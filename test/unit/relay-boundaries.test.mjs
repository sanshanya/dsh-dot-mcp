import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { Context } from '@deepseek-ai/cordis';
import ApprovalService from '@deepseek-ai/dsh-user-approval';
import { AskRelay } from '../../lib/ask-relay.js';

const silentLog = { debug() {}, info() {}, warn() {}, error() {} };
const ev = (type, data, seq = 0) => ({ type, data, seq, time: 0 });
const tick = () => new Promise((resolve) => setImmediate(resolve));
const listeners = (signal) => getEventListeners(signal, 'abort').length;
const noAnswers = async () => ({ answers: [] });

function relayFor(overrides = {}) {
  return new AskRelay({
    isManaged: () => true,
    hostCanAnswer: () => false,
    autoApproveEscalations: () => false,
    ...overrides,
  }, silentLog);
}

/** In-memory audit only: no persistence, homes, workspaces, or credentials. */
function agentFor(id, seed = []) {
  const events = [ev('turn/start', {}), ...seed];
  const session = {
    events,
    get seq() { return events.length; },
    eventAt: (seq) => events[seq],
    snapshotEvents: () => [...events],
    append(type, data) {
      const event = ev(type, data, events.length);
      events.push(event);
      return event;
    },
  };
  return { id, session };
}

async function nativeRelay(t) {
  const ctx = new Context();
  await ctx.plugin(ApprovalService);
  const relay = relayFor();
  relay.start(ctx);
  t.after(async () => {
    relay.clear();
    await ctx.fiber.dispose();
  });
  return { ctx, relay };
}

function assertEmpty(relay) {
  assert.equal(relay.approvals.size, 0);
  assert.equal(relay.questions.size, 0);
  assert.equal(relay.questionBatches.size, 0);
}

function question(id) {
  return { id, question: `Choose ${id}`, options: [{ label: 'Yes' }, { label: 'No' }] };
}

for (const callId of ['call-native', undefined]) {
  for (const reason of ['requested escalation', undefined]) {
    test(`native audit + parked approval is one answerable ask (${callId ?? 'no callId'}, ${reason ?? 'no reason'})`, { timeout: 5000 }, async (t) => {
      const { ctx, relay } = await nativeRelay(t);
      const controller = new AbortController();
      const agent = agentFor('session-native', callId === undefined ? [] : [
        ev('tool/call', { name: 'bash', callId, arguments: JSON.stringify({ command: 'printf relay-test' }) }),
      ]);
      const asking = ctx.approval.request({
        agent, toolName: 'bash', signal: controller.signal,
        ...(callId === undefined ? {} : { callId }),
        ...(reason === undefined ? {} : { reason }),
      });
      await tick();

      const nativeId = agent.session.events.find((event) => event.type === 'approval/asked').data.id;
      const waiting = relay.waitingFor(agent.id, agent.session.events).approvals;
      assert.equal(waiting.length, 1, 'the host UUID is not a second unanswerable ask');
      const [pending] = waiting;
      assert.equal(pending.source, 'parked');
      assert.match(pending.approval_id, /^approval-/);
      assert.notEqual(pending.approval_id, nativeId, 'existing answerable bridge ID contract stays intact');
      assert.equal(pending.call_id, callId);
      assert.equal(pending.reason, reason);
      if (callId !== undefined) assert.equal(pending.command, 'printf relay-test');
      await assert.rejects(() => relay.approve(agent.id, nativeId, 'approve'), { code: 'APPROVAL_NOT_FOUND' });
      const receipt = await relay.approve(agent.id, pending.approval_id, 'approve');
      assert.equal(receipt.approval_id, pending.approval_id);
      assert.equal(await asking, 'allowed-once');
      assert.deepEqual(relay.waitingFor(agent.id, agent.session.events).approvals, []);
      assert.equal(listeners(controller.signal), 0, 'host and relay both release their abort listeners');
      assertEmpty(relay);
    });
  }
}

test('a true log-only approval is visible, marked unanswerable, and still carries its command', async () => {
  const relay = relayFor();
  const events = [
    ev('tool/call', { name: 'bash', callId: 'call-log', arguments: JSON.stringify({ command: 'printf log-only' }) }),
    ev('approval/asked', { id: 'native-open', toolName: 'bash', callId: 'call-log', reason: 'host-owned' }),
    ev('approval/asked', { id: 'native-closed', toolName: 'write' }),
    ev('approval/decided', { id: 'native-closed', outcome: 'rejected' }),
  ];
  assert.deepEqual(relay.waitingFor('session-log', events).approvals, [{
    approval_id: 'native-open', source: 'log', session_id: 'session-log',
    tool_name: 'bash', call_id: 'call-log', reason: 'host-owned', command: 'printf log-only',
  }]);
  await assert.rejects(() => relay.approve('session-log', 'native-open', 'approve'), { code: 'APPROVAL_NOT_FOUND' });
  assertEmpty(relay);
});

for (const callId of ['call-exact', undefined]) {
  test(`approval correlation does not hide unrelated request identities (${callId ?? 'no callId'})`, async (t) => {
    const relay = relayFor();
    t.after(() => relay.clear());
    const request = { toolName: 'bash', reason: 'exact reason', ...(callId === undefined ? {} : { callId }) };
    const unrelated = [
      { id: 'different-call', ...request, callId: 'other-call' },
      { id: 'different-tool', ...request, toolName: 'write' },
      { id: 'different-reason', ...request, reason: 'other reason' },
      { id: 'absent-reason', toolName: 'bash', ...(callId === undefined ? {} : { callId }) },
      { id: 'empty-reason', ...request, reason: '' },
      { id: 'near-reason', ...request, reason: 'exact reason ' },
      ...(callId === undefined ? [] : [{ id: 'absent-call', toolName: 'bash', reason: 'exact reason' }]),
    ];
    const agent = agentFor('session-exact', [
      ev('approval/asked', { id: 'native-match', ...request }),
      ...unrelated.map((data) => ev('approval/asked', data)),
    ]);
    const asking = relay.decideApproval({ agent, ...request });
    const waiting = relay.waitingFor(agent.id, agent.session.events).approvals;
    assert.equal(waiting.filter((item) => item.source === 'parked').length, 1);
    assert.deepEqual(waiting.filter((item) => item.source === 'log').map((item) => item.approval_id), unrelated.map((item) => item.id));
    relay.failClosed(agent.id);
    assert.equal(await asking, 'cancelled');
    assertEmpty(relay);
  });
}

test('late audit availability correlates by request, without consuming two records for an exact ID match', async (t) => {
  const relay = relayFor();
  t.after(() => relay.clear());
  const agent = agentFor('session-late-log');
  const asking = relay.decideApproval({ agent, toolName: 'bash', reason: 'same' });
  const [parked] = relay.waitingFor(agent.id).approvals;
  agent.session.append('approval/asked', { id: 'native-late', toolName: 'bash', reason: 'same' });
  assert.deepEqual(relay.waitingFor(agent.id, agent.session.events).approvals.map((item) => item.approval_id), [parked.approval_id]);
  agent.session.events.splice(-1, 1);
  agent.session.append('approval/asked', { id: parked.approval_id, toolName: 'bash', reason: 'same' });
  agent.session.append('approval/asked', { id: 'native-unrelated-identical', toolName: 'bash', reason: 'same' });
  const waiting = relay.waitingFor(agent.id, agent.session.events).approvals;
  assert.deepEqual(waiting.map((item) => [item.approval_id, item.source]), [
    [parked.approval_id, 'parked'], ['native-unrelated-identical', 'log'],
  ]);
  relay.clear();
  assert.equal(await asking, 'cancelled');
});

for (const callId of ['concurrent-call', undefined]) {
  test(`identical concurrent native approvals remain separate, including after one settles (${callId ?? 'no callId'})`, { timeout: 5000 }, async (t) => {
    const { ctx, relay } = await nativeRelay(t);
    const identity = { toolName: 'bash', reason: 'same reason', ...(callId === undefined ? {} : { callId }) };
    const agent = agentFor('session-concurrent', [ev('approval/asked', { id: 'old-log-only', ...identity })]);
    const first = ctx.approval.request({ agent, ...identity });
    const second = ctx.approval.request({ agent, ...identity });
    await tick();
    const waiting = relay.waitingFor(agent.id, agent.session.events).approvals;
    const parked = waiting.filter((item) => item.source === 'parked');
    assert.equal(parked.length, 2);
    assert.equal(new Set(parked.map((item) => item.approval_id)).size, 2);
    assert.deepEqual(waiting.filter((item) => item.source === 'log').map((item) => item.approval_id), ['old-log-only']);
    await relay.approve(agent.id, parked[0].approval_id, 'reject');
    assert.equal(await first, 'rejected');
    const afterFirst = relay.waitingFor(agent.id, agent.session.events).approvals;
    assert.deepEqual(afterFirst.map((item) => [item.approval_id, item.source]), [
      [parked[1].approval_id, 'parked'], ['old-log-only', 'log'],
    ], 'inferred native pairing must not retain the wrong concurrent UUID after it decides');
    await relay.approve(agent.id, parked[1].approval_id, 'approve');
    assert.equal(await second, 'allowed-once');
    assert.deepEqual(relay.waitingFor(agent.id, agent.session.events).approvals.map((item) => item.approval_id), ['old-log-only']);
    assertEmpty(relay);
  });
}

test('native approval abort before its waterfall microtask never parks a late request', { timeout: 5000 }, async (t) => {
  const { ctx, relay } = await nativeRelay(t);
  const agent = agentFor('session-abort-late');
  const controller = new AbortController();
  let dispatches = 0;
  ctx.on('approval/request', (request, next) => { dispatches += 1; return next(); }, { prepend: true });
  const asking = ctx.approval.request({ agent, toolName: 'bash', callId: 'late-call', signal: controller.signal });
  controller.abort();
  assert.equal(await asking, 'cancelled');
  await tick();
  assert.equal(dispatches, 1, 'the host really did dispatch after the abort');
  assert.deepEqual(relay.waitingFor(agent.id, agent.session.events).approvals, []);
  assert.equal(listeners(controller.signal), 0);
  assertEmpty(relay);
});

test('direct preaborted approval and question signals return closed without registering listeners', async () => {
  const relay = relayFor();
  const controller = new AbortController();
  controller.abort();
  const agent = agentFor('session-preaborted');
  assert.equal(await relay.decideApproval({ agent, toolName: 'bash', signal: controller.signal }), 'cancelled');
  assert.deepEqual(await relay.decideQuestion({ agent, questions: [question('q')], signal: controller.signal }, noAnswers), { answers: [] });
  assert.equal(listeners(controller.signal), 0);
  assertEmpty(relay);
});

for (const kind of ['approval', 'question']) {
  test(`${kind} cancellation during log mining also releases late-registered listeners`, async (t) => {
    const relay = relayFor();
    t.after(() => relay.clear());
    const controller = new AbortController();
    const agent = agentFor('session-mining');
    agent.session.snapshotEvents = () => { controller.abort(); return []; };
    const asking = kind === 'approval'
      ? relay.decideApproval({ agent, toolName: 'bash', signal: controller.signal })
      : relay.decideQuestion({ agent, questions: [question('q')], signal: controller.signal }, noAnswers);
    await tick();
    assertEmpty(relay);
    assert.equal(listeners(controller.signal), 0);
    assert.deepEqual(await asking, kind === 'approval' ? 'cancelled' : { answers: [] });
  });
}

for (const settlement of ['approve', 'reject', 'abort', 'stop', 'dispose']) {
  test(`parked approval removes its abort listener on ${settlement}`, async (t) => {
    const relay = relayFor();
    t.after(() => relay.clear());
    const controller = new AbortController();
    const agent = agentFor('session-cleanup');
    const asking = relay.decideApproval({ agent, toolName: 'bash', signal: controller.signal });
    const [pending] = relay.waitingFor(agent.id).approvals;
    assert.equal(listeners(controller.signal), 1);
    if (settlement === 'approve' || settlement === 'reject') await relay.approve(agent.id, pending.approval_id, settlement);
    else if (settlement === 'abort') controller.abort();
    else if (settlement === 'stop') relay.failClosed(agent.id);
    else relay.clear();
    assert.equal(await asking, settlement === 'approve' ? 'allowed-once' : settlement === 'reject' ? 'rejected' : 'cancelled');
    assert.equal(listeners(controller.signal), 0);
    controller.abort();
    assertEmpty(relay);
    await assert.rejects(() => relay.approve(agent.id, pending.approval_id, 'approve'), { code: 'APPROVAL_NOT_FOUND' });
  });
}

for (const settlement of ['stop', 'dispose', 'abort']) {
  test(`partially answered question batch preserves only human answers in original order on ${settlement}`, async (t) => {
    const relay = relayFor();
    t.after(() => relay.clear());
    const agent = agentFor('session-batch');
    const controller = new AbortController();
    const questions = ['q-first', 'q-unanswered', 'q-third', 'q-also-unanswered'].map(question);
    const asking = relay.decideQuestion({ agent, questions, wait: { callId: 'batch-call' }, signal: controller.signal }, noAnswers);
    let settled = false;
    void asking.then(() => { settled = true; });
    const pending = relay.waitingFor(agent.id).questions;
    const batchId = pending[0].question_id.split('#')[0];
    assert.deepEqual(pending.map((item) => item.question_id), questions.map((_, index) => `${batchId}#${index}`));
    assert.equal(listeners(controller.signal), 1);
    await relay.answerQuestion(pending[2].question_id, agent.id, { selected: ['No'] });
    await relay.answerQuestion(pending[0].question_id, agent.id, { selected: ['Yes'], custom: 'human detail' });
    await tick();
    assert.equal(settled, false, 'partial answers do not complete the host ask');
    assert.equal(relay.questionBatches.size, 1);
    assert.equal(relay.questions.size, 2);
    if (settlement === 'stop') relay.failClosed(agent.id);
    else if (settlement === 'dispose') relay.clear();
    else controller.abort();
    assert.deepEqual(await asking, { answers: [
      { id: 'q-first', selected: ['Yes'], custom: 'human detail' },
      { id: 'q-third', selected: ['No'] },
    ] });
    assert.equal(listeners(controller.signal), 0);
    assertEmpty(relay);
    relay.failClosed(agent.id);
    relay.clear();
    controller.abort();
    await assert.rejects(() => relay.answerQuestion(pending[1].question_id, agent.id, { selected: ['Yes'] }), { code: 'QUESTION_NOT_FOUND' });
  });
}

test('normal single-question and batch completion keep their ID contracts and release abort listeners', async (t) => {
  const relay = relayFor();
  t.after(() => relay.clear());
  const agent = agentFor('session-complete');
  for (const count of [1, 2]) {
    const controller = new AbortController();
    const questions = Array.from({ length: count }, (_, index) => question(`q-${index}`));
    const asking = relay.decideQuestion({ agent, questions, signal: controller.signal }, noAnswers);
    const pending = relay.waitingFor(agent.id).questions;
    if (count === 1) assert.match(pending[0].question_id, /^question-[0-9a-f]{8}$/);
    else assert.ok(pending.every((item, index) => item.question_id.endsWith(`#${index}`)));
    for (const item of [...pending].reverse()) await relay.answerQuestion(item.question_id, agent.id, { selected: ['Yes'] });
    assert.deepEqual(await asking, { answers: questions.map((item) => ({ id: item.id, selected: ['Yes'] })) });
    assert.equal(listeners(controller.signal), 0);
    assertEmpty(relay);
  }
});

test('session stop is isolated for approvals, question batches, and unscoped asks', async (t) => {
  const relay = relayFor();
  t.after(() => relay.clear());
  const a = agentFor('session-a');
  const b = agentFor('session-b');
  const signals = Array.from({ length: 5 }, () => new AbortController());
  const approvalA = relay.decideApproval({ agent: a, toolName: 'bash', callId: 'shared-call', signal: signals[0].signal });
  const approvalB = relay.decideApproval({ agent: b, toolName: 'bash', callId: 'shared-call', signal: signals[1].signal });
  const questionA = relay.decideQuestion({ agent: a, questions: [question('a-1'), question('a-2')], signal: signals[2].signal }, noAnswers);
  const questionB = relay.decideQuestion({ agent: b, questions: [question('b-1'), question('b-2')], signal: signals[3].signal }, noAnswers);
  const unscoped = relay.decideQuestion({ questions: [question('unscoped')], signal: signals[4].signal }, noAnswers);
  const waitingA = relay.waitingFor(a.id, [ev('approval/asked', { id: 'native-a', toolName: 'bash', callId: 'shared-call' })]);
  const waitingB = relay.waitingFor(b.id, [ev('approval/asked', { id: 'native-b', toolName: 'bash', callId: 'shared-call' })]);
  assert.equal(waitingA.approvals.length, 1);
  assert.equal(waitingB.approvals.length, 1);
  assert.notEqual(waitingA.approvals[0].approval_id, waitingB.approvals[0].approval_id);
  await assert.rejects(() => relay.approve(b.id, waitingA.approvals[0].approval_id, 'approve'), { code: 'APPROVAL_SESSION_MISMATCH' });
  await assert.rejects(() => relay.answerQuestion(waitingA.questions[0].question_id, b.id, { selected: ['Yes'] }), { code: 'QUESTION_NOT_FOUND' });
  await relay.answerQuestion(waitingA.questions[0].question_id, a.id, { selected: ['Yes'] });
  await relay.answerQuestion(waitingB.questions[1].question_id, b.id, { selected: ['No'] });

  relay.failClosed(a.id);
  assert.equal(await approvalA, 'cancelled');
  assert.deepEqual(await questionA, { answers: [{ id: 'a-1', selected: ['Yes'] }] });
  assert.equal(relay.approvals.size, 1);
  assert.equal(relay.questions.size, 2, 'session-b and unscoped asks are still answerable');
  assert.equal(relay.questionBatches.size, 2);
  assert.deepEqual(signals.map((item) => listeners(item.signal)), [0, 1, 0, 1, 1]);
  assert.deepEqual(relay.waitingFor(a.id), { approvals: [], questions: [] });
  relay.clear();
  assert.equal(await approvalB, 'cancelled');
  assert.deepEqual(await questionB, { answers: [{ id: 'b-2', selected: ['No'] }] });
  assert.deepEqual(await unscoped, { answers: [] });
  assert.deepEqual(signals.map((item) => listeners(item.signal)), [0, 0, 0, 0, 0]);
  assertEmpty(relay);
});

test('question reporting keeps unrelated log calls and other sessions separate', async (t) => {
  const relay = relayFor();
  t.after(() => relay.clear());
  const questions = [question('q-first'), question('q-second')];
  const agent = agentFor('session-questions', [
    ev('tool/call', { name: 'ask_user_question', callId: 'parked-call', arguments: JSON.stringify({ questions }) }),
    ev('tool/call', { name: 'ask_user_question', callId: 'log-only-call', arguments: JSON.stringify({ questions: [question('other')] }) }),
  ]);
  const asking = relay.decideQuestion({ agent, questions, wait: { callId: 'parked-call' } }, noAnswers);
  const waiting = relay.waitingFor(agent.id, agent.session.events).questions;
  assert.deepEqual(waiting.map((item) => item.source), ['parked', 'parked', 'log']);
  assert.equal(waiting[2].question_id, 'log-only-call');
  assert.deepEqual(relay.waitingFor('other-session').questions, []);
  relay.failClosed(agent.id);
  assert.deepEqual(await asking, { answers: [] });
  assertEmpty(relay);
});

test('empty question batches settle without a parked entry or accumulator leak', async () => {
  const relay = relayFor();
  const controller = new AbortController();
  const asking = relay.decideQuestion({ questions: [], signal: controller.signal }, noAnswers);
  assertEmpty(relay);
  assert.deepEqual(await asking, { answers: [] });
  assert.equal(listeners(controller.signal), 0);
});

test('unmanaged, GUI deferral, and operator auto-approval retain their routing priority', async () => {
  const agent = agentFor('session-routing');
  let approvals = 0;
  let questions = 0;
  const nextApproval = async () => { approvals += 1; return 'rejected'; };
  const hostAnswer = { answers: [{ id: 'q', selected: ['Yes'] }] };
  const nextQuestion = async () => { questions += 1; return hostAnswer; };
  for (const host of [
    { isManaged: () => false, autoApproveEscalations: () => true },
    { hostCanAnswer: () => true },
  ]) {
    const relay = relayFor(host);
    assert.equal(await relay.decideApproval({ agent, toolName: 'bash' }, nextApproval), 'rejected');
    assert.equal(await relay.decideQuestion({ agent, questions: [question('q')] }, nextQuestion), hostAnswer);
    assertEmpty(relay);
  }
  const switched = relayFor({ hostCanAnswer: () => true, autoApproveEscalations: () => true });
  assert.equal(await switched.decideApproval({ agent, toolName: 'bash' }, nextApproval), 'allowed-once');
  assert.equal(await switched.decideQuestion({ agent, questions: [question('q')] }, nextQuestion), hostAnswer);
  assert.equal(approvals, 2, 'operator switch claims only managed approvals, before GUI deferral');
  assert.equal(questions, 3, 'operator switch never invents question answers');
  assertEmpty(switched);
});
