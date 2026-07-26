import {
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  canonicalJson,
  collectIntent,
  createIntentWindow,
  IntentCollectionError,
  type CollectedIntent,
  type CommandSubmission,
  type IntentWindow,
  type JsonObject,
  type JsonValue,
  type SubmissionIntegrityReservation,
} from './protocol.js';
export { IntentCollectionError };
export type { IntentErrorCode } from './protocol.js';
import {
  COMMITMENT_SCHEME,
  GAOS_REPLAY_DERIVED_SEEDS,
  advanceTick,
  assertCommitmentEnvelope,
  createCommitmentHash,
  createReplayArtifact,
  fnv1a,
  runLevelSeed,
  type CommitmentEnvelope,
  type Dmath,
  type Reducer,
  type ReplayArtifact,
  type ReplayGameRef,
  type ReplayRecord,
  type ReplayResolutionInput,
  type ReplaySeedPolicy,
  type RevealEnvelope,
  type SubmittedAction,
  type TickRate,
  type TickView,
  type TranscriptVisibility,
} from './engine/index.js';

export interface SessionLimits {
  /** Maximum distance a tick target may be ahead of the open tick. */
  maxFutureTicks?: number;
  /** Maximum ticks resolved by one `prepareAdvance` call. */
  maxCatchUpTicks?: number;
  /** Receipts retained per seat, measured in resolved windows. */
  receiptRetention?: number;
  /** Maximum canonical bytes accepted by one extension record. */
  maxExtensionBytes?: number;
}

export interface SessionStateIsolation<TState> {
  fork(state: TState): TState;
  discard?(draft: TState): void;
  retire?(previous: TState): void;
}

export interface CommandContext {
  readonly sessionId: string;
  readonly participantId: string;
  readonly submissionId: string;
  readonly cursor: number;
  readonly tick: number;
}

export interface SessionKernelOptions<
  TLevel,
  TState,
  TCommand extends JsonValue,
  TView extends TickView<unknown, unknown>,
> {
  sessionId: string;
  game: ReplayGameRef;
  levelId: string;
  levelVersion?: string | number;
  reducer: Reducer<TLevel, TState, TView>;
  level: TLevel;
  seed: number;
  seedPolicy: ReplaySeedPolicy;
  seats: readonly string[];
  cadence:
    | { mode: 'turns' }
    | { mode: 'ticks'; rate: TickRate };
  commandToAction(command: TCommand, context: CommandContext): SubmittedAction;
  /** Host UTC-millisecond clock used only to annotate durable session events. */
  hostTime?: () => number;
  /** Reserved timeout-policy declaration; v0.19 assigns no policy semantics. */
  timeoutPolicy?: JsonObject;
  dmath?: Dmath;
  limits?: SessionLimits;
  stateIsolation?: SessionStateIsolation<TState>;
}

export interface SessionHeader<TLevel = unknown> {
  sessionId: string;
  game: ReplayGameRef;
  levelId: string;
  levelVersion?: string | number;
  level: TLevel;
  seed: number;
  seedPolicy: ReplaySeedPolicy;
  seats: readonly string[];
  cadence:
    | { mode: 'turns' }
    | { mode: 'ticks'; ticksPerSecond: number };
  /** Reserved timeout-policy declaration; v0.19 assigns no policy semantics. */
  timeoutPolicy?: JsonObject;
  dmath?: {
    algorithm: string;
    backend: 'js' | 'wasm';
  };
}

interface SessionEventBase {
  eventId: string;
  transitionRevision: number;
  /** Advisory host UTC milliseconds; never reducer input or authentication evidence. */
  hostTime: number;
}

export interface CanonicalInput extends SubmissionIntegrityReservation {
  participantId: string | null;
  submissionId: string | null;
  action: SubmittedAction;
}

export type SessionEvent =
  | (SessionEventBase & {
    kind: 'intent-accepted';
    tick: number;
    revision: number;
    participantId: string;
    submissionId: string;
    command: JsonValue;
    canonicalCommand: string;
    /** RFC-010 reservation; v0.19 assigns no signature semantics. */
    clientTime?: number;
    /** RFC-010 reservation; v0.19 assigns no signature semantics. */
    prevChainHash?: string;
    /** RFC-010 reservation; v0.19 does not verify signatures. */
    sig?: string;
  })
  | (SessionEventBase & {
    kind: 'resolution';
    tick: number;
    cursor: number;
    cause: 'complete' | 'timeout' | 'tick';
    consumed: ReadonlyArray<{
      participantId: string;
      submissionId: string;
    }>;
    inputs: readonly CanonicalInput[];
    /** Exact host-derived input for a timeout resolution. */
    systemInput?: CanonicalInput;
    result: {
      status: 'playing' | 'won' | 'failed';
      stars: number | null;
      actionsUsed: number;
    };
  })
  | (SessionEventBase & {
    kind: 'timeout';
    tick: number;
    timeoutId: string;
    windowRef: number;
    participantId: string | null;
    /** Why the host concluded that the seat would not respond. */
    reason: string;
    /** Reserved reference into `SessionHeader.timeoutPolicy`. */
    timeoutPolicyRef?: string;
  })
  | (SessionEventBase & {
    kind: 'extension';
    tick: number;
    lane: string;
    record: JsonObject;
  })
  | (SessionEventBase & {
    kind: 'checkpoint';
    tick: number;
    digest: number;
  })
  | (SessionEventBase & {
    kind: 'rejection';
    code: 'commit_mismatch';
    tick: number;
    participantId: string;
    submissionId: string;
    commitmentId: number;
    scheme: typeof COMMITMENT_SCHEME;
    attemptedReveal: {
      salt: string;
      payload: JsonValue;
    };
    /** RFC-010 reservation for the rejected signed command. */
    canonicalCommand?: string;
    /** RFC-010 reservation for the rejected command cursor. */
    cursor?: number;
    clientTime?: number;
    prevChainHash?: string;
    sig?: string;
  });

type RawSessionEvent = SessionEvent extends infer T
  ? T extends SessionEvent
    ? Omit<T, keyof SessionEventBase>
    : never
  : never;

export interface SessionTranscript<TLevel = unknown> {
  header: SessionHeader<TLevel>;
  events: readonly SessionEvent[];
}

export interface ObservationDelta<TView = TickView<unknown, unknown>> {
  seat: string;
  /** Durable transition watermark used to resume rejection delivery. */
  transitionRevision: number;
  viewRevision: number;
  tick: number;
  codec: 'v1';
  /**
   * Applied user inputs in canonical reducer order for this view revision.
   * A reconnect snapshot applies no new input and therefore carries `[]`.
   */
  acknowledgements: readonly ObservationAcknowledgement[];
  /** Rejected identities ordered within this durable transition. */
  rejections: readonly ObservationRejectionNotice[];
  body:
    | { kind: 'snapshot'; view: TView }
    | { kind: 'unchanged' };
  /** Diagnostic only; not authentication or anti-cheat evidence. */
  viewDigest: number;
}

export interface ObservationAcknowledgement {
  participantId: string;
  submissionId: string;
}

export interface IngestReceipt {
  status: 'accepted' | 'duplicate';
  participantId: string;
  submissionId: string;
  cursor: number;
  tick: number;
  submittedParticipants: readonly string[];
  awaitingParticipants: readonly string[];
}

export interface AdvanceSummary<TView> {
  resolutions: number;
  partial: boolean;
  cursor: number;
  tick: number;
  digest: number;
  deltas: readonly ObservationDelta<TView>[];
  /** Per-seat notices for rejected inputs that did not advance gameplay. */
  rejections: readonly ObservationRejectionNotice[];
  /** Non-fatal integrity warnings observed while preparing this advance. */
  warnings: readonly SessionWarning[];
}

export interface ObservationRejectionNotice {
  /** Destination seat for this notice. */
  seat: string;
  transitionRevision: number;
  tick: number;
  participantId: string;
  submissionId: string;
  code: 'commit_mismatch';
}

export interface SessionWarning {
  code: 'salt_reuse';
  message: string;
  participantId: string;
  commitmentId: number;
}

export interface TimeoutInput {
  timeoutId: string;
  tick: number;
  participantId?: string | null;
  /** `elapsed`, `disconnect`, or a product-defined non-empty reason. */
  reason: string;
  /** Reserved reference into the declared timeout policy. */
  timeoutPolicyRef?: string;
}

export interface FinalizeOptions {
  perm: number[];
  visibility?: TranscriptVisibility;
  extensions?: JsonObject;
  /** Opt in to projecting advisory session-event times into replay records. */
  includeHostTime?: boolean;
}

export interface FinalizeRunOptions extends FinalizeOptions {
  /** Authoritative run seed used to derive every ordered level seed. */
  seed: number;
}

const preparedTransition: unique symbol = Symbol('gaos.prepared-transition');

type PreparedCompletion = 'open' | 'committed' | 'aborted';

interface ReceiptState {
  canonicalCommand: string;
  tickId: string;
  receipt: IngestReceipt;
  cursor: number;
}

interface LiveCommitment {
  envelope: CommitmentEnvelope;
  seat: string;
  windowRef: number;
  revealed: boolean;
}

interface KernelState<TState, TCommand extends JsonValue, TView> {
  reducerState: TState;
  window: IntentWindow<TCommand>;
  transitionRevision: number;
  cursor: number;
  tick: number;
  events: SessionEvent[];
  receipts: Map<string, ReceiptState>;
  expiredReceiptKeys: Set<string>;
  views: Map<string, TView>;
  viewRevisions: Map<string, number>;
  commitments: Map<string, LiveCommitment>;
  nextCommitmentIds: Map<string, number>;
  seenSalts: Map<string, string>;
}

interface PreparedState<TState, TCommand extends JsonValue, TView> {
  owner: object;
  completion: PreparedCompletion;
  next: KernelState<TState, TCommand, TView>;
  drafts: readonly TState[];
  noop: boolean;
}

export interface Prepared<TResult> {
  readonly baseTransitionRevision: number;
  readonly nextTransitionRevision: number;
  readonly events: readonly SessionEvent[];
  readonly deltas: readonly ObservationDelta[];
  readonly result: TResult;
  /** Opaque package-owned transition payload. */
  readonly [preparedTransition]: unknown;
}

export type PreparedTransitionErrorCode =
  | 'foreign'
  | 'stale'
  | 'already_completed';

export type SessionConflictErrorCode =
  | 'conflict'
  | 'unknown_submission';

export class PreparedTransitionError extends Error {
  constructor(
    public readonly code: PreparedTransitionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'PreparedTransitionError';
  }
}

export class SessionConflictError extends Error {
  public readonly code: SessionConflictErrorCode;

  constructor(
    code: SessionConflictErrorCode,
    message: string,
  );
  constructor(message: string);
  constructor(codeOrMessage: SessionConflictErrorCode | string, message?: string) {
    const code = message === undefined ? 'conflict' : codeOrMessage as SessionConflictErrorCode;
    super(message ?? codeOrMessage);
    this.name = 'SessionConflictError';
    this.code = code;
  }
}

export class SessionAdvanceError extends Error {
  constructor(
    public readonly code: 'not_ready' | 'stale_target' | 'invalid_target' | 'terminal',
    message: string,
  ) {
    super(message);
    this.name = 'SessionAdvanceError';
  }
}

export interface SessionKernel<TCommand extends JsonValue, TView> {
  prepareIngest(submission: CommandSubmission<TCommand>): Prepared<IngestReceipt>;
  prepareAdvance(target?: number): Prepared<AdvanceSummary<TView>>;
  prepareTimeout(
    timeout: TimeoutInput,
    forcedInput: SubmittedAction,
  ): Prepared<AdvanceSummary<TView>>;
  prepareExtension(lane: string, record: JsonObject): Prepared<void>;
  commit(prepared: Prepared<unknown>): void;
  abort(prepared: Prepared<unknown>): void;
  observe(seat: string): TView;
  observeAll(): Readonly<Record<string, TView>>;
  cursor(): number;
  tick(): number;
  viewRevision(seat: string): number;
  snapshot(seat: string, afterTransitionRevision?: number): ObservationDelta<TView>;
  sessionHeader(): SessionHeader;
  liveTranscript(): SessionTranscript;
  digest(): number;
}

const DEFAULT_LIMITS = Object.freeze({
  maxCatchUpTicks: 600,
  receiptRetention: 64,
  maxExtensionBytes: 65_536,
});

function cloneMapValues<T>(source: Map<string, T>): Map<string, T> {
  return new Map([...source].map(([key, value]) => [key, structuredClone(value)]));
}

function actionCopy(action: SubmittedAction): SubmittedAction {
  return structuredClone(action);
}

function deepFreeze<T>(value: T, maximumObjects = 100_000): T {
  if (value === null || typeof value !== 'object') return value;
  const pending: object[] = [value];
  const visited = new WeakSet<object>();
  let visitedObjects = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (visited.has(current)) continue;
    visited.add(current);
    visitedObjects++;
    if (visitedObjects > maximumObjects) {
      throw new RangeError('prepared value exceeds the deep-freeze object limit');
    }
    for (const child of Object.values(current)) {
      if (child !== null && typeof child === 'object') pending.push(child);
    }
    Object.freeze(current);
  }
  return value;
}

function participantsForView<TView extends TickView<unknown, unknown>>(
  view: TView,
  fallback: readonly string[],
): string[] {
  if (view.participation?.mode === 'sequential') {
    return [view.participation.activeSeat];
  }
  if (view.participation?.mode === 'simultaneous') {
    return [...view.participation.seats];
  }
  if (view.activeSeat) return [view.activeSeat];
  return [...fallback];
}

function receiptKey(participantId: string, submissionId: string): string {
  return `${participantId}\u0000${submissionId}`;
}

function commitmentKey(seat: string, commitmentId: number): string {
  return `${seat}\u0000${commitmentId}`;
}

function eventId(sessionId: string, transitionRevision: number, index: number): string {
  return `${sessionId}:${transitionRevision}:${index}`;
}

function viewDigest(view: unknown): number {
  return fnv1a(canonicalJson(view));
}

class SessionKernelImpl<
  TLevel,
  TState,
  TCommand extends JsonValue,
  TView extends TickView<unknown, unknown>,
> implements SessionKernel<TCommand, TView> {
  private readonly owner = {};
  private readonly isolation: SessionStateIsolation<TState>;
  private readonly limits: Required<SessionLimits>;
  private readonly header: SessionHeader<TLevel>;
  /** O(1) permanent idempotency index, rebuilt from durable accepted events. */
  private readonly historicalSubmissionKeys = new Set<string>();
  private readonly draftForks = new WeakMap<
    KernelState<TState, TCommand, TView>,
    TState
  >();
  private live: KernelState<TState, TCommand, TView>;

  constructor(
    private readonly options: SessionKernelOptions<TLevel, TState, TCommand, TView>,
    transcript?: SessionTranscript<TLevel>,
  ) {
    if (!Number.isSafeInteger(options.seed) || options.seed < 0 || options.seed > 0xffff_ffff) {
      throw new RangeError('seed must be an unsigned 32-bit integer');
    }
    if (new Set(options.seats).size !== options.seats.length || options.seats.length === 0) {
      throw new TypeError('seats must be non-empty and unique');
    }
    if (options.cadence.mode === 'ticks' && !('advance' in options.reducer)) {
      throw new TypeError('ticks cadence requires TickReducer.advance');
    }
    if (options.timeoutPolicy !== undefined
      && (options.timeoutPolicy === null
        || typeof options.timeoutPolicy !== 'object'
        || Array.isArray(options.timeoutPolicy))) {
      throw new TypeError('timeoutPolicy must be an object');
    }
    if (options.timeoutPolicy !== undefined) canonicalJson(options.timeoutPolicy);
    this.limits = {
      maxFutureTicks: options.limits?.maxFutureTicks
        ?? (options.cadence.mode === 'ticks'
          ? options.cadence.rate.ticksPerSecond * 2
          : 1),
      maxCatchUpTicks: options.limits?.maxCatchUpTicks ?? DEFAULT_LIMITS.maxCatchUpTicks,
      receiptRetention: options.limits?.receiptRetention ?? DEFAULT_LIMITS.receiptRetention,
      maxExtensionBytes: options.limits?.maxExtensionBytes ?? DEFAULT_LIMITS.maxExtensionBytes,
    };
    for (const [key, value] of Object.entries(this.limits)) {
      if (!Number.isSafeInteger(value) || value < (key === 'receiptRetention' ? 0 : 1)) {
        throw new RangeError(`${key} has an invalid bound`);
      }
    }
    this.isolation = options.stateIsolation ?? {
      fork: (state: TState): TState => structuredClone(state),
    };
    const levelSeed = options.seedPolicy === 'gaos.run-level-seed.v1'
      ? runLevelSeed(options.seed, 0)
      : options.seed;
    const initialState = options.reducer.init(options.level, levelSeed);
    try {
      const probe = this.isolation.fork(initialState);
      this.isolation.discard?.(probe);
    } catch (error) {
      throw new TypeError(
        'reducer state is not cloneable; provide SessionStateIsolation.fork'
        + ` (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    this.header = {
      sessionId: options.sessionId,
      game: structuredClone(options.game),
      levelId: options.levelId,
      ...(options.levelVersion === undefined ? {} : { levelVersion: options.levelVersion }),
      level: structuredClone(options.level),
      seed: options.seed,
      seedPolicy: options.seedPolicy,
      seats: [...options.seats],
      cadence: options.cadence.mode === 'turns'
        ? { mode: 'turns' }
        : { mode: 'ticks', ticksPerSecond: options.cadence.rate.ticksPerSecond },
      ...(options.timeoutPolicy === undefined
        ? {}
        : { timeoutPolicy: structuredClone(options.timeoutPolicy) }),
      ...(options.dmath === undefined
        ? {}
        : {
          dmath: {
            algorithm: options.dmath.algorithm,
            backend: options.dmath.backend,
          },
        }),
    };
    const initialView = options.reducer.view(initialState);
    const participants = this.validatedParticipantsForView(initialView);
    const views = new Map<string, TView>();
    const revisions = new Map<string, number>();
    for (const seat of options.seats) {
      views.set(seat, this.viewFor(initialState, seat));
      revisions.set(seat, 0);
    }
    this.live = {
      reducerState: initialState,
      window: createIntentWindow(options.sessionId, 0, participants),
      transitionRevision: 0,
      cursor: 0,
      tick: 0,
      events: [],
      receipts: new Map(),
      expiredReceiptKeys: new Set(),
      views,
      viewRevisions: revisions,
      commitments: new Map(),
      nextCommitmentIds: new Map(),
      seenSalts: new Map(),
    };
    if (transcript) this.rehydrate(transcript);
  }

  private viewFor(state: TState, seat: string): TView {
    if (!this.options.seats.includes(seat)) throw new RangeError(`unknown seat ${seat}`);
    return this.options.reducer.viewFor
      ? this.options.reducer.viewFor(state, seat)
      : this.options.reducer.view(state);
  }

  private validatedParticipantsForView(view: TView): string[] {
    const participants = participantsForView(view, this.options.seats);
    if (participants.length === 0
      || participants.some((seat) => !this.options.seats.includes(seat))) {
      throw new TypeError('reducer participation must name one or more declared session seats');
    }
    return participants;
  }

  private forkLive(): KernelState<TState, TCommand, TView> {
    const reducerState = this.isolation.fork(this.live.reducerState);
    const draft: KernelState<TState, TCommand, TView> = {
      reducerState,
      window: structuredClone(this.live.window),
      transitionRevision: this.live.transitionRevision,
      cursor: this.live.cursor,
      tick: this.live.tick,
      events: [...this.live.events],
      receipts: cloneMapValues(this.live.receipts),
      expiredReceiptKeys: new Set(this.live.expiredReceiptKeys),
      views: cloneMapValues(this.live.views),
      viewRevisions: new Map(this.live.viewRevisions),
      commitments: cloneMapValues(this.live.commitments),
      nextCommitmentIds: new Map(this.live.nextCommitmentIds),
      seenSalts: new Map(this.live.seenSalts),
    };
    this.draftForks.set(draft, reducerState);
    return draft;
  }

  private takeDraftResources(
    draft: KernelState<TState, TCommand, TView>,
  ): readonly TState[] {
    const original = this.draftForks.get(draft);
    this.draftForks.delete(draft);
    if (original === undefined || original === draft.reducerState) {
      return [draft.reducerState];
    }
    return [original, draft.reducerState];
  }

  private discardDraft(draft: KernelState<TState, TCommand, TView>): void {
    for (const resource of this.takeDraftResources(draft)) {
      this.isolation.discard?.(resource);
    }
  }

  private makePrepared<TResult>(
    draft: KernelState<TState, TCommand, TView>,
    rawEvents: RawSessionEvent[],
    deltas: ObservationDelta<TView>[],
    result: TResult,
    noop = false,
  ): Prepared<TResult> {
    const base = this.live.transitionRevision;
    const nextRevision = noop ? base : base + 1;
    const events = rawEvents.map((raw, index): SessionEvent => {
      const hostTime = this.options.hostTime?.() ?? Date.now();
      if (!Number.isSafeInteger(hostTime) || hostTime < 0) {
        throw new RangeError('hostTime must be non-negative UTC milliseconds');
      }
      return {
        ...structuredClone(raw),
        eventId: eventId(this.options.sessionId, nextRevision, index),
        transitionRevision: nextRevision,
        hostTime,
      } as SessionEvent;
    });
    if (!noop) {
      draft.transitionRevision = nextRevision;
      draft.events.push(...events);
    }
    const publishedEvents = deepFreeze(structuredClone(events));
    const publishedDeltas = deepFreeze(structuredClone(deltas));
    const publishedResult = deepFreeze(structuredClone(result));
    const state: PreparedState<TState, TCommand, TView> = {
      owner: this.owner,
      completion: 'open',
      next: draft,
      drafts: this.takeDraftResources(draft),
      noop,
    };
    return Object.freeze({
      baseTransitionRevision: base,
      nextTransitionRevision: nextRevision,
      events: publishedEvents,
      deltas: publishedDeltas,
      result: publishedResult,
      [preparedTransition]: state as PreparedState<unknown, JsonValue, unknown>,
    });
  }

  private preparedState(
    prepared: Prepared<unknown>,
    allowAborted = false,
  ): PreparedState<TState, TCommand, TView> {
    const value = prepared?.[preparedTransition] as
      | PreparedState<TState, TCommand, TView>
      | undefined;
    if (!value || value.owner !== this.owner) {
      throw new PreparedTransitionError('foreign', 'prepared transition belongs to another kernel');
    }
    if (value.completion !== 'open' && !(allowAborted && value.completion === 'aborted')) {
      throw new PreparedTransitionError(
        'already_completed',
        `prepared transition was already ${value.completion}`,
      );
    }
    return value;
  }

  prepareIngest(submission: CommandSubmission<TCommand>): Prepared<IngestReceipt> {
    if (submission === null || typeof submission !== 'object' || Array.isArray(submission)) {
      throw new IntentCollectionError('invalid_submission', 'submission must be an object');
    }
    if (submission.protocol !== PROTOCOL_ID || submission.protocolVersion !== PROTOCOL_VERSION) {
      throw new IntentCollectionError(
        'invalid_protocol',
        `expected ${PROTOCOL_ID} ${PROTOCOL_VERSION}`,
      );
    }
    if (submission.sessionId !== this.options.sessionId) {
      throw new IntentCollectionError(
        'wrong_session',
        'submission session does not match endpoint',
      );
    }
    const key = receiptKey(submission.participantId, submission.submissionId);
    let canonicalCommand: string;
    try {
      canonicalCommand = canonicalJson(submission.command);
    } catch (error) {
      throw new IntentCollectionError(
        'invalid_submission',
        error instanceof Error ? error.message : 'submission command must contain plain JSON',
      );
    }
    const existing = this.live.receipts.get(key);
    if (existing) {
      if (existing.canonicalCommand !== canonicalCommand
        || existing.tickId !== submission.tickId
        || existing.cursor !== submission.revision) {
        throw new SessionConflictError('submission id was reused with different content or cursor');
      }
      const draft = this.forkLive();
      try {
        return this.makePrepared(
          draft,
          [],
          [],
          { ...existing.receipt, status: 'duplicate' },
          true,
        );
      } catch (error) {
        this.discardDraft(draft);
        throw error;
      }
    }
    if (this.options.reducer.view(this.live.reducerState).status !== 'playing') {
      throw new SessionAdvanceError('terminal', 'session is already terminal');
    }
    if (this.live.expiredReceiptKeys.has(key)
      || this.historicalSubmissionKeys.has(key)) {
      throw new SessionConflictError(
        'unknown_submission',
        'receipt retention has expired',
      );
    }
    const preview = actionCopy(this.options.commandToAction(submission.command, {
      sessionId: this.options.sessionId,
      participantId: submission.participantId,
      submissionId: submission.submissionId,
      cursor: this.live.cursor,
      tick: this.live.tick,
    }));
    if (preview.seat !== undefined && preview.seat !== submission.participantId) {
      throw new SessionConflictError('a participant command cannot impersonate another seat');
    }
    if (preview.verifiedPayload !== undefined) {
      throw new SessionConflictError('verifiedPayload is reserved for the session verifier');
    }
    if (preview.commit && preview.reveal) {
      throw new SessionConflictError('commit and reveal are mutually exclusive');
    }
    if (preview.commit) {
      try {
        assertCommitmentEnvelope(preview.commit);
      } catch (error) {
        throw new SessionConflictError(
          `invalid commitment envelope: `
          + `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const expected = this.live.nextCommitmentIds.get(submission.participantId) ?? 0;
      if (preview.commit.commitmentId !== expected) {
        throw new SessionConflictError(
          `commitmentId ${preview.commit.commitmentId} must be ${expected}`,
        );
      }
    }
    if (preview.reveal) {
      const commitment = this.live.commitments.get(
        commitmentKey(submission.participantId, preview.reveal.commitmentId),
      );
      if (!commitment || commitment.revealed) {
        throw new SessionConflictError('reveal references an unknown or revealed commitment');
      }
      try {
        createCommitmentHash(
          {
            sessionId: this.options.sessionId,
            seat: submission.participantId,
            commitmentId: commitment.envelope.commitmentId,
            windowRef: commitment.windowRef,
          },
          preview.reveal.salt,
          preview.reveal.payload,
        );
      } catch (error) {
        throw new SessionConflictError(
          `invalid reveal envelope: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const collected = collectIntent(this.live.window, submission);
    const draft = this.forkLive();
    draft.window = structuredClone(collected.window);
    const submittedParticipants = draft.window.participants.filter(
      (seat) => Object.hasOwn(draft.window.intents, seat),
    );
    const awaitingParticipants = draft.window.participants.filter(
      (seat) => !Object.hasOwn(draft.window.intents, seat),
    );
    const receipt: IngestReceipt = {
      status: 'accepted',
      participantId: submission.participantId,
      submissionId: submission.submissionId,
      cursor: draft.cursor,
      tick: draft.tick,
      submittedParticipants,
      awaitingParticipants,
    };
    draft.receipts.set(key, {
      canonicalCommand,
      tickId: submission.tickId,
      receipt,
      cursor: draft.cursor,
    });
    try {
      return this.makePrepared(draft, [{
        kind: 'intent-accepted',
        tick: draft.tick,
        revision: draft.cursor,
        participantId: submission.participantId,
        submissionId: submission.submissionId,
        command: structuredClone(submission.command),
        canonicalCommand,
        ...(submission.clientTime === undefined ? {} : { clientTime: submission.clientTime }),
        ...(submission.prevChainHash === undefined
          ? {}
          : { prevChainHash: submission.prevChainHash }),
        ...(submission.sig === undefined ? {} : { sig: submission.sig }),
      }], [], receipt);
    } catch (error) {
      this.discardDraft(draft);
      throw error;
    }
  }

  private mapIntents(
    draft: KernelState<TState, TCommand, TView>,
    intents: readonly CollectedIntent<TCommand>[],
  ): {
    inputs: CanonicalInput[];
    warnings: SessionWarning[];
    rejection?: Omit<Extract<SessionEvent, { kind: 'rejection' }>, keyof SessionEventBase>;
  } {
    const inputs: CanonicalInput[] = [];
    const warnings: SessionWarning[] = [];
    const commitments = cloneMapValues(draft.commitments);
    const nextCommitmentIds = new Map(draft.nextCommitmentIds);
    const seenSalts = new Map(draft.seenSalts);
    for (const intent of intents) {
      const context: CommandContext = {
        sessionId: this.options.sessionId,
        participantId: intent.participantId,
        submissionId: intent.submissionId,
        cursor: draft.cursor,
        tick: draft.tick,
      };
      const action = actionCopy(this.options.commandToAction(intent.command, context));
      if (action.seat !== undefined && action.seat !== intent.participantId) {
        throw new SessionConflictError('a participant command cannot impersonate another seat');
      }
      action.seat ??= intent.participantId;
      if (action.verifiedPayload !== undefined) {
        throw new SessionConflictError('verifiedPayload is reserved for the session verifier');
      }
      if (action.commit && action.reveal) {
        throw new SessionConflictError('commit and reveal are mutually exclusive');
      }
      if (action.commit) {
        assertCommitmentEnvelope(action.commit);
        const expected = nextCommitmentIds.get(intent.participantId) ?? 0;
        if (action.commit.commitmentId !== expected) {
          throw new SessionConflictError(
            `commitmentId ${action.commit.commitmentId} must be ${expected}`,
          );
        }
        commitments.set(commitmentKey(intent.participantId, expected), {
          envelope: structuredClone(action.commit),
          seat: intent.participantId,
          windowRef: draft.tick,
          revealed: false,
        });
        nextCommitmentIds.set(intent.participantId, expected + 1);
      }
      if (action.reveal) {
        const identity = commitmentKey(
          intent.participantId,
          action.reveal.commitmentId,
        );
        const priorIdentity = seenSalts.get(action.reveal.salt);
        if (priorIdentity !== undefined && priorIdentity !== identity) {
          warnings.push({
            code: 'salt_reuse',
            message: 'commitment salt was reused within this session',
            participantId: intent.participantId,
            commitmentId: action.reveal.commitmentId,
          });
        } else {
          seenSalts.set(action.reveal.salt, identity);
        }
        const key = commitmentKey(intent.participantId, action.reveal.commitmentId);
        const commitment = commitments.get(key);
        if (!commitment || commitment.revealed) {
          throw new SessionConflictError('reveal references an unknown or revealed commitment');
        }
        const actual = createCommitmentHash(
          {
            sessionId: this.options.sessionId,
            seat: intent.participantId,
            commitmentId: commitment.envelope.commitmentId,
            windowRef: commitment.windowRef,
          },
          action.reveal.salt,
          action.reveal.payload,
        );
        if (actual !== commitment.envelope.hash) {
          draft.seenSalts = seenSalts;
          return {
            inputs,
            warnings,
            rejection: {
              kind: 'rejection',
              code: 'commit_mismatch',
              tick: draft.tick,
              participantId: intent.participantId,
              submissionId: intent.submissionId,
              commitmentId: action.reveal.commitmentId,
              scheme: COMMITMENT_SCHEME,
              attemptedReveal: {
                salt: action.reveal.salt,
                payload: structuredClone(action.reveal.payload),
              },
              ...(intent.clientTime === undefined ? {} : { clientTime: intent.clientTime }),
              ...(intent.prevChainHash === undefined
                ? {}
                : { prevChainHash: intent.prevChainHash }),
              ...(intent.sig === undefined ? {} : { sig: intent.sig }),
            },
          };
        }
        commitment.revealed = true;
        action.verifiedPayload = structuredClone(action.reveal.payload);
      }
      inputs.push({
        participantId: intent.participantId,
        submissionId: intent.submissionId,
        action,
        ...(intent.clientTime === undefined ? {} : { clientTime: intent.clientTime }),
        ...(intent.prevChainHash === undefined
          ? {}
          : { prevChainHash: intent.prevChainHash }),
        ...(intent.sig === undefined ? {} : { sig: intent.sig }),
      });
    }
    draft.commitments = commitments;
    draft.nextCommitmentIds = nextCommitmentIds;
    draft.seenSalts = seenSalts;
    return { inputs, warnings };
  }

  private resolveOnce(
    draft: KernelState<TState, TCommand, TView>,
    cause: 'complete' | 'timeout' | 'tick',
    forcedInputs?: readonly CanonicalInput[],
  ): {
    event?: Omit<Extract<SessionEvent, { kind: 'resolution' }>, keyof SessionEventBase>;
    rejection?: Omit<Extract<SessionEvent, { kind: 'rejection' }>, keyof SessionEventBase>;
    deltas: ObservationDelta<TView>[];
    warnings: SessionWarning[];
  } {
    const intents = draft.window.participants
      .filter((seat) => Object.hasOwn(draft.window.intents, seat))
      .map((seat) => draft.window.intents[seat]!);
    if (cause === 'complete' && intents.length !== draft.window.participants.length) {
      throw new SessionAdvanceError('not_ready', 'the current intent window is not complete');
    }
    const collectedInputs = this.mapIntents(draft, intents);
    const mapped = forcedInputs && !collectedInputs.rejection
      ? {
        inputs: [...collectedInputs.inputs, ...forcedInputs],
        warnings: collectedInputs.warnings,
      }
      : collectedInputs;
    if ('rejection' in mapped && mapped.rejection) {
      const rejectedSeat = mapped.rejection.participantId;
      const nextIntents = { ...draft.window.intents };
      delete nextIntents[rejectedSeat];
      draft.window = { ...draft.window, intents: nextIntents };
      draft.receipts.delete(receiptKey(
        mapped.rejection.participantId,
        mapped.rejection.submissionId,
      ));
      return { rejection: mapped.rejection, deltas: [], warnings: mapped.warnings };
    }
    draft.reducerState = advanceTick(
      this.options.reducer,
      draft.reducerState,
      mapped.inputs.map((entry) => entry.action),
    );
    const resolvedTick = draft.tick;
    const resolvedCursor = draft.cursor;
    const acknowledgements: ObservationAcknowledgement[] = mapped.inputs.flatMap(
      ({ participantId, submissionId }) => (
        participantId === null || submissionId === null
          ? []
          : [{ participantId, submissionId }]
      ),
    );
    draft.cursor++;
    draft.tick++;
    const view = this.options.reducer.view(draft.reducerState);
    const deltas: ObservationDelta<TView>[] = [];
    for (const seat of this.options.seats) {
      const previous = draft.views.get(seat)!;
      const next = this.viewFor(draft.reducerState, seat);
      const revision = (draft.viewRevisions.get(seat) ?? 0) + 1;
      const nextDigest = viewDigest(next);
      const unchanged = canonicalJson(previous) === canonicalJson(next);
      const delta: ObservationDelta<TView> = {
        seat,
        transitionRevision: draft.transitionRevision + 1,
        viewRevision: revision,
        tick: draft.tick,
        codec: 'v1',
        acknowledgements: structuredClone(acknowledgements),
        rejections: [],
        body: unchanged
          ? { kind: 'unchanged' }
          : { kind: 'snapshot', view: structuredClone(next) },
        viewDigest: nextDigest,
      };
      draft.views.set(seat, structuredClone(next));
      draft.viewRevisions.set(seat, revision);
      deltas.push(delta);
    }
    draft.window = createIntentWindow(
      this.options.sessionId,
      draft.cursor,
      this.validatedParticipantsForView(view),
    );
    this.evictReceipts(draft);
    return {
      event: {
        kind: 'resolution',
        tick: resolvedTick,
        cursor: resolvedCursor,
        cause,
        consumed: intents.map(({ participantId, submissionId }) => ({
          participantId,
          submissionId,
        })),
        inputs: mapped.inputs.map((entry) => structuredClone(entry)),
        ...(forcedInputs?.[0] === undefined
          ? {}
          : { systemInput: structuredClone(forcedInputs[0]) }),
        result: {
          status: view.status,
          stars: view.stars ?? null,
          actionsUsed: view.hud.actionsUsed,
        },
      },
      deltas,
      warnings: mapped.warnings,
    };
  }

  private evictReceipts(draft: KernelState<TState, TCommand, TView>): void {
    const oldest = draft.cursor - this.limits.receiptRetention;
    for (const [key, receipt] of draft.receipts) {
      if (receipt.cursor < oldest) {
        draft.receipts.delete(key);
        draft.expiredReceiptKeys.add(key);
      }
    }
    const maximumTombstones = Math.max(
      this.options.seats.length,
      this.options.seats.length * Math.max(1, this.limits.receiptRetention),
    );
    while (draft.expiredReceiptKeys.size > maximumTombstones) {
      const first = draft.expiredReceiptKeys.values().next().value as string | undefined;
      if (first === undefined) break;
      draft.expiredReceiptKeys.delete(first);
    }
  }

  private rejectionDeltas(
    draft: KernelState<TState, TCommand, TView>,
    rejection: Pick<
      Extract<SessionEvent, { kind: 'rejection' }>,
      'tick' | 'participantId' | 'submissionId' | 'code'
    >,
  ): ObservationDelta<TView>[] {
    const transitionRevision = draft.transitionRevision + 1;
    return this.options.seats.map((seat) => {
      const view = draft.views.get(seat)!;
      return {
        seat,
        transitionRevision,
        viewRevision: draft.viewRevisions.get(seat)!,
        tick: draft.tick,
        codec: 'v1',
        acknowledgements: [],
        rejections: [{
          seat,
          transitionRevision,
          tick: rejection.tick,
          participantId: rejection.participantId,
          submissionId: rejection.submissionId,
          code: rejection.code,
        }],
        body: { kind: 'unchanged' },
        viewDigest: viewDigest(view),
      };
    });
  }

  private rejectionNoticesSince(
    seat: string,
    afterTransitionRevision: number,
  ): ObservationRejectionNotice[] {
    if (!this.options.seats.includes(seat)) throw new RangeError(`unknown seat ${seat}`);
    return this.live.events.flatMap((event) => event.kind === 'rejection'
      && event.transitionRevision > afterTransitionRevision
      ? [{
        seat,
        transitionRevision: event.transitionRevision,
        tick: event.tick,
        participantId: event.participantId,
        submissionId: event.submissionId,
        code: event.code,
      }]
      : []);
  }

  prepareAdvance(target?: number): Prepared<AdvanceSummary<TView>> {
    const draft = this.forkLive();
    const rawEvents: RawSessionEvent[] = [];
    const deltas: ObservationDelta<TView>[] = [];
    const rejections: ObservationRejectionNotice[] = [];
    const warnings: SessionWarning[] = [];
    try {
      const currentView = this.options.reducer.view(draft.reducerState);
      if (currentView.status !== 'playing') {
        throw new SessionAdvanceError('terminal', 'session is already terminal');
      }
      let requested = 1;
      let partial = false;
      if (this.options.cadence.mode === 'turns') {
        if (target !== undefined) {
          throw new SessionAdvanceError('invalid_target', 'target is forbidden in turns mode');
        }
      } else {
        if (target === undefined) target = draft.tick;
        if (!Number.isSafeInteger(target) || target < 0) {
          throw new SessionAdvanceError('invalid_target', 'target must be a non-negative safe integer');
        }
        if (target < draft.tick) {
          throw new SessionAdvanceError('stale_target', 'target precedes the current tick');
        }
        if (target - draft.tick > this.limits.maxFutureTicks) {
          throw new SessionAdvanceError(
            'invalid_target',
            'target exceeds maxFutureTicks',
          );
        }
        requested = target - draft.tick + 1;
        if (requested > this.limits.maxCatchUpTicks) {
          requested = this.limits.maxCatchUpTicks;
          partial = true;
        }
      }
      let resolutions = 0;
      for (let index = 0; index < requested; index++) {
        const ready = draft.window.participants.every(
          (seat) => Object.hasOwn(draft.window.intents, seat),
        );
        const cause = this.options.cadence.mode === 'turns'
          ? 'complete'
          : ready ? 'complete' : 'tick';
        const resolved = this.resolveOnce(draft, cause);
        warnings.push(...resolved.warnings);
        if (resolved.rejection) {
          rawEvents.push(resolved.rejection);
          rejections.push(...this.options.seats.map((seat) => ({
            seat,
            transitionRevision: this.live.transitionRevision + 1,
            tick: resolved.rejection!.tick,
            participantId: resolved.rejection!.participantId,
            submissionId: resolved.rejection!.submissionId,
            code: resolved.rejection!.code,
          })));
          deltas.push(...this.rejectionDeltas(draft, resolved.rejection));
          break;
        }
        if (resolved.event) {
          rawEvents.push(resolved.event);
          deltas.push(...resolved.deltas);
          resolutions++;
        }
        if (this.options.reducer.view(draft.reducerState).status !== 'playing') break;
      }
      const digest = this.digestState(draft);
      if (resolutions > 0 || rawEvents.at(-1)?.kind === 'rejection') {
        rawEvents.push({ kind: 'checkpoint', tick: draft.tick, digest });
      }
      const result: AdvanceSummary<TView> = {
        resolutions,
        partial,
        cursor: draft.cursor,
        tick: draft.tick,
        digest,
        deltas,
        rejections,
        warnings,
      };
      return this.makePrepared(draft, rawEvents, deltas, result);
    } catch (error) {
      this.discardDraft(draft);
      throw error;
    }
  }

  prepareTimeout(
    timeout: TimeoutInput,
    forcedInput: SubmittedAction,
  ): Prepared<AdvanceSummary<TView>> {
    if (typeof timeout.timeoutId !== 'string' || timeout.timeoutId.length === 0) {
      throw new TypeError('timeoutId must be a non-empty string');
    }
    if (typeof timeout.reason !== 'string' || timeout.reason.length === 0) {
      throw new TypeError('timeout reason must be a non-empty string');
    }
    if (timeout.timeoutPolicyRef !== undefined
      && (typeof timeout.timeoutPolicyRef !== 'string'
        || timeout.timeoutPolicyRef.length === 0)) {
      throw new TypeError('timeoutPolicyRef must be a non-empty string');
    }
    if (!Number.isSafeInteger(timeout.tick) || timeout.tick !== this.live.tick) {
      throw new SessionAdvanceError('stale_target', 'timeout tick must equal the open tick');
    }
    const participantId = timeout.participantId ?? null;
    if (participantId !== null) {
      if (!this.live.window.participants.includes(participantId)) {
        throw new SessionConflictError('timeout participant is not eligible in the open window');
      }
      if (Object.hasOwn(this.live.window.intents, participantId)) {
        throw new SessionConflictError('timeout participant already submitted in the open window');
      }
    }
    if (forcedInput.seat !== undefined) {
      if (!this.live.window.participants.includes(forcedInput.seat)) {
        throw new SessionConflictError('timeout system input names a seat outside the open window');
      }
      if (participantId === null) {
        throw new SessionConflictError(
          'window timeout system input cannot name a participant seat',
        );
      }
      if (forcedInput.seat !== participantId) {
        throw new SessionConflictError('timeout system input cannot impersonate another seat');
      }
    }
    if (forcedInput.commit !== undefined
      || forcedInput.reveal !== undefined
      || forcedInput.verifiedPayload !== undefined) {
      throw new SessionConflictError(
        'timeout system input cannot carry commitment verification fields',
      );
    }
    const draft = this.forkLive();
    try {
      if (this.options.reducer.view(draft.reducerState).status !== 'playing') {
        throw new SessionAdvanceError('terminal', 'session is already terminal');
      }
      const windowRef = draft.cursor;
      const action = actionCopy(forcedInput);
      if (participantId !== null) action.seat ??= participantId;
      const canonical: CanonicalInput = {
        participantId,
        submissionId: null,
        action,
      };
      const resolved = this.resolveOnce(draft, 'timeout', [canonical]);
      const rawEvents: RawSessionEvent[] = [{
        kind: 'timeout',
        tick: timeout.tick,
        timeoutId: timeout.timeoutId,
        windowRef,
        participantId,
        reason: timeout.reason,
        ...(timeout.timeoutPolicyRef === undefined
          ? {}
          : { timeoutPolicyRef: timeout.timeoutPolicyRef }),
      }];
      if (resolved.rejection) rawEvents.push(resolved.rejection);
      if (resolved.event) rawEvents.push(resolved.event);
      const deltas = resolved.deltas;
      const rejections: ObservationRejectionNotice[] = resolved.rejection
        ? this.options.seats.map((seat) => ({
          seat,
          transitionRevision: this.live.transitionRevision + 1,
          tick: resolved.rejection!.tick,
          participantId: resolved.rejection!.participantId,
          submissionId: resolved.rejection!.submissionId,
          code: resolved.rejection!.code,
        }))
        : [];
      if (resolved.rejection) deltas.push(...this.rejectionDeltas(draft, resolved.rejection));
      const digest = this.digestState(draft);
      if (resolved.event || resolved.rejection) {
        rawEvents.push({ kind: 'checkpoint', tick: draft.tick, digest });
      }
      const result: AdvanceSummary<TView> = {
        resolutions: resolved.event ? 1 : 0,
        partial: false,
        cursor: draft.cursor,
        tick: draft.tick,
        digest,
        deltas,
        rejections,
        warnings: resolved.warnings,
      };
      return this.makePrepared(draft, rawEvents, deltas, result);
    } catch (error) {
      this.discardDraft(draft);
      throw error;
    }
  }

  prepareExtension(lane: string, record: JsonObject): Prepared<void> {
    if (this.options.reducer.view(this.live.reducerState).status !== 'playing') {
      throw new SessionAdvanceError('terminal', 'session is already terminal');
    }
    if (typeof lane !== 'string' || lane.length === 0) {
      throw new TypeError('lane must be a non-empty string');
    }
    const canonical = canonicalJson(record);
    if (new TextEncoder().encode(canonical).length > this.limits.maxExtensionBytes) {
      throw new RangeError('extension record exceeds maxExtensionBytes');
    }
    const draft = this.forkLive();
    try {
      return this.makePrepared(draft, [{
        kind: 'extension',
        tick: draft.tick,
        lane,
        record: structuredClone(record),
      }], [], undefined);
    } catch (error) {
      this.discardDraft(draft);
      throw error;
    }
  }

  commit(prepared: Prepared<unknown>): void {
    const state = this.preparedState(prepared);
    if (prepared.baseTransitionRevision !== this.live.transitionRevision) {
      state.completion = 'aborted';
      for (const draft of state.drafts) this.isolation.discard?.(draft);
      throw new PreparedTransitionError(
        'stale',
        `prepared base revision ${prepared.baseTransitionRevision} `
        + `does not match live revision ${this.live.transitionRevision}`,
      );
    }
    if (state.noop) {
      state.completion = 'committed';
      for (const draft of state.drafts) this.isolation.discard?.(draft);
      return;
    }
    const previous = this.live.reducerState;
    this.live = state.next;
    for (const event of prepared.events) {
      if (event.kind === 'intent-accepted') {
        this.historicalSubmissionKeys.add(
          receiptKey(event.participantId, event.submissionId),
        );
      }
    }
    state.completion = 'committed';
    for (const draft of state.drafts) {
      if (draft !== state.next.reducerState) this.isolation.discard?.(draft);
    }
    this.isolation.retire?.(previous);
  }

  abort(prepared: Prepared<unknown>): void {
    const state = this.preparedState(prepared, true);
    if (state.completion === 'aborted') return;
    state.completion = 'aborted';
    for (const draft of state.drafts) this.isolation.discard?.(draft);
  }

  observe(seat: string): TView {
    const view = this.live.views.get(seat);
    if (view === undefined) throw new RangeError(`unknown seat ${seat}`);
    return structuredClone(view);
  }

  observeAll(): Readonly<Record<string, TView>> {
    return Object.freeze(Object.fromEntries(
      this.options.seats.map((seat) => [seat, this.observe(seat)]),
    ));
  }

  cursor(): number {
    return this.live.cursor;
  }

  tick(): number {
    return this.live.tick;
  }

  viewRevision(seat: string): number {
    const revision = this.live.viewRevisions.get(seat);
    if (revision === undefined) throw new RangeError(`unknown seat ${seat}`);
    return revision;
  }

  snapshot(seat: string, afterTransitionRevision = 0): ObservationDelta<TView> {
    if (!Number.isSafeInteger(afterTransitionRevision)
      || afterTransitionRevision < 0
      || afterTransitionRevision > this.live.transitionRevision) {
      throw new RangeError('afterTransitionRevision must identify committed session history');
    }
    const view = this.observe(seat);
    return {
      seat,
      transitionRevision: this.live.transitionRevision,
      viewRevision: this.viewRevision(seat),
      tick: this.live.tick,
      codec: 'v1',
      acknowledgements: [],
      rejections: this.rejectionNoticesSince(seat, afterTransitionRevision),
      body: { kind: 'snapshot', view },
      viewDigest: viewDigest(view),
    };
  }

  sessionHeader(): SessionHeader {
    return structuredClone(this.header);
  }

  liveTranscript(): SessionTranscript {
    return {
      header: structuredClone(this.header),
      events: structuredClone(this.live.events),
    };
  }

  private digestState(state: KernelState<TState, TCommand, TView>): number {
    return fnv1a(canonicalJson({
      cursor: state.cursor,
      tick: state.tick,
      views: Object.fromEntries(
        [...state.views.entries()].sort(([left], [right]) => left.localeCompare(right)),
      ),
    }));
  }

  digest(): number {
    return this.digestState(this.live);
  }

  private rehydrate(transcript: SessionTranscript<TLevel>): void {
    if (canonicalJson(transcript.header) !== canonicalJson(this.header)) {
      throw new TypeError('transcript header does not match kernel options');
    }
    const events = [...transcript.events];
    validateTimeoutAudit(transcript.header, events);
    let previousTransitionRevision = 0;
    for (const event of events) {
      if (!Number.isSafeInteger(event.hostTime) || event.hostTime < 0) {
        throw new TypeError('session event hostTime must be non-negative UTC milliseconds');
      }
      if (event.transitionRevision < previousTransitionRevision) {
        throw new TypeError('transcript transition revisions must be monotonic');
      }
      previousTransitionRevision = event.transitionRevision;
      if (event.kind === 'intent-accepted') {
        this.historicalSubmissionKeys.add(
          receiptKey(event.participantId, event.submissionId),
        );
        const submission: CommandSubmission<TCommand> = {
          protocol: PROTOCOL_ID,
          protocolVersion: PROTOCOL_VERSION,
          sessionId: this.options.sessionId,
          tickId: this.live.window.tickId,
          revision: this.live.window.revision,
          participantId: event.participantId,
          submissionId: event.submissionId,
          command: structuredClone(event.command as TCommand),
          ...(event.clientTime === undefined ? {} : { clientTime: event.clientTime }),
          ...(event.prevChainHash === undefined
            ? {}
            : { prevChainHash: event.prevChainHash }),
          ...(event.sig === undefined ? {} : { sig: event.sig }),
        };
        const collected = collectIntent(this.live.window, submission);
        this.live.window = collected.window;
        const submittedParticipants = this.live.window.participants.filter(
          (seat) => Object.hasOwn(this.live.window.intents, seat),
        );
        const awaitingParticipants = this.live.window.participants.filter(
          (seat) => !Object.hasOwn(this.live.window.intents, seat),
        );
        const receipt: IngestReceipt = {
          status: 'accepted',
          participantId: event.participantId,
          submissionId: event.submissionId,
          cursor: event.revision,
          tick: event.tick,
          submittedParticipants,
          awaitingParticipants,
        };
        this.live.receipts.set(receiptKey(event.participantId, event.submissionId), {
          canonicalCommand: event.canonicalCommand,
          tickId: submission.tickId,
          receipt,
          cursor: event.revision,
        });
      } else if (event.kind === 'resolution') {
        for (const { participantId, action } of event.inputs) {
          if (!participantId) continue;
          if (action.commit) {
            const expected = this.live.nextCommitmentIds.get(participantId) ?? 0;
            if (action.commit.commitmentId !== expected) {
              throw new TypeError(
                `transcript commitmentId ${action.commit.commitmentId} must be ${expected}`,
              );
            }
            this.live.commitments.set(commitmentKey(participantId, expected), {
              envelope: structuredClone(action.commit),
              seat: participantId,
              windowRef: event.tick,
              revealed: false,
            });
            this.live.nextCommitmentIds.set(participantId, expected + 1);
          } else if (action.reveal) {
            const identity = commitmentKey(
              participantId,
              action.reveal.commitmentId,
            );
            this.live.seenSalts.set(
              action.reveal.salt,
              this.live.seenSalts.get(action.reveal.salt) ?? identity,
            );
            const commitment = this.live.commitments.get(
              commitmentKey(participantId, action.reveal.commitmentId),
            );
            if (!commitment || commitment.revealed) {
              throw new TypeError('transcript reveal references an unknown or revealed commitment');
            }
            const actual = createCommitmentHash(
              {
                sessionId: this.options.sessionId,
                seat: participantId,
                commitmentId: commitment.envelope.commitmentId,
                windowRef: commitment.windowRef,
              },
              action.reveal.salt,
              action.reveal.payload,
            );
            if (actual !== commitment.envelope.hash) {
              throw new TypeError('transcript contains an unrecorded commitment mismatch');
            }
            commitment.revealed = true;
          }
        }
        this.live.reducerState = advanceTick(
          this.options.reducer,
          this.live.reducerState,
          event.inputs.map(({ action }) => actionCopy(action)),
        );
        this.live.cursor = event.cursor + 1;
        this.live.tick = event.tick + 1;
        const view = this.options.reducer.view(this.live.reducerState);
        this.live.window = createIntentWindow(
          this.options.sessionId,
          this.live.cursor,
          this.validatedParticipantsForView(view),
        );
        for (const seat of this.options.seats) {
          this.live.views.set(seat, this.viewFor(this.live.reducerState, seat));
          this.live.viewRevisions.set(seat, (this.live.viewRevisions.get(seat) ?? 0) + 1);
        }
        this.evictReceipts(this.live);
      } else if (event.kind === 'rejection') {
        const identity = commitmentKey(event.participantId, event.commitmentId);
        this.live.seenSalts.set(
          event.attemptedReveal.salt,
          this.live.seenSalts.get(event.attemptedReveal.salt) ?? identity,
        );
        const intents = { ...this.live.window.intents };
        delete intents[event.participantId];
        this.live.window = { ...this.live.window, intents };
        this.live.receipts.delete(receiptKey(
          event.participantId,
          event.submissionId,
        ));
      }
      this.live.transitionRevision = Math.max(
        this.live.transitionRevision,
        event.transitionRevision,
      );
      this.live.events.push(structuredClone(event));
    }
  }
}

/** Create a new synchronous, IO-free authoritative session kernel. */
export function createSessionKernel<
  TLevel,
  TState,
  TCommand extends JsonValue,
  TView extends TickView<unknown, unknown>,
>(
  options: SessionKernelOptions<TLevel, TState, TCommand, TView>,
): SessionKernel<TCommand, TView> {
  return new SessionKernelImpl(options);
}

/** Reconstruct a kernel from its durable accepted-intent and resolution log. */
export function rehydrateKernel<
  TLevel,
  TState,
  TCommand extends JsonValue,
  TView extends TickView<unknown, unknown>,
>(
  options: SessionKernelOptions<TLevel, TState, TCommand, TView>,
  transcript: SessionTranscript<TLevel>,
): SessionKernel<TCommand, TView> {
  return new SessionKernelImpl(options, transcript);
}

function replayInput(input: CanonicalInput, perm: readonly number[]): ReplayResolutionInput {
  const action = input.action;
  const canonicalMatch = /^Action ([1-9]\d*)$/.exec(action.id);
  const canonicalIndex = canonicalMatch ? Number(canonicalMatch[1]) - 1 : -1;
  const wireIndex = perm.indexOf(canonicalIndex);
  return {
    wireId: wireIndex < 0 ? action.id : `Action ${wireIndex + 1}`,
    canonicalId: action.id,
    ...(action.x === undefined ? {} : { x: action.x }),
    ...(action.y === undefined ? {} : { y: action.y }),
    ...(action.index === undefined ? {} : { index: action.index }),
    ...(action.boardId === undefined ? {} : { boardId: action.boardId }),
    ...(action.zoneId === undefined ? {} : { zoneId: action.zoneId }),
    ...(action.seat === undefined ? {} : { seat: action.seat }),
    ...(action.targets === undefined ? {} : { targets: action.targets }),
    ...(action.commit === undefined ? {} : { commit: action.commit }),
    ...(action.reveal === undefined ? {} : { reveal: action.reveal }),
    ...(action.verifiedPayload === undefined ? {} : { verifiedPayload: action.verifiedPayload }),
    ...(input.clientTime === undefined ? {} : { clientTime: input.clientTime }),
    ...(input.prevChainHash === undefined ? {} : { prevChainHash: input.prevChainHash }),
    ...(input.sig === undefined ? {} : { sig: input.sig }),
  };
}

function timeoutSystemInput(
  event: Extract<SessionEvent, { kind: 'resolution' }>,
): CanonicalInput | undefined {
  return event.systemInput
    ?? [...event.inputs].reverse().find((input) => input.submissionId === null);
}

function validateTimeoutAudit(
  header: SessionHeader,
  events: readonly SessionEvent[],
): void {
  for (const [index, event] of events.entries()) {
    if (event.kind === 'timeout') {
      if (typeof event.timeoutId !== 'string' || event.timeoutId.length === 0) {
        throw new TypeError('timeout audit event must name a non-empty timeoutId');
      }
      if (typeof event.reason !== 'string' || event.reason.length === 0) {
        throw new TypeError('timeout audit event must name a non-empty reason');
      }
      if (event.timeoutPolicyRef !== undefined
        && (typeof event.timeoutPolicyRef !== 'string'
          || event.timeoutPolicyRef.length === 0)) {
        throw new TypeError('timeout audit event timeoutPolicyRef must be non-empty');
      }
      if (event.participantId !== null && !header.seats.includes(event.participantId)) {
        throw new TypeError('timeout audit participant must be a declared session seat');
      }
      const outcome = events[index + 1];
      if (outcome?.kind === 'rejection') {
        if (outcome.transitionRevision !== event.transitionRevision
          || outcome.tick !== event.tick) {
          throw new TypeError(
            'timeout audit event must immediately precede its matching rejection',
          );
        }
        continue;
      }
      if (outcome?.kind !== 'resolution'
        || outcome.cause !== 'timeout'
        || outcome.transitionRevision !== event.transitionRevision
        || outcome.tick !== event.tick
        || outcome.cursor !== event.windowRef) {
        throw new TypeError(
          'timeout audit event must immediately precede its matching resolution or rejection',
        );
      }
      const systemInput = timeoutSystemInput(outcome);
      if (!systemInput || systemInput.participantId !== event.participantId) {
        throw new TypeError('timeout audit participant must match the recorded system input');
      }
      if (event.participantId === null && systemInput.action.seat !== undefined) {
        throw new TypeError('window timeout audit input cannot name a participant seat');
      }
      if (event.participantId !== null
        && systemInput.action.seat !== event.participantId) {
        throw new TypeError('timeout audit participant must match the system action seat');
      }
    } else if (event.kind === 'resolution' && event.cause === 'timeout') {
      const timeout = events[index - 1];
      if (timeout?.kind !== 'timeout'
        || timeout.transitionRevision !== event.transitionRevision) {
        throw new TypeError('timeout resolution must immediately follow its audit event');
      }
    }
  }
}

/** Purely project a terminal live transcript into portable replay v1.1. */
export function finalizeReplay<TLevel>(
  transcript: SessionTranscript<TLevel>,
  options: FinalizeOptions,
): ReplayArtifact<TLevel> {
  validateTimeoutAudit(transcript.header, transcript.events);
  const resolutions = transcript.events.filter(
    (event): event is Extract<SessionEvent, { kind: 'resolution' }> => event.kind === 'resolution',
  );
  const terminal = resolutions.at(-1);
  if (!terminal || terminal.result.status === 'playing') {
    throw new SessionAdvanceError('terminal', 'only a terminal transcript can be finalized');
  }
  const records: ReplayRecord[] = [];
  for (const event of transcript.events) {
    if (event.kind === 'resolution') {
      const systemInput = event.cause === 'timeout'
        ? timeoutSystemInput(event)
        : undefined;
      records.push({
        kind: 'resolution',
        n: records.length,
        levelIndex: 0,
        tick: event.tick,
        inputs: event.inputs.map((input) => replayInput(input, options.perm)),
        cause: event.cause,
        ...(options.includeHostTime ? { hostTime: event.hostTime } : {}),
        ...(event.cause === 'timeout' && systemInput
          ? { systemInput: replayInput(systemInput, options.perm) }
          : {}),
      });
    } else if (event.kind === 'timeout') {
      records.push({
        kind: 'timeout',
        n: records.length,
        levelIndex: 0,
        tick: event.tick,
        timeoutId: event.timeoutId,
        windowRef: event.windowRef,
        participantId: event.participantId,
        reason: event.reason,
        ...(event.timeoutPolicyRef === undefined
          ? {}
          : { timeoutPolicyRef: event.timeoutPolicyRef }),
        ...(options.includeHostTime ? { hostTime: event.hostTime } : {}),
      });
    } else if (event.kind === 'extension') {
      records.push({
        kind: 'extension',
        n: records.length,
        levelIndex: 0,
        lane: event.lane,
        record: structuredClone(event.record),
        ...(options.includeHostTime ? { hostTime: event.hostTime } : {}),
      });
    } else if (event.kind === 'checkpoint') {
      records.push({
        kind: 'checkpoint',
        n: records.length,
        levelIndex: 0,
        tick: event.tick,
        digest: event.digest,
        ...(options.includeHostTime ? { hostTime: event.hostTime } : {}),
      });
    } else if (event.kind === 'rejection') {
      records.push({
        kind: 'commit-mismatch',
        n: records.length,
        levelIndex: 0,
        tick: event.tick,
        participantId: event.participantId,
        submissionId: event.submissionId,
        commitmentId: event.commitmentId,
        scheme: event.scheme,
        ...(event.clientTime === undefined ? {} : { clientTime: event.clientTime }),
        ...(event.prevChainHash === undefined
          ? {}
          : { prevChainHash: event.prevChainHash }),
        ...(event.sig === undefined ? {} : { sig: event.sig }),
        ...(options.includeHostTime ? { hostTime: event.hostTime } : {}),
        ...(options.visibility && options.visibility !== 'full'
          ? {}
          : { attemptedReveal: structuredClone(event.attemptedReveal) }),
      });
    }
  }
  const replayActions = resolutions.flatMap((event) => event.inputs.map((input) => ({
    ...replayInput(input, options.perm),
    tick: event.tick,
  })));
  const extensions: JsonObject = {
    ...(options.extensions ?? {}),
    ...(transcript.header.dmath === undefined
      ? {}
      : { dmath: structuredClone(transcript.header.dmath) as unknown as JsonValue }),
  };
  return createReplayArtifact({
    sessionId: transcript.header.sessionId,
    game: transcript.header.game,
    seed: transcript.header.seed,
    seedPolicy: transcript.header.seedPolicy,
    perm: options.perm,
    levels: [{
      id: transcript.header.levelId,
      ...(transcript.header.levelVersion === undefined
        ? {}
        : { version: transcript.header.levelVersion }),
      ...(transcript.header.seedPolicy === 'explicit'
        ? { seed: transcript.header.seed }
        : {}),
      level: transcript.header.level,
      result: {
        status: terminal.result.status,
        stars: terminal.result.stars,
        actionsUsed: terminal.result.actionsUsed,
      },
    }],
    actions: replayActions.map((action, n) => ({
      ...action,
      n,
      levelIndex: 0,
    })),
    records,
    ...(transcript.header.timeoutPolicy === undefined
      ? {}
      : { timeoutPolicy: structuredClone(transcript.header.timeoutPolicy) }),
    ...(options.visibility === undefined ? {} : { visibility: options.visibility }),
    ...(Object.keys(extensions).length === 0 ? {} : { extensions }),
  });
}

/**
 * Project an ordered, terminal sequence of one-level kernel transcripts into
 * one portable multi-level run. Per-level seeds must already equal the
 * derivation from `options.seed`.
 */
export function finalizeRunReplay<TLevel>(
  transcripts: readonly SessionTranscript<TLevel>[],
  options: FinalizeRunOptions,
): ReplayArtifact<TLevel> {
  if (transcripts.length === 0) {
    throw new RangeError('a run replay requires at least one transcript');
  }
  if (!Number.isSafeInteger(options.seed)
    || options.seed < 0
    || options.seed > 0xffff_ffff) {
    throw new RangeError('run seed must be an unsigned 32-bit integer');
  }
  const first = transcripts[0]!;
  const game = canonicalJson(first.header.game);
  const dmath = canonicalJson(first.header.dmath ?? null);
  const timeoutPolicy = canonicalJson(first.header.timeoutPolicy ?? null);
  const levels = [];
  const actions = [];
  const records: ReplayRecord[] = [];
  for (const [levelIndex, transcript] of transcripts.entries()) {
    if (transcript.header.sessionId !== first.header.sessionId) {
      throw new TypeError(`run transcript ${levelIndex} has a different sessionId`);
    }
    if (canonicalJson(transcript.header.game) !== game) {
      throw new TypeError(`run transcript ${levelIndex} has a different game`);
    }
    if (canonicalJson(transcript.header.dmath ?? null) !== dmath) {
      throw new TypeError(`run transcript ${levelIndex} has a different dmath declaration`);
    }
    if (canonicalJson(transcript.header.timeoutPolicy ?? null) !== timeoutPolicy) {
      throw new TypeError(`run transcript ${levelIndex} has a different timeout policy`);
    }
    if (transcript.header.seedPolicy !== 'explicit') {
      throw new TypeError(
        `run transcript ${levelIndex} must record its derived level seed as explicit`,
      );
    }
    const expectedSeed = runLevelSeed(options.seed, levelIndex);
    if (transcript.header.seed !== expectedSeed) {
      throw new TypeError(
        `run transcript ${levelIndex} seed must equal runLevelSeed(runSeed, ${levelIndex})`,
      );
    }
    const segment = finalizeReplay(transcript, {
      perm: options.perm,
      ...(options.visibility === undefined ? {} : { visibility: options.visibility }),
      ...(options.includeHostTime === undefined
        ? {}
        : { includeHostTime: options.includeHostTime }),
    });
    const level = segment.header.levels[0]!;
    if (levelIndex < transcripts.length - 1 && level.result.status !== 'won') {
      throw new TypeError(`run transcript ${levelIndex} must be won before another level`);
    }
    levels.push({
      id: level.id,
      ...(level.version === undefined ? {} : { version: level.version }),
      level: level.level,
      result: level.result,
    });
    for (const action of segment.actions) {
      const { kind: _kind, ...input } = action;
      actions.push({
        ...input,
        n: actions.length,
        levelIndex,
      });
    }
    for (const record of segment.records ?? []) {
      records.push({
        ...record,
        n: records.length,
        levelIndex,
      });
    }
  }

  const extensions: JsonObject = {
    ...(options.extensions ?? {}),
    ...(first.header.dmath === undefined
      ? {}
      : { dmath: structuredClone(first.header.dmath) as unknown as JsonValue }),
  };
  return createReplayArtifact({
    sessionId: first.header.sessionId,
    game: first.header.game,
    seed: options.seed,
    seedPolicy: GAOS_REPLAY_DERIVED_SEEDS,
    perm: options.perm,
    levels,
    actions,
    records,
    ...(first.header.timeoutPolicy === undefined
      ? {}
      : { timeoutPolicy: structuredClone(first.header.timeoutPolicy) }),
    ...(options.visibility === undefined ? {} : { visibility: options.visibility }),
    ...(Object.keys(extensions).length === 0 ? {} : { extensions }),
  });
}
