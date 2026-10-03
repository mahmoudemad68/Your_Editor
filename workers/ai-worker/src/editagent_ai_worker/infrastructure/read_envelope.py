"""Print one BullMQ envelope from Redis after schema validation."""

from __future__ import annotations

import json
import sys

from editagent_ai_worker.infrastructure.job_envelope import read_bullmq_envelope


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if len(args) != 3:
        print("usage: read_envelope REDIS_URL QUEUE_NAME JOB_ID", file=sys.stderr)
        return 2
    envelope = read_bullmq_envelope(args[0], args[1], args[2])
    print(json.dumps(envelope))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
