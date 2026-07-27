# Gaming AGI Open SDK (GAOS)

**The open-source SDK for Game-as-a-Benchmark: build games for people and
agents, then publish exact-run evidence others can independently check.**

[Documentation](https://yugao-gaos.github.io/GAOS-TurnBasedGrid-SDK/) ·
[Playable demos](https://yugao-gaos.github.io/GAOS-TurnBasedGrid-SDK/demos/) ·
[v0.25 release notes](docs/releases.md#v0250) ·
[Discord](https://discord.gg/vdvUgcqPU)

GAOS connects two kinds of builders through one deterministic game contract:

| Game developers | Benchmark builders |
|---|---|
| Use reusable mechanisms for human play, agents, authoritative sessions, and replay without maintaining a second rules engine. | Turn interactive games into versioned evaluations with structured actions, signed run evidence, and offline verification. |

The product owns its reducer, semantic adapter, content, scoring meaning, and
publication policy. GAOS owns the reusable contracts and infrastructure around
them.

## Why GAOS

### One product reducer

The product supplies one deterministic `TickReducer`. Human clients, agent
environments, authoritative sessions, solvers, and replay checks consume the
same rules.

### Verifiable exact runs

GAOS records canonical inputs, results, seat signatures, and hash chains in a
portable `gaos.replay` artifact. Verification re-simulates that exact run; it
does not re-run the model or depend on a GAOS service.

A result is independently verifiable only when the matching historical reducer
and semantic adapter remain available and their identity is trusted outside the
replay. v0.25 supports both explicitly supplied pinned adapters and
product-owned, content-addressed verifier kits. GAOS standardizes packing,
resolution, caching, and restricted execution; the product or benchmark
authority still owns publication, retention, and digest authorization.

```sh
gaos verifier pack ./adapter.bundle.mjs \
  --game creator/demo@1.0.0 \
  --output creator-demo.gaos-verifier
gaos verifier inspect creator-demo.gaos-verifier
```

### Production-ready evidence plumbing

GAOS includes prepared persistence, idempotent submissions, deterministic
ticks, reconnect repair, hidden-information views, signed interest scopes, and
portable benchmark publication.

## What GAOS does not own

GAOS does not decide what a game means or what a benchmark measures. Products
retain their worlds, rules content, tasks, rewards, held-out evaluation,
capability claims, hosting, rendering, identity policy, and leaderboards.

## Start building

```sh
npm install 'git+https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK.git#v0.25.0'
```

- [Build your first reducer](docs/quickstart.md)
- [Understand the ownership boundary](docs/architecture.md)
- [Explore reusable mechanisms](docs/mechanisms/index.md)
- [Connect an agent](docs/agentic-play.md)
- [Understand verification](docs/trust-and-verification.md)
- [Read RFC-016 verifier kits](docs/rfcs/rfc-016-product-owned-verifier-kits.md)

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm run docs:build
```

Python checks and contribution guidance are in
[CONTRIBUTING.md](CONTRIBUTING.md). Licensed under the
[Apache License 2.0](LICENSE).
