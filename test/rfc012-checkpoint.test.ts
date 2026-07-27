import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  makeTickId,
  type CommandSubmission,
  type JsonValue,
} from '../src/protocol.js';
import {
  SessionConflictError,
  createSessionKernel,
  createTickRate,
  finalizeReplay,
  rehydrateKernelFromCheckpoint,
  type KernelCheckpoint,
  type SessionHistoryLookup,
  type SessionKernelOptions,
  type SessionTranscript,
} from '../src/session.js';
import type {
  SessionView,
  TickReducer,
} from '../src/engine/index.js';
import {
  SUBMISSION_SIGNATURE_ALGORITHM,
  exportSubmissionPublicKey,
  generateSubmissionKeyPair,
  signSubmissionV1,
  submissionGenesisHashV1,
  submissionRosterHashV1,
} from '../src/engine/index.js';

interface State {
  total: number;
  actionsUsed: number;
}

interface Command {
  [key: string]: JsonValue;
  amount: number;
}

const reducer: TickReducer<null, State, SessionView> = {
  init: () => ({ total: 0, actionsUsed: 0 }),
  advance: (state, inputs) => ({
    total: state.total + inputs.reduce(
      (sum, input) => sum + ((input.payload as { amount: number }).amount),
      0,
    ),
    actionsUsed: state.actionsUsed + inputs.length,
  }),
  view: (state) => ({
    status: state.total >= 3 ? 'ended' : 'playing',
  }),
  replayMetrics: (state) => ({ actionsUsed: state.actionsUsed }),
};

function historyStore(): SessionHistoryLookup & {
  record(checkpoint: KernelCheckpoint): void;
} {
  const gameplay = new Set<string>();
  const interests = new Map<string, string>();
  const salts = new Map<string, string>();
  const key = (seat: string, submissionId: string) => `${seat}\u0000${submissionId}`;
  return {
    gameplaySubmission: (seat, submissionId) => gameplay.has(key(seat, submissionId)),
    interestCommand: (seat, submissionId) => interests.get(key(seat, submissionId)),
    saltIdentity: (salt) => salts.get(salt),
    record: (checkpoint) => {
      for (const identity of checkpoint.protocol.historicalSubmissionKeys) {
        gameplay.add(identity);
      }
      for (const [identity, command] of checkpoint.protocol.historicalInterestCommands) {
        interests.set(identity, command);
      }
      for (const [salt, identity] of checkpoint.protocol.seenSalts) {
        salts.set(salt, identity);
      }
    },
  };
}

function options(
  historyLookup?: SessionHistoryLookup,
): SessionKernelOptions<null, State, Command, SessionView> {
  return {
    sessionId: 'rfc012-checkpoint',
    game: {
      id: 'tests/rfc012-checkpoint',
      version: '1',
      adapter: { id: 'tests/rfc012-checkpoint/reducer', version: '1' },
    },
    levelId: 'room',
    reducer,
    level: null,
    seed: 7,
    seedPolicy: 'explicit',
    seats: ['solo'],
    cadence: { mode: 'turns' },
    hostTime: 'none',
    commandToAction: (command, context) => ({
      id: 'Action 1',
      seat: context.participantId,
      payload: structuredClone(command),
    }),
    limits: { checkpointInterval: 1 },
    ...(historyLookup === undefined ? {} : { historyLookup }),
  };
}

function submission(
  cursor: number,
  submissionId: string,
  amount: number,
): CommandSubmission<Command> {
  return {
    protocol: PROTOCOL_ID,
    protocolVersion: PROTOCOL_VERSION,
    sessionId: 'rfc012-checkpoint',
    tickId: makeTickId('rfc012-checkpoint', cursor),
    revision: cursor,
    participantId: 'solo',
    submissionId,
    command: { amount },
  };
}

describe('RFC-012 checkpoint and compaction', () => {
  it('uses a versioned product codec for non-JSON reducer state', () => {
    interface SetState {
      values: Set<number>;
    }
    const setReducer: TickReducer<null, SetState, SessionView> = {
      init: () => ({ values: new Set() }),
      advance: (state, inputs) => ({
        values: new Set([
          ...state.values,
          ...inputs.map((input) => (input.payload as { amount: number }).amount),
        ]),
      }),
      view: (state) => ({
        status: 'playing',
        stars: state.values.size,
      }),
      replayMetrics: (state) => ({ actionsUsed: state.values.size }),
    };
    const {
      reducer: _reducer,
      checkpointCodec: _checkpointCodec,
      stateIsolation: _stateIsolation,
      ...baseOptions
    } = options();
    const setOptions: SessionKernelOptions<null, SetState, Command, SessionView> = {
      ...baseOptions,
      reducer: setReducer,
      checkpointCodec: {
        id: 'tests.set-state',
        version: '1',
        encode: (state) => [...state.values],
        decode: (value) => ({
          values: new Set(value as number[]),
        }),
      },
    };
    const kernel = createSessionKernel(setOptions);
    kernel.commit(kernel.prepareIngest(submission(0, 'set-one', 7)));
    kernel.commit(kernel.prepareAdvance());

    const checkpoint = kernel.checkpoint();
    expect(checkpoint.codec).toEqual({ id: 'tests.set-state', version: '1' });
    const restored = rehydrateKernelFromCheckpoint(setOptions, checkpoint, []);
    expect(restored.observe('solo')).toEqual({
      status: 'playing',
      stars: 1,
    });
  });

  it('restores pending protocol state and preserves exact receipt behavior', () => {
    const kernel = createSessionKernel(options());
    kernel.commit(kernel.prepareIngest(submission(0, 'first', 1)));
    const checkpoint = kernel.checkpoint();

    const restored = rehydrateKernelFromCheckpoint(options(), checkpoint, []);
    const retry = restored.prepareIngest(submission(0, 'first', 1));
    expect(retry.result.status).toBe('duplicate');
    restored.abort(retry);
    expect(restored.awaitingSeats()).toEqual([]);
    expect(restored.cursor()).toBe(0);
    expect(restored.tick()).toBe(0);

    kernel.commit(kernel.prepareAdvance());
    restored.commit(restored.prepareAdvance());
    expect(restored.digest()).toBe(kernel.digest());
    expect(restored.observe('solo')).toEqual(kernel.observe('solo'));
  });

  it('restores signed interest scopes and their permanent identities', async () => {
    const pair = await generateSubmissionKeyPair();
    const seatKeys = [{
      id: 'solo',
      publicKey: await exportSubmissionPublicKey(pair.publicKey),
      alg: SUBMISSION_SIGNATURE_ALGORITHM,
      signingTier: { N: 10 },
    }];
    const configured = {
      ...options(),
      seatKeys,
      signaturePolicy: { scheme: 'gaos.submission.ed25519.v1' as const },
      interest: {
        narrowView: (view: SessionView) => view,
      },
    };
    const command = {
      kind: 'interest',
      scopeId: 'phone',
      declaration: { detail: 'compact' },
    } as const;
    const envelope = {
      sessionId: configured.sessionId,
      seat: 'solo',
      submissionId: 'interest-one',
      cursor: 0,
      tick: 0,
      clientTime: 1,
      command,
      prevChainHash: submissionGenesisHashV1(
        configured.sessionId,
        'solo',
        submissionRosterHashV1(seatKeys),
      ),
    };
    const interest = {
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: configured.sessionId,
      tickId: makeTickId(configured.sessionId, 0),
      revision: 0,
      participantId: 'solo',
      submissionId: 'interest-one',
      scopeId: 'phone',
      declaration: command.declaration,
      clientTime: envelope.clientTime,
      prevChainHash: envelope.prevChainHash,
      sig: await signSubmissionV1(pair.privateKey, envelope),
    } as const;
    const kernel = createSessionKernel(configured);
    kernel.commit(kernel.prepareInterest(interest));

    const restored = rehydrateKernelFromCheckpoint(
      configured,
      kernel.checkpoint(),
      [],
    );
    expect(restored.observe('solo', 'phone')).toEqual(kernel.observe('solo', 'phone'));
    const retry = restored.prepareInterest(interest);
    expect(retry.result.status).toBe('duplicate');
    restored.abort(retry);
  });

  it('requires durable confirmation, compacts to a retention floor, and restores a tail', () => {
    const history = historyStore();
    const kernel = createSessionKernel(options(history));
    kernel.commit(kernel.prepareIngest(submission(0, 'first', 1)));
    kernel.commit(kernel.prepareAdvance());
    const durablePrefix = [...kernel.liveTranscript().events];
    const checkpoint = kernel.checkpoint();
    history.record(checkpoint);

    expect(() => kernel.compact(checkpoint, {
      checkpointDigest: checkpoint.integrityDigest,
      checkpointDurablyCommitted: true,
      historyDurablyCommitted: false as true,
    })).toThrow(/durable checkpoint and permanent-history confirmation/);

    kernel.compact(checkpoint, {
      checkpointDigest: checkpoint.integrityDigest,
      checkpointDurablyCommitted: true,
      historyDurablyCommitted: true,
    });
    expect(kernel.liveTranscript().events).toEqual([]);
    expect(kernel.retentionFloor()).toBe(checkpoint.watermark.transitionRevision);
    expect(kernel.snapshot('solo', 0)).toEqual({
      status: 'resync_required',
      requestedTransitionRevision: 0,
      retentionFloor: checkpoint.watermark.transitionRevision,
      currentTransitionRevision: checkpoint.watermark.transitionRevision,
    });
    expect(() => kernel.prepareIngest(submission(1, 'first', 2)))
      .toThrowError(SessionConflictError);

    kernel.commit(kernel.prepareIngest(submission(1, 'second', 2)));
    kernel.commit(kernel.prepareAdvance());
    const tail = [...kernel.liveTranscript().events];
    const restored = rehydrateKernelFromCheckpoint(options(history), checkpoint, tail);
    expect(restored.digest()).toBe(kernel.digest());
    expect(restored.observe('solo')).toEqual({ status: 'ended' });

    const durableTranscript: SessionTranscript<null> = {
      header: checkpoint.header,
      events: [...durablePrefix, ...tail],
    };
    expect(finalizeReplay(durableTranscript, { perm: [0] })
      .header.levels[0]!.result).toEqual({
        status: 'ended',
        stars: null,
        actionsUsed: 2,
      });

    const corruptCheckpoint = structuredClone(checkpoint);
    corruptCheckpoint.watermark.tick++;
    expect(() => rehydrateKernelFromCheckpoint(
      options(history),
      corruptCheckpoint,
      [],
    )).toThrow(/integrity digest mismatch/);

    const corruptTail = structuredClone(tail);
    const finalAudit = [...corruptTail].reverse()
      .find((event) => event.kind === 'checkpoint');
    if (finalAudit?.kind === 'checkpoint') finalAudit.digest ^= 1;
    expect(() => rehydrateKernelFromCheckpoint(
      options(history),
      checkpoint,
      corruptTail,
    )).toThrow(/checkpoint digest does not match/);

    const nonContiguous = structuredClone(tail);
    nonContiguous[0]!.transitionRevision += 2;
    expect(() => rehydrateKernelFromCheckpoint(
      options(history),
      checkpoint,
      nonContiguous,
    )).toThrow(/not contiguous/);
  });

  it('keeps retained state bounded through a simulated two-hour 20 Hz session', () => {
    interface TickState {
      ticks: number;
    }
    const tickReducer: TickReducer<null, TickState, SessionView> = {
      init: () => ({ ticks: 0 }),
      advance: (state) => ({ ticks: state.ticks + 1 }),
      view: () => ({ status: 'playing' }),
      replayMetrics: () => ({ actionsUsed: 0 }),
    };
    const history = historyStore();
    const {
      reducer: _reducer,
      stateIsolation: _stateIsolation,
      checkpointCodec: _checkpointCodec,
      ...baseOptions
    } = options(history);
    const kernel = createSessionKernel({
      ...baseOptions,
      reducer: tickReducer,
      cadence: { mode: 'ticks', rate: createTickRate(20) },
      limits: {
        maxFutureTicks: 144_000,
        maxCatchUpTicks: 600,
        checkpointInterval: 600,
      },
    });

    const resolvedTicks = 2 * 60 * 60 * 20;
    for (let target = 599; target < resolvedTicks; target += 600) {
      const advance = kernel.prepareAdvance(target);
      expect(advance.result.resolutions).toBe(600);
      kernel.commit(advance);
      expect(kernel.liveTranscript().events.length).toBeLessThanOrEqual(601);
      const checkpoint = kernel.checkpoint();
      history.record(checkpoint);
      kernel.compact(checkpoint, {
        checkpointDigest: checkpoint.integrityDigest,
        checkpointDurablyCommitted: true,
        historyDurablyCommitted: true,
      });
      expect(kernel.liveTranscript().events).toHaveLength(0);
    }
    expect(kernel.tick()).toBe(resolvedTicks);
    expect(kernel.retentionFloor()).toBeGreaterThan(0);
  }, 20_000);
});
