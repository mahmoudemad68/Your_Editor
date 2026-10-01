-- US-122 direct upload. Duration stays null until US-126 inspects the file.
-- There is no UploadSession or UploadPart table. Those belong to US-123.

CREATE TABLE media_assets (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects (id),
  kind text NOT NULL,
  storage_key text NOT NULL,
  display_filename text NOT NULL,
  mime_type text NOT NULL,
  byte_size bigint NOT NULL,
  content_sha256 text NOT NULL,
  upload_state text NOT NULL,
  duration bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CONSTRAINT media_assets_kind CHECK (kind IN ('video', 'audio', 'image')),
  CONSTRAINT media_assets_mime CHECK (
    mime_type IN ('video/mp4', 'video/quicktime', 'video/x-matroska', 'video/webm')
  ),
  CONSTRAINT media_assets_byte_size CHECK (byte_size >= 1 AND byte_size <= 4294967296),
  CONSTRAINT media_assets_sha256 CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT media_assets_upload_state CHECK (upload_state = 'uploaded'),
  CONSTRAINT media_assets_storage_key CHECK (
    storage_key ~ '^projects/[0-9a-f-]{36}/media/sha256/[0-9a-f]{64}$'
  ),
  CONSTRAINT media_assets_filename CHECK (
    length(display_filename) BETWEEN 1 AND 255
  ),
  CONSTRAINT media_assets_audit_order CHECK (created_at <= updated_at),
  CONSTRAINT media_assets_duration CHECK (
    duration IS NULL OR (duration >= 0 AND duration <= 1800000000)
  ),
  CONSTRAINT media_assets_project_key UNIQUE (project_id, storage_key)
);

CREATE INDEX media_assets_project_id ON media_assets (project_id);
