/**
 * File-backed persistence for the goal request_id map.
 *
 * request_id dedup is process-local unless a dshHome is configured; with one,
 * the map is persisted so a connector retry after a bridge restart is still
 * recognised as a replay instead of starting the work a second time.
 *
 * The store owns the fs shape (JSON document, atomic tmp+rename, 0600) and
 * nothing else: the map itself lives with its owner (Bridge).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RequestRecord } from './request-id.js';

export class RequestIdStore {
  private readonly file: string | undefined;
  private readonly warn: (message: string) => void;

  constructor(dshHome: string | undefined, warn: (message: string) => void) {
    this.file = dshHome === undefined || dshHome === '' ? undefined : join(dshHome, 'goal-requests.json');
    this.warn = warn;
  }

  /** Rows to restore at boot; a missing or malformed file must never block startup. */
  load(): [string, RequestRecord][] {
    if (this.file === undefined) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { records?: unknown };
      if (!Array.isArray(parsed.records)) return [];
      return parsed.records.filter(
        (row): row is [string, RequestRecord] => Array.isArray(row)
          && typeof row[0] === 'string'
          && row[1] !== null
          && typeof row[1] === 'object'
          && typeof (row[1] as { sessionId?: unknown }).sessionId === 'string'
          && typeof (row[1] as { fingerprint?: unknown }).fingerprint === 'string'
          && ((row[1] as { goalId?: unknown }).goalId === undefined
            || typeof (row[1] as { goalId?: unknown }).goalId === 'string'),
      );
    } catch {
      return [];
    }
  }

  /** Persist the full current map; best-effort — dedup still works in-process. */
  save(entries: [string, RequestRecord][]): void {
    if (this.file === undefined) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, records: entries }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      this.warn(`could not persist request_id state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
