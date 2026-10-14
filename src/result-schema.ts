/**
 * Standardized Result Schema: structured, token-efficient summaries of a turn
 * (tests, commits, tags, artifacts, evidence) without parsing giant assistant
 * texts. Credential availability lives next door in credentials.ts and reaches
 * this module only as `credentialRefs` input.
 */
import { isTerminalStatus } from './status.js';
import type { NativeGoalWire } from './goal-native.js';
import type { BridgeStatus } from './status.js';
import { collectChangedFiles, foldSessionFacts, type LooseEvent, type ToolFact } from './session-facts.js';

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
  remote: {
    push_verified?: boolean;
    npm_verified?: boolean;
    github_verified?: boolean;
    details?: string;
  };
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

const PASS_COUNT_REGEX = /(?:✔|PASS|\bpass(?:ed)?\b)[:\s]*(\d+)/i;
const FAIL_COUNT_REGEX = /(?:✖|FAIL|\bfail(?:ed)?\b)[:\s]*(\d+)/i;
const SKIP_COUNT_REGEX = /(?:ℹ|SKIP|\bskip(?:ped)?\b)[:\s]*(\d+)/i;
const COMMIT_BRACKET = /\[(?:[^\]]+?\s)?([0-9a-f]{7,40})\]/i;
const COMMIT_WORD = /\bcommit\s+([0-9a-f]{7,40})\b/i;
const TAG_COMMAND = /\bgit\s+tag(?:\s+(?:-a|--annotate))?\s+['"]?([^\s'"]+)/i;
const TAG_CREATED = /\b(?:created tag|tag)\s+['"]?([vV]?\d[\w.+-]*)['"]?/i;
const ARTIFACT_FILE = /([^\s"'\\]+\.(?:tgz|tar\.gz|zip|whl))\b/i;
const ARTIFACT_NOTICE = /filename:\s+(\S+\.(?:tgz|tar\.gz|zip))/i;
const SHA_HASH = /\b(?:sha256|sha-256|hash)[:\s=]+([0-9a-f]{32,64})\b/i;
const SIZE_BYTES = /\b(\d+)\s*(?:bytes|B)\b/;
const SIZE_NOTICE = /package size:\s+(\d+(?:\.\d+)?)\s*([kKmMgG])i?B/i;
function unique(values: string[]): string[] {
  return [...new Set(values.filter((item) => item.trim() !== ''))];
}

/** Parse test results from tool execution facts. */
function extractTestMetrics(facts: ReturnType<typeof foldSessionFacts>): {
  total: number;
  pass: number;
  fail: number;
  skip: number;
  suites: string[];
} {
  let pass = 0;
  let fail = 0;
  let skip = 0;
  const suites: string[] = [];

  for (const tool of facts.tools) {
    if (tool.command && /\b(?:test|jest|vitest|mocha|node\s+--test)\b/i.test(tool.command)) {
      suites.push(tool.command.trim());
      const text = tool.resultText ?? '';
      const passMatch = text.match(PASS_COUNT_REGEX);
      if (passMatch) pass = Math.max(pass, parseInt(passMatch[1] ?? '0', 10));
      const failMatch = text.match(FAIL_COUNT_REGEX);
      if (failMatch) fail = Math.max(fail, parseInt(failMatch[1] ?? '0', 10));
      const skipMatch = text.match(SKIP_COUNT_REGEX);
      if (skipMatch) skip = Math.max(skip, parseInt(skipMatch[1] ?? '0', 10));

      if (tool.ok && pass === 0 && fail === 0) {
        pass = 1;
      }
    }
  }

  const total = pass + fail + skip;
  return { total, pass, fail, skip, suites };
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
  const out: string[] = [];
  if (command) {
    const fromCmd = command.match(TAG_COMMAND);
    if (fromCmd?.[1] && fromCmd[1] !== '-a' && fromCmd[1] !== '--annotate') out.push(fromCmd[1]);
  }
  if (resultText) {
    const fromResult = resultText.match(TAG_CREATED);
    if (fromResult?.[1]) out.push(fromResult[1]);
  }
  return unique(out);
}

function parseSize(text: string): number | undefined {
  const notice = text.match(SIZE_NOTICE);
  if (notice) {
    const n = Number(notice[1]);
    const unit = (notice[2] ?? 'k').toLowerCase();
    const mul = unit === 'g' ? 1024 * 1024 * 1024 : unit === 'm' ? 1024 * 1024 : 1024;
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
    const text = `${tool.command ?? ''}\n${tool.resultText ?? ''}\n${tool.filePath ?? ''}`;
    const hash = text.match(SHA_HASH)?.[1];
    const size = parseSize(text);
    const extra = { ...(hash === undefined ? {} : { hash }), ...(size === undefined ? {} : { size }) };
    const notice = (tool.resultText ?? '').match(ARTIFACT_NOTICE);
    if (notice?.[1]) add(notice[1], extra);
    const file = text.match(ARTIFACT_FILE);
    if (file?.[1]) add(file[1], extra);
    if (tool.filePath && ARTIFACT_FILE.test(tool.filePath)) add(tool.filePath, extra);
  }
  return artifacts;
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
  const events = input.events ?? [];
  const facts = foldSessionFacts(events);
  const metrics = extractTestMetrics(facts);
  const changedFiles = collectChangedFiles(events);

  const commits: string[] = [];
  const tags: string[] = [];
  let pushVerified = false;
  let npmVerified = false;
  let githubVerified = false;
  let lastStep: string | undefined;

  for (const tool of facts.tools) {
    if (!tool.ok) continue;
    lastStep = tool.kinds.find((kind) => kind !== 'unknown') ?? tool.callId;
    if (tool.kinds.includes('git_push')) pushVerified = true;
    if (tool.kinds.includes('npm_publish')) npmVerified = true;
    if (tool.kinds.includes('github_release')) githubVerified = true;
    if (tool.kinds.includes('git_tag') || (tool.command && TAG_COMMAND.test(tool.command))) {
      tags.push(...extractTagNames(tool.command, tool.resultText));
    }
    if (tool.command && /\bgit\s+commit\b/i.test(tool.command)) {
      const shas = extractCommitShas(tool.resultText ?? '');
      if (shas.length > 0) commits.push(...shas);
      else commits.push('local-commit');
    }
  }

  const warnings = unique(input.warnings ?? []);

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
      ...(input.goal === undefined ? {} : { started_at: new Date(input.goal.created_at).toISOString() }),
      ...(isTerminalStatus(input.status) ? { finished_at: new Date().toISOString() } : {}),
    },
    tests: {
      ...metrics,
      evidence_ids: input.evidenceIds ?? [],
    },
    changes: {
      changed_files: changedFiles,
      commits: unique(commits),
      tags: unique(tags),
      working_tree: changedFiles.length > 0 ? 'modified' : 'clean',
    },
    artifacts: extractArtifacts(facts.tools),
    remote: {
      push_verified: pushVerified,
      npm_verified: npmVerified,
      github_verified: githubVerified,
    },
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
