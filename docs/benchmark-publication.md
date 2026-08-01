# Verifiable benchmark publication

A published score should point to evidence of the exact run, the benchmark
conditions, and the historical verifier required to check it.

## Run and verify

```sh
gaos-benchmark run \
  --manifest ./benchmark.json \
  --adapter ./historical-adapter.mjs \
  --out ./runs

gaos-benchmark resume \
  --checkpoint ./runs/checkpoint.json

gaos-benchmark verify \
  --bundle ./runs/bundle.json \
  --manifest ./benchmark.json \
  --adapter ./historical-adapter.mjs
```

The runner writes each replay atomically and checkpoints after each case.
Resume skips completed cases only after rechecking their replay evidence.

Packed episodes retain the agent/provider's step, token, cost, wall-clock, and
provider data under `selfReportedObservations`. The explicit name is the trust
label: these fields support operational comparison but are not verified replay
evidence unless a separately trusted authority attests them.

The benchmark manifest must come from an independent trusted source. A manifest
embedded only inside the submitted bundle cannot authorize itself.

## Product-owned verifier kits

v0.25 adds a product export step:

```text
product reducer + semantic adapter
        ↓
content-addressed verifier kit
        ↓
benchmark manifest pins kit digest
        ↓
bundle publishes replay + references + results
```

The benchmark bundle may carry a verifier kit or mirror locations for it.
Those locations affect availability, not trust. An independently obtained
manifest, signed catalog, or verifier-owned allowlist must authorize the
content digest.

GAOS owns the kit format, hashing, resolution, cache, restricted execution,
and separate result facts. The product will own reducer export, publication,
retention, benchmark meaning, and adoption policy.

[Understand verdicts →](/trust-and-verification) ·
[Read RFC-016 →](/rfcs/rfc-016-product-owned-verifier-kits)
