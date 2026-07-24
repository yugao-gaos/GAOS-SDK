<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue';
import { withBase } from 'vitepress';
import { manhattan, wait, type Point } from './game-utils';

type CardKind = 'step' | 'vault' | 'bash' | 'hook' | 'bolt' | 'guard' | 'wait';
type Card = { kind: CardKind; name: string; text: string; glyph: string };
type Enemy = Point & { id: string; name: string; hp: number; maxHp: number; damage: number };
type Plan = { card: Card; target: Point; summary: string };
type EnemyIntent = { enemy: Enemy; intent: { kind: 'attack' | 'move'; target: Point } };
type Preview = { kind: 'move' | 'attack' | 'guard'; beat: number; endpoint: boolean; ghost: boolean };
type ProjectedEnemy = Enemy & { origin: Point; movedAt: number | null };
type ProjectedState = { hero: Point; enemies: ProjectedEnemy[] };
type TrajectorySegment = {
  kind: 'move' | 'attack' | 'displacement';
  beat: number;
  from: Point;
  to: Point;
  ghost: boolean;
};
type Motion = 'move' | 'attack' | 'cast' | 'guard' | 'collision';
type CombatAnimation = {
  id: string;
  kind: 'projectile' | 'melee' | 'tether';
  sourceId: string;
  from: Point;
  to: Point;
};
type MovementResolution = {
  blockHero: boolean;
  blockedEnemyIds: Set<string>;
  collisionCells: Set<number>;
};

const size = 6;
const maxActions = 3;
const handSize = 4;
const cards: Card[] = [
  { kind: 'step', name: 'Step', text: 'Move one tile.', glyph: '→' },
  { kind: 'vault', name: 'Vault', text: 'Jump over an obstacle.', glyph: '⌁' },
  { kind: 'bash', name: 'Bash', text: 'Push an adjacent enemy.', glyph: '»' },
  { kind: 'hook', name: 'Hook', text: 'Pull a visible enemy closer.', glyph: '↢' },
  { kind: 'bolt', name: 'Cinder Bolt', text: 'Damage a foe or ignite a barrel.', glyph: '✦' },
  { kind: 'guard', name: 'Guard', text: 'Gain two shield.', glyph: '◇' },
];
const waitCard: Card = { kind: 'wait', name: 'Wait', text: 'Take no action this beat.', glyph: '·' };

const seed = ref(616);
const room = ref(1);
const turn = ref(1);
const hero = ref({ x: 0, y: 5, hp: 8, maxHp: 8, shield: 0 });
const enemies = ref<Enemy[]>([]);
const walls = ref(new Set<number>());
const spikes = ref(new Set<number>());
const pits = ref(new Set<number>());
const barrels = ref(new Set<number>());
const plate = ref<number | null>(null);
const gate = ref<number | null>(null);
const gateOpen = ref(false);
const queue = ref<Plan[]>([]);
const hand = ref<Card[]>([]);
const drawPile = ref<Card[]>([]);
const discardPile = ref<Card[]>([]);
const selectedKind = ref<CardKind | null>(null);
const hoveredIndex = ref<number | null>(null);
const resolving = ref(false);
const autoplay = ref(false);
const activeBeat = ref<number | null>(null);
const heroMotion = ref<Motion | null>(null);
const enemyMotions = ref<Record<string, Motion>>({});
const combatAnimations = ref<CombatAnimation[]>([]);
const hitEnemyIds = ref(new Set<string>());
const delayedHitEnemyIds = ref(new Set<string>());
const heroHit = ref(false);
const collisionCells = ref(new Set<number>());
const message = ref('Program up to three actions, preview the paths, then commit.');
const decision = ref('Waiting for a plan');
const lastEvent = ref('Entered the vault');
let runToken = 0;

const actionsLeft = computed(() => maxActions - queue.value.length);
const selectedCard = computed(() => hand.value.find((card) => card.kind === selectedKind.value) ?? null);
const projectedState = computed(() => simulatePlans(queue.value));
const virtualHero = computed(() => projectedState.value.hero);
const projectedEnemies = computed(() => projectedState.value.enemies);
const phantomEnemies = computed(() => resolving.value ? [] : projectedEnemies.value.filter((enemy) => (
  enemy.x !== enemy.origin.x || enemy.y !== enemy.origin.y
)));
const won = computed(() => room.value === 3 && enemies.value.length === 0);
const defeated = computed(() => hero.value.hp <= 0);
const roomCleared = computed(() => enemies.value.length === 0 && !won.value);
const targetCells = computed(() => new Set(selectedCard.value ? legalTargets(selectedCard.value).map(indexAt) : []));
const previewCells = computed(() => {
  const previews = new Map<number, Preview>();
  if (resolving.value) return previews;
  const state = initialProjectedState();
  queue.value.forEach((plan, index) => {
    addPreview(previews, state.hero, plan.card, plan.target, index + 1, false);
    applyProjectedBeat(state, plan, index + 1);
  });
  if (selectedCard.value && hoveredIndex.value !== null && targetCells.value.has(hoveredIndex.value)) {
    addPreview(previews, state.hero, selectedCard.value, pointAt(hoveredIndex.value), queue.value.length + 1, true);
  }
  return previews;
});
const trajectorySegments = computed(() => {
  const segments: TrajectorySegment[] = [];
  if (resolving.value) return segments;
  const state = initialProjectedState();
  queue.value.forEach((plan, index) => {
    addTrajectory(segments, state, plan, index + 1, false);
    applyProjectedBeat(state, plan, index + 1);
  });
  if (selectedCard.value && hoveredIndex.value !== null && targetCells.value.has(hoveredIndex.value)) {
    addTrajectory(segments, state, {
      card: selectedCard.value,
      target: pointAt(hoveredIndex.value),
      summary: '',
    }, queue.value.length + 1, true);
  }
  return segments;
});
function indexAt(point: Point) {
  return point.y * size + point.x;
}

function pointAt(index: number) {
  return { x: index % size, y: Math.floor(index / size) };
}

function cellName(point: Point) {
  return `${String.fromCharCode(65 + point.x)}${point.y + 1}`;
}

function inside(point: Point) {
  return point.x >= 0 && point.y >= 0 && point.x < size && point.y < size;
}

function enemyAt(point: Point) {
  return enemies.value.find((enemy) => enemy.x === point.x && enemy.y === point.y);
}

function projectedEnemyAt(point: Point, projected = projectedEnemies.value) {
  return projected.find((enemy) => enemy.x === point.x && enemy.y === point.y);
}

function phantomAt(point: Point) {
  return phantomEnemies.value.find((enemy) => enemy.x === point.x && enemy.y === point.y);
}

function isBlocked(point: Point, includeHero = true) {
  const index = indexAt(point);
  return !inside(point)
    || walls.value.has(index)
    || (gate.value === index && !gateOpen.value)
    || barrels.value.has(index)
    || !!enemyAt(point)
    || (includeHero && hero.value.x === point.x && hero.value.y === point.y);
}

function terrainBlocked(point: Point) {
  const index = indexAt(point);
  return !inside(point)
    || walls.value.has(index)
    || (gate.value === index && !gateOpen.value);
}

function initialProjectedState(): ProjectedState {
  return {
    hero: { x: hero.value.x, y: hero.value.y },
    enemies: enemies.value.map((enemy) => ({
      ...enemy,
      origin: { x: enemy.x, y: enemy.y },
      movedAt: null,
    })),
  };
}

function cloneProjectedState(state: ProjectedState): ProjectedState {
  return {
    hero: { ...state.hero },
    enemies: state.enemies.map((enemy) => ({ ...enemy, origin: { ...enemy.origin } })),
  };
}

function isBlockedInProjectedState(point: Point, state: ProjectedState, includeHero = true) {
  const index = indexAt(point);
  return terrainBlocked(point)
    || barrels.value.has(index)
    || !!projectedEnemyAt(point, state.enemies)
    || (includeHero && state.hero.x === point.x && state.hero.y === point.y);
}

function pushProjectedEnemy(state: ProjectedState, enemyId: string, dx: number, dy: number, beat: number): boolean {
  const enemy = state.enemies.find((item) => item.id === enemyId);
  if (!enemy) return false;
  const destination = { x: enemy.x + dx, y: enemy.y + dy };
  if (terrainBlocked(destination) || (destination.x === state.hero.x && destination.y === state.hero.y)) return false;
  const chained = projectedEnemyAt(destination, state.enemies);
  if (chained && !pushProjectedEnemy(state, chained.id, dx, dy, beat)) return false;
  enemy.x = destination.x;
  enemy.y = destination.y;
  enemy.movedAt = beat;
  const destinationIndex = indexAt(destination);
  if (pits.value.has(destinationIndex)) {
    state.enemies = state.enemies.filter((item) => item.id !== enemy.id);
  } else if (spikes.value.has(destinationIndex)) {
    enemy.hp -= 2;
    if (enemy.hp <= 0) state.enemies = state.enemies.filter((item) => item.id !== enemy.id);
  }
  return true;
}

function applyProjectedPlan(state: ProjectedState, plan: Plan, beat: number) {
  const kind = plan.card.kind;
  if (kind === 'step' || kind === 'vault') {
    state.hero = { ...plan.target };
    return;
  }
  if (kind === 'bash' || kind === 'hook') {
    const enemy = projectedEnemyAt(plan.target, state.enemies);
    if (!enemy) return;
    const dx = kind === 'bash' ? Math.sign(enemy.x - state.hero.x) : Math.sign(state.hero.x - enemy.x);
    const dy = kind === 'bash' ? Math.sign(enemy.y - state.hero.y) : Math.sign(state.hero.y - enemy.y);
    pushProjectedEnemy(state, enemy.id, dx, dy, beat);
    return;
  }
  if (kind === 'bolt') {
    const enemy = projectedEnemyAt(plan.target, state.enemies);
    if (enemy) {
      enemy.hp -= 2;
      if (enemy.hp <= 0) state.enemies = state.enemies.filter((item) => item.id !== enemy.id);
    }
  }
}

function applyProjectedBeat(state: ProjectedState, plan: Plan, beat: number) {
  applyProjectedPlan(state, plan, beat);
}

function simulatePlans(plans: Plan[]) {
  const state = initialProjectedState();
  plans.forEach((plan, index) => applyProjectedBeat(state, plan, index + 1));
  return state;
}

function lineDirections() {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]];
}

function straightLine(origin: Point, target: Point) {
  if (origin.x !== target.x && origin.y !== target.y) return [];
  const dx = Math.sign(target.x - origin.x);
  const dy = Math.sign(target.y - origin.y);
  const points: Point[] = [];
  let point = { ...origin };
  while (point.x !== target.x || point.y !== target.y) {
    point = { x: point.x + dx, y: point.y + dy };
    points.push(point);
  }
  return points;
}

function hasClearLine(origin: Point, target: Point, projected = projectedEnemies.value) {
  const line = straightLine(origin, target);
  if (!line.length || line.length > 3) return false;
  return line.slice(0, -1).every((point) => {
    const index = indexAt(point);
    return !walls.value.has(index)
      && !(gate.value === index && !gateOpen.value)
      && !barrels.value.has(index)
      && !projectedEnemyAt(point, projected);
  });
}

function predictiveLineTargets(origin: Point, state: ProjectedState, allowBarrelTarget: boolean) {
  return lineDirections().flatMap(([dx, dy]) => [1, 2, 3]
    .map((distance) => ({ x: origin.x + dx * distance, y: origin.y + dy * distance }))
    .filter((target) => inside(target)
      && !terrainBlocked(target)
      && (allowBarrelTarget || !barrels.value.has(indexAt(target)))
      && hasClearLine(origin, target, state.enemies)));
}

function addTrajectory(segments: TrajectorySegment[], state: ProjectedState, plan: Plan, beat: number, ghost: boolean) {
  const from = { ...state.hero };
  const kind = plan.card.kind;
  if (kind === 'step' || kind === 'vault') {
    segments.push({ kind: 'move', beat, from, to: { ...plan.target }, ghost });
    return;
  }
  if (kind === 'guard' || kind === 'wait') return;
  segments.push({ kind: 'attack', beat, from, to: { ...plan.target }, ghost });
  if (kind !== 'bash' && kind !== 'hook') return;
  const enemy = projectedEnemyAt(plan.target, state.enemies);
  if (!enemy) return;
  const next = cloneProjectedState(state);
  applyProjectedPlan(next, plan, beat);
  const moved = next.enemies.find((item) => item.id === enemy.id);
  if (moved && (moved.x !== enemy.x || moved.y !== enemy.y)) {
    segments.push({
      kind: 'displacement',
      beat,
      from: { x: enemy.x, y: enemy.y },
      to: { x: moved.x, y: moved.y },
      ghost,
    });
  }
}

function segmentCoordinates(segment: TrajectorySegment) {
  const dx = segment.to.x - segment.from.x;
  const dy = segment.to.y - segment.from.y;
  const length = Math.max(Math.hypot(dx, dy), 1);
  const inset = Math.min(0.28, length * 0.22);
  return {
    x1: segment.from.x + 0.5 + (dx / length) * inset,
    y1: segment.from.y + 0.5 + (dy / length) * inset,
    x2: segment.to.x + 0.5 - (dx / length) * inset,
    y2: segment.to.y + 0.5 - (dy / length) * inset,
  };
}

function addPreview(previews: Map<number, Preview>, origin: Point, card: Card, target: Point, beat: number, ghost: boolean) {
  if (card.kind === 'wait') return;
  let points: Point[] = [];
  let kind: Preview['kind'] = 'attack';
  if (card.kind === 'step') {
    kind = 'move';
    points = [target];
  } else if (card.kind === 'vault') {
    kind = 'move';
    points = [
      { x: (origin.x + target.x) / 2, y: (origin.y + target.y) / 2 },
      target,
    ];
  } else if (card.kind === 'guard') {
    kind = 'guard';
    points = [origin];
  } else {
    points = straightLine(origin, target);
    if (!points.length) points = [target];
    if (card.kind === 'bash') {
      const dx = Math.sign(target.x - origin.x);
      const dy = Math.sign(target.y - origin.y);
      const pushed = { x: target.x + dx, y: target.y + dy };
      if (inside(pushed)) points.push(pushed);
    }
  }
  points.forEach((point, index) => previews.set(indexAt(point), {
    kind,
    beat,
    endpoint: index === points.length - 1 || (card.kind === 'bash' && index === 0),
    ghost,
  }));
}

function previewAt(index: number) {
  return previewCells.value.get(index);
}

function tokenFor(enemy: Enemy) {
  if (enemy.name === 'Sentinel') return withBase('/images/cinder-vault/sentinel.webp');
  if (enemy.name === 'Vault Heart') return withBase('/images/cinder-vault/vault-heart.webp');
  if (enemy.name === 'Wisp') return withBase('/images/cinder-vault/wisp.webp');
  return withBase('/images/cinder-vault/ashling.webp');
}

function isElite(enemy: Enemy) {
  return enemy.name === 'Sentinel' || enemy.name === 'Vault Heart';
}

function spawnRoom(number: number) {
  const layouts = [
    {
      enemies: [
        { id: 'ash-a', name: 'Ashling', x: 3, y: 4, hp: 3, maxHp: 3, damage: 1 },
        { id: 'ash-b', name: 'Ashling', x: 5, y: 2, hp: 3, maxHp: 3, damage: 1 },
      ],
      walls: [14, 20], spikes: [28, 10], pits: [5], barrels: [16], plate: 8, gate: 9,
    },
    {
      enemies: [
        { id: 'sentinel', name: 'Sentinel', x: 4, y: 4, hp: 5, maxHp: 5, damage: 2 },
        { id: 'ash-c', name: 'Ashling', x: 2, y: 1, hp: 3, maxHp: 3, damage: 1 },
      ],
      walls: [13, 14, 22], spikes: [21, 27], pits: [4, 11], barrels: [17, 29], plate: 18, gate: 19,
    },
    {
      enemies: [
        { id: 'heart', name: 'Vault Heart', x: 4, y: 1, hp: 7, maxHp: 7, damage: 2 },
        { id: 'wisp', name: 'Wisp', x: 3, y: 4, hp: 3, maxHp: 3, damage: 1 },
      ],
      walls: [8, 14, 20], spikes: [9, 15, 27], pits: [5, 30], barrels: [16, 28], plate: 21, gate: 22,
    },
  ][number - 1];
  enemies.value = layouts.enemies.map((enemy) => ({ ...enemy }));
  walls.value = new Set(layouts.walls);
  spikes.value = new Set(layouts.spikes);
  pits.value = new Set(layouts.pits);
  barrels.value = new Set(layouts.barrels);
  plate.value = layouts.plate;
  gate.value = layouts.gate;
  gateOpen.value = false;
}

function nextRandom() {
  seed.value = (seed.value * 1664525 + 1013904223) >>> 0;
  return seed.value / 4294967296;
}

function shuffleCards(source: Card[]) {
  const shuffled = [...source];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(nextRandom() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

function refillDrawPile() {
  if (drawPile.value.length || !discardPile.value.length) return;
  drawPile.value = shuffleCards(discardPile.value);
  discardPile.value = [];
}

function drawToHand() {
  while (hand.value.length < handSize) {
    refillDrawPile();
    const card = drawPile.value.shift();
    if (!card) break;
    hand.value.push(card);
  }
}

function resetDeck() {
  hand.value = [];
  discardPile.value = [];
  drawPile.value = shuffleCards(cards);
  drawToHand();
}

function returnPlansToHand(plans: Plan[]) {
  hand.value.push(...plans.map((plan) => plan.card).filter((card) => card.kind !== 'wait'));
}

function discardPlans(plans: Plan[]) {
  discardPile.value.push(...plans.map((plan) => plan.card).filter((card) => card.kind !== 'wait'));
}

function waitPlan(summary = 'Wait · no card programmed'): Plan {
  return { card: waitCard, target: { x: hero.value.x, y: hero.value.y }, summary };
}

function reset() {
  runToken += 1;
  room.value = 1;
  turn.value = 1;
  hero.value = { x: 0, y: 5, hp: 8, maxHp: 8, shield: 0 };
  queue.value = [];
  selectedKind.value = null;
  hoveredIndex.value = null;
  resolving.value = false;
  autoplay.value = false;
  activeBeat.value = null;
  heroMotion.value = null;
  enemyMotions.value = {};
  combatAnimations.value = [];
  hitEnemyIds.value = new Set();
  delayedHitEnemyIds.value = new Set();
  heroHit.value = false;
  collisionCells.value = new Set();
  resetDeck();
  spawnRoom(1);
  message.value = 'Program up to three actions, preview the paths, then commit.';
  decision.value = 'Waiting for a plan';
  lastEvent.value = 'Entered the first chamber';
}

function legalTargets(card: Card): Point[] {
  if (queue.value.length >= maxActions || resolving.value) return [];
  const state = projectedState.value;
  const origin = state.hero;
  if (card.kind === 'wait') return [];
  if (card.kind === 'guard') return [{ ...origin }];
  if (card.kind === 'step') {
    return lineDirections().map(([dx, dy]) => ({ x: origin.x + dx, y: origin.y + dy }))
      .filter((point) => inside(point) && !isBlockedInProjectedState(point, state, false));
  }
  if (card.kind === 'vault') {
    return lineDirections().flatMap(([dx, dy]) => {
      const middle = { x: origin.x + dx, y: origin.y + dy };
      const landing = { x: origin.x + dx * 2, y: origin.y + dy * 2 };
      return inside(landing)
        && isBlockedInProjectedState(middle, state, false)
        && !isBlockedInProjectedState(landing, state, false) ? [landing] : [];
    });
  }
  if (card.kind === 'bash') {
    return lineDirections()
      .map(([dx, dy]) => ({ x: origin.x + dx, y: origin.y + dy }))
      .filter((target) => inside(target)
        && !terrainBlocked(target)
        && !barrels.value.has(indexAt(target)));
  }
  if (card.kind === 'hook') return predictiveLineTargets(origin, state, false);
  return predictiveLineTargets(origin, state, true);
}

function chooseCard(card: Card) {
  if (queue.value.length >= maxActions || resolving.value) return;
  selectedKind.value = selectedKind.value === card.kind ? null : card.kind;
  hoveredIndex.value = null;
  message.value = selectedKind.value ? card.text : 'Choose a card.';
}

function chooseTile(point: Point) {
  const card = selectedCard.value;
  if (!card || !targetCells.value.has(indexAt(point))) return;
  queue.value.push({ card, target: { ...point }, summary: `${card.name} → ${String.fromCharCode(65 + point.x)}${point.y + 1}` });
  hand.value = hand.value.filter((item) => item.kind !== card.kind);
  selectedKind.value = null;
  hoveredIndex.value = null;
  message.value = queue.value.length === maxActions
    ? 'All three actions are ready. Review the paths, then commit.'
    : `${card.name} added to beat ${queue.value.length}. ${actionsLeft.value} action${actionsLeft.value === 1 ? '' : 's'} left.`;
}

function removePlan(index: number) {
  if (!resolving.value) {
    const returned = queue.value.splice(index);
    returnPlansToHand(returned);
    selectedKind.value = null;
    hoveredIndex.value = null;
    message.value = `Beat ${index + 1} and the actions after it were cancelled.`;
  }
}

function cancelSelection() {
  if (resolving.value) return;
  selectedKind.value = null;
  hoveredIndex.value = null;
  message.value = queue.value.length ? 'Selection cancelled. Your queued actions are unchanged.' : 'Choose a card.';
}

function clearPlan() {
  if (resolving.value) return;
  returnPlansToHand(queue.value);
  queue.value = [];
  selectedKind.value = null;
  hoveredIndex.value = null;
  message.value = 'Plan cleared. Choose the first action again.';
}

function applyHazard(enemy: Enemy) {
  const index = indexAt(enemy);
  if (pits.value.has(index)) {
    enemies.value = enemies.value.filter((item) => item.id !== enemy.id);
    lastEvent.value = `${enemy.name} fell into the abyss.`;
    return;
  }
  if (spikes.value.has(index)) {
    enemies.value = enemies.value.map((item) => item.id === enemy.id ? { ...item, hp: item.hp - 2 } : item).filter((item) => item.hp > 0);
    lastEvent.value = `${enemy.name} landed on spikes for 2 damage.`;
  }
  if (plate.value === index) {
    gateOpen.value = true;
    lastEvent.value = `${enemy.name} triggered the gate plate.`;
  }
}

function explodeBarrel(point: Point) {
  barrels.value = new Set([...barrels.value].filter((index) => index !== indexAt(point)));
  enemies.value = enemies.value
    .map((enemy) => manhattan(point, enemy) <= 1 ? { ...enemy, hp: enemy.hp - 3 } : enemy)
    .filter((enemy) => enemy.hp > 0);
  if (manhattan(point, hero.value) <= 1) hero.value = { ...hero.value, hp: Math.max(0, hero.value.hp - 2) };
  lastEvent.value = 'The cinder barrel exploded in a chain reaction.';
}

function pushEnemy(enemy: Enemy, dx: number, dy: number): boolean {
  const destination = { x: enemy.x + dx, y: enemy.y + dy };
  const chained = enemyAt(destination);
  if (chained && !pushEnemy(chained, dx, dy)) {
    enemies.value = enemies.value.map((item) => item.id === enemy.id || item.id === chained.id ? { ...item, hp: item.hp - 1 } : item).filter((item) => item.hp > 0);
    lastEvent.value = 'The push chain collapsed into collision damage.';
    return false;
  }
  if (!inside(destination) || walls.value.has(indexAt(destination)) || (gate.value === indexAt(destination) && !gateOpen.value)) {
    enemies.value = enemies.value.map((item) => item.id === enemy.id ? { ...item, hp: item.hp - 1 } : item).filter((item) => item.hp > 0);
    lastEvent.value = `${enemy.name} slammed into stone.`;
    return false;
  }
  if (barrels.value.has(indexAt(destination))) {
    explodeBarrel(destination);
    enemies.value = enemies.value.map((item) => item.id === enemy.id ? { ...item, ...destination } : item);
    return true;
  }
  enemies.value = enemies.value.map((item) => item.id === enemy.id ? { ...item, ...destination } : item);
  const moved = enemies.value.find((item) => item.id === enemy.id);
  if (moved) applyHazard(moved);
  return true;
}

function executePlayer(plan: Plan, blockedByCollision = false): boolean {
  const card = plan.card.kind;
  let resolved = true;
  if (card === 'step' || card === 'vault') {
    if (!blockedByCollision && !isBlocked(plan.target, false)) {
      hero.value = { ...hero.value, ...plan.target };
      lastEvent.value = `${plan.card.name} reached ${cellName(plan.target)}.`;
    } else {
      resolved = false;
      lastEvent.value = `${plan.card.name} was interrupted before reaching ${cellName(plan.target)}.`;
    }
  } else if (card === 'guard') {
    hero.value = { ...hero.value, shield: hero.value.shield + 2 };
    lastEvent.value = 'Guard raised two shield.';
  } else if (card === 'wait') {
    lastEvent.value = 'The Wayfarer waited.';
  } else if (card === 'bash') {
    const enemy = enemyAt(plan.target);
    if (enemy && manhattan(hero.value, enemy) === 1) pushEnemy(enemy, enemy.x - hero.value.x, enemy.y - hero.value.y);
    else {
      resolved = false;
      lastEvent.value = `Bash found no enemy at ${cellName(plan.target)}.`;
    }
  } else if (card === 'hook') {
    const enemy = enemyAt(plan.target);
    if (enemy && hasClearLine(hero.value, enemy, enemies.value)) {
      const dx = Math.sign(hero.value.x - enemy.x);
      const dy = Math.sign(hero.value.y - enemy.y);
      if (pushEnemy(enemy, dx, dy)) lastEvent.value = `${enemy.name} was pulled off its line.`;
    } else {
      resolved = false;
      lastEvent.value = `Hook found no enemy at ${cellName(plan.target)}.`;
    }
  } else {
    if (!hasClearLine(hero.value, plan.target, enemies.value)) {
      resolved = false;
      lastEvent.value = `Cinder Bolt lost line of sight to ${cellName(plan.target)}.`;
    } else if (barrels.value.has(indexAt(plan.target))) {
      explodeBarrel(plan.target);
    } else {
      const enemy = enemyAt(plan.target);
      if (enemy) {
        enemies.value = enemies.value.map((item) => item.id === enemy.id ? { ...item, hp: item.hp - 2 } : item).filter((item) => item.hp > 0);
        lastEvent.value = `Cinder Bolt dealt 2 damage to ${enemy.name}.`;
      } else {
        resolved = false;
        lastEvent.value = `Cinder Bolt found no enemy at ${cellName(plan.target)}.`;
      }
    }
  }
  message.value = lastEvent.value;
  return resolved;
}

function enemyIntent(enemy: Enemy) {
  if (manhattan(enemy, hero.value) === 1) return { kind: 'attack' as const, target: { x: hero.value.x, y: hero.value.y } };
  const candidates = lineDirections()
    .map(([dx, dy]) => ({ x: enemy.x + dx, y: enemy.y + dy }))
    .filter((point) => inside(point) && !isBlocked(point, false));
  candidates.sort((a, b) => manhattan(a, hero.value) - manhattan(b, hero.value) || indexAt(a) - indexAt(b));
  return { kind: 'move' as const, target: candidates[0] ?? { x: enemy.x, y: enemy.y } };
}

function resolveMovementConflicts(plan: Plan, intents: EnemyIntent[]): MovementResolution {
  const proposals = new Map<number, Array<{ kind: 'hero' | 'enemy'; id: string }>>();
  const addProposal = (target: Point, proposal: { kind: 'hero' | 'enemy'; id: string }) => {
    const index = indexAt(target);
    proposals.set(index, [...(proposals.get(index) ?? []), proposal]);
  };
  if ((plan.card.kind === 'step' || plan.card.kind === 'vault') && !isBlocked(plan.target, false)) {
    addProposal(plan.target, { kind: 'hero', id: 'hero' });
  }
  for (const { enemy, intent } of intents) {
    if (intent.kind !== 'move' || (intent.target.x === enemy.x && intent.target.y === enemy.y)) continue;
    addProposal(intent.target, { kind: 'enemy', id: enemy.id });
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

function executeEnemies(intents: EnemyIntent[], blockedEnemyIds = new Set<string>()) {
  for (const { enemy: snapshot, intent } of intents) {
    const enemy = enemies.value.find((item) => item.id === snapshot.id);
    if (!enemy || hero.value.hp <= 0) continue;
    if (enemy.x !== snapshot.x || enemy.y !== snapshot.y) {
      lastEvent.value = `${enemy.name}'s intent was disrupted by forced movement.`;
      continue;
    }
    if (intent.kind === 'attack' && manhattan(enemy, hero.value) === 1) {
      const blockedDamage = Math.min(hero.value.shield, enemy.damage);
      hero.value = {
        ...hero.value,
        shield: hero.value.shield - blockedDamage,
        hp: Math.max(0, hero.value.hp - (enemy.damage - blockedDamage)),
      };
      lastEvent.value = `${enemy.name} attacked${blockedDamage ? ` · ${blockedDamage} blocked` : ''}.`;
    } else if (intent.kind === 'move' && !blockedEnemyIds.has(enemy.id) && !isBlocked(intent.target, false)) {
      enemies.value = enemies.value.map((item) => item.id === enemy.id ? { ...item, ...intent.target } : item);
      const moved = enemies.value.find((item) => item.id === enemy.id);
      if (moved) applyHazard(moved);
    }
    message.value = lastEvent.value;
  }
}

function animationCenter(point: Point) {
  return { x: point.x + 0.5, y: point.y + 0.5 };
}

function meleeSlashCoordinates(animation: CombatAnimation) {
  const target = animationCenter(animation.to);
  const dx = animation.to.x - animation.from.x;
  const dy = animation.to.y - animation.from.y;
  const length = Math.hypot(dx, dy) || 1;
  const perpendicular = { x: -dy / length, y: dx / length };
  return {
    x1: target.x - perpendicular.x * 0.32,
    y1: target.y - perpendicular.y * 0.32,
    x2: target.x + perpendicular.x * 0.32,
    y2: target.y + perpendicular.y * 0.32,
  };
}

function attackLungeStyle(sourceId: string) {
  const animation = combatAnimations.value.find((item) => item.sourceId === sourceId && item.kind === 'melee');
  if (!animation) return {};
  return {
    '--strike-x': `${Math.sign(animation.to.x - animation.from.x) * 12}px`,
    '--strike-y': `${Math.sign(animation.to.y - animation.from.y) * 12}px`,
  };
}

function prepareAnimations(plan: Plan, intents: EnemyIntent[], movement: MovementResolution) {
  heroMotion.value = plan.card.kind === 'wait'
    ? null
    : plan.card.kind === 'step' || plan.card.kind === 'vault'
    ? movement.blockHero ? 'collision' : 'move'
    : plan.card.kind === 'guard'
      ? 'guard'
      : plan.card.kind === 'bash' ? 'attack' : 'cast';
  enemyMotions.value = Object.fromEntries(intents.map(({ enemy, intent }) => [
    enemy.id,
    intent.kind === 'move' && movement.blockedEnemyIds.has(enemy.id) ? 'collision' : intent.kind,
  ]));
  collisionCells.value = new Set(movement.collisionCells);
  const animations: CombatAnimation[] = [];
  const hitIds = new Set<string>();
  const delayedIds = new Set<string>();
  const playerTarget = enemyAt(plan.target);
  if (plan.card.kind === 'bash' || plan.card.kind === 'hook' || plan.card.kind === 'bolt') {
    const kind = plan.card.kind === 'bolt' ? 'projectile' : plan.card.kind === 'hook' ? 'tether' : 'melee';
    animations.push({
      id: `${activeBeat.value ?? 0}-player-${plan.card.kind}`,
      kind,
      sourceId: 'hero',
      from: { x: hero.value.x, y: hero.value.y },
      to: { ...plan.target },
    });
    if (playerTarget) {
      hitIds.add(playerTarget.id);
      if (kind !== 'melee') delayedIds.add(playerTarget.id);
    }
  }
  for (const { enemy, intent } of intents) {
    if (intent.kind !== 'attack') continue;
    animations.push({
      id: `${activeBeat.value ?? 0}-${enemy.id}-melee`,
      kind: 'melee',
      sourceId: enemy.id,
      from: { x: enemy.x, y: enemy.y },
      to: { ...intent.target },
    });
  }
  combatAnimations.value = animations;
  hitEnemyIds.value = hitIds;
  delayedHitEnemyIds.value = delayedIds;
  heroHit.value = intents.some(({ intent }) => intent.kind === 'attack');
}

function clearAnimations() {
  heroMotion.value = null;
  enemyMotions.value = {};
  combatAnimations.value = [];
  hitEnemyIds.value = new Set();
  delayedHitEnemyIds.value = new Set();
  heroHit.value = false;
  collisionCells.value = new Set();
}

async function commitTurn() {
  if (!queue.value.length || resolving.value || defeated.value || roomCleared.value || won.value) return;
  resolving.value = true;
  selectedKind.value = null;
  hoveredIndex.value = null;
  const token = runToken;
  const committedPlans = [...queue.value];
  const plans = [...committedPlans];
  while (plans.length < maxActions) plans.push(waitPlan());
  queue.value = [...plans];
  const waitCount = maxActions - committedPlans.length;
  decision.value = `Committed ${committedPlans.length} card${committedPlans.length === 1 ? '' : 's'}${waitCount ? ` and ${waitCount} Wait` : ''}`;
  let interruptionSummary = '';
  for (let beat = 0; beat < maxActions && token === runToken; beat += 1) {
    const plan = plans[beat];
    const intents: EnemyIntent[] = enemies.value.map((enemy) => ({ enemy: { ...enemy }, intent: enemyIntent(enemy) }));
    const movement = resolveMovementConflicts(plan, intents);
    activeBeat.value = beat;
    clearAnimations();
    await nextTick();
    prepareAnimations(plan, intents, movement);
    message.value = `Beat ${beat + 1}: ${plan.card.name} and every enemy response resolve together.`;
    const playerResolved = executePlayer(plan, movement.blockHero);
    const playerEvent = lastEvent.value;
    executeEnemies(intents, movement.blockedEnemyIds);
    let collisionEvent = '';
    if (movement.collisionCells.size) {
      const cells = [...movement.collisionCells].map((index) => {
        const point = pointAt(index);
        return `${String.fromCharCode(65 + point.x)}${point.y + 1}`;
      });
      collisionEvent = `Movement collision at ${cells.join(', ')}. Every contender held position.`;
      lastEvent.value = collisionEvent;
      message.value = lastEvent.value;
    }
    if (!playerResolved && plan.card.kind !== 'wait') {
      for (let futureBeat = beat + 1; futureBeat < maxActions; futureBeat += 1) {
        plans[futureBeat] = waitPlan('Wait · program interrupted');
      }
      queue.value = [...plans];
      const reason = movement.blockHero && collisionEvent ? collisionEvent : playerEvent;
      interruptionSummary = `Program interrupted: ${reason} Later cards became Wait.`;
      lastEvent.value = interruptionSummary;
      message.value = lastEvent.value;
      decision.value = `Program interrupted on beat ${beat + 1}; enemies continue through beat ${maxActions}`;
    }
    await nextTick();
    await wait(620);
    if (hero.value.hp <= 0 || enemies.value.length === 0) break;
  }
  if (token !== runToken) return;
  activeBeat.value = null;
  clearAnimations();
  queue.value = [];
  discardPlans(committedPlans);
  drawToHand();
  if (interruptionSummary) lastEvent.value = `${interruptionSummary} Enemy beats still completed.`;
  hero.value = { ...hero.value, shield: 0 };
  turn.value += 1;
  resolving.value = false;
  if (defeated.value) {
    autoplay.value = false;
    message.value = 'The Wayfarer fell in the vault.';
  } else if (won.value) {
    autoplay.value = false;
    message.value = 'The Vault Heart is extinguished. Run complete!';
  } else if (roomCleared.value) {
    autoplay.value = false;
    message.value = `Chamber ${room.value} solved through environmental combat.`;
  } else {
    message.value = 'Program the next three actions.';
    if (autoplay.value) await agentTurn();
  }
}

async function agentTurn() {
  if (resolving.value || defeated.value || roomCleared.value || won.value) return;
  queue.value = [];
  const available = [...hand.value];
  const takeCard = (card: Card, target: Point, summary: string) => {
    queue.value.push({ card, target: { ...target }, summary });
    available.splice(available.findIndex((item) => item.kind === card.kind), 1);
  };
  while (queue.value.length < maxActions && available.length) {
    const origin = virtualHero.value;
    const bash = available.find((card) => card.kind === 'bash');
    const adjacentEnemy = projectedEnemies.value.find((enemy) => manhattan(origin, enemy) === 1);
    if (bash && adjacentEnemy) {
      takeCard(bash, adjacentEnemy, 'Bash toward a hazard');
      continue;
    }
    const bolt = available.find((card) => card.kind === 'bolt');
    const barrelTarget = bolt
      ? legalTargets(bolt).find((target) => barrels.value.has(indexAt(target))
        && !queue.value.some((plan) => plan.card.kind === 'bolt' && indexAt(plan.target) === indexAt(target)))
      : undefined;
    if (bolt && barrelTarget) {
      takeCard(bolt, barrelTarget, 'Ignite environmental chain');
      continue;
    }
    const guard = available.find((card) => card.kind === 'guard');
    if (guard && hero.value.hp <= 4) {
      takeCard(guard, origin, 'Protect against incoming attacks');
      continue;
    }
    const step = available.find((card) => card.kind === 'step');
    const target = step
      ? legalTargets(step).sort((a, b) => Math.min(...enemies.value.map((enemy) => manhattan(a, enemy))) - Math.min(...enemies.value.map((enemy) => manhattan(b, enemy))))[0]
      : undefined;
    if (step && target) {
      takeCard(step, target, 'Reposition for the next beat');
      continue;
    }
    const fallback = available
      .map((card) => ({ card, target: legalTargets(card)[0] }))
      .find(({ target }) => !!target);
    if (!fallback?.target) break;
    takeCard(fallback.card, fallback.target, `${fallback.card.name} from shuffled hand`);
  }
  hand.value = available;
  decision.value = `Agent programmed ${queue.value.length} cards from the shuffled hand`;
  await wait(350);
  await commitTurn();
}

async function toggleAutoplay() {
  autoplay.value = !autoplay.value;
  if (autoplay.value) await agentTurn();
}

function nextRoom() {
  if (!roomCleared.value) return;
  room.value += 1;
  hero.value = { x: 0, y: 5, maxHp: hero.value.maxHp + 1, hp: Math.min(hero.value.maxHp + 1, hero.value.hp + 3), shield: 0 };
  queue.value = [];
  spawnRoom(room.value);
  message.value = `Chamber ${room.value}: inspect the new trap layout.`;
  lastEvent.value = 'Rested and descended.';
}

function tileLabel(index: number) {
  if (walls.value.has(index)) return 'Wall';
  if (gate.value === index) return gateOpen.value ? 'Open gate' : 'Closed gate';
  if (spikes.value.has(index)) return 'Spikes';
  if (pits.value.has(index)) return 'Pit';
  if (barrels.value.has(index)) return 'Cinder barrel';
  if (plate.value === index) return 'Pressure plate';
  return '';
}

onUnmounted(() => { runToken += 1; });
reset();
</script>

<template>
  <section class="game-demo game-demo--rogue">
    <header class="game-hero">
      <div>
        <span class="game-eyebrow">Three-beat lockstep combat · chamber {{ room }} of 3</span>
        <h2>Cinder Vault</h2>
        <p>Program up to three actions, preview your paths, then watch each beat resolve simultaneously against unknown enemy responses.</p>
      </div>
      <div class="game-status-pill" :data-active="autoplay">{{ won ? 'Run won' : defeated ? 'Run lost' : `Turn ${turn}` }}</div>
    </header>

    <div class="beat-ribbon" :class="{ resolving }">
      <button
        v-for="beat in maxActions"
        :key="beat"
        :class="{ active: activeBeat === beat - 1, planned: !!queue[beat - 1] }"
        :disabled="resolving || !queue[beat - 1]"
        :title="queue[beat - 1] ? `Cancel beat ${beat} and every later beat` : `Beat ${beat} is empty`"
        @click="removePlan(beat - 1)"
      >
        <b>BEAT {{ beat }}</b><span>{{ queue[beat - 1]?.summary ?? 'Empty' }}</span>
      </button>
    </div>

    <div class="game-layout">
      <div class="game-stage rogue-stage">
        <div class="rogue-hud">
          <div class="hero-vitals"><span>Wayfarer</span><strong>{{ hero.hp }}/{{ hero.maxHp }} HP · {{ hero.shield }} shield</strong><i><b :style="{ width: `${(hero.hp / hero.maxHp) * 100}%` }"></b></i></div>
          <div class="energy-pips" :title="`${actionsLeft} actions left`">
            <span v-for="pip in maxActions" :key="pip" :class="{ full: pip <= actionsLeft }">◆</span>
          </div>
          <div class="deck-counts"><span>Draw {{ drawPile.length }} · Discard {{ discardPile.length }}</span></div>
        </div>

        <div class="rogue-board" :class="{ 'is-resolving': resolving }">
          <div v-if="resolving && activeBeat !== null" class="resolution-banner">
            <span>Resolving beat {{ activeBeat + 1 }}</span>
            <strong>{{ queue[activeBeat]?.card.name }}</strong>
          </div>
          <svg v-if="!resolving" class="trajectory-layer" viewBox="0 0 6 6" aria-hidden="true">
            <defs>
              <marker id="move-arrow" markerWidth=".34" markerHeight=".34" refX=".28" refY=".17" orient="auto" markerUnits="userSpaceOnUse">
                <path d="M0,0 L.34,.17 L0,.34 Z" />
              </marker>
              <marker id="attack-arrow" markerWidth=".34" markerHeight=".34" refX=".28" refY=".17" orient="auto" markerUnits="userSpaceOnUse">
                <path d="M0,0 L.34,.17 L0,.34 Z" />
              </marker>
              <marker id="displacement-arrow" markerWidth=".34" markerHeight=".34" refX=".28" refY=".17" orient="auto" markerUnits="userSpaceOnUse">
                <path d="M0,0 L.34,.17 L0,.34 Z" />
              </marker>
            </defs>
            <line
              v-for="(segment, segmentIndex) in trajectorySegments"
              :key="`${segment.beat}-${segment.kind}-${segmentIndex}`"
              :x1="segmentCoordinates(segment).x1"
              :y1="segmentCoordinates(segment).y1"
              :x2="segmentCoordinates(segment).x2"
              :y2="segmentCoordinates(segment).y2"
              :class="[`path-${segment.kind}`, { ghost: segment.ghost }]"
              :marker-end="`url(#${segment.kind === 'move' ? 'move-arrow' : segment.kind === 'attack' ? 'attack-arrow' : 'displacement-arrow'})`"
              vector-effect="non-scaling-stroke"
            />
          </svg>
          <svg v-if="resolving && combatAnimations.length" class="combat-animation-layer" viewBox="0 0 6 6" aria-hidden="true">
            <g v-for="animation in combatAnimations" :key="animation.id">
              <line
                v-if="animation.kind === 'tether'"
                class="combat-tether"
                :x1="animationCenter(animation.from).x"
                :y1="animationCenter(animation.from).y"
                :x2="animationCenter(animation.to).x"
                :y2="animationCenter(animation.to).y"
                pathLength="1"
              />
              <line
                v-else-if="animation.kind === 'melee'"
                class="combat-melee-slash"
                v-bind="meleeSlashCoordinates(animation)"
                pathLength="1"
              />
              <template v-else>
                <line
                  class="combat-projectile-trail"
                  :x1="animationCenter(animation.from).x"
                  :y1="animationCenter(animation.from).y"
                  :x2="animationCenter(animation.to).x"
                  :y2="animationCenter(animation.to).y"
                />
                <circle
                  class="combat-projectile-halo"
                  :cx="animationCenter(animation.from).x"
                  :cy="animationCenter(animation.from).y"
                  r=".22"
                >
                  <animate attributeName="cx" :from="animationCenter(animation.from).x" :to="animationCenter(animation.to).x" dur=".34s" fill="freeze" />
                  <animate attributeName="cy" :from="animationCenter(animation.from).y" :to="animationCenter(animation.to).y" dur=".34s" fill="freeze" />
                </circle>
                <circle
                  class="combat-projectile"
                  :cx="animationCenter(animation.from).x"
                  :cy="animationCenter(animation.from).y"
                  r=".12"
                >
                  <animate attributeName="cx" :from="animationCenter(animation.from).x" :to="animationCenter(animation.to).x" dur=".34s" fill="freeze" />
                  <animate attributeName="cy" :from="animationCenter(animation.from).y" :to="animationCenter(animation.to).y" dur=".34s" fill="freeze" />
                </circle>
              </template>
              <circle
                class="combat-hit-burst"
                :class="[`hit-${animation.kind}`, { delayed: animation.kind !== 'melee' }]"
                :cx="animationCenter(animation.to).x"
                :cy="animationCenter(animation.to).y"
                r=".2"
              />
            </g>
          </svg>
          <button
            v-for="index in size * size"
            :key="index"
            class="rogue-cell"
            :class="{
              targetable: targetCells.has(index - 1),
              hero: indexAt(hero) === index - 1,
              wall: walls.has(index - 1),
              spike: spikes.has(index - 1),
              pit: pits.has(index - 1),
              barrel: barrels.has(index - 1),
              plate: plate === index - 1,
              gate: gate === index - 1,
              open: gate === index - 1 && gateOpen,
              'preview-move': previewAt(index - 1)?.kind === 'move',
              'preview-attack': previewAt(index - 1)?.kind === 'attack',
              'preview-guard': previewAt(index - 1)?.kind === 'guard',
              'preview-ghost': previewAt(index - 1)?.ghost,
              'movement-collision': collisionCells.has(index - 1),
            }"
            @click="chooseTile(pointAt(index - 1))"
            @mouseenter="hoveredIndex = targetCells.has(index - 1) ? index - 1 : null"
            @mouseleave="hoveredIndex = null"
          >
            <span
              v-if="previewAt(index - 1)"
              class="trajectory-marker"
              :class="[`trajectory-${previewAt(index - 1)!.kind}`, { ghost: previewAt(index - 1)!.ghost }]"
            ><strong v-if="previewAt(index - 1)!.endpoint">{{ previewAt(index - 1)!.beat }}</strong></span>
            <span
              v-if="indexAt(hero) === index - 1"
              class="rogue-actor wayfarer token-actor"
              :class="heroMotion ? `motion-${heroMotion}` : ''"
              :style="attackLungeStyle('hero')"
            >
              <img src="/images/cinder-vault/wayfarer.webp" alt="Wayfarer" :class="{ 'hit-react': heroHit }">
              <i v-if="hero.shield">{{ hero.shield }}</i>
            </span>
            <span
              v-else-if="enemyAt(pointAt(index - 1))"
              class="rogue-actor enemy token-actor"
              :class="[
                { elite: isElite(enemyAt(pointAt(index - 1))!) },
                enemyMotions[enemyAt(pointAt(index - 1))!.id] ? `motion-${enemyMotions[enemyAt(pointAt(index - 1))!.id]}` : '',
              ]"
              :style="attackLungeStyle(enemyAt(pointAt(index - 1))!.id)"
            >
              <img
                :src="tokenFor(enemyAt(pointAt(index - 1))!)"
                :alt="enemyAt(pointAt(index - 1))!.name"
                :class="{
                  'hit-react': hitEnemyIds.has(enemyAt(pointAt(index - 1))!.id),
                  'hit-delayed': delayedHitEnemyIds.has(enemyAt(pointAt(index - 1))!.id),
                }"
              >
              <i>{{ enemyAt(pointAt(index - 1))!.hp }}</i>
            </span>
            <span v-else class="environment-mark">{{ tileLabel(index - 1) }}</span>
            <span
              v-if="phantomAt(pointAt(index - 1))"
              class="rogue-actor enemy token-actor phantom-actor"
              :class="{ elite: isElite(phantomAt(pointAt(index - 1))!) }"
            >
              <img :src="tokenFor(phantomAt(pointAt(index - 1))!)" :alt="`Projected ${phantomAt(pointAt(index - 1))!.name}`">
              <i>{{ phantomAt(pointAt(index - 1))!.hp }}</i>
              <em>{{ phantomAt(pointAt(index - 1))!.movedAt }}</em>
            </span>
            <span
              v-if="!resolving && queue.length && indexAt(virtualHero) === index - 1 && indexAt(hero) !== index - 1"
              class="rogue-actor wayfarer token-actor phantom-actor phantom-wayfarer"
            >
              <img src="/images/cinder-vault/wayfarer.webp" alt="Projected Wayfarer">
              <em>{{ queue.length }}</em>
            </span>
            <small>{{ String.fromCharCode(65 + ((index - 1) % size)) }}{{ Math.floor((index - 1) / size) + 1 }}</small>
          </button>
        </div>

        <div class="game-message">{{ message }}</div>

        <div v-if="roomCleared || won || defeated" class="run-gate">
          <template v-if="roomCleared"><strong>Chamber solved</strong><span>Rest: +3 health and +1 maximum health</span><button @click="nextRoom">Descend</button></template>
          <template v-else><strong>{{ won ? 'Vault conquered' : 'Run ended' }}</strong><button @click="reset">Start another run</button></template>
        </div>
        <div v-else class="rogue-card-zone">
          <div class="deck-strip">
            <span><b>{{ hand.length }}</b> Hand</span>
            <span><b>{{ drawPile.length }}</b> Draw</span>
            <span><b>{{ discardPile.length }}</b> Discard</span>
          </div>
          <div class="rogue-hand">
            <button
              v-for="card in hand"
              :key="card.kind"
              class="action-card"
              :class="{ selected: selectedKind === card.kind, exhausted: queue.length >= maxActions }"
              :disabled="resolving || autoplay || queue.length >= maxActions"
              @click="chooseCard(card)"
            >
              <b class="card-glyph">{{ card.glyph }}</b><strong>{{ card.name }}</strong><small>{{ card.text }}</small>
            </button>
          </div>
        </div>
        <div v-if="!roomCleared && !won && !defeated" class="plan-controls">
          <button :disabled="resolving || autoplay || !selectedKind" @click="cancelSelection">Cancel selection</button>
          <button :disabled="resolving || autoplay || !queue.length" @click="clearPlan">Clear plan</button>
          <button class="commit-plan" :disabled="resolving || autoplay || !queue.length" @click="commitTurn">
            Commit {{ queue.length }} card{{ queue.length === 1 ? '' : 's' }}<template v-if="actionsLeft"> + {{ actionsLeft }} Wait</template>
          </button>
        </div>
      </div>

      <aside class="agent-console">
        <div class="agent-console__head"><span class="agent-orb" :class="{ thinking: resolving || autoplay }"></span><div><strong>Environment planner</strong><small>Telegraphs · pushes · hazards · escape</small></div></div>
        <div class="agent-decision"><span>Latest decision</span><p>{{ decision }}</p></div>
        <div class="agent-decision battle-log"><span>Resolution log</span><p>{{ lastEvent }}</p></div>
        <div class="agent-metrics">
          <div><span>Queued</span><strong>{{ queue.length }} / {{ maxActions }}</strong></div><div><span>Hand</span><strong>{{ hand.length }}</strong></div><div><span>Draw</span><strong>{{ drawPile.length }}</strong></div>
          <div><span>Discard</span><strong>{{ discardPile.length }}</strong></div><div><span>Actions left</span><strong>{{ actionsLeft }}</strong></div><div><span>Enemies</span><strong>{{ enemies.length }}</strong></div>
        </div>
        <div class="game-actions">
          <button class="primary-action" :disabled="resolving || won || defeated || roomCleared" @click="toggleAutoplay">{{ autoplay ? 'Take control' : 'Watch agent' }}</button>
          <button :disabled="resolving || autoplay || won || defeated || roomCleared" @click="agentTurn">Agent plan</button>
          <button @click="reset">Restart run</button>
        </div>
      </aside>
    </div>

    <section class="how-to-play" aria-labelledby="cinder-how-to">
      <div>
        <span class="game-eyebrow">Quick guide</span>
        <h3 id="cinder-how-to">How to play</h3>
        <p>Build a three-beat plan, check your colored trajectory, then commit. Enemy responses stay hidden until every entity resolves together on each beat.</p>
      </div>
      <ol>
        <li><b>Draw and choose.</b><span>Your four-card hand comes from a shuffled deck. Used cards discard, then reshuffle when the draw pile empties.</span></li>
        <li><b>Program three beats.</b><span>Commit fewer than three cards and the empty beats become Wait. Enemies still act on all three beats.</span></li>
        <li><b>Plan for uncertainty.</b><span>Attacks may target predicted empty cells. If a card is interrupted or misses, every later player card becomes Wait.</span></li>
        <li><b>Resolve together.</b><span>Player and enemy actions are simultaneous. Movers choosing the same tile collide and remain in place.</span></li>
      </ol>
      <div class="hazard-legend">
        <span><i class="legend-spike"></i><b>Spikes</b> deal damage</span>
        <span><i class="legend-pit"></i><b>Pits</b> defeat pushed enemies</span>
        <span><i class="legend-barrel"></i><b>Barrels</b> explode in a chain</span>
        <span><i class="legend-plate"></i><b>Plates</b> open gates</span>
      </div>
    </section>
  </section>
</template>

<style scoped>
.beat-ribbon{display:grid;grid-template-columns:repeat(3,1fr);gap:.55rem;padding:.8rem 1.4rem;border-bottom:1px solid var(--game-line);background:rgba(0,0,0,.2)}
.beat-ribbon button{min-height:48px;border:1px solid var(--game-line);border-radius:10px;color:var(--game-ink);background:rgba(255,255,255,.04);text-align:left;padding:.45rem .65rem;transition:border-color .18s ease,background .18s ease,transform .18s ease}
.beat-ribbon button.planned{border-color:rgba(234,165,104,.34);background:rgba(234,165,104,.08);cursor:pointer}
.beat-ribbon button.active{transform:translateY(-2px);border-color:#ffc778;background:rgba(255,199,120,.17);box-shadow:0 0 18px rgba(255,160,81,.22)}
.beat-ribbon.resolving button:not(.active){opacity:.42}
.beat-ribbon b,.beat-ribbon span{display:block}.beat-ribbon b{color:var(--game-accent);font-size:.55rem}.beat-ribbon span{margin-top:.2rem;color:var(--game-muted);font-size:.6rem}
.environment-mark{z-index:1;max-width:80%;color:rgba(255,231,194,.65);font-size:.48rem;font-weight:800;text-transform:uppercase}
.rogue-cell.wall{background:#302c31}.rogue-cell.spike{background:repeating-linear-gradient(45deg,#33242a 0 8px,#5b3035 8px 10px)}.rogue-cell.pit{background:radial-gradient(circle,#050408 20%,#1c1520 65%)}.rogue-cell.barrel{background:radial-gradient(circle,#843d26,#2a1920 60%)}.rogue-cell.plate{box-shadow:inset 0 0 0 3px #b8894d}.rogue-cell.gate{background:repeating-linear-gradient(90deg,#4d4745 0 5px,#171419 5px 10px)}.rogue-cell.gate.open{opacity:.38}
.rogue-board{position:relative}
.rogue-board.is-resolving{box-shadow:0 0 0 2px rgba(255,199,120,.28),0 18px 42px rgba(0,0,0,.38)}
.resolution-banner{position:absolute;z-index:8;left:50%;top:10px;display:flex;align-items:center;gap:.45rem;transform:translateX(-50%);border:1px solid rgba(255,199,120,.44);border-radius:999px;padding:.32rem .65rem;color:#f7d9ac;background:rgba(28,18,24,.92);box-shadow:0 6px 18px rgba(0,0,0,.42);pointer-events:none;white-space:nowrap}
.resolution-banner span{font-size:.54rem;font-weight:850;letter-spacing:.07em;text-transform:uppercase}.resolution-banner strong{color:#ffc778;font-size:.62rem}
.rogue-cell.targetable{z-index:auto}
.trajectory-layer{position:absolute;z-index:2;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}
.trajectory-layer line{fill:none;stroke-linecap:round;stroke-linejoin:round;stroke-width:3}
.trajectory-layer .path-move{stroke:#6dd8e5}
.trajectory-layer .path-attack{stroke:#ff925f;stroke-dasharray:8 6;animation:attack-dashes .75s linear infinite}
.trajectory-layer .path-displacement{stroke:#e5a7ff;stroke-dasharray:3 5;animation:attack-dashes .75s linear infinite}
.trajectory-layer .ghost{opacity:.52}
#move-arrow path{fill:#6dd8e5}
#attack-arrow path{fill:#ff925f}
#displacement-arrow path{fill:#e5a7ff}
.combat-animation-layer{position:absolute;z-index:7;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}
.combat-projectile-trail{stroke:rgba(255,136,72,.42);stroke-width:.06;stroke-linecap:round;stroke-dasharray:.08 .16;animation:projectile-trail .48s ease-out both}
.combat-projectile-halo{fill:rgba(255,91,43,.3);filter:drop-shadow(0 0 7px #ff5e35)}
.combat-projectile{fill:#fff3b0;stroke:#ff7745;stroke-width:.055;filter:drop-shadow(0 0 3px #fff) drop-shadow(0 0 7px #ff5e35)}
.combat-tether{fill:none;stroke:#e5a7ff;stroke-width:.075;stroke-linecap:round;stroke-dasharray:1;animation:tether-snap .5s ease-in-out both}
.combat-melee-slash{fill:none;stroke:#fff0c2;stroke-width:.11;stroke-linecap:round;stroke-dasharray:1;filter:drop-shadow(0 0 .1px #ff784e);animation:melee-slash .34s ease-out both}
.combat-hit-burst{fill:none;stroke:#ff7048;stroke-width:.07;transform-box:fill-box;transform-origin:center;animation:combat-hit .3s .08s ease-out both}
.combat-hit-burst.hit-tether{stroke:#e5a7ff}.combat-hit-burst.delayed{animation-delay:.3s}
.rogue-cell.preview-move{background:radial-gradient(circle,rgba(95,203,219,.16),transparent 68%),#202c31}
.rogue-cell.preview-attack{background:radial-gradient(circle,rgba(255,137,83,.16),transparent 68%),#34231f}
.rogue-cell.preview-guard{background:radial-gradient(circle,rgba(118,180,230,.2),transparent 68%),#202a36}
.rogue-cell.preview-ghost{filter:saturate(.75)}
.rogue-cell.movement-collision::after{position:absolute;z-index:7;inset:20%;display:grid;place-items:center;border:2px solid #ffd07d;border-radius:50%;color:#fff3c7;background:rgba(117,51,42,.72);box-shadow:0 0 20px rgba(255,112,72,.9);content:'×';font-size:1.2rem;font-weight:950;pointer-events:none;animation:collision-burst .58s ease-out both}
.trajectory-marker{position:absolute;z-index:3;left:4px;top:4px;pointer-events:none;color:var(--trajectory-color)}
.trajectory-marker strong{display:grid;width:22px;height:22px;place-items:center;border:2px solid #17131b;border-radius:50%;color:#16131a;background:var(--trajectory-color);box-shadow:0 0 12px color-mix(in srgb,var(--trajectory-color),transparent 35%);font-size:.62rem}
.trajectory-move{--trajectory-color:#6dd8e5;color:var(--trajectory-color)}.trajectory-attack{--trajectory-color:#ff925f;color:var(--trajectory-color)}.trajectory-guard{--trajectory-color:#8bbcf0;color:var(--trajectory-color)}.trajectory-marker.ghost{opacity:.58}
.token-actor{transform:none;border-radius:50%;background:#211820;box-shadow:0 7px 15px rgba(0,0,0,.48),0 0 0 2px rgba(0,0,0,.3)}
.token-actor img{display:block;width:100%;height:100%;border-radius:50%;object-fit:cover}
.token-actor i{z-index:4;transform:none}
.phantom-actor{position:absolute;z-index:5;left:50%;top:50%;width:58%;transform:translate(-50%,-50%);border-style:dashed;opacity:.58;pointer-events:none;filter:saturate(.72) brightness(1.15);animation:phantom-pulse 1.15s ease-in-out infinite}
.phantom-actor::after{position:absolute;inset:-7px;border:1px dashed #e5a7ff;border-radius:50%;content:''}
.phantom-actor em{left:auto;right:-8px;top:-8px;color:#231527;background:#e5a7ff}
.phantom-wayfarer{border-color:#6dd8e5}.phantom-wayfarer::after{border-color:#6dd8e5}.phantom-wayfarer em{background:#6dd8e5}
.rogue-actor em{position:absolute;z-index:5;left:-8px;top:-8px;display:grid;width:22px;height:22px;place-items:center;transform:none;border-radius:50%;color:#24131c;background:#ffc778;font-size:.65rem;font-style:normal}
.token-actor.motion-move{animation:token-hop .52s cubic-bezier(.2,.9,.25,1)}
.token-actor.motion-attack{animation:token-strike .52s ease-out}
.token-actor.motion-cast{animation:token-cast .52s ease-out}
.token-actor.motion-guard{animation:token-guard .52s ease-out}
.token-actor.motion-collision{animation:token-collision .58s ease-out}
.token-actor img.hit-react{animation:token-hit .32s .08s ease-out both}.token-actor img.hit-react.hit-delayed{animation-delay:.3s}
.rogue-card-zone{margin-top:.65rem}.rogue-card-zone .rogue-hand{margin-top:.4rem}
.deck-strip{display:flex;align-items:center;justify-content:center;gap:.45rem}
.deck-strip span{display:flex;align-items:center;gap:.3rem;border:1px solid rgba(255,255,255,.1);border-radius:999px;padding:.3rem .55rem;color:var(--game-muted);background:rgba(255,255,255,.035);font-size:.56rem;font-weight:800;text-transform:uppercase}
.deck-strip b{color:#ffc778;font-size:.68rem}
.plan-controls{display:flex;align-items:center;justify-content:flex-end;gap:.5rem;margin-top:.65rem}
.plan-controls button{border:1px solid rgba(255,255,255,.14);border-radius:999px;padding:.58rem .85rem;color:var(--game-muted);background:#28202c;cursor:pointer;font-size:.62rem;font-weight:800}
.plan-controls button:disabled{cursor:not-allowed;opacity:.35}
.plan-controls .commit-plan{border-color:rgba(255,190,112,.42);color:#211309;background:var(--game-accent)}
.how-to-play{display:grid;grid-template-columns:.85fr 1.45fr;gap:1.4rem;padding:1.4rem;border-top:1px solid var(--game-line);background:rgba(9,7,12,.44)}
.how-to-play h3{margin:.3rem 0 .45rem;color:var(--game-ink);font-family:Georgia,'Times New Roman',serif;font-size:1.35rem}
.how-to-play p{margin:0;color:var(--game-muted);font-size:.72rem;line-height:1.6}
.how-to-play ol{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.65rem;margin:0;padding:0;list-style:none;counter-reset:steps}
.how-to-play li{position:relative;min-height:78px;padding:.75rem .75rem .75rem 2.5rem;border:1px solid var(--game-line);border-radius:12px;background:rgba(255,255,255,.035);counter-increment:steps}
.how-to-play li::before{position:absolute;left:.7rem;top:.72rem;display:grid;width:1.35rem;height:1.35rem;place-items:center;border-radius:50%;color:#211309;background:var(--game-accent);content:counter(steps);font-size:.62rem;font-weight:900}
.how-to-play li b,.how-to-play li span{display:block}.how-to-play li b{color:var(--game-ink);font-size:.7rem}.how-to-play li span{margin-top:.24rem;color:var(--game-muted);font-size:.61rem;line-height:1.45}
.hazard-legend{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:.55rem}
.hazard-legend span{display:flex;align-items:center;gap:.35rem;border-radius:999px;padding:.35rem .55rem;color:var(--game-muted);background:rgba(255,255,255,.04);font-size:.58rem}.hazard-legend b{color:var(--game-ink)}
.hazard-legend i{display:block;width:12px;height:12px;border-radius:3px}.legend-spike{background:#8d4149}.legend-pit{background:#08060b;box-shadow:inset 0 0 0 2px #392a3d}.legend-barrel{background:#a84d2b}.legend-plate{box-shadow:inset 0 0 0 2px #c39050}
@keyframes trajectory-dash{50%{filter:brightness(1.3)}}
@keyframes attack-dashes{to{stroke-dashoffset:-14}}
@keyframes projectile-trail{0%{opacity:0;stroke-dashoffset:.5}35%{opacity:.85}100%{opacity:0;stroke-dashoffset:-.5}}
@keyframes tether-snap{0%{opacity:0;stroke-dashoffset:1}35%,70%{opacity:1;stroke-dashoffset:0}100%{opacity:0;stroke-dashoffset:-1}}
@keyframes melee-slash{0%{opacity:0;stroke-dashoffset:1}35%{opacity:1}100%{opacity:0;stroke-dashoffset:-1}}
@keyframes combat-hit{0%{opacity:0;transform:scale(.35)}35%{opacity:1}100%{opacity:0;transform:scale(3.1)}}
@keyframes phantom-pulse{50%{opacity:.78;filter:saturate(.9) brightness(1.3)}}
@keyframes token-hop{0%{transform:translateY(12px) scale(.78);opacity:.25}55%{transform:translateY(-7px) scale(1.08)}100%{transform:none;opacity:1}}
@keyframes token-strike{0%,100%{transform:none}35%{transform:translate(var(--strike-x,0),var(--strike-y,0)) scale(1.1);filter:brightness(1.35)}68%{transform:scale(.96)}}
@keyframes token-cast{0%,100%{transform:none;filter:none}35%{transform:scale(.88);filter:brightness(1.45) drop-shadow(0 0 10px #ff8754)}58%{transform:scale(1.08);filter:brightness(1.2)}}
@keyframes token-hit{0%,100%{transform:none;filter:none}28%{transform:translateX(-6px) rotate(-5deg);filter:brightness(1.8) saturate(.6)}55%{transform:translateX(4px) rotate(3deg)}}
@keyframes token-guard{0%{transform:scale(.78)}45%{transform:scale(1.16);box-shadow:0 0 28px rgba(108,190,236,.8)}100%{transform:none}}
@keyframes token-collision{0%,100%{transform:none}28%{transform:translateY(-6px) scale(.94);filter:brightness(1.45)}48%{transform:translateY(3px) scale(1.04)}68%{transform:translateY(-2px)}}
@keyframes collision-burst{0%{transform:scale(.3) rotate(-20deg);opacity:0}35%{transform:scale(1.12);opacity:1}100%{transform:scale(.9) rotate(8deg);opacity:0}}
@media(max-width:620px){
  .beat-ribbon{padding:.6rem}
  .beat-ribbon span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rogue-hand{justify-content:flex-start;overflow-x:auto;overscroll-behavior-inline:contain;padding:.4rem 0 .8rem;scrollbar-color:rgba(255,255,255,.25) transparent;scrollbar-width:thin;scroll-snap-type:x proximity}
  .action-card{width:92px;flex:0 0 92px;scroll-snap-align:start}
  .plan-controls{justify-content:stretch}.plan-controls button{flex:1;padding:.52rem .35rem}
  .how-to-play{grid-template-columns:1fr;padding:1rem}.how-to-play ol{grid-template-columns:1fr}
}
</style>
