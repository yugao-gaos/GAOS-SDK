import { describe, expect, it } from 'vitest';
import {
  AgentEnvironment,
  buildLinkedComponentSources,
  createHexAxialLayout,
  createSquareLayout,
  deriveSeatView,
  lineOfSight,
  locationKey,
  recheckTranscript,
  resolveChainReaction,
  resolveKeyedMoves,
  runSettlementCascade,
  seededPermutation,
  type BoardObservation,
  type Cell,
  type ActionReducer,
  type TickView,
} from '../src/engine/index.js';

describe('RFC-002 requirement coverage', () => {
  const hex = createHexAxialLayout({
    contains: ([q, r]) => (
      (Math.abs(q) + Math.abs(r) + Math.abs(q + r)) / 2 <= 3
    ),
  });

  it('satisfies axial distance/line properties across a bounded cube oracle fixture', () => {
    const cells: Cell[] = [];
    for (let q = -3; q <= 3; q++) {
      for (let r = -3; r <= 3; r++) {
        if (hex.contains([q, r])) cells.push([q, r]);
      }
    }
    for (const from of cells) {
      for (const to of cells) {
        const distance = (
          Math.abs(from[0] - to[0])
          + Math.abs(from[1] - to[1])
          + Math.abs((from[0] + from[1]) - (to[0] + to[1]))
        ) / 2;
        expect(hex.distance(from, to)).toBe(distance);
        expect(hex.distance(from, to)).toBe(hex.distance(to, from));
        const line = hex.line(from, to);
        expect(line).toHaveLength(distance);
        if (distance > 0) expect(hex.key(line.at(-1)!)).toBe(hex.key(to));
        let previous = from;
        for (const current of line) {
          expect(hex.neighbors(previous).map(hex.key)).toContain(hex.key(current));
          previous = current;
        }
      }
    }
  });

  it('reuses keyed collision resolution over axial coordinates', () => {
    const result = resolveKeyedMoves<Cell>([
      { id: 'west', from: [-1, 0], to: [0, 0], priority: 1 },
      { id: 'east', from: [1, 0], to: [0, 0], priority: 0 },
    ], {
      key: hex.key,
      isStaticBlocked: (cell) => !hex.contains(cell),
    });
    expect(Object.fromEntries(result)).toEqual({
      east: [0, 0],
      west: [-1, 0],
    });
  });

  it('composes graph adjacency and location keys through generic networks and reactions', () => {
    const graph = {
      neighbors: (node: string): readonly string[] => ({
        a: ['b', 'c'],
        b: ['d'],
        c: ['d'],
        d: [],
      })[node] ?? [],
    };
    const sources = buildLinkedComponentSources([{
      target: { container: 'territory', coord: 'a' },
      source: 'generator',
    }], {
      key: locationKey,
      neighbors: (location) => graph.neighbors(location.coord as string)
        .map((coord) => ({ container: location.container, coord })),
      member: () => true,
    });
    expect([...sources.keys()].sort()).toEqual(['a', 'b', 'c', 'd'].map((coord) => (
      locationKey({ container: 'territory', coord })
    )).sort());

    const trace: string[] = [];
    resolveChainReaction({}, [{ container: 'territory', coord: 'a' }], {
      key: locationKey,
      maxReactions: 4,
      react: (_state, node) => {
        trace.push(node.coord as string);
        return graph.neighbors(node.coord as string)
          .map((coord) => ({ container: node.container, coord }));
      },
    });
    expect(trace).toEqual(['a', 'b', 'c', 'd']);
  });

  it('settles cross-board consequences and replays board-addressed actions', () => {
    interface Job {
      kind: 'board';
      key: string;
      boardId: string;
    }
    const state = { fired: [] as string[] };
    const settlement = runSettlementCascade<typeof state, Job>(
      state,
      [{ kind: 'board', key: 'switch', boardId: 'a' }],
      (job, context) => {
        context.state.fired.push(`${context.wave}:${job.boardId}:${job.key}`);
        if (job.boardId === 'a') {
          context.enqueue({ kind: 'board', key: 'gate', boardId: 'b' });
        }
      },
      { maxSteps: 2 },
    );
    expect(settlement.state.fired).toEqual(['0:a:switch', '1:b:gate']);

    const reducer: ActionReducer<null, { done: boolean }> = {
      init: () => ({ done: false }),
      apply: (_current, action) => {
        if (action.boardId !== 'b') throw new Error('wrong board');
        return { done: true };
      },
      view: (current) => ({
        actions: [],
        status: current.done ? 'won' : 'playing',
        hud: { actionsUsed: current.done ? 1 : 0 },
      }),
    };
    expect(recheckTranscript(reducer, {
      sessionId: 'boards',
      level: null,
      seed: 1,
      perm: [0],
      status: 'won',
      stars: null,
      actionsUsed: 1,
    }, [{
      n: 0,
      wireId: 'Action 1',
      canonicalId: 'Action 1',
      boardId: 'b',
    }])).toMatchObject({ ok: true });
  });
});

describe('RFC-003 requirement coverage', () => {
  interface Entity {
    id: string;
    at: Cell;
  }

  type FogView = TickView<
    Readonly<Record<string, BoardObservation<Cell, Entity>>>,
    Readonly<Record<string, { count: number; entries?: readonly { id: string }[]; ordered?: boolean }>>
  >;

  it('composes square and hex line-of-sight policies into per-seat fog views', () => {
    const square = createSquareLayout({ width: 4, height: 1 });
    const hexLayout = createHexAxialLayout({
      contains: ([q, r]) => q >= 0 && q <= 2 && r === 0,
    });
    const full: FogView = {
      actions: [],
      status: 'playing',
      hud: { actionsUsed: 0 },
      grid: {
        square: {
          cells: [[0, 0], [1, 0], [2, 0], [3, 0]],
          entities: [
            { id: 'near', at: [1, 0] },
            { id: 'far', at: [3, 0] },
          ],
        },
        hex: {
          cells: [[0, 0], [1, 0], [2, 0]],
          entities: [
            { id: 'hex-near', at: [1, 0] },
            { id: 'hex-far', at: [2, 0] },
          ],
        },
      },
    };
    const view = deriveSeatView<Cell, unknown, Entity, FogView>(full, {
      boards: {
        square: {
          cellVisible: (_seat, cell) => lineOfSight(
            square,
            [0, 0],
            cell,
            ([x]) => x === 2,
          ),
          hiddenEntityMode: 'absent',
        },
        hex: {
          cellVisible: (_seat, cell) => lineOfSight(
            hexLayout,
            [0, 0],
            cell,
            ([q]) => q === 1,
          ),
          hiddenEntityMode: 'shell',
        },
      },
    }, 'observer');
    expect(view.grid?.square?.entities?.map(({ id }) => id)).toEqual(['near']);
    expect(view.grid?.hex?.entities).toEqual([
      { id: 'hex-near', at: [1, 0] },
      { at: [2, 0], hidden: true },
    ]);
  });

  it('records and replays a seeded hidden-deck agent episode byte-for-byte', () => {
    interface State {
      deck: string[];
      used: number;
    }
    interface View extends TickView {
      zones: {
        deck: {
          count: number;
          entries?: readonly { id: string }[];
          ordered?: boolean;
        };
      };
    }
    const reducer: ActionReducer<readonly string[], State, View> = {
      init: (level, seed) => ({
        deck: seededPermutation(level.length, seed).map((index) => level[index]!),
        used: 0,
      }),
      apply: (state, action) => {
        if (action.id !== 'draw') throw new Error('illegal');
        return { deck: state.deck.slice(0, -1), used: state.used + 1 };
      },
      view: (state) => ({
        actions: state.deck.length > 0 ? [{ id: 'draw', params: 'none' }] : [],
        status: state.deck.length === 0 ? 'won' : 'playing',
        hud: { actionsUsed: state.used },
        zones: {
          deck: {
            count: state.deck.length,
            entries: state.deck.map((id) => ({ id })),
            ordered: true,
          },
        },
      }),
      viewFor(state) {
        return deriveSeatView(this.view(state), {
          zones: {
            deck: {
              identity: () => ({ kind: 'hidden' }),
              order: () => ({ kind: 'hidden' }),
            },
          },
        }, 'agent');
      },
    };
    const first = new AgentEnvironment({
      reducer,
      level: ['a', 'b'],
      seat: 'agent',
      seed: 19,
    });
    first.reset();
    first.step({ id: 'draw' });
    first.step({ id: 'draw' });
    const transcript = first.transcript();
    expect(transcript.initialObservation.zones.deck).toEqual({ count: 2 });
    expect(transcript.actions.map(({ observation }) => observation.zones.deck))
      .toEqual([{ count: 1 }, { count: 0 }]);
    const replayed = new AgentEnvironment({
      reducer,
      level: ['a', 'b'],
      seat: 'agent',
      seed: 19,
    });
    replayed.replay(transcript.actions.map(({ action }) => action));
    expect(JSON.stringify(replayed.transcript())).toBe(JSON.stringify(transcript));
  });

  it('round-trips declarative target arrays through replay', () => {
    const reducer: ActionReducer<null, { done: boolean }> = {
      init: () => ({ done: false }),
      apply: (_state, action) => {
        if (action.targets?.[0]?.container !== 'hand'
          || action.targets[0].coord !== 1) throw new Error('missing target');
        return { done: true };
      },
      view: (state) => ({
        actions: [],
        status: state.done ? 'won' : 'playing',
        hud: { actionsUsed: state.done ? 1 : 0 },
      }),
    };
    expect(recheckTranscript(reducer, {
      sessionId: 'targets',
      level: null,
      seed: 1,
      perm: [0],
      status: 'won',
      stars: null,
      actionsUsed: 1,
    }, [{
      n: 0,
      wireId: 'Action 1',
      canonicalId: 'Action 1',
      targets: [{ container: 'hand', coord: 1 }],
    }])).toMatchObject({ ok: true });
  });
});
