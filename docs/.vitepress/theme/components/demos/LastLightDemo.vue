<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

type TowerKind = 'rifle' | 'floodlight' | 'molotov';
type Tower = { socket: number; kind: TowerKind; cooldown: number };
type Zombie = { id: number; type: 'Shambler' | 'Runner' | 'Brute' | 'Screamer'; route: number; segment: number; progress: number; hp: number; maxHp: number; speed: number };
type MapPoint = { x: number; y: number };

const routes: MapPoint[][] = [
  [{ x: 4, y: 50 }, { x: 28, y: 50 }, { x: 48, y: 24 }, { x: 72, y: 50 }, { x: 96, y: 50 }],
  [{ x: 4, y: 50 }, { x: 28, y: 50 }, { x: 48, y: 77 }, { x: 72, y: 50 }, { x: 96, y: 50 }],
];
const sockets: MapPoint[] = [
  { x: 20, y: 35 }, { x: 20, y: 67 }, { x: 43, y: 48 },
  { x: 55, y: 12 }, { x: 56, y: 88 }, { x: 69, y: 31 }, { x: 69, y: 70 }, { x: 84, y: 35 },
];
const towerInfo = {
  rifle: { name: 'Rifle nest', cost: 35, glyph: 'R', range: 20 },
  floodlight: { name: 'Floodlight', cost: 30, glyph: 'F', range: 18 },
  molotov: { name: 'Molotov post', cost: 50, glyph: 'M', range: 23 },
};

const zombies = ref<Zombie[]>([]);
const towers = ref<Tower[]>([]);
const selectedTower = ref<TowerKind>('rifle');
const scrap = ref(90);
const safehouseHp = ref(12);
const wave = ref(1);
const tick = ref(0);
const spawned = ref(0);
const paused = ref(false);
const speed = ref(1);
const agentBuilder = ref(false);
const message = ref('Build around the road network before the horde reaches the safehouse.');
const decision = ref('Human controls construction');
let zombieId = 0;
let timer: ReturnType<typeof setInterval> | undefined;

const waveQuota = computed(() => 5 + wave.value * 3);
const gameOver = computed(() => safehouseHp.value <= 0);
const victory = computed(() => wave.value > 3 && zombies.value.length === 0);

function lineStyle(a: MapPoint, b: MapPoint) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return {
    left: `${a.x}%`, top: `${a.y}%`,
    width: `${Math.hypot(dx, dy)}%`,
    transform: `rotate(${Math.atan2(dy, dx) * 180 / Math.PI}deg)`,
  };
}

function zombiePoint(zombie: Zombie) {
  const route = routes[zombie.route];
  const from = route[Math.min(zombie.segment, route.length - 1)];
  const to = route[Math.min(zombie.segment + 1, route.length - 1)];
  const t = zombie.progress / 100;
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

function zombieStyle(zombie: Zombie) {
  const point = zombiePoint(zombie);
  return { left: `${point.x}%`, top: `${point.y}%` };
}

function build(socket: number, kind = selectedTower.value) {
  if (paused.value || towers.value.some((tower) => tower.socket === socket) || scrap.value < towerInfo[kind].cost || gameOver.value || victory.value) return;
  scrap.value -= towerInfo[kind].cost;
  towers.value.push({ socket, kind, cooldown: 0 });
  message.value = `${towerInfo[kind].name} constructed for ${towerInfo[kind].cost} scrap.`;
}

function spawnZombie() {
  const order: Zombie['type'][] = ['Shambler', 'Runner', 'Shambler', 'Screamer', 'Brute'];
  const type = order[(spawned.value + wave.value) % order.length];
  const stats = {
    Shambler: { hp: 4, speed: 1.15 },
    Runner: { hp: 3, speed: 1.9 },
    Brute: { hp: 10, speed: .72 },
    Screamer: { hp: 5, speed: 1.05 },
  }[type];
  zombies.value.push({
    id: ++zombieId, type, route: spawned.value % 2, segment: 0, progress: 0,
    hp: stats.hp + wave.value - 1, maxHp: stats.hp + wave.value - 1, speed: stats.speed,
  });
  spawned.value += 1;
}

function nearestTargets(socket: MapPoint, range: number) {
  return zombies.value
    .map((zombie) => ({ zombie, point: zombiePoint(zombie) }))
    .filter(({ point }) => Math.hypot(point.x - socket.x, point.y - socket.y) <= range)
    .sort((a, b) => {
      const progressA = a.zombie.segment * 100 + a.zombie.progress;
      const progressB = b.zombie.segment * 100 + b.zombie.progress;
      return progressB - progressA;
    });
}

function runTowers() {
  for (const tower of towers.value) {
    if (tower.cooldown > 0) {
      tower.cooldown -= 1;
      continue;
    }
    const socket = sockets[tower.socket];
    const targets = nearestTargets(socket, towerInfo[tower.kind].range);
    if (!targets.length || tower.kind === 'floodlight') continue;
    if (tower.kind === 'rifle') {
      const target = targets[0].zombie;
      target.hp -= 2;
      tower.cooldown = 7;
      message.value = `Rifle nest hit a ${target.type}.`;
    } else {
      for (const { zombie } of targets.slice(0, 3)) zombie.hp -= 2;
      tower.cooldown = 15;
      message.value = 'Molotov burst scorched the horde.';
    }
  }
  const defeated = zombies.value.filter((zombie) => zombie.hp <= 0);
  if (defeated.length) scrap.value += defeated.reduce((sum, zombie) => sum + (zombie.type === 'Brute' ? 8 : 4), 0);
  zombies.value = zombies.value.filter((zombie) => zombie.hp > 0);
}

function moveZombies() {
  for (const zombie of zombies.value) {
    const point = zombiePoint(zombie);
    const slowed = towers.value.some((tower) => {
      if (tower.kind !== 'floodlight') return false;
      const socket = sockets[tower.socket];
      return Math.hypot(point.x - socket.x, point.y - socket.y) <= towerInfo.floodlight.range;
    });
    const screamerBoost = zombies.value.some((other) => other.type === 'Screamer' && other.id !== zombie.id && Math.hypot(zombiePoint(other).x - point.x, zombiePoint(other).y - point.y) < 12);
    zombie.progress += zombie.speed * (slowed ? .55 : 1) * (screamerBoost ? 1.25 : 1);
    if (zombie.progress >= 100) {
      zombie.segment += 1;
      zombie.progress -= 100;
      if (zombie.segment >= routes[zombie.route].length - 1) {
        safehouseHp.value -= zombie.type === 'Brute' ? 3 : 1;
        zombie.hp = 0;
        message.value = `${zombie.type} reached the safehouse.`;
      }
    }
  }
  zombies.value = zombies.value.filter((zombie) => zombie.hp > 0);
}

function agentBuild() {
  const open = sockets.map((_, index) => index).filter((index) => !towers.value.some((tower) => tower.socket === index));
  if (!open.length) return;
  const kind: TowerKind = towers.value.every((tower) => tower.kind !== 'floodlight') && scrap.value >= towerInfo.floodlight.cost
    ? 'floodlight'
    : scrap.value >= towerInfo.molotov.cost && wave.value >= 2 ? 'molotov' : 'rifle';
  if (scrap.value >= towerInfo[kind].cost) {
    const socket = open[Math.floor(open.length / 2)];
    build(socket, kind);
    decision.value = `Builder agent placed ${towerInfo[kind].name} at defense socket ${socket + 1}`;
  }
}

function advance() {
  if (paused.value || gameOver.value || victory.value || (typeof document !== 'undefined' && document.hidden)) return;
  for (let frame = 0; frame < speed.value; frame += 1) {
    tick.value += 1;
    if (wave.value <= 3 && spawned.value < waveQuota.value && tick.value % Math.max(10, 20 - wave.value * 2) === 0) spawnZombie();
    runTowers();
    moveZombies();
    if (agentBuilder.value && tick.value % 30 === 0) agentBuild();
    if (wave.value <= 3 && spawned.value >= waveQuota.value && zombies.value.length === 0) {
      wave.value += 1;
      spawned.value = 0;
      scrap.value += 35;
      message.value = wave.value > 3 ? 'Dawn breaks. The safehouse survived.' : `Wave ${wave.value} approaches. +35 scrap.`;
    }
  }
}

function reset() {
  zombies.value = [];
  towers.value = [];
  scrap.value = 90;
  safehouseHp.value = 12;
  wave.value = 1;
  tick.value = 0;
  spawned.value = 0;
  paused.value = false;
  agentBuilder.value = false;
  decision.value = 'Human controls construction';
  message.value = 'Build around the road network before the horde reaches the safehouse.';
  zombieId = 0;
}

onMounted(() => { timer = setInterval(advance, 100); });
onUnmounted(() => { if (timer) clearInterval(timer); });
reset();
</script>

<template>
  <section class="game-demo lastlight-demo">
    <header class="game-hero">
      <div>
        <span class="game-eyebrow">Real-time zombie tower defense · road graph</span>
        <h2>Last Light</h2>
        <p>Place survivor defenses around branching roads, slow the horde with floodlights, and keep the safehouse alive until dawn.</p>
      </div>
      <div class="game-status-pill" :data-active="!paused">{{ victory ? 'Dawn survived' : gameOver ? 'Safehouse lost' : `Wave ${wave}` }}</div>
    </header>

    <div class="game-layout">
      <div class="game-stage lastlight-stage">
        <div class="defense-hud">
          <span>Safehouse <b>{{ safehouseHp }} HP</b></span><span>Scrap <b>{{ scrap }}</b></span><span>Horde <b>{{ zombies.length }}</b></span>
        </div>
        <div class="defense-map">
          <template v-for="(route, routeIndex) in routes" :key="routeIndex">
            <div v-for="(_, index) in route.slice(0, -1)" :key="`${routeIndex}-${index}`" class="road-edge" :style="lineStyle(route[index], route[index + 1])"></div>
          </template>
          <span class="safehouse"><b>SAFE</b></span>
          <span class="breach">BREACH</span>
          <button
            v-for="(socket, index) in sockets"
            :key="index"
            class="tower-socket"
            :class="{ built: towers.some((tower) => tower.socket === index) }"
            :style="{ left: `${socket.x}%`, top: `${socket.y}%` }"
            @click="build(index)"
          >
            <template v-if="towers.find((tower) => tower.socket === index)">
              <b>{{ towerInfo[towers.find((tower) => tower.socket === index)!.kind].glyph }}</b>
            </template>
            <span v-else>+</span>
          </button>
          <span v-for="zombie in zombies" :key="zombie.id" class="zombie" :class="zombie.type.toLowerCase()" :style="zombieStyle(zombie)">
            <b>{{ zombie.type[0] }}</b><i><span :style="{ width: `${(zombie.hp / zombie.maxHp) * 100}%` }"></span></i>
          </span>
        </div>
        <div class="game-message">{{ message }}</div>
        <div class="build-tray">
          <button v-for="(info, kind) in towerInfo" :key="kind" :class="{ selected: selectedTower === kind }" @click="selectedTower = kind">
            <b>{{ info.glyph }}</b><span>{{ info.name }}</span><small>{{ info.cost }} scrap</small>
          </button>
        </div>
      </div>

      <aside class="agent-console">
        <div class="agent-console__head"><span class="agent-orb" :class="{ thinking: !paused }"></span><div><strong>Survival builder</strong><small>Coverage · horde mix · scrap economy</small></div></div>
        <div class="agent-decision"><span>Latest decision</span><p>{{ decision }}</p></div>
        <div class="agent-metrics"><div><span>Wave</span><strong>{{ Math.min(3, wave) }}</strong></div><div><span>Zombies</span><strong>{{ zombies.length }}</strong></div><div><span>Tick</span><strong>{{ tick }}</strong></div></div>
        <div class="game-actions">
          <button class="primary-action" :disabled="gameOver || victory" @click="agentBuilder = !agentBuilder">{{ agentBuilder ? 'Take construction' : 'Watch builder agent' }}</button>
          <button @click="paused = !paused">{{ paused ? 'Resume' : 'Pause' }}</button>
          <button @click="speed = speed === 1 ? 2 : 1">Simulation ×{{ speed === 1 ? 2 : 1 }}</button>
          <button @click="reset">Restart defense</button>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.lastlight-demo{--game-accent:#f0b45f;background:radial-gradient(circle at 75% 30%,rgba(196,103,45,.18),transparent 40%),#10130f}
.lastlight-stage{min-height:650px;background:linear-gradient(rgba(255,255,255,.015),rgba(255,255,255,0)),#171a15}
.defense-hud{display:flex;justify-content:center;gap:1.4rem;margin-bottom:.8rem;color:var(--game-muted);font-size:.65rem;text-transform:uppercase}.defense-hud b{margin-left:.3rem;color:var(--game-ink)}
.defense-map{position:relative;width:min(780px,100%);height:430px;margin:auto;overflow:hidden;border:1px solid rgba(240,180,95,.13);border-radius:20px;background:radial-gradient(circle at 30% 30%,rgba(87,104,60,.26),transparent 35%),repeating-linear-gradient(15deg,rgba(255,255,255,.015) 0 1px,transparent 1px 19px),#1b2119}
.road-edge{position:absolute;height:17px;transform-origin:left center;border-top:2px dashed rgba(236,206,149,.28);border-bottom:2px solid rgba(57,48,38,.7);background:#3a352d;pointer-events:none}
.tower-socket{position:absolute;z-index:3;display:grid;width:44px;height:44px;place-items:center;transform:translate(-50%,-50%);border:2px dashed rgba(255,255,255,.28);border-radius:50%;color:#d4c6a4;background:#252b21;cursor:pointer}.tower-socket.built{border-style:solid;border-color:#efb45d;color:#21160c;background:#d18b42;box-shadow:0 0 16px rgba(240,180,95,.3)}
.zombie{position:absolute;z-index:4;display:grid;width:25px;height:25px;place-items:center;transform:translate(-50%,-50%);border:1px solid #b3c28c;border-radius:45% 55% 50% 45%;color:#17200f;background:#77964f;font-size:.55rem;transition:left .1s linear,top .1s linear}.zombie.runner{background:#b0a94e}.zombie.brute{width:33px;height:33px;background:#65583d}.zombie.screamer{background:#875b74}.zombie i{position:absolute;right:-3px;bottom:-6px;left:-3px;height:3px;background:#291e1e}.zombie i span{display:block;height:100%;background:#db5d51}
.safehouse,.breach{position:absolute;z-index:2;top:50%;display:grid;place-items:center;transform:translate(-50%,-50%);font-size:.55rem;font-weight:900}.safehouse{left:94.5%;width:62px;height:62px;border:3px solid #e9b867;color:#23180d;background:#b66a34;box-shadow:0 0 25px rgba(237,172,91,.35)}.breach{left:5.5%;color:#d97769}
.build-tray{display:flex;justify-content:center;gap:.55rem;margin-top:.8rem}.build-tray button{display:grid;grid-template-columns:auto 1fr;min-width:145px;align-items:center;border:1px solid var(--game-line);border-radius:10px;padding:.5rem;color:var(--game-ink);background:rgba(255,255,255,.04);cursor:pointer;text-align:left}.build-tray button.selected{border-color:var(--game-accent);background:rgba(240,180,95,.1)}.build-tray b{grid-row:1/3;display:grid;width:28px;height:28px;margin-right:.5rem;place-items:center;border-radius:50%;background:#bb7538}.build-tray span{font-size:.65rem}.build-tray small{color:var(--game-muted);font-size:.52rem}
@media(max-width:650px){.defense-map{height:360px}.safehouse{left:90%}.breach{left:9%}.build-tray{flex-direction:column}.build-tray button{width:100%;min-height:44px}}
</style>
