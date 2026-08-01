import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  makeTickId,
  type CommandSubmission,
} from '../src/protocol.js';
import {
  GAOS_REPLAY_FORMAT_VERSION,
  recheckReplayArtifact,
  type TickReducer,
  type TickView,
} from '../src/engine/index.js';
import {
  IntentCollectionError,
  SessionConflictError,
  createSessionKernel,
  finalizeReplay,
  rehydrateKernel,
  rehydrateKernelFromCheckpoint,
  type SessionKernelOptions,
} from '../src/session.js';

type Command =
  | { kind: 'set-multiplier'; value: number }
  | { kind: 'add'; value: number };

interface State {
  total: number;
  multiplier: number;
  actionsUsed: number;
}

const reducer: TickReducer<null, State> = {
  init: () => ({ total: 0, multiplier: 1, actionsUsed: 0 }),
  advance: (state, actions) => ({
    ...state,
    total: state.total + actions.reduce((sum, action) => sum + (action.index ?? 0), 0),
    actionsUsed: state.actionsUsed + actions.length,
  }),
  view: (state): TickView => ({
    status: state.total >= 11 ? 'won' : 'playing',
    ...(state.total >= 11 ? { stars: 1 } : {}),
    actions: [{ id: 'Action 1', params: 'index' }],
    participation: { mode: 'simultaneous', seats: ['blue', 'red'] },
    hud: { actionsUsed: state.actionsUsed },
  }),
  replayMetrics: (state) => ({ actionsUsed: state.actionsUsed }),
};

const game = {
  id: 'tests/rfc020',
  version: '1',
  adapter: { id: 'tests/rfc020/adapter', version: '1' },
};

function options(classifications: string[] = []):
SessionKernelOptions<null, State, Command, TickView> {
  return {
    sessionId: 'rfc020',
    game,
    levelId: 'only',
    reducer,
    level: null,
    seed: 1,
    seedPolicy: 'explicit',
    seats: ['red', 'blue'],
    cadence: { mode: 'turns' },
    hostTime: 'none',
    classifyCommand: (state, command, context) => {
      classifications.push(context.submissionId);
      if (command.kind === 'set-multiplier') {
        state.multiplier = command.value;
        return {
          kind: 'interaction',
          state,
        };
      }
      return {
        kind: 'intent',
        action: {
          id: 'Action 1',
          index: command.value * state.multiplier,
          seat: context.participantId,
        },
      };
    },
  };
}

function submit(
  participantId: string,
  submissionId: string,
  command: Command,
): CommandSubmission<Command> {
  return {
    protocol: PROTOCOL_ID,
    protocolVersion: PROTOCOL_VERSION,
    sessionId: 'rfc020',
    tickId: makeTickId('rfc020', 0),
    revision: 0,
    participantId,
    submissionId,
    command,
  };
}

describe('RFC-020 unified command effects', () => {
  it('requires one authoritative adapter and rejects stale input before classification', () => {
    expect(() => createSessionKernel({
      ...options(),
      commandToAction: () => ({ id: 'Action 1' }),
    })).toThrowError(/exactly one command adapter/);
    const { classifyCommand: _classifier, ...missing } = options();
    expect(() => createSessionKernel(missing)).toThrowError(
      /exactly one command adapter/,
    );

    const classifications: string[] = [];
    const kernel = createSessionKernel(options(classifications));
    expect(() => kernel.prepareCommand({
      ...submit('red', 'stale', { kind: 'add', value: 1 }),
      revision: 1,
    })).toThrowError(IntentCollectionError);
    expect(classifications).toEqual([]);
  });

  it('validates classifier effects and preserves the legacy intent adapter', () => {
    const legacy = createSessionKernel({
      ...options(),
      classifyCommand: undefined,
      commandToAction: (command: Command, context) => ({
        id: 'Action 1',
        index: command.value,
        seat: context.participantId,
      }),
    });
    expect(legacy.prepareCommand(submit('red', 'legacy', {
      kind: 'add',
      value: 1,
    })).result.effect).toBe('intent');

    const invalid = createSessionKernel({
      ...options(),
      classifyCommand: () => ({ kind: 'invalid' } as never),
    });
    expect(() => invalid.prepareCommand(submit('red', 'invalid', {
      kind: 'add',
      value: 1,
    }))).toThrowError(/interaction or intent effect/);

    const throwing = createSessionKernel({
      ...options(),
      classifyCommand: () => {
        throw new Error('classifier failed');
      },
    });
    expect(() => throwing.prepareCommand(submit('red', 'throwing', {
      kind: 'add',
      value: 1,
    }))).toThrowError(/classifier failed/);
  });

  it('keeps aborted interactions pure and rejects cross-effect identity reuse', () => {
    const kernel = createSessionKernel(options());
    const before = kernel.digest();
    const interaction = kernel.prepareCommand(submit('blue', 'shared', {
      kind: 'set-multiplier',
      value: 10,
    }));
    kernel.abort(interaction);
    expect(kernel.digest()).toBe(before);

    kernel.commit(kernel.prepareCommand(submit('blue', 'shared', {
      kind: 'set-multiplier',
      value: 10,
    })));
    expect(() => kernel.prepareCommand(submit('blue', 'shared', {
      kind: 'add',
      value: 1,
    }))).toThrowError(SessionConflictError);
  });

  it('classifies one command path, preserves pending intents, and freezes actions', () => {
    const classifications: string[] = [];
    const kernel = createSessionKernel(options(classifications));

    kernel.commit(kernel.prepareCommand(submit('red', 'red-intent', {
      kind: 'add',
      value: 1,
    })));
    const interaction = kernel.prepareCommand(submit('blue', 'blue-interaction', {
      kind: 'set-multiplier',
      value: 10,
    }));
    expect(interaction.result).toMatchObject({
      status: 'accepted',
      effect: 'interaction',
      cursor: 0,
      tick: 0,
    });
    expect(interaction.deltas.every((delta) => delta.origin === 'interaction')).toBe(true);
    kernel.commit(interaction);
    expect(kernel.awaitingSeats()).toEqual(['blue']);

    const retry = kernel.prepareCommand(submit('blue', 'blue-interaction', {
      kind: 'set-multiplier',
      value: 10,
    }));
    expect(retry.result.status).toBe('duplicate');
    kernel.abort(retry);
    expect(classifications.filter((id) => id === 'blue-interaction')).toHaveLength(1);

    kernel.commit(kernel.prepareCommand(submit('blue', 'blue-intent', {
      kind: 'add',
      value: 1,
    })));
    kernel.commit(kernel.prepareAdvance());

    expect(kernel.observe('red').status).toBe('won');
    const resolution = kernel.liveTranscript().events.find((event) => event.kind === 'resolution');
    expect(resolution?.kind === 'resolution'
      ? resolution.inputs.map((input) => input.action.index)
      : []).toEqual([10, 1]);
    expect(classifications.filter((id) => id.endsWith('intent'))).toHaveLength(2);
  });

  it('recovers and independently replays ordered interactions in v1.4', () => {
    const kernel = createSessionKernel(options());
    kernel.commit(kernel.prepareCommand(submit('red', 'red-intent', {
      kind: 'add',
      value: 1,
    })));
    kernel.commit(kernel.prepareCommand(submit('blue', 'blue-interaction', {
      kind: 'set-multiplier',
      value: 10,
    })));
    kernel.commit(kernel.prepareCommand(submit('blue', 'blue-intent', {
      kind: 'add',
      value: 1,
    })));
    kernel.commit(kernel.prepareAdvance());

    const transcript = kernel.liveTranscript();
    const recovered = rehydrateKernel(options(), transcript);
    expect(recovered.observe('red')).toEqual(kernel.observe('red'));

    const replay = finalizeReplay(transcript, { perm: [0] });
    expect(replay.header.formatVersion).toBe(GAOS_REPLAY_FORMAT_VERSION);
    expect(replay.records?.map((record) => record.kind)).toEqual([
      'interaction',
      'resolution',
      'checkpoint',
    ]);
    const checked = recheckReplayArtifact(
      replay,
      () => reducer,
      {
        semanticAdapterForLevel: () => ({
          classifyCommand: (state, command, context) =>
            options().classifyCommand!(state, command as Command, context),
        }),
      },
    );
    expect(checked.ok).toBe(true);
    expect(recheckReplayArtifact(replay, () => reducer).ok).toBe(false);

    const wrongCursor = structuredClone(replay);
    const recordedInteraction = wrongCursor.records?.find(
      (record) => record.kind === 'interaction',
    );
    if (recordedInteraction?.kind === 'interaction') recordedInteraction.cursor = 1;
    expect(recheckReplayArtifact(
      wrongCursor,
      () => reducer,
      {
        semanticAdapterForLevel: () => ({
          classifyCommand: (_state, _command, context) => ({
            kind: 'intent',
            action: { id: 'Action 1', seat: context.participantId },
          }),
        }),
      },
    ).ok).toBe(false);
    expect(recheckReplayArtifact(
      replay,
      () => reducer,
      {
        semanticAdapterForLevel: () => ({
          classifyCommand: (_state, _command, context) => ({
            kind: 'intent',
            action: { id: 'Action 1', seat: context.participantId },
          }),
        }),
      },
    ).ok).toBe(false);
    expect(recheckReplayArtifact(
      replay,
      () => reducer,
      {
        semanticAdapterForLevel: () => ({
          classifyCommand: () => {
            throw new Error('historical adapter unavailable');
          },
        }),
      },
    ).problems.some((problem) =>
      problem.includes('classification failed: historical adapter unavailable'),
    )).toBe(true);

    expect(() => rehydrateKernel({
      ...options(),
      classifyCommand: (state, command, context) => command.kind === 'add'
        ? ({
          kind: 'intent',
          action: {
            id: 'Action 1',
            index: command.value * state.multiplier,
            seat: context.participantId,
          },
        })
        : ({
        kind: 'intent',
        action: { id: 'Action 1', seat: context.participantId },
        }),
    }, transcript)).toThrowError(
      /recorded interaction no longer classifies as an interaction/,
    );

    const invalidTranscript = structuredClone(transcript);
    const invalidInteraction = invalidTranscript.events.find(
      (event) => event.kind === 'interaction',
    );
    if (invalidInteraction?.kind === 'interaction') {
      invalidInteraction.canonicalCommand = '{}';
    }
    expect(() => rehydrateKernel(options(), invalidTranscript)).toThrowError(
      /transcript contains an invalid interaction/,
    );
  });

  it('restores frozen pending actions and interactions from a checkpoint', () => {
    const kernel = createSessionKernel(options());
    kernel.commit(kernel.prepareCommand(submit('red', 'red-intent', {
      kind: 'add',
      value: 1,
    })));
    kernel.commit(kernel.prepareCommand(submit('blue', 'blue-interaction', {
      kind: 'set-multiplier',
      value: 10,
    })));

    const restored = rehydrateKernelFromCheckpoint(options(), kernel.checkpoint(), []);
    expect(restored.awaitingSeats()).toEqual(['blue']);
    restored.commit(restored.prepareCommand(submit('blue', 'blue-intent', {
      kind: 'add',
      value: 1,
    })));
    restored.commit(restored.prepareAdvance());
    expect(restored.observe('red').status).toBe('won');
  });
});
