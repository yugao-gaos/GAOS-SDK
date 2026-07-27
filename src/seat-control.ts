import { canonicalJson, type JsonValue } from './protocol.js';
import { bytesToHex, sha256 } from './engine/commitment.js';
import type { SubmissionSigningTier } from './engine/submission-signatures.js';

export type SeatControllerKind = 'human' | 'agent' | 'service';

export interface SeatController {
  controllerId: string;
  kind: SeatControllerKind;
  publicKey?: string;
  signingTier?: SubmissionSigningTier;
}

export type SeatControlReason =
  | 'genesis'
  | 'released'
  | 'disconnected'
  | 'reconnected'
  | 'substituted'
  | 'transferred'
  | 'revoked';

export interface SeatControlEpoch {
  seat: string;
  epoch: number;
  status: 'occupied' | 'vacant';
  controller?: SeatController;
  effectiveTransitionRevision: number;
  reason: SeatControlReason;
  authorization: 'genesis' | 'controller-handoff' | 'host-policy';
  authorizationEvidence?: SeatControlAuthorization;
  previousEpochDigest?: string;
  previousChainHead?: string;
  digest: string;
}

export interface SeatControlChange {
  seat: string;
  status: 'occupied' | 'vacant';
  controller?: SeatController;
  reason: Exclude<SeatControlReason, 'genesis' | 'reconnected'>;
  previousChainHead?: string;
}

export type SeatControlAuthorization =
  | {
    mode: 'controller-handoff';
    outgoingSignatures: Readonly<Record<string, string>>;
    incomingSignatures: Readonly<Record<string, string>>;
  }
  | {
    mode: 'host-policy';
    policy: string;
  };

export interface SeatControlCheckpoint {
  format: 'gaos.seat-control';
  formatVersion: '1.0';
  sessionId: string;
  transitionRevision: number;
  seats: readonly string[];
  epochs: readonly SeatControlEpoch[];
  prepared?: readonly SeatControlPreparedCheckpoint[];
}

export interface SeatControlPreparedCheckpoint {
  baseTransitionRevision: number;
  nextTransitionRevision: number;
  epochs: readonly SeatControlEpoch[];
}

const preparedSeatControl: unique symbol = Symbol('gaos.prepared-seat-control');

export interface PreparedSeatControl {
  baseTransitionRevision: number;
  nextTransitionRevision: number;
  epochs: readonly SeatControlEpoch[];
  readonly [preparedSeatControl]: unknown;
}

interface PreparedState {
  owner: object;
  completed: boolean;
  next: Map<string, SeatControlEpoch[]>;
}

const encoder = new TextEncoder();

function epochDigest(epoch: Omit<SeatControlEpoch, 'digest'>): string {
  return bytesToHex(sha256(encoder.encode(canonicalJson(epoch as unknown as JsonValue))));
}

function assertController(controller: SeatController | undefined): asserts controller is SeatController {
  if (controller === undefined
    || typeof controller.controllerId !== 'string'
    || controller.controllerId.length === 0) {
    throw new TypeError('occupied seat control requires a non-empty controllerId');
  }
  if (!['human', 'agent', 'service'].includes(controller.kind)) {
    throw new TypeError('controller.kind must be human, agent, or service');
  }
}

function copyHistory(source: Map<string, SeatControlEpoch[]>): Map<string, SeatControlEpoch[]> {
  return new Map([...source].map(([seat, epochs]) => [seat, structuredClone(epochs)]));
}

/**
 * Auditable authority schedule for fixed logical seats. It is independent of
 * transport connections and gameplay participation.
 */
export class SeatControlLedger {
  private revision = 0;
  private history = new Map<string, SeatControlEpoch[]>();
  private readonly owner = {};
  private readonly prepared = new WeakMap<PreparedSeatControl, PreparedState>();
  private readonly activePrepared = new Set<PreparedSeatControl>();

  constructor(
    private readonly sessionId: string,
    genesis: Readonly<Record<string, SeatController | null>>,
  ) {
    if (typeof sessionId !== 'string' || sessionId.length === 0) {
      throw new TypeError('sessionId must be a non-empty string');
    }
    const seats = Object.keys(genesis).sort();
    if (seats.length === 0 || seats.some((seat) => seat.length === 0)) {
      throw new TypeError('genesis must declare at least one non-empty logical seat');
    }
    for (const seat of seats) {
      const controller = genesis[seat];
      if (controller !== null) assertController(controller);
      const base = {
        seat,
        epoch: 0,
        status: controller === null ? 'vacant' as const : 'occupied' as const,
        ...(controller === null ? {} : { controller: structuredClone(controller) }),
        effectiveTransitionRevision: 0,
        reason: 'genesis' as const,
        authorization: 'genesis' as const,
      };
      this.history.set(seat, [{ ...base, digest: epochDigest(base) }]);
    }
  }

  seats(): readonly string[] {
    return [...this.history.keys()];
  }

  transitionRevision(): number {
    return this.revision;
  }

  current(seat: string): SeatControlEpoch {
    const epochs = this.history.get(seat);
    if (epochs === undefined) throw new RangeError(`unknown logical seat ${seat}`);
    return structuredClone(epochs[epochs.length - 1]!);
  }

  epochAt(seat: string, transitionRevision: number): SeatControlEpoch {
    if (!Number.isSafeInteger(transitionRevision) || transitionRevision < 0
      || transitionRevision > this.revision) {
      throw new RangeError('transitionRevision must identify committed control history');
    }
    const epochs = this.history.get(seat);
    if (epochs === undefined) throw new RangeError(`unknown logical seat ${seat}`);
    const epoch = [...epochs].reverse().find(
      (candidate) => candidate.effectiveTransitionRevision <= transitionRevision,
    );
    if (epoch === undefined) throw new TypeError(`no controller epoch for logical seat ${seat}`);
    return structuredClone(epoch);
  }

  /**
   * A connection reconnect with unchanged controller/key resumes the current
   * epoch and intentionally creates no evidence transition.
   */
  reconnect(seat: string, controller: SeatController): SeatControlEpoch {
    const current = this.current(seat);
    if (current.status !== 'occupied'
      || canonicalJson(current.controller) !== canonicalJson(controller)) {
      throw new TypeError('reconnect requires the active controller and key');
    }
    return current;
  }

  authorize(
    seat: string,
    epoch: number,
    controllerId?: string,
    transitionRevision = this.revision,
  ): SeatControlEpoch {
    const active = this.epochAt(seat, transitionRevision);
    if (active.status !== 'occupied') throw new TypeError(`logical seat ${seat} is vacant`);
    if (active.epoch !== epoch) {
      throw new TypeError(`controller epoch ${epoch} is inactive for logical seat ${seat}`);
    }
    if (controllerId !== undefined && active.controller!.controllerId !== controllerId) {
      throw new TypeError(`controller ${controllerId} is inactive for logical seat ${seat}`);
    }
    return active;
  }

  prepareSeatControl(
    changes: readonly SeatControlChange[],
    authorization: SeatControlAuthorization,
  ): PreparedSeatControl {
    if (this.activePrepared.size !== 0) {
      throw new TypeError('another seat-control transition is already prepared');
    }
    if (changes.length === 0) throw new TypeError('seat-control transition must contain changes');
    const seen = new Set<string>();
    const nextRevision = this.revision + 1;
    const next = copyHistory(this.history);
    const epochs: SeatControlEpoch[] = [];
    for (const change of changes) {
      if (seen.has(change.seat)) throw new TypeError(`duplicate seat-control change for ${change.seat}`);
      seen.add(change.seat);
      const seatHistory = next.get(change.seat);
      if (seatHistory === undefined) throw new RangeError(`unknown logical seat ${change.seat}`);
      if (change.status === 'occupied') assertController(change.controller);
      if (change.status === 'vacant' && change.controller !== undefined) {
        throw new TypeError('vacant seat-control change must not include a controller');
      }
      const previous = seatHistory[seatHistory.length - 1]!;
      if (authorization.mode === 'controller-handoff') {
        if (previous.status !== 'occupied'
          || !authorization.outgoingSignatures[change.seat]) {
          throw new TypeError(`controller handoff requires outgoing signature for ${change.seat}`);
        }
        if (change.status === 'occupied' && !authorization.incomingSignatures[change.seat]) {
          throw new TypeError(`controller handoff requires incoming signature for ${change.seat}`);
        }
      } else if (authorization.policy.length === 0) {
        throw new TypeError('host-policy authorization requires a non-empty policy');
      }
      const base = {
        seat: change.seat,
        epoch: previous.epoch + 1,
        status: change.status,
        ...(change.controller === undefined ? {} : { controller: structuredClone(change.controller) }),
        effectiveTransitionRevision: nextRevision,
        reason: change.reason,
        authorization: authorization.mode,
        authorizationEvidence: structuredClone(authorization),
        previousEpochDigest: previous.digest,
        ...(change.previousChainHead === undefined
          ? {}
          : { previousChainHead: change.previousChainHead }),
      };
      const epoch = { ...base, digest: epochDigest(base) };
      seatHistory.push(epoch);
      epochs.push(structuredClone(epoch));
    }
    const result: PreparedSeatControl = {
      baseTransitionRevision: this.revision,
      nextTransitionRevision: nextRevision,
      epochs,
      [preparedSeatControl]: undefined,
    };
    this.prepared.set(result, { owner: this.owner, completed: false, next });
    this.activePrepared.add(result);
    return result;
  }

  commit(prepared: PreparedSeatControl): void {
    const state = this.prepared.get(prepared);
    if (state === undefined || state.owner !== this.owner) {
      throw new TypeError('foreign prepared seat-control transition');
    }
    if (state.completed) throw new TypeError('prepared seat-control transition already completed');
    if (prepared.baseTransitionRevision !== this.revision) {
      throw new TypeError('stale prepared seat-control transition');
    }
    state.completed = true;
    this.activePrepared.delete(prepared);
    this.history = state.next;
    this.revision = prepared.nextTransitionRevision;
  }

  abort(prepared: PreparedSeatControl): void {
    const state = this.prepared.get(prepared);
    if (state === undefined || state.owner !== this.owner) {
      throw new TypeError('foreign prepared seat-control transition');
    }
    if (state.completed) throw new TypeError('prepared seat-control transition already completed');
    state.completed = true;
    this.activePrepared.delete(prepared);
  }

  preparedTransitions(): readonly PreparedSeatControl[] {
    return [...this.activePrepared];
  }

  checkpoint(): SeatControlCheckpoint {
    return {
      format: 'gaos.seat-control',
      formatVersion: '1.0',
      sessionId: this.sessionId,
      transitionRevision: this.revision,
      seats: this.seats(),
      epochs: [...this.history.values()].flatMap((epochs) => structuredClone(epochs)),
      ...(this.activePrepared.size === 0
        ? {}
        : {
          prepared: [...this.activePrepared].map((prepared) => ({
            baseTransitionRevision: prepared.baseTransitionRevision,
            nextTransitionRevision: prepared.nextTransitionRevision,
            epochs: structuredClone(prepared.epochs),
          })),
        }),
    };
  }

  static rehydrate(checkpoint: SeatControlCheckpoint): SeatControlLedger {
    if (checkpoint.format !== 'gaos.seat-control' || checkpoint.formatVersion !== '1.0') {
      throw new TypeError('unsupported seat-control checkpoint');
    }
    if (typeof checkpoint.sessionId !== 'string' || checkpoint.sessionId.length === 0) {
      throw new TypeError('checkpoint sessionId must be a non-empty string');
    }
    if (!Array.isArray(checkpoint.seats) || checkpoint.seats.length === 0
      || checkpoint.seats.some((seat) => typeof seat !== 'string' || seat.length === 0)) {
      throw new TypeError('checkpoint must declare non-empty logical seats');
    }
    if (new Set(checkpoint.seats).size !== checkpoint.seats.length) {
      throw new TypeError('checkpoint contains duplicate logical seat declarations');
    }
    if (!Array.isArray(checkpoint.epochs)) {
      throw new TypeError('checkpoint epochs must be an array');
    }
    const declaredSeats = new Set(checkpoint.seats);
    const undeclared = checkpoint.epochs.find((epoch) => !declaredSeats.has(epoch.seat));
    if (undeclared !== undefined) {
      throw new TypeError(`epoch belongs to undeclared logical seat ${undeclared.seat}`);
    }
    const genesis: Record<string, SeatController | null> = {};
    for (const seat of checkpoint.seats) genesis[seat] = null;
    const ledger = new SeatControlLedger(checkpoint.sessionId, genesis);
    const rebuilt = new Map<string, SeatControlEpoch[]>();
    for (const seat of checkpoint.seats) {
      const epochs = checkpoint.epochs
        .filter((epoch) => epoch.seat === seat)
        .sort((left, right) => left.epoch - right.epoch);
      if (epochs.length === 0) throw new TypeError(`missing epoch history for ${seat}`);
      for (const [index, epoch] of epochs.entries()) {
        if (epoch.epoch !== index) throw new TypeError(`non-consecutive epochs for ${seat}`);
        if (!Number.isSafeInteger(epoch.effectiveTransitionRevision)
          || epoch.effectiveTransitionRevision < 0) {
          throw new TypeError(`invalid effective transition revision for ${seat}`);
        }
        if (index === 0) {
          if (epoch.reason !== 'genesis'
            || epoch.authorization !== 'genesis'
            || epoch.effectiveTransitionRevision !== 0
            || epoch.previousEpochDigest !== undefined
            || epoch.previousChainHead !== undefined
            || epoch.authorizationEvidence !== undefined) {
            throw new TypeError(`invalid genesis epoch for ${seat}`);
          }
        } else {
          const previous = epochs[index - 1]!;
          if (epoch.reason === 'genesis' || epoch.reason === 'reconnected'
            || epoch.authorization === 'genesis'
            || epoch.effectiveTransitionRevision <= previous.effectiveTransitionRevision) {
            throw new TypeError(`invalid epoch ordering for ${seat}`);
          }
          if (epoch.authorizationEvidence?.mode !== epoch.authorization) {
            throw new TypeError(`conflicting authorization evidence for ${seat}`);
          }
          if (epoch.authorization === 'controller-handoff') {
            const authorization = epoch.authorizationEvidence;
            if (authorization?.mode !== 'controller-handoff'
              || !authorization.outgoingSignatures[seat]
              || (epoch.status === 'occupied'
                && !authorization.incomingSignatures[seat])) {
              throw new TypeError(`incomplete controller-handoff authorization for ${seat}`);
            }
            if (epoch.previousChainHead === undefined) {
              throw new TypeError(`controller handoff is missing previous chain head for ${seat}`);
            }
          } else {
            const authorization = epoch.authorizationEvidence;
            if (authorization?.mode !== 'host-policy'
              || typeof authorization.policy !== 'string'
              || authorization.policy.length === 0) {
              throw new TypeError(`invalid host-policy authorization for ${seat}`);
            }
          }
        }
        if (epoch.status === 'occupied') {
          assertController(epoch.controller);
        } else if (epoch.status === 'vacant') {
          if (epoch.controller !== undefined) {
            throw new TypeError(`vacant epoch includes a controller for ${seat}`);
          }
        } else {
          throw new TypeError(`invalid epoch status for ${seat}`);
        }
        const { digest, ...base } = epoch;
        if (digest !== epochDigest(base)) throw new TypeError(`invalid epoch digest for ${seat}`);
        if (index > 0 && epoch.previousEpochDigest !== epochs[index - 1]!.digest) {
          throw new TypeError(`conflicting epoch continuity for ${seat}`);
        }
      }
      rebuilt.set(seat, structuredClone(epochs));
    }
    if (!Number.isSafeInteger(checkpoint.transitionRevision)
      || checkpoint.transitionRevision < 0
      || [...rebuilt.values()].flat().some(
        (epoch) => epoch.effectiveTransitionRevision > checkpoint.transitionRevision,
      )) {
      throw new TypeError('invalid seat-control transition revision');
    }
    const committedRevisions = new Set(
      [...rebuilt.values()].flat()
        .map((epoch) => epoch.effectiveTransitionRevision)
        .filter((revision) => revision > 0),
    );
    for (let revision = 1; revision <= checkpoint.transitionRevision; revision += 1) {
      if (!committedRevisions.has(revision)) {
        throw new TypeError(`missing committed seat-control transition revision ${revision}`);
      }
      const atRevision = [...rebuilt.values()].flat().filter(
        (epoch) => epoch.effectiveTransitionRevision === revision,
      );
      const authorization = canonicalJson(
        atRevision[0]!.authorizationEvidence as unknown as JsonValue,
      );
      if (atRevision.some((epoch) =>
        epoch.authorization !== atRevision[0]!.authorization
        || canonicalJson(epoch.authorizationEvidence as unknown as JsonValue) !== authorization)) {
        throw new TypeError(`conflicting atomic authorization at revision ${revision}`);
      }
    }
    ledger.history = rebuilt;
    ledger.revision = checkpoint.transitionRevision;
    if (checkpoint.prepared !== undefined) {
      if (!Array.isArray(checkpoint.prepared) || checkpoint.prepared.length > 1) {
        throw new TypeError('checkpoint may contain at most one prepared transition');
      }
      for (const pending of checkpoint.prepared) {
        if (pending.baseTransitionRevision !== ledger.revision
          || pending.nextTransitionRevision !== ledger.revision + 1
          || pending.epochs.length === 0) {
          throw new TypeError('invalid prepared seat-control transition');
        }
        const next = copyHistory(rebuilt);
        const seen = new Set<string>();
        for (const epoch of pending.epochs) {
          if (seen.has(epoch.seat)) {
            throw new TypeError(`duplicate prepared epoch for ${epoch.seat}`);
          }
          seen.add(epoch.seat);
          const history = next.get(epoch.seat);
          const previous = history?.[history.length - 1];
          if (history === undefined
            || previous === undefined
            || epoch.epoch !== previous.epoch + 1
            || epoch.effectiveTransitionRevision !== pending.nextTransitionRevision
            || epoch.previousEpochDigest !== previous.digest) {
            throw new TypeError(`invalid prepared epoch continuity for ${epoch.seat}`);
          }
          if (epoch.reason === 'genesis' || epoch.reason === 'reconnected'
            || epoch.authorization === 'genesis'
            || epoch.authorizationEvidence?.mode !== epoch.authorization) {
            throw new TypeError(`invalid prepared epoch metadata for ${epoch.seat}`);
          }
          if (epoch.status === 'occupied') {
            assertController(epoch.controller);
          } else if (epoch.status === 'vacant') {
            if (epoch.controller !== undefined) {
              throw new TypeError(`vacant prepared epoch includes a controller for ${epoch.seat}`);
            }
          } else {
            throw new TypeError(`invalid prepared epoch status for ${epoch.seat}`);
          }
          if (epoch.authorization === 'controller-handoff') {
            const authorization = epoch.authorizationEvidence;
            if (authorization?.mode !== 'controller-handoff'
              || !authorization.outgoingSignatures[epoch.seat]
              || (epoch.status === 'occupied'
                && !authorization.incomingSignatures[epoch.seat])
              || epoch.previousChainHead === undefined) {
              throw new TypeError(`incomplete prepared handoff for ${epoch.seat}`);
            }
          } else {
            const authorization = epoch.authorizationEvidence;
            if (authorization?.mode !== 'host-policy'
              || typeof authorization.policy !== 'string'
              || authorization.policy.length === 0) {
              throw new TypeError(`invalid prepared host policy for ${epoch.seat}`);
            }
          }
          const { digest, ...base } = epoch;
          if (digest !== epochDigest(base)) {
            throw new TypeError(`invalid prepared epoch digest for ${epoch.seat}`);
          }
          history.push(structuredClone(epoch));
        }
        const preparedAuthorization = canonicalJson(
          pending.epochs[0]!.authorizationEvidence as unknown as JsonValue,
        );
        if (pending.epochs.some((epoch: SeatControlEpoch) =>
          epoch.authorization !== pending.epochs[0]!.authorization
          || canonicalJson(epoch.authorizationEvidence as unknown as JsonValue)
            !== preparedAuthorization)) {
          throw new TypeError('conflicting atomic authorization in prepared transition');
        }
        const restored: PreparedSeatControl = {
          baseTransitionRevision: pending.baseTransitionRevision,
          nextTransitionRevision: pending.nextTransitionRevision,
          epochs: structuredClone(pending.epochs),
          [preparedSeatControl]: undefined,
        };
        ledger.prepared.set(restored, {
          owner: ledger.owner,
          completed: false,
          next,
        });
        ledger.activePrepared.add(restored);
      }
    }
    return ledger;
  }
}
