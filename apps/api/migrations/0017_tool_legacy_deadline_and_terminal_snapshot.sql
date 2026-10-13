-- Repair databases that already applied the earlier five-minute 0016 backfill.
-- Only unmanaged, still-running, job-less legacy admissions can be extended.
-- Managed leases and terminal audits remain immutable; no execution is revived.
UPDATE tool_executions e
SET admission_deadline_at_ms=GREATEST(e.admission_deadline_at_ms,e.started_at_ms+600000)
WHERE e.admission_owner_id IS NULL AND e.outcome='running'
  AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id=e.id OR j.id=e.job_id);

-- Equal status alone does not make a stale terminal snapshot safe: a cancelled
-- stale worker could otherwise replace attempt_count=0 with its speculative 1.
-- Exact repeated saves remain idempotent. Rejection is visible as rowCount=0.
CREATE OR REPLACE FUNCTION tool_job_terminal_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.job_type='tool.execute.v1' AND OLD.status IN ('Completed','Failed','Cancelled')
    AND (NEW.status IS DISTINCT FROM OLD.status
      OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count
      OR NEW.failure_reason IS DISTINCT FROM OLD.failure_reason
      OR NEW.updated_at IS DISTINCT FROM OLD.updated_at) THEN RETURN NULL; END IF;
  RETURN NEW;
END $$;
