import type {
  GridViewNamespace,
  Outcome,
  TickView,
  ZoneViewNamespace,
} from './contracts.js';

export type Visibility =
  | { kind: 'public' }
  | { kind: 'seats'; seats: readonly string[] }
  | { kind: 'hidden' };

export interface ZoneVisibilityPolicy {
  /** Who may see which entries are in the zone. */
  identity(seat: string): Visibility;
  /** Who may see authored/internal order, independently of identity. */
  order(seat: string): Visibility;
}

export interface BoardVisibilityPolicy<TCell> {
  cellVisible(seat: string, cell: TCell): boolean;
  hiddenEntityMode: 'absent' | 'shell';
}

export interface BoardEntityView<TCell> {
  at: TCell;
  id?: string;
  [key: string]: unknown;
}

export interface BoardObservation<TCell, TEntity = BoardEntityView<TCell>>
  extends Omit<GridViewNamespace, 'targetableCells' | 'actionTargeting'> {
  cells?: readonly TCell[];
  entities?: readonly TEntity[];
  targetableCells?: readonly TCell[];
  actionTargeting?: Readonly<Record<string, { targetableCells: readonly TCell[] }>>;
  [key: string]: unknown;
}

export interface InformationPartitionPolicies<
  TCell,
  TEntry = unknown,
  TEntity = BoardEntityView<TCell>,
> {
  zones?: Readonly<Record<string, ZoneVisibilityPolicy>>;
  /** Policy for the single implicit board form of `TickView.grid`. */
  board?: BoardVisibilityPolicy<TCell>;
  /** Policies for the board-id record form of `TickView.grid`. */
  boards?: Readonly<Record<string, BoardVisibilityPolicy<TCell>>>;
  /** Stable identity used to mask hidden order. Defaults to canonical JSON. */
  entryKey?: (entry: TEntry) => string;
  /** Locate an entity for board visibility. Defaults to its `at` field. */
  entityCell?: (entity: TEntity) => TCell;
  /** Construct a presence-only entity. Defaults to `{ at, hidden: true }`. */
  shellEntity?: (entity: TEntity, at: TCell) => TEntity;
}

export interface TeamDefinition {
  id: string;
  seats: readonly string[];
}

export interface TeamRanking {
  teamId: string;
  rank: number;
  score?: number;
}

export type SpectatorVisibilityPolicy =
  | { kind: 'public' }
  | { kind: 'full'; delayTurns?: number };

export interface InformationRevelation<TValue = unknown> {
  type: 'information.revealed';
  id: string;
  visibility: Visibility;
  value: TValue;
}

export function visibilityAllows(visibility: Visibility, seat: string): boolean {
  if (!visibility || typeof visibility !== 'object') {
    throw new TypeError('visibility must be an object');
  }
  switch (visibility.kind) {
    case 'public':
      return true;
    case 'hidden':
      return false;
    case 'seats':
      if (!Array.isArray(visibility.seats)
        || visibility.seats.some((candidate) => typeof candidate !== 'string')) {
        throw new TypeError('seat visibility must contain seat ids');
      }
      return visibility.seats.includes(seat);
    default:
      throw new TypeError('visibility kind must be public, seats, or hidden');
  }
}

function validateTeams(teams: readonly TeamDefinition[]): void {
  if (!Array.isArray(teams)) throw new TypeError('teams must be an array');
  const ids = new Set<string>();
  const seats = new Set<string>();
  for (const team of teams) {
    if (!team || typeof team.id !== 'string' || team.id.length === 0) {
      throw new TypeError('team ids must be non-empty strings');
    }
    if (ids.has(team.id)) throw new TypeError(`duplicate team id: ${team.id}`);
    ids.add(team.id);
    if (!Array.isArray(team.seats) || team.seats.length === 0
      || team.seats.some((seat: unknown) => typeof seat !== 'string' || seat.length === 0)) {
      throw new TypeError(`team ${team.id} must contain non-empty seat ids`);
    }
    for (const seat of team.seats) {
      if (seats.has(seat)) throw new TypeError(`seat belongs to multiple teams: ${seat}`);
      seats.add(seat);
    }
  }
}

export function teamForSeat(
  teams: readonly TeamDefinition[],
  seat: string,
): TeamDefinition | undefined {
  validateTeams(teams);
  const team = teams.find((candidate) => candidate.seats.includes(seat));
  return team ? { ...team, seats: [...team.seats] } : undefined;
}

/** Shared-vision set for a seat; an unteamed seat sees only itself. */
export function teamVisibility(
  teams: readonly TeamDefinition[],
  seat: string,
): Visibility {
  return {
    kind: 'seats',
    seats: teamForSeat(teams, seat)?.seats ?? [seat],
  };
}

/**
 * Expand a team ranking into the seat-ranked `Outcome` convention. Every
 * member receives its team's rank and optional score.
 */
export function outcomeForTeams(
  teams: readonly TeamDefinition[],
  ranking: readonly TeamRanking[],
  reason?: string,
): Outcome {
  validateTeams(teams);
  if (!Array.isArray(ranking) || ranking.length !== teams.length) {
    throw new TypeError('team ranking must contain every declared team exactly once');
  }
  const teamById = new Map(teams.map((team) => [team.id, team]));
  const seen = new Set<string>();
  const seats: Array<{ seat: string; rank: number; score?: number }> = [];
  for (const result of ranking) {
    if (!result || typeof result.teamId !== 'string' || !teamById.has(result.teamId)
      || seen.has(result.teamId)) {
      throw new TypeError('team ranking must reference unique declared team ids');
    }
    if (!Number.isSafeInteger(result.rank) || result.rank < 1) {
      throw new RangeError(`team ${result.teamId} rank must be a positive safe integer`);
    }
    if (result.score !== undefined && !Number.isFinite(result.score)) {
      throw new TypeError(`team ${result.teamId} score must be finite`);
    }
    seen.add(result.teamId);
    for (const seat of teamById.get(result.teamId)!.seats) {
      seats.push({
        seat,
        rank: result.rank,
        ...(result.score !== undefined ? { score: result.score } : {}),
      });
    }
  }
  return {
    kind: 'decided',
    ranking: seats,
    ...(reason !== undefined ? { reason } : {}),
  };
}

/** Create a standardized reveal record for observation/event streams. */
export function createInformationRevelation<TValue>(
  id: string,
  value: TValue,
  visibility: Visibility = { kind: 'public' },
): InformationRevelation<TValue> {
  if (typeof id !== 'string' || id.length === 0) {
    throw new TypeError('information revelation id must be a non-empty string');
  }
  // Exercise runtime validation even for public/hidden variants.
  visibilityAllows(visibility, '__revelation_validation__');
  return { type: 'information.revealed', id, visibility, value };
}

/** Filter standardized reveal records for one seat without changing order. */
export function revelationsForSeat<TValue>(
  revelations: readonly InformationRevelation<TValue>[],
  seat: string,
): readonly InformationRevelation<TValue>[] {
  if (!Array.isArray(revelations)) throw new TypeError('revelations must be an array');
  return revelations.filter((revelation) => {
    if (!revelation || revelation.type !== 'information.revealed') {
      throw new TypeError('revelation records must use information.revealed');
    }
    return visibilityAllows(revelation.visibility, seat);
  }).map((revelation) => ({ ...revelation }));
}

function canonicalValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'bigint') return value.toString();
    return value;
  }
  if (seen.has(value)) throw new TypeError('partition values must not be cyclic');
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((entry) => canonicalValue(entry, seen));
  } else {
    result = Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
        .map((key) => [
          key,
          canonicalValue((value as Record<string, unknown>)[key], seen),
        ]),
    );
  }
  seen.delete(value);
  return result;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value, new Set()));
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function redactZone<TEntry>(
  source: Record<string, unknown>,
  policy: ZoneVisibilityPolicy,
  seat: string,
  entryKey: (entry: TEntry) => string,
): ZoneViewNamespace<TEntry> {
  const count = source['count'];
  if (!Number.isSafeInteger(count) || (count as number) < 0) {
    throw new TypeError('zone view count must be a non-negative safe integer');
  }
  const identityVisible = visibilityAllows(policy.identity(seat), seat);
  const orderVisible = visibilityAllows(policy.order(seat), seat);
  const {
    entries: sourceEntries,
    slots: sourceSlots,
    ordered: _sourceOrdered,
    ...aggregates
  } = source;
  const base = { ...aggregates, count: count as number };
  if (!identityVisible) return base as ZoneViewNamespace<TEntry>;

  const entries = Array.isArray(sourceEntries)
    ? sourceEntries as TEntry[]
    : Object.values(record(sourceSlots) ?? {}).filter((entry): entry is TEntry => entry !== null);
  if (!orderVisible) {
    return {
      ...base,
      ...(entries.length > 0 ? { entries: [...entries].sort((a, b) => (
        compareStrings(entryKey(a), entryKey(b))
        || compareStrings(canonicalJson(a), canonicalJson(b))
      )) } : {}),
    } as ZoneViewNamespace<TEntry>;
  }
  return {
    ...base,
    ...(Array.isArray(sourceEntries) ? { entries: [...entries] } : {}),
    ...(record(sourceSlots) ? { slots: { ...record(sourceSlots) } } : {}),
    ordered: true,
  } as ZoneViewNamespace<TEntry>;
}

function defaultEntityCell<TCell, TEntity>(entity: TEntity): TCell {
  const value = record(entity);
  if (!value || !('at' in value)) {
    throw new TypeError('board entities require an `at` field or entityCell adapter');
  }
  return value['at'] as TCell;
}

function defaultShellEntity<TCell, TEntity>(_entity: TEntity, at: TCell): TEntity {
  return { at, hidden: true } as TEntity;
}

function redactBoard<TCell, TEntity>(
  source: Record<string, unknown>,
  policy: BoardVisibilityPolicy<TCell>,
  seat: string,
  entityCell: (entity: TEntity) => TCell,
  shellEntity: (entity: TEntity, at: TCell) => TEntity,
): Record<string, unknown> {
  if (policy.hiddenEntityMode !== 'absent' && policy.hiddenEntityMode !== 'shell') {
    throw new TypeError('hiddenEntityMode must be absent or shell');
  }
  const result = { ...source };
  const visible = (cell: TCell): boolean => policy.cellVisible(seat, cell);
  if (Array.isArray(source['cells'])) {
    result['cells'] = (source['cells'] as TCell[]).filter(visible);
  }
  if (Array.isArray(source['targetableCells'])) {
    result['targetableCells'] = (source['targetableCells'] as TCell[]).filter(visible);
  }
  const targeting = record(source['actionTargeting']);
  if (targeting) {
    result['actionTargeting'] = Object.fromEntries(
      Object.entries(targeting).map(([actionId, value]) => {
        const target = record(value);
        return [actionId, {
          ...target,
          targetableCells: Array.isArray(target?.['targetableCells'])
            ? (target['targetableCells'] as TCell[]).filter(visible)
            : [],
        }];
      }),
    );
  }
  if (Array.isArray(source['entities'])) {
    result['entities'] = (source['entities'] as TEntity[]).flatMap((entity) => {
      const at = entityCell(entity);
      if (visible(at)) return [entity];
      return policy.hiddenEntityMode === 'shell' ? [shellEntity(entity, at)] : [];
    });
  }
  return result;
}

/**
 * Derive a conventional per-seat view without mutating the full observation.
 *
 * Unconfigured zones/boards remain public. Products with custom view schemas
 * may implement `TickReducer.viewFor` directly and still use the leak checker.
 */
export function deriveSeatView<
  TCell,
  TEntry = unknown,
  TEntity = BoardEntityView<TCell>,
  TView extends TickView<unknown, unknown> = TickView<unknown, unknown>,
>(
  fullView: TView,
  policies: InformationPartitionPolicies<TCell, TEntry, TEntity>,
  seat: string,
): TView {
  if (typeof seat !== 'string' || seat.length === 0) {
    throw new TypeError('seat must be a non-empty string');
  }
  if (policies.board && policies.boards) {
    throw new TypeError('use either board or boards visibility policies, not both');
  }
  const result = { ...fullView } as Record<string, unknown>;
  const zones = record(fullView.zones);
  if (zones && policies.zones) {
    result['zones'] = Object.fromEntries(
      Object.entries(zones).map(([zoneId, zone]) => {
        const policy = policies.zones?.[zoneId];
        const source = record(zone);
        if (!policy || !source) return [zoneId, zone];
        return [zoneId, redactZone<TEntry>(
          source,
          policy,
          seat,
          policies.entryKey ?? ((entry) => canonicalJson(entry)),
        )];
      }),
    );
  }

  const grid = record(fullView.grid);
  const entityCell = policies.entityCell ?? defaultEntityCell<TCell, TEntity>;
  const shellEntity = policies.shellEntity ?? defaultShellEntity<TCell, TEntity>;
  if (grid && policies.board) {
    result['grid'] = redactBoard(grid, policies.board, seat, entityCell, shellEntity);
  } else if (grid && policies.boards) {
    result['grid'] = Object.fromEntries(
      Object.entries(grid).map(([boardId, board]) => {
        const policy = policies.boards?.[boardId];
        const source = record(board);
        return [boardId, policy && source
          ? redactBoard(source, policy, seat, entityCell, shellEntity)
          : board];
      }),
    );
  }
  return result as TView;
}

export interface InformationLeakCheckOptions<TState, TObservation> {
  baseline: TState;
  /** States that differ only in regions hidden from the observer. */
  variants: readonly TState[];
  observe(state: TState): TObservation | readonly TObservation[];
  /** Defaults to exact JSON serialization. */
  serialize?: (observation: TObservation | readonly TObservation[]) => string;
}

export class InformationLeakError extends Error {
  constructor(
    public readonly variant: number,
    message = `hidden-state variant ${variant} changed the observation stream`,
  ) {
    super(message);
    this.name = 'InformationLeakError';
  }
}

/**
 * Assert that hidden-state permutations produce byte-identical observations.
 */
export function assertNoInformationLeak<TState, TObservation>(
  options: InformationLeakCheckOptions<TState, TObservation>,
): void {
  if (!Array.isArray(options.variants) || options.variants.length === 0) {
    throw new RangeError('information leak checks require at least one hidden-state variant');
  }
  const serialize = options.serialize ?? ((observation) => JSON.stringify(observation));
  const expected = serialize(options.observe(options.baseline));
  for (let index = 0; index < options.variants.length; index++) {
    if (serialize(options.observe(options.variants[index]!)) !== expected) {
      throw new InformationLeakError(index);
    }
  }
}
