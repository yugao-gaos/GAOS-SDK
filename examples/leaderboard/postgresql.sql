CREATE TABLE benchmark_submissions (
  submission_id TEXT PRIMARY KEY,
  benchmark_id TEXT NOT NULL,
  benchmark_version TEXT NOT NULL,
  modality TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  aggregate_score DOUBLE PRECISION NOT NULL,
  uncertainty DOUBLE PRECISION,
  artifact_digest TEXT NOT NULL UNIQUE,
  verification_json JSONB NOT NULL,
  eligibility_json JSONB
);

CREATE TABLE benchmark_task_scores (
  submission_id TEXT NOT NULL REFERENCES benchmark_submissions(submission_id),
  task_id TEXT NOT NULL,
  score DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (submission_id, task_id)
);

CREATE INDEX benchmark_submission_filters
  ON benchmark_submissions(benchmark_id, benchmark_version, modality);
