import {
  assertJsonValue,
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

function diffJson(previous: JsonValue, next: JsonValue): JsonPatchOperation[] {
  const operations: JsonPatchOperation[] = [];
  const visit = (left: JsonValue, right: JsonValue, path: string): void => {
    if (jsonEqual(left, right)) return;
    if (!objectValue(left) || !objectValue(right)) {
      operations.push({ op: 'replace', path, value: structuredClone(right) });
      return;
    }
    const leftKeys = Object.keys(left).sort(compareCodePoints);
    const rightKeys = Object.keys(right).sort(compareCodePoints);
    const rightSet = new Set(rightKeys);
    for (const key of leftKeys) {
      if (!rightSet.has(key)) {
        operations.push({ op: 'remove', path: `${path}/${pointerToken(key)}` });
      }
    }
    const leftSet = new Set(leftKeys);
    for (const key of rightKeys) {
      const childPath = `${path}/${pointerToken(key)}`;
      if (!leftSet.has(key)) {
        operations.push({ op: 'add', path: childPath, value: structuredClone(right[key]!) });
      } else {
        visit(left[key]!, right[key]!, childPath);
      }
    }
  };
  visit(previous, next, '');
  return operations;
}

/** Deterministic RFC-6902 subset. Arrays are atomically replaced. */
export function createJsonPatch(previous: JsonValue, next: JsonValue): JsonPatchOperation[] {
  assertJsonValue(previous, 'previous view');
  assertJsonValue(next, 'next view');
  return diffJson(previous, next);
}

/** @internal Inputs have already passed the session canonical JSON boundary. */
export function createValidatedJsonPatch(
  previous: JsonValue,
  next: JsonValue,
): JsonPatchOperation[] {
  return diffJson(previous, next);
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
