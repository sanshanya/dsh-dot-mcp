import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startHttpServer } from '../../lib/http.js';
import { createMcpServer } from '../../lib/mcp.js';
import { createBridgeLogger } from '../../lib/log.js';

function silent() {
  return createBridgeLogger({ level: 'error', dshHome: process.cwd(), stdioSafe: true });
}
function fakeBridge() {
  return { health: async () => ({ bridge: 'ok', sessions: { live: 1, persisted: 2, active: 0 } }) };
}

async function start(extras) {
  const log = silent();
  return startHttpServer(() => createMcpServer(fakeBridge(), {}, log), { host: '127.0.0.1', port: 0 }, log, extras);
}

test('GET /status answers the health payload to a loopback browser page', async () => {
  const handle = await start({ statusReport: () => fakeBridge().health() });
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/status`, {
      headers: { origin: 'http://127.0.0.1:3080' },
    });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://127.0.0.1:3080');
    const body = await res.json();
    assert.equal(body.enabled, true);
    assert.equal(body.state, 'running');
    assert.equal(body.health.bridge, 'ok');
  } finally {
    await handle.close();
  }
});

test('GET /status refuses a foreign browser origin', async () => {
  const handle = await start({ statusReport: () => fakeBridge().health() });
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/status`, {
      headers: { origin: 'http://evil.example' },
    });
    assert.equal(res.status, 403);
  } finally {
    await handle.close();
  }
});

test('without a statusReport the /status route stays unmounted', async () => {
  const handle = await start({});
  try {
    const res = await fetch(`http://127.0.0.1:${handle.port}/status`);
    assert.equal(res.status, 404);
  } finally {
    await handle.close();
  }
});

test('disabled gate refuses MCP traffic with 503 while /status keeps answering', async () => {
  let enabled = false;
  const handle = await start({ isEnabled: () => enabled, statusReport: () => fakeBridge().health() });
  try {
    const mcp = await fetch(`http://127.0.0.1:${handle.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }),
    });
    assert.equal(mcp.status, 503);
    const stop = await mcp.json();
    assert.equal(stop.error.message, 'bridge-disabled');
    const status = await (await fetch(`http://127.0.0.1:${handle.port}/status`)).json();
    assert.equal(status.state, 'disabled');
    enabled = true;
    const live = await fetch(`http://127.0.0.1:${handle.port}/status`);
    assert.equal((await live.json()).state, 'running');
  } finally {
    await handle.close();
  }
});
