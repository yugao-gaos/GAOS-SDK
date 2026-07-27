import type { JsonValue } from './protocol.js';

export type PresentationClientMessage<TView, TPatch> =
  | {
    type: 'snapshot';
    transitionRevision: number;
    tick: number;
    view: TView;
    digest?: string;
  }
  | {
    type: 'patch';
    baseTransitionRevision: number;
    transitionRevision: number;
    tick: number;
    patch: TPatch;
    digest?: string;
  }
  | { type: 'acknowledgement'; submissionId: string }
  | { type: 'rejection'; submissionId: string; reason: string }
  | { type: 'digest-mismatch'; expected: string; actual: string };

export interface PresentationClientState<TView> {
  status: 'empty' | 'ready' | 'repair-required';
  transitionRevision?: number;
  tick?: number;
  view?: TView;
  digest?: string;
  acknowledged: readonly string[];
  rejected: Readonly<Record<string, string>>;
}

export interface PresentationClientReducer<TView, TPatch> {
  applyPatch(view: TView, patch: TPatch): TView;
  digest?(view: TView): string;
}

/** Portable snapshot/patch/receipt state machine shared by engine clients. */
export class PresentationClient<TView, TPatch = JsonValue> {
  private value: PresentationClientState<TView> = {
    status: 'empty',
    acknowledged: [],
    rejected: {},
  };

  constructor(private readonly reducer: PresentationClientReducer<TView, TPatch>) {}

  state(): PresentationClientState<TView> {
    return structuredClone(this.value);
  }

  receive(message: PresentationClientMessage<TView, TPatch>): PresentationClientState<TView> {
    if (message.type === 'acknowledgement') {
      if (!this.value.acknowledged.includes(message.submissionId)) {
        this.value = {
          ...this.value,
          acknowledged: [...this.value.acknowledged, message.submissionId],
        };
      }
      return this.state();
    }
    if (message.type === 'rejection') {
      this.value = {
        ...this.value,
        rejected: { ...this.value.rejected, [message.submissionId]: message.reason },
      };
      return this.state();
    }
    if (message.type === 'digest-mismatch') {
      this.value = { ...this.value, status: 'repair-required' };
      return this.state();
    }
    if (message.type === 'snapshot') {
      this.value = {
        ...this.value,
        status: 'ready',
        transitionRevision: message.transitionRevision,
        tick: message.tick,
        view: structuredClone(message.view),
        ...(message.digest === undefined ? {} : { digest: message.digest }),
      };
      return this.state();
    }
    if (this.value.status !== 'ready'
      || this.value.view === undefined
      || this.value.transitionRevision !== message.baseTransitionRevision) {
      this.value = { ...this.value, status: 'repair-required' };
      return this.state();
    }
    const view = this.reducer.applyPatch(structuredClone(this.value.view), message.patch);
    const actual = this.reducer.digest?.(view);
    if (message.digest !== undefined && actual !== undefined && actual !== message.digest) {
      this.value = { ...this.value, status: 'repair-required' };
      return this.state();
    }
    this.value = {
      ...this.value,
      status: 'ready',
      transitionRevision: message.transitionRevision,
      tick: message.tick,
      view: structuredClone(view),
      ...(message.digest === undefined ? {} : { digest: message.digest }),
    };
    return this.state();
  }
}
