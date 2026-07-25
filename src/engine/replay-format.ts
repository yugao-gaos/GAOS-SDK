import {
  assertJsonValue,
  canonicalJson,
  type JsonObject,
} from '../protocol.js';
import type { Reducer, TickView } from './contracts.js';
import { locationKey } from './locations.js';
import {
  recheckTranscript,
  runLevelSeed,
  type RecheckOptions,
  type RecheckResult,
  type TranscriptAction,
  type TranscriptHeader,
  type TranscriptVisibility,
} from './replay.js';

/** Stable identifier carried by every SDK-owned portable replay. */
export const GAOS_REPLAY_FORMAT_ID = 'gaos.replay' as const;
/** Schema version for the header and action JSONL records. */
export const GAOS_REPLAY_FORMAT_VERSION = '1.0' as const;
/** Media type used by downloads, object storage, and module manifests. */
export const GAOS_REPLAY_MIME = 'application/vnd.gaos.replay+jsonl' as const;
/** Conventional filename extension, without a leading dot. */
export const GAOS_REPLAY_EXTENSION = 'gaos-replay.jsonl' as const;
/** Seed policy compatible with `runLevelSeed`. */
export const GAOS_REPLAY_DERIVED_SEEDS = 'gaos.run-level-seed.v1' as const;

/**
 * Drop-in value for TabletopLabs-style `results.replayFormat` declarations.
 * Compression belongs to the surrounding transport, not the canonical bytes.
 */
export const GAOS_REPLAY_MANIFEST_FORMAT = Object.freeze({
  mime: GAOS_REPLAY_MIME,
  extension: GAOS_REPLAY_EXTENSION,
  compressed: false,
});

export type ReplaySeedPolicy = 'explicit' | typeof GAOS_REPLAY_DERIVED_SEEDS;

/**
 * Selects the game and historical deterministic adapter needed to recheck it.
 * Products decide how these ids resolve to executable reducer code.
 */
export interface ReplayGameRef {
  id: string;
  version: string;
  adapter: {
    id: string;
    version: string;
  };
}

export interface ReplayLevelResult {
  status: 'won' | 'failed';
  stars: number | null;
  actionsUsed: number;
  /** Product-specific scores or benchmark facts; core recheck ignores them. */
  extensions?: JsonObject;
}

export interface ReplayLevelRecord<TLevel> {
  /** Zero-based position in the pinned run. */
  index: number;
  id: string;
  version?: string | number;
  /** Explicit even when derived, so each segment is independently inspectable. */
  seed: number;
  /** Self-contained reducer input pinned at the time of play. */
  level: TLevel;
  result: ReplayLevelResult;
  extensions?: JsonObject;
}

export interface ReplayTotals {
  totalStars: number;
  totalActionsUsed: number;
  extensions?: JsonObject;
}

/** First line of a GAOS replay JSONL artifact. */
export interface ReplayHeader<TLevel> {
  kind: 'header';
  format: typeof GAOS_REPLAY_FORMAT_ID;
  formatVersion: typeof GAOS_REPLAY_FORMAT_VERSION;
  sessionId: string;
  game: ReplayGameRef;
  /** Run seed. Per-level seeds remain explicit in `levels`. */
  seed: number;
  seedPolicy: ReplaySeedPolicy;
  /** Default wire action index to canonical action index permutation. */
  perm: number[];
  levels: Array<ReplayLevelRecord<TLevel>>;
  totals: ReplayTotals;
  visibility?: TranscriptVisibility;
  /** Host, creator, agent, signing, or benchmark metadata. */
  extensions?: JsonObject;
}

/** Every line after the header is one canonical reducer input delta. */
export interface ReplayAction extends TranscriptAction {
  kind: 'action';
  levelIndex: number;
}

export interface ReplayArtifact<TLevel> {
  header: ReplayHeader<TLevel>;
  actions: ReplayAction[];
}

export interface ReplayLevelInput<TLevel> {
  id: string;
  version?: string | number;
  /**
   * Required for `explicit`; ignored and recomputed for the derived seed
   * policy so producers cannot accidentally write a different derivation.
   */
  seed?: number;
  level: TLevel;
  result: ReplayLevelResult;
  extensions?: JsonObject;
}

export interface ReplayActionInput extends TranscriptAction {
  levelIndex: number;
}

export interface CreateReplayArtifactInput<TLevel> {
  sessionId: string;
  game: ReplayGameRef;
  seed: number;
  seedPolicy?: ReplaySeedPolicy;
  perm: number[];
  levels: Array<ReplayLevelInput<TLevel>>;
  actions: ReplayActionInput[];
  totals?: ReplayTotals;
  visibility?: TranscriptVisibility;
  extensions?: JsonObject;
}

export interface TranscriptReplayOptions {
  game: ReplayGameRef;
  levelId: string;
  levelVersion?: string | number;
  extensions?: JsonObject;
}

export interface ReplayReducerContext<TLevel> {
  game: ReplayGameRef;
  level: ReplayLevelRecord<TLevel>;
}

export type ReplayReducerResolver<
  TLevel,
  TState,
  TView extends TickView<unknown, unknown>,
> = (context: ReplayReducerContext<TLevel>) => Reducer<TLevel, TState, TView> | undefined;

export interface ReplayArtifactRecheckOptions<TLevel, TState> {
  optionsForLevel?: (
    context: ReplayReducerContext<TLevel>,
  ) => RecheckOptions<TState> | undefined;
}

export interface ReplayLevelRecheck {
  index: number;
  id: string;
  seed: number;
  result: RecheckResult;
}

export interface ReplayArtifactRecheckResult {
  ok: boolean;
  problems: string[];
  levels: ReplayLevelRecheck[];
  replayed: {
    statuses: string[];
    totalStars: number;
    totalActionsUsed: number;
  };
}

export class ReplayFormatError extends Error {
  readonly problems: string[];

  constructor(problems: string[]) {
    super(`invalid ${GAOS_REPLAY_FORMAT_ID} ${GAOS_REPLAY_FORMAT_VERSION} artifact: ${problems.join('; ')}`);
    this.name = 'ReplayFormatError';
    this.problems = [...problems];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validU32(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
}

function validNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validatePermutation(value: unknown): boolean {
  return Array.isArray(value)
    && value.every((entry) => Number.isSafeInteger(entry)
      && entry >= 0 && entry < value.length)
    && new Set(value).size === value.length;
}

function replayTotals(levels: ReadonlyArray<ReplayLevelRecord<unknown>>): ReplayTotals {
  return {
    totalStars: levels.reduce(
      (sum, level) => sum + (level.result.status === 'won' ? (level.result.stars ?? 0) : 0),
      0,
    ),
    totalActionsUsed: levels.reduce((sum, level) => sum + level.result.actionsUsed, 0),
  };
}

/**
 * Build a normalized portable replay. Derived level seeds and aggregate totals
 * are computed here so Arena, TabletopLabs, and other producers write the same
 * envelope.
 */
export function createReplayArtifact<TLevel>(
  input: CreateReplayArtifactInput<TLevel>,
): ReplayArtifact<TLevel> {
  const seedPolicy = input.seedPolicy ?? GAOS_REPLAY_DERIVED_SEEDS;
  const levels = input.levels.map((level, index): ReplayLevelRecord<TLevel> => ({
    index,
    id: level.id,
    ...(level.version === undefined ? {} : { version: level.version }),
    seed: seedPolicy === GAOS_REPLAY_DERIVED_SEEDS
      ? runLevelSeed(input.seed, index)
      : level.seed as number,
    level: level.level,
    result: level.result,
    ...(level.extensions === undefined ? {} : { extensions: level.extensions }),
  }));
  const header: ReplayHeader<TLevel> = {
    kind: 'header',
    format: GAOS_REPLAY_FORMAT_ID,
    formatVersion: GAOS_REPLAY_FORMAT_VERSION,
    sessionId: input.sessionId,
    game: input.game,
    seed: input.seed,
    seedPolicy,
    perm: [...input.perm],
    levels,
    totals: input.totals ?? replayTotals(levels),
    ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    ...(input.extensions === undefined ? {} : { extensions: input.extensions }),
  };
  const artifact: ReplayArtifact<TLevel> = {
    header,
    actions: input.actions.map((action) => ({ ...action, kind: 'action' })),
  };
  const problems = validateReplayArtifact(artifact);
  if (problems.length > 0) throw new ReplayFormatError(problems);
  return artifact;
}

/** Lift an existing single-level SDK transcript into the portable envelope. */
export function transcriptToReplayArtifact<TLevel>(
  header: TranscriptHeader<TLevel>,
  actions: TranscriptAction[],
  options: TranscriptReplayOptions,
): ReplayArtifact<TLevel> {
  return createReplayArtifact({
    sessionId: header.sessionId,
    game: options.game,
    seed: header.seed,
    seedPolicy: 'explicit',
    perm: header.perm,
    levels: [{
      id: options.levelId,
      ...(options.levelVersion === undefined ? {} : { version: options.levelVersion }),
      seed: header.seed,
      level: header.level,
      result: {
        status: header.status,
        stars: header.stars,
        actionsUsed: header.actionsUsed,
      },
    }],
    actions: actions.map((action) => ({ ...action, levelIndex: 0 })),
    ...(header.visibility === undefined ? {} : { visibility: header.visibility }),
    ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
  });
}

/**
 * Validate the transport envelope independently of game code. Reducer-level
 * legality and results are checked by `recheckReplayArtifact`.
 */
export function validateReplayArtifact(value: unknown): string[] {
  const problems: string[] = [];
  if (!isRecord(value)) return ['artifact must be an object'];
  const header = value['header'];
  const actions = value['actions'];
  if (!isRecord(header)) return ['header must be an object'];
  if (header['kind'] !== 'header') problems.push('header.kind must be header');
  if (header['format'] !== GAOS_REPLAY_FORMAT_ID) {
    problems.push(`header.format must be ${GAOS_REPLAY_FORMAT_ID}`);
  }
  if (header['formatVersion'] !== GAOS_REPLAY_FORMAT_VERSION) {
    problems.push(`header.formatVersion must be ${GAOS_REPLAY_FORMAT_VERSION}`);
  }
  if (typeof header['sessionId'] !== 'string' || header['sessionId'].length === 0) {
    problems.push('header.sessionId must be a non-empty string');
  }
  if (!validU32(header['seed'])) problems.push('header.seed must be an unsigned 32-bit integer');
  if (header['seedPolicy'] !== 'explicit' && header['seedPolicy'] !== GAOS_REPLAY_DERIVED_SEEDS) {
    problems.push(`header.seedPolicy must be explicit or ${GAOS_REPLAY_DERIVED_SEEDS}`);
  }
  if (!validatePermutation(header['perm'])) {
    problems.push('header.perm must be a complete bijection over its declared length');
  }
  if (
    header['visibility'] !== undefined
    && (typeof header['visibility'] !== 'string'
      || (header['visibility'] !== 'full' && !/^seat:.+/.test(header['visibility'])))
  ) {
    problems.push('header.visibility must be full or seat:<id>');
  }

  const game = header['game'];
  if (!isRecord(game)) {
    problems.push('header.game must be an object');
  } else {
    for (const field of ['id', 'version'] as const) {
      if (typeof game[field] !== 'string' || game[field].length === 0) {
        problems.push(`header.game.${field} must be a non-empty string`);
      }
    }
    const adapter = game['adapter'];
    if (!isRecord(adapter)) {
      problems.push('header.game.adapter must be an object');
    } else {
      for (const field of ['id', 'version'] as const) {
        if (typeof adapter[field] !== 'string' || adapter[field].length === 0) {
          problems.push(`header.game.adapter.${field} must be a non-empty string`);
        }
      }
    }
  }

  const levels = header['levels'];
  if (!Array.isArray(levels) || levels.length === 0) {
    problems.push('header.levels must be a non-empty array');
  } else {
    const ids = new Set<string>();
    for (const [index, candidate] of levels.entries()) {
      if (!isRecord(candidate)) {
        problems.push(`level at index ${index} must be an object`);
        continue;
      }
      if (candidate['index'] !== index) {
        problems.push(`level at index ${index} must declare index ${index}`);
      }
      if (typeof candidate['id'] !== 'string' || candidate['id'].length === 0) {
        problems.push(`level ${index} id must be a non-empty string`);
      } else if (ids.has(candidate['id'])) {
        problems.push(`level ${index} duplicates id ${candidate['id']}`);
      } else {
        ids.add(candidate['id']);
      }
      if (candidate['version'] !== undefined
        && typeof candidate['version'] !== 'string'
        && typeof candidate['version'] !== 'number') {
        problems.push(`level ${index} version must be a string or number`);
      }
      if (!validU32(candidate['seed'])) {
        problems.push(`level ${index} seed must be an unsigned 32-bit integer`);
      } else if (
        header['seedPolicy'] === GAOS_REPLAY_DERIVED_SEEDS
        && validU32(header['seed'])
        && candidate['seed'] !== runLevelSeed(header['seed'], index)
      ) {
        problems.push(`level ${index} seed does not match ${GAOS_REPLAY_DERIVED_SEEDS}`);
      }
      if (!Object.hasOwn(candidate, 'level')) problems.push(`level ${index} must include level data`);
      const result = candidate['result'];
      if (!isRecord(result)) {
        problems.push(`level ${index} result must be an object`);
      } else {
        if (result['status'] !== 'won' && result['status'] !== 'failed') {
          problems.push(`level ${index} result.status must be won or failed`);
        }
        if (result['stars'] !== null
          && (typeof result['stars'] !== 'number' || !Number.isFinite(result['stars']))) {
          problems.push(`level ${index} result.stars must be a finite number or null`);
        }
        if (!validNonNegativeInteger(result['actionsUsed'])) {
          problems.push(`level ${index} result.actionsUsed must be a non-negative safe integer`);
        }
      }
    }
  }

  const totals = header['totals'];
  if (!isRecord(totals)) {
    problems.push('header.totals must be an object');
  } else {
    if (typeof totals['totalStars'] !== 'number' || !Number.isFinite(totals['totalStars'])) {
      problems.push('header.totals.totalStars must be a finite number');
    }
    if (!validNonNegativeInteger(totals['totalActionsUsed'])) {
      problems.push('header.totals.totalActionsUsed must be a non-negative safe integer');
    }
  }

  if (!Array.isArray(actions)) {
    problems.push('actions must be an array');
  } else {
    const firstNumber = isRecord(actions[0]) ? actions[0]['n'] : undefined;
    const sequenceBase = firstNumber === 0 || firstNumber === 1 ? firstNumber : undefined;
    if (actions.length > 0 && sequenceBase === undefined) {
      problems.push('action numbering must start at 0 or 1');
    }
    let previousLevelIndex = -1;
    const levelTicks = new Map<number, number>();
    const permutation = validatePermutation(header['perm']) ? header['perm'] as number[] : [];
    for (const [index, action] of actions.entries()) {
      if (!isRecord(action)) {
        problems.push(`action at index ${index} must be an object`);
        continue;
      }
      if (action['kind'] !== 'action') problems.push(`action at index ${index} kind must be action`);
      if (!Number.isSafeInteger(action['n'])
        || sequenceBase === undefined
        || action['n'] !== sequenceBase + index) {
        problems.push(
          `action at index ${index} has non-contiguous sequence number ${String(action['n'])}`,
        );
      }
      if (!validNonNegativeInteger(action['levelIndex'])
        || !Array.isArray(levels)
        || action['levelIndex'] >= levels.length) {
        problems.push(`action ${String(action['n'])} has invalid levelIndex ${String(action['levelIndex'])}`);
      } else if (action['levelIndex'] < previousLevelIndex) {
        problems.push(`action ${String(action['n'])} returns to an earlier level`);
      } else {
        previousLevelIndex = action['levelIndex'];
      }
      const parseActionId = (field: 'wireId' | 'canonicalId'): number | undefined => {
        const value = action[field];
        if (typeof value !== 'string') {
          problems.push(`action ${String(action['n'])} ${field} must use Action N syntax`);
          return undefined;
        }
        const match = /^Action ([1-9]\d*)$/.exec(value);
        const number = match ? Number(match[1]) : Number.NaN;
        if (!Number.isSafeInteger(number) || number < 1 || number > permutation.length) {
          problems.push(
            `action ${String(action['n'])} ${field} must be within Action 1..${permutation.length}`,
          );
          return undefined;
        }
        return number - 1;
      };
      const wire = parseActionId('wireId');
      const canonical = parseActionId('canonicalId');
      if (wire !== undefined && canonical !== undefined && permutation[wire] !== canonical) {
        problems.push(
          `action ${String(action['n'])}: wire ${String(action['wireId'])} `
          + `to ${String(action['canonicalId'])} contradicts the replay permutation`,
        );
      }
      for (const field of ['x', 'y', 'index', 'tick'] as const) {
        if (action[field] !== undefined && !Number.isSafeInteger(action[field])) {
          problems.push(`action ${String(action['n'])} ${field} must be a safe integer`);
        }
      }
      if (Number.isSafeInteger(action['tick']) && (action['tick'] as number) < 0) {
        problems.push(`action ${String(action['n'])} tick must be non-negative`);
      }
      if (validNonNegativeInteger(action['levelIndex']) && validNonNegativeInteger(action['tick'])) {
        const lastTick = levelTicks.get(action['levelIndex']) ?? 0;
        if (action['tick'] < lastTick) {
          problems.push(`action ${String(action['n'])} tick must not precede its level's previous action`);
        } else {
          levelTicks.set(action['levelIndex'], action['tick']);
        }
      }
      for (const field of ['boardId', 'zoneId', 'seat'] as const) {
        if (action[field] !== undefined
          && (typeof action[field] !== 'string' || action[field].length === 0)) {
          problems.push(`action ${String(action['n'])} ${field} must be a non-empty string`);
        }
      }
      if (action['targets'] !== undefined) {
        if (!Array.isArray(action['targets'])) {
          problems.push(`action ${String(action['n'])} targets must be an array`);
        } else {
          for (const [targetIndex, target] of action['targets'].entries()) {
            try {
              locationKey(target as never);
            } catch {
              problems.push(`action ${String(action['n'])} target ${targetIndex} is invalid`);
            }
          }
        }
      }
    }
  }

  try {
    assertJsonValue(value, 'artifact');
  } catch (error) {
    problems.push(error instanceof Error ? error.message : 'artifact must contain only plain JSON');
  }
  return problems;
}

/** Canonical, trailing-newline JSONL suitable for hashing and object storage. */
export function serializeReplayJsonl<TLevel>(artifact: ReplayArtifact<TLevel>): string {
  const problems = validateReplayArtifact(artifact);
  if (problems.length > 0) throw new ReplayFormatError(problems);
  return [artifact.header, ...artifact.actions].map(canonicalJson).join('\n') + '\n';
}

/** Parse and validate one SDK-owned replay JSONL artifact. */
export function parseReplayJsonl<TLevel = unknown>(jsonl: string): ReplayArtifact<TLevel> {
  if (typeof jsonl !== 'string' || jsonl.trim().length === 0) {
    throw new ReplayFormatError(['JSONL must contain a header line']);
  }
  const lines = jsonl.split(/\r?\n/);
  while (lines.length > 0 && lines.at(-1)!.trim().length === 0) lines.pop();
  const parsed = lines.map((line, index) => {
    if (line.trim().length === 0) {
      throw new ReplayFormatError([`line ${index + 1} must not be blank`]);
    }
    try {
      return JSON.parse(line) as unknown;
    } catch (error) {
      throw new ReplayFormatError([
        `line ${index + 1} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ]);
    }
  });
  const artifact = {
    header: parsed[0],
    actions: parsed.slice(1),
  };
  const problems = validateReplayArtifact(artifact);
  if (problems.length > 0) throw new ReplayFormatError(problems);
  return artifact as ReplayArtifact<TLevel>;
}

/**
 * Recheck every level segment through the existing SDK reducer verifier, then
 * compare the run totals. Reducer selection is product-owned but keyed only by
 * the portable game/adapter/level declarations.
 */
export function recheckReplayArtifact<
  TLevel,
  TState,
  TView extends TickView<unknown, unknown>,
>(
  artifact: ReplayArtifact<TLevel>,
  resolveReducer: ReplayReducerResolver<TLevel, TState, TView>,
  options: ReplayArtifactRecheckOptions<TLevel, TState> = {},
): ReplayArtifactRecheckResult {
  const problems = validateReplayArtifact(artifact);
  if (problems.length > 0) {
    return {
      ok: false,
      problems,
      levels: [],
      replayed: { statuses: [], totalStars: 0, totalActionsUsed: 0 },
    };
  }

  const checks: ReplayLevelRecheck[] = [];
  let totalStars = 0;
  let totalActionsUsed = 0;
  for (const level of artifact.header.levels) {
    const context = { game: artifact.header.game, level };
    const reducer = resolveReducer(context);
    if (!reducer) {
      problems.push(
        `level ${level.index} (${level.id}): no reducer for `
        + `${artifact.header.game.adapter.id}@${artifact.header.game.adapter.version}`,
      );
      continue;
    }
    const actions = artifact.actions
      .filter((action) => action.levelIndex === level.index)
      .map(({ kind: _kind, levelIndex: _levelIndex, ...action }, index) => ({
        ...action,
        n: index,
      }));
    const result = recheckTranscript(
      reducer,
      {
        sessionId: artifact.header.sessionId,
        level: level.level,
        seed: level.seed,
        perm: artifact.header.perm,
        status: level.result.status,
        stars: level.result.stars,
        actionsUsed: level.result.actionsUsed,
        ...(artifact.header.visibility === undefined
          ? {}
          : { visibility: artifact.header.visibility }),
      },
      actions,
      options.optionsForLevel?.(context),
    );
    checks.push({ index: level.index, id: level.id, seed: level.seed, result });
    problems.push(...result.problems.map(
      (problem) => `level ${level.index} (${level.id}): ${problem}`,
    ));
    totalStars += result.replayed.status === 'won' ? (result.replayed.stars ?? 0) : 0;
    totalActionsUsed += result.replayed.actionsUsed;
  }

  if (checks.length === artifact.header.levels.length) {
    if (totalStars !== artifact.header.totals.totalStars) {
      problems.push(
        `totalStars: recorded ${artifact.header.totals.totalStars}, replayed ${totalStars}`,
      );
    }
    if (totalActionsUsed !== artifact.header.totals.totalActionsUsed) {
      problems.push(
        `totalActionsUsed: recorded ${artifact.header.totals.totalActionsUsed}, `
        + `replayed ${totalActionsUsed}`,
      );
    }
  }
  return {
    ok: problems.length === 0,
    problems,
    levels: checks,
    replayed: {
      statuses: checks.map(({ result }) => result.replayed.status),
      totalStars,
      totalActionsUsed,
    },
  };
}
