import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import {
  verifyEd25519Base64,
} from '../dist/engine/index.js';

const fixture = JSON.parse(await readFile(
  new URL(
    '../fixtures/signatures/gaos.submission.ed25519.v1.vectors.json',
    import.meta.url,
  ),
  'utf8',
));
const vector = fixture.vectors[0];
const message = Uint8Array.from(Buffer.from(vector.preimageHex, 'hex'));
const iterations = Number.parseInt(process.argv[2] ?? '200', 10);

if (!Number.isSafeInteger(iterations) || iterations < 1) {
  throw new RangeError('iterations must be a positive integer');
}
for (let index = 0; index < 5; index++) {
  if (!verifyEd25519Base64(vector.publicKey, message, vector.signature)) {
    throw new Error('signature benchmark vector did not verify');
  }
}
const started = performance.now();
for (let index = 0; index < iterations; index++) {
  verifyEd25519Base64(vector.publicKey, message, vector.signature);
}
const elapsed = performance.now() - started;
console.log(JSON.stringify({
  implementation: 'gaos pure-js synchronous Ed25519',
  iterations,
  elapsedMs: elapsed,
  millisecondsPerVerify: elapsed / iterations,
}));
