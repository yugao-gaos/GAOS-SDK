import { describe, expect, it, vi } from 'vitest';
import {
  RoomAgentServiceRegistry,
  RoomInteractionRouter,
  RoomInteractionWatcherRegistry,
  resolveRoomVote,
  roomAgentInputFromInteraction,
  type RoomInteractionEnvelope,
  type RoomVoteDefinition,
} from '../src/room-interaction.js';

function idFactory(): () => string {
  let next = 0;
  return () => `interaction-${++next}`;
}

describe('room interaction routing', () => {
  it('uses explicit targets, delivers in order, and deduplicates envelope ids', async () => {
    const router = new RoomInteractionRouter({ createId: idFactory() });
    const guide = vi.fn(() => 'guide-result');
    const merchant = vi.fn(() => 'merchant-result');
    router.register({ kind: 'agent', id: 'guide' }, guide);
    router.register({ kind: 'agent', id: 'merchant' }, merchant);
    const envelope = router.create(
      'room-1',
      'public',
      { kind: 'participant', id: 'audience-1' },
      {
        targets: [{ kind: 'agent', id: 'guide' }],
        disclosure: { kind: 'room' },
        payload: { kind: 'message', text: 'Explain the turn.', modality: 'speech' },
      },
    );

    await expect(router.dispatch(envelope)).resolves.toEqual({
      duplicate: false,
      deliveries: [{ target: { kind: 'agent', id: 'guide' }, result: 'guide-result' }],
    });
    await expect(router.dispatch(envelope)).resolves.toEqual({
      duplicate: true,
      deliveries: [],
    });
    expect(guide).toHaveBeenCalledOnce();
    expect(merchant).not.toHaveBeenCalled();
  });

  it('checks every target before making an atomic delivery attempt', async () => {
    const router = new RoomInteractionRouter({ createId: idFactory() });
    const guide = vi.fn();
    router.register({ kind: 'agent', id: 'guide' }, guide);
    const envelope = router.create(
      'room-1',
      'public',
      { kind: 'participant', id: 'audience-1' },
      {
        targets: [
          { kind: 'agent', id: 'guide' },
          { kind: 'agent', id: 'missing' },
        ],
        disclosure: { kind: 'room' },
        payload: { kind: 'message', text: 'Hello.', modality: 'text' },
      },
    );

    await expect(router.dispatch(envelope)).rejects.toThrow(
      'unknown room interaction target: agent:"missing"',
    );
    expect(guide).not.toHaveBeenCalled();
  });

  it('rejects provider objects that are not portable JSON payloads', () => {
    const router = new RoomInteractionRouter({ createId: idFactory() });

    expect(() => router.create(
      'room-1',
      'public',
      { kind: 'watcher', id: 'rounds' },
      {
        targets: [{ kind: 'agent', id: 'guide' }],
        payload: {
          kind: 'event',
          topic: 'round.started',
          data: { callback: () => undefined } as never,
        },
      },
    )).toThrow('room event data');
  });

  it('preserves channel and causation while preventing disclosure widening', () => {
    const router = new RoomInteractionRouter({ createId: idFactory(), maxHops: 1 });
    const root = router.create(
      'room-1',
      'private:audience-1:guide',
      { kind: 'participant', id: 'audience-1' },
      {
        targets: [{ kind: 'agent', id: 'guide' }],
        disclosure: { kind: 'participants', participantIds: ['audience-1'] },
        payload: { kind: 'message', text: 'Is my card useful?', modality: 'text' },
      },
    );
    const reply = router.derive(root, { kind: 'agent', id: 'guide' }, {
      targets: [{ kind: 'participant', id: 'audience-1' }],
      disclosure: { kind: 'room' },
      payload: { kind: 'message', text: 'Yes.', modality: 'generated', speak: true },
    });

    expect(reply).toMatchObject({
      roomId: 'room-1',
      channelId: 'private:audience-1:guide',
      disclosure: { kind: 'participants', participantIds: ['audience-1'] },
      cause: { rootId: root.id, parentId: root.id, hop: 1 },
    });
    expect(() => router.derive(reply, { kind: 'participant', id: 'audience-1' }, {
      targets: [{ kind: 'agent', id: 'merchant' }],
      payload: { kind: 'message', text: 'Loop.', modality: 'generated' },
    })).toThrow('exceeded maxHops');
  });

  it('rejects source spoofing and new agents on an existing private chain', () => {
    const router = new RoomInteractionRouter({ createId: idFactory() });
    const root = router.create(
      'room-1',
      'private:audience-1:guide',
      { kind: 'participant', id: 'audience-1' },
      {
        targets: [{ kind: 'agent', id: 'guide' }],
        disclosure: { kind: 'participants', participantIds: ['audience-1'] },
        payload: { kind: 'message', text: 'Secret.', modality: 'text' },
      },
    );
    const privateDraft = {
      targets: [{ kind: 'agent' as const, id: 'merchant' }],
      payload: { kind: 'message' as const, text: 'Forward.', modality: 'generated' as const },
    };

    expect(() => router.derive(
      root,
      { kind: 'agent', id: 'merchant' },
      privateDraft,
    )).toThrow('source was not a parent target');
    expect(() => router.derive(
      root,
      { kind: 'agent', id: 'guide' },
      privateDraft,
    )).toThrow('private room interaction cannot add target');
    expect(() => router.create(
      'room-1',
      'private:audience-1:guide',
      { kind: 'agent', id: 'guide' },
      {
        targets: [{ kind: 'participant', id: 'player-1' }],
        disclosure: { kind: 'participants', participantIds: ['audience-1'] },
        payload: { kind: 'message', text: 'Wrong recipient.', modality: 'generated' },
      },
    )).toThrow('target is not disclosed');
  });

  it('serializes independent deliveries through one FIFO queue', async () => {
    const router = new RoomInteractionRouter({ createId: idFactory() });
    const order: string[] = [];
    let release!: () => void;
    router.register({ kind: 'agent', id: 'guide' }, async (envelope) => {
      order.push(`start:${envelope.id}`);
      if (envelope.id === 'interaction-1') {
        await new Promise<void>((resolve) => { release = resolve; });
      }
      order.push(`end:${envelope.id}`);
    });
    const draft = {
      targets: [{ kind: 'agent' as const, id: 'guide' }],
      disclosure: { kind: 'room' as const },
      payload: { kind: 'message' as const, text: 'Hello.', modality: 'text' as const },
    };
    const first = router.dispatch(router.create(
      'room-1', 'public', { kind: 'participant', id: 'p1' }, draft,
    ));
    const second = router.dispatch(router.create(
      'room-1', 'public', { kind: 'participant', id: 'p2' }, draft,
    ));
    await vi.waitFor(() => expect(order).toEqual(['start:interaction-1']));
    release();
    await Promise.all([first, second]);

    expect(order).toEqual([
      'start:interaction-1',
      'end:interaction-1',
      'start:interaction-2',
      'end:interaction-2',
    ]);
  });

  it('adapts agent-to-agent messages to the existing room-agent input', () => {
    const envelope: RoomInteractionEnvelope = {
      id: 'interaction-1',
      roomId: 'room-1',
      channelId: 'agents:merchant:guide',
      source: { kind: 'agent', id: 'merchant' },
      targets: [{ kind: 'agent', id: 'guide' }],
      disclosure: { kind: 'none' },
      payload: { kind: 'message', text: 'What do you know?', modality: 'generated' },
      cause: { rootId: 'interaction-1', hop: 0 },
    };

    expect(roomAgentInputFromInteraction(envelope)).toEqual({
      id: 'interaction-1',
      speakerId: 'merchant',
      speakerKind: 'agent',
      text: 'What do you know?',
      modality: 'text',
      addressedAgentIds: ['guide'],
    });
  });
});

describe('room agent services', () => {
  it('checks agent capability and returns one retry-stable correlated result', async () => {
    const invoke = vi.fn(async () => ({ ok: true, output: { forecast: 'clear' } }));
    const services = new RoomAgentServiceRegistry([{
      id: 'weather',
      invoke,
    }]);
    const envelope: RoomInteractionEnvelope = {
      id: 'interaction-1',
      roomId: 'room-1',
      channelId: 'agents:guide:service:weather',
      source: { kind: 'agent', id: 'guide' },
      targets: [{ kind: 'service', id: 'weather' }],
      disclosure: { kind: 'none' },
      payload: {
        kind: 'service-request',
        callId: 'call-1',
        serviceId: 'weather',
        operation: 'forecast',
        input: { region: 'north' },
      },
      cause: { rootId: 'interaction-1', hop: 0 },
    };
    const agent = {
      id: 'guide',
      label: 'Guide',
      role: 'guide' as const,
      serviceIds: ['weather'],
    };

    const expected = {
      kind: 'service-result',
      callId: 'call-1',
      serviceId: 'weather',
      ok: true,
      output: { forecast: 'clear' },
    };
    await expect(services.invoke(agent, envelope)).resolves.toEqual(expected);
    await expect(services.invoke(agent, envelope)).resolves.toEqual(expected);
    expect(invoke).toHaveBeenCalledOnce();

    await expect(services.invoke({ ...agent, serviceIds: [] }, envelope)).rejects.toThrow(
      'not allowed to use service',
    );
    await expect(services.invoke(agent, {
      ...envelope,
      payload: {
        kind: 'service-request',
        callId: 'call-1',
        serviceId: 'weather',
        operation: 'history',
        input: { region: 'north' },
      },
    })).rejects.toThrow('service call id was reused');
  });
});

describe('room interaction watchers', () => {
  it('raises drafts once for each committed room revision', async () => {
    const onCommitted = vi.fn(() => [{
      targets: [{ kind: 'agent' as const, id: 'guide' }],
      disclosure: { kind: 'room' as const },
      payload: {
        kind: 'event' as const,
        topic: 'round.started',
        transitionRevision: 7,
      },
    }]);
    const watchers = new RoomInteractionWatcherRegistry([{ id: 'rounds', onCommitted }]);
    const context = {
      roomId: 'room-1',
      observation: { round: 2 },
      tick: 8,
      transitionRevision: 7,
    };

    await expect(watchers.raiseCommitted(context)).resolves.toEqual([{
      watcherId: 'rounds',
      drafts: [expect.objectContaining({ payload: expect.objectContaining({
        topic: 'round.started',
      }) })],
    }]);
    await expect(watchers.raiseCommitted(context)).resolves.toEqual([]);
    expect(onCommitted).toHaveBeenCalledOnce();
  });
});

describe('room voting', () => {
  const definition: RoomVoteDefinition = {
    id: 'route-vote',
    prompt: 'Which route?',
    options: [
      { id: 'forest', label: 'Forest' },
      { id: 'river', label: 'River' },
    ],
    eligibleParticipantIds: ['p1', 'p2'],
    tieBreakOrder: ['river', 'forest'],
    ballotVisibility: 'secret',
  };

  it('is order-independent and resolves ties by explicit stable policy', () => {
    const casts = [
      { voteId: 'route-vote', participantId: 'p1', optionId: 'forest' },
      { voteId: 'route-vote', participantId: 'p2', optionId: 'river' },
    ];
    const expected = {
      voteId: 'route-vote',
      counts: [
        { optionId: 'forest', count: 1 },
        { optionId: 'river', count: 1 },
      ],
      totalBallots: 2,
      winnerOptionId: 'river',
      tiedOptionIds: ['forest', 'river'],
    };

    expect(resolveRoomVote(definition, casts)).toEqual(expected);
    expect(resolveRoomVote(definition, [...casts].reverse())).toEqual(expected);
  });

  it('rejects ineligible and duplicate ballots instead of asking an agent to tally', () => {
    expect(() => resolveRoomVote(definition, [{
      voteId: 'route-vote', participantId: 'missing', optionId: 'forest',
    }])).toThrow('not eligible');
    expect(() => resolveRoomVote(definition, [
      { voteId: 'route-vote', participantId: 'p1', optionId: 'forest' },
      { voteId: 'route-vote', participantId: 'p1', optionId: 'river' },
    ])).toThrow('duplicate room vote cast');
  });
});
