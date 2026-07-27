# Gaming AGI Open SDK (GAOS)

**The open-source Game-as-a-Benchmark SDK. Build deterministic games, evaluate
agents, and let any third party verify the result.**

[Documentation](https://yugao-gaos.github.io/GAOS-TurnBasedGrid-SDK/) ·
[Playable demos](https://yugao-gaos.github.io/GAOS-TurnBasedGrid-SDK/demos/) ·
[v0.20 release notes](docs/releases.md) ·
[Discord](https://discord.gg/vdvUgcqPU)

GAOS is an open-source TypeScript and Python SDK for **Game-as-a-Benchmark**:
games that humans and agents can both play across turn-based, simultaneous
WEGO, and fixed-tick real-time systems. One reducer drives the game, the agent
environment, the authoritative session, and deterministic replay. Signed runs
can be checked offline by anyone with the pinned game adapter, without trusting
the host or a GAOS-operated service.

**The problem it solves:** agent evaluation results are self-published, and
checking one today means re-running the whole evaluation at the full inference
cost of the original. Even then, you have a different sample rather than that
run. GAOS keeps producing a result expensive and makes validation nearly free.
[Why verification, not trust →](#why-verification-not-trust)

## What is Game-as-a-Benchmark?

**Game-as-a-Benchmark** turns a playable game into a versioned evaluation
environment. Humans and agents face the same rules and canonical actions;
every scored run can carry portable evidence of exactly what happened. It is
not a static test set or a claim that every game score measures general
intelligence. The benchmark operator still owns the tasks, scoring meaning,
held-out content, and capability claims.

## The three reasons to use GAOS

### 1. One deterministic core

Write the rules once. The same reducer powers human clients, model and CLI
agents, solvers, tournaments, authoritative multiplayer, and replay. Hidden
information stays seat-scoped; action order, randomness, and scoring remain
reproducible.

### 2. Third-party-verifiable runs

Portable `gaos.replay` v1.2 evidence combines deterministic re-simulation,
Ed25519 seat signatures, roster-bound hash chains, and independent command and
timeout reconstruction. The offline verifier returns an explicit verdict:
`trusted`, `unverifiable`, or `rejected`.

```sh
gaos verify run.gaos-replay.jsonl --adapter ./historical-adapter.mjs
gaos-verify run.gaos-replay.jsonl --adapter ./historical_adapter.py
```

### 3. Production session infrastructure

Use prepared commit/abort transitions, idempotent submissions, authoritative
ticks, prediction reconciliation, reconnect snapshots, signed interest scopes,
and adaptive observation delivery. GAOS supplies the hard multiplayer and
evidence plumbing while your product keeps its world, presentation, hosting,
and commercial policy.

## Built for two teams

| Game developers | Game-as-a-Benchmark teams |
|---|---|
| Ship human play today without creating a second rules engine for bots tomorrow. Use reusable board, card, zone, movement, visibility, scoring, settlement, and session mechanisms. | Turn interactive games into reproducible single- or multi-agent evaluations. Use structured legal actions, provider-neutral drivers, portable transcripts, signed evidence, and offline verification. |
| [Build your first game →](docs/quickstart.md) | [Build an agent evaluation →](docs/agentic-play.md) |

## Where GAOS fits

GAOS is **open verification infrastructure for Game-as-a-Benchmark
evaluations**. It is the deterministic execution and evidence layer beneath a
game, benchmark, or tournament, not a replacement for the rest of the stack.

Use GAOS alongside:

- a renderer, game engine, scheduler, sockets or WebRTC transport,
  interpolation, and latency policy;
- an evaluation orchestrator, RL training loop, or multi-agent environment
  API; and
- your own tasks, scoring meaning, held-out content, hosting, analytics, and
  publication policy.

Choose GAOS when the exact interactive run must remain independently checkable,
the same rules must serve humans and agents, or multiplayer outcomes must be
reconstructed from canonical signed inputs. If you only need rendering,
network transport, model orchestration, or experiment tracking, use the tool
that specializes in that layer and integrate GAOS where deterministic evidence
begins.

## Why verification, not trust

Agent evaluation results are self-published. A leaderboard entry is a claim
made by the party that benefits from it, and a reader has two options today:

- **Trust it.** No verification at all.
- **Reproduce it.** Re-run the evaluation at full inference cost. You still do
  not get *that* run back because the model is stochastic and the harness has
  moved on. What you get is a different sample, not a check.

So verification is either free and worthless, or expensive and inconclusive.
Most published agent results are unverifiable in practice: not because anyone
is dishonest, but because checking costs more than any reader will spend.

**GAOS inverts that cost.** A run is recorded as a deterministic transcript
with every input signed by the seat that produced it. Verification replays
those recorded inputs through a pinned reducer; **it never re-runs the
agent.** No model calls, no inference spend, no stochasticity. Checking a claim costs
milliseconds of local CPU, and it checks *that exact run* rather than a fresh
sample of roughly similar behaviour.

Producing a result stays expensive. Checking one becomes nearly free, works
offline, and needs no cooperation from whoever published it.

### What a `trusted` verdict proves

A scoring authority pins the historical reducer and pure command adapter named
by the artifact, then checks the run locally:

- the recorded inputs reproduce the recorded game result;
- the declared seat keys authored the signed submission chains;
- chain order, periodic signing tiers, and roster binding are intact; and
- signed commands and timeout inputs independently map to the recorded actions.

### What it does not prove

Not that a key belongs to a real-world identity, that an artifact was published
rather than withheld, or that wall-clock timing was fair. It also does not prove
that the agent would play this way again. Replay verifies **this run**, not the
policy that produced it. Those remain product and scoring-authority policy. See
[Trust and verification](docs/trust-and-verification.md) for the exact boundary.

## Start building

```sh
npm install 'git+https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK.git#v0.20.0'
```

Choose the path that matches your project:

- [Quickstart and authenticated package-registry install](docs/quickstart.md)
- [Complete capability map](docs/capabilities.md)
- [Reusable mechanism reference](docs/mechanisms/index.md)
- [Authoritative sessions and integrity](docs/session-and-integrity.md)
- [Fixed-tick real-time games](docs/high-frequency.md)
- [Portable replay and verification](docs/mechanisms/replay.md)
- [Architecture and ownership boundaries](docs/architecture.md)

## Built with GAOS

[Zonoid](https://zonoid.ai) is the first production game and live reference: a
strategy game for humans and AI agents built around prediction, planning, and
judgment.

GAOS was extracted and published as a standalone SDK during OpenAI Build Week
2026. The [GPT-5.6 Sol case study](docs/building-with-gpt-5-6-sol.md) records
the design, implementation, review, and agent-play workflow. Submission
materials remain available in [DEVPOST.md](DEVPOST.md).

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm run docs:build

cd python
PYTHONPATH=. python3 -m pytest tests
python3 -m build
```

Live integration tests use `ARENA_BASE_URL` and skip automatically when a
compatible API host is unavailable. See [CONTRIBUTING.md](CONTRIBUTING.md) and
[SECURITY.md](SECURITY.md).

## License

Licensed under the [Apache License 2.0](LICENSE).
