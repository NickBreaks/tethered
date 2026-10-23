/**
 * Browser-level integration test for the FetchCapability / proxy
 * streaming path. A proxy enforces its own mid-stream size cap (see
 * docs/proxy-protocol.md). This suite covers the client side, because
 * jsdom's fetch surface does not model premature stream closure the
 * same way real browsers do. This test runs in Playwright Chromium through
 * `vitest.integration.config.ts`. It drives a real QuickJS VM through
 * FetchCapability against a stub fetch that aborts mid-stream.
 *
 * Scenarios:
 *   1. Upstream responds 200 with a ReadableStream body whose reader
 *      throws after the first chunk. The client-side fetch observes
 *      a TypeError (`TypeError: Failed to fetch` or the Chromium
 *      equivalent). QuickJS must show that as `fetch failed: ...`.
 *
 *   2. Upstream returns a large body (11 MB in a single chunk). The
 *      client receives all of it. This verifies that the VM-side
 *      surface can consume an oversized response and not crash. The
 *      SERVER enforces the cap. Here we only verify the client
 *      plumbing.
 *
 * Run with: npm run test:integration
 */

import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncWASMModule,
  type QuickJSAsyncRuntime,
  type QuickJSAsyncContext,
} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-asyncify';
import { FetchCapability } from './fetch-capability.js';
import { injectCapabilityBridge } from '../../workers/capability-bridge.js';
import type { SandboxCapability } from './capability.js';
import type { ProxyAuth } from '../proxy/proxy-auth.js';

// Injects the capability's guest API the way the worker does: bridge
// functions that relay to invokeHost on the (test) main thread.
function injectCap(vm: QuickJSAsyncContext, cap: SandboxCapability): void {
  injectCapabilityBridge(
    vm,
    { name: cap.name, stub: cap.stubInfo, setupScript: cap.setupScript },
    (method, args) => cap.invokeHost!(method, args),
  );
}

function makeStubProxyAuth(): ProxyAuth {
  return {
    proxyBase: () => null,
    authHeader: () => null,
    setToken: () => {},
    clearToken: () => {},
    invalidate: () => {},
    tokenInvalid: () => false,
  } as unknown as ProxyAuth;
}

async function evalAndDump(vm: QuickJSAsyncContext, code: string): Promise<unknown> {
  const result = await vm.evalCodeAsync(code);
  if (result.error) {
    const err = vm.dump(result.error);
    if (result.error.alive) {
      result.error.dispose();
    }
    throw new Error(`Eval failed: ${JSON.stringify(err)}`);
  }
  const val = vm.dump(result.value!);
  if (result.value!.alive) {
    result.value!.dispose();
  }
  return val;
}

describe('fetch-proxy-streaming integration', () => {
  let module: QuickJSAsyncWASMModule;
  let runtime: QuickJSAsyncRuntime;
  let vm: QuickJSAsyncContext;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    module = await newQuickJSAsyncWASMModuleFromVariant(variant);
  }, 30_000);

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    runtime = module.newRuntime();
    vm = runtime.newContext();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try { vm.dispose(); } catch { /* ignore */ }
    try { runtime.dispose(); } catch { /* ignore */ }
  });

  it('mid-stream abort surfaces as fetch failed: in QuickJS', async () => {
    // Make a ReadableStream whose reader gives one chunk and then
    // throws on the second pull. In real browsers, this shows as a
    // TypeError when the consumer calls .text().
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('first chunk'));
      },
      pull() {
        throw new TypeError('stream aborted');
      },
    });

    globalThis.fetch = async () =>
      new Response(body, {
        status: 200,
        headers: { 'Content-Type': 'application/octet-stream' },
      });

    const cap = new FetchCapability(makeStubProxyAuth());
    injectCap(vm, cap);

    const val = await evalAndDump(vm, `
      try {
        var resp = fetch('https://example.com/stream');
        resp.text();
        'no error';
      } catch (e) {
        e.message;
      }
    `);

    expect(String(val)).toContain('fetch failed');
  }, 60_000);

  it('11 MB single-chunk upstream is consumed without crashing the VM', async () => {
    const payload = 'x'.repeat(11 * 1024 * 1024);
    globalThis.fetch = async () =>
      new Response(payload, {
        status: 200,
        headers: { 'Content-Type': 'text/plain' },
      });

    const cap = new FetchCapability(makeStubProxyAuth());
    injectCap(vm, cap);

    const len = await evalAndDump(vm, `
      var resp = fetch('https://example.com/big');
      resp.text().length;
    `);

    expect(len).toBe(payload.length);
  }, 120_000);
});
