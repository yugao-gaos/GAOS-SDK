import type { TickView } from '../engine/contracts.js';
import type {
  AgentEnvironment,
  AgentStep,
  AgentTranscript,
} from '../engine/agent-environment.js';
import type { AgentDecision, AgentDriver } from './driver.js';

export interface AgentDriverEpisodeResult<TLevel, TView extends TickView<unknown, unknown>> {
  finalStep: AgentStep<TView>;
  transcript: AgentTranscript<TLevel, TView>;
  decisions: AgentDecision[];
}

/** Run one complete deterministic environment episode through an AgentDriver. */
export async function runAgentDriverEpisode<TLevel, TState, TView extends TickView<unknown, unknown>>(
  environment: AgentEnvironment<TLevel, TState, TView>,
  driver: AgentDriver<TView>,
  options: {
    systemPrompt?: string;
    guidance?: readonly string[];
    signal?: AbortSignal;
    onDecision?: (decision: AgentDecision, step: AgentStep<TView>) => void | Promise<void>;
  } = {},
): Promise<AgentDriverEpisodeResult<TLevel, TView>> {
  await driver.reset?.();
  let step = environment.reset();
  const decisions: AgentDecision[] = [];
  while (!step.done) {
    if (options.signal?.aborted) throw options.signal.reason;
    const decision = await driver.act({
      observation: step.observation,
      legalActions: step.legalActions,
      systemActions: step.systemActions,
      actionDefinitions: step.actionDefinitions,
      step: step.info.ticks,
      systemPrompt: options.systemPrompt,
      guidance: options.guidance,
      signal: options.signal,
    });
    decisions.push(decision);
    await options.onDecision?.(decision, step);
    step = environment.step(decision.action);
  }
  return {
    finalStep: step,
    transcript: environment.transcript(),
    decisions,
  };
}
