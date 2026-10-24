-- Additive operational detail; frozen MediaAnalysis 1.0/1.1 JSON is unchanged.
ALTER TABLE analysis_tasks ADD COLUMN failure_category text
  CHECK(failure_category IN ('authorization_revoked','authorization_failed','publication_fenced',
    'untrustworthy_alignment','analyzer_unavailable','cancelled','timeout','invalid_input','internal'));

CREATE OR REPLACE FUNCTION analysis_result_admission() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.result IS DISTINCT FROM OLD.result AND NEW.result IS NOT NULL
    AND NEW.analyzer='transcript'
    AND (jsonb_typeof(NEW.configuration->'asrAlgorithm') IS DISTINCT FROM 'string'
      OR NEW.configuration->>'asrAlgorithm'=''
      OR NEW.inference_parameters->'asr'->>'alignmentAlgorithm'
        IS DISTINCT FROM NEW.configuration->>'asrAlgorithm') THEN
    RAISE EXCEPTION 'Analysis runtime version mismatch' USING ERRCODE='23514';
  END IF;
  IF NEW.result IS DISTINCT FROM OLD.result AND NEW.result IS NOT NULL
    AND NEW.deadline_at_ms<=(extract(epoch FROM clock_timestamp())*1000)::bigint THEN
    RAISE EXCEPTION 'Analysis result admission fenced'
      USING ERRCODE='23514', CONSTRAINT='analysis_deadline';
  END IF;
  -- Stable SQLSTATE, never exception-text matching. No private identity in errors.
  IF NEW.result IS DISTINCT FROM OLD.result AND NEW.result IS NOT NULL
    AND NEW.initiated_by IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM media_analyses a JOIN projects p ON p.id=a.project_id
      JOIN project_memberships member ON member.project_id=a.project_id
      WHERE a.media_asset_id=NEW.media_asset_id AND p.deleted_at IS NULL
        AND member.user_id=NEW.initiated_by AND member.role IN ('owner','editor')
    ) THEN RAISE EXCEPTION 'Analysis authorization unavailable' USING ERRCODE='EA001'; END IF;
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
  ) THEN RAISE EXCEPTION 'Analysis result admission fenced'
    USING ERRCODE='23514', CONSTRAINT='analysis_result_admission'; END IF;
  RETURN NULL;
END $$;
