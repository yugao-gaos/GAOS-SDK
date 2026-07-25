import { describe, expect, it, vi } from 'vitest';
import {
  AgentDriverRegistry,
  KEYED_PROVIDERS,
  createDefaultKeyedProviderRegistry,
  createKeyedAgentDriver,
  parseAgentDecision,
  runAgentDriverEpisode,
  type AgentDriver,
  type AgentFetch,
} from '../src/agent/index.js';
import {
  AgentEnvironment,
  type ActionReducer,
  type TickView,
} from '../src/engine/index.js';

interface Level { goal: number }
interface State { at: number; actionsUsed: number }
interface View extends TickView { at: number }

const reducer: ActionReducer<Level, State, View> = {
  init: () => ({ at: 0, actionsUsed: 0 }),
  apply: (state, action) => ({
    at: state.at + (action.id === 'jump' ? (action.index ?? 0) : 1),
    actionsUsed: state.actionsUsed + 1,
  }),
  view: (state) => ({
    at: state.at,
    actions: [
      { id: 'advance', params: 'none' },
      { id: 'jump', params: 'index' },
    ],
    status: state.at >= 2 ? 'won' : 'playing',
    ...(state.at >= 2 ? { stars: 3 } : {}),
    hud: { actionsUsed: state.actionsUsed, items: [{ index: 2 }] },
  }),
};

describe('agent driver contracts', () => {
  it('supports extension through a driver registry', async () => {
    const driver: AgentDriver<View> = {
      id: 'local',
      label: 'Local test driver',
      act: async () => ({ action: { id: 'jump', index: 2 } }),
    };
    const registry = new AgentDriverRegistry([driver]);
    expect(registry.require('local')).toBe(driver);
    expect(() => registry.register(driver)).toThrow('already registered');

    const result = await runAgentDriverEpisode(new AgentEnvironment({
      reducer,
      level: { goal: 2 },
      seed: 1,
    }), driver);
    expect(result.decisions).toEqual([{ action: { id: 'jump', index: 2 } }]);
    expect(result.finalStep.info).toMatchObject({ terminationReason: 'won', ticks: 1 });
  });

  it('parses nested JSON without being confused by braces in strings', () => {
    expect(parseAgentDecision('answer: {"reasoning":"use {jump}","action":{"id":"jump","index":2}} done'))
      .toEqual({
        reasoning: 'use {jump}',
        action: { id: 'jump', index: 2 },
      });
  });

  it('preserves board and zone addressing in model decisions', () => {
    expect(parseAgentDecision(
      '{"action":{"id":"deploy","x":2,"y":3,"boardId":"arena","zoneId":"hand"}}',
    )).toEqual({
      action: {
        id: 'deploy',
        x: 2,
        y: 3,
        boardId: 'arena',
        zoneId: 'hand',
      },
    });
  });

  it('parses cross-container declarative target selections', () => {
    expect(parseAgentDecision(
      '{"action":{"id":"choose","targets":[{"container":"board","coord":[2,3]},{"container":"hand","coord":1}]}}',
    )).toEqual({
      action: {
        id: 'choose',
        targets: [
          { container: 'board', coord: [2, 3] },
          { container: 'hand', coord: 1 },
        ],
      },
    });
  });
});

describe('keyed providers', () => {
  it('ships four providers and legacy aliases', () => {
    expect(KEYED_PROVIDERS.map(({ id }) => id)).toEqual([
      'anthropic',
      'openai',
      'xai',
      'openrouter',
    ]);
    const registry = createDefaultKeyedProviderRegistry();
    expect(registry.require('key:openai').id).toBe('openai');
    expect(registry.require('api').id).toBe('anthropic');
    expect(registry.require('router').id).toBe('openrouter');
  });

  it('calls OpenAI-compatible APIs and rejects an illegal model action', async () => {
    const request = vi.fn<AgentFetch>().mockImplementation(async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"reasoning":"go","action":{"id":"advance"}}' } }],
      usage: { prompt_tokens: 10, completion_tokens: 4 },
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const driver = createKeyedAgentDriver<View>('openai', {
      apiKey: 'secret-key',
      model: 'test-model',
      fetch: request,
    });
    const decision = await driver.act({
      observation: reducer.view(reducer.init({ goal: 2 }, 1)),
      legalActions: [{ id: 'advance' }],
      step: 0,
      systemPrompt: 'Product rule: avoid hazards.',
    });
    expect(decision).toMatchObject({
      action: { id: 'advance' },
      reasoning: 'go',
      usage: { inputTokens: 10, outputTokens: 4 },
    });
    expect(request).toHaveBeenCalledWith('https://api.openai.com/v1/chat/completions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ authorization: 'Bearer secret-key' }),
      body: expect.stringContaining('Product rule: avoid hazards.'),
    }));
    const requestBody = JSON.parse(request.mock.calls[0]![1]!.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(requestBody.messages[0]?.content).toContain(
      'Choose exactly one entry from legalActions or systemActions.',
    );

    await driver.act({
      observation: reducer.view(reducer.init({ goal: 2 }, 1)),
      legalActions: [{ id: 'advance' }],
      step: 1,
    });
    const continuedBody = JSON.parse(request.mock.calls[1]![1]!.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(continuedBody.messages.map(({ role }) => role)).toEqual(['system', 'user', 'assistant', 'user']);

    request.mockResolvedValueOnce(new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":{"id":"jump","index":9}}' } }],
    }), { status: 200 }));
    await expect(driver.act({
      observation: reducer.view(reducer.init({ goal: 2 }, 1)),
      legalActions: [{ id: 'advance' }],
      step: 0,
    })).rejects.toThrow('illegal action');
  });

  it('interrupts an in-flight keyed request while retaining completed context', async () => {
    const request = vi.fn<AgentFetch>((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
    }));
    const driver = createKeyedAgentDriver<View>('openai', {
      apiKey: 'secret-key', model: 'test-model', fetch: request,
    });
    const pending = driver.act({
      observation: reducer.view(reducer.init({ goal: 2 }, 1)),
      legalActions: [{ id: 'advance' }],
      step: 0,
    });
    const rejected = expect(pending).rejects.toThrow('agent interrupted');
    expect(driver.interrupt?.({ prompt: 'stop' })).toEqual({
      mode: 'abort', interrupted: true, preservesContext: true,
    });
    await rejected;
  });

  it('retries transient responses and bounds completed conversation history', async () => {
    const ok = () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":{"id":"advance"}}' } }],
    }), { status: 200 });
    const request = vi.fn<AgentFetch>()
      .mockResolvedValueOnce(new Response('busy', { status: 503 }))
      .mockResolvedValue(ok())
      .mockResolvedValueOnce(ok())
      .mockResolvedValueOnce(ok());
    const sleep = vi.fn<(delayMs: number, signal: AbortSignal) => Promise<void>>(async () => undefined);
    const driver = createKeyedAgentDriver<View>('openai', {
      apiKey: 'secret-key', model: 'test-model', fetch: request,
      maxHistoryTurns: 1, maxRetries: 2, retryBaseDelayMs: 5,
      retryJitter: () => 0.5, sleep,
    });
    for (let step = 0; step < 3; step++) {
      await driver.act({
        observation: reducer.view(reducer.init({ goal: 2 }, 1)),
        legalActions: [{ id: 'advance' }],
        step,
      });
    }
    expect(request).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledWith(5, expect.any(AbortSignal));
    const lastBody = JSON.parse(request.mock.calls[3]![1]!.body as string) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(lastBody.messages.map(({ role }) => role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(lastBody.messages[1]?.content).toContain('"step":1');
    expect(lastBody.messages[3]?.content).toContain('"step":2');
  });

  it('aborts while waiting to retry a transient response', async () => {
    const sleep = vi.fn((_delay: number, signal: AbortSignal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }));
    const driver = createKeyedAgentDriver<View>('anthropic', {
      apiKey: 'secret-key', model: 'test-model', maxRetries: 1,
      fetch: async () => new Response('busy', { status: 429 }), sleep,
    });
    const pending = driver.act({
      observation: reducer.view(reducer.init({ goal: 2 }, 1)),
      legalActions: [{ id: 'advance' }],
      step: 0,
    });
    await vi.waitFor(() => expect(sleep).toHaveBeenCalled());
    expect(driver.interrupt?.()).toMatchObject({ interrupted: true });
    await expect(pending).rejects.toThrow('agent interrupted');
  });

  it('retries network failures, honors Retry-After, and applies bounded jitter', async () => {
    const ok = new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":{"id":"advance"}}' } }],
    }));
    const request = vi.fn<AgentFetch>()
      .mockRejectedValueOnce(new TypeError('network reset'))
      .mockResolvedValueOnce(new Response('slow down', {
        status: 429, headers: { 'retry-after': '2' },
      }))
      .mockResolvedValueOnce(ok);
    const sleep = vi.fn<(delayMs: number, signal: AbortSignal) => Promise<void>>(async () => undefined);
    const driver = createKeyedAgentDriver<View>('openai', {
      apiKey: 'secret-key', model: 'test-model', fetch: request,
      maxRetries: 2, retryBaseDelayMs: 100, maxRetryDelayMs: 5_000,
      retryJitter: () => 0.5, sleep,
    });
    await expect(driver.act({
      observation: reducer.view(reducer.init({ goal: 2 }, 1)),
      legalActions: [{ id: 'advance' }], step: 0,
    })).resolves.toMatchObject({ action: { id: 'advance' } });
    expect(sleep.mock.calls.map(([delay]) => delay)).toEqual([100, 2_000]);
  });

  it('rejects invalid retry jitter before scheduling a delay', async () => {
    const sleep = vi.fn<(delayMs: number, signal: AbortSignal) => Promise<void>>(async () => undefined);
    const driver = createKeyedAgentDriver<View>('openai', {
      apiKey: 'secret-key', model: 'test-model', maxRetries: 1,
      retryJitter: () => Number.NaN, sleep,
      fetch: async () => new Response('busy', { status: 503 }),
    });
    await expect(driver.act({
      observation: reducer.view(reducer.init({ goal: 2 }, 1)),
      legalActions: [{ id: 'advance' }], step: 0,
    })).rejects.toThrow(/retryJitter/);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('falls back to exponential backoff for malformed Retry-After', async () => {
    const sleep = vi.fn<(delayMs: number, signal: AbortSignal) => Promise<void>>(async () => undefined);
    const driver = createKeyedAgentDriver<View>('openai', {
      apiKey: 'secret-key', model: 'test-model', maxRetries: 1,
      retryBaseDelayMs: 80, retryJitter: () => 0.5, sleep,
      fetch: vi.fn<AgentFetch>()
        .mockResolvedValueOnce(new Response('busy', {
          status: 429, headers: { 'retry-after': 'not-a-date' },
        }))
        .mockResolvedValueOnce(new Response(JSON.stringify({
          choices: [{ message: { content: '{"action":{"id":"advance"}}' } }],
        }))),
    });
    await driver.act({
      observation: reducer.view(reducer.init({ goal: 2 }, 1)),
      legalActions: [{ id: 'advance' }], step: 0,
    });
    expect(sleep).toHaveBeenCalledWith(80, expect.any(AbortSignal));
  });

  it('rejects concurrent calls and bounds context and response bytes', async () => {
    let release!: (response: Response) => void;
    const request = vi.fn<AgentFetch>(() => new Promise<Response>((resolve) => { release = resolve; }));
    const driver = createKeyedAgentDriver<View>('openai', {
      apiKey: 'secret-key', model: 'test-model', fetch: request,
    });
    const context = {
      observation: reducer.view(reducer.init({ goal: 2 }, 1)),
      legalActions: [{ id: 'advance' }], step: 0,
    };
    const first = driver.act(context);
    await expect(driver.act(context)).rejects.toThrow(/already in progress/);
    release(new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":{"id":"advance"}}' } }],
    })));
    await first;

    const tooMuchContext = createKeyedAgentDriver<View>('openai', {
      apiKey: 'secret-key', model: 'test-model', fetch: request, maxContextBytes: 16,
    });
    await expect(tooMuchContext.act(context)).rejects.toThrow(/context exceeds/);

    const tooMuchResponse = createKeyedAgentDriver<View>('openai', {
      apiKey: 'secret-key', model: 'test-model', maxResponseBytes: 4,
      fetch: async () => new Response('12345'),
    });
    await expect(tooMuchResponse.act(context)).rejects.toThrow(/exceeds 4 bytes/);
  });

  it('calls Anthropic Messages without requiring a provider SDK', async () => {
    const request = vi.fn<AgentFetch>().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: '{"action":{"id":"jump","index":2}}' }],
      usage: { input_tokens: 8, output_tokens: 3 },
    }), { status: 200 }));
    const driver = createKeyedAgentDriver<View>('anthropic', {
      apiKey: 'secret-key',
      model: 'test-model',
      fetch: request,
    });
    await expect(driver.act({
      observation: reducer.view(reducer.init({ goal: 2 }, 1)),
      legalActions: [{ id: 'jump', index: 2 }],
      step: 0,
    })).resolves.toMatchObject({
      action: { id: 'jump', index: 2 },
      usage: { inputTokens: 8, outputTokens: 3 },
    });
    expect(request).toHaveBeenCalledWith('https://api.anthropic.com/v1/messages', expect.objectContaining({
      headers: expect.objectContaining({ 'x-api-key': 'secret-key' }),
    }));
  });

  it('checks keys with injected fetch and never echoes a rejected secret', async () => {
    const provider = createDefaultKeyedProviderRegistry().require('openai');
    await expect(provider.check('not-for-logs', {
      fetch: async () => new Response('', { status: 401 }),
    })).resolves.toEqual({ ok: false, detail: 'API returned HTTP 401' });
    await expect(provider.check('not-for-logs', {
      fetch: async () => { throw new Error('request not-for-logs rejected'); },
    })).resolves.toEqual({ ok: false, detail: 'Error: request [redacted] rejected' });
  });

  it('applies provider deadlines to requests and key checks with a zero opt-out', async () => {
    const request = vi.fn<AgentFetch>().mockImplementation(async (_url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '{"action":{"id":"advance"}}' } }],
      }));
    });
    const driver = createKeyedAgentDriver<View>('openai', {
      apiKey: 'secret-key', model: 'test-model', fetch: request,
    });
    await driver.act({
      observation: reducer.view(reducer.init({ goal: 2 }, 1)),
      legalActions: [{ id: 'advance' }], step: 0,
    });
    const provider = createDefaultKeyedProviderRegistry().require('openai');
    const check = vi.fn<AgentFetch>(async (_url, init) => {
      expect(init?.signal).toBeUndefined();
      return new Response('');
    });
    await expect(provider.check('secret-key', { fetch: check, timeoutMs: 0 }))
      .resolves.toMatchObject({ ok: true });
    expect(() => createKeyedAgentDriver('openai', {
      apiKey: 'secret-key', model: 'test-model', timeoutMs: -1,
    })).toThrow('timeoutMs');
  });
});
