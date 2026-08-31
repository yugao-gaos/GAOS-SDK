import type { JsonValue } from './protocol.js';

export const EXPERIENCE_PROVIDER_KINDS = [
  'reasoning',
  'speech_recognition',
  'speech_synthesis',
  'live_world',
  'replay_video',
] as const;

export type ExperienceProviderKind = typeof EXPERIENCE_PROVIDER_KINDS[number];
export type ExperienceProviderLocality = 'cloud' | 'local';

export interface ExperienceProviderDescriptor<K extends ExperienceProviderKind = ExperienceProviderKind> {
  id: string;
  kind: K;
  locality: ExperienceProviderLocality;
  label?: string;
}

export interface ExperienceProviderBase<K extends ExperienceProviderKind> {
  readonly descriptor: ExperienceProviderDescriptor<K>;
  health?(signal?: AbortSignal): Promise<'available' | 'unavailable'>;
}

export interface ExperienceReasoningMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ExperienceReasoningRequest {
  messages: readonly ExperienceReasoningMessage[];
  maxOutputTokens: number;
  temperature?: number;
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  response?:
    | { kind: 'text' }
    | { kind: 'json'; schema?: JsonValue };
}

export type ExperienceReasoningEvent =
  | { type: 'text_delta'; delta: string }
  | { type: 'completed' };

export interface ExperienceReasoningProvider
  extends ExperienceProviderBase<'reasoning'> {
  generate(
    request: ExperienceReasoningRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ExperienceReasoningEvent>;
}

export interface ExperienceAudioFrame {
  pcm16: Uint8Array;
  sampleRate: number;
  channels: 1 | 2;
}

export interface ExperienceTranscriptEvent {
  type: 'interim' | 'final';
  text: string;
  language?: string;
}

export interface ExperienceSpeechRecognitionRequest {
  audio: AsyncIterable<ExperienceAudioFrame>;
  language?: string;
  keyterms?: readonly string[];
}

export interface ExperienceSpeechRecognitionProvider
  extends ExperienceProviderBase<'speech_recognition'> {
  transcribe(
    request: ExperienceSpeechRecognitionRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ExperienceTranscriptEvent>;
}

export interface ExperienceSpeechSynthesisRequest {
  text: string;
  language?: string;
  voiceId?: string;
}

export interface ExperienceSpeechSynthesisProvider
  extends ExperienceProviderBase<'speech_synthesis'> {
  synthesize(
    request: ExperienceSpeechSynthesisRequest,
    signal?: AbortSignal,
  ): AsyncIterable<ExperienceAudioFrame>;
}

export interface ExperienceWorldPrompt {
  text: string;
  sequence: number;
  referenceImageUrl?: string;
  metadata?: Readonly<Record<string, JsonValue>>;
}

export type ExperienceWorldEvent =
  | { type: 'status'; status: 'starting' | 'ready' | 'updating' | 'closed' }
  | { type: 'media'; url: string; mediaType: string; sequence: number }
  | { type: 'error'; code: string; recoverable: boolean };

export interface ExperienceLiveWorldSession {
  readonly id: string;
  readonly events: AsyncIterable<ExperienceWorldEvent>;
  update(prompt: ExperienceWorldPrompt, signal?: AbortSignal): Promise<void>;
  close(reason?: string): Promise<void>;
}

export interface ExperienceLiveWorldProvider
  extends ExperienceProviderBase<'live_world'> {
  open(
    prompt: ExperienceWorldPrompt,
    signal?: AbortSignal,
  ): Promise<ExperienceLiveWorldSession>;
}

export interface ExperienceReplayVideoRequest {
  prompts: readonly ExperienceWorldPrompt[];
  audioUrl?: string;
  maxDurationMs?: number;
}

export interface ExperienceReplayVideoResult {
  url: string;
  mediaType: string;
  durationMs?: number;
}

export interface ExperienceReplayVideoProvider
  extends ExperienceProviderBase<'replay_video'> {
  generate(
    request: ExperienceReplayVideoRequest,
    signal?: AbortSignal,
  ): Promise<ExperienceReplayVideoResult>;
}

export interface ExperienceProviderByKind {
  reasoning: ExperienceReasoningProvider;
  speech_recognition: ExperienceSpeechRecognitionProvider;
  speech_synthesis: ExperienceSpeechSynthesisProvider;
  live_world: ExperienceLiveWorldProvider;
  replay_video: ExperienceReplayVideoProvider;
}

export type ExperienceProvider = ExperienceProviderByKind[ExperienceProviderKind];

export type ExperienceProviderSlots = {
  readonly [K in ExperienceProviderKind]: readonly string[];
};

export interface ExperienceProviderProfile {
  id: string;
  slots: ExperienceProviderSlots;
}

function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
}

function copyCandidates(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must contain at least one provider id`);
  }
  const candidates = value.map((candidate, index) => {
    assertText(candidate, `${label}[${index}]`);
    return candidate;
  });
  if (new Set(candidates).size !== candidates.length) {
    throw new TypeError(`${label} must not contain duplicate provider ids`);
  }
  return Object.freeze(candidates);
}

/** Validate and detach a host-authored provider profile from mutable config input. */
export function defineExperienceProviderProfile(
  profile: ExperienceProviderProfile,
): ExperienceProviderProfile {
  if (profile === null || typeof profile !== 'object') {
    throw new TypeError('experience provider profile must be an object');
  }
  assertText(profile.id, 'experience provider profile id');
  if (profile.slots === null || typeof profile.slots !== 'object') {
    throw new TypeError('experience provider profile slots must be an object');
  }
  const slots = Object.fromEntries(EXPERIENCE_PROVIDER_KINDS.map((kind) => [
    kind,
    copyCandidates(profile.slots[kind], `experience provider ${kind} candidates`),
  ])) as unknown as ExperienceProviderSlots;
  return Object.freeze({ id: profile.id, slots: Object.freeze(slots) });
}

/** Host-owned provider registry. Candidate order remains product policy. */
export class ExperienceProviderRegistry {
  readonly #providers = new Map<string, ExperienceProvider>();

  constructor(providers: readonly ExperienceProvider[] = []) {
    for (const provider of providers) this.register(provider);
  }

  register(provider: ExperienceProvider): void {
    if (provider === null || typeof provider !== 'object') {
      throw new TypeError('experience provider must be an object');
    }
    const { descriptor } = provider;
    if (descriptor === null || typeof descriptor !== 'object') {
      throw new TypeError('experience provider descriptor must be an object');
    }
    assertText(descriptor.id, 'experience provider id');
    if (!EXPERIENCE_PROVIDER_KINDS.includes(descriptor.kind)) {
      throw new TypeError('experience provider kind is unsupported');
    }
    if (descriptor.locality !== 'cloud' && descriptor.locality !== 'local') {
      throw new TypeError('experience provider locality is unsupported');
    }
    if (this.#providers.has(descriptor.id)) {
      throw new TypeError(`experience provider ${descriptor.id} is already registered`);
    }
    this.#providers.set(descriptor.id, provider);
  }

  candidates<K extends ExperienceProviderKind>(
    profile: ExperienceProviderProfile,
    kind: K,
  ): readonly ExperienceProviderByKind[K][] {
    return profile.slots[kind].map((id) => {
      const provider = this.#providers.get(id);
      if (provider === undefined) {
        throw new Error(`experience provider ${id} is not registered`);
      }
      if (provider.descriptor.kind !== kind) {
        throw new TypeError(
          `experience provider ${id} is ${provider.descriptor.kind}, expected ${kind}`,
        );
      }
      return provider as ExperienceProviderByKind[K];
    });
  }
}
