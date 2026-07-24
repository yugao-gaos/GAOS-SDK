<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { createRng, wait } from './game-utils';

type Suit = '♠' | '♥' | '♦' | '♣';
type Card = { rank: string; suit: Suit; value: number };
type Phase = 'player' | 'dealer' | 'settled';

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
let random = createRng(seed.value);
let runToken = 0;

const playerValue = computed(() => handValue(player.value));
const dealerValue = computed(() => handValue(dealer.value));
const dealerUpValue = computed(() => dealer.value[0]?.value ?? 0);
const canAct = computed(() => phase.value === 'player' && !agentPlaying.value);
const blackjack = computed(() => player.value.length === 2 && playerValue.value === 21);

function handValue(hand: Card[]) {
  let value = hand.reduce((sum, card) => sum + card.value, 0);
  let aces = hand.filter((card) => card.rank === 'A').length;
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

function buildDeck() {
  const suits: Suit[] = ['♠', '♥', '♦', '♣'];
  const ranks = [
    ['A', 11], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7],
    ['8', 8], ['9', 9], ['10', 10], ['J', 10], ['Q', 10], ['K', 10],
  ] as const;
  const cards = suits.flatMap((suit) => ranks.map(([rank, value]) => ({ rank, suit, value })));
  for (let index = cards.length - 1; index > 0; index -= 1) {
    const next = Math.floor(random() * (index + 1));
    [cards[index], cards[next]] = [cards[next], cards[index]];
  }
  return cards;
}

function draw() {
  if (deck.value.length < 12) deck.value = buildDeck();
  return deck.value.pop()!;
}

function resetTable() {
  runToken += 1;
  agentPlaying.value = false;
  random = createRng(seed.value);
  deck.value = buildDeck();
  chips.value = 250;
  handsPlayed.value = 0;
  wins.value = 0;
  phase.value = 'settled';
  decision.value = 'Waiting for the deal';
  startRound();
}

function startRound() {
  if (agentPlaying.value || phase.value !== 'settled') return;
  if (chips.value < bet.value) {
    message.value = 'Not enough chips — resetting the table.';
    return;
  }
  wager.value = bet.value;
  chips.value -= wager.value;
  player.value = [draw(), draw()];
  dealer.value = [draw(), draw()];
  revealDealer.value = false;
  phase.value = 'player';
  message.value = blackjack.value ? 'Blackjack!' : 'Hit, stand, or double.';
  decision.value = `${legalActions().length} legal actions`;
  if (blackjack.value) void dealerTurn();
}

function legalActions() {
  if (phase.value !== 'player') return [];
  const actions = ['Hit', 'Stand'];
  if (player.value.length === 2 && chips.value >= wager.value) actions.push('Double');
  return actions;
}

async function hit(fromAgent = false) {
  if (phase.value !== 'player' || (!fromAgent && agentPlaying.value)) return;
  player.value.push(draw());
  message.value = `Drew ${player.value.at(-1)!.rank}${player.value.at(-1)!.suit}.`;
  if (playerValue.value > 21) settle('bust');
  else if (playerValue.value === 21) await dealerTurn();
}

async function stand(fromAgent = false) {
  if (phase.value !== 'player' || (!fromAgent && agentPlaying.value)) return;
  await dealerTurn();
}

async function doubleDown(fromAgent = false) {
  if (phase.value !== 'player' || player.value.length !== 2 || chips.value < wager.value) return;
  if (!fromAgent && agentPlaying.value) return;
  chips.value -= wager.value;
  wager.value *= 2;
  player.value.push(draw());
  message.value = `Doubled to ${wager.value} chips.`;
  if (playerValue.value > 21) settle('bust');
  else await dealerTurn();
}

async function dealerTurn() {
  const token = runToken;
  phase.value = 'dealer';
  revealDealer.value = true;
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
  if (reason === 'bust' || playerValue.value > 21) {
    message.value = `Bust at ${playerValue.value}. Dealer wins.`;
  } else if (dealerValue.value > 21 || playerValue.value > dealerValue.value) {
    const payout = blackjack.value && !dealerBlackjack ? Math.floor(wager.value * 2.5) : wager.value * 2;
    chips.value += payout;
    wins.value += 1;
    message.value = dealerValue.value > 21 ? `Dealer busts. You win ${payout - wager.value}.` : `You win ${payout - wager.value} chips.`;
  } else if (playerValue.value === dealerValue.value) {
    chips.value += wager.value;
    message.value = `Push at ${playerValue.value}. Bet returned.`;
  } else {
    message.value = `Dealer wins ${dealerValue.value} to ${playerValue.value}.`;
  }
  agentPlaying.value = false;
}

function agentChoice() {
  const value = playerValue.value;
  const up = dealerUpValue.value;
  const soft = isSoft(player.value);
  const canDouble = player.value.length === 2 && chips.value >= wager.value;
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

onUnmounted(() => {
  runToken += 1;
});

resetTable();
</script>

<template>
  <section class="game-demo game-demo--blackjack">
    <header class="game-hero">
      <div>
        <span class="game-eyebrow">Playable system demo · hidden information</span>
        <h2>Midnight House</h2>
        <p>A complete seeded blackjack table. Read the dealer, manage your bankroll, or hand the seat to a basic-strategy agent.</p>
      </div>
      <div class="game-status-pill" :data-active="agentPlaying">{{ phase === 'player' ? (agentPlaying ? 'Agent playing' : 'Your hand') : phase }}</div>
    </header>

    <div class="game-layout">
      <div class="game-stage blackjack-stage">
        <div class="card-zone dealer-zone">
          <div class="hand-label">Dealer <strong>{{ revealDealer ? dealerValue : dealer[0]?.value }}</strong></div>
          <div class="playing-hand">
            <div
              v-for="(card, index) in dealer"
              :key="`${card.rank}${card.suit}-${index}`"
              class="playing-card"
              :class="{ red: card.suit === '♥' || card.suit === '♦', hidden: index === 1 && !revealDealer }"
            >
              <template v-if="index !== 1 || revealDealer">
                <b>{{ card.rank }}</b><span>{{ card.suit }}</span><em>{{ card.suit }}</em>
              </template>
              <div v-else class="card-back">GAOS</div>
            </div>
          </div>
        </div>

        <div class="table-message">{{ message }}</div>
        <div class="bet-chip">BET<br><strong>{{ wager }}</strong></div>

        <div class="card-zone player-zone">
          <div class="playing-hand">
            <div
              v-for="(card, index) in player"
              :key="`${card.rank}${card.suit}-${index}`"
              class="playing-card"
              :class="{ red: card.suit === '♥' || card.suit === '♦' }"
            >
              <b>{{ card.rank }}</b><span>{{ card.suit }}</span><em>{{ card.suit }}</em>
            </div>
          </div>
          <div class="hand-label">Your hand <strong>{{ playerValue }}</strong></div>
        </div>

        <div class="table-bank">
          <span>Bankroll</span><strong>{{ chips }}</strong><small>chips</small>
        </div>

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
        <div class="agent-console__head">
          <span class="agent-orb" :class="{ thinking: agentPlaying || phase === 'dealer' }"></span>
          <div><strong>Basic-strategy agent</strong><small>Seat view only · no hole card access</small></div>
        </div>
        <div class="agent-decision">
          <span>Latest decision</span>
          <p>{{ decision }}</p>
        </div>
        <div class="agent-metrics">
          <div><span>Legal actions</span><strong>{{ legalActions().length }}</strong></div>
          <div><span>Hands</span><strong>{{ handsPlayed }}</strong></div>
          <div><span>Wins</span><strong>{{ wins }}</strong></div>
        </div>
        <div class="game-actions">
          <button class="primary-action" :disabled="phase !== 'player' || agentPlaying" @click="watchAgent">Watch agent</button>
          <button :disabled="phase !== 'player' || agentPlaying" @click="agentStep">Step once</button>
          <button @click="resetTable">Reset table</button>
        </div>
        <label class="seed-control">
          <span>Seed</span>
          <input v-model.number="seed" type="number" min="1" @change="resetTable">
        </label>
      </aside>
    </div>
  </section>
</template>
