/**
 * Completed request records plus process-local in-flight coalescing. A key is
 * reserved before any async work starts, so overlapping retries cannot enqueue
 * the operation twice. Completed goal records are restored by the facade.
 */
import { BridgeError } from './errors.js';

const REQUEST_ID_CAP = 256;

/** One resolved request_id replay record. */
export interface RequestRecord {
  sessionId: string;
  fingerprint: string;
  /** Identifies the accepted goal generation; old sidecar rows may omit it. */
  goalId?: string;
}

/** In-flight keys are never evicted while their operation is pending. */
export class RequestFlights<T> {
  private readonly pending = new Map<string, { fingerprint: string; promise: Promise<T> }>();

  run(
    requestId: string | undefined,
    fingerprint: string,
    operation: () => Promise<T>,
  ): Promise<{ value: T; shared: boolean }> {
    if (requestId === undefined || requestId === '') {
      return operation().then((value) => ({ value, shared: false }));
    }
    const existing = this.pending.get(requestId);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(new BridgeError('REQUEST_ID_CONFLICT',
          `request_id "${requestId}" is already in flight with different arguments`));
      }
      return existing.promise.then((value) => ({ value, shared: true }));
    }
    // Deferring invocation reserves the key synchronously, even when the
    // operation itself immediately reaches an await or throws.
    const promise = Promise.resolve().then(operation).finally(() => {
      if (this.pending.get(requestId)?.promise === promise) this.pending.delete(requestId);
    });
    this.pending.set(requestId, { fingerprint, promise });
    return promise.then((value) => ({ value, shared: false }));
  }
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
