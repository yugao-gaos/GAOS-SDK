import { describe, expect, it, vi } from 'vitest';
import {
  createSessionAttachReceipt,
  SessionClient,
  verifySessionAttachReceiptChain,
  type SessionHandle,
  type SessionPolicy,
  type SessionResult,
} from '../src/client.js';
import {
  runSession,
  type SessionPresentation,
} from '../src/agent/session-runner.js';
import type { AgentDriver } from '../src/agent/driver.js';
import type { JsonValue, TickResult } from '../src/protocol.js';
import {
  runBenchmark,
  type BenchmarkAgentAdapter,
  type BenchmarkEpisodePlan,
  type BenchmarkEpisodeResult,
  type BenchmarkManifest,
} from '../src/benchmark.js';

const policy: SessionPolicy = {
  evaluation: { kind: 'none' },
  durability: { attachable: true },
  evidence: { kind: 'replay' },
  publication: { kind: 'none' },
};

interface Observation {
  legalActions: readonly { id: string }[];
  status: 'playing' | 'won';
  value: number;
}

function tick(
  sessionId: string,
  revision: number,
  observation: Observation,
  episode = 0,
): TickResult<Observation> {
  return {
    kind: 'tick',
    protocol: 'gaos.ticks',
    protocolVersion: '1.0',
    sessionId,
    tickId: `${sessionId}:${revision}`,
    revision,
    tick: observation,
    extensions: {
      'gaos.session.episode': { id: `episode-${episode}`, index: episode },
    },
  };
}

class MemoryHandle implements SessionHandle<{ id: string }, Observation, JsonValue> {
  readonly participantId = 'player';
  readonly policy = policy;
  readonly attachReceipt = undefined;
  status: SessionHandle<{ id: string }, Observation, JsonValue>['status'] = 'active';
  cursor = 0;
  readonly commands: string[] = [];
  finalized = 0;
  closed = 0;

  constructor(
    readonly sessionId: string,
    private readonly episodeBoundary = false,
  ) {}

  observe(): Promise<TickResult<Observation>> {
    const done = this.cursor === 2;
    return Promise.resolve(tick(this.sessionId, this.cursor, {
      legalActions: done ? [] : [{ id: `move-${this.cursor}` }],
      status: done ? 'won' : 'playing',
      value: this.cursor,
    }, this.episodeBoundary && this.cursor > 0 ? 1 : 0));
  }

  act(command: { id: string }): Promise<TickResult<Observation>> {
    this.commands.push(command.id);
    this.cursor += 1;
    return this.observe();
  }

  finalize(): Promise<SessionResult<JsonValue>> {
    this.finalized += 1;
    this.status = 'finalized';
    return Promise.resolve({
      sessionId: this.sessionId,
      status: 'finalized',
      outcome: { score: this.cursor },
      replay: { commands: this.commands },
      evaluation: { score: this.cursor },
    });
  }

  close(): void {
    if (this.status === 'closed') return;
    this.closed += 1;
    this.status = 'closed';
  }
}

function driver(resets: number[]): AgentDriver<Observation> {
  return {
    id: 'test-agent',
    label: 'Test agent',
    reset() {
      resets.push(1);
    },
    async act(context) {
      return { action: context.legalActions[0]! };
    },
  };
}

describe('RFC-018 unified session lifecycle', () => {
  it('constructs and independently verifies canonical attachment receipt chains', () => {
    const first = createSessionAttachReceipt({
      sessionId: 'session-1',
      requestId: 'attach-1',
      sequence: 0,
      revision: 4,
      transcriptDigest: 'transcript-4',
      stateDigest: 'state-4',
    });
    const second = createSessionAttachReceipt({
      sessionId: 'session-1',
      requestId: 'attach-2',
      sequence: 1,
      revision: 6,
      transcriptDigest: 'transcript-6',
      stateDigest: 'state-6',
      previousReceiptDigest: first.receiptDigest,
    });

    expect(verifySessionAttachReceiptChain([first, second])).toEqual({
      valid: true,
      problems: [],
    });
    expect(verifySessionAttachReceiptChain([
      first,
      { ...second, revision: 3 },
    ])).toMatchObject({ valid: false });
  });

  it('attaches at the returned durable head and finalizes through the generic client', async () => {
    const receipt = createSessionAttachReceipt({
      sessionId: 'session-1',
      requestId: 'attach-1',
      sequence: 0,
      revision: 7,
      transcriptDigest: 'transcript-7',
      stateDigest: 'state-7',
    });
    const responses = [
      {
        sessionId: 'session-1',
        tick: { value: 7 },
        binding: {
          protocol: 'gaos.ticks',
          protocolVersion: '1.0',
          sessionId: 'session-1',
          tickId: 'session-1:7',
          revision: 7,
          participantId: 'player',
        },
        receipt,
      },
      {
        sessionId: 'session-1',
        status: 'finalized',
        outcome: { score: 7 },
        replay: { actions: 7 },
      },
    ];
    const request = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify(responses.shift()),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    const client = new SessionClient('https://host.test', undefined, { fetch: request });

    const attached = await client.attachSession<{ value: number }>('session-1', {
      requestId: 'attach-1',
      participantId: 'player',
    });
    const result = await client.finalizeSession('session-1', { requestId: 'finalize-1' });

    expect(attached.binding.revision).toBe(7);
    expect(attached.receipt).toEqual(receipt);
    expect(result).toMatchObject({ status: 'finalized', outcome: { score: 7 } });
    expect(request.mock.calls.map(([url, init]) => [
      url,
      init?.method,
      JSON.parse(String(init?.body)),
    ])).toEqual([
      [
        'https://host.test/v1/sessions/session-1/attach',
        'POST',
        { requestId: 'attach-1', participantId: 'player' },
      ],
      [
        'https://host.test/v1/sessions/session-1/finalize',
        'POST',
        { requestId: 'finalize-1' },
      ],
    ]);
  });

  it('returns one handle type from create and attach with immutable finalization retries', async () => {
    const responses = [
      tick('created', 0, { legalActions: [], status: 'playing', value: 0 }),
      {
        sessionId: 'attached',
        tick: { legalActions: [], status: 'playing', value: 3 },
        binding: {
          protocol: 'gaos.ticks',
          protocolVersion: '1.0',
          sessionId: 'attached',
          tickId: 'attached:3',
          revision: 3,
          participantId: 'player',
        },
      },
      {
        sessionId: 'created',
        status: 'finalized',
        outcome: { score: 1 },
      },
    ];
    const request = vi.fn<typeof fetch>(async () => new Response(
      JSON.stringify(responses.shift()),
      { status: 200 },
    ));
    const client = new SessionClient('https://host.test', undefined, { fetch: request });
    const created = await client.createSessionHandle(
      { game: 'test' },
      policy,
    );
    const attached = await client.attachSessionHandle('attached', {
      requestId: 'attach',
    }, policy);

    expect(Object.getPrototypeOf(created)).toBe(Object.getPrototypeOf(attached));
    const first = await created.finalize({ requestId: 'finish' });
    const retry = await created.finalize({ requestId: 'finish' });
    expect(retry).toEqual(first);
    await expect(created.finalize({ requestId: 'conflict' })).rejects.toThrow(
      'different request',
    );
    attached.close();
    expect(request).toHaveBeenCalledTimes(3);
    expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toEqual({
      game: 'test',
      policy,
    });
  });

  it('adopts an existing durable head and consumes its initial tick without a request', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(
      tick('existing', 5, {
        legalActions: [],
        status: 'won',
        value: 5,
      }),
    )));
    const client = new SessionClient('https://host.test', undefined, { fetch: request });
    const initialTick = tick('existing', 4, {
      legalActions: [{ id: 'move' }],
      status: 'playing',
      value: 4,
    });
    const attachReceipt = createSessionAttachReceipt({
      sessionId: 'existing',
      requestId: 'custom-attach',
      sequence: 0,
      revision: 4,
      transcriptDigest: 'transcript-4',
      stateDigest: 'state-4',
    });
    const handle = client.createSessionHandleFromExisting<
      { id: string },
      Observation
    >({
      sessionId: 'existing',
      binding: {
        protocol: 'gaos.ticks',
        protocolVersion: '1.0',
        sessionId: 'existing',
        tickId: 'existing:4',
        revision: 4,
        participantId: 'north',
      },
      initialTick,
      attachReceipt,
    }, policy);
    initialTick.tick.value = 99;

    expect(request).not.toHaveBeenCalled();
    expect(handle.participantId).toBe('north');
    expect(handle.attachReceipt).toEqual(attachReceipt);
    await expect(handle.observe()).resolves.toMatchObject({
      revision: 4,
      tick: { value: 4 },
    });
    expect(request).not.toHaveBeenCalled();

    await expect(handle.act({ id: 'move' })).resolves.toMatchObject({
      revision: 5,
    });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toMatchObject({
      revision: 4,
      participantId: 'north',
      command: { id: 'move' },
    });
  });

  it('validates adopted identity and initializes terminal status from the tick', async () => {
    const client = new SessionClient('https://host.test', undefined, {
      fetch: vi.fn<typeof fetch>(),
    });
    const binding = {
      protocol: 'gaos.ticks' as const,
      protocolVersion: '1.0' as const,
      sessionId: 'terminal',
      tickId: 'terminal:2',
      revision: 2,
      participantId: 'player',
    };
    expect(() => client.createSessionHandleFromExisting({
      sessionId: 'other',
      binding,
      initialTick: tick('terminal', 2, {
        legalActions: [],
        status: 'won',
        value: 2,
      }),
    }, policy)).toThrow(/identities do not match/);
    expect(client.getSessionBinding('terminal')).toBeUndefined();

    const terminalTick = tick('terminal', 2, {
      legalActions: [],
      status: 'won',
      value: 2,
    });
    terminalTick.extensions = {
      ...terminalTick.extensions,
      'gaos.session.finalization': { status: 'terminal' },
    };
    const terminal = client.createSessionHandleFromExisting({
      sessionId: 'terminal',
      binding,
      initialTick: terminalTick,
    }, policy);
    expect(terminal.status).toBe('terminal');
    await expect(terminal.observe()).resolves.toEqual(terminalTick);
    await expect(terminal.act({ id: 'late' })).rejects.toThrow(
      'cannot act while session handle is terminal',
    );
  });

  it('adopts create and attach projections as resolved durable heads', async () => {
    const request = vi.fn<typeof fetch>();
    const client = new SessionClient('https://host.test', undefined, { fetch: request });
    const start = client.createSessionHandleFromExisting({
      sessionId: 'projected-start',
      binding: {
        protocol: 'gaos.ticks',
        protocolVersion: '1.0',
        sessionId: 'projected-start',
        tickId: 'projected-start:0',
        revision: 0,
        participantId: 'starter',
      },
      tick: {
        legalActions: [{ id: 'move' }],
        status: 'playing' as const,
        value: 0,
      },
    }, policy);

    await expect(start.observe()).resolves.toEqual({
      kind: 'tick',
      protocol: 'gaos.ticks',
      protocolVersion: '1.0',
      sessionId: 'projected-start',
      tickId: 'projected-start:0',
      revision: 0,
      tick: {
        legalActions: [{ id: 'move' }],
        status: 'playing',
        value: 0,
      },
    });

    const receipt = createSessionAttachReceipt({
      sessionId: 'projected-attach',
      requestId: 'attach-projection',
      sequence: 0,
      revision: 3,
      transcriptDigest: 'transcript-3',
      stateDigest: 'state-3',
    });
    const attachment = client.createSessionHandleFromExisting({
      sessionId: 'projected-attach',
      binding: {
        protocol: 'gaos.ticks',
        protocolVersion: '1.0',
        sessionId: 'projected-attach',
        tickId: 'projected-attach:3',
        revision: 3,
        participantId: 'attached',
      },
      tick: {
        legalActions: [],
        status: 'won' as const,
        value: 3,
      },
      receipt,
      extensions: {
        'gaos.session.finalization': { status: 'terminal' },
      },
    }, policy);

    expect(attachment.attachReceipt).toEqual(receipt);
    expect(attachment.status).toBe('terminal');
    await expect(attachment.observe()).resolves.toMatchObject({
      kind: 'tick',
      sessionId: 'projected-attach',
      tickId: 'projected-attach:3',
      revision: 3,
      extensions: {
        'gaos.session.finalization': { status: 'terminal' },
      },
    });
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps pacing presentation-only and resets context at episode transitions', async () => {
    const paced = new MemoryHandle('paced', true);
    const unpaced = new MemoryHandle('unpaced', true);
    const pacedResets: number[] = [];
    const unpacedResets: number[] = [];
    const pacedFrames: number[] = [];
    const unpacedFrames: number[] = [];
    const presentation = (frames: number[]): SessionPresentation<Observation> => ({
      async present(result) {
        await Promise.resolve();
        frames.push(result.revision);
      },
    });

    const [pacedRun, unpacedRun] = await Promise.all([
      runSession(paced, driver(pacedResets), {
        policy: {
          pacing: 'paced',
          conversation: 'fresh-per-episode',
          finalize: 'automatic',
        },
        presentation: presentation(pacedFrames),
      }),
      runSession(unpaced, driver(unpacedResets), {
        policy: {
          pacing: 'unpaced',
          conversation: 'fresh-per-episode',
          finalize: 'automatic',
        },
        presentation: presentation(unpacedFrames),
      }),
    ]);

    expect(paced.commands).toEqual(['move-0', 'move-1']);
    expect(unpaced.commands).toEqual(paced.commands);
    expect(pacedFrames).toEqual([0, 1, 2]);
    expect(unpacedFrames).toEqual(pacedFrames);
    expect(pacedResets).toHaveLength(2);
    expect(unpacedResets).toHaveLength(2);
    expect(pacedRun.result?.outcome).toEqual(unpacedRun.result?.outcome);
  });

  it('leaves authoritative state untouched when a handle closes', () => {
    const handle = new MemoryHandle('local-close');
    handle.close();
    handle.close();
    expect(handle.finalized).toBe(0);
    expect(handle.commands).toEqual([]);
  });

  it('runs session-backed benchmarks through runSession without changing plan order', async () => {
    const manifest: BenchmarkManifest = {
      schema: 'gaos.benchmark-manifest.v1',
      benchmark: { id: 'rfc018', version: '1', adapter: 'test' },
      tasks: [{ id: 'task', seeds: [2, 1], episodes: 1, maxSteps: 2 }],
      scoring: { plugin: 'score', aggregation: 'mean' },
      submission: { requireSignedSeats: false, requireCompleteCoverage: false },
    };
    const legacy: BenchmarkAgentAdapter = {
      kind: 'local',
      id: 'agent',
      runEpisode: vi.fn(async () => {
        throw new Error('legacy runner must not be used');
      }),
    };
    const handles: MemoryHandle[] = [];
    const resultFor = (
      plan: BenchmarkEpisodePlan,
      score: number,
    ): BenchmarkEpisodeResult => ({
      plan,
      score,
      replay: { plan: plan.index },
      terminalOutcome: { score },
      observations: { steps: 2 },
    });

    const run = await runBenchmark(manifest, legacy, {
      parallelism: 2,
      sessions: {
        factory: {
          async createEpisode(plan) {
            const handle = new MemoryHandle(`episode-${plan.index}`);
            handles.push(handle);
            return handle;
          },
        },
        createDriver: () => driver([]),
        async toEpisodeResult(plan, sessionRun) {
          return resultFor(plan, (sessionRun.result?.outcome as { score: number }).score);
        },
      },
    });

    expect(run.status).toBe('complete');
    expect(run.checkpoint.completed.map((episode) => episode.plan.index)).toEqual([0, 1]);
    expect(run.aggregate?.aggregateScore).toBe(2);
    expect(handles).toHaveLength(2);
    expect(handles.every((handle) => handle.closed === 1 && handle.finalized === 1)).toBe(true);
    expect(legacy.runEpisode).not.toHaveBeenCalled();
  });

  it('attaches an in-progress benchmark episode and does not duplicate actions', async () => {
    const manifest: BenchmarkManifest = {
      schema: 'gaos.benchmark-manifest.v1',
      benchmark: { id: 'resume', version: '1', adapter: 'test' },
      tasks: [{ id: 'task', seeds: [1], episodes: 1, maxSteps: 2 }],
      scoring: { plugin: 'score', aggregation: 'mean' },
      submission: { requireSignedSeats: false, requireCompleteCoverage: false },
    };
    const adapter: BenchmarkAgentAdapter = {
      kind: 'local',
      id: 'agent',
      async runEpisode() {
        throw new Error('legacy runner must not be used');
      },
    };
    const empty = await runBenchmark(manifest, adapter, { maxNewEpisodes: 0 });
    const resumed = new MemoryHandle('durable-session');
    resumed.cursor = 1;
    resumed.commands.push('move-0');
    const attachEpisode = vi.fn(async () => resumed);

    const run = await runBenchmark(manifest, adapter, {
      resume: {
        ...empty.checkpoint,
        inProgress: [{
          plan: empty.checkpoint.plan[0]!,
          attachment: { sessionId: 'durable-session' },
          attachReceiptDigest: 'receipt-digest',
        }],
      },
      sessions: {
        factory: {
          createEpisode: vi.fn(async () => {
            throw new Error('continued episode must attach');
          }),
          attachEpisode,
        },
        createDriver: () => driver([]),
        toEpisodeResult(plan, sessionRun) {
          return {
            plan,
            score: 2,
            replay: sessionRun.result?.replay ?? null,
            terminalOutcome: sessionRun.result?.outcome ?? null,
            observations: { steps: 2 },
          };
        },
      },
    });

    expect(run.status).toBe('complete');
    expect(attachEpisode).toHaveBeenCalledOnce();
    expect(resumed.commands).toEqual(['move-0', 'move-1']);
    expect(run.checkpoint.inProgress).toBeUndefined();
  });
});
