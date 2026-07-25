import type { TickView } from './contracts.js';

export interface TargetSpec<
  TCandidate,
  TView extends TickView<unknown, unknown> = TickView<unknown, unknown>,
> {
  count: number | { min: number; max: number };
  candidates(view: TView): readonly TCandidate[];
  /**
   * When true, a candidate index may appear at most once and choices are
   * combinations in authored candidate order. Otherwise ordered selections
   * with replacement are enumerated.
   */
  distinct?: boolean;
}

export interface TargetEnumerationOptions {
  /** Hard combinatorial guard. Defaults to 10,000 choices. */
  maxChoices?: number;
}

export interface TargetChoiceEnumeration<TCandidate> {
  choices: readonly (readonly TCandidate[])[];
  truncated: boolean;
}

function bounds(count: TargetSpec<unknown>['count']): { min: number; max: number } {
  const min = typeof count === 'number' ? count : count.min;
  const max = typeof count === 'number' ? count : count.max;
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max)
    || min < 0 || max < min) {
    throw new RangeError('target count must use non-negative safe integer bounds');
  }
  return { min, max };
}

/**
 * Enumerate target choices in deterministic candidate order with an explicit
 * truncation result. The first choice beyond `maxChoices` sets `truncated`.
 */
export function enumerateTargetChoices<
  TCandidate,
  TView extends TickView<unknown, unknown>,
>(
  spec: TargetSpec<TCandidate, TView>,
  view: TView,
  options: TargetEnumerationOptions = {},
): TargetChoiceEnumeration<TCandidate> {
  if (!spec || typeof spec.candidates !== 'function') {
    throw new TypeError('target spec requires a candidates function');
  }
  const { min, max } = bounds(spec.count);
  const maxChoices = options.maxChoices ?? 10_000;
  if (!Number.isSafeInteger(maxChoices) || maxChoices < 1) {
    throw new RangeError('maxChoices must be a positive safe integer');
  }
  const candidates = spec.candidates(view);
  if (!Array.isArray(candidates)) throw new TypeError('target candidates must be an array');
  const choices: TCandidate[][] = [];
  let truncated = false;

  const admit = (choice: readonly TCandidate[]): boolean => {
    if (choices.length >= maxChoices) {
      truncated = true;
      return false;
    }
    choices.push([...choice]);
    return true;
  };

  const generateDistinct = (
    size: number,
    start: number,
    selected: TCandidate[],
  ): boolean => {
    if (selected.length === size) return admit(selected);
    const remaining = size - selected.length;
    for (let index = start; index <= candidates.length - remaining; index++) {
      selected.push(candidates[index]!);
      if (!generateDistinct(size, index + 1, selected) && truncated) return false;
      selected.pop();
    }
    return true;
  };

  const generateOrdered = (size: number, selected: TCandidate[]): boolean => {
    if (selected.length === size) return admit(selected);
    for (const candidate of candidates) {
      selected.push(candidate);
      if (!generateOrdered(size, selected) && truncated) return false;
      selected.pop();
    }
    return true;
  };

  for (let size = min; size <= max; size++) {
    if (spec.distinct && size > candidates.length) continue;
    const completed = spec.distinct
      ? generateDistinct(size, 0, [])
      : generateOrdered(size, []);
    if (!completed && truncated) break;
  }
  return { choices, truncated };
}
