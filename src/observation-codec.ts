import {
  assertJsonValue,
  canonicalJson,
  type JsonValue,
} from './protocol.js';

export type JsonPatchOperation =
  | { op: 'add' | 'replace'; path: string; value: JsonValue }
  | { op: 'remove'; path: string };

const FORBIDDEN_POINTER_TOKENS = new Set(['__proto__', 'prototype', 'constructor']);

function pointerToken(value: string): string {
  if (FORBIDDEN_POINTER_TOKENS.has(value)) {
    throw new TypeError(`unsafe JSON Pointer token ${value}`);
  }
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function decodePointer(path: string): string[] {
  if (path === '') return [];
  if (!path.startsWith('/')) throw new TypeError('JSON Pointer must be empty or start with /');
  return path.slice(1).split('/').map((token) => {
    if (/~(?![01])/u.test(token)) throw new TypeError('JSON Pointer contains invalid escape');
    const decoded = token.replaceAll('~1', '/').replaceAll('~0', '~');
    if (FORBIDDEN_POINTER_TOKENS.has(decoded)) {
      throw new TypeError(`unsafe JSON Pointer token ${decoded}`);
    }
    return decoded;
  });
}

function objectValue(value: JsonValue): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => jsonEqual(value, right[index]!));
  }
  if (!objectValue(left) || !objectValue(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every(
      (key) => Object.hasOwn(right, key) && jsonEqual(left[key]!, right[key]!),
    );
}

function compareCodePoints(left: string, right: string): number {
  const a = Array.from(left, (value) => value.codePointAt(0)!);
  const b = Array.from(right, (value) => value.codePointAt(0)!);
  for (let index = 0; index < Math.min(a.length, b.length); index++) {
    if (a[index] !== b[index]) return a[index]! - b[index]!;
  }
  return a.length - b.length;
}

interface DiffJsonOptions {
  maxOperations?: number;
  maxBytes?: number;
  canonical?: boolean;
}

interface DiffJsonResult {
  operations: JsonPatchOperation[];
  canonical?: string;
  bytes?: number;
}

const textEncoder = new TextEncoder();

function diffJson(
  previous: JsonValue,
  next: JsonValue,
  options: DiffJsonOptions = {},
): DiffJsonResult | null {
  const operations: JsonPatchOperation[] = [];
  const canonicalOperations: string[] = [];
  let canonicalBytes = 2;
  let exceeded = false;
  const emit = (operation: JsonPatchOperation): void => {
    if (exceeded) return;
    if (operations.length >= (options.maxOperations ?? Number.POSITIVE_INFINITY)) {
      exceeded = true;
      return;
    }
    if (options.canonical || options.maxBytes !== undefined) {
      const encoded = canonicalJson(operation as unknown as JsonValue);
      const nextBytes = canonicalBytes
        + (canonicalOperations.length === 0 ? 0 : 1)
        + textEncoder.encode(encoded).length;
      if (nextBytes > (options.maxBytes ?? Number.POSITIVE_INFINITY)) {
        exceeded = true;
        return;
      }
      canonicalOperations.push(encoded);
      canonicalBytes = nextBytes;
    }
    operations.push(operation);
  };
  const visit = (left: JsonValue, right: JsonValue, path: string): void => {
    if (exceeded) return;
    if (jsonEqual(left, right)) return;
    if (!objectValue(left) || !objectValue(right)) {
      emit({ op: 'replace', path, value: structuredClone(right) });
      return;
    }
    const leftKeys = Object.keys(left).sort(compareCodePoints);
    const rightKeys = Object.keys(right).sort(compareCodePoints);
    const rightSet = new Set(rightKeys);
    for (const key of leftKeys) {
      if (!rightSet.has(key)) {
        emit({ op: 'remove', path: `${path}/${pointerToken(key)}` });
        if (exceeded) return;
      }
    }
    const leftSet = new Set(leftKeys);
    for (const key of rightKeys) {
      if (exceeded) return;
      const childPath = `${path}/${pointerToken(key)}`;
      if (!leftSet.has(key)) {
        emit({ op: 'add', path: childPath, value: structuredClone(right[key]!) });
      } else {
        visit(left[key]!, right[key]!, childPath);
      }
    }
  };
  visit(previous, next, '');
  if (exceeded) return null;
  return {
    operations,
    ...(options.canonical
      ? {
          canonical: `[${canonicalOperations.join(',')}]`,
          bytes: canonicalBytes,
        }
      : {}),
  };
}

/** Deterministic RFC-6902 subset. Arrays are atomically replaced. */
export function createJsonPatch(previous: JsonValue, next: JsonValue): JsonPatchOperation[] {
  assertJsonValue(previous, 'previous view');
  assertJsonValue(next, 'next view');
  // No limit supplied, so the walk never abandons and the result is never null.
  return diffJson(previous, next)!.operations;
}

/** @internal Inputs have already passed the session canonical JSON boundary. */
/**
 * Build a patch, optionally abandoning the walk once it exceeds `maxOperations`.
 *
 * Returns `null` only when a limit was supplied and exceeded, so the caller can
 * fall back to a snapshot *without having paid for the full diff*. Called with
 * two arguments the behaviour is unchanged and the result is never `null`.
 */
export function createValidatedJsonPatch(
  previous: JsonValue,
  next: JsonValue,
  maxOperations?: number,
): JsonPatchOperation[] | null {
  return diffJson(previous, next, { maxOperations })?.operations ?? null;
}

/**
 * Build a patch while enforcing operation and canonical-byte bounds during the
 * walk. The canonical form is returned so callers do not serialize it twice.
 *
 * @internal Inputs have already passed the session canonical JSON boundary.
 */
export function createBoundedValidatedJsonPatch(
  previous: JsonValue,
  next: JsonValue,
  maxOperations: number,
  maxBytes: number,
): {
  operations: JsonPatchOperation[];
  canonical: string;
  bytes: number;
} | null {
  const result = diffJson(previous, next, {
    maxOperations,
    maxBytes,
    canonical: true,
  });
  if (result === null) return null;
  return {
    operations: result.operations,
    canonical: result.canonical!,
    bytes: result.bytes!,
  };
}

/** Apply the safe RFC-6902 subset without mutating the prior snapshot. */
export function applyJsonPatch(
  previous: JsonValue,
  operations: readonly JsonPatchOperation[],
): JsonValue {
  assertJsonValue(previous, 'previous view');
  let root = structuredClone(previous);
  for (const operation of operations) {
    if (operation === null || typeof operation !== 'object') {
      throw new TypeError('patch operation must be an object');
    }
    const tokens = decodePointer(operation.path);
    if (tokens.length === 0) {
      if (operation.op === 'remove') throw new TypeError('root removal is not supported');
      assertJsonValue(operation.value, 'patch value');
      root = structuredClone(operation.value);
      continue;
    }
    let parent: JsonValue = root;
    for (const token of tokens.slice(0, -1)) {
      if (!objectValue(parent) || !Object.hasOwn(parent, token)) {
        throw new TypeError('patch path does not exist');
      }
      parent = parent[token]!;
    }
    if (!objectValue(parent)) throw new TypeError('patch parent must be an object');
    const key = tokens.at(-1)!;
    if (operation.op === 'remove') {
      if (!Object.hasOwn(parent, key)) throw new TypeError('remove path does not exist');
      delete parent[key];
    } else {
      assertJsonValue(operation.value, 'patch value');
      if (operation.op === 'replace' && !Object.hasOwn(parent, key)) {
        throw new TypeError('replace path does not exist');
      }
      Object.defineProperty(parent, key, {
        configurable: true,
        enumerable: true,
        writable: true,
        value: structuredClone(operation.value),
      });
    }
  }
  return root;
}

/**
 * Prove that a product interest result only removes structure from the
 * partitioned view. Arrays may be ordered subsequences; primitives must match.
 */
function jsonProjection(source: JsonValue, projected: JsonValue): boolean {
  if (jsonEqual(source, projected)) return true;
  if (Array.isArray(source) && Array.isArray(projected)) {
    let sourceIndex = 0;
    for (const item of projected) {
      while (sourceIndex < source.length
        && !jsonProjection(source[sourceIndex]!, item)) sourceIndex++;
      if (sourceIndex === source.length) return false;
      sourceIndex++;
    }
    return true;
  }
  if (objectValue(source) && objectValue(projected)) {
    return Object.keys(projected).every(
      (key) => Object.hasOwn(source, key) && jsonProjection(source[key]!, projected[key]!),
    );
  }
  return false;
}

export function isJsonProjection(source: JsonValue, projected: JsonValue): boolean {
  assertJsonValue(source, 'partitioned view');
  assertJsonValue(projected, 'interest view');
  return jsonProjection(source, projected);
}
