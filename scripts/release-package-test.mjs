// Always rebuild first. Install the actual tarball and exact official host into a fresh
// directory; never install into a user's DSH profile or reuse its credentials.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, cpSync, existsSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const npmCli = process.env.npm_execpath;
assert.ok(npmCli && existsSync(npmCli), 'Run through npm run test:release');
const temp = realpathSync(mkdtempSync(join(tmpdir(), 'bridge-release-')));
function run(args, cwd, capture = false, timeoutMs = 300000) {
  const result = spawnSync(process.execPath, args, {
    cwd, encoding: 'utf8', windowsHide: true,
    stdio: capture ? 'pipe' : 'inherit', timeout: timeoutMs,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `Subprocess failed: ${args[0]} (exit ${result.status})`);
  return result.stdout;
}
try {
  // Verify the clean target, then rebuild inside this gate. Module-name checks
  // alone cannot distinguish stale, same-named compiled files from current code.
  const lib = join(realpathSync(root), 'lib');
  if (existsSync(lib)) assert.equal(realpathSync(lib), lib, 'refuse an unexpected build-clean target');
  assert.equal(dirname(lib), realpathSync(root));
  run([npmCli, 'run', 'build'], root);
  const [pack] = JSON.parse(run([npmCli, 'pack', '--json', '--ignore-scripts', '--pack-destination', temp], root, true));
  assert.equal(pack.version, manifest.version);
  assert.ok(pack.files.every(({ path }) => !/(^test\/|test-tmp|openai-codex-oss-application|node_modules|\.env(?:\.|$)|\.(pem|key)$)/i.test(path)));
  const packedPaths = new Set(pack.files.map(({ path }) => path));
  for (const path of ['lib/index.js', 'lib/types/index.d.ts', 'cordis.patch.yml', 'README.md', 'ARCHITECTURE.md', 'LICENSE']) {
    assert.ok(packedPaths.has(path), `Missing package entry: ${path}`);
  }
  // `lib/` is a build product, so a module deleted from `src/` can survive in
  // it as a compiled ghost: invisible to every run inside the checkout, shipped
  // to users. The tarball must hold exactly one artifact per source module.
  const modules = readdirSync(join(root, 'src'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => name.slice(0, -'.ts'.length))
    .sort();
  const compiled = [...packedPaths]
    .filter((path) => /^lib\/[^/]+\.js$/.test(path))
    .map((path) => path.slice('lib/'.length, -'.js'.length))
    // The browser bundle is authored from src/client + src/shared, not one
    // src/<name>.ts module, so it is an expected top-level artifact, not a ghost.
    .filter((name) => name !== 'client')
    .sort();
  const declared = [...packedPaths]
    .filter((path) => /^lib\/types\/[^/]+\.d\.ts$/.test(path))
    .map((path) => path.slice('lib/types/'.length, -'.d.ts'.length))
    .sort();
  assert.deepEqual(compiled.filter((name) => !modules.includes(name)), [], 'compiled ghosts shipped in lib/');
  assert.deepEqual(declared.filter((name) => !modules.includes(name)), [], 'compiled ghosts shipped in lib/types/');
  assert.deepEqual(modules.filter((name) => !compiled.includes(name)), [], 'source modules missing from the tarball');
  assert.deepEqual(modules.filter((name) => !declared.includes(name)), [], 'source modules missing from lib/types/');
  const hostVersion = manifest.peerDependencies['@deepseek-ai/dsh-agent'];
  assert.match(hostVersion, /^\d+\.\d+\.\d+-rc\.\d+$/);
  // A fresh Windows machine can need more than five minutes to fetch the full
  // official host graph. Keep the contract-test subprocess on the short limit.
  run([npmCli, 'install', '--prefix', temp, '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
    join(temp, pack.filename), `@deepseek-ai/dsh@${hostVersion}`], temp, false, 600000);
  const installed = join(temp, 'node_modules', manifest.name);
  assert.equal(JSON.parse(readFileSync(join(installed, 'package.json'))).version, manifest.version);
  // Tests resolve both ../../lib and official dependencies from the installed
  // package. Copy only synthetic tests, never source/lib from the checkout.
  cpSync(join(root, 'test/integration'), join(installed, 'test/integration'), { recursive: true });
  run(['--test', 'test/integration/dsh-host.test.mjs', 'test/integration/dsh-cli.test.mjs'], installed);
  console.log(`PACKED_RELEASE_OK ${manifest.name}@${manifest.version}: ${pack.files.length} files; DSH ${hostVersion}`);
  console.log(`Package integrity: ${pack.integrity}`);
} finally {
  const boundary = relative(realpathSync(tmpdir()), temp);
  assert.ok(boundary && !boundary.startsWith('..') && !isAbsolute(boundary));
  assert.equal(dirname(temp), realpathSync(tmpdir()));
  rmSync(temp, { recursive: true, force: true });
}
