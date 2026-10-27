/**
 * The identity contract, tested against synthetic trees.
 *
 * These tests deliberately do NOT mutate `lib/`: the suite runs in one process
 * (`scripts/test.mjs --test-isolation=none`), so a test that edits the real
 * build output would poison every later health assertion — and restoring the
 * identical bytes afterwards is exactly the case a content hash cannot see.
 * Every fixture here is a fresh temp directory, so each case owns its own disk.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { compare, fingerprint, statSignature } from '../../lib/code-identity.js';

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-code-id-'));
  for (const [name, body] of Object.entries(files)) {
    const absolute = join(root, name);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, body);
  }
  return root;
}

const cleanup = (root) => rmSync(root, { recursive: true, force: true });

test('identity: the same bytes in the same paths hash the same, regardless of mtime', () => {
  const root = tree({ 'a.js': 'alpha', 'nested/b.js': 'beta' });
  try {
    const first = fingerprint(root);
    assert.match(first.sha256, /^[0-9a-f]{16}$/);
    assert.equal(first.files, 2);
    // A no-op rebuild is the NORMAL case here: `npm test` rebuilds before every
    // run, so every mtime moves while every byte stays identical.
    utimesSync(join(root, 'a.js'), new Date(2001, 1, 1), new Date(2001, 1, 1));
    assert.equal(fingerprint(root).sha256, first.sha256, 'mtime must not participate in the identity');
    assert.equal(compare(root, first).state, 'current', 'a no-op rebuild must read current');
  } finally { cleanup(root); }
});

test('identity: a moved byte boundary is not a collision', () => {
  // The naive `relpath\0bytes` join maps these two trees onto one preimage.
  const a = tree({ 'a.js': 'X', 'b.js': 'Y' });
  const b = tree({ 'a.js': 'XY', 'b.js': '' });
  try {
    assert.notEqual(fingerprint(a).sha256, fingerprint(b).sha256);
  } finally { cleanup(a); cleanup(b); }
});

test('identity: content change is stale and names the file', () => {
  const root = tree({ 'a.js': 'alpha', 'b.js': 'beta' });
  try {
    const boot = fingerprint(root);
    writeFileSync(join(root, 'b.js'), 'beta-changed');
    const verdict = compare(root, boot);
    assert.equal(verdict.state, 'stale');
    assert.deepEqual(verdict.changed, ['b.js']);
    assert.equal(verdict.changedTotal, 1);
  } finally { cleanup(root); }
});

test('identity: added and removed files are both staleness', () => {
  const root = tree({ 'a.js': 'alpha', 'b.js': 'beta' });
  try {
    const boot = fingerprint(root);
    writeFileSync(join(root, 'c.js'), 'gamma');
    assert.equal(compare(root, boot).state, 'stale');
    unlinkSync(join(root, 'c.js'));
    unlinkSync(join(root, 'a.js'));
    const afterDelete = compare(root, boot);
    assert.equal(afterDelete.state, 'stale');
    assert.deepEqual(afterDelete.changed, ['a.js']);
  } finally { cleanup(root); }
});

test('identity: the .js set is what counts — other files are ignored', () => {
  const root = tree({ 'a.js': 'alpha' });
  try {
    const boot = fingerprint(root);
    writeFileSync(join(root, 'README.md'), 'docs are not code');
    writeFileSync(join(root, 'buildmeta.json'), '{"artifact_sha256":"deadbeefdeadbeef"}');
    assert.equal(compare(root, boot).state, 'current', 'rewriting the stamp must not move the verdict');
  } finally { cleanup(root); }
});

test('identity: an unscannable or empty tree is unknown, never current', () => {
  const empty = tree({});
  try {
    const print = fingerprint(empty);
    assert.equal(print.sha256, undefined);
    assert.equal(print.reason, 'empty');
    assert.equal(compare(empty, print).state, 'unknown');
  } finally { cleanup(empty); }

  const missing = fingerprint(join(tmpdir(), 'dsh-code-id-does-not-exist-xyz'));
  assert.equal(missing.sha256, undefined);
  assert.equal(missing.reason, 'scan-failed');
  assert.equal(compare('/definitely/not/a/directory', missing).state, 'unknown');
});

test('identity: a failed baseline can never be upgraded to current', () => {
  const root = tree({ 'a.js': 'alpha' });
  try {
    const broken = { sha256: undefined, files: 0, stat: '', entries: [], reason: 'empty' };
    writeFileSync(join(root, 'b.js'), 'beta');
    assert.equal(compare(root, broken).state, 'unknown');
    assert.equal(compare(root, broken).reason, 'empty');
  } finally { cleanup(root); }
});

test('identity: the identity covers the browser bundle', () => {
  const root = tree({ 'index.js': 'server', 'client.js': 'bundle' });
  try {
    const boot = fingerprint(root);
    // `npm run build:server` deletes lib/ and does not rebuild the bundle. If
    // client.js were excluded, that missing bundle would read as current.
    unlinkSync(join(root, 'client.js'));
    const verdict = compare(root, boot);
    assert.equal(verdict.state, 'stale');
    assert.deepEqual(verdict.changed, ['client.js']);
  } finally { cleanup(root); }
});

test('identity: statSignature moves with metadata, the hash does not', () => {
  const root = tree({ 'a.js': 'alpha' });
  try {
    const before = statSignature(root);
    utimesSync(join(root, 'a.js'), new Date(2005, 5, 5), new Date(2005, 5, 5));
    assert.notEqual(statSignature(root), before, 'the cheap signature must notice the movement');
    assert.equal(statSignature('/definitely/not/a/directory'), undefined);
  } finally { cleanup(root); }
});

test('identity: the shipped stamp is produced by the same function as the runtime', () => {
  // The 0.9.1 tree had three incompatible hashes for one artifact because the
  // stamp script and the runtime each had their own scheme. This is the contract
  // that makes that impossible: same function, same file set, same bytes.
  const lib = new URL('../../lib/', import.meta.url);
  const stamp = JSON.parse(readFileSync(new URL('buildmeta.json', lib), 'utf8'));
  const runtime = fingerprint(new URL('.', lib).pathname);
  assert.equal(stamp.artifact_sha256, runtime.sha256,
    'buildmeta.artifact_sha256 must equal the fingerprint the runtime computes');
  assert.equal(stamp.files, runtime.files);
});