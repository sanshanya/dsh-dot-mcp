#!/usr/bin/env node
/**
 * Probe a LIVE bridge and print a report that two rounds can actually compare.
 *
 * Design rules, each one paid for by a review:
 *
 * 1. **Line 1 holds only invariants.** No timestamps, no pid, no protocol
 *    constant, no tool count: those all move between two runs of the SAME code
 *    (`started_at` changes on every restart; `MCP_PROTOCOL_VERSION` is the
 *    hardcoded '2024-11-05'; the tool count is the volatile `surface`). Line 1
 *    must be the line you diff.
 * 2. **The verdict is an assertion, not a self-report.** `--expect-sha` compares
 *    what the process says it is running against the sha you built. A process
 *    self-reporting `state=current` is a claim, not evidence: a clean install of
 *    an old tarball reports `current` too.
 * 3. **Read-only.** Three round trips, no session is created and no turn is
 *    started, because the usual target is a host with live work in it.
 *
 * Usage:
 *   node scripts/probe-wire.mjs [--url http://127.0.0.1:3456/mcp]
 *       [--status-url http://127.0.0.1:3456/status] [--expect-sha <16hex>]
 *       [--json] [--timeout 5000]
 *
 * Exit: 0 all probes ran and assertions held · 1 an assertion failed · 2 transport.
 */
const DEFAULT_URL = 'http://127.0.0.1:3456/mcp';

function parseArgs(argv) {
  const out = { url: DEFAULT_URL, expectSha: undefined, json: false, timeout: 5000, statusUrl: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--url') out.url = argv[++i];
    else if (arg === '--status-url') out.statusUrl = argv[++i];
    else if (arg === '--expect-sha') out.expectSha = argv[++i];
    else if (arg === '--timeout') out.timeout = Number(argv[++i]);
    else if (arg === '--help' || arg === '-h') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

/** MCP over Streamable HTTP answers either JSON or an SSE frame. */
function parsePayload(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  const lines = trimmed.split('\n').filter((line) => line.startsWith('data: '));
  if (lines.length === 0) throw new Error(`unparseable response: ${trimmed.slice(0, 120)}`);
  return JSON.parse(lines[lines.length - 1].slice('data: '.length));
}

function makeRpc(url, timeout) {
  return async function rpc(method, params = {}) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now() % 100000, method, params }),
      signal: AbortSignal.timeout(timeout),
    });
    return parsePayload(await response.text());
  };
}

const bytes = (value) => JSON.stringify(value, null, 2).length;
const hex16 = (value) => typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log('node scripts/probe-wire.mjs [--url URL] [--status-url URL] [--expect-sha 16hex] [--json] [--timeout MS]');
    return 0;
  }

  const rpc = makeRpc(args.url, args.timeout);
  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok, detail });

  // ── transport ─────────────────────────────────────────────────────────────
  let listed;
  try {
    await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'dsh-probe', version: '1' },
    });
    listed = await rpc('tools/list');
  } catch (error) {
    console.error(`probe: cannot reach ${args.url} (${error instanceof Error ? error.message : String(error)})`);
    return 2;
  }
  const toolNames = (listed?.result?.tools ?? []).map((tool) => tool.name);

  // ── identity ──────────────────────────────────────────────────────────────
  const healthEnvelope = await rpc('tools/call', { name: 'dsh_health', arguments: {} });
  const healthText = healthEnvelope?.result?.content?.[0]?.text;
  let health;
  try { health = JSON.parse(healthText); } catch { health = undefined; }

  const bridge = health?.bridge ?? {};
  const codeState = health?.code?.state;
  const sha = bridge.artifact_sha256;
  check('health answers over the real wire', health !== undefined, health === undefined ? 'no parseable dsh_health payload' : undefined);
  check('health identifies the artifact', hex16(sha), sha === undefined ? 'bridge.artifact_sha256 missing' : undefined);
  check('health reports code freshness', codeState === 'current' || codeState === 'stale' || codeState === 'unknown',
    codeState === undefined ? 'code.state missing — this build predates the freshness field' : undefined);
  if (args.expectSha !== undefined) {
    check(`the running code is the build we expect (${args.expectSha})`, sha === args.expectSha,
      sha === args.expectSha ? undefined : `process reports ${sha ?? 'nothing'} — it loaded a different artifact`);
  }

  // ── error representation ──────────────────────────────────────────────────
  // A session that cannot exist: deterministic, read-only, no side effects.
  const failure = await rpc('tools/call', {
    name: 'dsh_get_task_status',
    arguments: { session_id: 'probe-no-such-session' },
  });
  const errorBody = failure?.result?.content?.[0]?.text;
  let parsedError;
  try { parsedError = JSON.parse(errorBody); } catch { parsedError = undefined; }
  const structured = failure?.result?.structuredContent;
  check('a failure fails closed', failure?.result?.isError === true, failure?.result?.isError === true ? undefined : 'isError was not set');
  check('the error carries a machine code', typeof parsedError?.error?.code === 'string',
    parsedError?.error?.code === undefined ? 'no error.code in the text block' : undefined);
  check('text and structured representations agree', structured !== undefined && JSON.stringify(structured) === JSON.stringify(parsedError),
    structured === undefined
      ? 'no structuredContent — a client-side connector has to invent one'
      : JSON.stringify(structured) === JSON.stringify(parsedError) ? undefined : 'text and structuredContent disagree');

  // ── budget ────────────────────────────────────────────────────────────────
  const budget = await rpc('tools/call', {
    name: 'dsh_get_result',
    arguments: { session_id: 'probe-no-such-session', total_max_chars: 500 },
  });
  const budgetServed = bytes(budget?.result ?? {});
  check('an unknown session is refused, not answered', budget?.result?.isError === true,
    `served ${budgetServed} chars for a session that does not exist`);

  const failed = checks.filter((entry) => !entry.ok);
  const surface = health?.surface?.tier;
  const line1 = `${bridge.name ?? 'dsh-dot-mcp'} ${bridge.version ?? '?'} · code ${sha ?? 'unknown'} state=${codeState ?? 'unknown'}`
    + (args.expectSha === undefined ? '' : ` expect=${args.expectSha}${sha === args.expectSha ? ' ✓' : ' ✗'}`);

  if (args.json) {
    console.log(JSON.stringify({
      schema: 1,
      identity: { name: bridge.name, version: bridge.version, code_sha256: sha ?? null, code_state: codeState ?? null, expected_sha256: args.expectSha ?? null },
      volatile: {
        instance_id: bridge.instance_id ?? null,
        started_at: bridge.started_at ?? null,
        build_time: bridge.build_time ?? null,
        surface: surface ?? null,
        tool_count: toolNames.length,
        bridge_url: args.url,
      },
      checks,
      failed: failed.length,
    }, null, 2));
  } else {
    console.log(line1);
    console.log('---');
    console.log(`  surface    ${surface ?? '?'} (${toolNames.length} tools)`);
    console.log(`  instance   ${bridge.instance_id ?? '?'} · started ${bridge.started_at ?? '?'}`);
    console.log(`  build      ${bridge.build_time ?? '?'}`);
    console.log(`  bridge     ${args.url}`);
    for (const entry of checks) {
      console.log(`  ${entry.ok ? '✔' : '✖'} ${entry.name}${entry.ok ? '' : `  ← ${entry.detail}`}`);
    }
    if (args.statusUrl !== undefined) {
      try {
        const status = await (await fetch(args.statusUrl, { signal: AbortSignal.timeout(args.timeout) })).json();
        const code = status?.health?.code ?? {};
        console.log(`  /status    state=${code.state ?? '?'} files=${code.files ?? '?'} stamp_matches=${code.stamp_matches ?? '?'}`
          + (code.changed_total === undefined ? '' : ` changed=${code.changed_total}`));
        if (Array.isArray(code.changed) && code.changed.length > 0) console.log(`             ${code.changed.join(', ')}`);
      } catch (error) {
        console.log(`  /status    unreachable (${error instanceof Error ? error.message : String(error)})`);
      }
    }
    console.log(failed.length === 0 ? '\nprobe: all checks passed' : `\nprobe: ${failed.length} check(s) failed`);
  }

  return failed.length === 0 ? 0 : 1;
}

process.exit(await main());