-- US-126 technical inspection. This is not the US-127 validation state.
-- Existing uploaded rows stay pending. Duration remains null until a successful probe.

ALTER TABLE media_assets
  ADD COLUMN inspection_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN container text,
  ADD COLUMN video_codec text,
  ADD COLUMN audio_codec text,
  ADD COLUMN width integer,
  ADD COLUMN height integer,
  ADD COLUMN display_width integer,
  ADD COLUMN display_height integer,
  ADD COLUMN rotation integer,
  ADD COLUMN frame_rate_numerator bigint,
  ADD COLUMN frame_rate_denominator bigint,
  ADD COLUMN frame_rate_mode text,
  ADD COLUMN color_space text,
  ADD COLUMN audio_channels integer,
  ADD COLUMN sample_rate integer,
  ADD COLUMN streams jsonb,
  ADD COLUMN inspection_error text;

ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_inspection_status
    CHECK (inspection_status IN ('pending', 'completed', 'failed')),
  ADD CONSTRAINT media_assets_rotation
    CHECK (rotation IS NULL OR rotation IN (0, 90, 180, 270)),
  ADD CONSTRAINT media_assets_frame_rate_mode
    CHECK (
      frame_rate_mode IS NULL
      OR frame_rate_mode IN ('constant', 'variable', 'unknown')
    ),
  ADD CONSTRAINT media_assets_frame_rate
    CHECK (
      (
        frame_rate_numerator IS NULL
        AND frame_rate_denominator IS NULL
      )
      OR (
        frame_rate_numerator > 0
        AND frame_rate_denominator > 0
      )
    ),
  ADD CONSTRAINT media_assets_dimensions
    CHECK (
      (
        width IS NULL
        AND height IS NULL
        AND display_width IS NULL
        AND display_height IS NULL
      )
      OR (
        width > 0
        AND height > 0
        AND display_width > 0
        AND display_height > 0
      )
    ),
  ADD CONSTRAINT media_assets_audio_channels
    CHECK (audio_channels IS NULL OR audio_channels > 0),
  ADD CONSTRAINT media_assets_sample_rate
    CHECK (sample_rate IS NULL OR sample_rate > 0),
  ADD CONSTRAINT media_assets_streams_array
    CHECK (streams IS NULL OR jsonb_typeof(streams) = 'array'),
  ADD CONSTRAINT media_assets_inspection_error
    CHECK (
      inspection_error IS NULL
      OR inspection_error IN (
        'timeout',
        'not_found',
        'exit',
        'invalid_json',
        'invalid_result',
        'object_missing',
        'interrupted',
        'insufficient_storage'
      )
    ),
  ADD CONSTRAINT media_assets_inspection_shape
    CHECK (
      (
        inspection_status = 'pending'
        AND container IS NULL
        AND video_codec IS NULL
        AND audio_codec IS NULL
        AND width IS NULL
        AND height IS NULL
        AND display_width IS NULL
        AND display_height IS NULL
        AND rotation IS NULL
        AND frame_rate_numerator IS NULL
        AND frame_rate_denominator IS NULL
        AND frame_rate_mode IS NULL
        AND color_space IS NULL
        AND audio_channels IS NULL
        AND sample_rate IS NULL
        AND streams IS NULL
        AND inspection_error IS NULL
      )
      OR (
        inspection_status = 'failed'
        AND container IS NULL
        AND video_codec IS NULL
        AND audio_codec IS NULL
        AND width IS NULL
        AND height IS NULL
        AND display_width IS NULL
        AND display_height IS NULL
        AND rotation IS NULL
        AND frame_rate_numerator IS NULL
        AND frame_rate_denominator IS NULL
        AND frame_rate_mode IS NULL
        AND color_space IS NULL
        AND audio_channels IS NULL
        AND sample_rate IS NULL
        AND streams IS NULL
        AND inspection_error IS NOT NULL
      )
      OR (
        inspection_status = 'completed'
        AND inspection_error IS NULL
        AND frame_rate_mode IS NOT NULL
      )
    );
