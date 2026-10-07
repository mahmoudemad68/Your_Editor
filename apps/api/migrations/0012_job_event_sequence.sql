-- Durable ordering cursor; deleted with its job. No replay log or Redis expiry/reset.
ALTER TABLE jobs ADD COLUMN event_sequence bigint NOT NULL DEFAULT 0
  CHECK (event_sequence >= 0 AND event_sequence <= 9007199254740991);
ALTER TABLE jobs ADD COLUMN event_state_token text;
ALTER TABLE jobs ADD COLUMN event_progress_attempt integer NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN event_progress_percentage double precision NOT NULL DEFAULT 0;
