import { CapabilityStore } from './capabilities/capability-store.js';
import { ProxyAuth } from './proxy/proxy-auth.js';
import { JsRunner, type JsRunnerOptions } from './js/js-runner.js';
import { RuntimeFacade } from './runtime-facade.js';
import type { CodeRunner } from './shared/code-runner.js';

export interface SandboxRuntimeOptions {
  /**
   * CORS proxy base: `''` same-origin (dev), `null` disabled, or an
   * absolute URL. Defaults to `null`.
   */
  corsProxyUrl?: string | null;
  /**
   * Starts the JS worker. This option is required. There is no hidden
   * default, so the core never bundles a worker. `defaultJsWorkerFactory`
   * from `tethered/workers` starts the bundled worker. If there is no
   * global `Worker` (jsdom/SSR), it fails, unless you build it with
   * `createJsWorkerFactory({ allowInProcess: true })`.
   */
  jsWorkerFactory: () => Worker;
  /**
   * What `js.execute()` does while a JS run is in flight: `'supersede'`
   * (default: take over, and settle the older run as superseded) or
   * `'queue'` (run after the older run settles).
   */
  jsConcurrency?: JsRunnerOptions['concurrency'];
  /** Replace the JS worker every N runs. Off by default. */
  jsRecycleAfterRuns?: number;
  /** Respawn the JS worker and retry once on heap exhaustion. Defaults to `true`. */
  jsRecoverExhaustion?: boolean;
  /** How long the JS worker may take to report ready (ms). Defaults to 30000. */
  jsBootTimeoutMs?: number;
  /** Per-run time limit for the JS runner (ms). Defaults to 5000. */
  timeoutMs?: number;
  /**
   * Extra runners for the facade, keyed by mode. `js` is built in and
   * reserved. Each is reachable through `facade.setMode(key)`. The caller
   * keeps ownership: `dispose()` does not dispose them.
   */
  runners?: Readonly<Record<string, CodeRunner>>;
  /** The facade's starting mode: `'js'` or a key of `runners`. Defaults to `'js'`. */
  initialMode?: string;
}

/** One fully wired runtime: shared registry and auth, the JS runner, a facade. */
export interface SandboxRuntime {
  /** Dispatches to `js` or to an extra runner from `options.runners`. */
  readonly facade: RuntimeFacade;
  readonly js: JsRunner;
  readonly registry: CapabilityStore;
  readonly auth: ProxyAuth;
  /** Terminates the JS worker and drops every subscriber. */
  dispose(): void;
}

/**
 * Builds a runtime. This function does not start a worker. Call
 * `js.initialize()` when you want the worker to boot. That call rejects
 * if the worker fails to load.
 * Throws if `options.runners` has a `js` key or `initialMode` is unknown.
 */
export function createSandboxRuntime(options: SandboxRuntimeOptions): SandboxRuntime {
  const extra = options.runners ?? {};
  if (Object.hasOwn(extra, 'js')) {
    throw new Error('The "js" mode is built in; pass extra runners under other keys.');
  }
  const initialMode = options.initialMode ?? 'js';
  if (initialMode !== 'js' && !Object.hasOwn(extra, initialMode)) {
    throw new Error(`Unknown mode "${initialMode}"; registered modes: ${['js', ...Object.keys(extra)].join(', ')}.`);
  }
  const registry = new CapabilityStore();
  const auth = new ProxyAuth(options.corsProxyUrl ?? null);
  const js = new JsRunner(registry, {
    workerFactory: options.jsWorkerFactory,
    timeoutMs: options.timeoutMs,
    concurrency: options.jsConcurrency,
    recycleAfterRuns: options.jsRecycleAfterRuns,
    recoverExhaustion: options.jsRecoverExhaustion,
    bootTimeoutMs: options.jsBootTimeoutMs,
  });
  const facade = new RuntimeFacade({ js, ...extra }, initialMode);

  return {
    facade,
    js,
    registry,
    auth,
    dispose() {
      facade.dispose();
      js.dispose();
      registry.dispose();
      auth.dispose();
    },
  };
}
