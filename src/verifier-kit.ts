import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  link,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, posix, resolve, sep } from 'node:path';
import { canonicalJson, type JsonObject } from './protocol.js';

export const VERIFIER_KIT_SCHEMA = 'gaos.verifier-kit.v1' as const;
export const VERIFIER_REFERENCE_SCHEMA = 'gaos.verifier-reference.v1' as const;
export const VERIFIER_KIT_MEDIA_TYPE =
  'application/vnd.gaos.verifier-kit.v1+tar' as const;
export const VERIFIER_KIT_EXTENSION = 'gaos-verifier' as const;

const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const BLOCK_SIZE = 512;
const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_FILES = 512;

export interface VerifierKitManifestV1 {
  schema: typeof VERIFIER_KIT_SCHEMA;
  game: { id: string; version: string };
  adapter: {
    id: string;
    version: string;
    entrypoint: 'adapter.bundle.mjs';
  };
  runtime: {
    kind: 'node-esm';
    gaosVersion: string;
    nodeRange: string;
  };
  replayFormats: string[];
  files: Array<{
    path: string;
    size: number;
    digest: `sha256:${string}`;
  }>;
}

export interface VerifierReferenceV1 {
  schema: typeof VERIFIER_REFERENCE_SCHEMA;
  digest: `sha256:${string}`;
  mediaType: typeof VERIFIER_KIT_MEDIA_TYPE;
  size: number;
  mirrors: string[];
}

export interface VerifierKitResolution {
  reference: 'absent' | 'present';
  retrieval: 'not_attempted' | 'cached' | 'fetched' | 'unavailable';
  integrity: 'unchecked' | 'matched' | 'mismatched';
  authorization: 'unknown' | 'accepted' | 'rejected';
  execution: 'not_run' | 'passed' | 'failed' | 'restricted';
  digest?: string;
  source?: string;
  diagnostics: string[];
}

export interface PackedVerifierKit {
  bytes: Uint8Array;
  digest: `sha256:${string}`;
  manifest: VerifierKitManifestV1;
}

export interface InspectedVerifierKit extends PackedVerifierKit {
  files: ReadonlyMap<string, Uint8Array>;
}

export interface VerifierKitLimits {
  maxBytes?: number;
  maxFiles?: number;
}

export interface PackVerifierKitInput {
  game: VerifierKitManifestV1['game'];
  adapter: Omit<VerifierKitManifestV1['adapter'], 'entrypoint'>;
  runtime: VerifierKitManifestV1['runtime'];
  replayFormats: string[];
  /** Complete, already bundled kit files. Must include adapter.bundle.mjs. */
  files: Readonly<Record<string, Uint8Array | string>>;
}

export interface ResolveVerifierKitOptions {
  reference?: VerifierReferenceV1;
  authorizedDigests?: ReadonlySet<string> | readonly string[];
  cacheDirectory: string;
  fetch?: (mirror: string) => Promise<Uint8Array>;
  limits?: VerifierKitLimits;
}

export interface RestrictedVerifierRequest {
  schema: 'gaos.verifier-request.v1';
  kitDigest: string;
  kitDirectory: string;
  replayPath: string;
}

export interface RestrictedVerifierResponse {
  schema: 'gaos.verifier-response.v1';
  verdict: 'trusted' | 'unverifiable' | 'rejected';
  diagnostics: string[];
}

/**
 * Security boundary supplied by the verifier operator (for example a pinned
 * container runner). GAOS never imports fetched adapter code in-process.
 */
export interface RestrictedVerifierRunner {
  run(
    request: RestrictedVerifierRequest,
    limits: {
      cpuMilliseconds: number;
      wallMilliseconds: number;
      memoryBytes: number;
      processes: number;
      outputBytes: number;
    },
  ): Promise<RestrictedVerifierResponse>;
}

interface TarEntry {
  path: string;
  bytes: Uint8Array;
}

function comparePaths(left: { path: string }, right: { path: string }): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function sha256(bytes: Uint8Array): `sha256:${string}` {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function assertNonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is `sha256:${string}` {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest`);
  }
}

function normalizeKitPath(value: string): string {
  if (
    value.length === 0
    || value.includes('\\')
    || value.startsWith('/')
    || value.includes('\0')
    || posix.normalize(value) !== value
    || value.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new TypeError(`unsafe verifier-kit path ${JSON.stringify(value)}`);
  }
  if (Buffer.byteLength(value) > 100) {
    throw new TypeError(`verifier-kit path exceeds the v1 100-byte limit: ${value}`);
  }
  return value;
}

function asBytes(value: Uint8Array | string): Uint8Array {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : Uint8Array.from(value);
}

function writeAscii(target: Uint8Array, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, 'ascii');
  if (bytes.length > length) throw new TypeError(`tar field exceeds ${length} bytes`);
  target.set(bytes, offset);
}

function writeOctal(
  target: Uint8Array,
  offset: number,
  length: number,
  value: number,
): void {
  const encoded = value.toString(8).padStart(length - 1, '0');
  if (encoded.length >= length) throw new TypeError('tar numeric field overflow');
  writeAscii(target, offset, length, `${encoded}\0`);
}

function tarHeader(entry: TarEntry): Uint8Array {
  const header = new Uint8Array(BLOCK_SIZE);
  writeAscii(header, 0, 100, entry.path);
  writeOctal(header, 100, 8, 0o444);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, entry.bytes.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  writeAscii(header, 257, 6, 'ustar\0');
  writeAscii(header, 263, 2, '00');
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeAscii(header, 148, 8, `${checksum.toString(8).padStart(6, '0')}\0 `);
  return header;
}

function encodeTar(entries: readonly TarEntry[]): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = BLOCK_SIZE * 2;
  for (const entry of entries) {
    const header = tarHeader(entry);
    const padding = (BLOCK_SIZE - (entry.bytes.length % BLOCK_SIZE)) % BLOCK_SIZE;
    chunks.push(header, entry.bytes, new Uint8Array(padding));
    total += header.length + entry.bytes.length + padding;
  }
  chunks.push(new Uint8Array(BLOCK_SIZE * 2));
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

function readString(bytes: Uint8Array, offset: number, length: number): string {
  const end = bytes.indexOf(0, offset);
  return Buffer.from(bytes.subarray(offset, end < 0 || end >= offset + length
    ? offset + length
    : end)).toString('utf8');
}

function readOctal(bytes: Uint8Array, offset: number, length: number, label: string): number {
  const value = readString(bytes, offset, length).trim();
  if (!/^[0-7]+$/.test(value)) throw new TypeError(`malformed tar ${label}`);
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed)) throw new TypeError(`tar ${label} exceeds safe range`);
  return parsed;
}

function isZeroBlock(bytes: Uint8Array, offset: number): boolean {
  for (let index = offset; index < offset + BLOCK_SIZE; index++) {
    if (bytes[index] !== 0) return false;
  }
  return true;
}

function decodeTar(bytes: Uint8Array, limits: VerifierKitLimits = {}): TarEntry[] {
  const maxBytes = limits.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = limits.maxFiles ?? DEFAULT_MAX_FILES;
  if (bytes.length > maxBytes) throw new TypeError('verifier kit exceeds size limit');
  if (bytes.length < BLOCK_SIZE * 2 || bytes.length % BLOCK_SIZE !== 0) {
    throw new TypeError('malformed verifier-kit tar length');
  }
  const entries: TarEntry[] = [];
  const paths = new Set<string>();
  let offset = 0;
  while (!isZeroBlock(bytes, offset)) {
    if (entries.length >= maxFiles) throw new TypeError('verifier kit exceeds file limit');
    const header = bytes.subarray(offset, offset + BLOCK_SIZE);
    if (readString(header, 257, 6) !== 'ustar') {
      throw new TypeError('verifier kit must use canonical ustar headers');
    }
    const storedChecksum = readOctal(header, 148, 8, 'checksum');
    const checksumHeader = Uint8Array.from(header);
    checksumHeader.fill(0x20, 148, 156);
    if (checksumHeader.reduce((sum, byte) => sum + byte, 0) !== storedChecksum) {
      throw new TypeError('verifier-kit tar checksum mismatch');
    }
    if (header[156] !== 0x30 && header[156] !== 0) {
      throw new TypeError('verifier kit may contain regular files only');
    }
    const path = normalizeKitPath(readString(header, 0, 100));
    if (paths.has(path)) throw new TypeError(`duplicate verifier-kit path ${path}`);
    paths.add(path);
    const size = readOctal(header, 124, 12, 'size');
    const contentOffset = offset + BLOCK_SIZE;
    const nextOffset = contentOffset + Math.ceil(size / BLOCK_SIZE) * BLOCK_SIZE;
    if (nextOffset > bytes.length - BLOCK_SIZE * 2) {
      throw new TypeError(`truncated verifier-kit entry ${path}`);
    }
    entries.push({ path, bytes: Uint8Array.from(bytes.subarray(contentOffset, contentOffset + size)) });
    offset = nextOffset;
  }
  if (
    offset + BLOCK_SIZE * 2 !== bytes.length
    || !isZeroBlock(bytes, offset + BLOCK_SIZE)
  ) {
    throw new TypeError('verifier kit must end with exactly two zero blocks');
  }
  const ordered = [...entries].sort(comparePaths);
  if (entries.some((entry, index) => entry.path !== ordered[index]?.path)) {
    throw new TypeError('verifier-kit entries must be lexically ordered');
  }
  if (!Buffer.from(encodeTar(entries)).equals(Buffer.from(bytes))) {
    throw new TypeError('verifier kit is not canonically packed');
  }
  return entries;
}

export function assertVerifierKitManifest(
  value: unknown,
): asserts value is VerifierKitManifestV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('verifier manifest must be an object');
  }
  const manifest = value as Record<string, unknown>;
  if (manifest['schema'] !== VERIFIER_KIT_SCHEMA) {
    throw new TypeError(`verifier manifest schema must be ${VERIFIER_KIT_SCHEMA}`);
  }
  for (const key of Object.keys(manifest)) {
    if (!['schema', 'game', 'adapter', 'runtime', 'replayFormats', 'files'].includes(key)) {
      throw new TypeError(`unknown verifier manifest property ${key}`);
    }
  }
  const game = manifest['game'] as Record<string, unknown> | undefined;
  const adapter = manifest['adapter'] as Record<string, unknown> | undefined;
  const runtime = manifest['runtime'] as Record<string, unknown> | undefined;
  if (!game || Array.isArray(game)) throw new TypeError('manifest.game must be an object');
  if (!adapter || Array.isArray(adapter)) throw new TypeError('manifest.adapter must be an object');
  if (!runtime || Array.isArray(runtime)) throw new TypeError('manifest.runtime must be an object');
  if (Object.keys(game).sort().join(',') !== 'id,version') {
    throw new TypeError('manifest.game has unknown or missing properties');
  }
  if (Object.keys(adapter).sort().join(',') !== 'entrypoint,id,version') {
    throw new TypeError('manifest.adapter has unknown or missing properties');
  }
  if (Object.keys(runtime).sort().join(',') !== 'gaosVersion,kind,nodeRange') {
    throw new TypeError('manifest.runtime has unknown or missing properties');
  }
  assertNonEmpty(game['id'], 'manifest.game.id');
  assertNonEmpty(game['version'], 'manifest.game.version');
  assertNonEmpty(adapter['id'], 'manifest.adapter.id');
  assertNonEmpty(adapter['version'], 'manifest.adapter.version');
  if (adapter['entrypoint'] !== 'adapter.bundle.mjs') {
    throw new TypeError('manifest.adapter.entrypoint must be adapter.bundle.mjs');
  }
  if (runtime['kind'] !== 'node-esm') {
    throw new TypeError('manifest.runtime.kind must be node-esm');
  }
  assertNonEmpty(runtime['gaosVersion'], 'manifest.runtime.gaosVersion');
  assertNonEmpty(runtime['nodeRange'], 'manifest.runtime.nodeRange');
  if (
    !Array.isArray(manifest['replayFormats'])
    || manifest['replayFormats'].length === 0
    || !manifest['replayFormats'].every((item) => typeof item === 'string' && item.length > 0)
  ) {
    throw new TypeError('manifest.replayFormats must be a non-empty string array');
  }
  if (new Set(manifest['replayFormats']).size !== manifest['replayFormats'].length) {
    throw new TypeError('manifest.replayFormats must not contain duplicates');
  }
  if (!Array.isArray(manifest['files']) || manifest['files'].length === 0) {
    throw new TypeError('manifest.files must be a non-empty array');
  }
  let previous = '';
  const filePaths = new Set<string>();
  for (const [index, raw] of manifest['files'].entries()) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new TypeError(`manifest.files[${index}] must be an object`);
    }
    const file = raw as Record<string, unknown>;
    if (Object.keys(file).sort().join(',') !== 'digest,path,size') {
      throw new TypeError(`manifest.files[${index}] has unknown or missing properties`);
    }
    const path = normalizeKitPath(String(file['path']));
    if (path === 'verifier-manifest.json') {
      throw new TypeError('manifest.files must not include the self-referential manifest');
    }
    if (path <= previous || filePaths.has(path)) {
      throw new TypeError('manifest.files paths must be unique and lexically ordered');
    }
    previous = path;
    filePaths.add(path);
    if (!Number.isSafeInteger(file['size']) || (file['size'] as number) < 0) {
      throw new TypeError(`manifest.files[${index}].size must be a non-negative integer`);
    }
    assertDigest(file['digest'], `manifest.files[${index}].digest`);
  }
  if (!filePaths.has('adapter.bundle.mjs')) {
    throw new TypeError('manifest.files must include adapter.bundle.mjs');
  }
}

export function assertVerifierReference(
  value: unknown,
): asserts value is VerifierReferenceV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('verifier reference must be an object');
  }
  const reference = value as Record<string, unknown>;
  if (Object.keys(reference).sort().join(',') !== 'digest,mediaType,mirrors,schema,size') {
    throw new TypeError('verifier reference has unknown or missing properties');
  }
  if (reference['schema'] !== VERIFIER_REFERENCE_SCHEMA) {
    throw new TypeError(`verifier reference schema must be ${VERIFIER_REFERENCE_SCHEMA}`);
  }
  assertDigest(reference['digest'], 'verifier reference digest');
  if (reference['mediaType'] !== VERIFIER_KIT_MEDIA_TYPE) {
    throw new TypeError(`verifier reference mediaType must be ${VERIFIER_KIT_MEDIA_TYPE}`);
  }
  if (!Number.isSafeInteger(reference['size']) || (reference['size'] as number) < 0) {
    throw new TypeError('verifier reference size must be a non-negative integer');
  }
  if (
    !Array.isArray(reference['mirrors'])
    || !reference['mirrors'].every((mirror) => typeof mirror === 'string' && mirror.length > 0)
  ) {
    throw new TypeError('verifier reference mirrors must be a string array');
  }
}

export function verifierReferenceFromExtensions(
  extensions: JsonObject | undefined,
): VerifierReferenceV1 | undefined {
  const candidate = extensions?.['gaos.verifier'];
  if (candidate === undefined) return undefined;
  assertVerifierReference(candidate);
  return structuredClone(candidate);
}

export function packVerifierKit(input: PackVerifierKitInput): PackedVerifierKit {
  const paths = Object.keys(input.files).map(normalizeKitPath).sort();
  if (!paths.includes('adapter.bundle.mjs')) {
    throw new TypeError('verifier kit must include adapter.bundle.mjs');
  }
  if (paths.includes('verifier-manifest.json')) {
    throw new TypeError('verifier-manifest.json is generated by the packer');
  }
  const fileEntries = paths.map((path) => ({ path, bytes: asBytes(input.files[path]!) }));
  const manifest: VerifierKitManifestV1 = {
    schema: VERIFIER_KIT_SCHEMA,
    game: { ...input.game },
    adapter: { ...input.adapter, entrypoint: 'adapter.bundle.mjs' },
    runtime: { ...input.runtime },
    replayFormats: [...input.replayFormats],
    files: fileEntries.map(({ path, bytes }) => ({
      path,
      size: bytes.length,
      digest: sha256(bytes),
    })),
  };
  assertVerifierKitManifest(manifest);
  const entries = [
    ...fileEntries,
    {
      path: 'verifier-manifest.json',
      bytes: Buffer.from(`${canonicalJson(manifest as unknown as JsonObject)}\n`, 'utf8'),
    },
  ].sort(comparePaths);
  const bytes = encodeTar(entries);
  return { bytes, digest: sha256(bytes), manifest };
}

export function inspectVerifierKit(
  input: Uint8Array,
  limits: VerifierKitLimits = {},
): InspectedVerifierKit {
  const bytes = Uint8Array.from(input);
  const entries = decodeTar(bytes, limits);
  const manifestEntry = entries.find((entry) => entry.path === 'verifier-manifest.json');
  if (!manifestEntry) throw new TypeError('verifier kit is missing verifier-manifest.json');
  let manifest: unknown;
  try {
    manifest = JSON.parse(Buffer.from(manifestEntry.bytes).toString('utf8'));
  } catch {
    throw new TypeError('verifier manifest must be valid JSON');
  }
  assertVerifierKitManifest(manifest);
  const files = new Map(
    entries
      .filter((entry) => entry.path !== 'verifier-manifest.json')
      .map((entry) => [entry.path, Uint8Array.from(entry.bytes)]),
  );
  if (files.size !== manifest.files.length) {
    throw new TypeError('verifier manifest does not describe every kit file');
  }
  for (const expected of manifest.files) {
    const actual = files.get(expected.path);
    if (!actual) throw new TypeError(`verifier kit is missing ${expected.path}`);
    if (actual.length !== expected.size) {
      throw new TypeError(`verifier-kit size mismatch for ${expected.path}`);
    }
    if (sha256(actual) !== expected.digest) {
      throw new TypeError(`verifier-kit digest mismatch for ${expected.path}`);
    }
  }
  return { bytes, digest: sha256(bytes), manifest, files };
}

function cachePath(cacheDirectory: string, digest: string): string {
  assertDigest(digest, 'verifier-kit cache digest');
  return join(resolve(cacheDirectory), `${digest.slice('sha256:'.length)}.${VERIFIER_KIT_EXTENSION}`);
}

export async function admitVerifierKit(
  cacheDirectory: string,
  bytes: Uint8Array,
  expectedDigest: string,
  limits: VerifierKitLimits = {},
): Promise<string> {
  assertDigest(expectedDigest, 'expected verifier-kit digest');
  const inspected = inspectVerifierKit(bytes, limits);
  if (inspected.digest !== expectedDigest) {
    throw new TypeError('retrieved verifier-kit digest does not match the expected digest');
  }
  await mkdir(resolve(cacheDirectory), { recursive: true });
  const target = cachePath(cacheDirectory, expectedDigest);
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const existing = await readCachedVerifierKit(cacheDirectory, expectedDigest, limits);
      if (!existing) throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}

export async function readCachedVerifierKit(
  cacheDirectory: string,
  digest: string,
  limits: VerifierKitLimits = {},
): Promise<InspectedVerifierKit | undefined> {
  let bytes: Uint8Array;
  try {
    bytes = await readFile(cachePath(cacheDirectory, digest));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  const inspected = inspectVerifierKit(bytes, limits);
  if (inspected.digest !== digest) {
    throw new TypeError('cached verifier-kit digest does not match its cache key');
  }
  return inspected;
}

export async function resolveVerifierKit(
  options: ResolveVerifierKitOptions,
): Promise<{ resolution: VerifierKitResolution; kit?: InspectedVerifierKit }> {
  const reference = options.reference;
  if (!reference) {
    return {
      resolution: {
        reference: 'absent',
        retrieval: 'not_attempted',
        integrity: 'unchecked',
        authorization: 'unknown',
        execution: 'not_run',
        diagnostics: ['replay does not declare a verifier-kit reference'],
      },
    };
  }
  assertVerifierReference(reference);
  const authorized = new Set(options.authorizedDigests ?? []);
  const authorization = options.authorizedDigests === undefined
    ? 'unknown'
    : authorized.has(reference.digest) ? 'accepted' : 'rejected';
  const base: VerifierKitResolution = {
    reference: 'present',
    retrieval: 'not_attempted',
    integrity: 'unchecked',
    authorization,
    execution: 'not_run',
    digest: reference.digest,
    diagnostics: authorization === 'accepted'
      ? []
      : ['verifier-kit digest is not independently authorized'],
  };
  try {
    const cached = await readCachedVerifierKit(
      options.cacheDirectory,
      reference.digest,
      options.limits,
    );
    if (cached) {
      return {
        resolution: { ...base, retrieval: 'cached', integrity: 'matched' },
        kit: cached,
      };
    }
  } catch (error) {
    return {
      resolution: {
        ...base,
        retrieval: 'cached',
        integrity: 'mismatched',
        diagnostics: [...base.diagnostics, error instanceof Error ? error.message : String(error)],
      },
    };
  }
  if (!options.fetch) {
    return {
      resolution: {
        ...base,
        retrieval: 'unavailable',
        diagnostics: [...base.diagnostics, 'verifier-kit resolution was not enabled'],
      },
    };
  }
  const diagnostics = [...base.diagnostics];
  let sawMismatch = false;
  for (const mirror of reference.mirrors) {
    try {
      const bytes = await options.fetch(mirror);
      if (bytes.length !== reference.size || sha256(bytes) !== reference.digest) {
        sawMismatch = true;
        diagnostics.push(`mirror ${mirror} returned bytes with the wrong size or digest`);
        continue;
      }
      await admitVerifierKit(
        options.cacheDirectory,
        bytes,
        reference.digest,
        options.limits,
      );
      return {
        resolution: {
          ...base,
          retrieval: 'fetched',
          integrity: 'matched',
          source: mirror,
          diagnostics,
        },
        kit: inspectVerifierKit(bytes, options.limits),
      };
    } catch (error) {
      diagnostics.push(
        `mirror ${mirror} failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return {
    resolution: {
      ...base,
      retrieval: 'unavailable',
      integrity: sawMismatch ? 'mismatched' : 'unchecked',
      diagnostics,
    },
  };
}

export async function extractVerifierKit(
  kit: InspectedVerifierKit,
  destination: string,
): Promise<void> {
  const root = resolve(destination);
  await mkdir(root, { recursive: true });
  for (const [path, bytes] of kit.files) {
    const target = resolve(root, ...path.split('/'));
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      throw new TypeError(`verifier-kit path escapes destination: ${path}`);
    }
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx', mode: 0o444 });
  }
  await writeFile(
    join(root, 'verifier-manifest.json'),
    `${canonicalJson(kit.manifest as unknown as JsonObject)}\n`,
    { flag: 'wx', mode: 0o444 },
  );
}

export async function runRestrictedVerifier(
  runner: RestrictedVerifierRunner | undefined,
  request: RestrictedVerifierRequest,
  limits: Partial<Parameters<RestrictedVerifierRunner['run']>[1]> = {},
): Promise<{ resolution: Pick<VerifierKitResolution, 'execution' | 'diagnostics'>; response?: RestrictedVerifierResponse }> {
  if (!runner) {
    return {
      resolution: {
        execution: 'restricted',
        diagnostics: ['no approved restricted verifier runner is available'],
      },
    };
  }
  const response = await runner.run(request, {
    cpuMilliseconds: limits.cpuMilliseconds ?? 10_000,
    wallMilliseconds: limits.wallMilliseconds ?? 15_000,
    memoryBytes: limits.memoryBytes ?? 256 * 1024 * 1024,
    processes: limits.processes ?? 1,
    outputBytes: limits.outputBytes ?? 1024 * 1024,
  });
  if (
    response.schema !== 'gaos.verifier-response.v1'
    || !['trusted', 'unverifiable', 'rejected'].includes(response.verdict)
    || !Array.isArray(response.diagnostics)
    || !response.diagnostics.every((item) => typeof item === 'string')
  ) {
    throw new TypeError('restricted verifier returned an invalid response');
  }
  return {
    resolution: {
      execution: response.verdict === 'rejected' ? 'failed' : 'passed',
      diagnostics: [...response.diagnostics],
    },
    response,
  };
}
