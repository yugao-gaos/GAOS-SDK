import {
  assertJsonValue,
  canonicalJson,
  type JsonValue,
} from './protocol.js';

export type RoomEndpointKind =
  | 'participant'
  | 'agent'
  | 'service'
  | 'watcher';

export interface RoomEndpoint {
  kind: RoomEndpointKind;
  id: string;
}

/** Maximum participant-visible scope. Agent/service targets are carried separately. */
export type RoomDisclosure =
  | { kind: 'none' }
  | { kind: 'participants'; participantIds: readonly string[] }
  | { kind: 'room' };

export type RoomInteractionPayload =
  | {
    kind: 'message';
    text: string;
    modality: 'speech' | 'text' | 'generated';
    speak?: boolean;
    interruptible?: boolean;
  }
  | {
    kind: 'event';
    topic: string;
    data?: JsonValue;
    transitionRevision?: number;
  }
  | {
    kind: 'service-request';
    callId: string;
    serviceId: string;
    operation: string;
    input?: JsonValue;
  }
  | {
    kind: 'service-result';
    callId: string;
    serviceId: string;
    ok: boolean;
    output?: JsonValue;
    errorCode?: string;
  };

export interface RoomInteractionCause {
  rootId: string;
  parentId?: string;
  hop: number;
}

export interface RoomInteractionEnvelope<
  TPayload extends RoomInteractionPayload = RoomInteractionPayload,
> {
  id: string;
  roomId: string;
  /** Provider memory must be partitioned by this value. */
  channelId: string;
  source: RoomEndpoint;
  targets: readonly RoomEndpoint[];
  disclosure: RoomDisclosure;
  payload: TPayload;
  cause: RoomInteractionCause;
}

/** Producers return drafts; a router stamps source, identity, and causation. */
export interface RoomInteractionDraft<
  TPayload extends RoomInteractionPayload = RoomInteractionPayload,
> {
  targets: readonly RoomEndpoint[];
  /** Omitted means inherit the parent disclosure. */
  disclosure?: RoomDisclosure;
  payload: TPayload;
}

export type RoomInteractionHandler<TResult = unknown> = (
  envelope: RoomInteractionEnvelope,
  signal?: AbortSignal,
) => TResult | Promise<TResult>;

export interface RoomInteractionDelivery<TResult = unknown> {
  target: RoomEndpoint;
  result: TResult;
}

export interface RoomInteractionDispatch<TResult = unknown> {
  duplicate: boolean;
  deliveries: readonly RoomInteractionDelivery<TResult>[];
}

export interface RoomInteractionRouterOptions {
  createId(): string;
  maxHops?: number;
}

function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
}

function assertEndpoint(endpoint: RoomEndpoint): void {
  if (endpoint === null || typeof endpoint !== 'object') {
    throw new TypeError('room endpoint must be an object');
  }
  if (!['participant', 'agent', 'service', 'watcher'].includes(endpoint.kind)) {
    throw new TypeError('room endpoint kind is unsupported');
  }
  assertText(endpoint.id, 'room endpoint id');
}

export function roomEndpointKey(endpoint: RoomEndpoint): string {
  assertEndpoint(endpoint);
  return `${endpoint.kind}:${JSON.stringify(endpoint.id)}`;
}

function participantSet(disclosure: RoomDisclosure): Set<string> | undefined {
  return disclosure.kind === 'participants'
    ? new Set(disclosure.participantIds)
    : undefined;
}

function assertDisclosure(disclosure: RoomDisclosure): void {
  if (disclosure === null || typeof disclosure !== 'object') {
    throw new TypeError('room disclosure must be an object');
  }
  if (disclosure.kind === 'none' || disclosure.kind === 'room') return;
  if (disclosure.kind !== 'participants'
    || !Array.isArray(disclosure.participantIds)
    || disclosure.participantIds.length === 0) {
    throw new TypeError('participant disclosure requires participant ids');
  }
  const ids = new Set<string>();
  for (const id of disclosure.participantIds) {
    assertText(id, 'disclosed participant id');
    if (ids.has(id)) throw new TypeError(`duplicate disclosed participant: ${id}`);
    ids.add(id);
  }
}

/** Intersection used to prevent replies, services, and watchers widening visibility. */
export function intersectRoomDisclosures(
  parent: RoomDisclosure,
  requested: RoomDisclosure,
): RoomDisclosure {
  assertDisclosure(parent);
  assertDisclosure(requested);
  if (parent.kind === 'none' || requested.kind === 'none') return { kind: 'none' };
  if (parent.kind === 'room') {
    return requested.kind === 'participants'
      ? { kind: 'participants', participantIds: [...requested.participantIds] }
      : { kind: 'room' };
  }
  if (requested.kind === 'room') {
    return { kind: 'participants', participantIds: [...parent.participantIds] };
  }
  const requestedIds = participantSet(requested)!;
  const participantIds = parent.participantIds.filter((id) => requestedIds.has(id));
  return participantIds.length === 0
    ? { kind: 'none' }
    : { kind: 'participants', participantIds };
}

function assertPayload(payload: RoomInteractionPayload): void {
  if (payload === null || typeof payload !== 'object') {
    throw new TypeError('room interaction payload must be an object');
  }
  switch (payload.kind) {
    case 'message':
      assertText(payload.text, 'room message text');
      if (!['speech', 'text', 'generated'].includes(payload.modality)) {
        throw new TypeError('room message modality is unsupported');
      }
      if (payload.speak !== undefined && typeof payload.speak !== 'boolean') {
        throw new TypeError('room message speak must be boolean');
      }
      if (payload.interruptible !== undefined
        && typeof payload.interruptible !== 'boolean') {
        throw new TypeError('room message interruptible must be boolean');
      }
      return;
    case 'event':
      assertText(payload.topic, 'room event topic');
      if (payload.data !== undefined) {
        assertJsonValue(payload.data, 'room event data');
      }
      if (payload.transitionRevision !== undefined
        && (!Number.isSafeInteger(payload.transitionRevision)
          || payload.transitionRevision < 0)) {
        throw new RangeError('room event transitionRevision must be non-negative');
      }
      return;
    case 'service-request':
      assertText(payload.callId, 'room service call id');
      assertText(payload.serviceId, 'room service id');
      assertText(payload.operation, 'room service operation');
      if (payload.input !== undefined) {
        assertJsonValue(payload.input, 'room service input');
      }
      return;
    case 'service-result':
      assertText(payload.callId, 'room service call id');
      assertText(payload.serviceId, 'room service id');
      if (typeof payload.ok !== 'boolean') {
        throw new TypeError('room service result ok must be boolean');
      }
      if (payload.errorCode !== undefined) {
        assertText(payload.errorCode, 'room service error code');
      }
      if (payload.output !== undefined) {
        assertJsonValue(payload.output, 'room service output');
      }
      return;
    default:
      throw new TypeError('room interaction payload kind is unsupported');
  }
}

function assertTargets(targets: readonly RoomEndpoint[]): void {
  if (!Array.isArray(targets) || targets.length === 0) {
    throw new TypeError('room interaction requires explicit targets');
  }
  const keys = new Set<string>();
  for (const target of targets) {
    const key = roomEndpointKey(target);
    if (keys.has(key)) throw new TypeError(`duplicate room interaction target: ${key}`);
    keys.add(key);
  }
}

function sameEndpoint(left: RoomEndpoint, right: RoomEndpoint): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function assertParticipantTargetsDisclosed(
  targets: readonly RoomEndpoint[],
  disclosure: RoomDisclosure,
): void {
  if (disclosure.kind === 'room') return;
  const disclosed = disclosure.kind === 'participants'
    ? new Set(disclosure.participantIds)
    : new Set<string>();
  for (const target of targets) {
    if (target.kind === 'participant' && !disclosed.has(target.id)) {
      throw new Error(`room interaction target is not disclosed: participant:${target.id}`);
    }
  }
}

function assertEnvelope(envelope: RoomInteractionEnvelope): void {
  if (envelope === null || typeof envelope !== 'object') {
    throw new TypeError('room interaction envelope must be an object');
  }
  assertText(envelope.id, 'room interaction id');
  assertText(envelope.roomId, 'room interaction roomId');
  assertText(envelope.channelId, 'room interaction channelId');
  assertEndpoint(envelope.source);
  assertTargets(envelope.targets);
  assertDisclosure(envelope.disclosure);
  assertParticipantTargetsDisclosed(envelope.targets, envelope.disclosure);
  assertPayload(envelope.payload);
  if (envelope.cause === null || typeof envelope.cause !== 'object') {
    throw new TypeError('room interaction cause must be an object');
  }
  assertText(envelope.cause.rootId, 'room interaction root id');
  if (envelope.cause.parentId !== undefined) {
    assertText(envelope.cause.parentId, 'room interaction parent id');
  }
  if (!Number.isSafeInteger(envelope.cause.hop) || envelope.cause.hop < 0) {
    throw new RangeError('room interaction hop must be non-negative');
  }
  if (envelope.cause.hop === 0
    && (envelope.cause.rootId !== envelope.id
      || envelope.cause.parentId !== undefined)) {
    throw new Error('root room interaction must identify itself and have no parent');
  }
  if (envelope.cause.hop > 0 && envelope.cause.parentId === undefined) {
    throw new Error('derived room interaction requires a parent id');
  }
}

function assertDraft(draft: RoomInteractionDraft): void {
  if (draft === null || typeof draft !== 'object') {
    throw new TypeError('room interaction draft must be an object');
  }
  assertTargets(draft.targets);
  if (draft.disclosure !== undefined) assertDisclosure(draft.disclosure);
  assertPayload(draft.payload);
}

/** Explicit endpoint router with deduplication, privacy clamping, and hop bounds. */
export class RoomInteractionRouter {
  private readonly handlers = new Map<string, RoomInteractionHandler>();
  private readonly seen = new Set<string>();
  private readonly maxHops: number;
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: RoomInteractionRouterOptions) {
    if (typeof options?.createId !== 'function') {
      throw new TypeError('room interaction router requires createId');
    }
    this.maxHops = options.maxHops ?? 8;
    if (!Number.isSafeInteger(this.maxHops) || this.maxHops < 0) {
      throw new RangeError('room interaction maxHops must be non-negative');
    }
  }

  register(
    endpoint: RoomEndpoint,
    handler: RoomInteractionHandler,
    options: { replace?: boolean } = {},
  ): this {
    const key = roomEndpointKey(endpoint);
    if (typeof handler !== 'function') {
      throw new TypeError('room interaction handler must be a function');
    }
    if (this.handlers.has(key) && !options.replace) {
      throw new Error(`room interaction endpoint is already registered: ${key}`);
    }
    this.handlers.set(key, handler);
    return this;
  }

  unregister(endpoint: RoomEndpoint): boolean {
    return this.handlers.delete(roomEndpointKey(endpoint));
  }

  create(
    roomId: string,
    channelId: string,
    source: RoomEndpoint,
    draft: RoomInteractionDraft,
  ): RoomInteractionEnvelope {
    assertText(roomId, 'room interaction roomId');
    assertText(channelId, 'room interaction channelId');
    assertEndpoint(source);
    assertDraft(draft);
    const id = this.options.createId();
    assertText(id, 'created room interaction id');
    const envelope: RoomInteractionEnvelope = {
      id,
      roomId,
      channelId,
      source: { ...source },
      targets: draft.targets.map((target) => ({ ...target })),
      disclosure: draft.disclosure ?? { kind: 'none' },
      payload: draft.payload,
      cause: { rootId: id, hop: 0 },
    };
    assertEnvelope(envelope);
    return envelope;
  }

  derive(
    parent: RoomInteractionEnvelope,
    source: RoomEndpoint,
    draft: RoomInteractionDraft,
  ): RoomInteractionEnvelope {
    assertEnvelope(parent);
    assertEndpoint(source);
    assertDraft(draft);
    if (!parent.targets.some((target) => sameEndpoint(target, source))) {
      throw new Error('derived room interaction source was not a parent target');
    }
    const hop = parent.cause.hop + 1;
    if (hop > this.maxHops) {
      throw new RangeError(`room interaction exceeded maxHops: ${this.maxHops}`);
    }
    const id = this.options.createId();
    assertText(id, 'created room interaction id');
    const disclosure = intersectRoomDisclosures(
      parent.disclosure,
      draft.disclosure ?? parent.disclosure,
    );
    if (parent.disclosure.kind !== 'room') {
      const existingEndpoints = [parent.source, ...parent.targets];
      for (const target of draft.targets) {
        if ((target.kind === 'agent' || target.kind === 'watcher')
          && !existingEndpoints.some((endpoint) => sameEndpoint(endpoint, target))) {
          throw new Error(`private room interaction cannot add target: ${roomEndpointKey(target)}`);
        }
      }
    }
    const envelope: RoomInteractionEnvelope = {
      id,
      roomId: parent.roomId,
      channelId: parent.channelId,
      source: { ...source },
      targets: draft.targets.map((target) => ({ ...target })),
      disclosure,
      payload: draft.payload,
      cause: {
        rootId: parent.cause.rootId,
        parentId: parent.id,
        hop,
      },
    };
    assertEnvelope(envelope);
    return envelope;
  }

  async dispatch<TResult = unknown>(
    envelope: RoomInteractionEnvelope,
    signal?: AbortSignal,
  ): Promise<RoomInteractionDispatch<TResult>> {
    assertEnvelope(envelope);
    if (envelope.cause.hop > this.maxHops) {
      throw new RangeError(`room interaction exceeded maxHops: ${this.maxHops}`);
    }
    if (this.seen.has(envelope.id)) return { duplicate: true, deliveries: [] };
    const handlers = envelope.targets.map((target) => {
      const key = roomEndpointKey(target);
      const handler = this.handlers.get(key);
      if (handler === undefined) throw new Error(`unknown room interaction target: ${key}`);
      return { target, handler };
    });
    this.seen.add(envelope.id);
    let resolveDelivery!: (value: RoomInteractionDispatch<TResult>) => void;
    let rejectDelivery!: (reason?: unknown) => void;
    const delivery = new Promise<RoomInteractionDispatch<TResult>>((resolve, reject) => {
      resolveDelivery = resolve;
      rejectDelivery = reject;
    });
    this.tail = this.tail.then(async () => {
      try {
        const deliveries: RoomInteractionDelivery<TResult>[] = [];
        for (const { target, handler } of handlers) {
          if (signal?.aborted) break;
          const result = await handler(envelope, signal) as TResult;
          deliveries.push({ target: { ...target }, result });
        }
        resolveDelivery({ duplicate: false, deliveries });
      } catch (error) {
        rejectDelivery(error);
      }
    });
    return await delivery;
  }
}

/** Compatibility adapter for invoking an existing RoomAgentDriver through a routed message. */
export interface RoutedRoomAgentInput {
  id: string;
  speakerId: string;
  speakerKind: RoomEndpointKind;
  text: string;
  modality: 'speech' | 'text';
  addressedAgentIds: readonly string[];
}

export function roomAgentInputFromInteraction(
  envelope: RoomInteractionEnvelope,
): RoutedRoomAgentInput {
  assertEnvelope(envelope);
  const agentIds = envelope.targets
    .filter((target) => target.kind === 'agent')
    .map(({ id }) => id);
  const payload = envelope.payload;
  const text = payload.kind === 'message'
    ? payload.text
    : payload.kind === 'event'
      ? payload.topic
      : `${payload.serviceId}:${payload.kind}`;
  return {
    id: envelope.id,
    speakerId: envelope.source.id,
    speakerKind: envelope.source.kind,
    text,
    modality: payload.kind === 'message' && payload.modality === 'speech'
      ? 'speech'
      : 'text',
    addressedAgentIds: agentIds,
  };
}

export interface RoomAgentServiceResponse {
  ok: boolean;
  output?: JsonValue;
  errorCode?: string;
}

export interface RoomAgentServiceContext {
  roomId: string;
  agent: RoomAgentServiceCaller;
  envelope: RoomInteractionEnvelope<Extract<
    RoomInteractionPayload,
    { kind: 'service-request' }
  >>;
  signal?: AbortSignal;
}

/** Minimum agent identity and capability grant visible to a service. */
export interface RoomAgentServiceCaller {
  id: string;
  serviceIds?: readonly string[];
}

export interface RoomAgentService {
  readonly id: string;
  invoke(
    request: Extract<RoomInteractionPayload, { kind: 'service-request' }>,
    context: RoomAgentServiceContext,
  ): RoomAgentServiceResponse | Promise<RoomAgentServiceResponse>;
}

/** Capability-checked, retry-stable service invocation. Services cannot return game actions. */
export class RoomAgentServiceRegistry {
  private readonly services = new Map<string, RoomAgentService>();
  private readonly calls = new Map<
    string,
    { fingerprint: string; result: Promise<RoomInteractionPayload> }
  >();

  constructor(services: readonly RoomAgentService[] = []) {
    for (const service of services) this.register(service);
  }

  register(service: RoomAgentService, options: { replace?: boolean } = {}): this {
    if (service === null || typeof service !== 'object') {
      throw new TypeError('room agent service must be an object');
    }
    assertText(service.id, 'room agent service id');
    if (typeof service.invoke !== 'function') {
      throw new TypeError('room agent service must define invoke');
    }
    if (this.services.has(service.id) && !options.replace) {
      throw new Error(`room agent service is already registered: ${service.id}`);
    }
    this.services.set(service.id, service);
    return this;
  }

  get(id: string): RoomAgentService | undefined {
    return this.services.get(id);
  }

  unregister(id: string): boolean {
    return this.services.delete(id);
  }

  async invoke(
    agent: RoomAgentServiceCaller,
    envelope: RoomInteractionEnvelope,
    signal?: AbortSignal,
  ): Promise<Extract<RoomInteractionPayload, { kind: 'service-result' }>> {
    assertEnvelope(envelope);
    const request = envelope.payload;
    if (request.kind !== 'service-request') {
      throw new TypeError('room agent service requires a service-request payload');
    }
    if (envelope.source.kind !== 'agent' || envelope.source.id !== agent.id) {
      throw new Error('room agent service request source does not match agent');
    }
    if (!agent.serviceIds?.includes(request.serviceId)) {
      throw new Error(`room agent is not allowed to use service: ${request.serviceId}`);
    }
    if (!envelope.targets.some((target) => (
      target.kind === 'service' && target.id === request.serviceId
    ))) {
      throw new Error('room agent service request does not target its service');
    }
    const service = this.services.get(request.serviceId);
    if (service === undefined) throw new Error(`unknown room agent service: ${request.serviceId}`);
    const fingerprint = canonicalJson({
      serviceId: request.serviceId,
      operation: request.operation,
      ...(request.input === undefined ? {} : { input: request.input }),
    });
    const callKey = canonicalJson([envelope.roomId, agent.id, request.callId]);
    const existing = this.calls.get(callKey);
    if (existing !== undefined) {
      if (existing.fingerprint !== fingerprint) {
        throw new Error(`room agent service call id was reused: ${request.callId}`);
      }
      return await existing.result as Extract<RoomInteractionPayload, { kind: 'service-result' }>;
    }
    const result = Promise.resolve(service.invoke(request, {
      roomId: envelope.roomId,
      agent,
      envelope: envelope as RoomAgentServiceContext['envelope'],
      signal,
    })).then((response): Extract<RoomInteractionPayload, { kind: 'service-result' }> => {
      if (response === null || typeof response !== 'object') {
        throw new TypeError('room agent service response must be an object');
      }
      const payload: Extract<RoomInteractionPayload, { kind: 'service-result' }> = {
        kind: 'service-result',
        callId: request.callId,
        serviceId: request.serviceId,
        ok: response.ok,
        ...(response.output === undefined ? {} : { output: response.output }),
        ...(response.errorCode === undefined ? {} : { errorCode: response.errorCode }),
      };
      assertPayload(payload);
      return payload;
    });
    this.calls.set(callKey, { fingerprint, result });
    return await result as Extract<RoomInteractionPayload, { kind: 'service-result' }>;
  }
}

export interface RoomCommittedInteractionContext<TObservation = unknown> {
  roomId: string;
  observation: TObservation;
  tick: number;
  transitionRevision: number;
  cause?: RoomInteractionEnvelope;
}

export interface RoomInteractionWatcher<TObservation = unknown> {
  readonly id: string;
  onCommitted(
    context: RoomCommittedInteractionContext<TObservation>,
  ): readonly RoomInteractionDraft[] | Promise<readonly RoomInteractionDraft[]>;
}

export interface RoomWatcherEmission {
  watcherId: string;
  drafts: readonly RoomInteractionDraft[];
}

/** Watchers run once per committed room revision and only see the supplied projection. */
export class RoomInteractionWatcherRegistry<TObservation = unknown> {
  private readonly watchers = new Map<string, RoomInteractionWatcher<TObservation>>();
  private readonly seen = new Set<string>();

  constructor(watchers: readonly RoomInteractionWatcher<TObservation>[] = []) {
    for (const watcher of watchers) this.register(watcher);
  }

  register(
    watcher: RoomInteractionWatcher<TObservation>,
    options: { replace?: boolean } = {},
  ): this {
    if (watcher === null || typeof watcher !== 'object') {
      throw new TypeError('room interaction watcher must be an object');
    }
    assertText(watcher.id, 'room interaction watcher id');
    if (typeof watcher.onCommitted !== 'function') {
      throw new TypeError('room interaction watcher must define onCommitted');
    }
    if (this.watchers.has(watcher.id) && !options.replace) {
      throw new Error(`room interaction watcher is already registered: ${watcher.id}`);
    }
    this.watchers.set(watcher.id, watcher);
    return this;
  }

  get(id: string): RoomInteractionWatcher<TObservation> | undefined {
    return this.watchers.get(id);
  }

  unregister(id: string): boolean {
    return this.watchers.delete(id);
  }

  async raiseCommitted(
    context: RoomCommittedInteractionContext<TObservation>,
  ): Promise<readonly RoomWatcherEmission[]> {
    assertText(context.roomId, 'watcher roomId');
    if (!Number.isSafeInteger(context.tick) || context.tick < 0
      || !Number.isSafeInteger(context.transitionRevision)
      || context.transitionRevision < 0) {
      throw new RangeError('watcher tick and transitionRevision must be non-negative');
    }
    const emissions: RoomWatcherEmission[] = [];
    const completedKeys: string[] = [];
    for (const watcher of this.watchers.values()) {
      const key = `${JSON.stringify([watcher.id, context.roomId, context.transitionRevision])}`;
      if (this.seen.has(key)) continue;
      const drafts = await watcher.onCommitted(context);
      if (!Array.isArray(drafts)) {
        throw new TypeError('room interaction watcher must return an array');
      }
      for (const draft of drafts) assertDraft(draft);
      emissions.push({ watcherId: watcher.id, drafts: [...drafts] });
      completedKeys.push(key);
    }
    for (const key of completedKeys) this.seen.add(key);
    return emissions;
  }
}

export interface RoomVoteOption {
  id: string;
  label: string;
}

export interface RoomVoteDefinition {
  id: string;
  prompt: string;
  options: readonly RoomVoteOption[];
  eligibleParticipantIds: readonly string[];
  /** Contains every option exactly once; first matching tied option wins. */
  tieBreakOrder: readonly string[];
  ballotVisibility: 'public' | 'secret';
}

export interface RoomVoteCast {
  voteId: string;
  participantId: string;
  optionId: string;
}

export interface RoomVoteResult {
  voteId: string;
  counts: readonly { optionId: string; count: number }[];
  totalBallots: number;
  winnerOptionId?: string;
  tiedOptionIds: readonly string[];
}

/** Pure host-poll tally. Gameplay-authoritative votes belong in the product reducer. */
export function resolveRoomVote(
  definition: RoomVoteDefinition,
  casts: readonly RoomVoteCast[],
): RoomVoteResult {
  assertText(definition.id, 'room vote id');
  assertText(definition.prompt, 'room vote prompt');
  if (!Array.isArray(definition.options) || definition.options.length < 2) {
    throw new TypeError('room vote requires at least two options');
  }
  const optionIds = new Set<string>();
  for (const option of definition.options) {
    assertText(option.id, 'room vote option id');
    assertText(option.label, 'room vote option label');
    if (optionIds.has(option.id)) throw new TypeError(`duplicate room vote option: ${option.id}`);
    optionIds.add(option.id);
  }
  if (!Array.isArray(definition.eligibleParticipantIds)
    || definition.eligibleParticipantIds.length === 0) {
    throw new TypeError('room vote requires eligible participants');
  }
  const eligible = new Set<string>();
  for (const id of definition.eligibleParticipantIds) {
    assertText(id, 'eligible room vote participant id');
    if (eligible.has(id)) throw new TypeError(`duplicate eligible participant: ${id}`);
    eligible.add(id);
  }
  if (!Array.isArray(definition.tieBreakOrder)
    || definition.tieBreakOrder.length !== optionIds.size
    || new Set(definition.tieBreakOrder).size !== optionIds.size
    || definition.tieBreakOrder.some((id) => !optionIds.has(id))) {
    throw new TypeError('room vote tieBreakOrder must contain every option once');
  }
  if (definition.ballotVisibility !== 'public'
    && definition.ballotVisibility !== 'secret') {
    throw new TypeError('room vote ballotVisibility is unsupported');
  }
  if (!Array.isArray(casts)) throw new TypeError('room vote casts must be an array');
  const voters = new Set<string>();
  const counts = new Map(definition.options.map(({ id }) => [id, 0]));
  for (const cast of casts) {
    if (cast.voteId !== definition.id) throw new Error('room vote cast references another vote');
    if (!eligible.has(cast.participantId)) {
      throw new Error(`room vote participant is not eligible: ${cast.participantId}`);
    }
    if (voters.has(cast.participantId)) {
      throw new Error(`duplicate room vote cast: ${cast.participantId}`);
    }
    if (!optionIds.has(cast.optionId)) {
      throw new Error(`unknown room vote option: ${cast.optionId}`);
    }
    voters.add(cast.participantId);
    counts.set(cast.optionId, counts.get(cast.optionId)! + 1);
  }
  const orderedCounts = definition.options.map(({ id }) => ({
    optionId: id,
    count: counts.get(id)!,
  }));
  if (casts.length === 0) {
    return {
      voteId: definition.id,
      counts: orderedCounts,
      totalBallots: 0,
      tiedOptionIds: [],
    };
  }
  const highest = Math.max(...orderedCounts.map(({ count }) => count));
  const tiedOptionIds = orderedCounts
    .filter(({ count }) => count === highest)
    .map(({ optionId }) => optionId);
  const tied = new Set(tiedOptionIds);
  const winnerOptionId = definition.tieBreakOrder.find((id) => tied.has(id))!;
  return {
    voteId: definition.id,
    counts: orderedCounts,
    totalBallots: casts.length,
    winnerOptionId,
    tiedOptionIds,
  };
}
