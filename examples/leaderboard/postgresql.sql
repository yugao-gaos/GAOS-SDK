CREATE TABLE IF NOT EXISTS benchmark_submissions (
  submission_id TEXT PRIMARY KEY,
  benchmark_id TEXT NOT NULL,
  benchmark_version TEXT NOT NULL,
  modality TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  aggregate_score DOUBLE PRECISION NOT NULL,
  uncertainty DOUBLE PRECISION,
  artifact_digest TEXT NOT NULL UNIQUE,
  evidence_verdict TEXT NOT NULL,
  reproduced BOOLEAN NOT NULL,
  verification_json JSONB NOT NULL,
  eligibility_json JSONB
);

CREATE TABLE IF NOT EXISTS benchmark_task_scores (
  submission_id TEXT NOT NULL REFERENCES benchmark_submissions(submission_id),
  task_id TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (submission_id, task_id)
);

CREATE INDEX IF NOT EXISTS benchmark_submission_filters
  ON benchmark_submissions(benchmark_id, benchmark_version, modality);

CREATE TABLE IF NOT EXISTS verifier_queue (
  submission_id TEXT PRIMARY KEY REFERENCES benchmark_submissions(submission_id),
  artifact_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
