import { describe, expect, it } from 'vitest';
import {
  ExperienceProviderRegistry,
  defineExperienceProviderProfile,
  type ExperienceProviderProfile,
  type ExperienceReasoningProvider,
  type ExperienceReplayVideoProvider,
} from '../src/experience-providers.js';

function profile(): ExperienceProviderProfile {
  return defineExperienceProviderProfile({
    id: 'museum-local-first',
    slots: {
      reasoning: ['reasoning-local', 'reasoning-cloud'],
      speech_recognition: ['stt-local'],
      speech_synthesis: ['tts-local'],
      live_world: ['world-local'],
      replay_video: ['replay-local'],
    },
  });
}

function reasoning(id: string): ExperienceReasoningProvider {
  return {
    descriptor: { id, kind: 'reasoning', locality: id.endsWith('local') ? 'local' : 'cloud' },
    async *generate() {
      yield { type: 'text_delta', delta: 'response' };
      yield { type: 'completed' };
    },
  };
}

function replay(id: string): ExperienceReplayVideoProvider {
  return {
    descriptor: { id, kind: 'replay_video', locality: 'local' },
    async generate() {
      return { url: 'http://127.0.0.1/replay.mp4', mediaType: 'video/mp4' };
    },
  };
}

describe('experience providers', () => {
  it('preserves product-authored fallback order and narrows by capability', () => {
    const registry = new ExperienceProviderRegistry([
      reasoning('reasoning-cloud'),
      reasoning('reasoning-local'),
    ]);

    expect(registry.candidates(profile(), 'reasoning').map(({ descriptor }) => (
      `${descriptor.id}:${descriptor.locality}`
    ))).toEqual([
      'reasoning-local:local',
      'reasoning-cloud:cloud',
    ]);
  });

  it('rejects a provider wired into the wrong capability slot', () => {
    const registry = new ExperienceProviderRegistry([replay('reasoning-local')]);
    expect(() => registry.candidates(profile(), 'reasoning')).toThrow(
      'reasoning-local is replay_video, expected reasoning',
    );
  });

  it('rejects missing providers instead of silently changing product policy', () => {
    const registry = new ExperienceProviderRegistry([reasoning('reasoning-local')]);
    expect(() => registry.candidates(profile(), 'reasoning')).toThrow(
      'reasoning-cloud is not registered',
    );
  });

  it('validates, de-duplicates, freezes, and detaches profile candidates', () => {
    const mutable = ['reasoning-local', 'reasoning-cloud'];
    const defined = defineExperienceProviderProfile({
      id: 'profile',
      slots: {
        reasoning: mutable,
        speech_recognition: ['stt-local'],
        speech_synthesis: ['tts-local'],
        live_world: ['world-local'],
        replay_video: ['replay-local'],
      },
    });
    mutable[0] = 'mutated';
    expect(defined.slots.reasoning).toEqual(['reasoning-local', 'reasoning-cloud']);
    expect(Object.isFrozen(defined)).toBe(true);
    expect(Object.isFrozen(defined.slots.reasoning)).toBe(true);

    expect(() => defineExperienceProviderProfile({
      ...defined,
      slots: { ...defined.slots, live_world: ['world-local', 'world-local'] },
    })).toThrow('must not contain duplicate provider ids');
  });

  it('isolates registries from duplicate provider ids', () => {
    expect(() => new ExperienceProviderRegistry([
      reasoning('same'),
      reasoning('same'),
    ])).toThrow('same is already registered');
  });
});
