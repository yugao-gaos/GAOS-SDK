import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  benchmarkManifestDigest,
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
    const verify = (episode: typeof first.bundle.episodes[number]) => Promise.resolve({
      replayValid: true,
      score: (episode.terminalOutcome as { score: number }).score,
    });
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
    const verify = (episode: typeof bundle.episodes[number]) => Promise.resolve({
      replayValid: true,
      score: (episode.terminalOutcome as { score: number }).score,
    });
    expect((await verifyBenchmarkBundle(bundle, required, verify)).valid).toBe(false);
    expect((await verifyBenchmarkBundle(bundle, required, verify, [{
      cryptographicallyValid: true,
      authorityPinned: true,
      policyAccepted: true,
      authority: { authorityId: 'organizer', keyId: 'current', purpose: 'identity' },
      reasons: [],
    }])).valid).toBe(true);
    expect(benchmarkManifestDigest({ ...required, benchmark: { ...required.benchmark, version: '2' } }))
      .not.toBe(bundle.manifestDigest);
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
      artifactDigest: 'digest',
      evidenceVerdict: 'trusted',
      reproduced: false,
      verification: facts(),
    }, new Uint8Array([1, 2, 3]));
    expect(service.list({ benchmarkVersion: '1', modality: 'text' })).toHaveLength(1);
    expect(service.metadata('s1')).toMatchObject({
      artifactDownload: '/api/submissions/s1/artifact',
      entry: { verification: { replay: 'verified', organizerReproduced: 'not-observed' } },
    });
    expect(await service.artifact('s1')).toEqual(new Uint8Array([1, 2, 3]));
    expect(queued).toEqual(['s1']);
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
  return { replayValid: true, score: episode.terminalOutcome.score };
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
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
