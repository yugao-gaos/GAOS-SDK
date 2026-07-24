<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue';
import { withBase } from 'vitepress';
import { manhattan, wait, type Point } from './game-utils';

type CardKind = 'step' | 'vault' | 'bash' | 'hook' | 'bolt' | 'guard';
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
type Motion = 'move' | 'attack' | 'guard';

const size = 6;
const maxActions = 3;
const cards: Card[] = [
  { kind: 'step', name: 'Step', text: 'Move one tile.', glyph: '→' },
  { kind: 'vault', name: 'Vault', text: 'Jump over an obstacle.', glyph: '⌁' },
  { kind: 'bash', name: 'Bash', text: 'Push an adjacent enemy.', glyph: '»' },
  { kind: 'hook', name: 'Hook', text: 'Pull a visible enemy closer.', glyph: '↢' },
  { kind: 'bolt', name: 'Cinder Bolt', text: 'Damage a foe or ignite a barrel.', glyph: '✦' },
  { kind: 'guard', name: 'Guard', text: 'Gain two shield.', glyph: '◇' },
];

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
const selectedKind = ref<CardKind | null>(null);
const hoveredIndex = ref<number | null>(null);
const resolving = ref(false);
const autoplay = ref(false);
const activeBeat = ref<number | null>(null);
const heroMotion = ref<Motion | null>(null);
const enemyMotions = ref<Record<string, Motion>>({});
const impactCells = ref(new Set<number>());
const message = ref('Program up to three actions, preview the paths, then commit.');
const decision = ref('Waiting for a plan');
const lastEvent = ref('Entered the vault');
let runToken = 0;

const actionsLeft = computed(() => maxActions - queue.value.length);
const selectedCard = computed(() => cards.find((card) => card.kind === selectedKind.value) ?? null);
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

function projectedEnemyIntent(enemy: ProjectedEnemy, state: ProjectedState) {
  if (manhattan(enemy, state.hero) === 1) {
    return { kind: 'attack' as const, target: { ...state.hero } };
  }
  const candidates = lineDirections()
    .map(([dx, dy]) => ({ x: enemy.x + dx, y: enemy.y + dy }))
    .filter((point) => {
      const occupant = projectedEnemyAt(point, state.enemies);
      return inside(point)
        && !terrainBlocked(point)
        && !barrels.value.has(indexAt(point))
        && (!occupant || occupant.id === enemy.id);
    });
  candidates.sort((a, b) => manhattan(a, state.hero) - manhattan(b, state.hero) || indexAt(a) - indexAt(b));
  return { kind: 'move' as const, target: candidates[0] ?? { x: enemy.x, y: enemy.y } };
}

function applyProjectedEnemyHazard(state: ProjectedState, enemy: ProjectedEnemy) {
  const index = indexAt(enemy);
  if (pits.value.has(index)) {
    state.enemies = state.enemies.filter((item) => item.id !== enemy.id);
  } else if (spikes.value.has(index)) {
    enemy.hp -= 2;
    if (enemy.hp <= 0) state.enemies = state.enemies.filter((item) => item.id !== enemy.id);
  }
}

function applyProjectedBeat(state: ProjectedState, plan: Plan, beat: number) {
  const intents = state.enemies.map((enemy) => ({
    snapshot: { ...enemy, origin: { ...enemy.origin } },
    intent: projectedEnemyIntent(enemy, state),
  }));
  applyProjectedPlan(state, plan, beat);
  for (const { snapshot, intent } of intents) {
    const enemy = state.enemies.find((item) => item.id === snapshot.id);
    if (!enemy || enemy.x !== snapshot.x || enemy.y !== snapshot.y || intent.kind === 'attack') continue;
    const occupant = projectedEnemyAt(intent.target, state.enemies);
    if (terrainBlocked(intent.target)
      || barrels.value.has(indexAt(intent.target))
      || (occupant && occupant.id !== enemy.id)) continue;
    if (intent.target.x === enemy.x && intent.target.y === enemy.y) continue;
    enemy.x = intent.target.x;
    enemy.y = intent.target.y;
    enemy.movedAt = beat;
    applyProjectedEnemyHazard(state, enemy);
  }
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

function addTrajectory(segments: TrajectorySegment[], state: ProjectedState, plan: Plan, beat: number, ghost: boolean) {
  const from = { ...state.hero };
  const kind = plan.card.kind;
  if (kind === 'step' || kind === 'vault') {
    segments.push({ kind: 'move', beat, from, to: { ...plan.target }, ghost });
    return;
  }
  if (kind === 'guard') return;
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
  impactCells.value = new Set();
  spawnRoom(1);
  message.value = 'Program up to three actions, preview the paths, then commit.';
  decision.value = 'Waiting for a plan';
  lastEvent.value = 'Entered the first chamber';
}

function legalTargets(card: Card): Point[] {
  if (queue.value.length >= maxActions || resolving.value) return [];
  const state = projectedState.value;
  const origin = state.hero;
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
  if (card.kind === 'bash') return state.enemies.filter((enemy) => manhattan(origin, enemy) === 1);
  if (card.kind === 'hook') return state.enemies.filter((enemy) => hasClearLine(origin, enemy, state.enemies));
  return [
    ...state.enemies.filter((enemy) => hasClearLine(origin, enemy, state.enemies)),
    ...[...barrels.value].map(pointAt).filter((barrel) => hasClearLine(origin, barrel)),
  ];
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
  selectedKind.value = null;
  hoveredIndex.value = null;
  message.value = queue.value.length === maxActions
    ? 'All three actions are ready. Review the paths, then commit.'
    : `${card.name} added to beat ${queue.value.length}. ${actionsLeft.value} action${actionsLeft.value === 1 ? '' : 's'} left.`;
}

function removePlan(index: number) {
  if (!resolving.value) {
    queue.value.splice(index);
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

function executePlayer(plan: Plan) {
  const card = plan.card.kind;
  if (card === 'step' || card === 'vault') {
    if (!isBlocked(plan.target, false)) {
      hero.value = { ...hero.value, ...plan.target };
      lastEvent.value = `${plan.card.name} reached ${String.fromCharCode(65 + plan.target.x)}${plan.target.y + 1}.`;
    }
  } else if (card === 'guard') {
    hero.value = { ...hero.value, shield: hero.value.shield + 2 };
    lastEvent.value = 'Guard raised two shield.';
  } else if (card === 'bash') {
    const enemy = enemyAt(plan.target);
    if (enemy && manhattan(hero.value, enemy) === 1) pushEnemy(enemy, enemy.x - hero.value.x, enemy.y - hero.value.y);
  } else if (card === 'hook') {
    const enemy = enemyAt(plan.target);
    if (enemy) {
      const dx = Math.sign(hero.value.x - enemy.x);
      const dy = Math.sign(hero.value.y - enemy.y);
      pushEnemy(enemy, dx, dy);
      lastEvent.value = `${enemy.name} was pulled off its line.`;
    }
  } else {
    if (barrels.value.has(indexAt(plan.target))) explodeBarrel(plan.target);
    else {
      const enemy = enemyAt(plan.target);
      if (enemy) {
        enemies.value = enemies.value.map((item) => item.id === enemy.id ? { ...item, hp: item.hp - 2 } : item).filter((item) => item.hp > 0);
        lastEvent.value = `Cinder Bolt dealt 2 damage to ${enemy.name}.`;
      }
    }
  }
  message.value = lastEvent.value;
}

function enemyIntent(enemy: Enemy) {
  if (manhattan(enemy, hero.value) === 1) return { kind: 'attack' as const, target: { x: hero.value.x, y: hero.value.y } };
  const candidates = lineDirections()
    .map(([dx, dy]) => ({ x: enemy.x + dx, y: enemy.y + dy }))
    .filter((point) => inside(point) && !isBlocked(point, false));
  candidates.sort((a, b) => manhattan(a, hero.value) - manhattan(b, hero.value) || indexAt(a) - indexAt(b));
  return { kind: 'move' as const, target: candidates[0] ?? { x: enemy.x, y: enemy.y } };
}

function executeEnemies(intents: EnemyIntent[]) {
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
    } else if (intent.kind === 'move' && !isBlocked(intent.target, false)) {
      enemies.value = enemies.value.map((item) => item.id === enemy.id ? { ...item, ...intent.target } : item);
      const moved = enemies.value.find((item) => item.id === enemy.id);
      if (moved) applyHazard(moved);
    }
    message.value = lastEvent.value;
  }
}

function prepareAnimations(plan: Plan, intents: EnemyIntent[]) {
  heroMotion.value = plan.card.kind === 'step' || plan.card.kind === 'vault'
    ? 'move'
    : plan.card.kind === 'guard' ? 'guard' : 'attack';
  enemyMotions.value = Object.fromEntries(intents.map(({ enemy, intent }) => [enemy.id, intent.kind]));
  const impacts = new Set<number>();
  if (plan.card.kind === 'bash' || plan.card.kind === 'hook' || plan.card.kind === 'bolt') impacts.add(indexAt(plan.target));
  intents.filter(({ intent }) => intent.kind === 'attack').forEach(({ intent }) => impacts.add(indexAt(intent.target)));
  impactCells.value = impacts;
}

function clearAnimations() {
  heroMotion.value = null;
  enemyMotions.value = {};
  impactCells.value = new Set();
}

async function commitTurn() {
  if (!queue.value.length || resolving.value || defeated.value || roomCleared.value || won.value) return;
  resolving.value = true;
  selectedKind.value = null;
  hoveredIndex.value = null;
  const token = runToken;
  const plans = [...queue.value];
  decision.value = `Committed ${plans.length} action${plans.length === 1 ? '' : 's'} against enemy responses`;
  for (let beat = 0; beat < plans.length && token === runToken; beat += 1) {
    const plan = plans[beat];
    const intents: EnemyIntent[] = enemies.value.map((enemy) => ({ enemy: { ...enemy }, intent: enemyIntent(enemy) }));
    activeBeat.value = beat;
    clearAnimations();
    await nextTick();
    prepareAnimations(plan, intents);
    message.value = `Beat ${beat + 1}: ${plan.card.name} and every enemy response resolve together.`;
    executePlayer(plan);
    executeEnemies(intents);
    await nextTick();
    await wait(520);
    if (hero.value.hp <= 0 || enemies.value.length === 0) break;
  }
  if (token !== runToken) return;
  activeBeat.value = null;
  clearAnimations();
  queue.value = [];
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
  const bash = cards.find((card) => card.kind === 'bash')!;
  const bolt = cards.find((card) => card.kind === 'bolt')!;
  const guard = cards.find((card) => card.kind === 'guard')!;
  const step = cards.find((card) => card.kind === 'step')!;
  while (queue.value.length < maxActions) {
    const origin = virtualHero.value;
    const adjacentEnemy = enemies.value.find((enemy) => manhattan(origin, enemy) === 1);
    const barrelTarget = [...barrels.value]
      .map(pointAt)
      .find((barrel) => hasClearLine(origin, barrel) && !queue.value.some((plan) => plan.card.kind === 'bolt' && indexAt(plan.target) === indexAt(barrel)));
    if (adjacentEnemy) {
      queue.value.push({ card: bash, target: { x: adjacentEnemy.x, y: adjacentEnemy.y }, summary: 'Bash toward a hazard' });
      continue;
    }
    if (barrelTarget) {
      queue.value.push({ card: bolt, target: barrelTarget, summary: 'Ignite environmental chain' });
      continue;
    }
    if (hero.value.hp <= 4 && !queue.value.some((plan) => plan.card.kind === 'guard')) {
      queue.value.push({ card: guard, target: { ...origin }, summary: 'Protect against incoming attacks' });
      continue;
    }
    const target = legalTargets(step).sort((a, b) => Math.min(...enemies.value.map((enemy) => manhattan(a, enemy))) - Math.min(...enemies.value.map((enemy) => manhattan(b, enemy))))[0];
    if (target) {
      queue.value.push({ card: step, target, summary: 'Reposition for the next beat' });
      continue;
    }
    queue.value.push({ card: guard, target: { ...origin }, summary: 'Hold position' });
  }
  decision.value = `Agent programmed ${queue.value.length} actions using hazards and telegraphs`;
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
        <p>Program up to three actions, preview every path, then watch each beat resolve simultaneously against enemy responses.</p>
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
          <div class="deck-counts"><span>Enemies respond each beat</span></div>
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
              impact: impactCells.has(index - 1),
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
            >
              <img src="/images/cinder-vault/wayfarer.webp" alt="Wayfarer">
              <i v-if="hero.shield">{{ hero.shield }}</i>
            </span>
            <span
              v-else-if="enemyAt(pointAt(index - 1))"
              class="rogue-actor enemy token-actor"
              :class="[
                { elite: isElite(enemyAt(pointAt(index - 1))!) },
                enemyMotions[enemyAt(pointAt(index - 1))!.id] ? `motion-${enemyMotions[enemyAt(pointAt(index - 1))!.id]}` : '',
              ]"
            >
              <img :src="tokenFor(enemyAt(pointAt(index - 1))!)" :alt="enemyAt(pointAt(index - 1))!.name">
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
        <div v-else class="rogue-hand">
          <button
            v-for="card in cards"
            :key="card.kind"
            class="action-card"
            :class="{ selected: selectedKind === card.kind, exhausted: queue.length >= maxActions }"
            :disabled="resolving || autoplay || queue.length >= maxActions"
            @click="chooseCard(card)"
          >
            <b class="card-glyph">{{ card.glyph }}</b><strong>{{ card.name }}</strong><small>{{ card.text }}</small>
          </button>
        </div>
        <div v-if="!roomCleared && !won && !defeated" class="plan-controls">
          <button :disabled="resolving || autoplay || !selectedKind" @click="cancelSelection">Cancel selection</button>
          <button :disabled="resolving || autoplay || !queue.length" @click="clearPlan">Clear plan</button>
          <button class="commit-plan" :disabled="resolving || autoplay || !queue.length" @click="commitTurn">Commit {{ queue.length }} action{{ queue.length === 1 ? '' : 's' }}</button>
        </div>
      </div>

      <aside class="agent-console">
        <div class="agent-console__head"><span class="agent-orb" :class="{ thinking: resolving || autoplay }"></span><div><strong>Environment planner</strong><small>Telegraphs · pushes · hazards · escape</small></div></div>
        <div class="agent-decision"><span>Latest decision</span><p>{{ decision }}</p></div>
        <div class="agent-decision battle-log"><span>Resolution log</span><p>{{ lastEvent }}</p></div>
        <div class="agent-metrics">
          <div><span>Queued</span><strong>{{ queue.length }} / {{ maxActions }}</strong></div><div><span>Actions left</span><strong>{{ actionsLeft }}</strong></div><div><span>Enemies</span><strong>{{ enemies.length }}</strong></div>
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
        <p>Build a three-beat plan, check the colored trajectory on the board, then commit. Enemy responses stay hidden until every entity resolves together on each beat.</p>
      </div>
      <ol>
        <li><b>Choose a card.</b><span>Legal targets glow. Hover a target to preview its path before adding it.</span></li>
        <li><b>Program up to three beats.</b><span>Solid blue arrows show movement. Dashed orange arrows show attacks. Ghost tokens show projected positions and remain valid future targets.</span></li>
        <li><b>Plan for uncertainty.</b><span>Enemy movement and attacks are hidden until the current beat starts resolving.</span></li>
        <li><b>Commit the turn.</b><span>Your action and every enemy response animate simultaneously, one beat at a time.</span></li>
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
.rogue-cell.preview-move{background:radial-gradient(circle,rgba(95,203,219,.16),transparent 68%),#202c31}
.rogue-cell.preview-attack{background:radial-gradient(circle,rgba(255,137,83,.16),transparent 68%),#34231f}
.rogue-cell.preview-guard{background:radial-gradient(circle,rgba(118,180,230,.2),transparent 68%),#202a36}
.rogue-cell.preview-ghost{filter:saturate(.75)}
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
.token-actor.motion-guard{animation:token-guard .52s ease-out}
.rogue-cell.impact::after{position:absolute;z-index:4;inset:8%;pointer-events:none;border:3px solid #ff8c58;border-radius:50%;box-shadow:0 0 20px #ef633f;content:'';animation:impact-ring .52s ease-out both}
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
@keyframes phantom-pulse{50%{opacity:.78;filter:saturate(.9) brightness(1.3)}}
@keyframes token-hop{0%{transform:translateY(12px) scale(.78);opacity:.25}55%{transform:translateY(-7px) scale(1.08)}100%{transform:none;opacity:1}}
@keyframes token-strike{0%,100%{transform:none}38%{transform:scale(1.18) rotate(-8deg);filter:brightness(1.35)}70%{transform:scale(.94) rotate(3deg)}}
@keyframes token-guard{0%{transform:scale(.78)}45%{transform:scale(1.16);box-shadow:0 0 28px rgba(108,190,236,.8)}100%{transform:none}}
@keyframes impact-ring{0%{transform:scale(.3);opacity:0}40%{opacity:1}100%{transform:scale(1.35);opacity:0}}
@media(max-width:620px){
  .beat-ribbon{padding:.6rem}
  .beat-ribbon span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rogue-hand{justify-content:flex-start;overflow-x:auto;overscroll-behavior-inline:contain;padding:.4rem 0 .8rem;scrollbar-color:rgba(255,255,255,.25) transparent;scrollbar-width:thin;scroll-snap-type:x proximity}
  .action-card{width:92px;flex:0 0 92px;scroll-snap-align:start}
  .plan-controls{justify-content:stretch}.plan-controls button{flex:1;padding:.52rem .35rem}
  .how-to-play{grid-template-columns:1fr;padding:1rem}.how-to-play ol{grid-template-columns:1fr}
}
</style>
