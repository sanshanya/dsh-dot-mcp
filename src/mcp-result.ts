/**
 * The MCP result convention: successful calls return one JSON text block, and
 * every failure returns `{ error: { code, message } }` with `isError` — the
 * shape ChatGPT actions branch on. BridgeError codes pass through verbatim;
 * anything else is reported as INTERNAL (with a stack only under
 * DSH_DOT_MCP_DEBUG=1).
 *
 * Failures carry the SAME object twice: once as the JSON text block (the shape
 * every client can read) and once as `structuredContent`. Callers that branch on
 * a machine-readable code were reading a field we never sent, so their connector
 * synthesized one — and a connector-invented `INVALID_ARGUMENT` next to our
 * `WORKSPACE_NOT_FOUND` is a divergence we can prevent by construction. Success
 * results deliberately stay text-only: duplicating a multi-KB payload for zero
 * extra information is exactly the cost this bridge exists to avoid.
 *
 * `BridgeError` is imported from its owner (`goal-native.ts`), not from the
 * facade that re-exports it: going through `bridge.ts` made the error envelope
 * statically depend on every module the facade touches (measured: a 59.7K
 * closure for a 659-token file).
 */
import { BridgeError } from './errors.js';

function textResult(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export interface ErrorPayload {
  error: { code: string; message: string; details?: unknown; retryable: boolean };
  // The SDK types structuredContent as a string-keyed record.
  [key: string]: unknown;
}

/**
 * One object, two representations. `retryable` answers the question a caller
 * actually has — "should I try this again, or fix the input?" — so nobody has to
 * keep a table of our codes on their side.
 */
function errorPayload(error: unknown): ErrorPayload {
  if (error instanceof BridgeError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        ...(error.details === undefined ? {} : { details: error.details }),
        retryable: RETRYABLE_CODES.has(error.code),
      },
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const stack = process.env.DSH_DOT_MCP_DEBUG === '1' && error instanceof Error ? error.stack : undefined;
  return {
    error: { code: 'INTERNAL', message, retryable: false, ...(stack === undefined ? {} : { details: { stack } }) },
  };
}

/**
 * Codes worth retrying unchanged. Everything else is a caller error that will
 * fail the same way twice: an unknown workspace stays unknown, a cancelled
 * session stays cancelled.
 */
const RETRYABLE_CODES = new Set([
  // INTERNAL is deliberately absent: an unexpected fault is not fixed by asking
  // again, and the fallback branch below must agree with this set — two places
  // disagreeing about the same code is the bug this file exists to prevent.
  'SESSION_NOT_LIVE',
  'WORKSPACE_LOCKED',
  'WORKSPACE_REGISTRY_UNAVAILABLE',
  'GOAL_UNAVAILABLE',
  'SESSION_CREATE_FAILED',
  'REVISION_CONFLICT',
  'REQUEST_ID_STALE',
]);

function errorResult(error: unknown): {
  content: { type: 'text'; text: string }[];
  structuredContent: ErrorPayload;
  isError: true;
} {
  const payload = errorPayload(error);
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    isError: true,
  };
}

/** Wrap one async handler into the MCP error convention. */
export function safe<A>(handler: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<{
    content: { type: 'text'; text: string }[];
    structuredContent?: ErrorPayload;
    isError?: true;
  }> => {
    try {
      return textResult(await handler(args));
    } catch (error) {
      return errorResult(error);
    }
  };
}
