# Neutral leaderboard starter

`server.mjs` is a runnable Node.js/SQLite deployment with an HTTP API, durable
artifact directory, and verifier queue. Start it with:

```sh
GAOS_DB=./data/leaderboard.sqlite \
GAOS_OBJECTS=./data/objects \
PORT=8787 node server.mjs
```

Apply `postgresql.sql` when replacing the included SQLite adapter. Both preserve aggregate
and per-task scores, uncertainty, artifact identity, eligibility, and the
complete independent verification-fact object.

The starter deliberately has no default benchmark or eligibility policy.
Expose `metadata().artifactDownload` and the local `gaos benchmark verify`
instruction beside every entry. `POST /api/submissions` accepts `{entry,
bundleBase64}`; `GET /api/submissions` filters by `benchmarkId`,
`benchmarkVersion`, and `modality`; and `POST /api/verifier/dequeue` leases the
next verification job. Never collapse the verification facts into a
single trust badge.
