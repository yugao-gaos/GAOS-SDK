import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { JsonValue } from '../src/protocol.js';
import {
  COMMITMENT_SCHEME,
  STATE_MATH,
  bytesToHex,
  commitmentPreimageV1,
  createReplayArtifact,
  createCommitmentHash,
  createDmath,
  recheckReplayArtifact,
  sha256,
  verifyCommitmentReveal,
  type TickReducer,
  type TickView,
} from '../src/engine/index.js';

describe('deterministic math', () => {
  it('publishes one immutable classification and context', () => {
    const dmath = createDmath();
    expect(Object.isFrozen(dmath)).toBe(true);
    expect(dmath).toMatchObject({ algorithm: 'dmath-1', backend: 'js' });
    expect(STATE_MATH.constants).toContain('Math.PI');
    expect(STATE_MATH.forbidden).toContain('Math.random');
  });

  it('covers trigonometric quadrants and deterministic rounding boundaries', () => {
    const dmath = createDmath();
    for (const value of [-2 * Math.PI, -Math.PI, -0, Math.PI / 6, Math.PI / 2, Math.PI]) {
      expect(dmath.sin(value)).toBeCloseTo(Math.sin(value), 14);
      expect(dmath.cos(value)).toBeCloseTo(Math.cos(value), 14);
    }
    for (const [y, x] of [[1, 1], [1, -1], [-1, -1], [-1, 1]] as const) {
      expect(dmath.atan2(y, x)).toBeCloseTo(Math.atan2(y, x), 14);
    }
    expect(dmath.roundTo(1.25, 1)).toBe(1.3);
    expect(dmath.roundTo(-1.25, 1)).toBe(-1.3);
    expect(dmath.roundTo(0.49999999999999994, 0)).toBe(0);
    expect(dmath.roundTo(-0.49999999999999994, 0)).toBe(-0);
    expect(Object.is(dmath.roundTo(-0.1, 0), -0)).toBe(true);
    expect(dmath.clamp(4, 0, 3)).toBe(3);
  });

  it('captures custom backend methods at construction', () => {
    const backend = {
      id: 'wasm' as const,
      sin: () => 1,
      cos: () => 1,
      atan2: () => 1,
    };
    const dmath = createDmath({ backend });
    backend.sin = () => 2;
    backend.cos = () => 2;
    backend.atan2 = () => 2;
    expect(dmath.sin(0)).toBe(1);
    expect(dmath.cos(0)).toBe(1);
    expect(dmath.atan2(1, 1)).toBe(1);
  });

  it('rejects non-finite and out-of-contract values', () => {
    const dmath = createDmath();
    expect(() => dmath.sin(2 ** 30 + 1)).toThrow(RangeError);
    expect(() => dmath.atan2(Number.POSITIVE_INFINITY, 1)).toThrow(RangeError);
    expect(() => dmath.clamp(0, 2, 1)).toThrow(RangeError);
    expect(() => dmath.roundTo(2 ** 53, 0)).toThrow(RangeError);
    expect(() => createDmath({ algorithm: 'future' as 'dmath-1' })).toThrow(RangeError);
  });

  it('matches the published dmath-1 binary64 vectors bit for bit', () => {
    const vectors = JSON.parse(readFileSync(
      new URL('../fixtures/dmath/dmath-1.vectors.json', import.meta.url),
      'utf8',
    )) as Array<{
      function: 'sin' | 'cos' | 'atan2' | 'clamp' | 'roundTo';
      args: Array<number | '-0'>;
      resultBits: string;
    }>;
    const dmath = createDmath();
    const bits = (value: number): string => {
      const buffer = new ArrayBuffer(8);
      new DataView(buffer).setFloat64(0, value, false);
      return bytesToHex(new Uint8Array(buffer));
    };
    for (const vector of vectors) {
      const args = vector.args.map((value) => value === '-0' ? -0 : value);
      let result: number;
      if (vector.function === 'atan2') result = dmath.atan2(args[0]!, args[1]!);
      else if (vector.function === 'clamp') result = dmath.clamp(args[0]!, args[1]!, args[2]!);
      else if (vector.function === 'roundTo') result = dmath.roundTo(args[0]!, args[1]!);
      else result = dmath[vector.function](args[0]!);
      expect(bits(result), JSON.stringify(vector)).toBe(vector.resultBits);
    }
  });
});

describe('gaos.commit.sha256.v1', () => {
  const binding = {
    sessionId: 'session-1',
    seat: 'red',
    commitmentId: 0,
    windowRef: 7,
  };
  const salt = '00112233445566778899aabbccddeeff';
  const payload = { order: ['north', 2], ready: true };

  it('agrees with Node SHA-256 over the published complete preimage', () => {
    const preimage = commitmentPreimageV1(binding, salt, payload);
    const nodeHash = createHash('sha256').update(preimage).digest('hex');
    expect(bytesToHex(sha256(preimage))).toBe(nodeHash);
    expect(createCommitmentHash(binding, salt, payload)).toBe(nodeHash);
  });

  it('matches NIST SHA-256 vectors, block boundaries, and WebCrypto', async () => {
    const vectors = [
      ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
      ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
      [
        'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
        '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
      ],
      ['a'.repeat(1_000_000), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
    ] as const;
    const encoder = new TextEncoder();
    for (const [message, expected] of vectors) {
      const bytes = encoder.encode(message);
      expect(bytesToHex(sha256(bytes))).toBe(expected);
      expect(bytesToHex(new Uint8Array(await webcrypto.subtle.digest('SHA-256', bytes))))
        .toBe(expected);
    }
    for (const length of [55, 56, 63, 64, 65]) {
      const bytes = new Uint8Array(length).fill(0x61);
      expect(bytesToHex(sha256(bytes))).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  });

  it('keeps all published cross-language vectors byte-identical', () => {
    const vectors = JSON.parse(readFileSync(
      new URL(
        '../fixtures/commitment/gaos.commit.sha256.v1.vectors.json',
        import.meta.url,
      ),
      'utf8',
    )) as Array<{
      binding: typeof binding;
      salt: string;
      payload: JsonValue;
      preimageHex: string;
      hash: string;
    }>;
    expect(vectors).toHaveLength(3);
    for (const vector of vectors) {
      expect(bytesToHex(commitmentPreimageV1(
        vector.binding,
        vector.salt,
        vector.payload,
      ))).toBe(vector.preimageHex);
      expect(createCommitmentHash(vector.binding, vector.salt, vector.payload)).toBe(vector.hash);
    }
  });

  it('verifies honest reveals and identifies mismatches', () => {
    const hash = createCommitmentHash(binding, salt, payload);
    const commitment = { commitmentId: 0, scheme: COMMITMENT_SCHEME, hash };
    expect(verifyCommitmentReveal(
      binding,
      commitment,
      { commitmentId: 0, salt, payload },
    )).toMatchObject({ ok: true, code: 'ok' });
    expect(verifyCommitmentReveal(
      binding,
      commitment,
      { commitmentId: 0, salt, payload: { ...payload, ready: false } },
    )).toMatchObject({ ok: false, code: 'commit_mismatch' });
    const honest = { commitmentId: 0, salt, payload };
    for (const tamperedBinding of [
      { ...binding, sessionId: 'other-session' },
      { ...binding, seat: 'blue' },
      { ...binding, windowRef: binding.windowRef + 1 },
    ]) {
      expect(verifyCommitmentReveal(tamperedBinding, commitment, honest))
        .toMatchObject({ ok: false, code: 'commit_mismatch' });
    }
    expect(verifyCommitmentReveal(binding, commitment, {
      ...honest,
      salt: '11'.repeat(16),
    })).toMatchObject({ ok: false, code: 'commit_mismatch' });
  });

  it('rejects malformed Unicode, hex, and identifier ranges before hashing', () => {
    expect(() => commitmentPreimageV1(binding, 'AA'.repeat(16), payload)).toThrow(TypeError);
    expect(() => commitmentPreimageV1(
      binding,
      salt,
      { invalid: '\ud800' },
    )).toThrow(/unpaired surrogates/);
    expect(() => commitmentPreimageV1(
      { ...binding, commitmentId: 2 ** 32 },
      salt,
      payload,
    )).toThrow(RangeError);
  });

  it('independently rechecks mismatch audit material in replay v1.1', () => {
    interface AuditState { phase: number; actionsUsed: number }
    const auditReducer: TickReducer<{}, AuditState> = {
      init: () => ({ phase: 0, actionsUsed: 0 }),
      advance: (state, inputs) => ({
        phase: state.phase + 1,
        actionsUsed: state.actionsUsed + inputs.length,
      }),
      view: (state): TickView => ({
        actions: [{ id: 'Action 1', params: 'none' }],
        status: state.phase >= 2 ? 'won' : 'playing',
        ...(state.phase >= 2 ? { stars: 3 } : {}),
        hud: { actionsUsed: state.actionsUsed },
      }),
    };
    const hash = createCommitmentHash(binding, salt, payload);
    const commit = {
      wireId: 'Action 1',
      canonicalId: 'Action 1',
      seat: binding.seat,
      commit: { commitmentId: 0, scheme: COMMITMENT_SCHEME, hash },
    } as const;
    const reveal = {
      wireId: 'Action 1',
      canonicalId: 'Action 1',
      seat: binding.seat,
      reveal: { commitmentId: 0, salt, payload },
      verifiedPayload: payload,
    } as const;
    const artifact = createReplayArtifact({
      sessionId: binding.sessionId,
      game: {
        id: 'audit-test',
        version: '1',
        adapter: { id: 'audit-test/reducer', version: '1' },
      },
      seed: 1,
      seedPolicy: 'explicit',
      perm: [0],
      levels: [{
        id: 'only',
        seed: 1,
        level: {},
        result: { status: 'won', stars: 3, actionsUsed: 2 },
      }],
      actions: [
        { ...commit, n: 0, levelIndex: 0 },
        { ...reveal, n: 1, levelIndex: 0 },
      ],
      records: [
        {
          kind: 'resolution',
          n: 0,
          levelIndex: 0,
          tick: binding.windowRef,
          inputs: [commit],
          cause: 'complete',
        },
        {
          kind: 'commit-mismatch',
          n: 1,
          levelIndex: 0,
          tick: binding.windowRef + 1,
          participantId: binding.seat,
          submissionId: 'bad-reveal',
          commitmentId: 0,
          scheme: COMMITMENT_SCHEME,
          attemptedReveal: { salt, payload: { wrong: true } },
        },
        {
          kind: 'resolution',
          n: 2,
          levelIndex: 0,
          tick: binding.windowRef + 1,
          inputs: [reveal],
          cause: 'complete',
        },
      ],
    });
    const checked = recheckReplayArtifact(artifact, () => auditReducer);
    expect(checked.ok).toBe(false);
    expect(checked.problems.join('\n')).toMatch(/commit_mismatch.*red.*0/);

    const redacted = structuredClone(artifact);
    const redactedAudit = redacted.records?.[1];
    if (redactedAudit?.kind === 'commit-mismatch') {
      delete redactedAudit.attemptedReveal;
    }
    expect(recheckReplayArtifact(redacted, () => auditReducer).diagnostics.join('\n'))
      .toMatch(/recorded but is not independently recheckable/);

    const inconsistent = structuredClone(artifact);
    const audit = inconsistent.records?.[1];
    if (audit?.kind === 'commit-mismatch') {
      audit.attemptedReveal = { salt, payload };
    }
    expect(recheckReplayArtifact(inconsistent, () => auditReducer).problems.join('\n'))
      .toMatch(/is inconsistent/);
  });

  it('reports salt reuse across distinct commitments as a non-fatal diagnostic', () => {
    interface AuditState { phase: number; actionsUsed: number }
    const reuseReducer: TickReducer<{}, AuditState> = {
      init: () => ({ phase: 0, actionsUsed: 0 }),
      advance: (state, inputs) => ({
        phase: state.phase + 1,
        actionsUsed: state.actionsUsed + inputs.length,
      }),
      view: (state): TickView => ({
        actions: [{ id: 'Action 1', params: 'none' }],
        status: state.phase >= 4 ? 'won' : 'playing',
        ...(state.phase >= 4 ? { stars: 3 } : {}),
        hud: { actionsUsed: state.actionsUsed },
      }),
    };
    const payload0 = { order: 'north' };
    const payload1 = { order: 'south' };
    const binding0 = { ...binding, commitmentId: 0, windowRef: 0 };
    const binding1 = { ...binding, commitmentId: 1, windowRef: 2 };
    const input = (
      commitmentId: number,
      hash: string,
      revealPayload: JsonValue | undefined,
    ) => revealPayload === undefined
      ? {
        wireId: 'Action 1',
        canonicalId: 'Action 1',
        seat: binding.seat,
        commit: { commitmentId, scheme: COMMITMENT_SCHEME, hash },
      }
      : {
        wireId: 'Action 1',
        canonicalId: 'Action 1',
        seat: binding.seat,
        reveal: { commitmentId, salt, payload: revealPayload },
        verifiedPayload: revealPayload,
      };
    const commit0 = input(0, createCommitmentHash(binding0, salt, payload0), undefined);
    const reveal0 = input(0, '', payload0);
    const commit1 = input(1, createCommitmentHash(binding1, salt, payload1), undefined);
    const reveal1 = input(1, '', payload1);
    const artifact = createReplayArtifact({
      sessionId: binding.sessionId,
      game: {
        id: 'salt-reuse-test',
        version: '1',
        adapter: { id: 'salt-reuse-test/reducer', version: '1' },
      },
      seed: 1,
      seedPolicy: 'explicit',
      perm: [0],
      levels: [{
        id: 'only',
        seed: 1,
        level: {},
        result: { status: 'won', stars: 3, actionsUsed: 4 },
      }],
      actions: [commit0, reveal0, commit1, reveal1].map((action, n) => ({
        ...action,
        n,
        levelIndex: 0,
      })),
      records: [commit0, reveal0, commit1, reveal1].map((entry, n) => ({
        kind: 'resolution' as const,
        n,
        levelIndex: 0,
        tick: n,
        inputs: [entry],
        cause: 'complete' as const,
      })),
    });
    const checked = recheckReplayArtifact(artifact, () => reuseReducer);
    expect(checked.ok).toBe(true);
    expect(checked.problems).toEqual([]);
    expect(checked.diagnostics.join('\n')).toMatch(/salt reuse/);
  });
});
