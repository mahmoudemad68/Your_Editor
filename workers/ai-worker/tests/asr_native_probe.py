"""Real native-kernel regression entrypoint; fixed licensed fixtures, no gold generation."""

from __future__ import annotations

import hashlib
import json
import sys
import tempfile
from pathlib import Path
from typing import Any

from editagent_ai_worker.infrastructure.asr_config import AsrSettings
from editagent_ai_worker.infrastructure.config import configure_asr_native_environment


def main() -> None:
    configure_asr_native_environment()
    from editagent_ai_worker.infrastructure.faster_whisper import FasterWhisperAdapter
    from test_real_multilingual_asr import ROOT, canonical, fixture, pcm

    threads = int(sys.argv[1])
    assert threads in (1, 2)
    adapter = FasterWhisperAdapter(
        AsrSettings(model="tiny", model_root=ROOT / ".local/asr-models", cpu_threads=threads)
    )
    import numpy as np

    # CT2 has its own ISA dispatch; its convolution and GEMM backend dispatch
    # independently. A stable log-Mel input must produce bit-identical encoded
    # tensors even after requests with other shapes/languages. Retain those
    # hashes alongside the complete decoder/alignment output, not instead of it.
    native_features: list[tuple[str, Any]] = []
    encoder_hashes: dict[str, str] = {}

    def inspect_encoder() -> None:
        if not native_features:
            for name in ("en.wav", "ar.wav", "en-chunks.wav"):
                audio = np.frombuffer(pcm(name), dtype="<i2").astype(np.float32) / 32768
                for samples in (64000, 128000, 448000):
                    if len(audio) >= samples:
                        native_features.append(
                            (f"{name}:{samples}", adapter.model.feature_extractor(audio[:samples]))
                        )
        for name, features in native_features:
            encoded = np.asarray(adapter.model.encode(features))
            digest = hashlib.sha256(encoded.tobytes()).hexdigest()
            assert encoder_hashes.setdefault(name, digest) == digest, name

    original = adapter._aligned_chunk
    observations: list[str] = []

    def observed(segments: Any, audio: Any, language: str, check: Any = None) -> Any:
        words = original(segments, audio, language, check)
        text = "".join(segment.text for segment in segments).strip()
        assert "".join(word.word for word in words).strip() == text
        assert all(0 <= word.start < word.end <= len(audio) / 16000 for word in words)
        assert all(a.end <= b.start for a, b in zip(words, words[1:], strict=False))
        observations.append(text)
        return words

    adapter._aligned_chunk = observed  # type: ignore[method-assign]
    try:
        inspect_encoder()
        with tempfile.TemporaryDirectory(prefix="asr-kernel-") as directory:
            path = Path(directory) / "original.wav"
            source = fixture(path, pcm("en-chunks.wav"))
            outputs = [canonical(adapter, path, source)]
            # A different language/native encoder shape must not alter a later
            # identical request. This mirrors the original shared-fixture order.
            for language in ("en", "ar"):
                warm = Path(directory) / (language + ".wav")
                warm_source = fixture(warm, pcm(language + ".wav"))
                canonical(adapter, warm, warm_source)
                canonical(adapter, warm, warm_source)
            outputs.extend(canonical(adapter, path, source) for _ in range(3))
            inspect_encoder()
            assert outputs[0] == outputs[1] == outputs[2] == outputs[3]
            assert len(outputs[0]["transcript"]["words"]) > 100
            assert observations
            print(
                json.dumps(
                    {
                        "output": outputs[0],
                        "completeNativeTextPreserved": True,
                        "encoderHashes": encoder_hashes,
                    }
                )
            )
    finally:
        adapter.close()


if __name__ == "__main__":
    main()
