import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  type CommandSubmission,
  type JsonValue,
} from '../src/protocol.js';
import {
  createSessionKernel,
  IntentCollectionError,
  type SessionKernelOptions,
} from '../src/session.js';
import type {
  SessionView,
  SubmittedAction,
  TickReducer,
} from '../src/engine/index.js';

interface State {
  actionsUsed: number;
}

interface View extends SessionView {}

type Command = {
  kind: string;
};

const reducer: TickReducer<null, State, View> = {
  init: () => ({ actionsUsed: 0 }),
  advance: (state) => state,
  view: () => ({ status: 'playing' }),
  replayMetrics: (state) => ({ actionsUsed: state.actionsUsed }),
};

function options(overrides: {
  commandToAction?: SessionKernelOptions<null, State, Command, View>['commandToAction'];
  validateCommand?: (
    state: State,
    seat: string,
    action: SubmittedAction,
  ) => void;
} = {}): SessionKernelOptions<null, State, Command, View> {
  return {
    sessionId: 'rfc011',
    game: {
      id: 'tests/rfc011',
      version: '1',
      adapter: { id: 'tests/rfc011/reducer', version: '1' },
    },
    levelId: 'one',
    reducer: {
      ...reducer,
      ...(overrides.validateCommand === undefined
        ? {}
        : { validateCommand: overrides.validateCommand }),
    },
    level: null,
    seed: 1,
    seedPolicy: 'explicit',
    seats: ['alpha'],
    cadence: { mode: 'turns' },
    hostTime: 'none',
    commandToAction: overrides.commandToAction
      ?? ((command, context) => ({
        id: command.kind,
        seat: context.participantId,
      })),
  };
}

function submission(
  command: Command,
  overrides: Partial<CommandSubmission<Command>> = {},
): CommandSubmission<Command> {
  return {
    protocol: PROTOCOL_ID,
    protocolVersion: PROTOCOL_VERSION,
    sessionId: 'rfc011',
    tickId: 'rfc011:1',
    revision: 1,
    participantId: 'alpha',
    submissionId: 'one',
    command,
    ...overrides,
  };
}

function expectIntentCode(run: () => unknown, code: string): IntentCollectionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(IntentCollectionError);
    expect((error as IntentCollectionError).code).toBe(code);
    return error as IntentCollectionError;
  }
  throw new Error('expected IntentCollectionError');
}

describe('RFC-011 completion', () => {
  it('reports stale_tick before command mapping, commitment checks, or reducer validation', () => {
    const mapping = createSessionKernel(options({
      commandToAction: () => {
        throw new Error('mapping must not run');
      },
    }));
    expectIntentCode(
      () => mapping.prepareIngest(submission({ kind: 'map' })),
      'stale_tick',
    );

    const commitment = createSessionKernel(options({
      commandToAction: (_command, context) => ({
        id: 'reveal',
        seat: context.participantId,
        reveal: {
          commitmentId: 99,
          salt: 'unused',
          payload: null,
        },
      }),
    }));
    expectIntentCode(
      () => commitment.prepareIngest(submission({ kind: 'reveal' })),
      'stale_tick',
    );

    const validation = createSessionKernel(options({
      validateCommand: () => {
        throw new Error('validation must not run');
      },
    }));
    expectIntentCode(
      () => validation.prepareIngest(submission({ kind: 'validate' })),
      'stale_tick',
    );
  });

  it('classifies reducer rejections and preserves Error object identity', () => {
    const cause = new Error('not playable');
    const kernel = createSessionKernel(options({
      validateCommand: () => {
        throw cause;
      },
    }));

    const error = expectIntentCode(
      () => kernel.prepareIngest(submission(
        { kind: 'move' },
        { tickId: 'rfc011:0', revision: 0 },
      )),
      'illegal_command',
    );
    expect(error.cause).toBe(cause);
  });

  it('preserves non-Error reducer rejection values', () => {
    const cause: JsonValue = { reason: 'occupied' };
    const kernel = createSessionKernel(options({
      validateCommand: () => {
        throw cause;
      },
    }));

    const error = expectIntentCode(
      () => kernel.prepareIngest(submission(
        { kind: 'move' },
        { tickId: 'rfc011:0', revision: 0 },
      )),
      'illegal_command',
    );
    expect(error.cause).toBe(cause);
  });
});
