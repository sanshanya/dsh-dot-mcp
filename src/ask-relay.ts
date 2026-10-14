/**
 * The human-in-the-loop relay plane: DSH asks (permission approvals and user
 * questions), parked for a remote driver and settled from the wire.
 *
 * Doctrine, one owner: 不归我 → next(); 宿主能答 → next(); 停车待答 → hold the
 * raw ask here until `dsh_approve` / `dsh_answer_question` lands, and show it in
 * TWO lanes — the parked entry (answerable) and the session log (evidence) —
 * which must agree on one identity per ask or the same ask surfaces twice.
 * The bridge never judges, annotates, or answers for the human; the only
 * exception is the operator switch `autoApproveEscalations`, which grants the
 * escalation the tool asked for instead of parking it.
 *
 * Everything a relay needs is here: its state, its wire shapes, and the log
 * mining that feeds them (a fold living in the status module is how the two
 * reporting lanes drifted apart twice).
 */
import { randomUUID } from 'node:crypto';
import type { Context } from '@deepseek-ai/cordis';
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval';
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions';
import type { SessionEvent } from '@deepseek-ai/dsh-session';
import type { BridgeLogger } from './log.js';
import { BridgeError } from './errors.js';
import { commandForCall } from './session-facts.js';

/** Structural session view: fixtures may stand in for a real host session. */
export interface ApprovalSession {
  events?: readonly { type: string; data?: unknown }[];
  snapshotEvents?: () => readonly { type: string; data?: unknown }[];
  header?: { cwd?: string };
}

/** The session's event log, tolerantly: both relays mine it. */
export function sessionLogOf(session: ApprovalSession | undefined) {
  return session?.snapshotEvents?.() ?? session?.events ?? [];
}

export interface ApprovalRequestLike {
  agent: {
    id: string;
    session?: ApprovalSession;
  };
  toolName: string;
  callId?: string;
  reason?: string;
  signal?: AbortSignal;
}

/** Structural `user-questions/request` payload (legacy hosts carry no `wait`). */
export interface QuestionRequestLike {
  questions: AskUserQuestionItem[];
  agent?: { id: string; session?: ApprovalSession } | undefined;
  wait?: { callId?: string } | undefined;
  signal?: AbortSignal | undefined;
}

/** One parked approval awaiting a driver decision. */
export interface PendingApproval {
  id: string;
  sessionId: string;
  toolName: string;
  callId?: string;
  reason?: string;
  command?: string;
  resolve: (outcome: ApprovalOutcome) => void;
}

/** One answerable user question awaiting a ChatGPT answer. */
export interface PendingQuestion {
  id: string;
  sessionId?: string;
  /**
   * The host tool call this ask belongs to. The event lane reports the same ask
   * under THIS id, so it is the only key that lets the two lanes recognise each
   * other — without it one open ask surfaced twice (golden E2E, 0.7.0-dev).
   * Modern hosts put it on `request.wait.callId`; legacy asks carry no wait at
   * all, so it is mined from the open `ask_user_question` call in the log.
   */
  callId?: string;
  /** The item(s) THIS id answers: exactly one for a member of a multi-question ask. */
  questions: AskUserQuestionItem[];
  resolve: (answer: AskUserQuestionAnswer) => void;
}

/** One answered question, in the host's own answer shape. */
type AskUserQuestionAnswerItem = { id: string; selected: string[]; custom?: string };

/** Narrow a collected answer, so an unanswered batch member never reaches the host. */
function isAnswer(item: AskUserQuestionAnswerItem | undefined): item is AskUserQuestionAnswerItem {
  return item !== undefined;
}

/**
 * One host ask and the answers collected for it. The host asks questions in
 * BATCHES and wants one answer per question; the wire exposes one answerable id
 * per question (`<batchId>#<index>`), so the batch is the accumulator that
 * settles the host promise once every question has an answer — answering the
 * first of two used to hand the agent one answer and let it guess the rest
 * (golden E2E, 0.7.0-dev).
 */
interface PendingQuestionBatch {
  sessionId?: string;
  callId?: string;
  items: { id: string; question: AskUserQuestionItem }[];
  answers: Map<string, AskUserQuestionAnswerItem>;
  resolve: (answer: AskUserQuestionAnswer) => void;
}

/** Wire-safe approval summary shown in dsh_get_session / dsh_get_task_status. */
export interface ApprovalSummary {
  approval_id: string;
  session_id: string;
  tool_name: string;
  call_id?: string;
  reason?: string;
  /**
   * The command text the approval is about, when the session log carries it.
   * The relay's job is to hand the driver the raw request it must judge; a
   * summary without this made that half of the job invisible on the wire
   * (golden E2E, 0.7.0-dev).
   */
  command?: string;
}

/** Wire-safe question summary shown in dsh_get_session / dsh_get_task_status. */
export interface QuestionSummary {
  question_id: string;
  /**
   * `parked`: a live ask this bridge can settle with dsh_answer_question.
   * `log`: the session log shows an open ask that no live pending backs (it
   * arrived before a restart, or the park has not landed yet) — reported so the
   * driver can SEE it, but answering that id fails closed.
   */
  source: 'parked' | 'log';
  session_id?: string;
  /** The host tool call behind the ask, when known (see PendingQuestion.callId). */
  call_id?: string;
  questions: AskUserQuestionItem[];
}

/** The two open-ask lanes, as one wire view. */
export interface WaitingState {
  approvals: ApprovalSummary[];
  questions: QuestionSummary[];
}

/** An approval/asked event that has no matching approval/decided. */
interface UndecidedApproval {
  id: string;
  toolName: string;
  callId?: string;
  reason?: string;
}

/**
 * Fold durable approval audit events. Used when the Web api-proxy (not this
 * process's parked map) owns the answerer.
 */
function undecidedApprovals(events: readonly SessionEvent[]): UndecidedApproval[] {
  const asked = new Map<string, UndecidedApproval>();
  const decided = new Set<string>();
  for (const event of events) {
    const data = event.data as { id?: string; toolName?: string; callId?: string; reason?: string } | undefined;
    if (event.type === 'approval/decided' && typeof data?.id === 'string') {
      decided.add(data.id);
    } else if (event.type === 'approval/asked' && typeof data?.id === 'string' && typeof data.toolName === 'string') {
      asked.set(data.id, {
        id: data.id,
        toolName: data.toolName,
        ...(data.callId === undefined ? {} : { callId: data.callId }),
        ...(data.reason === undefined ? {} : { reason: data.reason }),
      });
    }
  }
  return [...asked.values()].filter((item) => !decided.has(item.id));
}

/** An ask_user_question tool call that has not yet produced a tool/result. */
interface OpenAskUser {
  callId: string;
  arguments: string;
}

/**
 * Open ask_user_question calls. Questions are not durable session events;
 * the in-flight tool call is the only log signal when the Web provider owns the slot.
 */
function openAskUserQuestions(events: readonly SessionEvent[]): OpenAskUser[] {
  const open = new Map<string, OpenAskUser>();
  for (const event of events) {
    if (event.type === 'tool/call' && event.data.name === 'ask_user_question') {
      open.set(event.data.callId, { callId: event.data.callId, arguments: event.data.arguments });
    } else if (event.type === 'tool/result') {
      const callId = (event.data.message as { source?: { callId?: string } } | undefined)?.source?.callId;
      if (callId !== undefined) open.delete(callId);
    }
  }
  return [...open.values()];
}

/** What the relay needs to know about the bridge it serves. */
export interface RelayHost {
  /** Sessions created/adopted by this bridge: asks elsewhere are not ours. */
  isManaged(sessionId: string): boolean;
  /** True when an attached host client can answer (the relay then steps aside). */
  hostCanAnswer(): boolean;
  /** Operator switch: grant escalations instead of parking them. */
  autoApproveEscalations(): boolean;
}

/** The relay plane: park, report, decide. One instance per bridge. */
export class AskRelay {
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly questions = new Map<string, PendingQuestion>();
  private readonly questionBatches = new Map<string, PendingQuestionBatch>();
  private approvalsEnabled = false;
  private questionsEnabled = false;

  private readonly host: RelayHost;
  private readonly log: BridgeLogger;

  constructor(host: RelayHost, log: BridgeLogger) {
    this.host = host;
    this.log = log;
  }

  /** True once the approval waterfall listener is registered. */
  get approvalsReady(): boolean {
    return this.approvalsEnabled;
  }

  /** True once the question waterfall listener is registered. */
  get questionsReady(): boolean {
    return this.questionsEnabled;
  }

  /**
   * Register both asks on their host waterfalls, in front of any later
   * answerer. The bridge owns process lifecycle; the relay owns this state and
   * clears it on `clear()`.
   */
  start(ctx: Context): void {
    ctx.on('approval/request', (request, next) => this.decideApproval(request as ApprovalRequestLike, next), { prepend: true });
    this.approvalsEnabled = true;
    // Questions are optional: a profile without the userQuestions service simply
    // has no question slot to take (the approval listener above is unconditional).
    if (ctx.get('userQuestions') === undefined) return;
    try {
      ctx.on('user-questions/request', (request, next) => this.decideQuestion(
        request as QuestionRequestLike,
        next as () => Promise<AskUserQuestionAnswer>,
      ), { prepend: true });
      this.questionsEnabled = true;
    } catch (error) {
      this.log.warn(`userQuestions provider slot already taken by another plugin; questions will flow through it: ${String(error)}`);
      this.questionsEnabled = false;
    }
  }

  /**
   * Relay a DSH approval. Three moves, all of them honest:
   *   不归我  — next();  宿主能答 — next();
   *   停车待答 — parkApproval 把问题原样交给 dot（dsh_approve）.
   * 感知 = 挖出命令文本（宿主请求不带它）；桥不附注、不代答、不裁决。
   */
  async decideApproval(
    request: ApprovalRequestLike,
    next: () => Promise<ApprovalOutcome> | ApprovalOutcome = () => Promise.resolve('rejected' as ApprovalOutcome),
  ): Promise<ApprovalOutcome> {
    if (!this.host.isManaged(request.agent.id)) return next();
    // Operator switch: grant the ask to the mode the tool requested (an
    // escalation target, i.e. the widest available) without waiting for a
    // driver or the GUI. Deliberately BEFORE hostCanAnswer: "never ask" means
    // an attached client does not get the card either.
    if (this.host.autoApproveEscalations()) {
      this.log.warn(`auto-approved ${request.toolName} on session ${request.agent.id} (autoApproveEscalations is on)`);
      return 'allowed-once';
    }
    if (this.host.hostCanAnswer()) {
      this.log.info(`host client attached; approval for ${request.toolName} on session ${request.agent.id} left to the host`);
      return next();
    }
    const events = sessionLogOf(request.agent.session);
    return this.parkApproval(request, commandForCall(events, request.callId));
  }

  /**
   * Relay a DSH user question. Same three moves as the approval relay:
   * 不归我 → next(); 宿主能答 → next(); 停车待答 → one answerable entry per
   * question, settled once every question of the ask has an answer
   * (dsh_answer_question). 感知 = the host call id that the two reporting lanes
   * share; the bridge neither annotates nor answers for the human.
   */
  async decideQuestion(
    request: QuestionRequestLike,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> {
    if (request.agent !== undefined && !this.host.isManaged(request.agent.id)) return next();
    if (this.host.hostCanAnswer()) {
      this.log.info(`host client attached; question on session ${request.agent?.id ?? '(no agent)'} left to the host`);
      return next();
    }
    if (request.signal?.aborted) return { answers: [] };
    const batchId = `question-${randomUUID().slice(0, 8)}`;
    const sessionId = request.agent?.id;
    const callId = this.questionCallIdFor(request);
    // One question keeps the bare batch id: the single-ask wire shape (and the
    // ids drivers already hold) does not change. A batch exposes one id per
    // question so each can be answered on its own options.
    const items = request.questions.map((question, index) => ({
      id: request.questions.length === 1 ? batchId : `${batchId}#${index}`,
      question,
    }));
    const answers = new Map<string, AskUserQuestionAnswerItem>();
    return new Promise<AskUserQuestionAnswer>((resolve) => {
      const cleanup = () => {
        this.questionBatches.delete(batchId);
        for (const item of items) this.questions.delete(item.id);
      };
      const settle = (answer: AskUserQuestionAnswer) => {
        request.signal?.removeEventListener('abort', abort);
        cleanup();
        resolve(answer);
      };
      // Aborting (turn cancelled / bridge disposed) fails the ask closed with the
      // answers the human already gave — never with invented ones.
      const abort = () => settle({ answers: items.map((item) => answers.get(item.id)).filter(isAnswer) });
      this.questionBatches.set(batchId, {
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(callId === undefined ? {} : { callId }),
        items,
        answers,
        resolve: settle,
      });
      for (const item of items) {
        this.questions.set(item.id, {
          id: item.id,
          ...(sessionId === undefined ? {} : { sessionId }),
          ...(callId === undefined ? {} : { callId }),
          questions: [item.question],
          resolve: settle,
        });
      }
      request.signal?.addEventListener('abort', abort, { once: true });
      this.log.info(`question ${batchId} pending for session ${sessionId ?? '(no agent)'} (${items.length} item(s))`);
    });
  }

  /**
   * The host call id behind an ask. Modern hosts carry it on `request.wait`;
   * legacy asks carry no wait at all, and without it the parked lane and the
   * event lane report ONE ask under two id spaces (golden E2E, 0.7.0-dev) — so
   * mine the open `ask_user_question` call from the log, matching on the asked
   * question ids and falling back to the newest open ask.
   */
  private questionCallIdFor(request: QuestionRequestLike): string | undefined {
    if (request.wait?.callId !== undefined) return request.wait.callId;
    // The structural session type is loose so fixtures can stand in for a host
    // session; a real one is a Session, so the log is a SessionEvent list.
    const open = openAskUserQuestions(sessionLogOf(request.agent?.session) as readonly SessionEvent[]);
    if (open.length === 0) return undefined;
    const wanted = request.questions.map((item) => item.id ?? '').join('\u0000');
    for (let index = open.length - 1; index >= 0; index -= 1) {
      const candidate = open[index];
      if (candidate === undefined) continue;
      try {
        const parsed = JSON.parse(candidate.arguments) as { questions?: { id?: string }[] };
        if ((parsed.questions ?? []).map((item) => item.id ?? '').join('\u0000') === wanted) return candidate.callId;
      } catch {
        // Unparsable arguments: the newest open ask below is the honest fallback.
      }
    }
    return open[open.length - 1]?.callId;
  }

  /**
   * 回答通道：把问题停车悬起（dsh_get_task_status / wait 工具可见），
   * dsh_approve 落地；turn 中止/清理一律 fail-closed 为 'cancelled'。
   */
  private parkApproval(request: ApprovalRequestLike, command?: string): Promise<ApprovalOutcome> {
    const id = `approval-${randomUUID()}`;
    const pending: PendingApproval = {
      id,
      sessionId: request.agent.id,
      toolName: request.toolName,
      callId: request.callId,
      reason: request.reason,
      ...(command === undefined ? {} : { command }),
      resolve: () => {},
    };
    const decision = new Promise<ApprovalOutcome>((resolve) => {
      pending.resolve = resolve;
    });
    this.approvals.set(id, pending);
    this.log.info(`approval ${id} pending for session ${request.agent.id} (tool ${request.toolName})`);
    request.signal?.addEventListener(
      'abort',
      () => {
        if (this.approvals.delete(id)) {
          this.log.info(`approval ${id} withdrawn (turn aborted)`);
          pending.resolve('cancelled');
        }
      },
      { once: true },
    );
    return decision;
  }

  /** Decide one parked approval. Ids are exact; a foreign session is refused. */
  async approve(sessionId: string, approvalId: string, decision: 'approve' | 'reject'): Promise<{
    approval_id: string;
    session_id: string;
    decision: 'approve' | 'reject';
    outcome: ApprovalOutcome;
    layer: 'user';
    fail_closed?: boolean;
  }> {
    const pending = this.approvals.get(approvalId);
    if (pending === undefined) {
      throw new BridgeError('APPROVAL_NOT_FOUND', `no pending approval ${approvalId}`);
    }
    if (pending.sessionId !== sessionId) {
      throw new BridgeError('APPROVAL_SESSION_MISMATCH', `approval ${approvalId} belongs to session ${pending.sessionId}`);
    }
    const outcome: ApprovalOutcome = decision === 'approve' ? 'allowed-once' : 'rejected';
    pending.resolve(outcome);
    this.approvals.delete(approvalId);
    this.log.info(`approval ${approvalId} decided: ${decision}`);
    return { approval_id: approvalId, session_id: sessionId, decision, outcome, layer: 'user' };
  }

  /**
   * Answer ONE answerable question. A multi-question ask is answered item by
   * item: each id is validated against ITS OWN options, and the host promise
   * settles only when every question has an answer.
   */
  async answerQuestion(questionId: string, sessionId: string | undefined, answer: {
    selected: string[];
    custom?: string;
  }): Promise<{ answered: true; remaining_questions: number; next_question_id?: string }> {
    const pending = this.questions.get(questionId);
    if (pending === undefined || (sessionId !== undefined && pending.sessionId !== sessionId)) {
      throw new BridgeError('QUESTION_NOT_FOUND', `no pending question ${questionId}`);
    }
    // Validation is per ANSWERABLE ID, i.e. per question of the ask: a batch's
    // second question is judged on its own options, not the first one's.
    const question = pending.questions[0];
    const labels = new Set(question?.options?.map((option) => option.label) ?? []);
    if (answer.selected.some((label) => !labels.has(label))) {
      throw new BridgeError('INVALID_ANSWER', `selected option(s) are not offered by question ${questionId}`);
    }
    if (question?.multiSelect !== true && answer.selected.length > 1) {
      throw new BridgeError('INVALID_ANSWER', `question ${questionId} is single-select`);
    }
    const record: AskUserQuestionAnswerItem = {
      id: question?.id ?? questionId,
      selected: answer.selected,
      ...(answer.custom === undefined ? {} : { custom: answer.custom }),
    };
    const batch = this.questionBatches.get(questionId.split('#')[0] ?? questionId);
    if (batch === undefined) {
      // No batch behind this entry: it IS the whole ask.
      this.questions.delete(pending.id);
      pending.resolve({ answers: [record] });
      this.log.info(`question ${questionId} answered`);
      return { answered: true, remaining_questions: 0 };
    }
    batch.answers.set(questionId, record);
    this.questions.delete(questionId);
    const remaining = batch.items.filter((item) => !batch.answers.has(item.id));
    if (remaining.length === 0) {
      // Every question answered: hand the host the batch in the order it asked.
      batch.resolve({ answers: batch.items.map((item) => batch.answers.get(item.id)).filter(isAnswer) });
      this.log.info(`question ${questionId} answered; batch complete`);
      return { answered: true, remaining_questions: 0 };
    }
    const next = remaining[0];
    this.log.info(`question ${questionId} answered; ${remaining.length} left in the ask`);
    return {
      answered: true,
      remaining_questions: remaining.length,
      ...(next === undefined ? {} : { next_question_id: next.id }),
    };
  }

  /**
   * The two-lane open-ask view for one session: parked entries first (the
   * answerable ids), then asks only the session log knows about.
   */
  waitingFor(sessionId: string, events?: readonly SessionEvent[]): WaitingState {
    const seenApprovals = new Set<string>();
    const approvals: ApprovalSummary[] = [];
    for (const pending of this.approvals.values()) {
      if (pending.sessionId !== sessionId) continue;
      seenApprovals.add(pending.id);
      approvals.push({
        approval_id: pending.id,
        session_id: pending.sessionId,
        tool_name: pending.toolName,
        ...(pending.callId === undefined ? {} : { call_id: pending.callId }),
        ...(pending.reason === undefined ? {} : { reason: pending.reason }),
        ...(pending.command === undefined ? {} : { command: pending.command }),
      });
    }
    if (events !== undefined) {
      for (const item of undecidedApprovals(events)) {
        if (seenApprovals.has(item.id)) continue;
        // Same mining as the parked lane: an approval observed only in the log
        // (bridge restarted, or the ask never reached this process) still
        // carries its command when the log has it.
        const command = item.callId === undefined ? undefined : commandForCall(events, item.callId);
        approvals.push({
          approval_id: item.id,
          session_id: sessionId,
          tool_name: item.toolName,
          ...(item.callId === undefined ? {} : { call_id: item.callId }),
          ...(item.reason === undefined ? {} : { reason: item.reason }),
          ...(command === undefined ? {} : { command }),
        });
      }
    }
    const seenQuestions = new Set<string>();
    const questions: QuestionSummary[] = [];
    for (const pending of this.questions.values()) {
      if (pending.sessionId !== sessionId) continue;
      seenQuestions.add(pending.id);
      // Both key spaces: the parked id answers dsh_answer_question, the host
      // callId is what the event lane reports this same ask under.
      if (pending.callId !== undefined) seenQuestions.add(pending.callId);
      questions.push({
        question_id: pending.id,
        source: 'parked',
        ...(pending.sessionId === undefined ? {} : { session_id: pending.sessionId }),
        ...(pending.callId === undefined ? {} : { call_id: pending.callId }),
        questions: pending.questions,
      });
    }
    if (events !== undefined) {
      for (const item of openAskUserQuestions(events)) {
        if (seenQuestions.has(item.callId)) continue;
        let parsed: { questions?: AskUserQuestionItem[] } | undefined;
        try {
          parsed = JSON.parse(item.arguments) as { questions?: AskUserQuestionItem[] };
        } catch {
          parsed = undefined;
        }
        questions.push({
          question_id: item.callId,
          source: 'log',
          session_id: sessionId,
          questions: parsed?.questions ?? [],
        });
      }
    }
    return { approvals, questions };
  }

  /** Fail every ask of one session closed (stop/abort): nothing waits forever. */
  failClosed(sessionId: string): void {
    for (const pending of [...this.approvals.values()]) {
      if (pending.sessionId !== sessionId) continue;
      this.approvals.delete(pending.id);
      pending.resolve('cancelled');
    }
    for (const pending of [...this.questions.values()]) {
      if (pending.sessionId !== sessionId) continue;
      this.questions.delete(pending.id);
      pending.resolve({ answers: [] });
    }
  }

  /** Fail everything closed (plugin disposal). */
  clear(): void {
    for (const pending of [...this.approvals.values()]) {
      this.approvals.delete(pending.id);
      pending.resolve('cancelled');
    }
    for (const pending of [...this.questions.values()]) {
      this.questions.delete(pending.id);
      pending.resolve({ answers: [] });
    }
    this.questionBatches.clear();
  }
}