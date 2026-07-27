import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  makeTickId,
  type CommandSubmission,
  type JsonValue,
} from '../src/protocol.js';
import {
  COMMITMENT_SCHEME,
  createCommitmentHash,
  createTickRate,
  parseReplayJsonl,
  recheckReplayArtifact,
  runLevelSeed,
  serializeReplayJsonl,
  type ReplayGameRef,
  type SessionView,
  type TickReducer,
  type TickView,
} from '../src/engine/index.js';
import {
  IntentCollectionError,
  PreparedTransitionError,
  SessionAdvanceError,
  SessionConflictError,
  applyObservationDelta,
  createSessionKernel,
  finalizeReplay,
  finalizeRunReplay,
  rehydrateKernel,
  rehydrateKernelFromCheckpoint,
  type ObservationDelta,
  type SessionEvent,
  type SessionKernelOptions,
} from '../src/session.js';

function withoutHostTimes(events: readonly SessionEvent[]): unknown[] {
  return events.map(({ hostTime: _hostTime, ...event }) => event);
}

interface Level {
  goal: number;
}

interface State {
  total: number;
  actionsUsed: number;
}

type Command = { amount: number };

const reducer: TickReducer<Level, State> = {
  init: () => ({ total: 0, actionsUsed: 0 }),
  // Deliberately mutating: the kernel must run it only against an isolated draft.
  advance: (state, inputs) => {
    for (const input of inputs) {
      state.total += input.index ?? 0;
      state.actionsUsed++;
    }
    return state;
  },
  view: (state): TickView => ({
    actions: [{ id: 'Action 1', params: 'index' }],
    status: state.total >= 3 ? 'won' : 'playing',
    ...(state.total >= 3 ? { stars: 3 } : {}),
    participation: { mode: 'simultaneous', seats: ['blue', 'red'] },
    hud: { actionsUsed: state.actionsUsed },
  }),
};

const game: ReplayGameRef = {
  id: 'tests/session',
  version: '1',
  adapter: { id: 'tests/session/reducer', version: '1' },
};

function options(
  cleanup?: { discarded: State[]; retired: State[] },
): SessionKernelOptions<Level, State, Command, TickView> {
  return {
    sessionId: 'session-kernel-test',
    game,
    levelId: 'only',
    reducer,
    level: { goal: 3 },
    seed: 42,
    seedPolicy: 'explicit',
    seats: ['red', 'blue'],
    cadence: { mode: 'turns' },
    hostTime: 'none',
    commandToAction: (command, context) => ({
      id: 'Action 1',
      index: command.amount,
      seat: context.participantId,
    }),
    ...(cleanup
      ? {
        stateIsolation: {
          fork: (state: State) => structuredClone(state),
          discard: (state: State) => cleanup.discarded.push(state),
          retire: (state: State) => cleanup.retired.push(state),
        },
      }
      : {}),
  };
}

function submission(
  participantId: string,
  submissionId: string,
  amount: number,
): CommandSubmission<Command> {
  return {
    protocol: PROTOCOL_ID,
    protocolVersion: PROTOCOL_VERSION,
    sessionId: 'session-kernel-test',
    tickId: makeTickId('session-kernel-test', 0),
    revision: 0,
    participantId,
    submissionId,
    command: { amount },
  };
}

describe('./session kernel', () => {
  it('persists accepted intents before atomic resolution and keeps prepare observable-pure', () => {
    const cleanup = { discarded: [] as State[], retired: [] as State[] };
    const kernel = createSessionKernel(options(cleanup));
    const red = kernel.prepareIngest(submission('red', 'red-1', 1));
    expect(kernel.liveTranscript().events).toHaveLength(0);
    kernel.commit(red);
    expect(kernel.liveTranscript().events.map(({ kind }) => kind)).toEqual(['intent-accepted']);

    const blue = kernel.prepareIngest(submission('blue', 'blue-1', 2));
    kernel.commit(blue);
    const before = kernel.digest();
    const advance = kernel.prepareAdvance();
    expect(kernel.digest()).toBe(before);
    expect(kernel.cursor()).toBe(0);
    expect(advance.events).toHaveLength(2);
    expect(advance.events[0]).toMatchObject({ kind: 'resolution', inputs: { length: 2 } });
    const consumed = advance.events[0]?.kind === 'resolution'
      ? advance.events[0].consumed
      : [];
    expect(advance.deltas.every(
      (delta) => JSON.stringify(delta.acknowledgements) === JSON.stringify(consumed),
    )).toBe(true);
    expect(advance.deltas.every((delta) => (
      delta.transitionRevision === advance.nextTransitionRevision
      && delta.rejections.length === 0
    ))).toBe(true);
    kernel.abort(advance);
    expect(kernel.cursor()).toBe(0);
    expect(kernel.digest()).toBe(before);

    const committed = kernel.prepareAdvance();
    kernel.commit(committed);
    expect(kernel.cursor()).toBe(1);
    expect(kernel.observe('red').status).toBe('won');
    expect(kernel.viewRevision('red')).toBe(1);
    expect(cleanup.discarded.length).toBeGreaterThanOrEqual(2); // constructor probe + abort
    expect(cleanup.retired).toHaveLength(3);
  });

  it('requires an explicit host clock policy and never supplies a wall clock', () => {
    const deterministic = createSessionKernel(options());
    const withoutTime = deterministic.prepareIngest(submission('red', 'red-none', 1));
    expect(Object.hasOwn(withoutTime.events[0]!, 'hostTime')).toBe(false);

    const fixed = createSessionKernel({
      ...options(),
      hostTime: () => 1_785_032_663_000,
    });
    const withTime = fixed.prepareIngest(submission('red', 'red-fixed', 1));
    expect(withTime.events[0]?.hostTime).toBe(1_785_032_663_000);

    const unavailable = createSessionKernel({
      ...options(),
      hostTime: (() => undefined) as unknown as () => number,
    });
    expect(() => unavailable.prepareIngest(submission('red', 'red-bad-clock', 1)))
      .toThrow(/UTC epoch milliseconds/);
  });

  it('makes exact retries idempotent and stale competing prepares self-cleaning', () => {
    const kernel = createSessionKernel(options());
    const first = kernel.prepareIngest(submission('red', 'red-1', 1));
    kernel.commit(first);
    const retry = kernel.prepareIngest(submission('red', 'red-1', 1));
    expect(retry.events).toHaveLength(0);
    expect(retry.result.status).toBe('duplicate');
    kernel.commit(retry);

    const left = kernel.prepareExtension('audit', { value: 1 });
    const right = kernel.prepareExtension('audit', { value: 2 });
    kernel.commit(left);
    expect(() => kernel.commit(right)).toThrowError(PreparedTransitionError);
    expect(() => kernel.abort(right)).not.toThrow();
    expect(() => kernel.abort(right)).not.toThrow();
  });

  it('validates the immutable envelope and full cursor before honoring a duplicate', () => {
    const kernel = createSessionKernel(options());
    kernel.commit(kernel.prepareIngest(submission('red', 'red-1', 1)));
    expect(() => kernel.prepareIngest({
      ...submission('red', 'red-1', 1),
      protocol: 'foreign' as typeof PROTOCOL_ID,
    })).toThrow(/expected agilabs\.ticks/);
    expect(() => kernel.prepareIngest({
      ...submission('red', 'red-1', 1),
      sessionId: 'another-session',
    })).toThrow(/does not match endpoint/);
    expect(() => kernel.prepareIngest({
      ...submission('red', 'red-1', 1),
      revision: 999,
    })).toThrowError(SessionConflictError);
  });

  it('freezes cyclic adapter output without recursion or aliasing', () => {
    const cyclicOptions = {
      ...options(),
      seats: ['red'],
      reducer: {
        ...reducer,
        view: (state: State): TickView => ({
          ...reducer.view(state),
          participation: { mode: 'sequential', activeSeat: 'red' },
        }),
      },
      commandToAction: () => {
        const action: Record<string, unknown> = { id: 'Action 1' };
        action['loop'] = action;
        return action as never;
      },
    };
    const kernel = createSessionKernel(cyclicOptions);
    const accepted = kernel.prepareIngest(submission('red', 'cyclic', 1));
    kernel.commit(accepted);
    const advance = kernel.prepareAdvance();
    const event = advance.events[0] as unknown as {
      inputs: Array<{ action: Record<string, unknown> }>;
    };
    const action = event.inputs[0]!.action;
    expect(action['loop']).toBe(action);
    expect(Object.isFrozen(action)).toBe(true);
    kernel.abort(advance);
  });

  it('rehydrates pending intents and finalizes an atomically recheckable v1.3 replay', () => {
    const original = createSessionKernel(options());
    const red = original.prepareIngest(submission('red', 'red-1', 1));
    original.commit(red);
    const recovered = rehydrateKernel(options(), original.liveTranscript());
    const retry = recovered.prepareIngest(submission('red', 'red-1', 1));
    expect(retry.result.status).toBe('duplicate');
    recovered.commit(retry);

    const blue = recovered.prepareIngest(submission('blue', 'blue-1', 2));
    recovered.commit(blue);
    const advance = recovered.prepareAdvance();
    recovered.commit(advance);

    const artifact = finalizeReplay(recovered.liveTranscript(), { perm: [1, 0] });
    expect(artifact.header.formatVersion).toBe('1.3');
    expect(artifact.actions.every((action) => (
      action.wireId === 'Action 2' && action.canonicalId === 'Action 1'
    ))).toBe(true);
    expect(artifact.records).toHaveLength(2);
    expect(artifact.records?.[0]).toMatchObject({
      kind: 'resolution',
      inputs: { length: 2 },
    });
    const serialized = serializeReplayJsonl(artifact);
    const parsed = parseReplayJsonl<Level>(serialized);
    expect(parsed.records).toEqual(artifact.records);
    expect(serializeReplayJsonl(parsed)).toBe(serialized);
    expect(recheckReplayArtifact(parsed, () => reducer)).toMatchObject({
      ok: true,
      problems: [],
    });
  });

  it('finalizes a reducer-replayable ended session without inventing an outcome', () => {
    const endedReducer: TickReducer<null, { ended: boolean }, SessionView> = {
      init: () => ({ ended: false }),
      advance: () => ({ ended: true }),
      view: (state) => ({ status: state.ended ? 'ended' : 'playing' }),
      replayMetrics: (state) => ({ actionsUsed: state.ended ? 1 : 0 }),
    };
    const kernel = createSessionKernel({
      sessionId: 'ended-session',
      game: {
        id: 'tests/ended-session',
        version: '1',
        adapter: { id: 'tests/ended-session/reducer', version: '1' },
      },
      levelId: 'room',
      reducer: endedReducer,
      level: null,
      seed: 1,
      seedPolicy: 'explicit',
      seats: ['host'],
      cadence: { mode: 'turns' },
      hostTime: 'none',
      commandToAction: () => ({ id: 'Action 1', seat: 'host' }),
    });
    kernel.commit(kernel.prepareIngest({
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: 'ended-session',
      tickId: makeTickId('ended-session', 0),
      revision: 0,
      participantId: 'host',
      submissionId: 'end',
      command: { amount: 0 },
    }));
    kernel.commit(kernel.prepareAdvance());

    const artifact = finalizeReplay(kernel.liveTranscript(), { perm: [0] });
    expect(artifact.header.formatVersion).toBe('1.3');
    expect(artifact.header.levels[0]!.result).toEqual({
      status: 'ended',
      stars: null,
      actionsUsed: 1,
    });
    expect(artifact.header.totals.totalStars).toBe(0);
  });

  it('rejects an ended reducer view that reports stars', () => {
    const invalidReducer: TickReducer<null, null, SessionView> = {
      init: () => null,
      advance: () => null,
      view: () => ({ status: 'ended', stars: 1 }),
      replayMetrics: () => ({ actionsUsed: 0 }),
    };
    expect(() => createSessionKernel({
      sessionId: 'invalid-ended-session',
      game,
      levelId: 'room',
      reducer: invalidReducer,
      level: null,
      seed: 1,
      seedPolicy: 'explicit',
      seats: ['host'],
      cadence: { mode: 'turns' },
      hostTime: 'none',
      commandToAction: () => ({ id: 'Action 1', seat: 'host' }),
    })).toThrow(/ended session view must not report stars/);
  });

  it('rehydrates exact pending receipts after either seat acceptance', () => {
    for (const seat of ['red', 'blue'] as const) {
      const original = createSessionKernel(options());
      const accepted = original.prepareIngest(submission(seat, `${seat}-1`, 1));
      original.commit(accepted);
      const recovered = rehydrateKernel(options(), original.liveTranscript());
      const retry = recovered.prepareIngest(submission(seat, `${seat}-1`, 1));
      expect(retry.result).toEqual({ ...accepted.result, status: 'duplicate' });
      recovered.commit(retry);
    }
  });

  it('rejects non-JSON commands through the protocol boundary', () => {
    const kernel = createSessionKernel(options());
    const invalid = submission('red', 'bad', 1) as CommandSubmission<Command & JsonValue>;
    (invalid.command as { amount: number }).amount = Number.NaN;
    expect(() => kernel.prepareIngest(invalid)).toThrowError(
      expect.objectContaining<Partial<IntentCollectionError>>({
        code: 'invalid_submission',
      }),
    );
    expect(() => kernel.prepareIngest(null as never)).toThrowError(
      expect.objectContaining<Partial<IntentCollectionError>>({
        code: 'invalid_submission',
      }),
    );
  });

  it('rejects malformed public API shapes before they can enter durable state', () => {
    const kernel = createSessionKernel(options());
    for (const invalidOptions of [null, [], 'x']) {
      expect(() => createSessionKernel(invalidOptions as never))
        .toThrow(/session kernel options must be an object/);
    }
    expect(() => kernel.prepareTimeout(null as never, { id: 'Action 1' }))
      .toThrow(/timeout must be an object/);
    expect(() => kernel.prepareTimeout(
      { timeoutId: 'bad-input', reason: 'elapsed', tick: 0 },
      null as never,
    )).toThrow(/forcedInput must be an object/);
    expect(() => kernel.prepareExtension('bad-record', [] as never))
      .toThrow(/JSON object/);
    expect(() => rehydrateKernel(options(), null as never))
      .toThrow(/transcript must be an object/);
    expect(() => rehydrateKernel(options(), undefined as never))
      .toThrow(/transcript must be an object/);
    expect(() => rehydrateKernel(null as never, kernel.liveTranscript()))
      .toThrow(/session kernel options must be an object/);
    expect(() => finalizeReplay(null as never, { perm: [0] }))
      .toThrow(/transcript must be an object/);
    expect(() => finalizeRunReplay(null as never, { seed: 1, perm: [0] }))
      .toThrow(/transcripts must be an array/);
    for (const invalidTranscript of [null, 'x', []]) {
      expect(() => finalizeRunReplay(
        [invalidTranscript] as never,
        { seed: 1, perm: [0] },
      )).toThrow(/run transcript 0 must be an object/);
    }
  });

  it('verifies commit–reveal before reducer execution and through replay', () => {
    type SecretCommand =
      | { kind: 'commit'; hash: string }
      | { kind: 'reveal'; salt: string; payload: JsonValue };
    interface SecretState { phase: number; actionsUsed: number }
    const secretReducer: TickReducer<{}, SecretState> = {
      init: () => ({ phase: 0, actionsUsed: 0 }),
      advance: (state, inputs) => ({
        phase: inputs[0]?.verifiedPayload === undefined ? 1 : 2,
        actionsUsed: state.actionsUsed + inputs.length,
      }),
      view: (state): TickView => ({
        actions: [{ id: 'Action 1', params: 'none' }],
        status: state.phase === 2 ? 'won' : 'playing',
        ...(state.phase === 2 ? { stars: 3 } : {}),
        participation: { mode: 'sequential', activeSeat: 'red' },
        hud: { actionsUsed: state.actionsUsed },
      }),
    };
    const salt = '00112233445566778899aabbccddeeff';
    const payload = { order: 'north' };
    const binding = {
      sessionId: 'commit-session',
      seat: 'red',
      commitmentId: 0,
      windowRef: 0,
    };
    const secretOptions: SessionKernelOptions<{}, SecretState, SecretCommand, TickView> = {
      sessionId: binding.sessionId,
      game,
      levelId: 'secret',
      reducer: secretReducer,
      level: {},
      seed: 9,
      seedPolicy: 'explicit',
      seats: ['red'],
      cadence: { mode: 'turns' },
      hostTime: 'none',
      commandToAction: (command) => command.kind === 'commit'
        ? {
          id: 'Action 1',
          commit: {
            commitmentId: 0,
            scheme: COMMITMENT_SCHEME,
            hash: command.hash,
          },
        }
        : {
          id: 'Action 1',
          reveal: {
            commitmentId: 0,
            salt: command.salt,
            payload: command.payload,
          },
        },
    };
    const kernel = createSessionKernel(secretOptions);
    const submit = (revision: number, submissionId: string, command: SecretCommand) => ({
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: binding.sessionId,
      tickId: makeTickId(binding.sessionId, revision),
      revision,
      participantId: 'red',
      submissionId,
      command,
    } as const);
    const commit = kernel.prepareIngest(submit(
      0,
      'commit-0',
      { kind: 'commit', hash: createCommitmentHash(binding, salt, payload) },
    ));
    kernel.commit(commit);
    kernel.commit(kernel.prepareAdvance());
    const reveal = kernel.prepareIngest(submit(
      1,
      'reveal-0',
      { kind: 'reveal', salt, payload },
    ));
    kernel.commit(reveal);
    kernel.commit(kernel.prepareAdvance());

    const artifact = finalizeReplay(kernel.liveTranscript(), { perm: [0] });
    expect(recheckReplayArtifact(artifact, () => secretReducer)).toMatchObject({
      ok: true,
      problems: [],
    });
  });

  it('finalizes ordered one-level transcripts as one derived-seed run', () => {
    const runSeed = 12345;
    const sessionId = 'multi-level-run';
    const finishLevel = (levelIndex: number) => {
      const levelOptions = {
        ...options(),
        sessionId,
        levelId: `level-${levelIndex}`,
        level: { goal: 3 },
        seed: runLevelSeed(runSeed, levelIndex),
        seedPolicy: 'explicit' as const,
      };
      const kernel = createSessionKernel(levelOptions);
      const submit = (
        participantId: string,
        submissionId: string,
        amount: number,
      ): CommandSubmission<Command> => ({
        protocol: PROTOCOL_ID,
        protocolVersion: PROTOCOL_VERSION,
        sessionId,
        tickId: makeTickId(sessionId, 0),
        revision: 0,
        participantId,
        submissionId,
        command: { amount },
      });
      kernel.commit(kernel.prepareIngest(submit('red', 'red-1', 1)));
      kernel.commit(kernel.prepareIngest(submit('blue', 'blue-1', 2)));
      kernel.commit(kernel.prepareAdvance());
      return kernel.liveTranscript();
    };
    const transcripts = [finishLevel(0), finishLevel(1)];
    const artifact = finalizeRunReplay(transcripts, { seed: runSeed, perm: [1, 0] });
    expect(artifact.header).toMatchObject({
      sessionId,
      seed: runSeed,
      seedPolicy: 'gaos.run-level-seed.v1',
      totals: { totalStars: 6, totalActionsUsed: 4 },
    });
    expect(artifact.header.levels.map(({ index, id, seed }) => ({ index, id, seed })))
      .toEqual([
        { index: 0, id: 'level-0', seed: runLevelSeed(runSeed, 0) },
        { index: 1, id: 'level-1', seed: runLevelSeed(runSeed, 1) },
      ]);
    expect(artifact.actions.map(({ n, levelIndex }) => ({ n, levelIndex })))
      .toEqual([
        { n: 0, levelIndex: 0 },
        { n: 1, levelIndex: 0 },
        { n: 2, levelIndex: 1 },
        { n: 3, levelIndex: 1 },
      ]);
    expect(artifact.actions.every((action) => (
      action.wireId === 'Action 2' && action.canonicalId === 'Action 1'
    ))).toBe(true);
    expect(artifact.records?.map(({ n, levelIndex }) => ({ n, levelIndex })))
      .toEqual([
        { n: 0, levelIndex: 0 },
        { n: 1, levelIndex: 0 },
        { n: 2, levelIndex: 1 },
        { n: 3, levelIndex: 1 },
      ]);
    expect(recheckReplayArtifact(artifact, () => reducer)).toMatchObject({
      ok: true,
      problems: [],
    });

    const wrongSeed = structuredClone(transcripts[1]!);
    wrongSeed.header.seed++;
    expect(() => finalizeRunReplay(
      [transcripts[0]!, wrongSeed],
      { seed: runSeed, perm: [0] },
    )).toThrow(/runLevelSeed/);

    const derivedPolicy = structuredClone(transcripts[0]!);
    derivedPolicy.header.seedPolicy = 'gaos.run-level-seed.v1';
    expect(() => finalizeRunReplay(
      [derivedPolicy],
      { seed: runSeed, perm: [0] },
    )).toThrow(/must record its derived level seed as explicit/);

    const wrongSession = structuredClone(transcripts[1]!);
    wrongSession.header.sessionId = 'another-run';
    expect(() => finalizeRunReplay(
      [transcripts[0]!, wrongSession],
      { seed: runSeed, perm: [0] },
    )).toThrow(/sessionId/);

    const wrongGame = structuredClone(transcripts[1]!);
    wrongGame.header.game.adapter.version = '2';
    expect(() => finalizeRunReplay(
      [transcripts[0]!, wrongGame],
      { seed: runSeed, perm: [0] },
    )).toThrow(/different game/);

    const wrongDmath = structuredClone(transcripts[1]!);
    wrongDmath.header.dmath = { algorithm: 'dmath-1', backend: 'js' };
    expect(() => finalizeRunReplay(
      [transcripts[0]!, wrongDmath],
      { seed: runSeed, perm: [0] },
    )).toThrow(/dmath/);

    const failedFirst = structuredClone(transcripts[0]!);
    const terminal = [...failedFirst.events].reverse().find(
      (event) => event.kind === 'resolution',
    );
    if (terminal?.kind === 'resolution') terminal.result.status = 'failed';
    expect(() => finalizeRunReplay(
      [failedFirst, transcripts[1]!],
      { seed: runSeed, perm: [0] },
    )).toThrow(/must be won/);
    expect(() => finalizeRunReplay([], { seed: runSeed, perm: [0] }))
      .toThrow(/at least one/);
  });

  it('warns live hosts when a salt is reused across commitments', () => {
    type SecretCommand =
      | { kind: 'commit'; commitmentId: number; hash: string }
      | { kind: 'reveal'; commitmentId: number; salt: string; payload: JsonValue };
    interface SecretState { phase: number; actionsUsed: number }
    const secretReducer: TickReducer<{}, SecretState> = {
      init: () => ({ phase: 0, actionsUsed: 0 }),
      advance: (state, inputs) => ({
        phase: state.phase + 1,
        actionsUsed: state.actionsUsed + inputs.length,
      }),
      view: (state): TickView => ({
        actions: [{ id: 'Action 1', params: 'none' }],
        status: state.phase === 4 ? 'won' : 'playing',
        ...(state.phase === 4 ? { stars: 3 } : {}),
        participation: { mode: 'sequential', activeSeat: 'red' },
        hud: { actionsUsed: state.actionsUsed },
      }),
    };
    const secretOptions: SessionKernelOptions<
      {},
      SecretState,
      SecretCommand,
      TickView
    > = {
      sessionId: 'salt-warning-session',
      game,
      levelId: 'salt-warning',
      reducer: secretReducer,
      level: {},
      seed: 1,
      seedPolicy: 'explicit',
      seats: ['red'],
      cadence: { mode: 'turns' },
      hostTime: 'none',
      commandToAction: (command) => command.kind === 'commit'
        ? {
          id: 'Action 1',
          commit: {
            commitmentId: command.commitmentId,
            scheme: COMMITMENT_SCHEME,
            hash: command.hash,
          },
        }
        : {
          id: 'Action 1',
          reveal: {
            commitmentId: command.commitmentId,
            salt: command.salt,
            payload: command.payload,
          },
        },
    };
    const submit = (
      revision: number,
      submissionId: string,
      command: SecretCommand,
    ): CommandSubmission<SecretCommand> => ({
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: secretOptions.sessionId,
      tickId: makeTickId(secretOptions.sessionId, revision),
      revision,
      participantId: 'red',
      submissionId,
      command,
    });
    const salt = '00112233445566778899aabbccddeeff';
    const payload0 = { order: 'north' };
    const payload1 = { order: 'south' };
    const kernel = createSessionKernel(secretOptions);
    const resolve = (revision: number, submissionId: string, command: SecretCommand) => {
      kernel.commit(kernel.prepareIngest(submit(revision, submissionId, command)));
      const advance = kernel.prepareAdvance();
      kernel.commit(advance);
      return advance;
    };
    resolve(0, 'commit-0', {
      kind: 'commit',
      commitmentId: 0,
      hash: createCommitmentHash({
        sessionId: secretOptions.sessionId,
        seat: 'red',
        commitmentId: 0,
        windowRef: 0,
      }, salt, payload0),
    });
    expect(resolve(1, 'reveal-0', {
      kind: 'reveal',
      commitmentId: 0,
      salt,
      payload: payload0,
    }).result.warnings).toEqual([]);
    resolve(2, 'commit-1', {
      kind: 'commit',
      commitmentId: 1,
      hash: createCommitmentHash({
        sessionId: secretOptions.sessionId,
        seat: 'red',
        commitmentId: 1,
        windowRef: 2,
      }, salt, payload1),
    });

    const recovered = rehydrateKernel(secretOptions, kernel.liveTranscript());
    recovered.commit(recovered.prepareIngest(submit(3, 'reveal-1', {
      kind: 'reveal',
      commitmentId: 1,
      salt,
      payload: payload1,
    })));
    const reused = recovered.prepareAdvance();
    expect(reused.result.warnings).toEqual([expect.objectContaining({
      code: 'salt_reuse',
      participantId: 'red',
      commitmentId: 1,
    })]);
    recovered.commit(reused);
  });

  it('bounds inclusive tick catch-up and records canonical timeout input', () => {
    const tickOptions = {
      ...options(),
      cadence: { mode: 'ticks', rate: createTickRate(30) } as const,
      limits: { maxCatchUpTicks: 2 },
      hostTime: () => 1_785_032_663_000,
    };
    const kernel = createSessionKernel(tickOptions);
    const catchUp = kernel.prepareAdvance(5);
    expect(catchUp.result).toMatchObject({ resolutions: 2, partial: true, tick: 2 });
    expect(catchUp.result.cursor).toBe(catchUp.result.tick);
    kernel.abort(catchUp);
    const timeout = kernel.prepareTimeout(
      {
        timeoutId: 'turn-0',
        reason: 'elapsed',
        tick: 0,
        participantId: 'red',
      },
      { id: 'Action 1', index: 3, seat: 'red' },
    );
    expect(timeout.events.map(({ kind }) => kind))
      .toEqual(['timeout', 'resolution', 'checkpoint']);
    kernel.commit(timeout);
    expect(kernel.cursor()).toBe(kernel.tick());
    expect(kernel.observe('red').status).toBe('won');
    expect(timeout.events.every((event) => Number.isSafeInteger(event.hostTime))).toBe(true);

    const ordinary = finalizeReplay(kernel.liveTranscript(), { perm: [0] });
    expect(ordinary.header.timeoutPolicy).toBeUndefined();
    expect(ordinary.records?.every((record) => record.hostTime === undefined)).toBe(true);
    expect(ordinary.records?.find((record) => record.kind === 'timeout')).toMatchObject({
      kind: 'timeout',
      timeoutId: 'turn-0',
      windowRef: 0,
      participantId: 'red',
      reason: 'elapsed',
    });

    const timed = finalizeReplay(kernel.liveTranscript(), {
      perm: [0],
      includeHostTime: true,
    });
    expect(timed.records?.every((record) => Number.isSafeInteger(record.hostTime))).toBe(true);
  });

  it('recovers persisted catch-up and timeout events before the live commit', () => {
    const tickOptions = {
      ...options(),
      cadence: { mode: 'ticks', rate: createTickRate(30) } as const,
      limits: { maxCatchUpTicks: 2 },
    };
    const liveCatchUp = createSessionKernel(tickOptions);
    const catchUp = liveCatchUp.prepareAdvance(5);
    const catchUpBeforeCommit = liveCatchUp.liveTranscript();
    const recoveredCatchUp = rehydrateKernel(tickOptions, {
      header: catchUpBeforeCommit.header,
      events: [...catchUpBeforeCommit.events, ...catchUp.events],
    });
    liveCatchUp.commit(catchUp);
    expect(recoveredCatchUp.digest()).toBe(liveCatchUp.digest());
    expect(recoveredCatchUp.liveTranscript()).toEqual(liveCatchUp.liveTranscript());
    expect(recoveredCatchUp.cursor()).toBe(recoveredCatchUp.tick());

    const liveTimeout = createSessionKernel(options());
    liveTimeout.commit(liveTimeout.prepareIngest(submission('red', 'red-1', 1)));
    const timeout = liveTimeout.prepareTimeout(
      { timeoutId: 'persisted', reason: 'elapsed', tick: 0, participantId: 'blue' },
      { id: 'Action 1', index: 2, seat: 'blue' },
    );
    const timeoutBeforeCommit = liveTimeout.liveTranscript();
    const recoveredTimeout = rehydrateKernel(options(), {
      header: timeoutBeforeCommit.header,
      events: [...timeoutBeforeCommit.events, ...timeout.events],
    });
    liveTimeout.commit(timeout);
    expect(recoveredTimeout.digest()).toBe(liveTimeout.digest());
    expect(recoveredTimeout.liveTranscript()).toEqual(liveTimeout.liveTranscript());
  });

  it('keeps commitment bookkeeping atomic across mismatch rejection and rehydration', () => {
    type SecretCommand =
      | { kind: 'commit'; commitmentId: number; hash: string }
      | { kind: 'reveal'; commitmentId: number; salt: string; payload: JsonValue };
    interface SecretState { phase: number; actionsUsed: number }
    const secretReducer: TickReducer<{}, SecretState> = {
      init: () => ({ phase: 0, actionsUsed: 0 }),
      advance: (state, inputs) => ({
        phase: state.phase + 1,
        actionsUsed: state.actionsUsed + inputs.length,
      }),
      view: (state): TickView => ({
        actions: [{ id: 'Action 1', params: 'none' }],
        status: state.phase >= 2 ? 'won' : 'playing',
        ...(state.phase >= 2 ? { stars: 3 } : {}),
        participation: state.phase === 0
          ? { mode: 'sequential', activeSeat: 'zulu' }
          : { mode: 'simultaneous', seats: ['alpha', 'zulu'] },
        hud: { actionsUsed: state.actionsUsed },
      }),
    };
    const secretOptions: SessionKernelOptions<
      {},
      SecretState,
      SecretCommand,
      TickView
    > = {
      sessionId: 'atomic-commit-session',
      game,
      levelId: 'atomic',
      reducer: secretReducer,
      level: {},
      seed: 7,
      seedPolicy: 'explicit',
      seats: ['alpha', 'zulu'],
      cadence: { mode: 'turns' },
      hostTime: 'none',
      commandToAction: (command) => command.kind === 'commit'
        ? {
          id: 'Action 1',
          commit: {
            commitmentId: command.commitmentId,
            scheme: COMMITMENT_SCHEME,
            hash: command.hash,
          },
        }
        : {
          id: 'Action 1',
          reveal: {
            commitmentId: command.commitmentId,
            salt: command.salt,
            payload: command.payload,
          },
        },
    };
    const submit = (
      revision: number,
      participantId: string,
      submissionId: string,
      command: SecretCommand,
    ): CommandSubmission<SecretCommand> => ({
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: secretOptions.sessionId,
      tickId: makeTickId(secretOptions.sessionId, revision),
      revision,
      participantId,
      submissionId,
      command,
    });
    const zuluSalt = '00112233445566778899aabbccddeeff';
    const alphaSalt = 'ffeeddccbbaa99887766554433221100';
    const honestPayload = { order: 'north' };
    const zuluHash = createCommitmentHash({
      sessionId: secretOptions.sessionId,
      seat: 'zulu',
      commitmentId: 0,
      windowRef: 0,
    }, zuluSalt, honestPayload);
    const alphaHash = createCommitmentHash({
      sessionId: secretOptions.sessionId,
      seat: 'alpha',
      commitmentId: 0,
      windowRef: 1,
    }, alphaSalt, { order: 'south' });

    const live = createSessionKernel(secretOptions);
    live.commit(live.prepareIngest(submit(
      0,
      'zulu',
      'zulu-commit',
      { kind: 'commit', commitmentId: 0, hash: zuluHash },
    )));
    live.commit(live.prepareAdvance());
    live.commit(live.prepareIngest(submit(
      1,
      'alpha',
      'alpha-commit',
      { kind: 'commit', commitmentId: 0, hash: alphaHash },
    )));
    live.commit(live.prepareIngest(submit(
      1,
      'zulu',
      'zulu-reveal',
      { kind: 'reveal', commitmentId: 0, salt: zuluSalt, payload: { order: 'wrong' } },
    )));

    const timeoutKernel = rehydrateKernel(secretOptions, live.liveTranscript());
    const timeoutRejected = timeoutKernel.prepareTimeout(
      { timeoutId: 'window-timeout-with-rejection', reason: 'elapsed', tick: 1 },
      { id: 'Action 1', index: 2 },
    );
    expect(timeoutRejected.events.map((event) => event.kind)).toEqual([
      'timeout',
      'rejection',
      'checkpoint',
    ]);
    expect(timeoutRejected.events[0]).toMatchObject({
      kind: 'timeout',
      timeoutId: 'window-timeout-with-rejection',
    });
    expect(timeoutRejected.result.resolutions).toBe(0);
    timeoutKernel.commit(timeoutRejected);
    expect(() => rehydrateKernel(secretOptions, timeoutKernel.liveTranscript()))
      .not.toThrow();
    timeoutKernel.commit(timeoutKernel.prepareIngest(submit(
      1,
      'zulu',
      'zulu-reveal-after-timeout',
      { kind: 'reveal', commitmentId: 0, salt: zuluSalt, payload: honestPayload },
    )));
    timeoutKernel.commit(timeoutKernel.prepareAdvance());
    const timeoutArtifact = finalizeReplay(
      timeoutKernel.liveTranscript(),
      { perm: [0] },
    );
    expect(timeoutArtifact.records?.map((record) => record.kind)).toContain('timeout');
    expect(recheckReplayArtifact(timeoutArtifact, () => secretReducer)).toMatchObject({
      ok: true,
      problems: [],
    });

    const rejected = live.prepareAdvance();
    expect(rejected.events.some((event) => event.kind === 'checkpoint')).toBe(true);
    expect(rejected.events.map((event) => event.kind)).toEqual([
      'rejection',
      'checkpoint',
    ]);
    expect(rejected.events[0]).toMatchObject({
      kind: 'rejection',
      participantId: 'zulu',
    });
    expect(rejected.result.rejections).toEqual([
      {
        seat: 'alpha',
        transitionRevision: rejected.nextTransitionRevision,
        tick: 1,
        participantId: 'zulu',
        submissionId: 'zulu-reveal',
        code: 'commit_mismatch',
      },
      {
        seat: 'zulu',
        transitionRevision: rejected.nextTransitionRevision,
        tick: 1,
        participantId: 'zulu',
        submissionId: 'zulu-reveal',
        code: 'commit_mismatch',
      },
    ]);
    expect(rejected.deltas).toHaveLength(2);
    expect(rejected.deltas.every((delta) => (
      delta.transitionRevision === rejected.nextTransitionRevision
      && delta.viewRevision === live.cursor()
      && delta.body.kind === 'unchanged'
      && delta.rejections.length === 1
      && delta.rejections[0]?.submissionId === 'zulu-reveal'
    ))).toBe(true);
    live.commit(rejected);

    const recovered = rehydrateKernel(secretOptions, live.liveTranscript());
    const checkpointRecovered = rehydrateKernelFromCheckpoint(
      secretOptions,
      live.checkpoint(),
      [],
    );
    for (const kernel of [live, recovered, checkpointRecovered]) {
      const before = kernel.snapshot('alpha', rejected.baseTransitionRevision);
      const after = kernel.snapshot('alpha', rejected.nextTransitionRevision);
      expect('status' in before ? before.status : before.rejections)
        .toEqual([rejected.result.rejections[0]]);
      expect('status' in after ? after.status : after.rejections)
        .toEqual([]);
      expect(() => kernel.prepareIngest(submit(
        1,
        'zulu',
        'zulu-reveal',
        { kind: 'reveal', commitmentId: 0, salt: zuluSalt, payload: honestPayload },
      ))).toThrowError(SessionConflictError);
    }
    for (const kernel of [live, recovered]) {
      kernel.commit(kernel.prepareIngest(submit(
        1,
        'zulu',
        'zulu-reveal-second-fumble',
        { kind: 'reveal', commitmentId: 0, salt: zuluSalt, payload: { order: 'wrong' } },
      )));
      const secondFumble = kernel.prepareAdvance();
      expect(secondFumble.events.map((event) => event.kind)).toEqual([
        'rejection',
        'checkpoint',
      ]);
      kernel.commit(secondFumble);
    }
    for (const kernel of [live, recovered]) {
      const retry = kernel.prepareIngest(submit(
        1,
        'zulu',
        'zulu-reveal-corrected',
        { kind: 'reveal', commitmentId: 0, salt: zuluSalt, payload: honestPayload },
      ));
      expect(retry.result.status).toBe('accepted');
      kernel.commit(retry);
      kernel.commit(kernel.prepareAdvance());
    }
    expect(recovered.digest()).toBe(live.digest());
    expect(withoutHostTimes(recovered.liveTranscript().events))
      .toEqual(withoutHostTimes(live.liveTranscript().events));
    expect(live.observe('alpha').status).toBe('won');

    const checked = recheckReplayArtifact(
      finalizeReplay(live.liveTranscript(), { perm: [0] }),
      () => secretReducer,
    );
    expect(checked.ok).toBe(true);
    expect(checked.diagnostics.join('\n')).toMatch(/verified commit_mismatch.*zulu.*0/);
  });

  it('projects the explicit system input and publishes matching checkpoint digests', () => {
    const kernel = createSessionKernel(options());
    kernel.commit(kernel.prepareIngest(submission('red', 'red-1', 1)));
    expect(() => kernel.prepareTimeout(
      { timeoutId: '', reason: 'elapsed', tick: 0, participantId: 'blue' },
      { id: 'Action 1', index: 2, seat: 'blue' },
    )).toThrow(/timeoutId/);
    expect(() => kernel.prepareTimeout(
      { timeoutId: 'wrong-seat', reason: 'elapsed', tick: 0, participantId: 'blue' },
      { id: 'Action 1', index: 2, seat: 'red' },
    )).toThrow(/impersonate/);
    expect(() => kernel.prepareTimeout(
      { timeoutId: 'unknown', reason: 'elapsed', tick: 0, participantId: 'green' },
      { id: 'Action 1', index: 2 },
    )).toThrow(/not eligible/);
    expect(() => kernel.prepareTimeout(
      { timeoutId: 'already-submitted', reason: 'elapsed', tick: 0, participantId: 'red' },
      { id: 'Action 1', index: 2 },
    )).toThrow(/already submitted/);
    expect(() => kernel.prepareTimeout(
      { timeoutId: 'window-seat', reason: 'elapsed', tick: 0 },
      { id: 'Action 1', index: 2, seat: 'blue' },
    )).toThrow(/window timeout.*cannot name/);
    const timeout = kernel.prepareTimeout(
      { timeoutId: 'mixed', reason: 'elapsed', tick: 0, participantId: 'blue' },
      { id: 'Action 1', index: 2, seat: 'blue' },
    );
    const resolution = timeout.events.find((event) => event.kind === 'resolution');
    const checkpoint = timeout.events.find((event) => event.kind === 'checkpoint');
    expect(resolution).toMatchObject({
      kind: 'resolution',
      inputs: { length: 2 },
      systemInput: {
        participantId: 'blue',
        submissionId: null,
        action: { index: 2 },
      },
    });
    expect(checkpoint).toMatchObject({ digest: timeout.result.digest });
    expect(timeout.deltas.every((delta) => (
      JSON.stringify(delta.acknowledgements)
      === JSON.stringify([{ participantId: 'red', submissionId: 'red-1' }])
    ))).toBe(true);
    expect(timeout.deltas).not.toBe(timeout.result.deltas);
    expect(Object.isFrozen(timeout.deltas)).toBe(true);
    expect(Object.isFrozen(timeout.result.deltas)).toBe(true);
    expect(Object.isFrozen(timeout.deltas[0]?.body)).toBe(true);
    expect(() => {
      (timeout.deltas[0]?.body as unknown as Record<string, unknown>)['kind'] = 'unchanged';
    }).toThrow(TypeError);
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(() => {
      (resolution as unknown as Record<string, unknown>)['kind'] = 'extension';
    }).toThrow(TypeError);
    kernel.commit(timeout);
    expect(kernel.digest()).toBe(checkpoint?.kind === 'checkpoint' ? checkpoint.digest : -1);

    const artifact = finalizeReplay(kernel.liveTranscript(), { perm: [0] });
    const replayResolution = artifact.records?.find((record) => record.kind === 'resolution');
    expect(replayResolution).toMatchObject({
      kind: 'resolution',
      systemInput: { index: 2, seat: 'blue' },
    });
    const legacyTranscript = structuredClone(kernel.liveTranscript());
    const legacyResolution = legacyTranscript.events.find(
      (event) => event.kind === 'resolution',
    );
    if (legacyResolution?.kind === 'resolution') delete legacyResolution.systemInput;
    expect(finalizeReplay(legacyTranscript, { perm: [0] }).records)
      .toEqual(artifact.records);
    const forgedTimeout = structuredClone(kernel.liveTranscript());
    const timeoutEvent = forgedTimeout.events.find((event) => event.kind === 'timeout');
    if (timeoutEvent?.kind === 'timeout') timeoutEvent.participantId = 'red';
    expect(() => finalizeReplay(forgedTimeout, { perm: [0] }))
      .toThrow(/participant must match/);
    const forgedWindowTimeout = structuredClone(kernel.liveTranscript());
    const forgedWindowEvent = forgedWindowTimeout.events.find(
      (event) => event.kind === 'timeout',
    );
    const forgedWindowResolution = forgedWindowTimeout.events.find(
      (event) => event.kind === 'resolution' && event.cause === 'timeout',
    );
    if (forgedWindowEvent?.kind === 'timeout') forgedWindowEvent.participantId = null;
    if (forgedWindowResolution?.kind === 'resolution'
      && forgedWindowResolution.systemInput) {
      forgedWindowResolution.systemInput.participantId = null;
    }
    expect(() => finalizeReplay(forgedWindowTimeout, { perm: [0] }))
      .toThrow(/window timeout.*cannot name/);
    expect(() => rehydrateKernel(options(), forgedWindowTimeout))
      .toThrow(/window timeout.*cannot name/);
    const forgedUnknownParticipant = structuredClone(kernel.liveTranscript());
    const unknownTimeout = forgedUnknownParticipant.events.find(
      (event) => event.kind === 'timeout',
    );
    const unknownResolution = forgedUnknownParticipant.events.find(
      (event) => event.kind === 'resolution' && event.cause === 'timeout',
    );
    if (unknownTimeout?.kind === 'timeout') unknownTimeout.participantId = 'green';
    if (unknownResolution?.kind === 'resolution' && unknownResolution.systemInput) {
      unknownResolution.systemInput.participantId = 'green';
      unknownResolution.systemInput.action.seat = 'green';
    }
    expect(() => finalizeReplay(forgedUnknownParticipant, { perm: [0] }))
      .toThrow(/declared session seat/);
    const forgedEmptyTimeout = structuredClone(kernel.liveTranscript());
    const emptyTimeout = forgedEmptyTimeout.events.find((event) => event.kind === 'timeout');
    if (emptyTimeout?.kind === 'timeout') emptyTimeout.timeoutId = '';
    expect(() => finalizeReplay(forgedEmptyTimeout, { perm: [0] }))
      .toThrow(/non-empty timeoutId/);

    const exactRetry = kernel.prepareIngest(submission('red', 'red-1', 1));
    expect(exactRetry.result.status).toBe('duplicate');
    kernel.commit(exactRetry);
    expect(() => kernel.prepareIngest(submission('red', 'late', 1)))
      .toThrowError(expect.objectContaining<Partial<IntentCollectionError>>({
        code: 'stale_tick',
      }));
    expect(() => kernel.prepareTimeout(
      { timeoutId: 'late', reason: 'elapsed', tick: 1 },
      { id: 'Action 1', index: 1 },
    )).toThrowError(SessionAdvanceError);
    expect(() => kernel.prepareExtension('late', { value: 1 }))
      .toThrowError(SessionAdvanceError);
  });

  it('cleans both the isolated fork and a fresh reducer result', () => {
    const discarded: State[] = [];
    const retired: State[] = [];
    const freshReducer: TickReducer<Level, State> = {
      ...reducer,
      advance: (state) => ({ ...state }),
    };
    const freshOptions: SessionKernelOptions<Level, State, Command, TickView> = {
      ...options(),
      reducer: freshReducer,
      cadence: { mode: 'ticks', rate: createTickRate(30) },
      stateIsolation: {
        fork: (state) => structuredClone(state),
        discard: (state) => discarded.push(state),
        retire: (state) => retired.push(state),
      },
    };
    const kernel = createSessionKernel(freshOptions);
    expect(discarded).toHaveLength(1); // constructor isolation probe
    kernel.abort(kernel.prepareAdvance(0));
    expect(discarded).toHaveLength(3);
    kernel.commit(kernel.prepareAdvance(0));
    expect(discarded).toHaveLength(4);
    expect(retired).toHaveLength(1);
  });

  it('enforces future-target bounds with the RFC default catch-up capacity', () => {
    const kernel = createSessionKernel({
      ...options(),
      cadence: { mode: 'ticks', rate: createTickRate(30) },
      limits: { maxFutureTicks: 2 },
    });
    try {
      kernel.prepareAdvance(3);
      throw new Error('expected the future target to be rejected');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionAdvanceError);
      expect((error as SessionAdvanceError).code).toBe('invalid_target');
    }
    const advance = kernel.prepareAdvance(2);
    expect(advance.result).toMatchObject({ resolutions: 3, partial: false });
    kernel.abort(advance);
  });

  it('preserves stable cursor precedence after receipt eviction', () => {
    const kernel = createSessionKernel({
      ...options(),
      limits: { receiptRetention: 0 },
    });
    kernel.commit(kernel.prepareIngest(submission('red', 'red-old', 1)));
    kernel.commit(kernel.prepareIngest(submission('blue', 'blue-old', 1)));
    kernel.commit(kernel.prepareAdvance());
    expect(kernel.cursor()).toBe(kernel.tick());
    expect(() => kernel.prepareIngest(submission('red', 'red-old', 1)))
      .toThrowError(expect.objectContaining<Partial<IntentCollectionError>>({
        code: 'stale_tick',
      }));
  });

  it('never reapplies an accepted submission ID after bounded receipt cleanup', () => {
    const kernel = createSessionKernel({
      ...options(),
      limits: { receiptRetention: 1 },
    });
    for (const [round, redId, blueId] of [
      [0, 'red-original', 'blue-0'],
      [1, 'red-1', 'blue-1'],
      [2, 'red-2', 'blue-2'],
    ] as const) {
      const atCursor = (participantId: string, submissionId: string) => ({
        ...submission(participantId, submissionId, 0),
        tickId: makeTickId('session-kernel-test', round),
        revision: round,
      });
      kernel.commit(kernel.prepareIngest(atCursor('red', redId)));
      kernel.commit(kernel.prepareIngest(atCursor('blue', blueId)));
      kernel.commit(kernel.prepareAdvance());
    }

    expect(kernel.cursor()).toBe(3);
    expect(() => kernel.prepareIngest({
      ...submission('red', 'red-original', 0),
      tickId: makeTickId('session-kernel-test', 3),
      revision: 3,
    })).toThrowError(SessionConflictError);
    try {
      kernel.prepareIngest({
        ...submission('red', 'red-original', 0),
        tickId: makeTickId('session-kernel-test', 3),
        revision: 3,
      });
    } catch (error) {
      expect((error as SessionConflictError).code).toBe('unknown_submission');
    }
  });

  it('produces cadence-equivalent canonical event streams for the same ready window', () => {
    const turns = createSessionKernel(options());
    const ticks = createSessionKernel({
      ...options(),
      cadence: { mode: 'ticks', rate: createTickRate(30) },
    });
    for (const kernel of [turns, ticks]) {
      kernel.commit(kernel.prepareIngest(submission('red', 'red-1', 1)));
      kernel.commit(kernel.prepareIngest(submission('blue', 'blue-1', 2)));
      kernel.commit(kernel.prepareAdvance());
    }
    expect(withoutHostTimes(ticks.liveTranscript().events))
      .toEqual(withoutHostTimes(turns.liveTranscript().events));
    expect(ticks.digest()).toBe(turns.digest());
  });

  it('reproduces per-seat views from deltas without leaking another seat hand', () => {
    interface HiddenState {
      actionsUsed: number;
      hands: Record<string, string>;
    }
    type HiddenZones = Record<string, {
      count: number;
      entries: Array<{ id: string }>;
    }>;
    type HiddenView = TickView<unknown, HiddenZones>;
    const hiddenReducer: TickReducer<{}, HiddenState, HiddenView> = {
      init: () => ({
        actionsUsed: 0,
        hands: { alpha: 'alpha-secret', beta: 'beta-secret' },
      }),
      advance: (state, inputs) => ({
        ...state,
        actionsUsed: state.actionsUsed
          + inputs.filter((input) => input.seat === 'alpha').length,
      }),
      view: (state): HiddenView => ({
        actions: [{ id: 'Action 1', params: 'none' }],
        status: state.actionsUsed >= 2 ? 'won' : 'playing',
        ...(state.actionsUsed >= 2 ? { stars: 3 } : {}),
        participation: { mode: 'simultaneous', seats: ['alpha', 'beta'] },
        hud: { actionsUsed: state.actionsUsed },
        zones: { hand: { count: 2, entries: [] } },
      }),
      viewFor: (state, seat): HiddenView => ({
        actions: [{ id: 'Action 1', params: 'none' }],
        status: 'playing',
        participation: { mode: 'simultaneous', seats: ['alpha', 'beta'] },
        hud: { actionsUsed: seat === 'alpha' ? state.actionsUsed : 0 },
        zones: {
          hand: {
            count: 1,
            entries: [{ id: state.hands[seat]! }],
          },
        },
      }),
    };
    const hiddenOptions: SessionKernelOptions<{}, HiddenState, Command, HiddenView> = {
      sessionId: 'hidden-session',
      game,
      levelId: 'hidden',
      reducer: hiddenReducer,
      level: {},
      seed: 1,
      seedPolicy: 'explicit',
      seats: ['alpha', 'beta'],
      cadence: { mode: 'turns' },
      hostTime: 'none',
      commandToAction: (_command, context) => ({
        id: 'Action 1',
        seat: context.participantId,
      }),
    };
    const hiddenSubmission = (seat: string): CommandSubmission<Command> => ({
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: hiddenOptions.sessionId,
      tickId: makeTickId(hiddenOptions.sessionId, 0),
      revision: 0,
      participantId: seat,
      submissionId: `${seat}-1`,
      command: { amount: 1 },
    });
    const kernel = createSessionKernel(hiddenOptions);
    const reproduced = new Map<string, HiddenView>();
    for (const seat of hiddenOptions.seats) {
      const snapshot = kernel.snapshot(seat);
      expect(snapshot.acknowledgements).toEqual([]);
      expect(snapshot.rejections).toEqual([]);
      if (snapshot.body.kind === 'snapshot') reproduced.set(seat, snapshot.body.view);
    }
    kernel.commit(kernel.prepareIngest(hiddenSubmission('alpha')));
    kernel.commit(kernel.prepareIngest(hiddenSubmission('beta')));
    const advance = kernel.prepareAdvance();
    expect(advance.deltas.find(({ seat }) => seat === 'beta')?.body)
      .toEqual({ kind: 'unchanged' });
    expect(advance.deltas.every((delta) => delta.acknowledgements.length === 2))
      .toBe(true);
    for (const delta of advance.deltas as readonly ObservationDelta<HiddenView>[]) {
      expect(delta.codec).toBe('v2');
      reproduced.set(
        delta.seat,
        applyObservationDelta(reproduced.get(delta.seat), delta),
      );
    }
    expect(JSON.stringify(advance.deltas.filter(({ seat }) => seat === 'alpha')))
      .not.toContain('beta-secret');
    expect(JSON.stringify(advance.deltas.filter(({ seat }) => seat === 'beta')))
      .not.toContain('alpha-secret');
    kernel.commit(advance);
    expect(reproduced.get('alpha')).toEqual(kernel.observe('alpha'));
    expect(reproduced.get('beta')).toEqual(kernel.observe('beta'));
  });
});
