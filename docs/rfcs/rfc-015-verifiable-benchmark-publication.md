# RFC-015 — Verifiable benchmark execution and publication

Status: **implemented** · Target: v0.24 · Compatibility: additive benchmark
packages, CLI, artifact, and reference application · Depends on:
[RFC-013](rfc-013-ecosystem-bridges-and-benchmark-tooling.md),
[RFC-014](rfc-014-interoperability-and-dynamic-control-evidence.md)

## 1 — Scope and inherited boundary

RFC-015 turns RFC-013's deterministic benchmark foundations and RFC-014's
portable evidence into an executable, independently verifiable publication
path:

1. remaining broadly applicable research metrics and qualified transforms;
2. a deterministic benchmark runner with resume and resource observations;
3. a portable `.gaos-bench` bundle and independent verifier;
4. a deployable, neutral leaderboard starter with explicit trust labels.

The ownership boundary in RFC-013 §2 is normative. GAOS owns execution,
packaging, replay verification, and score recomputation mechanics. Each
benchmark product owns its tasks, scoring meaning, weights, held-out content,
eligibility, governance, and publication policy.

## 2 — Research metrics and transforms

The optional research package must add the broadly applicable metrics not
shipped in v0.22:

- head-to-head payoff matrix;
- action efficiency and invalid-action rate;
- rating-system adapters.

Win rate with confidence intervals and policy entropy remain the RFC-013
baseline.

Best response, exploitability, equilibrium, and other formal metrics may ship
only when the game descriptor and policy contract establish their
preconditions. They must reject incompatible descriptors rather than emit a
misleading value.

Potential game transforms are:

- simultaneous-to-sequential commitment form;
- repeated games;
- start-from-state;
- cooperative centralized policy views;
- utility normalization.

Transforms remain lower priority than descriptors, chance, observers, and
conformance. A transform ships only with an explicit input/output descriptor,
determinism rules, evidence identity, and conformance fixtures. This RFC does
not require an unstable transform merely to fill the list.

## 3 — Benchmark runner

The runner consumes the RFC-013 manifest and must support:

- sequential and bounded parallel execution;
- deterministic task and seed scheduling;
- local, provider-backed, and CLI agents;
- single-agent and multi-agent episodes;
- token, cost, step, and wall-clock observations;
- explicit invalid-action and timeout policy;
- checkpoints and resume;
- per-episode portable replay evidence;
- deterministic per-task and aggregate scoring.

Proposed CLI workflow:

```bash
gaos benchmark init
gaos benchmark run benchmark.yaml --agent ./agent.mjs
gaos benchmark resume ./runs/run-id
gaos benchmark pack ./runs/run-id
gaos benchmark verify submission.gaos-bench
```

Wall-clock, provider identity, token, and model-cost fields are operational
observations unless a separate trusted authority attests them. Parallelism and
resume must not change the authored episode plan, episode identities, or
aggregate result.

### 3.1 Product-pinned authority policy

A benchmark manifest may require external attestations defined by RFC-014, but
it must pin the policy used to evaluate them. At minimum, each requirement
declares:

```ts
interface BenchmarkAuthorityRequirement {
  claim:
    | 'identity'
    | 'time'
    | 'publication'
    | 'tail-anchor'
    | 'model-identity'
    | 'hidden-test';
  purpose: 'identity' | 'timestamp' | 'transparency' | 'witness';
  authorityId: string;
  keyIds?: string[];
  pinnedRootDigests?: string[];
  acceptedSchemas: string[];
  acceptedAlgorithms?: string[];
  revocationPolicy?: 'ignore' | 'reject-revoked' | 'require-valid';
  required: boolean;
}
```

The independently obtained manifest is product configuration and may establish
trust. A copy carried only inside the submitted bundle cannot establish its
own trust; it must match the benchmark id, version, and digest pinned by the
product or verifier invocation. Products own authority selection, service
calls, credential handling, key rotation and revocation, account policy, and
availability. The GAOS runner and verifier consume their keys, certificate
roots, receipts, and policies through the RFC-014 interfaces.

## 4 — Portable submission bundle

The portable bundle has an explicitly versioned format:

```text
submission.gaos-bench/
├── manifest.json
├── submission.json
├── episodes/
│   ├── task-a-seed-101.gaos-replay.jsonl
│   └── task-a-seed-102.gaos-replay.jsonl
├── scores.json
├── verification.json
└── README.md
```

Independent verification must:

1. validate manifest, game, adapter, artifact, and schema identities;
2. replay every included episode;
3. reconstruct terminal outcomes and replay metrics;
4. recompute per-task scores;
5. recompute aggregate scores;
6. verify submission and dynamic-control chains when required;
7. reject missing or duplicate required episodes;
8. verify requested external attestations against the independently supplied
   manifest and product trust roots; and
9. emit machine-readable, independent verification facts for each episode and
   submission.

Packing must be reproducible: canonical metadata and episode ordering must
produce a stable artifact digest independent of filesystem traversal order.
The verifier must not require a GAOS-operated service.

## 5 — Trust claims

All submission and leaderboard surfaces must preserve independent facts,
including the five RFC-013 claims:

- evidence verified;
- organizer reproduced;
- open implementation;
- model identity attested;
- hidden-test compliant.

Evidence verification establishes only that recorded inputs reproduce recorded
outcomes and scores. The other four claims require metadata or an external
authority. External attestations add further independent facts such as
identity attested, time attested, publication logged, tail anchored, and
availability observed.

No single `trusted` or `verified` boolean, verdict, checkmark, or visual badge
may compose these facts or imply all of them. Policy adoption is a separate
product decision. A proposed machine-readable shape is:

```ts
type VerificationState =
  | 'verified'
  | 'unverified'
  | 'failed'
  | 'not-required'
  | 'not-observed';

interface SubmissionVerificationFacts {
  replay: VerificationState;
  signatures: VerificationState;
  semantics: VerificationState;
  evidenceComplete: VerificationState;
  organizerReproduced: VerificationState;
  implementationOpen: VerificationState;
  modelIdentityAttested: VerificationState;
  hiddenTestCompliant: VerificationState;
  accountIdentityAttested: VerificationState;
  timeAttested: VerificationState;
  publicationLogged: VerificationState;
  tailAnchored: VerificationState;
  availabilityObserved: VerificationState;
  externalAuthorities: ExternalTrustResult[];
  reasons: string[];
}
```

An application may calculate an eligibility decision from these facts and its
own named policy, but must expose the underlying facts and policy version. The
SDK does not assign a universal trust meaning.

## 6 — Neutral leaderboard starter

GAOS must provide a deployable reference template containing:

- a static leaderboard frontend;
- submission and artifact metadata API;
- object-storage interface for evidence bundles;
- verifier worker queue;
- SQLite and PostgreSQL-compatible schema;
- benchmark-version and modality filters;
- aggregate and per-task score tables;
- uncertainty or error-bar fields;
- artifact download and local-verification instructions;
- distinct trust labels from §5.

v0.22 already ships `LeaderboardEntry`. Its fields remain supported:

```ts
interface LeaderboardEntry {
  benchmarkId: string;
  benchmarkVersion: string;
  submissionId: string;
  agentName: string;
  modelClaim?: string;
  strategyName?: string;
  modality: string;
  aggregateScore: number;
  taskScores: Record<string, number>;
  uncertainty?: number;
  artifactDigest: string;
  evidenceVerdict: 'trusted' | 'unverifiable' | 'rejected';
  reproduced: boolean;
  openSourceUrl?: string;
}
```

Those two legacy summary fields have deliberately narrow meanings.
`evidenceVerdict` is the historical replay, signature, chain, and semantic
adoption verdict described in
[Trust and verification](../trust-and-verification.md); it is not an overall
trust decision. `reproduced` reports only organizer reproduction. Neither
field implies identity, timing, publication, anchoring, availability,
open-source, model-identity, or hidden-test facts.

RFC-015 adds a versioned, additive entry shape rather than changing or removing
the v0.22 contract:

```ts
interface LeaderboardEntryV2 extends LeaderboardEntry {
  schema: 'gaos.leaderboard-entry.v2';
  verification: SubmissionVerificationFacts;
  eligibility?: {
    policyId: string;
    policyVersion: string;
    decision: 'eligible' | 'ineligible' | 'pending';
    reasons: string[];
  };
}
```

The V2 `verification` facts are authoritative for the expanded claim set.
Implementations may derive the legacy summaries from those facts when
serializing a V2 entry, but must not derive the expanded facts from the two
legacy fields.

The template does not create an official GAOS ranking. A product must
instantiate it with an explicit benchmark manifest, governance policy,
submission rules, and scoring interpretation.

## 7 — Compatibility and release gate

Runner, bundle, verifier, metrics, and leaderboard surfaces are additive. New
wire objects and bundle contents require explicit schema ids and versions.
Native GAOS evidence and externally adapted evidence remain unambiguous, as
required by RFC-014. Existing `LeaderboardEntry` consumers continue to receive
the v0.22 fields; expanded verification facts require the explicitly versioned
V2 shape.

v0.24 is complete only when:

1. sequential, parallel, interrupted, and resumed runs produce the same plan
   and deterministic scores;
2. local, provider-backed, and CLI agent paths share conformance fixtures;
3. packing is reproducible and the verifier rejects missing, duplicated,
   modified, or incompatible evidence;
4. independent verification recomputes every episode, task score, and
   aggregate;
5. the leaderboard starter deploys against both supported database schemas and
   exposes evidence download plus all independent verification facts;
6. manifest-pinned authority fixtures cover valid, unknown, rotated, revoked,
   expired, and artifact-substituted keys without private-key custody in GAOS;
7. every shipped metric or transform enforces its declared preconditions.

## 8 — Out of scope

RFC-015 does not add an official benchmark, universal score, official
leaderboard, hosted evaluation service, training framework, algorithm
catalogue, proof of model identity, prompt secrecy, wall-clock fairness, or
proof that evaluation content was withheld. It does not operate an identity
provider, timestamp authority, transparency log, witness, certificate
authority, or key-management service. It does not weaken the product ownership
rules in RFC-013 or RFC-014.
