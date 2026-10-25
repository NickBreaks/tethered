import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProxyAuth } from './proxy-auth.js';

const DEFAULT_PROXY = 'http://127.0.0.1:4000/proxy/';

function configureWithProxy(value: string | null): ProxyAuth {
  return new ProxyAuth(value);
}

describe('ProxyAuth', () => {
  let service: ProxyAuth;

  beforeEach(() => {
    sessionStorage.clear();
    service = configureWithProxy(DEFAULT_PROXY);
  });

  afterEach(() => {
    service.dispose();
    sessionStorage.clear();
  });

  describe('proxyBase() tri-state', () => {
    it.each<[string, string | null | undefined, string | null]>([
      ['returns empty string when corsProxyUrl is empty (dev default)', '', ''],
      ['returns null when corsProxyUrl is null (proxy disabled)', null, null],
      ['returns null when corsProxyUrl is undefined (proxy disabled)', undefined, null],
      [
        'returns the absolute URL when corsProxyUrl is an absolute URL',
        'https://proxy.example.com',
        'https://proxy.example.com',
      ],
    ])('%s', (_name, corsProxyUrl, expected) => {
      const svc = new ProxyAuth(corsProxyUrl);
      expect(svc.proxyBase()).toBe(expected);
    });
  });

  describe('authHeader() fresh-read invariant', () => {
    it.each<[string, () => void]>([
      ['sessionStorage is empty', () => {}],
      [
        'the stored token is an empty string',
        () => sessionStorage.setItem('cors_proxy_auth_token', ''),
      ],
      ['setToken got only whitespace', () => service.setToken('   ')],
    ])('returns null when %s', (_name, arrange) => {
      arrange();
      expect(service.authHeader()).toBeNull();
    });

    it("returns 'Bearer <token>' after setToken('x')", () => {
      service.setToken('x');
      expect(service.authHeader()).toBe('Bearer x');
    });

    it('reads sessionStorage fresh on every call (no caching)', () => {
      service.setToken('first');
      expect(service.authHeader()).toBe('Bearer first');

      // Change storage directly (do not use setToken). This proves that
      // the service reads again and does not use a cached value.
      sessionStorage.setItem('cors_proxy_auth_token', 'second');
      expect(service.authHeader()).toBe('Bearer second');
    });
  });

  describe('setToken() trimming', () => {
    it("stores 'abc' for input '  abc  '", () => {
      service.setToken('  abc  ');
      expect(sessionStorage.getItem('cors_proxy_auth_token')).toBe('abc');
      expect(service.authHeader()).toBe('Bearer abc');
    });
  });

  describe('setToken() validation', () => {
    it.each<[string, string]>([
      ['a line feed', 'ab\ncd'],
      ['a carriage return', 'ab\rcd'],
      ['a NUL', 'ab\u0000cd'],
      ['an inner space', 'ab cd'],
      ['a character that is not ASCII', 'abé'],
    ])('throws a TypeError and keeps the old token for a token with %s', (_name, token) => {
      service.setToken('old');
      expect(() => service.setToken(token)).toThrow(TypeError);
      expect(service.authHeader()).toBe('Bearer old');
    });

    it('the TypeError message does not contain the token', () => {
      expect(() => service.setToken('secret\nvalue')).toThrow(
        /^Proxy token must contain only visible ASCII characters\.$/,
      );
    });

    it('authHeader() returns null for an invalid token written directly to sessionStorage', () => {
      sessionStorage.setItem('cors_proxy_auth_token', 'ab\r\ncd');
      expect(service.authHeader()).toBeNull();
    });
  });

  describe('clearToken() and invalidate()', () => {
    it('clearToken removes the sessionStorage entry', () => {
      service.setToken('x');
      service.clearToken();
      expect(sessionStorage.getItem('cors_proxy_auth_token')).toBeNull();
    });

    it('invalidate clears the token AND flips tokenInvalid to true', () => {
      service.setToken('x');
      expect(service.tokenInvalid.get()).toBe(false);
      service.invalidate();
      expect(sessionStorage.getItem('cors_proxy_auth_token')).toBeNull();
      expect(service.tokenInvalid.get()).toBe(true);
    });

    it('setToken flips tokenInvalid back to false', () => {
      service.invalidate();
      expect(service.tokenInvalid.get()).toBe(true);
      service.setToken('new');
      expect(service.tokenInvalid.get()).toBe(false);
    });
  });

  describe('TOKEN_KEY and source invariants', () => {
    it("uses the exact TOKEN_KEY 'cors_proxy_auth_token'", () => {
      service.setToken('token-value');
      expect(sessionStorage.getItem('cors_proxy_auth_token')).toBe('token-value');
    });

    it('never uses localStorage', () => {
      // The trap records each access to localStorage.
      const touched: PropertyKey[] = [];
      vi.stubGlobal(
        'localStorage',
        new Proxy(
          {},
          {
            get: (_target, key) => {
              touched.push(key);
              return () => null;
            },
          },
        ),
      );
      try {
        service.setToken('x');
        expect(service.authHeader()).toBe('Bearer x');
        service.clearToken();
        service.invalidate();
        expect(touched).toEqual([]);
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('tokenInvalid is exposed as a ReadableValue', () => {
      expect(typeof service.tokenInvalid.get).toBe('function');
      expect('set' in service.tokenInvalid).toBe(false);
      expect(service.tokenInvalid.get()).toBe(false);
    });
  });
});
