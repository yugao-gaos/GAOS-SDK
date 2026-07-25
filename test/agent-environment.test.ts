import { describe, expect, it } from 'vitest';
import {
  AgentEnvironment,
  AgentEnvironmentError,
  createAgentToolAdapter,
  evaluateAgentEpisodes,
  runAgentEpisode,
  type ActionReducer,
  type TickView,
} from '../src/engine/index.js';

interface Level { goal: number }
interface State { at: number; actionsUsed: number }

const reducer: ActionReducer<Level, State> = {
  init: () => ({ at: 0, actionsUsed: 0 }),
  apply: (state, action) => {
    if (action.id === 'advance') return { at: state.at + 1, actionsUsed: state.actionsUsed + 1 };
    if (action.id === 'jump' && action.index !== undefined) {
      return { at: state.at + action.index, actionsUsed: state.actionsUsed + 1 };
    }
    if (action.id === 'restart') return { at: 0, actionsUsed: state.actionsUsed + 1 };
    throw new Error('reducer rejected action');
  },
  view: (state): TickView => ({
    actions: [
      { id: 'advance', params: 'none' },
      { id: 'jump', params: 'index' },
    ],
    systemActions: [{ id: 'restart', params: 'none' }],
    status: state.at >= 3 ? 'won' : 'playing',
    ...(state.at >= 3 ? { stars: state.actionsUsed === 2 ? 3 : 2 } : {}),
    hud: { actionsUsed: state.actionsUsed, items: [{ index: 2 }] },
  }),
};

const environment = (maxTicks = 10) => new AgentEnvironment({
  reducer,
  level: { goal: 3 },
  seed: 42,
  maxTicks,
});

describe('AgentEnvironment', () => {
  it('requires reset and exposes concrete legal actions', () => {
    const env = environment();
    expect(() => env.observe()).toThrowError(
      expect.objectContaining<Partial<AgentEnvironmentError>>({ code: 'not_started' }),
    );
    const step = env.reset();
    expect(step.legalActions).toEqual([
      { id: 'advance' },
      { id: 'jump', index: 2 },
    ]);
    expect(step.systemActions).toEqual([{ id: 'restart' }]);
    expect(step.info).toMatchObject({ seed: 42, ticks: 0, totalReward: 0 });
  });

  it('validates system actions separately from legal gameplay actions', () => {
    const env = environment();
    env.reset();
    env.step({ id: 'advance' });
    const restarted = env.step({ id: 'restart' });
    expect(restarted.observation).toMatchObject({ hud: { actionsUsed: 2 } });
    expect(restarted.legalActions.map(({ id }) => id)).not.toContain('restart');
    expect(restarted.systemActions).toEqual([{ id: 'restart' }]);
  });

  it('validates actions, terminates, rewards, and records a transcript', () => {
    const env = environment();
    env.reset();
    expect(() => env.step({ id: 'jump', index: 9 })).toThrowError(
      expect.objectContaining<Partial<AgentEnvironmentError>>({ code: 'illegal_action' }),
    );
    env.step({ id: 'advance' });
    const final = env.step({ id: 'jump', index: 2 });
    expect(final).toMatchObject({ reward: 3, terminated: true, truncated: false, done: true });
    expect(final.info).toMatchObject({ ticks: 2, totalReward: 3, terminationReason: 'won' });
    expect(final.legalActions).toEqual([]);
    expect(env.transcript()).toMatchObject({
      version: '1.3',
      seed: 42,
      actions: [
        { n: 1, action: { id: 'advance' }, reward: 0 },
        { n: 2, action: { id: 'jump', index: 2 }, reward: 3 },
      ],
      result: { terminationReason: 'won' },
    });
    expect(() => env.step({ id: 'advance' })).toThrowError(
      expect.objectContaining<Partial<AgentEnvironmentError>>({ code: 'episode_done' }),
    );
  });

  it('distinguishes a safety truncation from reducer termination', () => {
    const env = environment(1);
    env.reset();
    expect(env.step({ id: 'advance' })).toMatchObject({
      done: true,
      terminated: false,
      truncated: true,
      info: { terminationReason: 'tick_limit' },
    });
  });

  it('replays the same seed and canonical actions deterministically', () => {
    const first = environment();
    const second = environment();
    first.replay([{ id: 'advance' }, { id: 'jump', index: 2 }]);
    second.replay([{ id: 'advance' }, { id: 'jump', index: 2 }]);
    expect(first.transcript()).toEqual(second.transcript());
  });

  it('snapshots level data at reset and isolates returned transcripts', () => {
    const level = { goal: 3 };
    const env = new AgentEnvironment({ reducer, level, seed: 1 });
    env.reset();
    level.goal = 99;
    const first = env.transcript();
    expect(first.level).toEqual({ goal: 3 });
    first.level.goal = 77;
    expect(env.transcript().level).toEqual({ goal: 3 });
  });

  it('supports an explicit snapshot function for non-cloneable level values', () => {
    const level = { goal: 3, helper: () => 3 };
    const customReducer: ActionReducer<typeof level, State> = reducer;
    const env = new AgentEnvironment({
      reducer: customReducer,
      level,
      snapshotLevel: ({ goal, helper }) => ({ goal, helper }),
    });
    expect(env.reset().done).toBe(false);
    expect(env.transcript().level.helper()).toBe(3);
  });
});

describe('agent evaluation', () => {
  it('runs async policies and aggregates deterministic batches', async () => {
    const single = await runAgentEpisode(environment(), async (step) => step.legalActions.at(-1)!);
    expect(single.finalStep.info).toMatchObject({ terminationReason: 'won', ticks: 2 });

    const cases = [
      { id: 'seed-1', level: { goal: 3 }, seed: 1 },
      { id: 'seed-2', level: { goal: 3 }, seed: 2 },
    ];
    const batch = await evaluateAgentEpisodes(
      cases,
      (episode) => new AgentEnvironment({ reducer, level: episode.level, seed: episode.seed }),
      (step) => step.legalActions.at(-1)!,
    );
    expect(batch.summary).toEqual({
      episodes: 2,
      won: 2,
      failed: 0,
      truncated: 0,
      meanReward: 3,
      meanTicks: 2,
    });
  });
});

describe('agent tool adapter', () => {
  it('binds observe, act, reset, and transcript without a provider dependency', () => {
    const env = environment();
    const tools = createAgentToolAdapter(env);
    expect(tools.definitions.map(({ name }) => name)).toEqual([
      'observe', 'act', 'reset', 'transcript',
    ]);
    const actSchema = tools.definitions.find(({ name }) => name === 'act')!
      .inputSchema as {
        properties: { action: { properties: Record<string, unknown> } };
      };
    expect(Object.keys(actSchema.properties.action.properties)).toEqual([
      'id', 'x', 'y', 'index', 'boardId', 'zoneId', 'seat', 'targets',
    ]);
    expect(tools.call('reset', { seed: 7 })).toMatchObject({ info: { seed: 7 } });
    expect(tools.call('act', { action: { id: 'jump', index: 2 } }))
      .toMatchObject({ done: false, info: { ticks: 1 } });
    expect(tools.call('observe')).toMatchObject({ info: { seed: 7, ticks: 1 } });
    expect(tools.call('transcript')).toMatchObject({
      seed: 7,
      actions: [{ action: { id: 'jump', index: 2 } }],
    });
  });
});
