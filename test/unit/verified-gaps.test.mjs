/**
 * Regression tests for gaps verified against commit b78a575e (see the review
 * package). Each test fails on the pre-fix source and passes after the fix; the
 * defect is named in the test title so a future revert is obvious.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../../lib/bridge.js';
import { fingerprintRequest } from '../../lib/request-id.js';
import { computeCatchUpDelta, computeProgressDelta } from '../../lib/session-delta.js';
import { makeGoalsService } from '../helpers/native-goals.mjs';

function makeBridge(agent, extras = {}) {
  const agents = new Map(agent === undefined ? [] : [[agent.id, agent]]);
  const goals = extras.goals ?? makeGoalsService();
  const services = {
    workspaceRegistry: undefined,
    agents: {
      get: (id) => agents.get(String(id)),
      list: () => [...agents.values()],
    },
    goals,
    ...(extras.services ?? {}),
  };
  const bridge = new Bridge(
    {
      agents: services.agents,
      get: (key) => services[key],
      on: () => {},
      effect: () => () => {},
    },
    { dshHome: '', resultMaxChars: 1000, resultMaxItems: 50 },
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  return bridge;
}

function runningAgent(id) {
  return {
    id,
    status: 'running',
    inbox: { nextTurn: [], nextStep: [] },
    // updateGoal follows up on the live agent; the fake only needs the shape.
    followup: async () => {},
    session: { events: [], snapshotEvents() { return this.events; }, header: { cwd: '/tmp/verified-gaps-workspace' } },
  };
}

test('GAP-C7: a long wait never suggests a dsh_wait_goal argument its own schema rejects', async () => {
  const bridge = makeBridge(runningAgent('s1'));
  let now = 0;
  bridge.now = () => now;
  bridge.sleep = async (ms) => { now += ms; };

  const result = await bridge.waitUntilActionRequired('s1', 120);
  assert.equal(result.status, 'running');
  assert.equal(result.continuation_required, true);
  assert.equal(result.next_tool_call.tool, 'dsh_wait_goal');
  // dsh_wait_goal accepts 1..30 only (src/mcp.ts); any suggested value must stay in range.
  const suggested = result.next_tool_call.arguments.wait_seconds;
  assert.ok(suggested >= 1 && suggested <= 30, `suggested wait_seconds ${suggested} within schema bounds`);
  assert.ok(result.waited_ms > 0, 'the actual wait still honoured the 120s window');
});

test('GAP-B2: the request_id fingerprint covers goal fields and intent', () => {
  const base = { workspace: 'ws', goal: 'g', session_id: 's1', action: 'resume' };
  assert.notEqual(
    fingerprintRequest({ ...base, goal: 'goal-one' }),
    fingerprintRequest({ ...base, goal: 'goal-two' }),
  );
  assert.notEqual(
    fingerprintRequest({ ...base, action: 'revise' }),
    fingerprintRequest({ ...base, action: 'resume' }),
  );
  assert.notEqual(
    fingerprintRequest({ ...base, expected_revision: 1 }),
    fingerprintRequest({ ...base, expected_revision: 2 }),
  );
  assert.notEqual(
    fingerprintRequest({ ...base, max_goal_rounds: 12 }),
    fingerprintRequest({ ...base, max_goal_rounds: 64 }),
  );
  assert.notEqual(
    fingerprintRequest({ ...base, workspace_lock_override: true }),
    fingerprintRequest({ ...base }),
  );
  // Identical intent still dedupes — key order is canonicalised.
  assert.equal(
    fingerprintRequest({ ...base, expected_revision: 1 }),
    fingerprintRequest({ expected_revision: 1, ...base }),
  );
});

test('GAP-B2: a reused request_id with different intent is a conflict, not a replay', async () => {
  const goals = makeGoalsService();
  const bridge = makeBridge(runningAgent('s2'), { goals });
  goals.create({ id: 's2' }, { objective: 'fixture goal' });

  const first = await bridge.updateGoal({
    session_id: 's2',
    action: 'resume',
    request_id: 'req-a',
  });
  assert.equal(first.existing_goal_reused, undefined);

  await assert.rejects(
    () => bridge.updateGoal({
      session_id: 's2',
      action: 'revise',
      goal: 'different intent',
      request_id: 'req-a',
    }),
    (error) => error.code === 'REQUEST_ID_CONFLICT',
  );

  // An identical retry is still a benign replay.
  const replay = await bridge.updateGoal({
    session_id: 's2',
    action: 'resume',
    request_id: 'req-a',
  });
  assert.equal(replay.existing_goal_reused, true);
  assert.equal(replay.revision_unchanged, true);
});

test('GAP-B2: request_id replay pre-empts a native resume that would now fail', async () => {
  const goals = makeGoalsService();
  const bridge = makeBridge(runningAgent('s3'), { goals });
  goals.create({ id: 's3' }, { objective: 'fixture goal' });

  await bridge.resumeGoal('s3', 'req-retry');

  // 此后 goal 被宿主标记完成——新鲜的 resume 会被拒绝……
  goals.__setPhase({ id: 's3' }, 'complete');
  // ……但同 request_id 的重放仍应短路取出先前未经重做的结果。
  const replayed = await bridge.resumeGoal('s3', 'req-retry');
  assert.equal(replayed.existing_goal_reused, true);

  // 同一 request_id 搭配意图不同的调用（revise 而非 resume）= 冲突。
  await assert.rejects(
    () => bridge.reviseGoal({ session_id: 's3', goal: 'a different objective', request_id: 'req-retry' }),
    (error) => error.code === 'REQUEST_ID_CONFLICT',
  );
});

// GAP-D6 removed: the heuristic redactor was deleted in 0.7.0 — error payloads
// are no longer scrubbed, by operator decision (trusted-channel model).
// ── resumable reads (client-held cursor) ────────────────────────────────────

test('GAP-C6: a client-held cursor can page a burst forward without losing events', () => {
  const events = Array.from({ length: 60 }, (_, index) => ({ seq: index + 1, type: 'note', data: {}, time: 1_700_000_000_000 + index }));
  const base = { events, facts: { tools: [] }, status: 'running', changedFiles: [], approvalIds: [], questionIds: [] };

  const first = computeCatchUpDelta(base, 0);
  assert.equal(first.new_events.length, 40, 'a page is bounded by DELTA_EVENTS_MAX');
  assert.deepEqual(first.new_events.map((event) => event.seq)[0], 1, 'catch-up returns the FIRST events, not the last');
  assert.equal(first.until_seq, 40, 'until_seq is the last event actually returned, so it is a resumable cursor');

  const second = computeCatchUpDelta(base, first.until_seq);
  assert.deepEqual(second.new_events.map((event) => event.seq)[0], 41);
  assert.equal(second.new_events.length, 20);
  assert.equal(second.until_seq, 60);

  const third = computeCatchUpDelta(base, second.until_seq);
  assert.equal(third.new_events.length, 0, 'caught up');
  assert.equal(third.until_seq, 60, 'the cursor does not move backwards when there is nothing new');

  // Contrast: the shared-cursor path keeps only the tail of the burst.
  const shared = computeProgressDelta({ ...base, previous: undefined });
  assert.equal(shared.new_events.length, 40);
  assert.equal(shared.new_events[0].seq, 21, 'shared mode drops the first 20 events');
});

test('GAP-C6: since_seq answers from the caller cursor and leaves the shared baseline alone', async () => {
  const bridge = makeBridge(runningAgent('s4'));
  let now = 0;
  bridge.now = () => now;
  bridge.sleep = async (ms) => { now += ms; };

  // Seed enough events for two pages.
  const agent = bridge.ctx.agents.get('s4');
  for (let seq = 1; seq <= 60; seq += 1) agent.session.events.push({ seq, type: 'note', data: {}, time: 1_700_000_000_000 + seq });

  const page = await bridge.waitGoal('s4', 1, 0);
  assert.equal(page.progress_delta.until_seq, 40);
  // The shared per-session baseline lives in the wait plane, next to the loops
  // that read it (the facade only forwards these two verbs).
  const cursors = bridge['waits']['cursors'];
  assert.equal(cursors.get('s4'), undefined, 'a client cursor must not move the shared baseline');

  // The shared path still advances it.
  const shared = await bridge.waitGoal('s4', 1);
  assert.equal(shared.progress_delta.new_events.length, 40);
  assert.ok(cursors.get('s4') !== undefined, 'the shared path records its own cursor');
});

// ── run traceability ────────────────────────────────────────────────────────

function countingAgent(id) {
  const agent = runningAgent(id);
  agent.followups = [];
  agent.followup = async (message) => { agent.followups.push(message); };
  return agent;
}

test('GAP-B1: send_message is idempotent only when a request_id is supplied', async () => {
  const agent = countingAgent('s5');
  const bridge = makeBridge(agent);

  // No key: unchanged behaviour, two sends queue two turns.
  await bridge.sendMessage('s5', 'do the thing');
  await bridge.sendMessage('s5', 'do the thing');
  assert.equal(agent.followups.length, 2);

  // With a key: the retry is a replay, not a second turn.
  const first = await bridge.sendMessage('s5', 'queued once', 'send-key-1');
  assert.equal(first.accepted, true);
  assert.equal(first.request_id, 'send-key-1');
  assert.equal(first.replayed, undefined);
  const retry = await bridge.sendMessage('s5', 'queued once', 'send-key-1');
  assert.equal(retry.replayed, true);
  assert.equal(agent.followups.length, 3, 'the retry did not queue a fourth turn');

  await assert.rejects(
    () => bridge.sendMessage('s5', 'a different message', 'send-key-1'),
    (error) => error.code === 'REQUEST_ID_CONFLICT',
  );
});

test('GAP-B1: goal request ids survive a bridge restart when a dshHome is configured', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-request-ids-'));
  try {
    const first = new Bridge(
      { agents: { get: () => undefined, list: () => [] }, get: () => undefined, on: () => {}, effect: () => () => {} },
      { dshHome: home },
      { debug() {}, info() {}, warn() {}, error() {} },
    );
    first.rememberRequestId('connector-retry-1', { sessionId: 'session-a', fingerprint: 'fp-1' });

    const restarted = new Bridge(
      { agents: { get: () => undefined, list: () => [] }, get: () => undefined, on: () => {}, effect: () => () => {} },
      { dshHome: home },
      { debug() {}, info() {}, warn() {}, error() {} },
    );
    assert.deepEqual(
      restarted.goalRequests.get('connector-retry-1'),
      { sessionId: 'session-a', fingerprint: 'fp-1' },
      'a connector retry after restart must still be recognised as a replay',
    );

    // A malformed file must never block startup.
    writeFileSync(join(home, 'goal-requests.json'), '{ not json');
    const afterCorruption = new Bridge(
      { agents: { get: () => undefined, list: () => [] }, get: () => undefined, on: () => {}, effect: () => () => {} },
      { dshHome: home },
      { debug() {}, info() {}, warn() {}, error() {} },
    );
    assert.equal(afterCorruption.goalRequests.get('connector-retry-1'), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// ── relay-only approval design (0.7.0) ─────────────────────────────────────
// The classification matrix, posture and deny list died with approval-policy.ts:
// the bridge parks every managed approval for the remote driver (or defers to
// the host GUI), carrying only raw tool/command plus an advisory drift note.

async function waitPending(bridge) {
  for (let i = 0; i < 100; i += 1) {
    const pending = [...bridge['relays']['approvals'].values()][0];
    if (pending !== undefined) return pending;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return undefined;
}

test('RELAY-1: every managed approval parks verbatim for the driver — no classes, no verdict', async () => {
  const agent = { id: 'relay-1', status: 'idle', session: { events: [], snapshotEvents() { return this.events; } } };
  const bridge = makeBridge(agent);
  bridge.adopt('relay-1');
  const parked = bridge['relays'].decideApproval({
    agent: {
      id: 'relay-1',
      session: {
        events: [
          {
            type: 'tool/call', seq: 1, time: 1,
            data: { turn: 1, callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'git push --force' }) },
          },
        ],
      },
    },
    toolName: 'bash',
    callId: 'c1',
  });
  const pending = await waitPending(bridge);
  assert.ok(pending !== undefined, 'a force-push the old matrix denied outright now parks like everything else');
  assert.equal(pending.capability, undefined);
  assert.equal(pending.level, undefined);
  assert.equal(pending.command, 'git push --force');
  const answer = await bridge.approve('relay-1', pending.id, 'approve');
  assert.equal(answer.outcome, 'allowed-once');
  assert.equal(await parked, 'allowed-once');
});

test('RELAY-2: a workspace write parks verbatim — the bridge attaches no notes of its own', async () => {
  const agent = { id: 'relay-2', status: 'idle', session: { events: [], snapshotEvents() { return this.events; } } };
  const bridge = makeBridge(agent);
  bridge.adopt('relay-2');
  const workspacePath = await mkdtemp(join(tmpdir(), 'relay-drift-'));
  const parked = bridge['relays'].decideApproval({
    agent: { id: 'relay-2', session: { events: [], snapshotEvents() { return this.events; }, header: { cwd: workspacePath } } },
    toolName: 'write',
    callId: 'c2',
  });
  const pending = await waitPending(bridge);
  assert.ok(pending !== undefined, 'a mutating call parks like everything else');
  assert.equal(pending.drift, undefined, 'no drift annotation: the bridge never inspects the tree for the driver');
  const answer = await bridge.approve('relay-2', pending.id, 'approve');
  assert.equal(answer.outcome, 'allowed-once');
  assert.equal(await parked, 'allowed-once');
  rmSync(workspacePath, { recursive: true, force: true });
});
