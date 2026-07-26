import { performance } from 'node:perf_hooks';
import { deflateSync } from 'node:zlib';
import { canonicalJson } from '../dist/protocol.js';
import { createBoundedValidatedJsonPatch } from '../dist/observation-codec.js';

/*
 * Measures the two v2 delivery policies, not two wire versions:
 *
 *   1. `patchStrategy: "never"` canonicalises and snapshots the whole view.
 *   2. `patchStrategy: "adaptive"` probes a bounded patch. After a probe loses,
 *      the kernel skips the next PATCH_BACKOFF_TICKS probes, so high-churn
 *      workloads converge near snapshot CPU while sparse workloads retain the
 *      bandwidth win.
 *
 * The compression columns show what permessage-deflate can reclaim in either
 * case. The activity sweep avoids treating one changed entity as representative
 * of every tick.
 */

const TICK_HZ = 20;
const SEATS = 4;
const SIZES = [50, 200, 500];
const ACTIVITY = [1, 5, 20, 'all'];
const ITERATIONS = 30;
const WARMUP = 10;
const MIN_REDUCTION = 4;
const MAX_OPERATIONS = 2_048;
const MAX_BYTES = 65_536;
const PATCH_BACKOFF_TICKS = 8;

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
const byteLength = (text) => Buffer.byteLength(text, 'utf8');
const perRoomMiBs = (bytes) => (bytes * TICK_HZ * SEATS) / (1024 * 1024);
const round = (value, places = 3) => Number(value.toFixed(places));

const rows = [];
for (const entities of SIZES) {
  const before = makeView(entities);
  for (const changed of ACTIVITY) {
    const after = mutate(before, entities, changed);
    const snapshotJson = canonicalJson(after);
    const snapshotBytes = byteLength(snapshotJson);
    const maximumPatchBytes = Math.min(
      MAX_BYTES,
      Math.floor(snapshotBytes / MIN_REDUCTION),
    );
    const patch = createBoundedValidatedJsonPatch(
      before,
      after,
      MAX_OPERATIONS,
      maximumPatchBytes,
    );
    const fellBack = patch === null;
    const wireJson = fellBack ? snapshotJson : patch.canonical;
    const wireBytes = byteLength(wireJson);
    const wireDeflated = deflated(wireJson);

    // Both paths include the canonical view required for equality and digest.
    const snapshotMs = timeIt(() => {
      canonicalJson(after);
      structuredClone(after);
    });
    const probeMs = timeIt(() => {
      const canonical = canonicalJson(after);
      const candidate = createBoundedValidatedJsonPatch(
        before,
        after,
        MAX_OPERATIONS,
        Math.min(MAX_BYTES, Math.floor(byteLength(canonical) / MIN_REDUCTION)),
      );
      if (candidate === null) {
        structuredClone(after);
      }
    });
    const adaptiveSteadyMs = fellBack
      ? (probeMs + snapshotMs * PATCH_BACKOFF_TICKS) / (PATCH_BACKOFF_TICKS + 1)
      : probeMs;

    rows.push({
      entities,
      changed,
      fellBack,
      bytes: {
        snapshot: snapshotBytes,
        adaptive: wireBytes,
        reduction: round(snapshotBytes / wireBytes, 1),
      },
      deflated: {
        snapshot: deflated(snapshotJson),
        adaptive: wireDeflated,
        reduction: round(deflated(snapshotJson) / wireDeflated, 1),
      },
      cpuMsPerSeatPerTick: {
        snapshot: round(snapshotMs),
        adaptiveProbe: round(probeMs),
        adaptiveSteady: round(adaptiveSteadyMs),
        probeRatio: round(probeMs / snapshotMs, 2),
        steadyRatio: round(adaptiveSteadyMs / snapshotMs, 2),
      },
      roomMiBs: {
        snapshot: round(perRoomMiBs(snapshotBytes)),
        adaptive: round(perRoomMiBs(wireBytes)),
        adaptiveDeflated: round(perRoomMiBs(wireDeflated)),
      },
      tickBudgetPct: {
        snapshot: round((snapshotMs * SEATS) / (1000 / TICK_HZ) * 100, 1),
        adaptiveProbe: round((probeMs * SEATS) / (1000 / TICK_HZ) * 100, 1),
        adaptiveSteady: round((adaptiveSteadyMs * SEATS) / (1000 / TICK_HZ) * 100, 1),
      },
    });
  }
}

console.log(JSON.stringify({
  implementation: 'gaos observation codec v2 delivery strategies',
  conditions: {
    tickHz: TICK_HZ,
    seats: SEATS,
    iterations: ITERATIONS,
    patchBackoffTicks: PATCH_BACKOFF_TICKS,
  },
  rows,
}, null, 1));
