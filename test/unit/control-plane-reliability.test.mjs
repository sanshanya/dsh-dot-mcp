import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Bridge, BridgeError } from '../../lib/bridge.js';
import { makeGoalsService } from '../helpers/native-goals.mjs';

const MIX = {
  id: 'ws-1',
  title: 'mix_workspace',
  path: 'D:\\Agent\\agent_workplace\\mix_workspace',
  createdAt: 'x',
  updatedAt: 'x',
  sessionIds: [],
};

function makeLiveAgent(id, workspacePath, extras = {}) {
  const events = extras.events ?? [];
  const inbox = extras.inbox ?? { nextTurn: [], nextStep: [], hasPending: false };
  const agent = {
    id,
    status: extras.status ?? 'idle',
    inbox,
    session: {
      id,
      header: { id, createdAt: Date.now(), cwd: workspacePath },
      events,
      snapshotEvents: () => events,
      requestHeader: () => undefined,
    },
    followup(message) {
      agent.followupCount += 1;
      agent.status = extras.followupStatus ?? 'running';
      inbox.hasPending = true;
      inbox.nextTurn = inbox.nextTurn ?? [];
      inbox.nextTurn.push(message ?? { id: 'm' });
    },
    cancel() {
      agent.cancelCount += 1;
      agent.status = 'idle';
      inbox.hasPending = false;
      inbox.nextTurn = [];
      inbox.nextStep = [];
    },
    followupCount: 0,
    cancelCount: 0,
  };
  return agent;
}

function makeStatefulBridge(cfg = {}) {
  const agents = new Map();
  const created = [];
  const goals = makeGoalsService();
  const workspace = { ...MIX, attachSession: async () => {}, sessionIds: [] };
  const agentsApi = {
    get: (id) => agents.get(id),
    list: () => [...agents.values()],
    create: async ({ sessionId, meta }) => {
      created.push(sessionId);
      const agent = makeLiveAgent(sessionId, meta.cwd);
      agents.set(sessionId, agent);
      return { agent };
    },
    resume: async ({ resumeSessionId }) => {
      const existing = agents.get(resumeSessionId);
      if (existing) return { agent: existing };
      const agent = makeLiveAgent(resumeSessionId, MIX.path);
      agents.set(resumeSessionId, agent);
      return { agent };
    },
  };
  const services = {
    workspaceRegistry: { list: () => [workspace] },
    agents: agentsApi,
    sessions: { list: () => [...agents.values()].map((agent) => agent.session), get: (id) => agents.get(id)?.session },
    sessionPersistence: {
      list: async () => [...agents.values()].map((agent) => ({ header: agent.session.header })),
      inspect: async (id) => {
        const agent = agents.get(id);
        if (agent === undefined) throw new Error('missing');
        return { meta: agent.session.header, events: agent.session.events };
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    goals,
  };
  const ctx = {
    get: (key) => services[key],
    agents: services.agents,
    sessions: services.sessions,
    sessionPersistence: services.sessionPersistence,
    agentDefaultModel: services.agentDefaultModel,
    sessionTitle: { rename() {}, get: () => undefined },
    on: () => {},
  };
  const bridge = new Bridge(
    ctx,
    {
      sessionMaxItems: 5,
      sessionMaxChars: 200,
      resultMaxItems: 10,
      resultMaxChars: 500,
      ...cfg,
    },
    { debug() {}, info() {}, warn() {}, error() {} },
  );
  return { bridge, agents, created, goals };
}

async function waitForApproval(bridge, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (bridge['relays']['approvals'].size > 0) return [...bridge['relays']['approvals'].keys()][0];
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for parked approval');
}

function toolCall(seq, callId, command) {
  return {
    type: 'tool/call',
    seq,
    time: seq,
    data: { turn: 1, callId, name: 'bash', arguments: JSON.stringify({ command }) },
  };
}

function fileToolCall(seq, callId, name, args) {
  return {
    type: 'tool/call',
    seq,
    time: seq,
    data: { turn: 1, callId, name, arguments: JSON.stringify(args) },
  };
}

function toolResult(seq, callId, content, isError = false) {
  return {
    type: 'tool/result',
    seq,
    time: seq,
    data: { turn: 1, message: { source: { callId }, content: [{ type: 'tool', isError, content }] } },
  };
}

test('R1 / A01: identical Goal sent three times reuses one session and does not bump revision', async () => {
  const { bridge, created } = makeStatefulBridge();
  const input = { workspace: 'ws-1', goal: 'Run the full npm test suite' };
  const first = await bridge.startGoal(input);
  const second = await bridge.startGoal(input);
  const third = await bridge.startGoal(input);

  assert.equal(created.length, 1);
  assert.equal(second.session_id, first.session_id);
  assert.equal(third.session_id, first.session_id);
  assert.equal(second.existing_goal_reused, true);
  assert.equal(third.existing_goal_reused, true);
  assert.equal(second.revision_unchanged, true);
  assert.equal(third.revision_unchanged, true);
  assert.equal(first.goal?.revision ?? 1, 1);
  assert.equal(second.goal?.revision ?? 1, 1);
});

test('terminal identical goals replace in place on the same session (native)', async () => {
  const { bridge, agents, goals } = makeStatefulBridge();
  const input = { workspace: 'ws-1', goal: 'Run the full npm test suite' };
  const first = await bridge.startGoal(input);
  const agent = agents.get(first.session_id);
  goals.__setPhase(agent, 'complete'); // 宿主的回合驱动器已完成目标
  const second = await bridge.startGoal(input);
  assert.equal(second.session_id, first.session_id); // 原生：completed goal 可被同会话原地替换
  assert.equal(second.goal.revision, 1);
  assert.notEqual(second.goal.goal_id, first.goal.goal_id);
});

test('startGoal on a busy session states GOAL_ALREADY_EXISTS with native details', async () => {
  const { bridge } = makeStatefulBridge();
  const first = await bridge.startGoal({ workspace: 'ws-1', goal: 'Prepare release candidate 1' });
  await assert.rejects(
    () => bridge.startGoal({
      workspace: 'ws-1',
      session_id: first.session_id,
      goal: 'Prepare release candidate 2',
    }),
    (error) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'GOAL_ALREADY_EXISTS');
      assert.equal(error.details?.goal_id, first.goal.goal_id);
      return true;
    },
  );
  // 修改目标要走 revise/update，并由 revision CAS 守
  const revised = await bridge.reviseGoal({
    session_id: first.session_id,
    goal: 'Prepare release candidate 2',
    expected_revision: first.goal.revision,
  });
  assert.equal(revised.goal.revision, 2);
  await assert.rejects(
    () => bridge.reviseGoal({
      session_id: first.session_id,
      goal: 'Release candidate 3',
      expected_revision: 1, // 已过期的锁
    }),
    (error) => error.code === 'REVISION_CONFLICT',
  );
});

test('R4 / A07: second mutable Goal on the same workspace is locked without override', async () => {
  const { bridge, created } = makeStatefulBridge();
  const first = await bridge.startGoal({ workspace: 'ws-1', goal: 'Edit files and commit the fix' });
  assert.equal(created.length, 1);

  await assert.rejects(
    () => bridge.startGoal({ workspace: 'ws-1', goal: 'Publish a different release' }),
    (error) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'WORKSPACE_LOCKED');
      assert.equal(error.details?.status, 'waiting_for_workspace_lock');
      assert.equal(error.details?.holder_session_id, first.session_id);
      return true;
    },
  );
  assert.equal(created.length, 1);

  const audit = await bridge.startGoal({
    workspace: 'ws-1',
    goal: 'Audit git log and review the package manifest',
    read_only: true,
  });
  assert.notEqual(audit.session_id, first.session_id);

  const override = await bridge.startGoal({
    workspace: 'ws-1',
    goal: 'Take over and continue the release',
    workspace_lock_override: true,
  });
  assert.notEqual(override.session_id, first.session_id);
  assert.equal(bridge.workspaceGuard.getLock(MIX.path)?.sessionId, override.session_id);
});

test('R5 / A05 (simplified): reject and stop converge for parked approvals', async () => {
  // The platform-layer mux path (APPROVAL_UNREACHABLE) died with the tunnel
  // control plane; what remains worth pinning is that reject and stop still
  // converge a parked approval without it.
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'Publish package to npm registry' });
  const agent = agents.get(started.session_id);
  agent.session.events.push(toolCall(1, 'c-pub', 'npm publish'));

  const parked = bridge['relays'].decideApproval({ agent, toolName: 'bash', callId: 'c-pub', reason: 'publish' });
  const approvalId = await waitForApproval(bridge);
  assert.equal(bridge['relays']['approvals'].size, 1);

  const rejected = await bridge.approve(started.session_id, approvalId, 'reject');
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(bridge['relays']['approvals'].size, 0);
  assert.equal(await parked, 'rejected');

  const parkedAgain = bridge['relays'].decideApproval({ agent, toolName: 'bash', callId: 'c-pub-2' });
  await waitForApproval(bridge);
  const stopped = await bridge.stopGoal(started.session_id);
  assert.equal(stopped.stopped, true);
  assert.equal(bridge['relays']['approvals'].size, 0);
  assert.equal(await parkedAgain, 'cancelled');
});

test('snapshot-only sessions park every managed approval for the driver, paths included', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'Update one file' });
  const agent = agents.get(started.session_id);
  const events = agent.session.events;
  agent.session.snapshotEvents = () => events;
  delete agent.session.events;

  events.push(fileToolCall(1, 'c-inside', 'write', { file_path: 'src/inside.ts', content: 'x' }));
  const parkedInside = bridge['relays'].decideApproval({ agent, toolName: 'write', callId: 'c-inside' });
  const insideId = await waitForApproval(bridge);
  assert.ok(insideId, 'an in-workspace write parks like everything else (relay-only design)');

  events.push(fileToolCall(2, 'c-outside', 'write', { file_path: join('..', 'outside.ts'), content: 'x' }));
  const parkedOutside = bridge['relays'].decideApproval({ agent, toolName: 'write', callId: 'c-outside' });
  while (bridge['relays']['approvals'].size < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(bridge['relays']['approvals'].size, 2, 'inside and outside writes both park — no bridge-side verdict');

  assert.equal(await bridge.approve(started.session_id, insideId, 'approve').then((item) => item.outcome), 'allowed-once');
  assert.equal(await parkedInside, 'allowed-once');
  const outsideId = [...bridge['relays']['approvals'].keys()][0];
  assert.equal(await bridge.approve(started.session_id, outsideId, 'reject').then((item) => item.outcome), 'rejected');
  assert.equal(await parkedOutside, 'rejected');
});

test('R7 / A10: observed PASS is recorded as evidence; the relay still parks the rerun for the driver', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'Run the full npm test suite' });
  const agent = agents.get(started.session_id);
  agent.session.events.push(
    toolCall(1, 'c-test-1', 'npm test'),
    toolResult(2, 'c-test-1', '✔ pass 203\nℹ tests 203\nℹ fail 0'),
  );
  await bridge.getTaskStatus(started.session_id);
  const first = await bridge.getStructuredResult(started.session_id);
  assert.ok(first.tests.evidence_ids.includes(`exec-${started.session_id}:c-test-1`));

  agent.session.events.push(toolCall(3, 'c-test-2', 'npm test'));
  const decision = bridge['relays'].decideApproval({ agent, toolName: 'bash', callId: 'c-test-2' });
  const approvalId = await waitForApproval(bridge);
  assert.ok(approvalId, 'already-verified reruns are not auto-answered: the driver decides');
  await bridge.approve(started.session_id, approvalId, 'approve');
  assert.equal(await decision, 'allowed-once');
});

test('structured result evidence ids are derived strictly from the session\'s own events', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'Inspect current state' });
  const agent = agents.get(started.session_id);
  agent.session.events.push(
    toolCall(1, 'c-inspect-1', 'npm test'),
    toolResult(2, 'c-inspect-1', '✔ pass 10\nℹ tests 10\nℹ fail 0'),
  );
  const result = await bridge.getStructuredResult(started.session_id);
  assert.ok(result.tests.evidence_ids.length > 0);
  for (const id of result.tests.evidence_ids) {
    assert.ok(id.startsWith(`exec-${started.session_id}:`), `no foreign evidence: ${id}`);
  }
  // A fresh, empty session derives no evidence at all (no ledger to leak).
  const empty = await bridge.createSession('ws-1');
  const emptyResult = await bridge.getStructuredResult(empty.session_id);
  assert.deepEqual(emptyResult.tests.evidence_ids, []);
});

test('R8 / A11: observed publish is recorded as evidence; the relay still parks the replay for the driver', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'Publish package to npm registry' });
  const agent = agents.get(started.session_id);
  agent.session.events.push(
    toolCall(1, 'c-pub-1', 'npm publish'),
    toolResult(2, 'c-pub-1', 'probemux@0.1.0 published'),
  );
  await bridge.getTaskStatus(started.session_id);
  const first = await bridge.getStructuredResult(started.session_id);
  assert.ok(first.tests.evidence_ids.includes(`exec-${started.session_id}:c-pub-1`));

  agent.session.events.push(toolCall(3, 'c-pub-2', 'npm publish'));
  const decision = bridge['relays'].decideApproval({ agent, toolName: 'bash', callId: 'c-pub-2' });
  const approvalId = await waitForApproval(bridge);
  assert.ok(approvalId, 'already-applied replays are not auto-answered: the driver decides');
  await bridge.approve(started.session_id, approvalId, 'reject');
  assert.equal(await decision, 'rejected');
});

test('A11: a driver-approved publish records evidence independently from mutation provenance', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'Publish package to npm registry' });
  const agent = agents.get(started.session_id);
  agent.session.events.push(toolCall(1, 'c-pub-approved', 'npm publish'));
  const decision = bridge['relays'].decideApproval({ agent, toolName: 'bash', callId: 'c-pub-approved' });
  const approvalId = await waitForApproval(bridge);
  await bridge.approve(started.session_id, approvalId, 'approve');
  assert.equal(await decision, 'allowed-once');

  agent.session.events.push(toolResult(2, 'c-pub-approved', 'dsh-dot-mcp@0.7.0 published'));
  await bridge.getTaskStatus(started.session_id);
  const published = await bridge.getStructuredResult(started.session_id);
  assert.ok(published.tests.evidence_ids.includes(`exec-${started.session_id}:c-pub-approved`));

  agent.session.events.push(toolCall(3, 'c-pub-replay', 'npm publish'));
  const replay = bridge['relays'].decideApproval({ agent, toolName: 'bash', callId: 'c-pub-replay' });
  const replayId = await waitForApproval(bridge);
  assert.ok(replayId, 'evidence does not auto-answer the replay: it parks for the driver');
  await bridge.approve(started.session_id, replayId, 'reject');
  assert.equal(await replay, 'rejected');
});

test('R9 / A09: pause and resume drive the native goal phases', async () => {
  const { bridge } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'Long-lived build' });
  const paused = await bridge.pauseGoal(started.session_id);
  assert.equal(paused.goal.phase, 'paused');
  assert.equal(paused.goal.activation, 'disarmed');
  assert.equal(paused.goal.revision, 2);
  const resumed = await bridge.resumeGoal(started.session_id);
  assert.equal(resumed.goal.phase, 'active');
  assert.equal(resumed.goal.activation, 'armed');
  assert.equal(resumed.goal.revision, 3);
});


test('a parked approval reaches the wire with the command it is about (golden E2E defect 1)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'Publish the package' });
  const agent = agents.get(started.session_id);
  // The command is in the log BEFORE the approval fires — the shape the real
  // host produced (tool/call seq 20, approval/asked seq 21).
  agent.session.events.push(toolCall(1, 'c-publish', 'npm publish --access public'));
  const parked = bridge['relays'].decideApproval({ agent, toolName: 'bash', callId: 'c-publish' });
  const approvalId = await waitForApproval(bridge);

  const status = await bridge.getTaskStatus(started.session_id);
  const summary = status.waiting.approvals.find((item) => item.approval_id === approvalId);
  assert.ok(summary, 'the parked approval is on the wire');
  assert.equal(summary.command, 'npm publish --access public',
    'the driver must see the command it is judging — mining it and dropping it was write-only state');

  await bridge.approve(started.session_id, approvalId, 'reject');
  assert.equal(await parked, 'rejected');
});

test('one open ask is reported once, under both key spaces (golden E2E defect 2)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'Ask before writing' });
  const agent = agents.get(started.session_id);
  const question = { id: 'escalate', question: 'Wider access?', options: [{ label: 'Yes' }] };
  // The parked lane is keyed by the bridge's own id; the host callId is what
  // the event lane reports the same ask under. The dedupe must span both.
  bridge['relays']['questions'].set('question-abc12345', {
    id: 'question-abc12345', sessionId: started.session_id, callId: 'call-ask-1',
    questions: [question], resolve: () => {},
  });
  agent.session.events.push({
    type: 'tool/call', seq: 1, time: 1,
    data: { turn: 1, step: 1, callId: 'call-ask-1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [question] }) },
  });

  const status = await bridge.getTaskStatus(started.session_id);
  assert.equal(status.waiting.questions.length, 1,
    `one open ask, one report — got ${JSON.stringify(status.waiting.questions.map((item) => item.question_id))}`);
  assert.equal(status.waiting.questions[0].question_id, 'question-abc12345',
    'the answerable id stays the parked one (dsh_answer_question keys on it)');
  assert.equal(status.waiting.questions[0].call_id, 'call-ask-1', 'the host call id rides along for correlation');
  assert.equal(status.waiting.questions[0].source, 'parked', 'this row can be settled by dsh_answer_question');
});

test('a log-only ask is reported as such, and answering it fails closed', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'Ask before writing' });
  const agent = agents.get(started.session_id);
  const question = { id: 'escalate', question: 'Wider access?', options: [{ label: 'Yes' }] };
  // The log signal lands BEFORE the bridge parks the ask (and outlives a bridge
  // restart): the row must say so, instead of offering an id that no pending
  // backs — a driver that answers it gets QUESTION_NOT_FOUND.
  agent.session.events.push({
    type: 'tool/call', seq: 2, time: 2,
    data: { turn: 1, step: 1, callId: 'call-ask-logonly', name: 'ask_user_question', arguments: JSON.stringify({ questions: [question] }) },
  });

  const status = await bridge.getTaskStatus(started.session_id);
  assert.equal(status.waiting.questions.length, 1);
  assert.equal(status.waiting.questions[0].question_id, 'call-ask-logonly');
  assert.equal(status.waiting.questions[0].source, 'log', 'not answerable: no live pending backs this row');
  await assert.rejects(
    () => bridge.answerQuestion('call-ask-logonly', started.session_id, { selected: ['Yes'] }),
    (error) => {
      assert.equal(error.code, 'QUESTION_NOT_FOUND');
      return true;
    },
  );
});

test('a legacy ask with no wait.callId is still recognised by the lane that logged it (golden E2E defect 1)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'Ask before writing' });
  const agent = agents.get(started.session_id);
  const questions = [{ id: 'escalate', question: 'Wider access?', options: [{ label: 'Yes' }] }];
  // Legacy host shape: the request carries questions and the agent, and nothing
  // else — no `wait`. The open tool/call in the log is the only call id there is.
  agent.session.events.push({
    type: 'tool/call', seq: 4, time: 4,
    data: { turn: 1, step: 1, callId: 'call-ask-legacy', name: 'ask_user_question', arguments: JSON.stringify({ questions }) },
  });

  const parked = bridge['relays'].decideQuestion({ questions, agent }, async () => ({ answers: [] }));
  const status = await bridge.getTaskStatus(started.session_id);
  assert.equal(status.waiting.questions.length, 1,
    `one open ask, one report — got ${JSON.stringify(status.waiting.questions.map((item) => item.question_id))}`);
  assert.equal(status.waiting.questions[0].call_id, 'call-ask-legacy',
    'without the mined call id the parked lane and the event lane report the same ask twice');

  const answer = await bridge.answerQuestion(status.waiting.questions[0].question_id, started.session_id, { selected: ['Yes'] });
  assert.equal(answer.remaining_questions, 0);
  assert.deepEqual(await parked, { answers: [{ id: 'escalate', selected: ['Yes'] }] });
});

test('the autoApproveEscalations switch is reported on the health wire', async () => {
  const off = await makeStatefulBridge().bridge.health();
  assert.equal(off.capabilities.autoApproveEscalations, false, 'default posture: escalations park for a decision');
  const on = await makeStatefulBridge({ autoApproveEscalations: true }).bridge.health();
  assert.equal(on.capabilities.autoApproveEscalations, true,
    'a driver must be able to see that asks are granted rather than parked');
});
