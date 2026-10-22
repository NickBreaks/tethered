import type { SandboxCapability, CapabilityStubInfo } from './capability.js';
import type { ProxyAuthLike } from '../proxy/proxy-auth.js';

/**
 * Host policy for {@link FetchCapability}. Entries are hostnames
 * (`example.com`) or a `*.` wildcard (`*.example.com`), which matches
 * every subdomain of `example.com` but not `example.com` itself (list
 * both to allow both). A wildcard needs at least two labels (`*.com` is
 * refused) and cannot cover an IP address. No scheme, port, path or
 * userinfo, and no empty labels (`.example.com`, `a..b`). Entries are
 * lowercased, trimmed and stripped of one trailing dot; an invalid entry,
 * a non-string entry or a list that is not an array throws a `TypeError`
 * at construction.
 *
 * Either list makes fetch http(s)-only, but an allowed host is reachable
 * on any port and over plain `http`. `denyHosts` is not a security
 * boundary (an IP literal or a CNAME reaches the same server under
 * another name): use `allowHosts` to confine the guest.
 */
export interface FetchCapabilityOptions {
  /**
   * When set, only these hosts may be fetched (an empty list allows
   * nothing). Relative and same-origin URLs are checked against the
   * page's hostname.
   */
  readonly allowHosts?: readonly string[];
  /** These hosts are always refused, even when they match `allowHosts`. */
  readonly denyHosts?: readonly string[];
}

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
 * Routing decision (Flow C):
 *   1. If proxyAuth.proxyBase() is null -> proxy disabled; call
 *      globalThis.fetch directly (AC #49 direct-fetch fallback).
 *   2. If the request URL resolves to the same origin as the current
 *      page, call globalThis.fetch directly regardless of proxyBase.
 *   3. Otherwise read proxyAuth.authHeader() and POST the request to
 *      `${base}/proxy/fetch` with the destination URL/method/headers/body
 *      in the JSON body. A missing token invalidates the service and
 *      throws the locked Spec Mod #5 error string so the modal opens.
 *   4. A 401 response from the proxy invalidates the token and throws
 *      a "CORS proxy rejected the token" error.
 *
 * Host policy: with `allowHosts` and/or `denyHosts`, every request URL
 * is parsed with the WHATWG URL parser (relative URLs against the page)
 * and checked BEFORE any routing above, so a refused URL never reaches
 * globalThis.fetch, the proxy or the auth header. Only http(s) URLs pass;
 * the hostname is compared exactly (never by substring); deny wins.
 * The lists are copied at construction and never reach the guest. With
 * neither option the URL is not inspected at all.
 *
 * Token-isolation invariant: the auth header is read INSIDE invokeHost on
 * the main thread. It never crosses the worker boundary, is never turned
 * into a VM value, and is never concatenated into an error message. The
 * exfiltration specs in fetch-capability.spec.ts regression-test this.
 *
 * The worker injects the raw bridge as the global `fetch`; setupScript
 * then wraps it into a thenable response object so .then() chaining,
 * sync access (resp.text()), and await all work as agents/LLMs expect.
 */
export class FetchCapability implements SandboxCapability {
  readonly name = 'fetch';
  readonly description = 'HTTP requests via the Fetch API (routed through CORS proxy)';
  readonly stubInfo: CapabilityStubInfo = { name: 'fetch', type: 'function' };

  readonly setupScript = `(function() {
    var rawFetch = globalThis.fetch;

    function __wrapThenable(v) {
      if (v && typeof v === 'object' && typeof v.then === 'function') return v;
      return {
        _v: v,
        then: function(f, r) {
          try { return __wrapThenable(f(this._v)); }
          catch (e) { if (r) return __wrapThenable(r(e)); throw e; }
        }
      };
    }

    globalThis.fetch = function fetch(url, options) {
      var raw = rawFetch(url, options || {});
      var d = JSON.parse(raw);
      var resp = {
        status: d.status,
        ok: d.ok,
        statusText: d.statusText,
        text: function() { return d.body; },
        json: function() { return JSON.parse(d.body); },
        then: function(f, r) {
          try { return __wrapThenable(f(resp)); }
          catch (e) { if (r) return __wrapThenable(r(e)); throw e; }
        }
      };
      return resp;
    };
  })();`;

  readonly #allow: HostList | null;
  readonly #deny: HostList | null;

  constructor(
    private readonly proxyAuth: ProxyAuthLike,
    options: FetchCapabilityOptions = {},
  ) {
    if (options === null || typeof options !== 'object') {
      throw new TypeError('FetchCapability options must be an object.');
    }
    // Only an absent list means "no policy": anything else that is not an
    // array (null, a string) throws rather than silently failing open.
    const { allowHosts, denyHosts } = options;
    this.#allow = allowHosts !== undefined ? toHostList(allowHosts, 'allowHosts') : null;
    this.#deny = denyHosts !== undefined ? toHostList(denyHosts, 'denyHosts') : null;
  }

  async invokeHost(method: string, args: unknown[]): Promise<unknown> {
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

    try {
      const response = await this.doFetch(this.checkHost(url), options);
      const bodyText = await response.text();
      return JSON.stringify({
        status: response.status,
        ok: response.ok,
        statusText: response.statusText,
        body: bodyText,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`fetch failed: ${msg}`);
    }
  }

  /**
   * Throws unless the host policy (if any) admits `url`, and returns the
   * URL to request. Under a policy that is the parsed absolute URL, so the
   * request goes exactly where the check looked (a `<base>` element or a
   * proxy cannot resolve it differently); without one, `url` unchanged.
   * The message names only the guest-supplied hostname or scheme, never
   * anything the host holds (the proxy token is not read before this).
   */
  private checkHost(url: string): string {
    if (this.#allow === null && this.#deny === null) return url;

    let parsed: URL;
    try {
      parsed = new URL(url, globalThis.location?.href);
    } catch {
      throw new Error('URL is not allowed: it is not a valid absolute or page-relative URL.');
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`URL scheme "${parsed.protocol}" is not allowed: only http and https.`);
    }
    const host = stripTrailingDot(parsed.hostname);
    const denied = this.#deny !== null && matchesHost(this.#deny, host);
    const allowed = this.#allow === null || matchesHost(this.#allow, host);
    if (denied || !allowed) {
      throw new Error(`Host "${host}" is not allowed.`);
    }
    return parsed.href;
  }

  private async doFetch(url: string, options: RequestInit): Promise<Response> {
    const base = this.proxyAuth.proxyBase();

    // Case 1: proxy disabled -> direct fetch
    if (base === null) {
      return globalThis.fetch(url, options);
    }

    // Case 2: same-origin URL -> direct fetch regardless of base
    // (the spec's Flow C correction: same-origin bypass runs even
    // when proxyBase is set to an absolute cross-origin URL).
    let targetOrigin: string;
    try {
      targetOrigin = new URL(url, window.location.href).origin;
    } catch {
      targetOrigin = '';
    }
    if (targetOrigin === window.location.origin) {
      return globalThis.fetch(url, options);
    }

    // Case 3: cross-origin -> route through proxy
    const authHeader = this.proxyAuth.authHeader();
    if (authHeader === null) {
      this.proxyAuth.invalidate();
      throw new Error(
        'Proxy fetch failed: no authentication token. Use the token modal to enter your proxy key.',
      );
    }

    const proxyUrl = `${base}/proxy/fetch`;
    const proxyResponse = await globalThis.fetch(proxyUrl, {
      method: 'POST',
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

    if (proxyResponse.status === 401) {
      this.proxyAuth.invalidate();
      throw new Error('CORS proxy rejected the token. Re-enter a valid token.');
    }

    return proxyResponse;
  }
}

function stripTrailingDot(host: string): string {
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

function matchesHost(list: HostList, host: string): boolean {
  return list.exact.has(host) || list.suffixes.some((suffix) => host.endsWith(suffix));
}

/**
 * Copies and normalizes a host list. Each entry goes through the URL
 * parser so it is compared in the same form as `URL.hostname`
 * (lowercase, IDNA/punycode, canonical IPv4). A malformed entry throws
 * rather than being kept in a form that could never match (which, in
 * `denyHosts`, would deny nothing).
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
  // trailing dot, or dots only. Checked before and after the URL parser,
  // which maps other dot characters to `.`.
  if (hasEmptyLabel(name) || hasEmptyLabel(host)) return null;
  return host;
}

function hasEmptyLabel(host: string): boolean {
  return host === '' || (!host.startsWith('[') && host.split('.').includes(''));
}
