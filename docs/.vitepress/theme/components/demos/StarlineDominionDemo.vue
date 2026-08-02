<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { withBase } from 'vitepress';
import {
  STARLINE_ACTIONS,
  STARLINE_EDGES,
  chooseStarlineAction,
  createStarlineEnvironment,
  describeStarlineAction,
  type StarlineFleet,
  type StarlineLaunchOption,
  type StarlineView,
} from '../../../../../examples/demos/starline-dominion';

const edges = STARLINE_EDGES.map(([from, to]) => [from, to] as [string, string]);
const planetImages: Record<string, string> = {
  home: 'aster',
  mine: 'morrow',
  forge: 'forge',
  relay: 'relay',
  crown: 'crown',
  rift: 'rift',
  enemy: 'nyx',
};

const seed = ref(731);
const speed = ref(1);
const paused = ref(false);
const selected = ref<string | null>(null);
const autoplayHuman = ref(false);
const pendingAction = ref<StarlineLaunchOption['action'] | null>(null);
const decisionOverride = ref<string | null>(null);
let environment = createStarlineEnvironment(seed.value);
const observation = ref<StarlineView>(environment.reset().observation);
let timer: ReturnType<typeof setInterval> | undefined;

const planets = computed(() => observation.value.planets);
const fleets = computed(() => observation.value.fleets);
const clashes = computed(() => observation.value.clashes);
const tick = computed(() => observation.value.tick);
const winner = computed(() => observation.value.winner);
const eventLog = computed(() => observation.value.eventLog);
const decision = computed(() => decisionOverride.value ?? observation.value.decision);
const legalDestinations = computed(() => new Set(
  selected.value
    ? observation.value.legalLaunches
      .filter((option) => option.from === selected.value && option.ratio === 0.5)
      .map(({ to }) => to)
    : [],
));

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

function fleetStyle(fleet: StarlineFleet) {
  const from = planet(fleet.from);
  const to = planet(fleet.to);
  const progress = Math.min(1, fleet.progress / fleet.duration);
  return {
    left: `${from.x + (to.x - from.x) * progress}%`,
    top: `${from.y + (to.y - from.y) * progress}%`,
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
    '--orbit-radius': `${37 + Math.min(5, count) * 0.7}px`,
  };
}

function planetImage(id: string) {
  return withBase(`/images/starline-dominion/${planetImages[id]}.png`);
}

function choosePlanet(id: string) {
  if (paused.value || autoplayHuman.value || winner.value || pendingAction.value) return;
  const target = planet(id);
  if (!selected.value) {
    if (target.owner === 'human') {
      selected.value = id;
      decisionOverride.value = `${target.name} selected · ${target.strength} ships available`;
    }
    return;
  }
  if (selected.value === id) {
    selected.value = null;
    decisionOverride.value = 'Selection cleared. Choose a blue planet to issue another order.';
    return;
  }
  const option = observation.value.legalLaunches.find((candidate) => (
    candidate.from === selected.value
    && candidate.to === id
    && candidate.ratio === 0.5
  ));
  if (option) {
    const source = planet(selected.value);
    pendingAction.value = { ...option.action };
    decisionOverride.value = target.owner === 'human'
      ? `Reinforcements queued from ${source.name} to ${target.name}`
      : `${source.name} fleet queued toward ${target.name}`;
    selected.value = null;
    return;
  }
  if (target.owner === 'human') {
    selected.value = id;
    decisionOverride.value = `${target.name} selected · ${target.strength} ships available`;
  }
}

function isStillLegal(action: StarlineLaunchOption['action']) {
  return observation.value.legalLaunches.some((option) => (
    option.action.id === action.id && option.action.index === action.index
  ));
}

function advance() {
  if (paused.value || winner.value || (typeof document !== 'undefined' && document.hidden)) {
    return;
  }
  for (let step = 0; step < speed.value && !winner.value; step += 1) {
    const before = observation.value;
    let action = { id: STARLINE_ACTIONS.hold } as StarlineLaunchOption['action'];
    let agentDescription: string | null = null;
    if (pendingAction.value) {
      if (isStillLegal(pendingAction.value)) action = pendingAction.value;
      else decisionOverride.value = 'Queued order expired before the next deterministic tick.';
      pendingAction.value = null;
    } else if (autoplayHuman.value && before.tick % 18 === 9) {
      action = chooseStarlineAction(before);
      agentDescription = describeStarlineAction(before, action);
    }
    const result = environment.step(action);
    observation.value = result.observation;
    if (agentDescription) decisionOverride.value = agentDescription;
    else if (action.id === STARLINE_ACTIONS.launch) decisionOverride.value = null;
    if (observation.value.transition?.launches.some(({ fleet }) => fleet.owner === 'agent')) {
      decisionOverride.value = null;
    }
    if (result.done && !winner.value) {
      paused.value = true;
      break;
    }
  }
}

function toggleAutoplay() {
  autoplayHuman.value = !autoplayHuman.value;
  selected.value = null;
  pendingAction.value = null;
  decisionOverride.value = autoplayHuman.value
    ? 'Aster agent will issue orders on its next command interval.'
    : 'Manual command restored. Select a blue planet.';
}

function reset() {
  environment = createStarlineEnvironment(seed.value >>> 0);
  observation.value = environment.reset().observation;
  selected.value = null;
  pendingAction.value = null;
  paused.value = false;
  autoplayHuman.value = false;
  decisionOverride.value = null;
}

onMounted(() => {
  timer = setInterval(advance, 100);
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
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
          <button class="primary-action" :disabled="!!winner" @click="toggleAutoplay">{{ autoplayHuman ? 'Take command' : 'Watch both factions' }}</button>
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
