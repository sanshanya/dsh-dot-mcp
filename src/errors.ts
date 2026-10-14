/**
 * The wire error vocabulary: one class and the stable codes every tool can
 * return. This is a leaf — it imports nothing, so any module may raise a
 * coded failure without depending on the facade, the goal mapping, or the
 * relay. Before this module existed the class lived in `goal-native.ts` only
 * because that file must not import `bridge.ts`, which made the result
 * envelope and the relay statically depend on the *goal* module for an error
 * they raise about sessions, approvals and questions.
 *
 * Codes are part of the wire contract: the real-boundary lanes assert them by
 * name, and `ARCHITECTURE.md` lists the full set.
 */

/** One coded bridge failure. `code` is stable on the wire; `details` is optional context. */
export class BridgeError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'BridgeError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** A host-goal failure translated for the wire: same identity, distinct name for logs. */
export class GoalNativeError extends BridgeError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, details);
    this.name = 'GoalNativeError';
  }
}