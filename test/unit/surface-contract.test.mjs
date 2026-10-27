/**
 * The surface contract: which names a deployment serves, what they cost, and
 * whether the served text can point a model at a door that does not exist.
 *
 * These are the V1/V2 release gates that do not need a live host — the budget
 * ratchet (F1), the description caps, core⊂full (F7 static half), the
 * no-dangling-reference rule (F5 static half) and the health self-report.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServer } from '../../lib/mcp.js';
import { Bridge } from '../../lib/bridge.js';
import { measureStatic, loadBudget } from '../../scripts/surface-cost.mjs';
import {
  CORE_TOOL_NAMES,
  FROZEN_TOOL_NAMES,
  FULL_ONLY_TOOL_NAMES,
  TOOL_REPLACEMENTS,
} from '../integration/frozen-wire.mjs';

const names = (surface) => Object.keys(createMcpServer({}, surface)._registeredTools).sort();

function stubBridge({ goalService } = {}) {
  const services = {
    agents: { get: () => undefined, list: () => [] },
    sessions: { list: () => [], get: () => undefined },
    sessionPersistence: { list: async () => [] },
    agentDefaultModel: { currentSelection: () => ({ provider: 'p', model: 'm' }) },
    goals: goalService ?? { get: () => undefined, create: () => undefined },
    workspaceRegistry: { list: () => [] },
  };
  const ctx = {
    get: (key) => services[key],
    agents: services.agents,
    sessions: services.sessions,
    sessionPersistence: services.sessionPersistence,
    agentDefaultModel: services.agentDefaultModel,
    on: () => {},
  };
  const log = { debug() {}, info() {}, warn() {}, error() {} };
  return new Bridge(ctx, { sessionMaxItems: 5, sessionMaxChars: 200, resultMaxItems: 10, resultMaxChars: 500 }, log);
}

test('surface: core is the default and serves one door per intent', () => {
  assert.deepEqual(names(), [...CORE_TOOL_NAMES].sort());
  assert.deepEqual(names('core'), [...CORE_TOOL_NAMES].sort());
  assert.equal(names().length, 15);
});

test('surface: full serves every frozen name', () => {
  assert.deepEqual(names('full'), [...FROZEN_TOOL_NAMES].sort());
  assert.equal(names('full').length, 22);
});

test('surface: core and full differ by exactly the documented doors', () => {
  const core = new Set(names('core'));
  const full = new Set(names('full'));
  for (const name of core) assert.ok(full.has(name), `${name} must also exist on full`);
  assert.deepEqual([...full].filter((n) => !core.has(n)).sort(), [...FULL_ONLY_TOOL_NAMES].sort());
});

test('surface: every full-only goal/session alias has a core door for its verb', () => {
  const core = new Set(names('core'));
  for (const name of FULL_ONLY_TOOL_NAMES) {
    // The credential dump is the one exception: reading secrets has no core door.
    if (name === 'dsh_credential_status') continue;
    const replacement = TOOL_REPLACEMENTS[name];
    assert.ok(replacement, `${name} needs a documented replacement`);
    assert.ok(core.has(replacement), `${name} → ${replacement} must exist on core`);
  }
});

test('F1 budget ratchet: the served vocabulary stays inside its measured budget', async () => {
  const budget = loadBudget();
  for (const surface of ['core', 'full']) {
    const measured = await measureStatic(surface);
    const limits = budget[surface];
    assert.ok(limits, `budget fixture needs a ${surface} entry`);
    assert.ok(
      measured.total <= limits.maxTotal,
      `${surface}: ${measured.total} chars exceeds the ${limits.maxTotal} budget — shrink prose, not capability`,
    );
    assert.equal(measured.tools, limits.tools, `${surface}: tool count drifted from the fixture`);
    for (const row of measured.detail) {
      assert.ok(
        row.total <= limits.maxTool,
        `${row.name}: ${row.total} chars exceeds the ${limits.maxTool} per-tool cap`,
      );
      assert.ok(
        row.description <= limits.maxDescription,
        `${row.name}: description is ${row.description} chars (cap ${limits.maxDescription})`,
      );
    }
  }
});

test('F1 budget ratchet: core is at least 40% cheaper than the 0.8.0 surface', async () => {
  const budget = loadBudget();
  const core = await measureStatic('core');
  const shrink = 1 - core.total / budget.baseline_0_8_0;
  assert.ok(shrink >= 0.4, `core only shrank ${(shrink * 100).toFixed(1)}% against 0.8.0`);
});

test('F5: no core-visible text points at a door that core does not serve', () => {
  const hidden = new Set(FULL_ONLY_TOOL_NAMES);
  const server = createMcpServer({}, 'core');
  for (const [name, tool] of Object.entries(server._registeredTools)) {
    const text = JSON.stringify({
      description: tool.description,
      title: tool.title,
      params: Object.fromEntries(
        Object.entries(tool.inputSchema?.shape ?? {}).map(([key, value]) => [key, value?.description]),
      ),
    });
    for (const hiddenName of hidden) {
      assert.ok(
        !text.includes(hiddenName),
        `${name} mentions ${hiddenName}, which does not exist on core: the model will call a dead door`,
      );
    }
  }
});

test('health reports the surface it was built for, with a name hash', async () => {
  const core = await stubBridge().health('core');
  const full = await stubBridge().health('full');
  assert.equal(core.surface.tier, 'core');
  assert.equal(core.surface.tool_count, 15);
  assert.equal(full.surface.tier, 'full');
  assert.equal(full.surface.tool_count, 22);
  assert.match(core.surface.tools_sha256, /^[0-9a-f]{16}$/);
  assert.notEqual(core.surface.tools_sha256, full.surface.tools_sha256);
  // The migration map ships as data so a client can translate without guessing.
  assert.equal(core.surface.replacements.dsh_get_session, 'dsh_get_task_status');
});

test('get_task_status advertises detail without changing the default projection', () => {
  const server = createMcpServer({}, 'core');
  const shape = server._registeredTools.dsh_get_task_status.inputSchema.shape;
  assert.ok('detail' in shape, 'detail is how the read merge stays backward compatible');
  assert.equal(shape.detail.safeParse(undefined).success, true, 'detail must stay optional');
  assert.ok('max_items' in shape && 'max_chars' in shape);
});