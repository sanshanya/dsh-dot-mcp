/**
 * MCP server surface: build the server DSH mounts, register the frozen tool
 * table, and hand it back. The declarations live in `tools.ts` and the result
 * convention in `mcp-result.ts`; this module owns only the server object.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Bridge } from './bridge.js';
import { registerBridgeTools } from './tools.js';
import { BRIDGE_NAME, BRIDGE_VERSION } from './version.js';

export function createMcpServer(bridge: Bridge): McpServer {
  const server = new McpServer(
    { name: BRIDGE_NAME, version: BRIDGE_VERSION },
    { capabilities: { tools: {} } },
  );
  registerBridgeTools(server, bridge);
  return server;
}
