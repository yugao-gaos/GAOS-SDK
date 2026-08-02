import { describe, expect, it } from 'vitest';
import {
  CINDER_ACTIONS,
  CINDER_LEVEL,
  chooseCinderVaultAction,
  cinderVaultReducer,
  createCinderVaultEnvironment,
  type CinderVaultState,
} from '../examples/demos/cinder-vault.js';

describe('Cinder Vault GAOS demo reducer', () => {
  it('initializes its shuffled hand and concrete plan actions deterministically', () => {
    const first = createCinderVaultEnvironment(616).reset();
    const second = createCinderVaultEnvironment(616).reset();

    expect(first).toEqual(second);
    expect(first.observation.room).toBe(1);
    expect(first.observation.hand).toHaveLength(4);
    expect(first.observation.enemies).toHaveLength(2);
    expect(first.legalActions.length).toBeGreaterThan(0);
    expect(first.legalActions.every((action) => (
      action.id.startsWith('Action ')
      && (action.x === undefined || Number.isInteger(action.x))
      && (action.y === undefined || Number.isInteger(action.y))
    ))).toBe(true);
    expect('enemyIntents' in first.observation).toBe(false);
  });

  it('programs card targets and commits a three-beat simultaneous transition', () => {
    const environment = createCinderVaultEnvironment(616);
    let step = environment.reset();
    const programmed = [];

    while (step.observation.queue.length < 3) {
      const action = chooseCinderVaultAction(step.observation);
      expect(action.id).not.toBe(CINDER_ACTIONS.commit);
      programmed.push(action);
      step = environment.step(action);
    }

    const committed = environment.step({ id: CINDER_ACTIONS.commit });

    expect(committed.observation.transition?.beats).toHaveLength(3);
    expect(committed.observation.transition?.plans).toHaveLength(3);
    expect(committed.observation.queue).toHaveLength(0);
    expect(committed.observation.turn).toBe(2);
    expect(environment.transcript().actions).toHaveLength(programmed.length + 1);
  });

  it('resolves forced movement, spike damage, and disrupted enemy intent', () => {
    const initialized = cinderVaultReducer.init(CINDER_LEVEL, 616);
    const state: CinderVaultState = {
      ...initialized,
      hero: { ...initialized.hero, x: 2, y: 4 },
      hand: ['bash'],
      drawPile: [],
      discardPile: [],
      queue: [],
    };
    const planned = cinderVaultReducer.advance(state, [{
      id: CINDER_ACTIONS.bash,
      x: 3,
      y: 4,
    }]);
    const resolved = cinderVaultReducer.advance(planned, [{
      id: CINDER_ACTIONS.commit,
    }]);
    const view = cinderVaultReducer.view(resolved);
    const firstBeatAshling = view.transition?.beats[0]?.after.enemies
      .find(({ id }) => id === 'ash-a');

    expect(firstBeatAshling).toMatchObject({ x: 4, y: 4, hp: 1 });
    expect(view.transition?.beats[0]).toMatchObject({
      plan: { card: { kind: 'bash' } },
      lastEvent: "Ashling's intent was disrupted by forced movement.",
    });
  });

  it('replays a multi-turn planner transcript identically', () => {
    const environment = createCinderVaultEnvironment(616);
    let step = environment.reset();

    for (let index = 0; index < 12 && !step.done; index += 1) {
      step = environment.step(chooseCinderVaultAction(step.observation));
      if (step.observation.roomCleared) break;
    }

    const transcript = environment.transcript();
    const actions = transcript.actions.map(({ action }) => action);
    const replayed = createCinderVaultEnvironment(616).replay(actions);

    expect(actions.length).toBeGreaterThan(3);
    expect(replayed.observation).toEqual(step.observation);
  });

  it('rejects plans outside the advertised card-target action set', () => {
    const state = cinderVaultReducer.init(CINDER_LEVEL, 616);
    expect(() => cinderVaultReducer.advance(state, [{
      id: CINDER_ACTIONS.step,
      x: 5,
      y: 0,
    }])).toThrow(/legal action/);
  });
});
