import type { SandboxCapability, CapabilityStubInfo, HostCallContext } from './capability.js';
import type { ProxyAuthLike } from '../proxy/proxy-auth.js';

/**
 * Host policy for {@link FetchCapability}. Entries are hostnames
 * (`example.com`) or a `*.` wildcard (`*.example.com`). A wildcard matches
 * every subdomain of `example.com` but not `example.com` itself. To allow
 * both, list both. A wildcard must have a minimum of two labels (`*.com`
 * is refused) and cannot cover an IP address. Entries must not have a
 * scheme, port, path, userinfo or empty labels (`.example.com`, `a..b`).
 * The constructor lowercases and trims each entry and removes one
 * trailing dot. It throws a `TypeError` for an invalid entry, a
 * non-string entry or a list that is not an array.
 *
 * Either list makes fetch http(s)-only. But an allowed host is reachable
 * on any port and over plain `http`. `denyHosts` is not a security
 * boundary, because an IP literal or a CNAME reaches the same server
 * under another name. Use `allowHosts` to confine the guest.
 */
export interface FetchCapabilityOptions {
  /**
   * When set, fetch can get only these hosts. An empty list allows no
   * host. Relative and same-origin URLs are checked against the hostname
   * of the page.
   */
  readonly allowHosts?: readonly string[];
  /** These hosts are always refused, even when they match `allowHosts`. */
  readonly denyHosts?: readonly string[];
  /**
   * The maximum size of a response body, in bytes. The host reads the
   * body on the main thread, outside the memory limit of the worker. If
   * the body is larger, the host stops the read and the guest `fetch`
   * fails. It must be a positive integer. The default is 10 MiB
   * (10485760).
   */
  readonly maxResponseBytes?: number;
}

/** The default of {@link FetchCapabilityOptions.maxResponseBytes}: 10 MiB. */
const DEFAULT_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/**
 * The response header with which the proxy marks its own token failure.
 * A destination can also answer 401, and the proxy gives that status to
 * the client. Thus the status alone does not identify a token failure.
 */
const PROXY_ERROR_HEADER = 'X-Proxy-Error';
const PROXY_ERROR_UNAUTHORIZED = 'unauthorized';

/** The error when the proxy URL is not valid. It does not show the URL. */
const PROXY_URL_INVALID_MSG = 'Proxy fetch failed: the CORS proxy URL is not a valid URL.';

/** The error when the host fetch error shows the proxy URL or the token. */
const PROXY_REQUEST_FAILED_MSG = 'Proxy fetch failed: the request to the CORS proxy failed.';

/** A normalized host list: exact hostnames plus `*.` wildcard suffixes. */
interface HostList {
  readonly exact: ReadonlySet<string>;
  /** Each entry is `.example.com` for `*.example.com`. */
  readonly suffixes: readonly string[];
}

/**
 * Fetch capability that routes cross-origin requests through the CORS
 * proxy when one is configured.
 *
 * URL resolution: the capability parses the guest URL one time with the
 * WHATWG URL parser. It resolves a relative URL against
 * `document.baseURI` when a document exists, else against
 * `location.href`. The routing decision and the request both use this
 * absolute URL.
 *
 * Routing decision:
 *   1. If proxyAuth.proxyBase() is null, the proxy is disabled. Call
 *      globalThis.fetch directly.
 *   2. If the URL has the same origin as the current page, call
 *      globalThis.fetch directly. Ignore proxyBase.
 *   3. Otherwise, read proxyAuth.authHeader(). Then POST the request to
 *      `/proxy/fetch` under the proxy base, with the destination
 *      URL/method/headers/body in the JSON body. If the token is missing,
 *      the capability invalidates the token and throws an error. The
 *      host app can show a token prompt when the token is invalid.
 *   4. A 401 response with `X-Proxy-Error: unauthorized` invalidates the
 *      token and throws a "CORS proxy rejected the token" error. A 401
 *      without this header comes from the destination. The guest gets it
 *      as a response, and the token stays.
 *   5. The proxy POST does not follow redirects. A redirect could send
 *      the `X-Proxy-Authorization` header to a different host.
 *
 * Host policy: with `allowHosts`, `denyHosts` or both, the capability
 * checks the resolved URL BEFORE the routing above. Thus a refused URL
 * never reaches globalThis.fetch, the proxy or the auth header. Only
 * http(s) URLs pass. The check compares the full hostname, never a
 * substring. If both lists match, deny wins. The constructor copies the
 * lists, and the lists never reach the guest. With neither option, the
 * capability does not limit the URL.
 *
 * Body and cancel: the host reads the response body as a stream and
 * counts the bytes. A body larger than `maxResponseBytes` fails the
 * request. Each request has an AbortController. The request aborts when
 * the signal of its host call aborts. The runner aborts this signal when
 * the run of the call ends, also when the run is aborted, times out or
 * is superseded. Thus the end of a run does not abort the requests of
 * other runs, also when two runners share one capability object.
 *
 * Token-isolation invariant: the auth header is read only INSIDE
 * invokeHost, on the main thread. It never crosses the worker boundary.
 * It never becomes a VM value, and it is never part of an error message.
 * The exfiltration specs in fetch-capability.spec.ts are regression tests
 * for this.
 *
 * Guest API: the worker injects the raw bridge as the global `fetch`.
 * Then setupScript wraps it. The guest call is synchronous and returns a
 * response object. Thus `fetch(u).text()` works. The response object is
 * also a thenable. Its `then`, `catch` and `finally` use a real Promise
 * that settles to a copy of the response without these three methods.
 * Thus `await fetch(u)` and `fetch(u).then(...)` settle and do not loop.
 */
export class FetchCapability implements SandboxCapability {
  readonly name = 'fetch';
  readonly description = 'HTTP requests via the Fetch API (routed through CORS proxy)';
  readonly stubInfo: CapabilityStubInfo = { name: 'fetch', type: 'function' };

  readonly setupScript = `(function() {
    var rawFetch = globalThis.fetch;
    var P = Promise;

    function makeResponse(d) {
      return {
        status: d.status,
        ok: d.ok,
        statusText: d.statusText,
        text: function() { return d.body; },
        json: function() { return JSON.parse(d.body); }
      };
    }

    globalThis.fetch = function fetch(url, options) {
      var d = JSON.parse(rawFetch(url, options || {}));
      // The settled value has no then. Thus a Promise that adopts the
      // response settles after one step.
      var settled = makeResponse(d);
      var resp = makeResponse(d);
      resp.then = function(onFulfilled, onRejected) {
        return P.resolve(settled).then(onFulfilled, onRejected);
      };
      resp.catch = function(onRejected) {
        return P.resolve(settled).catch(onRejected);
      };
      resp.finally = function(onFinally) {
        return P.resolve(settled).finally(onFinally);
      };
      return resp;
    };
  })();`;

  readonly #allow: HostList | null;
  readonly #deny: HostList | null;
  readonly #maxResponseBytes: number;

  constructor(
    private readonly proxyAuth: ProxyAuthLike,
    options: FetchCapabilityOptions = {},
  ) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('FetchCapability options must be an object.');
    }
    // Only an absent list means "no policy". Any other value that is not an
    // array (null, a string) throws. It does not silently fail open.
    const { allowHosts, denyHosts, maxResponseBytes } = options;
    this.#allow = allowHosts !== undefined ? toHostList(allowHosts, 'allowHosts') : null;
    this.#deny = denyHosts !== undefined ? toHostList(denyHosts, 'denyHosts') : null;
    if (
      maxResponseBytes !== undefined &&
      !(Number.isSafeInteger(maxResponseBytes) && maxResponseBytes > 0)
    ) {
      throw new TypeError('FetchCapability maxResponseBytes must be a positive integer.');
    }
    this.#maxResponseBytes = maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
    // The client sends the proxy URL in each request. Credentials in it
    // can go to logs and error messages. A URL that does not parse makes
    // each proxy call fail, and the parser error can show the URL. The
    // errors here do not show the URL.
    const base = proxyAuth.proxyBase();
    if (base !== null) {
      const endpoint = proxyEndpoint(base);
      if (endpoint === null) {
        throw new TypeError('FetchCapability corsProxyUrl must be a valid URL.');
      }
      if (hasUserInfo(endpoint)) {
        throw new TypeError('FetchCapability corsProxyUrl must not contain a user name or a password.');
      }
    }
  }

  /**
   * Does one guest request. When `context.signal` aborts, the request
   * aborts. The runner aborts it when the run of the call ends.
   */
  async invokeHost(method: string, args: unknown[], context?: HostCallContext): Promise<unknown> {
    if (method !== 'fetch') {
      throw new Error(`fetch.${method} is not implemented`);
    }
    const url = String(args[0]);
    let options: RequestInit = {};
    const opts = args[1];
    if (opts && typeof opts === 'object') {
      const o = opts as Record<string, unknown>;
      options = {
        method: o['method'] as string | undefined,
        headers: o['headers'] as Record<string, string> | undefined,
        body: o['body'] as string | undefined,
      };
    }

    const controller = new AbortController();
    const runSignal = context?.signal;
    const onRunEnd = () => controller.abort();
    if (runSignal?.aborted) onRunEnd();
    runSignal?.addEventListener('abort', onRunEnd);
    try {
      const response = await this.doFetch(this.checkHost(url), options, controller.signal);
      const bodyText = await this.readBody(response, controller.signal);
      return JSON.stringify({
        status: response.status,
        ok: response.ok,
        statusText: response.statusText,
        body: bodyText,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`fetch failed: ${msg}`);
    } finally {
      runSignal?.removeEventListener('abort', onRunEnd);
    }
  }

  /**
   * Reads the body as UTF-8 text and counts the bytes. If the count
   * becomes larger than `maxResponseBytes`, or if `signal` aborts, it
   * cancels the stream and throws.
   */
  private async readBody(response: Response, signal: AbortSignal): Promise<string> {
    const limit = this.#maxResponseBytes;
    const tooLarge = () =>
      new Error(`response body is larger than maxResponseBytes (${limit} bytes).`);
    const declared = Number(response.headers.get('content-length'));
    if (declared > limit) {
      void response.body?.cancel().catch(() => {});
      throw tooLarge();
    }
    if (!response.body) {
      const buf = await response.arrayBuffer();
      if (buf.byteLength > limit) throw tooLarge();
      return new TextDecoder().decode(buf);
    }

    const reader = response.body.getReader();
    // A body can ignore the signal of the request (for example, a stream
    // that the host made). Thus an abort also cancels the reader.
    const onAbort = () => void reader.cancel().catch(() => {});
    // The signal can abort before the body read starts, for example when
    // a fetch function of the host ignores it. The listener does not fire
    // for an abort in the past.
    if (signal.aborted) {
      onAbort();
      throw new Error('the request was aborted.');
    }
    signal.addEventListener('abort', onAbort);
    const decoder = new TextDecoder();
    let total = 0;
    let text = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (signal.aborted) throw new Error('the request was aborted.');
        if (done) break;
        total += value.byteLength;
        if (total > limit) {
          void reader.cancel().catch(() => {});
          throw tooLarge();
        }
        text += decoder.decode(value, { stream: true });
      }
      return text + decoder.decode();
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  }

  /**
   * Resolves `url` and throws unless the host policy (if any) admits it.
   * Returns the parsed absolute URL. The routing decision and the request
   * both use it, so the request goes to the location that the check
   * examined. The error message names only the hostname or scheme that
   * the guest supplied. It never names data that the host holds. The
   * proxy token is not read before this check.
   */
  private checkHost(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url, pageBaseUrl());
    } catch {
      throw new Error(
        this.#allow === null && this.#deny === null
          ? 'URL is not a valid absolute or page-relative URL.'
          : 'URL is not allowed: it is not a valid absolute or page-relative URL.',
      );
    }
    if (this.#allow === null && this.#deny === null) return parsed;
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`URL scheme "${parsed.protocol}" is not allowed: only http and https.`);
    }
    const host = stripTrailingDot(parsed.hostname);
    const denied = this.#deny !== null && matchesHost(this.#deny, host);
    const allowed = this.#allow === null || matchesHost(this.#allow, host);
    if (denied || !allowed) {
      throw new Error(`Host "${host}" is not allowed.`);
    }
    return parsed;
  }

  private async doFetch(target: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
    let base: string | null;
    try {
      base = this.proxyAuth.proxyBase();
    } catch {
      throw new Error(PROXY_URL_INVALID_MSG);
    }
    const url = target.href;
    const options: RequestInit = { ...init, signal };

    // Case 1: proxy disabled -> direct fetch
    if (base === null) {
      return globalThis.fetch(url, options);
    }

    // Case 2: same-origin URL -> direct fetch regardless of base. The
    // bypass also applies when proxyBase is an absolute cross-origin URL.
    // An opaque origin ("null") is never the same origin.
    const pageOrigin = globalThis.location?.origin;
    if (target.origin !== 'null' && target.origin === pageOrigin) {
      return globalThis.fetch(url, options);
    }

    // Case 3: cross-origin -> route through proxy. The constructor examined
    // the proxy URL, but a ProxyAuthLike can return a different URL on
    // each call. Thus examine it again before the token is read. The
    // errors do not show the URL.
    const endpoint = proxyEndpoint(base);
    if (endpoint === null) throw new Error(PROXY_URL_INVALID_MSG);
    if (hasUserInfo(endpoint)) {
      throw new Error('Proxy fetch failed: the CORS proxy URL must not contain a user name or a password.');
    }
    const authHeader = this.proxyAuth.authHeader();
    if (authHeader === null) {
      this.proxyAuth.invalidate();
      throw new Error(
        'Proxy fetch failed: no authentication token. Set the proxy token with ProxyAuth.setToken().',
      );
    }

    // Remove trailing slashes from the base. Else a base of '/' gives
    // '//proxy/fetch', a protocol-relative URL to the host "proxy", and
    // the token goes to that host. An empty base gives the same-origin
    // path '/proxy/fetch'. A relative base resolves against the page
    // location, not against a `<base>` element. Thus the token stays on
    // the origin of the page. proxyEndpoint() parsed this URL with the
    // same base, thus it parses.
    const proxyUrl = resolveAgainstPage(`${base.replace(/\/+$/, '')}/proxy/fetch`);
    const proxyResponse = await this.proxyFetch(proxyUrl, [proxyUrl, endpoint.href, authHeader], {
      signal,
      method: 'POST',
      // The browser keeps custom headers on a redirect, also to a different
      // origin. Thus a redirect fails the request and the token stays here.
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'X-Proxy-Authorization': authHeader,
      },
      body: JSON.stringify({
        url,
        method: (options.method as string | undefined) ?? 'GET',
        headers: (options.headers as Record<string, string> | undefined) ?? {},
        body: (options.body as string | null | undefined) ?? null,
      }),
    });

    if (
      proxyResponse.status === 401 &&
      proxyResponse.headers.get(PROXY_ERROR_HEADER) === PROXY_ERROR_UNAUTHORIZED
    ) {
      this.proxyAuth.invalidate();
      throw new Error('CORS proxy rejected the token. Re-enter a valid token.');
    }

    return proxyResponse;
  }

  /**
   * Calls `globalThis.fetch` for the proxy. An error message from the
   * host fetch can contain the proxy URL or the auth header. When the
   * message contains one of `secrets`, this method throws a fixed error
   * instead. Thus the guest never sees the proxy URL or the token.
   */
  private async proxyFetch(url: string, secrets: string[], init: RequestInit): Promise<Response> {
    try {
      return await globalThis.fetch(url, init);
    } catch (err) {
      let text: string;
      try {
        text = err instanceof Error ? String(err.message) : String(err);
      } catch {
        throw new Error(PROXY_REQUEST_FAILED_MSG);
      }
      const parts = secrets.flatMap((v) => [v, v.replace(/^Bearer\s+/, '')]);
      if (parts.some((v) => v !== '' && text.includes(v))) {
        throw new Error(PROXY_REQUEST_FAILED_MSG);
      }
      throw err;
    }
  }
}

/**
 * The base for a relative guest URL: `document.baseURI` when a document
 * exists (the page `fetch` uses it too), else `location.href`. It is
 * undefined where neither exists. Then only absolute URLs parse.
 */
function pageBaseUrl(): string | undefined {
  const doc = (globalThis as { document?: { baseURI?: unknown } }).document;
  if (doc && typeof doc.baseURI === 'string' && doc.baseURI !== '') return doc.baseURI;
  return globalThis.location?.href;
}

/** `url` made absolute against `location.href`, or unchanged where there is no location. */
function resolveAgainstPage(url: string): string {
  const href = globalThis.location?.href;
  return href === undefined ? url : new URL(url, href).href;
}

/**
 * The proxy endpoint for `base`: `/proxy/fetch` under `base`, with the
 * trailing slashes of `base` removed. A relative base resolves against
 * `location.href`, not against a `<base>` element. Where there is no
 * location, it resolves against `http://localhost/`. Returns null when
 * `base` is not a string or the result does not parse. This function
 * never throws.
 */
function proxyEndpoint(base: unknown): URL | null {
  if (typeof base !== 'string') return null;
  try {
    return new URL(
      `${base.replace(/\/+$/, '')}/proxy/fetch`,
      globalThis.location?.href ?? 'http://localhost/',
    );
  } catch {
    return null;
  }
}

/** True when `url` has a user name or a password. */
function hasUserInfo(url: URL): boolean {
  return url.username !== '' || url.password !== '';
}

function stripTrailingDot(host: string): string {
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

function matchesHost(list: HostList, host: string): boolean {
  return list.exact.has(host) || list.suffixes.some((suffix) => host.endsWith(suffix));
}

/**
 * Copies and normalizes a host list. Each entry goes through the URL
 * parser, so the comparison uses the same form as `URL.hostname`:
 * lowercase, IDNA/punycode, canonical IPv4. A malformed entry throws.
 * Otherwise the list keeps it in a form that can never match. In
 * `denyHosts`, such an entry denies nothing.
 */
function toHostList(entries: readonly string[], option: string): HostList {
  if (!Array.isArray(entries)) {
    throw new TypeError(`FetchCapability ${option} must be an array of host names.`);
  }
  const exact = new Set<string>();
  const suffixes: string[] = [];
  for (const entry of Array.from(entries as readonly unknown[])) {
    const invalid = () =>
      new TypeError(`FetchCapability ${option}: invalid host entry ${JSON.stringify(entry)}.`);
    if (typeof entry !== 'string') throw invalid();
    const raw = entry.trim().toLowerCase();
    const wildcard = raw.startsWith('*.');
    const name = stripTrailingDot(wildcard ? raw.slice(2) : raw);
    const host = parseHostname(name);
    if (host === null) throw invalid();
    if (wildcard) {
      // `*.` covers subdomains of a registrable name only: not a bare
      // label (`*.com`), and not an IP literal.
      if (!host.includes('.') || isIpLiteral(host)) throw invalid();
      suffixes.push(`.${host}`);
    } else {
      exact.add(host);
    }
  }
  return { exact, suffixes: Object.freeze(suffixes) };
}

function isIpLiteral(host: string): boolean {
  return host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host);
}

/** The canonical hostname for a bare host entry, or null if it is not one. */
function parseHostname(name: string): string | null {
  if (name === '' || /[\s/?#@*\\]/.test(name)) return null;
  // A colon is only valid inside a bracketed IPv6 literal (no port).
  if (name.startsWith('[') ? !name.endsWith(']') : name.includes(':')) return null;
  let url: URL;
  try {
    url = new URL(`http://${name}`);
  } catch {
    return null;
  }
  const host = stripTrailingDot(url.hostname);
  // No empty labels: a leading dot (`.evil.net`), `a..b`, a second
  // trailing dot, or dots only. The check runs before and after the URL
  // parser, because the parser changes other dot characters to `.`.
  if (hasEmptyLabel(name) || hasEmptyLabel(host)) return null;
  return host;
}

function hasEmptyLabel(host: string): boolean {
  return host === '' || (!host.startsWith('[') && host.split('.').includes(''));
}
