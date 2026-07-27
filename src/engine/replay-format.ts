import {
  assertJsonValue,
  canonicalJson,
  type JsonValue,
  type JsonObject,
} from '../protocol.js';
import {
  advanceTick,
  replayMetricsFor,
  type Reducer,
  type SessionView,
  type SubmittedAction,
} from './contracts.js';
import {
  COMMITMENT_SCHEME,
  createCommitmentHash,
  type CommitmentEnvelope,
  type RevealEnvelope,
} from './commitment.js';
import { createDmath, type Dmath } from './dmath.js';
import { locationKey } from './locations.js';
import {
  SUBMISSION_SIGNATURE_ALGORITHM,
  SUBMISSION_SIGNATURE_SCHEME,
  periodicSignaturePreimageV1,
  signatureBytesFromBase64,
  submissionChainHashV1,
  submissionGenesisHashV1,
  submissionPreimageV1,
  submissionRosterHashV1,
  verifyEd25519Base64,
  type SubmissionSeatKey,
  type SubmissionSignaturePolicy,
} from './submission-signatures.js';
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
/** Current schema version; adds replayable open-session termination. */
export const GAOS_REPLAY_FORMAT_VERSION = '1.3' as const;
/** Signed submission and per-seat audit-chain compatibility version. */
export const GAOS_REPLAY_SIGNED_FORMAT_VERSION = '1.2' as const;
/** Unsigned grouped/audit format accepted for migration compatibility. */
export const GAOS_REPLAY_UNSIGNED_FORMAT_VERSION = '1.1' as const;
/** Action-only compatibility version accepted by the parser and verifier. */
export const GAOS_REPLAY_LEGACY_FORMAT_VERSION = '1.0' as const;
export type ReplayFormatVersion =
  | typeof GAOS_REPLAY_LEGACY_FORMAT_VERSION
  | typeof GAOS_REPLAY_UNSIGNED_FORMAT_VERSION
  | typeof GAOS_REPLAY_SIGNED_FORMAT_VERSION
  | typeof GAOS_REPLAY_FORMAT_VERSION;
/** Media type used by downloads, object storage, and module manifests. */
export const GAOS_REPLAY_MIME = 'application/vnd.gaos.replay+jsonl' as const;
/** Conventional filename extension, without a leading dot. */
export const GAOS_REPLAY_EXTENSION = 'gaos-replay.jsonl' as const;
/** Seed policy compatible with `runLevelSeed`. */
export const GAOS_REPLAY_DERIVED_SEEDS = 'gaos.run-level-seed.v1' as const;
/** Fixed reference used by v1.2 timeout records for the header policy. */
export const GAOS_TIMEOUT_POLICY_REF = 'header.timeoutPolicy' as const;

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

export interface ReplayTickTimeoutPolicy {
  mode: 'ticks';
  windowTicks: number;
}

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
  status: 'won' | 'failed' | 'ended';
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

/** v1.1 reservation shape; v1.2 requires every RFC-010 field. */
export interface ReplaySeatIntegrityReservation {
  id: string;
  publicKey?: string;
  alg?: string;
  signingTier?: { N: number };
}

/** First line of a GAOS replay JSONL artifact. */
export interface ReplayHeader<TLevel> {
  kind: 'header';
  format: typeof GAOS_REPLAY_FORMAT_ID;
  formatVersion: ReplayFormatVersion;
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
  /** RFC-010 key roster; opaque reservation only when reading v1.1. */
  seatKeys?: ReadonlyArray<ReplaySeatIntegrityReservation | SubmissionSeatKey>;
  /** RFC-010 construction policy; opaque reservation only when reading v1.1. */
  signaturePolicy?: JsonObject | SubmissionSignaturePolicy;
  /** Opaque in v1.1; v1.2 assigns tick-bounded timeout semantics. */
  timeoutPolicy?: JsonObject | ReplayTickTimeoutPolicy;
  /** Host, creator, agent, signing, or benchmark metadata. */
  extensions?: JsonObject;
}

/** Every line after the header is one canonical reducer input delta. */
export interface ReplayAction extends TranscriptAction {
  kind: 'action';
  levelIndex: number;
  /** Advisory host UTC milliseconds; ignored by replay verification. */
  hostTime?: number;
  /** RFC-010 reservations; ignored by the v1.1 verifier. */
  submissionId?: string;
  canonicalCommand?: string;
  cursor?: number;
  clientTime?: number;
  prevChainHash?: string;
  sig?: string;
  commit?: CommitmentEnvelope;
  reveal?: RevealEnvelope;
  /** Present only after a reveal has passed commitment verification. */
  verifiedPayload?: JsonValue;
}

export type ReplayResolutionInput = Omit<
  ReplayAction,
  'kind' | 'n' | 'levelIndex' | 'tick'
>;

/** One reducer call. Inputs are consumed atomically in their recorded order. */
export interface ReplayResolution {
  kind: 'resolution';
  n: number;
  levelIndex: number;
  tick: number;
  inputs: ReplayResolutionInput[];
  cause: 'complete' | 'timeout' | 'tick';
  /** Advisory host UTC milliseconds; ignored by replay verification. */
  hostTime?: number;
  /** Exact canonical timeout/pass action when the host supplied one. */
  systemInput?: ReplayResolutionInput;
}

export interface ReplayTimeout {
  kind: 'timeout';
  n: number;
  levelIndex: number;
  tick: number;
  timeoutId: string;
  windowRef: number;
  participantId: string | null;
  reason: string;
  /** v1.2 uses the fixed `header.timeoutPolicy` reference. */
  timeoutPolicyRef?: string;
  /** Advisory host UTC milliseconds; ignored by replay verification. */
  hostTime?: number;
}

export interface ReplayExtension {
  kind: 'extension';
  n: number;
  levelIndex: number;
  lane: string;
  record: JsonObject;
  /** Advisory host UTC milliseconds; ignored by replay verification. */
  hostTime?: number;
}

export interface ReplayInterest {
  kind: 'interest';
  n: number;
  levelIndex: number;
  tick: number;
  cursor: number;
  participantId: string;
  submissionId: string;
  scopeId: string;
  declaration: JsonValue;
  canonicalCommand: string;
  clientTime?: number;
  prevChainHash?: string;
  sig?: string;
  hostTime?: number;
}

export interface ReplayCheckpoint {
  kind: 'checkpoint';
  n: number;
  levelIndex: number;
  tick: number;
  /** Diagnostic FNV-1a digest, not an authentication primitive. */
  digest: number;
  /** Advisory host UTC milliseconds; ignored by replay verification. */
  hostTime?: number;
}

export interface ReplayCommitMismatchAudit {
  kind: 'commit-mismatch';
  n: number;
  levelIndex: number;
  tick: number;
  participantId: string;
  submissionId: string;
  commitmentId: number;
  scheme: typeof COMMITMENT_SCHEME;
  /** RFC-010 reservations; ignored by the v1.1 verifier. */
  canonicalCommand?: string;
  cursor?: number;
  clientTime?: number;
  prevChainHash?: string;
  sig?: string;
  /** Advisory host UTC milliseconds; ignored by replay verification. */
  hostTime?: number;
  attemptedReveal?: {
    salt: string;
    payload: JsonValue;
  };
}

/**
 * RFC-010 tier-3 carrier reservation. v1.1 preserves this record but assigns
 * no cryptographic or chain semantics to it.
 */
export interface ReplaySeatSignatureReservation {
  kind: 'seat-signature';
  n: number;
  levelIndex: number;
  tick: number;
  participantId: string;
  clientTime?: number;
  prevChainHash?: string;
  sig?: string;
  hostTime?: number;
}

export type ReplayRecord =
  | ReplayAction
  | ReplayResolution
  | ReplayTimeout
  | ReplayExtension
  | ReplayInterest
  | ReplayCheckpoint
  | ReplayCommitMismatchAudit
  | ReplaySeatSignatureReservation;

export interface ReplayArtifact<TLevel> {
  header: ReplayHeader<TLevel>;
  /** Compatibility projection for action-oriented v1.0 consumers. */
  actions: ReplayAction[];
  /** Ordered v1.1+ record stream. Absent on parsed v1.0/action-only artifacts. */
  records?: ReplayRecord[];
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
  hostTime?: number;
  submissionId?: string;
  canonicalCommand?: string;
  cursor?: number;
  clientTime?: number;
  prevChainHash?: string;
  sig?: string;
  commit?: CommitmentEnvelope;
  reveal?: RevealEnvelope;
  verifiedPayload?: JsonValue;
}

export interface CreateReplayArtifactInput<TLevel> {
  sessionId: string;
  game: ReplayGameRef;
  seed: number;
  seedPolicy?: ReplaySeedPolicy;
  perm: number[];
  levels: Array<ReplayLevelInput<TLevel>>;
  actions?: ReplayActionInput[];
  /** Supplying records opts into the v1.1+ grouped/audit transport. */
  records?: ReplayRecord[];
  totals?: ReplayTotals;
  visibility?: TranscriptVisibility;
  seatKeys?: readonly ReplaySeatIntegrityReservation[];
  signaturePolicy?: JsonObject | SubmissionSignaturePolicy;
  timeoutPolicy?: JsonObject | ReplayTickTimeoutPolicy;
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
  /** Constructed from the authoritative replay algorithm declaration. */
  dmath?: Dmath;
}

export interface ReplaySubmissionContext {
  sessionId: string;
  tick: number;
  cursor: number;
  participantId: string;
  submissionId: string;
}

export interface ReplayTimeoutContext<TLevel> {
  sessionId: string;
  game: ReplayGameRef;
  levelId: string;
  levelVersion?: string | number;
  level: TLevel;
  seed: number;
  participantId: string | null;
  windowRef: number;
}

export interface ReplaySemanticAdapter<TLevel> {
  commandToAction?: (
    command: JsonValue,
    context: ReplaySubmissionContext,
  ) => SubmittedAction;
  timeoutToAction?: (
    context: ReplayTimeoutContext<TLevel>,
    timeout: ReplayTimeout,
  ) => SubmittedAction;
}

export type ReplayReducerResolver<
  TLevel,
  TState,
  TView extends SessionView,
> = (context: ReplayReducerContext<TLevel>) => Reducer<TLevel, TState, TView> | undefined;

export interface ReplayArtifactRecheckOptions<TLevel, TState> {
  optionsForLevel?: (
    context: ReplayReducerContext<TLevel>,
  ) => RecheckOptions<TState> | undefined;
  /**
   * Historical pure adapter functions. A signed artifact is only `trusted`
   * when every applicable submission and timeout action is independently
   * reconstructed through these functions.
   */
  semanticAdapterForLevel?: (
    context: ReplayReducerContext<TLevel>,
  ) => ReplaySemanticAdapter<TLevel> | undefined;
}

export interface ReplayLevelRecheck {
  index: number;
  id: string;
  seed: number;
  result: RecheckResult;
}

export type ReplaySignatureState = 'signed' | 'partial' | 'unsigned';
export type ReplayVerificationVerdict = 'trusted' | 'unverifiable' | 'rejected';

export interface ReplaySeatSignatureCheck {
  seat: string;
  submissions: number;
  validSignatures: number;
  chainReproduced: boolean;
  policySatisfied: boolean;
  chainHead: string;
}

export interface ReplaySignatureCheck {
  state: ReplaySignatureState;
  problems: string[];
  seats: ReplaySeatSignatureCheck[];
}

export type ReplaySemanticState =
  | 'verified'
  | 'unavailable'
  | 'not_applicable'
  | 'failed';

export interface ReplaySemanticCheck {
  submissions: ReplaySemanticState;
  timeouts: ReplaySemanticState;
  problems: string[];
}

export interface ReplayArtifactRecheckResult {
  ok: boolean;
  /** Adoption-level verdict; policy can require `trusted` for scored runs. */
  verdict: ReplayVerificationVerdict;
  /** Signature and chain facts remain orthogonal to deterministic replay `ok`. */
  signatures: ReplaySignatureCheck;
  /** Independent reconstruction of signed commands and host timeout actions. */
  semantics: ReplaySemanticCheck;
  problems: string[];
  /** Non-fatal audit limitations and security hygiene warnings. */
  diagnostics: string[];
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

function projectRecordActions(stream: readonly unknown[]): ReplayAction[] {
  const projected: ReplayAction[] = [];
  for (const record of stream) {
    if (isRecord(record) && record['kind'] === 'action') {
      projected.push(record as unknown as ReplayAction);
    } else if (isRecord(record)
      && record['kind'] === 'resolution'
      && Array.isArray(record['inputs'])) {
      for (const input of record['inputs']) {
        if (!isRecord(input)) continue;
        projected.push({
          ...input,
          kind: 'action',
          n: projected.length,
          levelIndex: record['levelIndex'] as number,
          tick: record['tick'] as number,
        } as unknown as ReplayAction);
      }
    }
  }
  return projected.map((action, index) => ({ ...action, n: index }));
}

function rejectUnknownProperties(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  problems: string[],
): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) problems.push(`${label} has unknown property ${key}`);
  }
}

function validU32(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
}

function validNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isGroupedReplayVersion(value: unknown): boolean {
  return value === GAOS_REPLAY_UNSIGNED_FORMAT_VERSION
    || value === GAOS_REPLAY_SIGNED_FORMAT_VERSION
    || value === GAOS_REPLAY_FORMAT_VERSION;
}

function hasV12IntegritySemantics(value: unknown): boolean {
  return value === GAOS_REPLAY_SIGNED_FORMAT_VERSION
    || value === GAOS_REPLAY_FORMAT_VERSION;
}

function validateV12IntegrityFields(
  candidate: Record<string, unknown>,
  label: string,
  problems: string[],
): void {
  const identity = [
    'submissionId',
    'canonicalCommand',
    'cursor',
  ] as const;
  const chain = [
    'clientTime',
    'prevChainHash',
  ] as const;
  const identityPresent = identity.filter((field) => candidate[field] !== undefined);
  const chainPresent = chain.filter((field) => candidate[field] !== undefined);
  if (identityPresent.length !== 0 && identityPresent.length !== identity.length) {
    problems.push(`${label} must carry every submission identity field or none`);
  }
  if (chainPresent.length !== 0 && chainPresent.length !== chain.length) {
    problems.push(`${label} must carry both clientTime and prevChainHash or neither`);
  }
  if (chainPresent.length !== 0 && identityPresent.length !== identity.length) {
    problems.push(`${label} chain fields require every submission identity field`);
  }
  if (candidate['sig'] !== undefined
    && (identityPresent.length !== identity.length || chainPresent.length !== chain.length)) {
    problems.push(`${label} sig requires every submission and chain field`);
  }
  if (identityPresent.length === identity.length) {
    if (typeof candidate['submissionId'] !== 'string'
      || candidate['submissionId'].length === 0) {
      problems.push(`${label} submissionId must be a non-empty string`);
    }
    if (!validNonNegativeInteger(candidate['cursor'])) {
      problems.push(`${label} cursor must be a non-negative safe integer`);
    }
    if (typeof candidate['canonicalCommand'] !== 'string') {
      problems.push(`${label} canonicalCommand must be canonical JSON text`);
    } else {
      try {
        if (canonicalJson(JSON.parse(candidate['canonicalCommand'])) !== candidate['canonicalCommand']) {
          problems.push(`${label} canonicalCommand must use canonical JSON bytes`);
        }
      } catch {
        problems.push(`${label} canonicalCommand must be valid canonical JSON`);
      }
    }
  }
  if (chainPresent.length === chain.length) {
    if (!validNonNegativeInteger(candidate['clientTime'])) {
      problems.push(`${label} clientTime must be a non-negative safe integer`);
    }
    try {
      signatureBytesFromBase64(
        candidate['prevChainHash'] as string,
        `${label} prevChainHash`,
        32,
      );
    } catch (error) {
      problems.push(error instanceof Error ? error.message : `${label} prevChainHash is invalid`);
    }
  }
  if (candidate['sig'] !== undefined) {
    try {
      signatureBytesFromBase64(candidate['sig'] as string, `${label} sig`, 64);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : `${label} sig is invalid`);
    }
  }
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
    ...(input.seatKeys === undefined ? {} : { seatKeys: structuredClone(input.seatKeys) }),
    ...(input.signaturePolicy === undefined
      ? {}
      : { signaturePolicy: structuredClone(input.signaturePolicy) }),
    ...(input.timeoutPolicy === undefined
      ? {}
      : { timeoutPolicy: structuredClone(input.timeoutPolicy) }),
    ...(input.extensions === undefined ? {} : { extensions: input.extensions }),
  };
  const artifact: ReplayArtifact<TLevel> = {
    header,
    actions: (input.actions ?? []).map((action) => ({ ...action, kind: 'action' })),
    ...(input.records === undefined
      ? {}
      : { records: input.records.map((record) => structuredClone(record)) }),
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
  rejectUnknownProperties(value, ['header', 'actions', 'records'], 'artifact', problems);
  const header = value['header'];
  const actions = value['actions'];
  if (!isRecord(header)) return ['header must be an object'];
  rejectUnknownProperties(header, [
    'kind',
    'format',
    'formatVersion',
    'sessionId',
    'game',
    'seed',
    'seedPolicy',
    'perm',
    'levels',
    'totals',
    'visibility',
    'seatKeys',
    'signaturePolicy',
    'timeoutPolicy',
    'extensions',
  ], 'header', problems);
  if (header['kind'] !== 'header') problems.push('header.kind must be header');
  if (header['format'] !== GAOS_REPLAY_FORMAT_ID) {
    problems.push(`header.format must be ${GAOS_REPLAY_FORMAT_ID}`);
  }
  if (header['formatVersion'] !== GAOS_REPLAY_FORMAT_VERSION
    && header['formatVersion'] !== GAOS_REPLAY_SIGNED_FORMAT_VERSION
    && header['formatVersion'] !== GAOS_REPLAY_UNSIGNED_FORMAT_VERSION
    && header['formatVersion'] !== GAOS_REPLAY_LEGACY_FORMAT_VERSION) {
    problems.push(
      `header.formatVersion must be ${GAOS_REPLAY_LEGACY_FORMAT_VERSION}`
      + `, ${GAOS_REPLAY_UNSIGNED_FORMAT_VERSION}, `
      + `${GAOS_REPLAY_SIGNED_FORMAT_VERSION}, or ${GAOS_REPLAY_FORMAT_VERSION}`,
    );
  }
  if (header['formatVersion'] === GAOS_REPLAY_LEGACY_FORMAT_VERSION
    && (header['seatKeys'] !== undefined
      || header['signaturePolicy'] !== undefined
      || header['timeoutPolicy'] !== undefined)) {
    problems.push('header integrity reservations require formatVersion 1.1');
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
  for (const field of ['signaturePolicy', 'timeoutPolicy', 'extensions'] as const) {
    if (header[field] !== undefined && !isRecord(header[field])) {
      problems.push(`header.${field} must be an object`);
    }
  }
  if (hasV12IntegritySemantics(header['formatVersion'])) {
    const hasRoster = header['seatKeys'] !== undefined;
    const hasPolicy = header['signaturePolicy'] !== undefined;
    if (hasRoster !== hasPolicy) {
      problems.push('v1.2+ seatKeys and signaturePolicy must be declared together');
    }
    if (hasPolicy) {
      const policy = header['signaturePolicy'];
      if (!isRecord(policy)) {
        problems.push('header.signaturePolicy must be an object');
      } else {
        rejectUnknownProperties(policy, ['scheme'], 'header.signaturePolicy', problems);
        if (policy['scheme'] !== SUBMISSION_SIGNATURE_SCHEME) {
          problems.push(
            `header.signaturePolicy.scheme must be ${SUBMISSION_SIGNATURE_SCHEME}`,
          );
        }
      }
    }
    if (hasRoster) {
      if (!Array.isArray(header['seatKeys']) || header['seatKeys'].length === 0) {
        problems.push('header.seatKeys must be a non-empty array');
      } else {
        try {
          submissionRosterHashV1(header['seatKeys'] as SubmissionSeatKey[]);
        } catch (error) {
          problems.push(
            `header.seatKeys is invalid: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
    const timeoutPolicy = header['timeoutPolicy'];
    if (timeoutPolicy !== undefined) {
      if (!isRecord(timeoutPolicy)) {
        problems.push('header.timeoutPolicy must be an object');
      } else {
        rejectUnknownProperties(
          timeoutPolicy,
          ['mode', 'windowTicks'],
          'header.timeoutPolicy',
          problems,
        );
        if (timeoutPolicy['mode'] !== 'ticks') {
          problems.push('header.timeoutPolicy.mode must be ticks');
        }
        if (!validNonNegativeInteger(timeoutPolicy['windowTicks'])
          || timeoutPolicy['windowTicks'] === 0) {
          problems.push('header.timeoutPolicy.windowTicks must be a positive safe integer');
        }
      }
    }
  }

  const game = header['game'];
  if (!isRecord(game)) {
    problems.push('header.game must be an object');
  } else {
    rejectUnknownProperties(game, ['id', 'version', 'adapter'], 'header.game', problems);
    for (const field of ['id', 'version'] as const) {
      if (typeof game[field] !== 'string' || game[field].length === 0) {
        problems.push(`header.game.${field} must be a non-empty string`);
      }
    }
    const adapter = game['adapter'];
    if (!isRecord(adapter)) {
      problems.push('header.game.adapter must be an object');
    } else {
      rejectUnknownProperties(adapter, ['id', 'version'], 'header.game.adapter', problems);
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
      rejectUnknownProperties(candidate, [
        'index',
        'id',
        'version',
        'seed',
        'level',
        'result',
        'extensions',
      ], `level ${index}`, problems);
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
      if (candidate['extensions'] !== undefined && !isRecord(candidate['extensions'])) {
        problems.push(`level ${index} extensions must be an object`);
      }
      const result = candidate['result'];
      if (!isRecord(result)) {
        problems.push(`level ${index} result must be an object`);
      } else {
        rejectUnknownProperties(
          result,
          ['status', 'stars', 'actionsUsed', 'extensions'],
          `level ${index} result`,
          problems,
        );
        if (result['status'] !== 'won'
          && result['status'] !== 'failed'
          && (header['formatVersion'] !== GAOS_REPLAY_FORMAT_VERSION
            || result['status'] !== 'ended')) {
          problems.push(
            `level ${index} result.status must be won or failed`
            + (header['formatVersion'] === GAOS_REPLAY_FORMAT_VERSION ? ' or ended' : ''),
          );
        }
        if (result['stars'] !== null
          && (typeof result['stars'] !== 'number' || !Number.isFinite(result['stars']))) {
          problems.push(`level ${index} result.stars must be a finite number or null`);
        }
        if (result['status'] === 'ended' && result['stars'] !== null) {
          problems.push(`level ${index} ended result.stars must be null`);
        }
        if (!validNonNegativeInteger(result['actionsUsed'])) {
          problems.push(`level ${index} result.actionsUsed must be a non-negative safe integer`);
        }
        if (result['extensions'] !== undefined && !isRecord(result['extensions'])) {
          problems.push(`level ${index} result.extensions must be an object`);
        }
      }
    }
  }

  const totals = header['totals'];
  if (!isRecord(totals)) {
    problems.push('header.totals must be an object');
  } else {
    rejectUnknownProperties(
      totals,
      ['totalStars', 'totalActionsUsed', 'extensions'],
      'header.totals',
      problems,
    );
    if (typeof totals['totalStars'] !== 'number' || !Number.isFinite(totals['totalStars'])) {
      problems.push('header.totals.totalStars must be a finite number');
    }
    if (!validNonNegativeInteger(totals['totalActionsUsed'])) {
      problems.push('header.totals.totalActionsUsed must be a non-negative safe integer');
    }
    if (totals['extensions'] !== undefined && !isRecord(totals['extensions'])) {
      problems.push('header.totals.extensions must be an object');
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
      rejectUnknownProperties(action, [
        'kind',
        'n',
        'levelIndex',
        'wireId',
        'canonicalId',
        'payload',
        'x',
        'y',
        'index',
        'boardId',
        'zoneId',
        'seat',
        'targets',
        'tick',
        'hostTime',
        'submissionId',
        'canonicalCommand',
        'cursor',
        'clientTime',
        'prevChainHash',
        'sig',
        'commit',
        'reveal',
        'verifiedPayload',
      ], `action ${String(action['n'])}`, problems);
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
      for (const field of ['hostTime', 'clientTime'] as const) {
        if (action[field] !== undefined && !validNonNegativeInteger(action[field])) {
          problems.push(
            `action ${String(action['n'])} ${field} must be a non-negative safe integer`,
          );
        }
      }
      if (hasV12IntegritySemantics(header['formatVersion'])) {
        validateV12IntegrityFields(action, `action ${String(action['n'])}`, problems);
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
              if (isRecord(target)) {
                rejectUnknownProperties(
                  target,
                  ['container', 'coord'],
                  `action ${String(action['n'])} target ${targetIndex}`,
                  problems,
                );
              }
              locationKey(target as never);
            } catch {
              problems.push(`action ${String(action['n'])} target ${targetIndex} is invalid`);
            }
          }
        }
      }
      if (action['commit'] !== undefined && action['reveal'] !== undefined) {
        problems.push(`action ${String(action['n'])} commit and reveal are mutually exclusive`);
      }
      if (action['verifiedPayload'] !== undefined && action['reveal'] === undefined) {
        problems.push(`action ${String(action['n'])} verifiedPayload requires reveal`);
      }
      if (header['formatVersion'] === GAOS_REPLAY_LEGACY_FORMAT_VERSION
        && (action['commit'] !== undefined
          || action['reveal'] !== undefined
          || action['verifiedPayload'] !== undefined
          || action['submissionId'] !== undefined
          || action['canonicalCommand'] !== undefined
          || action['cursor'] !== undefined
          || action['clientTime'] !== undefined
          || action['hostTime'] !== undefined
          || action['prevChainHash'] !== undefined
          || action['sig'] !== undefined)) {
        problems.push(
          `action ${String(action['n'])} v1.1 fields require formatVersion 1.1`,
        );
      }
      if (action['commit'] !== undefined) {
        const commit = action['commit'];
        if (!isRecord(commit)) {
          problems.push(`action ${String(action['n'])} commit must be an object`);
        } else {
          rejectUnknownProperties(
            commit,
            ['commitmentId', 'scheme', 'hash'],
            `action ${String(action['n'])} commit`,
            problems,
          );
          if (!validU32(commit['commitmentId'])) {
            problems.push(`action ${String(action['n'])} commitmentId must be an unsigned 32-bit integer`);
          }
          if (commit['scheme'] !== COMMITMENT_SCHEME) {
            problems.push(`action ${String(action['n'])} commit scheme must be ${COMMITMENT_SCHEME}`);
          }
          if (typeof commit['hash'] !== 'string' || !/^[0-9a-f]{64}$/.test(commit['hash'])) {
            problems.push(`action ${String(action['n'])} commit hash must be 64 lowercase hex characters`);
          }
        }
      }
      if (action['reveal'] !== undefined) {
        const reveal = action['reveal'];
        if (!isRecord(reveal)) {
          problems.push(`action ${String(action['n'])} reveal must be an object`);
        } else {
          rejectUnknownProperties(
            reveal,
            ['commitmentId', 'salt', 'payload'],
            `action ${String(action['n'])} reveal`,
            problems,
          );
          if (!validU32(reveal['commitmentId'])) {
            problems.push(`action ${String(action['n'])} reveal commitmentId must be an unsigned 32-bit integer`);
          }
          if (typeof reveal['salt'] !== 'string'
            || !/^(?:[0-9a-f]{2}){16,64}$/.test(reveal['salt'])) {
            problems.push(`action ${String(action['n'])} reveal salt must be 16..64 lowercase-hex bytes`);
          }
          if (!Object.hasOwn(reveal, 'payload')) {
            problems.push(`action ${String(action['n'])} reveal must include payload`);
          }
        }
      }
    }
  }

  const records = value['records'];
  if (records !== undefined) {
    if (!isGroupedReplayVersion(header['formatVersion'])) {
      problems.push(
        `records require header.formatVersion ${GAOS_REPLAY_UNSIGNED_FORMAT_VERSION}`
        + `, ${GAOS_REPLAY_SIGNED_FORMAT_VERSION}, or ${GAOS_REPLAY_FORMAT_VERSION}`,
      );
    }
    if (!Array.isArray(records)) {
      problems.push('records must be an array');
    } else {
      let previousLevelIndex = -1;
      const recordTicks = new Map<number, number>();
      const permutation = validatePermutation(header['perm']) ? header['perm'] as number[] : [];
      const validateResolutionInput = (
        candidate: unknown,
        label: string,
        actionRecord = false,
      ): void => {
        if (!isRecord(candidate)) {
          problems.push(`${label} must be an object`);
          return;
        }
        rejectUnknownProperties(candidate, [
          ...(actionRecord ? ['kind', 'n', 'levelIndex', 'tick'] : []),
          'wireId',
          'canonicalId',
          'payload',
          'x',
          'y',
          'index',
          'boardId',
          'zoneId',
          'seat',
          'targets',
          'commit',
          'reveal',
          'verifiedPayload',
          'submissionId',
          'canonicalCommand',
          'cursor',
          'clientTime',
          'prevChainHash',
          'sig',
        ], label, problems);
        const indexes: Record<'wireId' | 'canonicalId', number | undefined> = {
          wireId: undefined,
          canonicalId: undefined,
        };
        for (const field of ['wireId', 'canonicalId'] as const) {
          const id = candidate[field];
          const match = typeof id === 'string' ? /^Action ([1-9]\d*)$/.exec(id) : null;
          const number = match ? Number(match[1]) : Number.NaN;
          if (!Number.isSafeInteger(number) || number < 1 || number > permutation.length) {
            problems.push(`${label} ${field} must be within Action 1..${permutation.length}`);
          } else {
            indexes[field] = number - 1;
          }
        }
        if (indexes.wireId !== undefined
          && indexes.canonicalId !== undefined
          && permutation[indexes.wireId] !== indexes.canonicalId) {
          problems.push(`${label} action ids contradict the replay permutation`);
        }
        for (const field of ['x', 'y', 'index'] as const) {
          if (candidate[field] !== undefined && !Number.isSafeInteger(candidate[field])) {
            problems.push(`${label} ${field} must be a safe integer`);
          }
        }
        for (const field of ['clientTime', ...(actionRecord ? ['hostTime'] : [])]) {
          if (candidate[field] !== undefined
            && !validNonNegativeInteger(candidate[field])) {
            problems.push(`${label} ${field} must be a non-negative safe integer`);
          }
        }
        if (hasV12IntegritySemantics(header['formatVersion'])) {
          validateV12IntegrityFields(candidate, label, problems);
        }
        for (const field of ['boardId', 'zoneId', 'seat'] as const) {
          if (candidate[field] !== undefined
            && (typeof candidate[field] !== 'string' || candidate[field].length === 0)) {
            problems.push(`${label} ${field} must be a non-empty string`);
          }
        }
        if (candidate['commit'] !== undefined && candidate['reveal'] !== undefined) {
          problems.push(`${label} commit and reveal are mutually exclusive`);
        }
        if (candidate['verifiedPayload'] !== undefined && candidate['reveal'] === undefined) {
          problems.push(`${label} verifiedPayload requires reveal`);
        }
        const commit = candidate['commit'];
        if (isRecord(commit)) {
          rejectUnknownProperties(
            commit,
            ['commitmentId', 'scheme', 'hash'],
            `${label} commit`,
            problems,
          );
        }
        if (candidate['targets'] !== undefined) {
          if (!Array.isArray(candidate['targets'])) {
            problems.push(`${label} targets must be an array`);
          } else {
            for (const [targetIndex, target] of candidate['targets'].entries()) {
              if (isRecord(target)) {
                rejectUnknownProperties(
                  target,
                  ['container', 'coord'],
                  `${label} target ${targetIndex}`,
                  problems,
                );
              }
              try {
                locationKey(target as never);
              } catch {
                problems.push(`${label} target ${targetIndex} is invalid`);
              }
            }
          }
        }
        if (commit !== undefined && (!isRecord(commit)
          || !validU32(commit['commitmentId'])
          || commit['scheme'] !== COMMITMENT_SCHEME
          || typeof commit['hash'] !== 'string'
          || !/^[0-9a-f]{64}$/.test(commit['hash']))) {
          problems.push(`${label} has an invalid commitment envelope`);
        }
        const reveal = candidate['reveal'];
        if (isRecord(reveal)) {
          rejectUnknownProperties(
            reveal,
            ['commitmentId', 'salt', 'payload'],
            `${label} reveal`,
            problems,
          );
        }
        if (reveal !== undefined && (!isRecord(reveal)
          || !validU32(reveal['commitmentId'])
          || typeof reveal['salt'] !== 'string'
          || !/^(?:[0-9a-f]{2}){16,64}$/.test(reveal['salt'])
          || !Object.hasOwn(reveal, 'payload'))) {
          problems.push(`${label} has an invalid reveal envelope`);
        }
      };
      for (const [index, record] of records.entries()) {
        if (!isRecord(record)) {
          problems.push(`record at index ${index} must be an object`);
          continue;
        }
        if (record['n'] !== index) {
          problems.push(`record at index ${index} must declare sequence number ${index}`);
        }
        if (!validNonNegativeInteger(record['levelIndex'])
          || !Array.isArray(levels)
          || record['levelIndex'] >= levels.length) {
          problems.push(`record ${index} has invalid levelIndex ${String(record['levelIndex'])}`);
        } else if (record['levelIndex'] < previousLevelIndex) {
          problems.push(`record ${index} returns to an earlier level`);
        } else {
          previousLevelIndex = record['levelIndex'];
        }
        const kind = record['kind'];
        for (const field of ['hostTime', 'clientTime'] as const) {
          if (record[field] !== undefined && !validNonNegativeInteger(record[field])) {
            problems.push(
              `record ${index} ${field} must be a non-negative safe integer`,
            );
          }
        }
        if (![
          'action',
          'resolution',
          'timeout',
          'extension',
          'interest',
          'checkpoint',
          'commit-mismatch',
          'seat-signature',
        ].includes(
          typeof kind === 'string' ? kind : '',
        )) {
          problems.push(`record ${index} has unknown kind ${String(kind)}`);
          continue;
        }
        const common = ['kind', 'n', 'levelIndex', 'hostTime'];
        const allowedByKind: Record<string, string[]> = {
          action: [
            ...common,
            'wireId',
            'canonicalId',
            'payload',
            'x',
            'y',
            'index',
            'boardId',
            'zoneId',
            'seat',
            'targets',
            'tick',
            'hostTime',
            'commit',
            'reveal',
            'verifiedPayload',
            'submissionId',
            'canonicalCommand',
            'cursor',
            'clientTime',
            'prevChainHash',
            'sig',
          ],
          resolution: [...common, 'tick', 'inputs', 'cause', 'systemInput'],
          timeout: [
            ...common,
            'tick',
            'timeoutId',
            'windowRef',
            'participantId',
            'reason',
            'timeoutPolicyRef',
          ],
          extension: [...common, 'lane', 'record'],
          interest: [
            ...common,
            'tick',
            'cursor',
            'participantId',
            'submissionId',
            'scopeId',
            'declaration',
            'canonicalCommand',
            'clientTime',
            'prevChainHash',
            'sig',
          ],
          checkpoint: [...common, 'tick', 'digest'],
          'commit-mismatch': [
            ...common,
            'tick',
            'participantId',
            'submissionId',
            'commitmentId',
            'scheme',
            'attemptedReveal',
            'canonicalCommand',
            'cursor',
            'clientTime',
            'prevChainHash',
            'sig',
          ],
          'seat-signature': [
            ...common,
            'tick',
            'participantId',
            'clientTime',
            'prevChainHash',
            'sig',
          ],
        };
        if (kind !== 'action') {
          rejectUnknownProperties(
            record,
            allowedByKind[kind as string]!,
            `record ${index}`,
            problems,
          );
        }
        if (kind === 'action') {
          validateResolutionInput(record, `record ${index} action`, true);
        } else if (kind === 'resolution') {
          if (!validNonNegativeInteger(record['tick'])) {
            problems.push(`resolution ${index} tick must be a non-negative safe integer`);
          }
          if (!Array.isArray(record['inputs'])) {
            problems.push(`resolution ${index} inputs must be an array`);
          } else {
            record['inputs'].forEach((input, inputIndex) => {
              validateResolutionInput(input, `resolution ${index} input ${inputIndex}`);
            });
          }
          if (!['complete', 'timeout', 'tick'].includes(String(record['cause']))) {
            problems.push(`resolution ${index} cause must be complete, timeout, or tick`);
          }
          if (record['cause'] === 'timeout') {
            if (record['systemInput'] === undefined) {
              problems.push(`resolution ${index} timeout cause requires systemInput`);
            } else {
              validateResolutionInput(record['systemInput'], `resolution ${index} systemInput`);
              if (Array.isArray(record['inputs'])) {
                try {
                  const canonicalSystemInput = canonicalJson(record['systemInput']);
                  if (!record['inputs'].some(
                    (input) => canonicalJson(input) === canonicalSystemInput,
                  )) {
                    problems.push(`resolution ${index} systemInput must appear in inputs`);
                  }
                } catch {
                  problems.push(`resolution ${index} systemInput must contain plain JSON`);
                }
              }
            }
          } else if (record['systemInput'] !== undefined) {
            problems.push(`resolution ${index} systemInput requires timeout cause`);
          }
          if (validNonNegativeInteger(record['levelIndex'])
            && validNonNegativeInteger(record['tick'])) {
            const lastTick = recordTicks.get(record['levelIndex']) ?? 0;
            if (record['tick'] < lastTick) {
              problems.push(`resolution ${index} tick precedes its level's prior record`);
            } else {
              recordTicks.set(record['levelIndex'], record['tick']);
            }
          }
        } else if (kind === 'timeout') {
          if (!validNonNegativeInteger(record['tick'])) {
            problems.push(`timeout ${index} tick must be a non-negative safe integer`);
          }
          if (typeof record['reason'] !== 'string' || record['reason'].length === 0) {
            problems.push(`timeout ${index} reason must be a non-empty string`);
          }
          if (typeof record['timeoutId'] !== 'string' || record['timeoutId'].length === 0) {
            problems.push(`timeout ${index} timeoutId must be a non-empty string`);
          }
          if (!validNonNegativeInteger(record['windowRef'])) {
            problems.push(`timeout ${index} windowRef must be a non-negative safe integer`);
          }
          if (record['participantId'] !== null
            && (typeof record['participantId'] !== 'string'
              || record['participantId'].length === 0)) {
            problems.push(`timeout ${index} participantId must be null or a non-empty string`);
          }
          if (record['timeoutPolicyRef'] !== undefined
            && (typeof record['timeoutPolicyRef'] !== 'string'
              || record['timeoutPolicyRef'].length === 0)) {
            problems.push(`timeout ${index} timeoutPolicyRef must be a non-empty string`);
          }
          if (hasV12IntegritySemantics(header['formatVersion'])) {
            const timeoutPolicy = header['timeoutPolicy'];
            if (timeoutPolicy === undefined) {
              if (record['timeoutPolicyRef'] !== undefined) {
                problems.push(
                  `timeout ${index} timeoutPolicyRef requires header.timeoutPolicy`,
                );
              }
            } else if (record['timeoutPolicyRef'] !== GAOS_TIMEOUT_POLICY_REF) {
              problems.push(
                `timeout ${index} timeoutPolicyRef must be ${GAOS_TIMEOUT_POLICY_REF}`,
              );
            } else if (isRecord(timeoutPolicy)
              && validNonNegativeInteger(timeoutPolicy['windowTicks'])
              && validNonNegativeInteger(record['tick'])
              && validNonNegativeInteger(record['windowRef'])
              && record['tick'] !== record['windowRef'] + timeoutPolicy['windowTicks']) {
              problems.push(
                `timeout ${index} tick must equal windowRef + windowTicks`,
              );
            }
          }
        } else if (kind === 'extension') {
          if (typeof record['lane'] !== 'string' || record['lane'].length === 0) {
            problems.push(`extension ${index} lane must be a non-empty string`);
          }
          if (!isRecord(record['record'])) {
            problems.push(`extension ${index} record must be an object`);
          }
        } else if (kind === 'interest') {
          if (!hasV12IntegritySemantics(header['formatVersion'])) {
            problems.push(
              `interest ${index} requires formatVersion `
              + `${GAOS_REPLAY_SIGNED_FORMAT_VERSION} or ${GAOS_REPLAY_FORMAT_VERSION}`,
            );
          }
          validateV12IntegrityFields(record, `interest ${index}`, problems);
          if (record['clientTime'] === undefined
            || record['prevChainHash'] === undefined
            || record['sig'] === undefined) {
            problems.push(`interest ${index} requires clientTime, prevChainHash, and sig`);
          }
          if (!validNonNegativeInteger(record['tick'])
            || !validNonNegativeInteger(record['cursor'])) {
            problems.push(`interest ${index} tick and cursor must be non-negative safe integers`);
          }
          for (const field of ['participantId', 'submissionId', 'scopeId'] as const) {
            if (typeof record[field] !== 'string' || record[field].length === 0) {
              problems.push(`interest ${index} ${field} must be a non-empty string`);
            }
          }
          if (!Object.hasOwn(record, 'declaration')) {
            problems.push(`interest ${index} declaration is required`);
          } else {
            try {
              const expected = canonicalJson({
                kind: 'interest',
                scopeId: record['scopeId'] as string,
                declaration: record['declaration'] as JsonValue,
              });
              if (record['canonicalCommand'] !== expected) {
                problems.push(`interest ${index} canonicalCommand does not match declaration`);
              }
            } catch {
              problems.push(`interest ${index} declaration must contain plain JSON`);
            }
          }
        } else if (kind === 'checkpoint') {
          if (!validNonNegativeInteger(record['tick'])) {
            problems.push(`checkpoint ${index} tick must be a non-negative safe integer`);
          }
          if (!validU32(record['digest'])) {
            problems.push(`checkpoint ${index} digest must be an unsigned 32-bit integer`);
          }
        } else if (kind === 'commit-mismatch') {
          if (hasV12IntegritySemantics(header['formatVersion'])) {
            validateV12IntegrityFields(record, `commit-mismatch ${index}`, problems);
          }
          if (!validNonNegativeInteger(record['tick'])) {
            problems.push(`commit-mismatch ${index} tick must be a non-negative safe integer`);
          }
          if (!validU32(record['commitmentId'])) {
            problems.push(`commit-mismatch ${index} commitmentId must be an unsigned 32-bit integer`);
          }
          if (record['scheme'] !== COMMITMENT_SCHEME) {
            problems.push(`commit-mismatch ${index} scheme must be ${COMMITMENT_SCHEME}`);
          }
          if (typeof record['participantId'] !== 'string'
            || record['participantId'].length === 0
            || typeof record['submissionId'] !== 'string'
            || record['submissionId'].length === 0) {
            problems.push(`commit-mismatch ${index} participantId and submissionId are required`);
          }
          const attempt = record['attemptedReveal'];
          if (isRecord(attempt)) {
            rejectUnknownProperties(
              attempt,
              ['salt', 'payload'],
              `commit-mismatch ${index} attemptedReveal`,
              problems,
            );
          }
          if (attempt !== undefined && (!isRecord(attempt)
            || typeof attempt['salt'] !== 'string'
            || !/^(?:[0-9a-f]{2}){16,64}$/.test(attempt['salt'])
            || !Object.hasOwn(attempt, 'payload'))) {
            problems.push(`commit-mismatch ${index} attemptedReveal is invalid`);
          }
        } else if (kind === 'seat-signature') {
          if (!validNonNegativeInteger(record['tick'])) {
            problems.push(
              `seat-signature ${index} tick must be a non-negative safe integer`,
            );
          }
          if (typeof record['participantId'] !== 'string'
            || record['participantId'].length === 0) {
            problems.push(
              `seat-signature ${index} participantId must be a non-empty string`,
            );
          }
          if (hasV12IntegritySemantics(header['formatVersion'])) {
            if (!validNonNegativeInteger(record['clientTime'])) {
              problems.push(
                `seat-signature ${index} clientTime must be a non-negative safe integer`,
              );
            }
            try {
              signatureBytesFromBase64(
                record['prevChainHash'] as string,
                `seat-signature ${index} prevChainHash`,
                32,
              );
            } catch (error) {
              problems.push(
                error instanceof Error ? error.message : `seat-signature ${index} chain is invalid`,
              );
            }
            try {
              signatureBytesFromBase64(
                record['sig'] as string,
                `seat-signature ${index} sig`,
                64,
              );
            } catch (error) {
              problems.push(
                error instanceof Error ? error.message : `seat-signature ${index} sig is invalid`,
              );
            }
          }
        }
      }
      if (Array.isArray(actions)) {
        try {
          if (canonicalJson(projectRecordActions(records)) !== canonicalJson(actions)) {
            problems.push('actions must exactly match the projection of records');
          }
        } catch {
          problems.push('actions and records must contain only plain JSON');
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
  const stream = artifact.records ?? artifact.actions;
  return [artifact.header, ...stream].map(canonicalJson).join('\n') + '\n';
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
  const header = parsed[0];
  const stream = parsed.slice(1);
  const hasGroupedRecords = isRecord(header)
    && isGroupedReplayVersion(header['formatVersion'])
    && stream.some((record) => isRecord(record) && record['kind'] !== 'action');
  const projectedActions = projectRecordActions(stream);
  const artifact = {
    header,
    actions: hasGroupedRecords
      ? projectedActions
      : stream,
    ...(hasGroupedRecords ? { records: stream } : {}),
  };
  const problems = validateReplayArtifact(artifact);
  if (problems.length > 0) throw new ReplayFormatError(problems);
  return artifact as ReplayArtifact<TLevel>;
}

interface ReplaySubmissionForSignature {
  seat: string;
  levelIndex: number;
  tick: number;
  value:
    | ReplayResolutionInput
    | ReplayAction
    | ReplayCommitMismatchAudit
    | ReplayInterest;
  label: string;
  requiredTier?: 1 | 2;
}

function signatureSubmissions(artifact: ReplayArtifact<unknown>): Array<
  | { kind: 'submission'; submission: ReplaySubmissionForSignature }
  | { kind: 'periodic'; record: ReplaySeatSignatureReservation; label: string }
> {
  const result: Array<
    | { kind: 'submission'; submission: ReplaySubmissionForSignature }
    | { kind: 'periodic'; record: ReplaySeatSignatureReservation; label: string }
  > = [];
  const records = artifact.records ?? artifact.actions;
  for (const [recordIndex, record] of records.entries()) {
    if (record.kind === 'resolution') {
      for (const [inputIndex, input] of record.inputs.entries()) {
        if (typeof input.seat !== 'string' || input.submissionId === undefined) continue;
        result.push({
          kind: 'submission',
          submission: {
            seat: input.seat,
            levelIndex: record.levelIndex,
            tick: record.tick,
            value: input,
            label: `resolution ${record.n} input ${inputIndex}`,
            ...(input.commit !== undefined || input.reveal !== undefined
              ? { requiredTier: 1 as const }
              : {}),
          },
        });
      }
    } else if (record.kind === 'action'
      && typeof record.seat === 'string'
      && record.submissionId !== undefined) {
      result.push({
        kind: 'submission',
        submission: {
          seat: record.seat,
          levelIndex: record.levelIndex,
          tick: record.tick ?? 0,
          value: record,
          label: `action ${record.n}`,
          ...(record.commit !== undefined || record.reveal !== undefined
            ? { requiredTier: 1 as const }
            : {}),
        },
      });
    } else if (record.kind === 'commit-mismatch') {
      result.push({
        kind: 'submission',
        submission: {
          seat: record.participantId,
          levelIndex: record.levelIndex,
          tick: record.tick,
          value: record,
          label: `commit-mismatch ${record.n}`,
          requiredTier: 1,
        },
      });
    } else if (record.kind === 'interest') {
      result.push({
        kind: 'submission',
        submission: {
          seat: record.participantId,
          levelIndex: record.levelIndex,
          tick: record.tick,
          value: record,
          label: `interest ${record.n}`,
          requiredTier: 2,
        },
      });
    } else if (record.kind === 'seat-signature') {
      result.push({
        kind: 'periodic',
        record,
        label: `seat-signature ${record.n}`,
      });
    } else {
      void recordIndex;
    }
  }
  return result;
}

/**
 * Verify RFC-010 signatures and per-seat chains without invoking game code.
 * v1.0/v1.1 artifacts remain valid but are explicitly `unsigned`.
 */
export function recheckReplaySignatures(
  artifact: ReplayArtifact<unknown>,
): ReplaySignatureCheck {
  if (!hasV12IntegritySemantics(artifact.header.formatVersion)
    || artifact.header.seatKeys === undefined
    || artifact.header.signaturePolicy === undefined) {
    return { state: 'unsigned', problems: [], seats: [] };
  }
  const problems: string[] = [];
  let signatureMaterial = 0;
  let validSignatures = 0;
  let rosterHash: string;
  try {
    rosterHash = submissionRosterHashV1(
      artifact.header.seatKeys as SubmissionSeatKey[],
    );
  } catch (error) {
    return {
      state: artifact.header.seatKeys.some((entry) => isRecord(entry) && entry['sig'] !== undefined)
        ? 'partial'
        : 'unsigned',
      problems: [
        `cannot hash seat roster: ${error instanceof Error ? error.message : String(error)}`,
      ],
      seats: [],
    };
  }
  const keys = new Map(
    (artifact.header.seatKeys as SubmissionSeatKey[]).map((entry) => [entry.id, entry]),
  );
  interface MutableSeatCheck {
    seat: string;
    submissions: number;
    validSignatures: number;
    chainReproduced: boolean;
    policySatisfied: boolean;
    chainHead: string;
    firstSubmissionTick?: number;
    submissionPositions: Array<{ levelIndex: number; tick: number; order: number }>;
    attestationPositions: Array<{ levelIndex: number; tick: number; order: number }>;
    chainBroken: boolean;
  }
  const checks = new Map<string, MutableSeatCheck>();
  for (const entry of keys.values()) {
    checks.set(entry.id, {
      seat: entry.id,
      submissions: 0,
      validSignatures: 0,
      chainReproduced: true,
      policySatisfied: true,
      chainHead: submissionGenesisHashV1(
        artifact.header.sessionId,
        entry.id,
        rosterHash,
      ),
      submissionPositions: [],
      attestationPositions: [],
      chainBroken: false,
    });
  }

  for (const [order, item] of signatureSubmissions(artifact).entries()) {
    if (item.kind === 'periodic') {
      const record = item.record;
      const check = checks.get(record.participantId);
      const key = keys.get(record.participantId);
      if (!check || !key) {
        problems.push(`${item.label} names seat outside header.seatKeys`);
        continue;
      }
      if (record.sig !== undefined) signatureMaterial++;
      if (record.prevChainHash !== check.chainHead) {
        check.chainReproduced = false;
        check.policySatisfied = false;
        problems.push(`${item.label} does not sign seat ${record.participantId}'s current chain head`);
        continue;
      }
      if (record.clientTime === undefined || record.sig === undefined) {
        check.policySatisfied = false;
        problems.push(`${item.label} is missing clientTime or sig`);
        continue;
      }
      const valid = verifyEd25519Base64(
        key.publicKey,
        periodicSignaturePreimageV1({
          sessionId: artifact.header.sessionId,
          seat: record.participantId,
          tick: record.tick,
          clientTime: record.clientTime,
          chainHead: record.prevChainHash,
        }),
        record.sig,
      );
      if (!valid) {
        check.policySatisfied = false;
        problems.push(`${item.label} has an invalid Ed25519 signature`);
        continue;
      }
      validSignatures++;
      check.validSignatures++;
      check.attestationPositions.push({
        levelIndex: record.levelIndex,
        tick: record.tick,
        order,
      });
      continue;
    }

    const { submission } = item;
    const check = checks.get(submission.seat);
    const key = keys.get(submission.seat);
    if (!check || !key) {
      problems.push(`${submission.label} names seat outside header.seatKeys`);
      continue;
    }
    check.submissions++;
    check.firstSubmissionTick ??= submission.tick;
    check.submissionPositions.push({
      levelIndex: submission.levelIndex,
      tick: submission.tick,
      order,
    });
    const value = submission.value;
    if (value.sig !== undefined) signatureMaterial++;
    const hasChain = value.submissionId !== undefined
      && value.canonicalCommand !== undefined
      && value.cursor !== undefined
      && value.clientTime !== undefined
      && value.prevChainHash !== undefined;
    if (!hasChain) {
      check.chainBroken = true;
      check.chainReproduced = false;
      check.policySatisfied = false;
      problems.push(`${submission.label} is missing RFC-010 chain metadata`);
      continue;
    }
    const submissionId = value.submissionId!;
    const canonicalCommand = value.canonicalCommand!;
    const cursor = value.cursor!;
    const clientTime = value.clientTime!;
    const prevChainHash = value.prevChainHash!;
    if (check.chainBroken || value.prevChainHash !== check.chainHead) {
      check.chainBroken = true;
      check.chainReproduced = false;
      check.policySatisfied = false;
      problems.push(`${submission.label} does not reproduce seat ${submission.seat}'s chain`);
      continue;
    }
    let command: JsonValue;
    try {
      command = JSON.parse(canonicalCommand) as JsonValue;
      if (canonicalJson(command) !== canonicalCommand) throw new TypeError('not canonical');
    } catch {
      check.chainBroken = true;
      check.chainReproduced = false;
      check.policySatisfied = false;
      problems.push(`${submission.label} canonicalCommand is not canonical JSON`);
      continue;
    }
    const envelope = {
      sessionId: artifact.header.sessionId,
      seat: submission.seat,
      submissionId,
      cursor,
      tick: submission.tick,
      clientTime,
      command,
      prevChainHash,
    };
    const preimage = submissionPreimageV1(envelope);
    check.chainHead = submissionChainHashV1(envelope);
    if (value.sig === undefined) {
      if (submission.requiredTier !== undefined) {
        check.policySatisfied = false;
        problems.push(
          `${submission.label} requires a tier-${submission.requiredTier} signature`,
        );
      }
      continue;
    }
    if (!verifyEd25519Base64(key.publicKey, preimage, value.sig)) {
      check.policySatisfied = false;
      problems.push(`${submission.label} has an invalid Ed25519 signature`);
      continue;
    }
    validSignatures++;
    check.validSignatures++;
    check.attestationPositions.push({
      levelIndex: submission.levelIndex,
      tick: submission.tick,
      order,
    });
  }

  for (const [seat, check] of checks) {
    const key = keys.get(seat)!;
    if (check.firstSubmissionTick !== undefined) {
      for (const submission of check.submissionPositions) {
        const covering = check.attestationPositions.find(
          (candidate) => candidate.order >= submission.order,
        );
        if (covering === undefined) {
          check.policySatisfied = false;
          problems.push(
            `seat ${seat} has no signed chain head covering submission at `
            + `level ${submission.levelIndex} tick ${submission.tick}`,
          );
          break;
        }
        if (covering.levelIndex !== submission.levelIndex) {
          check.policySatisfied = false;
          problems.push(
            `seat ${seat} crosses a level boundary without signing its chain head`,
          );
          break;
        }
        if (covering.tick - submission.tick > key.signingTier.N) {
          check.policySatisfied = false;
          problems.push(
            `seat ${seat} exceeds signingTier.N=${key.signingTier.N} for submission at `
            + `level ${submission.levelIndex} tick ${submission.tick}`,
          );
          break;
        }
      }
    }
  }

  const seats: ReplaySeatSignatureCheck[] = [...checks.values()].map((check) => ({
    seat: check.seat,
    submissions: check.submissions,
    validSignatures: check.validSignatures,
    chainReproduced: check.chainReproduced,
    policySatisfied: check.policySatisfied,
    chainHead: check.chainHead,
  }));
  const complete = seats.every(
    (seat) => seat.chainReproduced && seat.policySatisfied,
  );
  return {
    state: signatureMaterial === 0
      ? seats.some((seat) => seat.submissions > 0) ? 'partial' : 'signed'
      : complete && validSignatures === signatureMaterial
        ? 'signed'
        : 'partial',
    problems,
    seats,
  };
}

function replaySubmittedAction(input: ReplayResolutionInput): SubmittedAction {
  return {
    id: input.canonicalId,
    ...(input.payload === undefined ? {} : { payload: input.payload }),
    ...(input.x === undefined ? {} : { x: input.x }),
    ...(input.y === undefined ? {} : { y: input.y }),
    ...(input.index === undefined ? {} : { index: input.index }),
    ...(input.boardId === undefined ? {} : { boardId: input.boardId }),
    ...(input.zoneId === undefined ? {} : { zoneId: input.zoneId }),
    ...(input.seat === undefined ? {} : { seat: input.seat }),
    ...(input.targets === undefined ? {} : { targets: input.targets }),
    ...(input.commit === undefined ? {} : { commit: input.commit }),
    ...(input.reveal === undefined ? {} : { reveal: input.reveal }),
    ...(input.verifiedPayload === undefined ? {} : { verifiedPayload: input.verifiedPayload }),
  };
}

function replayAuthoredAction(input: ReplayResolutionInput): SubmittedAction {
  const { verifiedPayload: _verifiedPayload, ...authored } = input;
  return replaySubmittedAction(authored);
}

function canonicalAction(action: SubmittedAction): string {
  return canonicalJson(action as unknown as JsonValue);
}

function parseCanonicalCommand(command: string): JsonValue {
  const parsed: unknown = JSON.parse(command);
  assertJsonValue(parsed);
  if (canonicalJson(parsed) !== command) {
    throw new TypeError('canonicalCommand is not canonical JSON');
  }
  return parsed;
}

function recheckReplaySemantics<TLevel, TState>(
  artifact: ReplayArtifact<TLevel>,
  options: ReplayArtifactRecheckOptions<TLevel, TState>,
  contexts: ReadonlyMap<number, ReplayReducerContext<TLevel>>,
): ReplaySemanticCheck {
  let submissionCount = 0;
  let timeoutCount = 0;
  let submissionUnavailable = false;
  let timeoutUnavailable = false;
  const problems: string[] = [];
  const records = artifact.records ?? [];
  const adapters = new Map<number, ReplaySemanticAdapter<TLevel> | undefined>();
  const adapterFor = (levelIndex: number): ReplaySemanticAdapter<TLevel> | undefined => {
    if (!adapters.has(levelIndex)) {
      const context = contexts.get(levelIndex);
      adapters.set(
        levelIndex,
        context === undefined ? undefined : options.semanticAdapterForLevel?.(context),
      );
    }
    return adapters.get(levelIndex);
  };
  const checkSubmission = (
    levelIndex: number,
    tick: number,
    input: ReplayResolutionInput,
    label: string,
  ): void => {
    if (input.submissionId === undefined
      || input.canonicalCommand === undefined
      || input.cursor === undefined
      || input.seat === undefined) return;
    submissionCount++;
    const base = contexts.get(levelIndex);
    const mapper = adapterFor(levelIndex)?.commandToAction;
    if (base === undefined || mapper === undefined) {
      submissionUnavailable = true;
      return;
    }
    try {
      const mapped = mapper(parseCanonicalCommand(input.canonicalCommand), {
        sessionId: artifact.header.sessionId,
        tick,
        cursor: input.cursor,
        participantId: input.seat,
        submissionId: input.submissionId,
      });
      const normalized = mapped.seat === undefined
        ? { ...mapped, seat: input.seat }
        : mapped;
      if (canonicalAction(normalized) !== canonicalAction(replayAuthoredAction(input))) {
        problems.push(`${label} command maps to a different replay action`);
      }
    } catch (error) {
      problems.push(
        `${label} command mapping failed: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  for (const [recordIndex, record] of records.entries()) {
    if (record.kind === 'action') {
      checkSubmission(record.levelIndex, record.tick ?? 0, record, `action ${record.n}`);
    } else if (record.kind === 'resolution') {
      for (const [inputIndex, input] of record.inputs.entries()) {
        checkSubmission(
          record.levelIndex,
          record.tick,
          input,
          `resolution ${record.n} input ${inputIndex}`,
        );
      }
    } else if (record.kind === 'commit-mismatch'
      && record.canonicalCommand !== undefined
      && record.cursor !== undefined
      && record.attemptedReveal !== undefined) {
      submissionCount++;
      const base = contexts.get(record.levelIndex);
      const mapper = adapterFor(record.levelIndex)?.commandToAction;
      if (base === undefined || mapper === undefined) {
        submissionUnavailable = true;
      } else {
        try {
          const mapped = mapper(parseCanonicalCommand(record.canonicalCommand), {
            sessionId: artifact.header.sessionId,
            tick: record.tick,
            cursor: record.cursor,
            participantId: record.participantId,
            submissionId: record.submissionId,
          });
          const expectedReveal = {
            commitmentId: record.commitmentId,
            salt: record.attemptedReveal.salt,
            payload: record.attemptedReveal.payload,
          };
          if (canonicalJson(mapped.reveal as unknown as JsonValue)
            !== canonicalJson(expectedReveal)) {
            problems.push(
              `commit-mismatch record ${record.n} command maps to a different reveal`,
            );
          }
        } catch (error) {
          problems.push(
            `commit-mismatch record ${record.n} command mapping failed: `
            + `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    } else if (record.kind === 'timeout') {
      const resolution = records.slice(recordIndex + 1).find((candidate) =>
        candidate.levelIndex === record.levelIndex
        && (candidate.kind === 'resolution'
          || candidate.kind === 'timeout'
          || candidate.kind === 'commit-mismatch'));
      if (resolution?.kind !== 'resolution'
        || resolution.cause !== 'timeout'
        || resolution.systemInput === undefined) continue;
      timeoutCount++;
      const base = contexts.get(record.levelIndex);
      const mapper = adapterFor(record.levelIndex)?.timeoutToAction;
      if (base === undefined || mapper === undefined) {
        timeoutUnavailable = true;
        continue;
      }
      try {
        const mapped = mapper({
          sessionId: artifact.header.sessionId,
          game: base.game,
          levelId: base.level.id,
          ...(base.level.version === undefined ? {} : { levelVersion: base.level.version }),
          level: base.level.level,
          seed: base.level.seed,
          participantId: record.participantId,
          windowRef: record.windowRef,
        }, record);
        if (canonicalAction(mapped)
          !== canonicalAction(replayAuthoredAction(resolution.systemInput))) {
          problems.push(`timeout ${record.n} maps to a different system action`);
        }
      } catch (error) {
        problems.push(
          `timeout ${record.n} mapping failed: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  const failedSubmissions = problems.some((problem) =>
    problem.includes('command map') || problem.includes('command mapping'));
  const failedTimeouts = problems.some((problem) =>
    problem.startsWith('timeout ') && problem.includes('map'));
  return {
    submissions: submissionCount === 0
      ? 'not_applicable'
      : failedSubmissions ? 'failed' : submissionUnavailable ? 'unavailable' : 'verified',
    timeouts: timeoutCount === 0
      ? 'not_applicable'
      : failedTimeouts ? 'failed' : timeoutUnavailable ? 'unavailable' : 'verified',
    problems,
  };
}

interface RecordedCommitment {
  envelope: CommitmentEnvelope;
  sessionId: string;
  seat: string;
  windowRef: number;
  revealed: boolean;
}

function recheckGroupedLevel<
  TLevel,
  TState,
  TView extends SessionView,
>(
  artifact: ReplayArtifact<TLevel>,
  level: ReplayLevelRecord<TLevel>,
  reducer: Reducer<TLevel, TState, TView>,
  seenSalts: Map<string, { identity: string; location: string }>,
): RecheckResult {
  const problems: string[] = [];
  const diagnostics: string[] = [];
  const commitments = new Map<string, RecordedCommitment>();
  const nextCommitmentId = new Map<string, number>();
  const seenMismatchSubmissionIds = new Set<string>();
  let lastResolutionTick: number | undefined;
  let state = reducer.init(level.level, level.seed);
  const records = (artifact.records ?? []).filter(
    (record) => record.levelIndex === level.index,
  );
  const noteSalt = (salt: string, identity: string, location: string): void => {
    const prior = seenSalts.get(salt);
    if (prior && prior.identity !== identity) {
      diagnostics.push(
        `salt reuse: ${location} reuses salt first observed at ${prior.location}`,
      );
    } else {
      seenSalts.set(salt, { identity, location });
    }
  };
  for (const record of records) {
    const resolution: ReplayResolution | undefined = record.kind === 'resolution'
      ? record
      : record.kind === 'action'
        ? {
          kind: 'resolution',
          n: record.n,
          levelIndex: record.levelIndex,
          tick: record.tick ?? 0,
          cause: 'complete',
          inputs: [{
            wireId: record.wireId,
            canonicalId: record.canonicalId,
            ...(record.x === undefined ? {} : { x: record.x }),
            ...(record.y === undefined ? {} : { y: record.y }),
            ...(record.index === undefined ? {} : { index: record.index }),
            ...(record.boardId === undefined ? {} : { boardId: record.boardId }),
            ...(record.zoneId === undefined ? {} : { zoneId: record.zoneId }),
            ...(record.seat === undefined ? {} : { seat: record.seat }),
            ...(record.targets === undefined ? {} : { targets: record.targets }),
            ...(record.commit === undefined ? {} : { commit: record.commit }),
            ...(record.reveal === undefined ? {} : { reveal: record.reveal }),
            ...(record.verifiedPayload === undefined
              ? {}
              : { verifiedPayload: record.verifiedPayload }),
          }],
        }
        : undefined;
    if (resolution) {
      if (reducer.view(state).status !== 'playing') {
        problems.push(`resolution ${resolution.n} appears after terminal state`);
        break;
      }
      const inputs: SubmittedAction[] = [];
      for (const replayInput of resolution.inputs) {
        if (replayInput.commit && replayInput.reveal) {
          problems.push(`resolution ${resolution.n} input has both commit and reveal`);
          continue;
        }
        const seat = replayInput.seat;
        if (replayInput.commit) {
          if (!seat) {
            problems.push(`resolution ${resolution.n} commitment requires seat`);
            continue;
          }
          const expectedId = nextCommitmentId.get(seat) ?? 0;
          if (replayInput.commit.commitmentId !== expectedId) {
            problems.push(
              `resolution ${resolution.n} seat ${seat} commitmentId `
              + `${replayInput.commit.commitmentId} must be ${expectedId}`,
            );
            continue;
          }
          const key = `${seat}\u0000${replayInput.commit.commitmentId}`;
          commitments.set(key, {
            envelope: replayInput.commit,
            sessionId: artifact.header.sessionId,
            seat,
            windowRef: resolution.tick,
            revealed: false,
          });
          nextCommitmentId.set(seat, expectedId + 1);
        }
        let verifiedPayload: JsonValue | undefined;
        if (replayInput.reveal) {
          noteSalt(
            replayInput.reveal.salt,
            `${level.index}\u0000${seat ?? '<missing>'}\u0000${replayInput.reveal.commitmentId}`,
            `resolution ${resolution.n} seat ${seat ?? '<missing>'}`,
          );
          if (!seat) {
            problems.push(`resolution ${resolution.n} reveal requires seat`);
            continue;
          }
          const key = `${seat}\u0000${replayInput.reveal.commitmentId}`;
          const commitment = commitments.get(key);
          if (!commitment) {
            problems.push(
              `resolution ${resolution.n} reveal references unknown commitment `
              + `${seat}/${replayInput.reveal.commitmentId}`,
            );
            continue;
          }
          if (commitment.revealed) {
            problems.push(
              `resolution ${resolution.n} commitment ${seat}/${replayInput.reveal.commitmentId}`
              + ' was already revealed',
            );
            continue;
          }
          let actualHash = '';
          try {
            actualHash = createCommitmentHash(
              {
                sessionId: commitment.sessionId,
                seat: commitment.seat,
                commitmentId: commitment.envelope.commitmentId,
                windowRef: commitment.windowRef,
              },
              replayInput.reveal.salt,
              replayInput.reveal.payload,
            );
          } catch (error) {
            problems.push(
              `resolution ${resolution.n} reveal is malformed: `
              + `${error instanceof Error ? error.message : String(error)}`,
            );
            continue;
          }
          if (actualHash !== commitment.envelope.hash) {
            problems.push(
              `commit_mismatch: seat ${seat}, commitmentId ${replayInput.reveal.commitmentId}`,
            );
            continue;
          }
          commitment.revealed = true;
          verifiedPayload = replayInput.reveal.payload;
        }
        inputs.push(replaySubmittedAction({
          ...replayInput,
          ...(verifiedPayload === undefined ? {} : { verifiedPayload }),
        }));
      }
      try {
        state = advanceTick(reducer, state, inputs);
        lastResolutionTick = resolution.tick;
      } catch (error) {
        problems.push(
          `resolution ${resolution.n} rejected on replay: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
        break;
      }
    } else if (record.kind === 'commit-mismatch') {
      const key = `${record.participantId}\u0000${record.commitmentId}`;
      const submissionKey = `${record.participantId}\u0000${record.submissionId}`;
      let duplicate = false;
      if (seenMismatchSubmissionIds.has(submissionKey)) {
        problems.push(
          `commit-mismatch record ${record.n} reuses submissionId `
          + `${record.participantId}/${record.submissionId}`,
        );
        duplicate = true;
      } else {
        seenMismatchSubmissionIds.add(submissionKey);
      }
      const expectedTick = lastResolutionTick === undefined
        ? undefined
        : lastResolutionTick + 1;
      if (expectedTick !== undefined && record.tick !== expectedTick) {
        problems.push(
          `commit-mismatch record ${record.n} tick ${record.tick} must match `
          + `the open tick ${expectedTick}`,
        );
      }
      const commitment = commitments.get(key);
      if (!commitment) {
        problems.push(
          `commit-mismatch record ${record.n} references unknown commitment `
          + `${record.participantId}/${record.commitmentId}`,
        );
      } else if (commitment.revealed) {
        problems.push(
          `commit-mismatch record ${record.n} references already revealed commitment `
          + `${record.participantId}/${record.commitmentId}`,
        );
      } else if (duplicate) {
        continue;
      } else if (!record.attemptedReveal) {
        diagnostics.push(
          `commit-mismatch record ${record.n} was recorded but is not independently recheckable`,
        );
      } else {
        noteSalt(
          record.attemptedReveal.salt,
          `${level.index}\u0000${record.participantId}\u0000${record.commitmentId}`,
          `commit-mismatch record ${record.n} seat ${record.participantId}`,
        );
        try {
          const actualHash = createCommitmentHash(
            {
              sessionId: commitment.sessionId,
              seat: commitment.seat,
              commitmentId: commitment.envelope.commitmentId,
              windowRef: commitment.windowRef,
            },
            record.attemptedReveal.salt,
            record.attemptedReveal.payload,
          );
          if (actualHash === commitment.envelope.hash) {
            problems.push(
              `commit-mismatch record ${record.n} is inconsistent: attempted reveal matches`,
            );
          } else {
            diagnostics.push(
              `verified commit_mismatch: seat ${record.participantId}, `
              + `commitmentId ${record.commitmentId}`,
            );
          }
        } catch (error) {
          problems.push(
            `commit-mismatch record ${record.n} cannot be rechecked: `
            + `${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
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
  if (view.status !== level.result.status) {
    problems.push(`status: recorded ${level.result.status}, replayed ${view.status}`);
  }
  if ((view.stars ?? null) !== level.result.stars) {
    problems.push(`stars: recorded ${level.result.stars}, replayed ${view.stars ?? null}`);
  }
  if (actionsUsed >= 0 && actionsUsed !== level.result.actionsUsed) {
    problems.push(
      `actionsUsed: recorded ${level.result.actionsUsed}, replayed ${actionsUsed}`,
    );
  }
  return {
    ok: problems.length === 0,
    problems,
    diagnostics,
    replayed: {
      status: view.status,
      stars: view.stars ?? null,
      actionsUsed,
    },
  };
}

/**
 * Recheck every level segment through the existing SDK reducer verifier, then
 * compare the run totals. Reducer selection is product-owned but keyed only by
 * the portable game/adapter/level declarations.
 */
export function recheckReplayArtifact<
  TLevel,
  TState,
  TView extends SessionView,
>(
  artifact: ReplayArtifact<TLevel>,
  resolveReducer: ReplayReducerResolver<TLevel, TState, TView>,
  options: ReplayArtifactRecheckOptions<TLevel, TState> = {},
): ReplayArtifactRecheckResult {
  const problems = validateReplayArtifact(artifact);
  const diagnostics: string[] = [];
  if (problems.length > 0) {
    return {
      ok: false,
      verdict: 'rejected',
      signatures: { state: 'unsigned', problems: [], seats: [] },
      semantics: {
        submissions: 'not_applicable',
        timeouts: 'not_applicable',
        problems: [],
      },
      problems,
      diagnostics,
      levels: [],
      replayed: { statuses: [], totalStars: 0, totalActionsUsed: 0 },
    };
  }
  const signatures = recheckReplaySignatures(artifact as ReplayArtifact<unknown>);

  const checks: ReplayLevelRecheck[] = [];
  let totalStars = 0;
  let totalActionsUsed = 0;
  let replayDmath: Dmath | undefined;
  const dmathDeclaration = artifact.header.extensions?.['dmath'];
  if (dmathDeclaration !== undefined) {
    try {
      if (!isRecord(dmathDeclaration)
        || dmathDeclaration['algorithm'] !== 'dmath-1') {
        throw new TypeError('extensions.dmath.algorithm must be dmath-1');
      }
      replayDmath = createDmath({ algorithm: dmathDeclaration['algorithm'] });
    } catch (error) {
      problems.push(
        `cannot construct replay dmath algorithm: `
        + `${error instanceof Error ? error.message : String(error)}`,
      );
      return {
        ok: false,
        verdict: 'rejected',
        signatures,
        semantics: {
          submissions: 'not_applicable',
          timeouts: 'not_applicable',
          problems: [],
        },
        problems,
        diagnostics,
        levels: [],
        replayed: { statuses: [], totalStars: 0, totalActionsUsed: 0 },
      };
    }
  }
  const seenSalts = new Map<string, { identity: string; location: string }>();
  const replayContexts = new Map<number, ReplayReducerContext<TLevel>>();
  for (const level of artifact.header.levels) {
    const context: ReplayReducerContext<TLevel> = {
      game: artifact.header.game,
      level,
      ...(replayDmath === undefined ? {} : { dmath: replayDmath }),
    };
    replayContexts.set(level.index, context);
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
    const result = artifact.records
      ? recheckGroupedLevel(artifact, level, reducer, seenSalts)
      : recheckTranscript(
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
    diagnostics.push(...result.diagnostics.map(
      (diagnostic) => `level ${level.index} (${level.id}): ${diagnostic}`,
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
  const semantics = recheckReplaySemantics(artifact, options, replayContexts);
  if (semantics.submissions === 'unavailable') {
    diagnostics.push(
      'signed command bytes were authenticated, but command-to-action mapping was not supplied',
    );
  }
  if (semantics.timeouts === 'unavailable') {
    diagnostics.push(
      'timeout actions were replayed, but timeoutToAction mapping was not supplied',
    );
  }
  const semanticsRejected = semantics.submissions === 'failed'
    || semantics.timeouts === 'failed';
  const semanticsUnavailable = semantics.submissions === 'unavailable'
    || semantics.timeouts === 'unavailable';
  return {
    ok: problems.length === 0,
    verdict: problems.length > 0 || signatures.problems.length > 0
      || signatures.state === 'partial' || semanticsRejected
      ? 'rejected'
      : signatures.state === 'signed' && !semanticsUnavailable
        ? 'trusted'
        : 'unverifiable',
    signatures,
    semantics,
    problems,
    diagnostics,
    levels: checks,
    replayed: {
      statuses: checks.map(({ result }) => result.replayed.status),
      totalStars,
      totalActionsUsed,
    },
  };
}
