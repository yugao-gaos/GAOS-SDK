import { describe, expect, it, vi } from 'vitest';
import {
  ControlSourceRegistry,
  controlSubjectKey,
  fromAgentDriver,
  fromBehaviorTree,
  fromHumanInput,
  type ControlContext,
  type ControlSource,
} from '../src/control.js';
import {
  type ActionReducer,
  type BehaviorTreeAdapter,
  type SubmittedAction,
  type TickView,
} from '../src/engine/index.js';
import type { AgentDriver } from '../src/agent/index.js';

interface State {
  at: number;
  actionsUsed: number;
}

interface View extends TickView {
  at: number;
}

const actor = { kind: 'actor', actorId: 'guard-17', seat: 'north' } as const;
const move: SubmittedAction = {
  id: 'actor.move',
  seat: 'north',
  payload: { actorId: 'guard-17', direction: 'north' },
};
const observation: View = {
  at: 0,
  actions: [{ id: 'actor.move', params: 'none' }],
  status: 'playing',
  hud: { actionsUsed: 0 },
};
const context: ControlContext<View> = {
  subject: actor,
  observation,
  legalActions: [move],
  tick: 0,
};

const reducer: ActionReducer<null, State, View> = {
  init: () => ({ at: 0, actionsUsed: 0 }),
  apply: (state, action) => {
    if (JSON.stringify(action) !== JSON.stringify(move)) throw new Error('illegal');
    return { at: state.at + 1, actionsUsed: state.actionsUsed + 1 };
  },
  view: (state) => ({
    ...observation,
    at: state.at,
    hud: { actionsUsed: state.actionsUsed },
  }),
};

describe('RFC-019 unified actor control sources', () => {
  it('adapts behavior-tree, human, and agent decisions to one action shape', async () => {
    type Node = { kind: 'leaf' };
    const treeAdapter: BehaviorTreeAdapter<
      ControlContext<View>,
      Node,
      never,
      SubmittedAction
    > = {
      inspect: () => ({ kind: 'leaf' }),
      test: () => false,
      evaluateLeaf: () => move,
    };
    const driver: AgentDriver<View> = {
      id: 'agent',
      label: 'Agent',
      act: async () => ({ action: move }),
    };
    const sources: ControlSource<View>[] = [
      fromBehaviorTree('tree', { kind: 'leaf' }, treeAdapter),
      fromHumanInput('human', async () => move),
      fromAgentDriver(driver),
    ];

    for (const source of sources) {
      const registry = new ControlSourceRegistry([source]);
      registry.bind(actor, source.id);
      const decision = await registry.decide(context);
      expect(decision).toEqual({ action: move });
      expect(reducer.apply(reducer.init(null, 1), decision!.action)).toEqual({
        at: 1,
        actionsUsed: 1,
      });
    }
  });

  it('keeps actor and seat subjects distinct and validates bindings', () => {
    const source = fromHumanInput<View>('human', () => move);
    const registry = new ControlSourceRegistry([source]);
    expect(controlSubjectKey({ kind: 'actor', actorId: 'north' }))
      .not.toBe(controlSubjectKey({ kind: 'seat', seat: 'north' }));
    expect(() => registry.bind(actor, 'missing')).toThrow('unknown control source');
    expect(registry.bind(actor, source.id)).toBe(true);
    expect(registry.bind(actor, source.id)).toBe(false);
    expect(registry.boundSource(actor)).toBe(source);
    expect(registry.unbind(actor)).toBe(true);
    expect(registry.unbind(actor)).toBe(false);
  });

  it('preserves null as no decision instead of inventing wait', async () => {
    const registry = new ControlSourceRegistry([
      fromHumanInput<View>('human', () => null),
    ]);
    registry.bind(actor, 'human');
    await expect(registry.decide(context)).resolves.toBeNull();
  });

  it('aborts and discards an in-flight decision after source replacement', async () => {
    let finish!: (action: SubmittedAction) => void;
    const sawAbort = vi.fn();
    const slow = fromHumanInput<View>('slow', ({ signal }) => new Promise((resolve) => {
      signal?.addEventListener('abort', sawAbort, { once: true });
      finish = resolve;
    }));
    const replacement = fromHumanInput<View>('replacement', () => ({
      id: 'actor.wait',
      seat: 'north',
    }));
    const registry = new ControlSourceRegistry([slow, replacement]);
    registry.bind(actor, 'slow');

    const stale = registry.decide(context);
    registry.bind(actor, 'replacement');
    finish(move);

    await expect(stale).resolves.toBeNull();
    expect(sawAbort).toHaveBeenCalledOnce();
    await expect(registry.decide(context)).resolves.toEqual({
      action: { id: 'actor.wait', seat: 'north' },
    });
  });

  it('discards a source that finishes after external cancellation', async () => {
    const controller = new AbortController();
    let finish!: (action: SubmittedAction) => void;
    const source = fromHumanInput<View>('human', () => new Promise((resolve) => {
      finish = resolve;
    }));
    const registry = new ControlSourceRegistry([source]);
    registry.bind(actor, source.id);
    const pending = registry.decide({ ...context, signal: controller.signal });
    controller.abort();
    finish(move);
    await expect(pending).resolves.toBeNull();
  });

  it('does not invoke a source for an already canceled request', async () => {
    const controller = new AbortController();
    controller.abort();
    const decide = vi.fn(() => move);
    const source = fromHumanInput<View>('human', decide);
    const registry = new ControlSourceRegistry([source]);
    registry.bind(actor, source.id);
    await expect(registry.decide({ ...context, signal: controller.signal }))
      .resolves.toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it('removes bindings and stale decisions when a source is unregistered', async () => {
    let finish!: (action: SubmittedAction) => void;
    const source = fromHumanInput<View>('human', () => new Promise((resolve) => {
      finish = resolve;
    }));
    const registry = new ControlSourceRegistry([source]);
    registry.bind(actor, source.id);
    const pending = registry.decide(context);
    expect(registry.unregister(source.id)).toBe(true);
    finish(move);
    await expect(pending).resolves.toBeNull();
    expect(registry.boundSource(actor)).toBeUndefined();
    await expect(registry.decide(context)).rejects.toThrow('no control source bound');
  });
});
