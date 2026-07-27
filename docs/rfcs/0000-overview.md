# GAOS SDK — RFC sequence and release roadmap

Status: implemented through v0.25 ·
Target: v0.13 → v1.0 arc · Baseline: v0.12.0 export surface

::: info Design record and roadmap
RFC-001 through RFC-013 record the design path that led to the current SDK.
RFC-014 and RFC-015 are shipped in v0.24. RFC-016 ships in v0.25. For
supported APIs and current terminology, use the
[architecture map](/architecture), [capability map](/capabilities), and
[mechanism reference](/mechanisms/).
:::

## Goal

Evolve the SDK from a turn-based **grid** engine into a composable **game
mechanism SDK** in which every mechanism family is optional and composable:

- grid-only games (today's shape) keep working unchanged;
- card-only games use zones, keywords, and priority windows with no spatial
  imports;
- hybrid games combine boards and zones freely, connected by portals.

Two standing design rules govern every RFC in this batch:

1. **The SDK owns how a mechanism behaves; the product owns which content uses
   it, where it is enabled, and with what values.** (Unchanged from
   `docs/engine.md`.)
2. **Every new mechanism must serve grid play too.** Hidden information doubles
   as fog-of-war; targeting unifies cells and cards; durations buff grid units;
   deck validation validates squads.

## RFC sequence

| RFC | Title | Ships in | Depends on |
|---|---|---|---|
| [001](rfc-001-neutral-core.md) | Neutral core: genre-free names for the reducer, solver, and replay contracts | v0.13–v0.14 | — |
| [002](rfc-002-locations-and-layouts.md) | Locations and layouts: `LocationRef`, `BoardLayout` (square/hex/graph), multi-board | v0.13 | 001 |
| [003](rfc-003-information-partitions.md) | Information partitions: per-seat views, hidden zones, fog-of-war | v0.14 | 001, 002 |
| [004](rfc-004-zones-and-card-play.md) | Zones and card play: the zone primitive, deal/draft, keywords, priority, durations | v0.15 | 002, 003 |
| [005](rfc-005-portals.md) | Portals: entity transit across heterogeneous containers | v0.16 | 002, 004 |
| [006](rfc-006-session-kernel.md) | Authoritative session kernel with prepared persistence transitions | v0.19 | protocol, replay v1.1 |
| [007](rfc-007-deterministic-math.md) | Deterministic math classification and immutable `dmath` contexts | v0.19 | engine |
| [008](rfc-008-commitment-envelope.md) | Context-bound commit–reveal envelopes and replay audit evidence | v0.19 | 006, replay v1.1 |
| [009](rfc-009-release-sequencing-and-migration.md) | Release sequencing and migration gates | v0.19–v0.20 | 006, 008 |
| [010](rfc-010-submission-signatures-and-interest.md) | Submission signatures, audit chains, and generic interest management | v0.20 | 006, 008 |
| [011](rfc-011-arena-migration-findings.md) | Arena's open asks of the SDK | v0.21 | 006, 009, 010 |
| [012](rfc-012-post-migration-gaps.md) | SDK gaps after the TabletopLabs migration completed | v0.21 | 006, 009 |
| [013](rfc-013-ecosystem-bridges-and-benchmark-tooling.md) | Ecosystem and benchmark foundations | v0.22 | 006, 010, 012 |
| [014](rfc-014-interoperability-and-dynamic-control-evidence.md) | Interoperability and dynamic-control evidence | v0.24 (historical v0.23 target) | 006, 010, 012, 013 |
| [015](rfc-015-verifiable-benchmark-publication.md) | Verifiable benchmark execution and publication | v0.24 | 013, 014 |
| [016](rfc-016-product-owned-verifier-kits.md) | Product-owned historical verifier kits | v0.25 | 014, 015 |

Sequencing rationale: RFC-001/002 are contract-level and mostly mechanical —
they unblock naming and addressing for everything else. RFC-003 is the one
breaking-ish decision (per-seat views) and both hands and fog-of-war hang off
it, so it lands before any zone code. RFC-004 builds the card family on the
settled contracts. RFC-005 composes everything and ships last.

The ecosystem sequence is likewise dependency-driven. RFC-013 is the shipped
v0.22 contract foundation. RFC-014 makes those boundaries interoperable and
extends portable evidence to changing controllers as a historical v0.23
compatibility milestone. RFC-015 consumes that evidence in the resumable
benchmark runner, independent bundle verifier, and neutral publication
starter. Both RFC-014 and RFC-015 ship in the official v0.24 release.
RFC-016 preserves the ownership boundary while standardizing how products
explicitly export, content-address, distribute, authorize, cache, and
restrict execution of historical reducers and semantic adapters.

The [batch implementation review](implementation-review.md) maps every
normative requirement and test-plan fixture to its shipped API and evidence.

## Compatibility promise

- v0.13–v0.16 are **additive**. Every rename ships with a `@deprecated` alias
  re-exporting the old name; no consumer breaks.
- v1.0 removes the deprecated aliases and freezes the neutral core.
- Zonoid (the reference consumer) migrates during the v0.13/v0.14 window and
  serves as the live validation for each RFC, per the existing practice.

## Mission tie-in

Hidden-information games are a qualitatively different AI benchmark class than
perfect-information grid puzzles. RFC-003 + RFC-004 let the same
`AgentEnvironment`, drivers, and CLI launchers play card games and
fog-of-war grid games honestly (agents observe exactly what their seat may
see), which widens the game-as-benchmark surface the SDK exists to provide.

## First-consumer notes (TabletopLabs)

Not part of the SDK batch, recorded here so the RFCs stay product-neutral:

- TabletopLabs exposes selected engine functions to sandboxed creator scripts
  through its module-host frozen re-export pattern; the neutral names from
  RFC-001 are the ones creators will see.
- TabletopLabs' `EntityPrivacyStore` modes (public / hidden / shell /
  seat-scoped) map nearly one-to-one onto RFC-003 partitions.
- All SDK calls resolve synchronously within one ECS tick to stay
  rollback-safe; nothing in this batch introduces async mid-settlement.
- Its hex snap support (60°) is the presentation counterpart of
  `HexAxialLayout` in RFC-002.

## Cross-batch decisions

1. The existing package/repository name remains through the additive batch;
   reconsidering it is a v1.0 package-boundary decision.
2. `TurnView` uses defaulted `TGrid` and `TZones` generics with JSON-friendly
   optional namespaces.
3. Full multi-seat orchestration ships in v0.16 as
   `MultiAgentEnvironment`, layered on RFC-003 seat views and the existing
   participation model.
