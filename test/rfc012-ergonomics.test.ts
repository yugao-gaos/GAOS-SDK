import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  makeTickId,
  type JsonValue,
} from '../src/protocol.js';
import type {
  SessionView,
  TickReducer,
} from '../src/engine/index.js';
import {
  createSessionKernel,
  createTickRate,
} from '../src/session.js';

interface State {
  actionsUsed: number;
}

interface Command {
  [key: string]: JsonValue;
  kind: string;
}

const reducer: TickReducer<null, State, SessionView> = {
  init: () => ({ actionsUsed: 0 }),
  advance: (state) => state,
  view: () => ({ status: 'playing' }),
  replayMetrics: (state) => ({ actionsUsed: state.actionsUsed }),
};

describe('RFC-012 session ergonomics', () => {
  it('exposes the next tick-bounded advance deadline while a window is open', () => {
    const kernel = createSessionKernel({
      sessionId: 'deadline',
      game: {
        id: 'tests/deadline',
        version: '1',
        adapter: { id: 'tests/deadline/reducer', version: '1' },
      },
      levelId: 'room',
      reducer,
      level: null,
      seed: 1,
      seedPolicy: 'explicit',
      seats: ['solo'],
      cadence: { mode: 'ticks', rate: createTickRate(20) },
      hostTime: 'none',
      timeoutPolicy: { mode: 'ticks', windowTicks: 5 },
      timeoutToAction: () => ({ id: 'Action 1' }),
      commandToAction: () => ({ id: 'Action 1' }),
    });

    expect(kernel.nextDeadline()).toBe(5);
    kernel.commit(kernel.prepareIngest({
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: 'deadline',
      tickId: makeTickId('deadline', 0),
      revision: 0,
      participantId: 'solo',
      submissionId: 'one',
      command: { kind: 'wait' },
    }));
    expect(kernel.nextDeadline()).toBeUndefined();
  });

  it('reports canonical declared and supplied seat sets for invalid participation', () => {
    const emptyParticipation: TickReducer<null, State, SessionView> = {
      ...reducer,
      view: () => ({
        status: 'playing',
        participation: { mode: 'simultaneous', seats: [] },
      }),
    };
    expect(() => createSessionKernel({
      sessionId: 'participation-empty',
      game: {
        id: 'tests/participation',
        version: '1',
        adapter: { id: 'tests/participation/reducer', version: '1' },
      },
      levelId: 'room',
      reducer: emptyParticipation,
      level: null,
      seed: 1,
      seedPolicy: 'explicit',
      seats: ['zeta', 'alpha'],
      cadence: { mode: 'turns' },
      hostTime: 'none',
      commandToAction: () => ({ id: 'Action 1' }),
    })).toThrow(
      /declared=\[alpha, zeta\], supplied=\[\] \(supplied set is empty\)/,
    );

    const unknownParticipation: TickReducer<null, State, SessionView> = {
      ...reducer,
      view: () => ({
        status: 'playing',
        participation: {
          mode: 'simultaneous',
          seats: ['zeta', 'beta'],
        },
      }),
    };
    expect(() => createSessionKernel({
      sessionId: 'participation-unknown',
      game: {
        id: 'tests/participation',
        version: '1',
        adapter: { id: 'tests/participation/reducer', version: '1' },
      },
      levelId: 'room',
      reducer: unknownParticipation,
      level: null,
      seed: 1,
      seedPolicy: 'explicit',
      seats: ['zeta', 'alpha'],
      cadence: { mode: 'turns' },
      hostTime: 'none',
      commandToAction: () => ({ id: 'Action 1' }),
    })).toThrow(
      /declared=\[alpha, zeta\], supplied=\[beta, zeta\] \(undeclared seats: beta\)/,
    );
  });
});
