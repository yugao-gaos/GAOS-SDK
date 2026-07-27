# Verifiable benchmark publication

The v0.24 benchmark path owns deterministic planning, execution, checkpointing,
packaging, replay verification, and score recomputation. A benchmark product
still owns its tasks, scoring meaning, weights, held-out content, eligibility,
governance, and publication policy.

## CLI workflow

```sh
gaos benchmark init benchmark.json
gaos benchmark run benchmark.json --agent ./agent.mjs --output ./run
# If a run was interrupted:
gaos benchmark resume ./run --agent ./agent.mjs
gaos benchmark pack ./run --output submission.gaos-bench
gaos benchmark verify submission.gaos-bench \
  --manifest benchmark.json \
  --adapter ./verifier-adapter.mjs
```

The manifest passed to `verify` must come from an independent trusted source,
not from the submitted bundle.

`runBenchmark()` accepts local, provider, and CLI adapters through one episode
contract. It runs sequentially or with bounded parallelism, stores completed
results in authored plan order, and resumes only when the manifest digest,
agent identity, and complete plan match. Wall clock, provider, token, and cost
fields are observations unless separately attested.

`packBenchmarkRun()` creates an actual `.gaos-bench` directory containing the
manifest, submission, scores, verification record, README, and one replay file
per episode. Sorted paths, byte lengths, and canonical contents make the package
digest independent of filesystem traversal metadata. The separately named
`contentDigest` covers the authoritative manifest/submission/episode/score
content while excluding attestations, allowing external authorities to sign a
non-self-referential subject. `verifyBenchmarkBundle()` requires
an independently supplied manifest, rejects missing/duplicate/modified/
incompatible episodes, calls the product's replay verifier for every episode,
and recomputes episode, task, and aggregate scores. It never treats scores
carried by the bundle as authoritative.

Manifest authority requirements pin claim, purpose, authority, key ids,
schemas, algorithms, roots, and revocation policy. A manifest copied only from
the submitted artifact cannot anchor itself. GAOS accepts public material and
portable receipts through the RFC-014 external-trust interfaces incorporated
into v0.24 and never takes private-key custody.

The neutral starter under `examples/leaderboard` includes a runnable Node HTTP
server, SQLite persistence, a durable artifact directory, verifier queue,
static frontend, and a PostgreSQL migration schema. Its integration test submits,
filters, fetches metadata/artifacts, and dequeues verification work. It exposes aggregate/per-task scores,
uncertainty, local verification instructions, and every verification fact
separately. `evidenceVerdict` retains its narrow historical meaning and
`reproduced` means organizer reproduction only; neither is a universal trust
badge.

Research helpers include ordered head-to-head payoff matrices, action
efficiency/invalid-action rates, and a deterministic Elo adapter. Formal
best-response, exploitability, and equilibrium entry points must call
`assertFormalMetricPreconditions()`. Transform implementations must validate a
versioned `gaos.game-transform.v1` descriptor and reject unmet preconditions.
