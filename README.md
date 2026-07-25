# Gaming AGI Open SDK (GAOS)

**Build once. Play as a human. Evaluate as an agent.**

GAOS is an open-source SDK for building games and interactive benchmarks that
humans and agents can both play. It gives researchers reusable game mechanisms,
structured agent interfaces, and replayable evidence, while helping game
developers keep one authoritative game core ready for agents later.

The SDK owns reusable infrastructure. Each product still owns its world,
content, benchmark claims, scoring meaning, hosting, and presentation.

## Start here

- [Documentation](https://yugao-gaos.github.io/GAOS-TurnBasedGrid-SDK/)
- [Quickstart and language guide](docs/quickstart.md)
- [Capabilities](docs/capabilities.md)
- [Architecture and ownership boundaries](docs/architecture.md)
- [Mechanism reference](docs/mechanisms/index.md)
- [Agentic play](docs/agentic-play.md)
- [Python SDK surface](docs/python.md)
- [Portable replay and verification](docs/mechanisms/replay.md)
- [Roadmap, including the future naming migration](docs/roadmap.md)

The existing repository and package names remain active for compatibility; no
replacement name is active yet.

**Built with GAOS:** [Zonoid](https://zonoid.ai) is the first production game
and live reference. For questions and ideas, join the
[GAOS Discord community](https://discord.gg/vdvUgcqPU).

## Built during OpenAI Build Week

The **GAOS SDK is the submitted project**. This standalone repository was
created on July 21, 2026 during OpenAI Build Week, and its complete commit and
release history was produced during the event. The work turned the reusable
mechanism engine, deterministic agent evaluation environment, provider-neutral
drivers, and CLI integrations into an independently installable open-source
toolkit with TypeScript and Python releases.

The pre-existing Zonoid platform is outside the submission scope, but was
central to production. As the game evolved, GAOS generalized its initial
spatial engine into reusable game-mechanism, multiplayer, verification, and
agent capabilities; Zonoid then validated them in a live product. Judges can
register at [zonoid.ai](https://zonoid.ai) and download the game without
rebuilding its platform source. The
[GPT-5.6 Sol case study](docs/building-with-gpt-5-6-sol.md) records Codex's role
in extraction, design, implementation, review, publishing, and agent-play
testing.

GAOS is submitted in the **Developer Tools** category. Submission links,
prebuilt installation checks, supported platforms, verification commands, and
the `/feedback` Session ID are collected in [DEVPOST.md](DEVPOST.md).

## Development

```sh
npm install
npm run typecheck
npm test
npm run build
npm run docs:build

cd python
PYTHONPATH=. python3 -m pytest tests
python3 -m build
```

Live integration tests use `ARENA_BASE_URL` and skip automatically when a
compatible API host is not available.

Use `npm run docs:dev` to work on the documentation locally. See
[CONTRIBUTING.md](CONTRIBUTING.md) for contribution checks and [SECURITY.md](SECURITY.md)
for private vulnerability reporting.

## License

Licensed under the [Apache License 2.0](LICENSE).
