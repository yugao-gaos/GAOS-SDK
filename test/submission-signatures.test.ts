import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  SUBMISSION_SIGNATURE_ALGORITHM,
  GAOS_TIMEOUT_POLICY_REF,
  createTickRate,
  createCommitmentHash,
  exportSubmissionPublicKey,
  generateSubmissionKeyPair,
  createReplayArtifact,
  recheckReplaySignatures,
  signEd25519Base64,
  signPeriodicChainHeadV1,
  signSubmissionV1,
  signatureBytesFromBase64,
  signatureBytesToBase64,
  submissionChainHashV1,
  submissionGenesisHashV1,
  submissionPreimageV1,
  submissionRosterHashV1,
  verifyEd25519,
  verifyEd25519Base64,
  type ReplayArtifact,
  type ReplayRecord,
  type TickReducer,
  type TickView,
} from '../src/engine/index.js';
import { createSessionKernel, finalizeReplay } from '../src/session.js';
import { PROTOCOL_ID, PROTOCOL_VERSION, makeTickId } from '../src/protocol.js';

function hex(value: string): Uint8Array {
  return Uint8Array.from(
    value.match(/.{2}/g) ?? [],
    (byte) => Number.parseInt(byte, 16),
  );
}

describe('RFC-010 submission signatures', () => {
  it('verifies RFC 8032 Ed25519 vectors synchronously', () => {
    const vectors = [
      {
        publicKey: 'd75a980182b10ab7d54bfed3c964073a'
          + '0ee172f3daa62325af021a68f707511a',
        message: '',
        signature: 'e5564300c360ac729086e2cc806e828a'
          + '84877f1eb8e5d974d873e06522490155'
          + '5fb8821590a33bacc61e39701cf9b46b'
          + 'd25bf5f0595bbe24655141438e7a100b',
      },
      {
        publicKey: '3d4017c3e843895a92b70aa74d1b7ebc'
          + '9c982ccf2ec4968cc0cd55f12af4660c',
        message: '72',
        signature: '92a009a9f0d4cab8720e820b5f642540'
          + 'a2b27b5416503f8fb3762223ebdb69da'
          + '085ac1e43e15996e458f3613d0f11d8c'
          + '387b2eaeb4302aeeb00d291612bb0c00',
      },
    ];
    for (const vector of vectors) {
      const publicKey = hex(vector.publicKey);
      const message = hex(vector.message);
      const signature = hex(vector.signature);
      expect(verifyEd25519(publicKey, message, signature)).toBe(true);
      const tampered = signature.slice();
      tampered[0] = tampered[0]! ^ 1;
      expect(verifyEd25519(publicKey, message, tampered)).toBe(false);
    }
    const identity = new Uint8Array(32);
    identity[0] = 1;
    expect(verifyEd25519(identity, new Uint8Array(), new Uint8Array(64))).toBe(false);
  });

  it('matches every published cross-language submission vector byte for byte', () => {
    const fixture = JSON.parse(readFileSync(
      new URL(
        '../fixtures/signatures/gaos.submission.ed25519.v1.vectors.json',
        import.meta.url,
      ),
      'utf8',
    )) as {
      roster: Parameters<typeof submissionRosterHashV1>[0];
      rosterHash: string;
      vectors: Array<{
        envelope: Parameters<typeof submissionPreimageV1>[0];
        preimageHex: string;
        signature: string;
        publicKey: string;
        chainHash: string;
      }>;
    };
    expect(submissionRosterHashV1(fixture.roster)).toBe(fixture.rosterHash);
    for (const vector of fixture.vectors) {
      expect(Buffer.from(submissionPreimageV1(vector.envelope)).toString('hex'))
        .toBe(vector.preimageHex);
      expect(submissionChainHashV1(vector.envelope)).toBe(vector.chainHash);
      expect(verifyEd25519Base64(
        vector.publicKey,
        submissionPreimageV1(vector.envelope),
        vector.signature,
      )).toBe(true);
    }
  });

  it('signs with WebCrypto and verifies with the synchronous implementation', async () => {
    const pair = await generateSubmissionKeyPair();
    const publicKey = await exportSubmissionPublicKey(pair.publicKey);
    const message = new TextEncoder().encode('portable evidence');
    const signature = await signEd25519Base64(pair.privateKey, message);
    expect(verifyEd25519Base64(publicKey, message, signature)).toBe(true);
    expect(signatureBytesToBase64(
      signatureBytesFromBase64(signature, 'sig', 64),
    )).toBe(signature);
  });

  it('binds canonical commands, chain links, and order-independent rosters', async () => {
    const pair = await generateSubmissionKeyPair();
    const publicKey = await exportSubmissionPublicKey(pair.publicKey);
    const seats = [
      {
        id: 'zulu',
        publicKey,
        alg: SUBMISSION_SIGNATURE_ALGORITHM,
        signingTier: { N: 100 },
      },
      {
        id: 'alpha',
        publicKey,
        alg: SUBMISSION_SIGNATURE_ALGORITHM,
        signingTier: { N: 10 },
      },
    ];
    const rosterHash = submissionRosterHashV1(seats);
    expect(submissionRosterHashV1([...seats].reverse())).toBe(rosterHash);
    const genesis = submissionGenesisHashV1('session-1', 'alpha', rosterHash);
    const envelope = {
      sessionId: 'session-1',
      seat: 'alpha',
      submissionId: 'alpha-1',
      cursor: 0,
      tick: 0,
      clientTime: 1_785_032_000_000,
      command: { move: '😀', amount: 1 },
      prevChainHash: genesis,
    };
    expect(submissionPreimageV1(envelope)).toEqual(submissionPreimageV1({
      ...envelope,
      command: { amount: 1, move: '😀' },
    }));
    expect(submissionChainHashV1(envelope)).not.toBe(genesis);
    expect(submissionGenesisHashV1('session-2', 'alpha', rosterHash)).not.toBe(genesis);
  });

  it('rechecks complete chains, periodic coverage, suppression, and tampering', async () => {
    const pair = await generateSubmissionKeyPair();
    const publicKey = await exportSubmissionPublicKey(pair.publicKey);
    const seatKeys = [{
      id: 'red',
      publicKey,
      alg: SUBMISSION_SIGNATURE_ALGORITHM,
      signingTier: { N: 2 },
    }];
    const rosterHash = submissionRosterHashV1(seatKeys);
    const first = {
      sessionId: 'signed-session',
      seat: 'red',
      submissionId: 'red-0',
      cursor: 0,
      tick: 0,
      clientTime: 1_785_032_000_000,
      command: { move: 1 },
      prevChainHash: submissionGenesisHashV1('signed-session', 'red', rosterHash),
    };
    const firstSignature = await signSubmissionV1(pair.privateKey, first);
    const second = {
      ...first,
      submissionId: 'red-1',
      cursor: 1,
      tick: 2,
      clientTime: first.clientTime + 2_000,
      command: { move: 2 },
      prevChainHash: submissionChainHashV1(first),
    };
    const head = submissionChainHashV1(second);
    const periodic = {
      sessionId: first.sessionId,
      seat: first.seat,
      tick: second.tick,
      clientTime: second.clientTime,
      chainHead: head,
    };
    const periodicSignature = await signPeriodicChainHeadV1(pair.privateKey, periodic);
    const inputs = [
      {
        wireId: 'Action 1',
        canonicalId: 'Action 1',
        seat: 'red',
        submissionId: first.submissionId,
        canonicalCommand: JSON.stringify(first.command),
        cursor: first.cursor,
        clientTime: first.clientTime,
        prevChainHash: first.prevChainHash,
        sig: firstSignature,
      },
      {
        wireId: 'Action 1',
        canonicalId: 'Action 1',
        seat: 'red',
        submissionId: second.submissionId,
        canonicalCommand: JSON.stringify(second.command),
        cursor: second.cursor,
        clientTime: second.clientTime,
        prevChainHash: second.prevChainHash,
      },
    ];
    const records: ReplayRecord[] = [
      {
        kind: 'resolution',
        n: 0,
        levelIndex: 0,
        tick: 0,
        inputs: [inputs[0]!],
        cause: 'complete',
      },
      {
        kind: 'resolution',
        n: 1,
        levelIndex: 0,
        tick: 2,
        inputs: [inputs[1]!],
        cause: 'complete',
      },
      {
        kind: 'seat-signature',
        n: 2,
        levelIndex: 0,
        tick: 2,
        participantId: 'red',
        clientTime: periodic.clientTime,
        prevChainHash: head,
        sig: periodicSignature,
      },
    ];
    const artifact = createReplayArtifact({
      sessionId: first.sessionId,
      game: {
        id: 'signature-test',
        version: '1',
        adapter: { id: 'signature-test', version: '1' },
      },
      seed: 1,
      seedPolicy: 'explicit',
      perm: [0],
      levels: [{
        id: 'level',
        seed: 1,
        level: {},
        result: { status: 'won', stars: 1, actionsUsed: 2 },
      }],
      actions: inputs.map((input, n) => ({
        ...input,
        n,
        levelIndex: 0,
        tick: n === 0 ? 0 : 2,
      })),
      records,
      seatKeys,
      signaturePolicy: { scheme: 'gaos.submission.ed25519.v1' },
    });
    expect(artifact.header.formatVersion).toBe('1.3');
    expect(recheckReplaySignatures(artifact)).toMatchObject({
      state: 'signed',
      problems: [],
      seats: [{
        seat: 'red',
        submissions: 2,
        validSignatures: 2,
        chainReproduced: true,
        policySatisfied: true,
        chainHead: head,
      }],
    });
    const v12 = structuredClone(artifact);
    v12.header.formatVersion = '1.2';
    expect(recheckReplaySignatures(v12)).toMatchObject({
      state: 'signed',
      problems: [],
    });

    const suppressed = structuredClone(artifact);
    suppressed.records!.pop();
    suppressed.actions = suppressed.actions;
    expect(recheckReplaySignatures(suppressed).state).toBe('partial');
    expect(recheckReplaySignatures(suppressed).problems.join('\n')).toMatch(
      /no signed chain head|exceeds signingTier\.N=2/,
    );

    const tampered = structuredClone(artifact);
    const tamperedInput = (
      tampered.records![0] as Extract<ReplayRecord, { kind: 'resolution' }>
    ).inputs[0]!;
    tamperedInput.canonicalCommand = '{"move":9}';
    expect(recheckReplaySignatures(tampered).state).toBe('partial');
    expect(recheckReplaySignatures(tampered).problems.join('\n')).toMatch(
      /invalid Ed25519 signature/,
    );

    for (const mutate of [
      (input: typeof tamperedInput) => { input.submissionId = 'other-id'; },
      (input: typeof tamperedInput) => { input.cursor = 9; },
      (input: typeof tamperedInput) => { input.clientTime = first.clientTime + 1; },
    ]) {
      const changed = structuredClone(artifact);
      const input = (
        changed.records![0] as Extract<ReplayRecord, { kind: 'resolution' }>
      ).inputs[0]!;
      mutate(input);
      expect(recheckReplaySignatures(changed).state).toBe('partial');
    }
    const changedTick = structuredClone(artifact);
    (changedTick.records![0] as Extract<ReplayRecord, { kind: 'resolution' }>).tick = 1;
    expect(recheckReplaySignatures(changedTick).state).toBe('partial');

    const reattributed = structuredClone(artifact);
    (
      reattributed.records![0] as Extract<ReplayRecord, { kind: 'resolution' }>
    ).inputs[0]!.seat = 'blue';
    expect(recheckReplaySignatures(reattributed).problems.join('\n')).toMatch(
      /outside header\.seatKeys/,
    );

    const deleted = structuredClone(artifact);
    deleted.records!.shift();
    expect(recheckReplaySignatures(deleted).state).toBe('partial');
    const reordered = structuredClone(artifact);
    [reordered.records![0], reordered.records![1]] = [
      reordered.records![1]!,
      reordered.records![0]!,
    ];
    expect(recheckReplaySignatures(reordered).state).toBe('partial');

    const selfConsistentTruncation = structuredClone(artifact);
    selfConsistentTruncation.records = [selfConsistentTruncation.records![0]!];
    selfConsistentTruncation.actions = [selfConsistentTruncation.actions[0]!];
    expect(recheckReplaySignatures(selfConsistentTruncation)).toMatchObject({
      state: 'signed',
      problems: [],
    });

    const forgedRejection = structuredClone(artifact);
    forgedRejection.records!.push({
      kind: 'commit-mismatch',
      n: 3,
      levelIndex: 0,
      tick: 3,
      participantId: 'red',
      submissionId: 'forged-reveal',
      commitmentId: 0,
      scheme: 'gaos.commit.sha256.v1',
      attemptedReveal: {
        salt: '00'.repeat(16),
        payload: { move: 9 },
      },
      canonicalCommand: '{"kind":"reveal"}',
      cursor: 3,
      clientTime: second.clientTime + 1,
      prevChainHash: head,
    });
    expect(recheckReplaySignatures(forgedRejection).problems.join('\n')).toMatch(
      /requires a tier-1 signature/,
    );

    const substituted = structuredClone(artifact) as ReplayArtifact<unknown>;
    const other = await generateSubmissionKeyPair();
    substituted.header.seatKeys = [{
      ...seatKeys[0]!,
      publicKey: await exportSubmissionPublicKey(other.publicKey),
    }];
    expect(recheckReplaySignatures(substituted).state).toBe('partial');
    expect(recheckReplaySignatures(substituted).problems.join('\n')).toMatch(
      /does not reproduce/,
    );
  });

  it('invalidates every seat chain after one roster-key substitution', async () => {
    const pair = await generateSubmissionKeyPair();
    const publicKey = await exportSubmissionPublicKey(pair.publicKey);
    const seatKeys = ['red', 'blue'].map((id) => ({
      id,
      publicKey,
      alg: SUBMISSION_SIGNATURE_ALGORITHM,
      signingTier: { N: 10 },
    }));
    const rosterHash = submissionRosterHashV1(seatKeys);
    const inputs = await Promise.all(seatKeys.map(async ({ id }) => {
      const envelope = {
        sessionId: 'two-seat-roster',
        seat: id,
        submissionId: `${id}-0`,
        cursor: 0,
        tick: 0,
        clientTime: 1_785_032_000_000,
        command: { move: id },
        prevChainHash: submissionGenesisHashV1(
          'two-seat-roster',
          id,
          rosterHash,
        ),
      };
      return {
        wireId: 'Action 1',
        canonicalId: 'Action 1',
        seat: id,
        submissionId: envelope.submissionId,
        canonicalCommand: JSON.stringify(envelope.command),
        cursor: 0,
        clientTime: envelope.clientTime,
        prevChainHash: envelope.prevChainHash,
        sig: await signSubmissionV1(pair.privateKey, envelope),
      };
    }));
    const artifact = createReplayArtifact({
      sessionId: 'two-seat-roster',
      game: {
        id: 'signature-test',
        version: '1',
        adapter: { id: 'signature-test', version: '1' },
      },
      seed: 1,
      seedPolicy: 'explicit',
      perm: [0],
      levels: [{
        id: 'level',
        seed: 1,
        level: {},
        result: { status: 'won', stars: 1, actionsUsed: 2 },
      }],
      actions: inputs.map((input, n) => ({ ...input, n, levelIndex: 0, tick: 0 })),
      records: [{
        kind: 'resolution',
        n: 0,
        levelIndex: 0,
        tick: 0,
        inputs,
        cause: 'complete',
      }],
      seatKeys,
      signaturePolicy: { scheme: 'gaos.submission.ed25519.v1' },
    });
    expect(recheckReplaySignatures(artifact).state).toBe('signed');
    const reordered = structuredClone(artifact);
    reordered.header.seatKeys = [...reordered.header.seatKeys!].reverse();
    expect(recheckReplaySignatures(reordered).state).toBe('signed');

    const other = await generateSubmissionKeyPair();
    const otherPublicKey = await exportSubmissionPublicKey(other.publicKey);
    const substituted = structuredClone(artifact);
    substituted.header.seatKeys = substituted.header.seatKeys!.map((entry) =>
      entry.id === 'red'
        ? {
          ...entry,
          publicKey: otherPublicKey,
        }
        : entry);
    const check = recheckReplaySignatures(substituted);
    expect(check.state).toBe('partial');
    expect(check.seats).toEqual(expect.arrayContaining([
      expect.objectContaining({ seat: 'red', chainReproduced: false }),
      expect.objectContaining({ seat: 'blue', chainReproduced: false }),
    ]));
  });

  it('authenticates a rejected reveal end to end', async () => {
    type Command =
      | { kind: 'commit'; commitmentId: number; hash: string }
      | { kind: 'reveal'; commitmentId: number; salt: string; payload: { move: number } }
      | { kind: 'win' };
    interface State { actionsUsed: number; won: boolean }
    const reducer: TickReducer<{}, State> = {
      init: () => ({ actionsUsed: 0, won: false }),
      advance: (state, actions) => ({
        actionsUsed: state.actionsUsed + 1,
        won: state.won || actions.some((action) =>
          action.commit === undefined && action.reveal === undefined),
      }),
      view: (state): TickView => ({
        actions: [{ id: 'Action 1', params: 'none' }],
        status: state.won ? 'won' : 'playing',
        ...(state.won ? { stars: 1 } : {}),
        participation: { mode: 'sequential', activeSeat: 'red' },
        hud: { actionsUsed: state.actionsUsed },
      }),
    };
    const sessionId = 'signed-rejection';
    const salt = '11'.repeat(16);
    const committedPayload = { move: 1 };
    const attemptedPayload = { move: 9 };
    const commitmentHash = createCommitmentHash({
      sessionId,
      seat: 'red',
      commitmentId: 0,
      windowRef: 0,
    }, salt, committedPayload);
    const commandToAction = (command: Command) => command.kind === 'commit'
      ? {
        id: 'Action 1',
        commit: {
          commitmentId: command.commitmentId,
          scheme: 'gaos.commit.sha256.v1' as const,
          hash: command.hash,
        },
      }
      : command.kind === 'reveal'
        ? {
          id: 'Action 1',
          reveal: {
            commitmentId: command.commitmentId,
            salt: command.salt,
            payload: command.payload,
          },
        }
        : { id: 'Action 1' };
    const pair = await generateSubmissionKeyPair();
    const seatKeys = [{
      id: 'red',
      publicKey: await exportSubmissionPublicKey(pair.publicKey),
      alg: SUBMISSION_SIGNATURE_ALGORITHM,
      signingTier: { N: 10 },
    }];
    const rosterHash = submissionRosterHashV1(seatKeys);
    const kernel = createSessionKernel({
      sessionId,
      game: {
        id: 'signed-rejection',
        version: '1',
        adapter: { id: 'signed-rejection', version: '1' },
      },
      levelId: 'one',
      reducer,
      level: {},
      seed: 1,
      seedPolicy: 'explicit',
      seats: ['red'],
      cadence: { mode: 'turns' },
      hostTime: 'none',
      seatKeys,
      signaturePolicy: { scheme: 'gaos.submission.ed25519.v1' },
      commandToAction,
    });
    let chainHead = submissionGenesisHashV1(sessionId, 'red', rosterHash);
    const submit = async (
      submissionId: string,
      command: Command,
      clientTime: number,
    ) => {
      const envelope = {
        sessionId,
        seat: 'red',
        submissionId,
        cursor: kernel.cursor(),
        tick: kernel.tick(),
        clientTime,
        command,
        prevChainHash: chainHead,
      };
      const submission = {
        protocol: PROTOCOL_ID,
        protocolVersion: PROTOCOL_VERSION,
        sessionId,
        tickId: makeTickId(sessionId, kernel.cursor()),
        revision: kernel.cursor(),
        participantId: 'red',
        submissionId,
        command,
        clientTime,
        prevChainHash: chainHead,
        sig: await signSubmissionV1(pair.privateKey, envelope),
      } as const;
      chainHead = submissionChainHashV1(envelope);
      kernel.commit(kernel.prepareIngest(submission));
    };
    await submit('commit-0', {
      kind: 'commit',
      commitmentId: 0,
      hash: commitmentHash,
    }, 1_785_032_000_000);
    kernel.commit(kernel.prepareAdvance());
    await submit('bad-reveal-0', {
      kind: 'reveal',
      commitmentId: 0,
      salt,
      payload: attemptedPayload,
    }, 1_785_032_001_000);
    kernel.commit(kernel.prepareAdvance());
    await submit('win-0', { kind: 'win' }, 1_785_032_002_000);
    kernel.commit(kernel.prepareAdvance());

    const artifact = finalizeReplay(kernel.liveTranscript(), { perm: [0] });
    const { recheckReplayArtifact } = await import('../src/engine/index.js');
    expect(recheckReplayArtifact(artifact, () => reducer, {
      semanticAdapterForLevel: () => ({
        commandToAction: (command) => commandToAction(command as Command),
      }),
    })).toMatchObject({
      ok: true,
      verdict: 'trusted',
      signatures: { state: 'signed', problems: [] },
      semantics: { submissions: 'verified' },
    });
    const stripped = structuredClone(artifact);
    const mismatch = stripped.records?.find((record) => record.kind === 'commit-mismatch');
    if (mismatch?.kind === 'commit-mismatch') delete mismatch.sig;
    expect(recheckReplayArtifact(stripped, () => reducer, {
      semanticAdapterForLevel: () => ({
        commandToAction: (command) => commandToAction(command as Command),
      }),
    }).verdict).toBe('rejected');
  });

  it('projects a live signed kernel session into a trusted v1.3 artifact', async () => {
    interface State { actionsUsed: number }
    const reducer: TickReducer<{}, State> = {
      init: () => ({ actionsUsed: 0 }),
      advance: (state) => ({ actionsUsed: state.actionsUsed + 1 }),
      view: (state): TickView => ({
        actions: [{ id: 'Action 1', params: 'none' }],
        status: state.actionsUsed > 0 ? 'won' : 'playing',
        ...(state.actionsUsed > 0 ? { stars: 1 } : {}),
        participation: { mode: 'sequential', activeSeat: 'red' },
        hud: { actionsUsed: state.actionsUsed },
      }),
    };
    const pair = await generateSubmissionKeyPair();
    const publicKey = await exportSubmissionPublicKey(pair.publicKey);
    const seatKeys = [{
      id: 'red',
      publicKey,
      alg: SUBMISSION_SIGNATURE_ALGORITHM,
      signingTier: { N: 100 },
    }];
    const sessionId = 'live-signed-session';
    const command = { move: 1 } as const;
    const envelope = {
      sessionId,
      seat: 'red',
      submissionId: 'red-0',
      cursor: 0,
      tick: 0,
      clientTime: 1_785_032_000_000,
      command,
      prevChainHash: submissionGenesisHashV1(
        sessionId,
        'red',
        submissionRosterHashV1(seatKeys),
      ),
    };
    const kernel = createSessionKernel({
      sessionId,
      game: {
        id: 'signed-test',
        version: '1',
        adapter: { id: 'signed-test', version: '1' },
      },
      levelId: 'one',
      reducer,
      level: {},
      seed: 1,
      seedPolicy: 'explicit',
      seats: ['red'],
      cadence: { mode: 'turns' },
      hostTime: 'none',
      seatKeys,
      signaturePolicy: { scheme: 'gaos.submission.ed25519.v1' },
      commandToAction: () => ({ id: 'Action 1' }),
    });
    kernel.commit(kernel.prepareIngest({
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId,
      tickId: makeTickId(sessionId, 0),
      revision: 0,
      participantId: 'red',
      submissionId: envelope.submissionId,
      command,
      clientTime: envelope.clientTime,
      prevChainHash: envelope.prevChainHash,
      sig: await signSubmissionV1(pair.privateKey, envelope),
    }));
    kernel.commit(kernel.prepareAdvance());
    const artifact = finalizeReplay(kernel.liveTranscript(), { perm: [0] });
    expect(artifact.header.formatVersion).toBe('1.3');
    const result = (await import('../src/engine/index.js')).recheckReplayArtifact(
      artifact,
      () => reducer,
      {
        semanticAdapterForLevel: () => ({
          commandToAction: () => ({ id: 'Action 1' }),
        }),
      },
    );
    expect(result).toMatchObject({
      ok: true,
      verdict: 'trusted',
      signatures: { state: 'signed', problems: [] },
      semantics: { submissions: 'verified' },
    });
    const missingAdapter = (await import('../src/engine/index.js')).recheckReplayArtifact(
      artifact,
      () => reducer,
    );
    expect(missingAdapter).toMatchObject({
      ok: true,
      verdict: 'unverifiable',
      semantics: { submissions: 'unavailable' },
    });
    const mismatchedAdapter = (await import('../src/engine/index.js')).recheckReplayArtifact(
      artifact,
      () => reducer,
      {
        semanticAdapterForLevel: () => ({
          commandToAction: () => ({ id: 'Other action' }),
        }),
      },
    );
    expect(mismatchedAdapter).toMatchObject({
      ok: true,
      verdict: 'rejected',
      semantics: { submissions: 'failed' },
    });

    const unsignedKernel = createSessionKernel({
      sessionId: 'declared-signed-but-legacy-client',
      game: {
        id: 'signed-test',
        version: '1',
        adapter: { id: 'signed-test', version: '1' },
      },
      levelId: 'one',
      reducer,
      level: {},
      seed: 1,
      seedPolicy: 'explicit',
      seats: ['red'],
      cadence: { mode: 'turns' },
      hostTime: 'none',
      seatKeys,
      signaturePolicy: { scheme: 'gaos.submission.ed25519.v1' },
      commandToAction: () => ({ id: 'Action 1' }),
    });
    unsignedKernel.commit(unsignedKernel.prepareIngest({
      protocol: PROTOCOL_ID,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: 'declared-signed-but-legacy-client',
      tickId: makeTickId('declared-signed-but-legacy-client', 0),
      revision: 0,
      participantId: 'red',
      submissionId: 'legacy-0',
      command,
    }));
    unsignedKernel.commit(unsignedKernel.prepareAdvance());
    const partialArtifact = finalizeReplay(unsignedKernel.liveTranscript(), { perm: [0] });
    expect((await import('../src/engine/index.js')).recheckReplayArtifact(
      partialArtifact,
      () => reducer,
      {
        semanticAdapterForLevel: () => ({
          commandToAction: () => ({ id: 'Action 1' }),
        }),
      },
    )).toMatchObject({
      ok: true,
      verdict: 'rejected',
      signatures: { state: 'partial' },
      semantics: { submissions: 'verified' },
    });
  });

  it('recomputes timeout actions and enforces the declared tick position', async () => {
    interface State { actionsUsed: number }
    const reducer: TickReducer<{}, State> = {
      init: () => ({ actionsUsed: 0 }),
      advance: (state) => ({ actionsUsed: state.actionsUsed + 1 }),
      view: (state): TickView => ({
        actions: [{ id: 'Action 1', params: 'none' }],
        status: state.actionsUsed > 0 ? 'won' : 'playing',
        ...(state.actionsUsed > 0 ? { stars: 1 } : {}),
        participation: { mode: 'sequential', activeSeat: 'red' },
        hud: { actionsUsed: state.actionsUsed },
      }),
    };
    const pair = await generateSubmissionKeyPair();
    const seatKeys = [{
      id: 'red',
      publicKey: await exportSubmissionPublicKey(pair.publicKey),
      alg: SUBMISSION_SIGNATURE_ALGORITHM,
      signingTier: { N: 100 },
    }];
    const timeoutToAction = () => ({ id: 'Action 1', seat: 'red' });
    const kernel = createSessionKernel({
      sessionId: 'signed-timeout-session',
      game: {
        id: 'signed-test',
        version: '1',
        adapter: { id: 'signed-test', version: '1' },
      },
      levelId: 'one',
      reducer,
      level: {},
      seed: 1,
      seedPolicy: 'explicit',
      seats: ['red'],
      cadence: { mode: 'ticks', rate: createTickRate(30) },
      hostTime: 'none',
      seatKeys,
      signaturePolicy: { scheme: 'gaos.submission.ed25519.v1' },
      timeoutPolicy: { mode: 'ticks', windowTicks: 3 },
      timeoutToAction,
      commandToAction: () => ({ id: 'Action 1' }),
    });
    const waiting = kernel.prepareAdvance(2);
    expect(waiting).toMatchObject({
      baseTransitionRevision: 0,
      nextTransitionRevision: 0,
      events: [],
      result: { resolutions: 0, tick: 0 },
    });
    kernel.commit(waiting);
    expect(() => kernel.prepareAdvance(3)).toThrow(/prepareTimeout is required/);
    const prepared = kernel.prepareTimeout({
      timeoutId: 'red-0',
      tick: 3,
      participantId: 'red',
      reason: 'elapsed',
      timeoutPolicyRef: GAOS_TIMEOUT_POLICY_REF,
    });
    kernel.commit(prepared);
    const artifact = finalizeReplay(kernel.liveTranscript(), { perm: [0] });
    const { recheckReplayArtifact } = await import('../src/engine/index.js');
    const timeoutResult = recheckReplayArtifact(artifact, () => reducer, {
      semanticAdapterForLevel: () => ({ timeoutToAction }),
    });
    expect(timeoutResult).toMatchObject({
      ok: true,
      verdict: 'trusted',
      semantics: { submissions: 'not_applicable', timeouts: 'verified' },
    });

    const early = structuredClone(artifact);
    const timeout = early.records?.find((record) => record.kind === 'timeout');
    if (timeout?.kind === 'timeout') timeout.tick = 2;
    expect(recheckReplayArtifact(early, () => reducer).verdict).toBe('rejected');

    expect(recheckReplayArtifact(artifact, () => reducer, {
      semanticAdapterForLevel: () => ({
        timeoutToAction: () => ({ id: 'Different action', seat: 'red' }),
      }),
    })).toMatchObject({
      ok: true,
      verdict: 'rejected',
      semantics: { timeouts: 'failed' },
    });
  });
});
