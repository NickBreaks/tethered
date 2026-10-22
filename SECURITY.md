# Security policy

## What is claimed

> Guest JavaScript run by the built-in JS runner, inside a real web
> `Worker`, cannot read or change host state and cannot cause side
> effects, except through the capabilities the host registered and
> enabled for that run. Each run is bounded by its time limit and a
> per-run memory limit. The claim covers the built-in JS runner only.

Not covered: the in-process fallback (`allowInProcess`), runners and
capabilities you write yourself, bugs in the browser or the WebAssembly
engine, and denial of service within the time and memory limits. The
[threat model](docs/threat-model.md) has the full scope and each built-in
capability's attack surface.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

While tethered is 0.x, only the latest minor release gets security fixes.

## Reporting a vulnerability

Report security issues privately through GitHub's private vulnerability
reporting: open the repository's **Security** tab and choose **Report a
vulnerability**. Please do not open a public issue, pull request or
discussion for a vulnerability.

Include:

- the tethered version and the browser;
- a minimal guest script and host setup that reproduce the issue;
- what the guest gained (host state read or changed, a side effect
  without a capability, the proxy token, a limit bypassed).

The maintainer will acknowledge the report, work on a fix, and agree a
disclosure date with you. Issues that fall outside the claim are welcome
as regular bug reports.
