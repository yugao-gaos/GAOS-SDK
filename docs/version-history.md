# Version history

GAOS uses the v0.x line to refine its contracts before v1.0. Products should
review the migration notes when updating across minor versions.

::: tip Latest release: v0.19.0
Authoritative sessions now share replayable grouped resolutions, deterministic
math, and commit–reveal integrity primitives.
:::

## v0.19.0 — authoritative sessions and integrity

Prepared July 25, 2026.

- New optional `./session` kernel with persist-before-publish prepared
  transitions, explicit commit/abort lifecycle, mutable-state isolation,
  durable partial-window intents, crash rehydration, and per-seat observation
  revisions with canonical applied-submission acknowledgements and routable
  rejection identities recoverable by durable transition watermark. Accepted
  submission IDs are permanently single-use.
- Multi-level `finalizeRunReplay` projection with derived level seeds, global
  action/record numbering, aggregate totals, and run-terminal validation.
- `gaos.replay` v1.1 grouped resolutions preserve one reducer call per
  authoritative resolution and add timeout, extension, and mismatch audit
  records. The parser continues to accept and reproduce v1.0 artifacts;
  TypeScript and Python share Unicode-code-point canonical key order,
  JavaScript-safe integers, and strict schema semantics.
- `dmath-1` contexts provide deterministic `sin`, `cos`, `atan2`, `clamp`,
  and `roundTo`, frozen for the first time by this release with a 512-bit
  independent oracle and Node/Chromium/Firefox/WebKit/workerd bit-vector CI.
- `gaos.commit.sha256.v1` provides byte-exact framing, canonical payload
  validation, synchronous SHA-256 replay verification, published complete
  preimage vectors, and explicit non-fatal replay diagnostics. The v1.1 audit
  lane is advisory host attestation; additive v1.2 signature/chain/roster
  fields are reserved for RFC-010 under `seatKeys`, `clientTime`,
  `timeoutPolicy`, and `seat-signature`. Session events add advisory
  `hostTime`; portable projection is opt-in.
- Migration: the final API/wire name is `timeout`, not `deadline`, and
  `finalizeRunReplay` source transcripts must use `seedPolicy: 'explicit'`.

[Sessions and integrity →](/session-and-integrity) ·
[Portable replay →](/mechanisms/replay)

## v0.18.0 — one coherent tick model

Released July 24, 2026.

- `TickReducer.advance(state, inputs)` defines one deterministic tick with
  zero, one, or many canonical inputs.
- Existing settlement resolution steps execute within that tick.
- Turn order and turn-scoped durations are product concerns and no longer
  ship as SDK mechanics.
- The wire protocol is tick-native: `agilabs.ticks`, `tickId`, `kind: "tick"`,
  and a `tick` observation.
- TypeScript and Python agent `step()` calls each advance exactly one tick.
  Products own decision cadence and action-holding policy.

## v0.17.0 — portable benchmark replays

Released July 24, 2026.

- SDK-owned `gaos.replay` v1 JSONL envelope for both single-level sessions and
  ordered multi-level runs.
- Explicit per-level seeds, pinned content/results, reducer adapter identity,
  aggregate totals, and level-indexed actions.
- Canonical serialization, strict parsing, transport validation, whole-run
  reducer recheck, and a creator-platform `results.replayFormat` integration
  constant.
- Packaged JSON Schema, cross-language golden fixture, and zero-dependency
  Python parsing, validation, and canonical serialization.
- Lossless adapter from the existing `TranscriptHeader`/`TranscriptAction`
  pair, allowing Arena and creator-platform results to share verifier tooling.
- Public documentation and capability map present GAOS as a general game SDK,
  with tabletop games as one supported family and grids as one optional
  mechanism.
- Six playable browser demos cover card, puzzle, hex, graph, hybrid, and
  real-time scheduled game loops.

[Portable replay specification →](/mechanisms/replay)

## Composable game mechanisms

### v0.16.0 — portals and multi-agent play

Prepared July 23, 2026.

- Atomic portal planning and commit across square, hex, and graph boards and
  ordered, bag, or slotted zones.
- Bounded multi-hop traversal, cycles, groups, footprints, transformations,
  destination capacity, and deterministic contention.
- Frame skipping for decision-point agents with transcript v1.2.
- Seat-redacted `MultiAgentEnvironment` episodes with canonical simultaneous
  batches and per-seat rewards.
- Authoritative hidden-information deployment guidance, including per-match
  server resolvers and optimistic P2P dispute verification.

[Portal reference →](/mechanisms/portals) ·
[Multi-agent reference →](/agentic-play) ·
[High-frequency turns →](/high-frequency)

### v0.15.0 — zones and card composition

Prepared July 23, 2026.

- Ordered, bag, and sparse slotted zones with atomic transfers.
- Seeded shuffle, draw, round-robin dealing, and batch dealing.
- Keyword layers, response priority, declarative targets, durations, phase
  hooks, and deck/squad validation.
- Priority resource claims for contested draft picks and capacity.

[Zones and card play →](/mechanisms/zones-and-card-play)

### v0.14.0 — information partitions

Prepared July 23, 2026.

- Deterministic `viewFor(state, seat)` observations.
- Independent identity and order visibility for zones.
- Fog-of-war, entity shells, leak assertions, revelations, teams, spectators,
  and ranked multi-seat outcomes.
- Turn order, participation descriptors, pattern matching, sparse tick
  transcripts, rollback resimulation, and state digests.

[Information partitions →](/mechanisms/information-partitions) ·
[Ticks and lockstep →](/mechanisms/ticks-and-lockstep)

### v0.13.0 — neutral core and layouts

Prepared July 23, 2026.

- Genre-neutral reducer, action, solver, and replay names.
- Deprecated v0.12 aliases retained with equivalent behavior.
- `LocationRef` addressing across multiple containers.
- Square, axial-hex, and directed-graph layouts with generic pathfinding,
  line-of-sight, fields, and keyed movement.

[Locations and layouts →](/mechanisms/locations-and-layouts) ·
[Migration table →](/releases#v0-12-to-v0-13-migration)

## Foundation releases

| Version | Date | Main addition |
|---|---|---|
| [v0.12.0](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.12.0) | 2026-07-22 | Runtime validation, integrity, retry lifecycle, and deterministic edge-case hardening |
| [v0.11.0](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.11.0) | 2026-07-22 | Atomic, product-defined resource transactions |
| [v0.10.0](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.10.0) | 2026-07-22 | Resumable agent interruption |
| [v0.9.2](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.9.2) | 2026-07-21 | Complete mechanism documentation, benchmark mission, and Build Week release packet |
| [v0.9.1](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.9.1) | 2026-07-21 | Nearest reachable qualified paths and the public VitePress site |
| [v0.9.0](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.9.0) | 2026-07-21 | Gates, latched triggers, policy-driven rays, and generic behavior trees |
| [v0.8.0](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.8.0) | 2026-07-21 | Chain reactions, projectiles, push chains, arrivals, claims, transport, and interlocks |
| [v0.7.0](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.7.0) | 2026-07-21 | Deterministic multi-wave settlement |
| [v0.6.0](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.6.0) | 2026-07-21 | Local Ollama-backed CLI agent support |
| [v0.5.1](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.5.1) | 2026-07-21 | Product and action-prompt composition |
| [v0.5.0](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.5.0) | 2026-07-21 | Extensible keyed-model drivers and the `gaos-agent` CLI |
| [v0.4.0](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.4.0) | 2026-07-21 | Deterministic agent environment, portable tools, and Python evaluation |
| [v0.3.0](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.3.0) | 2026-07-21 | Reusable geometry and pathfinding |
| [v0.2.0](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.2.0) | 2026-07-21 | Reusable engine core, generic solver, and replay verification |
| [v0.1.1](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.1.1) | 2026-07-21 | Build output for Git-based package installation |
| [v0.1.0](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.1.0) | 2026-07-21 | TypeScript and Python turn SDKs, protocol documentation, and release automation |

## Compatibility policy

- v0.13 through v0.17 are additive.
- Existing single-board and perfect-information reducers continue to work.
- The old `Grid*` core names remain deprecated aliases through v0.x.
- v1.0 removes those aliases and is the next intentional breaking boundary.

For migration details and maintainer publishing instructions, see
[Release process and migrations](/releases).
