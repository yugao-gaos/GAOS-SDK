<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue';
import { withBase } from 'vitepress';
import {
  CINDER_ACTIONS,
  CINDER_MAX_ACTIONS,
  CINDER_SIZE,
  chooseCinderVaultAction,
  createCinderVaultEnvironment,
  describeCinderVaultAction,
  type CinderCard,
  type CinderCardKind,
  type CinderCombatAnimation,
  type CinderEnemy,
  type CinderMotion,
  type CinderPlan,
  type CinderPoint,
  type CinderPreview,
  type CinderSnapshot,
  type CinderTrajectory,
  type CinderVaultView,
} from '../../../../../examples/demos/cinder-vault';
import { wait } from './game-utils';

const size = CINDER_SIZE;
const maxActions = CINDER_MAX_ACTIONS;
const seed = ref(616);
const selectedKind = ref<CinderCardKind | null>(null);
const hoveredIndex = ref<number | null>(null);
const resolving = ref(false);
const autoplay = ref(false);
const activeBeat = ref<number | null>(null);
const animationPlans = ref<CinderPlan[]>([]);
const animationFrame = ref<CinderSnapshot | null>(null);
const heroMotion = ref<CinderMotion | null>(null);
const enemyMotions = ref<Record<string, CinderMotion>>({});
const combatAnimations = ref<CinderCombatAnimation[]>([]);
const hitEnemyIds = ref(new Set<string>());
const delayedHitEnemyIds = ref(new Set<string>());
const heroHit = ref(false);
const collisionCells = ref(new Set<number>());
const messageOverride = ref<string | null>(null);
const decisionOverride = ref<string | null>(null);
const eventOverride = ref<string | null>(null);
let environment = createCinderVaultEnvironment(seed.value);
const observation = ref<CinderVaultView>(environment.reset().observation);
let runToken = 0;

const room = computed(() => observation.value.room);
const turn = computed(() => observation.value.turn);
const hero = computed(() => animationFrame.value?.hero ?? observation.value.hero);
const enemies = computed(() => animationFrame.value?.enemies ?? observation.value.enemies);
const walls = computed(() => new Set(observation.value.walls));
const spikes = computed(() => new Set(observation.value.spikes));
const pits = computed(() => new Set(observation.value.pits));
const barrels = computed(() => new Set(
  animationFrame.value?.barrels ?? observation.value.barrels,
));
const plate = computed(() => observation.value.plate);
const gate = computed(() => observation.value.gate);
const gateOpen = computed(() => (
  animationFrame.value?.gateOpen ?? observation.value.gateOpen
));
const queue = computed(() => (
  resolving.value ? animationPlans.value : observation.value.queue
));
const hand = computed(() => observation.value.hand);
const drawPile = computed(() => Array.from({ length: observation.value.drawCount }));
const discardPile = computed(() => Array.from({ length: observation.value.discardCount }));
const actionsLeft = computed(() => maxActions - queue.value.length);
const virtualHero = computed(() => observation.value.projected.hero);
const projectedEnemies = computed(() => observation.value.projected.enemies);
const phantomEnemies = computed(() => resolving.value ? [] : projectedEnemies.value.filter((enemy) => (
  enemy.x !== enemy.origin.x || enemy.y !== enemy.origin.y
)));
const won = computed(() => observation.value.won);
const defeated = computed(() => observation.value.defeated);
const roomCleared = computed(() => observation.value.roomCleared);
const message = computed(() => messageOverride.value ?? observation.value.message);
const decision = computed(() => decisionOverride.value ?? observation.value.decision);
const lastEvent = computed(() => eventOverride.value ?? observation.value.lastEvent);
const selectedCard = computed(() => (
  hand.value.find(({ kind }) => kind === selectedKind.value) ?? null
));
const selectedPlans = computed(() => observation.value.legalPlans.filter(({ card }) => (
  card.kind === selectedKind.value
)));
const targetCells = computed(() => new Set(selectedPlans.value.map(({ target }) => indexAt(target))));
const hoveredPlan = computed(() => {
  if (hoveredIndex.value === null) return null;
  return selectedPlans.value.find(({ target }) => indexAt(target) === hoveredIndex.value) ?? null;
});
const previewCells = computed(() => {
  const previews = new Map<number, CinderPreview>();
  if (resolving.value) return previews;
  for (const preview of observation.value.previews) previews.set(indexAt(preview.cell), preview);
  for (const preview of hoveredPlan.value?.preview ?? []) previews.set(indexAt(preview.cell), preview);
  return previews;
});
const trajectorySegments = computed(() => (
  resolving.value
    ? []
    : [...observation.value.trajectories, ...(hoveredPlan.value?.trajectory ?? [])]
));

function indexAt(point: CinderPoint) {
  return point.y * size + point.x;
}

function pointAt(index: number): CinderPoint {
  return { x: index % size, y: Math.floor(index / size) };
}

function enemyAt(point: CinderPoint) {
  return enemies.value.find((enemy) => enemy.x === point.x && enemy.y === point.y);
}

function phantomAt(point: CinderPoint) {
  return phantomEnemies.value.find((enemy) => enemy.x === point.x && enemy.y === point.y);
}

function previewAt(index: number) {
  return previewCells.value.get(index);
}

function segmentCoordinates(segment: CinderTrajectory) {
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

function tokenFor(enemy: CinderEnemy) {
  if (enemy.name === 'Sentinel') return withBase('/images/cinder-vault/sentinel.webp');
  if (enemy.name === 'Vault Heart') return withBase('/images/cinder-vault/vault-heart.webp');
  if (enemy.name === 'Wisp') return withBase('/images/cinder-vault/wisp.webp');
  return withBase('/images/cinder-vault/ashling.webp');
}

function isElite(enemy: CinderEnemy) {
  return enemy.name === 'Sentinel' || enemy.name === 'Vault Heart';
}

function sync(next: CinderVaultView) {
  observation.value = next;
  selectedKind.value = null;
  hoveredIndex.value = null;
}

function chooseCard(card: CinderCard) {
  if (queue.value.length >= maxActions || resolving.value || autoplay.value) return;
  selectedKind.value = selectedKind.value === card.kind ? null : card.kind;
  hoveredIndex.value = null;
  messageOverride.value = selectedKind.value ? card.text : 'Choose a card.';
}

function chooseTile(point: CinderPoint) {
  if (resolving.value || autoplay.value) return;
  const plan = selectedPlans.value.find(({ target }) => (
    target.x === point.x && target.y === point.y
  ));
  if (!plan) return;
  sync(environment.step(plan.action).observation);
  messageOverride.value = null;
  decisionOverride.value = null;
  eventOverride.value = null;
}

function removePlan(index: number) {
  if (resolving.value || autoplay.value || index < 0 || index >= observation.value.queue.length) {
    return;
  }
  sync(environment.step({ id: CINDER_ACTIONS.remove, index }).observation);
  messageOverride.value = null;
  decisionOverride.value = null;
  eventOverride.value = null;
}

function cancelSelection() {
  if (resolving.value) return;
  selectedKind.value = null;
  hoveredIndex.value = null;
  messageOverride.value = queue.value.length
    ? 'Selection cancelled. Your queued actions are unchanged.'
    : 'Choose a card.';
}

function clearPlan() {
  if (resolving.value || autoplay.value || observation.value.queue.length === 0) return;
  sync(environment.step({ id: CINDER_ACTIONS.clear }).observation);
  messageOverride.value = null;
  decisionOverride.value = null;
  eventOverride.value = null;
}

function animationCenter(point: CinderPoint) {
  return { x: point.x + 0.5, y: point.y + 0.5 };
}

function meleeSlashCoordinates(animation: CinderCombatAnimation) {
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
  const animation = combatAnimations.value.find((item) => (
    item.sourceId === sourceId && item.kind === 'melee'
  ));
  if (!animation) return {};
  return {
    '--strike-x': `${Math.sign(animation.to.x - animation.from.x) * 12}px`,
    '--strike-y': `${Math.sign(animation.to.y - animation.from.y) * 12}px`,
  };
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
  if (resolving.value || observation.value.queue.length === 0 || defeated.value
    || roomCleared.value || won.value) {
    return;
  }
  resolving.value = true;
  selectedKind.value = null;
  hoveredIndex.value = null;
  const token = runToken;
  const result = environment.step({ id: CINDER_ACTIONS.commit });
  const transition = result.observation.transition;
  if (!transition) throw new Error('Cinder Vault reducer did not publish a transition');
  observation.value = result.observation;
  animationPlans.value = transition.plans.map((plan) => ({
    card: { ...plan.card },
    target: { ...plan.target },
    summary: plan.summary,
  }));
  decisionOverride.value = `Committed ${transition.committedCount} card${transition.committedCount === 1 ? '' : 's'}${transition.committedCount < maxActions ? ` and ${maxActions - transition.committedCount} Wait` : ''}`;

  for (const beat of transition.beats) {
    if (token !== runToken) return;
    activeBeat.value = beat.beat;
    animationFrame.value = beat.before;
    heroMotion.value = beat.heroMotion;
    enemyMotions.value = { ...beat.enemyMotions };
    combatAnimations.value = beat.combatAnimations.map((animation) => ({
      ...animation,
      from: { ...animation.from },
      to: { ...animation.to },
    }));
    hitEnemyIds.value = new Set(beat.hitEnemyIds);
    delayedHitEnemyIds.value = new Set(
      beat.combatAnimations.some(({ sourceId, kind }) => sourceId === 'hero' && kind !== 'melee')
        ? beat.hitEnemyIds
        : [],
    );
    heroHit.value = beat.heroHit;
    collisionCells.value = new Set(beat.collisionCells);
    messageOverride.value = `Beat ${beat.beat + 1}: ${beat.plan.card.name} and every enemy response resolve together.`;
    await nextTick();
    animationFrame.value = beat.after;
    eventOverride.value = beat.lastEvent;
    await wait(620);
  }
  if (token !== runToken) return;
  activeBeat.value = null;
  animationFrame.value = null;
  animationPlans.value = [];
  clearAnimations();
  resolving.value = false;
  messageOverride.value = null;
  eventOverride.value = null;
  decisionOverride.value = null;
  if (defeated.value || won.value || roomCleared.value) autoplay.value = false;
  else if (autoplay.value) await agentTurn(true);
}

async function agentTurn(fromAutoplay = false) {
  if (resolving.value || defeated.value || roomCleared.value || won.value) return;
  if (observation.value.queue.length > 0) {
    sync(environment.step({ id: CINDER_ACTIONS.clear }).observation);
  }
  let programmed = 0;
  while (observation.value.queue.length < maxActions) {
    const action = chooseCinderVaultAction(observation.value);
    if (action.id === CINDER_ACTIONS.commit) break;
    decisionOverride.value = describeCinderVaultAction(observation.value, action);
    sync(environment.step(action).observation);
    programmed += 1;
  }
  decisionOverride.value = `Agent programmed ${programmed} card${programmed === 1 ? '' : 's'} from the shuffled hand`;
  await wait(350);
  if (fromAutoplay === true && !autoplay.value) return;
  await commitTurn();
}

async function toggleAutoplay() {
  autoplay.value = !autoplay.value;
  if (autoplay.value) await agentTurn(true);
}

function nextRoom() {
  if (!roomCleared.value || resolving.value) return;
  sync(environment.step({ id: CINDER_ACTIONS.nextRoom }).observation);
  messageOverride.value = null;
  decisionOverride.value = null;
  eventOverride.value = null;
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

function reset() {
  runToken += 1;
  autoplay.value = false;
  resolving.value = false;
  selectedKind.value = null;
  hoveredIndex.value = null;
  activeBeat.value = null;
  animationPlans.value = [];
  animationFrame.value = null;
  clearAnimations();
  messageOverride.value = null;
  decisionOverride.value = null;
  eventOverride.value = null;
  environment = createCinderVaultEnvironment(seed.value >>> 0);
  observation.value = environment.reset().observation;
}

onUnmounted(() => {
  runToken += 1;
});
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
          <button :disabled="resolving || autoplay || won || defeated || roomCleared" @click="agentTurn()">Agent plan</button>
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
