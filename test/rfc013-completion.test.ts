import { describe, expect, it } from 'vitest';
import {
  SeatControlLedger,
  aggregateBenchmarkScores,
  assertBenchmarkManifest,
  planBenchmarkEpisodes,
  presentationFrameFromObservation,
  type BenchmarkManifest,
  type PresentationEvent,
} from '../src/index.js';
import {
  assertGameDescriptor,
  policyEntropy,
  sampleActionDistribution,
  validateActionDistribution,
  validateChanceOutcomes,
  winRate,
  type GameDescriptor,
} from '../src/engine/index.js';
import type { ObservationDelta } from '../src/session.js';

describe('RFC-013 dynamic seat control', () => {
  it('keeps logical seats stable and reconnects the same authority without a new epoch', () => {
    const ledger = new SeatControlLedger('control', {
      alpha: { controllerId: 'human-a', kind: 'human', publicKey: 'key-a' },
      beta: null,
    });
    expect(ledger.seats()).toEqual(['alpha', 'beta']);
    expect(ledger.reconnect('alpha', {
      controllerId: 'human-a',
      kind: 'human',
      publicKey: 'key-a',
    }).epoch).toBe(0);
    expect(ledger.transitionRevision()).toBe(0);
    expect(() => ledger.reconnect('alpha', {
      controllerId: 'other',
      kind: 'human',
      publicKey: 'key-a',
    })).toThrow(/active controller/);
  });

  it('prepares and atomically commits a two-seat host-policy swap', () => {
    const ledger = new SeatControlLedger('swap', {
      alpha: { controllerId: 'a', kind: 'human' },
      beta: { controllerId: 'b', kind: 'agent' },
    });
    const prepared = ledger.prepareSeatControl([
      {
        seat: 'alpha',
        status: 'occupied',
        controller: { controllerId: 'b', kind: 'agent' },
        reason: 'transferred',
      },
      {
        seat: 'beta',
        status: 'occupied',
        controller: { controllerId: 'a', kind: 'human' },
        reason: 'transferred',
      },
    ], { mode: 'host-policy', policy: 'moderated-swap' });

    expect(ledger.current('alpha').controller?.controllerId).toBe('a');
    expect(prepared.epochs.map(({ effectiveTransitionRevision }) => effectiveTransitionRevision))
      .toEqual([1, 1]);
    ledger.commit(prepared);
    expect(ledger.current('alpha').controller?.controllerId).toBe('b');
    expect(ledger.current('beta').controller?.controllerId).toBe('a');
    expect(ledger.authorize('alpha', 0, 'a', 0).epoch).toBe(0);
    expect(() => ledger.authorize('alpha', 0, 'a')).toThrow(/inactive/);
    expect(ledger.authorize('alpha', 1, 'b').authorization).toBe('host-policy');
  });

  it('requires handoff evidence and preserves digest continuity through checkpoint restore', () => {
    const ledger = new SeatControlLedger('handoff', {
      alpha: { controllerId: 'human', kind: 'human', publicKey: 'old' },
    });
    expect(() => ledger.prepareSeatControl([{
      seat: 'alpha',
      status: 'occupied',
      controller: { controllerId: 'agent', kind: 'agent', publicKey: 'new' },
      reason: 'substituted',
    }], {
      mode: 'controller-handoff',
      outgoingSignatures: {},
      incomingSignatures: { alpha: 'incoming' },
    })).toThrow(/outgoing signature/);

    const prepared = ledger.prepareSeatControl([{
      seat: 'alpha',
      status: 'occupied',
      controller: { controllerId: 'agent', kind: 'agent', publicKey: 'new' },
      reason: 'substituted',
      previousChainHead: 'head',
    }], {
      mode: 'controller-handoff',
      outgoingSignatures: { alpha: 'outgoing' },
      incomingSignatures: { alpha: 'incoming' },
    });
    ledger.commit(prepared);
    expect(ledger.current('alpha').authorizationEvidence).toEqual({
      mode: 'controller-handoff',
      outgoingSignatures: { alpha: 'outgoing' },
      incomingSignatures: { alpha: 'incoming' },
    });
    const restored = SeatControlLedger.rehydrate(ledger.checkpoint());
    expect(restored.current('alpha')).toEqual(ledger.current('alpha'));

    const damaged = structuredClone(ledger.checkpoint());
    damaged.epochs[1]!.previousEpochDigest = 'damaged';
    expect(() => SeatControlLedger.rehydrate(damaged)).toThrow(/digest|continuity/);
  });

  it('allows only one in-flight prepared control transition', () => {
    const ledger = new SeatControlLedger('stale', { alpha: null, beta: null });
    const first = ledger.prepareSeatControl([{
      seat: 'alpha',
      status: 'occupied',
      controller: { controllerId: 'a', kind: 'service' },
      reason: 'substituted',
    }], { mode: 'host-policy', policy: 'assignment' });
    expect(() => ledger.prepareSeatControl([{
      seat: 'beta',
      status: 'occupied',
      controller: { controllerId: 'b', kind: 'service' },
      reason: 'substituted',
    }], { mode: 'host-policy', policy: 'assignment' })).toThrow(/already prepared/);
    ledger.commit(first);
    expect(() => ledger.prepareSeatControl([{
      seat: 'beta',
      status: 'occupied',
      controller: { controllerId: 'b', kind: 'service' },
      reason: 'substituted',
    }], { mode: 'host-policy', policy: 'assignment' })).not.toThrow();
  });

  it('rejects malformed declared-seat and epoch checkpoint graphs', () => {
    const ledger = new SeatControlLedger('invalid-checkpoint', {
      alpha: { controllerId: 'a', kind: 'human' },
      beta: null,
    });
    ledger.commit(ledger.prepareSeatControl([{
      seat: 'alpha',
      status: 'occupied',
      controller: { controllerId: 'next', kind: 'agent' },
      reason: 'substituted',
    }], { mode: 'host-policy', policy: 'replacement' }));
    const checkpoint = ledger.checkpoint();
    const expectRejected = (
      mutate: (value: ReturnType<SeatControlLedger['checkpoint']>) => void,
      message: RegExp,
    ) => {
      const damaged = structuredClone(checkpoint);
      mutate(damaged);
      expect(() => SeatControlLedger.rehydrate(damaged)).toThrow(message);
    };

    expectRejected((value) => {
      value.seats = ['alpha', 'alpha'];
    }, /duplicate logical seat/);
    expectRejected((value) => {
      value.epochs[0]!.seat = 'gamma';
    }, /undeclared logical seat/);
    expectRejected((value) => {
      value.epochs = value.epochs.filter(({ seat }) => seat !== 'beta');
    }, /missing epoch history/);
    expectRejected((value) => {
      value.epochs = [
        ...value.epochs,
        structuredClone(value.epochs.find(
          ({ seat, epoch }) => seat === 'alpha' && epoch === 0,
        )!),
      ];
    }, /non-consecutive epochs/);
    expectRejected((value) => {
      value.epochs.find(({ seat, epoch }) => seat === 'alpha' && epoch === 0)!.reason = 'revoked';
    }, /invalid genesis/);
    expectRejected((value) => {
      value.epochs.find(({ seat, epoch }) => seat === 'alpha' && epoch === 1)!
        .effectiveTransitionRevision = 0;
    }, /invalid epoch ordering/);
    expectRejected((value) => {
      value.sessionId = '';
    }, /sessionId/);
    expectRejected((value) => {
      value.transitionRevision = 2;
    }, /missing committed.*revision 2/);
  });
});

describe('RFC-013 presentation and research contracts', () => {
  it('suppresses old presentation cues on repair and rejects duplicate cue ids', () => {
    const observation: ObservationDelta<{ status: string }> = {
      seat: 'alpha',
      transitionRevision: 4,
      viewRevision: 3,
      tick: 2,
      codec: 'v2',
      origin: 'snapshot',
      acknowledgements: [],
      rejections: [],
      body: { kind: 'snapshot', view: { status: 'playing' } },
      viewDigest: 1,
    };
    const events: PresentationEvent[] = [{ id: 'move:1', type: 'move' }];
    expect(presentationFrameFromObservation(
      observation,
      { status: 'playing' },
      events,
    )).toMatchObject({
      transitionRevision: 4,
      tick: 2,
      repair: true,
      events: [],
    });
    expect(() => presentationFrameFromObservation(
      { ...observation, origin: 'resolution' },
      { status: 'playing' },
      [...events, ...events],
    )).toThrow(/duplicate/);
  });

  it('validates descriptors and canonically ordered chance distributions', () => {
    const descriptor: GameDescriptor = {
      id: 'tests/strategy',
      version: '1',
      dynamics: 'simultaneous',
      chance: 'explicit',
      information: 'imperfect',
      utility: 'zero-sum',
      rewards: 'terminal',
      minPlayers: 2,
      maxPlayers: 2,
      minUtility: -1,
      maxUtility: 1,
      maxEpisodeLength: 100,
    };
    expect(() => assertGameDescriptor(descriptor)).not.toThrow();
    expect(() => assertGameDescriptor({ ...descriptor, maxPlayers: 1 })).toThrow(/maxPlayers/);
    for (const [field, value] of [
      ['dynamics', 'alternating'],
      ['chance', 'random'],
      ['information', 'hidden'],
      ['utility', 'cooperative'],
      ['rewards', 'dense'],
    ] as const) {
      expect(() => assertGameDescriptor({
        ...descriptor,
        [field]: value,
      } as GameDescriptor)).toThrow(new RegExp(field));
    }

    const distribution = [
      { action: { id: 'a' }, probability: 0.25 },
      { action: { id: 'b' }, probability: 0.75 },
    ];
    expect(validateChanceOutcomes(distribution)).toBe(distribution);
    expect(() => validateChanceOutcomes([...distribution].reverse())).toThrow(/canonical/);
    expect(() => validateActionDistribution(distribution, {
      legalActions: [{ id: 'a' }],
    })).toThrow(/illegal/);
    expect(sampleActionDistribution(distribution, 0.24)).toEqual({ id: 'a' });
    expect(sampleActionDistribution(distribution, 0.25)).toEqual({ id: 'b' });
    expect(policyEntropy([
      { action: { id: 'a' }, probability: 0.5 },
      { action: { id: 'b' }, probability: 0.5 },
    ])).toBe(1);
    expect(winRate(5, 10)).toMatchObject({ rate: 0.5, episodes: 10 });
  });
});

describe('RFC-013 neutral benchmark primitives', () => {
  const manifest: BenchmarkManifest = {
    schema: 'gaos.benchmark-manifest',
    schemaVersion: '1.0',
    benchmark: {
      id: 'example-strategy',
      version: '1.0.0',
      adapter: 'sha256:adapter',
    },
    tasks: [
      { id: 'small', seeds: [101, 102], episodes: 2, maxSteps: 500, weight: 1 },
      { id: 'large', seeds: [201], episodes: 1, maxSteps: 800, weight: 3 },
    ],
    scoring: { plugin: './score.mjs', aggregation: 'weighted-mean' },
    submission: { requireSignedSeats: true, requireCompleteCoverage: true },
  };

  it('validates and schedules authored task, seed, and episode order deterministically', () => {
    expect(() => assertBenchmarkManifest(manifest)).not.toThrow();
    expect(planBenchmarkEpisodes(manifest)).toEqual([
      { index: 0, taskId: 'small', seed: 101, episode: 0, maxSteps: 500 },
      { index: 1, taskId: 'small', seed: 101, episode: 1, maxSteps: 500 },
      { index: 2, taskId: 'small', seed: 102, episode: 0, maxSteps: 500 },
      { index: 3, taskId: 'small', seed: 102, episode: 1, maxSteps: 500 },
      { index: 4, taskId: 'large', seed: 201, episode: 0, maxSteps: 800 },
    ]);
  });

  it('rejects malformed parsed manifest enums, flags, and optional strings', () => {
    expect(() => assertBenchmarkManifest({
      ...manifest,
      scoring: { ...manifest.scoring, aggregation: 'median' },
    } as unknown as BenchmarkManifest)).toThrow(/aggregation/);
    expect(() => assertBenchmarkManifest({
      ...manifest,
      submission: {
        ...manifest.submission,
        requireSignedSeats: 'yes',
      },
    } as unknown as BenchmarkManifest)).toThrow(/booleans/);
    expect(() => assertBenchmarkManifest({
      ...manifest,
      observationModalities: ['text', ''],
    })).toThrow(/observationModalities/);
    expect(() => assertBenchmarkManifest({
      ...manifest,
      observationModalities: 'text',
    } as unknown as BenchmarkManifest)).toThrow(/observationModalities/);
    expect(() => assertBenchmarkManifest({
      ...manifest,
      agentInterface: '',
    })).toThrow(/agentInterface/);
  });

  it('recomputes complete aggregates and rejects missing or duplicate scores', () => {
    expect(aggregateBenchmarkScores(manifest, [
      { taskId: 'small', score: 0.5 },
      { taskId: 'large', score: 1 },
    ])).toEqual({
      aggregateScore: 0.875,
      taskScores: { small: 0.5, large: 1 },
    });
    expect(() => aggregateBenchmarkScores(manifest, [
      { taskId: 'small', score: 0.5 },
    ])).toThrow(/missing/);
  });
});
