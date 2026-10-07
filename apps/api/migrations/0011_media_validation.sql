-- US-127: inspection is technical metadata, never a security verdict.
ALTER TABLE media_assets
  ADD COLUMN validation_status text NOT NULL DEFAULT 'pending',
  ADD COLUMN validation_policy_signature text,
  ADD COLUMN validation_source_sha256 text,
  ADD COLUMN validation_checked_at bigint,
  ADD COLUMN validation_rejection_code text,
  ADD CONSTRAINT media_assets_validation_status CHECK (validation_status IN ('pending','validated','rejected')),
  ADD CONSTRAINT media_assets_validation_shape CHECK (
    (validation_status = 'pending' AND validation_policy_signature IS NULL AND validation_source_sha256 IS NULL AND validation_checked_at IS NULL AND validation_rejection_code IS NULL)
    OR (validation_status IN ('validated','rejected') AND validation_policy_signature IS NOT NULL AND validation_source_sha256 IS NOT NULL AND validation_policy_signature ~ '^[0-9a-f]{64}$' AND validation_source_sha256 = content_sha256 AND validation_checked_at IS NOT NULL AND validation_checked_at BETWEEN created_at AND updated_at
      AND ((validation_status = 'validated' AND inspection_status = 'completed' AND validation_rejection_code IS NULL)
        OR (validation_status = 'rejected' AND validation_rejection_code IS NOT NULL AND validation_rejection_code IN ('empty_media','invalid_signature','unsupported_container','unsupported_codec','duration_limit_exceeded','resolution_limit_exceeded','stream_count_limit_exceeded','file_size_limit_exceeded','bitrate_limit_exceeded','invalid_metadata','corrupt_media','decode_validation_failed','resource_limit_exceeded','unsafe_external_reference','source_identity_mismatch'))))
  );
CREATE INDEX media_assets_validation_pending ON media_assets (validation_status, id) WHERE validation_status = 'pending';
