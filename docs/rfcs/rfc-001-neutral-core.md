# RFC-001 — Neutral core: genre-free names for the reducer, solver, and replay contracts

Status: implemented · Ships in: v0.13–v0.14 · Depends on: — · Breaking: no (aliases retained until v1.0)

::: warning Superseded in v0.18
This historical RFC records the earlier turn-oriented API. The current
contract is `TickReducer`/`TickView`; turn scheduling is product-owned.
:::

## Motivation

The engine's genuinely generic mechanisms already carry neutral names
(settlement, chain reactions, triggers, resources, behavior trees, scoring,
agent environment). The grid coupling is concentrated in exactly one place:
the core contracts in `contracts.ts`, `solver.ts`, and `replay.ts` that every
future mechanism family (zones, cards, portals) must also consume. Renaming
this cluster — and nothing else — makes the core reusable without blurring the
catalog of genuinely spatial mechanisms.

## Rename map

| v0.12 name | v0.13 name | File |
|---|---|---|
| `GridReducer` | `TurnReducer` | contracts.ts |
| `GridSubmittedAction` | `SubmittedAction` | contracts.ts |
| `GridActionDefinition` | `ActionDefinition` | contracts.ts |
| `GridTurnView` | `TurnView` | contracts.ts |
| `solveGridLevel` | `solveLevel` | solver.ts |
| `enumerateGridActions` | `enumerateActions` | solver.ts |
| `GridSolveResult` | `SolveResult` | solver.ts |
| `GridSolverOptions` | `SolverOptions` | solver.ts |
| `recheckGridTranscript` | `recheckTranscript` | replay.ts |
| `GridRecheckResult` | `RecheckResult` | replay.ts |
| `GridTranscriptAction` | `TranscriptAction` | replay.ts |
| `GridTranscriptHeader` | `TranscriptHeader` | replay.ts |

**Explicitly not renamed** (genuinely spatial; renaming would blur the
catalog): `Cell`, `Mover`, `resolveMoves`, all of `geometry.ts`,
`traverseGridRay`/`GridRayDirective`/`GridRayResult`, push chains,
projectiles, transport, `runLevelSeed`. `resolveArrival` is already neutral —
a card entering a discard pile is an arrival dispatch; no change needed.

## Contract evolution

### `SubmittedAction` / `ActionDefinition`

```ts
export interface ActionDefinition {
  id: string;
  /** 'xy' remains for board targets; 'index' serves zones today. */
  params: 'none' | 'xy' | 'index';
  text?: string;
}

export interface SubmittedAction {
  id: string;
  x?: number;
  y?: number;
  index?: number;
  /** RFC-002: names the board when a game declares more than one. */
  boardId?: string;
  /** RFC-004: names the zone for zone-indexed actions. */
  zoneId?: string;
}
```

`boardId`/`zoneId` are optional and ignored by single-board games, so v0.12
action logs replay unchanged.

### `TurnView` — neutral core plus optional namespaces

The v0.12 `GridTurnView.hud` mixes neutral fields (`actionsUsed`, `items`,
`dialogueOptions`, `pois`) with grid-only fields (`targetableCells`,
`actionTargeting`). v0.13 splits them:

```ts
export interface TurnView {
  actions: readonly ActionDefinition[];
  systemActions?: readonly ActionDefinition[];
  status: 'playing' | 'won' | 'failed';
  stars?: number;
  /** RFC-003: which seat acts; absent means single-seat (v0.12 behavior). */
  activeSeat?: string;
  hud: {
    actionsUsed: number;
    items?: ReadonlyArray<{ index: number }>;
    dialogueOptions?: ReadonlyArray<{ index: number }>;
    pois?: ReadonlyArray<{ index: number }>;
  };
  /** Spatial namespace — present only when the game has boards. */
  grid?: {
    targetableCells?: readonly Cell[];
    actionTargeting?: Readonly<Record<string, { targetableCells: readonly Cell[] }>>;
  };
  // RFC-004 adds an optional `zones` namespace here.
}
```

The deprecated `GridTurnView` alias keeps the v0.12 flat-hud shape via an
intersection type so existing Zonoid views type-check; the solver and replay
checker accept both shapes during the deprecation window (they only read the
neutral core).

### `TurnReducer`

```ts
export interface TurnReducer<TLevel, TState, TView extends TurnView = TurnView> {
  init(level: TLevel, seed: number): TState;
  apply(state: TState, action: SubmittedAction): TState;
  view(state: TState): TView;
  // RFC-003 adds optional viewFor(state, seat) here.
}
```

Unchanged semantics. The solver, replay checker, and `AgentEnvironment`
already depend only on this triple; they gain the new names and keep old-name
overload aliases.

## Sequential turn discipline and turn order

Sequential play — one seat acts per turn, everyone else waits — is the most
common turn-based cadence and gets first-class support here (the simultaneous
and high-frequency cadences are the same collection model with different
participation; see Appendix A.3). v0.12 has no seat-rotation logic because
its reference consumer is single-seat; multi-seat sequential games need a
deterministic turn-order mechanism.

### `TurnOrder`

A pure, deterministic rotation state the product embeds in `TState`; the SDK
owns the rotation algebra, the product decides when each operation fires:

```ts
export interface TurnOrderState {
  seats: readonly string[];        // rotation order (initiative)
  current: number;                 // index into seats
  direction: 1 | -1;               // reversible (Uno)
  turnNumber: number;              // increments every advance
  round: number;                   // increments when rotation wraps
  pendingExtra?: readonly string[];// queued extra turns, FIFO
  skips?: Readonly<Record<string, number>>; // queued skip counts per seat
}

export function createTurnOrder(seats: readonly string[], first?: number): TurnOrderState;
export function advanceTurn(order: TurnOrderState): TurnOrderState;   // consumes skips/extras deterministically
export function reverseTurnOrder(order: TurnOrderState): TurnOrderState;
export function queueSkip(order: TurnOrderState, seat: string, count?: number): TurnOrderState;
export function queueExtraTurn(order: TurnOrderState, seat: string): TurnOrderState;
export function eliminateSeat(order: TurnOrderState, seat: string): TurnOrderState;
export function reorderSeats(order: TurnOrderState, seats: readonly string[]): TurnOrderState; // re-rolled initiative
export function activeSeat(order: TurnOrderState): string;
```

Deterministic resolution rules (contractual, golden-tested): queued extra
turns resolve before rotation advances; skips consume before a seat becomes
active; eliminating the active seat advances immediately; wrap-around
increments `round` exactly once per full rotation regardless of skips.

### The sequential game loop

How a sequential game composes the pieces — this is the integration recipe:

1. `TState` embeds a `TurnOrderState`; `view`/`viewFor` expose
   `participation: { mode: 'sequential', activeSeat: activeSeat(order) }`.
2. **The structure is always simultaneous collection; sequencing is a
   legality rule.** Every turn collects exactly one intent per seat (the
   submitting seat travels as an optional `seat` field on `SubmittedAction`,
   or via the host/protocol), and any seat that submits nothing
   auto-contributes `wait`. What makes play "sequential" is that the
   non-active seats' legal-action sets normally contain only `wait` —
   `apply` validates each seat's intent against that seat's legal set, the
   same rule that rejects any other illegal action. Nothing structural
   privileges the active seat.
3. **Turn advancement is product policy over SDK rotation**: an explicit
   `end_turn` action, exhaustion of an action budget (`actionsUsed` vs a
   per-turn allowance), or a settlement consequence — whichever the product
   chooses calls `advanceTurn` inside `apply`.
4. Legal-action enumeration for a non-active seat returns `wait` plus any
   **reaction-class actions currently legal for that seat** (see below), so
   agents and UIs in every seat always see a truthful action surface.

### In-turn reactions fall out of this structure

Because every seat submits an intent every turn, counter-play needs no
second machinery. The pattern: the active seat's action does not commit
immediately — it becomes visible **pending state**; the next collection
turn's legality gives seats holding a legal response (a counter card, a
trap, an interrupt ability) a non-empty reaction set while everyone else
defaults to `wait`; responses stack; a collection round in which every
eligible seat waits closes the exchange and the pending stack unwinds LIFO.
RFC-004's priority window is exactly this loop packaged as a mechanism —
"my turn, but you may counter under the same structure" — and it works
identically for card counters and grid overwatch, at player pace or at
tick rate.
5. `AgentEnvironment` (single-agent today) plays the active seat and lets
   the reducer drive other seats (behavior trees); multi-agent episodes
   (RFC-003 follow-up) solicit each seat's driver only when that seat is
   active.
6. Turn-scoped effects ("until end of turn") key off `turnNumber`/`round`
   boundaries — the same hooks RFC-004 durations use.

Grid and card games share every line of this recipe; only step 3's policy
differs per product.

## Deprecation mechanics

```ts
/** @deprecated Renamed to TurnReducer in v0.13; alias removed in v1.0. */
export type GridReducer<TLevel, TState, TView extends GridTurnView = GridTurnView>
  = TurnReducer<TLevel, TState, TView>;

/** @deprecated Renamed to solveLevel in v0.13; alias removed in v1.0. */
export const solveGridLevel = solveLevel;
```

- Type aliases and const re-exports only — zero runtime cost, zero behavior
  change.
- Docs pages switch to neutral names; a migration table lands in
  `docs/releases.md`.
- v1.0 deletes the aliases. Nothing else in this RFC is breaking.

## Test plan

- Existing suite passes untouched (aliases make v0.12 imports resolve).
- New: type-level tests asserting alias equivalence; solver/replay golden
  tests run once through old names, once through new, identical transcripts.

## Historical open questions

Implementation decisions: RFC-004 extends the closed parameter union with
`'targets'` plus `targetSpecId`; `TurnView` uses defaulted grid/zone generics
and optional JSON-friendly namespaces.

1. `params` is a closed union; RFC-004 targeting may want richer shapes.
   Options: extend the union (`'targets'`) vs. a parallel declarative
   targeting spec on `ActionDefinition`. Leaning: keep `params` closed here,
   decide in RFC-004.
2. Whether `TurnView.grid` should be generic (`TurnView<TGridExt, TZoneExt>`)
   instead of optional fields. Optional fields chosen for JSON-transcript
   friendliness; revisit if namespace collisions appear.
