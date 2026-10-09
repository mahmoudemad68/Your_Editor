"""Process-level typed settings. Defaults are configuration, not adapter constants."""

from pathlib import Path

from pydantic import Field, ValidationError
from pydantic_settings import BaseSettings, SettingsConfigDict

from editagent_ai_worker.domain.analysis.voice_activity import VadConfiguration, VadModelError
from editagent_ai_worker.infrastructure.vad_model import default_model_path


class VadSettings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="EDITAGENT_VAD_", extra="forbid", env_file=None)
    speech_threshold: float = Field(default=0.5, gt=0, lt=1, allow_inf_nan=False)
    negative_threshold: float = Field(default=0.35, gt=0, lt=1, allow_inf_nan=False)
    min_speech_us: int = Field(default=100_000, ge=1, le=1_800_000_000)
    min_silence_us: int = Field(default=200_000, ge=1, le=1_800_000_000)
    padding_us: int = Field(default=100_000, ge=0, le=1_000_000)
    timeout_ms: int = Field(default=120_000, ge=1, le=600_000)
    model_path: Path = Field(default_factory=default_model_path)

    def configuration(self) -> VadConfiguration:
        return VadConfiguration(
            self.speech_threshold,
            self.negative_threshold,
            self.min_speech_us,
            self.min_silence_us,
            self.padding_us,
        )


def load_vad_settings() -> VadSettings:
    try:
        settings = VadSettings()
        settings.configuration()  # Cross-field hysteresis constraints validated at startup.
        return settings
    except (ValueError, ValidationError) as exc:
        raise VadModelError("Invalid voice-activity configuration") from exc
