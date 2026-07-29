"""Smallest possible autonomous agent: uniform-random legal actions.

Usage:  python examples/random_agent.py [level_id] [base_url]

This is the harness skeleton an LLM agent replaces: read observation,
pick one of `legal_actions`, step, repeat. Restart ("the 5th action")
is excluded so the walk actually explores.
"""

import random
import sys

from gaos_sdk import ArenaEnv


def main() -> None:
    level_id = sys.argv[1] if len(sys.argv) > 1 else "od-l1"
    base_url = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8899"

    env = ArenaEnv(level_id, base_url=base_url, play_method="human")
    obs, info = env.reset()
    print(f"level {level_id}, energy {obs['energy_left']}")
    print(obs["grid"], "\n")

    terminated = False
    while not terminated:
        moves = obs["legal_actions"][:-1] or obs["legal_actions"]  # drop restart if possible
        action = random.choice(moves)
        obs, reward, terminated, _, info = env.step(action)

    print(obs["grid"])
    print(f"\n{info['status']} in {info['actions_used']} actions, stars={info['stars']}")


if __name__ == "__main__":
    main()
