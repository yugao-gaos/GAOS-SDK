/** A validated fixed simulation cadence. */
export interface TickRate {
  /** Number of authoritative simulation ticks in one second. */
  readonly ticksPerSecond: number;
  /** Logical duration of one tick in seconds. */
  readonly secondsPerTick: number;
  /** Logical duration of one tick in milliseconds. */
  readonly millisecondsPerTick: number;
}

function assertFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }
}

/**
 * Describe a fixed-rate simulation without coupling the deterministic engine
 * to a wall clock or scheduler.
 */
export function createTickRate(ticksPerSecond: number): TickRate {
  if (!Number.isFinite(ticksPerSecond) || ticksPerSecond <= 0) {
    throw new RangeError('ticksPerSecond must be a finite positive number');
  }
  const secondsPerTick = 1 / ticksPerSecond;
  const millisecondsPerTick = 1000 / ticksPerSecond;
  if (!Number.isFinite(secondsPerTick) || !Number.isFinite(millisecondsPerTick)
    || secondsPerTick <= 0 || millisecondsPerTick <= 0) {
    throw new RangeError('ticksPerSecond produces an unrepresentable tick duration');
  }
  return Object.freeze({
    ticksPerSecond,
    secondsPerTick,
    millisecondsPerTick,
  });
}

function assertTickRate(rate: TickRate): void {
  if (!rate || !Number.isFinite(rate.ticksPerSecond) || rate.ticksPerSecond <= 0) {
    throw new RangeError('rate.ticksPerSecond must be a finite positive number');
  }
}

/** Return the zero-based tick containing an elapsed wall-clock instant. */
export function tickAtElapsedMilliseconds(
  elapsedMilliseconds: number,
  rate: TickRate,
): number {
  assertFiniteNonNegative(elapsedMilliseconds, 'elapsedMilliseconds');
  assertTickRate(rate);
  const tick = Math.floor((elapsedMilliseconds * rate.ticksPerSecond) / 1000);
  if (!Number.isSafeInteger(tick)) {
    throw new RangeError('elapsedMilliseconds produces an unsafe tick index');
  }
  return tick;
}

/** Return the elapsed logical milliseconds at the start of a zero-based tick. */
export function elapsedMillisecondsAtTick(tick: number, rate: TickRate): number {
  if (!Number.isSafeInteger(tick) || tick < 0) {
    throw new RangeError('tick must be a non-negative safe integer');
  }
  assertTickRate(rate);
  const elapsed = (tick / rate.ticksPerSecond) * 1000;
  if (!Number.isFinite(elapsed)) {
    throw new RangeError('tick produces an unrepresentable elapsed duration');
  }
  return elapsed;
}
