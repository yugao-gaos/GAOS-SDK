import { bytesToHex, sha256 } from './engine/commitment.js';
import { canonicalJson, type JsonValue } from './protocol.js';
import type {
  ExternalAttestation,
  ExternalTrustResolver,
  ExternalTrustResult,
} from './evidence.js';
import { verifyExternalAttestation } from './evidence.js';

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

export interface BenchmarkAuthorityRequirement {
  claim:
    | 'identity'
    | 'time'
    | 'publication'
    | 'tail-anchor'
    | 'model-identity'
    | 'hidden-test';
  purpose: 'identity' | 'timestamp' | 'transparency' | 'witness';
  authorityId: string;
  keyIds?: string[];
  pinnedRootDigests?: string[];
  acceptedSchemas: string[];
  acceptedAlgorithms?: string[];
  revocationPolicy?: 'ignore' | 'reject-revoked' | 'require-valid';
  required: boolean;
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
  authorityRequirements?: readonly BenchmarkAuthorityRequirement[];
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

export type VerificationState =
  | 'verified'
  | 'unverified'
  | 'failed'
  | 'not-required'
  | 'not-observed';

export interface SubmissionVerificationFacts {
  replay: VerificationState;
  signatures: VerificationState;
  semantics: VerificationState;
  evidenceComplete: VerificationState;
  organizerReproduced: VerificationState;
  implementationOpen: VerificationState;
  modelIdentityAttested: VerificationState;
  hiddenTestCompliant: VerificationState;
  accountIdentityAttested: VerificationState;
  timeAttested: VerificationState;
  publicationLogged: VerificationState;
  tailAnchored: VerificationState;
  availabilityObserved: VerificationState;
  externalAuthorities: ExternalTrustResult[];
  reasons: string[];
}

export interface LeaderboardEntryV2 extends LeaderboardEntry {
  schema: 'gaos.leaderboard-entry.v2';
  verification: SubmissionVerificationFacts;
  eligibility?: {
    policyId: string;
    policyVersion: string;
    decision: 'eligible' | 'ineligible' | 'pending';
    reasons: string[];
  };
}

export type BenchmarkAgentKind = 'local' | 'provider' | 'cli';

export interface BenchmarkResourceObservations {
  steps: number;
  wallClockMs?: number;
  tokens?: number;
  cost?: number;
  provider?: string;
}

export interface BenchmarkEpisodeResult {
  plan: BenchmarkEpisodePlan;
  score: number;
  replay: JsonValue;
  terminalOutcome: JsonValue;
  observations: BenchmarkResourceObservations;
}

export interface BenchmarkAgentAdapter {
  kind: BenchmarkAgentKind;
  id: string;
  runEpisode(plan: BenchmarkEpisodePlan): Promise<BenchmarkEpisodeResult>;
}

export interface BenchmarkRunCheckpoint {
  schema: 'gaos.benchmark-run-checkpoint.v1';
  manifestDigest: string;
  agent: { kind: BenchmarkAgentKind; id: string };
  plan: readonly BenchmarkEpisodePlan[];
  completed: readonly BenchmarkEpisodeResult[];
}

export interface BenchmarkRun {
  status: 'complete' | 'interrupted';
  checkpoint: BenchmarkRunCheckpoint;
  aggregate?: BenchmarkAggregate;
}

export interface BenchmarkBundleEpisode {
  id: string;
  plan: BenchmarkEpisodePlan;
  replay: JsonValue;
  terminalOutcome: JsonValue;
  score: number;
  replayDigest: string;
}

export interface BenchmarkBundle {
  schema: 'gaos.benchmark-bundle.v1';
  /** Digest of all authoritative contents, excluding attestations and this field. */
  contentDigest: string;
  manifest: BenchmarkManifest;
  manifestDigest: string;
  submission: {
    submissionId: string;
    agentId: string;
    agentKind: BenchmarkAgentKind;
    attestations?: readonly ExternalAttestation[];
  };
  episodes: readonly BenchmarkBundleEpisode[];
  scores: BenchmarkAggregate;
}

export interface BenchmarkBundleVerification {
  valid: boolean;
  bundleDigest: string;
  aggregate?: BenchmarkAggregate;
  episodeFacts: readonly {
    id: string;
    replayValid: boolean;
    score: number;
    terminalOutcome: JsonValue;
    signatures: VerificationState;
    semantics: VerificationState;
    evidenceComplete: VerificationState;
    reasons: string[];
  }[];
  facts: SubmissionVerificationFacts;
}

export interface BenchmarkEpisodeVerification {
  replayValid: boolean;
  score: number;
  terminalOutcome: JsonValue;
  signatures: VerificationState;
  semantics: VerificationState;
  evidenceComplete: VerificationState;
  reasons?: string[];
}

export interface BenchmarkVerificationOptions {
  externalTrustResolver?: ExternalTrustResolver;
}

export interface BenchmarkPackage {
  bundle: BenchmarkBundle;
  files: Readonly<Record<string, string>>;
  digest: string;
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
  if (manifest.authorityRequirements !== undefined) {
    const claims = new Set<string>();
    for (const requirement of manifest.authorityRequirements) {
      assertNonEmpty(requirement.authorityId, 'authorityRequirement.authorityId');
      if (requirement.acceptedSchemas.length === 0) {
        throw new TypeError('authority requirement must accept at least one schema');
      }
      const identity = `${requirement.claim}:${requirement.authorityId}`;
      if (claims.has(identity)) throw new TypeError(`duplicate authority requirement ${identity}`);
      claims.add(identity);
    }
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

const encoder = new TextEncoder();

export function benchmarkManifestDigest(manifest: BenchmarkManifest): string {
  assertBenchmarkManifest(manifest);
  return bytesToHex(
    sha256(encoder.encode(canonicalJson(manifest as unknown as JsonValue))),
  );
}

function episodeId(plan: BenchmarkEpisodePlan): string {
  return `${plan.taskId}-seed-${plan.seed}-episode-${plan.episode}`;
}

function assertEpisodeResult(
  expected: BenchmarkEpisodePlan,
  result: BenchmarkEpisodeResult,
): void {
  if (canonicalJson(result.plan as unknown as JsonValue)
    !== canonicalJson(expected as unknown as JsonValue)) {
    throw new TypeError(`agent returned a result for the wrong episode ${expected.index}`);
  }
  if (!Number.isFinite(result.score)) {
    throw new RangeError(`episode ${expected.index} score must be finite`);
  }
  if (!Number.isSafeInteger(result.observations.steps)
    || result.observations.steps < 0
    || result.observations.steps > expected.maxSteps) {
    throw new RangeError(`episode ${expected.index} reported invalid step count`);
  }
}

function aggregateEpisodeResults(
  manifest: BenchmarkManifest,
  completed: readonly BenchmarkEpisodeResult[],
): BenchmarkAggregate {
  const byTask = new Map<string, number[]>();
  for (const result of completed) {
    const scores = byTask.get(result.plan.taskId) ?? [];
    scores.push(result.score);
    byTask.set(result.plan.taskId, scores);
  }
  return aggregateBenchmarkScores(
    manifest,
    manifest.tasks.map((task) => {
      const values = byTask.get(task.id);
      if (values === undefined || values.length !== task.seeds.length * task.episodes) {
        throw new TypeError(`missing episode scores for task ${task.id}`);
      }
      return {
        taskId: task.id,
        score: values.reduce((sum, value) => sum + value, 0) / values.length,
      };
    }),
  );
}

/**
 * Execute the authored plan with bounded concurrency. Results and checkpoints
 * are always canonical plan order, so parallelism and resume cannot affect
 * episode identities or scores.
 */
export async function runBenchmark(
  manifest: BenchmarkManifest,
  adapter: BenchmarkAgentAdapter,
  options: {
    parallelism?: number;
    resume?: BenchmarkRunCheckpoint;
    maxNewEpisodes?: number;
  } = {},
): Promise<BenchmarkRun> {
  const plan = planBenchmarkEpisodes(manifest);
  const manifestDigest = benchmarkManifestDigest(manifest);
  const parallelism = options.parallelism ?? 1;
  if (!Number.isSafeInteger(parallelism) || parallelism < 1) {
    throw new RangeError('parallelism must be a positive safe integer');
  }
  if (options.maxNewEpisodes !== undefined
    && (!Number.isSafeInteger(options.maxNewEpisodes)
      || options.maxNewEpisodes < 0)) {
    throw new RangeError('maxNewEpisodes must be a non-negative safe integer');
  }
  const completed = new Map<number, BenchmarkEpisodeResult>();
  if (options.resume !== undefined) {
    if (options.resume.schema !== 'gaos.benchmark-run-checkpoint.v1'
      || options.resume.manifestDigest !== manifestDigest
      || canonicalJson(options.resume.plan as unknown as JsonValue)
        !== canonicalJson(plan as unknown as JsonValue)
      || options.resume.agent.kind !== adapter.kind
      || options.resume.agent.id !== adapter.id) {
      throw new TypeError('checkpoint is incompatible with this benchmark run');
    }
    for (const result of options.resume.completed) {
      const expected = plan[result.plan.index];
      if (expected === undefined || completed.has(result.plan.index)) {
        throw new TypeError('checkpoint contains duplicate or unknown episodes');
      }
      assertEpisodeResult(expected, result);
      completed.set(result.plan.index, structuredClone(result));
    }
  }
  const pending = plan.filter((entry) => !completed.has(entry.index));
  const limit = options.maxNewEpisodes === undefined
    ? pending.length
    : Math.max(0, Math.min(pending.length, options.maxNewEpisodes));
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(parallelism, limit) },
    async () => {
      while (cursor < limit) {
        const entry = pending[cursor++]!;
        const result = await adapter.runEpisode(structuredClone(entry));
        assertEpisodeResult(entry, result);
        completed.set(entry.index, structuredClone(result));
      }
    },
  );
  await Promise.all(workers);
  const ordered = [...completed.values()].sort(
    (left, right) => left.plan.index - right.plan.index,
  );
  const checkpoint: BenchmarkRunCheckpoint = {
    schema: 'gaos.benchmark-run-checkpoint.v1',
    manifestDigest,
    agent: { kind: adapter.kind, id: adapter.id },
    plan: structuredClone(plan),
    completed: ordered,
  };
  if (ordered.length !== plan.length) return { status: 'interrupted', checkpoint };
  return {
    status: 'complete',
    checkpoint,
    aggregate: aggregateEpisodeResults(manifest, ordered),
  };
}

/** Reproducibly package a complete run in authored episode order. */
export function packBenchmarkRun(
  manifest: BenchmarkManifest,
  run: BenchmarkRun,
  submission: BenchmarkBundle['submission'],
): BenchmarkPackage {
  if (run.status !== 'complete' || run.aggregate === undefined) {
    throw new TypeError('only a complete benchmark run can be packed');
  }
  const expectedDigest = benchmarkManifestDigest(manifest);
  if (run.checkpoint.manifestDigest !== expectedDigest) {
    throw new TypeError('run checkpoint belongs to a different manifest');
  }
  const episodes = [...run.checkpoint.completed]
    .sort((left, right) => left.plan.index - right.plan.index)
    .map((result): BenchmarkBundleEpisode => {
      const replay = typeof result.replay === 'string'
        ? `${result.replay.replace(/\n*$/, '')}\n`
        : structuredClone(result.replay);
      const replayDigest = bytesToHex(
        sha256(encoder.encode(canonicalJson(replay))),
      );
      return {
        id: episodeId(result.plan),
        plan: structuredClone(result.plan),
        replay,
        terminalOutcome: structuredClone(result.terminalOutcome),
        score: result.score,
        replayDigest,
      };
    });
  const unsignedSubmission = {
    submissionId: submission.submissionId,
    agentId: submission.agentId,
    agentKind: submission.agentKind,
  };
  const content = {
    schema: 'gaos.benchmark-bundle.v1' as const,
    manifest: structuredClone(manifest),
    manifestDigest: expectedDigest,
    submission: unsignedSubmission,
    episodes,
    scores: structuredClone(run.aggregate),
  };
  const contentDigest = bytesToHex(
    sha256(encoder.encode(canonicalJson(content as unknown as JsonValue))),
  );
  if (submission.attestations?.some(
    (attestation) => attestation.subjectDigest !== contentDigest,
  )) {
    throw new TypeError('submission attestation is not bound to the bundle content digest');
  }
  const bundle: BenchmarkBundle = {
    ...content,
    contentDigest,
    submission: structuredClone(submission),
  };
  const files = benchmarkBundleFiles(bundle);
  return {
    bundle,
    files,
    digest: benchmarkPackageDigest(files),
  };
}

/** Stable digest signed by external attestations; attestations cannot self-bind. */
export function benchmarkBundleContentDigest(bundle: BenchmarkBundle): string {
  const content = {
    schema: bundle.schema,
    manifest: bundle.manifest,
    manifestDigest: bundle.manifestDigest,
    submission: {
      submissionId: bundle.submission.submissionId,
      agentId: bundle.submission.agentId,
      agentKind: bundle.submission.agentKind,
    },
    episodes: bundle.episodes,
    scores: bundle.scores,
  };
  return bytesToHex(
    sha256(encoder.encode(canonicalJson(content as unknown as JsonValue))),
  );
}

/** Attach receipts only after their subject is the already-computed content digest. */
export function attachBenchmarkAttestations(
  bundle: BenchmarkBundle,
  attestations: readonly ExternalAttestation[],
): BenchmarkBundle {
  const digest = benchmarkBundleContentDigest(bundle);
  if (digest !== bundle.contentDigest) {
    throw new TypeError('cannot attest a bundle with a mismatched content digest');
  }
  if (attestations.some((attestation) => attestation.subjectDigest !== digest)) {
    throw new TypeError('attestation subject does not match bundle content digest');
  }
  return {
    ...structuredClone(bundle),
    submission: {
      ...structuredClone(bundle.submission),
      attestations: structuredClone(attestations),
    },
  };
}

export function emptyVerificationFacts(): SubmissionVerificationFacts {
  return {
    replay: 'not-observed',
    signatures: 'not-observed',
    semantics: 'not-observed',
    evidenceComplete: 'not-observed',
    organizerReproduced: 'not-observed',
    implementationOpen: 'not-observed',
    modelIdentityAttested: 'not-observed',
    hiddenTestCompliant: 'not-observed',
    accountIdentityAttested: 'not-observed',
    timeAttested: 'not-observed',
    publicationLogged: 'not-observed',
    tailAnchored: 'not-observed',
    availabilityObserved: 'not-observed',
    externalAuthorities: [],
    reasons: [],
  };
}

/** Exact, portable `.gaos-bench` directory contents from RFC-015 §4. */
export function benchmarkBundleFiles(
  bundle: BenchmarkBundle,
  verification: SubmissionVerificationFacts = emptyVerificationFacts(),
): Readonly<Record<string, string>> {
  const files: Record<string, string> = {
    'manifest.json': `${canonicalJson(bundle.manifest as unknown as JsonValue)}\n`,
    'submission.json': `${canonicalJson({
      ...bundle.submission,
      contentDigest: bundle.contentDigest,
      manifestDigest: bundle.manifestDigest,
      schema: bundle.schema,
    } as unknown as JsonValue)}\n`,
    'scores.json': `${canonicalJson({
      aggregate: bundle.scores,
      episodes: bundle.episodes.map((episode) => ({
        id: episode.id,
        plan: episode.plan,
        terminalOutcome: episode.terminalOutcome,
        score: episode.score,
        replayDigest: episode.replayDigest,
        replayEncoding: typeof episode.replay === 'string' ? 'jsonl' : 'json',
      })),
    } as unknown as JsonValue)}\n`,
    'verification.json': `${canonicalJson(verification as unknown as JsonValue)}\n`,
    'README.md': [
      '# GAOS benchmark submission',
      '',
      `Content digest: \`${bundle.contentDigest}\``,
      '',
      'Verify independently with:',
      '',
      '```sh',
      'gaos benchmark verify submission.gaos-bench --manifest benchmark.json --adapter adapter.mjs',
      '```',
      '',
    ].join('\n'),
  };
  for (const episode of bundle.episodes) {
    files[`episodes/${encodeURIComponent(episode.id)}.gaos-replay.jsonl`] =
      typeof episode.replay === 'string'
        ? `${episode.replay.replace(/\n*$/, '')}\n`
        : `${canonicalJson(episode.replay)}\n`;
  }
  return files;
}

/** Hash sorted path/length/content tuples, independent of traversal metadata. */
export function benchmarkPackageDigest(
  files: Readonly<Record<string, string>>,
): string {
  const parts = Object.keys(files).sort().map((path) => {
    const bytes = encoder.encode(files[path]!);
    return `${path}\0${bytes.length}\0${files[path]!}`;
  });
  return bytesToHex(sha256(encoder.encode(parts.join(''))));
}

function combinedState(
  values: readonly VerificationState[],
  notRequired: boolean,
): VerificationState {
  if (notRequired) return 'not-required';
  if (values.some((value) => value === 'failed')) return 'failed';
  if (values.length > 0 && values.every((value) => value === 'verified')) {
    return 'verified';
  }
  return 'unverified';
}

function authorityFact(
  claim: BenchmarkAuthorityRequirement['claim'],
): keyof Pick<
  SubmissionVerificationFacts,
  | 'accountIdentityAttested'
  | 'timeAttested'
  | 'publicationLogged'
  | 'tailAnchored'
  | 'modelIdentityAttested'
  | 'hiddenTestCompliant'
> {
  if (claim === 'identity') return 'accountIdentityAttested';
  if (claim === 'time') return 'timeAttested';
  if (claim === 'publication') return 'publicationLogged';
  if (claim === 'tail-anchor') return 'tailAnchored';
  if (claim === 'model-identity') return 'modelIdentityAttested';
  return 'hiddenTestCompliant';
}

/**
 * Verify a portable bundle against an independently supplied manifest.
 * Carried episode and aggregate scores are comparison data, never authority.
 */
export async function verifyBenchmarkBundle(
  bundle: BenchmarkBundle,
  manifest: BenchmarkManifest,
  verifyEpisode: (
    episode: BenchmarkBundleEpisode,
  ) => Promise<BenchmarkEpisodeVerification>,
  options: BenchmarkVerificationOptions = {},
): Promise<BenchmarkBundleVerification> {
  const facts = emptyVerificationFacts();
  const reasons = facts.reasons;
  const bundleDigest = benchmarkPackageDigest(benchmarkBundleFiles(bundle));
  if (bundle.schema !== 'gaos.benchmark-bundle.v1') {
    reasons.push('unsupported benchmark bundle schema');
  }
  const manifestDigest = benchmarkManifestDigest(manifest);
  if (bundle.manifestDigest !== manifestDigest
    || benchmarkManifestDigest(bundle.manifest) !== manifestDigest) {
    reasons.push('bundle manifest does not match independently supplied manifest');
  }
  const contentDigest = benchmarkBundleContentDigest(bundle);
  if (bundle.contentDigest !== contentDigest) {
    reasons.push('bundle content digest mismatch');
  }
  const plan = planBenchmarkEpisodes(manifest);
  const expectedIds = new Set(plan.map(episodeId));
  const seen = new Set<string>();
  const episodeFacts: {
    id: string;
    replayValid: boolean;
    score: number;
    terminalOutcome: JsonValue;
    signatures: VerificationState;
    semantics: VerificationState;
    evidenceComplete: VerificationState;
    reasons: string[];
  }[] = [];
  const recomputed: BenchmarkEpisodeResult[] = [];
  for (const [bundleIndex, episode] of bundle.episodes.entries()) {
    const localReasons: string[] = [];
    if (!expectedIds.has(episode.id)) localReasons.push('episode is not required by manifest');
    if (seen.has(episode.id)) localReasons.push('duplicate episode');
    seen.add(episode.id);
    const expectedPlan = plan[bundleIndex];
    if (expectedPlan === undefined
      || episode.plan.index !== bundleIndex
      || canonicalJson(expectedPlan as unknown as JsonValue)
        !== canonicalJson(episode.plan as unknown as JsonValue)) {
      localReasons.push('episode plan does not exactly match the authored plan');
    }
    if (episode.id !== episodeId(episode.plan)) localReasons.push('episode id does not match plan');
    const replayDigest = bytesToHex(
      sha256(encoder.encode(canonicalJson(episode.replay))),
    );
    if (episode.replayDigest !== replayDigest) localReasons.push('replay digest mismatch');
    let checked: BenchmarkEpisodeVerification;
    try {
      checked = await verifyEpisode(structuredClone(episode));
    } catch (error) {
      checked = {
        replayValid: false,
        score: Number.NaN,
        terminalOutcome: null,
        signatures: 'failed',
        semantics: 'failed',
        evidenceComplete: 'failed',
        reasons: [
          `episode verifier failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
    localReasons.push(...(checked.reasons ?? []));
    if (!checked.replayValid) localReasons.push('episode replay verification failed');
    if (checked.score !== episode.score) localReasons.push('carried episode score is incorrect');
    if (canonicalJson(checked.terminalOutcome)
      !== canonicalJson(episode.terminalOutcome)) {
      localReasons.push('carried terminal outcome is incorrect');
    }
    episodeFacts.push({
      id: episode.id,
      replayValid: checked.replayValid,
      score: checked.score,
      terminalOutcome: structuredClone(checked.terminalOutcome),
      signatures: checked.signatures,
      semantics: checked.semantics,
      evidenceComplete: checked.evidenceComplete,
      reasons: localReasons,
    });
    if (localReasons.length === 0) {
      recomputed.push({
        plan: structuredClone(episode.plan),
        score: checked.score,
        replay: structuredClone(episode.replay),
        terminalOutcome: structuredClone(checked.terminalOutcome),
        observations: { steps: 0 },
      });
    }
  }
  for (const id of expectedIds) {
    if (!seen.has(id)) reasons.push(`missing required episode ${id}`);
  }
  if (seen.size !== expectedIds.size) reasons.push('bundle episode set is incompatible');
  reasons.push(...episodeFacts.flatMap((fact) => fact.reasons.map(
    (reason) => `${fact.id}: ${reason}`,
  )));
  let aggregate: BenchmarkAggregate | undefined;
  if (recomputed.length === plan.length && reasons.length === 0) {
    aggregate = aggregateEpisodeResults(manifest, recomputed);
    if (canonicalJson(aggregate as unknown as JsonValue)
      !== canonicalJson(bundle.scores as unknown as JsonValue)) {
      reasons.push('carried task or aggregate scores are incorrect');
    }
  }
  for (const requirement of manifest.authorityRequirements ?? []) {
    const field = authorityFact(requirement.claim);
    const candidates = (bundle.submission.attestations ?? []).filter(
      (attestation) =>
        attestation.authority.authorityId === requirement.authorityId
        && attestation.authority.purpose === requirement.purpose
        && requirement.acceptedSchemas.includes(attestation.schema)
        && (requirement.keyIds === undefined
          || requirement.keyIds.includes(attestation.authority.keyId)),
    );
    const results: ExternalTrustResult[] = [];
    if (options.externalTrustResolver !== undefined) {
      for (const attestation of candidates) {
        results.push(await verifyExternalAttestation(
          attestation,
          contentDigest,
          {
            pinnedKeys: requirement.keyIds === undefined
              ? []
              : requirement.keyIds.map((keyId) => ({
                authorityId: requirement.authorityId,
                keyId,
                purpose: requirement.purpose,
              })),
            ...(requirement.pinnedRootDigests === undefined
              ? {}
              : { pinnedRootDigests: requirement.pinnedRootDigests }),
            acceptedSchemas: requirement.acceptedSchemas,
            ...(requirement.acceptedAlgorithms === undefined
              ? {}
              : { acceptedAlgorithms: requirement.acceptedAlgorithms }),
            ...(requirement.revocationPolicy === undefined
              ? {}
              : { revocationPolicy: requirement.revocationPolicy }),
          },
          options.externalTrustResolver,
        ));
      }
    }
    facts.externalAuthorities.push(...results);
    const accepted = results.some((result) => result.policyAccepted);
    facts[field] = accepted
      ? 'verified'
      : requirement.required ? 'failed' : 'not-observed';
    if (requirement.required && !accepted) {
      reasons.push(
        `required ${requirement.claim} attestation from ${requirement.authorityId} is missing or invalid`,
      );
    }
  }
  facts.replay = episodeFacts.every((fact) => fact.replayValid) ? 'verified' : 'failed';
  facts.signatures = combinedState(
    episodeFacts.map((fact) => fact.signatures),
    !manifest.submission.requireSignedSeats,
  );
  facts.semantics = combinedState(
    episodeFacts.map((fact) => fact.semantics),
    false,
  );
  facts.evidenceComplete = combinedState(
    episodeFacts.map((fact) => fact.evidenceComplete),
    !manifest.submission.requireCompleteCoverage,
  );
  if (manifest.submission.requireSignedSeats && facts.signatures !== 'verified') {
    reasons.push('signed-seat evidence is required but was not verified');
  }
  if (manifest.submission.requireCompleteCoverage
    && facts.evidenceComplete !== 'verified') {
    reasons.push('complete evidence coverage is required but was not verified');
  }
  if (facts.semantics !== 'verified') {
    reasons.push('episode semantics were not verified');
  }
  return {
    valid: reasons.length === 0,
    bundleDigest,
    ...(aggregate === undefined ? {} : { aggregate }),
    episodeFacts,
    facts,
  };
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
