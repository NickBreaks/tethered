// Import guard: the core entry (src/index.ts and everything under src/lib/)
// must stay dependency-free and framework-free, so any app can consume it.
// The ESLint `no-restricted-imports` rules for src/lib mirror this guard.
//
// The main entry must also never reach a worker module (directly, by
// `new URL(…, import.meta.url)` or by dynamic import). Those modules are in
// the `tethered/workers` entry (src/workers/) and the worker script
// (src/js-worker.ts). After the build, scripts/verify-build.mjs mirrors
// this guard.
//
// Vitest runs specs in Node, but the package has no @types/node. Thus this
// spec imports the fs module through an untyped specifier.

interface NodeFs {
  readdirSync(dir: string): string[];
  readFileSync(path: string, encoding: 'utf8'): string;
  statSync(path: string): { isDirectory(): boolean };
  existsSync(path: string): boolean;
}

/** Static, side-effect and dynamic import specifiers. */
const IMPORT_SPECIFIER = /(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g;
const WORKER_URL = /new\s+(?:Shared)?Worker\s*\(|new\s+URL\s*\([^)]*import\.meta\.url/;

describe('core import guard', () => {
  let fs: NodeFs;
  let srcRoot: string;
  let coreRoot: string;

  beforeAll(async () => {
    const fsSpecifier = 'node:fs';
    fs = (await import(/* @vite-ignore */ fsSpecifier)) as NodeFs;
    const cwd = (globalThis as unknown as { process: { cwd(): string } }).process.cwd();
    srcRoot = `${cwd}/src`;
    coreRoot = `${srcRoot}/lib`;
  });

  function tsFiles(dir: string): string[] {
    return fs.readdirSync(dir).flatMap((name) => {
      const full = `${dir}/${name}`;
      if (fs.statSync(full).isDirectory()) return tsFiles(full);
      return name.endsWith('.ts') && !name.endsWith('.spec.ts') ? [full] : [];
    });
  }

  it('finds the core sources', () => {
    expect(tsFiles(coreRoot).length).toBeGreaterThan(10);
  });

  /** Every source file the main entry reaches through relative imports. */
  function reachableFromMainEntry(): { files: string[]; bareImports: string[] } {
    const seen = new Set<string>();
    const bareImports = new Set<string>();
    const normalize = (f: string) =>
      f
        .split('/')
        .reduce<string[]>((acc, part) => {
          if (part === '..') acc.pop();
          else if (part !== '.') acc.push(part);
          return acc;
        }, [])
        .join('/');
    const visit = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const text = fs.readFileSync(file, 'utf8');
      for (const [, spec] of text.matchAll(IMPORT_SPECIFIER)) {
        if (!spec.startsWith('.')) {
          bareImports.add(spec);
          continue;
        }
        const base = normalize(`${file.slice(0, file.lastIndexOf('/'))}/${spec}`);
        const target = [base.replace(/\.js$/, '.ts'), `${base}.ts`, `${base}/index.ts`].find((f) =>
          fs.existsSync(f),
        );
        visit(target ?? base);
      }
    };
    visit(`${srcRoot}/index.ts`);
    return { files: [...seen], bareImports: [...bareImports] };
  }

  it('the main entry reaches no worker module or worker factory', () => {
    const { files } = reachableFromMainEntry();
    expect(files.length).toBeGreaterThan(10);
    const outside = files.filter(
      (f) => f !== `${srcRoot}/index.ts` && !f.startsWith(`${coreRoot}/`),
    );
    expect(outside).toEqual([]);
    expect(files.filter((f) => /worker(?:-host)?\.ts$|in-process/.test(f))).toEqual([]);
    expect(files.filter((f) => WORKER_URL.test(fs.readFileSync(f, 'utf8')))).toEqual([]);
  });

  it('the main entry imports no package (no engine, no framework)', () => {
    expect(reachableFromMainEntry().bareImports).toEqual([]);
  });

  it('no core file imports a package or the workers', () => {
    const offenders = tsFiles(coreRoot).filter((file) =>
      [...fs.readFileSync(file, 'utf8').matchAll(IMPORT_SPECIFIER)].some(
        ([, spec]) => !spec.startsWith('.') || /\/workers\/|js-worker/.test(spec),
      ),
    );
    expect(offenders.map((f) => f.slice(srcRoot.length + 1))).toEqual([]);
  });

  it.each([
    ['a static import', `import { a } from 'pkg';`, ['pkg']],
    ['a side-effect import', `import 'pkg';`, ['pkg']],
    ['a dynamic import', `await import("pkg")`, ['pkg']],
    ['a re-export', `export * from './x.js';`, ['./x.js']],
    ['a type-only import', `import type { T } from 'pkg';`, ['pkg']],
    ['prose that names a package', `// mentions pkg in prose`, []],
  ])('the import pattern finds the specifiers of %s', (_name, text, expected) => {
    expect([...text.matchAll(IMPORT_SPECIFIER)].map(([, s]) => s)).toEqual(expected);
  });

  it.each([
    ['new Worker(', `new Worker(url)`, true],
    ['new SharedWorker(', `new SharedWorker(url)`, true],
    ['new URL with import.meta.url', `new URL('./w.js', import.meta.url)`, true],
    ['new URL without import.meta.url', `new URL('https://example.com/')`, false],
  ])('the worker pattern checks %s', (_name, text, expected) => {
    expect(WORKER_URL.test(text)).toBe(expected);
  });
});
