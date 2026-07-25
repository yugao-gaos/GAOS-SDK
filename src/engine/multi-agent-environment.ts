import type {
  Outcome,
  SubmittedAction,
  Reducer,
  TickView,
} from './contracts.js';
import { advanceTick } from './contracts.js';
import { enumerateActions } from './solver.js';

export const MULTI_AGENT_TRANSCRIPT_VERSION = '1.1' as const;

export type MultiAgentEnvironmentErrorCode =
  | 'not_started'
  | 'episode_done'
  | 'illegal_action'
  | 'invalid_participation';

export class MultiAgentEnvironmentError extends Error {
  constructor(
    public readonly code: MultiAgentEnvironmentErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'MultiAgentEnvironmentError';
  }
}

export interface MultiAgentSeatStep<TView extends TickView<unknown, unknown>> {
  seat: string;
  observation: TView;
  legalActions: readonly SubmittedAction[];
  systemActions: readonly SubmittedAction[];
  participating: boolean;
  reward: number;
  totalReward: number;
}

export interface MultiAgentStep<TView extends TickView<unknown, unknown>> {
  seats: Readonly<Record<string, MultiAgentSeatStep<TView>>>;
  participatingSeats: readonly string[];
  tick: number;
  status: TickView['status'];
  outcome?: Outcome;
  terminated: boolean;
  truncated: boolean;
  done: boolean;
}

export interface MultiAgentTranscriptTick<
  TView extends TickView<unknown, unknown>,
> {
  n: number;
  actions: readonly SubmittedAction[];
  rewards: Readonly<Record<string, number>>;
  observations: Readonly<Record<string, TView>>;
}

export interface MultiAgentTranscript<
  TLevel,
  TView extends TickView<unknown, unknown>,
> {
  version: typeof MULTI_AGENT_TRANSCRIPT_VERSION;
  level: TLevel;
  seed: number;
  seats: readonly string[];
  initialObservations: Readonly<Record<string, TView>>;
  ticks: readonly MultiAgentTranscriptTick<TView>[];
  result: {
    ticks: number;
    status: TickView['status'];
    outcome?: Outcome;
    totalRewards: Readonly<Record<string, number>>;
    terminated: boolean;
    truncated: boolean;
  };
}

export interface MultiAgentEnvironmentOptions<
  TLevel,
  TState,
  TView extends TickView<unknown, unknown>,
> {
  reducer: Reducer<TLevel, TState, TView>;
  level: TLevel;
  seats: readonly string[];
  seed?: number;
  maxTicks?: number;
  enumerateActions?: (view: TView) => SubmittedAction[];
  waitAction?: (seat: string, view: TView) => SubmittedAction;
  isActionLegal?: (
    action: SubmittedAction,
    seat: string,
    view: TView,
    concrete: readonly SubmittedAction[],
  ) => boolean;
  reward?: (
    previous: TView,
    next: TView,
    actions: readonly SubmittedAction[],
    tick: number,
    seat: string,
  ) => number;
  snapshotLevel?: (level: TLevel) => TLevel;
  snapshotObservation?: (view: TView) => TView;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function copyAction(action: SubmittedAction): SubmittedAction {
  return {
    ...action,
    ...(action.targets ? {
      targets: action.targets.map((target) => ({
        container: target.container,
        coord: Array.isArray(target.coord) ? [...target.coord] : target.coord,
      })),
    } : {}),
  };
}

function copyOutcome(outcome: Outcome): Outcome {
  return outcome.kind === 'ongoing'
    ? { kind: 'ongoing' }
    : {
      kind: 'decided',
      ranking: outcome.ranking.map((entry) => ({ ...entry })),
      ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
    };
}

function actionKey(action: SubmittedAction, hostedSeat?: string): string {
  const normalized = hostedSeat && action.seat === hostedSeat
    ? { ...action, seat: undefined }
    : action;
  return JSON.stringify({
    id: normalized.id,
    ...(normalized.x !== undefined ? { x: normalized.x } : {}),
    ...(normalized.y !== undefined ? { y: normalized.y } : {}),
    ...(normalized.index !== undefined ? { index: normalized.index } : {}),
    ...(normalized.boardId !== undefined ? { boardId: normalized.boardId } : {}),
    ...(normalized.zoneId !== undefined ? { zoneId: normalized.zoneId } : {}),
    ...(normalized.seat !== undefined ? { seat: normalized.seat } : {}),
    ...(normalized.targets !== undefined ? { targets: normalized.targets } : {}),
  });
}

function defaultSnapshot<T>(value: T, label: string): T {
  try {
    return structuredClone(value);
  } catch (error) {
    throw new TypeError(`${label} is not cloneable; provide a snapshot adapter`, { cause: error });
  }
}

function validateSeats(seats: readonly string[]): string[] {
  if (!Array.isArray(seats) || seats.length === 0
    || seats.some((seat) => typeof seat !== 'string' || seat.length === 0)
    || new Set(seats).size !== seats.length) {
    throw new TypeError('multi-agent seats must be unique non-empty strings');
  }
  return [...seats].sort(compareText);
}

/**
 * Deterministic shared-state environment for multiple seat-scoped policies.
 * Simultaneous participation resolves one canonical input batch per tick.
 */
export class MultiAgentEnvironment<
  TLevel,
  TState,
  TView extends TickView<unknown, unknown>,
> {
  private readonly seats: string[];
  private readonly seed: number;
  private readonly maxTicks: number;
  private readonly actionsFor: (view: TView) => SubmittedAction[];
  private readonly snapshotLevel: (level: TLevel) => TLevel;
  private readonly snapshotObservation: (view: TView) => TView;
  private state: TState | undefined;
  private ticks = 0;
  private ended = false;
  private truncated = false;
  private totalRewards: Record<string, number>;
  private lastRewards: Record<string, number>;
  private initialObservations: Record<string, TView> | undefined;
  private records: Array<MultiAgentTranscriptTick<TView>> = [];
  private transcriptLevel: TLevel | undefined;

  constructor(private readonly options: MultiAgentEnvironmentOptions<TLevel, TState, TView>) {
    this.seats = validateSeats(options.seats);
    this.seed = options.seed ?? 1;
    if (!Number.isSafeInteger(this.seed) || this.seed < 0 || this.seed > 0xffff_ffff) {
      throw new RangeError('multi-agent seed must be an unsigned 32-bit integer');
    }
    this.maxTicks = options.maxTicks ?? 10_000;
    if (!Number.isSafeInteger(this.maxTicks) || this.maxTicks < 1) {
      throw new RangeError('multi-agent maxTicks must be a positive safe integer');
    }
    this.actionsFor = options.enumerateActions ?? ((view) => enumerateActions(view));
    this.snapshotLevel = options.snapshotLevel
      ?? ((level) => defaultSnapshot(level, 'multi-agent level'));
    this.snapshotObservation = options.snapshotObservation
      ?? ((view) => defaultSnapshot(view, 'multi-agent observation'));
    this.totalRewards = Object.fromEntries(this.seats.map((seat) => [seat, 0]));
    this.lastRewards = Object.fromEntries(this.seats.map((seat) => [seat, 0]));
  }

  reset(): MultiAgentStep<TView> {
    this.transcriptLevel = this.snapshotLevel(this.options.level);
    this.state = this.options.reducer.init(this.options.level, this.seed);
    this.ticks = 0;
    this.ended = false;
    this.truncated = false;
    this.records = [];
    this.totalRewards = Object.fromEntries(this.seats.map((seat) => [seat, 0]));
    this.lastRewards = Object.fromEntries(this.seats.map((seat) => [seat, 0]));
    const views = this.views();
    this.initialObservations = Object.fromEntries(this.seats.map((seat) => [
      seat,
      this.snapshotObservation(views[seat]!),
    ]));
    const full = this.options.reducer.view(this.state);
    if (full.status !== 'playing' || full.outcome?.kind === 'decided') this.ended = true;
    return this.tick(views, full);
  }

  observe(): MultiAgentStep<TView> {
    if (this.state === undefined) {
      throw new MultiAgentEnvironmentError('not_started', 'call reset() before observe()');
    }
    return this.tick(this.views(), this.options.reducer.view(this.state));
  }

  step(
    intents: Readonly<Record<string, SubmittedAction | undefined>>,
  ): MultiAgentStep<TView> {
    if (this.state === undefined) {
      throw new MultiAgentEnvironmentError('not_started', 'call reset() before step()');
    }
    if (this.ended) {
      throw new MultiAgentEnvironmentError('episode_done', 'reset before another multi-agent step');
    }
    if (!intents || typeof intents !== 'object' || Array.isArray(intents)) {
      throw new TypeError('multi-agent intents must be a seat record');
    }
    const previousViews = this.views();
    const full = this.options.reducer.view(this.state);
    const participating = this.participatingSeats(full);
    for (const seat of Object.keys(intents)) {
      if (!participating.includes(seat)) {
        throw new MultiAgentEnvironmentError(
          'invalid_participation',
          `seat ${seat} is not participating in this collection tick`,
        );
      }
    }
    const actions: SubmittedAction[] = [];
    for (const seat of participating) {
      const view = previousViews[seat]!;
      const gameplay = this.actionsFor(view);
      const systems = view.systemActions
        ? enumerateActions({ ...view, actions: view.systemActions })
        : [];
      const supplied = intents[seat]
        ?? this.options.waitAction?.(seat, view)
        ?? { id: 'wait' };
      if (supplied.seat !== undefined && supplied.seat !== seat) {
        throw new MultiAgentEnvironmentError(
          'illegal_action',
          `action seat ${supplied.seat} does not match policy seat ${seat}`,
        );
      }
      const concrete = [...gameplay, ...systems];
      const legal = this.options.isActionLegal
        ? this.options.isActionLegal(supplied, seat, view, concrete)
        : concrete.some((candidate) => (
          actionKey(candidate, seat) === actionKey(supplied, seat)
        ));
      if (!legal) {
        throw new MultiAgentEnvironmentError(
          'illegal_action',
          `action is not legal for seat ${seat}: ${actionKey(supplied)}`,
        );
      }
      actions.push(copyAction(supplied.seat === undefined ? { ...supplied, seat } : supplied));
    }

    if (full.participation?.mode === 'simultaneous') {
      if (!('advance' in this.options.reducer) && !this.options.reducer.applyIntents) {
        throw new MultiAgentEnvironmentError(
          'invalid_participation',
          'simultaneous participation requires TickReducer.advance or reducer.applyIntents',
        );
      }
      this.state = advanceTick(this.options.reducer, this.state, actions);
    } else {
      if (actions.length !== 1) {
        throw new MultiAgentEnvironmentError(
          'invalid_participation',
          'sequential or implicit participation must resolve exactly one action',
        );
      }
      this.state = advanceTick(this.options.reducer, this.state, actions);
    }
    this.ticks++;
    const nextViews = this.views();
    const nextFull = this.options.reducer.view(this.state);
    const rewards: Record<string, number> = {};
    for (const seat of this.seats) {
      const reward = this.options.reward
        ? this.options.reward(previousViews[seat]!, nextViews[seat]!, actions, this.ticks, seat)
        : this.defaultReward(nextViews[seat]!, seat);
      if (!Number.isFinite(reward)) throw new TypeError(`reward for seat ${seat} must be finite`);
      rewards[seat] = reward;
      this.lastRewards[seat] = reward;
      this.totalRewards[seat] = this.totalRewards[seat]! + reward;
    }
    if (nextFull.status !== 'playing' || nextFull.outcome?.kind === 'decided') {
      this.ended = true;
    } else if (this.ticks >= this.maxTicks) {
      this.ended = true;
      this.truncated = true;
    }
    this.records.push({
      n: this.ticks,
      actions: actions.map(copyAction),
      rewards: { ...rewards },
      observations: Object.fromEntries(this.seats.map((seat) => [
        seat,
        this.snapshotObservation(nextViews[seat]!),
      ])),
    });
    return this.tick(nextViews, nextFull);
  }

  /** Reset and replay canonical per-tick action batches from a transcript. */
  replay(
    ticks: readonly (readonly SubmittedAction[])[],
  ): MultiAgentStep<TView> {
    let step = this.reset();
    for (const actions of ticks) {
      const intents: Record<string, SubmittedAction> = {};
      for (const action of actions) {
        if (typeof action.seat !== 'string' || action.seat.length === 0) {
          throw new TypeError('multi-agent replay actions require seat ids');
        }
        if (intents[action.seat]) {
          throw new TypeError(`multi-agent replay has duplicate seat action: ${action.seat}`);
        }
        intents[action.seat] = copyAction(action);
      }
      step = this.step(intents);
    }
    return step;
  }

  transcript(): MultiAgentTranscript<TLevel, TView> {
    const step = this.observe();
    if (this.transcriptLevel === undefined || this.initialObservations === undefined) {
      throw new MultiAgentEnvironmentError('not_started', 'call reset() before transcript()');
    }
    return {
      version: MULTI_AGENT_TRANSCRIPT_VERSION,
      level: this.snapshotLevel(this.transcriptLevel),
      seed: this.seed,
      seats: [...this.seats],
      initialObservations: Object.fromEntries(this.seats.map((seat) => [
        seat,
        this.snapshotObservation(this.initialObservations![seat]!),
      ])),
      ticks: this.records.map((tick) => ({
        n: tick.n,
        actions: tick.actions.map(copyAction),
        rewards: { ...tick.rewards },
        observations: Object.fromEntries(this.seats.map((seat) => [
          seat,
          this.snapshotObservation(tick.observations[seat]!),
        ])),
      })),
      result: {
        ticks: this.ticks,
        status: step.status,
        ...(step.outcome ? { outcome: copyOutcome(step.outcome) } : {}),
        totalRewards: { ...this.totalRewards },
        terminated: step.terminated,
        truncated: step.truncated,
      },
    };
  }

  private views(): Record<string, TView> {
    if (this.state === undefined) {
      throw new MultiAgentEnvironmentError('not_started', 'call reset() before observing seats');
    }
    return Object.fromEntries(this.seats.map((seat) => [
      seat,
      this.options.reducer.viewFor
        ? this.options.reducer.viewFor(this.state!, seat)
        : this.options.reducer.view(this.state!),
    ]));
  }

  private participatingSeats(view: TView): string[] {
    let seats: readonly string[];
    if (view.participation?.mode === 'sequential') {
      seats = [view.participation.activeSeat];
    } else if (view.participation?.mode === 'simultaneous') {
      seats = view.participation.seats;
    } else if (view.activeSeat) {
      seats = [view.activeSeat];
    } else if (this.seats.length === 1) {
      seats = this.seats;
    } else {
      throw new MultiAgentEnvironmentError(
        'invalid_participation',
        'multi-seat views must declare participation',
      );
    }
    if (new Set(seats).size !== seats.length
      || seats.some((seat) => !this.seats.includes(seat))) {
      throw new MultiAgentEnvironmentError(
        'invalid_participation',
        'view participation must contain unique configured seats',
      );
    }
    return [...seats].sort(compareText);
  }

  private defaultReward(view: TView, seat: string): number {
    if (view.outcome?.kind === 'decided') {
      const result = view.outcome.ranking.find((entry) => entry.seat === seat);
      return result?.score ?? (result?.rank === 1 ? 1 : 0);
    }
    return view.status === 'won' ? (view.stars ?? 1) : 0;
  }

  private tick(views: Record<string, TView>, full: TView): MultiAgentStep<TView> {
    const participating = this.ended ? [] : this.participatingSeats(full);
    return {
      seats: Object.fromEntries(this.seats.map((seat) => {
        const view = views[seat]!;
        const isParticipating = participating.includes(seat);
        return [seat, {
          seat,
          observation: view,
          legalActions: isParticipating ? this.actionsFor(view) : [],
          systemActions: isParticipating && view.systemActions
            ? enumerateActions({ ...view, actions: view.systemActions })
            : [],
          participating: isParticipating,
          reward: this.lastRewards[seat]!,
          totalReward: this.totalRewards[seat]!,
        }];
      })),
      participatingSeats: participating,
      tick: this.ticks,
      status: full.status,
      ...(full.outcome ? { outcome: copyOutcome(full.outcome) } : {}),
      terminated: this.ended && !this.truncated,
      truncated: this.truncated,
      done: this.ended,
    };
  }
}

export type MultiAgentPolicy<TView extends TickView<unknown, unknown>> = (
  step: MultiAgentSeatStep<TView>,
  shared: MultiAgentStep<TView>,
) => SubmittedAction | undefined | Promise<SubmittedAction | undefined>;

export interface MultiAgentEpisodeResult<
  TLevel,
  TView extends TickView<unknown, unknown>,
> {
  finalStep: MultiAgentStep<TView>;
  transcript: MultiAgentTranscript<TLevel, TView>;
}

/** Run seat policies concurrently while committing their inputs canonically. */
export async function runMultiAgentEpisode<
  TLevel,
  TState,
  TView extends TickView<unknown, unknown>,
>(
  environment: MultiAgentEnvironment<TLevel, TState, TView>,
  policies: Readonly<Record<string, MultiAgentPolicy<TView>>>,
): Promise<MultiAgentEpisodeResult<TLevel, TView>> {
  let step = environment.reset();
  while (!step.done) {
    const decisions = await Promise.all(step.participatingSeats.map(async (seat) => {
      const policy = policies[seat];
      if (!policy) return [seat, undefined] as const;
      return [seat, await policy(step.seats[seat]!, step)] as const;
    }));
    step = environment.step(Object.fromEntries(decisions));
  }
  return { finalStep: step, transcript: environment.transcript() };
}
