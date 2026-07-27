import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  packBenchmarkRun,
  runBenchmark,
  verifyBenchmarkBundle,
  type BenchmarkAgentAdapter,
  type BenchmarkBundle,
  type BenchmarkBundleEpisode,
  type BenchmarkEpisodeVerification,
  type BenchmarkManifest,
  type BenchmarkRun,
} from './benchmark.js';
import type { ExternalTrustResolver } from './evidence.js';

export interface BenchmarkCliIo {
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface RunFile {
  schema: 'gaos.benchmark-run-file.v1';
  manifest: BenchmarkManifest;
  run: BenchmarkRun;
}

interface AgentModule {
  default?: BenchmarkAgentAdapter;
  createBenchmarkAgent?: () => BenchmarkAgentAdapter | Promise<BenchmarkAgentAdapter>;
  verifyEpisode?: (
    episode: BenchmarkBundleEpisode,
  ) => Promise<BenchmarkEpisodeVerification>;
  externalTrustResolver?: ExternalTrustResolver;
}

function usage(): string {
  return [
    'usage:',
    '  gaos benchmark init [benchmark.json]',
    '  gaos benchmark run <manifest.json> --agent <agent.mjs> [--output <run-dir>] [--parallelism <n>]',
    '  gaos benchmark resume <run-dir> --agent <agent.mjs> [--parallelism <n>]',
    '  gaos benchmark pack <run-dir> [--output <submission.gaos-bench>]',
    '  gaos benchmark verify <submission.gaos-bench> --manifest <manifest.json> --adapter <adapter.mjs>',
    '',
  ].join('\n');
}

function option(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index < 0 ? undefined : argv[index + 1];
}

async function loadAgent(cwd: string, path: string | undefined): Promise<BenchmarkAgentAdapter> {
  if (!path) throw new TypeError('--agent requires a module path');
  const loaded = await import(pathToFileURL(resolve(cwd, path)).href) as AgentModule;
  const adapter = loaded.createBenchmarkAgent === undefined
    ? loaded.default
    : await loaded.createBenchmarkAgent();
  if (!adapter || typeof adapter.runEpisode !== 'function') {
    throw new TypeError('agent module must export a BenchmarkAgentAdapter');
  }
  return adapter;
}

const TEMPLATE: BenchmarkManifest = {
  schema: 'gaos.benchmark-manifest',
  schemaVersion: '1.0',
  benchmark: { id: 'example', version: '1.0.0', adapter: './adapter.mjs' },
  tasks: [{ id: 'task-a', seeds: [101], episodes: 1, maxSteps: 100 }],
  scoring: { plugin: './score.mjs', aggregation: 'mean' },
  submission: { requireSignedSeats: false, requireCompleteCoverage: true },
};

async function writePackageDirectory(
  path: string,
  files: Readonly<Record<string, string>>,
): Promise<void> {
  await mkdir(path, { recursive: true });
  for (const [relative, contents] of Object.entries(files)) {
    const target = resolve(path, relative);
    const root = `${resolve(path)}/`;
    if (!target.startsWith(root)) {
      throw new TypeError(`package path escapes output directory: ${relative}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents, { flag: 'wx' });
  }
}

async function readPackageDirectory(path: string): Promise<BenchmarkBundle> {
  const manifest = JSON.parse(
    await readFile(resolve(path, 'manifest.json'), 'utf8'),
  ) as BenchmarkManifest;
  const submissionFile = JSON.parse(
    await readFile(resolve(path, 'submission.json'), 'utf8'),
  ) as BenchmarkBundle['submission'] & {
    schema: BenchmarkBundle['schema'];
    contentDigest: string;
    manifestDigest: string;
  };
  const scoreFile = JSON.parse(
    await readFile(resolve(path, 'scores.json'), 'utf8'),
  ) as {
    aggregate: BenchmarkBundle['scores'];
    episodes: Array<Omit<BenchmarkBundleEpisode, 'replay'> & {
      replayEncoding: 'json' | 'jsonl';
    }>;
  };
  const episodes: BenchmarkBundleEpisode[] = [];
  for (const metadata of scoreFile.episodes) {
    const replayText = await readFile(
      resolve(path, `episodes/${encodeURIComponent(metadata.id)}.gaos-replay.jsonl`),
      'utf8',
    );
    const replay: BenchmarkBundleEpisode['replay'] =
      metadata.replayEncoding === 'json'
        ? JSON.parse(replayText) as BenchmarkBundleEpisode['replay']
        : replayText;
    const { replayEncoding: _encoding, ...episode } = metadata;
    episodes.push({ ...episode, replay });
  }
  const {
    schema,
    contentDigest,
    manifestDigest,
    ...submission
  } = submissionFile;
  return {
    schema,
    contentDigest,
    manifest,
    manifestDigest,
    submission,
    episodes,
    scores: scoreFile.aggregate,
  };
}

/** Filesystem CLI for deterministic benchmark run/resume/pack/verify. */
export async function runBenchmarkCli(
  argv: readonly string[],
  io: BenchmarkCliIo = {},
): Promise<number> {
  const cwd = io.cwd ?? process.cwd();
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(text));
  if (argv[0] !== 'benchmark') {
    stderr(usage());
    return 2;
  }
  const command = argv[1];
  try {
    if (command === 'init') {
      const path = resolve(cwd, argv[2] ?? 'benchmark.json');
      await writeFile(path, `${JSON.stringify(TEMPLATE, null, 2)}\n`, { flag: 'wx' });
      stdout(`${path}\n`);
      return 0;
    }
    if (command === 'run') {
      if (!argv[2]) throw new TypeError('run requires a manifest path');
      const manifest = JSON.parse(
        await readFile(resolve(cwd, argv[2]), 'utf8'),
      ) as BenchmarkManifest;
      const adapter = await loadAgent(cwd, option(argv, 'agent'));
      const parallelism = Number(option(argv, 'parallelism') ?? '1');
      const run = await runBenchmark(manifest, adapter, { parallelism });
      const directory = resolve(cwd, option(argv, 'output') ?? `runs/${Date.now()}`);
      await mkdir(directory, { recursive: true });
      const value: RunFile = { schema: 'gaos.benchmark-run-file.v1', manifest, run };
      await writeFile(resolve(directory, 'run.json'), `${JSON.stringify(value, null, 2)}\n`);
      stdout(`${directory}\n`);
      return run.status === 'complete' ? 0 : 1;
    }
    if (command === 'resume') {
      if (!argv[2]) throw new TypeError('resume requires a run directory');
      const directory = resolve(cwd, argv[2]);
      const saved = JSON.parse(
        await readFile(resolve(directory, 'run.json'), 'utf8'),
      ) as RunFile;
      const adapter = await loadAgent(cwd, option(argv, 'agent'));
      const run = await runBenchmark(saved.manifest, adapter, {
        parallelism: Number(option(argv, 'parallelism') ?? '1'),
        resume: saved.run.checkpoint,
      });
      await writeFile(
        resolve(directory, 'run.json'),
        `${JSON.stringify({ ...saved, run }, null, 2)}\n`,
      );
      stdout(`${directory}\n`);
      return run.status === 'complete' ? 0 : 1;
    }
    if (command === 'pack') {
      if (!argv[2]) throw new TypeError('pack requires a run directory');
      const saved = JSON.parse(
        await readFile(resolve(cwd, argv[2], 'run.json'), 'utf8'),
      ) as RunFile;
      const packed = packBenchmarkRun(saved.manifest, saved.run, {
        submissionId: `submission-${packedId(saved.run)}`,
        agentId: saved.run.checkpoint.agent.id,
        agentKind: saved.run.checkpoint.agent.kind,
      });
      const output = resolve(cwd, option(argv, 'output') ?? 'submission.gaos-bench');
      await writePackageDirectory(output, packed.files);
      stdout(`${JSON.stringify({ path: output, digest: packed.digest })}\n`);
      return 0;
    }
    if (command === 'verify') {
      if (!argv[2]) throw new TypeError('verify requires a bundle path');
      const manifestPath = option(argv, 'manifest');
      const adapterPath = option(argv, 'adapter');
      if (!manifestPath || !adapterPath) {
        throw new TypeError('verify requires independent --manifest and --adapter paths');
      }
      const bundle = await readPackageDirectory(resolve(cwd, argv[2]));
      const manifest = JSON.parse(
        await readFile(resolve(cwd, manifestPath), 'utf8'),
      ) as BenchmarkManifest;
      const loaded = await import(
        pathToFileURL(resolve(cwd, adapterPath)).href
      ) as AgentModule;
      if (typeof loaded.verifyEpisode !== 'function') {
        throw new TypeError('adapter module must export verifyEpisode(episode)');
      }
      const result = await verifyBenchmarkBundle(
        bundle,
        manifest,
        loaded.verifyEpisode,
        {
          ...(loaded.externalTrustResolver === undefined
            ? {}
            : { externalTrustResolver: loaded.externalTrustResolver }),
        },
      );
      stdout(`${JSON.stringify(result)}\n`);
      return result.valid ? 0 : 1;
    }
    stderr(usage());
    return 2;
  } catch (error) {
    stderr(`gaos benchmark: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}

function packedId(run: BenchmarkRun): string {
  return run.checkpoint.manifestDigest.slice(0, 12);
}
