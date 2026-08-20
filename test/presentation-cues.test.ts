import { describe, expect, it, vi } from 'vitest';
import {
  PRESENTATION_CUE_SCHEMA,
  PresentationCueClient,
  PresentationCueHost,
} from '../src/presentation-cues.js';

function idFactory(): () => string {
  let next = 0;
  return () => `cue-${++next}`;
}

describe('presentation cues', () => {
  it('applies ordered cues once and returns retry-stable acknowledgements', async () => {
    const applied: string[] = [];
    const host = new PresentationCueHost({
      sessionId: 'session-1',
      createId: idFactory(),
    });
    const client = new PresentationCueClient({
      sessionId: 'session-1',
      apply: async (cue) => { applied.push(cue.type); },
    });
    const cue = host.issue('play_media', { slot: 'welcome' });

    const first = await client.receive(cue);
    const duplicate = await client.receive(cue);

    expect(first).toEqual({
      schema: PRESENTATION_CUE_SCHEMA,
      sessionId: 'session-1',
      cueId: 'cue-1',
      sequence: 1,
      status: 'applied',
    });
    expect(duplicate).toEqual({ ...first, status: 'duplicate' });
    expect(applied).toEqual(['play_media']);
    expect(host.acknowledge(first)).toBe('recorded');
    expect(host.acknowledge(first)).toBe('duplicate');
    expect(host.acknowledge(duplicate)).toBe('duplicate');
  });

  it('detects sequence gaps and replays the retained tail on reconnect', async () => {
    const host = new PresentationCueHost({
      sessionId: 'session-1',
      createId: idFactory(),
    });
    const first = host.issue('set_phase', { phase: 'welcome' });
    const second = host.issue('play_media', { slot: 'ask_question' });
    const client = new PresentationCueClient({
      sessionId: 'session-1',
      apply: async () => undefined,
    });

    await expect(client.receive(second)).resolves.toMatchObject({
      status: 'repair_required',
      reason: 'sequence_gap',
    });
    expect(client.state().lastAppliedSequence).toBe(0);
    expect(host.resumeAfter(0)).toEqual({
      status: 'replay',
      cues: [first, second],
    });
    await client.receive(first);
    await client.receive(second);
    expect(client.state()).toMatchObject({
      status: 'ready',
      lastAppliedSequence: 2,
    });
  });

  it('lets an emergency cue interrupt and supersede a missing normal cue', async () => {
    const interrupt = vi.fn(async () => undefined);
    const apply = vi.fn(async () => undefined);
    const host = new PresentationCueHost({
      sessionId: 'session-1',
      createId: idFactory(),
    });
    host.issue('play_media', { slot: 'welcome' });
    const emergency = host.issue(
      'emergency_stop',
      { fallback: 'grounding' },
      { priority: 'emergency' },
    );
    const client = new PresentationCueClient({
      sessionId: 'session-1',
      apply,
      interrupt,
    });

    await expect(client.receive(emergency)).resolves.toMatchObject({
      status: 'applied',
      sequence: 2,
    });
    expect(interrupt).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith(emergency);
    expect(client.state()).toMatchObject({
      status: 'ready',
      lastAppliedSequence: 2,
    });
  });

  it('serializes host/client state and requests a snapshot after retention loss', async () => {
    const host = new PresentationCueHost({
      sessionId: 'session-1',
      createId: idFactory(),
      maxRetainedCues: 2,
    });
    const first = host.issue('set_phase', { phase: 'one' });
    const second = host.issue('set_phase', { phase: 'two' });
    const third = host.issue('set_phase', { phase: 'three' });

    expect(host.resumeAfter(0)).toEqual({
      status: 'snapshot_required',
      earliestRetainedSequence: 2,
      latestSequence: 3,
    });
    expect(host.resumeAfter(1)).toEqual({ status: 'replay', cues: [second, third] });

    const restoredHost = new PresentationCueHost({
      sessionId: 'session-1',
      createId: idFactory(),
      state: host.state(),
    });
    expect(restoredHost.issue('return', null).sequence).toBe(4);

    const client = new PresentationCueClient({
      sessionId: 'session-1',
      apply: async () => undefined,
    });
    await client.receive(first);
    await client.receive(second);
    const restoredClient = new PresentationCueClient({
      sessionId: 'session-1',
      apply: async () => undefined,
      state: client.state(),
    });
    await restoredClient.receive(third);
    expect(restoredClient.state().lastAppliedSequence).toBe(3);
  });

  it('rejects cross-session, non-JSON, and conflicting cue identities', async () => {
    const host = new PresentationCueHost({
      sessionId: 'session-1',
      createId: () => 'same-id',
    });
    expect(() => host.issue('bad', { callback: () => undefined } as never))
      .toThrow('presentation cue payload');

    const cue = host.issue('set_phase', { phase: 'welcome' });
    const client = new PresentationCueClient({
      sessionId: 'session-2',
      apply: async () => undefined,
    });
    await expect(client.receive(cue)).rejects.toThrow('does not belong to client session');

    const matching = new PresentationCueClient({
      sessionId: 'session-1',
      apply: async () => undefined,
    });
    await matching.receive(cue);
    await expect(matching.receive({
      ...cue,
      type: 'different',
    })).rejects.toThrow('cue identity was reused');

    const newer = { ...cue, cueId: 'newer', sequence: 2 };
    await matching.receive(newer);
    await expect(matching.receive({
      ...cue,
      cueId: 'stale-emergency',
      priority: 'emergency',
    })).resolves.toMatchObject({
      status: 'repair_required',
      reason: 'stale_sequence',
    });
  });

  it('rejects restored acknowledgements that do not match the retained cue', () => {
    const host = new PresentationCueHost({
      sessionId: 'session-1',
      createId: idFactory(),
    });
    const cue = host.issue('set_phase', { phase: 'welcome' });
    const state = host.state();

    expect(() => new PresentationCueHost({
      sessionId: 'session-1',
      createId: idFactory(),
      state: {
        ...state,
        acknowledgements: {
          wrong: {
            schema: PRESENTATION_CUE_SCHEMA,
            sessionId: 'session-1',
            cueId: cue.cueId,
            sequence: cue.sequence,
            status: 'applied',
          },
        },
      },
    })).toThrow('does not match a retained cue');
  });
});
