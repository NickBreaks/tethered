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
> for that run. Each run is bounded by its time limit (`timeoutMs`) and a
> per-run memory limit. The claim covers the built-in JS runner only.

All of the subsequent text supports that claim or sets its limits.

## In scope

**Isolation of the guest from the host.** The guest runs in a QuickJS
engine compiled to WebAssembly, inside a dedicated web worker:

- The guest sees only the built-ins of the engine, a `console`, and the
  globals installed for enabled capabilities. It has no DOM and no
  `window`. It has none of the globals of the worker (its `fetch`,
  `importScripts`, `indexedDB`, `postMessage`), and no host objects.
  Values cross the engine boundary as copies.
- The host does not trust the worker. `JsRunner` checks the shape of each
  message that the worker posts. It ignores all messages that are not
  exactly a known message. The host sends replies to host calls only to
  the worker that asked, for the run that asked.
- `abort()`, a supersede and the timeout backstop terminate the worker
  and start a fresh one. Thus, no run can continue after its limit, and
  no run can leave state in the engine of the next run.

**Side effects only through registered capabilities.** The worker sends
a guest call to a capability to the main thread as
`(capability, method, args)`. The `invokeHost()` of that capability
processes the call. A call goes to `invokeHost()` only if these
conditions are true:

- The capability is registered and enabled on the host when the call
  arrives.
- The capability declares the `method` in its `stubInfo`. For a function
  capability, this is its `globals` or its own name. For an object, this
  is its `methods`.

If not, the guest gets an error. The guest chooses the `args` values, and
`invokeHost()` must check them.
Disabled capabilities are installed as stubs that throw. The host keeps
its secrets (for example, the proxy token) on the main thread. The host
never copies them into the worker or into an error message.

**Limits.**

- Time: the interrupt handler of the engine stops guest code after
  `timeoutMs` (default 5000 ms for each run). If the engine cannot stop
  itself, a backstop on the main thread terminates the worker 2 s later.
  This is also true while the guest waits for a host call. The limit
  also applies to promise jobs and timers after the script. Only the
  interrupt handler or the deadline can mark a run as timed out. A
  thrown value cannot. The runner refuses a time limit that is not
  finite and greater than 0.
- Memory: each run gets a fresh engine runtime with a 256 MiB memory
  limit. The runner retries a run only when the worker reports a spent
  heap from signals that the guest cannot forge. Refer to
  [run lifecycle](run-lifecycle.md).
- Boot: if a worker is not ready within `bootTimeoutMs` (default 30 s),
  the host terminates it.

## Out of scope

- **The in-process fallback.** `createJsWorkerFactory({ allowInProcess: true })`
  runs the engine on the calling thread for tests (jsdom, SSR). It has no
  worker isolation. `abort()` cannot interrupt a busy guest, because they
  use the same thread. The claim does not include it. It is opt-in, and
  the default factory does not use it.
- **Third-party runners and capabilities.** This is all `CodeRunner`
  objects other than the built-in JS runner (all that you register through
  `runners`). It is also all `SandboxCapability` objects that you write
  yourself. The `invokeHost()` of a custom capability is host code. The
  guest can do all that it allows.
- **Bugs in the browser and the WebAssembly engine.** This scope does not
  include a bug in QuickJS, the WASM runtime or the browser that lets guest
  code go out of the engine. Such an escape gets access to a same-origin
  worker. That worker has `fetch`, `indexedDB` and other worker globals.
  To decrease that access, deploy the page with a strict Content Security
  Policy and cross-origin isolation.
- **Denial of service beyond the time and memory limits.** Within its
  limits, a guest can:
  - use all of the CPU;
  - fill its heap;
  - write large output;
  - make many capability calls;
  - fill the storage quota of the browser through the storage and disk
    capabilities.

  If a host runs guests in a loop, it must limit the rate of runs itself.
- **What the host does with guest output.** The guest controls the
  strings in console entries, results and capability arguments. Render
  them as text. Do not render them as HTML.
- **Network controls.** Firewalls, DNS, and the security configuration of
  the proxy server (refer to [proxy protocol](proxy-protocol.md)).

## Built-in capabilities: attack surface

All four are off until the host registers and enables them. Arguments
arrive as plain copies of values. Paths, keys and URLs go through
`String()`. `storage.setItem` refuses a value that is not a string.

### fetch (`FetchCapability`)

The guest gets a `fetch(url, { method, headers, body })` that returns a
response with `status`, `ok`, `statusText`, `text()` and `json()`. The
host reads the response body on the main thread and copies it to the
guest. The host stops the read when the body becomes larger than
`maxResponseBytes` (default 10 MiB). This limit is outside the memory
limit of the worker. When a run ends, the host aborts all requests of
the run that are in flight. This includes a run that is aborted, times
out or is superseded.

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
  network of the user. Only the host policy can limit this.
- **Requests through the proxy**: the proxy server sends them, from its
  network. The proxy must refuse private and internal destinations.
- **The token**: the host reads it on the main thread only when a request
  goes to the proxy. The host never copies it into the worker, never
  returns it to the guest, and never puts it in an error message. A `401`
  from the proxy clears it.
- The guest chooses the method, headers and body. In direct mode, the
  browser removes forbidden browser headers. The proxy decides which
  headers it sends to the destination.

Limits of the host policy:

- **The guest can get access to an allowed host on all ports and over
  plain `http`.** The policy matches only the hostname.
  `allowHosts: ['example.com']` admits `http://example.com:8080/` and
  also `https://example.com/`. Thus, the guest can get access to all
  services on that host.
- **`denyHosts` is not a security boundary.** It compares hostnames, not
  destinations. The guest can get access to the same server through an
  IP literal (`http://203.0.113.7/`, or a different spelling of it), a
  CNAME or any other name that resolves to it. None of these match the
  deny entry. Use `denyHosts` to make exceptions in an `allowHosts` list.
  To limit the guest, we recommend `allowHosts`.

- **The policy does not check redirects again.** In direct mode, the
  browser follows redirects, and a proxy can also follow them. Thus, an
  open redirect on an allowed host can go to a host that is not allowed.
  Proxies SHOULD apply their own policy to each hop.
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
  This includes keys from earlier runs and other guests. Data stays from
  one run to the next, and from one session to the next.
- The guest cannot get access to keys outside the prefix.
- Host code that reads these keys must not trust their values.
- Writes use the `localStorage` quota of the origin. To set the scope of
  storage or to limit it, give your own backend (any object with
  `getItem`, `setItem` and `removeItem`) to
  `new StorageCapability(backend)`.

### disk (`DiskCapability`)

`disk.writeFile(path, content)`, `readFile(path)` and `listFiles(dir)`
on a virtual file system. With the default `IndexedDBDiskBackend`, files
are records in the `__sandbox_disk__` IndexedDB database.

- Paths are normalized strings that the store uses as record keys. There
  is no real file system behind them. Thus, `..` and similar paths cannot
  go out of the store.
- The capability resolves `.` and `..` segments as POSIX does. A `..` at
  the root stays at the root (`/../x` is `/x`). Thus, `/a/../b` and `/b`
  are the same file.
- The guest can read, overwrite and list all files in the store. This
  includes files from earlier runs and other guests. Data stays from one
  run to the next, and from one session to the next.
- The host can get access to the same files through `getBackend()`. Do
  not trust their contents.
- Writes use the storage quota of the origin. To set the scope of the
  store or to limit it, give a `MapDiskBackend` or your own
  `DiskBackend`.

### timer (`TimerCapability`)

Enables `setTimeout`, `setInterval`, `clearTimeout` and `clearInterval`.
The timers run inside the worker on virtual time. The worker drains them
before the run settles. Thus, they cannot fire after the run ends. They
make no host calls. The only risk is CPU time, and the time limit of the
run limits it.

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
