# Real-time games: fixed-rate ticks and deterministic lockstep

GAOS supports fixed-tick real-time games with the same deterministic reducer
used for turn-based and WEGO play. The SDK owns ticks, lockstep input ordering,
rollback/resimulation, replay verification, and the session kernel. The product
owns its scheduler and wall clock, sockets or WebRTC transport, signaling,
interpolation, rendering, late-join flow, and latency policy.

That makes fixed-tick action and strategy games first-class
Game-as-a-Benchmark environments rather than limiting the category to
turn-based tasks.

```ts
import {
  createTickRate,
  tickAtElapsedMilliseconds,
  type TickReducer,
} from '@yugao-gaos/turn-based-grid-sdk/engine';

const rate = createTickRate(30);
// rate.millisecondsPerTick === 33.333...

const currentTick = tickAtElapsedMilliseconds(elapsedMs, rate);
for (; simulatedTick < currentTick; simulatedTick++) {
  state = reducer.advance(state, inputsFor(simulatedTick));
}
```

The host owns `elapsedMs`, scheduling, catch-up limits, rendering, and
interpolation. The reducer sees only explicit tick-numbered inputs.

## Reducer guidance

A tick with no submitted intents should take a near-free empty-input path:
advance only scheduled systems whose explicit boundary is crossed. Reducers
must be deterministic, but they need not be persistently immutable. At high
frequency, in-place mutation with copy-on-write rollback deltas is legitimate.
The solver is the exception: it explores sibling actions from one parent, so
its adapter must snapshot or otherwise protect the parent state.

Keep reducer state free of wall-clock reads. Hosts translate deadlines,
elapsed time, disconnects, and substitutions into ordinary tick-numbered
inputs. Mint ids from deterministic counters or seeded streams, and avoid
cross-engine transcendental floating-point operations unless the result is
quantized.

## Seat lifecycle

Disconnect, rejoin, and human/bot substitution are host events injected as
ordinary inputs. A product may switch a disconnected seat to a behavior-tree
driver, make it auto-wait, or call `eliminateSeat` and apply a declared policy
to its entities. Reconnection changes the seat's driver back; ownership and
authoritative state never move. Record the chosen transition with its tick or
tick so rollback and replay reach the same result.

## Sparse transcripts and rollback

`TranscriptAction.tick` records input deltas. Empty ticks may be omitted;
`recheckTranscript` and `resimulate` infer gaps and call a product
`applyEmptyTick` callback when supplied. Lockstep inputs are canonically
ordered by tick, lexical seat id, then authored action order.

Peers can compare `stateDigest` values at agreed ticks to locate the first
desync. The product must provide canonical serialization for maps, sets, and
presentation-only fields. Pure peer-to-peer lockstep replicates full state:
per-seat views prevent accidental disclosure but not a modified client's
maphack.

For open-information games, products may use optimistic P2P plus a dispute
verifier: exchange signed canonical inputs and digests, accept matching
results, and send a divergent transcript to an authoritative server for
deterministic replay. This provides integrity, fault detection, and
arbitration. It does not provide confidentiality: a client that passively
reads replicated secrets can still submit a legal action and produce the same
digest as every honest peer.

Competitive hidden-information games therefore keep authoritative secret
state in a server-side session resolver (for example, one Durable Object per
match) and distribute only `viewFor(state, seat)` observations. The resolver
collects canonical intents, applies the reducer, retains the full replay
record, and sends each client its redacted result. P2P input exchange or
digest comparison may still be used around that authority, but no untrusted
client receives another seat's hand, deck order, or unrevealed fog state.

## Agent decision cadence

`AgentEnvironment.step()` advances exactly one simulation tick. Products own
the policy for requesting a new decision less often, holding an input, or
repeating an action. Every applied tick, observation, and reward is retained
in transcript version 1.3.

`MultiAgentEnvironment` applies a canonical simultaneous batch through
`TickReducer.advance`. Each seat receives only `viewFor(state, seat)` and
its legal actions. Missing policies or deadline misses contribute a legal
`wait`. One shared transcript records the redacted per-seat views, canonical
intent batches, and per-seat rewards/outcomes.

The hosted HTTP tick protocol shares the participation and canonical
collection model, but it is not a 60 Hz transport. Realtime products bring
WebRTC, relay, or socket transport and use the reducer, lockstep inputs,
rollback, and digest helpers directly.
