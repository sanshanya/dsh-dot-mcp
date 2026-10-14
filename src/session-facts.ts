/**
 * Fold a session event log into structured Goal facts.
 * Success is taken from tool/call arguments + tool/result, never from
 * assistant summary text.
 */
import { classifyCommand, type CommandKind } from './command-classify.js';

export type ActionKind = CommandKind;

/** Minimal event shape so this module stays unit-testable without DSH types. */
export interface LooseEvent {
  type: string;
  seq: number;
  time?: number;
  data?: unknown;
}

export interface ToolFact {
  seq: number;
  callId: string;
  name: string;
  kinds: ActionKind[];
  ok: boolean;
  errorCode?: string;
  resultText?: string;
  command?: string;
  filePath?: string;
}

export interface SessionFacts {
  lastSeq?: number;
  todos?: { content: string; status: string }[];
  tools: ToolFact[];
  lastTurnReason?: string;
}

const RESULT_TEXT_CAP = 800;
const COMMAND_KEYS = ['command', 'cmd', 'script', 'command_line'];
const PATH_KEYS = [
  'file_path', 'path', 'filepath', 'target',
  'old_path', 'new_path', 'src', 'dest', 'old_file', 'new_file',
];


function extractFilePath(args: Record<string, unknown>): string | undefined {
  for (const key of PATH_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  return undefined;
}


function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
  }
  return tokens.filter((token) => token !== '');
}

export function parseArgsJson(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    // ignore malformed tool arguments
  }
  return undefined;
}

export function extractCommand(args: Record<string, unknown>): string | undefined {
  for (const key of COMMAND_KEYS) {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value;
  }
  const commands = args.commands;
  if (Array.isArray(commands)) {
    const joined = commands.filter((item): item is string => typeof item === 'string').join('\n');
    if (joined.trim() !== '') return joined;
  }
  return undefined;
}



const WORKTREE_VALUE_OPTS = new Set(['-b', '-B', '--reason', '--track']);

export function parseWorktreeAddPath(command: string): string | undefined {
  const match = command.match(/\bgit\s+worktree\s+add\b([\s\S]*)/i);
  if (match === null) return undefined;
  const tokens = tokenize(match[1] ?? '');
  const positional: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? '';
    if (token.startsWith('-')) {
      const opt = token.split('=')[0] ?? token;
      if (WORKTREE_VALUE_OPTS.has(opt) && !token.includes('=')) i += 1;
      continue;
    }
    positional.push(token);
  }
  return positional[0];
}

export function parseMkdirPaths(command: string): string[] {
  if (!/\bmkdir\b/i.test(command)) return [];
  const match = command.match(/\bmkdir\b([\s\S]*)/i);
  if (match === null) return [];
  const tokens = tokenize(match[1] ?? '');
  return tokens.filter((token) => !token.startsWith('-'));
}

function resultTextOf(data: Record<string, unknown>): string {
  const message = data.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (typeof content === 'string') return content.slice(0, RESULT_TEXT_CAP);
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      parts.push(block);
    } else if (block !== null && typeof block === 'object') {
      const rec = block as Record<string, unknown>;
      if (typeof rec.content === 'string') parts.push(rec.content);
      else if (typeof rec.text === 'string') parts.push(rec.text);
    }
  }
  return parts.join('\n').slice(0, RESULT_TEXT_CAP);
}

function resultIsError(data: Record<string, unknown>): boolean {
  if (data.error !== undefined) return true;
  const message = data.message as { content?: unknown } | undefined;
  const content = message?.content;
  if (Array.isArray(content)) {
    const first = content[0] as { isError?: boolean } | undefined;
    if (first?.isError === true) return true;
  }
  return false;
}

function resultErrorCode(data: Record<string, unknown>): string | undefined {
  const error = data.error as { code?: string } | undefined;
  if (typeof error?.code === 'string' && error.code !== '') return error.code;
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

/** Fold tool/call + tool/result + todo/write + turn/end into facts. */
export function foldSessionFacts(events: readonly LooseEvent[]): SessionFacts {
  const tools: ToolFact[] = [];
  const open = new Map<string, { seq: number; name: string; command?: string; filePath?: string; kinds: ActionKind[] }>();
  let todos: { content: string; status: string }[] | undefined;
  let lastTurnReason: string | undefined;
  let lastSeq: number | undefined;

  for (const event of events) {
    lastSeq = event.seq;
    const data = asRecord(event.data);
    if (event.type === 'todo/write' && data !== undefined) {
      const list = data.todos;
      if (Array.isArray(list)) {
        todos = list
          .map((item) => {
            const rec = asRecord(item);
            if (rec === undefined) return undefined;
            if (typeof rec.content !== 'string') return undefined;
            return { content: rec.content, status: typeof rec.status === 'string' ? rec.status : 'pending' };
          })
          .filter((item): item is { content: string; status: string } => item !== undefined);
      }
    } else if (event.type === 'turn/end' && data !== undefined) {
      const reason = asRecord(data.reason);
      if (typeof reason?.kind === 'string') lastTurnReason = reason.kind;
    } else if (event.type === 'tool/call' && data !== undefined) {
      const callId = typeof data.callId === 'string' ? data.callId : undefined;
      const name = typeof data.name === 'string' ? data.name : 'unknown';
      const rawArgs = typeof data.arguments === 'string' ? data.arguments : '';
      const args = rawArgs === '' ? undefined : parseArgsJson(rawArgs);
      const command = args === undefined ? undefined : extractCommand(args);
      const filePath = args === undefined ? undefined : extractFilePath(args);
      const kinds = command === undefined ? [] : classifyCommand(command);
      if (kinds.length === 0) kinds.push('unknown');
      if (callId !== undefined) {
        open.set(callId, {
          seq: event.seq,
          name,
          ...(command === undefined ? {} : { command }),
          ...(filePath === undefined ? {} : { filePath }),
          kinds,
        });
      }
    } else if (event.type === 'tool/result' && data !== undefined) {
      const message = asRecord(data.message);
      const source = message === undefined ? undefined : asRecord(message.source);
      const callId = typeof source?.callId === 'string' ? source.callId : undefined;
      const opened = callId === undefined ? undefined : open.get(callId);
      if (opened !== undefined && callId !== undefined) {
        open.delete(callId);
        const text = resultTextOf(data);
        const ok = !resultIsError(data);
        const errorCode = resultErrorCode(data);
        tools.push({
          seq: event.seq,
          callId,
          name: opened.name,
          kinds: opened.kinds,
          ok,
          ...(errorCode === undefined ? {} : { errorCode }),
          ...(text === '' ? {} : { resultText: text }),
          ...(opened.command === undefined ? {} : { command: opened.command }),
          ...(opened.filePath === undefined ? {} : { filePath: opened.filePath }),
        });
      }
    }
  }

  return {
    ...(lastSeq === undefined ? {} : { lastSeq }),
    ...(todos === undefined ? {} : { todos }),
    tools,
    ...(lastTurnReason === undefined ? {} : { lastTurnReason }),
  };
}

export function lastEventSeq(events: readonly LooseEvent[]): number | undefined {
  const last = events[events.length - 1];
  return last === undefined ? undefined : last.seq;
}

export function commandForCall(
  events: readonly { type: string; data?: unknown }[] | undefined,
  callId?: string,
): string | undefined {
  if (events === undefined || callId === undefined) return undefined;
  for (const event of events) {
    if (event.type !== 'tool/call') continue;
    const data = event.data as Record<string, unknown> | undefined;
    if (data === undefined || data.callId !== callId) continue;
    const raw = typeof data.arguments === 'string' ? data.arguments : '';
    const args = raw === '' ? undefined : parseArgsJson(raw);
    return args === undefined ? undefined : extractCommand(args);
  }
  return undefined;
}

import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session';
import type {} from '@deepseek-ai/dsh-tool-todo';

/* ── 会话读投影（前 session-view.ts）：turn span / 助手文本/工具调用/
   changedFiles/摘要行——与上方折叠同属"对话读模型"一域 ────────────────── */

/** One turn's span in the log. */
export interface TurnSpan {
  turn: number;
  startSeq: number;
  endSeq: number;
  reason?: TurnEndReason;
}

/** The last turn that ended (or is still open), scanning from the tail. */
export function lastTurnSpan(events: readonly SessionEvent[]): TurnSpan | undefined {
  let open: TurnSpan | undefined;
  let lastEnd: TurnSpan | undefined;
  for (const event of events) {
    if (event.type === 'turn/start') {
      open = { turn: event.data.turn, startSeq: event.seq, endSeq: event.seq };
    } else if (event.type === 'turn/end' && open !== undefined && open.turn === event.data.turn) {
      open = { ...open, endSeq: event.seq, reason: event.data.reason };
      lastEnd = open;
      open = undefined;
    }
  }
    // An open turn is the most recent activity and must win: a consumer
  // polling a running task needs the in-flight turn, not the last completed
  // one. Only when no turn is open does the last ended turn count.
  return open ?? lastEnd;
}

/** Concatenated text content of assistant messages inside one turn. */
export function assistantTextForTurn(events: readonly SessionEvent[], turn: number): string {
  const parts: string[] = [];
  for (const event of events) {
    if (event.type !== 'assistant/message' || event.data.turn !== turn) continue;
    const text = event.data.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
    if (text !== '') parts.push(text);
  }
  return parts.join('\n');
}

/** One model-requested tool invocation inside a turn, paired with its result. */
export interface ToolCallInfo {
  callId: string;
  name: string;
  /** Raw arguments JSON exactly as the model produced it. */
  arguments: string;
  isError?: boolean;
  error?: { name: string; code: string };
}

/** Tool calls of one turn in call order, paired with their results. */
export function toolCallsForTurn(events: readonly SessionEvent[], turn: number, maxItems: number): ToolCallInfo[] {
  const calls = new Map<string, ToolCallInfo>();
  const order: string[] = [];
  for (const event of events) {
    if (event.data === undefined) continue;
    const data = event.data as Record<string, unknown>;
    if (event.type === 'tool/call' && data.turn === turn) {
      const callId = data.callId as string;
      calls.set(callId, { callId, name: data.name as string, arguments: data.arguments as string });
      order.push(callId);
    } else if (event.type === 'tool/result' && data.turn === turn) {
      const callId = (data.message as { source?: { callId?: string } })?.source?.callId as string | undefined;
      if (callId !== undefined) {
        const call = calls.get(callId);
        if (call !== undefined) {
          call.isError = (data.message as { content?: { isError?: boolean }[] })?.content?.[0]?.isError ?? false;
          if (data.error !== undefined) call.error = data.error as { name: string; code: string };
        }
      }
    }
  }
  return order.slice(-maxItems).map((callId) => calls.get(callId) as ToolCallInfo);
}

/** Tool names whose arguments carry a file path and that mutate files. */
const EDIT_TOOL_NAMES = new Set([
  'write', 'edit', 'str_replace', 'insert', 'replace', 'apply_patch', 'str-replace-editor',
  'rename', 'move', 'delete', 'rm', 'cp', 'mv',
]);
const PATH_ARG_KEYS = ['file_path', 'path', 'filepath', 'old_path', 'new_path', 'src', 'dest', 'old_file', 'new_file'];

/**
 * Files edit tools named, in first-seen order (data-driven from the log).
 * turn undefined = the whole log; otherwise only that turn (audit B#3: this
 * is the single owner for both changed_files wire fields).
 */
export function collectChangedFiles(events: readonly LooseEvent[], turn?: number): string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const event of events) {
    if (event.type !== 'tool/call') continue;
    const data = event.data as { turn?: unknown; name?: unknown; arguments?: unknown } | undefined;
    if (turn !== undefined && data?.turn !== turn) continue;
    if (data === undefined || typeof data.name !== 'string' || !EDIT_TOOL_NAMES.has(data.name)) continue;
    if (typeof data.arguments !== 'string') continue;
    let args: unknown;
    try {
      args = JSON.parse(data.arguments);
    } catch {
      continue;
    }
    if (args === null || typeof args !== 'object') continue;
    for (const key of PATH_ARG_KEYS) {
      const value = (args as Record<string, unknown>)[key];
      if (typeof value === 'string' && value !== '' && !seen.has(value)) {
        seen.add(value);
        paths.push(value);
      }
    }
  }
  return paths;
}

/** One summarized message row for dsh_get_session. */
export interface MessageRow {
  seq: number;
  time: string;
  role: 'user' | 'assistant';
  text: string;
}

function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '…[truncated]';
}

/** Recent user/assistant message rows, newest first, bounded by item/char budgets. */
export function summarizeMessages(
  events: readonly SessionEvent[],
  maxItems: number,
  maxChars: number,
): MessageRow[] {
  const rows: MessageRow[] = [];
  for (const event of events) {
    if (event.type === 'user/message') {
      const text = event.data.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (text !== '') rows.push({ seq: event.seq, time: new Date(event.time).toISOString(), role: 'user', text: truncate(text, maxChars) });
    } else if (event.type === 'assistant/message') {
      const text = event.data.message.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      if (text !== '') rows.push({ seq: event.seq, time: new Date(event.time).toISOString(), role: 'assistant', text: truncate(text, maxChars) });
    }
  }
  return rows.slice(-maxItems).reverse();
}

/** Last event timestamp (ms) or undefined for an empty log. */
export function lastEventTime(events: readonly SessionEvent[]): string | undefined {
  const last = events[events.length - 1];
  return last === undefined ? undefined : new Date(last.time).toISOString();
}
