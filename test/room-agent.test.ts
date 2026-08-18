import { describe, expect, it, vi } from 'vitest';
import {
  RoomAgentRegistry,
  type GameAgentManifest,
  type RoomAgentContext,
  type RoomAgentRegistration,
} from '../src/room-agent.js';
import {
  RoomInteractionRouter,
  roomAgentInputFromInteraction,
} from '../src/room-interaction.js';
import type { SubmittedAction } from '../src/engine/index.js';

interface Observation {
  phase: string;
}

const manifest: GameAgentManifest = {
  gameId: 'demo',
  gameVersion: '1.0.0',
  rules: [{ id: 'turn', title: 'Take a turn', body: 'Choose one legal action.' }],
};

const participants = [
  { id: 'audience-1', role: 'spectator' as const, displayName: 'Audience One' },
  { id: 'player-1', role: 'player' as const, seat: 'north' },
];

const baseContext: Omit<RoomAgentContext<Observation>, 'agent'> = {
  roomId: 'room-1',
  input: {
    id: 'utterance-1',
    speakerId: 'audience-1',
    text: 'What can the north player do?',
    modality: 'speech',
    addressedAgentIds: ['guide'],
  },
  participants,
  observation: { phase: 'playing' },
  manifest,
  legalActions: [],
  tick: 2,
  transitionRevision: 4,
};

describe('room agents', () => {
  it('lets an unbound guide answer an audience member without a game action', async () => {
    const respond = vi.fn(async () => ({
      utterances: [{ text: 'North may move or wait.', audience: { kind: 'room' as const } }],
    }));
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'guide', label: 'Guide', role: 'guide' },
      driver: { respond },
    }]);

    await expect(registry.respond('guide', baseContext)).resolves.toEqual({
      agentId: 'guide',
      utterances: [{ text: 'North may move or wait.', audience: { kind: 'room' } }],
    });
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      agent: expect.objectContaining({ id: 'guide' }),
      input: expect.objectContaining({ speakerId: 'audience-1' }),
      observation: { phase: 'playing' },
      manifest,
    }));
  });

  it('keeps several agents independently addressable in one room', async () => {
    const registrations: RoomAgentRegistration<Observation>[] = [
      {
        descriptor: { id: 'guide', label: 'Guide', role: 'guide' },
        driver: { respond: async () => ({ utterances: [{ text: 'Guide answer' }] }) },
      },
      {
        descriptor: { id: 'merchant', label: 'Merchant', role: 'character' },
        driver: { respond: async () => ({ utterances: [{ text: 'Merchant answer' }] }) },
      },
    ];
    const registry = new RoomAgentRegistry(registrations);

    expect(registry.list().map(({ id }) => id)).toEqual(['guide', 'merchant']);
    await expect(registry.respond('merchant', {
      ...baseContext,
      input: { ...baseContext.input, addressedAgentIds: ['merchant'] },
    })).resolves.toMatchObject({
      agentId: 'merchant',
      utterances: [{ text: 'Merchant answer' }],
    });
  });

  it('allows an agent to continue an unscripted agent-to-agent exchange', async () => {
    const router = new RoomInteractionRouter({ createId: () => 'reply-1' });
    const interaction = router.create(
      'room-1',
      'agents:merchant:guide',
      { kind: 'agent', id: 'merchant' },
      {
        targets: [{ kind: 'agent', id: 'guide' }],
        disclosure: { kind: 'none' },
        payload: { kind: 'message', text: 'Where is the map?', modality: 'generated' },
      },
    );
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: {
        id: 'guide',
        label: 'Guide',
        role: 'guide',
        personaId: 'patient-guide',
      },
      driver: {
        respond: async () => ({
          interactions: [{
            targets: [{ kind: 'agent', id: 'merchant' }],
            payload: {
              kind: 'message',
              text: 'The player is carrying it.',
              modality: 'generated',
            },
          }],
        }),
      },
    }]);

    await expect(registry.respond('guide', {
      ...baseContext,
      input: roomAgentInputFromInteraction(interaction),
      interaction,
    })).resolves.toMatchObject({
      agentId: 'guide',
      utterances: [],
      interactions: [{
        targets: [{ kind: 'agent', id: 'merchant' }],
        disclosure: { kind: 'none' },
        payload: { kind: 'message', text: 'The player is carrying it.' },
      }],
    });
  });

  it('clamps a private participant reply even when the driver asks to address the room', async () => {
    const router = new RoomInteractionRouter({ createId: () => 'private-1' });
    const interaction = router.create(
      'room-1',
      'private:audience-1:guide',
      { kind: 'participant', id: 'audience-1' },
      {
        targets: [{ kind: 'agent', id: 'guide' }],
        disclosure: { kind: 'participants', participantIds: ['audience-1'] },
        payload: { kind: 'message', text: 'What is my hint?', modality: 'text' },
      },
    );
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'guide', label: 'Guide', role: 'guide' },
      driver: {
        respond: async () => ({
          utterances: [{ text: 'Your private hint.', audience: { kind: 'room' } }],
          interactions: [{
            targets: [{ kind: 'service', id: 'hints' }],
            disclosure: { kind: 'room' },
            payload: {
              kind: 'service-request',
              callId: 'hint-1',
              serviceId: 'hints',
              operation: 'acknowledge',
            },
          }],
        }),
      },
    }]);

    await expect(registry.respond('guide', {
      ...baseContext,
      input: roomAgentInputFromInteraction(interaction),
      interaction,
    })).resolves.toMatchObject({
      utterances: [{
        text: 'Your private hint.',
        audience: { kind: 'participants', participantIds: ['audience-1'] },
      }],
      interactions: [{
        disclosure: { kind: 'participants', participantIds: ['audience-1'] },
      }],
    });
  });

  it('rejects a spoofed routed source before invoking the agent driver', async () => {
    const respond = vi.fn(async () => ({ utterances: [{ text: 'No.' }] }));
    const router = new RoomInteractionRouter({ createId: () => 'private-1' });
    const interaction = router.create(
      'room-1',
      'private:audience-1:guide',
      { kind: 'participant', id: 'audience-1' },
      {
        targets: [{ kind: 'agent', id: 'guide' }],
        disclosure: { kind: 'participants', participantIds: ['audience-1'] },
        payload: { kind: 'message', text: 'Hello.', modality: 'text' },
      },
    );
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'guide', label: 'Guide', role: 'guide' },
      driver: { respond },
    }]);

    await expect(registry.respond('guide', {
      ...baseContext,
      input: {
        ...roomAgentInputFromInteraction(interaction),
        speakerId: 'player-1',
      },
      interaction,
    })).rejects.toThrow('source does not match');
    expect(respond).not.toHaveBeenCalled();
  });

  it('copies descriptor metadata across the driver and registry boundaries', async () => {
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: {
        id: 'guide',
        label: 'Guide',
        role: 'guide',
        voice: { id: 'guide-voice' },
        visibility: { kind: 'participants', participantIds: ['audience-1'] },
      },
      driver: {
        respond: async ({ agent }) => {
          (agent.voice as { id: string }).id = 'mutated';
          return { utterances: [{ text: 'Still isolated' }] };
        },
      },
    }]);

    await registry.respond('guide', baseContext);
    expect(registry.require('guide').descriptor).toMatchObject({
      voice: { id: 'guide-voice' },
      visibility: { kind: 'participants', participantIds: ['audience-1'] },
    });
  });

  it('returns a bound NPC action as a proposal without submitting it', async () => {
    const action: SubmittedAction = {
      id: 'actor.trade',
      seat: 'north',
      payload: { actorId: 'merchant-7', item: 'map' },
    };
    const subject = { kind: 'actor', actorId: 'merchant-7', seat: 'north' } as const;
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: {
        id: 'merchant',
        label: 'Merchant',
        role: 'character',
        controlSubject: subject,
      },
      driver: {
        respond: async () => ({
          utterances: [{ text: 'A fair trade.' }],
          action,
        }),
      },
    }]);

    await expect(registry.respond('merchant', {
      ...baseContext,
      legalActions: [action],
    })).resolves.toEqual({
      agentId: 'merchant',
      utterances: [{ text: 'A fair trade.' }],
      action: { subject, action },
    });
  });

  it('does not let room presence or spectator input grant action authority', async () => {
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'guide', label: 'Guide', role: 'guide' },
      driver: { respond: async () => ({ action: { id: 'game.advance' } }) },
    }]);

    await expect(registry.respond('guide', baseContext)).rejects.toThrow(
      'speech-only room agent cannot propose an action',
    );
  });

  it('rejects an action that claims a different seat than the binding', async () => {
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: {
        id: 'north-agent',
        label: 'North Agent',
        role: 'character',
        controlSubject: { kind: 'seat', seat: 'north' },
      },
      driver: { respond: async () => ({ action: { id: 'move', seat: 'south' } }) },
    }]);

    await expect(registry.respond('north-agent', baseContext)).rejects.toThrow(
      'action seat does not match its control binding',
    );
  });

  it('requires the authenticated speaker to be present in the room', async () => {
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'guide', label: 'Guide', role: 'guide' },
      driver: { respond: async () => ({ utterances: [{ text: 'Hello' }] }) },
    }]);

    await expect(registry.respond('guide', {
      ...baseContext,
      input: { ...baseContext.input, speakerId: 'missing' },
    })).rejects.toThrow('room input speaker is not present');
  });

  it('aborts and discards an in-flight response when an agent is replaced', async () => {
    let finish!: () => void;
    const sawAbort = vi.fn();
    const registry = new RoomAgentRegistry<Observation>([{
      descriptor: { id: 'guide', label: 'Guide', role: 'guide' },
      driver: {
        respond: ({ signal }) => new Promise((resolve) => {
          signal?.addEventListener('abort', sawAbort, { once: true });
          finish = () => resolve({ utterances: [{ text: 'Stale' }] });
        }),
      },
    }]);

    const stale = registry.respond('guide', baseContext);
    registry.register({
      descriptor: { id: 'guide', label: 'Replacement', role: 'guide' },
      driver: { respond: async () => ({ utterances: [{ text: 'Current' }] }) },
    }, { replace: true });
    finish();

    await expect(stale).resolves.toBeNull();
    expect(sawAbort).toHaveBeenCalledOnce();
    await expect(registry.respond('guide', baseContext)).resolves.toMatchObject({
      utterances: [{ text: 'Current' }],
    });
  });
});
