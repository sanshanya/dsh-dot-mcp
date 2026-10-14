import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import UserQuestions from '@deepseek-ai/dsh-user-questions';
import { Bridge } from '../../lib/bridge.js';

test('real DSH question waterfall reaches the bridge and abort clears its pending request', { timeout: 5000 }, async () => {
  const ctx = new Context();
  await ctx.plugin(UserQuestions);
  const fallback = { answers: [] };
  ctx.on('user-questions/request', async () => fallback);
  const bridge = new Bridge(ctx, {}, { info() {}, warn() {}, error() {}, debug() {} });
  bridge.start();
  try {
    const controller = new AbortController();
    const asking = ctx.userQuestions.ask({
      questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }],
      signal: controller.signal,
    });
    // Attach rejection handling immediately: the real service owns abort errors.
    const settled = asking.then(value => ({ value }), error => ({ error }));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bridge['relays']['questions'].size, 1);
    controller.abort();
    await settled;
    assert.equal(bridge['relays']['questions'].size, 0);
    // Dispatch directly to test routing without fabricating a live DSH agent.
    assert.equal(await ctx.waterfall('user-questions/request', {
      agent: { id: 'unmanaged' }, questions: [],
    }, async () => fallback), fallback);

    const answer = { answers: [{ id: 'q', selected: ['Yes'] }] };
    const next = ctx.userQuestions.ask({ questions: [{ id: 'q', question: 'Continue?', options: [{ label: 'Yes' }] }] });
    await new Promise(resolve => setImmediate(resolve));
    const pending = [...bridge['relays']['questions'].values()][0];
    assert.ok(pending);
    pending.resolve(answer);
    assert.deepEqual(await next, answer);
    assert.equal(bridge['relays']['questions'].size, 0);
  } finally {
    await ctx.fiber.dispose();
  }
});

test('a multi-question ask is answered one item at a time (golden E2E defect)', { timeout: 5000 }, async () => {
  const ctx = new Context();
  await ctx.plugin(UserQuestions);
  const bridge = new Bridge(ctx, {}, { info() {}, warn() {}, error() {}, debug() {} });
  bridge.start();
  try {
    const asking = ctx.userQuestions.ask({
      questions: [
        { id: 'q-color', question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }] },
        { id: 'q-size', question: 'Which size?', options: [{ label: 'Small' }, { label: 'Large' }] },
      ],
    });
    const state = { done: false };
    const settled = asking.then(
      (value) => { state.done = true; return value; },
      () => { state.done = true; return undefined; },
    );
    await new Promise((resolve) => { setImmediate(resolve); });

    // One answerable id per question: the second question is judged on its OWN
    // options, so answering the first must not settle the ask.
    const ids = [...bridge['relays']['questions'].keys()];
    assert.equal(ids.length, 2, 'one answerable id per question of the ask');
    assert.deepEqual([...bridge['relays']['questions'].values()].map((item) => item.questions[0].id), ['q-color', 'q-size']);

    const first = await bridge.answerQuestion(ids[0], undefined, { selected: ['Red'] });
    await new Promise((resolve) => { setImmediate(resolve); });
    assert.equal(first.remaining_questions, 1);
    assert.equal(first.next_question_id, ids[1]);
    assert.equal(bridge['relays']['questions'].size, 1, 'the second question stays answerable');
    assert.equal(state.done, false, 'the host ask is not settled by a partial answer');
    await assert.rejects(() => bridge.answerQuestion(ids[1], undefined, { selected: ['Red'] }), (error) => {
      assert.equal(error.code, 'INVALID_ANSWER', 'per-item validation: q-size never offered Red');
      return true;
    });

    const second = await bridge.answerQuestion(ids[1], undefined, { selected: ['Large'] });
    assert.equal(second.remaining_questions, 0);
    assert.deepEqual(await settled, {
      answers: [{ id: 'q-color', selected: ['Red'] }, { id: 'q-size', selected: ['Large'] }],
    }, 'the host receives every answer, in the order it asked');
    assert.equal(bridge['relays']['questions'].size, 0);
    assert.equal(bridge['relays']['questionBatches'].size, 0, 'the batch record is released with its last answer');
  } finally {
    await ctx.fiber.dispose();
  }
});
