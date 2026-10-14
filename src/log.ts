import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

/**
 * Bridge logger. Writes lines to an optional file under DSH_HOME and NEVER
 * to stdout (stdout must stay clean for the stdio MCP transport). In HTTP
 * mode the same lines are forwarded to the cordis logger, which the harness
 * already routes. Lines are NOT secret-scrubbed (0.7.0 removed the heuristic
 * redactor): never log credentials in the first place.
 */
export interface BridgeLogger {
  debug(message: string, payload?: unknown): void;
  info(message: string, payload?: unknown): void;
  warn(message: string, payload?: unknown): void;
  error(message: string, payload?: unknown): void;
}

export function createBridgeLogger(options: {
  level: LogLevel;
  dshHome: string;
  stdioSafe: boolean;
  cordis?: { info(m: string): void; warn(m: string): void; error(m: string): void; debug?(m: string): void };
}): BridgeLogger {
  const threshold = LEVEL_ORDER[options.level] ?? LEVEL_ORDER.info;
  let file: string | undefined;
  try {
    const dir = options.dshHome || process.cwd();
    mkdirSync(dir, { recursive: true });
    file = join(dir, 'dot-mcp.log');
  } catch {
    file = undefined;
  }
  const emit = (level: LogLevel, message: string, payload?: unknown): void => {
    if (LEVEL_ORDER[level] < threshold) return;
    let line = message;
    if (payload !== undefined) {
      try {
        line = `${message} ${JSON.stringify(payload)}`;
      } catch {
        line = message;
      }
    }
    if (file !== undefined) {
      try {
        appendFileSync(file, `${new Date().toISOString()} [${level}] ${line}\n`);
      } catch {
        // logging must never break the bridge
      }
    }
    if (!options.stdioSafe) {
      try {
        if (level === 'error') options.cordis?.error(line);
        else if (level === 'warn') options.cordis?.warn(line);
        else options.cordis?.info(line);
      } catch {
        // cordis logger optional
      }
    }
  };
  return {
    debug: (m, p) => emit('debug', m, p),
    info: (m, p) => emit('info', m, p),
    warn: (m, p) => emit('warn', m, p),
    error: (m, p) => emit('error', m, p),
  };
}

/** Control-plane logger removed together with the tunnel control plane (0.6.1). */
