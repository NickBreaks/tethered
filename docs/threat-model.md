# Threat model

What tethered defends against, what it does not, and what each built-in
capability exposes to guest code. "Guest" means the untrusted
JavaScript passed to `execute()`. "Host" means the page that embeds the
runtime: the main thread, its DOM, its storage and its credentials.

## Security claim

> **Claim.** Guest JavaScript run by the built-in JS runner, inside a real
> web `Worker`, cannot read or change host state and cannot cause side
> effects, except through the capabilities the host registered and enabled
> for that run. Each run is bounded by its time limit (`timeoutMs`) and a
> per-run memory limit. The claim covers the built-in JS runner only.

Everything below either supports that claim or sets its limits.

## In scope

**Guest isolation from the host.** The guest runs in a QuickJS engine
compiled to WebAssembly, inside a dedicated web worker:

- The guest sees only the engine's built-ins, a `console`, and the
  globals installed for enabled capabilities. It has no DOM, no
  `window`, none of the worker's own globals (its `fetch`,
  `importScripts`, `indexedDB`, `postMessage`) and no host objects. Values cross the engine boundary
  as copies.
- The host treats the worker as untrusted. `JsRunner` shape-checks every
  message the worker posts and drops anything that is not exactly a known
  message. Replies to host calls go only to the worker that asked, for the
  run that asked.
- `abort()`, a supersede and the timeout backstop terminate the worker
  and spawn a fresh one, so no run can outlive its limit or leak state
  into the next run's engine.

**Side effects only through registered capabilities.** A guest call to a
capability is relayed to the main thread as `(capability, method, args)`
and handled by that capability's `invokeHost()`. A call reaches
`invokeHost()` only if the capability is registered and enabled on the
host at the moment the call arrives, and only with a `method` the
capability declares in its `stubInfo` (its `globals` or its own name for a
function capability, its `methods` for an object); otherwise the guest
gets an error. `args` are still guest-chosen values for `invokeHost()` to
check.
Disabled capabilities are installed as throwing stubs. Secrets the host
holds (for example the proxy token) stay on the main thread and are never
copied into the worker or into an error message.

**Limits.**

- Time: the engine's interrupt handler stops guest code after `timeoutMs`
  (default 5000 ms per run). A main-thread backstop terminates the worker
  2 s after that if the engine cannot stop itself, including while the
  guest waits on a host call.
- Memory: each run gets a fresh engine runtime with a 256 MiB memory
  limit.
- Boot: a worker that does not become ready within `bootTimeoutMs`
  (default 30 s) is terminated.

## Out of scope

- **The in-process fallback.** `createJsWorkerFactory({ allowInProcess: true })`
  runs the engine on the calling thread for tests (jsdom, SSR). It has no
  worker isolation, `abort()` cannot interrupt a busy guest because they
  share the thread, and it is not covered by the claim. It is opt-in; the default factory refuses to use it.
- **Third-party runners and capabilities.** Any `CodeRunner` other than
  the built-in JS runner (anything you register through `runners`) and
  any `SandboxCapability` you write yourself. A custom
  capability's `invokeHost()` is host code: what it allows, the guest can
  do.
- **Browser and WebAssembly engine bugs.** A bug in QuickJS, the WASM
  runtime or the browser that lets guest code escape the engine is out of
  scope. Note what such an escape would reach: a same-origin worker, which
  has `fetch`, `indexedDB` and other worker globals. Deploying the page
  with a strict Content Security Policy and cross-origin isolation reduces
  that reach.
- **Denial of service beyond the time and memory limits.** Within its
  limits a guest can burn CPU, fill its heap, write large output, make
  many capability calls, and fill the browser's storage quota through the
  storage and disk capabilities. Hosts that run guests in a loop should
  rate-limit runs themselves.
- **What the host does with guest output.** Console entries, results and
  capability arguments are guest-controlled strings. Render them as text,
  never as HTML.
- **Network-level controls.** Firewalls, DNS, and the proxy server's own
  hardening (see [proxy protocol](proxy-protocol.md)).

## Built-in capabilities: attack surface

All four are off unless the host registers and enables them. Arguments
arrive as plain copied values; capabilities coerce them with `String()`
where they expect strings.

### fetch (`FetchCapability`)

The guest gets a `fetch(url, { method, headers, body })` that returns a
response with `status`, `ok`, `statusText`, `text()` and `json()`. The
whole response body is read on the host and copied to the guest.

Routing, in order:

1. **Host policy** (only if `allowHosts` or `denyHosts` is set). The URL
   is parsed with the WHATWG URL parser (relative URLs against the page),
   only `http:` and `https:` pass, and the hostname must match the lists:
   exact names, or `*.example.com` for subdomains only (not the apex). Deny
   wins, and an empty `allowHosts` allows nothing. Malformed entries throw
   a `TypeError` when the capability is constructed, so a list can't
   silently match nothing: a list that is not an array, a non-string
   entry, an empty label (`.evil.net`, `a..b`, `..`), a bare `*` or `*.`,
   and a wildcard over a single label or an IP address (`*.com`,
   `*.0.0.1`). Public-suffix wildcards with more than one label (such as
   `*.co.uk`) are not detected. A refused URL fails
   before any network call, with no proxy call and no token read. The
   admitted URL is sent in its parsed absolute form, so the request goes
   where the check looked.
2. **Proxy disabled** (no proxy URL): the page's own `fetch`, direct.
3. **Same-origin URL**: the page's own `fetch`, direct, even when a proxy
   is configured.
4. **Otherwise**: a `POST` to the proxy, with the token in a header (see
   [proxy protocol](proxy-protocol.md)).

What the guest can do with it:

- **Same-origin requests carry the user's credentials.** A direct
  same-origin `fetch` sends the page's cookies, and the guest can read the
  response. A guest can therefore call the host app's own APIs as the
  user. If the host has same-origin endpoints that guests must not reach,
  use an `allowHosts` list that omits the page's hostname (`denyHosts`
  alone is not enough, see below).
- **Direct cross-origin requests** (proxy disabled) are subject to the
  browser's CORS rules for reading the response, but the request itself is
  still sent. A guest can send simple requests to any host the browser can
  reach, including hosts on the user's local network, unless the host
  policy limits it.
- **Proxied requests** are sent by the proxy server, from its network. The
  proxy is responsible for refusing private and internal destinations.
- **The token** is read on the main thread only when a request is routed
  to the proxy. It is never copied into the worker, never returned to the
  guest, and never part of an error message. A `401` from the proxy clears
  it.
- The guest chooses the method, headers and body. Forbidden browser
  headers are dropped by the browser in direct mode; the proxy decides
  which headers it forwards.

Limitations of the host policy:

- **An allowed host is reachable on any port and over plain `http`.**
  The policy matches the hostname only. `allowHosts: ['example.com']`
  admits `http://example.com:8080/` as well as `https://example.com/`,
  so every service that host exposes is in reach.
- **`denyHosts` is not a security boundary.** It compares hostnames, not
  destinations: the same server is reachable under an IP literal
  (`http://203.0.113.7/`, or another spelling of it), a CNAME or any
  other name that resolves to it, and none of those match the deny
  entry. Use `denyHosts` to carve exceptions out of an `allowHosts` list.
  To confine the guest, `allowHosts` is the recommended control.

- **Redirects are not re-checked.** In direct mode the browser follows
  redirects, and a proxy may follow them too. An open redirect on an
  allowed host can therefore lead to a host that is not allowed. Proxies
  SHOULD apply their own policy to every hop.
- **It matches hostnames, not addresses.** An allowed hostname that
  resolves to a private address is not blocked by the policy.
- **The proxy may parse URLs differently.** Sending the parsed absolute
  URL narrows this, but a proxy should still enforce its own policy.

### storage (`StorageCapability`)

`storage.getItem(key)`, `setItem(key, value)` and `removeItem(key)`. With
the default `LocalStorageBackend`, keys live in the page's `localStorage`
under the prefix `__sandbox_storage__:`. Values must be strings.

- The guest can read, overwrite and delete any key under that prefix,
  including keys written by earlier runs and other guests. Data persists
  across runs and sessions.
- The guest cannot reach keys outside the prefix.
- Host code that reads these keys must treat their values as untrusted.
- Writes count against the origin's `localStorage` quota. Pass your own
  backend (any object with `getItem`, `setItem` and `removeItem`) to
  `new StorageCapability(backend)` to scope or limit storage.

### disk (`DiskCapability`)

`disk.writeFile(path, content)`, `readFile(path)` and `listFiles(dir)`
over a virtual file system. With the default `IndexedDBDiskBackend`, files
are records in the `__sandbox_disk__` IndexedDB database.

- Paths are normalized strings used as record keys. There is no real file
  system behind them, so `..` and similar paths cannot leave the store.
- The guest can read, overwrite and list every file in the store,
  including files from earlier runs and other guests. Data persists across
  runs and sessions.
- The host can reach the same files through `getBackend()`; treat their
  contents as untrusted.
- Writes count against the origin's storage quota. Pass a `MapDiskBackend`
  or your own `DiskBackend` to scope or limit it.

### timer (`TimerCapability`)

Enables `setTimeout`, `setInterval`, `clearTimeout` and `clearInterval`.
The timers run inside the worker on virtual time and are drained before
the run settles, so they cannot fire after the run ends. They make no host
calls. The only exposure is CPU time, which the run's time limit bounds.

## Reporting a vulnerability

Please report security issues privately, not in a public issue. Use the
repository's private vulnerability reporting ("Report a vulnerability"
under the Security tab). Include:

- the package version and browser;
- a minimal guest script and host setup that reproduce the issue;
- what the guest gained (host state read or changed, a side effect without
  a capability, the token, a limit bypassed).

The maintainer will acknowledge the report and coordinate the fix and its
disclosure with you. Issues that fall under "Out of scope" above are
welcome as regular bug reports. [SECURITY.md](../SECURITY.md) lists the
supported versions.
