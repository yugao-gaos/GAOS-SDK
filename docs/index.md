---
layout: home

hero:
  name: Gaming AGI Open SDK
  tagline: A deterministic game SDK for benchmarks where humans and AI agents play by the same rules.
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

features:
  - title: Deterministic by construction
    details: Resolve turn order, hidden information, zones, portals, movement, consequence cascades, lockstep inputs, and scoring with replayable outcomes.
  - title: AI-native, not AI-attached
    details: Expose concrete legal actions, deterministic seeds, transcripts, batch evaluation, model drivers, and MCP-capable CLI launchers from one environment contract.
  - title: Product-neutral mechanisms
    details: The SDK owns how reusable mechanics behave. Your product retains characters, levels, objectives, tuning, authentication, and presentation.
---

<div class="hero-video">
  <iframe
    src="https://www.youtube-nocookie.com/embed/gOUGajF9Vug"
    title="GAOS visual preview"
    loading="lazy"
    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
    referrerpolicy="strict-origin-when-cross-origin"
    allowfullscreen
  ></iframe>
</div>

**Deterministic game mechanisms and multiplayer infrastructure for agent-ready
games.**

## Our mission

**Make interactive games a shared, inspectable proving ground for human and
machine intelligence—where both act through the same rules, face the same
consequences, and can be compared through reproducible play rather than
persuasive outputs alone.**

Games measure behavior across a sequence of consequential choices. Structured
boards, graphs, zones, actions, and seeded state keep that behavior inspectable
without requiring one genre or representation. Simultaneous turns remove
reaction speed and request order as accidental advantages while testing
prediction, coordination, and adaptation between actors.

[Why games—and why simultaneous turn-based play—make strong benchmarks →](/mission)

[See every supported game shape and mechanism family →](/capabilities)

[Join the GAOS Discord community →](https://discord.gg/vdvUgcqPU)

## One reducer, every way to play

The same injected deterministic reducer can power local play, hosted sessions,
solvers, replay checks, model agents, CLI agents, and evaluation runs. There is
no second, approximate implementation just for automation.

```text
Product reducer + authored content
              |
              v
   GAOS deterministic engine
       /       |        \
  renderer   solver   AgentEnvironment
                         |
                 tools / drivers / CLIs
```

## One agent turn

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
    <p>Canonical tick inputs, sparse transcripts, resimulation, state digests, frame skip, and authoritative hidden-information deployment.</p>
  </a>
  <a class="mechanism-card" href="./agentic-play">
    <span class="mechanism-kicker">Model vs. model</span>
    <h3>Multi-agent episodes</h3>
    <p>Seat-redacted policies, simultaneous atomic batches, legal default waits, per-seat rewards, and one shared verifiable transcript.</p>
  </a>
</div>

[See the complete version history →](/version-history)

## Built with GAOS

<div class="ownership-card">
  <h3><a href="https://zonoid.ai">Zonoid</a></h3>
  <p><strong>The first production game built with Gaming AGI Open SDK.</strong></p>
  <p>Zonoid is a strategy game for humans and AI agents, built around prediction, planning, and judgment.</p>
  <p>GAOS provides the reusable toolkit; Zonoid's product content stays separate from the SDK.</p>
  <p><strong><a href="https://zonoid.ai">Visit Zonoid →</a></strong></p>
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
