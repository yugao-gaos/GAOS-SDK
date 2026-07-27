import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_ID,
  PROTOCOL_VERSION,
  makeTickId,
  type JsonValue,
} from '../src/protocol.js';
import type { SessionView, TickReducer } from '../src/engine/index.js';
import { createSessionKernel } from '../src/session.js';
import {
  InMemorySessionEventStore,
  SessionKernelHost,
  runEventStoreConformance,
  type SessionEventStore,
} from '../src/session-host.js';

interface State {
  actionsUsed: number;
}

interface Command {
  [key: string]: JsonValue;
  action: string;
}

const reducer: TickReducer<null, State, SessionView> = {
  init: () => ({ actionsUsed: 0 }),
  advance: (state) => ({ actionsUsed: state.actionsUsed + 1 }),
  view: (state) => ({
    status: state.actionsUsed > 0 ? 'ended' : 'playing',
  }),
  replayMetrics: (state) => ({ actionsUsed: state.actionsUsed }),
};

function kernel() {
  return createSessionKernel({
    sessionId: 'host-test',
    game: {
      id: 'tests/session-host',
      version: '1',
      adapter: { id: 'tests/session-host/reducer', version: '1' },
    },
    levelId: 'room',
    reducer,
    level: null,
    seed: 1,
    seedPolicy: 'explicit',
    seats: ['solo'],
    cadence: { mode: 'turns' },
    hostTime: 'none',
    commandToAction: (_command, context) => ({
      id: 'Action 1',
      seat: context.participantId,
    }),
  });
}

const submission = {
  protocol: PROTOCOL_ID,
  protocolVersion: PROTOCOL_VERSION,
  sessionId: 'host-test',
  tickId: makeTickId('host-test', 0),
  revision: 0,
  participantId: 'solo',
  submissionId: 'one',
  command: { action: 'end' },
} as const;

describe('reference session host and conformance kit', () => {
  it('passes byte-identical retry and conflicting-event conformance', async () => {
    expect(await runEventStoreConformance(
      () => new InMemorySessionEventStore(),
    )).toEqual([
      { name: 'byte-identical retry', passed: true },
      { name: 'conflicting event reuse', passed: true },
      { name: 'atomic conflicting batch', passed: true },
    ]);
  });

  it('aborts a draft when persistence fails before writing and can retry', async () => {
    const inner = new InMemorySessionEventStore();
    let failBeforePersist = true;
    const store: SessionEventStore = {
      load: () => inner.load(),
      persist: async (events) => {
        if (failBeforePersist) {
          failBeforePersist = false;
          throw new Error('simulated failure before persistence');
        }
        await inner.persist(events);
      },
    };
    const live = kernel();
    const host = new SessionKernelHost(live, store, async () => undefined);

    await expect(host.ingest(submission)).rejects.toThrow(/before persistence/);
    expect(await store.load()).toHaveLength(0);
    expect(live.awaitingSeats()).toEqual(['solo']);
    await expect(host.ingest(submission)).resolves.toMatchObject({
      status: 'accepted',
      submissionId: 'one',
    });
  });

  it('recovers when persistence succeeds but the host observes a failure', async () => {
    const inner = new InMemorySessionEventStore();
    let failAfterPersist = true;
    const store: SessionEventStore = {
      load: () => inner.load(),
      persist: async (events) => {
        await inner.persist(events);
        if (failAfterPersist) {
          failAfterPersist = false;
          throw new Error('simulated crash after persistence');
        }
      },
    };
    const live = kernel();
    const host = new SessionKernelHost(live, store, async () => undefined);

    await expect(host.ingest(submission)).rejects.toThrow(/after persistence/);
    expect(live.cursor()).toBe(0);
    expect(await store.load()).toHaveLength(1);

    await expect(host.ingest(submission)).resolves.toMatchObject({
      status: 'accepted',
      submissionId: 'one',
    });
    expect(await store.load()).toHaveLength(1);
    expect(live.awaitingSeats()).toEqual([]);
  });

  it('commits once and retries publication without rewriting history', async () => {
    const store = new InMemorySessionEventStore();
    const published: unknown[] = [];
    let failPublish = true;
    const live = kernel();
    const host = new SessionKernelHost(live, store, async (deltas) => {
      if (failPublish) {
        failPublish = false;
        throw new Error('publish unavailable');
      }
      published.push(structuredClone(deltas));
    });

    await host.ingest(submission);
    await expect(host.advance()).rejects.toThrow(/publish unavailable/);
    expect(live.cursor()).toBe(1);
    expect(host.pendingPublicationBatches()).toBe(1);
    const durableCount = (await store.load()).length;

    await host.retryPublish();
    expect(host.pendingPublicationBatches()).toBe(0);
    expect(published).toHaveLength(1);
    expect(await store.load()).toHaveLength(durableCount);
  });

  it('serializes concurrent callers so prepared transitions cannot go stale', async () => {
    const store = new InMemorySessionEventStore();
    const live = kernel();
    const host = new SessionKernelHost(live, store, async () => undefined);

    const [receipt, advance] = await Promise.all([
      host.ingest(submission),
      host.advance(),
    ]);
    expect(receipt.status).toBe('accepted');
    expect(advance.resolutions).toBe(1);
    expect(live.cursor()).toBe(1);
  });
});
