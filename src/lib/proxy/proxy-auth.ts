import { createValue } from '../shared/readable-value.js';

/** The part of ProxyAuth that capabilities need. Adapters can use it to pass a wrapper. */
export type ProxyAuthLike = Pick<ProxyAuth, 'proxyBase' | 'authHeader' | 'invalidate'>;

/**
 * Owns the CORS proxy bearer token.
 *
 * `corsProxyUrl` has three states:
 *  - `''`   — dev default; same-origin `/proxy/fetch` through the dev-server proxy.
 *  - `null` — proxy disabled.
 *  - any absolute URL string — that URL is the proxy base. FetchCapability
 *    removes trailing slashes before it adds `/proxy/fetch`.
 *
 * Invariants:
 *  - `authHeader()` reads sessionStorage on every call. There is no
 *    private `_cachedToken` field and no reactive value over the token.
 *    A stale cache can leak tokens between tabs or through browser
 *    storage listeners.
 *  - Only sessionStorage is ever referenced. localStorage is forbidden
 *    so the token never outlives the browser tab.
 *  - `proxyBase()` uses an explicit null/undefined check. Thus the empty
 *    string (dev mode, same-origin `/proxy/fetch`) does NOT become null.
 *  - `setToken()` removes whitespace at the start and end of the token
 *    before it stores the token.
 */
export class ProxyAuth {
  private static readonly TOKEN_KEY = 'cors_proxy_auth_token';

  readonly #tokenInvalid = createValue(false);
  readonly tokenInvalid = this.#tokenInvalid.asReadonly();

  readonly #corsProxyUrl: string | null | undefined;

  constructor(corsProxyUrl: string | null | undefined) {
    this.#corsProxyUrl = corsProxyUrl;
  }

  proxyBase(): string | null {
    const value = this.#corsProxyUrl;
    return value === null || value === undefined ? null : value;
  }

  authHeader(): string | null {
    const token = sessionStorage.getItem(ProxyAuth.TOKEN_KEY);
    if (token === null || token === '') {
      return null;
    }
    return `Bearer ${token}`;
  }

  setToken(token: string): void {
    const trimmed = token.trim();
    sessionStorage.setItem(ProxyAuth.TOKEN_KEY, trimmed);
    this.#tokenInvalid.set(false);
  }

  clearToken(): void {
    sessionStorage.removeItem(ProxyAuth.TOKEN_KEY);
  }

  invalidate(): void {
    this.clearToken();
    this.#tokenInvalid.set(true);
  }

  dispose(): void {
    this.#tokenInvalid.clear();
  }
}
