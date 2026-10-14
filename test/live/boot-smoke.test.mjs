/**
 * Live boot smoke lane — the wire contract checked against a REAL booted
 * host, not a mock (M1; the goal-lifecycle warm lane is M2).
 *
 * Ritual (the same one better-model-provider runs, adapted to a server-side
 * plugin): build + pack the publishable artifact, strip it into a throwaway
 * `<BRIDGE_LIVE workspace>/package`, install it into a throwaway profile
 * (`profiles/bridge-live`) next to the checkout's OWN client bundles
 * (version read from `packages/boot/app-boot/package.json` — the harness's
 * own definition of its generation, never an env guess and never a
 * published rc), boot that checkout's CLI, harvest its printed loopback
 * URL — query included, master prints `?token=…` and a bare-origin regex
 * would strand the auth exchange — then speak real JSON-RPC to the bridge's
 * MCP endpoint and hold four pins to it:
 *
 *   1. tools/list returns EXACTLY the 21 frozen names (served vocabulary, from
 *      the one literal owner test/integration/frozen-wire.mjs — never imported
 *      from the code under test, which could never fail that way);
 *   2. dsh_health answers over real HTTP;
 *   3. dsh_get_task_status on a session that never existed fails CLOSED,
 *      not by inventing a session;
 *   4. the whole thing survives boot order: if plugin admission rejected the
 *      cordis patch (unknown config keys, wrong peers), no URL and no tools
 *      ever appear and the lane reports THAT, verbatim.
 *
 * The patch's `port: 3456` is rewritten inside the extracted tarball before
 * install to a probed free port: the lane must never touch a production
 * listener running on this machine (and 0.6.3-era instances do hold 3456).
 *
 * Opt-in by design: set BRIDGE_DSH_DIR to a deepseek-harness checkout with
 * `pnpm install` already run. BRIDGE_LIVE_KEEP preserves the throwaway home
 * for postmortem.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { FROZEN_TOOL_NAMES } from '../integration/frozen-wire.mjs';

const shell = process.platform === 'win32';
const repo = new URL('../../', import.meta.url).pathname;

/** The frozen wire has ONE owner: test/integration/frozen-wire.mjs. */

/** The version the harness checkout defines for itself (see file header). */
function resolveBundleVersion(dshDir) {
  const manifest = join(dshDir, 'packages', 'boot', 'app-boot', 'package.json');
  let parsed;
  try { parsed = JSON.parse(readFileSync(manifest, 'utf8')); } catch (error) {
    throw new Error(`live boot: cannot read the harness's own version from ${manifest}: ${error}`);
  }
  if (typeof parsed.version !== 'string' || parsed.version === '') {
    throw new Error(`live boot: ${manifest} carries no version; this lane pins to the checkout it boots and refuses to guess`);
  }
  return parsed.version;
}

/** A loopback port nobody (including any production listener here) holds. */
function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => resolvePort(address.port));
    });
  });
}

/** One JSON-RPC call against the stateless MCP endpoint. */
async function rpc(url, method, params) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const text = await response.text();
  // Stateless mode may answer as SSE: take the last JSON data frame.
  const frames = [...text.matchAll(/^data: (.*)$/gm)].map((m) => m[1]);
  const payload = frames.length > 0 ? frames[frames.length - 1] : text;
  return JSON.parse(payload);
}

const dshDir = process.env.BRIDGE_DSH_DIR;
test('live: real host boots the packed plugin and serves the frozen 21-tool wire', {
  skip: dshDir === undefined || dshDir.trim() === '',
  timeout: 300_000,
}, async (t) => {
  const checkout = resolve(dshDir);
  const bundleVersion = resolveBundleVersion(checkout);
  const bridgePort = await freePort();
  const work = mkdtempSync(join(tmpdir(), 'bridge-live-'));
  let server;
  const dispose = async () => {
    if (server !== undefined && server.exitCode === null && server.signalCode === null) {
      const closed = new Promise((resolve) => { server.once('exit', resolve); });
      server.kill('SIGTERM');
      // Bounded: a host that ignores SIGTERM must not hang the lane forever.
      await Promise.race([closed, new Promise((resolve) => { setTimeout(resolve, 10_000); })]);
      if (server.exitCode === null && server.signalCode === null) server.kill('SIGKILL');
    }
    if (process.env.BRIDGE_LIVE_KEEP !== undefined) return;
    // The killed host's own children can still be flushing into the tree;
    // recursive removal races them (ENOTEMPTY) unless given a bounded retry.
    for (let attempt = 0; ; attempt++) {
      try {
        rmSync(work, { recursive: true, force: true });
        return;
      } catch (error) {
        if (attempt >= 5) throw error;
        await new Promise((resolve) => { setTimeout(resolve, 200); });
      }
    }
  };
  t.after(dispose);

  execFileSync('npm', ['run', 'build'], { cwd: repo, stdio: 'pipe', shell });
  const packOut = execFileSync('npm', ['pack', '--pack-destination', work], { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], shell });
  const tarball = join(work, packOut.trim().split('\n').pop());
  execFileSync('tar', ['xzf', tarball, '-C', work], { stdio: 'pipe' });
  const pluginDir = join(work, 'package');

  // Isolation patch to the tarball copy only: bind a probed port, never 3456.
  const patchPath = join(pluginDir, 'cordis.patch.yml');
  const patch = readFileSync(patchPath, 'utf8');
  assert.match(patch, /port: 3456/, 'the shipped cordis patch pins port 3456 — the isolation rewrite refuses to guess where the port lives');
  writeFileSync(patchPath, patch.replace('port: 3456', `port: ${bridgePort}`));

  const clientBundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
  const profileDir = join(work, 'profiles', 'bridge-live');
  mkdirSync(profileDir, { recursive: true });
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-bridge-live',
    private: true,
    dsh: { profile: { bundles: [...clientBundles, 'dsh-dot-mcp'] } },
    dependencies: {
      // file:, never link:: pnpm install COPIES the package into the
      // profile's node_modules, where it can resolve its peer deps against
      // the same tree exactly like a registry install. A link: survives
      // as a symlink whose realpath carries no node_modules — the dev tree
      // only looks like it works because the repo root sits behind it.
      'dsh-dot-mcp': `file:${pluginDir}`,
      ...Object.fromEntries(clientBundles.map((name) => [name, bundleVersion])),
    },
  }, null, 1));
  execFileSync('pnpm', ['install', '--ignore-scripts'], { cwd: profileDir, stdio: 'pipe', shell });
  console.log(`live boot: dsh ${bundleVersion}; bridge on 127.0.0.1:${bridgePort}; profile at ${profileDir}${process.env.BRIDGE_LIVE_KEEP !== undefined ? ' (kept)' : ''}`);

  server = spawn('node', ['--import', 'tsx/esm', join(checkout, 'apps/cli/src/bin.ts'), '--profile', 'bridge-live', '--host', '127.0.0.1', '--port', '0'], {
    cwd: checkout,
    env: { ...process.env, DSH_HOME: work },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let cliOut = '';
  const printed = await new Promise((resolveUrl, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error(`live boot: URL never printed; output so far:\n${out}`)), 120_000);
    const probe = (chunk) => {
      cliOut += String(chunk);
      out = cliOut;
      const found = /https?:\/\/127\.0\.0\.1:\d+(?:\/\?\S*)?/.exec(out);
      if (found) { clearTimeout(timer); resolveUrl(found[0]); }
    };
    server.stdout.on('data', probe);
    server.stderr.on('data', probe);
    server.on('error', (error) => { clearTimeout(timer); reject(error); });
    server.on('exit', (code) => { if (code !== 0 && code !== null) { clearTimeout(timer); reject(new Error(`live boot: CLI exited ${code}; output:\n${out}`)); } });
  });
  console.log(`live boot: host at ${printed}`);
  const baseUrl = new URL(printed).origin;

  // The serving check answers before the MCP one: no page, no plugin row.
  // The listener can lag the printed URL by plugin-load time; poll, and on
  // exhaustion print the CLI transcript — that IS the admission evidence.
  let page = '';
  const deadline = Date.now() + 30_000;
  for (;;) {
    page = await fetch(baseUrl).then((r) => r.text()).catch(() => '');
    if (page !== '' || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  if (page === '') console.error(`live boot: page never served at ${baseUrl}; CLI transcript:\n${cliOut}`);
  assert.notEqual(page, '', `live boot: the host served no page at ${baseUrl}`);

  const mcpUrl = `http://127.0.0.1:${bridgePort}/mcp`;
  await rpc(mcpUrl, 'initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'bridge-live', version: '0' } });
  const listed = await rpc(mcpUrl, 'tools/list', {});
  const names = [...(listed.result?.tools ?? [])].map((tool) => tool.name).sort();
  // exact idiomatic set-equality imports nothing from src/ (see pin 1).
  assert.deepEqual(names, [...FROZEN_TOOL_NAMES].sort());

  const health = await rpc(mcpUrl, 'tools/call', { name: 'dsh_health', arguments: {} });
  assert.equal(health.error, undefined, `dsh_health failed over the live wire: ${JSON.stringify(health.error)}`);
  assert.equal(health.result.isError, undefined, `dsh_health returned an error envelope: ${JSON.stringify(health.result)}`);

  const ghost = await rpc(mcpUrl, 'tools/call', { name: 'dsh_get_task_status', arguments: { session_id: 'definitely-not-a-session' } });
  const declared = ghost.error !== undefined ? String(ghost.error.code) : JSON.stringify(ghost.result);
  assert.match(declared, /4204|SessionNotFound|isError/, `unknown-session status must fail closed, got: ${declared}`);
});
