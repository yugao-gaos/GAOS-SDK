CREATE TABLE benchmark_submissions (
  submission_id TEXT PRIMARY KEY,
  benchmark_id TEXT NOT NULL,
  benchmark_version TEXT NOT NULL,
  modality TEXT NOT NULL,
  agent_name TEXT NOT NULL,
  aggregate_score REAL NOT NULL,
  uncertainty REAL,
  artifact_digest TEXT NOT NULL UNIQUE,
  verification_json TEXT NOT NULL,
  eligibility_json TEXT
);

CREATE TABLE benchmark_task_scores (
  submission_id TEXT NOT NULL REFERENCES benchmark_submissions(submission_id),
  task_id TEXT NOT NULL,
  score REAL NOT NULL,
  PRIMARY KEY (submission_id, task_id)
);

CREATE INDEX benchmark_submission_filters
  ON benchmark_submissions(benchmark_id, benchmark_version, modality);
