#!/usr/bin/env node
/**
 * The one ruler for tool-surface cost.
 *
 * Every "we saved N%" claim in docs/0.9-tool-surface.md must be reproducible
 * with this script. It measures what a client actually receives, not what the
 * source looks like:
 *
 *   static  — build a server for a surface and drive a real `tools/list` over an
 *             in-memory transport (same projection the HTTP path serves).
 *   served  — POST initialize + tools/list at a live bridge and measure the
 *             raw response bytes.
 *
 * The two modes must agree within 2% (M1). If they do not, the static formula
 * is wrong and every budget number derived from it is void.
 *
 * Usage:
 *   node scripts/surface-cost.mjs [--surface core|full] [--mode static|served]
 *                                [--url http://127.0.0.1:3456/mcp] [--json]
 *   node scripts/surface-cost.mjs --all          # both surfaces, both modes
 */
import { readFileSync } from 'node:fs';

const CHARS_PER_TOKEN = [3.0, 3.6, 4.0];

/** Compact serialization — this is the unit every budget in the docs uses. */
const bytes = (value) => JSON.stringify(value).length;

/** Split one tool definition into the prose and the structural remainder. */
function splitTool(tool) {
  const description = (tool.description ?? '').length;
  const title = (tool.title ?? '').length;
  const schema = JSON.stringify(tool.inputSchema ?? {});
  let paramDescriptions = 0;
  for (const value of Object.values(tool.inputSchema?.properties ?? {})) {
    paramDescriptions += (value?.description ?? '').length;
  }
  const total = bytes(tool);
  return {
    name: tool.name,
    total,
    description,
    title,
    schema: schema.length,
    paramDescriptions,
    prose: description + paramDescriptions,
    structural: total - description - paramDescriptions,
  };
}

/** Measure a surface by driving a real tools/list over an in-memory transport. */
export async function measureStatic(surface) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
  const { createMcpServer } = await import('../lib/mcp.js');

  const server = createMcpServer({}, surface);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  const client = new Client({ name: 'surface-cost', version: '0.0.0' });
  await client.connect(clientSide);
  try {
    const { tools } = await client.listTools();
    return summarize(surface, tools);
  } finally {
    await client.close();
    await server.close();
  }
}

/** Measure a surface by asking a live bridge and reading the raw bytes. */
export async function measureServed(surface, url = 'http://127.0.0.1:3456/mcp') {
  const post = async (body) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify(body),
    });
    const text = await response.text();
    const payload = text.includes('data: ') ? text.slice(text.lastIndexOf('data: ') + 6).trim() : text.trim();
    return { text, json: JSON.parse(payload) };
  };

  await post({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'surface-cost', version: '0.0.0' } },
  });
  const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const summary = summarize(surface, listed.json.result.tools);
  summary.rawResponseBytes = listed.text.length;
  return summary;
}

function summarize(surface, tools) {
  const rows = tools.map(splitTool).sort((a, b) => b.total - a.total);
  const total = rows.reduce((sum, row) => sum + row.total, 0);
  const prose = rows.reduce((sum, row) => sum + row.prose, 0);
  const schemaTax = rows.length * '"$schema":"http://json-schema.org/draft-07/schema#",'.length;
  return {
    surface,
    tools: rows.length,
    total,
    // Whole-array serialization: brackets + separators a client also pays for.
    wireTotal: bytes(tools),
    prose,
    proseShare: total === 0 ? 0 : Math.round((prose / total) * 100),
    schemaTax,
    tokens: CHARS_PER_TOKEN.map((cpt) => Math.round(total / cpt)),
    largest: rows.slice(0, 5).map(({ name, total: size }) => ({ name, total: size })),
    detail: rows,
  };
}

/** Load the committed budget fixture. */
export function loadBudget(path = new URL('../test/fixtures/surface-budget.json', import.meta.url)) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function print(summary, label) {
  const [lean, mid, rich] = summary.tokens;
  console.log(`${label}${summary.surface}: ${summary.tools} tools, ${summary.total} chars (wire ${summary.wireTotal})`);
  console.log(`  prose ${summary.prose} (${summary.proseShare}%) · $schema tax ${summary.schemaTax} · ~${lean}k-${rich}k tokens (~${mid}k)`);
  const top = summary.largest.map((r) => `${r.name}=${r.total}`).join('  ');
  console.log(`  largest: ${top}`);
}

async function main(argv) {
  const flag = (name, fallback) => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? fallback : argv[index + 1];
  };
  const json = argv.includes('--json');
  const url = flag('url', 'http://127.0.0.1:3456/mcp');
  const surfaces = argv.includes('--all') ? ['core', 'full'] : [flag('surface', 'core')];
  const modes = argv.includes('--all') ? ['static', 'served'] : [flag('mode', 'static')];

  const out = [];
  for (const surface of surfaces) {
    for (const mode of modes) {
      const summary = mode === 'served' ? await measureServed(surface, url) : await measureStatic(surface);
      out.push({ mode, ...summary });
      if (!json) print(summary, `[${mode}] `);
    }
  }

  if (json) {
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  // M1: static and served must agree, or the ruler is broken.
  if (argv.includes('--all')) {
    for (const surface of surfaces) {
      const s = out.find((r) => r.mode === 'static' && r.surface === surface);
      const d = out.find((r) => r.mode === 'served' && r.surface === surface);
      const delta = Math.abs(s.total - d.total) / s.total;
      const verdict = delta < 0.02 ? 'OK' : 'MISMATCH';
      console.log(`M1 ${surface}: static ${s.total} vs served ${d.total} → ${(delta * 100).toFixed(1)}% ${verdict}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main(process.argv.slice(2));
}