import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AskRelay } from '../../lib/ask-relay.js';

/**
 * The relay's log mining, next to the module that owns it: both folds feed the
 * two reporting lanes (parked vs log-only) that dsh_get_task_status shows.
 */
const ev = (type, data, seq = 0, time = 0) => ({ type, seq, time, data });

/** Only the mining folds are exercised here; the relay's wire behaviour lives
 * in the suites that drive it through a real bridge or host (bridge.test.mjs,
 * host-priority.test.mjs, dsh-questions-integration.test.mjs). */
const relay = () => new AskRelay({ isManaged: () => true, hostCanAnswer: () => false, autoApproveEscalations: () => false },
  { debug() {}, info() {}, warn() {}, error() {} });

test('undecidedApprovals: asked without decided remains pending', () => {
  const events = [
    ev('approval/asked', { id: 'a1', toolName: 'bash', callId: 'c1' }, 0),
    ev('approval/asked', { id: 'a2', toolName: 'write' }, 1),
    ev('approval/decided', { id: 'a1', outcome: 'allowed-once' }, 2),
  ];
  const pending = relay().waitingFor('s-1', events).approvals;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tool_name, 'write');
});

test('openAskUserQuestions: open call without result', () => {
  const events = [
    ev('tool/call', { turn: 1, step: 1, callId: 'q1', name: 'ask_user_question', arguments: '{"questions":[]}' }, 0),
    ev('tool/call', { turn: 1, step: 1, callId: 'q2', name: 'ask_user_question', arguments: '{}' }, 1),
    ev('tool/result', { turn: 1, step: 1, message: { source: { callId: 'q1' } } }, 2),
  ];
  const open = relay().waitingFor('s-1', events).questions;
  assert.equal(open.length, 1);
  assert.equal(open[0].question_id, 'q2');
  assert.equal(open[0].source, 'log');
});
