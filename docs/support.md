# Support and compatibility

## Versioning

TypeScript and Python distributions share one semantic version. While the SDK
is below `1.0.0`, minor releases may include breaking API changes. Patch
releases are reserved for compatible fixes.

The generic `agilabs.ticks` v1 wire contract has its own compatibility promise:
breaking its envelope, cursor, retry, or simultaneous-intent behavior requires
a new protocol version. See [Tick protocol v1](/protocol-v1).

Version 0.18 establishes `agilabs.ticks` v1 as the canonical transport with
`kind: "tick"`, `tickId`, and `tick`. Changing those fields in place would
break deployed hosts and clients.

Pin an exact release for production and review the GitHub release notes before
upgrading:

```json
{
  "dependencies": {
    "@yugao-gaos/turn-based-grid-sdk": "git+https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK.git#v0.25.0"
  }
}
```

## Naming compatibility

The public project name is **Gaming AGI Open SDK (GAOS)**. The current
repository, npm package (`@yugao-gaos/turn-based-grid-sdk`), and Python
distribution (`gaos-turn-based-grid-sdk`) retain their original grid-oriented
identifiers throughout the v0.x line so existing installations, import maps,
release URLs, and automation do not break.

Those identifiers do not describe the current feature boundary. The `./engine`
entry point is a genre-neutral game-mechanism suite for deterministic card,
tactics, simulation, and hybrid games; spatial grids are one optional
mechanism. Neutral names such as `TickReducer`, `solveLevel`, and
`recheckTranscript` are canonical. The remaining deprecated grid-prefixed
action aliases are scheduled for the separate v1.0 boundary, where package
naming will also be reconsidered.

The project plans to migrate the repository and distributions to coordinated,
neutral names rather than rename one surface at a time. Current identifiers
remain authoritative until that compatibility plan is published. See the
[roadmap](/roadmap) for the intended migration scope.

## Runtime support

- TypeScript output targets ES2022 and uses ESM package entry points.
- Hosted clients and keyed drivers require a runtime with `fetch`.
- The `./agent-cli` entry point is Node-only because it launches subprocesses.
- Python requires version 3.10 or newer and has no runtime dependencies.

## Getting help

Use [GitHub Issues](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/issues)
for reproducible bugs and focused feature requests. Include the SDK version,
runtime version, minimal input or reducer, expected result, and actual result.

For questions, implementation ideas, and community discussion, [join the GAOS
Discord community](https://discord.gg/vdvUgcqPU).

Do not report suspected vulnerabilities in a public issue. Follow the private
instructions in the repository's
[security policy](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/security/policy).

## Scope of support

The SDK project can support reusable mechanics, protocol compatibility, agent
infrastructure, and the published clients. Product content and hosting policy
remain the responsibility of the product that integrates the SDK.
