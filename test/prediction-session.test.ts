import { describe, expect, it } from 'vitest';
import { canonicalJson, type JsonValue } from '../src/protocol.js';
import { fnv1a, type SessionView } from '../src/engine/index.js';
import {
  PredictionSession,
  type ObservationDelta,
} from '../src/session.js';

interface View extends SessionView {
  log: string[];
}

interface Command {
  [key: string]: JsonValue;
  label: string;
}

function digest(view: View): number {
  return fnv1a(canonicalJson(view as unknown as JsonValue));
}

function snapshot(
  transitionRevision: number,
  viewRevision: number,
  view: View,
  settled: {
    acknowledgements?: ObservationDelta<View>['acknowledgements'];
    rejections?: ObservationDelta<View>['rejections'];
  } = {},
): ObservationDelta<View> {
  return {
    seat: 'solo',
    transitionRevision,
    viewRevision,
    tick: transitionRevision,
    codec: 'v2',
    origin: 'snapshot',
    acknowledgements: settled.acknowledgements ?? [],
    rejections: settled.rejections ?? [],
    body: { kind: 'snapshot', view },
    viewDigest: digest(view),
  };
}

describe('PredictionSession', () => {
  it('settles acknowledgements and rejections then replays pending inputs in enqueue order', () => {
    const prediction = new PredictionSession<Command, View>({
      initial: {
        view: { status: 'playing', log: [] },
        transitionRevision: 0,
        viewRevision: 0,
      },
      applyPending: (view, submission) => ({
        ...view,
        log: [...view.log, submission.command.label],
      }),
    });
    prediction.predict({
      participantId: 'solo',
      submissionId: 'a',
      command: { label: 'a' },
    });
    expect(prediction.predict({
      participantId: 'solo',
      submissionId: 'b',
      command: { label: 'b' },
    }).log).toEqual(['a', 'b']);

    const reconciled = prediction.reconcile(snapshot(
      1,
      1,
      { status: 'playing', log: ['authoritative-a'] },
      {
        acknowledgements: [{ participantId: 'solo', submissionId: 'a' }],
      },
    ));
    expect(reconciled).toMatchObject({
      status: 'applied',
      settled: ['a'],
      reapplied: ['b'],
      view: { log: ['authoritative-a', 'b'] },
    });

    const rejected = prediction.reconcile(snapshot(
      2,
      2,
      { status: 'playing', log: ['authoritative-a'] },
      {
        rejections: [{
          seat: 'solo',
          transitionRevision: 2,
          tick: 2,
          participantId: 'solo',
          submissionId: 'b',
          code: 'commit_mismatch',
        }],
      },
    ));
    expect(rejected).toMatchObject({
      status: 'applied',
      settled: ['b'],
      reapplied: [],
      view: { log: ['authoritative-a'] },
    });
    expect(prediction.pending()).toEqual([]);
  });

  it('requests recovery for gaps, missing patch bases, and digest mismatches', () => {
    const withoutBase = new PredictionSession<Command, View>({
      applyPending: (view) => view,
    });
    expect(withoutBase.reconcile({
      seat: 'solo',
      transitionRevision: 4,
      viewRevision: 4,
      tick: 4,
      codec: 'v2',
      origin: 'resolution',
      acknowledgements: [],
      rejections: [],
      body: { kind: 'patch', operations: [] },
      viewDigest: 0,
    })).toMatchObject({
      status: 'resync_required',
      reason: 'missing_base',
    });

    const prediction = new PredictionSession<Command, View>({
      initial: {
        view: { status: 'playing', log: [] },
        transitionRevision: 1,
        viewRevision: 1,
      },
      applyPending: (view) => view,
    });
    expect(prediction.reconcile({
      seat: 'solo',
      transitionRevision: 3,
      viewRevision: 3,
      tick: 3,
      codec: 'v2',
      origin: 'resolution',
      acknowledgements: [],
      rejections: [],
      body: { kind: 'unchanged' },
      viewDigest: digest({ status: 'playing', log: [] }),
    })).toMatchObject({
      status: 'resync_required',
      reason: 'transition_gap',
      expectedTransitionRevision: 2,
    });

    expect(prediction.reconcile(snapshot(
      2,
      2,
      { status: 'playing', log: ['bad'] },
    ) as ObservationDelta<View> & { viewDigest: number })).toMatchObject({
      status: 'applied',
    });
    const invalid = snapshot(3, 3, { status: 'playing', log: ['next'] });
    invalid.viewDigest ^= 1;
    expect(prediction.reconcile(invalid)).toMatchObject({
      status: 'resync_required',
      reason: 'invalid_delta',
    });
  });

  it('recovers a stream that starts mid-session from a snapshot', () => {
    const prediction = new PredictionSession<Command, View>({
      applyPending: (view) => view,
    });
    expect(prediction.reconcile(snapshot(
      10,
      7,
      { status: 'playing', log: ['recovered'] },
    ))).toMatchObject({
      status: 'applied',
      view: { log: ['recovered'] },
      transitionRevision: 10,
    });
  });
});
