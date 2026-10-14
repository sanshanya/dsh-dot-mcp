#!/usr/bin/env node
/**
 * Test runner for `npm test`.
 *
 * Runs the unit suite with `node --test` in a single process
 * (`--test-isolation=none`), so the whole suite shares one process and no
 * per-file child processes are spawned.
 *
 * The isolation flag has two names depending on the Node major:
 *   - Node 22:  `--experimental-test-isolation=none` (experimental name)
 *   - Node 23+: `--test-isolation=none` (stable name; the experimental name
 *     is kept as an alias)
 * Select the supported spelling before starting the suite so Node 22 does not
 * emit a deliberate "bad option" failure before the real test run.
 */
import { spawnSync } from 'node:child_process';

const TEST_ARGS = ['--test', 'test/unit/*.test.mjs'];

function run(flag) {
  return spawnSync(process.execPath, [flag, ...TEST_ARGS], { stdio: 'inherit' });
}

const nodeMajor = Number(process.versions.node.split('.')[0]);
const result = run(nodeMajor === 22 ? '--experimental-test-isolation=none' : '--test-isolation=none');
process.exit(result.status === null ? 1 : result.status);
