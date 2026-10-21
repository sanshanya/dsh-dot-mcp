import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInThisContext } from 'node:vm';

// Executes the built closure bundle against a fake GUI module table and
// client context, asserting the tab contribution the browser will register.
test('client bundle registers the settings.plugins.tab contribution as dot-mcp', async () => {
  const captured = { registration: undefined, entryId: undefined, slotName: undefined };
  const windowStub = {
    __ModuleLoader__: {
      load({ id, factory }) { captured.id = id; captured.factory = factory; },
    },
  };
  const source = readFileSync(new URL('../../lib/client.js', import.meta.url), 'utf8');
  const loader = runInThisContext(`(window) => { ${source}\n}`);
  loader(windowStub);
  assert.equal(captured.id, 'dsh-dot-mcp');

  // Framework packages come from the host module table at runtime; apply()
  // never renders, so inert proxies suffice for the two imports.
  const inert = new Proxy({}, { get: () => inert });
  const fakeRequire = () => inert;
  const moduleExports = captured.factory(fakeRequire);
  assert.equal(typeof moduleExports?.apply, 'function');

  const form = {
    getSnapshot: () => ({ status: 'ready', value: undefined, base: undefined, user: undefined, revision: 3, writable: true, mode: 'host' }),
    subscribe: () => () => {},
    set: async () => true,
    unset: async () => true,
  };
  const ctx = {
    effect(fn) { fn?.(); },
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    configForms: {
      get(entryId) { captured.entryId = entryId; return form; },
      whileServed(namespaces, register) { return register(new Set(namespaces)); },
    },
    slots: {
      inject(name, contribution) { captured.slotName = name; contribution?.(); return () => {}; },
      register(options, component) { captured.registration = { options, component }; return {}; },
    },
  };
  moduleExports.apply(ctx);

  assert.equal(captured.entryId, 'dot-mcp', 'the panel reads the host config form for our loader row id');
  assert.equal(captured.slotName, 'settings.plugins.tab');
  assert.deepEqual(
    { name: captured.registration.options.name, id: captured.registration.options.id, order: captured.registration.options.order },
    { name: 'settings.plugins.tab', id: 'dot-mcp', order: 20 },
  );
  assert.equal(typeof captured.registration.options.label, 'function');
  assert.equal(typeof captured.registration.options.inject, 'function');
  assert.equal(typeof captured.registration.component, 'function');
});
