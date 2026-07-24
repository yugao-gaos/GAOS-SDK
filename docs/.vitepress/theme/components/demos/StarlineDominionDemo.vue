<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { withBase } from 'vitepress';

type Owner = 'human' | 'agent' | 'neutral';
type Planet = { id: string; name: string; x: number; y: number; owner: Owner; strength: number; production: number };
type Fleet = { id: number; owner: Exclude<Owner, 'neutral'>; from: string; to: string; strength: number; progress: number; duration: number };
type Clash = { id: number; x: number; y: number; ttl: number };

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
const planetImages: Record<string, string> = {
  home: 'aster',
  mine: 'morrow',
  forge: 'forge',
  relay: 'relay',
  crown: 'crown',
  rift: 'rift',
  enemy: 'nyx',
};

const planets = ref<Planet[]>([]);
const fleets = ref<Fleet[]>([]);
const tick = ref(0);
const speed = ref(1);
const paused = ref(false);
const selected = ref<string | null>(null);
const autoplayHuman = ref(false);
const decision = ref('Select an owned planet, then a connected destination.');
const eventLog = ref('Real-time simulation ready');
const clashes = ref<Clash[]>([]);
let fleetId = 0;
let clashId = 0;
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
  return {
    left: `${from.x + (to.x - from.x) * t}%`,
    top: `${from.y + (to.y - from.y) * t}%`,
    '--heading': `${Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI + 90}deg`,
  };
}

function fleetShipCount(strength: number) {
  return Math.min(8, Math.max(1, Math.ceil(strength / 4)));
}

function garrisonShipCount(strength: number) {
  return Math.min(12, Math.max(1, Math.ceil(strength / 4)));
}

function orbitStyle(index: number, count: number) {
  return {
    '--angle': `${index * 360 / count}deg`,
    '--orbit-radius': `${37 + Math.min(5, count) * .7}px`,
  };
}

function planetImage(id: string) {
  return withBase(`/images/starline-dominion/${planetImages[id]}.png`);
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
  if (selected.value === id) {
    selected.value = null;
    decision.value = 'Selection cleared. Choose a blue planet to issue another order.';
    return;
  }
  if (legalDestinations.value.has(id)) {
    const source = planet(selected.value);
    const reinforcing = target.owner === 'human';
    sendFleet(selected.value, id, 'human');
    decision.value = reinforcing
      ? `Reinforcements launched from ${source.name} to ${target.name}`
      : `${source.name} fleet committed toward ${target.name}`;
    selected.value = null;
    return;
  }
  if (target.owner === 'human') {
    selected.value = id;
    decision.value = `${target.name} selected · ${target.strength} ships available`;
    return;
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

function edgeProgress(fleet: Fleet) {
  const edge = edges.find(([a, b]) => connected(a, b) && (a === fleet.from || b === fleet.from) && (a === fleet.to || b === fleet.to))!;
  const progress = Math.min(1, fleet.progress / fleet.duration);
  return fleet.from === edge[0] ? progress : 1 - progress;
}

function resolveFleetBattles() {
  const removed = new Set<number>();
  const ordered = [...fleets.value].sort((a, b) => a.id - b.id);

  for (let i = 0; i < ordered.length; i += 1) {
    const a = ordered[i];
    if (removed.has(a.id)) continue;
    for (let j = i + 1; j < ordered.length; j += 1) {
      const b = ordered[j];
      if (
        removed.has(b.id)
        || a.owner === b.owner
        || a.from !== b.to
        || a.to !== b.from
      ) continue;

      const collisionWindow = 1 / a.duration + 1 / b.duration + .002;
      if (Math.abs(edgeProgress(a) - edgeProgress(b)) > collisionWindow) continue;

      const aPosition = fleetStyle(a);
      const bPosition = fleetStyle(b);
      clashes.value.push({
        id: ++clashId,
        x: (Number.parseFloat(aPosition.left) + Number.parseFloat(bPosition.left)) / 2,
        y: (Number.parseFloat(aPosition.top) + Number.parseFloat(bPosition.top)) / 2,
        ttl: 7,
      });

      const aBefore = a.strength;
      const bBefore = b.strength;
      if (a.strength === b.strength) {
        removed.add(a.id);
        removed.add(b.id);
      } else if (a.strength > b.strength) {
        a.strength -= b.strength;
        removed.add(b.id);
      } else {
        b.strength -= a.strength;
        removed.add(a.id);
      }

      const survivor = aBefore === bBefore
        ? 'Both fleets were destroyed'
        : `${aBefore > bBefore ? (a.owner === 'human' ? 'Aster' : 'Nyx') : (b.owner === 'human' ? 'Aster' : 'Nyx')} survived with ${Math.abs(aBefore - bBefore)} ships`;
      eventLog.value = `Fleet clash on the ${planet(a.from).name}–${planet(a.to).name} lane. ${survivor}.`;
      decision.value = 'Opposing fleets met in transit and resolved combat before either could arrive.';
      break;
    }
  }

  fleets.value = fleets.value.filter((fleet) => !removed.has(fleet.id));
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
    clashes.value = clashes.value.map((clash) => ({ ...clash, ttl: clash.ttl - 1 })).filter((clash) => clash.ttl > 0);
    if (tick.value % 10 === 0) {
      for (const node of planets.value) if (node.owner !== 'neutral') node.strength += node.production;
    }
    for (const fleet of fleets.value) fleet.progress += 1;
    resolveFleetBattles();
    fleets.value = fleets.value.filter((fleet) => {
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
  clashes.value = [];
  tick.value = 0;
  selected.value = null;
  paused.value = false;
  autoplayHuman.value = false;
  decision.value = 'Select an owned planet, then a connected destination.';
  eventLog.value = 'Real-time simulation ready';
  fleetId = 0;
  clashId = 0;
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
            <span class="fleet-ships" aria-hidden="true">
              <i v-for="ship in fleetShipCount(fleet.strength)" :key="ship"></i>
            </span>
            <b>{{ fleet.strength }}</b>
          </span>
          <span
            v-for="clash in clashes"
            :key="clash.id"
            class="fleet-clash"
            :style="{ left: `${clash.x}%`, top: `${clash.y}%`, '--clash-life': clash.ttl }"
            aria-hidden="true"
          ></span>
          <button
            v-for="node in planets"
            :key="node.id"
            class="planet-node"
            :class="[node.owner, { selected: selected === node.id, legal: legalDestinations.has(node.id) }]"
            :style="{ left: `${node.x}%`, top: `${node.y}%` }"
            :aria-label="`${node.name}, ${node.owner}, ${node.strength} ships, produces ${node.production}`"
            @click="choosePlanet(node.id)"
          >
            <span class="garrison-orbit" aria-hidden="true">
              <span
                v-for="ship in garrisonShipCount(node.strength)"
                :key="ship"
                class="garrison-ship"
                :style="orbitStyle(ship - 1, garrisonShipCount(node.strength))"
              ></span>
            </span>
            <img class="planet-art" :src="planetImage(node.id)" alt="" draggable="false" />
            <strong>{{ node.name }}</strong><b>{{ node.strength }}</b><small>+{{ node.production }}</small>
          </button>
          <div class="map-legend" aria-hidden="true"><span></span> Each triangle represents part of an army</div>
        </div>
        <div class="game-message" role="status" aria-live="polite">{{ eventLog }}</div>
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
    <section class="how-to-play" aria-labelledby="starline-how-to-play">
      <h3 id="starline-how-to-play">How to play</h3>
      <ol>
        <li><b>Select</b> one of your blue planets.</li>
        <li><b>Send</b> half its army to any connected planet—including another blue planet.</li>
        <li><b>Intercept</b> enemy fleets on the same lane; the stronger fleet continues with its survivors.</li>
        <li><b>Conquer</b> Nyx, the red command world. Owned planets produce ships every 10 ticks.</li>
      </ol>
      <p><span class="guide-swatch human"></span> You <span class="guide-swatch neutral"></span> Neutral <span class="guide-swatch agent"></span> Nyx</p>
    </section>
  </section>
</template>

<style scoped>
.starline-demo{--game-accent:#7ce1ff;background:radial-gradient(circle at 50% 40%,rgba(51,88,142,.32),transparent 42%),#080c18}
.star-stage{min-height:610px}
.star-map{position:relative;width:min(760px,100%);height:520px;margin:auto;overflow:hidden;border:1px solid rgba(124,225,255,.12);border-radius:22px;background:radial-gradient(circle at 25% 30%,rgba(255,255,255,.13) 0 1px,transparent 2px),radial-gradient(circle at 70% 60%,rgba(255,255,255,.12) 0 1px,transparent 2px),#090e1c;background-size:53px 47px,71px 61px}
.star-edge{position:absolute;height:2px;transform-origin:left center;background:linear-gradient(90deg,rgba(110,177,220,.12),rgba(124,225,255,.48),rgba(110,177,220,.12));pointer-events:none}
.planet-node{position:absolute;z-index:2;display:grid;width:76px;height:76px;place-items:center;transform:translate(-50%,-50%);border:0;border-radius:50%;color:white;background:transparent;cursor:pointer}
.planet-node::before{position:absolute;z-index:0;inset:5px;border:2px solid rgba(181,192,211,.6);border-radius:50%;content:"";box-shadow:0 0 18px rgba(255,255,255,.12);transition:border-color .15s ease,box-shadow .15s ease}
.planet-node.human::before{border-color:#70d8ff;box-shadow:0 0 25px rgba(90,206,255,.52)}
.planet-node.agent::before{border-color:#ff788f;box-shadow:0 0 25px rgba(255,87,116,.5)}
.planet-node.selected,.planet-node.legal{filter:drop-shadow(0 0 10px #fff)}.planet-node.legal::before{border-style:dashed}
.planet-art{position:absolute;z-index:1;width:82px;height:82px;max-width:none;object-fit:contain;pointer-events:none;user-select:none;filter:drop-shadow(0 4px 8px rgba(0,0,0,.55));transition:transform .18s ease}.planet-node:hover .planet-art,.planet-node.selected .planet-art{transform:scale(1.08)}
.planet-node strong,.planet-node b,.planet-node small{z-index:2;text-shadow:0 1px 5px #000,0 0 3px #000}.planet-node strong{position:absolute;top:72px;font-size:.62rem}.planet-node b{font-size:1rem}.planet-node small{position:absolute;right:5px;top:4px;display:grid;width:22px;height:22px;place-items:center;border-radius:50%;background:rgba(8,14,28,.9);font-size:.5rem}
.garrison-orbit{position:absolute;z-index:0;inset:0;color:#9aa6b8;pointer-events:none;animation:garrison-spin 18s linear infinite}.planet-node.human .garrison-orbit{color:#7ce1ff}.planet-node.agent .garrison-orbit{color:#ff8296}
.garrison-ship{position:absolute;left:50%;top:50%;width:0;height:0;border-right:3px solid transparent;border-bottom:7px solid currentColor;border-left:3px solid transparent;filter:drop-shadow(0 0 3px currentColor);transform:translate(-50%,-50%) rotate(var(--angle)) translateY(calc(-1 * var(--orbit-radius))) rotate(90deg)}
@keyframes garrison-spin{to{transform:rotate(360deg)}}
.fleet{position:absolute;z-index:3;display:grid;width:38px;min-height:34px;place-items:center;transform:translate(-50%,-50%);color:#79ddff;font-size:.5rem;transition:left .1s linear,top .1s linear;filter:drop-shadow(0 0 6px #52c9ff)}.fleet.agent{color:#ff8296;filter:drop-shadow(0 0 6px #ff526f)}
.fleet-ships{display:flex;width:30px;align-items:center;justify-content:center;gap:2px;flex-wrap:wrap}.fleet-ships i{display:block;width:0;height:0;border-right:3px solid transparent;border-bottom:8px solid currentColor;border-left:3px solid transparent;transform:rotate(var(--heading))}
.fleet b{position:absolute;top:20px;min-width:19px;border:1px solid currentColor;border-radius:999px;padding:1px 4px;color:#071018;background:#9ce9ff;text-align:center;line-height:1.2}.fleet.agent b{color:#240811;background:#ff9aaa}
.fleet-clash{position:absolute;z-index:4;width:12px;height:12px;transform:translate(-50%,-50%) rotate(45deg);background:#fff4bd;box-shadow:0 0 8px #fff,0 0 18px #ff8a5b,0 0 34px #ff526f;animation:clash-pop .7s ease-out forwards;pointer-events:none}.fleet-clash::before,.fleet-clash::after{position:absolute;inset:-7px 4px;content:"";background:inherit}.fleet-clash::after{transform:rotate(90deg)}
@keyframes clash-pop{0%{opacity:0;transform:translate(-50%,-50%) scale(.25) rotate(45deg)}35%{opacity:1;transform:translate(-50%,-50%) scale(1.4) rotate(45deg)}100%{opacity:0;transform:translate(-50%,-50%) scale(2) rotate(45deg)}}
.map-legend{position:absolute;right:12px;bottom:10px;display:flex;align-items:center;gap:6px;color:#8291aa;font-size:.55rem;letter-spacing:.02em}.map-legend span{width:0;height:0;border-right:3px solid transparent;border-bottom:8px solid #7ce1ff;border-left:3px solid transparent}
.how-to-play{width:calc(100% - 4rem);max-width:760px;margin:0 auto 2rem;border:1px solid var(--game-line);border-radius:18px;padding:1.35rem 1.5rem;background:rgba(124,225,255,.045)}.how-to-play h3{margin:0;color:#dff8ff;font-size:.78rem;letter-spacing:.08em;text-transform:uppercase}.how-to-play ol{margin:.8rem 0 0;padding-left:1.25rem;color:var(--game-muted);font-size:.72rem;line-height:1.5}.how-to-play li+li{margin-top:.45rem}.how-to-play li::marker{color:#7ce1ff;font-weight:800}.how-to-play b{color:var(--game-ink)}.how-to-play p{display:flex;align-items:center;gap:.35rem;margin:.9rem 0 0;color:#8795ad;font-size:.64rem}.guide-swatch{width:7px;height:7px;border-radius:50%;background:#8d98a9}.guide-swatch.human{background:#70d8ff}.guide-swatch.agent{margin-left:.2rem;background:#ff788f}
@media(max-width:650px){.star-map{height:430px}.planet-node{width:62px;height:62px}.planet-art{width:68px;height:68px}.planet-node strong{top:60px}.garrison-ship{--orbit-radius:32px!important}.map-legend{display:none}.how-to-play{width:calc(100% - 2.4rem);margin-bottom:1.2rem;padding:1.1rem 1.2rem}}
</style>
