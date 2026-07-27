# Version history

GAOS uses the v0.x line to refine its contracts before v1.0. Products should
review the migration notes when updating across minor versions.

::: tip Current release: v0.25.0
RFC-016 adds product-owned historical verifier-kit preservation and restricted
execution to the portable evidence path.
:::

## v0.25.0: product-owned historical verifier kits

Released July 27, 2026 with the additive RFC-016 verifier distribution path.

- Deterministic canonical tar packing gives identical product inputs identical
  `sha256:` kit identities.
- Strict inspection rejects traversal, duplicate paths, non-regular entries,
  malformed archives, and file-integrity mismatches before extraction.
- Replay references keep untrusted mirrors separate from independently pinned
  kit authorization.
- Digest-keyed cache admission is atomic and rechecks integrity for offline use.
- A pinned-container runner disables networking, inherits no product
  environment, mounts only read-only inputs, and applies process, memory, CPU,
  wall-time, and output limits.
- TypeScript and Python inspect the same v1 manifest and reference contracts.

[Product-owned verifier kits →](/rfcs/rfc-016-product-owned-verifier-kits)

## v0.24.0: interoperability and verifiable benchmark publication

Released July 27, 2026 with the RFC-014 interoperability/dynamic-control
milestone and RFC-015 benchmark publication.

- Bounded parallel execution, interruption, and resume preserve the authored
  plan and deterministic aggregate.
- Reproducible `gaos.benchmark-bundle.v1` packaging and independent
  verification reject missing, duplicate, modified, or incompatible evidence
  and recompute every score.
- Manifest-pinned external authority facts remain separate from replay,
  reproduction, openness, model identity, and hidden-test facts.
- Qualified payoff, action-efficiency, and rating helpers enforce declared
  preconditions.
- The neutral leaderboard starter includes SQLite/PostgreSQL schemas, object
  storage and worker-queue boundaries, artifact download, and local verification.

[Verifiable benchmark publication →](/benchmark-publication)

## RFC-014 compatibility milestone

Incorporated into v0.24.0; no separate v0.23.0 artifact was released.

- A versioned executable host-conformance report covers the common lifecycle
  failures and repair/control transitions.
- Host and rendering-engine guides state the simulation and evidence authority
  boundary for every supported integration.
- TypeScript, C#, C++, and GDScript-compatible clients share schemas and one
  golden presentation fixture.
- `gaos.submission.ed25519.v2` binds commands to authenticated controller
  epochs, signed handoffs, checkpoint continuity, and offline verifier facts.
- Product-pinned external trust reports cryptographic, pin, expiry, revocation,
  and subject-binding facts without GAOS private-key custody.

[Interoperability and dynamic-control evidence →](/interoperability)

## v0.22.0: ecosystem and benchmark contracts

Released July 27, 2026 as the RFC-013 foundation release.

- Transport-neutral host and versioned presentation-frame contracts establish
  stable boundaries for hosts and rendering engines.
- `SeatControlLedger` records fixed logical seats, explicit vacancy,
  consecutive controller epochs, atomic swaps, stale-authority rejection, and
  checkpoint digest continuity without reinterpreting v1 signatures.
- Machine-readable descriptors, explicit chance, observer and policy
  contracts ship with legality, normalization, entropy, and win-rate checks.
- Benchmark manifest validation, deterministic episode planning, weighted
  aggregation, leaderboard entry types, and distinct trust claims keep
  benchmark mechanics separate from product-owned meaning.
- JSON Schemas and a golden presentation fixture begin cross-language
  conformance.

[Ecosystem bridges and benchmark contracts →](/ecosystem-bridges)

RFC-014 and RFC-015 build additively on these foundations in v0.24.

## v0.21.0: durable long-running sessions

Released July 26, 2026 after the Arena and TabletopLabs v0.20 migrations
identified the remaining authoritative-session gaps.

- Canonical integrity-checked checkpoints capture reducer state and the full
  live protocol surface; restore accepts only a contiguous durable event tail.
- Explicitly confirmed compaction bounds in-memory history while preserving
  permanent submission identity through a host history index. Old reconnect
  watermarks return `resync_required`.
- `PredictionSession` implements deterministic optimistic reconciliation, and
  `./session-host` supplies a serialized persist-before-publish lane,
  publication retry, and event-store conformance tests.
- `nextDeadline()` exposes tick-window scheduling; declared seats remain
  immutable while occupancy and spectators stay product/host state.
- Cursor precedence and reducer rejection typing complete RFC-011 A1/A2.
- `SessionView.status` adds `ended`; `gaos.replay` v1.3 exports it with
  `stars: null`, while v1.0/v1.1/v1.2 remain compatible.
- Participation diagnostics now name both declared and supplied seat sets.

[Sessions and integrity →](/session-and-integrity) ·
[Portable replay →](/mechanisms/replay)

## v0.20.0: signed portable evidence

Released July 26, 2026 after Arena and TabletopLabs returned their v0.19
integration findings. v0.20 makes the resulting signed artifacts fully
third-party verifiable with a pinned historical adapter and no GAOS service,
providing the evidence layer for Game-as-a-Benchmark products.

- `gaos.replay` v1.2 validates and verifies
  `gaos.submission.ed25519.v1`, with canonical command/cursor/time material for
  chained submissions, order-independent roster hashing, roster-bound chain
  genesis, and per-seat `signingTier.N`.
- Commit/reveal and rejected reveal submissions require tier-1 signatures.
  High-rate submissions can be covered by periodic signed chain heads recorded
  in the durable `seat-signature` lane.
- TypeScript and zero-dependency Python share RFC 8032 checks, deterministic
  signing, three complete framed vectors, and independent chain verification.
- Replay facts remain separate: `ok` is computation consistency,
  `signatures.state` is `signed` / `partial` / `unsigned`, and `verdict` is
  `trusted` / `unverifiable` / `rejected`.
- `semantics` independently reports signed command and timeout action
  reconstruction. Tick-bounded policies fix timeout position at
  `windowRef + windowTicks`; wall-clock earliness is not claimed.
- Offline `gaos verify` and `gaos-verify` commands compose signature facts with
  a pinned product adapter. No GAOS service, account, or network is involved.
- The session hot path reuses canonical seat-view bytes and one cloned delta
  graph, removing the pre-pin serialization duplication without changing the
  wire contract.
- Tier-2-signed `(seat, scopeId)` interest declarations narrow partitioned
  views without widening visibility, survive replay, and emit independently
  reconstructible delivery streams.
- Observation codec v2 is the only v0.20 delivery codec. It uses bounded safe
  JSON patches with snapshot fallback; adaptive delivery backs off after an
  uneconomic probe with an exponential per-scope circuit breaker, while
  `patchStrategy: 'never'` keeps v2 snapshots and skips diff CPU entirely.
  Derived observation caches use copy-on-write ownership without weakening
  public snapshot isolation. Clients migrate from snapshot-only v1 through
  `applyObservationDelta`. Repair origins, opaque product action payloads,
  pre-ingest legality, typed view failures, play-all-level runs, and host
  recovery helpers incorporate the two product migrations' findings.
- `SessionView` separates generic lifecycle observations from the
  action/grid-shaped `TickView`; non-HUD reducers report deterministic replay
  counters through `replayMetrics`, while existing reducers remain unchanged.
- Arena chooser and dialogue navigation is classified as host/UI state.
  Confirmed choices become normal SDK actions, so no seat-local state-changing
  kernel transition or revision exception is introduced.

[Trust and verification →](/trust-and-verification) ·
[Portable replay →](/mechanisms/replay)

## v0.19.0: authoritative sessions and integrity

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
  `timeoutPolicy`, and `seat-signature`. Session construction requires an
  explicit UTC-epoch clock provider or `'none'`; event `hostTime` is advisory
  and optional, and portable projection is opt-in.
- Migration: the final API/wire name is `timeout`, not `deadline`, and
  `finalizeRunReplay` source transcripts must use `seedPolicy: 'explicit'`.
  Hosts must also add the explicit `hostTime` policy; timestamp-free
  persisted events remain valid.

[Sessions and integrity →](/session-and-integrity) ·
[Portable replay →](/mechanisms/replay)

## v0.18.0: one coherent tick model

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

## v0.17.0: portable benchmark replays

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
  spanning card, puzzle, tactics, simulation, and hybrid games, with grids as
  one optional mechanism.
- Six playable browser demos cover card, puzzle, hex, graph, hybrid, and
  real-time scheduled game loops.

[Portable replay specification →](/mechanisms/replay)

## Composable game mechanisms

### v0.16.0: portals and multi-agent play

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

### v0.15.0: zones and card composition

Prepared July 23, 2026.

- Ordered, bag, and sparse slotted zones with atomic transfers.
- Seeded shuffle, draw, round-robin dealing, and batch dealing.
- Keyword layers, response priority, declarative targets, durations, phase
  hooks, and deck/squad validation.
- Priority resource claims for contested draft picks and capacity.

[Zones and card play →](/mechanisms/zones-and-card-play)

### v0.14.0: information partitions

Prepared July 23, 2026.

- Deterministic `viewFor(state, seat)` observations.
- Independent identity and order visibility for zones.
- Fog-of-war, entity shells, leak assertions, revelations, teams, spectators,
  and ranked multi-seat outcomes.
- Turn order, participation descriptors, pattern matching, sparse tick
  transcripts, rollback resimulation, and state digests.

[Information partitions →](/mechanisms/information-partitions) ·
[Ticks and lockstep →](/mechanisms/ticks-and-lockstep)

### v0.13.0: neutral core and layouts

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
