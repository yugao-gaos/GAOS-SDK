import { describe, expect, it } from 'vitest';
import {
  commitPortalTransits,
  deriveSeatView,
  planPortalTransits,
  recheckTranscript,
  type Cell,
  type PortalEdge,
  type PortalPolicy,
  type ActionReducer,
  type TickView,
} from '../src/engine/index.js';

interface Entity {
  id: string;
  form: string;
}

interface PortalState {
  entities: Record<string, { entity: Entity; container: string; coord: Cell | string | number }>;
  transformCalls: string[];
}

const chainEdges: PortalEdge[] = [
  {
    id: 'board-to-bag',
    from: { container: 'hex', coord: [0, 0] },
    to: { container: 'bag', coord: 'mouth' },
    priority: 0,
  },
  {
    id: 'bag-to-graph',
    from: { container: 'bag', coord: 'mouth' },
    to: { container: 'territories', coord: 'north' },
    priority: 1,
  },
];

function policy(
  blocked: ReadonlySet<string> = new Set(),
  capacity = 1,
): PortalPolicy<PortalState, Entity> {
  return {
    entityId: ({ id }) => id,
    isActive: () => true,
    canTransit: () => true,
    destinationKind: (_state, _entity, edge) => (
      edge.id === 'board-to-bag' ? 'zone' : 'board'
    ),
    insertInto: { mode: 'top' },
    placeOnto: (_state, _entity, edge) => edge.to.coord,
    occupiesAt: (_entity, at) => [at],
    canEnter: (_state, entity) => !blocked.has(entity.id),
    capacityAt: () => capacity,
    transform: (entity, edge) => ({
      ...entity,
      form: edge.id === 'board-to-bag' ? 'card' : 'unit',
    }),
  };
}

function stateFor(...entities: Entity[]): PortalState {
  return {
    entities: Object.fromEntries(entities.map((entity) => [
      entity.id,
      { entity, container: 'hex', coord: [0, 0] as Cell },
    ])),
    transformCalls: [],
  };
}

describe('portal transit', () => {
  it('plans and commits a heterogeneous multi-hop chain with atomic transformations', () => {
    const state = stateFor({ id: 'hero', form: 'unit' });
    let transforms = 0;
    const basePolicy = policy(new Set(), Number.POSITIVE_INFINITY);
    const portalPolicy: PortalPolicy<PortalState, Entity> = {
      ...basePolicy,
      transform: (entity, edge) => {
        transforms++;
        return basePolicy.transform!(entity, edge);
      },
    };
    const plan = planPortalTransits(state, [{
      entity: { id: 'hero', form: 'unit' },
      at: { container: 'hex', coord: [0, 0] },
    }], chainEdges, portalPolicy, { maxPasses: 4 });
    expect(plan).toMatchObject({ ok: true, rejected: [] });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.transits.map(({ edge, from, to }) => [
      edge.id,
      from.container,
      to.container,
    ])).toEqual([
      ['board-to-bag', 'hex', 'bag'],
      ['bag-to-graph', 'bag', 'territories'],
    ]);
    const arrivals: string[] = [];
    const result = commitPortalTransits(state, plan, portalPolicy, {
      commit: (current, transits) => {
        const final = transits.at(-1)!;
        return {
          ...current,
          entities: {
            ...current.entities,
            hero: {
              entity: final.committedEntity,
              container: final.to.container,
              coord: final.to.coord,
            },
          },
          transformCalls: transits.map(({ edge }) => edge.id),
        };
      },
      arrive: (_state, transit) => arrivals.push(transit.edge.id),
    });
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) throw new Error(result.message);
    expect(transforms).toBe(2);
    expect(result.state.entities.hero).toMatchObject({
      entity: { id: 'hero', form: 'unit' },
      container: 'territories',
      coord: 'north',
    });
    expect(arrivals).toEqual(['board-to-bag', 'bag-to-graph']);
  });

  it('reports cycles instead of looping', () => {
    const state = stateFor({ id: 'loop', form: 'unit' });
    const edges: PortalEdge[] = [
      {
        id: 'out',
        from: { container: 'a', coord: 0 },
        to: { container: 'b', coord: 0 },
      },
      {
        id: 'back',
        from: { container: 'b', coord: 0 },
        to: { container: 'a', coord: 0 },
      },
    ];
    const zonePolicy: PortalPolicy<PortalState, Entity> = {
      ...policy(),
      destinationKind: () => 'zone',
    };
    expect(planPortalTransits(state, [{
      entity: { id: 'loop', form: 'unit' },
      at: { container: 'a', coord: 0 },
    }], edges, zonePolicy, { maxPasses: 5 })).toMatchObject({
      ok: false,
      code: 'cycle',
    });
  });

  it('rejects a complete rider/mount group when one destination is blocked', () => {
    const state = stateFor(
      { id: 'rider', form: 'unit' },
      { id: 'mount', form: 'unit' },
    );
    const plan = planPortalTransits(state, [
      {
        entity: { id: 'rider', form: 'unit' },
        at: { container: 'hex', coord: [0, 0] },
        group: 'mounted',
      },
      {
        entity: { id: 'mount', form: 'unit' },
        at: { container: 'hex', coord: [0, 0] },
        group: 'mounted',
      },
    ], chainEdges.slice(0, 1), {
      ...policy(new Set(['mount'])),
      destinationKind: () => 'zone',
    }, { maxPasses: 2 });
    expect(plan).toMatchObject({ ok: true, transits: [] });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.rejected.map(({ entrant }) => entrant.entity.id).sort())
      .toEqual(['mount', 'rider']);
  });

  it('arbitrates three entrants into capacity one in all-fail and priority modes', () => {
    const entities = [
      { id: 'a', form: 'unit' },
      { id: 'b', form: 'unit' },
      { id: 'c', form: 'unit' },
    ];
    const state = stateFor(...entities);
    const entrants = entities.map((entity, index) => ({
      entity,
      at: { container: 'hex', coord: [0, 0] as Cell },
      priority: [2, 0, 1][index],
    }));
    const oneEdge = chainEdges.slice(0, 1);
    const zonePolicy = { ...policy(), destinationKind: () => 'zone' as const };
    const allFail = planPortalTransits(state, entrants, oneEdge, zonePolicy, {
      maxPasses: 1,
      contention: 'all-fail',
    });
    const priority = planPortalTransits(state, entrants, oneEdge, zonePolicy, {
      maxPasses: 1,
      contention: 'priority',
    });
    expect(allFail).toMatchObject({ ok: true, transits: [] });
    expect(priority).toMatchObject({ ok: true });
    if (!priority.ok) throw new Error(priority.message);
    expect(priority.transits.map(({ entityId }) => entityId)).toEqual(['b']);
  });

  it('orders waves, edges, authored order, and entrant priority deterministically', () => {
    const entities = [
      { id: 'late-wave', form: 'unit' },
      { id: 'low-priority', form: 'unit' },
      { id: 'high-priority', form: 'unit' },
      { id: 'earlier-edge', form: 'unit' },
    ];
    const state = stateFor(...entities);
    const edges: PortalEdge[] = [
      {
        id: 'edge-a',
        from: { container: 'in', coord: 0 },
        to: { container: 'out-a', coord: 0 },
        priority: 1,
      },
      {
        id: 'edge-b',
        from: { container: 'in', coord: 1 },
        to: { container: 'out-b', coord: 0 },
        priority: 0,
      },
    ];
    const zonePolicy: PortalPolicy<PortalState, Entity> = {
      ...policy(new Set(), Number.POSITIVE_INFINITY),
      destinationKind: () => 'zone',
    };
    const plan = planPortalTransits(state, [
      {
        entity: entities[0]!,
        at: { container: 'in', coord: 1 },
        wave: 1,
        priority: 0,
      },
      {
        entity: entities[1]!,
        at: { container: 'in', coord: 0 },
        priority: 2,
      },
      {
        entity: entities[2]!,
        at: { container: 'in', coord: 0 },
        priority: 0,
      },
      {
        entity: entities[3]!,
        at: { container: 'in', coord: 1 },
        priority: 9,
      },
    ], edges, zonePolicy, { maxPasses: 1, contention: 'priority' });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.transits.map(({ entityId }) => entityId)).toEqual([
      'earlier-edge',
      'high-priority',
      'low-priority',
      'late-wave',
    ]);
  });

  it('supports authored bidirectional edges without inventing another edge id', () => {
    const state = stateFor({ id: 'returning', form: 'unit' });
    const edge: PortalEdge = {
      id: 'stairs',
      from: { container: 'floor-a', coord: 0 },
      to: { container: 'floor-b', coord: 0 },
      bidirectional: true,
    };
    const zonePolicy: PortalPolicy<PortalState, Entity> = {
      ...policy(new Set(), Number.POSITIVE_INFINITY),
      destinationKind: () => 'zone',
      canTransit: (_state, _entity, oriented) => oriented.from.container === 'floor-b',
    };
    const plan = planPortalTransits(state, [{
      entity: { id: 'returning', form: 'unit' },
      at: { container: 'floor-b', coord: 0 },
    }], [edge], zonePolicy, { maxPasses: 2 });
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.transits).toMatchObject([{
      edge: { id: 'stairs', from: { container: 'floor-b' }, to: { container: 'floor-a' } },
      reversed: true,
    }]);
  });

  it('lets one atomic commit expose departure and hidden-zone count together', () => {
    interface View extends TickView {
      boardEntities: string[];
    }
    const before: View = {
      actions: [],
      status: 'playing',
      hud: { actionsUsed: 0 },
      boardEntities: ['hero'],
      zones: {
        hand: { count: 0, entries: [] },
      },
    };
    const after: View = {
      ...before,
      boardEntities: [],
      zones: {
        hand: { count: 1, entries: [{ id: 'hero' }] },
      },
    };
    const policies = {
      zones: {
        hand: {
          identity: () => ({ kind: 'hidden' as const }),
          order: () => ({ kind: 'hidden' as const }),
        },
      },
    };
    expect(deriveSeatView(before, policies, 'observer')).toMatchObject({
      boardEntities: ['hero'],
      zones: { hand: { count: 0 } },
    });
    expect(deriveSeatView(after, policies, 'observer')).toMatchObject({
      boardEntities: [],
      zones: { hand: { count: 1 } },
    });
  });

  it('re-verifies a transcript whose reducer commits a portal transit', () => {
    interface State {
      at: 'board' | 'zone';
      used: number;
    }
    const reducer: ActionReducer<null, State> = {
      init: () => ({ at: 'board', used: 0 }),
      apply: (state, action) => {
        if (action.id !== 'Action 1' || state.at !== 'board') throw new Error('illegal');
        const portalState = stateFor({ id: 'hero', form: 'unit' });
        const portalPolicy = { ...policy(), destinationKind: () => 'zone' as const };
        const plan = planPortalTransits(portalState, [{
          entity: { id: 'hero', form: 'unit' },
          at: { container: 'hex', coord: [0, 0] },
        }], chainEdges.slice(0, 1), portalPolicy, { maxPasses: 1 });
        if (!plan.ok || plan.transits.length !== 1) throw new Error('portal failed');
        return { at: 'zone', used: state.used + 1 };
      },
      view: (state) => ({
        actions: state.at === 'board' ? [{ id: 'Action 1', params: 'none' }] : [],
        status: state.at === 'zone' ? 'won' : 'playing',
        hud: { actionsUsed: state.used },
      }),
    };
    expect(recheckTranscript(reducer, {
      sessionId: 'portal',
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
    }])).toMatchObject({ ok: true });
  });
});
