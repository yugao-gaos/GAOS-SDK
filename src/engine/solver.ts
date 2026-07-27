import type {
  GridViewNamespace,
  SubmittedAction,
  Reducer,
  TickView,
} from './contracts.js';
import { advanceTick } from './contracts.js';

export interface SolveResult {
  min: number | null;
  capped: boolean;
  explored: number;
  actions: SubmittedAction[] | null;
}

export interface SolverOptions<TState> {
  maxActions: number;
  maxNodes?: number;
  seed?: number;
  /** Override state normalization when a runtime has other volatile fields. */
  stateKey?: (state: TState) => string;
  /** Override action enumeration for a custom observation surface. */
  actions?: (view: TickView<unknown, unknown>) => SubmittedAction[];
  /** Product policy can exclude actions that cannot help search, such as restart. */
  includeAction?: (action: SubmittedAction, view: TickView<unknown, unknown>) => boolean;
}

const VOLATILE_KEYS = ['lastEvents', 'actionsUsed', 'narrative', 'log'];

function defaultStateKey(state: unknown): string {
  if (state === null || typeof state !== 'object' || Array.isArray(state)) return JSON.stringify(state);
  const clone: Record<string, unknown> = { ...(state as Record<string, unknown>) };
  for (const key of VOLATILE_KEYS) delete clone[key];
  if (Array.isArray(clone.entities)) {
    clone.entities = (clone.entities as Array<{ cosmetic?: boolean }>).filter((entity) => !entity?.cosmetic);
  }
  return JSON.stringify(clone);
}

function stateFingerprint(value: string): string {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ code, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ code, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ code, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ code, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 = (h1 ^ h2 ^ h3 ^ h4) >>> 0;
  h2 = (h2 ^ h1) >>> 0;
  h3 = (h3 ^ h1) >>> 0;
  h4 = (h4 ^ h1) >>> 0;
  return String.fromCharCode(
    h1 & 0xffff, h1 >>> 16,
    h2 & 0xffff, h2 >>> 16,
    h3 & 0xffff, h3 >>> 16,
    h4 & 0xffff, h4 >>> 16,
  );
}

function isGridNamespace(
  grid: unknown,
): grid is GridViewNamespace {
  if (!grid || typeof grid !== 'object' || Array.isArray(grid)) return false;
  const candidate = grid as Record<string, unknown>;
  if (candidate['targetableCells'] !== undefined) {
    return Array.isArray(candidate['targetableCells']);
  }
  if (candidate['actionTargeting'] !== undefined) {
    const targeting = candidate['actionTargeting'];
    return !!targeting && typeof targeting === 'object' && !Array.isArray(targeting)
      && Object.values(targeting).every((value) => (
        !!value && typeof value === 'object' && !Array.isArray(value)
        && Array.isArray((value as Record<string, unknown>)['targetableCells'])
      ));
  }
  return Object.keys(candidate).length === 0;
}

function gridTargets(
  view: TickView<unknown, unknown>,
  actionId: string,
): Array<{ boardId?: string; cells: readonly [number, number][] }> {
  const legacyHud = view.hud as TickView['hud'] & GridViewNamespace;
  const legacyCells = legacyHud.actionTargeting?.[actionId]?.targetableCells
    ?? legacyHud.targetableCells;
  if (legacyCells) return [{ cells: legacyCells }];
  if (!view.grid) return [];
  if (isGridNamespace(view.grid)) {
    const cells = view.grid.actionTargeting?.[actionId]?.targetableCells
      ?? view.grid.targetableCells;
    return cells ? [{ cells }] : [];
  }
  if (!view.grid || typeof view.grid !== 'object' || Array.isArray(view.grid)) return [];
  return Object.entries(view.grid).flatMap(([boardId, value]) => {
    if (!isGridNamespace(value)) return [];
    const namespace = value;
    const cells = namespace.actionTargeting?.[actionId]?.targetableCells
      ?? namespace.targetableCells;
    return cells ? [{ boardId, cells }] : [];
  });
}

/** Enumerate standard no-parameter, indexed, board, and declarative-target actions. */
export function enumerateActions(view: TickView<unknown, unknown>): SubmittedAction[] {
  const submitted: SubmittedAction[] = [];
  for (const action of view.actions) {
    switch (action.params) {
      case 'none':
        submitted.push({ id: action.id });
        break;
      case 'index': {
        const indices = new Set<number>();
        for (const item of view.hud.items ?? []) indices.add(item.index);
        for (const option of view.hud.dialogueOptions ?? []) indices.add(option.index);
        for (const poi of view.hud.pois ?? []) indices.add(poi.index);
        for (const index of indices) submitted.push({ id: action.id, index });
        break;
      }
      case 'xy':
        for (const { boardId, cells } of gridTargets(view, action.id)) {
          for (const [x, y] of cells) {
            submitted.push({
              id: action.id,
              x,
              y,
              ...(boardId === undefined ? {} : { boardId }),
            });
          }
        }
        break;
      case 'targets': {
        if (!action.targetSpecId) {
          throw new TypeError(`targeted action ${action.id} requires targetSpecId`);
        }
        const enumeration = view.targetChoices?.[action.targetSpecId];
        if (!enumeration) {
          throw new RangeError(`missing target choices for ${action.targetSpecId}`);
        }
        if (enumeration.truncated) {
          throw new RangeError(`target choices for ${action.targetSpecId} are truncated`);
        }
        for (const targets of enumeration.choices) {
          submitted.push({
            id: action.id,
            targets: targets.map((target) => ({
              container: target.container,
              coord: Array.isArray(target.coord) ? [...target.coord] : target.coord,
            })),
          });
        }
        break;
      }
    }
  }
  return submitted;
}

/** Breadth-first shortest-path solver over any deterministic reducer. */
export function solveLevel<TLevel, TState, TView extends TickView<unknown, unknown>>(
  reducer: Reducer<TLevel, TState, TView>,
  level: TLevel,
  options: SolverOptions<TState>,
): SolveResult {
  const maxNodes = options.maxNodes ?? 5_000_000;
  if (!Number.isSafeInteger(options.maxActions) || options.maxActions < 0) {
    throw new RangeError('maxActions must be a non-negative safe integer');
  }
  if (!Number.isSafeInteger(maxNodes) || maxNodes <= 0) {
    throw new RangeError('maxNodes must be a positive safe integer');
  }
  const keyOf = options.stateKey ?? defaultStateKey;
  const actionsFor = options.actions ?? enumerateActions;
  const start = reducer.init(level, options.seed ?? 1);
  const initialStatus = reducer.view(start).status;
  if (initialStatus === 'won') {
    return { min: 0, capped: false, explored: 1, actions: [] };
  }
  if (initialStatus !== 'playing') {
    return { min: null, capped: false, explored: 1, actions: null };
  }
  let frontier: Array<{ state: TState; nodeId: number }> = [{ state: start, nodeId: 0 }];
  const seen = new Set<string>([stateFingerprint(keyOf(start))]);

  const traceChunkBits = 16;
  const traceChunkNodes = 1 << traceChunkBits;
  const traceChunkMask = traceChunkNodes - 1;
  const traceChunks: Uint32Array[] = [];
  const internedActions: SubmittedAction[] = [];
  const actionIds = new Map<string, number>();

  const internAction = (action: SubmittedAction): number => {
    const key = JSON.stringify(action);
    const existing = actionIds.get(key);
    if (existing !== undefined) return existing;
    const id = internedActions.length;
    internedActions.push(action);
    actionIds.set(key, id);
    return id;
  };

  const setTrace = (nodeId: number, parentId: number, action: SubmittedAction): void => {
    const chunkId = nodeId >>> traceChunkBits;
    const chunk = traceChunks[chunkId]
      ?? (traceChunks[chunkId] = new Uint32Array(traceChunkNodes * 2));
    const offset = (nodeId & traceChunkMask) * 2;
    chunk[offset] = parentId;
    chunk[offset + 1] = internAction(action);
  };

  let explored = 1;
  const pathTo = (fromId: number, last: SubmittedAction): SubmittedAction[] => {
    const path = [last];
    for (let nodeId = fromId; nodeId !== 0;) {
      const chunk = traceChunks[nodeId >>> traceChunkBits]!;
      const offset = (nodeId & traceChunkMask) * 2;
      path.push(internedActions[chunk[offset + 1]!]!);
      nodeId = chunk[offset]!;
    }
    return path.reverse();
  };

  for (let depth = 1; depth <= options.maxActions; depth++) {
    const next: typeof frontier = [];
    for (const { state, nodeId: parentId } of frontier) {
      const currentView = reducer.view(state);
      for (const action of actionsFor(currentView)) {
        if (options.includeAction && !options.includeAction(action, currentView)) continue;
        let nextState: TState;
        try {
          nextState = advanceTick(reducer, state, [action]);
        } catch {
          continue;
        }
        const view = reducer.view(nextState);
        if (view.status === 'won') {
          return { min: depth, capped: false, explored, actions: pathTo(parentId, action) };
        }
        if (view.status !== 'playing') continue;
        const fingerprint = stateFingerprint(keyOf(nextState));
        if (!seen.has(fingerprint)) {
          seen.add(fingerprint);
          const nodeId = explored;
          setTrace(nodeId, parentId, action);
          next.push({ state: nextState, nodeId });
          explored++;
          if (explored >= maxNodes) {
            return { min: null, capped: true, explored, actions: null };
          }
        }
      }
    }
    if (next.length === 0) return { min: null, capped: false, explored, actions: null };
    frontier = next;
  }
  return { min: null, capped: false, explored, actions: null };
}

/** @deprecated Renamed to `SolveResult`; this alias will be removed in v1.0. */
export type GridSolveResult = SolveResult;

/** @deprecated Renamed to `SolverOptions`; this alias will be removed in v1.0. */
export type GridSolverOptions<TState> = SolverOptions<TState>;

/** @deprecated Renamed to `enumerateActions`; this alias will be removed in v1.0. */
export const enumerateGridActions = enumerateActions;

/** @deprecated Renamed to `solveLevel`; this alias will be removed in v1.0. */
export const solveGridLevel = solveLevel;
