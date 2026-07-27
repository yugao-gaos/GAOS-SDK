/**
 * Independent 512-bit fixed-point oracle for dmath acceptance tests.
 *
 * This module deliberately uses no native transcendental. Pi comes from
 * Machin's formula and sin/cos/atan come from convergent Taylor series.
 * It is test/provenance code, not part of the shipped runtime.
 */

export const ORACLE_BITS = 512n;
export const ORACLE_ONE = 1n << ORACLE_BITS;
const FLOAT_BUFFER = new ArrayBuffer(8);
const FLOAT_VIEW = new DataView(FLOAT_BUFFER);
const FLOAT_SIGN = 1n << 63n;
const FLOAT_MASK = (1n << 64n) - 1n;

function abs(value) {
  return value < 0n ? -value : value;
}

function multiply(left, right) {
  return (left * right) / ORACLE_ONE;
}

function atanInverse(integer) {
  const squared = BigInt(integer * integer);
  let powerDenominator = BigInt(integer);
  let sum = 0n;
  let sign = 1n;
  for (let index = 0n; ; index++) {
    const term = ORACLE_ONE / (powerDenominator * (index * 2n + 1n));
    if (term === 0n) return sum;
    sum += sign * term;
    sign = -sign;
    powerDenominator *= squared;
  }
}

export const ORACLE_PI = 16n * atanInverse(5) - 4n * atanInverse(239);
const ORACLE_PI_OVER_2 = ORACLE_PI / 2n;
const ORACLE_PI_OVER_4 = ORACLE_PI / 4n;

function integerSquareRoot(value) {
  if (value < 0n) throw new RangeError('square root input must be non-negative');
  if (value < 2n) return value;
  let estimate = 1n << (BigInt(value.toString(2).length) / 2n + 1n);
  for (;;) {
    const next = (estimate + value / estimate) / 2n;
    if (next >= estimate) return estimate;
    estimate = next;
  }
}

const ORACLE_TAN_PI_OVER_8 =
  integerSquareRoot(2n * ORACLE_ONE * ORACLE_ONE) - ORACLE_ONE;

export function numberToOracle(value) {
  if (!Number.isFinite(value)) throw new RangeError('oracle input must be finite');
  if (value === 0) return 0n;
  const negative = value < 0;
  FLOAT_VIEW.setFloat64(0, Math.abs(value), false);
  const high = FLOAT_VIEW.getUint32(0, false);
  const low = FLOAT_VIEW.getUint32(4, false);
  const rawExponent = (high >>> 20) & 0x7ff;
  const exponent = rawExponent === 0 ? -1022 : rawExponent - 1023;
  const mantissa = (rawExponent === 0 ? 0n : 1n << 52n)
    | (BigInt(high & 0x000f_ffff) << 32n)
    | BigInt(low);
  const shift = ORACLE_BITS + BigInt(exponent) - 52n;
  const fixed = shift >= 0n ? mantissa << shift : mantissa >> -shift;
  return negative ? -fixed : fixed;
}

export function oracleToNumber(value) {
  return Number(value) / Number(ORACLE_ONE);
}

function reduce(value) {
  const negative = value < 0n;
  const magnitude = abs(value);
  let nearest = (magnitude + ORACLE_PI_OVER_2 / 2n) / ORACLE_PI_OVER_2;
  let remainder = magnitude - nearest * ORACLE_PI_OVER_2;
  if (negative) {
    nearest = -nearest;
    remainder = -remainder;
  }
  return {
    quadrant: Number(((nearest % 4n) + 4n) % 4n),
    remainder,
  };
}

function kernelSin(value) {
  const squared = multiply(value, value);
  let term = value;
  let sum = value;
  for (let index = 1n; ; index++) {
    term = -multiply(term, squared) / ((index * 2n) * (index * 2n + 1n));
    if (term === 0n) return sum;
    sum += term;
  }
}

function kernelCos(value) {
  const squared = multiply(value, value);
  let term = ORACLE_ONE;
  let sum = ORACLE_ONE;
  for (let index = 1n; ; index++) {
    term = -multiply(term, squared) / ((index * 2n - 1n) * (index * 2n));
    if (term === 0n) return sum;
    sum += term;
  }
}

export function oracleSin(value) {
  if (Object.is(value, -0)) return -0;
  if (Math.abs(value) < 2 ** -500) return value;
  const { quadrant, remainder } = reduce(numberToOracle(value));
  const fixed = quadrant === 0
    ? kernelSin(remainder)
    : quadrant === 1
      ? kernelCos(remainder)
      : quadrant === 2
        ? -kernelSin(remainder)
        : -kernelCos(remainder);
  return oracleToNumber(fixed);
}

export function oracleCos(value) {
  if (Math.abs(value) < 2 ** -500) return 1;
  const { quadrant, remainder } = reduce(numberToOracle(value));
  const fixed = quadrant === 0
    ? kernelCos(remainder)
    : quadrant === 1
      ? -kernelSin(remainder)
      : quadrant === 2
        ? -kernelCos(remainder)
        : kernelSin(remainder);
  return oracleToNumber(fixed);
}

function atanSeries(value) {
  const squared = multiply(value, value);
  let power = value;
  let sum = value;
  let sign = -1n;
  for (let denominator = 3n; ; denominator += 2n) {
    power = multiply(power, squared);
    const term = power / denominator;
    if (term === 0n) return sum;
    sum += sign * term;
    sign = -sign;
  }
}

function atanPositive(value) {
  if (value > ORACLE_ONE) {
    return ORACLE_PI_OVER_2 - atanPositive((ORACLE_ONE * ORACLE_ONE) / value);
  }
  if (value > ORACLE_TAN_PI_OVER_8) {
    return ORACLE_PI_OVER_4
      + atanSeries(((value - ORACLE_ONE) * ORACLE_ONE) / (value + ORACLE_ONE));
  }
  return atanSeries(value);
}

export function oracleAtan2(y, x) {
  if (!Number.isFinite(y) || !Number.isFinite(x)) {
    throw new RangeError('oracle atan2 inputs must be finite');
  }
  if (y === 0) {
    if (x < 0 || Object.is(x, -0)) {
      const pi = oracleToNumber(ORACLE_PI);
      return Object.is(y, -0) ? -pi : pi;
    }
    return y;
  }
  if (x === 0) {
    const halfPi = oracleToNumber(ORACLE_PI_OVER_2);
    return y < 0 ? -halfPi : halfPi;
  }
  const fixedY = abs(numberToOracle(y));
  const fixedX = abs(numberToOracle(x));
  const angle = atanPositive((fixedY * ORACLE_ONE) / fixedX);
  const directed = x > 0
    ? (y < 0 ? -angle : angle)
    : (y < 0 ? angle - ORACLE_PI : ORACLE_PI - angle);
  return oracleToNumber(directed);
}

export function float64Bits(value) {
  FLOAT_VIEW.setFloat64(0, value, false);
  return FLOAT_VIEW.getBigUint64(0, false);
}

function orderedFloatBits(value) {
  const bits = float64Bits(value);
  return bits & FLOAT_SIGN ? (~bits) & FLOAT_MASK : bits | FLOAT_SIGN;
}

export function ulpDistance(left, right) {
  const leftBits = orderedFloatBits(left);
  const rightBits = orderedFloatBits(right);
  return Number(leftBits >= rightBits ? leftBits - rightBits : rightBits - leftBits);
}
