import type { AgentDriver } from './agent/driver.js';
import {
  evaluateBehaviorTree,
  type BehaviorTreeAdapter,
} from './engine/behavior-tree.js';
import type { SubmittedAction } from './engine/contracts.js';

export type ControlSourceKind =
  | 'behavior-tree'
  | 'human-input'
  | 'agent-input';

export type ControlSubject =
  | {
    kind: 'actor';
    actorId: string;
    /** Logical seat whose authority admits this actor-scoped action. */
    seat?: string;
  }
  | {
    kind: 'seat';
    seat: string;
  };

export interface ControlContext<TObservation = unknown> {
  subject: ControlSubject;
  observation: TObservation;
  legalActions: readonly SubmittedAction[];
  systemActions?: readonly SubmittedAction[];
  tick: number;
  signal?: AbortSignal;
}

export interface ControlDecision {
  action: SubmittedAction;
}

export interface ControlSource<TObservation = unknown> {
  readonly id: string;
  readonly kind: ControlSourceKind;
  reset?(): void | Promise<void>;
  decide(
    context: ControlContext<TObservation>,
  ): ControlDecision | null | Promise<ControlDecision | null>;
}

export type HumanInputHandler<TObservation> = (
  context: ControlContext<TObservation>,
) => SubmittedAction | null | Promise<SubmittedAction | null>;

const CONTROL_SOURCE_KINDS: readonly ControlSourceKind[] = [
  'behavior-tree',
  'human-input',
  'agent-input',
];

function assertSourceId(id: string): void {
  if (typeof id !== 'string' || id.trim().length === 0) {
    throw new TypeError('control source id must not be empty');
  }
}

function assertSubject(subject: ControlSubject): void {
  if (subject === null || typeof subject !== 'object') {
    throw new TypeError('control subject must be an actor or seat');
  }
  if (subject.kind === 'actor') {
    if (typeof subject.actorId !== 'string' || subject.actorId.length === 0) {
      throw new TypeError('actor control subject requires a non-empty actorId');
    }
    if (subject.seat !== undefined
      && (typeof subject.seat !== 'string' || subject.seat.length === 0)) {
      throw new TypeError('actor control subject seat must be non-empty when present');
    }
    return;
  }
  if (subject.kind === 'seat') {
    if (typeof subject.seat !== 'string' || subject.seat.length === 0) {
      throw new TypeError('seat control subject requires a non-empty seat');
    }
    return;
  }
  throw new TypeError('control subject kind must be actor or seat');
}

function assertSource<TObservation>(
  source: ControlSource<TObservation>,
): void {
  if (source === null || typeof source !== 'object') {
    throw new TypeError('control source must be an object');
  }
  assertSourceId(source.id);
  if (!CONTROL_SOURCE_KINDS.includes(source.kind)) {
    throw new TypeError('control source kind is unsupported');
  }
  if (typeof source.decide !== 'function') {
    throw new TypeError('control source decide must be a function');
  }
}

function assertContext<TObservation>(
  context: ControlContext<TObservation>,
): void {
  assertSubject(context.subject);
  if (!Array.isArray(context.legalActions)) {
    throw new TypeError('control context legalActions must be an array');
  }
  if (context.systemActions !== undefined && !Array.isArray(context.systemActions)) {
    throw new TypeError('control context systemActions must be an array when present');
  }
  if (!Number.isSafeInteger(context.tick) || context.tick < 0) {
    throw new RangeError('control context tick must be a non-negative safe integer');
  }
}

function assertDecision(decision: ControlDecision): void {
  if (decision === null
    || typeof decision !== 'object'
    || decision.action === null
    || typeof decision.action !== 'object'
    || typeof decision.action.id !== 'string'
    || decision.action.id.length === 0) {
    throw new TypeError('control source decision requires an action with a non-empty id');
  }
}

/**
 * Stable key for a control subject. Actor and seat namespaces never collide.
 */
export function controlSubjectKey(subject: ControlSubject): string {
  assertSubject(subject);
  return subject.kind === 'seat'
    ? `seat:${JSON.stringify(subject.seat)}`
    : `actor:${JSON.stringify([subject.actorId, subject.seat ?? null])}`;
}

/**
 * Adapt one product-owned behavior tree to the common control-source boundary.
 */
export function fromBehaviorTree<TObservation, TNode, TCondition>(
  id: string,
  root: TNode,
  adapter: BehaviorTreeAdapter<
    ControlContext<TObservation>,
    TNode,
    TCondition,
    SubmittedAction
  >,
): ControlSource<TObservation> {
  assertSourceId(id);
  return {
    id,
    kind: 'behavior-tree',
    decide(context) {
      const action = evaluateBehaviorTree(context, root, adapter);
      return action === null ? null : { action };
    },
  };
}

/**
 * Adapt queued UI, device, accessibility, or remote-human input.
 */
export function fromHumanInput<TObservation>(
  id: string,
  next: HumanInputHandler<TObservation>,
): ControlSource<TObservation> {
  assertSourceId(id);
  if (typeof next !== 'function') {
    throw new TypeError('human input handler must be a function');
  }
  return {
    id,
    kind: 'human-input',
    async decide(context) {
      const action = await next(context);
      return action === null ? null : { action };
    },
  };
}

/**
 * Adapt an existing provider-neutral agent driver.
 */
export function fromAgentDriver<TObservation>(
  driver: AgentDriver<TObservation>,
): ControlSource<TObservation> {
  assertSourceId(driver.id);
  return {
    id: driver.id,
    kind: 'agent-input',
    ...(driver.reset === undefined ? {} : { reset: () => driver.reset!() }),
    async decide(context) {
      const decision = await driver.act({
        observation: context.observation,
        legalActions: context.legalActions,
        systemActions: context.systemActions,
        step: context.tick,
        signal: context.signal,
      });
      return { action: decision.action };
    },
  };
}

interface ActiveBinding {
  sourceId: string;
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

/**
 * Host-side source registry and subject binding coordinator.
 *
 * Rebinding or unregistering a source aborts its in-flight decisions. A source
 * that ignores cancellation may still finish, but its stale result is
 * discarded before it crosses this boundary.
 */
export class ControlSourceRegistry<TObservation = unknown> {
  private readonly sources = new Map<string, ControlSource<TObservation>>();
  private readonly bindings = new Map<string, ActiveBinding>();

  constructor(sources: readonly ControlSource<TObservation>[] = []) {
    for (const source of sources) this.register(source);
  }

  register(
    source: ControlSource<TObservation>,
    options: { replace?: boolean } = {},
  ): this {
    assertSource(source);
    if (this.sources.has(source.id) && !options.replace) {
      throw new Error(`control source is already registered: ${source.id}`);
    }
    if (options.replace && this.sources.has(source.id)) {
      this.abortBindingsFor(source.id);
    }
    this.sources.set(source.id, source);
    return this;
  }

  unregister(id: string): boolean {
    if (!this.sources.delete(id)) return false;
    this.removeBindingsFor(id);
    return true;
  }

  get(id: string): ControlSource<TObservation> | undefined {
    return this.sources.get(id);
  }

  require(id: string): ControlSource<TObservation> {
    const source = this.get(id);
    if (source === undefined) throw new Error(`unknown control source: ${id}`);
    return source;
  }

  list(): ControlSource<TObservation>[] {
    return [...this.sources.values()];
  }

  bind(subject: ControlSubject, sourceId: string): boolean {
    const key = controlSubjectKey(subject);
    this.require(sourceId);
    const previous = this.bindings.get(key);
    if (previous?.sourceId === sourceId) return false;
    if (previous !== undefined) this.abort(previous);
    this.bindings.set(key, { sourceId, active: new Set() });
    return true;
  }

  unbind(subject: ControlSubject): boolean {
    const key = controlSubjectKey(subject);
    const binding = this.bindings.get(key);
    if (binding === undefined) return false;
    this.abort(binding);
    this.bindings.delete(key);
    return true;
  }

  boundSource(subject: ControlSubject): ControlSource<TObservation> | undefined {
    const binding = this.bindings.get(controlSubjectKey(subject));
    return binding === undefined ? undefined : this.sources.get(binding.sourceId);
  }

  async decide(
    context: ControlContext<TObservation>,
  ): Promise<ControlDecision | null> {
    assertContext(context);
    const key = controlSubjectKey(context.subject);
    const binding = this.bindings.get(key);
    if (binding === undefined) {
      throw new Error(`no control source bound for ${key}`);
    }
    const source = this.require(binding.sourceId);
    const linked = linkedAbortController(context.signal);
    binding.active.add(linked.controller);
    try {
      if (linked.controller.signal.aborted) return null;
      let decision: ControlDecision | null;
      try {
        decision = await source.decide({
          ...context,
          signal: linked.controller.signal,
        });
      } catch (error) {
        if (linked.controller.signal.aborted || this.bindings.get(key) !== binding) {
          return null;
        }
        throw error;
      }
      if (linked.controller.signal.aborted || this.bindings.get(key) !== binding) {
        return null;
      }
      if (decision !== null) assertDecision(decision);
      return decision;
    } finally {
      binding.active.delete(linked.controller);
      linked.dispose();
    }
  }

  private abort(binding: ActiveBinding): void {
    for (const controller of binding.active) {
      controller.abort(new Error('control source binding changed'));
    }
    binding.active.clear();
  }

  private abortBindingsFor(sourceId: string): void {
    for (const binding of this.bindings.values()) {
      if (binding.sourceId === sourceId) this.abort(binding);
    }
  }

  private removeBindingsFor(sourceId: string): void {
    for (const [key, binding] of this.bindings) {
      if (binding.sourceId !== sourceId) continue;
      this.abort(binding);
      this.bindings.delete(key);
    }
  }
}
