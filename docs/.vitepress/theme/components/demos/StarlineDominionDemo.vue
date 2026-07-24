<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';

type Owner = 'human' | 'agent' | 'neutral';
type Planet = { id: string; name: string; x: number; y: number; owner: Owner; strength: number; production: number };
type Fleet = { id: number; owner: Exclude<Owner, 'neutral'>; from: string; to: string; strength: number; progress: number; duration: number };

const edges: Array<[string, string]> = [
  ['home', 'mine'], ['home', 'forge'], ['mine', 'relay'], ['forge', 'relay'],
  ['relay', 'crown'], ['relay', 'rift'], ['crown', 'enemy'], ['rift', 'enemy'],
  ['mine', 'crown'], ['forge', 'rift'],
];
const initialPlanets: Planet[] = [
  { id: 'home', name: 'Aster', x: 10, y: 50, owner: 'human', strength: 34, production: 3 },
  { id: 'mine', name: 'Morrow', x: 29, y: 20, owner: 'neutral', strength: 10, production: 2 },
  { id: 'forge', name: 'Forge', x: 29, y: 78, owner: 'neutral', strength: 12, production: 3 },
  { id: 'relay', name: 'Relay', x: 50, y: 50, owner: 'neutral', strength: 15, production: 4 },
  { id: 'crown', name: 'Crown', x: 69, y: 20, owner: 'neutral', strength: 11, production: 3 },
  { id: 'rift', name: 'Rift', x: 69, y: 78, owner: 'neutral', strength: 9, production: 2 },
  { id: 'enemy', name: 'Nyx', x: 90, y: 50, owner: 'agent', strength: 34, production: 3 },
];

const planets = ref<Planet[]>([]);
const fleets = ref<Fleet[]>([]);
const tick = ref(0);
const speed = ref(1);
const paused = ref(false);
const selected = ref<string | null>(null);
const autoplayHuman = ref(false);
const decision = ref('Select an owned planet, then a connected destination.');
const eventLog = ref('Real-time simulation ready');
let fleetId = 0;
let timer: ReturnType<typeof setInterval> | undefined;

const winner = computed<Owner | null>(() => {
  const owners = new Set(planets.value.filter((planet) => planet.owner !== 'neutral').map((planet) => planet.owner));
  if (!owners.has('human')) return 'agent';
  if (!owners.has('agent')) return 'human';
  return null;
});
const selectedPlanet = computed(() => planets.value.find((planet) => planet.id === selected.value) ?? null);
const legalDestinations = computed(() => new Set(selected.value
  ? edges.filter(([a, b]) => a === selected.value || b === selected.value).map(([a, b]) => a === selected.value ? b : a)
  : []));

function planet(id: string) {
  return planets.value.find((item) => item.id === id)!;
}

function edgeStyle([fromId, toId]: [string, string]) {
  const from = planet(fromId);
  const to = planet(toId);
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return {
    left: `${from.x}%`,
    top: `${from.y}%`,
    width: `${Math.sqrt(dx * dx + dy * dy)}%`,
    transform: `rotate(${Math.atan2(dy, dx) * 180 / Math.PI}deg)`,
  };
}

function fleetStyle(fleet: Fleet) {
  const from = planet(fleet.from);
  const to = planet(fleet.to);
  const t = Math.min(1, fleet.progress / fleet.duration);
  return { left: `${from.x + (to.x - from.x) * t}%`, top: `${from.y + (to.y - from.y) * t}%` };
}

function connected(a: string, b: string) {
  return edges.some(([from, to]) => (from === a && to === b) || (from === b && to === a));
}

function sendFleet(fromId: string, toId: string, owner: Exclude<Owner, 'neutral'>, ratio = .5) {
  const from = planet(fromId);
  if (from.owner !== owner || !connected(fromId, toId) || from.strength < 4) return;
  const strength = Math.max(1, Math.floor(from.strength * ratio));
  from.strength -= strength;
  const to = planet(toId);
  const distance = Math.hypot(to.x - from.x, to.y - from.y);
  fleets.value.push({ id: ++fleetId, owner, from: fromId, to: toId, strength, progress: 0, duration: Math.max(18, Math.round(distance * .75)) });
  eventLog.value = `${owner === 'human' ? 'Aster' : 'Nyx'} launched ${strength} ships from ${from.name} to ${to.name}.`;
}

function choosePlanet(id: string) {
  if (paused.value || autoplayHuman.value || winner.value) return;
  const target = planet(id);
  if (!selected.value) {
    if (target.owner === 'human') {
      selected.value = id;
      decision.value = `${target.name} selected · ${target.strength} ships available`;
    }
    return;
  }
  if (target.owner === 'human') {
    selected.value = id;
    return;
  }
  if (legalDestinations.value.has(id)) {
    sendFleet(selected.value, id, 'human');
    selected.value = null;
  }
}

function resolveArrival(fleet: Fleet) {
  const target = planet(fleet.to);
  if (target.owner === fleet.owner) target.strength += fleet.strength;
  else if (fleet.strength > target.strength) {
    const remaining = fleet.strength - target.strength;
    target.owner = fleet.owner;
    target.strength = remaining;
    eventLog.value = `${target.name} was captured by ${fleet.owner === 'human' ? 'Aster' : 'Nyx'}.`;
  } else {
    target.strength -= fleet.strength;
    if (target.strength === 0) target.owner = 'neutral';
  }
}

function agentOrder(owner: Exclude<Owner, 'neutral'>) {
  const owned = planets.value.filter((item) => item.owner === owner && item.strength >= 9)
    .sort((a, b) => b.strength - a.strength || a.id.localeCompare(b.id));
  for (const source of owned) {
    const targets = planets.value
      .filter((target) => connected(source.id, target.id) && target.owner !== owner)
      .sort((a, b) => a.strength - b.strength || b.production - a.production);
    if (targets[0]) {
      sendFleet(source.id, targets[0].id, owner, targets[0].strength < source.strength / 2 ? .55 : .4);
      decision.value = `${owner === 'human' ? 'Aster agent' : 'Nyx agent'} sends from ${source.name} toward ${targets[0].name}`;
      break;
    }
  }
}

function advance() {
  if (paused.value || winner.value || (typeof document !== 'undefined' && document.hidden)) return;
  for (let step = 0; step < speed.value; step += 1) {
    tick.value += 1;
    if (tick.value % 10 === 0) {
      for (const node of planets.value) if (node.owner !== 'neutral') node.strength += node.production;
    }
    fleets.value = fleets.value.filter((fleet) => {
      fleet.progress += 1;
      if (fleet.progress < fleet.duration) return true;
      resolveArrival(fleet);
      return false;
    });
    if (tick.value % 18 === 0) agentOrder('agent');
    if (autoplayHuman.value && tick.value % 18 === 9) agentOrder('human');
  }
}

function reset() {
  planets.value = initialPlanets.map((item) => ({ ...item }));
  fleets.value = [];
  tick.value = 0;
  selected.value = null;
  paused.value = false;
  autoplayHuman.value = false;
  decision.value = 'Select an owned planet, then a connected destination.';
  eventLog.value = 'Real-time simulation ready';
  fleetId = 0;
}

onMounted(() => { timer = setInterval(advance, 100); });
onUnmounted(() => { if (timer) clearInterval(timer); });
reset();
</script>

<template>
  <section class="game-demo starline-demo">
    <header class="game-hero">
      <div>
        <span class="game-eyebrow">Real-time graph RTS · fixed deterministic ticks</span>
        <h2>Starline Dominion</h2>
        <p>Produce fleets, traverse hyperlanes, and capture the opposing command world without ever stepping onto a grid.</p>
      </div>
      <div class="game-status-pill" :data-active="!paused">{{ winner ? `${winner} victory` : `Tick ${tick}` }}</div>
    </header>
    <div class="game-layout">
      <div class="game-stage star-stage">
        <div class="star-map">
          <div v-for="edge in edges" :key="edge.join('-')" class="star-edge" :style="edgeStyle(edge)"></div>
          <span v-for="fleet in fleets" :key="fleet.id" class="fleet" :class="fleet.owner" :style="fleetStyle(fleet)">
            <b>{{ fleet.strength }}</b>
          </span>
          <button
            v-for="node in planets"
            :key="node.id"
            class="planet-node"
            :class="[node.owner, { selected: selected === node.id, legal: legalDestinations.has(node.id) }]"
            :style="{ left: `${node.x}%`, top: `${node.y}%` }"
            @click="choosePlanet(node.id)"
          >
            <i></i><strong>{{ node.name }}</strong><b>{{ node.strength }}</b><small>+{{ node.production }}</small>
          </button>
        </div>
        <div class="game-message">{{ eventLog }}</div>
      </div>
      <aside class="agent-console">
        <div class="agent-console__head"><span class="agent-orb" :class="{ thinking: !paused }"></span><div><strong>Graph commander</strong><small>Production · travel time · capture pressure</small></div></div>
        <div class="agent-decision"><span>Latest decision</span><p>{{ decision }}</p></div>
        <div class="agent-metrics"><div><span>Tick</span><strong>{{ tick }}</strong></div><div><span>Fleets</span><strong>{{ fleets.length }}</strong></div><div><span>Speed</span><strong>×{{ speed }}</strong></div></div>
        <div class="game-actions">
          <button class="primary-action" :disabled="!!winner" @click="autoplayHuman = !autoplayHuman">{{ autoplayHuman ? 'Take command' : 'Watch both factions' }}</button>
          <button @click="paused = !paused">{{ paused ? 'Resume' : 'Pause' }}</button>
          <button @click="speed = speed === 1 ? 2 : 1">Simulation ×{{ speed === 1 ? 2 : 1 }}</button>
          <button @click="reset">Restart war</button>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.starline-demo{--game-accent:#7ce1ff;background:radial-gradient(circle at 50% 40%,rgba(51,88,142,.32),transparent 42%),#080c18}
.star-stage{min-height:610px}
.star-map{position:relative;width:min(760px,100%);height:520px;margin:auto;overflow:hidden;border:1px solid rgba(124,225,255,.12);border-radius:22px;background:radial-gradient(circle at 25% 30%,rgba(255,255,255,.13) 0 1px,transparent 2px),radial-gradient(circle at 70% 60%,rgba(255,255,255,.12) 0 1px,transparent 2px),#090e1c;background-size:53px 47px,71px 61px}
.star-edge{position:absolute;height:2px;transform-origin:left center;background:linear-gradient(90deg,rgba(110,177,220,.12),rgba(124,225,255,.48),rgba(110,177,220,.12));pointer-events:none}
.planet-node{position:absolute;z-index:2;display:grid;width:76px;height:76px;place-items:center;transform:translate(-50%,-50%);border:0;border-radius:50%;color:white;background:transparent;cursor:pointer}
.planet-node i{position:absolute;inset:7px;border:2px solid #777;border-radius:50%;background:radial-gradient(circle at 32% 28%,#aaa,#3d4654 68%);box-shadow:0 0 18px rgba(255,255,255,.12)}
.planet-node.human i{border-color:#70d8ff;background:radial-gradient(circle at 32% 28%,#a5efff,#176f9e 68%);box-shadow:0 0 24px rgba(90,206,255,.38)}
.planet-node.agent i{border-color:#ff788f;background:radial-gradient(circle at 32% 28%,#ffb0b7,#9b2745 68%);box-shadow:0 0 24px rgba(255,87,116,.34)}
.planet-node.selected,.planet-node.legal{filter:drop-shadow(0 0 10px #fff)}.planet-node.legal i{border-style:dashed}
.planet-node strong,.planet-node b,.planet-node small{z-index:1}.planet-node strong{position:absolute;top:72px;font-size:.62rem}.planet-node b{font-size:1rem}.planet-node small{position:absolute;right:5px;top:4px;display:grid;width:22px;height:22px;place-items:center;border-radius:50%;background:#172133;font-size:.5rem}
.fleet{position:absolute;z-index:3;display:grid;width:22px;height:22px;place-items:center;transform:translate(-50%,-50%);border-radius:50%;color:#071018;background:#79ddff;box-shadow:0 0 14px #52c9ff;font-size:.52rem;transition:left .1s linear,top .1s linear}.fleet.agent{color:#240811;background:#ff8296;box-shadow:0 0 14px #ff526f}
@media(max-width:650px){.star-map{height:430px}.planet-node{width:62px;height:62px}.planet-node strong{top:60px}}
</style>
