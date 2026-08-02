import {
  AgentEnvironment,
  changeResource,
  commitZoneTransfer,
  createZone,
  deck,
  defineResources,
  defineZones,
  discard,
  enumerateActions,
  hand,
  initializeResourceBalances,
  mulberry32,
  planResourceTransaction,
  planZoneTransfer,
  resourceAtLeast,
  shuffleZone,
  type ActionDefinition,
  type ResourceBalances,
  type SubmittedAction,
  type TickReducer,
  type TickView,
  type ZoneCollection,
  type ZoneEntryView,
  type ZoneViewNamespace,
} from '../../src/engine/index.js';

export type MidnightHouseSuit = '♠' | '♥' | '♦' | '♣';
export type MidnightHousePhase = 'player' | 'dealer' | 'settled';
export type MidnightHouseFavorKind = 'peek' | 'cut' | 'twist' | 'ace' | 'breath' | 'crown';

export interface MidnightHouseCard {
  rank: string;
  suit: MidnightHouseSuit;
  value: number;
}

export interface MidnightHouseFavorCard {
  kind: MidnightHouseFavorKind;
  name: string;
  cost: number;
  glyph: string;
  text: string;
}

export interface MidnightHouseLevel {
  bet: number;
}

export const MIDNIGHT_HOUSE_DEFAULT_LEVEL: MidnightHouseLevel = { bet: 25 };

export const MIDNIGHT_HOUSE_ACTIONS = {
  hit: 'Action 1',
  stand: 'Action 2',
  double: 'Action 3',
  peek: 'Action 4',
  cut: 'Action 5',
  twist: 'Action 6',
  ace: 'Action 7',
  breath: 'Action 8',
  crown: 'Action 9',
  chooseTwist: 'Action 10',
  chooseAce: 'Action 11',
  deal: 'Action 12',
} as const;

export const MIDNIGHT_HOUSE_FAVORS: readonly MidnightHouseFavorCard[] = [
  { kind: 'peek', name: 'Candle Peek', cost: 1, glyph: '◉', text: 'Reveal the dealer hole card.' },
  { kind: 'cut', name: 'Cut the Deck', cost: 1, glyph: '✂', text: 'Burn the next card before hitting.' },
  { kind: 'twist', name: 'Twist of Fate', cost: 2, glyph: '⑵', text: 'Draw two cards and choose one.' },
  { kind: 'ace', name: 'Glass Ace', cost: 2, glyph: 'A', text: 'Treat one selected card as an Ace.' },
  { kind: 'breath', name: 'Last Breath', cost: 2, glyph: '↶', text: 'Cancel the next card that would bust.' },
  { kind: 'crown', name: 'Crowned Hand', cost: 1, glyph: '♛', text: 'A three-card 21 receives a premium payout.' },
];

interface RandomCursor {
  next(): number;
  draws(): number;
}

interface MidnightHouseInternalFrame {
  resources: ResourceBalances;
  wager: number;
  player: readonly MidnightHouseCard[];
  dealer: readonly MidnightHouseCard[];
  phase: MidnightHousePhase;
  revealDealer: boolean;
  message: string;
  handsPlayed: number;
  wins: number;
  favorHand: readonly MidnightHouseFavorCard[];
  favorUsed: boolean;
  glassAceIndex: number | null;
  targetingAce: boolean;
  lastBreathArmed: boolean;
  crownedHand: boolean;
  twistChoices: readonly MidnightHouseCard[];
}

export interface MidnightHouseFrame {
  resources: ResourceBalances;
  wager: number;
  player: readonly MidnightHouseCard[];
  dealer: readonly (MidnightHouseCard | null)[];
  playerValue: number;
  dealerValue: number | null;
  phase: MidnightHousePhase;
  revealDealer: boolean;
  message: string;
  handsPlayed: number;
  wins: number;
  favorHand: readonly MidnightHouseFavorCard[];
  favorUsed: boolean;
  glassAceIndex: number | null;
  targetingAce: boolean;
  lastBreathArmed: boolean;
  crownedHand: boolean;
  twistChoices: readonly MidnightHouseCard[];
}

export interface MidnightHouseTransition {
  frames: readonly MidnightHouseFrame[];
}

export interface MidnightHouseZoneEntry extends ZoneEntryView {
  rank?: string;
  suit?: MidnightHouseSuit;
  value?: number;
  hidden?: boolean;
  name?: string;
  kind?: MidnightHouseFavorKind;
}

export interface MidnightHouseView extends TickView {
  level: MidnightHouseLevel;
  resources: ResourceBalances;
  bet: number;
  wager: number;
  player: readonly MidnightHouseCard[];
  dealer: readonly (MidnightHouseCard | null)[];
  phase: MidnightHousePhase;
  revealDealer: boolean;
  message: string;
  handsPlayed: number;
  wins: number;
  favorHand: readonly MidnightHouseFavorCard[];
  favorUsed: boolean;
  glassAceIndex: number | null;
  targetingAce: boolean;
  lastBreathArmed: boolean;
  crownedHand: boolean;
  twistChoices: readonly MidnightHouseCard[];
  playerValue: number;
  dealerValue: number | null;
  dealerUpValue: number;
  blackjack: boolean;
  transition?: MidnightHouseTransition;
  zones: Readonly<Record<string, ZoneViewNamespace<MidnightHouseZoneEntry>>>;
}

export interface MidnightHouseState {
  level: MidnightHouseLevel;
  seed: number;
  randomDraws: number;
  shoe: number;
  cards: Readonly<Record<string, MidnightHouseCard>>;
  zones: ZoneCollection;
  resources: ResourceBalances;
  wager: number;
  phase: MidnightHousePhase;
  revealDealer: boolean;
  message: string;
  handsPlayed: number;
  wins: number;
  favorDeck: readonly MidnightHouseFavorKind[];
  favorHand: readonly MidnightHouseFavorKind[];
  favorDiscard: readonly MidnightHouseFavorKind[];
  favorUsed: boolean;
  glassAceIndex: number | null;
  targetingAce: boolean;
  lastBreathArmed: boolean;
  crownedHand: boolean;
  actionsUsed: number;
  lastEvents?: {
    frames: readonly MidnightHouseInternalFrame[];
  };
}

const RESOURCE_DEFINITIONS = defineResources({
  chips: { initial: 250, min: 0 },
  favor: { initial: 3, min: 0, max: 5 },
});

const FAVOR_BY_KIND = Object.fromEntries(
  MIDNIGHT_HOUSE_FAVORS.map((card) => [card.kind, card]),
) as Record<MidnightHouseFavorKind, MidnightHouseFavorCard>;

const FAVOR_ACTION: Record<MidnightHouseFavorKind, string> = {
  peek: MIDNIGHT_HOUSE_ACTIONS.peek,
  cut: MIDNIGHT_HOUSE_ACTIONS.cut,
  twist: MIDNIGHT_HOUSE_ACTIONS.twist,
  ace: MIDNIGHT_HOUSE_ACTIONS.ace,
  breath: MIDNIGHT_HOUSE_ACTIONS.breath,
  crown: MIDNIGHT_HOUSE_ACTIONS.crown,
};

const ACTION_FAVOR = Object.fromEntries(
  Object.entries(FAVOR_ACTION).map(([kind, id]) => [id, kind]),
) as Record<string, MidnightHouseFavorKind>;

function copyCard(card: MidnightHouseCard): MidnightHouseCard {
  return { ...card };
}

function copyFavor(card: MidnightHouseFavorCard): MidnightHouseFavorCard {
  return { ...card };
}

function randomCursor(seed: number, consumed: number): RandomCursor {
  const random = mulberry32(seed);
  for (let index = 0; index < consumed; index += 1) random();
  let draws = consumed;
  return {
    next() {
      draws += 1;
      return random();
    },
    draws: () => draws,
  };
}

function shuffle<T>(values: readonly T[], random: RandomCursor): T[] {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const next = Math.floor(random.next() * (index + 1));
    [copy[index], copy[next]] = [copy[next]!, copy[index]!];
  }
  return copy;
}

function initialZones(): ZoneCollection {
  return defineZones({
    deck: createZone(deck('deck'), []),
    player: createZone(hand('player', 'player'), []),
    dealer: createZone(hand('dealer', 'dealer'), []),
    twist: createZone(hand('player', 'twist'), []),
    discard: createZone(discard('discard'), []),
  });
}

function cloneState(state: MidnightHouseState): MidnightHouseState {
  return {
    ...state,
    level: { ...state.level },
    cards: { ...state.cards },
    zones: defineZones(state.zones),
    resources: { ...state.resources },
    favorDeck: [...state.favorDeck],
    favorHand: [...state.favorHand],
    favorDiscard: [...state.favorDiscard],
    lastEvents: undefined,
  };
}

function zoneIds(state: MidnightHouseState, zoneId: string): readonly string[] {
  return state.zones[zoneId]?.entries ?? [];
}

function cardsIn(state: MidnightHouseState, zoneId: string): MidnightHouseCard[] {
  return zoneIds(state, zoneId).map((id) => copyCard(state.cards[id]!));
}

function addShoe(state: MidnightHouseState, random: RandomCursor): void {
  const suits: readonly MidnightHouseSuit[] = ['♠', '♥', '♦', '♣'];
  const ranks = [
    ['A', 11], ['2', 2], ['3', 3], ['4', 4], ['5', 5], ['6', 6], ['7', 7],
    ['8', 8], ['9', 9], ['10', 10], ['J', 10], ['Q', 10], ['K', 10],
  ] as const;
  const shoe = state.shoe + 1;
  const cards = { ...state.cards };
  const ids: string[] = [];
  suits.forEach((suit, suitIndex) => {
    ranks.forEach(([rank, value], rankIndex) => {
      const id = `shoe-${shoe}-${suitIndex}-${rankIndex}`;
      cards[id] = { rank, suit, value };
      ids.push(id);
    });
  });
  const zones = defineZones({
    ...state.zones,
    deck: createZone(deck('deck'), ids),
  });
  const shuffleSeed = Math.floor(random.next() * 0x1_0000_0000) >>> 0;
  state.shoe = shoe;
  state.cards = cards;
  state.zones = shuffleZone(zones, 'deck', shuffleSeed);
}

function transfer(
  state: MidnightHouseState,
  entryIds: readonly string[],
  from: string,
  to: string,
): void {
  if (entryIds.length === 0) return;
  const source = zoneIds(state, from);
  const firstIndex = source.indexOf(entryIds[0]!);
  const plan = planZoneTransfer(state.zones, {
    entries: entryIds,
    from: { container: from, coord: firstIndex },
    to: { container: to, coord: zoneIds(state, to).length },
    insert: 'top',
  });
  if (!plan.ok) throw new Error(`Midnight House zone transfer failed: ${plan.message}`);
  const committed = commitZoneTransfer(state.zones, plan);
  if (!committed.ok) throw new Error(`Midnight House zone commit failed: ${committed.message}`);
  state.zones = committed.zones;
}

function drawTo(
  state: MidnightHouseState,
  to: 'player' | 'dealer' | 'twist' | 'discard',
  random: RandomCursor,
): MidnightHouseCard {
  if (zoneIds(state, 'deck').length < 12) addShoe(state, random);
  const deckIds = zoneIds(state, 'deck');
  const id = deckIds[deckIds.length - 1]!;
  transfer(state, [id], 'deck', to);
  return copyCard(state.cards[id]!);
}

function clearToDiscard(state: MidnightHouseState, zoneId: 'player' | 'dealer' | 'twist'): void {
  transfer(state, [...zoneIds(state, zoneId)], zoneId, 'discard');
}

function transact(
  state: MidnightHouseState,
  id: string,
  effects: readonly ReturnType<typeof changeResource>[],
  requirements: readonly ReturnType<typeof resourceAtLeast>[] = [],
): void {
  const plan = planResourceTransaction(RESOURCE_DEFINITIONS, state.resources, {
    id,
    requirements,
    effects,
  });
  if (!plan.ok) throw new RangeError(`Midnight House resource transaction failed: ${plan.failure.code}`);
  state.resources = plan.balances;
}

export function midnightHouseHandValue(
  handCards: readonly MidnightHouseCard[],
  forcedAceIndex: number | null = null,
): number {
  let value = handCards.reduce(
    (sum, card, index) => sum + (index === forcedAceIndex ? 11 : card.value),
    0,
  );
  let aces = handCards.filter(
    (card, index) => card.rank === 'A' || index === forcedAceIndex,
  ).length;
  while (value > 21 && aces > 0) {
    value -= 10;
    aces -= 1;
  }
  return value;
}

function isSoft(handCards: readonly MidnightHouseCard[]): boolean {
  const raw = handCards.reduce((sum, card) => sum + card.value, 0);
  return handCards.some((card) => card.rank === 'A')
    && raw === midnightHouseHandValue(handCards);
}

function favorCards(kinds: readonly MidnightHouseFavorKind[]): MidnightHouseFavorCard[] {
  return kinds.map((kind) => copyFavor(FAVOR_BY_KIND[kind]));
}

function snapshotFrame(state: MidnightHouseState): MidnightHouseInternalFrame {
  return {
    resources: { ...state.resources },
    wager: state.wager,
    player: cardsIn(state, 'player'),
    dealer: cardsIn(state, 'dealer'),
    phase: state.phase,
    revealDealer: state.revealDealer,
    message: state.message,
    handsPlayed: state.handsPlayed,
    wins: state.wins,
    favorHand: favorCards(state.favorHand),
    favorUsed: state.favorUsed,
    glassAceIndex: state.glassAceIndex,
    targetingAce: state.targetingAce,
    lastBreathArmed: state.lastBreathArmed,
    crownedHand: state.crownedHand,
    twistChoices: cardsIn(state, 'twist'),
  };
}

function pushFrame(state: MidnightHouseState, frames: MidnightHouseInternalFrame[]): void {
  frames.push(snapshotFrame(state));
}

function refreshFavorHand(state: MidnightHouseState, random: RandomCursor): void {
  const discardPile = [...state.favorDiscard, ...state.favorHand];
  let deckPile = [...state.favorDeck];
  const handCards: MidnightHouseFavorKind[] = [];
  let discardCards = discardPile;
  while (handCards.length < 3) {
    if (deckPile.length === 0) {
      deckPile = shuffle(
        discardCards.length > 0
          ? discardCards
          : MIDNIGHT_HOUSE_FAVORS.map(({ kind }) => kind),
        random,
      );
      discardCards = [];
    }
    const next = deckPile.pop();
    if (!next) break;
    handCards.push(next);
  }
  state.favorDeck = deckPile;
  state.favorHand = handCards;
  state.favorDiscard = discardCards;
}

function resetHandAbilities(state: MidnightHouseState): void {
  state.favorUsed = false;
  state.glassAceIndex = null;
  state.targetingAce = false;
  state.lastBreathArmed = false;
  state.crownedHand = false;
}

function settle(
  state: MidnightHouseState,
  reason: 'bust' | 'compare',
  frames: MidnightHouseInternalFrame[],
): void {
  const playerCards = cardsIn(state, 'player');
  const dealerCards = cardsIn(state, 'dealer');
  const playerValue = midnightHouseHandValue(playerCards, state.glassAceIndex);
  const dealerValue = midnightHouseHandValue(dealerCards);
  const blackjack = playerCards.length === 2 && playerValue === 21;
  const dealerBlackjack = dealerCards.length === 2 && dealerValue === 21;
  state.revealDealer = true;
  state.phase = 'settled';
  state.handsPlayed += 1;

  if (reason === 'bust' || playerValue > 21) {
    state.message = `Bust at ${playerValue}. Dealer wins.`;
  } else if (dealerValue > 21 || playerValue > dealerValue) {
    const crowned = state.crownedHand && playerCards.length >= 3 && playerValue === 21;
    const payout = crowned
      ? state.wager * 3
      : blackjack && !dealerBlackjack ? Math.floor(state.wager * 2.5) : state.wager * 2;
    const favorEarned = 1 + (dealerValue > 21 ? 1 : 0);
    const favorGain = Math.min(favorEarned, 5 - state.resources.favor!);
    transact(state, `settle-win-${state.actionsUsed}`, [
      changeResource('chips', payout),
      ...(favorGain > 0 ? [changeResource('favor', favorGain)] : []),
    ]);
    state.wins += 1;
    state.message = `${dealerValue > 21 ? 'Dealer busts' : crowned ? 'Crowned 21' : 'You win'} · +${payout - state.wager} chips · +${favorEarned} Favor.`;
  } else if (playerValue === dealerValue) {
    transact(state, `settle-push-${state.actionsUsed}`, [
      changeResource('chips', state.wager),
    ]);
    state.message = `Push at ${playerValue}. Bet returned.`;
  } else {
    state.message = `Dealer wins ${dealerValue} to ${playerValue}.`;
  }
  pushFrame(state, frames);
}

function dealerTurn(
  state: MidnightHouseState,
  random: RandomCursor,
  frames: MidnightHouseInternalFrame[],
): void {
  state.phase = 'dealer';
  state.revealDealer = true;
  state.targetingAce = false;
  clearToDiscard(state, 'twist');
  state.message = 'Dealer reveals the hole card.';
  pushFrame(state, frames);
  while (midnightHouseHandValue(cardsIn(state, 'dealer')) < 17) {
    const drawn = drawTo(state, 'dealer', random);
    state.message = `Dealer draws ${drawn.rank}${drawn.suit}.`;
    pushFrame(state, frames);
  }
  settle(state, 'compare', frames);
}

function resolvePlayerDraw(
  state: MidnightHouseState,
  random: RandomCursor,
  frames: MidnightHouseInternalFrame[],
  doubled = false,
): void {
  const playerValue = midnightHouseHandValue(cardsIn(state, 'player'), state.glassAceIndex);
  if (playerValue > 21 && state.lastBreathArmed) {
    const playerIds = zoneIds(state, 'player');
    const cancelledId = playerIds[playerIds.length - 1]!;
    const cancelled = state.cards[cancelledId]!;
    transfer(state, [cancelledId], 'player', 'discard');
    state.lastBreathArmed = false;
    state.message = `Last Breath cancelled ${cancelled.rank}${cancelled.suit}${doubled ? '; the doubled hand stands.' : ' and forces a stand.'}`;
    pushFrame(state, frames);
    dealerTurn(state, random, frames);
  } else if (playerValue > 21) {
    settle(state, 'bust', frames);
  } else if (playerValue === 21 || doubled) {
    dealerTurn(state, random, frames);
  }
}

function consumeFavor(state: MidnightHouseState, kind: MidnightHouseFavorKind): void {
  const favor = FAVOR_BY_KIND[kind];
  transact(
    state,
    `favor-${kind}-${state.actionsUsed}`,
    [changeResource('favor', -favor.cost)],
    [resourceAtLeast('favor', favor.cost)],
  );
  state.favorUsed = true;
  state.favorHand = state.favorHand.filter((candidate) => candidate !== kind);
  state.favorDiscard = [...state.favorDiscard, kind];
}

function dealRound(
  state: MidnightHouseState,
  random: RandomCursor,
  frames: MidnightHouseInternalFrame[],
): void {
  clearToDiscard(state, 'player');
  clearToDiscard(state, 'dealer');
  clearToDiscard(state, 'twist');
  resetHandAbilities(state);
  refreshFavorHand(state, random);
  state.wager = state.level.bet;
  transact(
    state,
    `deal-${state.handsPlayed}`,
    [changeResource('chips', -state.wager)],
    [resourceAtLeast('chips', state.wager)],
  );
  drawTo(state, 'player', random);
  drawTo(state, 'player', random);
  drawTo(state, 'dealer', random);
  drawTo(state, 'dealer', random);
  state.revealDealer = false;
  state.phase = 'player';
  const playerCards = cardsIn(state, 'player');
  const blackjack = midnightHouseHandValue(playerCards) === 21;
  state.message = blackjack
    ? 'Natural Blackjack!'
    : 'Play one House Favor, then hit, stand, or double.';
  pushFrame(state, frames);
  if (blackjack) dealerTurn(state, random, frames);
}

function playableFavorKinds(state: MidnightHouseState): MidnightHouseFavorKind[] {
  if (state.phase !== 'player' || state.favorUsed) return [];
  const favor = state.resources.favor!;
  return state.favorHand.filter((kind) => FAVOR_BY_KIND[kind].cost <= favor);
}

function actionDefinitions(state: MidnightHouseState): ActionDefinition[] {
  if (state.phase === 'settled') {
    return state.resources.chips! >= state.level.bet
      ? [{ id: MIDNIGHT_HOUSE_ACTIONS.deal, params: 'none', text: 'Deal next hand' }]
      : [];
  }
  if (state.phase !== 'player') return [];
  const twistChoices = zoneIds(state, 'twist');
  if (twistChoices.length > 0) {
    return [{
      id: MIDNIGHT_HOUSE_ACTIONS.chooseTwist,
      params: 'index',
      text: 'Choose a Twist of Fate card',
    }];
  }
  if (state.targetingAce) {
    return [{
      id: MIDNIGHT_HOUSE_ACTIONS.chooseAce,
      params: 'index',
      text: 'Choose a card to become a Glass Ace',
    }];
  }

  const actions: ActionDefinition[] = [
    { id: MIDNIGHT_HOUSE_ACTIONS.hit, params: 'none', text: 'Hit' },
    { id: MIDNIGHT_HOUSE_ACTIONS.stand, params: 'none', text: 'Stand' },
  ];
  if (
    zoneIds(state, 'player').length === 2
    && state.resources.chips! >= state.wager
  ) {
    actions.push({ id: MIDNIGHT_HOUSE_ACTIONS.double, params: 'none', text: 'Double' });
  }
  for (const kind of playableFavorKinds(state)) {
    actions.push({
      id: FAVOR_ACTION[kind],
      params: 'none',
      text: FAVOR_BY_KIND[kind].name,
    });
  }
  return actions;
}

function actionKey(action: SubmittedAction): string {
  return JSON.stringify({
    id: action.id,
    ...(action.index === undefined ? {} : { index: action.index }),
  });
}

function applyAction(
  state: MidnightHouseState,
  action: SubmittedAction,
  random: RandomCursor,
  frames: MidnightHouseInternalFrame[],
): void {
  if (action.id === MIDNIGHT_HOUSE_ACTIONS.deal) {
    dealRound(state, random, frames);
    return;
  }
  if (action.id === MIDNIGHT_HOUSE_ACTIONS.hit) {
    const drawn = drawTo(state, 'player', random);
    state.message = `Drew ${drawn.rank}${drawn.suit}.`;
    pushFrame(state, frames);
    resolvePlayerDraw(state, random, frames);
    return;
  }
  if (action.id === MIDNIGHT_HOUSE_ACTIONS.stand) {
    dealerTurn(state, random, frames);
    return;
  }
  if (action.id === MIDNIGHT_HOUSE_ACTIONS.double) {
    transact(
      state,
      `double-${state.actionsUsed}`,
      [changeResource('chips', -state.wager)],
      [resourceAtLeast('chips', state.wager)],
    );
    state.wager *= 2;
    drawTo(state, 'player', random);
    state.message = `Doubled to ${state.wager} chips.`;
    pushFrame(state, frames);
    resolvePlayerDraw(state, random, frames, true);
    return;
  }
  if (action.id === MIDNIGHT_HOUSE_ACTIONS.chooseTwist) {
    const choices = zoneIds(state, 'twist');
    const chosenId = choices[action.index!]!;
    const rejectedId = choices[action.index === 0 ? 1 : 0]!;
    const chosen = state.cards[chosenId]!;
    const rejected = state.cards[rejectedId]!;
    transfer(state, [chosenId], 'twist', 'player');
    transfer(state, [rejectedId], 'twist', 'discard');
    state.message = `Twist chose ${chosen.rank}${chosen.suit}; ${rejected.rank}${rejected.suit} was discarded.`;
    pushFrame(state, frames);
    resolvePlayerDraw(state, random, frames);
    return;
  }
  if (action.id === MIDNIGHT_HOUSE_ACTIONS.chooseAce) {
    const selected = cardsIn(state, 'player')[action.index!]!;
    state.glassAceIndex = action.index!;
    state.targetingAce = false;
    state.message = `${selected.rank}${selected.suit} is treated as an Ace this hand.`;
    pushFrame(state, frames);
    return;
  }

  const kind = ACTION_FAVOR[action.id];
  if (!kind) throw new RangeError('action is not a legal action');
  consumeFavor(state, kind);
  if (kind === 'peek') {
    const hole = cardsIn(state, 'dealer')[1]!;
    state.revealDealer = true;
    state.message = `Candle Peek reveals ${hole.rank}${hole.suit}.`;
  } else if (kind === 'cut') {
    const burned = drawTo(state, 'discard', random);
    state.message = `Cut the Deck burned ${burned.rank}${burned.suit}.`;
  } else if (kind === 'twist') {
    drawTo(state, 'twist', random);
    drawTo(state, 'twist', random);
    state.message = 'Twist of Fate: choose one of the two drawn cards.';
  } else if (kind === 'ace') {
    state.targetingAce = true;
    state.message = 'Glass Ace: select one card in your hand.';
  } else if (kind === 'breath') {
    state.lastBreathArmed = true;
    state.message = 'Last Breath is armed for the next draw that would bust.';
  } else {
    state.crownedHand = true;
    state.message = 'Crowned Hand will enhance a three-or-more-card 21.';
  }
  pushFrame(state, frames);
}

function advance(
  state: MidnightHouseState,
  inputs: readonly SubmittedAction[],
): MidnightHouseState {
  if (inputs.length === 0) return state;
  if (inputs.length !== 1) throw new RangeError('Midnight House accepts one action per tick');
  const action = inputs[0]!;
  if (action.seat !== undefined && action.seat !== 'player') {
    throw new RangeError('Midnight House only accepts the player seat');
  }
  const legal = enumerateActions(presentation(state, false));
  if (!legal.some((candidate) => actionKey(candidate) === actionKey(action))) {
    throw new RangeError('action is not a legal action for this table state');
  }

  const next = cloneState(state);
  const random = randomCursor(next.seed, next.randomDraws);
  const frames: MidnightHouseInternalFrame[] = [];
  next.actionsUsed += 1;
  applyAction(next, action, random, frames);
  next.randomDraws = random.draws();
  next.lastEvents = { frames };
  return next;
}

function presentFrame(
  frame: MidnightHouseInternalFrame,
  redactDealer: boolean,
): MidnightHouseFrame {
  const hideHole = redactDealer && !frame.revealDealer;
  const dealer = frame.dealer.map((card, index) => (
    hideHole && index === 1 ? null : copyCard(card)
  ));
  return {
    resources: { ...frame.resources },
    wager: frame.wager,
    player: frame.player.map(copyCard),
    dealer,
    playerValue: midnightHouseHandValue(frame.player, frame.glassAceIndex),
    dealerValue: hideHole ? null : midnightHouseHandValue(frame.dealer),
    phase: frame.phase,
    revealDealer: frame.revealDealer,
    message: frame.message,
    handsPlayed: frame.handsPlayed,
    wins: frame.wins,
    favorHand: frame.favorHand.map(copyFavor),
    favorUsed: frame.favorUsed,
    glassAceIndex: frame.glassAceIndex,
    targetingAce: frame.targetingAce,
    lastBreathArmed: frame.lastBreathArmed,
    crownedHand: frame.crownedHand,
    twistChoices: frame.twistChoices.map(copyCard),
  };
}

function cardEntry(
  state: MidnightHouseState,
  id: string,
): MidnightHouseZoneEntry {
  const card = state.cards[id]!;
  return { id, rank: card.rank, suit: card.suit, value: card.value };
}

function presentation(
  state: MidnightHouseState,
  redactDealer: boolean,
): MidnightHouseView {
  const player = cardsIn(state, 'player');
  const dealerCards = cardsIn(state, 'dealer');
  const hideHole = redactDealer && !state.revealDealer;
  const dealer = dealerCards.map((card, index) => (
    hideHole && index === 1 ? null : copyCard(card)
  ));
  const twistChoices = cardsIn(state, 'twist');
  const actions = actionDefinitions(state);
  const items = actions[0]?.id === MIDNIGHT_HOUSE_ACTIONS.chooseTwist
    ? twistChoices.map((_card, index) => ({ index }))
    : actions[0]?.id === MIDNIGHT_HOUSE_ACTIONS.chooseAce
      ? player.map((_card, index) => ({ index }))
      : undefined;
  const dealerEntries = zoneIds(state, 'dealer').map((id, index) => (
    hideHole && index === 1
      ? { id: 'dealer-hole', hidden: true }
      : cardEntry(state, id)
  ));
  const favorHand = favorCards(state.favorHand);
  return {
    level: { ...state.level },
    resources: { ...state.resources },
    bet: state.level.bet,
    wager: state.wager,
    player,
    dealer,
    phase: state.phase,
    revealDealer: state.revealDealer,
    message: state.message,
    handsPlayed: state.handsPlayed,
    wins: state.wins,
    favorHand,
    favorUsed: state.favorUsed,
    glassAceIndex: state.glassAceIndex,
    targetingAce: state.targetingAce,
    lastBreathArmed: state.lastBreathArmed,
    crownedHand: state.crownedHand,
    twistChoices,
    playerValue: midnightHouseHandValue(player, state.glassAceIndex),
    dealerValue: hideHole ? null : midnightHouseHandValue(dealerCards),
    dealerUpValue: dealerCards[0]?.value ?? 0,
    blackjack: player.length === 2
      && midnightHouseHandValue(player, state.glassAceIndex) === 21,
    ...(state.lastEvents ? {
      transition: {
        frames: state.lastEvents.frames.map((frame) => presentFrame(frame, redactDealer)),
      },
    } : {}),
    actions,
    hud: {
      actionsUsed: state.actionsUsed,
      ...(items ? { items } : {}),
    },
    zones: {
      deck: { count: zoneIds(state, 'deck').length },
      player: {
        count: player.length,
        ordered: true,
        entries: zoneIds(state, 'player').map((id) => cardEntry(state, id)),
      },
      dealer: {
        count: dealerCards.length,
        ordered: true,
        entries: dealerEntries,
      },
      twist: {
        count: twistChoices.length,
        ordered: true,
        entries: zoneIds(state, 'twist').map((id) => cardEntry(state, id)),
      },
      discard: { count: zoneIds(state, 'discard').length },
      favorHand: {
        count: favorHand.length,
        ordered: true,
        entries: favorHand.map((favor) => ({
          id: `favor-${favor.kind}`,
          kind: favor.kind,
          name: favor.name,
        })),
      },
    },
    status: state.phase === 'settled' && state.resources.chips! < state.level.bet
      ? 'failed'
      : 'playing',
  };
}

export const midnightHouseReducer: TickReducer<
  MidnightHouseLevel,
  MidnightHouseState,
  MidnightHouseView
> = {
  init(level, seed) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new RangeError('seed must be an unsigned 32-bit integer');
    }
    if (!Number.isSafeInteger(level.bet) || level.bet <= 0) {
      throw new RangeError('bet must be a positive safe integer');
    }
    const state: MidnightHouseState = {
      level: { ...level },
      seed,
      randomDraws: 0,
      shoe: 0,
      cards: {},
      zones: initialZones(),
      resources: initializeResourceBalances(RESOURCE_DEFINITIONS),
      wager: level.bet,
      phase: 'settled',
      revealDealer: false,
      message: 'Place your bet.',
      handsPlayed: 0,
      wins: 0,
      favorDeck: [],
      favorHand: [],
      favorDiscard: [],
      favorUsed: false,
      glassAceIndex: null,
      targetingAce: false,
      lastBreathArmed: false,
      crownedHand: false,
      actionsUsed: 0,
    };
    const random = randomCursor(seed, 0);
    addShoe(state, random);
    state.favorDeck = shuffle(
      MIDNIGHT_HOUSE_FAVORS.map(({ kind }) => kind),
      random,
    );
    const frames: MidnightHouseInternalFrame[] = [];
    dealRound(state, random, frames);
    state.randomDraws = random.draws();
    state.lastEvents = undefined;
    return state;
  },
  advance,
  view(state) {
    return presentation(state, false);
  },
  viewFor(state, seat) {
    return presentation(state, seat === 'player');
  },
};

function actionAvailable(view: MidnightHouseView, id: string): boolean {
  return view.actions.some((action) => action.id === id);
}

export function chooseMidnightHouseAction(view: MidnightHouseView): SubmittedAction {
  if (view.phase === 'settled' && actionAvailable(view, MIDNIGHT_HOUSE_ACTIONS.deal)) {
    return { id: MIDNIGHT_HOUSE_ACTIONS.deal };
  }
  if (view.twistChoices.length > 0) {
    const values = view.twistChoices.map((choice) => (
      midnightHouseHandValue([...view.player, choice], view.glassAceIndex)
    ));
    const safe = values
      .map((value, index) => ({ value, index }))
      .filter(({ value }) => value <= 21)
      .sort((left, right) => right.value - left.value || left.index - right.index);
    const fallback = values.indexOf(Math.min(...values));
    return {
      id: MIDNIGHT_HOUSE_ACTIONS.chooseTwist,
      index: safe[0]?.index ?? fallback,
    };
  }
  if (view.targetingAce) {
    const target = view.player
      .map((card, index) => ({ card, index }))
      .filter(({ card }) => card.rank !== 'A')
      .sort((left, right) => right.card.value - left.card.value || left.index - right.index)[0];
    return { id: MIDNIGHT_HOUSE_ACTIONS.chooseAce, index: target?.index ?? 0 };
  }

  const availableFavors = view.favorHand.filter((favor) => actionAvailable(
    view,
    FAVOR_ACTION[favor.kind],
  ));
  const find = (kind: MidnightHouseFavorKind) => (
    availableFavors.find((favor) => favor.kind === kind)
  );
  const value = view.playerValue;
  const favorChoice = value >= 15 && find('breath')
    || (value >= 14 && value <= 17 && find('twist'))
    || (view.dealerUpValue >= 10 && find('peek'))
    || (view.player.length >= 3 && value >= 18 && find('crown'))
    || (value >= 16 && find('ace'));
  if (favorChoice) return { id: FAVOR_ACTION[favorChoice.kind] };

  const soft = isSoft(view.player);
  const canDouble = actionAvailable(view, MIDNIGHT_HOUSE_ACTIONS.double);
  if (
    view.revealDealer
    && view.dealerValue !== null
    && view.dealerValue < value
    && value <= 21
  ) return { id: MIDNIGHT_HOUSE_ACTIONS.stand };
  if (
    canDouble
    && !soft
    && (value === 11 || (value === 10 && view.dealerUpValue <= 9))
  ) return { id: MIDNIGHT_HOUSE_ACTIONS.double };
  if (soft && value <= 17) return { id: MIDNIGHT_HOUSE_ACTIONS.hit };
  if (value >= 17) return { id: MIDNIGHT_HOUSE_ACTIONS.stand };
  if (value <= 11) return { id: MIDNIGHT_HOUSE_ACTIONS.hit };
  if (value >= 12 && value <= 16 && view.dealerUpValue >= 2 && view.dealerUpValue <= 6) {
    return { id: MIDNIGHT_HOUSE_ACTIONS.stand };
  }
  return { id: MIDNIGHT_HOUSE_ACTIONS.hit };
}

export function describeMidnightHouseAction(
  view: MidnightHouseView,
  action: SubmittedAction,
): string {
  if (action.id === MIDNIGHT_HOUSE_ACTIONS.chooseTwist) {
    return `Twist of Fate selects option ${(action.index ?? 0) + 1}`;
  }
  if (action.id === MIDNIGHT_HOUSE_ACTIONS.chooseAce) {
    const card = view.player[action.index ?? 0];
    return `Glass Ace selects ${card?.rank ?? 'card'}${card?.suit ?? ''}`;
  }
  const favorKind = ACTION_FAVOR[action.id];
  if (favorKind) {
    const favor = FAVOR_BY_KIND[favorKind];
    return `Agent played ${favor.name} for ${favor.cost} Favor`;
  }
  const choice = action.id === MIDNIGHT_HOUSE_ACTIONS.double
    ? 'Double'
    : action.id === MIDNIGHT_HOUSE_ACTIONS.stand ? 'Stand' : 'Hit';
  return `${isSoft(view.player) ? 'Soft' : 'Hard'} ${view.playerValue} vs dealer ${view.dealerUpValue} → ${choice}`;
}

export function createMidnightHouseEnvironment(
  seed: number,
  level: MidnightHouseLevel = MIDNIGHT_HOUSE_DEFAULT_LEVEL,
) {
  return new AgentEnvironment({
    reducer: midnightHouseReducer,
    level,
    seed,
    seat: 'player',
    maxTicks: 500,
  });
}
