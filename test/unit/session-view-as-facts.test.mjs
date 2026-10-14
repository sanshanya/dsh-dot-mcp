import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastTurnSpan,
  assistantTextForTurn,
  toolCallsForTurn,
  collectChangedFiles,
  summarizeMessages,
} from '../../lib/session-facts.js';

/** Inlined from the removed session-facts export (only this test ever read it). */
function lastTodos(events) {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.type === 'todo/write') return event.data.todos.map((todo) => ({ content: todo.content, status: todo.status }));
  }
  return undefined;
}

const ev = (type, data, seq = 0, time = 0) => ({ type, seq, time, data });
const textMessage = (role, text) => ({
  id: 'id-' + Math.random(),
  role,
  content: [{ type: 'text', text }],
  source: role === 'user' ? { kind: 'user' } : { kind: 'model', provider: 'p', model: 'm' },
});

const turn1 = [
  ev('turn/start', { turn: 1 }, 0),
  ev('user/message', textMessage('user', 'hello'), 1),
  ev('assistant/message', { turn: 1, step: 0, message: textMessage('assistant', 'hi there') }, 2),
  ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{"file_path":"a.txt"}' }, 3),
  ev('tool/result', { turn: 1, step: 1, message: { id: 'r1', role: 'user', content: [{ type: 'tool', callId: 'c1', content: 'ok', isError: false }], source: { kind: 'tool', callId: 'c1' } } }, 4),
  ev('tool/call', { turn: 1, step: 1, callId: 'c2', name: 'write', arguments: '{"file_path":"b.txt","content":"x"}' }, 5),
  ev('tool/result', { turn: 1, step: 1, message: { id: 'r2', role: 'user', content: [{ type: 'tool', callId: 'c2', content: 'err', isError: true }], source: { kind: 'tool', callId: 'c2' } }, error: { name: 'X', code: 'E_DENIED' } }, 6),
  ev('assistant/message', { turn: 1, step: 1, message: textMessage('assistant', 'done') }, 7),
  ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 8),
];

test('lastTurnSpan finds the completed turn', () => {
  const span = lastTurnSpan(turn1);
  assert.equal(span.turn, 1);
  assert.equal(span.reason.kind, 'completed');
  assert.equal(span.startSeq, 0);
});

test('assistantTextForTurn concatenates assistant text', () => {
  assert.equal(assistantTextForTurn(turn1, 1), 'hi there\ndone');
});

test('toolCallsForTurn pairs calls with results', () => {
  const calls = toolCallsForTurn(turn1, 1, 50);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'read');
  assert.equal(calls[0].isError, false);
  assert.equal(calls[1].name, 'write');
  assert.equal(calls[1].isError, true);
  assert.deepEqual(calls[1].error, { name: 'X', code: 'E_DENIED' });
});

test('collectChangedFiles only lists paths of editing tools', () => {
  const files = collectChangedFiles(turn1, 1);
  assert.deepEqual(files, ['b.txt']);
});

test('summarizeMessages bounds and orders', () => {
  const rows = summarizeMessages(turn1, 10, 1000);
  assert.equal(rows.length, 3); // user 'hello' + assistant 'hi there' + assistant 'done'
  assert.equal(rows[0].role, 'assistant'); // newest first
  assert.equal(rows[0].text, 'done');
  assert.equal(rows[1].text, 'hi there');
  assert.equal(rows[2].role, 'user');
});

test('summarizeMessages truncates per budget', () => {
  const rows = summarizeMessages(turn1, 10, 3);
  assert.ok(rows.some((row) => row.text.includes('…[truncated]')));
});

test('lastTurnSpan reports an OPEN turn over the last ended turn', () => {
  const events = [
    ev('turn/start', { turn: 1 }, 0),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1),
    ev('turn/start', { turn: 2 }, 2),
  ];
  const span = lastTurnSpan(events);
  assert.equal(span.turn, 2);
  assert.equal(span.reason, undefined);
});

test('lastTodos returns the last snapshot', () => {
  const events = [
    ...turn1,
    ev('todo/write', { todos: [{ content: 'first', status: 'in_progress' }] }, 9),
    ev('todo/write', { todos: [{ content: 'second', status: 'completed' }] }, 10),
  ];
  assert.deepEqual(lastTodos(events), [{ content: 'second', status: 'completed' }]);
});