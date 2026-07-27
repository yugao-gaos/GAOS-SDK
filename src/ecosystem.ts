import type { JsonValue } from './protocol.js';
import type {
  ObservationDelta,
  SnapshotResult,
} from './session.js';

export const RFC013_HOST_CONFORMANCE_SCENARIOS = [
  'byte-identical retry',
  'conflicting event reuse',
  'crash before persistence',
  'crash after persistence',
  'crash after commit',
  'publish retry after durable commit',
  'stale prepared transition rejection',
  'timeout transition handling',
  'acknowledgement and rejection',
  'reconnect repair',
  'patch without base snapshot',
  'dropout and drop-in',
  'reconnect and substitution',
  'transfer and atomic seat swap',
  'inactive controller epoch rejection',
  'checkpoint restore and retention floor',
  'artifact finalization and independent verification',
] as const;

export type Rfc013HostConformanceScenario =
  typeof RFC013_HOST_CONFORMANCE_SCENARIOS[number];

export const HOST_CONFORMANCE_VERSION = 'gaos.host-conformance.v1' as const;
export const RFC014_HOST_CONFORMANCE_SCENARIOS =
  RFC013_HOST_CONFORMANCE_SCENARIOS;

export interface HostConformanceAdapter {
  runtime: string;
  adapterVersion: string;
  run(
    scenario: Rfc013HostConformanceScenario,
  ): Promise<{ passed: boolean; details?: JsonValue }>;
}

export interface HostConformanceReport {
  schema: typeof HOST_CONFORMANCE_VERSION;
  runtime: string;
  adapterVersion: string;
  passed: boolean;
  scenarios: readonly {
    scenario: Rfc013HostConformanceScenario;
    passed: boolean;
    details?: JsonValue;
  }[];
}

/** Execute the transport-neutral fixture names and emit portable result facts. */
export async function runHostConformance(
  adapter: HostConformanceAdapter,
): Promise<HostConformanceReport> {
  if (!adapter.runtime || !adapter.adapterVersion) {
    throw new TypeError('conformance adapter runtime and version must be non-empty');
  }
  const scenarios = [];
  for (const scenario of RFC014_HOST_CONFORMANCE_SCENARIOS) {
    const result = await adapter.run(scenario);
    scenarios.push({
      scenario,
      passed: result.passed,
      ...(result.details === undefined
        ? {}
        : { details: structuredClone(result.details) }),
    });
  }
  return {
    schema: HOST_CONFORMANCE_VERSION,
    runtime: adapter.runtime,
    adapterVersion: adapter.adapterVersion,
    passed: scenarios.every(({ passed }) => passed),
    scenarios,
  };
}

export interface PresentationFrame<TView, TEvent> {
  tick: number;
  transitionRevision: number;
  view: TView;
  events: readonly TEvent[];
  stateDigest?: string;
  repair?: boolean;
}

export interface HostCreateInput {
  sessionId: string;
  [key: string]: unknown;
}

export interface HostSeatControl {
  changes: readonly unknown[];
  authorization: unknown;
}

export interface HostSubmission<TCommand> {
  command: TCommand;
  [key: string]: unknown;
}

export interface HostObservation<TView> {
  observation: SnapshotResult<TView>;
}

export interface HostArtifact {
  format: string;
  artifact: JsonValue;
}

export interface HostedSession<TCommand, TView> {
  sessionId: string;
  ingest(input: HostSubmission<TCommand>): Promise<void>;
  snapshot(seat: string, afterRevision?: number): Promise<HostObservation<TView>>;
}

/**
 * Transport-neutral lifecycle boundary. Authentication, sockets, storage,
 * matchmaking, and publication remain host responsibilities.
 */
export interface SessionHostDriver<TCommand, TView> {
  create(input: HostCreateInput): Promise<HostedSession<TCommand, TView>>;
  control(sessionId: string, input: HostSeatControl): Promise<void>;
  ingest(sessionId: string, input: HostSubmission<TCommand>): Promise<void>;
  advance(sessionId: string, tick: number): Promise<void>;
  snapshot(
    sessionId: string,
    seat: string,
    afterRevision?: number,
  ): Promise<HostObservation<TView>>;
  terminate(sessionId: string, reason: string): Promise<HostArtifact>;
}

export interface PresentationEvent {
  /** Stable across retry and reconnect; clients deduplicate on this field. */
  id: string;
  type: string;
  [key: string]: unknown;
}

/**
 * Project one seat-scoped durable observation into a rendering boundary.
 * Repair frames deliberately carry no old cues.
 */
export function presentationFrameFromObservation<
  TView,
  TEvent extends PresentationEvent,
>(
  delta: ObservationDelta<TView>,
  view: TView,
  events: readonly TEvent[],
  options: { stateDigest?: string; repair?: boolean } = {},
): PresentationFrame<TView, TEvent> {
  const repair = options.repair === true || delta.origin === 'snapshot';
  const unique = new Set<string>();
  for (const event of events) {
    if (typeof event.id !== 'string' || event.id.length === 0) {
      throw new TypeError('presentation event id must be a non-empty string');
    }
    if (unique.has(event.id)) {
      throw new TypeError(`duplicate presentation event id ${event.id}`);
    }
    unique.add(event.id);
  }
  return {
    tick: delta.tick,
    transitionRevision: delta.transitionRevision,
    view: structuredClone(view),
    events: repair ? [] : structuredClone(events),
    ...(options.stateDigest === undefined ? {} : { stateDigest: options.stateDigest }),
    ...(repair ? { repair: true } : {}),
  };
}
