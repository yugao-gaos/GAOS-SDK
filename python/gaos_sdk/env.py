"""Gymnasium-style environment over the Arena session API.

Matches the step(action) -> (observation, reward, terminated, truncated, info)
contract used by Gymnasium and Prime Intellect's `verifiers` ecosystem
(docs/game-tech-stack.md §2) without importing either — the API is
duck-type-compatible, so the env drops into existing harnesses or runs bare.

The observation is text-first, exactly what the wire protocol serves: the
composited grid, optional narrative, and the generic legal action ids. Action
semantics are deliberately NOT explained — inferring what "Action 3" does
from observed grid deltas is part of the task (scored sessions additionally
shuffle the id mapping per session).
"""

from __future__ import annotations

from typing import Any

from .client import ArenaClient, Tick


class ArenaEnv:
    """One env instance == one level; each reset() opens a fresh session."""

    def __init__(
        self,
        level_id: str,
        base_url: str = "http://localhost:8899",
        game_mode: str = "challenge",
        play_method: str = "autonomous_local",
        api_key: str | None = None,
    ):
        self.client = ArenaClient(base_url, api_key)
        self.level_id = level_id
        self.game_mode = game_mode
        self.play_method = play_method
        self.session_id: str | None = None
        self._tick: Tick | None = None

    # -- Gymnasium-style surface -------------------------------------------

    def reset(self, seed: int | None = None) -> tuple[dict[str, Any], dict[str, Any]]:
        # `seed` is accepted for interface compatibility but ignored: session
        # seeds are generated and held server-side (anti-cheat §7).
        self.session_id, self._tick = self.client.create_session(
            self.level_id, self.game_mode, self.play_method
        )
        return self._observation(self._tick), self._info(self._tick)

    def step(
        self,
        action: int | str | dict[str, Any],
        x: int | None = None,
        y: int | None = None,
        index: int | None = None,
    ) -> tuple[dict[str, Any], float, bool, bool, dict[str, Any]]:
        if self.session_id is None or self._tick is None:
            raise RuntimeError("call reset() before step()")
        if isinstance(action, dict):
            action_id = self._resolve(action.get("id", ""))
            x = action.get("x", x)
            y = action.get("y", y)
            index = action.get("index", index)
        else:
            action_id = self._resolve(action)
        tick = self.client.submit_action(self.session_id, action_id, x=x, y=y, index=index)
        self._tick = tick
        terminated = tick.done
        # Reward only at the terminal tick: stars on a win (1-3), 0 otherwise.
        # Efficiency pressure comes from stars, not per-step shaping — the
        # environment does not leak gradient the wire protocol doesn't.
        reward = float(tick.stars or 0) if tick.status == "won" else 0.0
        return self._observation(tick), reward, terminated, False, self._info(tick)

    def close(self) -> None:
        self.session_id = None
        self._tick = None

    # -- helpers ------------------------------------------------------------

    def submit(self) -> dict:
        """Flag the finished scored session for leaderboard publication."""
        if self.session_id is None:
            raise RuntimeError("no session")
        return self.client.submit_session(self.session_id)

    def _resolve(self, action: int | str) -> str:
        """Accept a legal-list index (int) or a wire id (str)."""
        assert self._tick is not None
        if isinstance(action, int):
            legal = self._tick.legal_action_ids
            if not 0 <= action < len(legal):
                raise IndexError(f"action index {action} out of range for {legal}")
            return legal[action]
        return action

    @staticmethod
    def _observation(tick: Tick) -> dict[str, Any]:
        return {
            "grid": tick.grid,
            "narrative": tick.narrative,
            "legal_actions": tick.legal_action_ids,
            "action_definitions": tick.actions,
            "concrete_actions": ArenaEnv._concrete_actions(tick),
            "carrying": tick.carrying,
            "energy_left": tick.max_actions - tick.actions_used,
            "control_revision": tick.control_revision,
            "mode": tick.mode,
            "targetable_cells": tick.targetable_cells,
            "action_targeting": tick.action_targeting,
            "dialogue_options": tick.dialogue_options,
            "talking_to": tick.talking_to,
            "dialogue_speaker": tick.dialogue_speaker,
            "dialogue_emotion": tick.dialogue_emotion,
        }

    @staticmethod
    def _concrete_actions(tick: Tick) -> list[dict[str, Any]]:
        concrete: list[dict[str, Any]] = []
        for definition in tick.actions:
            action_id = definition.get("id")
            params = definition.get("params")
            if not isinstance(action_id, str):
                continue
            if params == "none":
                concrete.append({"id": action_id})
            elif params == "index":
                indices = {
                    item["index"]
                    for item in [*tick.items, *tick.dialogue_options, *tick.pois]
                    if isinstance(item.get("index"), int)
                }
                concrete.extend({"id": action_id, "index": index} for index in sorted(indices))
            elif params == "xy":
                targeting = tick.action_targeting.get(action_id, {})
                cells = targeting.get("targetableCells", tick.targetable_cells)
                concrete.extend(
                    {"id": action_id, "x": cell[0], "y": cell[1]}
                    for cell in cells
                    if isinstance(cell, list) and len(cell) == 2
                )
        return concrete

    @staticmethod
    def _info(tick: Tick) -> dict[str, Any]:
        return {
            "tick_number": tick.tick_number,
            "status": tick.status,
            "stars": tick.stars,
            "actions_used": tick.actions_used,
            "max_actions": tick.max_actions,
            "visual_events": tick.visual_events,
        }
