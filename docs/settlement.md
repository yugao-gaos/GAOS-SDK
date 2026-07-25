# Deterministic tick settlement

A tick may contain many resolution steps. The existing settlement worklist
groups those steps into deterministic waves: consequences produced during one
wave become eligible in a later wave of the same tick. Settlement ends when
the worklist is empty.

This is a cascade, not a loop that blindly reruns the complete game reducer.
Each product rule decides whether a consequence belongs to the current tick or
must be deferred to the next one.

```text
submitted intents
       |
       v
simultaneous movement snapshot
       |
       v
wave 0 -> wave 1 -> wave 2 -> ... -> quiescence
            |          |
            |          +-- collision -> landing -> arrival
            +------------- movement -> switch -> environment update
       |
       +-- explicitly deferred work ----------------> next tick
```

## Job contract

Every unit of work has a stable identity and optional ordering policy:

```ts
interface SettlementJob {
  kind: string;
  key: string;
  priority?: number;
  policy?: 'repeat' | 'coalesce' | 'once';
}
```

The identity is the exact `kind + key` pair. Lower priority numbers run first.
Within one wave, remaining ties are ordered by lexical kind, lexical key, then
enqueue sequence. This makes input order relevant only when all explicit fields
tie.

Jobs enqueued by a resolver never run in the current wave. They enter the next
wave, even when their priority is higher than work already being resolved. This
wave barrier is what makes cause and consequence visible in traces.

## Complete example

```ts
type Job =
  | { kind: 'arrival'; key: string; actorId: string; priority: 10 }
  | { kind: 'switch'; key: string; switchId: string; priority: 20; policy: 'coalesce' }
  | { kind: 'gate'; key: string; gateId: string; priority: 30; policy: 'coalesce' };

const result = runSettlementCascade(world, initialArrivals, (job, context) => {
  switch (job.kind) {
    case 'arrival':
      commitArrival(context.state, job.actorId);
      for (const switchId of switchesAtActor(context.state, job.actorId)) {
        context.enqueue({
          kind: 'switch', key: switchId, switchId,
          priority: 20, policy: 'coalesce',
        });
      }
      break;
    case 'switch':
      updateSwitch(context.state, job.switchId);
      for (const gateId of linkedGates(context.state, job.switchId)) {
        context.enqueue({
          kind: 'gate', key: gateId, gateId,
          priority: 30, policy: 'coalesce',
        });
      }
      break;
    case 'gate':
      updateGate(context.state, job.gateId);
      break;
  }
}, { maxSteps: 256 });
```

The resolver mutates the supplied product state. The kernel returns that same
state together with `steps`, `waves`, `trace`, and `deferred` jobs.

## Kernel boundary

`runSettlementCascade` owns product-neutral execution behavior:

- deterministic ordering within every wave;
- same-tick consequence scheduling;
- pending-work coalescing and once-per-tick identities;
- explicit next-tick deferral;
- a maximum-step convergence guard; and
- a causal trace linking each resolved job to the step that scheduled it.

The product owns rule policy and world meaning:

- which intent or mutation creates a job;
- how a job reads or mutates product state;
- the job priority and stable identity;
- whether duplicate work repeats, coalesces while pending, or runs once;
- which consequences are same-tick and which are next-tick; and
- snapshot qualification and commit rules for simultaneous effects.

The kernel does not infer dependencies from state mutations. A rule explicitly
enqueues its consequences, which keeps replay behavior inspectable and prevents
an unrelated board update from accidentally rerunning every mechanic.

## Scheduling policies

Jobs choose one of three policies:

- `repeat`: every enqueue is a distinct resolution step;
- `coalesce`: duplicate pending work with the same identity is merged, but the
  identity may be scheduled again after it runs; this supports dirty-resource
  fixed points; and
- `once`: the identity may run only once during this settlement call.

An identity is the pair `kind + key`. Products can express narrower scopes by
choosing an appropriate key, such as an arrival id, entity id, resource cell,
or rule id.

The duplicate policies differ at scheduling time:

| Policy | Duplicate while pending | Same identity after it runs |
|---|---|---|
| `repeat` | accepted | accepted |
| `coalesce` | rejected | accepted again |
| `once` | rejected | rejected for the rest of the call |

`context.enqueue(job)` returns whether the job was accepted, allowing product
traces or counters to distinguish a new consequence from a suppressed duplicate.

Work that must not resolve in the current tick uses `defer`. Deferred jobs are
returned to the caller and are never executed by that settlement call.

## Required product invariants

A product integration should characterize these boundaries before replacing an
existing loop:

1. Which consequences can create more same-tick work?
2. Which state is frozen for simultaneous qualification?
3. Which mutations are committed only after qualification?
4. Which jobs may run more than once, and what proves convergence?
5. Which landings or updates deliberately wait for the next tick?
6. What deterministic key orders otherwise independent work?

The maximum-step limit is a safety guard, not a game rule. A normal tick should
reach quiescence before the limit; exceeding it reports a cycle or a missing
convergence condition.

## Limit failures and traces

`maxSteps` must be a positive safe integer. When the next queued job would
exceed it, the kernel throws `SettlementLimitError` containing the configured
limit and that `nextJob`. State mutations from earlier steps are not rolled
back, so authoritative callers should resolve against a disposable draft or
transaction when a limit failure must leave persistent state untouched.

Each trace entry records the resolved job, zero-based step, zero-based wave, and
the parent step that enqueued it. Seed jobs have no parent. A trace therefore
forms a causal forest suitable for debugging, replay diagnostics, and agent
explanations without exposing animation timing.

Deferred jobs are returned in defer-call order and never enter duplicate-policy
tracking for future settlement calls. The product decides how to serialize,
revalidate, and seed them on the next tick.

## Composition guidance

- Qualify simultaneous actions from one snapshot before seeding jobs.
- Commit atomic movement before enqueuing [arrival rules](/mechanisms/arrivals).
- Use `coalesce` for dirty resources that may change again after resolution.
- Use `once` for identities such as a one-shot reaction or per-tick trigger.
- Use `repeat` only when every occurrence is meaningful and convergence is
  independently bounded.
- Prefer `defer` when a rule is intentionally next-tick behavior, rather than
  encoding tick delay as an artificial same-tick wave.

## Zonoid example

Zonoid uses settlement as the universal reducer’s same-tick worklist. A
committed move can enqueue arrivals, a switch can update a gate, a belt can
create another movement pass, and a laser or pickup can enqueue damage or
resource work. The platform supplies those jobs and policies; the SDK keeps
ordering, deduplication, and the authored safety bound deterministic.

<figure class="mechanism-video">
  <video controls muted playsinline preload="metadata" poster="/mechanisms/settlement-poster.jpg" aria-label="Zonoid complex deterministic tick-settlement showcase recording">
    <source src="/mechanisms/settlement.mp4" type="video/mp4">
    Your browser does not support embedded video.
  </video>
  <figcaption>One final tick settles allied NPC movement, a Relic projectile, three linked blasts, player damage, rival defeat, the gate and door update, and victory before the worklist reaches quiescence.</figcaption>
</figure>
