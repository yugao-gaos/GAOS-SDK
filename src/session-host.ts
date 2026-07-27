import { canonicalJson, type JsonObject, type JsonValue } from './protocol.js';
import {
  SessionConflictError,
  type AdvanceSummary,
  type IngestReceipt,
  type InterestReceipt,
  type InterestSubmission,
  type ObservationDelta,
  type Prepared,
  type SeatSignatureInput,
  type SessionEvent,
  type SessionKernel,
  type TimeoutInput,
} from './session.js';

export interface SessionEventStore {
  /** Atomically persist the batch or prove that every event is an exact retry. */
  persist(events: readonly SessionEvent[]): Promise<void>;
  load(): Promise<readonly SessionEvent[]>;
}

export class InMemorySessionEventStore implements SessionEventStore {
  private readonly byId = new Map<string, { canonical: string; event: SessionEvent }>();
  private readonly order: string[] = [];

  async persist(events: readonly SessionEvent[]): Promise<void> {
    const incoming = events.map((event) => ({
      event,
      canonical: canonicalJson(event as unknown as JsonValue),
    }));
    for (const { event, canonical } of incoming) {
      const existing = this.byId.get(event.eventId);
      if (existing !== undefined && existing.canonical !== canonical) {
        throw new SessionConflictError(
          `eventId ${event.eventId} was reused with different canonical bytes`,
        );
      }
    }
    for (const { event, canonical } of incoming) {
      if (this.byId.has(event.eventId)) continue;
      this.byId.set(event.eventId, {
        canonical,
        event: structuredClone(event),
      });
      this.order.push(event.eventId);
    }
  }

  async load(): Promise<readonly SessionEvent[]> {
    return this.order.map((id) => structuredClone(this.byId.get(id)!.event));
  }
}

export type SessionObservationPublisher<TView> = (
  deltas: readonly ObservationDelta<TView>[],
) => Promise<void>;

/**
 * Reference host lane implementing prepare → persist → commit → publish.
 * Publication failures remain queued and can be retried without rerunning the
 * reducer or rewriting durable history.
 */
export class SessionKernelHost<
  TCommand extends JsonValue,
  TView,
  TLevel = unknown,
> {
  private lane: Promise<void> = Promise.resolve();
  private readonly publicationQueue: Array<readonly ObservationDelta<TView>[]> = [];

  constructor(
    private readonly kernel: SessionKernel<TCommand, TView, TLevel>,
    private readonly store: SessionEventStore,
    private readonly publish: SessionObservationPublisher<TView>,
  ) {}

  private enqueue<TResult>(
    prepare: () => Prepared<TResult, TView>,
  ): Promise<TResult> {
    const operation = this.lane.then(async () => {
      await this.flushPublicationQueue();
      const prepared = prepare();
      try {
        await this.store.persist(prepared.events);
      } catch (error) {
        this.kernel.abort(prepared);
        throw error;
      }
      this.kernel.commit(prepared);
      if (prepared.deltas.length > 0) {
        this.publicationQueue.push(structuredClone(prepared.deltas));
      }
      await this.flushPublicationQueue();
      return prepared.result;
    });
    this.lane = operation.then(() => undefined, () => undefined);
    return operation;
  }

  private async flushPublicationQueue(): Promise<void> {
    while (this.publicationQueue.length > 0) {
      const batch = this.publicationQueue[0]!;
      await this.publish(structuredClone(batch));
      this.publicationQueue.shift();
    }
  }

  ingest(submission: Parameters<SessionKernel<TCommand, TView>['prepareIngest']>[0]):
    Promise<IngestReceipt> {
    return this.enqueue(() => this.kernel.prepareIngest(submission));
  }

  advance(target?: number): Promise<AdvanceSummary<TView>> {
    return this.enqueue(() => this.kernel.prepareAdvance(target));
  }

  timeout(
    input: TimeoutInput,
    forcedInput?: Parameters<SessionKernel<TCommand, TView>['prepareTimeout']>[1],
  ): Promise<AdvanceSummary<TView>> {
    return this.enqueue(() => this.kernel.prepareTimeout(input, forcedInput));
  }

  extension(lane: string, record: JsonObject): Promise<void> {
    return this.enqueue(() => this.kernel.prepareExtension(lane, record));
  }

  interest(submission: InterestSubmission): Promise<InterestReceipt> {
    return this.enqueue(() => this.kernel.prepareInterest(submission));
  }

  seatSignature(input: SeatSignatureInput): Promise<void> {
    return this.enqueue(() => this.kernel.prepareSeatSignature(input));
  }

  retryPublish(): Promise<void> {
    const operation = this.lane.then(() => this.flushPublicationQueue());
    this.lane = operation.then(() => undefined, () => undefined);
    return operation;
  }

  pendingPublicationBatches(): number {
    return this.publicationQueue.length;
  }
}

export interface HostConformanceScenario {
  name:
    | 'byte-identical retry'
    | 'conflicting event reuse'
    | 'atomic conflicting batch';
  passed: boolean;
}

/** Reusable transport-neutral event-store conformance checks. */
export async function runEventStoreConformance(
  createStore: () => SessionEventStore,
): Promise<readonly HostConformanceScenario[]> {
  const event: SessionEvent = {
    kind: 'extension',
    eventId: 'conformance:1:0',
    transitionRevision: 1,
    tick: 0,
    lane: 'conformance',
    record: { value: 1 },
  };
  const retryStore = createStore();
  await retryStore.persist([event]);
  await retryStore.persist([structuredClone(event)]);
  const retryPassed = (await retryStore.load()).length === 1;

  const conflictStore = createStore();
  await conflictStore.persist([event]);
  let conflictPassed = false;
  try {
    await conflictStore.persist([{
      ...event,
      record: { value: 2 },
    }]);
  } catch (error) {
    conflictPassed = error instanceof SessionConflictError;
  }
  const atomicStore = createStore();
  await atomicStore.persist([event]);
  let atomicPassed = false;
  try {
    await atomicStore.persist([
      {
        ...event,
        eventId: 'conformance:2:0',
        transitionRevision: 2,
      },
      {
        ...event,
        record: { value: 2 },
      },
    ]);
  } catch (error) {
    atomicPassed = error instanceof SessionConflictError
      && (await atomicStore.load()).length === 1;
  }
  return [
    { name: 'byte-identical retry', passed: retryPassed },
    { name: 'conflicting event reuse', passed: conflictPassed },
    { name: 'atomic conflicting batch', passed: atomicPassed },
  ];
}
