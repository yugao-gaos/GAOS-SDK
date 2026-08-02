import {
  AgentEnvironment,
  createHexAxialLayout,
  type Cell,
  type SubmittedAction,
  type TickReducer,
  type TickView,
} from '../../src/engine/index.js';

export type AshfallSide = 'ember' | 'hollow';
export type AshfallRole = 'Ranger' | 'Vanguard' | 'Warden';

export interface AshfallHex {
  q: number;
  r: number;
}

export interface AshfallLevel {
  id: 'ashfall-crossing';
}

export interface AshfallUnit extends AshfallHex {
  id: string;
  side: AshfallSide;
  role: AshfallRole;
  speed: number;
  hp: number;
  maxHp: number;
  damage: number;
  range: number;
  nextAt: number;
  attackReady: number;
}

export interface AshfallMoveOption {
  kind: 'move';
  unitId: string;
  target: AshfallHex;
  recovery: number;
  value: number;
  action: SubmittedAction;
}

export interface AshfallAttackOption {
  kind: 'attack';
  unitId: string;
  targetId: string;
  target: AshfallHex;
  recovery: number;
  value: number;
  action: SubmittedAction;
}

export type AshfallOption = AshfallMoveOption | AshfallAttackOption;

export interface AshfallTransition {
  kind: AshfallOption['kind'];
  unitId: string;
  targetId?: string;
  from: AshfallHex;
  to: AshfallHex;
  recovery: number;
  recoveryDelay: number;
  damage?: number;
  lethal?: boolean;
  message: string;
}

export interface AshfallTimelineEntry extends AshfallUnit {
  forecastAt: number;
}

export interface AshfallState {
  seed: number;
  units: readonly AshfallUnit[];
  actionsUsed: number;
  message: string;
  lastEvents?: AshfallTransition;
}

export interface AshfallView extends TickView {
  seed: number;
  radius: number;
  cells: readonly AshfallHex[];
  blocked: readonly string[];
  units: readonly AshfallUnit[];
  living: readonly AshfallUnit[];
  active: AshfallUnit | null;
  activeSide: AshfallSide;
  winner: AshfallSide | null;
  legalOptions: readonly AshfallOption[];
  timeline: readonly AshfallTimelineEntry[];
  message: string;
  transition?: AshfallTransition;
}

export const ASHFALL_RADIUS = 2;
export const ASHFALL_BLOCKED = ['0,-1', '-1,0', '1,0'] as const;
export const ASHFALL_LEVEL: AshfallLevel = { id: 'ashfall-crossing' };
export const ASHFALL_ACTIONS = {
  move: 'Action 1',
  attack: 'Action 2',
} as const;

const blockedKeys = new Set<string>(ASHFALL_BLOCKED);
const layout = createHexAxialLayout({
  contains: ([q, r]) => (
    Math.max(Math.abs(q), Math.abs(r), Math.abs(-q - r)) <= ASHFALL_RADIUS
  ),
});

export const ASHFALL_CELLS: readonly AshfallHex[] = (() => {
  const cells: AshfallHex[] = [];
  for (let q = -ASHFALL_RADIUS; q <= ASHFALL_RADIUS; q += 1) {
    const rMin = Math.max(-ASHFALL_RADIUS, -q - ASHFALL_RADIUS);
    const rMax = Math.min(ASHFALL_RADIUS, -q + ASHFALL_RADIUS);
    for (let r = rMin; r <= rMax; r += 1) cells.push({ q, r });
  }
  return cells;
})();

const STATS: Record<AshfallRole, Pick<
  AshfallUnit,
  'speed' | 'hp' | 'damage' | 'range'
>> = {
  Ranger: { speed: 160, hp: 3, damage: 1, range: 2 },
  Vanguard: { speed: 100, hp: 5, damage: 2, range: 1 },
  Warden: { speed: 70, hp: 6, damage: 2, range: 1 },
};

function copyHex(hex: AshfallHex): AshfallHex {
  return { q: hex.q, r: hex.r };
}

function copyUnit(unit: AshfallUnit): AshfallUnit {
  return { ...unit };
}

export function ashfallHexKey(hex: AshfallHex): string {
  return `${hex.q},${hex.r}`;
}

export function compareAshfallUnits(left: AshfallUnit, right: AshfallUnit): number {
  return left.nextAt - right.nextAt
    || right.speed - left.speed
    || left.id.localeCompare(right.id);
}

export function ashfallDistance(left: AshfallHex, right: AshfallHex): number {
  return layout.distance([left.q, left.r], [right.q, right.r]);
}

export function ashfallDelay(unit: AshfallUnit, recovery: number): number {
  return Math.ceil((recovery * 100) / unit.speed);
}

function initialDelay(speed: number): number {
  return Math.ceil(10_000 / speed);
}

function makeUnit(
  id: string,
  side: AshfallSide,
  role: AshfallRole,
  q: number,
  r: number,
): AshfallUnit {
  const stats = STATS[role];
  return {
    id,
    side,
    role,
    q,
    r,
    ...stats,
    maxHp: stats.hp,
    nextAt: initialDelay(stats.speed),
    attackReady: 0,
  };
}

function initialUnits(): AshfallUnit[] {
  return [
    makeUnit('e-ranger', 'ember', 'Ranger', -1, 2),
    makeUnit('e-vanguard', 'ember', 'Vanguard', -2, 1),
    makeUnit('e-warden', 'ember', 'Warden', -2, 0),
    makeUnit('h-ranger', 'hollow', 'Ranger', 1, -2),
    makeUnit('h-vanguard', 'hollow', 'Vanguard', 2, -1),
    makeUnit('h-warden', 'hollow', 'Warden', 2, 0),
  ];
}

function livingUnits(state: AshfallState): AshfallUnit[] {
  return state.units.filter(({ hp }) => hp > 0).map(copyUnit);
}

function winnerFor(units: readonly AshfallUnit[]): AshfallSide | null {
  const living = units.filter(({ hp }) => hp > 0);
  if (!living.some(({ side }) => side === 'ember')) return 'hollow';
  if (!living.some(({ side }) => side === 'hollow')) return 'ember';
  return null;
}

function activeUnit(state: AshfallState): AshfallUnit | null {
  return livingUnits(state).sort(compareAshfallUnits)[0] ?? null;
}

function unitAt(units: readonly AshfallUnit[], hex: AshfallHex): AshfallUnit | undefined {
  return units.find(({ hp, q, r }) => hp > 0 && q === hex.q && r === hex.r);
}

function moveAction(target: AshfallHex): SubmittedAction {
  return { id: ASHFALL_ACTIONS.move, x: target.q, y: target.r };
}

function attackAction(target: AshfallHex): SubmittedAction {
  return { id: ASHFALL_ACTIONS.attack, x: target.q, y: target.r };
}

function legalOptions(state: AshfallState): AshfallOption[] {
  const unit = activeUnit(state);
  if (!unit || winnerFor(state.units)) return [];
  const living = livingUnits(state);
  const enemies = living.filter(({ side }) => side !== unit.side);
  const options: AshfallOption[] = [];

  if (unit.nextAt >= unit.attackReady) {
    for (const target of enemies) {
      if (ashfallDistance(unit, target) <= unit.range) {
        options.push({
          kind: 'attack',
          unitId: unit.id,
          targetId: target.id,
          target: { q: target.q, r: target.r },
          recovery: unit.role === 'Ranger' ? 120 : 135,
          value: 120 + (target.hp <= unit.damage ? 70 : 0) - target.hp,
          action: attackAction(target),
        });
      }
    }
  }

  for (const [q, r] of layout.neighbors([unit.q, unit.r])) {
    const target = { q, r };
    if (blockedKeys.has(ashfallHexKey(target))) continue;
    if (unitAt(living, target)) continue;
    const closest = Math.min(...enemies.map((enemy) => ashfallDistance(target, enemy)));
    options.push({
      kind: 'move',
      unitId: unit.id,
      target,
      recovery: 100,
      value: 50 - closest * 8,
      action: moveAction(target),
    });
  }

  return options.sort((left, right) => right.value - left.value);
}

function copyOption(option: AshfallOption): AshfallOption {
  const common = {
    ...option,
    target: copyHex(option.target),
    action: { ...option.action },
  };
  return option.kind === 'attack'
    ? { ...common, kind: 'attack', targetId: option.targetId }
    : { ...common, kind: 'move' };
}

function forecastTimeline(state: AshfallState): AshfallTimelineEntry[] {
  const forecast = livingUnits(state);
  const result: AshfallTimelineEntry[] = [];
  for (let index = 0; index < 8 && forecast.length > 0; index += 1) {
    forecast.sort(compareAshfallUnits);
    const unit = forecast[0]!;
    result.push({ ...unit, forecastAt: unit.nextAt });
    unit.nextAt += ashfallDelay(unit, 100);
  }
  return result;
}

function actionKey(action: SubmittedAction): string {
  return JSON.stringify({ id: action.id, x: action.x, y: action.y });
}

function copyTransition(transition: AshfallTransition): AshfallTransition {
  return {
    ...transition,
    from: copyHex(transition.from),
    to: copyHex(transition.to),
  };
}

function advance(state: AshfallState, inputs: readonly SubmittedAction[]): AshfallState {
  if (inputs.length === 0) return state;
  if (inputs.length !== 1) throw new RangeError('Ashfall Crossing accepts one action per tick');
  if (winnerFor(state.units)) throw new RangeError('Ashfall Crossing is already terminal');

  const action = inputs[0]!;
  const option = legalOptions(state).find(
    (candidate) => actionKey(candidate.action) === actionKey(action),
  );
  if (!option) throw new RangeError('action is not a legal action for the active unit');

  const units = state.units.map(copyUnit);
  const unit = units.find(({ id }) => id === option.unitId)!;
  const from = { q: unit.q, r: unit.r };
  let message: string;
  let targetId: string | undefined;
  let damage: number | undefined;
  let lethal: boolean | undefined;

  if (option.kind === 'move') {
    unit.q = option.target.q;
    unit.r = option.target.r;
    message = `${unit.role} moved to hex ${ashfallHexKey(option.target)}.`;
  } else {
    const target = units.find(({ id }) => id === option.targetId)!;
    targetId = target.id;
    damage = unit.damage;
    lethal = target.hp <= unit.damage;
    target.hp = Math.max(0, target.hp - unit.damage);
    message = `${unit.role} hit ${target.role} for ${unit.damage}${lethal ? ' — defeated.' : '.'}`;
  }

  const previousNextAt = unit.nextAt;
  const recoveryDelay = ashfallDelay(unit, option.recovery);
  unit.nextAt += recoveryDelay;
  if (option.kind === 'attack') {
    unit.attackReady = previousNextAt + ashfallDelay(unit, 180);
  }

  return {
    ...state,
    units,
    actionsUsed: state.actionsUsed + 1,
    message,
    lastEvents: {
      kind: option.kind,
      unitId: unit.id,
      ...(targetId ? { targetId } : {}),
      from,
      to: copyHex(option.target),
      recovery: option.recovery,
      recoveryDelay,
      ...(damage === undefined ? {} : { damage }),
      ...(lethal === undefined ? {} : { lethal }),
      message,
    },
  };
}

function view(state: AshfallState): AshfallView {
  const living = livingUnits(state);
  const active = activeUnit(state);
  const winner = winnerFor(state.units);
  const options = legalOptions(state);
  const moveCells = options
    .filter((option): option is AshfallMoveOption => option.kind === 'move')
    .map(({ target }) => [target.q, target.r] as Cell);
  const attackCells = options
    .filter((option): option is AshfallAttackOption => option.kind === 'attack')
    .map(({ target }) => [target.q, target.r] as Cell);
  return {
    seed: state.seed,
    radius: ASHFALL_RADIUS,
    cells: ASHFALL_CELLS.map(copyHex),
    blocked: [...ASHFALL_BLOCKED],
    units: state.units.map(copyUnit),
    living,
    active: active ? copyUnit(active) : null,
    activeSide: active?.side ?? 'ember',
    winner,
    legalOptions: options.map(copyOption),
    timeline: forecastTimeline(state),
    message: state.message,
    ...(state.lastEvents ? { transition: copyTransition(state.lastEvents) } : {}),
    actions: [
      ...(moveCells.length > 0
        ? [{ id: ASHFALL_ACTIONS.move, params: 'xy' as const, text: 'Move' }]
        : []),
      ...(attackCells.length > 0
        ? [{ id: ASHFALL_ACTIONS.attack, params: 'xy' as const, text: 'Attack' }]
        : []),
    ],
    hud: { actionsUsed: state.actionsUsed },
    grid: {
      actionTargeting: {
        [ASHFALL_ACTIONS.move]: { targetableCells: moveCells },
        [ASHFALL_ACTIONS.attack]: { targetableCells: attackCells },
      },
    },
    status: winner === 'ember' ? 'won' : winner === 'hollow' ? 'failed' : 'playing',
  };
}

export const ashfallReducer: TickReducer<AshfallLevel, AshfallState, AshfallView> = {
  init(level, seed) {
    if (level.id !== ASHFALL_LEVEL.id) throw new RangeError('unknown Ashfall Crossing level');
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new RangeError('seed must be an unsigned 32-bit integer');
    }
    return {
      seed,
      units: initialUnits(),
      actionsUsed: 0,
      message: 'The fastest unit acts first. Choose a highlighted hex or target.',
    };
  },
  advance,
  view,
};

export function chooseAshfallAction(viewState: AshfallView): SubmittedAction {
  const option = viewState.legalOptions[0];
  if (!option) throw new RangeError('Ashfall Crossing has no legal action');
  return { ...option.action };
}

export function describeAshfallAction(
  viewState: AshfallView,
  action: SubmittedAction,
): string {
  const option = viewState.legalOptions.find(
    (candidate) => actionKey(candidate.action) === actionKey(action),
  );
  if (!option) return 'No legal action selected';
  return `${viewState.active?.role ?? 'Unit'} evaluated ${viewState.legalOptions.length} actions · value ${option.value}`;
}

export function createAshfallEnvironment(seed: number) {
  return new AgentEnvironment({
    reducer: ashfallReducer,
    level: ASHFALL_LEVEL,
    seed,
    maxTicks: 200,
  });
}
