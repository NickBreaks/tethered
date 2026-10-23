// Type- and value-level guards for the public surface of both entries.
// Each `@ts-expect-error` fails the typecheck if the line it marks
// compiles again. The export lists fail when an export is added or
// removed and the lists (and the CHANGELOG) are not updated.

// @ts-expect-error A4: TracebackFrame is not exported
import type { TracebackFrame } from '../../index.js';
// @ts-expect-error A4: SyntaxErrorInfo is not exported
import type { SyntaxErrorInfo } from '../../index.js';
// @ts-expect-error A3: the core declares no LanguageMode (modes are runner-map keys)
import type { LanguageMode } from '../../index.js';
import * as core from '../../index.js';
import * as workers from '../../workers/index.js';
import { createSandboxRuntime, type OutputEntry } from '../../index.js';

type Unused = TracebackFrame | SyntaxErrorInfo | LanguageMode;

describe('public surface', () => {
  it('the core entry exports exactly these values', () => {
    expect(Object.keys(core).sort()).toEqual(
      [
        'CapabilityStore',
        'DiskCapability',
        'FetchCapability',
        'IndexedDBDiskBackend',
        'JsRunner',
        'MapDiskBackend',
        'ProxyAuth',
        'RuntimeFacade',
        'SANDBOX_DISK_DB_VERSION',
        'StorageCapability',
        'TimerCapability',
        'createSandboxRuntime',
        'normalizePath',
        'openSandboxDisk',
        'serialize',
      ].sort(),
    );
  });

  it('the workers entry exports exactly these values', () => {
    expect(Object.keys(workers).sort()).toEqual(
      ['InProcessJsWorker', 'createJsWorkerFactory', 'defaultJsWorkerFactory'].sort(),
    );
  });

  it('A3: the core has no LanguageMode type; modes are runner-map keys', () => {
    const unused: Unused[] = [];
    expect(unused).toEqual([]);
  });

  it("A4: OutputEntry.type excludes 'stdout' and 'stderr'", () => {
    // @ts-expect-error A4: no 'stdout' entries
    const out: OutputEntry = { type: 'stdout', content: '', timestamp: 0 };
    // @ts-expect-error A4: no 'stderr' entries
    const err: OutputEntry = { type: 'stderr', content: '', timestamp: 0 };
    expect([out, err]).toHaveLength(2);
  });

  it('A4: OutputEntry has no frames or syntaxError field', () => {
    // @ts-expect-error A4: no traceback frames
    const framed: OutputEntry = { type: 'error', content: '', timestamp: 0, frames: [] };
    const syntax: OutputEntry = {
      type: 'error',
      content: '',
      timestamp: 0,
      // @ts-expect-error A4: no syntax-error payload
      syntaxError: { message: '', line: 1 },
    };
    expect([framed, syntax]).toHaveLength(2);
  });

  it('A16: the runtime has one worker factory option and no runner fields besides js', () => {
    const factory = () => ({}) as Worker;
    // @ts-expect-error the only worker factory option is jsWorkerFactory
    const rt = createSandboxRuntime({ jsWorkerFactory: factory, wasmWorkerFactory: factory });
    // @ts-expect-error A16: extra runners are registered through `runners`, not as runtime fields
    expect(rt.wasm).toBeUndefined();
    rt.dispose();
  });
});
