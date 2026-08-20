import {
  assertJsonValue,
  canonicalJson,
  type JsonValue,
} from './protocol.js';

export const PRESENTATION_CUE_SCHEMA = 'gaos.presentation-cue.v1' as const;

export type PresentationCuePriority = 'normal' | 'emergency';

/** Product-defined visual/audio command carried over the portable cue lane. */
export interface PresentationCue<TPayload extends JsonValue = JsonValue> {
  schema: typeof PRESENTATION_CUE_SCHEMA;
  sessionId: string;
  cueId: string;
  sequence: number;
  type: string;
  priority: PresentationCuePriority;
  payload: TPayload;
}

export type PresentationCueAcknowledgementStatus =
  | 'applied'
  | 'duplicate'
  | 'rejected'
  | 'repair_required';

export interface PresentationCueAcknowledgement {
  schema: typeof PRESENTATION_CUE_SCHEMA;
  sessionId: string;
  cueId: string;
  sequence: number;
  status: PresentationCueAcknowledgementStatus;
  reason?: string;
}

export interface PresentationCueHostState {
  schema: typeof PRESENTATION_CUE_SCHEMA;
  sessionId: string;
  nextSequence: number;
  retainedCues: readonly PresentationCue[];
  acknowledgements: Readonly<Record<string, PresentationCueAcknowledgement>>;
}

export interface PresentationCueClientState {
  schema: typeof PRESENTATION_CUE_SCHEMA;
  sessionId: string;
  status: 'ready' | 'repair_required';
  lastAppliedSequence: number;
  appliedCueFingerprints: Readonly<Record<string, string>>;
}

export type PresentationCueResume =
  | { status: 'replay'; cues: readonly PresentationCue[] }
  | {
    status: 'snapshot_required';
    earliestRetainedSequence: number;
    latestSequence: number;
  };

export interface PresentationCueHostOptions {
  sessionId: string;
  createId(): string;
  maxRetainedCues?: number;
  state?: PresentationCueHostState;
}

export interface PresentationCueClientOptions {
  sessionId: string;
  apply(cue: PresentationCue): void | Promise<void>;
  interrupt?(): void | Promise<void>;
  state?: PresentationCueClientState;
}

function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
}

function assertSequence(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function assertCue(cue: PresentationCue): void {
  if (cue === null || typeof cue !== 'object') {
    throw new TypeError('presentation cue must be an object');
  }
  if (cue.schema !== PRESENTATION_CUE_SCHEMA) {
    throw new TypeError('presentation cue schema is unsupported');
  }
  assertText(cue.sessionId, 'presentation cue sessionId');
  assertText(cue.cueId, 'presentation cue cueId');
  assertSequence(cue.sequence, 'presentation cue sequence');
  if (cue.sequence === 0) throw new RangeError('presentation cue sequence must be positive');
  assertText(cue.type, 'presentation cue type');
  if (cue.priority !== 'normal' && cue.priority !== 'emergency') {
    throw new TypeError('presentation cue priority is unsupported');
  }
  assertJsonValue(cue.payload, 'presentation cue payload');
}

function assertAcknowledgement(ack: PresentationCueAcknowledgement): void {
  if (ack === null || typeof ack !== 'object') {
    throw new TypeError('presentation cue acknowledgement must be an object');
  }
  if (ack.schema !== PRESENTATION_CUE_SCHEMA) {
    throw new TypeError('presentation cue acknowledgement schema is unsupported');
  }
  assertText(ack.sessionId, 'presentation cue acknowledgement sessionId');
  assertText(ack.cueId, 'presentation cue acknowledgement cueId');
  assertSequence(ack.sequence, 'presentation cue acknowledgement sequence');
  if (!['applied', 'duplicate', 'rejected', 'repair_required'].includes(ack.status)) {
    throw new TypeError('presentation cue acknowledgement status is unsupported');
  }
  if (ack.reason !== undefined) assertText(ack.reason, 'presentation cue rejection reason');
}

function cueFingerprint(cue: PresentationCue): string {
  return canonicalJson(cue);
}

function acknowledgementFingerprint(ack: PresentationCueAcknowledgement): string {
  return canonicalJson(ack);
}

function copyCue(cue: PresentationCue): PresentationCue {
  return structuredClone(cue);
}

/**
 * Host-side retained cue log. Persist `state()` in the hosting runtime and use
 * `resumeAfter()` to repair a presentation client after reconnect.
 */
export class PresentationCueHost {
  private value: PresentationCueHostState;
  private readonly maxRetainedCues: number;

  constructor(private readonly options: PresentationCueHostOptions) {
    assertText(options?.sessionId, 'presentation cue host sessionId');
    if (typeof options.createId !== 'function') {
      throw new TypeError('presentation cue host requires createId');
    }
    this.maxRetainedCues = options.maxRetainedCues ?? 128;
    if (!Number.isSafeInteger(this.maxRetainedCues) || this.maxRetainedCues < 1) {
      throw new RangeError('presentation cue maxRetainedCues must be positive');
    }
    this.value = options.state === undefined
      ? {
        schema: PRESENTATION_CUE_SCHEMA,
        sessionId: options.sessionId,
        nextSequence: 1,
        retainedCues: [],
        acknowledgements: {},
      }
      : this.restore(options.state);
  }

  private restore(state: PresentationCueHostState): PresentationCueHostState {
    if (state.schema !== PRESENTATION_CUE_SCHEMA || state.sessionId !== this.options.sessionId) {
      throw new Error('presentation cue host state does not belong to session');
    }
    assertSequence(state.nextSequence, 'presentation cue nextSequence');
    if (state.nextSequence === 0) {
      throw new RangeError('presentation cue nextSequence must be positive');
    }
    if (!Array.isArray(state.retainedCues)) {
      throw new TypeError('presentation cue retainedCues must be an array');
    }
    let previous = 0;
    for (const cue of state.retainedCues) {
      assertCue(cue);
      if (cue.sessionId !== state.sessionId || cue.sequence <= previous) {
        throw new Error('presentation cue host state is not ordered for its session');
      }
      previous = cue.sequence;
    }
    if (previous >= state.nextSequence) {
      throw new Error('presentation cue nextSequence must follow retained cues');
    }
    for (const [cueId, ack] of Object.entries(state.acknowledgements)) {
      assertAcknowledgement(ack);
      if (ack.sessionId !== state.sessionId) {
        throw new Error('presentation cue acknowledgement does not belong to session');
      }
      const cue = state.retainedCues.find((candidate) => candidate.cueId === cueId);
      if (cueId !== ack.cueId || cue === undefined || cue.sequence !== ack.sequence) {
        throw new Error('presentation cue acknowledgement does not match a retained cue');
      }
    }
    return structuredClone(state);
  }

  issue(
    type: string,
    payload: JsonValue,
    options: { priority?: PresentationCuePriority } = {},
  ): PresentationCue {
    assertText(type, 'presentation cue type');
    assertJsonValue(payload, 'presentation cue payload');
    const cueId = this.options.createId();
    assertText(cueId, 'created presentation cue id');
    if (this.value.retainedCues.some((cue) => cue.cueId === cueId)
      || this.value.acknowledgements[cueId] !== undefined) {
      throw new Error(`presentation cue id was reused: ${cueId}`);
    }
    const cue: PresentationCue = {
      schema: PRESENTATION_CUE_SCHEMA,
      sessionId: this.options.sessionId,
      cueId,
      sequence: this.value.nextSequence,
      type,
      priority: options.priority ?? 'normal',
      payload: structuredClone(payload),
    };
    assertCue(cue);
    const retained = [...this.value.retainedCues, cue]
      .slice(-this.maxRetainedCues)
      .map(copyCue);
    const retainedIds = new Set(retained.map(({ cueId: id }) => id));
    this.value = {
      ...this.value,
      nextSequence: cue.sequence + 1,
      retainedCues: retained,
      acknowledgements: Object.fromEntries(
        Object.entries(this.value.acknowledgements)
          .filter(([id]) => retainedIds.has(id)),
      ),
    };
    return copyCue(cue);
  }

  acknowledge(ack: PresentationCueAcknowledgement): 'recorded' | 'duplicate' {
    assertAcknowledgement(ack);
    if (ack.sessionId !== this.options.sessionId) {
      throw new Error('presentation cue acknowledgement does not belong to host session');
    }
    const cue = this.value.retainedCues.find(({ cueId }) => cueId === ack.cueId);
    if (cue === undefined || cue.sequence !== ack.sequence) {
      throw new Error(`presentation cue acknowledgement is unknown: ${ack.cueId}`);
    }
    const current = this.value.acknowledgements[ack.cueId];
    if (current !== undefined) {
      if (current.sequence === ack.sequence
        && current.status === 'applied'
        && ack.status === 'duplicate') {
        return 'duplicate';
      }
      if (acknowledgementFingerprint(current) !== acknowledgementFingerprint(ack)) {
        throw new Error(`presentation cue acknowledgement changed: ${ack.cueId}`);
      }
      return 'duplicate';
    }
    this.value = {
      ...this.value,
      acknowledgements: {
        ...this.value.acknowledgements,
        [ack.cueId]: structuredClone(ack),
      },
    };
    return 'recorded';
  }

  resumeAfter(sequence: number): PresentationCueResume {
    assertSequence(sequence, 'presentation cue resume sequence');
    const latestSequence = this.value.nextSequence - 1;
    if (sequence > latestSequence) {
      throw new RangeError('presentation cue resume sequence exceeds issued cues');
    }
    const earliestRetainedSequence = this.value.retainedCues[0]?.sequence
      ?? this.value.nextSequence;
    if (sequence < earliestRetainedSequence - 1) {
      return { status: 'snapshot_required', earliestRetainedSequence, latestSequence };
    }
    return {
      status: 'replay',
      cues: this.value.retainedCues
        .filter((cue) => cue.sequence > sequence)
        .map(copyCue),
    };
  }

  state(): PresentationCueHostState {
    return structuredClone(this.value);
  }
}

/** Presentation-side ordered, idempotent cue application state machine. */
export class PresentationCueClient {
  private value: PresentationCueClientState;

  constructor(private readonly options: PresentationCueClientOptions) {
    assertText(options?.sessionId, 'presentation cue client sessionId');
    if (typeof options.apply !== 'function') {
      throw new TypeError('presentation cue client requires apply');
    }
    this.value = options.state === undefined
      ? {
        schema: PRESENTATION_CUE_SCHEMA,
        sessionId: options.sessionId,
        status: 'ready',
        lastAppliedSequence: 0,
        appliedCueFingerprints: {},
      }
      : this.restore(options.state);
  }

  private restore(state: PresentationCueClientState): PresentationCueClientState {
    if (state.schema !== PRESENTATION_CUE_SCHEMA || state.sessionId !== this.options.sessionId) {
      throw new Error('presentation cue client state does not belong to session');
    }
    if (state.status !== 'ready' && state.status !== 'repair_required') {
      throw new TypeError('presentation cue client state status is unsupported');
    }
    assertSequence(state.lastAppliedSequence, 'presentation cue client sequence');
    for (const [cueId, fingerprint] of Object.entries(state.appliedCueFingerprints)) {
      assertText(cueId, 'presentation cue client cue id');
      assertText(fingerprint, 'presentation cue client fingerprint');
    }
    return structuredClone(state);
  }

  async receive(cue: PresentationCue): Promise<PresentationCueAcknowledgement> {
    assertCue(cue);
    if (cue.sessionId !== this.options.sessionId) {
      throw new Error('presentation cue does not belong to client session');
    }
    const fingerprint = cueFingerprint(cue);
    const previous = this.value.appliedCueFingerprints[cue.cueId];
    if (previous !== undefined) {
      if (previous !== fingerprint) {
        throw new Error(`presentation cue identity was reused: ${cue.cueId}`);
      }
      return this.ack(cue, 'duplicate');
    }
    const expected = this.value.lastAppliedSequence + 1;
    if (cue.sequence <= this.value.lastAppliedSequence) {
      this.value = { ...this.value, status: 'repair_required' };
      return this.ack(cue, 'repair_required', 'stale_sequence');
    }
    if (cue.priority !== 'emergency' && cue.sequence !== expected) {
      this.value = { ...this.value, status: 'repair_required' };
      return this.ack(cue, 'repair_required', 'sequence_gap');
    }
    if (cue.priority === 'emergency' && this.options.interrupt !== undefined) {
      await this.options.interrupt();
    }
    try {
      await this.options.apply(copyCue(cue));
    } catch (error) {
      this.value = { ...this.value, status: 'repair_required' };
      return this.ack(
        cue,
        'rejected',
        error instanceof Error ? error.message : 'cue_apply_failed',
      );
    }
    this.value = {
      ...this.value,
      status: 'ready',
      lastAppliedSequence: cue.sequence,
      appliedCueFingerprints: {
        ...this.value.appliedCueFingerprints,
        [cue.cueId]: fingerprint,
      },
    };
    return this.ack(cue, 'applied');
  }

  private ack(
    cue: PresentationCue,
    status: PresentationCueAcknowledgementStatus,
    reason?: string,
  ): PresentationCueAcknowledgement {
    return {
      schema: PRESENTATION_CUE_SCHEMA,
      sessionId: cue.sessionId,
      cueId: cue.cueId,
      sequence: cue.sequence,
      status,
      ...(reason === undefined ? {} : { reason }),
    };
  }

  state(): PresentationCueClientState {
    return structuredClone(this.value);
  }
}
