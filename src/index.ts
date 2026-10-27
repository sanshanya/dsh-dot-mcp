/**
 * dsh-dot-mcp plugin entry: a DSH (Cordis) plugin row that mounts the
 * MCP bridge. Removing or disabling the row (or the bundle) makes the MCP
 * endpoint disappear while DSH keeps running untouched.
 */
import { Context } from '@deepseek-ai/cordis';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Bridge } from './bridge.js';
import { ConfigSchema, liveValue, resolveConfig, type BridgeConfigInput, type ResolvedBridgeConfig } from './config.js';
import { createBridgeLogger } from './log.js';
import { createMcpServer } from './mcp.js';
import { startHttpServer, type HttpServerHandle } from './http.js';
import { asSurface } from './shared/surface.js';

export const name = 'dot-mcp';

/** Core services the bridge needs before it can start. */
export const inject = ['agents', 'sessions', 'sessionPersistence', 'sessionTitle', 'agentDefaultModel', 'loader', 'goals'];

/** Plugin configuration schema (schemastery, DSH convention). */
export const Config = ConfigSchema;

export function apply(ctx: Context, config: BridgeConfigInput): void {
  const cfg: ResolvedBridgeConfig = resolveConfig(config, process.env as Record<string, string | undefined>);
  const log = createBridgeLogger({
    level: cfg.logLevel,
    dshHome: cfg.dshHome,
    stdioSafe: cfg.transport === 'stdio',
    cordis: {
      info: (message) => ctx.logger.info(message),
      warn: (message) => ctx.logger.warn(message),
      error: (message) => ctx.logger.error(message),
    },
  });

  const bridge = new Bridge(ctx, cfg, log);
  bridge.start();

  // Settings presentation: when the DSH settings service exists (web/headless
  // profiles), describe this row's Config so the GUI can read and edit the
  // volatile fields (budgets, log level, auto-approve switch) live.
  interface SettingsPresentation {
    configure(options: { auto: boolean }, owner?: unknown): () => void;
  }
  ctx.inject(['settings'], (child) => {
    child.effect(() => {
      const settings = (child as unknown as { settings: SettingsPresentation }).settings;
      return settings.configure({ auto: false }, ctx.fiber);
    });
  });

  let mcpServer: ReturnType<typeof createMcpServer> | undefined;
  let stdioTransport: StdioServerTransport | undefined;
  let stdioReady: Promise<void> | undefined;
  let httpReady: Promise<HttpServerHandle> | undefined;

  if (cfg.transport === 'stdio') {
    log.info('MCP stdio transport active — speak JSON-RPC on stdin/stdout');
    // Built lazily here: in HTTP mode a singleton McpServer would never have
    // been connected (per-session instances serve every request instead).
    // stdio is a single long-lived connection: the surface is read once at boot.
    mcpServer = createMcpServer(bridge, asSurface(liveValue(cfg.surface)));
    stdioTransport = new StdioServerTransport();
    stdioReady = mcpServer.connect(stdioTransport).catch((error) => {
      log.error(`stdio transport failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  } else {
    httpReady = startHttpServer(
      // Read inside the factory: HTTP builds a server per request, so a
      // volatile surface flip takes effect on the next tools/list.
      () => createMcpServer(bridge, asSurface(liveValue(cfg.surface))),
      { host: cfg.host, port: cfg.port },
      log,
      {
        // Live gate: the settings panel flips this volatile field to suspend
        // the MCP surface without unbinding the port (see GET /status).
        isEnabled: () => liveValue(cfg.enabled) !== false,
        statusReport: () => bridge.health(asSurface(liveValue(cfg.surface))),
      },
    );
    void httpReady.catch((error) => {
      log.error(`failed to start MCP HTTP server: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  // Fiber-owned effect: Cordis awaits this disposer, so the MCP endpoint is
  // actually gone before the plugin row finishes unloading.
  ctx.effect(() => async () => {
    log.info('bridge shutting down: closing MCP server and transports');
    if (httpReady !== undefined) {
      try {
        const handle = await httpReady;
        try {
          await handle.close();
        } catch (error) {
          log.error(`http server close failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      } catch {
        // start already logged; nothing listening
      }
    }
    if (stdioReady !== undefined) {
      try {
        await stdioReady;
      } catch {
        // connect already logged
      }
    }
    if (stdioTransport !== undefined) {
      try {
        await stdioTransport.close();
      } catch {
        // best-effort
      }
    }
    try {
      await mcpServer?.close();
    } catch {
      // best-effort
    }
  });
}
