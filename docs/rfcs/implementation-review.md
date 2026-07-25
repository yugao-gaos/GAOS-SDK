# Next-version batch implementation review

Status: complete for the additive v0.13–v0.16 scope · Reviewed against the
updated 58,209-byte handoff bundle

::: info Historical design record
This review captures a completed implementation checkpoint. It is retained for
design provenance, not as the current API guide. Start with the
[architecture map](/architecture) or [mechanism reference](/mechanisms/).
Version 0.18 superseded its turn-order and frame-skip conclusions with the
single tick model.
:::

This review treats the five RFCs and Appendix A as one acceptance contract.
The implementation remains product-neutral and preserves every v0.12 rename
as a deprecated alias until the separately scheduled v1.0 boundary.

## Requirement-to-evidence matrix

| Requirement family | Shipped implementation | Verification evidence | Result |
|---|---|---|---|
| RFC-001 neutral contracts | `TurnReducer`, neutral actions/views, solver and replay names; deprecated `Grid*` aliases; participation and ranked outcomes | `test/next-version.test.ts`, `test/information.test.ts` | Complete |
| Sequential discipline | Immutable turn rotation, reversal, FIFO extras, skips, elimination, reorder, wrap-aware rounds; protocol participation adapter | `test/information.test.ts`, `test/protocol.test.ts` | Complete |
| RFC-002 addressing/layouts | Typed `LocationRef` keys; square, axial-hex, directed graph layouts; generic path/LOS/fields; keyed movement and footprints | `test/next-version.test.ts`, `test/requirements-coverage.test.ts` | Complete |
| RFC-002 integration fixtures | Cube-oracle hex properties, axial collisions, authored graph paths, generic networks/reactions, cross-board settlement and replay | `test/requirements-coverage.test.ts` | Complete |
| RFC-003 partitions | Independent identity/order visibility, conventional seat-view derivation, board fog/shells, leak assertion, revelations, teams and spectator policy | `test/information.test.ts`, `test/zones-card.test.ts`, `test/requirements-coverage.test.ts` | Complete |
| Seat-aware agents | Legal actions derived only from `viewFor`; redacted observation transcript replay from the authoritative seed | `test/information.test.ts`, `test/requirements-coverage.test.ts` | Complete |
| RFC-004 zones | Validated list/bag/slot configurations and presets; atomic plan/commit transfers; arrivals; seeded shuffle/draw; round-robin and batch deals | `test/zones-card.test.ts` | Complete |
| RFC-004 composition | Keyword layers, three-seat response priority and timeout passes, LIFO unwind, bounded target choices, durations, phases, structured deck validation | `test/zones-card.test.ts`, `test/agent-drivers.test.ts` | Complete |
| RFC-004 integration | Three-seat policy matrix, deck/hand/bag leak permutations, capacity failure, priority draft claims, open-hand solitaire solving, target replay | `test/zones-card.test.ts`, `test/requirements-coverage.test.ts` | Complete |
| RFC-005 portals | Authored/bidirectional edges, heterogeneous destination adapters, footprints, groups, multi-hop, cycle/pass bounds, claims contention, atomic transformation and arrival commit | `test/portals.test.ts` | Complete |
| RFC-005 integration | Hex → bag → graph chain, cycle, rider/mount failure, capacity-one all-fail/priority, ordering trace, visibility atomicity, transcript replay | `test/portals.test.ts` | Complete |
| Pattern accommodation | Deterministic maximal runs and authored motifs over arbitrary layouts | `test/information.test.ts` | Complete |
| High-frequency accommodation | Sparse tick actions, canonical tick/seat/action order, empty-tick replay, rollback resimulation, state digests, reducer performance guidance | `test/information.test.ts`, `docs/high-frequency.md` | Complete |
| Frame skip | Repeated or product-continuation actions, early illegal/terminal stop, every tick recorded, transcript v1.2 replay without double skipping | `test/multi-agent.test.ts` | Complete |
| Multi-agent follow-up | Per-seat redacted turns/legal actions, default wait, canonical atomic `applyIntents`, concurrent policies, per-seat rewards/outcomes, shared replayable transcript | `test/multi-agent.test.ts` | Complete |
| Cross-platform replay follow-up | SDK-owned self-identifying JSONL envelope, adapter/content versions, explicit per-level seeds, canonical serialization, strict parse, legacy transcript lift, whole-run recheck | `test/replay-format.test.ts`, `docs/mechanisms/replay.md` | Complete |
| Known-gaps register | Team-ranked outcomes, team visibility, revelation records, seat lifecycle/time/id/spectator/P2P security guidance | `test/information.test.ts`, mechanism and high-frequency documentation | Complete |

## Determinism and atomicity findings

- Every mechanism consumes stable product ids and explicit seeds; none mints
  random identity or reads wall-clock time.
- Zone and portal planning is mutation-free. Group/capacity failures do not
  partially apply, and arrival callbacks run only after a complete commit.
- Hidden zone order remains canonical in authoritative state but is never
  exposed through conventional seat views.
- Portal and simultaneous-intent arbitration use documented total ordering.
- Target enumeration reports truncation. Generic agents and the solver reject
  a partial target surface rather than silently treating it as complete.
- Replays preserve board, zone, seat, target, and tick addressing.
- `gaos.replay` preserves those reducer inputs inside one portable single- or
  multi-level evidence artifact that Arena and creator platforms can share.

## Compatibility and intentional boundaries

These are not implementation gaps:

- Deprecated v0.12 aliases remain available through v0.16 exactly as promised.
  Removing them belongs to the breaking v1.0 release.
- Product reducers own card meaning, legal actions, costs, effects, terrain,
  fog memory, portal activation, authoritative persistence, and serialization.
- Wager pools, negotiation, adversarial search, continuous physics, schedulers,
  realtime transport, NAT/signaling, and cryptographic hidden-information
  protocols remain explicitly out of SDK scope.
- Pure peer-to-peer lockstep cannot protect full hidden state from a modified
  peer. Optimistic P2P plus server replay provides deterministic integrity and
  dispute resolution, while competitive confidentiality requires an
  authoritative session resolver (for example, a per-match Durable Object)
  that sends only seat-redacted views.
- Solver search remains defined for open-information, discrete decision
  spaces. Products may provide snapshots around mutable high-frequency state.

## Final gap disposition

No unimplemented normative requirement remains in the current additive
v0.13–v0.16 batch. The only scheduled work beyond this batch is the explicit
v1.0 alias removal/package-boundary decision and future consumer-driven
features that the RFCs list as out of scope.
