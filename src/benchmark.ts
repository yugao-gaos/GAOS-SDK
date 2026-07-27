export interface BenchmarkIdentity {
  id: string;
  version: string;
  adapter: string;
}

export interface BenchmarkTask {
  id: string;
  seeds: readonly number[];
  episodes: number;
  maxSteps: number;
  weight?: number;
}

export interface BenchmarkScoring {
  plugin: string;
  aggregation: 'mean' | 'weighted-mean' | 'sum';
}

export interface BenchmarkSubmissionPolicy {
  requireSignedSeats: boolean;
  requireCompleteCoverage: boolean;
}

export interface BenchmarkManifest {
  schema: 'gaos.benchmark-manifest';
  schemaVersion: '1.0';
  benchmark: BenchmarkIdentity;
  tasks: readonly BenchmarkTask[];
  scoring: BenchmarkScoring;
  submission: BenchmarkSubmissionPolicy;
  observationModalities?: readonly string[];
  agentInterface?: string;
}

export interface BenchmarkEpisodePlan {
  index: number;
  taskId: string;
  seed: number;
  episode: number;
  maxSteps: number;
}

export interface BenchmarkTaskScore {
  taskId: string;
  score: number;
}

export interface BenchmarkAggregate {
  aggregateScore: number;
  taskScores: Readonly<Record<string, number>>;
}

export interface EvidenceTrustClaims {
  evidenceVerified: boolean;
  organizerReproduced: boolean;
  openImplementation: boolean;
  modelIdentityAttested: boolean;
  hiddenTestCompliant: boolean;
}

export interface LeaderboardEntry {
  benchmarkId: string;
  benchmarkVersion: string;
  submissionId: string;
  agentName: string;
  modelClaim?: string;
  strategyName?: string;
  modality: string;
  aggregateScore: number;
  taskScores: Record<string, number>;
  uncertainty?: number;
  artifactDigest: string;
  evidenceVerdict: 'trusted' | 'unverifiable' | 'rejected';
  reproduced: boolean;
  openSourceUrl?: string;
}

function assertNonEmpty(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
}

/** Validate only neutral execution structure; benchmark meaning stays product-owned. */
export function assertBenchmarkManifest(
  manifest: BenchmarkManifest,
): asserts manifest is BenchmarkManifest {
  if (manifest.schema !== 'gaos.benchmark-manifest' || manifest.schemaVersion !== '1.0') {
    throw new TypeError('unsupported benchmark manifest schema');
  }
  assertNonEmpty(manifest.benchmark.id, 'benchmark.id');
  assertNonEmpty(manifest.benchmark.version, 'benchmark.version');
  assertNonEmpty(manifest.benchmark.adapter, 'benchmark.adapter');
  assertNonEmpty(manifest.scoring.plugin, 'scoring.plugin');
  if (!['mean', 'weighted-mean', 'sum'].includes(manifest.scoring.aggregation)) {
    throw new TypeError('scoring.aggregation must be mean, weighted-mean, or sum');
  }
  if (typeof manifest.submission.requireSignedSeats !== 'boolean'
    || typeof manifest.submission.requireCompleteCoverage !== 'boolean') {
    throw new TypeError('submission requirements must be booleans');
  }
  if (manifest.observationModalities !== undefined) {
    if (!Array.isArray(manifest.observationModalities)
      || manifest.observationModalities.some(
        (modality) => typeof modality !== 'string' || modality.length === 0,
      )) {
      throw new TypeError('observationModalities must contain non-empty strings');
    }
  }
  if (manifest.agentInterface !== undefined) {
    assertNonEmpty(manifest.agentInterface, 'agentInterface');
  }
  if (manifest.tasks.length === 0) throw new TypeError('manifest must contain tasks');
  const ids = new Set<string>();
  for (const task of manifest.tasks) {
    assertNonEmpty(task.id, 'task.id');
    if (ids.has(task.id)) throw new TypeError(`duplicate benchmark task ${task.id}`);
    ids.add(task.id);
    if (!Number.isSafeInteger(task.episodes) || task.episodes <= 0) {
      throw new RangeError(`task ${task.id} episodes must be a positive safe integer`);
    }
    if (!Number.isSafeInteger(task.maxSteps) || task.maxSteps <= 0) {
      throw new RangeError(`task ${task.id} maxSteps must be a positive safe integer`);
    }
    if (task.seeds.length === 0
      || task.seeds.some((seed) => !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff)) {
      throw new RangeError(`task ${task.id} seeds must be unsigned 32-bit integers`);
    }
    if (new Set(task.seeds).size !== task.seeds.length) {
      throw new TypeError(`task ${task.id} contains duplicate seeds`);
    }
    if (task.weight !== undefined && (!Number.isFinite(task.weight) || task.weight < 0)) {
      throw new RangeError(`task ${task.id} weight must be non-negative and finite`);
    }
  }
}

/** Task order, then authored seed order, then episode ordinal. */
export function planBenchmarkEpisodes(
  manifest: BenchmarkManifest,
): readonly BenchmarkEpisodePlan[] {
  assertBenchmarkManifest(manifest);
  const plan: BenchmarkEpisodePlan[] = [];
  for (const task of manifest.tasks) {
    for (const seed of task.seeds) {
      for (let episode = 0; episode < task.episodes; episode += 1) {
        plan.push({
          index: plan.length,
          taskId: task.id,
          seed,
          episode,
          maxSteps: task.maxSteps,
        });
      }
    }
  }
  return plan;
}

/** Recompute an aggregate only from one finite score for every manifest task. */
export function aggregateBenchmarkScores(
  manifest: BenchmarkManifest,
  scores: readonly BenchmarkTaskScore[],
): BenchmarkAggregate {
  assertBenchmarkManifest(manifest);
  const byTask = new Map<string, number>();
  for (const { taskId, score } of scores) {
    if (byTask.has(taskId)) throw new TypeError(`duplicate score for task ${taskId}`);
    if (!Number.isFinite(score)) throw new RangeError(`score for task ${taskId} must be finite`);
    byTask.set(taskId, score);
  }
  const taskScores: Record<string, number> = {};
  let total = 0;
  let totalWeight = 0;
  for (const task of manifest.tasks) {
    const score = byTask.get(task.id);
    if (score === undefined) throw new TypeError(`missing score for task ${task.id}`);
    taskScores[task.id] = score;
    const weight = manifest.scoring.aggregation === 'weighted-mean'
      ? (task.weight ?? 1)
      : 1;
    total += score * weight;
    totalWeight += weight;
  }
  if ([...byTask.keys()].some((id) => !(id in taskScores))) {
    throw new TypeError('scores contain a task not declared by the manifest');
  }
  if (manifest.scoring.aggregation === 'sum') {
    return { aggregateScore: total, taskScores };
  }
  if (totalWeight === 0) throw new RangeError('aggregate task weight must be greater than zero');
  return { aggregateScore: total / totalWeight, taskScores };
}
