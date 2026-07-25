# Release process and migrations

For the public chronological changelog, see the
[complete version history](/version-history).

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
