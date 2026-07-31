# Game-Agent Open Standard (GAOS)

**Build games that become verifiable benchmarks.**

The GAOS SDK implements the open Game-Agent Open Standard for
**Game-as-a-Benchmark**: one deterministic game contract for human play, agent
evaluation, authoritative sessions, and independent verification of exact
runs.

[Documentation](https://yugao-gaos.github.io/GAOS-SDK/) ·
[Playable demos](https://yugao-gaos.github.io/GAOS-SDK/demos/) ·
[v0.26 release notes](docs/releases.md#v0260) ·
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
npm install 'git+https://github.com/yugao-gaos/GAOS-SDK.git#v0.26.0'
```

Use the narrowest package surface:

- package root or `./client` — product-neutral hosted sessions, attach/finalize,
  and unified session handles
- `./engine` — mechanisms, reducers, agents, solvers, and replay
- `./session` — authoritative transitions and evidence capture
- `./protocol` — product-neutral tick envelopes
- `./control` — behavior-tree, human-input, and agent-input control sources
- `./agent` and `./agent-cli` — the common session runner, model drivers, and
  MCP-capable CLIs
- Python — hosted evaluation and replay exchange

[Build your first reducer →](docs/quickstart.md)

## The v0.26 standard boundary

v0.26 completes the coordinated GAOS rename and makes the SDK boundary
product-neutral. TypeScript and Python now expose generic hosted-session
clients over `gaos.ticks` v1. Product-specific observations, matchmaking,
convenience endpoints, and environment adapters live with the product that
defines them.

The canonical packages are `@yugao-gaos/gaos-sdk` and `gaos-sdk`; Python code
imports `gaos_sdk`. Zonoid's Arena adapter now lives in the Zonoid repository
instead of this SDK.

[Read the v0.26 migration guide →](docs/releases.md#v0260)

## The verifiable arm

A replay is independently checkable only while its historical reducer and
semantic adapter remain available and their identity is trusted outside the
replay.

Products can package that code as a content-addressed verifier kit:

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
