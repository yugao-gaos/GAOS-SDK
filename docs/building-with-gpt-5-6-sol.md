# Building GAOS and Zonoid with GPT-5.6 Sol

We used **OpenAI GPT-5.6 Sol** as a production collaborator across the full
development loop: concepting, asset direction, engineering, review, publishing,
and playtesting. The result is Gaming AGI Open SDK, now a composable SDK for
deterministic, verifiable games, and [Zonoid](https://zonoid.ai), its first
game and a live, sign-in-gated preview.

This was not a one-prompt generation process. Sol worked through bounded tasks,
inspected the current product state, produced or revised artifacts, ran checks,
and responded to human review. We retained the consequential gates: product
direction, visual taste, intellectual-property decisions, credentials, licensing,
and approval to publish.

OpenAI describes [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)
as a model for complex professional work with access to tools including image
generation, web search, hosted shell execution, patching, and MCP. In our
workflow, Sol coordinated those tools and production systems; the image model
performed the actual image generation and editing.

## The production loop

| Phase | How we used Sol | Output |
| --- | --- | --- |
| Concept | Developed game, character, mechanic, and world directions through iterative image generation and editing | Approved concept images and visual briefs |
| Production | Translated a selected concept into prompts and jobs for specialist media and 3D systems | Video, world, and model candidates |
| Review | Compared results with the brief, identified mismatches, and revised prompts, assets, or implementation | Traceable review-and-revision cycles |
| Engineering | Implemented and refactored both Zonoid and the reusable GAOS SDK | Product code, engine mechanisms, agent interfaces, and tests |
| Publishing | Authored documentation and presentation websites, configured build workflows, and checked production output | Release-ready packages and web artifacts |
| Testing | Ran conventional checks and let language-model agents play through the same legal-action interface as other clients | Test results, transcripts, replays, and behavioral findings |

## 1. Concepting with image generation and editing

Sol was particularly effective at turning an early idea into something we could
evaluate visually. We used it to explore characters, environments, mechanics,
camera language, and interface direction, then edited the strongest concepts
instead of restarting on every revision.

That distinction matters: the concept image became a shared production
reference, not disposable inspiration. OpenAI's
[image-generation guidance](https://learn.chatgpt.com/docs/image-generation)
describes how Sol can direct image creation and editing while an image model
renders the result. We used that separation deliberately: Sol maintained the
brief and revision history while the image tool produced the pixels.

## 2. Driving specialist production from the concept

Once a concept was approved, Sol turned it into structured instructions for the
specialist system needed by each medium:

```text
Product brief
    -> approved concept image
        -> Seedance: motion and video
        -> World Labs Marble: persistent spatial world
        -> Tripo: 3D model candidate
    -> review against the original brief
    -> revise or approve
```

- [ByteDance Seedance](https://seed.bytedance.com/en/seedance) accepts text and
  images for multi-shot video generation. Sol used the approved image to keep
  subject, visual language, and motion direction grounded across video prompts.
- [World Labs Marble](https://docs.worldlabs.ai/) creates persistent 3D worlds
  from text, images, video, and 3D structures. Sol translated the concept into
  spatial and environmental instructions rather than treating the image as a
  flat backdrop.
- [Tripo](https://docs.tripo3d.ai/) generates high-fidelity 3D models from text
  or images. Sol prepared model requests and reviewed the resulting candidates
  against the silhouette and design constraints in the concept.

Specialist generators remained responsible for their medium. Sol's role was to
carry intent between systems, preserve constraints, inspect results, and drive
the next revision.

## 3. Autonomous review and revision, with human gates

For each bounded task, Sol could inspect its own output, run the relevant check,
and revise without waiting for a person to point out every local issue. That
included correcting visual drift, fixing code after a failed test, tightening
documentation, and rechecking links or builds after a change. OpenAI's
[Codex best practices](https://learn.chatgpt.com/guides/best-practices) emphasize
the same test, check, confirm, and review loop.

Autonomous did not mean unsupervised or unlimited. We set the objective and
repository scope, and we reviewed decisions that changed product identity,
public interfaces, licensing, security posture, or publication state. This let
the model handle detailed iteration while keeping product accountability with
the human team.

## 4. Coding the game and the SDK

Sol contributed implementation and revision work in both codebases, while
maintaining a deliberate ownership boundary:

- **GAOS owns reusable behavior:** deterministic turn settlement, movement and
  collision mechanisms, grid geometry and field of view, solver and scoring
  behavior, replay verification, agent environments, model drivers, CLI
  integration, and protocol primitives.
- **Zonoid owns the product:** characters, abilities, authored levels, campaign
  modes, objectives, presentation, authentication, live-service policy, and
  seasonal rules.

The separation keeps the SDK useful to other games without reducing Zonoid to a
generic demo. It also gives Sol a clear engineering rule: extract how a reusable
mechanism behaves, but leave where it is used and what it means in the product.

## 5. Publishing packages, documentation, and presentations

We used Sol to prepare release metadata, package workflows, SDK documentation,
and online presentation surfaces. It could update navigation and examples, run
the static-site build, inspect internal links, and revise failures before a
human publication gate.

The GAOS documentation site is prepared for GitHub Pages, but we do **not**
represent it as publicly live while repository visibility and hosting are still
being finalized. The product example is available now: **[play the Zonoid live
preview](https://zonoid.ai)**. The current preview requires sign-in.

## 6. Testing by letting models play

GAOS supports normal software verification (unit tests, type checking, build
checks, deterministic replay, and protocol tests), but the game adds another
useful layer: a language model can play it.

The agent environment exposes the concrete legal actions for each turn, accepts
one canonical action, records rewards and a transcript, and can replay the same
seed and actions deterministically. That lets us evaluate more than whether the
code runs. We can ask whether an agent observes correctly, plans over multiple
turns, recovers from a mistake, and improves under the same rules used by human
players.

Model play does not replace unit tests, security review, or human playtesting.
It complements them with repeatable behavioral evaluation. This is central to
the GAOS mission: **games as benchmarks for human and AI agents**.

## What we learned

The most effective pattern was not “AI generates a game.” It was a closed
production loop in which one model could maintain intent across creative and
technical stages:

1. establish a concept that humans can judge;
2. translate it into specialized production systems;
3. inspect and revise the outputs;
4. encode reusable mechanisms separately from product content;
5. publish only after builds and human gates pass; and
6. test the result both as software and as a game an agent can actually play.

That loop is how we built the toolkit, and it is also the kind of agentic
development the toolkit is designed to support.
