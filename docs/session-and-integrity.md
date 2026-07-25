# Authoritative sessions and integrity

Version 0.19 adds the optional `./session` entry point for hosts that need a
deterministic, authoritative match loop without coupling game rules to a
database, network, timer, or deployment platform.

## Persist before publish

Every state-changing operation returns a `Prepared` transition:

```ts
import { createSessionKernel } from '@yugao-gaos/turn-based-grid-sdk/session';

const kernel = createSessionKernel({
  sessionId,
  game,
  levelId,
  reducer,
  level,
  seed,
  seedPolicy: 'explicit',
  seats: ['blue', 'red'],
  cadence: { mode: 'turns' },
  commandToAction: (command, context) => ({
    id: command.action,
    seat: context.participantId,
  }),
});

const prepared = kernel.prepareIngest(submission);
try {
  await eventStore.append(prepared.events);
  kernel.commit(prepared);
} catch (error) {
  kernel.abort(prepared);
  throw error;
}
```

Preparation operates on an isolated reducer draft. The live state,
observations, cursor, and digest do not change until `commit`. Hosts with
mutable, copy-on-write, pooled, or ECS state supply `stateIsolation.fork`,
`discard`, and optionally `retire`; structured-cloneable state uses the
default strategy.

Accepted intents are events even before a simultaneous window is complete.
`rehydrateKernel(options, transcript)` therefore restores pending commands and
idempotency receipts after a crash. A resolution records the complete
canonical input group and replay invokes the reducer exactly once for that
group.

Every seat has an independent `viewRevision`. Resolution increments it even
when the seat's redacted view is unchanged. `snapshot(seat)` is the reconnect
path; v1 observation deltas are either a complete snapshot or an unchanged
marker.

The v0.19 kernel bounds future tick targets, buffered submissions per seat,
catch-up work, retained receipts, and extension bytes. The client-side
`PredictionSession` sketch from RFC-006 is deferred to v0.20: observation
deltas first need an authoritative acknowledgement identity so reconciliation
can remove and replay pending predictions deterministically.

## Deterministic math

State-path code can import `STATE_MATH` and `createDmath` from `./engine`.
`STATE_MATH` classifies the native constants and operations that are safe for
deterministic state. Implementation-approximated functions such as
`Math.sin`, `Math.cos`, and `Math.atan2` are forbidden there.

```ts
import { createDmath } from '@yugao-gaos/turn-based-grid-sdk/engine';

const dmath = createDmath();
const heading = dmath.atan2(deltaY, deltaX);
const snapped = dmath.roundTo(heading, 6);
```

`dmath-1` exposes `sin`, `cos`, `atan2`, `clamp`, and `roundTo`. It rejects
non-finite inputs and documented out-of-domain values instead of allowing
NaN or infinity into reducer state. The selected algorithm is recorded in a
session replay and must be constructible before re-simulation begins.

| Function | Accepted domain | Boundary rule |
| --- | --- | --- |
| `sin`, `cos` | finite `|x| <= 2^30` | preserve the signed-zero sine convention |
| `atan2` | finite `x` and `y` | IEEE signed-zero quadrants |
| `clamp` | finite values, `lo <= hi` | exact endpoint selection |
| `roundTo` | integer decimals `[-15, 15]`, scaled magnitude `< 2^53` | half away from zero |

The package publishes exact binary64 vectors at
`fixtures/dmath/dmath-1.vectors.json`.

## Commit–reveal envelopes

`gaos.commit.sha256.v1` binds a secret payload to the session, seat,
seat-scoped commitment id, and gameplay window. The hash covers length-framed
UTF-8 fields, u64 big-endian counters, raw salt bytes, and canonical JSON
payload bytes.

```ts
import {
  COMMITMENT_SCHEME,
  createCommitmentHash,
} from '@yugao-gaos/turn-based-grid-sdk/engine';

const binding = { sessionId, seat: 'red', commitmentId: 0, windowRef: 3 };
const hash = createCommitmentHash(binding, saltHex, hiddenOrder);

const commit = { commitmentId: 0, scheme: COMMITMENT_SCHEME, hash };
const reveal = { commitmentId: 0, salt: saltHex, payload: hiddenOrder };
```

The session layer verifies a reveal before the payload reaches gameplay.
Mismatches remain outside the reducer batch and become independently
verifiable replay audit records. The package includes three complete
preimage-and-hash vectors at
`fixtures/commitment/gaos.commit.sha256.v1.vectors.json`.
Replay recheck results expose non-fatal `diagnostics` for redacted mismatch
records that cannot be independently rechecked and for salt reuse across
distinct commitments.

## Finalization

`liveTranscript()` is an append-only durability log, not a portable result.
Once the reducer reports `won` or `failed`, `finalizeReplay(transcript,
options)` projects it into `gaos.replay` v1.1. Deadline, extension, checkpoint,
grouped-resolution, and commitment-mismatch records survive in their portable
lanes.

See [portable replay and verification](/mechanisms/replay) for the JSONL
format and whole-run verifier.
