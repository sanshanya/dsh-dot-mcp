/**
 * Remote-evidence extraction for result-schema: read-back verification of
 * git push, npm publish and gh release mutations. Credential availability
 * never reaches this module; only settled tool facts and session events.
 */
import { completeCommandTokens, idempotencyKindFor } from './command-classify.js';
import {
  extractCommand, parseArgsJson, stripExitMarkers, type LooseEvent, type ToolFact,
} from './session-facts.js';
import { resolve } from 'node:path';
import { normalizePath } from './paths.js';

export interface RemoteEvidence {
  /** Successful mutation-tool executions, not independent remote-state proof. */
  push_observed?: boolean;
  npm_observed?: boolean;
  github_observed?: boolean;
  push_verified?: boolean;
  npm_verified?: boolean;
  github_verified?: boolean;
  details?: string;
}

export function cleanToolOutput(text: string): string {
  return stripExitMarkers(text.replace(/\u001b\[[0-9;]*m/g, '').replace(/\r/g, ''));
}

export function jsonResult(tool: ToolFact): unknown {
  if (tool.resultTruncated) return undefined;
  try { return JSON.parse(cleanToolOutput(tool.resultText ?? '')) as unknown; } catch { return undefined; }
}

/** Lexical execution identity, never a filesystem probe or an inferred shell cd. */
export function executionDirectory(tool: Pick<ToolFact, 'workdir'>, workspace: string): string | undefined {
  return workspace.trim() === '' ? undefined : normalizePath(resolve(workspace, tool.workdir ?? '.'));
}

function gitEndpoint(value: string, directory: string): string | undefined {
  if (/^(?:https?|ssh|git|file):\/\/\S+$/.test(value)) {
    try { return new URL(value).href; } catch { return undefined; }
  }
  if (/^[^/\s:]+@[^/\s:]+:\S+$/.test(value)) return value;
  if (/^(?:\.{1,2}[/\\]|[/\\]|[A-Za-z]:[/\\])/.test(value)) return normalizePath(resolve(directory, value));
  return undefined; // A remote alias is not proof of its push/fetch URL.
}

function registryUrl(value: string | undefined): string | undefined {
  if (value === undefined || !/^https?:\/\/\S+$/.test(value)) return undefined;
  try { return new URL(value).href.replace(/\/*$/, '/'); } catch { return undefined; }
}

function registryOption(tokens: readonly string[]): { registry?: string; rest: string[] } {
  const rest: string[] = [];
  let registry: string | undefined;
  let seen = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === '--registry' || token.startsWith('--registry=')) {
      const value = token === '--registry' ? tokens[++index] : token.slice('--registry='.length);
      if (seen) return { rest: [] }; // Ambiguous repeated overrides prove nothing.
      seen = true;
      registry = registryUrl(value);
    } else rest.push(token);
  }
  return { ...(registry === undefined ? {} : { registry }), rest };
}

function changesGitEndpoint(tokens: readonly string[] | undefined): boolean {
  return tokens?.[0] === 'git' && (tokens[1] === 'config'
    || (tokens[1] === 'remote' && ['add', 'remove', 'rm', 'rename', 'set-url'].includes(tokens[2] ?? '')));
}

/** git push evidence: a push reads back through the same endpoint it pushed to. */
function scanGitPush(tools: readonly ToolFact[], workspace: string, remote: RemoteEvidence): void {
  let push: { seq: number; directory: string; repository: string; ref: string; sha: string } | undefined;
  const aliases = new Map<string, { url: string; seq: number }>();
  for (const tool of tools) {
    const kind = idempotencyKindFor(tool.name, tool.command);
    const tokens = completeCommandTokens(tool.command ?? '');
    const directory = executionDirectory(tool, workspace);
    // A later mutation invalidates earlier verification, including partial failure.
    if (kind === 'git_push') { remote.push_verified = false; push = undefined; aliases.clear(); }
    if (changesGitEndpoint(tokens)) {
      // Clearing only URL lookups would let fresh lookups rebind an old alias
      // push to a new repository. Invalidate the operation itself, even when a
      // config command failed after a partial change.
      aliases.clear();
      push = undefined;
      remote.push_verified = false;
    }
    if (!tool.ok) continue;
    if (kind === 'git_push') {
      remote.push_observed = true;
      const target = tokens?.length === 4 ? /^([0-9a-f]{40}|[0-9a-f]{64}):(refs\/(?:heads|tags)\/\S+)$/.exec(tokens[3] ?? '') : null;
      if (target !== null && directory !== undefined) push = {
        seq: tool.seq, directory, repository: tokens?.[2] ?? '', sha: target[1] ?? '', ref: target[2] ?? '',
      };
    }
    if (tokens === undefined || directory === undefined) continue;
    if (push !== undefined && directory === push.directory && (tool.callSeq ?? tool.seq) > push.seq
      && tokens[0] === 'git' && tokens[1] === 'remote' && tokens[2] === 'get-url' && !tool.resultTruncated) {
      const pushing = tokens.length === 5 && tokens[3] === '--push';
      const alias = pushing ? tokens[4] : tokens.length === 4 ? tokens[3] : undefined;
      const url = gitEndpoint(cleanToolOutput(tool.resultText ?? '').trim(), directory);
      if (alias !== undefined && url !== undefined) aliases.set(`${pushing ? 'push' : 'fetch'}:${alias}`, { url, seq: tool.seq });
    }
    if (push !== undefined && directory === push.directory && (tool.callSeq ?? tool.seq) > push.seq
      && tokens.length === 4 && tokens[0] === 'git' && tokens[1] === 'ls-remote' && tokens[3] === push.ref) {
      const started = tool.callSeq ?? tool.seq;
      const endpoint = (repository: string, mode: 'push' | 'fetch') => {
        const explicit = gitEndpoint(repository, directory);
        const proof = aliases.get(`${mode}:${repository}`);
        return explicit ?? (proof !== undefined && proof.seq < started ? proof.url : undefined);
      };
      const pushedTo = endpoint(push.repository, 'push');
      const readFrom = endpoint(tokens[2] ?? '', 'fetch');
      remote.push_verified = pushedTo !== undefined && pushedTo === readFrom
        && cleanToolOutput(tool.resultText ?? '').split('\n').some(line => {
          const match = /^([0-9a-f]{40}|[0-9a-f]{64})\s+(refs\/(?:heads|tags)\/\S+)$/.exec(line.trim());
          return match?.[1] === push?.sha && match?.[2] === push?.ref;
        });
    }
  }
}

/** npm publish evidence: a view on the same registry, name and version. */
function scanNpmPublish(tools: readonly ToolFact[], workspace: string, remote: RemoteEvidence): void {
  let published: { seq: number; directory: string; registry: string; name: string; version: string } | undefined;
  for (const tool of tools) {
    const kind = idempotencyKindFor(tool.name, tool.command);
    const tokens = completeCommandTokens(tool.command ?? '');
    const directory = executionDirectory(tool, workspace);
    // A later mutation invalidates earlier verification, including partial failure.
    if (kind === 'npm_publish') { remote.npm_verified = false; published = undefined; }
    if (!tool.ok) continue;
    if (kind === 'npm_publish') {
      remote.npm_observed = true;
      const output = cleanToolOutput(tool.resultText ?? '');
      const notice = /^\s*\+\s+((?:@[^/\s]+\/)?[^@\s]+)@(\S+)\s*$/m.exec(output);
      const actual = registryUrl(/^\s*npm\s+notice\s+Publishing to (https?:\/\/\S+)/m.exec(output)?.[1]);
      const registry = actual ?? registryOption(tokens ?? []).registry;
      if (notice !== null && registry !== undefined && directory !== undefined) published = {
        seq: tool.seq, directory, registry, name: notice[1] ?? '', version: notice[2] ?? '',
      };
    }
    if (tokens === undefined || directory === undefined) continue;
    const npmRead = registryOption(tokens);
    if (published !== undefined && directory === published.directory && (tool.callSeq ?? tool.seq) > published.seq
      && npmRead.registry === published.registry && npmRead.rest[0] === 'npm' && npmRead.rest[1] === 'view'
      && [published.name, `${published.name}@${published.version}`].includes(npmRead.rest[2] ?? '')
      && npmRead.rest.slice(3).every(token => token === 'version' || token === '--json') && !tool.resultTruncated) {
      const value = jsonResult(tool);
      const row = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
      const version = typeof value === 'string' ? value : row?.version ?? cleanToolOutput(tool.resultText ?? '').trim();
      remote.npm_verified = version === published.version && (row?.name === undefined || row.name === published.name);
    }
  }
}

/** gh release evidence: a view naming the same tag and the same release URL. */
function scanGithubRelease(tools: readonly ToolFact[], workspace: string, remote: RemoteEvidence): void {
  let release: { seq: number; directory: string; tag: string; url: string } | undefined;
  for (const tool of tools) {
    const kind = idempotencyKindFor(tool.name, tool.command);
    const tokens = completeCommandTokens(tool.command ?? '');
    const directory = executionDirectory(tool, workspace);
    // A later mutation invalidates earlier verification, including partial failure.
    if (kind === 'github_release') { remote.github_verified = false; release = undefined; }
    if (!tool.ok) continue;
    if (kind === 'github_release') {
      remote.github_observed = true;
      const tag = tokens?.[3];
      const url = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/releases\/tag\/\S+$/m.exec(cleanToolOutput(tool.resultText ?? ''))?.[0];
      if (tag !== undefined && !tag.startsWith('-') && url !== undefined && directory !== undefined) {
        try {
          if (decodeURIComponent(url.split('/releases/tag/')[1] ?? '') === tag) release = { seq: tool.seq, directory, tag, url };
        } catch { /* malformed URL encoding is not evidence */ }
      }
    }
    if (tokens === undefined || directory === undefined) continue;
    if (release !== undefined && directory === release.directory && (tool.callSeq ?? tool.seq) > release.seq
      && tokens[0] === 'gh' && tokens[1] === 'release' && tokens[2] === 'view' && tokens[3] === release.tag
      && tokens.length === 6 && tokens[4] === '--json' && ['tagName,url', 'url,tagName'].includes(tokens[5] ?? '')) {
      const value = jsonResult(tool);
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        const row = value as Record<string, unknown>;
        remote.github_verified = row.tagName === release.tag && row.url === release.url;
      }
    }
  }
}

/** A pending mutation may still change the remote after an earlier read-back. */
function invalidatePendingReads(remote: RemoteEvidence, completedCalls: ReadonlySet<string>, events: readonly LooseEvent[]): void {
  for (const event of events) {
    if (event.type !== 'tool/call') continue;
    const data = event.data as { name?: string; callId?: string; arguments?: string } | undefined;
    const args = typeof data?.arguments === 'string' ? parseArgsJson(data.arguments) : undefined;
    const command = args === undefined ? undefined : extractCommand(args);
    const kind = idempotencyKindFor(data?.name ?? '', command);
    const endpointChange = changesGitEndpoint(completeCommandTokens(command ?? ''));
    if (!endpointChange && !['git_push', 'npm_publish', 'github_release'].includes(kind ?? '')) continue;
    if (completedCalls.has(`${event.seq}\u0000${data?.callId}`)) continue;
    if (kind === 'git_push' || endpointChange) remote.push_verified = false;
    if (kind === 'npm_publish') remote.npm_verified = false;
    if (kind === 'github_release') remote.github_verified = false;
  }
}

/** Read-back must follow settlement and name the same execution/remote context. */
export function extractRemoteEvidence(tools: readonly ToolFact[], workspace: string, events: readonly LooseEvent[]): RemoteEvidence {
  const remote: RemoteEvidence = { push_observed: false, npm_observed: false, github_observed: false,
    push_verified: false, npm_verified: false, github_verified: false };
  const completedCalls = new Set(tools.map(tool => `${tool.callSeq ?? tool.seq}\u0000${tool.callId}`));
  scanGitPush(tools, workspace, remote);
  scanNpmPublish(tools, workspace, remote);
  scanGithubRelease(tools, workspace, remote);
  invalidatePendingReads(remote, completedCalls, events);
  return remote;
}
