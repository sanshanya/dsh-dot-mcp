import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasShellControlOperator,
  idempotencyKindFor,
  isCompleteBuildCommand,
  isCompleteTestCommand,
} from '../../lib/command-classify.js';

test('control operators block classification (a compound command is never one kind)', () => {
  assert.equal(hasShellControlOperator('npm test && echo done'), true);
  assert.equal(hasShellControlOperator('npm test'), false);
});

test('complete test/build commands classify; fragments do not', () => {
  assert.equal(isCompleteTestCommand('npm test'), true);
  assert.equal(isCompleteTestCommand('npm run test'), true);
  assert.equal(isCompleteTestCommand('npx vitest'), true);
  assert.equal(isCompleteTestCommand('pnpm vitest run'), false, 'pnpm only classifies its own test scripts');
  assert.equal(isCompleteBuildCommand('npm run build'), true);
  assert.equal(isCompleteBuildCommand('npx tsc'), true);
});

test('idempotencyKindFor maps only clean commands to a kind', () => {
  assert.equal(idempotencyKindFor('bash', 'npm publish'), 'npm_publish');
  assert.equal(idempotencyKindFor('bash', 'gh release create v1'), 'github_release');
  assert.equal(idempotencyKindFor('bash', 'git push origin main'), 'git_push');
  assert.equal(idempotencyKindFor('bash', 'npm test'), 'test');
  assert.equal(idempotencyKindFor('bash', 'npm run build'), 'build');
  assert.equal(idempotencyKindFor('bash', 'npm test && rm -rf .'), undefined, 'compound commands never classify');
  assert.equal(idempotencyKindFor('bash', 'git status'), undefined);
});
