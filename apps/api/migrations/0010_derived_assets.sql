-- US-128: stored results, not a new media entity. Millisecond audit timestamps.
CREATE TABLE derived_assets (
  id uuid PRIMARY KEY CHECK (substring(id::text, 15, 1) = '7'),
  media_asset_id uuid NOT NULL,
  project_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('proxy', 'extracted-audio', 'thumbnail')),
  storage_key text NOT NULL UNIQUE,
  parameter_signature text NOT NULL CHECK (parameter_signature ~ '^[0-9a-f]{64}$'),
  mime_type text NOT NULL CHECK (mime_type IN ('video/mp4', 'audio/wav', 'image/jpeg')),
  CONSTRAINT derived_assets_mime_kind CHECK (
    (kind = 'proxy' AND mime_type = 'video/mp4') OR
    (kind = 'extracted-audio' AND mime_type = 'audio/wav') OR
    (kind = 'thumbnail' AND mime_type = 'image/jpeg')
  ),
  byte_size bigint NOT NULL CHECK (byte_size > 0 AND byte_size <= 68719476736),
  content_sha256 text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb NOT NULL CHECK (jsonb_typeof(metadata) = 'object'),
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL CHECK (updated_at >= created_at),
  FOREIGN KEY (media_asset_id, project_id) REFERENCES media_assets (id, project_id),
  CONSTRAINT derived_assets_signature UNIQUE (media_asset_id, kind, parameter_signature),
  CONSTRAINT derived_assets_owned_key CHECK (
    storage_key = 'projects/' || project_id::text || '/derived/' || media_asset_id::text || '/' || kind || '/' || parameter_signature || '/' || (metadata->>'variant') ||
      CASE WHEN kind = 'proxy' THEN '.mp4' WHEN kind = 'extracted-audio' THEN '.wav' ELSE '.jpg' END
    AND metadata->>'variant' IS NOT NULL
    AND jsonb_typeof(metadata->'parameters') = 'object'
    AND metadata ? 'parameters'
    AND metadata->>'variant' IN ('proxy', 'asr', 'mix', 'poster', 'sprite')
    AND (kind, metadata->>'variant') IN (('proxy','proxy'), ('extracted-audio','asr'), ('extracted-audio','mix'), ('thumbnail','poster'), ('thumbnail','sprite')))
);
CREATE INDEX derived_assets_project_source ON derived_assets (project_id, media_asset_id);
-- Identity and persisted output are immutable; repair missing objects at the same key.
CREATE FUNCTION reject_derived_asset_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Derived artifacts are immutable' USING ERRCODE = '23514';
END;
$$;
CREATE TRIGGER derived_assets_immutable BEFORE UPDATE ON derived_assets
  FOR EACH ROW EXECUTE FUNCTION reject_derived_asset_mutation();
