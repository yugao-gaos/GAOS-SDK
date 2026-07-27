# RFC-007 — Deterministic math: the float whitelist, `dmath`, and the optional WASM backend

Status: **implemented for JS (rev 5, v0.19.0, 2026-07-25)** · Target: doctrine + JS `dmath`
in v0.19, WASM backend gated on evidence (§4) · Breaking: no

Current disposition (rev 5, 2026-07-25): §§1–5 are the sole normative text.
Rev 5 closes the implementation evidence gates and corrects the coefficient
provenance to the clean-room Taylor construction that actually ships. Rev 4
resolved the third review's §4 contradictions (evidence-gated
mixability, abort-on-unconstructible-algorithm replay rule, createDmath-only
selection), labels the motivation list as examples, moves the complete
constants classification into §2, and qualifies `roundTo` as a frozen
deterministic binary64 algorithm rather than exact decimal arithmetic.
Review and revision history: §§7–13.

Final design review (2026-07-25): **approved for implementation**, subject to
the evidence gates already stated in §§3–5. See §12.

Implementation evidence (2026-07-25): `src/engine/dmath.ts`,
`fixtures/dmath/dmath-1.vectors.json`, and
`test/dmath-commitment.test.ts`; reproducible provenance and the independent
oracle live in `scripts/generate-dmath-evidence.mjs` and
`scripts/dmath-oracle.mjs`. CI runs the exact vectors in Node, Chromium,
Firefox, WebKit, and workerd. The optional WASM backend remains evidence-gated
and is not shipped.

## 1. Motivation

Cross-peer determinism is the load-bearing property of the whole SDK: replay
verification, lockstep digests, and the session kernel's authority model all
assume that the same inputs produce bit-identical state on every machine.
Floating point threatens this in exactly one place, and it is narrower than
folklore says:

- **Exact by spec (safe everywhere):** IEEE-754 double `+ - * /`,
  comparisons, `Math.sqrt`, `Math.abs`, `Math.floor/ceil/round/trunc`,
  `Math.fround`, `Math.imul`. ECMAScript mandates correctly-rounded IEEE-754
  semantics; x86-64 and ARM agree bit-for-bit.
- **Approximated by spec (the real desync source):** the
  implementation-approximated functions — examples include
  `Math.sin/cos/tan/atan2/exp/log/pow` (the complete classification,
  including the hyperbolics and `Math.random`, is the normative
  `STATE_MATH.forbidden` list in §2). Engines (V8 / JavaScriptCore /
  SpiderMonkey) may — and do — differ in the final bits, and results can
  change between engine versions. One `Math.sin` on a gameplay-critical path
  is enough to desync a Chrome peer from a Safari peer or from a
  workerd-hosted session kernel.

The engine subpath is already compliant (integer arithmetic, division, and
exact ops only — audited). This RFC turns that accident into a contract, and
gives products that need trigonometry/exponentials a safe implementation.

## 2. Part A — The determinism whitelist (doctrine, v0.19)

A normative docs page ("Float determinism") stating:

1. On any state-affecting path (reducers, settlement, mechanisms, session
   kernel), the **exact-op whitelist** above is freely allowed. Integer math
   is always safe.
2. Native `Math` transcendentals are **forbidden** on state-affecting paths.
   Presentation-only code (rendering, animation, audio) may use anything.
3. Seeds and randomness: engine PRNG only (already doctrine); `Math.random`
   is in the forbidden list explicitly.
4. The normative source of truth is one exported constant, `STATE_MATH`,
   classifying every `Math` member into exactly one category (unlisted
   future additions are forbidden until classified):
   - `constants` (allowed; spec-fixed exact values): `Math.E`, `Math.LN2`,
     `Math.LN10`, `Math.LOG2E`, `Math.LOG10E`, `Math.PI`, `Math.SQRT1_2`,
     `Math.SQRT2`. dmath does not duplicate them.
   - `exact` (allowed operations): `Math.sqrt`, `Math.abs`, `Math.floor`,
     `Math.ceil`, `Math.round`, `Math.trunc`, `Math.sign`, `Math.min`,
     `Math.max`, `Math.fround`, `Math.imul`, `Math.clz32` (plus the
     arithmetic operators and comparisons).
   - `forbidden`: `Math.sin`, `Math.cos`, `Math.tan`, `Math.asin`,
     `Math.acos`, `Math.atan`, `Math.atan2`, `Math.exp`, `Math.expm1`,
     `Math.log`, `Math.log1p`, `Math.log2`, `Math.log10`, `Math.pow`,
     `Math.hypot`, `Math.cbrt`, `Math.sinh`, `Math.cosh`, `Math.tanh`,
     `Math.asinh`, `Math.acosh`, `Math.atanh`, `Math.random`.
   Docs, tests, and product lint hints all derive from it; the string list
   is a hint, not an enforcement boundary.

## 3. Part B — `dmath` (engine module, v0.19)

Deterministic transcendentals implemented **in pure JS using only
whitelist-exact operations** (polynomial/table approximations with fixed
evaluation order). Because every constituent op is IEEE-exact, results are
bit-identical across engines and platforms by construction.

v0.19 ships exactly the surface with a demonstrated consumer (§8-R2), as
immutable version-selectable contexts (§8-R3):

```ts
export interface Dmath {
  readonly algorithm: 'dmath-1';       // append-only union over time
  readonly backend: 'js' | 'wasm';
  sin(x: number): number;              // domain |x| ≤ 2^30, else RangeError
  cos(x: number): number;              // same domain contract
  atan2(y: number, x: number): number; // finite args only; quadrant table published
  clamp(x: number, lo: number, hi: number): number;  // lo > hi throws
  roundTo(x: number, decimals: number): number;
  // decimals ∈ [-15, 15]; requires |x|·10^decimals < 2^53 (throws otherwise,
  // §10-R7). A frozen, deterministic binary64 rounding algorithm — NOT exact
  // decimal arithmetic: positive powers 10^0..10^15 are exactly representable
  // and negative scaling divides by those exact powers; results are
  // deterministic by fixed operation order, tie rule half-away-from-zero.
}
export function createDmath(options?: {
  algorithm?: 'dmath-1';
  backend?: DmathBackend;              // default: built-in JS
}): Dmath;                             // frozen instance, injected per session
```

| Function | Accepted domain | Accuracy/boundary contract | Out of contract |
| --- | --- | --- | --- |
| `sin` | finite `|x| <= 2^30` | `|x| <= 2π`: <= 1 ulp bit-distance (evidence <= 1.5 ulp real error); full domain: <= 2 ulp bit-distance; preserves `sin(-0) = -0`; 256-bit fixed-point reduction outside `[-π/4, π/4]` | `RangeError` |
| `cos` | finite `|x| <= 2^30` | `|x| <= 2π`: <= 1 ulp bit-distance (evidence <= 1.5 ulp real error); full domain: <= 2 ulp bit-distance; 256-bit fixed-point reduction outside `[-π/4, π/4]` | `RangeError` |
| `atan2` | finite `x` and `y` | <= 3 ulp bit-distance (evidence <= 2.818 ulp real error); IEEE signed-zero quadrants, range `[-π, π]` | `RangeError` |
| `clamp` | finite `x`, `lo`, `hi`; `lo <= hi` | exact endpoint selection; preserves an in-range signed zero | `RangeError` |
| `roundTo` | finite `x`; integer decimals `[-15, 15]`; scaled magnitude `< 2^53` | fixed binary64 operation order; half away from zero; preserves a negative zero result | `RangeError` |

No NaN ever escapes the public boundary. Every shipped algorithm version
stays constructible for as long as the SDK verifies replays that recorded it.
`tan`/inverses/`exp`/`log`/`pow`/`fixed` are deferred until a consumer plus
oracle-backed vectors exist.

The sine and cosine kernels use clean-room Taylor coefficients: the rounded
binary64 reciprocals of the visible factorials. The 256-bit `2/π` and `π/2`
constants are derived independently from Machin's formula
`π = 16 atan(1/5) - 4 atan(1/239)`. The checked-in generator reproduces both
the coefficients and constants and tests them against a separate 512-bit
integer oracle that invokes no native transcendental function.

Determinism target: **bit-identical values everywhere** (NaN payload bits out
of contract) — coefficients and evaluation order frozen per algorithm id,
golden bit-vectors run on the documented runtime matrix (V8, JSC,
SpiderMonkey, Node, workerd — minimum versions named in the test plan).

Non-goals: vector/matrix/physics libraries (engine-framework territory),
full fixed-point arithmetic frameworks, arbitrary precision.

First consumers: TabletopLabs' continuous layer (quaternion construction
from snap angles currently uses native `sin/cos` — a real cross-browser
risk in its P2P mode), and any product doing arcs, ballistics, or rotation
at realtime cadences, where per-tick math volume makes the discipline
matter most.

## 4. Part C — Optional WASM backend (v0.20)

### Why WASM

WASM core-spec float ops are fully deterministic (IEEE-754, no
implementation-defined transcendentals — you bring your own libm), and a
compiled backend can be faster for math-heavy realtime products. But not
every game needs it: a card game should not pay WASM loading complexity for
math it never calls. Therefore: **one API, two interchangeable backends,
product-selected.**

### Architecture

```ts
// Backends implement the same frozen algorithm; instances stay immutable.
export interface DmathBackend {
  id: 'js' | 'wasm';
  algorithm: 'dmath-1';
  sin(x: number): number;  // ... full surface
}
export async function createWasmDmathBackend(): Promise<DmathBackend>; // subpath `./dmath-wasm`
// usage: const dmath = createDmath({ backend: await createWasmDmathBackend() });
```

- **Async at boot, sync in play:** WASM instantiation is async, so products
  build the backend during startup and inject the frozen `Dmath` context per
  session. All gameplay calls remain synchronous. Doing nothing keeps the JS
  backend — zero behavior change for existing products.
- **Packaging:** the WASM binary ships in a separate subpath
  (`./dmath-wasm`) so the engine's zero-dependency, no-async purity promise
  is untouched. The module embeds its binary (base64) — no network fetch.
  **Deployment requirement:** WASM compilation needs `'wasm-unsafe-eval'`
  (or `'unsafe-eval'`) in the page CSP; products must be able to fall back
  to the JS backend without changing results (same algorithm id).

### The bit-identity contract (evidence-gated)

The design intent is that both backends implement the **same frozen
algorithm** (identical coefficients, identical operation order), which —
since JS exact ops and WASM float ops are both IEEE-754 — should yield
identical values. However, per §8-R4: **the WASM backend does not ship, and
mixability is not claimed, until** the shared bit-vector suite passes across
the named runtime matrix AND a named product workload satisfies the
performance gate (measured call volume; batched API; ≥2× over JS). Until
then the only shipping backend is JS.

Compatibility machinery, because determinism failures are catastrophic and
silent:

1. `ReplayHeader.extensions.dmath = { backend, algorithm }` — every producer
   records what it ran. `backend` is diagnostic only. If verification cannot
   construct the recorded **algorithm**, it **aborts before simulation** —
   never warn-and-continue.
2. The session kernel includes `dmath.algorithm` in its session config; a
   client with a different algorithm is refused at join, the same way
   protocol versions gate today.
3. If a future algorithm revision is ever needed (accuracy fix), it ships as
   `dmath-2` alongside `dmath-1` — both constructible via
   `createDmath({ algorithm })`; old replays re-verify with the algorithm
   they recorded. Algorithm ids are append-only, never edited.

### Product selection surface

Products build a backend at boot and inject an immutable context per session
via `createDmath` (§3); there is no global setter. Where the *choice* lives
is product policy — for TabletopLabs, the natural home is the module
manifest (e.g. `math: { backend: 'js' | 'wasm' }` beside `resolver.mode`),
letting each game declare what it needs; the platform builds the backend at
session boot and stamps `dmath.algorithm` into the session config. Games
that never call dmath declare nothing and load nothing.

### Future scope (explicitly deferred)

Compiling entire hot mechanisms (solver, large-board pattern scans) to WASM
is a separate decision with its own RFC if profiling ever justifies it; this
RFC only covers the math substrate.

## 5. Test plan

- Golden vectors: fixed input set (including ±0, denormals, near-π multiples,
  and huge arguments) → exact expected bit patterns. CI runs the JS backend on
  Node 20.3/22, Chromium 151 (V8), Firefox 153 (SpiderMonkey), WebKit 26.5
  (JavaScriptCore), and workerd 1.20260724.1.
- Property tests: accuracy within the documented ulp bounds versus the
  independent 512-bit integer oracle. The reproducible evidence sample is
  2,048 deterministic inputs; the unit suite adds boundary and seeded samples.
- Session mixing test: two clients on different backends + kernel complete a
  session with digest agreement at every checkpoint.
- Replay: artifacts record `{ backend, algorithm }`; an unconstructible
  recorded algorithm aborts verification before simulation.

## 6. Open questions

1. Argument-range reduction policy for huge angles (|x| > 2^30): document
   precision cliff vs pay for Payne–Hanek reduction. Proposal: document the
   cliff; game code has no business feeding astronomical angles.
2. Should `fixed` (Q16.16) ship in v0.19 or wait for a consumer? Proposal:
   wait — whitelist + dmath cover the known needs.
3. Lint rule distribution: docs-only list vs a published ESLint config.
   Proposal: docs list in v0.19, ESLint package if a third product asks.

---

## 7. Review notes and requested revisions (2026-07-25)

### Disposition

Approve the need for deterministic-math doctrine and a shared implementation.
Request revision before implementation. A small, frozen JS implementation is
credible; the full proposed API and interchangeable global backend contract
are not yet sufficiently bounded to promise bit identity forever.

### Required revisions

#### 1. Make the whitelist complete and distinguish value determinism from bits

The implementation-approximated list must also include:

```text
Math.acosh Math.asinh Math.atanh Math.cosh Math.expm1 Math.log1p
Math.sinh Math.tanh
```

Add `Math.random` to the state-path CI ban even though it is not a
transcendental. Consider generating the lint list from one normative exported
constant so the documentation, tests, and product checks cannot drift.

`Math.sqrt` may remain on the exact side: current ECMAScript defines its
finite result as the Number value of the mathematical square root. The
document should nevertheless distinguish equal numeric results from equal
raw NaN payload bits. JavaScript treats NaN as a numeric category; a promise
about serialized or typed-array bit patterns is stronger.

Also decide whether this is an exhaustive allowlist or only examples of safe
operations. If exhaustive, include other specified helpers that products may
reasonably use, such as `Math.min`, `Math.max`, `Math.sign`, and `Math.clz32`,
or explicitly classify them elsewhere.

#### 2. Narrow the v0.19 implementation surface

Start with the functions required by a demonstrated consumer:

```ts
sin(x: number): number;
cos(x: number): number;
atan2(y: number, x: number): number;
clamp(x: number, lo: number, hi: number): number;
roundTo(x: number, decimals: number): number;
```

For every function, specify:

- accepted finite domain and behavior for NaN, infinities, and signed zero;
- argument-reduction range;
- absolute, relative, or ULP accuracy target by range;
- exact result conventions at important boundary values; and
- whether out-of-contract input throws, clamps, or returns a canonical value.

An across-the-board `≤ 2 ulp` promise for `tan`, inverse functions, `exp`,
`log`, and general `pow` is a numerical-library project, especially when huge
argument reduction is explicitly allowed to lose precision. Add functions
only with golden vectors, a high-precision oracle, and a real consumer.

Keep Q16.16 deferred. If it is later added, define range, overflow,
saturation/wrapping behavior, and intermediate precision; JavaScript integer
values cease to be exact beyond the safe-integer range.

#### 3. Replace the global mutable backend with immutable math contexts

`setDmathBackend()` creates process-global gameplay state. It prevents safe
concurrent sessions using different algorithm versions and makes historical
replay verification dependent on whichever backend was installed most
recently.

Prefer an immutable factory:

```ts
export interface Dmath {
  readonly algorithm: string;
  readonly backend: 'js' | 'wasm';
  sin(x: number): number;
  // ...
}

export function createDmath(options?: {
  algorithm?: 'dmath-1';
  backend?: DmathBackend;
}): Dmath;
```

The selected instance is injected into a reducer/session or captured by a
versioned adapter. It must be frozen before initialization and must not change
during play. Old algorithm implementations must remain explicitly
selectable for as long as the SDK claims to verify their replays.

#### 4. Tighten the JS/WASM bit-identity contract

WebAssembly normally permits more than one NaN sign/payload result. Exact
golden bit patterns therefore require one of:

- rejecting non-finite state-path inputs and outputs;
- canonicalizing every NaN at the public boundary; or
- requiring and verifying a WebAssembly deterministic profile everywhere.

The first or second option is the more portable initial contract. Golden
vectors should still cover NaN and infinities, but compare the canonicalized
public result promised by the API.

Document compiler constraints for the WASM module: no fast-math,
reassociation, implicit fused operations, relaxed SIMD, or external libm
whose implementation can change independently. Preserve coefficients and
operation order in auditable source, and make the generated binary
reproducible.

Bit identity should be demonstrated before describing JS and WASM backends as
mixable. Performance should also be benchmarked first; scalar JS-to-WASM call
overhead may erase the expected advantage for individual math calls.

#### 5. Make replay algorithm selection authoritative

Recording `{ backend, version }` in `ReplayHeader.extensions` is useful
diagnostic metadata, but a version mismatch cannot merely warn if math affects
state. Replay verification must select the exact recorded algorithm or fail
before simulation. Backend identity may remain informational only after both
backends have passed the same bit-vector suite.

Define how `recheckReplayArtifact` obtains historical math implementations.
The current reducer resolver selects only a game adapter and level; either the
adapter version fully pins dmath or the resolver context must expose a
validated dmath algorithm identifier.

Clarify whether `dmath-2` can coexist with `dmath-1` inside one installed SDK
package and how long old versions remain supported. "Append-only" requires an
API for selecting the historical implementation, not only retaining its
source internally.

#### 6. Correct the CSP and packaging claim

Embedding the WASM binary removes a network fetch but does not make
instantiation universally CSP-friendly. A page whose `script-src` or
`default-src` omits `'wasm-unsafe-eval'` and `'unsafe-eval'` may block
WebAssembly compilation. Document this deployment requirement and guarantee
that products can fall back to the JS backend without changing algorithm
results.

Specify the browser and server runtime matrix for both backends, including the
minimum V8, JavaScriptCore, SpiderMonkey, Node, and workerd versions actually
tested. The package currently promises Node `>=20.3`; CI claims should name
how JSC and browser coverage will be run.

### Questions to resolve

1. Which concrete algorithm is the starting point: a clean-room polynomial,
   a suitably licensed fdlibm-derived implementation, or another published
   reference? Record coefficient provenance and licensing.
2. Are non-finite numbers forbidden in deterministic reducer state? Wire JSON
   already cannot represent them, but in-memory state currently has no
   equivalent universal guard.
3. Is dmath version part of the game adapter version, an independent replay
   compatibility dimension, or both? Avoid two sources of truth.
4. What evidence would justify the v0.20 WASM backend: measured call volume,
   batch API design, or a minimum speedup on named workloads?
5. Must `roundTo` support negative decimal positions, and what tie rule does
   it use? Decimal scaling through `10 ** decimals` would itself call an
   implementation-approximated operation unless the implementation avoids
   native exponentiation for nontrivial cases.
6. Should product CI scan only direct `Math.*` calls, or also imported
   libraries and aliases such as `const sin = Math.sin`? A string list is a
   useful first hint but not an enforcement boundary.

---

## 8. Revision 2 — author response and revised normative text

All six required revisions are **accepted**. Revised contracts below
supersede §§2–4 where they differ.

### R1. Whitelist: complete, normative, and value-vs-bits precise

- One exported constant is the single source of truth; docs, tests, and
  product lint derive from it:

```ts
export const STATE_MATH = {
  exact: ['+', '-', '*', '/', '%', 'Math.sqrt', 'Math.abs', 'Math.floor',
    'Math.ceil', 'Math.round', 'Math.trunc', 'Math.sign', 'Math.min',
    'Math.max', 'Math.fround', 'Math.imul', 'Math.clz32'],
  forbidden: ['Math.sin', 'Math.cos', 'Math.tan', 'Math.asin', 'Math.acos',
    'Math.atan', 'Math.atan2', 'Math.exp', 'Math.expm1', 'Math.log',
    'Math.log1p', 'Math.log2', 'Math.log10', 'Math.pow', 'Math.hypot',
    'Math.cbrt', 'Math.sinh', 'Math.cosh', 'Math.tanh', 'Math.asinh',
    'Math.acosh', 'Math.atanh', 'Math.random'],
} as const;
```

- The list is **exhaustive for `Math`**; anything not listed is forbidden on
  state paths until classified.
- Determinism promise is stated as **value determinism**: equal Number
  values, with NaN treated as one category. Raw NaN payload bits are
  explicitly out of contract; state serialization must never depend on them.
  Corollary (answers Q2): **non-finite values are forbidden in reducer
  state** — wire JSON cannot carry them; `dmath` functions canonicalize
  out-of-domain results per R2 instead of returning NaN/Infinity surprises.

### R2. v0.19 surface narrowed to the demonstrated consumer

Ships exactly: `sin`, `cos`, `atan2`, `clamp`, `roundTo` (TabletopLabs
quaternion/snap-angle path is the consumer). Per-function contract table
(domain, NaN/∞/±0 behavior, reduction range, per-range accuracy bound,
boundary values, out-of-contract policy) is a merge blocker for each
function. Specifics:

- `sin`/`cos`: domain |x| ≤ 2^30; beyond → throws `RangeError` (out-of-domain
  is a programming error, not a value). Reduction documented; target ≤ 1 ulp
  on |x| ≤ 2π, ≤ 2 ulp elsewhere in domain.
- `atan2`: full finite domain; IEEE special-quadrant conventions enumerated;
  non-finite input throws.
- `clamp`: exact by construction; `lo > hi` throws.
- `roundTo`: decimals ∈ [-15, 15] integer; scaling uses the exact-power
  table 10^0…10^15 in both directions (no `**`, answers Q5); tie rule:
  half-away-from-zero, documented with boundary vectors.
- `tan`, inverses, `exp`, `log`, `pow`, `fixed` — deferred until a consumer
  plus oracle-backed golden vectors exist (per review).

### R3. Immutable math contexts replace the global backend

`setDmathBackend` is withdrawn. Adopted contract:

```ts
export interface Dmath {
  readonly algorithm: 'dmath-1';       // append-only union over time
  readonly backend: 'js' | 'wasm';
  sin(x: number): number; cos(x: number): number;
  atan2(y: number, x: number): number;
  clamp(x: number, lo: number, hi: number): number;
  roundTo(x: number, decimals: number): number;
}
export function createDmath(options?: {
  algorithm?: 'dmath-1';
  backend?: DmathBackend;              // default: built-in JS
}): Dmath;                             // frozen instance
```

Instances are frozen, injected per session/reducer, and never mutate during
play. Every shipped algorithm version remains constructible for as long as
the SDK claims to verify replays that recorded it (answers the append-only
question concretely: selection API, not just retained source).

### R4. WASM: bit-identity preconditions and evidence gate

- Public-boundary contract: state-path inputs must be finite (throw
  otherwise); every public result is canonicalized (no NaN escapes), so
  golden vectors compare canonical values — the WASM multi-NaN issue is
  excluded at the boundary rather than papered over.
- Build constraints recorded in-repo: no fast-math, no reassociation, no
  implicit FMA, no relaxed SIMD, no external libm; coefficients and op order
  live in auditable source; binary build is reproducible.
- "Mixable backends" is **not claimed until** the shared bit-vector suite
  passes on the runtime matrix (below), and v0.20 work does not start until
  the evidence gate is met (answers Q4): a named product workload with
  measured per-tick call volume where batched WASM shows ≥2× over JS —
  scalar call-overhead reality acknowledged; a batch API
  (`sinInto(dst, src)`) is designed before the backend, not after.

### R5. Replay algorithm selection is authoritative

- `gaos.replay` records the dmath **algorithm** as a compatibility dimension
  (backend stays diagnostic). Verification **fails before simulation** if the
  recorded algorithm cannot be constructed; no warn-and-continue.
- `ReplayReducerContext` gains the validated algorithm id so the reducer
  resolver receives a ready `Dmath` instance; the adapter version may
  additionally pin it, but the header field is the single verification
  source (answers Q3: independent dimension, adapter pin optional).

### R6. CSP and runtime matrix corrected

The embedded-binary claim is amended: WASM compilation requires
`'wasm-unsafe-eval'` (or `'unsafe-eval'`) in CSP; documented as a deployment
requirement, with the guarantee that falling back to the JS backend never
changes results (same algorithm id). Tested-runtime matrix (minimum V8,
JSC, SpiderMonkey, Node, workerd versions; how JSC/browser CI runs) becomes
part of the v0.19 test plan deliverable, not an afterthought.

### Answers to remaining review questions

- **Q1 (original provenance plan, superseded by §13):** this revision proposed
  clean-room minimax polynomials generated by Sollya/Remez. The shipped
  implementation instead uses the reproducible clean-room Taylor/factorial
  construction and independent Machin-derived constants documented in §3 and
  §13. No fdlibm derivation is present.
- **Q6 (lint scope):** the string list is a hint, not an enforcement
  boundary — documented as such. Enforcement is golden digests and review;
  products wanting more can alias-ban via their own AST lint. The SDK does
  not promise static enforcement.

---

## 9. Second review after Revision 2 (2026-07-25)

### Disposition

Revision 2 resolves the original review: the v0.19 surface is appropriately
narrow, math contexts are immutable and version-selectable, non-finite values
are excluded from state paths, replay selection is authoritative, WASM is
evidence-gated, and the CSP/runtime claims are now accurate.

Conditionally approve RFC-007 after R7 below and editorial consolidation.
The numerical accuracy promises remain implementation acceptance criteria:
they are not considered proven until the per-function contract tables,
generated coefficients, cross-runtime bit vectors, and oracle tests exist.

### R7. Classify deterministic `Math` constants

R1 says its list is exhaustive for `Math` and forbids anything not listed, but
it classifies methods only. That implicitly forbids deterministic constants
such as `Math.PI`, `Math.E`, `Math.LN2`, and `Math.SQRT2` without saying
whether this is intentional.

Add an explicit constant classification:

```ts
export const STATE_MATH = {
  constants: [
    'Math.E',
    'Math.LN2',
    'Math.LN10',
    'Math.LOG2E',
    'Math.LOG10E',
    'Math.PI',
    'Math.SQRT1_2',
    'Math.SQRT2',
  ],
  exact: [
    // existing method/operator list
  ],
  forbidden: [
    // existing implementation-approximated/random list
  ],
} as const;
```

If state code should use dmath-owned frozen constants instead, say so and
place the native constants in `forbidden`. Either policy is deterministic;
the contract must make it deliberate.

The per-function table for `roundTo` must also bound intermediate scaling.
Finite `x` and a valid decimal count do not guarantee that `x * scale`
remains finite or retains meaningful integer precision. Define the supported
magnitude and throw before an out-of-contract intermediate result.

### Editorial integration request

Fold the accepted §8 contracts into §§2–5 and withdraw the original global
`setDmathBackend`, broad function surface, universal `≤ 2 ulp` claim, and
"CSP-friendly" wording from the normative body. Retaining both versions with
a supersession note is useful history but creates avoidable implementation
ambiguity.

---

## 10. Revision 3 — response to second review

### R7 accepted: constants classified; roundTo intermediate bound

- `STATE_MATH` gains a `constants` category listing the eight native `Math`
  constants as **allowed** on state paths: their values are fixed by the
  ECMAScript spec (exact double literals), so they are deterministic
  everywhere; dmath does not duplicate them. The exhaustiveness rule now
  reads: every `Math` member is classified into exactly one of
  `constants` / `exact` / `forbidden`; unlisted future additions to `Math`
  are forbidden until classified.
- `roundTo` contract tightened: in addition to `decimals ∈ [-15, 15]`, the
  intermediate `|x| · 10^decimals` must be `< 2^53`; otherwise `RangeError`
  is thrown **before** any scaling occurs. This bounds precision loss and
  makes out-of-contract inputs loud rather than silently degraded.

### Editorial consolidation done

§§2–4 now carry the adopted contracts directly (narrowed surface, immutable
`createDmath`, NaN/finite-boundary rules, evidence-gated WASM, corrected CSP
wording); the withdrawn `setDmathBackend`, broad surface, and universal
"≤ 2 ulp" text no longer appear in the normative body. §§7–9 remain as
design history. Header note marks accuracy promises as acceptance criteria
pending contract tables, generated coefficients, cross-runtime bit vectors,
and oracle tests.

---

## 11. Third review after Revision 3 (2026-07-25)

### Disposition

R7 is resolved: constants are classified and `roundTo` now has a bounded
intermediate domain. The narrowed immutable JS API in §3 is coherent.

Revision requested because the claimed editorial consolidation is incomplete.
The normative §4 still contradicts the adopted §8 contracts in three places.

### Required normative corrections

1. **Evidence gate:** §4 currently says both backends produce bit-identical
   outputs and are mixable. Replace that claim with §8-R4's rule: the WASM
   backend does not ship and mixability is not claimed until the shared
   bit-vector suite passes across the named runtime matrix and the product
   workload satisfies the performance gate.
2. **Replay behavior:** replace
   `ReplayHeader.extensions.dmath = { backend, version }` plus
   warn-on-version-mismatch with `{ backend, algorithm }`, where backend is
   diagnostic and failure to construct the recorded algorithm aborts
   verification before simulation. Use `algorithm`, not the otherwise
   undefined `version`, consistently.
3. **Selection API:** remove the remaining `setDmathBackend` product-selection
   paragraph. Products create a backend at boot and inject an immutable
   `Dmath` instance with `createDmath`, as already shown in §4's architecture
   example.

The motivation's abbreviated implementation-approximated list should either
include all members classified in `STATE_MATH.forbidden` or explicitly label
it as examples. Otherwise it reintroduces the incomplete-list problem that R1
resolved.

Move the complete eight-entry constants list into normative §2 rather than
requiring implementers to reconstruct it from the historical §9 example and
§10 response.

Finally, avoid calling the decimal scale table "exact" without qualification:
positive powers through `10^15` are exactly representable integers, but their
reciprocals generally are not exact binary values. The contract is a frozen,
deterministic binary64 rounding algorithm—not exact decimal arithmetic.

### Approval condition

RFC-007 can be marked design-approved when the contradictory §4 paragraphs
are replaced and the current review banner is consolidated. Numerical
accuracy remains gated by implementation evidence as the header correctly
states.

---

## 12. Final design review (2026-07-25)

### Disposition: approved for implementation

Revision 4 resolves the remaining normative contradictions:

- the complete `Math` classification is normative;
- the v0.19 surface is narrow and consumer-driven;
- dmath contexts and historical algorithms are immutable and selectable;
- non-finite state-path values are rejected;
- decimal rounding is described as a deterministic binary64 algorithm;
- WASM mixability is an evidence-gated future claim;
- replay aborts when the recorded algorithm cannot be constructed;
- backend selection uses `createDmath`, with no global setter; and
- CSP/runtime limitations are explicit.

This approval is for the design, not an assertion that the numerical
implementation already meets its targets. The following remain merge gates:

1. per-function domain and boundary tables;
2. reproducible coefficient-generation source and provenance;
3. oracle-backed accuracy tests;
4. exact golden bit vectors across the named JS runtimes; and
5. for any later WASM backend, cross-backend vectors plus the stated product
   performance gate.

If those tests expose an algorithm change, assign a new append-only algorithm
ID rather than editing `dmath-1`.

---

## 13. Revision 5 — implementation evidence closure (2026-07-25)

The round-two implementation review found cancellation in the original fast
range-reduction path near multiples of π. Before the first v0.19 publication,
that path was replaced by the independently generated 256-bit reduction for
every input outside the direct kernel interval. The near-π vectors were then
regenerated from the corrected implementation.

`dmath-1` is a release-candidate algorithm until the v0.19 tag is published;
the tag is its first public freeze point. The pre-release `roundTo` correction
and range-reduction correction therefore do not mutate a published algorithm.
After that tag, the append-only rule in §4 applies without exception.

All JS implementation gates from §12 are now executable in the repository:

1. the normative per-function table is in §3;
2. the generator reproduces the Taylor coefficients and Machin-derived
   fixed-point constants;
3. measured bit-distance maxima across the reproducible 512-bit-oracle sample
   are 1 ulp (`sin`), 1 ulp (`cos`), and 2 ulp (`atan2`); these observed
   values are evidence within the normative per-range bounds, not a
   redefinition of classical real-error ulps;
4. Node, Chromium, Firefox, WebKit, and workerd run the same frozen vectors;
   and
5. WASM remains unshipped and subject to its separate evidence and performance
   gates.
