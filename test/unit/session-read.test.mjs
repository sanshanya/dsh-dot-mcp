import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  cachedTitle,
  deriveRowStatus,
  iso,
  pendingOf,
  sessionSummary,
  titleOf,
  truncate,
} from '../../lib/session-read.js';

const ev = (type, data, seq = 0, time = 0) => ({ type, seq, time, data });
const header = (over = {}) => ({ id: 's-1', createdAt: 1_700_000_000_000, ...over });
const agent = (over = {}) => ({ status: 'idle', inbox: { nextTurn: [], nextStep: [] }, ...over });

test('session-read: iso and truncate are the wire formatting, marker included', () => {
  assert.equal(iso(0), '1970-01-01T00:00:00.000Z');
  assert.equal(truncate('abc', 3), 'abc');
  assert.equal(truncate('abcd', 3), 'abc…[truncated]');
});

test('session-read: pendingOf counts the live inbox, folds the log when cold', () => {
  const live = agent({ inbox: { nextTurn: [1], nextStep: [2, 3] } });
  assert.deepEqual(pendingOf(live, []), { nextTurn: 1, nextStep: 2 });

  const events = [ev('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [{ id: 'm1' }] }, 0)];
  assert.deepEqual(pendingOf(undefined, events), { nextTurn: 1, nextStep: 0 });
});

test('session-read: deriveRowStatus keeps the derivation order and the live/cold split', () => {
  const events = [
    ev('turn/start', { turn: 1 }, 0),
    ev('turn/end', { turn: 1, reason: { kind: 'completed' } }, 1),
  ];
  const base = { events, pendingApprovals: 0, pendingQuestions: 0 };
  // A parked ask outranks a working agent: that is why the driver is asked at all.
  assert.equal(deriveRowStatus({ ...base, agent: agent({ status: 'running' }), pendingApprovals: 1 }), 'waiting_for_approval');
  assert.equal(deriveRowStatus({ ...base, agent: agent({ status: 'running' }), pendingQuestions: 1 }), 'waiting_for_user');
  assert.equal(deriveRowStatus({ ...base, agent: agent({ status: 'running' }) }), 'running');
  assert.equal(deriveRowStatus({ ...base, agent: agent() }), 'completed');
  assert.equal(deriveRowStatus(base), 'completed');
  assert.equal(deriveRowStatus({ events: [], pendingApprovals: 0, pendingQuestions: 0 }), 'unknown');
});

test('session-read: a title service failure never fails the read', () => {
  const events = [ev('session/title', { title: 'from the log', messageSeqs: [], source: { kind: 'user' } }, 0)];
  assert.equal(titleOf({ events }, { get: () => ({ title: 'live' }) }), 'from the log');
  assert.equal(
    titleOf({ session: { id: 's-1' }, events }, { get: () => ({ title: 'live' }) }),
    'live',
  );
  assert.equal(titleOf({ session: { id: 's-1' }, events }, { get: () => { throw new Error('no'); } }), undefined);
  assert.equal(titleOf({ session: { id: 's-1' }, events }, undefined), undefined);
  assert.equal(titleOf({ events: [] }, undefined), undefined);
});

test('session-read: the cache hint asks for the title key only, and a miss is not an error', () => {
  const calls = [];
  const cache = {
    cachedSnapshot: (meta, keys) => {
      calls.push([meta.id, keys]);
      return { asOfSeq: 3, values: { title: 'cached' } };
    },
  };
  assert.equal(cachedTitle(cache, header()), 'cached');
  assert.deepEqual(calls, [['s-1', ['title']]]);

  const throwing = { cachedSnapshot: () => { throw new Error('storage closed'); } };
  assert.equal(cachedTitle(throwing, header()), undefined);
  assert.equal(cachedTitle(undefined, header()), undefined);
});

test('session-read: a null or empty cached title is no hint (the host wire is string | null)', () => {
  const withTitle = (title) => ({ cachedSnapshot: () => ({ asOfSeq: 1, values: { title } }) });
  assert.equal(cachedTitle(withTitle(null), header()), undefined);
  assert.equal(cachedTitle(withTitle(''), header()), undefined);
  assert.equal(cachedTitle({ cachedSnapshot: () => undefined }, header()), undefined);
  assert.equal(cachedTitle({ cachedSnapshot: () => ({ asOfSeq: 1, values: {} }) }, header()), undefined);
});

test('session-read: absent row fields are omitted, never sent as null', () => {
  assert.deepEqual(sessionSummary({ header: header({ cwd: '/tmp/ws' }) }), {
    session_id: 's-1',
    workspace: '/tmp/ws',
    created_at: new Date(1_700_000_000_000).toISOString(),
  });
  assert.deepEqual(
    sessionSummary({ header: header(), title: 't', status: 'idle', updatedAt: '2026-01-01T00:00:00.000Z' }),
    {
      session_id: 's-1',
      title: 't',
      status: 'idle',
      created_at: new Date(1_700_000_000_000).toISOString(),
      updated_at: '2026-01-01T00:00:00.000Z',
    },
  );
});

test('session-read: the read plane never imports the bridge (one direction only)', () => {
  const text = readFileSync(new URL('../../src/session-read.ts', import.meta.url), 'utf8');
  const specifiers = [...text.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
  assert.deepEqual(specifiers.filter((specifier) => specifier.includes('bridge')), []);
  assert.deepEqual(specifiers.filter((specifier) => specifier.includes('mcp')), []);
});