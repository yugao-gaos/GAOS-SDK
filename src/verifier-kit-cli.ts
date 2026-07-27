import { readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import {
  admitVerifierKit,
  inspectVerifierKit,
  packVerifierKit,
  VERIFIER_KIT_EXTENSION,
} from './verifier-kit.js';

export interface VerifierKitCliIo {
  cwd?: string;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  fetch?: typeof globalThis.fetch;
}

function usage(): string {
  return [
    'usage:',
    '  gaos verifier pack <adapter.bundle.mjs> --game <id@version> --adapter <id@version> [--output <kit.gaos-verifier>]',
    '  gaos verifier inspect <kit.gaos-verifier> [--json]',
    '  gaos verifier fetch <https-url> --digest <sha256:...> --cache <directory>',
    '',
  ].join('\n');
}

function identity(value: string | undefined, label: string): { id: string; version: string } {
  const separator = value?.lastIndexOf('@') ?? -1;
  if (!value || separator <= 0 || separator === value.length - 1) {
    throw new TypeError(`${label} must use <id>@<version>`);
  }
  return { id: value.slice(0, separator), version: value.slice(separator + 1) };
}

function assertBundledEntrypoint(source: Uint8Array): void {
  const text = Buffer.from(source).toString('utf8');
  if (
    /(?:^|\n)\s*import\s+(?!\()/.test(text)
    || /(?:^|\n)\s*export\s+[^;\n]*\sfrom\s*['"]/.test(text)
    || /\bimport\s*\(/.test(text)
    || /\brequire\s*\(/.test(text)
  ) {
    throw new TypeError(
      'adapter entry point must be self-contained; bundle imports before packing',
    );
  }
}

async function boundedResponseBytes(response: Response): Promise<Uint8Array> {
  const maximum = 64 * 1024 * 1024;
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new TypeError('verifier kit exceeds the 64 MiB fetch limit');
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maximum) {
      await reader.cancel();
      throw new TypeError('verifier kit exceeds the 64 MiB fetch limit');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

/** Explicit filesystem/network CLI for RFC-016 pack, inspect, and cache steps. */
export async function runVerifierKitCli(
  argv: readonly string[],
  io: VerifierKitCliIo = {},
): Promise<number> {
  const stdout = io.stdout ?? ((text: string) => process.stdout.write(text));
  const stderr = io.stderr ?? ((text: string) => process.stderr.write(text));
  const cwd = io.cwd ?? process.cwd();
  if (argv[0] !== 'verifier') {
    stderr(usage());
    return 2;
  }
  try {
    if (argv[1] === 'pack') {
      const entrypoint = argv[2];
      let gameValue: string | undefined;
      let adapterValue: string | undefined;
      let output: string | undefined;
      for (let index = 3; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--game') gameValue = argv[++index];
        else if (argument === '--adapter') adapterValue = argv[++index];
        else if (argument === '--output') output = argv[++index];
        else throw new TypeError(`unknown option ${String(argument)}`);
      }
      if (!entrypoint) throw new TypeError('pack requires an explicit adapter entry point');
      const game = identity(gameValue, '--game');
      const adapter = identity(adapterValue ?? gameValue, '--adapter');
      const adapterBytes = await readFile(resolve(cwd, entrypoint));
      assertBundledEntrypoint(adapterBytes);
      const packed = packVerifierKit({
        game,
        adapter,
        runtime: {
          kind: 'node-esm',
          gaosVersion: '0.25.0',
          nodeRange: '>=20.3',
        },
        replayFormats: ['gaos.replay@1.0', 'gaos.replay@1.1', 'gaos.replay@1.2', 'gaos.replay@1.3'],
        files: {
          'adapter.bundle.mjs': adapterBytes,
        },
      });
      const outputPath = resolve(
        cwd,
        output ?? `${basename(entrypoint, '.mjs')}.${VERIFIER_KIT_EXTENSION}`,
      );
      await writeFile(outputPath, packed.bytes, { flag: 'wx' });
      stdout(`${JSON.stringify({ output: outputPath, digest: packed.digest })}\n`);
      return 0;
    }
    if (argv[1] === 'inspect') {
      const path = argv[2];
      if (!path) throw new TypeError('inspect requires a verifier-kit path');
      const json = argv.includes('--json');
      const inspected = inspectVerifierKit(await readFile(resolve(cwd, path)));
      stdout(json
        ? `${JSON.stringify({ digest: inspected.digest, manifest: inspected.manifest })}\n`
        : `${inspected.digest} · ${inspected.manifest.game.id}@${inspected.manifest.game.version}`
          + ` · ${inspected.manifest.adapter.id}@${inspected.manifest.adapter.version}\n`);
      return 0;
    }
    if (argv[1] === 'fetch') {
      const source = argv[2];
      let digest: string | undefined;
      let cache: string | undefined;
      for (let index = 3; index < argv.length; index++) {
        const argument = argv[index];
        if (argument === '--digest') digest = argv[++index];
        else if (argument === '--cache') cache = argv[++index];
        else throw new TypeError(`unknown option ${String(argument)}`);
      }
      if (!source || !digest || !cache) {
        throw new TypeError('fetch requires a URL, --digest, and --cache');
      }
      if (!/^https:\/\//.test(source)) {
        throw new TypeError('the reference CLI fetcher accepts HTTPS only');
      }
      const response = await (io.fetch ?? globalThis.fetch)(source, {
        redirect: 'error',
      });
      if (!response.ok) throw new TypeError(`fetch failed with HTTP ${response.status}`);
      const path = await admitVerifierKit(
        resolve(cwd, cache),
        await boundedResponseBytes(response),
        digest,
      );
      stdout(`${JSON.stringify({ cache: path, digest })}\n`);
      return 0;
    }
    stderr(usage());
    return 2;
  } catch (error) {
    stderr(`gaos verifier: ${error instanceof Error ? error.message : String(error)}\n`);
    return 2;
  }
}
