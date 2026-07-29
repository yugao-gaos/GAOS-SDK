# Support and compatibility

## Versioning

TypeScript and Python distributions share one semantic version. While the SDK
is below `1.0.0`, minor releases may include breaking API changes. Patch
releases are reserved for compatible fixes.

The generic `gaos.ticks` v1 wire contract has its own compatibility promise:
breaking its envelope, cursor, retry, or simultaneous-intent behavior requires
a new protocol version. See [Tick protocol v1](/protocol-v1).

The current SDK establishes `gaos.ticks` v1 as the canonical transport with
`kind: "tick"`, `tickId`, and `tick`.

Pin an exact release for production and review the GitHub release notes before
upgrading. Releases through v0.25.0 use the former package name:

```json
{
  "dependencies": {
    "@yugao-gaos/turn-based-grid-sdk": "git+https://github.com/yugao-gaos/GAOS-SDK.git#v0.25.0"
  }
}
```

## Naming compatibility

The public project name is **Game-Agent Open Standard (GAOS)**. The canonical
repository is `yugao-gaos/GAOS-SDK`, the npm package is
`@yugao-gaos/gaos-sdk`, and
the Python distribution is `gaos-sdk`.

Releases through v0.25.0 used the npm name
`@yugao-gaos/turn-based-grid-sdk` and Python distribution
`gaos-turn-based-grid-sdk`. Those archives and Git tags remain valid. The
coordinated GAOS rename is intentionally breaking: current consumers must
update the package dependency, use the Python import `gaos_sdk`, and send the
`gaos.ticks` protocol identifier. TypeScript entry points and CLI commands
remain unchanged.

The `./engine` entry point remains a genre-neutral game-mechanism suite for
deterministic card, tactics, simulation, and hybrid games; spatial grids are
one optional mechanism. Neutral names such as `TickReducer`, `solveLevel`, and
`recheckTranscript` remain canonical.

## Runtime support

- TypeScript output targets ES2022 and uses ESM package entry points.
- Hosted clients and keyed drivers require a runtime with `fetch`.
- The `./agent-cli` entry point is Node-only because it launches subprocesses.
- Python requires version 3.10 or newer and has no runtime dependencies.

## Getting help

Use [GitHub Issues](https://github.com/yugao-gaos/GAOS-SDK/issues)
for reproducible bugs and focused feature requests. Include the SDK version,
runtime version, minimal input or reducer, expected result, and actual result.

For questions, implementation ideas, and community discussion, [join the GAOS
Discord community](https://discord.gg/vdvUgcqPU).

Do not report suspected vulnerabilities in a public issue. Follow the private
instructions in the repository's
[security policy](https://github.com/yugao-gaos/GAOS-SDK/security/policy).

## Scope of support

The SDK project can support reusable mechanics, protocol compatibility, agent
infrastructure, and the published clients. Product content and hosting policy
remain the responsibility of the product that integrates the SDK.
