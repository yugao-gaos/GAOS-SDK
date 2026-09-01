/**
 * Product-neutral HTTP client for hosts that implement the GAOS tick protocol.
 *
 * Game observations and commands remain opaque. Product adapters such as Arena
 * build typed convenience methods on top of this boundary.
 */

import {
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  assertJsonObject,
  assertJsonValue,
  assertSubmissionSigningPosition,
  canonicalJson,
  isParticipantId,
  type CommandSubmission,
  type JsonObject,
  type JsonValue,
  type ProtocolExtensions,
  type SubmissionSigningPosition,
  type TickCursor,
  type TickResult,
} from './protocol.js';
import { bytesToHex, sha256 } from './engine/commitment.js';
import {
  signatureBytesFromBase64,
  submissionChainHashV1,
  submissionGenesisHashV1,
  submissionPreimageV1,
  submissionRosterHashV1,
  type SubmissionSeatKey,
} from './engine/submission-signatures.js';

/** Roster material a signing client declares, without pulling in `./engine`. */
export {
  SUBMISSION_SIGNATURE_ALGORITHM,
  SUBMISSION_SIGNATURE_SCHEME,
} from './engine/submission-signatures.js';
export type {
  SubmissionSeatKey,
  SubmissionSignaturePolicy,
  SubmissionSigningTier,
} from './engine/submission-signatures.js';

export interface SessionBinding extends TickCursor {
  protocol: typeof PROTOCOL_ID;
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  participantId: string;
  /** Carried from the envelope this binding was remembered from. */
  signingPosition?: SubmissionSigningPosition;
}

export interface SessionStart<TObservation = unknown> {
  sessionId: string;
  tick: TObservation;
  binding: SessionBinding;
}

export interface ExistingSessionHandle<
  TObservation = unknown,
> {
  sessionId: string;
  binding: SessionBinding;
  /** Full current GAOS tick envelope, not only its observation payload. */
  initialTick: TickResult<TObservation>;
  attachReceipt?: SessionAttachReceipt;
}

export interface SessionControllerIdentity {
  kind: 'human' | 'provider' | 'cli' | 'local-agent' | 'mixed';
  id: string;
  provider?: string;
  model?: string;
  version?: string;
}

export interface SessionPolicy {
  evaluation:
    | { kind: 'none' }
    | { kind: 'practice'; evaluator?: string }
    | {
        kind: 'official';
        benchmarkId: string;
        benchmarkVersion: string;
        manifestDigest: string;
      };
  durability: {
    attachable: boolean;
    retention?: { kind: 'host-policy'; policyId: string };
  };
  evidence:
    | { kind: 'none' }
    | { kind: 'replay' }
    | {
        kind: 'verification';
        attachReceipts?: boolean;
        verifierReference?: JsonObject;
      };
  publication:
    | { kind: 'none' }
    | { kind: 'eligible'; policyId: string; policyVersion: string };
  controller?: SessionControllerIdentity;
  extensions?: ProtocolExtensions;
}

export interface SessionAttachRequest {
  participantId?: string;
  requestId: string;
  controller?: SessionControllerIdentity;
  extensions?: ProtocolExtensions;
}

export interface SessionAttachReceipt {
  schema: 'gaos.session-attach-receipt.v1';
  sessionId: string;
  requestId: string;
  sequence: number;
  revision: number;
  transcriptDigest: string;
  stateDigest: string;
  attachedAt?: number;
  previousReceiptDigest?: string;
  receiptDigest: string;
  controller?: SessionControllerIdentity;
  extensions?: ProtocolExtensions;
}

export interface SessionAttach<TObservation = unknown> {
  sessionId: string;
  tick: TObservation;
  binding: SessionBinding;
  receipt?: SessionAttachReceipt;
  extensions?: ProtocolExtensions;
}

export interface SessionFinalizeRequest {
  requestId: string;
  metadata?: JsonObject;
  extensions?: ProtocolExtensions;
}

export interface SessionArtifactReference {
  kind: string;
  digest?: string;
  uri?: string;
  mediaType?: string;
  extensions?: ProtocolExtensions;
}

export interface SessionResult<TOutcome = JsonValue> {
  sessionId: string;
  status: 'finalized';
  outcome: TOutcome;
  replay?: JsonValue | string;
  evaluation?: JsonObject;
  artifacts?: readonly SessionArtifactReference[];
  extensions?: ProtocolExtensions;
}

/** Durable per-(session, seat) RFC-010 chain position. Plain JSON. */
export interface SubmissionChainState {
  schema: 'gaos.submission-chain.v1';
  sessionId: string;
  seat: string;
  /** Roster hash every link in this chain is bound to. */
  rosterHash: string;
  /** Canonical base64 hash the next submission must carry as `prevChainHash`. */
  chainHead: string;
  /** Submissions this chain has already advanced past. */
  submissions: number;
}

/** Identifies the submission a `sign` callback is being asked to authenticate. */
export interface SubmissionSigningContext {
  sessionId: string;
  seat: string;
  submissionId: string;
  cursor: number;
  tick: number;
  clientTime: number;
}

export interface SubmissionSigningOptions {
  /** Seat this client signs for. Defaults to the session binding's seat. */
  seat?: string;
  /** Roster declared in the session header; every chain binds to its hash. */
  seatKeys: readonly SubmissionSeatKey[];
  /**
   * Produce canonical padded base64 of the 64-byte Ed25519 signature over
   * `preimage`. The SDK never sees, holds, or derives the private key.
   */
  sign(
    preimage: Uint8Array,
    context: SubmissionSigningContext,
  ): Promise<string> | string;
  /** Client clock in UTC epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Chain position to continue from. Required when resuming a session this
   * client attached to, so an interrupted run continues its seat chain
   * instead of restarting at genesis and breaking every later link.
   */
  resume?: SubmissionChainState;
}

export interface SubmitCommandOptions {
  participantId?: string;
  submissionId?: string;
  cursor?: TickCursor;
  /**
   * Episode-local signing coordinates, when the host publishes them outside
   * the envelope. Overrides the envelope's own `signingPosition`.
   */
  signingPosition?: SubmissionSigningPosition;
  signal?: AbortSignal;
}

/** @deprecated Use SubmitCommandOptions. */
export type SubmitIntentOptions = SubmitCommandOptions;

export interface SessionHandle<
  TCommand = unknown,
  TObservation = unknown,
  TOutcome = JsonValue,
> {
  readonly sessionId: string;
  readonly participantId: string;
  readonly policy: SessionPolicy;
  readonly status: 'active' | 'terminal' | 'finalized' | 'closed';
  readonly attachReceipt?: SessionAttachReceipt;
  observe(options?: SessionCallOptions): Promise<TickResult<TObservation>>;
  act(command: TCommand, options?: SubmitIntentOptions): Promise<TickResult<TObservation>>;
  finalize(request?: Partial<SessionFinalizeRequest>): Promise<SessionResult<TOutcome>>;
  close(): void | Promise<void>;
}

export class ProtocolMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolMismatchError';
  }
}

export class GaosApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly error: string,
    public readonly code?: string,
    public readonly details?: Readonly<Record<string, unknown>>,
    public readonly responseBody?: string,
  ) {
    super(`HTTP ${status}: ${error}`);
    this.name = 'GaosApiError';
  }
}

export class IllegalActionRejected extends GaosApiError {
  constructor(
    status: number,
    error: string,
    code?: string,
    details?: Readonly<Record<string, unknown>>,
    responseBody?: string,
  ) {
    super(status, error, code, details, responseBody);
    this.name = 'IllegalActionRejected';
  }
}

export type CredentialProvider =
  | string
  | (() => string | null | undefined | Promise<string | null | undefined>);

export interface SessionClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxResponseBytes?: number;
}

export interface SessionCallOptions {
  signal?: AbortSignal;
}

export function parseSessionBinding(value: unknown): SessionBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolMismatchError('session binding must be an object');
  }
  const binding = value as Record<string, unknown>;
  if (binding['protocol'] !== PROTOCOL_ID || binding['protocolVersion'] !== PROTOCOL_VERSION) {
    throw new ProtocolMismatchError(`session binding must use ${PROTOCOL_ID} ${PROTOCOL_VERSION}`);
  }
  if (
    typeof binding['sessionId'] !== 'string'
    || !binding['sessionId'].trim()
    || typeof binding['tickId'] !== 'string'
    || !binding['tickId'].trim()
    || !Number.isSafeInteger(binding['revision'])
    || (binding['revision'] as number) < 0
    || typeof binding['participantId'] !== 'string'
    || !isParticipantId(binding['participantId'])
  ) {
    throw new ProtocolMismatchError('session binding cursor or participant is invalid');
  }
  return {
    protocol: PROTOCOL_ID,
    protocolVersion: PROTOCOL_VERSION,
    sessionId: binding['sessionId'],
    tickId: binding['tickId'],
    revision: binding['revision'] as number,
    participantId: binding['participantId'],
    ...(Object.hasOwn(binding, 'signingPosition')
      ? { signingPosition: parseSigningPosition(binding['signingPosition']) }
      : {}),
  };
}

function parseSigningPosition(value: unknown): SubmissionSigningPosition {
  try {
    assertSubmissionSigningPosition(value);
  } catch (error) {
    throw new ProtocolMismatchError(
      error instanceof Error ? error.message : 'signingPosition is invalid',
    );
  }
  return { cursor: value.cursor, tick: value.tick };
}

/**
 * Start one seat's RFC-010 chain at its roster-bound genesis link. Persist the
 * returned state and hand it back as `resume` when a run continues in another
 * process; a chain that silently restarts at genesis cannot be verified.
 */
export function createSubmissionChainState(
  sessionId: string,
  seat: string,
  seatKeys: readonly SubmissionSeatKey[],
): SubmissionChainState {
  assertNonEmptyString(sessionId, 'sessionId');
  if (!isParticipantId(seat)) {
    throw new ProtocolMismatchError('seat must match the portable ASCII seat-id pattern');
  }
  const rosterHash = submissionRosterHashV1(seatKeys);
  if (!seatKeys.some((entry) => entry.id === seat)) {
    throw new ProtocolMismatchError(`seatKeys does not declare seat ${seat}`);
  }
  return {
    schema: 'gaos.submission-chain.v1',
    sessionId,
    seat,
    rosterHash,
    chainHead: submissionGenesisHashV1(sessionId, seat, rosterHash),
    submissions: 0,
  };
}

/** Validate a persisted chain state against the session and roster it claims. */
function parseSubmissionChainState(
  value: unknown,
  sessionId: string,
  seat: string,
  rosterHash: string,
): SubmissionChainState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ProtocolMismatchError('submission chain state must be an object');
  }
  const state = value as unknown as SubmissionChainState;
  if (state.schema !== 'gaos.submission-chain.v1') {
    throw new ProtocolMismatchError('submission chain state has an unsupported schema');
  }
  if (state.sessionId !== sessionId || state.seat !== seat) {
    throw new ProtocolMismatchError('submission chain state names another session or seat');
  }
  if (state.rosterHash !== rosterHash) {
    throw new ProtocolMismatchError('submission chain state was bound to a different roster');
  }
  if (!Number.isSafeInteger(state.submissions) || state.submissions < 0) {
    throw new ProtocolMismatchError('submission chain state submissions must be a count');
  }
  try {
    signatureBytesFromBase64(state.chainHead, 'chainHead', 32);
  } catch (error) {
    throw new ProtocolMismatchError(
      error instanceof Error ? error.message : 'chainHead is invalid',
    );
  }
  return {
    schema: 'gaos.submission-chain.v1',
    sessionId,
    seat,
    rosterHash,
    chainHead: state.chainHead,
    submissions: state.submissions,
  };
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new ProtocolMismatchError(`${field} must be a non-empty string`);
  }
}

function receiptContent(receipt: Omit<SessionAttachReceipt, 'receiptDigest'>): JsonObject {
  return receipt as unknown as JsonObject;
}

/** Construct the portable digest over every receipt field except `receiptDigest`. */
export function sessionAttachReceiptDigest(
  receipt: Omit<SessionAttachReceipt, 'receiptDigest'>,
): string {
  assertJsonObject(receipt, 'session attach receipt');
  return bytesToHex(sha256(new TextEncoder().encode(
    canonicalJson(receiptContent(receipt)),
  )));
}

export function createSessionAttachReceipt(
  receipt: Omit<SessionAttachReceipt, 'schema' | 'receiptDigest'>,
): SessionAttachReceipt {
  const unsigned = {
    schema: 'gaos.session-attach-receipt.v1' as const,
    ...structuredClone(receipt),
  };
  return { ...unsigned, receiptDigest: sessionAttachReceiptDigest(unsigned) };
}

/** Independently verify receipt contents, monotonic order, and digest linkage. */
export function verifySessionAttachReceiptChain(
  receipts: readonly SessionAttachReceipt[],
): { valid: boolean; problems: string[] } {
  const problems: string[] = [];
  let previous: SessionAttachReceipt | undefined;
  for (const [index, receipt] of receipts.entries()) {
    if (receipt.schema !== 'gaos.session-attach-receipt.v1') {
      problems.push(`receipt ${index} has an unsupported schema`);
      continue;
    }
    const { receiptDigest, ...unsigned } = receipt;
    let computedDigest: string | undefined;
    try {
      computedDigest = sessionAttachReceiptDigest(unsigned);
    } catch {
      problems.push(`receipt ${index} is not canonical JSON`);
    }
    if (computedDigest !== undefined && computedDigest !== receiptDigest) {
      problems.push(`receipt ${index} digest does not match its contents`);
    }
    if (previous) {
      if (receipt.sessionId !== previous.sessionId) {
        problems.push(`receipt ${index} changes session identity`);
      }
      if (receipt.sequence !== previous.sequence + 1) {
        problems.push(`receipt ${index} sequence is not contiguous`);
      }
      if (receipt.revision < previous.revision) {
        problems.push(`receipt ${index} rolls revision backward`);
      }
      if (receipt.previousReceiptDigest !== previous.receiptDigest) {
        problems.push(`receipt ${index} does not link to the previous receipt`);
      }
    } else if (receipt.previousReceiptDigest !== undefined) {
      problems.push('first receipt unexpectedly links to an omitted predecessor');
    }
    previous = receipt;
  }
  return { valid: problems.length === 0, problems };
}

function parseSessionAttachReceipt(value: unknown): SessionAttachReceipt {
  try {
    assertJsonObject(value, 'attach receipt');
  } catch (error) {
    throw new ProtocolMismatchError(error instanceof Error ? error.message : 'attach receipt invalid');
  }
  const receipt = value as unknown as SessionAttachReceipt;
  if (
    receipt.schema !== 'gaos.session-attach-receipt.v1'
    || !Number.isSafeInteger(receipt.sequence)
    || receipt.sequence < 0
    || !Number.isSafeInteger(receipt.revision)
    || receipt.revision < 0
  ) {
    throw new ProtocolMismatchError('attach receipt schema or sequence is invalid');
  }
  for (const [field, item] of [
    ['sessionId', receipt.sessionId],
    ['requestId', receipt.requestId],
    ['transcriptDigest', receipt.transcriptDigest],
    ['stateDigest', receipt.stateDigest],
    ['receiptDigest', receipt.receiptDigest],
  ] as const) {
    assertNonEmptyString(item, `attach receipt ${field}`);
  }
  const { receiptDigest, ...unsigned } = receipt;
  if (sessionAttachReceiptDigest(unsigned) !== receiptDigest) {
    throw new ProtocolMismatchError('attach receipt digest does not match its contents');
  }
  return structuredClone(receipt);
}

function isParticipantList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isParticipantId);
}

export function parseTickResult<TObservation = unknown>(data: unknown): TickResult<TObservation> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ProtocolMismatchError('response is not an object');
  }
  const value = data as Record<string, unknown>;
  if (value['protocol'] !== PROTOCOL_ID || value['protocolVersion'] !== PROTOCOL_VERSION) {
    throw new ProtocolMismatchError(`expected ${PROTOCOL_ID} ${PROTOCOL_VERSION}`);
  }
  if (value['kind'] !== 'tick' && value['kind'] !== 'pending') {
    throw new ProtocolMismatchError('response kind must be tick or pending');
  }
  if (
    typeof value['sessionId'] !== 'string'
    || !value['sessionId'].trim()
    || typeof value['tickId'] !== 'string'
    || !value['tickId'].trim()
  ) {
    throw new ProtocolMismatchError('response sessionId/tickId missing');
  }
  if (
    !Number.isSafeInteger(value['revision'])
    || (value['revision'] as number) < 0
    || !Object.hasOwn(value, 'tick')
  ) {
    throw new ProtocolMismatchError('response revision/tick missing');
  }
  if (Object.hasOwn(value, 'extensions')) {
    try {
      assertJsonObject(value['extensions'], 'response extensions');
    } catch (error) {
      throw new ProtocolMismatchError(
        error instanceof Error ? error.message : 'response extensions invalid',
      );
    }
  }
  if (Object.hasOwn(value, 'signingPosition')) {
    parseSigningPosition(value['signingPosition']);
  }
  if (value['kind'] === 'pending') {
    if (
      !isParticipantList(value['submittedParticipants'])
      || !isParticipantList(value['awaitingParticipants'])
    ) {
      throw new ProtocolMismatchError('pending participant lists missing');
    }
    const submitted = value['submittedParticipants'];
    const awaiting = value['awaitingParticipants'];
    if (awaiting.length === 0) {
      throw new ProtocolMismatchError('pending envelope must await a participant');
    }
    if (new Set(submitted).size !== submitted.length || new Set(awaiting).size !== awaiting.length) {
      throw new ProtocolMismatchError('pending participant lists must be unique');
    }
    if (submitted.some((participantId) => awaiting.includes(participantId))) {
      throw new ProtocolMismatchError('pending participant lists must be disjoint');
    }
    const accepted = value['acceptedParticipantId'];
    if (
      Object.hasOwn(value, 'acceptedParticipantId')
      && (
        typeof accepted !== 'string'
        || !isParticipantId(accepted)
        || !submitted.includes(accepted)
      )
    ) {
      throw new ProtocolMismatchError('pending acceptedParticipantId must be submitted');
    }
  }
  return value as unknown as TickResult<TObservation>;
}

export function parseSessionAttach<TObservation = unknown>(
  data: unknown,
  requestedSessionId?: string,
): SessionAttach<TObservation> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ProtocolMismatchError('session attachment must be an object');
  }
  const value = data as Record<string, unknown>;
  assertNonEmptyString(value['sessionId'], 'attachment sessionId');
  if (requestedSessionId !== undefined && value['sessionId'] !== requestedSessionId) {
    throw new ProtocolMismatchError('attachment session does not match request');
  }
  if (!Object.hasOwn(value, 'tick')) {
    throw new ProtocolMismatchError('attachment tick missing');
  }
  const binding = parseSessionBinding(value['binding']);
  if (binding.sessionId !== value['sessionId']) {
    throw new ProtocolMismatchError('attachment binding does not match session');
  }
  let extensions: ProtocolExtensions | undefined;
  if (Object.hasOwn(value, 'extensions')) {
    try {
      assertJsonObject(value['extensions'], 'attachment extensions');
      extensions = structuredClone(value['extensions']);
    } catch (error) {
      throw new ProtocolMismatchError(
        error instanceof Error ? error.message : 'attachment extensions invalid',
      );
    }
  }
  return {
    sessionId: value['sessionId'],
    tick: value['tick'] as TObservation,
    binding,
    ...(Object.hasOwn(value, 'receipt')
      ? { receipt: parseSessionAttachReceipt(value['receipt']) }
      : {}),
    ...(extensions ? { extensions } : {}),
  };
}

export function parseSessionResult<TOutcome = JsonValue>(
  data: unknown,
  requestedSessionId?: string,
): SessionResult<TOutcome> {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ProtocolMismatchError('session result must be an object');
  }
  const value = data as Record<string, unknown>;
  assertNonEmptyString(value['sessionId'], 'result sessionId');
  if (requestedSessionId !== undefined && value['sessionId'] !== requestedSessionId) {
    throw new ProtocolMismatchError('result session does not match request');
  }
  if (value['status'] !== 'finalized' || !Object.hasOwn(value, 'outcome')) {
    throw new ProtocolMismatchError('session result must be finalized with an outcome');
  }
  try {
    assertJsonValue(value['outcome'], 'session result outcome');
    if (Object.hasOwn(value, 'replay')) assertJsonValue(value['replay'], 'session result replay');
    if (Object.hasOwn(value, 'evaluation')) {
      assertJsonObject(value['evaluation'], 'session result evaluation');
    }
    if (Object.hasOwn(value, 'extensions')) {
      assertJsonObject(value['extensions'], 'session result extensions');
    }
    if (Object.hasOwn(value, 'artifacts')) {
      if (!Array.isArray(value['artifacts'])) {
        throw new TypeError('session result artifacts must be an array');
      }
      for (const artifact of value['artifacts']) {
        assertJsonObject(artifact, 'session result artifact');
        assertNonEmptyString(artifact['kind'], 'session result artifact kind');
      }
    }
  } catch (error) {
    if (error instanceof ProtocolMismatchError) throw error;
    throw new ProtocolMismatchError(
      error instanceof Error ? error.message : 'session result invalid',
    );
  }
  return structuredClone(value) as unknown as SessionResult<TOutcome>;
}

function awaitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

class ResponseTooLargeError extends Error {}

async function readResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let output = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new ResponseTooLargeError(`HTTP response exceeds ${maxBytes} bytes`);
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

interface RegisteredSigner {
  seat: string;
  seatKeys: readonly SubmissionSeatKey[];
  sign(
    preimage: Uint8Array,
    context: SubmissionSigningContext,
  ): Promise<string> | string;
  now: () => number;
  state: SubmissionChainState;
  /** Signed material per submissionId, so an exact retry resends it byte-identically. */
  signed: Map<string, {
    clientTime: number;
    prevChainHash: string;
    sig: string;
    nextChainHead: string;
    /** True once the host accepted it and the chain moved past this link. */
    accepted: boolean;
  }>;
}

function signerKey(sessionId: string, seat: string): string {
  return `${sessionId}\u0000${seat}`;
}

export class SessionClient {
  private readonly bindings = new Map<string, SessionBinding>();
  private readonly commandSequences = new Map<string, number>();
  private readonly signers = new Map<string, RegisteredSigner>();
  /** Sessions this client joined rather than created; their chains pre-exist. */
  private readonly attachedSessions = new Set<string>();
  private readonly request: typeof fetch;
  private readonly baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly credential?: CredentialProvider,
    private readonly options: SessionClientOptions = {},
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.request = options.fetch ?? fetch;
    if (
      options.timeoutMs !== undefined
      && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0)
    ) {
      throw new RangeError('timeoutMs must be a non-negative safe integer');
    }
    if (
      options.maxResponseBytes !== undefined
      && (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 1)
    ) {
      throw new RangeError('maxResponseBytes must be a positive safe integer');
    }
  }

  private remember<TObservation>(
    result: TickResult<TObservation>,
    participantId?: string,
  ): SessionBinding {
    const previous = this.bindings.get(result.sessionId);
    const binding: SessionBinding = {
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: result.sessionId,
      tickId: result.tickId,
      revision: result.revision,
      participantId: participantId ?? previous?.participantId ?? 'player',
      ...(result.signingPosition === undefined
        ? {}
        : { signingPosition: { ...result.signingPosition } }),
    };
    this.bindings.set(result.sessionId, binding);
    return binding;
  }

  getSessionBinding(sessionId: string): SessionBinding | undefined {
    const binding = this.bindings.get(sessionId);
    return binding ? { ...binding } : undefined;
  }

  restoreSessionBinding(value: unknown): SessionBinding {
    const binding = parseSessionBinding(value);
    this.bindings.set(binding.sessionId, binding);
    return { ...binding };
  }

  /**
   * Sign this seat's submissions to `sessionId` under RFC-010. The caller keeps
   * the private key and supplies `sign`; the client keeps the per-(session,
   * seat) chain, stamps `clientTime`, and attaches `prevChainHash` and `sig`.
   *
   * Returns the chain position now in force. Persist it — and every position
   * returned by `submissionChainState` — so a resumed run can continue the
   * same chain through `resume`.
   */
  useSubmissionSigning(
    sessionId: string,
    options: SubmissionSigningOptions,
  ): SubmissionChainState {
    assertNonEmptyString(sessionId, 'sessionId');
    if (!options || typeof options !== 'object') {
      throw new TypeError('submission signing options must be an object');
    }
    if (typeof options.sign !== 'function') {
      throw new TypeError('submission signing requires a sign callback');
    }
    if (options.now !== undefined && typeof options.now !== 'function') {
      throw new TypeError('submission signing now must be a function');
    }
    const seat = options.seat ?? this.bindings.get(sessionId)?.participantId;
    if (seat === undefined) {
      throw new ProtocolMismatchError(
        'submission signing needs a seat: pass one or bind the session first',
      );
    }
    const genesis = createSubmissionChainState(sessionId, seat, options.seatKeys);
    let state: SubmissionChainState;
    if (options.resume === undefined) {
      if (this.attachedSessions.has(sessionId)) {
        throw new ProtocolMismatchError(
          `resuming signed session ${sessionId} requires the seat's saved chain state; `
          + 'pass resume, or createSubmissionChainState(...) if this seat has not submitted',
        );
      }
      state = genesis;
    } else {
      state = parseSubmissionChainState(
        options.resume,
        sessionId,
        seat,
        genesis.rosterHash,
      );
    }
    this.signers.set(signerKey(sessionId, seat), {
      seat,
      seatKeys: structuredClone(options.seatKeys) as SubmissionSeatKey[],
      sign: options.sign,
      now: options.now ?? (() => Date.now()),
      state,
      signed: new Map(),
    });
    return { ...state };
  }

  /** Current chain position for a signing seat, for durable persistence. */
  submissionChainState(
    sessionId: string,
    seat: string,
  ): SubmissionChainState | undefined {
    const signer = this.signers.get(signerKey(sessionId, seat));
    return signer ? { ...signer.state } : undefined;
  }

  /** Stop signing for one seat and forget its in-memory chain position. */
  stopSubmissionSigning(sessionId: string, seat: string): void {
    this.signers.delete(signerKey(sessionId, seat));
  }

  /**
   * Attach RFC-010 material to one submission. Exact retries reuse the bytes
   * already signed for that `submissionId`; the chain advances only after the
   * host accepts, so an abandoned submission does not orphan the chain.
   */
  private async signSubmission<TCommand>(
    signer: RegisteredSigner,
    submission: CommandSubmission<TCommand>,
    position: SubmissionSigningPosition | undefined,
  ): Promise<{ signed: CommandSubmission<TCommand>; commit: () => void }> {
    const accept = (id: string): void => {
      const material = signer.signed.get(id)!;
      if (material.accepted) return;
      material.accepted = true;
      signer.state = {
        ...signer.state,
        chainHead: material.nextChainHead,
        submissions: signer.state.submissions + 1,
      };
    };
    const retry = signer.signed.get(submission.submissionId);
    if (retry !== undefined) {
      return {
        signed: {
          ...submission,
          clientTime: retry.clientTime,
          prevChainHash: retry.prevChainHash,
          sig: retry.sig,
        },
        commit: () => accept(submission.submissionId),
      };
    }
    if (position === undefined) {
      throw new ProtocolMismatchError(
        'signing requires the host to publish signingPosition on the tick envelope, '
        + 'or the caller to pass SubmitCommandOptions.signingPosition',
      );
    }
    const clientTime = signer.now();
    if (!Number.isSafeInteger(clientTime) || clientTime < 0) {
      throw new ProtocolMismatchError('clientTime must be a non-negative safe integer');
    }
    const envelope = {
      sessionId: submission.sessionId,
      seat: signer.seat,
      submissionId: submission.submissionId,
      cursor: position.cursor,
      tick: position.tick,
      clientTime,
      command: submission.command as JsonValue,
      prevChainHash: signer.state.chainHead,
    };
    const preimage = submissionPreimageV1(envelope);
    const sig = await signer.sign(preimage, {
      sessionId: envelope.sessionId,
      seat: envelope.seat,
      submissionId: envelope.submissionId,
      cursor: envelope.cursor,
      tick: envelope.tick,
      clientTime,
    });
    signatureBytesFromBase64(sig, 'sig', 64);
    signer.signed.set(submission.submissionId, {
      clientTime,
      prevChainHash: envelope.prevChainHash,
      sig,
      nextChainHead: submissionChainHashV1(envelope),
      accepted: false,
    });
    return {
      signed: {
        ...submission,
        clientTime,
        prevChainHash: envelope.prevChainHash,
        sig,
      },
      commit: () => accept(submission.submissionId),
    };
  }

  private async call(
    method: string,
    path: string,
    body?: JsonValue,
    callOptions: SessionCallOptions = {},
  ): Promise<unknown> {
    const token = typeof this.credential === 'function'
      ? await this.credential()
      : this.credential;
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const signals = [
      this.options.signal,
      callOptions.signal,
      timeout,
    ].filter((signal): signal is AbortSignal => signal !== undefined);
    const signal = signals.length === 0
      ? undefined
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals);
    const response = await awaitWithSignal(this.request(`${this.baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal,
    }), signal);
    const maxResponseBytes = this.options.maxResponseBytes ?? 1024 * 1024;
    let responseBody: string;
    try {
      responseBody = await readResponseText(response, maxResponseBytes);
    } catch (error) {
      if (!(error instanceof ResponseTooLargeError)) throw error;
      if (response.ok) throw new ProtocolMismatchError(error.message);
      throw new GaosApiError(response.status, error.message);
    }
    let data: unknown;
    try {
      data = responseBody ? JSON.parse(responseBody) : undefined;
    } catch {
      data = undefined;
    }
    if (!response.ok) {
      const details = data && typeof data === 'object' && !Array.isArray(data)
        ? data as Readonly<Record<string, unknown>>
        : undefined;
      const message = typeof details?.['error'] === 'string'
        ? details['error']
        : responseBody.trim() || response.statusText;
      const code = typeof details?.['code'] === 'string' ? details['code'] : undefined;
      if (response.status === 422) {
        throw new IllegalActionRejected(response.status, message, code, details, responseBody);
      }
      throw new GaosApiError(response.status, message, code, details, responseBody);
    }
    if (data === undefined) {
      throw new ProtocolMismatchError(`HTTP ${response.status} response is not JSON`);
    }
    return data;
  }

  async createSession<TRequest = unknown, TObservation = unknown>(
    request: TRequest,
    participantId = 'player',
    callOptions: SessionCallOptions = {},
  ): Promise<SessionStart<TObservation>> {
    assertJsonValue(request, 'session request');
    const result = parseTickResult<TObservation>(
      await this.call('POST', '/v1/sessions', request, callOptions),
    );
    if (result.kind !== 'tick') {
      throw new ProtocolMismatchError('new session must start resolved');
    }
    const binding = this.remember(result, participantId);
    return { sessionId: result.sessionId, tick: result.tick, binding };
  }

  async attachSession<TObservation = unknown>(
    sessionId: string,
    request: SessionAttachRequest,
    callOptions: SessionCallOptions = {},
  ): Promise<SessionAttach<TObservation>> {
    assertNonEmptyString(sessionId, 'sessionId');
    assertNonEmptyString(request.requestId, 'attach requestId');
    assertJsonValue(request, 'attach request');
    const attachment = parseSessionAttach<TObservation>(
      await this.call(
        'POST',
        `/v1/sessions/${encodeURIComponent(sessionId)}/attach`,
        request as unknown as JsonValue,
        callOptions,
      ),
      sessionId,
    );
    const participantId = request.participantId ?? attachment.binding.participantId;
    if (participantId !== attachment.binding.participantId) {
      throw new ProtocolMismatchError('attachment participant does not match request');
    }
    if (attachment.receipt && attachment.receipt.requestId !== request.requestId) {
      throw new ProtocolMismatchError('attachment receipt does not match request');
    }
    if (
      request.controller
      && attachment.receipt?.controller
      && canonicalJson(request.controller as unknown as JsonValue)
        !== canonicalJson(attachment.receipt.controller as unknown as JsonValue)
    ) {
      throw new ProtocolMismatchError('attachment receipt changes controller identity');
    }
    this.bindings.set(sessionId, attachment.binding);
    this.attachedSessions.add(sessionId);
    return attachment;
  }

  async finalizeSession<TOutcome = JsonValue>(
    sessionId: string,
    request: SessionFinalizeRequest,
    callOptions: SessionCallOptions = {},
  ): Promise<SessionResult<TOutcome>> {
    assertNonEmptyString(sessionId, 'sessionId');
    assertNonEmptyString(request.requestId, 'finalization requestId');
    assertJsonValue(request, 'finalization request');
    return parseSessionResult<TOutcome>(
      await this.call(
        'POST',
        `/v1/sessions/${encodeURIComponent(sessionId)}/finalize`,
        request as unknown as JsonValue,
        callOptions,
      ),
      sessionId,
    );
  }

  async createSessionHandle<
    TRequest = unknown,
    TCommand = unknown,
    TObservation = unknown,
    TOutcome = JsonValue,
  >(
    request: TRequest,
    policy: SessionPolicy,
    participantId = 'player',
    callOptions: SessionCallOptions = {},
  ): Promise<SessionHandle<TCommand, TObservation, TOutcome>> {
    assertJsonValue(policy, 'session policy');
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new TypeError('session handle request must be a JSON object');
    }
    const policyRequest = {
      ...(request as Record<string, unknown>),
      policy,
    };
    const start = await this.createSession<typeof policyRequest, TObservation>(
      policyRequest,
      participantId,
      callOptions,
    );
    return new ClientSessionHandle<TCommand, TObservation, TOutcome>(
      this,
      start.sessionId,
      start.binding.participantId,
      policy,
    );
  }

  async attachSessionHandle<
    TCommand = unknown,
    TObservation = unknown,
    TOutcome = JsonValue,
  >(
    sessionId: string,
    request: SessionAttachRequest,
    policy: SessionPolicy,
    callOptions: SessionCallOptions = {},
  ): Promise<SessionHandle<TCommand, TObservation, TOutcome>> {
    assertJsonValue(policy, 'session policy');
    if (
      request.controller
      && policy.controller
      && canonicalJson(request.controller as unknown as JsonValue)
        !== canonicalJson(policy.controller as unknown as JsonValue)
    ) {
      throw new ProtocolMismatchError('attachment cannot replace the pinned controller');
    }
    const attachment = await this.attachSession<TObservation>(
      sessionId,
      request,
      callOptions,
    );
    return new ClientSessionHandle<TCommand, TObservation, TOutcome>(
      this,
      sessionId,
      attachment.binding.participantId,
      policy,
      attachment.receipt,
    );
  }

  /**
   * Adopt a session created or attached through a product-owned wire route.
   * This performs no network request. A supplied full tick is preserved;
   * current SessionStart/SessionAttach projections synthesize a resolved tick.
   */
  createSessionHandleFromExisting<
    TCommand = unknown,
    TObservation = unknown,
    TOutcome = JsonValue,
  >(
    existing: ExistingSessionHandle<TObservation>,
    policy: SessionPolicy,
  ): SessionHandle<TCommand, TObservation, TOutcome>;
  createSessionHandleFromExisting<
    TCommand = unknown,
    TObservation = unknown,
    TOutcome = JsonValue,
  >(
    existing: SessionStart<TObservation> | SessionAttach<TObservation>,
    policy: SessionPolicy,
  ): SessionHandle<TCommand, TObservation, TOutcome>;
  createSessionHandleFromExisting<
    TCommand = unknown,
    TObservation = unknown,
    TOutcome = JsonValue,
  >(
    existing:
      | ExistingSessionHandle<TObservation>
      | SessionStart<TObservation>
      | SessionAttach<TObservation>,
    policy: SessionPolicy,
  ): SessionHandle<TCommand, TObservation, TOutcome> {
    assertJsonValue(policy, 'session policy');
    if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
      throw new ProtocolMismatchError('existing session must be an object');
    }
    assertNonEmptyString(existing.sessionId, 'existing sessionId');
    const binding = parseSessionBinding(existing.binding);
    let initialTick: TickResult<TObservation>;
    let receiptValue: unknown;
    if (Object.hasOwn(existing, 'initialTick')) {
      const full = existing as ExistingSessionHandle<TObservation>;
      initialTick = parseTickResult<TObservation>(full.initialTick);
      receiptValue = full.attachReceipt;
    } else {
      const projected = existing as SessionStart<TObservation> | SessionAttach<TObservation>;
      if (!Object.hasOwn(projected, 'tick')) {
        throw new ProtocolMismatchError('existing session initial tick is missing');
      }
      try {
        assertJsonValue(projected.tick, 'existing session initial tick');
      } catch (error) {
        throw new ProtocolMismatchError(
          error instanceof Error ? error.message : 'existing session initial tick is invalid',
        );
      }
      let extensions: ProtocolExtensions | undefined;
      if (Object.hasOwn(projected, 'extensions')) {
        const attachment = projected as SessionAttach<TObservation>;
        try {
          assertJsonObject(attachment.extensions, 'existing session extensions');
          extensions = structuredClone(attachment.extensions);
        } catch (error) {
          throw new ProtocolMismatchError(
            error instanceof Error ? error.message : 'existing session extensions are invalid',
          );
        }
      }
      initialTick = {
        kind: 'tick',
        protocol: PROTOCOL_ID,
        protocolVersion: PROTOCOL_VERSION,
        sessionId: binding.sessionId,
        tickId: binding.tickId,
        revision: binding.revision,
        tick: structuredClone(projected.tick),
        ...(binding.signingPosition === undefined
          ? {}
          : { signingPosition: { ...binding.signingPosition } }),
        ...(extensions === undefined ? {} : { extensions }),
      };
      receiptValue = Object.hasOwn(projected, 'receipt')
        ? (projected as SessionAttach<TObservation>).receipt
        : undefined;
    }
    try {
      assertJsonValue(initialTick.tick, 'existing session initial tick');
    } catch (error) {
      throw new ProtocolMismatchError(
        error instanceof Error ? error.message : 'existing session initial tick is invalid',
      );
    }
    if (
      binding.sessionId !== existing.sessionId
      || initialTick.sessionId !== existing.sessionId
    ) {
      throw new ProtocolMismatchError('existing session identities do not match');
    }
    if (
      binding.tickId !== initialTick.tickId
      || binding.revision !== initialTick.revision
    ) {
      throw new ProtocolMismatchError('existing session binding does not match initial tick');
    }
    const attachReceipt = receiptValue === undefined
      ? undefined
      : parseSessionAttachReceipt(receiptValue);
    if (
      attachReceipt !== undefined
      && (
        attachReceipt.sessionId !== existing.sessionId
        || attachReceipt.revision !== binding.revision
      )
    ) {
      throw new ProtocolMismatchError('existing session receipt does not match durable head');
    }
    this.bindings.set(existing.sessionId, binding);
    if (attachReceipt !== undefined) this.attachedSessions.add(existing.sessionId);
    return new ClientSessionHandle<TCommand, TObservation, TOutcome>(
      this,
      existing.sessionId,
      binding.participantId,
      structuredClone(policy),
      attachReceipt,
      structuredClone(initialTick),
    );
  }

  async getTickEnvelope<TObservation = unknown>(
    sessionId: string,
    callOptions: SessionCallOptions = {},
  ): Promise<TickResult<TObservation>> {
    const result = parseTickResult<TObservation>(
      await this.call(
        'GET',
        `/v1/sessions/${encodeURIComponent(sessionId)}/tick`,
        undefined,
        callOptions,
      ),
    );
    if (result.sessionId !== sessionId) {
      throw new ProtocolMismatchError('response session does not match request');
    }
    this.remember(result);
    return result;
  }

  async submitCommand<TCommand = unknown, TObservation = unknown>(
    sessionId: string,
    command: TCommand,
    options: SubmitCommandOptions = {},
  ): Promise<TickResult<TObservation>> {
    assertJsonValue(command, 'command');
    let binding = this.bindings.get(sessionId);
    if (!binding && !options.cursor) {
      if (options.submissionId !== undefined) {
        throw new ProtocolMismatchError(
          'explicit submissionId requires the original cursor or a restored session binding',
        );
      }
      await this.getTickEnvelope(sessionId, { signal: options.signal });
      binding = this.bindings.get(sessionId);
    }
    const cursor = options.cursor ?? binding;
    if (!cursor) throw new ProtocolMismatchError('session cursor unavailable');
    const participantId = options.participantId ?? binding?.participantId ?? 'player';
    const sequenceKey = `${sessionId}\u0000${participantId}\u0000${cursor.tickId}`;
    const sequence = this.commandSequences.get(sequenceKey) ?? 0;
    if (options.submissionId === undefined) {
      this.commandSequences.set(sequenceKey, sequence + 1);
    }
    const signer = this.signers.get(signerKey(sessionId, participantId));
    // A signing client numbers generated ids from its durable chain position
    // rather than a per-process counter, so they stay distinct across a resume
    // even when the host restarts revisions at a level boundary. An unsent
    // submission keeps its id, so a retry after a failure resends signed bytes.
    const generatedId = signer === undefined
      ? `${participantId}:${cursor.tickId}:${sequence}`
      : `${participantId}:${cursor.tickId}:s${signer.state.submissions}`;
    const submission: CommandSubmission<TCommand> = {
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      tickId: cursor.tickId,
      revision: cursor.revision,
      participantId,
      submissionId: options.submissionId ?? generatedId,
      command,
    };
    let body = submission;
    let commitChain: (() => void) | undefined;
    if (signer !== undefined) {
      const cursorPosition = options.cursor === undefined
        ? undefined
        : (options.cursor as SessionBinding).signingPosition;
      const signed = await this.signSubmission(
        signer,
        submission,
        options.signingPosition
          ?? (cursorPosition === undefined
            ? undefined
            : parseSigningPosition(cursorPosition))
          ?? binding?.signingPosition,
      );
      body = signed.signed;
      commitChain = signed.commit;
    }
    const result = parseTickResult<TObservation>(
      await this.call(
        'POST',
        `/v1/sessions/${encodeURIComponent(sessionId)}/actions`,
        body as unknown as JsonValue,
        { signal: options.signal },
      ),
    );
    if (result.sessionId !== sessionId) {
      throw new ProtocolMismatchError('response session does not match request');
    }
    commitChain?.();
    this.remember(result, participantId);
    return result;
  }

  /** @deprecated Use submitCommand. */
  async submitIntent<TCommand = unknown, TObservation = unknown>(
    sessionId: string,
    command: TCommand,
    options: SubmitIntentOptions = {},
  ): Promise<TickResult<TObservation>> {
    let binding = this.bindings.get(sessionId);
    if (!binding && !options.cursor && options.submissionId === undefined) {
      await this.getTickEnvelope(sessionId, { signal: options.signal });
      binding = this.bindings.get(sessionId);
    }
    const cursor = options.cursor ?? binding;
    const participantId = options.participantId ?? binding?.participantId ?? 'player';
    return this.submitCommand<TCommand, TObservation>(sessionId, command, {
      ...options,
      ...(options.submissionId !== undefined || cursor === undefined
        ? {}
        : { submissionId: `${participantId}:${cursor.tickId}` }),
    });
  }
}

class ClientSessionHandle<TCommand, TObservation, TOutcome>
implements SessionHandle<TCommand, TObservation, TOutcome> {
  private lifecycleStatus: SessionHandle<TCommand, TObservation, TOutcome>['status'] = 'active';
  private finalization?: {
    request: SessionFinalizeRequest;
    result: SessionResult<TOutcome>;
  };

  constructor(
    private readonly client: SessionClient,
    readonly sessionId: string,
    readonly participantId: string,
    readonly policy: SessionPolicy,
    readonly attachReceipt?: SessionAttachReceipt,
    private initialTick?: TickResult<TObservation>,
  ) {
    if (initialTick !== undefined) this.updateStatus(initialTick);
  }

  get status(): SessionHandle<TCommand, TObservation, TOutcome>['status'] {
    return this.lifecycleStatus;
  }

  private requireOpen(): void {
    if (this.lifecycleStatus === 'closed') throw new Error('session handle is closed');
  }

  private updateStatus(result: TickResult<TObservation>): void {
    const finalization = result.extensions?.['gaos.session.finalization'];
    if (
      finalization
      && typeof finalization === 'object'
      && !Array.isArray(finalization)
      && finalization['status'] === 'terminal'
    ) {
      this.lifecycleStatus = 'terminal';
    }
  }

  private rememberStatus(result: TickResult<TObservation>): TickResult<TObservation> {
    this.updateStatus(result);
    return result;
  }

  async observe(options: SessionCallOptions = {}): Promise<TickResult<TObservation>> {
    this.requireOpen();
    if (this.lifecycleStatus === 'finalized') {
      throw new Error('session is already finalized');
    }
    if (this.initialTick !== undefined) {
      const result = this.initialTick;
      this.initialTick = undefined;
      return this.rememberStatus(structuredClone(result));
    }
    return this.rememberStatus(
      await this.client.getTickEnvelope<TObservation>(this.sessionId, options),
    );
  }

  async act(
    command: TCommand,
    options: SubmitIntentOptions = {},
  ): Promise<TickResult<TObservation>> {
    this.requireOpen();
    if (this.lifecycleStatus !== 'active') {
      throw new Error(`cannot act while session handle is ${this.lifecycleStatus}`);
    }
    const result = await this.client.submitCommand<TCommand, TObservation>(
      this.sessionId,
      command,
      {
        ...options,
        participantId: options.participantId ?? this.participantId,
      },
    );
    this.initialTick = undefined;
    return this.rememberStatus(result);
  }

  async finalize(
    request: Partial<SessionFinalizeRequest> = {},
  ): Promise<SessionResult<TOutcome>> {
    this.requireOpen();
    const completeRequest: SessionFinalizeRequest = {
      ...structuredClone(request),
      requestId: request.requestId ?? `finalize:${this.sessionId}`,
    };
    if (this.finalization) {
      if (canonicalJson(completeRequest as unknown as JsonValue)
        !== canonicalJson(this.finalization.request as unknown as JsonValue)) {
        throw new Error('session was finalized with a different request');
      }
      return structuredClone(this.finalization.result);
    }
    const result = await this.client.finalizeSession<TOutcome>(this.sessionId, completeRequest);
    this.finalization = {
      request: structuredClone(completeRequest),
      result: structuredClone(result),
    };
    this.lifecycleStatus = 'finalized';
    return result;
  }

  close(): void {
    this.lifecycleStatus = 'closed';
  }
}
