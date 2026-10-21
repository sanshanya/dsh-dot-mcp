/**
 * Stamp build metadata into lib/buildmeta.json after `tsc`: the artifact hash
 * lets `dsh_health` answer "did the update actually land on the running
 * instance" without trusting a stale version string. The hash covers every
 * emitted file except the stamp itself.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const lib = new URL('../lib/', import.meta.url).pathname;
const names = readdirSync(lib, { recursive: true })
  .filter((name) => typeof name === 'string' && String(name).endsWith('.js') && String(name) !== 'buildmeta.json')
  .sort();
const hash = createHash('sha256');
for (const name of names) hash.update(String(name)).update(readFileSync(join(lib, String(name))));
const digest = hash.digest('hex').slice(0, 16);
writeFileSync(join(lib, 'buildmeta.json'), JSON.stringify({
  built_at: new Date().toISOString(),
  artifact_sha256: digest,
}, null, 2));
console.log(`buildmeta: ${digest} @ ${names.length} files`);
