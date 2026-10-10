"""GENERATED FILE — DO NOT EDIT.
Canonical sources: packages/schemas/src/{media,analysis,speech}*.schema.json
Generator: tools/schema/generate-media-analysis.mjs v1.0.0; pnpm schemas:generate
Source SHA-256: 7709b283cf9196ec597aec206eecde6cf11a00a1137ed8bcc262b6299adc2cb4"""

# fmt: off
# ruff: noqa: E501
from __future__ import annotations

from functools import partial
from typing import Annotated, Literal, Self, TypeAlias

from pydantic import AfterValidator, BeforeValidator, Field, model_validator

from .validation import ContractModel, check_rules, json_integer, text_rules

MediaTime: TypeAlias = Annotated[str, AfterValidator(partial(text_rules, minimum=0, maximum=None, patterns=("^(0|[1-9][0-9]*)$",)))]

Time: TypeAlias = Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=20, patterns=("^(0|[1-9][0-9]*)$", "^(0|[1-9][0-9]*)$(?![\\s\\S])")))]

class TimeRange(ContractModel):
    startUs: Time
    endUs: Time

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "less", "left": "startUs", "right": "endUs", "decimal": True}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class AnalysisCommon(ContractModel):
    range: TimeRange


Confidence: TypeAlias = Annotated[float, Field(ge=0, le=1)]

LogicalId: TypeAlias = Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=128, patterns=("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])",)))]

Sha256: TypeAlias = Annotated[str, AfterValidator(partial(text_rules, minimum=64, maximum=64, patterns=("^[0-9a-f]{64}$(?![\\s\\S])",)))]

UuidV7: TypeAlias = Annotated[str, AfterValidator(partial(text_rules, minimum=36, maximum=36, patterns=("^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$(?![\\s\\S])",)))]

class BoundingBox(ContractModel):
    x: Annotated[float, Field(ge=0, le=1)]
    y: Annotated[float, Field(ge=0, le=1)]
    width: Annotated[float, Field(le=1, gt=0)]
    height: Annotated[float, Field(le=1, gt=0)]

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "sumMax", "fields": ["x", "width"], "maximum": 1}, {"kind": "sumMax", "fields": ["y", "height"], "maximum": 1}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class Failure(ContractModel):
    code: Literal["invalid_input", "unsupported", "timeout", "unavailable", "internal"]
    reason: Literal["Analysis input is invalid.", "This analysis is unsupported.", "Analysis timed out.", "Analyzer is unavailable.", "Analysis failed."]
    retryable: bool


class ModelIdentity(ContractModel):
    name: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=128, patterns=("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])",)))]
    version: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=128, patterns=("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])",)))]
    sha256: Annotated[str, AfterValidator(partial(text_rules, minimum=64, maximum=64, patterns=("^[0-9a-f]{64}$(?![\\s\\S])",)))]


class AnalyzerProvenance(ContractModel):
    analyzer: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=128, patterns=("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])",)))]
    analyzerVersion: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=128, patterns=("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])",)))]
    sourceSha256: Annotated[str, AfterValidator(partial(text_rules, minimum=64, maximum=64, patterns=("^[0-9a-f]{64}$(?![\\s\\S])",)))]
    configurationSha256: Annotated[str, AfterValidator(partial(text_rules, minimum=64, maximum=64, patterns=("^[0-9a-f]{64}$(?![\\s\\S])",)))]
    inputArtifactId: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=128, patterns=("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])",)))] | None = None
    inputSha256: Annotated[str, AfterValidator(partial(text_rules, minimum=64, maximum=64, patterns=("^[0-9a-f]{64}$(?![\\s\\S])",)))] | None = None
    runtime: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=128, patterns=("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])",)))] | None = None
    runtimeVersion: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=128, patterns=("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])",)))] | None = None
    model: ModelIdentity | None = None


class FrameRate(ContractModel):
    numerator: Time
    denominator: Time

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "positive", "field": "numerator", "decimal": True}, {"kind": "positive", "field": "denominator", "decimal": True}, {"kind": "maximum", "field": "numerator", "value": "9223372036854775807", "decimal": True}, {"kind": "maximum", "field": "denominator", "value": "9223372036854775807", "decimal": True}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class MediaMetadata(ContractModel):
    kind: Literal["video", "audio", "image"]
    durationUs: Time | None = None
    container: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=64, patterns=("^[A-Za-z0-9][A-Za-z0-9._+-]*$(?![\\s\\S])",)))] | None = None
    videoCodec: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=64, patterns=("^[A-Za-z0-9][A-Za-z0-9._+-]*$(?![\\s\\S])",)))] | None = None
    audioCodec: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=64, patterns=("^[A-Za-z0-9][A-Za-z0-9._+-]*$(?![\\s\\S])",)))] | None = None
    width: Annotated[int, BeforeValidator(json_integer), Field(ge=1, le=2147483647)] | None = None
    height: Annotated[int, BeforeValidator(json_integer), Field(ge=1, le=2147483647)] | None = None
    displayWidth: Annotated[int, BeforeValidator(json_integer), Field(ge=1, le=2147483647)] | None = None
    displayHeight: Annotated[int, BeforeValidator(json_integer), Field(ge=1, le=2147483647)] | None = None
    rotation: Literal[0, 90, 180, 270] | None = None
    frameRate: FrameRate | None = None
    frameRateMode: Literal["constant", "variable", "unknown"] | None = None
    colorSpace: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=64, patterns=("^[A-Za-z0-9][A-Za-z0-9._+-]*$(?![\\s\\S])",)))] | None = None
    audioChannels: Annotated[int, BeforeValidator(json_integer), Field(ge=1, le=64)] | None = None
    sampleRate: Annotated[int, BeforeValidator(json_integer), Field(ge=1, le=1000000)] | None = None

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "together", "fields": ["width", "height", "displayWidth", "displayHeight"]}, {"kind": "rotatedDimensions", "width": "width", "height": "height", "displayWidth": "displayWidth", "displayHeight": "displayHeight", "rotation": "rotation"}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class TranscriptWord(ContractModel):
    text: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=256, patterns=("^[^\\ud800-\\udfff]*$(?![\\s\\S])",)))]
    startUs: Time
    endUs: Time
    confidence: Annotated[float, Field(ge=0, le=1)] | None = None
    speaker: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=128, patterns=("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])",)))] | None = None

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "less", "left": "startUs", "right": "endUs", "decimal": True}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class TranscriptSegment(ContractModel):
    id: LogicalId
    text: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=16384, patterns=("^[^\\ud800-\\udfff]*$(?![\\s\\S])",)))]
    startUs: Time
    endUs: Time
    confidence: Annotated[float, Field(ge=0, le=1)] | None = None
    words: Annotated[list[TranscriptWord], Field(min_length=0, max_length=54000)]

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "less", "left": "startUs", "right": "endUs", "decimal": True}, {"kind": "orderedRanges", "field": "words", "start": "startUs", "end": "endUs"}, {"kind": "rangesWithin", "field": "words", "lower": "startUs", "upper": "endUs", "start": "startUs", "end": "endUs"}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class Transcript(ContractModel):
    language: Annotated[str, AfterValidator(partial(text_rules, minimum=2, maximum=35, patterns=("^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$(?![\\s\\S])",)))]
    languageConfidence: Annotated[float, Field(ge=0, le=1)] | None = None
    segments: Annotated[list[TranscriptSegment], Field(min_length=0, max_length=54000)]

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "orderedRanges", "field": "segments", "start": "startUs", "end": "endUs"}, {"kind": "unique", "field": "segments", "key": "id"}, {"kind": "nestedCount", "field": "segments", "child": "words", "maximum": 54000}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class SpeechAnalysisSource(ContractModel):
    sourceId: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=128, patterns=("^[a-zA-Z0-9][a-zA-Z0-9._-]*$(?![\\s\\S])",)))]
    sourceSha256: Annotated[str, AfterValidator(partial(text_rules, minimum=0, maximum=None, patterns=("^[0-9a-f]{64}$(?![\\s\\S])",)))]
    artifactId: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=128, patterns=("^[a-zA-Z0-9][a-zA-Z0-9._-]*$(?![\\s\\S])",)))]
    audioSha256: Annotated[str, AfterValidator(partial(text_rules, minimum=0, maximum=None, patterns=("^[0-9a-f]{64}$(?![\\s\\S])",)))]
    sourceDurationUs: Annotated[str, AfterValidator(partial(text_rules, minimum=0, maximum=10, patterns=("^(0|[1-9][0-9]*)$(?![\\s\\S])",)))]
    scopeStartUs: Annotated[str, AfterValidator(partial(text_rules, minimum=0, maximum=10, patterns=("^(0|[1-9][0-9]*)$(?![\\s\\S])",)))]
    scopeEndUs: Annotated[str, AfterValidator(partial(text_rules, minimum=0, maximum=10, patterns=("^(0|[1-9][0-9]*)$(?![\\s\\S])",)))]

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "positive", "field": "sourceDurationUs", "decimal": True}, {"kind": "maximum", "field": "sourceDurationUs", "value": "1800000000", "decimal": True}, {"kind": "less", "left": "scopeStartUs", "right": "scopeEndUs", "decimal": True}, {"kind": "lessEqual", "left": "scopeEndUs", "right": "sourceDurationUs", "decimal": True}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class SpeechRegion(ContractModel):
    startUs: Annotated[str, AfterValidator(partial(text_rules, minimum=0, maximum=10, patterns=("^(0|[1-9][0-9]*)$(?![\\s\\S])",)))]
    endUs: Annotated[str, AfterValidator(partial(text_rules, minimum=0, maximum=10, patterns=("^(0|[1-9][0-9]*)$(?![\\s\\S])",)))]
    confidence: Annotated[float, Field(ge=0, le=1)]

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "less", "left": "startUs", "right": "endUs", "decimal": True}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class SpeechAnalysisProvenanceConfiguration(ContractModel):
    speechThreshold: Annotated[float, Field(gt=0, lt=1)]
    negativeThreshold: Annotated[float, Field(gt=0, lt=1)]
    minSpeechUs: Annotated[str, AfterValidator(partial(text_rules, minimum=0, maximum=10, patterns=("^(0|[1-9][0-9]*)$(?![\\s\\S])",)))]
    minSilenceUs: Annotated[str, AfterValidator(partial(text_rules, minimum=0, maximum=10, patterns=("^(0|[1-9][0-9]*)$(?![\\s\\S])",)))]
    paddingUs: Annotated[str, AfterValidator(partial(text_rules, minimum=0, maximum=10, patterns=("^(0|[1-9][0-9]*)$(?![\\s\\S])",)))]

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "less", "left": "negativeThreshold", "right": "speechThreshold", "decimal": False}, {"kind": "positive", "field": "minSpeechUs", "decimal": True}, {"kind": "positive", "field": "minSilenceUs", "decimal": True}, {"kind": "maximum", "field": "minSpeechUs", "value": "1800000000", "decimal": True}, {"kind": "maximum", "field": "minSilenceUs", "value": "1800000000", "decimal": True}, {"kind": "maximum", "field": "paddingUs", "value": "1000000", "decimal": True}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class SpeechAnalysisProvenance(ContractModel):
    adapterVersion: Literal["silero-onnx-stream-v1"]
    modelName: Literal["silero-vad"]
    modelVersion: Literal["v6-faster-whisper-1.2.1"]
    modelSha256: Literal["4cbf549b8326f60f80f2536d9eefeb450a9abe83365a098031c89719f1be17d2"]
    runtime: Literal["onnxruntime"]
    runtimeVersion: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=32, patterns=("^[a-zA-Z0-9][a-zA-Z0-9._-]*$(?![\\s\\S])",)))]
    numpyVersion: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=32, patterns=("^[a-zA-Z0-9][a-zA-Z0-9._-]*$(?![\\s\\S])",)))]
    normalizedPcmSha256: Annotated[str, AfterValidator(partial(text_rules, minimum=0, maximum=None, patterns=("^[0-9a-f]{64}$(?![\\s\\S])",)))]
    configuration: SpeechAnalysisProvenanceConfiguration
    sampleRate: Literal[16000]
    windowSamples: Literal[512]
    contextSamples: Literal[64]
    threads: Literal[1]
    device: Literal["cpu"]
    confidenceAggregation: Literal["sample_weighted_mean_in_padded_region"]


class SpeechAnalysis(ContractModel):
    schemaVersion: Literal[1]
    source: SpeechAnalysisSource
    speechRegions: Annotated[list[SpeechRegion], Field(min_length=0, max_length=56250)]
    provenance: SpeechAnalysisProvenance

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "orderedRanges", "field": "speechRegions", "start": "startUs", "end": "endUs"}, {"kind": "rangesWithin", "field": "speechRegions", "lower": "source.scopeStartUs", "upper": "source.scopeEndUs", "start": "startUs", "end": "endUs"}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class Loudness(ContractModel):
    integratedLufs: Annotated[float, Field(ge=-200, le=100)] | None = None
    truePeakDbtp: Annotated[float, Field(ge=-200, le=100)] | None = None
    loudnessRangeLu: Annotated[float, Field(ge=0, le=200)] | None = None

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if len(self.model_fields_set) < 1 or not check_rules(self, []):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class EnergyPoint(ContractModel):
    atUs: Time
    rmsDbfs: Annotated[float, Field(ge=-200, le=0)]


class WaveformPeak(ContractModel):
    atUs: Time
    minimum: Annotated[float, Field(ge=-1, le=1)]
    maximum: Annotated[float, Field(ge=-1, le=1)]

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "lessEqual", "left": "minimum", "right": "maximum", "decimal": False}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class ShortTermLoudnessPoint(ContractModel):
    atUs: Time
    lufs: Annotated[float, Field(ge=-200, le=100)]


class AudioAnalysis(ContractModel):
    speech: SpeechAnalysis | None = None
    silence: Annotated[list[TimeRange], Field(min_length=0, max_length=56250)] | None = None
    loudness: Loudness | None = None
    energyCurve: Annotated[list[EnergyPoint], Field(min_length=0, max_length=108000)] | None = None
    waveformPeaks: Annotated[list[WaveformPeak], Field(min_length=0, max_length=108000)] | None = None
    shortTermLoudness: Annotated[list[ShortTermLoudnessPoint], Field(min_length=0, max_length=1800)] | None = None

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if len(self.model_fields_set) < 1 or not check_rules(self, [{"kind": "orderedRanges", "field": "silence", "start": "startUs", "end": "endUs"}, {"kind": "orderedPoints", "field": "energyCurve", "time": "atUs"}, {"kind": "orderedPoints", "field": "waveformPeaks", "time": "atUs"}, {"kind": "orderedPoints", "field": "shortTermLoudness", "time": "atUs"}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class Scene(ContractModel):
    id: LogicalId
    startUs: Time
    endUs: Time
    confidence: Annotated[float, Field(ge=0, le=1)]

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "less", "left": "startUs", "right": "endUs", "decimal": True}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class SceneAnalysis(ContractModel):
    scenes: Annotated[list[Scene], Field(min_length=0, max_length=108000)]

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "orderedRanges", "field": "scenes", "start": "startUs", "end": "endUs"}, {"kind": "unique", "field": "scenes", "key": "id"}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class FaceObservation(ContractModel):
    atUs: Time
    boundingBox: BoundingBox
    confidence: Annotated[float, Field(ge=0, le=1)]


class FaceTrack(ContractModel):
    id: LogicalId
    startUs: Time
    endUs: Time
    observations: Annotated[list[FaceObservation], Field(min_length=1, max_length=108000)]

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "less", "left": "startUs", "right": "endUs", "decimal": True}, {"kind": "orderedPoints", "field": "observations", "time": "atUs"}, {"kind": "pointsWithin", "field": "observations", "lower": "startUs", "upper": "endUs", "time": "atUs"}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class FaceAnalysis(ContractModel):
    tracks: Annotated[list[FaceTrack], Field(min_length=0, max_length=128)]

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "unique", "field": "tracks", "key": "id"}, {"kind": "nestedCount", "field": "tracks", "child": "observations", "maximum": 108000}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class ObjectObservation(ContractModel):
    atUs: Time
    boundingBox: BoundingBox
    confidence: Annotated[float, Field(ge=0, le=1)]


class ObjectTrack(ContractModel):
    id: LogicalId
    label: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=128, patterns=("^[^\\ud800-\\udfff]*$(?![\\s\\S])",)))]
    startUs: Time
    endUs: Time
    observations: Annotated[list[ObjectObservation], Field(min_length=1, max_length=108000)]

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "less", "left": "startUs", "right": "endUs", "decimal": True}, {"kind": "orderedPoints", "field": "observations", "time": "atUs"}, {"kind": "pointsWithin", "field": "observations", "lower": "startUs", "upper": "endUs", "time": "atUs"}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class ObjectAnalysis(ContractModel):
    tracks: Annotated[list[ObjectTrack], Field(min_length=0, max_length=1024)]

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "unique", "field": "tracks", "key": "id"}, {"kind": "nestedCount", "field": "tracks", "child": "observations", "maximum": 108000}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class MediaAnalysisSource(ContractModel):
    sha256: Annotated[str, AfterValidator(partial(text_rules, minimum=64, maximum=64, patterns=("^[0-9a-f]{64}$(?![\\s\\S])",)))]
    durationUs: Time | None = None

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "positive", "field": "durationUs", "decimal": True}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self


class MediaAnalysisDocumentProvenance(ContractModel):
    producer: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=128, patterns=("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])",)))]
    producerVersion: Annotated[str, AfterValidator(partial(text_rules, minimum=1, maximum=128, patterns=("^[a-zA-Z0-9][a-zA-Z0-9._+-]*$(?![\\s\\S])",)))]


class MetadataNotAvailable(ContractModel):
    status: Literal["not_available"]


class MetadataCompleted(ContractModel):
    status: Literal["completed"]
    data: MediaMetadata
    provenance: AnalyzerProvenance


class MetadataFailed(ContractModel):
    status: Literal["failed"]
    failure: Failure


MetadataSection: TypeAlias = MetadataNotAvailable | MetadataCompleted | MetadataFailed

class TranscriptNotAvailable(ContractModel):
    status: Literal["not_available"]


class TranscriptCompleted(ContractModel):
    status: Literal["completed"]
    data: Transcript
    provenance: AnalyzerProvenance


class TranscriptFailed(ContractModel):
    status: Literal["failed"]
    failure: Failure


TranscriptSection: TypeAlias = TranscriptNotAvailable | TranscriptCompleted | TranscriptFailed

class AudioNotAvailable(ContractModel):
    status: Literal["not_available"]


class AudioCompleted(ContractModel):
    status: Literal["completed"]
    data: AudioAnalysis
    provenance: AnalyzerProvenance


class AudioFailed(ContractModel):
    status: Literal["failed"]
    failure: Failure


AudioSection: TypeAlias = AudioNotAvailable | AudioCompleted | AudioFailed

class ScenesNotAvailable(ContractModel):
    status: Literal["not_available"]


class ScenesCompleted(ContractModel):
    status: Literal["completed"]
    data: SceneAnalysis
    provenance: AnalyzerProvenance


class ScenesFailed(ContractModel):
    status: Literal["failed"]
    failure: Failure


ScenesSection: TypeAlias = ScenesNotAvailable | ScenesCompleted | ScenesFailed

class FacesNotAvailable(ContractModel):
    status: Literal["not_available"]


class FacesCompleted(ContractModel):
    status: Literal["completed"]
    data: FaceAnalysis
    provenance: AnalyzerProvenance


class FacesFailed(ContractModel):
    status: Literal["failed"]
    failure: Failure


FacesSection: TypeAlias = FacesNotAvailable | FacesCompleted | FacesFailed

class ObjectsNotAvailable(ContractModel):
    status: Literal["not_available"]


class ObjectsCompleted(ContractModel):
    status: Literal["completed"]
    data: ObjectAnalysis
    provenance: AnalyzerProvenance


class ObjectsFailed(ContractModel):
    status: Literal["failed"]
    failure: Failure


ObjectsSection: TypeAlias = ObjectsNotAvailable | ObjectsCompleted | ObjectsFailed

class MediaAnalysisSections(ContractModel):
    metadata: MetadataSection
    transcript: TranscriptSection
    audio: AudioSection
    scenes: ScenesSection
    faces: FacesSection
    objects: ObjectsSection


class MediaAnalysis(ContractModel):
    schemaVersion: Literal["1.0.0"]
    mediaAssetId: UuidV7
    source: MediaAnalysisSource
    provenance: MediaAnalysisDocumentProvenance
    sections: MediaAnalysisSections

    @model_validator(mode="after")
    def validate_contract(self) -> Self:
        if not check_rules(self, [{"kind": "sameWhenPresent", "left": "source.sha256", "right": "sections.metadata.provenance.sourceSha256"}, {"kind": "sameWhenPresent", "left": "source.sha256", "right": "sections.transcript.provenance.sourceSha256"}, {"kind": "sameWhenPresent", "left": "source.sha256", "right": "sections.audio.provenance.sourceSha256"}, {"kind": "sameWhenPresent", "left": "source.sha256", "right": "sections.scenes.provenance.sourceSha256"}, {"kind": "sameWhenPresent", "left": "source.sha256", "right": "sections.faces.provenance.sourceSha256"}, {"kind": "sameWhenPresent", "left": "source.sha256", "right": "sections.objects.provenance.sourceSha256"}, {"kind": "sameWhenPresent", "left": "source.durationUs", "right": "sections.metadata.data.durationUs"}, {"kind": "sameWhenPresent", "left": "source.sha256", "right": "sections.audio.data.speech.source.sourceSha256"}, {"kind": "sameWhenPresent", "left": "source.durationUs", "right": "sections.audio.data.speech.source.sourceDurationUs"}, {"kind": "timesWithin", "fields": ["sections.transcript.data", "sections.audio.data", "sections.scenes.data", "sections.faces.data", "sections.objects.data"], "duration": "source.durationUs", "timeKeys": ["startUs", "endUs", "atUs", "scopeStartUs", "scopeEndUs"]}]):
            raise ValueError("Canonical schema relational constraint failed")
        return self
