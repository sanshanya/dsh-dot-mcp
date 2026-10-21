/**
 * File-backed delivery receipts for `dsh_send_message` request ids.
 *
 * The in-process RequestIdMap alone forgets everything at restart, so a
 * connector whose response was lost cannot tell "never arrived" from "accepted
 * before the crash". This store keeps the accepted receipts (never payloads) on
 * the same discipline as goal-requests.json: FIFO ≤256 rows, ≤64KB, atomic
 * tmp+rename at 0600, restore-tolerates-malformed. Searching is honest: an id
 * outside the retention window is reported as such, not as "not found".
 */
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const RECEIPT_CAP = 256;
const RECEIPT_BYTES = 65536;

/** One accepted message receipt; the payload itself is never persisted. */
export interface MessageReceipt {
  request_id: string;
  session_id: string;
  /** Fingerprint of the accepted payload (session/message/mode), never the payload. */
  payload_hash: string;
  mode: 'queue' | 'steer' | 'interrupt';
  accepted_at: string;
}

export class MessageReceiptStore {
  private readonly file: string | undefined;
  private readonly warn: (message: string) => void;

  constructor(dshHome: string | undefined, warn: (message: string) => void) {
    this.file = dshHome === undefined || dshHome === '' ? undefined : join(dshHome, 'message-receipts.json');
    this.warn = warn;
  }

  /** Rows to restore at boot; a missing or malformed file must never block startup. */
  load(): MessageReceipt[] {
    if (this.file === undefined) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as { receipts?: unknown };
      if (!Array.isArray(parsed.receipts)) return [];
      return parsed.receipts.filter(
        (row): row is MessageReceipt => row !== null
          && typeof row === 'object'
          && typeof (row as { request_id?: unknown }).request_id === 'string'
          && typeof (row as { session_id?: unknown }).session_id === 'string'
          && typeof (row as { payload_hash?: unknown }).payload_hash === 'string'
          && typeof (row as { mode?: unknown }).mode === 'string'
          && typeof (row as { accepted_at?: unknown }).accepted_at === 'string',
      );
    } catch {
      return [];
    }
  }

  /** Persist the full receipt set; best-effort — dedup still works in-process. */
  save(receipts: readonly MessageReceipt[]): void {
    if (this.file === undefined) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      // FIFO within a byte ceiling: keep the newest rows that fit.
      let kept = [...receipts].slice(-RECEIPT_CAP);
      while (kept.length > 0 && JSON.stringify(kept).length > RECEIPT_BYTES) kept = kept.slice(1);
      const tmp = `${this.file}.tmp`;
      writeFileSync(tmp, JSON.stringify({ version: 1, receipts: kept }), { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch (error) {
      this.warn(`could not persist message receipts: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** True when the store file exists (used only by tests to prove a write landed). */
  persisted(): boolean {
    if (this.file === undefined) return false;
    try { return statSync(this.file).isFile(); } catch { return false; }
  }
}
