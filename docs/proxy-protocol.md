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
| absolute URL | The proxy base, for example `https://proxy.example.com`. |

The token is in `sessionStorage` on the host page (`ProxyAuth.setToken`).
The host reads it again for each request through the proxy. The token
never goes into the worker.

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
| `url` | string | The destination. Without a host policy, it is the string from the guest, without changes. With `allowHosts`/`denyHosts`, it is the parsed absolute URL (`new URL(url, location.href).href`) that passed the policy. |
| `method` | string | The `options.method` of the guest. The default is `"GET"`. |
| `headers` | object | The `options.headers` of the guest, as a `{ name: value }` object of strings. The default is `{}`. |
| `body` | string or `null` | The `options.body` of the guest. The default is `null`. |

The guest controls `url`, `method`, `headers` and `body`. The proxy must
not trust these four fields. The token in `X-Proxy-Authorization` is the
only host secret in the request.

If there is no token, the host does not send the request. The `fetch` of
the guest fails with `Proxy fetch failed: no authentication token. …`.
`ProxyAuth` marks the token as invalid, so that the host can ask for a
token.

The request has `X-Proxy-Authorization` and a JSON body. Thus, when the
proxy is on a different origin, the browser first sends a CORS preflight
(`OPTIONS {proxyBase}/proxy/fetch`). The preflight has no token. The proxy
must answer the preflight without auth. The answer must allow `POST` and
the `Content-Type` and `X-Proxy-Authorization` request headers.

## Responses

The guest gets the response of the proxy as the fetch result: its
`status`, `ok` and `statusText`, and its body as text.

| Status | Meaning | What the client does |
| --- | --- | --- |
| Destination's status (2xx–5xx) | The proxy got a response from the destination, and sends its status and body. | Gives them to the guest without changes. |
| `401` | Missing or wrong token. | Removes the token, marks it as invalid, and makes the `fetch` of the guest fail with `CORS proxy rejected the token. Re-enter a valid token.` |
| `400` | Malformed request body (no `url`, incorrect types). | Gives it to the guest as a response. |
| `403` | The policy of the proxy refused the destination (scheme, host, private address). | Gives it to the guest as a response. |
| `502` | Upstream error (connection failed, too many redirects). | Gives it to the guest as a response. |
| `504` | Upstream timeout before the headers arrived. | Gives it to the guest as a response. |
| `500` | Internal proxy error. | Gives it to the guest as a response. |

The client examines only `401`. To the guest, other proxy errors look
the same as all other HTTP errors. Thus, use a status that a guest can
identify, and a small JSON body. We recommend this error body:

```json
{ "error": "destination_blocked", "message": "Destination blocked", "status": 403 }
```

When the proxy is cross-origin, the response must have
`Access-Control-Allow-Origin` for the origin of the host page. A proxy can
stream the body. The client reads all of the body before it gives the body
to the guest.

## Proxy requirements

A proxy MUST:

- check `X-Proxy-Authorization` on every `POST`, and answer `401` when it
  is missing or incorrect (compare in constant time);
- never send `X-Proxy-Authorization` (or any other proxy credential) to
  the destination, also when the guest names it in `headers`.

A proxy SHOULD:

- **enforce its own host allow/deny policy**, on the destination and on
  each redirect hop, also when the client has a policy. The client policy
  in `FetchCapability` checks only the first URL. It does not check
  redirects again, thus an open redirect on an allowed host can go to a
  host that is not allowed. Also, the proxy can parse the URL differently
  from the browser, and a client can have an incorrect configuration or a
  replacement;
- refuse loopback, private, link-local and other internal addresses after
  DNS resolution, and connect to the address that it checked (no DNS
  rebinding between the check and the connection);
- allow only `http` and `https` destinations;
- remove hop-by-hop headers from the request that it sends and the
  response that it returns;
- set a limit on the response size and the request duration;
- return the same error body for all types of refused destination, so that
  a guest cannot find which check failed.
