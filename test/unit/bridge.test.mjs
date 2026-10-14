import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Bridge, BridgeError } from '../../lib/bridge.js';
import { normalizePath } from '../../lib/paths.js';
import { makeGoalsService } from '../helpers/native-goals.mjs';

// A minimal fake workspace registry with one registered workspace.
function makeRegistry(workspaces) {
  return {
    list: () => workspaces,
  };
}

const MIX = { id: 'ws-1', title: 'mix_workspace', path: 'D:\\Agent\\agent_workplace\\mix_workspace', createdAt: 'x', updatedAt: 'x', sessionIds: [] };
const OTHER = { id: 'ws-2', title: 'other', path: 'D:\\Other\\place', createdAt: 'x', updatedAt: 'x', sessionIds: [] };

function makeBridge({ registry, agents, sessions, persistence, on, userQuestions, title, goals } = {}) {
  const services = {
    workspaceRegistry: registry,
    agents: agents ?? { get: () => undefined, list: () => [] },
    sessions: sessions ?? { list: () => [], get: () => undefined },
    sessionPersistence: persistence ?? { list: async () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    goals: goals ?? makeGoalsService(),
  };
  const ctx = {
    get: (key) => services[key],
    agents: services.agents,
    sessions: services.sessions,
    sessionPersistence: services.sessionPersistence,
    agentDefaultModel: services.agentDefaultModel,
    sessionTitle: title,
    on: on ?? (() => {}),
  };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  return new Bridge(ctx, { sessionMaxItems: 5, sessionMaxChars: 200, resultMaxItems: 10, resultMaxChars: 500 }, log);
}

test('resolveWorkspace: accepts id, canonical path, and title (Case 5 boundary)', async () => {
  const bridge = makeBridge({ registry: makeRegistry([MIX, OTHER]) });
  assert.equal((await bridge.resolveWorkspace('ws-1')).path, MIX.path);
  assert.equal((await bridge.resolveWorkspace(MIX.path)).id, 'ws-1');
  assert.equal((await bridge.resolveWorkspace('mix_workspace')).id, 'ws-1');
});

test('resolveWorkspace: rejects unregistered paths (Case 5)', async () => {
  const bridge = makeBridge({ registry: makeRegistry([MIX]) });
  for (const input of ['D:\\Users\\nobody\\secret', 'C:\\Windows', '/', 'D:\\', '~']) {
    await assert.rejects(() => bridge.resolveWorkspace(input), (error) => {
      assert.ok(error instanceof BridgeError);
      assert.equal(error.code, 'WORKSPACE_NOT_FOUND');
      return true;
    });
  }
});

test('resolveWorkspace: trailing slash and win32 case use the shared compare rule', async () => {
  const bridge = makeBridge({ registry: makeRegistry([MIX, OTHER]) });
  const trailing = MIX.path.endsWith('\\') || MIX.path.endsWith('/') ? MIX.path : `${MIX.path}\\`;
  assert.equal((await bridge.resolveWorkspace(trailing)).id, 'ws-1');
  if (process.platform === 'win32') {
    assert.equal((await bridge.resolveWorkspace(MIX.path.toLowerCase())).id, 'ws-1');
    assert.equal(normalizePath(trailing), normalizePath(MIX.path.toLowerCase()));
  } else {
    assert.equal(normalizePath(trailing), normalizePath(MIX.path));
  }
});

test('listSessions workspace filter uses the same path compare as resolveWorkspace', async () => {
  const { bridge } = makeStatefulBridge();
  const created = await bridge.createSession('ws-1', 'demo');
  const trailing = `${MIX.path}\\`;
  const listed = await bridge.listSessions({ workspace: trailing });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].session_id, created.session_id);
});

test('Bridge.start effect disposer cancels parked approvals and questions', async () => {
  const disposers = [];
  const services = {
    workspaceRegistry: makeRegistry([MIX]),
    agents: { get: () => undefined, list: () => [] },
    sessions: { list: () => [], get: () => undefined },
    sessionPersistence: { list: async () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
  };
  const ctx = {
    get: (key) => services[key],
    agents: services.agents,
    sessions: services.sessions,
    sessionPersistence: services.sessionPersistence,
    agentDefaultModel: services.agentDefaultModel,
    on: () => () => true,
    inject: () => ({}),
    effect: (execute) => {
      const disposer = execute();
      disposers.push(disposer);
      return disposer;
    },
  };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  const bridge = new Bridge(ctx, { sessionMaxItems: 5, sessionMaxChars: 200, resultMaxItems: 10, resultMaxChars: 500 }, log);
  bridge.start();
  assert.ok(disposers.length >= 1);
  let approval;
  bridge['relays']['approvals'].set('approval-1', {
    id: 'approval-1', sessionId: 'session-a', toolName: 'bash',
    resolve: (outcome) => { approval = outcome; },
  });
  let question;
  bridge['relays']['questions'].set('question-1', {
    id: 'question-1', sessionId: 'session-a', questions: [],
    resolve: (answer) => { question = answer; },
  });
  await disposers[disposers.length - 1]();
  assert.equal(approval, 'cancelled');
  assert.deepEqual(question, { answers: [] });
  assert.equal(bridge['relays']['approvals'].size, 0);
  assert.equal(bridge['relays']['questions'].size, 0);
});

test('resolveWorkspace: rejects when no registry is mounted', async () => {
  const bridge = makeBridge({});
  await assert.rejects(() => bridge.resolveWorkspace('anything'), (error) => {
    assert.equal(error.code, 'WORKSPACE_REGISTRY_UNAVAILABLE');
    return true;
  });
});

test('approve: rejects unknown approval ids', async () => {
  const bridge = makeBridge({});
  await assert.rejects(() => bridge.approve('session-1', 'approval-nope', 'approve'), (error) => {
    assert.equal(error.code, 'APPROVAL_NOT_FOUND');
    return true;
  });
});

test('approve: rejects session mismatch', async () => {
  const bridge = makeBridge({});
  const settled = { resolve: () => {} };
  bridge['relays']['approvals'].set('approval-1', { id: 'approval-1', sessionId: 'session-a', toolName: 't', resolve: (o) => settled.resolve(o) });
  await assert.rejects(() => bridge.approve('session-b', 'approval-1', 'approve'), (error) => {
    assert.equal(error.code, 'APPROVAL_SESSION_MISMATCH');
    return true;
  });
});

test('answerQuestion: rejects unknown question ids and invalid selections', async () => {
  const bridge = makeBridge({});
  await assert.rejects(() => bridge.answerQuestion('question-9', undefined, { selected: [] }), (error) => {
    assert.equal(error.code, 'QUESTION_NOT_FOUND');
    return true;
  });
  bridge['relays']['questions'].set('question-1', {
    id: 'question-1', sessionId: 'session-a',
    questions: [{ id: 'inner-1', question: 'pick', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }],
    resolve: () => {},
  });
  await assert.rejects(() => bridge.answerQuestion('question-1', undefined, { selected: ['Z'] }), (error) => {
    assert.equal(error.code, 'INVALID_ANSWER');
    return true;
  });
  await assert.rejects(() => bridge.answerQuestion('question-1', undefined, { selected: ['A', 'B'] }), (error) => {
    assert.equal(error.code, 'INVALID_ANSWER');
    return true;
  });
});

test('answerQuestion: resolves with the offered option', async () => {
  const bridge = makeBridge({});
  let resolved;
  bridge['relays']['questions'].set('question-1', {
    id: 'question-1', sessionId: 'session-a',
    questions: [{ id: 'inner-1', question: 'pick', options: [{ label: 'A' }], multiSelect: false }],
    resolve: (answer) => { resolved = answer; },
  });
  const out = await bridge.answerQuestion('question-1', 'session-a', { selected: ['A'] });
  assert.deepEqual(out, { answered: true, remaining_questions: 0 });
  assert.deepEqual(resolved.answers, [{ id: 'inner-1', selected: ['A'] }]);
});

test('cancelTask: only live sessions can be cancelled', async () => {
  const bridge = makeBridge({ agents: { get: () => undefined } });
  await assert.rejects(() => bridge.cancelTask('session-1'), (error) => {
    assert.equal(error.code, 'SESSION_NOT_LIVE');
    return true;
  });
});

test('sendMessage: empty message rejected', async () => {
  const bridge = makeBridge({});
  await assert.rejects(() => bridge.sendMessage('session-1', '   '), (error) => {
    assert.equal(error.code, 'EMPTY_MESSAGE');
    return true;
  });
});

test('sendMessage: unknown session rejected', async () => {
  const bridge = makeBridge({ persistence: { open: async () => { throw new Error('nope'); } } });
  await assert.rejects(() => bridge.sendMessage('session-unknown', 'hello'), (error) => {
    assert.equal(error.code, 'SESSION_NOT_FOUND');
    return true;
  });
});

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
      agent.lastFollowup = message;
      agent.status = extras.followupStatus ?? 'running';
      inbox.hasPending = true;
      inbox.nextTurn = inbox.nextTurn ?? [];
      inbox.nextTurn.push({ id: 'm' });
    },
    cancel() {
      agent.status = 'idle';
      inbox.hasPending = false;
      inbox.nextTurn = [];
      inbox.nextStep = [];
      events.push({ type: 'turn/end', seq: events.length, time: Date.now(), data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } });
    },
  };
  return agent;
}

function makeStatefulBridge() {
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
  const persistence = {
    // Pinned host shape (dsh-session-persistence): rows are snapshots, not bare headers.
    list: async () => [...agents.values()].map((agent) => ({ header: agent.session.header })),
    inspect: async (id) => {
      const agent = agents.get(id);
      if (agent === undefined) throw new Error('missing');
      return { meta: agent.session.header, events: agent.session.events };
    },
  };
  const title = { rename() {}, get: () => undefined };
  const bridge = makeBridge({
    registry: makeRegistry([workspace]),
    agents: agentsApi,
    sessions: { list: () => [...agents.values()].map((agent) => agent.session), get: (id) => agents.get(id)?.session },
    persistence,
    title,
    goals,
  });
  return { bridge, agents, created, workspace, goals };
}

test('createSession uses agents.create + attachSession (Case 1 path)', async () => {
  const { bridge, created, workspace } = makeStatefulBridge();
  let attached;
  workspace.attachSession = async (id) => { attached = id; };
  const view = await bridge.createSession('ws-1', 'demo');
  assert.equal(created.length, 1);
  assert.equal(view.session_id, created[0]);
  assert.equal(attached, created[0]);
  assert.match(view.session_id, /^session-/);
});

test('startGoal returns continuation to dsh_wait_goal (Case 2)', async () => {
  const { bridge } = makeStatefulBridge();
  const out = await bridge.startGoal({ workspace: 'ws-1', goal: 'three-step optimize' });
  assert.equal(out.continuation_required, true); // armed active goal keeps rounds driving
  assert.equal(out.next_tool_call.tool, 'dsh_wait_goal');
  assert.equal(out.next_tool_call.arguments.session_id, out.session_id);
  assert.equal(out.goal.phase, 'active');
  assert.equal(out.goal.revision, 1);
  assert.equal(out.goal.objective, 'three-step optimize');
});

test('startGoal request_id is idempotent and conflicts on different args', async () => {
  const { bridge, created } = makeStatefulBridge();
  const first = await bridge.startGoal({ workspace: 'ws-1', goal: 'g', request_id: 'req-1' });
  const retry = await bridge.startGoal({ workspace: 'ws-1', goal: 'g', request_id: 'req-1' });
  assert.equal(retry.session_id, first.session_id);
  assert.equal(created.length, 1);
  await assert.rejects(
    () => bridge.startGoal({ workspace: 'ws-1', goal: 'other', request_id: 'req-1' }),
    (error) => error.code === 'REQUEST_ID_CONFLICT',
  );
  assert.equal(created.length, 1);
});

test('waitGoal still-running returns after bound with continuation (Case 3)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  const agent = agents.get(started.session_id);
  agent.status = 'running';
  agent.inbox.hasPending = false;
  let t = 0;
  bridge.now = () => t;
  bridge.sleep = async (ms) => { t += ms; };
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.continuation_required, true);
  assert.equal(waited.goal_outcome, 'timeout');
  assert.ok(waited.waited_ms >= 1000);
  assert.equal(waited.next_tool_call.tool, 'dsh_wait_goal');
});

test('waitGoal ends when the goal completes natively (Case 4)', async () => {
  const { bridge, agents, goals } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  const agent = agents.get(started.session_id);
  agent.status = 'idle';
  agent.inbox.hasPending = false;
  agent.inbox.nextTurn = [];
  agent.session.events.push(
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'assistant/message', seq: 1, time: 2, data: { turn: 1, step: 0, message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] } } },
    { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
  );
  goals.__setPhase(agent, 'complete'); // the round driver marks the goal done
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.goal_outcome, 'ended');
  assert.equal(waited.goal.phase, 'complete');
  assert.equal(waited.continuation_required, false);
  assert.equal(waited.status, 'completed');
});

test('waitGoal approval does not auto-approve (Case 5)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  let granted;
  bridge['relays']['approvals'].set('approval-1', {
    id: 'approval-1', sessionId: started.session_id, toolName: 'bash',
    resolve: (outcome) => { granted = outcome; },
  });
  agents.get(started.session_id).status = 'running';
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.status, 'waiting_for_approval');
  assert.equal(waited.continuation_required, false);
  assert.equal(waited.approval.approval_id, 'approval-1');
  // A#5 single-owner pin: parked human action reports action_required on
  // dsh_wait_goal too — the fields agree instead of contradicting.
  assert.equal(waited.goal_outcome, 'action_required');
  assert.equal(granted, undefined);
});

test('waitGoal question does not auto-answer (Case 6)', async () => {
  const { bridge } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  let answered;
  bridge['relays']['questions'].set('question-1', {
    id: 'question-1', sessionId: started.session_id,
    questions: [{ id: 'inner', question: 'pick', options: [{ label: 'A' }], multiSelect: false }],
    resolve: (answer) => { answered = answer; },
  });
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.status, 'waiting_for_user');
  assert.equal(waited.continuation_required, false);
  assert.equal(waited.question.question_id, 'question-1');
  assert.equal(answered, undefined);
});

test('approve then waitGoal can continue (Case 7)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  let outcome;
  bridge['relays']['approvals'].set('approval-1', {
    id: 'approval-1', sessionId: started.session_id, toolName: 'bash',
    resolve: (value) => { outcome = value; },
  });
  await bridge.approve(started.session_id, 'approval-1', 'approve');
  assert.equal(outcome, 'allowed-once');
  const agent = agents.get(started.session_id);
  agent.status = 'running';
  agent.inbox.hasPending = false;
  let t = 0;
  bridge.now = () => t;
  bridge.sleep = async (ms) => { t += ms; };
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.notEqual(waited.status, 'waiting_for_approval');
});

test('answerQuestion then waitGoal can continue (Case 8)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  bridge['relays']['questions'].set('question-1', {
    id: 'question-1', sessionId: started.session_id,
    questions: [{ id: 'inner', question: 'pick', options: [{ label: 'A' }], multiSelect: false }],
    resolve: () => {},
  });
  await bridge.answerQuestion('question-1', started.session_id, { selected: ['A'] });
  const agent = agents.get(started.session_id);
  agent.status = 'running';
  agent.inbox.hasPending = false;
  let t = 0;
  bridge.now = () => t;
  bridge.sleep = async (ms) => { t += ms; };
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.notEqual(waited.status, 'waiting_for_user');
});

test('stopGoal cancels a running goal (Case 9)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  agents.get(started.session_id).status = 'running';
  const stopped = await bridge.stopGoal(started.session_id);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.already_stopped, false);
  assert.equal(stopped.status, 'cancelled');
});

test('stopGoal while waiting approval fails closed (Case 10)', async () => {
  const { bridge } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  let outcome;
  bridge['relays']['approvals'].set('approval-1', {
    id: 'approval-1', sessionId: started.session_id, toolName: 'bash',
    resolve: (value) => { outcome = value; },
  });
  const stopped = await bridge.stopGoal(started.session_id);
  assert.equal(stopped.status, 'cancelled');
  assert.equal(outcome, 'cancelled');
  assert.equal(bridge['relays']['approvals'].has('approval-1'), false);
});

test('stopGoal while waiting for user fails closed and is idempotent (waiting_for_user)', async () => {
  const { bridge } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  let answered;
  bridge['relays']['questions'].set('question-1', {
    id: 'question-1', sessionId: started.session_id,
    questions: [{ id: 'inner', question: 'pick', options: [{ label: 'A' }], multiSelect: false }],
    resolve: (answer) => { answered = answer; },
  });
  const stopped = await bridge.stopGoal(started.session_id);
  assert.equal(stopped.stopped, true);
  assert.equal(stopped.already_stopped, false);
  assert.equal(stopped.status, 'cancelled');
  assert.deepEqual(answered, { answers: [] });
  assert.equal(bridge['relays']['questions'].has('question-1'), false);
  const again = await bridge.stopGoal(started.session_id);
  assert.equal(again.stopped, true);
  assert.equal(again.already_stopped, true);
});

test('stopGoal twice is idempotent (Case 11)', async () => {
  const { bridge, agents } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  agents.get(started.session_id).status = 'running';
  await bridge.stopGoal(started.session_id);
  const again = await bridge.stopGoal(started.session_id);
  assert.equal(again.stopped, true);
  assert.equal(again.already_stopped, true);
});

test('waitGoal on a session with no goal reports no_goal (Case 12)', async () => {
  const { bridge, agents, goals } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  const agent = agents.get(started.session_id);
  agent.status = 'idle';
  agent.inbox.hasPending = false;
  agent.inbox.nextTurn = [];
  agent.session.events.push(
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
  );
  goals.clear(agent, { id: started.goal.goal_id, revision: started.goal.revision }); // goal cleared
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.goal_outcome, 'no_goal');
  assert.equal(waited.status, 'completed');
});

test('startGoal sessions stay isolated (Case 13)', async () => {
  const { bridge, agents, goals } = makeStatefulBridge();
  const a = await bridge.startGoal({ workspace: 'ws-1', goal: 'A' });
  const b = await bridge.startGoal({ workspace: 'ws-1', goal: 'B', workspace_lock_override: true });
  assert.notEqual(a.session_id, b.session_id);
  agents.get(a.session_id).status = 'running';
  await bridge.stopGoal(a.session_id);
  assert.equal(goals.get(agents.get(a.session_id)), undefined);
  assert.notEqual(goals.get(agents.get(b.session_id)), undefined);
});

test('idle wait with an ended goal has no continuation', async () => {
  const { bridge, agents, goals } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  const agent = agents.get(started.session_id);
  agent.status = 'idle';
  agent.inbox.hasPending = false;
  agent.inbox.nextTurn = [];
  goals.__setPhase(agent, 'complete');
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.continuation_required, false);
  assert.ok(waited.status === 'idle' || waited.status === 'unknown');
});

const ev = (type, data, seq) => ({ type, seq, time: seq, data });
const bashCall = (seq, callId, command) =>
  ev('tool/call', { turn: 1, step: 1, callId, name: 'bash', arguments: JSON.stringify({ command }) }, seq);
const bashResult = (seq, callId, { isError = false, content = 'ok', code } = {}) =>
  ev('tool/result', {
    turn: 1,
    step: 1,
    message: { source: { callId }, content: [{ type: 'tool', isError, content }] },
    ...(code === undefined ? {} : { error: { name: 'ToolError', code } }),
  }, seq);

function settle(agent) {
  agent.status = 'idle';
  agent.inbox.hasPending = false;
  agent.inbox.nextTurn = [];
}

test('MCP surface exposes 21 dsh_* tools (v0.5.0 Control Plane Reliability)', async () => {
  const src = await import('node:fs');
  // The declaration table owns the count; `mcp.ts` only builds the server now.
  const text = src.readFileSync(new URL('../../src/tools.ts', import.meta.url), 'utf8');
  const count = [...text.matchAll(/server\.registerTool\(/g)].length;
  assert.equal(count, 21);
  const surface = src.readFileSync(new URL('../../src/mcp.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(surface, /server\.registerTool\(/, 'declarations belong in tools.ts');
  assert.match(text, /dsh_update_goal/);
  assert.match(text, /dsh_create_goal/);
  assert.match(text, /dsh_revise_goal/);
});

test('Test A — session todos survive natively after a successful push', async () => {
  const { bridge, agents, goals } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'ship' });
  const agent = agents.get(started.session_id);
  settle(agent);
  agent.session.events.push(
    ev('turn/start', { turn: 1 }, 0),
    ev('todo/write', { todos: [{ content: 'C12 push release commit', status: 'completed' }] }, 1),
    bashCall(3, 'c1', 'git push origin main'),
    bashResult(4, 'c1'),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 5),
  );
  const session = await bridge.getSession(started.session_id);
  assert.equal(session.todos.find((todo) => todo.content.includes('push')).status, 'completed');
  const status = await bridge.getTaskStatus(started.session_id);
  assert.equal(status.todos.find((todo) => todo.content.includes('push')).status, 'completed');
  // goal 的存活由宿主服务语义决定，桥只做透传
  goals.__setPhase(agent, 'complete');
  const waited = await bridge.waitGoal(started.session_id, 1);
  assert.equal(waited.goal_outcome, 'ended');
});

test('Test 1/2 — start then revise edits the native goal in place', async () => {
  const { bridge } = makeStatefulBridge();
  const started = await bridge.startGoal({
    workspace: 'ws-1',
    goal: 'publish v0.3.0:\n- npm publish\n- GitHub Release',
    plan: 'tag then fork',
  });
  assert.equal(started.goal.revision, 1);

  const revised = await bridge.updateGoal({
    session_id: started.session_id,
    action: 'revise',
    goal: 'npm 暂缓，其他继续',
  });
  assert.equal(revised.session_id, started.session_id);
  assert.equal(revised.goal.goal_id, started.goal.goal_id);
  assert.equal(revised.goal.revision, 2);
  assert.equal(revised.goal.objective, 'npm 暂缓，其他继续');

  // revision CAS：旧 revision 的再来一次必须炸
  await assert.rejects(
    () => bridge.updateGoal({
      session_id: started.session_id,
      action: 'revise',
      goal: '再改',
      expected_revision: 1,
    }),
    (error) => error.code === 'REVISION_CONFLICT',
  );
});

test('updateGoal resume without a goal does not create one', async () => {
  const { bridge } = makeStatefulBridge();
  const created = await bridge.createSession('ws-1', 'bare');
  await assert.rejects(
    () => bridge.updateGoal({ session_id: created.session_id, action: 'resume' }),
    (error) => {
      assert.equal(error.code, 'GOAL_NOT_FOUND');
      return true;
    },
  );
});

test('approve / answer do not increment revision', async () => {
  const { bridge } = makeStatefulBridge();
  const started = await bridge.startGoal({ workspace: 'ws-1', goal: 'g' });
  assert.equal(started.goal.revision, 1);
  bridge['relays']['approvals'].set('approval-1', {
    id: 'approval-1', sessionId: started.session_id, toolName: 'bash', resolve: () => {},
  });
  await bridge.approve(started.session_id, 'approval-1', 'approve');
  const status = await bridge.getTaskStatus(started.session_id);
  assert.equal(status.goal.revision, 1);
});

