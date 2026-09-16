-- Additive classroom management; legacy credentials and grant claims are unchanged.
CREATE TABLE classroom_classes (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  course TEXT NOT NULL DEFAULT '',
  instructors_json TEXT NOT NULL DEFAULT '[]',
  timezone TEXT NOT NULL DEFAULT 'UTC',
  starts_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > starts_at),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
  capabilities_json TEXT NOT NULL,
  budget_microcents INTEGER NOT NULL CHECK (budget_microcents BETWEEN 0 AND 1000000000000000),
  group_budget_microcents INTEGER NOT NULL CHECK (group_budget_microcents BETWEEN 0 AND 1000000000000000),
  daily_budget_microcents INTEGER CHECK (daily_budget_microcents BETWEEN 0 AND 1000000000000000),
  rpm_limit INTEGER NOT NULL CHECK (rpm_limit BETWEEN 1 AND 1000000),
  tpm_limit INTEGER NOT NULL CHECK (tpm_limit BETWEEN 1 AND 1000000000),
  concurrency_limit INTEGER NOT NULL CHECK (concurrency_limit BETWEEN 1 AND 10000),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id, product_id) REFERENCES environments(id, product_id) ON DELETE CASCADE
);

CREATE TABLE classroom_groups (
  id TEXT PRIMARY KEY NOT NULL,
  class_id TEXT NOT NULL REFERENCES classroom_classes(id) ON DELETE CASCADE,
  name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  capabilities_json TEXT,
  budget_microcents INTEGER NOT NULL CHECK (budget_microcents BETWEEN 0 AND 1000000000000000),
  daily_budget_microcents INTEGER CHECK (daily_budget_microcents BETWEEN 0 AND 1000000000000000),
  rpm_limit INTEGER CHECK (rpm_limit BETWEEN 1 AND 1000000),
  tpm_limit INTEGER CHECK (tpm_limit BETWEEN 1 AND 1000000000),
  concurrency_limit INTEGER CHECK (concurrency_limit BETWEEN 1 AND 10000),
  starts_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (class_id, name),
  CHECK (starts_at IS NULL OR expires_at IS NULL OR expires_at > starts_at)
);

CREATE TABLE classroom_group_keys (
  id TEXT PRIMARY KEY NOT NULL,
  group_id TEXT NOT NULL REFERENCES classroom_groups(id) ON DELETE CASCADE,
  secret_hash TEXT NOT NULL UNIQUE,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX classroom_group_keys_group_idx ON classroom_group_keys(group_id);

ALTER TABLE access_codes ADD COLUMN classroom_group_id TEXT REFERENCES classroom_groups(id);
CREATE INDEX access_codes_classroom_group_idx ON access_codes(classroom_group_id);
ALTER TABLE provider_attempts ADD COLUMN classroom_group_id TEXT REFERENCES classroom_groups(id);
CREATE INDEX provider_attempts_classroom_group_idx ON provider_attempts(classroom_group_id, created_at);
