/**
 * Primitive configuration defaults shared by the host schema (src/config.ts)
 * and the GUI settings panel (src/client/index.tsx). This module must stay
 * Node-free and dependency-free so the browser bundle can inline it.
 */
export const CONFIG_DEFAULTS = {
  transport: 'http',
  host: '127.0.0.1',
  port: 3456,
  resultMaxChars: 8000,
  resultMaxItems: 50,
  sessionMaxItems: 20,
  sessionMaxChars: 4000,
  logLevel: 'info',
  autoApproveEscalations: false,
  enabled: true,
} as const;
