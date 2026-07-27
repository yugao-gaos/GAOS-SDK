# Terminology

GAOS uses a small set of terms consistently across the SDK and its
documentation.

## Product language

| Term | Meaning |
| --- | --- |
| **Game-as-a-Benchmark** | A playable, versioned game used as an evaluation environment, where humans and agents share authoritative rules and scored runs can carry portable verification evidence. The benchmark operator still owns tasks, scoring meaning, held-out content, and capability claims. |
| **agent-playable** | The game exposes structured observations and canonical actions that an agent can use without UI automation. This is the SDK's primary promise. |
| **agent-ready** | The game keeps one authoritative reducer and can add agent play later without rebuilding its rules. |
| **agent** | Any policy that chooses an action: a script, search algorithm, model, CLI process, or person acting through an adapter. |
| **model provider** | A service that performs model inference. Providers are optional integrations, not part of the game rules. |
| **AI** | Broad product language. Technical pages use the more precise terms *agent* and *model provider*. |
| **Arena** | A hosted product integration built on the protocol. Arena behavior, matchmaking, authentication, and hosting are not generic SDK guarantees. |

## Simulation and evidence

| Term | Meaning |
| --- | --- |
| **tick** | One deterministic reducer step. A turn-based game may use one tick per player turn; a real-time game may advance ticks at a fixed rate. |
| **turn** | A product-level gameplay concept. A product may implement turns using ticks; the SDK does not define turn behavior. |
| **deterministic** | Reproducible given the same SDK and game versions, initial state or seed, and canonical action sequence. It does not mean that hidden information or player choices are predictable. |
| **transcript** | A versioned record of an environment episode, including actions and results. |
| **portable replay** | A `gaos.replay` artifact whose schema and canonical JSONL bytes can be parsed and validated across supported languages. |
| **rechecked replay** | A portable replay whose actions have also been executed again through the pinned historical game reducer. Rechecking requires that reducer and authored content; schema validation alone does not prove the game result. |

Human clients and agent adapters may present different interfaces. They remain
comparable when both submit the same canonical action semantics to the same
authoritative reducer.
