import {
  AgentEnvironment,
  createSquareLayout,
  type Cell,
  type SubmittedAction,
  type TickReducer,
  type TickView,
} from '../../src/engine/index.js';

export type CinderCardKind =
  | 'step'
  | 'vault'
  | 'bash'
  | 'hook'
  | 'bolt'
  | 'guard'
  | 'wait';
type CinderPlayableCardKind = Exclude<CinderCardKind, 'wait'>;

export interface CinderPoint {
  x: number;
  y: number;
}

export interface CinderCard {
  kind: CinderCardKind;
  name: string;
  text: string;
  glyph: string;
}

export interface CinderHero extends CinderPoint {
  hp: number;
  maxHp: number;
  shield: number;
}

export interface CinderEnemy extends CinderPoint {
  id: string;
  name: string;
  hp: number;
  maxHp: number;
  damage: number;
}

export interface CinderPlanState {
  kind: CinderCardKind;
  target: CinderPoint;
  summary: string;
}

export interface CinderPlan {
  card: CinderCard;
  target: CinderPoint;
  summary: string;
}

export interface CinderProjectedEnemy extends CinderEnemy {
  origin: CinderPoint;
  movedAt: number | null;
}

export interface CinderProjectedState {
  hero: CinderPoint;
  enemies: CinderProjectedEnemy[];
}

export interface CinderPreview {
  cell: CinderPoint;
  kind: 'move' | 'attack' | 'guard';
  beat: number;
  endpoint: boolean;
  ghost: boolean;
}

export interface CinderTrajectory {
  kind: 'move' | 'attack' | 'displacement';
  beat: number;
  from: CinderPoint;
  to: CinderPoint;
  ghost: boolean;
}

export interface CinderEnemyIntent {
  enemy: CinderEnemy;
  intent: {
    kind: 'attack' | 'move';
    target: CinderPoint;
  };
}

export type CinderMotion = 'move' | 'attack' | 'cast' | 'guard' | 'collision';

export interface CinderCombatAnimation {
  id: string;
  kind: 'projectile' | 'melee' | 'tether';
  sourceId: string;
  from: CinderPoint;
  to: CinderPoint;
}

export interface CinderSnapshot {
  hero: CinderHero;
  enemies: CinderEnemy[];
  barrels: number[];
  gateOpen: boolean;
}

export interface CinderBeatTransition {
  beat: number;
  plan: CinderPlan;
  before: CinderSnapshot;
  after: CinderSnapshot;
  intents: CinderEnemyIntent[];
  blockHero: boolean;
  blockedEnemyIds: string[];
  collisionCells: number[];
  heroMotion: CinderMotion | null;
  enemyMotions: Record<string, CinderMotion>;
  combatAnimations: CinderCombatAnimation[];
  hitEnemyIds: string[];
  heroHit: boolean;
  playerResolved: boolean;
  lastEvent: string;
}

export interface CinderTransition {
  plans: CinderPlan[];
  beats: CinderBeatTransition[];
  committedCount: number;
  interruptedAt: number | null;
}

export interface CinderLegalPlan {
  card: CinderCard;
  target: CinderPoint;
  summary: string;
  action: SubmittedAction;
  preview: CinderPreview[];
  trajectory: CinderTrajectory[];
}

export interface CinderVaultLevel {
  id: 'cinder-vault';
}

export interface CinderVaultState {
  seed: number;
  randomState: number;
  room: number;
  turn: number;
  hero: CinderHero;
  enemies: CinderEnemy[];
  walls: number[];
  spikes: number[];
  pits: number[];
  barrels: number[];
  plate: number;
  gate: number;
  gateOpen: boolean;
  queue: CinderPlanState[];
  hand: CinderCardKind[];
  drawPile: CinderCardKind[];
  discardPile: CinderCardKind[];
  actionsUsed: number;
  message: string;
  decision: string;
  lastEvent: string;
  lastEvents: CinderTransition | null;
}

export interface CinderVaultView extends TickView {
  seed: number;
  room: number;
  turn: number;
  size: number;
  maxActions: number;
  hero: CinderHero;
  enemies: CinderEnemy[];
  walls: number[];
  spikes: number[];
  pits: number[];
  barrels: number[];
  plate: number;
  gate: number;
  gateOpen: boolean;
  queue: CinderPlan[];
  hand: CinderCard[];
  drawCount: number;
  discardCount: number;
  projected: CinderProjectedState;
  previews: CinderPreview[];
  trajectories: CinderTrajectory[];
  legalPlans: CinderLegalPlan[];
  roomCleared: boolean;
  won: boolean;
  defeated: boolean;
  message: string;
  decision: string;
  lastEvent: string;
  transition?: CinderTransition;
}

interface RoomLayout {
  enemies: CinderEnemy[];
  walls: number[];
  spikes: number[];
  pits: number[];
  barrels: number[];
  plate: number;
  gate: number;
}

interface MovementResolution {
  blockHero: boolean;
  blockedEnemyIds: Set<string>;
  collisionCells: Set<number>;
}

export const CINDER_SIZE = 6;
export const CINDER_MAX_ACTIONS = 3;
export const CINDER_HAND_SIZE = 4;
export const CINDER_LEVEL: CinderVaultLevel = { id: 'cinder-vault' };
export const CINDER_ACTIONS = {
  step: 'Action 1',
  vault: 'Action 2',
  bash: 'Action 3',
  hook: 'Action 4',
  bolt: 'Action 5',
  guard: 'Action 6',
  commit: 'Action 7',
  remove: 'Action 8',
  clear: 'Action 9',
  nextRoom: 'Action 10',
} as const;

export const CINDER_CARDS: Readonly<Record<CinderCardKind, CinderCard>> = {
  step: { kind: 'step', name: 'Step', text: 'Move one tile.', glyph: '→' },
  vault: { kind: 'vault', name: 'Vault', text: 'Jump over an obstacle.', glyph: '⌁' },
  bash: { kind: 'bash', name: 'Bash', text: 'Push an adjacent enemy.', glyph: '»' },
  hook: { kind: 'hook', name: 'Hook', text: 'Pull a visible enemy closer.', glyph: '↢' },
  bolt: {
    kind: 'bolt',
    name: 'Cinder Bolt',
    text: 'Damage a foe or ignite a barrel.',
    glyph: '✦',
  },
  guard: { kind: 'guard', name: 'Guard', text: 'Gain two shield.', glyph: '◇' },
  wait: { kind: 'wait', name: 'Wait', text: 'Take no action this beat.', glyph: '·' },
};

const CARD_KINDS: CinderPlayableCardKind[] = [
  'step',
  'vault',
  'bash',
  'hook',
  'bolt',
  'guard',
];
const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];
const layout = createSquareLayout({ width: CINDER_SIZE, height: CINDER_SIZE });

const ROOM_LAYOUTS: readonly RoomLayout[] = [
  {
    enemies: [
      { id: 'ash-a', name: 'Ashling', x: 3, y: 4, hp: 3, maxHp: 3, damage: 1 },
      { id: 'ash-b', name: 'Ashling', x: 5, y: 2, hp: 3, maxHp: 3, damage: 1 },
    ],
    walls: [14, 20],
    spikes: [28, 10],
    pits: [5],
    barrels: [16],
    plate: 8,
    gate: 9,
  },
  {
    enemies: [
      { id: 'sentinel', name: 'Sentinel', x: 4, y: 4, hp: 5, maxHp: 5, damage: 2 },
      { id: 'ash-c', name: 'Ashling', x: 2, y: 1, hp: 3, maxHp: 3, damage: 1 },
    ],
    walls: [13, 14, 22],
    spikes: [21, 27],
    pits: [4, 11],
    barrels: [17, 29],
    plate: 18,
    gate: 19,
  },
  {
    enemies: [
      { id: 'heart', name: 'Vault Heart', x: 4, y: 1, hp: 7, maxHp: 7, damage: 2 },
      { id: 'wisp', name: 'Wisp', x: 3, y: 4, hp: 3, maxHp: 3, damage: 1 },
    ],
    walls: [8, 14, 20],
    spikes: [9, 15, 27],
    pits: [5, 30],
    barrels: [16, 28],
    plate: 21,
    gate: 22,
  },
];

function copyPoint(point: CinderPoint): CinderPoint {
  return { x: point.x, y: point.y };
}

function copyHero(hero: CinderHero): CinderHero {
  return { ...hero };
}

function copyEnemy(enemy: CinderEnemy): CinderEnemy {
  return { ...enemy };
}

function cardFor(kind: CinderCardKind): CinderCard {
  return { ...CINDER_CARDS[kind] };
}

function indexAt(point: CinderPoint): number {
  return point.y * CINDER_SIZE + point.x;
}

function pointAt(index: number): CinderPoint {
  return { x: index % CINDER_SIZE, y: Math.floor(index / CINDER_SIZE) };
}

function cellName(point: CinderPoint): string {
  return `${String.fromCharCode(65 + point.x)}${point.y + 1}`;
}

function inside(point: CinderPoint): boolean {
  return layout.contains([point.x, point.y]);
}

function distance(left: CinderPoint, right: CinderPoint): number {
  return layout.distance([left.x, left.y], [right.x, right.y]);
}

function roomLayout(room: number): RoomLayout {
  const source = ROOM_LAYOUTS[room - 1];
  if (!source) throw new RangeError(`unknown Cinder Vault room ${room}`);
  return {
    enemies: source.enemies.map(copyEnemy),
    walls: [...source.walls],
    spikes: [...source.spikes],
    pits: [...source.pits],
    barrels: [...source.barrels],
    plate: source.plate,
    gate: source.gate,
  };
}

function nextRandom(randomState: number): { randomState: number; value: number } {
  const next = (Math.imul(randomState, 1_664_525) + 1_013_904_223) >>> 0;
  return { randomState: next, value: next / 4_294_967_296 };
}

function shuffle(
  source: readonly CinderCardKind[],
  randomState: number,
): { cards: CinderCardKind[]; randomState: number } {
  const cards = [...source];
  let current = randomState;
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const random = nextRandom(current);
    current = random.randomState;
    const swapIndex = Math.floor(random.value * (index + 1));
    [cards[index], cards[swapIndex]] = [cards[swapIndex]!, cards[index]!];
  }
  return { cards, randomState: current };
}

function drawCards(state: CinderVaultState): void {
  while (state.hand.length < CINDER_HAND_SIZE) {
    if (state.drawPile.length === 0 && state.discardPile.length > 0) {
      const shuffled = shuffle(state.discardPile, state.randomState);
      state.drawPile = shuffled.cards;
      state.randomState = shuffled.randomState;
      state.discardPile = [];
    }
    const card = state.drawPile.shift();
    if (!card) break;
    state.hand.push(card);
  }
}

function cloneState(state: CinderVaultState): CinderVaultState {
  return {
    ...state,
    hero: copyHero(state.hero),
    enemies: state.enemies.map(copyEnemy),
    walls: [...state.walls],
    spikes: [...state.spikes],
    pits: [...state.pits],
    barrels: [...state.barrels],
    queue: state.queue.map((plan) => ({
      ...plan,
      target: copyPoint(plan.target),
    })),
    hand: [...state.hand],
    drawPile: [...state.drawPile],
    discardPile: [...state.discardPile],
    lastEvents: state.lastEvents ? copyTransition(state.lastEvents) : null,
  };
}

function terrainBlocked(state: CinderVaultState, point: CinderPoint): boolean {
  const index = indexAt(point);
  return !inside(point)
    || state.walls.includes(index)
    || (state.gate === index && !state.gateOpen);
}

function enemyAt(
  enemies: readonly CinderEnemy[],
  point: CinderPoint,
): CinderEnemy | undefined {
  return enemies.find((enemy) => enemy.x === point.x && enemy.y === point.y);
}

function stateBlocked(
  state: CinderVaultState,
  point: CinderPoint,
  includeHero = true,
): boolean {
  return terrainBlocked(state, point)
    || state.barrels.includes(indexAt(point))
    || !!enemyAt(state.enemies, point)
    || (includeHero && state.hero.x === point.x && state.hero.y === point.y);
}

function projectedEnemyAt(
  enemies: readonly CinderProjectedEnemy[],
  point: CinderPoint,
): CinderProjectedEnemy | undefined {
  return enemies.find((enemy) => enemy.x === point.x && enemy.y === point.y);
}

function projectedBlocked(
  state: CinderVaultState,
  projected: CinderProjectedState,
  point: CinderPoint,
  includeHero = true,
): boolean {
  return terrainBlocked(state, point)
    || state.barrels.includes(indexAt(point))
    || !!projectedEnemyAt(projected.enemies, point)
    || (includeHero && projected.hero.x === point.x && projected.hero.y === point.y);
}

function initialProjection(state: CinderVaultState): CinderProjectedState {
  return {
    hero: { x: state.hero.x, y: state.hero.y },
    enemies: state.enemies.map((enemy) => ({
      ...copyEnemy(enemy),
      origin: { x: enemy.x, y: enemy.y },
      movedAt: null,
    })),
  };
}

function pushProjected(
  state: CinderVaultState,
  projected: CinderProjectedState,
  enemyId: string,
  dx: number,
  dy: number,
  beat: number,
): boolean {
  const enemy = projected.enemies.find(({ id }) => id === enemyId);
  if (!enemy) return false;
  const destination = { x: enemy.x + dx, y: enemy.y + dy };
  if (terrainBlocked(state, destination)
    || (destination.x === projected.hero.x && destination.y === projected.hero.y)) {
    return false;
  }
  const chained = projectedEnemyAt(projected.enemies, destination);
  if (chained && !pushProjected(state, projected, chained.id, dx, dy, beat)) return false;
  enemy.x = destination.x;
  enemy.y = destination.y;
  enemy.movedAt = beat;
  const destinationIndex = indexAt(destination);
  if (state.pits.includes(destinationIndex)) {
    projected.enemies = projected.enemies.filter(({ id }) => id !== enemy.id);
  } else if (state.spikes.includes(destinationIndex)) {
    enemy.hp -= 2;
    if (enemy.hp <= 0) {
      projected.enemies = projected.enemies.filter(({ id }) => id !== enemy.id);
    }
  }
  return true;
}

function applyProjectedPlan(
  state: CinderVaultState,
  projected: CinderProjectedState,
  plan: CinderPlanState,
  beat: number,
): void {
  if (plan.kind === 'step' || plan.kind === 'vault') {
    projected.hero = copyPoint(plan.target);
    return;
  }
  if (plan.kind === 'bash' || plan.kind === 'hook') {
    const enemy = projectedEnemyAt(projected.enemies, plan.target);
    if (!enemy) return;
    const dx = plan.kind === 'bash'
      ? Math.sign(enemy.x - projected.hero.x)
      : Math.sign(projected.hero.x - enemy.x);
    const dy = plan.kind === 'bash'
      ? Math.sign(enemy.y - projected.hero.y)
      : Math.sign(projected.hero.y - enemy.y);
    pushProjected(state, projected, enemy.id, dx, dy, beat);
    return;
  }
  if (plan.kind === 'bolt') {
    const enemy = projectedEnemyAt(projected.enemies, plan.target);
    if (!enemy) return;
    enemy.hp -= 2;
    if (enemy.hp <= 0) {
      projected.enemies = projected.enemies.filter(({ id }) => id !== enemy.id);
    }
  }
}

function projectQueue(state: CinderVaultState): CinderProjectedState {
  const projected = initialProjection(state);
  state.queue.forEach((plan, index) => applyProjectedPlan(state, projected, plan, index + 1));
  return projected;
}

function straightLine(origin: CinderPoint, target: CinderPoint): CinderPoint[] {
  if (origin.x !== target.x && origin.y !== target.y) return [];
  return layout.line(
    [origin.x, origin.y],
    [target.x, target.y],
  ).map(([x, y]) => ({ x, y }));
}

function hasClearLine(
  state: CinderVaultState,
  origin: CinderPoint,
  target: CinderPoint,
  enemies: readonly Pick<CinderEnemy, 'x' | 'y'>[],
): boolean {
  const line = straightLine(origin, target);
  if (line.length === 0 || line.length > 3) return false;
  return line.slice(0, -1).every((point) => {
    const index = indexAt(point);
    return !state.walls.includes(index)
      && !(state.gate === index && !state.gateOpen)
      && !state.barrels.includes(index)
      && !enemies.some((enemy) => enemy.x === point.x && enemy.y === point.y);
  });
}

function lineTargets(
  state: CinderVaultState,
  projected: CinderProjectedState,
  allowBarrelTarget: boolean,
): CinderPoint[] {
  return DIRECTIONS.flatMap(([dx, dy]) => [1, 2, 3]
    .map((amount) => ({
      x: projected.hero.x + dx * amount,
      y: projected.hero.y + dy * amount,
    }))
    .filter((target) => inside(target)
      && !terrainBlocked(state, target)
      && (allowBarrelTarget || !state.barrels.includes(indexAt(target)))
      && hasClearLine(state, projected.hero, target, projected.enemies)));
}

function legalTargets(
  state: CinderVaultState,
  projected: CinderProjectedState,
  kind: CinderCardKind,
): CinderPoint[] {
  if (state.queue.length >= CINDER_MAX_ACTIONS || kind === 'wait') return [];
  const origin = projected.hero;
  if (kind === 'guard') return [copyPoint(origin)];
  if (kind === 'step') {
    return DIRECTIONS
      .map(([dx, dy]) => ({ x: origin.x + dx, y: origin.y + dy }))
      .filter((target) => inside(target) && !projectedBlocked(state, projected, target, false));
  }
  if (kind === 'vault') {
    return DIRECTIONS.flatMap(([dx, dy]) => {
      const middle = { x: origin.x + dx, y: origin.y + dy };
      const landing = { x: origin.x + dx * 2, y: origin.y + dy * 2 };
      return inside(landing)
        && projectedBlocked(state, projected, middle, false)
        && !projectedBlocked(state, projected, landing, false)
        ? [landing]
        : [];
    });
  }
  if (kind === 'bash') {
    return DIRECTIONS
      .map(([dx, dy]) => ({ x: origin.x + dx, y: origin.y + dy }))
      .filter((target) => inside(target)
        && !terrainBlocked(state, target)
        && !state.barrels.includes(indexAt(target)));
  }
  return lineTargets(state, projected, kind === 'bolt');
}

function actionFor(kind: CinderCardKind, target: CinderPoint): SubmittedAction {
  if (kind === 'wait') throw new RangeError('Wait is not a programmable card action');
  const id = CINDER_ACTIONS[kind];
  return { id, x: target.x, y: target.y };
}

function planSummary(kind: CinderCardKind, target: CinderPoint): string {
  return `${CINDER_CARDS[kind].name} → ${cellName(target)}`;
}

function actionKey(action: SubmittedAction): string {
  return JSON.stringify({
    id: action.id,
    ...(action.x === undefined ? {} : { x: action.x }),
    ...(action.y === undefined ? {} : { y: action.y }),
    ...(action.index === undefined ? {} : { index: action.index }),
  });
}

function addPreview(
  previews: CinderPreview[],
  origin: CinderPoint,
  plan: CinderPlanState,
  beat: number,
  ghost: boolean,
): void {
  if (plan.kind === 'wait') return;
  let points: CinderPoint[];
  let kind: CinderPreview['kind'] = 'attack';
  if (plan.kind === 'step') {
    kind = 'move';
    points = [copyPoint(plan.target)];
  } else if (plan.kind === 'vault') {
    kind = 'move';
    points = [
      { x: (origin.x + plan.target.x) / 2, y: (origin.y + plan.target.y) / 2 },
      copyPoint(plan.target),
    ];
  } else if (plan.kind === 'guard') {
    kind = 'guard';
    points = [copyPoint(origin)];
  } else {
    points = straightLine(origin, plan.target);
    if (points.length === 0) points = [copyPoint(plan.target)];
    if (plan.kind === 'bash') {
      const pushed = {
        x: plan.target.x + Math.sign(plan.target.x - origin.x),
        y: plan.target.y + Math.sign(plan.target.y - origin.y),
      };
      if (inside(pushed)) points.push(pushed);
    }
  }
  points.forEach((cell, index) => previews.push({
    cell,
    kind,
    beat,
    endpoint: index === points.length - 1 || (plan.kind === 'bash' && index === 0),
    ghost,
  }));
}

function addTrajectory(
  state: CinderVaultState,
  trajectories: CinderTrajectory[],
  projected: CinderProjectedState,
  plan: CinderPlanState,
  beat: number,
  ghost: boolean,
): void {
  const from = copyPoint(projected.hero);
  if (plan.kind === 'step' || plan.kind === 'vault') {
    trajectories.push({
      kind: 'move',
      beat,
      from,
      to: copyPoint(plan.target),
      ghost,
    });
    return;
  }
  if (plan.kind === 'guard' || plan.kind === 'wait') return;
  trajectories.push({
    kind: 'attack',
    beat,
    from,
    to: copyPoint(plan.target),
    ghost,
  });
  if (plan.kind !== 'bash' && plan.kind !== 'hook') return;
  const enemy = projectedEnemyAt(projected.enemies, plan.target);
  if (!enemy) return;
  const before = copyPoint(enemy);
  const next: CinderProjectedState = {
    hero: copyPoint(projected.hero),
    enemies: projected.enemies.map((item) => ({
      ...item,
      origin: copyPoint(item.origin),
    })),
  };
  applyProjectedPlan(state, next, plan, beat);
  const moved = next.enemies.find(({ id }) => id === enemy.id);
  if (moved && (moved.x !== before.x || moved.y !== before.y)) {
    trajectories.push({
      kind: 'displacement',
      beat,
      from: before,
      to: copyPoint(moved),
      ghost,
    });
  }
}

function queuePresentation(state: CinderVaultState): {
  projected: CinderProjectedState;
  previews: CinderPreview[];
  trajectories: CinderTrajectory[];
} {
  const projected = initialProjection(state);
  const previews: CinderPreview[] = [];
  const trajectories: CinderTrajectory[] = [];
  state.queue.forEach((plan, index) => {
    addPreview(previews, projected.hero, plan, index + 1, false);
    addTrajectory(state, trajectories, projected, plan, index + 1, false);
    applyProjectedPlan(state, projected, plan, index + 1);
  });
  return { projected, previews, trajectories };
}

function legalPlans(
  state: CinderVaultState,
  projected: CinderProjectedState,
): CinderLegalPlan[] {
  if (state.queue.length >= CINDER_MAX_ACTIONS) return [];
  return state.hand.flatMap((kind) => legalTargets(state, projected, kind).map((target) => {
    const plan: CinderPlanState = {
      kind,
      target: copyPoint(target),
      summary: planSummary(kind, target),
    };
    const preview: CinderPreview[] = [];
    const trajectory: CinderTrajectory[] = [];
    addPreview(preview, projected.hero, plan, state.queue.length + 1, true);
    addTrajectory(state, trajectory, projected, plan, state.queue.length + 1, true);
    return {
      card: cardFor(kind),
      target: copyPoint(target),
      summary: plan.summary,
      action: actionFor(kind, target),
      preview,
      trajectory,
    };
  }));
}

function snapshot(state: CinderVaultState): CinderSnapshot {
  return {
    hero: copyHero(state.hero),
    enemies: state.enemies.map(copyEnemy),
    barrels: [...state.barrels],
    gateOpen: state.gateOpen,
  };
}

function enemyIntent(state: CinderVaultState, enemy: CinderEnemy): CinderEnemyIntent {
  if (distance(enemy, state.hero) === 1) {
    return {
      enemy: copyEnemy(enemy),
      intent: {
        kind: 'attack',
        target: { x: state.hero.x, y: state.hero.y },
      },
    };
  }
  const candidates = DIRECTIONS
    .map(([dx, dy]) => ({ x: enemy.x + dx, y: enemy.y + dy }))
    .filter((target) => inside(target) && !stateBlocked(state, target, false))
    .sort((left, right) => (
      distance(left, state.hero) - distance(right, state.hero)
      || indexAt(left) - indexAt(right)
    ));
  return {
    enemy: copyEnemy(enemy),
    intent: {
      kind: 'move',
      target: candidates[0] ?? { x: enemy.x, y: enemy.y },
    },
  };
}

function movementResolution(
  state: CinderVaultState,
  plan: CinderPlanState,
  intents: readonly CinderEnemyIntent[],
): MovementResolution {
  const proposals = new Map<number, Array<{ kind: 'hero' | 'enemy'; id: string }>>();
  const add = (
    target: CinderPoint,
    proposal: { kind: 'hero' | 'enemy'; id: string },
  ): void => {
    const index = indexAt(target);
    proposals.set(index, [...(proposals.get(index) ?? []), proposal]);
  };
  if ((plan.kind === 'step' || plan.kind === 'vault')
    && !stateBlocked(state, plan.target, false)) {
    add(plan.target, { kind: 'hero', id: 'hero' });
  }
  for (const { enemy, intent } of intents) {
    if (intent.kind !== 'move'
      || (intent.target.x === enemy.x && intent.target.y === enemy.y)) {
      continue;
    }
    add(intent.target, { kind: 'enemy', id: enemy.id });
  }
  const blockedEnemyIds = new Set<string>();
  const collisionCells = new Set<number>();
  let blockHero = false;
  for (const [index, contenders] of proposals) {
    if (contenders.length < 2) continue;
    collisionCells.add(index);
    for (const contender of contenders) {
      if (contender.kind === 'hero') blockHero = true;
      else blockedEnemyIds.add(contender.id);
    }
  }
  return { blockHero, blockedEnemyIds, collisionCells };
}

function applyHazard(state: CinderVaultState, enemyId: string): void {
  const enemy = state.enemies.find(({ id }) => id === enemyId);
  if (!enemy) return;
  const index = indexAt(enemy);
  if (state.pits.includes(index)) {
    state.enemies = state.enemies.filter(({ id }) => id !== enemy.id);
    state.lastEvent = `${enemy.name} fell into the abyss.`;
    return;
  }
  if (state.spikes.includes(index)) {
    enemy.hp -= 2;
    state.enemies = state.enemies.filter(({ hp }) => hp > 0);
    state.lastEvent = `${enemy.name} landed on spikes for 2 damage.`;
  }
  if (state.plate === index) {
    state.gateOpen = true;
    state.lastEvent = `${enemy.name} triggered the gate plate.`;
  }
}

function explodeBarrel(state: CinderVaultState, point: CinderPoint): void {
  state.barrels = state.barrels.filter((index) => index !== indexAt(point));
  for (const enemy of state.enemies) {
    if (distance(point, enemy) <= 1) enemy.hp -= 3;
  }
  state.enemies = state.enemies.filter(({ hp }) => hp > 0);
  if (distance(point, state.hero) <= 1) {
    state.hero.hp = Math.max(0, state.hero.hp - 2);
  }
  state.lastEvent = 'The cinder barrel exploded in a chain reaction.';
}

function damageEnemies(
  state: CinderVaultState,
  ids: readonly string[],
  damage: number,
): void {
  const selected = new Set(ids);
  for (const enemy of state.enemies) {
    if (selected.has(enemy.id)) enemy.hp -= damage;
  }
  state.enemies = state.enemies.filter(({ hp }) => hp > 0);
}

function pushEnemy(
  state: CinderVaultState,
  enemyId: string,
  dx: number,
  dy: number,
): boolean {
  const enemy = state.enemies.find(({ id }) => id === enemyId);
  if (!enemy) return false;
  const destination = { x: enemy.x + dx, y: enemy.y + dy };
  const chained = enemyAt(state.enemies, destination);
  if (chained && !pushEnemy(state, chained.id, dx, dy)) {
    damageEnemies(state, [enemy.id, chained.id], 1);
    state.lastEvent = 'The push chain collapsed into collision damage.';
    return false;
  }
  if (terrainBlocked(state, destination)) {
    damageEnemies(state, [enemy.id], 1);
    state.lastEvent = `${enemy.name} slammed into stone.`;
    return false;
  }
  if (state.barrels.includes(indexAt(destination))) {
    explodeBarrel(state, destination);
    const survivor = state.enemies.find(({ id }) => id === enemy.id);
    if (survivor) {
      survivor.x = destination.x;
      survivor.y = destination.y;
    }
    return true;
  }
  const moved = state.enemies.find(({ id }) => id === enemy.id);
  if (!moved) return false;
  moved.x = destination.x;
  moved.y = destination.y;
  applyHazard(state, moved.id);
  return true;
}

function executePlayer(
  state: CinderVaultState,
  plan: CinderPlanState,
  blockedByCollision: boolean,
): boolean {
  if (plan.kind === 'step' || plan.kind === 'vault') {
    if (!blockedByCollision && !stateBlocked(state, plan.target, false)) {
      state.hero.x = plan.target.x;
      state.hero.y = plan.target.y;
      state.lastEvent = `${CINDER_CARDS[plan.kind].name} reached ${cellName(plan.target)}.`;
      return true;
    }
    state.lastEvent = `${CINDER_CARDS[plan.kind].name} was interrupted before reaching ${cellName(plan.target)}.`;
    return false;
  }
  if (plan.kind === 'guard') {
    state.hero.shield += 2;
    state.lastEvent = 'Guard raised two shield.';
    return true;
  }
  if (plan.kind === 'wait') {
    state.lastEvent = 'The Wayfarer waited.';
    return true;
  }
  if (plan.kind === 'bash') {
    const enemy = enemyAt(state.enemies, plan.target);
    if (enemy && distance(state.hero, enemy) === 1) {
      pushEnemy(state, enemy.id, enemy.x - state.hero.x, enemy.y - state.hero.y);
      return true;
    }
    state.lastEvent = `Bash found no enemy at ${cellName(plan.target)}.`;
    return false;
  }
  if (plan.kind === 'hook') {
    const enemy = enemyAt(state.enemies, plan.target);
    if (enemy && hasClearLine(state, state.hero, enemy, state.enemies)) {
      const moved = pushEnemy(
        state,
        enemy.id,
        Math.sign(state.hero.x - enemy.x),
        Math.sign(state.hero.y - enemy.y),
      );
      if (moved) state.lastEvent = `${enemy.name} was pulled off its line.`;
      return true;
    }
    state.lastEvent = `Hook found no enemy at ${cellName(plan.target)}.`;
    return false;
  }
  if (!hasClearLine(state, state.hero, plan.target, state.enemies)) {
    state.lastEvent = `Cinder Bolt lost line of sight to ${cellName(plan.target)}.`;
    return false;
  }
  if (state.barrels.includes(indexAt(plan.target))) {
    explodeBarrel(state, plan.target);
    return true;
  }
  const enemy = enemyAt(state.enemies, plan.target);
  if (!enemy) {
    state.lastEvent = `Cinder Bolt found no enemy at ${cellName(plan.target)}.`;
    return false;
  }
  damageEnemies(state, [enemy.id], 2);
  state.lastEvent = `Cinder Bolt dealt 2 damage to ${enemy.name}.`;
  return true;
}

function executeEnemies(
  state: CinderVaultState,
  intents: readonly CinderEnemyIntent[],
  blockedEnemyIds: ReadonlySet<string>,
): void {
  for (const { enemy: before, intent } of intents) {
    const enemy = state.enemies.find(({ id }) => id === before.id);
    if (!enemy || state.hero.hp <= 0) continue;
    if (enemy.x !== before.x || enemy.y !== before.y) {
      state.lastEvent = `${enemy.name}'s intent was disrupted by forced movement.`;
      continue;
    }
    if (intent.kind === 'attack' && distance(enemy, state.hero) === 1) {
      const blocked = Math.min(state.hero.shield, enemy.damage);
      state.hero.shield -= blocked;
      state.hero.hp = Math.max(0, state.hero.hp - (enemy.damage - blocked));
      state.lastEvent = `${enemy.name} attacked${blocked ? ` · ${blocked} blocked` : ''}.`;
    } else if (intent.kind === 'move'
      && !blockedEnemyIds.has(enemy.id)
      && !stateBlocked(state, intent.target, false)) {
      enemy.x = intent.target.x;
      enemy.y = intent.target.y;
      applyHazard(state, enemy.id);
    }
    state.message = state.lastEvent;
  }
}

function animationFor(
  state: CinderVaultState,
  plan: CinderPlanState,
  beat: number,
  intents: readonly CinderEnemyIntent[],
  movement: MovementResolution,
): Pick<
  CinderBeatTransition,
  'heroMotion' | 'enemyMotions' | 'combatAnimations' | 'hitEnemyIds' | 'heroHit'
> {
  const heroMotion = plan.kind === 'wait'
    ? null
    : plan.kind === 'step' || plan.kind === 'vault'
      ? movement.blockHero ? 'collision' : 'move'
      : plan.kind === 'guard'
        ? 'guard'
        : plan.kind === 'bash' ? 'attack' : 'cast';
  const enemyMotions: Record<string, CinderMotion> = {};
  for (const { enemy, intent } of intents) {
    enemyMotions[enemy.id] = intent.kind === 'move' && movement.blockedEnemyIds.has(enemy.id)
      ? 'collision'
      : intent.kind;
  }
  const combatAnimations: CinderCombatAnimation[] = [];
  const target = enemyAt(state.enemies, plan.target);
  const hitEnemyIds = target ? [target.id] : [];
  if (plan.kind === 'bash' || plan.kind === 'hook' || plan.kind === 'bolt') {
    combatAnimations.push({
      id: `${beat}-player-${plan.kind}`,
      kind: plan.kind === 'bolt' ? 'projectile' : plan.kind === 'hook' ? 'tether' : 'melee',
      sourceId: 'hero',
      from: { x: state.hero.x, y: state.hero.y },
      to: copyPoint(plan.target),
    });
  }
  for (const { enemy, intent } of intents) {
    if (intent.kind !== 'attack') continue;
    combatAnimations.push({
      id: `${beat}-${enemy.id}-melee`,
      kind: 'melee',
      sourceId: enemy.id,
      from: copyPoint(enemy),
      to: copyPoint(intent.target),
    });
  }
  return {
    heroMotion,
    enemyMotions,
    combatAnimations,
    hitEnemyIds,
    heroHit: intents.some(({ intent }) => intent.kind === 'attack'),
  };
}

function waitPlan(hero: CinderPoint, summary = 'Wait · no card programmed'): CinderPlanState {
  return { kind: 'wait', target: copyPoint(hero), summary };
}

function planView(plan: CinderPlanState): CinderPlan {
  return {
    card: cardFor(plan.kind),
    target: copyPoint(plan.target),
    summary: plan.summary,
  };
}

function resolveCommit(state: CinderVaultState): CinderVaultState {
  const next = cloneState(state);
  const committed = next.queue.map((plan) => ({
    ...plan,
    target: copyPoint(plan.target),
  }));
  const plans = committed.map((plan) => ({ ...plan, target: copyPoint(plan.target) }));
  while (plans.length < CINDER_MAX_ACTIONS) plans.push(waitPlan(next.hero));
  const waitCount = CINDER_MAX_ACTIONS - committed.length;
  next.decision = `Committed ${committed.length} card${committed.length === 1 ? '' : 's'}${waitCount ? ` and ${waitCount} Wait` : ''}`;
  const beats: CinderBeatTransition[] = [];
  let interruptedAt: number | null = null;
  let interruptionSummary = '';

  for (let beat = 0; beat < CINDER_MAX_ACTIONS; beat += 1) {
    const plan = plans[beat]!;
    const before = snapshot(next);
    const intents = next.enemies.map((enemy) => enemyIntent(next, enemy));
    const movement = movementResolution(next, plan, intents);
    const animation = animationFor(next, plan, beat, intents, movement);
    next.message = `Beat ${beat + 1}: ${CINDER_CARDS[plan.kind].name} and every enemy response resolve together.`;
    const playerResolved = executePlayer(next, plan, movement.blockHero);
    const playerEvent = next.lastEvent;
    executeEnemies(next, intents, movement.blockedEnemyIds);
    if (movement.collisionCells.size > 0) {
      const cells = [...movement.collisionCells].map((index) => cellName(pointAt(index)));
      next.lastEvent = `Movement collision at ${cells.join(', ')}. Every contender held position.`;
      next.message = next.lastEvent;
    }
    if (!playerResolved && plan.kind !== 'wait') {
      for (let future = beat + 1; future < CINDER_MAX_ACTIONS; future += 1) {
        plans[future] = waitPlan(next.hero, 'Wait · program interrupted');
      }
      const reason = movement.blockHero && movement.collisionCells.size > 0
        ? next.lastEvent
        : playerEvent;
      interruptionSummary = `Program interrupted: ${reason} Later cards became Wait.`;
      interruptedAt = beat;
      next.lastEvent = interruptionSummary;
      next.message = interruptionSummary;
      next.decision = `Program interrupted on beat ${beat + 1}; enemies continue through beat ${CINDER_MAX_ACTIONS}`;
    }
    beats.push({
      beat,
      plan: planView(plan),
      before,
      after: snapshot(next),
      intents: intents.map(copyIntent),
      blockHero: movement.blockHero,
      blockedEnemyIds: [...movement.blockedEnemyIds],
      collisionCells: [...movement.collisionCells],
      ...animation,
      playerResolved,
      lastEvent: next.lastEvent,
    });
    if (next.hero.hp <= 0 || next.enemies.length === 0) break;
  }

  next.queue = [];
  next.discardPile.push(...committed.map(({ kind }) => kind).filter((kind) => kind !== 'wait'));
  drawCards(next);
  if (interruptionSummary) {
    next.lastEvent = `${interruptionSummary} Enemy beats still completed.`;
  }
  next.hero.shield = 0;
  next.turn += 1;
  next.actionsUsed += 1;
  const won = next.room === ROOM_LAYOUTS.length && next.enemies.length === 0;
  const roomCleared = next.enemies.length === 0 && !won;
  if (next.hero.hp <= 0) next.message = 'The Wayfarer fell in the vault.';
  else if (won) next.message = 'The Vault Heart is extinguished. Run complete!';
  else if (roomCleared) {
    next.message = `Chamber ${next.room} solved through environmental combat.`;
  } else next.message = 'Program the next three actions.';
  next.lastEvents = {
    plans: plans.map(planView),
    beats,
    committedCount: committed.length,
    interruptedAt,
  };
  return next;
}

function copyIntent(intent: CinderEnemyIntent): CinderEnemyIntent {
  return {
    enemy: copyEnemy(intent.enemy),
    intent: {
      kind: intent.intent.kind,
      target: copyPoint(intent.intent.target),
    },
  };
}

function copySnapshot(value: CinderSnapshot): CinderSnapshot {
  return {
    hero: copyHero(value.hero),
    enemies: value.enemies.map(copyEnemy),
    barrels: [...value.barrels],
    gateOpen: value.gateOpen,
  };
}

function copyTransition(transition: CinderTransition): CinderTransition {
  return {
    plans: transition.plans.map((plan) => ({
      card: cardFor(plan.card.kind),
      target: copyPoint(plan.target),
      summary: plan.summary,
    })),
    beats: transition.beats.map((beat) => ({
      ...beat,
      plan: {
        card: cardFor(beat.plan.card.kind),
        target: copyPoint(beat.plan.target),
        summary: beat.plan.summary,
      },
      before: copySnapshot(beat.before),
      after: copySnapshot(beat.after),
      intents: beat.intents.map(copyIntent),
      blockedEnemyIds: [...beat.blockedEnemyIds],
      collisionCells: [...beat.collisionCells],
      enemyMotions: { ...beat.enemyMotions },
      combatAnimations: beat.combatAnimations.map((animation) => ({
        ...animation,
        from: copyPoint(animation.from),
        to: copyPoint(animation.to),
      })),
      hitEnemyIds: [...beat.hitEnemyIds],
    })),
    committedCount: transition.committedCount,
    interruptedAt: transition.interruptedAt,
  };
}

function initialState(seed: number): CinderVaultState {
  const room = roomLayout(1);
  const shuffled = shuffle(CARD_KINDS, seed);
  const state: CinderVaultState = {
    seed,
    randomState: shuffled.randomState,
    room: 1,
    turn: 1,
    hero: { x: 0, y: 5, hp: 8, maxHp: 8, shield: 0 },
    enemies: room.enemies,
    walls: room.walls,
    spikes: room.spikes,
    pits: room.pits,
    barrels: room.barrels,
    plate: room.plate,
    gate: room.gate,
    gateOpen: false,
    queue: [],
    hand: [],
    drawPile: shuffled.cards,
    discardPile: [],
    actionsUsed: 0,
    message: 'Program up to three actions, preview the paths, then commit.',
    decision: 'Waiting for a plan',
    lastEvent: 'Entered the first chamber',
    lastEvents: null,
  };
  drawCards(state);
  return state;
}

function availableActions(state: CinderVaultState): {
  plans: CinderLegalPlan[];
  projected: CinderProjectedState;
} {
  const projected = projectQueue(state);
  return { projected, plans: legalPlans(state, projected) };
}

function advance(state: CinderVaultState, inputs: readonly SubmittedAction[]): CinderVaultState {
  if (inputs.length === 0) return state;
  if (inputs.length !== 1) throw new RangeError('Cinder Vault accepts one action per tick');
  const won = state.room === ROOM_LAYOUTS.length && state.enemies.length === 0;
  if (state.hero.hp <= 0 || won) throw new RangeError('Cinder Vault is already terminal');

  const action = inputs[0]!;
  const { plans } = availableActions(state);
  const selected = plans.find((plan) => actionKey(plan.action) === actionKey(action));
  if (selected) {
    const next = cloneState(state);
    const handIndex = next.hand.indexOf(selected.card.kind);
    if (handIndex < 0) throw new RangeError('card is not in hand');
    next.hand.splice(handIndex, 1);
    next.queue.push({
      kind: selected.card.kind,
      target: copyPoint(selected.target),
      summary: selected.summary,
    });
    next.actionsUsed += 1;
    next.lastEvents = null;
    const remaining = CINDER_MAX_ACTIONS - next.queue.length;
    next.message = remaining === 0
      ? 'All three actions are ready. Review the paths, then commit.'
      : `${selected.card.name} added to beat ${next.queue.length}. ${remaining} action${remaining === 1 ? '' : 's'} left.`;
    next.lastEvent = `${selected.card.name} programmed for ${cellName(selected.target)}.`;
    next.decision = `Programming beat ${next.queue.length}`;
    return next;
  }

  if (actionKey(action) === actionKey({ id: CINDER_ACTIONS.commit })) {
    if (state.queue.length === 0) throw new RangeError('commit is not a legal action');
    return resolveCommit(state);
  }
  if (action.id === CINDER_ACTIONS.remove && Number.isInteger(action.index)) {
    const index = action.index!;
    if (index < 0 || index >= state.queue.length) {
      throw new RangeError('remove is not a legal action');
    }
    const next = cloneState(state);
    const returned = next.queue.splice(index);
    next.hand.push(...returned.map(({ kind }) => kind).filter((kind) => kind !== 'wait'));
    next.actionsUsed += 1;
    next.lastEvents = null;
    next.message = `Beat ${index + 1} and the actions after it were cancelled.`;
    next.lastEvent = next.message;
    next.decision = 'Editing the program';
    return next;
  }
  if (actionKey(action) === actionKey({ id: CINDER_ACTIONS.clear })) {
    if (state.queue.length === 0) throw new RangeError('clear is not a legal action');
    const next = cloneState(state);
    next.hand.push(...next.queue.map(({ kind }) => kind).filter((kind) => kind !== 'wait'));
    next.queue = [];
    next.actionsUsed += 1;
    next.lastEvents = null;
    next.message = 'Plan cleared. Choose the first action again.';
    next.lastEvent = next.message;
    next.decision = 'Waiting for a plan';
    return next;
  }
  if (actionKey(action) === actionKey({ id: CINDER_ACTIONS.nextRoom })) {
    if (state.enemies.length !== 0 || state.room >= ROOM_LAYOUTS.length) {
      throw new RangeError('next room is not a legal action');
    }
    const next = cloneState(state);
    next.room += 1;
    next.hero = {
      x: 0,
      y: 5,
      maxHp: next.hero.maxHp + 1,
      hp: Math.min(next.hero.maxHp + 1, next.hero.hp + 3),
      shield: 0,
    };
    const room = roomLayout(next.room);
    next.enemies = room.enemies;
    next.walls = room.walls;
    next.spikes = room.spikes;
    next.pits = room.pits;
    next.barrels = room.barrels;
    next.plate = room.plate;
    next.gate = room.gate;
    next.gateOpen = false;
    next.queue = [];
    next.actionsUsed += 1;
    next.lastEvents = null;
    next.message = `Chamber ${next.room}: inspect the new trap layout.`;
    next.lastEvent = 'Rested and descended.';
    next.decision = 'Waiting for a plan';
    return next;
  }
  throw new RangeError('action is not a legal action');
}

function view(state: CinderVaultState): CinderVaultView {
  const presentation = queuePresentation(state);
  const plans = legalPlans(state, presentation.projected);
  const won = state.room === ROOM_LAYOUTS.length && state.enemies.length === 0;
  const defeated = state.hero.hp <= 0;
  const roomCleared = state.enemies.length === 0 && !won;
  const targeting: Record<string, { targetableCells: Cell[] }> = {};
  for (const plan of plans) {
    const targetable = targeting[plan.action.id]?.targetableCells
      ?? (targeting[plan.action.id] = { targetableCells: [] }).targetableCells;
    targetable.push([plan.target.x, plan.target.y]);
  }
  const cardActions = [...new Set(plans.map(({ action }) => action.id))].map((id) => {
    const kind = CARD_KINDS.find((candidate) => CINDER_ACTIONS[candidate] === id)!;
    return { id, params: 'xy' as const, text: CINDER_CARDS[kind].name };
  });
  const actions = [
    ...cardActions,
    ...(state.queue.length > 0
      ? [
        { id: CINDER_ACTIONS.commit, params: 'none' as const, text: 'Commit program' },
        { id: CINDER_ACTIONS.remove, params: 'index' as const, text: 'Remove plan' },
        { id: CINDER_ACTIONS.clear, params: 'none' as const, text: 'Clear plan' },
      ]
      : []),
    ...(roomCleared
      ? [{ id: CINDER_ACTIONS.nextRoom, params: 'none' as const, text: 'Next chamber' }]
      : []),
  ];
  return {
    seed: state.seed,
    room: state.room,
    turn: state.turn,
    size: CINDER_SIZE,
    maxActions: CINDER_MAX_ACTIONS,
    hero: copyHero(state.hero),
    enemies: state.enemies.map(copyEnemy),
    walls: [...state.walls],
    spikes: [...state.spikes],
    pits: [...state.pits],
    barrels: [...state.barrels],
    plate: state.plate,
    gate: state.gate,
    gateOpen: state.gateOpen,
    queue: state.queue.map(planView),
    hand: state.hand.map(cardFor),
    drawCount: state.drawPile.length,
    discardCount: state.discardPile.length,
    projected: {
      hero: copyPoint(presentation.projected.hero),
      enemies: presentation.projected.enemies.map((enemy) => ({
        ...enemy,
        origin: copyPoint(enemy.origin),
      })),
    },
    previews: presentation.previews.map((preview) => ({
      ...preview,
      cell: copyPoint(preview.cell),
    })),
    trajectories: presentation.trajectories.map((trajectory) => ({
      ...trajectory,
      from: copyPoint(trajectory.from),
      to: copyPoint(trajectory.to),
    })),
    legalPlans: plans.map((plan) => ({
      card: cardFor(plan.card.kind),
      target: copyPoint(plan.target),
      summary: plan.summary,
      action: { ...plan.action },
      preview: plan.preview.map((preview) => ({
        ...preview,
        cell: copyPoint(preview.cell),
      })),
      trajectory: plan.trajectory.map((trajectory) => ({
        ...trajectory,
        from: copyPoint(trajectory.from),
        to: copyPoint(trajectory.to),
      })),
    })),
    roomCleared,
    won,
    defeated,
    message: state.message,
    decision: state.decision,
    lastEvent: state.lastEvent,
    ...(state.lastEvents ? { transition: copyTransition(state.lastEvents) } : {}),
    actions,
    hud: {
      actionsUsed: state.actionsUsed,
      ...(state.queue.length > 0
        ? { items: state.queue.map((_plan, index) => ({ index })) }
        : {}),
    },
    grid: { actionTargeting: targeting },
    status: defeated ? 'failed' : won ? 'won' : 'playing',
  };
}

export const cinderVaultReducer: TickReducer<
  CinderVaultLevel,
  CinderVaultState,
  CinderVaultView
> = {
  init(level, seed) {
    if (level.id !== CINDER_LEVEL.id) throw new RangeError('unknown Cinder Vault level');
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new RangeError('seed must be an unsigned 32-bit integer');
    }
    return initialState(seed);
  },
  advance,
  view,
};

function closestEnemyDistance(
  point: CinderPoint,
  enemies: readonly CinderEnemy[],
): number {
  return enemies.length === 0
    ? 0
    : Math.min(...enemies.map((enemy) => distance(point, enemy)));
}

export function chooseCinderVaultAction(observation: CinderVaultView): SubmittedAction {
  if (observation.roomCleared) return { id: CINDER_ACTIONS.nextRoom };
  if (observation.queue.length >= CINDER_MAX_ACTIONS || observation.legalPlans.length === 0) {
    if (observation.queue.length > 0) return { id: CINDER_ACTIONS.commit };
    throw new RangeError('Cinder Vault has no legal action');
  }
  const adjacentBash = observation.legalPlans.find((plan) => (
    plan.card.kind === 'bash'
    && !!enemyAt(observation.projected.enemies, plan.target)
    && distance(observation.projected.hero, plan.target) === 1
  ));
  if (adjacentBash) return { ...adjacentBash.action };

  const barrelBolt = observation.legalPlans.find((plan) => (
    plan.card.kind === 'bolt'
    && observation.barrels.includes(indexAt(plan.target))
    && !observation.queue.some((queued) => (
      queued.card.kind === 'bolt' && indexAt(queued.target) === indexAt(plan.target)
    ))
  ));
  if (barrelBolt) return { ...barrelBolt.action };

  if (observation.hero.hp <= 4) {
    const guard = observation.legalPlans.find(({ card }) => card.kind === 'guard');
    if (guard) return { ...guard.action };
  }

  const steps = observation.legalPlans
    .filter(({ card }) => card.kind === 'step')
    .sort((left, right) => (
      closestEnemyDistance(left.target, observation.enemies)
      - closestEnemyDistance(right.target, observation.enemies)
      || indexAt(left.target) - indexAt(right.target)
    ));
  if (steps[0]) return { ...steps[0].action };
  return { ...observation.legalPlans[0]!.action };
}

export function describeCinderVaultAction(
  observation: CinderVaultView,
  action: SubmittedAction,
): string {
  if (action.id === CINDER_ACTIONS.commit) {
    return `Agent committed ${observation.queue.length} programmed card${observation.queue.length === 1 ? '' : 's'}`;
  }
  if (action.id === CINDER_ACTIONS.nextRoom) return 'Agent descended to the next chamber';
  const plan = observation.legalPlans.find(
    (candidate) => actionKey(candidate.action) === actionKey(action),
  );
  return plan
    ? `${plan.card.name} selected from ${observation.legalPlans.length} legal card-target pairs`
    : 'No legal action selected';
}

export function createCinderVaultEnvironment(seed: number) {
  return new AgentEnvironment({
    reducer: cinderVaultReducer,
    level: CINDER_LEVEL,
    seed,
    maxTicks: 300,
  });
}
