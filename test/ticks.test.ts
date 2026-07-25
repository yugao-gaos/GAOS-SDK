import { describe, expect, it } from 'vitest';
import {
  advanceTick,
  createTickRate,
  elapsedMillisecondsAtTick,
  tickAtElapsedMilliseconds,
  type ActionReducer,
  type TickReducer,
  type TickView,
} from '../src/engine/index.js';
import {
  makeTickId,
  resolveGameTick,
  tickEnvelope,
} from '../src/protocol.js';

describe('tick-based engine contracts', () => {
  it('models a 30 ticks-per-second fixed cadence without owning a scheduler', () => {
    const rate = createTickRate(30);
    expect(rate).toEqual({
      ticksPerSecond: 30,
      secondsPerTick: 1 / 30,
      millisecondsPerTick: 1000 / 30,
    });
    expect(tickAtElapsedMilliseconds(0, rate)).toBe(0);
    expect(tickAtElapsedMilliseconds(999, rate)).toBe(29);
    expect(tickAtElapsedMilliseconds(1000, rate)).toBe(30);
    expect(elapsedMillisecondsAtTick(30, rate)).toBe(1000);
  });

  it('rejects invalid rates, elapsed times, and tick indexes', () => {
    expect(() => createTickRate(0)).toThrow('ticksPerSecond');
    expect(() => createTickRate(Number.POSITIVE_INFINITY)).toThrow('ticksPerSecond');
    expect(() => tickAtElapsedMilliseconds(-1, createTickRate(30))).toThrow(
      'elapsedMilliseconds',
    );
    expect(() => elapsedMillisecondsAtTick(0.5, createTickRate(30))).toThrow('tick');
  });

  it('supports canonical tick reducers and action-at-a-time compatibility reducers', () => {
    interface State { tick: number }
    const reducer: TickReducer<null, State> = {
      init: () => ({ tick: 0 }),
      advance: (state) => ({ tick: state.tick + 1 }),
      view: (state): TickView => ({
        actions: [{ id: 'advance', params: 'none' }],
        status: 'playing',
        hud: { actionsUsed: state.tick },
      }),
    };
    expect(advanceTick(reducer, reducer.init(null, 1), [])).toEqual({ tick: 1 });
    const legacy: ActionReducer<null, State> = {
      init: reducer.init,
      apply: (state) => ({ tick: state.tick + 1 }),
      view: reducer.view,
    };
    expect(legacy.apply(legacy.init(null, 1), { id: 'advance' })).toEqual({ tick: 1 });
  });

  it('uses a tick-native wire format', () => {
    expect(makeTickId('session', 4)).toBe('session:4');
    expect(tickEnvelope('session', 4, { x: 1 })).toEqual({
      protocol: 'agilabs.ticks',
      protocolVersion: '1.0',
      kind: 'tick',
      sessionId: 'session',
      tickId: 'session:4',
      revision: 4,
      tick: { x: 1 },
    });
  });

  it('resolves canonical tick adapters', () => {
    const intents = [{ participantId: 'p1', submissionId: 's1', command: 2 }];
    expect(resolveGameTick(
      { resolveTick: (state: number, values) => state + values[0]!.command },
      3,
      intents,
    )).toBe(5);
  });
});
