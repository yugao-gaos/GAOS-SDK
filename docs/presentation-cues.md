# Presentation cues

`@yugao-gaos/gaos-sdk/presentation-cues` is a small, provider-neutral command
lane between an authoritative host and a browser, Godot, Unity, or native
presentation client. It is intended for non-authoritative effects such as
playing a prepared video, changing a scene, entering an immersive world, or
stopping an experience safely.

The product defines cue `type` values and JSON payloads. GAOS standardizes the
delivery behavior: monotonically increasing sequence numbers, stable cue IDs,
idempotent application, acknowledgements, bounded replay after reconnect, and
an emergency priority that may interrupt and supersede missing normal cues.

```ts
import {
  PresentationCueClient,
  PresentationCueHost,
} from '@yugao-gaos/gaos-sdk/presentation-cues';

const host = new PresentationCueHost({
  sessionId: 'visit-42',
  createId: crypto.randomUUID,
});

const cue = host.issue('enter_artwork', {
  artworkId: 'phoenix-eye',
  transition: 'portal',
});

const client = new PresentationCueClient({
  sessionId: 'visit-42',
  apply: async (nextCue) => renderer.applyCue(nextCue),
  interrupt: async () => renderer.stopCurrentEffect(),
});

host.acknowledge(await client.receive(cue));
```

## Reconnect and repair

Persist `host.state()` with the room/session. Persist `client.state()` with the
presentation process. On reconnect, send the client's `lastAppliedSequence`
to `host.resumeAfter(sequence)`. A `replay` response contains the retained tail
in order. `snapshot_required` means the client is older than the bounded cue
log; the product must send its current presentation snapshot before resuming
normal cues.

A normal out-of-order cue returns `repair_required` and is not applied. A
duplicate cue ID with identical content returns `duplicate`. Reusing an ID for
different content is rejected. Emergency cues call the optional interruption
hook before application and may advance over missing normal cues.

## Authority boundary

Presentation cues never mutate the product reducer and are not evidence of an
authoritative action. Reducer commands still use the ordinary GAOS session
path. Cue payloads must be JSON and should contain references and parameters,
not large media bodies or secrets.

The published JSON contract is
[`gaos.presentation-cue.v1`](./public/schemas/gaos.presentation-cue-v1.schema.json).
