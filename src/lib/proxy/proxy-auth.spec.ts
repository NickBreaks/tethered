import { beforeEach, describe, expect, it } from 'vitest';

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

  describe('proxyBase() tri-state (A-01..A-03)', () => {
    it('A-01: returns empty string when corsProxyUrl is empty (dev default)', () => {
      const svc = configureWithProxy('');
      expect(svc.proxyBase()).toBe('');
    });

    it('A-02: returns null when corsProxyUrl is null (proxy disabled)', () => {
      const svc = configureWithProxy(null);
      expect(svc.proxyBase()).toBeNull();
    });

    it('A-03: returns the absolute URL when corsProxyUrl is an absolute URL', () => {
      const svc = configureWithProxy('https://proxy.example.com');
      expect(svc.proxyBase()).toBe('https://proxy.example.com');
    });
  });

  describe('authHeader() fresh-read invariant (A-04..A-06)', () => {
    it('returns null when sessionStorage is empty', () => {
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

  describe('setToken() trimming (A-07)', () => {
    it("stores 'abc' for input '  abc  '", () => {
      service.setToken('  abc  ');
      expect(sessionStorage.getItem('cors_proxy_auth_token')).toBe('abc');
      expect(service.authHeader()).toBe('Bearer abc');
    });
  });

  describe('clearToken() and invalidate() (A-08..A-10)', () => {
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

    it('tokenInvalid is exposed as a ReadableValue', () => {
      expect(typeof service.tokenInvalid.get).toBe('function');
      expect('set' in service.tokenInvalid).toBe(false);
      expect(service.tokenInvalid.get()).toBe(false);
    });
  });
});
