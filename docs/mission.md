# Mission: games as shared benchmarks

## Our mission

**GAOS exists to make interactive games a shared, inspectable proving ground
for human and machine intelligence—where both reach the same authoritative
rules, face the same consequences, and can be compared through reproducible
play rather than persuasive outputs alone.**

We want developers to be able to build games that are enjoyable for people,
playable by agents without UI automation, and rigorous enough to reveal how a
system plans, adapts, cooperates, competes, and recovers from mistakes.

That requires more than exposing a model API. The environment must provide
clear observations and legal actions, deterministic resolution, versioned
rules, measurable outcomes, and replayable evidence. GAOS supplies those
reusable foundations while each game retains its own world, content, and
meaning.

## The bridge

GAOS serves two creator communities through the same technical core:

- researchers and benchmark creators get a quick start on interactive
  environments, agent execution, deterministic evidence, and reusable game
  mechanisms; and
- game developers get reusable rules that remain ready for AI opponents,
  autonomous play, solvers, verified competition, and research use.

The SDK does not decide what an integrating benchmark measures. Capability
claims, authored tasks, scoring meaning, human analytics, held-out evaluation,
publication, and commercial policy remain the responsibility of that benchmark
product. GAOS makes those products faster to build and easier to interoperate.

## What we mean by a benchmark

A useful game benchmark is not one level, one model score, or one leaderboard.
It is a versioned evaluation system:

```text
environment + task suite + action protocol + metrics + replay evidence
```

The environment defines what can happen. The task suite samples different
skills and situations. The protocol gives every participant the same legal
interface. Metrics summarize outcomes, while transcripts preserve the evidence
needed to understand how those outcomes were produced.

Scores are useful, but they are not sufficient. A strong benchmark also makes
failure legible: Did the agent misunderstand the board, choose an illegal
action, predict another actor incorrectly, waste resources, fail to adapt, or
find a valid but inefficient plan?

The portable unit of evidence is an SDK-owned replay, not a platform-specific
database row. A creator platform can emit the same `gaos.replay` JSONL as a
hosted Arena run, allowing either result to be parsed, routed to its pinned
historical reducer, and verified by shared tooling. That is the benchmark
mission in operational form: a game authored in one product can be checked by
independent, protocol-compatible tooling.

## Why games are a good approach

### They measure behavior over time

A static question measures one response. A game measures a sequence of choices
under changing state. Early decisions constrain later options, mistakes carry
consequences, and success depends on maintaining a coherent strategy rather
than producing one plausible answer.

### They combine capabilities naturally

One compact scenario can require spatial reasoning, planning, memory, resource
management, tool use, communication, uncertainty, cooperation, and adaptation.
These abilities interact inside one causal environment instead of being scored
as unrelated test questions.

### Humans and agents can share the same task

When both reach the same rules and canonical action semantics, human play
provides an interpretable reference rather than a separate benchmark. We can
compare not only final score, but efficiency, consistency, recovery, strategy
diversity, and the kinds of errors each participant makes.

The interface may differ—a person can use a rendered client while an agent uses
structured observations—but both must reach the same authoritative reducer and
produce the same canonical actions.

### Games are repeatable without being static

Seeds, authored variations, hidden information, different opponents, and new
levels can create many controlled situations from one ruleset. This supports
repeat trials and held-out evaluation without reducing the benchmark to a
fixed answer sheet.

### They produce inspectable evidence

Every tick can be recorded as an observation, legal-action set, chosen action,
state transition, event trace, and outcome. Deterministic replay lets a judge
or developer reproduce a run, audit a surprising result, and compare agents
under identical conditions.

### They can remain worth playing

A benchmark that is also a game has a continuing source of difficult,
human-legible tasks. Designers can create new mechanics and scenarios; players
can expose strategies and edge cases; agents can be evaluated on the same
evolving challenges. Enjoyment does not guarantee scientific validity, but it
helps the environment stay alive rather than becoming a solved worksheet.

## Why use structured game state

Benchmarks need stable identities and exact transitions, not necessarily a
square grid. GAOS models state through typed actions and named containers:
boards, graph nodes, decks, hands, bags, queues, and slots. This makes an
observation independent of rendering quality, screen resolution, input timing,
and computer-vision noise.

Different containers expose different reasoning:

- square and hex boards measure spatial planning, collision, fields, and line
  of sight;
- graph boards measure routing, territory, and network reasoning;
- decks, hands, and bags measure uncertainty, memory, sequencing, and risk;
- hidden roles and seat-scoped views measure inference and communication;
- hybrid games test plans that cross several representations.

Structured does not mean simple. Partial observability, simultaneous actors,
dynamic terrain, multi-card response stacks, resource contention, portals, and
long settlement chains create deep planning problems while preserving an exact
authoritative state.

The renderer can remain expressive for people. The benchmark core remains a
deterministic state machine that a server, solver, replay checker, and agent can
all execute without reproducing the visuals.

## Why simultaneous WEGO play

Sequential turn-taking gives the later actor information about the earlier
actor's committed move. Real-time play often measures reaction speed, network
latency, hardware, and input throughput alongside reasoning. Simultaneous
turn-based play occupies a useful middle ground: everyone chooses from the same
snapshot, then the world resolves those intentions together.

```text
shared observation
       ↓
participants choose independently
       ↓
intents close for the turn
       ↓
deterministic simultaneous resolution
       ↓
same-turn consequences settle
       ↓
next shared observation
```

### It tests prediction, not response order

An actor cannot simply wait to see the opponent's committed move. It must model
what others may do, reason about collisions or cooperation, and choose an action
that remains sensible across plausible outcomes.

### It removes speed as an accidental advantage

Humans and models may need very different amounts of deliberation. A bounded
turn window lets each participant think before submitting, while the result is
independent of who sent an HTTP request a few milliseconds earlier.

### It makes concurrency fair and explicit

All intents qualify against one turn snapshot. Contested destinations,
resources, swaps, and interactions are resolved by documented rules rather than
server arrival order. No participant gains initiative accidentally from process
scheduling or network geography.

### It creates richer multi-agent reasoning

Simultaneous choices expose coordination, trust, signaling, competition,
conflict avoidance, and opponent modeling. Even deterministic movement can
produce meaningful uncertainty because another participant's intent is unknown
when the choice is made.

### It remains reproducible

Turn inputs are finite and canonical. The engine can resolve movement and then
settle every induced collision, switch, pickup, gate, projectile, or transport
effect through deterministic waves before publishing the next observation. The
complete turn can be traced and replayed without reproducing wall-clock timing.

## Comparison

| Property | Real-time | Sequential turns | Simultaneous turns |
|---|---|---|---|
| Reaction speed affects results | Often | Rarely | No, within the turn limit |
| Later actor sees earlier action | Continuously | Yes | No |
| Request order can create advantage | Often | Defined by turn order | No |
| Opponent prediction is required | Mixed | Reduced for later actor | Central |
| Exact replay is straightforward | Difficult | Yes | Yes |
| Slow model participation | Awkward | Natural | Natural |
| Concurrent conflict is explicit | Timing-dependent | Mostly absent | Core mechanic |

Simultaneous turns are not universally better. Real-time games are appropriate
when motor control and rapid adaptation are the capability being tested;
sequential turns are appropriate when initiative order is part of the design.
GAOS supports all three cadences: sequential turn-based play, simultaneous WEGO
play, and fixed-tick real-time simulation. They share the same deterministic
reducer, lockstep ordering, rollback, and replay foundations; the product
chooses the cadence that matches what it intends to build or evaluate.

## Principles for credible evaluation

GAOS encourages benchmark authors to:

1. **Use one authoritative reducer.** Human clients, model agents, solvers, and
   replay checks must not implement approximations of the rules.
2. **Expose concrete legal actions.** Do not score agents mainly on guessing an
   undocumented command syntax.
3. **Version rules and content.** A score is meaningful only with the exact
   environment version that produced it.
4. **Separate outcome from evidence.** Keep scores for comparison and complete
   transcripts for diagnosis.
5. **Evaluate across tasks and seeds.** One level or lucky run is not a robust
   measure.
6. **Keep held-out challenges.** Public examples teach the interface; unseen
   variations test transfer rather than memorization.
7. **Report efficiency and failure modes.** Wins alone hide waste, brittleness,
   invalid actions, and inconsistent planning.
8. **State comparison conditions.** Use the same rules, seeds, action budget,
   and settlement policy for every candidate. When interfaces or observations
   differ by participant type, document those differences instead of claiming
   strict equivalence.

## What GAOS does not claim

Performance in a game is evidence about performance in that environment. It is
not, by itself, proof of general intelligence, real-world safety, or competence
in unrelated domains. Any benchmark can reward narrow optimization, contain
design bias, or become saturated.

The goal is therefore not to produce one universal intelligence number. The
goal is to make interactive evaluation easier to build, reproduce, inspect,
extend, and compare—so claims about agent capability rest on observable
behavior and replayable evidence.

Continue with the [architecture map](/architecture), the
[mechanism reference](/mechanisms/), or [agentic play](/agentic-play).
