/**
 * One identity for the built artifact, computed by ONE algorithm in ONE place.
 *
 * Why this file exists: before 0.9.2 the tree produced three unrelated 16-hex
 * "artifact" hashes for the same bytes —
 *   - `write-buildmeta.mjs` over `lib/**\/*.js` INCLUDING the browser bundle,
 *   - the same scheme run before `lib/client.js` existed (31 files vs 32),
 *   - and a `dsh_health` value that was a `readFileSync` of the stamp AT CALL
 *     TIME, so it described the disk rather than the code the process loaded.
 * A live 0.8.0 process reported `5e2f65aa0f212959`; after re-running the stamp
 * script alone — no rebuild, no restart — the same process reported
 * `b8549883b6388d38`. The field tracked the disk and called itself an artifact.
 *
 * Three consequences the reviews insisted on, all implemented here:
 *
 * 1. **No ambiguity in the preimage.** Joining `relpath\0bytes` is not
 *    injective: [["a","b"],["c","d"]] and [["a","bc\0d"]] serialize identically.
 *    Each file contributes `relpath\0sha256(bytes)`, joined with "\n".
 * 2. **One inclusion rule.** Every `.js` under the root, browser bundle
 *    included (`build:server` deletes it and does not rebuild it, so excluding
 *    it makes a missing bundle read as `current`).
 * 3. **It never throws.** This runs during plugin boot; a broken lib path must
 *    not stop the bridge from mounting. Every failure becomes a `reason`.
 *
 * It also answers the cheap question cheaply: `statSignature()` reads metadata
 * only, so a health call on an unchanged tree does no file I/O beyond `stat`,
 * and a full rehash happens only when the metadata MOVED (a no-op rebuild moves
 * mtimes but leaves the hash identical — that case must read `current`).
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** One file's contribution to the identity. */
export interface FingerprintEntry {
  /** Path relative to the root, always POSIX-separated so the id is cross-platform. */
  path: string;
  digest: string;
}

export interface Fingerprint {
  /** 16 hex chars, or absent when the scan could not establish one. */
  sha256?: string;
  /** How many `.js` files went into the hash. */
  files: number;
  /** Metadata-only signature; equal signatures imply equal content in practice. */
  stat: string;
  entries: FingerprintEntry[];
  /** Why `sha256` is absent. Never silently omitted. */
  reason?: 'scan-failed' | 'empty' | 'read-failed' | 'no-files';
}

const toPosix = (name: string): string => name.replaceAll('\\', '/');

function listJs(root: string): string[] | undefined {
  try {
    return (readdirSync(root, { recursive: true }) as string[])
      .map(String)
      .filter((name) => name.endsWith('.js'))
      .sort();
  } catch {
    return undefined;
  }
}

/** Metadata-only signature: one `stat` per file, no reads. */
export function statSignature(root: string): string | undefined {
  const names = listJs(root);
  if (names === undefined) return undefined;
  const parts: string[] = [];
  try {
    for (const name of names) {
      const stat = statSync(join(root, name));
      if (!stat.isFile()) continue;
      parts.push(`${toPosix(name)}:${stat.size}:${Math.round(stat.mtimeMs)}`);
    }
  } catch {
    return undefined;
  }
  return parts.sort().join('|');
}

/** The full identity. Reads every `.js` file once. */
export function fingerprint(root: string): Fingerprint {
  const names = listJs(root);
  if (names === undefined) return { files: 0, stat: '', entries: [], reason: 'scan-failed' };
  if (names.length === 0) return { files: 0, stat: '', entries: [], reason: 'empty' };

  const entries: FingerprintEntry[] = [];
  const stats: string[] = [];
  try {
    for (const name of names) {
      const absolute = join(root, name);
      const stat = statSync(absolute);
      if (!stat.isFile()) continue; // a directory named *.js is not an artifact
      const path = toPosix(name);
      stats.push(`${path}:${stat.size}:${Math.round(stat.mtimeMs)}`);
      entries.push({ path, digest: createHash('sha256').update(readFileSync(absolute)).digest('hex') });
    }
  } catch {
    return { files: names.length, stat: stats.sort().join('|'), entries, reason: 'read-failed' };
  }
  if (entries.length === 0) return { files: 0, stat: '', entries, reason: 'no-files' };

  const preimage = entries
    .map((entry) => `${entry.path}\0${entry.digest}`)
    .sort()
    .join('\n');
  return {
    sha256: createHash('sha256').update(preimage).digest('hex').slice(0, 16),
    files: entries.length,
    stat: stats.sort().join('|'),
    entries,
  };
}

export type Freshness = 'current' | 'stale' | 'unknown';

export interface Comparison {
  state: Freshness;
  /** Paths that appeared, disappeared or changed content (bounded by `limit`). */
  changed: string[];
  /** How many paths changed in total, so a capped list cannot hide the rest. */
  changedTotal: number;
  /** Why the state is `unknown`, when it is. */
  reason?: string;
}

/**
 * Compare a boot-time fingerprint against the tree NOW.
 *
 * Order matters: metadata first (cheap), content only when the metadata moved.
 * A no-op rebuild (`npm test` rebuilds before every run) moves every mtime and
 * leaves every byte identical — it must read `current`, and it does, because
 * the stat change only triggers the rehash that then proves equality.
 */
export function compare(root: string, boot: Fingerprint, limit = 5): Comparison {
  if (boot.sha256 === undefined) {
    return { state: 'unknown', changed: [], changedTotal: 0, reason: boot.reason ?? 'no-baseline' };
  }
  const signature = statSignature(root);
  if (signature === undefined) {
    return { state: 'unknown', changed: [], changedTotal: 0, reason: 'scan-failed' };
  }
  if (signature === boot.stat) return { state: 'current', changed: [], changedTotal: 0 };

  const now = fingerprint(root);
  if (now.sha256 === undefined) {
    return { state: 'unknown', changed: [], changedTotal: 0, reason: now.reason ?? 'read-failed' };
  }
  if (now.sha256 === boot.sha256) return { state: 'current', changed: [], changedTotal: 0 };

  const before = new Map(boot.entries.map((entry) => [entry.path, entry.digest]));
  const after = new Map(now.entries.map((entry) => [entry.path, entry.digest]));
  const touched: string[] = [];
  for (const [path, digest] of after) {
    if (before.get(path) !== digest) touched.push(path);
  }
  for (const path of before.keys()) {
    if (!after.has(path)) touched.push(path);
  }
  touched.sort();
  return { state: 'stale', changed: touched.slice(0, limit), changedTotal: touched.length };
}