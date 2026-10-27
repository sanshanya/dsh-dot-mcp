import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../../lib/bridge.js';
import { makeGoalsService } from '../helpers/native-goals.mjs';

const WS = { id: 'ws-1', title: 'v08', path: '/tmp/v08', createdAt: 'x', updatedAt: 'x', sessionIds: [], attachSession: async () => {} };
const log = { debug() {}, info() {}, warn() {}, error() {} };

function ev(type, data, seq) {
  return { seq, type, data, time: 1_700_000_000_000 + seq * 1000 };
}

function makeLiveAgent(id, cwd) {
  const events = [];
  const inbox = { nextTurn: [], nextStep: [], hasPending: false };
  const agent = {
    id,
    status: 'idle',
    inbox,
    followups: [],
    follows: 0,
    steers: 0,
    cancels: 0,
    followup(message) { agent.followups.push(message); agent.follows += 1; inbox.nextTurn.push({ id: 'm' }); },
    steer(message) { agent.steers += 1; inbox.nextStep.push({ id: 's' }); },
    cancel(cause, options) { agent.cancels += 1; agent.lastCancel = { cause, options }; },
    whenIdle: async () => {},
    goal: undefined,
    session: {
      id,
      header: { id, cwd, createdAt: Date.now() },
      events,
      snapshotEvents: () => events,
      requestHeader: () => undefined,
    },
  };
  return agent;
}

function makeStateful(dshHome, titles = {}) {
  const agents = new Map();
  const goals = makeGoalsService();
  const agentsApi = {
    get: (id) => agents.get(id),
    list: () => [...agents.values()],
    create: async ({ sessionId, meta }) => {
      const agent = makeLiveAgent(sessionId, meta.cwd);
      agents.set(sessionId, agent);
      return { agent };
    },
    resume: async ({ resumeSessionId }) => {
      const existing = agents.get(resumeSessionId);
      if (existing) return { agent: existing };
      const agent = makeLiveAgent(resumeSessionId, WS.path);
      agents.set(resumeSessionId, agent);
      return { agent };
    },
  };
  const persistence = {
    list: async () => [...agents.values()].map((agent) => ({ header: agent.session.header })),
    inspect: async (id) => {
      const agent = agents.get(id);
      if (agent === undefined) throw new Error('missing');
      return { meta: agent.session.header, events: agent.session.events };
    },
  };
  const ctx = {
    get: (key) => ({ workspaceRegistry: { list: () => [WS] }, goals }[key]),
    agents: agentsApi,
    sessions: { list: () => [...agents.values()].map((a) => a.session), get: (id) => agents.get(id)?.session },
    sessionPersistence: persistence,
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    sessionTitle: { get: (session) => (titles[session.id] === undefined ? undefined : { title: titles[session.id] }), rename() {} },
    on: () => {},
  };
  const bridge = new Bridge(ctx, {
    dshHome,
    sessionMaxItems: 5,
    sessionMaxChars: 200,
    resultMaxItems: 10,
    resultMaxChars: 500,
  }, log);
  return { bridge, agents, goals };
}

test('v0.8 P0-02: receipts persist across restart; conflict and not-found are explicit', async () => {
  const home = await mkdtemp(join(tmpdir(), 'bridge-receipts-'));
  try {
    const { bridge } = makeStateful(home);
    const view = await bridge.createSession('ws-1', 'receipts');
    const first = await bridge.sendMessage(view.session_id, 'hello', 'rid-1', 'queue');
    assert.equal(first.accepted, true);
    const receipt = bridge.messageStatus(view.session_id, 'rid-1');
    assert.equal(receipt.state, 'accepted');
    assert.equal(receipt.mode, 'queue');
    assert.ok(receipt.accepted_at.includes('T'));
    assert.ok(existsSync(join(home, 'message-receipts.json')), 'receipt file must exist');

    await assert.rejects(
      () => bridge.sendMessage(view.session_id, 'different text', 'rid-1'),
      (error) => error.code === 'IDEMPOTENCY_CONFLICT',
    );
    assert.throws(
      () => bridge.messageStatus(view.session_id, 'missing-id'),
      (error) => error.code === 'REQUEST_NOT_FOUND' && error.message.includes('retention window'),
    );
    // No cross-session leakage of the same key.
    assert.throws(
      () => bridge.messageStatus('other-session', 'rid-1'),
      (error) => error.code === 'REQUEST_NOT_FOUND',
    );

    // Restart: a new Bridge over the same home still answers the receipt.
    const second = makeStateful(home).bridge;
    const restored = second.messageStatus(view.session_id, 'rid-1');
    assert.equal(restored.state, 'accepted');
    assert.equal(restored.mode, 'queue');
    const replay = await second.sendMessage(view.session_id, 'hello', 'rid-1', 'queue');
    assert.equal(replay.replayed, true, 'a restarted bridge dedupes the connector replay');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('v0.8 P1-05: health carries instance/build metadata; unknown carries a reason', async () => {
  const { bridge } = makeStateful(undefined);
  const report = await bridge.health();
  assert.match(report.bridge.instance_id, /^[0-9a-f-]{36}$/);
  assert.equal(report.bridge.protocol_version, '2024-11-05');
  assert.equal(report.bridge.schema_version, '0.8');
  assert.ok(report.bridge.started_at.includes('T'));
  assert.ok(typeof report.bridge.artifact_sha256 === 'string' && report.bridge.artifact_sha256.length === 16,
    'buildmeta sha stamped at build time');
  assert.ok(report.bridge.build_time !== undefined);
  // 0.9.2: the artifact field now identifies the code THIS process loaded, and
  // the freshness verdict rides beside it. A build that cannot establish its
  // own identity must say `unknown` — never `current`.
  assert.equal(report.code.state, 'current', 'a freshly imported bridge runs the tree it just loaded');
  assert.ok(['current', 'stale', 'unknown'].includes(report.code.state));
  assert.equal(report.code.changed_total, undefined, 'the MCP tool must not pay for the diff');
  const withEvidence = await bridge.health('core', { evidence: true });
  assert.equal(withEvidence.code.state, report.code.state, '/status and the tool must agree on the verdict');
  assert.equal(typeof withEvidence.code.files, 'number');
  assert.equal(withEvidence.code.stamp_matches, true, 'the stamp is written by the same function as the runtime id');
  assert.ok(typeof report.dsh.version === 'string');
  if (report.dsh.version === 'unknown') {
    assert.ok(report.dsh.unknown_reason !== undefined, 'unknown must explain itself');
  } else {
    assert.ok(report.dsh.source !== undefined);
  }
});

test('v0.8 P1-01: get_result detail modes budget the envelope; omissions are counted', async () => {
  const { bridge, agents } = makeStateful(undefined);
  const view = await bridge.createSession('ws-1', 'budget');
  const agent = agents.get(view.session_id);
  const longArgs = JSON.stringify({ file_path: '/tmp/'.repeat(150).slice(0, 600) });
  agent.session.events.push(
    ev('turn/start', { turn: 1 }, 0),
    ...Array.from({ length: 12 }, (_, i) => ev('tool/call', { turn: 1, callId: `w${i}`, name: 'write', arguments: JSON.stringify({ file_path: `/tmp/f${i}.txt`, content: 'x' }) }, 2 + i)),
    ev('tool/call', { turn: 1, callId: 'c1', name: 'write', arguments: longArgs }, 30),
    ev('tool/result', { turn: 1, message: { source: { callId: 'c1' } }, content: [{ type: 'text', text: 'ok' }] }, 31),
    ev('assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } }, 40),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 41),
  );
  const summary = await bridge.getResult(view.session_id, 800, 'summary');
  assert.ok(summary.tool_calls.every((call) => call.arguments === '…'));
  assert.ok(summary.changed_files.length <= 5);
  assert.equal(summary.result_schema, undefined, 'summary drops the structured projection');
  assert.ok(summary.omitted_counts.changed_files > 0);
  assert.equal(summary.detail, 'summary');
  assert.ok(summary.snapshot.observed_at.includes('T'));
  assert.equal(summary.snapshot.last_event_seq, 41);

  const standard = await bridge.getResult(view.session_id, 800);
  const argsCall = standard.tool_calls.find((call) => call.callId === 'c1');
  assert.ok(argsCall.arguments.length < longArgs.length + 30, 'standard caps each argument payload');
  assert.ok(standard.truncated.text === false);
  assert.equal(standard.detail, 'standard');

  const full = await bridge.getResult(view.session_id, 800, 'full');
  assert.equal(full.tool_calls.find((call) => call.callId === 'c1').arguments, longArgs);

  // P1 total budget: the WHOLE payload is bounded, not just per-field sections.
  const base = await bridge.getResult(view.session_id, 800, 'standard');
  const baseLen = JSON.stringify(base).length;
  const untouched = await bridge.getResult(view.session_id, 800, 'standard', 100000);
  const sansClock = (object) => ({ ...object, snapshot: { ...object.snapshot, observed_at: '<clock>' } });
  assert.deepEqual(sansClock(untouched), sansClock(base), 'a budget above the payload changes nothing but the clock');
  assert.equal(untouched.truncated.total, undefined);
  const tight = await bridge.getResult(view.session_id, 800, 'standard', baseLen - 300);
  assert.equal(tight.truncated.total, true, 'degradation is visible');
  assert.ok(JSON.stringify(tight).length <= baseLen - 300, 'the ladder lands under budget');
  assert.equal(tight.result_schema, undefined, 'the structured projection goes first');
  // Drive the ladder one step deeper: force the tool-argument stubbing step.
  const sansSchema = ((object) => { const copy = { ...object }; delete copy.result_schema; return copy; })(base);
  const stepTwo = await bridge.getResult(view.session_id, 800, 'standard', JSON.stringify(sansSchema).length - 200);
  assert.equal(stepTwo.truncated.total, true);
  assert.equal(stepTwo.result_schema, undefined);
  assert.ok(stepTwo.tool_calls.every((call) => call.arguments === '…'), 'tool arguments are stubbed next');
  assert.equal(stepTwo.assistant_text, base.assistant_text, 'assistant text survives the first two steps');
  const extreme = await bridge.getResult(view.session_id, 800, 'standard', 500);
  assert.equal(extreme.truncated.total, true);
  assert.ok(JSON.parse(JSON.stringify(extreme)), 'below the skeleton we stop cutting — JSON stays valid');
  assert.ok(extreme.snapshot.observed_at.includes('T'), 'skeleton markers are never budgeted away');
});

test('v0.8 P0-03: last_failure survives a later healthy turn', async () => {
  const { bridge, agents } = makeStateful(undefined);
  const view = await bridge.createSession('ws-1', 'failures');
  const agent = agents.get(view.session_id);
  agent.session.events.push(
    ev('turn/start', { turn: 1 }, 0),
    ev('turn/end', { turn: 1, reason: { kind: 'error', error: { code: 'PROVIDER_OVERLOAD', message: 'provider saturated' } } }, 1),
    ev('turn/start', { turn: 2 }, 2),
    ev('turn/end', { turn: 2, reason: { kind: 'completed' } }, 3),
  );
  const result = await bridge.getResult(view.session_id);
  assert.deepEqual(result.last_failure, {
    turn: 1, seq: 1, kind: 'error', code: 'PROVIDER_OVERLOAD', message: 'provider saturated',
  });
});

test('v0.8 P1-02 + E02: list filters work; rows always carry explicit markers', async () => {
  const titles = {};
  const { bridge, agents } = makeStateful(undefined, titles);
  const kernel = await bridge.createSession('ws-1', 'kernel');
  const reap = await bridge.createSession('ws-1', 'REAP-cleanup');
  titles[kernel.session_id] = 'kernel';
  titles[reap.session_id] = 'REAP-cleanup';
  for (const id of [kernel.session_id, reap.session_id]) {
    agents.get(id).session.events.push(ev('assistant/message', { turn: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }, 1));
  }
  const all = await bridge.listSessions({});
  assert.equal(all.length, 2);
  const detail = await bridge.getSession(kernel.session_id);
  assert.ok(detail.snapshot.observed_at.includes('T'), 'get_session carries snapshot markers too');
  assert.equal(detail.snapshot.last_event_seq, 1);
  for (const row of all) {
    assert.notEqual(row.status, undefined, 'status must never be absent (E02)');
    assert.ok(row.updated_at === null || row.updated_at.includes('T'));
    assert.equal(typeof row.live, 'boolean');
  }
  assert.equal((await bridge.listSessions({ query: 'reap' }))[0].session_id, reap.session_id);
  assert.equal((await bridge.listSessions({ title_exact: 'kernel' }))[0].session_id, kernel.session_id);
  assert.equal((await bridge.listSessions({ state: 'live' })).length, 2);
  assert.equal((await bridge.listSessions({ state: 'persisted' })).length, 0);
  const future = await bridge.listSessions({ updated_after: '2999-01-01T00:00:00Z' });
  assert.equal(future.length, 0, 'filter by freshness honors known timestamps only');
  await assert.rejects(
    () => bridge.listSessions({ updated_after: 'not-a-date' }),
    (error) => error.code === 'INVALID_ARGUMENT',
  );
});

test('v0.8 P1-04: wait results carry heartbeat and explicit cursor expiry', async () => {
  const { bridge, agents } = makeStateful(undefined);
  const view = await bridge.createSession('ws-1', 'cursor');
  const agent = agents.get(view.session_id);
  agent.session.events.push(
    ev('assistant/message', { turn: 1, message: { role: 'user', content: [{ type: 'text', text: 'u' }] } }, 5),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 6),
  );
  const waited = await bridge.waitGoal(view.session_id, 1, 3); // since_seq below oldest buffered event seq 5
  assert.ok(waited.heartbeat_at.includes('T'));
  assert.equal(waited.cursor?.expired, true);
  assert.equal(waited.cursor?.oldest_seq, 5);
  const fresh = await bridge.waitGoal(view.session_id, 1, 6);
  assert.equal(fresh.cursor, undefined, 'an in-window cursor reports no expiry');
});
