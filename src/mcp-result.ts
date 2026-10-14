/**
 * The MCP result convention: successful calls return one JSON text block, and
 * every failure returns `{ error: { code, message } }` with `isError` — the
 * shape ChatGPT actions branch on. BridgeError codes pass through verbatim;
 * anything else is reported as INTERNAL (with a stack only under
 * DSH_DOT_MCP_DEBUG=1).
 *
 * Outputs are NOT secret-scrubbed: 0.7.0 removed the heuristic redactor as a
 * screen door, so the wire is a trusted-channel decision rather than a
 * sanitization layer.
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

function errorResult(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  if (error instanceof BridgeError) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: { code: error.code, message: error.message, ...(error.details === undefined ? {} : { details: error.details }) } }, null, 2) }],
      isError: true,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const stack = process.env.DSH_DOT_MCP_DEBUG === '1' && error instanceof Error ? error.stack : undefined;
  return {
    content: [{ type: 'text', text: JSON.stringify(stack ? { error: { code: 'INTERNAL', message, stack } } : { error: { code: 'INTERNAL', message } }, null, 2) }],
    isError: true,
  };
}

/** Wrap one async handler into the MCP error convention. */
export function safe<A>(handler: (args: A) => Promise<unknown>) {
  return async (args: A): Promise<{ content: { type: 'text'; text: string }[]; isError?: true }> => {
    try {
      return textResult(await handler(args));
    } catch (error) {
      return errorResult(error);
    }
  };
}
