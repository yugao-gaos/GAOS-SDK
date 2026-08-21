import { canonicalJson } from './protocol.js';
import {
  RoomAgentRegistry,
  type RoomAgentContext,
  type RoomAgentDescriptor,
  type RoomAgentInput,
  type RoomAgentRunEvent,
  type RoomAgentRunProgress,
  type RoomAgentTurn,
  type RoomAgentUtterance,
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

export const ROOM_AGENT_RUN_SCHEMA = 'gaos.room-agent-run.v1' as const;

export type RoomAgentRunStatus =
  | 'active'
  | 'waiting_for_input'
  | 'completed'
  | 'canceled'
  | 'deadline_exceeded'
  | 'failed';

/** Durable, provider-neutral status for one logical task across user turns. */
export interface RoomAgentRunRecord {
  schema: typeof ROOM_AGENT_RUN_SCHEMA;
  id: string;
  roomId: string;
  channelId: string;
  agentId: string;
  rootInputId: string;
  latestInput: RoomAgentInput;
  attempt: number;
  status: RoomAgentRunStatus;
  startedAt: number;
  updatedAt: number;
  /** Active-attempt budget. The wall deadline is paused while waiting for input. */
  deadlineMs?: number;
  deadlineAt?: number;
  lastSequence: number;
  checkpoint?: unknown;
  continuation?: { requestId: string; token: string };
  failureCode?: string;
}

export type RoomAgentRunJournalEvent = RoomAgentRunEvent
  | { type: 'run_canceled'; reason: string }
  | { type: 'deadline_exceeded' }
  | { type: 'run_failed'; code: string };

export interface RoomAgentRunJournalEntry {
  id: string;
  runId: string;
  roomId: string;
  channelId: string;
  agentId: string;
  /** Input attempt that produced this event. */
  inputId: string;
  sequence: number;
  recordedAt: number;
  event: RoomAgentRunJournalEvent;
}

export type RoomAgentRunJournalDraft = Omit<RoomAgentRunJournalEntry, 'sequence'>;

export interface RoomAgentRunJournalAppendResult {
  entry: RoomAgentRunJournalEntry;
  run: RoomAgentRunRecord;
  duplicate: boolean;
}

export interface RoomAgentRunAdmissionResult {
  run: RoomAgentRunRecord;
  transcript: RoomAgentTranscriptEntry;
  duplicate: boolean;
}

/** Durable hosts implement these rows in SQLite or an equivalent ordered store. */
export interface RoomAgentRunStore {
  /**
   * Atomically persist an authenticated input transcript boundary, the new or
   * continued run, and the retry-safe input-to-run index.
   */
  admitRunInput(
    input: RoomAgentTranscriptDraft,
    run: RoomAgentRunRecord,
  ): Promise<RoomAgentRunAdmissionResult>;
  /** Recovery/import seam; fresh authenticated input uses `admitRunInput`. */
  createRun(run: RoomAgentRunRecord): Promise<{ run: RoomAgentRunRecord; duplicate: boolean }>;
  /**
   * Compare-and-set recovery-attempt metadata. Returns false if the stored run
   * is no longer active with the same identity, input, and journal sequence,
   * or if `run.attempt` is not exactly the next attempt.
   */
  saveRun(run: RoomAgentRunRecord): Promise<boolean>;
  loadRun(roomId: string, runId: string): Promise<RoomAgentRunRecord | undefined>;
  loadRunByInput(
    roomId: string,
    channelId: string,
    inputId: string,
  ): Promise<RoomAgentRunRecord | undefined>;
  loadOpenRun(roomId: string, channelId: string): Promise<RoomAgentRunRecord | undefined>;
  /** Atomically append an event and persist the resulting run transition. */
  commitRunEvent(
    run: RoomAgentRunRecord,
    event: RoomAgentRunJournalDraft,
  ): Promise<RoomAgentRunJournalAppendResult>;
  loadRunEvents(roomId: string, runId: string): Promise<readonly RoomAgentRunJournalEntry[]>;
}

export interface RoomAgentRuntimeContextRequest {
  roomId: string;
  channelId: string;
  agentId: string;
  input: RoomAgentInput;
  phase?: string;
  transcript: readonly RoomAgentTranscriptEntry[];
  /** Aborts when the turn is canceled or its active-attempt deadline expires. */
  signal: AbortSignal;
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
  /** Required by `handleRunInput`; kept separate for backward-compatible stores. */
  runStore?: RoomAgentRunStore;
  /** Receives durable run events for UI, cue, or transport-specific presentation. */
  runObserver?: RoomAgentRunObserver;
  /**
   * Optional product policy for turning verified progress into speech. It may
   * use prerecorded, deterministic, or freshly generated text; the SDK does
   * not choose a modality.
   */
  progressPresenter?: RoomAgentProgressPresenter;
  /** Default wall-clock deadline for new runs. Zero or undefined disables it. */
  runDeadlineMs?: number;
  /** Epoch clock used for persisted timestamps and deadlines. Defaults to Date.now. */
  wallNow?: () => number;
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

export interface RoomAgentRunObserver {
  publish(entry: RoomAgentRunJournalEntry): void | Promise<void>;
}

export interface RoomAgentProgressPresentation {
  utterance: RoomAgentUtterance;
  /** Defaults to ephemeral so filler cannot silently enter model history. */
  history?: 'ephemeral' | 'record';
}

export interface RoomAgentProgressPresenterContext {
  run: RoomAgentRunRecord;
  progress: RoomAgentRunProgress;
  signal: AbortSignal;
}

export interface RoomAgentProgressPresenter {
  present(
    context: RoomAgentProgressPresenterContext,
  ): RoomAgentProgressPresentation | null | Promise<RoomAgentProgressPresentation | null>;
}

export interface RoomAgentRunInput extends RoomAgentRuntimeInput {
  /** Explicit proof that this input continues the named waiting run. */
  continuation?: { runId: string; token: string };
  /** Per-run override. Zero disables the default deadline. */
  deadlineMs?: number;
  /** Per-call live delivery, invoked after each event is durably appended. */
  onEvent?(entry: RoomAgentRunJournalEntry): void | Promise<void>;
}

export interface RoomAgentRunResult {
  status: RoomAgentRunStatus | 'duplicate';
  agentId: string;
  run: RoomAgentRunRecord;
  turn: RoomAgentTurn | null;
}

export interface RoomAgentRunReplay {
  run: RoomAgentRunRecord;
  events: readonly RoomAgentRunJournalEntry[];
}

/** Immediate live event stream plus the eventual durable run result. */
export interface RoomAgentRunExecution {
  events: AsyncIterable<RoomAgentRunJournalEntry>;
  result: Promise<RoomAgentRunResult>;
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

function assertTranscriptDraft(draft: RoomAgentTranscriptDraft): void {
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
}

function visibleTo(descriptor: RoomAgentDescriptor, input: RoomAgentInput): boolean {
  if ((input.speakerKind ?? 'participant') !== 'participant') return true;
  return descriptor.visibility === undefined
    || descriptor.visibility.kind === 'room'
    || descriptor.visibility.participantIds.includes(input.speakerId);
}

/** Reference persistence implementation for tests, local hosts, and adapters. */
export class InMemoryRoomAgentRuntimeStore implements RoomAgentRuntimeStore, RoomAgentRunStore {
  private readonly states = new Map<string, RoomAgentRuntimeState>();
  private readonly transcripts = new Map<string, RoomAgentTranscriptEntry[]>();
  private readonly transcriptIds = new Map<
    string,
    { fingerprint: string; entry: RoomAgentTranscriptEntry }
  >();
  private readonly runs = new Map<string, RoomAgentRunRecord>();
  private readonly runInputs = new Map<string, string>();
  private readonly runEvents = new Map<string, RoomAgentRunJournalEntry[]>();
  private readonly runEventIds = new Map<
    string,
    { fingerprint: string; entry: RoomAgentRunJournalEntry }
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
    assertTranscriptDraft(draft);
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

  async admitRunInput(
    input: RoomAgentTranscriptDraft,
    run: RoomAgentRunRecord,
  ): Promise<RoomAgentRunAdmissionResult> {
    assertTranscriptDraft(input);
    assertRunRecord(run);
    const transcriptKey = `${input.roomId}\u0000${input.channelId}`;
    const transcriptIdKey = `${transcriptKey}\u0000${input.id}`;
    const fingerprint = transcriptFingerprint(input);
    const existingTranscript = this.transcriptIds.get(transcriptIdKey);
    if (existingTranscript !== undefined && existingTranscript.fingerprint !== fingerprint) {
      throw new Error(`room transcript id was reused: ${input.id}`);
    }
    const inputKey = runInputKey(run.roomId, run.channelId, run.latestInput.id);
    const existingRunId = this.runInputs.get(inputKey);
    if (existingRunId !== undefined) {
      const existingRun = this.runs.get(`${run.roomId}\u0000${existingRunId}`);
      if (existingRun === undefined || existingTranscript === undefined) {
        throw new Error('room agent run admission index is corrupt');
      }
      return {
        run: structuredClone(existingRun),
        transcript: structuredClone(existingTranscript.entry),
        duplicate: true,
      };
    }

    if (input.direction !== 'input'
      || input.id !== run.latestInput.id
      || input.turnId !== run.latestInput.id
      || input.roomId !== run.roomId
      || input.channelId !== run.channelId
      || input.endpoint.kind !== (run.latestInput.speakerKind ?? 'participant')
      || input.endpoint.id !== run.latestInput.speakerId
      || input.text !== run.latestInput.text
      || input.modality !== run.latestInput.modality) {
      throw new Error('room agent run admission input does not match the run');
    }
    if (run.status !== 'active') {
      throw new Error('room agent admitted run must be active');
    }

    const runKey = `${run.roomId}\u0000${run.id}`;
    const currentRun = this.runs.get(runKey);
    if (currentRun === undefined) {
      if (run.lastSequence !== 0) {
        throw new Error('new room agent run admission must start at sequence zero');
      }
    } else if (currentRun.status !== 'waiting_for_input'
      || run.rootInputId !== currentRun.rootInputId
      || run.attempt !== currentRun.attempt + 1
      || run.lastSequence !== currentRun.lastSequence) {
      throw new Error('continued room agent run admission is stale');
    }

    const entries = this.transcripts.get(transcriptKey) ?? [];
    const transcript = existingTranscript?.entry ?? {
      ...structuredClone(input),
      sequence: entries.length + 1,
    };
    const settledRun = structuredClone(run);
    // All mutations are synchronous; durable adapters perform these writes in
    // one database transaction.
    if (existingTranscript === undefined) {
      entries.push(transcript);
      this.transcripts.set(transcriptKey, entries);
      this.transcriptIds.set(transcriptIdKey, { fingerprint, entry: transcript });
    }
    this.runs.set(runKey, settledRun);
    this.runInputs.set(inputKey, settledRun.id);
    return {
      run: structuredClone(settledRun),
      transcript: structuredClone(transcript),
      duplicate: false,
    };
  }

  async createRun(
    run: RoomAgentRunRecord,
  ): Promise<{ run: RoomAgentRunRecord; duplicate: boolean }> {
    assertRunRecord(run);
    const key = `${run.roomId}\u0000${run.id}`;
    const existing = this.runs.get(key);
    if (existing !== undefined) {
      if (canonicalJson(existing) !== canonicalJson(run)) {
        throw new Error(`room agent run id was reused: ${run.id}`);
      }
      return { run: structuredClone(existing), duplicate: true };
    }
    const inputKey = runInputKey(run.roomId, run.channelId, run.latestInput.id);
    const existingRunId = this.runInputs.get(inputKey);
    if (existingRunId !== undefined) {
      const duplicate = this.runs.get(`${run.roomId}\u0000${existingRunId}`);
      if (duplicate === undefined) throw new Error('room agent run input index is corrupt');
      return { run: structuredClone(duplicate), duplicate: true };
    }
    this.runs.set(key, structuredClone(run));
    this.runInputs.set(inputKey, run.id);
    return { run: structuredClone(run), duplicate: false };
  }

  async saveRun(run: RoomAgentRunRecord): Promise<boolean> {
    assertRunRecord(run);
    const key = `${run.roomId}\u0000${run.id}`;
    const current = this.runs.get(key);
    if (current === undefined) throw new Error(`unknown room agent run: ${run.id}`);
    if (run.status !== 'active') {
      throw new Error('room agent recovery attempt must be active');
    }
    if (current.status !== 'active'
      || run.channelId !== current.channelId
      || run.agentId !== current.agentId
      || run.rootInputId !== current.rootInputId
      || canonicalJson(run.latestInput) !== canonicalJson(current.latestInput)
      || run.startedAt !== current.startedAt
      || run.attempt !== current.attempt + 1
      || run.lastSequence !== current.lastSequence) {
      return false;
    }
    this.runs.set(key, structuredClone(run));
    this.runInputs.set(runInputKey(run.roomId, run.channelId, run.latestInput.id), run.id);
    return true;
  }

  async loadRun(roomId: string, runId: string): Promise<RoomAgentRunRecord | undefined> {
    const run = this.runs.get(`${roomId}\u0000${runId}`);
    return run === undefined ? undefined : structuredClone(run);
  }

  async loadRunByInput(
    roomId: string,
    channelId: string,
    inputId: string,
  ): Promise<RoomAgentRunRecord | undefined> {
    const runId = this.runInputs.get(runInputKey(roomId, channelId, inputId));
    return runId === undefined ? undefined : await this.loadRun(roomId, runId);
  }

  async loadOpenRun(
    roomId: string,
    channelId: string,
  ): Promise<RoomAgentRunRecord | undefined> {
    const candidates = [...this.runs.values()]
      .filter((run) => run.roomId === roomId
        && run.channelId === channelId
        && (run.status === 'active' || run.status === 'waiting_for_input'))
      .sort((left, right) => right.updatedAt - left.updatedAt);
    return candidates[0] === undefined ? undefined : structuredClone(candidates[0]);
  }

  async commitRunEvent(
    nextRun: RoomAgentRunRecord,
    draft: RoomAgentRunJournalDraft,
  ): Promise<RoomAgentRunJournalAppendResult> {
    assertRunRecord(nextRun);
    assertText(draft.id, 'room agent run event id');
    assertText(draft.runId, 'room agent run event runId');
    assertText(draft.inputId, 'room agent run event inputId');
    const key = `${draft.roomId}\u0000${draft.runId}`;
    const currentRun = this.runs.get(key);
    if (currentRun === undefined) throw new Error(`unknown room agent run: ${draft.runId}`);
    const fingerprint = canonicalJson(draft);
    const idKey = `${key}\u0000${draft.id}`;
    const existing = this.runEventIds.get(idKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error(`room agent run event id was reused: ${draft.id}`);
      }
      return {
        entry: structuredClone(existing.entry),
        run: structuredClone(currentRun),
        duplicate: true,
      };
    }
    if (nextRun.id !== draft.runId
      || nextRun.roomId !== draft.roomId
      || nextRun.channelId !== draft.channelId
      || nextRun.agentId !== draft.agentId
      || nextRun.latestInput.id !== draft.inputId) {
      throw new Error('room agent run transition does not match its event');
    }
    if (nextRun.lastSequence !== currentRun.lastSequence) {
      throw new Error('room agent run transition is stale');
    }
    const events = this.runEvents.get(key) ?? [];
    const entry: RoomAgentRunJournalEntry = {
      ...structuredClone(draft),
      sequence: events.length + 1,
    };
    const settledRun: RoomAgentRunRecord = {
      ...structuredClone(nextRun),
      lastSequence: entry.sequence,
      updatedAt: entry.recordedAt,
    };
    // These in-memory mutations are synchronous. Durable adapters implement
    // the same operation in one database transaction.
    events.push(entry);
    this.runEvents.set(key, events);
    this.runEventIds.set(idKey, { fingerprint, entry });
    this.runs.set(key, settledRun);
    this.runInputs.set(
      runInputKey(settledRun.roomId, settledRun.channelId, settledRun.latestInput.id),
      settledRun.id,
    );
    return {
      entry: structuredClone(entry),
      run: structuredClone(settledRun),
      duplicate: false,
    };
  }

  async loadRunEvents(
    roomId: string,
    runId: string,
  ): Promise<readonly RoomAgentRunJournalEntry[]> {
    return structuredClone(this.runEvents.get(`${roomId}\u0000${runId}`) ?? []);
  }
}

function runInputKey(roomId: string, channelId: string, inputId: string): string {
  return `${roomId}\u0000${channelId}\u0000${inputId}`;
}

function assertRunRecord(run: RoomAgentRunRecord): void {
  if (run?.schema !== ROOM_AGENT_RUN_SCHEMA) {
    throw new TypeError('room agent run schema is unsupported');
  }
  assertText(run.id, 'room agent run id');
  assertText(run.roomId, 'room agent run roomId');
  assertText(run.channelId, 'room agent run channelId');
  assertText(run.agentId, 'room agent run agentId');
  assertText(run.rootInputId, 'room agent run rootInputId');
  if (!Number.isSafeInteger(run.attempt) || run.attempt < 1) {
    throw new RangeError('room agent run attempt must be positive');
  }
  if (!Number.isSafeInteger(run.lastSequence) || run.lastSequence < 0) {
    throw new RangeError('room agent run lastSequence must be non-negative');
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
  private activeTurn?: { controller: AbortController; runId?: string };
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
    active.controller.abort(reason);
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
        signal: controller.signal,
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
      if (this.activeTurn?.controller === controller) this.activeTurn = undefined;
    }
  }

  /**
   * Start or continue a durable logical run. A waiting run on the same channel
   * is continued automatically; clients may supply the token for strict
   * correlation. A legacy `respond()` driver is adapted to this lifecycle.
   */
  async handleRunInput(request: RoomAgentRunInput): Promise<RoomAgentRunResult> {
    await this.initialize();
    this.assertRuntimeInput(request);
    const admission = await this.withIntakeLane(
      async () => await this.admitDurableRunInput(request),
    );
    // Admissions already queued behind this one finish their cancellation and
    // controller handoff before an older run can enter provider work. The run
    // itself still executes outside the intake lane.
    await this.intakeLane;
    if (admission.duplicate) {
      return {
        status: 'duplicate',
        agentId: admission.run.agentId,
        run: admission.run,
        turn: null,
      };
    }
    return await this.executeRun(
      admission.run,
      admission.controller,
      admission.continuation,
      false,
      request.onEvent,
    );
  }

  /**
   * Start a run without awaiting completion. This is the voice/chat streaming
   * seam: consumers can forward assistant deltas while `result` remains open.
   */
  startRun(request: RoomAgentRunInput): RoomAgentRunExecution {
    const queue = new RoomAgentRunEventQueue();
    const result = this.handleRunInput({
      ...request,
      onEvent: async (entry) => {
        queue.push(entry);
        await request.onEvent?.(entry);
      },
    });
    void result.then(
      () => queue.close(),
      (error: unknown) => queue.fail(error),
    );
    return { events: queue, result };
  }

  /** Resume checkpoint-aware active work after a host/runtime restart. */
  async resumeRun(runId: string): Promise<RoomAgentRunResult> {
    await this.initialize();
    assertText(runId, 'room agent run id');
    const runStore = this.requireRunStore();
    const stored = await runStore.loadRun(this.options.roomId, runId);
    if (stored === undefined) throw new Error(`unknown room agent run: ${runId}`);
    if (stored.status !== 'active') {
      return { status: stored.status, agentId: stored.agentId, run: stored, turn: null };
    }
    await this.interrupt('run_resumed');
    const controller = new AbortController();
    this.activeTurn = { controller, runId };
    const run = {
      ...stored,
      attempt: stored.attempt + 1,
      updatedAt: this.wallNow(),
    };
    const acquired = await runStore.saveRun(run);
    if (!acquired) {
      controller.abort('resume_ownership_lost');
      if (this.activeTurn?.controller === controller) this.activeTurn = undefined;
      const current = await runStore.loadRun(this.options.roomId, runId);
      if (current === undefined) throw new Error(`unknown room agent run: ${runId}`);
      return { status: current.status, agentId: current.agentId, run: current, turn: null };
    }
    return await this.executeRun(run, controller, undefined, true);
  }

  /** Cooperatively cancel a live run and durably record the terminal state. */
  async cancelRun(runId: string, reason = 'canceled_by_host'): Promise<boolean> {
    await this.initialize();
    assertText(runId, 'room agent run id');
    assertText(reason, 'room agent run cancellation reason');
    const runStore = this.requireRunStore();
    const run = await runStore.loadRun(this.options.roomId, runId);
    if (run === undefined || isTerminalRun(run.status)) return false;
    if (this.activeTurn?.runId === runId) {
      this.activeTurn.controller.abort(reason);
      await this.speechArbiter.interrupt();
    }
    await this.finishRun(run, 'canceled', { type: 'run_canceled', reason });
    return true;
  }

  /** Read the exact durable event sequence without replaying side effects. */
  async replayRun(runId: string): Promise<RoomAgentRunReplay> {
    await this.initialize();
    assertText(runId, 'room agent run id');
    const runStore = this.requireRunStore();
    const run = await runStore.loadRun(this.options.roomId, runId);
    if (run === undefined) throw new Error(`unknown room agent run: ${runId}`);
    const events = await runStore.loadRunEvents(this.options.roomId, runId);
    return { run, events };
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

  private async admitDurableRunInput(
    request: RoomAgentRunInput,
  ): Promise<DurableRunAdmission> {
    const runStore = this.requireRunStore();
    const agentId = this.resolveAgent(request.input);
    const duplicate = await runStore.loadRunByInput(
      this.options.roomId,
      request.channelId,
      request.input.id,
    );
    if (duplicate !== undefined) {
      const retried = await runStore.admitRunInput(
        this.inputTranscriptDraft(request),
        duplicate,
      );
      return { duplicate: true, run: retried.run };
    }

    const open = await runStore.loadOpenRun(this.options.roomId, request.channelId);
    let continuation: RoomAgentRunRecord['continuation'];
    let run: RoomAgentRunRecord;
    let supersededRunId: string | undefined;
    if (request.continuation !== undefined) {
      if (open === undefined
        || open.id !== request.continuation.runId
        || open.status !== 'waiting_for_input'
        || open.continuation?.token !== request.continuation.token) {
        throw new Error('room agent continuation does not match a waiting run');
      }
    }
    const continuesOpen = open?.status === 'waiting_for_input'
      && open.agentId === agentId
      && (request.continuation === undefined || request.continuation.runId === open.id);
    if (continuesOpen && open !== undefined) {
      continuation = open.continuation;
      const deadlineMs = request.deadlineMs ?? open.deadlineMs ?? this.options.runDeadlineMs;
      if (deadlineMs !== undefined
        && (!Number.isFinite(deadlineMs) || deadlineMs < 0)) {
        throw new RangeError('room agent run deadlineMs must be non-negative');
      }
      const now = this.wallNow();
      run = {
        ...open,
        latestInput: structuredClone(request.input),
        attempt: open.attempt + 1,
        status: 'active',
        updatedAt: now,
        ...(deadlineMs === undefined || deadlineMs === 0
          ? { deadlineMs: undefined, deadlineAt: undefined }
          : { deadlineMs, deadlineAt: now + deadlineMs }),
        continuation: undefined,
        failureCode: undefined,
      };
    } else {
      supersededRunId = open?.id;
      const now = this.wallNow();
      const deadlineMs = request.deadlineMs ?? this.options.runDeadlineMs;
      if (deadlineMs !== undefined
        && (!Number.isFinite(deadlineMs) || deadlineMs < 0)) {
        throw new RangeError('room agent run deadlineMs must be non-negative');
      }
      const runId = this.options.createId();
      assertText(runId, 'created room agent run id');
      run = {
        schema: ROOM_AGENT_RUN_SCHEMA,
        id: runId,
        roomId: this.options.roomId,
        channelId: request.channelId,
        agentId,
        rootInputId: request.input.id,
        latestInput: structuredClone(request.input),
        attempt: 1,
        status: 'active',
        startedAt: now,
        updatedAt: now,
        ...(deadlineMs === undefined || deadlineMs === 0
          ? {}
          : { deadlineMs, deadlineAt: now + deadlineMs }),
        lastSequence: 0,
      };
    }

    const admission = await runStore.admitRunInput(this.inputTranscriptDraft(request), run);
    if (admission.duplicate) return { duplicate: true, run: admission.run };
    if (supersededRunId !== undefined) {
      await this.cancelRun(supersededRunId, 'superseded_by_new_input');
    }
    await this.interrupt('superseded_by_new_input');
    const controller = new AbortController();
    this.activeTurn = { controller, runId: admission.run.id };
    return {
      duplicate: false,
      run: admission.run,
      controller,
      ...(continuation === undefined ? {} : { continuation }),
    };
  }

  private async executeRun(
    initialRun: RoomAgentRunRecord,
    controller: AbortController,
    continuation: RoomAgentRunRecord['continuation'],
    resumed: boolean,
    liveObserver?: RoomAgentRunInput['onEvent'],
  ): Promise<RoomAgentRunResult> {
    const runStore = this.requireRunStore();
    let run = structuredClone(initialRun);
    const recordedUtterances: RoomAgentUtterance[] = [];
    const interactions: NonNullable<RoomAgentTurn['interactions']>[number][] = [];
    let action: RoomAgentTurn['action'];
    let waiting = false;
    let completed = false;
    const replayedEvents = await runStore.loadRunEvents(this.options.roomId, run.id);
    const buffers = this.restoreOutputBuffers(replayedEvents);
    await this.reconcileRecordedOutputs(run, replayedEvents);
    if (controller.signal.aborted) {
      try {
        const settled = await this.settleAbortedRun(run, controller, liveObserver);
        return { status: settled.status, agentId: run.agentId, run: settled, turn: null };
      } finally {
        if (this.activeTurn?.controller === controller) this.activeTurn = undefined;
      }
    }
    const deadlineRemaining = run.deadlineAt === undefined
      ? undefined
      : run.deadlineAt - this.wallNow();
    if (deadlineRemaining !== undefined && deadlineRemaining <= 0) {
      await this.finishRun(run, 'deadline_exceeded', { type: 'deadline_exceeded' });
      const settled = await runStore.loadRun(run.roomId, run.id);
      if (settled === undefined) throw new Error(`unknown room agent run: ${run.id}`);
      return { status: 'deadline_exceeded', agentId: run.agentId, run: settled, turn: null };
    }
    const timer = deadlineRemaining === undefined
      ? undefined
      : setTimeout(() => controller.abort('deadline_exceeded'), deadlineRemaining);

    const append = async (
      event: RoomAgentRunJournalEvent,
      transition?: (current: RoomAgentRunRecord) => RoomAgentRunRecord,
    ): Promise<RoomAgentRunJournalEntry> => {
      const eventId = this.options.createId();
      assertText(eventId, 'created room agent run event id');
      const appended = await runStore.commitRunEvent(transition?.(run) ?? run, {
        id: eventId,
        runId: run.id,
        roomId: run.roomId,
        channelId: run.channelId,
        agentId: run.agentId,
        inputId: run.latestInput.id,
        recordedAt: this.wallNow(),
        event: structuredClone(event),
      });
      run = appended.run;
      await this.options.runObserver?.publish(appended.entry);
      await liveObserver?.(appended.entry);
      return appended.entry;
    };

    const handleOutput = async (
      event: Extract<RoomAgentRunEvent, { type: 'assistant_output' }>,
      alreadyJournaled = false,
    ): Promise<void> => {
      if (!alreadyJournaled) await append(event);
      const current = buffers.get(event.outputId) ?? {
        text: '',
        purpose: event.purpose ?? 'answer',
        history: event.history ?? ((event.purpose ?? 'answer') === 'progress'
          ? 'ephemeral'
          : 'record'),
        audience: event.audience,
        interruptible: event.interruptible ?? true,
        closed: false,
      };
      if (current.closed) throw new Error(`room agent output is already closed: ${event.outputId}`);
      if (event.purpose !== undefined && event.purpose !== current.purpose) {
        throw new Error(`room agent output purpose changed: ${event.outputId}`);
      }
      if (event.history !== undefined && event.history !== current.history) {
        throw new Error(`room agent output history changed: ${event.outputId}`);
      }
      current.text += event.delta;
      current.purpose = event.purpose ?? current.purpose;
      current.history = event.history ?? current.history;
      current.audience = event.audience ?? current.audience;
      current.interruptible = event.interruptible ?? current.interruptible;
      current.closed = event.final === true;
      buffers.set(event.outputId, current);
      if (!current.closed) return;
      assertText(current.text, 'completed room agent output');
      const utterance: RoomAgentUtterance = {
        text: current.text,
        ...(current.audience === undefined ? {} : { audience: current.audience }),
        interruptible: current.interruptible,
      };
      if (current.history === 'record') {
        await this.options.store.appendTranscript({
          id: `${run.id}:output:${event.outputId}`,
          roomId: run.roomId,
          channelId: run.channelId,
          turnId: run.latestInput.id,
          direction: 'output',
          endpoint: { kind: 'agent', id: run.agentId },
          text: current.text,
          modality: 'generated',
        });
        recordedUtterances.push(utterance);
      }
      const descriptor = this.options.registry.require(run.agentId).descriptor;
      const speech = await this.speechArbiter.speak({
        utteranceId: event.outputId,
        roomId: run.roomId,
        channelId: run.channelId,
        agentId: run.agentId,
        text: current.text,
        ...(descriptor.voice === undefined ? {} : { voice: descriptor.voice }),
        ...(current.audience === undefined ? {} : { audience: current.audience }),
        interruptible: current.interruptible,
      }, controller.signal);
      if (speech.status === 'interrupted') controller.abort(controller.signal.reason);
    };

    try {
      const transcript = await this.options.store.loadTranscript(run.roomId, run.channelId);
      const context = await this.options.contextSource({
        roomId: run.roomId,
        channelId: run.channelId,
        agentId: run.agentId,
        input: structuredClone(run.latestInput),
        phase: this.requireState().phase,
        transcript,
        signal: controller.signal,
      });
      for await (const event of this.options.registry.run(run.agentId, {
        ...context,
        roomId: run.roomId,
        input: structuredClone(run.latestInput),
        signal: controller.signal,
      }, {
        id: run.id,
        attempt: run.attempt,
        resumed,
        ...(run.checkpoint === undefined ? {} : { checkpoint: structuredClone(run.checkpoint) }),
        ...(continuation === undefined
          ? {}
          : { continuation: { requestId: continuation.requestId, token: continuation.token } }),
      })) {
        if (controller.signal.aborted) break;
        if (event.type === 'progress') {
          await append(event);
          const presentation = await this.options.progressPresenter?.present({
            run: structuredClone(run),
            progress: structuredClone(event.progress),
            signal: controller.signal,
          });
          if (presentation !== undefined && presentation !== null) {
            assertText(presentation.utterance.text, 'room agent progress presentation text');
            const outputId = this.options.createId();
            assertText(outputId, 'created room agent progress output id');
            const descriptor = this.options.registry.require(run.agentId).descriptor;
            const audience = clampRunAudience(descriptor, presentation.utterance.audience);
            await handleOutput({
              type: 'assistant_output',
              outputId,
              delta: presentation.utterance.text,
              final: true,
              purpose: 'progress',
              history: presentation.history ?? 'ephemeral',
              ...(audience === undefined ? {} : { audience }),
              interruptible: presentation.utterance.interruptible ?? true,
            });
          }
        } else if (event.type === 'assistant_output') {
          await append(event);
          await handleOutput(event, true);
        } else if (event.type === 'checkpoint') {
          await append(event, (current) => ({
            ...current,
            checkpoint: structuredClone(event.value),
          }));
        } else if (event.type === 'input_requested') {
          if ([...buffers.values()].some((buffer) => !buffer.closed)) {
            throw new Error('room agent requested input with an open assistant output');
          }
          await append(event, (current) => ({
            ...current,
            status: 'waiting_for_input',
            deadlineAt: undefined,
            continuation: {
              requestId: event.requestId,
              token: event.continuationToken,
            },
          }));
          waiting = true;
          break;
        } else if (event.type === 'decision') {
          await append(event);
          for (const utterance of event.decision.utterances ?? []) {
            const outputId = this.options.createId();
            assertText(outputId, 'created room agent decision output id');
            await handleOutput({
              type: 'assistant_output',
              outputId,
              delta: utterance.text,
              final: true,
              purpose: 'answer',
              history: 'record',
              ...(utterance.audience === undefined ? {} : { audience: utterance.audience }),
              interruptible: utterance.interruptible ?? true,
            });
          }
          interactions.push(...structuredClone(event.decision.interactions ?? []));
          if (event.decision.action !== undefined) {
            if (action !== undefined) {
              throw new Error('room agent run proposed more than one action');
            }
            const subject = this.options.registry.require(run.agentId).descriptor.controlSubject;
            if (subject === undefined) {
              throw new Error(`speech-only room agent cannot propose an action: ${run.agentId}`);
            }
            action = { subject: structuredClone(subject), action: structuredClone(event.decision.action) };
          }
        } else if (event.type === 'completed') {
          if ([...buffers.values()].some((buffer) => !buffer.closed)) {
            throw new Error('room agent run completed with an open assistant output');
          }
          await append(event, (current) => ({
            ...current,
            status: 'completed',
            continuation: undefined,
          }));
          completed = true;
          break;
        }
      }

      if (controller.signal.aborted) {
        const settled = await this.settleAbortedRun(run, controller, liveObserver);
        return { status: settled.status, agentId: run.agentId, run: settled, turn: null };
      }

      if (waiting) {
        const turn = makeRunTurn(run.agentId, recordedUtterances, interactions, action);
        return { status: 'waiting_for_input', agentId: run.agentId, run, turn };
      }
      if ([...buffers.values()].some((buffer) => !buffer.closed)) {
        throw new Error('room agent run completed with an open assistant output');
      }
      if (!completed) {
        await append({ type: 'completed' }, (current) => ({
          ...current,
          status: 'completed',
          continuation: undefined,
        }));
      }
      const turn = makeRunTurn(run.agentId, recordedUtterances, interactions, action);
      return { status: 'completed', agentId: run.agentId, run, turn };
    } catch (error) {
      if (controller.signal.aborted) {
        const settled = await this.settleAbortedRun(run, controller, liveObserver);
        return { status: settled.status, agentId: run.agentId, run: settled, turn: null };
      }
      await this.finishRun(
        run,
        'failed',
        { type: 'run_failed', code: 'run_processing_failed' },
        liveObserver,
      );
      throw error;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      if (this.activeTurn?.controller === controller) this.activeTurn = undefined;
    }
  }

  private restoreOutputBuffers(
    events: readonly RoomAgentRunJournalEntry[],
  ): Map<string, OutputBuffer> {
    const buffers = new Map<string, OutputBuffer>();
    for (const entry of events) {
      if (entry.event.type !== 'assistant_output') continue;
      const event = entry.event;
      const current = buffers.get(event.outputId) ?? {
        text: '',
        purpose: event.purpose ?? 'answer',
        history: event.history ?? ((event.purpose ?? 'answer') === 'progress'
          ? 'ephemeral'
          : 'record'),
        audience: event.audience,
        interruptible: event.interruptible ?? true,
        closed: false,
      };
      current.text += event.delta;
      current.closed = event.final === true;
      buffers.set(event.outputId, current);
    }
    return buffers;
  }

  /**
   * The journal is the source of truth. If an isolate died after committing a
   * final recorded output but before transcript append, repair that boundary
   * idempotently without presenting the output again.
   */
  private async reconcileRecordedOutputs(
    run: RoomAgentRunRecord,
    events: readonly RoomAgentRunJournalEntry[],
  ): Promise<void> {
    const outputs = new Map<string, OutputBuffer & { inputId: string }>();
    for (const entry of events) {
      if (entry.event.type !== 'assistant_output') continue;
      const event = entry.event;
      const current = outputs.get(event.outputId) ?? {
        text: '',
        purpose: event.purpose ?? 'answer',
        history: event.history ?? ((event.purpose ?? 'answer') === 'progress'
          ? 'ephemeral'
          : 'record'),
        audience: event.audience,
        interruptible: event.interruptible ?? true,
        closed: false,
        inputId: entry.inputId,
      };
      current.text += event.delta;
      current.history = event.history ?? current.history;
      current.closed = event.final === true;
      current.inputId = entry.inputId;
      outputs.set(event.outputId, current);
    }
    for (const [outputId, output] of outputs) {
      if (!output.closed || output.history !== 'record') continue;
      assertText(output.text, 'reconciled room agent output');
      await this.options.store.appendTranscript({
        id: `${run.id}:output:${outputId}`,
        roomId: run.roomId,
        channelId: run.channelId,
        turnId: output.inputId,
        direction: 'output',
        endpoint: { kind: 'agent', id: run.agentId },
        text: output.text,
        modality: 'generated',
      });
    }
  }

  private async finishRun(
    run: RoomAgentRunRecord,
    status: Extract<RoomAgentRunStatus, 'canceled' | 'deadline_exceeded' | 'failed'>,
    event: Extract<RoomAgentRunJournalEvent,
      { type: 'run_canceled' | 'deadline_exceeded' | 'run_failed' }>,
    liveObserver?: RoomAgentRunInput['onEvent'],
  ): Promise<void> {
    const runStore = this.requireRunStore();
    const current = await runStore.loadRun(run.roomId, run.id);
    if (current === undefined) throw new Error(`unknown room agent run: ${run.id}`);
    if (isTerminalRun(current.status)) return;
    const eventId = this.options.createId();
    assertText(eventId, 'created room agent terminal event id');
    const appended = await runStore.commitRunEvent({
      ...current,
      status,
      continuation: undefined,
      ...(event.type === 'run_failed' ? { failureCode: event.code } : {}),
    }, {
      id: eventId,
      runId: run.id,
      roomId: run.roomId,
      channelId: run.channelId,
      agentId: run.agentId,
      inputId: current.latestInput.id,
      recordedAt: this.wallNow(),
      event,
    });
    await this.options.runObserver?.publish(appended.entry);
    await liveObserver?.(appended.entry);
  }

  private async settleAbortedRun(
    run: RoomAgentRunRecord,
    controller: AbortController,
    liveObserver?: RoomAgentRunInput['onEvent'],
  ): Promise<RoomAgentRunRecord> {
    const deadline = controller.signal.reason === 'deadline_exceeded';
    const status: Extract<RoomAgentRunStatus, 'canceled' | 'deadline_exceeded'> = deadline
      ? 'deadline_exceeded'
      : 'canceled';
    const terminal: Extract<RoomAgentRunJournalEvent,
      { type: 'run_canceled' | 'deadline_exceeded' }> = deadline
      ? { type: 'deadline_exceeded' }
      : {
        type: 'run_canceled',
        reason: typeof controller.signal.reason === 'string'
          ? controller.signal.reason
          : 'canceled',
      };
    await this.finishRun(run, status, terminal, liveObserver);
    const settled = await this.requireRunStore().loadRun(run.roomId, run.id);
    if (settled === undefined) throw new Error(`unknown room agent run: ${run.id}`);
    return settled;
  }

  private requireRunStore(): RoomAgentRunStore {
    if (this.options.runStore === undefined) {
      throw new Error('room agent runtime requires runStore for durable runs');
    }
    return this.options.runStore;
  }

  private wallNow(): number {
    return (this.options.wallNow ?? Date.now)();
  }

  private assertRuntimeInput(request: RoomAgentRuntimeInput): void {
    assertText(request?.channelId, 'room agent runtime channelId');
    assertText(request.input?.id, 'room agent input id');
    assertText(request.input.speakerId, 'room agent input speakerId');
    assertText(request.input.text, 'room agent input text');
    if (request.input.modality !== 'speech' && request.input.modality !== 'text') {
      throw new TypeError('room agent input modality is unsupported');
    }
  }

  private inputTranscriptDraft(request: RoomAgentRuntimeInput): RoomAgentTranscriptDraft {
    return {
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
    };
  }

  private async admitInput(
    request: RoomAgentRuntimeInput,
  ): Promise<{ duplicate: true } | { duplicate: false; controller: AbortController }> {
    return await this.withIntakeLane(async () => {
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
      this.activeTurn = { controller };
      return { duplicate: false, controller } as const;
    });
  }

  private async withIntakeLane<T>(operation: () => Promise<T>): Promise<T> {
    const queued = this.intakeLane.then(operation);
    this.intakeLane = queued.then(() => undefined, () => undefined);
    return await queued;
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

type DurableRunAdmission =
  | { duplicate: true; run: RoomAgentRunRecord }
  | {
    duplicate: false;
    run: RoomAgentRunRecord;
    controller: AbortController;
    continuation?: RoomAgentRunRecord['continuation'];
  };

interface OutputBuffer {
  text: string;
  purpose: 'progress' | 'answer' | 'question';
  history: 'ephemeral' | 'record';
  audience: RoomAgentUtterance['audience'];
  interruptible: boolean;
  closed: boolean;
}

class RoomAgentRunEventQueue implements AsyncIterable<RoomAgentRunJournalEntry> {
  private readonly values: RoomAgentRunJournalEntry[] = [];
  private readonly waiters: Array<{
    resolve(value: IteratorResult<RoomAgentRunJournalEntry>): void;
    reject(reason: unknown): void;
  }> = [];
  private ended = false;
  private failure?: unknown;

  push(value: RoomAgentRunJournalEntry): void {
    if (this.ended) return;
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(structuredClone(value));
    else waiter.resolve({ done: false, value: structuredClone(value) });
  }

  close(): void {
    if (this.ended) return;
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.resolve({ done: true, value: undefined });
    }
  }

  fail(reason: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.failure = reason;
    for (const waiter of this.waiters.splice(0)) waiter.reject(reason);
  }

  [Symbol.asyncIterator](): AsyncIterator<RoomAgentRunJournalEntry> {
    return {
      next: async (): Promise<IteratorResult<RoomAgentRunJournalEntry>> => {
        const value = this.values.shift();
        if (value !== undefined) return { done: false, value };
        if (this.failure !== undefined) throw this.failure;
        if (this.ended) return { done: true, value: undefined };
        return await new Promise((resolve, reject) => {
          this.waiters.push({ resolve, reject });
        });
      },
    };
  }
}

function isTerminalRun(status: RoomAgentRunStatus): boolean {
  return status === 'completed'
    || status === 'canceled'
    || status === 'deadline_exceeded'
    || status === 'failed';
}

function makeRunTurn(
  agentId: string,
  utterances: readonly RoomAgentUtterance[],
  interactions: NonNullable<RoomAgentTurn['interactions']>,
  action: RoomAgentTurn['action'],
): RoomAgentTurn | null {
  if (utterances.length === 0 && interactions.length === 0 && action === undefined) return null;
  return {
    agentId,
    utterances: structuredClone(utterances),
    ...(interactions.length === 0 ? {} : { interactions: structuredClone(interactions) }),
    ...(action === undefined ? {} : { action: structuredClone(action) }),
  };
}

function clampRunAudience(
  descriptor: RoomAgentDescriptor,
  requested: RoomAgentUtterance['audience'],
): RoomAgentUtterance['audience'] {
  if (descriptor.visibility === undefined || descriptor.visibility.kind === 'room') {
    return requested === undefined ? undefined : structuredClone(requested);
  }
  if (requested === undefined || requested.kind === 'room') {
    return structuredClone(descriptor.visibility);
  }
  const permitted = new Set(descriptor.visibility.participantIds);
  const participantIds = requested.participantIds.filter((id) => permitted.has(id));
  if (participantIds.length === 0) {
    throw new Error(
      `room agent progress presentation has no permitted audience: ${descriptor.id}`,
    );
  }
  return { kind: 'participants', participantIds };
}

/** Compare persisted runtime snapshots without relying on object identity. */
export function sameRoomAgentRuntimeState(
  left: RoomAgentRuntimeState,
  right: RoomAgentRuntimeState,
): boolean {
  return stateFingerprint(left) === stateFingerprint(right);
}
