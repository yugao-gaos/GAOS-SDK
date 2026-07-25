/** How duplicate jobs with the same `kind + key` identity are scheduled. */
export type SettlementPolicy = 'repeat' | 'coalesce' | 'once';

/** One product-defined unit of settlement work. */
export interface SettlementJob {
  /** Stable rule or consequence kind. */
  kind: string;
  /** Stable identity within this settlement call. */
  key: string;
  /** Lower values run first within a wave. Defaults to zero. */
  priority?: number;
  /** Duplicate scheduling behavior. Defaults to `repeat`. */
  policy?: SettlementPolicy;
}

/** One resolved job in the causal settlement trace. */
export interface SettlementTraceEntry<TJob extends SettlementJob> {
  step: number;
  wave: number;
  job: TJob;
  /** The step that enqueued this job; absent for seed jobs. */
  parentStep?: number;
}

/** Operations available while resolving one settlement job. */
export interface SettlementContext<TState, TJob extends SettlementJob> {
  readonly state: TState;
  readonly step: number;
  readonly wave: number;
  /** Schedule a consequence for the next resolution wave of this tick. */
  enqueue(job: TJob): boolean;
  /** Return work to the caller without executing it during this tick. */
  defer(job: TJob): void;
}

export type SettlementResolver<TState, TJob extends SettlementJob> = (
  job: TJob,
  context: SettlementContext<TState, TJob>,
) => void;

export interface SettlementOptions {
  /** Hard safety guard. Normal settlement must reach quiescence before this. */
  maxSteps: number;
}

export interface SettlementResult<TState, TJob extends SettlementJob> {
  state: TState;
  steps: number;
  waves: number;
  trace: Array<SettlementTraceEntry<TJob>>;
  /** Jobs deliberately left for a later tick. */
  deferred: TJob[];
}

/** Raised when same-tick resolution does not reach quiescence within its guard. */
export class SettlementLimitError<TJob extends SettlementJob = SettlementJob> extends Error {
  readonly maxSteps: number;
  readonly nextJob: TJob;

  constructor(maxSteps: number, nextJob: TJob) {
    super(`settlement exceeded its ${maxSteps}-step limit before ${nextJob.kind}:${nextJob.key}`);
    this.name = 'SettlementLimitError';
    this.maxSteps = maxSteps;
    this.nextJob = nextJob;
  }
}

interface QueuedJob<TJob extends SettlementJob> {
  job: TJob;
  sequence: number;
  wave: number;
  parentStep?: number;
}

const identityOf = (job: SettlementJob): string => `${job.kind}\u0000${job.key}`;

const compareText = (left: string, right: string): number => (
  left < right ? -1 : left > right ? 1 : 0
);

const compareQueued = <TJob extends SettlementJob>(
  left: QueuedJob<TJob>,
  right: QueuedJob<TJob>,
): number => (
  (left.job.priority ?? 0) - (right.job.priority ?? 0)
  || compareText(left.job.kind, right.job.kind)
  || compareText(left.job.key, right.job.key)
  || left.sequence - right.sequence
);

/**
 * Resolve product-defined consequences in deterministic resolution waves.
 *
 * Every job enqueued by a resolver runs no earlier than the following wave.
 * The caller owns state mutation and rule semantics; this function owns work
 * ordering, duplicate policy, deferral, tracing, and convergence enforcement.
 */
export function runSettlementCascade<TState, TJob extends SettlementJob>(
  state: TState,
  seeds: readonly TJob[],
  resolve: SettlementResolver<TState, TJob>,
  options: SettlementOptions,
): SettlementResult<TState, TJob> {
  if (!Number.isSafeInteger(options.maxSteps) || options.maxSteps < 1) {
    throw new RangeError('settlement maxSteps must be a positive safe integer');
  }

  let sequence = 0;
  let current: Array<QueuedJob<TJob>> = [];
  let next: Array<QueuedJob<TJob>> = [];
  const pendingCoalesced = new Set<string>();
  const seenOnce = new Set<string>();
  const trace: Array<SettlementTraceEntry<TJob>> = [];
  const deferred: TJob[] = [];

  const schedule = (
    job: TJob,
    wave: number,
    parentStep: number | undefined,
    target: Array<QueuedJob<TJob>>,
  ): boolean => {
    const identity = identityOf(job);
    const policy = job.policy ?? 'repeat';
    if (policy === 'once') {
      if (seenOnce.has(identity)) return false;
      seenOnce.add(identity);
    } else if (policy === 'coalesce') {
      if (pendingCoalesced.has(identity)) return false;
      pendingCoalesced.add(identity);
    }
    target.push({
      job,
      sequence: sequence++,
      wave,
      ...(parentStep !== undefined ? { parentStep } : {}),
    });
    return true;
  };

  for (const seed of seeds) schedule(seed, 0, undefined, current);

  let steps = 0;
  let waves = 0;
  while (current.length > 0) {
    current.sort(compareQueued);
    const wave = current[0]!.wave;
    waves = Math.max(waves, wave + 1);
    for (const queued of current) {
      if (steps >= options.maxSteps) throw new SettlementLimitError(options.maxSteps, queued.job);
      if ((queued.job.policy ?? 'repeat') === 'coalesce') {
        pendingCoalesced.delete(identityOf(queued.job));
      }
      const step = steps++;
      trace.push({
        step,
        wave,
        job: queued.job,
        ...(queued.parentStep !== undefined ? { parentStep: queued.parentStep } : {}),
      });
      resolve(queued.job, {
        state,
        step,
        wave,
        enqueue: (job) => schedule(job, wave + 1, step, next),
        defer: (job) => deferred.push(job),
      });
    }
    current = next;
    next = [];
  }

  return { state, steps, waves, trace, deferred };
}
