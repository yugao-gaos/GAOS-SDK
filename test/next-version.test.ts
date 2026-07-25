import { describe, expect, it } from 'vitest';
import {
  createGraphLayout,
  createHexAxialLayout,
  createSquareLayout,
  enumerateActions,
  enumerateGridActions,
  fieldCells,
  lineOfSight,
  locationKey,
  nearestReachablePath,
  recheckGridTranscript,
  recheckTranscript,
  rectFootprint,
  resolveKeyedMoves,
  resolveMoves,
  shortestPath,
  solveGridLevel,
  solveLevel,
  type Cell,
  type ActionDefinition,
  type GridActionDefinition,
  type GridRecheckResult,
  type GridSolveResult,
  type GridSolverOptions,
  type GridSubmittedAction,
  type GridTranscriptAction,
  type GridTranscriptHeader,
  type KeyedMover,
  type Mover,
  type RecheckResult,
  type SolveResult,
  type SolverOptions,
  type SubmittedAction,
  type TranscriptAction,
  type TranscriptHeader,
  type ActionReducer,
  type TickView,
} from '../src/engine/index.js';

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends
  (<T>() => T extends Right ? 1 : 2) ? true : false;
type Assert<T extends true> = T;
type _ActionAlias = Assert<Equal<GridActionDefinition, ActionDefinition>>;
type _SubmittedAlias = Assert<Equal<GridSubmittedAction, SubmittedAction>>;
type _SolveResultAlias = Assert<Equal<GridSolveResult, SolveResult>>;
type _SolverOptionsAlias = Assert<Equal<GridSolverOptions<{ at: number }>, SolverOptions<{ at: number }>>>;
type _RecheckAlias = Assert<Equal<GridRecheckResult, RecheckResult>>;
type _TranscriptActionAlias = Assert<Equal<GridTranscriptAction, TranscriptAction>>;
type _TranscriptHeaderAlias = Assert<Equal<GridTranscriptHeader<null>, TranscriptHeader<null>>>;

describe('v0.13 neutral core', () => {
  interface State {
    at: number;
    actionsUsed: number;
  }

  const reducer: ActionReducer<{ goal: number }, State> = {
    init: () => ({ at: 0, actionsUsed: 0 }),
    apply: (state, action) => {
      if (action.id !== 'advance') throw new Error('illegal');
      return { at: state.at + 1, actionsUsed: state.actionsUsed + 1 };
    },
    view: (state): TickView => ({
      actions: [{ id: 'advance', params: 'none' }],
      status: state.at >= 2 ? 'won' : 'playing',
      hud: { actionsUsed: state.actionsUsed },
    }),
  };

  it('solves through neutral names', () => {
    expect(solveLevel(reducer, { goal: 2 }, { maxActions: 3 })).toEqual({
      min: 2,
      capped: false,
      explored: 2,
      actions: [{ id: 'advance' }, { id: 'advance' }],
    });
  });

  it('keeps legacy solver names behaviorally and structurally compatible', () => {
    interface LegacyProductView extends TickView<{ tiles: string[] }> {}
    const legacy: ActionReducer<{ goal: number }, State, LegacyProductView> = {
      init: reducer.init,
      apply: reducer.apply,
      view: (state): LegacyProductView => ({
        ...reducer.view(state),
        hud: { actionsUsed: state.actionsUsed },
        grid: { tiles: ['floor'] },
      }),
    };
    expect(solveGridLevel(legacy, { goal: 2 }, { maxActions: 3 }))
      .toEqual(solveLevel(legacy, { goal: 2 }, { maxActions: 3 }));
    expect(enumerateGridActions(legacy.view({ at: 0, actionsUsed: 0 })))
      .toEqual(enumerateActions(legacy.view({ at: 0, actionsUsed: 0 })));
  });

  it('enumerates neutral and per-board action targets', () => {
    const view: TickView = {
      actions: [
        { id: 'wait', params: 'none' },
        { id: 'use', params: 'index' },
        { id: 'move', params: 'xy' },
      ],
      status: 'playing',
      hud: {
        actionsUsed: 0,
        items: [{ index: 2 }],
        pois: [{ index: 2 }, { index: 5 }],
      },
      grid: {
        arena: { targetableCells: [[1, 2]] },
        reserve: {
          actionTargeting: { move: { targetableCells: [[3, 4], [4, 4]] } },
        },
      },
    };
    expect(enumerateActions(view)).toEqual([
      { id: 'wait' },
      { id: 'use', index: 2 },
      { id: 'use', index: 5 },
      { id: 'move', x: 1, y: 2, boardId: 'arena' },
      { id: 'move', x: 3, y: 4, boardId: 'reserve' },
      { id: 'move', x: 4, y: 4, boardId: 'reserve' },
    ]);
  });

  it('replays board-addressed transcripts through old and new names', () => {
    const boardReducer: ActionReducer<null, State> = {
      init: () => ({ at: 0, actionsUsed: 0 }),
      apply: (state, action) => {
        if (action.id !== 'Action 1' || action.boardId !== 'arena') throw new Error('illegal');
        return { at: 1, actionsUsed: state.actionsUsed + 1 };
      },
      view: (state) => ({
        actions: [],
        status: state.at === 1 ? 'won' : 'playing',
        hud: { actionsUsed: state.actionsUsed },
      }),
    };
    const header = {
      sessionId: 'test',
      level: null,
      seed: 1,
      perm: [0],
      status: 'won' as const,
      stars: null,
      actionsUsed: 1,
    };
    const actions = [{
      n: 0,
      wireId: 'Action 1',
      canonicalId: 'Action 1',
      boardId: 'arena',
    }];
    expect(recheckTranscript(boardReducer, header, actions)).toEqual({
      ok: true,
      problems: [],
      diagnostics: [],
      replayed: { status: 'won', stars: null, actionsUsed: 1 },
    });
    expect(recheckGridTranscript(boardReducer as ActionReducer<null, State>, header, actions))
      .toEqual(recheckTranscript(boardReducer, header, actions));
  });
});

describe('v0.13 locations and layouts', () => {
  it('produces stable, type-disambiguated location keys', () => {
    const keys = [
      locationKey({ container: 'board', coord: [1, 2] }),
      locationKey({ container: 'board', coord: '1,2' }),
      locationKey({ container: 'board', coord: 12 }),
      locationKey({ container: 'board:cell', coord: [1, 2] }),
    ];
    expect(new Set(keys).size).toBe(keys.length);
    expect(locationKey({ container: 'board', coord: [1, 2] }))
      .toBe(locationKey({ container: 'board', coord: [1, 2] }));
  });

  it('wraps square geometry with deterministic neighbor order and generic paths', () => {
    const layout = createSquareLayout({ width: 5, height: 4 });
    expect(layout.neighbors([1, 1])).toEqual([[1, 0], [1, 2], [0, 1], [2, 1]]);
    expect(layout.distance([1, 1], [4, 3])).toBe(5);
    expect(shortestPath(layout, {
      start: [1, 1],
      goal: [3, 1],
      isBlocked: ([x, y]) => x === 2 && y === 1,
    })).toEqual([[1, 0], [2, 0], [3, 0], [3, 1]]);
    expect(nearestReachablePath<Cell>(layout, {
      start: [1, 1],
      isBlocked: () => false,
      qualifies: ([x]) => x === 3,
      compareEqualDistance: (a, b) => b[1] - a[1],
    })).toEqual({ goal: [3, 1], path: [[2, 1], [3, 1]] });
  });

  it('implements axial hex distance, neighbors, lines, and paths', () => {
    const layout = createHexAxialLayout({
      contains: (cell) => (
        (Math.abs(cell[0]) + Math.abs(cell[1]) + Math.abs(cell[0] + cell[1])) / 2 <= 2
      ),
    });
    expect(layout.neighbors([0, 0])).toEqual([
      [1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1],
    ]);
    expect(layout.distance([0, 0], [2, -1])).toBe(2);
    expect(layout.line([0, 0], [2, -1])).toEqual([[1, -1], [2, -1]]);
    expect(shortestPath(layout, {
      start: [-2, 0],
      goal: [2, 0],
      isBlocked: ([q, r]) => q === 0 && r === 0,
    })).toHaveLength(5);
  });

  it('uses authored directed-edge order for graph BFS and LOS', () => {
    const layout = createGraphLayout({
      nodes: ['a', 'b', 'c', 'd'],
      edges: {
        a: ['b', 'c'],
        b: ['d'],
        c: ['d'],
        d: [],
      },
    });
    expect(layout.line('a', 'd')).toEqual(['b', 'd']);
    expect(layout.distance('a', 'd')).toBe(2);
    expect(layout.distance('d', 'a')).toBe(Number.POSITIVE_INFINITY);
    expect(shortestPath(layout, {
      start: 'a',
      goal: 'd',
      isBlocked: (node) => node === 'b',
    })).toEqual(['c', 'd']);
    expect(lineOfSight(layout, 'a', 'd', (node) => node === 'b')).toBe(false);
    expect(lineOfSight(layout, 'a', 'd', (node) => node === 'd')).toBe(true);
    expect(fieldCells(layout, {
      from: 'a',
      candidates: ['d', 'c', 'b', 'c'],
      range: 2,
      blocksSight: (node) => node === 'b',
    })).toEqual(['c', 'b']);
  });
});

describe('v0.13 keyed movement', () => {
  const squareKey = ([x, y]: Cell): string => `${x},${y}`;

  it('preserves square movement resolution exactly through the keyed engine', () => {
    const movers: Mover[] = [
      { id: 'a', from: [1, 1], to: [2, 1], priority: 1 },
      { id: 'b', from: [3, 1], to: [2, 1], priority: 0 },
      {
        id: 'wide',
        from: [1, 3],
        to: [2, 3],
        priority: 2,
        footprint: { width: 2, height: 1 },
      },
    ];
    const blocked = (x: number, y: number): boolean => x < 0 || y < 0 || x > 4 || y > 4;
    const keyed: KeyedMover<Cell>[] = movers.map((mover) => ({
      ...mover,
      ...(mover.footprint
        ? { occupies: rectFootprint(mover.footprint.width, mover.footprint.height) }
        : {}),
    }));
    expect([...resolveKeyedMoves(keyed, {
      key: squareKey,
      isStaticBlocked: ([x, y]) => blocked(x, y),
    })]).toEqual([...resolveMoves(movers, blocked)]);
  });

  it('resolves graph-node contests and arbitrary occupied sets', () => {
    const result = resolveKeyedMoves([
      { id: 'low', from: 'a', to: 'hub', priority: 4 },
      { id: 'high', from: 'b', to: 'hub', priority: 0 },
      {
        id: 'pair',
        from: 'c',
        to: 'd',
        priority: 1,
        occupies: (at) => [at, `${at}:tail`],
      },
    ], {
      key: (cell) => cell,
      isStaticBlocked: (cell) => cell === 'd:tail',
    });
    expect(Object.fromEntries(result)).toEqual({
      high: 'hub',
      low: 'a',
      pair: 'c',
    });
  });
});
