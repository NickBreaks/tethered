import { createValue } from '../shared/readable-value.js';

/** Visible ASCII only, so that the token is always a valid header value. */
const VALID_TOKEN = /^[\x21-\x7e]+$/;

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
 *  - A token has only visible ASCII characters (0x21–0x7E). `setToken()`
 *    refuses other tokens, and `authHeader()` ignores them. Thus a token
 *    is always a valid header value. Else `fetch()` can throw an error
 *    whose message contains the header value, and that message goes to
 *    the guest.
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
    if (token === null || token === '' || !VALID_TOKEN.test(token)) {
      return null;
    }
    return `Bearer ${token}`;
  }

  /** Throws a `TypeError` if the trimmed token has a character that is not visible ASCII. */
  setToken(token: string): void {
    const trimmed = token.trim();
    if (trimmed !== '' && !VALID_TOKEN.test(trimmed)) {
      throw new TypeError('Proxy token must contain only visible ASCII characters.');
    }
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
