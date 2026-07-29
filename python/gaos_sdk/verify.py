"""Offline RFC-010 verification composition and command-line entry point."""

from __future__ import annotations

import argparse
import importlib.util
import json
from pathlib import Path
from typing import Any, Callable

from .replay import (
    parse_replay_jsonl,
    recheck_replay_signatures,
    validate_replay_artifact,
)


ReplayCheck = Callable[[dict[str, Any]], dict[str, Any]]
_SEMANTIC_STATES = {
    "verified",
    "unavailable",
    "not_applicable",
    "failed",
}


def _default_semantics(
    artifact: dict[str, Any],
    signed: bool,
) -> dict[str, Any]:
    records = artifact.get("records", [])
    has_submissions = any(
        (
            record.get("kind") == "action"
            and "submissionId" in record
        )
        or (
            record.get("kind") == "resolution"
            and any(
                isinstance(item, dict) and "submissionId" in item
                for item in record.get("inputs", [])
            )
        )
        or record.get("kind") == "commit-mismatch"
        for record in records
        if isinstance(record, dict)
    )
    has_timeouts = any(
        record.get("kind") == "resolution"
        and record.get("cause") == "timeout"
        for record in records
        if isinstance(record, dict)
    )
    return {
        "submissions": (
            "unavailable"
            if signed and has_submissions
            else "not_applicable"
        ),
        "timeouts": (
            "unavailable"
            if signed and has_timeouts
            else "not_applicable"
        ),
        "problems": [],
    }


def verify_replay(
    artifact: dict[str, Any],
    replay_check: ReplayCheck,
) -> dict[str, Any]:
    """Compose transport, product replay, and RFC-010 signature facts."""

    transport_problems = validate_replay_artifact(artifact)
    signatures = (
        recheck_replay_signatures(artifact)
        if not transport_problems
        else {"state": "unsigned", "problems": [], "seats": []}
    )
    replay = (
        replay_check(artifact)
        if not transport_problems
        else {"ok": False, "problems": transport_problems}
    )
    replay_ok = replay.get("ok") is True
    semantics = replay.get("semantics")
    if not isinstance(semantics, dict):
        semantics = _default_semantics(
            artifact,
            signatures["state"] == "signed",
        )
    else:
        semantics = {
            "submissions": semantics.get("submissions", "unavailable"),
            "timeouts": semantics.get("timeouts", "unavailable"),
            "problems": list(semantics.get("problems", [])),
        }
        for lane in ("submissions", "timeouts"):
            if semantics[lane] not in _SEMANTIC_STATES:
                semantics["problems"].append(
                    f"semantic {lane} state is invalid"
                )
                semantics[lane] = "failed"
    semantic_failed = (
        semantics["submissions"] == "failed"
        or semantics["timeouts"] == "failed"
    )
    semantic_unavailable = (
        semantics["submissions"] == "unavailable"
        or semantics["timeouts"] == "unavailable"
    )
    rejected = (
        bool(transport_problems)
        or not replay_ok
        or bool(signatures["problems"])
        or signatures["state"] == "partial"
        or semantic_failed
    )
    verdict = (
        "rejected"
        if rejected
        else "trusted"
        if signatures["state"] == "signed" and not semantic_unavailable
        else "unverifiable"
    )
    return {
        "verdict": verdict,
        "replayOk": replay_ok,
        "format": artifact.get("header", {}).get("format"),
        "formatVersion": artifact.get("header", {}).get("formatVersion"),
        "dmath": artifact.get("header", {}).get("extensions", {}).get("dmath"),
        "signatures": signatures,
        "semantics": semantics,
        "problems": [
            *transport_problems,
            *replay.get("problems", []),
        ],
        "diagnostics": replay.get("diagnostics", []),
        "replayed": replay.get("replayed"),
    }


def _load_adapter(path: Path) -> ReplayCheck:
    spec = importlib.util.spec_from_file_location("gaos_verify_adapter", path)
    if spec is None or spec.loader is None:
        raise TypeError(f"cannot load adapter {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    check = getattr(module, "recheck_replay", None)
    if not callable(check):
        raise TypeError("adapter must export recheck_replay(artifact)")
    return check


def main() -> int:
    """Run ``gaos-verify`` over one artifact and product adapter."""

    parser = argparse.ArgumentParser(prog="gaos-verify")
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--adapter", required=True, type=Path)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    try:
        artifact = parse_replay_jsonl(
            args.artifact.read_text(encoding="utf-8")
        )
        report = verify_replay(artifact, _load_adapter(args.adapter))
    except (OSError, TypeError, ValueError) as error:
        parser.exit(2, f"gaos-verify: {error}\n")
    if args.json:
        print(json.dumps(report, separators=(",", ":")))
    else:
        print(
            f"{report['verdict']} · {report['format']} "
            f"{report['formatVersion']} · "
            f"replay {'consistent' if report['replayOk'] else 'inconsistent'} "
            f"· signatures {report['signatures']['state']}"
        )
        for problem in [
            *report["problems"],
            *report["signatures"]["problems"],
            *report["semantics"]["problems"],
        ]:
            print(f"problem: {problem}")
    return 1 if report["verdict"] == "rejected" else 0


if __name__ == "__main__":
    raise SystemExit(main())
