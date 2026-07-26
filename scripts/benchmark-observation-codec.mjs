import { performance } from 'node:perf_hooks';
import { deflateSync } from 'node:zlib';
import { canonicalJson } from '../dist/protocol.js';
import { createValidatedJsonPatch } from '../dist/observation-codec.js';

/*
 * Answers two questions the byte-only benchmark could not:
 *
 *   1. CPU — is v2 net cheaper or net more expensive than v1? v1's per-seat
 *      per-tick cost is canonicalising the whole view. v2's is diffing plus
 *      canonicalising the patch. Timing the patch alone measures what v2
 *      spends without measuring what it saves, which cannot settle the
 *      question RFC-009 §3.3 actually asked.
 *   2. Compression — how much does transport compression (permessage-deflate)
 *      reclaim on its own? If it reclaims most of the gap, a custom binary
 *      codec is not worth building.
 *
 * Also sweeps activity. The previous version changed exactly one entity, which
 * is the best case, and made the patch a constant 122 B at every table size —
 * so its headline "reduction" grew with the table for the wrong reason.
 */

const TICK_HZ = 20;
const SEATS = 4;
const SIZES = [50, 200, 500];
const ACTIVITY = [1, 5, 20, 'all'];
const ITERATIONS = 30;
const WARMUP = 10;
const MIN_REDUCTION = 4;

function makeView(entities) {
  return {
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
}

function mutate(view, entities, changed) {
  const next = structuredClone(view);
  next.hud.actionsUsed = 1;
  const count = changed === 'all' ? entities : Math.min(changed, entities);
  for (let index = 0; index < count; index++) {
    next.entities[`entity-${index}`].position = [
      (index % 25) + 1,
      Math.floor(index / 25),
    ];
  }
  return next;
}

function timeIt(fn) {
  for (let index = 0; index < WARMUP; index++) fn();
  const started = performance.now();
  for (let index = 0; index < ITERATIONS; index++) fn();
  return (performance.now() - started) / ITERATIONS;
}

const deflated = (text) => deflateSync(Buffer.from(text, 'utf8')).length;
const perRoomMiBs = (bytes) => (bytes * TICK_HZ * SEATS) / (1024 * 1024);
const round = (value, places = 3) => Number(value.toFixed(places));

const rows = [];
for (const entities of SIZES) {
  const before = makeView(entities);
  for (const changed of ACTIVITY) {
    const after = mutate(before, entities, changed);

    // v1: serialise the whole view, every seat, every tick.
    const snapshotJson = canonicalJson(after);
    const v1Ms = timeIt(() => canonicalJson(after));

    // v2: diff against the previous view, then serialise the patch.
    const patchJson = canonicalJson(createValidatedJsonPatch(before, after));
    const v2Ms = timeIt(() => canonicalJson(createValidatedJsonPatch(before, after)));

    // Match the kernel rule: a patch ships only if it wins by MIN_REDUCTION.
    const fellBack = patchJson.length * MIN_REDUCTION > snapshotJson.length;
    const wireBytes = fellBack ? snapshotJson.length : patchJson.length;
    const wireDeflated = fellBack ? deflated(snapshotJson) : deflated(patchJson);

    rows.push({
      entities,
      changed,
      fellBack,
      bytes: {
        v1: snapshotJson.length,
        v2: wireBytes,
        reduction: round(snapshotJson.length / wireBytes, 1),
      },
      deflated: {
        v1: deflated(snapshotJson),
        v2: wireDeflated,
        reduction: round(deflated(snapshotJson) / wireDeflated, 1),
      },
      cpuMsPerSeatPerTick: {
        v1: round(v1Ms),
        v2: round(v2Ms),
        // > 1 means v2 costs more CPU per seat per tick than v1.
        ratio: round(v2Ms / v1Ms, 2),
      },
      roomMiBs: {
        v1: round(perRoomMiBs(snapshotJson.length)),
        v2: round(perRoomMiBs(wireBytes)),
        v2Deflated: round(perRoomMiBs(wireDeflated)),
      },
      // Share of one 20 Hz tick (50 ms) spent encoding for every seat.
      tickBudgetPct: {
        v1: round((v1Ms * SEATS) / (1000 / TICK_HZ) * 100, 1),
        v2: round((v2Ms * SEATS) / (1000 / TICK_HZ) * 100, 1),
      },
    });
  }
}

console.log(JSON.stringify({
  implementation: 'gaos observation codec v2',
  conditions: { tickHz: TICK_HZ, seats: SEATS, iterations: ITERATIONS },
  rows,
}, null, 1));
