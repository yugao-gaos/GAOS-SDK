import {
  AgentEnvironment,
  type SubmittedAction,
  type TickReducer,
  type TickView,
} from '../../src/engine/index.js';

export type LastLightTowerKind = 'rifle' | 'floodlight' | 'molotov';
export type LastLightZombieType = 'Shambler' | 'Runner' | 'Brute' | 'Screamer';

export interface LastLightPoint {
  x: number;
  y: number;
}

export interface LastLightTower {
  socket: number;
  kind: LastLightTowerKind;
  cooldown: number;
}

export interface LastLightZombie {
  id: number;
  type: LastLightZombieType;
  route: number;
  segment: number;
  progress: number;
  hp: number;
  maxHp: number;
  speed: number;
}

export interface LastLightZombieView extends LastLightZombie {
  point: LastLightPoint;
  slowed: boolean;
}

export interface LastLightTowerDefinition {
  name: string;
  cost: number;
  range: number;
  description: string;
  stats: string;
}

export interface LastLightBuildOption {
  index: number;
  socket: number;
  kind: LastLightTowerKind;
  cost: number;
  value: number;
  action: SubmittedAction;
}

export interface LastLightBuildEvent {
  socket: number;
  kind: LastLightTowerKind;
  cost: number;
  scrapAfter: number;
  message: string;
}

export interface LastLightAttackTarget {
  zombieId: number;
  point: LastLightPoint;
  damage: number;
  lethal: boolean;
}

export interface LastLightAttackEvent {
  socket: number;
  kind: 'rifle' | 'molotov';
  targets: LastLightAttackTarget[];
}

export interface LastLightDefeatEvent {
  zombieId: number;
  type: LastLightZombieType;
  scrap: number;
}

export interface LastLightBreachEvent {
  zombieId: number;
  type: LastLightZombieType;
  damage: number;
  safehouseHp: number;
}

export interface LastLightTransition {
  tick: number;
  built: LastLightBuildEvent[];
  spawned: LastLightZombie[];
  attacks: LastLightAttackEvent[];
  defeated: LastLightDefeatEvent[];
  breaches: LastLightBreachEvent[];
  waveAdvanced: boolean;
  message: string;
  decision: string;
}

export interface LastLightLevel {
  id: 'last-light';
}

export interface LastLightState {
  seed: number;
  zombies: LastLightZombie[];
  towers: LastLightTower[];
  scrap: number;
  safehouseHp: number;
  wave: number;
  tick: number;
  spawned: number;
  nextZombieId: number;
  message: string;
  decision: string;
  lastEvents: LastLightTransition | null;
}

export interface LastLightView extends TickView {
  seed: number;
  zombies: LastLightZombieView[];
  towers: LastLightTower[];
  scrap: number;
  safehouseHp: number;
  wave: number;
  tick: number;
  spawned: number;
  waveQuota: number;
  gameOver: boolean;
  victory: boolean;
  legalBuilds: LastLightBuildOption[];
  towerTargets: Record<string, LastLightPoint | null>;
  message: string;
  decision: string;
  transition?: LastLightTransition;
}

export const LAST_LIGHT_LEVEL: LastLightLevel = { id: 'last-light' };
export const LAST_LIGHT_ACTIONS = {
  build: 'Action 1',
  hold: 'Action 2',
} as const;
export const LAST_LIGHT_ROUTES: ReadonlyArray<ReadonlyArray<LastLightPoint>> = [
  [{ x: 4, y: 50 }, { x: 28, y: 50 }, { x: 48, y: 24 }, { x: 72, y: 50 }, { x: 96, y: 50 }],
  [{ x: 4, y: 50 }, { x: 28, y: 50 }, { x: 48, y: 77 }, { x: 72, y: 50 }, { x: 96, y: 50 }],
];
export const LAST_LIGHT_SOCKETS: readonly LastLightPoint[] = [
  { x: 20, y: 35 },
  { x: 20, y: 67 },
  { x: 43, y: 48 },
  { x: 55, y: 12 },
  { x: 56, y: 88 },
  { x: 69, y: 31 },
  { x: 69, y: 70 },
  { x: 84, y: 35 },
];
export const LAST_LIGHT_TOWERS: Readonly<Record<
  LastLightTowerKind,
  LastLightTowerDefinition
>> = {
  rifle: {
    name: 'Rifle nest',
    cost: 35,
    range: 20,
    description: 'Fires at the zombie closest to the safehouse.',
    stats: '2 damage · Fast',
  },
  floodlight: {
    name: 'Floodlight',
    cost: 30,
    range: 18,
    description: 'Slows every zombie in its glow to 55% speed. Deals no damage.',
    stats: 'Area slow · No damage',
  },
  molotov: {
    name: 'Molotov post',
    cost: 50,
    range: 23,
    description: 'Scorches up to 3 zombies with each throw.',
    stats: '2 damage · 3 targets',
  },
};

const TOWER_KINDS: readonly LastLightTowerKind[] = ['rifle', 'floodlight', 'molotov'];
const ZOMBIE_ORDER: readonly LastLightZombieType[] = [
  'Shambler',
  'Runner',
  'Shambler',
  'Screamer',
  'Brute',
];
const ZOMBIE_STATS: Readonly<Record<LastLightZombieType, { hp: number; speed: number }>> = {
  Shambler: { hp: 4, speed: 1.15 },
  Runner: { hp: 3, speed: 1.9 },
  Brute: { hp: 10, speed: 0.72 },
  Screamer: { hp: 5, speed: 1.05 },
};

function copyPoint(point: LastLightPoint): LastLightPoint {
  return { x: point.x, y: point.y };
}

function copyTower(tower: LastLightTower): LastLightTower {
  return { ...tower };
}

function copyZombie(zombie: LastLightZombie): LastLightZombie {
  return { ...zombie };
}

function copyTransition(transition: LastLightTransition): LastLightTransition {
  return {
    tick: transition.tick,
    built: transition.built.map((event) => ({ ...event })),
    spawned: transition.spawned.map(copyZombie),
    attacks: transition.attacks.map((attack) => ({
      socket: attack.socket,
      kind: attack.kind,
      targets: attack.targets.map((target) => ({
        ...target,
        point: copyPoint(target.point),
      })),
    })),
    defeated: transition.defeated.map((event) => ({ ...event })),
    breaches: transition.breaches.map((event) => ({ ...event })),
    waveAdvanced: transition.waveAdvanced,
    message: transition.message,
    decision: transition.decision,
  };
}

function cloneState(state: LastLightState): LastLightState {
  return {
    ...state,
    zombies: state.zombies.map(copyZombie),
    towers: state.towers.map(copyTower),
    lastEvents: state.lastEvents ? copyTransition(state.lastEvents) : null,
  };
}

function distanceSquared(left: LastLightPoint, right: LastLightPoint): number {
  const dx = left.x - right.x;
  const dy = left.y - right.y;
  return dx * dx + dy * dy;
}

function withinRange(left: LastLightPoint, right: LastLightPoint, range: number): boolean {
  return distanceSquared(left, right) <= range * range;
}

export function lastLightZombiePoint(zombie: LastLightZombie): LastLightPoint {
  const route = LAST_LIGHT_ROUTES[zombie.route];
  if (!route) throw new RangeError(`unknown Last Light route ${zombie.route}`);
  const from = route[Math.min(zombie.segment, route.length - 1)]!;
  const to = route[Math.min(zombie.segment + 1, route.length - 1)]!;
  const progress = zombie.progress / 100;
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
  };
}

function isZombieSlowed(state: LastLightState, zombie: LastLightZombie): boolean {
  const point = lastLightZombiePoint(zombie);
  return state.towers.some((tower) => (
    tower.kind === 'floodlight'
    && withinRange(point, LAST_LIGHT_SOCKETS[tower.socket]!, LAST_LIGHT_TOWERS.floodlight.range)
  ));
}

function nearestTargets(
  state: LastLightState,
  socket: LastLightPoint,
  range: number,
): Array<{ zombie: LastLightZombie; point: LastLightPoint }> {
  return state.zombies
    .filter(({ hp }) => hp > 0)
    .map((zombie) => ({ zombie, point: lastLightZombiePoint(zombie) }))
    .filter(({ point }) => withinRange(point, socket, range))
    .sort((left, right) => (
      right.zombie.segment * 100 + right.zombie.progress
      - (left.zombie.segment * 100 + left.zombie.progress)
    ));
}

function waveQuota(wave: number): number {
  return 5 + wave * 3;
}

function buildIndex(socket: number, kind: LastLightTowerKind): number {
  return socket * 10 + TOWER_KINDS.indexOf(kind);
}

function legalBuilds(state: LastLightState): LastLightBuildOption[] {
  if (state.safehouseHp <= 0 || (state.wave > 3 && state.zombies.length === 0)) return [];
  return LAST_LIGHT_SOCKETS.flatMap((_socket, socket) => {
    if (state.towers.some((tower) => tower.socket === socket)) return [];
    return TOWER_KINDS.flatMap((kind) => {
      const definition = LAST_LIGHT_TOWERS[kind];
      if (state.scrap < definition.cost) return [];
      const coverage = kind === 'floodlight' ? 12 : kind === 'molotov' ? 18 : 10;
      return [{
        index: buildIndex(socket, kind),
        socket,
        kind,
        cost: definition.cost,
        value: coverage + socket,
        action: { id: LAST_LIGHT_ACTIONS.build, index: buildIndex(socket, kind) },
      }];
    });
  });
}

function actionKey(action: SubmittedAction): string {
  return JSON.stringify({
    id: action.id,
    ...(action.index === undefined ? {} : { index: action.index }),
  });
}

function buildTower(
  state: LastLightState,
  socket: number,
  kind: LastLightTowerKind,
  events: LastLightBuildEvent[],
): boolean {
  const definition = LAST_LIGHT_TOWERS[kind];
  if (state.towers.some((tower) => tower.socket === socket)
    || state.scrap < definition.cost) {
    return false;
  }
  state.scrap -= definition.cost;
  state.towers.push({ socket, kind, cooldown: 0 });
  state.message = kind === 'floodlight'
    ? 'Floodlight online: zombies in its glow move at 55% speed.'
    : `${definition.name} constructed for ${definition.cost} scrap.`;
  events.push({
    socket,
    kind,
    cost: definition.cost,
    scrapAfter: state.scrap,
    message: state.message,
  });
  return true;
}

function spawnZombie(state: LastLightState): LastLightZombie {
  const type = ZOMBIE_ORDER[(state.spawned + state.wave) % ZOMBIE_ORDER.length]!;
  const stats = ZOMBIE_STATS[type];
  const hp = stats.hp + state.wave - 1;
  const zombie: LastLightZombie = {
    id: ++state.nextZombieId,
    type,
    route: state.spawned % 2,
    segment: 0,
    progress: 0,
    hp,
    maxHp: hp,
    speed: stats.speed,
  };
  state.zombies.push(zombie);
  state.spawned += 1;
  return zombie;
}

function runTowers(
  state: LastLightState,
  attacks: LastLightAttackEvent[],
  defeated: LastLightDefeatEvent[],
): void {
  for (const tower of state.towers) {
    if (tower.cooldown > 0) {
      tower.cooldown -= 1;
      continue;
    }
    const socket = LAST_LIGHT_SOCKETS[tower.socket]!;
    const targets = nearestTargets(state, socket, LAST_LIGHT_TOWERS[tower.kind].range);
    if (targets.length === 0 || tower.kind === 'floodlight') continue;
    if (tower.kind === 'rifle') {
      const target = targets[0]!;
      target.zombie.hp -= 2;
      attacks.push({
        socket: tower.socket,
        kind: 'rifle',
        targets: [{
          zombieId: target.zombie.id,
          point: copyPoint(target.point),
          damage: 2,
          lethal: target.zombie.hp <= 0,
        }],
      });
      tower.cooldown = 7;
      state.message = `Rifle nest hit a ${target.zombie.type}.`;
    } else {
      const victims = targets.slice(0, 3);
      const eventTargets = victims.map((target) => {
        target.zombie.hp -= 2;
        return {
          zombieId: target.zombie.id,
          point: copyPoint(target.point),
          damage: 2,
          lethal: target.zombie.hp <= 0,
        };
      });
      attacks.push({ socket: tower.socket, kind: 'molotov', targets: eventTargets });
      tower.cooldown = 15;
      state.message = 'Molotov burst scorched the horde.';
    }
  }
  const removed = state.zombies.filter(({ hp }) => hp <= 0);
  for (const zombie of removed) {
    const reward = zombie.type === 'Brute' ? 8 : 4;
    state.scrap += reward;
    defeated.push({ zombieId: zombie.id, type: zombie.type, scrap: reward });
  }
  state.zombies = state.zombies.filter(({ hp }) => hp > 0);
}

function moveZombies(
  state: LastLightState,
  breaches: LastLightBreachEvent[],
): void {
  for (const zombie of state.zombies) {
    const point = lastLightZombiePoint(zombie);
    const slowed = isZombieSlowed(state, zombie);
    const screamerBoost = state.zombies.some((other) => (
      other.type === 'Screamer'
      && other.id !== zombie.id
      && distanceSquared(lastLightZombiePoint(other), point) < 12 * 12
    ));
    zombie.progress += zombie.speed * (slowed ? 0.55 : 1) * (screamerBoost ? 1.25 : 1);
    if (zombie.progress < 100) continue;
    zombie.segment += 1;
    zombie.progress -= 100;
    if (zombie.segment < LAST_LIGHT_ROUTES[zombie.route]!.length - 1) continue;
    const damage = zombie.type === 'Brute' ? 3 : 1;
    state.safehouseHp -= damage;
    zombie.hp = 0;
    state.message = `${zombie.type} reached the safehouse.`;
    breaches.push({
      zombieId: zombie.id,
      type: zombie.type,
      damage,
      safehouseHp: state.safehouseHp,
    });
  }
  state.zombies = state.zombies.filter(({ hp }) => hp > 0);
}

function advance(state: LastLightState, inputs: readonly SubmittedAction[]): LastLightState {
  if (inputs.length > 1) throw new RangeError('Last Light accepts at most one action per tick');
  const gameOver = state.safehouseHp <= 0;
  const victory = state.wave > 3 && state.zombies.length === 0;
  if (gameOver || victory) throw new RangeError('Last Light is already terminal');
  const input = inputs[0];
  const builds = legalBuilds(state);
  const selected = input?.id === LAST_LIGHT_ACTIONS.build
    ? builds.find(({ action }) => actionKey(action) === actionKey(input))
    : undefined;
  if (input && input.id !== LAST_LIGHT_ACTIONS.hold && !selected) {
    throw new RangeError('action is not a legal action');
  }
  if (input?.id === LAST_LIGHT_ACTIONS.hold
    && actionKey(input) !== actionKey({ id: LAST_LIGHT_ACTIONS.hold })) {
    throw new RangeError('action is not a legal action');
  }

  const next = cloneState(state);
  const built: LastLightBuildEvent[] = [];
  const spawned: LastLightZombie[] = [];
  const attacks: LastLightAttackEvent[] = [];
  const defeated: LastLightDefeatEvent[] = [];
  const breaches: LastLightBreachEvent[] = [];
  if (selected) {
    buildTower(next, selected.socket, selected.kind, built);
    next.decision = `Defense socket ${selected.socket + 1} received ${LAST_LIGHT_TOWERS[selected.kind].name}`;
  }
  next.tick += 1;
  const interval = Math.max(10, 20 - next.wave * 2);
  if (next.wave <= 3
    && next.spawned < waveQuota(next.wave)
    && next.tick % interval === 0) {
    spawned.push(copyZombie(spawnZombie(next)));
  }
  runTowers(next, attacks, defeated);
  moveZombies(next, breaches);
  let waveAdvanced = false;
  if (next.wave <= 3
    && next.spawned >= waveQuota(next.wave)
    && next.zombies.length === 0) {
    next.wave += 1;
    next.spawned = 0;
    next.scrap += 35;
    waveAdvanced = true;
    next.message = next.wave > 3
      ? 'Dawn breaks. The safehouse survived.'
      : `Wave ${next.wave} approaches. +35 scrap.`;
  }
  next.lastEvents = {
    tick: next.tick,
    built,
    spawned,
    attacks,
    defeated,
    breaches,
    waveAdvanced,
    message: next.message,
    decision: next.decision,
  };
  return next;
}

function view(state: LastLightState): LastLightView {
  const gameOver = state.safehouseHp <= 0;
  const victory = state.wave > 3 && state.zombies.length === 0;
  const builds = legalBuilds(state);
  const towerTargets: Record<string, LastLightPoint | null> = {};
  for (const tower of state.towers) {
    if (tower.kind === 'floodlight') {
      towerTargets[String(tower.socket)] = null;
      continue;
    }
    const target = nearestTargets(
      state,
      LAST_LIGHT_SOCKETS[tower.socket]!,
      LAST_LIGHT_TOWERS[tower.kind].range,
    )[0];
    towerTargets[String(tower.socket)] = target ? copyPoint(target.point) : null;
  }
  return {
    seed: state.seed,
    zombies: state.zombies.map((zombie) => ({
      ...copyZombie(zombie),
      point: lastLightZombiePoint(zombie),
      slowed: isZombieSlowed(state, zombie),
    })),
    towers: state.towers.map(copyTower),
    scrap: state.scrap,
    safehouseHp: state.safehouseHp,
    wave: state.wave,
    tick: state.tick,
    spawned: state.spawned,
    waveQuota: waveQuota(state.wave),
    gameOver,
    victory,
    legalBuilds: builds.map((option) => ({
      ...option,
      action: { ...option.action },
    })),
    towerTargets,
    message: state.message,
    decision: state.decision,
    ...(state.lastEvents ? { transition: copyTransition(state.lastEvents) } : {}),
    actions: gameOver || victory
      ? []
      : [
        ...(builds.length > 0
          ? [{ id: LAST_LIGHT_ACTIONS.build, params: 'index' as const, text: 'Build defense' }]
          : []),
        { id: LAST_LIGHT_ACTIONS.hold, params: 'none' as const, text: 'Hold construction' },
      ],
    hud: {
      actionsUsed: state.tick,
      ...(builds.length > 0
        ? { items: builds.map(({ index }) => ({ index })) }
        : {}),
    },
    status: victory ? 'won' : gameOver ? 'failed' : 'playing',
  };
}

export const lastLightReducer: TickReducer<
  LastLightLevel,
  LastLightState,
  LastLightView
> = {
  init(level, seed) {
    if (level.id !== LAST_LIGHT_LEVEL.id) throw new RangeError('unknown Last Light level');
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new RangeError('seed must be an unsigned 32-bit integer');
    }
    return {
      seed,
      zombies: [],
      towers: [],
      scrap: 90,
      safehouseHp: 12,
      wave: 1,
      tick: 0,
      spawned: 0,
      nextZombieId: 0,
      message: 'Build around the road network before the horde reaches the safehouse.',
      decision: 'Human controls construction',
      lastEvents: null,
    };
  },
  advance,
  view,
};

export function chooseLastLightAction(observation: LastLightView): SubmittedAction {
  const open = LAST_LIGHT_SOCKETS
    .map((_socket, index) => index)
    .filter((index) => !observation.towers.some((tower) => tower.socket === index));
  if (open.length === 0) return { id: LAST_LIGHT_ACTIONS.hold };
  const kind: LastLightTowerKind = observation.towers.every(({ kind: placed }) => (
    placed !== 'floodlight'
  )) && observation.scrap >= LAST_LIGHT_TOWERS.floodlight.cost
    ? 'floodlight'
    : observation.scrap >= LAST_LIGHT_TOWERS.molotov.cost && observation.wave >= 2
      ? 'molotov'
      : 'rifle';
  const socket = open[Math.floor(open.length / 2)]!;
  const option = observation.legalBuilds.find((candidate) => (
    candidate.socket === socket && candidate.kind === kind
  ));
  return option ? { ...option.action } : { id: LAST_LIGHT_ACTIONS.hold };
}

export function describeLastLightAction(
  observation: LastLightView,
  action: SubmittedAction,
): string {
  if (action.id === LAST_LIGHT_ACTIONS.hold) return 'No affordable defense placement · holding scrap';
  const option = observation.legalBuilds.find(
    (candidate) => actionKey(candidate.action) === actionKey(action),
  );
  return option
    ? `Builder agent placed ${LAST_LIGHT_TOWERS[option.kind].name} at defense socket ${option.socket + 1}`
    : 'No legal defense placement selected';
}

export function createLastLightEnvironment(seed: number) {
  return new AgentEnvironment({
    reducer: lastLightReducer,
    level: LAST_LIGHT_LEVEL,
    seed,
    maxTicks: 100_000,
  });
}
