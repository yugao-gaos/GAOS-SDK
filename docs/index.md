---
layout: home

hero:
  name: Gaming AGI Open SDK
  tagline: Build once. Play as a human. Evaluate as an agent.
  actions:
    - theme: brand
      text: Start building
      link: /quickstart
    - theme: alt
      text: Explore the engine
      link: /mechanisms/
    - theme: alt
      text: What's new in v0.17
      link: /version-history

---

## Build the game and the agent surface together

GAOS gives researchers and game developers one deterministic core for human
play, agent play, and signed evidence anyone can verify.

<div class="ownership-grid">
  <div class="ownership-card">
    <h3>Researchers and benchmark creators</h3>
    <p>Start with deterministic mechanisms, unified agent actions, single- and multi-agent environments, model and CLI adapters, transcripts, and roster-bound portable replay verification.</p>
    <p>Your benchmark still owns its tasks, capability claims, scoring methodology, held-out content, analytics, and publication.</p>
  </div>
  <div class="ownership-card">
    <h3>Game developers</h3>
    <p>Build reusable, testable rules once. The same reducer can power a renderer today and agents, solvers, tournaments, or benchmark products later.</p>
    <p>Your game still owns its world, characters, levels, tuning, presentation, hosting, and commercial policy.</p>
  </div>
</div>

```text
Game or benchmark design
          |
          v
   One GAOS reducer
      /    |     \
 human   agents   replay
 client  + tools  verifier
```

[Start with the quickstart →](/quickstart)

[See every supported game shape and mechanism family →](/capabilities)

[Read the mission and benchmark thesis →](/mission)

[Choose TypeScript or Python →](/quickstart#choose-your-language)

[Join the GAOS Discord community →](https://discord.gg/vdvUgcqPU)

## One agent tick

| State | Legal actions | Agent chooses | Deterministic result |
|---|---|---|---|
| `position: 1`<br>`status: playing`<br>`actionsUsed: 1` | `{ id: 'advance' }`<br>`{ id: 'jump', index: 2 }` | `{ id: 'jump', index: 2 }` | `position: 3` → **won**<br>`reward: +3` · `totalReward: 3` · **3★** |

`AgentEnvironment` exposes the product state—or one seat's redacted view—and
concrete legal actions, validates the agent's choice, applies the injected
reducer at each recorded tick, and returns the result with transcript-ready
metrics.

## A composable game SDK

<div class="mechanism-grid">
  <a class="mechanism-card" href="./mechanisms/zones-and-card-play">
    <span class="mechanism-kicker">Collections</span>
    <h3>Zones and card play</h3>
    <p>Decks, hands, queues, bags, slot rows, atomic transfers, dealing, keyword layers, priority, targets, durations, and deck validation.</p>
  </a>
  <a class="mechanism-card" href="./mechanisms/portals">
    <span class="mechanism-kicker">Hybrid worlds</span>
    <h3>Portals</h3>
    <p>Move entities atomically across heterogeneous boards and zones with groups, capacity, transformations, cycles, and bounded multi-hop traversal.</p>
  </a>
  <a class="mechanism-card" href="./mechanisms/information-partitions">
    <span class="mechanism-kicker">Honest observations</span>
    <h3>Hidden information</h3>
    <p>Per-seat views, hidden hands, independent identity and order visibility, fog-of-war, teams, revelations, spectators, and leak checks.</p>
  </a>
  <a class="mechanism-card" href="./mechanisms/locations-and-layouts">
    <span class="mechanism-kicker">Spatial layouts</span>
    <h3>Layouts and locations</h3>
    <p>Stable cross-container addresses plus square, axial-hex, directed-graph, multi-board, pathfinding, line-of-sight, and keyed movement support.</p>
  </a>
  <a class="mechanism-card" href="./high-frequency">
    <span class="mechanism-kicker">Fast deterministic play</span>
    <h3>Lockstep and rollback</h3>
    <p>Canonical tick inputs, sparse transcripts, resimulation, state digests, and authoritative hidden-information deployment.</p>
  </a>
  <a class="mechanism-card" href="./agentic-play">
    <span class="mechanism-kicker">Model vs. model</span>
    <h3>Multi-agent episodes</h3>
    <p>Seat-redacted policies, simultaneous atomic batches, legal default waits, per-seat rewards, and one shared verifiable transcript.</p>
  </a>
</div>

[See the complete version history →](/version-history)

## Built with GAOS

<div class="ownership-card zonoid-showcase">
  <div class="zonoid-showcase__copy">
    <h3><a href="https://zonoid.ai">Zonoid</a></h3>
    <p><strong>The first production game built with Gaming AGI Open SDK.</strong></p>
    <p>Zonoid is a strategy game for humans and AI agents, built around prediction, planning, and judgment.</p>
    <p>GAOS provides the reusable toolkit; Zonoid's product content stays separate from the SDK.</p>
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

[How we built GAOS and Zonoid with GPT-5.6 Sol →](/building-with-gpt-5-6-sol)

## A deliberate ownership boundary

<div class="ownership-grid">
  <div class="ownership-card">
    <h3>SDK owns</h3>
    <p>Reusable algorithms, deterministic ordering, settlement, protocol primitives, replay, scoring behavior, agent lifecycle, and integration contracts.</p>
  </div>
  <div class="ownership-card">
    <h3>Your product owns</h3>
    <p>Characters, abilities, authored levels, game modes, objectives, thresholds, world tokens, prompts, hosting policy, seasons, and presentation.</p>
  </div>
</div>

The rule is simple: the SDK defines **how a reusable mechanism behaves**. The
product decides **where it is used and what it means**.

[Read the complete mechanism reference →](/mechanisms/)

[See the architecture map →](/architecture)

## Naming roadmap

The current repository and package identifiers retain the SDK's original
grid-oriented names for compatibility. A coordinated move to neutral names is
planned, but no replacement identifier is active yet.

[Read the compatibility-aware naming roadmap →](/roadmap)
