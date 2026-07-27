import type { Cell } from './movement.js';
import type { LocationRef } from './locations.js';
import type { JsonValue } from '../protocol.js';
import type {
  CommitmentEnvelope,
  RevealEnvelope,
} from './commitment.js';

export interface ActionDefinition {
  id: string;
  /** `targets` references a pre-enumerated declarative target specification. */
  params: 'none' | 'xy' | 'index' | 'targets';
  text?: string;
  targetSpecId?: string;
}

export interface SubmittedAction {
  id: string;
  /** Opaque product payload. The SDK never interprets it; replay round-trips it. */
  payload?: JsonValue;
  x?: number;
  y?: number;
  index?: number;
  /** Target board for games with more than one board. */
  boardId?: string;
  /** Reserved for zone-indexed actions. */
  zoneId?: string;
  /** Submitting seat when the host does not carry seat identity separately. */
  seat?: string;
  /** Cross-container target selection produced by a declarative target spec. */
  targets?: readonly LocationRef[];
  /** Optional opaque commit envelope, verified by the session layer. */
  commit?: CommitmentEnvelope;
  /** Optional reveal envelope, verified before its payload reaches gameplay. */
  reveal?: RevealEnvelope;
  /** Verified reveal payload made available to a game adapter. */
  verifiedPayload?: JsonValue;
}

export interface GridViewNamespace {
  targetableCells?: readonly Cell[];
  actionTargeting?: Readonly<Record<string, { targetableCells: readonly Cell[] }>>;
}

/** Spatial observation surface used by the generic solver. */
export type GridTargetingView =
  GridViewNamespace | Readonly<Record<string, GridViewNamespace>>;

export interface ZoneEntryView {
  id: string;
  [key: string]: unknown;
}

export interface ZoneViewNamespace<TEntry = ZoneEntryView> {
  /** Aggregate existence/count remains visible even when identity is hidden. */
  count: number;
  entries?: readonly TEntry[];
  /** Present only when the viewer may observe authored order. */
  ordered?: boolean;
  slots?: Readonly<Record<string, TEntry | null>>;
  [key: string]: unknown;
}

export type ZoneViews<TEntry = ZoneEntryView> =
  Readonly<Record<string, ZoneViewNamespace<TEntry>>>;

export interface TargetChoiceView {
  choices: readonly (readonly LocationRef[])[];
  /** True means the product's combinatorial guard omitted legal choices. */
  truncated: boolean;
}

export type Participation =
  | { mode: 'sequential'; activeSeat: string }
  | { mode: 'simultaneous'; seats: readonly string[] };

export type Outcome =
  | { kind: 'ongoing' }
  | {
    kind: 'decided';
    /** Ascending rank; ties share a rank. */
    ranking: ReadonlyArray<{ seat: string; rank: number; score?: number }>;
    reason?: string;
  };

/**
 * Minimum observation surface required by session, replay, and lockstep
 * infrastructure. Products with non-grid observations extend this directly.
 */
export interface SessionView {
  status: 'playing' | 'won' | 'failed' | 'ended';
  stars?: number;
  /** Active player/agent seat. Absent retains the single-seat behavior. */
  activeSeat?: string;
  /** Participation model. `activeSeat` is sequential-mode compatibility sugar. */
  participation?: Participation;
  /** Multi-seat result. `status` remains the required solo compatibility view. */
  outcome?: Outcome;
}

/** Product-owned replay counters that do not belong in an observation HUD. */
export interface ReplayMetrics {
  actionsUsed: number;
}

/**
 * Observation produced after one deterministic simulation tick.
 *
 * A product may map one player turn to one tick. A real-time product may
 * advance the same contract at a fixed cadence such as 30 ticks/s.
 *
 * This action-discovery shape remains the compatibility default. Products
 * without actions, HUD, grids, or zones may extend `SessionView` instead.
 */
export interface TickView<
  TGrid = GridTargetingView,
  TZones = ZoneViews,
> extends SessionView {
  actions: readonly ActionDefinition[];
  /** Semantic host controls, separate from hidden/state-filtered gameplay actions. */
  systemActions?: readonly ActionDefinition[];
  hud: {
    actionsUsed: number;
    items?: ReadonlyArray<{ index: number }>;
    dialogueOptions?: ReadonlyArray<{ index: number }>;
    pois?: ReadonlyArray<{ index: number }>;
  };
  /**
   * Spatial targeting for one implicit board or a record keyed by board id.
   * The single-board shape keeps product views compact.
   */
  grid?: TGrid;
  /** Conventional partition-filtered zone observations. */
  zones?: TZones;
  /** JSON-ready target choices keyed by `ActionDefinition.targetSpecId`. */
  targetChoices?: Readonly<Record<string, TargetChoiceView>>;
}

interface ReducerBase<
  TLevel,
  TState,
  TView extends SessionView = TickView,
> {
  init(level: TLevel, seed: number): TState;
  view(state: TState): TView;
  /** Optional per-seat observation. Absent means perfect information. */
  viewFor?(state: TState, seat: string): TView;
  /**
   * Pure replay counters for views without `hud.actionsUsed`.
   * Existing `TickView` reducers inherit the HUD value when this is absent.
   */
  replayMetrics?(state: TState): ReplayMetrics;
  /** Reject an action before it is durably admitted to the participation window. */
  validateCommand?(state: TState, seat: string, action: SubmittedAction): void;
}

/**
 * Canonical deterministic game adapter.
 *
 * Every call advances exactly one simulation tick. `inputs` may be empty,
 * contain one sequential input, or contain a canonically ordered simultaneous
 * batch. Autonomous systems therefore advance without invented wait actions.
 */
export interface TickReducer<
  TLevel,
  TState,
  TView extends SessionView = TickView,
> extends ReducerBase<TLevel, TState, TView> {
  advance(state: TState, inputs: readonly SubmittedAction[]): TState;
}

/** Compatibility shape for action-at-a-time reducers from SDK 0.17 and older. */
export interface ActionReducer<
  TLevel,
  TState,
  TView extends SessionView = TickView,
> extends ReducerBase<TLevel, TState, TView> {
  apply(state: TState, action: SubmittedAction): TState;
  /** Optional atomic batch resolver for simultaneous participation. */
  applyIntents?(state: TState, actions: readonly SubmittedAction[]): TState;
}

/** Reducer accepted by SDK algorithms during the 0.x compatibility period. */
export type Reducer<
  TLevel,
  TState,
  TView extends SessionView = TickView,
> =
  | TickReducer<TLevel, TState, TView>
  | ActionReducer<TLevel, TState, TView>;

/** Advance one tick through the canonical or compatibility reducer shape. */
export function advanceTick<
  TLevel,
  TState,
  TView extends SessionView,
>(
  reducer: Reducer<TLevel, TState, TView>,
  state: TState,
  inputs: readonly SubmittedAction[],
): TState {
  if ('advance' in reducer) return reducer.advance(state, inputs);
  if (inputs.length === 1) return reducer.apply(state, inputs[0]!);
  if (inputs.length > 1 && reducer.applyIntents) {
    return reducer.applyIntents(state, inputs);
  }
  if (inputs.length === 0) {
    throw new TypeError(
      'input-free ticks require TickReducer.advance; migrate this compatibility reducer',
    );
  }
  throw new TypeError('multi-input ticks require TickReducer.advance or reducer.applyIntents');
}

/**
 * Read and validate the deterministic replay counter for a reducer state.
 * Action-discovery reducers retain the legacy `view.hud.actionsUsed` fallback.
 */
export function replayMetricsFor<
  TLevel,
  TState,
  TView extends SessionView,
>(
  reducer: Reducer<TLevel, TState, TView>,
  state: TState,
  view: TView = reducer.view(state),
): ReplayMetrics {
  const actionsUsed = reducer.replayMetrics === undefined
    ? (view as SessionView & { hud?: { actionsUsed?: unknown } }).hud?.actionsUsed
    : reducer.replayMetrics(state).actionsUsed;
  if (!Number.isSafeInteger(actionsUsed) || (actionsUsed as number) < 0) {
    throw new TypeError(
      'reducer replayMetrics().actionsUsed or view.hud.actionsUsed '
      + 'must be a non-negative safe integer',
    );
  }
  return { actionsUsed: actionsUsed as number };
}

/** @deprecated Renamed to `ActionDefinition`; this alias will be removed in v1.0. */
export type GridActionDefinition = ActionDefinition;

/** @deprecated Renamed to `SubmittedAction`; this alias will be removed in v1.0. */
export type GridSubmittedAction = SubmittedAction;
