import type { SubmittedAction, TickView } from './contracts.js';
import type {
  AgentEnvironment,
  AgentStep,
  AgentTranscript,
} from './agent-environment.js';

export type AgentPolicy<TView extends TickView<unknown, unknown>> = (
  step: AgentStep<TView>,
) => SubmittedAction | Promise<SubmittedAction>;

export interface AgentEpisodeResult<TLevel, TView extends TickView<unknown, unknown>> {
  finalStep: AgentStep<TView>;
  transcript: AgentTranscript<TLevel, TView>;
}

/** Run one complete episode using a synchronous or asynchronous agent policy. */
export async function runAgentEpisode<TLevel, TState, TView extends TickView<unknown, unknown>>(
  environment: AgentEnvironment<TLevel, TState, TView>,
  policy: AgentPolicy<TView>,
): Promise<AgentEpisodeResult<TLevel, TView>> {
  let step = environment.reset();
  while (!step.done) step = environment.step(await policy(step));
  return { finalStep: step, transcript: environment.transcript() };
}

export interface AgentBatchCase<TLevel> {
  id: string;
  level: TLevel;
  seed: number;
}

export interface AgentBatchEpisode<TLevel, TView extends TickView<unknown, unknown>>
  extends AgentEpisodeResult<TLevel, TView> {
  id: string;
}

export interface AgentBatchResult<TLevel, TView extends TickView<unknown, unknown>> {
  episodes: Array<AgentBatchEpisode<TLevel, TView>>;
  summary: {
    episodes: number;
    won: number;
    failed: number;
    truncated: number;
    meanReward: number;
    meanTicks: number;
  };
}

/** Sequential deterministic batch runner suitable for evaluation harnesses. */
export async function evaluateAgentEpisodes<TLevel, TState, TView extends TickView<unknown, unknown>>(
  cases: readonly AgentBatchCase<TLevel>[],
  createEnvironment: (episode: AgentBatchCase<TLevel>) => AgentEnvironment<TLevel, TState, TView>,
  policy: (step: AgentStep<TView>, episode: AgentBatchCase<TLevel>) => SubmittedAction | Promise<SubmittedAction>,
): Promise<AgentBatchResult<TLevel, TView>> {
  const episodes: Array<AgentBatchEpisode<TLevel, TView>> = [];
  for (const episode of cases) {
    const result = await runAgentEpisode(
      createEnvironment(episode),
      (step) => policy(step, episode),
    );
    episodes.push({ id: episode.id, ...result });
  }
  const count = episodes.length;
  return {
    episodes,
    summary: {
      episodes: count,
      won: episodes.filter(({ finalStep }) => finalStep.info.terminationReason === 'won').length,
      failed: episodes.filter(({ finalStep }) => finalStep.info.terminationReason === 'failed').length,
      truncated: episodes.filter(({ finalStep }) => finalStep.truncated).length,
      meanReward: count === 0
        ? 0
        : episodes.reduce((sum, episode) => sum + episode.finalStep.info.totalReward, 0) / count,
      meanTicks: count === 0
        ? 0
        : episodes.reduce((sum, episode) => sum + episode.finalStep.info.ticks, 0) / count,
    },
  };
}
