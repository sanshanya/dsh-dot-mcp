/**
 * Bounded polling delta over a session event sequence.
 * Stores only a cursor, never unbounded history.
 */
import type { ActionKind, LooseEvent } from './session-facts.js';
import { lastEventSeq, parseArgsJson, extractCommand, toolResultOutcome } from './session-facts.js';
import { classifyCommand } from './command-classify.js';

export const DELTA_EVENTS_MAX = 40;
const POLL_CURSOR_CAP = 256;

export interface TodoChange {
  content: string;
  from: string;
  to: string;
}

export interface DeltaEvent {
  seq: number;
  type: string;
  name?: string;
  kind?: ActionKind;
  ok?: boolean;
}

export interface ProgressDelta {
  since_seq?: number;
  until_seq?: number;
  current_step?: string;
  status_changed: boolean;
  todos_changed: TodoChange[];
  new_events: DeltaEvent[];
  new_approvals: string[];
  new_questions: string[];
  new_changed_files: string[];
  agent_status_changed: boolean;
}

export interface PollCursor {
  seq: number;
  status: string;
  todos: { content: string; status: string }[];
  files: string[];
  agentStatus?: string;
  approvalIds: string[];
  questionIds: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

function summarizeEvent(event: LooseEvent): DeltaEvent {
  const data = asRecord(event.data);
  const out: DeltaEvent = { seq: event.seq, type: event.type };
  if (event.type === 'tool/call' && data !== undefined) {
    if (typeof data.name === 'string') out.name = data.name;
    const raw = typeof data.arguments === 'string' ? data.arguments : '';
    const args = raw === '' ? undefined : parseArgsJson(raw);
    const command = args === undefined ? undefined : extractCommand(args);
    const kinds = command === undefined ? [] : classifyCommand(command);
    const kind = kinds.find((item) => item !== 'unknown');
    if (kind !== undefined) out.kind = kind;
  } else if (event.type === 'tool/result') {
    const source = asRecord(asRecord(data?.message)?.source);
    if (typeof source?.callId === 'string') out.name = source.callId;
    out.ok = toolResultOutcome(event.data).ok;
  } else if (event.type === 'todo/write') {
    out.name = 'todo';
  }
  return out;
}

function todoChanges(
  previous: { content: string; status: string }[] | undefined,
  current: { content: string; status: string }[] | undefined,
): TodoChange[] {
  const prev = new Map((previous ?? []).map((todo) => [todo.content, todo.status]));
  const changes: TodoChange[] = [];
  for (const todo of current ?? []) {
    const from = prev.get(todo.content);
    if (from === undefined) {
      changes.push({ content: todo.content, from: '(none)', to: todo.status });
    } else if (from !== todo.status) {
      changes.push({ content: todo.content, from, to: todo.status });
    }
  }
  return changes;
}

export interface DeltaInput {
  events: readonly LooseEvent[];
  todos?: { content: string; status: string }[];
  status: string;
  changedFiles: string[];
  agentStatus?: string;
  approvalIds: string[];
  questionIds: string[];
  previous?: PollCursor;
  currentStep?: string;
}

export function computeProgressDelta(input: DeltaInput): ProgressDelta {
  const until = lastEventSeq(input.events);
  const since = input.previous?.seq;
  const newEvents = input.events
    .filter((event) => since === undefined || event.seq > since)
    .map(summarizeEvent);
  const capped = newEvents.length <= DELTA_EVENTS_MAX
    ? newEvents
    : newEvents.slice(newEvents.length - DELTA_EVENTS_MAX);

  const prevApprovals = new Set(input.previous?.approvalIds ?? []);
  const prevQuestions = new Set(input.previous?.questionIds ?? []);
  const prevFiles = new Set(input.previous?.files ?? []);

  return {
    ...(since === undefined ? {} : { since_seq: since }),
    ...(until === undefined ? {} : { until_seq: until }),
    ...(input.currentStep === undefined || input.currentStep === '' ? {} : { current_step: input.currentStep }),
    status_changed: input.previous !== undefined && input.previous.status !== input.status,
    todos_changed: todoChanges(input.previous?.todos, input.todos),
    new_events: capped,
    new_approvals: input.approvalIds.filter((id) => !prevApprovals.has(id)),
    new_questions: input.questionIds.filter((id) => !prevQuestions.has(id)),
    new_changed_files: input.changedFiles.filter((file) => !prevFiles.has(file)),
    agent_status_changed: input.previous !== undefined && input.previous.agentStatus !== input.agentStatus,
  };
}

export function nextPollCursor(input: DeltaInput): PollCursor {
  return {
    seq: lastEventSeq(input.events) ?? input.previous?.seq ?? -1,
    status: input.status,
    todos: (input.todos ?? []).map((todo) => ({ content: todo.content, status: todo.status })),
    files: [...input.changedFiles],
    ...(input.agentStatus === undefined ? {} : { agentStatus: input.agentStatus }),
    approvalIds: [...input.approvalIds],
    questionIds: [...input.questionIds],
  };
}

/**
 * Client-held cursor catch-up (resumable reads).
 *
 * computeProgressDelta() keeps only the LAST DELTA_EVENTS_MAX events, which is
 * correct for a live poll but silently loses the middle of a burst for a client
 * that reconnects later. Here the FIRST events after `sinceSeq` are returned and
 * until_seq is the seq of the last event ACTUALLY returned, so a caller can page
 * forward without gaps:
 *
 *   let cursor = 0;
 *   for (;;) {
 *     const delta = (await wait({ since_seq: cursor })).progress_delta;
 *     if (delta.until_seq !== undefined) cursor = delta.until_seq;
 *     if (delta.new_events.length < 40) break;  // caught up
 *   }
 *
 * A bare seq carries no snapshot baseline, so the snapshot-derived fields
 * (status_changed, todos_changed, new_approvals, new_questions,
 * new_changed_files, agent_status_changed) are reported against an EMPTY
 * baseline in this mode: they describe the current sets rather than a delta.
 * new_events is exact in both modes.
 */
export function computeCatchUpDelta(input: DeltaInput, sinceSeq: number): ProgressDelta {
  const newEvents = input.events
    .filter((event) => event.seq > sinceSeq)
    .map(summarizeEvent);
  const capped = newEvents.slice(0, DELTA_EVENTS_MAX);
  const untilSeq = capped.length > 0 ? capped[capped.length - 1].seq : sinceSeq;
  return {
    since_seq: sinceSeq,
    until_seq: untilSeq,
    ...(input.currentStep === undefined || input.currentStep === '' ? {} : { current_step: input.currentStep }),
    status_changed: false,
    todos_changed: [],
    new_events: capped,
    new_approvals: [...input.approvalIds],
    new_questions: [...input.questionIds],
    new_changed_files: [...input.changedFiles],
    agent_status_changed: false,
  };
}

/** FIFO-capped per-session poll cursors. */
export class PollCursorMap {
  private readonly items = new Map<string, PollCursor>();
  private readonly cap: number;
  constructor(cap = POLL_CURSOR_CAP) {
    this.cap = cap;
  }

  get(sessionId: string): PollCursor | undefined {
    return this.items.get(sessionId);
  }

  set(sessionId: string, cursor: PollCursor): void {
    if (this.items.has(sessionId)) this.items.delete(sessionId);
    this.items.set(sessionId, cursor);
    while (this.items.size > this.cap) {
      const first = this.items.keys().next().value;
      if (first === undefined) break;
      this.items.delete(first);
    }
  }
}
