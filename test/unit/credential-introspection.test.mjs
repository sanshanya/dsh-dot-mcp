import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectCredentials } from '../../lib/credentials.js';

const ENV_REFS = ['NUBE_API_KEY', 'DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DSH_API_KEY'];

async function withCleanEnv(fn) {
  const saved = {};
  for (const key of ENV_REFS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  try {
    return await fn();
  } finally {
    for (const key of ENV_REFS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

test('R11 / A15: Credential introspection only exposes availability and source, never secrets', async () => {
  await withCleanEnv(async () => {
    const envKey = 'sk-real-test-secret-key-12345';
    process.env.DEEPSEEK_API_KEY = envKey;

    const { Bridge } = await import('../../lib/bridge.js');
    const bridge = new Bridge(
      { agents: { list: () => [], get: () => undefined }, get: () => undefined },
      { dshHome: '', resultMaxChars: 1000, resultMaxItems: 50 },
      { debug() {}, info() {}, warn() {}, error() {} },
    );

    const creds = bridge.getCredentialStatus();
    assert.ok(Array.isArray(creds));
    assert.equal(creds.length, 1);
    assert.equal(creds[0].credentialAvailable, true);
    assert.equal(creds[0].credentialRef, 'DEEPSEEK_API_KEY');
    assert.equal(creds[0].credentialSource, 'env');

    const jsonStr = JSON.stringify(creds);
    assert.doesNotMatch(jsonStr, new RegExp(envKey));
    assert.doesNotMatch(jsonStr, /sk-real/);
    assert.doesNotMatch(jsonStr, /length/i);
  });
});

test('R11 / A15: credentials.yaml keys are reported without values, prefixes, or lengths', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-creds-'));
  const secret = 'sk-store-secret-must-never-leak-99999';
  writeFileSync(join(dir, 'credentials.yaml'), `NUBE_API_KEY: ${secret}\nopenai:\n  apiKey: ${secret}\n`, 'utf8');
  try {
    const creds = inspectCredentials({ env: {}, dshHome: dir });
    assert.ok(creds.some((item) => item.credentialRef === 'NUBE_API_KEY' && item.credentialSource === 'credentials_store'));
    const jsonStr = JSON.stringify(creds);
    assert.doesNotMatch(jsonStr, new RegExp(secret));
    assert.doesNotMatch(jsonStr, /sk-store/);
    assert.equal('length' in creds[0], false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R11 / A15: runtime secret store is reported as runtime without reading the value', () => {
  const creds = inspectCredentials({ env: {}, runtimeKeyConfigured: true });
  assert.equal(creds.length, 1);
  assert.equal(creds[0].credentialRef, 'RUNTIME_API_KEY');
  assert.equal(creds[0].credentialSource, 'runtime');
  assert.equal(creds[0].credentialAvailable, true);
});
