"""Build/setup-only immutable model acquisition; inference verifies and stays offline."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import tempfile
import urllib.request
from pathlib import Path
from typing import Any

from editagent_ai_worker.domain.analysis.transcription import TranscriptionError

MODELS = {
    "tiny": {
        "revision": "d90ca5fe260221311c53c58e660288d3deb8d356",
        "files": {
            "model.bin": (
                75538270,
                "dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1",
            ),
            "config.json": (
                2249,
                "a73a28cdfe1c43ccc7202fa333d1f89c202477271407ae9a7f19afa52039cac8",
            ),
        },
    },
    "small": {
        "revision": "536b0662742c02347bc0e980a01041f333bce120",
        "files": {
            "model.bin": (
                483546902,
                "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671",
            ),
            "config.json": (
                2370,
                "b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828",
            ),
        },
    },
}
COMMON = {
    "tokenizer.json": (2203239, "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab"),
    "vocabulary.txt": (459861, "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913"),
}


def files(model: str) -> dict[str, tuple[int, str]]:
    if model not in MODELS:
        raise TranscriptionError("Unsupported ASR model")
    return {**COMMON, **MODELS[model]["files"]}  # type: ignore[dict-item]


def verify_asr_model(path: Path, model: str) -> dict[str, Any]:
    expected = files(model)
    if path.is_symlink() or not path.is_dir():
        raise TranscriptionError("Pinned ASR model is unavailable")
    for name, (size, digest) in expected.items():
        file = path / name
        if file.is_symlink() or not file.is_file() or file.stat().st_size != size:
            raise TranscriptionError("Pinned ASR model is invalid")
        with file.open("rb") as stream:
            if hashlib.file_digest(stream, "sha256").hexdigest() != digest:
                raise TranscriptionError("Pinned ASR model checksum mismatch")
    # Model bundle identity covers tokenizer/configuration as well as weights.
    bundle = hashlib.sha256(json.dumps(expected, sort_keys=True).encode()).hexdigest()
    return {
        "name": "faster-whisper-" + model,
        "version": MODELS[model]["revision"],
        "sha256": bundle,
    }


def acquire(root: Path, model: str) -> None:
    root.mkdir(parents=True, exist_ok=True)
    target = root / model
    if target.exists():
        verify_asr_model(target, model)
        return
    with tempfile.TemporaryDirectory(prefix="asr-build-", dir=root) as temporary:
        staging = Path(temporary) / model
        staging.mkdir()
        for name, (size, digest) in files(model).items():
            url = f"https://huggingface.co/Systran/faster-whisper-{model}/resolve/{MODELS[model]['revision']}/{name}"
            with (
                urllib.request.urlopen(url, timeout=120) as response,
                (staging / name).open("xb") as output,
            ):
                downloaded = 0
                checksum = hashlib.sha256()
                while block := response.read(65536):
                    downloaded += len(block)
                    if downloaded > size:
                        raise TranscriptionError("Model download exceeds immutable size")
                    checksum.update(block)
                    output.write(block)
                if downloaded != size or checksum.hexdigest() != digest:
                    raise TranscriptionError("Model download checksum mismatch")
        verify_asr_model(staging, model)
        try:
            os.rename(staging, target)
        except FileExistsError:
            verify_asr_model(target, model)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, required=True)
    parser.add_argument("--model", choices=tuple(MODELS), required=True)
    args = parser.parse_args()
    acquire(args.root, args.model)
    print(json.dumps(verify_asr_model(args.root / args.model, args.model), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
