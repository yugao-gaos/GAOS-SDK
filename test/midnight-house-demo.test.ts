import { describe, expect, it } from 'vitest';
import {
  MIDNIGHT_HOUSE_ACTIONS,
  chooseMidnightHouseAction,
  createMidnightHouseEnvironment,
  midnightHouseReducer,
} from '../examples/demos/midnight-house.js';

describe('Midnight House GAOS demo reducer', () => {
  it('deals deterministically through structured zones and resource views', () => {
    const first = createMidnightHouseEnvironment(1701).reset();
    const second = createMidnightHouseEnvironment(1701).reset();

    expect(first).toEqual(second);
    expect(first.observation.player).toHaveLength(2);
    expect(first.observation.dealer).toHaveLength(2);
    expect(first.observation.dealer[1]).toBeNull();
    expect(first.observation.zones).toMatchObject({
      deck: { count: 48 },
      player: { count: 2 },
      dealer: { count: 2 },
      favorHand: { count: 3 },
    });
    expect(first.observation.resources).toEqual({ chips: 225, favor: 3 });
    expect(first.legalActions.map(({ id }) => id)).toContain(MIDNIGHT_HOUSE_ACTIONS.hit);
  });

  it('redacts the dealer hole card from observations and every transition frame', () => {
    let seed = 1;
    let state = midnightHouseReducer.init({ bet: 25 }, seed);
    while (!midnightHouseReducer.view(state).actions.some(
      ({ id }) => id === MIDNIGHT_HOUSE_ACTIONS.cut,
    )) {
      seed += 1;
      state = midnightHouseReducer.init({ bet: 25 }, seed);
    }

    const fullBefore = midnightHouseReducer.view(state);
    const privateHole = fullBefore.dealer[1];
    expect(privateHole).not.toBeNull();
    expect(midnightHouseReducer.viewFor!(state, 'player').dealer[1]).toBeNull();

    const next = midnightHouseReducer.advance(state, [{ id: MIDNIGHT_HOUSE_ACTIONS.cut }]);
    const full = midnightHouseReducer.view(next);
    const player = midnightHouseReducer.viewFor!(next, 'player');

    expect(full.dealer[1]).toEqual(privateHole);
    expect(full.transition?.frames.every((frame) => frame.dealer[1] !== null)).toBe(true);
    expect(player.dealer[1]).toBeNull();
    expect(player.dealerValue).toBeNull();
    expect(player.zones!.dealer!.entries?.[1]).toMatchObject({ hidden: true });
    expect(player.transition?.frames.every((frame) => (
      frame.dealer[1] === null && frame.dealerValue === null
    ))).toBe(true);
  });

  it('routes strategy decisions through AgentEnvironment and replays identically', () => {
    const environment = createMidnightHouseEnvironment(1701);
    let step = environment.reset();
    const actions = [];

    while (step.observation.phase === 'player' && actions.length < 20) {
      const action = chooseMidnightHouseAction(step.observation);
      expect(step.legalActions).toContainEqual(action);
      actions.push(action);
      step = environment.step(action);
    }

    expect(step.observation.phase).toBe('settled');
    expect(actions.length).toBeGreaterThan(0);
    expect(environment.transcript().actions).toHaveLength(actions.length);

    const replayed = createMidnightHouseEnvironment(1701).replay(actions);
    expect(replayed.observation).toEqual(step.observation);
  });

  it('enumerates favor follow-up selections as indexed structured actions', () => {
    let foundTwist = false;
    let foundAce = false;

    for (let seed = 1; seed <= 500 && (!foundTwist || !foundAce); seed += 1) {
      const environment = createMidnightHouseEnvironment(seed);
      const initial = environment.reset();
      for (const action of initial.legalActions) {
        if (action.id === MIDNIGHT_HOUSE_ACTIONS.twist && !foundTwist) {
          const next = environment.step(action);
          expect(next.legalActions).toEqual([
            { id: MIDNIGHT_HOUSE_ACTIONS.chooseTwist, index: 0 },
            { id: MIDNIGHT_HOUSE_ACTIONS.chooseTwist, index: 1 },
          ]);
          foundTwist = true;
          break;
        }
        if (action.id === MIDNIGHT_HOUSE_ACTIONS.ace && !foundAce) {
          const next = environment.step(action);
          expect(next.legalActions).toEqual(initial.observation.player.map((_card, index) => ({
            id: MIDNIGHT_HOUSE_ACTIONS.chooseAce,
            index,
          })));
          foundAce = true;
          break;
        }
      }
    }

    expect({ foundTwist, foundAce }).toEqual({ foundTwist: true, foundAce: true });
  });

  it('rejects actions outside the reducer-advertised legal set', () => {
    const state = midnightHouseReducer.init({ bet: 25 }, 1701);
    expect(() => midnightHouseReducer.advance(state, [{
      id: MIDNIGHT_HOUSE_ACTIONS.chooseTwist,
      index: 99,
    }])).toThrow(/legal action/);
  });
});
