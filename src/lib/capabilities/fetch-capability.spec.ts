import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import {
  newQuickJSAsyncWASMModuleFromVariant,
  type QuickJSAsyncWASMModule,
  type QuickJSAsyncRuntime,
  type QuickJSAsyncContext,
} from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-browser-release-asyncify';
import { FetchCapability, type FetchCapabilityOptions } from './fetch-capability.js';
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

type ProxyAuthStubOverrides = Partial<{
  proxyBase: () => string | null;
  authHeader: () => string | null;
  setToken: (token: string) => void;
  clearToken: () => void;
  invalidate: () => void;
  tokenInvalid: () => boolean;
}>;

function makeStubProxyAuth(overrides: ProxyAuthStubOverrides = {}): ProxyAuth {
  return {
    proxyBase: () => null,
    authHeader: () => null,
    setToken: vi.fn(),
    clearToken: vi.fn(),
    invalidate: vi.fn(),
    tokenInvalid: () => false,
    ...overrides,
  } as unknown as ProxyAuth;
}

describe('FetchCapability', () => {
  let module: QuickJSAsyncWASMModule;
  let runtime: QuickJSAsyncRuntime;
  let vm: QuickJSAsyncContext;
  let originalFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    module = await newQuickJSAsyncWASMModuleFromVariant(variant);
  }, 30000);

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    runtime = module.newRuntime();
    vm = runtime.newContext();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try { vm.dispose(); } catch { /* already disposed */ }
    try { runtime.dispose(); } catch { /* already disposed */ }
  });

  // Helper: evalCodeAsync returns the resolved value for asyncified functions
  async function evalAndDump(code: string): Promise<unknown> {
    const result = await vm.evalCodeAsync(code);
    if (result.error) {
      const errorHandle = result.error;
      const err = vm.dump(errorHandle);
      if (errorHandle.alive) {
        errorHandle.dispose();
      }
      throw new Error(`Eval failed: ${JSON.stringify(err)}`);
    }

    const valueHandle = result.value!;
    const val = vm.dump(valueHandle);
    if (valueHandle.alive) {
      valueHandle.dispose();
    }
    return val;
  }

  // With newAsyncifiedFunction, fetch() appears synchronous to QuickJS.
  // An await is not necessary. The asyncify mechanism transparently suspends/resumes WASM.

  it('should fetch and return status', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200, statusText: 'OK' }));
    const cap = new FetchCapability(makeStubProxyAuth());
    injectCap(vm, cap);
    const val = await evalAndDump(`
      var resp = fetch('https://example.com');
      resp.status;
    `);
    expect(val).toBe(200);
    // The request uses the parsed absolute URL, and carries an abort signal.
    expect(globalThis.fetch).toHaveBeenCalledWith('https://example.com/', {
      signal: expect.any(AbortSignal),
    });
  });

  it('should return text body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('Hello World', { status: 200 }));
    const cap = new FetchCapability(makeStubProxyAuth());
    injectCap(vm, cap);
    const val = await evalAndDump(`
      var resp = fetch('https://example.com');
      resp.text();
    `);
    expect(val).toBe('Hello World');
  });

  it('should return parsed JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"key":"value"}', { status: 200 }));
    const cap = new FetchCapability(makeStubProxyAuth());
    injectCap(vm, cap);
    const val = await evalAndDump(`
      var resp = fetch('https://example.com');
      resp.json();
    `);
    expect(val).toEqual({ key: 'value' });
  });

  it('should send POST with body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('created', { status: 201, statusText: 'Created' }));
    const cap = new FetchCapability(makeStubProxyAuth());
    injectCap(vm, cap);
    const val = await evalAndDump(`
      var resp = fetch('https://example.com/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"data": 1}'
      });
      resp.status;
    `);
    expect(val).toBe(201);
    expect(globalThis.fetch).toHaveBeenCalledWith('https://example.com/api', expect.objectContaining({
      method: 'POST',
      body: '{"data": 1}',
    }));
  });

  it('should report ok status correctly', async () => {
    // Test ok = true for 200
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));
    const cap = new FetchCapability(makeStubProxyAuth());
    injectCap(vm, cap);
    let val = await evalAndDump(`
      var resp = fetch('https://example.com');
      resp.ok;
    `);
    expect(val).toBe(true);

    // Recreate context for 404 test
    try { vm.dispose(); } catch { /* ignore */ }
    try { runtime.dispose(); } catch { /* ignore */ }
    runtime = module.newRuntime();
    vm = runtime.newContext();

    globalThis.fetch = vi.fn().mockResolvedValue(new Response('Not Found', { status: 404, statusText: 'Not Found' }));
    const cap2 = new FetchCapability(makeStubProxyAuth());
    injectCap(vm, cap2);
    val = await evalAndDump(`
      var resp = fetch('https://example.com/missing');
      resp.ok;
    `);
    expect(val).toBe(false);
  });

  it('should return statusText', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('', { status: 200, statusText: 'OK' }));
    const cap = new FetchCapability(makeStubProxyAuth());
    injectCap(vm, cap);
    const val = await evalAndDump(`
      var resp = fetch('https://example.com');
      resp.statusText;
    `);
    expect(val).toBe('OK');
  });

  it('should propagate network errors', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    const cap = new FetchCapability(makeStubProxyAuth());
    injectCap(vm, cap);
    const val = await evalAndDump(`
      try {
        fetch('https://example.com');
        'no error';
      } catch (e) {
        e.message;
      }
    `);
    expect(val).toContain('Failed to fetch');
    expect(val).toContain('fetch failed');
  });

  // ---------------------------------------------------------------
  // Thenable response: .then() chaining support so LLM agents
  // can use standard fetch patterns (for example, fetch(url).then(r => r.text()))
  // ---------------------------------------------------------------

  it('should support .then() on response for text extraction', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('Hello', { status: 200 }));
    const cap = new FetchCapability(makeStubProxyAuth());
    injectCap(vm, cap);
    const val = await evalAndDrain(`
      fetch('https://example.com').then(function(r) { globalThis.out = r.text(); });
    `);
    expect(val).toBe('Hello');
  }, 10_000);

  it('should support chained .then() calls', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('chained', { status: 200 }));
    const cap = new FetchCapability(makeStubProxyAuth());
    injectCap(vm, cap);
    const val = await evalAndDrain(`
      fetch('https://example.com')
        .then(function(r) { return r.text(); })
        .then(function(t) { return 'got: ' + t; })
        .then(function(v) { globalThis.out = v; });
    `);
    expect(val).toBe('got: chained');
  }, 10_000);

  it('should support .then() on response for json extraction', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"a":1}', { status: 200 }));
    const cap = new FetchCapability(makeStubProxyAuth());
    injectCap(vm, cap);
    const val = await evalAndDrain(`
      fetch('https://example.com')
        .then(function(r) { return r.json(); })
        .then(function(d) { globalThis.out = d.a; });
    `);
    expect(val).toBe(1);
  }, 10_000);

  it('should support .then() with status check', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 201 }));
    const cap = new FetchCapability(makeStubProxyAuth());
    injectCap(vm, cap);
    const val = await evalAndDrain(`
      fetch('https://example.com')
        .then(function(r) { globalThis.out = r.status; });
    `);
    expect(val).toBe(201);
  }, 10_000);

  it('should not expose __rawFetch on globalThis', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const cap = new FetchCapability(makeStubProxyAuth());
    injectCap(vm, cap);
    const val = await evalAndDump(`typeof globalThis.__rawFetch;`);
    expect(val).toBe('undefined');
  });

  // ---------------------------------------------------------------
  // Routing + token exfiltration suite.
  // ---------------------------------------------------------------

  const TOKEN = 'secret-test-token-xyz-123';

  function mockOkResponse(body: string, contentType = 'text/plain'): Response {
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': contentType },
    });
  }

  it('A-11: cross-origin URL routes through POST /proxy/fetch', async () => {
    const spy = vi
      .fn()
      .mockResolvedValue(mockOkResponse('{"hello":"world"}', 'application/json'));
    globalThis.fetch = spy;

    const cap = new FetchCapability(
      makeStubProxyAuth({
        proxyBase: () => '',
        authHeader: () => `Bearer ${TOKEN}`,
      }),
    );
    injectCap(vm, cap);

    await evalAndDump(`
      var resp = fetch('https://api.example.com/data');
      resp.status;
    `);

    expect(spy).toHaveBeenCalledTimes(1);
    const [proxyUrl, init] = spy.mock.calls[0];
    expect(proxyUrl).toMatch(/\/proxy\/fetch$/);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body.url).toBe('https://api.example.com/data');
  });

  it('A-12: X-Proxy-Authorization header present on the proxy POST', async () => {
    const spy = vi.fn().mockResolvedValue(mockOkResponse('ok'));
    globalThis.fetch = spy;

    const cap = new FetchCapability(
      makeStubProxyAuth({
        proxyBase: () => '',
        authHeader: () => `Bearer ${TOKEN}`,
      }),
    );
    injectCap(vm, cap);

    await evalAndDump(`fetch('https://api.example.com/data').status;`);

    const [, init] = spy.mock.calls[0];
    expect(init.headers['X-Proxy-Authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('A-13: token string NOT in the body field of the proxy POST', async () => {
    const spy = vi.fn().mockResolvedValue(mockOkResponse('ok'));
    globalThis.fetch = spy;

    const cap = new FetchCapability(
      makeStubProxyAuth({
        proxyBase: () => '',
        authHeader: () => `Bearer ${TOKEN}`,
      }),
    );
    injectCap(vm, cap);

    await evalAndDump(`fetch('https://api.example.com/data').status;`);

    const [, init] = spy.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it('A-14: same-origin URL bypasses the proxy', async () => {
    const spy = vi.fn().mockResolvedValue(mockOkResponse('local ok'));
    globalThis.fetch = spy;

    const cap = new FetchCapability(
      makeStubProxyAuth({
        proxyBase: () => '',
        authHeader: () => `Bearer ${TOKEN}`,
      }),
    );
    injectCap(vm, cap);

    const sameOrigin = `${window.location.origin}/api/local`;
    await evalAndDump(`fetch(${JSON.stringify(sameOrigin)}).status;`);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url] = spy.mock.calls[0];
    expect(url).toBe(sameOrigin);
    expect(url).not.toMatch(/\/proxy\/fetch$/);
  });

  it('A-15: same-origin URL still bypasses when proxyBase is empty string', async () => {
    const spy = vi.fn().mockResolvedValue(mockOkResponse('local ok'));
    globalThis.fetch = spy;

    const cap = new FetchCapability(
      makeStubProxyAuth({
        proxyBase: () => '',
        authHeader: () => `Bearer ${TOKEN}`,
      }),
    );
    injectCap(vm, cap);

    const sameOrigin = `${window.location.origin}/api/local`;
    await evalAndDump(`fetch(${JSON.stringify(sameOrigin)}).status;`);

    const [url] = spy.mock.calls[0];
    expect(url).toBe(sameOrigin);
  });

  it('A-16: proxyBase null routes direct (AC #49 regression)', async () => {
    const spy = vi.fn().mockResolvedValue(mockOkResponse('direct'));
    globalThis.fetch = spy;

    const cap = new FetchCapability(
      makeStubProxyAuth({ proxyBase: () => null }),
    );
    injectCap(vm, cap);

    await evalAndDump(`fetch('https://api.example.com/data').status;`);

    const [url] = spy.mock.calls[0];
    expect(url).toBe('https://api.example.com/data');
    expect(url).not.toMatch(/\/proxy\/fetch$/);
  });

  it('A-18: 401 from proxy -> invalidate() called + error thrown', async () => {
    const invalidate = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('unauthorized', { status: 401 }),
    );

    const cap = new FetchCapability(
      makeStubProxyAuth({
        proxyBase: () => '',
        authHeader: () => `Bearer ${TOKEN}`,
        invalidate,
      }),
    );
    injectCap(vm, cap);

    const val = await evalAndDump(`
      try {
        fetch('https://api.example.com/data');
        'no error';
      } catch (e) {
        e.message;
      }
    `);

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(val).toContain('CORS proxy rejected the token');
  });

  it('A-19: missing token with proxy enabled throws locked Spec Mod #5 string', async () => {
    const invalidate = vi.fn();
    globalThis.fetch = vi.fn();

    const cap = new FetchCapability(
      makeStubProxyAuth({
        proxyBase: () => '',
        authHeader: () => null,
        invalidate,
      }),
    );
    injectCap(vm, cap);

    const val = await evalAndDump(`
      try {
        fetch('https://api.example.com/data');
        'no error';
      } catch (e) {
        e.message;
      }
    `);

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(val).toContain(
      'Proxy fetch failed: no authentication token. Use the token modal to enter your proxy key.',
    );
  });

  it('A-20: JSON.stringify(globalThis) inside VM does not contain token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockOkResponse('ok'));

    const cap = new FetchCapability(
      makeStubProxyAuth({
        proxyBase: () => '',
        authHeader: () => `Bearer ${TOKEN}`,
      }),
    );
    injectCap(vm, cap);

    const dump = await evalAndDump(`
      var keys = Object.keys(globalThis);
      keys.join(',');
    `);

    expect(String(dump)).not.toContain(TOKEN);
  });

  it('A-21: Object.getOwnPropertyNames(globalThis).join(",") does not contain token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockOkResponse('ok'));

    const cap = new FetchCapability(
      makeStubProxyAuth({
        proxyBase: () => '',
        authHeader: () => `Bearer ${TOKEN}`,
      }),
    );
    injectCap(vm, cap);

    const dump = await evalAndDump(`
      Object.getOwnPropertyNames(globalThis).join(',');
    `);

    expect(String(dump)).not.toContain(TOKEN);
  });

  it('A-22: Function.prototype.toString.call(fetch) does not contain token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(mockOkResponse('ok'));

    const cap = new FetchCapability(
      makeStubProxyAuth({
        proxyBase: () => '',
        authHeader: () => `Bearer ${TOKEN}`,
      }),
    );
    injectCap(vm, cap);

    const dump = await evalAndDump(`Function.prototype.toString.call(fetch);`);

    expect(String(dump)).not.toContain(TOKEN);
  });

  it('A-23: response body via .text() does not contain token', async () => {
    // Upstream returns a harmless body. The token must not leak through
    // the proxy response path.
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('safe body data with no secrets here', { status: 200 }),
    );

    const cap = new FetchCapability(
      makeStubProxyAuth({
        proxyBase: () => '',
        authHeader: () => `Bearer ${TOKEN}`,
      }),
    );
    injectCap(vm, cap);

    const body = await evalAndDump(`fetch('https://api.example.com/data').text();`);
    expect(String(body)).not.toContain(TOKEN);
  });

  it('A-24: rejected fetch error message does not contain token', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network kaboom'));

    const cap = new FetchCapability(
      makeStubProxyAuth({
        proxyBase: () => '',
        authHeader: () => `Bearer ${TOKEN}`,
      }),
    );
    injectCap(vm, cap);

    const val = await evalAndDump(`
      try {
        fetch('https://api.example.com/data');
        'no error';
      } catch (e) {
        e.message;
      }
    `);

    expect(String(val)).not.toContain(TOKEN);
  });

  it('A-28: hardcoded CORS note absent, fetch failed prefix present', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('network down'));

    const cap = new FetchCapability(
      makeStubProxyAuth({ proxyBase: () => null }),
    );
    injectCap(vm, cap);

    const val = await evalAndDump(`
      try {
        fetch('https://api.example.com/data');
        'no error';
      } catch (e) {
        e.message;
      }
    `);

    expect(String(val)).toContain('fetch failed');
    expect(String(val)).not.toContain('subject to browser CORS policy');
  });

  // ---------------------------------------------------------------
  // Host allow/deny policy (A36–A42). The capability checks it before any
  // routing, so a rejected URL never reaches globalThis.fetch (direct or
  // proxy).
  // ---------------------------------------------------------------

  // Runs fetch(url) in the guest; returns the error message, or
  // 'no error' when the fetch went through.
  async function guestFetch(url: string): Promise<string> {
    return String(await evalAndDump(`
      try {
        fetch(${JSON.stringify(url)});
        'no error';
      } catch (e) {
        e.message;
      }
    `));
  }

  function proxyAuthWithToken(authHeader = vi.fn(() => `Bearer ${TOKEN}`)): ProxyAuth {
    return makeStubProxyAuth({ proxyBase: () => '', authHeader });
  }

  describe('host allow/deny policy', () => {
    it('A36: a host outside allowHosts is rejected with no network call (direct)', async () => {
      const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
      globalThis.fetch = spy;
      const cap = new FetchCapability(makeStubProxyAuth(), { allowHosts: ['example.com'] });
      injectCap(vm, cap);

      const msg = await guestFetch('https://other.com/');

      expect(msg).toContain('not allowed');
      expect(msg).toContain('other.com');
      expect(spy).not.toHaveBeenCalled();
    });

    it('A36: a host outside allowHosts is rejected with no network call (proxy)', async () => {
      const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
      globalThis.fetch = spy;
      const authHeader = vi.fn(() => `Bearer ${TOKEN}`);
      const cap = new FetchCapability(proxyAuthWithToken(authHeader), {
        allowHosts: ['example.com'],
      });
      injectCap(vm, cap);

      const msg = await guestFetch('https://other.com/');

      expect(msg).toContain('not allowed');
      expect(spy).not.toHaveBeenCalled();
      expect(authHeader).not.toHaveBeenCalled();
    });

    it('A36: an allowed host goes through (direct and proxy)', async () => {
      const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
      globalThis.fetch = spy;
      const cap = new FetchCapability(proxyAuthWithToken(), { allowHosts: ['example.com'] });
      injectCap(vm, cap);

      expect(await guestFetch('https://example.com/data')).toBe('no error');
      expect(spy).toHaveBeenCalledTimes(1);
      const [proxyUrl, init] = spy.mock.calls[0];
      expect(proxyUrl).toMatch(/\/proxy\/fetch$/);
      expect(JSON.parse(init.body).url).toBe('https://example.com/data');
    });

    it('A37: a host in both allowHosts and denyHosts is denied', async () => {
      const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
      globalThis.fetch = spy;
      const cap = new FetchCapability(makeStubProxyAuth(), {
        allowHosts: ['example.com', 'api.example.com'],
        denyHosts: ['api.example.com'],
      });
      injectCap(vm, cap);

      expect(await guestFetch('https://api.example.com/x')).toContain('not allowed');
      expect(spy).not.toHaveBeenCalled();
      expect(await guestFetch('https://example.com/x')).toBe('no error');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('A37: a *. deny entry wins over an exact allow entry', async () => {
      const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
      globalThis.fetch = spy;
      const cap = new FetchCapability(makeStubProxyAuth(), {
        allowHosts: ['a.example.com'],
        denyHosts: ['*.example.com'],
      });
      injectCap(vm, cap);

      expect(await guestFetch('https://a.example.com/')).toContain('not allowed');
      expect(spy).not.toHaveBeenCalled();
    });

    it('A37: denyHosts alone blocks only the listed hosts', async () => {
      const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
      globalThis.fetch = spy;
      const cap = new FetchCapability(makeStubProxyAuth(), { denyHosts: ['evil.net'] });
      injectCap(vm, cap);

      expect(await guestFetch('https://evil.net/')).toContain('not allowed');
      expect(await guestFetch('https://EVIL.NET./x')).toContain('not allowed');
      expect(spy).not.toHaveBeenCalled();
      expect(await guestFetch('https://example.com/')).toBe('no error');
      expect(await guestFetch('https://sub.evil.net/')).toBe('no error');
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('A38: hostile URLs are rejected under allowHosts: [example.com]', async () => {
      const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
      globalThis.fetch = spy;
      const cap = new FetchCapability(proxyAuthWithToken(), { allowHosts: ['example.com'] });
      injectCap(vm, cap);

      const hostile = [
        'https://example.com.evil.net/',
        'https://evil.net/?h=example.com',
        'https://example.com@evil.net/',
        'https://evil.net/#example.com',
        'https://EXAMPLE.com.evil.net/',
        'https://evil.net/example.com',
        'https://example.com:pw@evil.net/',
        'https://sub.example.com/',
        'https://notexample.com/',
      ];
      for (const url of hostile) {
        expect(await guestFetch(url), url).toContain('not allowed');
      }
      expect(spy).not.toHaveBeenCalled();
    });

    it('A38: the hostname matches case-insensitively and ignores a trailing dot', async () => {
      const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
      globalThis.fetch = spy;
      const cap = new FetchCapability(makeStubProxyAuth(), { allowHosts: ['example.com'] });
      injectCap(vm, cap);

      expect(await guestFetch('https://EXAMPLE.COM/x')).toBe('no error');
      expect(await guestFetch('https://example.com./x')).toBe('no error');
      expect(await guestFetch('http://example.com:8080/x')).toBe('no error');
      expect(spy).toHaveBeenCalledTimes(3);
    });

    it('A38: list entries are normalized (case, whitespace, trailing dot)', async () => {
      const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
      globalThis.fetch = spy;
      const cap = new FetchCapability(makeStubProxyAuth(), {
        allowHosts: ['  Example.COM. ', '*.API.Test'],
      });
      injectCap(vm, cap);

      expect(await guestFetch('https://example.com/')).toBe('no error');
      expect(await guestFetch('https://v1.api.test/')).toBe('no error');
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('A38: subdomains match only through an explicit *. entry', async () => {
      const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
      globalThis.fetch = spy;
      const cap = new FetchCapability(makeStubProxyAuth(), { allowHosts: ['*.example.com'] });
      injectCap(vm, cap);

      expect(await guestFetch('https://api.example.com/')).toBe('no error');
      expect(await guestFetch('https://a.b.EXAMPLE.com/')).toBe('no error');
      expect(spy).toHaveBeenCalledTimes(2);
      // The wildcard matches subdomains only, not the apex.
      expect(await guestFetch('https://example.com/')).toContain('not allowed');
      expect(await guestFetch('https://example.com.evil.net/')).toContain('not allowed');
      expect(await guestFetch('https://evilexample.com/')).toContain('not allowed');
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('A38: invalid list entries throw at construction', () => {
      const auth = makeStubProxyAuth();
      for (const bad of ['', 'https://example.com', 'example.com/path', 'example.com:443',
        'user@example.com', '*', '*.', 'a.*.example.com', 'exa mple.com']) {
        expect(() => new FetchCapability(auth, { allowHosts: [bad] }), bad).toThrow(TypeError);
        expect(() => new FetchCapability(auth, { denyHosts: [bad] }), bad).toThrow(TypeError);
      }
    });

    it("A39: relative and same-origin URLs are checked against the page's hostname", async () => {
      const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
      globalThis.fetch = spy;
      const pageHost = window.location.hostname;
      const sameOrigin = `${window.location.origin}/api/local`;

      const denied = new FetchCapability(makeStubProxyAuth(), { allowHosts: ['example.com'] });
      injectCap(vm, denied);
      expect(await guestFetch('/api/local')).toContain('not allowed');
      expect(await guestFetch('api/local')).toContain('not allowed');
      expect(await guestFetch(sameOrigin)).toContain('not allowed');
      expect(spy).not.toHaveBeenCalled();

      try { vm.dispose(); } catch { /* ignore */ }
      try { runtime.dispose(); } catch { /* ignore */ }
      runtime = module.newRuntime();
      vm = runtime.newContext();

      const allowed = new FetchCapability(makeStubProxyAuth(), { allowHosts: [pageHost] });
      injectCap(vm, allowed);
      expect(await guestFetch('/api/local')).toBe('no error');
      expect(await guestFetch(sameOrigin)).toBe('no error');
      expect(spy).toHaveBeenCalledTimes(2);
    });

    it('A39: non-http(s) URLs are rejected whenever a list is configured', async () => {
      const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
      globalThis.fetch = spy;
      const urls = [
        'data:text/plain,hello',
        'blob:https://example.com/0e6b1e7c-0000-4000-8000-000000000000',
        'file:///etc/passwd',
        'javascript:alert(1)',
        'ftp://example.com/x',
      ];
      for (const options of [
        { allowHosts: ['example.com'] },
        { denyHosts: ['evil.net'] },
        { allowHosts: [] as string[] },
        { denyHosts: [] as string[] },
      ]) {
        try { vm.dispose(); } catch { /* ignore */ }
        try { runtime.dispose(); } catch { /* ignore */ }
        runtime = module.newRuntime();
        vm = runtime.newContext();
        injectCap(vm, new FetchCapability(makeStubProxyAuth(), options));
        for (const url of urls) {
          expect(await guestFetch(url), `${url} ${JSON.stringify(options)}`).toContain('not allowed');
        }
      }
      expect(spy).not.toHaveBeenCalled();
    });

    it('A39: an empty allowHosts list allows nothing', async () => {
      const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
      globalThis.fetch = spy;
      injectCap(vm, new FetchCapability(makeStubProxyAuth(), { allowHosts: [] }));

      expect(await guestFetch('https://example.com/')).toContain('not allowed');
      expect(await guestFetch('/relative')).toContain('not allowed');
      expect(spy).not.toHaveBeenCalled();
    });

    it('A40: no options (or empty options) leaves non-http(s) and every host untouched', async () => {
      const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
      globalThis.fetch = spy;
      injectCap(vm, new FetchCapability(makeStubProxyAuth(), {}));

      expect(await guestFetch('data:text/plain,hello')).toBe('no error');
      expect(await guestFetch('https://anything.example/')).toBe('no error');
      expect(spy.mock.calls.map((c) => c[0])).toEqual([
        'data:text/plain,hello',
        'https://anything.example/',
      ]);
    });

    it("A41: mutating the caller's arrays after construction does not change the policy", async () => {
      const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
      globalThis.fetch = spy;
      const allowHosts = ['example.com', 'evil.net'];
      const denyHosts = ['evil.net'];
      const cap = new FetchCapability(makeStubProxyAuth(), { allowHosts, denyHosts });
      injectCap(vm, cap);

      allowHosts.length = 0;
      allowHosts.push('other.com');
      denyHosts.length = 0;
      denyHosts.push('example.com');

      expect(await guestFetch('https://other.com/')).toContain('not allowed');
      expect(await guestFetch('https://evil.net/')).toContain('not allowed');
      expect(await guestFetch('https://example.com/')).toBe('no error');
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it('A41: neither the guest nor the capability object exposes the lists', async () => {
      globalThis.fetch = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
      const cap = new FetchCapability(makeStubProxyAuth(), {
        allowHosts: ['secret-allowed.example'],
        denyHosts: ['secret-denied.example'],
      });
      injectCap(vm, cap);

      const guestView = String(await evalAndDump(`
        var seen = [];
        Object.getOwnPropertyNames(globalThis).forEach(function (k) { seen.push(k); });
        Object.getOwnPropertyNames(fetch).forEach(function (k) {
          seen.push('fetch.' + k + '=' + String(fetch[k]));
        });
        seen.push(Function.prototype.toString.call(fetch));
        seen.join('|');
      `));
      for (const leak of ['secret-allowed', 'secret-denied', 'allowHosts', 'denyHosts']) {
        expect(guestView).not.toContain(leak);
      }

      const hostView = JSON.stringify(cap) + Object.keys(cap).join(',') + cap.setupScript;
      expect(hostView).not.toContain('secret-allowed');
      expect(hostView).not.toContain('secret-denied');
      expect((cap as unknown as Record<string, unknown>)['allowHosts']).toBeUndefined();
      expect((cap as unknown as Record<string, unknown>)['denyHosts']).toBeUndefined();
    });

    it('A41: the guest cannot widen the policy through invokeHost', async () => {
      const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
      globalThis.fetch = spy;
      const cap = new FetchCapability(makeStubProxyAuth(), { allowHosts: ['example.com'] });

      await expect(cap.invokeHost('setPolicy', [{ allowHosts: ['other.com'] }])).rejects.toThrow();
      await expect(
        cap.invokeHost('fetch', ['https://other.com/', { allowHosts: ['other.com'] }]),
      ).rejects.toThrow(/not allowed/);
      expect(spy).not.toHaveBeenCalled();
    });

    it('A42: a host-not-allowed error message never contains the proxy token', async () => {
      const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
      globalThis.fetch = spy;
      const authHeader = vi.fn(() => `Bearer ${TOKEN}`);
      const cap = new FetchCapability(proxyAuthWithToken(authHeader), {
        allowHosts: ['example.com'],
        denyHosts: ['blocked.example.com'],
      });
      injectCap(vm, cap);

      for (const url of [
        'https://other.com/',
        'https://blocked.example.com/',
        'data:text/plain,x',
        `https://other.com/?q=${TOKEN.slice(0, 6)}`,
      ]) {
        const msg = await guestFetch(url);
        expect(msg, url).toContain('not allowed');
        expect(msg, url).not.toContain(TOKEN);
        expect(msg, url).not.toContain('Bearer');
      }
      expect(authHeader).not.toHaveBeenCalled();
      expect(spy).not.toHaveBeenCalled();
    });

    describe('A66: malformed host lists throw instead of failing open', () => {
      it.each([
        ['a leading dot', '.evil.net'],
        ['a leading dot after the wildcard', '*..evil.net'],
        ['a lone dot', '.'],
        ['dots only', '..'],
        ['an empty label', 'a..b'],
        ['an empty label before the trailing dot', 'example.com..'],
        ['a bare *', '*'],
        ['*.', '*.'],
        ['a wildcard over a single label', '*.com'],
        ['a wildcard over a single label with a trailing dot', '*.com.'],
        ['a wildcard over an IPv4 literal', '*.0.0.1'],
        ['a wildcard over an IPv6 literal', '*.[::1]'],
      ])('A66: %s (%s) throws a TypeError in either list', (_, bad) => {
        const auth = makeStubProxyAuth();
        expect(() => new FetchCapability(auth, { allowHosts: [bad] })).toThrow(TypeError);
        expect(() => new FetchCapability(auth, { denyHosts: [bad] })).toThrow(TypeError);
        expect(() => new FetchCapability(auth, { denyHosts: ['ok.example', bad] })).toThrow(
          TypeError,
        );
      });

      it.each([
        ['a string', 'evil.net'],
        ['an empty string', ''],
        ['null', null],
        ['an object', { 0: 'evil.net', length: 1 }],
        ['a Set', new Set(['evil.net'])],
      ])('A66: a non-array list (%s) throws a TypeError', (_, list) => {
        const auth = makeStubProxyAuth();
        const asList = list as unknown as readonly string[];
        expect(() => new FetchCapability(auth, { allowHosts: asList })).toThrow(TypeError);
        expect(() => new FetchCapability(auth, { denyHosts: asList })).toThrow(TypeError);
      });

      it('A66: a non-string entry throws a TypeError', () => {
        const auth = makeStubProxyAuth();
        for (const bad of [42, null, undefined, ['evil.net'], { toString: () => 'evil.net' }]) {
          const list = [bad] as unknown as readonly string[];
          expect(() => new FetchCapability(auth, { allowHosts: list })).toThrow(TypeError);
          expect(() => new FetchCapability(auth, { denyHosts: list })).toThrow(TypeError);
        }
      });

      it('A66: a null or non-object options argument throws a clear TypeError', () => {
        const auth = makeStubProxyAuth();
        for (const bad of [null, 'allowHosts', 42]) {
          expect(
            () => new FetchCapability(auth, bad as unknown as FetchCapabilityOptions),
          ).toThrow(new TypeError('FetchCapability options must be an object.'));
        }
      });

      it('A66: well-formed entries are still accepted (positive control)', async () => {
        const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
        globalThis.fetch = spy;
        const auth = makeStubProxyAuth();
        expect(() => new FetchCapability(auth)).not.toThrow();
        expect(() => new FetchCapability(auth, {})).not.toThrow();
        expect(() => new FetchCapability(auth, { allowHosts: undefined })).not.toThrow();
        const cap = new FetchCapability(auth, {
          allowHosts: ['example.com.', '*.example.org', 'localhost', '127.0.0.1', '[::1]', '*.a.b'],
          denyHosts: ['evil.example.org'],
        });
        injectCap(vm, cap);
        expect(await guestFetch('https://example.com/')).toBe('no error');
        expect(await guestFetch('https://api.example.org/')).toBe('no error');
        expect(await guestFetch('https://x.a.b/')).toBe('no error');
        expect(await guestFetch('https://evil.example.org/')).toContain('not allowed');
        expect(spy).toHaveBeenCalledTimes(3);
      });

      it('A66: a dotted denyHosts entry that used to deny nothing now cannot be configured', async () => {
        // Before A66, denyHosts: ['.evil.net'] was accepted and blocked no request.
        expect(
          () => new FetchCapability(makeStubProxyAuth(), { denyHosts: ['.evil.net'] }),
        ).toThrow(/denyHosts/);
      });
    });
  });

  // ---------------------------------------------------------------
  // Promise behaviour of the guest response. The VM drains a bounded
  // number of jobs, so a job chain that never ends fails the spec and
  // does not hang it.
  // ---------------------------------------------------------------

  // Evaluates `code`, drains up to 10000 pending jobs, and returns the
  // value of `globalThis.out`.
  async function evalAndDrain(code: string): Promise<unknown> {
    await evalAndDump(code);
    const jobs = runtime.executePendingJobs(10_000);
    if (jobs.error) {
      const err = vm.dump(jobs.error);
      jobs.error.dispose();
      throw new Error(`Job failed: ${JSON.stringify(err)}`);
    }
    return evalAndDump('globalThis.out');
  }

  describe('await and promise chains on the guest response', () => {
    it('await fetch(url) settles to a response, and await r.json() gives the data', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"a":1}', { status: 200 }));
      injectCap(vm, new FetchCapability(makeStubProxyAuth()));
      const val = await evalAndDrain(`
        (async function () {
          var r = await fetch('https://example.com/');
          var d = await r.json();
          globalThis.out = [r.status, r.ok, d.a];
        })();
      `);
      expect(val).toEqual([200, true, 1]);
    }, 10_000);

    it('await fetch(url) then await r.text() gives the body', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('hello', { status: 200 }));
      injectCap(vm, new FetchCapability(makeStubProxyAuth()));
      const val = await evalAndDrain(`
        (async function () {
          var r = await fetch('https://example.com/');
          globalThis.out = await r.text();
        })();
      `);
      expect(val).toBe('hello');
    }, 10_000);

    it('the response thenable settles to a value that is not a thenable', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('x', { status: 202 }));
      injectCap(vm, new FetchCapability(makeStubProxyAuth()));
      const val = await evalAndDrain(`
        Promise.resolve(fetch('https://example.com/')).then(function (r) {
          globalThis.out = [typeof r.then, r.status];
        });
      `);
      expect(val).toEqual(['undefined', 202]);
    }, 10_000);

    it('fetch(url).then(r => r.json()).then(...) runs as a promise chain', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('{"n":7}', { status: 200 }));
      injectCap(vm, new FetchCapability(makeStubProxyAuth()));
      const val = await evalAndDrain(`
        fetch('https://example.com/')
          .then(function (r) { return r.json(); })
          .then(function (d) { globalThis.out = d.n * 2; });
      `);
      expect(val).toBe(14);
    }, 10_000);

    it('.catch() on the response chain gets an error thrown in a callback', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('not json', { status: 200 }));
      injectCap(vm, new FetchCapability(makeStubProxyAuth()));
      const val = await evalAndDrain(`
        fetch('https://example.com/')
          .then(function (r) { return r.json(); })
          .catch(function (e) { globalThis.out = e instanceof SyntaxError; });
      `);
      expect(val).toBe(true);
    }, 10_000);
  });

  // ---------------------------------------------------------------
  // Response size limit and cancel of requests in flight.
  // ---------------------------------------------------------------

  describe('maxResponseBytes and cleanup()', () => {
    function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
      const enc = new TextEncoder();
      let i = 0;
      return new ReadableStream<Uint8Array>({
        pull(controller) {
          if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
          else controller.close();
        },
      });
    }

    it('a body larger than maxResponseBytes fails with a clear error and cancels the stream', async () => {
      let cancelled = false;
      const enc = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(enc.encode('x'.repeat(64)));
        },
        cancel() {
          cancelled = true;
        },
      });
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
      const cap = new FetchCapability(makeStubProxyAuth(), { maxResponseBytes: 100 });

      await expect(cap.invokeHost('fetch', ['https://example.com/'])).rejects.toThrow(
        /fetch failed: .*maxResponseBytes.*100/,
      );
      expect(cancelled).toBe(true);
    });

    it('a body at the limit is accepted, and multi-byte text is decoded across chunks', async () => {
      // 'é' is 2 bytes in UTF-8. The split puts its bytes in two chunks.
      const bytes = new TextEncoder().encode('abécd');
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes.slice(0, 3));
          controller.enqueue(bytes.slice(3));
          controller.close();
        },
      });
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
      const cap = new FetchCapability(makeStubProxyAuth(), { maxResponseBytes: bytes.byteLength });

      const raw = await cap.invokeHost('fetch', ['https://example.com/']);
      expect(JSON.parse(String(raw)).body).toBe('abécd');
    });

    it('the default limit is 10 MiB', async () => {
      const mib = 1024 * 1024;
      globalThis.fetch = vi.fn().mockImplementation(async () =>
        new Response(streamOf(Array.from({ length: 11 }, () => 'y'.repeat(mib))), { status: 200 }),
      );
      const cap = new FetchCapability(makeStubProxyAuth());
      await expect(cap.invokeHost('fetch', ['https://example.com/'])).rejects.toThrow(
        /maxResponseBytes/,
      );

      globalThis.fetch = vi.fn().mockImplementation(async () =>
        new Response(streamOf(Array.from({ length: 10 }, () => 'y'.repeat(mib))), { status: 200 }),
      );
      const raw = await cap.invokeHost('fetch', ['https://example.com/']);
      expect(JSON.parse(String(raw)).body.length).toBe(10 * mib);
    }, 30_000);

    it('the guest sees the size error as a fetch failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('z'.repeat(50), { status: 200 }));
      injectCap(vm, new FetchCapability(makeStubProxyAuth(), { maxResponseBytes: 10 }));
      const msg = String(await evalAndDump(`
        try { fetch('https://example.com/'); 'no error'; } catch (e) { e.message; }
      `));
      expect(msg).toContain('fetch failed');
      expect(msg).toContain('maxResponseBytes');
    });

    it('an invalid maxResponseBytes throws a TypeError at construction', () => {
      const auth = makeStubProxyAuth();
      for (const bad of [0, -1, 1.5, NaN, Infinity, '100', null]) {
        expect(
          () => new FetchCapability(auth, { maxResponseBytes: bad as unknown as number }),
          String(bad),
        ).toThrow(TypeError);
      }
      expect(() => new FetchCapability(auth, { maxResponseBytes: 1 })).not.toThrow();
    });

    it('cleanup() aborts every request in flight (direct and proxy)', async () => {
      const signals: AbortSignal[] = [];
      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init.signal!;
            signals.push(signal);
            signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
          }),
      );
      const direct = new FetchCapability(makeStubProxyAuth());
      const proxied = new FetchCapability(proxyAuthWithToken());

      const calls = [
        direct.invokeHost('fetch', ['https://a.example/']),
        direct.invokeHost('fetch', ['https://b.example/']),
        proxied.invokeHost('fetch', ['https://c.example/']),
      ];
      await vi.waitFor(() => expect(signals).toHaveLength(3));
      expect(signals.some((s) => s.aborted)).toBe(false);

      direct.cleanup();
      proxied.cleanup();

      expect(signals.every((s) => s.aborted)).toBe(true);
      for (const call of calls) await expect(call).rejects.toThrow(/fetch failed/);
    });

    it('cleanup() also stops a body read that is in progress', async () => {
      // The body never ends, and it ignores the signal. Only a cancel of
      // the reader can stop the read.
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('part'));
        },
        cancel() {
          cancelled = true;
        },
      });
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
      const cap = new FetchCapability(makeStubProxyAuth());
      const call = cap.invokeHost('fetch', ['https://example.com/']);
      await new Promise((r) => setTimeout(r, 20));
      cap.cleanup();
      await expect(call).rejects.toThrow(/fetch failed/);
      expect(cancelled).toBe(true);
    }, 10_000);
  });

  // ---------------------------------------------------------------
  // Proxy URL join and URL resolution.
  // ---------------------------------------------------------------

  describe('proxy URL and URL resolution', () => {
    async function proxyCallFor(base: string): Promise<string> {
      const spy = vi.fn().mockResolvedValue(mockOkResponse('ok'));
      globalThis.fetch = spy;
      const cap = new FetchCapability(
        makeStubProxyAuth({ proxyBase: () => base, authHeader: () => `Bearer ${TOKEN}` }),
      );
      await cap.invokeHost('fetch', ['https://api.example.com/data']);
      expect(spy).toHaveBeenCalledTimes(1);
      return String(spy.mock.calls[0][0]);
    }

    it('the proxy URL is joined with one slash', async () => {
      const origin = window.location.origin;
      expect(await proxyCallFor('')).toBe(`${origin}/proxy/fetch`);
      expect(await proxyCallFor('/')).toBe(`${origin}/proxy/fetch`);
      expect(await proxyCallFor('//')).toBe(`${origin}/proxy/fetch`);
      expect(await proxyCallFor('/sub/')).toBe(`${origin}/sub/proxy/fetch`);
      expect(await proxyCallFor('https://proxy.example.com')).toBe('https://proxy.example.com/proxy/fetch');
      expect(await proxyCallFor('https://proxy.example.com/')).toBe('https://proxy.example.com/proxy/fetch');
      expect(await proxyCallFor('https://proxy.example.com//')).toBe('https://proxy.example.com/proxy/fetch');
      expect(await proxyCallFor('https://proxy.example.com/base/')).toBe(
        'https://proxy.example.com/base/proxy/fetch',
      );
    });

    it('the token goes only to the host of the proxy base', async () => {
      const page = window.location.href;
      const cases: [string, string][] = [
        ['', window.location.host],
        ['/', window.location.host],
        ['//', window.location.host],
        ['/sub/', window.location.host],
        ['https://proxy.example.com/', 'proxy.example.com'],
        ['https://proxy.example.com:8443//', 'proxy.example.com:8443'],
      ];
      for (const [base, host] of cases) {
        const spy = vi.fn().mockResolvedValue(mockOkResponse('ok'));
        globalThis.fetch = spy;
        const cap = new FetchCapability(
          makeStubProxyAuth({ proxyBase: () => base, authHeader: () => `Bearer ${TOKEN}` }),
        );
        await cap.invokeHost('fetch', ['https://api.example.com/data']);
        const [target, init] = spy.mock.calls[0];
        expect(init.headers['X-Proxy-Authorization']).toBe(`Bearer ${TOKEN}`);
        expect(new URL(String(target), page).host, JSON.stringify(base)).toBe(host);
      }
    });

    describe('with a <base> element', () => {
      let baseEl: HTMLBaseElement;
      beforeEach(() => {
        baseEl = document.createElement('base');
        baseEl.href = 'https://cdn.example.net/assets/';
        document.head.appendChild(baseEl);
      });
      afterEach(() => {
        baseEl.remove();
      });

      it('a relative URL resolves against document.baseURI for the request and the route', async () => {
        const spy = vi.fn().mockResolvedValue(mockOkResponse('ok'));
        globalThis.fetch = spy;
        const cap = new FetchCapability(
          makeStubProxyAuth({ proxyBase: () => '', authHeader: () => `Bearer ${TOKEN}` }),
        );
        await cap.invokeHost('fetch', ['data.json']);
        // The resolved URL is cross-origin. Thus the request goes to the
        // proxy, with the absolute URL.
        // The proxy URL resolves against the page, not the <base>, so the
        // token does not go to cdn.example.net.
        const [target, init] = spy.mock.calls[0];
        expect(target).toBe(`${window.location.origin}/proxy/fetch`);
        expect(init.headers['X-Proxy-Authorization']).toBe(`Bearer ${TOKEN}`);
        expect(JSON.parse(init.body).url).toBe('https://cdn.example.net/assets/data.json');
      });

      it('without a proxy, the direct request uses the same resolved URL', async () => {
        const spy = vi.fn().mockResolvedValue(mockOkResponse('ok'));
        globalThis.fetch = spy;
        const cap = new FetchCapability(makeStubProxyAuth());
        await cap.invokeHost('fetch', ['data.json']);
        expect(spy.mock.calls[0][0]).toBe('https://cdn.example.net/assets/data.json');
      });

      it('the host policy examines the URL that resolves against document.baseURI', async () => {
        const spy = vi.fn().mockResolvedValue(mockOkResponse('ok'));
        globalThis.fetch = spy;
        const cap = new FetchCapability(makeStubProxyAuth(), {
          allowHosts: [window.location.hostname],
        });
        await expect(cap.invokeHost('fetch', ['data.json'])).rejects.toThrow(
          /cdn\.example\.net.*not allowed/,
        );
        expect(spy).not.toHaveBeenCalled();
      });
    });

    it('a relative same-origin URL goes direct with the resolved absolute URL', async () => {
      const spy = vi.fn().mockResolvedValue(mockOkResponse('ok'));
      globalThis.fetch = spy;
      const cap = new FetchCapability(
        makeStubProxyAuth({
          proxyBase: () => 'https://proxy.example.com',
          authHeader: () => `Bearer ${TOKEN}`,
        }),
      );
      await cap.invokeHost('fetch', ['/api/local']);
      expect(spy.mock.calls[0][0]).toBe(`${window.location.origin}/api/local`);
    });
  });
}, 30000);
