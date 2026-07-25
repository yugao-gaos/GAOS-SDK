import { describe, expect, it } from 'vitest';
import {
  AgentEnvironment,
  InformationLeakError,
  assertNoInformationLeak,
  canonicalizeLockstepInputs,
  createSquareLayout,
  createInformationRevelation,
  deriveSeatView,
  findPatterns,
  recheckTranscript,
  revelationsForSeat,
  resimulate,
  stateDigest,
  outcomeForTeams,
  teamVisibility,
  type BoardObservation,
  type Cell,
  type InformationPartitionPolicies,
  type TokenRef,
  type ActionReducer,
  type TickReducer,
  type TickView,
  type ZoneViewNamespace,
} from '../src/engine/index.js';

interface PatternToken extends TokenRef<Cell> {
  kind: string;
}

describe('layout pattern matching', () => {
  const layout = createSquareLayout({ width: 5, height: 5 });

  it('reports overlapping maximal runs in deterministic order', () => {
    const tokens: PatternToken[] = [
      { id: 'a', cell: [0, 0], kind: 'gem' },
      { id: 'b', cell: [1, 0], kind: 'gem' },
      { id: 'c', cell: [2, 0], kind: 'gem' },
      { id: 'd', cell: [1, 1], kind: 'gem' },
      { id: 'e', cell: [1, 2], kind: 'gem' },
    ];
    const occupied = new Map(tokens.map((token) => [layout.key(token.cell), token]));
    const matches = findPatterns(layout, occupied, {
      shape: { kind: 'run', minLength: 3 },
      matches: (a, b) => a.kind === b.kind,
    });
    expect(matches.map(({ cells }) => cells)).toEqual([
      [[0, 0], [1, 0], [2, 0]],
      [[1, 0], [1, 1], [1, 2]],
    ]);
  });

  it('matches relative lattice motifs', () => {
    const tokens: PatternToken[] = [
      { id: 'a', cell: [2, 2], kind: 'unit' },
      { id: 'b', cell: [3, 2], kind: 'unit' },
      { id: 'c', cell: [2, 3], kind: 'unit' },
    ];
    const occupied = new Map(tokens.map((token) => [layout.key(token.cell), token]));
    expect(findPatterns(layout, occupied, {
      shape: { kind: 'motif', offsets: [[0, 0], [1, 0], [0, 1]] },
      matches: (a, b) => a.kind === b.kind,
    })).toHaveLength(1);
  });
});

interface CardView {
  id: string;
  label: string;
}

interface PieceView {
  id: string;
  at: Cell;
  team: string;
}

type PartitionView = TickView<
  Readonly<Record<string, BoardObservation<Cell, PieceView>>>,
  Readonly<Record<string, ZoneViewNamespace<CardView>>>
>;

const ownerOnly = {
  identity: () => ({ kind: 'seats', seats: ['a'] } as const),
  order: () => ({ kind: 'seats', seats: ['a'] } as const),
};

const publicZone = {
  identity: () => ({ kind: 'public' } as const),
  order: () => ({ kind: 'public' } as const),
};

const fullPartitionView = (): PartitionView => ({
  actions: [{ id: 'move', params: 'xy' }],
  status: 'playing',
  hud: { actionsUsed: 0 },
  zones: {
    deck: {
      count: 2,
      entries: [
        { id: 'secret-2', label: 'two' },
        { id: 'secret-1', label: 'one' },
      ],
      ordered: true,
    },
    handA: {
      count: 1,
      entries: [{ id: 'hand-a', label: 'owner card' }],
      ordered: true,
    },
    discard: {
      count: 1,
      entries: [{ id: 'open', label: 'public card' }],
      ordered: true,
    },
    bag: {
      count: 2,
      entries: [
        { id: 'bag-2', label: 'two' },
        { id: 'bag-1', label: 'one' },
      ],
    },
  },
  grid: {
    arena: {
      cells: [[0, 0], [1, 0], [2, 0]],
      targetableCells: [[0, 0], [2, 0]],
      actionTargeting: {
        move: { targetableCells: [[1, 0], [2, 0]] },
      },
      entities: [
        { id: 'visible', at: [0, 0], team: 'blue' },
        { id: 'hidden', at: [2, 0], team: 'red' },
      ],
    },
  },
});

const policies: InformationPartitionPolicies<Cell, CardView, PieceView> = {
  zones: {
    deck: {
      identity: () => ({ kind: 'hidden' }),
      order: () => ({ kind: 'hidden' }),
    },
    handA: ownerOnly,
    discard: publicZone,
    bag: {
      identity: () => ({ kind: 'public' }),
      order: () => ({ kind: 'hidden' }),
    },
  },
  boards: {
    arena: {
      cellVisible: (_seat, [x]) => x <= 1,
      hiddenEntityMode: 'shell',
    },
  },
  shellEntity: (_entity, at) => ({ id: 'shell', at, team: 'unknown' }),
};

describe('information partitions', () => {
  it('redacts identity and order independently without mutating the full view', () => {
    const full = fullPartitionView();
    const forA = deriveSeatView(full, policies, 'a');
    const forB = deriveSeatView(full, policies, 'b');

    expect(forA.zones?.deck).toEqual({ count: 2 });
    expect(forA.zones?.handA).toMatchObject({
      entries: [{ id: 'hand-a', label: 'owner card' }],
      ordered: true,
    });
    expect(forB.zones?.handA).toEqual({ count: 1 });
    expect(forB.zones?.discard).toMatchObject({ entries: [{ id: 'open' }], ordered: true });
    expect(forB.zones?.bag).toEqual({
      count: 2,
      entries: [
        { id: 'bag-1', label: 'one' },
        { id: 'bag-2', label: 'two' },
      ],
    });
    expect(full.zones?.deck?.entries?.[0]?.id).toBe('secret-2');
  });

  it('filters fogged cells and targeting while shelling hidden entities', () => {
    const view = deriveSeatView(fullPartitionView(), policies, 'b');
    expect(view.grid?.arena).toMatchObject({
      cells: [[0, 0], [1, 0]],
      targetableCells: [[0, 0]],
      actionTargeting: { move: { targetableCells: [[1, 0]] } },
      entities: [
        { id: 'visible', at: [0, 0], team: 'blue' },
        { id: 'shell', at: [2, 0], team: 'unknown' },
      ],
    });
  });

  it('checks hidden permutations for observation leaks', () => {
    const baseline = fullPartitionView();
    const variant = fullPartitionView();
    const variantDeck = variant.zones?.deck;
    if (!variantDeck?.entries) throw new Error('deck fixture missing');
    variantDeck.entries = [...variantDeck.entries].reverse();
    expect(() => assertNoInformationLeak({
      baseline,
      variants: [variant],
      observe: (state) => deriveSeatView(state, policies, 'b'),
    })).not.toThrow();
    expect(() => assertNoInformationLeak({
      baseline,
      variants: [variant],
      observe: (state) => state,
    })).toThrow(InformationLeakError);
  });

  it('provides a shared-vision team convention', () => {
    expect(teamVisibility([
      { id: 'blue', seats: ['a', 'b'] },
      { id: 'red', seats: ['c'] },
    ], 'b')).toEqual({ kind: 'seats', seats: ['a', 'b'] });
    expect(outcomeForTeams([
      { id: 'blue', seats: ['a', 'b'] },
      { id: 'red', seats: ['c'] },
    ], [
      { teamId: 'red', rank: 1, score: 4 },
      { teamId: 'blue', rank: 2 },
    ], 'objective')).toEqual({
      kind: 'decided',
      ranking: [
        { seat: 'c', rank: 1, score: 4 },
        { seat: 'a', rank: 2 },
        { seat: 'b', rank: 2 },
      ],
      reason: 'objective',
    });
  });

  it('standardizes reveal records and filters them through the visibility algebra', () => {
    const records = [
      createInformationRevelation('public', { card: 'ace' }),
      createInformationRevelation('owner', { card: 'king' }, {
        kind: 'seats',
        seats: ['a'],
      }),
    ];
    expect(revelationsForSeat(records, 'a').map(({ id }) => id))
      .toEqual(['public', 'owner']);
    expect(revelationsForSeat(records, 'b').map(({ id }) => id))
      .toEqual(['public']);
  });
});

describe('seat-aware agent observations', () => {
  interface State {
    done: boolean;
    appliedSeat?: string;
  }

  interface View extends TickView {
    secret: string;
  }

  const reducer: ActionReducer<null, State, View> = {
    init: () => ({ done: false }),
    apply: (_state, action) => ({ done: true, appliedSeat: action.seat }),
    view: (state) => ({
      actions: [
        { id: 'advance', params: 'none' },
        { id: 'cheat', params: 'none' },
      ],
      status: 'playing',
      outcome: state.done
        ? { kind: 'decided', ranking: [{ seat: 'b', rank: 1, score: 7 }, { seat: 'a', rank: 2 }] }
        : { kind: 'ongoing' },
      hud: { actionsUsed: state.done ? 1 : 0 },
      secret: 'full-secret',
    }),
    viewFor: (state, seat) => ({
      actions: [{ id: 'advance', params: 'none' }],
      status: 'playing',
      outcome: state.done
        ? { kind: 'decided', ranking: [{ seat: 'b', rank: 1, score: 7 }, { seat: 'a', rank: 2 }] }
        : { kind: 'ongoing' },
      hud: { actionsUsed: state.done ? 1 : 0 },
      secret: seat === 'a' ? 'full-secret' : '[hidden]',
    }),
  };

  it('uses viewFor for legality and records redacted observation streams', () => {
    const environment = new AgentEnvironment({ reducer, level: null, seat: 'b', seed: 9 });
    const initial = environment.reset();
    expect(initial.observation.secret).toBe('[hidden]');
    expect(initial.legalActions).toEqual([{ id: 'advance' }]);

    const final = environment.step({ id: 'advance' });
    expect(final).toMatchObject({
      reward: 7,
      done: true,
      info: { seat: 'b', terminationReason: 'decided' },
    });
    const transcript = environment.transcript();
    expect(transcript).toMatchObject({
      version: '1.3',
      seat: 'b',
      initialObservation: { secret: '[hidden]' },
      actions: [{
        action: { id: 'advance', seat: 'b' },
        observation: { secret: '[hidden]' },
      }],
    });
    const replayed = new AgentEnvironment({ reducer, level: null, seat: 'b', seed: 9 });
    replayed.replay(transcript.actions.map(({ action }) => action));
    expect(replayed.transcript()).toEqual(transcript);
  });
});

describe('tick replay and lockstep', () => {
  interface State {
    count: number;
    trace: string[];
  }

  const reducer: ActionReducer<null, State> = {
    init: () => ({ count: 0, trace: [] }),
    apply: (state, action) => ({
      count: state.count + 1,
      trace: [...state.trace, `${action.seat}:${action.id}`],
    }),
    view: (state) => ({
      actions: [],
      status: state.count >= 4 ? 'won' : 'playing',
      hud: { actionsUsed: state.count },
    }),
  };

  it('rechecks tick gaps through product-owned empty-tick work', () => {
    const emptyTicks: number[] = [];
    const result = recheckTranscript(reducer, {
      sessionId: 'ticks',
      level: null,
      seed: 1,
      perm: [0],
      status: 'won',
      stars: null,
      actionsUsed: 4,
      visibility: 'seat:a',
    }, [
      { n: 0, wireId: 'Action 1', canonicalId: 'Action 1', seat: 'a' },
      { n: 1, wireId: 'Action 1', canonicalId: 'Action 1', tick: 3, seat: 'a' },
    ], {
      applyEmptyTick: (state, tick) => {
        emptyTicks.push(tick);
        return {
          count: state.count + 1,
          trace: [...state.trace, `empty:${tick}`],
        };
      },
    });
    expect(result.ok).toBe(true);
    expect(emptyTicks).toEqual([1, 2]);
  });

  it('rejects a tick that moves backward across an omitted inherited tick', () => {
    const result = recheckTranscript(reducer, {
      sessionId: 'backward-ticks',
      level: null,
      seed: 1,
      perm: [0],
      status: 'won',
      stars: null,
      actionsUsed: 4,
    }, [
      { n: 0, wireId: 'Action 1', canonicalId: 'Action 1', tick: 3 },
      { n: 1, wireId: 'Action 1', canonicalId: 'Action 1' },
      { n: 2, wireId: 'Action 1', canonicalId: 'Action 1', tick: 2 },
      { n: 3, wireId: 'Action 1', canonicalId: 'Action 1' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain('action 2 tick must not precede the previous action');
  });

  it('canonicalizes input order and resimulates empty ticks', () => {
    const atomicReducer: TickReducer<null, State> = {
      ...reducer,
      advance: (state, actions) => actions.length === 0
        ? { ...state, trace: [...state.trace, 'empty'] }
        : actions.reduce((current, action) => ({
          count: current.count + 1,
          trace: [...current.trace, `${action.seat}:${action.id}`],
        }), state),
    };
    const inputs = [
      { tick: 1, seat: 'b', actions: [{ id: 'b' }] },
      { tick: 3, seat: 'a', actions: [{ id: 'late' }] },
      { tick: 1, seat: 'a', actions: [{ id: 'a' }] },
    ];
    expect(canonicalizeLockstepInputs(inputs).map(({ tick, seat }) => [tick, seat]))
      .toEqual([[1, 'a'], [1, 'b'], [3, 'a']]);
    const state = resimulate(atomicReducer, { count: 0, trace: [] }, inputs, {
      throughTick: 3,
    });
    expect(state.trace).toEqual([
      'empty',
      'a:a',
      'b:b',
      'empty',
      'a:late',
    ]);
    expect(stateDigest(state, { serialize: (value) => JSON.stringify(value.trace) }))
      .toBe(stateDigest(state, { serialize: (value) => JSON.stringify(value.trace) }));
    expect(() => resimulate(atomicReducer, state, inputs, { fromTick: 2 }))
      .toThrow('must not precede fromTick');
  });

  it('resimulates one tick as one canonical atomic intent batch when supported', () => {
    const batchReducer: ActionReducer<null, State> = {
      ...reducer,
      applyIntents: (state, actions) => ({
        count: state.count + actions.length,
        trace: [
          ...state.trace,
          `batch:${actions.map((action) => `${action.seat}:${action.id}`).join(',')}`,
        ],
      }),
    };
    const state = resimulate(batchReducer, { count: 0, trace: [] }, [
      { tick: 2, seat: 'z', actions: [{ id: 'last' }] },
      { tick: 2, seat: 'a', actions: [{ id: 'first' }, { id: 'second' }] },
    ], { fromTick: 2 });
    expect(state).toEqual({
      count: 3,
      trace: ['batch:a:first,a:second,z:last'],
    });
  });
});
