/**
 * Bridge core: maps MCP operations onto the DSH capability seams. The bridge
 * never re-implements DSH — it drives ctx.agents / ctx.sessions /
 * ctx.sessionPersistence / ctx.sessionTitle / ctx.workspaceRegistry and
 * answers ctx.approval + ctx.userQuestions through their plugin seams.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Context } from '@deepseek-ai/cordis';
import type { Agent, AgentOptions, AgentSetup, ModelSelection } from '@deepseek-ai/dsh-agent';
import { installModelSelection } from '@deepseek-ai/dsh-agent';
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import {
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from '@deepseek-ai/dsh-session';
import { inspectPersistedSession, persistedHeader, sessionEvents } from './session-persistence-compat.js';
import type { Workspace } from '@deepseek-ai/dsh-workspace';
import { liveValue, type ResolvedBridgeConfig } from './config.js';
import type { BridgeLogger } from './log.js';
import { isTerminalStatus, type BridgeStatus } from './status.js';
import {
  cachedTitle,
  deriveRowStatus,
  iso,
  pendingOf,
  sessionSummary,
  titleOf,
  truncate,
  type LoadedView,
  type SessionSummary,
} from './session-read.js';
import { WaitPlane } from './waits.js';
export type { SessionSummary } from './session-read.js';
import {
  assistantTextForTurn,
  collectChangedFiles,
  lastEventTime,
  lastFailureBefore,
  lastTurnSpan,
  summarizeMessages,
  toolCallsForTurn,
  type MessageRow,
  type ToolCallInfo,
} from './session-facts.js';
import { foldSessionFacts } from './session-facts.js';
import { RequestIdStore } from './request-id-store.js';
import { MessageReceiptStore, type MessageReceipt } from './message-receipts.js';
import {
  RequestFlights,
  RequestIdMap,
  fingerprintRequest,
  type RequestRecord,
} from './request-id.js';
import {
  mapGoalStartNative,
  nativeClear,
  nativeCreate,
  nativeEdit,
  nativeGet,
  nativeGoalWire,
  nativePause,
  nativeResume,
  titleFromGoal,
  type GoalStartResult,
  type GoalWaitResult,
  type NativeGoalWire,
  type GoalHostContext,
} from './goal-native.js';
import { WorkspaceConcurrencyGuard, WorkspaceOperationQueue } from './workspace-guard.js';
import { idempotencyKindFor } from './command-classify.js';
import { AskRelay, type WaitingState } from './ask-relay.js';
import { buildResultSchema, type ResultSchema } from './result-schema.js';
import { selectResultEvents } from './result-scope.js';
import {
  DEFAULT_SURFACE,
  TOOL_REPLACEMENTS,
  toolsForSurface,
  type Surface,
} from './shared/surface.js';
import { inspectCredentials, type CredentialStatus } from './credentials.js';
import { BRIDGE_NAME, BRIDGE_VERSION } from './version.js';
import { pathsEqual } from './paths.js';

import { BridgeError } from './errors.js';
export { BridgeError };


/** Stable fingerprint of the names a surface serves, for cache invalidation. */
function surfaceFingerprint(surface: Surface): string {
  return createHash('sha256').update(toolsForSurface(surface).join('\n')).digest('hex').slice(0, 16);
}

export interface HealthReport {
  status: string;
  bridge: {
    name: string;
    version: string;
    protocol_version: string;
    schema_version: string;
    instance_id: string;
    started_at: string;
    build_time?: string;
    artifact_sha256?: string;
  };
  dsh: { version: string; source?: string; unknown_reason?: string };
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
  /**
   * The surface this server instance was built for. `tools_sha256` is a hash of
   * the served names, so a client can tell "my cached list is stale" without
   * diffing names and without trusting a hand-maintained version integer.
   */
  surface: {
    tier: Surface;
    tool_count: number;
    tools_sha256: string;
    /** Names that exist only on the `full` surface → the core door that owns the verb. */
    replacements: Readonly<Record<string, string>>;
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
  /** Read snapshot markers: same-call freshness to pair with dsh_get_result. */
  snapshot: { observed_at: string; last_event_seq?: number };
}

interface MessageAccepted {
  session_id: string;
  accepted: boolean;
  request_id?: string;
  replayed?: boolean;
}

interface StartGoalInput {
  workspace: string;
  goal: string;
  plan?: string;
  session_id?: string;
  request_id?: string;
  max_goal_rounds?: number;
  expected_revision?: number;
  workspace_lock_override?: boolean;
  read_only?: boolean;
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
  /** Requested detail level; 'standard' is the historical behavior. */
  detail: 'summary' | 'standard' | 'full';
  /** Number of rows dropped by a budget, per field (0 = nothing omitted). */
  omitted_counts: { tool_calls: number; changed_files: number };
  /**
   * Per-field truncation marker — never truncate a JSON structure itself.
   * Every flag is recomputed from the FINAL object after the total-budget
   * ladder ran, so a flag can never disagree with `omitted_counts` (the 0.8.0
   * bug: 38 dropped tool calls reported as `tool_calls: false`).
   */
  truncated: {
    text: boolean;
    tool_calls: boolean;
    changed_files: boolean;
    /** An extra (total-payload) layer was applied, on top of the per-field ones. */
    total?: boolean;
    /** The skeleton alone exceeded the caller's ceiling; this is what we sent. */
    served_chars?: number;
    budget_chars?: number;
    over_budget?: true;
  };
  /** Read snapshot markers: same-call freshness for status/result pairs (P1-03). */
  snapshot: { observed_at: string; last_event_seq?: number };
  /** Newest non-completed terminal turn before this one (P0-03 failure trail). */
  last_failure?: { turn: number; seq: number; kind: string; code?: string; message?: string };
}

/** The CLI package.json is inside the host process tree, not our node_modules. */
function resolveDshVersion(): { version: string; source?: string; unknown_reason?: string } {
  const candidates = [process.argv[1], process.cwd(), fileURLToPath(import.meta.url)]
    .filter((entry): entry is string => typeof entry === 'string' && entry !== '')
    .map((entry) => dirname(entry));
  for (const root of candidates) {
    try {
      const probe = createRequire(join(root, 'probe.js'));
      const manifest = probe.resolve('@deepseek-ai/dsh/package.json');
      const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string };
      if (typeof parsed.version === 'string') return { version: parsed.version, source: manifest };
    } catch {
      // next candidate
    }
  }
  return { version: 'unknown', unknown_reason: 'the host CLI package (@deepseek-ai/dsh) is not resolvable from argv/cwd/module roots' };
}

/** Stamped at build time by scripts/write-buildmeta.mjs. */
function buildMeta(): { built_at?: string; artifact_sha256?: string } {
  try {
    return JSON.parse(readFileSync(new URL('buildmeta.json', import.meta.url), 'utf8')) as { built_at?: string; artifact_sha256?: string };
  } catch {
    return {};
  }
}

const INSTANCE_ID = randomUUID();
const INSTANCE_STARTED_AT = new Date().toISOString();
const MCP_PROTOCOL_VERSION = '2024-11-05';
const WIRE_SCHEMA_VERSION = '0.8';

/** The bridge service. One instance per plugin activation. */
/**
 * Workspace claim policy, named instead of the old positional booleans:
 * `override` takes foreign locks (pauses the holder); `readOnly` claims
 * nothing (bridge-level audit classification only — never a native concept).
 */
interface LockPolicy {
  readonly override?: boolean;
  readonly readOnly?: boolean;
}

export class Bridge {
  private readonly ctx: Context;
  private readonly cfg: ResolvedBridgeConfig;
  private readonly log: BridgeLogger;
  /** Sessions created through this bridge (approval answering scope). */
  private readonly managed = new Set<string>();
  private readonly relays: AskRelay;
  /** The wait plane: both long-poll verbs plus their per-session poll cursors. */
  private readonly waits: WaitPlane;
  private started = false;
  private readonly goalRequests = new RequestIdMap();
  private readonly messageRequests = new RequestIdMap();
  private readonly requestIdStore: RequestIdStore;
  private readonly receiptStore: MessageReceiptStore;
  /** dsh_send_message receipts (accepted only): restore + live appends. */
  private readonly messageReceipts = new Map<string, MessageReceipt>();
  private readonly goalFlights = new RequestFlights<GoalStartResult>();
  private readonly messageFlights = new RequestFlights<MessageAccepted>();
  private readonly agentFlights = new RequestFlights<Agent>();
  private readonly workspaceOperations = new WorkspaceOperationQueue();
  /** Session -> exact goal generation; a hint never survives replacement work. */
  private readonly readOnlySessions = new Map<string, string>();

  readonly workspaceGuard = new WorkspaceConcurrencyGuard();

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
      autoApproveEscalations: () => liveValue(this.cfg.autoApproveEscalations) === true,
    }, log);

    // The wait plane reads the facade through this seam; `now`/`sleep` are read
    // dynamically so the unit tests can replace them on the bridge instance.
    this.waits = new WaitPlane({
      adopt: (sessionId) => this.adopt(sessionId),
      loadView: (sessionId) => this.loadView(sessionId),
      statusOf: (sessionId, view) => this.statusOf(sessionId, view),
      waitingFor: (sessionId, events) => this.relays.waitingFor(sessionId, events),
      goalHost: () => this.goalHost(),
      releaseWorkspaceIfTerminal: (sessionId, status) => this.releaseWorkspaceIfTerminal(sessionId, status),
      now: () => this.now(),
      sleep: (ms) => this.sleep(ms),
    });
    const home = typeof cfg.dshHome === 'string' && cfg.dshHome !== '' ? cfg.dshHome : undefined;
    this.requestIdStore = new RequestIdStore(home, (message) => this.log.warn(message));
    this.goalRequests.restore(this.requestIdStore.load());
    this.receiptStore = new MessageReceiptStore(home, (message) => this.log.warn(message));
    for (const receipt of this.receiptStore.load()) {
      this.messageReceipts.set(receipt.request_id, receipt);
      this.messageRequests.set(receipt.request_id, { sessionId: receipt.session_id, fingerprint: receipt.payload_hash });
    }
  }

  /** The fs shape lives in RequestIdStore; the map itself stays here. */
  private rememberRequestId(requestId: string, record: RequestRecord): void {
    this.goalRequests.set(requestId, record);
    this.requestIdStore.save(this.goalRequests.entries());
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

  /** Coalesce cold loads even when callers use different request ids. */
  private async ensureAgent(sessionId: string): Promise<Agent> {
    const live = this.ctx.agents.get(SessionId(sessionId));
    if (live !== undefined) return live;
    const { value } = await this.agentFlights.run(sessionId, sessionId, () => this.resumeAgent(sessionId));
    return value;
  }

  /** Resolve a cold agent using the host's own persisted-session API. */
  private async resumeAgent(sessionId: string): Promise<Agent> {
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
    // Another host entry point may have loaded the session during disk I/O.
    const loaded = this.ctx.agents.get(SessionId(sessionId));
    if (loaded !== undefined) return loaded;
    const { agent } = await this.ctx.agents.resume({
      resumeSessionId: SessionId(sessionId),
      agentOptions: this.agentOptions(),
      setup: composition.setup,
    });
    return agent;
  }

  private workspaceOf(view: LoadedView, sessionId: string): string {
    const workspace = view.header.cwd;
    if (typeof workspace !== 'string' || workspace.trim() === '') {
      throw new BridgeError('WORKSPACE_NOT_FOUND', `session ${sessionId} has no workspace binding`);
    }
    return workspace;
  }

  /** No nested public mutators inside this queue: call their private bodies. */
  private async inSessionWorkspace<T>(
    sessionId: string,
    operation: (workspacePath: string) => Promise<T>,
  ): Promise<T> {
    const view = await this.loadView(sessionId);
    const workspace = this.workspaceOf(view, sessionId);
    return this.workspaceOperations.run(workspace, () => operation(workspace));
  }

  private assertSessionWorkspace(sessionId: string, actual: string | undefined, expected: string): void {
    if (actual === undefined || !pathsEqual(actual, expected)) {
      throw new BridgeError('WORKSPACE_MISMATCH',
        `session ${sessionId} belongs to "${actual ?? '(none)'}", not the requested workspace "${expected}"`);
    }
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
      `no registered workspace matches "${input}" (checked id, path and title); ` +
        'call dsh_list_workspaces to see the registered set — the bridge never registers a path on your behalf',
    );
  }

  // ── operations ────────────────────────────────────────────────────────────

  async health(surface: Surface = DEFAULT_SURFACE): Promise<HealthReport> {
    const agents = this.ctx.agents.list();
    let persisted = 0;
    try {
      persisted = (await this.ctx.get('sessionPersistence')?.list())?.length ?? 0;
    } catch {
      persisted = -1;
    }
    const workspaces = this.ctx.get('workspaceRegistry')?.list() ?? [];
    const dsh = resolveDshVersion();
    const meta = buildMeta();
    return {
      status: 'ok',
      bridge: {
        name: BRIDGE_NAME,
        version: BRIDGE_VERSION,
        protocol_version: MCP_PROTOCOL_VERSION,
        schema_version: WIRE_SCHEMA_VERSION,
        instance_id: INSTANCE_ID,
        started_at: INSTANCE_STARTED_AT,
        ...(meta.built_at === undefined ? {} : { build_time: meta.built_at }),
        ...(meta.artifact_sha256 === undefined ? {} : { artifact_sha256: meta.artifact_sha256 }),
      },
      dsh,
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
        autoApproveEscalations: liveValue(this.cfg.autoApproveEscalations) === true,
        workspaces: workspaces.length,
        // DSH 0.2.1-rc.2 renamed the web-surface marker service from
        // `webRuntime` to `webApp`; accept either so health stays honest on
        // whichever host generation boots us.
        webSurface: this.ctx.get('webApp') !== undefined || this.ctx.get('webRuntime') !== undefined,
        goalSupervision: true,
      },
      surface: {
        tier: surface,
        tool_count: toolsForSurface(surface).length,
        tools_sha256: surfaceFingerprint(surface),
        replacements: TOOL_REPLACEMENTS,
      },
    };
  }

  async createSession(
    workspaceInput: string,
    title?: string,
    initialMessage?: string,
  ): Promise<SessionView> {
    const workspace = await this.resolveWorkspace(workspaceInput);
    return this.workspaceOperations.run(workspace.path, () => this.createSessionInWorkspace(workspace, title, initialMessage));
  }

  private async createSessionInWorkspace(
    workspace: Workspace,
    title?: string,
    initialMessage?: string,
  ): Promise<SessionView> {
    const startsTurn = initialMessage !== undefined && initialMessage.trim() !== '';
    if (startsTurn) this.assertMutableWorkspaceAvailable(workspace.path, undefined, {});
    const sessionId = `session-${randomUUID()}`;
    if (startsTurn) await this.takeWorkspaceLock(workspace.path, sessionId, {});
    return this.runReleasingLock(sessionId, 'on-error', async () => {
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
        throw new BridgeError('SESSION_CREATE_FAILED',
          `failed to create DSH session in workspace "${workspace.title}": ${error instanceof Error ? error.message : String(error)}`);
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
      if (startsTurn) {
        // Recheck host-created occupants that appeared during agent setup.
        this.assertMutableWorkspaceAvailable(workspace.path, sessionId, {});
        agent.followup(createUserMessage({
          content: [{ type: 'text', text: initialMessage }],
          source: { kind: 'user' },
        }));
      }
      return await this.viewOf(agent);
    });
  }

  async sendMessage(
    sessionId: string,
    message: string,
    requestId?: string,
    mode: 'queue' | 'steer' | 'interrupt' = 'queue',
  ): Promise<MessageAccepted> {
    if (message.trim() === '') throw new BridgeError('EMPTY_MESSAGE', 'message must not be empty');
    const useKey = requestId !== undefined && requestId !== '';
    const fingerprint = JSON.stringify({ session_id: sessionId, message, mode });
    const { value, shared } = await this.messageFlights.run(requestId, fingerprint, async () => {
      if (useKey) {
        const existing = this.messageRequests.get(requestId);
        if (existing !== undefined) {
          if (existing.fingerprint !== fingerprint) {
            throw new BridgeError('IDEMPOTENCY_CONFLICT',
              `request_id "${requestId}" was already used with a different dispatch; the original receipt remains the authoritative acceptance`);
          }
          return { session_id: existing.sessionId, accepted: true, request_id: requestId, replayed: true };
        }
      }
      return this.inSessionWorkspace(sessionId, async (workspacePath) => {
        // All ordinary messages are potentially mutating, even on a session
        // whose earlier goal carried a read_only concurrency hint.
        await this.takeWorkspaceLock(workspacePath, sessionId, {});
        // 'on-error': a successful followup returns before the agent can be
        // proven active — releasing there would drop the seat early.
        return this.runReleasingLock(sessionId, 'on-error', async () => {
          this.adopt(sessionId);
          const agent = await this.ensureAgent(sessionId);
          this.assertSessionWorkspace(sessionId, agent.session.header.cwd, workspacePath);
          this.assertMutableWorkspaceAvailable(workspacePath, sessionId, {});
          const userMessage = createUserMessage({
            content: [{ type: 'text', text: message }],
            source: { kind: 'user' },
          });
          if (mode === 'steer') {
            // Next step boundary mid-turn; on an idle agent the host opens a turn.
            agent.steer(userMessage);
          } else if (mode === 'interrupt') {
            // Abort first (the host reclassifies this waking input to next-turn
            // and latches it until the aborted activity converges), keep queued
            // work, then follow up so the new turn carries this message.
            agent.cancel({ kind: 'user' }, { keepInbox: true });
            agent.followup(userMessage);
          } else {
            agent.followup(userMessage);
          }
          if (useKey) {
            this.messageRequests.set(requestId, { sessionId, fingerprint });
            this.messageReceipts.set(requestId, {
              request_id: requestId,
              session_id: sessionId,
              payload_hash: fingerprint,
              mode,
              accepted_at: new Date().toISOString(),
            });
            this.receiptStore.save([...this.messageReceipts.values()]);
          }
          return { session_id: sessionId, accepted: true, ...(useKey ? { request_id: requestId } : {}) };
        });
      });
    });
    return shared ? { ...value, replayed: true } : value;
  }

  /**
   * Query the persisted delivery receipt of a dsh_send_message request_id.
   * States: accepted (receipt found, payload hash echoes) or REQUEST_NOT_FOUND
   * (never accepted — or evicted from the ≤256-row retention window).
   */
  messageStatus(sessionId: string, requestId: string): {
    state: 'accepted';
    session_id: string;
    request_id: string;
    mode?: 'queue' | 'steer' | 'interrupt';
    payload_hash: string;
    accepted_at?: string;
  } {
    const receipt = this.messageReceipts.get(requestId);
    const legacy = this.messageRequests.get(requestId);
    const sessionMatches = receipt?.session_id === sessionId || legacy?.sessionId === sessionId;
    if (!sessionMatches) {
      throw new BridgeError('REQUEST_NOT_FOUND',
        `request_id "${requestId}" has no accepted receipt for session ${sessionId} (never accepted, or evicted from the 256-row retention window)`);
    }
    return {
      state: 'accepted',
      session_id: sessionId,
      request_id: requestId,
      payload_hash: receipt?.payload_hash ?? legacy?.fingerprint ?? '',
      ...(receipt === undefined ? {} : { mode: receipt.mode, accepted_at: receipt.accepted_at }),
    };
  }

  async cancelTask(sessionId: string): Promise<{ session_id: string; cancelled: boolean; external_jobs_may_run: true }> {
    const agent = this.ctx.agents.get(SessionId(sessionId));
    if (agent === undefined) {
      throw new BridgeError('SESSION_NOT_LIVE', `session ${sessionId} is not loaded; only live sessions can be cancelled`);
    }
    agent.cancel({ kind: 'user' });
    // Cancellation stops the agent; processes it spawned are outside our reach
    // and may still run. Resource cleanup is its own question (P1-06).
    return { session_id: sessionId, cancelled: true, external_jobs_may_run: true };
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
    workspacePath: string,
  ): Promise<GoalStartResult | undefined> {
    if (requestId === undefined || requestId === '') return undefined;
    const existing = this.goalRequests.get(requestId);
    if (existing === undefined) return undefined;
    if (existing.fingerprint !== fingerprint) {
      throw new BridgeError('REQUEST_ID_CONFLICT',
        `request_id "${requestId}" was already used with different ${verb} arguments`);
    }
    const view = await this.loadView(existing.sessionId);
    this.assertSessionWorkspace(existing.sessionId, view.header.cwd, workspacePath);
    // Restore the recorded session, never fall through to a new create merely
    // because nativeGet cannot read an unloaded agent. Loading does NOT re-arm.
    // Replay takes NO workspace lock and never takes over: its goal-id/CAS
    // validation is read-only and must not cancel a foreign writer even when
    // it ultimately rejects the replay.
    try {
      this.adopt(existing.sessionId);
      await this.ensureAgent(existing.sessionId);
      const current = nativeGet(this.goalHost(), existing.sessionId);
      if (current === undefined) {
        throw new BridgeError('GOAL_NOT_FOUND', `request_id "${requestId}" was already accepted, but its goal was cleared; use a new request_id for new work`);
      }
      if (existing.goalId !== undefined && existing.goalId !== current.id) {
        throw new BridgeError('REQUEST_ID_STALE', `request_id "${requestId}" belongs to a replaced goal; use a new request_id for new work`);
      }
      return await this.mapStartNative(existing.sessionId, nativeGoalWire(existing.sessionId, current), {
        existing_goal_reused: true,
        revision_unchanged: true,
      });
    } finally {
      this.releaseUnusedWorkspaceLock(existing.sessionId);
    }
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
    return this.getSession(agent.id, liveValue(this.cfg.sessionMaxItems), liveValue(this.cfg.sessionMaxChars));
  }

  async getSession(sessionId: string, maxItems?: number, maxChars?: number): Promise<SessionView> {
    const view = await this.loadView(sessionId);
    const items = maxItems ?? liveValue(this.cfg.sessionMaxItems);
    const chars = maxChars ?? liveValue(this.cfg.sessionMaxChars);
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
      snapshot: {
        observed_at: new Date().toISOString(),
        ...(view.events.at(-1) === undefined ? {} : { last_event_seq: view.events.at(-1)!.seq }),
      },
    };
  }

  async listSessions(options: {
    limit?: number;
    offset?: number;
    workspace?: string;
    /** Case-insensitive substring match on the title (P1-02). */
    query?: string;
    /** Exact title equality (P1-02). */
    title_exact?: string;
    /** 'live' = in-process agent attached; 'persisted' = cold only (P1-02). */
    state?: 'live' | 'persisted' | 'all';
    /** ISO timestamp: only rows with a KNOWN updated_at at or after it (P1-02). */
    updated_after?: string;
  }): Promise<SessionSummary[]> {
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
    if (options.state === 'live') rows = rows.filter((header) => this.ctx.agents.get(header.id) !== undefined);
    if (options.state === 'persisted') rows = rows.filter((header) => this.ctx.agents.get(header.id) === undefined);
    rows.sort((a, b) => b.createdAt - a.createdAt);
    // Title/recency filters force assembling every candidate row; without them
    // only the page is assembled (cold rows read the cheap title cache).
    const needsRowFilters = options.query !== undefined || options.title_exact !== undefined || options.updated_after !== undefined;
    const offset = Math.max(options.offset ?? 0, 0);
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
    const candidates = needsRowFilters ? rows : rows.slice(offset, offset + limit);
    const cache = this.ctx.get('sessionProjectionCache');
    const assembled: SessionSummary[] = [];
    for (const header of candidates) {
      const agent = this.ctx.agents.get(header.id);
      if (agent === undefined) {
        assembled.push(sessionSummary({ header, title: cachedTitle(cache, header) }));
        continue;
      }
      const events = sessionEvents(agent.session);
      const waiting = this.relays.waitingFor(header.id, events);
      assembled.push(sessionSummary({
        header,
        title: titleOf({ session: agent.session, events }, this.ctx.sessionTitle),
        status: deriveRowStatus({
          agent,
          events,
          pendingApprovals: waiting.approvals.length,
          pendingQuestions: waiting.questions.length,
        }),
        updatedAt: lastEventTime(events),
        live: true,
      }));
    }
    let filtered = assembled;
    if (options.query !== undefined) {
      const needle = options.query.toLowerCase();
      filtered = filtered.filter((row) => row.title !== undefined && row.title.toLowerCase().includes(needle));
    }
    if (options.title_exact !== undefined) {
      filtered = filtered.filter((row) => row.title === options.title_exact);
    }
    if (options.updated_after !== undefined) {
      const stamp = Date.parse(options.updated_after);
      if (Number.isNaN(stamp)) throw new BridgeError('INVALID_ARGUMENT', `updated_after must be an ISO timestamp, got ${options.updated_after}`);
      // Rows with updated_at null are excluded — "unknown" must never sneak
      // through as "recent" (P1-02 freshness discipline).
      filtered = filtered.filter((row) => row.updated_at !== null && Date.parse(row.updated_at) >= stamp);
    }
    return needsRowFilters ? filtered.slice(offset, offset + limit) : filtered;
  }

  /**
   * Total-payload budget (P1: a supervisor's `max_chars=800` must not be met
   * by ~49k of sections).
   *
   * Measured on the text the client actually receives — the pretty-printed
   * block `mcp-result.ts` serializes. The 0.8.0 version measured the COMPACT
   * form, which understated the payload by ~40% and is why a 1,000-char ceiling
   * shipped 1,884 chars: the budget was never violated, it was measured against
   * the wrong string.
   *
   * The ladder drops the cheapest information first and re-measures after every
   * rung; omission counts and truncation flags are recomputed from the final
   * object rather than carried over from the pre-ladder one.
   */
  private enforceTotalBudget(view: ResultView, budget: number): ResultView {
    const served = (value: unknown): number => JSON.stringify(value, null, 2).length;
    let current = view;
    if (served(current) <= budget) return current;
    let total = false;

    const apply = (next: ResultView): void => {
      if (served(next) < served(current)) total = true;
      current = next;
    };

    if (current.result_schema !== undefined) {
      const { result_schema: _dropped, ...rest } = current;
      apply(rest);
    }
    const over = (): boolean => served(current) > budget;
    if (over() && current.tool_calls.some((call) => call.arguments !== '…')) {
      apply({ ...current, tool_calls: current.tool_calls.map((call) => ({ ...call, arguments: '…' })) });
    }
    if (over() && current.changed_files.length > 5) {
      apply({ ...current, changed_files: current.changed_files.slice(0, 5) });
    }
    if (over() && current.tool_calls.length > 3) {
      apply({ ...current, tool_calls: current.tool_calls.slice(0, 3) });
    }
    if (over() && current.assistant_text.length > 200) {
      apply({ ...current, assistant_text: truncate(current.assistant_text, 200) });
    }
    if (over() && current.assistant_text.length > 0) {
      apply({ ...current, assistant_text: '' });
    }
    if (over() && current.changed_files.length > 0) {
      apply({ ...current, changed_files: [] });
    }
    if (over() && current.tool_calls.length > 0) {
      apply({ ...current, tool_calls: [] });
    }
    if (over() && current.last_failure !== undefined) {
      const { last_failure: _dropped, ...rest } = current;
      apply(rest);
    }

    const droppedCalls = view.omitted_counts.tool_calls + (view.tool_calls.length - current.tool_calls.length);
    const droppedFiles = view.omitted_counts.changed_files + (view.changed_files.length - current.changed_files.length);
    const finalServed = served(current);
    return {
      ...current,
      omitted_counts: { tool_calls: droppedCalls, changed_files: droppedFiles },
      truncated: {
        ...current.truncated,
        // Same source as omitted_counts: one裁剪 produces both, so a caller can
        // trust either.
        tool_calls: droppedCalls > 0 || current.truncated.tool_calls,
        changed_files: droppedFiles > 0 || current.truncated.changed_files,
        text: view.truncated.text || current.assistant_text.length < view.assistant_text.length,
        ...(total ? { total: true as const } : {}),
        // The skeleton (ids, status, counts, snapshot) is irreducible. When the
        // caller asks for less than it costs we say so — silently shipping 3x
        // the requested ceiling is what made the old budget untrustworthy.
        ...(finalServed > budget
          ? { served_chars: finalServed, budget_chars: budget, over_budget: true as const }
          : {}),
      },
    };
  }

  async getResult(sessionId: string, maxChars?: number, detail: 'summary' | 'standard' | 'full' = 'standard', totalMaxChars?: number): Promise<ResultView> {
    this.adopt(sessionId);
    const view = await this.loadView(sessionId);
    const span = lastTurnSpan(view.events);
    if (span === undefined) {
      throw new BridgeError('NO_RESULT_YET', `session ${sessionId} has no turn yet; send a message first`);
    }
    const chars = maxChars ?? liveValue(this.cfg.resultMaxChars);
    const items = liveValue(this.cfg.resultMaxItems);
    const text = assistantTextForTurn(view.events, span.turn);
    const status = this.statusOf(sessionId, view);
    const error = span.reason !== undefined && span.reason.kind === 'error'
      ? { code: span.reason.error.code, message: span.reason.error.message }
      : undefined;
    // Per-field budgets (P1-01): max_chars bounded only the assistant text; the
    // tool call tail and file list got their own ceilings and omission counts.
    // One total, two views: `rawCalls` is the capped list, `totalCalls` the real
    // one. Omission counts and truncation flags both derive from these, so
    // "38 dropped but tool_calls:false" cannot happen again.
    const totalCalls = toolCallsForTurn(view.events, span.turn, Number.POSITIVE_INFINITY).length;
    const rawCalls = toolCallsForTurn(view.events, span.turn, detail === 'summary' ? 10 : items);
    const allFiles = collectChangedFiles(view.events, span.turn);
    const fileLimit = detail === 'summary' ? 5 : detail === 'full' ? Number.POSITIVE_INFINITY : 200;
    const calls = detail === 'full'
      ? rawCalls
      : rawCalls.map((call) => {
        if (detail === 'summary') return { ...call, arguments: '…' };
        return { ...call, arguments: truncate(call.arguments, 500) };
      });
    const files = allFiles.slice(0, fileLimit);
    const lastFailure = lastFailureBefore(view.events, span.turn);
    // Keep the raw last-turn view and structured summary on one event snapshot.
    let resultSchema: ResultSchema | undefined;
    if (detail !== 'summary') {
      try { resultSchema = this.structuredResultOf(sessionId, view); } catch { /* optional projection */ }
    }
    const built: ResultView = {
      session_id: sessionId,
      status,
      turn: span.turn,
      assistant_text: truncate(text, chars),
      changed_files: files,
      tool_calls: calls,
      detail,
      omitted_counts: {
        tool_calls: Math.max(0, totalCalls - calls.length),
        changed_files: allFiles.length - files.length,
      },
      truncated: {
        text: text.length > chars,
        // `rawCalls` was already capped, so comparing it to `calls` could never
        // see the drop that `omitted_counts` was reporting. Compare the REAL
        // total instead — the two fields must agree.
        tool_calls: totalCalls > calls.length
          || rawCalls.some((call) => call.arguments.length > 500 && detail === 'standard')
          || (detail === 'summary' && rawCalls.some((call) => call.arguments !== '…')),
        changed_files: allFiles.length > files.length,
      },
      snapshot: {
        observed_at: new Date().toISOString(),
        ...(view.events.at(-1) === undefined ? {} : { last_event_seq: view.events.at(-1)!.seq }),
      },
      ...(error === undefined ? {} : { error }),
      ...(lastFailure === undefined ? {} : { last_failure: lastFailure }),
      ...(resultSchema === undefined ? {} : { result_schema: resultSchema }),
    };
    return totalMaxChars === undefined ? built : this.enforceTotalBudget(built, totalMaxChars);
  }

  /**
   * "What happens next" — the question a supervisor actually asks, and the one
   * the field set alone cannot answer. A snapshot can be entirely accurate and
   * still ambiguous: `status=queued` with an idle agent, a pending next-step and
   * a completed-turn marker describes three different situations (a driver is
   * about to run / nothing will consume it / the task already ended) depending
   * on whether a goal is armed.
   *
   * This does not collapse status into one label — it names the blocker and what
   * the caller should do, so "wait" and "push it forward" stop looking identical.
   */
  private nextActionOf(input: {
    status: BridgeStatus;
    agentStatus?: 'idle' | 'running';
    pending: { nextTurn: number; nextStep: number };
    waiting: WaitingState;
    goal?: NativeGoalWire;
  }): {
    actionable: boolean;
    waiting_on: 'nothing' | 'agent' | 'goal_round' | 'approval' | 'question' | 'queue' | 'human';
    recommendation: 'wait' | 'approve' | 'answer' | 'send_message' | 'done';
    reason: string;
  } {
    const { status, agentStatus, pending, waiting, goal } = input;
    const approvals = waiting.approvals.length;
    const questions = waiting.questions.length;
    const armed = goal !== undefined && goal.activation === 'armed' && goal.phase === 'active';
    const pendingCount = pending.nextTurn + pending.nextStep;

    if (approvals > 0) {
      return {
        actionable: false,
        waiting_on: 'approval',
        recommendation: 'approve',
        reason: `${approvals} approval(s) parked; nothing runs until one is decided (dsh_approve with approval_id)`,
      };
    }
    if (questions > 0) {
      return {
        actionable: false,
        waiting_on: 'question',
        recommendation: 'answer',
        reason: `${questions} question(s) parked; the agent is waiting on a human (dsh_answer_question)`,
      };
    }
    if (agentStatus === 'running') {
      return {
        actionable: true,
        waiting_on: armed ? 'goal_round' : 'agent',
        recommendation: 'wait',
        reason: armed
          ? 'the armed goal is driving this session; rounds continue without a new push'
          : 'the agent is mid-turn; it continues on its own',
      };
    }
    if (pendingCount > 0 && armed) {
      return {
        actionable: true,
        waiting_on: 'goal_round',
        recommendation: 'wait',
        reason: `${pendingCount} queued item(s) will be consumed by the armed goal`,
      };
    }
    if (pendingCount > 0) {
      // The 19-minute snapshot: queued work, idle agent, no driver.
      return {
        actionable: false,
        waiting_on: 'queue',
        recommendation: 'send_message',
        reason: `${pendingCount} queued item(s) with no driver: the agent is idle and no goal is armed, so nothing will consume them — push with dsh_send_message (mode=queue) or arm a goal`,
      };
    }
    if (isTerminalStatus(status)) {
      return {
        actionable: false,
        waiting_on: 'nothing',
        recommendation: 'done',
        reason: `the last turn ended ${status}; read dsh_get_result or continue with dsh_send_message`,
      };
    }
    return {
      actionable: false,
      waiting_on: 'human',
      recommendation: 'send_message',
      reason: 'idle with no pending work: nothing is scheduled, send a message to continue',
    };
  }

  /**
   * One session read with two projections. `detail='status'` (default) is the
   * historical task-status shape, byte for byte. `detail='session'` adds the
   * long-form fields the retired `dsh_get_session` served (title, workspace,
   * created_at, agent, bounded messages) — a strict superset, so nothing that
   * used to be reachable became unreachable.
   *
   * The workspace-lock release below is a WRITE side effect that has always
   * lived on this read path; `detail='session'` inherits it deliberately rather
   * than silently dropping it (a dropped release leaks the lock until the next
   * task-status poll).
   */
  async getTaskStatus(
    sessionId: string,
    detail: 'status' | 'session' = 'status',
    maxItems?: number,
    maxChars?: number,
  ): Promise<{
    session_id: string;
    status: BridgeStatus;
    live: boolean;
    agent_status?: 'idle' | 'running';
    /** Where current activity comes from (P0-01): 'goal' when an armed native goal drives, 'manual' otherwise; omitted when nothing runs. */
    execution_origin?: 'goal' | 'manual';
    pending: { nextTurn: number; nextStep: number };
    waiting: WaitingState;
    last_turn?: { turn: number; reason?: string };
    updated_at?: string;
    title?: string;
    workspace?: string;
    created_at?: string;
    agent?: { status: 'idle' | 'running'; inbox: { nextTurn: number; nextStep: number } };
    messages?: MessageRow[];
    todos?: { content: string; status: string }[];
    goal?: NativeGoalWire;
    /** Why the session sits where it sits, and what the caller should do (0.9.1). */
    next: {
      /** True when something will progress this session without a new push. */
      actionable: boolean;
      waiting_on: 'nothing' | 'agent' | 'goal_round' | 'approval' | 'question' | 'queue' | 'human';
      recommendation: 'wait' | 'approve' | 'answer' | 'send_message' | 'done';
      reason: string;
    };
    /** Read snapshot markers (P1-03): pair this call's fields by revision. */
    snapshot: { observed_at: string; last_event_seq?: number };
  }> {
    const view = await this.loadView(sessionId);
    const status = this.statusOf(sessionId, view);
    this.releaseWorkspaceIfTerminal(sessionId, status);
    const pending = pendingOf(view.agent, view.events);
    const span = lastTurnSpan(view.events);
    const extras = this.sessionExtras(sessionId, view.events);
    const session =
      detail !== 'session'
        ? {}
        : {
            ...(titleOf(view, this.ctx.sessionTitle) === undefined
              ? {}
              : { title: titleOf(view, this.ctx.sessionTitle) as string }),
            ...(view.header.cwd === undefined ? {} : { workspace: view.header.cwd }),
            created_at: iso(view.header.createdAt),
            ...(view.agent === undefined
              ? {}
              : { agent: { status: view.agent.status, inbox: { nextTurn: pending.nextTurn, nextStep: pending.nextStep } } }),
            messages: summarizeMessages(
              view.events,
              maxItems ?? liveValue(this.cfg.sessionMaxItems),
              maxChars ?? liveValue(this.cfg.sessionMaxChars),
            ),
          };
    const waiting = this.relays.waitingFor(sessionId, view.events);
    return {
      session_id: sessionId,
      status,
      live: view.agent !== undefined,
      ...(view.agent === undefined ? {} : { agent_status: view.agent.status }),
      ...(view.agent?.status !== 'running'
        ? {}
        : { execution_origin: extras.goal !== undefined && extras.goal.activation === 'armed' ? ('goal' as const) : ('manual' as const) }),
      pending,
      waiting,
      next: this.nextActionOf({
        status,
        ...(view.agent === undefined ? {} : { agentStatus: view.agent.status }),
        pending,
        waiting,
        ...(extras.goal === undefined ? {} : { goal: extras.goal }),
      }),
      ...(span === undefined ? {} : { last_turn: { turn: span.turn, ...(span.reason === undefined ? {} : { reason: span.reason.kind }) } }),
      updated_at: lastEventTime(view.events),
      ...session,
      snapshot: {
        observed_at: new Date().toISOString(),
        ...(view.events.at(-1) === undefined ? {} : { last_event_seq: view.events.at(-1)!.seq }),
      },
      ...extras,
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
    return this.inSessionWorkspace(sessionId, async (workspacePath) => {
      await this.claimWorkspaceIfCold(workspacePath, sessionId, { readOnly: this.isReadOnlySession(sessionId) });
      return this.runReleasingLock(sessionId, 'always', async () => {
        const { native, status } = await this.doPause(sessionId);
        return {
          session_id: sessionId,
          status,
          paused: true,
          checkpoint_revision: native.revision,
          goal: nativeGoalWire(sessionId, native),
        };
      });
    });
  }

  /**
   * Accept the native CAS/transition synchronously BEFORE cancelling anything.
   * Disarming first also prevents a round from starting during cancellation.
   * A successful pause returns only after the host driver is quiescent.
   */
  private async doPause(
    sessionId: string,
    expectedRevision?: number,
  ): Promise<{ native: ReturnType<typeof nativePause>; status: BridgeStatus }> {
    this.adopt(sessionId);
    const agent = await this.ensureAgent(sessionId);
    const current = nativeGet(this.goalHost(), sessionId);
    let native;
    if (current?.phase === 'paused') {
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        throw new BridgeError('REVISION_CONFLICT', `expected_revision mismatch: expected ${expectedRevision}, but current revision is ${current.revision}`);
      }
      native = current;
    } else {
      native = nativePause(this.goalHost(), sessionId, expectedRevision);
    }
    this.relays.failClosed(sessionId);
    agent.cancel({ kind: 'user' });
    // whenIdle is guaranteed by the pinned host; optional only for minimal
    // synthetic Agent fixtures used by the unit suite.
    await agent.whenIdle?.();
    this.releaseUnusedWorkspaceLock(sessionId);
    const view = await this.loadView(sessionId);
    return { native, status: this.statusOf(sessionId, view) };
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
    return this.waits.untilActionRequired(sessionId, waitSeconds, sinceSeq);
  }

  async getStructuredResult(sessionId: string): Promise<ResultSchema> {
    this.adopt(sessionId);
    return this.structuredResultOf(sessionId, await this.loadView(sessionId));
  }

  private structuredResultOf(sessionId: string, view: LoadedView): ResultSchema {
    const native = nativeGet(this.goalHost(), sessionId);
    const goal = native === undefined ? undefined : nativeGoalWire(sessionId, native);
    const events = selectResultEvents(view.events, goal);
    return buildResultSchema({
      sessionId,
      ...(goal === undefined ? {} : { goal }),
      events,
      status: this.statusOf(sessionId, view),
      workspace: view.header.cwd ?? '',
      evidenceIds: derivedEvidenceIds(sessionId, events),
      credentialRefs: this.getCredentialStatus()
        .filter((item) => item.credentialAvailable)
        .map((item) => item.credentialRef),
      // Provenance is derived from these scoped facts, never another session's
      // workspace mutation or a previous generation's successful operation.
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

  async startGoal(input: StartGoalInput): Promise<GoalStartResult> {
    const plan = input.plan?.trim() ?? '';
    const objective = plan === '' ? input.goal.trim() : `${input.goal.trim()}\n\nPlan:\n${plan}`;
    if (objective === '') throw new BridgeError('EMPTY_GOAL', 'goal must not be empty');
    const fingerprint = fingerprintRequest({
      workspace: input.workspace,
      goal: objective,
      session_id: input.session_id ?? '',
      max_goal_rounds: input.max_goal_rounds ?? 0,
      expected_revision: input.expected_revision ?? 0,
      ...(input.workspace_lock_override === true ? { workspace_lock_override: true } : {}),
      ...(input.read_only === true ? { read_only: true } : {}),
    });
    const { value, shared } = await this.goalFlights.run(input.request_id, fingerprint, async () => {
      const workspace = await this.resolveWorkspace(input.workspace);
      return this.workspaceOperations.run(workspace.path, async () => {
        const replayed = await this.replayGoalRequest(input.request_id, fingerprint, 'start_goal', workspace.path);
        if (replayed !== undefined) return replayed;
        return this.startGoalInWorkspace(input, objective, fingerprint, workspace);
      });
    });
    return shared ? { ...value, existing_goal_reused: true, revision_unchanged: true } : value;
  }

  private async startGoalInWorkspace(
    input: StartGoalInput,
    objective: string,
    fingerprint: string,
    resolvedWorkspace: Workspace,
  ): Promise<GoalStartResult> {
    const host = this.goalHost();
    if (host.goals === undefined) throw new BridgeError('GOAL_UNAVAILABLE', 'host goal service (goals) is not injected in this profile');
    if (input.max_goal_rounds !== undefined && (!Number.isSafeInteger(input.max_goal_rounds) || input.max_goal_rounds < 1)) {
      throw new BridgeError('GOAL_INVALID', 'max_goal_rounds must be a positive safe integer');
    }
    let sessionId = input.session_id;
    let createdHere = false;
    const workspacePath = resolvedWorkspace.path;
    const lockOverride = input.workspace_lock_override === true;
    // Bridge-level concurrency classification only: a read-only audit coexists
    // with a mutable lock; native goal semantics do not know this flag. The
    // hint may classify only a session this dispatch creates — it can NEVER
    // downgrade an existing session whose classification is unknown (default:
    // mutable; adversarial review: a bridge reload wiped all local locks).
    const requestedReadOnly = input.read_only === true;

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
        // A fresh audit hint may classify only a newly created session. Do not
        // implicitly downgrade a completed mutable (or unknown) session.
        if (!requestedReadOnly && existingGoal.phase === 'complete' && replaceCandidate === undefined) {
          replaceCandidate = agent.id;
        }
      }
      if (sessionId === undefined && replaceCandidate !== undefined) {
        sessionId = replaceCandidate;
      }
      if (sessionId === undefined || sessionId === '') {
        this.assertMutableWorkspaceAvailable(workspacePath, undefined, { override: lockOverride, readOnly: requestedReadOnly });
        const created = await this.createSessionInWorkspace(resolvedWorkspace, titleFromGoal(objective));
        sessionId = created.session_id;
        createdHere = true;
      }
    }
    const view = await this.loadView(sessionId);
    // Validate the actual session binding before loading, adopting or mutating it.
    this.assertSessionWorkspace(sessionId, view.header.cwd, workspacePath);
    return this.runReleasingLock(sessionId, 'on-error', async () => {
      this.adopt(sessionId);
      // Load the session BEFORE any lock acquisition or takeover: validating
      // expected_revision and identical-objective reuse is read-only, and a
      // stale expected_revision must never cancel a foreign writer. (The
      // per-workspace operation queue already serializes competing starts, so
      // the lock's pre-load reservation is unnecessary.)
      await this.ensureAgent(sessionId);
      const current = nativeGet(host, sessionId);
      if (input.expected_revision !== undefined && current !== undefined && input.expected_revision !== current.revision) {
        throw new BridgeError('REVISION_CONFLICT',
          `expected_revision mismatch: expected ${input.expected_revision}, but current revision is ${current.revision}`);
      }
      if (current !== undefined && current.phase !== 'complete') {
        if (current.objective === objective
          && (input.max_goal_rounds === undefined || input.max_goal_rounds === current.maxGoalRounds)) {
          if (this.isLockHolderActive(sessionId)) await this.takeWorkspaceLock(workspacePath, sessionId, { override: lockOverride, readOnly: this.isReadOnlySession(sessionId) });
          if (input.request_id !== undefined && input.request_id !== '') {
            this.rememberRequestId(input.request_id, { sessionId, fingerprint, goalId: current.id });
          }
          return await this.mapStartNative(sessionId, nativeGoalWire(sessionId, current), {
            existing_goal_reused: true,
            revision_unchanged: true,
          });
        }
        throw new BridgeError('GOAL_ALREADY_EXISTS',
          `session ${sessionId} already has a ${current.phase} native goal (revision ${current.revision}); use dsh_update_goal`,
          { goal_id: current.id, revision: current.revision });
      }
      // Fresh work never inherits the previous goal's concurrency exemption,
      // even if the host completed/replaced that goal without a terminal read.
      const freshReadOnly = createdHere && requestedReadOnly;
      await this.takeWorkspaceLock(workspacePath, sessionId, { override: lockOverride, readOnly: freshReadOnly });
      const native = nativeCreate(host, sessionId, {
        objective,
        ...(input.max_goal_rounds === undefined ? {} : { max_goal_rounds: input.max_goal_rounds }),
      });
      if (freshReadOnly) this.readOnlySessions.set(sessionId, native.id);
      if (input.request_id !== undefined && input.request_id !== '') {
        this.rememberRequestId(input.request_id, { sessionId, fingerprint, goalId: native.id });
      }
      return await this.mapStartNative(sessionId, nativeGoalWire(sessionId, native));
    });
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
    const { value, shared } = await this.goalFlights.run(input.request_id, fingerprint, () =>
      this.inSessionWorkspace(sessionId, async (workspacePath) => {
        const replayed = await this.replayGoalRequest(input.request_id, fingerprint, 'update_goal', workspacePath);
        if (replayed !== undefined) return replayed;
        const policy: LockPolicy = { readOnly: this.isReadOnlySession(sessionId) };
        await this.claimWorkspaceIfCold(workspacePath, sessionId, policy);
        return this.runReleasingLock(sessionId, 'always', async () => {
          this.adopt(sessionId);
          await this.ensureAgent(sessionId);
          let native;
          if (action === 'resume') {
            await this.takeWorkspaceLock(workspacePath, sessionId, policy);
            native = nativeResume(this.goalHost(), sessionId, input.expected_revision);
          } else if (action === 'pause') {
            ({ native } = await this.doPause(sessionId, input.expected_revision));
          } else {
            if (this.isLockHolderActive(sessionId)) await this.takeWorkspaceLock(workspacePath, sessionId, policy);
            native = nativeEdit(this.goalHost(), sessionId, {
              ...(input.goal === undefined ? {} : { objective: input.goal }),
              ...(input.max_goal_rounds === undefined ? {} : { max_goal_rounds: input.max_goal_rounds }),
              ...(input.expected_revision === undefined ? {} : { expected_revision: input.expected_revision }),
            });
          }
          if (input.request_id !== undefined && input.request_id !== '') {
            this.rememberRequestId(input.request_id, { sessionId, fingerprint, goalId: native.id });
          }
          const mapped = await this.mapStartNative(sessionId, nativeGoalWire(sessionId, native));
          // Parity with dsh_pause_goal: a pause reports the revision it parked
          // at. The value was always inside goal.revision; surfacing it under
          // the same key keeps the two doors interchangeable.
          return action === 'pause' ? { ...mapped, checkpoint_revision: native.revision } : mapped;
        });
      }));
    return shared ? { ...value, existing_goal_reused: true, revision_unchanged: true } : value;
  }

  async waitGoal(sessionId: string, waitSeconds?: number, sinceSeq?: number): Promise<GoalWaitResult> {
    return this.waits.goal(sessionId, waitSeconds, sinceSeq);
  }

  async stopGoal(sessionId: string): Promise<{
    session_id: string;
    stopped: true;
    already_stopped: boolean;
    status: BridgeStatus;
    cleanup_warning?: string;
  }> {
    return this.inSessionWorkspace(sessionId, async (workspacePath) => {
      this.adopt(sessionId);
      let agent = this.ctx.agents.get(SessionId(sessionId));
      if (agent === undefined && this.goalHost().goals !== undefined) {
        await this.claimWorkspaceIfCold(workspacePath, sessionId, { readOnly: this.isReadOnlySession(sessionId) });
        agent = await this.runReleasingLock(sessionId, 'on-error', () => this.ensureAgent(sessionId));
      }
      const view = await this.loadView(sessionId);
      const status = this.statusOf(sessionId, view);
      const current = nativeGet(this.goalHost(), sessionId);
      const waiting = this.relays.waitingFor(sessionId, view.events);
      const alreadyStopped = (current === undefined || current.phase === 'complete')
        && !this.isLockHolderActive(sessionId) && waiting.approvals.length === 0 && waiting.questions.length === 0;
      // Commit disarm/clear before yielding to cancellation. Never release the
      // workspace while the cancelled driver may still write to it.
      if (current !== undefined && current.phase !== 'complete') nativeClear(this.goalHost(), sessionId);
      this.relays.failClosed(sessionId);
      // Cancel + await quiescence for EVERY live agent, even when the goal is
      // already cleared. Public 'idle' status still hides whenIdle-tracked
      // maintenance work (the pinned Agent contract runs maintenance with
      // status idle), and stopping must make that settle before returning.
      // Cancel is a no-op on a truly idle agent.
      if (agent !== undefined) {
        agent.cancel({ kind: 'user' });
        await agent.whenIdle?.();
      }
      this.releaseUnusedWorkspaceLock(sessionId);
      this.readOnlySessions.delete(sessionId);
      // Logs and filename patterns cannot prove ownership. Stopping a session
      // never deletes its files, worktrees or persistent artifacts.
      return {
        session_id: sessionId,
        stopped: true as const,
        already_stopped: alreadyStopped,
        status: alreadyStopped ? status : 'cancelled' as const,
      };
    });
  }

  /**
   * A classification lives only while its goal does: completion, clear, cold
   * reload and external replacement (goal id changed) invalidate it. Pausing
   * retains the same generation's classification.
   */
  private pruneReadOnlyClassification(sessionId: string): void {
    const goalId = this.readOnlySessions.get(sessionId);
    if (goalId === undefined) return;
    const current = nativeGet(this.goalHost(), sessionId);
    if (current?.id !== goalId || current.phase === 'complete') this.readOnlySessions.delete(sessionId);
  }

  private isReadOnlySession(sessionId: string): boolean {
    this.pruneReadOnlyClassification(sessionId);
    return this.readOnlySessions.has(sessionId);
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
    policy: LockPolicy,
  ): void {
    if (policy.readOnly === true || policy.override === true) return;
    const holder = this.activeWorkspaceHolders(workspacePath, sessionId)[0];
    if (holder !== undefined) throw this.workspaceLockedError(holder);
  }

  /** Includes live host sessions, so a bridge reload cannot forget occupants. */
  private activeWorkspaceHolders(
    workspacePath: string,
    exceptSessionId?: string,
  ): { sessionId: string; goalId: string }[] {
    const holders = new Map<string, { sessionId: string; goalId: string }>();
    const existing = this.workspaceGuard.getLock(workspacePath);
    if (existing !== undefined && existing.sessionId !== exceptSessionId && this.isLockHolderActive(existing.sessionId)) {
      holders.set(existing.sessionId, existing);
    }
    for (const agent of this.ctx.agents.list()) {
      if (agent.id === exceptSessionId || this.isReadOnlySession(agent.id)) continue;
      if (!pathsEqual(agent.session.header.cwd ?? '', workspacePath) || !this.isLockHolderActive(agent.id)) continue;
      holders.set(agent.id, { sessionId: agent.id, goalId: nativeGet(this.goalHost(), agent.id)?.id ?? `session-${agent.id}` });
    }
    return [...holders.values()];
  }

  private async takeWorkspaceLock(
    workspacePath: string,
    sessionId: string,
    policy: LockPolicy,
  ): Promise<void> {
    const override = policy.override === true;
    // Read-only sessions never hold a lock. Classification registration is
    // explicit at the creation site (startGoal) — a missing local lock is NOT
    // evidence a session is read-only (a bridge reload wiped local locks).
    if (policy.readOnly === true) return;
    const holders = this.activeWorkspaceHolders(workspacePath, sessionId);
    if (holders.length > 0 && !override) throw this.workspaceLockedError(holders[0]);
    for (const holder of holders) {
      const agent = this.ctx.agents.get(SessionId(holder.sessionId));
      if (agent === undefined) continue;
      const goal = nativeGet(this.goalHost(), holder.sessionId);
      if (goal?.phase === 'active') nativePause(this.goalHost(), holder.sessionId);
      this.relays.failClosed(holder.sessionId);
      agent.cancel({ kind: 'user' });
      await agent.whenIdle?.();
      this.workspaceGuard.releaseLock(holder.sessionId);
      this.log.warn(`workspace takeover quiesced session ${holder.sessionId}`);
    }
    const lockRes = this.workspaceGuard.acquireMutableLock(workspacePath, sessionId, `goal-${sessionId}`, false, override);
    if (!lockRes.success && lockRes.holder !== undefined) throw this.workspaceLockedError(lockRes.holder);
    this.readOnlySessions.delete(sessionId);
  }

  /** Explicit dispatch cleanup: an armed goal is active even between turns. */
  private releaseUnusedWorkspaceLock(sessionId: string): void {
    if (!this.isLockHolderActive(sessionId)) this.workspaceGuard.releaseLock(sessionId);
  }

  /** Cold sessions must claim the workspace before any load validates them. */
  private async claimWorkspaceIfCold(
    workspacePath: string,
    sessionId: string,
    policy: LockPolicy,
  ): Promise<void> {
    if (this.ctx.agents.get(SessionId(sessionId)) === undefined) {
      await this.takeWorkspaceLock(workspacePath, sessionId, policy);
    }
  }

  /**
   * ONE lock-release skeleton for every dispatch. 'always' releases on success
   * too (the run already advanced the agent, or abandoned its claim);
   * 'on-error' keeps a successful reservation. The release is idempotent, so a
   * failed run under 'always' simply releases twice with no effect.
   */
  private async runReleasingLock<T>(
    sessionId: string,
    mode: 'always' | 'on-error',
    run: () => Promise<T>,
  ): Promise<T> {
    try {
      return await run();
    } catch (error) {
      this.releaseUnusedWorkspaceLock(sessionId);
      throw error;
    } finally {
      if (mode === 'always') this.releaseUnusedWorkspaceLock(sessionId);
    }
  }

  private releaseWorkspaceIfTerminal(sessionId: string, status: BridgeStatus): void {
    if (this.isLockHolderActive(sessionId)) return;
    const lock = this.workspaceGuard.getSessionLock(sessionId);
    // A read cannot revoke a reservation while a dispatch is loading/creating.
    if (lock !== undefined && this.workspaceOperations.isBusy(lock.workspacePath)) return;
    if (isTerminalStatus(status) || status === 'idle' || status === 'unknown') {
      this.workspaceGuard.releaseLock(sessionId);
      this.pruneReadOnlyClassification(sessionId);
    }
  }

  // The observed-mutation ledger was retired with execution-idempotency.ts:
  // evidence ids (derivedEvidenceIds below) are a pure function of facts, and
  // provenance comes from scoped facts — never a stored ledger.

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
