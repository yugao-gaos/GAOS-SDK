# RFC-018 — Unified session lifecycle and runner

Status: **proposed** · Target: v0.28 · Compatibility: additive session client
and runner contracts, followed by deprecation of duplicate product wrappers ·
Depends on:
[RFC-006](rfc-006-session-kernel.md),
[RFC-013](rfc-013-ecosystem-bridges-and-benchmark-tooling.md),
[RFC-015](rfc-015-verifiable-benchmark-publication.md)

## 1 — Problem

GAOS already has one deterministic session kernel and one product-neutral tick
protocol. It also has benchmark planning, checkpointing, scoring, packing, and
verification. Product integrations can nevertheless end up creating a second
live-session abstraction for benchmarks because the SDK client does not yet
standardize durable attachment, finalization, presentation pacing, or
in-progress continuation.

That split is architecturally wrong. A benchmark action is an ordinary game
action. Watching a benchmark does not change simulation semantics. Reattaching
after a transport failure does not create a new run. Official scoring and
verification add policy and evidence; they do not create another kind of live
session.

Separate normal and benchmark runners risk differences in:

- action validation and idempotency;
- observation and cursor handling;
- level transition order;
- conversation reset behavior;
- presentation blocking;
- reconnect and authentication refresh;
- finalization and replay construction; and
- transcript and score evidence.

This RFC defines one lifecycle for normal play, Coach-style guided play,
autonomous play, watched or headless benchmarks, and future arena modes.

## 2 — Decision

There is exactly one live-session protocol and one session runner.

Every live session has the same lifecycle:

```text
create or attach → observe ↔ act → finalize → close
```

The operations have the following meanings:

- **create** asks a host to create one authoritative session under an explicit
  policy and returns a handle at its durable head;
- **attach** obtains a new handle to an existing authoritative session at its
  durable head; it never rolls gameplay back, forks the transcript, or creates
  a new run;
- **observe** returns the latest seat-scoped authoritative observation;
- **act** submits one idempotent protocol command and advances through the
  ordinary tick protocol;
- **finalize** closes the authoritative record to further gameplay and returns
  its outcome and any policy-selected evidence or evaluation;
- **close** releases only the caller's local resources. It does not delete,
  finalize, abandon, or otherwise mutate the authoritative session.

A benchmark is a normal session whose creation policy selects an authored
evaluation plan, official scoring, controller identity, durable evidence, and
publication eligibility. The base lifecycle does not contain a benchmark-only
method, handle, room, or runner.

`runBenchmark` remains the SDK's batch planning and aggregation API. It must
execute each episode through the same `SessionHandle` and `SessionRunner` as
ordinary play; it is not a second live-session implementation.

## 3 — Layer boundaries

The unified design has five layers:

1. **`SessionKernel`** owns deterministic ingestion, resolution, observations,
   transcripts, and replay projection as specified by RFC-006.
2. **Host adapters** own HTTP or other transport, storage, credentials,
   authorization, expiry, and authoritative attestation issuance.
3. **`SessionClient`** implements the product-neutral wire operations and
   cursor/idempotency checks.
4. **`SessionHandle` and `SessionRunner`** provide the common live-session and
   agent-execution lifecycle.
5. **Benchmark orchestration** authors episode plans, checkpoints completed
   work, aggregates scores, and packages RFC-015 evidence by using layer 4.

Products continue to own game rules, level catalogs, story ordering, scoring
plugins, identity providers, leaderboards, publication policy, storage, and
presentation. GAOS owns the common contracts, deterministic semantics,
portable evidence shapes, and conformance tests.

## 4 — Session policy

Differences between normal and evaluated play are explicit policy, not
different methods:

```ts
interface SessionPolicy {
  evaluation:
    | { kind: 'none' }
    | { kind: 'practice'; evaluator?: string }
    | {
        kind: 'official';
        benchmarkId: string;
        benchmarkVersion: string;
        manifestDigest: string;
      };
  durability: {
    attachable: boolean;
    retention?: { kind: 'host-policy'; policyId: string };
  };
  evidence:
    | { kind: 'none' }
    | { kind: 'replay' }
    | {
        kind: 'verification';
        attachReceipts?: boolean;
        verifierReference?: JsonObject;
      };
  publication:
    | { kind: 'none' }
    | { kind: 'eligible'; policyId: string; policyVersion: string };
  controller?: SessionControllerIdentity;
  extensions?: ProtocolExtensions;
}

interface SessionControllerIdentity {
  kind: 'human' | 'provider' | 'cli' | 'local-agent' | 'mixed';
  id: string;
  provider?: string;
  model?: string;
  version?: string;
}
```

The host validates and pins the accepted policy at creation. A submitted
command cannot change it. An attach request can prove that it is compatible
with the pinned controller identity but cannot replace that identity.

`SessionPolicy` is product-neutral. Products may offer presets named Story,
Challenge, Coach, Arena, or Benchmark, but those names do not enter the SDK
state machine.

## 5 — Client and handle API

### 5.1 Low-level client

The product-neutral client extends its existing operations:

```ts
interface SessionAttachRequest {
  participantId?: string;
  requestId: string;
  controller?: SessionControllerIdentity;
  extensions?: ProtocolExtensions;
}

interface SessionAttach<TObservation> {
  sessionId: string;
  tick: TObservation;
  binding: SessionBinding;
  receipt?: SessionAttachReceipt;
  extensions?: ProtocolExtensions;
}

interface SessionFinalizeRequest {
  requestId: string;
  metadata?: JsonObject;
  extensions?: ProtocolExtensions;
}

interface SessionResult<TOutcome = JsonValue> {
  sessionId: string;
  status: 'finalized';
  outcome: TOutcome;
  replay?: JsonValue | string;
  evaluation?: JsonObject;
  artifacts?: readonly SessionArtifactReference[];
  extensions?: ProtocolExtensions;
}

class SessionClient {
  createSession<TRequest, TObservation>(
    request: TRequest,
    participantId?: string,
    options?: SessionCallOptions,
  ): Promise<SessionStart<TObservation>>;

  attachSession<TObservation>(
    sessionId: string,
    request: SessionAttachRequest,
    options?: SessionCallOptions,
  ): Promise<SessionAttach<TObservation>>;

  getTickEnvelope<TObservation>(
    sessionId: string,
    options?: SessionCallOptions,
  ): Promise<TickResult<TObservation>>;

  submitIntent<TCommand, TObservation>(
    sessionId: string,
    command: TCommand,
    options?: SubmitIntentOptions,
  ): Promise<TickResult<TObservation>>;

  finalizeSession<TOutcome>(
    sessionId: string,
    request: SessionFinalizeRequest,
    options?: SessionCallOptions,
  ): Promise<SessionResult<TOutcome>>;
}
```

`attachSession` replaces product-specific names such as
`resumeBenchmarkSession`. `finalizeSession` replaces product-specific submit
methods. Product adapters may add typed request, observation, outcome, and
extension helpers without changing the lifecycle.

### 5.2 High-level handle

Both creation and attachment return the same handle type:

```ts
interface SessionHandle<TCommand, TObservation, TOutcome = JsonValue> {
  readonly sessionId: string;
  readonly participantId: string;
  readonly policy: SessionPolicy;
  readonly status: 'active' | 'terminal' | 'finalized' | 'closed';

  observe(options?: SessionCallOptions): Promise<TickResult<TObservation>>;

  act(
    command: TCommand,
    options?: SubmitIntentOptions,
  ): Promise<TickResult<TObservation>>;

  finalize(
    request?: Partial<SessionFinalizeRequest>,
  ): Promise<SessionResult<TOutcome>>;

  close(): void | Promise<void>;
}
```

The handle may cache the most recent authoritative observation, but
`observe()` always has a transport-neutral asynchronous contract. A local
implementation may resolve immediately.

`close()` is idempotent and local. Cleanup of expired or abandoned
authoritative records is host retention policy, never an implicit side effect
of closing a UI, CLI, socket, or agent process.

## 6 — Attachment and continuation

Attachment is available to every session whose pinned policy says
`attachable: true`. It is not intrinsically a benchmark operation.

The host must:

1. authenticate the caller and authorize its seat;
2. load the current durable session head;
3. reject finalized, expired, incompatible, or unauthorized attachment;
4. preserve the existing transcript and gameplay revision exactly;
5. return the current observation and binding; and
6. when required by evidence policy, verify the stored prefix and issue an
   attach receipt.

An exact retry using the same `requestId` at the same revision returns the
same receipt. Reusing that request ID after gameplay has advanced is rejected.
Attachment cannot accept a requested older cursor as a rollback target.

The optional portable receipt is generic:

```ts
interface SessionAttachReceipt {
  schema: 'gaos.session-attach-receipt.v1';
  sessionId: string;
  requestId: string;
  sequence: number;
  revision: number;
  transcriptDigest: string;
  stateDigest: string;
  attachedAt?: number;
  previousReceiptDigest?: string;
  receiptDigest: string;
  controller?: SessionControllerIdentity;
  extensions?: ProtocolExtensions;
}
```

`attachedAt` is an operational claim unless a trusted time authority attests
it. A digest chain proves consistency of the recorded receipts; it does not by
itself prove model identity, absence of human intervention, or wall-clock
fairness. Those remain separate RFC-014/RFC-015 facts.

The SDK provides canonical receipt construction and independent chain
verification. Only an authoritative host may issue a receipt for its session.

## 7 — Finalization

Every session may be finalized, including ordinary and practice sessions.
Policy controls which fields are produced:

- an unevaluated session returns its terminal outcome and may omit replay;
- a replay-enabled session returns or references a portable replay;
- a practice evaluation may return non-publishable scores;
- an official evaluation returns the manifest-bound score and verification
  facts needed by RFC-015;
- a publication-eligible result may include immutable replay-kit and
  verification-kit references.

Finalization has exactly-once semantics:

- it is accepted only when the session policy permits finalization and the
  session satisfies its terminal/coverage requirements;
- the first accepted `requestId` fixes the immutable result;
- an exact retry returns the same result;
- later gameplay submissions are rejected;
- conflicting finalization metadata or identity is rejected; and
- finalization never recomputes gameplay through a product-specific path.

The authoritative transcript is projected through RFC-006 replay
finalization. RFC-015 packing and publication consume that result rather than
reconstructing a second transcript.

## 8 — One session runner

The SDK exports one runner:

```ts
type SessionPacing = 'paced' | 'unpaced';

interface SessionRunPolicy {
  pacing: SessionPacing;
  conversation: 'continuous' | 'fresh-per-episode';
  finalize: 'automatic' | 'caller';
}

interface SessionPresentation<TObservation> {
  present(
    result: TickResult<TObservation>,
    signal?: AbortSignal,
  ): void | Promise<void>;
}

interface SessionRunEvents<TObservation, TOutcome> {
  onObservation?(result: TickResult<TObservation>): void | Promise<void>;
  onDecision?(decision: AgentDecision): void | Promise<void>;
  onEpisodeChange?(episode: SessionEpisodeIdentity): void | Promise<void>;
  onAttached?(receipt?: SessionAttachReceipt): void | Promise<void>;
  onFinalized?(result: SessionResult<TOutcome>): void | Promise<void>;
}

function runSession<TCommand, TObservation, TOutcome>(
  session: SessionHandle<TCommand, TObservation, TOutcome>,
  driver: AgentDriver<TObservation>,
  options: {
    policy: SessionRunPolicy;
    presentation?: SessionPresentation<TObservation>;
    events?: SessionRunEvents<TObservation, TOutcome>;
    signal?: AbortSignal;
  },
): Promise<SessionRunResult<TOutcome>>;
```

In `paced` mode, the runner awaits `presentation.present` after each resolved
transition before requesting the next agent decision. Coach and watched Arena
modes can therefore guide or display every transition effectively.

In `unpaced` mode, presentation cannot block gameplay. Observations and
presentation events are still durably recorded or emitted so a UI can follow
live, catch up, or replay later. Pacing never changes accepted commands,
episode order, transcript contents, score, or evidence.

`fresh-per-episode` resets the driver when the authoritative observation
announces an episode transition. It does not create a new game session unless
the authored plan itself uses one session per episode. Transport attachment
also starts a fresh conversation when product policy requires it, but it
continues the same authoritative session and transcript.

Human actions and Coach guidance are runner inputs or optional extensions.
They do not require a `CoachSession` subtype. A product may decorate a
`SessionHandle` with guidance queues, presentation, speech, or takeover
controls while all actions continue through `act`.

## 9 — Benchmark orchestration

RFC-013/RFC-015 benchmark APIs remain responsible for:

- manifest validation;
- canonical task, seed, and episode planning;
- bounded parallel scheduling;
- completed-episode checkpoints;
- resource observations;
- scoring and aggregation;
- bundle packing; and
- independent verification.

They gain a session factory rather than a second runner:

```ts
interface BenchmarkSessionFactory<TCommand, TObservation, TOutcome> {
  createEpisode(
    plan: BenchmarkEpisodePlan,
  ): Promise<SessionHandle<TCommand, TObservation, TOutcome>>;

  attachEpisode?(
    checkpoint: BenchmarkInProgressCheckpoint,
  ): Promise<SessionHandle<TCommand, TObservation, TOutcome>>;
}
```

`runBenchmark` calls `runSession` for each planned episode. A product may map
many plans to one authoritative multi-level session or one session per
episode, provided the manifest, ordering, seed, scoring, and replay identity
remain canonical.

The existing `BenchmarkRunCheckpoint.completed` representation remains valid.
An additive in-progress checkpoint may carry an opaque host attachment
reference and attach-receipt digest. The SDK never treats opaque product state
as replay evidence and never permits it to override the authoritative head.

CLI and Desktop are presentation shells around the same calls:

```text
CLI:     attach/create → runSession(unpaced) → finalize
Desktop: attach/create → runSession(paced)   → finalize
```

## 10 — Protocol extensions

Optional evaluation, evidence, and publication data travel in namespaced
protocol extensions. The base tick envelope and command submission remain
unchanged.

Reserved SDK extension names introduced by this RFC are:

- `gaos.session.policy` — the host-accepted session policy identity;
- `gaos.session.episode` — authoritative episode identity and transition;
- `gaos.session.attach` — attach receipt or receipt reference; and
- `gaos.session.finalization` — immutable result and artifact references.

Products use their own namespace for product-specific level, score,
leaderboard, storage, or UI data. Unknown extensions round-trip according to
the existing protocol rules and cannot change deterministic reducer input
unless explicitly mapped by the product.

## 11 — Compatibility and migration

The SDK work is additive:

1. add attach/finalize contracts, receipt verification, `SessionHandle`, and
   `runSession`;
2. adapt the existing local environment and `SessionClient` to conformance
   fixtures;
3. make `runBenchmark` consume the common runner;
4. migrate the reference product's normal, Coach, autonomous, and benchmark
   paths to the same handle;
5. deprecate duplicate product wrappers after parity tests pass; and
6. remove deprecated aliases only at the next documented breaking release.

Existing `createSession`, `getTickEnvelope`, and `submitIntent` behavior does
not change. Existing benchmark manifests, completed-episode checkpoints,
bundles, and verification retain their interpretation.

A product-specific `resumeBenchmarkSession` may temporarily forward to
`attachSession`, and a product-specific `submitSession` may temporarily
forward to `finalizeSession`. They must not remain independent
implementations.

## 12 — Release gate

RFC-018 is complete when conformance tests establish:

1. normal, guided, autonomous, watched benchmark, and headless benchmark play
   submit commands through the same session handle;
2. create and attach return the same handle type and current durable head;
3. attachment cannot roll back, fork, replace identity, or mutate gameplay;
4. exact attachment retries are idempotent and receipt chains independently
   verify;
5. normal and evaluated sessions both use the same finalization operation;
6. exact finalization retries return the same immutable result;
7. paced and unpaced runs produce identical accepted commands, transcripts,
   outcomes, and scores for the same decisions;
8. `fresh-per-episode` resets agent context without changing the authoritative
   game-session identity;
9. closing a client handle never deletes or finalizes authoritative state;
10. interrupted in-progress and between-episode runs attach and continue
    without duplicating accepted actions;
11. `runBenchmark` uses `runSession` and preserves canonical ordering,
    parallelism, checkpoint, scoring, packing, and verification behavior; and
12. no SDK export introduces a benchmark-specific live-session handle or
    runner.

## 13 — Out of scope

RFC-018 does not standardize product mode names, game catalogs, story content,
scores, leaderboards, billing, authentication providers, retention duration,
database layout, Durable Objects, sockets, animation systems, model-provider
APIs, or publication governance.

It does not claim that a replay proves model identity, autonomous control,
hidden-test secrecy, elapsed time, cost, or absence of human intervention.
Those remain separate evidence and authority facts.

The SDK owns one session mechanism. Products own the policy under which they
use it.
