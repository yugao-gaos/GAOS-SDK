# Interoperability and dynamic-control evidence

GAOS is the simulation authority in every native integration below. Networking,
accounts, matchmaking, storage, rendering, and external trust remain product
responsibilities. Run the built-in `runReferenceHostConformance()` and the
product adapter through `runHostConformance()` before claiming compatibility; each
`gaos.host-conformance.v1` report names the runtime, adapter version, every
fixture, and the pass/fail result.

## Authoritative hosts

| Platform | Classification and authority | Runtime and cryptography | Persistence and evidence |
| --- | --- | --- | --- |
| Nakama | Direct host. One authoritative TypeScript match invokes `SessionHostDriver`; clients never reduce game state. | Nakama's TypeScript runtime must provide the SDK's ES2022 features and Ed25519 WebCrypto, or a product-supplied signer/verifier adapter. Do not assume Node built-ins. | Persist the committed transition, seat-control checkpoint, and outbox before publish. The match process finalizes evidence in-process when its runtime supports the complete stack. |
| Colyseus | Direct host. The room owns transport and connection membership; one GAOS session owns simulation. | Node.js 20.3+ and WebCrypto support the complete evidence stack. Colyseus schema state is a projection, not a second reducer. | A product storage adapter durably commits transition/checkpoint/outbox state. The room may finalize evidence in-process after durable commit. |
| Node.js HTTP/WebSocket | Direct reference host. HTTP creates and repairs sessions; WebSocket carries commands, receipts, snapshots, and patches; `SessionHostDriver` is authoritative. | Node.js 20.3+; WebCrypto Ed25519 executes signature v1/v2 and external-attestation verification. Enforce product payload and backpressure limits at the socket edge. | Store committed transition, checkpoint, and publish outbox atomically. Retry publish from the durable outbox; keep replay and benchmark bundles in product object storage. |
| Photon Fusion | Transport/orchestration layer. Fusion forwards ordered command envelopes and seat scopes to one headless GAOS server or sidecar. It must not simulate the same match independently. | Fusion transports opaque JSON/binary payloads; the GAOS process performs canonical hashing and cryptography. Product code propagates controller id, epoch, transition revision, and submission id. | The GAOS process owns durable evidence. Use ordered delivery, idempotent submission ids, bounded payloads/backpressure, and snapshot repair after reconnect. |
| Photon Quantum | Alternate simulation core unless GAOS is explicitly selected as the sole simulation core. | Option 1 uses a non-simulating transport and native GAOS evidence. Option 2 uses Quantum confirmed inputs, pinned simulation identity, frame digests, and final results. | Option 2 emits an explicitly external artifact format and an external-verifier result. It must never claim that a GAOS reducer replayed the run. Quantum or product infrastructure owns its evidence durability. |

The reference lifecycle is create, control, ingest, advance, snapshot, and
terminate. A host acknowledges only after durable commit. Byte-identical retries
return the durable result; conflicting reuse is rejected. Reconnect binds a new
connection to the active controller and logical seat scopes without creating an
epoch. A patch without its base triggers snapshot repair.

## Rendering engines

| Engine | Authority boundary | Projection and reconnect |
| --- | --- | --- |
| Unity | The C# client decodes GAOS observations. GameObjects, Animator state, camera, and input are presentation only. Unity must not run a competing authoritative reducer. | Map stable entity ids to GameObjects. Apply durable state before animation, deduplicate presentation-event ids, and clear old cue queues when a repair snapshot arrives. |
| Godot | GDScript or C# decodes the same fixture over WebSocket. Nodes/scenes are projections; GAOS remains authoritative. | Map stable ids to Nodes. Preserve unknown optional fields, request repair after a missing base/digest mismatch, replace durable projection, and do not replay old cues. |
| Unreal Engine | C++ decodes GAOS messages and projects entities into Actors/UObjects. Native replication may distribute the projection but must not become a second simulation authority. | Emit Blueprint events only for unseen presentation-event ids. On reconnect, reconcile the snapshot and retain engine-native objects only when their stable ids still exist. |

The executable examples live under `examples/clients`. The release test compiles
and runs TypeScript/Node, C#/.NET, C++17, and GDScript/Godot against
`fixtures/ecosystem/presentation-client-v1.golden.json`. The fixture includes an
unknown optional field so integrations can verify compatible minor-field
preservation. These examples intentionally do not prescribe a UI, art, camera,
animation, or input framework.

## Dynamic controller evidence

`gaos.submission.ed25519.v2` starts a distinct command chain for every logical
seat epoch. Its genesis binds the session, seat, epoch key, transition digest,
previous epoch digest, and the last authenticated prior chain head when
available. A voluntary `gaos.controller-handoff.v2` is signed by both outgoing
and incoming keys. Abrupt replacement is recorded as `host-policy`; it is never
presented as controller consent.

`verifyDynamicControlEvidenceV2()` rehydrates and validates the full
seat-control history, resolves every command at its exact transition revision,
checks checkpointed epoch genesis/final heads and periodic signatures, requires
a voluntary handoff to name the exact computed outgoing head, identifies
host-policy epochs, and reports unsigned or incomplete tails. The v2 golden vectors are shared with the
Python SDK. Existing replay v1.0–v1.3 and
`gaos.submission.ed25519.v1` retain their original interpretation.

External attestations are verified only against caller-supplied
`ExternalTrustPolicy` and `ExternalTrustResolver` values. Embedded keys and
certificate chains are evidence, never trust anchors. Private keys stay behind
product-supplied signer callbacks.
