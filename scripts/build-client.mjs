/**
 * Build the browser half: one closure-factory bundle at lib/client.js in the
 * shape the GUI module loader expects (`window.__ModuleLoader__.load`) with
 * framework packages supplied by the host's module table at runtime.
 */
import { build } from 'esbuild';

await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  banner: {
    js: "window.__ModuleLoader__.load({ id: 'dsh-dot-mcp', factory: (require) => { const module = { exports: {} }; const exports = module.exports;",
  },
  footer: {
    js: '  return module.exports;\n} });',
  },
  outfile: 'lib/client.js',
  minify: true,
  sourcemap: false,
  logLevel: 'info',
});
