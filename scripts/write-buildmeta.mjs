/**
 * Stamp build metadata into lib/buildmeta.json after the build.
 *
 * IMPORTANT: this must run AFTER every emitted artifact exists, so it lives at
 * the END of `npm run build` (after `build:client`). Until 0.9.2 it ran inside
 * `build:server`, before esbuild wrote lib/client.js — so the stamp described a
 * tree that never existed on disk, and `lib/client.js` was covered by nothing.
 *
 * The hash is not computed here: it comes from `lib/code-identity.js`, the same
 * function the running process uses to fingerprint itself. Two algorithms for
 * one artifact is how this repo ended up with three incompatible hashes for the
 * same bytes.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fingerprint } from '../lib/code-identity.js';

const lib = new URL('../lib/', import.meta.url).pathname;
const print = fingerprint(lib);
if (print.sha256 === undefined) {
  console.error(`buildmeta: refusing to stamp an unreadable artifact (${print.reason ?? 'unknown'})`);
  process.exit(1);
}

// `built_at` is deliberately NOT a claim about the code: a no-op rebuild moves
// it and leaves the hash identical. It records when the stamp was produced.
const meta = { built_at: new Date().toISOString(), artifact_sha256: print.sha256, files: print.files };
writeFileSync(new URL('../lib/buildmeta.json', import.meta.url), JSON.stringify(meta, null, 2));

// Contract: what we just wrote must be what a reader recomputes. This is the
// check that would have caught the build-order defect on its first run.
const reread = JSON.parse(readFileSync(new URL('../lib/buildmeta.json', import.meta.url), 'utf8'));
if (reread.artifact_sha256 !== print.sha256) {
  console.error('buildmeta: stamp does not round-trip');
  process.exit(1);
}
console.log(`buildmeta: ${print.sha256} @ ${print.files} files`);
