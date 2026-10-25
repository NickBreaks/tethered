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
import { SuspendGate } from '../../workers/engine-async.js';
import type { SandboxCapability } from './capability.js';
import type { ProxyAuth } from '../proxy/proxy-auth.js';

// Injects the capability's guest API the way the worker does: bridge
// functions that relay to invokeHost on the (test) main thread.
const gate = new SuspendGate();
function injectCap(vm: QuickJSAsyncContext, cap: SandboxCapability): void {
  injectCapabilityBridge(
    vm,
    { name: cap.name, stub: cap.stubInfo, setupScript: cap.setupScript },
    (method, args) => cap.invokeHost!(method, args),
    gate,
  );
}

// Evaluates guest code the way the worker does: the gate is open, thus a
// host call can suspend the engine.
function evalAsync(vm: QuickJSAsyncContext, code: string) {
  return gate.suspendable(() => vm.evalCodeAsync(code));
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
    try {
      vm.dispose();
    } catch {
      /* already disposed */
    }
    try {
      runtime.dispose();
    } catch {
      /* already disposed */
    }
  });

  // Helper: evalCodeAsync returns the resolved value for asyncified functions
  async function evalAndDump(code: string): Promise<unknown> {
    const result = await evalAsync(vm, code);
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
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('OK', { status: 200, statusText: 'OK' }));
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

  it.each<[string, string, ResponseInit, string, unknown]>([
    ['should return text body', 'Hello World', { status: 200 }, 'resp.text()', 'Hello World'],
    [
      'should return parsed JSON',
      '{"key":"value"}',
      { status: 200 },
      'resp.json()',
      { key: 'value' },
    ],
    ['should report ok as true for 200', 'OK', { status: 200 }, 'resp.ok', true],
    [
      'should report ok as false for 404',
      'Not Found',
      { status: 404, statusText: 'Not Found' },
      'resp.ok',
      false,
    ],
    ['should return statusText', '', { status: 200, statusText: 'OK' }, 'resp.statusText', 'OK'],
  ])('%s', async (_name, body, init, expr, expected) => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response(body, init));
    injectCap(vm, new FetchCapability(makeStubProxyAuth()));
    const val = await evalAndDump(`
      var resp = fetch('https://example.com');
      ${expr};
    `);
    expect(val).toEqual(expected);
  });

  it('should send POST with body', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('created', { status: 201, statusText: 'Created' }));
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
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com/api',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"data": 1}',
      }),
    );
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
    expect(val).toBe('fetch failed: Failed to fetch');
  });

  it('should not expose the raw bridge (__rawFetch or rawFetch) on globalThis', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const cap = new FetchCapability(makeStubProxyAuth());
    injectCap(vm, cap);
    // The raw bridge returns a JSON string. The wrapper returns an object.
    // Thus an object result shows that the global fetch is the wrapper.
    const val = await evalAndDump(`
      [typeof globalThis.__rawFetch, typeof globalThis.rawFetch, typeof fetch('https://example.com')];
    `);
    expect(val).toEqual(['undefined', 'undefined', 'object']);
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

  // Replaces globalThis.fetch with a spy that answers 200 'ok' to each call.
  function okFetch(): ReturnType<typeof vi.fn> {
    const spy = vi.fn().mockImplementation(async () => mockOkResponse('ok'));
    globalThis.fetch = spy;
    return spy;
  }

  // Runs code in the guest. Returns the error message, or the value of
  // the code when it does not throw.
  async function guestTry(code: string): Promise<unknown> {
    return evalAndDump(`
      try {
        ${code}
      } catch (e) {
        e.message;
      }
    `);
  }

  it.each<[string, string, Record<string, unknown>]>([
    [
      'GET with the defaults',
      `fetch('https://api.example.com/data').status;`,
      { url: 'https://api.example.com/data', method: 'GET', headers: {}, body: null },
    ],
    [
      'the method, headers and body of the guest',
      `fetch('https://api.example.com/data', {
        method: 'PUT', headers: { 'X-A': '1' }, body: 'payload'
      }).status;`,
      {
        url: 'https://api.example.com/data',
        method: 'PUT',
        headers: { 'X-A': '1' },
        body: 'payload',
      },
    ],
  ])('cross-origin URL routes through POST /proxy/fetch (%s)', async (_name, code, expected) => {
    const spy = vi.fn().mockResolvedValue(mockOkResponse('{"hello":"world"}', 'application/json'));
    globalThis.fetch = spy;

    const cap = new FetchCapability(
      makeStubProxyAuth({
        proxyBase: () => '',
        authHeader: () => `Bearer ${TOKEN}`,
      }),
    );
    injectCap(vm, cap);

    expect(await evalAndDump(code)).toBe(200);

    expect(spy).toHaveBeenCalledTimes(1);
    const [proxyUrl, init] = spy.mock.calls[0];
    expect(proxyUrl).toBe(`${window.location.origin}/proxy/fetch`);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual(expected);
  });

  it('X-Proxy-Authorization header present on the proxy POST', async () => {
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

  it('the proxy POST refuses redirects, so the token header cannot follow one', async () => {
    const spy = vi.fn().mockResolvedValue(mockOkResponse('ok'));
    globalThis.fetch = spy;

    const cap = new FetchCapability(
      makeStubProxyAuth({
        proxyBase: () => 'https://proxy.example.com',
        authHeader: () => `Bearer ${TOKEN}`,
      }),
    );
    injectCap(vm, cap);

    await evalAndDump(`fetch('https://api.example.com/data').status;`);

    const [, init] = spy.mock.calls[0];
    expect(init.redirect).toBe('error');
  });

  it('token string NOT in the body field of the proxy POST', async () => {
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

  it.each([
    ['same-origin URL bypasses the proxy (absolute proxyBase)', 'https://proxy.example.com'],
    ['same-origin URL still bypasses when proxyBase is empty string', ''],
  ])('%s', async (_name, base) => {
    const spy = vi.fn().mockResolvedValue(mockOkResponse('local ok'));
    globalThis.fetch = spy;
    const authHeader = vi.fn(() => `Bearer ${TOKEN}`);

    const cap = new FetchCapability(makeStubProxyAuth({ proxyBase: () => base, authHeader }));
    injectCap(vm, cap);

    const sameOrigin = `${window.location.origin}/api/local`;
    await evalAndDump(`fetch(${JSON.stringify(sameOrigin)}).status;`);

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0];
    expect(url).toBe(sameOrigin);
    expect(init.headers).toBeUndefined();
    // A direct request does not read the token.
    expect(authHeader).not.toHaveBeenCalled();
  });

  it('proxyBase null routes direct (AC #49 regression)', async () => {
    const spy = vi.fn().mockResolvedValue(mockOkResponse('direct'));
    globalThis.fetch = spy;

    const cap = new FetchCapability(makeStubProxyAuth({ proxyBase: () => null }));
    injectCap(vm, cap);

    await evalAndDump(`fetch('https://api.example.com/data').status;`);

    const [url] = spy.mock.calls[0];
    expect(url).toBe('https://api.example.com/data');
    expect(url).not.toMatch(/\/proxy\/fetch$/);
  });

  it('401 from proxy -> invalidate() called + error thrown', async () => {
    const invalidate = vi.fn();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response('unauthorized', { status: 401, headers: { 'X-Proxy-Error': 'unauthorized' } }),
      );

    const cap = new FetchCapability(
      makeStubProxyAuth({
        proxyBase: () => '',
        authHeader: () => `Bearer ${TOKEN}`,
        invalidate,
      }),
    );
    injectCap(vm, cap);

    const val = await guestTry(`fetch('https://api.example.com/data'); 'no error';`);

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(val).toBe('fetch failed: CORS proxy rejected the token. Re-enter a valid token.');
  });

  it('a 401 that the proxy relays from the destination goes to the guest and keeps the token', async () => {
    const invalidate = vi.fn();
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('login required', { status: 401 }));

    const cap = new FetchCapability(
      makeStubProxyAuth({
        proxyBase: () => '',
        authHeader: () => `Bearer ${TOKEN}`,
        invalidate,
      }),
    );
    injectCap(vm, cap);

    const val = await evalAndDump(
      `var r = fetch('https://api.example.com/data'); [r.status, r.text()].join(' ');`,
    );

    expect(val).toBe('401 login required');
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('missing token with proxy enabled throws the missing-token error', async () => {
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

    const val = await guestTry(`fetch('https://api.example.com/data'); 'no error';`);

    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(val).toContain(
      'Proxy fetch failed: no authentication token. Set the proxy token with ProxyAuth.setToken().',
    );
    // With no token, the host does not send the request.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  // Each guest expression runs after a fetch through the proxy. Thus the
  // host read the token before the guest looks for it.
  it.each([
    [
      'JSON.stringify(globalThis) inside VM does not contain token',
      `JSON.stringify(globalThis) + '|' + Object.keys(globalThis).join(',')`,
    ],
    [
      'Object.getOwnPropertyNames(globalThis).join(",") does not contain token',
      `Object.getOwnPropertyNames(globalThis).join(',')`,
    ],
    [
      'Function.prototype.toString.call(fetch) does not contain token',
      'Function.prototype.toString.call(fetch)',
    ],
  ])('%s', async (_name, expr) => {
    const spy = okFetch();
    const authHeader = vi.fn(() => `Bearer ${TOKEN}`);
    injectCap(vm, new FetchCapability(proxyAuthWithToken(authHeader)));

    const dump = await evalAndDump(`
      var r = fetch('https://api.example.com/data');
      ${expr};
    `);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(authHeader).toHaveBeenCalled();
    expect(String(dump)).not.toContain(TOKEN);
  });

  it('the response (.text() and its fields) does not contain token', async () => {
    // The proxy response has a header with the token. The guest response
    // gets only status, ok, statusText and the body. Thus the token must
    // not reach the guest.
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('safe body data with no secrets here', {
        status: 200,
        headers: { 'X-Echo-Authorization': `Bearer ${TOKEN}` },
      }),
    );

    const cap = new FetchCapability(
      makeStubProxyAuth({
        proxyBase: () => '',
        authHeader: () => `Bearer ${TOKEN}`,
      }),
    );
    injectCap(vm, cap);

    const view = String(
      await evalAndDump(`
      var r = fetch('https://api.example.com/data');
      r.text() + '|' + JSON.stringify(r) + '|' + Object.getOwnPropertyNames(r).join(',');
    `),
    );
    expect(view).toContain('safe body data with no secrets here');
    expect(view).not.toContain(TOKEN);
  });

  it('rejected fetch error message does not contain token', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network kaboom'));

    const cap = new FetchCapability(
      makeStubProxyAuth({
        proxyBase: () => '',
        authHeader: () => `Bearer ${TOKEN}`,
      }),
    );
    injectCap(vm, cap);

    const val = await guestTry(`fetch('https://api.example.com/data'); 'no error';`);

    // The error comes from the proxy request, which carries the token.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(val).toBe('fetch failed: network kaboom');
    expect(String(val)).not.toContain(TOKEN);
  });

  // ---------------------------------------------------------------
  // Host allow/deny policy. The capability checks it before any
  // routing, so a rejected URL never reaches globalThis.fetch (direct or
  // proxy).
  // ---------------------------------------------------------------

  // Runs fetch(url) in the guest; returns the error message, or
  // 'no error' when the fetch went through.
  async function guestFetch(url: string): Promise<string> {
    return String(await guestTry(`fetch(${JSON.stringify(url)}); 'no error';`));
  }

  function proxyAuthWithToken(authHeader = vi.fn(() => `Bearer ${TOKEN}`)): ProxyAuth {
    return makeStubProxyAuth({ proxyBase: () => '', authHeader });
  }

  describe('host allow/deny policy', () => {
    const pageOrigin = window.location.origin;
    const sameOrigin = `${pageOrigin}/api/local`;

    it.each([
      ['direct', null],
      ['proxy', ''],
    ])('a host outside allowHosts is rejected with no network call (%s)', async (_mode, base) => {
      const spy = okFetch();
      const authHeader = vi.fn(() => `Bearer ${TOKEN}`);
      const cap = new FetchCapability(makeStubProxyAuth({ proxyBase: () => base, authHeader }), {
        allowHosts: ['example.com'],
      });
      injectCap(vm, cap);

      const msg = await guestFetch('https://other.com/');

      expect(msg).toContain('not allowed');
      expect(msg).toContain('other.com');
      expect(spy).not.toHaveBeenCalled();
      expect(authHeader).not.toHaveBeenCalled();
    });

    it.each([
      ['direct', null, 'https://example.com/data'],
      ['proxy', '', `${pageOrigin}/proxy/fetch`],
    ])('an allowed host goes through (%s)', async (_mode, base, target) => {
      const spy = okFetch();
      const cap = new FetchCapability(
        makeStubProxyAuth({ proxyBase: () => base, authHeader: () => `Bearer ${TOKEN}` }),
        { allowHosts: ['example.com'] },
      );
      injectCap(vm, cap);

      expect(await guestFetch('https://example.com/data')).toBe('no error');
      expect(spy).toHaveBeenCalledTimes(1);
      const [url, init] = spy.mock.calls[0];
      expect(url).toBe(target);
      // The proxy gets the destination in the JSON body.
      const destination = base === null ? url : JSON.parse(init.body).url;
      expect(destination).toBe('https://example.com/data');
    });

    it('a host in both allowHosts and denyHosts is denied', async () => {
      const spy = okFetch();
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

    it('a *. deny entry wins over an exact allow entry', async () => {
      const spy = okFetch();
      const cap = new FetchCapability(makeStubProxyAuth(), {
        allowHosts: ['a.example.com'],
        denyHosts: ['*.example.com'],
      });
      injectCap(vm, cap);

      expect(await guestFetch('https://a.example.com/')).toContain('not allowed');
      expect(spy).not.toHaveBeenCalled();
    });

    it.each([
      ['https://evil.net/', false],
      ['https://EVIL.NET./x', false],
      ['https://example.com/', true],
      ['https://sub.evil.net/', true],
    ])(
      'denyHosts alone blocks only the listed hosts (%s goes through: %s)',
      async (url, passes) => {
        const spy = okFetch();
        injectCap(vm, new FetchCapability(makeStubProxyAuth(), { denyHosts: ['evil.net'] }));

        const msg = await guestFetch(url);

        if (passes) expect(msg).toBe('no error');
        else expect(msg).toContain('not allowed');
        expect(spy).toHaveBeenCalledTimes(passes ? 1 : 0);
      },
    );

    it.each([
      'https://example.com.evil.net/',
      'https://evil.net/?h=example.com',
      'https://example.com@evil.net/',
      'https://evil.net/#example.com',
      'https://EXAMPLE.com.evil.net/',
      'https://evil.net/example.com',
      'https://example.com:pw@evil.net/',
      'https://sub.example.com/',
      'https://notexample.com/',
    ])('hostile URL %s is rejected under allowHosts: [example.com]', async (url) => {
      const spy = okFetch();
      injectCap(vm, new FetchCapability(proxyAuthWithToken(), { allowHosts: ['example.com'] }));

      expect(await guestFetch(url)).toContain('not allowed');
      expect(spy).not.toHaveBeenCalled();
    });

    it.each(['https://EXAMPLE.COM/x', 'https://example.com./x', 'http://example.com:8080/x'])(
      'the hostname matches case-insensitively and ignores a trailing dot and the port (%s)',
      async (url) => {
        const spy = okFetch();
        injectCap(vm, new FetchCapability(makeStubProxyAuth(), { allowHosts: ['example.com'] }));

        expect(await guestFetch(url)).toBe('no error');
        expect(spy).toHaveBeenCalledTimes(1);
      },
    );

    it('list entries are normalized (case, whitespace, trailing dot)', async () => {
      const spy = okFetch();
      const cap = new FetchCapability(makeStubProxyAuth(), {
        allowHosts: ['  Example.COM. ', '*.API.Test'],
      });
      injectCap(vm, cap);

      expect(await guestFetch('https://example.com/')).toBe('no error');
      expect(await guestFetch('https://v1.api.test/')).toBe('no error');
      expect(spy).toHaveBeenCalledTimes(2);
    });

    // The wildcard matches subdomains only, not the apex.
    it.each([
      ['https://api.example.com/', true],
      ['https://a.b.EXAMPLE.com/', true],
      ['https://example.com/', false],
      ['https://example.com.evil.net/', false],
      ['https://evilexample.com/', false],
    ])(
      'subdomains match only through an explicit *. entry (%s goes through: %s)',
      async (url, passes) => {
        const spy = okFetch();
        injectCap(vm, new FetchCapability(makeStubProxyAuth(), { allowHosts: ['*.example.com'] }));

        const msg = await guestFetch(url);

        if (passes) expect(msg).toBe('no error');
        else expect(msg).toContain('not allowed');
        expect(spy).toHaveBeenCalledTimes(passes ? 1 : 0);
      },
    );

    it.each([
      '',
      'https://example.com',
      'example.com/path',
      'example.com:443',
      'user@example.com',
      '*',
      '*.',
      'a.*.example.com',
      'exa mple.com',
    ])('invalid list entry %j throws at construction', (bad) => {
      const auth = makeStubProxyAuth();
      expect(() => new FetchCapability(auth, { allowHosts: [bad] })).toThrow(TypeError);
      expect(() => new FetchCapability(auth, { denyHosts: [bad] })).toThrow(TypeError);
    });

    it.each(['/api/local', 'api/local', sameOrigin])(
      "under allowHosts: [example.com], the page URL %s is checked against the page's hostname and rejected",
      async (url) => {
        const spy = okFetch();
        injectCap(vm, new FetchCapability(makeStubProxyAuth(), { allowHosts: ['example.com'] }));

        expect(await guestFetch(url)).toContain('not allowed');
        expect(spy).not.toHaveBeenCalled();
      },
    );

    it.each(['/api/local', sameOrigin])(
      'under allowHosts: [page hostname], the page URL %s goes through',
      async (url) => {
        const spy = okFetch();
        injectCap(
          vm,
          new FetchCapability(makeStubProxyAuth(), { allowHosts: [window.location.hostname] }),
        );

        expect(await guestFetch(url)).toBe('no error');
        expect(spy).toHaveBeenCalledTimes(1);
        expect(spy.mock.calls[0][0]).toBe(sameOrigin);
      },
    );

    describe.each<[string, FetchCapabilityOptions]>([
      ['allowHosts: [example.com]', { allowHosts: ['example.com'] }],
      ['denyHosts: [evil.net]', { denyHosts: ['evil.net'] }],
      ['allowHosts: []', { allowHosts: [] }],
      ['denyHosts: []', { denyHosts: [] }],
    ])('non-http(s) URLs are rejected whenever a list is configured (%s)', (_label, options) => {
      it.each([
        'data:text/plain,hello',
        'blob:https://example.com/0e6b1e7c-0000-4000-8000-000000000000',
        'file:///etc/passwd',
        'javascript:alert(1)',
        'ftp://example.com/x',
      ])('%s is rejected', async (url) => {
        const spy = okFetch();
        injectCap(vm, new FetchCapability(makeStubProxyAuth(), options));

        expect(await guestFetch(url)).toContain('not allowed');
        expect(spy).not.toHaveBeenCalled();
      });
    });

    it('an empty allowHosts list allows nothing', async () => {
      const spy = okFetch();
      injectCap(vm, new FetchCapability(makeStubProxyAuth(), { allowHosts: [] }));

      expect(await guestFetch('https://example.com/')).toContain('not allowed');
      expect(await guestFetch('/relative')).toContain('not allowed');
      expect(spy).not.toHaveBeenCalled();
    });

    it.each<[string, FetchCapabilityOptions | undefined]>([
      ['no options', undefined],
      ['empty options', {}],
    ])('%s leaves non-http(s) and every host untouched', async (_label, options) => {
      const spy = okFetch();
      injectCap(vm, new FetchCapability(makeStubProxyAuth(), options));

      expect(await guestFetch('data:text/plain,hello')).toBe('no error');
      expect(await guestFetch('https://anything.example/')).toBe('no error');
      expect(spy.mock.calls.map((c) => c[0])).toEqual([
        'data:text/plain,hello',
        'https://anything.example/',
      ]);
    });

    it("mutating the caller's arrays after construction does not change the policy", async () => {
      const spy = okFetch();
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

    it('neither the guest nor the capability object exposes the lists', async () => {
      okFetch();
      const cap = new FetchCapability(makeStubProxyAuth(), {
        allowHosts: ['secret-allowed.example'],
        denyHosts: ['secret-denied.example'],
      });
      injectCap(vm, cap);

      const guestView = String(
        await evalAndDump(`
        var seen = [];
        Object.getOwnPropertyNames(globalThis).forEach(function (k) { seen.push(k); });
        Object.getOwnPropertyNames(fetch).forEach(function (k) {
          seen.push('fetch.' + k + '=' + String(fetch[k]));
        });
        seen.push(Function.prototype.toString.call(fetch));
        seen.join('|');
      `),
      );
      for (const leak of ['secret-allowed', 'secret-denied', 'allowHosts', 'denyHosts']) {
        expect(guestView).not.toContain(leak);
      }

      const hostView = JSON.stringify(cap) + Object.keys(cap).join(',') + cap.setupScript;
      expect(hostView).not.toContain('secret-allowed');
      expect(hostView).not.toContain('secret-denied');
      expect((cap as unknown as Record<string, unknown>)['allowHosts']).toBeUndefined();
      expect((cap as unknown as Record<string, unknown>)['denyHosts']).toBeUndefined();
    });

    it('the guest cannot widen the policy through invokeHost', async () => {
      const spy = okFetch();
      const cap = new FetchCapability(makeStubProxyAuth(), { allowHosts: ['example.com'] });

      await expect(cap.invokeHost('setPolicy', [{ allowHosts: ['other.com'] }])).rejects.toThrow(
        'fetch.setPolicy is not implemented',
      );
      await expect(
        cap.invokeHost('fetch', ['https://other.com/', { allowHosts: ['other.com'] }]),
      ).rejects.toThrow(/not allowed/);
      expect(spy).not.toHaveBeenCalled();
    });

    it('a host-not-allowed error message never contains the proxy token', async () => {
      const spy = okFetch();
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

    describe('malformed host lists throw instead of failing open', () => {
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
      ])('%s (%s) throws a TypeError in either list', (_, bad) => {
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
      ])('a non-array list (%s) throws a TypeError', (_, list) => {
        const auth = makeStubProxyAuth();
        const asList = list as unknown as readonly string[];
        expect(() => new FetchCapability(auth, { allowHosts: asList })).toThrow(TypeError);
        expect(() => new FetchCapability(auth, { denyHosts: asList })).toThrow(TypeError);
      });

      it.each([
        ['a number', 42],
        ['null', null],
        ['undefined', undefined],
        ['an array', ['evil.net']],
        ['an object with toString', { toString: () => 'evil.net' }],
      ])('a non-string entry (%s) throws a TypeError', (_, bad) => {
        const auth = makeStubProxyAuth();
        const list = [bad] as unknown as readonly string[];
        expect(() => new FetchCapability(auth, { allowHosts: list })).toThrow(TypeError);
        expect(() => new FetchCapability(auth, { denyHosts: list })).toThrow(TypeError);
      });

      it.each([
        ['null', null],
        ['a string', 'allowHosts'],
        ['a number', 42],
      ])('a non-object options argument (%s) throws a clear TypeError', (_, bad) => {
        expect(
          () => new FetchCapability(makeStubProxyAuth(), bad as unknown as FetchCapabilityOptions),
        ).toThrow(new TypeError('FetchCapability options must be an object.'));
      });

      it('well-formed entries are still accepted (positive control)', async () => {
        const spy = okFetch();
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
        expect(await guestFetch('http://127.0.0.1/')).toBe('no error');
        expect(await guestFetch('http://[::1]/')).toBe('no error');
        expect(await guestFetch('https://evil.example.org/')).toContain('not allowed');
        expect(spy).toHaveBeenCalledTimes(5);
      });

      it('a dotted denyHosts entry that used to deny nothing now cannot be configured', async () => {
        // Before, denyHosts: ['.evil.net'] was accepted and blocked no request.
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
    // Columns: name, upstream body, upstream status, guest code, value of
    // globalThis.out after the jobs drain.
    it.each<[string, string, number, string, unknown]>([
      [
        'should support .then() on response for text extraction',
        'Hello',
        200,
        `fetch('https://example.com').then(function(r) { globalThis.out = r.text(); });`,
        'Hello',
      ],
      [
        'should support chained .then() calls',
        'chained',
        200,
        `fetch('https://example.com')
          .then(function(r) { return r.text(); })
          .then(function(t) { return 'got: ' + t; })
          .then(function(v) { globalThis.out = v; });`,
        'got: chained',
      ],
      [
        'fetch(url).then(r => r.json()).then(...) runs as a promise chain',
        '{"n":7}',
        200,
        `fetch('https://example.com/')
          .then(function (r) { return r.json(); })
          .then(function (d) { globalThis.out = d.n * 2; });`,
        14,
      ],
      [
        'should support .then() with status check',
        'ok',
        201,
        `fetch('https://example.com').then(function(r) { globalThis.out = r.status; });`,
        201,
      ],
      [
        'await fetch(url) settles to a response, and await r.json() gives the data',
        '{"a":1}',
        200,
        `(async function () {
          var r = await fetch('https://example.com/');
          var d = await r.json();
          globalThis.out = [r.status, r.ok, d.a];
        })();`,
        [200, true, 1],
      ],
      [
        'await fetch(url) then await r.text() gives the body',
        'hello',
        200,
        `(async function () {
          var r = await fetch('https://example.com/');
          globalThis.out = await r.text();
        })();`,
        'hello',
      ],
      [
        'the response thenable settles to a value that is not a thenable',
        'x',
        202,
        `Promise.resolve(fetch('https://example.com/')).then(function (r) {
          globalThis.out = [typeof r.then, r.status];
        });`,
        ['undefined', 202],
      ],
      [
        '.catch() on the response chain gets an error thrown in a callback',
        'not json',
        200,
        `fetch('https://example.com/')
          .then(function (r) { return r.json(); })
          .catch(function (e) { globalThis.out = e instanceof SyntaxError; });`,
        true,
      ],
      [
        '.catch() and .finally() on the response pass the response through',
        'pass',
        203,
        `var a = fetch('https://example.com/').catch(function () { return 'caught'; });
        var b = fetch('https://example.com/').finally(function () { globalThis.fin = true; });
        Promise.all([a, b]).then(function (rs) {
          globalThis.out = [rs[0].status, rs[1].status, rs[1].text(), globalThis.fin];
        });`,
        [203, 203, 'pass', true],
      ],
    ])(
      '%s',
      async (_name, body, status, code, expected) => {
        globalThis.fetch = vi.fn().mockImplementation(async () => new Response(body, { status }));
        injectCap(vm, new FetchCapability(makeStubProxyAuth()));
        expect(await evalAndDrain(code)).toEqual(expected);
      },
      10_000,
    );
  });

  // ---------------------------------------------------------------
  // Response size limit and cancel of requests in flight.
  // ---------------------------------------------------------------

  describe('maxResponseBytes and the run signal', () => {
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
      globalThis.fetch = vi.fn().mockImplementation(
        async () =>
          new Response(streamOf(Array.from({ length: 11 }, () => 'y'.repeat(mib))), {
            status: 200,
          }),
      );
      const cap = new FetchCapability(makeStubProxyAuth());
      await expect(cap.invokeHost('fetch', ['https://example.com/'])).rejects.toThrow(
        /maxResponseBytes/,
      );

      globalThis.fetch = vi.fn().mockImplementation(
        async () =>
          new Response(streamOf(Array.from({ length: 10 }, () => 'y'.repeat(mib))), {
            status: 200,
          }),
      );
      const raw = await cap.invokeHost('fetch', ['https://example.com/']);
      expect(JSON.parse(String(raw)).body.length).toBe(10 * mib);
    }, 30_000);

    it('the guest sees the size error as a fetch failure', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(new Response('z'.repeat(50), { status: 200 }));
      injectCap(vm, new FetchCapability(makeStubProxyAuth(), { maxResponseBytes: 10 }));
      const msg = String(await guestTry(`fetch('https://example.com/'); 'no error';`));
      expect(msg).toContain('fetch failed');
      expect(msg).toContain('maxResponseBytes');
    });

    it.each([[0], [-1], [1.5], [NaN], [Infinity], ['100'], [null]])(
      'an invalid maxResponseBytes (%o) throws a TypeError at construction',
      (bad) => {
        expect(
          () =>
            new FetchCapability(makeStubProxyAuth(), {
              maxResponseBytes: bad as unknown as number,
            }),
        ).toThrow(new TypeError('FetchCapability maxResponseBytes must be a positive integer.'));
      },
    );

    it.each([
      ['https://user:secret@proxy.example'],
      ['https://user@proxy.example/base'],
      ['https://:secret@proxy.example'],
      ['//user:secret@proxy.example'],
    ])(
      'a corsProxyUrl with a user name or a password (%s) throws a TypeError at construction',
      (base) => {
        const make = () => new FetchCapability(makeStubProxyAuth({ proxyBase: () => base }));
        expect(make).toThrow(
          new TypeError('FetchCapability corsProxyUrl must not contain a user name or a password.'),
        );
      },
    );

    it.each([['https://u:p@ho st'], ['https://ho st'], ['http://[::1']])(
      'a corsProxyUrl that does not parse (%s) throws a TypeError without the URL',
      (base) => {
        const make = () => new FetchCapability(makeStubProxyAuth({ proxyBase: () => base }));
        expect(make).toThrow(new TypeError('FetchCapability corsProxyUrl must be a valid URL.'));
      },
    );

    describe('a proxyBase that changes after construction', () => {
      const makeChanging = (later: unknown) => {
        let base: unknown = 'https://proxy.example.com';
        const authHeader = vi.fn(() => `Bearer ${TOKEN}`);
        const cap = new FetchCapability(
          makeStubProxyAuth({ proxyBase: () => base as string | null, authHeader }),
        );
        base = later;
        return { cap, authHeader };
      };

      it.each([
        ['https://u:p@ho st', 'Proxy fetch failed: the CORS proxy URL is not a valid URL.'],
        [42, 'Proxy fetch failed: the CORS proxy URL is not a valid URL.'],
        [
          'https://user:secret@proxy.example.com',
          'Proxy fetch failed: the CORS proxy URL must not contain a user name or a password.',
        ],
      ])('a proxy call to %o is refused before the token is read', async (later, text) => {
        const spy = vi.fn().mockResolvedValue(mockOkResponse('ok'));
        globalThis.fetch = spy;
        const { cap, authHeader } = makeChanging(later);
        const err = await cap.invokeHost('fetch', ['https://api.example.com/data']).catch((e) => e);
        expect(err).toBeInstanceOf(Error);
        expect((err as Error).message).toBe(`fetch failed: ${text}`);
        expect((err as Error).message).not.toContain('secret');
        expect(spy).not.toHaveBeenCalled();
        expect(authHeader).not.toHaveBeenCalled();
      });

      it('a proxyBase() that throws gives a fixed error', async () => {
        const spy = vi.fn().mockResolvedValue(mockOkResponse('ok'));
        globalThis.fetch = spy;
        const cap = new FetchCapability(makeStubProxyAuth({ proxyBase: () => null }));
        let calls = 0;
        (cap as unknown as { proxyAuth: { proxyBase: () => string } }).proxyAuth.proxyBase = () => {
          calls++;
          throw new Error('https://user:secret@proxy.example.com');
        };
        await expect(cap.invokeHost('fetch', ['https://api.example.com/data'])).rejects.toThrow(
          new Error('fetch failed: Proxy fetch failed: the CORS proxy URL is not a valid URL.'),
        );
        expect(calls).toBe(1);
        expect(spy).not.toHaveBeenCalled();
      });
    });

    it.each([
      ['the proxy URL', () => 'request to https://proxy.example.com/proxy/fetch failed'],
      ['the token', () => `bad header Bearer ${TOKEN}`],
      ['the bare token', () => `bad value ${TOKEN}`],
    ])('a host fetch error that shows %s becomes a fixed error', async (_label, text) => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError(text()));
      const cap = new FetchCapability(
        makeStubProxyAuth({
          proxyBase: () => 'https://proxy.example.com',
          authHeader: () => `Bearer ${TOKEN}`,
        }),
      );
      await expect(cap.invokeHost('fetch', ['https://api.example.com/data'])).rejects.toThrow(
        new Error('fetch failed: Proxy fetch failed: the request to the CORS proxy failed.'),
      );
    });

    it('a host fetch error without the proxy URL or the token passes unchanged', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
      const cap = new FetchCapability(
        makeStubProxyAuth({
          proxyBase: () => 'https://proxy.example.com',
          authHeader: () => `Bearer ${TOKEN}`,
        }),
      );
      await expect(cap.invokeHost('fetch', ['https://api.example.com/data'])).rejects.toThrow(
        new Error('fetch failed: Failed to fetch'),
      );
    });

    it.each([[null], [''], ['/api'], ['https://proxy.example/'], ['https://proxy.example/a@b']])(
      'a corsProxyUrl without credentials (%o) is accepted',
      (base) => {
        expect(
          () => new FetchCapability(makeStubProxyAuth({ proxyBase: () => base })),
        ).not.toThrow();
      },
    );

    it('a maxResponseBytes of 1 is accepted', () => {
      expect(() => new FetchCapability(makeStubProxyAuth(), { maxResponseBytes: 1 })).not.toThrow();
    });

    it('the run signal aborts every request of the run in flight (direct and proxy)', async () => {
      const signals: AbortSignal[] = [];
      globalThis.fetch = vi.fn().mockImplementation(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            const signal = init.signal!;
            signals.push(signal);
            signal.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
          }),
      );
      const direct = new FetchCapability(makeStubProxyAuth());
      const proxied = new FetchCapability(proxyAuthWithToken());
      const run = new AbortController();
      const context = { signal: run.signal };

      const calls = [
        direct.invokeHost('fetch', ['https://a.example/'], context),
        direct.invokeHost('fetch', ['https://b.example/'], context),
        proxied.invokeHost('fetch', ['https://c.example/'], context),
      ];
      await vi.waitFor(() => expect(signals).toHaveLength(3));
      expect(signals.some((s) => s.aborted)).toBe(false);

      run.abort();

      expect(signals.every((s) => s.aborted)).toBe(true);
      for (const call of calls) await expect(call).rejects.toThrow(/fetch failed/);
    });

    it('the run signal also stops a body read that is in progress', async () => {
      // The body never ends, and it ignores the signal. Only a cancel of
      // the reader can stop the read.
      let cancelled = false;
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('part'));
        },
        // The stream calls pull when the reader takes the first chunk.
        // This pull does not add a chunk, so the next read waits.
        pull() {
          pulls++;
        },
        cancel() {
          cancelled = true;
        },
      });
      globalThis.fetch = vi.fn().mockResolvedValue(new Response(body, { status: 200 }));
      const cap = new FetchCapability(makeStubProxyAuth());
      const run = new AbortController();
      const call = cap.invokeHost('fetch', ['https://example.com/'], { signal: run.signal });
      // Wait until the host reads the body. Then the read is in progress.
      await vi.waitFor(() => expect(pulls).toBeGreaterThan(0));
      run.abort();
      await expect(call).rejects.toThrow(/fetch failed/);
      expect(cancelled).toBe(true);
    }, 10_000);

    it('the run signal before the response arrives cancels the body of a fetch that ignores the signal', async () => {
      // The fetch function ignores the signal, and the body never ends.
      // Without a check of the signal before the read, the read waits
      // forever.
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true;
        },
      });
      let respond!: (r: Response) => void;
      globalThis.fetch = vi.fn(() => new Promise<Response>((r) => (respond = r)));
      const cap = new FetchCapability(makeStubProxyAuth());
      const run = new AbortController();
      const call = cap.invokeHost('fetch', ['https://example.com/'], { signal: run.signal });
      await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalled());
      run.abort();
      respond(new Response(body, { status: 200 }));
      await expect(call).rejects.toThrow('fetch failed: the request was aborted.');
      expect(cancelled).toBe(true);
    }, 10_000);

    it('the end of one run does not abort the requests of another run on the same capability', async () => {
      const byUrl = new Map<string, AbortSignal>();
      let finish!: () => void;
      globalThis.fetch = vi.fn().mockImplementation(
        (url: string, init: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            byUrl.set(url, init.signal!);
            init.signal!.addEventListener('abort', () =>
              reject(new DOMException('aborted', 'AbortError')),
            );
            if (url.includes('b.example'))
              finish = () => resolve(new Response('b', { status: 200 }));
          }),
      );
      // One capability object, registered in two runtimes.
      const cap = new FetchCapability(makeStubProxyAuth());
      const runA = new AbortController();
      const runB = new AbortController();
      const callA = cap.invokeHost('fetch', ['https://a.example/'], { signal: runA.signal });
      const callB = cap.invokeHost('fetch', ['https://b.example/'], { signal: runB.signal });
      await vi.waitFor(() => expect(byUrl.size).toBe(2));

      runA.abort();
      await expect(callA).rejects.toThrow(/fetch failed/);
      expect(byUrl.get('https://b.example/')!.aborted).toBe(false);
      finish();
      expect(JSON.parse(String(await callB)).body).toBe('b');
    });

    it('a request whose run signal already aborted does not start a read', async () => {
      globalThis.fetch = vi
        .fn()
        .mockImplementation((_url: string, init: RequestInit) =>
          init.signal!.aborted
            ? Promise.reject(new DOMException('aborted', 'AbortError'))
            : Promise.resolve(new Response('x', { status: 200 })),
        );
      const cap = new FetchCapability(makeStubProxyAuth());
      const run = new AbortController();
      run.abort();
      await expect(
        cap.invokeHost('fetch', ['https://example.com/'], { signal: run.signal }),
      ).rejects.toThrow(/fetch failed/);
    });
  });

  // ---------------------------------------------------------------
  // Proxy URL join and URL resolution.
  // ---------------------------------------------------------------

  describe('proxy URL and URL resolution', () => {
    const origin = window.location.origin;

    // The token goes only to the host of the proxy base. A relative base
    // resolves against the page.
    it.each([
      ['', `${origin}/proxy/fetch`],
      ['/', `${origin}/proxy/fetch`],
      ['//', `${origin}/proxy/fetch`],
      ['/sub/', `${origin}/sub/proxy/fetch`],
      ['https://proxy.example.com', 'https://proxy.example.com/proxy/fetch'],
      ['https://proxy.example.com/', 'https://proxy.example.com/proxy/fetch'],
      ['https://proxy.example.com//', 'https://proxy.example.com/proxy/fetch'],
      ['https://proxy.example.com/base/', 'https://proxy.example.com/base/proxy/fetch'],
      ['https://proxy.example.com:8443//', 'https://proxy.example.com:8443/proxy/fetch'],
    ])(
      'the proxy URL for base %j is joined with one slash (%s) and only it gets the token',
      async (base, expected) => {
        const spy = vi.fn().mockResolvedValue(mockOkResponse('ok'));
        globalThis.fetch = spy;
        const cap = new FetchCapability(
          makeStubProxyAuth({ proxyBase: () => base, authHeader: () => `Bearer ${TOKEN}` }),
        );
        await cap.invokeHost('fetch', ['https://api.example.com/data']);

        expect(spy).toHaveBeenCalledTimes(1);
        const [target, init] = spy.mock.calls[0];
        expect(target).toBe(expected);
        expect(init.headers['X-Proxy-Authorization']).toBe(`Bearer ${TOKEN}`);
      },
    );

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
      const authHeader = vi.fn(() => `Bearer ${TOKEN}`);
      const cap = new FetchCapability(
        makeStubProxyAuth({ proxyBase: () => 'https://proxy.example.com', authHeader }),
      );
      await cap.invokeHost('fetch', ['/api/local']);
      expect(spy.mock.calls[0][0]).toBe(`${window.location.origin}/api/local`);
      expect(authHeader).not.toHaveBeenCalled();
    });
  });
}, 30000);
