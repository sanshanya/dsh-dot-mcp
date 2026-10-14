import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldSessionFacts } from '../../lib/session-facts.js';
import { computeProgressDelta, nextPollCursor, DELTA_EVENTS_MAX } from '../../lib/session-delta.js';

const ev = (type, data, seq) => ({ type, seq, time: seq, data });

test('Test C — second poll delta contains only new changes', () => {
  const firstEvents = [
    ev('todo/write', { todos: [{ content: 'analyze', status: 'in_progress' }] }, 1),
    ev('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: '{}' }, 2),
    ev('tool/result', { turn: 1, step: 1, message: { source: { callId: 'c1' }, content: [{ isError: false }] } }, 3),
  ];
  const firstFacts = foldSessionFacts(firstEvents);
  const firstInput = {
    events: firstEvents,
    facts: firstFacts,
    todos: firstFacts.todos,
    status: 'running',
    changedFiles: [],
    approvalIds: [],
    questionIds: [],
    currentStep: 'analyze',
  };
  const firstDelta = computeProgressDelta(firstInput);
  assert.equal(firstDelta.since_seq, undefined);
  assert.equal(firstDelta.until_seq, 3);
  assert.ok(firstDelta.new_events.length >= 1);

  const cursor = nextPollCursor(firstInput);
  const secondEvents = [
    ...firstEvents,
    ev('todo/write', { todos: [{ content: 'analyze', status: 'completed' }] }, 4),
  ];
  const secondFacts = foldSessionFacts(secondEvents);
  const secondDelta = computeProgressDelta({
    events: secondEvents,
    facts: secondFacts,
    todos: secondFacts.todos,
    status: 'running',
    changedFiles: [],
    approvalIds: [],
    questionIds: [],
    previous: cursor,
    currentStep: 'analyze',
  });
  assert.equal(secondDelta.since_seq, 3);
  assert.equal(secondDelta.until_seq, 4);
  assert.equal(secondDelta.new_events.length, 1);
  assert.equal(secondDelta.new_events[0].seq, 4);
  assert.deepEqual(secondDelta.todos_changed, [{ content: 'analyze', from: 'in_progress', to: 'completed' }]);
  assert.equal(secondDelta.status_changed, false);
});

test('progress delta caps new_events', () => {
  const events = [];
  for (let i = 0; i <= DELTA_EVENTS_MAX + 5; i++) {
    events.push(ev('step/start', { turn: 1, step: i }, i));
  }
  const delta = computeProgressDelta({
    events,
    facts: foldSessionFacts(events),
    status: 'running',
    changedFiles: [],
    approvalIds: [],
    questionIds: [],
  });
  assert.equal(delta.new_events.length, DELTA_EVENTS_MAX);
  assert.equal(delta.new_events[0].seq, 6);
});
