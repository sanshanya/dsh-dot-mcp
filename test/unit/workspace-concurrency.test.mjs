import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceConcurrencyGuard } from '../../lib/workspace-guard.js';

test('R4 / A07: Workspace concurrency guard allows only one mutable session per workspace', () => {
  const guard = new WorkspaceConcurrencyGuard();
  const workspacePath = 'D:/test-workspace';

  const first = guard.acquireMutableLock(workspacePath, 'session-1', 'goal-1');
  assert.equal(first.success, true);
  assert.equal(first.holder?.sessionId, 'session-1');

  // Second mutable session is blocked
  const second = guard.acquireMutableLock(workspacePath, 'session-2', 'goal-2');
  assert.equal(second.success, false);
  assert.equal(second.holder?.sessionId, 'session-1');

  // Override allows second session with warning
  const override = guard.acquireMutableLock(workspacePath, 'session-2', 'goal-2', true, true);
  assert.equal(override.success, true);
  assert.ok(override.warning?.includes('session-1'));

  // Old overridden session attempting to release does not release session-2's lock
  assert.equal(guard.releaseLock('session-1'), false);
  assert.equal(guard.getLock(workspacePath)?.sessionId, 'session-2');

  // Releasing lock makes workspace available
  assert.equal(guard.releaseLock('session-2'), true);
  const third = guard.acquireMutableLock(workspacePath, 'session-3', 'goal-3');
  assert.equal(third.success, true);
});
