/**
 * Stable wire contracts for deterministic tick-based games.
 *
 * Observations and commands are deliberately opaque generic values. A grid
 * game may put a text board in an observation; a card game may put hands and
 * piles there. Values crossing the wire must be JSON-serializable.
 */

export const PROTOCOL_ID = 'agilabs.ticks' as const;
export const PROTOCOL_VERSION = '1.0' as const;
/** Portable seat ids keep canonical ordering identical across SDK languages. */
export const PARTICIPANT_ID_PATTERN = '^[A-Za-z0-9_.:@-]{1,128}$' as const;
const INVALID_PARTICIPANT_ID_CHAR = /[^A-Za-z0-9_.:@-]/;

export function isParticipantId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 1
    && value.length <= 128
    && !INVALID_PARTICIPANT_ID_CHAR.test(value);
}

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];
export interface JsonObject { [key: string]: JsonValue }

export interface ProtocolExtensions extends JsonObject {}

/** RFC-010 integrity fields; semantics activate under a v1.2 replay policy. */
export interface SubmissionIntegrityReservation {
  /**
   * Required for chained submissions. Recorded without judging the client
   * clock's correctness.
   */
  clientTime?: number;
  prevChainHash?: string;
  sig?: string;
}

export interface TickCursor {
  /** Stable identity of this revision, unique within a session. */
  tickId: string;
  /** Monotonically increasing resolved-tick revision, starting at zero. */
  revision: number;
}

interface EnvelopeBase extends TickCursor {
  protocol: typeof PROTOCOL_ID;
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  extensions?: ProtocolExtensions;
}

/** A fully resolved observation. This is the only envelope renderers animate. */
export interface TickEnvelope<TObservation = unknown> extends EnvelopeBase {
  kind: 'tick';
  tick: TObservation;
}

/**
 * Acknowledges one collected input without advancing the tick. `tick` is the
 * last resolved observation, so clients can keep rendering while they wait.
 */
export interface PendingEnvelope<TObservation = unknown> extends EnvelopeBase {
  kind: 'pending';
  tick: TObservation;
  acceptedParticipantId?: string;
  submittedParticipants: string[];
  awaitingParticipants: string[];
}

export type TickResult<TObservation = unknown> =
  | TickEnvelope<TObservation>
  | PendingEnvelope<TObservation>;

/** One participant's command for a specific unresolved tick. */
export interface CommandSubmission<TCommand = unknown>
  extends TickCursor, SubmissionIntegrityReservation {
  protocol: typeof PROTOCOL_ID;
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  participantId: string;
  /** Required caller-generated idempotency key. Keep it stable for exact
   * retries, and use a new key for each logical command/control substep. */
  submissionId: string;
  command: TCommand;
  extensions?: ProtocolExtensions;
}

export interface CollectedIntent<TCommand = unknown>
  extends SubmissionIntegrityReservation {
  participantId: string;
  submissionId: string;
  command: TCommand;
}

/**
 * Host-independent game registration seam. A game resolves one complete,
 * canonically ordered intent batch; the SDK never serially applies participant
 * commands. Config, state, observation, and command shapes are game-owned.
 */
export interface GameDefinition<
  TConfig,
  TState,
  TObservation,
  TCommand,
  TCommandDefinition = unknown,
> {
  id: string;
  version: string;
  create(config: TConfig, seed: number): TState;
  participants(state: TState): readonly string[];
  observe(state: TState, participantId: string): TObservation;
  /** Discoverable legal command surface for this participant and revision. */
  legalCommands(state: TState, participantId: string): readonly TCommandDefinition[];
  /** Authoritative host-side validation for an opaque submitted command. */
  isCommandLegal(state: TState, participantId: string, command: TCommand): boolean;
  /** One collected input batch resolves exactly one tick. */
  resolveTick(
    state: TState,
    intents: readonly CollectedIntent<TCommand>[],
  ): TState;
}

/** Resolve one canonical simulation tick through either adapter generation. */
export function resolveGameTick<TState, TCommand>(
  definition:
    Pick<GameDefinition<unknown, TState, unknown, TCommand>, 'resolveTick'>,
  state: TState,
  intents: readonly CollectedIntent<TCommand>[],
): TState {
  return definition.resolveTick(state, intents);
}

/** Instance-local registry: hosts opt games in explicitly without global state. */
export class GameRegistry {
  private readonly definitions = new Map<
    string,
    Map<string, GameDefinition<unknown, unknown, unknown, unknown, unknown>>
  >();

  register<TConfig, TState, TObservation, TCommand, TCommandDefinition>(
    definition: GameDefinition<TConfig, TState, TObservation, TCommand, TCommandDefinition>,
  ): void {
    if (
      typeof definition.id !== 'string'
      || !definition.id.trim()
      || typeof definition.version !== 'string'
      || !definition.version.trim()
    ) {
      throw new Error('game id and version are required');
    }
    let versions = this.definitions.get(definition.id);
    if (!versions) {
      versions = new Map();
      this.definitions.set(definition.id, versions);
    }
    if (versions.has(definition.version)) {
      throw new Error(`game already registered: ${definition.id}@${definition.version}`);
    }
    versions.set(
      definition.version,
      definition as GameDefinition<unknown, unknown, unknown, unknown, unknown>,
    );
  }

  get<TConfig, TState, TObservation, TCommand, TCommandDefinition = unknown>(
    id: string,
    version: string,
  ): GameDefinition<TConfig, TState, TObservation, TCommand, TCommandDefinition> | undefined {
    return this.definitions.get(id)?.get(version) as
      | GameDefinition<TConfig, TState, TObservation, TCommand, TCommandDefinition>
      | undefined;
  }
}

/** Plain-JSON state suitable for Durable Object/database persistence. */
export interface IntentWindow<TCommand = unknown> extends TickCursor {
  sessionId: string;
  /** Canonical lexicographic order used for deterministic resolution. */
  participants: string[];
  intents: Record<string, CollectedIntent<TCommand>>;
}

/** Structural counterpart of the engine participation descriptor. */
export type IntentParticipation =
  | { mode: 'sequential'; activeSeat: string }
  | { mode: 'simultaneous'; seats: readonly string[] };

/**
 * Map one engine collection tick to the protocol's eligible participant set.
 * Sequential play creates a one-seat window; simultaneous play includes every
 * declared seat. Portable seat-id validation is delegated to the normal
 * intent-window constructor.
 */
export function createParticipationIntentWindow<TCommand>(
  sessionId: string,
  revision: number,
  participation: IntentParticipation,
): IntentWindow<TCommand> {
  if (!participation || typeof participation !== 'object') {
    throw new TypeError('participation descriptor must be an object');
  }
  if (participation.mode === 'sequential') {
    return createIntentWindow(sessionId, revision, [participation.activeSeat]);
  }
  if (participation.mode === 'simultaneous') {
    return createIntentWindow(sessionId, revision, participation.seats);
  }
  throw new TypeError('participation mode must be sequential or simultaneous');
}

function hasIntent<TCommand>(window: IntentWindow<TCommand>, participantId: string): boolean {
  return Object.prototype.hasOwnProperty.call(window.intents, participantId);
}

export type IntentCollectionResult<TCommand = unknown> =
  | {
      status: 'pending';
      window: IntentWindow<TCommand>;
      submittedParticipants: string[];
      awaitingParticipants: string[];
    }
  | {
      status: 'ready';
      window: IntentWindow<TCommand>;
      /** Always follows `window.participants`, never request arrival order. */
      intents: CollectedIntent<TCommand>[];
    };

export type IntentErrorCode =
  | 'invalid_protocol'
  | 'wrong_session'
  | 'stale_tick'
  | 'unknown_participant'
  | 'invalid_submission'
  | 'illegal_command'
  | 'conflicting_intent';

export class IntentCollectionError extends Error {
  constructor(
    public readonly code: IntentErrorCode,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message, { cause });
    this.name = 'IntentCollectionError';
  }
}

export function makeTickId(sessionId: string, revision: number): string {
  if (typeof sessionId !== 'string' || !sessionId.trim()) {
    throw new Error('sessionId must be a non-empty string');
  }
  if (!Number.isSafeInteger(revision) || revision < 0) {
    throw new Error('revision must be a non-negative safe integer');
  }
  return `${sessionId}:${revision}`;
}

export function createIntentWindow<TCommand>(
  sessionId: string,
  revision: number,
  participantIds: readonly string[],
): IntentWindow<TCommand> {
  makeTickId(sessionId, revision);
  if (!Array.isArray(participantIds) || participantIds.some(
    (id) => !isParticipantId(id),
  )) {
    throw new Error('participant ids must match the portable ASCII seat-id pattern');
  }
  const participants = [...new Set(participantIds)].sort();
  if (participants.length === 0) throw new Error('at least one participant is required');
  if (participants.length !== participantIds.length) {
    throw new Error('participant ids must be non-empty and unique');
  }
  return {
    sessionId,
    tickId: makeTickId(sessionId, revision),
    revision,
    participants,
    intents: {},
  };
}

/**
 * Add one intent without mutating the persisted input window. Exact retries
 * are idempotent; stale or conflicting submissions are explicit errors. A
 * ready result may be recomputed for an exact retry. The host must atomically
 * commit resolution, its retry receipt, and the next intent window to ensure
 * the reducer itself runs once.
 */
export function collectIntent<TCommand>(
  window: IntentWindow<TCommand>,
  submission: CommandSubmission<TCommand>,
): IntentCollectionResult<TCommand> {
  validateIntentSubmission(window, submission);
  const existing = hasIntent(window, submission.participantId)
    ? window.intents[submission.participantId]
    : undefined;
  if (existing) {
    let exactRetry = false;
    try {
      exactRetry = existing.submissionId === submission.submissionId
        && stableJson(existing.command) === stableJson(submission.command);
    } catch (error) {
      throw new IntentCollectionError(
        'invalid_submission',
        error instanceof Error ? error.message : 'stored intent must contain plain JSON',
      );
    }
    if (exactRetry) {
      const submittedParticipants = window.participants.filter((id) => hasIntent(window, id));
      const awaitingParticipants = window.participants.filter((id) => !hasIntent(window, id));
      if (awaitingParticipants.length > 0) {
        return { status: 'pending', window, submittedParticipants, awaitingParticipants };
      }
      return {
        status: 'ready',
        window,
        intents: window.participants.map((id) => window.intents[id]!),
      };
    }
    throw new IntentCollectionError(
      'conflicting_intent',
      `participant ${submission.participantId} submitted a different intent for ${window.tickId}`,
    );
  }

  const intent: CollectedIntent<TCommand> = {
    participantId: submission.participantId,
    submissionId: submission.submissionId,
    command: submission.command,
    ...(submission.clientTime === undefined ? {} : { clientTime: submission.clientTime }),
    ...(submission.prevChainHash === undefined
      ? {}
      : { prevChainHash: submission.prevChainHash }),
    ...(submission.sig === undefined ? {} : { sig: submission.sig }),
  };
  const next: IntentWindow<TCommand> = {
    ...window,
    participants: [...window.participants],
    intents: { ...window.intents, [submission.participantId]: intent },
  };
  const submittedParticipants = next.participants.filter((id) => hasIntent(next, id));
  const awaitingParticipants = next.participants.filter((id) => !hasIntent(next, id));
  if (awaitingParticipants.length > 0) {
    return { status: 'pending', window: next, submittedParticipants, awaitingParticipants };
  }
  return {
    status: 'ready',
    window: next,
    intents: next.participants.map((id) => next.intents[id]!),
  };
}

/** Validate the stable wire cursor before interpreting a game-owned command. */
export function validateIntentSubmission<TCommand>(
  window: IntentWindow<unknown>,
  submission: CommandSubmission<TCommand>,
): void {
  if (submission.protocol !== PROTOCOL_ID || submission.protocolVersion !== PROTOCOL_VERSION) {
    throw new IntentCollectionError(
      'invalid_protocol',
      `expected ${PROTOCOL_ID} ${PROTOCOL_VERSION}`,
    );
  }
  if (submission.sessionId !== window.sessionId) {
    throw new IntentCollectionError('wrong_session', 'submission session does not match endpoint');
  }
  if (submission.tickId !== window.tickId || submission.revision !== window.revision) {
    throw new IntentCollectionError(
      'stale_tick',
      `expected tick ${window.tickId} revision ${window.revision}`,
    );
  }
  if (!window.participants.includes(submission.participantId)) {
    throw new IntentCollectionError(
      'unknown_participant',
      `unknown participant ${submission.participantId}`,
    );
  }
  if (typeof submission.submissionId !== 'string' || !submission.submissionId.trim()) {
    throw new IntentCollectionError('invalid_submission', 'submissionId is required');
  }
  try {
    assertJsonValue(submission.command, 'command');
    if (submission.extensions !== undefined) assertJsonObject(submission.extensions, 'extensions');
  } catch (error) {
    throw new IntentCollectionError(
      'invalid_submission',
      error instanceof Error ? error.message : 'submission must contain plain JSON',
    );
  }
}

function assertWellFormedUnicode(value: string, label: string): void {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new TypeError(`${label} must not contain unpaired surrogates`);
      }
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new TypeError(`${label} must not contain unpaired surrogates`);
    }
  }
}

/** Reject values whose JSON serialization is lossy, ambiguous, or unsafe. */
export function assertJsonValue(value: unknown, label = 'value'): asserts value is JsonValue {
  const active = new WeakSet<object>();
  const visit = (candidate: unknown, path: string): void => {
    if (candidate === null || typeof candidate === 'boolean') return;
    if (typeof candidate === 'string') {
      assertWellFormedUnicode(candidate, path);
      return;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new TypeError(`${path} must contain only finite numbers`);
      if (Number.isInteger(candidate) && !Number.isSafeInteger(candidate)) {
        throw new TypeError(
          `${path} integer numbers must be within the JavaScript safe range`,
        );
      }
      return;
    }
    if (typeof candidate !== 'object') throw new TypeError(`${path} must contain only plain JSON values`);
    if (active.has(candidate)) throw new TypeError(`${path} must not contain cycles`);
    active.add(candidate);
    try {
      if (Array.isArray(candidate)) {
        if (Object.getOwnPropertySymbols(candidate).length > 0) {
          throw new TypeError(`${path} must not contain symbol keys`);
        }
        for (let index = 0; index < candidate.length; index++) {
          if (!Object.hasOwn(candidate, index)) throw new TypeError(`${path} must not contain sparse arrays`);
          visit(candidate[index], `${path}[${index}]`);
        }
        const names = Object.getOwnPropertyNames(candidate);
        if (names.some((key) => key !== 'length' && (!/^(0|[1-9]\d*)$/.test(key)
          || Number(key) >= candidate.length))) {
          throw new TypeError(`${path} arrays must not contain named properties`);
        }
      } else {
        const prototype = Object.getPrototypeOf(candidate);
        if (prototype !== Object.prototype && prototype !== null) {
          throw new TypeError(`${path} must contain only plain objects`);
        }
        if (Object.getOwnPropertySymbols(candidate).length > 0) {
          throw new TypeError(`${path} must not contain symbol keys`);
        }
        for (const key of Object.keys(candidate)) {
          assertWellFormedUnicode(key, `${path} object key`);
          const descriptor = Object.getOwnPropertyDescriptor(candidate, key)!;
          if (!Object.hasOwn(descriptor, 'value')) {
            throw new TypeError(`${path} must contain only data properties`);
          }
          visit((candidate as Record<string, unknown>)[key], `${path}.${key}`);
        }
        if (Object.getOwnPropertyNames(candidate).length !== Object.keys(candidate).length) {
          throw new TypeError(`${path} must not contain hidden properties`);
        }
      }
    } finally {
      active.delete(candidate);
    }
  };
  visit(value, label);
}

export function assertJsonObject(value: unknown, label = 'value'): asserts value is JsonObject {
  assertJsonValue(value, label);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain JSON object`);
  }
}

/** Compare strings lexicographically by Unicode scalar value, not UTF-16 units. */
function compareUnicodeCodePoints(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  const length = Math.min(leftPoints.length, rightPoints.length);
  for (let index = 0; index < length; index++) {
    const difference = leftPoints[index]!.codePointAt(0)!
      - rightPoints[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

/** Collision-free canonical JSON used for exact retry comparison. */
export function canonicalJson(value: unknown): string {
  assertJsonValue(value);
  const encode = (candidate: JsonValue): string => {
    if (Array.isArray(candidate)) return `[${candidate.map(encode).join(',')}]`;
    if (candidate !== null && typeof candidate === 'object') {
      return `{${Object.keys(candidate).sort(compareUnicodeCodePoints).map((key) => (
        `${JSON.stringify(key)}:${encode(candidate[key]!)}`
      )).join(',')}}`;
    }
    return JSON.stringify(candidate);
  };
  return encode(value);
}

function stableJson(value: unknown): string {
  return canonicalJson(value);
}

export function tickEnvelope<TObservation>(
  sessionId: string,
  revision: number,
  tick: TObservation,
  extensions?: ProtocolExtensions,
): TickEnvelope<TObservation> {
  if (extensions !== undefined) assertJsonObject(extensions, 'extensions');
  return {
    protocol: PROTOCOL_ID,
    protocolVersion: PROTOCOL_VERSION,
    kind: 'tick',
    sessionId,
    tickId: makeTickId(sessionId, revision),
    revision,
    tick,
    ...(extensions ? { extensions } : {}),
  };
}

export function pendingEnvelope<TObservation, TCommand>(
  window: IntentWindow<TCommand>,
  tick: TObservation,
  acceptedParticipantId?: string,
  extensions?: ProtocolExtensions,
): PendingEnvelope<TObservation> {
  if (extensions !== undefined) assertJsonObject(extensions, 'extensions');
  const submittedParticipants = window.participants.filter((id) => hasIntent(window, id));
  return {
    protocol: PROTOCOL_ID,
    protocolVersion: PROTOCOL_VERSION,
    kind: 'pending',
    sessionId: window.sessionId,
    tickId: window.tickId,
    revision: window.revision,
    tick,
    ...(acceptedParticipantId ? { acceptedParticipantId } : {}),
    submittedParticipants,
    awaitingParticipants: window.participants.filter((id) => !hasIntent(window, id)),
    ...(extensions ? { extensions } : {}),
  };
}
