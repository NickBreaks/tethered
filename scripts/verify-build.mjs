/**
 * Post-build gate.
 *
 * 1. The main entry (`dist/index.js` and every module it imports) must not
 *    reference the worker modules: no `js-worker`, no `worker-host`, no
 *    `workers/` import and no `new Worker(`. Those live in the `./workers`
 *    entry, so a consumer that passes its own worker factory bundles none
 *    of them. Mirrors src/lib/core-import-guard.spec.ts.
 * 2. No emitted `.d.ts` mentions the JS engine: it is an implementation
 *    detail of the worker, so it can be swapped without breaking the
 *    public types.
 * 3. The worker bundle exists and imports nothing (it must be
 *    self-contained, WASM included).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist');
const fail = (msg) => {
  console.error(`verify-build: ${msg}`);
  process.exit(1);
};

const IMPORT_SPECIFIER = /(?:from\s*|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
const coreFiles = new Set();
const visit = (file) => {
  if (coreFiles.has(file)) return;
  if (!existsSync(file)) fail(`${file} is imported but missing`);
  coreFiles.add(file);
  for (const [, spec] of readFileSync(file, 'utf8').matchAll(IMPORT_SPECIFIER)) {
    if (!spec.startsWith('.')) fail(`${file} imports the package '${spec}'; the core has no dependencies`);
    visit(resolve(dirname(file), spec));
  }
};
visit(join(dist, 'index.js'));
const forbidden = [/js-worker/, /worker-host/, /\/workers\//, /new\s+Worker\s*\(/];
for (const file of coreFiles) {
  const text = readFileSync(file, 'utf8');
  const hits = forbidden.filter((re) => re.test(text)).map(String);
  if (hits.length > 0) fail(`${file} (main entry) references ${hits.join(', ')}`);
}

const typings = readdirSync(dist, { recursive: true, encoding: 'utf8' }).filter((f) =>
  f.endsWith('.d.ts'),
);
if (typings.length === 0) fail(`no .d.ts files under ${dist}`);
const engineLeaks = typings.filter((f) => /quickjs/i.test(readFileSync(join(dist, f), 'utf8')));
if (engineLeaks.length > 0) fail(`the engine leaks into public types: ${engineLeaks.join(', ')}`);

const workerBundle = join(dist, 'js-worker.js');
if (!existsSync(workerBundle)) fail('dist/js-worker.js is missing');
const external = [...readFileSync(workerBundle, 'utf8').matchAll(/^\s*import\s.*?from\s*['"]([^'"]+)['"]/gm)];
if (external.length > 0) fail(`dist/js-worker.js still imports ${external.map((m) => m[1]).join(', ')}`);

console.log(`verify-build: main entry (${coreFiles.size} modules) is free of worker references`);
console.log(`verify-build: ${typings.length} .d.ts file(s) are engine-neutral`);
console.log('verify-build: dist/js-worker.js is self-contained');
