import type {
  SessionAttachReceipt,
  SessionHandle,
  SessionResult,
} from '../client.js';
import type { JsonObject, TickResult } from '../protocol.js';
import type { ActionDefinition, SubmittedAction } from '../engine/contracts.js';
import type {
  AgentDecision,
  AgentDriver,
  AgentDriverContext,
} from './driver.js';

export type SessionPacing = 'paced' | 'unpaced';

export interface SessionRunPolicy {
  pacing: SessionPacing;
  conversation: 'continuous' | 'fresh-per-episode';
  finalize: 'automatic' | 'caller';
  /** Maximum concurrent presentation calls when pacing is `unpaced`. */
  maxPendingPresentations?: number;
}

export interface SessionEpisodeIdentity {
  id: string;
  index?: number;
  extensions?: JsonObject;
}

export interface SessionPresentation<TObservation> {
  present(
    result: TickResult<TObservation>,
    signal?: AbortSignal,
  ): void | Promise<void>;
}

export interface SessionRunEvents<TObservation, TOutcome> {
  onObservation?(result: TickResult<TObservation>): void | Promise<void>;
  onDecision?(decision: AgentDecision): void | Promise<void>;
  onEpisodeChange?(episode: SessionEpisodeIdentity): void | Promise<void>;
  onAttached?(receipt?: SessionAttachReceipt): void | Promise<void>;
  onFinalized?(result: SessionResult<TOutcome>): void | Promise<void>;
}

export interface SessionObservationAdapter<TObservation> {
  context(
    result: TickResult<TObservation>,
    step: number,
    signal?: AbortSignal,
  ): AgentDriverContext<TObservation>;
  terminal(result: TickResult<TObservation>): boolean;
  episode?(result: TickResult<TObservation>): SessionEpisodeIdentity | undefined;
}

export interface SessionRunResult<TOutcome> {
  status: 'terminal' | 'finalized';
  observations: number;
  decisions: readonly AgentDecision[];
  result?: SessionResult<TOutcome>;
}

interface StandardObservation {
  legalActions?: readonly SubmittedAction[];
  systemActions?: readonly SubmittedAction[];
  actionDefinitions?: readonly ActionDefinition[];
  status?: string;
  done?: boolean;
}

function standardObservation<TObservation>(
  result: TickResult<TObservation>,
): StandardObservation {
  return result.tick && typeof result.tick === 'object'
    ? result.tick as StandardObservation
    : {};
}

function extensionEpisode<TObservation>(
  result: TickResult<TObservation>,
): SessionEpisodeIdentity | undefined {
  const value = result.extensions?.['gaos.session.episode'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const episode = value as JsonObject;
  if (typeof episode['id'] !== 'string' || !episode['id']) return undefined;
  const index = episode['index'];
  return {
    id: episode['id'],
    ...(typeof index === 'number' && Number.isSafeInteger(index) ? { index } : {}),
    extensions: structuredClone(episode),
  };
}

function defaultObservationAdapter<TObservation>(): SessionObservationAdapter<TObservation> {
  return {
    context(result, step, signal) {
      const observation = standardObservation(result);
      return {
        observation: result.tick,
        legalActions: observation.legalActions ?? [],
        ...(observation.systemActions ? { systemActions: observation.systemActions } : {}),
        ...(observation.actionDefinitions
          ? { actionDefinitions: observation.actionDefinitions }
          : {}),
        step,
        signal,
      };
    },
    terminal(result) {
      const observation = standardObservation(result);
      return observation.done === true
        || (typeof observation.status === 'string' && observation.status !== 'playing');
    },
    episode: extensionEpisode,
  };
}

/**
 * Run every agent-controlled live session through the same observe/act loop.
 * Presentation is ordered and blocking only when the policy is `paced`.
 */
export async function runSession<TCommand, TObservation, TOutcome>(
  session: SessionHandle<TCommand, TObservation, TOutcome>,
  driver: AgentDriver<TObservation>,
  options: {
    policy: SessionRunPolicy;
    presentation?: SessionPresentation<TObservation>;
    events?: SessionRunEvents<TObservation, TOutcome>;
    observationAdapter?: SessionObservationAdapter<TObservation>;
    signal?: AbortSignal;
  },
): Promise<SessionRunResult<TOutcome>> {
  if (session.status !== 'active' && session.status !== 'terminal') {
    throw new Error(`cannot run a ${session.status} session handle`);
  }
  const maxPendingPresentations = options.policy.maxPendingPresentations ?? 32;
  if (
    !Number.isSafeInteger(maxPendingPresentations)
    || maxPendingPresentations < 1
  ) {
    throw new RangeError('maxPendingPresentations must be a positive safe integer');
  }
  const adapter = options.observationAdapter ?? defaultObservationAdapter<TObservation>();
  const decisions: AgentDecision[] = [];
  const backgroundPresentations = new Set<Promise<void>>();
  let backgroundFailure: { error: unknown } | undefined;
  let observations = 0;
  let priorEpisode: SessionEpisodeIdentity | undefined;

  const trackPresentation = (presentation: Promise<void>): void => {
    const tracked = presentation.catch((error: unknown) => {
      backgroundFailure ??= { error };
    });
    backgroundPresentations.add(tracked);
    void tracked.then(() => backgroundPresentations.delete(tracked));
  };
  const throwBackgroundFailure = (): void => {
    if (backgroundFailure) throw backgroundFailure.error;
  };

  if (options.policy.conversation === 'fresh-per-episode') {
    await driver.reset?.();
  }
  if (session.attachReceipt !== undefined) {
    await options.events?.onAttached?.(session.attachReceipt);
  }

  let observed = await session.observe({ signal: options.signal });
  while (true) {
    throwBackgroundFailure();
    if (options.signal?.aborted) throw options.signal.reason;
    observations += 1;
    await options.events?.onObservation?.(observed);

    if (options.presentation) {
      const presentation = Promise.resolve(
        options.presentation.present(observed, options.signal),
      );
      if (options.policy.pacing === 'paced') {
        await presentation;
      } else {
        trackPresentation(presentation);
        if (backgroundPresentations.size >= maxPendingPresentations) {
          await Promise.race(backgroundPresentations);
          throwBackgroundFailure();
        }
      }
    }

    const episode = adapter.episode?.(observed);
    if (episode && (
      priorEpisode === undefined
      || episode.id !== priorEpisode.id
      || episode.index !== priorEpisode.index
    )) {
      if (priorEpisode !== undefined && options.policy.conversation === 'fresh-per-episode') {
        await driver.reset?.();
      }
      priorEpisode = episode;
      await options.events?.onEpisodeChange?.(episode);
    }

    if (adapter.terminal(observed) || session.status === 'terminal') break;
    if (
      observed.kind === 'pending'
      && !observed.awaitingParticipants.includes(session.participantId)
    ) {
      observed = await session.observe({ signal: options.signal });
      continue;
    }
    const decision = await driver.act(adapter.context(observed, decisions.length, options.signal));
    decisions.push(decision);
    await options.events?.onDecision?.(decision);
    observed = await session.act(
      decision.action as unknown as TCommand,
      { signal: options.signal },
    );
  }

  await Promise.all(backgroundPresentations);
  throwBackgroundFailure();
  if (options.policy.finalize === 'caller') {
    return { status: 'terminal', observations, decisions };
  }
  const result = await session.finalize();
  await options.events?.onFinalized?.(result);
  return { status: 'finalized', observations, decisions, result };
}
