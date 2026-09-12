-- Additive: the existing gateway/control schema marker is unchanged.
CREATE TABLE dashboard_admins (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254 AND email = lower(trim(email))),
  actor_hash TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
