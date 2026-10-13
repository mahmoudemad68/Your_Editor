-- Separate execution/cleanup outcomes and explicit actual-vs-reserved cost accounting.
ALTER TABLE tool_executions
  ADD COLUMN cleanup_status text NOT NULL DEFAULT 'not_required' CHECK (cleanup_status IN ('not_required','succeeded','failed')),
  ADD COLUMN cleanup_code text CHECK (cleanup_code IS NULL OR cleanup_code = 'cleanup_unconfirmed'),
  ADD COLUMN stop_code text CHECK (stop_code IS NULL OR stop_code IN ('cancelled','timed_out')),
  ADD COLUMN cost_basis text NOT NULL DEFAULT 'none' CHECK (cost_basis IN ('actual','reserved','none'));
UPDATE tool_executions SET cost_basis = CASE WHEN outcome='succeeded' THEN 'actual' WHEN cost_micros>0 THEN 'reserved' ELSE 'none' END;
CREATE INDEX tool_executions_recovery ON tool_executions(id) WHERE outcome='running' AND job_id IS NOT NULL;
