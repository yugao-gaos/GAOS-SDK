import {
  AgentEnvironment,
  runAgentEpisode,
  type TickReducer,
  type TickView,
} from '../src/engine/index.js';

type Level = { goal: number };
type State = { position: number; steps: number };

const reducer: TickReducer<Level, State> = {
  init: () => ({ position: 0, steps: 0 }),
  advance: (state, inputs) => {
    const action = inputs[0];
    if (!action) return state;
    if (action.id !== 'advance') throw new Error('illegal action');
    return { position: state.position + 1, steps: state.steps + 1 };
  },
  view: (state): TickView => ({
    actions: [{ id: 'advance', params: 'none' }],
    status: state.position >= 3 ? 'won' : 'playing',
    hud: { actionsUsed: state.steps },
  }),
};

const environment = new AgentEnvironment({
  reducer,
  level: { goal: 3 },
  seed: 42,
});

const episode = await runAgentEpisode(
  environment,
  (step) => step.legalActions[0]!,
);

console.log(JSON.stringify(episode.transcript, null, 2));
