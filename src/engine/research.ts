import { canonicalJson, type JsonValue } from '../protocol.js';
import type { SubmittedAction } from './contracts.js';

export interface GameDescriptor {
  id: string;
  version: string;
  dynamics: 'sequential' | 'simultaneous' | 'mixed';
  chance: 'none' | 'explicit' | 'sampled';
  information: 'perfect' | 'imperfect';
  utility: 'zero-sum' | 'constant-sum' | 'general-sum' | 'identical';
  rewards: 'terminal' | 'incremental';
  minPlayers: number;
  maxPlayers: number;
  minUtility?: number;
  maxUtility?: number;
  maxEpisodeLength?: number;
}

export interface ChanceOutcome {
  action: SubmittedAction;
  probability: number;
}

export interface GameHistory<TState = unknown> {
  readonly initialState: TState;
  readonly states: readonly TState[];
  readonly actions: readonly SubmittedAction[];
}

export interface GameObserver<TState, TObservation, TInformationState = never> {
  observe(state: TState, seat: string): TObservation;
  informationState?(history: GameHistory<TState>, seat: string): TInformationState;
  publicObservation?(state: TState): unknown;
  privateObservation?(state: TState, seat: string): unknown;
}

export interface PolicyChoice {
  action: SubmittedAction;
  probability: number;
}

export interface Policy<TObservation> {
  distribution(
    observation: TObservation,
    legalActions: readonly SubmittedAction[],
  ): Promise<readonly PolicyChoice[]>;
}

function assertNonEmpty(value: unknown, name: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

/** Validate the portable discovery contract before scheduling a run. */
export function assertGameDescriptor(
  descriptor: GameDescriptor,
): asserts descriptor is GameDescriptor {
  assertNonEmpty(descriptor.id, 'descriptor.id');
  assertNonEmpty(descriptor.version, 'descriptor.version');
  if (!['sequential', 'simultaneous', 'mixed'].includes(descriptor.dynamics)) {
    throw new TypeError('descriptor.dynamics must be sequential, simultaneous, or mixed');
  }
  if (!['none', 'explicit', 'sampled'].includes(descriptor.chance)) {
    throw new TypeError('descriptor.chance must be none, explicit, or sampled');
  }
  if (!['perfect', 'imperfect'].includes(descriptor.information)) {
    throw new TypeError('descriptor.information must be perfect or imperfect');
  }
  if (!['zero-sum', 'constant-sum', 'general-sum', 'identical'].includes(
    descriptor.utility,
  )) {
    throw new TypeError(
      'descriptor.utility must be zero-sum, constant-sum, general-sum, or identical',
    );
  }
  if (!['terminal', 'incremental'].includes(descriptor.rewards)) {
    throw new TypeError('descriptor.rewards must be terminal or incremental');
  }
  if (!Number.isSafeInteger(descriptor.minPlayers) || descriptor.minPlayers <= 0) {
    throw new RangeError('descriptor.minPlayers must be a positive safe integer');
  }
  if (!Number.isSafeInteger(descriptor.maxPlayers)
    || descriptor.maxPlayers < descriptor.minPlayers) {
    throw new RangeError(
      'descriptor.maxPlayers must be a safe integer no smaller than minPlayers',
    );
  }
  if (descriptor.maxEpisodeLength !== undefined
    && (!Number.isSafeInteger(descriptor.maxEpisodeLength)
      || descriptor.maxEpisodeLength <= 0)) {
    throw new RangeError('descriptor.maxEpisodeLength must be a positive safe integer');
  }
  if (descriptor.minUtility !== undefined && !Number.isFinite(descriptor.minUtility)) {
    throw new RangeError('descriptor.minUtility must be finite');
  }
  if (descriptor.maxUtility !== undefined && !Number.isFinite(descriptor.maxUtility)) {
    throw new RangeError('descriptor.maxUtility must be finite');
  }
  if (descriptor.minUtility !== undefined && descriptor.maxUtility !== undefined
    && descriptor.maxUtility < descriptor.minUtility) {
    throw new RangeError('descriptor.maxUtility must not be smaller than minUtility');
  }
}

function actionKey(action: SubmittedAction): string {
  return canonicalJson(action as unknown as JsonValue);
}

/**
 * Validate a finite canonical distribution. Callers retain the returned array
 * as the canonical chance/policy order.
 */
export function validateActionDistribution(
  distribution: readonly PolicyChoice[],
  options: {
    legalActions?: readonly SubmittedAction[];
    tolerance?: number;
    requireCanonicalOrder?: boolean;
  } = {},
): readonly PolicyChoice[] {
  if (distribution.length === 0) {
    throw new RangeError('distribution must contain at least one outcome');
  }
  const tolerance = options.tolerance ?? 1e-9;
  if (!Number.isFinite(tolerance) || tolerance < 0) {
    throw new RangeError('tolerance must be a non-negative finite number');
  }
  const legal = options.legalActions === undefined
    ? undefined
    : new Set(options.legalActions.map(actionKey));
  const seen = new Set<string>();
  let total = 0;
  let previous: string | undefined;
  for (const [index, choice] of distribution.entries()) {
    const key = actionKey(choice.action);
    if (seen.has(key)) {
      throw new TypeError(`distribution contains duplicate action at index ${index}`);
    }
    seen.add(key);
    if (legal !== undefined && !legal.has(key)) {
      throw new TypeError(`distribution contains illegal action at index ${index}`);
    }
    if (!Number.isFinite(choice.probability) || choice.probability < 0) {
      throw new RangeError(`distribution probability at index ${index} must be non-negative and finite`);
    }
    if (options.requireCanonicalOrder === true && previous !== undefined && key < previous) {
      throw new TypeError('distribution actions are not in canonical order');
    }
    previous = key;
    total += choice.probability;
  }
  if (Math.abs(total - 1) > tolerance) {
    throw new RangeError(`distribution probabilities sum to ${total}, expected 1 ± ${tolerance}`);
  }
  return distribution;
}

export function validateChanceOutcomes(
  outcomes: readonly ChanceOutcome[],
  tolerance = 1e-9,
): readonly ChanceOutcome[] {
  return validateActionDistribution(outcomes, {
    tolerance,
    requireCanonicalOrder: true,
  });
}

/** Deterministically select from a validated distribution using a [0, 1) draw. */
export function sampleActionDistribution(
  distribution: readonly PolicyChoice[],
  draw: number,
): SubmittedAction {
  validateActionDistribution(distribution);
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1) {
    throw new RangeError('draw must be a finite number in [0, 1)');
  }
  let cumulative = 0;
  for (const choice of distribution) {
    cumulative += choice.probability;
    if (draw < cumulative) return structuredClone(choice.action);
  }
  return structuredClone(distribution[distribution.length - 1]!.action);
}

export interface WinRateEstimate {
  wins: number;
  episodes: number;
  rate: number;
  confidence95: readonly [number, number];
}

/** Wilson 95% interval; defined for an empty sample as [0, 1]. */
export function winRate(wins: number, episodes: number): WinRateEstimate {
  if (!Number.isSafeInteger(episodes) || episodes < 0
    || !Number.isSafeInteger(wins) || wins < 0 || wins > episodes) {
    throw new RangeError('wins and episodes must be safe integers with 0 <= wins <= episodes');
  }
  if (episodes === 0) {
    return { wins, episodes, rate: 0, confidence95: [0, 1] };
  }
  const z = 1.959963984540054;
  const rate = wins / episodes;
  const denominator = 1 + (z * z) / episodes;
  const center = (rate + (z * z) / (2 * episodes)) / denominator;
  const margin = z * Math.sqrt(
    (rate * (1 - rate) + (z * z) / (4 * episodes)) / episodes,
  ) / denominator;
  return {
    wins,
    episodes,
    rate,
    confidence95: [Math.max(0, center - margin), Math.min(1, center + margin)],
  };
}

export function policyEntropy(distribution: readonly PolicyChoice[]): number {
  validateActionDistribution(distribution);
  return distribution.reduce(
    (entropy, { probability }) => (
      probability === 0 ? entropy : entropy - probability * Math.log2(probability)
    ),
    0,
  );
}
