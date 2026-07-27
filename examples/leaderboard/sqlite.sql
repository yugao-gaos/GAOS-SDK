CREATE TABLE IF NOT EXISTS benchmark_submissions (
  submission_id TEXT PRIMARY KEY,
  benchmark_id TEXT NOT NULL,
  benchmark_version TEXT NOT NULL,
  modality TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  aggregate_score REAL NOT NULL,
  uncertainty REAL,
  artifact_digest TEXT NOT NULL UNIQUE,
  evidence_verdict TEXT NOT NULL,
  reproduced INTEGER NOT NULL,
  verification_json TEXT NOT NULL,
  eligibility_json TEXT
);

CREATE TABLE IF NOT EXISTS benchmark_task_scores (
  submission_id TEXT NOT NULL REFERENCES benchmark_submissions(submission_id),
  task_id TEXT NOT NULL,
  score REAL NOT NULL,
  PRIMARY KEY (submission_id, task_id)
);

CREATE INDEX IF NOT EXISTS benchmark_submission_filters
  ON benchmark_submissions(benchmark_id, benchmark_version, modality);

CREATE TABLE IF NOT EXISTS verifier_queue (
  submission_id TEXT PRIMARY KEY REFERENCES benchmark_submissions(submission_id),
  artifact_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
