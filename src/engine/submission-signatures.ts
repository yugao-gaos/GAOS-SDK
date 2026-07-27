import {
  assertJsonValue,
  canonicalJson,
  type JsonValue,
} from '../protocol.js';
import { sha256 } from './commitment.js';

export const SUBMISSION_SIGNATURE_SCHEME = 'gaos.submission.ed25519.v1' as const;
export const SUBMISSION_SIGNATURE_ALGORITHM = 'Ed25519' as const;

export interface SubmissionSigningTier {
  /** Maximum tick gap between periodic chain-head signatures. */
  N: number;
}

export interface SubmissionSeatKey {
  id: string;
  publicKey: string;
  alg: typeof SUBMISSION_SIGNATURE_ALGORITHM;
  signingTier: SubmissionSigningTier;
}

export interface SubmissionSignaturePolicy {
  scheme: typeof SUBMISSION_SIGNATURE_SCHEME;
}

export interface SubmissionSigningEnvelope {
  sessionId: string;
  seat: string;
  submissionId: string;
  cursor: number;
  tick: number;
  clientTime: number;
  command: JsonValue;
  /** Canonical base64 SHA-256 chain link. */
  prevChainHash: string;
}

export interface PeriodicSigningEnvelope {
  sessionId: string;
  seat: string;
  tick: number;
  clientTime: number;
  /** Current canonical base64 SHA-256 chain head. */
  chainHead: string;
}

const encoder = new TextEncoder();
const DOMAIN_TAG = encoder.encode(SUBMISSION_SIGNATURE_SCHEME);
const PERIODIC_DOMAIN_TAG = encoder.encode(`${SUBMISSION_SIGNATURE_SCHEME}.periodic`);
const MAX_TEXT_BYTES = 65_536;

function assertValidUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new TypeError(`${label} must not contain unpaired surrogates`);
      }
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError(`${label} must not contain unpaired surrogates`);
    }
  }
}

function utf8(value: string, label: string, allowEmpty = false): Uint8Array {
  if (typeof value !== 'string') throw new TypeError(`${label} must be a string`);
  assertValidUnicode(value, label);
  const bytes = encoder.encode(value);
  if (!allowEmpty && bytes.length === 0) throw new RangeError(`${label} must be non-empty`);
  if (bytes.length > MAX_TEXT_BYTES) {
    throw new RangeError(`${label} exceeds ${MAX_TEXT_BYTES} UTF-8 bytes`);
  }
  return bytes;
}

function assertU64(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function writeU32(target: Uint8Array, offset: number, value: number): number {
  target[offset] = (value >>> 24) & 0xff;
  target[offset + 1] = (value >>> 16) & 0xff;
  target[offset + 2] = (value >>> 8) & 0xff;
  target[offset + 3] = value & 0xff;
  return offset + 4;
}

function writeU64(target: Uint8Array, offset: number, value: number): number {
  offset = writeU32(target, offset, Math.floor(value / 0x1_0000_0000));
  return writeU32(target, offset, value >>> 0);
}

function framedSize(bytes: Uint8Array): number {
  return 4 + bytes.length;
}

function writeFramed(target: Uint8Array, offset: number, bytes: Uint8Array): number {
  offset = writeU32(target, offset, bytes.length);
  target.set(bytes, offset);
  return offset + bytes.length;
}

function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/** Encode bytes as canonical padded RFC 4648 base64. */
export function signatureBytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** Decode canonical padded RFC 4648 base64 with an exact byte length. */
export function signatureBytesFromBase64(
  value: string,
  label: string,
  expectedLength: number,
): Uint8Array {
  if (typeof value !== 'string'
    || value.length !== Math.ceil(expectedLength / 3) * 4
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError(`${label} must be canonical padded base64`);
  }
  let decoded: string;
  try {
    decoded = atob(value);
  } catch {
    throw new TypeError(`${label} must be canonical padded base64`);
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.length !== expectedLength || signatureBytesToBase64(bytes) !== value) {
    throw new RangeError(`${label} must decode to exactly ${expectedLength} bytes`);
  }
  return bytes;
}

/** Canonical command bytes signed by the v1 submission scheme. */
export function canonicalSubmissionCommandV1(command: JsonValue): Uint8Array {
  assertJsonValue(command, 'command');
  const result = encoder.encode(canonicalJson(command));
  if (result.length > MAX_TEXT_BYTES) {
    throw new RangeError(`command exceeds ${MAX_TEXT_BYTES} canonical UTF-8 bytes`);
  }
  return result;
}

/** Build the byte-exact RFC-010 submission signature preimage. */
export function submissionPreimageV1(envelope: SubmissionSigningEnvelope): Uint8Array {
  assertU64(envelope.cursor, 'cursor');
  assertU64(envelope.tick, 'tick');
  assertU64(envelope.clientTime, 'clientTime');
  const session = utf8(envelope.sessionId, 'sessionId');
  const seat = utf8(envelope.seat, 'seat');
  const submissionId = utf8(envelope.submissionId, 'submissionId');
  const command = canonicalSubmissionCommandV1(envelope.command);
  const previous = signatureBytesFromBase64(
    envelope.prevChainHash,
    'prevChainHash',
    32,
  );
  const result = new Uint8Array(
    framedSize(DOMAIN_TAG)
    + framedSize(session)
    + framedSize(seat)
    + framedSize(submissionId)
    + 8
    + 8
    + 8
    + framedSize(command)
    + framedSize(previous),
  );
  let offset = 0;
  offset = writeFramed(result, offset, DOMAIN_TAG);
  offset = writeFramed(result, offset, session);
  offset = writeFramed(result, offset, seat);
  offset = writeFramed(result, offset, submissionId);
  offset = writeU64(result, offset, envelope.cursor);
  offset = writeU64(result, offset, envelope.tick);
  offset = writeU64(result, offset, envelope.clientTime);
  offset = writeFramed(result, offset, command);
  writeFramed(result, offset, previous);
  return result;
}

/** Hash one canonical submission preimage into the next per-seat chain head. */
export function submissionChainHashV1(envelope: SubmissionSigningEnvelope): string {
  return signatureBytesToBase64(sha256(submissionPreimageV1(envelope)));
}

/** Order-independent hash of the complete RFC-010 seat roster. */
export function submissionRosterHashV1(seatKeys: readonly SubmissionSeatKey[]): string {
  if (!Array.isArray(seatKeys) || seatKeys.length === 0) {
    throw new TypeError('seatKeys must be a non-empty array');
  }
  const ids = new Set<string>();
  const normalized: SubmissionSeatKey[] = seatKeys.map((entry, index) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new TypeError(`seatKeys[${index}] must be an object`);
    }
    const keys = Object.keys(entry);
    if (keys.length !== 4
      || !['id', 'publicKey', 'alg', 'signingTier'].every((key) => keys.includes(key))) {
      throw new TypeError(`seatKeys[${index}] must be an exact roster object`);
    }
    utf8(entry.id, `seatKeys[${index}].id`);
    if (ids.has(entry.id)) throw new TypeError(`seatKeys contains duplicate id ${entry.id}`);
    ids.add(entry.id);
    signatureBytesFromBase64(entry.publicKey, `seatKeys[${index}].publicKey`, 32);
    if (entry.alg !== SUBMISSION_SIGNATURE_ALGORITHM) {
      throw new TypeError(`seatKeys[${index}].alg must be ${SUBMISSION_SIGNATURE_ALGORITHM}`);
    }
    if (!Number.isSafeInteger(entry.signingTier?.N) || entry.signingTier.N < 1) {
      throw new RangeError(`seatKeys[${index}].signingTier.N must be a positive safe integer`);
    }
    return {
      id: entry.id,
      publicKey: entry.publicKey,
      alg: entry.alg,
      signingTier: { N: entry.signingTier.N },
    };
  }).sort((left, right) => {
    const leftPoints = Array.from(left.id, (value: string) => value.codePointAt(0)!);
    const rightPoints = Array.from(right.id, (value: string) => value.codePointAt(0)!);
    for (let index = 0; index < Math.min(leftPoints.length, rightPoints.length); index++) {
      const difference = leftPoints[index]! - rightPoints[index]!;
      if (difference !== 0) return difference;
    }
    return leftPoints.length - rightPoints.length;
  });
  return signatureBytesToBase64(sha256(encoder.encode(canonicalJson(normalized))));
}

/** First expected chain link for a seat, binding every chain to the roster. */
export function submissionGenesisHashV1(
  sessionId: string,
  seat: string,
  rosterHash: string,
): string {
  const session = utf8(sessionId, 'sessionId');
  const seatBytes = utf8(seat, 'seat');
  const roster = signatureBytesFromBase64(rosterHash, 'rosterHash', 32);
  const result = new Uint8Array(
    framedSize(DOMAIN_TAG)
    + framedSize(session)
    + framedSize(seatBytes)
    + framedSize(roster),
  );
  let offset = 0;
  offset = writeFramed(result, offset, DOMAIN_TAG);
  offset = writeFramed(result, offset, session);
  offset = writeFramed(result, offset, seatBytes);
  writeFramed(result, offset, roster);
  return signatureBytesToBase64(sha256(result));
}

/**
 * Domain-separated preimage for a periodic signature over the current chain
 * head. Periodic records do not create another chain link.
 */
export function periodicSignaturePreimageV1(envelope: PeriodicSigningEnvelope): Uint8Array {
  assertU64(envelope.tick, 'tick');
  assertU64(envelope.clientTime, 'clientTime');
  const session = utf8(envelope.sessionId, 'sessionId');
  const seat = utf8(envelope.seat, 'seat');
  const chainHead = signatureBytesFromBase64(envelope.chainHead, 'chainHead', 32);
  const result = new Uint8Array(
    framedSize(PERIODIC_DOMAIN_TAG)
    + framedSize(session)
    + framedSize(seat)
    + 8
    + 8
    + framedSize(chainHead),
  );
  let offset = 0;
  offset = writeFramed(result, offset, PERIODIC_DOMAIN_TAG);
  offset = writeFramed(result, offset, session);
  offset = writeFramed(result, offset, seat);
  offset = writeU64(result, offset, envelope.tick);
  offset = writeU64(result, offset, envelope.clientTime);
  writeFramed(result, offset, chainHead);
  return result;
}

// Synchronous SHA-512 and Ed25519 verification are deliberately pure
// ECMAScript so replay verification remains synchronous in browsers and
// isolates. BigInt keeps the implementation compact and exact.
const MASK_64 = (1n << 64n) - 1n;
const SHA512_K = [
  0x428a2f98d728ae22n, 0x7137449123ef65cdn, 0xb5c0fbcfec4d3b2fn, 0xe9b5dba58189dbbcn,
  0x3956c25bf348b538n, 0x59f111f1b605d019n, 0x923f82a4af194f9bn, 0xab1c5ed5da6d8118n,
  0xd807aa98a3030242n, 0x12835b0145706fben, 0x243185be4ee4b28cn, 0x550c7dc3d5ffb4e2n,
  0x72be5d74f27b896fn, 0x80deb1fe3b1696b1n, 0x9bdc06a725c71235n, 0xc19bf174cf692694n,
  0xe49b69c19ef14ad2n, 0xefbe4786384f25e3n, 0x0fc19dc68b8cd5b5n, 0x240ca1cc77ac9c65n,
  0x2de92c6f592b0275n, 0x4a7484aa6ea6e483n, 0x5cb0a9dcbd41fbd4n, 0x76f988da831153b5n,
  0x983e5152ee66dfabn, 0xa831c66d2db43210n, 0xb00327c898fb213fn, 0xbf597fc7beef0ee4n,
  0xc6e00bf33da88fc2n, 0xd5a79147930aa725n, 0x06ca6351e003826fn, 0x142929670a0e6e70n,
  0x27b70a8546d22ffcn, 0x2e1b21385c26c926n, 0x4d2c6dfc5ac42aedn, 0x53380d139d95b3dfn,
  0x650a73548baf63den, 0x766a0abb3c77b2a8n, 0x81c2c92e47edaee6n, 0x92722c851482353bn,
  0xa2bfe8a14cf10364n, 0xa81a664bbc423001n, 0xc24b8b70d0f89791n, 0xc76c51a30654be30n,
  0xd192e819d6ef5218n, 0xd69906245565a910n, 0xf40e35855771202an, 0x106aa07032bbd1b8n,
  0x19a4c116b8d2d0c8n, 0x1e376c085141ab53n, 0x2748774cdf8eeb99n, 0x34b0bcb5e19b48a8n,
  0x391c0cb3c5c95a63n, 0x4ed8aa4ae3418acbn, 0x5b9cca4f7763e373n, 0x682e6ff3d6b2b8a3n,
  0x748f82ee5defb2fcn, 0x78a5636f43172f60n, 0x84c87814a1f0ab72n, 0x8cc702081a6439ecn,
  0x90befffa23631e28n, 0xa4506cebde82bde9n, 0xbef9a3f7b2c67915n, 0xc67178f2e372532bn,
  0xca273eceea26619cn, 0xd186b8c721c0c207n, 0xeada7dd6cde0eb1en, 0xf57d4f7fee6ed178n,
  0x06f067aa72176fban, 0x0a637dc5a2c898a6n, 0x113f9804bef90daen, 0x1b710b35131c471bn,
  0x28db77f523047d84n, 0x32caab7b40c72493n, 0x3c9ebe0a15c9bebcn, 0x431d67c49c100d4cn,
  0x4cc5d4becb3e42b6n, 0x597f299cfc657e2an, 0x5fcb6fab3ad6faecn, 0x6c44198c4a475817n,
] as const;

function rotateRight64(value: bigint, amount: bigint): bigint {
  return ((value >> amount) | (value << (64n - amount))) & MASK_64;
}

function sha512(bytes: Uint8Array): Uint8Array {
  const paddedLength = Math.ceil((bytes.length + 17) / 128) * 128;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  let bitLength = BigInt(bytes.length) * 8n;
  for (let index = 0; index < 16; index++) {
    padded[paddedLength - 1 - index] = Number(bitLength & 0xffn);
    bitLength >>= 8n;
  }
  const hash = [
    0x6a09e667f3bcc908n, 0xbb67ae8584caa73bn, 0x3c6ef372fe94f82bn, 0xa54ff53a5f1d36f1n,
    0x510e527fade682d1n, 0x9b05688c2b3e6c1fn, 0x1f83d9abfb41bd6bn, 0x5be0cd19137e2179n,
  ];
  const words = new Array<bigint>(80).fill(0n);
  for (let block = 0; block < padded.length; block += 128) {
    for (let index = 0; index < 16; index++) {
      let word = 0n;
      for (let byte = 0; byte < 8; byte++) {
        word = (word << 8n) | BigInt(padded[block + index * 8 + byte]!);
      }
      words[index] = word;
    }
    for (let index = 16; index < 80; index++) {
      const left = words[index - 15]!;
      const right = words[index - 2]!;
      const s0 = rotateRight64(left, 1n) ^ rotateRight64(left, 8n) ^ (left >> 7n);
      const s1 = rotateRight64(right, 19n) ^ rotateRight64(right, 61n) ^ (right >> 6n);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) & MASK_64;
    }
    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 80; index++) {
      const sigma1 = rotateRight64(e!, 14n) ^ rotateRight64(e!, 18n) ^ rotateRight64(e!, 41n);
      const choose = (e! & f!) ^ ((~e! & MASK_64) & g!);
      const t1 = (h! + sigma1 + choose + SHA512_K[index]! + words[index]!) & MASK_64;
      const sigma0 = rotateRight64(a!, 28n) ^ rotateRight64(a!, 34n) ^ rotateRight64(a!, 39n);
      const majority = (a! & b!) ^ (a! & c!) ^ (b! & c!);
      const t2 = (sigma0 + majority) & MASK_64;
      h = g;
      g = f;
      f = e;
      e = (d! + t1) & MASK_64;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) & MASK_64;
    }
    for (let index = 0; index < 8; index++) {
      hash[index] = (hash[index]! + [a, b, c, d, e, f, g, h][index]!) & MASK_64;
    }
  }
  const result = new Uint8Array(64);
  for (let index = 0; index < 8; index++) {
    let value = hash[index]!;
    for (let byte = 7; byte >= 0; byte--) {
      result[index * 8 + byte] = Number(value & 0xffn);
      value >>= 8n;
    }
  }
  return result;
}

const P = (1n << 255n) - 19n;
const L = (1n << 252n) + 27742317777372353535851937790883648493n;

function mod(value: bigint): bigint {
  const result = value % P;
  return result < 0n ? result + P : result;
}

function power(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let factor = mod(base);
  let remaining = exponent;
  while (remaining > 0n) {
    if (remaining & 1n) result = mod(result * factor);
    factor = mod(factor * factor);
    remaining >>= 1n;
  }
  return result;
}

const D = mod(-121665n * power(121666n, P - 2n));
const SQRT_M1 = power(2n, (P - 1n) / 4n);
type Point = readonly [bigint, bigint, bigint, bigint];
const IDENTITY: Point = [0n, 1n, 1n, 0n];

function pointAdd(left: Point, right: Point): Point {
  const [x1, y1, z1, t1] = left;
  const [x2, y2, z2, t2] = right;
  const a = mod((y1 - x1) * (y2 - x2));
  const b = mod((y1 + x1) * (y2 + x2));
  const c = mod(2n * D * t1 * t2);
  const d = mod(2n * z1 * z2);
  const e = b - a;
  const f = d - c;
  const g = d + c;
  const h = b + a;
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}

function pointDouble(point: Point): Point {
  const [x, y, z] = point;
  const a = mod(x * x);
  const b = mod(y * y);
  const c = mod(2n * z * z);
  const d = mod(-a);
  const e = mod((x + y) * (x + y) - a - b);
  const g = d + b;
  const f = g - c;
  const h = d - b;
  return [mod(e * f), mod(g * h), mod(f * g), mod(e * h)];
}

function littleEndianInteger(bytes: Uint8Array): bigint {
  let result = 0n;
  for (let index = bytes.length - 1; index >= 0; index--) {
    result = (result << 8n) | BigInt(bytes[index]!);
  }
  return result;
}

function decodePoint(bytes: Uint8Array): Point | undefined {
  if (bytes.length !== 32) return undefined;
  const encoded = bytes.slice();
  const sign = encoded[31]! >>> 7;
  encoded[31] = encoded[31]! & 0x7f;
  const y = littleEndianInteger(encoded);
  if (y >= P) return undefined;
  const y2 = mod(y * y);
  const u = mod(y2 - 1n);
  const v = mod(D * y2 + 1n);
  const v3 = mod(v * v * v);
  const v7 = mod(v3 * v3 * v);
  let x = mod(u * v3 * power(mod(u * v7), (P - 5n) / 8n));
  if (mod(v * x * x - u) !== 0n) x = mod(x * SQRT_M1);
  if (mod(v * x * x - u) !== 0n || (x === 0n && sign === 1)) return undefined;
  if (Number(x & 1n) !== sign) x = P - x;
  return [x, y, 1n, mod(x * y)];
}

const BASE_ENCODING = Uint8Array.from([0x58, ...new Array<number>(31).fill(0x66)]);
const BASE_POINT = decodePoint(BASE_ENCODING)!;

function pointsEqual(left: Point, right: Point): boolean {
  return mod(left[0] * right[2] - right[0] * left[2]) === 0n
    && mod(left[1] * right[2] - right[1] * left[2]) === 0n;
}

function pointNegate(point: Point): Point {
  return [mod(-point[0]), point[1], point[2], mod(-point[3])];
}

function hasSmallOrder(point: Point): boolean {
  return pointsEqual(pointDouble(pointDouble(pointDouble(point))), IDENTITY);
}

function windowTable(point: Point): readonly Point[] {
  const table: Point[] = [IDENTITY, point];
  for (let index = 2; index < 16; index++) {
    table.push(pointAdd(table[index - 1]!, point));
  }
  return table;
}

const BASE_WINDOW = windowTable(BASE_POINT);

function doubleScalarBaseMinusPoint(
  baseScalar: bigint,
  point: Point,
  pointScalar: bigint,
): Point {
  const pointWindow = windowTable(pointNegate(point));
  let result = IDENTITY;
  for (let window = 63; window >= 0; window--) {
    result = pointDouble(pointDouble(pointDouble(pointDouble(result))));
    const shift = BigInt(window * 4);
    const baseDigit = Number((baseScalar >> shift) & 0xfn);
    const pointDigit = Number((pointScalar >> shift) & 0xfn);
    if (baseDigit !== 0) result = pointAdd(result, BASE_WINDOW[baseDigit]!);
    if (pointDigit !== 0) result = pointAdd(result, pointWindow[pointDigit]!);
  }
  return result;
}

const PUBLIC_POINT_CACHE_LIMIT = 64;
const publicPointCache = new Map<string, Point>();

function decodedPublicPoint(publicKey: Uint8Array): Point | undefined {
  const cacheKey = signatureBytesToBase64(publicKey);
  const cached = publicPointCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const point = decodePoint(publicKey);
  if (point === undefined || hasSmallOrder(point)) return undefined;
  if (publicPointCache.size >= PUBLIC_POINT_CACHE_LIMIT) {
    const oldest = publicPointCache.keys().next().value as string | undefined;
    if (oldest !== undefined) publicPointCache.delete(oldest);
  }
  publicPointCache.set(cacheKey, point);
  return point;
}

/** Synchronous strict Ed25519 verification for post-hoc replay checking. */
export function verifyEd25519(
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  if (publicKey.length !== 32 || signature.length !== 64) return false;
  const rBytes = signature.subarray(0, 32);
  const s = littleEndianInteger(signature.subarray(32));
  if (s >= L) return false;
  const publicPoint = decodedPublicPoint(publicKey);
  const rPoint = decodePoint(rBytes);
  if (!publicPoint || !rPoint || hasSmallOrder(rPoint)) {
    return false;
  }
  const challenge = littleEndianInteger(
    sha512(concatBytes(rBytes, publicKey, message)),
  ) % L;
  const reconstructed = doubleScalarBaseMinusPoint(s, publicPoint, challenge);
  return pointsEqual(
    pointDouble(pointDouble(pointDouble(reconstructed))),
    pointDouble(pointDouble(pointDouble(rPoint))),
  );
}

/** Verify canonical base64 Ed25519 material without throwing. */
export function verifyEd25519Base64(
  publicKey: string,
  message: Uint8Array,
  signature: string,
): boolean {
  try {
    return verifyEd25519(
      signatureBytesFromBase64(publicKey, 'publicKey', 32),
      message,
      signatureBytesFromBase64(signature, 'sig', 64),
    );
  } catch {
    return false;
  }
}

/** Generate an extractable client-side Ed25519 key pair with WebCrypto. */
export async function generateSubmissionKeyPair(): Promise<CryptoKeyPair> {
  return crypto.subtle.generateKey({ name: SUBMISSION_SIGNATURE_ALGORITHM }, true, [
    'sign',
    'verify',
  ]);
}

/** Export a WebCrypto Ed25519 public key in the replay's canonical base64 form. */
export async function exportSubmissionPublicKey(publicKey: CryptoKey): Promise<string> {
  const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
  if (raw.length !== 32) throw new TypeError('Ed25519 public key must contain 32 raw bytes');
  return signatureBytesToBase64(raw);
}

/** Sign arbitrary bytes with a WebCrypto Ed25519 private key. */
export async function signEd25519Base64(
  privateKey: CryptoKey,
  message: Uint8Array,
): Promise<string> {
  const messageBuffer = message.slice().buffer as ArrayBuffer;
  const signature = new Uint8Array(
    await crypto.subtle.sign(SUBMISSION_SIGNATURE_ALGORITHM, privateKey, messageBuffer),
  );
  if (signature.length !== 64) throw new TypeError('Ed25519 signature must contain 64 bytes');
  return signatureBytesToBase64(signature);
}

/** Sign one RFC-010 submission envelope. */
export function signSubmissionV1(
  privateKey: CryptoKey,
  envelope: SubmissionSigningEnvelope,
): Promise<string> {
  return signEd25519Base64(privateKey, submissionPreimageV1(envelope));
}

/** Sign a periodic RFC-010 chain-head checkpoint. */
export function signPeriodicChainHeadV1(
  privateKey: CryptoKey,
  envelope: PeriodicSigningEnvelope,
): Promise<string> {
  return signEd25519Base64(privateKey, periodicSignaturePreimageV1(envelope));
}
