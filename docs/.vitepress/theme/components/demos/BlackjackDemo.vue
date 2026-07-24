<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { createRng, wait } from './game-utils';

type Suit = '♠' | '♥' | '♦' | '♣';
type Card = { rank: string; suit: Suit; value: number };
type Phase = 'player' | 'dealer' | 'settled';
type FavorKind = 'peek' | 'cut' | 'twist' | 'ace' | 'breath' | 'crown';
type FavorCard = { kind: FavorKind; name: string; cost: number; glyph: string; text: string };

const favorLibrary: FavorCard[] = [
  { kind: 'peek', name: 'Candle Peek', cost: 1, glyph: '◉', text: 'Reveal the dealer hole card.' },
  { kind: 'cut', name: 'Cut the Deck', cost: 1, glyph: '✂', text: 'Burn the next card before hitting.' },
  { kind: 'twist', name: 'Twist of Fate', cost: 2, glyph: '⑵', text: 'Draw two cards and choose one.' },
  { kind: 'ace', name: 'Glass Ace', cost: 2, glyph: 'A', text: 'Treat one selected card as an Ace.' },
  { kind: 'breath', name: 'Last Breath', cost: 2, glyph: '↶', text: 'Cancel the next card that would bust.' },
  { kind: 'crown', name: 'Crowned Hand', cost: 1, glyph: '♛', text: 'A three-card 21 receives a premium payout.' },
];

const seed = ref(1701);
const chips = ref(250);
const bet = ref(25);
const wager = ref(25);
const player = ref<Card[]>([]);
const dealer = ref<Card[]>([]);
const deck = ref<Card[]>([]);
const phase = ref<Phase>('settled');
const revealDealer = ref(false);
const message = ref('Place your bet.');
const decision = ref('Waiting for the deal');
const agentPlaying = ref(false);
const handsPlayed = ref(0);
const wins = ref(0);
const favor = ref(3);
const favorDeck = ref<FavorCard[]>([]);
const favorHand = ref<FavorCard[]>([]);
const favorDiscard = ref<FavorCard[]>([]);
const favorUsed = ref(false);
const glassAceIndex = ref<number | null>(null);
const targetingAce = ref(false);
const lastBreathArmed = ref(false);
const crownedHand = ref(false);
const twistChoices = ref<Card[]>([]);
let random = createRng(seed.value);
let runToken = 0;

const playerValue = computed(() => handValue(player.value, glassAceIndex.value));
const dealerValue = computed(() => handValue(dealer.value));
const dealerUpValue = computed(() => dealer.value[0]?.value ?? 0);
const canAct = computed(() => phase.value === 'player' && !agentPlaying.value && twistChoices.value.length === 0 && !targetingAce.value);
const blackjack = computed(() => player.value.length === 2 && playerValue.value === 21);
const favorPips = computed(() => Array.from({ length: 5 }, (_, index) => index < favor.value));

function handValue(hand: Card[], forcedAceIndex: number | null = null) {
  let value = hand.reduce((sum, card, index) => sum + (index === forcedAceIndex ? 11 : card.value), 0);
  let aces = hand.filter((card, index) => card.rank === 'A' || index === forcedAceIndex).length;
  while (value > 21 && aces > 0) {
    value -= 10;
    aces -= 1;
  }
  return value;
}

function isSoft(hand: Card[]) {
  const raw = hand.reduce((sum, card) => sum + card.value, 0);
  return hand.some((card) => card.rank === 'A') && raw === handValue(hand);
}

function shuffle<T>(values: T[]) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const next = Math.floor(random() * (index + 1));
    [copy[index], copy[next]] = [copy[next], copy[index]];
  }
  return copy;
}

function buildDeck() {
  const suits: Suit[] = ['♠', '♥', '♦', '♣'];
  const ranks = [
    ['A', 11], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7],
    ['8', 8], ['9', 9], ['10', 10], ['J', 10], ['Q', 10], ['K', 10],
  ] as const;
  return shuffle(suits.flatMap((suit) => ranks.map(([rank, value]) => ({ rank, suit, value }))));
}

function draw() {
  if (deck.value.length < 12) deck.value = buildDeck();
  return deck.value.pop()!;
}

function drawFavor() {
  if (!favorDeck.value.length) {
    favorDeck.value = shuffle(favorDiscard.value.length ? favorDiscard.value : favorLibrary);
    favorDiscard.value = [];
  }
  return favorDeck.value.pop();
}

function refreshFavorHand() {
  favorDiscard.value.push(...favorHand.value);
  favorHand.value = [];
  while (favorHand.value.length < 3) {
    const card = drawFavor();
    if (!card) break;
    favorHand.value.push(card);
  }
}

function resetHandAbilities() {
  favorUsed.value = false;
  glassAceIndex.value = null;
  targetingAce.value = false;
  lastBreathArmed.value = false;
  crownedHand.value = false;
  twistChoices.value = [];
}

function resetTable() {
  runToken += 1;
  agentPlaying.value = false;
  random = createRng(seed.value);
  deck.value = buildDeck();
  favorDeck.value = shuffle(favorLibrary);
  favorHand.value = [];
  favorDiscard.value = [];
  chips.value = 250;
  favor.value = 3;
  handsPlayed.value = 0;
  wins.value = 0;
  phase.value = 'settled';
  decision.value = 'Waiting for the deal';
  startRound();
}

function startRound() {
  if (agentPlaying.value || phase.value !== 'settled') return;
  if (chips.value < bet.value) {
    message.value = 'Not enough chips — reset the table to begin again.';
    return;
  }
  resetHandAbilities();
  refreshFavorHand();
  wager.value = bet.value;
  chips.value -= wager.value;
  player.value = [draw(), draw()];
  dealer.value = [draw(), draw()];
  revealDealer.value = false;
  phase.value = 'player';
  message.value = blackjack.value ? 'Natural Blackjack!' : 'Play one House Favor, then hit, stand, or double.';
  decision.value = `${legalActions().length} legal actions across Blackjack and Favor cards`;
  if (blackjack.value) void dealerTurn();
}

function playableFavorCards() {
  if (phase.value !== 'player' || favorUsed.value) return [];
  return favorHand.value.filter((card) => card.cost <= favor.value);
}

function legalActions() {
  if (phase.value !== 'player') return [];
  const actions = ['Hit', 'Stand'];
  if (player.value.length === 2 && chips.value >= wager.value) actions.push('Double');
  actions.push(...playableFavorCards().map((card) => card.name));
  return actions;
}

function consumeFavor(card: FavorCard) {
  favor.value -= card.cost;
  favorUsed.value = true;
  favorHand.value = favorHand.value.filter((item) => item.kind !== card.kind);
  favorDiscard.value.push(card);
}

async function chooseTwistCard(index: number, fromAgent = false) {
  if (!twistChoices.value[index] || (!fromAgent && agentPlaying.value)) return;
  const chosen = twistChoices.value[index];
  const rejected = twistChoices.value[index === 0 ? 1 : 0];
  player.value.push(chosen);
  twistChoices.value = [];
  message.value = `Twist chose ${chosen.rank}${chosen.suit}; ${rejected.rank}${rejected.suit} was discarded.`;
  if (playerValue.value > 21) settle('bust');
  else if (playerValue.value === 21) await dealerTurn();
}

async function playFavor(card: FavorCard, fromAgent = false) {
  if (phase.value !== 'player' || favorUsed.value || card.cost > favor.value || (!fromAgent && agentPlaying.value)) return;
  consumeFavor(card);
  decision.value = `${fromAgent ? 'Agent' : 'Player'} played ${card.name} for ${card.cost} Favor`;
  if (card.kind === 'peek') {
    revealDealer.value = true;
    message.value = `Candle Peek reveals ${dealer.value[1].rank}${dealer.value[1].suit}.`;
  } else if (card.kind === 'cut') {
    const burned = draw();
    message.value = `Cut the Deck burned ${burned.rank}${burned.suit}.`;
  } else if (card.kind === 'twist') {
    twistChoices.value = [draw(), draw()];
    message.value = 'Twist of Fate: choose one of the two drawn cards.';
    if (fromAgent) {
      const choiceValues = twistChoices.value.map((choice) => handValue([...player.value, choice], glassAceIndex.value));
      const safe = choiceValues
        .map((value, index) => ({ value, index }))
        .filter(({ value }) => value <= 21)
        .sort((a, b) => b.value - a.value);
      await wait(260);
      await chooseTwistCard(safe[0]?.index ?? choiceValues.indexOf(Math.min(...choiceValues)), true);
    }
  } else if (card.kind === 'ace') {
    if (fromAgent) {
      const target = player.value
        .map((playingCard, index) => ({ playingCard, index }))
        .filter(({ playingCard }) => playingCard.rank !== 'A')
        .sort((a, b) => b.playingCard.value - a.playingCard.value)[0];
      glassAceIndex.value = target?.index ?? 0;
      message.value = `${player.value[glassAceIndex.value].rank}${player.value[glassAceIndex.value].suit} became a Glass Ace.`;
    } else {
      targetingAce.value = true;
      message.value = 'Glass Ace: select one card in your hand.';
    }
  } else if (card.kind === 'breath') {
    lastBreathArmed.value = true;
    message.value = 'Last Breath is armed for the next draw that would bust.';
  } else {
    crownedHand.value = true;
    message.value = 'Crowned Hand will enhance a three-or-more-card 21.';
  }
}

function chooseGlassAce(index: number) {
  if (!targetingAce.value || agentPlaying.value) return;
  glassAceIndex.value = index;
  targetingAce.value = false;
  message.value = `${player.value[index].rank}${player.value[index].suit} is treated as an Ace this hand.`;
}

async function resolvePlayerDraw() {
  if (playerValue.value > 21 && lastBreathArmed.value) {
    const cancelled = player.value.pop()!;
    lastBreathArmed.value = false;
    message.value = `Last Breath cancelled ${cancelled.rank}${cancelled.suit} and forces a stand.`;
    await wait(320);
    await dealerTurn();
  } else if (playerValue.value > 21) settle('bust');
  else if (playerValue.value === 21) await dealerTurn();
}

async function hit(fromAgent = false) {
  if (phase.value !== 'player' || twistChoices.value.length || targetingAce.value || (!fromAgent && agentPlaying.value)) return;
  player.value.push(draw());
  message.value = `Drew ${player.value.at(-1)!.rank}${player.value.at(-1)!.suit}.`;
  await resolvePlayerDraw();
}

async function stand(fromAgent = false) {
  if (phase.value !== 'player' || twistChoices.value.length || targetingAce.value || (!fromAgent && agentPlaying.value)) return;
  await dealerTurn();
}

async function doubleDown(fromAgent = false) {
  if (phase.value !== 'player' || player.value.length !== 2 || chips.value < wager.value || twistChoices.value.length || targetingAce.value) return;
  if (!fromAgent && agentPlaying.value) return;
  chips.value -= wager.value;
  wager.value *= 2;
  player.value.push(draw());
  message.value = `Doubled to ${wager.value} chips.`;
  if (playerValue.value > 21 && lastBreathArmed.value) {
    const cancelled = player.value.pop()!;
    lastBreathArmed.value = false;
    message.value = `Last Breath cancelled ${cancelled.rank}${cancelled.suit}; the doubled hand stands.`;
  } else if (playerValue.value > 21) {
    settle('bust');
    return;
  }
  await dealerTurn();
}

async function dealerTurn() {
  const token = runToken;
  phase.value = 'dealer';
  revealDealer.value = true;
  twistChoices.value = [];
  targetingAce.value = false;
  message.value = 'Dealer reveals the hole card.';
  await wait(420);
  while (dealerValue.value < 17 && token === runToken) {
    dealer.value.push(draw());
    message.value = `Dealer draws ${dealer.value.at(-1)!.rank}${dealer.value.at(-1)!.suit}.`;
    await wait(420);
  }
  if (token !== runToken) return;
  settle('compare');
}

function settle(reason: 'bust' | 'compare') {
  revealDealer.value = true;
  phase.value = 'settled';
  handsPlayed.value += 1;
  const dealerBlackjack = dealer.value.length === 2 && dealerValue.value === 21;
  let favorEarned = 0;
  if (reason === 'bust' || playerValue.value > 21) {
    message.value = `Bust at ${playerValue.value}. Dealer wins.`;
  } else if (dealerValue.value > 21 || playerValue.value > dealerValue.value) {
    const crowned = crownedHand.value && player.value.length >= 3 && playerValue.value === 21;
    const payout = crowned
      ? wager.value * 3
      : blackjack.value && !dealerBlackjack ? Math.floor(wager.value * 2.5) : wager.value * 2;
    chips.value += payout;
    wins.value += 1;
    favorEarned = 1 + (dealerValue.value > 21 ? 1 : 0);
    favor.value = Math.min(5, favor.value + favorEarned);
    message.value = `${dealerValue.value > 21 ? 'Dealer busts' : crowned ? 'Crowned 21' : 'You win'} · +${payout - wager.value} chips · +${favorEarned} Favor.`;
  } else if (playerValue.value === dealerValue.value) {
    chips.value += wager.value;
    message.value = `Push at ${playerValue.value}. Bet returned.`;
  } else {
    message.value = `Dealer wins ${dealerValue.value} to ${playerValue.value}.`;
  }
  agentPlaying.value = false;
}

function agentFavorChoice() {
  if (favorUsed.value) return undefined;
  const available = playableFavorCards();
  const find = (kind: FavorKind) => available.find((card) => card.kind === kind);
  if (playerValue.value >= 15 && find('breath')) return find('breath');
  if (playerValue.value >= 14 && playerValue.value <= 17 && find('twist')) return find('twist');
  if (dealerUpValue.value >= 10 && find('peek')) return find('peek');
  if (player.value.length >= 3 && playerValue.value >= 18 && find('crown')) return find('crown');
  if (playerValue.value >= 16 && find('ace')) return find('ace');
  return undefined;
}

function agentChoice() {
  const value = playerValue.value;
  const up = dealerUpValue.value;
  const soft = isSoft(player.value);
  const canDouble = player.value.length === 2 && chips.value >= wager.value;
  if (revealDealer.value && dealerValue.value < value && value <= 21) return 'Stand';
  if (canDouble && !soft && (value === 11 || (value === 10 && up <= 9))) return 'Double';
  if (soft && value <= 17) return 'Hit';
  if (value >= 17) return 'Stand';
  if (value <= 11) return 'Hit';
  if (value >= 12 && value <= 16 && up >= 2 && up <= 6) return 'Stand';
  return 'Hit';
}

async function agentStep() {
  if (phase.value === 'settled') {
    startRound();
    return;
  }
  if (phase.value !== 'player') return;
  const favorCard = agentFavorChoice();
  if (favorCard) {
    await playFavor(favorCard, true);
    return;
  }
  const choice = agentChoice();
  decision.value = `${isSoft(player.value) ? 'Soft' : 'Hard'} ${playerValue.value} vs dealer ${dealerUpValue.value} → ${choice}`;
  message.value = `Strategy agent chooses ${choice.toLowerCase()}.`;
  await wait(350);
  if (choice === 'Hit') await hit(true);
  else if (choice === 'Double') await doubleDown(true);
  else await stand(true);
}

async function watchAgent() {
  if (phase.value === 'settled') startRound();
  if (phase.value !== 'player') return;
  agentPlaying.value = true;
  const token = runToken;
  while (agentPlaying.value && phase.value === 'player' && token === runToken) {
    await agentStep();
    await wait(420);
  }
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
              :key="`${card.rank}${card.suit}-${index}`"
              class="playing-card"
              :class="{ red: card.suit === '♥' || card.suit === '♦', hidden: index === 1 && !revealDealer }"
              :style="{ '--deal-index': index }"
            >
              <Transition name="card-reveal" mode="out-in">
                <div v-if="index !== 1 || revealDealer" :key="`front-${card.rank}${card.suit}`" class="card-face">
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
              :disabled="!targetingAce"
              @click="chooseGlassAce(index)"
            >
              <b>{{ glassAceIndex === index ? 'A' : card.rank }}</b><span>{{ card.suit }}</span><em>{{ card.suit }}</em>
            </button>
          </TransitionGroup>
          <div class="hand-label">Your hand <strong>{{ playerValue }}</strong></div>
        </div>

        <div v-if="twistChoices.length" class="twist-choice">
          <span>Choose one card</span>
          <button v-for="(card, index) in twistChoices" :key="`${card.rank}-${card.suit}`" :class="{ red: card.suit === '♥' || card.suit === '♦' }" @click="chooseTwistCard(index)">
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
              :disabled="phase !== 'player' || agentPlaying || favorUsed || card.cost > favor || twistChoices.length > 0 || targetingAce"
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
          <button v-else class="deal-button" :disabled="chips < bet" @click="startRound">Deal next hand</button>
        </div>
      </div>

      <aside class="agent-console">
        <div class="agent-console__head"><span class="agent-orb" :class="{ thinking: agentPlaying || phase === 'dealer' }"></span><div><strong>Favor-aware strategy agent</strong><small>Seat view · timing windows · resource value</small></div></div>
        <div class="agent-decision"><span>Latest decision</span><p>{{ decision }}</p></div>
        <div class="agent-metrics">
          <div><span>Legal actions</span><strong>{{ legalActions().length }}</strong></div><div><span>Favor</span><strong>{{ favor }}</strong></div><div><span>Wins</span><strong>{{ wins }}</strong></div>
        </div>
        <div class="game-actions">
          <button class="primary-action" :disabled="phase !== 'player' || agentPlaying" @click="watchAgent">Watch agent</button>
          <button :disabled="phase !== 'player' || agentPlaying" @click="agentStep">Step once</button>
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
