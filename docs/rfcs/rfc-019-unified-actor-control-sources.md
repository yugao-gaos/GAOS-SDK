# RFC-019 — Unified actor control sources

Status: **implemented** · Target: v0.29 · Compatibility: additive host-side
control contracts; no reducer or replay format break · Depends on:
[RFC-001](rfc-001-neutral-core.md),
[RFC-003](rfc-003-information-partitions.md),
[RFC-006](rfc-006-session-kernel.md),
[RFC-013](rfc-013-ecosystem-bridges-and-benchmark-tooling.md),
[RFC-014](rfc-014-interoperability-and-dynamic-control-evidence.md),
[RFC-018](rfc-018-unified-session-lifecycle.md)

## 1 — Problem

Products commonly expose two unrelated control paths:

- player-controlled entities receive human or agent input through a session
  seat; and
- NPCs receive product orders from a behavior tree inside or beside the
  reducer.

That split makes an otherwise ordinary gameplay feature—temporarily possessing
an NPC, assigning an agent to an allied unit, or replacing a disconnected
player with a behavior tree—require duplicated entity logic or an unsafe
conversion between `NPC` and `Player` types.

The entity is not the controller. “Player” and “NPC” describe current product
roles or presentation, not two incompatible simulation primitives. Movement,
targeting, resources, damage, settlement, and replay should not care whether a
legal action originated from a behavior tree, a human input device, or an
agent driver.

The current boundaries are close but not yet joined:

- `evaluateBehaviorTree` may return any product-defined result;
- human and agent sessions submit `SubmittedAction`;
- `AgentDriver` returns a `SubmittedAction`;
- `SeatControlLedger` can assign a logical seat to a human, agent, or service;
  and
- the reducer already resolves canonical submitted actions independently of
  their authoring UI.

Products still need one explicit contract that adapts these sources to the
same action path without conflating an actor with a logical seat.

## 2 — Decision

GAOS standardizes a host-side **control source** contract. A control source
receives a restricted observation plus the concrete legal actions for one
control subject and returns at most one `SubmittedAction`.

The initial source kinds are:

- **behavior tree** — a deterministic or product-authored policy;
- **human input** — UI, device, accessibility, remote-player, or queued human
  input; and
- **agent input** — a local policy, model provider, MCP-capable CLI, or other
  `AgentDriver`.

All three converge before command validation:

```text
behavior tree ─┐
human input ───┼─→ ControlSource ─→ SubmittedAction ─→ validation ─→ reducer
agent input ───┘
```

This RFC does not make `NPC` inherit from `Player` and does not require either
term in SDK state. Products model a neutral controllable actor and bind a
control source to it.

The authoritative reducer remains synchronous and deterministic. Human,
network, and model latency stays in the host. Only the selected canonical
action reaches the reducer.

## 3 — Actor, subject, seat, and source

The following identities are distinct:

- **actor** — a product-owned entity that may carry out gameplay actions;
- **control subject** — the actor or logical seat for which a source is
  currently choosing;
- **logical seat** — a stable session participant with observation,
  participation, authority, outcome, and evidence consequences;
- **control source** — the current behavior-tree, human-input, or agent-input
  strategy;
- **controller** — the RFC-013/RFC-014 authority currently permitted to submit
  for a logical seat; and
- **connection** — host-owned transport state.

One logical seat may control several actors. One actor does not become a seat
merely because a human or agent temporarily controls it.

A product promotes an actor to a logical seat only when it needs one or more
of:

- independent command authority;
- a separately restricted observation;
- independent participation or turn order;
- separately attributed rewards or outcomes;
- controller epochs or signed evidence; or
- direct use as an `AgentEnvironment` or `MultiAgentEnvironment` participant.

Because the logical seat set is stable, a potentially promotable actor seat is
declared at session genesis and may remain dormant until product
`Participation` activates it. Possession does not dynamically add a seat.

## 4 — Control-source API

The additive product-facing contract is:

```ts
type ControlSourceKind =
  | 'behavior-tree'
  | 'human-input'
  | 'agent-input';

type ControlSubject =
  | {
      kind: 'actor';
      actorId: string;
      /** Seat whose authority admits this actor-scoped action, when any. */
      seat?: string;
    }
  | {
      kind: 'seat';
      seat: string;
    };

interface ControlContext<TObservation> {
  subject: ControlSubject;
  observation: TObservation;
  legalActions: readonly SubmittedAction[];
  systemActions?: readonly SubmittedAction[];
  tick: number;
  signal?: AbortSignal;
}

interface ControlDecision {
  action: SubmittedAction;
}

interface ControlSource<TObservation = unknown> {
  readonly id: string;
  readonly kind: ControlSourceKind;
  reset?(): void | Promise<void>;
  decide(
    context: ControlContext<TObservation>,
  ): ControlDecision | null | Promise<ControlDecision | null>;
}
```

`id` identifies a host-side source instance. It is not a real-world identity,
an authorization credential, or replay evidence.

`null` means that the source produced no action. It does not silently mean
`wait`, does not bypass required participation, and does not authorize an
input-free tick. The host applies the product's declared timeout or fallback
policy.

The SDK exports the contracts, adapters, and registry from `./control`:

```ts
class ControlSourceRegistry<TObservation = unknown> {
  register(
    source: ControlSource<TObservation>,
    options?: { replace?: boolean },
  ): this;
  unregister(sourceId: string): boolean;
  get(sourceId: string): ControlSource<TObservation> | undefined;
  require(sourceId: string): ControlSource<TObservation>;
  list(): ControlSource<TObservation>[];

  bind(subject: ControlSubject, sourceId: string): boolean;
  unbind(subject: ControlSubject): boolean;
  boundSource(
    subject: ControlSubject,
  ): ControlSource<TObservation> | undefined;
  decide(
    context: ControlContext<TObservation>,
  ): Promise<ControlDecision | null>;
}
```

`bind` is idempotent for an unchanged source. Rebinding, replacing, unbinding,
or unregistering aborts affected in-flight requests. If a source ignores its
abort signal and finishes later, the registry discards that stale decision.

The registry is a host utility, not authoritative game state. When changing a
binding has gameplay consequences, the product records an ordinary
deterministic action or seat-control transition as described below.

## 5 — Source adapters

### 5.1 Behavior tree

A behavior-tree adapter projects its leaf result into a legal
`SubmittedAction` through `fromBehaviorTree`:

```ts
const behaviorTreeSource = fromBehaviorTree(
  'guard-policy',
  guardTree,
  guardTreeAdapter,
);
```

The tree reads the same restricted snapshot represented by `observation`.
Leaves select an action; they do not mutate authoritative state. The reducer
performs the mutation after ordinary validation and admission.

Products may keep reducer-internal behavior trees for actors that are always
autonomous. An actor that can switch to human or agent control needs an
explicit externally controlled mode or must move its tree decision to the
control-source boundary. The same actor must not receive both an internal tree
order and an external order for one tick unless the product specifies and
tests deterministic precedence.

### 5.2 Human input

A human-input adapter may await UI or transport input through
`fromHumanInput`:

```ts
const humanSource = fromHumanInput(
  'local-player-one',
  (context) => inputQueue.next(context.subject, context.signal),
);
```

The adapter must reject or ignore stale input tied to an earlier subject,
tick, observation revision, or controller epoch. The ordinary session layer
remains responsible for idempotency and authoritative command admission.

### 5.3 Agent input

An agent-input adapter wraps the existing provider-neutral `AgentDriver`:

```ts
function fromAgentDriver<TObservation>(
  driver: AgentDriver<TObservation>,
): ControlSource<TObservation> {
  return {
    id: driver.id,
    kind: 'agent-input',
    reset: () => driver.reset?.(),
    async decide(context) {
      const decision = await driver.act({
        observation: context.observation,
        legalActions: context.legalActions,
        systemActions: context.systemActions,
        step: context.tick,
        signal: context.signal,
      });
      return { action: decision.action };
    },
  };
}
```

Provider reasoning, messages, token usage, and raw responses remain
operational metadata. They do not enter reducer input unless a product
explicitly defines gameplay semantics for them.

## 6 — Actor-scoped possession

Actor-scoped possession is the lightweight path. The existing logical seat
retains authority while the selected actor changes.

The product encodes actor identity in its opaque action payload:

```ts
const action: SubmittedAction = {
  id: 'actor.move',
  seat: 'north',
  payload: {
    actorId: 'guard-17',
    direction: 'north',
  },
};
```

The SDK does not interpret `actorId`. Product `validateCommand` and reducer
logic must establish that:

- the submitting seat may control that actor at the current revision;
- the action is legal for that actor;
- the actor is not concurrently controlled by an incompatible source; and
- the action targets the intended actor without trusting presentation state.

Starting or ending possession is an ordinary deterministic gameplay action
when it changes authoritative actor ownership, eligibility, cooldowns, or
state. A local UI selection that changes no authoritative rule may remain
presentation state.

Actor-scoped possession does not create a new controller epoch when the same
logical seat and controller retain authority. It also does not provide
independent observation, reward, signature, or outcome identity for the
actor.

## 7 — Logical-seat promotion and controller handoff

An actor uses the logical-seat path when control itself is independently
authoritative. The product:

1. declares the seat at genesis;
2. supplies `viewFor(state, seat)`;
3. projects its participation and legal actions;
4. assigns the active human, agent, or service through
   `SeatControlLedger`; and
5. submits the selected `SubmittedAction` under that seat and controller
   epoch.

A behavior-tree source maps to the existing seat-controller kind `service`.
A human-input source maps to `human`; an agent-input source maps to `agent`.
Control-source kind describes decision strategy. `SeatControllerKind`
describes authority. They are related but not interchangeable claims.

Changing a seat from behavior tree to human or agent control starts a new
seat-control epoch unless the existing RFC-013/RFC-014 rules classify the
operation as a reconnect of the same controller and key. Voluntary transfer
uses controller-handoff evidence; forced substitution uses an explicit
host-policy authorization.

A host-side source binding cannot override the active ledger epoch. A command
from a newly selected source is rejected until its controller is
authoritative for the target transition revision.

## 8 — Timing, fallback, and handoff boundaries

Source changes take effect at an explicit boundary:

- an actor-scoped gameplay change takes effect at the reducer tick that
  accepts the corresponding command;
- a logical-seat authority change takes effect at its committed transition
  revision; and
- a host-only adapter replacement that changes neither gameplay nor authority
  takes effect before the next decision request.

An in-flight decision from the old source is canceled when possible and
discarded when it returns. It must never be relabeled as a decision from the
new source.

Products declare one fallback for a missing decision:

- submit an explicit legal wait action;
- advance an input-free tick when the `TickReducer` and participation policy
  permit it;
- invoke a named fallback control source, commonly a behavior tree;
- pause the session; or
- apply an authored elimination, vacancy, or timeout policy.

Fallback selection is host policy translated into ordinary deterministic
inputs. Wall-clock deadlines and provider failures do not enter reducer
state directly.

## 9 — Determinism, replay, and evidence

Every source produces the same canonical action before the reducer advances.
Therefore:

- action validation is source-independent;
- replays store the chosen action, not a requirement to rerun the source;
- replay verification does not call human UI, an agent provider, or a
  behavior tree that was externalized as a source;
- rollback reuses recorded actions at their original ticks; and
- a source swap cannot rewrite already accepted actions.

A behavior tree may be deterministic, but its selected external action is
still recorded. This protects replay from later tree edits and makes human,
agent, and tree control observationally equivalent at the reducer boundary.

`ControlSource.kind` and `ControlSource.id` are not proof that a human, model,
or behavior tree acted alone. Independently verifiable controller claims use
RFC-014 controller epochs, signatures, and policy evidence. Benchmark claims
continue to use RFC-015 and RFC-016 artifacts.

## 10 — Observation and security boundary

A source receives only the observation it is allowed to use:

- seat-scoped sources receive `viewFor(state, seat)`;
- actor-scoped sources receive a product projection no more privileged than
  their authorizing seat; and
- a source never receives authoritative full state merely because it is a
  behavior tree or runs in the host process.

Concrete legal actions are capabilities for one decision request, not durable
authorization. The session still validates the submitted seat, controller
epoch, participation window, command schema, and current game state.

Products must not trust an actor ID, source ID, UI binding, model response, or
behavior-tree leaf as authority. Those values are inputs to product
validation. The active seat-control epoch and authoritative reducer state
remain the source of truth.

## 11 — Compatibility and migration

The change is additive:

1. define product `ControlSubject` and `ControlSource` adapters;
2. make switchable behavior-tree leaves return the same product action shape
   used by human and agent input;
3. route all three source kinds through the same legality and submission
   path;
4. encode actor scope in product-owned `SubmittedAction.payload`;
5. add an explicit control mode or precedence rule for previously internal
   NPC behavior;
6. record possession and fallback effects as ordinary deterministic commands;
7. promote only actors requiring independent authority or observation to
   predeclared logical seats; and
8. use `SeatControlLedger` for security-relevant source handoffs.

Existing `BehaviorTreeAdapter`, `AgentDriver`, `SubmittedAction`,
`AgentEnvironment`, `MultiAgentEnvironment`, reducer, transcript, replay, and
seat-control formats retain their current meaning. Adapters compose those
contracts rather than replacing them.

Products may migrate one actor class at a time. Permanently autonomous NPCs
need no change.

## 12 — Release gate

RFC-019 is complete when conformance fixtures establish:

1. behavior-tree, human-input, and agent-input adapters can produce the same
   legal `SubmittedAction` for one control subject;
2. those equivalent actions produce identical reducer states, transcripts,
   and replays;
3. an actor may switch among all three sources without changing its entity
   identity or component data;
4. actor-scoped possession retains the authorizing logical seat and rejects
   commands for actors it may not control;
5. a promoted actor seat receives only its `viewFor` observation and its own
   legal actions;
6. a behavior-tree-to-human or behavior-tree-to-agent seat handoff rejects
   stale controller epochs;
7. an in-flight decision from a replaced source cannot be admitted after the
   handoff boundary;
8. every missing-decision fallback becomes an explicit deterministic input or
   permitted input-free tick;
9. replay verification never reruns an external control source;
10. source metadata cannot bypass command validation or seat authority; and
11. existing permanently autonomous NPC and ordinary player paths remain
    compatible.

Reference-product acceptance additionally requires one scenario in which a
human possesses an NPC, one in which an `AgentDriver` controls that same
actor, and one in which the behavior tree resumes control.

## 13 — Rejected alternatives

### Make `NPC` inherit from `Player`

Rejected. Entity role and input authority are independent axes. Inheritance
would leak UI, account, seat, or transport assumptions into simulation
entities and still would not define replay-safe handoff.

### Add human and agent callbacks directly to the behavior-tree adapter

Rejected. A behavior tree is one decision strategy, not the owner of every
input strategy. Blocking UI or provider calls inside tree evaluation would
also cross the synchronous reducer boundary.

### Create a logical seat for every NPC

Rejected as a default. It unnecessarily expands participation, observations,
outcomes, controller evidence, and session cardinality. Products may
predeclare an NPC seat when those semantics are intentional.

### Store live source objects in reducer state

Rejected. Human queues, sockets, provider clients, abort signals, and mutable
driver conversations are nondeterministic and not replayable. Reducer state
stores only product control rules and accepted gameplay consequences.

### Infer the source from action contents

Rejected. Identical actions must have identical gameplay semantics regardless
of origin. Source identity is host/evidence metadata, not reducer branching.

## 14 — Out of scope

RFC-019 does not standardize product actor schemas, ECS components, possession
rules, behavior-tree node vocabularies, input-device APIs, model providers,
prompt formats, animation, camera ownership, UI focus, account identity,
matchmaking, or a universal actor-action payload.

It does not claim that labeling a source `human-input` or `agent-input` proves
who authored an action. It does not permit dynamic logical-seat creation.

The SDK standardizes the control boundary. Products continue to own actors,
legal actions, control eligibility, fallback policy, and presentation.
