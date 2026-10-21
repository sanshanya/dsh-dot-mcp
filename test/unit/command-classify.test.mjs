import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasShellControlOperator,
  completeCommandTokens,
  classifyCommand,
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

test('remote evidence classification is anchored, operation-specific and rejects non-executing options', () => {
  for (const command of ["echo 'git push'", "echo 'npm publish'", "echo 'gh release create v1'",
    'printf "git push"', 'npm publish --dry-run', 'npm publish --dry-run=true', 'npm publish --help',
    'git push -n origin main', 'git push origin main --dry-run', 'gh release list', 'gh release view v1',
    'gh release delete v1', 'git push origin main; echo ok', 'npm publish || echo ok']) {
    assert.equal(idempotencyKindFor('bash', command), undefined, command);
  }
  assert.equal(idempotencyKindFor('bash', 'npm.cmd publish'), 'npm_publish');
  assert.equal(idempotencyKindFor('bash', 'git.exe push origin main'), 'git_push');
  assert.equal(idempotencyKindFor('bash', 'gh.exe release create v1'), 'github_release');
  assert.equal(idempotencyKindFor('npm.publish'), 'npm_publish');
  assert.equal(idempotencyKindFor('npm.publish', 'echo not-a-publish'), undefined, 'tool-name fallback cannot override a supplied command');
});

test('evidence tokenization fails closed on interpolation/unsupported quoting while display stays descriptive', () => {
  assert.deepEqual(completeCommandTokens('git push "origin" main'), ['git', 'push', 'origin', 'main']);
  for (const command of ['git push $REMOTE main', 'git push ${REMOTE} main', 'git push $(pick) main',
    'git push origin "unterminated', 'git push origin ma\\in']) {
    assert.equal(completeCommandTokens(command), undefined, command);
  }
  assert.ok(classifyCommand("echo 'git push'").includes('git_push'), 'display mentions remain non-authoritative');
  assert.equal(isCompleteTestCommand('npm test --help'), false);
  assert.equal(isCompleteTestCommand('npx jest --listTests'), false);
  assert.equal(isCompleteBuildCommand('npm run build --dry-run'), false);
});

test('git push grouped dry-run short options never become mutation/evidence kinds', () => {
  for (const cluster of ['qn', 'nv', 'nq', 'vn', 'qnv', 'vqn', 'qfn', '4n', '6vn', 'un']) {
    for (const command of [`git push -${cluster} origin main`, `git push origin main -${cluster}`]) {
      assert.equal(completeCommandTokens(command), undefined, command);
      assert.equal(idempotencyKindFor('bash', command), undefined, command);
      assert.ok(classifyCommand(command).includes('git_push'), 'display remains descriptive');
    }
  }
  for (const command of ['git.exe push -q -vn origin main', 'git push -qnoVALUE origin main',
    'git push -o -nv -qn origin main', 'git push --repo -- -nv origin main',
    'git push --receive-pack runner -qn origin main']) {
    assert.equal(idempotencyKindFor('bash', command), undefined, command);
  }
  for (const command of ['git push -nv --tags', 'git push -qn origin --tags', 'git push origin --tags -nv']) {
    assert.equal(idempotencyKindFor('bash', command), undefined, command);
    assert.deepEqual(classifyCommand(command), ['git_tag'], 'display recognizes --tags after options or operands');
  }
});

test('git push option values and operands after -- are not dry-run flags', () => {
  for (const command of ['git push -qv origin main', 'git push --thin origin main',
    'git push -o -n origin main', 'git push -o -nv origin main', 'git push -on origin main',
    'git push -qon origin main', 'git push -qo-n origin main', 'git push --push-option -qn origin main',
    'git push --push-option=-nv origin main', 'git push --receive-pack -nv origin main',
    'git push --exec -qn origin main', 'git push --repo -n main',
    'git push -- --dry-run main', 'git push -- -nv main']) {
    assert.equal(idempotencyKindFor('bash', command), 'git_push', command);
    assert.ok(completeCommandTokens(command), command);
  }
  assert.deepEqual(completeCommandTokens('git push -- -qn main'), ['git', 'push', '--', '-qn', 'main']);
  for (const command of ['git push -o', 'git push --repo']) {
    assert.equal(idempotencyKindFor('bash', command), undefined, 'missing required option arguments fail closed');
  }
});

test('non-executing aliases and option arity belong to the actual command', () => {
  for (const command of ['gh release create v1 -n "notes mention n"',
    'gh release create v1 --notes --help', 'gh release create v1 -F -n']) {
    assert.equal(idempotencyKindFor('bash', command), 'github_release', command);
  }
  assert.ok(completeCommandTokens('git commit -n -m "no-verify is not dry-run"'));
  assert.ok(completeCommandTokens('git commit -m --dry-run'));
  assert.ok(completeCommandTokens('git ls-remote -h origin'));
  assert.equal(isCompleteTestCommand('node --test --test-name-pattern --help'), true);
  assert.equal(isCompleteTestCommand('npx jest --testNamePattern --help'), true);
  assert.equal(isCompleteTestCommand('npx Jest.cmd --help'), false);
  assert.equal(isCompleteTestCommand('npm test -- --help'), false, 'npm forwards its first -- to the test script');
  assert.equal(idempotencyKindFor('bash', 'npm publish --tag --help'), 'npm_publish');
  assert.equal(idempotencyKindFor('bash', 'git push -o -n origin main --dry-run'), undefined);
});
