# RFC-016 / v0.25 implementation gate

| Gate | Shipped evidence |
| --- | --- |
| Reproducible content identity | `packVerifierKit()` emits canonical ustar bytes and whole-kit SHA-256 identity; the release test compares independent packs and changed inputs. |
| Strict pre-extraction inspection | `inspectVerifierKit()` rejects malformed, noncanonical, traversing, duplicate, unordered, linked, undeclared, oversized, and digest-mismatched content. |
| Replay discovery without self-authorization | `verifierReferenceFromExtensions()` parses the namespaced v1 reference while `resolveVerifierKit()` reports authorization independently. |
| Verified online/offline resolution | Resolver callbacks verify size and digest before atomic cache admission; cache reads recheck whole-kit and per-file integrity. |
| Restricted execution | `RestrictedVerifierRunner` forbids in-process fallback. `ContainerVerifierRunner` requires a pinned image and constructs a networkless, read-only, environment-clean, resource-bounded invocation. |
| TypeScript/Python parity | Both packages validate manifests and references; both inspect archive contents without execution. |
| Compatibility | The existing local `gaos verify --adapter` path and replay v1.0–v1.3 suites run unchanged. |

## Executed release checks

- `npm test`
- `npm run typecheck`
- `npm run build`
- `npm run docs:build`
- `cd python && PYTHONPATH=. pytest`
- `node scripts/check-release-version.mjs v0.25.0`
- `git diff --check`
