# Contributing

Thanks for helping improve the Game-Agent Open Standard SDK.

## Before opening a change

- Search existing issues and pull requests for related work.
- Open an issue before a large API or protocol change so the boundary can be
  agreed before implementation.
- Keep product content out of the SDK. Reusable mechanism behavior, deterministic
  infrastructure, and integration contracts belong here; characters, authored
  levels, game modes, and product policy do not.

## Local setup

```sh
npm install
npm run typecheck
npm test
npm run build
npm run docs:build
```

Python changes also require:

```sh
python3 -m pip install build pytest
PYTHONPATH=python python3 -m pytest python/tests
python3 -m build python
```

Use `npm run docs:dev` for a local documentation server.

## Pull requests

Keep changes focused and explain the reusable problem they solve. Add or update
tests for observable behavior, including deterministic ordering and boundary
cases. Update the relevant guide when a public API, compatibility promise, or
integration workflow changes.

Prefer small, intentional commits. Do not include generated `dist` output or
credentials. A pull request should pass the TypeScript build, test, typecheck,
documentation build, and any affected Python checks.
