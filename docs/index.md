---
layout: home

hero:
  name: Gaming AGI Open SDK
  text: Game-as-a-Benchmark infrastructure with verifiable exact runs.
  tagline: Build one deterministic game for people and agents. Export portable evidence so independent verifiers can check what happened without re-running the model.
  actions:
    - theme: brand
      text: Build a game
      link: /quickstart
    - theme: alt
      text: Build a benchmark
      link: /agentic-play
    - theme: alt
      text: Verify a run
      link: /trust-and-verification

features:
  - title: One product reducer
    details: The product supplies one deterministic reducer for human play, agents, sessions, solvers, and replay.
    link: /architecture
    linkText: See the boundary
  - title: Verifiable exact runs
    details: Signed portable evidence lets an independent verifier re-simulate the recorded run without repeating model inference.
    link: /trust-and-verification
    linkText: See what is proven
  - title: Reusable game infrastructure
    details: Compose mechanisms, agent environments, authoritative sessions, and benchmark publication without giving up product ownership.
    link: /capabilities
    linkText: Explore capabilities

---

<div class="release-proof" aria-label="GAOS v0.25 release facts">
  <span><strong>Game-as-a-Benchmark</strong></span>
  <span><strong>v0.25</strong> product-owned verifier kits</span>
  <span><strong>TypeScript + Python</strong></span>
</div>

## One SDK, two audiences

<div class="audience-grid">
  <section class="audience-card audience-card--games">
    <span class="audience-kicker">For game developers</span>
    <h3>Build for people. Stay agent-ready.</h3>
    <p>Use reusable deterministic mechanisms and one product reducer for the
    renderer, authoritative host, agents, tournaments, and replay.</p>
    <p><strong>You own:</strong> rules content, world, presentation, hosting,
    modes, and commercial policy.</p>
    <a class="audience-cta" href="./quickstart">Build your first game →</a>
  </section>

  <section class="audience-card audience-card--evaluation">
    <span class="audience-kicker">For benchmark builders</span>
    <h3>Turn play into defensible evidence.</h3>
    <p>Give agents structured observations and legal actions, then publish the
    score with portable evidence of the exact run.</p>
    <p><strong>You own:</strong> tasks, scoring meaning, held-out content,
    capability claims, and adoption policy.</p>
    <a class="audience-cta" href="./agentic-play">Build a benchmark →</a>
  </section>
</div>

## The verifiable arm

Producing an agent result can be expensive. Checking it should not require
re-running the model and producing a different stochastic sample.

GAOS records canonical reducer inputs, results, signatures, and chains. An
independent verifier can re-simulate that exact run with the matching
historical reducer and semantic adapter.

```text
play → signed portable evidence → historical verifier → verdict
```

The replay alone is not enough. The product must preserve and publish the
matching verifier code, while an independently obtained manifest, catalog, or
allowlist authorizes its digest.

The verifier may receive a pinned adapter explicitly. v0.25 also supports
product-owned, content-addressed verifier kits with SDK tooling for packing,
inspection, resolution, caching, and restricted execution.

[Read the verification boundary →](/trust-and-verification)

## Game-as-a-Benchmark

A Game-as-a-Benchmark product is a playable, versioned environment in which
people and agents reach the same authoritative rules. Scores summarize
performance; portable evidence preserves how each result was produced.

GAOS supplies the shared technical layer. It does not decide what the game
means, what capability a task measures, or whether a result should be adopted.

[Read the thesis →](/mission) ·
[Explore the mechanisms →](/mechanisms/) ·
[Play the demos →](/demos/)

## Built with GAOS

[Zonoid](https://zonoid.ai) is the first production game and live reference: a
strategy game for humans and AI agents built around prediction, planning, and
judgment.
