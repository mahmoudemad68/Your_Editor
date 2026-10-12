-- Publication intent is committed in the SAME transaction as each Tool Job insert,
-- including callers using the canonical US-129 enqueueJob path. Redis is not a commit participant.
ALTER TABLE tool_executions DROP CONSTRAINT tool_executions_cleanup_status_check;
ALTER TABLE tool_executions ADD CONSTRAINT tool_executions_cleanup_status_check
  CHECK (cleanup_status IN ('not_required','succeeded','failed','unconfirmed'));
ALTER TABLE tool_remote_calls ADD COLUMN cleanup_status text NOT NULL DEFAULT 'not_required'
  CHECK (cleanup_status IN ('not_required','succeeded','failed','unconfirmed'));
-- Existing result receipts were written only AFTER successful cleanup acknowledgment.
UPDATE tool_remote_calls SET cleanup_status=CASE WHEN result IS NOT NULL THEN 'succeeded' ELSE 'unconfirmed' END;
CREATE TABLE tool_job_publications (
  job_id uuid PRIMARY KEY REFERENCES jobs(id),
  deadline_at_ms bigint NOT NULL,
  lease_until_ms bigint NOT NULL DEFAULT 0,
  published boolean NOT NULL DEFAULT false
);
CREATE FUNCTION tool_job_publication_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE execution tool_executions%ROWTYPE;
BEGIN
  IF NEW.job_type IS DISTINCT FROM 'tool.execute.v1' THEN RETURN NEW; END IF;
  SELECT * INTO execution FROM tool_executions WHERE id=NEW.id FOR UPDATE;
  IF NOT FOUND OR execution.job_id IS DISTINCT FROM NEW.id OR execution.outcome <> 'running'
    OR execution.stop_code IS NOT NULL OR NOT EXISTS (SELECT 1 FROM tool_remote_calls WHERE execution_id=NEW.id)
    OR execution.started_at_ms + NEW.timeout_ms <= (extract(epoch FROM clock_timestamp())*1000)::bigint THEN
    RAISE EXCEPTION 'remote_admission_closed';
  END IF;
  INSERT INTO tool_job_publications(job_id,deadline_at_ms)
    VALUES (NEW.id,execution.started_at_ms+NEW.timeout_ms);
  RETURN NEW;
END $$;
CREATE TRIGGER tool_job_publication_intent AFTER INSERT ON jobs
  FOR EACH ROW EXECUTE FUNCTION tool_job_publication_intent();
INSERT INTO tool_job_publications(job_id,deadline_at_ms,published)
  SELECT j.id,e.started_at_ms+j.timeout_ms,j.status <> 'Queued'
  FROM jobs j JOIN tool_executions e ON e.job_id=j.id WHERE j.job_type='tool.execute.v1';
-- A worker may have read Queued before a deadline fence committed. Its stale aggregate
-- save cannot resurrect a terminal Tool Job after Redis resumes.
CREATE FUNCTION tool_job_terminal_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.job_type='tool.execute.v1' AND OLD.status IN ('Completed','Failed','Cancelled')
    AND NEW.status <> OLD.status THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tool_job_terminal_fence BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION tool_job_terminal_fence();
