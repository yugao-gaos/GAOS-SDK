# Neutral leaderboard starter

`server.mjs` is a runnable Node.js/SQLite deployment with an HTTP API, durable
artifact directory, and verifier queue. Start it with:

```sh
GAOS_DB=./data/leaderboard.sqlite \
GAOS_OBJECTS=./data/objects \
PORT=8787 node server.mjs
```

Set `GAOS_DATABASE_URL=postgresql://...` to select the runtime PostgreSQL
adapter (`GAOS_PSQL` may name a non-default `psql` executable). SQLite uses
`GAOS_DB` and the PATH-resolved `sqlite3` command. Both schemas are idempotent and preserve aggregate
and per-task scores, uncertainty, artifact identity, eligibility, and the
complete independent verification-fact object.

The starter deliberately has no default benchmark or eligibility policy.
Expose `metadata().artifactDownload` and the local `gaos benchmark verify`
instruction beside every entry. `POST /api/submissions` accepts `{entry,
bundleBase64}`; `GET /api/submissions` filters by `benchmarkId`,
`benchmarkVersion`, and `modality`; and `POST /api/verifier/dequeue` leases the
next verification job. Never collapse the verification facts into a
single trust badge.

Submission trust claims are never published directly: new entries are stored
as pending/not-observed. A verifier must lease the job and POST independently
derived facts to `/api/verifier/complete` before they become visible.
