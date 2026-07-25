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
  serializeReplayJsonl,
  type ReplayGameRef,
  type TickReducer,
  type TickView,
} from '../src/engine/index.js';
import {
  PreparedTransitionError,
  SessionAdvanceError,
  createSessionKernel,
  finalizeReplay,
  rehydrateKernel,
  type ObservationDelta,
  type SessionKernelOptions,
} from '../src/session.js';

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
    expect(() => kernel.abort(right)).toThrow(/already aborted/);
  });

  it('rehydrates pending intents and finalizes an atomically recheckable v1.1 replay', () => {
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

    const artifact = finalizeReplay(recovered.liveTranscript(), { perm: [0] });
    expect(artifact.header.formatVersion).toBe('1.1');
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
    expect(() => kernel.prepareIngest(invalid)).toThrow();
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

  it('bounds inclusive tick catch-up and records canonical deadline input', () => {
    const tickOptions = {
      ...options(),
      cadence: { mode: 'ticks', rate: createTickRate(30) } as const,
      limits: { maxCatchUpTicks: 2 },
    };
    const kernel = createSessionKernel(tickOptions);
    const catchUp = kernel.prepareAdvance(5);
    expect(catchUp.result).toMatchObject({ resolutions: 2, partial: true, tick: 2 });
    kernel.abort(catchUp);
    const deadline = kernel.prepareDeadline(
      { deadlineId: 'turn-0', tick: 0, participantId: 'red' },
      { id: 'Action 1', index: 3, seat: 'red' },
    );
    expect(deadline.events.map(({ kind }) => kind))
      .toEqual(['deadline', 'resolution', 'checkpoint']);
    kernel.commit(deadline);
    expect(kernel.observe('red').status).toBe('won');
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
    const rejected = live.prepareAdvance();
    expect(rejected.events.at(-1)).toMatchObject({
      kind: 'rejection',
      participantId: 'zulu',
    });
    live.commit(rejected);

    const recovered = rehydrateKernel(secretOptions, live.liveTranscript());
    for (const kernel of [live, recovered]) {
      const retry = kernel.prepareIngest(submit(
        1,
        'zulu',
        'zulu-reveal',
        { kind: 'reveal', commitmentId: 0, salt: zuluSalt, payload: honestPayload },
      ));
      expect(retry.result.status).toBe('accepted');
      kernel.commit(retry);
      kernel.commit(kernel.prepareAdvance());
    }
    expect(recovered.digest()).toBe(live.digest());
    expect(recovered.liveTranscript()).toEqual(live.liveTranscript());
    expect(live.observe('alpha').status).toBe('won');

    const checked = recheckReplayArtifact(
      finalizeReplay(live.liveTranscript(), { perm: [0] }),
      () => secretReducer,
    );
    expect(checked.problems.join('\n')).toMatch(/commit_mismatch.*zulu.*0/);
  });

  it('projects the explicit system input and publishes matching checkpoint digests', () => {
    const kernel = createSessionKernel(options());
    kernel.commit(kernel.prepareIngest(submission('red', 'red-1', 1)));
    const deadline = kernel.prepareDeadline(
      { deadlineId: 'mixed', tick: 0, participantId: 'blue' },
      { id: 'Action 1', index: 2, seat: 'blue' },
    );
    const resolution = deadline.events.find((event) => event.kind === 'resolution');
    const checkpoint = deadline.events.find((event) => event.kind === 'checkpoint');
    expect(resolution).toMatchObject({
      kind: 'resolution',
      inputs: { length: 2 },
      systemInput: {
        participantId: 'blue',
        submissionId: null,
        action: { index: 2 },
      },
    });
    expect(checkpoint).toMatchObject({ digest: deadline.result.digest });
    expect(Object.isFrozen(resolution)).toBe(true);
    expect(() => {
      (resolution as unknown as Record<string, unknown>)['kind'] = 'extension';
    }).toThrow(TypeError);
    kernel.commit(deadline);
    expect(kernel.digest()).toBe(checkpoint?.kind === 'checkpoint' ? checkpoint.digest : -1);

    const artifact = finalizeReplay(kernel.liveTranscript(), { perm: [0] });
    const replayResolution = artifact.records?.find((record) => record.kind === 'resolution');
    expect(replayResolution).toMatchObject({
      kind: 'resolution',
      systemInput: { index: 2, seat: 'blue' },
    });
    expect(() => kernel.prepareIngest(submission('red', 'late', 1)))
      .toThrowError(SessionAdvanceError);
    expect(() => kernel.prepareDeadline(
      { deadlineId: 'late', tick: 1 },
      { id: 'Action 1', index: 1 },
    )).toThrowError(SessionAdvanceError);
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
    expect(() => kernel.prepareAdvance(3)).toThrow(/maxFutureTicks/);
    const advance = kernel.prepareAdvance(2);
    expect(advance.result).toMatchObject({ resolutions: 3, partial: false });
    kernel.abort(advance);
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
    expect(ticks.liveTranscript().events).toEqual(turns.liveTranscript().events);
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
        actionsUsed: state.actionsUsed + inputs.length,
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
        status: state.actionsUsed >= 2 ? 'won' : 'playing',
        ...(state.actionsUsed >= 2 ? { stars: 3 } : {}),
        participation: { mode: 'simultaneous', seats: ['alpha', 'beta'] },
        hud: { actionsUsed: state.actionsUsed },
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
      if (snapshot.body.kind === 'snapshot') reproduced.set(seat, snapshot.body.view);
    }
    kernel.commit(kernel.prepareIngest(hiddenSubmission('alpha')));
    kernel.commit(kernel.prepareIngest(hiddenSubmission('beta')));
    const advance = kernel.prepareAdvance();
    for (const delta of advance.deltas as readonly ObservationDelta<HiddenView>[]) {
      if (delta.body.kind === 'snapshot') reproduced.set(delta.seat, delta.body.view);
    }
    expect(JSON.stringify(advance.deltas.filter(({ seat }) => seat === 'alpha')))
      .not.toContain('beta-secret');
    kernel.commit(advance);
    expect(reproduced.get('alpha')).toEqual(kernel.observe('alpha'));
    expect(reproduced.get('beta')).toEqual(kernel.observe('beta'));
  });
});
