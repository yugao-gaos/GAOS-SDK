# Gaming AGI Open SDK (GAOS)

**Build games that become verifiable benchmarks.**

GAOS is the open-source TypeScript and Python SDK for
**Game-as-a-Benchmark**: one deterministic game contract for human play, agent
evaluation, authoritative sessions, and independent verification of exact
runs.

[Documentation](https://yugao-gaos.github.io/GAOS-TurnBasedGrid-SDK/) ·
[Playable demos](https://yugao-gaos.github.io/GAOS-TurnBasedGrid-SDK/demos/) ·
[v0.25 release notes](docs/releases.md#v0250) ·
[Discord](https://discord.gg/vdvUgcqPU)

| For game developers | For benchmark builders |
|---|---|
| Compose deterministic mechanisms once, then use the same rules for people, agents, multiplayer, and replay. | Turn interactive play into versioned evaluation with structured actions and portable evidence of each result. |

## What GAOS provides

- **One product reducer.** Your `TickReducer` drives renderers, agent
  environments, authoritative sessions, solvers, and replay checks.
- **Agent-ready play.** Models and CLI agents receive structured observations
  and concrete legal actions instead of automating a UI.
- **Verifiable exact runs.** `gaos.replay` records canonical inputs, results,
  seat signatures, and hash chains. Verification re-simulates the recorded run
  without re-running the model or trusting the original host.
- **Reusable infrastructure.** Boards, graphs, zones, hidden information,
  deterministic settlement, sessions, reconnect evidence, and benchmark
  publication remain product-neutral.

The product owns its reducer, semantic adapter, content, scoring meaning,
hosting, and publication policy. GAOS standardizes the contracts and evidence
around them.

## Install

```sh
npm install 'git+https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK.git#v0.25.0'
```

Use the narrowest package surface:

- `./engine` — mechanisms, reducers, agents, solvers, and replay
- `./session` — authoritative transitions and evidence capture
- `./protocol` — product-neutral tick envelopes
- `./agent` and `./agent-cli` — model drivers and MCP-capable CLIs
- Python — hosted evaluation and replay exchange

[Build your first reducer →](docs/quickstart.md)

## The v0.25 verifiable arm

A replay is independently checkable only while its historical reducer and
semantic adapter remain available and their identity is trusted outside the
replay.

v0.25 lets products package that code as a content-addressed verifier kit:

```sh
gaos verifier pack ./adapter.bundle.mjs \
  --game creator/demo@1.0.0 \
  --adapter creator/demo-adapter@1.0.0 \
  --output creator-demo.gaos-verifier

gaos verifier inspect creator-demo.gaos-verifier
```

GAOS owns kit packing, inspection, integrity, resolution, caching, and
restricted execution. Products own export, publication, and retention. An
independently obtained manifest, catalog, or allowlist decides which digest to
trust.

[Understand the verification boundary →](docs/trust-and-verification.md)

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm run docs:build
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [LICENSE](LICENSE).
