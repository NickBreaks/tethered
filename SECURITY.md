# Security policy

## Security goal

Caution: no independent party has reviewed or audited tethered. The
tests and the reviews of the maintainer examine the goal, but they cannot
prove it. Do not use tethered as the only barrier between hostile code
and data or credentials that you must keep safe. Reviews and reports of
escapes are welcome.

tethered has this security goal:

> Guest JavaScript run by the built-in JS runner, inside a real web
> `Worker`, cannot read or change host state and cannot cause side
> effects, except through the capabilities the host registered and
> enabled for that run. Each run is bounded by its time limit (with a
> 2 s backstop) and a per-run memory limit. The goal covers the
> built-in JS runner only.

The goal does not include:

- the in-process host (`InProcessJsWorker`, also through `allowInProcess`);
- runners and capabilities that you write yourself;
- bugs in the browser or the WebAssembly engine;
- denial of service within the time and memory limits.

The [threat model](docs/threat-model.md) gives the full scope and the
attack surface of each built-in capability.

## Supported versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

While tethered is 0.x, only the latest minor release gets security fixes.

## Reporting a vulnerability

Report security issues privately. Do not open a public issue, pull
request or discussion for a vulnerability. The repository is not public
yet. When it is public, use the GitHub private vulnerability reports:
open the **Security** tab of the repository and select **Report a
vulnerability**.

Include:

- the tethered version and the browser;
- a minimal guest script and host setup that show the issue;
- what the guest got: host state that it read or changed, a side effect
  without a capability, the proxy token, or a limit that it went around.

Also use the private report for an escape from QuickJS, the WASM runtime
or the browser, and tell the upstream project. The maintainer will reply
to the report, work on a fix, and agree a disclosure date with you. For
other issues outside the goal, open a usual bug report.
