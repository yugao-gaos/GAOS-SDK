import { describe, expect, it } from 'vitest';
import {
  STARLINE_ACTIONS,
  STARLINE_LEVEL,
  chooseStarlineAction,
  createStarlineEnvironment,
  starlineReducer,
  type StarlineState,
} from '../examples/demos/starline-dominion.js';

describe('Starline Dominion GAOS demo reducer', () => {
  it('initializes a deterministic graph observation and structured fleet orders', () => {
    const first = createStarlineEnvironment(731).reset();
    const second = createStarlineEnvironment(731).reset();

    expect(first).toEqual(second);
    expect(first.observation.tick).toBe(0);
    expect(first.observation.planets).toHaveLength(7);
    expect(first.observation.edges).toHaveLength(10);
    expect(first.observation.legalLaunches.length).toBeGreaterThan(0);
    expect(first.legalActions).toContainEqual({ id: STARLINE_ACTIONS.hold });
    expect(first.observation.transition).toBeUndefined();
  });

  it('advances autonomous systems on empty-input ticks', () => {
    let state = starlineReducer.init(STARLINE_LEVEL, 731);
    for (let tick = 0; tick < 18; tick += 1) {
      state = starlineReducer.advance(state, []);
    }
    const view = starlineReducer.view(state);

    expect(view.tick).toBe(18);
    expect(view.planets.find(({ id }) => id === 'home')?.strength).toBe(37);
    expect(view.planets.find(({ id }) => id === 'enemy')?.strength).toBeLessThan(37);
    expect(view.fleets.some(({ owner }) => owner === 'agent')).toBe(true);
  });

  it('launches half a human garrison and captures after deterministic travel', () => {
    let state = starlineReducer.init(STARLINE_LEVEL, 731);
    const initial = starlineReducer.view(state);
    const launch = initial.legalLaunches.find((option) => (
      option.from === 'home' && option.to === 'mine' && option.ratio === 0.5
    ));
    expect(launch).toBeDefined();

    state = starlineReducer.advance(state, [launch!.action]);
    let view = starlineReducer.view(state);
    const fleet = view.fleets.find(({ owner }) => owner === 'human');

    expect(view.planets.find(({ id }) => id === 'home')?.strength).toBe(17);
    expect(fleet).toMatchObject({ from: 'home', to: 'mine', strength: 17, progress: 1 });

    for (let tick = 1; tick < fleet!.duration; tick += 1) {
      state = starlineReducer.advance(state, []);
    }
    view = starlineReducer.view(state);

    expect(view.fleets.some(({ id }) => id === fleet!.id)).toBe(false);
    expect(view.planets.find(({ id }) => id === 'mine')).toMatchObject({
      owner: 'human',
      strength: 7,
    });
  });

  it('settles opposing lane fleets before either can arrive', () => {
    const initialized = starlineReducer.init(STARLINE_LEVEL, 731);
    const state: StarlineState = {
      ...initialized,
      fleets: [
        {
          id: 1,
          owner: 'human',
          from: 'home',
          to: 'mine',
          strength: 8,
          progress: 13,
          duration: 27,
        },
        {
          id: 2,
          owner: 'agent',
          from: 'mine',
          to: 'home',
          strength: 5,
          progress: 13,
          duration: 27,
        },
      ],
      nextFleetId: 2,
    };
    const resolved = starlineReducer.advance(state, []);
    const view = starlineReducer.view(resolved);

    expect(view.fleets).toEqual([
      expect.objectContaining({ id: 1, owner: 'human', strength: 3 }),
    ]);
    expect(view.clashes).toHaveLength(1);
    expect(view.transition?.clashes[0]).toMatchObject({
      humanStrength: 8,
      agentStrength: 5,
      survivor: 'human',
      survivorStrength: 3,
    });
  });

  it('replays mixed Hold and local-policy ticks identically', () => {
    const environment = createStarlineEnvironment(731);
    let step = environment.reset();

    for (let index = 0; index < 54 && !step.done; index += 1) {
      const action = step.observation.tick % 18 === 9
        ? chooseStarlineAction(step.observation)
        : { id: STARLINE_ACTIONS.hold };
      step = environment.step(action);
    }

    const actions = environment.transcript().actions.map(({ action }) => action);
    const replayed = createStarlineEnvironment(731).replay(actions);

    expect(replayed.observation).toEqual(step.observation);
  });

  it('rejects fleet orders outside the advertised action set', () => {
    const state = starlineReducer.init(STARLINE_LEVEL, 731);
    expect(() => starlineReducer.advance(state, [{
      id: STARLINE_ACTIONS.launch,
      index: 999,
    }])).toThrow(/legal action/);
  });
});
