---
layout: home

hero:
  name: Gaming AGI Open SDK
  text: One game core. Human play, agent evaluation, third-party proof.
  tagline: Agent evaluation results are self-published, and re-running one to check it costs the full inference bill—and still returns a different sample, not that run. GAOS keeps producing a result expensive and makes checking it nearly free.
  actions:
    - theme: brand
      text: Build a game
      link: /quickstart
    - theme: alt
      text: Build an evaluation
      link: /agentic-play
    - theme: alt
      text: Verify a run
      link: /trust-and-verification

features:
  - title: One deterministic core
    details: The same reducer powers human clients, agent environments, authoritative sessions, solvers, and replay—without a second rules engine.
    link: /architecture
    linkText: See the architecture
  - title: Third-party-verifiable runs
    details: Signed replay evidence combines deterministic re-simulation, Ed25519 seat chains, and independently reconstructed actions. Verification is offline.
    link: /trust-and-verification
    linkText: See what is proven
  - title: Sessions ready for production
    details: Prepared persistence, idempotency, prediction, reconnect repair, hidden-information views, signed interest scopes, and adaptive observation delivery.
    link: /session-and-integrity
    linkText: Explore sessions

---

<div class="release-proof" aria-label="GAOS v0.20 release facts">
  <span><strong>v0.20</strong> signed portable evidence</span>
  <span><strong>TypeScript + Python</strong></span>
  <span><strong>No verification service required</strong></span>
</div>

## Why verification, not trust

A leaderboard entry is a claim made by the party that benefits from it, and a
reader has two options today. **Trust it** — no verification at all. Or
**reproduce it** — re-run the evaluation at full inference cost and still not
get *that* run back, because the model is stochastic and the harness has moved
on. What you get is a different sample, not a check.

So verification is either free and worthless, or expensive and inconclusive.
Most published agent results are unverifiable in practice: not because anyone
is dishonest, but because checking costs more than any reader will spend.

**GAOS inverts that cost.** A run is recorded as a deterministic transcript
with every input signed by the seat that produced it. Verifying replays those
recorded inputs through a pinned reducer — **it never re-runs the agent.** No
model calls, no inference spend, no stochasticity. Checking costs milliseconds
of local CPU, works offline, needs no cooperation from whoever published the
result, and checks *that exact run* rather than a fresh sample of roughly
similar behaviour.

What a `trusted` verdict does **not** claim: that a key belongs to a
real-world identity, that an artifact was published rather than withheld, that
wall-clock timing was fair, or that the agent would play this way again —
replay verifies **this run**, not the policy behind it.
[Read the exact boundary →](/trust-and-verification)

## Built for two teams

<p class="home-section-intro">GAOS connects game development and agent
evaluation without asking either team to give up ownership of its product.</p>

<div class="audience-grid">
  <section class="audience-card audience-card--games">
    <span class="audience-kicker">For game developers</span>
    <h3>Ship a game now. Stay agent-ready.</h3>
    <p>Write and test your rules once. Use the same reducer for the renderer,
    authoritative host, bots, tournaments, and replay. Compose board, card,
    movement, visibility, scoring, settlement, and multiplayer mechanisms
    without surrendering your world or presentation.</p>
    <p><strong>You own:</strong> content, tuning, art, hosting, modes, and
    commercial policy.</p>
    <a class="audience-cta" href="./quickstart">Build your first game →</a>
  </section>

  <section class="audience-card audience-card--evaluation">
    <span class="audience-kicker">For benchmark & evaluation teams</span>
    <h3>Turn interactive play into defensible evidence.</h3>
    <p>Expose concrete legal actions to model or CLI agents, run single- or
    multi-agent episodes, and publish signed portable artifacts. A third party
    can pin the historical adapter and reproduce both the computation and the
    authorship evidence offline.</p>
    <p><strong>You own:</strong> tasks, scoring meaning, held-out content,
    capability claims, and publication policy.</p>
    <a class="audience-cta" href="./agentic-play">Build an evaluation →</a>
  </section>
</div>

## From an action to independently checked evidence

<p class="home-section-intro">The host is not the trust boundary. GAOS makes
the run portable so another organization can check it with its own copy of the
game adapter.</p>

<div class="verification-flow" role="list">
  <div class="verification-step" role="listitem">
    <span>01</span>
    <strong>Play</strong>
    <p>A human or agent submits the same canonical game command.</p>
  </div>
  <div class="verification-arrow" aria-hidden="true">→</div>
  <div class="verification-step" role="listitem">
    <span>02</span>
    <strong>Record</strong>
    <p>The session binds reducer inputs, seat signatures, chains, and results.</p>
  </div>
  <div class="verification-arrow" aria-hidden="true">→</div>
  <div class="verification-step" role="listitem">
    <span>03</span>
    <strong>Verify offline</strong>
    <p>A pinned adapter returns <code>trusted</code>, <code>unverifiable</code>,
    or <code>rejected</code>.</p>
  </div>
</div>

```sh
gaos verify run.gaos-replay.jsonl --adapter ./historical-adapter.mjs
```

[Read the exact trust boundary →](/trust-and-verification)

## See one core power different games

GAOS includes playable reference games across match-3, blackjack, grid
strategy, card-grid roguelikes, graph RTS, and defense. Each uses the same
reducer, agent, replay, and verification contracts in a different game shape.

[Play the demo arcade →](/demos/)

[Browse every mechanism and supported game shape →](/capabilities)

## Built with GAOS

<div class="ownership-card zonoid-showcase">
  <div class="zonoid-showcase__copy">
    <h3><a href="https://zonoid.ai">Zonoid</a></h3>
    <p><strong>The first production game built with Gaming AGI Open SDK.</strong></p>
    <p>A strategy game for humans and AI agents, built around prediction,
    planning, and judgment.</p>
    <p><strong><a href="https://zonoid.ai">Visit Zonoid →</a></strong></p>
  </div>
  <div class="zonoid-showcase__video">
    <iframe
      src="https://www.youtube-nocookie.com/embed/gOUGajF9Vug"
      title="Zonoid Benchmark"
      loading="lazy"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
      referrerpolicy="strict-origin-when-cross-origin"
      allowfullscreen
    ></iframe>
  </div>
</div>

[How GAOS and Zonoid were built with GPT-5.6 Sol →](/building-with-gpt-5-6-sol)
