import { mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  attachBenchmarkAttestations,
  benchmarkManifestDigest,
  benchmarkPackageDigest,
  packBenchmarkRun,
  runBenchmark,
  verifyBenchmarkBundle,
  type BenchmarkAgentAdapter,
  type BenchmarkAgentKind,
  type BenchmarkManifest,
  type SubmissionVerificationFacts,
} from '../src/benchmark.js';
import { runBenchmarkCli } from '../src/benchmark-cli.js';
import {
  actionEfficiency,
  assertFormalMetricPreconditions,
  assertTransformDescriptor,
  headToHeadPayoffMatrix,
  updateEloRatings,
  type GameDescriptor,
} from '../src/engine/research.js';
import { LeaderboardService } from '../src/leaderboard.js';
import {
  externalAttestationPreimage,
  type ExternalAttestation,
} from '../src/evidence.js';
import {
  generateSubmissionKeyPair,
  signEd25519Base64,
} from '../src/engine/submission-signatures.js';

const manifest: BenchmarkManifest = {
  schema: 'gaos.benchmark-manifest',
  schemaVersion: '1.0',
  benchmark: { id: 'reference', version: '1', adapter: 'reference-game@1' },
  tasks: [
    { id: 'a', seeds: [3, 1], episodes: 2, maxSteps: 10 },
    { id: 'b', seeds: [7], episodes: 1, maxSteps: 10 },
  ],
  scoring: { plugin: 'terminal-score@1', aggregation: 'mean' },
  submission: { requireSignedSeats: false, requireCompleteCoverage: true },
};

function adapter(kind: BenchmarkAgentKind): BenchmarkAgentAdapter {
  return {
    kind,
    id: 'fixture-agent',
    runEpisode: async (plan) => {
      await new Promise((resolve) => setTimeout(resolve, (4 - plan.index) % 3));
      const score = plan.seed + plan.episode;
      return {
        plan,
        score,
        replay: { task: plan.taskId, seed: plan.seed, score },
        terminalOutcome: { score },
        observations: {
          steps: plan.episode + 1,
          wallClockMs: 5,
          tokens: 2,
          cost: 0.01,
          provider: kind,
        },
      };
    },
  };
}

function facts(): SubmissionVerificationFacts {
  return {
    replay: 'verified',
    signatures: 'not-required',
    semantics: 'verified',
    evidenceComplete: 'verified',
    organizerReproduced: 'not-observed',
    implementationOpen: 'verified',
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

function verifiedEpisode(
  episode: Parameters<Parameters<typeof verifyBenchmarkBundle>[2]>[0],
  signatures: 'verified' | 'not-required' | 'unverified' = 'not-required',
) {
  return Promise.resolve({
    replayValid: true,
    score: (episode.terminalOutcome as { score: number }).score,
    terminalOutcome: structuredClone(episode.terminalOutcome),
    signatures,
    semantics: 'verified' as const,
    evidenceComplete: 'verified' as const,
  });
}

describe('RFC-015 release gate', () => {
  it('keeps sequential, parallel, interrupted, resumed, and all agent paths deterministic', async () => {
    const sequential = await runBenchmark(manifest, adapter('local'));
    const parallel = await runBenchmark(manifest, adapter('local'), { parallelism: 3 });
    expect(parallel).toEqual(sequential);
    const interrupted = await runBenchmark(manifest, adapter('local'), {
      parallelism: 2,
      maxNewEpisodes: 2,
    });
    expect(interrupted.status).toBe('interrupted');
    const resumed = await runBenchmark(manifest, adapter('local'), {
      parallelism: 3,
      resume: interrupted.checkpoint,
    });
    expect(resumed).toEqual(sequential);
    for (const kind of ['provider', 'cli'] as const) {
      const run = await runBenchmark(manifest, adapter(kind), { parallelism: 2 });
      expect(run.checkpoint.plan).toEqual(sequential.checkpoint.plan);
      expect(run.aggregate).toEqual(sequential.aggregate);
    }
  });

  it('packs reproducibly and independently rejects missing, duplicate, modified, and incompatible evidence', async () => {
    const run = await runBenchmark(manifest, adapter('local'), { parallelism: 3 });
    const first = packBenchmarkRun(manifest, run, {
      submissionId: 'submission',
      agentId: 'fixture-agent',
      agentKind: 'local',
    });
    const shuffled = structuredClone(run);
    shuffled.checkpoint.completed = [...shuffled.checkpoint.completed].reverse();
    expect(packBenchmarkRun(manifest, shuffled, first.bundle.submission).digest)
      .toBe(first.digest);
    const verify = (episode: typeof first.bundle.episodes[number]) =>
      verifiedEpisode(episode);
    const valid = await verifyBenchmarkBundle(first.bundle, manifest, verify);
    expect(valid).toMatchObject({
      valid: true,
      aggregate: run.aggregate,
      facts: { replay: 'verified', semantics: 'verified', evidenceComplete: 'verified' },
    });

    const missing = structuredClone(first.bundle);
    missing.episodes = missing.episodes.slice(1);
    expect((await verifyBenchmarkBundle(missing, manifest, verify)).valid).toBe(false);
    const duplicate = structuredClone(first.bundle);
    duplicate.episodes = [...duplicate.episodes, duplicate.episodes[0]!];
    expect((await verifyBenchmarkBundle(duplicate, manifest, verify)).valid).toBe(false);
    const modified = structuredClone(first.bundle);
    modified.episodes[0]!.replay = { modified: true };
    expect((await verifyBenchmarkBundle(modified, manifest, verify)).valid).toBe(false);
    const incorrectScore = structuredClone(first.bundle);
    incorrectScore.episodes[0]!.score += 1;
    expect((await verifyBenchmarkBundle(incorrectScore, manifest, verify)).valid).toBe(false);
    const incompatible = structuredClone(first.bundle);
    incompatible.manifestDigest = '0'.repeat(64);
    expect((await verifyBenchmarkBundle(incompatible, manifest, verify)).valid).toBe(false);
    const wrongPlan = structuredClone(first.bundle);
    wrongPlan.episodes[0]!.plan.maxSteps += 1;
    expect((await verifyBenchmarkBundle(wrongPlan, manifest, verify)).valid).toBe(false);
    const reordered = structuredClone(first.bundle);
    reordered.episodes = [
      reordered.episodes[1]!,
      reordered.episodes[0]!,
      ...reordered.episodes.slice(2),
    ];
    expect((await verifyBenchmarkBundle(reordered, manifest, verify)).valid).toBe(false);
    const wrongOutcome = structuredClone(first.bundle);
    wrongOutcome.episodes[0]!.terminalOutcome = { score: 999 };
    expect((await verifyBenchmarkBundle(
      wrongOutcome,
      manifest,
      (episode) => verifiedEpisode({
        ...episode,
        terminalOutcome: { score: episode.score },
      }),
    )).valid).toBe(false);
    expect(benchmarkPackageDigest(first.files)).toBe(first.digest);
    expect(Object.keys(first.files).sort()).toEqual([
      'README.md',
      ...first.bundle.episodes.map(
        ({ id }) => `episodes/${encodeURIComponent(id)}.gaos-replay.jsonl`,
      ),
      'manifest.json',
      'scores.json',
      'submission.json',
      'verification.json',
    ].sort());
  });

  it('pins required external authority facts to the independent manifest', async () => {
    const required: BenchmarkManifest = {
      ...manifest,
      authorityRequirements: [{
        claim: 'model-identity',
        purpose: 'identity',
        authorityId: 'organizer',
        keyIds: ['current'],
        acceptedSchemas: ['gaos.identity.v1'],
        required: true,
      }],
    };
    const run = await runBenchmark(required, adapter('local'));
    const { bundle } = packBenchmarkRun(required, run, {
      submissionId: 'authority-submission',
      agentId: 'fixture-agent',
      agentKind: 'local',
    });
    const verify = (episode: typeof bundle.episodes[number]) =>
      verifiedEpisode(episode, 'not-required');
    expect((await verifyBenchmarkBundle(bundle, required, verify)).valid).toBe(false);
    const keyPair = await generateSubmissionKeyPair();
    const jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const authority = {
      authorityId: 'organizer',
      keyId: 'current',
      purpose: 'identity' as const,
    };
    const unsigned = {
      schema: 'gaos.identity.v1',
      authority,
      subjectDigest: bundle.contentDigest,
      algorithm: 'Ed25519',
      payload: { model: 'fixture' },
    };
    const attestation: ExternalAttestation = {
      ...unsigned,
      signature: await signEd25519Base64(
        keyPair.privateKey,
        externalAttestationPreimage(unsigned),
      ),
    };
    const attested = attachBenchmarkAttestations(bundle, [attestation]);
    const resolver = {
      resolveKey: async () => ({ format: 'jwk' as const, key: jwk }),
    };
    expect((await verifyBenchmarkBundle(
      attested,
      required,
      verify,
      { externalTrustResolver: resolver },
    )).valid).toBe(true);
    const substituted = structuredClone(attested);
    substituted.episodes[0]!.score += 1;
    expect((await verifyBenchmarkBundle(
      substituted,
      required,
      verify,
      { externalTrustResolver: resolver },
    )).valid).toBe(false);
    expect(benchmarkManifestDigest({ ...required, benchmark: { ...required.benchmark, version: '2' } }))
      .not.toBe(bundle.manifestDigest);
  });

  it('cannot accept required signatures while episode signatures are unverified', async () => {
    const signedManifest: BenchmarkManifest = {
      ...manifest,
      submission: {
        requireSignedSeats: true,
        requireCompleteCoverage: true,
      },
    };
    const run = await runBenchmark(signedManifest, adapter('local'));
    const { bundle } = packBenchmarkRun(signedManifest, run, {
      submissionId: 'signed',
      agentId: 'fixture-agent',
      agentKind: 'local',
    });
    const unverified = await verifyBenchmarkBundle(
      bundle,
      signedManifest,
      (episode) => verifiedEpisode(episode, 'unverified'),
    );
    expect(unverified.valid).toBe(false);
    expect(unverified.facts.signatures).toBe('unverified');
    expect(unverified.facts.reasons).toContain(
      'signed-seat evidence is required but was not verified',
    );
  });

  it('ships qualified research metrics and rejects unsupported formal assumptions', () => {
    expect(headToHeadPayoffMatrix([
      { rowPolicy: 'a', columnPolicy: 'b', rowUtility: 1, episodes: 2 },
      { rowPolicy: 'a', columnPolicy: 'b', rowUtility: -1, episodes: 1 },
    ]).utilities.a!.b).toBeCloseTo(1 / 3);
    expect(actionEfficiency({
      attempted: 10,
      accepted: 7,
      invalid: 3,
      productive: 5,
    })).toMatchObject({ invalidActionRate: 0.3, productiveActionRate: 0.5 });
    expect(updateEloRatings([
      { id: 'a', value: 1000 },
      { id: 'b', value: 1000 },
    ], [{ left: 'a', right: 'b', leftScore: 1 }])).toEqual([
      { id: 'a', value: 1016 },
      { id: 'b', value: 984 },
    ]);
    const descriptor: GameDescriptor = {
      id: 'game',
      version: '1',
      dynamics: 'sequential',
      chance: 'none',
      information: 'perfect',
      utility: 'general-sum',
      rewards: 'terminal',
      minPlayers: 2,
      maxPlayers: 2,
      minUtility: -1,
      maxUtility: 1,
    };
    expect(() => assertFormalMetricPreconditions('exploitability', descriptor))
      .toThrow(/zero-sum/);
    expect(() => assertTransformDescriptor({
      schema: 'gaos.game-transform.v1',
      transform: 'simultaneous-to-sequential',
      input: descriptor,
      output: descriptor,
      deterministic: true,
      evidenceIdentity: 'transform@1',
    })).toThrow(/simultaneous/);
  });

  it('provides dual-database leaderboard storage and separate trust facts', async () => {
    const sqlite = readFileSync(
      new URL('../examples/leaderboard/sqlite.sql', import.meta.url),
      'utf8',
    );
    const postgres = readFileSync(
      new URL('../examples/leaderboard/postgresql.sql', import.meta.url),
      'utf8',
    );
    expect(sqlite).toContain('benchmark_task_scores');
    expect(postgres).toContain('JSONB');
    const stored = new Map<string, Uint8Array>();
    const queued: string[] = [];
    const service = new LeaderboardService({
      put: async (digest, bytes) => { stored.set(digest, bytes); },
      get: async (digest) => stored.get(digest),
    }, {
      enqueue: async (submissionId) => { queued.push(submissionId); },
    });
    const serviceBundle = new Uint8Array([1, 2, 3]);
    const serviceDigest = createHash('sha256').update(serviceBundle).digest('hex');
    await service.submit({
      schema: 'gaos.leaderboard-entry.v2',
      benchmarkId: 'reference',
      benchmarkVersion: '1',
      submissionId: 's1',
      agentName: 'agent',
      modality: 'text',
      aggregateScore: 1,
      taskScores: { a: 1 },
      uncertainty: 0.1,
      artifactDigest: serviceDigest,
      evidenceVerdict: 'trusted',
      reproduced: false,
      verification: facts(),
    }, serviceBundle);
    expect(service.list({ benchmarkVersion: '1', modality: 'text' })).toHaveLength(1);
    expect(service.metadata('s1')).toMatchObject({
      artifactDownload: '/api/submissions/s1/artifact',
      entry: { evidenceVerdict: 'unverifiable', verification: {
        replay: 'not-observed', reasons: ['pending independent verification'],
      } },
    });
    expect(await service.artifact('s1')).toEqual(serviceBundle);
    expect(queued).toEqual(['s1']);
  });

  it('runs the deployable SQLite HTTP leaderboard, object store, and verifier queue', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gaos-leaderboard-'));
    const { startLeaderboardServer, databaseBoolean, normalizeDatabaseBoolean, normalizeDatabaseJson } = await import(
      '../examples/leaderboard/server.mjs'
    ) as {
      startLeaderboardServer(options: {
        database: string;
        objects: string;
        port: number;
      }): import('node:http').Server;
      databaseBoolean(database: string, value: boolean): string;
      normalizeDatabaseBoolean(value: unknown): boolean;
      normalizeDatabaseJson(value: unknown): unknown;
    };
    expect(databaseBoolean('postgresql://fixture', true)).toBe('TRUE');
    expect(databaseBoolean('postgresql://fixture', false)).toBe('FALSE');
    expect(['t', true, 1].map(normalizeDatabaseBoolean)).toEqual([true, true, true]);
    expect(normalizeDatabaseJson({ replay: 'verified' })).toEqual({ replay: 'verified' });
    expect(normalizeDatabaseJson('{"replay":"verified"}')).toEqual({ replay: 'verified' });
    const server = startLeaderboardServer({
      database: join(directory, 'leaderboard.sqlite'),
      objects: join(directory, 'objects'),
      port: 0,
    });
    try {
      await new Promise<void>((resolve) => server.once('listening', resolve));
      const address = server.address();
      if (address === null || typeof address === 'string') throw new Error('missing address');
      const base = `http://127.0.0.1:${address.port}`;
      expect(await (await fetch(base)).text()).toContain('Benchmark submissions');
      const bundleBytes = Buffer.from('bundle bytes');
      const artifactDigest = createHash('sha256').update(bundleBytes).digest('hex');
      const entry = {
        schema: 'gaos.leaderboard-entry.v2',
        benchmarkId: 'reference',
        benchmarkVersion: '1',
        submissionId: 'http-1',
        agentName: 'agent',
        modality: 'text',
        aggregateScore: 3,
        taskScores: { a: 3 },
        uncertainty: 0.2,
        artifactDigest,
        evidenceVerdict: 'trusted',
        reproduced: false,
        verification: facts(),
      };
      const submitted = await fetch(`${base}/api/submissions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          entry,
          bundleBase64: bundleBytes.toString('base64'),
        }),
      });
      expect(submitted.status).toBe(202);
      expect(await (await fetch(
        `${base}/api/submissions?benchmarkVersion=1&modality=text`,
      )).json()).toMatchObject([{ submissionId: 'http-1', taskScores: { a: 3 } }]);
      expect(await (await fetch(`${base}/api/submissions/http-1`)).json())
        .toMatchObject({
          artifactDownload: '/api/submissions/http-1/artifact',
          entry: { evidenceVerdict: 'unverifiable', verification: { replay: 'not-observed' } },
        });
      expect(Buffer.from(await (await fetch(
        `${base}/api/submissions/http-1/artifact`,
      )).arrayBuffer()).toString()).toBe('bundle bytes');
      expect(await (await fetch(`${base}/api/verifier/dequeue`, {
        method: 'POST',
      })).json()).toMatchObject({
        submission_id: 'http-1',
        artifact_digest: artifactDigest,
        status: 'pending',
      });
      expect(await (await fetch(`${base}/api/verifier/dequeue`, {
        method: 'POST',
      })).json()).toBeNull();
      expect((await fetch(`${base}/api/verifier/complete`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          submissionId: 'http-1',
          evidenceVerdict: 'trusted',
          reproduced: true,
          verification: facts(),
        }),
      })).status).toBe(200);
      expect(await (await fetch(`${base}/api/submissions/http-1`)).json())
        .toMatchObject({ entry: {
          evidenceVerdict: 'trusted', reproduced: true,
          verification: { replay: 'verified' },
        } });
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
      const restarted = startLeaderboardServer({
        database: join(directory, 'leaderboard.sqlite'),
        objects: join(directory, 'objects'),
        port: 0,
      });
      await new Promise<void>((resolve) => restarted.once('listening', resolve));
      await new Promise<void>((resolve, reject) =>
        restarted.close((error) => error ? reject(error) : resolve()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it('runs the init/run/pack/verify CLI workflow with an independent manifest', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gaos-benchmark-cli-'));
    try {
      const manifestPath = join(directory, 'benchmark.json');
      const runDirectory = join(directory, 'run');
      const bundlePath = join(directory, 'submission.gaos-bench');
      const adapterPath = join(directory, 'adapter.mjs');
      writeFileSync(manifestPath, JSON.stringify(manifest));
      writeFileSync(adapterPath, `
export default {
  kind: 'cli',
  id: 'fixture-agent',
  async runEpisode(plan) {
    const score = plan.seed + plan.episode;
    return {
      plan,
      score,
      replay: { score },
      terminalOutcome: { score },
      observations: { steps: 1 }
    };
  }
};
export async function verifyEpisode(episode) {
  return {
    replayValid: true,
    score: episode.terminalOutcome.score,
    terminalOutcome: episode.terminalOutcome,
    signatures: 'not-required',
    semantics: 'verified',
    evidenceComplete: 'verified'
  };
}
`);
      const output: string[] = [];
      const errors: string[] = [];
      const io = {
        cwd: directory,
        stdout: (text: string) => output.push(text),
        stderr: (text: string) => errors.push(text),
      };
      expect(await runBenchmarkCli([
        'benchmark',
        'run',
        manifestPath,
        '--agent',
        adapterPath,
        '--output',
        runDirectory,
        '--parallelism',
        '2',
      ], io)).toBe(0);
      expect(await runBenchmarkCli([
        'benchmark',
        'pack',
        runDirectory,
        '--output',
        bundlePath,
      ], io)).toBe(0);
      expect(await runBenchmarkCli([
        'benchmark',
        'verify',
        bundlePath,
        '--manifest',
        manifestPath,
        '--adapter',
        adapterPath,
      ], io)).toBe(0);
      expect(errors).toEqual([]);
      expect(JSON.parse(output.at(-1)!)).toMatchObject({ valid: true });
      writeFileSync(join(bundlePath, 'extra.txt'), 'smuggled');
      expect(await runBenchmarkCli([
        'benchmark', 'verify', bundlePath, '--manifest', manifestPath, '--adapter', adapterPath,
      ], io)).toBe(2);
      unlinkSync(join(bundlePath, 'extra.txt'));
      symlinkSync(join(bundlePath, 'README.md'), join(bundlePath, 'alias'));
      expect(await runBenchmarkCli([
        'benchmark', 'verify', bundlePath, '--manifest', manifestPath, '--adapter', adapterPath,
      ], io)).toBe(2);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
