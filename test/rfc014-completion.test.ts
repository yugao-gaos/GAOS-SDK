import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  controllerHandoffPreimageV2,
  externalAttestationPreimage,
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
  RFC014_HOST_CONFORMANCE_SCENARIOS,
  runHostConformance,
} from '../src/ecosystem.js';
import { PresentationClient } from '../src/presentation-client.js';
import { SeatControlLedger } from '../src/seat-control.js';

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
    expect(() => ledger.authorize('alpha', 0, undefined, 0)).not.toThrow();
    expect(() => ledger.authorize('alpha', 0, undefined, 1)).toThrow(/inactive/);
    expect(() => ledger.authorize('alpha', 1, undefined, 0)).toThrow(/inactive/);
    expect(() => ledger.authorize('alpha', 1, undefined, 1)).not.toThrow();
    const checked = verifyDynamicControlEvidenceV2({
      format: 'gaos.dynamic-control-evidence.v2',
      sessionId: 'session',
      control: ledger.checkpoint(),
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
    const stale = structuredClone(envelope);
    stale.transitionRevision = 1;
    expect(verifyDynamicControlEvidenceV2({
      format: 'gaos.dynamic-control-evidence.v2',
      sessionId: 'session',
      control: ledger.checkpoint(),
      commands: [{ envelope: stale, signature }],
    }).valid).toBe(false);
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
    const restored = SeatControlLedger.rehydrate(checkpoint);
    const [pending] = restored.preparedTransitions();
    expect(pending?.epochs.map(({ seat }) => seat).sort()).toEqual(['alpha', 'beta']);
    restored.commit(pending!);
    expect(restored.current('alpha').controller?.controllerId).toBe('b');
    expect(restored.current('beta').controller?.controllerId).toBe('a');
  });

  it('executes every versioned host fixture and emits machine-readable facts', async () => {
    const report = await runHostConformance({
      runtime: 'reference-node',
      adapterVersion: '1.0.0',
      run: async (scenario) => ({ passed: scenario.length > 0 }),
    });
    expect(report.schema).toBe(HOST_CONFORMANCE_VERSION);
    expect(report.scenarios).toHaveLength(RFC014_HOST_CONFORMANCE_SCENARIOS.length);
    expect(report.passed).toBe(true);
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
});
