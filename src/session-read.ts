/**
 * The read plane: turning a session header or a loaded view into the wire rows
 * `dsh_list_sessions` / `dsh_get_session` / `dsh_get_result` return.
 *
 * Everything here is a pure projection given its inputs — the two host seams it
 * reads (the session-title service and the projection cache) arrive as
 * arguments, so a fixture can drive every branch without a host. The cache path
 * is the zero-I/O one: a cold list row gets its title from the persisted
 * projection checkpoint instead of opening the session log.
 */
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Session, SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session';
import { foldSessionTitle } from '@deepseek-ai/dsh-session-title';
import { deriveStatus, foldPendingMessages, type BridgeStatus, type PendingFold } from './status.js';

/**
 * One loaded session: the live agent when attached, else the persisted log.
 * Owned here because both the facade and the wait plane read it.
 */
export interface LoadedView {
  agent?: Agent;
  session?: Session;
  events: readonly SessionEvent[];
  header: SessionHeader;
}

/** One list row: the shape `dsh_list_sessions` returns. */
export interface SessionSummary {
  session_id: string;
  title?: string;
  workspace?: string;
  /** Explicitly 'unknown' when nothing can derive it — never silently absent (E02). */
  status: BridgeStatus | 'unknown';
  created_at: string;
  /** Explicitly null when no timestamp source exists (E02). */
  updated_at: string | null;
  /** True when an in-process agent is attached to this session. */
  live: boolean;
}

/** The `inbox` slice of a live agent the read plane counts. */
export interface RowAgent {
  status: 'idle' | 'running';
  inbox: { nextTurn: readonly unknown[]; nextStep: readonly unknown[] };
}

/** The `ctx.sessionTitle` slice used to read a live session's title. */
export interface TitleSource {
  get(session: Session): { readonly title: string } | undefined;
}

/**
 * The `ctx.sessionProjectionCache` slice used for a cold row. `keys` asks the
 * host for exactly the title row instead of viewing every projection.
 */
export interface TitleCache {
  cachedSnapshot(
    header: SessionHeader,
    keys?: readonly string[],
  ): { readonly values?: { readonly title?: string | null } } | undefined;
}

/** ISO timestamp for the wire. */
export function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Bounded text for the wire; the marker is part of the contract drivers see. */
export function truncate(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + '…[truncated]';
}

/**
 * Pending-message counts for a session: the live agent's inbox when attached,
 * else the durable splice events (a cold session's Inbox is not replayed).
 */
export function pendingOf(agent: RowAgent | undefined, events: readonly SessionEvent[]): PendingFold {
  if (agent === undefined) return foldPendingMessages(events);
  return { nextTurn: agent.inbox.nextTurn.length, nextStep: agent.inbox.nextStep.length };
}

/** Derive one row's status: parked asks first, then the live agent, then the log. */
export function deriveRowStatus(input: {
  agent?: RowAgent | undefined;
  events: readonly SessionEvent[];
  pendingApprovals: number;
  pendingQuestions: number;
}): BridgeStatus {
  const pending = pendingOf(input.agent, input.events);
  return deriveStatus({
    live: input.agent !== undefined,
    ...(input.agent === undefined ? {} : { agentStatus: input.agent.status }),
    hasPendingInbox: pending.nextTurn + pending.nextStep > 0,
    pendingApprovals: input.pendingApprovals,
    pendingQuestions: input.pendingQuestions,
    events: input.events,
  });
}

/**
 * A session's title: the title service folds a live session's own snapshot,
 * while a cold session has only its persisted log to fold. Both are wrapped:
 * a title is a display detail and must never fail a read.
 */
export function titleOf(
  view: { session?: Session | undefined; events: readonly SessionEvent[] },
  titles: TitleSource | undefined,
): string | undefined {
  if (view.session !== undefined) {
    try {
      return titles?.get(view.session)?.title;
    } catch {
      return undefined;
    }
  }
  try {
    return foldSessionTitle(view.events)?.title;
  } catch {
    return undefined;
  }
}

/**
 * Zero-I/O title for a cold session. The host's title projection is a plain
 * `string | null` (0.2.1-rc.2 `titleProjectionDefinition`), and a cache that is
 * absent, lagging, or throwing means "no hint" — never a failed list.
 */
export function cachedTitle(cache: TitleCache | undefined, header: SessionHeader): string | undefined {
  if (cache === undefined) return undefined;
  try {
    const value = cache.cachedSnapshot(header, ['title'])?.values?.title;
    return typeof value === 'string' && value !== '' ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Assemble one list row. Fields are ALWAYS present: unknown beats absent — a
 * missing status must never be misread as "idle" or "succeeded" by drivers
 * that test for key presence (E02).
 */
export function sessionSummary(input: {
  header: SessionHeader;
  title?: string | undefined;
  status?: BridgeStatus | undefined;
  updatedAt?: string | undefined;
  live?: boolean;
}): SessionSummary {
  return {
    session_id: input.header.id,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.header.cwd === undefined ? {} : { workspace: input.header.cwd }),
    status: input.status ?? 'unknown',
    created_at: iso(input.header.createdAt),
    updated_at: input.updatedAt ?? null,
    live: input.live === true,
  };
}