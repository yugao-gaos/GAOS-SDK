# Verifiable benchmark publication

The v0.24 benchmark path owns deterministic planning, execution, checkpointing,
packaging, replay verification, and score recomputation. A benchmark product
still owns its tasks, scoring meaning, weights, held-out content, eligibility,
governance, and publication policy.

`runBenchmark()` accepts local, provider, and CLI adapters through one episode
contract. It runs sequentially or with bounded parallelism, stores completed
results in authored plan order, and resumes only when the manifest digest,
agent identity, and complete plan match. Wall clock, provider, token, and cost
fields are observations unless separately attested.

`packBenchmarkRun()` creates the canonical contents of a
`gaos.benchmark-bundle.v1`. Episode ordering and canonical JSON make its digest
independent of filesystem traversal order. `verifyBenchmarkBundle()` requires
an independently supplied manifest, rejects missing/duplicate/modified/
incompatible episodes, calls the product's replay verifier for every episode,
and recomputes episode, task, and aggregate scores. It never treats scores
carried by the bundle as authoritative.

Manifest authority requirements pin claim, purpose, authority, key ids,
schemas, algorithms, roots, and revocation policy. A manifest copied only from
the submitted artifact cannot anchor itself. GAOS accepts public material and
portable receipts through the v0.23 external-trust interfaces and never takes
private-key custody.

The neutral starter under `examples/leaderboard` includes a static frontend,
object-store and verifier-queue interfaces, metadata and artifact-download
operations, and SQLite/PostgreSQL schemas. It exposes aggregate/per-task scores,
uncertainty, local verification instructions, and every verification fact
separately. `evidenceVerdict` retains its narrow historical meaning and
`reproduced` means organizer reproduction only; neither is a universal trust
badge.

Research helpers include ordered head-to-head payoff matrices, action
efficiency/invalid-action rates, and a deterministic Elo adapter. Formal
best-response, exploitability, and equilibrium entry points must call
`assertFormalMetricPreconditions()`. Transform implementations must validate a
versioned `gaos.game-transform.v1` descriptor and reject unmet preconditions.
