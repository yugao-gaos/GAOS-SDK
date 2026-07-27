# RFC-014 and RFC-015 implementation gate

This matrix records the release evidence for the RFC-014 compatibility
milestone and the official v0.24 release that incorporates it alongside
RFC-015. No separate v0.23 artifact was published. Product-owned networking,
credentials, benchmark meaning, eligibility, and governance remain outside
the SDK.

## RFC-014 compatibility milestone (historical v0.23 target)

| Gate | Shipped evidence |
| --- | --- |
| Named host and engine authority boundaries | `docs/interoperability.md` classifies Nakama, Colyseus, Node.js, Photon Fusion/Quantum, Unity, Godot, and Unreal, including runtime, cryptography, persistence, reconnect, and evidence ownership. |
| Executable versioned host conformance | `runReferenceHostConformance()` executes state transitions and fault injection for every scenario, while `runHostConformance()` emits portable `gaos.host-conformance.v1` adapter reports. |
| Shared cross-language presentation contract | Versioned schemas and one golden fixture are consumed by executable TypeScript, C#, C++, and GDScript state machines in the release test. |
| Signature v2 and dynamic control | `src/evidence.ts` binds command chains to exact controller epochs, validates signed handoffs or explicit host policy, reports tails, rehydrates checkpoints including prepared atomic swaps, and rejects stale/future epochs. TypeScript and Python share golden bytes and offline verifier behavior. |
| Product-supplied external trust | The policy/resolver boundary verifies signature, subject, pin/root path, expiry, revocation, schema, and algorithm facts. Fixtures cover valid, unknown, rotated, revoked, expired, and artifact-substituted material without private-key custody. |
| Old replay compatibility | Existing v1.0–v1.3 replay and `gaos.submission.ed25519.v1` suites run unchanged in the full test gate. v2 uses distinct scheme and evidence format ids. |

## RFC-015 / v0.24

| Gate | Shipped evidence |
| --- | --- |
| Sequential/parallel/resume determinism | `runBenchmark()` preserves authored plan order in checkpoints and results; tests compare sequential, bounded parallel, interrupted, and resumed output. |
| Local/provider/CLI conformance | One `BenchmarkAgentAdapter` contract carries all three explicit kinds. The CLI integration test runs a module through run/pack/verify. |
| Reproducible pack and strict rejection | `packBenchmarkRun()` canonicalizes episode order and content. Tests reject missing, duplicate, modified, score-modified, and incompatible bundles. |
| Independent score recomputation | `verifyBenchmarkBundle()` invokes episode replay verification and recomputes per-task and aggregate scores rather than trusting carried values. |
| Neutral leaderboard starter | A runnable Node HTTP/SQLite server, artifact directory, verifier queue, static frontend, PostgreSQL schema, filters, task scores, downloads, and independent V2 facts ship under `examples/leaderboard`; the HTTP path has an integration test. |
| Manifest-pinned authorities | Independently supplied manifest requirements select accepted authority/purpose/key facts; external-trust tests cover the required trust-state matrix. |
| Metric/transform preconditions | Payoff matrix, action efficiency, invalid-action rate, and Elo helpers ship. Formal metrics and transform descriptors reject incompatible game descriptors. |

## Executed release checks

- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run docs:build`
- `cd python && PYTHONPATH=. pytest`
- `node scripts/check-release-version.mjs v0.24.0`
- `git diff --check`
