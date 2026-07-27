import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  controllerHandoffPreimageV2,
  externalAttestationPreimage,
  periodicSignaturePreimageV2,
  submissionChainHashV2,
  submissionEpochGenesisHashV2,
  submissionPreimageV2,
  verifyDynamicControlEvidenceV2,
  verifyExternalAttestation,
  type ControllerEpochGenesisV2,
  type ControllerHandoffV2,
  type ExternalAttestation,
  type ExternalTrustPolicy,
  type SubmissionSigningEnvelopeV2,
} from '../src/evidence.js';
import {
  exportSubmissionPublicKey,
  generateSubmissionKeyPair,
  signEd25519Base64,
  verifyEd25519Base64,
} from '../src/engine/submission-signatures.js';
import {
  HOST_CONFORMANCE_VERSION,
  RFC014_HOST_CONFORMANCE_FIXTURES,
  RFC014_HOST_CONFORMANCE_SCENARIOS,
  runHostConformance,
  runReferenceHostConformance,
  type HostConformanceFixture,
} from '../src/ecosystem.js';
import { PresentationClient } from '../src/presentation-client.js';
import { SeatControlLedger } from '../src/seat-control.js';
import { canonicalJson } from '../src/protocol.js';

interface V2Vectors {
  publicKey: string;
  genesis: ControllerEpochGenesisV2;
  genesisHash: string;
  command: {
    envelope: SubmissionSigningEnvelopeV2;
    preimageHex: string;
    signature: string;
    chainHash: string;
  };
  handoff: {
    envelope: ControllerHandoffV2;
    preimageHex: string;
    outgoingSignature: string;
  };
}

const vectors = JSON.parse(readFileSync(
  new URL('../fixtures/signatures/gaos.submission.ed25519.v2.vectors.json', import.meta.url),
  'utf8',
)) as V2Vectors;

describe('RFC-014 release gate', () => {
  it('matches the cross-language v2 golden preimages, chain hashes, and signatures', () => {
    expect(submissionEpochGenesisHashV2(vectors.genesis)).toBe(vectors.genesisHash);
    expect(Buffer.from(submissionPreimageV2(vectors.command.envelope)).toString('hex'))
      .toBe(vectors.command.preimageHex);
    expect(submissionChainHashV2(vectors.command.envelope)).toBe(vectors.command.chainHash);
    expect(verifyEd25519Base64(
      vectors.publicKey,
      submissionPreimageV2(vectors.command.envelope),
      vectors.command.signature,
    )).toBe(true);
    expect(Buffer.from(controllerHandoffPreimageV2(vectors.handoff.envelope)).toString('hex'))
      .toBe(vectors.handoff.preimageHex);
    expect(verifyEd25519Base64(
      vectors.publicKey,
      controllerHandoffPreimageV2(vectors.handoff.envelope),
      vectors.handoff.outgoingSignature,
    )).toBe(true);
  });

  it('verifies signed voluntary transfer and exact-revision controller authority', async () => {
    const outgoing = await generateSubmissionKeyPair();
    const incoming = await generateSubmissionKeyPair();
    const outgoingPublic = await exportSubmissionPublicKey(outgoing.publicKey);
    const incomingPublic = await exportSubmissionPublicKey(incoming.publicKey);
    const ledger = new SeatControlLedger('session', {
      alpha: {
        controllerId: 'human',
        kind: 'human',
        publicKey: outgoingPublic,
        signingTier: { N: 10 },
      },
    });
    const genesisEpoch = ledger.current('alpha');
    const genesisHead = submissionEpochGenesisHashV2({
      sessionId: 'session',
      seat: 'alpha',
      epoch: 0,
      controllerId: 'human',
      publicKey: outgoingPublic,
      transitionDigest: genesisEpoch.digest,
    });
    const envelope: SubmissionSigningEnvelopeV2 = {
      sessionId: 'session',
      seat: 'alpha',
      epoch: 0,
      transitionRevision: 0,
      submissionId: 'a-0',
      cursor: 0,
      tick: 1,
      clientTime: 1,
      command: { move: 1 },
      prevChainHash: genesisHead,
    };
    const signature = await signEd25519Base64(
      outgoing.privateKey,
      submissionPreimageV2(envelope),
    );
    const chainHead = submissionChainHashV2(envelope);
    const handoff: ControllerHandoffV2 = {
      schema: 'gaos.controller-handoff.v2',
      sessionId: 'session',
      seat: 'alpha',
      outgoingEpoch: 0,
      outgoingChainHead: chainHead,
      incomingEpoch: 1,
      incomingControllerId: 'agent',
      incomingPublicKey: incomingPublic,
      effectiveTransitionRevision: 1,
    };
    const handoffBytes = controllerHandoffPreimageV2(handoff);
    const prepared = ledger.prepareSeatControl([{
      seat: 'alpha',
      status: 'occupied',
      controller: {
        controllerId: 'agent',
        kind: 'agent',
        publicKey: incomingPublic,
        signingTier: { N: 10 },
      },
      reason: 'transferred',
      previousChainHead: chainHead,
    }], {
      mode: 'controller-handoff',
      outgoingSignatures: {
        alpha: await signEd25519Base64(outgoing.privateKey, handoffBytes),
      },
      incomingSignatures: {
        alpha: await signEd25519Base64(incoming.privateKey, handoffBytes),
      },
    });
    ledger.commit(prepared);
    const incomingEpoch = ledger.current('alpha');
    const incomingGenesisHead = submissionEpochGenesisHashV2({
      sessionId: 'session',
      seat: 'alpha',
      epoch: 1,
      controllerId: 'agent',
      publicKey: incomingPublic,
      transitionDigest: incomingEpoch.digest,
      previousEpochDigest: incomingEpoch.previousEpochDigest,
      previousChainHead: chainHead,
    });
    const periodicEnvelope = {
      sessionId: 'session',
      seat: 'alpha',
      epoch: 0,
      tick: 1,
      clientTime: 1,
      chainHead,
    };
    const signatureStates = [{
      seat: 'alpha',
      epoch: 0,
      genesisHash: genesisHead,
      lastChainHead: chainHead,
      lastSignedChainHead: chainHead,
      lastPeriodicTick: 1,
      lastPeriodicClientTime: 1,
      lastPeriodicSignature: await signEd25519Base64(
        outgoing.privateKey,
        periodicSignaturePreimageV2(periodicEnvelope),
      ),
    }, {
      seat: 'alpha',
      epoch: 1,
      genesisHash: incomingGenesisHead,
      lastChainHead: incomingGenesisHead,
    }];
    expect(() => ledger.authorize('alpha', 0, undefined, 0)).not.toThrow();
    expect(() => ledger.authorize('alpha', 0, undefined, 1)).toThrow(/inactive/);
    expect(() => ledger.authorize('alpha', 1, undefined, 0)).toThrow(/inactive/);
    expect(() => ledger.authorize('alpha', 1, undefined, 1)).not.toThrow();
    const checked = verifyDynamicControlEvidenceV2({
      format: 'gaos.dynamic-control-evidence.v2',
      sessionId: 'session',
      checkpoint: {
        format: 'gaos.dynamic-control-checkpoint.v2',
        sessionId: 'session',
        control: ledger.checkpoint(),
        signatureStates,
      },
      commands: [{ envelope, signature }],
    });
    expect(checked).toMatchObject({
      valid: true,
      commandsValid: true,
      controlHistoryValid: true,
    });
    expect(checked.epochs[1]).toMatchObject({
      authorization: 'controller-handoff',
      authorizationValid: true,
    });
    const invalidPeriodicStates = structuredClone(signatureStates);
    invalidPeriodicStates[0]!.lastPeriodicSignature = signature;
    expect(verifyDynamicControlEvidenceV2({
      format: 'gaos.dynamic-control-evidence.v2',
      sessionId: 'session',
      checkpoint: {
        format: 'gaos.dynamic-control-checkpoint.v2',
        sessionId: 'session',
        control: ledger.checkpoint(),
        signatureStates: invalidPeriodicStates,
      },
      commands: [{ envelope, signature }],
    }).valid).toBe(false);
    const fabricatedHead = Buffer.alloc(32, 9).toString('base64');
    const fabricatedStates = structuredClone(signatureStates);
    fabricatedStates[0]!.lastSignedChainHead = fabricatedHead;
    fabricatedStates[0]!.lastPeriodicSignature = await signEd25519Base64(
      outgoing.privateKey,
      periodicSignaturePreimageV2({ ...periodicEnvelope, chainHead: fabricatedHead }),
    );
    expect(verifyDynamicControlEvidenceV2({
      format: 'gaos.dynamic-control-evidence.v2',
      sessionId: 'session',
      checkpoint: {
        format: 'gaos.dynamic-control-checkpoint.v2',
        sessionId: 'session',
        control: ledger.checkpoint(),
        signatureStates: fabricatedStates,
      },
      commands: [{ envelope, signature }],
    }).valid).toBe(false);
    const stale = structuredClone(envelope);
    stale.transitionRevision = 1;
    expect(verifyDynamicControlEvidenceV2({
      format: 'gaos.dynamic-control-evidence.v2',
      sessionId: 'session',
      checkpoint: {
        format: 'gaos.dynamic-control-checkpoint.v2',
        sessionId: 'session',
        control: ledger.checkpoint(),
        signatureStates,
      },
      commands: [{ envelope: stale, signature }],
    }).valid).toBe(false);

    const forgedControl = structuredClone(ledger.checkpoint());
    const forgedIncoming = forgedControl.epochs.find((epoch) => epoch.epoch === 1)!;
    forgedIncoming.previousChainHead = genesisHead;
    const forgedHandoff = {
      ...handoff,
      outgoingChainHead: genesisHead,
    };
    const forgedHandoffBytes = controllerHandoffPreimageV2(forgedHandoff);
    forgedIncoming.authorizationEvidence = {
      mode: 'controller-handoff',
      outgoingSignatures: {
        alpha: await signEd25519Base64(outgoing.privateKey, forgedHandoffBytes),
      },
      incomingSignatures: {
        alpha: await signEd25519Base64(incoming.privateKey, forgedHandoffBytes),
      },
    };
    const { digest: _oldDigest, ...forgedIncomingBase } = forgedIncoming;
    forgedIncoming.digest = createHash('sha256')
      .update(canonicalJson(forgedIncomingBase as never))
      .digest('hex');
    const forgedIncomingGenesis = submissionEpochGenesisHashV2({
      sessionId: 'session',
      seat: 'alpha',
      epoch: 1,
      controllerId: 'agent',
      publicKey: incomingPublic,
      transitionDigest: forgedIncoming.digest,
      previousEpochDigest: forgedIncoming.previousEpochDigest,
      previousChainHead: genesisHead,
    });
    const forged = verifyDynamicControlEvidenceV2({
      format: 'gaos.dynamic-control-evidence.v2',
      sessionId: 'session',
      checkpoint: {
        format: 'gaos.dynamic-control-checkpoint.v2',
        sessionId: 'session',
        control: forgedControl,
        signatureStates: [
          signatureStates[0]!,
          {
            seat: 'alpha',
            epoch: 1,
            genesisHash: forgedIncomingGenesis,
            lastChainHead: forgedIncomingGenesis,
          },
        ],
      },
      commands: [{ envelope, signature }],
    });
    expect(forged.valid).toBe(false);
    expect(forged.reasons).toContain(
      'voluntary handoff does not continue exact chain head for alpha:0',
    );
  });

  it('applies product pins, expiry, revocation, and artifact subject binding independently', async () => {
    const pair = await generateSubmissionKeyPair();
    const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey);
    const authority = {
      authorityId: 'organizer',
      keyId: '2026-01',
      purpose: 'witness' as const,
    };
    const unsigned = {
      schema: 'gaos.witness.v1',
      authority,
      subjectDigest: 'artifact-a',
      algorithm: 'Ed25519',
      issuedAt: '2026-07-01T00:00:00Z',
      expiresAt: '2027-01-01T00:00:00Z',
      payload: { observed: true },
    };
    const attestation: ExternalAttestation = {
      ...unsigned,
      signature: await signEd25519Base64(
        pair.privateKey,
        externalAttestationPreimage(unsigned),
      ),
    };
    const policy: ExternalTrustPolicy = {
      pinnedKeys: [authority],
      acceptedSchemas: ['gaos.witness.v1'],
      acceptedAlgorithms: ['Ed25519'],
      revocationPolicy: 'require-valid',
    };
    const resolver = {
      resolveKey: async () => ({ format: 'jwk' as const, key: jwk }),
      resolveRevocation: async () => ({ state: 'valid' as const }),
    };
    expect(await verifyExternalAttestation(
      attestation,
      'artifact-a',
      policy,
      resolver,
      new Date('2026-07-27T00:00:00Z'),
    )).toMatchObject({
      cryptographicallyValid: true,
      authorityPinned: true,
      revocationState: 'valid',
      policyAccepted: true,
    });
    expect((await verifyExternalAttestation(
      attestation,
      'artifact-b',
      policy,
      resolver,
    )).policyAccepted).toBe(false);
    expect((await verifyExternalAttestation(
      attestation,
      'artifact-a',
      { ...policy, pinnedKeys: [] },
      resolver,
    )).authorityPinned).toBe(false);
    expect((await verifyExternalAttestation(
      attestation,
      'artifact-a',
      { ...policy, pinnedKeys: [], pinnedRootDigests: ['root-digest'] },
      resolver,
    )).policyAccepted).toBe(false);
    expect(await verifyExternalAttestation(
      attestation,
      'artifact-a',
      { ...policy, pinnedKeys: [], pinnedRootDigests: ['root-digest'] },
      {
        ...resolver,
        verifyCertificatePath: async () => ({
          valid: true,
          matchedRootDigest: 'root-digest',
        }),
      },
    )).toMatchObject({
      authorityPinned: true,
      certificatePathValid: true,
      matchedPin: 'root-digest',
      policyAccepted: true,
    });
    expect((await verifyExternalAttestation(
      attestation,
      'artifact-a',
      policy,
      {
        ...resolver,
        resolveRevocation: async () => ({ state: 'revoked' as const }),
      },
    )).policyAccepted).toBe(false);
    expect((await verifyExternalAttestation(
      { ...attestation, expiresAt: '2020-01-01T00:00:00Z' },
      'artifact-a',
      policy,
      resolver,
    )).policyAccepted).toBe(false);
    const rotated = await generateSubmissionKeyPair();
    const rotatedJwk = await crypto.subtle.exportKey('jwk', rotated.publicKey);
    expect((await verifyExternalAttestation(
      attestation,
      'artifact-a',
      policy,
      {
        ...resolver,
        resolveKey: async () => ({ format: 'jwk' as const, key: rotatedJwk }),
      },
    )).cryptographicallyValid).toBe(false);
  });

  it('checkpoints and rehydrates an in-flight atomic seat-control change', () => {
    const ledger = new SeatControlLedger('prepared', {
      alpha: { controllerId: 'a', kind: 'human' },
      beta: { controllerId: 'b', kind: 'agent' },
    });
    ledger.prepareSeatControl([
      {
        seat: 'alpha',
        status: 'occupied',
        controller: { controllerId: 'b', kind: 'agent' },
        reason: 'transferred',
      },
      {
        seat: 'beta',
        status: 'occupied',
        controller: { controllerId: 'a', kind: 'human' },
        reason: 'transferred',
      },
    ], { mode: 'host-policy', policy: 'atomic recovery' });
    const checkpoint = ledger.checkpoint();
    expect(checkpoint.prepared).toHaveLength(1);
    const duplicatePrepared = structuredClone(checkpoint);
    duplicatePrepared.prepared = [
      duplicatePrepared.prepared![0]!,
      structuredClone(duplicatePrepared.prepared![0]!),
    ];
    expect(() => SeatControlLedger.rehydrate(duplicatePrepared)).toThrow(/at most one/);
    const incompletePrepared = structuredClone(checkpoint);
    incompletePrepared.prepared![0]!.epochs[0]!.authorizationEvidence = {
      mode: 'host-policy',
      policy: '',
    };
    expect(() => SeatControlLedger.rehydrate(incompletePrepared)).toThrow(
      /prepared host policy|prepared epoch digest/,
    );
    const restored = SeatControlLedger.rehydrate(checkpoint);
    const [pending] = restored.preparedTransitions();
    expect(pending?.epochs.map(({ seat }) => seat).sort()).toEqual(['alpha', 'beta']);
    restored.commit(pending!);
    expect(restored.current('alpha').controller?.controllerId).toBe('b');
    expect(restored.current('beta').controller?.controllerId).toBe('a');
  });

  it('executes every versioned host fixture and emits machine-readable facts', async () => {
    const report = await runReferenceHostConformance();
    expect(report.schema).toBe(HOST_CONFORMANCE_VERSION);
    expect(report.scenarios).toHaveLength(RFC014_HOST_CONFORMANCE_SCENARIOS.length);
    expect(report.passed).toBe(true);
    expect(report.scenarios.every(({ details }) => details !== undefined)).toBe(true);
  });

  it('rejects no-op, malformed, echoed, extra, and wrong conformance observations', async () => {
    const [fixture] = RFC014_HOST_CONFORMANCE_FIXTURES;
    const adapter = (execute: (value: HostConformanceFixture) => Promise<unknown>) => ({
      runtime: 'adversarial',
      adapterVersion: '1',
      execute: execute as never,
    });
    for (const execute of [
      async () => undefined,
      async (value: HostConformanceFixture) => value,
      async (value: HostConformanceFixture) => ({
        scenario: value.scenario, executed: true, extra: true,
      }),
      async (value: HostConformanceFixture) => ({ scenario: value.scenario, executed: false }),
    ]) {
      expect((await runHostConformance(adapter(execute), [fixture!])).passed).toBe(false);
    }
    const malformed = { ...structuredClone(fixture!), steps: [] };
    expect((await runHostConformance(
      adapter(async (value) => ({ scenario: value.scenario, executed: true })),
      [malformed],
    )).passed).toBe(false);
    expect('expected' in fixture!).toBe(false);
  });

  it('repairs missing patch bases and never replays old presentation cues', () => {
    const client = new PresentationClient<{ value: number }, { add: number }>({
      applyPatch: (view, patch) => ({ value: view.value + patch.add }),
      digest: (view) => String(view.value),
    });
    expect(client.receive({
      type: 'patch',
      baseTransitionRevision: 0,
      transitionRevision: 1,
      tick: 1,
      patch: { add: 1 },
    }).status).toBe('repair-required');
    client.receive({
      type: 'snapshot',
      transitionRevision: 1,
      tick: 1,
      view: { value: 4 },
      digest: '4',
    });
    expect(client.receive({
      type: 'patch',
      baseTransitionRevision: 1,
      transitionRevision: 2,
      tick: 2,
      patch: { add: 2 },
      digest: '6',
    })).toMatchObject({ status: 'ready', view: { value: 6 } });
    expect(client.receive({ type: 'digest-mismatch', expected: '7', actual: '6' }).status)
      .toBe('repair-required');
  });

  it('publishes versioned schemas, one fixture, all client languages, and authority guides', () => {
    for (const name of [
      'gaos.command-v1.schema.json',
      'gaos.receipt-v1.schema.json',
      'gaos.observation-v1.schema.json',
      'gaos.presentation-frame-v1.schema.json',
      'gaos.replay-reference-v1.schema.json',
      'gaos.seat-control-v2.schema.json',
      'gaos.evidence-verdict-v2.schema.json',
      'gaos.dynamic-control-evidence-v2.schema.json',
    ]) {
      const schema = JSON.parse(readFileSync(
        new URL(`../schemas/${name}`, import.meta.url),
        'utf8',
      )) as { $id?: string };
      expect(schema.$id).toContain(name);
    }
    const fixture = JSON.parse(readFileSync(
      new URL(
        '../fixtures/ecosystem/presentation-client-v1.golden.json',
        import.meta.url,
      ),
      'utf8',
    )) as { schema: string; expected: { entityId: string } };
    expect(fixture).toMatchObject({
      schema: 'gaos.presentation-client-fixture.v1',
      expected: { entityId: 'unit-1' },
    });
    for (const path of [
      '../src/presentation-client.ts',
      '../examples/clients/csharp/GaosPresentation.cs',
      '../examples/clients/cpp/gaos_presentation.hpp',
      '../examples/clients/gdscript/gaos_presentation.gd',
    ]) {
      expect(readFileSync(new URL(path, import.meta.url), 'utf8')).toContain('Presentation');
    }
    const guide = readFileSync(
      new URL('../docs/interoperability.md', import.meta.url),
      'utf8',
    );
    for (const platform of [
      'Nakama',
      'Colyseus',
      'Node.js HTTP/WebSocket',
      'Photon Fusion',
      'Photon Quantum',
      'Unity',
      'Godot',
      'Unreal Engine',
    ]) {
      expect(guide).toContain(platform);
    }
  });

  it('executes the same presentation state machine in TypeScript, C#, C++, and GDScript', () => {
    const fixturePath = fileURLToPath(new URL(
      '../fixtures/ecosystem/presentation-client-v1.golden.json',
      import.meta.url,
    ));
    const expected = (JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      expected: unknown;
    }).expected;
    const temporary = mkdtempSync(join(tmpdir(), 'gaos-clients-'));
    const cppBinary = join(temporary, 'gaos-cpp-client');
    execFileSync(process.env.GAOS_CXX ?? 'c++', [
      '-std=c++17',
      fileURLToPath(new URL('../examples/clients/cpp/run_fixture.cpp', import.meta.url)),
      '-o',
      cppBinary,
    ]);
    const project = fileURLToPath(new URL(
      '../examples/clients/csharp/GaosPresentation.csproj',
      import.meta.url,
    ));
    const artifacts = join(temporary, 'dotnet');
    execFileSync(process.env.GAOS_DOTNET ?? 'dotnet', [
      'build', project, '--artifacts-path', artifacts, '--nologo',
    ]);
    const commands: [string, string[]][] = [
      [process.execPath, [
        fileURLToPath(new URL(
          '../examples/clients/typescript/run-fixture.mjs',
          import.meta.url,
        )),
        fixturePath,
      ]],
      [cppBinary, [fixturePath]],
      [process.env.GAOS_DOTNET ?? 'dotnet', [
        join(artifacts, 'bin/GaosPresentation/debug/GaosPresentation.dll'),
        fixturePath,
      ]],
      [process.env.GAOS_GODOT ?? 'godot', [
        '--headless',
        '--script',
        fileURLToPath(new URL(
          '../examples/clients/gdscript/run_fixture.gd',
          import.meta.url,
        )),
        '--',
        fixturePath,
      ]],
    ];
    for (const [executable, args] of commands) {
      const output = execFileSync(executable, args, { encoding: 'utf8' });
      const jsonLine = output.trim().split('\n').reverse()
        .find((line: string) => line.startsWith('{'));
      expect(JSON.parse(jsonLine!)).toEqual(expected);
    }
  }, 30_000);
});
