import {
  AgentEnvironment,
  type SubmittedAction,
  type TickReducer,
  type TickView,
} from '../../src/engine/index.js';

export type StarlineOwner = 'human' | 'agent' | 'neutral';
export type StarlineFaction = Exclude<StarlineOwner, 'neutral'>;

export interface StarlinePlanet {
  id: string;
  name: string;
  x: number;
  y: number;
  owner: StarlineOwner;
  strength: number;
  production: number;
}

export interface StarlineFleet {
  id: number;
  owner: StarlineFaction;
  from: string;
  to: string;
  strength: number;
  progress: number;
  duration: number;
}

export interface StarlineClash {
  id: number;
  x: number;
  y: number;
  ttl: number;
}

export interface StarlineLaunchOption {
  index: number;
  from: string;
  to: string;
  ratio: 0.4 | 0.5 | 0.55;
  strength: number;
  value: number;
  action: SubmittedAction;
}

export interface StarlineLaunchEvent {
  fleet: StarlineFleet;
  sourceStrength: number;
  message: string;
}

export interface StarlineArrivalEvent {
  fleetId: number;
  owner: StarlineFaction;
  targetId: string;
  beforeOwner: StarlineOwner;
  beforeStrength: number;
  afterOwner: StarlineOwner;
  afterStrength: number;
  captured: boolean;
}

export interface StarlineClashEvent {
  clashId: number;
  fleetIds: [number, number];
  humanStrength: number;
  agentStrength: number;
  survivor: StarlineFaction | null;
  survivorStrength: number;
  message: string;
}

export interface StarlineTransition {
  tick: number;
  produced: string[];
  launches: StarlineLaunchEvent[];
  arrivals: StarlineArrivalEvent[];
  clashes: StarlineClashEvent[];
  message: string;
  decision: string;
}

export interface StarlineLevel {
  id: 'starline-dominion';
}

export interface StarlineState {
  seed: number;
  tick: number;
  planets: StarlinePlanet[];
  fleets: StarlineFleet[];
  clashes: StarlineClash[];
  nextFleetId: number;
  nextClashId: number;
  decision: string;
  eventLog: string;
  lastEvents: StarlineTransition | null;
}

export interface StarlineView extends TickView {
  seed: number;
  tick: number;
  edges: Array<[string, string]>;
  planets: StarlinePlanet[];
  fleets: StarlineFleet[];
  clashes: StarlineClash[];
  winner: StarlineFaction | null;
  legalLaunches: StarlineLaunchOption[];
  decision: string;
  eventLog: string;
  transition?: StarlineTransition;
}

export const STARLINE_LEVEL: StarlineLevel = { id: 'starline-dominion' };
export const STARLINE_ACTIONS = {
  launch: 'Action 1',
  hold: 'Action 2',
} as const;
export const STARLINE_EDGES: ReadonlyArray<readonly [string, string]> = [
  ['home', 'mine'],
  ['home', 'forge'],
  ['mine', 'relay'],
  ['forge', 'relay'],
  ['relay', 'crown'],
  ['relay', 'rift'],
  ['crown', 'enemy'],
  ['rift', 'enemy'],
  ['mine', 'crown'],
  ['forge', 'rift'],
];

const INITIAL_PLANETS: readonly StarlinePlanet[] = [
  { id: 'home', name: 'Aster', x: 10, y: 50, owner: 'human', strength: 34, production: 3 },
  { id: 'mine', name: 'Morrow', x: 29, y: 20, owner: 'neutral', strength: 10, production: 2 },
  { id: 'forge', name: 'Forge', x: 29, y: 78, owner: 'neutral', strength: 12, production: 3 },
  { id: 'relay', name: 'Relay', x: 50, y: 50, owner: 'neutral', strength: 15, production: 4 },
  { id: 'crown', name: 'Crown', x: 69, y: 20, owner: 'neutral', strength: 11, production: 3 },
  { id: 'rift', name: 'Rift', x: 69, y: 78, owner: 'neutral', strength: 9, production: 2 },
  { id: 'enemy', name: 'Nyx', x: 90, y: 50, owner: 'agent', strength: 34, production: 3 },
];
const RATIOS = [0.4, 0.5, 0.55] as const;

function copyPlanet(planet: StarlinePlanet): StarlinePlanet {
  return { ...planet };
}

function copyFleet(fleet: StarlineFleet): StarlineFleet {
  return { ...fleet };
}

function copyClash(clash: StarlineClash): StarlineClash {
  return { ...clash };
}

function cloneState(state: StarlineState): StarlineState {
  return {
    ...state,
    planets: state.planets.map(copyPlanet),
    fleets: state.fleets.map(copyFleet),
    clashes: state.clashes.map(copyClash),
    lastEvents: state.lastEvents ? copyTransition(state.lastEvents) : null,
  };
}

function planet(state: StarlineState, id: string): StarlinePlanet {
  const found = state.planets.find((item) => item.id === id);
  if (!found) throw new RangeError(`unknown Starline Dominion planet ${id}`);
  return found;
}

function connected(left: string, right: string): boolean {
  return STARLINE_EDGES.some(([from, to]) => (
    (from === left && to === right) || (from === right && to === left)
  ));
}

function durationBetween(from: StarlinePlanet, to: StarlinePlanet): number {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return Math.max(18, Math.round(Math.sqrt(dx * dx + dy * dy) * 0.75));
}

function winnerFor(planets: readonly StarlinePlanet[]): StarlineFaction | null {
  const owners = new Set(
    planets.filter(({ owner }) => owner !== 'neutral').map(({ owner }) => owner),
  );
  if (!owners.has('human')) return 'agent';
  if (!owners.has('agent')) return 'human';
  return null;
}

function launchIndex(fromIndex: number, toIndex: number, ratioIndex: number): number {
  return fromIndex * 100 + toIndex * 10 + ratioIndex;
}

function legalLaunchesFor(
  state: StarlineState,
  owner: StarlineFaction,
): StarlineLaunchOption[] {
  return state.planets.flatMap((source, fromIndex) => {
    if (source.owner !== owner || source.strength < 4) return [];
    return state.planets.flatMap((target, toIndex) => {
      if (!connected(source.id, target.id)) return [];
      return RATIOS.map((ratio, ratioIndex) => {
        const strength = Math.max(1, Math.floor(source.strength * ratio));
        const hostileValue = target.owner === owner
          ? -target.strength
          : 100 - target.strength * 3 + target.production * 5;
        return {
          index: launchIndex(fromIndex, toIndex, ratioIndex),
          from: source.id,
          to: target.id,
          ratio,
          strength,
          value: hostileValue + strength,
          action: {
            id: STARLINE_ACTIONS.launch,
            index: launchIndex(fromIndex, toIndex, ratioIndex),
          },
        };
      });
    });
  });
}

function actionKey(action: SubmittedAction): string {
  return JSON.stringify({
    id: action.id,
    ...(action.index === undefined ? {} : { index: action.index }),
  });
}

function fleetPosition(state: StarlineState, fleet: StarlineFleet): {
  x: number;
  y: number;
} {
  const from = planet(state, fleet.from);
  const to = planet(state, fleet.to);
  const progress = Math.min(1, fleet.progress / fleet.duration);
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
  };
}

function edgeProgress(fleet: StarlineFleet): number {
  const edge = STARLINE_EDGES.find(([from, to]) => (
    (from === fleet.from && to === fleet.to)
    || (from === fleet.to && to === fleet.from)
  ));
  if (!edge) throw new RangeError(`fleet ${fleet.id} is not on a declared edge`);
  const progress = Math.min(1, fleet.progress / fleet.duration);
  return fleet.from === edge[0] ? progress : 1 - progress;
}

function launchFleet(
  state: StarlineState,
  fromId: string,
  toId: string,
  owner: StarlineFaction,
  ratio: number,
  launches: StarlineLaunchEvent[],
): StarlineFleet | null {
  const from = planet(state, fromId);
  if (from.owner !== owner || !connected(fromId, toId) || from.strength < 4) return null;
  const strength = Math.max(1, Math.floor(from.strength * ratio));
  from.strength -= strength;
  const to = planet(state, toId);
  const fleet: StarlineFleet = {
    id: ++state.nextFleetId,
    owner,
    from: fromId,
    to: toId,
    strength,
    progress: 0,
    duration: durationBetween(from, to),
  };
  state.fleets.push(fleet);
  const message = `${owner === 'human' ? 'Aster' : 'Nyx'} launched ${strength} ships from ${from.name} to ${to.name}.`;
  state.eventLog = message;
  launches.push({
    fleet: copyFleet(fleet),
    sourceStrength: from.strength,
    message,
  });
  return fleet;
}

function resolveArrival(
  state: StarlineState,
  fleet: StarlineFleet,
): StarlineArrivalEvent {
  const target = planet(state, fleet.to);
  const beforeOwner = target.owner;
  const beforeStrength = target.strength;
  if (target.owner === fleet.owner) {
    target.strength += fleet.strength;
  } else if (fleet.strength > target.strength) {
    target.owner = fleet.owner;
    target.strength = fleet.strength - target.strength;
    state.eventLog = `${target.name} was captured by ${fleet.owner === 'human' ? 'Aster' : 'Nyx'}.`;
  } else {
    target.strength -= fleet.strength;
    if (target.strength === 0) target.owner = 'neutral';
  }
  return {
    fleetId: fleet.id,
    owner: fleet.owner,
    targetId: target.id,
    beforeOwner,
    beforeStrength,
    afterOwner: target.owner,
    afterStrength: target.strength,
    captured: beforeOwner !== target.owner && target.owner === fleet.owner,
  };
}

function resolveFleetBattles(
  state: StarlineState,
  events: StarlineClashEvent[],
): void {
  const removed = new Set<number>();
  const ordered = [...state.fleets].sort((left, right) => left.id - right.id);

  for (let leftIndex = 0; leftIndex < ordered.length; leftIndex += 1) {
    const left = ordered[leftIndex]!;
    if (removed.has(left.id)) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < ordered.length; rightIndex += 1) {
      const right = ordered[rightIndex]!;
      if (removed.has(right.id)
        || left.owner === right.owner
        || left.from !== right.to
        || left.to !== right.from) {
        continue;
      }
      const collisionWindow = 1 / left.duration + 1 / right.duration + 0.002;
      if (Math.abs(edgeProgress(left) - edgeProgress(right)) > collisionWindow) continue;

      const leftPosition = fleetPosition(state, left);
      const rightPosition = fleetPosition(state, right);
      const clash: StarlineClash = {
        id: ++state.nextClashId,
        x: (leftPosition.x + rightPosition.x) / 2,
        y: (leftPosition.y + rightPosition.y) / 2,
        ttl: 7,
      };
      state.clashes.push(clash);
      const leftBefore = left.strength;
      const rightBefore = right.strength;
      let survivor: StarlineFaction | null = null;
      let survivorStrength = 0;
      if (left.strength === right.strength) {
        removed.add(left.id);
        removed.add(right.id);
      } else if (left.strength > right.strength) {
        left.strength -= right.strength;
        removed.add(right.id);
        survivor = left.owner;
        survivorStrength = left.strength;
      } else {
        right.strength -= left.strength;
        removed.add(left.id);
        survivor = right.owner;
        survivorStrength = right.strength;
      }
      const leftLabel = left.owner === 'human' ? 'Aster' : 'Nyx';
      const rightLabel = right.owner === 'human' ? 'Aster' : 'Nyx';
      const result = survivor === null
        ? 'Both fleets were destroyed'
        : `${survivor === left.owner ? leftLabel : rightLabel} survived with ${survivorStrength} ships`;
      const message = `Fleet clash on the ${planet(state, left.from).name}–${planet(state, left.to).name} lane. ${result}.`;
      state.eventLog = message;
      state.decision = 'Opposing fleets met in transit and resolved combat before either could arrive.';
      const humanStrength = left.owner === 'human' ? leftBefore : rightBefore;
      const agentStrength = left.owner === 'agent' ? leftBefore : rightBefore;
      events.push({
        clashId: clash.id,
        fleetIds: [left.id, right.id],
        humanStrength,
        agentStrength,
        survivor,
        survivorStrength,
        message,
      });
      break;
    }
  }
  state.fleets = state.fleets.filter(({ id }) => !removed.has(id));
}

function chooseFactionOrder(
  state: StarlineState,
  owner: StarlineFaction,
): { from: string; to: string; ratio: 0.4 | 0.55 } | null {
  const owned = state.planets
    .filter((item) => item.owner === owner && item.strength >= 9)
    .sort((left, right) => (
      right.strength - left.strength || left.id.localeCompare(right.id)
    ));
  for (const source of owned) {
    const targets = state.planets
      .filter((target) => connected(source.id, target.id) && target.owner !== owner)
      .sort((left, right) => (
        left.strength - right.strength || right.production - left.production
      ));
    const target = targets[0];
    if (!target) continue;
    return {
      from: source.id,
      to: target.id,
      ratio: target.strength < source.strength / 2 ? 0.55 : 0.4,
    };
  }
  return null;
}

function copyTransition(transition: StarlineTransition): StarlineTransition {
  return {
    tick: transition.tick,
    produced: [...transition.produced],
    launches: transition.launches.map((event) => ({
      ...event,
      fleet: copyFleet(event.fleet),
    })),
    arrivals: transition.arrivals.map((event) => ({ ...event })),
    clashes: transition.clashes.map((event) => ({
      ...event,
      fleetIds: [...event.fleetIds] as [number, number],
    })),
    message: transition.message,
    decision: transition.decision,
  };
}

function advance(state: StarlineState, inputs: readonly SubmittedAction[]): StarlineState {
  if (inputs.length > 1) throw new RangeError('Starline Dominion accepts at most one action per tick');
  if (winnerFor(state.planets)) throw new RangeError('Starline Dominion is already terminal');
  const input = inputs[0];
  const launchesBefore = legalLaunchesFor(state, 'human');
  const selected = input?.id === STARLINE_ACTIONS.launch
    ? launchesBefore.find(({ action }) => actionKey(action) === actionKey(input))
    : undefined;
  if (input && input.id !== STARLINE_ACTIONS.hold && !selected) {
    throw new RangeError('action is not a legal action');
  }
  if (input?.id === STARLINE_ACTIONS.hold && actionKey(input) !== actionKey({
    id: STARLINE_ACTIONS.hold,
  })) {
    throw new RangeError('action is not a legal action');
  }

  const next = cloneState(state);
  const launches: StarlineLaunchEvent[] = [];
  const arrivals: StarlineArrivalEvent[] = [];
  const clashEvents: StarlineClashEvent[] = [];
  const produced: string[] = [];

  if (selected) {
    launchFleet(next, selected.from, selected.to, 'human', selected.ratio, launches);
    next.decision = `${planet(next, selected.from).name} fleet committed toward ${planet(next, selected.to).name}`;
  }
  next.tick += 1;
  next.clashes = next.clashes
    .map((clash) => ({ ...clash, ttl: clash.ttl - 1 }))
    .filter(({ ttl }) => ttl > 0);
  if (next.tick % 10 === 0) {
    for (const node of next.planets) {
      if (node.owner === 'neutral') continue;
      node.strength += node.production;
      produced.push(node.id);
    }
  }
  for (const fleet of next.fleets) fleet.progress += 1;
  resolveFleetBattles(next, clashEvents);
  next.fleets = next.fleets.filter((fleet) => {
    if (fleet.progress < fleet.duration) return true;
    arrivals.push(resolveArrival(next, fleet));
    return false;
  });
  if (next.tick % 18 === 0 && !winnerFor(next.planets)) {
    const order = chooseFactionOrder(next, 'agent');
    if (order) {
      launchFleet(next, order.from, order.to, 'agent', order.ratio, launches);
      next.decision = `Nyx agent sends from ${planet(next, order.from).name} toward ${planet(next, order.to).name}`;
    }
  }
  next.lastEvents = {
    tick: next.tick,
    produced,
    launches,
    arrivals,
    clashes: clashEvents,
    message: next.eventLog,
    decision: next.decision,
  };
  return next;
}

function view(state: StarlineState): StarlineView {
  const winner = winnerFor(state.planets);
  const launches = winner ? [] : legalLaunchesFor(state, 'human');
  return {
    seed: state.seed,
    tick: state.tick,
    edges: STARLINE_EDGES.map(([from, to]) => [from, to]),
    planets: state.planets.map(copyPlanet),
    fleets: state.fleets.map(copyFleet),
    clashes: state.clashes.map(copyClash),
    winner,
    legalLaunches: launches.map((option) => ({
      ...option,
      action: { ...option.action },
    })),
    decision: state.decision,
    eventLog: state.eventLog,
    ...(state.lastEvents ? { transition: copyTransition(state.lastEvents) } : {}),
    actions: winner
      ? []
      : [
        ...(launches.length > 0
          ? [{ id: STARLINE_ACTIONS.launch, params: 'index' as const, text: 'Launch fleet' }]
          : []),
        { id: STARLINE_ACTIONS.hold, params: 'none' as const, text: 'Hold orders' },
      ],
    hud: {
      actionsUsed: state.tick,
      ...(launches.length > 0
        ? { items: launches.map(({ index }) => ({ index })) }
        : {}),
    },
    status: winner === 'human' ? 'won' : winner === 'agent' ? 'failed' : 'playing',
  };
}

export const starlineReducer: TickReducer<
  StarlineLevel,
  StarlineState,
  StarlineView
> = {
  init(level, seed) {
    if (level.id !== STARLINE_LEVEL.id) throw new RangeError('unknown Starline Dominion level');
    if (!Number.isInteger(seed) || seed < 0 || seed > 0xffff_ffff) {
      throw new RangeError('seed must be an unsigned 32-bit integer');
    }
    return {
      seed,
      tick: 0,
      planets: INITIAL_PLANETS.map(copyPlanet),
      fleets: [],
      clashes: [],
      nextFleetId: 0,
      nextClashId: 0,
      decision: 'Select an owned planet, then a connected destination.',
      eventLog: 'Real-time simulation ready',
      lastEvents: null,
    };
  },
  advance,
  view,
};

export function chooseStarlineAction(observation: StarlineView): SubmittedAction {
  const owned = observation.planets
    .filter((item) => item.owner === 'human' && item.strength >= 9)
    .sort((left, right) => (
      right.strength - left.strength || left.id.localeCompare(right.id)
    ));
  for (const source of owned) {
    const targets = observation.planets
      .filter((target) => connected(source.id, target.id) && target.owner !== 'human')
      .sort((left, right) => (
        left.strength - right.strength || right.production - left.production
      ));
    const target = targets[0];
    if (!target) continue;
    const ratio = target.strength < source.strength / 2 ? 0.55 : 0.4;
    const option = observation.legalLaunches.find((candidate) => (
      candidate.from === source.id
      && candidate.to === target.id
      && candidate.ratio === ratio
    ));
    if (option) return { ...option.action };
  }
  return { id: STARLINE_ACTIONS.hold };
}

export function describeStarlineAction(
  observation: StarlineView,
  action: SubmittedAction,
): string {
  if (action.id === STARLINE_ACTIONS.hold) return 'No advantageous fleet order · holding';
  const option = observation.legalLaunches.find(
    (candidate) => actionKey(candidate.action) === actionKey(action),
  );
  if (!option) return 'No legal fleet order selected';
  const source = observation.planets.find(({ id }) => id === option.from)!;
  const target = observation.planets.find(({ id }) => id === option.to)!;
  return `Aster agent sends ${option.strength} from ${source.name} toward ${target.name}`;
}

export function createStarlineEnvironment(seed: number) {
  return new AgentEnvironment({
    reducer: starlineReducer,
    level: STARLINE_LEVEL,
    seed,
    maxTicks: 100_000,
  });
}
