-- The admission lease is committed with the audit, BEFORE startup recovery or budget reserve.
-- It is not renewable: no coordinator may extend a logical execution's declared deadline.
ALTER TABLE tool_executions ADD COLUMN admission_owner_id uuid;
ALTER TABLE tool_executions ADD COLUMN execution_mode text NOT NULL DEFAULT 'unknown'
  CHECK (execution_mode IN ('remote','in-process','unknown'));
ALTER TABLE tool_executions ADD COLUMN admission_deadline_at_ms bigint;
UPDATE tool_executions e SET admission_deadline_at_ms=e.started_at_ms+COALESCE(
  -- Job-less legacy calls may legally run for the manifest maximum (ten minutes).
  (SELECT j.timeout_ms FROM jobs j WHERE j.id=e.job_id),600000),
  execution_mode=CASE WHEN e.job_id IS NOT NULL OR EXISTS
    (SELECT 1 FROM tool_remote_calls r WHERE r.execution_id=e.id) THEN 'remote' ELSE 'unknown' END;
ALTER TABLE tool_executions ALTER COLUMN admission_deadline_at_ms SET NOT NULL;
ALTER TABLE tool_executions ADD CONSTRAINT tool_admission_positive_lease
  CHECK (admission_deadline_at_ms > started_at_ms);
CREATE INDEX tool_admission_recovery ON tool_executions(admission_deadline_at_ms,id)
  WHERE outcome='running';
CREATE FUNCTION tool_admission_identity_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.admission_owner_id IS NOT NULL AND
    (NEW.admission_owner_id IS DISTINCT FROM OLD.admission_owner_id
     OR NEW.admission_deadline_at_ms IS DISTINCT FROM OLD.admission_deadline_at_ms
     OR NEW.execution_mode IS DISTINCT FROM OLD.execution_mode) THEN
    RAISE EXCEPTION 'admission_identity_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tool_admission_identity_fence BEFORE UPDATE ON tool_executions
  FOR EACH ROW EXECUTE FUNCTION tool_admission_identity_fence();
-- The budget fence also covers delayed/older writers, not just adapter prechecks.
CREATE FUNCTION tool_reservation_admission_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE execution tool_executions%ROWTYPE;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.execution_id IS DISTINCT FROM OLD.execution_id OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
      RAISE EXCEPTION 'reservation_identity_immutable';
    END IF;
    -- Terminal settlement may reduce exposure, never resurrect/increase a reservation.
    IF NEW.cost_micros <= OLD.cost_micros THEN RETURN NEW; END IF;
  END IF;
  SELECT * INTO execution FROM tool_executions WHERE id=NEW.execution_id FOR UPDATE;
  IF NOT FOUND OR execution.project_id IS DISTINCT FROM NEW.project_id OR execution.outcome<>'running'
    OR execution.stop_code IS NOT NULL OR execution.admission_deadline_at_ms <=
      (extract(epoch FROM clock_timestamp())*1000)::bigint THEN
    RAISE EXCEPTION 'remote_admission_closed';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tool_reservation_admission_fence BEFORE INSERT OR UPDATE ON tool_cost_reservations
  FOR EACH ROW EXECUTE FUNCTION tool_reservation_admission_fence();

CREATE OR REPLACE FUNCTION tool_job_publication_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE execution tool_executions%ROWTYPE;
BEGIN
  IF NEW.job_type IS DISTINCT FROM 'tool.execute.v1' THEN RETURN NEW; END IF;
  SELECT * INTO execution FROM tool_executions WHERE id=NEW.id FOR UPDATE;
  IF NOT FOUND OR execution.job_id IS DISTINCT FROM NEW.id OR execution.outcome <> 'running'
    OR execution.stop_code IS NOT NULL OR execution.execution_mode='in-process'
    OR NOT EXISTS (SELECT 1 FROM tool_remote_calls WHERE execution_id=NEW.id)
    OR LEAST(execution.admission_deadline_at_ms,execution.started_at_ms+NEW.timeout_ms)
       <= (extract(epoch FROM clock_timestamp())*1000)::bigint THEN
    RAISE EXCEPTION 'remote_admission_closed';
  END IF;
  INSERT INTO tool_job_publications(job_id,deadline_at_ms)
    VALUES (NEW.id,LEAST(execution.admission_deadline_at_ms,execution.started_at_ms+NEW.timeout_ms));
  RETURN NEW;
END $$;

-- A rejected stale write must be visible as rowCount=0, not a fictitious UPDATE 1.
-- Canonical Job saves reject fenced writes before any subsequent attempt/work.
-- Non-Tool Jobs retain their US-129 behavior.
CREATE OR REPLACE FUNCTION tool_job_terminal_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.job_type='tool.execute.v1' AND OLD.status IN ('Completed','Failed','Cancelled')
    AND NEW.status <> OLD.status THEN RETURN NULL; END IF;
  RETURN NEW;
END $$;
