from __future__ import annotations

import json
from pathlib import Path


MINIMUM_SCORE = 0.82
stats = json.loads(
    (Path(__file__).parent / "mutants/mutmut-cicd-stats.json").read_text()
)
detected = stats["killed"] + stats["timeout"]
score = detected / stats["total"]
print(
    f"Python mutation score: {score:.2%} "
    f"({detected}/{stats['total']} detected)"
)
if score < MINIMUM_SCORE:
    raise SystemExit(
        f"mutation score {score:.2%} is below the {MINIMUM_SCORE:.0%} floor"
    )
