import { describe, expect, it } from 'vitest';
import {
  ASHFALL_ACTIONS,
  ASHFALL_LEVEL,
  chooseAshfallAction,
  createAshfallEnvironment,
  ashfallReducer,
  type AshfallAttackOption,
} from '../examples/demos/ashfall-crossing.js';

describe('Ashfall Crossing GAOS demo reducer', () => {
  it('initializes the speed timeline and concrete hex actions deterministically', () => {
    const first = createAshfallEnvironment(903).reset();
    const second = createAshfallEnvironment(903).reset();

    expect(first).toEqual(second);
    expect(first.observation.active?.id).toBe('e-ranger');
    expect(first.observation.active?.nextAt).toBe(63);
    expect(first.observation.units).toHaveLength(6);
    expect(first.observation.cells).toHaveLength(19);
    expect(first.legalActions.length).toBeGreaterThan(0);
    expect(first.legalActions.every((action) => (
      action.id === ASHFALL_ACTIONS.move || action.id === ASHFALL_ACTIONS.attack
    ))).toBe(true);
    expect(first.legalActions.every((action) => (
      Number.isInteger(action.x) && Number.isInteger(action.y)
    ))).toBe(true);
  });

  it('routes movement through AgentEnvironment and records the timeline transition', () => {
    const environment = createAshfallEnvironment(903);
    const initial = environment.reset();
    const move = initial.legalActions.find(({ id }) => id === ASHFALL_ACTIONS.move)!;
    const active = initial.observation.active!;
    const next = environment.step(move);

    expect(next.observation.units.find(({ id }) => id === active.id)).toMatchObject({
      q: move.x,
      r: move.y,
      nextAt: active.nextAt + Math.ceil((100 * 100) / active.speed),
    });
    expect(next.observation.transition).toMatchObject({
      kind: 'move',
      unitId: active.id,
      to: { q: move.x, r: move.y },
    });
    expect(environment.transcript().actions).toEqual([
      expect.objectContaining({ n: 1, action: move }),
    ]);
  });

  it('applies attack damage, recovery, and cooldown from one structured action', () => {
    const environment = createAshfallEnvironment(903);
    let step = environment.reset();
    let attack = step.observation.legalOptions.find(
      (option): option is AshfallAttackOption => option.kind === 'attack',
    );

    for (let index = 0; !attack && index < 40; index += 1) {
      step = environment.step(chooseAshfallAction(step.observation));
      attack = step.observation.legalOptions.find(
        (option): option is AshfallAttackOption => option.kind === 'attack',
      );
    }

    expect(attack).toBeDefined();
    const attacker = step.observation.active!;
    const target = step.observation.units.find(({ id }) => id === attack!.targetId)!;
    const next = environment.step(attack!.action);
    const updatedAttacker = next.observation.units.find(({ id }) => id === attacker.id)!;
    const updatedTarget = next.observation.units.find(({ id }) => id === target.id)!;

    expect(updatedTarget.hp).toBe(Math.max(0, target.hp - attacker.damage));
    expect(updatedAttacker.nextAt).toBe(
      attacker.nextAt + Math.ceil((attack!.recovery * 100) / attacker.speed),
    );
    expect(updatedAttacker.attackReady).toBe(
      attacker.nextAt + Math.ceil((180 * 100) / attacker.speed),
    );
    expect(next.observation.transition).toMatchObject({
      kind: 'attack',
      unitId: attacker.id,
      targetId: target.id,
      damage: attacker.damage,
      lethal: target.hp <= attacker.damage,
    });
  });

  it('replays a complete evaluator battle identically from its transcript actions', () => {
    const environment = createAshfallEnvironment(903);
    let step = environment.reset();

    while (!step.done) step = environment.step(chooseAshfallAction(step.observation));

    const transcript = environment.transcript();
    const actions = transcript.actions.map(({ action }) => action);
    const replayed = createAshfallEnvironment(903).replay(actions);

    expect(transcript.result.terminationReason).toMatch(/won|failed/);
    expect(actions.length).toBeLessThan(200);
    expect(replayed.observation).toEqual(step.observation);
  });

  it('rejects coordinates outside the reducer-advertised action set', () => {
    const state = ashfallReducer.init(ASHFALL_LEVEL, 903);
    expect(() => ashfallReducer.advance(state, [{
      id: ASHFALL_ACTIONS.move,
      x: 0,
      y: -1,
    }])).toThrow(/legal action/);
  });
});
