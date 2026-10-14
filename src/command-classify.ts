/**
 * Shell command classification helpers — the single home for "what kinds of
 * command is this?" (adversarial audit B#1; the previously duplicated
 * substring bank in session-facts merged here 0.7.0).
 *
 * Two projections exist ON PURPOSE:
 * - classifyCommand: substring semantics ("the command mentions a
 *   git push") — for display/summary naming only.
 * - idempotencyKindFor: anchored complete-command semantics ("the WHOLE
 *   payload is one clean verifiable command") — gates evidence ids and
 *   names mutation-ledger records. Compound shells never classify.
 * They must NEVER disagree on the existence of a verb; add a new verb here
 * exactly once and pick the strictness per projection.
 */

const SHELL_CONTROL = /(?:&&|\|\||[;&|<>`\r\n]|\$\(|%[^%\r\n]+%|![^!\r\n]+!)/;
const TEST_COMMAND = /^(?:npm(?:\.cmd)?\s+(?:test|run\s+test)|pnpm(?:\.cmd)?\s+(?:test|run\s+test)|yarn(?:\.cmd)?\s+(?:test|run\s+test)|node(?:\.exe)?\s+--test|(?:npx(?:\.cmd)?\s+)?(?:jest|vitest|mocha)(?:\.cmd)?)(?:\s+.*)?$/i;
const BUILD_COMMAND = /^(?:npm(?:\.cmd)?\s+run\s+build|pnpm(?:\.cmd)?\s+(?:build|run\s+build)|yarn(?:\.cmd)?\s+(?:build|run\s+build)|(?:npx(?:\.cmd)?\s+)?(?:tsc|esbuild|webpack)(?:\.cmd)?|(?:npx(?:\.cmd)?\s+)?vite(?:\.cmd)?\s+build)(?:\s+.*)?$/i;

function isCompleteKnownCommand(command: string, pattern: RegExp): boolean {
  const trimmed = command.trim();
  return trimmed !== '' && !hasShellControlOperator(trimmed) && pattern.test(trimmed);
}

/** True when the shell payload contains chaining/interpolation operators. */
export function hasShellControlOperator(command: string): boolean {
  return SHELL_CONTROL.test(command);
}

/** True only when the complete shell payload is one recognized test command. */
export function isCompleteTestCommand(command: string): boolean {
  return isCompleteKnownCommand(command, TEST_COMMAND);
}

/** True only when the complete shell payload is one recognized build command. */
export function isCompleteBuildCommand(command: string): boolean {
  return isCompleteKnownCommand(command, BUILD_COMMAND);
}

/**
 * High-cost / side-effecting step kind, or undefined when the call is not
 * one clean recognizable command (compound shells never classify). Used to
 * name mutation-ledger records and derive evidence ids — the removed
 * execution-idempotency ledger used it as cache key.
 */
export function idempotencyKindFor(toolName: string, command?: string): string | undefined {
  const cmd = command ?? '';
  if (hasShellControlOperator(cmd)) return undefined;
  if (/\bnpm\s+publish\b/i.test(cmd) || toolName === 'npm.publish') return 'npm_publish';
  if (/\bgh\s+release\b/i.test(cmd) || toolName === 'github.release') return 'github_release';
  if (/\bgit\s+push\b/i.test(cmd)) return 'git_push';
  if (isCompleteTestCommand(cmd)) return 'test';
  if (isCompleteBuildCommand(cmd)) return 'build';
  return undefined;
}

// ── Display naming projection (substring semantics) ─────────────────────────

/** Canonical verb kinds a command can exhibit (display naming domain). */
export type CommandKind =
  | 'git_push'
  | 'git_tag'
  | 'npm_publish'
  | 'github_release'
  | 'git_worktree_add'
  | 'npm_pack'
  | 'unknown';

/** Every recognized verb kind mentioned ANYWHERE in the payload. */
export function classifyCommand(command: string): CommandKind[] {
  const kinds: CommandKind[] = [];
  if (/\bgit\s+worktree\s+add\b/i.test(command)) kinds.push('git_worktree_add');
  if (/\bnpm\s+publish\b/i.test(command)) kinds.push('npm_publish');
  if (/\bnpm\s+pack\b/i.test(command)) kinds.push('npm_pack');
  if (/\bgh\s+release\b/i.test(command)) kinds.push('github_release');
  const tagCreate = /\bgit\s+tag\b/i.test(command);
  const tagPush = /\bgit\s+push\s+--tags\b/i.test(command)
    || /\bgit\s+push\b[^\n]*\b(--tags|refs\/tags\/|v\d)/i.test(command);
  if (tagCreate || tagPush) kinds.push('git_tag');
  const commitPush = /\bgit\s+push\b/i.test(command) && !tagPush;
  if (commitPush) kinds.push('git_push');
  return kinds;
}
