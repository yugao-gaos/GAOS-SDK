# Release process and migrations

For the public chronological changelog, see the
[complete version history](/version-history).

## v0.25.0

RFC-016 adds product-owned historical verifier kits without changing
`gaos.replay` v1.0–v1.3 or the existing local adapter workflow.

- `gaos verifier pack`, `inspect`, and `fetch` provide explicit product export,
  read-only inspection, verified retrieval, and atomic offline caching.
- `gaos.verifier-kit.v1` uses canonical regular-file-only tar bytes and a
  whole-kit SHA-256 identity.
- `gaos.verifier-reference.v1` carries digest, size, media type, and untrusted
  mirror hints in the namespaced `gaos.verifier` replay extension.
- Resolver facts keep retrieval, integrity, independent authorization, and
  restricted execution separate.
- The reference container runner requires a digest-pinned image, disables
  networking, inherits no host environment, uses read-only mounts/root, and
  enforces resource bounds.
- TypeScript and Python validate and inspect the shared manifest and reference
  contracts.

## v0.24.0

Released July 27, 2026. This release includes the RFC-014 interoperability and
dynamic-control milestone and implements RFC-015: deterministic
bounded-parallel benchmark execution and resume, reproducible portable bundles,
independent replay/score verification, qualified research metrics, and a
neutral dual-database leaderboard starter.

### Migration from v0.22

All APIs are additive. Existing `LeaderboardEntry` fields retain their v0.22
meaning; expanded independent facts require `gaos.leaderboard-entry.v2`.
Benchmark verification requires a manifest obtained independently of the
submitted artifact. See [verifiable benchmark publication](/benchmark-publication).

## RFC-014 compatibility milestone

This milestone was incorporated into the official v0.24.0 artifact; no separate
v0.23.0 package was released. It implements RFC-014: executable host
conformance, host/engine authority guides, portable presentation clients,
authenticated controller epochs, signature v2, and product-supplied external
trust verification.

Existing fixed-roster sessions, replay v1.0–v1.3, and
`gaos.submission.ed25519.v1` are unchanged. Dynamic controller evidence opts
into `gaos.submission.ed25519.v2` and its new artifact identity. See
[interoperability and dynamic-control evidence](/interoperability).

## v0.22.0

Released July 27, 2026. This release implements RFC-013: portable
host and presentation boundaries, auditable controller epochs, formal game and
policy descriptors, and neutral benchmark manifest planning.

### Migration from v0.21

All new TypeScript APIs are additive. Existing fixed-roster sessions and
`gaos.replay` v1.0–v1.3 artifacts retain their existing interpretation.
`SeatControlLedger` is a separate authority schedule in this stage; it does not
upgrade or reinterpret `gaos.submission.ed25519.v1` evidence.

See [ecosystem bridges and benchmark contracts](/ecosystem-bridges) and the
[versioned roadmap](/roadmap). RFC-014 and RFC-015 ship together in v0.24.

## v0.21.0

Released July 26, 2026. This release implements RFC-011 A1/A2 and RFC-012
§§1–7: durable checkpoint/restore/compaction for long-running kernels, the
reference prediction client and host adapter, explicit tick deadlines, fixed
seat guidance, improved diagnostics, and portable evidence for sessions that
end without a win or loss.

[View the v0.21.0 release on GitHub →](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.21.0)

### Migration from v0.20

- `SessionView.status` and replay results add `ended`. Exhaustive switches need
  a new arm. An ended replay level has `stars: null`.
- New replay artifacts emit `gaos.replay` v1.3. Existing v1.0, unsigned v1.1,
  and signed v1.2 artifacts remain accepted with their original rules.
- Stale cursor validation precedes game-owned legality checks. Reducer
  rejection is `IntentCollectionError('illegal_command', ...)` and preserves
  the thrown value as `cause`.
- `checkpoint()` and `rehydrateKernelFromCheckpoint()` preserve reducer and
  protocol state across restarts. `compact()` additionally requires an exact
  durable checkpoint confirmation and access to complete canonical history;
  checkpoint recovery does not replace the full replay evidence log.
- Snapshot requests older than `retentionFloor()` return
  `resync_required`; clients must request a current snapshot.
- The new `PredictionSession` reconciles authoritative deltas and replays
  remaining optimistic commands in enqueue order. Gaps, missing patch bases,
  and digest failures require resync.
- The new `./session-host` reference adapter serializes
  prepare → persist → commit → publish, queues failed publication for retry,
  and includes a reusable event-store conformance kit.
- `nextDeadline()` returns the next tick-bounded participation deadline.
  Declared seats remain fixed; occupancy, reconnect, driver assignment, and
  spectators remain product/host concerns.

See [sessions and integrity](/session-and-integrity) and
[portable replay](/mechanisms/replay) for the complete contracts. The
subsequent v0.22 foundation is recorded in
[RFC-013](/rfcs/rfc-013-ecosystem-bridges-and-benchmark-tooling).

## v0.20.0

Released July 26, 2026. This release completes the resolved implementation
scope of [RFC-010](/rfcs/rfc-010-submission-signatures-and-interest), including
the Arena and TabletopLabs migration findings. Its central result is portable,
signed run evidence that a third party can verify offline with a pinned
historical adapter, without trusting the host or a GAOS-operated service.
It provides the independently checkable evidence layer behind GAOS's
Game-as-a-Benchmark positioning.

[View the v0.20.0 release on GitHub →](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/releases/tag/v0.20.0)

### Migration from v0.19

Observation delivery uses one mandatory v2 envelope. `ObservationDelta.codec`
is `'v2'`; bodies may be `patch`, `snapshot`, or `unchanged`, so clients should
pass envelopes through `applyObservationDelta`.

Patch computation is a delivery policy, not a wire-version choice. The default
`patchStrategy: 'adaptive'` requires a patch to win by `minReduction` (default
**4×**). After repeated unsafe, over-bound, or uneconomic probes, its per-scope
circuit breaker doubles from `patchBackoffTicks` (default **8**) up to
`maxPatchBackoffTicks` (default **32**), then performs a half-open probe.
Products that prefer predictable snapshot CPU can set
`patchStrategy: 'never'`; envelopes remain v2 and still use `snapshot` or
`unchanged` bodies.

The patch walker now abandons operation and canonical-byte bounds during the
walk, reuses the already cached canonical view for its size decision, and does
not clone a snapshot on a successful patch. Derived seat and interest views
use copy-on-write references inside prepared drafts; public observations and
snapshot bodies remain isolated copies.

Transport compression remains recommended for snapshot-heavy traffic. In the
synthetic benchmark, zlib level 1 compresses a 500-entity snapshot from 38,420
to 3,839 bytes in about 0.10 ms/seat; level 6 reaches 3,361 bytes but costs
about 0.57 ms/seat. These synchronous zlib figures expose the CPU trade and are
not a substitute for measuring the product's actual WebSocket stack.

Durable `SessionEvent.kind` also adds `interest` and `seat-signature`; exhaustive
switches need arms for enabled RFC-010 lanes. A patch is an observation body,
not a durable session-event kind. This is an intentional pre-1.0 source/wire
break, accepted because Arena and TabletopLabs are early integrations and can
migrate without a compatibility period.

- `gaos.replay` v1.2 assigns cryptographic meaning to the reserved integrity
  slots: canonical Ed25519 submission envelopes, roster-bound per-seat
  SHA-256 chains, per-seat periodic signing tiers, and durable
  `seat-signature` checkpoints;
- replay results separate deterministic `ok` from signature state and expose
  the adoption verdicts `trusted`, `unverifiable`, and `rejected`; unsigned
  v1.0/v1.1 artifacts remain valid and report `unverifiable`;
- trusted verification independently reconstructs signed commands and timeout
  actions through the pinned semantic adapter; missing mappings are
  `unverifiable`, while mismatches are `rejected`;
- tick-bounded timeout policy uses
  `{ mode: 'ticks', windowTicks: N }` and fixes timeout position at
  `windowRef + N`; wall-clock fairness remains outside the artifact. Unsigned
  sessions retain the v0.19 opaque timeout-policy reservation;
- TypeScript uses async WebCrypto signing plus synchronous pure-JS
  verification; the zero-dependency Python package signs and verifies the same
  published complete-preimage vectors;
- `gaos verify <artifact> --adapter <module>` and Python `gaos-verify` compose
  pinned product replay with signature facts completely offline;
- signed kernel sessions declare `seatKeys` and
  `signaturePolicy: { scheme: 'gaos.submission.ed25519.v1' }`, preserve exact
  command/cursor material for accepted and rejected submissions, and record
  periodic heads through `prepareSeatSignature`;
- the session hot path caches canonical seat views, reuses their bytes for
  unchanged checks and digests, snapshots each view once, and clones the heavy
  prepared-delta graph once while preserving distinct published array shells.
- client-declared interest is ordered per `(seat, scopeId)`, structurally
  constrained inside the partitioned view, tier-2 signed, replayed, and
  delivered with omission metadata;
- observation codec v2 is the default and emits safe bounded JSON patches with
  mandatory snapshot fallback and digest-checked reconstruction;
- reducer legality runs before durable ingest, invalid views are typed/fail
  fast, action `payload` round-trips through replay, repair envelopes declare
  their origin, and play-all-level run composition is explicit;
- generic infrastructure accepts the minimal `SessionView`; existing
  action-oriented reducers keep `TickView`, while non-grid observations supply
  replay counters through `replayMetrics` instead of manufacturing a HUD;
- seat-local chooser/dialogue navigation is explicitly host/UI state, while
  confirmation enters the deterministic kernel as an ordinary SDK action;
- `awaitingSeats`, resolved duplicate receipts, `sessionHeaderFor`, and
  event-array rehydration remove loops reported by both production hosts.

## v0.19.0

Released July 25, 2026. Tagged `v0.19.0` (annotated, pointing at `5ddd404`).
**This is the migration baseline; pin the tag.** See RFC-009 §4 for the pin
rule and the contract freeze that holds while both consumer migrations are in
flight.

This release adds the optional authoritative session and integrity layer:

- `./session` prepared transitions enforce persist-before-publish ordering;
- reducer drafts have explicit fork, discard, and retirement ownership;
- accepted partial-window intents and receipts survive crash rehydration;
- `finalizeRunReplay` composes ordered level transcripts with derived seeds,
  global record numbering, aggregate totals, and run-terminal validation;
- observation deltas carry applied submission acknowledgements in canonical
  reducer order for prediction reconciliation;
- rejection advances carry durable per-seat rejection identities at a
  transition watermark without inventing a gameplay revision; snapshots can
  replay missed notices after crash/reconnect, and accepted submission IDs
  remain permanently non-reusable;
- replay v1.1 preserves grouped reducer calls plus timeout, extension, and
  commitment-mismatch audit records while retaining v1.0 parsing;
- the pre-tag API and wire vocabulary is `prepareTimeout`, `TimeoutInput`,
  `timeoutId`, record/event kind `timeout`, and resolution cause `timeout`;
- TypeScript and Python pin canonical object-key ordering to Unicode code
  points, share the JavaScript-safe integer domain, and enforce the same
  strict replay object/null semantics;
- `dmath-1` supplies deterministic trigonometry and rounding, frozen for the
  first time by the v0.19 tag with independent-oracle and cross-runtime
  evidence;
- `gaos.commit.sha256.v1` supplies context-bound commit–reveal verification
  with complete cross-language byte vectors;
- replay recheck results add non-fatal `diagnostics`, including verified and
  redacted commitment mismatches; mismatch identities and chronology are
  checked, `ok` is reserved for replay consistency, and consumers apply their
  own policy to diagnostics;
- v1.1 audit records are explicitly advisory host attestation, not a
  leaderboard trust signal; strict-schema slots are reserved for RFC-010's
  additive v1.2 `seatKeys`, `clientTime`, periodic signature, policy,
  signature, and chain fields;
- session construction requires an explicit
  `hostTime: (() => number) | 'none'` choice. Clocked events carry advisory
  UTC epoch milliseconds; `'none'` keeps timestamp-free transcripts valid.
  Replay projection is opt-in and verification ignores it;
- `abort()` is idempotent after an explicit or automatic abort; it still
  rejects committed and foreign prepared transitions;
- session `AdvanceSummary` adds non-fatal `warnings`, currently used to
  surface live commitment-salt reuse.

The [sessions and integrity guide](/session-and-integrity) normatively defines
the host's prepare → persist → commit → publish order, event-id idempotency,
crash recovery, and reducer-state ownership callbacks.

Migration note: `finalizeRunReplay` requires each source level transcript to
record its already-derived level seed with `seedPolicy: 'explicit'`.
Transcripts using `gaos.run-level-seed.v1` directly are rejected.
Hosts migrating kernel construction must also choose a `hostTime` policy.
Existing timestamp-free persisted events remain rehydratable under any
`hostTime` policy.

See [sessions and integrity](/session-and-integrity).

## v0.18.0

Released July 24, 2026.

This is a breaking terminology and ownership cleanup:

- the SDK simulation boundary is a tick;
- existing settlement resolution steps run within a tick;
- turn scheduling remains entirely product-owned;
- the generic wire contract uses tick-native fields;
- agent environment steps advance exactly one tick; and
- product-controlled frame skipping was removed from the SDK.

## v0.17.0

Released July 24, 2026.

The v0.17 line begins by making replay evidence portable across products:

- `gaos.replay` v1 defines one self-identifying JSONL header/action envelope
  for single-level sessions and ordered multi-level runs;
- headers pin game and reducer-adapter versions, explicit per-level seeds,
  level definitions/results, action permutations, visibility, and totals;
- canonical serialization, strict parsing, transport validation, and
  whole-run reducer recheck are SDK-owned;
- a packaged JSON Schema and shared golden JSONL fixture make the decoded
  contract independently testable;
- the zero-dependency Python package now parses, validates, and canonically
  serializes the same replay bytes;
- `transcriptToReplayArtifact` lifts existing single-level SDK transcripts;
- `GAOS_REPLAY_MANIFEST_FORMAT` fills creator-platform
  `results.replayFormat` declarations without another product-specific spec;
  and
- the public capability map and onboarding now cover card-only, hidden-role,
  square/hex/graph, multi-board, and hybrid games instead of presenting GAOS
  as a grid-only toolkit; and
- six browser-playable examples span card, puzzle, hex, graph, hybrid, and
  real-time scheduled game loops.

## v0.16.0

The complete next-version batch is implemented. This release adds RFC-005
portals and the appendix's high-frequency and multi-agent accommodations:

- `planPortalTransits` and `commitPortalTransits` provide bounded,
  mutation-free planning and atomic commit across boards and zones;
- portal groups, footprints, bidirectional edges, multi-hop traversal, cycle
  detection, pass caps, capacity claims, and all-fail or priority contention
  have deterministic ordering and structured failures;
- `AgentEnvironment` supports frame skip and emits transcript v1.2 with every
  applied tick;
- `MultiAgentEnvironment` collects seat-redacted policies, applies canonical
  simultaneous batches through `applyIntents`, and records per-seat rewards
  and outcomes in one replayable transcript;
- protocol participation windows map sequential or simultaneous engine
  participation onto the existing intent collector; and
- information revelations, team-ranked outcomes, seat lifecycle guidance,
  sparse tick transcripts, rollback re-simulation, digests, deterministic time
  and id guidance, and spectator/hidden-lockstep boundaries are documented.

All v0.12 names remain deprecated aliases. Their scheduled removal is the
separate v1.0 compatibility boundary.

## v0.15.0

RFC-004 introduces collection and card-composition primitives:

- ordered, bag, and sparse slotted zones with immutable definitions, atomic
  plan/commit transfers, post-commit arrivals, deterministic shuffle/draw, and
  round-robin or batch dealing;
- deck, hand, queue, bag, slot-row, and discard configuration presets;
- layered keyword resolution, deterministic response priority and LIFO unwind,
  bounded declarative target enumeration, explicit durations and phases, and
  structured deck/squad validation;
- optional `targets` actions and transcript replay support; and
- priority resource-claim arbitration for contested drafts and capacity.

## v0.14.0

The engine now supports deterministic multi-seat and imperfect-information
games without changing the v0.13 single-seat path:

- reducers may implement `viewFor(state, seat)`, while `deriveSeatView`
  supplies conventional zone and board-fog redaction;
- zone identity and order have independent visibility policies, hidden order
  is canonicalized, and `assertNoInformationLeak` checks hidden-state
  permutations against observation streams;
- `TurnView` adds `participation`, ranked multi-seat `outcome`, and conventional
  `zones`; actions add an optional `seat`;
- `TurnOrderState` and immutable helpers cover rotations, reversals, skips,
  extra turns, elimination, and deterministic reordering;
- `findPatterns` detects maximal runs and relative motifs on a `BoardLayout`;
- lockstep helpers canonicalize tick/seat inputs, re-simulate from snapshots,
  process optional empty ticks, and create state digests;
- replay actions add `seat` and `tick`, replay headers identify full or
  seat-scoped visibility, and tick gaps can advance scheduled systems; and
- `AgentEnvironment` is seat-aware, terminates on decided outcomes, and emits
  transcript v1.1 with redacted initial and per-action observations.

### v0.13 to v0.14 migration

All changes are additive. Existing reducers that implement only `view` and
existing views that expose `status` continue to work.

- Add `viewFor` only when a seat must receive less than the full view.
- Set `AgentEnvironmentOptions.seat` to activate seat-scoped observations and
  hosted-seat submission checks.
- Use `participation` for new sequential or simultaneous games; `activeSeat`
  remains compatibility sugar.
- Continue using `status` for solo results. Add `outcome` when a game needs a
  ranked result across seats.
- Agent transcript consumers should accept version 1.1 before reading its
  observation snapshots.
- A missing replay-header visibility remains equivalent to `full`; missing
  action ticks preserve ordinary array-order replay.

## v0.13.0

The engine core now uses genre-neutral contracts and supports heterogeneous
board layouts:

- `TurnReducer`, `SubmittedAction`, `ActionDefinition`, and `TurnView` replace
  the old `Grid*` core names;
- `solveLevel`, `enumerateActions`, and `recheckTranscript` are the neutral
  solver and replay entry points;
- `LocationRef` and `locationKey` provide stable cross-container addressing;
- `BoardLayout` ships square, axial-hex, and directed-graph implementations
  with generic path, reachability, line-of-sight, and field helpers;
- `resolveKeyedMoves` supports arbitrary coordinate types and occupied-cell
  sets, while `resolveMoves` remains the square-grid convenience API; and
- submitted actions and agent tools accept optional `boardId` and `zoneId`
  addressing.

All v0.12 names remain as deprecated aliases with identical runtime behavior.
They are scheduled for removal in v1.0.

### v0.12 to v0.13 migration

| Deprecated v0.12 name | Preferred v0.13 name |
|---|---|
| `GridReducer` | `TurnReducer` |
| `GridSubmittedAction` | `SubmittedAction` |
| `GridActionDefinition` | `ActionDefinition` |
| `GridTurnView` | `TurnView` |
| `solveGridLevel` | `solveLevel` |
| `enumerateGridActions` | `enumerateActions` |
| `GridSolveResult` | `SolveResult` |
| `GridSolverOptions` | `SolverOptions` |
| `recheckGridTranscript` | `recheckTranscript` |
| `GridRecheckResult` | `RecheckResult` |
| `GridTranscriptAction` | `TranscriptAction` |
| `GridTranscriptHeader` | `TranscriptHeader` |

Existing imports continue to compile. New views should put spatial targeting in
`TurnView.grid`; the deprecated `GridTurnView` continues to accept the v0.12
flat `hud.targetableCells` and `hud.actionTargeting` fields. Its compatibility
view also accepts an existing product-owned `grid` payload of any shape.

## Release process

TypeScript and Python distributions share one semantic version. Before a
release, update both `package.json` and `python/pyproject.toml`, then run:

```sh
npm ci
npm run typecheck
npm test
npm run build

python3 -m pip install build pytest
PYTHONPATH=python python3 -m pytest python/tests
python3 -m build python
```

Commit the version change separately and push it. Create a GitHub release whose
tag is `v` followed by that version, such as `v0.1.0`.

Publishing the release runs `.github/workflows/release.yml`. It:

1. validates the TypeScript SDK and publishes it to GitHub Packages;
2. validates and builds the Python SDK; and
3. attaches the npm tarball, Python wheel, and Python source distribution to
   the GitHub release.

GitHub Packages uses the repository's `GITHUB_TOKEN`; no long-lived npm token
is required. Package consumers authenticate with a token that has
`read:packages` access.
