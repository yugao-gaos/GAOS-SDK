/**
 * Reproduce dmath-1 coefficient provenance, fixed-point constants, accuracy
 * evidence, and golden result bits.
 *
 * Usage:
 *   npm run build
 *   node scripts/generate-dmath-evidence.mjs
 *   node scripts/generate-dmath-evidence.mjs --write
 *
 * `--write` updates only resultBits in the checked-in fixture. Review the
 * resulting diff before committing it.
 */

import { readFile, writeFile } from 'node:fs/promises';
import {
  ORACLE_BITS,
  ORACLE_ONE,
  ORACLE_PI,
  oracleAtan2,
  oracleCos,
  oracleSin,
  ulpDistance,
} from './dmath-oracle.mjs';
import {
  bytesToHex,
  createDmath,
} from '../dist/engine/index.js';

const fixtureUrl = new URL('../fixtures/dmath/dmath-1.vectors.json', import.meta.url);
const dmath = createDmath();

function factorial(value) {
  let result = 1;
  for (let factor = 2; factor <= value; factor++) result *= factor;
  return result;
}

const coefficients = {
  sin: Array.from({ length: 8 }, (_, index) => {
    const degree = index * 2 + 3;
    return (index % 2 === 0 ? -1 : 1) / factorial(degree);
  }),
  cos: Array.from({ length: 8 }, (_, index) => {
    const degree = index * 2 + 4;
    return (index % 2 === 0 ? 1 : -1) / factorial(degree);
  }),
};

const fixedShift = ORACLE_BITS - 256n;
const piOver2Fixed = (ORACLE_PI / 2n) >> fixedShift;
const inversePiOver2AtOracleScale = (2n * ORACLE_ONE * ORACLE_ONE) / ORACLE_PI;
const inversePiOver2Fixed = inversePiOver2AtOracleScale >> fixedShift;

function resultBits(value) {
  const buffer = new ArrayBuffer(8);
  new DataView(buffer).setFloat64(0, value, false);
  return bytesToHex(new Uint8Array(buffer));
}

let seed = 0x5eed_1234;
function randomUnit() {
  seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
  return seed / 0x1_0000_0000;
}

let maximumSinUlp = 0;
let maximumCosUlp = 0;
let maximumAtan2Ulp = 0;
for (let index = 0; index < 2_048; index++) {
  const angle = (randomUnit() * 2 - 1) * 1_073_741_824;
  maximumSinUlp = Math.max(maximumSinUlp, ulpDistance(dmath.sin(angle), oracleSin(angle)));
  maximumCosUlp = Math.max(maximumCosUlp, ulpDistance(dmath.cos(angle), oracleCos(angle)));
  const y = (randomUnit() * 2 - 1) * 1_000_000;
  const x = (randomUnit() * 2 - 1) * 1_000_000;
  maximumAtan2Ulp = Math.max(
    maximumAtan2Ulp,
    ulpDistance(dmath.atan2(y, x), oracleAtan2(y, x)),
  );
}
if (maximumSinUlp > 1 || maximumCosUlp > 1 || maximumAtan2Ulp > 3) {
  throw new Error(
    `dmath accuracy failed: sin=${maximumSinUlp}, cos=${maximumCosUlp}, `
    + `atan2=${maximumAtan2Ulp}`,
  );
}

const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
const write = process.argv.includes('--write');
const fixtureMismatches = [];
for (const [index, vector] of fixture.entries()) {
  const args = vector.args.map((value) => value === '-0' ? -0 : value);
  let result;
  if (vector.function === 'atan2') result = dmath.atan2(args[0], args[1]);
  else if (vector.function === 'clamp') result = dmath.clamp(args[0], args[1], args[2]);
  else if (vector.function === 'roundTo') result = dmath.roundTo(args[0], args[1]);
  else result = dmath[vector.function](args[0]);
  const generatedBits = resultBits(result);
  if (vector.resultBits !== generatedBits) {
    fixtureMismatches.push({
      index,
      function: vector.function,
      expected: vector.resultBits,
      generated: generatedBits,
    });
  }
  if (write) vector.resultBits = generatedBits;
}

const evidence = {
  provenance: 'clean-room factorial reciprocals + Machin pi (16*atan(1/5)-4*atan(1/239))',
  coefficients,
  fixedPoint: {
    bits: 256,
    inversePiOver2Hex: `0x${inversePiOver2Fixed.toString(16)}`,
    piOver2Hex: `0x${piOver2Fixed.toString(16)}`,
  },
  accuracy: {
    samples: 2_048,
    maximumSinUlp,
    maximumCosUlp,
    maximumAtan2Ulp,
  },
};
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

if (write) {
  await writeFile(fixtureUrl, `${JSON.stringify(fixture, null, 2)}\n`);
} else if (fixtureMismatches.length > 0) {
  throw new Error(
    `frozen dmath fixture is stale:\n${JSON.stringify(fixtureMismatches, null, 2)}`,
  );
}
