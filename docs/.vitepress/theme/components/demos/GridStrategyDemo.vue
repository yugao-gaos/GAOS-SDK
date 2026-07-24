<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue';
import { withBase } from 'vitepress';
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
type AttackEffect = {
  id: number;
  attackerId: string;
  targetId: string;
  from: Hex;
  to: Hex;
  side: Side;
};
type DamageEffect = {
  id: number;
  at: Hex;
  amount: number;
  lethal: boolean;
};

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
const hoveredCell = ref<Hex | null>(null);
const movingUnitId = ref<string | null>(null);
const attackEffect = ref<AttackEffect | null>(null);
const damageEffect = ref<DamageEffect | null>(null);
let runToken = 0;
let effectId = 0;

const living = computed(() => units.value.filter((unit) => unit.hp > 0));
const active = computed(() => [...living.value].sort(compareUnits)[0] ?? null);
const activeSide = computed(() => active.value?.side ?? 'ember');
const winner = computed<Side | null>(() => {
  if (!living.value.some((unit) => unit.side === 'ember')) return 'hollow';
  if (!living.value.some((unit) => unit.side === 'hollow')) return 'ember';
  return null;
});
const currentActions = computed(() => active.value ? legalActions(active.value) : []);
const hoverPreview = computed(() => {
  const unit = active.value;
  const target = hoveredCell.value;
  if (!unit || !target || locked.value) return null;
  const action = cellAction(target);
  if (!action) return null;
  const segment = segmentBetween(unit, target, 29, action.kind === 'attack' ? 31 : 10);
  return segment ? { ...segment, kind: action.kind } : null;
});
const attackVisual = computed(() => {
  const effect = attackEffect.value;
  if (!effect) return null;
  const segment = segmentBetween(effect.from, effect.to, 28, 30);
  if (!segment) return null;
  return {
    ...segment,
    style: {
      left: `${segment.x1}px`,
      top: `${segment.y1}px`,
      '--travel-x': `${segment.x2 - segment.x1}px`,
      '--travel-y': `${segment.y2 - segment.y1}px`,
    },
  };
});
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

function point(hex: Hex) {
  return {
    x: 220 + (hex.q + hex.r / 2) * 82,
    y: 174 + hex.r * 71,
  };
}

function screen(hex: Hex) {
  const { x, y } = point(hex);
  return { left: `${x}px`, top: `${y}px` };
}

function segmentBetween(from: Hex, to: Hex, startInset: number, endInset: number) {
  const start = point(from);
  const end = point(to);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.hypot(dx, dy);
  if (!length) return null;
  const ux = dx / length;
  const uy = dy / length;
  return {
    x1: start.x + ux * startInset,
    y1: start.y + uy * startInset,
    x2: end.x - ux * endInset,
    y2: end.y - uy * endInset,
  };
}

function unitStyle(unit: Unit) {
  const style: Record<string, string> = screen(unit);
  const effect = attackEffect.value;
  if (effect?.attackerId === unit.id) {
    const from = point(effect.from);
    const to = point(effect.to);
    const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
    style['--attack-x'] = `${((to.x - from.x) / length) * 18}px`;
    style['--attack-y'] = `${((to.y - from.y) / length) * 18}px`;
  }
  return style;
}

function damageStyle(effect: DamageEffect) {
  return screen(effect.at);
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
  hoveredCell.value = null;
  movingUnitId.value = null;
  attackEffect.value = null;
  damageEffect.value = null;
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

function previewCell(hex: Hex) {
  if (locked.value || autoplay.value || activeSide.value !== 'ember' || winner.value) return;
  hoveredCell.value = cellAction(hex) ? hex : null;
}

function clearPreview() {
  hoveredCell.value = null;
}

async function perform(action: Action, actor: 'human' | 'agent') {
  const unit = active.value;
  if (!unit || unit.id !== action.unitId || locked.value) return;
  locked.value = true;
  hoveredCell.value = null;
  if (action.kind === 'move') {
    movingUnitId.value = unit.id;
    await nextTick();
    units.value = units.value.map((item) => item.id === unit.id ? { ...item, ...action.target } : item);
    lastAction.value = `${unit.role} moved to hex ${key(action.target)}.`;
    await wait(460);
    movingUnitId.value = null;
  } else {
    const target = units.value.find((item) => item.id === action.targetId);
    if (target) {
      const id = ++effectId;
      attackEffect.value = {
        id,
        attackerId: unit.id,
        targetId: target.id,
        from: { q: unit.q, r: unit.r },
        to: { q: target.q, r: target.r },
        side: unit.side,
      };
      await nextTick();
      await wait(340);
      units.value = units.value.map((item) => item.id === target.id ? { ...item, hp: Math.max(0, item.hp - unit.damage) } : item);
      damageEffect.value = {
        id,
        at: { q: target.q, r: target.r },
        amount: unit.damage,
        lethal: target.hp <= unit.damage,
      };
      lastAction.value = `${unit.role} hit ${target.role} for ${unit.damage}${target.hp <= unit.damage ? ' — defeated.' : '.'}`;
      await wait(480);
      attackEffect.value = null;
      damageEffect.value = null;
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
  await wait(120);
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

function portrait(unit: Unit) {
  return withBase(`/images/units/${unit.side}-${unit.role.toLowerCase()}.jpg`);
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
        <img class="turn-chip__avatar" :src="portrait(entry)" alt="" aria-hidden="true">
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
            @mouseenter="previewCell(cell)"
            @mouseleave="clearPreview"
            @focus="previewCell(cell)"
            @blur="clearPreview"
            @click="chooseHex(cell)"
          >
            <span v-if="blocked.has(key(cell))" class="hex-rock">✦</span>
            <small>{{ key(cell) }}</small>
          </button>
          <svg class="board-effects" viewBox="0 0 440 390" aria-hidden="true">
            <defs>
              <marker id="path-preview-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z"></path>
              </marker>
            </defs>
            <line
              v-if="hoverPreview"
              :x1="hoverPreview.x1"
              :y1="hoverPreview.y1"
              :x2="hoverPreview.x2"
              :y2="hoverPreview.y2"
              class="path-preview"
              :class="hoverPreview.kind"
              marker-end="url(#path-preview-arrow)"
            ></line>
            <line
              v-if="attackVisual"
              :x1="attackVisual.x1"
              :y1="attackVisual.y1"
              :x2="attackVisual.x2"
              :y2="attackVisual.y2"
              class="attack-trail"
              :class="attackEffect?.side"
            ></line>
          </svg>
          <span
            v-for="unit in living"
            :key="unit.id"
            class="board-unit unit-token"
            :class="[
              unit.side,
              {
                active: unit.id === active?.id,
                'is-moving': unit.id === movingUnitId,
                'is-attacking': unit.id === attackEffect?.attackerId,
                'is-hit': unit.id === attackEffect?.targetId,
              },
            ]"
            :style="unitStyle(unit)"
          >
            <img :src="portrait(unit)" :alt="`${unit.side} ${unit.role}`">
            <i><span :style="{ width: `${(unit.hp / unit.maxHp) * 100}%` }"></span></i>
          </span>
          <span
            v-if="attackVisual"
            :key="attackEffect!.id"
            class="attack-projectile"
            :class="attackEffect?.side"
            :style="attackVisual.style"
            aria-hidden="true"
          ></span>
          <span
            v-if="damageEffect"
            :key="damageEffect.id"
            class="damage-pop"
            :class="{ lethal: damageEffect.lethal }"
            :style="damageStyle(damageEffect)"
            aria-live="polite"
          >−{{ damageEffect.amount }}</span>
        </div>
        <div class="game-message">{{ message }}</div>
        <section class="how-to-play" aria-labelledby="strategy-how-to-play">
          <div class="how-to-play__head">
            <span>Quick guide</span>
            <h3 id="strategy-how-to-play">How to play</h3>
          </div>
          <ol>
            <li>
              <b>1</b>
              <span><strong>Read the timeline</strong>NOW marks the active unit. You command Ember; Hollow turns resolve automatically.</span>
            </li>
            <li>
              <b>2</b>
              <span><strong>Preview an action</strong>Hover or focus a green move hex or red enemy to see its directional arrow.</span>
            </li>
            <li>
              <b>3</b>
              <span><strong>Move or attack</strong>Click the highlighted destination or enemy. Damage drains the green health bar.</span>
            </li>
            <li>
              <b>4</b>
              <span><strong>Win the crossing</strong>Defeat every Hollow unit. Watch timeline autoplays both armies.</span>
            </li>
          </ol>
        </section>
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
.turn-chip__avatar { display:block; width:28px; height:28px; object-fit:cover; border:2px solid #ffbd71; border-radius:50%; background:#89483a; box-shadow:0 3px 8px rgba(0,0,0,.35); }
.turn-chip.hollow .turn-chip__avatar { border-color:#a9baff; background:#3b497f; }
.turn-chip small { color:var(--game-muted); font-size:.53rem; }
.hex-stage { min-height:560px; }
.hex-board { position:relative; width:440px; height:390px; margin:0 auto; }
.hex-cell { position:absolute; display:grid; width:80px; height:92px; place-items:center; transform:translate(-50%,-50%); clip-path:polygon(50% 0,100% 25%,100% 75%,50% 100%,0 75%,0 25%); border:0; padding:0; color:white; background:#2a2d35; cursor:pointer; transition:filter .15s, transform .15s; }
.hex-cell:nth-child(2n) { background:#242831; }
.hex-cell:hover { filter:brightness(1.15); }
.hex-cell.reachable { background:#285047; box-shadow:inset 0 0 0 4px #64d1b6; }
.hex-cell.targetable { background:#5b2d31; box-shadow:inset 0 0 0 4px #ef7567; }
.hex-cell.active { filter:drop-shadow(0 0 9px #ffbb68); }
.hex-cell small { position:absolute; right:20px; bottom:7px; color:rgba(255,255,255,.2); font-size:.42rem; }
.hex-rock { color:rgba(240,210,160,.42); font-size:1.6rem; }
.board-effects { position:absolute; z-index:2; inset:0; width:100%; height:100%; overflow:visible; pointer-events:none; }
.path-preview { stroke:#75e2c5; stroke-width:3; stroke-linecap:round; stroke-dasharray:7 6; filter:drop-shadow(0 0 4px rgba(117,226,197,.8)); animation:path-flow .55s linear infinite; }
.path-preview.attack { stroke:#ff8b7d; filter:drop-shadow(0 0 5px rgba(255,105,93,.9)); }
.path-preview + * { pointer-events:none; }
#path-preview-arrow path { fill:context-stroke; }
.attack-trail { stroke-width:3; stroke-linecap:round; stroke-dasharray:4 7; opacity:.75; animation:attack-trail .82s ease-out both; }
.attack-trail.ember { stroke:#ff9d58; filter:drop-shadow(0 0 5px #ff7048); }
.attack-trail.hollow { stroke:#8fb7ff; filter:drop-shadow(0 0 5px #6f79ff); }
.board-unit { position:absolute; z-index:3; width:53px; height:53px; overflow:hidden; transform:translate(-50%,-50%); pointer-events:none; transition:left 400ms cubic-bezier(.2,.8,.2,1),top 400ms cubic-bezier(.2,.8,.2,1),filter 160ms ease; }
.board-unit.active { filter:drop-shadow(0 0 8px #ffbd67); }
.board-unit img { display:block; width:100%; height:100%; object-fit:cover; }
.board-unit.is-moving { animation:unit-hop 460ms ease-in-out both; }
.board-unit.is-attacking { animation:unit-lunge 420ms ease-in-out both; }
.board-unit.is-hit { animation:unit-hit 360ms ease-out both; }
.attack-projectile { position:absolute; z-index:4; width:10px; height:10px; border:2px solid rgba(255,255,255,.8); border-radius:50%; pointer-events:none; animation:projectile-flight 340ms cubic-bezier(.2,.7,.25,1) both; }
.attack-projectile.ember { background:#ffb05e; box-shadow:0 0 5px #fff,0 0 14px #ff6b3f; }
.attack-projectile.hollow { background:#9ec5ff; box-shadow:0 0 5px #fff,0 0 14px #6b74ff; }
.damage-pop { position:absolute; z-index:5; color:#fff4e1; pointer-events:none; text-shadow:0 2px 3px #000,0 0 8px #ff503f; font-family:Georgia,'Times New Roman',serif; font-size:1.35rem; font-weight:900; animation:damage-rise 480ms ease-out both; }
.damage-pop.lethal { color:#ffd36e; font-size:1.55rem; text-shadow:0 2px 3px #000,0 0 10px #ff9b3f; }
.how-to-play { width:min(440px,100%); margin:1rem auto 0; border:1px solid rgba(117,226,197,.16); border-radius:16px; padding:1rem; background:linear-gradient(145deg,rgba(117,226,197,.07),rgba(255,255,255,.025)); }
.how-to-play__head { display:flex; align-items:baseline; justify-content:space-between; gap:1rem; margin-bottom:.75rem; }
.how-to-play__head span { color:#75e2c5; font-size:.55rem; font-weight:850; letter-spacing:.12em; text-transform:uppercase; }
.how-to-play h3 { margin:0; color:var(--game-ink); font-family:Georgia,'Times New Roman',serif; font-size:1.05rem; font-weight:500; }
.how-to-play ol { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.55rem; margin:0; padding:0; list-style:none; }
.how-to-play li { display:grid; grid-template-columns:24px 1fr; align-items:start; gap:.55rem; min-width:0; border:1px solid rgba(255,255,255,.07); border-radius:11px; padding:.65rem; color:var(--game-muted); background:rgba(0,0,0,.12); font-size:.56rem; line-height:1.45; }
.how-to-play li > b { display:grid; width:24px; height:24px; place-items:center; border-radius:50%; color:#10221d; background:#75e2c5; font-size:.58rem; }
.how-to-play li strong { display:block; margin-bottom:.12rem; color:var(--game-ink); font-size:.62rem; }
@keyframes path-flow { to { stroke-dashoffset:-13; } }
@keyframes attack-trail { 0% { opacity:0; stroke-dashoffset:20; } 25% { opacity:.95; } 100% { opacity:0; stroke-dashoffset:0; } }
@keyframes unit-hop {
  0%,100% { transform:translate(-50%,-50%) scale(1); }
  50% { transform:translate(-50%,calc(-50% - 9px)) scale(1.06); filter:drop-shadow(0 10px 7px rgba(0,0,0,.5)); }
}
@keyframes unit-lunge {
  0%,100% { transform:translate(-50%,-50%) scale(1); }
  45% { transform:translate(calc(-50% + var(--attack-x)),calc(-50% + var(--attack-y))) scale(1.08); }
}
@keyframes unit-hit {
  0%,100% { transform:translate(-50%,-50%); filter:none; }
  30% { transform:translate(calc(-50% - 5px),-50%); filter:brightness(2) saturate(.5); }
  60% { transform:translate(calc(-50% + 4px),-50%); filter:brightness(1.5); }
}
@keyframes projectile-flight {
  0% { transform:translate(-50%,-50%) scale(.45); opacity:0; }
  12% { opacity:1; }
  100% { transform:translate(calc(-50% + var(--travel-x)),calc(-50% + var(--travel-y))) scale(1.35); opacity:0; }
}
@keyframes damage-rise {
  0% { transform:translate(-50%,-25%) scale(.55); opacity:0; }
  22% { transform:translate(-50%,-85%) scale(1.2); opacity:1; }
  100% { transform:translate(-50%,-190%) scale(1); opacity:0; }
}
@media(max-width:580px){
  .turn-ribbon{padding:.75rem}
  .turn-chip{min-width:82px}
  .hex-stage{min-height:480px;overflow:hidden;padding-right:.75rem;padding-left:.75rem}
  .hex-board{width:440px;height:390px;margin-right:0;margin-bottom:-109px;margin-left:calc(50% - 220px);transform:scale(.72);transform-origin:top center}
  .how-to-play{margin-top:.75rem;padding:.8rem}
  .how-to-play ol{grid-template-columns:1fr}
}
</style>
