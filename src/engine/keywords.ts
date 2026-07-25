export type KeywordKind = 'static' | 'triggered' | 'activated';

export interface KeywordDefinition<TContext, TEffect> {
  id: string;
  kind: KeywordKind;
  /** Lower layers resolve first. */
  layer: number;
  resolve(context: TContext): TEffect | null;
}

export interface ActiveKeyword {
  id: string;
  /** Product-owned acquisition tick. Lower values resolve first. */
  acquiredAt: number;
  /** Stable source identity for duplicate keyword instances. */
  sourceId?: string;
}

export interface ResolvedKeyword<TEffect> {
  keywordId: string;
  kind: KeywordKind;
  layer: number;
  registrationOrder: number;
  acquiredAt: number;
  sourceId?: string;
  effect: TEffect;
}

interface RegisteredKeyword<TContext, TEffect> {
  definition: KeywordDefinition<TContext, TEffect>;
  order: number;
}

/**
 * Instance-local product keyword registry. Registration order is part of
 * deterministic layered resolution and never depends on object-key order.
 */
export class KeywordRegistry<TContext, TEffect> {
  private readonly definitions = new Map<string, RegisteredKeyword<TContext, TEffect>>();
  private nextOrder = 0;

  constructor(definitions: readonly KeywordDefinition<TContext, TEffect>[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: KeywordDefinition<TContext, TEffect>): void {
    validateDefinition(definition);
    if (this.definitions.has(definition.id)) {
      throw new Error(`keyword already registered: ${definition.id}`);
    }
    this.definitions.set(definition.id, {
      definition,
      order: this.nextOrder++,
    });
  }

  get(id: string): KeywordDefinition<TContext, TEffect> | undefined {
    return this.definitions.get(id)?.definition;
  }

  require(id: string): KeywordDefinition<TContext, TEffect> {
    const definition = this.get(id);
    if (!definition) throw new RangeError(`unknown keyword: ${id}`);
    return definition;
  }

  registrationOrder(id: string): number {
    const registered = this.definitions.get(id);
    if (!registered) throw new RangeError(`unknown keyword: ${id}`);
    return registered.order;
  }

  list(): readonly KeywordDefinition<TContext, TEffect>[] {
    return [...this.definitions.values()]
      .sort((left, right) => left.order - right.order)
      .map(({ definition }) => definition);
  }
}

function validateDefinition<TContext, TEffect>(
  definition: KeywordDefinition<TContext, TEffect>,
): void {
  if (!definition || typeof definition !== 'object') {
    throw new TypeError('keyword definition must be an object');
  }
  if (typeof definition.id !== 'string' || definition.id.length === 0) {
    throw new TypeError('keyword id must be a non-empty string');
  }
  if (!['static', 'triggered', 'activated'].includes(definition.kind)) {
    throw new TypeError(`keyword ${definition.id} kind is invalid`);
  }
  if (!Number.isSafeInteger(definition.layer)) {
    throw new TypeError(`keyword ${definition.id} layer must be a safe integer`);
  }
  if (typeof definition.resolve !== 'function') {
    throw new TypeError(`keyword ${definition.id} resolve must be a function`);
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Resolve active keyword instances by layer, authored registration order,
 * acquisition timestamp, source id, then active-list order.
 */
export function resolveKeywordLayerDetails<TContext, TEffect>(
  context: TContext,
  active: readonly ActiveKeyword[],
  registry: KeywordRegistry<TContext, TEffect>,
): readonly ResolvedKeyword<TEffect>[] {
  if (!Array.isArray(active)) throw new TypeError('active keywords must be an array');
  const ordered = active.map((instance, authoredOrder) => {
    if (!instance || typeof instance.id !== 'string' || instance.id.length === 0) {
      throw new TypeError('active keyword ids must be non-empty strings');
    }
    if (!Number.isSafeInteger(instance.acquiredAt) || instance.acquiredAt < 0) {
      throw new RangeError(`keyword ${instance.id} acquiredAt must be non-negative`);
    }
    if (instance.sourceId !== undefined
      && (typeof instance.sourceId !== 'string' || instance.sourceId.length === 0)) {
      throw new TypeError(`keyword ${instance.id} sourceId must be a non-empty string`);
    }
    const definition = registry.require(instance.id);
    return {
      instance,
      authoredOrder,
      definition,
      registrationOrder: registry.registrationOrder(instance.id),
    };
  }).sort((left, right) => (
    left.definition.layer - right.definition.layer
    || left.registrationOrder - right.registrationOrder
    || left.instance.acquiredAt - right.instance.acquiredAt
    || compareText(left.instance.sourceId ?? '', right.instance.sourceId ?? '')
    || left.authoredOrder - right.authoredOrder
  ));

  const resolved: Array<ResolvedKeyword<TEffect>> = [];
  for (const entry of ordered) {
    const effect = entry.definition.resolve(context);
    if (effect === null) continue;
    resolved.push({
      keywordId: entry.definition.id,
      kind: entry.definition.kind,
      layer: entry.definition.layer,
      registrationOrder: entry.registrationOrder,
      acquiredAt: entry.instance.acquiredAt,
      ...(entry.instance.sourceId ? { sourceId: entry.instance.sourceId } : {}),
      effect,
    });
  }
  return resolved;
}

/** Resolve active keyword instances to effects in their contractual order. */
export function resolveKeywordLayers<TContext, TEffect>(
  context: TContext,
  active: readonly ActiveKeyword[],
  registry: KeywordRegistry<TContext, TEffect>,
): readonly TEffect[] {
  return resolveKeywordLayerDetails(context, active, registry)
    .map(({ effect }) => effect);
}
