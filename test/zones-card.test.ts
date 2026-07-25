import { describe, expect, it } from 'vitest';
import {
  KeywordRegistry,
  activePhase,
  advanceDurations,
  advancePhase,
  arbitrateResourceClaims,
  assertNoInformationLeak,
  bag,
  commitZoneTransfer,
  createPhaseState,
  createZone,
  dealBatches,
  dealRoundRobin,
  deck,
  defineZones,
  discard,
  deriveSeatView,
  drawFromZone,
  enumerateActions,
  enumerateTargetChoices,
  hand,
  openResponseWindow,
  passResponsePriority,
  planZoneTransfer,
  queue,
  resolveArrival,
  resolveKeywordLayerDetails,
  shuffleZone,
  slotRow,
  solveLevel,
  spendStatusCounters,
  submitResponse,
  timeoutResponsePriority,
  unwindResponseWindow,
  validateDeck,
  type Cell,
  type TimedStatus,
  type ActionReducer,
  type TickView,
  type Visibility,
  type ZoneCollection,
  type ZoneVisibilityPolicy,
} from '../src/engine/index.js';

function zonesFixture(): ZoneCollection {
  return defineZones({
    deck: createZone({ ...deck(), capacity: 6 }, ['a', 'b', 'c', 'd', 'e', 'f']),
    handA: createZone({ ...hand('a'), id: 'handA', capacity: 3 }),
    handB: createZone({ ...hand('b'), id: 'handB', capacity: 3 }),
    discard: createZone(discard()),
    queue: createZone(queue()),
    slots: createZone(slotRow(['weapon', 'armor'])),
  });
}

describe('zone primitives', () => {
  it('covers preset identity/order visibility for three seats without bag or hand leaks', () => {
    const full: TickView = {
      actions: [],
      status: 'playing',
      hud: { actionsUsed: 0 },
      zones: {
        deck: {
          count: 2,
          entries: [{ id: 'd2' }, { id: 'd1' }],
          ordered: true,
        },
        handA: {
          count: 2,
          entries: [{ id: 'h2' }, { id: 'h1' }],
          ordered: true,
        },
        discard: {
          count: 1,
          entries: [{ id: 'open' }],
          ordered: true,
        },
        bag: {
          count: 2,
          entries: [{ id: 'b2' }, { id: 'b1' }],
        },
      },
    };
    const configs = {
      deck: deck(),
      handA: { ...hand('a'), id: 'handA' },
      discard: discard(),
      bag: bag(),
    };
    const policies = {
      zones: Object.fromEntries(Object.entries(configs).map(([id, config]) => [
        id,
        config.visibility,
      ])),
    };
    const views = ['a', 'b', 'c'].map((seat) => deriveSeatView(full, policies, seat));
    expect(views[0]?.zones?.handA).toMatchObject({
      entries: [{ id: 'h2' }, { id: 'h1' }],
      ordered: true,
    });
    for (const view of views.slice(1)) expect(view.zones?.handA).toEqual({ count: 2 });
    for (const view of views) {
      expect(view.zones?.deck).toEqual({ count: 2 });
      expect(view.zones?.discard).toMatchObject({ entries: [{ id: 'open' }], ordered: true });
      expect(view.zones?.bag).toEqual({
        count: 2,
        entries: [{ id: 'b1' }, { id: 'b2' }],
      });
    }

    const variant: TickView = {
      ...full,
      zones: {
        ...full.zones,
        deck: { ...full.zones!.deck!, entries: [...full.zones!.deck!.entries!].reverse() },
        handA: { ...full.zones!.handA!, entries: [...full.zones!.handA!.entries!].reverse() },
        bag: { ...full.zones!.bag!, entries: [...full.zones!.bag!.entries!].reverse() },
      },
    };
    expect(() => assertNoInformationLeak({
      baseline: full,
      variants: [variant],
      observe: (state) => deriveSeatView(state, policies, 'c'),
    })).not.toThrow();
  });

  it('covers every visibility pair independently across every valid access/order pair', () => {
    const visibilityValues: Visibility[] = [
      { kind: 'public' },
      { kind: 'seats', seats: ['a'] },
      { kind: 'hidden' },
    ];
    for (const identity of visibilityValues) {
      for (const order of visibilityValues) {
        const policy: ZoneVisibilityPolicy = {
          identity: () => identity,
          order: () => order,
        };
        const full: TickView = {
          actions: [],
          status: 'playing',
          hud: { actionsUsed: 0 },
          zones: {
            sample: {
              count: 2,
              entries: [{ id: 'z' }, { id: 'a' }],
              ordered: true,
            },
          },
        };
        for (const seat of ['a', 'b']) {
          const observed = deriveSeatView(full, { zones: { sample: policy } }, seat)
            .zones!.sample!;
          const identityVisible = identity.kind === 'public'
            || (identity.kind === 'seats' && identity.seats.includes(seat));
          const orderVisible = order.kind === 'public'
            || (order.kind === 'seats' && order.seats.includes(seat));
          if (!identityVisible) {
            expect(observed).toEqual({ count: 2 });
          } else {
            expect(observed.entries).toEqual(orderVisible
              ? [{ id: 'z' }, { id: 'a' }]
              : [{ id: 'a' }, { id: 'z' }]);
            expect(observed.ordered).toBe(orderVisible ? true : undefined);
          }
        }
      }
    }

    const publicPolicy: ZoneVisibilityPolicy = {
      identity: () => ({ kind: 'public' }),
      order: () => ({ kind: 'public' }),
    };
    const valid = defineZones({
      lifo: createZone({
        id: 'lifo', access: 'lifo', order: 'ordered', visibility: publicPolicy,
      }, ['l1', 'l2']),
      fifo: createZone({
        id: 'fifo', access: 'fifo', order: 'ordered', visibility: publicPolicy,
      }, ['f1', 'f2']),
      indexed: createZone({
        id: 'indexed', access: 'anyIndex', order: 'ordered', visibility: publicPolicy,
      }, ['i1', 'i2']),
      bag: createZone({
        id: 'bag', access: 'anyIndex', order: 'bag', visibility: publicPolicy,
      }, ['b1', 'b2']),
      slots: createZone({
        id: 'slots',
        access: 'slots',
        order: 'sparse',
        visibility: publicPolicy,
        slots: ['s1', 's2'],
      }, { s1: 'sparse1' }),
    });
    expect(drawFromZone(valid, 'lifo', 1).entries).toEqual(['l2']);
    expect(drawFromZone(valid, 'fifo', 1).entries).toEqual(['f1']);
    expect(drawFromZone(valid, 'indexed', 1).entries).toEqual(['i2']);
    expect(drawFromZone(valid, 'bag', 1, 7).entries).toHaveLength(1);
    expect(valid.slots?.slots).toEqual({ s1: 'sparse1', s2: null });
    expect(() => createZone(slotRow(['s'], 'bad-slots'), [])).toThrow(
      /slot record/,
    );
    expect(() => createZone(queue('bad-list'), {})).toThrow(/entry array/);
  });

  it('plans and commits atomic cross-zone transfers with arrival locations', () => {
    const zones = zonesFixture();
    const plan = planZoneTransfer(zones, {
      entries: ['f'],
      from: { container: 'deck', coord: 5 },
      to: { container: 'handA', coord: 0 },
      insert: 'top',
    });
    expect(plan.ok).toBe(true);
    expect(zones.deck?.entries).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    if (!plan.ok) throw new Error(plan.message);
    expect(plan.arrivals).toEqual([{
      entry: 'f',
      from: { container: 'deck', coord: 5 },
      to: { container: 'handA', coord: 0 },
    }]);
    const arrivals: string[] = [];
    const committed = commitZoneTransfer(zones, plan, {
      arrive: (arrival) => arrivals.push(`${arrival.entry}:${arrival.to.container}`),
    });
    expect(committed).toMatchObject({ ok: true });
    if (!committed.ok) throw new Error(committed.message);
    expect(committed.zones.deck?.entries).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(committed.zones.handA?.entries).toEqual(['f']);

    resolveArrival({}, plan.arrivals[0]!, [{
      id: 'zone-entered',
      apply: (_state, arrival) => arrivals.push(`rule:${arrival.entry}:${arrival.to.container}`),
    }], []);
    expect(arrivals).toEqual(['f:handA', 'rule:f:handA']);
  });

  it('fails a capacity-violating group without changing state and rejects stale plans', () => {
    const base = defineZones({
      source: createZone({ ...deck('source'), capacity: 3 }, ['a', 'b', 'c']),
      target: createZone({ ...hand('x', 'target'), capacity: 1 }, ['held']),
    });
    const blocked = planZoneTransfer(base, {
      entries: ['b', 'c'],
      from: { container: 'source', coord: 1 },
      to: { container: 'target', coord: 1 },
      insert: 'top',
    });
    expect(blocked).toMatchObject({ ok: false, code: 'capacity_exceeded', zones: base });
    expect(base.source?.entries).toEqual(['a', 'b', 'c']);

    const plan = planZoneTransfer(base, {
      entries: ['c'],
      from: { container: 'source', coord: 2 },
      to: { container: 'source', coord: 2 },
      insert: 'top',
    });
    if (!plan.ok) throw new Error(plan.message);
    const changed = shuffleZone(base, 'source', 9);
    expect(commitZoneTransfer(changed, plan)).toMatchObject({ ok: false, code: 'stale_plan' });
    expect(commitZoneTransfer(defineZones(base), plan))
      .toMatchObject({ ok: false, code: 'stale_plan' });
  });

  it('enforces FIFO and slot access while keeping bag draws seeded', () => {
    const base = defineZones({
      source: createZone(queue('source'), ['first', 'second']),
      slots: createZone(slotRow(['one'], 'slots')),
    });
    expect(planZoneTransfer(base, {
      entries: ['second'],
      from: { container: 'source', coord: 1 },
      to: { container: 'slots', coord: 'one' },
      insert: { slot: 'one' },
    })).toMatchObject({ ok: false, code: 'access_denied' });
    const allowed = planZoneTransfer(base, {
      entries: ['first'],
      from: { container: 'source', coord: 0 },
      to: { container: 'slots', coord: 'one' },
      insert: { slot: 'one' },
    });
    expect(allowed).toMatchObject({ ok: true });

    const bagZones = defineZones({
      bag: createZone({
        id: 'bag',
        access: 'anyIndex',
        order: 'bag',
        visibility: {
          identity: () => ({ kind: 'public' }),
          order: () => ({ kind: 'hidden' }),
        },
      }, ['a', 'b', 'c', 'd']),
    });
    expect(drawFromZone(bagZones, 'bag', 3, 42))
      .toEqual(drawFromZone(bagZones, 'bag', 3, 42));
  });

  it('deals round-robin and batches reproducibly in authored destination order', () => {
    const spec = { from: 'deck', to: ['handA', 'handB'], count: 2, seed: 17 };
    const roundRobin = dealRoundRobin(zonesFixture(), spec);
    const repeated = dealRoundRobin(zonesFixture(), spec);
    const batches = dealBatches(zonesFixture(), spec);
    expect(roundRobin.ok && repeated.ok ? roundRobin.dealt : null)
      .toEqual(repeated.ok ? repeated.dealt : null);
    expect(roundRobin).toMatchObject({ ok: true });
    expect(batches).toMatchObject({ ok: true });
    if (!roundRobin.ok || !batches.ok) throw new Error('deal failed');
    expect(roundRobin.dealt.handA).toHaveLength(2);
    expect(roundRobin.dealt.handB).toHaveLength(2);
    expect(roundRobin.dealt).not.toEqual(batches.dealt);
  });
});

describe('card composition mechanisms', () => {
  it('resolves keyword layers by layer, registration, acquisition, and source', () => {
    const registry = new KeywordRegistry<number, string>([
      { id: 'late-layer', kind: 'static', layer: 2, resolve: (n) => `late:${n}` },
      { id: 'first-layer', kind: 'triggered', layer: 1, resolve: (n) => `first:${n}` },
      { id: 'same-layer', kind: 'activated', layer: 1, resolve: (n) => `same:${n}` },
    ]);
    const resolved = resolveKeywordLayerDetails(4, [
      { id: 'late-layer', acquiredAt: 0 },
      { id: 'same-layer', acquiredAt: 2, sourceId: 'b' },
      { id: 'first-layer', acquiredAt: 9 },
      { id: 'same-layer', acquiredAt: 2, sourceId: 'a' },
    ], registry);
    expect(resolved.map(({ keywordId, sourceId }) => [keywordId, sourceId])).toEqual([
      ['first-layer', undefined],
      ['same-layer', 'a'],
      ['same-layer', 'b'],
      ['late-layer', undefined],
    ]);
  });

  it('closes a three-seat response window after consecutive passes and unwinds LIFO', () => {
    let window = openResponseWindow(['a', 'b', 'c'], 0, [
      { seat: 'a', response: 'trigger' },
    ]);
    window = submitResponse(window, 'a', 'counter-1');
    window = passResponsePriority(window, 'b');
    window = submitResponse(window, 'c', 'counter-2');
    window = timeoutResponsePriority(window); // a
    window = passResponsePriority(window, 'b', 'wait');
    window = passResponsePriority(window, 'c');
    expect(window.closed).toBe(true);
    expect(unwindResponseWindow(window).map(({ response }) => response))
      .toEqual(['counter-2', 'counter-1', 'trigger']);
  });

  it('enumerates declarative targets and reports truncation explicitly', () => {
    const view: TickView = { actions: [], status: 'playing', hud: { actionsUsed: 0 } };
    const exact = enumerateTargetChoices({
      count: 2,
      distinct: true,
      candidates: () => ['a', 'b', 'c'],
    }, view);
    expect(exact).toEqual({
      choices: [['a', 'b'], ['a', 'c'], ['b', 'c']],
      truncated: false,
    });
    expect(enumerateTargetChoices({
      count: { min: 1, max: 3 },
      candidates: () => ['a', 'b'],
    }, view, { maxChoices: 3 })).toMatchObject({
      choices: [['a'], ['b'], ['a', 'a']],
      truncated: true,
    });

    const targetView: TickView = {
      actions: [{ id: 'select', params: 'targets', targetSpecId: 'pair' }],
      status: 'playing',
      hud: { actionsUsed: 0 },
      targetChoices: {
        pair: {
          choices: [[
            { container: 'board', coord: [1, 2] },
            { container: 'hand', coord: 0 },
          ]],
          truncated: false,
        },
      },
    };
    expect(enumerateActions(targetView)).toEqual([{
      id: 'select',
      targets: [
        { container: 'board', coord: [1, 2] },
        { container: 'hand', coord: 0 },
      ],
    }]);
  });

  it('advances phases and expires durations in authored order', () => {
    const hooks: string[] = [];
    const phases = [
      {
        id: 'draw',
        onExit: () => hooks.push('exit:draw'),
      },
      {
        id: 'main',
        onEnter: () => hooks.push('enter:main'),
      },
    ];
    const initial = createPhaseState(phases);
    const advanced = advancePhase({}, initial, phases);
    expect(activePhase(advanced.phase, phases).id).toBe('main');
    expect(advanced.events.map(({ type }) => type)).toEqual([
      'phase.exited',
      'phase.entered',
    ]);
    expect(hooks).toEqual(['exit:draw', 'enter:main']);

    const statuses: TimedStatus<string>[] = [
      { id: 'later', authoredOrder: 2, duration: { kind: 'until-phase-end' }, value: 'b' },
      { id: 'round', authoredOrder: 1, duration: { kind: 'rounds', remaining: 2 }, value: 'r' },
      { id: 'first', authoredOrder: 0, duration: { kind: 'until-phase-end' }, value: 'a' },
      { id: 'shield', authoredOrder: 3, duration: { kind: 'counters', remaining: 2 }, value: 's' },
    ];
    const phase = advanceDurations(statuses, { kind: 'phase-end', phaseId: 'main' });
    expect(phase.expired.map(({ id }) => id)).toEqual(['first', 'later']);
    const spent = spendStatusCounters(phase.active, 'shield', 2);
    expect(spent.expired.map(({ id }) => id)).toEqual(['shield']);
    const round1 = advanceDurations(spent.active, { kind: 'round-end' });
    const round2 = advanceDurations(round1.active, { kind: 'round-end' });
    expect(round2.expired.map(({ id }) => id)).toEqual(['round']);
  });

  it('returns structured deck/squad constraint violations', () => {
    const result = validateDeck([
      { id: 'scout', copies: 3, tags: ['unit'], factions: ['blue'] },
      { id: 'spell', copies: 1, tags: ['spell'], factions: ['red'] },
    ], [
      { id: 'size', kind: 'totalSize', min: 5, max: 6 },
      { id: 'copies', kind: 'copiesLimit', max: 2 },
      { id: 'units', kind: 'tagCount', tag: 'unit', min: 2 },
      { id: 'faction', kind: 'factions', allowed: ['blue'], maxDistinct: 1 },
    ]);
    expect(result.valid).toBe(false);
    expect(result.violations.map(({ code }) => code)).toEqual([
      'total_size_below_min',
      'copies_limit_exceeded',
      'faction_not_allowed',
      'too_many_factions',
    ]);
  });

  it('supports priority draft claims in addition to all-fail arbitration', () => {
    const claims = [
      { id: 'a', resources: ['card:1'], priority: 2, claim: 'a' },
      { id: 'b', resources: ['card:1'], priority: 0, claim: 'b' },
      { id: 'c', resources: ['card:2'], priority: 1, claim: 'c' },
    ];
    expect(arbitrateResourceClaims(claims).accepted.map(({ id }) => id)).toEqual(['c']);
    expect(arbitrateResourceClaims(claims, { mode: 'priority' }).accepted.map(({ id }) => id))
      .toEqual(['b', 'c']);
  });

  it('solves an open-hand solitaire card reducer without solver-specific code', () => {
    interface State {
      cards: string[];
      used: number;
    }
    const reducer: ActionReducer<readonly string[], State> = {
      init: (level) => ({ cards: [...level], used: 0 }),
      apply: (state, action) => {
        if (action.id !== 'play' || action.index === undefined
          || state.cards[action.index] === undefined) throw new Error('illegal');
        return {
          cards: state.cards.filter((_card, index) => index !== action.index),
          used: state.used + 1,
        };
      },
      view: (state) => ({
        actions: state.cards.length > 0 ? [{ id: 'play', params: 'index' }] : [],
        status: state.cards.length === 0 ? 'won' : 'playing',
        hud: {
          actionsUsed: state.used,
          items: state.cards.map((_card, index) => ({ index })),
        },
        zones: {
          hand: {
            count: state.cards.length,
            entries: state.cards.map((id) => ({ id })),
            ordered: true,
          },
        },
      }),
    };
    expect(solveLevel(reducer, ['one', 'two'], { maxActions: 2 })).toMatchObject({
      min: 2,
      actions: [{ id: 'play', index: 0 }, { id: 'play', index: 0 }],
    });
  });
});
