-- US-120 Project persistence.
-- project_memberships.user_id has no foreign key. US-118 owns the User table
-- and the credential schema. Adding that table here would invent authentication
-- this story does not implement.

CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  deleted_at bigint,
  CONSTRAINT projects_name_not_blank CHECK (length(btrim(name)) > 0),
  CONSTRAINT projects_audit_order CHECK (created_at <= updated_at),
  CONSTRAINT projects_deleted_matches_update CHECK (deleted_at IS NULL OR deleted_at = updated_at)
);

CREATE TABLE project_memberships (
  project_id uuid NOT NULL REFERENCES projects (id),
  user_id uuid NOT NULL,
  role text NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (project_id, user_id),
  CONSTRAINT project_memberships_role CHECK (role IN ('owner', 'editor', 'viewer'))
);

CREATE INDEX project_memberships_user_id ON project_memberships (user_id);
