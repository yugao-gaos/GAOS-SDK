# Portable replay and verification

`gaos.replay` v1 is the SDK-owned evidence envelope for a deterministic game
session or ordered multi-level run. Arena, creator platforms, local
evaluators, and third-party benchmark tools can exchange one self-identifying
JSONL artifact instead of defining platform-specific wrappers around the same
SDK transcript.

The first line is a `ReplayHeader`. A v1.0 stream follows it with individual
`ReplayAction` lines. A v1.1 stream may instead contain grouped
`resolution`, `deadline`, `extension`, `checkpoint`, and `commit-mismatch`
records.

```jsonl
{"format":"gaos.replay","formatVersion":"1.0","game":{"adapter":{"id":"creator/demo/reducer","version":"commit:abc123"},"id":"creator/demo","version":"1.0.0"},"kind":"header","levels":[{"id":"intro","index":0,"level":{"goal":3},"result":{"actionsUsed":2,"stars":3,"status":"won"},"seed":2654435731}],"perm":[0,1],"seed":42,"seedPolicy":"gaos.run-level-seed.v1","sessionId":"run-42","totals":{"totalActionsUsed":2,"totalStars":3}}
{"canonicalId":"Action 1","kind":"action","levelIndex":0,"n":0,"wireId":"Action 1"}
{"canonicalId":"Action 2","index":2,"kind":"action","levelIndex":0,"n":1,"wireId":"Action 2"}
```

Property order is not semantic. `serializeReplayJsonl` emits canonical
lexicographically ordered JSON with one trailing newline, making the exact
artifact suitable for hashing, signing, and object storage.

## Header contract

The header pins everything shared tooling needs before reducer execution:

- `format` and `formatVersion`, currently `gaos.replay` / `1.1`;
- a stable game id/version and historical adapter id/version;
- the run seed and either explicit seeds or
  `gaos.run-level-seed.v1` derivation;
- the default wire-to-canonical action permutation;
- an ordered level list with an explicit seed, self-contained level
  definition, recorded result, and optional content version;
- aggregate stars and action usage;
- optional transcript visibility and JSON extension objects.

Adapter identity is intentionally separate from game identity. A game release
can keep the same content id while selecting the exact reducer implementation
needed to recheck an old result. The SDK does not download or execute adapters;
the verifier supplies a trusted registry callback.

Every level stores its seed even when the run uses
`gaos.run-level-seed.v1`. This makes a segment independently inspectable while
letting validation detect a seed that disagrees with the declared derivation.

## Creating and transporting an artifact

```ts
import {
  GAOS_REPLAY_MANIFEST_FORMAT,
  createReplayArtifact,
  parseReplayJsonl,
  serializeReplayJsonl,
} from '@yugao-gaos/turn-based-grid-sdk/engine';

const artifact = createReplayArtifact({
  sessionId: 'run-42',
  game: {
    id: 'creator/demo',
    version: '1.0.0',
    adapter: { id: 'creator/demo/reducer', version: 'commit:abc123' },
  },
  seed: 42,
  perm: [0, 1],
  levels: [{
    id: 'intro',
    version: 3,
    level: { goal: 3 },
    result: { status: 'won', stars: 3, actionsUsed: 2 },
  }],
  actions: [
    { n: 0, levelIndex: 0, wireId: 'Action 1', canonicalId: 'Action 1' },
    { n: 1, levelIndex: 0, wireId: 'Action 2', canonicalId: 'Action 2', index: 2 },
  ],
});

const stored = serializeReplayJsonl(artifact);
const restored = parseReplayJsonl(stored);
```

`GAOS_REPLAY_MANIFEST_FORMAT` is the portable declaration for a host manifest:

```ts
results: {
  schema: 'creator.demo.result/v1',
  replayFormat: GAOS_REPLAY_MANIFEST_FORMAT,
}
```

It declares MIME `application/vnd.gaos.replay+jsonl`, extension
`gaos-replay.jsonl`, and `compressed: false`. A host may gzip transport or
storage, but decompression must recover the canonical JSONL bytes.

The npm archive includes the decoded-artifact
[`gaos.replay` v1 JSON Schema](https://github.com/yugao-gaos/GAOS-TurnBasedGrid-SDK/blob/v0.19.0/schemas/gaos.replay-v1.schema.json).
The repository also carries a canonical JSONL fixture used by both language
test suites, so independent implementations can verify byte-for-byte output.

Python uses the same transport contract without adding runtime dependencies:

```python
from agilabs_arena import parse_replay_jsonl, serialize_replay_jsonl

artifact = parse_replay_jsonl(stored)
assert serialize_replay_jsonl(artifact) == stored
```

Python owns parsing, transport validation, seed derivation, and canonical
serialization. The SDK's whole-run reducer recheck remains in the TypeScript
engine and requires the product's pinned reducer registry.

## Whole-run recheck

`recheckReplayArtifact` validates the envelope and checks every level. Legacy
action streams use `recheckTranscript`; v1.1 resolution records invoke
`advance` or `applyIntents` exactly once with the complete recorded input
group. Commitment reveals are recomputed before reducer execution. The product
supplies only a trusted adapter registry:

```ts
const checked = recheckReplayArtifact(
  artifact,
  ({ game }) => reducerRegistry.get(
    `${game.adapter.id}@${game.adapter.version}`,
  ),
);

if (!checked.ok) console.error(checked.problems);
```

`checked.ok` reports demonstrated validation or simulation failures.
`checked.diagnostics` reports evidence that is intentionally non-fatal, such
as a redacted commitment-mismatch record whose reveal is unavailable for
independent recomputation or salt reuse across commitments. A verifier that
claims full independent cryptographic verification must require both
`checked.ok` and `checked.diagnostics.length === 0`.

The checker verifies global action numbering and level ordering, per-level seed
policy, each recorded terminal result, and aggregate totals. Problems are
prefixed with the level index/id so a multi-level run can be diagnosed without
splitting the evidence file.

## Existing transcript compatibility

The reducer-level `TranscriptHeader` and `TranscriptAction` contracts remain
the core single-level inputs. `transcriptToReplayArtifact` wraps them without
changing their seed, visibility, permutation, ticks, targeting, or action
numbers:

```ts
const portable = transcriptToReplayArtifact(header, actions, {
  game: gameAndAdapterRef,
  levelId: 'intro',
  levelVersion: 3,
});
```

Arena's existing run header maps directly:

| Arena run field | `gaos.replay` field |
| --- | --- |
| `sessionId`, `seed`, `perm` | same header fields |
| `levels[i]` | `levels[i].level` |
| derived `runLevelSeed(seed, i)` | explicit `levels[i].seed` plus derived seed policy |
| `results[i]` | `levels[i].result` |
| `totalStars`, `totalSteps` | `totals.totalStars`, `totals.totalActionsUsed` |
| action `levelIndex` | action `levelIndex` |

Creator platforms can use the manifest constant above and emit the identical
envelope from their sessions. Shared tooling then resolves the declared
adapter and verifies either producer with the same parse/recheck path.

## Reducer-level transcript inputs

`recheckTranscript` verifies an action-label permutation, re-simulates
canonical actions through a deterministic reducer, and compares the recorded
terminal summary with the replayed result.

## Transcript inputs

The header records the level, seed, wire-to-canonical permutation, final status,
stars, action count, and optional transcript visibility. Visibility is `full`
or `seat:<id>`; omission retains full-view compatibility. Each action records
both its externally visible wire id and canonical reducer id plus optional
coordinates, index, `boardId`, `zoneId`, `seat`, a declarative `targets`
tuple, or non-negative integer
`tick`.

```ts
const result = recheckTranscript(reducer, header, transcriptActions);
if (!result.ok) console.error(result.problems);
```

Action labels must use the exact one-based form `Action N`. For each entry, the
checker parses both labels and verifies:

```text
header.perm[wireNumber - 1] === canonicalNumber - 1
```

A bad mapping is reported but does not prevent canonical re-simulation, allowing
one pass to reveal both permutation and outcome problems.

## Re-simulation

The checker initializes the reducer with the recorded level and seed, then
submits canonical actions in array order. Optional `x`, `y`, `index`, `boardId`,
`zoneId`, `seat`, and `targets` fields are copied when present. The first rejected action stops
replay and adds its number, id, and error message to the problem list.

Ticks must be monotonic. Omitted ticks continue the preceding tick, starting
at zero. Pass `applyEmptyTick` as the fourth argument when scheduled product
systems must advance through gaps:

```ts
recheckTranscript(reducer, header, actions, {
  applyEmptyTick: (state, tick) => advanceScheduledSystems(state, tick),
});
```

Without that callback, an empty tick is an identity step.

After replay it compares:

- status;
- stars, normalizing absent values to `null`; and
- `hud.actionsUsed`.

The returned `replayed` summary is available whether verification succeeds or
fails.

## What it does not verify

This helper does not authenticate a transcript, check session ownership,
compare every intermediate event or seat-scoped observation, or prove that the
recorded level definition has not changed. Products
should version or hash content and use server-side signatures when those
properties matter.

## Per-level run seeds

`runLevelSeed(sessionSeed, levelIndex)` derives a deterministic unsigned 32-bit
seed for each level in a multi-level run. Level indices are zero-based. Keep
their ordering stable; inserting a level changes the derived seeds of later
levels unless the product stores an explicit level identity mapping.

## Compatibility rule

A transcript is replayable only with compatible reducer logic, content, action
ids, and randomness. Version those together. Verification should select the
historical adapter before calling this helper rather than replaying old data
through current rules.

## Zonoid example

When a Zonoid scored session finishes, the server stores the level version,
seed, action-label permutation, canonical action log, and terminal summary.
Before a result reaches the official benchmark, Zonoid selects the matching
universal reducer and re-simulates the transcript with this SDK helper. A
desync, rejected action, altered permutation, or forged star count is reported
instead of being accepted as a leaderboard result.

<figure class="mechanism-video">
  <video controls muted playsinline preload="metadata" poster="/mechanisms/replay-poster.jpg" aria-label="Focused Zonoid deterministic replay demo board recording">
    <source src="/mechanisms/replay.mp4" type="video/mp4">
    Your browser does not support embedded video.
  </video>
  <figcaption>Zonoid Story Level 1: the same seed and solver-verified 19-action solution runs twice to completion, producing an identical final state.</figcaption>
</figure>
