CREATE TABLE products (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  kill_switch INTEGER NOT NULL DEFAULT 0 CHECK (kill_switch IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE environments (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  audience TEXT NOT NULL UNIQUE,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  kill_switch INTEGER NOT NULL DEFAULT 0 CHECK (kill_switch IN (0, 1)),
  token_ttl_seconds INTEGER NOT NULL DEFAULT 900 CHECK (token_ttl_seconds BETWEEN 60 AND 3600),
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  rpm_limit INTEGER NOT NULL DEFAULT 30 CHECK (rpm_limit > 0),
  tpm_limit INTEGER NOT NULL DEFAULT 100000 CHECK (tpm_limit > 0),
  concurrency_limit INTEGER NOT NULL DEFAULT 2 CHECK (concurrency_limit > 0),
  daily_budget_microcents INTEGER NOT NULL DEFAULT 1000000
    CHECK (daily_budget_microcents BETWEEN 0 AND 1000000000000000),
  max_request_bytes INTEGER NOT NULL DEFAULT 1048576 CHECK (max_request_bytes BETWEEN 1024 AND 10485760),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (product_id, name)
);

CREATE TABLE aliases (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  alias TEXT NOT NULL,
  endpoint TEXT NOT NULL CHECK (endpoint IN ('chat', 'responses')),
  route_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  allow_reasoning INTEGER NOT NULL DEFAULT 0 CHECK (allow_reasoning IN (0, 1)),
  allow_images INTEGER NOT NULL DEFAULT 0 CHECK (allow_images IN (0, 1)),
  allow_structured_json INTEGER NOT NULL DEFAULT 0 CHECK (allow_structured_json IN (0, 1)),
  max_input_tokens INTEGER NOT NULL CHECK (max_input_tokens > 0),
  max_output_tokens INTEGER NOT NULL CHECK (max_output_tokens > 0),
  input_cost_microcents_per_million INTEGER NOT NULL DEFAULT 0
    CHECK (input_cost_microcents_per_million BETWEEN 0 AND 1000000000000),
  output_cost_microcents_per_million INTEGER NOT NULL DEFAULT 0
    CHECK (output_cost_microcents_per_million BETWEEN 0 AND 1000000000000),
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version > 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (environment_id, alias, endpoint)
);

CREATE TABLE entitlements (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('access_code', 'service', 'dev', 'stripe', 'storekit', 'contract')),
  source_ref TEXT,
  capabilities_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX entitlements_principal_idx
  ON entitlements(environment_id, tenant_id, principal_id, status);

CREATE INDEX entitlements_source_idx ON entitlements(source, source_ref, status);

CREATE UNIQUE INDEX entitlements_source_principal_unique
  ON entitlements(source, source_ref, principal_id)
  WHERE source_ref IS NOT NULL;

CREATE TABLE service_credentials (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  secret_salt TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE TABLE access_codes (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  secret_salt TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  max_activations INTEGER NOT NULL CHECK (max_activations > 0),
  activation_count INTEGER NOT NULL DEFAULT 0 CHECK (activation_count >= 0),
  max_failed_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_failed_attempts BETWEEN 1 AND 50),
  failed_attempts INTEGER NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE activations (
  id TEXT PRIMARY KEY,
  access_code_id TEXT NOT NULL REFERENCES access_codes(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  device_hash TEXT NOT NULL,
  activated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE (access_code_id, device_hash)
);

CREATE TABLE token_grants (
  id TEXT PRIMARY KEY,
  jti_hash TEXT NOT NULL UNIQUE,
  entitlement_id TEXT REFERENCES entitlements(id) ON DELETE SET NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  audience TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);

CREATE INDEX token_grants_active_idx ON token_grants(jti_hash, expires_at, revoked_at);

CREATE TABLE idempotency_keys (
  scope_hash TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope_hash, key_hash)
);

CREATE TABLE provider_attempts (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  attempt_number INTEGER NOT NULL CHECK (attempt_number = 1),
  product_id TEXT NOT NULL,
  environment_id TEXT NOT NULL,
  tenant_hash TEXT NOT NULL,
  principal_hash TEXT NOT NULL,
  alias TEXT NOT NULL,
  policy_version INTEGER NOT NULL,
  route_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  resolved_model TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  error_class TEXT,
  latency_ms INTEGER NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cost_microcents INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE (request_id, attempt_number)
);

CREATE INDEX provider_attempts_product_time_idx
  ON provider_attempts(product_id, environment_id, created_at);

CREATE TABLE admin_audit (
  id TEXT PRIMARY KEY,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  actor_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
