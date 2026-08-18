import {
  controlSubjectKey,
  type ControlSubject,
} from './control.js';
import type { SubmittedAction } from './engine/contracts.js';

export type RoomParticipantRole =
  | 'player'
  | 'spectator'
  | 'moderator'
  | 'service';

/** Host-authenticated room presence. Role and seat are descriptive, not authority. */
export interface RoomParticipant {
  id: string;
  role: RoomParticipantRole;
  displayName?: string;
  seat?: string;
}

/** Final text input after a host-owned text or speech pipeline. */
export interface RoomAgentInput {
  id: string;
  speakerId: string;
  text: string;
  modality: 'speech' | 'text';
  /** Explicit host routing hint. The SDK does not infer mentions or wake policy. */
  addressedAgentIds?: readonly string[];
}

export interface GameAgentRule {
  id: string;
  title: string;
  body: string;
}

/** Versioned, product-owned material that makes game rules explainable. */
export interface GameAgentManifest<TKnowledge = unknown> {
  gameId: string;
  gameVersion: string;
  rules: readonly GameAgentRule[];
  glossary?: Readonly<Record<string, string>>;
  knowledge?: TKnowledge;
}

export type RoomAgentRole =
  | 'guide'
  | 'character'
  | 'referee'
  | 'custom';

export interface RoomAgentVoice {
  /** Provider-neutral voice identity resolved by the host runtime. */
  id: string;
  language?: string;
}

export interface RoomAgentDescriptor {
  id: string;
  label: string;
  role: RoomAgentRole;
  description?: string;
  voice?: RoomAgentVoice;
  /** Host-enforced visibility for this presence. Defaults to the room. */
  visibility?: RoomAgentAudience;
  /**
   * Optional gameplay identity. Without this binding the agent is speech-only.
   * The binding grants no authority by itself; ordinary host admission still applies.
   */
  controlSubject?: ControlSubject;
}

export type RoomAgentAudience =
  | { kind: 'room' }
  | { kind: 'participants'; participantIds: readonly string[] };

/** Text that a host may caption and synthesize through its own TTS provider. */
export interface RoomAgentUtterance {
  text: string;
  audience?: RoomAgentAudience;
  interruptible?: boolean;
}

export interface RoomAgentDecision {
  utterances?: readonly RoomAgentUtterance[];
  /** At most one canonical proposal, matching the existing ControlSource cadence. */
  action?: SubmittedAction;
}

export interface RoomAgentContext<TObservation = unknown, TKnowledge = unknown> {
  roomId: string;
  agent: RoomAgentDescriptor;
  input: RoomAgentInput;
  participants: readonly RoomParticipant[];
  /** A host-supplied public, seat, or product projection; never implied full state. */
  observation: TObservation;
  manifest: GameAgentManifest<TKnowledge>;
  legalActions: readonly SubmittedAction[];
  systemActions?: readonly SubmittedAction[];
  tick: number;
  transitionRevision?: number;
  signal?: AbortSignal;
}

export interface RoomAgentDriver<TObservation = unknown, TKnowledge = unknown> {
  reset?(): void | Promise<void>;
  respond(
    context: RoomAgentContext<TObservation, TKnowledge>,
  ): RoomAgentDecision | null | Promise<RoomAgentDecision | null>;
}

export interface RoomAgentRegistration<TObservation = unknown, TKnowledge = unknown> {
  descriptor: RoomAgentDescriptor;
  driver: RoomAgentDriver<TObservation, TKnowledge>;
}

export interface RoomAgentActionProposal {
  subject: ControlSubject;
  action: SubmittedAction;
}

export interface RoomAgentTurn {
  agentId: string;
  utterances: readonly RoomAgentUtterance[];
  /** The host must submit this through ordinary GAOS validation and authority checks. */
  action?: RoomAgentActionProposal;
}

const PARTICIPANT_ROLES: readonly RoomParticipantRole[] = [
  'player',
  'spectator',
  'moderator',
  'service',
];
const AGENT_ROLES: readonly RoomAgentRole[] = [
  'guide',
  'character',
  'referee',
  'custom',
];

function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
}

function assertDescriptor(descriptor: RoomAgentDescriptor): void {
  if (descriptor === null || typeof descriptor !== 'object') {
    throw new TypeError('room agent descriptor must be an object');
  }
  assertText(descriptor.id, 'room agent id');
  assertText(descriptor.label, 'room agent label');
  if (!AGENT_ROLES.includes(descriptor.role)) {
    throw new TypeError('room agent role is unsupported');
  }
  if (descriptor.voice !== undefined) {
    assertText(descriptor.voice.id, 'room agent voice id');
    if (descriptor.voice.language !== undefined) {
      assertText(descriptor.voice.language, 'room agent voice language');
    }
  }
  if (descriptor.visibility?.kind === 'participants') {
    if (!Array.isArray(descriptor.visibility.participantIds)
      || descriptor.visibility.participantIds.length === 0) {
      throw new TypeError('room agent visibility requires participant ids');
    }
    for (const participantId of descriptor.visibility.participantIds) {
      assertText(participantId, 'room agent visibility participant id');
    }
  } else if (descriptor.visibility !== undefined
    && descriptor.visibility.kind !== 'room') {
    throw new TypeError('room agent visibility is unsupported');
  }
  if (descriptor.controlSubject !== undefined) {
    controlSubjectKey(descriptor.controlSubject);
  }
}

function copyDescriptor(descriptor: RoomAgentDescriptor): RoomAgentDescriptor {
  return {
    ...descriptor,
    ...(descriptor.voice === undefined ? {} : { voice: { ...descriptor.voice } }),
    ...(descriptor.visibility === undefined
      ? {}
      : {
        visibility: descriptor.visibility.kind === 'room'
          ? { kind: 'room' }
          : {
            kind: 'participants',
            participantIds: [...descriptor.visibility.participantIds],
          },
      }),
    ...(descriptor.controlSubject === undefined
      ? {}
      : { controlSubject: { ...descriptor.controlSubject } }),
  };
}

function assertParticipants(
  participants: readonly RoomParticipant[],
  speakerId: string,
): void {
  if (!Array.isArray(participants)) {
    throw new TypeError('room participants must be an array');
  }
  const ids = new Set<string>();
  for (const participant of participants) {
    if (participant === null || typeof participant !== 'object') {
      throw new TypeError('room participant must be an object');
    }
    assertText(participant.id, 'room participant id');
    if (ids.has(participant.id)) {
      throw new TypeError(`duplicate room participant: ${participant.id}`);
    }
    ids.add(participant.id);
    if (!PARTICIPANT_ROLES.includes(participant.role)) {
      throw new TypeError('room participant role is unsupported');
    }
    if (participant.seat !== undefined) {
      assertText(participant.seat, 'room participant seat');
    }
  }
  if (!ids.has(speakerId)) {
    throw new Error(`room input speaker is not present: ${speakerId}`);
  }
}

function assertManifest(manifest: GameAgentManifest<unknown>): void {
  if (manifest === null || typeof manifest !== 'object') {
    throw new TypeError('game agent manifest must be an object');
  }
  assertText(manifest.gameId, 'game agent manifest gameId');
  assertText(manifest.gameVersion, 'game agent manifest gameVersion');
  if (!Array.isArray(manifest.rules)) {
    throw new TypeError('game agent manifest rules must be an array');
  }
  const ids = new Set<string>();
  for (const rule of manifest.rules) {
    if (rule === null || typeof rule !== 'object') {
      throw new TypeError('game agent rule must be an object');
    }
    assertText(rule.id, 'game agent rule id');
    if (ids.has(rule.id)) throw new TypeError(`duplicate game agent rule: ${rule.id}`);
    ids.add(rule.id);
    assertText(rule.title, 'game agent rule title');
    assertText(rule.body, 'game agent rule body');
  }
}

function assertContext<TObservation, TKnowledge>(
  context: Omit<RoomAgentContext<TObservation, TKnowledge>, 'agent'>,
): void {
  if (context === null || typeof context !== 'object') {
    throw new TypeError('room agent context must be an object');
  }
  assertText(context.roomId, 'room id');
  if (context.input === null || typeof context.input !== 'object') {
    throw new TypeError('room agent input must be an object');
  }
  assertText(context.input.id, 'room input id');
  assertText(context.input.speakerId, 'room input speakerId');
  assertText(context.input.text, 'room input text');
  if (context.input.modality !== 'speech' && context.input.modality !== 'text') {
    throw new TypeError('room input modality must be speech or text');
  }
  if (context.input.addressedAgentIds !== undefined) {
    if (!Array.isArray(context.input.addressedAgentIds)) {
      throw new TypeError('addressedAgentIds must be an array when present');
    }
    const ids = new Set<string>();
    for (const id of context.input.addressedAgentIds) {
      assertText(id, 'addressed room agent id');
      if (ids.has(id)) throw new TypeError(`duplicate addressed room agent: ${id}`);
      ids.add(id);
    }
  }
  assertParticipants(context.participants, context.input.speakerId);
  assertManifest(context.manifest);
  if (!Array.isArray(context.legalActions)) {
    throw new TypeError('room agent legalActions must be an array');
  }
  if (context.systemActions !== undefined && !Array.isArray(context.systemActions)) {
    throw new TypeError('room agent systemActions must be an array when present');
  }
  if (!Number.isSafeInteger(context.tick) || context.tick < 0) {
    throw new RangeError('room agent tick must be a non-negative safe integer');
  }
  if (context.transitionRevision !== undefined
    && (!Number.isSafeInteger(context.transitionRevision) || context.transitionRevision < 0)) {
    throw new RangeError('room agent transitionRevision must be non-negative when present');
  }
}

function normalizeDecision(
  descriptor: RoomAgentDescriptor,
  decision: RoomAgentDecision,
): RoomAgentTurn {
  if (decision === null || typeof decision !== 'object') {
    throw new TypeError('room agent decision must be an object or null');
  }
  const utterances = decision.utterances ?? [];
  if (!Array.isArray(utterances)) {
    throw new TypeError('room agent utterances must be an array when present');
  }
  for (const utterance of utterances) {
    if (utterance === null || typeof utterance !== 'object') {
      throw new TypeError('room agent utterance must be an object');
    }
    assertText(utterance.text, 'room agent utterance text');
    if (utterance.audience?.kind === 'participants') {
      if (!Array.isArray(utterance.audience.participantIds)
        || utterance.audience.participantIds.length === 0) {
        throw new TypeError('targeted room agent utterance requires participant ids');
      }
      for (const participantId of utterance.audience.participantIds) {
        assertText(participantId, 'room agent utterance participant id');
      }
    } else if (utterance.audience !== undefined
      && utterance.audience.kind !== 'room') {
      throw new TypeError('room agent utterance audience is unsupported');
    }
  }
  if (decision.action === undefined) {
    if (utterances.length === 0) {
      throw new TypeError('room agent decision must contain an utterance or action');
    }
    return { agentId: descriptor.id, utterances: [...utterances] };
  }
  if (decision.action === null
    || typeof decision.action !== 'object'
    || typeof decision.action.id !== 'string'
    || decision.action.id.length === 0) {
    throw new TypeError('room agent action requires a non-empty id');
  }
  const subject = descriptor.controlSubject;
  if (subject === undefined) {
    throw new Error(`speech-only room agent cannot propose an action: ${descriptor.id}`);
  }
  const authoritySeat = subject.seat;
  if (decision.action.seat !== undefined
    && decision.action.seat !== authoritySeat) {
    throw new Error(`room agent action seat does not match its control binding: ${descriptor.id}`);
  }
  return {
    agentId: descriptor.id,
    utterances: [...utterances],
    action: { subject: { ...subject }, action: decision.action },
  };
}

interface ActiveRegistration<TObservation, TKnowledge>
  extends RoomAgentRegistration<TObservation, TKnowledge> {
  active: Set<AbortController>;
}

function linkedAbortController(signal: AbortSignal | undefined): {
  controller: AbortController;
  dispose(): void;
} {
  const controller = new AbortController();
  if (signal === undefined) return { controller, dispose() {} };
  const forward = () => controller.abort(signal.reason);
  if (signal.aborted) {
    forward();
    return { controller, dispose() {} };
  }
  signal.addEventListener('abort', forward, { once: true });
  return {
    controller,
    dispose: () => signal.removeEventListener('abort', forward),
  };
}

/** Host-side room-agent registry. It never submits or commits game actions. */
export class RoomAgentRegistry<TObservation = unknown, TKnowledge = unknown> {
  private readonly registrations = new Map<
    string,
    ActiveRegistration<TObservation, TKnowledge>
  >();

  constructor(
    registrations: readonly RoomAgentRegistration<TObservation, TKnowledge>[] = [],
  ) {
    for (const registration of registrations) this.register(registration);
  }

  register(
    registration: RoomAgentRegistration<TObservation, TKnowledge>,
    options: { replace?: boolean } = {},
  ): this {
    if (registration === null || typeof registration !== 'object') {
      throw new TypeError('room agent registration must be an object');
    }
    assertDescriptor(registration.descriptor);
    if (registration.driver === null
      || typeof registration.driver !== 'object'
      || typeof registration.driver.respond !== 'function') {
      throw new TypeError('room agent driver must define respond');
    }
    const id = registration.descriptor.id;
    const current = this.registrations.get(id);
    if (current !== undefined && !options.replace) {
      throw new Error(`room agent is already registered: ${id}`);
    }
    if (current !== undefined) this.abort(current);
    this.registrations.set(id, {
      descriptor: copyDescriptor(registration.descriptor),
      driver: registration.driver,
      active: new Set(),
    });
    return this;
  }

  unregister(id: string): boolean {
    const registration = this.registrations.get(id);
    if (registration === undefined) return false;
    this.abort(registration);
    this.registrations.delete(id);
    return true;
  }

  get(id: string): RoomAgentRegistration<TObservation, TKnowledge> | undefined {
    const registration = this.registrations.get(id);
    return registration === undefined
      ? undefined
      : { descriptor: copyDescriptor(registration.descriptor), driver: registration.driver };
  }

  require(id: string): RoomAgentRegistration<TObservation, TKnowledge> {
    const registration = this.get(id);
    if (registration === undefined) throw new Error(`unknown room agent: ${id}`);
    return registration;
  }

  list(): RoomAgentDescriptor[] {
    return [...this.registrations.values()].map(({ descriptor }) => copyDescriptor(descriptor));
  }

  async respond(
    id: string,
    context: Omit<RoomAgentContext<TObservation, TKnowledge>, 'agent'>,
  ): Promise<RoomAgentTurn | null> {
    assertContext(context);
    const registration = this.registrations.get(id);
    if (registration === undefined) throw new Error(`unknown room agent: ${id}`);
    const linked = linkedAbortController(context.signal);
    registration.active.add(linked.controller);
    try {
      if (linked.controller.signal.aborted) return null;
      let decision: RoomAgentDecision | null;
      try {
        decision = await registration.driver.respond({
          ...context,
          agent: copyDescriptor(registration.descriptor),
          signal: linked.controller.signal,
        });
      } catch (error) {
        if (linked.controller.signal.aborted
          || this.registrations.get(id) !== registration) {
          return null;
        }
        throw error;
      }
      if (linked.controller.signal.aborted
        || this.registrations.get(id) !== registration
        || decision === null) {
        return null;
      }
      return normalizeDecision(registration.descriptor, decision);
    } finally {
      registration.active.delete(linked.controller);
      linked.dispose();
    }
  }

  private abort(registration: ActiveRegistration<TObservation, TKnowledge>): void {
    for (const controller of registration.active) {
      controller.abort(new Error('room agent registration changed'));
    }
    registration.active.clear();
  }
}
