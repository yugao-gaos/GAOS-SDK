<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import type { SubmittedAction } from '../../../../../src/engine/index';
import {
  MIDNIGHT_HOUSE_ACTIONS,
  chooseMidnightHouseAction,
  createMidnightHouseEnvironment,
  describeMidnightHouseAction,
  type MidnightHouseCard,
  type MidnightHouseFavorCard,
  type MidnightHouseFavorKind,
  type MidnightHouseFrame,
  type MidnightHousePhase,
  type MidnightHouseView,
} from '../../../../../examples/demos/midnight-house';
import { wait } from './game-utils';

const seed = ref(1701);
const bet = ref(25);
const chips = ref(250);
const wager = ref(25);
const player = ref<MidnightHouseCard[]>([]);
const dealer = ref<(MidnightHouseCard | null)[]>([]);
const phase = ref<MidnightHousePhase>('settled');
const revealDealer = ref(false);
const message = ref('Place your bet.');
const decision = ref('Waiting for the deal');
const agentPlaying = ref(false);
const animating = ref(false);
const wins = ref(0);
const favor = ref(3);
const favorHand = ref<MidnightHouseFavorCard[]>([]);
const favorUsed = ref(false);
const glassAceIndex = ref<number | null>(null);
const targetingAce = ref(false);
const twistChoices = ref<MidnightHouseCard[]>([]);
const playerValue = ref(0);
const dealerValue = ref<number | null>(null);
const legalActionCount = ref(0);
let environment: ReturnType<typeof createMidnightHouseEnvironment>;
let observation: MidnightHouseView;
let legalActionList: SubmittedAction[] = [];
let runToken = 0;

const canAct = computed(() => (
  phase.value === 'player'
  && !agentPlaying.value
  && !animating.value
  && twistChoices.value.length === 0
  && !targetingAce.value
));
const favorPips = computed(() => Array.from(
  { length: 5 },
  (_value, index) => index < favor.value,
));

const FAVOR_ACTIONS: Record<MidnightHouseFavorKind, string> = {
  peek: MIDNIGHT_HOUSE_ACTIONS.peek,
  cut: MIDNIGHT_HOUSE_ACTIONS.cut,
  twist: MIDNIGHT_HOUSE_ACTIONS.twist,
  ace: MIDNIGHT_HOUSE_ACTIONS.ace,
  breath: MIDNIGHT_HOUSE_ACTIONS.breath,
  crown: MIDNIGHT_HOUSE_ACTIONS.crown,
};

function syncPresentation(next: MidnightHouseView | MidnightHouseFrame) {
  chips.value = next.resources.chips ?? 0;
  favor.value = next.resources.favor ?? 0;
  wager.value = next.wager;
  player.value = next.player.map((card) => ({ ...card }));
  dealer.value = next.dealer.map((card) => card ? { ...card } : null);
  phase.value = next.phase;
  revealDealer.value = next.revealDealer;
  message.value = next.message;
  wins.value = next.wins;
  favorHand.value = next.favorHand.map((card) => ({ ...card }));
  favorUsed.value = next.favorUsed;
  glassAceIndex.value = next.glassAceIndex;
  targetingAce.value = next.targetingAce;
  twistChoices.value = next.twistChoices.map((card) => ({ ...card }));
  playerValue.value = next.playerValue;
  dealerValue.value = next.dealerValue;
}

function syncObservation(next: MidnightHouseView, actions: SubmittedAction[]) {
  observation = next;
  legalActionList = actions.map((action) => ({ ...action }));
  legalActionCount.value = legalActionList.length;
  syncPresentation(next);
}

async function performAction(action: SubmittedAction, actor: 'human' | 'agent') {
  if (animating.value || (actor === 'human' && agentPlaying.value)) return;
  animating.value = true;
  const token = runToken;
  try {
    const result = environment.step(action);
    for (const frame of result.observation.transition?.frames ?? []) {
      syncPresentation(frame);
      await wait(frame.phase === 'dealer' ? 420 : 260);
      if (token !== runToken) return;
    }
    syncObservation(result.observation, result.legalActions);
  } finally {
    if (token === runToken) animating.value = false;
  }
}

function legalActions() {
  return legalActionList;
}

function startRound() {
  if (phase.value !== 'settled' || chips.value < bet.value) return;
  void performAction({ id: MIDNIGHT_HOUSE_ACTIONS.deal }, 'human');
}

function hit() {
  void performAction({ id: MIDNIGHT_HOUSE_ACTIONS.hit }, 'human');
}

function stand() {
  void performAction({ id: MIDNIGHT_HOUSE_ACTIONS.stand }, 'human');
}

function doubleDown() {
  void performAction({ id: MIDNIGHT_HOUSE_ACTIONS.double }, 'human');
}

function playFavor(card: MidnightHouseFavorCard) {
  decision.value = `Player played ${card.name} for ${card.cost} Favor`;
  void performAction({ id: FAVOR_ACTIONS[card.kind] }, 'human');
}

function chooseTwistCard(index: number) {
  void performAction({
    id: MIDNIGHT_HOUSE_ACTIONS.chooseTwist,
    index,
  }, 'human');
}

function chooseGlassAce(index: number) {
  void performAction({
    id: MIDNIGHT_HOUSE_ACTIONS.chooseAce,
    index,
  }, 'human');
}

async function agentStep() {
  if (phase.value !== 'player' || animating.value) return;
  const action = chooseMidnightHouseAction(observation);
  decision.value = describeMidnightHouseAction(observation, action);
  await wait(350);
  await performAction(action, 'agent');
}

async function watchAgent() {
  if (phase.value !== 'player' || animating.value) return;
  agentPlaying.value = true;
  const token = runToken;
  while (agentPlaying.value && phase.value === 'player' && token === runToken) {
    await agentStep();
    await wait(420);
  }
  if (token === runToken) agentPlaying.value = false;
}

function resetTable() {
  runToken += 1;
  agentPlaying.value = false;
  animating.value = false;
  environment = createMidnightHouseEnvironment(seed.value >>> 0, { bet: bet.value });
  const initial = environment.reset();
  syncObservation(initial.observation, initial.legalActions);
  decision.value = `${legalActionCount.value} SDK-enumerated actions · waiting for your move`;
}

onUnmounted(() => { runToken += 1; });
resetTable();
</script>

<template>
  <section class="game-demo game-demo--blackjack">
    <header class="game-hero">
      <div>
        <span class="game-eyebrow">Blackjack · hidden information · special card triggers</span>
        <h2>Midnight House</h2>
        <p>Play recognizable Blackjack with a secondary deck of costly House Favors that alter information, draws, card values, and settlement.</p>
      </div>
      <div class="game-status-pill" :data-active="agentPlaying">{{ phase === 'player' ? (agentPlaying ? 'Agent playing' : 'Your hand') : phase }}</div>
    </header>

    <div class="game-layout">
      <div class="game-stage blackjack-stage">
        <div class="card-zone dealer-zone">
          <div class="hand-label">Dealer <strong>{{ revealDealer ? dealerValue : dealer[0]?.value }}</strong></div>
          <TransitionGroup name="card-deal" tag="div" class="playing-hand" appear>
            <div
              v-for="(card, index) in dealer"
              :key="`${card?.rank ?? 'hidden'}${card?.suit ?? ''}-${index}`"
              class="playing-card"
              :class="{ red: card?.suit === '♥' || card?.suit === '♦', hidden: index === 1 && !revealDealer }"
              :style="{ '--deal-index': index }"
            >
              <Transition name="card-reveal" mode="out-in">
                <div v-if="card && (index !== 1 || revealDealer)" :key="`front-${card.rank}${card.suit}`" class="card-face">
                  <b>{{ card.rank }}</b><span>{{ card.suit }}</span><em>{{ card.suit }}</em>
                </div>
                <div v-else key="back" class="card-back">GAOS</div>
              </Transition>
            </div>
          </TransitionGroup>
        </div>

        <Transition name="table-message" mode="out-in">
          <div :key="message" class="table-message">{{ message }}</div>
        </Transition>
        <Transition name="wager-pop" mode="out-in">
          <div :key="wager" class="bet-chip">BET<br><strong>{{ wager }}</strong></div>
        </Transition>

        <div class="card-zone player-zone">
          <TransitionGroup name="card-deal" tag="div" class="playing-hand" appear>
            <button
              v-for="(card, index) in player"
              :key="`${card.rank}${card.suit}-${index}`"
              class="playing-card player-card"
              :class="{ red: card.suit === '♥' || card.suit === '♦', 'glass-ace': glassAceIndex === index, targetable: targetingAce }"
              :style="{ '--deal-index': index }"
              :disabled="!targetingAce || agentPlaying || animating"
              @click="chooseGlassAce(index)"
            >
              <b>{{ glassAceIndex === index ? 'A' : card.rank }}</b><span>{{ card.suit }}</span><em>{{ card.suit }}</em>
            </button>
          </TransitionGroup>
          <div class="hand-label">Your hand <strong>{{ playerValue }}</strong></div>
        </div>

        <div v-if="twistChoices.length" class="twist-choice">
          <span>Choose one card</span>
          <button v-for="(card, index) in twistChoices" :key="`${card.rank}-${card.suit}`" :class="{ red: card.suit === '♥' || card.suit === '♦' }" :disabled="agentPlaying || animating" @click="chooseTwistCard(index)">
            <b>{{ card.rank }}</b><i>{{ card.suit }}</i>
          </button>
        </div>

        <div class="favor-zone">
          <div class="favor-head">
            <div><span>House Favors</span><strong>Play one special card per hand</strong></div>
            <div class="favor-resource"><span v-for="(full, index) in favorPips" :key="index" :class="{ full }">◆</span><b>{{ favor }}/5</b></div>
          </div>
          <div class="favor-hand">
            <button
              v-for="(card, index) in favorHand"
              :key="card.kind"
              class="favor-card"
              :class="{ exhausted: favorUsed || card.cost > favor }"
              :style="{ '--favor-index': index }"
              :disabled="phase !== 'player' || agentPlaying || animating || favorUsed || card.cost > favor || twistChoices.length > 0 || targetingAce"
              @click="playFavor(card)"
            >
              <span class="favor-cost">{{ card.cost }}</span><b>{{ card.glyph }}</b><strong>{{ card.name }}</strong><small>{{ card.text }}</small>
            </button>
            <div v-if="favorHand.length < 3" class="favor-discard-slot">DISCARD</div>
          </div>
        </div>

        <div class="table-bank"><span>Bankroll</span><strong>{{ chips }}</strong><small>chips</small></div>

        <div class="table-actions">
          <template v-if="phase === 'player'">
            <button :disabled="!canAct" @click="hit()">Hit</button>
            <button :disabled="!canAct" @click="stand()">Stand</button>
            <button :disabled="!canAct || player.length !== 2 || chips < wager" @click="doubleDown()">Double</button>
          </template>
          <button v-else class="deal-button" :disabled="chips < bet || agentPlaying || animating" @click="startRound">Deal next hand</button>
        </div>
      </div>

      <aside class="agent-console">
        <div class="agent-console__head"><span class="agent-orb" :class="{ thinking: agentPlaying || phase === 'dealer' }"></span><div><strong>Favor-aware strategy agent</strong><small>Seat view · timing windows · resource value</small></div></div>
        <div class="agent-decision"><span>Latest decision</span><p>{{ decision }}</p></div>
        <div class="agent-metrics">
          <div><span>Legal actions</span><strong>{{ legalActions().length }}</strong></div><div><span>Favor</span><strong>{{ favor }}</strong></div><div><span>Wins</span><strong>{{ wins }}</strong></div>
        </div>
        <div class="game-actions">
          <button class="primary-action" :disabled="phase !== 'player' || agentPlaying || animating" @click="watchAgent">Watch agent</button>
          <button :disabled="phase !== 'player' || agentPlaying || animating" @click="agentStep">Step once</button>
          <button @click="resetTable">Reset table</button>
        </div>
        <label class="seed-control"><span>Seed</span><input v-model.number="seed" type="number" min="1" @change="resetTable"></label>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.blackjack-stage {
  isolation:isolate;
  min-height:820px;
  overflow:hidden;
}
.blackjack-stage::before {
  position:absolute;
  z-index:-1;
  width:70%;
  aspect-ratio:1;
  border:1px solid rgba(231,195,123,.08);
  border-radius:50%;
  background:radial-gradient(circle,rgba(49,151,110,.08),transparent 67%);
  content:"";
  filter:blur(2px);
  animation:table-breathe 7s ease-in-out infinite;
}
.blackjack-stage::after {
  position:absolute;
  z-index:-1;
  top:-35%;
  left:-25%;
  width:38%;
  height:170%;
  transform:rotate(18deg);
  background:linear-gradient(90deg,transparent,rgba(231,195,123,.035),transparent);
  content:"";
  animation:table-glint 11s ease-in-out infinite;
}
.player-card { font: inherit; text-align:left; cursor:default; }
.player-card.targetable { cursor:pointer; box-shadow:0 0 0 3px #f1c66d,0 8px 24px rgba(241,198,109,.34); }
.player-card.glass-ace { border-color:#b8f3ff; box-shadow:0 0 20px rgba(150,230,255,.45); background:linear-gradient(145deg,#efffff,#b8dbe2); }
.card-face { position:relative; width:100%; height:100%; }
.card-deal-enter-active {
  animation:card-deal-in .5s cubic-bezier(.2,.8,.2,1) both;
  animation-delay:calc(var(--deal-index) * 70ms);
}
.card-deal-leave-active { transition:opacity .16s ease,transform .16s ease; }
.card-deal-leave-to { transform:translateY(-8px) scale(.92); opacity:0; }
.card-reveal-enter-active,.card-reveal-leave-active {
  transition:transform .3s ease,opacity .3s ease;
  transform-style:preserve-3d;
}
.card-reveal-enter-from { transform:rotateY(90deg) scale(.96); opacity:0; }
.card-reveal-leave-to { transform:rotateY(-90deg) scale(.96); opacity:0; }
.table-message-enter-active,.table-message-leave-active { transition:transform .2s ease,opacity .2s ease; }
.table-message-enter-from { transform:translateY(5px); opacity:0; }
.table-message-leave-to { transform:translateY(-5px); opacity:0; }
.wager-pop-enter-active { animation:wager-pop .4s cubic-bezier(.2,.85,.3,1.25); }
.wager-pop-leave-active { position:absolute; opacity:0; }
.favor-zone { width:min(650px,100%); margin:.45rem auto .7rem; border:1px solid rgba(231,195,123,.2); border-radius:14px; padding:.7rem; background:rgba(5,16,12,.55); }
.favor-head { display:flex; align-items:center; justify-content:space-between; gap:1rem; margin-bottom:.6rem; }
.favor-head span,.favor-head strong { display:block; }.favor-head span { color:var(--game-muted); font-size:.56rem; font-weight:850; letter-spacing:.1em; text-transform:uppercase; }.favor-head strong { margin-top:.12rem; color:var(--game-ink); font-size:.68rem; }
.favor-resource { display:flex; align-items:center; gap:.18rem; color:rgba(231,195,123,.16); }.favor-resource span.full { color:#f2c76d; filter:drop-shadow(0 0 5px rgba(242,199,109,.4)); }.favor-resource b { margin-left:.35rem; color:var(--game-muted); font-size:.58rem; }
.favor-hand { display:flex; min-height:108px; justify-content:center; gap:.5rem; }
.favor-card { position:relative; display:flex; width:31%; max-width:185px; flex-direction:column; align-items:center; border:1px solid rgba(231,195,123,.22); border-radius:10px; padding:.55rem .45rem; color:var(--game-ink); background:linear-gradient(145deg,rgba(231,195,123,.1),transparent 45%),#181b18; cursor:pointer; text-align:center; transition:transform .15s,border-color .15s; animation:favor-arrive .42s cubic-bezier(.2,.8,.2,1) both; animation-delay:calc(var(--favor-index) * 65ms); }
.favor-card:hover:not(:disabled) { transform:translateY(-4px); border-color:#edc979; }.favor-card.exhausted { filter:grayscale(.6); opacity:.38; cursor:not-allowed; }
.favor-card > b { color:#edc979; font-family:Georgia,serif; font-size:1.25rem; line-height:1; }.favor-card strong { margin-top:.3rem; color:var(--game-ink); font-family:Georgia,serif; font-size:.7rem; }.favor-card small { margin-top:.2rem; color:var(--game-muted); font-size:.52rem; line-height:1.3; }
.favor-cost { position:absolute; left:6px; top:6px; display:grid; width:19px; height:19px; place-items:center; border-radius:50%; color:#21160a; background:#edc979; font-size:.55rem; font-weight:900; }
.favor-discard-slot { display:grid; width:31%; max-width:185px; place-items:center; border:1px dashed rgba(255,255,255,.12); border-radius:10px; color:rgba(255,255,255,.2); font-size:.56rem; letter-spacing:.12em; }
.twist-choice { display:flex; align-items:center; justify-content:center; gap:.6rem; margin:.35rem auto; color:var(--game-muted); font-size:.62rem; }.twist-choice button { display:grid; width:48px; height:62px; place-items:center; border:1px solid #fff; border-radius:7px; color:#16181d; background:#f5f1e8; cursor:pointer; }.twist-choice button.red { color:#b62638; }.twist-choice b { font-family:Georgia,serif; font-size:1rem; }.twist-choice i { font-style:normal; }
@keyframes card-deal-in {
  from { transform:translate(46px,-24px) rotate(7deg) scale(.88); opacity:0; }
  to { opacity:1; }
}
@keyframes wager-pop {
  0% { transform:scale(.72) rotate(-8deg); opacity:0; }
  70% { transform:scale(1.08) rotate(2deg); opacity:1; }
  100% { transform:none; }
}
@keyframes favor-arrive {
  from { transform:translateY(10px) rotate(-1deg); opacity:0; }
  to { opacity:1; }
}
@keyframes table-breathe {
  0%,100% { transform:scale(.94); opacity:.45; }
  50% { transform:scale(1.08); opacity:1; }
}
@keyframes table-glint {
  0%,18% { transform:translateX(-30%) rotate(18deg); opacity:0; }
  35% { opacity:1; }
  55%,100% { transform:translateX(390%) rotate(18deg); opacity:0; }
}
@media(prefers-reduced-motion:reduce){.blackjack-stage::before,.blackjack-stage::after{animation:none}}
@media(max-width:620px){.favor-hand{gap:.25rem}.favor-card{padding:.5rem .2rem}.favor-card small{display:none}.favor-head{align-items:flex-start;flex-direction:column}.blackjack-stage{min-height:760px}}
</style>
