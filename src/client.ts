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
  isParticipantId,
  type CommandSubmission,
  type JsonValue,
  type TickCursor,
  type TickResult,
} from './protocol.js';

export interface SessionBinding extends TickCursor {
  protocol: typeof PROTOCOL_ID;
  protocolVersion: typeof PROTOCOL_VERSION;
  sessionId: string;
  participantId: string;
}

export interface SessionStart<TObservation = unknown> {
  sessionId: string;
  tick: TObservation;
  binding: SessionBinding;
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
  };
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

export class SessionClient {
  private readonly bindings = new Map<string, SessionBinding>();
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

  async submitIntent<TCommand = unknown, TObservation = unknown>(
    sessionId: string,
    command: TCommand,
    options: {
      participantId?: string;
      submissionId?: string;
      cursor?: TickCursor;
      signal?: AbortSignal;
    } = {},
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
    const submission: CommandSubmission<TCommand> = {
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      tickId: cursor.tickId,
      revision: cursor.revision,
      participantId,
      submissionId: options.submissionId ?? `${participantId}:${cursor.tickId}`,
      command,
    };
    const result = parseTickResult<TObservation>(
      await this.call(
        'POST',
        `/v1/sessions/${encodeURIComponent(sessionId)}/actions`,
        submission as unknown as JsonValue,
        { signal: options.signal },
      ),
    );
    if (result.sessionId !== sessionId) {
      throw new ProtocolMismatchError('response session does not match request');
    }
    this.remember(result, participantId);
    return result;
  }
}
