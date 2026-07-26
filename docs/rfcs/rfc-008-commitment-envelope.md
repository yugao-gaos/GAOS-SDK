# RFC-008 — Commit–reveal envelope for player-authored secrets

Status: **implemented (rev 6, v0.19.0, 2026-07-25)**
Target: rides the gaos.replay v1.1 format bump defined by RFC-006 §D1
Breaking: no (new optional records; strict schema extended, not loosened)

Current disposition (rev 6, 2026-07-25): §§1–7 are the sole normative text.
Rev 6 makes the v1.1 audit lane explicitly advisory pending RFC-010,
reserves the additive signature/chain/roster slots, permits repeated bad
reveals under fresh submission identities, and closes canonical safe-number
and unpaired-surrogate parity across TypeScript and Python. Rev 5 pins
object-key collation to Unicode code-point order, adds a
non-BMP-key cross-language vector, and rejects mismatch audits that are late,
duplicated, or reuse a rejection submission identity. Rev 4 makes mismatch
audit records independently recomputable (attemptedReveal in the rejection
event, matching-hash records fail replay, redacted artifacts state their
limitation) and freezes windowRef to non-negative safe integers.
Rev 3 pins the exact domain-tag bytes and full preimage rules, separates
wire-hex encoding from hashed raw bytes with a dedicated pre-hash validator,
integrates the commit_mismatch rejection event with RFC-006 SessionEvents and
gaos.replay v1.1 audit records, and folds all lifecycle/visibility rules into
the normative body. Golden preimage-and-digest vectors are required before
merge. Review and revision history: §§8–11.

Final design review (2026-07-25): **approved for implementation**, subject to
the golden-vector and strict-schema merge gates already stated. See §14.

Implementation evidence (2026-07-25): `src/engine/commitment.ts`, session
pre-reducer verification in `src/session.ts`, replay audit verification in
`src/engine/replay-format.ts`, and the complete preimage vectors under
`fixtures/commitment/`. TypeScript tests cover NIST/WebCrypto agreement,
tampering, redacted unrevealed commitments, and audit behavior; the Python
suite independently rebuilds every framed preimage and SHA-256 digest.

Third review (2026-07-25): framing and lifecycle rules are resolved, but a
live `commit_mismatch` audit record is not independently replay-verifiable
without the attempted reveal, and `windowRef` needs a numeric bound. See §12.

## 1. Scope

Player-authored secrets only: simultaneous hidden orders, face-down choices
the player composed, bluff tokens, secret notes. Out of scope: shared
randomness (deck order — session kernel or mental poker) and derived
visibility (fog — session kernel). See the hidden-information class analysis
in the appendix history.

Goal: a peer or host can verify, at reveal time and again at replay time,
that a revealed secret is byte-identical to what was committed, that the
commitment was bound to its context, and that game legality was evaluated
consistently before and after the reveal.

## 2. Canonical bytes and scheme

- `payloadBytes = UTF8(canonicalJson(payload))` — the SDK's shared
  `canonicalJson` (object keys sorted lexicographically by Unicode code point,
  not UTF-16 code unit; no insignificant whitespace; non-finite and
  non-JavaScript-safe integer numbers rejected). **No NFC normalization**
  (rev 2): strings are committed
  as their exact JSON code points; differently-normalized strings are
  different payloads, consistent with the byte-identical goal, and the
  shared helper is not forked or changed. Unpaired surrogates are rejected.
- Framing (frozen, byte-exact): fields in the order
  `domainTag, sessionId, seat, commitmentId, windowRef, salt, payloadBytes`.
  - `domainTag = UTF8("gaos.commit.sha256.v1")` — the exact bytes, framed
    with a u32 big-endian length prefix like every other byte-string field.
  - Every byte-string field is prefixed by its unsigned 32-bit big-endian
    byte length; `commitmentId` and `windowRef` are unsigned 64-bit
    big-endian integers (no length prefix). The u64 width is a **frozen
    reserved range**: v1 policy caps `commitmentId` at `2^32 − 1` (§3);
    implementations must enforce the policy cap and must NOT infer a wider
    accepted range from the wire width.
  - **Wire encoding vs hashed bytes:** `sessionId` and `seat` enter the
    preimage as UTF-8 bytes after validation. `salt` enters as the **raw
    16–64 decoded bytes** (strict lowercase-hex decoding), never as the
    UTF-8 bytes of its hex spelling. `hash` is exactly 32 raw SHA-256
    bytes, represented on the wire by exactly 64 lowercase hex characters.
  - **Pre-hash validation (a dedicated validator — existing `canonicalJson`
    does NOT perform these checks):** malformed hex, odd-length hex,
    non-lowercase hex, and invalid/unpaired surrogates in any framed string
    are rejected before hashing.
  - Limits: sessionId ≤ 128 bytes, seat ≤ 64 bytes, salt 16–64 bytes,
    payloadBytes ≤ 65536 bytes (also the protocol acceptance bound).
  - At least three published vectors showing the **complete preimage bytes**
    (not only the final digest) accompany the implementation.
- `scheme = 'gaos.commit.sha256.v1'` — the identifier pins the **complete
  construction** (canonicalization + framing + hash), not just the
  primitive. Append-only registry.
- `salt`: ≥ 16 bytes, hex-encoded, from the committer's own entropy — salts
  are NOT derived from session seeds (they must be unpredictable to other
  peers, unlike gameplay randomness).
- Encoding on the wire and in transcripts: lowercase hex for hash and salt.

## 3. Binding and references (anti-replay)

A commitment is bound to `(sessionId, seat, commitmentId, windowRef)`:

- `commitmentId`: seat-scoped counter, **client-authored and
  collector-validated**: starts at 0, strictly monotonic, no gaps, capped at
  `2^32 − 1`; bound to the accepted-intent receipt (RFC-006 §F-E1), so a
  transport retry can never mint a second logical commitment — exact
  duplicate retry returns the original receipt, conflicting reuse is a
  `conflict`. Rehydration reconstructs the next valid id from
  accepted-intent events, including commitments in unresolved windows.
  Several commitments may coexist in one window; each reveal names exactly
  one `commitmentId`.
- `windowRef`: the resolution index (turns mode) or tick (ticks mode) of the
  window the commitment entered — assigned by transcript position, so a
  commitment recorded in resolution N has `windowRef = N` **by
  construction**. The reveal's `commitRef` is checked against the recorded
  transcript position; it is never trusted from the revealer (review
  requirement: `commitTick` derived, not supplied). Accepted range (frozen):
  `0 ≤ windowRef ≤ Number.MAX_SAFE_INTEGER`, a non-negative safe integer
  encoded into the reserved u64 big-endian field; unsafe, fractional, or
  negative values are rejected before hashing — as with `commitmentId`, the
  wire width does not imply the full u64 range is accepted.
- Cross-context replay of a commitment (another session, seat, or window)
  fails the binding check by construction.

## 4. Reducer semantics

- Envelope rules: `commit` and `reveal` are **mutually exclusive** on one
  action; the outer action id is an ordinary game-declared action; the
  committed payload is an **opaque `JsonValue`** that the game adapter maps
  to reducer input only **after** verification; envelope verification is a
  deterministic **pre-reducer** step in the session/protocol layer — only
  verified payloads enter the canonical input batch.
- Commit: `SubmittedAction` with `commit: { commitmentId, scheme, hash }`.
  The reducer sees the commitment as opaque; legality rules may count
  commitments (e.g. "you must submit exactly one hidden order") but cannot
  read payloads. State stores the commitment record verbatim.
- Reveal: `SubmittedAction` with `reveal: { commitmentId, salt, payload }`.
  Verification order is fixed: (1) commitment exists and is unrevealed;
  (2) binding fields match transcript position; (3) hash matches canonical
  payload bytes. Only then does the reducer evaluate the payload's gameplay
  legality. An illegal-but-honest payload is a normal illegal action; a
  hash mismatch is recorded as the typed rejection event defined in
  RFC-006's `SessionEvent` union — carrying tick, participantId,
  submissionId, commitmentId, scheme, **and the rejected reveal material
  itself** (`attemptedReveal: { salt, payload }`, subject to the same
  65,536-byte payload bound), so replay can independently recompute the
  mismatch rather than trusting the host's recorded code. It stays outside
  the reducer input batch, never advances gameplay by itself, and
  **survives `finalizeReplay` as a `gaos.replay` v1.1 audit record**.
  Replay verification of a rejection record: look up the commitment and
  binding context, re-canonicalize and hash `attemptedReveal`, confirm the
  computed hash **differs** from the committed hash, then report a non-fatal
  `verified commit_mismatch` diagnostic; if the values actually match, the
  rejection record is itself inconsistent and replay fails with a distinct
  verifier problem. A redacted record also remains a non-fatal diagnostic,
  explicitly marked as not independently recheckable.
  A mismatch record must occur at the still-open tick before that commitment
  is successfully revealed. The verifier rejects participant-scoped reuse
  of a mismatch `submissionId`; it deliberately permits the same bad reveal
  under a fresh identity because that is valid client retry behavior.
  Seat-scoped projections may redact another seat's rejected payload under
  normal visibility policy — such artifacts must report the rejection as
  recorded-but-not-independently-recheckable; only a full artifact
  containing the attempted reveal can claim cryptographic re-verification.
  `commit_mismatch` is (rev 2 rename):
  **a cryptographically recomputable mismatch between two host-recorded
  values** — not authentication that the seat authored the reveal, and not
  proof of who cheated (client bugs, storage corruption, fabrication, or host
  tampering produce the same artifact). Products classify it under their own
  trust policy.
- **v1.1 audit trust boundary (interim):** `commit-mismatch` and `timeout`
  records are host attestation. Their consistency checks catch implementation
  bugs, corruption, and unsophisticated tampering; they do not authenticate
  authorship, prevent fabrication/deletion, or prove that the host's audit
  story is true. `ok` means the replay and any present audit records are
  internally consistent. A leaderboard or third-party trust decision MUST
  NOT depend on unauthenticated v1.1 audit records. RFC-010 supplies
  per-submission signatures and per-seat hash chains in v1.2.
- **RFC-010 reservations:** v1.1 reserves, without assigning cryptographic
  meaning, header `seatKeys`/`signaturePolicy`/`timeoutPolicy`, the periodic
  `seat-signature` carrier, action and resolution-input
  `submissionId`/`canonicalCommand`/`cursor`/`clientTime`/`prevChainHash`/`sig`,
  and matching mismatch fields. The strict schema accepts and round-trips
  these slots so v1.2 remains additive.
- Pre-reveal observation: commitments appear in every seat's view as
  `{ commitmentId, seat, scheme }` — existence is public, content is not.
  Post-reveal, payload joins the view per normal partition policy.

## 5. Transcript and replay (`gaos.replay` v1.1)

- Commit and reveal ride the action records (new optional fields in the
  v1.1 schema; v1.0 rejects them by design — producers using commitments
  must emit v1.1).
- Replay verification recomputes every reveal's hash with the recorded
  scheme. A synchronous, pure JS SHA-256 ships with the verifier for exactly
  this purpose (WebCrypto's async API is unusable inside the synchronous
  checker; the committer MAY still use WebCrypto at submission time — both
  must agree on test vectors). A failed recomputation fails the replay with
  a `commit_mismatch` finding naming seat and commitmentId.
- Redaction/publication timing: **full visibility means every commit and
  reveal actually recorded** — a finalized artifact can never contain an
  unrevealed payload the host never received. Seat-scoped artifacts include
  another seat's payload only from its recorded reveal point onward;
  redaction is a deterministic projection of recorded reveals and the
  partition policy — never a synthesized reveal, never a salt before the
  reveal record. Publication timing is product policy; the format supports
  both.
- Lifetime: commitments must reveal (or expire under product legality
  rules) **within the same level episode** (kernel-per-level, RFC-006 §D
  answer 3); cross-level carry-over is deferred to the run-composition
  contract.

## 6. Test plan

- Canonical-bytes golden vectors (code-point preservation — deliberately no
  normalization — plus unpaired-surrogate rejection, Unicode code-point key
  order including a non-BMP/BMP-private-use pair, nested structures, framing;
  vectors publish complete preimages).
- Full commit→reveal→verify round-trip; tamper matrix (wrong salt, wrong
  payload, wrong window, wrong seat, replayed commitment from another
  session) — each fails with the specific expected code.
- Replay: v1.1 artifact with commitments verifies; a doctored reveal fails;
  an unrevealed commitment survives finalization redacted.
- Cross-language: Python independently reconstructs the u32/u64 framing,
  canonical payload bytes, complete preimage, and SHA-256 for every published
  vector.
- WebCrypto-vs-shipped-SHA256 agreement vectors.

## 7. Open questions

1. Should `commit_mismatch` terminate replay verification or be collected
   while verification continues (auditors may want the full list)?
   Resolved: collect and continue. A verified mismatch (or a redacted record
   that cannot be independently checked) is a diagnostic and does not make
   `ok` false; an internally inconsistent audit record is a problem and does.
2. Group commitments (one hash over N seats' bundled secrets for team play):
   defer until a consumer exists.
3. Expiry: may a product declare commitments void if unrevealed after K
   windows, and does the kernel enforce it? Proposal: product legality rule,
   not kernel policy.

---

## 8. Review notes and requested revisions (2026-07-25)

### Disposition

Approve the decision to move commit–reveal into a dedicated RFC and to make it
depend on `gaos.replay` v1.1. The proposed domain binding,
transcript-position check, minimum salt size, replay verification, and tamper
matrix are the right components.

Request revision before implementation. Cryptographic interoperability
depends on byte-level rules being exact, and the current text conflicts with
the SDK's existing canonical JSON behavior.

### Required revisions

#### 1. Resolve the NFC/canonical JSON incompatibility

The existing SDK `canonicalJson` sorts object keys and rejects lossy JSON
values, but it does not normalize strings or keys to NFC. Changing that helper
globally would change exact-retry comparison and canonical replay bytes for
existing consumers.

Choose one:

- **Recommended:** preserve strings exactly as JSON code points and remove NFC
  normalization from this scheme. Two differently normalized strings then
  represent different committed payloads, which is consistent with the
  stated "byte-identical" goal.
- Introduce a commitment-specific `canonicalCommitPayloadV1` that recursively
  normalizes both keys and values before encoding. If this option is chosen,
  define behavior when two distinct source keys normalize to the same key and
  make clear that semantic-normalization equivalence, not authored-byte
  identity, is being committed.

Do not silently change `canonicalJson` under the existing protocol/replay
format. Pin the selected canonicalization algorithm in the commitment scheme
and add cross-language vectors.

#### 2. Specify the framing format byte for byte

"Explicit length-prefix framing" is not enough for independent
implementations. Define:

- field order;
- UTF-8 encoding and invalid/unpaired surrogate behavior;
- length width, units, signedness, and byte order;
- integer encoding for `commitmentId` and `windowRef`;
- maximum lengths and integer ranges;
- whether the domain tag is itself framed;
- the exact bytes hashed, with at least three published hex vectors.

For example, the scheme could use an unsigned 32-bit big-endian byte length
before every byte-string field and unsigned 64-bit big-endian integers for
the two counters. Whatever representation is selected becomes frozen
`gaos.commit.v1` behavior.

The `scheme` identifier should pin the complete construction, not only the
hash primitive. Prefer a value such as `gaos.commit.sha256.v1`, or define a
separate canonicalization/framing version that is always checked together
with `scheme`.

#### 3. Define commitment ID authority and lifecycle

Specify whether `commitmentId` is assigned by the client or the authoritative
collector. If client-authored, the collector must validate:

- the initial value;
- strict monotonicity or uniqueness rules;
- duplicate exact retry versus conflicting reuse;
- maximum value and overflow; and
- whether gaps are legal.

Bind the ID to the protocol submission receipt so a transport retry cannot
create a second logical commitment. Rehydration must reconstruct the next
valid ID from accepted-intent/session events, including commitments in an
unresolved window.

#### 4. Pin `SubmittedAction` shape and reducer ordering

`SubmittedAction.id` remains mandatory, while `commit` and `reveal` are
described as optional additions. Define:

- whether one action may contain both `commit` and `reveal`;
- whether commit/reveal may coexist with `x`, `y`, `index`, `targets`, or
  other gameplay parameters;
- whether the committed payload is itself a `SubmittedAction`, an opaque
  `JsonValue`, or a game-defined command later mapped to an action;
- whether hash verification happens in the session/protocol layer before the
  reducer or inside a versioned reducer adapter;
- what state transition is recorded for an invalid reveal; and
- atomic ordering when several seats reveal in one simultaneous resolution.

Recommended rule: commit and reveal envelopes are mutually exclusive, their
outer action IDs are ordinary game-declared actions, envelope verification is
a deterministic pre-reducer validation step, and only a verified payload is
mapped into the reducer's canonical simultaneous input batch.

#### 5. Narrow the evidentiary claim

A hash mismatch proves that a reveal is inconsistent with a recorded
commitment. Without authenticated submission signatures and a trusted
transcript writer, it does not by itself prove that the player cheated; client
bugs, storage corruption, or host tampering can produce the same artifact.

Rename the finding accordingly, for example `commit_mismatch`, and describe
it as cryptographic evidence of inconsistency. A product may classify it as a
competitive violation under its trust policy, but the SDK should not
attribute intent or authorship it has not authenticated.

#### 6. Clarify replay visibility and unrevealed payloads

A finalized full transcript cannot contain an unrevealed payload that the
host never received. Define full visibility as containing every commit and
every reveal actually recorded, not unknowable secrets.

For seat-scoped artifacts, specify whether an opponent's successfully revealed
payload is included after its normal revelation point. Redaction must be a
deterministic projection of the recorded reveal and the product's partition
policy; it must never synthesize a reveal or include a salt before the reveal
record.

### Questions to resolve

1. Does the synchronous SHA-256 implementation become an SDK-owned,
   version-frozen replay primitive with permanent golden vectors, or is hash
   verification injected by the replay adapter? The former is simpler for
   portable verification but expands the SDK's compatibility surface.
2. Is a salt permitted to be reused accidentally across commitments? The hash
   remains context-bound, but the verifier may still want a diagnostic warning
   because reuse weakens resistance to offline guessing.
3. What is the maximum payload size accepted before hashing? Set a protocol
   bound so malicious inputs cannot force unbounded canonicalization, memory,
   or hashing work.
4. Are commitments required to reveal during the same level episode, or may a
   multi-level run carry an unrevealed commitment forward? The latter would
   require the run-level composition contract to preserve its binding context.

---

## 9. Revision 2 — author response

All six required revisions **accepted**; §§2–5 updated in place. Decisions:

1. **Canonicalization:** recommended option adopted — exact JSON code
   points, no NFC anywhere in the scheme, existing `canonicalJson`
   untouched. Cross-language vectors required before merge.
2. **Framing:** fully specified in §2 (field order, u32-BE length prefixes
   on all byte strings incl. domain tag, u64-BE counters, size bounds,
   unpaired-surrogate rejection, three published hex vectors). The scheme
   id `gaos.commit.sha256.v1` pins the complete construction.
3. **Commitment id authority:** client-authored, collector-validated:
   per-seat strictly monotonic from 0, no gaps, max 2^32−1; exact duplicate
   retry returns the original receipt (bound to the protocol submission
   receipt via RFC-006 §F-E1 `intent-accepted` events — a transport retry
   can never mint a second logical commitment); conflicting reuse →
   `conflict`. Rehydration reconstructs the next id from accepted-intent
   events, including commitments in unresolved windows.
4. **Action shape and ordering:** recommended rule adopted verbatim —
   `commit` and `reveal` are mutually exclusive on one action; outer action
   ids are ordinary game-declared actions and may carry normal gameplay
   parameters only when the game's action declares them; the committed
   payload is an opaque `JsonValue` that the game adapter maps to reducer
   input **after** verification; envelope verification is a deterministic
   pre-reducer validation step in the session/protocol layer; a failed
   verification never enters the canonical input batch — it is recorded as
   a typed rejection (`commit_mismatch`) event, keeping simultaneous
   resolutions atomic over verified inputs only.
5. **Evidentiary wording:** renamed to `commit_mismatch`; described as
   cryptographic inconsistency evidence (§4); the SDK attributes no intent.
6. **Replay visibility:** full visibility = every commit and reveal
   *actually recorded* (never unknowable secrets); seat-scoped artifacts
   include another seat's payload only from its recorded reveal point;
   redaction is a pure projection — no synthesized reveals, no salt before
   the reveal record.

### Answers to §8 questions

1. **Sync SHA-256:** SDK-owned, version-frozen replay primitive with
   permanent golden vectors. Rationale: portable verification must not
   depend on adapter-supplied crypto; the surface is one function and one
   test-vector file, a small price for universal verifiability.
2. **Salt reuse:** allowed by the scheme (context binding keeps hashes
   distinct); `AdvanceSummary.warnings` warns the live host and the replay
   verifier emits a non-fatal diagnostic when reuse occurs within a session,
   since reuse weakens offline-guessing resistance. Rehydration reconstructs
   the live warning state from resolutions and mismatch audit records.
3. **Payload bound:** 65536 bytes before hashing (also enforced at
   ingestion), preventing unbounded canonicalization/hash work.
4. **Cross-level commitments:** v1 requires reveal within the same level
   episode (kernel-per-level, RFC-006 §D answer 3). Carrying a commitment
   across levels is deferred to the run-composition contract and must
   preserve the full binding context if ever allowed.

---

## 10. Second review after Revision 2 (2026-07-25)

### Disposition

Revision 2 resolves the six original requests: existing canonical JSON remains
unchanged, framing is substantially specified, IDs are collector-validated,
envelope verification precedes reducer entry, evidentiary language is
appropriately narrow, and visibility is based only on recorded data.

Request four final corrections before approval. These are byte-level
interoperability and cross-RFC replay issues.

### Required corrections

#### 1. Pin the exact domain-tag bytes

The framing lists `domainTag` but never assigns its value. The scheme ID does
not implicitly define the bytes unless the RFC says so.

Set it normatively, for example:

```text
domainTag = UTF8("gaos.commit.sha256.v1")
```

and include its u32 big-endian byte length like every other byte-string field.
The published vectors must show the complete preimage, not only the final
digest.

#### 2. Distinguish encoded wire strings from hashed raw bytes

State explicitly that:

- `sessionId` and `seat` are UTF-8 bytes after validation;
- `salt` in the hash preimage is the raw 16–64-byte value obtained by strict
  lowercase-hex decoding, not the UTF-8 bytes of its hex spelling;
- `hash` is exactly 32 raw SHA-256 bytes represented on the wire by exactly
  64 lowercase hexadecimal characters; and
- malformed hex, odd lengths, non-lowercase input, and invalid/unpaired
  surrogates in every framed string are rejected before hashing.

The current SDK `canonicalJson` accepts unpaired surrogate strings and escapes
them. If this scheme rejects them, add an explicit pre-canonicalization
validator; do not imply that existing `canonicalJson` already performs the
check.

#### 3. Integrate rejected reveals into session and replay record unions

Revision 2 says a failed reveal is recorded as a typed `commit_mismatch`
event, but RFC-006's `SessionEvent` union has no rejection event and
`gaos.replay` v1.1 has not been assigned a portable rejection record.

Add a cross-RFC contract such as:

```ts
type SessionEvent =
  | {
      kind: 'rejection';
      code: 'commit_mismatch';
      tick: number;
      participantId: string;
      submissionId: string;
      commitmentId: number;
      scheme: 'gaos.commit.sha256.v1';
    }
  // ...
```

Define whether this event survives `finalizeReplay` as a v1.1 audit record.
It must survive if replay verification is expected to report a mismatch that
occurred live. It remains outside the reducer input batch and must not advance
gameplay unless product policy separately submits a canonical penalty action.

Coordinate this with RFC-006's new `transitionRevision` so rejection event IDs
are unique and retry-idempotent.

#### 4. Fold accepted lifecycle rules into normative §§3–5

The author response defines critical rules that the main contract still omits:

- commitment IDs start at zero, have no gaps, cap at `2^32 - 1`, and are
  bound to accepted-intent receipts;
- commit and reveal are mutually exclusive;
- the payload is opaque JSON mapped only after verification;
- verification is a session/protocol pre-reducer step;
- full visibility means all commits and reveals actually recorded; and
- commitments must reveal within the same level episode.

Move these into §§3–5. Also change the test-plan phrase "unicode
normalization" to code-point preservation plus unpaired-surrogate rejection,
since the scheme deliberately performs no normalization.

### Clarification recommended

The framing reserves u64 for `commitmentId` while v1 policy caps it at
`2^32 - 1`. This is deterministic but unusual. Either explain that the wider
frozen field reserves future range without changing framing, or use u32 now;
future implementations should not infer different accepted ranges from the
wire width.

### Approval condition

RFC-008 can be marked design-approved once the exact preimage rules,
rejection-event integration, and accepted lifecycle/visibility rules are in
the normative body with golden preimage-and-digest vectors required before
merge.

---

## 11. Revision 3 — response to second review

All four corrections **accepted** and folded into §§2–6:

1. Domain-tag bytes pinned: `domainTag = UTF8("gaos.commit.sha256.v1")`,
   framed with a u32-BE length like every byte-string field; vectors must
   publish complete preimages (§2).
2. Wire-hex vs raw-bytes distinction made explicit (salt hashes as raw
   decoded bytes; hash is 32 raw bytes / 64 lowercase hex on the wire), and
   a dedicated pre-hash validator is specified — existing `canonicalJson`
   is explicitly NOT credited with these checks (§2).
3. Rejected reveals integrated cross-RFC: RFC-006's `SessionEvent` union
   gains the `rejection` record (see its §H), which survives
   `finalizeReplay` as a v1.1 audit record, stays outside the reducer
   batch, and uses `transitionRevision`-scoped ids (§4 here).
4. Lifecycle/visibility rules folded into normative §§3–5 (id authority and
   caps, commit XOR reveal, opaque payload mapped post-verification,
   pre-reducer verification, recorded-data-only full visibility, same-level
   lifetime); test plan wording corrected to code-point preservation +
   unpaired-surrogate rejection.

Clarification adopted: the u64 counter width is documented as a frozen
reserved range; v1 policy caps `commitmentId` at `2^32 − 1` and
implementations must not infer acceptance range from wire width (§2).

---

## 12. Third review after Revision 3 (2026-07-25)

### Disposition

The canonical preimage, raw-byte versus wire-hex rules, ID lifecycle,
pre-reducer ordering, visibility, and same-level lifetime are now sufficiently
precise.

Revision requested for two final replay/interoperability corrections.

### 1. Make live mismatch audit records independently verifiable

The new rejection event records that a mismatch occurred but carries only
metadata:

```ts
{ kind: 'rejection', code: 'commit_mismatch', tick, participantId,
  submissionId, commitmentId, scheme }
```

That is insufficient for replay verification to recompute the attempted
reveal and confirm that it contradicts the commitment. The verifier can only
trust the host's recorded rejection code, which weakens the RFC's audit goal.

For a full-visibility v1.1 audit record, include the rejected reveal material:

```ts
{
  kind: 'rejection';
  code: 'commit_mismatch';
  tick: number;
  participantId: string;
  submissionId: string;
  commitmentId: number;
  scheme: 'gaos.commit.sha256.v1';
  attemptedReveal: {
    salt: string;
    payload: JsonValue;
  };
}
```

Replay then:

1. looks up the recorded commitment and binding context;
2. re-canonicalizes and hashes `attemptedReveal`;
3. confirms the computed hash differs from the committed hash; and
4. reports `commit_mismatch`.

If the values actually match, the rejection record itself is inconsistent and
the replay fails with a distinct verifier problem.

Seat-scoped projections may redact another seat's rejected payload under the
normal visibility policy. Such a redacted artifact must report the rejection
as recorded-but-not-independently-recheckable; only a full artifact containing
the attempted reveal can claim cryptographic re-verification.

Coordinate the expanded event shape with RFC-006 and the v1.1 strict schema.
The 65,536-byte payload bound applies to rejected attempts too.

### 2. Bound and type `windowRef`

The frozen preimage encodes `windowRef` as u64, but the TypeScript/session
surface uses JavaScript numbers and currently gives no accepted range. Define
it as a non-negative safe integer:

```text
0 ≤ windowRef ≤ Number.MAX_SAFE_INTEGER
```

and encode that integer into the reserved u64 big-endian field. Reject unsafe,
fractional, or negative values before hashing. As with `commitmentId`, the
wire width must not imply that JavaScript implementations accept the full u64
range.

### Approval condition

RFC-008 can be marked design-approved after full audit records carry enough
data to recompute live mismatches, redacted artifacts accurately state their
verification limitation, and `windowRef` has a frozen accepted range.

---

## 13. Revision 4 — response to third review

Both corrections **accepted** and folded into §§3–4:

1. **Independently verifiable mismatch audits:** the rejection event now
   carries `attemptedReveal: { salt, payload }` (payload bound applies), the
   replay recompute procedure is normative (§4), a matching recomputation
   fails replay as an inconsistent rejection record, and redacted artifacts
   must report recorded-but-not-independently-recheckable status. The
   expanded shape is coordinated with RFC-006 §J and the v1.1 strict schema.
2. **`windowRef` typed and bounded:** non-negative safe integer
   (`0 ≤ windowRef ≤ Number.MAX_SAFE_INTEGER`) encoded into the reserved
   u64-BE field; unsafe/fractional/negative rejected before hashing (§3).

---

## 14. Final design review (2026-07-25)

### Disposition: approved for implementation

Revision 4 satisfies the remaining approval conditions:

- the complete hash preimage and domain tag are byte-exact;
- canonical JSON behavior and the separate surrogate/hex validator are clear;
- wire hexadecimal and hashed raw bytes are distinguished;
- commitment and window identifiers have frozen accepted ranges;
- commitment IDs are receipt-bound and rehydratable;
- commit/reveal ordering and pre-reducer verification are deterministic;
- live mismatch records contain enough material for independent full-replay
  verification;
- redacted artifacts accurately disclose when a rejection cannot be
  independently recomputed;
- evidentiary claims do not over-attribute intent; and
- the record survives finalization through the strict v1.1 audit schema.

This is design approval, not approval of untested cryptographic code. Merge
still requires:

1. published complete-preimage and digest vectors, including cross-language
   implementations;
2. WebCrypto versus SDK SHA-256 agreement vectors;
3. strict malformed-input, surrogate, framing, and size-bound tests;
4. the full tamper/binding matrix;
5. full-versus-redacted replay verification tests; and
6. schema compatibility tests proving v1.0 rejects and v1.1 accepts the new
   records as specified.

The `gaos.commit.sha256.v1` construction becomes version-frozen once those
vectors ship; incompatible corrections require a new scheme identifier.
