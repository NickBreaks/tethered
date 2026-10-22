# Proxy protocol

How `FetchCapability` talks to a CORS proxy, and what a proxy must do to
work with it. Any server that follows this page can be used. Requests that
are same-origin, or made while the proxy is disabled, never reach the
proxy (see the fetch section of the [threat model](threat-model.md)).

## Configuration

The proxy base comes from `corsProxyUrl` (`createSandboxRuntime`) and is
read through `ProxyAuth.proxyBase()`:

| `corsProxyUrl` | Meaning |
| --- | --- |
| `null` (or unset) | Proxy disabled: every guest `fetch` goes direct. |
| `''` | Same-origin proxy at `/proxy/fetch` (for example, a dev-server rewrite). |
| absolute URL | The proxy base, for example `https://proxy.example.com`. |

The token lives in `sessionStorage` on the host page (`ProxyAuth.setToken`)
and is read fresh for each proxied request. It never enters the worker.

## Request

For each cross-origin guest `fetch(url, options)`:

```http
POST {proxyBase}/proxy/fetch
Content-Type: application/json
X-Proxy-Authorization: Bearer <token>

{"url":"https://api.example.com/items?page=2","method":"GET","headers":{},"body":null}
```

| Body field | Type | Value |
| --- | --- | --- |
| `url` | string | The destination. Without a host policy it is the guest's string as given; with `allowHosts`/`denyHosts` it is the parsed absolute URL (`new URL(url, location.href).href`) that passed the policy. |
| `method` | string | The guest's `options.method`, default `"GET"`. |
| `headers` | object | The guest's `options.headers` as a `{ name: value }` object of strings, default `{}`. |
| `body` | string or `null` | The guest's `options.body`, default `null`. |

The guest controls `url`, `method`, `headers` and `body`; the proxy must
treat all four as untrusted. The token in `X-Proxy-Authorization` is the
only host secret in the request.

If no token is set, the request is not sent: the guest's `fetch` fails
with `Proxy fetch failed: no authentication token. …` and `ProxyAuth`
marks the token invalid, so the host can prompt for one.

Because the request carries `X-Proxy-Authorization` and a JSON body, the
browser sends a CORS preflight (`OPTIONS {proxyBase}/proxy/fetch`) first
when the proxy is on another origin. The preflight has no token. The proxy
must answer it without requiring auth and allow `POST` and the
`Content-Type` and `X-Proxy-Authorization` request headers.

## Responses

The proxy's response is handed to the guest as the fetch result: its
`status`, `ok` and `statusText`, and its body read as text.

| Status | Meaning | What the client does |
| --- | --- | --- |
| Destination's status (2xx–5xx) | The proxy reached the destination and relays its status and body. | Passes them to the guest unchanged. |
| `401` | Missing or wrong token. | Clears the token, marks it invalid, and fails the guest's `fetch` with `CORS proxy rejected the token. Re-enter a valid token.` |
| `400` | Malformed request body (missing `url`, wrong types). | Passed to the guest as a response. |
| `403` | Destination refused by the proxy's policy (scheme, host, private address). | Passed to the guest as a response. |
| `502` | Upstream error (connection failed, too many redirects). | Passed to the guest as a response. |
| `504` | Upstream timed out before sending headers. | Passed to the guest as a response. |
| `500` | Internal proxy error. | Passed to the guest as a response. |

Only `401` is interpreted by the client. Other proxy errors look like any
other HTTP error to the guest, so use a status a guest can tell apart and
a small JSON body. The recommended error body is:

```json
{ "error": "destination_blocked", "message": "Destination blocked", "status": 403 }
```

The response must carry `Access-Control-Allow-Origin` for the host page's
origin when the proxy is cross-origin. A proxy may stream the body; the
client reads it to the end before returning it to the guest.

## Proxy requirements

A proxy MUST:

- check `X-Proxy-Authorization` on every `POST` and answer `401` when it
  is missing or wrong (compare in constant time);
- never forward `X-Proxy-Authorization` (or any other proxy credential)
  to the destination, including when the guest names it in `headers`.

A proxy SHOULD:

- **enforce its own host allow/deny policy**, on the destination and on
  every redirect hop, even when the client has one. The client-side
  policy in `FetchCapability` checks only the first URL: redirects are not
  re-checked, so an open redirect on an allowed host can lead to a host
  that is not allowed. The proxy may also parse the URL differently from
  the browser, and a client can be misconfigured or replaced;
- refuse loopback, private, link-local and other internal addresses after
  DNS resolution, and connect to the address it checked (no DNS
  rebinding between check and connect);
- allow only `http` and `https` destinations;
- strip hop-by-hop headers from the forwarded request and the relayed
  response;
- cap response size and request duration;
- return the same error body for every kind of refused destination, so a
  guest cannot probe which check failed.
