# Proxy protocol

This page tells how `FetchCapability` communicates with a CORS proxy, and
what a proxy must do to operate with it. You can use any server that
follows this page. Same-origin requests do not go to the proxy. Requests
that the guest makes while the proxy is disabled also do not go to the
proxy. Refer to the fetch section of the [threat model](threat-model.md).

## Configuration

The proxy base comes from `corsProxyUrl` (`createSandboxRuntime`).
`ProxyAuth.proxyBase()` reads it:

| `corsProxyUrl` | Meaning |
| --- | --- |
| `null` (or unset) | Proxy disabled: every guest `fetch` goes directly to the destination. |
| `''` | Same-origin proxy at `/proxy/fetch` (for example, a dev-server rewrite). |
| path (`/api`) | Same-origin proxy at `{path}/proxy/fetch`. |
| absolute URL | The proxy base, for example `https://proxy.example.com`. |

The client removes trailing slashes from the base, then adds
`/proxy/fetch`. Thus `'/'` is the same as `''`, and
`https://proxy.example.com/` gives `https://proxy.example.com/proxy/fetch`.
A relative base resolves against `location.href` of the page, not
against a `<base>` element. Thus a base that is empty or starts with one
`/` keeps the token on the origin of the page. A protocol-relative base
(`//proxy.example.com`) is a different host. To use a different host,
write the full absolute URL.

Do not put credentials in `corsProxyUrl`. The `FetchCapability`
constructor throws a `TypeError` for a proxy URL with a user name or a
password. It also throws for a proxy URL that does not parse. An empty
base and a relative base parse. The capability examines
`proxyBase()` again on each proxy call. The errors that the guest gets do
not show the proxy URL or the token.

A same-origin proxy gets more than the token. Refer to
[Same-origin proxy](#same-origin-proxy).

The token is in `sessionStorage` on the host page (`ProxyAuth.setToken`).
The host reads it again for each request through the proxy. The token
never goes into the worker.

## Request

For each guest `fetch(url, options)` whose URL does not have the origin
of the page. This includes URLs with an opaque origin, for example
`data:` and `about:` URLs. Without a host policy (`allowHosts` or
`denyHosts`), the `url` field can thus have any scheme:

```http
POST {proxyBase}/proxy/fetch
Content-Type: application/json
X-Proxy-Authorization: Bearer <token>

{"url":"https://api.example.com/items?page=2","method":"GET","headers":{},"body":null}
```

| Body field | Type | Value |
| --- | --- | --- |
| `url` | string | The destination, as a parsed absolute URL. The client resolves the URL of the guest against `document.baseURI` (else `location.href`), the same as the `fetch` of the page. With `allowHosts`/`denyHosts`, this is the URL that passed the policy. |
| `method` | any JSON value | The `options.method` of the guest. The default is `"GET"`. |
| `headers` | any JSON value | The `options.headers` of the guest. The default is `{}`. |
| `body` | any JSON value | The `options.body` of the guest. The default is `null`. |

The guest controls `url`, `method`, `headers` and `body`. The proxy must
not trust these four fields. The client does not convert `method`,
`headers` or `body` to strings, and does not examine their types. Thus
`headers` can be an array of pairs, an object with values that are not
strings, or any other JSON value. `body` can be an object or a number.
The proxy must check the type of each field. It must answer `400` for a
type that it does not accept.

The client sends only these four fields. It ignores all other guest
options, for example `credentials`, `mode`, `redirect` and `cache`.

The client puts the token in `X-Proxy-Authorization`. A cross-origin
proxy gets no other host secret. A same-origin proxy also gets the
cookies of the page (refer to [Same-origin proxy](#same-origin-proxy)).
`ProxyAuth.setToken` removes whitespace at the start and end of the
token. Then it accepts only visible ASCII characters (0x21–0x7E), or an
empty string. It throws a `TypeError` for other tokens. The client does
not send an empty token. Thus the token is always a valid header value.

If there is no token, the host does not send the request. The `fetch` of
the guest fails with
`fetch failed: Proxy fetch failed: no authentication token. …`.
`ProxyAuth` marks the token as invalid, so that the host can ask for a
token.

The request has `X-Proxy-Authorization` and a JSON body. Thus, when the
proxy is on a different origin, the browser first sends a CORS preflight
(`OPTIONS {proxyBase}/proxy/fetch`). The preflight has no token. The proxy
must answer the preflight without auth. The answer must have
`Access-Control-Allow-Origin` for the origin of the host page. It must
also have `Access-Control-Allow-Headers: Content-Type, X-Proxy-Authorization`.
`POST` is a CORS-safelisted method, thus `Access-Control-Allow-Methods`
is not necessary.

The client sends the request with `redirect: 'error'`. The browser keeps
`X-Proxy-Authorization` on a redirect, also to a different origin. Thus a
redirect response from the proxy makes the `fetch` of the guest fail, and
the token does not go to a different host.

## Responses

The guest gets the response of the proxy as the fetch result: its
`status`, `ok` and `statusText`, and its body as text. The guest does not
get the response headers. Over HTTP/2 and HTTP/3, `statusText` is empty.

The client reads the body as a stream and counts the bytes. If the body
is larger than `maxResponseBytes` (default 10 MiB), the client cancels
the stream and the `fetch` of the guest fails. When a run ends, the
client aborts all requests of the run that are in flight. It does not
abort the requests of other runs.

| Status | Meaning | What the client does |
| --- | --- | --- |
| Destination's status (2xx–5xx) | The proxy got a response from the destination, and sends its status and body. | Gives them to the guest without changes. This includes a `401` from the destination. |
| `401` with `X-Proxy-Error: unauthorized` | Missing or wrong token. | Removes the token, marks it as invalid, and makes the `fetch` of the guest fail with `fetch failed: CORS proxy rejected the token. Re-enter a valid token.` |
| `400` | Malformed request body (no `url`, incorrect types). | Gives it to the guest as a response. |
| `403` | The policy of the proxy refused the destination (scheme, host, private address). | Gives it to the guest as a response. |
| `502` | Upstream error (connection failed, too many redirects). | Gives it to the guest as a response. |
| `504` | Upstream timeout before the headers arrived. | Gives it to the guest as a response. |
| `500` | Internal proxy error. | Gives it to the guest as a response. |

The client examines only a `401` with `X-Proxy-Error: unauthorized`. A
destination can also answer `401`. Thus the status alone cannot tell a
token failure, and a guest cannot clear the token with a `401` URL. To the
guest, other proxy errors look the same as all other HTTP errors. Thus, use a status that a guest can
identify, and a small JSON body. We recommend this error body:

```json
{ "error": "destination_blocked", "message": "Destination blocked", "status": 403 }
```

When the proxy is cross-origin, the response must have
`Access-Control-Allow-Origin` for the origin of the host page. A `401`
for a token failure must also have
`Access-Control-Expose-Headers: X-Proxy-Error`. Else the client cannot
read the header. A proxy can
stream the body. The client reads all of the body before it gives the body
to the guest.

## Same-origin proxy

A proxy on the origin of the page (`''` or a path) has more risks than a
proxy on a different origin:

- The client does not set `credentials`, so the browser uses
  `'same-origin'`. Thus each request to the proxy has the cookies of the
  page. It also has the full URL of the page in `Referer`. A proxy that
  copies these headers to the destination sends the session of the user
  to a host that the guest selected.
- The browser applies the response headers of the proxy to the origin
  of the page. If the proxy sends the headers of the destination, the
  destination can set or overwrite the cookies of the host app
  (`Set-Cookie`). It can also remove the cookies and storage of the
  origin (`Clear-Site-Data`). The guest selects the destination.

The requirements below prevent both risks. A proxy on a different origin
does not get the cookies of the page. The browser ignores its
`Set-Cookie` headers, because the client does not use
`credentials: 'include'`. All proxies must still follow the
requirements, because the same proxy can later move to the origin of
the page.

## Proxy requirements

A proxy MUST:

- check `X-Proxy-Authorization` on every `POST`, and answer `401` with
  `X-Proxy-Error: unauthorized` when it is missing or incorrect (compare
  in constant time);
- remove `X-Proxy-Error` from the response headers of the destination,
  so that a destination cannot clear the token;
- never answer the client with a redirect (`3xx`). Follow the redirects
  of the destination, or answer `502`;
- never send `X-Proxy-Authorization` (or any other proxy credential) to
  the destination, also when the guest names it in `headers`;
- make the request to the destination only from the `url`, `method`,
  `headers` and `body` fields. Never copy a header of the request from
  the client, for example `Cookie`, `Referer` or `Origin`;
- send no header of the destination response to the client, other than
  `Content-Type`. The client does not read other headers. Headers such as
  `Set-Cookie` and `Clear-Site-Data` can change the state of the host
  page (refer to [Same-origin proxy](#same-origin-proxy));
- never put the value of `X-Proxy-Authorization` in a response, for
  example in an error body;
- refuse loopback, private, link-local and other internal addresses.
  Apply this check to the destination and to each redirect hop, that is,
  to each connection that the proxy opens. Do the check after DNS
  resolution, and connect to the address that it checked (no DNS
  rebinding between the check and the connection);
- never send a `Host`, `Content-Length`, `Transfer-Encoding` or
  `Connection` header, or another hop-by-hop or forbidden request header,
  from the `headers` field. The client sends the guest headers without
  changes. Set `Host` from the URL that the proxy checked. Set
  `Content-Length` or `Transfer-Encoding` from the body that the proxy
  sends;
- allow only `http` and `https` destinations and redirect hops, and
  refuse all other schemes.

A proxy SHOULD:

- use `https`. Over `http`, the token and the requests are not
  encrypted;
- **enforce its own host allow/deny policy**, on the destination and on
  each redirect hop, also when the client has a policy. The client policy
  in `FetchCapability` checks only the first URL. It does not check
  redirects again, thus an open redirect on an allowed host can go to a
  host that is not allowed. Also, the proxy can parse the URL differently
  from the browser, and a client can have an incorrect configuration or a
  replacement;
- set a limit on the response size and the request duration;
- return the same error body for all types of refused destination, so that
  a guest cannot find which check failed.
