import { describe, expect, it } from 'vitest';
import {
  AgentEnvironment,
  MultiAgentEnvironment,
  runMultiAgentEpisode,
  type ActionReducer,
  type TickView,
} from '../src/engine/index.js';

describe('agent decision cadence', () => {
  interface State {
    tick: number;
    actions: string[];
  }

  const reducer: ActionReducer<null, State> = {
    init: () => ({ tick: 0, actions: [] }),
    apply: (state, action) => ({
      tick: state.tick + 1,
      actions: [...state.actions, action.id],
    }),
    view: (state) => ({
      actions: state.tick < 3 ? [{ id: 'hold', params: 'none' }] : [],
      status: state.tick >= 3 ? 'won' : 'playing',
      hud: { actionsUsed: state.tick },
    }),
  };

  it('advances exactly one tick per environment step', () => {
    const environment = new AgentEnvironment({ reducer, level: null });
    environment.reset();
    const first = environment.step({ id: 'hold' });
    expect(first).toMatchObject({
      done: false,
      info: { ticks: 1, actionsUsed: 1 },
    });
    environment.step({ id: 'hold' });
    const final = environment.step({ id: 'hold' });
    expect(final).toMatchObject({ done: true, info: { ticks: 3 } });
    const transcript = environment.transcript();
    expect(transcript).toMatchObject({
      version: '1.3',
      actions: [
        { n: 1, action: { id: 'hold' } },
        { n: 2, action: { id: 'hold' } },
        { n: 3, action: { id: 'hold' } },
      ],
    });
    const replayed = new AgentEnvironment({ reducer, level: null });
    replayed.replay(transcript.actions.map(({ action }) => action));
    expect(replayed.transcript()).toEqual(transcript);
  });

  it('leaves action repetition to the product policy', () => {
    const changing: ActionReducer<null, State> = {
      ...reducer,
      view: (state) => ({
        actions: state.tick === 0
          ? [{ id: 'charge', params: 'none' }]
          : state.tick === 1
            ? [{ id: 'release', params: 'none' }]
            : [],
        status: state.tick >= 2 ? 'won' : 'playing',
        hud: { actionsUsed: state.tick },
      }),
    };
    const environment = new AgentEnvironment({ reducer: changing, level: null });
    environment.reset();
    expect(environment.step({ id: 'charge' })).toMatchObject({
      done: false,
      info: { ticks: 1 },
    });
    expect(environment.step({ id: 'release' })).toMatchObject({
      done: true,
      info: { ticks: 2 },
    });
  });
});

describe('multi-agent episodes', () => {
  interface State {
    round: number;
    trace: string[];
  }

  interface View extends TickView {
    privateValue: string;
  }

  const reducer: ActionReducer<null, State, View> = {
    init: () => ({ round: 0, trace: [] }),
    apply: () => {
      throw new Error('simultaneous reducer must not serially apply intents');
    },
    applyIntents: (state, actions) => ({
      round: state.round + 1,
      trace: [...state.trace, ...actions.map(({ seat, id }) => `${seat}:${id}`)],
    }),
    view: (state) => ({
      actions: [],
      status: 'playing',
      participation: { mode: 'simultaneous', seats: ['b', 'a'] },
      outcome: state.round === 0
        ? { kind: 'ongoing' }
        : {
          kind: 'decided',
          ranking: [
            { seat: 'b', rank: 1, score: 2 },
            { seat: 'a', rank: 2 },
          ],
        },
      hud: { actionsUsed: state.round },
      privateValue: 'full',
    }),
    viewFor: (state, seat) => ({
      actions: state.round === 0 ? [{ id: `move-${seat}`, params: 'none' }] : [],
      status: 'playing',
      participation: { mode: 'simultaneous', seats: ['b', 'a'] },
      outcome: state.round === 0
        ? { kind: 'ongoing' }
        : {
          kind: 'decided',
          ranking: [
            { seat: 'b', rank: 1, score: 2 },
            { seat: 'a', rank: 2 },
          ],
        },
      hud: { actionsUsed: state.round },
      privateValue: `only:${seat}`,
    }),
  };

  it('collects seat-scoped actions, commits one canonical batch, and rewards each seat', () => {
    const environment = new MultiAgentEnvironment({
      reducer,
      level: null,
      seats: ['b', 'a'],
      seed: 7,
    });
    const initial = environment.reset();
    expect(initial.participatingSeats).toEqual(['a', 'b']);
    expect(initial.seats.a?.observation.privateValue).toBe('only:a');
    const final = environment.step({
      b: { id: 'move-b' },
      a: { id: 'move-a' },
    });
    expect(final).toMatchObject({
      done: true,
      seats: {
        a: { reward: 0, totalReward: 0 },
        b: { reward: 2, totalReward: 2 },
      },
    });
    const transcript = environment.transcript();
    expect(transcript).toMatchObject({
      version: '1.1',
      seats: ['a', 'b'],
      initialObservations: {
        a: { privateValue: 'only:a' },
        b: { privateValue: 'only:b' },
      },
      ticks: [{
        actions: [
          { id: 'move-a', seat: 'a' },
          { id: 'move-b', seat: 'b' },
        ],
        observations: {
          a: { privateValue: 'only:a' },
          b: { privateValue: 'only:b' },
        },
      }],
      result: {
        totalRewards: { a: 0, b: 2 },
      },
    });
    const replayed = new MultiAgentEnvironment({
      reducer,
      level: null,
      seats: ['a', 'b'],
      seed: 7,
    });
    replayed.replay(transcript.ticks.map(({ actions }) => actions));
    expect(replayed.transcript()).toEqual(transcript);
  });

  it('runs independent seat policies against one shared verifiable transcript', async () => {
    const environment = new MultiAgentEnvironment({
      reducer,
      level: null,
      seats: ['a', 'b'],
    });
    const episode = await runMultiAgentEpisode(environment, {
      a: (step) => step.legalActions[0],
      b: (step) => step.legalActions[0],
    });
    expect(episode.finalStep.done).toBe(true);
    expect(episode.transcript.ticks).toHaveLength(1);
  });
});
