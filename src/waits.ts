/**
 * The wait plane: the two long-poll loops behind `dsh_wait_goal` and
 * `dsh_wait_until_action_required`, plus the per-session poll cursors and the
 * snapshot they answer from.
 *
 * Both loops speak one wire dialect (`goal_outcome`, `continuation_required`,
 * `next_tool_call`, `progress_delta`), and one rule decides the verdict: a
 * **parked human action always wins** over the native phase loop's three-value
 * outcome — otherwise `dsh_wait_goal` would report `timeout` while a question
 * is waiting to be answered. That rule and the cursor semantics live here
 * rather than interleaved with the goal verbs that arm and pause goals.
 *
 * The module holds no host reference of its own: `WaitHost` is the seam the
 * facade implements (load a view, derive its status, read the relay's parked
 * asks, release a workspace lock when the session turns terminal, and the two
 * injectable clock functions the unit tests drive).
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import { isActiveStatus, type BridgeStatus } from './status.js';
import type { WaitingState } from './ask-relay.js';
import type { LoadedView } from './session-read.js';
import { collectChangedFiles, foldSessionFacts, lastTurnSpan } from './session-facts.js';
import {
  PollCursorMap,
  computeCatchUpDelta,
  computeProgressDelta,
  nextPollCursor,
} from './session-delta.js';
import {
  DEFAULT_WAIT_SECONDS,
  WAIT_POLL_MS,
  clampWaitSeconds,
  nativeGet,
  nativeGoalWire,
  nativeWait,
  type GoalHostContext,
  type GoalWaitResult,
} from './goal-native.js';

/** What the wait plane needs from the facade. */
export interface WaitHost {
  /** Mark the session as bridge-managed (the wait verbs adopt like every verb). */
  adopt(sessionId: string): void;
  /** Load the live agent when attached, else the persisted log. */
  loadView(sessionId: string): Promise<LoadedView>;
  /** Derive the bridge status of a loaded view (parked asks included). */
  statusOf(sessionId: string, view: LoadedView): BridgeStatus;
  /** The relay's parked approvals/questions for this session. */
  waitingFor(sessionId: string, events: readonly SessionEvent[]): WaitingState;
  /** The host-goal seam (`ctx.goals` plus the agent lookup). */
  goalHost(): GoalHostContext;
  /** Release the workspace lock once the session is terminal. */
  releaseWorkspaceIfTerminal(sessionId: string, status: BridgeStatus): void;
  /** Injectable clock (unit tests replace it). */
  now(): number;
  /** Injectable sleep (unit tests replace it). */
  sleep(ms: number): Promise<void>;
}

/** The two wait verbs and the cursor state they answer from. */
export class WaitPlane {
  private readonly host: WaitHost;
  private readonly cursors = new PollCursorMap();

  constructor(host: WaitHost) {
    this.host = host;
  }

  /**
   * Bounded poll until the session stops being active, or the deadline passes.
   * Reports whatever the session looks like then — this verb never arms a goal.
   */
  async untilActionRequired(sessionId: string, waitSeconds = 120, sinceSeq?: number): Promise<GoalWaitResult> {
    this.host.adopt(sessionId);
    const seconds = Math.min(300, Math.max(1, waitSeconds));
    const started = this.host.now();
    const deadline = started + seconds * 1000;
    let view = await this.host.loadView(sessionId);
    let status = this.host.statusOf(sessionId, view);

    while (isActiveStatus(status) && this.host.now() < deadline) {
      const remaining = deadline - this.host.now();
      if (remaining <= 0) break;
      await this.host.sleep(Math.min(WAIT_POLL_MS, remaining));
      view = await this.host.loadView(sessionId);
      status = this.host.statusOf(sessionId, view);
      if (!isActiveStatus(status)) break;
    }
    return this.snapshot(sessionId, view, status, this.host.now() - started, seconds, sinceSeq);
  }

  /** Wait on the native goal loop, then report the unified snapshot. */
  async goal(sessionId: string, waitSeconds?: number, sinceSeq?: number): Promise<GoalWaitResult> {
    this.host.adopt(sessionId);
    const seconds = clampWaitSeconds(waitSeconds);
    const outcome = await nativeWait(this.host.goalHost(), sessionId, seconds, () => this.host.now(), (ms) => this.host.sleep(ms));
    const view = await this.host.loadView(sessionId);
    const status = this.host.statusOf(sessionId, view);
    const result = this.snapshot(sessionId, view, status, outcome.waited_ms, seconds, sinceSeq);
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

  /** One wait result: progress delta, goal view, parked asks, loop contract. */
  private snapshot(
    sessionId: string,
    view: LoadedView,
    status: BridgeStatus,
    waitedMs: number,
    waitSeconds: number,
    sinceSeq?: number,
  ): GoalWaitResult {
    const facts = foldSessionFacts(view.events);
    const waiting = this.host.waitingFor(sessionId, view.events);
    const waitKind = waiting.approvals.map((item) => item.approval_id);
    const waitQuestions = waiting.questions.map((item) => item.question_id);
    const span = lastTurnSpan(view.events);
    const changedFiles = span === undefined ? [] : collectChangedFiles(view.events, span.turn);
    const deltaInput = {
      events: view.events,
      ...(facts.todos === undefined ? {} : { todos: facts.todos }),
      status,
      changedFiles,
      approvalIds: waitKind,
      questionIds: waitQuestions,
      previous: this.cursors.get(sessionId),
      ...(view.agent === undefined ? {} : { agentStatus: view.agent.status }),
    };
    const progressDelta = sinceSeq === undefined
      ? computeProgressDelta(deltaInput)
      : computeCatchUpDelta(deltaInput, sinceSeq);
    if (sinceSeq === undefined) this.cursors.set(sessionId, nextPollCursor(deltaInput));
    const native = nativeGet(this.host.goalHost(), sessionId);
    this.host.releaseWorkspaceIfTerminal(sessionId, status);
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
}