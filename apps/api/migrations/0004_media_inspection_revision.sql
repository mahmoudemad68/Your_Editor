-- Inspection concurrency token. It is not media time and not updated_at.
-- Existing rows, whether pending, completed, or failed, start at revision zero.

ALTER TABLE media_assets
  ADD COLUMN inspection_revision bigint NOT NULL DEFAULT 0;

ALTER TABLE media_assets
  ADD CONSTRAINT media_assets_inspection_revision
    CHECK (inspection_revision >= 0);
