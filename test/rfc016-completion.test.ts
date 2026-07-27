import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectVerifierKit,
  packVerifierKit,
  readCachedVerifierKit,
  resolveVerifierKit,
  runRestrictedVerifier,
  verifierReferenceFromExtensions,
  VERIFIER_KIT_MEDIA_TYPE,
  type VerifierReferenceV1,
} from '../src/verifier-kit.js';
import { runVerifierKitCli } from '../src/verifier-kit-cli.js';
import { containerVerifierInvocation } from '../src/container-verifier-runner.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(adapter = 'export default () => ({})') {
  return packVerifierKit({
    game: { id: 'creator/demo', version: '1.0.0' },
    adapter: { id: 'creator/demo', version: '1.0.0' },
    runtime: { kind: 'node-esm', gaosVersion: '0.25.0', nodeRange: '>=20.3' },
    replayFormats: ['gaos.replay@1.3'],
    files: {
      'README.md': 'Product-owned verifier fixture\n',
      'adapter.bundle.mjs': adapter,
      'fixtures/expected-verdict.json': '{"verdict":"unverifiable"}\n',
    },
  });
}

function referenceFor(
  digest: `sha256:${string}`,
  size: number,
): VerifierReferenceV1 {
  return {
    schema: 'gaos.verifier-reference.v1',
    digest,
    mediaType: VERIFIER_KIT_MEDIA_TYPE,
    size,
    mirrors: ['https://one.invalid/demo', 'https://two.invalid/demo'],
  };
}

describe('RFC-016 release gate', () => {
  it('packs canonical bytes reproducibly and changes identity with content', () => {
    const first = fixture();
    const second = fixture();
    const changed = fixture('export default () => ({ changed: true })');

    expect(first.bytes).toEqual(second.bytes);
    expect(first.digest).toBe(second.digest);
    expect(changed.digest).not.toBe(first.digest);
    expect(inspectVerifierKit(first.bytes)).toMatchObject({
      digest: first.digest,
      manifest: {
        schema: 'gaos.verifier-kit.v1',
        game: { id: 'creator/demo', version: '1.0.0' },
      },
    });
  });

  it('rejects corruption and unsafe archive metadata before extraction', () => {
    const packed = fixture();
    const corrupted = Uint8Array.from(packed.bytes);
    corrupted[600] = corrupted[600]! ^ 1;
    expect(() => inspectVerifierKit(corrupted)).toThrow();

    const traversal = Uint8Array.from(packed.bytes);
    const name = Buffer.from('../escape');
    traversal.fill(0, 0, 100);
    traversal.set(name, 0);
    traversal.fill(0x20, 148, 156);
    const checksum = traversal.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
    traversal.set(Buffer.from(`${checksum.toString(8).padStart(6, '0')}\0 `), 148);
    expect(() => inspectVerifierKit(traversal)).toThrow(/unsafe verifier-kit path/);

    const symlink = Uint8Array.from(packed.bytes);
    symlink[156] = '2'.charCodeAt(0);
    symlink.fill(0x20, 148, 156);
    const linkChecksum = symlink.subarray(0, 512).reduce((sum, byte) => sum + byte, 0);
    symlink.set(Buffer.from(`${linkChecksum.toString(8).padStart(6, '0')}\0 `), 148);
    expect(() => inspectVerifierKit(symlink)).toThrow(/regular files only/);
  });

  it('keeps integrity, independent authorization, availability, and cache separate', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gaos-verifier-cache-'));
    temporaryDirectories.push(directory);
    const packed = fixture();
    const reference = referenceFor(packed.digest, packed.bytes.length);

    let mirrorCalls = 0;
    const selfDeclared = await resolveVerifierKit({
      reference,
      cacheDirectory: directory,
      fetch: async () => {
        mirrorCalls += 1;
        return mirrorCalls === 1 ? new Uint8Array(packed.bytes.length) : packed.bytes;
      },
    });
    expect(selfDeclared.resolution).toMatchObject({
      retrieval: 'fetched',
      integrity: 'matched',
      authorization: 'unknown',
      execution: 'not_run',
    });
    expect(selfDeclared.resolution.source).toBe(reference.mirrors[1]);

    const offline = await resolveVerifierKit({
      reference,
      authorizedDigests: [packed.digest],
      cacheDirectory: directory,
    });
    expect(offline.resolution).toMatchObject({
      retrieval: 'cached',
      integrity: 'matched',
      authorization: 'accepted',
    });
    expect((await readCachedVerifierKit(directory, packed.digest))?.digest).toBe(
      packed.digest,
    );

    const unavailable = await resolveVerifierKit({
      reference: { ...reference, digest: `sha256:${'0'.repeat(64)}` },
      authorizedDigests: [],
      cacheDirectory: directory,
    });
    expect(unavailable.resolution).toMatchObject({
      retrieval: 'unavailable',
      authorization: 'rejected',
      execution: 'not_run',
    });
  });

  it('parses only the namespaced reference and never falls back to in-process execution', async () => {
    const packed = fixture();
    const reference = referenceFor(packed.digest, packed.bytes.length);
    expect(verifierReferenceFromExtensions({
      'gaos.verifier': JSON.parse(JSON.stringify(reference)),
    })).toEqual(reference);
    expect(verifierReferenceFromExtensions({})).toBeUndefined();

    const restricted = await runRestrictedVerifier(undefined, {
      schema: 'gaos.verifier-request.v1',
      kitDigest: packed.digest,
      kitDirectory: '/read-only/kit',
      replayPath: '/read-only/replay',
    });
    expect(restricted).toEqual({
      resolution: {
        execution: 'restricted',
        diagnostics: ['no approved restricted verifier runner is available'],
      },
    });
  });

  it('constructs a pinned, networkless, read-only, resource-bounded runner', () => {
    const invocation = containerVerifierInvocation({
      image: `registry.invalid/gaos-runner@sha256:${'a'.repeat(64)}`,
    }, {
      schema: 'gaos.verifier-request.v1',
      kitDigest: `sha256:${'b'.repeat(64)}`,
      kitDirectory: '/kits/demo',
      replayPath: '/replays/run.jsonl',
    }, {
      cpuMilliseconds: 1_000,
      wallMilliseconds: 5_000,
      memoryBytes: 64 * 1024 * 1024,
      processes: 1,
      outputBytes: 1024,
    });
    expect(invocation.args).toEqual(expect.arrayContaining([
      '--network=none',
      '--read-only',
      '--pids-limit',
      '1',
      '--memory',
      '64m',
    ]));
    expect(invocation.args.some((argument) => argument.includes('readonly'))).toBe(true);
    expect(invocation.request).not.toContain(process.env['HOME']);
    expect(() => containerVerifierInvocation({
      image: 'registry.invalid/gaos-runner:latest',
    }, {
      schema: 'gaos.verifier-request.v1',
      kitDigest: `sha256:${'b'.repeat(64)}`,
      kitDirectory: '/kits/demo',
      replayPath: '/replays/run.jsonl',
    }, {
      cpuMilliseconds: 1_000,
      wallMilliseconds: 5_000,
      memoryBytes: 64 * 1024 * 1024,
      processes: 1,
      outputBytes: 1024,
    })).toThrow(/pinned/);
  });

  it('provides explicit pack and read-only inspect CLI commands', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gaos-verifier-cli-'));
    temporaryDirectories.push(directory);
    writeFileSync(
      join(directory, 'adapter.bundle.mjs'),
      'export default () => ({})\n',
    );
    let output = '';
    expect(await runVerifierKitCli([
      'verifier',
      'pack',
      'adapter.bundle.mjs',
      '--game',
      'creator/demo@1.0.0',
      '--output',
      'demo.gaos-verifier',
    ], {
      cwd: directory,
      stdout: (text) => { output += text; },
      stderr: () => undefined,
    })).toBe(0);
    expect(JSON.parse(output).digest).toMatch(/^sha256:[0-9a-f]{64}$/);

    output = '';
    expect(await runVerifierKitCli([
      'verifier',
      'inspect',
      'demo.gaos-verifier',
      '--json',
    ], {
      cwd: directory,
      stdout: (text) => { output += text; },
      stderr: () => undefined,
    })).toBe(0);
    expect(JSON.parse(output).manifest.schema).toBe('gaos.verifier-kit.v1');
    expect(readFileSync(join(directory, 'demo.gaos-verifier')).length).toBeGreaterThan(0);
  });
});
