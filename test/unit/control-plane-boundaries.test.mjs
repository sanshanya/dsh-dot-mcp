import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Bridge } from '../../lib/bridge.js';
import { RequestFlights } from '../../lib/request-id.js';
import { makeGoalsService } from '../helpers/native-goals.mjs';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const cfg = { dshHome: '', sessionMaxItems: 5, sessionMaxChars: 200, resultMaxItems: 10, resultMaxChars: 500 };

function fixture() {
  const agents = new Map();
  const persisted = new Map();
  const goals = makeGoalsService();
  const counts = { created: 0, resumed: 0 };
  const workspaces = ['a', 'b'].map(id => ({
    id, title: id, path: `/virtual-control-boundaries/${id}`,
    createdAt: 'x', updatedAt: 'x', sessionIds: [], attachSession: async () => {},
  }));
  function agentFor(session) {
    const agent = {
      id: session.id, session, status: 'idle', inbox: { nextTurn: [], nextStep: [] },
      followups: [], cancelCount: 0,
      followup(message) { this.followups.push(message); this.inbox.nextTurn.push(message); this.status = 'running'; },
      cancel() { this.cancelCount++; this.status = 'idle'; this.inbox.nextTurn = []; this.inbox.nextStep = []; },
      whenIdle: async () => {},
    };
    agents.set(agent.id, agent);
    return agent;
  }
  const agentsApi = {
    get: id => agents.get(id), list: () => [...agents.values()],
    create: async ({ sessionId, meta }) => {
      counts.created++;
      const events = [];
      const session = { id: sessionId, header: { id: sessionId, createdAt: 1, ...meta }, events, snapshotEvents: () => events };
      persisted.set(sessionId, session);
      return { agent: agentFor(session) };
    },
    resume: async ({ resumeSessionId }) => {
      counts.resumed++;
      const session = persisted.get(resumeSessionId);
      if (!session) throw new Error('missing cold session');
      const agent = agentFor(session);
      goals.__disarm(agent);
      return { agent };
    },
  };
  const services = {
    agents: agentsApi, goals, workspaceRegistry: { list: () => workspaces },
    sessions: { list: () => [...agents.values()].map(agent => agent.session) },
    sessionPersistence: {
      open: async id => {
        const session = persisted.get(id);
        if (!session) throw new Error('missing');
        return { header: session.header, read: async () => ({ events: session.events }), close: async () => {} };
      },
      list: async () => [...persisted.values()].map(session => ({ header: session.header })),
    },
  };
  const ctx = { agents: agentsApi, sessions: services.sessions, get: key => services[key] };
  const makeBridge = (config = {}) => new Bridge(ctx, { ...cfg, ...config }, log);
  return { bridge: makeBridge(), makeBridge, agents, persisted, goals, counts, workspaces, services };
}

async function blank(f, workspace = 'a') {
  const result = await f.bridge.createSession(workspace);
  return f.agents.get(result.session_id);
}

function finishTurn(agent) {
  agent.status = 'idle';
  agent.inbox.nextTurn = [];
  agent.inbox.nextStep = [];
  agent.session.events.push(
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  );
}

const rejectsCode = (operation, code) => assert.rejects(operation, error => error.code === code);

test('in-flight keys reject different intent and failed operations release their reservation', async () => {
  const flights = new RequestFlights();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let calls = 0;
  const operation = async () => { calls++; entered.resolve(); await release.promise; throw new Error('retryable'); };
  const first = flights.run('k', 'same', operation);
  const duplicate = flights.run('k', 'same', operation);
  const outcomes = Promise.allSettled([first, duplicate]);
  await entered.promise;
  await rejectsCode(() => flights.run('k', 'different', operation), 'REQUEST_ID_CONFLICT');
  release.resolve();
  assert.ok((await outcomes).every(result => result.status === 'rejected'));
  assert.equal(calls, 1);
  assert.equal((await flights.run('k', 'same', async () => 'retried')).value, 'retried');
});

test('concurrent identical send_message requests enqueue once, with a replay marker', async () => {
  const f = fixture();
  const agent = await blank(f);
  const results = await Promise.all([1, 2, 3].map(() => f.bridge.sendMessage(agent.id, 'once', 'k')));
  assert.equal(agent.followups.length, 1);
  assert.equal(results.filter(result => result.replayed).length, 2);
});

test('cold concurrent messages coalesce agent loading and respect per-message idempotency', async () => {
  const f = fixture();
  const old = await blank(f);
  f.agents.delete(old.id);
  await Promise.all([f.bridge.sendMessage(old.id, 'one', 'k1'), f.bridge.sendMessage(old.id, 'one', 'k1'), f.bridge.sendMessage(old.id, 'two', 'k2')]);
  assert.equal(f.counts.resumed, 1);
  assert.equal(f.agents.get(old.id).followups.length, 2);
});

test('concurrent same-key goal starts create only one session and goal', async () => {
  const f = fixture();
  const input = { workspace: 'a', goal: 'one goal', request_id: 'k' };
  const results = await Promise.all([f.bridge.startGoal(input), f.bridge.startGoal(input)]);
  assert.equal(results[0].session_id, results[1].session_id);
  assert.equal(results[1].existing_goal_reused, true);
  assert.equal(f.counts.created, 1);
  assert.equal(f.goals.__count(), 1);
});

test('different keys targeting an identical objective serialize into one session', async () => {
  const f = fixture();
  const results = await Promise.all(['k1', 'k2'].map(request_id => f.bridge.startGoal({ workspace: 'a', goal: 'one goal', request_id })));
  assert.equal(results[0].session_id, results[1].session_id);
  assert.equal(f.counts.created, 1);
});

test('different concurrent mutable goals cannot create orphan competing sessions', async () => {
  const f = fixture();
  const results = await Promise.allSettled(['one', 'two'].map(goal => f.bridge.startGoal({ workspace: 'a', goal })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'WORKSPACE_LOCKED');
  assert.equal(f.counts.created, 1);
});

test('failed keyed sends are retryable once the workspace becomes available', async () => {
  const f = fixture();
  const holder = await f.bridge.startGoal({ workspace: 'a', goal: 'holder' });
  const other = await blank(f);
  await rejectsCode(() => f.bridge.sendMessage(other.id, 'work', 'k'), 'WORKSPACE_LOCKED');
  await f.bridge.stopGoal(holder.session_id);
  assert.equal((await f.bridge.sendMessage(other.id, 'work', 'k')).replayed, undefined);
  assert.equal(other.followups.length, 1);
});

test('goal fingerprints include read_only and takeover intent', async () => {
  const f = fixture();
  const input = { workspace: 'a', goal: 'one', request_id: 'k' };
  await f.bridge.startGoal(input);
  await rejectsCode(() => f.bridge.startGoal({ ...input, read_only: true }), 'REQUEST_ID_CONFLICT');
  await rejectsCode(() => f.bridge.startGoal({ ...input, workspace_lock_override: true }), 'REQUEST_ID_CONFLICT');
});

test('restored goal keys load the original cold session without creating or rearming', async () => {
  const f = fixture();
  const input = { workspace: 'a', goal: 'once across cold loads', request_id: 'k' };
  const first = await f.bridge.startGoal(input);
  const records = f.bridge.goalRequests.entries();
  f.agents.clear();
  const restarted = f.makeBridge();
  restarted.goalRequests.restore(records);
  const replay = await restarted.startGoal(input);
  assert.equal(replay.session_id, first.session_id);
  assert.equal(replay.goal.goal_id, first.goal.goal_id);
  assert.equal(replay.goal.revision, first.goal.revision);
  assert.equal(replay.goal.activation, 'disarmed');
  assert.equal(replay.continuation_required, false);
  assert.equal(replay.existing_goal_reused, true);
  assert.equal(f.counts.resumed, 1);
  assert.equal(f.counts.created, 1);
});

test('cleared or replaced goal keys never fall through to fresh work', async () => {
  const f = fixture();
  const input = { workspace: 'a', goal: 'one', request_id: 'k' };
  const first = await f.bridge.startGoal(input);
  await f.bridge.stopGoal(first.session_id);
  await rejectsCode(() => f.bridge.startGoal(input), 'GOAL_NOT_FOUND');
  assert.equal(f.counts.created, 1);
  const replacement = await f.bridge.startGoal({ workspace: 'a', session_id: first.session_id, goal: 'replacement' });
  assert.notEqual(replacement.goal.goal_id, first.goal.goal_id);
  await rejectsCode(() => f.bridge.startGoal(input), 'REQUEST_ID_STALE');
  assert.equal(f.counts.created, 1);
});

test('start_goal validates the actual workspace before adopting or mutating an existing session', async () => {
  const f = fixture();
  const agent = await blank(f, 'b');
  await rejectsCode(() => f.bridge.startGoal({ workspace: 'a', session_id: agent.id, goal: 'wrong binding' }), 'WORKSPACE_MISMATCH');
  assert.equal(f.goals.__count(), 0);
  assert.equal(f.bridge.workspaceGuard.getLock(f.workspaces[0].path), undefined);
  assert.equal(agent.cancelCount, 0);
});

test('ordinary sends and initial messages cannot bypass an active goal workspace lock', async () => {
  const f = fixture();
  await f.bridge.startGoal({ workspace: 'a', goal: 'holder' });
  const other = await blank(f);
  await rejectsCode(() => f.bridge.sendMessage(other.id, 'also write'), 'WORKSPACE_LOCKED');
  await rejectsCode(() => f.bridge.createSession('a', 'competing', 'also write'), 'WORKSPACE_LOCKED');
  assert.equal(other.followups.length, 0);
  assert.equal(f.counts.created, 2, 'the denied initial message did not create an orphan session');
});

test('an armed goal retains its lock between completed turns, including wait snapshots', async () => {
  const f = fixture();
  const started = await f.bridge.startGoal({ workspace: 'a', goal: 'several rounds' });
  finishTurn(f.agents.get(started.session_id));
  const status = await f.bridge.getTaskStatus(started.session_id);
  assert.equal(status.status, 'completed');
  assert.equal(status.goal.activation, 'armed');
  let now = 0;
  f.bridge.now = () => now;
  f.bridge.sleep = async ms => { now += ms; };
  await f.bridge.waitGoal(started.session_id, 1);
  assert.equal(f.bridge.workspaceGuard.getLock(f.workspaces[0].path).sessionId, started.session_id);
  await rejectsCode(() => f.bridge.startGoal({ workspace: 'a', goal: 'competing' }), 'WORKSPACE_LOCKED');
});

test('resume reacquires the workspace and fails closed if another goal took it', async () => {
  const f = fixture();
  const first = await f.bridge.startGoal({ workspace: 'a', goal: 'first' });
  await f.bridge.pauseGoal(first.session_id);
  const second = await f.bridge.startGoal({ workspace: 'a', goal: 'second' });
  await rejectsCode(() => f.bridge.resumeGoal(first.session_id), 'WORKSPACE_LOCKED');
  assert.equal(f.goals.get(f.agents.get(first.session_id)).phase, 'paused');
  assert.equal(f.bridge.workspaceGuard.getLock(f.workspaces[0].path).sessionId, second.session_id);
});

test('a bridge reload observes live host occupants instead of forgetting their locks', async () => {
  const f = fixture();
  await f.bridge.startGoal({ workspace: 'a', goal: 'still active' });
  const restarted = f.makeBridge();
  await rejectsCode(() => restarted.startGoal({ workspace: 'a', goal: 'another' }), 'WORKSPACE_LOCKED');
  assert.equal(f.counts.created, 1);
});

test('a read_only hint permits an audit, but a later ordinary send is treated as a writer', async () => {
  const f = fixture();
  await f.bridge.startGoal({ workspace: 'a', goal: 'writer' });
  const audit = await f.bridge.startGoal({ workspace: 'a', goal: 'audit', read_only: true });
  await rejectsCode(() => f.bridge.sendMessage(audit.session_id, 'now write'), 'WORKSPACE_LOCKED');
  assert.equal(f.agents.get(audit.session_id).followups.length, 0);
});

test('a stale pause CAS cannot cancel a running task or withdraw its pending approval', async () => {
  const f = fixture();
  const started = await f.bridge.startGoal({ workspace: 'a', goal: 'first' });
  await f.bridge.reviseGoal({ session_id: started.session_id, goal: 'second', expected_revision: 1 });
  const agent = f.agents.get(started.session_id);
  agent.status = 'running';
  f.bridge.relays.approvals.set('pending', { id: 'pending', sessionId: agent.id, toolName: 'bash', resolve() {} });
  await rejectsCode(() => f.bridge.updateGoal({ session_id: agent.id, action: 'pause', expected_revision: 1 }), 'REVISION_CONFLICT');
  assert.equal(agent.cancelCount, 0);
  assert.equal(agent.status, 'running');
  assert.equal(f.goals.get(agent).phase, 'active');
  assert.equal(f.goals.get(agent).revision, 2);
  assert.equal(f.bridge.relays.approvals.size, 1);
});

test('a rejected pause without a goal has no cancellation side effect', async () => {
  const f = fixture();
  const agent = await blank(f);
  agent.status = 'running';
  await rejectsCode(() => f.bridge.pauseGoal(agent.id), 'GOAL_NOT_FOUND');
  assert.equal(agent.cancelCount, 0);
});

test('successful pause disarms first, waits for quiescence, then admits another writer', async () => {
  const f = fixture();
  const first = await f.bridge.startGoal({ workspace: 'a', goal: 'first' });
  const agent = f.agents.get(first.session_id);
  const cancelled = Promise.withResolvers();
  const idle = Promise.withResolvers();
  agent.status = 'running';
  agent.cancel = function () { this.cancelCount++; cancelled.resolve(); };
  agent.whenIdle = () => idle.promise;
  const pause = f.bridge.pauseGoal(agent.id);
  await cancelled.promise;
  assert.equal(f.goals.get(agent).activation, 'disarmed');
  assert.equal(f.goals.get(agent).phase, 'paused');
  assert.equal(f.bridge.workspaceGuard.getLock(f.workspaces[0].path).sessionId, agent.id);
  const second = f.bridge.startGoal({ workspace: 'a', goal: 'second' });
  assert.equal(f.counts.created, 1);
  agent.status = 'idle';
  idle.resolve();
  await pause;
  assert.notEqual((await second).session_id, agent.id);
});

test('pause is idempotent after it has already reached the paused phase', async () => {
  const f = fixture();
  const first = await f.bridge.startGoal({ workspace: 'a', goal: 'one' });
  await f.bridge.pauseGoal(first.session_id);
  const second = await f.bridge.pauseGoal(first.session_id);
  assert.equal(second.checkpoint_revision, 2);
});

test('takeover pauses and quiesces the old writer rather than merely replacing a lock row', async () => {
  const f = fixture();
  const first = await f.bridge.startGoal({ workspace: 'a', goal: 'first' });
  const agent = f.agents.get(first.session_id);
  const cancelled = Promise.withResolvers();
  const idle = Promise.withResolvers();
  agent.status = 'running';
  agent.cancel = function () { this.cancelCount++; cancelled.resolve(); };
  agent.whenIdle = () => idle.promise;
  const takeover = f.bridge.startGoal({ workspace: 'a', goal: 'second', workspace_lock_override: true });
  await cancelled.promise;
  assert.equal(f.goals.get(agent).phase, 'paused');
  assert.equal(f.goals.__count(), 1, 'new goal cannot arm until the old driver settles');
  agent.status = 'idle';
  idle.resolve();
  const second = await takeover;
  assert.equal(f.bridge.workspaceGuard.getLock(f.workspaces[0].path).sessionId, second.session_id);
});

test('stop clears first and retains the lock until driver cancellation settles', async () => {
  const f = fixture();
  const first = await f.bridge.startGoal({ workspace: 'a', goal: 'one' });
  const agent = f.agents.get(first.session_id);
  const cancelled = Promise.withResolvers();
  const idle = Promise.withResolvers();
  agent.status = 'running';
  agent.cancel = function () { this.cancelCount++; cancelled.resolve(); };
  agent.whenIdle = () => idle.promise;
  const stop = f.bridge.stopGoal(agent.id);
  await cancelled.promise;
  assert.equal(f.goals.get(agent), undefined);
  assert.equal(f.bridge.workspaceGuard.getLock(f.workspaces[0].path).sessionId, agent.id);
  agent.status = 'idle';
  idle.resolve();
  await stop;
  assert.equal(f.bridge.workspaceGuard.getLock(f.workspaces[0].path), undefined);
});

test('stop also cancels an ordinary running session with no native goal', async () => {
  const f = fixture();
  const agent = await blank(f);
  await f.bridge.sendMessage(agent.id, 'ordinary work');
  const result = await f.bridge.stopGoal(agent.id);
  assert.equal(result.already_stopped, false);
  assert.equal(agent.cancelCount, 1);
  assert.equal(agent.status, 'idle');
});

test('stopping an already completed session preserves a pre-existing named release file', async () => {
  const root = realpathSync(tmpdir());
  const home = mkdtempSync(join(root, 'bridge-stop-preserves-'));
  try {
    const file = join(home, 'release-notes-v1.0.0.md');
    writeFileSync(file, 'user-owned persistent release notes');
    const f = fixture();
    f.workspaces[0].path = home;
    const started = await f.bridge.startGoal({ workspace: 'a', goal: 'read only this file' });
    const agent = f.agents.get(started.session_id);
    agent.session.events.push(
      { type: 'tool/call', seq: 0, time: 1, data: { callId: 'read', name: 'read', arguments: JSON.stringify({ file_path: file }) } },
      { type: 'tool/result', seq: 1, time: 2, data: { message: { source: { callId: 'read' }, content: [{ content: 'user-owned persistent release notes' }] } } },
    );
    f.goals.__setPhase(agent, 'complete');
    assert.equal((await f.bridge.stopGoal(agent.id)).already_stopped, true);
    assert.equal(existsSync(file), true);
    await f.bridge.stopGoal(agent.id);
    assert.equal(existsSync(file), true);
  } finally {
    assert.equal(realpathSync(home), home, 'verify exact newly created fixture before deletion');
    assert.equal(join(root, home.slice(root.length + 1)), home);
    assert.ok(home.startsWith(join(root, 'bridge-stop-preserves-')));
    rmSync(home, { recursive: true, force: true });
  }
});

test('a stale expected_revision on a cold session never quiesces the foreign writer', async () => {
  const f = fixture();
  const target = await f.bridge.startGoal({ workspace: 'a', goal: 'target' });
  await f.bridge.pauseGoal(target.session_id); // revision 2, paused, lock released
  f.agents.delete(target.session_id); // cold: the next start must re-load it
  const holder = await f.bridge.startGoal({ workspace: 'a', goal: 'holder' });
  const holderAgent = f.agents.get(holder.session_id);
  await rejectsCode(() => f.bridge.startGoal({
    workspace: 'a',
    session_id: target.session_id,
    goal: 'target',
    expected_revision: 1,
    workspace_lock_override: true,
  }), 'REVISION_CONFLICT');
  assert.equal(holderAgent.cancelCount, 0, 'stale CAS must not have quiesced the foreign writer');
  assert.equal(f.goals.get(holderAgent).phase, 'active');
  assert.equal(f.goals.get(holderAgent).activation, 'armed');
  assert.equal(f.bridge.workspaceGuard.getLock(f.workspaces[0].path).sessionId, holder.session_id);
});

test('a read_only hint after a bridge reload cannot downgrade a live mutable writer', async () => {
  const f = fixture();
  const writer = await f.bridge.startGoal({ workspace: 'a', goal: 'writer goal' });
  const restarted = f.makeBridge();
  const reuse = await restarted.startGoal({
    workspace: 'a',
    session_id: writer.session_id,
    goal: 'writer goal',
    read_only: true,
  });
  assert.equal(reuse.existing_goal_reused, true);
  await rejectsCode(() => restarted.startGoal({ workspace: 'a', goal: 'second goal' }), 'WORKSPACE_LOCKED');
  assert.equal(f.counts.created, 1, 'the original writer remains the sole occupant');
});

test('stop quiesces idle-status maintenance even when no native goal exists', async () => {
  const f = fixture();
  const agent = await blank(f);
  agent.status = 'idle';
  const idle = Promise.withResolvers();
  let maintenanceAborted = false;
  const cancelled = Promise.withResolvers();
  agent.cancel = function () { this.cancelCount++; maintenanceAborted = true; cancelled.resolve(); };
  agent.whenIdle = () => idle.promise;
  const stop = f.bridge.stopGoal(agent.id);
  await cancelled.promise;
  assert.equal(agent.cancelCount, 1, 'stop must cancel maintenance that hides behind public idle status');
  idle.resolve();
  const result = await stop;
  assert.equal(maintenanceAborted, true);
  assert.equal(result.already_stopped, true);
});

for (const explicitSession of [false, true]) {
  for (const read_only of [undefined, false]) {
    test(`completed audit cannot exempt replacement writer (explicit session=${explicitSession}, read_only=${read_only})`, async () => {
      const f = fixture();
      const writer = await f.bridge.startGoal({ workspace: 'a', goal: 'writer' });
      const audit = await f.bridge.startGoal({ workspace: 'a', goal: 'audit', read_only: true });
      const audited = f.agents.get(audit.session_id);
      f.goals.__setPhase(audited, 'complete'); // no intervening status/wait/stop read
      await rejectsCode(() => f.bridge.startGoal({ workspace: 'a', goal: 'new mutable work',
        ...(explicitSession ? { session_id: audit.session_id } : {}),
        ...(read_only === undefined ? {} : { read_only }),
      }), 'WORKSPACE_LOCKED');
      assert.equal(f.goals.get(audited).id, audit.goal.goal_id, 'denial must not replace the completed audit');
      assert.equal(f.goals.get(audited).phase, 'complete');
      assert.equal(f.goals.get(f.agents.get(writer.session_id)).activation, 'armed');
      assert.equal(f.bridge.workspaceGuard.getLock(f.workspaces[0].path).sessionId, writer.session_id);
    });
  }
}

test('free-workspace replacement of a completed audit acquires a mutable lock', async () => {
  const f = fixture();
  const audit = await f.bridge.startGoal({ workspace: 'a', goal: 'audit', read_only: true });
  f.goals.__setPhase(f.agents.get(audit.session_id), 'complete');
  const writer = await f.bridge.startGoal({ workspace: 'a', goal: 'new mutable work' });
  assert.equal(writer.session_id, audit.session_id);
  assert.notEqual(writer.goal.goal_id, audit.goal.goal_id);
  assert.equal(f.bridge.workspaceGuard.getLock(f.workspaces[0].path).sessionId, writer.session_id);
  assert.equal(f.bridge.readOnlySessions.has(writer.session_id), false);
  await rejectsCode(() => f.bridge.startGoal({ workspace: 'a', goal: 'another writer' }), 'WORKSPACE_LOCKED');
});

test('fresh audit uses a new session instead of reclassifying a completed one', async () => {
  const f = fixture();
  const writer = await f.bridge.startGoal({ workspace: 'a', goal: 'writer' });
  const first = await f.bridge.startGoal({ workspace: 'a', goal: 'audit', read_only: true });
  f.goals.__setPhase(f.agents.get(first.session_id), 'complete');
  const second = await f.bridge.startGoal({ workspace: 'a', goal: 'fresh audit', read_only: true });
  assert.notEqual(second.session_id, first.session_id);
  assert.equal(f.bridge.readOnlySessions.get(second.session_id), second.goal.goal_id);
  assert.equal(f.bridge.workspaceGuard.getLock(f.workspaces[0].path).sessionId, writer.session_id);
  await rejectsCode(() => f.bridge.startGoal({ workspace: 'a', goal: 'explicit replacement audit',
    session_id: first.session_id, read_only: true }), 'WORKSPACE_LOCKED');
});

test('same audit generation retains its hint across pause/read/resume', async () => {
  const f = fixture();
  const writer = await f.bridge.startGoal({ workspace: 'a', goal: 'writer' });
  const audit = await f.bridge.startGoal({ workspace: 'a', goal: 'audit', read_only: true });
  await f.bridge.pauseGoal(audit.session_id);
  await f.bridge.getTaskStatus(audit.session_id);
  const resumed = await f.bridge.resumeGoal(audit.session_id);
  assert.equal(resumed.goal.goal_id, audit.goal.goal_id);
  assert.equal(f.bridge.readOnlySessions.get(audit.session_id), audit.goal.goal_id);
  assert.equal(f.bridge.workspaceGuard.getLock(f.workspaces[0].path).sessionId, writer.session_id);
});

test('a host-replaced goal cannot hide behind the old audit classification', async () => {
  const f = fixture();
  const audit = await f.bridge.startGoal({ workspace: 'a', goal: 'audit', read_only: true });
  const agent = f.agents.get(audit.session_id);
  f.goals.__setPhase(agent, 'complete');
  f.goals.create(agent, { objective: 'host-created writer' });
  const other = await blank(f);
  await rejectsCode(() => f.bridge.sendMessage(other.id, 'competing writer'), 'WORKSPACE_LOCKED');
  assert.equal(f.bridge.readOnlySessions.has(agent.id), false);
});

function appendEvent(agent, type, data) {
  const events = agent.session.events;
  events.push({ type, seq: Math.max(-1, ...events.map(event => event.seq)) + 1, time: Date.now(), data });
}

function appendTool(agent, turn, callId, name, args, output) {
  appendEvent(agent, 'tool/call', { turn, callId, name, arguments: JSON.stringify(args) });
  appendEvent(agent, 'tool/result', { turn, message: { source: { callId }, content: [{ type: 'tool', isError: false, content: output }] } });
}

test('replacement goal result excludes old test/release/file/artifact evidence and foreign provenance', async () => {
  const f = fixture();
  const first = await f.bridge.startGoal({ workspace: 'a', goal: 'old release' });
  const agent = f.agents.get(first.session_id);
  const repository = 'https://github.com/owner/repo.git';
  const sha = 'a'.repeat(40);
  appendEvent(agent, 'turn/start', { turn: 1 });
  appendTool(agent, 1, 'old-test', 'bash', { command: 'npm test' }, 'Tests: 203 passed, 203 total');
  appendTool(agent, 1, 'old-push', 'bash', { command: `git push ${repository} ${sha}:refs/heads/main` }, 'ok');
  appendTool(agent, 1, 'old-readback', 'bash', { command: `git ls-remote ${repository} refs/heads/main` }, `${sha}\trefs/heads/main`);
  appendTool(agent, 1, 'old-write', 'write', { file_path: 'old.ts' }, 'ok');
  appendTool(agent, 1, 'old-pack', 'bash', { command: 'npm pack' }, 'npm notice filename: old-1.0.0.tgz');
  appendTool(agent, 1, 'old-commit', 'bash', { command: 'git commit -m old' }, '[main abcdef1] old');
  appendTool(agent, 1, 'old-tag', 'bash', { command: 'git tag v1.0.0' }, 'Created tag v1.0.0');
  appendEvent(agent, 'turn/end', { turn: 1, reason: { kind: 'completed' } });
  const oldResult = await f.bridge.getStructuredResult(agent.id);
  assert.equal(oldResult.tests.pass, 203);
  assert.equal(oldResult.remote.push_verified, true);
  assert.ok(oldResult.tests.evidence_ids.includes(`exec-${agent.id}:old-test`));
  f.goals.__setPhase(agent, 'complete');
  const second = await f.bridge.startGoal({ workspace: 'a', goal: 'entirely new work' });
  assert.equal(second.session_id, first.session_id);
  assert.notEqual(second.goal.goal_id, first.goal.goal_id);
  f.bridge.workspaceGuard.recordMutation(f.workspaces[0].path, { stepId: 'foreign-step', type: 'foreign-writer' });
  const current = await f.bridge.getStructuredResult(agent.id);
  assert.equal(current.goal.goal_id, second.goal.goal_id);
  assert.equal(current.goal.finished_at, undefined);
  assert.equal(current.tests.counts_known, false);
  assert.deepEqual(current.tests.evidence_ids, []);
  assert.deepEqual(current.changes.changed_files, []);
  assert.deepEqual(current.changes.commits, []);
  assert.deepEqual(current.changes.tags, []);
  assert.deepEqual(current.artifacts, []);
  assert.equal(current.remote.push_verified, false);
  assert.equal(current.remote.push_observed, false);
  assert.equal(current.provenance.originating_step, undefined);
  appendEvent(agent, 'turn/start', { turn: 2 });
  appendEvent(agent, 'turn/end', { turn: 2, reason: { kind: 'completed' } });
  const turn = await f.bridge.getResult(agent.id);
  assert.equal(turn.turn, 2);
  assert.deepEqual(turn.changed_files, []);
  assert.deepEqual(turn.result_schema.changes.changed_files, []);
  assert.deepEqual(turn.result_schema.tests.evidence_ids, []);
  assert.equal(turn.result_schema.tests.pass, 0);
  assert.equal(turn.result_schema.remote.push_verified, false);
});
