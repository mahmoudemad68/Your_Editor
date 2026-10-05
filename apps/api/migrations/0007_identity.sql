-- US-118 accounts and refresh sessions.
-- project_memberships.user_id now references users. A membership cannot
-- point at an account that was never registered.

CREATE TABLE users (
  id uuid PRIMARY KEY,
  email text NOT NULL,
  password_hash text NOT NULL,
  operator_role text,
  failed_login_count integer NOT NULL DEFAULT 0,
  locked_until bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CONSTRAINT users_email_unique UNIQUE (email),
  CONSTRAINT users_email_normalized CHECK (email = lower(email)),
  CONSTRAINT users_password_argon2id CHECK (password_hash LIKE '$argon2id$%'),
  CONSTRAINT users_operator_role CHECK (operator_role IS NULL OR operator_role = 'admin'),
  CONSTRAINT users_failed_login_non_negative CHECK (failed_login_count >= 0),
  CONSTRAINT users_audit_order CHECK (created_at <= updated_at)
);

CREATE TABLE refresh_sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  secret_hash text NOT NULL,
  rotated_from_id uuid REFERENCES refresh_sessions (id),
  expires_at bigint NOT NULL,
  revoked_at bigint,
  created_at bigint NOT NULL,
  CONSTRAINT refresh_sessions_secret_present CHECK (length(secret_hash) >= 32),
  CONSTRAINT refresh_sessions_expiry CHECK (created_at <= expires_at)
);

CREATE INDEX refresh_sessions_user_id ON refresh_sessions (user_id);

-- Historical memberships may name a principal that has no account.
-- Those rows stay. No password is created for them.
-- Every new membership must name an account. Existing rows are checked
-- only when all of them already do.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM project_memberships AS membership
    LEFT JOIN users AS account ON account.id = membership.user_id
    WHERE account.id IS NULL
  ) THEN
    ALTER TABLE project_memberships
      ADD CONSTRAINT project_memberships_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users (id)
      NOT VALID;
  ELSE
    ALTER TABLE project_memberships
      ADD CONSTRAINT project_memberships_user_id_fkey
      FOREIGN KEY (user_id) REFERENCES users (id);
  END IF;
END $$;
