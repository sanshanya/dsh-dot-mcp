import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectPersistedSession, persistedHeader, sessionEvents } from '../../lib/session-persistence-compat.js';
import { agentPresetProjectionDefinition } from '@deepseek-ai/dsh-agent-preset-registry';

test('persistence reads without write ownership and closes before returning', async () => {
  const calls = [];
  const header = { id: 'session-a' };
  const events = Object.freeze([{ type: 'test' }]);
  const result = await inspectPersistedSession({
    async open(id, access) {
      calls.push([id, access]);
      return { header, async read() { calls.push('read'); return { eventState: 'shared-frozen', events }; },
        async close() { calls.push('close'); } };
    },
  }, 'session-a');
  assert.deepEqual(result, { meta: header, events });
  assert.equal(result.events, events);
  assert.deepEqual(calls, [['session-a', 'read'], 'read', 'close']);
});

test('persistence closes read handles when reading fails', async () => {
  let closed = false;
  const failure = new Error('read failed');
  await assert.rejects(inspectPersistedSession({ async open() {
    return { header: {}, async read() { throw failure; }, async close() { closed = true; } };
  } }, 'session-a'), error => error === failure);
  assert.equal(closed, true);
});

test('list snapshots carry header metadata (pinned host snapshot shape only)', () => {
  const header = { id: 'session-a' };
  assert.equal(persistedHeader({ header, revision: 'opaque-token' }), header);
});

test('live snapshot API feeds the preset replay projection', () => {
  const events = [{ type: 'agent-preset/selected', data: { agentPreset: 'new-preset' } }];
  const session = { snapshotEvents: () => events };
  assert.equal(sessionEvents(session), events);
  assert.equal(events.reduce(agentPresetProjectionDefinition.apply,
    agentPresetProjectionDefinition.init({ agentPreset: 'old-preset' })), 'new-preset');
});
