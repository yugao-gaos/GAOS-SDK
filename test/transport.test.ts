import { describe, expect, it } from 'vitest';
import {
  buildLinkedComponentSources,
  proposeDirectedTransport,
  resolveInterlock,
  resolveTransportRun,
  type Cell,
} from '../src/engine/index.js';

const key = ([x, y]: Cell): string => `${x},${y}`;

describe('directed transport', () => {
  it('proposes movement only for occupants on active enterable cells', () => {
    const directions = new Map([['1,1', [1, 0] as Cell], ['2,1', [0, 1] as Cell]]);
    const movers = proposeDirectedTransport([
      { id: 'active', at: [1, 1], priority: 0 },
      { id: 'off', at: [2, 1], priority: 1 },
      { id: 'floor', at: [3, 1], priority: 2 },
    ], {
      directionAt: (cell) => directions.get(key(cell)),
      activeAt: (cell) => key(cell) !== '2,1',
      canEnter: (_occupant, destination) => destination[0] < 4,
    });

    expect(movers).toEqual([{
      id: 'active', from: [1, 1], to: [2, 1], priority: 0,
    }]);
  });

  it('runs a complete transport line in multiple same-tick passes', () => {
    const state = { x: 0 };
    const result = resolveTransportRun(state, {
      maxPasses: 4,
      step: (world) => {
        if (world.x >= 3) return 0;
        world.x += 1;
        return 1;
      },
    });

    expect(result).toEqual({ state: { x: 3 }, passes: 3, moves: 3, completed: true });
  });

  it('requires at least one authored pass', () => {
    expect(() => resolveTransportRun({}, { maxPasses: 0, step: () => 0 }))
      .toThrow(/positive/);
  });

  it('rejects invalid step counts and unsafe cumulative totals', () => {
    for (const moved of [Number.NaN, -1, 0.5]) {
      expect(() => resolveTransportRun({}, { maxPasses: 1, step: () => moved }))
        .toThrow(/non-negative safe integer/);
    }

    let pass = 0;
    expect(() => resolveTransportRun({}, {
      maxPasses: 2,
      step: () => [Number.MAX_SAFE_INTEGER, 1][pass++]!,
    })).toThrow(/cumulative/);
  });
});

describe('linked components and interlocks', () => {
  it('fans every incoming source across its connected target component', () => {
    const members = new Set(['1,1', '2,1', '3,1', '8,1']);
    const sources = buildLinkedComponentSources([
      { source: 'switch', target: [2, 1] as Cell },
      { source: 'plug', target: [3, 1] as Cell },
    ], {
      key,
      member: (cell) => members.has(key(cell)),
      neighbors: ([x, y]) => [[x - 1, y], [x + 1, y]] as Cell[],
      sourceKey: (source) => source,
    });

    expect([...sources]).toEqual([
      ['2,1', ['switch', 'plug']],
      ['3,1', ['switch', 'plug']],
      ['1,1', ['switch', 'plug']],
    ]);
    expect(sources.has('8,1')).toBe(false);
  });

  it('repeats settlement only while linked state changes', () => {
    const state = { settled: 0, updates: 0 };
    const result = resolveInterlock(state, {
      maxCycles: 4,
      settle: (world) => { world.settled += 1; },
      update: (world) => {
        world.updates += 1;
        return world.updates < 3;
      },
    });

    expect(result).toEqual({
      state: { settled: 3, updates: 3 }, cycles: 3, stabilized: true,
    });
  });
});
