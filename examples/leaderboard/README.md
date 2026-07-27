# Neutral leaderboard starter

Wire `LeaderboardService` to an HTTP framework, an object store, and a worker
queue. Apply either `sqlite.sql` or `postgresql.sql`; both preserve aggregate
and per-task scores, uncertainty, artifact identity, eligibility, and the
complete independent verification-fact object.

The starter deliberately has no default benchmark or eligibility policy.
Expose `metadata().artifactDownload` and the local `gaos benchmark verify`
instruction beside every entry. Never collapse the verification facts into a
single trust badge.
