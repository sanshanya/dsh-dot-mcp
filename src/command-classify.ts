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

const SHELL_CONTROL = /(?:&&|\|\||[;&|<>`\r\n]|\$(?:\(|\{|[A-Za-z_0-9@*?#$!-])|%[^%\r\n]+%|![^!\r\n]+!)/;
const NON_EXECUTING_LONG_OPTION = /^(?:--dry-run|--help|--version|--listTests|--showConfig)$/i;
const TEST_COMMAND = /^(?:npm(?:\.cmd)?\s+(?:test|run\s+test)|pnpm(?:\.cmd)?\s+(?:test|run\s+test)|yarn(?:\.cmd)?\s+(?:test|run\s+test)|node(?:\.exe)?\s+--test|(?:npx(?:\.cmd)?\s+)?(?:jest|vitest|mocha)(?:\.cmd)?)(?:\s+.*)?$/i;
const BUILD_COMMAND = /^(?:npm(?:\.cmd)?\s+run\s+build|pnpm(?:\.cmd)?\s+(?:build|run\s+build)|yarn(?:\.cmd)?\s+(?:build|run\s+build)|(?:npx(?:\.cmd)?\s+)?(?:tsc|esbuild|webpack)(?:\.cmd)?|(?:npx(?:\.cmd)?\s+)?vite(?:\.cmd)?\s+build)(?:\s+.*)?$/i;

interface CommandOptions {
  start: number;
  shortProbes: string;
  shortValues: string;
  longValues: readonly string[];
  /** npm-style script runners forward the first -- to the invoked script. */
  forwardsOptions?: boolean;
}

const NPM_VALUE_OPTIONS = [
  '--registry', '--tag', '--access', '--otp', '--workspace', '--prefix',
  '--userconfig', '--globalconfig', '--cache', '--provenance-file',
];
const RUNNER_OPTIONS: Readonly<Record<string, { shortValues: string; longValues: readonly string[] }>> = {
  node: { shortValues: '', longValues: ['--test-name-pattern', '--test-skip-pattern',
    '--test-reporter', '--test-reporter-destination'] },
  jest: { shortValues: 'ct', longValues: ['--config', '--testNamePattern', '--testPathPattern',
    '--testPathPatterns', '--outputFile', '--reporters'] },
  vitest: { shortValues: 'ct', longValues: ['--config', '--testNamePattern', '--reporter', '--outputFile'] },
  mocha: { shortValues: 'gfrt', longValues: ['--config', '--grep', '--fgrep', '--reporter', '--require', '--timeout'] },
  tsc: { shortValues: 'pt', longValues: ['--project', '--target', '--outDir'] },
  esbuild: { shortValues: '', longValues: [] }, // esbuild value options use --key=value.
  webpack: { shortValues: 'c', longValues: ['--config', '--output-path', '--mode', '--env'] },
  vite: { shortValues: 'c', longValues: ['--config', '--base', '--mode', '--outDir'] },
};
const SCRIPT_VALUE_OPTIONS = [...new Set(Object.values(RUNNER_OPTIONS).flatMap(options => options.longValues))];

/** Option arity and short aliases belong to the invoked command, not a substring bank. */
function commandOptions(tokens: readonly string[]): CommandOptions | undefined {
  const executable = tokens[0];
  if (executable === 'git') {
    const verb = tokens[1];
    if (verb === 'push') {
      return { start: 2, shortProbes: 'nh', shortValues: 'o',
        longValues: ['--repo', '--receive-pack', '--exec', '--push-option'] };
    }
    if (verb === 'commit') {
      return { start: 2, shortProbes: 'h', shortValues: 'mFcCt',
        longValues: ['--message', '--file', '--reuse-message', '--reedit-message', '--fixup',
          '--squash', '--author', '--date', '--template', '--cleanup', '--trailer', '--pathspec-from-file'] };
    }
    if (verb === 'tag') {
      return { start: 2, shortProbes: 'nh', shortValues: 'mFu',
        longValues: ['--message', '--file', '--local-user', '--format'] };
    }
    // ls-remote -h means --heads, not help.
    return { start: 2, shortProbes: verb === 'ls-remote' ? '' : 'h', shortValues: '', longValues: [] };
  }
  if (executable === 'gh' && tokens[1] === 'release') {
    // In gh release create, -n supplies notes; it is not a dry-run alias.
    return { start: 3, shortProbes: 'h', shortValues: 'ntFRq',
      longValues: ['--notes', '--notes-file', '--title', '--target', '--repo', '--discussion-category',
        '--notes-start-tag', '--json', '--jq', '--template'] };
  }
  if (executable === 'npm' || executable === 'pnpm' || executable === 'yarn') {
    const start = tokens[1] === 'run' ? 3 : 2;
    const script = tokens[start - 1];
    const forwardsOptions = script === 'test' || script === 'build';
    return { start, shortProbes: 'h', shortValues: 'wC', forwardsOptions,
      longValues: forwardsOptions ? [...NPM_VALUE_OPTIONS, ...SCRIPT_VALUE_OPTIONS] : NPM_VALUE_OPTIONS };
  }
  const runner = (executable === 'npx' ? tokens[1] : executable)?.replace(/\.(?:cmd|exe)$/i, '').toLowerCase();
  if (runner === undefined || !Object.hasOwn(RUNNER_OPTIONS, runner)) return undefined;
  return { start: executable === 'npx' ? 2 : 1, shortProbes: 'h', ...RUNNER_OPTIONS[runner] };
}

function hasNonExecutingOption(tokens: readonly string[]): boolean {
  const options = commandOptions(tokens);
  if (options === undefined) return false;
  let forwardsOptions = options.forwardsOptions === true;
  for (let index = options.start; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '--') {
      if (forwardsOptions) { forwardsOptions = false; continue; }
      break;
    }
    if (token.startsWith('--')) {
      const option = token.split('=')[0] ?? token;
      if (NON_EXECUTING_LONG_OPTION.test(option)) return true;
      if (options.longValues.includes(option) && !token.includes('=')) {
        if (++index >= tokens.length) return true;
      }
    } else if (token.startsWith('-')) {
      // Consume short clusters in order: -qnoVALUE is dry-run, -qon is a
      // push-option value. Values and operands after -- are never flags.
      for (let offset = 1; offset < token.length; offset += 1) {
        const option = token[offset] ?? '';
        if (options.shortProbes.includes(option)) return true;
        if (options.shortValues.includes(option)) {
          if (offset === token.length - 1 && ++index >= tokens.length) return true;
          break;
        }
      }
    }
  }
  return false;
}

/**
 * A conservative tokenization seam for evidence, NOT a shell interpreter.
 * Unsupported quoting, interpolation, compound shells and non-executing probes
 * have no evidence kind. Display classification deliberately stays permissive.
 */
export function completeCommandTokens(command: string): string[] | undefined {
  const trimmed = command.trim();
  if (trimmed === '' || hasShellControlOperator(trimmed)) return undefined;
  const tokens: string[] = [];
  let remaining = trimmed;
  while (remaining !== '') {
    const match = /^(?:"([^"]*)"|'([^']*)'|([^\s"'\\]+))(?:\s+|$)/.exec(remaining);
    if (match === null) return undefined;
    tokens.push(match[1] ?? match[2] ?? match[3] ?? '');
    remaining = remaining.slice(match[0].length);
  }
  // Canonicalize Windows executable suffixes, without changing arguments.
  tokens[0] = (tokens[0] ?? '').replace(/\.(?:cmd|exe)$/i, '').toLowerCase();
  if (hasNonExecutingOption(tokens)) return undefined;
  return tokens;
}

function isCompleteKnownCommand(command: string, pattern: RegExp): boolean {
  return completeCommandTokens(command) !== undefined && pattern.test(command.trim());
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
  if (cmd.trim() === '') {
    if (toolName === 'npm.publish') return 'npm_publish';
    if (toolName === 'github.release') return 'github_release';
    return undefined;
  }
  const tokens = completeCommandTokens(cmd);
  if (tokens === undefined) return undefined;
  if (tokens[0] === 'npm' && tokens[1] === 'publish') return 'npm_publish';
  if (tokens[0] === 'gh' && tokens[1] === 'release' && tokens[2] === 'create') return 'github_release';
  if (tokens[0] === 'git' && tokens[1] === 'push') return 'git_push';
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
    || /\bgit\s+push\b[^\n]*(?:\s--tags\b|\b(?:refs\/tags\/|v\d))/i.test(command);
  if (tagCreate || tagPush) kinds.push('git_tag');
  const commitPush = /\bgit\s+push\b/i.test(command) && !tagPush;
  if (commitPush) kinds.push('git_push');
  return kinds;
}
