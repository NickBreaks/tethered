# Threat model

This page tells what tethered defends against, and what it does not
defend against. It also tells what each built-in capability makes
available to guest code. "Guest" is the untrusted JavaScript that you
give to `execute()`. "Host" is the page that contains the runtime: the
main thread, its DOM, its storage and its credentials.

## Security claim

> **Claim.** Guest JavaScript run by the built-in JS runner, inside a real
> web `Worker`, cannot read or change host state and cannot cause side
> effects, except through the capabilities the host registered and enabled
> for that run. Each run is bounded by its time limit (`timeoutMs`, with a
> 2 s backstop) and a per-run memory limit. The claim covers the built-in
> JS runner only.

All of the subsequent text supports that claim or sets its limits.

## In scope

**Isolation of the guest from the host.** The guest runs in a QuickJS
engine compiled to WebAssembly, inside a dedicated web worker:

- The guest sees only these globals:
  - the built-ins of the engine;
  - a `console` with `log`, `warn` and `error`;
  - the globals of capabilities that are enabled when the run starts;
  - stubs that throw, for capabilities that are registered but disabled
    when the run starts.

  It has no DOM and no `window`. It has none of the globals of the worker
  (its `fetch`, `importScripts`, `indexedDB`, `postMessage`), and no host
  objects. Values cross the engine boundary as copies.
- The host does not trust the worker. `JsRunner` checks the shape of each
  message that the worker posts. It accepts only a known message type
  with fields of the correct types. It rebuilds the top level of the
  message from these fields and drops all other properties. It does not
  examine the contents of `args`. It ignores all other messages. A
  malformed host call with a usable `callId` and `runId` from the active
  run gets an error reply, so that the guest does not wait until the
  timeout. The host sends replies to host calls only to the worker that
  asked, for the run that asked.
- Each run gets a fresh engine runtime and context. Thus the objects and
  globals of one run are not available to the next run. All runs on one
  worker share the WASM heap of that worker. A run can fill or fragment
  that heap, and then the next run can fail (refer to the memory limit
  below).
- `abort()`, a supersede and the timeout backstop terminate the worker
  and start a fresh one. Thus guest code cannot continue after them.
  But a host call that started on the main thread can complete after the
  run ends. `FetchCapability` aborts its requests when the run ends. The
  disk capability and custom capabilities do not stop their work. Thus a
  disk write or the work of a custom capability can occur after the run
  ends. A storage backend is synchronous, so a storage write occurs when
  the host gets the call. The host drops calls that arrive after the run
  ends.

**Side effects only through registered capabilities.** The worker sends
a guest call to a capability to the main thread as
`(capability, method, args)`. The `invokeHost()` of that capability
processes the call. A call goes to `invokeHost()` only if these
conditions are true:

- The call comes from the active run. The host drops a call from a run
  that ended, and does not reply.
- The capability was enabled when the run started. The host keeps the
  list of these capabilities for each run, and checks each call against
  it. A forged message (refer to "Out of scope") cannot go around this
  check.
- The same capability object is registered and enabled on the host when
  the call arrives, and it has an `invokeHost()`. Thus a capability that
  the host enables or replaces during a run is available from the next
  run.
- The capability declares the `method` in its `stubInfo`. For a function
  capability, this is its `stubInfo.globals`, else `stubInfo.name`. For an
  object, this is its `methods`.

If not, the guest gets an error. The guest chooses the `args` values, and
`invokeHost()` must check them.
A capability that is registered but disabled when the run starts is
installed as a stub that throws. An unregistered capability installs
nothing. The built-in capabilities keep their secrets (for example, the
proxy token) on the main thread. They never copy them into the worker or
into an error message. The host sends the message of an error from
`invokeHost()` to the guest without changes. Thus a custom capability
must not put secrets in its errors.

**Limits.**

- Time: the interrupt handler of the engine stops guest code after
  `timeoutMs` (default 5000 ms for each run). If the engine cannot stop
  itself, a backstop on the main thread terminates the worker. The
  backstop starts when the host posts the run, and it expires after
  `timeoutMs` + 2 s.
  This is also true while the guest waits for a host call. The limit
  also applies to promise jobs and timers after the script. Only the
  interrupt handler or the deadline can mark a run as timed out. A
  thrown value cannot. The runner refuses a time limit that is not a
  finite number greater than 0, or that is larger than 2147481647 ms.
- Memory: each run gets a fresh engine runtime with a 256 MiB memory
  limit. This limit applies only to the heap of the engine. These limits
  apply to the memory of the run outside that heap:
  - Output: the runner keeps a maximum of `maxOutputChars` characters
    (default 1048576) of output for each run. A character is a UTF-16
    code unit. Each entry costs its characters plus a fixed cost of 64
    characters. Thus an empty entry also counts, and the default limit
    keeps a maximum of 16384 entries. The runner drops the entry that
    goes over the limit, and all output after it. The runner applies the
    limit itself, because it does not trust the worker.
  - Error: the runner keeps a maximum of 10000 characters of the `error`
    of each run. The worker also applies this cap before it posts the
    error. The runner keeps a copy of the characters, not a slice. A
    slice can keep the full string of the guest in host memory.
  - Timers: a run can have a maximum of 10000 pending timers.
  - Fetch: refer to `maxResponseBytes` in the fetch section.

  Other copies, for example of the arguments of a host call, have no
  separate limit. The time limit and the memory limit of the engine
  bound them. The runner retries a run only when the worker reports a spent
  heap from signals that the guest cannot forge. It does not retry a run
  that called `invokeHost()` of a capability. Thus a retry never does the
  side effects of a capability two times. Refer to
  [run lifecycle](run-lifecycle.md).
- Boot: if a worker is not ready within `bootTimeoutMs` (default 30 s),
  the host terminates it.

## Out of scope

- **The in-process host.** `InProcessJsWorker` runs the engine on the
  calling thread for tests (jsdom, SSR). It has no worker isolation.
  `abort()` cannot interrupt a busy guest, because they use the same
  thread. The claim does not include it. It is opt-in. A host uses it in
  one of two ways:
  - `createJsWorkerFactory({ allowInProcess: true })`. This factory uses
    `InProcessJsWorker` only when there is no global `Worker`. When
    `Worker` exists, it starts a real worker.
  - A factory of its own that returns `new InProcessJsWorker()`.

  The default factory never uses it.
- **Third-party runners and capabilities.** This is all `CodeRunner`
  objects other than the built-in JS runner (all that you register through
  `runners`). It is also all `SandboxCapability` objects that you write
  yourself. The `invokeHost()` of a custom capability is host code. The
  guest can do all that it allows.
- **Bugs in the browser and the WebAssembly engine.** This scope does not
  include a bug in QuickJS, the WASM runtime or the browser that lets guest
  code go out of the engine. Such an escape gets access to the worker.
  A worker from an `http(s)` or `blob:` URL has the origin of the page. It
  has `fetch`, `indexedDB` and other worker globals:
  - Its `fetch` sends the cookies of the page to the origin of the page.
    With `credentials: 'include'`, it can send credentialed requests to
    other origins too.
  - It can read and write all IndexedDB and CacheStorage data of the
    origin, `__sandbox_disk__` included.
  - It cannot read `localStorage` or `sessionStorage`, because a worker
    does not have them. Thus it cannot read the proxy token or the data
    of the storage capability.

  A worker from a `data:` URL has an opaque origin. It cannot get access
  to the cookies, IndexedDB or CacheStorage of the page.

  The escape also controls the messages of the worker:
  - It can post forged messages to the host. The host checks their shape,
    as it checks all worker messages. During a run, a forged host call
    can call each method that a capability declares, with all arguments.
    This applies to each capability that was enabled when the run
    started and is still enabled. A forged `fetch` call through the proxy gets the token from
    the host. The escape cannot read the token, but it can use it.
  - It can forge the output and the result of the run.
  - It stays in the worker after the run ends. The runner uses the same
    worker for the next runs, until it replaces the worker (refer to
    [run lifecycle](run-lifecycle.md)). Thus the escape can read the code
    of the next runs, forge their results and make host calls for them.

  To decrease the network access, serve the worker script with its own
  `Content-Security-Policy` header. For example:
  `default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'none'`.
  Put the header on the URL that the worker loads from. Some bundlers
  change the name of `js-worker.js`. The worker does not load other
  resources, so it does not need `connect-src`. This policy stops
  requests from the worker. It does not stop access to IndexedDB,
  CacheStorage or `postMessage`. `worker-src 'none'` stops nested
  workers. Without it, `script-src 'self'` lets the escape start a
  nested worker from a same-origin script. That worker uses the policy of
  its own response, which can have no limits.

  A worker that loads from an `http(s)` URL uses the policy of its own
  response. The policy of the page does not apply to it. A worker from a
  `blob:` or `data:` URL uses the policy of the page. Cross-origin
  isolation (COOP/COEP) does not decrease this access.
- **Denial of service beyond the time and memory limits.** Within its
  limits, a guest can:
  - use all of the CPU;
  - fill its heap;
  - write output up to the output limit;
  - make many capability calls;
  - fill the storage quota of the browser through the storage and disk
    capabilities.

  If a host runs guests in a loop, it must limit the rate of runs itself.
- **What the host does with guest output.** The guest controls these
  strings:
  - console entries;
  - results;
  - the `error` of an `ExecutionResult`, and the reason that the host
    gives to `onRecycle`;
  - capability arguments.

  Render them as text. Do not render them as HTML.
- **Network controls.** Firewalls, DNS, and the security configuration of
  the proxy server (refer to [proxy protocol](proxy-protocol.md)).

## Built-in capabilities: attack surface

All four are off until the host registers and enables them. Arguments
arrive as plain copies of values. Paths, keys and URLs go through
`String()`. `storage.setItem` refuses a value that is not a string.
`disk.writeFile` converts its content with `String()` and does not
refuse it. The fetch `method`, `headers` and `body` do not go through
`String()` (refer to the fetch section).

### fetch (`FetchCapability`)

The guest gets a `fetch(url, { method, headers, body })` that returns a
response with `status`, `ok`, `statusText`, `text()` and `json()`. The
host reads the response body on the main thread and copies it to the
guest. The host does not start the read when `Content-Length` is larger
than `maxResponseBytes` (default 10 MiB). It stops the read when the body
becomes larger than that limit. The limit counts the bytes of the body.
The copies of the body that the host and the worker make (a string, then
JSON, then a message) can be many times larger. These copies are
outside the memory limit of the guest. When a run ends, the host aborts
all requests of the run that are in flight. This includes a run that is
aborted, times out or is superseded.

The capability resolves the guest URL one time, against
`document.baseURI` (else `location.href`). The page `fetch` uses the same
base. The host policy, the same-origin check and the request all use
this absolute URL.

The capability selects the route in this sequence:

1. **Host policy** (only if `allowHosts` or `denyHosts` is set). The
   capability parses the URL with the WHATWG URL parser (relative URLs
   against the page). Only `http:` and `https:` pass. The hostname must
   match the lists: exact names, or `*.example.com` for subdomains only
   (not the apex). Deny has priority. An empty `allowHosts` allows
   nothing.

   Malformed entries throw a `TypeError` when you construct the
   capability. Thus, a list cannot silently match nothing. These entries
   are malformed:
   - a list that is not an array;
   - an entry that is not a string;
   - an empty label (`.evil.net`, `a..b`, `..`);
   - a bare `*` or `*.`;
   - a wildcard over a single label or an IP address (`*.com`,
     `*.0.0.1`).

   The capability does not find public-suffix wildcards with more than
   one label (for example, `*.co.uk`). A refused URL fails before a
   network call occurs. There is no proxy call and the host does not read
   the token. The request goes to the URL that the check examined.
2. **Proxy disabled** (no proxy URL): the `fetch` of the page, directly.
3. **Same-origin URL**: the `fetch` of the page, directly, also when a
   proxy is configured. The origin of the page is `location.origin`.
4. **All other URLs**: a `POST` to the proxy, with the token in a header
   (refer to [proxy protocol](proxy-protocol.md)). The capability removes
   trailing slashes from the proxy base before it adds `/proxy/fetch`.
   The proxy request does not follow redirects (`redirect: 'error'`).
   Thus the token goes only to the host of the proxy base.

What the guest can do with this capability:

- **Same-origin requests send the credentials of the user.** A direct
  same-origin `fetch` sends the cookies of the page, and the guest can
  read the response. Thus, a guest can call the APIs of the host app as
  the user. If the host has same-origin endpoints that guests must not
  get access to, use an `allowHosts` list without the hostname of the
  page. `denyHosts` alone is not sufficient (refer to the subsequent
  text).
- **Direct cross-origin requests** (proxy disabled): the CORS rules of
  the browser control if the guest can read the response. But the browser
  still sends the request. A guest can send simple requests to all hosts
  that the browser can get access to. This includes hosts on the local
  network of the user. Some browsers ask the user before a public page
  sends a request to the local network. Do not depend on this. Two
  controls limit this in all browsers: the host policy, and the
  `connect-src` directive of the page CSP. Direct requests use the
  `fetch` of the page, so the page CSP applies to them. `connect-src`
  also applies when the policy is not set.
- **Requests through the proxy**: the proxy server sends them, from its
  network. The proxy must refuse private and internal destinations. A
  same-origin proxy also gets the cookies of the page. Its response
  headers apply to the origin of the page. A proxy that copies headers
  between the client and the destination can thus give the session of
  the user to the guest, or let the guest set cookies of the host app.
  Refer to [same-origin proxy](proxy-protocol.md#same-origin-proxy).
- **The token**: the host reads it on the main thread only when a request
  goes to the proxy. The host never copies it into the worker, never
  returns it to the guest, and never puts it in an error message. A `401`
  with `X-Proxy-Error: unauthorized` from the proxy clears it. A `401`
  from the destination goes to the guest as a response. Thus, with a
  proxy that follows the [proxy protocol](proxy-protocol.md), a guest
  cannot clear the token. But when no token is set, a guest request to
  the proxy marks the token as invalid. Thus a guest can cause the
  `tokenInvalid` signal of the host, and a token prompt if the host shows
  one.
- `ProxyAuth.setToken` accepts only visible ASCII characters, or an empty
  string. `authHeader()` ignores an empty token, and a token with other
  characters. Thus the token is always a valid header value, and a header
  error from `fetch()` cannot contain it.
- The guest chooses the method, headers and body. The capability sends
  only these three options. It ignores all other options, for example
  `credentials`, `mode` and `redirect`. The capability does not convert
  the three options to strings. In proxy mode, they go to the proxy as
  the JSON values that the guest gave. In direct mode, the browser
  removes forbidden browser headers. The proxy decides which headers it
  sends to the destination.

Limits of the host policy:

- **The guest can get access to an allowed host on all ports and over
  plain `http`.** The policy matches only the hostname.
  `allowHosts: ['example.com']` admits `http://example.com:8080/` and
  also `https://example.com/`. Thus, the guest can get access to all
  services on that host.
- **`denyHosts` is not a security boundary.** It compares hostnames, not
  destinations. The guest can get access to the same server through an
  IP literal (`http://203.0.113.7/`), a CNAME or any other name that
  resolves to it. None of these match a deny entry for the name. The URL
  parser normalizes IPv4 spellings (for example, `http://0xcb.0.113.7/`)
  on the two sides, so these match an IPv4 deny entry. An IPv4-mapped
  IPv6 address (`http://[::ffff:203.0.113.7]/`) does not match it. Use
  `denyHosts` to make exceptions in an `allowHosts` list.
  To limit the guest, we recommend `allowHosts`.

- **The policy does not check redirects again.** In direct mode, the
  browser follows redirects, and a proxy can also follow them. Thus, an
  open redirect on an allowed host can go to a host that is not allowed.
  Proxies SHOULD apply their own policy to each hop.
- **Same-origin redirects go around the proxy.** A same-origin URL goes
  directly, also when a proxy is configured, and the browser follows its
  redirects. Thus an open redirect on the origin of the page can send a
  direct request to any host. That request does not go through the proxy
  or its policy. CORS still controls if the guest can read the response.
- **It matches hostnames, not addresses.** If an allowed hostname
  resolves to a private address, the policy does not block it.
- **The proxy can parse URLs differently.** The capability sends the
  parsed absolute URL, and this decreases the risk. But a proxy must
  still enforce its own policy.

### storage (`StorageCapability`)

`storage.getItem(key)`, `setItem(key, value)` and `removeItem(key)`. With
the default `LocalStorageBackend`, the keys are in the `localStorage` of
the page, under the prefix `__sandbox_storage__:`. Values must be
strings.

- The guest can read, overwrite and delete all keys under that prefix.
  This includes keys from earlier runs, other guests, other tabs and
  page code on the same origin. The guest has no method that lists keys.
  Thus it gets access only to keys whose names it knows or guesses. Data
  stays from one run to the next, and from one session to the next.
- The guest cannot get access to keys outside the prefix.
- Host code that reads these keys must not trust their values.
- Writes use the `localStorage` quota of the origin. To set the scope of
  storage or to limit it, give a `MapStorageBackend` or your own backend
  to `new StorageCapability(backend)`. A backend is an object with
  synchronous `getItem`, `setItem` and `removeItem`. The prefix is a
  feature of `LocalStorageBackend` only. Other backends get the key of
  the guest without changes. `MapStorageBackend` has no size limit.

### disk (`DiskCapability`)

`disk.writeFile(path, content)`, `readFile(path)` and `listFiles(dir)`
on a virtual file system. With the default `IndexedDBDiskBackend`, files
are records in the `__sandbox_disk__` IndexedDB database.

- Paths are normalized strings that the store uses as record keys. There
  is no real file system behind them. Thus, `..` and similar paths cannot
  go out of the store.
- The capability splits a path only at `/`. It removes empty and `.`
  segments, and resolves `..` segments. A `..` at the root stays at the
  root (`/../x` is `/x`). Thus, `/a/../b` and `/b` are the same file. A
  relative path starts at `/`. A backslash is an ordinary character.
- The guest can read, overwrite and list all files in the store. This
  includes files from earlier runs and other guests. Data stays from one
  run to the next, and from one session to the next. The guest cannot
  delete files.
- The host can get access to the same files through `getBackend()`. Do
  not trust their contents. The backend does not normalize keys. Thus a
  key that the host writes without a leading `/` is not available to the
  guest.
- Writes use the storage quota of the origin. To set the scope of the
  store, give a `MapDiskBackend` or your own `DiskBackend` to
  `new DiskCapability(backend)`. `MapDiskBackend` keeps the files in the
  memory of the page, and it has no size limit. To limit the size of the
  store, give your own `DiskBackend`.

### timer (`TimerCapability`)

Enables `setTimeout`, `setInterval`, `clearTimeout` and `clearInterval`.
The timers run inside the worker on virtual time. The worker drains them
before the run settles. After a timeout, or when a promise job throws,
the worker stops the drain and discards the remaining timers. Thus,
timers cannot fire after the run ends. The
timer functions make no host calls. A timer callback is guest code, so it
can call the enabled capabilities, as all guest code can. The timers add
two risks:

- CPU time, for example an interval with a delay of 0. The time limit of
  the run limits it.
- Memory of the worker. Each pending timer has an entry in the worker,
  outside the heap of the engine. A run can have a maximum of 10000
  pending timers. A timer is pending until it fires or the guest clears
  it. A clear removes the entry at once. Over the limit, `setTimeout` and
  `setInterval` throw a `RangeError`.

## Reporting a vulnerability

Report security issues privately. Do not report them in a public issue.
Use the private vulnerability reports of the repository ("Report a
vulnerability" in the Security tab). Include:

- the package version and browser;
- a minimal guest script and host setup that show the issue;
- what the guest got: host state that it read or changed, a side effect
  without a capability, the token, or a limit that it went around.

The maintainer will reply to the report, and will agree the fix and its
disclosure with you. For issues in "Out of scope" above, open a usual bug
report. [SECURITY.md](../SECURITY.md) lists the supported versions.
