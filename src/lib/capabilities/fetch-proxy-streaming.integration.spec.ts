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
 *   2. Upstream returns a large body (11 MB in a single chunk), and
 *      `maxResponseBytes` is larger. The client receives all of it.
 *      This verifies that the VM-side surface can consume a large
 *      response and not crash.
 *
 *   3. Upstream streams a body that does not end. The client stops at
 *      the default `maxResponseBytes` (10 MiB) and cancels the stream.
 *
 *   4. A relative URL resolves against the `<base>` element.
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

    // The default limit is 10 MiB. Set a larger limit for this body.
    const cap = new FetchCapability(makeStubProxyAuth(), { maxResponseBytes: 12 * 1024 * 1024 });
    injectCap(vm, cap);

    const len = await evalAndDump(vm, `
      var resp = fetch('https://example.com/big');
      resp.text().length;
    `);

    expect(len).toBe(payload.length);
  }, 120_000);

  it('a streamed body larger than the default 10 MiB limit fails and is cancelled', async () => {
    let cancelled = false;
    let sent = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(120);
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            sent += chunk.byteLength;
            controller.enqueue(chunk);
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 200 },
      );

    const cap = new FetchCapability(makeStubProxyAuth());
    injectCap(vm, cap);

    const val = await evalAndDump(vm, `
      try { fetch('https://example.com/endless').text(); 'no error'; } catch (e) { e.message; }
    `);

    expect(String(val)).toContain('fetch failed');
    expect(String(val)).toContain('maxResponseBytes');
    expect(cancelled).toBe(true);
    // The host stops soon after the limit. It does not read the stream to its end.
    expect(sent).toBeLessThan(16 * 1024 * 1024);
  }, 60_000);

  it('a relative URL resolves against the <base> element, as the page fetch does', async () => {
    const base = document.createElement('base');
    base.href = 'https://cdn.example.net/assets/';
    document.head.appendChild(base);
    const urls: string[] = [];
    globalThis.fetch = async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response('ok', { status: 200 });
    };
    try {
      const cap = new FetchCapability(makeStubProxyAuth());
      injectCap(vm, cap);
      await evalAndDump(vm, `fetch('data.json').status;`);
    } finally {
      base.remove();
    }
    expect(urls).toEqual(['https://cdn.example.net/assets/data.json']);
  }, 60_000);
});
