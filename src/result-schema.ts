/**
 * Standardized Result Schema: summaries of the current goal generation (or last turn)
 * (tests, commits, tags, artifacts, evidence) without parsing giant assistant
 * texts. Credential availability lives next door in credentials.ts and reaches
 * this module only as `credentialRefs` input.
 */
import { isTerminalStatus } from './status.js';
import { completeCommandTokens, isCompleteTestCommand } from './command-classify.js';
import type { NativeGoalWire } from './goal-native.js';
import type { BridgeStatus } from './status.js';
import { collectChangedFiles, extractCommand, foldSessionFacts, parseArgsJson, type LooseEvent, type ToolFact } from './session-facts.js';
import { selectResultEvents } from './result-scope.js';
import { cleanToolOutput, executionDirectory, extractRemoteEvidence, jsonResult, type RemoteEvidence } from './result-remote.js';

type TestCount = 'total' | 'pass' | 'fail' | 'skip';

export interface ResultSchema {
  status: BridgeStatus;
  goal: {
    goal_id: string;
    revision: number;
    phase?: string;
    objective?: string;
    max_goal_rounds?: number;
    rounds_started?: number;
    workspace: string;
    started_at?: string;
    finished_at?: string;
  };
  tests: {
    total: number;
    pass: number;
    fail: number;
    skip: number;
    /** Numeric fields stay compatible; zero is a placeholder for listed unknowns. */
    counts_known?: boolean;
    unknown_counts?: TestCount[];
    suites: string[];
    evidence_ids: string[];
  };
  changes: {
    changed_files: string[];
    commits: string[];
    tags: string[];
    working_tree?: string;
  };
  artifacts: Array<{
    path: string;
    name?: string;
    hash?: string;
    size?: number;
  }>;
  remote: RemoteEvidence;
  security: {
    credential_refs: string[];
    approval_summary?: Record<string, unknown>;
  };
  warnings: string[];
  provenance: {
    session_id: string;
    goal_id: string;
    originating_step?: string;
  };
}

const TEST_COUNTS: TestCount[] = ['total', 'pass', 'fail', 'skip'];
const COMMIT_BRACKET = /\[(?:[^\]]+?\s)?([0-9a-f]{7,40})\]/i;
const COMMIT_WORD = /\bcommit\s+([0-9a-f]{7,40})\b/i;
const TAG_CREATED = /\b(?:created tag|tag)\s+['"]?([vV]?\d[\w.+-]*)['"]?/i;
const ARTIFACT_FILE = /([^\s"'\\]+\.(?:tgz|tar\.gz|zip|whl))\b/i;
const ARTIFACT_NOTICE = /^\s*(?:npm\s+notice\s+)?filename:\s+(\S+\.tgz)\s*$/gmi;
const PACK_STDOUT_FILE = /^\s*(\S+\.tgz)\s*$/gmi;
const SHA_HASH = /\b(?:sha256|sha-256|hash)[:\s=]+([0-9a-f]{32,64})\b/i;
const SIZE_BYTES = /\b(\d+)\s*(?:bytes|B)\b/;
const SIZE_NOTICE = /package size:\s+(\d+(?:\.\d+)?)\s*([kKmMgG])(i?)B/i;
function unique(values: string[]): string[] {
  return [...new Set(values.filter((item) => item.trim() !== ''))];
}

/** Recognized summary rows only: test names and PASS file banners are not counts. */
function parseTestSummary(text: string): Partial<Record<TestCount, number>> {
  type SummaryKey = TestCount | 'cancelled' | 'todo';
  let counts: Partial<Record<SummaryKey, number>> = {};
  for (const line of cleanToolOutput(text).split('\n')) {
    if (line === '…[truncated]') { counts = {}; continue; }
    const node = /^\s*(?:[#ℹ✔✖]\s*)?(tests?|pass(?:ed)?|fail(?:ed)?|skip(?:ped)?|cancelled|todo)(?:\s*:\s*|\s+)(\d+)\s*$/i.exec(line);
    if (node !== null) {
      const label = (node[1] ?? '').toLowerCase();
      const key: SummaryKey = label.startsWith('test') ? 'total'
        : label.startsWith('pass') ? 'pass' : label.startsWith('fail') ? 'fail'
          : label.startsWith('skip') ? 'skip' : label === 'todo' ? 'todo' : 'cancelled';
      const value = Number(node[2]);
      if (!Number.isSafeInteger(value)) continue;
      if (key === 'total') counts = {};
      counts[key] = value;
      continue;
    }
    // Jest: Tests: 1 failed, 2 passed, 1 skipped, 4 total
    // Vitest: Tests  1 failed | 2 passed | 1 skipped (4)
    const summary = /^\s*Tests?(?:\s*:\s*|\s{2,})(.*)$/i.exec(line);
    if (summary === null) continue;
    const entries = [...(summary[1] ?? '').matchAll(/(\d+)\s+(passed|failed|skipped|pending|todo|total)\b/gi)];
    if (entries.length === 0) continue;
    counts = {};
    for (const entry of entries) {
      const value = Number(entry[1]);
      if (!Number.isSafeInteger(value)) continue;
      const label = (entry[2] ?? '').toLowerCase();
      const key: SummaryKey = label === 'passed' ? 'pass' : label === 'failed' ? 'fail'
        : label === 'total' ? 'total' : label === 'todo' ? 'todo' : 'skip';
      counts[key] = value;
    }
    const vitestTotal = /\((\d+)\)\s*$/.exec(summary[1] ?? '');
    if (vitestTotal !== null && Number.isSafeInteger(Number(vitestTotal[1]))) counts.total = Number(vitestTotal[1]);
    // These complete one-line summaries omit zero categories by convention.
    if (counts.total !== undefined && (counts.pass ?? 0) + (counts.fail ?? 0) + (counts.skip ?? 0) + (counts.todo ?? 0) === counts.total) {
      counts.pass ??= 0;
      counts.fail ??= 0;
      counts.skip ??= 0;
    }
  }
  if (counts.total !== undefined) {
    const accounted = (counts.pass ?? 0) + (counts.fail ?? 0) + (counts.skip ?? 0)
      + (counts.cancelled ?? 0) + (counts.todo ?? 0);
    if (accounted > counts.total) return {};
    // An explicit total fully accounted for by reported categories proves the
    // omitted categories are zero; missing rows alone do NOT prove that.
    if (accounted === counts.total) {
      counts.pass ??= 0;
      counts.fail ??= 0;
      counts.skip ??= 0;
    }
  }
  return counts;
}

/** Latest invocation wins even if an older concurrent test settles afterward. */
function extractTestMetrics(facts: ReturnType<typeof foldSessionFacts>, events: readonly LooseEvent[]): Omit<ResultSchema['tests'], 'evidence_ids'> {
  let latest: { callId: string; seq: number } | undefined;
  const suites: string[] = [];
  for (const event of events) {
    if (event.type !== 'tool/call') continue;
    const data = event.data as { callId?: unknown; arguments?: unknown } | undefined;
    if (typeof data?.callId !== 'string' || typeof data.arguments !== 'string') continue;
    const args = parseArgsJson(data.arguments);
    const command = args === undefined ? undefined : extractCommand(args);
    if (command === undefined || !isCompleteTestCommand(command)) continue;
    suites.push(command.trim());
    if (latest === undefined || event.seq > latest.seq) latest = { callId: data.callId, seq: event.seq };
  }
  const completed = latest === undefined ? undefined : facts.tools.find(tool => tool.callId === latest.callId && tool.callSeq === latest.seq);
  // A newly started test without a result invalidates the older summary too.
  const counts = completed === undefined ? {} : parseTestSummary(completed.resultText ?? '');
  const unknown = TEST_COUNTS.filter(key => counts[key] === undefined);
  return {
    total: counts.total ?? 0, pass: counts.pass ?? 0, fail: counts.fail ?? 0, skip: counts.skip ?? 0,
    counts_known: unknown.length === 0,
    ...(unknown.length === 0 ? {} : { unknown_counts: unknown }),
    suites: unique(suites),
  };
}


export function extractCommitShas(text: string): string[] {
  const out: string[] = [];
  const bracket = text.match(COMMIT_BRACKET);
  if (bracket?.[1]) out.push(bracket[1]);
  const word = text.match(COMMIT_WORD);
  if (word?.[1]) out.push(word[1]);
  return unique(out);
}

export function extractTagNames(command?: string, resultText?: string): string[] {
  const tokens = completeCommandTokens(command ?? '');
  if (tokens?.[0] !== 'git' || tokens[1] !== 'tag') return [];
  const out: string[] = [];
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '-m' || token === '--message' || token === '-F' || token === '--file') { index += 1; continue; }
    if (/^(?:-a|--annotate|-s|--sign|-f|--force|--no-sign)$/.test(token)) continue;
    // Listing, deleting and verifying tags do not create them.
    if (token.startsWith('-')) return [];
    if (out.length === 0) out.push(token);
  }
  if (out.length === 0) return [];
  const fromResult = resultText?.match(TAG_CREATED);
  if (fromResult?.[1] === out[0]) out.push(fromResult[1]);
  return unique(out);
}

function parseSize(text: string): number | undefined {
  const notice = text.match(SIZE_NOTICE);
  if (notice) {
    const n = Number(notice[1]);
    const unit = (notice[2] ?? 'k').toLowerCase();
    const base = notice[3] ? 1024 : 1000;
    const mul = unit === 'g' ? base ** 3 : unit === 'm' ? base ** 2 : base;
    return Math.round(n * mul);
  }
  const bytes = text.match(SIZE_BYTES);
  if (bytes) return parseInt(bytes[1] ?? '0', 10);
  return undefined;
}

export function extractArtifacts(tools: readonly ToolFact[]): ResultSchema['artifacts'] {
  const seen = new Set<string>();
  const artifacts: ResultSchema['artifacts'] = [];
  const add = (path: string, extra?: { hash?: string; size?: number }) => {
    const trimmed = path.trim().replace(/\\/g, '/');
    if (trimmed === '' || seen.has(trimmed)) return;
    seen.add(trimmed);
    const name = trimmed.split('/').pop();
    artifacts.push({
      path: trimmed,
      ...(name === undefined ? {} : { name }),
      ...(extra?.hash === undefined ? {} : { hash: extra.hash }),
      ...(extra?.size === undefined ? {} : { size: extra.size }),
    });
  };

  for (const tool of tools) {
    if (!tool.ok) continue;
    const tokens = completeCommandTokens(tool.command ?? '');
    const packed = tokens?.[0] === 'npm' && tokens[1] === 'pack';
    const written = ['write', 'edit', 'rename', 'move', 'cp', 'mv'].includes(tool.name) && tool.filePath !== undefined;
    if (!packed && !written) continue;
    const text = tool.resultText ?? '';
    // npm's inventory sizes/hashes belong to members, not its output tarball.
    const hash = packed
      ? /^\s*(?:npm\s+notice\s+)?(?:sha256|sha-256|hash|shasum)[:\s=]+([0-9a-f]{32,64})\s*$/mi.exec(text)?.[1]
      : text.match(SHA_HASH)?.[1];
    const packageSize = /^\s*(?:npm\s+notice\s+)?package size:\s+\d+(?:\.\d+)?\s*(?:[kKmMgG]i?)?B\s*$/mi.exec(text)?.[0];
    const size = packed ? packageSize === undefined ? undefined : parseSize(packageSize) : parseSize(text);
    const extra = { ...(hash === undefined ? {} : { hash }), ...(size === undefined ? {} : { size }) };
    if (packed) {
      const json = jsonResult(tool);
      const rows = Array.isArray(json) ? json : [];
      const filenames = rows.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object'
        && typeof row.filename === 'string' && /\.tgz$/i.test(row.filename));
      if (filenames.length > 0) {
        for (const row of filenames) add(row.filename as string, {
          ...(typeof row.size === 'number' && Number.isSafeInteger(row.size) && row.size >= 0 ? { size: row.size } : {}),
          ...(typeof row.shasum === 'string' && /^[0-9a-f]{40}$/i.test(row.shasum) ? { hash: row.shasum } : {}),
        });
      } else {
        const output = cleanToolOutput(text);
        const notices = [...output.matchAll(ARTIFACT_NOTICE)];
        // npm's member inventory is not a list of produced files. Once an
        // authoritative filename exists, never scan arbitrary archive mentions.
        const files = notices.length > 0 ? notices : [...output.matchAll(PACK_STDOUT_FILE)];
        for (const file of files) if (file[1]) add(file[1], files.length === 1 ? extra : undefined);
      }
    }
    if (written && tool.filePath && ARTIFACT_FILE.test(tool.filePath)) add(tool.filePath, extra);
  }
  return artifacts;
}

function extractWorkingTree(tools: readonly ToolFact[], events: readonly LooseEvent[], workspace: string): string {
  const last = tools[tools.length - 1];
  if (last === undefined || !last.ok || last.resultTruncated
    || executionDirectory(last, workspace) !== executionDirectory({}, workspace)
    || executionDirectory(last, workspace) === undefined
    || events.some(event => event.type === 'tool/call' && event.seq > (last.callSeq ?? last.seq))) return 'unknown';
  const tokens = completeCommandTokens(last.command ?? '');
  if (tokens?.[0] !== 'git' || tokens[1] !== 'status') return 'unknown';
  const flags = tokens.slice(2);
  const allowed = new Set(['--porcelain', '--porcelain=v1', '--porcelain=v2', '--short', '-s', '--branch', '-b']);
  // Path filters, hidden untracked files, -z, etc. cannot prove the whole tree.
  if (flags.some(flag => !allowed.has(flag))) return 'unknown';
  const text = cleanToolOutput(last.resultText ?? '');
  if (flags.some(flag => /^(?:--porcelain|--short|-s)/.test(flag))) {
    const lines = text.split('\n').filter(line => line.trim() !== '' && !/^##? /.test(line));
    if (lines.length === 0) return 'clean';
    return lines.every(line => /^(?:[ MADRCU?!]{2} |[12u?] ).+/.test(line)) ? 'modified' : 'unknown';
  }
  if (/^\s*nothing to commit(?:, working tree clean| \(working directory clean\))\s*$/m.test(text)) return 'clean';
  if (/^\s*(?:Changes (?:not staged for commit|to be committed)|Untracked files|Unmerged paths):/m.test(text)) return 'modified';
  return 'unknown';
}

function isoTime(value: string | number | undefined): string | undefined {
  if (value === undefined || value === '' || (typeof value === 'number' && !Number.isFinite(value))) return undefined;
  const time = new Date(value);
  return Number.isNaN(time.getTime()) ? undefined : time.toISOString();
}

/** Construct standardized ResultSchema from goal record and session events. */
export function buildResultSchema(input: {
  sessionId: string;
  goal?: NativeGoalWire;
  events?: readonly LooseEvent[];
  status: BridgeStatus;
  workspace: string;
  evidenceIds?: string[];
  warnings?: string[];
  credentialRefs?: string[];
  originatingStep?: string;
  approvalSummary?: Record<string, unknown>;
}): ResultSchema {
  const events = selectResultEvents(input.events ?? [], input.goal);
  const facts = foldSessionFacts(events);
  const metrics = extractTestMetrics(facts, events);
  const changedFiles = collectChangedFiles(events);

  const commits: string[] = [];
  const tags: string[] = [];
  let lastStep: string | undefined;

  for (const tool of facts.tools) {
    if (!tool.ok) continue;
    lastStep = tool.kinds.find((kind) => kind !== 'unknown') ?? tool.callId;
    tags.push(...extractTagNames(tool.command, tool.resultText));
    const tokens = completeCommandTokens(tool.command ?? '');
    if (tokens?.[0] === 'git' && tokens[1] === 'commit') {
      commits.push(...extractCommitShas(tool.resultText ?? ''));
    }
  }

  const startedAt = isoTime(input.goal?.created_at) ?? isoTime(events.find(event => event.type === 'turn/start')?.time);
  const lastEnd = events.filter(event => event.type === 'turn/end').at(-1);
  // An ended turn is not an ended active goal. A completed/paused goal may
  // still be edited, so updated_at is not its terminal checkpoint's timestamp.
  const terminalOperation = input.goal?.phase === 'complete' ? 'complete'
    : input.goal?.phase === 'blocked' ? 'block' : input.goal?.phase === 'paused' ? 'pause' : undefined;
  const checkpoint = terminalOperation === undefined ? undefined : events.filter(event => {
    const data = event.data as { operation?: unknown; goal?: { id?: unknown } } | undefined;
    return event.type === 'goal/change' && data?.operation === terminalOperation && data.goal?.id === input.goal?.goal_id;
  }).at(-1);
  const checkpointData = checkpoint?.data as { updatedAt?: number } | undefined;
  const candidateFinish = input.goal === undefined
    ? isTerminalStatus(input.status) ? isoTime(lastEnd?.time) : undefined
    : isoTime(checkpointData?.updatedAt);
  const finishedAt = candidateFinish !== undefined && (startedAt === undefined || candidateFinish >= startedAt)
    ? candidateFinish : undefined;
  const warnings = unique([
    ...(input.warnings ?? []),
    ...(input.goal !== undefined && events.length === 0
      ? ['Current goal create boundary is unavailable; historical execution evidence is excluded.'] : []),
    ...(metrics.suites.length > 0 && !metrics.counts_known
      ? [`Unknown test counts: ${(metrics.unknown_counts ?? []).join(', ')}; numeric zeros are compatibility placeholders.`] : []),
  ]);

  return {
    status: input.status,
    goal: {
      goal_id: input.goal?.goal_id ?? `goal-${input.sessionId}`,
      revision: input.goal?.revision ?? 1,
      ...(input.goal?.phase === undefined ? {} : { phase: input.goal.phase }),
      ...(input.goal?.objective === undefined ? {} : { objective: input.goal.objective }),
      ...(input.goal?.max_goal_rounds === undefined ? {} : { max_goal_rounds: input.goal.max_goal_rounds }),
      ...(input.goal?.rounds_started === undefined ? {} : { rounds_started: input.goal.rounds_started }),
      workspace: input.workspace,
      ...(startedAt === undefined ? {} : { started_at: startedAt }),
      ...(finishedAt === undefined ? {} : { finished_at: finishedAt }),
    },
    tests: {
      ...metrics,
      evidence_ids: input.goal !== undefined && events.length === 0 ? [] : input.evidenceIds ?? [],
    },
    changes: {
      changed_files: changedFiles,
      commits: unique(commits),
      tags: unique(tags),
      working_tree: extractWorkingTree(facts.tools, events, input.workspace),
    },
    artifacts: extractArtifacts(facts.tools),
    remote: extractRemoteEvidence(facts.tools, input.workspace, events),
    security: {
      credential_refs: input.credentialRefs ?? [],
      ...(input.approvalSummary === undefined ? {} : { approval_summary: input.approvalSummary }),
    },
    warnings,
    provenance: {
      session_id: input.sessionId,
      goal_id: input.goal?.goal_id ?? `goal-${input.sessionId}`,
      ...(input.originatingStep === undefined && lastStep === undefined
        ? {}
        : { originating_step: input.originatingStep ?? lastStep }),
    },
  };
}
