import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryRoomAgentRuntimeStore,
  RoomAgentRuntime,
  waitWithRoomAgentProgress,
  type RoomAgentRuntimeContextSource,
  type RoomAgentRuntimeEvent,
  type RoomAgentRunAdmissionResult,
  type RoomAgentRunJournalAppendResult,
  type RoomAgentRunJournalDraft,
  type RoomAgentRunJournalEntry,
  type RoomAgentRunRecord,
  type RoomAgentTranscriptDraft,
  type RoomCaptionEvent,
  type RoomSpeechRequest,
} from '../src/room-agent-runtime.js';
import {
  RoomAgentRegistry,
  type GameAgentManifest,
  type RoomAgentContext,
  type RoomAgentRunContext,
} from '../src/room-agent.js';

interface Observation {
  phase: string;
}

const manifest: GameAgentManifest = {
  gameId: 'runtime-demo',
  gameVersion: '1.0.0',
  rules: [],
};

const participants = [
  { id: 'visitor-1', role: 'spectator' as const },
];

const roomDisclosure = { kind: 'room' } as const;
const privateDisclosure = {
  kind: 'participants',
  participantIds: ['visitor-1'],
} as const;

function contextSource(): RoomAgentRuntimeContextSource<Observation> {
  return async ({ phase }): Promise<Omit<
    RoomAgentContext<Observation>,
    'agent' | 'roomId' | 'input' | 'interaction' | 'signal'
  >> => ({
    participants,
    observation: { phase: phase ?? 'arrival' },
    manifest,
    legalActions: [],
    tick: 0,
  });
}

function idFactory(): () => string {
  let next = 0;
  return () => `runtime-${++next}`;
}

function assertPlainJson(value: unknown, path = 'value'): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} must contain only plain JSON values`);
    return;
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) throw new TypeError(`${path} must contain only plain JSON values`);
      assertPlainJson(value[index], `${path}[${index}]`);
    }
    return;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} must contain only plain JSON values`);
    }
    for (const [key, child] of Object.entries(value)) {
      assertPlainJson(child, `${path}.${key}`);
    }
    return;
  }
  throw new TypeError(`${path} must contain only plain JSON values`);
}

class JsonStrictRunStore extends InMemoryRoomAgentRuntimeStore {
  readonly persistedRuns: Array<{
    operation: 'admitRunInput' | 'createRun' | 'saveRun' | 'commitRunEvent';
    run: RoomAgentRunRecord;
  }> = [];

  private record(
    operation: 'admitRunInput' | 'createRun' | 'saveRun' | 'commitRunEvent',
    run: RoomAgentRunRecord,
  ): void {
    assertPlainJson(run, 'run');
    this.persistedRuns.push({ operation, run: structuredClone(run) });
  }

  override async admitRunInput(
    input: RoomAgentTranscriptDraft,
    run: RoomAgentRunRecord,
  ): Promise<RoomAgentRunAdmissionResult> {
    this.record('admitRunInput', run);
    return await super.admitRunInput(input, run);
  }

  override async createRun(
    run: RoomAgentRunRecord,
  ): Promise<{ run: RoomAgentRunRecord; duplicate: boolean }> {
    this.record('createRun', run);
    return await super.createRun(run);
  }

  override async saveRun(run: RoomAgentRunRecord): Promise<boolean> {
    this.record('saveRun', run);
    return await super.saveRun(run);
  }

  override async commitRunEvent(
    run: RoomAgentRunRecord,
    event: RoomAgentRunJournalDraft,
  ): Promise<RoomAgentRunJournalAppendResult> {
    this.record('commitRunEvent', run);
    return await super.commitRunEvent(run, event);
  }
}

function activeRecoveryRun(id: string, channelId: string): RoomAgentRunRecord {
  return {
    schema: 'gaos.room-agent-run.v1',
    id,
    roomId: 'room-1',
    channelId,
    agentId: 'oracle',
    rootInputId: 'input-1',
    latestInput: {
      id: 'input-1', speakerId: 'visitor-1', text: 'Recover', modality: 'text',
    },
    disclosure: privateDisclosure,
    attempt: 1,
    status: 'active',
    startedAt: 1,
    updatedAt: 1,
    lastSequence: 0,
  };
}

async function seedRecoveryOutput(
  store: InMemoryRoomAgentRuntimeStore,
  run: RoomAgentRunRecord,
  event: Extract<RoomAgentRunJournalDraft['event'], { type: 'assistant_output' }>,
): Promise<void> {
  await store.createRun(run);
  await store.appendTranscript({
    id: run.latestInput.id,
    roomId: run.roomId,
    channelId: run.channelId,
    turnId: run.latestInput.id,
    direction: 'input',
    endpoint: { kind: 'participant', id: run.latestInput.speakerId },
    disclosure: run.disclosure,
    text: run.latestInput.text,
    modality: run.latestInput.modality,
  });
  await store.commitRunEvent(run, {
    id: `${run.id}:crash-output`,
    runId: run.id,
    roomId: run.roomId,
    channelId: run.channelId,
    agentId: run.agentId,
    inputId: run.latestInput.id,
    recordedAt: 2,
    event,
  });
}

describe('room agent runtime', () => {
  it('routes explicit address, participant focus, phase policy, then fallback', async () => {
    const calls: string[] = [];
    const registry = new RoomAgentRegistry<Observation>([
      {
        descriptor: { id: 'guide', label: 'Guide', role: 'guide' },
        driver: { respond: async () => {
          calls.push('guide');
          return { utterances: [{ text: 'Guide.' }] };
        } },
      },
      {
        descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
        driver: { respond: async () => {
          calls.push('oracle');
          return { utterances: [{ text: 'Oracle.' }] };
        } },
      },
    ]);
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1',
      registry,
      store: new InMemoryRoomAgentRuntimeStore(),
      contextSource: contextSource(),
      createId: idFactory(),
      fallbackAgentId: 'guide',
      phaseAgentIds: { ritual: 'oracle' },
    });

    await runtime.setPhase('ritual');
    await runtime.handleFinalInput({
      channelId: 'public',
      disclosure: roomDisclosure,
      input: {
        id: 'turn-1', speakerId: 'visitor-1', text: 'Hello', modality: 'text',
      },
    });
    await runtime.setFocus('visitor-1', 'guide');
    await runtime.handleFinalInput({
      channelId: 'public',
      disclosure: roomDisclosure,
      input: {
        id: 'turn-2', speakerId: 'visitor-1', text: 'Hello again', modality: 'speech',
      },
    });
    await runtime.handleFinalInput({
      channelId: 'public',
      disclosure: roomDisclosure,
      input: {
        id: 'turn-3',
        speakerId: 'visitor-1',
        text: 'Oracle?',
        modality: 'speech',
        addressedAgentIds: ['oracle'],
      },
    });
    await runtime.setFocus('visitor-1', null);
    await runtime.setPhase('other');
    await runtime.handleFinalInput({
      channelId: 'public',
      disclosure: roomDisclosure,
      input: {
        id: 'turn-4', speakerId: 'visitor-1', text: 'Fallback?', modality: 'text',
      },
    });

    expect(calls).toEqual(['oracle', 'guide', 'oracle', 'guide']);
  });

  it('persists exact channel-separated turns and emits captions around provider speech', async () => {
    const spoken: RoomSpeechRequest[] = [];
    const captions: RoomCaptionEvent[] = [];
    const events: RoomAgentRuntimeEvent[] = [];
    let clock = 0;
    const store = new InMemoryRoomAgentRuntimeStore();
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: {
        id: 'oracle',
        label: 'Oracle',
        role: 'character',
        voice: { id: 'connie', language: 'en' },
      },
      driver: {
        respond: async ({ input }) => ({
          utterances: [{ text: `I heard: ${input.text}`, interruptible: true }],
        }),
      },
    }]);
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1',
      registry,
      store,
      contextSource: contextSource(),
      createId: idFactory(),
      fallbackAgentId: 'oracle',
      speech: {
        speak: async (request) => { spoken.push(request); },
      },
      captions: {
        publish: async (event) => { captions.push(event); },
      },
      observer: {
        emit: async (event) => { events.push(event); },
      },
      now: () => { clock += 10; return clock; },
    });

    await runtime.handleFinalInput({
      channelId: 'private:visitor-1:oracle',
      disclosure: privateDisclosure,
      input: {
        id: 'question-1',
        speakerId: 'visitor-1',
        text: 'What should I carry forward?',
        modality: 'speech',
      },
    });

    expect(spoken).toEqual([expect.objectContaining({
      agentId: 'oracle',
      channelId: 'private:visitor-1:oracle',
      text: 'I heard: What should I carry forward?',
      voice: { id: 'connie', language: 'en' },
    })]);
    expect(captions.map(({ status }) => status)).toEqual(['started', 'completed']);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'speech_completed',
      durationMs: 10,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      type: 'turn_completed',
      durationMs: 30,
    }));
    expect(events.every((event) => !('text' in event))).toBe(true);
    await expect(store.loadTranscript(
      'room-1', 'private:visitor-1:oracle',
    )).resolves.toMatchObject([
      {
        id: 'question-1',
        direction: 'input',
        endpoint: { kind: 'participant', id: 'visitor-1' },
        text: 'What should I carry forward?',
      },
      {
        direction: 'output',
        endpoint: { kind: 'agent', id: 'oracle' },
        text: 'I heard: What should I carry forward?',
      },
    ]);
    await expect(store.loadTranscript('room-1', 'public')).resolves.toEqual([]);
  });

  it('owns the interaction disclosure and clamps private replies across every presentation surface', async () => {
    const interactions: unknown[] = [];
    const spoken: RoomSpeechRequest[] = [];
    const captions: RoomCaptionEvent[] = [];
    const store = new InMemoryRoomAgentRuntimeStore();
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'guide', label: 'Guide', role: 'guide' },
      driver: {
        respond: async ({ interaction }) => {
          interactions.push(structuredClone(interaction));
          return {
            utterances: [{ text: 'Private answer.', audience: { kind: 'room' } }],
          };
        },
      },
    }]);
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1',
      registry,
      store,
      contextSource: async (request) => {
        expect(request.interaction.disclosure).toEqual(privateDisclosure);
        return {
          participants,
          observation: { phase: 'arrival' },
          manifest,
          legalActions: [],
          tick: 0,
        };
      },
      createId: idFactory(),
      fallbackAgentId: 'guide',
      speech: { speak: async (request) => { spoken.push(request); } },
      captions: { publish: async (event) => { captions.push(event); } },
    });

    const result = await runtime.handleFinalInput({
      channelId: 'private:visitor-1:guide',
      disclosure: privateDisclosure,
      input: {
        id: 'private-turn',
        speakerId: 'visitor-1',
        text: 'Tell only me.',
        modality: 'text',
      },
    });

    const expectedAudience = {
      kind: 'participants',
      participantIds: ['visitor-1'],
    };
    expect(interactions).toEqual([expect.objectContaining({
      roomId: 'room-1',
      channelId: 'private:visitor-1:guide',
      source: { kind: 'participant', id: 'visitor-1' },
      targets: [{ kind: 'agent', id: 'guide' }],
      disclosure: privateDisclosure,
    })]);
    expect(result.turn?.utterances).toEqual([{
      text: 'Private answer.',
      audience: expectedAudience,
    }]);
    expect(spoken).toEqual([expect.objectContaining({ audience: expectedAudience })]);
    expect(captions).toEqual([
      expect.objectContaining({ status: 'started', audience: expectedAudience }),
      expect.objectContaining({ status: 'completed', audience: expectedAudience }),
    ]);
    await expect(store.loadTranscript(
      'room-1', 'private:visitor-1:guide',
    )).resolves.toMatchObject([
      { direction: 'input', disclosure: privateDisclosure },
      { direction: 'output', disclosure: privateDisclosure },
    ]);
  });

  it('rejects missing disclosure and input-id reuse with a wider disclosure', async () => {
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'guide', label: 'Guide', role: 'guide' },
      driver: { respond: async () => ({ utterances: [{ text: 'Answer.' }] }) },
    }]);
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1',
      registry,
      store: new InMemoryRoomAgentRuntimeStore(),
      contextSource: contextSource(),
      createId: idFactory(),
      fallbackAgentId: 'guide',
    });
    const request = {
      channelId: 'private:visitor-1:guide',
      disclosure: privateDisclosure,
      input: {
        id: 'stable-input',
        speakerId: 'visitor-1',
        text: 'Keep this private.',
        modality: 'text' as const,
      },
    };

    await expect(runtime.handleFinalInput({
      channelId: 'private:visitor-1:guide',
      input: request.input,
    } as Parameters<typeof runtime.handleFinalInput>[0])).rejects.toThrow();
    await expect(runtime.handleFinalInput(request)).resolves.toMatchObject({ status: 'completed' });
    await expect(runtime.handleFinalInput({
      ...request,
      disclosure: roomDisclosure,
    })).rejects.toThrow('room transcript id was reused');
  });

  it('keeps provider work isolated by channel while speech remains room-global', async () => {
    const providerReleases = new Map<string, () => void>();
    const providerSignals = new Map<string, AbortSignal>();
    let releaseFirstSpeech!: () => void;
    const firstSpeech = new Promise<void>((resolve) => { releaseFirstSpeech = resolve; });
    const spoken: string[] = [];
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'guide', label: 'Guide', role: 'guide' },
      driver: {
        respond: async ({ input, signal }) => {
          providerSignals.set(input.text, signal!);
          await new Promise<void>((resolve) => { providerReleases.set(input.text, resolve); });
          return { utterances: [{ text: input.text }] };
        },
      },
    }]);
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1',
      registry,
      store: new InMemoryRoomAgentRuntimeStore(),
      contextSource: contextSource(),
      createId: idFactory(),
      fallbackAgentId: 'guide',
      speech: {
        speak: async ({ text }) => {
          spoken.push(text);
          if (spoken.length === 1) await firstSpeech;
        },
      },
    });
    const first = runtime.handleFinalInput({
      channelId: 'private:first',
      disclosure: privateDisclosure,
      input: { id: 'turn-first', speakerId: 'visitor-1', text: 'First', modality: 'text' },
    });
    await vi.waitFor(() => expect(providerReleases.has('First')).toBe(true));
    const second = runtime.handleFinalInput({
      channelId: 'private:second',
      disclosure: privateDisclosure,
      input: { id: 'turn-second', speakerId: 'visitor-1', text: 'Second', modality: 'text' },
    });
    await vi.waitFor(() => expect(providerReleases.has('Second')).toBe(true));

    expect(providerSignals.get('First')?.aborted).toBe(false);
    expect(providerSignals.get('Second')?.aborted).toBe(false);
    providerReleases.get('First')!();
    providerReleases.get('Second')!();
    await vi.waitFor(() => expect(spoken).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spoken).toHaveLength(1);
    releaseFirstSpeech();

    await expect(first).resolves.toMatchObject({ status: 'completed' });
    await expect(second).resolves.toMatchObject({ status: 'completed' });
    expect(spoken).toHaveLength(2);
  });

  it('interrupts stale work when a newer final input arrives', async () => {
    let finishFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    let firstSignal: AbortSignal | undefined;
    const speak = vi.fn(async (_request: RoomSpeechRequest, signal: AbortSignal) => {
      firstSignal = signal;
      await firstStarted;
    });
    const interrupt = vi.fn(async () => undefined);
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'guide', label: 'Guide', role: 'guide' },
      driver: {
        respond: async ({ input }) => ({ utterances: [{ text: input.text }] }),
      },
    }]);
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1',
      registry,
      store: new InMemoryRoomAgentRuntimeStore(),
      contextSource: contextSource(),
      createId: idFactory(),
      fallbackAgentId: 'guide',
      speech: { speak, interrupt },
    });

    const first = runtime.handleFinalInput({
      channelId: 'public',
      disclosure: roomDisclosure,
      input: {
        id: 'turn-1', speakerId: 'visitor-1', text: 'First', modality: 'speech',
      },
    });
    await vi.waitFor(() => expect(speak).toHaveBeenCalledOnce());
    const second = runtime.handleFinalInput({
      channelId: 'public',
      disclosure: roomDisclosure,
      input: {
        id: 'turn-2', speakerId: 'visitor-1', text: 'Second', modality: 'speech',
      },
    });
    await vi.waitFor(() => expect(firstSignal?.aborted).toBe(true));
    finishFirst();

    await expect(first).resolves.toMatchObject({ status: 'interrupted' });
    await expect(second).resolves.toMatchObject({ status: 'completed' });
    expect(interrupt).toHaveBeenCalledOnce();
    expect(speak).toHaveBeenCalledTimes(2);
  });

  it('does not cancel an in-flight turn when the transport retries the same input', async () => {
    let release!: () => void;
    const speaking = new Promise<void>((resolve) => { release = resolve; });
    const interrupt = vi.fn(async () => undefined);
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'guide', label: 'Guide', role: 'guide' },
      driver: { respond: async () => ({ utterances: [{ text: 'Only once.' }] }) },
    }]);
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1',
      registry,
      store: new InMemoryRoomAgentRuntimeStore(),
      contextSource: contextSource(),
      createId: idFactory(),
      fallbackAgentId: 'guide',
      speech: { speak: async () => await speaking, interrupt },
    });
    const request = {
      channelId: 'public',
      disclosure: roomDisclosure,
      input: {
        id: 'turn-1', speakerId: 'visitor-1', text: 'Retry me', modality: 'text' as const,
      },
    };

    const first = runtime.handleFinalInput(request);
    await vi.waitFor(() => expect(runtime.state().roomId).toBe('room-1'));
    await expect(runtime.handleFinalInput(request)).resolves.toMatchObject({ status: 'duplicate' });
    expect(interrupt).not.toHaveBeenCalled();
    release();
    await expect(first).resolves.toMatchObject({ status: 'completed' });
  });

  it('lets non-interruptible speech finish before the replacement turn speaks', async () => {
    let release!: () => void;
    const firstSpeaking = new Promise<void>((resolve) => { release = resolve; });
    const spoken: string[] = [];
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'guide', label: 'Guide', role: 'guide' },
      driver: {
        respond: async ({ input }) => ({
          utterances: [{ text: input.text, interruptible: input.text !== 'First' }],
        }),
      },
    }]);
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1',
      registry,
      store: new InMemoryRoomAgentRuntimeStore(),
      contextSource: contextSource(),
      createId: idFactory(),
      fallbackAgentId: 'guide',
      speech: {
        speak: async ({ text }, signal) => {
          spoken.push(text);
          if (text === 'First') {
            await firstSpeaking;
            expect(signal.aborted).toBe(false);
          }
        },
      },
    });

    const first = runtime.handleFinalInput({
      channelId: 'public',
      disclosure: roomDisclosure,
      input: { id: 'turn-1', speakerId: 'visitor-1', text: 'First', modality: 'speech' },
    });
    await vi.waitFor(() => expect(spoken).toEqual(['First']));
    const second = runtime.handleFinalInput({
      channelId: 'public',
      disclosure: roomDisclosure,
      input: { id: 'turn-2', speakerId: 'visitor-1', text: 'Second', modality: 'speech' },
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(spoken).toEqual(['First']);
    release();

    await expect(first).resolves.toMatchObject({ status: 'interrupted' });
    await expect(second).resolves.toMatchObject({ status: 'completed' });
    expect(spoken).toEqual(['First', 'Second']);
  });

  it('restores focus, phase, registrations, and channel transcript for reconnect', async () => {
    const store = new InMemoryRoomAgentRuntimeStore();
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'guide', label: 'Guide', role: 'guide' },
      driver: { respond: async () => ({ utterances: [{ text: 'Welcome back.' }] }) },
    }]);
    const options = {
      roomId: 'room-1',
      registry,
      store,
      contextSource: contextSource(),
      createId: idFactory(),
      fallbackAgentId: 'guide',
    };
    const first = new RoomAgentRuntime(options);
    await first.setPhase('reflection');
    await first.setFocus('visitor-1', 'guide');
    await first.handleFinalInput({
      channelId: 'private:visitor-1:guide',
      disclosure: privateDisclosure,
      input: {
        id: 'turn-1', speakerId: 'visitor-1', text: 'Resume me', modality: 'text',
      },
    });

    const restored = new RoomAgentRuntime(options);
    await expect(restored.resume('private:visitor-1:guide')).resolves.toMatchObject({
      state: {
        schema: 'gaos.room-agent-runtime.v1',
        roomId: 'room-1',
        phase: 'reflection',
        focusByParticipant: { 'visitor-1': 'guide' },
        registrations: [{ id: 'guide' }],
      },
      transcript: [
        { id: 'turn-1', text: 'Resume me' },
        { text: 'Welcome back.' },
      ],
    });
  });

  it('exposes only the product-selected progress rungs while long work is silent', async () => {
    vi.useFakeTimers();
    try {
      let resolveWork!: (value: string) => void;
      const work = new Promise<string>((resolve) => { resolveWork = resolve; });
      const iterator = waitWithRoomAgentProgress(work, {
        delaysMs: [6_000, 3_000, 6_000],
        now: Date.now,
      })[Symbol.asyncIterator]();

      let firstSettled = false;
      const first = iterator.next().then((entry) => {
        firstSettled = true;
        return entry;
      });
      await vi.advanceTimersByTimeAsync(5_999);
      expect(firstSettled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(first).resolves.toEqual({
        done: false,
        value: { type: 'progress', rung: 1, elapsedMs: 6_000 },
      });

      const second = iterator.next();
      await vi.advanceTimersByTimeAsync(3_000);
      await expect(second).resolves.toEqual({
        done: false,
        value: { type: 'progress', rung: 2, elapsedMs: 9_000 },
      });

      const result = iterator.next();
      resolveWork('understood');
      await expect(result).resolves.toEqual({
        done: false,
        value: { type: 'result', value: 'understood' },
      });
      await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a progress ladder silently when the run is aborted', async () => {
    const controller = new AbortController();
    const work = new Promise<string>(() => {});
    const iterator = waitWithRoomAgentProgress(work, {
      delaysMs: [],
      signal: controller.signal,
    })[Symbol.asyncIterator]();
    const pending = iterator.next();
    controller.abort('interrupted');
    await expect(pending).resolves.toEqual({ done: true, value: undefined });
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });

  it('streams durable progress and multiple outputs before completion without recording filler', async () => {
    let release!: () => void;
    const work = new Promise<void>((resolve) => { release = resolve; });
    const globallyObserved: RoomAgentRunJournalEntry[] = [];
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
      driver: {
        run: async function* () {
          yield { type: 'progress', progress: { stage: 'research', current: 1, total: 2 } };
          yield {
            type: 'assistant_output',
            outputId: 'answer-1',
            delta: 'The first ',
            purpose: 'answer',
          };
          await work;
          yield {
            type: 'assistant_output',
            outputId: 'answer-1',
            delta: 'answer.',
            final: true,
            purpose: 'answer',
          };
          yield {
            type: 'assistant_output',
            outputId: 'question-1',
            delta: 'What do you notice?',
            final: true,
            purpose: 'question',
          };
          yield { type: 'completed' };
        },
      },
    }]);
    const store = new JsonStrictRunStore();
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1',
      registry,
      store,
      runStore: store,
      contextSource: contextSource(),
      createId: idFactory(),
      fallbackAgentId: 'oracle',
      runObserver: { publish: async (entry) => { globallyObserved.push(entry); } },
      progressPresenter: {
        present: async ({ progress }) => ({
          utterance: { text: `Working on ${progress.stage}.` },
        }),
      },
    });

    const execution = runtime.startRun({
      channelId: 'private:visitor-1:oracle',
      disclosure: privateDisclosure,
      input: {
        id: 'input-1', speakerId: 'visitor-1', text: 'Guide me', modality: 'text',
      },
    });
    const iterator = execution.events[Symbol.asyncIterator]();
    const progress = await iterator.next();
    const filler = await iterator.next();
    const firstDelta = await iterator.next();

    expect(progress.value?.event).toEqual({
      type: 'progress', progress: { stage: 'research', current: 1, total: 2 },
    });
    expect(filler.value?.event).toMatchObject({
      type: 'assistant_output', purpose: 'progress', history: 'ephemeral', final: true,
    });
    expect(firstDelta.value?.event).toMatchObject({
      type: 'assistant_output',
      outputId: 'gaos-output-attempt:1:driver:answer-1',
      delta: 'The first ',
      delivery: { origin: 'driver', attempt: 1, logicalOutputId: 'answer-1' },
    });
    let settled = false;
    void execution.result.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();

    const result = await execution.result;
    expect(result).toMatchObject({
      status: 'completed',
      turn: { utterances: [{ text: 'The first answer.' }, { text: 'What do you notice?' }] },
    });
    const transcript = await store.loadTranscript('room-1', 'private:visitor-1:oracle');
    expect(transcript.map(({ text }) => text)).toEqual([
      'Guide me',
      'The first answer.',
      'What do you notice?',
    ]);
    expect(globallyObserved.map(({ sequence }) => sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('continues one waiting run across inputs with its checkpoint and token', async () => {
    const invocations: Array<RoomAgentRunContext<Observation>['run']> = [];
    let wallClock = 1_000;
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
      driver: {
        run: async function* (context) {
          invocations.push(structuredClone(context.run));
          if (context.run.attempt === 1) {
            yield { type: 'checkpoint', value: { path: ['gate'] } };
            yield {
              type: 'assistant_output',
              outputId: 'message',
              delta: 'What is beyond the gate?',
              final: true,
              purpose: 'question',
            };
            yield {
              type: 'input_requested',
              requestId: 'gate-detail',
              continuationToken: 'continue-1',
            };
            return;
          }
          yield {
            type: 'assistant_output',
            outputId: 'message',
            delta: `You found ${context.input.text}.`,
            final: true,
          };
          yield { type: 'completed' };
        },
      },
    }]);
    const store = new JsonStrictRunStore();
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1', registry, store, runStore: store,
      contextSource: contextSource(), createId: idFactory(), fallbackAgentId: 'oracle',
      wallNow: () => wallClock,
    });

    const first = await runtime.handleRunInput({
      channelId: 'private',
      disclosure: privateDisclosure,
      deadlineMs: 100,
      input: { id: 'input-1', speakerId: 'visitor-1', text: 'A gate', modality: 'text' },
    });
    expect(first).toMatchObject({
      status: 'waiting_for_input',
      run: {
        attempt: 1,
        deadlineMs: 100,
        checkpoint: { path: ['gate'] },
        continuation: { requestId: 'gate-detail', token: 'continue-1' },
      },
    });
    expect('deadlineAt' in first.run).toBe(false);

    // Human waiting time does not consume the next active attempt's budget.
    wallClock = 50_000;
    const second = await runtime.handleRunInput({
      channelId: 'private',
      disclosure: privateDisclosure,
      continuation: { runId: first.run.id, token: 'continue-1' },
      input: { id: 'input-2', speakerId: 'visitor-1', text: 'a garden', modality: 'speech' },
    });
    expect(second).toMatchObject({
      status: 'completed',
      run: { id: first.run.id, attempt: 2, deadlineMs: 100, deadlineAt: 50_100 },
    });
    expect('continuation' in second.run).toBe(false);
    expect(invocations).toEqual([
      expect.objectContaining({ id: first.run.id, attempt: 1, resumed: false }),
      expect.objectContaining({
        id: first.run.id,
        attempt: 2,
        resumed: false,
        checkpoint: { path: ['gate'] },
        continuation: { requestId: 'gate-detail', token: 'continue-1' },
      }),
    ]);
    const replay = await runtime.replayRun(first.run.id);
    expect(replay.events.map(({ sequence }) => sequence)).toEqual(
      replay.events.map((_, index) => index + 1),
    );
    expect(replay.events.map(({ event }) => event.type)).toEqual([
      'checkpoint',
      'assistant_output',
      'input_requested',
      'assistant_output',
      'completed',
    ]);
    const outputIds = replay.events.flatMap(({ event }) => (
      event.type === 'assistant_output' ? [event.outputId] : []
    ));
    expect(outputIds).toHaveLength(2);
    expect(outputIds[0]).not.toBe(outputIds[1]);
    expect(replay.events.flatMap(({ event }) => (
      event.type === 'assistant_output' ? [event.delivery] : []
    ))).toEqual([
      { origin: 'driver', attempt: 1, logicalOutputId: 'message' },
      { origin: 'driver', attempt: 2, logicalOutputId: 'message' },
    ]);
    const transcript = await store.loadTranscript('room-1', 'private');
    expect(transcript.filter(({ direction }) => direction === 'output').map(({ text }) => text))
      .toEqual(['What is beyond the gate?', 'You found a garden.']);
  });

  it('binds continuation to its speaker and cannot widen its disclosure', async () => {
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
      driver: {
        run: async function* (context) {
          if (context.run.attempt === 1) {
            yield { type: 'checkpoint', value: { secret: 'visitor-1 secret' } };
            yield {
              type: 'input_requested',
              requestId: 'secret-detail',
              continuationToken: 'continue-secret',
            };
            return;
          }
          const checkpoint = context.run.checkpoint as { secret: string };
          yield {
            type: 'assistant_output',
            outputId: 'secret-answer',
            delta: checkpoint.secret,
            final: true,
          };
          yield { type: 'completed' };
        },
      },
    }]);
    const store = new InMemoryRoomAgentRuntimeStore();
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1', registry, store, runStore: store,
      contextSource: async () => ({
        participants: [
          { id: 'visitor-1', role: 'spectator' as const },
          { id: 'visitor-2', role: 'spectator' as const },
        ],
        observation: { phase: 'arrival' },
        manifest,
        legalActions: [],
        tick: 0,
      }),
      createId: idFactory(),
      fallbackAgentId: 'oracle',
    });

    const first = await runtime.handleRunInput({
      channelId: 'shared',
      disclosure: privateDisclosure,
      input: { id: 'input-1', speakerId: 'visitor-1', text: 'Keep this private', modality: 'text' },
    });
    expect(first.status).toBe('waiting_for_input');

    await expect(runtime.handleRunInput({
      channelId: 'shared',
      disclosure: roomDisclosure,
      continuation: { runId: first.run.id, token: 'continue-secret' },
      input: { id: 'input-2', speakerId: 'visitor-2', text: 'Tell everyone', modality: 'text' },
    })).rejects.toThrow('continuation speaker does not match');
    await expect(store.loadRun('room-1', first.run.id)).resolves.toMatchObject({
      status: 'waiting_for_input',
      attempt: 1,
    });

    const continued = await runtime.handleRunInput({
      channelId: 'shared',
      disclosure: roomDisclosure,
      continuation: { runId: first.run.id, token: 'continue-secret' },
      input: { id: 'input-3', speakerId: 'visitor-1', text: 'Continue', modality: 'text' },
    });
    expect(continued).toMatchObject({
      status: 'completed',
      run: { disclosure: privateDisclosure },
    });
    const transcript = await store.loadTranscript('room-1', 'shared');
    expect(transcript.filter(({ direction }) => direction === 'output')).toEqual([
      expect.objectContaining({
        text: 'visitor-1 secret',
        disclosure: privateDisclosure,
      }),
    ]);
  });

  it('adapts legacy respond drivers to durable runs', async () => {
    const store = new InMemoryRoomAgentRuntimeStore();
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'guide', label: 'Guide', role: 'guide' },
      driver: { respond: async () => ({ utterances: [{ text: 'Legacy answer.' }] }) },
    }]);
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1', registry, store, runStore: store,
      contextSource: contextSource(), createId: idFactory(), fallbackAgentId: 'guide',
    });
    const result = await runtime.handleRunInput({
      channelId: 'public',
      disclosure: roomDisclosure,
      input: { id: 'input-1', speakerId: 'visitor-1', text: 'Hello', modality: 'text' },
    });
    expect(result).toMatchObject({
      status: 'completed',
      turn: { utterances: [{ text: 'Legacy answer.' }] },
    });
    await expect(runtime.replayRun(result.run.id)).resolves.toMatchObject({
      events: [
        { event: { type: 'decision' } },
        { event: { type: 'assistant_output', history: 'record' } },
        { event: { type: 'completed' } },
      ],
    });
  });

  it('persists implicit completion and failure as recursively plain JSON records', async () => {
    const store = new JsonStrictRunStore();
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
      driver: {
        run: async function* ({ input }) {
          if (input.id === 'failure') throw new Error('provider failed');
          yield {
            type: 'assistant_output',
            outputId: 'answer',
            delta: 'Finished without an explicit completion event.',
            final: true,
          } as const;
        },
      },
    }]);
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1', registry, store, runStore: store,
      contextSource: contextSource(), createId: idFactory(), fallbackAgentId: 'oracle',
    });

    await expect(runtime.handleRunInput({
      channelId: 'implicit',
      disclosure: roomDisclosure,
      input: { id: 'implicit', speakerId: 'visitor-1', text: 'Finish', modality: 'text' },
    })).resolves.toMatchObject({ status: 'completed' });
    await expect(runtime.handleRunInput({
      channelId: 'failure',
      disclosure: roomDisclosure,
      input: { id: 'failure', speakerId: 'visitor-1', text: 'Fail', modality: 'text' },
    })).rejects.toThrow('provider failed');
    await expect(store.loadRunByInput('room-1', 'failure', 'failure')).resolves.toMatchObject({
      status: 'failed',
      failureCode: 'run_processing_failed',
    });
    expect(store.persistedRuns.some(({ operation }) => operation === 'commitRunEvent')).toBe(true);
  });

  it('records cooperative cancellation and deadline expiry as replayable terminal states', async () => {
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
      driver: {
        run: async function* ({ signal }) {
          yield { type: 'progress', progress: { stage: 'waiting' } };
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        },
      },
    }]);
    const store = new JsonStrictRunStore();
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1', registry, store, runStore: store,
      contextSource: contextSource(), createId: idFactory(), fallbackAgentId: 'oracle',
    });
    const execution = runtime.startRun({
      channelId: 'cancel',
      disclosure: roomDisclosure,
      input: { id: 'cancel-1', speakerId: 'visitor-1', text: 'Stop', modality: 'text' },
    });
    const iterator = execution.events[Symbol.asyncIterator]();
    const started = await iterator.next();
    const runId = started.value?.runId;
    expect(runId).toBeTypeOf('string');
    await expect(runtime.cancelRun(runId!, 'user_stopped')).resolves.toBe(true);
    await expect(execution.result).resolves.toMatchObject({ status: 'canceled' });
    await expect(runtime.replayRun(runId!)).resolves.toMatchObject({
      run: { status: 'canceled' },
      events: [
        { event: { type: 'progress' } },
        { event: { type: 'run_canceled', reason: 'user_stopped' } },
      ],
    });

    const deadline = await runtime.handleRunInput({
      channelId: 'deadline',
      disclosure: roomDisclosure,
      deadlineMs: 5,
      input: { id: 'deadline-1', speakerId: 'visitor-1', text: 'Wait', modality: 'text' },
    });
    expect(deadline.status).toBe('deadline_exceeded');
    const deadlineReplay = await runtime.replayRun(deadline.run.id);
    expect(deadlineReplay.run).toMatchObject({ status: 'deadline_exceeded' });
    expect(deadlineReplay.events.at(-1)?.event).toEqual({ type: 'deadline_exceeded' });
  });

  it('restores a durable checkpoint into an explicitly resumed active run', async () => {
    const seen: RoomAgentRunContext<Observation>['run'][] = [];
    const store = new JsonStrictRunStore();
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
      driver: {
        run: async function* (context) {
          seen.push(structuredClone(context.run));
          yield { type: 'completed' };
        },
      },
    }]);
    const active: RoomAgentRunRecord = {
      schema: 'gaos.room-agent-run.v1',
      id: 'run-recovery',
      roomId: 'room-1',
      channelId: 'private',
      agentId: 'oracle',
      rootInputId: 'input-1',
      latestInput: {
        id: 'input-1', speakerId: 'visitor-1', text: 'Recover', modality: 'text',
      },
      disclosure: privateDisclosure,
      attempt: 1,
      status: 'active',
      startedAt: 1,
      updatedAt: 1,
      lastSequence: 0,
      checkpoint: { completed: ['observe'] },
    };
    await store.createRun(active);
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1', registry, store, runStore: store,
      contextSource: contextSource(), createId: idFactory(), fallbackAgentId: 'oracle',
    });

    await expect(runtime.resumeRun(active.id)).resolves.toMatchObject({
      status: 'completed', run: { attempt: 2 },
    });
    expect(seen).toEqual([expect.objectContaining({
      id: active.id,
      attempt: 2,
      resumed: true,
      checkpoint: { completed: ['observe'] },
    })]);
  });

  it('publishes checkpoint and waiting events only after their run transition commits', async () => {
    const store = new InMemoryRoomAgentRuntimeStore();
    const observed: Array<{ entry: RoomAgentRunJournalEntry; run?: RoomAgentRunRecord }> = [];
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
      driver: {
        run: async function* () {
          yield { type: 'checkpoint', value: { completed: ['observe'] } };
          yield {
            type: 'input_requested',
            requestId: 'describe',
            continuationToken: 'continue-1',
          };
        },
      },
    }]);
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1', registry, store, runStore: store,
      contextSource: contextSource(), createId: idFactory(), fallbackAgentId: 'oracle',
      runObserver: {
        publish: async (entry) => {
          observed.push({ entry, run: await store.loadRun(entry.roomId, entry.runId) });
        },
      },
    });

    const result = await runtime.handleRunInput({
      channelId: 'atomic',
      disclosure: roomDisclosure,
      input: { id: 'input-1', speakerId: 'visitor-1', text: 'Begin', modality: 'text' },
    });
    expect(result.status).toBe('waiting_for_input');
    expect(observed).toEqual([
      {
        entry: expect.objectContaining({
          sequence: 1,
          event: expect.objectContaining({ type: 'checkpoint' }),
        }),
        run: expect.objectContaining({
          lastSequence: 1,
          checkpoint: { completed: ['observe'] },
        }),
      },
      {
        entry: expect.objectContaining({
          sequence: 2,
          event: expect.objectContaining({ type: 'input_requested' }),
        }),
        run: expect.objectContaining({
          lastSequence: 2,
          status: 'waiting_for_input',
          continuation: { requestId: 'describe', token: 'continue-1' },
        }),
      },
    ]);
  });

  it('cancels only the controller belonging to the requested run', async () => {
    let releaseSecond!: () => void;
    const secondWork = new Promise<void>((resolve) => { releaseSecond = resolve; });
    let secondSignal: AbortSignal | undefined;
    const store = new InMemoryRoomAgentRuntimeStore();
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
      driver: {
        run: async function* ({ input, signal }) {
          if (input.text === 'First') {
            yield {
              type: 'input_requested',
              requestId: 'first-wait',
              continuationToken: 'first-token',
            };
            return;
          }
          secondSignal = signal;
          yield { type: 'progress', progress: { stage: 'second-active' } };
          await secondWork;
          if (!signal?.aborted) yield { type: 'completed' };
        },
      },
    }]);
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1', registry, store, runStore: store,
      contextSource: contextSource(), createId: idFactory(), fallbackAgentId: 'oracle',
    });
    const first = await runtime.handleRunInput({
      channelId: 'first-channel',
      disclosure: roomDisclosure,
      input: { id: 'input-1', speakerId: 'visitor-1', text: 'First', modality: 'text' },
    });
    const second = runtime.startRun({
      channelId: 'second-channel',
      disclosure: roomDisclosure,
      input: { id: 'input-2', speakerId: 'visitor-1', text: 'Second', modality: 'text' },
    });
    await second.events[Symbol.asyncIterator]().next();

    await expect(runtime.cancelRun(first.run.id, 'cancel_waiting')).resolves.toBe(true);
    expect(secondSignal?.aborted).toBe(false);
    releaseSecond();
    await expect(second.result).resolves.toMatchObject({ status: 'completed' });
  });

  it('runs durable work concurrently across channels and cancels only its owning channel', async () => {
    const releases = new Map<string, () => void>();
    const signals = new Map<string, AbortSignal>();
    const store = new InMemoryRoomAgentRuntimeStore();
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
      driver: {
        run: async function* ({ input, signal }) {
          signals.set(input.text, signal!);
          yield { type: 'progress', progress: { stage: input.text } };
          await new Promise<void>((resolve) => { releases.set(input.text, resolve); });
          if (!signal?.aborted) yield { type: 'completed' };
        },
      },
    }]);
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1', registry, store, runStore: store,
      contextSource: contextSource(), createId: idFactory(), fallbackAgentId: 'oracle',
    });
    const first = runtime.startRun({
      channelId: 'private:first',
      disclosure: privateDisclosure,
      input: { id: 'run-input-first', speakerId: 'visitor-1', text: 'First', modality: 'text' },
    });
    const firstProgress = await first.events[Symbol.asyncIterator]().next();
    const second = runtime.startRun({
      channelId: 'private:second',
      disclosure: privateDisclosure,
      input: { id: 'run-input-second', speakerId: 'visitor-1', text: 'Second', modality: 'text' },
    });
    const secondProgress = await second.events[Symbol.asyncIterator]().next();

    expect(firstProgress.value?.event).toMatchObject({ type: 'progress' });
    expect(secondProgress.value?.event).toMatchObject({ type: 'progress' });
    expect(signals.get('First')?.aborted).toBe(false);
    expect(signals.get('Second')?.aborted).toBe(false);

    const firstRun = await store.loadRunByInput('room-1', 'private:first', 'run-input-first');
    await expect(runtime.cancelRun(firstRun!.id, 'cancel_first')).resolves.toBe(true);
    expect(signals.get('First')?.aborted).toBe(true);
    expect(signals.get('Second')?.aborted).toBe(false);
    releases.get('First')!();
    releases.get('Second')!();

    await expect(first.result).resolves.toMatchObject({ status: 'canceled' });
    await expect(second.result).resolves.toMatchObject({ status: 'completed' });
  });

  it.each(['context source', 'progress presenter'] as const)(
    'persists deadline terminal state when an abort-aware %s rejects',
    async (failurePoint) => {
      const store = new InMemoryRoomAgentRuntimeStore();
      const registry = new RoomAgentRegistry<Observation>([{
        descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
        driver: {
          run: async function* () {
            yield { type: 'progress', progress: { stage: 'slow-work' } };
            yield { type: 'completed' };
          },
        },
      }]);
      const source: RoomAgentRuntimeContextSource<Observation> = async (request) => {
        if (failurePoint === 'context source') {
          await new Promise<void>((_resolve, reject) => {
            request.signal.addEventListener(
              'abort',
              () => reject(new Error('context aborted')),
              { once: true },
            );
          });
        }
        return {
          participants,
          observation: { phase: 'arrival' },
          manifest,
          legalActions: [],
          tick: 0,
        };
      };
      const runtime = new RoomAgentRuntime({
        roomId: 'room-1', registry, store, runStore: store,
        contextSource: source, createId: idFactory(), fallbackAgentId: 'oracle',
        ...(failurePoint === 'progress presenter'
          ? {
            progressPresenter: {
              present: async ({ signal }: { signal: AbortSignal }) => await new Promise(
                (_resolve, reject) => signal.addEventListener(
                  'abort',
                  () => reject(new Error('presenter aborted')),
                  { once: true },
                ),
              ),
            },
          }
          : {}),
      });

      const result = await runtime.handleRunInput({
        channelId: failurePoint,
        disclosure: roomDisclosure,
        deadlineMs: 5,
        input: { id: `input-${failurePoint}`, speakerId: 'visitor-1', text: 'Wait', modality: 'text' },
      });
      expect(result.status).toBe('deadline_exceeded');
      const replay = await runtime.replayRun(result.run.id);
      expect(replay.run).toMatchObject({
        status: 'deadline_exceeded',
        lastSequence: replay.events.length,
      });
      expect(replay.events.at(-1)?.event).toEqual({ type: 'deadline_exceeded' });
    },
  );

  it('reconciles a committed final output missing from transcript without re-speaking it', async () => {
    const store = new InMemoryRoomAgentRuntimeStore();
    const active: RoomAgentRunRecord = {
      schema: 'gaos.room-agent-run.v1',
      id: 'run-reconcile',
      roomId: 'room-1',
      channelId: 'private',
      agentId: 'oracle',
      rootInputId: 'input-1',
      latestInput: {
        id: 'input-1', speakerId: 'visitor-1', text: 'Recover', modality: 'text',
      },
      disclosure: privateDisclosure,
      attempt: 1,
      status: 'active',
      startedAt: 1,
      updatedAt: 1,
      lastSequence: 0,
    };
    await store.createRun(active);
    await store.commitRunEvent(active, {
      id: 'event-1',
      runId: active.id,
      roomId: active.roomId,
      channelId: active.channelId,
      agentId: active.agentId,
      inputId: active.latestInput.id,
      recordedAt: 2,
      event: {
        type: 'assistant_output',
        outputId: 'answer-1',
        delta: 'Recovered answer.',
        final: true,
        purpose: 'answer',
        history: 'record',
      },
    });
    const speak = vi.fn(async () => undefined);
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
      driver: { run: async function* () { yield { type: 'completed' }; } },
    }]);
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1', registry, store, runStore: store,
      contextSource: contextSource(), createId: idFactory(), fallbackAgentId: 'oracle',
      speech: { speak },
    });

    await expect(runtime.resumeRun(active.id)).resolves.toMatchObject({ status: 'completed' });
    await expect(store.loadTranscript(active.roomId, active.channelId)).resolves.toMatchObject([
      { id: `${active.id}:output:answer-1`, text: 'Recovered answer.', turnId: 'input-1' },
    ]);
    expect(speak).not.toHaveBeenCalled();
  });

  it('suppresses a closed logical output when a recovery attempt re-yields it', async () => {
    const store = new InMemoryRoomAgentRuntimeStore();
    const active = activeRecoveryRun('run-closed-output', 'closed-output');
    await seedRecoveryOutput(store, active, {
      type: 'assistant_output',
      outputId: 'gaos-output-attempt:1:driver:stable-answer',
      delta: 'Already committed.',
      final: true,
      purpose: 'answer',
      history: 'record',
      delivery: { origin: 'driver', attempt: 1, logicalOutputId: 'stable-answer' },
    });
    await store.appendTranscript({
      id: `${active.id}:output:gaos-output-attempt:1:driver:stable-answer`,
      roomId: active.roomId,
      channelId: active.channelId,
      turnId: active.latestInput.id,
      direction: 'output',
      endpoint: { kind: 'agent', id: active.agentId },
      disclosure: active.disclosure,
      text: 'Already committed.',
      modality: 'generated',
    });
    const speak = vi.fn(async () => undefined);
    const observed: RoomAgentRunJournalEntry[] = [];
    const invocations: RoomAgentRunContext<Observation>['run'][] = [];
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
      driver: {
        run: async function* (context) {
          invocations.push(structuredClone(context.run));
          yield {
            type: 'assistant_output',
            outputId: 'stable-answer',
            delta: 'Already committed.',
            final: true,
            purpose: 'answer',
            history: 'record',
          };
          yield {
            type: 'assistant_output',
            outputId: 'fresh-follow-up',
            delta: 'A fresh follow-up.',
            final: true,
            purpose: 'question',
            history: 'record',
          };
          yield { type: 'completed' };
        },
      },
    }]);
    const runtime = new RoomAgentRuntime({
      roomId: active.roomId, registry, store, runStore: store,
      contextSource: contextSource(), createId: idFactory(), fallbackAgentId: 'oracle',
      speech: { speak },
      runObserver: { publish: async (entry) => { observed.push(entry); } },
    });

    await expect(store.loadRun(active.roomId, active.id)).resolves.toMatchObject({
      status: 'active', attempt: 1,
    });
    const result = await runtime.resumeRun(active.id);
    expect(result).toMatchObject({ status: 'completed', run: { attempt: 2 } });
    expect(result.turn?.utterances).toEqual([
      expect.objectContaining({ text: 'A fresh follow-up.' }),
    ]);
    expect(invocations).toEqual([expect.objectContaining({ attempt: 2, resumed: true })]);
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'A fresh follow-up.' }),
      expect.any(AbortSignal),
    );
    expect(observed.map(({ event }) => event.type)).toEqual([
      'assistant_output',
      'completed',
    ]);
    const transcript = await store.loadTranscript(active.roomId, active.channelId);
    expect(transcript.filter(({ direction }) => direction === 'output').map(({ text }) => text))
      .toEqual(['Already committed.', 'A fresh follow-up.']);
    const replay = await runtime.replayRun(active.id);
    const outputs = replay.events.flatMap(({ event }) => (
      event.type === 'assistant_output' ? [event] : []
    ));
    expect(outputs.map(({ delta }) => delta)).toEqual([
      'Already committed.',
      'A fresh follow-up.',
    ]);
    expect(outputs.map(({ delivery }) => delivery)).toEqual([
      { origin: 'driver', attempt: 1, logicalOutputId: 'stable-answer' },
      { origin: 'driver', attempt: 2, logicalOutputId: 'fresh-follow-up' },
    ]);
  });

  it.each([
    {
      label: 'driver-shaped',
      legacyOutputIds: ['gaos-output-attempt:1:driver:stable-answer'],
      resumedLogicalId: 'stable-answer',
      expectedOutputId: 'gaos-output-attempt:2:driver:stable-answer',
    },
    {
      label: 'runtime-shaped',
      legacyOutputIds: ['gaos-output-attempt:1:runtime:stable-answer'],
      resumedLogicalId: 'gaos-output-attempt:1:runtime:stable-answer',
      expectedOutputId:
        'gaos-output-attempt:2:driver:gaos-output-attempt:1:runtime:stable-answer',
    },
    {
      label: 'exact next-attempt collision',
      legacyOutputIds: ['gaos-output-attempt:2:driver:stable-answer'],
      resumedLogicalId: 'stable-answer',
      expectedOutputId:
        'gaos-output-collision:1:gaos-output-attempt:2:driver:stable-answer',
    },
    {
      label: 'chained next-attempt collisions',
      legacyOutputIds: [
        'gaos-output-attempt:2:driver:stable-answer',
        'gaos-output-collision:1:gaos-output-attempt:2:driver:stable-answer',
      ],
      resumedLogicalId: 'stable-answer',
      expectedOutputId:
        'gaos-output-collision:2:gaos-output-attempt:2:driver:stable-answer',
    },
  ])('does not suppress a $label legacy output ID without delivery metadata', async ({
    label,
    legacyOutputIds,
    resumedLogicalId,
    expectedOutputId,
  }) => {
    const store = new InMemoryRoomAgentRuntimeStore();
    const active = activeRecoveryRun(`run-legacy-${label}`, `legacy-${label}`);
    await seedRecoveryOutput(store, active, {
      type: 'assistant_output',
      outputId: legacyOutputIds[0]!,
      delta: 'Legacy committed output 1.',
      final: true,
      purpose: 'answer',
      history: 'record',
    });
    let stored = await store.loadRun(active.roomId, active.id);
    if (stored === undefined) throw new Error('seeded recovery run is missing');
    for (const [index, outputId] of legacyOutputIds.slice(1).entries()) {
      const appended = await store.commitRunEvent(stored, {
        id: `${active.id}:legacy-output:${index + 2}`,
        runId: active.id,
        roomId: active.roomId,
        channelId: active.channelId,
        agentId: active.agentId,
        inputId: active.latestInput.id,
        recordedAt: index + 3,
        event: {
          type: 'assistant_output',
          outputId,
          delta: `Legacy committed output ${index + 2}.`,
          final: true,
          purpose: 'answer',
          history: 'record',
        },
      });
      stored = appended.run;
    }
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
      driver: {
        run: async function* () {
          yield {
            type: 'assistant_output',
            outputId: resumedLogicalId,
            delta: 'Regenerated output.',
            final: true,
            purpose: 'answer',
            history: 'record',
          };
          yield { type: 'completed' };
        },
      },
    }]);
    const runtime = new RoomAgentRuntime({
      roomId: active.roomId, registry, store, runStore: store,
      contextSource: contextSource(), createId: idFactory(), fallbackAgentId: 'oracle',
    });

    await expect(runtime.resumeRun(active.id)).resolves.toMatchObject({
      status: 'completed',
      turn: { utterances: [{ text: 'Regenerated output.' }] },
    });
    const transcript = await store.loadTranscript(active.roomId, active.channelId);
    expect(transcript.filter(({ direction }) => direction === 'output').map(({ text }) => text))
      .toEqual([
        ...legacyOutputIds.map((_, index) => `Legacy committed output ${index + 1}.`),
        'Regenerated output.',
      ]);
    const replay = await runtime.replayRun(active.id);
    const outputs = replay.events.flatMap(({ event }) => (
      event.type === 'assistant_output' ? [event] : []
    ));
    expect(outputs).toHaveLength(legacyOutputIds.length + 1);
    expect(new Set(outputs.map(({ outputId }) => outputId)).size).toBe(outputs.length);
    expect(outputs.at(-1)?.outputId).toBe(expectedOutputId);
    expect(outputs.map(({ delivery }) => delivery)).toEqual([
      ...legacyOutputIds.map(() => undefined),
      { origin: 'driver', attempt: 2, logicalOutputId: resumedLogicalId },
    ]);
  });

  it('abandons an incomplete prior output before a recovery attempt streams it again', async () => {
    const store = new InMemoryRoomAgentRuntimeStore();
    const active = activeRecoveryRun('run-partial-output', 'partial-output');
    await seedRecoveryOutput(store, active, {
      type: 'assistant_output',
      outputId: 'gaos-output-attempt:1:driver:stable-answer',
      delta: 'Abandoned prefix. ',
      purpose: 'answer',
      history: 'record',
      delivery: { origin: 'driver', attempt: 1, logicalOutputId: 'stable-answer' },
    });
    const speak = vi.fn(async () => undefined);
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
      driver: {
        run: async function* () {
          yield {
            type: 'assistant_output',
            outputId: 'stable-answer',
            delta: 'Recovered whole answer.',
            final: true,
            purpose: 'answer',
            history: 'record',
          };
          yield { type: 'completed' };
        },
      },
    }]);
    const runtime = new RoomAgentRuntime({
      roomId: active.roomId, registry, store, runStore: store,
      contextSource: contextSource(), createId: idFactory(), fallbackAgentId: 'oracle',
      speech: { speak },
    });

    await expect(runtime.resumeRun(active.id)).resolves.toMatchObject({
      status: 'completed',
      turn: { utterances: [{ text: 'Recovered whole answer.' }] },
    });
    expect(speak).toHaveBeenCalledTimes(1);
    expect(speak).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Recovered whole answer.' }),
      expect.any(AbortSignal),
    );
    const transcript = await store.loadTranscript(active.roomId, active.channelId);
    expect(transcript.filter(({ direction }) => direction === 'output')).toEqual([
      expect.objectContaining({ text: 'Recovered whole answer.' }),
    ]);
    const replay = await runtime.replayRun(active.id);
    const outputs = replay.events.flatMap(({ event }) => (
      event.type === 'assistant_output' ? [event] : []
    ));
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).toMatchObject({ delta: 'Abandoned prefix. ' });
    expect(outputs[0]).not.toHaveProperty('final');
    expect(outputs[0]?.outputId).not.toBe(outputs[1]?.outputId);
    expect(outputs.map(({ delivery }) => delivery)).toEqual([
      { origin: 'driver', attempt: 1, logicalOutputId: 'stable-answer' },
      { origin: 'driver', attempt: 2, logicalOutputId: 'stable-answer' },
    ]);
  });

  it('recovers an atomically admitted input after caller loss and deduplicates exact retry', async () => {
    class EvictingAdmissionStore extends InMemoryRoomAgentRuntimeStore {
      private evict = true;

      override async admitRunInput(
        input: RoomAgentTranscriptDraft,
        run: RoomAgentRunRecord,
      ): Promise<RoomAgentRunAdmissionResult> {
        const admitted = await super.admitRunInput(input, run);
        if (this.evict) {
          this.evict = false;
          throw new Error('simulated eviction after admission commit');
        }
        return admitted;
      }
    }

    const store = new EvictingAdmissionStore();
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
      driver: { run: async function* () { yield { type: 'completed' }; } },
    }]);
    const options = {
      roomId: 'room-1',
      registry,
      store,
      runStore: store,
      contextSource: contextSource(),
      createId: idFactory(),
      fallbackAgentId: 'oracle',
    };
    const request = {
      channelId: 'atomic-admission',
      disclosure: roomDisclosure,
      input: {
        id: 'input-atomic',
        speakerId: 'visitor-1',
        text: 'Commit me exactly once',
        modality: 'text' as const,
      },
    };
    const interrupted = new RoomAgentRuntime(options);
    await expect(interrupted.handleRunInput(request)).rejects.toThrow('simulated eviction');

    const admitted = await store.loadRunByInput('room-1', request.channelId, request.input.id);
    expect(admitted).toMatchObject({ status: 'active', latestInput: request.input });
    await expect(store.loadTranscript('room-1', request.channelId)).resolves.toHaveLength(1);

    const recovered = new RoomAgentRuntime(options);
    await expect(recovered.handleRunInput(request)).resolves.toMatchObject({
      status: 'duplicate',
      run: { id: admitted?.id, status: 'active' },
    });
    await expect(store.loadTranscript('room-1', request.channelId)).resolves.toHaveLength(1);
    await expect(recovered.resumeRun(admitted!.id)).resolves.toMatchObject({ status: 'completed' });
  });

  it('retries supersession after loss between old-run cancellation and new admission', async () => {
    class CrashAfterCancellationStore extends InMemoryRoomAgentRuntimeStore {
      private crash = true;

      override async commitRunEvent(
        run: RoomAgentRunRecord,
        event: RoomAgentRunJournalDraft,
      ): Promise<RoomAgentRunJournalAppendResult> {
        const committed = await super.commitRunEvent(run, event);
        if (this.crash
          && event.event.type === 'run_canceled'
          && event.event.reason === 'superseded_by_new_input') {
          this.crash = false;
          throw new Error('simulated loss after old-run cancellation');
        }
        return committed;
      }
    }

    const store = new CrashAfterCancellationStore();
    const oldRun: RoomAgentRunRecord = {
      schema: 'gaos.room-agent-run.v1',
      id: 'old-run-before-admit',
      roomId: 'room-1',
      channelId: 'supersession-before-admit',
      agentId: 'oracle',
      rootInputId: 'old-input',
      latestInput: {
        id: 'old-input', speakerId: 'visitor-1', text: 'Old work', modality: 'text',
      },
      disclosure: roomDisclosure,
      attempt: 1,
      status: 'active',
      startedAt: 1,
      updatedAt: 1,
      lastSequence: 0,
    };
    await store.createRun(oldRun);
    const driverEntries: string[] = [];
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
      driver: {
        run: async function* ({ input }) {
          driverEntries.push(input.text);
          yield {
            type: 'input_requested',
            requestId: 'replacement-wait',
            continuationToken: 'replacement-token',
          };
        },
      },
    }]);
    const options = {
      roomId: 'room-1', registry, store, runStore: store,
      contextSource: contextSource(), createId: idFactory(), fallbackAgentId: 'oracle',
    };
    const request = {
      channelId: oldRun.channelId,
      disclosure: roomDisclosure,
      input: {
        id: 'replacement-input',
        speakerId: 'visitor-1',
        text: 'Replacement work',
        modality: 'text' as const,
      },
    };

    const interrupted = new RoomAgentRuntime(options);
    await expect(interrupted.handleRunInput(request)).rejects.toThrow(
      'simulated loss after old-run cancellation',
    );
    await expect(store.loadRun(oldRun.roomId, oldRun.id)).resolves.toMatchObject({
      status: 'canceled',
    });
    await expect(store.loadRunByInput(
      oldRun.roomId,
      oldRun.channelId,
      request.input.id,
    )).resolves.toBeUndefined();
    await expect(store.loadOpenRun(oldRun.roomId, oldRun.channelId)).resolves.toBeUndefined();
    expect(driverEntries).toEqual([]);

    const recovered = new RoomAgentRuntime(options);
    const retried = await recovered.handleRunInput(request);
    expect(retried).toMatchObject({ status: 'waiting_for_input' });
    await expect(store.loadOpenRun(oldRun.roomId, oldRun.channelId)).resolves.toMatchObject({
      id: retried.run.id,
      status: 'waiting_for_input',
    });
    expect(driverEntries).toEqual(['Replacement work']);
    await expect(store.loadTranscript(oldRun.roomId, oldRun.channelId)).resolves.toMatchObject([
      { id: request.input.id, direction: 'input' },
    ]);
  });

  it('deduplicates supersession retry after loss following new admission commit', async () => {
    class CrashAfterNewAdmissionStore extends InMemoryRoomAgentRuntimeStore {
      private crash = true;

      override async admitRunInput(
        input: RoomAgentTranscriptDraft,
        run: RoomAgentRunRecord,
      ): Promise<RoomAgentRunAdmissionResult> {
        const admitted = await super.admitRunInput(input, run);
        if (this.crash && input.id === 'replacement-input') {
          this.crash = false;
          throw new Error('simulated loss after new-run admission');
        }
        return admitted;
      }
    }

    const store = new CrashAfterNewAdmissionStore();
    const oldRun: RoomAgentRunRecord = {
      schema: 'gaos.room-agent-run.v1',
      id: 'old-run-after-admit',
      roomId: 'room-1',
      channelId: 'supersession-after-admit',
      agentId: 'oracle',
      rootInputId: 'old-input',
      latestInput: {
        id: 'old-input', speakerId: 'visitor-1', text: 'Old work', modality: 'text',
      },
      disclosure: roomDisclosure,
      attempt: 1,
      status: 'active',
      startedAt: 1,
      updatedAt: 1,
      lastSequence: 0,
    };
    await store.createRun(oldRun);
    const driver = vi.fn(async function* () { yield { type: 'completed' as const }; });
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
      driver: { run: driver },
    }]);
    const options = {
      roomId: 'room-1', registry, store, runStore: store,
      contextSource: contextSource(), createId: idFactory(), fallbackAgentId: 'oracle',
    };
    const request = {
      channelId: oldRun.channelId,
      disclosure: roomDisclosure,
      input: {
        id: 'replacement-input',
        speakerId: 'visitor-1',
        text: 'Replacement work',
        modality: 'text' as const,
      },
    };

    const interrupted = new RoomAgentRuntime(options);
    await expect(interrupted.handleRunInput(request)).rejects.toThrow(
      'simulated loss after new-run admission',
    );
    const admitted = await store.loadRunByInput(
      oldRun.roomId,
      oldRun.channelId,
      request.input.id,
    );
    expect(admitted).toMatchObject({ status: 'active' });
    await expect(store.loadRun(oldRun.roomId, oldRun.id)).resolves.toMatchObject({
      status: 'canceled',
    });

    const recovered = new RoomAgentRuntime(options);
    await expect(recovered.handleRunInput(request)).resolves.toMatchObject({
      status: 'duplicate',
      run: { id: admitted?.id, status: 'active' },
    });
    await expect(store.loadOpenRun(oldRun.roomId, oldRun.channelId)).resolves.toMatchObject({
      id: admitted?.id,
      status: 'active',
    });
    await expect(store.loadTranscript(oldRun.roomId, oldRun.channelId)).resolves.toHaveLength(1);
    expect(driver).not.toHaveBeenCalled();
  });

  it('accepts an identical event retry before checking its stale proposed sequence', async () => {
    const store = new InMemoryRoomAgentRuntimeStore();
    const run: RoomAgentRunRecord = {
      schema: 'gaos.room-agent-run.v1',
      id: 'run-event-retry',
      roomId: 'room-1',
      channelId: 'private',
      agentId: 'oracle',
      rootInputId: 'input-1',
      latestInput: {
        id: 'input-1', speakerId: 'visitor-1', text: 'Retry events', modality: 'text',
      },
      disclosure: privateDisclosure,
      attempt: 1,
      status: 'active',
      startedAt: 1,
      updatedAt: 1,
      lastSequence: 0,
    };
    await store.createRun(run);
    const firstDraft = {
      id: 'event-1',
      runId: run.id,
      roomId: run.roomId,
      channelId: run.channelId,
      agentId: run.agentId,
      inputId: run.latestInput.id,
      recordedAt: 2,
      event: { type: 'progress' as const, progress: { stage: 'first' } },
    };
    const first = await store.commitRunEvent(run, firstDraft);
    const second = await store.commitRunEvent(first.run, {
      ...firstDraft,
      id: 'event-2',
      recordedAt: 3,
      event: { type: 'progress', progress: { stage: 'second' } },
    });

    const retried = await store.commitRunEvent(run, firstDraft);
    expect(retried).toMatchObject({
      duplicate: true,
      entry: { id: 'event-1', sequence: 1 },
      run: { lastSequence: second.run.lastSequence },
    });
  });

  it('serializes concurrent same-channel admission without holding the lane for execution', async () => {
    class PausingFirstAdmissionStore extends InMemoryRoomAgentRuntimeStore {
      private admissionCount = 0;
      private releaseFirst!: () => void;
      readonly firstCommitted = new Promise<void>((resolve) => {
        this.releaseFirst = resolve;
      });
      private continueFirst!: () => void;
      private readonly firstMayReturn = new Promise<void>((resolve) => {
        this.continueFirst = resolve;
      });

      override async admitRunInput(
        input: RoomAgentTranscriptDraft,
        run: RoomAgentRunRecord,
      ): Promise<RoomAgentRunAdmissionResult> {
        const admitted = await super.admitRunInput(input, run);
        this.admissionCount += 1;
        if (this.admissionCount === 1) {
          this.releaseFirst();
          await this.firstMayReturn;
        }
        return admitted;
      }

      allowFirstToReturn(): void {
        this.continueFirst();
      }
    }

    let releaseLatest!: () => void;
    const latestWork = new Promise<void>((resolve) => { releaseLatest = resolve; });
    const store = new PausingFirstAdmissionStore();
    const driverEntries: string[] = [];
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
      driver: {
        run: async function* ({ input, signal }) {
          driverEntries.push(input.text);
          yield { type: 'progress', progress: { stage: input.text } };
          if (input.text === 'Latest') {
            await latestWork;
            if (!signal?.aborted) yield { type: 'completed' };
            return;
          }
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
        },
      },
    }]);
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1', registry, store, runStore: store,
      contextSource: contextSource(), createId: idFactory(), fallbackAgentId: 'oracle',
    });
    const first = runtime.startRun({
      channelId: 'same-channel',
      disclosure: roomDisclosure,
      input: { id: 'input-first', speakerId: 'visitor-1', text: 'First', modality: 'text' },
    });
    await store.firstCommitted;
    const latest = runtime.startRun({
      channelId: 'same-channel',
      disclosure: roomDisclosure,
      input: { id: 'input-latest', speakerId: 'visitor-1', text: 'Latest', modality: 'text' },
    });
    store.allowFirstToReturn();

    await expect(latest.events[Symbol.asyncIterator]().next()).resolves.toMatchObject({
      value: { event: { type: 'progress', progress: { stage: 'Latest' } } },
    });
    expect(driverEntries).toEqual(['Latest']);
    const firstRun = await store.loadRunByInput('room-1', 'same-channel', 'input-first');
    const latestRun = await store.loadRunByInput('room-1', 'same-channel', 'input-latest');
    expect(firstRun).toMatchObject({ status: 'canceled' });
    expect(latestRun).toMatchObject({ status: 'active' });
    await expect(store.loadOpenRun('room-1', 'same-channel')).resolves.toMatchObject({
      id: latestRun?.id,
    });

    releaseLatest();
    await expect(first.result).resolves.toMatchObject({ status: 'canceled' });
    await expect(latest.result).resolves.toMatchObject({ status: 'completed' });
    const transcript = await store.loadTranscript('room-1', 'same-channel');
    expect(transcript.filter(({ direction }) => direction === 'input').map(({ id }) => id)).toEqual([
      'input-first',
      'input-latest',
    ]);
    await expect(runtime.replayRun(firstRun!.id)).resolves.toMatchObject({
      run: { status: 'canceled' },
      events: [expect.objectContaining({ event: { type: 'run_canceled', reason: 'superseded_by_new_input' } })],
    });
  });

  it('does not revive a run canceled while a recovery attempt is acquiring ownership', async () => {
    class PausingRecoveryStore extends InMemoryRoomAgentRuntimeStore {
      private markSaveEntered!: () => void;
      readonly saveEntered = new Promise<void>((resolve) => {
        this.markSaveEntered = resolve;
      });
      private continueSave!: () => void;
      private readonly saveMayContinue = new Promise<void>((resolve) => {
        this.continueSave = resolve;
      });

      override async saveRun(run: RoomAgentRunRecord): Promise<boolean> {
        this.markSaveEntered();
        await this.saveMayContinue;
        return await super.saveRun(run);
      }

      allowSaveToContinue(): void {
        this.continueSave();
      }
    }

    const store = new PausingRecoveryStore();
    const active: RoomAgentRunRecord = {
      schema: 'gaos.room-agent-run.v1',
      id: 'run-resume-cancel-race',
      roomId: 'room-1',
      channelId: 'private',
      agentId: 'oracle',
      rootInputId: 'input-1',
      latestInput: {
        id: 'input-1', speakerId: 'visitor-1', text: 'Resume me', modality: 'text',
      },
      disclosure: privateDisclosure,
      attempt: 1,
      status: 'active',
      startedAt: 1,
      updatedAt: 1,
      lastSequence: 0,
    };
    await store.createRun(active);
    const driver = vi.fn(async function* () { yield { type: 'completed' as const }; });
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'oracle', label: 'Oracle', role: 'character' },
      driver: { run: driver },
    }]);
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1', registry, store, runStore: store,
      contextSource: contextSource(), createId: idFactory(), fallbackAgentId: 'oracle',
    });

    const resumed = runtime.resumeRun(active.id);
    await store.saveEntered;
    await expect(runtime.cancelRun(active.id, 'canceled_during_resume')).resolves.toBe(true);
    store.allowSaveToContinue();

    await expect(resumed).resolves.toMatchObject({
      status: 'canceled',
      run: { id: active.id, status: 'canceled', attempt: 1 },
    });
    await expect(runtime.replayRun(active.id)).resolves.toMatchObject({
      run: { status: 'canceled', attempt: 1 },
      events: [expect.objectContaining({
        event: { type: 'run_canceled', reason: 'canceled_during_resume' },
      })],
    });
    expect(driver).not.toHaveBeenCalled();
  });
});
