import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildResultSchema, extractArtifacts, extractCommitShas, extractTagNames } from '../../lib/result-schema.js';
import { foldSessionFacts } from '../../lib/session-facts.js';
// Native goal wire factory — mirrors src/goal-native.ts NativeGoalWire.
const native = (over = {}) => ({
  goal_id: 'goal-1',
  revision: 1,
  phase: 'complete',
  session_id: 'session-res',
  objective: 'Run tests and verify build',
  max_goal_rounds: 256,
  rounds_started: 0,
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
  activation: 'disarmed',
  ...over,
});

function goalCreate(goal = native()) {
  return { type: 'goal/change', seq: 0, time: Date.parse(goal.created_at), data: {
    kind: 'goal/change', version: 1, operation: 'create', goal: {
      id: goal.goal_id, revision: 1, phase: 'active', objective: goal.objective, maxGoalRounds: goal.max_goal_rounds,
    }, roundsStarted: 0, createdAt: Date.parse(goal.created_at), updatedAt: Date.parse(goal.created_at),
  } };
}

test('A14 / R12: buildResultSchema generates structured results with test metrics and changes', () => {

  const events = [
    {
      type: 'tool/call',
      seq: 1,
      data: {
        turn: 1,
        callId: 'c1',
        name: 'bash',
        arguments: JSON.stringify({ command: 'node --test test/unit/sample.test.mjs' }),
      },
    },
    {
      type: 'tool/result',
      seq: 2,
      data: {
        turn: 1,
        message: {
          source: { callId: 'c1' },
          content: [{ type: 'tool', isError: false, content: '✔ pass 203\nℹ tests 203\nℹ pass 203\nℹ fail 0' }],
        },
      },
    },
    {
      type: 'tool/call',
      seq: 3,
      data: {
        turn: 1,
        callId: 'c2',
        name: 'write',
        arguments: JSON.stringify({ path: 'src/sample.ts' }),
      },
    },
    {
      type: 'tool/result',
      seq: 4,
      data: {
        turn: 1,
        message: { source: { callId: 'c2' }, content: [{ type: 'tool', isError: false, content: 'ok' }] },
      },
    },
  ];

  const result = buildResultSchema({
    sessionId: 'session-res',
    goal: native(),
    events: [goalCreate(), ...events],
    status: 'completed',
    workspace: 'D:/test-workspace',
    evidenceIds: ['evidence-12345'],
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.goal.goal_id, 'goal-1');
  assert.equal(result.goal.revision, 1);
  assert.equal(result.goal.phase, 'complete');
  assert.equal(result.tests.pass, 203);
  assert.equal(result.tests.total, 203);
  assert.ok(result.tests.evidence_ids.includes('evidence-12345'));
  assert.ok(result.changes.changed_files.includes('src/sample.ts'));
  assert.equal('secret_leak_check' in result.security, false);
  assert.deepEqual(Object.keys(result.security), ['credential_refs']);
  assert.equal(result.provenance.session_id, 'session-res');
});

test('A14: commit SHAs, tags, and tarball artifacts are parsed from tool evidence', () => {
  const events = [
    {
      type: 'tool/call',
      seq: 1,
      data: {
        turn: 1,
        callId: 'c-commit',
        name: 'bash',
        arguments: JSON.stringify({ command: 'git commit -m "fix tests"' }),
      },
    },
    {
      type: 'tool/result',
      seq: 2,
      data: {
        turn: 1,
        message: {
          source: { callId: 'c-commit' },
          content: [{ type: 'tool', isError: false, content: '[main a1b2c3d4e5f6] fix tests\n 2 files changed' }],
        },
      },
    },
    {
      type: 'tool/call',
      seq: 3,
      data: {
        turn: 1,
        callId: 'c-tag',
        name: 'bash',
        arguments: JSON.stringify({ command: 'git tag v0.1.0' }),
      },
    },
    {
      type: 'tool/result',
      seq: 4,
      data: {
        turn: 1,
        message: { source: { callId: 'c-tag' }, content: [{ type: 'tool', isError: false, content: 'Created tag v0.1.0' }] },
      },
    },
    {
      type: 'tool/call',
      seq: 5,
      data: {
        turn: 1,
        callId: 'c-pack',
        name: 'bash',
        arguments: JSON.stringify({ command: 'npm pack' }),
      },
    },
    {
      type: 'tool/result',
      seq: 6,
      data: {
        turn: 1,
        message: {
          source: { callId: 'c-pack' },
          content: [{
            type: 'tool',
            isError: false,
            content: 'npm notice filename: probemux-0.1.0.tgz\nnpm notice package size: 12.5 kB\nsha256: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
          }],
        },
      },
    },
  ];

  const result = buildResultSchema({
    sessionId: 'session-rel',
    goal: native(),
    events: [goalCreate(), ...events],
    status: 'completed',
    workspace: 'D:/workspace/probemux',
  });

  assert.ok(result.changes.commits.includes('a1b2c3d4e5f6'));
  assert.ok(!result.changes.commits.includes('local-commit'));
  assert.ok(result.changes.tags.includes('v0.1.0'));
  assert.equal(result.artifacts.length, 1);
  assert.equal(result.artifacts[0].name, 'probemux-0.1.0.tgz');
  assert.equal(result.artifacts[0].hash, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
  assert.ok((result.artifacts[0].size ?? 0) > 1000);
});

// A14 (secret_leak_check) removed: the heuristic redactor was deleted in 0.7.0.
// The wire carries tool output verbatim by operator decision (trusted-channel
// model); get_result's security section now only reports real data:
// credential_refs and approval_summary.

test('extract helpers parse git and pack evidence', () => {
  assert.deepEqual(extractCommitShas('[main abcdef1] fix\n 1 file changed'), ['abcdef1']);
  assert.ok(extractTagNames('git tag v1.2.3', '').includes('v1.2.3'));
  const artifacts = extractArtifacts([
    {
      seq: 1,
      callId: 'c',
      name: 'bash',
      kinds: ['npm_pack'],
      ok: true,
      command: 'npm pack',
      resultText: 'npm notice filename: pkg-1.0.0.tgz',
    },
  ]);
  assert.equal(artifacts[0]?.name, 'pkg-1.0.0.tgz');
});

test('live structured results preserve running status and omit terminal timestamp', () => {
  const result = buildResultSchema({
    sessionId: 'session-running',
    events: [],
    status: 'running',
    workspace: 'D:/ws',
  });
  assert.equal(result.status, 'running');
  assert.equal('finished_at' in result.goal, false);
});

test('terminal structured results take their stable timestamp from the event, not the read clock', () => {
  const ended = Date.parse('2026-01-02T03:04:05.000Z');
  const input = {
    sessionId: 'session-interrupted',
    events: [{ type: 'turn/end', seq: 1, time: ended, data: { turn: 1, reason: { kind: 'interrupted' } } }],
    status: 'interrupted',
    workspace: 'D:/ws',
  };
  const result = buildResultSchema(input);
  assert.equal(result.status, 'interrupted');
  assert.equal(result.goal.finished_at, '2026-01-02T03:04:05.000Z');
  assert.deepEqual(buildResultSchema(input), result);
});

function runEvents(command, output = 'ok', { seq = 1, isError = false, name = 'bash', extraBlocks = [], workdir } = {}) {
  const callId = `result-${seq}`;
  return [
    { type: 'tool/call', seq, data: { turn: 1, callId, name, arguments: JSON.stringify({ command, workdir }) } },
    { type: 'tool/result', seq: seq + 1, data: { turn: 1, message: {
      source: { callId }, content: [{ type: 'tool', isError, content: output }, ...extraBlocks],
    } } },
  ];
}

function resultFor(events) {
  return buildResultSchema({ sessionId: 'honest-result', events, status: 'completed', workspace: '/tmp/workspace' });
}

function runSequence(...rows) {
  return rows.flatMap(([command, output, options], index) => runEvents(command, output, { ...options, seq: index * 2 + 1 }));
}

const remoteFlags = remote => [remote.push_verified, remote.npm_verified, remote.github_verified];

test('a successful test tool without a summary has unknown counts, never an invented pass', () => {
  const result = resultFor(runEvents('npm test', 'ok\n[exit code: 0]'));
  assert.equal(result.tests.pass, 0);
  assert.equal(result.tests.total, 0);
  assert.equal(result.tests.counts_known, false);
  assert.deepEqual(result.tests.unknown_counts, ['total', 'pass', 'fail', 'skip']);
  assert.ok(result.warnings.some(warning => warning.includes('Unknown test counts')));
});

test('the bounded preview retains a long Node test run\'s 161-pass summary tail', () => {
  const output = Array.from({ length: 161 }, (_, index) => `✔ case ${index + 1} ${'detail '.repeat(12)}`).join('\n')
    + '\nℹ tests 161\nℹ suites 1\nℹ pass 161\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 543.2\n[exit code: 0]';
  const events = runEvents('node --test test/unit/*.test.mjs', output);
  const fact = foldSessionFacts(events).tools[0];
  assert.ok(output.length > 800);
  assert.equal(fact.resultTruncated, true);
  assert.ok(fact.resultText.length <= 800);
  assert.match(fact.resultText, /ℹ pass 161/);
  const { tests } = resultFor(events);
  assert.equal(tests.total, 161);
  assert.equal(tests.pass, 161);
  assert.equal(tests.fail, 0);
  assert.equal(tests.skip, 0);
  assert.equal(tests.counts_known, true);
  assert.equal(tests.unknown_counts, undefined);
});

test('Node TAP, Vitest and Jest summaries report tests, not suite counts or PASS banners', () => {
  const samples = [
    ['node --test', '# tests 161\n# suites 3\n# pass 159\n# fail 1\n# skipped 1', [161, 159, 1, 1]],
    ['npx vitest run', 'Test Files  8 passed (8)\n\u001b[32mTests  1 failed | 161 passed | 2 skipped | 1 todo (165)\u001b[0m', [165, 161, 1, 2]],
    ['npx jest', 'PASS test/fail999.test.mjs\nTest Suites: 4 passed, 4 total\nTests: 2 failed, 161 passed, 3 skipped, 166 total', [166, 161, 2, 3]],
    ['npx vitest run', 'Tests  161 passed (161)', [161, 161, 0, 0]],
    ['npx jest', 'Tests: 161 passed, 161 total', [161, 161, 0, 0]],
  ];
  for (const [command, output, expected] of samples) {
    const { tests } = resultFor(runEvents(command, output));
    assert.deepEqual([tests.total, tests.pass, tests.fail, tests.skip], expected, command);
    assert.equal(tests.counts_known, true, command);
  }
});

test('partial summaries explicitly identify missing counts, including a missing total', () => {
  const { tests } = resultFor(runEvents('npm test', '# pass 3\n# fail 0'));
  assert.equal(tests.pass, 3);
  assert.equal(tests.total, 0, 'zero remains only a compatibility placeholder');
  assert.equal(tests.counts_known, false);
  assert.deepEqual(tests.unknown_counts, ['total', 'skip']);
});

test('test summaries use the latest run rather than combining maxima from unrelated runs', () => {
  const events = runSequence(
    ['npm test', 'Tests: 100 passed, 100 total'],
    ['npm test', 'Tests: 1 failed, 99 passed, 100 total', { isError: true }],
  );
  const { tests } = resultFor(events);
  assert.deepEqual([tests.total, tests.pass, tests.fail], [100, 99, 1]);
  const unknown = resultFor([...events, ...runEvents('npm test', 'summary unavailable', { seq: 5 })]);
  assert.equal(unknown.tests.counts_known, false);
  assert.equal(unknown.tests.pass, 0);
});

test('echo, dry-run, compound and unrelated commands cannot manufacture test metrics', () => {
  for (const command of ['echo "Tests: 161 passed, 161 total"', 'npm test --dry-run', 'npm test --help',
    'npm test && echo done', 'npm run build']) {
    const { tests } = resultFor(runEvents(command, 'Tests: 161 passed, 161 total'));
    assert.equal(tests.counts_known, false, command);
    assert.equal(tests.pass, 0, command);
    assert.deepEqual(tests.suites, [], command);
  }
});

test('remote mutations can be observed but are not independently verified by tool success', () => {
  const result = resultFor(runSequence(
    ['git push origin main', 'To https://github.com/owner/repo\nmain -> main'],
    ['npm publish', '+ demo@1.2.3'],
    ['gh release create v1.2.3', 'https://github.com/owner/repo/releases/tag/v1.2.3'],
  ));
  assert.deepEqual(remoteFlags(result.remote), [false, false, false]);
  assert.deepEqual([result.remote.push_observed, result.remote.npm_observed, result.remote.github_observed], [true, true, true]);
});

test('display mentions, dry-runs, metadata and compounds do not become remote evidence', () => {
  for (const command of ["echo 'git push'", "echo 'npm publish'", "echo 'gh release create v1'",
    'git push origin main --dry-run', 'git push -n origin main', 'npm publish --dry-run',
    'gh release list', 'gh release view v1', 'npm publish --help', 'git push origin main && git ls-remote origin']) {
    const { remote } = resultFor(runEvents(command, '+ demo@1.2.3\nhttps://github.com/owner/repo/releases/tag/v1'));
    assert.deepEqual(remoteFlags(remote), [false, false, false], command);
    assert.deepEqual([remote.push_observed, remote.npm_observed, remote.github_observed], [false, false, false], command);
  }
});

test('external verification requires the subsequent read-back to match the operation target', () => {
  const sha = 'a'.repeat(40);
  const repository = 'https://github.com/owner/repo.git';
  const push = ['git push ' + repository + ' ' + sha + ':refs/heads/main', 'main -> main'];
  const lookup = ['git ls-remote ' + repository + ' refs/heads/main', sha + '\trefs/heads/main\n[exit code: 0]'];
  assert.equal(resultFor(runSequence(push, lookup)).remote.push_verified, true);
  assert.equal(resultFor(runSequence(lookup, push)).remote.push_verified, false, 'earlier reads are not proof');
  const pushing = runEvents(...push, { seq: 1 });
  const reading = runEvents(...lookup, { seq: 2 });
  const overlapping = [pushing[0], reading[0], { ...pushing[1], seq: 3 }, { ...reading[1], seq: 4 }];
  assert.equal(resultFor(overlapping).remote.push_verified, false, 'a read started before push settled cannot verify it');
  assert.equal(resultFor(runSequence(push, [lookup[0], 'b'.repeat(40) + '\trefs/heads/main'])).remote.push_verified, false);
  assert.equal(resultFor(runSequence(['git push origin main', 'main -> main'], lookup)).remote.push_verified, false, 'do not guess HEAD');
  assert.equal(resultFor(runSequence(push, ['git ls-remote other refs/heads/main', lookup[1]])).remote.push_verified, false);
  assert.equal(resultFor(runSequence(push, [lookup[0], lookup[1] + '\n[exit code: 1]'])).remote.push_verified, false);

  const registry = 'https://registry.npmjs.org/';
  const publish = ['npm publish --registry=' + registry, '+ demo@1.2.3'];
  assert.equal(resultFor(runSequence(publish, ['npm view demo@1.2.3 version --json --registry=' + registry, '"1.2.3"'])).remote.npm_verified, true);
  assert.equal(resultFor(runSequence(publish, ['npm view other version --json --registry=' + registry, '"1.2.3"'])).remote.npm_verified, false);
  assert.equal(resultFor(runSequence(publish, ['npm view demo version --json --registry=' + registry, '"1.2.2"'])).remote.npm_verified, false);
  assert.equal(resultFor(runSequence(publish, ['npm view demo --json --registry=' + registry, '{"name":"other","version":"1.2.3"}'])).remote.npm_verified, false);

  const url = 'https://github.com/owner/repo/releases/tag/v1.2.3';
  const create = ['gh release create v1.2.3', url];
  const view = ['gh release view v1.2.3 --json tagName,url', JSON.stringify({ tagName: 'v1.2.3', url })];
  assert.equal(resultFor(runSequence(create, view)).remote.github_verified, true);
  assert.equal(resultFor(runSequence(create, [view[0], JSON.stringify({ tagName: 'v1.2.3', url: 'https://github.com/other/repo/releases/tag/v1.2.3' })])).remote.github_verified, false);
});

test('nonzero process exit or an error in any result block is not successful tool evidence', () => {
  const exited = runEvents('git push origin main', 'looks successful\n[exit code: 1]');
  assert.equal(foldSessionFacts(exited).tools[0].ok, false);
  assert.equal(foldSessionFacts(exited).tools[0].exitCode, 1);
  assert.equal(resultFor(exited).remote.push_observed, false);
  const errorBlock = runEvents('npm publish', '+ demo@1.2.3', { extraBlocks: [{ type: 'tool', isError: true, content: 'failed' }] });
  assert.equal(foldSessionFacts(errorBlock).tools[0].ok, false);
  assert.equal(resultFor(errorBlock).remote.npm_observed, false);
});

test('working tree is unknown without a current, unfiltered successful git status observation', () => {
  assert.equal(resultFor([]).changes.working_tree, 'unknown');
  assert.equal(resultFor(runEvents('npm test', 'Tests: 161 passed, 161 total')).changes.working_tree, 'unknown');
  assert.equal(resultFor(runEvents('git status --porcelain', '\n[exit code: 0]')).changes.working_tree, 'clean');
  assert.equal(resultFor(runEvents('git status --short', ' M src/file.ts')).changes.working_tree, 'modified');
  assert.equal(resultFor(runEvents('git status', 'On branch main\nnothing to commit, working tree clean')).changes.working_tree, 'clean');
  assert.equal(resultFor(runEvents('git status --porcelain src/file.ts', '')).changes.working_tree, 'unknown');
  assert.equal(resultFor(runEvents('git status --porcelain -uno', '')).changes.working_tree, 'unknown');
  assert.equal(resultFor(runEvents('git status --porcelain', 'fatal: not a repository\n[exit code: 1]')).changes.working_tree, 'unknown');
  const status = runEvents('git status --porcelain', '');
  assert.equal(resultFor([...status, ...runEvents('npm test', 'ok', { seq: 3 })]).changes.working_tree, 'unknown');
  assert.equal(resultFor([...status, { type: 'tool/call', seq: 3, data: { callId: 'open', name: 'write', arguments: '{"file_path":"a"}' } }]).changes.working_tree, 'unknown');
});

test('echo/list/dry-run cannot create commits, tags or artifacts, and missing SHA stays missing', () => {
  const result = resultFor(runSequence(
    ['echo "git commit"', '[main abcdef1] fabricated'],
    ['git commit --dry-run', '[main abcdef1] not committed'],
    ['git commit -m "message"', 'ok'],
    ['git tag --list', 'v1.2.3'],
    ['git tag v1.2.3 --delete', 'Deleted tag v1.2.3'],
    ['echo "npm pack"', 'npm notice filename: fake.tgz'],
    ['npm pack --dry-run', 'npm notice filename: fake.tgz'],
  ));
  assert.deepEqual(result.changes.commits, []);
  assert.deepEqual(result.changes.tags, []);
  assert.deepEqual(result.artifacts, []);
});

test('unknown terminal time is omitted; goal creation and terminal checkpoints stay stable', () => {
  assert.equal(resultFor([]).goal.finished_at, undefined);
  const input = { sessionId: 's', goal: native(), events: [], status: 'completed', workspace: '/tmp/ws' };
  assert.equal(buildResultSchema(input).goal.finished_at, undefined, 'updated_at alone is not proof of completion time');
  assert.equal(buildResultSchema(input).goal.started_at, native().created_at);
  const created = goalCreate();
  const completed = { ...created, seq: 1, data: { ...created.data, operation: 'complete',
    goal: { ...created.data.goal, revision: 2, phase: 'complete' }, updatedAt: Date.parse(native().updated_at) } };
  const ended = { ...input, goal: native({ revision: 2 }), events: [created, completed] };
  assert.equal(buildResultSchema(ended).goal.finished_at, native().updated_at);
  assert.deepEqual(buildResultSchema(ended), buildResultSchema(ended));
  const invalid = buildResultSchema({ ...input, goal: native({ created_at: 'invalid', updated_at: 'invalid' }) });
  assert.equal(invalid.goal.started_at, undefined);
  assert.equal(invalid.goal.finished_at, undefined);
});
