# RFC-010 — Submission signatures, audit chains, and generic interest management

Status: **Parts A and B plus the resolved D/E implementation scope are
implemented for v0.20 development (2026-07-26); E1 and E4 are now resolved
additively** · Target: v0.20 · Breaking: **yes for observation delivery**
(codec v2 replaces snapshot-only v1 before the first product release; replay
v1.0/v1.1 compatibility remains) ·
Depends on: RFC-006, RFC-008, and **baseline T2 closed**

**This is the v0.20 document.** Parts A–C are the designed scope: signatures
(A) and interest (B) share an RFC because they couple at exactly one point —
an interest scope change is a client-declared, signable submission (§B4), the
only place where a bandwidth optimisation becomes a security-relevant claim —
and C is what must be documented alongside them.

Parts D and E are the *earned* scope: the two consumer migrations' return
channels under RFC-009 §4.3, consolidated here. **D** is what lands on the
v0.19.x line (four items, three of them migration-blocking); **E** is what
v0.20 should take on. Each consumer's own write-up is retired into these parts
as it is accepted — see the consolidated scope table at the end.

> **All four §B7 open questions are resolved (2026-07-26)**, including the
> scope-change lane, which turned out to rest on a false premise rather than a
> genuine contradiction (§B7.1). Two resolutions changed Part A: chain genesis
> now binds the roster (§A5.1 / §B7.4) and tier-3 `N` became per-seat (§A6 /
> §B7.3). **Part A has no dependency on Part B** and is buildable in parallel
> with the migrations (§B7.5).

---

# Part A — Submission signatures and the audit chain

## A1. Problem

`gaos.replay` verification today authenticates one thing cryptographically:
that a recorded `attemptedReveal` hashes differently from its commitment.
Everything else in the audit lane is **host attestation**. A host that
controls the artifact can reattribute a fumble to another seat, fabricate
unbounded "verified" mismatches against an unrevealed commitment, or delete
audit records entirely — all of which recheck `ok: true` (evidence:
`implementation-review-v019-tag-gate-2.md` §T4).

The structural cause is not a missing check. **The verifier reconstructs
state by replaying recorded inputs, and a rejected submission never becomes
an input**, so nothing in the reconstructible state constrains an audit
record. Three rounds of consistency patches each closed some holes and opened
others; internal consistency raises the bar from "append anything" to "append
something plausible" and stops there.

This matters because the mission claim is portable evidence that *anyone* can
verify. In a closed loop where the host produces and consumes its own
artifacts, host attestation is adequate. The moment a third-party arena
submits to a shared leaderboard — the explicit goal — the verifier becomes
the trust boundary, and an unauthenticated audit lane is the weakest link in
the chain the SDK is selling.

## A2. What signatures buy, and what they do not

Buy: **content authenticity** (these bytes came from that seat),
**authorship** (no reattribution), **unforgeability** (no invented
submissions).

Do **not** buy:

- **Deletion.** Signatures authenticate what is present. Removing a signed
  submission leaves every remaining signature valid. → this is why the chain
  (§A5) is not optional.
- **Truncation.** Dropping the tail of a session leaves a self-consistent
  chain. Detection needs client-held chain heads (dispute evidence) or
  external anchoring (deferred, §A10).
- **Time.** No timestamp authority ⇒ no proof of when.
- **Collusion.** A player who cooperates with a malicious host signs whatever
  is asked. Signatures bound *the host acting alone*, which is the threat
  that matters here.

The RFC must state these limits in the public docs, so "signed" is not read
as "trustworthy in every dimension" — the same discipline that renamed
`commit_violation` to `commit_mismatch` in RFC-008.

## A3. Identity boundary

A signature proves **the holder of key K produced these bytes**. It does not
prove *who* K is. Binding K to an account, a person, or an agent is product
policy and stays out of the SDK, exactly as authentication does in RFC-006 §2.

- The artifact header carries a **seat roster**: `seatKeys: [{ id, publicKey,
  alg, signingTier }]` — `signingTier` per §B7.3.
- **Roster integrity is closed by the SDK; roster *authenticity* is not.**
  §B7.4 binds `rosterHash` into every chain genesis, so key substitution
  breaks all chains and is `rejected`. What remains product policy is proving
  the roster names the intended people.
- How a verifier decides the roster is authentic is product policy (Arena
  signs the roster with a service key; a third party may pin it; a casual
  host may publish it unsigned). The SDK reports *what the roster says* and
  whether submissions match it — never who the seats "really are".
- The v1 roster is immutable. Key rotation or seat reassignment starts a new
  session with a new roster and chain genesis. A lost private key cannot be
  replaced in-session; product policy may reject further input or accept an
  unsigned continuation, which loses a complete trusted chain. Spectators
  need no key because they submit nothing. **Agents/bots** occupying seats do
  need keys, making benchmark runs signable.

## A4. Scheme

**Ed25519.** Deterministic (no per-signature randomness ⇒ no nonce-reuse
class of failure, and determinism is the SDK's whole posture), 64-byte
signatures, 32-byte keys, ubiquitous.

**The synchronous-verifier constraint drives the implementation.**
`recheckReplayArtifact` is synchronous by contract; WebCrypto Ed25519 is
async. Therefore:

- **Signing** may use async WebCrypto — it happens client-side, before
  submission, off the tick path (same placement decision as RFC-008 hashing).
- **Verification** ships as a **synchronous pure-JS Ed25519**, alongside the
  existing synchronous SHA-256, with permanent golden vectors (RFC 8032 test
  vectors are the obvious source).
- Cost budget to measure before merging: pure-JS verify is ~1–2 ms per
  signature; a long run with per-submission signatures reaches seconds of
  verification. Acceptable offline, but it is an argument for §A6 tiering
  and for a batch-verification path.
- **Python must verify too**, or the cross-language equivalence claim breaks
  the moment signatures exist. Python side needs the same vectors.

Implementation measurement (2026-07-26): the reproducible
`npm run signatures:benchmark` check measures about 2.9 ms/signature on the
development desktop after warm-up. That is above the planning estimate but
remains an offline cost; the per-seat periodic tier prevents it from entering
the host tick path.

## A5. The signing envelope

Byte-exact, framed with the same discipline RFC-008 §2 already proved out
(u32-BE length prefixes on every byte-string field, u64-BE integers, a
domain tag that is itself framed):

```
domainTag = UTF8("gaos.submission.ed25519.v1")     // distinct from gaos.commit.*
fields, in order:
  domainTag, sessionId, seat, submissionId,
  cursor (u64-BE), tick (u64-BE),
  clientTime (u64-BE),          // MANDATORY; see A5.2
  canonicalCommandBytes,        // UTF8(canonicalJson(command))
  prevChainHash                 // 32 raw bytes; see A5.1
```

- `scheme` pins the **complete construction** (canonicalisation + framing +
  hash + signature algorithm), append-only registry, exactly as
  `gaos.commit.sha256.v1` does.
- At least three published vectors showing the **complete preimage bytes**,
  the signature, and the public key — not only the final signature.

> **Hard dependency.** This envelope signs over `canonicalJson` output.
> v0.19 T2 is the prerequisite: both implementations now reject
> integer-valued numbers outside the JavaScript-safe range and unpaired
> surrogates, and sort keys by Unicode code point. Signing over any
> differently canonicalized form would produce signatures that verify in one
> implementation and fail in the other.

### A5.1 Per-seat chain

Each seat's submission includes the hash of **that seat's previous
submission** in the same session (`prevChainHash`).

**Genesis binds the roster** (resolved in §B7.4). The first submission's
`prevChainHash` is not zero but

```
H(domainTag ‖ sessionId ‖ seat ‖ rosterHash)
```

so that substituting any seat's public key invalidates **every** seat's chain
— including chains the substituting host cannot re-forge. This makes roster
tampering `rejected` rather than `unverifiable`, with no PKI required. It
costs one hash per session, client-side.

Per-seat rather than global, deliberately: the client can compute its own
previous hash **locally**, with no extra round trip and no dependency on the
host telling it the current global head. It detects exactly the attack that
motivates this RFC — *the host deleted or altered one of my submissions*.
Global ordering is separately covered by the host's own event chain
(reserved in v0.19), which is host-attested and therefore weaker; the two
compose without conflicting.

Chain verification is a pure recomputation from the recorded submissions: any
deletion, alteration, or reordering inside a seat's stream fails to reproduce
the signed head.

### A5.2 `clientTime` — mandatory, recorded but not validated

The client's own UTC-millisecond timestamp is a **required** field of the
signing preimage.

**Why mandatory rather than optional.** An optional evidence field is a
downgrade vector: a colluding or merely lazy host can request submissions
without timestamps and the evidence disappears silently, while the artifact
still looks well-formed. Mandatory inside the envelope means the only way to
have no timestamp is to have **no signature at all** — which is already
visible as `partial`/`unsigned` in the §A9b.1 verdict. The point is not
completeness; it is making a downgrade impossible to hide.

Three constraints ship with it:

1. **Mandatory to record, never validated for correctness.** Client clocks
   are wrong, skewed, and time-zoned. The verifier records and reports; it
   MUST NOT reject a submission for an implausible absolute time, or a player
   with a bad clock cannot play. Its evidentiary use is **relative intervals
   cross-checked between seats**, never absolute time.
2. **Its scope is the signed envelope.** Unsigned submissions (§A8) carry no
   `clientTime`, which is self-consistent: unsigned material is not evidence
   in the first place.
3. **Format and privacy.** UTC milliseconds as an unsigned integer.
   Document that it leaks behavioural signal — thinking time, time zone,
   activity hours — since mandatory means products cannot opt out.

`clientTime` and an optional host-provided `hostTime` use the same UTC epoch.
They are therefore mutually checkable for clock-skew diagnostics and weak
network-delay bounds, strengthening §A9c.4 without turning either clock into
an authority. Neither value is used to order the durable transcript.

Agents and bots sign with a `clientTime` like anyone else. It carries no
fairness meaning for a batch evaluation, but a uniform rule beats an
exception.

**Weak by construction, and labelled as such:** a client can lie about its own
clock, and a client colluding with the host provides no constraint at all.
`clientTime` is bounded cross-seat evidence, not a time authority. The strong
answer remains external anchoring (§A10).

## A6. Tiered signing policy

Signing every input at 20–30 Hz is impractical for a tick-paced product
(64 bytes plus signing cost per input per seat). Three tiers over **one**
mechanism — same envelope, same chain:

| tier | what | why |
|---|---|---|
| **1. Always sign** | every `reveal` (and its `commit`) | the audit lane this RFC exists to close; low frequency by nature |
| **2. Always sign** | every interest-scope change (§B4) | client-declared subscription; proves what the client asked to see, so a host cannot later claim it was never asked |
| **3. Periodic** | one signature per seat every N ticks (or on window close in turns mode), over the seat's **current chain head** | one signature authenticates all N intervening submissions |

**Tier 3 is chained periodic signing, explicitly not sampling.** Random
spot-checking was considered and rejected: (a) coverage is only
probabilistic; (b) it is unsound unless the sample is unpredictable to the
signer at submission time, which forces the seed to derive from future state
and adds a timing dependency; (c) the chain already gives **100 % coverage at
O(1/N) cost**, because the signed head binds every intermediate submission.
Sampling would be strictly worse in both coverage and complexity.

`N` is product policy with an SDK default, and is **per seat**, recorded in
that seat's roster entry (resolved in §B7.3 — chains are per-seat, so `N` is a
per-chain property). It **must be recorded, never inferred from observed
signature spacing**: otherwise a verifier cannot distinguish `N = 100` from
`N = 10` with 90 % of signatures suppressed by the host.

## A6b. Who verifies — and why hosts need not

**Host verification is not what defends against a malicious host.** Signatures
exist *for the third party*; asking the adversary to check its own work
proves nothing. The split:

| verifier | when | defends against | verifies signatures |
|---|---|---|---|
| host | during the session | broken or cheating **clients** | **optional** — the host already has its own live validation (pre-reducer commitment verification, legality, ordering) |
| third party / auditor | after the session | **the malicious host** | **always** — this is the entire point |

**Normative: a host is NOT required to verify signatures.** It accepts them
as opaque bytes, records them in the transcript, and transmits them. No
cryptography is required on the hot path.

**Recommended:** verify only the tier-3 periodic signature, asynchronously,
off the critical path — enough to notice a broken client early instead of
discovering it post-hoc after a whole session. Measured envelope (4 seats,
30 Hz, pure-JS verify ≈1.5 ms):

| policy | host CPU |
|---|---|
| verify every submission | ~180 ms/s ≈ **18 % of a core** — do not do this |
| verify tier-3 only (N=100) | ~1.2 verifies/s ≈ **0.18 % of a core** |
| verify nothing | 0 |

`prevChainHash` is computed **client-side**; the host only stores it.
Signature storage is ~88 base64 chars per signature: at tier-3 defaults,
≈0.6 MB per 10 minutes per session, against ~74 MB/seat/10 min of delta
traffic. Negligible in both dimensions.

Without this stated normatively, independent hosts will each implement
per-submission verification and pay 18 % of a core for a property that
protects nobody from them.

### What a faithless host can and cannot do

Detected by the post-hoc verifier: deleting a submission (the seat's chain no
longer reproduces the signed head), altering one (same), reattributing a
fumble (signature fails against that seat's public key), fabricating a
submission (no valid signature).

**Not preventable, by construction:** a host can always emit a fully
*unsigned* artifact and claim the session was unsigned. No artifact format
can compel a party to produce evidence. The guarantee is therefore one-sided
and must be documented as such:

> If an artifact claims to be signed, its signed portions are authentic.
> Nothing guarantees that signed evidence is produced at all.

This is converted from a security problem into an incentive problem at the
**policy** layer, which is why §A7's three-state result is load-bearing
rather than cosmetic: a scoring authority requires `signed` for scored runs,
so withholding evidence forfeits the score while forging it is detectable.
The header's declared `signaturePolicy` is what makes *selective* stripping
visible too — a verifier knows how many signatures to expect, so a gap
surfaces as `partial` with a located hole rather than a silent downgrade.

**Truncation** (dropping the tail) is the one case the artifact alone cannot
close: the remaining chain is self-consistent. It is closed by clients
retaining their own signed chain heads as dispute evidence — a client
produces a signed head covering submissions absent from the host's artifact.
That is client-side and needs no host cooperation; the SDK's part is only to
make the chain head a well-defined, reproducible value.

## A7. Artifact layout and the three-state result

- Header: `seatKeys: [{ id, publicKey, alg }]`, `signaturePolicy: { scheme, N }`.
- Each `ReplayAction` / resolution input: optional `sig`, `prevChainHash`.
- **Rejection records must carry the signed submission** — that is the whole
  point: the verifier independently establishes that the seat really sent
  that reveal *and* that its hash differs from the commitment.
- `RecheckResult` gains an explicit **three-state** signature verdict:
  `signed` (every submission the policy requires is signed and every chain
  reproduces), `partial` (some are), `unsigned` (none). Auditors must be
  able to distinguish these programmatically — repeating the `ok`-only
  ambiguity that RFC-008's redacted-record diagnostic already ran into would
  waste the whole exercise.
- Back-compat: v1.1 artifacts without signatures verify exactly as today and
  report `unsigned`.
- Format: additive optional fields on the slots **reserved in v0.19** ⇒
  `gaos.replay` **v1.2**, not v2.

The v1.1 reservation accepts and round-trips, without cryptographic meaning:
header `seatKeys`/`signaturePolicy`/`timeoutPolicy`; the periodic
`seat-signature` record; action and resolution-input
`submissionId`/`canonicalCommand`/`cursor`/`clientTime`/`prevChainHash`/`sig`;
and matching mismatch fields. Live submission and session-event types
likewise reserve `clientTime`, `prevChainHash`, and `sig`. v1.2 validates
and interpret these fields; in particular, `clientTime` becomes mandatory
whenever `sig` is present.

## A8. Unsigned submissions

A client may lack a key, refuse to sign, or be a legacy build. The host must
be able to accept such a submission and have the contract express it: the
submission is recorded with no `sig`, the seat's chain is marked broken from
that point, and the result degrades to `partial`. Whether to accept at all is
product policy (Arena may refuse for scored runs; a casual host may not
care), but the *representation* must exist or hosts will invent divergent
ones.

## A9. Test plan

- RFC 8032 Ed25519 vectors, in TypeScript **and** Python.
- Published preimage+signature vectors for the envelope (complete preimage
  bytes), verified in both languages.
- Tamper matrix: altered command, altered submissionId, altered cursor/tick,
  reattributed seat, wrong key, deleted mid-chain submission, reordered
  submissions, truncated tail, forged rejection record with a valid-looking
  but unsigned reveal.
- Chain: recomputation across a full session; a deleted submission must fail
  the signed head.
- Three-state result: signed / partial / unsigned artifacts each report
  correctly, and `ok` remains orthogonal to the signature verdict.
- Cross-language: an artifact signed by the TypeScript client verifies in
  Python and vice versa (this is the claim that makes the format an interop
  boundary).
- Performance: verification cost for a realistic run at each tier.

Added by the §B7 resolutions:

- **Roster substitution (§B7.4):** swap one seat's `publicKey` in a finished
  artifact and assert **every** seat's chain fails — including seats the
  attacker never touched — and that the verdict is `rejected`, not
  `unverifiable`. Also assert the negative: a roster reordering that leaves
  every `(id, publicKey, alg, signingTier)` tuple intact must **not** change
  `rosterHash`, or honest hosts will produce spuriously rejected artifacts.
- **Genesis binding:** two sessions identical in every respect except
  `rosterHash` produce disjoint chains from the first submission onward.
- **Signature suppression (§B7.3):** an artifact declaring `signingTier.N =
  10` whose tier-3 signatures actually appear every 100 submissions is
  detected. Assert the verifier reads the **declared** `N` from the roster and
  never infers it from observed spacing.
- **Per-seat `N`:** a roster mixing a densely-signed agent seat with a sparsely
  signed human seat verifies, and each seat is judged against its own
  declared tier.

## A9b. Verdict vocabulary and the public verification service

Policy decision (2026-07-25): **an unsigned artifact is not adoptable as
evidence**, and a public verification API will let anyone obtain that verdict
without installing anything.

### A9b.1 Three verdicts, never two

`unsigned` and `forged` must never collapse into one "untrusted" answer —
collapsing them destroys the information the verdict exists to carry:

| verdict | condition | meaning |
|---|---|---|
| `trusted` | every signature the declared `signaturePolicy` requires is present and valid, every per-seat chain reproduces, and the replay is consistent | adoptable as evidence |
| `unverifiable` | no signatures (or a format predating them) | **neither confirmed nor refuted** — absence of evidence |
| `rejected` | signatures present but invalid, a chain fails to reproduce, or the replay is inconsistent | positive evidence of a problem |

This distinction is load-bearing for the v0.19 → v0.20 transition:
**`gaos.replay` v1.1 artifacts cannot carry signatures by construction.**
They are `unverifiable`, not suspect. `trusted` is a new tier that only v1.2+
can reach; the vocabulary must make that obvious or every artifact produced
during the migration window will read as broken.

### A9b.2 The library reports facts; policy applies the rule

`recheckReplayArtifact` continues to report **facts** — the three-state
signature result (§A7), chain reproduction, and replay consistency. It must
**not** hardcode "unsigned ⇒ untrusted": a host running friendly games has no
use for signatures and its artifacts are not defective.

The rule ("scored runs must be `trusted`") belongs to the policy layer — the
verification service, a leaderboard, Arena's scoring gate. Same
mechanism/policy split the rest of the SDK observes.

### A9b.3 No official verification service — decided, with the reason

A hosted "official GAOS verification API" was proposed and **rejected**.
Recording the reasoning here so it is not re-litigated:

Portable evidence exists precisely so that verification does **not** require
trusting a particular party. An official endpoint that everyone calls
silently replaces *"anyone can verify this themselves"* with *"anyone can ask
GAOS"* — it reintroduces the trusted third party this architecture is built
to remove, and it would do so at the exact moment the ecosystem starts to
depend on it. Secondary costs point the same way: a central service would
receive `visibility: full` artifacts containing every seat's hidden hands
(uploading **is** disclosure), and signing its verdicts would make the
project a certificate authority with permanent operational and trust
obligations.

The decisive point is simpler than any of those: **a third party does not
need a service to learn that an unsigned artifact cannot be verified.** That
conclusion falls out of running the verifier — which ships in the SDK, in
both languages, and which they can run themselves. There is nothing for a
service to add except a dependency.

### A9b.4 Invest in trivial self-verification instead

The correct investment is making local verification friction-free, so that
"run it yourself" is genuinely easier than asking anyone:

- **A one-command CLI** over the shipped verifier
  (`gaos verify <artifact.jsonl>`), exiting non-zero on `rejected`, printing
  the verdict plus its evidence: which seats signed, which chains reproduced,
  what the replay found, the recorded `dmath` algorithm, and the format
  version. CI-usable as-is.
- **Both languages**, so a Python-based benchmark harness is a first-class
  verifier and not a second-class consumer.
- **Documented offline**: verification requires the artifact and the game
  adapter — no network, no account, no service.
- Seat-scoped artifacts verify normally, with redacted regions reporting
  "not independently recheckable" through the mechanism RFC-008 already
  defines. A publisher can therefore release evidence without releasing
  secrets, and the recipient verifies it locally.

### A9b.5 Scope note

What must be frozen with the format is the **verdict vocabulary**
(§A9b.1) and the **facts-versus-policy split** (§A9b.2): a policy layer built
on an ambiguous verdict cannot be corrected once consumers adopt it. The CLI
is ordinary tooling and can follow at any time.

## A10. Explicitly deferred

- **Root anchoring** (publishing the chain head where the host cannot
  retroactively change it) — closes truncation and post-hoc rewrite. Needs an
  external dependency; revisit if a shared cross-host leaderboard becomes
  real.
- **Consensus / distributed ledger** — not applicable. Consensus solves
  Byzantine agreement on ordering among mutually distrusting validators; a
  single-writer kernel already establishes ordering deterministically.
  Adopting it would add cost and no property this RFC needs.
- **Threshold/multi-party schemes**, hardware attestation, zk proofs of legal
  play.

---

# Part B — Generic interest management

## B1. The conflation to undo

RFC-006 and RFC-009 describe "interest-managed per-seat view streams", and
earlier prose tied interest to spatial visibility. That is wrong on both
counts: **visibility and interest are orthogonal**, and **neither is
spatial-specific**.

| | Visibility | Interest |
|---|---|---|
| Question | what a seat is **allowed** to see | what a seat **needs to receive now** |
| Nature | correctness, fairness, secrecy | performance, bandwidth, relevance |
| Violation | information leak (fatal) | waste or latency (tolerable) |
| Decided by | rules — RFC-003 partition policies | client subscription + host policy |
| Status | **exists and is already generic** | **does not exist** |

RFC-003's information partitions are already generic — zone policies, board
policies, and product-defined policies; the geometry-based one (LOS/fog) is
merely one injected implementation. Nothing needs fixing on that side.

What is missing is interest. Today the delta stream is a
**visibility-filtered full snapshot, per seat, per tick**. It performs no
relevance filtering at all, which is precisely why the v0.19 measurement
found **99–100 % of per-tick kernel cost is serialisation** (reducer +
`viewFor` = 0.04–0.08 ms of a 12–16 ms tick): every tick re-serialises
everything a seat *may* see, regardless of whether the seat cares.

## B2. Dimensions (interest is not spatial)

A generic interest declaration must be able to express at least:

- **spatial** — visible cells, distance, which board;
- **container** — my hand, the deck I currently have open;
- **ownership** — my units' internals, my resources;
- **relevance** — settlement waves and trigger chains that actually touch me;
- **subscription / UI** — what the client is currently rendering (a player
  looking at board 2 can receive board 1 at reduced fidelity);
- **role** — player / spectator / admin.

Like every other mechanism in the suite, the SDK owns the *machinery*
(declaration, diffing, delta scoping, ordering) and the product injects the
*policy* (what is interesting to whom).

## B3. Invariants (non-negotiable)

1. **Interest may only narrow visibility, never widen it.** The filter
   composes *inside* the partition result. A violation is a leak, not a
   performance bug.
2. **Interest must not affect determinism.** It changes what a seat
   *receives*, never what the reducer computes, and **a transcript's gameplay
   projection is identical under any interest policy.** *(Corrected in
   §B7.1 — the original wording, "two hosts with different interest policies
   must produce identical transcripts", contradicted recording scope changes
   at all. Client-declared scope is a recorded submission; host-side
   narrowing is pure delivery and never enters the durable log.)*
3. **Omission must be knowable.** A client must be able to distinguish "this
   did not change" from "this was outside my interest", or reconciliation
   will treat absence as no-change and silently diverge. Therefore the
   **interest scope is part of the delta metadata**, not an invisible host
   optimisation.
4. **Scope changes are ordered events.** Widening interest requires a
   snapshot of the newly-included region at a defined revision; narrowing
   must be recorded so a later verifier knows why data stopped.

## B4. Where Part A and Part B meet

Invariant 4 makes an interest scope change a **client-declared, ordered
submission** — which makes it signable, and worth signing (tier 2, §A6).
The property gained: a host cannot retroactively claim a client never asked
to see something. If instead interest were derived host-side, signing it
would be worthless (a host signing its own claim proves nothing against that
host) — so **client-declared interest is the design that makes tier 2
meaningful**, and that is the reason the two parts share an RFC.

## B5. Relationship to the v2 patch codec — and priority

They attack different waste:

- **Patch codec**: stop re-sending *the same content*. Measured ~14×
  byte reduction available.
- **Interest**: stop sending *content nobody asked for*. Reduces both bytes
  and the serialisation CPU that is the actual measured bottleneck.

The v0.19 measurement is unambiguous: at 60 entities / 4 seats, bandwidth is
74 MB/seat/10 min (survivable) while CPU is 36 % of a 30 Hz budget on a fast
desktop — and a Cloudflare DO isolate is materially slower. **Interest
therefore outranks the patch codec in v0.20**, with the cheap
serialisation-deduplication work (3 `canonicalJson` + 2 `structuredClone` per
seat per tick, plus two `structuredClone(deltas)` in `makePrepared`) landing
first as a 0.19.x patch since it needs no contract change at all.

## B6. Test plan

- Leak check: for every interest policy, assert no delta ever carries a field
  outside the seat's *partition* result (interest narrowing must never
  accidentally widen).
- Determinism: identical transcripts from two hosts running different
  interest policies over the same input log.
- Omission-knowability: a client with narrowed interest reconstructs its
  in-scope view exactly, and can detect out-of-scope regions as unknown
  rather than unchanged.
- Scope change: widening delivers a correctly-scoped snapshot at the declared
  revision; narrowing is recorded; both survive `finalizeReplay` and recheck.
- Cost: per-tick serialisation and bytes at several interest breadths, versus
  the v0.19 baseline table.

## B7. Resolved design questions (2026-07-26)

### B7.1 The scope-change lane — the apparent contradiction, dissolved

The question as originally posed ("the extension lane deliberately lacks the
ordering guarantees invariant 4 needs") **rests on a false premise, and it is
the same conflation §B1 exists to undo, reappearing one level down.** Two
different orderings were being treated as one:

| | gameplay ordering | durable log ordering |
|---|---|---|
| means | position relative to reducer inputs | position in the committed event log |
| extension lane | **absent, by construction** | **fully present** |
| evidence | never reaches the reducer, carries no `SubmittedAction`, observation derivation cannot read it, advances neither `cursor` nor `viewRevision` (RFC-006 §D answer 2) | `prepareExtension` → `makePrepared` assigns `transitionRevision`; `commit()` throws `PreparedTransitionError('stale')` unless `baseTransitionRevision === live.transitionRevision` (`session.ts:1429`); rehydration enforces monotonicity (`:1554`) |

Invariant 4 asks for a snapshot **"at a defined revision"** — that is *log*
ordering, which the lane has. Invariant 2 forbids affecting the reducer —
that is *gameplay* ordering, which the lane lacks. **The lane already
provides exactly what invariant 4 needs and lacks exactly what invariant 2
forbids.** The property that made this look dangerous is the property that
makes it correct.

**But neither option in the original question is the answer.** A third
consideration decides it, and the question did not raise it: invariant 4 also
requires that narrowing be *recorded so a later verifier knows why data
stopped*. A generic `{ kind: 'extension', lane: string, record }` entry is
opaque — a verifier would have to know a product's lane-naming conventions to
locate scope changes at all. **Verifier legibility, not ordering, is what
rules out the generic extension lane.**

**Resolution — a third non-gameplay transition kind, `prepareInterest`**, with
its own record kind in the transcript. It borrows from both existing
non-gameplay lanes:

- **from the extension lane** — structural reducer isolation: an interest
  record is never a reducer input and cannot affect state, legality, or
  observation *derivation*. Invariant 2 then holds **by construction rather
  than by discipline**.
- **from the rejection lane** — delta emission with split revisions:
  `transitionRevision` advances to the scope-change transition while
  `viewRevision` stays equal to the unchanged gameplay cursor, exactly as
  RFC-006 already specifies for the rejection-only `ObservationDelta`.
  Invariants 3 and 4 follow.

This is **not new machinery.** The rejection-only delta already proves that a
non-gameplay transition can emit a delta and carry its own revision without
touching the cursor. Interest is the second instance of a pattern the kernel
ships today — which is the strongest evidence available that the shape is
right.

**Consequent correction to invariant 2 (§B3).** As written — *"two hosts with
different interest policies must produce identical transcripts"* — the
invariant contradicts recording scope changes at all: if policies differ, the
records differ. The fix is to separate the two things "interest policy"
conflates:

- **client-declared scope** is a *submission*: signed, recorded, ordered. Two
  hosts fed identical client submissions produce identical interest records.
- **host-side narrowing** on top of that declaration is *pure delivery*: it is
  re-derivable, it is **not** a transition, and it **must not enter the
  durable log**. A host may deliver less than a client asked for; it may never
  record that it did so as session history.

Invariant 2 therefore reads: **interest never affects reducer computation, and
a transcript's gameplay projection is identical under any interest policy.**

### B7.2 Interest is declared per `(seat, scopeId)` — not per client

"Client" and "connection" are **host** concepts; the kernel's vocabulary is
seats. Putting connections in the kernel would drag in connect/disconnect
lifecycle, and those events are not deterministic.

A seat may hold N named scopes; the kernel derives one delta stream per scope;
the **host** binds connections to `scopeId`s. Default is one scope per seat,
named by the seat id — so the single-device case costs nothing and the API has
no second shape.

This answers the two-device case properly. Per-seat-only would force the two
devices to share the *union* of their interest, meaning the phone pays for the
desktop's fidelity — precisely the waste Part B exists to remove.

Signing (tier 2): a scope declaration is signed by the **seat** key — one key
per seat, unchanged from §A3 — and carries its `scopeId`. Two devices on one
seat share a key, which is correct: the property proven is *"this seat asked
to see X"*, not *"this device asked"*. Invariant 1 holds trivially, since all
scopes of a seat compose inside the same partition result and none can widen
past it.

### B7.3 Tier-3 `N` is per-seat, recorded in the roster

`N` is a property of a **chain**, and chains are per-seat (§A5.1); a per-chain
parameter stored in a global field is a type error waiting to happen. §A3
already names the case that needs it — an evaluation driver under scrutiny
warrants dense signing where a human on a phone does not — and client-side
signing cost differs by an order of magnitude between those two. Uniform `N`
remains expressible as "every seat has the same `N`", so nothing is lost.

Recorded in the roster entry alongside the key: `{ id, publicKey, alg,
signingTier }`. Everything a verifier needs about a seat then lives in one
place.

**`N` must be recorded, never inferred.** A verifier that derives `N` from
observed signature spacing cannot distinguish `N = 100` from `N = 10` with 90 %
of the signatures suppressed by the host. Recording it converts signature
suppression from **invisible** into a **detectable violation** — this is a
security property, not bookkeeping.

### B7.4 The roster is not signed by the SDK — it is bound into chain genesis

The §A3 line holds: binding a key to a person is product policy and stays out
of the SDK. But roster *integrity* is load-bearing for every claim in Part A —
a host that can rewrite `seatKeys` post-hoc can substitute a key it controls
and forge that seat's entire chain. "Product PKI" alone leaves that open for
every host that does not deploy PKI.

The SDK closes it without any PKI, by making the roster **tamper-evident from
inside the artifact**: the chain genesis stops being 32 zero bytes and becomes

```
prevChainHash[first submission] = H(domainTag ‖ sessionId ‖ seat ‖ rosterHash)
```

`rosterHash` must be **order-independent**, or two honest hosts that list the
same seats in a different order produce incompatible chains. `canonicalJson`
sorts object keys but preserves **array** order, so it is not sufficient
alone:

```
rosterHash = SHA-256( canonicalJson( seatKeys sorted ascending by `id`
                                     using the RFC-008 code-point collation ) )
```

Reusing the code-point collation already frozen in the baseline (not
`Array.prototype.sort`'s UTF-16 order) keeps this consistent with the rest of
the canonical form and with Python.

Substituting any seat's key changes `rosterHash`, which invalidates **every
seat's chain from its first submission onward** — including the chains of
seats whose keys the host does not control, and which it therefore cannot
re-forge. Roster substitution lands in `rejected`, not `unverifiable`. Cost:
one hash per session, computed client-side, once.

Residual, and unchanged: proving the roster names the *intended people* is
still product PKI. The SDK proves the artifact was played under **the roster
it carries** — not who those seats really were. That is the §A2/§A3 line
restated, now with the substitution attack moved to the correct side of it.

### B7.5 Consequence for sequencing — Part A does not wait for Part B

§B4 establishes that client-declared interest is what makes tier-2 signing
meaningful. With B7.1 and B7.2 resolved, that dependency is now **one-way and
non-blocking**: tier 2 is fully specified, and simply has nothing to sign
until Part B ships. **Part A is buildable today, in parallel with the
migrations** (RFC-009 §5); tier 2 activates when interest lands.

---

# Part C — Documentation and positioning

Signatures change what the project can honestly claim, so the documentation
work is part of the feature, not an afterthought. It is also the part most
easily got wrong: a project whose value proposition is trustworthiness
destroys that proposition fastest by overclaiming a security feature.

## C1. What the claim becomes

| | before v0.20 | after v0.20 |
|---|---|---|
| what a verifier establishes | the recorded **computation** is self-consistent | the computation is self-consistent **and these actions came from these seats** |
| who must be trusted | the host that produced the artifact | **nobody** |
| one-line claim | "deterministic replay you can re-check" | "evidence anyone can verify" |

The mission consequence is specific and worth stating plainly: every AI
benchmark leaderboard today is *"trust the submitter"*. With an agent driver
being an ordinary seat that holds a key, **an evaluation run becomes
independently verifiable** — the artifact carries proof of which agent
produced which actions. That is the differentiator, and it is a direct
expression of the "humans and AI evaluated by the same standards" mission
rather than an unrelated security bullet.

## C2. Doc set to update or create (ship with the feature)

1. **A new concept page — "Trust and verification".** The layered story in
   one place: determinism → replay re-checking → signatures → per-seat chain,
   with the threat-model table from §A6b (who verifies, when, against whom).
   This is the page that makes the claim comprehensible instead of a bullet.
2. **The verdict vocabulary** (§A9b.1) as public reference:
   `trusted` / `unverifiable` / `rejected`, including the explicit statement
   that `unverifiable` is *absence of evidence, not evidence of a problem*,
   and that v1.1 artifacts are `unverifiable` by construction.
3. **An honest-limits section** (§A2 and §A6b's "what a faithless host can
   and cannot do"), including the one-sided guarantee in its exact wording:
   *if an artifact claims to be signed, its signed portions are authentic;
   nothing guarantees signed evidence is produced at all.* Publishing the
   limits is itself a credibility signal, and it is the same discipline that
   renamed `commit_violation` to `commit_mismatch`.
4. **An adoption guide** for each role: a **host** (record signatures, do not
   verify — §A6b, with the CPU table), a **client** (key generation and
   storage, what to sign at which tier, chain-head retention as dispute
   evidence), and a **scoring authority** (require `trusted`, and why
   requiring it is what converts withheld evidence into a forfeited score).
5. **Agent-evaluation framing** in `docs/agentic-play.md`: an evaluation
   driver is a seat with a key; batch evaluation produces signed artifacts;
   what a benchmark operator should publish alongside a score.
6. **Positioning surfaces** — `README.md`, `docs/index.md`, `docs/mission.md`,
   `docs/roadmap.md` — updated to the §C1 claim, with the bound stated inline
   rather than in a footnote.
7. **Format and release docs**: `gaos.replay` v1.2 fields, the
   `signaturePolicy` header, migration from v1.1, `docs/releases.md`,
   `docs/version-history.md`.
8. **The self-verification CLI** (§A9b.4) documented as the primary path:
   one command, offline, both languages, evidence printed. "Run it yourself"
   must read as easier than asking anyone.

## C3. Claims that must NOT be made

- ~~"tamper-proof"~~ — deletion of an entire artifact, truncation, and
  refusal to publish all remain possible (§A2).
- ~~"proves player X did Y"~~ — signatures prove *the holder of key K*;
  binding K to a person is product PKI, explicitly outside the SDK (§A3).
- ~~"prevents cheating"~~ — a colluding player signs whatever the host asks.
  The property is that a host **acting alone** cannot forge or reattribute.
- ~~"blockchain-based"~~ — the useful primitives are signatures and hash
  chains; consensus and distributed ledgers are deliberately not used
  (§A10), and the phrase would misdescribe the design.
- Any claim in the present tense before the feature ships.

## C4. Adoption is the prerequisite for the claim

A signature feature nobody enables is marketing, not evidence. To make the
claim true in practice rather than in principle:

- the reference host adapter signs by default;
- every example and template that submits also signs;
- the two consumer migrations adopt client-side signing as part of their
  v0.20 work, so the first published artifacts are already `trusted`;
- `docs/quickstart.md` reaches a signed, locally-verified artifact.

## C5. Timing

Documentation lands **with** v0.20, never ahead of it. Until the feature
ships, the honest description of the audit lane is the v0.19 wording:
advisory, pending RFC-010. The credibility this feature buys is spent the
first time a claim outruns the implementation.

---

## A9c. The timeout lane: what can and cannot be closed

Amendment (2026-07-25). The v0.19 docs state that RFC-010 closes both the
`commit-mismatch` and the `timeout` audit lanes. That is imprecise, and the
imprecision matters at the freeze because the two lanes are structurally
different: a `commit-mismatch` concerns a **client** submission, while a
timeout is a **host-originated** event. A host signing its own claim proves
nothing against that host, and the seat the timeout names is by definition
the one that did not respond — possibly disconnected — so it cannot
countersign either.

Decomposing what a timeout record actually asserts shows four of five
assertions are closable, most of them by machinery already in flight.

| # | assertion a faithless host could falsify | closed by |
|---|---|---|
| 1 | the canonical action the timeout produced | **pure recomputation** (§A9c.1) |
| 2 | "seat P did not submit" — when P did | **signatures + per-seat chain** (§A9c.2) |
| 3 | a timeout fabricated where policy forbids one | **declared tick-bounded timeout policy** (§A9c.3) |
| 4 | a timeout suppressed so a window stays open | **same policy** (§A9c.3) |
| 5 | fired early in **wall-clock** terms | **not closable without external time** (§A9c.4) |

### A9c.1 The forced action — deterministic, no cryptography

RFC-006 §F-E3 offered two options and adopted the first: the `resolution`
event records the fully derived canonical system input. Adopting the second
as well — a **versioned, pure `timeoutToAction(context, timeout)`** — lets
a verifier *recompute* that input from recorded context and compare. The host
may still claim a timeout fired; it cannot misreport what the timeout
produced. Requires no keys and no new records.

### A9c.2 Misattribution — a free by-product of Part A

A timeout asserts a **negative**: "P did not submit in this window."
Negatives are unprovable in general, but this one has a provable complement:
**accepted submissions are recorded, and under Part A they are signed.**

- If P's signed submission is present in that window, the timeout is
  refuted directly.
- For the host to avoid that, it must **delete** P's submission — which
  breaks P's per-seat chain (§A5.1) and is detected.

So Part A closes the timeout lane's authorship problem **without any
timeout-specific mechanism**. The asymmetry that makes it work: you cannot
prove someone did *not* submit, but you can prove they *did* — and forging a
timeout requires denying exactly that.

### A9c.3 Fabrication and suppression — a declared timeout policy

If the session header declares its timeout in **ticks** (never wall-clock),
the verifier can recompute the legal position of every timeout:

```
timeoutPolicy: { mode: 'ticks', windowTicks: N }
```

- a window opened at tick `T` must either resolve before `T+N`, or carry a
  timeout at **exactly** `T+N`;
- a timeout at any earlier tick is **fabricated** → reject;
- a window still open past `T+N` with no timeout is **suppressed** → reject.

**Cadence caveat, must be documented:** this holds in **ticks mode**, where
ticks are the clock. In **turns mode** the host decides when to close a
window, so assertions 3 and 4 degrade to what §A9c.2 provides. State the
distinction rather than implying uniform coverage.

**Freeze requirement:** this needs a reserved `timeoutPolicy` slot on the
header and a reference to it on the `timeout` record. The header rejects
unknown properties today, so **reserving is a v0.19 tag decision** — see
§A9c.5.

### A9c.4 Wall-clock earliness — bounded weak evidence, not fully closable

Firing a legitimate timeout *too soon in real time* (giving a player less
than the promised seconds) cannot be proven from the reducer-visible record:
the SDK is deliberately wall-clock-free.

The mandatory `clientTime` in the signing envelope (§A5.2) does, however,
give it **bounded** evidence. Client timestamps are signed, so a host cannot
alter them; to remove them it must delete the submission, which breaks that
seat's chain (§A5.1) and is detected. A host claiming a 60-second window
while the surrounding seats' signed timestamps span three seconds is
therefore contradicted by evidence it cannot forge. The reconstruction is an
interval bound between *other* seats' submissions — the timed-out seat
supplies nothing, by definition.

It stays **weak** and must be labelled so: clients can misreport their own
clocks, and a client colluding with the host removes the constraint
entirely. Only external time anchoring (§A10) makes it strong.

Note also that it is a different *class* of problem from 1–3: a **fairness**
issue rather than an **integrity** one, observed live by the victim (a
visibly short timer) even when it cannot be proven afterwards. It belongs to
dispute handling, alongside truncation — with `clientTime` now supplying the
dispute something to stand on.

### A9c.5 Consequences for the v0.19 freeze and for the docs

1. **Reserve `timeoutPolicy` on the header** and a policy reference on the
   `timeout` record. Without them §A9c.3 cannot be added additively.
2. **Reserve the `seat-signature` record carrier for tier-3 periodic
   signatures** (§A6). They attach to no submission; v1.1 preserves this
   carrier without assigning cryptographic semantics.
3. **Correct the documentation claim.** Replace "RFC-010 closes the
   `timeout` and `commit-mismatch` lanes" with the precise version: RFC-010
   authenticates authorship in both lanes and, in ticks mode, additionally
   constrains timeout position; **wall-clock earliness remains outside
   artifact verification.** Two consumer teams will read the v0.19 wording
   before v0.20 ships, so the correction belongs in this freeze, not the next.

---

## A9d. Naming: `deadline` → `timeout` (a v0.19 freeze decision)

Decided 2026-07-25. `deadline` reads like a **game concept** — "the deadline
for playing this card" — and two consumer teams are about to build against
it. What the mechanism actually does is narrower: **the host substitutes an
input for a seat that did not respond.** RFC-006's `durations` (turn- and
round-counted expiry tied to phase boundaries) is the game-rule mechanism,
and conflating the two would implement a rule as infrastructure while
inheriting infrastructure's unverifiable wall-clock weakness.

`timeout` is the right width. A broader name such as `forcedInput` invites
misuse the other way — scripted NPC moves, admin actions — none of which
belong here. Filtering the candidate cases leaves only non-response:

- **disconnect** — concluding early that a seat will not respond; identical
  kernel behaviour, so a `reason`, not a separate mechanism;
- **kick / admin removal** — seat elimination (`eliminateSeat`) or a
  lifecycle event, **not** this mechanism;
- **human → bot takeover** — the bot then submits normally, **not** this;
- **"no action for 3 turns ⇒ auto-pass"** — a game rule: `durations` plus a
  legality rule, producing an ordinary action, **not** this.

| current | renamed |
|---|---|
| `prepareDeadline(deadline, systemInput)` | `prepareTimeout(timeout, forcedInput)` |
| `DeadlineInput` / `deadlineId` | `TimeoutInput` / `timeoutId` |
| `SessionEvent` kind `deadline` | `timeout` |
| replay record kind `deadline` | `timeout` |
| `cause: 'deadline'` | `cause: 'timeout'` |
| `validateDeadlineAudit` | `validateTimeoutAudit` |
| — | new `reason: 'elapsed' \| 'disconnect' \| <product>` |

The type names the **event** (`Timeout`); the parameter names the **payload**
(`forcedInput`, the action actually executed).

**This must happen in the v0.19 freeze.** The record kind and the `cause`
value are wire format: renaming after the tag is a `gaos.replay` v2 break.
It is the largest of the pre-tag changes (TypeScript, Python, JSON Schema,
docs, tests) and warrants a full regression run, but the alternative is
freezing a name that will mislead every reader for the life of v1.

## A9e. Host timestamps (`hostTime`) — ops, explicitly advisory

Adopted alongside `clientTime`, with a sharp distinction:

| | `SessionEvent.hostTime` (live transcript) | projection into the artifact |
|---|---|---|
| cost | near zero — host-side, not wire format | wire format, needs a reservation **now** |
| purpose | correlate the transcript with the host's own logs by `eventId` | replay-UI pacing, third-party analytics |
| v0.19 | **add it** | **reserve an advisory slot; do not emit** |

Four hard constraints:

1. **Never a reducer input** — structurally, not by discipline.
2. **Never inside a signature preimage, and never inside any canonical byte
   comparison used for equivalence** — otherwise two hosts replaying the same
   input log produce different bytes.
3. **Replay verification ignores it entirely** — never compared.
4. **Documented advisory**, in the same terms as `checkpoint.digest`: host
   attestation, not evidence. A malicious host writes whatever it likes; the
   value is bug detection and operations.

Knock-on effect that must be written into the contract: `live === rehydrated`
equivalence today compares canonical transcript bytes. Rehydration reproduces
`hostTime` because it is recorded, but **any test or host check asserting
"replaying these inputs yields this transcript" must exclude it**. Consumers
will otherwise trip over it during migration.

Projection is opt-in through `FinalizeOptions` and off by default: the host
already owns its clock and can sidecar timestamps in its own storage, so the
artifact should carry them only when a consumer explicitly wants pacing data.

The kernel itself never reads a clock. `SessionKernelOptions.hostTime` is a
required explicit choice: `() => Date.now()` supplies UTC epoch milliseconds,
while `'none'` omits the field. `performance.now()` is not an epoch clock.
Ordering remains `tick`/`cursor`/`transitionRevision`; `hostTime` may move
backwards after clock correction and MUST NOT be used for sorting.

---

# Part D — Baseline corrections returned by the migrations (v0.19.x)

RFC-009 §4.3 asks each migrating consumer to classify what it finds as an
additive v0.19.x fix, a v0.20 reshape, or product-side only. Part D is the
first class; Part E is the second. Consolidated here from the consumers' own
write-ups so v0.20 has one document.

**Every claim below was re-verified against `v0.19.0` (`5ddd404`) before being
accepted.** Where a consumer's reasoning and the code disagreed, the code
won; where I could not reproduce a claim, it is marked as reported rather than
confirmed.

## D1 — `ObservationDelta` cannot be told apart from a repair envelope

*Source: TabletopLabs. Class: additive, **migration-blocking**. Failure mode:
silent state divergence.*

`docs/session-and-integrity.md` requires a prediction client to treat a
`viewRevision` gap as needing resync and forbids filling it by guessing. That
demands the client answer "is this a resolution or a host-pushed repair?" — a
repair legitimately jumps `viewRevision`, a resolution must not. **Nothing on
the envelope answers it.**

Verified: `ObservationDelta` carries `seat`, `transitionRevision`,
`viewRevision`, `tick`, `codec`, `acknowledgements`, `rejections`, `body`,
`viewDigest` — no discriminator. Rejection-only envelopes are identifiable
(non-empty `rejections` + `unchanged` body), but **resolution and reconnect
snapshot are not**, because a resolution can also carry zero acknowledgements.
Confirmed at `src/session.ts:1196–1201`, where inputs with
`participantId === null` are filtered out, so a timeout-only resolution
acknowledges nothing; and `TickReducer.advance` accepts an empty input batch by
design (RFC-006 §2).

The field's own doc comment is where the ambiguity becomes visible: *"A
reconnect snapshot applies no new input and therefore carries `[]`."* True —
and insufficient, because it does not say that a resolution never does. At tick
cadence the empty-acknowledgement resolution is the **common** case: a 20 Hz
session with physics and timers changes its view most ticks while most ticks
carry no player input.

Neither inference is safe. "Empty ⇒ repair" accepts a post-gap resolution as a
repair and skips gap detection — exactly the guessing the spec forbids.
"Empty ⇒ resolution" resync-loops on every legitimate repair. Context does not
rescue it either: `tick` is current in both, `viewRevision` is the question
itself, and tracking "did I request a snapshot" fails because repair is
**host**-initiated.

**Fix — one additive optional field:**

```ts
export interface ObservationDelta<TView = TickView<unknown, unknown>> {
  // …
  /** How this envelope was produced. Absent is read as 'resolution'. */
  origin?: 'resolution' | 'snapshot';
}
```

Existing readers are unaffected. `snapshot()` sets `'snapshot'`; both
resolution paths set `'resolution'` or omit it.

**Assessed alternative — document a derivation instead of adding a field.**
Rejected: there is no sound derivation. That absence *is* the finding, not a
gap in the consumer's effort.

## D2 — `SubmittedAction` has no product payload slot, and replay drops the workaround

*Source: TabletopLabs. Class: additive, **migration-blocking for replay**.*

`SubmittedAction` is typed for grid/zone games (`x`, `y`, `index`, `boardId`,
`zoneId`, `seat`, `targets`, plus the commitment slots). A TabletopLabs input is
an ECS entity id plus an arbitrary product payload. Nothing holds it, and
`verifiedPayload` is the reveal path's output — borrowing it would collide with
commit–reveal.

A product-namespaced field on the action survives `structuredClone` and
canonical JSON, so the live kernel, its digests, and its transcript are all
correct. **It does not survive replay projection.** Verified: `replayInput`
rebuilds each action field by field — `x`, `y`, `index`, `boardId`, `zoneId`,
`seat`, `targets`, `commit`, `reveal`, `verifiedPayload` — and drops anything
not enumerated.

Consequence: a TabletopLabs artifact cannot be rechecked, because the recorded
actions no longer determine the simulation. Since cross-product `gaos.replay`
verification is the stated reason the kernel was extracted at all (RFC-006 §1),
**a consumer that cannot produce a recheckable artifact has not integrated.**

**Fix — one additive optional member, projected through `replayInput`:**

```ts
export interface SubmittedAction {
  // …
  /** Opaque product payload. The SDK never interprets it; it round-trips. */
  payload?: JsonValue;
}
```

Worth noting while this file is open: `replayInput` **already** projects
`clientTime`, `prevChainHash`, and `sig`, so the Part A reservations are wired
through the replay path and Part A needs no change here.

## D3 — `./session` does not export the types its own API is written in

*Source: TabletopLabs. Class: packaging, non-blocking.*

Verified: `src/session.ts` re-exports exactly two things —
`IntentCollectionError` and the `IntentErrorCode` type. It *imports*
`TickReducer`, `SubmittedAction`, `ReplayGameRef`, `TickRate`, `TickView`,
`JsonValue`, and `CommandSubmission` from `./engine` and `./protocol` and
re-exports none of them, while `SessionKernelOptions` is declared in terms of
all of them. Building one kernel means importing from three subpaths.

The sharp edge is `createTickRate`, required to construct
`cadence: { mode: 'ticks', rate }` and exported only from `./engine`.

> **Reported, not reproduced:** TabletopLabs reports that importing it from
> `./session` *typechecks* under `moduleResolution: bundler` and then throws
> `createTickRate is not a function` at runtime. I confirmed the missing
> re-export — the actionable defect, and the one that fixes the symptom either
> way — but did not reproduce the typecheck-passes behaviour. Whoever
> implements this should reproduce it before concluding the type layer is also
> at fault.

**Fix:** a re-export block on `./session` covering the types and values its
public API references. Pure packaging, no semantics.

## D4 — RFC-009 §4's claims about the baseline were wrong *(already corrected)*

*Source: TabletopLabs. Class: documentation. No code impact.*

Two factual errors in RFC-009 §4, both **verified as reported and already
fixed** in that document:

1. **The `v0.19.0` tag exists.** It is annotated, on `origin`, and points at
   `5ddd404`. RFC-009 had claimed no tag existed and instructed consumers to
   pin a commit instead; the reasoning offered for that advice — that pinning
   `5ddd404` yields a `package.json` claiming a version which will never
   publish — was false. The outcome was harmless, since head and tag are the
   same code, but the reasoning would have sent the next migrating agent to the
   wrong ref for a wrong reason.
2. **TabletopLabs consumes the SDK as an npm `github:` dependency, not a git
   submodule** — `github:yugao-gaos/GAOS-TurnBasedGrid-SDK#v0.19.0`. RFC-009
   asserted a submodule.

The consumer's operational note is worth keeping: editing the version in
`package.json` does **not** move an npm `github:` pin — `npm install` reports
"up to date" and keeps the lockfile's already-resolved SHA. Re-resolution must
be forced with an explicit spec. This is now recorded in RFC-009 §4.

*Method note: this finding came from verifying the pin rather than trusting the
prose. That is the behaviour to keep.*

## D5 — `finalizeRunReplay` rejects runs whose non-final levels were lost

*Source: Arena. Class: additive, **migration-blocking**.*

Verified at `v0.19.0`:

```ts
// src/session.ts:2022
if (levelIndex < transcripts.length - 1 && level.result.status !== 'won') {
  throw new TypeError(`run transcript ${levelIndex} must be won before another level`);
}
```

Arena's scored runs advance through **failed** levels — the agent plays a
pinned level set to the end and is ranked on *total stars, then total turns
across the set*. A partly-failed run is the ordinary outcome of a paid ticket,
not an edge case.

**The gate is the only part of the stack that disagrees, and I confirmed each
half of that claim separately.** The format admits failed non-final levels:
`status` is an unconstrained `won | failed` enum with no positional rule
(`src/engine/replay-format.ts:657`, `python/agilabs_arena/replay.py:513`,
`schemas/gaos.replay-v1.schema.json:103`). The verifier admits them too —
`recheckReplayArtifact` re-simulates each segment independently and aggregates
at `replay-format.ts:1717–1718`:

```ts
totalStars += result.replayed.status === 'won' ? (result.replayed.stars ?? 0) : 0;
totalActionsUsed += result.replayed.actionsUsed;
```

A failed level contributes zero stars while its `actionsUsed` still counts —
which *is* Arena's ranking, already implemented. So the artifact would
round-trip, validate, and recheck correctly today; **only the projection
refuses to build it.** The gate encodes a *product* assumption ("a run is a
survival ladder") inside a *format* projection whose own verifier does not
share it.

Consequence: Arena still writes its own transcript format at `/submit` — the
exact divergence RFC-009 §2.1 moved run composition into v0.19 to prevent, in
the consumer whose `session-do` the kernel was extracted from.

**Fix — one optional field on `FinalizeRunOptions`, default preserving today's
behaviour byte-for-byte:**

```ts
advancePolicy?: 'win-to-advance' | 'play-all-levels';
```

with the gate consulting `(options.advancePolicy ?? 'win-to-advance')`. Every
other run check is unchanged under both policies: shared
session/game/dmath/timeout headers, `seedPolicy: 'explicit'`, per-segment
`runLevelSeed(runSeed, i)`, global renumbering, terminal validity.

**Why a policy field rather than dropping the gate** — dropping it silently
accepts a genuinely malformed ladder run, a real host-bug class for products
whose runs *do* end on a loss. Both shapes are legitimate and, as Arena notes,
indistinguishable from the transcripts alone, so the host must declare which
one it composed. Inferring it is not available.

**Re-pin note.** This is the exercised case of the RFC-009 §4.4
additive-optional exception, so the freeze check will legitimately print
`src/session.ts`. The announcement must say so explicitly rather than let the
check read as a violation — which is itself the argument for preferring one
such release over a habit of them.

---

# Part E — v0.20 scope returned by the migrations

Class 2 under RFC-009 §4.3: contract-shape questions and measurements that
inform v0.20, explicitly **not** requested on the v0.19.x line.

## E1 — `TickView` is grid-shaped; tick-paced products carry observations beside it

*Source: TabletopLabs. Not requested on the baseline.*

`TickView` requires `actions`, `status`, and `hud.actionsUsed`, and its optional
richness is `grid`, `zones`, `targetChoices`. TabletopLabs' unit of observation
is a privacy-filtered ECS world snapshot, so its adapter supplies `actions: []`,
a `status` that is always `'playing'` until a product state machine says
otherwise, `hud.actionsUsed` populated with the tick index because there is no
action budget, and carries the real observation in a product extension field.
The required surface is satisfied **vacuously**.

The consumer explicitly did not ask for a baseline change here, citing RFC-009's
own reasoning that a moving contract under two in-flight migrations doubles
everyone's work. That restraint is correct and worth naming.

**Disposition (resolved 2026-07-26): split infrastructure from action
discovery without changing the compatibility default.** `SessionView` is the
minimum lifecycle/participation surface used by sessions, replay, lockstep,
interest, and observation codecs. `TickView extends SessionView` retains
`actions`, `hud`, `grid`, `zones`, and `targetChoices` for existing reducers,
agents, and solvers.

Replay exposed one deeper coupling: `actionsUsed` was read directly from
`view.hud`. Reducers whose observations do not have a HUD now provide the pure
`replayMetrics(state)` seam; existing `TickView` reducers fall back to
`view.hud.actionsUsed`. TabletopLabs can therefore expose its ECS world
directly without fake action or HUD fields, while every existing reducer
continues to typecheck unchanged.

This remains additive because reducer generics still default to `TickView`,
and action-enumerating APIs continue to require it. Only infrastructure that
does not inspect action-discovery fields accepts `SessionView`.

## E2 — Snapshot cost measured; §3.3 resolves for the patch codec

*Source: TabletopLabs. This is the measurement RFC-009 §3.3 asked for.*

Measured on TabletopLabs' actual per-seat serializer (`serializeForRecipient`,
the same path the join snapshot uses), at 20 Hz:

| Table entities | Per-seat snapshot | Per seat | 4 seats |
| --- | --- | --- | --- |
| 50 | 12.6 KiB | 0.25 MiB/s | 0.99 MiB/s |
| 200 | 49.5 KiB | 0.97 MiB/s | 3.86 MiB/s |
| 500 | 123.6 KiB | 2.41 MiB/s | 9.66 MiB/s |

200 entities is an ordinary board-game table, not a stress case, and 3.86 MiB/s
of egress per room is not viable. The consumer's own caveats are recorded here
because they are the right ones: these are uncompressed JSON figures and
transport compression will reclaim a large fraction of a repetitive payload, and
they come from a synthetic table rather than live play.

Neither caveat changes the conclusion, and the reason is structural rather than
numerical: **snapshot cost scales with table size while the real per-tick delta
scales with activity, and those two curves diverge without bound.** Compression
shrinks the constant; it does not couple the curves.

**This settles RFC-009 §3.3 in favour of building the patch codec (RFC-006 §D4)
in v0.20.**

### E2a — This revises the §B5 priority call

§B5 ranked **interest above the patch codec** for v0.20, on the v0.19
measurement that bandwidth was survivable (74 MB/seat/10 min) while
serialisation CPU was the binding constraint. E2 measures an ordinary table
roughly 8× larger than that scenario and finds bandwidth is *not* survivable
there.

Corrected position: **they are not competitors, and ranking them was the wrong
question.** They attack different halves of the same divergence —

- **interest** stops sending what nobody asked for; it does nothing for a seat
  legitimately interested in the whole table, which is the normal case for a
  board game where everyone watches the same table;
- **the patch codec** stops re-sending what did not change; it is the only one
  of the two that decouples cost from table size.

E2's structural argument bites precisely in the case interest cannot help, so
the patch codec is load-bearing for tick-paced products in a way §B5 did not
credit. Build both in v0.20; if only one, the codec.

**Final codec disposition (2026-07-26): v2 is mandatory.** Arena and
TabletopLabs are both pre-release integrations and can migrate together, so
carrying a snapshot-only v1 emission mode would freeze negotiation and testing
cost without protecting a released consumer. `ObservationDelta.codec` is
`'v2'`; bodies remain `patch | snapshot | unchanged`, with snapshot fallback
required for unsafe, over-bound, or non-beneficial patches. Patch computation
is not mandatory: `patchStrategy: 'never'` emits v2 snapshots, while the
default `adaptive` strategy uses an exponential per-scope circuit breaker after
losing probes. Its initial and maximum windows are configurable. The optional
`observationCodec` setting configures that v2 delivery policy and its bounds.
This intentionally reopens the observation-delivery freeze; both product
repins are the tag gate.

*Follow-up available: the consumer offers live traces once its authoritative
host is deployed. Take them — the synthetic table is the caveat both sides
flagged.*

## E3 — The post-commit wedge class: no legality seam, and an unclassified view failure

*Source: Arena (F5 + F2, merged here because they are one defect class).*
**Highest-value item returned by either migration.**

Arena reported these as two findings and then observed they share a shape.
That observation is the important part, so they are consolidated: **a failure
discovered *after* the intent is durably committed does not reject the
request, it wedges the session.** The intent is recorded, the participation
window slot is taken, and every retry re-enters the same failing resolution.
No input can resolve it.

### E3a — There is no legality surface on the reducer contract

Verified at `v0.19.0`: `ReducerBase` is exactly `init` / `view` / `viewFor?`
(`src/engine/contracts.ts:122–131`). `TickReducer` adds `advance`;
`ActionReducer` adds `apply` / `applyIntents?`. There is no `legalActions`, no
`isCommandLegal`, no `validateCommand`.

So `prepareIngest` never asks whether a command is legal. It validates
*structure* thoroughly — impersonation, reserved `verifiedPayload`,
commit/reveal exclusivity, commitment envelope — and probes only
`reducer.view(state).status !== 'playing'` for terminality. An illegal command
is first discovered when `apply` throws inside `prepareAdvance`, which runs
only after the ingest transition is committed and the window is full.

The sharpest evidence is an inconsistency inside the SDK itself: the protocol
module **does** model this. `GameDefinition.isCommandLegal(state,
participantId, command)` exists at `src/protocol.ts:119` — and I confirmed the
kernel never calls it. The concept is present in the codebase and absent from
the layer that needs it.

**What the workaround costs.** Arena reproduces legality host-side, then uses
`prepareIngest` → validate against `kernel.observe(seat).actions` →
`kernel.abort(prepared)` → 4xx. That works, and it is worth being precise about
why it is not good enough: it duplicates the reducer's rule set *outside* the
reducer, which is the drift RFC-006 exists to prevent; and the residual risk of
that drift is **unrecoverable, not merely wrong** — a disagreement between the
host's notion of legal and the reducer's `apply` produces a wedged paid
session, not a rejected request. Prepare-then-abort is also a lifecycle
designed for persistence failure being used as a validator.

**Fix — an optional hook, called during `prepareIngest` before the intent is
recorded:**

```ts
interface ReducerBase<TLevel, TState, TView> {
  /** Reject a command before it is admitted to the participation window. */
  validateCommand?(state: TState, seat: string, action: SubmittedAction): void;
}
```

A throw becomes a typed ingest rejection with nothing committed. Reducers that
omit it keep today's behaviour exactly.

This is the piece that makes *"any game can be an arena"* batteries-included.
Without it every host must re-implement legality, and every host that gets it
subtly wrong bricks sessions rather than rejecting requests.

### E3b — A non-canonicalisable view wedges a committed transition, untyped

Same shape, reached from malformed data rather than ordinary input. Verified:
the **command** path classifies canonicalisation failure —
`canonicalJson(submission.command)` is wrapped and rethrown as
`IntentCollectionError('invalid_submission', …)` at `src/session.ts:759–765`.
The **view** path does not: `viewDigest(view)` is `fnv1a(canonicalJson(view))`
(`:492–493`), called bare at `:1080`, `:1175`, and `:1508`. A reducer view
carrying authored text with an unpaired surrogate throws a raw `TypeError` out
of `prepareAdvance`.

Two things compound it. It is **unclassified**, so hosts that map
`IntentCollectionError` / `SessionConflictError` / `SessionAdvanceError` to
status codes see something indistinguishable from a host bug and return 500.
And it fires **after** the ingest commit, so the session is wedged. Arena
reproduced this end-to-end: `/init` returns 201 because construction never
canonicalises the initial view, and the *first* `/actions` throws — the failure
is invisible where the level enters the system and appears only once someone
plays it.

**Fix, in the order worth doing them:**

1. **Fail fast at construction** — canonicalise the initial view once in
   `createSessionKernel` / `rehydrateKernel` and reject a non-encodable one,
   the same way the constructor already probes `stateIsolation.fork`
   cloneability. This alone converts an unrecoverable mid-session wedge into a
   clean startup rejection, and is worth doing even if 2 and 3 slip.
2. **Classify the resolution-path failure** — `SessionAdvanceError` with an
   `invalid_view` code, or a peer class.
3. **Document the obligation** — reducer views must be canonically encodable.
   This is currently implicit and is *new* relative to v0.16/v0.17 consumers,
   whose views were never canonicalised.

## E4 — Seat-local state transitions, and what they do to the §B7.1 taxonomy

*Source: Arena (F4), recorded as "not a defect". It is the most consequential
design input either migration returned, because it collides with a stated
invariant.*

Arena's free `controlRevision` substep calls `reducer.prepareIntent`, mutating
state **outside any resolution** — opening a talk-target chooser, cancelling a
dialogue. The kernel owns state and exposes no host-driven transition that is
not a reducer resolution; `prepareExtension` records a lane entry and changes
nothing. Routing these through `prepareIngest`/`prepareAdvance` would make each
modal keystroke a world turn requiring every seat to submit, which changes the
game. So hosted Arena PvP still runs a second, hand-rolled loop and its
transcript is not kernel-produced.

RFC-006 §4 anticipated exactly this, leaving the substep Arena-side and naming
a generic extension-lane hook as the seam; §7 Q1 left the shape open. Arena is
now a concrete answer: it needs **ordered-with-gameplay, state-changing,
seat-local** transitions that do not advance the shared cursor.

**This extends the §B7.1 taxonomy, and breaks an invariant §B7.1 relied on.**
B7.1 resolved interest scope changes as a third non-gameplay transition kind,
justified precisely *because* it cannot reach the reducer — reducer isolation
is what makes invariant 2 hold by construction. Arena's case is the opposite:
it must change state. Lining the three up:

| transition | changes state | advances `cursor` | advances `viewRevision` |
|---|---|---|---|
| rejection-only (shipped) | no | no | no |
| interest scope (§B7.1) | no | no | no |
| **seat-local control (F4)** | **yes** | no | **must** |

The first two are safe because nothing changed, so nothing needs a new view
revision. The third changes the view, so `viewRevision` must advance — and
RFC-006 states as an invariant that *"at every observable kernel state,
`viewRevision(seat) === cursor()` for every declared seat"*, calling that
equality the stable bridge from an `IngestReceipt.cursor` to the authoritative
revision after resync. **A seat-local state transition that advances
`viewRevision` without advancing `cursor` violates it.**

So F4 cannot be granted by analogy to B7.1; it needs its own resolution. Three
candidate directions, unresolved and stated as such:

1. **Decouple `viewRevision` from `cursor` per seat.** Most direct, and it
   costs the stable bridge that resync depends on. Likely too expensive.
2. **Seat-local control state is not reducer state.** Put it in a seat-scoped
   store the reducer may *read* but resolutions do not own. This is the
   cleanest if Arena's chooser/dialogue state is genuinely presentation rather
   than simulation — and the diagnostic is sharp: **if it affects the
   simulation, determinism already requires it in the transcript, so it was
   never seat-local to begin with.** Arena should answer that question first;
   it decides whether this finding is a kernel change at all.
3. **Model them as resolutions with an empty input set**, which advances both
   revisions honestly and costs the "every seat must submit" semantics that
   made Arena reject the resolution path in the first place.

**Recommendation: put question 2's diagnostic to Arena before designing
anything.** The answer determines whether v0.20 needs a new transition class or
whether this is host-side presentation state that never belonged in the kernel.

**Disposition (Arena answer, 2026-07-26): option 2.** Opening, navigating, and
cancelling a chooser or dialogue are pure UI state and must not mutate
simulation state. Confirming an option produces an ordinary SDK action; that
action enters through `prepareIngest` and changes state only during the
resulting deterministic reducer resolution.

No new kernel transition class is needed. UI activity advances neither
`cursor` nor `viewRevision`, so the equality invariant remains intact. Hosts
must not let unconfirmed chooser state affect legality, RNG, turn order,
authoritative observations, or any later reducer result. If a future product
needs such an effect, it is simulation input and must be represented as a
recorded action rather than reclassified as seat-local control.

## E5 — Durable event size, joined to E2

*Source: Arena (F3). Same family as E2, measured on a different axis — Arena
itself makes this point, and it is right: **E2 measures per-tick observation
cost, E5 measures per-resolution durable event cost.** Scope them together.*

Arena, turns cadence, one seat, single-parameter commands, measured off the
Durable Object's stored record:

| Event kind | Per turn | Bytes |
|---|---|---|
| `intent-accepted` | 1 | 271 |
| `resolution` | 1 | 392 |
| `checkpoint` | 1 | 152 |
| **total** | | **~815** (~818 with enclosing escaping) |

Roughly **30 % is derivable rather than essential**: `eventId` repeats the
36-char `sessionId` in every event (~150 B/turn of a constant already in
`SessionHeader`); `canonicalCommand` duplicates `command` as an escaped string
and is just `canonicalJson(command)`; `consumed` duplicates
`inputs[].participantId`/`submissionId`, which `inputs` already carries.

The operational finding is worth more than the byte count. Cloudflare Durable
Objects cap a single stored value at 128 KiB; Arena's shipped content reaches
375 actions for one level and 760–1305 for a scored run, so a naive
"transcript in one value" host design dies at ~159 actions — **well inside real
content**. Arena's fix is host-side (one storage key per level episode, plus
chunking) and it is explicit that the SDK should not know about the 128 KiB
cap. Agreed.

**v0.20, documentation first:**

1. Document that `SessionEvent` is the **durable** representation and state its
   expected size per resolution, so hosts size storage before designing it.
   Cheapest item here, and it would have caught Arena's design error.
2. *Consider* a documented compact persistence form — events minus the
   derivable fields, rehydrated by recomputation — for hosts with per-value
   limits. In-memory and projection shapes need not change.

## E6 — Host ergonomics: four papercuts that each cost every host the same loop

*Source: Arena (F6–F9). Individually small; grouped because they share a
cause — the kernel holds the answer and makes the host re-derive it.*

- **No accessor for awaiting seats.** Verified: `awaitingParticipants` exists
  only as an `IngestReceipt` field (`src/session.ts:253`), computed inline
  during receipt construction (`:861`, `:1582`). A host answering "who are we
  waiting for?" on a poll, a reconnect, or after a restart has no accessor, so
  Arena rebuilds it by replaying `intent-accepted` events since the last
  resolution. Every host serving a "waiting for opponent" UI writes that loop.
  → `awaitingSeats(): readonly string[]`, matching the receipt's fields.
- **A duplicate receipt cannot be classified.** `prepareIngest` returns
  `status: 'duplicate'` with the cursor the submission was *accepted* at, but
  the host's response depends on whether it is still **pending** (202) or
  already **resolved** (200 replaying the tick). Arena infers this by comparing
  against `kernel.cursor()`, which is fragile at the boundary: "older than the
  last resolution" and "receipt retention evicted it" are different situations
  the host cannot distinguish, and `receiptRetention` (default 64) silently
  changes which it sees. → state it: `resolved: boolean` or
  `resolvedAtCursor?: number`. The kernel knows precisely; the host is guessing.
- **Run cursor rebasing is neither done nor documented.** One kernel per level
  (RFC-006 §D answer 3) means each episode counts `cursor()` from zero, while
  the revision a client holds must climb across the whole run. Arena carries a
  `revisionBase`, adding it outbound and subtracting inbound, including
  rewriting `tickId` so a mismatched one still fails validation rather than
  being silently repaired. It works, but it is fiddly, **security-adjacent**
  (cursor validation), and every run-composing host will re-derive it.
  → document the translation in the multi-level runs section; or accept an
  `initialCursor` in `SessionKernelOptions` so episode N starts where N-1
  stopped.
- **`rehydrateKernel` forces hosts to store or reconstruct the header.** It
  rejects a transcript whose header does not match the one its options derive —
  yet the header *is* derived from the options, so it carries no information
  the caller did not already supply. Hosts either store it redundantly (it
  embeds the full pinned level config, the largest object in the record) or
  reconstruct it; Arena builds a throwaway kernel and reads `sessionHeader()`,
  running `reducer.init` an extra time on every load. → export a pure
  `sessionHeaderFor(options): SessionHeader` and have both paths use it. Hosts
  then store events only, which is what a durability log actually is.

---

## Consolidated v0.20 scope from both migrations

| Item | Source | Class | Lands |
|---|---|---|---|
| D1 `ObservationDelta` origin discriminator | TTL | blocks migration | v0.19.x |
| D2 `SubmittedAction.payload` + `replayInput` | TTL | blocks replay | v0.19.x |
| D3 `./session` re-exports | TTL | packaging | v0.19.x |
| D5 `advancePolicy` for non-ladder runs | Arena | blocks migration | v0.19.x |
| **E3 post-commit wedge (legality seam + view classification)** | Arena | contract gap | **v0.20 — highest value** |
| E4 seat-local state transitions | Arena | design input | v0.20, resolved host-side |
| E1 `TickView` shape | TTL | shape smell | v0.20, additive split |
| E2 + E5 representation cost | both | measured | v0.20, patch codec + docs |
| E6 host ergonomics ×4 | Arena | papercuts | v0.20, small |

Implementation note (2026-07-26): D1–D3/D5, E2's mandatory v2 envelope with
bounded adaptive patch delivery, E3, E5's storage guidance, and E6 are
implemented on the v0.20 development line. The reproducible
`npm run observations:benchmark` synthetic check now reports snapshot,
adaptive-probe, base/max-backoff CPU, derived-cache ownership cost, and timed
level-1/level-6 compression across sparse and high-churn 50/200/500-entity
views.
E1 is implemented as the additive `SessionView`/`TickView` split with an
explicit `replayMetrics` seam for non-HUD observations. Arena resolved E4:
unconfirmed chooser/dialogue state is presentation-only, while confirmation
enters the kernel as an ordinary action. No new transition class is needed.

**If only one item is taken from either migration, take E3.** Both consumers
independently hit the same class — a failure discovered after durable commit
wedges the session instead of rejecting the request — and E3a is the one every
host meets on ordinary input rather than on malformed data.

**Note on independence.** The two returns are largely disjoint, which is itself
evidence: D5, E3, and E4 have no TabletopLabs counterpart, and D1/D2/E1 have no
Arena counterpart. The one place they converge — representation cost, E2 and E5
measured on different axes — is the one place two independent voices agree, and
it is the item with the strongest claim on v0.20 engineering time after E3.
