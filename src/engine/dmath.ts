/**
 * Math operations classified for deterministic reducer state paths.
 *
 * The lists are documentation and lint inputs. Runtime determinism still
 * depends on using `Dmath` for implementation-approximated functions.
 */
export const STATE_MATH = Object.freeze({
  constants: Object.freeze([
    'Math.E',
    'Math.LN2',
    'Math.LN10',
    'Math.LOG2E',
    'Math.LOG10E',
    'Math.PI',
    'Math.SQRT1_2',
    'Math.SQRT2',
  ] as const),
  exact: Object.freeze([
    '+',
    '-',
    '*',
    '/',
    '%',
    'Math.sqrt',
    'Math.abs',
    'Math.floor',
    'Math.ceil',
    'Math.round',
    'Math.trunc',
    'Math.sign',
    'Math.min',
    'Math.max',
    'Math.fround',
    'Math.imul',
    'Math.clz32',
  ] as const),
  forbidden: Object.freeze([
    'Math.sin',
    'Math.cos',
    'Math.tan',
    'Math.asin',
    'Math.acos',
    'Math.atan',
    'Math.atan2',
    'Math.exp',
    'Math.expm1',
    'Math.log',
    'Math.log1p',
    'Math.log2',
    'Math.log10',
    'Math.pow',
    'Math.hypot',
    'Math.cbrt',
    'Math.sinh',
    'Math.cosh',
    'Math.tanh',
    'Math.asinh',
    'Math.acosh',
    'Math.atanh',
    'Math.random',
  ] as const),
});

export const DMATH_ALGORITHM = 'dmath-1' as const;

export interface DmathBackend {
  readonly id: 'js' | 'wasm';
  sin(x: number): number;
  cos(x: number): number;
  atan2(y: number, x: number): number;
}

export interface Dmath {
  readonly algorithm: typeof DMATH_ALGORITHM;
  readonly backend: 'js' | 'wasm';
  sin(x: number): number;
  cos(x: number): number;
  atan2(y: number, x: number): number;
  clamp(x: number, lo: number, hi: number): number;
  roundTo(x: number, decimals: number): number;
}

const PI = 3.141592653589793116;
const PI_OVER_2 = 1.570796326794896558;
const PI_OVER_4 = 0.785398163397448279;
const TWO_PI = 6.283185307179586232;
const MAX_TRIG_INPUT = 1_073_741_824;
const TWO_POW_53 = 9_007_199_254_740_992;

// The fixed-point constants are the first 256 fractional bits of 2/pi and
// pi/2. They were generated independently from Machin's formula by
// scripts/generate-dmath-evidence.mjs. Evaluation order is frozen as dmath-1.
const RANGE_BITS = 256n;
const RANGE_SCALE = Number(1n << 256n);
const INV_PIO2_FIXED =
  0xa2f9836e4e441529fc2757d1f534ddc0db6295993c439041fe5163abdebbc561n;
const PIO2_FIXED =
  0x1921fb54442d18469898cc51701b839a252049c1114cf98e804177d4c76273644n;
const FLOAT_BITS = new ArrayBuffer(8);
const FLOAT_VIEW = new DataView(FLOAT_BITS);

// Clean-room Taylor kernels over [-pi/4, pi/4]. The coefficients are rounded
// binary64 reciprocals of the visible factorial expressions; operation order
// is frozen as part of dmath-1.
const SIN_COEFFICIENTS = [
  -1 / 6,
  1 / 120,
  -1 / 5_040,
  1 / 362_880,
  -1 / 39_916_800,
  1 / 6_227_020_800,
  -1 / 1_307_674_368_000,
  1 / 355_687_428_096_000,
] as const;

const COS_COEFFICIENTS = [
  1 / 24,
  -1 / 720,
  1 / 40_320,
  -1 / 3_628_800,
  1 / 479_001_600,
  -1 / 87_178_291_200,
  1 / 20_922_789_888_000,
  -1 / 6_402_373_705_728_000,
] as const;

const POWERS_OF_TEN = Object.freeze([
  1,
  10,
  100,
  1_000,
  10_000,
  100_000,
  1_000_000,
  10_000_000,
  100_000_000,
  1_000_000_000,
  10_000_000_000,
  100_000_000_000,
  1_000_000_000_000,
  10_000_000_000_000,
  100_000_000_000_000,
  1_000_000_000_000_000,
] as const);

function requireFinite(value: number, name: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

function reduceTrigFixed(x: number): { quadrant: number; reduced: number } {
  const negative = x < 0;
  const magnitude = Math.abs(x);
  FLOAT_VIEW.setFloat64(0, magnitude, false);
  const high = FLOAT_VIEW.getUint32(0, false);
  const low = FLOAT_VIEW.getUint32(4, false);
  const exponent = ((high >>> 20) & 0x7ff) - 1023;
  const mantissa = (1n << 52n)
    | (BigInt(high & 0x000f_ffff) << 32n)
    | BigInt(low);
  const fixed = mantissa << (RANGE_BITS + BigInt(exponent) - 52n);
  const product = fixed * INV_PIO2_FIXED;
  let nearest = (product + (1n << 511n)) >> 512n;
  let remainder = fixed - nearest * PIO2_FIXED;
  if (negative) {
    nearest = -nearest;
    remainder = -remainder;
  }
  return {
    quadrant: Number(((nearest % 4n) + 4n) % 4n),
    reduced: Number(remainder) / RANGE_SCALE,
  };
}

function reduceTrig(x: number): { quadrant: number; reduced: number } {
  requireFinite(x, 'x');
  if (Math.abs(x) > MAX_TRIG_INPUT) {
    throw new RangeError('x must satisfy |x| <= 2^30');
  }
  // Avoid quantizing very small values into the 256-bit fixed-point grid.
  // Values already in the kernel interval require no range reduction.
  if (Math.abs(x) <= PI_OVER_4) return { quadrant: 0, reduced: x };
  return reduceTrigFixed(x);
}

function kernelSin(x: number): number {
  const z = x * x;
  const [s1, s2, s3, s4, s5, s6, s7, s8] = SIN_COEFFICIENTS;
  const tail = s2 + z * (s3 + z * (s4 + z * (s5 + z * (s6 + z * (s7 + z * s8)))));
  return x + x * z * (s1 + z * tail);
}

function kernelCos(x: number): number {
  const z = x * x;
  const [c1, c2, c3, c4, c5, c6, c7, c8] = COS_COEFFICIENTS;
  const tail = c2 + z * (c3 + z * (c4 + z * (c5 + z * (c6 + z * (c7 + z * c8)))));
  return 1 - (0.5 * z - z * z * (c1 + z * tail));
}

function jsSin(x: number): number {
  if (Object.is(x, -0)) return -0;
  const { quadrant, reduced } = reduceTrig(x);
  if (quadrant === 0) return kernelSin(reduced);
  if (quadrant === 1) return kernelCos(reduced);
  if (quadrant === 2) return -kernelSin(reduced);
  return -kernelCos(reduced);
}

function jsCos(x: number): number {
  const { quadrant, reduced } = reduceTrig(x);
  if (quadrant === 0) return kernelCos(reduced);
  if (quadrant === 1) return -kernelSin(reduced);
  if (quadrant === 2) return -kernelCos(reduced);
  return kernelSin(reduced);
}

// Frozen odd series after reduction to [-tan(pi/8), tan(pi/8)]. Degree 55
// makes the omitted term smaller than binary64 resolution across that range.
function kernelAtan(x: number): number {
  const z = x * x;
  let polynomial = -1 / 55;
  let sign = 1;
  for (let denominator = 53; denominator >= 1; denominator -= 2) {
    polynomial = sign / denominator + z * polynomial;
    sign = -sign;
  }
  return x * polynomial;
}

function atanPositive(value: number): number {
  if (value > 2.4142135623730950488) return PI_OVER_2 - kernelAtan(1 / value);
  if (value > 0.4142135623730950488) {
    return PI_OVER_4 + kernelAtan((value - 1) / (value + 1));
  }
  return kernelAtan(value);
}

function jsAtan2(y: number, x: number): number {
  requireFinite(y, 'y');
  requireFinite(x, 'x');
  if (y === 0) {
    if (x < 0 || Object.is(x, -0)) return Object.is(y, -0) ? -PI : PI;
    return y;
  }
  if (x === 0) return y < 0 ? -PI_OVER_2 : PI_OVER_2;
  const angle = atanPositive(Math.abs(y / x));
  if (x > 0) return y < 0 ? -angle : angle;
  return y < 0 ? angle - PI : PI - angle;
}

const JS_BACKEND: DmathBackend = Object.freeze({
  id: 'js',
  sin: jsSin,
  cos: jsCos,
  atan2: jsAtan2,
});

function clamp(x: number, lo: number, hi: number): number {
  requireFinite(x, 'x');
  requireFinite(lo, 'lo');
  requireFinite(hi, 'hi');
  if (lo > hi) throw new RangeError('lo must be <= hi');
  return x < lo ? lo : x > hi ? hi : x;
}

function roundTo(x: number, decimals: number): number {
  requireFinite(x, 'x');
  if (!Number.isInteger(decimals) || decimals < -15 || decimals > 15) {
    throw new RangeError('decimals must be an integer in [-15, 15]');
  }
  const scale = POWERS_OF_TEN[Math.abs(decimals)]!;
  const scaledMagnitude = decimals >= 0 ? Math.abs(x) * scale : Math.abs(x) / scale;
  if (!(scaledMagnitude < TWO_POW_53)) {
    throw new RangeError('|x| * 10^decimals must be < 2^53');
  }
  const integral = Math.floor(scaledMagnitude);
  const roundedMagnitude = scaledMagnitude - integral >= 0.5
    ? integral + 1
    : integral;
  const rounded = x < 0 ? -roundedMagnitude : roundedMagnitude;
  const result = decimals >= 0 ? rounded / scale : rounded * scale;
  return result === 0 && x < 0 ? -0 : result;
}

/** Construct one immutable, session-scoped deterministic math context. */
export function createDmath(options: {
  algorithm?: typeof DMATH_ALGORITHM;
  backend?: DmathBackend;
} = {}): Dmath {
  const algorithm = options.algorithm ?? DMATH_ALGORITHM;
  if (algorithm !== DMATH_ALGORITHM) {
    throw new RangeError(`unsupported dmath algorithm: ${String(algorithm)}`);
  }
  const backend = options.backend ?? JS_BACKEND;
  if (backend.id !== 'js' && backend.id !== 'wasm') {
    throw new TypeError('dmath backend id must be js or wasm');
  }
  const backendId = backend.id;
  const backendSin = backend.sin.bind(backend);
  const backendCos = backend.cos.bind(backend);
  const backendAtan2 = backend.atan2.bind(backend);
  const checkedResult = (value: number, operation: string): number => {
    if (!Number.isFinite(value)) {
      throw new RangeError(`${operation} backend result must be finite`);
    }
    return value;
  };
  return Object.freeze({
    algorithm,
    backend: backendId,
    sin: (x: number) => {
      requireFinite(x, 'x');
      if (Math.abs(x) > MAX_TRIG_INPUT) throw new RangeError('x must satisfy |x| <= 2^30');
      return checkedResult(backendSin(x), 'sin');
    },
    cos: (x: number) => {
      requireFinite(x, 'x');
      if (Math.abs(x) > MAX_TRIG_INPUT) throw new RangeError('x must satisfy |x| <= 2^30');
      return checkedResult(backendCos(x), 'cos');
    },
    atan2: (y: number, x: number) => {
      requireFinite(y, 'y');
      requireFinite(x, 'x');
      return checkedResult(backendAtan2(y, x), 'atan2');
    },
    clamp,
    roundTo,
  });
}

/** Frozen constants used by tests and external vector generators. */
export const DMATH_CONSTANTS = Object.freeze({
  PI,
  PI_OVER_2,
  PI_OVER_4,
  TWO_PI,
  MAX_TRIG_INPUT,
});
