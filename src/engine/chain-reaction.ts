import {
  runSettlementCascade,
  type SettlementResult,
} from './settlement.js';

interface ChainReactionJob<TNode> {
  kind: 'chain_reaction';
  key: string;
  node: TNode;
  priority: number;
  policy: 'once';
}

export interface ChainReactionContext {
  /** Zero-based reaction number across the complete cascade. */
  step: number;
  /** Breadth-first resolution wave within the current tick. */
  wave: number;
}

export interface ChainReactionOptions<TState, TNode> {
  /** Stable identity. A node with the same key reacts at most once. */
  key(node: TNode): string;
  /** Product-derived upper bound on distinct reactions. */
  maxReactions: number;
  /** Apply this node's effect and return newly triggered nodes. */
  react(state: TState, node: TNode, context: ChainReactionContext): Iterable<TNode>;
}

export type ChainReactionResult<TState, TNode> = SettlementResult<
  TState,
  ChainReactionJob<TNode>
>;

/**
 * Resolve a deterministic breadth-first chain reaction within one tick.
 *
 * Newly triggered nodes run in the following wave. Discovery order is retained
 * within a wave, and stable node keys guarantee at-most-once activation.
 */
export function resolveChainReaction<TState, TNode>(
  state: TState,
  seeds: readonly TNode[],
  options: ChainReactionOptions<TState, TNode>,
): ChainReactionResult<TState, TNode> {
  let order = 0;
  const job = (node: TNode): ChainReactionJob<TNode> => ({
    kind: 'chain_reaction',
    key: options.key(node),
    node,
    priority: order++,
    policy: 'once',
  });

  return runSettlementCascade(state, seeds.map(job), (current, context) => {
    for (const triggered of options.react(state, current.node, {
      step: context.step,
      wave: context.wave,
    })) context.enqueue(job(triggered));
  }, { maxSteps: options.maxReactions });
}
