import { createRequire } from 'node:module';

/**
 * Bridge identity reported by dsh_health and the MCP server banner.
 * Single source of truth: package.json — never mirror the version by hand.
 * lib/version.js sits one directory below the package root.
 */
const require = createRequire(import.meta.url);
const pkg = require('../package.json') as { name: string; version: string };

export const BRIDGE_VERSION: string = pkg.version;
export const BRIDGE_NAME: string = pkg.name;
