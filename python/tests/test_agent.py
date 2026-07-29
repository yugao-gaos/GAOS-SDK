from gaos_sdk import evaluate_agent_episodes, run_agent_episode


class CountingEnv:
    def __init__(self, target=2):
        self.target = target
        self.value = 0

    def reset(self, seed=None):
        self.value = 0
        return {"value": self.value, "legal_actions": [1]}, {"status": "playing", "seed": seed}

    def step(self, action):
        self.value += action
        terminated = self.value >= self.target
        status = "won" if terminated else "playing"
        return (
            {"value": self.value, "legal_actions": [1]},
            1.0 if terminated else 0.0,
            terminated,
            False,
            {"status": status},
        )


def test_runs_one_provider_neutral_episode():
    result = run_agent_episode(CountingEnv(), lambda observation, _info: observation["legal_actions"][0], seed=7)
    assert result.terminated is True
    assert result.truncated is False
    assert result.total_reward == 1.0
    assert result.ticks == 2
    assert [step.action for step in result.transcript] == [1, 1]


def test_aggregates_deterministic_batches_and_tick_limits():
    won = evaluate_agent_episodes(lambda _seed: CountingEnv(), lambda _observation, _info: 1, [1, 2])
    assert (won.won, won.failed, won.truncated, won.mean_reward, won.mean_ticks) == (2, 0, 0, 1.0, 2.0)

    capped = run_agent_episode(CountingEnv(target=9), lambda _observation, _info: 1, max_ticks=1)
    assert capped.truncated is True
    assert capped.info["termination_reason"] == "tick_limit"
