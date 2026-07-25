import { describe, expect, it } from 'vitest';
import {
  runSettlementCascade,
  SettlementLimitError,
  type SettlementJob,
} from '../src/engine/index.js';

interface Job extends SettlementJob {
  value?: number;
}

describe('deterministic tick settlement', () => {
  it('resolves consequences in later waves of the same tick', () => {
    const seen: string[] = [];
    const result = runSettlementCascade({ total: 0 }, [
      { kind: 'move', key: 'actor' },
    ], (job, context) => {
      seen.push(`${context.wave}:${job.kind}`);
      context.state.total += 1;
      if (job.kind === 'move') context.enqueue({ kind: 'arrival', key: 'actor' });
      if (job.kind === 'arrival') context.enqueue({ kind: 'switch', key: '3,4' });
    }, { maxSteps: 8 });

    expect(seen).toEqual(['0:move', '1:arrival', '2:switch']);
    expect(result.state.total).toBe(3);
    expect(result.waves).toBe(3);
    expect(result.trace.map(({ parentStep }) => parentStep)).toEqual([undefined, 0, 1]);
  });

  it('orders a wave by priority, kind, and key instead of seed order', () => {
    const resolveOrder = (seeds: Job[]): string[] => {
      const seen: string[] = [];
      runSettlementCascade({}, seeds, (job) => seen.push(`${job.kind}:${job.key}`), { maxSteps: 8 });
      return seen;
    };
    const jobs: Job[] = [
      { kind: 'pickup', key: 'b', priority: 2 },
      { kind: 'arrival', key: 'z', priority: 1 },
      { kind: 'arrival', key: 'a', priority: 1 },
    ];

    expect(resolveOrder(jobs)).toEqual(['arrival:a', 'arrival:z', 'pickup:b']);
    expect(resolveOrder([...jobs].reverse())).toEqual(['arrival:a', 'arrival:z', 'pickup:b']);
  });

  it('coalesces duplicate pending dirty work but permits a later rerun', () => {
    const seen: string[] = [];
    const dirty: Job = { kind: 'doors', key: 'board', policy: 'coalesce' };
    runSettlementCascade({}, [
      { kind: 'source', key: 'a' },
      { kind: 'source', key: 'b' },
    ], (job, context) => {
      seen.push(`${context.wave}:${job.kind}`);
      if (job.kind === 'source') context.enqueue(dirty);
      if (job.kind === 'doors' && context.wave === 1) context.enqueue(dirty);
    }, { maxSteps: 8 });

    expect(seen).toEqual(['0:source', '0:source', '1:doors', '2:doors']);
  });

  it('runs a once identity only once during the complete tick', () => {
    const once: Job = { kind: 'arrival', key: 'actor:7', policy: 'once' };
    const seen: string[] = [];
    runSettlementCascade({}, [once, once], (job, context) => {
      seen.push(job.kind);
      context.enqueue(once);
    }, { maxSteps: 8 });

    expect(seen).toEqual(['arrival']);
  });

  it('returns explicitly deferred jobs without resolving them', () => {
    const seen: string[] = [];
    const result = runSettlementCascade({}, [
      { kind: 'plow', key: 'object' },
    ], (job, context) => {
      seen.push(job.kind);
      context.defer({ kind: 'belt', key: 'object' });
    }, { maxSteps: 8 });

    expect(seen).toEqual(['plow']);
    expect(result.deferred).toEqual([{ kind: 'belt', key: 'object' }]);
  });

  it('stops a non-converging cascade at the configured step limit', () => {
    const cycle: Job = { kind: 'cycle', key: 'same' };
    expect(() => runSettlementCascade({}, [cycle], (_job, context) => {
      context.enqueue(cycle);
    }, { maxSteps: 3 })).toThrowError(SettlementLimitError);

    try {
      runSettlementCascade({}, [cycle], (_job, context) => context.enqueue(cycle), { maxSteps: 3 });
    } catch (error) {
      expect(error).toMatchObject({ maxSteps: 3, nextJob: cycle });
    }
  });

  it('rejects a missing convergence guard', () => {
    expect(() => runSettlementCascade({}, [], () => undefined, { maxSteps: 0 }))
      .toThrowError('settlement maxSteps must be a positive safe integer');
  });
});
