import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  IntentCollectionError,
  GameRegistry,
  canonicalJson,
  collectIntent,
  createIntentWindow,
  createParticipationIntentWindow,
  pendingEnvelope,
  tickEnvelope,
  type CommandSubmission,
} from '../src/protocol.js';

const submit = (
  participantId: string,
  command: unknown,
  revision = 0,
): CommandSubmission => ({
  protocol: PROTOCOL_ID,
  protocolVersion: PROTOCOL_VERSION,
  sessionId: 's1',
  tickId: `s1:${revision}`,
  revision,
  participantId,
  submissionId: `${participantId}-${revision}`,
  command,
});

describe('v1 simultaneous intent collection', () => {
  it('returns pending for the first intent and ready for the second', () => {
    const initial = createIntentWindow('s1', 0, ['bravo', 'alpha']);
    const first = collectIntent(initial, submit('bravo', { move: 2 }));
    expect(first.status).toBe('pending');
    if (first.status !== 'pending') throw new Error('expected pending');
    expect(first.submittedParticipants).toEqual(['bravo']);
    expect(first.awaitingParticipants).toEqual(['alpha']);
    const pending = pendingEnvelope(first.window, { board: 'same' }, 'bravo');
    expect(pending).toMatchObject({
      kind: 'pending',
      revision: 0,
      submittedParticipants: ['bravo'],
      awaitingParticipants: ['alpha'],
    });
    expect(pending).not.toHaveProperty('intents');
    expect(JSON.stringify(pending)).not.toContain('bravo-0');
    expect(JSON.stringify(pending)).not.toContain('"move"');

    const second = collectIntent(first.window, submit('alpha', { move: 1 }));
    expect(second.status).toBe('ready');
    if (second.status !== 'ready') throw new Error('expected ready');
    expect(second.intents).toEqual([
      { participantId: 'alpha', submissionId: 'alpha-0', command: { move: 1 } },
      { participantId: 'bravo', submissionId: 'bravo-0', command: { move: 2 } },
    ]);
  });

  it('orders resolution by participant id, independent of arrival order', () => {
    const resolve = (arrival: string[]): string => {
      let result = createIntentWindow<string>('s1', 0, ['bravo', 'alpha']);
      let ordered: string[] = [];
      for (const id of arrival) {
        const collected = collectIntent(result, submit(id, id) as CommandSubmission<string>);
        result = collected.window;
        if (collected.status === 'ready') ordered = collected.intents.map((i) => i.command);
      }
      return ordered.join(',');
    };
    expect(resolve(['alpha', 'bravo'])).toBe('alpha,bravo');
    expect(resolve(['bravo', 'alpha'])).toBe('alpha,bravo');
  });

  it('makes exact retries idempotent and rejects conflicting or stale intents', () => {
    const initial = createIntentWindow('s1', 0, ['alpha', 'bravo']);
    const first = collectIntent(initial, submit('alpha', { move: 1 }));
    expect(collectIntent(first.window, submit('alpha', { move: 1 }))).toMatchObject({
      status: 'pending',
      window: first.window,
    });
    expect(() => collectIntent(first.window, submit('alpha', { move: 2 }))).toThrowError(
      expect.objectContaining<Partial<IntentCollectionError>>({ code: 'conflicting_intent' }),
    );
    expect(() => collectIntent(first.window, submit('bravo', { move: 2 }, 1))).toThrowError(
      expect.objectContaining<Partial<IntentCollectionError>>({ code: 'stale_tick' }),
    );
  });

  it('accepts reordered plain JSON but rejects lossy or recursive commands', () => {
    const initial = createIntentWindow('s1', 0, ['alpha', 'bravo']);
    const first = collectIntent(initial, submit('alpha', { z: 1, nested: { b: 2, a: 3 } }));
    expect(collectIntent(first.window, submit('alpha', { nested: { a: 3, b: 2 }, z: 1 })))
      .toMatchObject({ status: 'pending' });
    expect(() => collectIntent(initial, submit('alpha', Number.NaN))).toThrowError(
      expect.objectContaining<Partial<IntentCollectionError>>({ code: 'invalid_submission' }),
    );
    expect(() => collectIntent(
      initial,
      submit('alpha', Number.MAX_SAFE_INTEGER + 1),
    )).toThrowError(
      expect.objectContaining<Partial<IntentCollectionError>>({ code: 'invalid_submission' }),
    );
    expect(() => collectIntent(initial, submit('alpha', 1e20))).toThrowError(
      expect.objectContaining<Partial<IntentCollectionError>>({ code: 'invalid_submission' }),
    );
    expect(() => collectIntent(initial, submit('alpha', '\ud800'))).toThrowError(
      expect.objectContaining<Partial<IntentCollectionError>>({ code: 'invalid_submission' }),
    );
    expect(() => collectIntent(initial, submit('alpha', BigInt(1)))).toThrowError(
      expect.objectContaining<Partial<IntentCollectionError>>({ code: 'invalid_submission' }),
    );
    expect(() => collectIntent(initial, submit('alpha', { missing: undefined }))).toThrowError(
      expect.objectContaining<Partial<IntentCollectionError>>({ code: 'invalid_submission' }),
    );
    expect(() => collectIntent(initial, submit('alpha', () => 1))).toThrowError(
      expect.objectContaining<Partial<IntentCollectionError>>({ code: 'invalid_submission' }),
    );
    expect(() => collectIntent(initial, submit('alpha', Symbol('bad')))).toThrowError(
      expect.objectContaining<Partial<IntentCollectionError>>({ code: 'invalid_submission' }),
    );
    expect(() => collectIntent(initial, submit('alpha', new Date()))).toThrowError(
      expect.objectContaining<Partial<IntentCollectionError>>({ code: 'invalid_submission' }),
    );
    const sparse = Array(1);
    expect(() => collectIntent(initial, submit('alpha', sparse))).toThrowError(
      expect.objectContaining<Partial<IntentCollectionError>>({ code: 'invalid_submission' }),
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => collectIntent(initial, submit('alpha', cyclic))).toThrowError(
      expect.objectContaining<Partial<IntentCollectionError>>({ code: 'invalid_submission' }),
    );
    expect(canonicalJson({ '\ue000': 2, '😀': 1 })).toBe('{"":2,"😀":1}');
    expect(() => canonicalJson({ '\ud800': true })).toThrow(/unpaired surrogates/);
  });

  it('treats hostile object-property participant ids as ordinary seats', () => {
    const initial = createIntentWindow('s1', 0, ['constructor', '__proto__']);
    const first = collectIntent(initial, submit('constructor', { move: 1 }));
    expect(first.status).toBe('pending');
    if (first.status !== 'pending') throw new Error('expected pending');
    expect(first.submittedParticipants).toEqual(['constructor']);
    const ready = collectIntent(first.window, submit('__proto__', { move: 2 }));
    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') throw new Error('expected ready');
    expect(ready.intents.map((intent) => intent.participantId)).toEqual(['__proto__', 'constructor']);
  });

  it('rejects invalid cursor and participant values at construction', () => {
    expect(() => createIntentWindow('', 0, ['player'])).toThrow('sessionId');
    expect(() => createIntentWindow('s1', -1, ['player'])).toThrow('revision');
    expect(() => createIntentWindow('s1', 0.5, ['player'])).toThrow('revision');
    expect(() => createIntentWindow('s1', 0, [''])).toThrow('participant ids');
    expect(() => createIntentWindow('s1', 0, [' north '])).toThrow('participant ids');
    expect(() => createIntentWindow('s1', 0, ['北'])).toThrow('participant ids');
    expect(() => createIntentWindow('s1', 0, ['player\n'])).toThrow('participant ids');
    expect(() => createIntentWindow('s1', 0, [1 as unknown as string])).toThrow(
      'participant ids',
    );
  });

  it('produces stable resolved envelope metadata without constraining observation shape', () => {
    expect(tickEnvelope('s1', 3, { hand: ['A', 'K'], custom: { phase: 'bid' } })).toEqual({
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      kind: 'tick',
      sessionId: 's1',
      tickId: 's1:3',
      revision: 3,
      tick: { hand: ['A', 'K'], custom: { phase: 'bid' } },
    });
  });

  it('maps sequential and simultaneous participation to compatible intent windows', () => {
    expect(createParticipationIntentWindow('s1', 2, {
      mode: 'sequential',
      activeSeat: 'north',
    }).participants).toEqual(['north']);
    expect(createParticipationIntentWindow('s1', 2, {
      mode: 'simultaneous',
      seats: ['south', 'north'],
    }).participants).toEqual(['north', 'south']);
    expect(() => createParticipationIntentWindow('s1', 2, {
      mode: 'sequential',
      activeSeat: 'north seat',
    })).toThrow('participant ids');
  });

  it('registers externally supplied games by stable id and version', () => {
    const registry = new GameRegistry();
    const game = {
      id: 'cards.high-card',
      version: '1.0.0',
      create: () => ({ score: 0 }),
      participants: () => ['north', 'south'],
      observe: (state: { score: number }) => ({ score: state.score }),
      legalCommands: () => [{ id: 'play', input: { type: 'integer' } }],
      isCommandLegal: (_state: { score: number }, _participantId: string, command: number) => (
        Number.isInteger(command) && command >= 0
      ),
      resolveTick: (state: { score: number }, intents: readonly { command: number }[]) => ({
        score: state.score + intents.reduce((sum, intent) => sum + intent.command, 0),
      }),
    };
    registry.register(game);
    expect(registry.get('cards.high-card', '1.0.0')).toBe(game);
    expect(game.isCommandLegal({ score: 0 }, 'north', 2)).toBe(true);
    expect(game.isCommandLegal({ score: 0 }, 'north', -1)).toBe(false);
    expect(() => registry.register(game)).toThrow('game already registered');

    const next = { ...game, version: '1.1.0' };
    registry.register(next);
    expect(registry.get('cards.high-card', '1.1.0')).toBe(next);
    expect(registry.get('cards.high-card', '2.0.0')).toBeUndefined();

    const atInId = { ...game, id: 'cards@high', version: '1' };
    const atInVersion = { ...game, id: 'cards', version: 'high@1' };
    registry.register(atInId);
    registry.register(atInVersion);
    expect(registry.get('cards@high', '1')).toBe(atInId);
    expect(registry.get('cards', 'high@1')).toBe(atInVersion);
  });
});
