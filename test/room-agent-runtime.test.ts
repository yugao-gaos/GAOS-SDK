import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryRoomAgentRuntimeStore,
  RoomAgentRuntime,
  type RoomAgentRuntimeContextSource,
  type RoomAgentRuntimeEvent,
  type RoomAgentRunAdmissionResult,
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

function contextSource(): RoomAgentRuntimeContextSource<Observation> {
  return async ({ phase }): Promise<Omit<
    RoomAgentContext<Observation>,
    'agent' | 'roomId' | 'input' | 'signal'
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
      input: {
        id: 'turn-1', speakerId: 'visitor-1', text: 'Hello', modality: 'text',
      },
    });
    await runtime.setFocus('visitor-1', 'guide');
    await runtime.handleFinalInput({
      channelId: 'public',
      input: {
        id: 'turn-2', speakerId: 'visitor-1', text: 'Hello again', modality: 'speech',
      },
    });
    await runtime.handleFinalInput({
      channelId: 'public',
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
      input: {
        id: 'turn-1', speakerId: 'visitor-1', text: 'First', modality: 'speech',
      },
    });
    await vi.waitFor(() => expect(speak).toHaveBeenCalledOnce());
    const second = runtime.handleFinalInput({
      channelId: 'public',
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
      input: { id: 'turn-1', speakerId: 'visitor-1', text: 'First', modality: 'speech' },
    });
    await vi.waitFor(() => expect(spoken).toEqual(['First']));
    const second = runtime.handleFinalInput({
      channelId: 'public',
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
    const store = new InMemoryRoomAgentRuntimeStore();
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
      type: 'assistant_output', outputId: 'answer-1', delta: 'The first ',
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
              outputId: 'follow-up',
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
            outputId: 'interpretation',
            delta: `You found ${context.input.text}.`,
            final: true,
          };
          yield { type: 'completed' };
        },
      },
    }]);
    const store = new InMemoryRoomAgentRuntimeStore();
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1', registry, store, runStore: store,
      contextSource: contextSource(), createId: idFactory(), fallbackAgentId: 'oracle',
      wallNow: () => wallClock,
    });

    const first = await runtime.handleRunInput({
      channelId: 'private',
      deadlineMs: 100,
      input: { id: 'input-1', speakerId: 'visitor-1', text: 'A gate', modality: 'text' },
    });
    expect(first).toMatchObject({
      status: 'waiting_for_input',
      run: {
        attempt: 1,
        deadlineMs: 100,
        deadlineAt: undefined,
        checkpoint: { path: ['gate'] },
        continuation: { requestId: 'gate-detail', token: 'continue-1' },
      },
    });

    // Human waiting time does not consume the next active attempt's budget.
    wallClock = 50_000;
    const second = await runtime.handleRunInput({
      channelId: 'private',
      continuation: { runId: first.run.id, token: 'continue-1' },
      input: { id: 'input-2', speakerId: 'visitor-1', text: 'a garden', modality: 'speech' },
    });
    expect(second).toMatchObject({
      status: 'completed',
      run: { id: first.run.id, attempt: 2, deadlineMs: 100, deadlineAt: 50_100 },
    });
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
    const store = new InMemoryRoomAgentRuntimeStore();
    const runtime = new RoomAgentRuntime({
      roomId: 'room-1', registry, store, runStore: store,
      contextSource: contextSource(), createId: idFactory(), fallbackAgentId: 'oracle',
    });
    const execution = runtime.startRun({
      channelId: 'cancel',
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
      deadlineMs: 5,
      input: { id: 'deadline-1', speakerId: 'visitor-1', text: 'Wait', modality: 'text' },
    });
    expect(deadline.status).toBe('deadline_exceeded');
    await expect(runtime.replayRun(deadline.run.id)).resolves.toMatchObject({
      run: { status: 'deadline_exceeded' },
      events: [
        { event: { type: 'progress' } },
        { event: { type: 'deadline_exceeded' } },
      ],
    });
  });

  it('restores a durable checkpoint into an explicitly resumed active run', async () => {
    const seen: RoomAgentRunContext<Observation>['run'][] = [];
    const store = new InMemoryRoomAgentRuntimeStore();
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
      input: { id: 'input-1', speakerId: 'visitor-1', text: 'First', modality: 'text' },
    });
    const second = runtime.startRun({
      channelId: 'second-channel',
      input: { id: 'input-2', speakerId: 'visitor-1', text: 'Second', modality: 'text' },
    });
    await second.events[Symbol.asyncIterator]().next();

    await expect(runtime.cancelRun(first.run.id, 'cancel_waiting')).resolves.toBe(true);
    expect(secondSignal?.aborted).toBe(false);
    releaseSecond();
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
});
