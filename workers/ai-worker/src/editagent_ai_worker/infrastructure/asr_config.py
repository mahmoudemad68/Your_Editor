"""Typed, bounded ASR deployment settings; callers cannot select arbitrary models/code."""

import sys
from pathlib import Path
from typing import Literal

from pydantic import Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class AsrSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="EDITAGENT_ASR_", extra="forbid")
    model: Literal["tiny", "small"] = "small"
    model_root: Path = Path(sys.prefix) / "share" / "editagent" / "asr-models"
    device: Literal["cpu", "cuda"] = "cpu"
    compute_type: Literal["int8", "float16", "int8_float16"] = "int8"
    cpu_fallback: bool = True
    cpu_threads: int = Field(default=2, ge=1, le=8)
    beam_size: int = Field(default=5, ge=1, le=10)
    timeout_ms: int = Field(default=600_000, ge=1, le=600_000)
    chunk_us: int = Field(default=24_000_000, ge=5_000_000, le=30_000_000)
    overlap_us: int = Field(default=2_000_000, ge=0, le=5_000_000)
    speech_threshold: float = Field(default=0.5, gt=0, lt=1, allow_inf_nan=False)
    negative_threshold: float = Field(default=0.35, gt=0, lt=1, allow_inf_nan=False)
    min_silence_ms: int = Field(default=200, ge=1, le=10_000)
    speech_padding_ms: int = Field(default=100, ge=0, le=1000)
    seed: int = Field(default=0, ge=0, le=2147483647)

    @model_validator(mode="after")
    def compatible(self) -> "AsrSettings":
        if self.device == "cpu" and self.compute_type != "int8":
            raise ValueError("CPU ASR requires int8")
        if self.overlap_us * 2 >= self.chunk_us:
            raise ValueError("Chunk overlap must leave an owned interior")
        if self.chunk_us + 2 * self.overlap_us > 30_000_000:
            raise ValueError("ASR context must fit the bounded model alignment window")
        if self.negative_threshold >= self.speech_threshold:
            raise ValueError("Invalid VAD hysteresis")
        return self

    @property
    def model_path(self) -> Path:
        return self.model_root / self.model
