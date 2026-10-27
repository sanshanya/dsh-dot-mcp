/**
 * MCP server surface: build the server DSH mounts, register the frozen tool
 * table for one surface, and hand it back. The declarations live in `tools.ts`
 * and the result convention in `mcp-result.ts`; this module owns only the
 * server object.
 *
 * `surface` is resolved by the caller per request (HTTP is stateless and builds
 * a server for every POST), so flipping the volatile config switches the served
 * vocabulary on the next `tools/list` without a host restart.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Bridge } from './bridge.js';
import { registerBridgeTools } from './tools.js';
import { BRIDGE_NAME, BRIDGE_VERSION } from './version.js';
import { DEFAULT_SURFACE, type Surface } from './shared/surface.js';

export function createMcpServer(bridge: Bridge, surface: Surface = DEFAULT_SURFACE): McpServer {
  const server = new McpServer(
    { name: BRIDGE_NAME, version: BRIDGE_VERSION },
    { capabilities: { tools: {} } },
  );
  registerBridgeTools(server, bridge, surface);
  return server;
}