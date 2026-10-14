/**
 * Bridge core: maps MCP operations onto the DSH capability seams. The bridge
 * never re-implements DSH — it drives ctx.agents / ctx.sessions /
 * ctx.sessionPersistence / ctx.sessionTitle / ctx.workspaceRegistry and
 * answers ctx.approval + ctx.userQuestions through their plugin seams.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentOptions, AgentSetup, ModelSelection } from '@deepseek-ai/dsh-agent';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  SessionId,
  type Session,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session';
import { inspectPersistedSession, persistedHeader, sessionEvents } from './session-persistence-compat.js';
import type { Workspace } from '@deepseek-ai/dsh-workspace';
import type { ResolvedBridgeConfig } from './config.js';
import type { BridgeLogger } from './log.js';
import { isActiveStatus, isTerminalStatus, type BridgeStatus } from './status.js';
import {
  cachedTitle,
  deriveRowStatus,
  iso,
  pendingOf,
  sessionSummary,
  titleOf,
  truncate,
  type SessionSummary,
} from './session-read.js';
export type { SessionSummary } from './session-read.js';
import {
  assistantTextForTurn,
  collectChangedFiles,
  lastEventTime,
  lastTurnSpan,
  summarizeMessages,
  toolCallsForTurn,
  type MessageRow,
  type ToolCallInfo,
} from './session-facts.js';
import { foldSessionFacts } from './session-facts.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PollCursorMap, computeCatchUpDelta, computeProgressDelta, nextPollCursor } from './session-delta.js';
import { cleanupTempResources, discoverTempResources } from './temp-resources.js';
import {
  RequestIdMap,
  fingerprintRequest,
  type RequestRecord,
} from './request-id.js';
import {
  clampWaitSeconds,
  mapGoalStartNative,
  nativeClear,
  nativeCreate,
  nativeEdit,
  nativeGet,
  nativeGoalWire,
  nativePause,
  nativeResume,
  nativeWait,
  titleFromGoal,
  DEFAULT_WAIT_SECONDS,
  WAIT_POLL_MS,
  type GoalStartResult,
  type GoalWaitResult,
  type NativeGoalWire,
  type GoalHostContext,
} from './goal-native.js';
import { WorkspaceConcurrencyGuard } from './workspace-guard.js';
import { idempotencyKindFor } from './command-classify.js';
import { AskRelay, type WaitingState } from './ask-relay.js';
import { buildResultSchema, type ResultSchema } from './result-schema.js';
import { inspectCredentials, type CredentialStatus } from './credentials.js';
import { BRIDGE_NAME, BRIDGE_VERSION } from './version.js';
import { pathsEqual } from './paths.js';

import { BridgeError } from './goal-native.js';
export { BridgeError };


export interface HealthReport {
  status: string;
  bridge: { name: string; version: string };
  dsh: { version: string };
  runtime: { pid: number; uptimeMs: number };
  sessions: { live: number; persisted: number; active: number };
  capabilities: {
    transports: string[];
      workspaceRegistry: boolean;
    sessionPersistence: boolean;
    agentPresets: boolean;
    userQuestions: boolean;
    approvals: boolean;
    /** True when `autoApproveEscalations` is on: escalations are granted, never parked. */
    autoApproveEscalations: boolean;
    workspaces: number;
    webSurface: boolean;
    goalSupervision: boolean;
  };
}

export interface WorkspaceView {
  id: string;
  title: string;
  path: string;
  createdAt: string;
  updatedAt: string;
  sessionCount: number;
}

export interface SessionView {
  session_id: string;
  title?: string;
  workspace?: string;
  status: BridgeStatus;
  created_at: string;
  updated_at?: string;
  agent?: { status: 'idle' | 'running'; inbox: { nextTurn: number; nextStep: number } };
  pending: { nextTurn: number; nextStep: number };
  waiting: WaitingState;
  messages: MessageRow[];
  last_turn?: { turn: number; reason?: string };
  todos?: { content: string; status: string }[];
  goal?: NativeGoalWire;
}

export interface ResultView {
  session_id: string;
  status: BridgeStatus;
  turn: number;
  assistant_text: string;
  changed_files: string[];
  tool_calls: ToolCallInfo[];
  error?: { code: string; message: string };
  result_schema?: ResultSchema;
}

/** One loaded session view: the live agent when attached, else persisted events. */
interface LoadedView {
  agent?: Agent;
  session?: Session;
  events: readonly SessionEvent[];
  header: SessionHeader;
}

const require = createRequire(import.meta.url);

/** DSH version string, resolved lazily from the installed package. */
function dshVersion(): string {
  try {
    return (require('@deepseek-ai/dsh/package.json') as { version?: string }).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The bridge service. One instance per plugin activation. */
export class Bridge {
  private readonly ctx: Context;
  private readonly cfg: ResolvedBridgeConfig;
  private readonly log: BridgeLogger;
  /** Sessions created through this bridge (approval answering scope). */
  private readonly managed = new Set<string>();
  private readonly relays: AskRelay;
  private started = false;
  private readonly goalRequests = new RequestIdMap();
  private readonly messageRequests = new RequestIdMap();
  private readonly requestIdFile: string | undefined;
  private readonly pollCursors = new PollCursorMap();

  readonly workspaceGuard = new WorkspaceConcurrencyGuard();
  private readonly recordedMutationCalls = new Set<string>();

  /** Test hooks for bounded wait loops. */
  now: () => number = () => Date.now();
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  constructor(ctx: Context, cfg: ResolvedBridgeConfig, log: BridgeLogger) {
    this.ctx = ctx;
    this.cfg = cfg;
    this.log = log;
    this.relays = new AskRelay({
      isManaged: (sessionId) => this.managed.has(sessionId),
      hostCanAnswer: () => this.hostCanAnswer(),
      autoApproveEscalations: () => this.cfg.autoApproveEscalations === true,
    }, log);
    const home = typeof cfg.dshHome === 'string' && cfg.dshHome !== '' ? cfg.dshHome : undefined;
    this.requestIdFile = home === undefined ? undefined : join(home, 'goal-requests.json');
    if (this.requestIdFile !== undefined) this.loadRequestIds();
  }

  /**
   * request_id dedup is process-local unless a dshHome is configured; with one,
   * the map is persisted so a connector retry after a bridge restart is still
   * recognised as a replay instead of starting the work a second time.
   */
  private loadRequestIds(): void {
    if (this.requestIdFile === undefined) return;
    try {
      const parsed = JSON.parse(readFileSync(this.requestIdFile, 'utf8')) as { records?: unknown };
      if (!Array.isArray(parsed.records)) return;
      const rows = parsed.records.filter(
        (row): row is [string, RequestRecord] => Array.isArray(row)
          && typeof row[0] === 'string'
          && row[1] !== null
          && typeof row[1] === 'object'
          && typeof (row[1] as { sessionId?: unknown }).sessionId === 'string'
          && typeof (row[1] as { fingerprint?: unknown }).fingerprint === 'string',
      );
      this.goalRequests.restore(rows);
    } catch {
      // A missing or malformed file must never block startup.
    }
  }

  private rememberRequestId(requestId: string, record: RequestRecord): void {
    this.goalRequests.set(requestId, record);
    if (this.requestIdFile === undefined) return;
    try {
      mkdirSync(dirname(this.requestIdFile), { recursive: true });
      const tmp = `${this.requestIdFile}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, records: this.goalRequests.entries() }), { mode: 0o600 });
      renameSync(tmp, this.requestIdFile);
    } catch (error) {
      this.log.warn(`could not persist request_id state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  /** Register the approval answerer and the user-questions provider. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // Scoped waterfalls are the only mode: approvals and questions defer to an
    // attached host client (hostCanAnswer) and the bridge answers only what
    // the host cannot. The legacy apiProxy mux mode and the tunnel control
    // plane were removed from this tree.
    // The relay plane owns both waterfalls (approvals + user questions) and
    // their parked state; the bridge owns the process lifecycle, so disposal
    // clears the relay here.
    this.relays.start(this.ctx);

    this.ctx.effect(() => () => {
      this.relays.clear();
    });
  }

  private adopt(sessionId: string): void {
    this.managed.add(sessionId);
  }

  /**
   * The plugin answers only when the host cannot. With a live Client event
   * stream every approval/question can be answered locally, so the bridge
   * steps aside with next(); with no client attached the gateway parks
   * forwarded waterfalls until one connects, and headless hosts have no
   * forwarder at all — in both cases nothing answers unless the bridge does.
   * The decision is made once per request at entry, so a request never has
   * two answerers: no answer race and no stale GUI card. Missing gateway
   * (headless profiles) reads as "no client": the bridge answers. This is the
   * relay's `hostCanAnswer` seam, so it stays next to the relay it serves.
   */
  private hostCanAnswer(): boolean {
    const gateway = this.ctx.get('typertGateway') as { hasLiveClient?: unknown } | undefined;
    return typeof gateway?.hasLiveClient === 'function'
      && (gateway.hasLiveClient as () => boolean).call(gateway) === true;
  }

  // ── model selection + composition (mirrors the web api-proxy) ─────────────

  private agentOptions(): AgentOptions {
    const defaults = this.ctx.get('agentDefaultModel');
    if (defaults !== undefined) {
      const selection = defaults.currentSelection();
      return { provider: selection.provider, model: selection.model };
    }
    return { provider: 'deepseek-official', model: 'deepseek-flash' };
  }

  /** Agent-scoped model selection with log-derived fallback for resumes. */
  private installSelection(agentCtx: Context, agent: Agent): void {
    const defaults = this.ctx.get('agentDefaultModel');
    let picked: ModelSelection | undefined;
    const selection: { current: ModelSelection; assembled: ModelSelection | undefined } = {
      get current() {
        if (picked !== undefined) return picked;
        const logged = agent.session.requestHeader()?.config;
        if (logged !== undefined) {
          return {
            provider: logged.provider,
            model: logged.model,
            ...(logged.reasoningEffort !== undefined ? { reasoningEffort: logged.reasoningEffort } : {}),
          };
        }
        if (defaults !== undefined) return defaults.currentSelection();
        return { provider: 'deepseek-official', model: 'deepseek-flash' };
      },
      set current(next) {
        picked = next;
      },
      assembled: undefined,
    };
    installModelSelection(agentCtx, selection);
  }

  /** Compose the preset+selection setup used at agent creation/resume. */
  private async composeSetupFor(presetId: string | undefined): Promise<{
    agentPreset?: string;
    setup: AgentSetup;
  }> {
    const presets = this.ctx.get('agentPresets');
    if (presets === undefined) {
      return {
        setup: (agentCtx, agent) => {
          this.installSelection(agentCtx, agent);
        },
      };
    }
    const resolvedId = presetId ?? (await presets.resolve(undefined)).id;
    return {
      agentPreset: resolvedId,
      setup: async (agentCtx, agent) => {
        this.installSelection(agentCtx, agent);
        await presets.mount(agentCtx, resolvedId);
      },
    };
  }

  // ── session loading ───────────────────────────────────────────────────────

  private async loadView(sessionId: string): Promise<LoadedView> {
    const liveAgent = this.ctx.agents.get(SessionId(sessionId));
    if (liveAgent !== undefined) {
      return { agent: liveAgent, session: liveAgent.session, events: sessionEvents(liveAgent.session), header: liveAgent.session.header };
    }
    const persistence = this.ctx.get('sessionPersistence');
    if (persistence === undefined) {
      throw new BridgeError('SESSION_NOT_FOUND', `session ${sessionId} is not live and no session persistence is mounted`);
    }
    try {
      const inspected = await inspectPersistedSession(persistence, SessionId(sessionId));
      return { events: inspected.events, header: inspected.meta };
    } catch {
      throw new BridgeError('SESSION_NOT_FOUND', `session ${sessionId} is not live and has no persisted log`);
    }
  }

  /** Resolve a live agent, resuming the persisted session when needed. */
  private async ensureAgent(sessionId: string): Promise<Agent> {
    const live = this.ctx.agents.get(SessionId(sessionId));
    if (live !== undefined) return live;
    const persistence = this.ctx.get('sessionPersistence');
    if (persistence === undefined) {
      throw new BridgeError('SESSION_NOT_FOUND', `session ${sessionId} is not live and no session persistence is mounted`);
    }
    let inspected;
    try {
      inspected = await inspectPersistedSession(persistence, SessionId(sessionId));
    } catch {
      throw new BridgeError('SESSION_NOT_FOUND', `session ${sessionId} is not live and has no persisted log`);
    }
    // Replay the official preset projection so a blank-session preset change
    // survives a cold resume, rather than using only the creation header.
    const presetId = inspected.events.reduce(agentPresetProjectionDefinition.apply,
      agentPresetProjectionDefinition.init(inspected.meta)) ?? undefined;
    const composition = await this.composeSetupFor(presetId);
    const { agent } = await this.ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: this.agentOptions(),
      setup: composition.setup,
    });
    return agent;
  }

  // ── workspace boundary ────────────────────────────────────────────────────

  async listWorkspaces(): Promise<WorkspaceView[]> {
    const registry = this.ctx.get('workspaceRegistry');
    if (registry === undefined) {
      throw new BridgeError('WORKSPACE_REGISTRY_UNAVAILABLE', 'no workspace registry is mounted in this profile');
    }
    return registry.list().map((workspace) => ({
      id: workspace.id,
      title: workspace.title,
      path: workspace.path,
      createdAt: workspace.createdAt,
      updatedAt: workspace.updatedAt,
      sessionCount: workspace.sessionIds.length,
    }));
  }

  /**
   * Resolve a workspace reference (id, canonical path, or title) against the
   * REGISTERED workspace set only. Never auto-registers and never opens an
   * arbitrary path: an unregistered path is rejected.
   */
  async resolveWorkspace(input: string): Promise<Workspace> {
    const registry = this.ctx.get('workspaceRegistry');
    if (registry === undefined) {
      throw new BridgeError('WORKSPACE_REGISTRY_UNAVAILABLE', 'no workspace registry is mounted in this profile');
    }
    const all = registry.list();
    const byId = all.find((workspace) => workspace.id === input);
    if (byId !== undefined) return byId;
    const byPath = all.find((workspace) => pathsEqual(workspace.path, input));
    if (byPath !== undefined) return byPath;
    const byTitle = all.find((workspace) => workspace.title === input);
    if (byTitle !== undefined) return byTitle;
    throw new BridgeError(
      'WORKSPACE_NOT_FOUND',
      `no registered workspace matches "${input}"; sessions can only be created in workspaces DSH already registered (dsh_list_workspaces)`,
    );
  }

  // ── operations ────────────────────────────────────────────────────────────

  async health(): Promise<HealthReport> {
    const agents = this.ctx.agents.list();
    let persisted = 0;
    try {
      persisted = (await this.ctx.get('sessionPersistence')?.list())?.length ?? 0;
    } catch {
      persisted = -1;
    }
    const workspaces = this.ctx.get('workspaceRegistry')?.list() ?? [];
    return {
      status: 'ok',
      bridge: { name: BRIDGE_NAME, version: BRIDGE_VERSION },
      dsh: { version: dshVersion() },
      runtime: { pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000) },
      sessions: {
        live: agents.length,
        persisted: Math.max(persisted, 0),
        active: agents.filter((agent) => agent.status === 'running').length,
      },
      capabilities: {
        transports: this.cfg.transport === 'stdio' ? ['stdio'] : ['streamable-http'],
        workspaceRegistry: this.ctx.get('workspaceRegistry') !== undefined,
        sessionPersistence: this.ctx.get('sessionPersistence') !== undefined,
        agentPresets: this.ctx.get('agentPresets') !== undefined,
        userQuestions: this.relays.questionsReady,
        approvals: this.relays.approvalsReady,
        autoApproveEscalations: this.cfg.autoApproveEscalations === true,
        workspaces: workspaces.length,
        webSurface: this.ctx.get('webRuntime') !== undefined,
        goalSupervision: true,
      },
    };
  }

  async createSession(
    workspaceInput: string,
    title?: string,
    initialMessage?: string,
  ): Promise<SessionView> {
    const workspace = await this.resolveWorkspace(workspaceInput);
    const sessionId = `session-${randomUUID()}`;
    const composition = await this.composeSetupFor(undefined);
    let agent: Agent;
    try {
      const handle = await this.ctx.agents.create({
        sessionId: SessionId(sessionId),
        agentOptions: this.agentOptions(),
        meta: {
          cwd: workspace.path,
          ...(composition.agentPreset === undefined ? {} : { agentPreset: composition.agentPreset }),
        },
        setup: composition.setup,
      });
      agent = handle.agent;
    } catch (error) {
      throw new BridgeError(
        'SESSION_CREATE_FAILED',
        `failed to create DSH session in workspace "${workspace.title}": ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.adopt(sessionId);
    try {
      await workspace.attachSession(SessionId(sessionId));
    } catch (error) {
      this.log.warn(`session ${sessionId} could not attach to workspace ${workspace.id}: ${String(error)}`);
    }
    if (title !== undefined && title !== '') {
      try {
        this.ctx.sessionTitle?.rename(agent.session, title);
      } catch (error) {
        this.log.warn(`session ${sessionId} title rejected: ${String(error)}`);
      }
    }
    if (initialMessage !== undefined && initialMessage.trim() !== '') {
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: initialMessage }],
          source: { kind: 'user' },
        }),
      );
    }
    return this.viewOf(agent);
  }

  async sendMessage(
    sessionId: string,
    message: string,
    requestId?: string,
  ): Promise<{ session_id: string; accepted: boolean; request_id?: string; replayed?: boolean }> {
    if (message.trim() === '') throw new BridgeError('EMPTY_MESSAGE', 'message must not be empty');
    // Without request_id the call is deliberately NOT deduplicated: a repeated
    // send queues a second turn. Passing request_id makes connector retries safe.
    const useKey = requestId !== undefined && requestId !== '';
    const fingerprint = JSON.stringify({ session_id: sessionId, message });
    // Deliberately NOT folded into replayGoalRequest below: this gate keys a
    // different map (messageRequests, in-process only), replays a different
    // result shape, and words its conflict differently. Same three rules,
    // different fact — do not "unify" them.
    if (useKey) {
      const existing = this.messageRequests.get(requestId);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new BridgeError(
            'REQUEST_ID_CONFLICT',
            `request_id "${requestId}" was already used with a different message`,
          );
        }
        return { session_id: existing.sessionId, accepted: true, request_id: requestId, replayed: true };
      }
    }
    this.adopt(sessionId);
    const agent = await this.ensureAgent(sessionId);
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: message }],
        source: { kind: 'user' },
      }),
    );
    if (useKey) this.messageRequests.set(requestId, { sessionId, fingerprint });
    return { session_id: sessionId, accepted: true, ...(useKey ? { request_id: requestId } : {}) };
  }

  async cancelTask(sessionId: string): Promise<{ session_id: string; cancelled: boolean }> {
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (agent === undefined) {
      throw new BridgeError('SESSION_NOT_LIVE', `session ${sessionId} is not loaded; only live sessions can be cancelled`);
    }
    agent.cancel({ kind: 'user' });
    return { session_id: sessionId, cancelled: true };
  }

  // ── relay facade ──────────────────────────────────────────────────────────
  // The relay plane (ask-relay.ts) owns the parked asks and the decision
  // rules; these two are the MCP verbs' entry points, forwarded verbatim.

  /** dsh_approve: decide one parked approval. */
  approve(sessionId: string, approvalId: string, decision: 'approve' | 'reject') {
    return this.relays.approve(sessionId, approvalId, decision);
  }

  /** dsh_answer_question: answer one answerable question of a parked ask. */
  answerQuestion(questionId: string, sessionId: string | undefined, answer: { selected: string[]; custom?: string }) {
    return this.relays.answerQuestion(questionId, sessionId, answer);
  }

  /**
   * The request_id replay gate the goal verbs share (start_goal / update_goal;
   * each caller fingerprints its own argument shape). Three rules, one home:
   * no id → no dedupe; same id + same fingerprint → return the recorded goal
   * as a replay; same id + different arguments → hard conflict. Two hand-copied
   * blocks had already drifted apart in wording before this extraction.
   * @param requestId - caller-supplied idempotency key, optional.
   * @param fingerprint - the caller's argument fingerprint for this verb.
   * @param verb - wire verb name, used in the conflict message only.
   * @returns the replayed result, or undefined when the call must proceed.
   */
  private async replayGoalRequest(
    requestId: string | undefined,
    fingerprint: string,
    verb: string,
  ): Promise<GoalStartResult | undefined> {
    if (requestId === undefined || requestId === '') return undefined;
    const existing = this.goalRequests.get(requestId);
    if (existing === undefined) return undefined;
    if (existing.fingerprint !== fingerprint) {
      throw new BridgeError(
        'REQUEST_ID_CONFLICT',
        `request_id "${requestId}" was already used with different ${verb} arguments`,
      );
    }
    this.adopt(existing.sessionId);
    const current = nativeGet(this.goalHost(), existing.sessionId);
    if (current === undefined) return undefined;
    return this.mapStartNative(existing.sessionId, nativeGoalWire(existing.sessionId, current), {
      existing_goal_reused: true,
      revision_unchanged: true,
    });
  }

  private statusOf(sessionId: string, view: LoadedView): BridgeStatus {
    const waiting = this.relays.waitingFor(sessionId, view.events);
    return deriveRowStatus({
      ...(view.agent === undefined ? {} : { agent: view.agent }),
      events: view.events,
      pendingApprovals: waiting.approvals.length,
      pendingQuestions: waiting.questions.length,
    });
  }

  private async viewOf(agent: Agent): Promise<SessionView> {
    return this.getSession(agent.id, this.cfg.sessionMaxItems, this.cfg.sessionMaxChars);
  }

  async getSession(sessionId: string, maxItems?: number, maxChars?: number): Promise<SessionView> {
    const view = await this.loadView(sessionId);
    const items = maxItems ?? this.cfg.sessionMaxItems;
    const chars = maxChars ?? this.cfg.sessionMaxChars;
    const pending = pendingOf(view.agent, view.events);
    const waiting = this.relays.waitingFor(sessionId, view.events);
    const status = this.statusOf(sessionId, view);
    const title = titleOf(view, this.ctx.sessionTitle);
    const span = lastTurnSpan(view.events);
    return {
      session_id: sessionId,
      ...(title === undefined ? {} : { title }),
      ...(view.header.cwd === undefined ? {} : { workspace: view.header.cwd }),
      status,
      created_at: iso(view.header.createdAt),
      updated_at: view.agent !== undefined ? lastEventTime(view.events) : undefined,
      ...(view.agent === undefined
        ? {}
        : { agent: { status: view.agent.status, inbox: { nextTurn: pending.nextTurn, nextStep: pending.nextStep } } }),
      pending,
      waiting,
      messages: summarizeMessages(view.events, items, chars),
      ...(span === undefined ? {} : { last_turn: { turn: span.turn, ...(span.reason === undefined ? {} : { reason: span.reason.kind }) } }),
      ...this.sessionExtras(sessionId, view.events),
    };
  }

  async listSessions(options: { limit?: number; offset?: number; workspace?: string }): Promise<SessionSummary[]> {
    const persistence = this.ctx.get('sessionPersistence');
    const persisted = persistence === undefined ? [] : await persistence.list();
    const live = this.ctx.sessions.list();
    const byId = new Map<string, SessionHeader>();
    for (const row of persisted) {
      const header = persistedHeader(row);
      byId.set(header.id, header);
    }
    for (const session of live) byId.set(session.id, session.header);
    let rows = [...byId.values()];
    if (options.workspace !== undefined && options.workspace !== '') {
      const workspace = await this.resolveWorkspace(options.workspace);
      rows = rows.filter((header) => header.cwd !== undefined && pathsEqual(header.cwd, workspace.path));
    }
    rows.sort((a, b) => b.createdAt - a.createdAt);
    const offset = Math.max(options.offset ?? 0, 0);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const page = rows.slice(offset, offset + limit);
    const out: SessionSummary[] = [];
    const cache = this.ctx.get('sessionProjectionCache');
    for (const header of page) {
      const agent = this.ctx.agents.get(header.id);
      if (agent === undefined) {
        out.push(sessionSummary({ header, title: cachedTitle(cache, header) }));
        continue;
      }
      const events = sessionEvents(agent.session);
      const waiting = this.relays.waitingFor(header.id, events);
      out.push(sessionSummary({
        header,
        title: titleOf({ session: agent.session, events }, this.ctx.sessionTitle),
        status: deriveRowStatus({
          agent,
          events,
          pendingApprovals: waiting.approvals.length,
          pendingQuestions: waiting.questions.length,
        }),
        updatedAt: lastEventTime(events),
      }));
    }
    return out;
  }

  async getResult(sessionId: string, maxChars?: number): Promise<ResultView> {
    const view = await this.loadView(sessionId);
    const span = lastTurnSpan(view.events);
    if (span === undefined) {
      throw new BridgeError('NO_RESULT_YET', `session ${sessionId} has no turn yet; send a message first`);
    }
    const chars = maxChars ?? this.cfg.resultMaxChars;
    const items = this.cfg.resultMaxItems;
    const text = assistantTextForTurn(view.events, span.turn);
    const status = this.statusOf(sessionId, view);
    const error = span.reason !== undefined && span.reason.kind === 'error'
      ? { code: span.reason.error.code, message: span.reason.error.message }
      : undefined;
    const resultSchema = await this.getStructuredResult(sessionId).catch(() => undefined);
    return {
      session_id: sessionId,
      status,
      turn: span.turn,
      assistant_text: truncate(text, chars),
      changed_files: collectChangedFiles(view.events, span.turn),
      tool_calls: toolCallsForTurn(view.events, span.turn, items).map((call) => ({
        ...call,
        arguments: truncate(call.arguments, 500),
      })),
      ...(error === undefined ? {} : { error }),
      ...(resultSchema === undefined ? {} : { result_schema: resultSchema }),
    };
  }

  async getTaskStatus(sessionId: string): Promise<{
    session_id: string;
    status: BridgeStatus;
    live: boolean;
    agent_status?: 'idle' | 'running';
    pending: { nextTurn: number; nextStep: number };
    waiting: WaitingState;
    last_turn?: { turn: number; reason?: string };
    updated_at?: string;
    todos?: { content: string; status: string }[];
    goal?: NativeGoalWire;
  }> {
    const view = await this.loadView(sessionId);
    const status = this.statusOf(sessionId, view);
    this.releaseWorkspaceIfTerminal(sessionId, status);
    const pending = pendingOf(view.agent, view.events);
    const span = lastTurnSpan(view.events);
    return {
      session_id: sessionId,
      status,
      live: view.agent !== undefined,
      ...(view.agent === undefined ? {} : { agent_status: view.agent.status }),
      pending,
      waiting: this.relays.waitingFor(sessionId, view.events),
      ...(span === undefined ? {} : { last_turn: { turn: span.turn, ...(span.reason === undefined ? {} : { reason: span.reason.kind }) } }),
      updated_at: lastEventTime(view.events),
      ...this.sessionExtras(sessionId, view.events),
    };
  }

  // ── Native goals (thin mapping onto ctx.goals) ───────────────────────────

  private goalHost(): GoalHostContext {
    const goals = this.ctx.get('goals') as GoalHostContext['goals'];
    return {
      agents: { get: (sessionId: string) => this.ctx.agents.get(SessionId(sessionId)) },
      goals,
    };
  }

  /** Session-level extras for getSession/getTaskStatus: native goal + agent todos. */
  private sessionExtras(sessionId: string, events: readonly SessionEvent[]): {
    todos?: { content: string; status: string }[];
    goal?: NativeGoalWire;
  } {
    const facts = foldSessionFacts(events);
    // Read paths keep the observed-mutation ledger warm (evidence ids are
    // derived per read, not stored) — recording is a pure idempotent
    // observation, even with no native goal present.
    this.recordObservedExecutions(sessionId, undefined, facts);
    const native = nativeGet(this.goalHost(), sessionId);
    return {
      ...(facts.todos === undefined ? {} : { todos: facts.todos }),
      ...(native === undefined ? {} : { goal: nativeGoalWire(sessionId, native) }),
    };
  }

  private async mapStartNative(
    sessionId: string,
    goal: NativeGoalWire,
    extras?: { existing_goal_reused?: boolean; revision_unchanged?: boolean },
  ): Promise<GoalStartResult> {
    const view = await this.loadView(sessionId);
    const status = await this.statusOf(sessionId, view);
    this.releaseWorkspaceIfTerminal(sessionId, status);
    return mapGoalStartNative(sessionId, status, goal, extras);
  }

  async createGoal(input: {
    workspace: string;
    goal: string;
    plan?: string;
    request_id?: string;
    max_goal_rounds?: number;
    workspace_lock_override?: boolean;
  }): Promise<GoalStartResult> {
    return this.startGoal(input);
  }

  async reviseGoal(input: {
    session_id: string;
    goal?: string;
    expected_revision?: number;
    max_goal_rounds?: number;
    request_id?: string;
  }): Promise<GoalStartResult> {
    return this.updateGoal({
      ...input,
      action: 'revise',
    });
  }

  async pauseGoal(sessionId: string): Promise<{
    session_id: string;
    status: BridgeStatus;
    paused: boolean;
    checkpoint_revision: number;
    goal?: NativeGoalWire;
  }> {
    const { native, status } = await this.doPause(sessionId);
    return {
      session_id: sessionId,
      status,
      paused: true,
      checkpoint_revision: native.revision,
      goal: nativeGoalWire(sessionId, native),
    };
  }

  /**
   * The ONE pause ordering (adversarial audit A#2): a pause always quiesces
   * the in-flight turn before flipping the native phase, and works on cold
   * sessions by resuming the agent. Two frozen tools shape their responses
   * around this; neither may re-order it.
   */
  private async doPause(
    sessionId: string,
    expectedRevision?: number,
  ): Promise<{ native: ReturnType<typeof nativePause>; status: BridgeStatus }> {
    this.adopt(sessionId);
    await this.ensureAgent(sessionId);
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (agent !== undefined && agent.status === 'running') {
      agent.cancel({ kind: 'user' });
    }
    const native = nativePause(this.goalHost(), sessionId, expectedRevision);
    const view = await this.loadView(sessionId);
    const status = await this.statusOf(sessionId, view);
    return { native, status };
  }

  async resumeGoal(
    sessionId: string,
    requestId?: string,
    expectedRevision?: number,
  ): Promise<GoalStartResult> {
    return this.updateGoal({
      session_id: sessionId,
      action: 'resume',
      request_id: requestId,
      ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }),
    });
  }

  async waitUntilActionRequired(sessionId: string, waitSeconds = 120, sinceSeq?: number): Promise<GoalWaitResult> {
    this.adopt(sessionId);
    const seconds = Math.min(300, Math.max(1, waitSeconds));
    const started = this.now();
    const deadline = started + seconds * 1000;
    let view = await this.loadView(sessionId);
    let status = await this.statusOf(sessionId, view);

    while (isActiveStatus(status) && this.now() < deadline) {
      const remaining = deadline - this.now();
      if (remaining <= 0) break;
      await this.sleep(Math.min(WAIT_POLL_MS, remaining));
      view = await this.loadView(sessionId);
      status = await this.statusOf(sessionId, view);
      if (!isActiveStatus(status)) break;
    }
    return this.nativeSnapshot(sessionId, view, status, this.now() - started, seconds, sinceSeq);
  }

  async getStructuredResult(sessionId: string): Promise<ResultSchema> {
    this.adopt(sessionId);
    const view = await this.loadView(sessionId);
    const status = await this.statusOf(sessionId, view);
    const workspace = view.header?.cwd ?? '';
    const native = nativeGet(this.goalHost(), sessionId);
    const lastMutation = workspace === '' ? undefined : this.workspaceGuard.getLastMutation(workspace);
    return buildResultSchema({
      sessionId,
      ...(native === undefined ? {} : { goal: nativeGoalWire(sessionId, native) }),
      events: view.events,
      status,
      workspace,
      evidenceIds: derivedEvidenceIds(sessionId, view.events),
      credentialRefs: this.getCredentialStatus()
        .filter((item) => item.credentialAvailable)
        .map((item) => item.credentialRef),
      originatingStep: lastMutation?.stepId ?? lastMutation?.type,
      warnings: [],
    });
  }

  getCredentialStatus(): CredentialStatus[] {
    const home = this.cfg.dshHome;
    return inspectCredentials({
      env: process.env,
      ...(typeof home === 'string' && home !== '' ? { dshHome: home } : {}),
    });
  }

  async startGoal(input: {
    workspace: string;
    goal: string;
    plan?: string;
    session_id?: string;
    request_id?: string;
    max_goal_rounds?: number;
    expected_revision?: number;
    workspace_lock_override?: boolean;
    read_only?: boolean;
  }): Promise<GoalStartResult> {
    // plan is advertised as "embedded into the objective" (mcp start_goal
    // schema) — actually embed it; it silently vanished before (audit A#4).
    const plan = input.plan?.trim() ?? '';
    const objective = plan === '' ? input.goal.trim() : `${input.goal.trim()}\n\nPlan:\n${plan}`;
    if (objective === '') throw new BridgeError('EMPTY_GOAL', 'goal must not be empty');
    const host = this.goalHost();

    const fingerprint = fingerprintRequest({
      workspace: input.workspace,
      goal: objective,
      session_id: input.session_id ?? '',
      max_goal_rounds: input.max_goal_rounds ?? 0,
      expected_revision: input.expected_revision ?? 0,
    });
    const replayed = await this.replayGoalRequest(input.request_id, fingerprint, 'start_goal');
    if (replayed !== undefined) return replayed;

    let sessionId = input.session_id;
    const resolvedWorkspace = await this.resolveWorkspace(input.workspace);
    const workspacePath = resolvedWorkspace.path;
    const lockOverride = input.workspace_lock_override === true;
    // Bridge-level concurrency classification only: a read-only audit coexists
    // with a mutable lock; native goal semantics do not know this flag.
    const isReadOnly = input.read_only === true;

    if (sessionId === undefined || sessionId === '') {
      // Native-equivalent targeting on this workspace: an identical active
      // objective is the same goal (reattach); a completed goal on an existing
      // session may legitimately be replaced by native create (reattach there
      // too). Anything else (paused/blocked foreign objective) falls through.
      let replaceCandidate: string | undefined;
      for (const agent of this.ctx.agents.list()) {
        if (!pathsEqual(agent.session.header?.cwd ?? '', workspacePath)) continue;
        const existingGoal = nativeGet(host, agent.id);
        if (existingGoal === undefined) continue;
        if (existingGoal.phase !== 'complete' && existingGoal.objective === objective) {
          sessionId = agent.id;
          break;
        }
        if (existingGoal.phase === 'complete' && replaceCandidate === undefined) {
          replaceCandidate = agent.id;
        }
      }
      if (sessionId === undefined && replaceCandidate !== undefined) {
        sessionId = replaceCandidate;
      }
      if (sessionId === undefined || sessionId === '') {
        this.assertMutableWorkspaceAvailable(workspacePath, undefined, lockOverride, isReadOnly);
        const created = await this.createSession(input.workspace, titleFromGoal(objective));
        sessionId = created.session_id;
      }
    }
    this.adopt(sessionId);

    const current = nativeGet(host, sessionId);
    if (current !== undefined && current.phase !== 'complete') {
      if (current.objective === objective) {
        if (input.request_id !== undefined && input.request_id !== '') {
          this.rememberRequestId(input.request_id, { sessionId, fingerprint });
        }
        return this.mapStartNative(sessionId, nativeGoalWire(sessionId, current), {
          existing_goal_reused: true,
          revision_unchanged: true,
        });
      }
      throw new BridgeError(
        'GOAL_ALREADY_EXISTS',
        `session ${sessionId} already has a ${current.phase} native goal (revision ${current.revision}); use dsh_revise_goal or dsh_update_goal`,
        { goal_id: current.id, revision: current.revision },
      );
    }
    if (input.expected_revision !== undefined && current !== undefined && input.expected_revision !== current.revision) {
      throw new BridgeError(
        'REVISION_CONFLICT',
        `expected_revision mismatch: expected ${input.expected_revision}, but current revision is ${current.revision}`,
      );
    }

    await this.takeWorkspaceLock(workspacePath, sessionId, lockOverride, isReadOnly);

    const native = nativeCreate(host, sessionId, {
      objective,
      ...(input.max_goal_rounds === undefined ? {} : { max_goal_rounds: input.max_goal_rounds }),
    });
    if (input.request_id !== undefined && input.request_id !== '') {
      this.rememberRequestId(input.request_id, { sessionId, fingerprint });
    }
    return this.mapStartNative(sessionId, nativeGoalWire(sessionId, native));
  }

  async updateGoal(
    input: {
      session_id: string;
      action?: 'revise' | 'resume' | 'pause';
      goal?: string;
      expected_revision?: number;
      max_goal_rounds?: number;
      request_id?: string;
    },
  ): Promise<GoalStartResult> {
    const sessionId = input.session_id;
    if (sessionId.trim() === '') throw new BridgeError('SESSION_REQUIRED', 'dsh_update_goal requires session_id');
    const action = input.action ?? 'revise';
    const fingerprint = fingerprintRequest({
      session_id: sessionId,
      action,
      goal: input.goal ?? '',
      expected_revision: input.expected_revision ?? 0,
      max_goal_rounds: input.max_goal_rounds ?? 0,
    });
    const replayed = await this.replayGoalRequest(input.request_id, fingerprint, 'update_goal');
    if (replayed !== undefined) return replayed;
    this.adopt(sessionId);
    await this.ensureAgent(sessionId);

    let native;
    if (action === 'resume') {
      native = nativeResume(this.goalHost(), sessionId, input.expected_revision);
    } else if (action === 'pause') {
      // Same single pause ordering as dsh_pause_goal (audit A#2).
      ({ native } = await this.doPause(sessionId, input.expected_revision));
    } else {
      native = nativeEdit(this.goalHost(), sessionId, {
        ...(input.goal === undefined ? {} : { objective: input.goal }),
        ...(input.max_goal_rounds === undefined ? {} : { max_goal_rounds: input.max_goal_rounds }),
        ...(input.expected_revision === undefined ? {} : { expected_revision: input.expected_revision }),
      });
    }
    if (input.request_id !== undefined && input.request_id !== '') {
      this.rememberRequestId(input.request_id, { sessionId, fingerprint });
    }
    return this.mapStartNative(sessionId, nativeGoalWire(sessionId, native));
  }

  async waitGoal(sessionId: string, waitSeconds?: number, sinceSeq?: number): Promise<GoalWaitResult> {
    this.adopt(sessionId);
    const seconds = clampWaitSeconds(waitSeconds);
    const outcome = await nativeWait(this.goalHost(), sessionId, seconds, this.now, (ms) => this.sleep(ms));
    const view = await this.loadView(sessionId);
    const status = await this.statusOf(sessionId, view);
    const result = this.nativeSnapshot(sessionId, view, status, outcome.waited_ms, seconds, sinceSeq);
    return {
      ...result,
      // Single owner for goal_outcome (adversarial audit A#5): the snapshot
      // sees parked approvals/questions — 'action_required' must win over
      // the native phase loop's 3-value verdict; otherwise the phase loop's
      // ended/no_goal/timeout stands. Clobbering with the 3-value outcome
      // made dsh_wait_goal report timeout while parked.
      goal_outcome: result.goal_outcome === 'action_required' ? result.goal_outcome : outcome.outcome,
      ...(outcome.goal === undefined ? {} : { goal: nativeGoalWire(sessionId, outcome.goal) }),
    };
  }

  async stopGoal(sessionId: string): Promise<{
    session_id: string;
    stopped: true;
    already_stopped: boolean;
    status: BridgeStatus;
    cleanup_warning?: string;
  }> {
    this.adopt(sessionId);
    this.workspaceGuard.releaseLock(sessionId);
    const view = await this.loadView(sessionId);
    const status = await this.statusOf(sessionId, view);
    const current = nativeGet(this.goalHost(), sessionId);
    if (current === undefined || current.phase === 'complete') {
      const warning = this.cleanupSessionTemps(sessionId, view);
      return {
        session_id: sessionId,
        stopped: true,
        already_stopped: true,
        status,
        ...(warning === undefined ? {} : { cleanup_warning: warning }),
      };
    }
    this.relays.failClosed(sessionId);
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (agent !== undefined && agent.status === 'running') agent.cancel({ kind: 'user' });
    nativeClear(this.goalHost(), sessionId);
    const warning = this.cleanupSessionTemps(sessionId, view);
    return {
      session_id: sessionId,
      stopped: true,
      already_stopped: false,
      status: 'cancelled',
      ...(warning === undefined ? {} : { cleanup_warning: warning }),
    };
  }

  private nativeSnapshot(
    sessionId: string,
    view: LoadedView,
    status: BridgeStatus,
    waitedMs: number,
    waitSeconds: number,
    sinceSeq?: number,
  ): GoalWaitResult {
    const facts = foldSessionFacts(view.events);
    const waiting = this.relays.waitingFor(sessionId, view.events);
    const waitKind = waiting.approvals.map((item) => item.approval_id);
    const waitQuestions = waiting.questions.map((item) => item.question_id);
    const span2 = lastTurnSpan(view.events);
    const changedFiles = span2 === undefined ? [] : collectChangedFiles(view.events, span2.turn);
    const deltaInput = {
      events: view.events,
      ...(facts.todos === undefined ? {} : { todos: facts.todos }),
      status,
      changedFiles,
      approvalIds: waitKind,
      questionIds: waitQuestions,
      previous: this.pollCursors.get(sessionId),
      ...(view.agent === undefined ? {} : { agentStatus: view.agent.status }),
    };
    const progressDelta = sinceSeq === undefined
      ? computeProgressDelta(deltaInput)
      : computeCatchUpDelta(deltaInput, sinceSeq);
    if (sinceSeq === undefined) this.pollCursors.set(sessionId, nextPollCursor(deltaInput));
    const native = nativeGet(this.goalHost(), sessionId);
    this.releaseWorkspaceIfTerminal(sessionId, status);
    // Parked human action always halts the loop — do not suggest dsh_wait_goal.
    const parked = waiting.approvals.length > 0 || waiting.questions.length > 0;
    const running = !parked && (isActiveStatus(status)
      || (native !== undefined && native.phase === 'active' && native.activation === 'armed'));
    // Same goal_outcome vocabulary as dsh_wait_goal so both wait loops speak
    // one wire dialect.
    // no-goal + still-running session = the wait genuinely timed out (the
    // session is busy outside any goal); no-goal + not running = no goal to wait on.
    const goalOutcome = parked
      ? 'action_required'
      : native === undefined
        ? isActiveStatus(status) ? 'timeout' : 'no_goal'
        : native.phase === 'complete' || native.phase === 'paused' || native.phase === 'blocked'
          ? 'ended'
          : 'timeout';
    return {
      session_id: sessionId,
      status,
      goal_outcome: goalOutcome,
      waited_ms: waitedMs,
      wait_seconds: waitSeconds,
      ...(native === undefined ? {} : { goal: nativeGoalWire(sessionId, native) }),
      continuation_required: running,
      ...(running
        ? { next_tool_call: { tool: 'dsh_wait_goal', arguments: { session_id: sessionId, wait_seconds: DEFAULT_WAIT_SECONDS } } }
        : {}),
      ...(waiting.approvals[0] === undefined ? {} : { approval: waiting.approvals[0] }),
      ...(waiting.questions[0] === undefined ? {} : { question: waiting.questions[0] }),
      progress_delta: progressDelta,
    };
  }

  private cleanupSessionTemps(sessionId: string, view: LoadedView): string | undefined {
    const workspace = view.header.cwd;
    if (typeof workspace !== 'string' || workspace === '') return undefined;
    const facts = foldSessionFacts(view.events);
    const resources = discoverTempResources({
      facts,
      sessionId,
      goalId: sessionId,
      workspacePath: workspace,
    });
    if (resources.length === 0) return undefined;
    const cleaned = cleanupTempResources(resources, workspace);
    if (cleaned.warnings.length === 0) return undefined;
    return cleaned.warnings.join('; ');
  }

  private isLockHolderActive(sessionId: string): boolean {
    const holderAgent = this.ctx.agents.get(SessionId(sessionId));
    if (holderAgent === undefined) return false;
    if (holderAgent.status === 'running') return true;
    if (holderAgent.inbox.nextTurn.length > 0 || holderAgent.inbox.nextStep.length > 0) return true;
    // Native regime: an armed active goal means the round driver will pick the
    // session back up any moment — the holder remains occupant between rounds.
    const native = nativeGet(this.goalHost(), sessionId);
    return native !== undefined && native.phase === 'active' && native.activation === 'armed';
  }

  private workspaceLockedError(holder: { sessionId: string; goalId: string }): BridgeError {
    return new BridgeError(
      'WORKSPACE_LOCKED',
      `workspace is locked by session ${holder.sessionId} (goal ${holder.goalId}); waiting_for_workspace_lock. Pass workspace_lock_override=true to take over.`,
      {
        status: 'waiting_for_workspace_lock',
        holder_session_id: holder.sessionId,
        holder_goal_id: holder.goalId,
      },
    );
  }

  private assertMutableWorkspaceAvailable(
    workspacePath: string,
    sessionId: string | undefined,
    override: boolean,
    isReadOnly: boolean,
  ): void {
    if (isReadOnly || override) return;
    const existing = this.workspaceGuard.getLock(workspacePath);
    if (existing === undefined) return;
    if (sessionId !== undefined && existing.sessionId === sessionId) return;
    if (this.isLockHolderActive(existing.sessionId)) {
      throw this.workspaceLockedError(existing);
    }
  }

  private async takeWorkspaceLock(
    workspacePath: string,
    sessionId: string,
    override: boolean,
    isReadOnly: boolean,
  ): Promise<void> {
    if (isReadOnly) return;
    const existing = this.workspaceGuard.getLock(workspacePath);
    const holderActive = existing !== undefined && existing.sessionId !== sessionId
      ? this.isLockHolderActive(existing.sessionId)
      : false;
    const lockRes = this.workspaceGuard.acquireMutableLock(
      workspacePath,
      sessionId,
      `goal-${sessionId}`,
      holderActive,
      override,
    );
    if (!lockRes.success && lockRes.holder !== undefined) {
      throw this.workspaceLockedError(lockRes.holder);
    }
    if (lockRes.warning) this.log.warn(lockRes.warning);
  }

  private releaseWorkspaceIfTerminal(sessionId: string, status: BridgeStatus): void {
    if (isTerminalStatus(status)) this.workspaceGuard.releaseLock(sessionId);
  }

  private recordObservedExecutions(
    sessionId: string,
    view: LoadedView | undefined,
    facts: ReturnType<typeof foldSessionFacts>,
  ): void {
    const workspacePath = view?.header?.cwd;
    if (workspacePath === undefined || workspacePath === '') return;
    this.recordObservedExecutionFacts(sessionId, workspacePath, facts);
  }

  private recordObservedExecutionFacts(
    sessionId: string,
    workspacePath: string,
    facts: ReturnType<typeof foldSessionFacts>,
  ): void {
    // Mutations record exactly once — at observed success, keyed
    // sessionId:callId (audit B#4: the approve-time write with a different
    // key shape died here; a successful call lands ONE ledger row).
    for (const tool of facts.tools) {
      if (!tool.ok) continue;
      const key = `${sessionId}:${tool.callId}`;
      if (!isMutatingTool(tool.name, tool.command) || this.recordedMutationCalls.has(key)) continue;
      this.rememberMutationCall(key);
      this.workspaceGuard.recordMutation(workspacePath, {
        stepId: tool.callId,
        type: idempotencyKindFor(tool.name, tool.command) ?? tool.name,
      });
    }
  }

  private rememberMutationCall(key: string): void {
    this.recordedMutationCalls.add(key);
    while (this.recordedMutationCalls.size > 2048) {
      const oldest = this.recordedMutationCalls.values().next().value;
      if (oldest === undefined) break;
      this.recordedMutationCalls.delete(oldest);
    }
  }

}

/**
 * Evidence ids derive from the session's own events — a pure function of
 * facts, so every read of the same session yields the same list, and the
 * bridge keeps no ledger of its own (execution-idempotency.ts removed).
 */
function derivedEvidenceIds(sessionId: string, events: readonly SessionEvent[]): string[] {
  const ids = new Set<string>();
  for (const tool of foldSessionFacts(events).tools) {
    if (!tool.ok) continue;
    if (idempotencyKindFor(tool.name, tool.command) === undefined) continue;
    ids.add(`exec-${sessionId}:${tool.callId}`);
  }
  return [...ids];
}

/**
 * Best-effort "could this call mutate the workspace?" — advisory only; it
 * feeds the observed-mutation ledger (originating_step provenance). It never
 * decides the approval outcome (relay-only design).
 */
function isMutatingTool(toolName: string, command?: string): boolean {
  if (/^(?:write|edit|multiedit|apply_patch|notebook_edit)/i.test(toolName)) return true;
  if (command === undefined) return false;
  return /\b(?:git\s+(?:add|commit|push|merge|rebase|reset|clean)|npm\s+(?:publish|unpublish)|gh\s+release|rm|mv|cp|mkdir|touch|chmod|chown)\b/i.test(command)
    || /(^|\s)>{1,2}\s*\S/.test(command);
}
