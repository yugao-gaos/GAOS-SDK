import { describe, expect, it } from 'vitest';
import {
  advancePathProjectiles,
  resolveFlightPasses,
  type ProjectileAction,
} from '../src/engine/index.js';

interface Projectile {
  id: string;
  path: number[];
  step: number;
}

describe('projectile mechanisms', () => {
  it('advances, lands, and consumes a snapshot of active projectiles', () => {
    const active: Projectile[] = [
      { id: 'move', path: [1, 2], step: 0 },
      { id: 'land', path: [], step: 0 },
      { id: 'consume', path: [9], step: 0 },
    ];
    const events: string[] = [];
    const remove = (projectile: Projectile): void => {
      active.splice(active.indexOf(projectile), 1);
    };
    const action = (projectile: Projectile): ProjectileAction => (
      projectile.id === 'consume' ? 'consume' : 'advance'
    );

    expect(advancePathProjectiles(active, {
      next: (projectile) => projectile.path[projectile.step],
      collide: action,
      advance: (projectile, next) => {
        projectile.step += 1;
        events.push(`move:${projectile.id}:${next}`);
      },
      land: (projectile) => {
        remove(projectile);
        events.push(`land:${projectile.id}`);
      },
      consume: (projectile) => {
        remove(projectile);
        events.push(`consume:${projectile.id}`);
      },
    })).toBe(true);

    expect(events).toEqual(['move:move:1', 'land:land', 'consume:consume']);
    expect(active.map(({ id }) => id)).toEqual(['move']);
  });

  it('runs relay hooks between same-tick flight passes', () => {
    const state = { remaining: 3, headings: [] as number[] };
    const result = resolveFlightPasses(state, {
      maxPasses: 8,
      active: ({ remaining }) => remaining > 0,
      beforePass: (world, pass) => world.headings.push(pass),
      advancePass: (world) => { world.remaining -= 1; },
    });

    expect(result).toMatchObject({ passes: 3, completed: true });
    expect(state.headings).toEqual([0, 1, 2]);
  });

  it('retains authoritative airborne state at the pass limit', () => {
    const state = { remaining: 5 };
    const result = resolveFlightPasses(state, {
      maxPasses: 2,
      active: ({ remaining }) => remaining > 0,
      advancePass: (world) => { world.remaining -= 1; },
    });

    expect(result).toEqual({ state: { remaining: 3 }, passes: 2, completed: false });
  });
});
