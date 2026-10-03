-- Durable intent to publish one media.inspect job.
-- The MediaAsset row and this intent commit together. Redis delivery is later.
-- Replaying a row uses the same job id, so it cannot create a second logical job.

CREATE TABLE inspect_publication_outbox (
  job_id uuid PRIMARY KEY,
  media_asset_id uuid NOT NULL UNIQUE REFERENCES media_assets (id),
  correlation_id text NOT NULL,
  queue_name text NOT NULL,
  job_type text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  timeout_ms integer NOT NULL,
  max_attempts integer NOT NULL,
  backoff_base_ms integer NOT NULL,
  status text NOT NULL,
  attempt_count integer NOT NULL,
  last_error text,
  error_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  available_at bigint NOT NULL,
  lease_owner text,
  lease_until bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  delivered_at bigint,
  CONSTRAINT inspect_outbox_status CHECK (status IN ('Pending', 'Delivering', 'Delivered')),
  CONSTRAINT inspect_outbox_attempt_count CHECK (attempt_count >= 0),
  CONSTRAINT inspect_outbox_timeout CHECK (timeout_ms >= 1),
  CONSTRAINT inspect_outbox_max_attempts CHECK (max_attempts >= 1),
  CONSTRAINT inspect_outbox_backoff CHECK (backoff_base_ms >= 1),
  CONSTRAINT inspect_outbox_names CHECK (
    length(btrim(queue_name)) > 0
    AND length(btrim(job_type)) > 0
    AND length(btrim(idempotency_key)) > 0
    AND length(btrim(correlation_id)) > 0
    AND position(':' IN queue_name) = 0
  ),
  CONSTRAINT inspect_outbox_audit CHECK (created_at <= updated_at),
  CONSTRAINT inspect_outbox_lease CHECK (
    (status <> 'Delivering' AND lease_owner IS NULL AND lease_until IS NULL)
    OR (status = 'Delivering' AND lease_owner IS NOT NULL AND lease_until IS NOT NULL)
    OR status = 'Delivered'
  )
);

CREATE INDEX inspect_outbox_due
  ON inspect_publication_outbox (available_at, job_id)
  WHERE status IN ('Pending', 'Delivering');
