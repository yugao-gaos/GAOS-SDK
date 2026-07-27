import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  parseReplayJsonl,
  recheckReplayArtifact,
  type ReplayArtifactRecheckOptions,
  type ReplayReducerResolver,
  type SessionView,
} from './engine/index.js';

export interface VerifyCliIo {
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

interface AdapterModule {
  resolveReplayReducer?: ReplayReducerResolver<unknown, unknown, SessionView>;
  default?: ReplayReducerResolver<unknown, unknown, SessionView>;
  semanticAdapterForLevel?: ReplayArtifactRecheckOptions<
    unknown,
    unknown
  >['semanticAdapterForLevel'];
}

function usage(): string {
  return 'usage: gaos verify <artifact.jsonl> --adapter <adapter.mjs> [--json]\n';
}

/**
 * Offline verification CLI. The adapter module exports
 * `resolveReplayReducer(context)` (or the same function as its default).
 * Signed evidence additionally exports `semanticAdapterForLevel(context)`.
 */
export async function runVerifyCli(
  argv: readonly string[],
  io: VerifyCliIo = {},
): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(text));
  const cwd = io.cwd ?? process.cwd();
  if (argv[0] !== 'verify') {
    stderr(usage());
    return 2;
  }
  const artifactPath = argv[1];
  let adapterPath: string | undefined;
  let json = false;
  for (let index = 2; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--adapter') {
      adapterPath = argv[++index];
      if (!adapterPath) {
        stderr('--adapter requires a module path\n');
        return 2;
      }
    } else if (argument === '--json') {
      json = true;
    } else {
      stderr(`unknown option ${String(argument)}\n${usage()}`);
      return 2;
    }
  }
  if (!artifactPath || !adapterPath) {
    stderr(usage());
    return 2;
  }
  try {
    const artifact = parseReplayJsonl(await readFile(resolve(cwd, artifactPath), 'utf8'));
    const imported = await import(
      pathToFileURL(resolve(cwd, adapterPath)).href
    ) as AdapterModule;
    const resolver = imported.resolveReplayReducer ?? imported.default;
    if (typeof resolver !== 'function') {
      throw new TypeError(
        'adapter must export resolveReplayReducer(context) or a default resolver',
      );
    }
    const result = recheckReplayArtifact(artifact, resolver, {
      ...(imported.semanticAdapterForLevel === undefined
        ? {}
        : { semanticAdapterForLevel: imported.semanticAdapterForLevel }),
    });
    const report = {
      verdict: result.verdict,
      replayOk: result.ok,
      format: artifact.header.format,
      formatVersion: artifact.header.formatVersion,
      dmath: artifact.header.extensions?.['dmath'] ?? null,
      signatures: result.signatures,
      semantics: result.semantics,
      levels: result.levels.map(({ index, id, result: level }) => ({
        index,
        id,
        ok: level.ok,
        problems: level.problems,
      })),
      problems: result.problems,
      diagnostics: result.diagnostics,
      replayed: result.replayed,
    };
    if (json) {
      stdout(`${JSON.stringify(report)}\n`);
    } else {
      stdout(
        `${report.verdict} · ${report.format} ${report.formatVersion}`
        + ` · replay ${report.replayOk ? 'consistent' : 'inconsistent'}`
        + ` · signatures ${report.signatures.state}\n`,
      );
      for (const seat of report.signatures.seats) {
        stdout(
          `seat ${seat.seat}: ${seat.validSignatures} valid signatures, `
          + `chain ${seat.chainReproduced ? 'reproduced' : 'failed'}, `
          + `policy ${seat.policySatisfied ? 'satisfied' : 'failed'}\n`,
        );
      }
      for (const problem of [
        ...report.problems,
        ...report.signatures.problems,
        ...report.semantics.problems,
      ]) {
        stdout(`problem: ${problem}\n`);
      }
      for (const diagnostic of report.diagnostics) {
        stdout(`diagnostic: ${diagnostic}\n`);
      }
    }
    return result.verdict === 'rejected' ? 1 : 0;
  } catch (error) {
    stderr(`gaos verify: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
