-- Additive controlled-loop qualification. Historical AgentRun v1 rows/events
-- retain their exact schema and no-LLM receipts; production admission is unchanged.
ALTER TABLE agent_runs ADD COLUMN runtime_driver text NOT NULL DEFAULT 'infrastructure-v1'
 CHECK(runtime_driver IN ('infrastructure-v1','controlled-loop-v1'));
ALTER TABLE agent_runs ADD COLUMN planning_stop_reason text CHECK(planning_stop_reason IN (
 'PROVIDER_INVALID_RESPONSE','PROVIDER_UNAVAILABLE','PROVIDER_OUTCOME_UNCONFIRMED','PROVIDER_REFUSED',
 'PLAN_INVALID','CAPABILITY_UNAVAILABLE','ITERATION_BUDGET','TOOL_BUDGET','TOKEN_BUDGET','COST_BUDGET',
 'RENDER_FAILED','RENDER_UNCONFIRMED','OUTPUT_INVALID','ANALYSIS_UNAVAILABLE'));
ALTER TABLE agent_runs ADD COLUMN tool_attempts integer NOT NULL DEFAULT 0 CHECK(tool_attempts BETWEEN 0 AND 64);
CREATE TABLE agent_loop_sessions (
 run_id uuid PRIMARY KEY REFERENCES agent_runs(id), schema_version text NOT NULL CHECK(schema_version='1.0.0'),
 configuration jsonb NOT NULL CHECK(jsonb_typeof(configuration)='object' AND octet_length(configuration::text)<=32768),
 profile_sha256 text NOT NULL CHECK(profile_sha256 ~ '^[a-f0-9]{64}$'),
 context_snapshot jsonb CHECK(context_snapshot IS NULL OR octet_length(context_snapshot::text)<=1048576),
 plan jsonb CHECK(plan IS NULL OR (jsonb_typeof(plan)='object' AND octet_length(plan::text)<=65536)),
 plan_sha256 text CHECK(plan_sha256 ~ '^[a-f0-9]{64}$'),
 render_receipt_id uuid, render_job_id uuid, render_outcome text CHECK(render_outcome IN ('running','succeeded','failed','unconfirmed')),
 render_output jsonb CHECK(render_output IS NULL OR octet_length(render_output::text)<=4096),
 CHECK((plan IS NULL)=(plan_sha256 IS NULL)),
 CHECK((render_receipt_id IS NULL)=(render_outcome IS NULL))
);
CREATE TABLE agent_model_calls (
 id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES agent_loop_sessions(run_id),
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 15), generation integer NOT NULL,
 request_sha256 text NOT NULL CHECK(request_sha256 ~ '^[a-f0-9]{64}$'),
 outcome text NOT NULL CHECK(outcome IN ('running','succeeded','failed','unconfirmed')),
 audit jsonb NOT NULL CHECK(jsonb_typeof(audit)='object' AND octet_length(audit::text)<=8192),
 validated_result jsonb CHECK(validated_result IS NULL OR octet_length(validated_result::text)<=65536),
 UNIQUE(run_id,ordinal)
);
CREATE FUNCTION agent_loop_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.run_id<>OLD.run_id OR NEW.profile_sha256<>OLD.profile_sha256
 OR NEW.configuration<>OLD.configuration OR NEW.schema_version<>OLD.schema_version
 OR (OLD.context_snapshot IS NOT NULL AND NEW.context_snapshot IS DISTINCT FROM OLD.context_snapshot)
 OR (OLD.plan IS NOT NULL AND (NEW.plan IS DISTINCT FROM OLD.plan OR NEW.plan_sha256 IS DISTINCT FROM OLD.plan_sha256))
 OR (OLD.render_receipt_id IS NOT NULL AND NEW.render_receipt_id IS DISTINCT FROM OLD.render_receipt_id)
 THEN RAISE EXCEPTION 'Agent loop identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER agent_loop_identity BEFORE UPDATE OR DELETE ON agent_loop_sessions FOR EACH ROW EXECUTE FUNCTION agent_loop_identity();
CREATE FUNCTION agent_model_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.run_id<>OLD.run_id OR NEW.ordinal<>OLD.ordinal
 OR NEW.request_sha256<>OLD.request_sha256 OR NEW.generation<>OLD.generation OR OLD.outcome<>'running'
 THEN RAISE EXCEPTION 'Agent model identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER agent_model_identity BEFORE UPDATE OR DELETE ON agent_model_calls FOR EACH ROW EXECUTE FUNCTION agent_model_identity();
-- Actual render-worker FFprobe receipt; never a model/client assertion.
CREATE TABLE render_output_validations (
 job_id uuid PRIMARY KEY REFERENCES jobs(id), project_id uuid NOT NULL REFERENCES projects(id),
 proof jsonb NOT NULL CHECK(jsonb_typeof(proof)='object' AND octet_length(proof::text)<=4096
  AND proof->>'schemaVersion'='1.0.0' AND proof->>'jobId'=job_id::text)
);
CREATE TRIGGER render_validation_immutable BEFORE UPDATE OR DELETE ON render_output_validations FOR EACH ROW EXECUTE FUNCTION agent_append_only();

-- SET LOCAL custom settings become empty strings after a pooled transaction.
-- SQL AND does not guard casts in a separately planned EXISTS subquery. Keep
-- the ordinary-edit branch in PL/pgSQL control flow, while retaining every
-- authorization, generation, lease and deadline check for an agent effect.
CREATE OR REPLACE FUNCTION agent_timeline_commit_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_text text := current_setting('editagent.agent_run',true);
BEGIN
 IF run_text IS NULL OR run_text='' THEN RETURN NEW; END IF;
 IF NOT EXISTS (
  SELECT 1 FROM agent_runs r JOIN projects p ON p.id=r.project_id
   JOIN project_memberships m ON m.project_id=p.id AND m.user_id=r.actor_id
  WHERE r.id=run_text::uuid AND r.source_timeline_id=NEW.id AND r.project_id=NEW.project_id
   AND r.state='Executing' AND r.stop_reason IS NULL AND p.deleted_at IS NULL AND m.role IN ('owner','editor')
   AND r.lease_owner=NULLIF(current_setting('editagent.agent_owner',true),'')::uuid
   AND r.generation=NULLIF(current_setting('editagent.agent_generation',true),'')::integer
   AND r.lease_until>clock_timestamp() AND r.deadline_at_ms>(extract(epoch FROM clock_timestamp())*1000)::bigint)
 THEN RAISE EXCEPTION 'Agent effect fenced' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
