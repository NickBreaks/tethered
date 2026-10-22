import { createValue } from '../shared/readable-value.js';

/** The slice of ProxyAuth that capabilities need (lets adapters pass a wrapper). */
export type ProxyAuthLike = Pick<ProxyAuth, 'proxyBase' | 'authHeader' | 'invalidate'>;

/**
 * Owns the CORS proxy bearer token.
 *
 * `corsProxyUrl` tri-state (preserved from the legacy
 * `environment.corsProxyUrl` field — see proxyBase tests A-01..A-03):
 *  - `''`   — dev default; same-origin `/proxy/fetch` via the dev-server proxy.
 *  - `null` — proxy disabled.
 *  - any absolute URL string — that URL is the proxy base.
 *
 * Invariants:
 *  - `authHeader()` reads sessionStorage on every call. There is no
 *    private `_cachedToken` field and no reactive value over the token -
 *    a stale cache would leak tokens between tabs or through browser
 *    storage listeners.
 *  - Only sessionStorage is ever referenced. localStorage is forbidden
 *    so the token never outlives the browser tab.
 *  - `proxyBase()` uses an explicit null/undefined check so the empty
 *    string (dev mode, same-origin `/proxy/fetch`) is NOT collapsed
 *    to null (Spec Mod #1).
 *  - `setToken()` trims whitespace before storing (Spec Mod #6 / U-01).
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
