import { join } from 'node:path';
import { isIP } from 'node:net';
import { isVolatile, type Volatile } from '@deepseek-ai/cosmokit';
import z from '@deepseek-ai/schemastery';
import type { LogLevel } from './log.js';
import { CONFIG_DEFAULTS } from './shared/defaults.js';

/**
 * Plugin configuration (schemastery schema, DSH convention). All defaults are
 * security-first: loopback-only host, bounded result sizes, and approvals that
 * park for a decision. (0.6.2: bearer token auth was removed by operator
 * decision; loopback binding is the only remaining choke point and is enforced
 * unconditionally. 0.7.0: the approval matrix is gone — approvals on managed
 * sessions relay to the remote driver or the host GUI. 0.7.0+: one explicit
 * opt-in switch, `autoApproveEscalations`, grants every escalation ask without
 * waiting for anyone; off by default, and the relay's parking path stays the
 * default posture.)
 */
export const ConfigSchema = z.object({
  /** MCP transport: 'http' (Streamable HTTP) or 'stdio' (local MCP clients). */
  transport: z.union([z.const('http'), z.const('stdio')]).default(CONFIG_DEFAULTS.transport),
  /** Bind host for the Streamable HTTP server. Loopback only by default. */
  host: z.string().default(CONFIG_DEFAULTS.host),
  /** Bind port for the Streamable HTTP server. */
  port: z.number().min(1).max(65535).default(CONFIG_DEFAULTS.port),
  /** Max characters of assistant text returned by dsh_get_result. Volatile: live-editable from the DSH settings UI. */
  resultMaxChars: z.number().default(CONFIG_DEFAULTS.resultMaxChars).volatile(),
  /** Max tool calls returned by dsh_get_result. Volatile: live-editable from the DSH settings UI. */
  resultMaxItems: z.number().default(CONFIG_DEFAULTS.resultMaxItems).volatile(),
  /** Max message rows returned by dsh_get_session. Volatile: live-editable from the DSH settings UI. */
  sessionMaxItems: z.number().default(CONFIG_DEFAULTS.sessionMaxItems).volatile(),
  /** Max characters per message text returned by dsh_get_session. Volatile: live-editable from the DSH settings UI. */
  sessionMaxChars: z.number().default(CONFIG_DEFAULTS.sessionMaxChars).volatile(),
  /** Log verbosity: debug | info | warn | error. Volatile: live-editable from the DSH settings UI. */
  logLevel: z.union([z.const('debug'), z.const('info'), z.const('warn'), z.const('error')]).default(CONFIG_DEFAULTS.logLevel).volatile(),
  /**
   * Auto-grant every sandbox-escalation ask on a bridge-managed session, to the
   * mode the tool requested (usually `danger-full-access`), instead of parking
   * it for a driver/GUI decision. Off by default: parking is the relay's job.
   * Volatile: live-editable from the DSH settings UI.
   */
  autoApproveEscalations: z.boolean().default(CONFIG_DEFAULTS.autoApproveEscalations).volatile(),
  /**
   * Master switch for the MCP surface. When false, the HTTP server stays
   * bound (so the settings panel can still reach GET /status and flip this
   * back) but every MCP request is refused with 503 `bridge-disabled`.
   * Volatile: flips live from the DSH settings UI without a host restart.
   */
  enabled: z.boolean().default(CONFIG_DEFAULTS.enabled).volatile(),
});

/** A schema value that may arrive as a live cosmokit Volatile handle or a plain constant (unit fixtures). */
export type VolatileConfig<T> = T | Volatile<T>;

/** Read a possibly-volatile configuration value at call time; plain constants pass through. */
export function liveValue<T>(value: VolatileConfig<T>): T {
  // VolatileSnapshot<T> is a readonly-deep alias of T for the primitive config
  // fields we mark volatile; the cast narrows the guaranteed-safe case.
  return (isVolatile(value) ? value.get() : value) as T;
}

/** Input shape accepted from the cordis row config (schema parse side; marked fields arrive Volatile-wrapped at runtime). */
export interface BridgeConfigInput {
  transport?: 'http' | 'stdio';
  host?: string;
  port?: number;
  resultMaxChars?: VolatileConfig<number>;
  resultMaxItems?: VolatileConfig<number>;
  sessionMaxItems?: VolatileConfig<number>;
  sessionMaxChars?: VolatileConfig<number>;
  logLevel?: VolatileConfig<LogLevel>;
  autoApproveEscalations?: VolatileConfig<boolean>;
  enabled?: VolatileConfig<boolean>;
}

/** Fully resolved configuration. Volatile fields keep their live handles; read them through `liveValue`. */
export interface ResolvedBridgeConfig {
  transport: 'http' | 'stdio';
  host: string;
  port: number;
  resultMaxChars: VolatileConfig<number>;
  resultMaxItems: VolatileConfig<number>;
  sessionMaxItems: VolatileConfig<number>;
  sessionMaxChars: VolatileConfig<number>;
  logLevel: VolatileConfig<LogLevel>;
  autoApproveEscalations: VolatileConfig<boolean>;
  enabled: VolatileConfig<boolean>;
  dshHome: string;
}

/** Convert URL authority host syntax to the bare form required by sockets. */
function normalizeSocketHostname(host: string): string {
  const value = host.trim();
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
}

function normalizedHost(host: string): string {
  return normalizeSocketHostname(host).toLowerCase();
}

function normalizedIpv6(host: string): string {
  return normalizeSocketHostname(new URL(`http://[${host}]/`).hostname);
}

/** True only for listener hosts whose bind scope is loopback-only. */
export function isLoopbackHost(host: string): boolean {
  const value = normalizedHost(host);
  if (value === 'localhost') return true;
  const family = isIP(value);
  if (family === 4) return value.split('.')[0] === '127';
  if (family !== 6) return false;
  const canonical = normalizedIpv6(value);
  return canonical === '::1' || /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(canonical);
}

/** Select a concrete address that can reach a wildcard listener locally. */
function bridgeConnectHost(listenerHost: string): string {
  const value = normalizedHost(listenerHost);
  if (value === '0.0.0.0') return '127.0.0.1';
  if (isIP(value) === 6 && normalizedIpv6(value) === '::') return '::1';
  return value;
}

/** Build a syntactically valid local probe URL, including IPv6 brackets. */
export function bridgeHttpUrl(listenerHost: string, port: number): string {
  const host = bridgeConnectHost(listenerHost);
  const authority = isIP(host) === 6 ? `[${host}]` : host;
  return `http://${authority}:${port}/mcp`;
}

function defaultDshHome(env: Record<string, string | undefined>): string {
  return env.DSH_HOME && env.DSH_HOME !== '' ? env.DSH_HOME : join(homeDir(), '.dsh');
}

function homeDir(): string {
  return process.env.USERPROFILE ?? process.env.HOME ?? '.';
}

/** Resolve the effective configuration (defaults + loopback enforcement). */
export function resolveConfig(
  input: BridgeConfigInput,
  env: Record<string, string | undefined>,
): ResolvedBridgeConfig {
  const dshHome = defaultDshHome(env);
  const transport = input.transport === 'stdio' ? 'stdio' : 'http';
  const host = input.host || CONFIG_DEFAULTS.host;
  // Auth is gone: the loopback bind is now the ONLY security choke point,
  // so refusing non-loopback listeners is unconditional (not a mode).
  if (transport === 'http' && !isLoopbackHost(host)) {
    throw new Error(`non-loopback HTTP listeners are refused: ${host}`);
  }
  return {
    transport,
    host,
    port: input.port ?? CONFIG_DEFAULTS.port,
    resultMaxChars: input.resultMaxChars ?? CONFIG_DEFAULTS.resultMaxChars,
    resultMaxItems: input.resultMaxItems ?? CONFIG_DEFAULTS.resultMaxItems,
    sessionMaxItems: input.sessionMaxItems ?? CONFIG_DEFAULTS.sessionMaxItems,
    sessionMaxChars: input.sessionMaxChars ?? CONFIG_DEFAULTS.sessionMaxChars,
    logLevel: input.logLevel ?? CONFIG_DEFAULTS.logLevel,
    autoApproveEscalations: input.autoApproveEscalations ?? CONFIG_DEFAULTS.autoApproveEscalations,
    enabled: input.enabled ?? CONFIG_DEFAULTS.enabled,
    dshHome,
  };
}
