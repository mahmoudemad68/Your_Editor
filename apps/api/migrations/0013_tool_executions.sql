-- Tool execution audit is deliberately separate from secret inputs/results.
CREATE TABLE tool_executions (
  id uuid PRIMARY KEY,
  schema_version integer NOT NULL CHECK (schema_version = 1),
  caller_id uuid,
  project_id uuid,
  tool_name text,
  tool_version text,
  input_hash text CHECK (input_hash IS NULL OR input_hash ~ '^[a-f0-9]{64}$'),
  started_at_ms bigint NOT NULL,
  finished_at_ms bigint,
  outcome text NOT NULL CHECK (outcome IN ('running','succeeded','rejected','failed','cancelled','timed_out')),
  code text,
  cost_micros bigint NOT NULL DEFAULT 0 CHECK (cost_micros >= 0),
  job_id uuid,
  CHECK ((outcome = 'running') = (finished_at_ms IS NULL))
);
CREATE INDEX tool_executions_project ON tool_executions(project_id, started_at_ms DESC, id);
CREATE INDEX tool_executions_caller ON tool_executions(caller_id, started_at_ms DESC, id);
-- Active reservations and settled costs enforce a deployment-owned lifetime project cap.
CREATE TABLE tool_cost_reservations (
  execution_id uuid PRIMARY KEY REFERENCES tool_executions(id),
  project_id uuid NOT NULL,
  cost_micros bigint NOT NULL CHECK (cost_micros >= 0)
);
-- Private transport data, not returned by the audit-query surface. No signed URLs or credentials.
CREATE TABLE tool_remote_calls (
  execution_id uuid PRIMARY KEY REFERENCES tool_executions(id),
  binding_hash text NOT NULL,
  call jsonb NOT NULL,
  result jsonb
);
