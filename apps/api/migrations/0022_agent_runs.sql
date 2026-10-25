-- AgentRun is authoritative in PostgreSQL; BullMQ is a delivery mechanism.
CREATE TABLE agent_runs (
 id uuid PRIMARY KEY CHECK(substring(id::text,15,1)='7'),
 project_id uuid NOT NULL REFERENCES projects(id), actor_id uuid NOT NULL,
 admission_key text NOT NULL CHECK(admission_key ~ '^[a-f0-9]{64}$'),
 state text NOT NULL DEFAULT 'Pending' CHECK(state IN ('Pending','Observing','Planning','Executing','Rendering','Evaluating','Completed','Failed','Cancelled')),
 revision integer NOT NULL DEFAULT 0 CHECK(revision>=0), sequence integer NOT NULL DEFAULT 0 CHECK(sequence>=0),
 checkpoint integer NOT NULL DEFAULT 0 CHECK(checkpoint BETWEEN 0 AND 64), generation integer NOT NULL DEFAULT 0 CHECK(generation>=0),
 stop_reason text CHECK(stop_reason IN ('PLANNER_NOT_CONFIGURED','CANCELLED','ACCESS_REVOKED','DEADLINE_EXCEEDED','EXECUTION_UNCONFIRMED','TOOL_FAILED','STALE_SOURCE','STEP_LIMIT','INTERNAL')),
 source_timeline_id uuid, source_sha256 text CHECK(source_sha256 ~ '^[a-f0-9]{64}$'), source_snapshot jsonb,
 lease_owner uuid, lease_until timestamptz, correlation_id uuid NOT NULL,
 request_correlation_sha256 text NOT NULL CHECK(request_correlation_sha256 ~ '^[a-f0-9]{64}$'),
 created_at_ms bigint NOT NULL, updated_at_ms bigint NOT NULL, deadline_at_ms bigint NOT NULL,
 CHECK((state IN ('Failed','Cancelled'))=(stop_reason IS NOT NULL)),
 CHECK((source_timeline_id IS NULL)=(source_sha256 IS NULL)),
 CHECK((source_sha256 IS NULL)=(source_snapshot IS NULL)),
 UNIQUE(project_id,actor_id,admission_key)
);
CREATE INDEX agent_runs_pending ON agent_runs(created_at_ms) WHERE state NOT IN ('Completed','Failed','Cancelled');
CREATE TABLE agent_steps (
 id uuid PRIMARY KEY CHECK(substring(id::text,15,1)='7'), run_id uuid NOT NULL REFERENCES agent_runs(id),
 ordinal integer NOT NULL CHECK(ordinal BETWEEN 0 AND 63),
 generation integer NOT NULL CHECK(generation>0),
 receipt_id uuid NOT NULL UNIQUE, tool_name text NOT NULL, tool_version text NOT NULL,
 input_sha256 text NOT NULL CHECK(input_sha256 ~ '^[a-f0-9]{64}$'),
 outcome text NOT NULL CHECK(outcome IN ('running','succeeded','failed','unconfirmed')),
 output_sha256 text CHECK(output_sha256 ~ '^[a-f0-9]{64}$'), duration_ms integer CHECK(duration_ms>=0),
 cost_micros bigint CHECK(cost_micros>=0),
 basis_sha256 text, result_sha256 text, commands jsonb,
 created_at_ms bigint NOT NULL, finished_at_ms bigint,
 UNIQUE(run_id,ordinal), CHECK(commands IS NULL OR (jsonb_typeof(commands)='array' AND jsonb_array_length(commands)<=100))
);
CREATE TABLE agent_events (
 id uuid PRIMARY KEY, run_id uuid NOT NULL REFERENCES agent_runs(id), sequence integer NOT NULL CHECK(sequence>0),
 event jsonb NOT NULL CHECK(jsonb_typeof(event)='object' AND octet_length(event::text)<=16384),
 UNIQUE(run_id,sequence), CHECK(event->>'id'=id::text AND event->>'runId'=run_id::text AND (event->>'sequence')::integer=sequence)
);
CREATE FUNCTION agent_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Agent events are append only' USING ERRCODE='23514'; END; $$;
CREATE TRIGGER agent_event_immutable BEFORE UPDATE OR DELETE ON agent_events FOR EACH ROW EXECUTE FUNCTION agent_append_only();
CREATE FUNCTION agent_step_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' OR NEW.id<>OLD.id OR NEW.run_id<>OLD.run_id OR NEW.ordinal<>OLD.ordinal OR NEW.generation<>OLD.generation OR NEW.receipt_id<>OLD.receipt_id
 OR NEW.tool_name<>OLD.tool_name OR NEW.tool_version<>OLD.tool_version OR NEW.input_sha256<>OLD.input_sha256 OR OLD.outcome<>'running'
 THEN RAISE EXCEPTION 'Agent step identity is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER agent_step_immutable BEFORE UPDATE OR DELETE ON agent_steps FOR EACH ROW EXECUTE FUNCTION agent_step_identity();
CREATE FUNCTION agent_tool_admission_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM agent_steps WHERE receipt_id=NEW.id) THEN
  PERFORM 1 FROM agent_steps s JOIN agent_runs r ON r.id=s.run_id
   JOIN projects p ON p.id=r.project_id JOIN project_memberships m ON m.project_id=p.id AND m.user_id=r.actor_id
   WHERE s.receipt_id=NEW.id AND s.outcome='running' AND s.generation=r.generation
    AND r.state='Executing' AND r.stop_reason IS NULL AND r.lease_until>clock_timestamp()
    AND r.deadline_at_ms>(extract(epoch FROM clock_timestamp())*1000)::bigint
    AND p.deleted_at IS NULL AND m.role IN ('owner','editor')
    AND NEW.project_id=r.project_id AND NEW.caller_id=r.actor_id
    AND NEW.tool_name=s.tool_name AND NEW.tool_version=s.tool_version AND NEW.input_hash=s.input_sha256
   FOR SHARE OF r,p,m;
  IF NOT FOUND THEN RAISE EXCEPTION 'Agent tool admission fenced' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER agent_tool_admission_fence BEFORE INSERT ON tool_executions FOR EACH ROW EXECUTE FUNCTION agent_tool_admission_fence();
-- Deferred check catches deadline/lease expiration during a blocked timeline
-- write. Membership/project share locks remain held through this commit.
CREATE FUNCTION agent_timeline_commit_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE run_text text := current_setting('editagent.agent_run',true);
BEGIN
 IF run_text IS NOT NULL AND run_text<>'' AND NOT EXISTS (
  SELECT 1 FROM agent_runs r JOIN projects p ON p.id=r.project_id
   JOIN project_memberships m ON m.project_id=p.id AND m.user_id=r.actor_id
  WHERE r.id=run_text::uuid AND r.source_timeline_id=NEW.id AND r.project_id=NEW.project_id
   AND r.state='Executing' AND r.stop_reason IS NULL AND p.deleted_at IS NULL AND m.role IN ('owner','editor')
   AND r.lease_owner=current_setting('editagent.agent_owner',true)::uuid
   AND r.generation=current_setting('editagent.agent_generation',true)::integer
   AND r.lease_until>clock_timestamp() AND r.deadline_at_ms>(extract(epoch FROM clock_timestamp())*1000)::bigint)
 THEN RAISE EXCEPTION 'Agent effect fenced' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE CONSTRAINT TRIGGER agent_timeline_commit_fence AFTER UPDATE ON editing_timelines
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION agent_timeline_commit_fence();
CREATE FUNCTION agent_job_state_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.job_type='agent.run.v1' THEN
  IF TG_OP='UPDATE' AND OLD.status IN ('Completed','Failed','Cancelled') AND
   (NEW.status IS DISTINCT FROM OLD.status OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
    OR NEW.failure_reason IS DISTINCT FROM OLD.failure_reason OR NEW.updated_at IS DISTINCT FROM OLD.updated_at) THEN RETURN NULL; END IF;
  IF NEW.status IN ('Queued','Running','Retrying') AND EXISTS(SELECT 1 FROM agent_runs WHERE id=NEW.id AND state='Cancelled')
  THEN NEW.status:='Cancelled'; NEW.failure_reason:='cancelled'; END IF;
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER agent_job_state_fence BEFORE INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION agent_job_state_fence();
