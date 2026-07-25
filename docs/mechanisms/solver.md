# Minimum-action solver

`solveLevel` performs breadth-first search over any deterministic
`TickReducer`. The first win it finds has minimum submitted-action depth under
the supplied action enumeration and state-equivalence policy.

## Basic use

```ts
const result = solveLevel(reducer, level, {
  maxActions: 20,
  maxNodes: 1_000_000,
  seed: 42,
  includeAction: (action) => action.id !== 'Restart',
});
```

The result reports:

- `min`: shortest action count, or `null` when none was found;
- `actions`: the canonical winning sequence, or `null`;
- `explored`: number of unique states admitted, including the initial state;
- `capped`: whether the node limit stopped search.

Search depths begin at zero. An already won initial state is reported as a
zero-action solution.

`solveLevel` is a perfect-information search helper: it calls `reducer.view`,
not `viewFor`. Do not use it as an imperfect-information policy evaluator.
Belief-state search and information-set planning remain product or future SDK
work.

## Action enumeration

By default, `enumerateActions` expands the current tick view:

- `none`: one `{ id }` action;
- `index`: one action for every distinct index found in items, dialogue options,
  then points of interest; and
- `xy`: per-action target cells when present, otherwise shared target cells.
  Multi-board views produce one action per cell with its `boardId`; and
- `targets`: one action per complete tuple in the referenced target-choice
  set. Enumeration rejects a truncated set instead of silently searching an
  incomplete legal surface.

Enumeration order breaks ties between equally short solutions. Override
`actions(view)` for richer parameter schemas or when indexed values apply only
to particular actions. `includeAction` can remove legal but search-unhelpful
commands such as restart.

An exception from `reducer.apply` marks that candidate invalid and search
continues. Failed states are not expanded; won states return immediately.

The solver is intentionally for discrete decision spaces. Do not expand a
60 Hz tick stream directly; expose macro decisions or another bounded
decision-space adapter.

## State identity

The default key shallow-copies object state, removes top-level `lastEvents`,
`actionsUsed`, `narrative`, and `log`, filters cosmetic entities, then applies
`JSON.stringify` and an internal compact fingerprint.

That default is a convenience, not a universal semantic model. Supply
`stateKey(state)` when:

- other volatile presentation fields exist;
- property or entity ordering is not canonical;
- hidden rule state affects future outcomes;
- cosmetic classification differs; or
- the state is not a plain serializable object.

Two states with one key are treated as equivalent forever. Omitting relevant
state can produce a false “unsolvable”; retaining irrelevant history can make
search unnecessarily large.

## Bounds and performance

The default `maxNodes` is 5,000,000. `maxActions` bounds solution depth, while
`maxNodes` bounds memory/work. Hitting `maxNodes` returns `capped: true`; reaching
the depth limit or exhausting the frontier returns `capped: false` with no
solution.

The solver proves minimum action count only for the reducer version, seed,
available actions, filters, and state key used in that run. Record those inputs
when using results to author [star thresholds](scoring.md).

## Zonoid example

Zonoid runs `solveLevel` against the same universal reducer used in play
when validating authored boards. The solver enumerates canonical movement,
Use, Talk, Inspect, and targeted actions, finds a minimum-action winning route,
and supplies a baseline for three- and two-star thresholds. Product state such
as fired events, delivered objects, and dialogue evidence stays in the injected
reducer and its state key.

<figure class="mechanism-video">
  <video controls muted playsinline preload="metadata" poster="/mechanisms/solver-poster.jpg" aria-label="Focused Zonoid solver demo board recording">
    <source src="/mechanisms/solver.mp4" type="video/mp4">
    Your browser does not support embedded video.
  </video>
  <figcaption>Focused Zonoid demo board: the solver computes and replays the seven-action minimum through a box push, conveyor, gate, and exit.</figcaption>
</figure>
