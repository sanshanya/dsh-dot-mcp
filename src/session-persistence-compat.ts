import type { SessionEvent, SessionHeader, SessionId } from '@deepseek-ai/dsh-session';

/**
 * Narrow adapter for the pinned host (dsh-* @ 0.2.0-rc.2): the persistence
 * service offers open()/close() only (no legacy inspect), read() always
 * returns the metadata envelope, and Session state is read through
 * snapshotEvents(). Legacy fallbacks were removed when peerDeps pinned this
 * exact version.
 */

/** One open channel onto a stored session (host shape, pinned version). */
type ReadHandle = {
  header: SessionHeader;
  read(): Promise<{ readonly events: readonly SessionEvent[] }>;
  close(): Promise<void>;
};

type Inspection = { meta: SessionHeader; events: readonly SessionEvent[] };

/** Read a persisted session's header plus full validated event log. */
export async function inspectPersistedSession(persistence: {
  open(id: SessionId, access: 'read'): Promise<ReadHandle>;
}, id: SessionId): Promise<Inspection> {
  const handle = await persistence.open(id, 'read');
  try {
    const result = await handle.read();
    // Never hand the ownership envelope to consumers expecting an event log,
    // and never acquire a writer here.
    return { meta: handle.header, events: result.events };
  } finally {
    await handle.close();
  }
}

/** Unwrap a list() snapshot — the pinned host always carries `header` (audit D8: the bare-header branch was dead compat). */
export function persistedHeader(row: { readonly header: SessionHeader }): SessionHeader {
  return row.header;
}

/** Snapshot the live session's event log (pinned Session API). */
export function sessionEvents(session: {
  snapshotEvents(): readonly SessionEvent[];
}): readonly SessionEvent[] {
  return session.snapshotEvents();
}
