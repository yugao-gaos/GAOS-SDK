import { describe, expect, it } from 'vitest';
import {
  enumerateGridActions,
  recheckGridTranscript,
  runLevelSeed,
  solveGridLevel,
  type ActionReducer,
  type TickView,
} from '../src/engine/index.js';

interface Level { goal: number }
interface State { at: number; actionsUsed: number }

const reducer: ActionReducer<Level, State> = {
  init: () => ({ at: 0, actionsUsed: 0 }),
  apply: (state, action) => {
    if (action.id === 'Action 1') {
      return { at: state.at + 1, actionsUsed: state.actionsUsed + 1 };
    }
    if (action.id === 'Action 2' && action.index !== undefined) {
      return { at: state.at + action.index, actionsUsed: state.actionsUsed + 1 };
    }
    throw new Error('illegal action');
  },
  view: (state): TickView => ({
    actions: [
      { id: 'Action 1', params: 'none' },
      { id: 'Action 2', params: 'index' },
    ],
    status: state.at >= 3 ? 'won' : 'playing',
    ...(state.at >= 3 ? { stars: 3 } : {}),
    hud: { actionsUsed: state.actionsUsed, items: [{ index: 2 }] },
  }),
};

describe('generic grid solver', () => {
  it('finds a shortest reducer-valid action sequence', () => {
    expect(solveGridLevel(reducer, { goal: 3 }, { maxActions: 4 })).toEqual({
      min: 2,
      capped: false,
      explored: 3,
      actions: [
        { id: 'Action 1' },
        { id: 'Action 2', index: 2 },
      ],
    });
  });

  it('reports an exhausted search bound', () => {
    const result = solveGridLevel(reducer, { goal: 3 }, { maxActions: 1 });
    expect(result).toMatchObject({ min: null, capped: false });
  });

  it('returns a zero-length solution when the initial state is already won', () => {
    const won: ActionReducer<Level, State> = {
      ...reducer,
      init: () => ({ at: 3, actionsUsed: 0 }),
    };
    expect(solveGridLevel(won, { goal: 3 }, { maxActions: 0 })).toEqual({
      min: 0, capped: false, explored: 1, actions: [],
    });
  });

  it('does not expand an ended state even if its view advertises actions', () => {
    const ended: ActionReducer<Level, State> = {
      ...reducer,
      init: () => ({ at: 0, actionsUsed: 0 }),
      view: (state) => ({
        ...reducer.view(state),
        status: 'ended',
      }),
    };
    expect(solveGridLevel(ended, { goal: 3 }, { maxActions: 4 })).toEqual({
      min: null, capped: false, explored: 1, actions: null,
    });
  });

  it('rejects invalid search bounds', () => {
    expect(() => solveGridLevel(reducer, { goal: 3 }, { maxActions: -1 })).toThrow(RangeError);
    expect(() => solveGridLevel(reducer, { goal: 3 }, { maxActions: 1, maxNodes: 0 }))
      .toThrow(RangeError);
  });

  it('keeps action filtering in product policy', () => {
    const withRestart: ActionReducer<Level, State> = {
      ...reducer,
      view: (state) => ({
        ...reducer.view(state),
        actions: [
          ...reducer.view(state).actions,
          { id: 'Action 9', params: 'none' },
        ],
      }),
    };
    expect(enumerateGridActions(withRestart.view({ at: 0, actionsUsed: 0 })))
      .toContainEqual({ id: 'Action 9' });
    expect(solveGridLevel(withRestart, { goal: 3 }, {
      maxActions: 4,
      includeAction: (action) => action.id !== 'Action 9',
    }).min).toBe(2);
  });
});

describe('generic transcript rechecking', () => {
  const header = {
    sessionId: 's1',
    level: { goal: 3 },
    seed: 42,
    perm: [0, 1],
    status: 'won' as const,
    stars: 3,
    actionsUsed: 2,
  };

  it('replays canonical actions and verifies the result', () => {
    expect(recheckGridTranscript(reducer, header, [
      { n: 1, wireId: 'Action 1', canonicalId: 'Action 1' },
      { n: 2, wireId: 'Action 2', canonicalId: 'Action 2', index: 2 },
    ])).toMatchObject({ ok: true, problems: [] });
  });

  it('accepts contiguous zero-based production numbering', () => {
    expect(recheckGridTranscript(reducer, header, [
      { n: 0, wireId: 'Action 1', canonicalId: 'Action 1' },
      { n: 1, wireId: 'Action 2', canonicalId: 'Action 2', index: 2 },
    ])).toMatchObject({ ok: true, problems: [] });
  });

  it('rejects malformed replay metadata without throwing', () => {
    const result = recheckGridTranscript(reducer, { ...header, perm: [0, 0] }, [
      { n: 99, wireId: 'Action 0', canonicalId: 'Action 1', x: Number.NaN },
      { n: 3, wireId: 'Action 2', canonicalId: 'Action 3', index: 2 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/bijection/);
    expect(result.problems.join('\n')).toMatch(/start at 0 or 1/);
    expect(result.problems.join('\n')).toMatch(/safe integer/);
    expect(result.problems.join('\n')).toMatch(/within Action/);
  });

  it('reports a runtime non-array permutation instead of throwing', () => {
    const malformed = {
      ...header,
      perm: null,
    } as unknown as typeof header;
    expect(() => recheckGridTranscript(reducer, malformed, [
      { n: 0, wireId: 'Action 1', canonicalId: 'Action 1' },
    ])).not.toThrow();
    expect(recheckGridTranscript(reducer, malformed, [
      { n: 0, wireId: 'Action 1', canonicalId: 'Action 1' },
    ])).toMatchObject({ ok: false });
    expect(recheckGridTranscript(reducer, malformed, []).problems.join('\n')).toMatch(/bijection/);
  });

  it('reports non-array actions and malformed entries instead of throwing', () => {
    for (const malformed of [null, {}, 'actions']) {
      const result = recheckGridTranscript(
        reducer,
        header,
        malformed as unknown as [],
      );
      expect(result.ok).toBe(false);
    }

    const malformedEntries = [
      null, [], 7, {}, { n: 0, wireId: null, canonicalId: 'Action 1' },
    ] as unknown as [];
    const result = recheckGridTranscript(
      reducer,
      header,
      malformedEntries,
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join('\n')).toMatch(/action at index/);
  });

  it('rejects gaps and actions after terminal state', () => {
    const gap = recheckGridTranscript(reducer, { ...header, actionsUsed: 3 }, [
      { n: 0, wireId: 'Action 1', canonicalId: 'Action 1' },
      { n: 2, wireId: 'Action 1', canonicalId: 'Action 1' },
      { n: 3, wireId: 'Action 1', canonicalId: 'Action 1' },
      { n: 4, wireId: 'Action 1', canonicalId: 'Action 1' },
    ]);
    expect(gap.ok).toBe(false);
    expect(gap.problems.join('\n')).toMatch(/non-contiguous/);
    expect(gap.problems.join('\n')).toMatch(/after terminal/);
  });

  it('detects permutation and outcome discrepancies', () => {
    const result = recheckGridTranscript(reducer, { ...header, actionsUsed: 9 }, [
      { n: 1, wireId: 'Action 2', canonicalId: 'Action 1' },
      { n: 2, wireId: 'Action 2', canonicalId: 'Action 2', index: 2 },
    ]);
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(2);
  });

  it('derives stable, distinct per-level seeds', () => {
    expect(runLevelSeed(99, 0)).toBe(runLevelSeed(99, 0));
    expect(runLevelSeed(99, 0)).not.toBe(runLevelSeed(99, 1));
  });
});
