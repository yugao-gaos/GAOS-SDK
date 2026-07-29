"""Provider-neutral helpers for deterministic agent evaluation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Protocol, Sequence


class AgentEnvironment(Protocol):
    """Minimal Gym-style contract accepted by the evaluation runner."""

    def reset(self, seed: int | None = None) -> tuple[dict[str, Any], dict[str, Any]]: ...

    def step(
        self, action: Any
    ) -> tuple[dict[str, Any], float, bool, bool, dict[str, Any]]: ...


AgentPolicy = Callable[[dict[str, Any], dict[str, Any]], Any]


@dataclass(frozen=True)
class AgentStep:
    n: int
    action: Any
    reward: float
    terminated: bool
    truncated: bool
    info: dict[str, Any]


@dataclass(frozen=True)
class AgentEpisodeResult:
    observation: dict[str, Any]
    info: dict[str, Any]
    transcript: tuple[AgentStep, ...]
    total_reward: float
    ticks: int
    terminated: bool
    truncated: bool


@dataclass(frozen=True)
class AgentBatchResult:
    episodes: tuple[AgentEpisodeResult, ...]
    won: int
    failed: int
    truncated: int
    mean_reward: float
    mean_ticks: float


def run_agent_episode(
    environment: AgentEnvironment,
    policy: AgentPolicy,
    *,
    seed: int | None = None,
    max_ticks: int = 10_000,
) -> AgentEpisodeResult:
    """Run one deterministic episode without depending on an LLM provider."""

    if max_ticks <= 0:
        raise ValueError("max_ticks must be positive")
    observation, info = environment.reset(seed=seed)
    transcript: list[AgentStep] = []
    total_reward = 0.0
    terminated = False
    truncated = False
    while not terminated and not truncated:
        if len(transcript) >= max_ticks:
            truncated = True
            info = {**info, "termination_reason": "tick_limit"}
            break
        action = policy(observation, info)
        observation, reward, terminated, truncated, info = environment.step(action)
        reward = float(reward)
        total_reward += reward
        transcript.append(
            AgentStep(
                n=len(transcript) + 1,
                action=action,
                reward=reward,
                terminated=terminated,
                truncated=truncated,
                info=dict(info),
            )
        )
    return AgentEpisodeResult(
        observation=observation,
        info=info,
        transcript=tuple(transcript),
        total_reward=total_reward,
        ticks=len(transcript),
        terminated=terminated,
        truncated=truncated,
    )


def evaluate_agent_episodes(
    environment_factory: Callable[[int | None], AgentEnvironment],
    policy: AgentPolicy,
    seeds: Sequence[int | None],
    *,
    max_ticks: int = 10_000,
) -> AgentBatchResult:
    """Run a deterministic batch and aggregate provider-neutral metrics."""

    episodes = tuple(
        run_agent_episode(
            environment_factory(seed),
            policy,
            seed=seed,
            max_ticks=max_ticks,
        )
        for seed in seeds
    )
    count = len(episodes)
    statuses = [episode.info.get("status") for episode in episodes]
    return AgentBatchResult(
        episodes=episodes,
        won=statuses.count("won"),
        failed=statuses.count("failed"),
        truncated=sum(episode.truncated for episode in episodes),
        mean_reward=(sum(episode.total_reward for episode in episodes) / count if count else 0.0),
        mean_ticks=(sum(episode.ticks for episode in episodes) / count if count else 0.0),
    )
