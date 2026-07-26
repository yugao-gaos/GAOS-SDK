import { performance } from 'node:perf_hooks';
import { deflateSync, inflateSync } from 'node:zlib';
import { canonicalJson } from '../dist/protocol.js';
import { createBoundedValidatedJsonPatch } from '../dist/observation-codec.js';

/*
 * Measures the two v2 delivery policies, not two wire versions:
 *
 *   1. `patchStrategy: "never"` canonicalises and snapshots the whole view.
 *   2. `patchStrategy: "adaptive"` probes a bounded patch. Repeated losses
 *      exponentially back off from PATCH_BACKOFF_TICKS to
 *      MAX_PATCH_BACKOFF_TICKS, so high-churn workloads converge near snapshot
 *      CPU while sparse workloads retain the bandwidth win.
 *
 * Compression columns include synchronous encode/decode CPU at zlib levels 1
 * and 6. This is not a WebSocket implementation benchmark, but it makes the
 * bandwidth/CPU trade visible instead of calling compression free.
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
const MAX_PATCH_BACKOFF_TICKS = 32;

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

const byteLength = (text) => Buffer.byteLength(text, 'utf8');
const perRoomMiBs = (bytes) => (bytes * TICK_HZ * SEATS) / (1024 * 1024);
const round = (value, places = 3) => Number(value.toFixed(places));

function compressionMetrics(text, level) {
  const input = Buffer.from(text, 'utf8');
  const compressed = deflateSync(input, { level });
  return {
    bytes: compressed.length,
    encodeMs: timeIt(() => deflateSync(input, { level })),
    decodeMs: timeIt(() => inflateSync(compressed)),
  };
}

const ownershipRows = SIZES.map((entities) => {
  const views = new Map();
  const scopes = new Map();
  for (let seat = 0; seat < SEATS; seat++) {
    const view = makeView(entities);
    views.set(`seat-${seat}`, view);
    scopes.set(`seat-${seat}`, {
      participantId: `seat-${seat}`,
      scopeId: `seat-${seat}`,
      declaration: null,
      view,
    });
  }
  const deepCloneMs = timeIt(() => {
    new Map([...views].map(([key, view]) => [key, structuredClone(view)]));
    new Map([...scopes].map(([key, scope]) => [key, structuredClone(scope)]));
  });
  const copyOnWriteMs = timeIt(() => {
    new Map(views);
    new Map([...scopes].map(([key, scope]) => [key, {
      ...scope,
      declaration: structuredClone(scope.declaration),
      view: scope.view,
    }]));
  });
  return {
    entities,
    seats: SEATS,
    scopesPerSeat: 1,
    deepCloneMs: round(deepCloneMs),
    copyOnWriteMs: round(copyOnWriteMs),
    speedup: round(deepCloneMs / copyOnWriteMs, 1),
  };
});

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
    const snapshotDeflate1 = compressionMetrics(snapshotJson, 1);
    const snapshotDeflate6 = compressionMetrics(snapshotJson, 6);
    const adaptiveDeflate1 = compressionMetrics(wireJson, 1);
    const adaptiveDeflate6 = compressionMetrics(wireJson, 6);

    // Mirrors the optimized default scope: one internal copy, then a public
    // snapshot copy only when the body falls back.
    const snapshotMs = timeIt(() => {
      const scoped = structuredClone(after);
      canonicalJson(scoped);
      structuredClone(scoped);
    });
    const probeMs = timeIt(() => {
      const scoped = structuredClone(after);
      const canonical = canonicalJson(scoped);
      const candidate = createBoundedValidatedJsonPatch(
        before,
        scoped,
        MAX_OPERATIONS,
        Math.min(MAX_BYTES, Math.floor(byteLength(canonical) / MIN_REDUCTION)),
      );
      if (candidate === null) {
        structuredClone(scoped);
      }
    });
    const adaptiveBaseMs = fellBack
      ? (probeMs + snapshotMs * PATCH_BACKOFF_TICKS) / (PATCH_BACKOFF_TICKS + 1)
      : probeMs;
    const adaptiveMaxMs = fellBack
      ? (probeMs + snapshotMs * MAX_PATCH_BACKOFF_TICKS)
        / (MAX_PATCH_BACKOFF_TICKS + 1)
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
        level1: {
          snapshot: snapshotDeflate1.bytes,
          adaptive: adaptiveDeflate1.bytes,
          reduction: round(snapshotDeflate1.bytes / adaptiveDeflate1.bytes, 1),
        },
        level6: {
          snapshot: snapshotDeflate6.bytes,
          adaptive: adaptiveDeflate6.bytes,
          reduction: round(snapshotDeflate6.bytes / adaptiveDeflate6.bytes, 1),
        },
      },
      cpuMsPerSeatPerTick: {
        snapshot: round(snapshotMs),
        adaptiveProbe: round(probeMs),
        adaptiveBaseBackoff: round(adaptiveBaseMs),
        adaptiveMaxBackoff: round(adaptiveMaxMs),
        probeRatio: round(probeMs / snapshotMs, 2),
        maxBackoffRatio: round(adaptiveMaxMs / snapshotMs, 2),
      },
      compressionCpuMs: {
        level1: {
          snapshotEncode: round(snapshotDeflate1.encodeMs),
          snapshotDecode: round(snapshotDeflate1.decodeMs),
          adaptiveEncode: round(adaptiveDeflate1.encodeMs),
          adaptiveDecode: round(adaptiveDeflate1.decodeMs),
        },
        level6: {
          snapshotEncode: round(snapshotDeflate6.encodeMs),
          snapshotDecode: round(snapshotDeflate6.decodeMs),
          adaptiveEncode: round(adaptiveDeflate6.encodeMs),
          adaptiveDecode: round(adaptiveDeflate6.decodeMs),
        },
      },
      roomMiBs: {
        snapshot: round(perRoomMiBs(snapshotBytes)),
        adaptive: round(perRoomMiBs(wireBytes)),
        adaptiveDeflatedLevel1: round(perRoomMiBs(adaptiveDeflate1.bytes)),
        adaptiveDeflatedLevel6: round(perRoomMiBs(adaptiveDeflate6.bytes)),
      },
      tickBudgetPct: {
        snapshot: round((snapshotMs * SEATS) / (1000 / TICK_HZ) * 100, 1),
        adaptiveProbe: round((probeMs * SEATS) / (1000 / TICK_HZ) * 100, 1),
        adaptiveBaseBackoff: round((adaptiveBaseMs * SEATS) / (1000 / TICK_HZ) * 100, 1),
        adaptiveMaxBackoff: round((adaptiveMaxMs * SEATS) / (1000 / TICK_HZ) * 100, 1),
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
    maxPatchBackoffTicks: MAX_PATCH_BACKOFF_TICKS,
    compressionLevels: [1, 6],
    derivedViews: 'copy-on-write',
  },
  ownershipRows,
  rows,
}, null, 1));
