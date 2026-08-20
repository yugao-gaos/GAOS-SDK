import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryRoomAgentRuntimeStore,
  RoomAgentRuntime,
  type RoomAgentRuntimeContextSource,
  type RoomAgentRuntimeEvent,
  type RoomCaptionEvent,
  type RoomSpeechRequest,
} from '../src/room-agent-runtime.js';
import {
  RoomAgentRegistry,
  type GameAgentManifest,
  type RoomAgentContext,
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
});
