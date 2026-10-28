-- US-312/313: additive, source-bound caption commands and idempotent request receipts.
-- No rewrite of legacy timeline snapshots, command history, analysis or media.
CREATE TABLE editing_caption_commands (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES projects(id),
  timeline_id uuid NOT NULL REFERENCES editing_timelines(id),
  actor_id uuid NOT NULL REFERENCES users(id),
  request_id uuid NOT NULL,
  input_sha256 text NOT NULL CHECK(input_sha256 ~ '^[0-9a-f]{64}$'),
  basis_sha256 text NOT NULL CHECK(basis_sha256 ~ '^[0-9a-f]{64}$'),
  operation text NOT NULL CHECK(operation IN ('add-caption','update-caption-style')),
  status text NOT NULL CHECK(status IN ('admitted','committed','undone')),
  command jsonb,
  inverse jsonb,
  result_sha256 text CHECK(result_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(project_id,actor_id,request_id),
  CHECK((status='admitted' AND command IS NULL AND inverse IS NULL AND result_sha256 IS NULL)
    OR (status IN ('committed','undone') AND command IS NOT NULL AND inverse IS NOT NULL AND result_sha256 IS NOT NULL))
);
CREATE INDEX editing_caption_history ON editing_caption_commands(project_id,timeline_id,created_at,id);
