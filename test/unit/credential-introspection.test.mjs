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

test('R11 / A15: Credential introspection returns availability, source and the plaintext value', async () => {
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
    // No redaction posture: the value the bridge can read is the value it returns.
    assert.equal(creds[0].credentialValue, envKey);
  });
});

test('R11 / A15: credentials.yaml named refs return their own plaintext values', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-creds-'));
  const secret = 'sk-store-secret-99999';
  writeFileSync(join(dir, 'credentials.yaml'), `NUBE_API_KEY: ${secret}\nDEEPSEEK_API_KEY: "quoted-${secret}"\nopenai:\n  apiKey: ${secret}\n`, 'utf8');
  try {
    const creds = inspectCredentials({ env: {}, dshHome: dir });
    const nube = creds.find((item) => item.credentialRef === 'NUBE_API_KEY');
    assert.equal(nube?.credentialSource, 'credentials_store');
    assert.equal(nube?.credentialValue, secret);
    const deepseek = creds.find((item) => item.credentialRef === 'DEEPSEEK_API_KEY');
    assert.equal(deepseek?.credentialValue, `quoted-${secret}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R11 / A15: an env ref outranks the store for both status and value', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-creds-'));
  writeFileSync(join(dir, 'credentials.yaml'), 'DEEPSEEK_API_KEY: sk-store-value\n', 'utf8');
  try {
    const creds = inspectCredentials({ env: { DEEPSEEK_API_KEY: 'sk-env-value' }, dshHome: dir });
    const row = creds.find((item) => item.credentialRef === 'DEEPSEEK_API_KEY');
    assert.equal(row?.credentialSource, 'env');
    assert.equal(row?.credentialValue, 'sk-env-value');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R11 / A15: runtime and unmapped store shapes report availability without a value', () => {
  const runtime = inspectCredentials({ env: {}, runtimeKeyConfigured: true });
  assert.equal(runtime.length, 1);
  assert.equal(runtime[0].credentialRef, 'RUNTIME_API_KEY');
  assert.equal(runtime[0].credentialSource, 'runtime');
  assert.equal(runtime[0].credentialAvailable, true);
  assert.equal(runtime[0].credentialValue, undefined);

  const dir = mkdtempSync(join(tmpdir(), 'dsh-creds-'));
  writeFileSync(join(dir, 'credentials.yaml'), 'openai:\n  apiKey: sk-unmapped\n', 'utf8');
  try {
    const generic = inspectCredentials({ env: {}, dshHome: dir });
    assert.equal(generic.length, 1);
    assert.equal(generic[0].credentialRef, 'PROVIDER_API_KEY');
    assert.equal(generic[0].credentialValue, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
