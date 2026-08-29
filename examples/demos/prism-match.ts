import {
  AgentEnvironment,
  createSquareLayout,
  findPatterns,
  mulberry32,
  type Cell,
  type SubmittedAction,
  type TickReducer,
  type TickView,
  type TokenRef,
} from '../../src/engine/index.js';

export const PRISM_MATCH_WIDTH = 7;
export const PRISM_MATCH_HEIGHT = 7;
export const PRISM_MATCH_GEM_NAMES = ['Ember', 'Tide', 'Bloom', 'Sun', 'Void', 'Frost'] as const;
export const PRISM_MATCH_SWAP_ACTION = 'Action 1';

export interface PrismMatchLevel {
  name: string;
  subtitle: string;
  moves: number;
  locks: readonly number[];
  relic?: { column: number; row: number };
  voids: readonly number[];
}

export const PRISM_MATCH_LEVELS: readonly PrismMatchLevel[] = [
  {
    name: 'Fractured Seal',
    subtitle: 'Break every crystal lock by matching on or beside it.',
    moves: 15,
    locks: [16, 17, 18, 23, 24, 25],
    voids: [],
  },
  {
    name: 'The Sun Key',
    subtitle: 'Clear matches beneath the key to lower it into the exit.',
    moves: 16,
    locks: [31, 32, 33],
    relic: { column: 3, row: 0 },
    voids: [],
  },
  {
    name: 'Void Garden',
    subtitle: 'Clear every corrupted cell before the void spreads again.',
    moves: 18,
    locks: [],
    voids: [0, 1, 7, 41, 47, 48],
  },
];

export interface PrismMatchSwap {
  a: number;
  b: number;
  value: number;
  action: SubmittedAction;
}

export interface PrismMatchCascade {
  matched: readonly number[];
  boardBefore: readonly number[];
  boardAfter: readonly number[];
  fallDistances: Readonly<Record<number, number>>;
  combo: number;
  gained: number;
  score: number;
  locks: Readonly<Record<number, number>>;
  voids: readonly number[];
  relicRow: number;
  relicDelivered: boolean;
}

export interface PrismMatchTransition {
  a: number;
  b: number;
  cascades: readonly PrismMatchCascade[];
  spreadVoidCell?: number;
  reshuffled: boolean;
}

export interface PrismMatchState {
  level: PrismMatchLevel;
  seed: number;
  randomDraws: number;
  board: readonly number[];
  score: number;
  moves: number;
  actionsUsed: number;
  locks: Readonly<Record<number, number>>;
  voids: readonly number[];
  relicRow: number;
  relicDelivered: boolean;
  lastEvents?: PrismMatchTransition;
}

export interface PrismMatchView extends TickView {
  level: PrismMatchLevel;
  board: readonly number[];
  score: number;
  moves: number;
  locks: Readonly<Record<number, number>>;
  voids: readonly number[];
  relicRow: number;
  relicDelivered: boolean;
  objectiveComplete: boolean;
  objectiveProgress: number;
  legalSwaps: readonly PrismMatchSwap[];
  transition?: PrismMatchTransition;
}

interface GemToken extends TokenRef<Cell> {
  index: number;
  color: number;
}

interface RandomCursor {
  next(): number;
  draws(): number;
}

const layout = createSquareLayout({
  width: PRISM_MATCH_WIDTH,
  height: PRISM_MATCH_HEIGHT,
});

function cloneLevel(level: PrismMatchLevel): PrismMatchLevel {
  return {
    name: level.name,
    subtitle: level.subtitle,
    moves: level.moves,
    locks: [...level.locks],
    ...(level.relic ? { relic: { ...level.relic } } : {}),
    voids: [...level.voids],
  };
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

function row(index: number): number {
  return Math.floor(index / PRISM_MATCH_WIDTH);
}

function cell(index: number): Cell {
  return [index % PRISM_MATCH_WIDTH, row(index)];
}

function indexAt([x, y]: Cell): number {
  return y * PRISM_MATCH_WIDTH + x;
}

function adjacent(a: number, b: number): boolean {
  return layout.distance(cell(a), cell(b)) === 1;
}

function neighbors(index: number): number[] {
  return layout.neighbors(cell(index)).map(indexAt);
}

function swapCells(values: number[], a: number, b: number): void {
  [values[a], values[b]] = [values[b]!, values[a]!];
}

function matchCells(values: readonly number[]): Set<number> {
  const occupied = new Map<string, GemToken>();
  values.forEach((color, index) => {
    const at = cell(index);
    occupied.set(layout.key(at), {
      id: `gem-${index}`,
      index,
      cell: at,
      color,
    });
  });
  const patterns = findPatterns(layout, occupied, {
    shape: { kind: 'run', minLength: 3 },
    matches: (left, right) => left.color === right.color,
  });
  return new Set(patterns.flatMap((pattern) => pattern.tokens.map((token) => token.index)));
}

function objectiveComplete(state: PrismMatchState): boolean {
  if (state.level.relic) return state.relicDelivered;
  if (state.level.voids.length > 0) return state.voids.length === 0;
  return Object.values(state.locks).every((hp) => hp <= 0);
}

function objectiveProgress(state: PrismMatchState): number {
  if (state.level.relic) {
    return state.relicDelivered
      ? 100
      : Math.round((state.relicRow / (PRISM_MATCH_HEIGHT - 1)) * 100);
  }
  if (state.level.voids.length > 0) {
    const total = state.level.voids.length;
    return Math.round(((total - Math.min(total, state.voids.length)) / total) * 100);
  }
  const total = state.level.locks.length * 2;
  if (total === 0) return 100;
  const left = Object.values(state.locks).reduce((sum, hp) => sum + Math.max(0, hp), 0);
  return Math.round(((total - left) / total) * 100);
}

function puzzleValue(state: PrismMatchState, found: ReadonlySet<number>): number {
  const affected = new Set([...found, ...[...found].flatMap(neighbors)]);
  const lockBonus = [...affected].reduce(
    (sum, at) => sum + ((state.locks[at] ?? 0) > 0 ? 35 : 0),
    0,
  );
  const voidSet = new Set(state.voids);
  const voidBonus = [...affected].reduce(
    (sum, at) => sum + (voidSet.has(at) ? 30 : 0),
    0,
  );
  const relicBonus = state.level.relic
    && [...found].some((at) => (
      at % PRISM_MATCH_WIDTH === state.level.relic!.column
      && row(at) > state.relicRow
    ))
    ? 55
    : 0;
  return lockBonus + voidBonus + relicBonus;
}

function swapAction(a: number, b: number): SubmittedAction {
  return {
    id: PRISM_MATCH_SWAP_ACTION,
    targets: [
      { container: 'board', coord: cell(a) },
      { container: 'board', coord: cell(b) },
    ],
  };
}

function legalSwaps(state: PrismMatchState, values = state.board): PrismMatchSwap[] {
  const options: PrismMatchSwap[] = [];
  for (let index = 0; index < values.length; index += 1) {
    if ((state.locks[index] ?? 0) > 0) continue;
    for (const next of [index + 1, index + PRISM_MATCH_WIDTH]) {
      if (
        next >= values.length
        || (next === index + 1 && row(next) !== row(index))
        || (state.locks[next] ?? 0) > 0
      ) continue;
      const copy = [...values];
      swapCells(copy, index, next);
      const made = matchCells(copy);
      if (made.size > 0) {
        options.push({
          a: index,
          b: next,
          value: made.size * 10 + puzzleValue(state, made),
          action: swapAction(index, next),
        });
      }
    }
  }
  return options.sort((a, b) => b.value - a.value || a.a - b.a || a.b - b.b);
}

function makeBoard(state: PrismMatchState, random: RandomCursor): number[] {
  const values: number[] = [];
  for (let index = 0; index < PRISM_MATCH_WIDTH * PRISM_MATCH_HEIGHT; index += 1) {
    let gem = Math.floor(random.next() * PRISM_MATCH_GEM_NAMES.length);
    const x = index % PRISM_MATCH_WIDTH;
    const y = row(index);
    while (
      (x >= 2 && values[index - 1] === gem && values[index - 2] === gem)
      || (
        y >= 2
        && values[index - PRISM_MATCH_WIDTH] === gem
        && values[index - PRISM_MATCH_WIDTH * 2] === gem
      )
    ) gem = (gem + 1) % PRISM_MATCH_GEM_NAMES.length;
    values.push(gem);
  }
  if (legalSwaps(state, values).length === 0) {
    values[0] = 0;
    values[1] = 1;
    values[2] = 0;
    values[PRISM_MATCH_WIDTH + 1] = 0;
  }
  return values;
}

function applyPuzzleEffects(state: PrismMatchState, found: ReadonlySet<number>): PrismMatchState {
  const affected = new Set([...found, ...[...found].flatMap(neighbors)]);
  const locks = { ...state.locks };
  for (const at of affected) {
    if ((locks[at] ?? 0) > 0) locks[at] = locks[at]! - 1;
  }

  const voids = state.voids.filter((at) => !affected.has(at));
  let relicRow = state.relicRow;
  let relicDelivered = state.relicDelivered;
  if (state.level.relic && !relicDelivered) {
    const clearsBelow = [...found].some((at) => (
      at % PRISM_MATCH_WIDTH === state.level.relic!.column
      && row(at) > relicRow
    ));
    if (clearsBelow) {
      relicRow += 1;
      if (relicRow >= PRISM_MATCH_HEIGHT - 1) relicDelivered = true;
    }
  }
  return { ...state, locks, voids, relicRow, relicDelivered };
}

function collapseBoard(
  board: readonly number[],
  found: ReadonlySet<number>,
  random: RandomCursor,
): { board: number[]; fallDistances: Record<number, number> } {
  const next = Array<number>(PRISM_MATCH_WIDTH * PRISM_MATCH_HEIGHT).fill(-1);
  const fallDistances: Record<number, number> = {};
  for (let x = 0; x < PRISM_MATCH_WIDTH; x += 1) {
    let destinationRow = PRISM_MATCH_HEIGHT - 1;
    for (let sourceRow = PRISM_MATCH_HEIGHT - 1; sourceRow >= 0; sourceRow -= 1) {
      const source = sourceRow * PRISM_MATCH_WIDTH + x;
      if (found.has(source)) continue;
      const destination = destinationRow * PRISM_MATCH_WIDTH + x;
      next[destination] = board[source]!;
      const distance = destinationRow - sourceRow;
      if (distance > 0) fallDistances[destination] = distance;
      destinationRow -= 1;
    }
    const refillCount = destinationRow + 1;
    while (destinationRow >= 0) {
      const destination = destinationRow * PRISM_MATCH_WIDTH + x;
      next[destination] = Math.floor(random.next() * PRISM_MATCH_GEM_NAMES.length);
      fallDistances[destination] = refillCount;
      destinationRow -= 1;
    }
  }
  return { board: next, fallDistances };
}

function targetIndex(
  target: NonNullable<SubmittedAction['targets']>[number] | undefined,
): number | undefined {
  if (!target || target.container !== 'board' || !Array.isArray(target.coord)) return undefined;
  const [x, y] = target.coord;
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return undefined;
  const at: Cell = [x, y];
  return layout.contains(at) ? indexAt(at) : undefined;
}

function copyTransition(transition: PrismMatchTransition): PrismMatchTransition {
  return {
    a: transition.a,
    b: transition.b,
    cascades: transition.cascades.map((cascade) => ({
      ...cascade,
      matched: [...cascade.matched],
      boardBefore: [...cascade.boardBefore],
      boardAfter: [...cascade.boardAfter],
      fallDistances: { ...cascade.fallDistances },
      locks: { ...cascade.locks },
      voids: [...cascade.voids],
    })),
    ...(transition.spreadVoidCell === undefined
      ? {}
      : { spreadVoidCell: transition.spreadVoidCell }),
    reshuffled: transition.reshuffled,
  };
}

function advance(state: PrismMatchState, inputs: readonly SubmittedAction[]): PrismMatchState {
  if (inputs.length === 0) return state;
  if (inputs.length !== 1) throw new RangeError('Prism Match accepts one action per tick');
  if (objectiveComplete(state) || state.moves <= 0) {
    throw new RangeError('Prism Match is already terminal');
  }
  const action = inputs[0]!;
  const a = targetIndex(action.targets?.[0]);
  const b = targetIndex(action.targets?.[1]);
  if (
    action.id !== PRISM_MATCH_SWAP_ACTION
    || action.targets?.length !== 2
    || a === undefined
    || b === undefined
    || !adjacent(a, b)
  ) {
    throw new RangeError('action is not a legal swap');
  }
  const option = legalSwaps(state).find((candidate) => (
    candidate.a === Math.min(a, b) && candidate.b === Math.max(a, b)
  ));
  if (!option) throw new RangeError('action is not a legal swap');

  const random = randomCursor(state.seed, state.randomDraws);
  let next: PrismMatchState = {
    ...state,
    board: [...state.board],
    moves: state.moves - 1,
    actionsUsed: state.actionsUsed + 1,
    lastEvents: undefined,
  };
  const swapped = [...next.board];
  swapCells(swapped, a, b);
  next = { ...next, board: swapped };

  const cascades: PrismMatchCascade[] = [];
  let combo = 0;
  let found = matchCells(next.board);
  while (found.size > 0) {
    combo += 1;
    const boardBefore = [...next.board];
    next = applyPuzzleEffects(next, found);
    const gained = found.size * 10 * combo;
    next = { ...next, score: next.score + gained };
    const collapsed = collapseBoard(next.board, found, random);
    cascades.push({
      matched: [...found].sort((left, right) => left - right),
      boardBefore,
      boardAfter: [...collapsed.board],
      fallDistances: { ...collapsed.fallDistances },
      combo,
      gained,
      score: next.score,
      locks: { ...next.locks },
      voids: [...next.voids],
      relicRow: next.relicRow,
      relicDelivered: next.relicDelivered,
    });
    next = { ...next, board: collapsed.board };
    found = matchCells(next.board);
  }

  let spreadVoidCell: number | undefined;
  if (!objectiveComplete(next) && next.level.voids.length > 0 && next.voids.length > 0) {
    const currentVoids = new Set(next.voids);
    const frontier = [...currentVoids]
      .sort((left, right) => left - right)
      .flatMap(neighbors)
      .filter((at) => !currentVoids.has(at));
    if (frontier.length > 0) {
      spreadVoidCell = frontier[Math.floor(random.next() * frontier.length)]!;
      next = { ...next, voids: [...next.voids, spreadVoidCell].sort((left, right) => left - right) };
    }
  }

  let reshuffled = false;
  if (!objectiveComplete(next) && next.moves > 0 && legalSwaps(next).length === 0) {
    next = { ...next, board: makeBoard(next, random) };
    reshuffled = true;
  }

  return {
    ...next,
    randomDraws: random.draws(),
    lastEvents: { a, b, cascades, spreadVoidCell, reshuffled },
  };
}

function view(state: PrismMatchState): PrismMatchView {
  const complete = objectiveComplete(state);
  const swaps = complete || state.moves <= 0 ? [] : legalSwaps(state);
  return {
    level: cloneLevel(state.level),
    board: [...state.board],
    score: state.score,
    moves: state.moves,
    locks: { ...state.locks },
    voids: [...state.voids],
    relicRow: state.relicRow,
    relicDelivered: state.relicDelivered,
    objectiveComplete: complete,
    objectiveProgress: objectiveProgress(state),
    legalSwaps: swaps.map((swap) => ({
      ...swap,
      action: {
        ...swap.action,
        targets: swap.action.targets?.map((target) => ({
          container: target.container,
          coord: Array.isArray(target.coord) ? [...target.coord] : target.coord,
        })),
      },
    })),
    ...(state.lastEvents ? { transition: copyTransition(state.lastEvents) } : {}),
    actions: swaps.length > 0
      ? [{
          id: PRISM_MATCH_SWAP_ACTION,
          params: 'targets',
          targetSpecId: 'prism-swap',
          text: 'Swap two adjacent gems',
        }]
      : [],
    targetChoices: {
      'prism-swap': {
        choices: swaps.map((swap) => swap.action.targets!),
        truncated: false,
      },
    },
    status: complete ? 'won' : state.moves <= 0 ? 'failed' : 'playing',
    hud: { actionsUsed: state.actionsUsed },
  };
}

export const prismMatchReducer: TickReducer<
  PrismMatchLevel,
  PrismMatchState,
  PrismMatchView
> = {
  init(level, seed) {
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new RangeError('seed must be an unsigned 32-bit integer');
    }
    const initial: PrismMatchState = {
      level: cloneLevel(level),
      seed,
      randomDraws: 0,
      board: [],
      score: 0,
      moves: level.moves,
      actionsUsed: 0,
      locks: Object.fromEntries(level.locks.map((at) => [at, 2])),
      voids: [...level.voids].sort((left, right) => left - right),
      relicRow: level.relic?.row ?? -1,
      relicDelivered: false,
    };
    const random = randomCursor(seed, 0);
    return {
      ...initial,
      board: makeBoard(initial, random),
      randomDraws: random.draws(),
    };
  },
  advance,
  view,
};

export function createPrismMatchEnvironment(level: PrismMatchLevel, seed: number) {
  return new AgentEnvironment({
    reducer: prismMatchReducer,
    level,
    seed,
    maxTicks: level.moves,
  });
}
