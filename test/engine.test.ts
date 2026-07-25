import { describe, expect, it } from 'vitest';
import {
  aiActionLimitExceeded,
  budgetFailure,
  resolveMoves,
  roll,
  scoreStars,
  seededPermutation,
  suggestStarThresholds,
  type Cell,
  type Mover,
} from '../src/engine/index.js';

const open = (x: number, y: number): boolean => x <= 0 || y <= 0 || x >= 4 || y >= 4;
const mover = (id: string, from: Cell, to: Cell, priority = 1): Mover => ({
  id,
  from,
  to,
  priority,
});
const at = (result: Map<string, Cell>, id: string): Cell => result.get(id)!;

describe('simultaneous movement', () => {
  it('allows rotations and movement into cells vacated in the same tick', () => {
    const result = resolveMoves([
      mover('a', [1, 1], [2, 1]),
      mover('b', [2, 1], [2, 2]),
      mover('c', [2, 2], [1, 2]),
      mover('d', [1, 2], [1, 1]),
    ], open);
    expect(at(result, 'a')).toEqual([2, 1]);
    expect(at(result, 'b')).toEqual([2, 2]);
    expect(at(result, 'c')).toEqual([1, 2]);
    expect(at(result, 'd')).toEqual([1, 1]);
  });

  it('reverts a blocked movement chain', () => {
    const result = resolveMoves([
      mover('a', [1, 2], [2, 2]),
      mover('b', [2, 2], [3, 2]),
      mover('c', [3, 2], [4, 2]),
    ], open);
    expect(at(result, 'a')).toEqual([1, 2]);
    expect(at(result, 'b')).toEqual([2, 2]);
    expect(at(result, 'c')).toEqual([3, 2]);
  });

  it('uses priority for contested destinations', () => {
    const result = resolveMoves([
      mover('high', [1, 1], [2, 1], 0),
      mover('low', [3, 1], [2, 1], 5),
    ], open);
    expect(at(result, 'high')).toEqual([2, 1]);
    expect(at(result, 'low')).toEqual([3, 1]);
  });

  it('breaks equal-priority ties by stable id regardless of input order', () => {
    const proposals = [
      mover('beta', [1, 1], [2, 1], 3),
      mover('alpha', [3, 1], [2, 1], 3),
    ];
    for (const ordered of [proposals, [...proposals].reverse()]) {
      const result = resolveMoves(ordered, open);
      expect(at(result, 'alpha')).toEqual([2, 1]);
      expect(at(result, 'beta')).toEqual([1, 1]);
    }
  });

  it('resolves blockers and destination contests independently of input order', () => {
    const proposals: Mover[] = [
      mover('a', [0, 0], [0, 0], 0),
      { ...mover('b', [2, 0], [0, 0], 0), footprint: { width: 2, height: 1 } },
      mover('c', [0, 1], [1, 0], 0),
    ];
    const permutations = [
      proposals,
      [proposals[0]!, proposals[2]!, proposals[1]!],
      [proposals[1]!, proposals[0]!, proposals[2]!],
      [proposals[1]!, proposals[2]!, proposals[0]!],
      [proposals[2]!, proposals[0]!, proposals[1]!],
      [proposals[2]!, proposals[1]!, proposals[0]!],
    ];

    for (const ordered of permutations) {
      const result = resolveMoves(ordered, () => false);
      expect([...result.keys()]).toEqual(['a', 'b', 'c']);
      expect(Object.fromEntries(result)).toEqual({
        a: [0, 0], b: [2, 0], c: [1, 0],
      });
    }
  });

  it('rejects malformed or ambiguous mover inputs', () => {
    expect(() => resolveMoves([
      mover('same', [1, 1], [2, 1]),
      mover('same', [3, 1], [2, 1]),
    ], open)).toThrow(/unique/);
    expect(() => resolveMoves([{ ...mover('bad', [1, 1], [2, 1]), priority: NaN }], open))
      .toThrow(/priority/);
    expect(() => resolveMoves([{
      ...mover('bad', [1, 1], [2, 1]), footprint: { width: 0, height: 1 },
    }], open)).toThrow(/footprint/);
  });

  it('blocks head-on swaps unless one mover consents', () => {
    const blocked = resolveMoves([
      mover('a', [1, 1], [2, 1]),
      mover('b', [2, 1], [1, 1]),
    ], open);
    expect(at(blocked, 'a')).toEqual([1, 1]);
    expect(at(blocked, 'b')).toEqual([2, 1]);

    const allowed = resolveMoves([
      { ...mover('a', [1, 1], [2, 1]), swapOk: ['b'] },
      mover('b', [2, 1], [1, 1]),
    ], open);
    expect(at(allowed, 'a')).toEqual([2, 1]);
    expect(at(allowed, 'b')).toEqual([1, 1]);
  });

  it('checks the full footprint against blockers', () => {
    const result = resolveMoves([{
      ...mover('large', [1, 1], [2, 1]),
      footprint: { width: 2, height: 2 },
    }], (x, y) => x === 3 && y === 2);
    expect(at(result, 'large')).toEqual([1, 1]);
  });
});

describe('deterministic randomness', () => {
  it('repeats event-keyed rolls and permutations for the same seed', () => {
    expect(roll(42, 'hit:1')).toBe(roll(42, 'hit:1'));
    expect(seededPermutation(8, 42)).toEqual(seededPermutation(8, 42));
    expect(seededPermutation(8, 42)).not.toEqual(seededPermutation(8, 43));
  });
});

describe('scoring and budgets', () => {
  it('scores against product-supplied thresholds', () => {
    expect(scoreStars(6, { three: 6, two: 9 })).toBe(3);
    expect(scoreStars(7, { three: 6, two: 9 })).toBe(2);
    expect(scoreStars(10, { three: 6, two: 9 })).toBe(1);
  });

  it('checks Energy before ActionBudget', () => {
    expect(budgetFailure({ actionsUsed: 8, maxActions: 8, energyUsed: 4, energyCap: 4 }))
      .toBe('out_of_energy');
    expect(budgetFailure({ actionsUsed: 8, maxActions: 8, energyUsed: 3, energyCap: 4 }))
      .toBe('out_of_action_budget');
    expect(budgetFailure({ actionsUsed: 7, maxActions: 8, energyUsed: 3, energyCap: 4 }))
      .toBeNull();
  });

  it('checks the AI action guardrail independently of resources', () => {
    expect(aiActionLimitExceeded({ actionsUsed: 8, maxActions: 8 })).toBe(true);
    expect(aiActionLimitExceeded({ actionsUsed: 7, maxActions: 8 })).toBe(false);
  });

  it('suggests the existing authored threshold ratios', () => {
    expect(suggestStarThresholds(6)).toEqual({ three: 9, two: 12 });
  });
});
