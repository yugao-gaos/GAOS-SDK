# Appendix A — Genre coverage and high-frequency turns

Status: implemented guidance and accommodations · Informative appendix to the
batch except for the marked contract additions.

::: warning Superseded in v0.18
High-frequency execution now uses ticks directly. Agent frame skipping and
turn scheduling are product policy, not SDK capabilities.
:::

## A.1 Genre coverage after the batch

| Genre | Verdict | Notes |
|---|---|---|
| Casino | Full | Hole cards = owner-only identity; betting round = priority window; chips = resource transactions. Side pots / wager pools are **product-side**: compose them from resource transactions (a layered pot is a set of product-defined balances). Real-money fairness (commit-reveal shuffles) is likewise product/server policy, out of SDK scope. |
| Board | Full | Graph layout = territory maps; hex + resources + dice + card zones cover Catan-class games. Negotiation/auctions are **product-side**: human trades are ordinary submitted actions over simultaneous intents; NPC negotiation is behavior-tree-driven dialogue. No new mechanism. Solver is BFS-to-goal, not adversarial search — opposing play comes from agents, by design. |
| Match | Full | Cascades = settlement; gravity = directed transport ("down" conveyor); refill = bag zone → spawn portal; clears = chain reactions; memory games = face-down identity + reveal events. Match detection **generalizes into a mechanism**: see A.1.1 pattern matching. |
| Strategy (turn-based) | Full | Fog-of-war (RFC-003), WEGO simultaneous turns (protocol intents + `resolveMoves`), production queues = FIFO zones, supply = linked components. Multi-agent episode orchestration (RFC-003 deferral) matters most here: several independent drivers each occupying a seat in the same episode, each observing only its seat's redacted view, intents collected per the A.3 participation model, one shared verifiable transcript with per-seat rewards — the substrate for model-vs-model arenas. |
| Strategy (real-time) / Simulation | Via high-frequency turns — see A.2 | Continuous numeric simulation (curves, physics) stays product math; the SDK owns the discrete rule moments. |

### A.1.1 Pattern matching — the one helper promoted to a mechanism

The only genre helper that passes the boundary test (a deterministic,
product-neutral algorithm more than one genre needs) is pattern detection:

```ts
export interface PatternSpec<TCell> {
  /** Relative motif: offsets for lattices, edge motifs for graphs,
   *  or 'run' with a minimum length along layout lines. */
  shape: { kind: 'run'; minLength: number } | { kind: 'motif'; offsets: readonly TCell[] };
  /** Product-owned equivalence: which tokens count as matching. */
  matches(a: TokenRef, b: TokenRef): boolean;
}

export function findPatterns<TCell>(
  layout: BoardLayout<TCell>,
  occupied: ReadonlyMap<string, TokenRef>,   // keyed by layout.key
  spec: PatternSpec<TCell>,
): readonly PatternMatch<TCell>[];           // deterministic order, overlaps reported
```

The SDK owns traversal, deterministic match ordering, and overlap reporting;
the product owns token equivalence and what a match triggers (usually a
settlement job). Grid application: match-3 runs, mahjong pairs, shape
detection. The same equivalence-driven combination search extends naturally
to card sets (melds, poker hand classes) as a zone-side variant if a
consumer needs it — noted, not specced. Lands with RFC-002 (it is pure
layout geometry) or immediately after.

The boundary rulings above double as the precedent: an algorithm enters the
SDK only when it is product-neutral AND needed across genres; anything
expressible as composition of existing mechanisms (wager pools, negotiation)
stays product-side, documented as a pattern instead.

## A.2 High-frequency turns ("real time" = many fast turns)

Real-time play is served by running the deterministic turn pipeline at tick
rate (e.g. 60 turns/second) with per-tick input collection — the classic
lockstep model. The engine's properties already fit: every mechanism is a
bounded, allocation-light pure function; settlement, flight, and transport
all carry explicit pass caps, so per-tick cost is bounded by contract.
Reference point: the first-consumer platform already runs a deterministic
20 Hz world with rollback that resimulates up to 60 ticks inside one frame,
which demands ≳3,600 ticks/second of simulation headroom — the same
discipline this pattern requires.

The pattern, and where each piece lands:

1. **Turn = tick.** `apply(state, action)` gains a documented empty-input
   fast path: a tick with no submitted intents must be near-free (advance
   durations/phases only when boundaries are crossed). ⚙ Lands in RFC-001 as
   a documented reducer guideline, not a signature change.
2. **Mutable apply is legitimate.** The `TurnReducer` contract requires
   determinism, not persistent immutability. At 60 Hz, products should
   implement `apply` with in-place mutation plus copy-on-write deltas for
   rollback (the pattern the reference platform's RollbackManager already
   uses). The engine never sees the difference — mechanisms receive state
   through callbacks. GC pressure, not algorithm cost, is the real 60 Hz
   budget; document it.
3. **Transcripts encode input deltas.** ⚙ RFC-001's `TranscriptAction`
   gains an optional `tick` field; ticks without inputs are omitted and
   re-simulation infers empty ticks between recorded ones. 60 Hz sessions
   stay replayable and `recheckTranscript`-verifiable without 60
   entries/second of no-ops.
4. **The protocol layer is NOT the 60 Hz transport.** The hosted turn
   envelope (HTTP submit/cursor/retry) serves async turn games. Lockstep
   products bring their own realtime transport and use the engine + reducer
   directly; the protocol's simultaneous-intent *concept* maps to per-tick
   input collection, but its hosted implementation does not. Document to
   prevent misuse.
5. **Agents act at decision points, not ticks.** LLM/scripted drivers cannot
   act 60 times a second, and should not have to. `AgentEnvironment` gains a
   frame-skip option (act every N ticks; chosen action or a product-defined
   "continue" repeats in between — the Atari benchmark convention). Behavior
   trees remain the in-tick automation layer; drivers make macro decisions.
   Lands as an RFC-003 follow-up alongside multi-seat episodes.
6. **The solver stays out.** BFS over a 60 Hz tick space explodes; solving
   remains defined for discrete decision spaces (puzzles, macro-turns).

What this appendix deliberately does not do: add a scheduler, a game loop,
or wall-clock time to the SDK. Tick cadence, catch-up, and interpolation are
host concerns; the SDK's contribution is that every mechanism is cheap,
bounded, and deterministic enough to be called 60 times a second.

## A.3 One turn model, three settings

Sequential play, simultaneous (WEGO) play, and high-frequency ("real-time")
play are not three modes — they are one intent-collection model with
different participation and cadence settings. Every turn collects one intent
per seat; a seat that submits nothing contributes the default intent `wait`.

| Style | Participation | Default | Cadence |
|---|---|---|---|
| Sequential (chess, most board games) | Active seat only may submit a non-wait intent | All other seats implicitly `wait` | On player action — normative spec: RFC-001 "Sequential turn discipline" (`TurnOrder` rotation, enforcement in `apply`, advancement policy) |
| Simultaneous / WEGO (Diplomacy, tactics) | All seats submit | `wait` on deadline | On window close |
| High-frequency (A.2) | Any subset per tick | `wait` | Fixed tick rate (e.g. 60/s) |

Consequences for the batch:

- ⚙ RFC-001: `TurnView.activeSeat` generalizes to a participation
  descriptor — `participation?: { mode: 'sequential'; activeSeat: string } |
  { mode: 'simultaneous'; seats: readonly string[] }` — with `activeSeat`
  kept as sugar for the sequential case. Legal-action enumeration for a
  non-participating seat returns `wait` plus any reaction-class actions the
  state currently makes legal for it — sequencing is a legality rule, never
  a structural one, which is what lets counter-play exist inside another
  seat's turn (RFC-001 "In-turn reactions").
- The protocol layer already implements this: its simultaneous-intent window
  with deadline collection IS the general case; a sequential game is a
  window whose eligible-seat set has size one. No protocol change needed —
  document the correspondence.
- The reducer sees a uniform shape: `apply` receives the collected intent
  set (size 1 in sequential play), which is also why the empty-input fast
  path in A.2 item 1 falls out naturally — a tick where everyone waits is
  the identity plus scheduled expirations.
- RFC-004's priority windows are this same model recursively: a response
  window is a nested intent collection with its own participation set.

This keeps the standing rule intact: products choose participation and
cadence as policy; the SDK owns the single deterministic collection and
resolution pipeline underneath all three.

## A.4 Deterministic lockstep networking (input-only exchange)

Because the reducer is deterministic, real-time multiplayer needs no state
replication: peers exchange only inputs, each simulates locally, and any
realtime transport (WebRTC data channels, Cloudflare Realtime, a relay
socket) carries the traffic. The reference platform already runs this model
in production (20 Hz input broadcast + copy-on-write rollback +
resimulation on late inputs).

What the SDK owns (deterministic algorithms, no I/O):

- **Canonical input envelope and ordering.** A documented per-tick record
  `{ tick, seat, actions }` with a total order — tick, then seat id, then
  submission index — so every peer folds simultaneous inputs identically.
  This is the A.3 participation model on the wire.
- **Resimulation helper.** Rollback IS replay: expose the replay checker's
  core as `resimulate(reducer, snapshotState, inputs)` for live rollback
  use, so netcode and `recheckTranscript` share one code path.
- **Desync detection contract.** Peers exchange a state digest every N
  ticks (product injects `hash(state)`, or hashes the canonical view
  stream; `fnv1a` is available). A divergence pinpoints the first bad tick,
  and the full transcript re-verifies offline — the same machinery doubles
  as an anti-cheat audit trail.
- **Cross-engine determinism guidance.** The engine itself uses only
  integer ops and division (mulberry32, FNV-1a) and is safe across JS
  engines. Product reducers must avoid engine-varying transcendentals
  (Math.sin/pow etc. are not bit-identical across engines) or use
  fixed-point; document in the integration checklist.

What the SDK will never own: sockets, signaling, NAT traversal, session
membership, clock sync, late-join snapshot transfer. Those are transport
and host concerns.

**The hidden-information tension.** Pure P2P lockstep replicates FULL state
to every peer — RFC-003 partitions protect honest presentation, not a
modified client. Fog-of-war and hidden hands are safe this way among
trusted players, but competitively a hacked peer sees everything (the
classic maphack). Games where hidden info matters adversarially should run
host-authoritative resolution (one peer or a server applies the reducer and
distributes redacted per-seat views; the digest/replay contract keeps the
host honest after the fact). This is the same split the first-consumer
platform already declares as resolver modes ('deterministic' P2P vs
'server-authoritative'). Cryptographic alternatives (mental poker) are out
of SDK scope.

## A.5 Known gaps register

Honest residue after the batch; ordered by severity. Items 1–3 need design
work before or during their dependent RFCs; 4–6 are documentation.

### 1. Multi-seat outcomes (must fix — lands with RFC-001/003)

`TurnView.status: 'playing' | 'won' | 'failed'` and star scoring are
single-player shapes. Multi-seat games need a results contract. Sketch:

```ts
export type Outcome =
  | { kind: 'ongoing' }
  | { kind: 'decided';
      /** Ascending rank; ties share a rank. Solo games: one entry. */
      ranking: ReadonlyArray<{ seat: string; rank: number; score?: number }>;
      reason?: string };            // product-defined: 'checkmate', 'timeout', ...
```

`status` stays as the solo sugar (deprecated alias path at v1.0);
`AgentEnvironment` rewards become per-seat, keyed off ranking — required for
model-vs-model arenas to rank participants. Elimination order folds in as
rank-at-elimination.

### 2. Seat lifecycle (pattern doc — attaches to RFC-001 TurnOrder + A.4)

Disconnect/rejoin/substitution are host events injected as inputs (like
time, A.5.4). Reducer-side menu, product-chosen per game: seat becomes
behavior-tree-driven (natural human→bot substitution); seat auto-waits;
seat is eliminated (`eliminateSeat`) with product policy for its entities
(neutral, removed, redistributed). Reconnection = the seat's driver changes
back; state never moved. Document; no new contract.

### 3. Teams (thin convention — attaches to RFC-003 + outcomes)

A seat-grouping declaration referenced consistently by visibility
(`seats: team(...)` sets = shared vision), outcomes (rank by team), and
product resource pooling. Convention + helpers, not a mechanism.

### 4. Time as input (determinism checklist)

The SDK stays wall-clock-free. Hosts observe clocks and inject deadline/
elapsed events as ordinary inputs with ticks/turn numbers, so time replays
deterministically. Priority-window timeout-as-pass is the existing instance
of this rule; chess clocks are the same pattern with a product rule
("flag fall" input → outcome).

### 5. Deterministic id minting (determinism checklist)

Entities spawned mid-game must take ids from counters or seeded draws —
never `crypto.randomUUID()`/`Math.random()` — or lockstep digests and
replays silently diverge. One line in the integration checklist.

### 6. Spectators (one paragraph in RFC-003)

A spectator is a view policy, not a seat: public-only, or full-view with
host-side delay (anti stream-sniping). Falls out of `viewFor` + partition
policies; state it explicitly.

Already tracked elsewhere: multi-agent episode orchestration (RFC-003
follow-up, defined in A.1); protocol-envelope compatibility check for the
participation descriptor (RFC-001 open item).
