from __future__ import annotations

import copy
import math
from collections.abc import Callable
from dataclasses import replace
from typing import Any

import jsonschema
import pytest

from editagent_ai_worker.domain.analysis.overlap import complement, overlap, union
from editagent_ai_worker.domain.analysis.segmentation import WindowProbability, speech_regions
from editagent_ai_worker.domain.analysis.voice_activity import (
    AudioIdentity,
    InferenceProvenance,
    SpeechAnalysis,
    SpeechRegion,
    VadConfiguration,
    VadModelError,
)
from editagent_ai_worker.infrastructure.speech_schema import parse_document, serialize, to_document
from editagent_ai_worker.infrastructure.vad_config import load_vad_settings
from editagent_ai_worker.infrastructure.vad_model import MODEL_SHA256


def identity(duration_us: int = 320_000, offset: int = 0) -> AudioIdentity:
    return AudioIdentity(
        "fixture",
        "a" * 64,
        "asr-fixture",
        "b" * 64,
        duration_us + offset,
        offset,
        duration_us + offset,
    )


def configuration(**changes: float | int) -> VadConfiguration:
    values: dict[str, float | int] = dict(
        speech_threshold=0.5,
        negative_threshold=0.35,
        min_speech_us=32_000,
        min_silence_us=64_000,
        padding_us=0,
    )
    values.update(changes)
    return VadConfiguration(**values)  # type: ignore[arg-type]


def frames(probabilities: list[float]) -> list[WindowProbability]:
    return [WindowProbability(i * 512, (i + 1) * 512, p) for i, p in enumerate(probabilities)]


@pytest.mark.parametrize("value", [math.nan, math.inf, -math.inf, -0.1, 1.1, True])
def test_invalid_probabilities(value: float) -> None:
    with pytest.raises(ValueError):
        configuration(speech_threshold=value)
    with pytest.raises(ValueError):
        SpeechRegion(0, 1, value)


@pytest.mark.parametrize(
    "changes",
    [
        {"min_speech_us": 0},
        {"min_silence_us": -1},
        {"padding_us": -1},
        {"padding_us": 1_000_001},
        {"min_speech_us": 0.5},
        {"speech_threshold": 0.3, "negative_threshold": 0.35},
    ],
)
def test_invalid_config_combinations(changes: dict[str, float | int]) -> None:
    with pytest.raises(ValueError):
        configuration(**changes)


def test_environment_thresholds_and_hysteresis(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("EDITAGENT_VAD_SPEECH_THRESHOLD", "0.6")
    monkeypatch.setenv("EDITAGENT_VAD_NEGATIVE_THRESHOLD", "0.4")
    monkeypatch.setenv("EDITAGENT_VAD_PADDING_US", "120000")
    assert load_vad_settings().configuration() == configuration(
        speech_threshold=0.6,
        negative_threshold=0.4,
        padding_us=120_000,
        min_speech_us=100_000,
        min_silence_us=200_000,
    )
    monkeypatch.setenv("EDITAGENT_VAD_SPEECH_THRESHOLD", "nan")
    with pytest.raises(VadModelError):
        load_vad_settings()


def test_speech_after_before_long_silence_and_source_coordinates() -> None:
    values = [0.0] * 4 + [0.9] * 5 + [0.0] * 4
    source = identity(len(values) * 32_000, 30_000_000)
    result = speech_regions(frames(values), source, configuration())
    assert [(r.start_us, r.end_us) for r in result] == [(30_128_000, 30_288_000)]
    assert result[0].confidence == pytest.approx(0.9)


def test_short_utterance_minimum_and_padding_clamp() -> None:
    windows = frames([0.9, 0.0, 0.0])
    assert speech_regions(windows, identity(96_000), configuration(min_speech_us=64_000)) == ()
    regions = speech_regions(windows, identity(96_000), configuration(padding_us=100_000))
    assert regions[0].start_us == 0 and regions[0].end_us == 96_000


def test_padding_merges_colliding_regions_and_weighted_confidence() -> None:
    windows = frames([0.9, 0.9, 0, 0, 0.8, 0.8, 0, 0])
    regions = speech_regions(windows, identity(256_000), configuration(padding_us=64_000))
    assert len(regions) == 1
    assert (regions[0].start_us, regions[0].end_us) == (0, 256_000)
    assert regions[0].confidence == pytest.approx((0.9 * 2 + 0.8 * 2) / 8)


def test_short_pause_hysteresis_noise_and_low_probability_speech() -> None:
    windows = frames([0.49, 0.51, 0.4, 0.0, 0.9, 0, 0])
    regions = speech_regions(windows, identity(224_000), configuration())
    assert [(r.start_us, r.end_us) for r in regions] == [(32_000, 160_000)]
    assert speech_regions(frames([0.49] * 10), identity(), configuration()) == ()


def test_windows_cover_exactly_once_and_valid_times() -> None:
    with pytest.raises(ValueError):
        speech_regions(frames([0.5] * 9), identity(), configuration())
    with pytest.raises(ValueError):
        speech_regions([WindowProbability(1, 512, 0.5)], identity(), configuration())
    for start, end in [(1, 1), (-1, 3), (0.5, 3)]:
        with pytest.raises(ValueError):
            SpeechRegion(start, end, 0.5)  # type: ignore[arg-type]


@pytest.mark.parametrize(
    "p,g,expected",
    [
        ([], [], (0, 0, 0, 1, 1, 1)),
        ([], [(0, 100)], (0, 0, 100, 1, 0, 0)),
        ([(0, 100)], [], (0, 100, 0, 0, 1, 0)),
        ([(0, 100)], [(0, 100)], (100, 0, 0, 1, 1, 1)),
        ([(0, 100)], [(50, 150)], (50, 50, 50, 0.5, 0.5, 0.5)),
        ([(0, 50)], [(50, 100)], (0, 50, 50, 0, 0, 0)),
        ([(0, 150)], [(0, 100)], (100, 50, 0, 2 / 3, 1, 0.8)),
    ],
)
def test_overlap_edges(
    p: list[tuple[int, int]], g: list[tuple[int, int]], expected: tuple[float, ...]
) -> None:
    m = overlap(p, g, (0, 200))
    assert (m.tp_us, m.fp_us, m.fn_us, m.precision, m.recall, m.f1) == expected


def test_scoped_union_complement_and_invalid_ranges() -> None:
    assert union([(0, 60), (40, 100), (100, 120), (150, 200)], (50, 160)) == ((50, 120), (150, 160))
    assert complement([(0, 60), (120, 200)], (50, 160)) == ((60, 120),)
    assert overlap([(0, 200)], [(50, 150)], (50, 150)).f1 == 1
    with pytest.raises(ValueError):
        overlap([(10, 9)], [], (0, 100))


def analysis() -> SpeechAnalysis:
    return SpeechAnalysis(
        identity(),
        (SpeechRegion(0, 100_000, 0.9),),
        InferenceProvenance(
            "silero-onnx-stream-v1",
            "silero-vad",
            "v6-faster-whisper-1.2.1",
            MODEL_SHA256,
            "onnxruntime",
            "1.31.0",
            "2.4.6",
            "d" * 64,
            configuration(),
        ),
    )


def test_schema_domain_roundtrip_and_deterministic_serialization() -> None:
    value = analysis()
    assert parse_document(to_document(value)) == value
    assert serialize(value) == serialize(parse_document(to_document(value)))
    assert '"startUs":"0"' in serialize(value)


@pytest.mark.parametrize(
    "mutation",
    [
        lambda d: d.update(schemaVersion=2),
        lambda d: d.update(__proto__={}),
        lambda d: d["speechRegions"][0].update(startUs="0.5"),
        lambda d: d["speechRegions"][0].update(confidence=2),
        lambda d: d["provenance"].update(extra="unknown"),
    ],
)
def test_schema_rejects_malformed_documents(mutation: object) -> None:
    document = copy.deepcopy(to_document(analysis()))
    mutation(document)  # type: ignore[operator]
    with pytest.raises(jsonschema.ValidationError):
        parse_document(document)


@pytest.mark.parametrize(
    "regions",
    [
        (SpeechRegion(0, 1, 0.5), SpeechRegion(0, 2, 0.5)),
        (SpeechRegion(0, 400_000, 0.5),),
    ],
)
def test_semantic_region_invariants(regions: tuple[SpeechRegion, ...]) -> None:
    with pytest.raises(ValueError):
        replace(analysis(), regions=regions)


def test_parser_rejects_out_of_scope_and_reversed_ranges() -> None:
    document = to_document(analysis())
    document["speechRegions"][0]["endUs"] = "400000"
    with pytest.raises(ValueError):
        parse_document(document)
    document["speechRegions"][0].update(startUs="200000", endUs="100000")
    with pytest.raises(ValueError):
        parse_document(document)


@pytest.mark.parametrize(
    "changes",
    [
        {"source_id": "../../secret"},
        {"artifact_id": "https://example.com"},
        {"audio_sha256": "bad"},
        {"source_duration_us": 1_800_000_001},
        {"scope_end_us": 320_001},
        {"scope_start_us": 320_000},
    ],
)
def test_audio_identity_rejects_malformed(changes: dict[str, str | int]) -> None:
    with pytest.raises(ValueError):
        replace(identity(), **changes)  # type: ignore[arg-type]


def test_document_rejects_nan_config_order_overlap_and_bad_model() -> None:
    mutations: list[Callable[[dict[str, Any]], None]] = [
        lambda d: d["provenance"]["configuration"].update(negativeThreshold=0.9),
        lambda d: d["speechRegions"][0].update(confidence=math.nan),
        lambda d: d["speechRegions"].append(d["speechRegions"][0]),
        lambda d: d["provenance"].update(modelSha256="0" * 64),
    ]
    for mutate in mutations:
        document = to_document(analysis())
        mutate(document)
        with pytest.raises((ValueError, jsonschema.ValidationError)):
            parse_document(document)
