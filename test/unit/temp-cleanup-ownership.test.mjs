import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { foldSessionFacts } from '../../lib/session-facts.js';
import { cleanupTempResources, discoverTempResources } from '../../lib/temp-resources.js';

// Every resource in this suite is an in-memory entry. No fixture path is
// created, opened, or removed, and no shell/git command is executed.
const WORKSPACE = resolve(tmpdir(), 'dsh-temp-cleanup-ownership-virtual');
const SESSION = 'synthetic-session';
const GOAL = 'synthetic-current-goal';

function toolEvents(name, args, { callId = 'synthetic-call', seq = 1, turn = 1, resultText = 'ok' } = {}) {
  return [
    {
      type: 'tool/call', seq,
      data: { turn, step: 1, callId, name, arguments: JSON.stringify(args) },
    },
    {
      type: 'tool/result', seq: seq + 1,
      data: {
        turn, step: 1,
        message: {
          role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
          isError: false, content: [{ type: 'text', text: resultText }],
        },
      },
    },
  ];
}

function assertNoInferredCleanup(events, entries, { sessionId = SESSION, goalId = GOAL } = {}) {
  const files = new Map(entries);
  const before = [...files.entries()];
  const facts = foldSessionFacts(events);
  assert.ok(facts.tools.length > 0, 'the fixture must contain observed successful tools');
  assert.ok(facts.tools.every((fact) => fact.ok), 'failed tools must not make the regression pass vacuously');

  const resources = discoverTempResources({ facts, events, sessionId, goalId, workspacePath: WORKSPACE });
  const calls = [];
  const result = cleanupTempResources(resources, WORKSPACE, {
    exists(path) {
      calls.push(['exists', path]);
      return files.has(path);
    },
    remove(path) {
      calls.push(['remove', path]);
      files.delete(path);
    },
    removeWorktree(path, workspace) {
      calls.push(['removeWorktree', path, workspace]);
      files.delete(path);
    },
  });

  assert.deepEqual(resources, [], 'session facts cannot establish trusted temporary ownership');
  assert.deepEqual(calls, [], 'unregistered paths must not reach cleanup IO');
  assert.deepEqual(result, { removed: [], warnings: [] });
  assert.deepEqual([...files.entries()], before, 'all existing resource identities/content must survive');
  return facts;
}

test('cleanup ownership: reading release-style user files never authorizes deletion', () => {
  const paths = [
    join(WORKSPACE, 'release-notes-v1.2.3.md'),
    join(WORKSPACE, 'user-archive.tgz'),
    join(WORKSPACE, '_release-verify', 'user-config.json'),
  ];
  const events = paths.flatMap((file_path, index) => toolEvents('read', { file_path }, {
    callId: `read-${index}`, seq: index * 2 + 1,
  }));
  const facts = assertNoInferredCleanup(events, paths.map((path) => [path, 'pre-existing user content']));
  assert.equal(facts.tools.length, paths.length);
  assert.ok(facts.tools.every((fact) => fact.name === 'read'));
});

test('cleanup ownership: successful writes, edits, mkdir, pack and worktree calls do not prove new temporary ownership', () => {
  const notes = join(WORKSPACE, 'release-notes-v1.2.3.md');
  const verify = join(WORKSPACE, '_release-verify');
  const tarball = join(WORKSPACE, 'package-1.0.0.tgz');
  const worktree = join(WORKSPACE, 'user-worktree');
  const operations = [
    ['write', { file_path: notes, content: 'updated user notes' }, 'ok'],
    ['edit', { file_path: notes, old_string: 'old', new_string: 'new' }, 'ok'],
    ['bash', { command: 'mkdir -p _release-verify' }, 'ok'],
    ['bash', { command: 'npm pack' }, 'package-1.0.0.tgz'],
    ['bash', { command: `git worktree add "${worktree}" HEAD` }, 'ok'],
  ];
  const events = operations.flatMap(([name, args, resultText], index) => toolEvents(name, args, {
    resultText, callId: `existing-${index}`, seq: index * 2 + 1,
  }));
  assertNoInferredCleanup(events, [
    [notes, 'existing persistent notes'],
    [verify, 'existing directory with user files'],
    [tarball, 'existing published artifact'],
    [worktree, 'existing persistent worktree'],
  ]);
});

for (const executionDirectory of ['workdir', 'shell-cd']) {
  test(`cleanup ownership: subdirectory commands (${executionDirectory}) cannot target root namesakes`, () => {
    const sub = join(WORKSPACE, 'sub');
    const inSub = (command) => executionDirectory === 'workdir'
      ? { command, workdir: sub }
      : { command: `cd "${sub}" && ${command}` };
    const events = [
      ...toolEvents('bash', inSub('mkdir -p _release-verify'), { callId: 'sub-mkdir' }),
      ...toolEvents('bash', inSub('npm pack'), { callId: 'sub-pack', seq: 3, resultText: 'package-1.0.0.tgz' }),
    ];
    assertNoInferredCleanup(events, [
      [join(WORKSPACE, '_release-verify'), 'root user directory'],
      [join(WORKSPACE, 'package-1.0.0.tgz'), 'root user artifact'],
      [join(sub, '_release-verify'), 'subdirectory output without temporary registration'],
      [join(sub, 'package-1.0.0.tgz'), 'subdirectory output without temporary registration'],
    ]);
  });
}

test('cleanup ownership: old session history cannot be relabelled as the current or a foreign goal', () => {
  const notes = join(WORKSPACE, 'release-notes-v0.1.0.md');
  const events = [
    ...toolEvents('write', { file_path: notes, content: 'historical output' }, { callId: 'old-write', turn: 1 }),
    ...toolEvents('read', { file_path: notes }, { callId: 'later-read', seq: 3, turn: 2 }),
  ];
  // The same path now names a user's replacement. The historical write cannot
  // establish current ownership, even if a caller reuses the old goal id.
  for (const [sessionId, goalId] of [
    [SESSION, 'synthetic-old-goal'],
    [SESSION, GOAL],
    ['synthetic-other-session', 'synthetic-other-goal'],
  ]) {
    assertNoInferredCleanup(events, [[notes, 'new persistent user replacement']], { sessionId, goalId });
  }
});

test('cleanup ownership: model-supplied flags and claimed resource text do not register ownership', () => {
  const path = join(WORKSPACE, 'release-notes-v1.2.3.md');
  const claim = {
    path, kind: 'file', session_id: SESSION, goal_id: GOAL,
    created_by_goal: true, temporary: true, seq: 2,
  };
  const events = [
    ...toolEvents('write', { file_path: path, content: JSON.stringify(claim), ...claim }, {
      resultText: JSON.stringify(claim),
    }),
    {
      type: 'assistant/message', seq: 3,
      data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: JSON.stringify(claim) }] } },
    },
  ];
  assertNoInferredCleanup(events, [[path, 'user-owned resource despite the model claim']]);
});

test('cleanup containment remains a second guard for trusted low-level records', () => {
  const child = join(WORKSPACE, 'registered.tmp');
  const trusted = {
    path: child, kind: 'file', session_id: SESSION, goal_id: GOAL,
    created_by_goal: true, temporary: true, seq: 1,
  };
  const calls = [];
  const unsafe = [
    { ...trusted, path: WORKSPACE },
    { ...trusted, path: join(WORKSPACE, '..', 'outside.tmp') },
    { ...trusted, temporary: false },
    { ...trusted, created_by_goal: false },
    { ...trusted, session_id: '' },
    { ...trusted, goal_id: '' },
  ];
  const result = cleanupTempResources(unsafe, WORKSPACE, {
    exists: (path) => { calls.push(path); return true; },
    remove: (path) => { calls.push(path); },
  });
  assert.deepEqual(calls, []);
  assert.deepEqual(result, { removed: [], warnings: [] });
});
