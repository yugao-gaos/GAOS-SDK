import { describe, expect, it } from 'vitest';
import {
  LAST_LIGHT_ACTIONS,
  LAST_LIGHT_LEVEL,
  chooseLastLightAction,
  createLastLightEnvironment,
  lastLightReducer,
  type LastLightState,
} from '../examples/demos/last-light.js';

describe('Last Light GAOS demo reducer', () => {
  it('initializes deterministic defense state and indexed build actions', () => {
    const first = createLastLightEnvironment(404).reset();
    const second = createLastLightEnvironment(404).reset();

    expect(first).toEqual(second);
    expect(first.observation).toMatchObject({
      tick: 0,
      wave: 1,
      scrap: 90,
      safehouseHp: 12,
    });
    expect(first.observation.legalBuilds).toHaveLength(24);
    expect(first.legalActions).toContainEqual({ id: LAST_LIGHT_ACTIONS.hold });
    expect(first.observation.transition).toBeUndefined();
  });

  it('spawns the authored wave sequence on input-free ticks', () => {
    let state = lastLightReducer.init(LAST_LIGHT_LEVEL, 404);
    for (let tick = 0; tick < 18; tick += 1) state = lastLightReducer.advance(state, []);
    const view = lastLightReducer.view(state);

    expect(view.tick).toBe(18);
    expect(view.spawned).toBe(1);
    expect(view.zombies[0]).toMatchObject({
      type: 'Runner',
      route: 0,
      hp: 3,
      maxHp: 3,
    });
    expect(view.transition?.spawned).toHaveLength(1);
  });

  it('builds through a structured action and charges scrap', () => {
    const state = lastLightReducer.init(LAST_LIGHT_LEVEL, 404);
    const initial = lastLightReducer.view(state);
    const build = initial.legalBuilds.find((option) => (
      option.socket === 2 && option.kind === 'molotov'
    ));
    expect(build).toBeDefined();

    const built = lastLightReducer.advance(state, [build!.action]);
    const view = lastLightReducer.view(built);

    expect(view.scrap).toBe(40);
    expect(view.towers).toContainEqual({ socket: 2, kind: 'molotov', cooldown: 0 });
    expect(view.transition?.built[0]).toMatchObject({ socket: 2, kind: 'molotov', cost: 50 });
  });

  it('applies floodlight slow before zombie movement', () => {
    const initialized = lastLightReducer.init(LAST_LIGHT_LEVEL, 404);
    const state: LastLightState = {
      ...initialized,
      towers: [{ socket: 0, kind: 'floodlight', cooldown: 0 }],
      zombies: [{
        id: 1,
        type: 'Shambler',
        route: 0,
        segment: 0,
        progress: 50,
        hp: 4,
        maxHp: 4,
        speed: 1.15,
      }],
      nextZombieId: 1,
    };
    const advanced = lastLightReducer.advance(state, []);
    const zombie = lastLightReducer.view(advanced).zombies[0];

    expect(zombie?.slowed).toBe(true);
    expect(zombie?.progress).toBeCloseTo(50 + 1.15 * 0.55);
  });

  it('resolves tower damage, defeat scrap, and breach damage as transition events', () => {
    const initialized = lastLightReducer.init(LAST_LIGHT_LEVEL, 404);
    const attackState: LastLightState = {
      ...initialized,
      towers: [{ socket: 0, kind: 'rifle', cooldown: 0 }],
      zombies: [{
        id: 1,
        type: 'Runner',
        route: 0,
        segment: 0,
        progress: 50,
        hp: 2,
        maxHp: 3,
        speed: 1.9,
      }],
      nextZombieId: 1,
    };
    const attacked = lastLightReducer.advance(attackState, []);
    const attackView = lastLightReducer.view(attacked);

    expect(attackView.zombies).toHaveLength(0);
    expect(attackView.scrap).toBe(94);
    expect(attackView.transition?.attacks[0]).toMatchObject({
      socket: 0,
      kind: 'rifle',
      targets: [{ zombieId: 1, damage: 2, lethal: true }],
    });

    const breachState: LastLightState = {
      ...initialized,
      zombies: [{
        id: 2,
        type: 'Brute',
        route: 0,
        segment: 3,
        progress: 99.5,
        hp: 10,
        maxHp: 10,
        speed: 0.72,
      }],
      nextZombieId: 2,
    };
    const breached = lastLightReducer.advance(breachState, []);
    const breachView = lastLightReducer.view(breached);

    expect(breachView.safehouseHp).toBe(9);
    expect(breachView.zombies).toHaveLength(0);
    expect(breachView.transition?.breaches[0]).toMatchObject({
      zombieId: 2,
      type: 'Brute',
      damage: 3,
    });
  });

  it('advances cleared waves and replays local-builder ticks identically', () => {
    const initialized = lastLightReducer.init(LAST_LIGHT_LEVEL, 404);
    const cleared = lastLightReducer.advance({
      ...initialized,
      spawned: 8,
      zombies: [],
    }, []);
    expect(lastLightReducer.view(cleared)).toMatchObject({ wave: 2, spawned: 0, scrap: 125 });

    const environment = createLastLightEnvironment(404);
    let step = environment.reset();
    for (let index = 0; index < 100 && !step.done; index += 1) {
      const action = step.observation.tick > 0 && step.observation.tick % 30 === 0
        ? chooseLastLightAction(step.observation)
        : { id: LAST_LIGHT_ACTIONS.hold };
      step = environment.step(action);
    }
    const actions = environment.transcript().actions.map(({ action }) => action);
    const replayed = createLastLightEnvironment(404).replay(actions);

    expect(replayed.observation).toEqual(step.observation);
  });

  it('rejects builds outside the advertised action set', () => {
    const state = lastLightReducer.init(LAST_LIGHT_LEVEL, 404);
    expect(() => lastLightReducer.advance(state, [{
      id: LAST_LIGHT_ACTIONS.build,
      index: 999,
    }])).toThrow(/legal action/);
  });
});
