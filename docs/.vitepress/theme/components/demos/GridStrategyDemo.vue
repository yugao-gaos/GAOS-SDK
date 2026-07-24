<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { wait } from './game-utils';

type Side = 'ember' | 'hollow';
type Hex = { q: number; r: number };
type Unit = Hex & {
  id: string;
  side: Side;
  role: 'Ranger' | 'Vanguard' | 'Warden';
  speed: number;
  hp: number;
  maxHp: number;
  damage: number;
  range: number;
  nextAt: number;
  attackReady: number;
};
type Action =
  | { kind: 'move'; unitId: string; target: Hex; recovery: number; value: number }
  | { kind: 'attack'; unitId: string; targetId: string; recovery: number; value: number };

const radius = 2;
const cells: Hex[] = [];
for (let q = -radius; q <= radius; q += 1) {
  const rMin = Math.max(-radius, -q - radius);
  const rMax = Math.min(radius, -q + radius);
  for (let r = rMin; r <= rMax; r += 1) cells.push({ q, r });
}

const seed = ref(903);
const units = ref<Unit[]>([]);
const blocked = ref(new Set<string>());
const locked = ref(false);
const autoplay = ref(false);
const message = ref('');
const decision = ref('Waiting for the first activation');
const lastAction = ref('Timeline initialized');
let runToken = 0;

const living = computed(() => units.value.filter((unit) => unit.hp > 0));
const active = computed(() => [...living.value].sort(compareUnits)[0] ?? null);
const activeSide = computed(() => active.value?.side ?? 'ember');
const winner = computed<Side | null>(() => {
  if (!living.value.some((unit) => unit.side === 'ember')) return 'hollow';
  if (!living.value.some((unit) => unit.side === 'hollow')) return 'ember';
  return null;
});
const currentActions = computed(() => active.value ? legalActions(active.value) : []);
const timeline = computed(() => {
  const forecast = living.value.map((unit) => ({ ...unit }));
  const result: Array<Unit & { forecastAt: number }> = [];
  for (let index = 0; index < 8 && forecast.length; index += 1) {
    forecast.sort(compareUnits);
    const unit = forecast[0];
    result.push({ ...unit, forecastAt: unit.nextAt });
    unit.nextAt += delayFor(unit, 100);
  }
  return result;
});

function key(hex: Hex) {
  return `${hex.q},${hex.r}`;
}

function compareUnits(a: Unit, b: Unit) {
  return a.nextAt - b.nextAt || b.speed - a.speed || a.id.localeCompare(b.id);
}

function distance(a: Hex, b: Hex) {
  const as = -a.q - a.r;
  const bs = -b.q - b.r;
  return Math.max(Math.abs(a.q - b.q), Math.abs(a.r - b.r), Math.abs(as - bs));
}

function delayFor(unit: Unit, recovery: number) {
  return Math.ceil((recovery * 100) / unit.speed);
}

function unitAt(hex: Hex) {
  return living.value.find((unit) => unit.q === hex.q && unit.r === hex.r);
}

function inside(hex: Hex) {
  return distance({ q: 0, r: 0 }, hex) <= radius;
}

function neighbors(hex: Hex) {
  return [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]
    .map(([dq, dr]) => ({ q: hex.q + dq, r: hex.r + dr }))
    .filter(inside);
}

function screen(hex: Hex) {
  return {
    left: `${220 + (hex.q + hex.r / 2) * 82}px`,
    top: `${174 + hex.r * 71}px`,
  };
}

function initialDelay(speed: number) {
  return Math.ceil(10000 / speed);
}

function makeUnit(id: string, side: Side, role: Unit['role'], q: number, r: number): Unit {
  const stats = {
    Ranger: { speed: 160, hp: 3, damage: 1, range: 2 },
    Vanguard: { speed: 100, hp: 5, damage: 2, range: 1 },
    Warden: { speed: 70, hp: 6, damage: 2, range: 1 },
  }[role];
  return { id, side, role, q, r, ...stats, maxHp: stats.hp, nextAt: initialDelay(stats.speed), attackReady: 0 };
}

function reset() {
  runToken += 1;
  autoplay.value = false;
  locked.value = false;
  blocked.value = new Set(['0,-1', '-1,0', '1,0']);
  units.value = [
    makeUnit('e-ranger', 'ember', 'Ranger', -1, 2),
    makeUnit('e-vanguard', 'ember', 'Vanguard', -2, 1),
    makeUnit('e-warden', 'ember', 'Warden', -2, 0),
    makeUnit('h-ranger', 'hollow', 'Ranger', 1, -2),
    makeUnit('h-vanguard', 'hollow', 'Vanguard', 2, -1),
    makeUnit('h-warden', 'hollow', 'Warden', 2, 0),
  ];
  message.value = 'The fastest unit acts first. Choose a highlighted hex or target.';
  decision.value = 'Waiting for the first activation';
  lastAction.value = 'Timeline initialized';
  void maybeRunAgent();
}

function legalActions(unit: Unit): Action[] {
  const enemies = living.value.filter((other) => other.side !== unit.side);
  const actions: Action[] = [];
  if (unit.nextAt >= unit.attackReady) {
    for (const target of enemies) {
      if (distance(unit, target) <= unit.range) {
        actions.push({
          kind: 'attack',
          unitId: unit.id,
          targetId: target.id,
          recovery: unit.role === 'Ranger' ? 120 : 135,
          value: 120 + (target.hp <= unit.damage ? 70 : 0) - target.hp,
        });
      }
    }
  }
  for (const target of neighbors(unit)) {
    if (blocked.value.has(key(target)) || unitAt(target)) continue;
    const closest = Math.min(...enemies.map((enemy) => distance(target, enemy)));
    actions.push({ kind: 'move', unitId: unit.id, target, recovery: 100, value: 50 - closest * 8 });
  }
  return actions.sort((a, b) => b.value - a.value);
}

function cellAction(hex: Hex) {
  const occupant = unitAt(hex);
  return currentActions.value.find((action) =>
    action.kind === 'move'
      ? action.target.q === hex.q && action.target.r === hex.r
      : action.targetId === occupant?.id,
  );
}

async function perform(action: Action, actor: 'human' | 'agent') {
  const unit = active.value;
  if (!unit || unit.id !== action.unitId || locked.value) return;
  locked.value = true;
  if (action.kind === 'move') {
    units.value = units.value.map((item) => item.id === unit.id ? { ...item, ...action.target } : item);
    lastAction.value = `${unit.role} moved to hex ${key(action.target)}.`;
  } else {
    const target = units.value.find((item) => item.id === action.targetId);
    if (target) {
      units.value = units.value.map((item) => item.id === target.id ? { ...item, hp: Math.max(0, item.hp - unit.damage) } : item);
      lastAction.value = `${unit.role} hit ${target.role} for ${unit.damage}${target.hp <= unit.damage ? ' — defeated.' : '.'}`;
    }
  }
  units.value = units.value.map((item) => item.id === unit.id
    ? {
        ...item,
        nextAt: item.nextAt + delayFor(item, action.recovery),
        attackReady: action.kind === 'attack' ? item.nextAt + delayFor(item, 180) : item.attackReady,
      }
    : item);
  message.value = lastAction.value;
  decision.value = `${actor === 'agent' ? 'Agent' : 'Human'} chose ${action.kind} · recovery ${delayFor(unit, action.recovery)} ticks`;
  await wait(330);
  locked.value = false;
  if (winner.value) {
    autoplay.value = false;
    message.value = `${winner.value === 'ember' ? 'Ember Company' : 'Hollow Host'} controls the crossing.`;
    return;
  }
  await maybeRunAgent();
}

function chooseHex(hex: Hex) {
  if (locked.value || autoplay.value || activeSide.value !== 'ember' || winner.value) return;
  const action = cellAction(hex);
  if (action) void perform(action, 'human');
}

async function agentStep() {
  if (locked.value || winner.value || !active.value) return;
  const options = legalActions(active.value);
  const best = options[0];
  if (!best) return;
  decision.value = `${active.value.role} evaluated ${options.length} actions · value ${best.value}`;
  await wait(260);
  await perform(best, 'agent');
}

async function maybeRunAgent() {
  if (winner.value || locked.value) return;
  if (activeSide.value === 'hollow' || autoplay.value) {
    await wait(260);
    await agentStep();
  } else {
    message.value = `${active.value?.role} is ready at tick ${active.value?.nextAt}. Choose its action.`;
  }
}

async function toggleAutoplay() {
  autoplay.value = !autoplay.value;
  if (autoplay.value) await maybeRunAgent();
}

function mark(role: Unit['role']) {
  return role === 'Ranger' ? 'R' : role === 'Vanguard' ? 'V' : 'W';
}

onUnmounted(() => { runToken += 1; });
reset();
</script>

<template>
  <section class="game-demo game-demo--strategy">
    <header class="game-hero">
      <div>
        <span class="game-eyebrow">Hex tactics · deterministic speed timeline</span>
        <h2>Ashfall Crossing</h2>
        <p>Fast units cycle through the timeline while heavy actions push their next activation farther into the future.</p>
      </div>
      <div class="game-status-pill" :data-active="autoplay">{{ winner ? `${winner} wins` : `${active?.role} · tick ${active?.nextAt}` }}</div>
    </header>

    <div class="turn-ribbon">
      <span
        v-for="(entry, index) in timeline"
        :key="`${entry.id}-${index}`"
        class="turn-chip"
        :class="[entry.side, { now: index === 0 }]"
      >
        <b>{{ index === 0 ? 'NOW' : entry.forecastAt }}</b>
        <i>{{ mark(entry.role) }}</i>
        <small>{{ entry.role }}</small>
      </span>
    </div>

    <div class="game-layout">
      <div class="game-stage hex-stage">
        <div class="hex-board">
          <button
            v-for="cell in cells"
            :key="key(cell)"
            class="hex-cell"
            :class="{
              blocked: blocked.has(key(cell)),
              reachable: cellAction(cell)?.kind === 'move',
              targetable: cellAction(cell)?.kind === 'attack',
              active: unitAt(cell)?.id === active?.id,
            }"
            :style="screen(cell)"
            @click="chooseHex(cell)"
          >
            <span v-if="blocked.has(key(cell))" class="hex-rock">✦</span>
            <span v-if="unitAt(cell)" class="unit-token" :class="unitAt(cell)!.side">
              <b>{{ mark(unitAt(cell)!.role) }}</b>
              <i><span :style="{ width: `${(unitAt(cell)!.hp / unitAt(cell)!.maxHp) * 100}%` }"></span></i>
            </span>
            <small>{{ key(cell) }}</small>
          </button>
        </div>
        <div class="game-message">{{ message }}</div>
      </div>

      <aside class="agent-console">
        <div class="agent-console__head">
          <span class="agent-orb" :class="{ thinking: locked || autoplay }"></span>
          <div><strong>Timeline evaluator</strong><small>Speed · recovery · cooldown · target value</small></div>
        </div>
        <div class="agent-decision"><span>Latest decision</span><p>{{ decision }}</p></div>
        <div class="agent-decision battle-log"><span>Battle log</span><p>{{ lastAction }}</p></div>
        <div class="agent-metrics">
          <div><span>Legal</span><strong>{{ currentActions.length }}</strong></div>
          <div><span>Speed</span><strong>{{ active?.speed }}</strong></div>
          <div><span>Tick</span><strong>{{ active?.nextAt }}</strong></div>
        </div>
        <div class="game-actions">
          <button class="primary-action" :disabled="locked || !!winner" @click="toggleAutoplay">{{ autoplay ? 'Take control' : 'Watch timeline' }}</button>
          <button :disabled="locked || autoplay || !!winner" @click="agentStep">Agent step</button>
          <button @click="reset">Restart battle</button>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.turn-ribbon { display:flex; gap:.5rem; overflow-x:auto; overscroll-behavior-inline:contain; padding:.9rem 1.4rem; border-bottom:1px solid var(--game-line); background:rgba(0,0,0,.18); scrollbar-color:rgba(255,255,255,.28) transparent; scrollbar-width:thin; scroll-snap-type:x proximity; }
.turn-chip { display:grid; grid-template-columns:auto auto; grid-template-rows:auto auto; min-width:96px; align-items:center; gap:0 .45rem; border:1px solid rgba(255,255,255,.1); border-radius:12px; padding:.45rem .6rem; background:rgba(255,255,255,.04); scroll-snap-align:start; }
.turn-chip.now { border-color:var(--game-accent); box-shadow:0 0 18px rgba(255,184,92,.18); }
.turn-chip > b { grid-row:1/3; color:var(--game-muted); font-size:.55rem; }
.turn-chip > i { display:grid; width:24px; height:24px; place-items:center; border-radius:50%; color:white; background:#89483a; font-style:normal; font-size:.65rem; }
.turn-chip.hollow > i { background:#3b497f; }
.turn-chip small { color:var(--game-muted); font-size:.53rem; }
.hex-stage { min-height:560px; }
.hex-board { position:relative; width:440px; height:390px; margin:0 auto; }
.hex-cell { position:absolute; width:92px; height:80px; transform:translate(-50%,-50%); clip-path:polygon(25% 0,75% 0,100% 50%,75% 100%,25% 100%,0 50%); border:0; color:white; background:#2a2d35; cursor:pointer; transition:filter .15s, transform .15s; }
.hex-cell:nth-child(2n) { background:#242831; }
.hex-cell:hover { filter:brightness(1.15); }
.hex-cell.reachable { background:#285047; box-shadow:inset 0 0 0 4px #64d1b6; }
.hex-cell.targetable { background:#5b2d31; box-shadow:inset 0 0 0 4px #ef7567; }
.hex-cell.active { filter:drop-shadow(0 0 9px #ffbb68); }
.hex-cell small { position:absolute; right:20px; bottom:7px; color:rgba(255,255,255,.2); font-size:.42rem; }
.hex-rock { color:rgba(240,210,160,.42); font-size:1.6rem; }
@media(max-width:580px){
  .turn-ribbon{padding:.75rem}
  .turn-chip{min-width:82px}
  .hex-stage{min-height:480px;overflow:hidden;padding-right:.75rem;padding-left:.75rem}
  .hex-board{width:440px;height:390px;margin-right:0;margin-bottom:-109px;margin-left:calc(50% - 220px);transform:scale(.72);transform-origin:top center}
}
</style>
