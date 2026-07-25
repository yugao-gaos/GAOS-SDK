import {
  assertJsonValue,
  canonicalJson,
  type JsonValue,
} from '../protocol.js';

export const COMMITMENT_SCHEME = 'gaos.commit.sha256.v1' as const;
export const COMMITMENT_MAX_PAYLOAD_BYTES = 65_536;
export const COMMITMENT_MAX_ID = 0xffff_ffff;

export interface CommitmentBinding {
  sessionId: string;
  seat: string;
  commitmentId: number;
  windowRef: number;
}

export interface CommitmentEnvelope {
  commitmentId: number;
  scheme: typeof COMMITMENT_SCHEME;
  hash: string;
}

export interface RevealEnvelope {
  commitmentId: number;
  salt: string;
  payload: JsonValue;
}

export type CommitmentVerificationCode =
  | 'ok'
  | 'invalid_envelope'
  | 'commit_mismatch';

export interface CommitmentVerification {
  ok: boolean;
  code: CommitmentVerificationCode;
  expectedHash: string;
  actualHash: string;
}

const encoder = new TextEncoder();
const DOMAIN_TAG = encoder.encode(COMMITMENT_SCHEME);

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

function assertPayloadUnicode(value: JsonValue, path = 'payload'): void {
  if (typeof value === 'string') {
    assertValidUnicode(value, path);
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => assertPayloadUnicode(entry, `${path}[${index}]`));
  } else if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      assertValidUnicode(key, `${path} key`);
      assertPayloadUnicode(entry, `${path}.${key}`);
    }
  }
}

function utf8(value: string, label: string, maximum: number): Uint8Array {
  assertValidUnicode(value, label);
  const bytes = encoder.encode(value);
  if (bytes.length === 0) throw new RangeError(`${label} must be non-empty`);
  if (bytes.length > maximum) throw new RangeError(`${label} exceeds ${maximum} UTF-8 bytes`);
  return bytes;
}

function decodeLowerHex(value: string, label: string, minimum: number, maximum: number): Uint8Array {
  if (typeof value !== 'string' || !/^(?:[0-9a-f]{2})+$/.test(value)) {
    throw new TypeError(`${label} must be even-length lowercase hexadecimal`);
  }
  const length = value.length / 2;
  if (length < minimum || length > maximum) {
    throw new RangeError(`${label} must decode to ${minimum}..${maximum} bytes`);
  }
  const bytes = new Uint8Array(length);
  for (let index = 0; index < length; index++) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function assertBinding(binding: CommitmentBinding): void {
  if (!Number.isSafeInteger(binding.commitmentId)
    || binding.commitmentId < 0
    || binding.commitmentId > COMMITMENT_MAX_ID) {
    throw new RangeError('commitmentId must be an unsigned 32-bit integer');
  }
  if (!Number.isSafeInteger(binding.windowRef) || binding.windowRef < 0) {
    throw new RangeError('windowRef must be a non-negative safe integer');
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
  const high = Math.floor(value / 0x1_0000_0000);
  const low = value >>> 0;
  offset = writeU32(target, offset, high);
  return writeU32(target, offset, low);
}

function framedSize(bytes: Uint8Array): number {
  return 4 + bytes.length;
}

function writeFramed(target: Uint8Array, offset: number, bytes: Uint8Array): number {
  offset = writeU32(target, offset, bytes.length);
  target.set(bytes, offset);
  return offset + bytes.length;
}

/** Canonical payload bytes used by the v1 commitment scheme. */
export function canonicalCommitPayloadV1(payload: JsonValue): Uint8Array {
  assertJsonValue(payload, 'payload');
  assertPayloadUnicode(payload);
  const bytes = encoder.encode(canonicalJson(payload));
  if (bytes.length > COMMITMENT_MAX_PAYLOAD_BYTES) {
    throw new RangeError(`payload exceeds ${COMMITMENT_MAX_PAYLOAD_BYTES} UTF-8 bytes`);
  }
  return bytes;
}

/** Build the complete, framed byte preimage pinned by gaos.commit.sha256.v1. */
export function commitmentPreimageV1(
  binding: CommitmentBinding,
  salt: string,
  payload: JsonValue,
): Uint8Array {
  assertBinding(binding);
  const session = utf8(binding.sessionId, 'sessionId', 128);
  const seat = utf8(binding.seat, 'seat', 64);
  const saltBytes = decodeLowerHex(salt, 'salt', 16, 64);
  const payloadBytes = canonicalCommitPayloadV1(payload);
  const result = new Uint8Array(
    framedSize(DOMAIN_TAG)
    + framedSize(session)
    + framedSize(seat)
    + 8
    + 8
    + framedSize(saltBytes)
    + framedSize(payloadBytes),
  );
  let offset = 0;
  offset = writeFramed(result, offset, DOMAIN_TAG);
  offset = writeFramed(result, offset, session);
  offset = writeFramed(result, offset, seat);
  offset = writeU64(result, offset, binding.commitmentId);
  offset = writeU64(result, offset, binding.windowRef);
  offset = writeFramed(result, offset, saltBytes);
  writeFramed(result, offset, payloadBytes);
  return result;
}

// Synchronous SHA-256 for replay verification. Arithmetic is deliberately
// limited to ECMAScript's exact 32-bit bitwise and Math.imul operations.
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value: number, amount: number): number {
  return (value >>> amount) | (value << (32 - amount));
}

/** Hash bytes with the frozen synchronous SHA-256 implementation. */
export function sha256(bytes: Uint8Array): Uint8Array {
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x1_0000_0000), false);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);

  const hash = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
    0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const words = new Uint32Array(64);
  for (let block = 0; block < paddedLength; block += 64) {
    for (let index = 0; index < 16; index++) {
      words[index] = view.getUint32(block + index * 4, false);
    }
    for (let index = 16; index < 64; index++) {
      const w15 = words[index - 15]!;
      const w2 = words[index - 2]!;
      const s0 = rotateRight(w15, 7) ^ rotateRight(w15, 18) ^ (w15 >>> 3);
      const s1 = rotateRight(w2, 17) ^ rotateRight(w2, 19) ^ (w2 >>> 10);
      words[index] = (words[index - 16]! + s0 + words[index - 7]! + s1) >>> 0;
    }
    let a = hash[0]!;
    let b = hash[1]!;
    let c = hash[2]!;
    let d = hash[3]!;
    let e = hash[4]!;
    let f = hash[5]!;
    let g = hash[6]!;
    let h = hash[7]!;
    for (let index = 0; index < 64; index++) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temp1 = (h + sum1 + choose + SHA256_K[index]! + words[index]!) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }
  const output = new Uint8Array(32);
  const outputView = new DataView(output.buffer);
  hash.forEach((value, index) => outputView.setUint32(index * 4, value, false));
  return output;
}

export function bytesToHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) result += byte.toString(16).padStart(2, '0');
  return result;
}

/** Compute the wire hash for one commitment. */
export function createCommitmentHash(
  binding: CommitmentBinding,
  salt: string,
  payload: JsonValue,
): string {
  return bytesToHex(sha256(commitmentPreimageV1(binding, salt, payload)));
}

export function assertCommitmentEnvelope(value: CommitmentEnvelope): void {
  if (value.scheme !== COMMITMENT_SCHEME) {
    throw new TypeError(`scheme must be ${COMMITMENT_SCHEME}`);
  }
  if (!Number.isSafeInteger(value.commitmentId)
    || value.commitmentId < 0
    || value.commitmentId > COMMITMENT_MAX_ID) {
    throw new RangeError('commitmentId must be an unsigned 32-bit integer');
  }
  decodeLowerHex(value.hash, 'hash', 32, 32);
}

/** Verify one reveal against a recorded commitment and binding context. */
export function verifyCommitmentReveal(
  binding: CommitmentBinding,
  commitment: CommitmentEnvelope,
  reveal: RevealEnvelope,
): CommitmentVerification {
  assertCommitmentEnvelope(commitment);
  if (reveal.commitmentId !== commitment.commitmentId
    || binding.commitmentId !== commitment.commitmentId) {
    return {
      ok: false,
      code: 'invalid_envelope',
      expectedHash: commitment.hash,
      actualHash: '',
    };
  }
  const actualHash = createCommitmentHash(binding, reveal.salt, reveal.payload);
  return {
    ok: actualHash === commitment.hash,
    code: actualHash === commitment.hash ? 'ok' : 'commit_mismatch',
    expectedHash: commitment.hash,
    actualHash,
  };
}
