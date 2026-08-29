import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  GAOS_REPLAY_DERIVED_SEEDS,
  GAOS_REPLAY_EXTENSION,
  GAOS_REPLAY_MANIFEST_FORMAT,
  GAOS_REPLAY_MIME,
  ReplayFormatError,
  createReplayArtifact,
  parseReplayJsonl,
  recheckReplayArtifact,
  runLevelSeed,
  serializeReplayJsonl,
  transcriptToReplayArtifact,
  validateReplayArtifact,
  type ReplayArtifact,
  type ReplayGameRef,
  type ReplaySeatIntegrityReservation,
  type ActionReducer,
  type SessionView,
  type TickView,
} from '../src/engine/index.js';

interface Level {
  id: string;
  goal: number;
}

interface State {
  at: number;
  actionsUsed: number;
}

const reducer: ActionReducer<Level, State> = {
  init: () => ({ at: 0, actionsUsed: 0 }),
  apply: (state, action) => {
    if (action.id !== 'Action 1') throw new Error('illegal action');
    return { at: state.at + 1, actionsUsed: state.actionsUsed + 1 };
  },
  view: (state): TickView => ({
    actions: [{ id: 'Action 1', params: 'none' }],
    status: state.at >= 1 ? 'won' : 'playing',
    ...(state.at >= 1 ? { stars: 3 } : {}),
    hud: { actionsUsed: state.actionsUsed },
  }),
};

const game: ReplayGameRef = {
  id: 'creator/tabletop-demo',
  version: '7',
  adapter: {
    id: 'creator/tabletop-demo/reducer',
    version: 'sha256:abc123',
  },
};

function runArtifact(): ReplayArtifact<Level> {
  return createReplayArtifact({
    sessionId: 'portable-run',
    game,
    seed: 12345,
    perm: [0],
    levels: [
      {
        id: 'level-a',
        version: 1,
        level: { id: 'level-a', goal: 1 },
        result: { status: 'won', stars: 3, actionsUsed: 1 },
      },
      {
        id: 'level-b',
        version: 4,
        level: { id: 'level-b', goal: 1 },
        result: { status: 'won', stars: 3, actionsUsed: 1 },
      },
    ],
    actions: [
      { n: 0, levelIndex: 0, wireId: 'Action 1', canonicalId: 'Action 1' },
      { n: 1, levelIndex: 1, wireId: 'Action 1', canonicalId: 'Action 1' },
    ],
    extensions: {
      producer: 'tabletoplabs',
      benchmark: 'arena-compatible',
    },
  });
}

describe('portable GAOS replay JSONL', () => {
  it('shares canonical golden bytes with non-TypeScript implementations', () => {
    const fixture = readFileSync(
      new URL('../fixtures/replay/gaos-replay-v1.golden.jsonl', import.meta.url),
      'utf8',
    );
    const artifact = parseReplayJsonl(fixture);
    expect(artifact.header.levels[0]!.seed).toBe(runLevelSeed(42, 0));
    expect(serializeReplayJsonl(artifact)).toBe(fixture);
  });

  it('round-trips and rechecks the cross-language v1.3 ended fixture', () => {
    const fixture = readFileSync(
      new URL(
        '../fixtures/replay/gaos-replay-v1.3-ended.golden.jsonl',
        import.meta.url,
      ),
      'utf8',
    );
    const artifact = parseReplayJsonl<{ room: string }>(fixture);
    expect(artifact.header.formatVersion).toBe('1.3');
    expect(artifact.header.levels[0]!.result).toEqual({
      status: 'ended',
      stars: null,
      actionsUsed: 1,
    });
    expect(serializeReplayJsonl(artifact)).toBe(fixture);

    const endedReducer: ActionReducer<{ room: string }, State, SessionView> = {
      init: () => ({ at: 0, actionsUsed: 0 }),
      apply: (state) => ({
        at: 1,
        actionsUsed: state.actionsUsed + 1,
      }),
      view: (state) => ({
        status: state.at === 0 ? 'playing' : 'ended',
      }),
      replayMetrics: (state) => ({ actionsUsed: state.actionsUsed }),
    };
    expect(recheckReplayArtifact(artifact, () => endedReducer)).toMatchObject({
      ok: true,
      problems: [],
      replayed: {
        statuses: ['ended'],
        totalStars: 0,
        totalActionsUsed: 1,
      },
    });
  });

  it('publishes one manifest declaration consumers can reuse', () => {
    expect(GAOS_REPLAY_MANIFEST_FORMAT).toEqual({
      mime: GAOS_REPLAY_MIME,
      extension: GAOS_REPLAY_EXTENSION,
      compressed: false,
    });
  });

  it('normalizes per-level seeds and round-trips canonical JSONL', () => {
    const artifact = runArtifact();
    expect(artifact.header.seedPolicy).toBe(GAOS_REPLAY_DERIVED_SEEDS);
    expect(artifact.header.levels.map(({ seed }) => seed)).toEqual([
      runLevelSeed(12345, 0),
      runLevelSeed(12345, 1),
    ]);
    expect(artifact.header.totals).toEqual({
      totalStars: 6,
      totalActionsUsed: 2,
    });

    const jsonl = serializeReplayJsonl(artifact);
    expect(jsonl.endsWith('\n')).toBe(true);
    expect(jsonl.trimEnd().split('\n')).toHaveLength(3);
    const parsed = parseReplayJsonl<Level>(jsonl);
    expect(parsed).toEqual(artifact);
    expect(serializeReplayJsonl(parsed)).toBe(jsonl);
  });

  it('rechecks an ordered multi-level run through a product reducer registry', () => {
    const artifact = runArtifact();
    const result = recheckReplayArtifact(
      artifact,
      ({ game: replayGame }) => replayGame.adapter.id === game.adapter.id
        ? reducer
        : undefined,
    );

    expect(result).toMatchObject({
      ok: true,
      problems: [],
      replayed: {
        statuses: ['won', 'won'],
        totalStars: 6,
        totalActionsUsed: 2,
      },
    });
    expect(result.levels.map(({ id, seed }) => ({ id, seed }))).toEqual(
      artifact.header.levels.map(({ id, seed }) => ({ id, seed })),
    );
  });

  it('rejects unknown properties at every frozen replay boundary', () => {
    const artifact = structuredClone(runArtifact()) as ReplayArtifact<Level>
      & { unexpected?: boolean };
    artifact.unexpected = true;
    expect(validateReplayArtifact(artifact)).toContain('artifact has unknown property unexpected');

    const nested = structuredClone(runArtifact());
    (nested.header.game.adapter as unknown as Record<string, unknown>)['extra'] = true;
    expect(validateReplayArtifact(nested))
      .toContain('header.game.adapter has unknown property extra');

    const action = structuredClone(runArtifact());
    (action.actions[0] as unknown as Record<string, unknown>)['extra'] = true;
    expect(validateReplayArtifact(action))
      .toContain('action 0 has unknown property extra');
  });

  it('rejects inconsistent grouped records instead of discarding gameplay', () => {
    const artifact = structuredClone(runArtifact());
    artifact.header.formatVersion = '1.1';
    artifact.records = [];

    expect(validateReplayArtifact(artifact).join('\n'))
      .toMatch(/actions must exactly match the projection of records/);
    expect(() => serializeReplayJsonl(artifact))
      .toThrow(/actions must exactly match the projection of records/);
  });

  it('preserves opaque RFC-010 reservation slots in legacy v1.1 artifacts', () => {
    const reserved = structuredClone(runArtifact());
    reserved.header.formatVersion = '1.1';
    const seatKey: ReplaySeatIntegrityReservation = {
      id: 'red',
      publicKey: 'reserved-key',
      alg: 'reserved-algorithm',
    };
    reserved.header.seatKeys = [seatKey];
    reserved.header.signaturePolicy = { scheme: 'reserved', N: 8 };
    reserved.header.timeoutPolicy = { mode: 'ticks', maximum: 90 };
    Object.assign(reserved.actions[0]!, {
      submissionId: 'reserved-submission',
      canonicalCommand: '{"move":1}',
      cursor: 0,
      clientTime: 1_785_032_000_000,
      prevChainHash: 'reserved-chain-link',
      sig: 'reserved-signature',
    });

    expect(validateReplayArtifact(reserved)).toEqual([]);
    const parsed = parseReplayJsonl(serializeReplayJsonl(reserved));
    expect(parsed).toEqual(reserved);

    const periodic = structuredClone(reserved);
    periodic.actions = [];
    periodic.records = [{
      kind: 'seat-signature',
      n: 0,
      levelIndex: 0,
      tick: 12,
      participantId: 'red',
      clientTime: 1_785_032_000_000,
      prevChainHash: 'reserved-chain-link',
      sig: 'reserved-periodic-signature',
      hostTime: 1_785_032_000_100,
    }];
    expect(validateReplayArtifact(periodic)).toEqual([]);
    expect(parseReplayJsonl(serializeReplayJsonl(periodic))).toEqual(periodic);

    const legacy = structuredClone(reserved);
    legacy.header.formatVersion = '1.0';
    expect(validateReplayArtifact(legacy).join('\n')).toMatch(
      /integrity reservations require|v1\.1 fields require/,
    );
  });

  it('rejects v1.0 commitment fields and aborts before reducer resolution for unknown dmath', () => {
    const legacy = structuredClone(runArtifact());
    legacy.header.formatVersion = '1.0';
    legacy.actions[0]!.commit = {
      commitmentId: 0,
      scheme: 'gaos.commit.sha256.v1',
      hash: '00'.repeat(32),
    };
    expect(validateReplayArtifact(legacy).join('\n'))
      .toMatch(/v1\.1 fields require formatVersion 1.1/);

    const unsupported = structuredClone(runArtifact());
    unsupported.header.extensions = {
      dmath: { algorithm: 'future', backend: 'js' },
    };
    let reducerResolved = false;
    const checked = recheckReplayArtifact(unsupported, () => {
      reducerResolved = true;
      return reducer;
    });
    expect(checked.ok).toBe(false);
    expect(checked.problems.join('\n')).toMatch(/cannot construct replay dmath algorithm/);
    expect(reducerResolved).toBe(false);
  });

  it('detects seed, total, ordering, and adapter tampering', () => {
    const artifact = runArtifact();
    const wrongSeed = structuredClone(artifact);
    wrongSeed.header.levels[1]!.seed++;
    expect(validateReplayArtifact(wrongSeed).join('\n')).toMatch(/seed does not match/);

    const wrongTotal = structuredClone(artifact);
    wrongTotal.header.totals.totalStars++;
    expect(recheckReplayArtifact(wrongTotal, () => reducer).problems.join('\n'))
      .toMatch(/totalStars/);

    const wrongOrder = structuredClone(artifact);
    wrongOrder.actions[1]!.levelIndex = 0;
    wrongOrder.actions.push({
      kind: 'action',
      n: 2,
      levelIndex: 1,
      wireId: 'Action 1',
      canonicalId: 'Action 1',
    });
    wrongOrder.actions.push({
      kind: 'action',
      n: 3,
      levelIndex: 0,
      wireId: 'Action 1',
      canonicalId: 'Action 1',
    });
    expect(validateReplayArtifact(wrongOrder).join('\n')).toMatch(/earlier level/);

    expect(recheckReplayArtifact(artifact, () => undefined).problems.join('\n'))
      .toMatch(/no reducer.*creator\/tabletop-demo\/reducer@sha256:abc123/);
  });

  it('lifts the existing TranscriptHeader/TranscriptAction pair without loss', () => {
    const artifact = transcriptToReplayArtifact(
      {
        sessionId: 'legacy-single',
        level: { id: 'only', goal: 1 },
        seed: 77,
        perm: [0],
        status: 'won',
        stars: 3,
        actionsUsed: 1,
        visibility: 'seat:red',
      },
      [{ n: 1, wireId: 'Action 1', canonicalId: 'Action 1', tick: 4 }],
      { game, levelId: 'only', levelVersion: '2' },
    );

    expect(artifact.header).toMatchObject({
      seed: 77,
      seedPolicy: 'explicit',
      visibility: 'seat:red',
      levels: [{
        index: 0,
        id: 'only',
        version: '2',
        seed: 77,
      }],
    });
    expect(artifact.actions).toEqual([{
      kind: 'action',
      n: 1,
      levelIndex: 0,
      wireId: 'Action 1',
      canonicalId: 'Action 1',
      tick: 4,
    }]);
    expect(recheckReplayArtifact(artifact, () => reducer).ok).toBe(true);
  });

  it('rejects malformed and foreign JSONL with actionable errors', () => {
    expect(() => parseReplayJsonl('not-json\n')).toThrow(ReplayFormatError);
    expect(() => parseReplayJsonl('{"kind":"header"}\n\n{"kind":"action"}\n'))
      .toThrow(/line 2 must not be blank/);

    const artifact = runArtifact();
    const foreign = serializeReplayJsonl(artifact)
      .replace('"format":"gaos.replay"', '"format":"vendor.replay"');
    expect(() => parseReplayJsonl(foreign)).toThrow(/header\.format must be gaos\.replay/);

    const unsafe = structuredClone(runArtifact());
    unsafe.header.levels[0]!.level.goal = Number.MAX_SAFE_INTEGER + 1;
    expect(() => serializeReplayJsonl(unsafe)).toThrow(/JavaScript safe range/);

    const surrogate = structuredClone(runArtifact());
    surrogate.header.sessionId = '\ud800';
    expect(() => serializeReplayJsonl(surrogate)).toThrow(/unpaired surrogates/);
  });
});

describe('host controls', () => {
  const game: ReplayGameRef = { id: 'grid', version: '1', adapter: { id: 'a', version: '1' } };

  const hostControlReducer: ActionReducer<Level, State & { restarted: boolean }> = {
    init: () => ({ at: 0, actionsUsed: 0, restarted: false }),
    apply: (state, action) => {
      if (action.id === 'Restart') {
        return { at: 0, actionsUsed: state.actionsUsed + 1, restarted: true };
      }
      if (action.id !== 'Action 1') throw new Error('illegal action');
      return { ...state, at: state.at + 1, actionsUsed: state.actionsUsed + 1 };
    },
    view: (state): TickView => ({
      actions: [{ id: 'Action 1', params: 'none' }],
      systemActions: [{ id: 'Restart', params: 'none' }],
      status: state.restarted && state.at >= 1 ? 'won' : 'playing',
      ...(state.restarted && state.at >= 1 ? { stars: 3 } : {}),
      hud: { actionsUsed: state.actionsUsed },
    }),
  };

  const artifact = (systemActions?: readonly string[]) => createReplayArtifact({
    sessionId: 'restart-run',
    game,
    seed: 7,
    perm: [0, 1],
    ...(systemActions ? { systemActions } : {}),
    levels: [{
      id: 'level-a',
      version: 1,
      level: { id: 'level-a', goal: 1 },
      result: { status: 'won', stars: 3, actionsUsed: 2 },
    }],
    actions: [
      // A restart changes world state but is never permuted, so it names
      // itself on both sides instead of indexing the alphabet.
      { n: 0, levelIndex: 0, wireId: 'Restart', canonicalId: 'Restart' },
      { n: 1, levelIndex: 0, wireId: 'Action 1', canonicalId: 'Action 1' },
    ],
  });

  it('accepts a declared control and records the version that carries it', () => {
    const declared = artifact(['Restart']);
    expect(declared.header.formatVersion).toBe('1.5');
    expect(declared.header.systemActions).toEqual(['Restart']);
    expect(() => validateReplayArtifact(declared)).not.toThrow();
    expect(recheckReplayArtifact(declared, () => hostControlReducer)).toMatchObject({
      ok: true,
      problems: [],
      replayed: { statuses: ['won'], totalActionsUsed: 2 },
    });
  });

  it('rejects a control the header never declared', () => {
    expect(() => artifact()).toThrow(ReplayFormatError);
  });

  it('rejects a control that disagrees with itself across wire and canonical', () => {
    const build = () => createReplayArtifact({
      sessionId: 'restart-run',
      game,
      seed: 7,
      perm: [0, 1],
      systemActions: ['Restart', 'Retry'],
      levels: [{
        id: 'level-a', version: 1, level: { id: 'level-a', goal: 1 },
        result: { status: 'won', stars: 3, actionsUsed: 2 },
      }],
      actions: [
        { n: 0, levelIndex: 0, wireId: 'Action 1', canonicalId: 'Action 1' },
        { n: 1, levelIndex: 0, wireId: 'Restart', canonicalId: 'Retry' },
      ],
    });
    expect(build).toThrow(/same declared host control/);
  });

  it('requires the same declared control in grouped resolution inputs', () => {
    const grouped = artifact(['Restart', 'Retry']);
    grouped.records = [{
      kind: 'resolution',
      n: 0,
      levelIndex: 0,
      tick: 0,
      inputs: [{ wireId: 'Restart', canonicalId: 'Restart' }],
      cause: 'complete',
    }, {
      kind: 'resolution',
      n: 1,
      levelIndex: 0,
      tick: 1,
      inputs: [{ wireId: 'Action 1', canonicalId: 'Action 1' }],
      cause: 'complete',
    }];
    grouped.actions[0]!.canonicalId = 'Retry';
    const first = grouped.records[0];
    if (first?.kind === 'resolution') first.inputs[0]!.canonicalId = 'Retry';

    const problems = validateReplayArtifact(grouped);
    expect(problems).toContain(
      'action 0 wireId and canonicalId must name the same declared host control',
    );
    expect(problems).toContain(
      'resolution 0 input 0 wireId and canonicalId must name the same declared host control',
    );
  });

  it('leaves an artifact without controls on its older version', () => {
    const plain = createReplayArtifact({
      sessionId: 'plain-run',
      game,
      seed: 7,
      perm: [0],
      levels: [{
        id: 'level-a', version: 1, level: { id: 'level-a', goal: 1 },
        result: { status: 'won', stars: 3, actionsUsed: 1 },
      }],
      actions: [{ n: 0, levelIndex: 0, wireId: 'Action 1', canonicalId: 'Action 1' }],
    });
    expect(plain.header.formatVersion).toBe('1.3');
    expect(plain.header.systemActions).toBeUndefined();
  });
});

describe('host control version follows usage', () => {
  const game: ReplayGameRef = { id: 'grid', version: '1', adapter: { id: 'a', version: '1' } };

  it('stays on the older version when a declared control is never used', () => {
    // A session that could restart but never did is an ordinary artifact, and
    // must stay readable by anything that predates host controls.
    const unused = createReplayArtifact({
      sessionId: 'no-restart',
      game,
      seed: 7,
      perm: [0],
      systemActions: ['Restart'],
      levels: [{
        id: 'level-a', version: 1, level: { id: 'level-a', goal: 1 },
        result: { status: 'won', stars: 3, actionsUsed: 1 },
      }],
      actions: [{ n: 0, levelIndex: 0, wireId: 'Action 1', canonicalId: 'Action 1' }],
    });
    expect(unused.header.formatVersion).toBe('1.3');
    expect(unused.header.systemActions).toBeUndefined();
  });
});
