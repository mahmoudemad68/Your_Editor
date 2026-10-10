"""Offline subprocess bridge: real generated Pydantic construction/validation, never gold."""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from editagent_ai_worker.contracts import MediaAnalysis
from editagent_ai_worker.infrastructure.speech_schema import parse_document, serialize


def main() -> None:
    request = json.load(sys.stdin)
    output: list[dict[str, Any]] = []
    for document in request["documents"]:
        start = time.perf_counter()
        try:
            # Real model construction, not a fixture-copy masquerading as a producer.
            model = MediaAnalysis(**document)
            output.append(
                {
                    "valid": True,
                    "document": json.loads(model.model_dump_json()),
                    "validationMs": (time.perf_counter() - start) * 1000,
                }
            )
        except (ValidationError, ValueError, TypeError):
            output.append({"valid": False})
    if request.get("checkSpeech"):
        fixture = json.loads(Path(request["speechFixture"]).read_text(encoding="utf-8"))
        speech = fixture["sections"]["audio"]["data"]["speech"]
        # Existing US-202 domain parser/serializer preserves all semantic values.
        output.append({"us202": json.loads(serialize(parse_document(speech)))})
    print(json.dumps(output, ensure_ascii=False, allow_nan=False))


if __name__ == "__main__":
    main()
