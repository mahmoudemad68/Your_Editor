-- US-123. UploadPart rows, never the cached count, determine resume/completion.
CREATE TABLE upload_sessions (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  user_id uuid NOT NULL REFERENCES users(id),
  media_asset_id uuid REFERENCES media_assets(id),
  storage_key text NOT NULL,
  multipart_upload_id text NOT NULL,
  filename text NOT NULL CHECK (length(filename) BETWEEN 1 AND 255 AND filename !~ '[/\\]'),
  mime_type text NOT NULL CHECK (mime_type IN ('video/mp4','video/quicktime','video/x-matroska','video/webm')),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 4294967296),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  part_size integer NOT NULL CHECK (part_size = 16777216),
  status text NOT NULL CHECK (status IN ('active','completing','completed','aborted','expired','failed')),
  completed_part_count integer NOT NULL DEFAULT 0 CHECK (completed_part_count BETWEEN 0 AND 256),
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CHECK (created_at <= updated_at AND created_at < expires_at),
  CHECK ((status = 'completed') = (media_asset_id IS NOT NULL)),
  CHECK (storage_key = 'projects/' || project_id::text || '/media/sha256/' || sha256)
);
CREATE INDEX upload_sessions_creator ON upload_sessions(project_id,user_id,sha256,created_at DESC);
CREATE INDEX upload_sessions_expiry ON upload_sessions(expires_at) WHERE status IN ('active','completing');
CREATE TABLE upload_parts (
  upload_session_id uuid NOT NULL REFERENCES upload_sessions(id),
  part_number integer NOT NULL CHECK (part_number BETWEEN 1 AND 256),
  etag text NOT NULL CHECK (length(etag) BETWEEN 1 AND 200),
  byte_size bigint NOT NULL CHECK (byte_size BETWEEN 1 AND 16777216),
  checksum text,
  completed_at bigint NOT NULL,
  PRIMARY KEY (upload_session_id,part_number)
);
-- Enforce immutability and parent bounds even for erroneous repository calls.
CREATE FUNCTION guard_upload_part() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE session upload_sessions%ROWTYPE;
BEGIN
  SELECT * INTO session FROM upload_sessions WHERE id=NEW.upload_session_id FOR UPDATE;
  IF session.status <> 'active' OR NEW.part_number > ceil(session.byte_size::numeric/session.part_size)
     OR NEW.byte_size <> least(session.part_size,session.byte_size-(NEW.part_number-1)::bigint*session.part_size)
     OR NEW.completed_at < session.created_at THEN
    RAISE EXCEPTION 'invalid upload part';
  END IF;
  IF TG_OP='UPDATE' AND (NEW.upload_session_id,NEW.part_number,NEW.etag,NEW.byte_size,NEW.checksum,NEW.completed_at)
       IS DISTINCT FROM (OLD.upload_session_id,OLD.part_number,OLD.etag,OLD.byte_size,OLD.checksum,OLD.completed_at) THEN
    RAISE EXCEPTION 'upload part is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER upload_part_guard BEFORE INSERT OR UPDATE ON upload_parts FOR EACH ROW EXECUTE FUNCTION guard_upload_part();
CREATE FUNCTION guard_upload_session() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.project_id,NEW.user_id,NEW.storage_key,NEW.multipart_upload_id,NEW.filename,NEW.mime_type,NEW.byte_size,NEW.sha256,NEW.part_size,NEW.created_at,NEW.expires_at)
     IS DISTINCT FROM (OLD.id,OLD.project_id,OLD.user_id,OLD.storage_key,OLD.multipart_upload_id,OLD.filename,OLD.mime_type,OLD.byte_size,OLD.sha256,OLD.part_size,OLD.created_at,OLD.expires_at) THEN
    RAISE EXCEPTION 'upload identity is immutable';
  END IF;
  IF NEW.status <> OLD.status AND NOT (
     (OLD.status='active' AND NEW.status IN ('completing','aborted','expired')) OR
     (OLD.status='completing' AND NEW.status IN ('completed','failed','expired'))
  ) THEN RAISE EXCEPTION 'invalid upload session transition'; END IF;
  IF OLD.status IN ('completed','aborted','expired','failed') AND NEW.media_asset_id IS DISTINCT FROM OLD.media_asset_id THEN
    RAISE EXCEPTION 'terminal upload session is immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER upload_session_guard BEFORE UPDATE ON upload_sessions FOR EACH ROW EXECUTE FUNCTION guard_upload_session();
-- A completed session cannot refer to a MediaAsset in another project.
CREATE UNIQUE INDEX media_assets_id_project ON media_assets(id,project_id);
ALTER TABLE upload_sessions ADD CONSTRAINT upload_sessions_media_project
  FOREIGN KEY(media_asset_id,project_id) REFERENCES media_assets(id,project_id);
