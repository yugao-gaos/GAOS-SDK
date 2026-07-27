# RFC-014 — Interoperability and dynamic-control evidence

Status: **implemented in v0.24** · Historical target: v0.23 compatibility
milestone (no separate artifact) · Compatibility: additive client and host
surfaces plus a new evidence/signature format; existing artifacts retain their
interpretation · Depends on: RFC-006, RFC-010, RFC-012,
[RFC-013](rfc-013-ecosystem-bridges-and-benchmark-tooling.md)

## 1 — Scope and inherited boundary

RFC-014 completes the interoperability and dynamic-control evidence path built
on RFC-013:

1. executable, transport-neutral host conformance;
2. honest platform integration guides;
3. cross-language schemas, fixtures, client types, and state machines;
4. cryptographically authenticated seat-control epochs;
5. replay, checkpoint, offline-verifier, and TypeScript/Python parity.

The product boundary in RFC-013 §2 is normative here. In particular, hosts
still own networking and account policy, engines still own rendering, and
GAOS remains the sole simulation authority unless an artifact explicitly
identifies an alternate simulation core.

## 2 — Hosting and transport interoperability

### 2.1 Integration classification

Every integration guide must identify one category.

#### Direct host

A platform that executes the GAOS TypeScript core inside its authoritative
match runtime invokes the RFC-013 host lifecycle directly. RFC-014 must
document:

- Nakama as a TypeScript authoritative match runtime;
- Colyseus as a Node.js room server;
- a minimal Node.js HTTP/WebSocket reference host.

Each guide must identify runtime restrictions, supported cryptography,
persistence behavior, and whether the full evidence stack executes in-process.

#### Transport or orchestration layer

When the platform moves inputs and observations or allocates authoritative
processes while GAOS runs elsewhere, the guide must specify:

- command and observation envelopes;
- seat identity propagation;
- ordering and retry behavior;
- backpressure and maximum payload assumptions;
- reconnect and repair flow;
- which process owns durable evidence.

Photon Fusion belongs primarily here. A headless engine server or sidecar may
carry GAOS commands and views, but the guide must name the actual state
authority and avoid duplicated simulation.

#### Alternate simulation core

Platforms that already own deterministic simulation, input synchronization,
prediction, rollback, and verified frames cannot run an independent GAOS
reducer as a second authority.

The Photon Quantum guide must present two honest options:

1. use GAOS as the simulation core with a transport that does not replace it;
2. use Quantum as the simulation core and emit explicitly external evidence
   over confirmed inputs, pinned simulation identity, frame digests, and final
   results.

The second option must not claim that a GAOS reducer reproduced the run unless
it actually did. Native GAOS replay and externally adapted evidence require
distinct, unambiguous artifact format ids and verifier results.

### 2.2 Executable host conformance kit

All adapters must execute the same fixtures, independent of networking and
storage technology:

- byte-identical retry versus conflicting event reuse;
- crash before persistence, after persistence, and after commit;
- publish retry after durable commit;
- stale prepared transition rejection;
- timeout transition handling;
- acknowledgement, rejection, and reconnect repair;
- observation patch without a base snapshot;
- dropout, drop-in, reconnect, substitution, transfer, and atomic seat swap;
- rejection of a command signed by an inactive controller epoch;
- checkpoint restore and retention-floor behavior;
- artifact finalization and independent verification.

The suite must expose machine-readable results so a guide can state which
runtime and adapter version passed which conformance version.

## 3 — Cross-language presentation clients

RFC-014 must publish:

- JSON Schema for commands, receipts, snapshots, patches, presentation frames,
  replay references, seat-control records, and evidence verdicts;
- generated or hand-maintained TypeScript, C#, C++, and GDScript-compatible
  data types;
- golden fixtures decoded by every supported language;
- a portable client state machine for snapshot, patch, acknowledgement,
  rejection, digest mismatch, and repair;
- examples that project stable entity identities into engine-native objects.

Initial guides must cover:

- Unity: C# client, GameObject projection, animation queue, and reconnect;
- Godot: GDScript and C# clients, scene/node projection, and WebSocket use;
- Unreal Engine: C++ client, Actor/UObject projection, Blueprint events, and
  the boundary with native replication.

All examples render one shared reference game. They must not create a general
UI framework or prescribe art, camera, animation, or input architecture.
Presentation-event identities remain stable across retry and reconnect, and a
repair reconciles durable state without replaying old cues.

Generated clients must preserve unknown optional fields during compatible
minor wire evolution where practical.

## 4 — Authenticated dynamic seat control

RFC-013 defines stable seats, ordered epochs, atomic transitions, reconnect
semantics, and authorization labels. RFC-014 authenticates those records.

### 4.1 Controller-authorized handoff

When the outgoing controller is available, it signs a handoff over:

- session and logical seat;
- outgoing epoch and its latest chain head;
- incoming epoch number, controller id, and public key;
- effective transition revision.

The incoming controller signs acceptance of the same handoff. This proves
continuity between controller epochs without claiming who either controller is
in the real world.

### 4.2 Host-policy transition

Abrupt dropout, moderation, timeout, or recovery may make outgoing consent
impossible. The host may revoke, vacate, or reassign the seat under declared
product policy. The transition is recorded as `host-policy`, never presented
as a controller-authorized handoff.

An auditor can distinguish voluntary transfer from authoritative replacement.
Whether a host-policy replacement is acceptable for a scored run is benchmark
or product policy. The record proves only the declared authority schedule and
which epoch keys authored later commands. It does not prove that a disconnect
occurred, that the host followed external account policy, or that replacement
was justified.

### 4.3 Signature-chain v2

RFC-010 binds one immutable seat-key roster into each v1 chain genesis and
cannot authenticate a replacement key. Existing v1 artifacts remain unchanged.

Dynamic control requires a new append-only signature scheme, provisionally
identified by `gaos.submission.ed25519.v2`. Each controller epoch begins a new
per-seat chain whose genesis binds:

- session and logical seat;
- epoch number and controller key;
- canonical seat-control transition digest;
- previous epoch digest;
- the last authenticated chain head from the previous epoch, when available.

An abrupt dropout may leave an unsigned tail after the previous periodic
signature. That tail uses the existing partial-evidence semantics and does not
invalidate a correctly authorized replacement epoch.

The verifier must:

- resolve every signed command against the epoch active at its revision;
- reject signatures from a future, expired, or different-seat epoch;
- validate handoff and acceptance signatures when authorization claims them;
- identify host-policy transitions explicitly;
- verify epoch ordering and cross-epoch digest continuity;
- report unsigned or incompletely closed epoch tails without hiding them.

The evidence format must include the complete control history required for
these checks. It requires a new format version; no v1.0–v1.3 replay artifact is
reinterpreted.

### 4.4 Checkpoint, recovery, and observation delivery

Checkpoints must retain:

- the current epoch for every logical seat;
- controller keys and signing tiers;
- epoch and transition digests;
- the last chain head and periodic signature state;
- any prepared atomic multi-seat control change.

Rehydration must reject missing, duplicated, non-consecutive, or conflicting
epochs. Observation delivery remains scoped to logical seats. The host binds a
connection to the currently authorized controller and one or more seat scopes;
changing connections alone does not alter evidence.

### 4.5 Acceptance evidence

The conformance suite must cover:

- disconnect and same-key reconnect without an epoch change;
- explicit vacancy followed by a new human controller;
- human-to-agent and agent-to-human substitution;
- voluntary signed transfer;
- host-policy revocation and replacement;
- atomic two-seat swap;
- command at the exact revision before and after a handoff;
- stale outgoing-controller and premature incoming-controller rejection;
- incomplete periodic-signature tail at abrupt dropout;
- checkpoint and rehydrate across several epochs;
- TypeScript/Python verification parity and golden signature vectors.

RFC-012 §6 remains the v0.21 baseline for fixed seats and product-managed
occupancy. RFC-013 supersedes that future direction for the ledger contracts;
this RFC supersedes it for dynamic-control evidence only when the new formats
ship.

## 5 — Product-supplied external trust

GAOS verifies cryptographic material but does not operate or select an
identity provider, timestamp authority, transparency log, witness, certificate
authority, or key-management service. A product chooses any such authority and
supplies the trust configuration used by its host and offline verifier.

The product owns:

- authority and service selection, enrollment, and all network service calls;
- trusted public keys and certificate roots;
- key rotation, revocation data, and validity policy;
- account-to-key binding and the meaning of identity claims;
- availability, retention, and publication policy; and
- the decision to require, accept, or reject each assurance level.

Private keys remain in the client, product, hardware module, or external
service that controls them. GAOS accepts signer callbacks; it does not require
private-key import or custody.

The following provisional contracts define the boundary. Exact names may
change before the RFC ships, but the separation of responsibilities is
normative:

```ts
type ExternalTrustPurpose =
  | 'identity'
  | 'timestamp'
  | 'transparency'
  | 'witness';

interface ExternalKeyRef {
  authorityId: string;
  keyId: string;
  purpose: ExternalTrustPurpose;
}

type ExternalPublicKey =
  | {
      format: 'jwk';
      key: JsonWebKey;
      certificateChain?: string[]; // DER certificates, base64 encoded
    }
  | {
      format: 'spki';
      key: string;                 // DER SubjectPublicKeyInfo, base64 encoded
      certificateChain?: string[];
    };

interface ExternalTrustResolver {
  resolveKey(ref: ExternalKeyRef): Promise<ExternalPublicKey | undefined>;
  resolveRevocation?(ref: ExternalKeyRef): Promise<{
    state: 'valid' | 'revoked' | 'unknown';
    checkedAt?: string;
    evidence?: ExternalAttestation;
  }>;
}

interface ExternalSigner {
  readonly key: ExternalKeyRef;
  readonly algorithm: string;
  sign(payload: Uint8Array): Promise<Uint8Array>;
}

interface ExternalAttestation {
  schema: string;
  authority: ExternalKeyRef;
  subjectDigest: string;
  algorithm: string;
  issuedAt?: string;
  expiresAt?: string;
  payload: unknown;
  signature: string;
  certificateChain?: string[];
}

interface ExternalTrustPolicy {
  pinnedKeys: ExternalKeyRef[];
  pinnedRootDigests?: string[];
  acceptedSchemas: string[];
  acceptedAlgorithms?: string[];
  revocationPolicy?: 'ignore' | 'reject-revoked' | 'require-valid';
}

interface ExternalTrustResult {
  cryptographicallyValid: boolean;
  authorityPinned: boolean;
  certificatePathValid?: boolean;
  revocationState?: 'valid' | 'revoked' | 'unknown' | 'not-checked';
  policyAccepted: boolean;
  authority?: ExternalKeyRef;
  matchedPin?: string;
  reasons: string[];
}
```

Portable receipts and attestations carry the authority reference, signed
subject digest, algorithm, signature, and any certificate path required for
offline checking. The verifier resolves trust using product configuration or
a benchmark manifest supplied independently of the artifact. An artifact may
embed a public key or certificate chain so its signature can be checked, but
embedded material is evidence, not a trust anchor. It is trusted only when it:

1. exactly matches a product-pinned authority and key;
2. matches a key pinned by the independently obtained benchmark manifest; or
3. validates through a certificate path to a product-pinned root under the
   product's declared policy.

Replacing evidence and its embedded key must never create a trusted result.
Unknown authorities, unpinned self-signed certificates, unavailable revocation
state, and expired attestations remain distinct machine-readable facts. The
SDK reports those facts and applies the supplied policy; it does not infer that
an authority is trustworthy merely because a signature is valid.

These interfaces permit offline verification from portable receipts. An
online adapter may obtain or refresh a receipt, public key, certificate chain,
or revocation response, but external protocols and credentials remain
product-owned integration code. GAOS never performs authority discovery or
calls an external trust service unless the product explicitly supplies an
adapter that does so.

## 6 — Compatibility and release gate

This release is additive except for emitting a new explicitly versioned
signature and evidence format when dynamic control is used. Existing reducers,
fixed-roster sessions, clients, and v1.0–v1.3 replay artifacts remain supported
with their original interpretation.

The RFC-014 compatibility milestone is complete only when:

1. every named host and engine guide states its authority boundary;
2. the host conformance kit is executable, versioned, and passes the reference
   adapter;
3. all supported language clients decode the same golden fixtures;
4. signature v2, handoffs, replay, checkpoint, and offline verification pass
   TypeScript/Python parity tests;
5. external trust fixtures prove that embedded keys are not trusted without a
   product or manifest pin, while pinned keys and chains produce explicit
   verification facts; and
6. compatibility tests prove old replay formats are unchanged.

## 7 — Out of scope

RFC-014 does not add accounts, lobbies, matchmaking, a hosted multiplayer
service, a renderer, editor extension, general UI framework, second simulation
authority, mutable signed history, real-world identity proof, external trust
service, certificate authority, transparency log, key custody, or mutable
logical seat sets. The broader exclusions and product ownership rules in
RFC-013 §2 and §8 remain in force.
