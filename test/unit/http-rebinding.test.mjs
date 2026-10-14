import { test } from 'node:test';
import http from 'node:http';
import assert from 'node:assert/strict';
import { startHttpServer } from '../../lib/http.js';
import { createMcpServer } from '../../lib/mcp.js';
import { createBridgeLogger } from '../../lib/log.js';

function silent() {
  return createBridgeLogger({ level: 'error', dshHome: process.cwd(), stdioSafe: true });
}
function fakeBridge() {
  return { /* tests never reach tool dispatch */ };
}

async function post(port, { origin, host } = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
  };
  if (origin !== undefined) headers.origin = origin;
  if (host !== undefined) headers.host = host;
  return fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'rebinding-test', version: '1' } },
    }),
  });
}

test('loopback clients without an Origin pass DNS-rebinding protection', async () => {
  const log = silent();
  const handle = await startHttpServer(() => createMcpServer(fakeBridge(), { resultMaxChars: 66 }, log), { host: '127.0.0.1', port: 0 }, log);
  try {
    const res = await post(handle.port);
    assert.equal(res.status, 200);
  } finally {
    await handle.close();
  }
});

test('a browser page with a foreign Origin is refused before dispatch (0.6.3)', async () => {
  const log = silent();
  const handle = await startHttpServer(() => createMcpServer(fakeBridge(), { resultMaxChars: 66 }, log), { host: '127.0.0.1', port: 0 }, log);
  try {
    const res = await post(handle.port, { origin: 'http://evil.example' });
    assert.equal(res.status, 403);
  } finally {
    await handle.close();
  }
});

test('stateless transport: consecutive calls need no Mcp-Session-Id (0.8.0)', async () => {
  const log = silent();
  const bridge = {
    // handlers are lazy; only dsh_health is dispatched below
    health: async () => ({ bridge: 'ok' }),
  };
  const handle = await startHttpServer(() => createMcpServer(bridge, { resultMaxChars: 1000 }, log), { host: '127.0.0.1', port: 0 }, log);
  const rpc = (method, params, id) => fetch(`http://127.0.0.1:${handle.port}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } }, 1);
    assert.equal(init.status, 200);
    assert.equal(init.headers.get('mcp-session-id'), null, 'stateless mode must not mint session ids');
    const list = await rpc('tools/list', {}, 2);
    assert.equal(list.status, 200);
    const call = await rpc('tools/call', { name: 'dsh_health', arguments: {} }, 3);
    assert.equal(call.status, 200);
    const body = await call.text();
    assert.match(body, /dsh_health|"result"/);
  } finally {
    await handle.close();
  }
});

test('GET and DELETE on /mcp are refused in stateless mode (0.8.0)', async () => {
  const log = silent();
  const handle = await startHttpServer(() => createMcpServer(fakeBridge(), { resultMaxChars: 66 }, log), { host: '127.0.0.1', port: 0 }, log);
  try {
    for (const method of ['GET', 'DELETE']) {
      const res = await fetch(`http://127.0.0.1:${handle.port}/mcp`, { method });
      assert.equal(res.status, 405);
    }
  } finally {
    await handle.close();
  }
});

test('a DNS-rebound Host is refused before dispatch (0.6.3)', async () => {
  const log = silent();
  const handle = await startHttpServer(() => createMcpServer(fakeBridge(), { resultMaxChars: 66 }, log), { host: '127.0.0.1', port: 0 }, log);
  try {
    // undici forbids overriding Host; use a raw socket-level request here.
    const status = await new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: handle.port, path: '/mcp', method: 'POST',
          headers: { host: 'attacker-controlled.example', 'content-type': 'application/json',
                     accept: 'application/json, text/event-stream' } },
        (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x', version: '1' } } }));
    });
    assert.equal(status, 403);
  } finally {
    await handle.close();
  }
});
