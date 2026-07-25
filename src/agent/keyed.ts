import type { SubmittedAction } from '../engine/contracts.js';
import { locationKey } from '../engine/locations.js';
import {
  isLegalAgentDecision,
  type AgentDecision,
  type AgentDriver,
  type AgentDriverContext,
  type AgentInterruptionResult,
  type AgentTokenUsage,
} from './driver.js';

export type AgentFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface KeyCheck {
  ok: boolean;
  detail: string;
}

export interface KeyedAgentDriverOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  fetch?: AgentFetch;
  maxTokens?: number;
  headers?: Readonly<Record<string, string>>;
  systemPrompt?: string;
  /** Number of completed user/assistant exchanges retained. Defaults to 8. */
  maxHistoryTurns?: number;
  /** Maximum UTF-8 bytes for system prompt, retained history, and current context. Defaults to 256 KiB. */
  maxContextBytes?: number;
  /** Maximum provider response body size. Defaults to 1 MiB. */
  maxResponseBytes?: number;
  /** Retries for HTTP 429 and 5xx responses. Defaults to 2. */
  maxRetries?: number;
  /** Initial exponential backoff delay in milliseconds. Defaults to 250. */
  retryBaseDelayMs?: number;
  /** Maximum retry delay after backoff and Retry-After handling. Defaults to 30 seconds. */
  maxRetryDelayMs?: number;
  /** Random source in [0, 1] for retry jitter. Defaults to Math.random. */
  retryJitter?: () => number;
  /** Optional delay implementation for deterministic harnesses. */
  sleep?: (delayMs: number, signal: AbortSignal) => Promise<void>;
  /** Complete provider-call deadline. Defaults to 30,000; zero disables it. */
  timeoutMs?: number;
}

export interface KeyedProvider {
  readonly id: string;
  readonly label: string;
  readonly apiKeyEnv: string;
  readonly login: string;
  readonly baseUrl: string;
  readonly defaultModel?: string;
  check(apiKey: string, options?: {
    fetch?: AgentFetch;
    signal?: AbortSignal;
    /** Defaults to 30,000; zero disables it. */
    timeoutMs?: number;
  }): Promise<KeyCheck>;
  createDriver<TObservation = unknown>(options: KeyedAgentDriverOptions): AgentDriver<TObservation>;
}

export class KeyedProviderRegistry {
  private readonly providers = new Map<string, KeyedProvider>();
  private readonly aliases = new Map<string, string>();

  constructor(providers: readonly KeyedProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: KeyedProvider, options: { replace?: boolean; aliases?: readonly string[] } = {}): this {
    if (!provider.id.trim()) throw new TypeError('keyed provider id must not be empty');
    if (this.providers.has(provider.id) && !options.replace) {
      throw new Error(`keyed provider is already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
    for (const alias of options.aliases ?? []) this.alias(alias, provider.id);
    return this;
  }

  alias(alias: string, providerId: string): this {
    if (!this.providers.has(providerId)) throw new Error(`unknown keyed provider: ${providerId}`);
    this.aliases.set(alias, providerId);
    return this;
  }

  get(id: string): KeyedProvider | undefined {
    const normalized = id.startsWith('key:') ? id.slice(4) : id;
    return this.providers.get(this.aliases.get(normalized) ?? normalized);
  }

  require(id: string): KeyedProvider {
    const provider = this.get(id);
    if (!provider) throw new Error(`unknown keyed provider: ${id}`);
    return provider;
  }

  list(): KeyedProvider[] {
    return [...this.providers.values()];
  }
}

const DEFAULT_SYSTEM_PROMPT = [
  'You are controlling a deterministic tick-based game environment.',
  'Choose exactly one entry from legalActions or systemActions.',
  'Return only JSON with this shape:',
  '{"reasoning":"brief explanation","action":{"id":"action id","x":0,"y":0,"index":0,"boardId":"board","seat":"seat","targets":[{"container":"board","coord":[1,2]}]},"message":"optional"}',
  'Omit x, y, index, boardId, zoneId, seat, or targets when the selected legal action does not contain it.',
].join('\n');

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function balancedJsonObject(text: string): string | undefined {
  let start = -1;
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (start < 0) {
      if (char === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === '{') depth++;
    else if (char === '}' && --depth === 0) return text.slice(start, index + 1);
  }
  return undefined;
}

function optionalInteger(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value)) throw new TypeError(`agent decision ${name} must be an integer`);
  return value as number;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`agent decision ${name} must be a non-empty string`);
  }
  return value;
}

function optionalTargets(value: unknown): SubmittedAction['targets'] {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TypeError('agent decision targets must be an array');
  return value.map((candidate, index) => {
    const target = record(candidate);
    if (!target) throw new TypeError(`agent decision targets[${index}] must be an object`);
    const location = {
      container: target.container,
      coord: target.coord,
    } as SubmittedAction['targets'] extends readonly (infer T)[] | undefined ? T : never;
    try {
      locationKey(location);
    } catch (error) {
      throw new TypeError(`agent decision targets[${index}] is invalid`, { cause: error });
    }
    return location;
  });
}

/** Parse a model response into the provider-neutral action contract. */
export function parseAgentDecision(text: string): AgentDecision {
  const json = balancedJsonObject(text);
  if (!json) throw new TypeError('agent response did not contain a JSON object');
  const root = record(JSON.parse(json));
  if (!root) throw new TypeError('agent response must be a JSON object');
  const nested = record(root.action);
  const candidate = nested ?? root;
  const id = typeof candidate.id === 'string'
    ? candidate.id
    : typeof candidate.action === 'string'
      ? candidate.action
      : undefined;
  if (!id?.trim()) throw new TypeError('agent decision action.id must be a non-empty string');
  const action: SubmittedAction = {
    id,
    ...(candidate.x !== undefined ? { x: optionalInteger(candidate.x, 'x') } : {}),
    ...(candidate.y !== undefined ? { y: optionalInteger(candidate.y, 'y') } : {}),
    ...(candidate.index !== undefined ? { index: optionalInteger(candidate.index, 'index') } : {}),
    ...(candidate.boardId !== undefined ? { boardId: optionalString(candidate.boardId, 'boardId') } : {}),
    ...(candidate.zoneId !== undefined ? { zoneId: optionalString(candidate.zoneId, 'zoneId') } : {}),
    ...(candidate.seat !== undefined ? { seat: optionalString(candidate.seat, 'seat') } : {}),
    ...(candidate.targets !== undefined ? { targets: optionalTargets(candidate.targets) } : {}),
  };
  return {
    action,
    ...(typeof root.reasoning === 'string' ? { reasoning: root.reasoning } : {}),
    ...(typeof root.message === 'string' ? { message: root.message } : {}),
  };
}

export function formatAgentContext<TObservation>(context: AgentDriverContext<TObservation>): string {
  return JSON.stringify({
    step: context.step,
    observation: context.observation,
    actionDefinitions: context.actionDefinitions,
    legalActions: context.legalActions,
    systemActions: context.systemActions,
    guidance: context.guidance,
  });
}

function systemPrompt<TObservation>(
  options: KeyedAgentDriverOptions,
  context: AgentDriverContext<TObservation>,
): string {
  return [options.systemPrompt, context.systemPrompt, DEFAULT_SYSTEM_PROMPT]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n\n');
}

function secretSafeError(message: string, apiKey: string): Error {
  return new Error(apiKey ? message.split(apiKey).join('[redacted]') : message);
}

async function limitedResponseText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new Error(`agent provider response exceeds ${maxBytes} bytes`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

async function responseError(response: Response, apiKey: string, maxBytes: number): Promise<Error> {
  const body = (await limitedResponseText(response, maxBytes)).replace(/\s+/g, ' ').slice(0, 500);
  return secretSafeError(`agent provider returned HTTP ${response.status}${body ? `: ${body}` : ''}`, apiKey);
}

function defaultSleep(delayMs: number, signal: AbortSignal): Promise<void> {
  if (delayMs === 0) return Promise.resolve();
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function assertNonNegativeInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

function providerSignal(timeoutMs: number, signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  assertNonNegativeInteger(timeoutMs, 'timeoutMs');
  const timeout = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
  const present = [...signals, timeout].filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

async function requestWithRetries(
  request: AgentFetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
  options: Required<Pick<KeyedAgentDriverOptions,
    'maxRetries' | 'retryBaseDelayMs' | 'maxRetryDelayMs' | 'retryJitter' | 'sleep'>>,
): Promise<Response> {
  const jitter = (): number => {
    const value = options.retryJitter();
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new RangeError('retryJitter must return a finite number between 0 and 1');
    }
    return value;
  };
  for (let attempt = 0; ; attempt++) {
    let response: Response;
    try {
      response = await request(url, { ...init, signal });
    } catch (error) {
      if (signal.aborted || attempt >= options.maxRetries) throw error;
      const random = jitter();
      const delay = Math.min(
        options.maxRetryDelayMs,
        options.retryBaseDelayMs * (2 ** attempt) * (0.5 + random),
      );
      await options.sleep(delay, signal);
      continue;
    }
    const transient = response.status === 429 || response.status >= 500;
    if (!transient || attempt >= options.maxRetries) return response;
    const retryAfter = response.headers.get('retry-after');
    let retryAfterMs = 0;
    if (retryAfter) {
      const seconds = Number(retryAfter);
      if (Number.isFinite(seconds)) retryAfterMs = Math.max(0, seconds * 1000);
      else {
        const date = Date.parse(retryAfter);
        if (Number.isFinite(date)) retryAfterMs = Math.max(0, date - Date.now());
      }
    }
    await response.body?.cancel();
    const random = jitter();
    const backoff = options.retryBaseDelayMs * (2 ** attempt) * (0.5 + random);
    await options.sleep(Math.min(options.maxRetryDelayMs, Math.max(backoff, retryAfterMs)), signal);
  }
}

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

function boundedMessages(
  system: string,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
  current: string,
  maxBytes: number,
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const fixedBytes = utf8Bytes(system) + utf8Bytes(current);
  if (fixedBytes > maxBytes) {
    throw new RangeError(`agent context exceeds ${maxBytes} UTF-8 bytes without history`);
  }
  let start = 0;
  let historyBytes = history.reduce((total, message) => total + utf8Bytes(message.content), 0);
  while (fixedBytes + historyBytes > maxBytes && start < history.length) {
    const remove = Math.min(2, history.length - start);
    for (let index = 0; index < remove; index++) {
      historyBytes -= utf8Bytes(history[start + index]!.content);
    }
    start += remove;
  }
  return [
    { role: 'system', content: system },
    ...history.slice(start),
    { role: 'user', content: current },
  ];
}

function assertLegal<TObservation>(
  decision: AgentDecision,
  context: AgentDriverContext<TObservation>,
): AgentDecision {
  if (!isLegalAgentDecision(decision, [...context.legalActions, ...(context.systemActions ?? [])])) {
    throw new TypeError(`agent selected an illegal action: ${JSON.stringify(decision.action)}`);
  }
  return decision;
}

function usage(inputTokens: unknown, outputTokens: unknown): AgentTokenUsage | undefined {
  const result: AgentTokenUsage = {};
  if (typeof inputTokens === 'number') result.inputTokens = inputTokens;
  if (typeof outputTokens === 'number') result.outputTokens = outputTokens;
  return Object.keys(result).length ? result : undefined;
}

export class OpenAICompatibleAgentDriver<TObservation = unknown> implements AgentDriver<TObservation> {
  readonly id: string;
  readonly label: string;
  private readonly request: AgentFetch;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly maxHistoryTurns: number;
  private readonly maxContextBytes: number;
  private readonly maxResponseBytes: number;
  private readonly retryOptions: Required<Pick<KeyedAgentDriverOptions,
    'maxRetries' | 'retryBaseDelayMs' | 'maxRetryDelayMs' | 'retryJitter' | 'sleep'>>;
  private readonly timeoutMs: number;
  private readonly history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private activeRequest?: AbortController;

  constructor(
    id: string,
    label: string,
    private readonly options: KeyedAgentDriverOptions & { defaultModel?: string; defaultBaseUrl: string },
  ) {
    this.id = id;
    this.label = label;
    this.request = options.fetch ?? fetch;
    this.model = options.model ?? options.defaultModel ?? '';
    this.baseUrl = (options.baseUrl ?? options.defaultBaseUrl).replace(/\/$/, '');
    this.maxTokens = options.maxTokens ?? 800;
    this.maxHistoryTurns = options.maxHistoryTurns ?? 8;
    this.maxContextBytes = options.maxContextBytes ?? 256 * 1024;
    this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retryOptions = {
      maxRetries: options.maxRetries ?? 2,
      retryBaseDelayMs: options.retryBaseDelayMs ?? 250,
      maxRetryDelayMs: options.maxRetryDelayMs ?? 30_000,
      retryJitter: options.retryJitter ?? Math.random,
      sleep: options.sleep ?? defaultSleep,
    };
    assertNonNegativeInteger(this.maxHistoryTurns, 'maxHistoryTurns');
    if (!Number.isSafeInteger(this.maxContextBytes) || this.maxContextBytes < 1) {
      throw new RangeError('maxContextBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) {
      throw new RangeError('maxResponseBytes must be a positive safe integer');
    }
    assertNonNegativeInteger(this.timeoutMs, 'timeoutMs');
    assertNonNegativeInteger(this.retryOptions.maxRetries, 'maxRetries');
    if (!Number.isFinite(this.retryOptions.retryBaseDelayMs) || this.retryOptions.retryBaseDelayMs < 0) {
      throw new RangeError('retryBaseDelayMs must be a non-negative finite number');
    }
    if (!Number.isFinite(this.retryOptions.maxRetryDelayMs) || this.retryOptions.maxRetryDelayMs < 0) {
      throw new RangeError('maxRetryDelayMs must be a non-negative finite number');
    }
    if (!options.apiKey) throw new TypeError('apiKey must not be empty');
    if (!this.model) throw new TypeError(`model is required for keyed provider ${id}`);
  }

  reset(): void {
    this.history.length = 0;
    this.activeRequest?.abort(new Error('agent reset'));
    this.activeRequest = undefined;
  }

  interrupt(): AgentInterruptionResult {
    const interrupted = this.activeRequest !== undefined;
    this.activeRequest?.abort(new Error('agent interrupted'));
    return { mode: 'abort', interrupted, preservesContext: true };
  }

  async act(context: AgentDriverContext<TObservation>): Promise<AgentDecision> {
    if (this.activeRequest) throw new Error('agent request already in progress');
    const controller = new AbortController();
    this.activeRequest = controller;
    const userMessage = formatAgentContext(context);
    try {
      const signal = providerSignal(this.timeoutMs, [context.signal, controller.signal])!;
      const prompt = systemPrompt(this.options, context);
      const messages = boundedMessages(prompt, this.history, userMessage, this.maxContextBytes);
      const response = await requestWithRetries(this.request, `${this.baseUrl}/chat/completions`, {
        method: 'POST',
        signal,
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          ...this.options.headers,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          messages,
        }),
      }, signal, this.retryOptions);
      if (!response.ok) throw await responseError(response, this.options.apiKey, this.maxResponseBytes);
      const raw: unknown = JSON.parse(await limitedResponseText(response, this.maxResponseBytes));
      const payload = record(raw);
      const choices = Array.isArray(payload?.choices) ? payload.choices : [];
      const first = record(choices[0]);
      const message = record(first?.message);
      if (typeof message?.content !== 'string') throw new TypeError('agent provider returned no message content');
      const parsed = parseAgentDecision(message.content);
      const tokens = record(payload?.usage);
      const decision = assertLegal({
        ...parsed,
        raw,
        usage: usage(tokens?.prompt_tokens, tokens?.completion_tokens),
      }, context);
      this.history.push({ role: 'user', content: userMessage }, { role: 'assistant', content: message.content });
      this.history.splice(0, Math.max(0, this.history.length - this.maxHistoryTurns * 2));
      while (this.history.length > 2
        && this.history.reduce((total, item) => total + utf8Bytes(item.content), 0) > this.maxContextBytes) {
        this.history.splice(0, 2);
      }
      return decision;
    } finally {
      if (this.activeRequest === controller) this.activeRequest = undefined;
    }
  }
}

export class AnthropicAgentDriver<TObservation = unknown> implements AgentDriver<TObservation> {
  readonly id: string;
  readonly label: string;
  private readonly request: AgentFetch;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly maxTokens: number;
  private readonly maxHistoryTurns: number;
  private readonly maxContextBytes: number;
  private readonly maxResponseBytes: number;
  private readonly retryOptions: Required<Pick<KeyedAgentDriverOptions,
    'maxRetries' | 'retryBaseDelayMs' | 'maxRetryDelayMs' | 'retryJitter' | 'sleep'>>;
  private readonly timeoutMs: number;
  private readonly history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  private activeRequest?: AbortController;

  constructor(
    id: string,
    label: string,
    private readonly options: KeyedAgentDriverOptions & { defaultModel?: string; defaultBaseUrl: string },
  ) {
    this.id = id;
    this.label = label;
    this.request = options.fetch ?? fetch;
    this.model = options.model ?? options.defaultModel ?? '';
    this.baseUrl = (options.baseUrl ?? options.defaultBaseUrl).replace(/\/$/, '');
    this.maxTokens = options.maxTokens ?? 800;
    this.maxHistoryTurns = options.maxHistoryTurns ?? 8;
    this.maxContextBytes = options.maxContextBytes ?? 256 * 1024;
    this.maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.retryOptions = {
      maxRetries: options.maxRetries ?? 2,
      retryBaseDelayMs: options.retryBaseDelayMs ?? 250,
      maxRetryDelayMs: options.maxRetryDelayMs ?? 30_000,
      retryJitter: options.retryJitter ?? Math.random,
      sleep: options.sleep ?? defaultSleep,
    };
    assertNonNegativeInteger(this.maxHistoryTurns, 'maxHistoryTurns');
    if (!Number.isSafeInteger(this.maxContextBytes) || this.maxContextBytes < 1) {
      throw new RangeError('maxContextBytes must be a positive safe integer');
    }
    if (!Number.isSafeInteger(this.maxResponseBytes) || this.maxResponseBytes < 1) {
      throw new RangeError('maxResponseBytes must be a positive safe integer');
    }
    assertNonNegativeInteger(this.timeoutMs, 'timeoutMs');
    assertNonNegativeInteger(this.retryOptions.maxRetries, 'maxRetries');
    if (!Number.isFinite(this.retryOptions.retryBaseDelayMs) || this.retryOptions.retryBaseDelayMs < 0) {
      throw new RangeError('retryBaseDelayMs must be a non-negative finite number');
    }
    if (!Number.isFinite(this.retryOptions.maxRetryDelayMs) || this.retryOptions.maxRetryDelayMs < 0) {
      throw new RangeError('maxRetryDelayMs must be a non-negative finite number');
    }
    if (!options.apiKey) throw new TypeError('apiKey must not be empty');
    if (!this.model) throw new TypeError(`model is required for keyed provider ${id}`);
  }

  reset(): void {
    this.history.length = 0;
    this.activeRequest?.abort(new Error('agent reset'));
    this.activeRequest = undefined;
  }

  interrupt(): AgentInterruptionResult {
    const interrupted = this.activeRequest !== undefined;
    this.activeRequest?.abort(new Error('agent interrupted'));
    return { mode: 'abort', interrupted, preservesContext: true };
  }

  async act(context: AgentDriverContext<TObservation>): Promise<AgentDecision> {
    if (this.activeRequest) throw new Error('agent request already in progress');
    const controller = new AbortController();
    this.activeRequest = controller;
    const userMessage = formatAgentContext(context);
    try {
      const signal = providerSignal(this.timeoutMs, [context.signal, controller.signal])!;
      const prompt = systemPrompt(this.options, context);
      const messages = boundedMessages(prompt, this.history, userMessage, this.maxContextBytes);
      const response = await requestWithRetries(this.request, `${this.baseUrl}/messages`, {
        method: 'POST',
        signal,
        headers: {
          'x-api-key': this.options.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
          ...this.options.headers,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: this.maxTokens,
          system: prompt,
          messages: messages.slice(1),
        }),
      }, signal, this.retryOptions);
      if (!response.ok) throw await responseError(response, this.options.apiKey, this.maxResponseBytes);
      const raw: unknown = JSON.parse(await limitedResponseText(response, this.maxResponseBytes));
      const payload = record(raw);
      const content = Array.isArray(payload?.content) ? payload.content : [];
      const text = content
        .map(record)
        .filter((part): part is Record<string, unknown> => part !== undefined)
        .filter((part) => part.type === 'text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('\n');
      if (!text) throw new TypeError('agent provider returned no message content');
      const parsed = parseAgentDecision(text);
      const tokens = record(payload?.usage);
      const decision = assertLegal({
        ...parsed,
        raw,
        usage: usage(tokens?.input_tokens, tokens?.output_tokens),
      }, context);
      this.history.push({ role: 'user', content: userMessage }, { role: 'assistant', content: text });
      this.history.splice(0, Math.max(0, this.history.length - this.maxHistoryTurns * 2));
      while (this.history.length > 2
        && this.history.reduce((total, item) => total + utf8Bytes(item.content), 0) > this.maxContextBytes) {
        this.history.splice(0, 2);
      }
      return decision;
    } finally {
      if (this.activeRequest === controller) this.activeRequest = undefined;
    }
  }
}

function openAIProvider(options: {
  id: string;
  label: string;
  apiKeyEnv: string;
  login: string;
  baseUrl: string;
  defaultModel?: string;
}): KeyedProvider {
  return {
    ...options,
    async check(apiKey, checkOptions = {}) {
      if (!apiKey) return { ok: false, detail: `missing ${options.apiKeyEnv}` };
      try {
        const response = await (checkOptions.fetch ?? fetch)(`${options.baseUrl}/models`, {
          signal: providerSignal(checkOptions.timeoutMs ?? 30_000, [checkOptions.signal]),
          headers: { authorization: `Bearer ${apiKey}` },
        });
        return response.ok
          ? { ok: true, detail: 'API key accepted' }
          : { ok: false, detail: `API returned HTTP ${response.status}` };
      } catch (error) {
        return { ok: false, detail: secretSafeError(String(error), apiKey).message };
      }
    },
    createDriver<TObservation>(driverOptions: KeyedAgentDriverOptions) {
      return new OpenAICompatibleAgentDriver<TObservation>(options.id, options.label, {
        ...driverOptions,
        defaultBaseUrl: options.baseUrl,
        defaultModel: options.defaultModel,
      });
    },
  };
}

const anthropicProvider: KeyedProvider = {
  id: 'anthropic',
  label: 'Anthropic',
  apiKeyEnv: 'ANTHROPIC_API_KEY',
  login: 'https://console.anthropic.com/settings/keys',
  baseUrl: 'https://api.anthropic.com/v1',
  defaultModel: 'claude-opus-4-8',
  async check(apiKey, options = {}) {
    if (!apiKey) return { ok: false, detail: 'missing ANTHROPIC_API_KEY' };
    try {
      const response = await (options.fetch ?? fetch)(`${anthropicProvider.baseUrl}/models`, {
        signal: providerSignal(options.timeoutMs ?? 30_000, [options.signal]),
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
      });
      return response.ok
        ? { ok: true, detail: 'API key accepted' }
        : { ok: false, detail: `API returned HTTP ${response.status}` };
    } catch (error) {
      return { ok: false, detail: secretSafeError(String(error), apiKey).message };
    }
  },
  createDriver<TObservation>(options: KeyedAgentDriverOptions) {
    return new AnthropicAgentDriver<TObservation>(anthropicProvider.id, anthropicProvider.label, {
      ...options,
      defaultBaseUrl: anthropicProvider.baseUrl,
      defaultModel: anthropicProvider.defaultModel,
    });
  },
};

export const KEYED_PROVIDERS = [
  anthropicProvider,
  openAIProvider({
    id: 'openai',
    label: 'OpenAI',
    apiKeyEnv: 'OPENAI_API_KEY',
    login: 'https://platform.openai.com/api-keys',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-5.1',
  }),
  openAIProvider({
    id: 'xai',
    label: 'xAI',
    apiKeyEnv: 'XAI_API_KEY',
    login: 'https://console.x.ai/',
    baseUrl: 'https://api.x.ai/v1',
    defaultModel: 'grok-4',
  }),
  openAIProvider({
    id: 'openrouter',
    label: 'OpenRouter',
    apiKeyEnv: 'OPENROUTER_API_KEY',
    login: 'https://openrouter.ai/keys',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'openrouter/auto',
  }),
] as const;

export function createDefaultKeyedProviderRegistry(): KeyedProviderRegistry {
  return new KeyedProviderRegistry(KEYED_PROVIDERS)
    .alias('api', 'anthropic')
    .alias('router', 'openrouter');
}

export function createKeyedAgentDriver<TObservation = unknown>(
  providerId: string,
  options: KeyedAgentDriverOptions,
  registry = createDefaultKeyedProviderRegistry(),
): AgentDriver<TObservation> {
  return registry.require(providerId).createDriver<TObservation>(options);
}
