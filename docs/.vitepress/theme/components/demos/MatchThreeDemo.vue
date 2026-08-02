<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from 'vue';
import {
  PRISM_MATCH_HEIGHT,
  PRISM_MATCH_LEVELS,
  PRISM_MATCH_WIDTH,
  createPrismMatchEnvironment,
  type PrismMatchCascade,
  type PrismMatchView,
} from '../../../../../examples/demos/prism-match';
import { wait } from './game-utils';

const width = PRISM_MATCH_WIDTH;
const height = PRISM_MATCH_HEIGHT;
const levels = PRISM_MATCH_LEVELS;

const seed = ref(2407);
const levelIndex = ref(0);
const board = ref<number[]>([]);
const score = ref(0);
const moves = ref(0);
const selected = ref<number | null>(null);
const clearing = ref(new Set<number>());
const swapMotions = ref<Record<number, { x: string; y: string }>>({});
const swapRejected = ref(false);
const falling = ref<Record<number, number>>({});
const locks = ref<Record<number, number>>({});
const voids = ref(new Set<number>());
const relicRow = ref(-1);
const relicDelivered = ref(false);
const locked = ref(false);
const agentPlaying = ref(false);
const message = ref('');
const decision = ref('Waiting for your move');
const combo = ref(0);
const boardElement = ref<HTMLElement | null>(null);
let runToken = 0;
let environment: ReturnType<typeof createPrismMatchEnvironment>;
let observation: PrismMatchView;

const level = computed(() => levels[levelIndex.value]!);
const objectiveComplete = computed(() => {
  if (level.value.relic) return relicDelivered.value;
  if (level.value.voids.length > 0) return voids.value.size === 0;
  return Object.values(locks.value).every((hp) => hp <= 0);
});
const stateLabel = computed(() => {
  if (objectiveComplete.value) return 'Chamber solved';
  if (moves.value <= 0) return 'Out of moves';
  return agentPlaying.value ? 'Agent solving' : 'Your move';
});
const objectiveProgress = computed(() => {
  if (level.value.relic) {
    return relicDelivered.value
      ? 100
      : Math.round((relicRow.value / (height - 1)) * 100);
  }
  if (level.value.voids.length > 0) {
    const total = level.value.voids.length;
    return Math.round(((total - Math.min(total, voids.value.size)) / total) * 100);
  }
  const total = level.value.locks.length * 2;
  if (total === 0) return 100;
  const left = Object.values(locks.value).reduce((sum, hp) => sum + Math.max(0, hp), 0);
  return Math.round(((total - left) / total) * 100);
});

function adjacent(a: number, b: number) {
  const aRow = Math.floor(a / width);
  const bRow = Math.floor(b / width);
  return Math.abs(aRow - bRow) + Math.abs((a % width) - (b % width)) === 1;
}

function row(index: number) {
  return Math.floor(index / width);
}

function gridStep(direction: number) {
  if (direction === 0) return '0px';
  return direction > 0
    ? 'calc(100% + var(--match-gap))'
    : 'calc(-100% - var(--match-gap))';
}

function fallOffset(rows: number) {
  if (rows <= 0) return '0px';
  return `calc(-${rows * 100}% ${' - var(--match-gap)'.repeat(rows)})`;
}

function startSwapMotion(a: number, b: number, rejected: boolean) {
  swapRejected.value = rejected;
  swapMotions.value = {
    [a]: { x: gridStep((b % width) - (a % width)), y: gridStep(row(b) - row(a)) },
    [b]: { x: gridStep((a % width) - (b % width)), y: gridStep(row(a) - row(b)) },
  };
}

function motionStyle(index: number) {
  const swap = swapMotions.value[index];
  const fallRows = falling.value[index] ?? 0;
  return {
    '--swap-x': swap?.x ?? '0px',
    '--swap-y': swap?.y ?? '0px',
    '--fall-offset': fallOffset(fallRows),
    '--fall-duration': `${Math.min(520, 250 + fallRows * 52)}ms`,
  };
}

function nextPaint() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForBoardMotion() {
  await nextTick();
  await nextPaint();
  const animations = boardElement.value?.getAnimations({ subtree: true }) ?? [];
  await Promise.allSettled(animations.map((animation) => animation.finished));
}

function legalSwaps() {
  return observation?.legalSwaps ?? [];
}

function syncObservation(next: PrismMatchView) {
  observation = next;
  board.value = [...next.board];
  score.value = next.score;
  moves.value = next.moves;
  locks.value = { ...next.locks };
  voids.value = new Set(next.voids);
  relicRow.value = next.relicRow;
  relicDelivered.value = next.relicDelivered;
}

function applyCascadeFrame(frame: PrismMatchCascade) {
  board.value = [...frame.boardBefore];
  clearing.value = new Set(frame.matched);
  score.value = frame.score;
  locks.value = { ...frame.locks };
  voids.value = new Set(frame.voids);
  relicRow.value = frame.relicRow;
  relicDelivered.value = frame.relicDelivered;
  combo.value = frame.combo;
  message.value = frame.combo > 1
    ? `Cascade ×${frame.combo} · puzzle state updated`
    : `Match · +${frame.gained}`;
}

async function playSwap(a: number, b: number, actor: 'human' | 'agent') {
  if (locked.value || moves.value <= 0 || objectiveComplete.value) return;
  locked.value = true;
  selected.value = null;
  const token = runToken;
  const option = legalSwaps().find((swap) => (
    (swap.a === a && swap.b === b) || (swap.a === b && swap.b === a)
  ));
  const valid = option !== undefined;
  startSwapMotion(a, b, !valid);
  await waitForBoardMotion();
  if (token !== runToken) return;
  if (!valid) {
    swapMotions.value = {};
    swapRejected.value = false;
    message.value = 'That swap makes no match.';
    if (actor === 'human') decision.value = 'Illegal action rejected';
    locked.value = false;
    return;
  }
  const result = environment.step(option.action);
  const transition = result.observation.transition;
  if (!transition) throw new Error('Prism Match reducer did not publish a transition');
  swapMotions.value = {};
  swapRejected.value = false;
  moves.value = result.observation.moves;
  combo.value = 0;
  for (const frame of transition.cascades) {
    applyCascadeFrame(frame);
    await waitForBoardMotion();
    if (token !== runToken) return;
    clearing.value = new Set();
    board.value = [...frame.boardAfter];
    falling.value = { ...frame.fallDistances };
    await waitForBoardMotion();
    if (token !== runToken) return;
    falling.value = {};
    await nextTick();
  }
  syncObservation(result.observation);
  message.value = result.observation.objectiveComplete
    ? `${level.value.name} solved!`
    : result.observation.moves <= 0
      ? 'The chamber seals. Restart the level.'
      : transition.reshuffled
        ? 'No legal swaps remained, so the chamber reshuffled deterministically.'
        : level.value.subtitle;
  locked.value = false;
}

function chooseCell(index: number) {
  if (locked.value || agentPlaying.value || (locks.value[index] ?? 0) > 0) return;
  if (selected.value === null || !adjacent(selected.value, index)) {
    selected.value = selected.value === index ? null : index;
    message.value = selected.value === null ? level.value.subtitle : 'Choose an adjacent unlocked gem.';
    return;
  }
  void playSwap(selected.value, index, 'human');
}

async function agentStep() {
  if (locked.value || moves.value <= 0 || objectiveComplete.value) return;
  const options = legalSwaps();
  if (!options.length) {
    return;
  }
  const best = options[0];
  selected.value = best.a;
  decision.value = `${options.length} legal swaps · selected objective value ${best.value}`;
  await wait(260);
  await playSwap(best.a, best.b, 'agent');
}

async function toggleAgent() {
  agentPlaying.value = !agentPlaying.value;
  const token = runToken;
  while (agentPlaying.value && token === runToken && moves.value > 0 && !objectiveComplete.value) {
    await agentStep();
    await wait(360);
  }
  if (token === runToken) agentPlaying.value = false;
}

function reset() {
  runToken += 1;
  agentPlaying.value = false;
  environment = createPrismMatchEnvironment(
    level.value,
    (seed.value + levelIndex.value * 997) >>> 0,
  );
  syncObservation(environment.reset().observation);
  selected.value = null;
  clearing.value = new Set();
  swapMotions.value = {};
  swapRejected.value = false;
  falling.value = {};
  combo.value = 0;
  locked.value = false;
  message.value = level.value.subtitle;
  decision.value = 'Waiting for your move';
}

function takeControl() {
  agentPlaying.value = false;
  selected.value = null;
  decision.value = 'Human control';
  message.value = locked.value ? 'Finishing the current move, then control returns to you.' : 'Select a gem to begin.';
}

function nextLevel() {
  levelIndex.value = (levelIndex.value + 1) % levels.length;
  reset();
}

onUnmounted(() => { runToken += 1; });
reset();
</script>

<template>
  <section class="game-demo game-demo--match">
    <header class="game-hero">
      <div>
        <span class="game-eyebrow">Puzzle chamber {{ levelIndex + 1 }} of {{ levels.length }} · seed {{ seed }}</span>
        <h2>Prism Match</h2>
        <p>{{ level.name }} — {{ level.subtitle }}</p>
      </div>
      <div class="game-status-pill" :data-active="agentPlaying">{{ stateLabel }}</div>
    </header>

    <div class="game-layout">
      <div class="game-stage">
        <div class="match-hud">
          <div><span>Objective</span><strong>{{ objectiveProgress }}%</strong></div>
          <div><span>Moves</span><strong>{{ moves }}</strong></div>
          <div><span>Score</span><strong>{{ score.toLocaleString() }}</strong></div>
        </div>
        <div class="goal-track"><div :style="{ width: `${objectiveProgress}%` }"></div></div>
        <div ref="boardElement" class="match-board" :aria-busy="locked">
          <button
            v-for="(gem, index) in board"
            :key="index"
            class="gem-cell"
            :class="[
              `gem-${gem}`,
              {
                selected: selected === index,
                clearing: clearing.has(index),
                swapping: Boolean(swapMotions[index]),
                'swap-rejected': Boolean(swapMotions[index]) && swapRejected,
                falling: Boolean(falling[index]),
                'puzzle-locked': (locks[index] ?? 0) > 0,
                corrupted: voids.has(index),
                'relic-cell': level.relic && relicRow * width + level.relic.column === index && !relicDelivered,
                'exit-cell': level.relic && (height - 1) * width + level.relic.column === index,
              },
            ]"
            :style="motionStyle(index)"
            :disabled="locked || agentPlaying || moves <= 0 || objectiveComplete || (locks[index] ?? 0) > 0"
            @click="chooseCell(index)"
          >
            <span class="gem-piece"><span class="gem-shape"></span></span>
            <span v-if="(locks[index] ?? 0) > 0" class="puzzle-overlay lock-mark">{{ locks[index] }}</span>
            <span v-if="voids.has(index)" class="puzzle-overlay void-mark">VOID</span>
            <span v-if="level.relic && relicRow * width + level.relic.column === index && !relicDelivered" class="puzzle-overlay relic-mark">KEY</span>
            <span v-if="level.relic && (height - 1) * width + level.relic.column === index" class="puzzle-overlay exit-mark">EXIT</span>
          </button>
        </div>

        <div class="human-play-panel">
          <div class="human-play-head">
            <div><span>Human play</span><strong>{{ agentPlaying ? 'Agent currently has the board' : 'You control the board' }}</strong></div>
            <button class="human-control-button" :class="{ active: !agentPlaying }" :disabled="!agentPlaying" @click="takeControl">
              {{ agentPlaying ? 'Take control' : 'Human control active' }}
            </button>
          </div>
          <ol class="human-play-steps">
            <li><b>1</b><span>Swap adjacent unlocked gems.</span></li>
            <li><b>2</b><span>Match beside locks, void, or below the key.</span></li>
            <li><b>3</b><span>Solve the objective before moves expire.</span></li>
          </ol>
          <section class="special-token-guide" aria-labelledby="special-token-title">
            <h3 id="special-token-title">Special tokens</h3>
            <ul>
              <li>
                <span class="token-swatch token-lock">Lock <b>2</b></span>
                <p>Cannot be swapped. A match on or beside it removes one lock layer.</p>
              </li>
              <li>
                <span class="token-swatch token-void">Void</span>
                <p>Spreads after every valid move. A match on or beside it clears that cell.</p>
              </li>
              <li>
                <span class="token-swatch token-key">Key</span>
                <p>Make a match below it in the same column to move it down one row.</p>
              </li>
              <li>
                <span class="token-swatch token-exit">Exit</span>
                <p>Guide the Key onto this destination to complete the relic chamber.</p>
              </li>
            </ul>
          </section>
          <div class="game-message" role="status">{{ message }}</div>
        </div>
      </div>

      <aside class="agent-console">
        <div class="agent-console__head">
          <span class="agent-orb" :class="{ thinking: agentPlaying || locked }"></span>
          <div><strong>Puzzle search agent</strong><small>Matches · blockers · relic route · void</small></div>
        </div>
        <div class="agent-decision"><span>Latest decision</span><p>{{ decision }}</p></div>
        <div class="agent-metrics">
          <div><span>Legal</span><strong>{{ legalSwaps().length }}</strong></div>
          <div><span>Combo</span><strong>×{{ Math.max(1, combo) }}</strong></div>
          <div><span>Objective</span><strong>{{ objectiveProgress }}%</strong></div>
        </div>
        <div class="game-actions">
          <button v-if="objectiveComplete" class="primary-action" @click="nextLevel">Next chamber</button>
          <button v-else class="primary-action" :disabled="locked || moves <= 0" @click="toggleAgent">{{ agentPlaying ? 'Pause agent' : 'Watch agent' }}</button>
          <button :disabled="locked || agentPlaying || moves <= 0 || objectiveComplete" @click="agentStep">Step once</button>
          <button @click="reset">Restart chamber</button>
        </div>
        <label class="seed-control"><span>Seed</span><input v-model.number="seed" type="number" min="1" @change="reset"></label>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.puzzle-overlay { position:absolute; z-index:3; display:grid; place-items:center; pointer-events:none; font-size:.48rem; font-weight:900; letter-spacing:.06em; }
.lock-mark { inset:5px; border:2px solid rgba(190,235,255,.78); border-radius:12px; color:#dff8ff; background:rgba(73,142,172,.32); }
.void-mark { right:3px; bottom:2px; color:#e0a8ff; text-shadow:0 0 8px #7d2bac; }
.relic-mark { inset:18%; transform:rotate(-8deg); border:2px solid #ffe19a; border-radius:50% 50% 15% 50%; color:#2a1a0b; background:#f3b94f; box-shadow:0 0 14px #ffc65a; }
.exit-mark { right:4px; top:3px; color:#8cf1d4; }
.corrupted { box-shadow:inset 0 0 0 3px rgba(156,65,196,.6), inset 0 0 22px rgba(105,24,130,.8); }
.puzzle-locked .gem-shape { opacity:.45; filter:grayscale(.3); }
.exit-cell { background:rgba(73,193,158,.12); }
.special-token-guide { margin-top:.9rem; border-top:1px solid var(--game-line); padding-top:.8rem; }
.special-token-guide h3 { margin:0 0 .65rem; color:var(--game-muted); font-size:.62rem; font-weight:850; letter-spacing:.1em; text-transform:uppercase; }
.special-token-guide ul { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:.55rem; margin:0; padding:0; list-style:none; }
.special-token-guide li { display:grid; grid-template-columns:58px 1fr; align-items:start; gap:.55rem; border:1px solid var(--game-line); border-radius:10px; padding:.6rem; background:rgba(255,255,255,.025); }
.special-token-guide p { margin:0; color:var(--game-muted); font-size:.63rem; line-height:1.45; }
.token-swatch { display:grid; min-height:34px; place-items:center; border-radius:8px; color:white; font-size:.52rem; font-weight:900; letter-spacing:.05em; text-transform:uppercase; }
.token-swatch b { margin-left:.2rem; font-size:.6rem; }
.token-lock { border:2px solid rgba(190,235,255,.78); background:rgba(73,142,172,.5); }
.token-void { color:#e0a8ff; background:radial-gradient(circle,#7d2bac,#21112d 70%); }
.token-key { color:#2a1a0b; background:#f3b94f; box-shadow:0 0 10px rgba(255,198,90,.35); }
.token-exit { border:1px solid rgba(140,241,212,.5); color:#8cf1d4; background:rgba(73,193,158,.12); }
@media(max-width:560px){.special-token-guide ul{grid-template-columns:1fr}}
</style>
