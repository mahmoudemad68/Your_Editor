-- US-210: durable section jobs and publication intent. JSON remains schema-owned.
CREATE TABLE media_analyses (
  media_asset_id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  source_sha256 text NOT NULL CHECK(source_sha256 ~ '^[0-9a-f]{64}$'),
  document jsonb NOT NULL CHECK(document->>'schemaVersion' IN ('1.0.0','1.1.0')),
  revision bigint NOT NULL DEFAULT 0,
  FOREIGN KEY(media_asset_id,project_id) REFERENCES media_assets(id,project_id),
  CHECK(document->>'mediaAssetId'=media_asset_id::text),
  CHECK(document->'source'->>'sha256'=source_sha256)
);
CREATE TABLE analysis_tasks (
  job_id uuid PRIMARY KEY REFERENCES jobs(id),
  media_asset_id uuid NOT NULL REFERENCES media_analyses(media_asset_id),
  analyzer text NOT NULL CHECK(analyzer IN ('transcript','audio','speech')),
  configuration_sha256 text NOT NULL CHECK(configuration_sha256 ~ '^[0-9a-f]{64}$'),
  configuration jsonb NOT NULL CHECK(jsonb_typeof(configuration)='object'),
  inference_parameters jsonb CHECK(inference_parameters IS NULL OR jsonb_typeof(inference_parameters)='object'),
  generation bigint NOT NULL CHECK(generation>=1),
  input_artifact_id uuid NOT NULL REFERENCES derived_assets(id),
  initiated_by uuid REFERENCES users(id),
  result jsonb,
  result_attempt integer CHECK(result_attempt IS NULL OR result_attempt>0),
  CHECK((result IS NULL)=(result_attempt IS NULL)),
  failure jsonb CHECK(failure IS NULL OR jsonb_typeof(failure)='object'),
  applied boolean NOT NULL DEFAULT false,
  published boolean NOT NULL DEFAULT false,
  publication_lease_until_ms bigint NOT NULL DEFAULT 0,
  deadline_at_ms bigint NOT NULL DEFAULT ((extract(epoch FROM clock_timestamp())*1000)::bigint+600000),
  UNIQUE(media_asset_id,analyzer,generation)
);
CREATE INDEX analysis_tasks_pending ON analysis_tasks(published,publication_lease_until_ms);
CREATE FUNCTION analysis_result_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.configuration IS DISTINCT FROM OLD.configuration OR NEW.configuration_sha256 IS DISTINCT FROM OLD.configuration_sha256
    OR NEW.generation IS DISTINCT FROM OLD.generation OR NEW.input_artifact_id IS DISTINCT FROM OLD.input_artifact_id
    OR NEW.media_asset_id IS DISTINCT FROM OLD.media_asset_id OR NEW.analyzer IS DISTINCT FROM OLD.analyzer
    OR NEW.initiated_by IS DISTINCT FROM OLD.initiated_by
    OR NEW.deadline_at_ms IS DISTINCT FROM OLD.deadline_at_ms OR NEW.job_id IS DISTINCT FROM OLD.job_id THEN
    RAISE EXCEPTION 'Analysis intent is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.result IS NOT NULL AND (NEW.result IS DISTINCT FROM OLD.result
    OR NEW.result_attempt IS DISTINCT FROM OLD.result_attempt
    OR NEW.inference_parameters IS DISTINCT FROM OLD.inference_parameters) THEN
    RAISE EXCEPTION 'Analysis result is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER analysis_result_fence BEFORE UPDATE ON analysis_tasks
  FOR EACH ROW EXECUTE FUNCTION analysis_result_fence();

-- Check at COMMIT as well as in the worker: cancellation/revocation can race inference.
CREATE FUNCTION analysis_result_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- A previous worker may still receive a new algorithm's job during rollout.
  -- Require acknowledgment of the admitted implementation at the durable
  -- receipt boundary, not merely a matching model/configuration payload hash.
  -- Recorded legacy documents remain readable; pending pre-repair intents
  -- cannot acquire a new completion without a supported runtime identity.
  IF NEW.result IS DISTINCT FROM OLD.result AND NEW.result IS NOT NULL
    AND NEW.analyzer='transcript'
    AND (jsonb_typeof(NEW.configuration->'asrAlgorithm') IS DISTINCT FROM 'string'
      OR NEW.configuration->>'asrAlgorithm'=''
      OR NEW.inference_parameters->'asr'->>'alignmentAlgorithm'
        IS DISTINCT FROM NEW.configuration->>'asrAlgorithm') THEN
    RAISE EXCEPTION 'Analysis runtime version mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.result IS DISTINCT FROM OLD.result AND NEW.result IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM jobs j JOIN media_analyses a ON a.media_asset_id=NEW.media_asset_id
      JOIN media_assets m ON m.id=a.media_asset_id JOIN projects p ON p.id=a.project_id
    WHERE j.id=NEW.job_id AND j.status='Running' AND j.attempt_count=NEW.result_attempt AND p.deleted_at IS NULL
      AND m.content_sha256=a.source_sha256 AND m.validation_status='validated'
      AND (NEW.initiated_by IS NULL OR EXISTS (SELECT 1 FROM project_memberships member
        WHERE member.project_id=a.project_id AND member.user_id=NEW.initiated_by AND member.role IN ('owner','editor')))
      AND NEW.deadline_at_ms>(extract(epoch FROM clock_timestamp())*1000)::bigint
      AND NOT EXISTS (SELECT 1 FROM analysis_tasks newer WHERE newer.media_asset_id=NEW.media_asset_id
        AND newer.analyzer=NEW.analyzer AND newer.generation>NEW.generation)
  ) THEN RAISE EXCEPTION 'Analysis result admission fenced' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER analysis_result_admission AFTER UPDATE ON analysis_tasks
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION analysis_result_admission();

CREATE TABLE analysis_derivation_publications (
  job_id uuid PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  published boolean NOT NULL DEFAULT false,
  lease_until_ms bigint NOT NULL DEFAULT 0
);
CREATE FUNCTION analysis_derivation_intent() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.job_type='media.derive' THEN
    INSERT INTO analysis_derivation_publications(job_id) VALUES(NEW.id);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER analysis_derivation_intent AFTER INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION analysis_derivation_intent();

CREATE FUNCTION analysis_terminal_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.job_type IN ('analysis.transcript.v1','analysis.speech.v1','analysis.audio.v1')
    AND OLD.status IN ('Completed','Failed','Cancelled') AND NEW.status<>OLD.status THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER analysis_terminal_fence BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION analysis_terminal_fence();
