---
layout: home

hero:
  name: Gaming AGI Open SDK
  text: Build games that become verifiable benchmarks.
  tagline: One deterministic game contract for human play, agent evaluation, and independent verification of exact runs.
  actions:
    - theme: brand
      text: Start building
      link: /quickstart
    - theme: alt
      text: Explore the demos
      link: /demos/
    - theme: alt
      text: Verify a run
      link: /trust-and-verification

features:
  - title: Build
    details: Compose deterministic game mechanisms around a product-owned reducer without giving up your world, rules, or presentation.
    link: /mechanisms/
    linkText: Explore mechanisms
  - title: Evaluate
    details: Give people and agents the same authoritative rules through rendered or structured interfaces.
    link: /agentic-play
    linkText: Connect an agent
  - title: Verify
    details: Publish signed exact-run evidence with the historical verifier needed for independent re-simulation.
    link: /trust-and-verification
    linkText: See what is proven

---

<div class="release-proof" aria-label="GAOS v0.25 release facts">
  <span><strong>Game-as-a-Benchmark</strong></span>
  <span><strong>v0.25</strong> verifier kits</span>
  <span><strong>TypeScript + Python</strong></span>
</div>

## Why Game-as-a-Benchmark

As agents and world models move from answering questions to acting over time,
evaluation needs environments where decisions change what happens next.
Games make planning, adaptation, memory, cooperation, and failure visible
inside a controlled world.

A Game-as-a-Benchmark product is both playable and measurable. People and
agents reach the same versioned rules; scores summarize performance; portable
evidence preserves how each result was produced.

[Read the thesis →](/mission)

## One SDK, two builders

<div class="audience-grid">
  <section class="audience-card audience-card--games">
    <span class="audience-kicker">For game developers</span>
    <h3>Build for people. Stay agent-ready.</h3>
    <p>Use one product reducer for the renderer, authoritative host, bots,
    tournaments, and replay. Compose reusable mechanisms without surrendering
    your rules, content, presentation, or commercial policy.</p>
    <a class="audience-cta" href="./quickstart">Build your first game →</a>
  </section>

  <section class="audience-card audience-card--evaluation">
    <span class="audience-kicker">For benchmark builders</span>
    <h3>Turn play into defensible evidence.</h3>
    <p>Expose structured observations and legal actions, evaluate single or
    multiple agents, and publish the result with evidence of the exact run.
    You retain task design, score meaning, held-out content, and claims.</p>
    <a class="audience-cta" href="./agentic-play">Build an evaluation →</a>
  </section>
</div>

## The verifiable arm

Reproducing an evaluation repeats its inference cost and produces a new
stochastic sample. It does not check the published run.

GAOS preserves canonical reducer inputs, results, signatures, and chains so an
independent verifier can re-simulate the exact recorded run:

```text
human or agent play
        ↓
signed portable evidence
        ↓
historical reducer + semantic adapter
        ↓
independent verification
```

v0.25 makes the historical verifier portable as a product-owned,
content-addressed kit. GAOS checks and executes the kit; the product preserves
and publishes it; an independent manifest, catalog, or allowlist authorizes its
digest. If required verifier material is unavailable, the result is
`unverifiable`—not silently trusted.

[Understand the verification boundary →](/trust-and-verification)

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

[See all games built with GAOS →](/built-with-gaos)

[Play the demos →](/demos/) ·
[See the architecture →](/architecture) ·
[Browse capabilities →](/capabilities)
