/**
 * Thin mapping layer onto the host's native GoalService (`dsh-goal`,
 * injected as `ctx.goals`). No supervision vocabulary of our own: the goal
 * state machine (active | paused | blocked | complete + clear tombstone),
 * the revision CAS, the round budget, and the armed/disarmed activation
 * edge all live in the host. This module only shapes the wire surface and
 * translates host errors into stable bridge error codes.
 *
 * Host reference: packages/goal/goal (GoalService) — methods take the live
 * Agent handle, resolved through `ctx.agents.get(SessionId)` here.
 */

/** Durable native goal phase (host vocabulary). */
export type NativeGoalPhase = 'active' | 'paused' | 'blocked' | 'complete';

/** Process-local activation edge (never persisted by the host). */
export type NativeGoalActivation = 'armed' | 'disarmed';

/** Host GoalService view, structurally mirrored (no host package import). */
export interface HostGoalView {
  id: string;
  revision: number;
  objective: string;
  phase: NativeGoalPhase;
  blockedReason?: { code: string; message: string };
  maxGoalRounds: number;
  roundsStarted: number;
  createdAt: number;
  updatedAt: number;
  activation: NativeGoalActivation;
}

/** Structural `ctx.goals` handle. */
export interface HostGoalsService {
  get(agent: unknown): HostGoalView | undefined;
  create(agent: unknown, request: { objective: string; maxGoalRounds?: number }): HostGoalView;
  edit(agent: unknown, ref: { id: string; revision: number }, request: { objective?: string; maxGoalRounds?: number }): HostGoalView;
  pause(agent: unknown, ref: { id: string; revision: number }): HostGoalView;
  resume(agent: unknown, ref: { id: string; revision: number }): HostGoalView;
  clear(agent: unknown, ref: { id: string; revision: number }): unknown;
}

/** Structural `ctx` surface this module needs. */
export interface GoalHostContext {
  agents: { get(sessionId: string): unknown };
  goals?: HostGoalsService | undefined;
}

/** Error shape thrown by the host's GoalService. */
interface HostGoalError extends Error {
  code?: string;
}

/** Stable wire shape returned by every dsh_*goal tool. */
export interface NativeGoalWire {
  goal_id: string;
  revision: number;
  phase: NativeGoalPhase;
  objective: string;
  max_goal_rounds: number;
  rounds_started: number;
  created_at: number;
  updated_at: number;
  activation: NativeGoalActivation;
  blocked_reason?: { code: string; message: string };
  session_id: string;
}

/** Map a host view to the wire shape. */
export function nativeGoalWire(sessionId: string, view: HostGoalView): NativeGoalWire {
  return {
    goal_id: view.id,
    revision: view.revision,
    phase: view.phase,
    objective: view.objective,
    max_goal_rounds: view.maxGoalRounds,
    rounds_started: view.roundsStarted,
    created_at: view.createdAt,
    updated_at: view.updatedAt,
    activation: view.activation,
    ...(view.blockedReason === undefined ? {} : { blocked_reason: view.blockedReason }),
    session_id: sessionId,
  };
}

/** Stable bridge error codes for goal failures. */
/** Typed bridge error with a stable machine-readable code (single identity for the wire; defined here so goal-native never imports bridge). */
export class BridgeError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Host-goal failure translated for the wire: still a BridgeError, since goal-native.ts must not import bridge.ts (bridge imports this module). */
export class GoalNativeError extends BridgeError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = 'GoalNativeError';
  }
}

/** Translate host GoalError codes into bridge codes. */
function mapHostError(err: unknown, sessionId: string): never {
  const host = err as HostGoalError;
  const message = host?.message ?? String(err);
  switch (host?.code) {
    case 'GOAL_STALE_REVISION':
      throw new GoalNativeError('REVISION_CONFLICT', message);
    case 'GOAL_NOT_FOUND':
      throw new GoalNativeError('GOAL_NOT_FOUND', message);
    case 'GOAL_ALREADY_EXISTS':
      throw new GoalNativeError('GOAL_ALREADY_EXISTS', message);
    case 'GOAL_INVALID_OBJECTIVE':
      throw new GoalNativeError('GOAL_INVALID', message);
    case 'GOAL_INVALID_MAX_ROUNDS':
      throw new GoalNativeError('GOAL_INVALID', message);
    case 'GOAL_INVALID_TRANSITION':
      throw new GoalNativeError('GOAL_INVALID_TRANSITION', message);
    case 'GOAL_INVALID_EDIT':
      throw new GoalNativeError('GOAL_INVALID', message);
    case 'GOAL_INVALID_BLOCK_REASON':
      throw new GoalNativeError('GOAL_INVALID', message);
    case 'GOAL_AGENT_NOT_LIVE':
      throw new GoalNativeError('SESSION_NOT_LIVE', message);
    default:
      throw new GoalNativeError('GOAL_HOST_ERROR', `host goal service failed for session ${sessionId}: ${message}`);
  }
}

/** Resolve the goals service or fail with a stable code. */
function requireGoals(ctx: GoalHostContext): HostGoalsService {
  const goals = ctx.goals;
  if (goals === undefined) {
    throw new GoalNativeError('GOAL_UNAVAILABLE', 'host goal service (goals) is not injected in this profile');
  }
  return goals;
}

/** Resolve the live agent for a session or fail with the established code. */
export function requireAgent(ctx: GoalHostContext, sessionId: string): unknown {
  const agent = ctx.agents.get(sessionId);
  if (agent === undefined) {
    throw new GoalNativeError('SESSION_NOT_FOUND', `unknown session_id "${sessionId}" or session is not live`);
  }
  return agent;
}

/** Read the current native goal of a session (absent → undefined). */
export function nativeGet(ctx: GoalHostContext, sessionId: string): HostGoalView | undefined {
  const goals = ctx.goals;
  if (goals === undefined) return undefined;
  const agent = ctx.agents.get(sessionId);
  if (agent === undefined) return undefined;
  return goals.get(agent);
}

/** Create a goal on a session. GOAL_ALREADY_EXISTS surfaces unchanged. */
export function nativeCreate(
  ctx: GoalHostContext,
  sessionId: string,
  input: { objective: string; max_goal_rounds?: number },
): HostGoalView {
  const goals = requireGoals(ctx);
  const agent = requireAgent(ctx, sessionId);
  try {
    return goals.create(agent, {
      objective: input.objective,
      ...(input.max_goal_rounds === undefined ? {} : { maxGoalRounds: input.max_goal_rounds }),
    });
  } catch (err) {
    mapHostError(err, sessionId);
  }
}

/** Revision-CAS reference built from the caller's expected revision. */
function refFor(view: HostGoalView, expectedRevision?: number): { id: string; revision: number } {
  return { id: view.id, revision: expectedRevision ?? view.revision };
}

/** Shared guard: the goal exists on this session or throw. */
function requireCurrentGoal(ctx: GoalHostContext, sessionId: string): HostGoalView {
  const view = nativeGet(ctx, sessionId);
  if (view === undefined) {
    throw new GoalNativeError('GOAL_NOT_FOUND', `no native goal on session ${sessionId}`);
  }
  return view;
}

/** Edit objective and/or round cap (native `edit`). */
export function nativeEdit(
  ctx: GoalHostContext,
  sessionId: string,
  input: { objective?: string; max_goal_rounds?: number; expected_revision?: number },
): HostGoalView {
  const goals = requireGoals(ctx);
  const agent = requireAgent(ctx, sessionId);
  const current = requireCurrentGoal(ctx, sessionId);
  if (input.objective === undefined && input.max_goal_rounds === undefined) {
    throw new GoalNativeError('GOAL_INVALID', 'edit requires objective and/or max_goal_rounds');
  }
  try {
    return goals.edit(agent, refFor(current, input.expected_revision), {
      ...(input.objective === undefined ? {} : { objective: input.objective }),
      ...(input.max_goal_rounds === undefined ? {} : { maxGoalRounds: input.max_goal_rounds }),
    });
  } catch (err) {
    mapHostError(err, sessionId);
  }
}

/** Pause the current goal (native `pause`). */
export function nativePause(
  ctx: GoalHostContext,
  sessionId: string,
  expectedRevision?: number,
): HostGoalView {
  const goals = requireGoals(ctx);
  const agent = requireAgent(ctx, sessionId);
  const current = requireCurrentGoal(ctx, sessionId);
  try {
    return goals.pause(agent, refFor(current, expectedRevision));
  } catch (err) {
    mapHostError(err, sessionId);
  }
}

/** Resume the current goal (native `resume`; round budget enforced by host). */
export function nativeResume(
  ctx: GoalHostContext,
  sessionId: string,
  expectedRevision?: number,
): HostGoalView {
  const goals = requireGoals(ctx);
  const agent = requireAgent(ctx, sessionId);
  const current = requireCurrentGoal(ctx, sessionId);
  try {
    return goals.resume(agent, refFor(current, expectedRevision));
  } catch (err) {
    mapHostError(err, sessionId);
  }
}

/** Stop semantics: native `clear` keeps a durable tombstone. */
export function nativeClear(
  ctx: GoalHostContext,
  sessionId: string,
  expectedRevision?: number,
): void {
  const goals = requireGoals(ctx);
  const agent = requireAgent(ctx, sessionId);
  const current = requireCurrentGoal(ctx, sessionId);
  try {
    goals.clear(agent, refFor(current, expectedRevision));
  } catch (err) {
    mapHostError(err, sessionId);
  }
}

/** Phases that end a goal wait loop. */
const WAIT_TERMINAL_PHASES: readonly NativeGoalPhase[] = ['paused', 'blocked', 'complete'];

/**
 * Bounded wait on the native goal surface. Terminals: goal cleared (gone),
 * or durable phase paused/blocked/complete. Polling because the host's
 * scoped `goal/changed` event requires agent-scope dispatch; a 250 ms poll
 * is well under the wait quanta and keeps this surface dependency-free.
 */
export const WAIT_POLL_MS = 250;

export async function nativeWait(
  ctx: GoalHostContext,
  sessionId: string,
  seconds: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<{ outcome: 'ended' | 'no_goal' | 'timeout'; goal?: HostGoalView; waited_ms: number }> {
  const started = now();
  const deadline = started + seconds * 1000;
  let view = nativeGet(ctx, sessionId);
  while (true) {
    if (view === undefined) {
      return { outcome: 'no_goal', waited_ms: now() - started };
    }
    if (WAIT_TERMINAL_PHASES.includes(view.phase)) {
      return { outcome: 'ended', goal: view, waited_ms: now() - started };
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      return { outcome: 'timeout', goal: view, waited_ms: now() - started };
    }
    await sleep(Math.min(WAIT_POLL_MS, remaining));
    view = nativeGet(ctx, sessionId);
  }
}

// ── wait/start tool contract constants ──────────────────────────────────────

export const DEFAULT_WAIT_SECONDS = 25;
const MIN_WAIT_SECONDS = 1;
export const MAX_WAIT_SECONDS = 30;

/** Clamp a client wait_seconds to the tool's bounded window. */
export function clampWaitSeconds(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return DEFAULT_WAIT_SECONDS;
  return Math.min(MAX_WAIT_SECONDS, Math.max(MIN_WAIT_SECONDS, Math.floor(value)));
}

/** Short human title derived from the goal text for session headers. */
export function titleFromGoal(goal: string): string {
  const line = goal.trim().split('\n')[0] ?? '';
  const collapsed = line.replace(/\s+/g, ' ').trim();
  return collapsed.length <= 60 ? collapsed : collapsed.slice(0, 57) + '…';
}

// ── goal tool wire results ──────────────────────────────────────────────────

/** Wire output of dsh_start_goal / dsh_create_goal / revise/update/resume. */
export interface GoalStartResult {
  session_id: string;
  status: string;
  goal: NativeGoalWire;
  continuation_required: boolean;
  next_tool_call?: { tool: string; arguments: Record<string, unknown> };
  existing_goal_reused?: boolean;
  revision_unchanged?: boolean;
}

/** Wire output of dsh_wait_goal / dsh_wait_until_action_required. */
export interface GoalWaitResult {
  session_id: string;
  status: string;
  waited_ms: number;
  wait_seconds: number;
  goal?: NativeGoalWire;
  goal_outcome?: 'ended' | 'no_goal' | 'timeout' | 'action_required';
  continuation_required: boolean;
  next_tool_call?: { tool: string; arguments: Record<string, unknown> };
  approval?: { approval_id: string; tool_name: string; reason?: string };
  question?: { question_id: string };
  progress_delta?: unknown;
  cleanup_warning?: string;
}

/** Shape a start/update result with the established loop contract. */
export function mapGoalStartNative(
  sessionId: string,
  status: string,
  goal: NativeGoalWire,
  extras?: { existing_goal_reused?: boolean; revision_unchanged?: boolean },
): GoalStartResult {
  // Loop contract: an armed active goal keeps driving rounds; keep waiting.
  const running = status === 'running' || status === 'queued'
    || (goal.phase === 'active' && goal.activation === 'armed');
  return {
    session_id: sessionId,
    status,
    goal,
    continuation_required: running,
    ...(running === false
      ? {}
      : { next_tool_call: { tool: 'dsh_wait_goal', arguments: { session_id: sessionId, wait_seconds: DEFAULT_WAIT_SECONDS } } }),
    ...(extras?.existing_goal_reused === true ? { existing_goal_reused: true } : {}),
    ...(extras?.revision_unchanged === true ? { revision_unchanged: true } : {}),
  };
}
