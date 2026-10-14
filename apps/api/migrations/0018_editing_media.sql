-- US-222: an explicit immutable edited-video artifact, never mislabeled as proxy.
ALTER TABLE derived_assets DROP CONSTRAINT derived_assets_kind_check;
ALTER TABLE derived_assets ADD CONSTRAINT derived_assets_kind_check
  CHECK (kind IN ('proxy','extracted-audio','thumbnail','edited-video'));
ALTER TABLE derived_assets DROP CONSTRAINT derived_assets_mime_kind;
ALTER TABLE derived_assets ADD CONSTRAINT derived_assets_mime_kind CHECK (
  (kind IN ('proxy','edited-video') AND mime_type='video/mp4') OR
  (kind='extracted-audio' AND mime_type='audio/wav') OR
  (kind='thumbnail' AND mime_type='image/jpeg'));
ALTER TABLE derived_assets DROP CONSTRAINT derived_assets_owned_key;
ALTER TABLE derived_assets ADD CONSTRAINT derived_assets_owned_key CHECK (
  metadata->>'variant' IS NOT NULL AND metadata ? 'parameters'
  AND jsonb_typeof(metadata->'parameters')='object'
  AND (
    (kind='edited-video' AND metadata->>'variant'='edit' AND byte_size<=1073741824
      AND storage_key='projects/'||project_id::text||'/derived/'||media_asset_id::text||'/edited-video/'||parameter_signature||'/'||content_sha256||'.mp4')
    OR (kind<>'edited-video' AND storage_key='projects/'||project_id::text||'/derived/'||media_asset_id::text||'/'||kind||'/'||parameter_signature||'/'||(metadata->>'variant')||
      CASE WHEN kind='proxy' THEN '.mp4' WHEN kind='extracted-audio' THEN '.wav' ELSE '.jpg' END
      AND (kind,metadata->>'variant') IN (('proxy','proxy'),('extracted-audio','asr'),('extracted-audio','mix'),('thumbnail','poster'),('thumbnail','sprite')))
  ));
-- The current canonical Timeline snapshot is an application boundary for proposals,
-- not a new model or an automatic edit API. Updates require validated value/CAS.
CREATE TABLE editing_timelines (
  id uuid PRIMARY KEY CHECK(substring(id::text,15,1)='7'),
  project_id uuid NOT NULL REFERENCES projects(id),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  state_sha256 text NOT NULL CHECK(state_sha256 ~ '^[0-9a-f]{64}$'),
  CHECK(snapshot->>'id'=id::text AND snapshot->>'projectId'=project_id::text));
-- Persist the exact output identity before S3 publication. Retry recovers an uploaded
-- object after a crash without creating a second DerivedAsset or changing its key.
CREATE TABLE editing_output_intents (
  execution_id uuid PRIMARY KEY REFERENCES tool_executions(id),
  asset_id uuid GENERATED ALWAYS AS ((descriptor->'asset'->>'id')::uuid) STORED UNIQUE NOT NULL,
  descriptor jsonb NOT NULL CHECK(jsonb_typeof(descriptor)='object'),
  descriptor_sha256 text NOT NULL CHECK(descriptor_sha256 ~ '^[0-9a-f]{64}$'),
  published boolean NOT NULL DEFAULT false,
  discarded boolean NOT NULL DEFAULT false,
  CHECK (NOT (published AND discarded)));
CREATE FUNCTION editing_output_intent_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.execution_id<>OLD.execution_id OR NEW.descriptor<>OLD.descriptor
    OR NEW.descriptor_sha256<>OLD.descriptor_sha256 OR (OLD.published AND NOT NEW.published) OR (OLD.discarded AND NOT NEW.discarded)
  THEN RAISE EXCEPTION 'Editing publication identity is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER editing_output_intent_immutable BEFORE UPDATE ON editing_output_intents
  FOR EACH ROW EXECUTE FUNCTION editing_output_intent_immutable();
-- Evaluate the durable deadline again at commit, including a slow/blocked INSERT.
-- Existing published assets remain immutable and do not require a second insertion.
CREATE FUNCTION edited_video_admission_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='edited-video' AND NOT EXISTS (
    SELECT 1 FROM editing_output_intents i JOIN tool_executions e ON e.id=i.execution_id
      JOIN jobs j ON j.id=e.job_id JOIN projects p ON p.id=e.project_id
      JOIN project_memberships m ON m.project_id=p.id AND m.user_id=e.caller_id
    WHERE i.asset_id=NEW.id AND i.published AND NOT i.discarded
      AND e.project_id=NEW.project_id AND p.deleted_at IS NULL AND m.role IN ('owner','editor')
      AND e.outcome='running' AND e.stop_code IS NULL AND j.status='Running'
      AND e.admission_deadline_at_ms>(extract(epoch FROM clock_timestamp())*1000)::bigint
      AND i.descriptor->'asset'->'artifact'->>'storageKey'=NEW.storage_key
      AND i.descriptor->'asset'->'artifact'->>'parameterSignature'=NEW.parameter_signature
      AND i.descriptor->'asset'->'artifact'->>'sha256'=NEW.content_sha256)
  THEN RAISE EXCEPTION 'Editing publication admission fenced' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE CONSTRAINT TRIGGER edited_video_admission_fence AFTER INSERT ON derived_assets
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION edited_video_admission_fence();
