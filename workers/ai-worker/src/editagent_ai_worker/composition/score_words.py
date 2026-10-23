"""Trusted evaluation command consumes already provenance-validated scoped metric inputs."""

import json
import sys

from editagent_ai_worker.domain.analysis.word_metrics import word_error


def main() -> None:
    data = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise ValueError("Evaluation input exceeds bound")
    inputs = json.loads(data)
    print(
        json.dumps(
            word_error(
                " ".join(w["text"] for w in inputs["gold"]),
                " ".join(w["text"] for w in inputs["predictions"]),
            ),
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
