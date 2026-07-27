# Trust and verification

Game-as-a-Benchmark claims are useful only when the exact scored run remains
checkable. GAOS evidence is layered so each layer proves a different fact:

1. deterministic replay checks that the recorded inputs reproduce the recorded
   computation;
2. Ed25519 signatures authenticate which seat key authored a canonical
   submission;
3. a per-seat hash chain makes deletion, alteration, and reordering inside that
   seat's recorded stream detectable; and
4. product policy decides whether those facts are sufficient to adopt a score.

`gaos.replay` v1.3 therefore lets an evaluator check both the computation and
the authorship of signed submissions offline. An agent driver is an ordinary
seat with a key, so the same mechanism applies to human play, agent evaluation,
and mixed sessions.

## Verdicts

The verifier deliberately reports three adoption-level verdicts:

| verdict | condition | meaning |
|---|---|---|
| `trusted` | replay is consistent; signatures, chains, and periodic tiers reproduce; the historical adapter independently maps every signed command and timeout to the recorded action | adoptable as evidence |
| `unverifiable` | replay is consistent but signature evidence or a required historical semantic adapter is unavailable | absence of evidence, not evidence of a problem |
| `rejected` | replay is inconsistent, cryptographic evidence fails, or an independently mapped action differs | positive evidence of a problem |

The library keeps the underlying facts separate. `result.ok` still means
deterministic replay consistency. `result.signatures.state` is `signed`,
`partial`, or `unsigned`. `result.verdict` composes those facts for adoption.
`result.semantics` separately reports submission and timeout reconstruction as
`verified`, `unavailable`, `not_applicable`, or `failed`.
A friendly host may accept an unsigned run; a scoring authority can require
`trusted`.

## What is signed

The fixed scheme is `gaos.submission.ed25519.v1`. Its byte-exact preimage uses
u32 big-endian length framing for byte strings and u64 big-endian integers:

```text
domainTag, sessionId, seat, submissionId,
cursor, tick, clientTime,
UTF8(canonicalJson(command)), prevChainHash
```

The public fixture
`fixtures/signatures/gaos.submission.ed25519.v1.vectors.json` publishes three
complete preimages, signatures, public keys, chain hashes, and the roster hash.
TypeScript and Python test the same bytes.

The header roster is:

```ts
const seatKeys = [{
  id: 'north',
  publicKey: '…canonical padded base64…',
  alg: 'Ed25519',
  signingTier: { N: 100 },
}];
```

Roster order does not matter. The SDK hashes the roster after sorting by seat
id and binds that hash into every seat's genesis link. Replacing one public key
therefore breaks the existing chains. Binding a key to an account or person is
still product policy; the SDK proves possession of the listed key, not a
real-world identity.

The roster is immutable for the life of a v1 session. Key rotation or seat
reassignment starts a new session with a new roster and new chain genesis;
hosts must not rewrite an existing header. A lost private key cannot be
recovered or replaced inside the session. The host may reject further input or
accept an unsigned continuation according to product policy, but the resulting
artifact cannot retain a complete trusted chain for that seat. Spectators do
not submit and therefore need no seat key; an agent or bot occupying a seat
does.

Commit and reveal submissions always require direct signatures. Ordinary
high-rate submissions may advance the chain without a direct signature, with a
signed chain head required within the seat's declared `N`. A
`seat-signature` record carries that periodic attestation without becoming a
gameplay input. Interest declarations always require a direct tier-2
signature: this proves which `(seat, scopeId)` delivery scope the client asked
for without treating the scope as reducer input. Multi-level runs sign an outstanding chain head before the
level boundary, where the tick counter may reset. `clientTime` is mandatory in chained material, recorded as UTC
milliseconds, and never trusted as a clock authority.

## Client adoption

Generate and retain an Ed25519 key pair client-side. Publish only the raw
public key in the session roster. The TypeScript helpers use WebCrypto:

```ts
import {
  exportSubmissionPublicKey,
  generateSubmissionKeyPair,
  signSubmissionV1,
  submissionChainHashV1,
  submissionGenesisHashV1,
  submissionRosterHashV1,
} from '@yugao-gaos/turn-based-grid-sdk/engine';

const keys = await generateSubmissionKeyPair();
const publicKey = await exportSubmissionPublicKey(keys.publicKey);
const rosterHash = submissionRosterHashV1(seatKeys);
let chainHead = submissionGenesisHashV1(sessionId, seat, rosterHash);

const envelope = {
  sessionId,
  seat,
  submissionId,
  cursor,
  tick,
  clientTime: Date.now(),
  command,
  prevChainHash: chainHead,
};
const sig = await signSubmissionV1(keys.privateKey, envelope);
chainHead = submissionChainHashV1(envelope);
```

Persist the key, current chain head, and the exact signed envelope before
sending. An exact network retry reuses all three. Retain signed chain heads
after a run: they are the dispute evidence for a host-truncated tail.

Python provides equivalent zero-dependency helpers over a 32-byte private
seed: `ed25519_public_key_from_seed`, `sign_submission_v1`, chain hashing, and
synchronous verification.

## Host adoption

Construct `SessionKernel` with matching `seatKeys` and
`signaturePolicy: { scheme: 'gaos.submission.ed25519.v1' }`. Record the
submission fields unchanged. The host is not required to verify signatures:
the feature protects a later auditor from a faithless host, so host-side
verification is not the trust boundary. If useful, verify periodic signatures
asynchronously to detect a broken client early.

Call `prepareSeatSignature` for a periodic chain-head attestation. Like every
prepared transition, persist its event before `commit()` and publish only
after commit. It is durable and ordered but never reaches the reducer.

An unsigned legacy submission remains representable. In a declared signed
session it breaks the chain and the artifact becomes `partial`/`rejected`;
product policy decides whether the live host accepts it.

Timeout actions use the same pure-adapter boundary. Configure
`timeoutToAction(context, timeout)` and let `prepareTimeout(timeout)` derive
the system action. In ticks cadence, an optional
`timeoutPolicy: { mode: 'ticks', windowTicks: N }` requires the timeout record
at exactly `windowRef + N` and the fixed reference
`header.timeoutPolicy`. Turns cadence intentionally makes no positional
claim.

## Scoring-authority adoption

Require `trusted` before accepting a scored run. This converts evidence
withholding into a visible forfeiture while leaving casual unsigned play
valid. Pin the historical game adapter named by the artifact, then verify
offline:

```sh
gaos verify run.gaos-replay.jsonl --adapter ./historical-adapter.mjs
gaos verify run.gaos-replay.jsonl --adapter ./historical-adapter.mjs --json

gaos-verify run.gaos-replay.jsonl --adapter ./historical_adapter.py
```

The TypeScript adapter exports `resolveReplayReducer(context)` (or that
function as default) plus `semanticAdapterForLevel(context)`, whose result
contains the historical `commandToAction` and, when applicable,
`timeoutToAction` functions. Omitting those pure mappings cannot produce
`trusted`; a differing mapping produces `rejected`. The Python adapter exports
`recheck_replay(artifact)` and reports the equivalent semantic-binding fact.
Both commands exit `1` for `rejected`, `0` for a consistent `trusted` or
`unverifiable` artifact, and `2` for invocation or loading errors. Verification
needs no network, account, or GAOS-operated service.

## Honest limits

If an artifact claims to be signed, its signed portions are authentic.
Nothing guarantees that signed evidence is produced at all.

Signatures and chains do not prove:

- that a roster key belongs to a named person or account;
- that a cooperating player refused a host's request;
- when an event happened or that a wall-clock timeout was fair;
- that an artifact was published rather than discarded; or
- that a self-consistent tail was not truncated.

Clients can lie about `clientTime`; it also exposes thinking-time and activity
patterns, so products should treat it as sensitive behavioral data. Optional
`hostTime` remains advisory operations metadata and is never signed or used to
order replay.

GAOS deliberately uses signatures and hash chains, not a blockchain. External
root anchoring could close truncation if a real cross-host leaderboard needs
it; it is not part of the v1.2/v1.3 signed-evidence construction.

## External trust and historical verifier availability

RFC-014 and RFC-015 supply interfaces for products that want stronger
identity, timestamp, publication, tail-anchoring, and benchmark-manifest
claims. Those interfaces ship in v0.24, but no external authority is operated
by GAOS and those claims are not supplied by replay formats alone.

GAOS will not provide an external authority or its keys. The integrating
product selects any identity provider, timestamp authority, transparency log,
witness, certificate authority, or key-management service. The product
supplies pinned public keys or certificate roots and verification policy to
the SDK, owns service calls, rotation, revocation, account binding, and
availability, and keeps private keys external. A signer integration is a
callback; it does not transfer private-key custody to GAOS.

A public key or certificate chain embedded in an artifact is enough to check
whether that material signed the artifact, but not enough to trust the
authority. Trust requires an exact product or independently obtained
benchmark-manifest pin, or a valid certificate path to a product-pinned root.
The verifier reports cryptographic validity, pin matching, certificate
path, revocation state, and policy acceptance separately. Leaderboards must
also keep replay, identity, time, publication, anchoring, availability,
reproduction, source availability, model attestation, and hidden-test claims
separate instead of collapsing them into one `trusted` flag.

[RFC-016](rfcs/rfc-016-product-owned-verifier-kits.md) supplies the v0.25
availability boundary for the historical reducer and semantic adapter. The
product chooses whether to export and publish that code. GAOS standardizes its
content digest, discovery, cache, and restricted execution, while an
independently obtained manifest, signed catalog, or verifier-owned allowlist
must authorize the digest. A replay cannot establish trust in the verifier it
names.

See [RFC-014](rfcs/rfc-014-interoperability-and-dynamic-control-evidence.md)
for the external-trust SDK boundary,
[RFC-015](rfcs/rfc-015-verifiable-benchmark-publication.md) for manifest and
leaderboard policy, and
[RFC-016](rfcs/rfc-016-product-owned-verifier-kits.md) for historical-verifier
distribution.
