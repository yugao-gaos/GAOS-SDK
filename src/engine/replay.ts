import {
  advanceTick,
  replayMetricsFor,
  type Reducer,
  type SessionView,
  type SubmittedAction,
} from './contracts.js';
import type { LocationRef } from './locations.js';
import type { JsonValue } from '../protocol.js';
import { locationKey } from './locations.js';
import { applyCanonicalActions } from './lockstep.js';

export type TranscriptVisibility = 'full' | `seat:${string}`;

export interface TranscriptHeader<TLevel> {
  sessionId: string;
  level: TLevel;
  seed: number;
  /** Wire action index to canonical action index. */
  perm: number[];
  status: 'won' | 'failed' | 'ended';
  stars: number | null;
  actionsUsed: number;
  /** Absent means `full` for v0.12/v0.13 transcript compatibility. */
  visibility?: TranscriptVisibility;
}

export interface TranscriptAction {
  n: number;
  wireId: string;
  canonicalId: string;
  payload?: JsonValue;
  x?: number;
  y?: number;
  index?: number;
  boardId?: string;
  zoneId?: string;
  seat?: string;
  targets?: readonly LocationRef[];
  /** High-frequency tick. Empty ticks between records are omitted. */
  tick?: number;
}

export interface RecheckResult {
  ok: boolean;
  problems: string[];
  /** Non-fatal audit limitations and security hygiene warnings. */
  diagnostics: string[];
  replayed: { status: string; stars: number | null; actionsUsed: number };
}

export interface RecheckOptions<TState> {
  /** Product-owned scheduled work for omitted all-wait ticks. */
  applyEmptyTick?: (state: TState, tick: number) => TState;
}

/** Re-simulate a transcript and compare its deterministic recorded outcome. */
export function recheckTranscript<TLevel, TState, TView extends SessionView>(
  reducer: Reducer<TLevel, TState, TView>,
  header: TranscriptHeader<TLevel>,
  actions: TranscriptAction[],
  options: RecheckOptions<TState> = {},
): RecheckResult {
  const problems: string[] = [];
  if (header.visibility !== undefined
    && (typeof header.visibility !== 'string'
      || (header.visibility !== 'full' && !/^seat:.+/.test(header.visibility)))) {
    problems.push('visibility must be full or seat:<id>');
  }
  const validSeed = Number.isSafeInteger(header.seed) && header.seed >= 0 && header.seed <= 0xffff_ffff;
  if (!validSeed) problems.push('seed must be an unsigned 32-bit integer');
  const permutation: unknown[] = Array.isArray(header.perm) ? header.perm : [];
  const permutationLength = permutation.length;
  const validPermutation = Array.isArray(header.perm)
    && permutation.every((entry) => Number.isSafeInteger(entry)
      && (entry as number) >= 0 && (entry as number) < permutationLength)
    && new Set(permutation).size === permutationLength;
  if (!validPermutation) problems.push('perm must be a complete bijection over its declared length');

  const actionValues: unknown[] = Array.isArray(actions) ? actions : [];
  if (!Array.isArray(actions)) problems.push('actions must be an array');
  const firstAction = actionValues[0];
  const firstNumber = firstAction && typeof firstAction === 'object' && !Array.isArray(firstAction)
    ? (firstAction as Record<string, unknown>)['n']
    : undefined;
  const sequenceBase = firstNumber === 0 || firstNumber === 1
    ? firstNumber
    : undefined;
  if (actionValues.length > 0 && sequenceBase === undefined) {
    problems.push('action numbering must start at 0 or 1');
  }
  let inferredTick = 0;
  const parsedActions = actionValues.map((value, offset) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      problems.push(`action at index ${offset} must be an object`);
      return { action: undefined, valid: false, effectiveTick: inferredTick };
    }
    const action = value as Partial<TranscriptAction>;
    if (!Number.isSafeInteger(action.n) || sequenceBase === undefined || action.n !== sequenceBase + offset) {
      problems.push(`action at index ${offset} has non-contiguous sequence number ${String(action.n)}`);
    }
    const parseId = (value: unknown, field: string): number | undefined => {
      if (typeof value !== 'string') {
        problems.push(`action ${String(action.n)} ${field} must use Action N syntax`);
        return undefined;
      }
      const match = /^Action ([1-9]\d*)$/.exec(value);
      const number = match ? Number(match[1]) : Number.NaN;
      if (!Number.isSafeInteger(number) || number < 1 || number > permutationLength) {
        problems.push(`action ${String(action.n)} ${field} must be within Action 1..${permutationLength}`);
        return undefined;
      }
      return number - 1;
    };
    for (const field of ['x', 'y', 'index', 'tick'] as const) {
      if (action[field] !== undefined && !Number.isSafeInteger(action[field])) {
        problems.push(`action ${String(action.n)} ${field} must be a safe integer`);
      }
    }
    if (Number.isSafeInteger(action.tick) && action.tick! < 0) {
      problems.push(`action ${String(action.n)} tick must be non-negative`);
    }
    if (action.tick !== undefined && Number.isSafeInteger(action.tick) && action.tick >= 0) {
      if (action.tick < inferredTick) {
        problems.push(`action ${String(action.n)} tick must not precede the previous action`);
      } else {
        inferredTick = action.tick;
      }
    }
    for (const field of ['boardId', 'zoneId', 'seat'] as const) {
      if (action[field] !== undefined
        && (typeof action[field] !== 'string' || action[field].length === 0)) {
        problems.push(`action ${String(action.n)} ${field} must be a non-empty string`);
      }
    }
    let validTargets = true;
    if (action.targets !== undefined) {
      if (!Array.isArray(action.targets)) {
        problems.push(`action ${String(action.n)} targets must be an array`);
        validTargets = false;
      } else {
        for (const [index, target] of action.targets.entries()) {
          try {
            locationKey(target);
          } catch {
            problems.push(`action ${String(action.n)} target ${index} is invalid`);
            validTargets = false;
          }
        }
      }
    }
    const wire = parseId(action.wireId, 'wireId');
    const canonical = parseId(action.canonicalId, 'canonicalId');
    if (validPermutation && wire !== undefined && canonical !== undefined
      && permutation[wire] !== canonical) {
      problems.push(
        `action ${action.n}: wire ${action.wireId} → ${action.canonicalId} contradicts the session permutation`,
      );
    }
    return { action: action as TranscriptAction, effectiveTick: inferredTick,
      valid: wire !== undefined && canonical !== undefined
      && ['x', 'y', 'index', 'tick'].every((field) => (
        action[field as 'x' | 'y' | 'index' | 'tick'] === undefined
        || (Number.isSafeInteger(action[field as 'x' | 'y' | 'index' | 'tick'])
          && (field !== 'tick' || action.tick! >= 0))
      ))
      && ['boardId', 'zoneId', 'seat'].every((field) => (
        action[field as 'boardId' | 'zoneId' | 'seat'] === undefined
        || (typeof action[field as 'boardId' | 'zoneId' | 'seat'] === 'string'
          && action[field as 'boardId' | 'zoneId' | 'seat']!.length > 0)
      ))
      && validTargets };
  });

  let state = reducer.init(header.level, validSeed ? header.seed : 0);
  let replayError: string | null = null;
  let lastTick = -1;
  for (const { action, valid, effectiveTick } of parsedActions) {
    if (!action) continue;
    if (effectiveTick > lastTick) {
      if ('advance' in reducer || options.applyEmptyTick) {
        try {
          for (let tick = lastTick + 1; tick < effectiveTick; tick++) {
            state = 'advance' in reducer
              ? advanceTick(reducer, state, [])
              : options.applyEmptyTick!(state, tick);
          }
        } catch (error) {
          replayError = `empty tick before action ${action.n} rejected on replay: ${(error as Error).message}`;
          break;
        }
      }
      lastTick = effectiveTick;
    }
    if (reducer.view(state).status !== 'playing') {
      problems.push(`action ${action.n} appears after terminal state`);
      break;
    }
    if (!valid) continue;
    const submitted: SubmittedAction = {
      id: action.canonicalId,
      ...(action.payload !== undefined ? { payload: structuredClone(action.payload) } : {}),
      ...(action.x !== undefined ? { x: action.x } : {}),
      ...(action.y !== undefined ? { y: action.y } : {}),
      ...(action.index !== undefined ? { index: action.index } : {}),
      ...(action.boardId !== undefined ? { boardId: action.boardId } : {}),
      ...(action.zoneId !== undefined ? { zoneId: action.zoneId } : {}),
      ...(action.seat !== undefined ? { seat: action.seat } : {}),
      ...(action.targets !== undefined ? {
        targets: action.targets.map((target) => ({
          container: target.container,
          coord: Array.isArray(target.coord) ? [...target.coord] : target.coord,
        })),
      } : {}),
    };
    try {
      state = applyCanonicalActions(reducer, state, [submitted], false);
    } catch (error) {
      replayError = `action ${action.n} (${action.canonicalId}) rejected on replay: ${(error as Error).message}`;
      break;
    }
  }

  const view = reducer.view(state);
  let actionsUsed = -1;
  try {
    actionsUsed = replayMetricsFor(reducer, state, view).actionsUsed;
  } catch (error) {
    problems.push(
      `replay metrics: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (replayError) problems.push(replayError);
  if (view.status !== header.status) {
    problems.push(`status: recorded ${header.status}, replayed ${view.status}`);
  }
  if ((view.stars ?? null) !== header.stars) {
    problems.push(`stars: recorded ${header.stars}, replayed ${view.stars ?? null}`);
  }
  if (actionsUsed >= 0 && actionsUsed !== header.actionsUsed) {
    problems.push(`actionsUsed: recorded ${header.actionsUsed}, replayed ${actionsUsed}`);
  }

  return {
    ok: problems.length === 0,
    problems,
    diagnostics: [],
    replayed: {
      status: view.status,
      stars: view.stars ?? null,
      actionsUsed,
    },
  };
}

/** Deterministically derive one level seed from a multi-level run seed. */
export function runLevelSeed(sessionSeed: number, levelIndex: number): number {
  return (sessionSeed ^ (0x9e3779b9 * (levelIndex + 1))) >>> 0;
}

/** @deprecated Renamed to `TranscriptHeader`; this alias will be removed in v1.0. */
export type GridTranscriptHeader<TLevel> = TranscriptHeader<TLevel>;

/** @deprecated Renamed to `TranscriptAction`; this alias will be removed in v1.0. */
export type GridTranscriptAction = TranscriptAction;

/** @deprecated Renamed to `RecheckResult`; this alias will be removed in v1.0. */
export type GridRecheckResult = RecheckResult;

/** @deprecated Renamed to `recheckTranscript`; this alias will be removed in v1.0. */
export const recheckGridTranscript = recheckTranscript;
