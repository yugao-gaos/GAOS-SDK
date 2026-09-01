import { describe, expect, it } from 'vitest';
import {
  SessionClient,
  createSubmissionChainState,
  type SubmissionChainState,
} from '../src/client.js';
import {
  makeTickId,
  tickEnvelope,
  type JsonValue,
  type SubmissionSigningPosition,
} from '../src/protocol.js';
import {
  SUBMISSION_SIGNATURE_ALGORITHM,
  exportSubmissionPublicKey,
  generateSubmissionKeyPair,
  recheckReplayArtifact,
  runLevelSeed,
  signEd25519Base64,
  type ReplayGameRef,
  type SubmittedAction,
  type TickReducer,
  type TickView,
} from '../src/engine/index.js';
import {
  createSessionKernel,
  finalizeRunReplay,
  type SessionKernel,
  type SessionKernelOptions,
  type SessionTranscript,
} from '../src/session.js';

interface Level { goal: number }
interface State { goal: number; total: number; notes: number; actionsUsed: number }
type Command =
  | { kind: 'note'; text: string }
  | { kind: 'add' };

const SESSION_ID = 'signed-run';
const SEAT = 'alpha';
const RUN_SEED = 4242;
const LEVELS: readonly Level[] = [{ goal: 2 }, { goal: 1 }];

const game: ReplayGameRef = {
  id: 'tests/client-signing',
  version: '1',
  adapter: { id: 'tests/client-signing/adapter', version: '1' },
};

const reducer: TickReducer<Level, State> = {
  init: (level) => ({ goal: level.goal, total: 0, notes: 0, actionsUsed: 0 }),
  advance: (state, actions) => ({
    ...state,
    total: state.total + actions.length,
    actionsUsed: state.actionsUsed + actions.length,
  }),
  view: (state): TickView => ({
    status: state.total >= state.goal ? 'won' : 'playing',
    ...(state.total >= state.goal ? { stars: 1 } : {}),
    actions: [{ id: 'Action 1', params: 'none' }],
    hud: { actionsUsed: state.actionsUsed, items: [{ index: state.notes }] },
  }),
  replayMetrics: (state) => ({ actionsUsed: state.actionsUsed }),
};

/**
 * A note is a free interaction: it changes durable state and observations
 * without advancing the cursor or the world tick, so two signed submissions
 * share one position.
 */
function classifyCommand(
  state: State,
  command: Command,
  context: { participantId: string },
):
  | { kind: 'interaction'; state: State }
  | { kind: 'intent'; action: SubmittedAction } {
  if (command.kind === 'note') {
    return { kind: 'interaction', state: { ...state, notes: state.notes + 1 } };
  }
  return {
    kind: 'intent',
    action: { id: 'Action 1', seat: context.participantId },
  };
}

function commandToAction(command: JsonValue, context: { participantId: string }): SubmittedAction {
  if ((command as Command).kind !== 'add') throw new Error('not an intent command');
  return { id: 'Action 1', seat: context.participantId };
}

async function seatRoster() {
  const pair = await generateSubmissionKeyPair();
  const publicKey = await exportSubmissionPublicKey(pair.publicKey);
  return {
    pair,
    seatKeys: [{
      id: SEAT,
      publicKey,
      alg: SUBMISSION_SIGNATURE_ALGORITHM,
      signingTier: { N: 4 },
    }],
  };
}

function kernelOptions(
  levelIndex: number,
  seatKeys: Awaited<ReturnType<typeof seatRoster>>['seatKeys'],
): SessionKernelOptions<Level, State, Command, TickView> {
  return {
    sessionId: SESSION_ID,
    game,
    levelId: `level-${levelIndex}`,
    reducer,
    level: LEVELS[levelIndex]!,
    seed: runLevelSeed(RUN_SEED, levelIndex),
    seedPolicy: 'explicit',
    seats: [SEAT],
    cadence: { mode: 'turns' },
    hostTime: 'none',
    classifyCommand,
    seatKeys,
    signaturePolicy: { scheme: 'gaos.submission.ed25519.v1' },
  };
}

/**
 * Reference multi-level run host. It keeps one kernel per level and exposes a
 * single monotonic run revision through a `revisionBase`, which is exactly the
 * case where the wire revision stops matching the recorded cursor and tick.
 */
class RunHost {
  readonly transcripts: SessionTranscript[] = [];
  private levelIndex = 0;
  private revisionBase = 0;
  private kernel: SessionKernel<Command, TickView, Level>;
  private finished = false;

  constructor(
    private readonly seatKeys: Awaited<ReturnType<typeof seatRoster>>['seatKeys'],
  ) {
    this.kernel = createSessionKernel(kernelOptions(0, seatKeys));
  }

  private position(): SubmissionSigningPosition {
    return { cursor: this.kernel.cursor(), tick: this.kernel.tick() };
  }

  /** The run revision a client holds; it never restarts at a level boundary. */
  runRevision(): number {
    return this.revisionBase + this.kernel.cursor();
  }

  envelope(): JsonValue {
    const revision = this.runRevision();
    return {
      ...tickEnvelope(
        SESSION_ID,
        revision,
        this.kernel.observe(SEAT) as unknown as JsonValue,
        this.finished
          ? { 'gaos.session.finalization': { status: 'terminal' } }
          : undefined,
        this.position(),
      ),
    } as unknown as JsonValue;
  }

  binding(): JsonValue {
    return {
      protocol: 'gaos.ticks',
      protocolVersion: '1.0',
      sessionId: SESSION_ID,
      tickId: makeTickId(SESSION_ID, this.runRevision()),
      revision: this.runRevision(),
      participantId: SEAT,
      signingPosition: this.position(),
    } as unknown as JsonValue;
  }

  submit(body: Record<string, unknown>): JsonValue {
    const runRevision = body['revision'] as number;
    if (body['tickId'] !== makeTickId(SESSION_ID, runRevision)) {
      throw new Error('submission tickId does not match its run revision');
    }
    const localRevision = runRevision - this.revisionBase;
    const local = {
      ...body,
      revision: localRevision,
      tickId: makeTickId(SESSION_ID, localRevision),
    } as never;
    const prepared = this.kernel.prepareCommand(local);
    this.kernel.commit(prepared);
    if (prepared.result.effect === 'intent' && this.kernel.awaitingSeats().length === 0) {
      const advance = this.kernel.prepareAdvance();
      this.kernel.commit(advance);
    }
    if (this.kernel.observe(SEAT).status !== 'playing') this.closeLevel();
    return this.envelope();
  }

  private closeLevel(): void {
    this.transcripts.push(structuredClone(this.kernel.liveTranscript()));
    this.revisionBase += this.kernel.cursor();
    this.levelIndex++;
    if (this.levelIndex >= LEVELS.length) {
      this.finished = true;
      return;
    }
    this.kernel = createSessionKernel(kernelOptions(this.levelIndex, this.seatKeys));
  }

  replay(): JsonValue {
    return finalizeRunReplay(this.transcripts, {
      seed: RUN_SEED,
      perm: [0],
      advancePolicy: 'win-to-advance',
    }) as unknown as JsonValue;
  }
}

function hostFetch(host: RunHost): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const body = init?.body === undefined
      ? undefined
      : JSON.parse(init.body as string) as Record<string, unknown>;
    const json = (value: unknown): Response => new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    if (url.pathname === '/v1/sessions') return json(host.envelope());
    if (url.pathname.endsWith('/tick')) return json(host.envelope());
    if (url.pathname.endsWith('/actions')) return json(host.submit(body!));
    if (url.pathname.endsWith('/attach')) {
      return json({
        sessionId: SESSION_ID,
        tick: (host.envelope() as Record<string, JsonValue>)['tick'],
        binding: host.binding(),
      });
    }
    if (url.pathname.endsWith('/finalize')) {
      return json({
        sessionId: SESSION_ID,
        status: 'finalized',
        outcome: { won: true },
        replay: host.replay(),
      });
    }
    throw new Error(`unrouted ${url.pathname}`);
  }) as typeof fetch;
}

function verify(replay: unknown) {
  return recheckReplayArtifact<Level, State, TickView>(
    replay as never,
    () => reducer,
    {
      semanticAdapterForLevel: () => ({
        commandToAction: commandToAction as never,
        classifyCommand: classifyCommand as never,
      }),
    },
  );
}

describe('client submission signing', () => {
  it('signs a resumed multi-level run that the verifier accepts as trusted', async () => {
    const { pair, seatKeys } = await seatRoster();
    const host = new RunHost(seatKeys);
    const sign = (preimage: Uint8Array) => signEd25519Base64(pair.privateKey, preimage);

    const opening = new SessionClient('https://host.test', undefined, {
      fetch: hostFetch(host),
    });
    const start = await opening.createSession({ run: 'signed' }, SEAT);
    const genesis = opening.useSubmissionSigning(start.sessionId, { seatKeys, sign });
    expect(genesis).toEqual(createSubmissionChainState(SESSION_ID, SEAT, seatKeys));

    // Level 0: a free interaction and two intents, all signed on one chain.
    await opening.submitCommand<Command>(SESSION_ID, { kind: 'note', text: 'plan' });
    await opening.submitCommand<Command>(SESSION_ID, { kind: 'add' });
    const saved = opening.submissionChainState(SESSION_ID, SEAT)!;
    expect(saved.submissions).toBe(2);
    await opening.submitCommand<Command>(SESSION_ID, { kind: 'add' });

    // The run is interrupted here and resumed by a separate client process.
    const carried = opening.submissionChainState(SESSION_ID, SEAT)!;
    expect(carried.submissions).toBe(3);
    expect(carried.chainHead).not.toBe(genesis.chainHead);

    const resumed = new SessionClient('https://host.test', undefined, {
      fetch: hostFetch(host),
    });
    const attachment = await resumed.attachSession(SESSION_ID, {
      participantId: SEAT,
      requestId: 'resume-1',
    });
    // The level boundary reset the recorded tick while the run revision climbed.
    expect(attachment.binding.revision).toBe(2);
    expect(attachment.binding.signingPosition).toEqual({ cursor: 0, tick: 0 });
    const continued = resumed.useSubmissionSigning(SESSION_ID, {
      seat: SEAT,
      seatKeys,
      sign,
      resume: carried,
    });
    expect(continued.chainHead).toBe(carried.chainHead);

    await resumed.submitCommand<Command>(SESSION_ID, { kind: 'note', text: 'again' });
    await resumed.submitCommand<Command>(SESSION_ID, { kind: 'add' });
    expect(resumed.submissionChainState(SESSION_ID, SEAT)!.submissions).toBe(5);

    const result = await resumed.finalizeSession(SESSION_ID, { requestId: 'finalize-1' });
    const checked = verify(result.replay);

    expect(checked.problems).toEqual([]);
    expect(checked.signatures.problems).toEqual([]);
    expect(checked.signatures.state).toBe('signed');
    expect(checked.signatures.seats).toEqual([{
      seat: SEAT,
      submissions: 5,
      validSignatures: 5,
      chainReproduced: true,
      policySatisfied: true,
      chainHead: resumed.submissionChainState(SESSION_ID, SEAT)!.chainHead,
    }]);
    expect(checked.semantics.submissions).toBe('verified');
    expect(checked.ok).toBe(true);
    expect(checked.verdict).toBe('trusted');
    expect(checked.levels.map(({ index }) => index)).toEqual([0, 1]);
  });

  it('rejects the run when the client signs the run revision instead of the recorded tick', async () => {
    const { pair, seatKeys } = await seatRoster();
    const host = new RunHost(seatKeys);
    const sign = (preimage: Uint8Array) => signEd25519Base64(pair.privateKey, preimage);
    const client = new SessionClient('https://host.test', undefined, {
      fetch: hostFetch(host),
    });
    await client.createSession({ run: 'naive' }, SEAT);
    client.useSubmissionSigning(SESSION_ID, { seatKeys, sign });

    // A naive client reads the wire revision and signs it as cursor and tick.
    const naive = async (command: Command): Promise<void> => {
      const revision = host.runRevision();
      await client.submitCommand<Command>(SESSION_ID, command, {
        signingPosition: { cursor: revision, tick: revision },
      });
    };
    await naive({ kind: 'note', text: 'plan' });
    await naive({ kind: 'add' });
    await naive({ kind: 'add' });
    await naive({ kind: 'note', text: 'again' });
    await naive({ kind: 'add' });

    const result = await client.finalizeSession(SESSION_ID, { requestId: 'finalize-1' });
    const checked = verify(result.replay);

    // Deterministic replay is untouched; only the signatures fail, and only
    // from level 1, where the run revision stops equalling the recorded tick.
    expect(checked.ok).toBe(true);
    expect(checked.signatures.state).toBe('partial');
    expect(checked.signatures.problems).toEqual([
      'interaction 5 has an invalid Ed25519 signature',
      "resolution 6 input 0 does not reproduce seat alpha's chain",
      'seat alpha has no signed chain head covering submission at level 1 tick 0',
    ]);
    expect(checked.verdict).toBe('rejected');
  });

  it('requires an explicit chain state when signing a session it attached to', async () => {
    const { pair, seatKeys } = await seatRoster();
    const host = new RunHost(seatKeys);
    const sign = (preimage: Uint8Array) => signEd25519Base64(pair.privateKey, preimage);
    const client = new SessionClient('https://host.test', undefined, {
      fetch: hostFetch(host),
    });
    await client.attachSession(SESSION_ID, { participantId: SEAT, requestId: 'a-1' });

    expect(() => client.useSubmissionSigning(SESSION_ID, { seatKeys, sign }))
      .toThrow(/requires the seat's saved chain state/);
    expect(client.useSubmissionSigning(SESSION_ID, {
      seatKeys,
      sign,
      resume: createSubmissionChainState(SESSION_ID, SEAT, seatKeys),
    }).submissions).toBe(0);
  });

  it('refuses a resumed chain that names another session, seat, or roster', async () => {
    const { pair, seatKeys } = await seatRoster();
    const other = await seatRoster();
    const sign = (preimage: Uint8Array) => signEd25519Base64(pair.privateKey, preimage);
    const client = new SessionClient('https://host.test', undefined, {
      fetch: hostFetch(new RunHost(seatKeys)),
    });
    await client.attachSession(SESSION_ID, { participantId: SEAT, requestId: 'a-1' });
    const state = createSubmissionChainState(SESSION_ID, SEAT, seatKeys);

    expect(() => client.useSubmissionSigning(SESSION_ID, {
      seatKeys,
      sign,
      resume: { ...state, sessionId: 'other-run' },
    })).toThrow(/names another session or seat/);
    expect(() => client.useSubmissionSigning(SESSION_ID, {
      seatKeys,
      sign,
      resume: createSubmissionChainState(SESSION_ID, SEAT, other.seatKeys),
    })).toThrow(/bound to a different roster/);
    expect(() => client.useSubmissionSigning(SESSION_ID, {
      seatKeys,
      sign,
      resume: { ...state, chainHead: 'not-base64' },
    })).toThrow(/canonical padded base64/);
    expect(() => client.useSubmissionSigning(SESSION_ID, {
      seatKeys,
      sign,
      resume: { ...state, submissions: -1 } as SubmissionChainState,
    })).toThrow(/submissions must be a count/);
  });

  it('reuses signed bytes for an exact retry and advances the chain once', async () => {
    const { pair, seatKeys } = await seatRoster();
    const host = new RunHost(seatKeys);
    const sent: Array<Record<string, unknown>> = [];
    const inner = hostFetch(host);
    const client = new SessionClient('https://host.test', undefined, {
      fetch: (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).endsWith('/actions')) {
          sent.push(JSON.parse(init!.body as string) as Record<string, unknown>);
        }
        return inner(input as never, init);
      }) as typeof fetch,
    });
    await client.createSession({ run: 'retry' }, SEAT);
    client.useSubmissionSigning(SESSION_ID, { seatKeys, sign: (preimage) =>
      signEd25519Base64(pair.privateKey, preimage) });

    await client.submitCommand<Command>(SESSION_ID, { kind: 'add' }, {
      submissionId: 'retried',
      signingPosition: { cursor: 0, tick: 0 },
    });
    const head = client.submissionChainState(SESSION_ID, SEAT)!;
    await client.submitCommand<Command>(SESSION_ID, { kind: 'add' }, {
      submissionId: 'retried',
      cursor: { tickId: makeTickId(SESSION_ID, 0), revision: 0 },
      signingPosition: { cursor: 0, tick: 0 },
    });

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual(sent[0]);
    expect(client.submissionChainState(SESSION_ID, SEAT)).toEqual(head);
  });

  it('round-trips the signing position through bindings and rejects a malformed one', async () => {
    const { pair, seatKeys } = await seatRoster();
    const host = new RunHost(seatKeys);
    const client = new SessionClient('https://host.test', undefined, { fetch: hostFetch(host) });
    await client.createSession({ run: 'binding' }, SEAT);

    const binding = client.getSessionBinding(SESSION_ID)!;
    expect(binding.signingPosition).toEqual({ cursor: 0, tick: 0 });
    expect(client.restoreSessionBinding(JSON.parse(JSON.stringify(binding))))
      .toEqual(binding);
    expect(() => client.restoreSessionBinding({
      ...binding,
      signingPosition: { cursor: 0, tick: -1 },
    })).toThrow(/signingPosition.tick/);

    client.useSubmissionSigning(SESSION_ID, {
      seatKeys,
      sign: (preimage) => signEd25519Base64(pair.privateKey, preimage),
    });
    expect(client.submissionChainState(SESSION_ID, SEAT)?.submissions).toBe(0);
    client.stopSubmissionSigning(SESSION_ID, SEAT);
    expect(client.submissionChainState(SESSION_ID, SEAT)).toBeUndefined();
    await client.submitCommand<Command>(SESSION_ID, { kind: 'add' });
    const sentUnsigned = await client.getTickEnvelope(SESSION_ID);
    expect(sentUnsigned).toMatchObject({ signingPosition: { cursor: 1, tick: 1 } });

    const malformed = new SessionClient('https://host.test', undefined, {
      fetch: (async () => new Response(JSON.stringify({
        ...tickEnvelope(SESSION_ID, 0, { board: 'x' }),
        signingPosition: { cursor: 0 },
      }), { status: 200 })) as typeof fetch,
    });
    await expect(malformed.createSession({ run: 'bad' }, SEAT))
      .rejects.toThrow(/signingPosition must contain exactly cursor and tick/);
  });

  it('refuses to sign without a signing position and validates the callback result', async () => {
    const { pair, seatKeys } = await seatRoster();
    const unpositioned = new SessionClient('https://host.test', undefined, {
      fetch: (async () => new Response(JSON.stringify(
        tickEnvelope(SESSION_ID, 0, { board: 'x' }),
      ), { status: 200 })) as typeof fetch,
    });
    await unpositioned.createSession({ run: 'bare' }, SEAT);
    unpositioned.useSubmissionSigning(SESSION_ID, {
      seatKeys,
      sign: (preimage) => signEd25519Base64(pair.privateKey, preimage),
    });
    await expect(unpositioned.submitCommand(SESSION_ID, { kind: 'add' }))
      .rejects.toThrow(/host to publish signingPosition/);

    const host = new RunHost(seatKeys);
    const bad = new SessionClient('https://host.test', undefined, { fetch: hostFetch(host) });
    await bad.createSession({ run: 'bad-signer' }, SEAT);
    bad.useSubmissionSigning(SESSION_ID, { seatKeys, sign: () => 'nope' });
    await expect(bad.submitCommand<Command>(SESSION_ID, { kind: 'add' }))
      .rejects.toThrow(/sig must be canonical padded base64/);
  });
});
