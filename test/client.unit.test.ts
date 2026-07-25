import { afterEach, describe, expect, it, vi } from 'vitest';
import { createIntentWindow, pendingEnvelope, tickEnvelope } from '../src/protocol.js';
import {
  ArenaClient,
  ProtocolMismatchError,
  parseTickResult,
  type GameObservation,
} from '../src/index.js';

const OBSERVATION: GameObservation = {
  tickNumber: 0,
  controlRevision: 0,
  narrative: null,
  grid: '@ .',
  visualEvents: [],
  actions: [{ id: 'Action 1', params: 'none' }],
  status: 'playing',
  hud: { actionsUsed: 0, maxActions: 4, carrying: null },
};

afterEach(() => vi.unstubAllGlobals());

describe('ArenaClient v1 protocol adapter', () => {
  it('preserves battle integrity and additive character observations', () => {
    const unit = {
      id: 'hacker',
      participantId: 'north',
      team: 'player',
      at: [1, 2] as [number, number],
      hp: 2,
      maxHp: 2,
      character: 'hacker',
      cast: 'hacker',
      controlMode: 'direct' as const,
      abilities: ['hack_drone', 'remote_control'],
      statuses: [{ kind: 'shield_field', phase: 'active', remaining: 1, capacity: 2 }],
    };
    const character = (({ hp: _hp, maxHp: _maxHp, ...entry }) => entry)(unit);
    const result = parseTickResult<GameObservation>(tickEnvelope('s1', 0, {
      ...OBSERVATION,
      hud: { ...OBSERVATION.hud, units: [unit], characters: [character] },
    }));

    expect(result.tick.hud.units).toEqual([unit]);
    expect(result.tick.hud.characters).toEqual([character]);
  });

  it('preserves the typed seat-relative Arena draw discriminator', () => {
    const result = parseTickResult<GameObservation>(tickEnvelope('arena-1', 4, {
      ...OBSERVATION,
      tickNumber: 4,
      status: 'failed',
      hud: { ...OBSERVATION.hud, arenaOutcome: 'draw' },
    }));

    expect(result.tick.hud.arenaOutcome).toBe('draw');
  });

  it('rejects unversioned tick-shaped responses', () => {
    expect(() => parseTickResult(OBSERVATION)).toThrow(ProtocolMismatchError);
    expect(() => parseTickResult({
      ...tickEnvelope('s1', 0, OBSERVATION),
      sessionId: '',
    })).toThrow(ProtocolMismatchError);
    expect(() => parseTickResult({
      ...tickEnvelope('s1', 0, OBSERVATION),
      tickId: '',
    })).toThrow(ProtocolMismatchError);
    expect(() => parseTickResult({
      ...tickEnvelope('s1', 0, OBSERVATION),
      revision: -1,
    })).toThrow(ProtocolMismatchError);
    expect(() => parseTickResult({
      ...tickEnvelope('s1', 0, OBSERVATION), extensions: 7,
    })).toThrow('extensions');
  });

  it('rejects incoherent pending participant state without constraining opaque tick ids', () => {
    const pending = {
      ...tickEnvelope('s1', 0, OBSERVATION),
      kind: 'pending',
      tickId: 'opaque-tick-token',
      submittedParticipants: ['north'],
      awaitingParticipants: ['south'],
      acceptedParticipantId: 'north',
    };
    expect(parseTickResult(pending)).toMatchObject({ tickId: 'opaque-tick-token' });
    expect(() => parseTickResult({ ...pending, submittedParticipants: ['north', 'north'] }))
      .toThrow('unique');
    expect(() => parseTickResult({ ...pending, awaitingParticipants: ['north'] }))
      .toThrow('disjoint');
    expect(() => parseTickResult({ ...pending, awaitingParticipants: [] }))
      .toThrow('must await');
    expect(() => parseTickResult({ ...pending, acceptedParticipantId: 'south' }))
      .toThrow('must be submitted');
    expect(() => parseTickResult({ ...pending, acceptedParticipantId: null }))
      .toThrow('must be submitted');
  });

  it('sends the generic command envelope and polls pending ticks once', async () => {
    const window = createIntentWindow('s1', 0, ['player', 'remote']);
    window.intents.player = {
      participantId: 'player',
      submissionId: 'request-1',
      command: { id: 'Action 1' },
    };
    const responses = [
      new Response(JSON.stringify(tickEnvelope('s1', 0, OBSERVATION)), { status: 201 }),
      new Response(JSON.stringify(pendingEnvelope(window, OBSERVATION, 'player')), { status: 202 }),
      new Response(JSON.stringify(tickEnvelope('s1', 1, { ...OBSERVATION, tickNumber: 1 }))),
    ];
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return responses.shift()!;
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new ArenaClient('https://example.test');
    const start = await client.createSession({
      gameMode: 'challenge',
      playMethod: 'human',
      levelId: 'test',
    });
    const tick = await client.submitAction(start.sessionId, { id: 'Action 1' }, {
      pollIntervalMs: 0,
      maxPollAttempts: 1,
      submissionId: 'request-1',
    });
    expect(tick.tickNumber).toBe(1);

    const [, submitCall, pollCall] = calls;
    expect(submitCall?.[0]).toBe('https://example.test/v1/sessions/s1/actions');
    const init = submitCall?.[1];
    if (!init) throw new Error('missing submit request');
    expect(JSON.parse(String(init.body))).toEqual({
      protocol: 'agilabs.ticks',
      protocolVersion: '1.0',
      sessionId: 's1',
      tickId: 's1:0',
      revision: 0,
      participantId: 'player',
      submissionId: 'request-1',
      command: { id: 'Action 1' },
    });
    expect(pollCall?.[0]).toBe('https://example.test/v1/sessions/s1/tick');
  });

  it('preserves stable conflict codes on API errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'expected a newer cursor',
      code: 'stale_turn',
    }), { status: 409 })));
    const client = new ArenaClient('https://example.test');
    await expect(client.getTickEnvelope('s1')).rejects.toMatchObject({
      status: 409,
      code: 'stale_turn',
    });
  });

  it('injects fetch, encodes path segments, and preserves non-JSON error bodies', async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response('upstream unavailable', { status: 502, statusText: 'Bad Gateway' });
    });
    const client = new ArenaClient('https://example.test', undefined, {
      fetch: request,
      timeoutMs: 1_000,
    });
    await expect(client.getTickEnvelope('room/with space')).rejects.toMatchObject({
      status: 502,
      error: 'upstream unavailable',
      responseBody: 'upstream unavailable',
    });
    expect(request.mock.calls[0]?.[0]).toBe(
      'https://example.test/v1/sessions/room%2Fwith%20space/tick',
    );
  });

  it('applies a default request timeout and lets zero explicitly disable it', async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      new Response(JSON.stringify(tickEnvelope('s1', 0, OBSERVATION))));
    await new ArenaClient('https://example.test', undefined, { fetch: request })
      .getTickEnvelope('s1');
    expect(request.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

    await new ArenaClient('https://example.test', undefined, { fetch: request, timeoutMs: 0 })
      .getTickEnvelope('s1');
    expect(request.mock.calls[1]?.[1]?.signal).toBeUndefined();
  });

  it('supports per-call cancellation and caps response bodies', async () => {
    const request = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => (
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      })
    ));
    const controller = new AbortController();
    const pending = new ArenaClient('https://example.test', undefined, {
      fetch: request,
      timeoutMs: 0,
    }).getTickEnvelope('s1', { signal: controller.signal });
    controller.abort(new Error('caller canceled'));
    await expect(pending).rejects.toThrow('caller canceled');

    const oversized = new ArenaClient('https://example.test', undefined, {
      fetch: async () => new Response('12345'),
      maxResponseBytes: 4,
    });
    await expect(oversized.getTickEnvelope('s1')).rejects.toThrow(/exceeds 4 bytes/);

    const oversizedError = new ArenaClient('https://example.test', undefined, {
      fetch: async () => new Response('12345', { status: 502 }),
      maxResponseBytes: 4,
    });
    await expect(oversizedError.getTickEnvelope('s1')).rejects.toMatchObject({
      status: 502,
      error: 'HTTP response exceeds 4 bytes',
    });
  });

  it('strictly validates Arena room metadata before remembering its cursor', async () => {
    const valid = {
      matchId: 'm1', sessionId: 'm1', status: 'active', participantId: 'north',
      readyDeadline: 120_000, tickDeadline: 30_000, expiresAt: null, outcome: null,
      participants: [
        { participantId: 'north', claimed: true, connected: true, reconnectDeadline: null },
      ],
      tick: tickEnvelope('m1', 0, OBSERVATION),
    };
    for (const invalid of [
      { ...valid, status: 'unknown' },
      { ...valid, readyDeadline: Number.NaN },
      { ...valid, participants: [{ participantId: 'north', claimed: 'yes', connected: true, reconnectDeadline: null }] },
      { ...valid, participantId: 'south' },
      { ...valid, outcome: { winner: 'north', loser: null, reason: 'timeout' } },
      { ...valid, outcome: { winner: 'south', loser: null, reason: 'game' } },
    ]) {
      const client = new ArenaClient('https://example.test', undefined, {
        fetch: async () => new Response(JSON.stringify(invalid)),
      });
      await expect(client.getArenaRoom('m1')).rejects.toThrow(/room fields/);
      expect(client.getSessionBinding('m1')).toBeUndefined();
    }
  });

  it('exposes the structured active ticket from a matchmaking conflict', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'profile already has an active Arena ticket',
      queueId: 'global.open',
      ticket: {
        ticketId: 'prior_request', state: 'matching', joinedAt: 1, expiresAt: 10_000,
        mapId: 'arena-s1-1', teamId: 'playerbot-mica',
        matchId: '11111111-1111-4111-8111-111111111111', participantId: 'north',
      },
    }), { status: 409 })));

    const client = new ArenaClient('https://example.test', 'ak_player');
    await expect(client.joinArenaQueue({
      mapId: 'arena-s1-1', teamId: 'playerbot-mica', requestId: 'new_request',
    })).rejects.toMatchObject({
      status: 409,
      ticket: {
        queueId: 'global.open', ticketId: 'prior_request', state: 'matching',
        matchId: '11111111-1111-4111-8111-111111111111', participantId: 'north',
      },
    });
  });

  it('discovers hosted Arena maps and game-owned team presets', async () => {
    const catalog = {
      maps: [{ id: 'arena-s1-1', gameId: 'arena', version: 1, name: 'Arena Exhibition' }],
      teams: [{
        id: 'playerbot-mica', name: 'Playerbot + MICA',
        members: [{ id: 'playerbot', characterId: 'playerbot', control: 'direct' }],
      }],
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify(catalog)));
    vi.stubGlobal('fetch', fetchMock);

    await expect(new ArenaClient('https://example.test').arenaCatalog()).resolves.toEqual(catalog);
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://example.test/v1/arena/maps');
  });

  it('polls matchmaking, plays one simultaneous tick, manages presence, and trusts room outcomes', async () => {
    const window = createIntentWindow('m1', 0, ['north', 'south']);
    window.intents.north = {
      participantId: 'north', submissionId: 'north-0', command: { id: 'Action 1' },
    };
    const resolvedTurn = tickEnvelope('m1', 1, { ...OBSERVATION, tickNumber: 1 });
    const activeRoom = {
      matchId: 'm1', sessionId: 'm1', status: 'active', participantId: 'north',
      readyDeadline: 120_000, tickDeadline: 30_000, expiresAt: null, outcome: null,
      participants: [
        { participantId: 'north', claimed: true, connected: true, reconnectDeadline: null },
        { participantId: 'south', claimed: true, connected: true, reconnectDeadline: null },
      ],
      tick: tickEnvelope('m1', 0, OBSERVATION),
    };
    const disconnectedRoom = {
      ...activeRoom,
      participants: [
        { participantId: 'north', claimed: true, connected: false, reconnectDeadline: 20_000 },
        { participantId: 'south', claimed: true, connected: true, reconnectDeadline: null },
      ],
      tick: resolvedTurn,
    };
    const completedRoom = {
      ...disconnectedRoom,
      status: 'completed',
      outcome: { winner: 'north', loser: 'south', reason: 'disconnect' },
      // Disconnect policy can finish the room while its last game tick is live.
      tick: resolvedTurn,
    };
    const responses = [
      new Response(JSON.stringify({
        queueId: 'global.open', ticketId: 'request_1', state: 'waiting',
        joinedAt: 0, expiresAt: 1, mapId: 'arena-s1-1', teamId: 'playerbot-mica',
        matchId: null, participantId: null,
      }), { status: 202 }),
      new Response(JSON.stringify({
        queueId: 'global.open', ticketId: 'request_1', state: 'matched',
        joinedAt: 0, expiresAt: 1, mapId: 'arena-s1-1', teamId: 'playerbot-mica',
        matchId: 'm1', participantId: 'north',
      })),
      new Response(JSON.stringify(activeRoom)),
      new Response(JSON.stringify(pendingEnvelope(window, OBSERVATION, 'north')), { status: 202 }),
      new Response(JSON.stringify(resolvedTurn)),
      new Response(JSON.stringify({ ...activeRoom, tick: resolvedTurn })),
      new Response(JSON.stringify(disconnectedRoom)),
      new Response(JSON.stringify(completedRoom)),
    ];
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return responses.shift()!;
    }));

    const client = new ArenaClient('https://example.test', 'ak_player');
    await client.joinArenaQueue({
      mapId: 'arena-s1-1', teamId: 'playerbot-mica', requestId: 'request_1',
    });
    const ticket = await client.arenaQueueTicket('global.open', 'request_1');
    expect(ticket).toMatchObject({ state: 'matched', matchId: 'm1', participantId: 'north' });
    await client.connectArenaMatch('m1');
    const pending = await client.submitArenaIntent('m1', { id: 'Action 1' }, {
      submissionId: 'north-0',
    });
    expect(pending.kind).toBe('pending');
    const resolved = await client.getArenaTickEnvelope('m1');
    expect(resolved).toMatchObject({ kind: 'tick', revision: 1 });
    await client.heartbeatArenaMatch('m1');
    const disconnected = await client.disconnectArenaMatch('m1');
    expect(disconnected.participants[0]).toMatchObject({ connected: false, reconnectDeadline: 20_000 });
    const completed = await client.getArenaRoom('m1');
    expect(completed.outcome).toMatchObject({ winner: 'north', reason: 'disconnect' });
    expect(completed.tick.tick.status).toBe('playing');

    expect(calls.map(([url]) => url)).toEqual([
      'https://example.test/v1/arena/matchmaking',
      'https://example.test/v1/arena/matchmaking/global.open/request_1',
      'https://example.test/v1/arena/matches/m1/presence',
      'https://example.test/v1/arena/matches/m1/actions',
      'https://example.test/v1/arena/matches/m1/tick',
      'https://example.test/v1/arena/matches/m1/presence',
      'https://example.test/v1/arena/matches/m1/presence',
      'https://example.test/v1/arena/matches/m1',
    ]);
    expect(JSON.parse(String(calls[3]![1]!.body))).toMatchObject({
      sessionId: 'm1', participantId: 'north', tickId: 'm1:0', revision: 0,
      submissionId: 'north-0', command: { id: 'Action 1' },
      extensions: { 'agilabs.arena': { controlRevision: 0 } },
    });
    expect(JSON.parse(String(calls[0]![1]!.body))).toEqual({
      mapId: 'arena-s1-1', teamId: 'playerbot-mica', requestId: 'request_1',
    });
    expect(JSON.parse(String(calls[2]![1]!.body))).toEqual({ connected: true });
    expect(JSON.parse(String(calls[5]![1]!.body))).toEqual({ connected: true });
    expect(JSON.parse(String(calls[6]![1]!.body))).toEqual({ connected: false });
    for (const [, init] of calls) {
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer ak_player');
    }
  });

  it('cancels a waiting matchmaking ticket', async () => {
    const waiting = {
      queueId: 'global.open', ticketId: 'request_2', state: 'waiting',
      joinedAt: 0, expiresAt: 1, mapId: 'arena-s1-1', teamId: 'fixer-overseer',
      matchId: null, participantId: null,
    };
    const responses = [
      new Response(JSON.stringify(waiting), { status: 202 }),
      new Response(JSON.stringify({ ...waiting, state: 'cancelled' })),
    ];
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return responses.shift()!;
    }));

    const client = new ArenaClient('https://example.test', 'ak_player');
    await client.joinArenaQueue({
      mapId: 'arena-s1-1', teamId: 'fixer-overseer', requestId: 'request_2',
    });
    await expect(client.cancelArenaQueueTicket('global.open', 'request_2'))
      .resolves.toMatchObject({ state: 'cancelled' });
    expect(calls[1]).toMatchObject([
      'https://example.test/v1/arena/matchmaking/global.open/request_2',
      { method: 'DELETE' },
    ]);
  });

  it('recovers the authenticated seat after polling a tick before the room', async () => {
    const tick = tickEnvelope('m1', 0, OBSERVATION);
    const room = {
      matchId: 'm1', sessionId: 'm1', status: 'active', participantId: 'south',
      readyDeadline: 120_000, tickDeadline: 30_000, expiresAt: null, outcome: null,
      participants: [
        { participantId: 'north', claimed: true, connected: true, reconnectDeadline: null },
        { participantId: 'south', claimed: true, connected: true, reconnectDeadline: null },
      ],
      tick,
    };
    const window = createIntentWindow('m1', 0, ['north', 'south']);
    window.intents.south = {
      participantId: 'south', submissionId: 'south-0', command: { id: 'Action 8' },
    };
    const responses = [
      new Response(JSON.stringify(tick)),
      new Response(JSON.stringify(room)),
      new Response(JSON.stringify(pendingEnvelope(window, OBSERVATION, 'south')), { status: 202 }),
    ];
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return responses.shift()!;
    }));

    const client = new ArenaClient('https://example.test', 'ak_player');
    await client.getArenaTickEnvelope('m1');
    await client.submitArenaIntent('m1', { id: 'Action 8' }, { submissionId: 'south-0' });

    expect(calls.map(([url]) => url)).toEqual([
      'https://example.test/v1/arena/matches/m1/tick',
      'https://example.test/v1/arena/matches/m1',
      'https://example.test/v1/arena/matches/m1/actions',
    ]);
    expect(JSON.parse(String(calls[2]![1]!.body))).toMatchObject({ participantId: 'south' });
  });

  it('tracks same-world Arena control substeps and generates a fresh retry key for each', async () => {
    const activeRoom = {
      matchId: 'm1', sessionId: 'm1', status: 'active', participantId: 'north',
      readyDeadline: 120_000, tickDeadline: 30_000, expiresAt: null, outcome: null,
      participants: [
        { participantId: 'north', claimed: true, connected: true, reconnectDeadline: null },
        { participantId: 'south', claimed: true, connected: true, reconnectDeadline: null },
      ],
      tick: tickEnvelope('m1', 0, OBSERVATION),
    };
    const responses = [
      new Response(JSON.stringify(activeRoom)),
      new Response(JSON.stringify(tickEnvelope('m1', 0, { ...OBSERVATION, controlRevision: 1 }))),
      new Response(JSON.stringify(tickEnvelope('m1', 0, { ...OBSERVATION, controlRevision: 2 }))),
    ];
    const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push([input, init]);
      return responses.shift()!;
    }));

    const client = new ArenaClient('https://example.test', 'ak_player');
    await client.connectArenaMatch('m1');
    await client.submitArenaIntent('m1', { id: 'Action 6' });
    await client.submitArenaIntent('m1', { id: 'Action 7', index: 0 });

    expect(JSON.parse(String(calls[1]![1]!.body))).toMatchObject({
      tickId: 'm1:0', revision: 0,
      submissionId: 'north:m1:0:control:0',
      extensions: { 'agilabs.arena': { controlRevision: 0 } },
    });
    expect(JSON.parse(String(calls[2]![1]!.body))).toMatchObject({
      tickId: 'm1:0', revision: 0,
      submissionId: 'north:m1:0:control:1',
      extensions: { 'agilabs.arena': { controlRevision: 1 } },
    });
  });

  it('persists and restores the original binding for an exact retry', async () => {
    const calls: RequestInit[] = [];
    const request = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init!);
      return new Response(JSON.stringify(tickEnvelope('s1', 1, { ...OBSERVATION, tickNumber: 1 })));
    });
    const client = new ArenaClient('https://example.test', undefined, { fetch: request });
    const restored = client.restoreSessionBinding({
      protocol: 'agilabs.ticks', protocolVersion: '1.0',
      sessionId: 's1', tickId: 's1:0', revision: 0, participantId: 'player',
    });
    expect(client.getSessionBinding('s1')).toEqual(restored);
    await client.submitIntent('s1', { id: 'Action 1' }, { submissionId: 'retry-revision-0' });
    expect(JSON.parse(String(calls[0]!.body))).toMatchObject({
      tickId: 's1:0', revision: 0, submissionId: 'retry-revision-0',
    });
    expect(() => client.restoreSessionBinding({ ...restored, revision: -1 })).toThrow('binding');
  });

  it('restored Arena bindings override an observed cursor for explicit retries', async () => {
    const calls: RequestInit[] = [];
    const responses = [
      new Response(JSON.stringify(tickEnvelope('m1', 5, { ...OBSERVATION, controlRevision: 5 }))),
      new Response(JSON.stringify(tickEnvelope('m1', 1, { ...OBSERVATION, controlRevision: 1 }))),
    ];
    const client = new ArenaClient('https://example.test', undefined, {
      fetch: vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(init!);
        return responses.shift()!;
      }),
    });
    await client.getArenaTickEnvelope('m1');
    client.restoreSessionBinding({
      protocol: 'agilabs.ticks', protocolVersion: '1.0',
      sessionId: 'm1', tickId: 'm1:0', revision: 0,
      participantId: 'north', controlRevision: 0,
    });
    await client.submitArenaIntent('m1', { id: 'Action 1' }, { submissionId: 'retry-0' });

    expect(JSON.parse(String(calls[1]!.body))).toMatchObject({
      tickId: 'm1:0', revision: 0, submissionId: 'retry-0',
      extensions: { 'agilabs.arena': { controlRevision: 0 } },
    });
  });

  it('does not borrow a newer control revision for an explicit Arena cursor', async () => {
    const request = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(JSON.stringify(
      tickEnvelope('m1', 1, { ...OBSERVATION, controlRevision: 1 }),
    )));
    const client = new ArenaClient('https://example.test', undefined, { fetch: request });
    client.restoreSessionBinding({
      protocol: 'agilabs.ticks', protocolVersion: '1.0',
      sessionId: 'm1', tickId: 'm1:5', revision: 5,
      participantId: 'north', controlRevision: 5,
    });

    await expect(client.submitArenaIntent('m1', { id: 'Action 1' }, {
      submissionId: 'retry-0', cursor: { tickId: 'm1:0', revision: 0 },
    })).rejects.toThrow(/controlRevision unavailable/);
    expect(request).not.toHaveBeenCalled();

    await client.submitArenaIntent('m1', { id: 'Action 1' }, {
      submissionId: 'retry-0',
      cursor: { tickId: 'm1:0', revision: 0, controlRevision: 0 },
    });
    expect(JSON.parse(String(request.mock.calls[0]![1]!.body))).toMatchObject({
      tickId: 'm1:0', revision: 0,
      extensions: { 'agilabs.arena': { controlRevision: 0 } },
    });
  });

  it('does not fetch a newer cursor for an ambiguous explicit retry key', async () => {
    const request = vi.fn(async () => new Response(JSON.stringify(tickEnvelope('s1', 1, OBSERVATION))));
    const client = new ArenaClient('https://example.test', undefined, { fetch: request });
    await expect(client.submitIntent('s1', { id: 'Action 1' }, {
      submissionId: 'retry-revision-0',
    })).rejects.toThrow('original cursor');
    expect(request).not.toHaveBeenCalled();
  });

  it('lets shared cancellation interrupt asynchronous authentication', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => new Response('{}'));
    const client = new ArenaClient('https://example.test', () => new Promise(() => {}), {
      fetch: request, signal: controller.signal,
    });
    const pending = client.arenaCatalog();
    controller.abort(new Error('auth canceled'));
    await expect(pending).rejects.toThrow('auth canceled');
    expect(request).not.toHaveBeenCalled();
  });
});
