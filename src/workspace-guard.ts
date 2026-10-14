/**
 * Workspace Concurrency Guard: single mutable-session lock plus
 * cross-session operation provenance. (0.7.0: drift detection and then the
 * whole baseline-capture pipeline were removed — adversarial audit B#2 —
 * after every captured field proved write-only.)
 */
import { normalizePath } from './paths.js';

export interface WorkspaceLockHolder {
  sessionId: string;
  goalId: string;
  workspacePath: string;
  lockedAt: number;
}

export interface MutationRecord {
  /** callId of the observed mutating call; feeds originating_step. */
  stepId?: string;
  type: string;
  timestamp: number;
}

export class WorkspaceConcurrencyGuard {
  private readonly locks = new Map<string, WorkspaceLockHolder>(); // normalizedPath -> lock
  private readonly sessionLocks = new Map<string, string>(); // sessionId -> normalizedPath
  private readonly mutations = new Map<string, MutationRecord[]>(); // normalizedPath -> mutations

  /**
   * Attempt to acquire an exclusive mutable session lock for a workspace.
   * Read-only sessions do not need to acquire this lock.
   */
  acquireMutableLock(
    workspacePath: string,
    sessionId: string,
    goalId: string,
    isExistingHolderActive = true,
    override = false,
  ): { success: boolean; holder?: WorkspaceLockHolder; warning?: string } {
    const key = normalizePath(workspacePath);
    const existing = this.locks.get(key);

    if (existing !== undefined && existing.sessionId !== sessionId) {
      if (!isExistingHolderActive || override) {
        this.sessionLocks.delete(existing.sessionId);
        this.locks.set(key, { sessionId, goalId, workspacePath: key, lockedAt: Date.now() });
        this.sessionLocks.set(sessionId, key);
        return {
          success: true,
          ...(isExistingHolderActive && override ? {
            warning: `Workspace mutable lock overridden. Previous holder: session ${existing.sessionId}, goal ${existing.goalId}`,
          } : {}),
        };
      }
      return { success: false, holder: existing };
    }

    const holder: WorkspaceLockHolder = {
      sessionId,
      goalId,
      workspacePath: key,
      lockedAt: Date.now(),
    };
    this.locks.set(key, holder);
    this.sessionLocks.set(sessionId, key);
    return { success: true, holder };
  }

  /** Release mutable lock held by a session upon completion or cancellation. */
  releaseLock(sessionId: string): boolean {
    const key = this.sessionLocks.get(sessionId);
    if (key === undefined) return false;
    this.sessionLocks.delete(sessionId);
    const holder = this.locks.get(key);
    if (holder?.sessionId === sessionId) {
      this.locks.delete(key);
      return true;
    }
    return false;
  }

  getLock(workspacePath: string): WorkspaceLockHolder | undefined {
    return this.locks.get(normalizePath(workspacePath));
  }

  /** Record a mutating operation (write, commit, tag, publish) for provenance. */
  recordMutation(workspacePath: string, record: Omit<MutationRecord, 'timestamp'>): void {
    const key = normalizePath(workspacePath);
    const list = this.mutations.get(key) ?? [];
    list.push({ stepId: record.stepId, type: record.type, timestamp: Date.now() });
    if (list.length > 100) list.shift();
    this.mutations.set(key, list);
  }

  getLastMutation(workspacePath: string): MutationRecord | undefined {
    const list = this.mutations.get(normalizePath(workspacePath));
    return list === undefined || list.length === 0 ? undefined : list[list.length - 1];
  }

}
