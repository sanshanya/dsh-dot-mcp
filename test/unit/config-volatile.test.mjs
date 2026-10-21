import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVolatile } from '@deepseek-ai/cosmokit';
import { ConfigSchema, liveValue } from '../../lib/config.js';

// The DSH settings UI edits only fields schemastery marks volatile and
// SettingsForms projects; dropping a marker silently removes the field from
// the panel without touching any runtime behavior, so pin the ledger.
const VOLATILE_KEYS = ['resultMaxChars', 'resultMaxItems', 'sessionMaxItems', 'sessionMaxChars', 'logLevel', 'autoApproveEscalations'];
const PLAIN_KEYS = ['transport', 'host', 'port'];

test('Config schema marks budgets, logLevel and autoApproveEscalations volatile', () => {
  const dict = ConfigSchema.dict ?? {};
  for (const key of VOLATILE_KEYS) {
    assert.equal(dict[key]?.meta?.volatile, true, `${key} must stay volatile (settings UI writes it live)`);
  }
});

test('Config schema keeps transport/host/port plain (a live edit would orphan the bound listener)', () => {
  const dict = ConfigSchema.dict ?? {};
  for (const key of PLAIN_KEYS) {
    assert.notEqual(dict[key]?.meta?.volatile, true, `${key} must stay non-volatile`);
  }
});

test('liveValue unwraps Volatile handles and passes plain values through', () => {
  assert.equal(liveValue(42), 42);
  assert.equal(liveValue(createVolatile(7)), 7);
  assert.equal(liveValue(false), false);
  assert.equal(liveValue(createVolatile(true)), true);
});
