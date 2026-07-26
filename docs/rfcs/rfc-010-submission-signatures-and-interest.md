# RFC-010 — Submission signatures, audit chains, and generic interest management

Status: draft · Target: v0.20 · Breaking: no (additive; requires the v0.19
field reservations) · Depends on: RFC-006, RFC-008, and **v0.19 T2 closed**

Two parts in one RFC because they couple at exactly one point: an interest
scope change is a client-declared, signable submission (§B4), and it is the
only place where a bandwidth optimisation becomes a security-relevant claim.

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

- The artifact header carries a **seat roster**: `seats: [{ id, publicKey,
  alg }]`.
- How a verifier decides the roster is authentic is product policy (Arena
  signs the roster with a service key; a third party may pin it; a casual
  host may publish it unsigned). The SDK reports *what the roster says* and
  whether submissions match it — never who the seats "really are".
- Open items to specify: key rotation mid-session (proposal: forbid in v1;
  a rotation is a new session), lost keys, spectators (no key needed — they
  submit nothing), **agents/bots** (an evaluation driver is a seat and needs
  a key, which makes benchmark runs signable — a mission win worth calling
  out), seat reassignment (proposal: a reassignment is a roster change and
  therefore a new session in v1).

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

## A5. The signing envelope

Byte-exact, framed with the same discipline RFC-008 §2 already proved out
(u32-BE length prefixes on every byte-string field, u64-BE integers, a
domain tag that is itself framed):

```
domainTag = UTF8("gaos.submission.ed25519.v1")     // distinct from gaos.commit.*
fields, in order:
  domainTag, sessionId, seat, submissionId,
  cursor (u64-BE), tick (u64-BE),
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
submission** in the same session (`prevChainHash`, zero for the first).

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

`N` is product policy with an SDK default; the artifact records it so a
verifier knows what coverage to expect.

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

- Header: `seats: [{ id, publicKey, alg }]`, `signaturePolicy: { scheme, N }`.
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
header `seats`/`signaturePolicy`; action and resolution-input
`submissionId`/`canonicalCommand`/`cursor`/`prevChainHash`/`sig`; and mismatch
`canonicalCommand`/`cursor`/`prevChainHash`/`sig`. Live submission and session
event types likewise reserve `prevChainHash` and `sig`, with rejected events
also reserving the canonical command and cursor. v1.2 will validate and
interpret these fields.

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
   *receives*, never what the reducer computes. Two hosts with different
   interest policies must produce identical transcripts.
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

## B7. Open questions (Part B)

1. Is interest declared per seat, or per (seat, client) — a player with two
   devices may render different things?
2. Does an interest scope change consume a gameplay window, or ride the
   extension lane (structurally non-gameplay, per RFC-006 §D answer 2)?
   Proposal: extension lane, since it must not affect reducer state — but
   then it needs ordering guarantees the extension lane deliberately lacks.
   This is the sharpest unresolved design question in Part B.
3. Should tier-3 `N` be uniform or per-seat (an agent under evaluation might
   warrant per-submission signing while a human player does not)?
4. Does the seat roster itself need signing, or is that always product PKI?

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
