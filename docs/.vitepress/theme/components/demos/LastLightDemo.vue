<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { withBase } from 'vitepress';

type TowerKind = 'rifle' | 'floodlight' | 'molotov';
type Tower = { socket: number; kind: TowerKind; cooldown: number };
type Zombie = { id: number; type: 'Shambler' | 'Runner' | 'Brute' | 'Screamer'; route: number; segment: number; progress: number; hp: number; maxHp: number; speed: number };
type MapPoint = { x: number; y: number };
type CombatEffectKind = 'rifle' | 'molotov';
type ShotEffect = { id: number; kind: CombatEffectKind; from: MapPoint; to: MapPoint };
type ImpactEffect = { id: number; kind: CombatEffectKind; point: MapPoint; lethal: boolean };

const routes: MapPoint[][] = [
  [{ x: 4, y: 50 }, { x: 28, y: 50 }, { x: 48, y: 24 }, { x: 72, y: 50 }, { x: 96, y: 50 }],
  [{ x: 4, y: 50 }, { x: 28, y: 50 }, { x: 48, y: 77 }, { x: 72, y: 50 }, { x: 96, y: 50 }],
];
const sockets: MapPoint[] = [
  { x: 20, y: 35 }, { x: 20, y: 67 }, { x: 43, y: 48 },
  { x: 55, y: 12 }, { x: 56, y: 88 }, { x: 69, y: 31 }, { x: 69, y: 70 }, { x: 84, y: 35 },
];
const towerInfo = {
  rifle: {
    name: 'Rifle nest',
    cost: 35,
    range: 20,
    sprite: withBase('/images/last-light/tower-rifle.png'),
    description: 'Fires at the zombie closest to the safehouse.',
    stats: '2 damage · Fast',
  },
  floodlight: {
    name: 'Floodlight',
    cost: 30,
    range: 18,
    sprite: withBase('/images/last-light/tower-floodlight.png'),
    description: 'Slows every zombie in its glow to 55% speed. Deals no damage.',
    stats: 'Area slow · No damage',
  },
  molotov: {
    name: 'Molotov post',
    cost: 50,
    range: 23,
    sprite: withBase('/images/last-light/tower-molotov.png'),
    description: 'Scorches up to 3 zombies with each throw.',
    stats: '2 damage · 3 targets',
  },
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
const shots = ref<ShotEffect[]>([]);
const impacts = ref<ImpactEffect[]>([]);
const breachPulse = ref(0);
const message = ref('Build around the road network before the horde reaches the safehouse.');
const decision = ref('Human controls construction');
const mapBackground = withBase('/images/last-light/battlefield-background.jpg');
let zombieId = 0;
let effectId = 0;
let timer: ReturnType<typeof setInterval> | undefined;
const effectTimers = new Set<ReturnType<typeof setTimeout>>();

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

function shotPath(shot: ShotEffect) {
  const distance = Math.hypot(shot.to.x - shot.from.x, shot.to.y - shot.from.y);
  const lift = Math.min(18, 7 + distance * .18);
  const middle = {
    x: (shot.from.x + shot.to.x) / 2,
    y: Math.min(shot.from.y, shot.to.y) - lift,
  };
  return `M ${shot.from.x} ${shot.from.y} Q ${middle.x} ${middle.y} ${shot.to.x} ${shot.to.y}`;
}

function scheduleEffect(callback: () => void, delay: number) {
  const effectTimer = setTimeout(() => {
    effectTimers.delete(effectTimer);
    callback();
  }, delay);
  effectTimers.add(effectTimer);
}

function launchShot(kind: CombatEffectKind, from: MapPoint, to: MapPoint) {
  const id = ++effectId;
  shots.value.push({ id, kind, from: { ...from }, to: { ...to } });
  scheduleEffect(() => {
    shots.value = shots.value.filter((shot) => shot.id !== id);
  }, kind === 'rifle' ? 280 : 680);
}

function launchImpact(kind: CombatEffectKind, point: MapPoint, lethal: boolean) {
  const delay = kind === 'rifle' ? 90 : 390;
  scheduleEffect(() => {
    const id = ++effectId;
    impacts.value.push({ id, kind, point: { ...point }, lethal });
    scheduleEffect(() => {
      impacts.value = impacts.value.filter((impact) => impact.id !== id);
    }, lethal ? 900 : 720);
  }, delay);
}

function clearCombatEffects() {
  for (const effectTimer of effectTimers) clearTimeout(effectTimer);
  effectTimers.clear();
  shots.value = [];
  impacts.value = [];
}

function towerFiring(socketIndex: number) {
  const socket = sockets[socketIndex];
  return shots.value.some((shot) => (
    Math.abs(shot.from.x - socket.x) < .01 && Math.abs(shot.from.y - socket.y) < .01
  ));
}

function towerAt(socketIndex: number) {
  return towers.value.find((tower) => tower.socket === socketIndex);
}

function towerAimAngle(tower: Tower) {
  if (tower.kind === 'floodlight') return 0;
  const target = nearestTargets(sockets[tower.socket], towerInfo[tower.kind].range)[0];
  if (!target) return 0;
  const from = sockets[tower.socket];
  // The source art faces left, so zero degrees keeps towers aimed at the breach.
  return Math.atan2(target.point.y - from.y, target.point.x - from.x) * 180 / Math.PI - 180;
}

function isZombieSlowed(zombie: Zombie) {
  const point = zombiePoint(zombie);
  return towers.value.some((tower) => {
    if (tower.kind !== 'floodlight') return false;
    const socket = sockets[tower.socket];
    return Math.hypot(point.x - socket.x, point.y - socket.y) <= towerInfo.floodlight.range;
  });
}

function build(socket: number, kind = selectedTower.value) {
  if (paused.value || towers.value.some((tower) => tower.socket === socket) || scrap.value < towerInfo[kind].cost || gameOver.value || victory.value) return;
  scrap.value -= towerInfo[kind].cost;
  towers.value.push({ socket, kind, cooldown: 0 });
  message.value = kind === 'floodlight'
    ? 'Floodlight online: zombies in its glow move at 55% speed.'
    : `${towerInfo[kind].name} constructed for ${towerInfo[kind].cost} scrap.`;
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
    .filter((zombie) => zombie.hp > 0)
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
      const point = { ...targets[0].point };
      target.hp -= 2;
      launchShot('rifle', socket, point);
      launchImpact('rifle', point, target.hp <= 0);
      tower.cooldown = 7;
      message.value = `Rifle nest hit a ${target.type}.`;
    } else {
      const victims = targets.slice(0, 3);
      launchShot('molotov', socket, victims[0].point);
      for (const { zombie, point } of victims) {
        zombie.hp -= 2;
        launchImpact('molotov', point, zombie.hp <= 0);
      }
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
    const slowed = isZombieSlowed(zombie);
    const screamerBoost = zombies.value.some((other) => other.type === 'Screamer' && other.id !== zombie.id && Math.hypot(zombiePoint(other).x - point.x, zombiePoint(other).y - point.y) < 12);
    zombie.progress += zombie.speed * (slowed ? .55 : 1) * (screamerBoost ? 1.25 : 1);
    if (zombie.progress >= 100) {
      zombie.segment += 1;
      zombie.progress -= 100;
      if (zombie.segment >= routes[zombie.route].length - 1) {
        safehouseHp.value -= zombie.type === 'Brute' ? 3 : 1;
        breachPulse.value += 1;
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
  clearCombatEffects();
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
  breachPulse.value = 0;
}

onMounted(() => { timer = setInterval(advance, 100); });
onUnmounted(() => {
  if (timer) clearInterval(timer);
  clearCombatEffects();
});
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
        <div class="defense-map" :style="{ backgroundImage: `url(${mapBackground})` }">
          <span class="map-atmosphere" aria-hidden="true"></span>
          <template v-for="(route, routeIndex) in routes" :key="routeIndex">
            <div v-for="(_, index) in route.slice(0, -1)" :key="`${routeIndex}-${index}`" class="road-edge" :style="lineStyle(route[index], route[index + 1])"></div>
          </template>
          <span class="safehouse">
            <i aria-hidden="true"></i><b>SAFE</b>
            <span v-if="breachPulse" :key="breachPulse" class="breach-hit" aria-hidden="true"></span>
          </span>
          <span class="breach">BREACH</span>
          <span
            v-for="tower in towers.filter((placed) => placed.kind === 'floodlight')"
            :key="`range-${tower.socket}`"
            class="tower-range floodlight-range"
            :style="{
              left: `${sockets[tower.socket].x}%`,
              top: `${sockets[tower.socket].y}%`,
              width: `${towerInfo.floodlight.range * 2}%`,
              height: `${towerInfo.floodlight.range * 2}%`,
            }"
            aria-hidden="true"
          ></span>
          <button
            v-for="(socket, index) in sockets"
            :key="index"
            class="tower-socket"
            :class="{
              built: towers.some((tower) => tower.socket === index),
              firing: towerFiring(index),
            }"
            :style="{ left: `${socket.x}%`, top: `${socket.y}%` }"
            :aria-label="towerAt(index)
              ? `${towerInfo[towerAt(index)!.kind].name} at defense socket ${index + 1}`
              : `Build ${towerInfo[selectedTower].name} at defense socket ${index + 1}`"
            @click="build(index)"
          >
            <span
              v-if="towerAt(index)"
              class="tower-sprite"
              :class="towerAt(index)!.kind"
              aria-hidden="true"
            >
              <img
                :src="towerInfo[towerAt(index)!.kind].sprite"
                alt=""
                :style="{ transform: `rotate(${towerAimAngle(towerAt(index)!)}deg)` }"
              />
            </span>
            <span v-else>+</span>
          </button>
          <span
            v-for="zombie in zombies"
            :key="zombie.id"
            class="zombie"
            :class="[zombie.type.toLowerCase(), { slowed: isZombieSlowed(zombie) }]"
            :style="zombieStyle(zombie)"
            role="img"
            :aria-label="`${zombie.type}, ${zombie.hp} of ${zombie.maxHp} health`"
          >
            <b class="zombie-sprite" aria-hidden="true"><span></span></b>
            <i class="zombie-health" aria-hidden="true"><span :style="{ width: `${(zombie.hp / zombie.maxHp) * 100}%` }"></span></i>
          </span>
          <svg class="combat-effects" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <g v-for="shot in shots" :key="shot.id" :class="`shot-${shot.kind}`">
              <template v-if="shot.kind === 'rifle'">
                <line class="rifle-trail" :x1="shot.from.x" :y1="shot.from.y" :x2="shot.to.x" :y2="shot.to.y" pathLength="1" />
                <circle class="muzzle-flash" :cx="shot.from.x" :cy="shot.from.y" r="1.2" />
                <circle class="rifle-round" :cx="shot.from.x" :cy="shot.from.y" r=".62">
                  <animate attributeName="cx" :from="shot.from.x" :to="shot.to.x" dur=".16s" fill="freeze" />
                  <animate attributeName="cy" :from="shot.from.y" :to="shot.to.y" dur=".16s" fill="freeze" />
                </circle>
              </template>
              <template v-else>
                <path class="molotov-arc" :d="shotPath(shot)" pathLength="1" />
                <circle class="molotov-round" r="1.25">
                  <animateMotion :path="shotPath(shot)" dur=".52s" fill="freeze" />
                </circle>
              </template>
            </g>
          </svg>
          <span
            v-for="impact in impacts"
            :key="impact.id"
            class="impact-sprite"
            :class="[impact.kind, { lethal: impact.lethal }]"
            :style="{ left: `${impact.point.x}%`, top: `${impact.point.y}%` }"
            aria-hidden="true"
          ><i v-for="particle in 6" :key="particle" :style="{ '--particle': particle }"></i></span>
        </div>
        <div class="game-message">{{ message }}</div>
        <div class="build-tray">
          <button
            v-for="(info, kind) in towerInfo"
            :key="kind"
            :class="{ selected: selectedTower === kind }"
            :aria-pressed="selectedTower === kind"
            :title="`${info.name}: ${info.description}`"
            @click="selectedTower = kind"
          >
            <img :src="info.sprite" alt="" aria-hidden="true" />
            <span class="build-copy">
              <span class="tower-name">{{ info.name }}</span>
              <span class="tower-cost">{{ info.cost }} scrap</span>
              <small class="tower-description">{{ info.description }}</small>
              <small class="tower-stats">{{ info.stats }}</small>
            </span>
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
.lastlight-stage{min-height:650px;background:linear-gradient(rgba(255,255,255,.015),rgba(255,255,255,0)),#111510}
.defense-hud{display:flex;justify-content:center;gap:1.4rem;margin-bottom:.8rem;color:var(--game-muted);font-size:.65rem;text-transform:uppercase}.defense-hud b{margin-left:.3rem;color:var(--game-ink)}
.defense-map{position:relative;isolation:isolate;width:min(780px,100%);height:430px;margin:auto;overflow:hidden;border:1px solid rgba(240,180,95,.2);border-radius:20px;background-color:#182019;background-position:center;background-size:cover;box-shadow:0 24px 55px rgba(0,0,0,.46),inset 0 0 55px rgba(1,5,5,.48)}
.defense-map::after{position:absolute;z-index:10;inset:0;pointer-events:none;border-radius:inherit;background:radial-gradient(ellipse at center,transparent 48%,rgba(2,5,7,.5) 100%);box-shadow:inset 0 0 0 1px rgba(255,220,158,.08);content:''}
.map-atmosphere{position:absolute;z-index:1;inset:0;pointer-events:none;background:linear-gradient(90deg,rgba(2,10,19,.28),transparent 47%,rgba(255,151,55,.07)),repeating-linear-gradient(112deg,transparent 0 13%,rgba(206,226,184,.025) 13.2% 13.4%,transparent 13.6% 26%);mix-blend-mode:screen}
.road-edge{position:absolute;z-index:2;height:18px;transform-origin:left center;border-top:1px dashed rgba(238,211,156,.43);border-bottom:2px solid rgba(28,23,20,.78);background:linear-gradient(#50483a,#302c26);box-shadow:0 5px 10px rgba(0,0,0,.3),inset 0 2px rgba(255,228,169,.06);pointer-events:none}
.tower-range{position:absolute;z-index:3;transform:translate(-50%,-50%);border-radius:50%;pointer-events:none}.floodlight-range{border:1px solid rgba(255,224,132,.38);background:radial-gradient(circle,rgba(255,231,155,.2),rgba(255,213,100,.08) 58%,transparent 72%);box-shadow:inset 0 0 22px rgba(255,229,147,.12);animation:floodlight-breathe 1.8s ease-in-out infinite}
.tower-socket{position:absolute;z-index:4;display:grid;width:46px;height:46px;place-items:center;transform:translate(-50%,-50%);border:2px dashed rgba(231,224,201,.35);border-radius:50%;color:#d4c6a4;background:rgba(21,31,25,.8);box-shadow:0 8px 13px rgba(0,0,0,.3);cursor:pointer;transition:width .2s ease,height .2s ease,border-color .2s ease,box-shadow .2s ease,filter .2s ease}.tower-socket:hover{border-color:#f2c071;box-shadow:0 0 0 5px rgba(240,180,95,.1),0 8px 13px rgba(0,0,0,.35)}.tower-socket.built{width:68px;height:68px;border-style:solid;border-color:rgba(231,180,95,.72);color:#fff2d1;background:rgba(44,38,29,.66);box-shadow:0 0 18px rgba(240,180,95,.25),0 8px 14px rgba(0,0,0,.4)}
.tower-sprite{position:relative;display:grid;width:64px;height:64px;place-items:center;border-radius:50%;filter:drop-shadow(0 5px 5px rgba(0,0,0,.65));transition:filter .18s ease}.tower-sprite img{display:block;width:100%;height:100%;object-fit:contain;transition:transform .28s ease-out}.tower-sprite.floodlight{filter:drop-shadow(0 0 8px rgba(255,225,132,.55)) drop-shadow(0 5px 5px rgba(0,0,0,.65))}.tower-sprite.molotov{filter:drop-shadow(0 0 5px rgba(255,126,47,.35)) drop-shadow(0 5px 5px rgba(0,0,0,.65))}.tower-socket.firing .tower-sprite{filter:brightness(1.32) drop-shadow(0 0 7px rgba(255,221,132,.8))}
.zombie{position:absolute;z-index:5;display:grid;width:30px;height:34px;place-items:center;transform:translate(-50%,-50%);transition:left .1s linear,top .1s linear}.zombie-sprite{position:relative;display:block;width:18px;height:22px;transform-origin:center bottom;border:1px solid rgba(218,231,177,.72);border-radius:45% 55% 43% 47%;background:linear-gradient(105deg,#91a467,#52643e);box-shadow:0 4px 7px rgba(0,0,0,.62);animation:zombie-lurch .72s ease-in-out infinite alternate}.zombie-sprite::before{position:absolute;left:50%;top:-7px;width:10px;height:10px;transform:translateX(-50%) rotate(-8deg);border:1px solid #b8c987;border-radius:50% 44% 55% 45%;background:#778b56;box-shadow:inset -3px -2px rgba(33,47,24,.28);content:''}.zombie-sprite::after{position:absolute;left:-7px;top:5px;width:31px;height:5px;transform:rotate(-12deg);border-radius:50%;background:linear-gradient(90deg,#4d5d39 0 23%,transparent 24% 76%,#4d5d39 77%);content:''}.zombie-sprite span::before,.zombie-sprite span::after{position:absolute;bottom:-6px;width:6px;height:10px;border-radius:2px;background:#3d4931;content:''}.zombie-sprite span::before{left:2px;transform:rotate(9deg)}.zombie-sprite span::after{right:2px;transform:rotate(-7deg)}
.zombie.runner .zombie-sprite{border-color:#e1d67b;background:linear-gradient(110deg,#b0aa55,#6c672c);animation-duration:.34s}.zombie.runner .zombie-sprite::after{transform:rotate(-25deg)}.zombie.brute{width:38px;height:42px}.zombie.brute .zombie-sprite{width:27px;height:29px;border-color:#baaa7c;background:linear-gradient(110deg,#76694c,#403a2d);animation-duration:.9s}.zombie.brute .zombie-sprite::before{top:-9px;width:14px;height:14px;background:#6b6045}.zombie.brute .zombie-sprite::after{left:-8px;top:8px;width:41px;height:8px}.zombie.screamer .zombie-sprite{border-color:#d4a4c6;background:linear-gradient(110deg,#90647e,#533b59);box-shadow:0 0 12px rgba(197,112,172,.38),0 4px 7px rgba(0,0,0,.62)}.zombie.screamer::before{position:absolute;inset:0;border:1px solid rgba(222,128,188,.5);border-radius:50%;content:'';animation:scream-pulse 1.1s ease-out infinite}
.zombie.slowed .zombie-sprite{animation-duration:1.25s;filter:brightness(1.28) sepia(.2);box-shadow:0 0 10px rgba(255,230,146,.7),0 4px 7px rgba(0,0,0,.62)}.zombie.slowed::after{position:absolute;inset:-3px;border:1px solid rgba(255,232,155,.62);border-radius:50%;content:'';animation:slow-pulse 1.15s ease-out infinite}
.zombie-health{position:absolute;right:0;bottom:-3px;left:0;height:4px;overflow:hidden;border:1px solid #170f0f;border-radius:2px;background:#291e1e;box-shadow:0 2px 3px rgba(0,0,0,.5)}.zombie-health span{display:block;height:100%;background:linear-gradient(90deg,#b33939,#ef7154);transition:width .16s ease}
.safehouse,.breach{position:absolute;z-index:4;top:50%;display:grid;place-items:center;transform:translate(-50%,-50%);font-size:.55rem;font-weight:900}.safehouse{left:94.5%;width:66px;height:66px;border:3px solid #f1c36d;color:#2a1708;background:linear-gradient(135deg,#c57935,#7a3e21);box-shadow:0 0 32px rgba(255,174,71,.46),inset 0 0 18px rgba(255,216,117,.32)}.safehouse::before,.safehouse::after{position:absolute;background:#3f271b;content:''}.safehouse::before{top:7px;width:40px;height:7px;box-shadow:0 43px #3f271b}.safehouse::after{left:7px;width:7px;height:40px;box-shadow:43px 0 #3f271b}.safehouse>i{position:absolute;inset:-16px;border:1px solid rgba(255,195,91,.24);border-radius:50%;animation:safehouse-glow 2.1s ease-in-out infinite}.safehouse>b{z-index:1}.breach{left:5.5%;color:#ff9681;text-shadow:0 0 12px rgba(217,70,54,.65)}
.breach-hit{position:absolute;z-index:4;width:80px;height:80px;border:4px solid #ff5e3d;border-radius:50%;animation:breach-blast .56s ease-out both}
.combat-effects{position:absolute;z-index:7;inset:0;width:100%;height:100%;overflow:visible;pointer-events:none}.combat-effects *{vector-effect:non-scaling-stroke}.rifle-trail{stroke:#ffe8a3;stroke-width:2;stroke-linecap:round;stroke-dasharray:.1 .9;filter:drop-shadow(0 0 3px #ffb445);animation:rifle-tracer .2s linear both}.rifle-round{fill:#fff7c8;filter:drop-shadow(0 0 3px #ffcb62)}.muzzle-flash{fill:#fff3a6;transform-box:fill-box;transform-origin:center;filter:drop-shadow(0 0 5px #ff8b32);animation:muzzle-pop .22s ease-out both}.molotov-arc{fill:none;stroke:rgba(255,192,92,.62);stroke-width:1.5;stroke-linecap:round;stroke-dasharray:.05 .08;animation:arc-fade .58s ease-out both}.molotov-round{fill:#ffd05c;stroke:#ff6a27;stroke-width:2;filter:drop-shadow(0 0 5px #ff6a27)}
.impact-sprite{--impact:#ffe7a0;position:absolute;z-index:8;width:10px;height:10px;transform:translate(-50%,-50%);pointer-events:none}.impact-sprite::before{position:absolute;inset:-7px;border:2px solid var(--impact);border-radius:50%;box-shadow:0 0 9px var(--impact);content:'';animation:impact-ring .48s ease-out both}.impact-sprite::after{position:absolute;inset:-3px;border-radius:50%;background:radial-gradient(circle,#fff 0 16%,var(--impact) 20% 42%,transparent 67%);filter:drop-shadow(0 0 5px var(--impact));content:'';animation:impact-core .46s ease-out both}.impact-sprite.molotov{--impact:#ff702c}.impact-sprite.molotov::before{inset:-18px;border-width:3px}.impact-sprite.molotov::after{inset:-13px;background:radial-gradient(circle,#fff5a1 0 10%,#ff9a32 25%,#bd321d 49%,transparent 70%)}.impact-sprite i{position:absolute;z-index:2;left:4px;top:3px;width:3px;height:9px;transform:rotate(calc(var(--particle) * 60deg));transform-origin:50% 2px;border-radius:2px;background:var(--impact);box-shadow:0 0 4px var(--impact);animation:impact-particle .52s cubic-bezier(.12,.7,.2,1) both}.impact-sprite.lethal::after{animation:lethal-burst .82s ease-out both}
.build-tray{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.55rem;margin-top:.8rem}.build-tray button{display:grid;grid-template-columns:56px minmax(0,1fr);gap:.55rem;min-height:118px;align-items:center;border:1px solid var(--game-line);border-radius:12px;padding:.58rem;color:var(--game-ink);background:rgba(255,255,255,.04);cursor:pointer;text-align:left;transition:border-color .18s ease,background .18s ease,transform .18s ease}.build-tray button:hover{transform:translateY(-1px);border-color:rgba(240,180,95,.5)}.build-tray button.selected{border-color:var(--game-accent);background:linear-gradient(135deg,rgba(240,180,95,.14),rgba(240,180,95,.05))}.build-tray button>img{display:block;width:56px;height:56px;object-fit:contain;filter:drop-shadow(0 4px 4px rgba(0,0,0,.55))}.build-copy{display:flex;min-width:0;flex-direction:column;gap:.14rem}.tower-name{font-size:.68rem;font-weight:760}.tower-cost{color:#f0b45f;font-size:.52rem}.tower-description{color:#c5c8bd;font-size:.5rem;line-height:1.35}.tower-stats{margin-top:.12rem;color:#eee1bd;font-size:.47rem;font-weight:700;text-transform:uppercase;letter-spacing:.035em}
@keyframes zombie-lurch{0%{transform:rotate(-7deg) translateY(1px)}100%{transform:rotate(8deg) translateY(-1px)}}@keyframes scream-pulse{0%{transform:scale(.4);opacity:.8}100%{transform:scale(1.65);opacity:0}}@keyframes slow-pulse{0%{transform:scale(.55);opacity:.8}100%{transform:scale(1.25);opacity:0}}@keyframes floodlight-breathe{50%{opacity:.55;filter:brightness(1.22)}}@keyframes safehouse-glow{50%{transform:scale(1.08);border-color:rgba(255,204,110,.48);box-shadow:0 0 18px rgba(255,168,61,.22)}}@keyframes rifle-tracer{0%{stroke-dashoffset:1;opacity:0}20%{opacity:1}100%{stroke-dashoffset:0;opacity:0}}@keyframes muzzle-pop{0%{transform:scale(.2);opacity:0}35%{transform:scale(1.9);opacity:1}100%{transform:scale(.3);opacity:0}}@keyframes arc-fade{0%,40%{opacity:.75}100%{opacity:0;stroke-dashoffset:-.5}}@keyframes impact-ring{0%{transform:scale(.2);opacity:0}35%{opacity:1}100%{transform:scale(2.4);opacity:0}}@keyframes impact-core{0%{transform:scale(.25);opacity:0}32%{transform:scale(1.35);opacity:1}100%{transform:scale(.5);opacity:0}}@keyframes impact-particle{0%{opacity:1}100%{transform:rotate(calc(var(--particle) * 60deg)) translateY(-24px) scale(.2);opacity:0}}@keyframes lethal-burst{0%{transform:scale(.2);opacity:0}28%{transform:scale(1.7);opacity:1}100%{transform:scale(3);filter:blur(5px);opacity:0}}@keyframes breach-blast{0%{transform:scale(.25);opacity:1}100%{transform:scale(1.8);border-width:0;opacity:0}}
@media(prefers-reduced-motion:reduce){.zombie-sprite,.zombie.screamer::before,.zombie.slowed::after,.floodlight-range,.safehouse>i{animation:none}.tower-sprite img{transition:none}.combat-effects,.impact-sprite,.breach-hit{display:none}}
@media(max-width:650px){.defense-map{height:360px}.safehouse{left:90%;transform:translate(-50%,-50%) scale(.82)}.breach{left:9%}.tower-socket{width:40px;height:40px}.tower-socket.built{width:56px;height:56px}.tower-sprite{width:53px;height:53px}.build-tray{grid-template-columns:1fr}.build-tray button{width:100%;min-height:92px}}
</style>
