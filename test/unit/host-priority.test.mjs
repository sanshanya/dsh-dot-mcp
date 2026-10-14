import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import UserQuestions from '@deepseek-ai/dsh-user-questions';
import { Bridge } from '../../lib/bridge.js';

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/**
 * Plugin etiquette: the host answers while it can. The fake host answerer is
 * registered BEFORE bridge.start() so the bridge's `{ prepend: true }`
 * listener lands in front of it — the same topology as the compose-time
 * gateway forwarder plus a plugin loaded later.
 */
function setup({ gateway, cfg = {} } = {}) {
  const ctx = new Context();
  const bridge = new Bridge(ctx, cfg, silentLog);
  return { ctx, bridge, gateway };
}

test('live host client: managed approval stays with the host, bridge holds no pending', { timeout: 5000 }, async () => {
  const { ctx, bridge } = setup();
  ctx.provide('typertGateway', { hasLiveClient: () => true });
  bridge['managed'].add('sess-1');
  let hostAnswered = 0;
  ctx.on('approval/request', () => { hostAnswered += 1; return 'allowed-once'; });
  bridge.start();
  try {
    const outcome = await ctx.waterfall(
      'approval/request',
      { agent: { id: 'sess-1' }, toolName: 'write', callId: 'c-1' },
      async () => 'unavailable',
    );
    assert.equal(outcome, 'allowed-once');
    assert.equal(hostAnswered, 1);
    assert.equal(bridge['relays']['approvals'].size, 0);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('no live host client: bridge holds the approval and dsh_approve settles it', { timeout: 5000 }, async () => {
  const { ctx, bridge } = setup();
  ctx.provide('typertGateway', { hasLiveClient: () => false });
  bridge['managed'].add('sess-2');
  let hostAnswered = 0;
  ctx.on('approval/request', () => { hostAnswered += 1; return 'allowed-once'; });
  bridge.start();
  try {
    const awaiting = ctx.waterfall(
      'approval/request',
      { agent: { id: 'sess-2' }, toolName: 'write', callId: 'c-2' },
      async () => 'unavailable',
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(hostAnswered, 0);
    assert.equal(bridge['relays']['approvals'].size, 1);
    const pendingId = [...bridge['relays']['approvals'].keys()][0];
    const receipt = await bridge.approve('sess-2', pendingId, 'approve');
    assert.equal(receipt.outcome, 'allowed-once');
    assert.equal(await awaiting, 'allowed-once');
    assert.equal(bridge['relays']['approvals'].size, 0);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('no gateway service at all (headless): bridge answers the approval', { timeout: 5000 }, async () => {
  const { ctx, bridge } = setup();
  bridge['managed'].add('sess-3');
  let hostAnswered = 0;
  ctx.on('approval/request', () => { hostAnswered += 1; return 'allowed-once'; });
  bridge.start();
  try {
    const awaiting = ctx.waterfall(
      'approval/request',
      { agent: { id: 'sess-3' }, toolName: 'write', callId: 'c-3' },
      async () => 'unavailable',
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(hostAnswered, 0);
    assert.equal(bridge['relays']['approvals'].size, 1);
    const pendingId = [...bridge['relays']['approvals'].keys()][0];
    await bridge.approve('sess-3', pendingId, 'reject');
    assert.equal(await awaiting, 'rejected');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('live host client: managed questions stay with the host as well', { timeout: 5000 }, async () => {
  const { ctx, bridge } = setup();
  await ctx.plugin(UserQuestions);
  ctx.provide('typertGateway', { hasLiveClient: () => true });
  bridge['managed'].add('sess-5');
  const hostAnswer = { answers: [{ id: 'q', selected: ['Yes'] }] };
  ctx.on('user-questions/request', () => hostAnswer);
  bridge.start();
  try {
    const out = await ctx.userQuestions.ask({
      questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }],
    });
    assert.deepEqual(out, hostAnswer);
    assert.equal(bridge['relays']['questions'].size, 0);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('autoApproveEscalations grants the ask itself, even with a live host client', { timeout: 5000 }, async () => {
  const { ctx, bridge } = setup({ cfg: { autoApproveEscalations: true } });
  ctx.provide('typertGateway', { hasLiveClient: () => true });
  bridge['managed'].add('sess-6');
  let hostAnswered = 0;
  ctx.on('approval/request', () => { hostAnswered += 1; return 'rejected'; });
  bridge.start();
  try {
    const outcome = await ctx.waterfall(
      'approval/request',
      { agent: { id: 'sess-6' }, toolName: 'bash', callId: 'c-6' },
      async () => 'unavailable',
    );
    assert.equal(outcome, 'allowed-once', 'the switch grants the escalation the tool asked for');
    assert.equal(bridge['relays']['approvals'].size, 0, 'nothing parks while the switch is on');
    assert.equal(hostAnswered, 0, '"never ask" outranks an attached client: no card, no host answerer');
  } finally {
    await ctx.fiber.dispose();
  }
});

test('autoApproveEscalations is OFF by default: the ask still parks for a decision', { timeout: 5000 }, async () => {
  const { ctx, bridge } = setup();
  bridge['managed'].add('sess-7');
  bridge.start();
  try {
    const awaiting = ctx.waterfall(
      'approval/request',
      { agent: { id: 'sess-7' }, toolName: 'bash', callId: 'c-7' },
      async () => 'unavailable',
    );
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bridge['relays']['approvals'].size, 1, 'default posture: park');
    const pendingId = [...bridge['relays']['approvals'].keys()][0];
    assert.equal((await bridge.approve('sess-7', pendingId, 'approve')).outcome, 'allowed-once');
    assert.equal(await awaiting, 'allowed-once');
  } finally {
    await ctx.fiber.dispose();
  }
});
