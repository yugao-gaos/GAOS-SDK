import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionClient } from '../src/client.js';
import { tickEnvelope } from '../src/protocol.js';

afterEach(() => vi.unstubAllGlobals());

describe('product-neutral SessionClient', () => {
  it('creates a session with an opaque non-grid observation', async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(
      tickEnvelope('cards-1', 0, {
        hand: ['ace', 'queen'],
        legalCommands: [{ id: 'play', card: 'ace' }],
      }),
    ), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    const client = new SessionClient('https://host.example', undefined, { fetch: request });

    const started = await client.createSession<
      { game: string },
      { hand: string[]; legalCommands: Array<{ id: string; card: string }> }
    >({ game: 'cards' }, 'north');

    expect(started.tick.hand).toEqual(['ace', 'queen']);
    expect(started.binding.participantId).toBe('north');
    expect(request).toHaveBeenCalledWith(
      'https://host.example/v1/sessions',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ game: 'cards' }),
      }),
    );
  });

  it('submits opaque commands against the remembered cursor', async () => {
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(
        tickEnvelope('graph-1', 0, { node: 'a' }),
      ), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(
        tickEnvelope('graph-1', 1, { node: 'b' }),
      ), { status: 200 }));
    const client = new SessionClient('https://host.example', undefined, { fetch: request });
    await client.createSession({ game: 'graph' });

    const result = await client.submitIntent<
      { traverse: string },
      { node: string }
    >('graph-1', { traverse: 'b' });

    expect(result.tick).toEqual({ node: 'b' });
    const submission = JSON.parse(
      (request.mock.calls[1]?.[1] as RequestInit).body as string,
    ) as Record<string, unknown>;
    expect(submission).toMatchObject({
      protocol: 'gaos.ticks',
      sessionId: 'graph-1',
      revision: 0,
      command: { traverse: 'b' },
    });
  });

  it('assigns distinct command ids to repeated same-cursor interactions', async () => {
    const pending = {
      ...tickEnvelope('graph-2', 0, { modal: 'open' }),
      kind: 'pending',
      submittedParticipants: [],
      awaitingParticipants: ['player'],
    };
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify(
        tickEnvelope('graph-2', 0, { modal: 'closed' }),
      ), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(pending), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(pending), { status: 200 }));
    const client = new SessionClient('https://host.example', undefined, { fetch: request });
    await client.createSession({ game: 'graph' });

    await client.submitCommand('graph-2', { kind: 'open' });
    await client.submitCommand('graph-2', { kind: 'select', value: 2 });

    const ids = request.mock.calls.slice(1).map((call) => JSON.parse(
      (call[1] as RequestInit).body as string,
    ) as { submissionId: string });
    expect(ids.map(({ submissionId }) => submissionId)).toEqual([
      'player:graph-2:0:0',
      'player:graph-2:0:1',
    ]);
  });
});
