-- US-129 job history. Redis is the broker. These tables are the record that
-- survives a Redis flush. revision is not used; updated_at is the audit instant.

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  queue_name text NOT NULL,
  job_type text NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL,
  subject_kind text NOT NULL,
  subject_id uuid NOT NULL,
  payload jsonb NOT NULL,
  timeout_ms integer NOT NULL,
  max_attempts integer NOT NULL,
  attempt_count integer NOT NULL,
  failure_reason text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CONSTRAINT jobs_status CHECK (
    status IN ('Queued', 'Running', 'Completed', 'Failed', 'Retrying', 'Cancelled')
  ),
  CONSTRAINT jobs_subject_kind CHECK (
    subject_kind IN ('project', 'media-asset', 'derived-asset')
  ),
  CONSTRAINT jobs_timeout_positive CHECK (timeout_ms >= 1),
  CONSTRAINT jobs_max_attempts_positive CHECK (max_attempts >= 1),
  CONSTRAINT jobs_attempt_count_non_negative CHECK (attempt_count >= 0),
  CONSTRAINT jobs_audit_order CHECK (created_at <= updated_at),
  CONSTRAINT jobs_names_not_blank CHECK (
    length(btrim(queue_name)) > 0 AND length(btrim(job_type)) > 0 AND length(btrim(idempotency_key)) > 0
  )
);

CREATE TABLE job_attempts (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL REFERENCES jobs (id),
  attempt_number integer NOT NULL,
  status text NOT NULL,
  started_at bigint NOT NULL,
  finished_at bigint,
  reason text,
  CONSTRAINT job_attempts_number_positive CHECK (attempt_number >= 1),
  CONSTRAINT job_attempts_status CHECK (
    status IN ('Queued', 'Running', 'Completed', 'Failed', 'Retrying', 'Cancelled')
  ),
  CONSTRAINT job_attempts_finish_order CHECK (finished_at IS NULL OR started_at <= finished_at),
  UNIQUE (job_id, attempt_number)
);

CREATE TABLE job_dead_letters (
  job_id uuid PRIMARY KEY REFERENCES jobs (id),
  reason text NOT NULL,
  envelope jsonb NOT NULL,
  created_at bigint NOT NULL,
  CONSTRAINT job_dead_letters_reason_not_blank CHECK (length(btrim(reason)) > 0)
);

CREATE INDEX job_attempts_job_id ON job_attempts (job_id, attempt_number);
