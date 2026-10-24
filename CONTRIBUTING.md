# Contributing

Thank you for your help.

## Issues

- To report a bug, open an issue. Include the tethered version, the
  browser, and a minimal guest script and host setup.
- Do not report a vulnerability in a public issue. Use the procedure in
  [SECURITY.md](SECURITY.md).

## Pull requests

1. Read [Development](docs/development.md) for the commands and the test
   rules.
2. Add a spec that fails without your change.
3. Run `npm run lint`, `npm run typecheck`, `npm test` and
   `npm run test:integration`. All must pass.
4. Write docs and code comments in the [writing style](docs/writing-style.md).
5. Add an entry for each change in the API or behavior to
   [CHANGELOG.md](CHANGELOG.md).
