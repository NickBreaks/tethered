/**
 * Builds the package into dist/:
 *
 *   1. `tsc -p tsconfig.build.json` emits the core (`.`) and the
 *      `./workers` entry as ES modules with declarations.
 *   2. The build removes the declarations that no public entry reaches.
 *      They belong to worker internals (the engine host and the capability
 *      bridge), and they name the engine. The engine stays an
 *      implementation detail.
 *   3. esbuild bundles the worker script (`src/js-worker.ts`) into the
 *      self-contained `dist/js-worker.js`, the `./js-worker` export. The
 *      bundle inlines the engine and its WASM. The default worker
 *      factory in `dist/workers/` points at it with
 *      `new URL('../js-worker.js', import.meta.url)`.
 *   4. scripts/verify-build.mjs checks the result.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const require = createRequire(import.meta.url);

rmSync(dist, { recursive: true, force: true });

execFileSync(process.execPath, [require.resolve('typescript/bin/tsc'), '-p', 'tsconfig.build.json'], {
  cwd: root,
  stdio: 'inherit',
});

// Keep only the declarations reachable from the public entries.
const IMPORT_SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)['"](\.[^'"]+)['"]/g;
const reachable = new Set();
const visit = (file) => {
  if (reachable.has(file)) return;
  reachable.add(file);
  for (const [, spec] of readFileSync(file, 'utf8').matchAll(IMPORT_SPECIFIER)) {
    visit(resolve(dirname(file), spec.replace(/\.js$/, '.d.ts')));
  }
};
visit(join(dist, 'index.d.ts'));
visit(join(dist, 'workers/index.d.ts'));
for (const rel of readdirSync(dist, { recursive: true, encoding: 'utf8' })) {
  const file = join(dist, rel);
  if (rel.endsWith('.d.ts') && !reachable.has(file)) {
    rmSync(file);
    rmSync(`${file}.map`, { force: true });
  }
}

await build({
  entryPoints: [join(root, 'src/js-worker.ts')],
  outfile: join(dist, 'js-worker.js'),
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  logLevel: 'warning',
});
console.log('build: wrote dist/js-worker.js');

execFileSync(process.execPath, [join(root, 'scripts/verify-build.mjs')], { cwd: root, stdio: 'inherit' });
