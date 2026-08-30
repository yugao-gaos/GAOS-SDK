# Speech input boundaries

GAOS exposes a transport-neutral hands-free speech segmenter from
`@yugao-gaos/gaos-sdk/speech-input`. It emits the same `segment_start` and
`segment_end` boundary events that a push-to-talk control would emit, so a
product can change input presentation without changing its agent run model.

```ts
import { AdaptiveSpeechSegmenter } from '@yugao-gaos/gaos-sdk/speech-input';

const speech = new AdaptiveSpeechSegmenter({
  sampleRate: 16_000,
  releaseMs: 1_500,
  speechThreshold: 0.04,
  assistantSpeechThreshold: 0.14,
});

for (const event of speech.pushPcm16(pcm, presentationContext)) {
  if (event.type === 'segment_start') transport.startSegment();
  else transport.endSegment(event.durationMs);
}
```

The product owns thresholds and the mapping to its transport. While assistant
audio is playing, the segmenter uses a separate, higher threshold and longer
onset confirmation. This reduces playback echo without disabling intentional
barge-in. A product should still request browser echo cancellation and noise
suppression.

`cancelSegment()` drops only the current candidate/open segment and retains the
learned listening noise floor. `reset()` also clears calibration. The class
does not retain audio or transcript content.
