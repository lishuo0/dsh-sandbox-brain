-- 脑写入的表。平台不写这些行。

CREATE TABLE IF NOT EXISTS dsh_session_headers (
  session_id       text PRIMARY KEY,
  header           jsonb NOT NULL,
  inherited_count  bigint NOT NULL DEFAULT 0,
  next_seq         bigint NOT NULL DEFAULT 0,
  revision         bigint NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS dsh_session_events (
  session_id  text NOT NULL,
  seq         bigint NOT NULL,
  event       jsonb NOT NULL,
  PRIMARY KEY (session_id, seq)
);

CREATE TABLE IF NOT EXISTS dsh_session_leases (
  session_id  text PRIMARY KEY,
  owner       text NOT NULL,
  generation  bigint NOT NULL DEFAULT 1,
  expires_at  timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS dsh_session_leases_expiry_idx ON dsh_session_leases (expires_at);

CREATE TABLE IF NOT EXISTS dsh_sandboxes (
  user_id         text NOT NULL,
  workspace_id    text NOT NULL DEFAULT '',
  session_id      text NOT NULL DEFAULT '',
  scope           text NOT NULL,
  sandbox_id      text NOT NULL UNIQUE,
  platform        text NOT NULL DEFAULT 'e2b',
  external_id     text NOT NULL,
  endpoint        text NOT NULL,
  workspace_root  text NOT NULL,
  generation      bigint NOT NULL DEFAULT 1,
  state           text NOT NULL DEFAULT 'creating',
  expires_at      timestamptz NOT NULL,
  last_used_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workspace_id, session_id)
);

CREATE INDEX IF NOT EXISTS dsh_sandboxes_external_idx ON dsh_sandboxes (external_id);
CREATE INDEX IF NOT EXISTS dsh_sandboxes_idle_idx ON dsh_sandboxes (state, last_used_at);
