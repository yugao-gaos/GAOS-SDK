# Experience providers

GAOS keeps the room-agent lifecycle provider-neutral while allowing a host to
switch the services around an experience as one explicit profile. The public
contracts are exported from
`@yugao-gaos/gaos-sdk/experience-providers`.

The five provider kinds are deliberately separate:

| Kind | Owns | Does not own |
|---|---|---|
| `reasoning` | model messages and public response deltas | room transcript or run durability |
| `speech_recognition` | PCM input to interim/final text | speaker authentication or turn admission |
| `speech_synthesis` | text to PCM output | playback arbitration or interruption policy |
| `live_world` | an updateable media session | the product's deterministic visual fallback |
| `replay_video` | a completed video artifact | the live session or private recording policy |

Splitting live world and replay video is intentional. A WebRTC world session,
a queued diffusion clip, and a final replay have different latency,
cancellation, and lifetime rules. A product can therefore use a deterministic
WebGL scene while a local video model renders in the background, then use a
different provider to assemble the final replay.

## Profiles and fallback

Provider order is product policy. A profile contains one non-empty ordered
candidate list for each kind. `defineExperienceProviderProfile()` validates,
copies, and freezes configuration. `ExperienceProviderRegistry.candidates()`
then resolves that order and rejects missing or wrongly wired providers.

```ts
import {
  ExperienceProviderRegistry,
  defineExperienceProviderProfile,
} from '@yugao-gaos/gaos-sdk/experience-providers';

const profile = defineExperienceProviderProfile({
  id: 'museum-local-first',
  slots: {
    reasoning: ['ollama-qwen', 'openrouter'],
    speech_recognition: ['sensevoice'],
    speech_synthesis: ['cosyvoice'],
    live_world: ['local-h3', 'three-fallback'],
    replay_video: ['local-h3-replay'],
  },
});

const registry = new ExperienceProviderRegistry(hostProviders);
const reasoningCandidates = registry.candidates(profile, 'reasoning');
```

The SDK does not silently pick the next provider. The host checks health,
deadlines, geography, privacy, and cost, then invokes candidates in the
declared order. A provider that emits a partial public response should not be
replaced mid-response unless the product has an explicit reconciliation rule.

## Local companions

The contracts use JSON-safe control data, `Uint8Array` PCM frames, and
`AsyncIterable` events. They do not assume Cloudflare, a browser
`MediaStream`, or a specific local model server. A museum installation can run
an authenticated loopback companion implementing the contracts while the
same product uses hosted providers online.

A hosted Worker cannot reach the visitor's `127.0.0.1`. A local profile must
therefore either run the host locally, use a local application/bridge, or
connect the browser to an explicitly trusted local endpoint. Provider
selection does not weaken that network boundary.

