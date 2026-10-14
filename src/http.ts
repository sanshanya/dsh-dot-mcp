/**
 * Streamable HTTP transport for the MCP server, hosted on the bridge's own
 * node:http server. STATELESS mode (0.8.0): no MCP session tracking at all.
 * Every request builds one transport plus one thin McpServer instance around
 * the shared Bridge, answers, and is torn down when the response closes.
 * The bridge tools carry session_id as an explicit argument and the server
 * never pushes notifications, so transport-side sessions were pure
 * bookkeeping (a Map, an idle sweep, a cap). Loopback-only, unconditionally
 * (0.6.2: bearer-token machinery removed by operator decision; loopback is
 * the only remaining choke point).
 *
 * Endpoint:
 *   POST /mcp  JSON-RPC messages (initialize, tools/list, tools/call...)
 *   anything else  405 method-not-allowed
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { BridgeLogger } from './log.js';
import { bridgeHttpUrl, isLoopbackHost } from './config.js';

export interface HttpServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

const MAX_MCP_BODY_BYTES = 4 * 1024 * 1024; // 4MB

/** Read and parse a JSON request body (empty bodies yield undefined). */
function readJsonBody(req: IncomingMessage, maxBytes = MAX_MCP_BODY_BYTES): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error('payload-too-large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (raw.trim() === '') return resolve(undefined);
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve(undefined);
      }
    });
    req.on('error', reject);
  });
}

function setCors(res: ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function startHttpServer(
  createSessionServer: () => McpServer,
  options: { host: string; port: number },
  log: BridgeLogger,
): Promise<HttpServerHandle> {
  if (!isLoopbackHost(options.host)) {
    return Promise.reject(new Error(`non-loopback HTTP listeners are refused: ${options.host}`));
  }
  return new Promise((resolve, reject) => {

    let boundPort = options.port;
    /**
     * SDK compares allowedHosts with the raw Host header byte-for-byte (port
     * included). Build the allowance from the configured host plus the actual
     * bound port at request time (port 0 in tests resolves after listen).
     */
    const rebindingHosts = (): string[] => {
      const h = options.host;
      return [...new Set([h, `${h}:${boundPort}`, 'localhost', `localhost:${boundPort}`, '127.0.0.1', `127.0.0.1:${boundPort}`, '[::1]', `[::1]:${boundPort}`])];
    };

    const httpServer = createServer(async (req, res) => {
      let transport: StreamableHTTPServerTransport | undefined;
      let server: McpServer | undefined;
      try {
        setCors(res);
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }
        const url = req.url ?? '/';
        const path = url.split('?')[0];
        if (path !== '/mcp') {
          sendJson(res, 404, { error: 'not-found' });
          return;
        }
        if (req.method !== 'POST') {
          // Stateless servers answer request/response POSTs only: no
          // server-initiated SSE stream (GET) and nothing to close (DELETE).
          sendJson(res, 405, { error: 'method-not-allowed' });
          return;
        }
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: undefined, // stateless
          // 0.6.2 removed auth: loopback binding stops remote hosts but NOT a
          // malicious page in a local browser. SDK string-compare semantics:
          // allowedHosts entries must match the RAW Host header (port
          // included); allowedOrigins must be non-empty to be enforced, and
          // any non-empty list excludes browser pages (whose Origin always
          // carries a scheme + port). Programmatic clients send no Origin.
          enableDnsRebindingProtection: true,
          allowedHosts: rebindingHosts(),
          allowedOrigins: ['http://localhost', 'http://127.0.0.1', 'http://[::1]'],
        });
        server = createSessionServer();
        await server.connect(transport);
        // Per-request teardown (SDK stateless pattern): when the response
        // finishes or the socket drops, release both instances.
        res.on('close', () => {
          void transport?.close().catch(() => {});
          void server?.close().catch(() => {});
        });
        const parsedBody = await readJsonBody(req);
        await transport.handleRequest(req, res, parsedBody);
      } catch (error) {
        log.error(`MCP HTTP request failed: ${error instanceof Error ? error.message : String(error)}`);
        void transport?.close().catch(() => {});
        void server?.close().catch(() => {});
        if (!res.headersSent) {
          const isLarge = error instanceof Error && error.message === 'payload-too-large';
          sendJson(res, isLarge ? 413 : 500, { error: isLarge ? 'payload-too-large' : 'internal-error' });
        } else {
          res.destroy();
        }
      }
    });

    httpServer.once('error', reject);
    httpServer.listen(options.port, options.host, () => {
      const address = httpServer.address() as AddressInfo;
      const port = address.port;
      boundPort = port;
      const url = bridgeHttpUrl(options.host, port);
      log.info(`MCP Streamable HTTP server listening on ${url} (stateless; no auth; loopback only)`);
      resolve({
        port,
        url,
        close: async () => {
          await new Promise<void>((done, fail) => {
            httpServer.close((error) => {
              if (error) fail(error);
              else done();
            });
            httpServer.closeAllConnections();
          });
        },
      });
    });
  });
}
