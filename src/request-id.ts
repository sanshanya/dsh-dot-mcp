/**
 * Cross-call request_id dedup for idempotent connector retries. Bounded,
 * process-restorable through a JSON file when cfg.dshHome is set; loss of
 * the file degrades the bridge to in-process dedup (native goal operations
 * are themselves idempotent by revision CAS, so this layer is a comfort,
 * not a correctness mechanism).
 */

const REQUEST_ID_CAP = 256;

/** One resolved request_id replay record. */
export interface RequestRecord {
  sessionId: string;
  fingerprint: string;
}

/** Bounded FIFO map of request_id → resolution. */
export class RequestIdMap {
  private readonly records = new Map<string, RequestRecord>();

  size(): number {
    return this.records.size;
  }

  get(id: string): RequestRecord | undefined {
    return this.records.get(id);
  }

  set(id: string, record: RequestRecord): void {
    if (this.records.has(id)) this.records.delete(id);
    this.records.set(id, record);
    while (this.records.size > REQUEST_ID_CAP) {
      const oldest = this.records.keys().next().value;
      if (oldest === undefined) break;
      this.records.delete(oldest);
    }
  }

  entries(): [string, RequestRecord][] {
    return [...this.records.entries()];
  }

  restore(rows: readonly [string, RequestRecord][]): void {
    for (const [id, record] of rows) this.set(id, record);
  }
}

/** Stable fingerprint of a replay-able call's semantic payload. */
export function fingerprintRequest(input: Record<string, unknown>): string {
  const canonical: Record<string, unknown> = {};
  for (const key of Object.keys(input).sort()) {
    const value = input[key];
    if (value === undefined) continue;
    canonical[key] = value;
  }
  return JSON.stringify(canonical);
}
