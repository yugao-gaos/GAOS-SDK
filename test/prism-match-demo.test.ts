import { describe, expect, it } from 'vitest';
import { recheckTranscript } from '../src/engine/index.js';
import {
  PRISM_MATCH_LEVELS,
  createPrismMatchEnvironment,
  prismMatchReducer,
} from '../examples/demos/prism-match.js';

describe('Prism Match GAOS demo reducer', () => {
  it('initializes deterministically and exposes concrete legal swaps', () => {
    const first = createPrismMatchEnvironment(PRISM_MATCH_LEVELS[0]!, 2407);
    const second = createPrismMatchEnvironment(PRISM_MATCH_LEVELS[0]!, 2407);

    const firstStep = first.reset();
    const secondStep = second.reset();

    expect(firstStep).toEqual(secondStep);
    expect(firstStep.observation.board).toHaveLength(49);
    expect(firstStep.legalActions.length).toBeGreaterThan(0);
    expect(firstStep.legalActions.every((action) => (
      action.id === 'Action 1'
      && action.targets?.length === 2
      && action.targets.every((target) => target.container === 'board')
    ))).toBe(true);
  });

  it('routes a swap through AgentEnvironment and records its reducer transition', () => {
    const environment = createPrismMatchEnvironment(PRISM_MATCH_LEVELS[0]!, 2407);
    const initial = environment.reset();
    const action = initial.legalActions[0]!;
    const next = environment.step(action);

    expect(next.info).toMatchObject({ ticks: 1, actionsUsed: 1 });
    expect(next.observation.moves).toBe(initial.observation.moves - 1);
    expect(next.observation.transition).toMatchObject({
      a: initial.observation.legalSwaps[0]!.a,
      b: initial.observation.legalSwaps[0]!.b,
    });
    expect(next.observation.transition!.cascades.length).toBeGreaterThan(0);
    expect(environment.transcript().actions).toEqual([
      expect.objectContaining({ n: 1, action }),
    ]);
  });

  it('replays a complete greedy episode through the generic transcript checker', () => {
    const environment = createPrismMatchEnvironment(PRISM_MATCH_LEVELS[0]!, 2407);
    let step = environment.reset();
    while (!step.done) step = environment.step(step.legalActions[0]!);

    const transcript = environment.transcript();
    const checked = recheckTranscript(prismMatchReducer, {
      sessionId: 'prism-match-demo',
      level: transcript.level,
      seed: transcript.seed,
      perm: [0],
      status: transcript.result.status as 'won' | 'failed',
      stars: null,
      actionsUsed: transcript.result.actionsUsed,
    }, transcript.actions.map(({ n, action }) => ({
      n,
      wireId: 'Action 1',
      canonicalId: action.id,
      targets: action.targets,
    })));

    expect(transcript.result.terminationReason).toMatch(/won|failed/);
    expect(checked).toMatchObject({ ok: true, problems: [] });
  });

  it('rejects swaps outside the reducer-advertised legal action set', () => {
    const state = prismMatchReducer.init(PRISM_MATCH_LEVELS[0]!, 2407);
    expect(() => prismMatchReducer.advance(state, [{
      id: 'Action 1',
      targets: [
        { container: 'board', coord: [0, 0] },
        { container: 'board', coord: [6, 6] },
      ],
    }])).toThrow(/legal swap/);
  });
});
