import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResultSchema } from '../../lib/result-schema.js';
import { selectResultEvents } from '../../lib/result-scope.js';

const workspace = '/virtual-result-evidence/a';
const repository = 'https://github.com/owner/repo.git';
const registry = 'https://registry.npmjs.org/';
const sha = 'a'.repeat(40);
const goal = (over = {}) => ({ goal_id: 'new-goal', revision: 1, phase: 'active', activation: 'armed',
  objective: 'New work', session_id: 'result-session', max_goal_rounds: 256, rounds_started: 0,
  created_at: 100, updated_at: 100, ...over });
const change = (seq, id, operation = 'create', time = 100) => ({ type: 'goal/change', seq, time, data: {
  kind: 'goal/change', version: 1, operation, goal: { id, revision: 1, phase: operation === 'complete' ? 'complete' : 'active',
    objective: 'work', maxGoalRounds: 256 }, createdAt: 100, updatedAt: time, roundsStarted: 0,
} });
function pair(seq, command, output = '[exit code: 0]', options = {}) {
  const callId = `call-${seq}`;
  return [{ type: 'tool/call', seq, time: 100, data: { turn: options.turn ?? 1, callId, name: options.name ?? 'bash',
    arguments: JSON.stringify({ command, workdir: options.workdir, ...options.args }) } },
  { type: 'tool/result', seq: seq + 1, time: 100, data: { turn: options.turn ?? 1, message: {
    source: { callId }, content: [{ type: 'tool', isError: false, content: output }],
  } } }];
}
const schema = (events, over = {}) => buildResultSchema({ sessionId: 'result-session', status: 'completed', workspace, events, ...over });
const sequence = (...rows) => rows.flatMap(([command, output, options], index) => pair(index * 2 + 1, command, output, options));
const pushed = `git push ${repository} ${sha}:refs/heads/main`;
const readBack = `git ls-remote ${repository} refs/heads/main`;
const readOutput = `${sha}\trefs/heads/main\n[exit code: 0]`;
const publish = `npm publish --registry=${registry}`;
const npmRead = `npm view demo@1.2.3 version --json --registry=${registry}`;

test('a native create boundary, not equal timestamps, owns the new goal evidence', () => {
  const events = [change(0, 'old-goal'), ...pair(1, 'npm test', 'Tests: 203 passed, 203 total'),
    change(3, 'old-goal', 'complete'), change(4, 'new-goal')];
  const current = schema(events, { goal: goal(), evidenceIds: ['foreign-explicit-id'] });
  assert.equal(current.tests.counts_known, false);
  assert.equal(current.tests.pass, 0);
  assert.deepEqual(current.changes.changed_files, []);
  assert.equal(current.remote.push_observed, false);
  assert.equal(current.goal.finished_at, undefined, 'an ended old turn cannot finish an active goal');
  assert.deepEqual(selectResultEvents(events, goal()).map(event => event.seq), [4]);
  const own = schema([...events, ...pair(5, 'npm test', 'Tests: 1 passed, 1 total')], { goal: goal() });
  assert.equal(own.tests.pass, 1);
});

test('goal edits, pauses and resumes retain only their own generation history', () => {
  const events = [change(0, 'old'), ...pair(1, 'npm test', 'Tests: 203 passed, 203 total'), change(3, 'old', 'complete'),
    change(4, 'new-goal'), ...pair(5, 'npm test', 'Tests: 2 passed, 2 total'),
    change(7, 'new-goal', 'edit'), change(8, 'new-goal', 'pause'), change(9, 'new-goal', 'resume')];
  assert.equal(schema(events, { goal: goal({ revision: 4 }) }).tests.pass, 2);
});

test('ordinary work after native completion or clear cannot become goal evidence', () => {
  const events = [change(0, 'new-goal'), ...pair(1, 'npm test', 'Tests: 2 passed, 2 total'),
    change(3, 'new-goal', 'complete', 110), ...pair(4, 'npm test', 'Tests: 203 passed, 203 total')];
  assert.equal(schema(events, { goal: goal({ phase: 'complete', updated_at: 110 }) }).tests.pass, 2);
  const clear = { type: 'goal/change', seq: 3, time: 110, data: { kind: 'goal/change', version: 1,
    operation: 'clear', cleared: { id: 'new-goal', revision: 2 }, clearedAt: 110 } };
  assert.deepEqual(selectResultEvents([events[0], events[1], events[2], clear, ...pair(4, 'npm test')], goal())
    .map(event => event.seq), [0, 1, 2]);
});

test('a missing/corrupt goal create boundary fails closed rather than guessing by time', () => {
  for (const prefix of [[], [change(0, 'other-goal')], [{ ...change(0, 'new-goal'), data: { kind: 'foreign', version: 1, operation: 'create', goal: { id: 'new-goal' } } }]]) {
    const current = schema([...prefix, ...pair(1, 'npm test', 'Tests: 203 passed, 203 total')],
      { goal: goal(), evidenceIds: ['old-proof'] });
    assert.equal(current.tests.counts_known, false);
    assert.deepEqual(current.tests.evidence_ids, []);
    assert.ok(current.warnings.some(warning => warning.includes('boundary')));
  }
});

test('without a goal, structured results report only the latest turn', () => {
  const events = [{ type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } }, ...pair(1, 'npm test', 'Tests: 203 passed, 203 total'),
    { type: 'turn/end', seq: 3, time: 10, data: { turn: 1 } },
    { type: 'turn/start', seq: 4, time: 20, data: { turn: 2 } },
    { type: 'turn/end', seq: 5, time: 30, data: { turn: 2 } }];
  const current = schema(events);
  assert.equal(current.tests.counts_known, false);
  assert.equal(current.goal.started_at, new Date(20).toISOString());
  assert.equal(current.goal.finished_at, new Date(30).toISOString());
});

test('goal completion time comes from its native checkpoint, never an old turn end', () => {
  const events = [{ type: 'turn/end', seq: 0, time: 10, data: { turn: 1 } }, change(1, 'new-goal')];
  assert.equal(schema(events, { goal: goal() }).goal.finished_at, undefined);
  assert.equal(schema(events, { goal: goal({ phase: 'complete', updated_at: 200 }) }).goal.finished_at, undefined, 'missing terminal checkpoint stays unknown');
  assert.equal(schema([...events, change(2, 'new-goal', 'complete', 200)], { goal: goal({ phase: 'complete', updated_at: 200 }) }).goal.finished_at, new Date(200).toISOString());
  assert.equal(schema([...events, change(2, 'new-goal', 'complete', 50)], { goal: goal({ phase: 'complete', updated_at: 50 }) }).goal.finished_at, undefined);
});

test('editing completed/paused goals cannot move their durable terminal checkpoint time', () => {
  const completed = [change(0, 'new-goal'), change(1, 'new-goal', 'complete', 200), change(2, 'new-goal', 'edit', 300)];
  assert.equal(schema(completed, { goal: goal({ phase: 'complete', revision: 3, updated_at: 300 }) }).goal.finished_at, new Date(200).toISOString());
  const paused = [change(0, 'new-goal'), change(1, 'new-goal', 'pause', 200), change(2, 'new-goal', 'edit', 300)];
  assert.equal(schema(paused, { goal: goal({ phase: 'paused', revision: 3, updated_at: 300 }) }).goal.finished_at, new Date(200).toISOString());
});

test('the latest-started test remains failing when an older test completes later', () => {
  const old = pair(1, 'npm test', 'Tests: 100 passed, 100 total\n[exit code: 0]');
  const latest = pair(2, 'npm test', 'Tests: 1 failed, 1 total\n[exit code: 1]');
  const events = [old[0], latest[0], { ...latest[1], seq: 3 }, { ...old[1], seq: 4 }];
  const result = schema(events);
  assert.deepEqual([result.tests.total, result.tests.pass, result.tests.fail], [1, 0, 1]);
  assert.equal(result.tests.counts_known, true);
});

test('an unresolved latest test invalidates an earlier completed summary', () => {
  const events = [...pair(1, 'npm test', 'Tests: 100 passed, 100 total'), pair(3, 'npm test')[0]];
  const result = schema(events);
  assert.equal(result.tests.counts_known, false);
  assert.equal(result.tests.pass, 0);
  assert.deepEqual(result.tests.unknown_counts, ['total', 'pass', 'fail', 'skip']);
});

test('push/read-back proof requires matching effective execution directories', () => {
  assert.equal(schema(sequence([pushed, 'ok'], [readBack, readOutput, { workdir: workspace }])).remote.push_verified, true);
  assert.equal(schema(sequence([pushed, 'ok', { workdir: './child/..' }], [readBack, readOutput])).remote.push_verified, true);
  assert.equal(schema(sequence([pushed, 'ok'], [readBack, readOutput, { workdir: '../b' }])).remote.push_verified, false);
  assert.equal(schema(sequence([pushed, 'ok', { workdir: '../b' }], [readBack, readOutput])).remote.push_verified, false);
});

test('a Git alias without fresh push/fetch endpoint proof is not independently verified', () => {
  const aliasPush = `git push origin ${sha}:refs/heads/main`;
  const aliasRead = 'git ls-remote origin refs/heads/main';
  assert.equal(schema(sequence([aliasPush, 'ok'], [aliasRead, readOutput])).remote.push_verified, false);
  const endpoints = [['git remote get-url --push origin', repository], ['git remote get-url origin', repository]];
  assert.equal(schema(sequence([aliasPush, 'ok'], ...endpoints, [aliasRead, readOutput])).remote.push_verified, true);
  assert.equal(schema(sequence(...endpoints, [aliasPush, 'ok'], [aliasRead, readOutput])).remote.push_verified, false);
  assert.equal(schema(sequence([aliasPush, 'ok'], endpoints[0], ['git remote get-url origin', 'https://github.com/other/repo.git'],
    [aliasRead, readOutput])).remote.push_verified, false, 'pushurl and fetch URL can differ');
  assert.equal(schema(sequence([aliasPush, 'ok'], ...endpoints, ['git remote set-url origin https://github.com/other/repo.git', 'ok'],
    [aliasRead, readOutput])).remote.push_verified, false);
  assert.equal(schema(sequence([aliasPush, 'ok'], [endpoints[0][0], repository, { workdir: '../b' }], endpoints[1],
    [aliasRead, readOutput])).remote.push_verified, false);
});

test('Git endpoint changes cannot rebind old pushes, even after refreshed or partial-failure config proof', () => {
  const aliasPush = `git push origin ${sha}:refs/heads/main`;
  const aliasRead = 'git ls-remote origin refs/heads/main';
  const other = 'https://github.com/other/repo.git';
  for (const outcome of ['[exit code: 0]', '[exit code: 1]']) {
    const events = sequence([aliasPush, 'ok'], ['git remote set-url origin ' + other, outcome],
      ['git remote get-url --push origin', other], ['git remote get-url origin', other], [aliasRead, readOutput]);
    assert.equal(schema(events).remote.push_verified, false, outcome);
    assert.equal(schema(events).remote.push_observed, true);
  }
  const proved = sequence([aliasPush, 'ok'], ['git remote get-url --push origin', repository],
    ['git remote get-url origin', repository], [aliasRead, readOutput]);
  assert.equal(schema(proved).remote.push_verified, true);
  assert.equal(schema([...proved, pair(9, 'git remote set-url origin ' + other)[0]]).remote.push_verified, false);
  assert.equal(schema([...proved, ...pair(9, 'git config remote.origin.pushurl ' + other, '[exit code: 1]')]).remote.push_verified, false);
});

test('npm verification binds directory, explicit registry, package and version', () => {
  assert.equal(schema(sequence([publish, '+ demo@1.2.3'], [npmRead, '"1.2.3"'])).remote.npm_verified, true);
  assert.equal(schema(sequence([publish, '+ demo@1.2.3'], [npmRead, '"1.2.3"', { workdir: workspace }])).remote.npm_verified, true);
  assert.equal(schema(sequence([publish, '+ demo@1.2.3'], [npmRead, '"1.2.3"', { workdir: '../b' }])).remote.npm_verified, false);
  assert.equal(schema(sequence([publish, '+ demo@1.2.3'], ['npm view demo@1.2.3 version --json --registry=https://private.example/', '"1.2.3"'])).remote.npm_verified, false);
  assert.equal(schema(sequence(['npm publish', '+ demo@1.2.3'], ['npm view demo@1.2.3 version --json', '"1.2.3"'])).remote.npm_verified, false);
  assert.equal(schema(sequence(['npm publish', `npm notice Publishing to ${registry} with tag latest\n+ demo@1.2.3`],
    [npmRead, '"1.2.3"'])).remote.npm_verified, true);
  assert.equal(schema(sequence([publish, '+ demo@1.2.3'], [npmRead + ' --registry=https://other.example/', '"1.2.3"'])).remote.npm_verified, false);
});

test('GitHub release read-back in another directory is not borrowed as proof', () => {
  const url = 'https://github.com/owner/repo/releases/tag/v1.2.3';
  const release = ['gh release create v1.2.3', url];
  const read = ['gh release view v1.2.3 --json tagName,url', JSON.stringify({ tagName: 'v1.2.3', url })];
  assert.equal(schema(sequence(release, read)).remote.github_verified, true);
  assert.equal(schema(sequence(release, [...read, { workdir: '../b' }])).remote.github_verified, false);
});

test('pending remote mutations invalidate previously verified state', () => {
  const events = sequence([pushed, 'ok'], [readBack, readOutput]);
  assert.equal(schema(events).remote.push_verified, true);
  assert.equal(schema([...events, pair(5, pushed)[0]]).remote.push_verified, false);
});

test('working-tree state must observe this workspace, including relative workdir normalization', () => {
  assert.equal(schema(pair(1, 'git status --porcelain', '[exit code: 0]', { workdir: '../b' })).changes.working_tree, 'unknown');
  assert.equal(schema(pair(1, 'git status --porcelain', '[exit code: 0]', { workdir: workspace })).changes.working_tree, 'clean');
  assert.equal(schema(pair(1, 'git status --porcelain', '[exit code: 0]', { workdir: 'child/..' })).changes.working_tree, 'clean');
  assert.equal(schema(pair(1, 'git status --porcelain', '[exit code: 0]'), { workspace: '' }).changes.working_tree, 'unknown');
});

test('a parallel write begun after git status started prevents a clean claim', () => {
  const status = pair(1, 'git status --porcelain');
  const write = pair(2, undefined, 'ok', { name: 'write', args: { file_path: 'new.ts' } });
  const events = [status[0], write[0], { ...write[1], seq: 3 }, { ...status[1], seq: 4 }];
  assert.equal(schema(events).changes.working_tree, 'unknown');
});

test('grouped git dry-run flags never become observed pushes or remote proof', () => {
  for (const command of ['git push -qn origin main', 'git push -nv origin main', 'git push -vn origin main']) {
    assert.equal(schema(pair(1, command)).remote.push_observed, false, command);
  }
});

test('npm pack inventory members are not produced artifacts', () => {
  const output = 'npm notice Tarball Contents\nnpm notice 17B fixtures/data.zip\nnpm notice 20B old-package.tgz\n'
    + 'npm notice filename: demo-1.0.0.tgz\nnpm notice package size: 12.5 kB\ndemo-1.0.0.tgz\n[exit code: 0]';
  const artifacts = schema(pair(1, 'npm pack', output)).artifacts;
  assert.deepEqual(artifacts.map(item => item.path), ['demo-1.0.0.tgz']);
  assert.deepEqual(schema(pair(1, 'npm pack', 'npm notice 17B fixtures/data.zip')).artifacts, []);
  assert.deepEqual(schema(pair(1, 'npm pack', 'demo-1.0.0.tgz\n[exit code: 0]')).artifacts.map(item => item.path), ['demo-1.0.0.tgz']);
});

test('npm pack text metadata never borrows inventory size/hash values', () => {
  const output = `npm notice Tarball Contents\nnpm notice 17B fixtures/data.txt\nnpm notice 40B hash: ${sha}\n`
    + 'npm notice filename: demo-1.0.0.tgz\n[exit code: 0]';
  assert.deepEqual(schema(pair(1, 'npm pack', output)).artifacts, [{ path: 'demo-1.0.0.tgz', name: 'demo-1.0.0.tgz' }]);
  assert.equal(schema(pair(1, 'npm pack', output + '\nnpm notice package size: 12.5 kB')).artifacts[0].size, 12500);
  assert.equal(schema(pair(1, 'npm pack', output + '\nnpm notice package size: 12.5 KiB')).artifacts[0].size, 12800);
  assert.equal(schema(pair(1, 'npm pack', output + '\nnpm notice package size: 900 B')).artifacts[0].size, 900);
});

test('npm pack JSON uses authoritative per-package filename and byte metadata', () => {
  const output = JSON.stringify([{ filename: 'demo-1.0.0.tgz', size: 120, shasum: 'a'.repeat(40), files: [{ path: 'fixtures/data.zip', size: 17 }] },
    { filename: 'other-1.0.0.tgz', size: 240, files: [{ path: 'member.tgz', size: 20 }] }]);
  assert.deepEqual(schema(pair(1, 'npm pack --json', output)).artifacts, [
    { path: 'demo-1.0.0.tgz', name: 'demo-1.0.0.tgz', size: 120, hash: 'a'.repeat(40) },
    { path: 'other-1.0.0.tgz', name: 'other-1.0.0.tgz', size: 240 },
  ]);
});
