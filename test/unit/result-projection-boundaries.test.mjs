import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldSessionFacts, toolCallsForTurn, toolResultOutcome } from '../../lib/session-facts.js';
import { computeCatchUpDelta, computeProgressDelta } from '../../lib/session-delta.js';

// All results, commands and paths are synthetic in-memory values. No tool,
// process, filesystem fixture, credential or real session is consulted.
const CALL_ID = 'synthetic-result-call';
const WORKDIR = '/synthetic/result-projection-workspace/subdirectory';
const event = (type, data, seq) => ({ type, seq, time: seq, data });

function resultData(content, flags = {}, messageFlags = {}) {
  return {
    turn: 1,
    message: { source: { callId: CALL_ID }, content, ...messageFlags },
    ...flags,
  };
}

function resultEvents(data) {
  return [
    event('tool/call', {
      turn: 1, callId: CALL_ID, name: 'bash',
      arguments: JSON.stringify({ command: 'git push origin main', workdir: WORKDIR }),
    }, 17),
    event('tool/result', data, 23),
  ];
}

function deltaInput(events) {
  return { events, status: 'running', changedFiles: [], approvalIds: [], questionIds: [] };
}

function assertProjections(data, expected) {
  const events = resultEvents(data);
  const outcome = toolResultOutcome(data);
  assert.deepEqual(outcome, expected);
  const fact = foldSessionFacts(events).tools[0];
  assert.ok(fact, 'the synthetic result must pair with its call');
  assert.equal(fact.ok, expected.ok);
  assert.equal(fact.exitCode, expected.exitCode);
  assert.equal(fact.callSeq, 17);
  assert.equal(fact.seq, 23);
  assert.equal(fact.workdir, WORKDIR);
  const call = toolCallsForTurn(events, 1, 20)[0];
  assert.equal(call.isError, !expected.ok);
  for (const delta of [computeProgressDelta(deltaInput(events)), computeCatchUpDelta(deltaInput(events), 0)]) {
    const result = delta.new_events.find(item => item.type === 'tool/result');
    assert.equal(result.name, CALL_ID);
    assert.equal(result.ok, expected.ok);
  }
  return { fact, call };
}

test('process nonzero exits fail in facts, turn tool calls and both polling projections', () => {
  for (const [content, exitCode] of [
    ['looks successful\n[exit code: 1]', 1],
    [[{ type: 'tool', isError: false, content: 'first block succeeded' },
      { type: 'text', text: '[exit code: 9]' }], 9],
    [[{ type: 'tool', content: 'process exited with code: -1' }], -1],
    [[{ type: 'text', text: 'exit code: 7' }], 7],
  ]) {
    assertProjections(resultData(content), { ok: false, exitCode });
  }
  assertProjections(resultData('looks successful', { exitCode: 2 }), { ok: false, exitCode: 2 });
  assertProjections(resultData('looks successful', {}, { exitCode: 3 }), { ok: false, exitCode: 3 });
});

test('zero and unknown exits have stable success semantics across every result projection', () => {
  for (const content of ['ok\n[exit code: 0]', [{ type: 'text', text: 'ok\n[exit code: 0]' }],
    ['ok', { type: 'tool', content: '[exit code: 0]', isError: false }]]) {
    assertProjections(resultData(content), { ok: true, exitCode: 0 });
  }
  for (const content of ['ok without a process marker', '', [],
    [{ type: 'tool', content: 'ok', isError: false }, { type: 'text', text: 'more output' }]]) {
    assertProjections(resultData(content), { ok: true });
  }
  assertProjections(resultData('ok', { exitCode: 0 }), { ok: true, exitCode: 0 });
  assertProjections(resultData('ok', {}, { exitCode: 0 }), { ok: true, exitCode: 0 });
});

test('an error in any later result block defeats earlier success and a zero process exit', () => {
  assertProjections(resultData([
    { type: 'tool', content: 'first block looks successful', isError: false },
    null, 'plain output',
    { type: 'tool', content: 'later block failed', isError: true },
    { type: 'text', text: '[exit code: 0]' },
  ]), { ok: false, exitCode: 0 });
});

test('data/message failure flags and structured errors survive all projections', () => {
  assertProjections(resultData('ok\n[exit code: 0]', { isError: true }), { ok: false, exitCode: 0 });
  assertProjections(resultData('ok\n[exit code: 0]', {}, { isError: true }), { ok: false, exitCode: 0 });
  const error = { name: 'SyntheticError', code: 'SYNTHETIC_FAILURE' };
  const { fact, call } = assertProjections(resultData('ok\n[exit code: 0]', { error }), { ok: false, exitCode: 0 });
  assert.equal(fact.errorCode, error.code);
  assert.deepEqual(call.error, error);
  assert.equal(call.error, error, 'the turn projection preserves the structured error unchanged');
  assertProjections(resultData('ok', { error: null }), { ok: false });
});

test('the last full-text exit marker wins over fake markers printed earlier on stdout', () => {
  assertProjections(resultData([
    { type: 'tool', content: '[exit code: 0]\nstdout printed a fake success marker' },
    { type: 'text', text: '[exit code: 4]' },
  ]), { ok: false, exitCode: 4 });
  assertProjections(resultData('[exit code: 42]\nstdout printed a fake failure marker\n[exit code: 0]'),
    { ok: true, exitCode: 0 });
  assertProjections(resultData('[exit code: 0]\nprocess exited with code: 5'), { ok: false, exitCode: 5 });
});

test('explicit safe-integer exits take precedence and invalid exits fall back to full text', () => {
  assertProjections(resultData('[exit code: 7]', { exitCode: 0 }), { ok: true, exitCode: 0 });
  assertProjections(resultData('[exit code: 0]', {}, { exitCode: 8 }), { ok: false, exitCode: 8 });
  assertProjections(resultData('[exit code: 7]', { exitCode: 0 }, { exitCode: 8 }), { ok: true, exitCode: 0 });
  for (const exitCode of [1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, '0']) {
    assertProjections(resultData('[exit code: 6]', { exitCode }), { ok: false, exitCode: 6 });
  }
  assertProjections(resultData('[exit code: 9007199254740992]'), { ok: true });
});

test('the bounded whole-line head-tail preview preserves call metadata and does not drive outcome', () => {
  const middle = Array.from({ length: 90 }, (_, index) => `synthetic output line ${index} ${'x'.repeat(60)}`).join('\n');
  const text = 'synthetic head\n[exit code: 0]\n' + middle
    + '\n# tests 161\n# pass 161\n# fail 0\n# skipped 0\n[exit code: 11]';
  const { fact } = assertProjections(resultData([{ type: 'tool', content: text }]), { ok: false, exitCode: 11 });
  assert.equal(fact.resultTruncated, true);
  assert.ok(fact.resultText.length <= 800);
  assert.ok(fact.resultText.startsWith('synthetic head\n'));
  assert.ok(fact.resultText.includes('\n…[truncated]\n'));
  assert.ok(fact.resultText.endsWith('# skipped 0\n[exit code: 11]'));
  assert.match(fact.resultText, /^# pass 161$/m);

  const textWithHiddenExit = 'synthetic head\n' + middle + '\n[exit code: 12]\n' + middle + '\nsynthetic tail';
  const hidden = assertProjections(resultData(textWithHiddenExit), { ok: false, exitCode: 12 }).fact;
  assert.equal(hidden.resultTruncated, true);
  assert.ok(!hidden.resultText.includes('[exit code: 12]'), 'exit parsing is independent of the bounded preview');
});

test('malformed top-level results fail closed without throwing or inventing a paired success', () => {
  for (const data of [undefined, null, false, 1, 'not a result envelope', []]) {
    assert.deepEqual(toolResultOutcome(data), { ok: false });
    const events = resultEvents(data);
    assert.deepEqual(foldSessionFacts(events).tools, []);
    assert.equal(toolCallsForTurn(events, 1, 20)[0].isError, undefined, 'an unmappable result does not settle the call');
    for (const delta of [computeProgressDelta(deltaInput(events)), computeCatchUpDelta(deltaInput(events), 0)]) {
      assert.equal(delta.new_events.find(item => item.type === 'tool/result').ok, false);
    }
  }
});

test('malformed nested content is safe and cannot hide an explicit failure flag', () => {
  for (const content of [undefined, null, false, 1, {}, [null, false, 1, [], {}]]) {
    assertProjections(resultData(content, { isError: true }), { ok: false });
  }
  for (const message of [undefined, null, false, 1, 'not a message', []]) {
    const data = { turn: 1, message, isError: true };
    assert.deepEqual(toolResultOutcome(data), { ok: false });
    const events = resultEvents(data);
    assert.doesNotThrow(() => foldSessionFacts(events));
    assert.doesNotThrow(() => toolCallsForTurn(events, 1, 20));
    assert.equal(computeProgressDelta(deltaInput(events)).new_events[1].ok, false);
  }
});
