# Deterministic randomness

The SDK provides a small seeded pseudo-random toolkit for replayable game rules.
It is deterministic JavaScript logic, not cryptographic randomness.

## Stateful streams

`mulberry32(seed)` returns a function producing values in `[0, 1)`. The numeric
seed is normalized to an unsigned 32-bit value. Calls advance private stream
state, so call order is part of the result:

```ts
const random = mulberry32(tickSeed);
const first = random();
const second = random();
```

Use a stream when a deliberately ordered operation makes several draws. Avoid
sharing one global stream across unrelated systems; inserting a new draw would
shift every later result.

## Event-keyed rolls

`roll(seed, eventKey)` hashes the string key with 32-bit FNV-1a, XORs it with
the seed, and takes the first Mulberry32 draw:

```ts
const hitRoll = roll(tickSeed, `attack:${attackerId}:${targetId}`);
```

The same seed and key always return the same value, independent of calls for
other events. Distinct logical draws need distinct stable keys. Reusing a key
reuses the exact outcome; it does not create a second sample.

Keys are processed as JavaScript string code units. Normalize ids and avoid
locale-formatted numbers or labels whose spelling may change between versions.

## Seeded permutations

`seededPermutation(n, seed)` performs a deterministic Fisher–Yates shuffle of
the indices `[0, n)`. It is used when wire actions or candidates need a stable
hidden order without changing canonical ids.

```ts
const permutation = seededPermutation(actions.length, sessionSeed);
const wireActions = permutation.map((canonicalIndex) => actions[canonicalIndex]);
```

Record the seed or permutation in the transcript whenever an external verifier
must reconstruct the mapping.

## Versioning warning

The exact algorithms are part of replay compatibility. Changing the hash, PRNG,
key format, draw order, or permutation algorithm changes historical outcomes.
When such a change is intentional, version the game/reducer rules and retain the
old implementation for old transcripts.

## Zonoid example

Zonoid stores the run seed and uses event-keyed draws for the small number of
character-effect outcomes that are intentionally probabilistic. The world
layout, beams, movement, NPC choices, and winnability remain deterministic;
the platform declares the odds in the observation and keys a roll by level,
attempt, subject, effect, and per-subject counter so junk actions cannot shift
the result stream.

<figure class="mechanism-video">
  <video controls muted playsinline preload="metadata" poster="/mechanisms/randomness-poster.jpg" aria-label="Focused Zonoid deterministic randomness and detection risk demo board recording">
    <source src="/mechanisms/randomness.mp4" type="video/mp4">
    Your browser does not support embedded video.
  </video>
  <figcaption>Focused Zonoid demo board: Look reveals labeled 100%, 35%, and 15% detection-risk cells while the seeded outcome remains replayable.</figcaption>
</figure>
