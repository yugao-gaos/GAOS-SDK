import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  canonicalJson,
  makeTickId,
  type JsonValue,
} from '../src/protocol.js';
import {
  SUBMISSION_SIGNATURE_ALGORITHM,
  exportSubmissionPublicKey,
  generateSubmissionKeyPair,
  recheckReplaySignatures,
  runLevelSeed,
  signSubmissionV1,
  submissionChainHashV1,
  submissionGenesisHashV1,
  submissionRosterHashV1,
  type ReplayGameRef,
  type TickReducer,
  type TickView,
} from '../src/engine/index.js';
import {
  IntentCollectionError,
  SessionAdvanceError,
  applyObservationDelta,
  applyJsonPatch,
  createJsonPatch,
  createTickRate,
  createSessionKernel,
  finalizeReplay,
  finalizeRunReplay,
  rehydrateKernel,
  sessionHeaderFor,
  type InterestSubmission,
  type SessionKernelOptions,
  type SessionTranscript,
} from '../src/session.js';

interface Level { goal: number }
interface State { total: number; actionsUsed: number }
interface View extends TickView {
  entities: ReadonlyArray<{ id: string; value: number }>;
  catalog: Readonly<Record<string, string>>;
  private?: { owner: string; value: string };
}
type Command = { amount: number };

const game: ReplayGameRef = {
  id: 'tests/rfc010-completion',
  version: '1',
  adapter: { id: 'tests/rfc010-completion/reducer', version: '1' },
};

const reducer: TickReducer<Level, State, View> = {
  init: () => ({ total: 0, actionsUsed: 0 }),
  validateCommand: (_state, _seat, action) => {
    if ((action.payload as { amount?: number } | undefined)?.amount !== 1) {
      throw new Error('amount must be one');
    }
  },
  advance: (state, inputs) => ({
    total: state.total + inputs.reduce(
      (sum, input) => sum + ((input.payload as { amount: number }).amount),
      0,
    ),
    actionsUsed: state.actionsUsed + inputs.length,
  }),
  view: (state) => ({
    actions: [{ id: 'Action 1', params: 'none' }],
    status: state.total >= 1 ? 'won' : 'playing',
    ...(state.total >= 1 ? { stars: 1 } : {}),
    hud: { actionsUsed: state.actionsUsed },
    entities: Array.from({ length: 20 }, (_, index) => ({
      id: `entity-${index}`,
      value: index === 0 ? state.total : index,
    })),
    catalog: Object.fromEntries(Array.from(
      { length: 80 },
      (_, index) => [`item-${index}`, `stable-description-${index}`],
    )),
  }),
  viewFor: (state, seat) => ({
    ...reducer.view(state),
    private: { owner: seat, value: `secret-${seat}` },
  }),
};

async function signedOptions() {
  const pair = await generateSubmissionKeyPair();
  const publicKey = await exportSubmissionPublicKey(pair.publicKey);
  const seatKeys = [{
    id: 'alpha',
    publicKey,
    alg: SUBMISSION_SIGNATURE_ALGORITHM,
    signingTier: { N: 10 },
  }];
  const options: SessionKernelOptions<Level, State, Command, View> = {
    sessionId: 'rfc010-completion',
    game,
    levelId: 'one',
    reducer,
    level: { goal: 1 },
    seed: 7,
    seedPolicy: 'explicit',
    seats: ['alpha'],
    cadence: { mode: 'turns' },
    hostTime: 'none',
    commandToAction: (command, context) => ({
      id: 'Action 1',
      seat: context.participantId,
      payload: structuredClone(command),
    }),
    seatKeys,
    signaturePolicy: { scheme: 'gaos.submission.ed25519.v1' },
    observationCodec: { version: 'v2', maxBytes: 65_536 },
    interest: {
      narrowView: (view, context) => {
        const declaration = context.declaration as { entityIds: string[] };
        const { private: _private, ...publicView } = view;
        return {
          ...publicView,
          entities: view.entities.filter((entry) => declaration.entityIds.includes(entry.id)),
        };
      },
    },
  };
  return { pair, seatKeys, options };
}

describe('RFC-010 completed migration-informed scope', () => {
  it('re-exports the session construction surface at runtime', () => {
    expect(createTickRate(20).ticksPerSecond).toBe(20);
  });

  it('escapes JSON Pointer paths, replaces arrays atomically, and blocks prototype paths', () => {
    const previous: JsonValue = {
      'a/b': { '~key': 1 },
      array: [1, 2],
    };
    const next: JsonValue = {
      'a/b': { '~key': 2 },
      array: [1, 3],
    };
    const patch = createJsonPatch(previous, next);
    expect(patch).toContainEqual({
      op: 'replace',
      path: '/a~1b/~0key',
      value: 2,
    });
    expect(patch).toContainEqual({
      op: 'replace',
      path: '/array',
      value: [1, 3],
    });
    expect(applyJsonPatch(previous, patch)).toEqual(next);
    expect(() => applyJsonPatch({}, [{
      op: 'add',
      path: '/__proto__/polluted',
      value: true,
    }])).toThrow(/unsafe JSON Pointer/);
  });

  it('orders signed interest scopes, proves narrowing, emits v2 patches, and rechecks replay', async () => {
    const { pair, seatKeys, options } = await signedOptions();
    const kernel = createSessionKernel(options);
    const gameplayDigest = kernel.digest();
    const rosterHash = submissionRosterHashV1(seatKeys);
    const genesis = submissionGenesisHashV1(options.sessionId, 'alpha', rosterHash);
    const declaration = { entityIds: ['entity-3'] };
    const interestCommand: JsonValue = {
      kind: 'interest',
      scopeId: 'phone',
      declaration,
    };
    const interestEnvelope = {
      sessionId: options.sessionId,
      seat: 'alpha',
      submissionId: 'interest-1',
      cursor: 0,
      tick: 0,
      clientTime: 1,
      command: interestCommand,
      prevChainHash: genesis,
    };
    const interest: InterestSubmission = {
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: options.sessionId,
      tickId: makeTickId(options.sessionId, 0),
      revision: 0,
      participantId: 'alpha',
      submissionId: 'interest-1',
      scopeId: 'phone',
      declaration,
      clientTime: 1,
      prevChainHash: genesis,
      sig: await signSubmissionV1(pair.privateKey, interestEnvelope),
    };
    const preparedInterest = kernel.prepareInterest(interest);
    expect(preparedInterest.deltas[0]).toMatchObject({
      scopeId: 'phone',
      origin: 'interest',
      viewRevision: 0,
      body: { kind: 'snapshot' },
    });
    kernel.commit(preparedInterest);
    expect(kernel.digest()).toBe(gameplayDigest);
    expect(kernel.observe('alpha', 'phone').entities.map(({ id }) => id))
      .toEqual(['entity-3']);
    expect(kernel.observe('alpha', 'phone')).not.toHaveProperty('private');
    expect(kernel.snapshot('alpha', 0, 'phone').origin).toBe('snapshot');
    expect(canonicalJson(kernel.observe('alpha', 'phone') as unknown as JsonValue).length)
      .toBeLessThan(canonicalJson(kernel.observe('alpha') as unknown as JsonValue).length);

    const widenedDeclaration = { entityIds: ['entity-3', 'entity-4'] };
    const widenedCommand: JsonValue = {
      kind: 'interest',
      scopeId: 'phone',
      declaration: widenedDeclaration,
    };
    const widenedEnvelope = {
      sessionId: options.sessionId,
      seat: 'alpha',
      submissionId: 'interest-2',
      cursor: 0,
      tick: 0,
      clientTime: 2,
      command: widenedCommand,
      prevChainHash: submissionChainHashV1(interestEnvelope),
    };
    const widened = kernel.prepareInterest({
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: options.sessionId,
      tickId: makeTickId(options.sessionId, 0),
      revision: 0,
      participantId: 'alpha',
      submissionId: 'interest-2',
      scopeId: 'phone',
      declaration: widenedDeclaration,
      clientTime: 2,
      prevChainHash: widenedEnvelope.prevChainHash,
      sig: await signSubmissionV1(pair.privateKey, widenedEnvelope),
    });
    expect(widened.deltas[0]).toMatchObject({
      origin: 'interest',
      body: { kind: 'snapshot' },
    });
    kernel.commit(widened);
    expect(kernel.digest()).toBe(gameplayDigest);
    expect(kernel.observe('alpha', 'phone').entities.map(({ id }) => id))
      .toEqual(['entity-3', 'entity-4']);

    const command = { amount: 1 };
    const previous = submissionChainHashV1(widenedEnvelope);
    const commandEnvelope = {
      sessionId: options.sessionId,
      seat: 'alpha',
      submissionId: 'command-1',
      cursor: 0,
      tick: 0,
      clientTime: 3,
      command,
      prevChainHash: previous,
    };
    const ingest = kernel.prepareIngest({
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: options.sessionId,
      tickId: makeTickId(options.sessionId, 0),
      revision: 0,
      participantId: 'alpha',
      submissionId: 'command-1',
      command,
      clientTime: 3,
      prevChainHash: previous,
      sig: await signSubmissionV1(pair.privateKey, commandEnvelope),
    });
    kernel.commit(ingest);
    expect(kernel.awaitingSeats()).toEqual([]);
    const duplicate = kernel.prepareIngest({
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: options.sessionId,
      tickId: makeTickId(options.sessionId, 0),
      revision: 0,
      participantId: 'alpha',
      submissionId: 'command-1',
      command,
      clientTime: 3,
      prevChainHash: previous,
      sig: await signSubmissionV1(pair.privateKey, commandEnvelope),
    });
    expect(duplicate.result).toMatchObject({ status: 'duplicate', resolved: false });
    kernel.abort(duplicate);

    const advance = kernel.prepareAdvance();
    const phoneDelta = advance.deltas.find((delta) => delta.scopeId === 'phone')!;
    expect(phoneDelta.codec).toBe('v2');
    expect(phoneDelta.body.kind).toBe('patch');
    expect(canonicalJson(phoneDelta.body as unknown as JsonValue).length)
      .toBeLessThan(canonicalJson({
        kind: 'snapshot',
        view: applyObservationDelta(kernel.observe('alpha', 'phone'), phoneDelta),
      } as unknown as JsonValue).length);
    expect(applyObservationDelta(kernel.observe('alpha', 'phone'), phoneDelta))
      .toMatchObject({
        status: 'won',
        entities: [
          { id: 'entity-3', value: 3 },
          { id: 'entity-4', value: 4 },
        ],
      });
    kernel.commit(advance);
    const resolvedDuplicate = kernel.prepareIngest({
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: options.sessionId,
      tickId: makeTickId(options.sessionId, 0),
      revision: 0,
      participantId: 'alpha',
      submissionId: 'command-1',
      command,
      clientTime: 3,
      prevChainHash: previous,
      sig: await signSubmissionV1(pair.privateKey, commandEnvelope),
    });
    expect(resolvedDuplicate.result).toMatchObject({
      status: 'duplicate',
      resolved: true,
    });
    kernel.abort(resolvedDuplicate);
    const replay = finalizeReplay(kernel.liveTranscript(), { perm: [0] });
    expect(replay.records?.filter((record) => record.kind === 'interest')).toHaveLength(2);
    expect(replay.records?.find((record) => record.kind === 'resolution'))
      .toMatchObject({ inputs: [{ payload: command }] });
    expect(recheckReplaySignatures(replay).state).toBe('signed');

    const restored = rehydrateKernel(options, kernel.liveTranscript().events);
    expect(restored.sessionHeader()).toEqual(sessionHeaderFor(options));
    expect(restored.observe('alpha', 'phone')).toEqual(kernel.observe('alpha', 'phone'));
  });

  it('rejects illegal commands before persistence and classifies invalid views', async () => {
    const { options } = await signedOptions();
    const kernel = createSessionKernel(options);
    expect(() => kernel.prepareIngest({
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: options.sessionId,
      tickId: makeTickId(options.sessionId, 0),
      revision: 0,
      participantId: 'alpha',
      submissionId: 'illegal',
      command: { amount: 2 },
    })).toThrowError(IntentCollectionError);
    expect(kernel.liveTranscript().events).toEqual([]);

    expect(() => createSessionKernel({
      ...options,
      reducer: {
        ...reducer,
        view: () => ({
          actions: [],
          status: 'playing',
          hud: { actionsUsed: 0 },
          entities: [],
          catalog: {},
          bad: '\ud800',
        } as View),
        viewFor: undefined,
      },
    })).toThrow(/canonically encodable/);

    const dynamicReducer: TickReducer<Level, State, View> = {
      ...reducer,
      view: (state) => state.total === 0
        ? reducer.view(state)
        : {
          ...reducer.view(state),
          bad: '\ud800',
        } as View,
      viewFor: undefined,
    };
    const dynamic = createSessionKernel({
      ...options,
      reducer: dynamicReducer,
      interest: undefined,
      seatKeys: undefined,
      signaturePolicy: undefined,
    });
    const accepted = dynamic.prepareIngest({
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: options.sessionId,
      tickId: makeTickId(options.sessionId, 0),
      revision: 0,
      participantId: 'alpha',
      submissionId: 'dynamic-invalid-view',
      command: { amount: 1 },
    });
    dynamic.commit(accepted);
    expect(() => dynamic.prepareAdvance()).toThrowError(
      expect.objectContaining({ code: 'invalid_view' }),
    );
    expect(new SessionAdvanceError('invalid_view', 'x').code).toBe('invalid_view');
  });

  it('supports play-all-levels while preserving ladder defaults', async () => {
    const { options } = await signedOptions();
    const failedReducer: TickReducer<Level, State, View> = {
      ...reducer,
      view: (state) => ({ ...reducer.view(state), status: state.total ? 'failed' : 'playing' }),
      viewFor: undefined,
    };
    const transcripts: SessionTranscript<Level>[] = [];
    for (let index = 0; index < 2; index++) {
      const levelOptions: SessionKernelOptions<Level, State, Command, View> = {
        ...options,
        reducer: failedReducer,
        interest: undefined,
        seatKeys: undefined,
        signaturePolicy: undefined,
        seed: (index + 1) * 100,
        levelId: `level-${index}`,
      };
      const kernel = createSessionKernel(levelOptions);
      const prepared = kernel.prepareIngest({
        protocol: PROTOCOL_ID,
        protocolVersion: PROTOCOL_VERSION,
        sessionId: options.sessionId,
        tickId: makeTickId(options.sessionId, 0),
        revision: 0,
        participantId: 'alpha',
        submissionId: `loss-${index}`,
        command: { amount: 1 },
      });
      kernel.commit(prepared);
      const advance = kernel.prepareAdvance();
      kernel.commit(advance);
      transcripts.push(kernel.liveTranscript() as SessionTranscript<Level>);
    }
    // Seeds above are not derived; this assertion isolates the policy field by
    // using the exact derivation expected by the run composer.
    transcripts.forEach((transcript, index) => {
      (transcript.header as { seed: number }).seed = runLevelSeed(0, index);
    });
    expect(() => finalizeRunReplay(transcripts, {
      seed: 0,
      perm: [0],
    })).toThrow(/must be won/);
    expect(finalizeRunReplay(transcripts, {
      seed: 0,
      perm: [0],
      advancePolicy: 'play-all-levels',
    }).header.levels).toHaveLength(2);
  });
});
