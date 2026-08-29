import { manhattanDistance, mulberry32 } from '../../../../../src/engine/index.js';

export type Point = { x: number; y: number };

export function createRng(seed: number) {
  return mulberry32(seed);
}

export function wait(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

export function samePoint(a: Point, b: Point) {
  return a.x === b.x && a.y === b.y;
}

export function manhattan(a: Point, b: Point) {
  return manhattanDistance([a.x, a.y], [b.x, b.y]);
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}
