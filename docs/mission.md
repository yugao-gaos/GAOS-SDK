# Mission: Game-as-a-Benchmark

**Game-as-a-Benchmark turns a playable game into a versioned evaluation
environment whose exact runs can be inspected and independently checked.**

GAOS exists to make that category practical for both game developers and
benchmark builders.

## Why games

Static tests measure isolated answers. Games measure sequences of decisions
under changing state. Plans create consequences; hidden information creates
uncertainty; other participants create cooperation and competition.

A useful game benchmark can combine planning, memory, spatial reasoning,
resource management, tool use, communication, and adaptation inside one causal
environment. People can play the same task, making success and failure easier
to interpret than an abstract score alone.

Games also produce inspectable evidence. A deterministic environment can record
each observation, legal action, submitted command, state transition, and
outcome. The result can then be diagnosed or checked without asking the agent
to behave the same way again.

## What makes a game a benchmark

A Game-as-a-Benchmark product combines:

```text
versioned environment + task suite + action protocol + metrics + run evidence
```

The product owns the authored environment, tasks, scoring meaning, held-out
content, and capability claims. GAOS supplies reusable mechanisms and common
contracts for deterministic execution, agents, sessions, evidence, and
verification.

People may use a rendered client while agents use structured observations.
Both must reach the same product-owned reducer and produce the same canonical
actions. This avoids separate human and agent rule implementations drifting
apart.

## Why verification matters

A leaderboard entry is a claim about an expensive run. Reproducing an
evaluation repeats the inference cost and produces a new sample; it does not
check the original.

GAOS instead preserves the exact reducer inputs and their authorship evidence.
Verification re-simulates the recorded run through the matching historical
reducer and semantic adapter. It checks what happened without re-running the
model.

This promise has an explicit availability boundary:

- the product chooses whether to export and publish its historical verifier;
- GAOS defines the evidence and verifier interfaces;
- an independent authority decides which verifier digest it trusts; and
- unavailable historical code produces `unverifiable`, not a false success.

v0.25 supports both explicitly supplied pinned adapters and product-owned,
content-addressed verifier kits with SDK-managed packing, inspection,
resolution, caching, and restricted execution.

## Why support different game cadences

Sequential turns, simultaneous WEGO, and fixed-rate play test different
abilities. WEGO emphasizes prediction because participants choose from the
same snapshot before intentions resolve together. Sequential play makes
initiative explicit. Real-time play can measure rapid adaptation.

GAOS supports all three through deterministic ticks and canonical input
ordering. The product chooses the cadence appropriate to its game and its
evaluation claim.

## Credible evaluation principles

1. Use one product-owned reducer for people, agents, and verification.
2. Expose concrete legal actions rather than undocumented command syntax.
3. Version rules, tasks, content, seeds, and evaluation conditions.
4. Publish outcomes with evidence of the exact run.
5. Evaluate across tasks and seeds, including held-out variations.
6. State what the score measures and what it does not.
7. Preserve the historical verifier needed to check published results.

## What GAOS does not claim

Performance in a game is evidence about that environment. It is not automatic
proof of general intelligence, safety, or competence elsewhere.

GAOS does not define a universal intelligence score. It helps products build
interactive evaluations whose rules, behavior, and evidence are explicit
enough to inspect, compare, and challenge.

[See the ownership boundary →](/architecture) ·
[Build an agent environment →](/agentic-play) ·
[Understand verification →](/trust-and-verification)
