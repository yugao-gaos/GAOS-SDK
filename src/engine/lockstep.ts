import {
  advanceTick,
  type Reducer,
  type SessionView,
  type SubmittedAction,
} from './contracts.js';
import { fnv1a } from './random.js';

export interface LockstepInput {
  tick: number;
  seat: string;
  actions: readonly SubmittedAction[];
}

export interface ResimulationOptions<TState> {
  /** First simulated tick. Defaults to zero. */
  fromTick?: number;
  /** Continue through this tick after the final input. */
  throughTick?: number;
  /** Product-owned scheduled work for an all-wait tick. Defaults to identity. */
  applyEmptyTick?: (state: TState, tick: number) => TState;
}

function assertTick(tick: number, name: string): void {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Shared replay/rollback action fold. Lockstep ticks prefer one atomic batch;
 * legacy action transcripts retain their original serial semantics.
 *
 * @internal
 */
export function applyCanonicalActions<
  TLevel,
  TState,
  TView extends SessionView,
>(
  reducer: Reducer<TLevel, TState, TView>,
  state: TState,
  actions: readonly SubmittedAction[],
  atomic: boolean,
): TState {
  if (atomic) return advanceTick(reducer, state, actions);
  let next = state;
  for (const action of actions) next = advanceTick(reducer, next, [action]);
  return next;
}

/**
 * Canonical total order: tick, seat id, then authored submission order.
 */
export function canonicalizeLockstepInputs(
  inputs: readonly LockstepInput[],
): LockstepInput[] {
  if (!Array.isArray(inputs)) throw new TypeError('lockstep inputs must be an array');
  return inputs.map((input, authoredOrder) => {
    if (!input || typeof input !== 'object') throw new TypeError('lockstep input must be an object');
    assertTick(input.tick, 'lockstep tick');
    if (typeof input.seat !== 'string' || input.seat.length === 0) {
      throw new TypeError('lockstep input seat must be a non-empty string');
    }
    if (!Array.isArray(input.actions)) throw new TypeError('lockstep actions must be an array');
    return { input, authoredOrder };
  }).sort((a, b) => (
    a.input.tick - b.input.tick
    || compareStrings(a.input.seat, b.input.seat)
    || a.authoredOrder - b.authoredOrder
  )).map(({ input }) => ({
    tick: input.tick,
    seat: input.seat,
    actions: input.actions.map((action: SubmittedAction) => ({
      ...action,
      ...(action.targets ? {
        targets: action.targets.map((target) => ({
          container: target.container,
          coord: Array.isArray(target.coord) ? [...target.coord] : target.coord,
        })),
      } : {}),
    })),
  }));
}

/**
 * Fold canonical per-tick inputs over a rollback snapshot.
 *
 * Canonical reducers receive an empty input batch for all-wait ticks. Legacy
 * reducers may provide `applyEmptyTick`; otherwise empty ticks remain identity
 * steps for compatibility.
 */
export function resimulate<
  TLevel,
  TState,
  TView extends SessionView,
>(
  reducer: Reducer<TLevel, TState, TView>,
  snapshotState: TState,
  inputs: readonly LockstepInput[],
  options: ResimulationOptions<TState> = {},
): TState {
  const ordered = canonicalizeLockstepInputs(inputs);
  const fromTick = options.fromTick ?? 0;
  assertTick(fromTick, 'fromTick');
  if (ordered.some(({ tick }) => tick < fromTick)) {
    throw new RangeError('lockstep input tick must not precede fromTick');
  }
  const finalInputTick = ordered.at(-1)?.tick ?? fromTick - 1;
  const throughTick = options.throughTick ?? finalInputTick;
  if (throughTick >= 0) assertTick(throughTick, 'throughTick');
  if (throughTick < finalInputTick) {
    throw new RangeError('throughTick must not precede the final input tick');
  }
  let state = snapshotState;
  let cursor = 0;
  for (let tick = fromTick; tick <= throughTick; tick++) {
    const start = cursor;
    while (cursor < ordered.length && ordered[cursor]!.tick === tick) cursor++;
    if (start === cursor) {
      if ('advance' in reducer) state = advanceTick(reducer, state, []);
      else if (options.applyEmptyTick) state = options.applyEmptyTick(state, tick);
      continue;
    }
    const tickActions: SubmittedAction[] = [];
    for (let inputIndex = start; inputIndex < cursor; inputIndex++) {
      const input = ordered[inputIndex]!;
      for (const action of input.actions) {
        if (action.seat !== undefined && action.seat !== input.seat) {
          throw new TypeError(
            `action seat ${action.seat} contradicts lockstep envelope seat ${input.seat}`,
          );
        }
        tickActions.push(action.seat === undefined
          ? { ...action, seat: input.seat }
          : action);
      }
    }
    state = applyCanonicalActions(reducer, state, tickActions, true);
  }
  return state;
}

export interface StateDigestOptions<TState, TDigest> {
  serialize?: (state: TState) => string;
  hash?: (serialized: string) => TDigest;
}

/** Deterministic desync digest; products should inject canonical serialization. */
export function stateDigest<TState, TDigest = number>(
  state: TState,
  options: StateDigestOptions<TState, TDigest> = {},
): TDigest {
  const serialized = (options.serialize ?? JSON.stringify)(state);
  if (typeof serialized !== 'string') throw new TypeError('state serializer must return a string');
  return (options.hash ?? (fnv1a as (value: string) => TDigest))(serialized);
}
