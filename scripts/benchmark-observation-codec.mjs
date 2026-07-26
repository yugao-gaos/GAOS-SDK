import { performance } from 'node:perf_hooks';
import { canonicalJson } from '../dist/protocol.js';
import { createValidatedJsonPatch } from '../dist/observation-codec.js';

const sizes = [50, 200, 500];
const rows = [];
for (const entities of sizes) {
  const before = {
    actions: [],
    status: 'playing',
    hud: { actionsUsed: 0 },
    entities: Object.fromEntries(Array.from({ length: entities }, (_, index) => [
      `entity-${index}`,
      {
        position: [index % 25, Math.floor(index / 25)],
        owner: `seat-${index % 4}`,
        state: `stable-state-${index}`,
      },
    ])),
  };
  const after = structuredClone(before);
  after.hud.actionsUsed = 1;
  after.entities['entity-0'].position = [1, 0];
  for (let index = 0; index < 5; index++) createValidatedJsonPatch(before, after);
  const iterations = 20;
  const started = performance.now();
  let patch;
  for (let index = 0; index < iterations; index++) {
    patch = createValidatedJsonPatch(before, after);
  }
  const elapsedMs = (performance.now() - started) / iterations;
  const snapshotBytes = Buffer.byteLength(canonicalJson(after));
  const patchBytes = Buffer.byteLength(canonicalJson(patch));
  rows.push({
    entities,
    snapshotBytes,
    patchBytes,
    reduction: snapshotBytes / patchBytes,
    encodeMs: elapsedMs,
  });
}
console.log(JSON.stringify({ implementation: 'gaos observation codec v2', rows }));
