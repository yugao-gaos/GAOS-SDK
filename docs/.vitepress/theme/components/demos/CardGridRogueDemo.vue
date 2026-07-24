<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { manhattan, wait, type Point } from './game-utils';

type CardKind = 'step' | 'vault' | 'bash' | 'hook' | 'bolt' | 'guard';
type Card = { kind: CardKind; name: string; cost: number; text: string; glyph: string };
type Enemy = Point & { id: string; name: string; hp: number; maxHp: number; damage: number };
type Plan = { card: Card; target: Point; summary: string };

const size = 6;
const cards: Card[] = [
  { kind: 'step', name: 'Step', cost: 1, text: 'Move one tile.', glyph: '→' },
  { kind: 'vault', name: 'Vault', cost: 1, text: 'Jump over an obstacle.', glyph: '⌁' },
  { kind: 'bash', name: 'Bash', cost: 1, text: 'Push an adjacent enemy.', glyph: '»' },
  { kind: 'hook', name: 'Hook', cost: 1, text: 'Pull a visible enemy closer.', glyph: '↢' },
  { kind: 'bolt', name: 'Cinder Bolt', cost: 2, text: 'Damage a foe or ignite a barrel.', glyph: '✦' },
  { kind: 'guard', name: 'Guard', cost: 1, text: 'Gain two shield.', glyph: '◇' },
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
const resolving = ref(false);
const autoplay = ref(false);
const message = ref('Program up to three energy, then commit the turn.');
const decision = ref('Waiting for a plan');
const lastEvent = ref('Entered the vault');
let runToken = 0;

const spent = computed(() => queue.value.reduce((sum, plan) => sum + plan.card.cost, 0));
const energy = computed(() => 3 - spent.value);
const selectedCard = computed(() => cards.find((card) => card.kind === selectedKind.value) ?? null);
const virtualHero = computed(() => {
  let position = { x: hero.value.x, y: hero.value.y };
  for (const plan of queue.value) if (plan.card.kind === 'step' || plan.card.kind === 'vault') position = { ...plan.target };
  return position;
});
const won = computed(() => room.value === 3 && enemies.value.length === 0);
const defeated = computed(() => hero.value.hp <= 0);
const roomCleared = computed(() => enemies.value.length === 0 && !won.value);
const targetCells = computed(() => new Set(selectedCard.value ? legalTargets(selectedCard.value).map(indexAt) : []));

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

function isBlocked(point: Point, includeHero = true) {
  const index = indexAt(point);
  return !inside(point)
    || walls.value.has(index)
    || (gate.value === index && !gateOpen.value)
    || barrels.value.has(index)
    || !!enemyAt(point)
    || (includeHero && hero.value.x === point.x && hero.value.y === point.y);
}

function lineDirections() {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]];
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
  resolving.value = false;
  autoplay.value = false;
  spawnRoom(1);
  message.value = 'Program up to three energy, then commit the turn.';
  decision.value = 'Waiting for a plan';
  lastEvent.value = 'Entered the first chamber';
}

function legalTargets(card: Card): Point[] {
  if (queue.value.some((plan) => plan.card.kind === card.kind) || card.cost > energy.value || resolving.value) return [];
  const origin = virtualHero.value;
  if (card.kind === 'guard') return [{ ...origin }];
  if (card.kind === 'step') {
    return lineDirections().map(([dx, dy]) => ({ x: origin.x + dx, y: origin.y + dy }))
      .filter((point) => inside(point) && !isBlocked(point, false));
  }
  if (card.kind === 'vault') {
    return lineDirections().flatMap(([dx, dy]) => {
      const middle = { x: origin.x + dx, y: origin.y + dy };
      const landing = { x: origin.x + dx * 2, y: origin.y + dy * 2 };
      return inside(landing) && isBlocked(middle, false) && !isBlocked(landing, false) ? [landing] : [];
    });
  }
  if (card.kind === 'bash') return enemies.value.filter((enemy) => manhattan(origin, enemy) === 1);
  if (card.kind === 'hook') return enemies.value.filter((enemy) => manhattan(origin, enemy) <= 3 && (enemy.x === origin.x || enemy.y === origin.y));
  return [
    ...enemies.value.filter((enemy) => manhattan(origin, enemy) <= 3),
    ...[...barrels.value].map(pointAt).filter((barrel) => manhattan(origin, barrel) <= 3),
  ];
}

function chooseCard(card: Card) {
  if (card.cost > energy.value || resolving.value || queue.value.some((plan) => plan.card.kind === card.kind)) return;
  selectedKind.value = selectedKind.value === card.kind ? null : card.kind;
  message.value = selectedKind.value ? card.text : 'Choose a card.';
}

function chooseTile(point: Point) {
  const card = selectedCard.value;
  if (!card || !targetCells.value.has(indexAt(point))) return;
  queue.value.push({ card, target: { ...point }, summary: `${card.name} → ${String.fromCharCode(65 + point.x)}${point.y + 1}` });
  selectedKind.value = null;
  message.value = `${card.name} added to beat ${queue.value.length}.`;
}

function removePlan(index: number) {
  if (!resolving.value) queue.value.splice(index, 1);
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

async function executePlayer(plan: Plan) {
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
  await wait(280);
}

function enemyIntent(enemy: Enemy) {
  if (manhattan(enemy, hero.value) === 1) return { kind: 'attack' as const, target: { x: hero.value.x, y: hero.value.y } };
  const candidates = lineDirections()
    .map(([dx, dy]) => ({ x: enemy.x + dx, y: enemy.y + dy }))
    .filter((point) => inside(point) && !isBlocked(point, false));
  candidates.sort((a, b) => manhattan(a, hero.value) - manhattan(b, hero.value) || indexAt(a) - indexAt(b));
  return { kind: 'move' as const, target: candidates[0] ?? { x: enemy.x, y: enemy.y } };
}

async function executeEnemies() {
  const intents = enemies.value.map((enemy) => ({ enemy, intent: enemyIntent(enemy) }));
  for (const { enemy: snapshot, intent } of intents) {
    const enemy = enemies.value.find((item) => item.id === snapshot.id);
    if (!enemy || hero.value.hp <= 0) continue;
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
    await wait(240);
  }
}

async function commitTurn() {
  if (!queue.value.length || resolving.value || defeated.value || roomCleared.value || won.value) return;
  resolving.value = true;
  selectedKind.value = null;
  const token = runToken;
  const plans = [...queue.value];
  decision.value = `Committed ${plans.length} programmed beats against revealed enemy intents`;
  for (let beat = 0; beat < 3 && token === runToken; beat += 1) {
    message.value = `Beat ${beat + 1}: intents resolve simultaneously.`;
    if (plans[beat]) await executePlayer(plans[beat]);
    await executeEnemies();
    if (hero.value.hp <= 0 || enemies.value.length === 0) break;
  }
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
    message.value = 'Program the next three beats.';
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
  const adjacentEnemy = enemies.value.find((enemy) => manhattan(hero.value, enemy) === 1);
  const barrelTarget = [...barrels.value].map(pointAt).find((barrel) => enemies.value.some((enemy) => manhattan(barrel, enemy) <= 1));
  if (adjacentEnemy) queue.value.push({ card: bash, target: { x: adjacentEnemy.x, y: adjacentEnemy.y }, summary: 'Bash toward a hazard' });
  if (barrelTarget && energy.value >= bolt.cost) queue.value.push({ card: bolt, target: barrelTarget, summary: 'Ignite environmental chain' });
  if (energy.value > 0 && !queue.value.some((plan) => plan.card.kind === 'guard') && hero.value.hp <= 4) queue.value.push({ card: guard, target: { ...hero.value }, summary: 'Protect against revealed attacks' });
  if (energy.value > 0) {
    const target = legalTargets(step).sort((a, b) => Math.min(...enemies.value.map((enemy) => manhattan(a, enemy))) - Math.min(...enemies.value.map((enemy) => manhattan(b, enemy))))[0];
    if (target) queue.value.push({ card: step, target, summary: 'Reposition for next beat' });
  }
  if (!queue.value.length) queue.value.push({ card: guard, target: { ...hero.value }, summary: 'Hold position' });
  decision.value = `Agent programmed ${queue.value.length} beats using hazards and telegraphs`;
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
        <span class="game-eyebrow">Simultaneous puzzle combat · chamber {{ room }} of 3</span>
        <h2>Cinder Vault</h2>
        <p>Program three beats, then use pushes, jumps, traps, gates, and explosions to turn enemy intentions against them.</p>
      </div>
      <div class="game-status-pill" :data-active="autoplay">{{ won ? 'Run won' : defeated ? 'Run lost' : `Turn ${turn}` }}</div>
    </header>

    <div class="beat-ribbon">
      <button v-for="beat in 3" :key="beat" :disabled="resolving" @click="removePlan(beat - 1)">
        <b>BEAT {{ beat }}</b><span>{{ queue[beat - 1]?.summary ?? 'Empty' }}</span>
      </button>
    </div>

    <div class="game-layout">
      <div class="game-stage rogue-stage">
        <div class="rogue-hud">
          <div class="hero-vitals"><span>Wayfarer</span><strong>{{ hero.hp }}/{{ hero.maxHp }} HP · {{ hero.shield }} shield</strong><i><b :style="{ width: `${(hero.hp / hero.maxHp) * 100}%` }"></b></i></div>
          <div class="energy-pips"><span v-for="pip in 3" :key="pip" :class="{ full: pip <= energy }">◆</span></div>
          <div class="deck-counts"><span>Enemy intents revealed</span></div>
        </div>

        <div class="rogue-board">
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
            }"
            @click="chooseTile(pointAt(index - 1))"
          >
            <span v-if="indexAt(hero) === index - 1" class="rogue-actor wayfarer"><b>W</b><i v-if="hero.shield">{{ hero.shield }}</i></span>
            <span v-else-if="enemyAt(pointAt(index - 1))" class="rogue-actor enemy">
              <b>A</b><i>{{ enemyAt(pointAt(index - 1))!.hp }}</i>
              <em>{{ enemyIntent(enemyAt(pointAt(index - 1))!).kind === 'attack' ? '!' : '→' }}</em>
            </span>
            <span v-else class="environment-mark">{{ tileLabel(index - 1) }}</span>
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
            :class="{ selected: selectedKind === card.kind, exhausted: card.cost > energy || queue.some((plan) => plan.card.kind === card.kind) }"
            :disabled="resolving || autoplay || card.cost > energy || queue.some((plan) => plan.card.kind === card.kind)"
            @click="chooseCard(card)"
          >
            <span class="card-cost">{{ card.cost }}</span><b class="card-glyph">{{ card.glyph }}</b><strong>{{ card.name }}</strong><small>{{ card.text }}</small>
          </button>
          <button class="end-turn-card" :disabled="resolving || autoplay || !queue.length" @click="commitTurn">Commit<br>turn</button>
        </div>
      </div>

      <aside class="agent-console">
        <div class="agent-console__head"><span class="agent-orb" :class="{ thinking: resolving || autoplay }"></span><div><strong>Environment planner</strong><small>Telegraphs · pushes · hazards · escape</small></div></div>
        <div class="agent-decision"><span>Latest decision</span><p>{{ decision }}</p></div>
        <div class="agent-decision battle-log"><span>Resolution log</span><p>{{ lastEvent }}</p></div>
        <div class="agent-metrics">
          <div><span>Queued</span><strong>{{ queue.length }}</strong></div><div><span>Energy</span><strong>{{ energy }}</strong></div><div><span>Enemies</span><strong>{{ enemies.length }}</strong></div>
        </div>
        <div class="game-actions">
          <button class="primary-action" :disabled="resolving || won || defeated || roomCleared" @click="toggleAutoplay">{{ autoplay ? 'Take control' : 'Watch agent' }}</button>
          <button :disabled="resolving || autoplay || won || defeated || roomCleared" @click="agentTurn">Agent plan</button>
          <button @click="reset">Restart run</button>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.beat-ribbon{display:grid;grid-template-columns:repeat(3,1fr);gap:.55rem;padding:.8rem 1.4rem;border-bottom:1px solid var(--game-line);background:rgba(0,0,0,.2)}
.beat-ribbon button{min-height:48px;border:1px solid var(--game-line);border-radius:10px;color:var(--game-ink);background:rgba(255,255,255,.04);text-align:left;padding:.45rem .65rem}
.beat-ribbon b,.beat-ribbon span{display:block}.beat-ribbon b{color:var(--game-accent);font-size:.55rem}.beat-ribbon span{margin-top:.2rem;color:var(--game-muted);font-size:.6rem}
.environment-mark{z-index:1;max-width:80%;color:rgba(255,231,194,.65);font-size:.48rem;font-weight:800;text-transform:uppercase}
.rogue-cell.wall{background:#302c31}.rogue-cell.spike{background:repeating-linear-gradient(45deg,#33242a 0 8px,#5b3035 8px 10px)}.rogue-cell.pit{background:radial-gradient(circle,#050408 20%,#1c1520 65%)}.rogue-cell.barrel{background:radial-gradient(circle,#843d26,#2a1920 60%)}.rogue-cell.plate{box-shadow:inset 0 0 0 3px #b8894d}.rogue-cell.gate{background:repeating-linear-gradient(90deg,#4d4745 0 5px,#171419 5px 10px)}.rogue-cell.gate.open{opacity:.38}
.rogue-actor em{position:absolute;left:-9px;top:-9px;display:grid;width:22px;height:22px;place-items:center;transform:rotate(-45deg);border-radius:50%;color:#24131c;background:#ffc778;font-size:.65rem;font-style:normal}
@media(max-width:620px){.beat-ribbon{padding:.6rem}.beat-ribbon span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}}
</style>
