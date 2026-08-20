import { canonicalJson } from './protocol.js';
import {
  RoomAgentRegistry,
  type RoomAgentContext,
  type RoomAgentDescriptor,
  type RoomAgentInput,
  type RoomAgentTurn,
  type RoomAgentVoice,
} from './room-agent.js';
import type { RoomEndpointKind } from './room-interaction.js';

export const ROOM_AGENT_RUNTIME_SCHEMA = 'gaos.room-agent-runtime.v1' as const;

export interface RoomAgentRuntimeState {
  schema: typeof ROOM_AGENT_RUNTIME_SCHEMA;
  roomId: string;
  phase?: string;
  focusByParticipant: Readonly<Record<string, string>>;
  registrations: readonly RoomAgentDescriptor[];
}

export interface RoomAgentTranscriptEntry {
  id: string;
  roomId: string;
  channelId: string;
  sequence: number;
  turnId: string;
  direction: 'input' | 'output';
  endpoint: { kind: RoomEndpointKind; id: string };
  text: string;
  modality: 'speech' | 'text' | 'generated';
}

export type RoomAgentTranscriptDraft = Omit<RoomAgentTranscriptEntry, 'sequence'>;

export interface RoomAgentTranscriptAppendResult {
  entry: RoomAgentTranscriptEntry;
  duplicate: boolean;
}

/** Durable hosts implement this with per-room state and per-channel transcript rows. */
export interface RoomAgentRuntimeStore {
  loadState(roomId: string): Promise<RoomAgentRuntimeState | undefined>;
  saveState(state: RoomAgentRuntimeState): Promise<void>;
  appendTranscript(entry: RoomAgentTranscriptDraft): Promise<RoomAgentTranscriptAppendResult>;
  loadTranscript(roomId: string, channelId: string): Promise<readonly RoomAgentTranscriptEntry[]>;
}

export interface RoomAgentRuntimeContextRequest {
  roomId: string;
  channelId: string;
  agentId: string;
  input: RoomAgentInput;
  phase?: string;
  transcript: readonly RoomAgentTranscriptEntry[];
}

export type RoomAgentRuntimeContextSource<TObservation = unknown, TKnowledge = unknown> = (
  request: RoomAgentRuntimeContextRequest,
) => Omit<
  RoomAgentContext<TObservation, TKnowledge>,
  'agent' | 'roomId' | 'input' | 'signal'
> | Promise<Omit<
  RoomAgentContext<TObservation, TKnowledge>,
  'agent' | 'roomId' | 'input' | 'signal'
>>;

export interface RoomSpeechRequest {
  utteranceId: string;
  roomId: string;
  channelId: string;
  agentId: string;
  text: string;
  voice?: RoomAgentVoice;
  audience?: RoomAgentTurn['utterances'][number]['audience'];
  interruptible: boolean;
}

export interface RoomSpeechAdapter {
  speak(request: RoomSpeechRequest, signal: AbortSignal): void | Promise<void>;
  interrupt?(utteranceId: string): void | Promise<void>;
}

export interface RoomCaptionEvent extends RoomSpeechRequest {
  status: 'started' | 'completed' | 'interrupted' | 'failed';
}

export interface RoomCaptionSink {
  publish(event: RoomCaptionEvent): void | Promise<void>;
}

export type RoomAgentRuntimeEventType =
  | 'turn_started'
  | 'turn_completed'
  | 'turn_interrupted'
  | 'turn_failed'
  | 'speech_started'
  | 'speech_completed'
  | 'speech_interrupted'
  | 'speech_failed'
  | 'reconnected';

/** Operational metadata deliberately excludes transcript and utterance text. */
export interface RoomAgentRuntimeEvent {
  type: RoomAgentRuntimeEventType;
  roomId: string;
  channelId?: string;
  turnId?: string;
  agentId?: string;
  utteranceId?: string;
  reason?: string;
  durationMs?: number;
}

export interface RoomAgentRuntimeObserver {
  emit(event: RoomAgentRuntimeEvent): void | Promise<void>;
}

export interface RoomAgentRuntimeOptions<TObservation = unknown, TKnowledge = unknown> {
  roomId: string;
  registry: RoomAgentRegistry<TObservation, TKnowledge>;
  store: RoomAgentRuntimeStore;
  contextSource: RoomAgentRuntimeContextSource<TObservation, TKnowledge>;
  createId(): string;
  fallbackAgentId?: string;
  phaseAgentIds?: Readonly<Record<string, string>>;
  speech?: RoomSpeechAdapter;
  captions?: RoomCaptionSink;
  observer?: RoomAgentRuntimeObserver;
  /** Operational monotonic clock used for duration metrics. Defaults to Date.now. */
  now?: () => number;
}

export interface RoomAgentRuntimeInput {
  channelId: string;
  input: RoomAgentInput;
}

export interface RoomAgentRuntimeResult {
  status: 'completed' | 'interrupted' | 'duplicate';
  agentId: string;
  turn: RoomAgentTurn | null;
}

export interface RoomAgentRuntimeResume {
  state: RoomAgentRuntimeState;
  transcript: readonly RoomAgentTranscriptEntry[];
}

function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
}

function copyDescriptor(descriptor: RoomAgentDescriptor): RoomAgentDescriptor {
  return structuredClone(descriptor);
}

function stateFingerprint(state: RoomAgentRuntimeState): string {
  return canonicalJson(state);
}

function transcriptFingerprint(entry: RoomAgentTranscriptDraft): string {
  return canonicalJson(entry);
}

function visibleTo(descriptor: RoomAgentDescriptor, input: RoomAgentInput): boolean {
  if ((input.speakerKind ?? 'participant') !== 'participant') return true;
  return descriptor.visibility === undefined
    || descriptor.visibility.kind === 'room'
    || descriptor.visibility.participantIds.includes(input.speakerId);
}

/** Reference persistence implementation for tests, local hosts, and adapters. */
export class InMemoryRoomAgentRuntimeStore implements RoomAgentRuntimeStore {
  private readonly states = new Map<string, RoomAgentRuntimeState>();
  private readonly transcripts = new Map<string, RoomAgentTranscriptEntry[]>();
  private readonly transcriptIds = new Map<
    string,
    { fingerprint: string; entry: RoomAgentTranscriptEntry }
  >();

  async loadState(roomId: string): Promise<RoomAgentRuntimeState | undefined> {
    const state = this.states.get(roomId);
    return state === undefined ? undefined : structuredClone(state);
  }

  async saveState(state: RoomAgentRuntimeState): Promise<void> {
    if (state.schema !== ROOM_AGENT_RUNTIME_SCHEMA) {
      throw new TypeError('room agent runtime state schema is unsupported');
    }
    assertText(state.roomId, 'room agent runtime roomId');
    this.states.set(state.roomId, structuredClone(state));
  }

  async appendTranscript(
    draft: RoomAgentTranscriptDraft,
  ): Promise<RoomAgentTranscriptAppendResult> {
    assertText(draft.id, 'room transcript id');
    assertText(draft.roomId, 'room transcript roomId');
    assertText(draft.channelId, 'room transcript channelId');
    assertText(draft.turnId, 'room transcript turnId');
    assertText(draft.endpoint.id, 'room transcript endpoint id');
    assertText(draft.text, 'room transcript text');
    if (!['participant', 'agent', 'service', 'watcher'].includes(draft.endpoint.kind)) {
      throw new TypeError('room transcript endpoint kind is unsupported');
    }
    if (draft.direction !== 'input' && draft.direction !== 'output') {
      throw new TypeError('room transcript direction is unsupported');
    }
    if (!['speech', 'text', 'generated'].includes(draft.modality)) {
      throw new TypeError('room transcript modality is unsupported');
    }
    if ((draft.direction === 'input') !== (draft.modality !== 'generated')) {
      throw new TypeError('room transcript direction and modality do not match');
    }
    const key = `${draft.roomId}\u0000${draft.channelId}`;
    const idKey = `${key}\u0000${draft.id}`;
    const fingerprint = transcriptFingerprint(draft);
    const existing = this.transcriptIds.get(idKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error(`room transcript id was reused: ${draft.id}`);
      }
      return { entry: structuredClone(existing.entry), duplicate: true };
    }
    const entries = this.transcripts.get(key) ?? [];
    const entry: RoomAgentTranscriptEntry = {
      ...structuredClone(draft),
      sequence: entries.length + 1,
    };
    entries.push(entry);
    this.transcripts.set(key, entries);
    this.transcriptIds.set(idKey, { fingerprint, entry });
    return { entry: structuredClone(entry), duplicate: false };
  }

  async loadTranscript(
    roomId: string,
    channelId: string,
  ): Promise<readonly RoomAgentTranscriptEntry[]> {
    const entries = this.transcripts.get(`${roomId}\u0000${channelId}`) ?? [];
    return structuredClone(entries);
  }
}

interface SpeechOutcome {
  status: 'completed' | 'interrupted';
}

class RoomSpeechArbiter {
  private active?: { request: RoomSpeechRequest; controller: AbortController };
  private lane: Promise<void> = Promise.resolve();

  constructor(
    private readonly adapter: RoomSpeechAdapter | undefined,
    private readonly captions: RoomCaptionSink | undefined,
    private readonly observer: RoomAgentRuntimeObserver | undefined,
    private readonly now: () => number,
  ) {}

  async speak(request: RoomSpeechRequest, turnSignal: AbortSignal): Promise<SpeechOutcome> {
    const operation = this.lane.then(async (): Promise<SpeechOutcome> => {
      if (turnSignal.aborted) return { status: 'interrupted' };
      const startedAt = this.now();
      const controller = new AbortController();
      const forwardAbort = () => {
        if (request.interruptible) controller.abort(turnSignal.reason);
      };
      turnSignal.addEventListener('abort', forwardAbort, { once: true });
      this.active = { request, controller };
      await this.publishCaption(request, 'started');
      await this.emit({
        type: 'speech_started',
        roomId: request.roomId,
        channelId: request.channelId,
        agentId: request.agentId,
        utteranceId: request.utteranceId,
      });
      try {
        await this.adapter?.speak(request, controller.signal);
        const interrupted = controller.signal.aborted;
        await this.publishCaption(request, interrupted ? 'interrupted' : 'completed');
        await this.emit({
          type: interrupted ? 'speech_interrupted' : 'speech_completed',
          roomId: request.roomId,
          channelId: request.channelId,
          agentId: request.agentId,
          utteranceId: request.utteranceId,
          durationMs: Math.max(0, this.now() - startedAt),
        });
        return { status: interrupted ? 'interrupted' : 'completed' };
      } catch (error) {
        const interrupted = controller.signal.aborted;
        await this.publishCaption(request, interrupted ? 'interrupted' : 'failed');
        await this.emit({
          type: interrupted ? 'speech_interrupted' : 'speech_failed',
          roomId: request.roomId,
          channelId: request.channelId,
          agentId: request.agentId,
          utteranceId: request.utteranceId,
          durationMs: Math.max(0, this.now() - startedAt),
          ...(!interrupted ? { reason: 'speech_adapter_failed' } : {}),
        });
        if (!interrupted) throw error;
        return { status: 'interrupted' };
      } finally {
        turnSignal.removeEventListener('abort', forwardAbort);
        if (this.active?.controller === controller) this.active = undefined;
      }
    });
    this.lane = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  async interrupt(): Promise<boolean> {
    const active = this.active;
    if (active === undefined || !active.request.interruptible) return false;
    active.controller.abort('interrupted');
    await this.adapter?.interrupt?.(active.request.utteranceId);
    return true;
  }

  private async publishCaption(
    request: RoomSpeechRequest,
    status: RoomCaptionEvent['status'],
  ): Promise<void> {
    await this.captions?.publish({ ...structuredClone(request), status });
  }

  private async emit(event: RoomAgentRuntimeEvent): Promise<void> {
    await this.observer?.emit(event);
  }
}

/**
 * Provider-neutral final-text runtime. STT/TTS transports adapt at the edges;
 * this class owns routing, durable boundaries, cancellation, and one speech floor.
 */
export class RoomAgentRuntime<TObservation = unknown, TKnowledge = unknown> {
  private stateValue?: RoomAgentRuntimeState;
  private initialization?: Promise<void>;
  private activeTurn?: AbortController;
  private intakeLane: Promise<void> = Promise.resolve();
  private readonly speechArbiter: RoomSpeechArbiter;

  constructor(private readonly options: RoomAgentRuntimeOptions<TObservation, TKnowledge>) {
    assertText(options?.roomId, 'room agent runtime roomId');
    if (typeof options.contextSource !== 'function') {
      throw new TypeError('room agent runtime requires contextSource');
    }
    if (typeof options.createId !== 'function') {
      throw new TypeError('room agent runtime requires createId');
    }
    this.speechArbiter = new RoomSpeechArbiter(
      options.speech,
      options.captions,
      options.observer,
      options.now ?? Date.now,
    );
  }

  private async initialize(): Promise<void> {
    if (this.initialization !== undefined) return await this.initialization;
    this.initialization = (async () => {
      const stored = await this.options.store.loadState(this.options.roomId);
      const registrations = this.options.registry.list();
      if (registrations.length === 0) {
        throw new Error('room agent runtime requires at least one registered agent');
      }
      const registrationIds = new Set(registrations.map(({ id }) => id));
      const focusByParticipant = Object.fromEntries(
        Object.entries(stored?.focusByParticipant ?? {})
          .filter(([, agentId]) => registrationIds.has(agentId)),
      );
      this.stateValue = {
        schema: ROOM_AGENT_RUNTIME_SCHEMA,
        roomId: this.options.roomId,
        ...(stored?.phase === undefined ? {} : { phase: stored.phase }),
        focusByParticipant,
        registrations: registrations.map(copyDescriptor),
      };
      await this.options.store.saveState(this.stateValue);
    })();
    return await this.initialization;
  }

  async setPhase(phase: string | undefined): Promise<void> {
    await this.initialize();
    if (phase !== undefined) assertText(phase, 'room agent runtime phase');
    const current = this.requireState();
    const withoutPhase: RoomAgentRuntimeState = {
      schema: current.schema,
      roomId: current.roomId,
      focusByParticipant: current.focusByParticipant,
      registrations: current.registrations,
    };
    this.stateValue = phase === undefined
      ? withoutPhase
      : { ...withoutPhase, phase };
    await this.options.store.saveState(this.stateValue);
  }

  async setFocus(participantId: string, agentId: string | null): Promise<void> {
    await this.initialize();
    assertText(participantId, 'room agent runtime participantId');
    if (agentId !== null) {
      assertText(agentId, 'room agent runtime focus agentId');
      this.options.registry.require(agentId);
    }
    const focus = { ...this.requireState().focusByParticipant };
    if (agentId === null) delete focus[participantId];
    else focus[participantId] = agentId;
    this.stateValue = { ...this.requireState(), focusByParticipant: focus };
    await this.options.store.saveState(this.stateValue);
  }

  async interrupt(reason = 'interrupted'): Promise<boolean> {
    const active = this.activeTurn;
    if (active === undefined) return false;
    active.abort(reason);
    await this.speechArbiter.interrupt();
    return true;
  }

  async handleFinalInput(request: RoomAgentRuntimeInput): Promise<RoomAgentRuntimeResult> {
    await this.initialize();
    assertText(request?.channelId, 'room agent runtime channelId');
    assertText(request.input?.id, 'room agent input id');
    assertText(request.input.speakerId, 'room agent input speakerId');
    assertText(request.input.text, 'room agent input text');
    if (request.input.modality !== 'speech' && request.input.modality !== 'text') {
      throw new TypeError('room agent input modality is unsupported');
    }
    const agentId = this.resolveAgent(request.input);
    const admission = await this.admitInput(request);
    if (admission.duplicate) {
      return { status: 'duplicate', agentId, turn: null };
    }
    const { controller } = admission;
    const startedAt = (this.options.now ?? Date.now)();
    await this.emit({
      type: 'turn_started',
      roomId: this.options.roomId,
      channelId: request.channelId,
      turnId: request.input.id,
      agentId,
    });
    try {
      const transcript = await this.options.store.loadTranscript(
        this.options.roomId,
        request.channelId,
      );
      const context = await this.options.contextSource({
        roomId: this.options.roomId,
        channelId: request.channelId,
        agentId,
        input: structuredClone(request.input),
        phase: this.requireState().phase,
        transcript,
      });
      const turn = await this.options.registry.respond(agentId, {
        ...context,
        roomId: this.options.roomId,
        input: structuredClone(request.input),
        signal: controller.signal,
      });
      if (controller.signal.aborted) {
        await this.emitInterrupted(request, agentId, controller, startedAt);
        return { status: 'interrupted', agentId, turn: null };
      }
      if (turn !== null) {
        const descriptor = this.options.registry.require(agentId).descriptor;
        for (const [index, utterance] of turn.utterances.entries()) {
          const utteranceId = this.options.createId();
          assertText(utteranceId, 'created room utterance id');
          await this.options.store.appendTranscript({
            id: utteranceId,
            roomId: this.options.roomId,
            channelId: request.channelId,
            turnId: request.input.id,
            direction: 'output',
            endpoint: { kind: 'agent', id: agentId },
            text: utterance.text,
            modality: 'generated',
          });
          const speech = await this.speechArbiter.speak({
            utteranceId,
            roomId: this.options.roomId,
            channelId: request.channelId,
            agentId,
            text: utterance.text,
            ...(descriptor.voice === undefined
              ? {}
              : { voice: structuredClone(descriptor.voice) }),
            ...(utterance.audience === undefined
              ? {}
              : { audience: structuredClone(utterance.audience) }),
            interruptible: utterance.interruptible ?? true,
          }, controller.signal);
          if (speech.status === 'interrupted' || controller.signal.aborted) {
            await this.emitInterrupted(request, agentId, controller, startedAt);
            return { status: 'interrupted', agentId, turn };
          }
          // Keep each provider call and transcript boundary ordered.
          if (index + 1 < turn.utterances.length && controller.signal.aborted) break;
        }
      }
      await this.emit({
        type: 'turn_completed',
        roomId: this.options.roomId,
        channelId: request.channelId,
        turnId: request.input.id,
        agentId,
        durationMs: Math.max(0, (this.options.now ?? Date.now)() - startedAt),
      });
      return { status: 'completed', agentId, turn };
    } catch (error) {
      if (controller.signal.aborted) {
        await this.emitInterrupted(request, agentId, controller, startedAt);
        return { status: 'interrupted', agentId, turn: null };
      }
      await this.emit({
        type: 'turn_failed',
        roomId: this.options.roomId,
        channelId: request.channelId,
        turnId: request.input.id,
        agentId,
        reason: 'turn_processing_failed',
        durationMs: Math.max(0, (this.options.now ?? Date.now)() - startedAt),
      });
      throw error;
    } finally {
      if (this.activeTurn === controller) this.activeTurn = undefined;
    }
  }

  async resume(channelId: string): Promise<RoomAgentRuntimeResume> {
    await this.initialize();
    assertText(channelId, 'room agent runtime channelId');
    const transcript = await this.options.store.loadTranscript(
      this.options.roomId,
      channelId,
    );
    await this.emit({
      type: 'reconnected',
      roomId: this.options.roomId,
      channelId,
    });
    return { state: structuredClone(this.requireState()), transcript };
  }

  state(): RoomAgentRuntimeState {
    return structuredClone(this.requireState());
  }

  private resolveAgent(input: RoomAgentInput): string {
    const descriptors = this.options.registry.list();
    const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
    const eligible = (agentId: string | undefined): string | undefined => {
      if (agentId === undefined) return undefined;
      const descriptor = byId.get(agentId);
      return descriptor !== undefined && visibleTo(descriptor, input) ? agentId : undefined;
    };
    if (input.addressedAgentIds !== undefined && input.addressedAgentIds.length > 0) {
      const explicit = input.addressedAgentIds.map(eligible).find((id) => id !== undefined);
      if (explicit === undefined) {
        throw new Error('no addressed room agent is registered and visible');
      }
      return explicit;
    }
    const focused = eligible(this.requireState().focusByParticipant[input.speakerId]);
    if (focused !== undefined) return focused;
    const phase = this.requireState().phase;
    const phaseAgent = eligible(phase === undefined
      ? undefined
      : this.options.phaseAgentIds?.[phase]);
    if (phaseAgent !== undefined) return phaseAgent;
    const fallback = eligible(this.options.fallbackAgentId);
    if (fallback !== undefined) return fallback;
    throw new Error('room agent runtime could not resolve a visible agent');
  }

  private async admitInput(
    request: RoomAgentRuntimeInput,
  ): Promise<{ duplicate: true } | { duplicate: false; controller: AbortController }> {
    const operation = this.intakeLane.then(async () => {
      const inputAppend = await this.options.store.appendTranscript({
        id: request.input.id,
        roomId: this.options.roomId,
        channelId: request.channelId,
        turnId: request.input.id,
        direction: 'input',
        endpoint: {
          kind: request.input.speakerKind ?? 'participant',
          id: request.input.speakerId,
        },
        text: request.input.text,
        modality: request.input.modality,
      });
      if (inputAppend.duplicate) return { duplicate: true } as const;
      await this.interrupt('superseded_by_new_input');
      const controller = new AbortController();
      this.activeTurn = controller;
      return { duplicate: false, controller } as const;
    });
    this.intakeLane = operation.then(() => undefined, () => undefined);
    return await operation;
  }

  private requireState(): RoomAgentRuntimeState {
    if (this.stateValue === undefined) {
      throw new Error('room agent runtime is not initialized');
    }
    return this.stateValue;
  }

  private async emit(event: RoomAgentRuntimeEvent): Promise<void> {
    await this.options.observer?.emit(event);
  }

  private async emitInterrupted(
    request: RoomAgentRuntimeInput,
    agentId: string,
    controller: AbortController,
    startedAt: number,
  ): Promise<void> {
    await this.emit({
      type: 'turn_interrupted',
      roomId: this.options.roomId,
      channelId: request.channelId,
      turnId: request.input.id,
      agentId,
      durationMs: Math.max(0, (this.options.now ?? Date.now)() - startedAt),
      ...(typeof controller.signal.reason === 'string'
        ? { reason: controller.signal.reason }
        : {}),
    });
  }
}

/** Compare persisted runtime snapshots without relying on object identity. */
export function sameRoomAgentRuntimeState(
  left: RoomAgentRuntimeState,
  right: RoomAgentRuntimeState,
): boolean {
  return stateFingerprint(left) === stateFingerprint(right);
}
