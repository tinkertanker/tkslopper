CREATE TABLE schema_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

INSERT INTO schema_metadata (key, value)
VALUES ('schema_version', '2026-09-03.pre-release.2');

CREATE TABLE products (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  kill_switch INTEGER NOT NULL DEFAULT 0 CHECK (kill_switch IN (0, 1)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE environments (
  id TEXT PRIMARY KEY NOT NULL,
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
  UNIQUE (id, product_id),
  UNIQUE (product_id, name)
);

CREATE TABLE aliases (
  id TEXT PRIMARY KEY NOT NULL,
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
  UNIQUE (environment_id, alias, endpoint),
  FOREIGN KEY (environment_id, product_id)
    REFERENCES environments(id, product_id) ON DELETE CASCADE
);

CREATE INDEX aliases_environment_active_idx
  ON aliases(product_id, environment_id)
  WHERE enabled = 1;

CREATE TABLE entitlements (
  id TEXT PRIMARY KEY NOT NULL,
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  environment_id TEXT NOT NULL REFERENCES environments(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('access_code', 'service', 'dev', 'stripe', 'storekit', 'contract')),
  source_ref TEXT CHECK (source NOT IN ('access_code', 'service') OR source_ref IS NOT NULL),
  capabilities_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
  expires_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id, product_id)
    REFERENCES environments(id, product_id) ON DELETE CASCADE
);

CREATE INDEX entitlements_principal_idx
  ON entitlements(environment_id, tenant_id, principal_id, status);

CREATE INDEX entitlements_environment_active_idx
  ON entitlements(product_id, environment_id, expires_at)
  WHERE status = 'active';

CREATE INDEX entitlements_source_idx ON entitlements(source, source_ref, status);

CREATE UNIQUE INDEX entitlements_source_principal_unique
  ON entitlements(source, source_ref, principal_id)
  WHERE source_ref IS NOT NULL;

CREATE TABLE service_credentials (
  id TEXT PRIMARY KEY NOT NULL,
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
  last_used_at INTEGER,
  FOREIGN KEY (environment_id, product_id)
    REFERENCES environments(id, product_id) ON DELETE CASCADE
);

CREATE TABLE access_codes (
  id TEXT PRIMARY KEY NOT NULL,
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
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id, product_id)
    REFERENCES environments(id, product_id) ON DELETE CASCADE
);

CREATE TABLE activations (
  id TEXT PRIMARY KEY NOT NULL,
  access_code_id TEXT NOT NULL REFERENCES access_codes(id) ON DELETE CASCADE,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  device_hash TEXT NOT NULL,
  activated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  UNIQUE (access_code_id, device_hash)
);

CREATE UNIQUE INDEX activations_access_code_principal_unique
  ON activations(access_code_id, tenant_id, principal_id);

CREATE TRIGGER activations_access_code_identity_insert
BEFORE INSERT ON activations
WHEN NOT EXISTS (
  SELECT 1
    FROM access_codes
   WHERE id = NEW.access_code_id
     AND tenant_id = NEW.tenant_id
)
BEGIN
  SELECT RAISE(ABORT, 'activation access code identity mismatch');
END;

CREATE TRIGGER activations_access_code_identity_update
BEFORE UPDATE OF access_code_id, tenant_id, principal_id ON activations
WHEN NOT EXISTS (
  SELECT 1
    FROM access_codes
   WHERE id = NEW.access_code_id
     AND tenant_id = NEW.tenant_id
)
OR EXISTS (
  SELECT 1
    FROM entitlements
   WHERE source = 'access_code'
     AND source_ref = OLD.access_code_id
     AND tenant_id = OLD.tenant_id
     AND principal_id = OLD.principal_id
     AND (
       source_ref IS NOT NEW.access_code_id
       OR tenant_id IS NOT NEW.tenant_id
       OR principal_id IS NOT NEW.principal_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'activation access code identity mismatch');
END;

CREATE TRIGGER entitlements_access_code_identity_insert
BEFORE INSERT ON entitlements
WHEN NEW.source = 'access_code'
  AND NOT EXISTS (
    SELECT 1
      FROM access_codes AS code
      JOIN activations AS activation
        ON activation.access_code_id = code.id
       AND activation.tenant_id = code.tenant_id
     WHERE code.id = NEW.source_ref
       AND code.product_id = NEW.product_id
       AND code.environment_id = NEW.environment_id
       AND code.tenant_id = NEW.tenant_id
       AND activation.principal_id = NEW.principal_id
  )
BEGIN
  SELECT RAISE(ABORT, 'entitlement access code identity mismatch');
END;

CREATE TRIGGER entitlements_access_code_identity_update
BEFORE UPDATE OF product_id, environment_id, tenant_id, principal_id, source, source_ref ON entitlements
WHEN NEW.source = 'access_code'
  AND NOT EXISTS (
    SELECT 1
      FROM access_codes AS code
      JOIN activations AS activation
        ON activation.access_code_id = code.id
       AND activation.tenant_id = code.tenant_id
     WHERE code.id = NEW.source_ref
       AND code.product_id = NEW.product_id
       AND code.environment_id = NEW.environment_id
       AND code.tenant_id = NEW.tenant_id
       AND activation.principal_id = NEW.principal_id
  )
BEGIN
  SELECT RAISE(ABORT, 'entitlement access code identity mismatch');
END;

CREATE TRIGGER entitlements_service_identity_insert
BEFORE INSERT ON entitlements
WHEN NEW.source = 'service'
  AND NOT EXISTS (
    SELECT 1
      FROM service_credentials
     WHERE id = NEW.source_ref
       AND product_id = NEW.product_id
       AND environment_id = NEW.environment_id
       AND tenant_id = NEW.tenant_id
       AND principal_id = NEW.principal_id
  )
BEGIN
  SELECT RAISE(ABORT, 'entitlement service credential identity mismatch');
END;

CREATE TRIGGER entitlements_service_identity_update
BEFORE UPDATE OF product_id, environment_id, tenant_id, principal_id, source, source_ref ON entitlements
WHEN NEW.source = 'service'
  AND NOT EXISTS (
    SELECT 1
      FROM service_credentials
     WHERE id = NEW.source_ref
       AND product_id = NEW.product_id
       AND environment_id = NEW.environment_id
       AND tenant_id = NEW.tenant_id
       AND principal_id = NEW.principal_id
  )
BEGIN
  SELECT RAISE(ABORT, 'entitlement service credential identity mismatch');
END;

CREATE TRIGGER entitlements_source_provenance_update
BEFORE UPDATE OF source, source_ref ON entitlements
WHEN NEW.source IS NOT OLD.source OR NEW.source_ref IS NOT OLD.source_ref
BEGIN
  SELECT RAISE(ABORT, 'entitlement source provenance is immutable');
END;

CREATE TRIGGER service_credentials_source_identity_update
BEFORE UPDATE OF id, product_id, environment_id, tenant_id, principal_id ON service_credentials
WHEN EXISTS (
  SELECT 1
    FROM entitlements
   WHERE source = 'service'
     AND source_ref = OLD.id
     AND (
       NEW.id IS NOT OLD.id
       OR product_id IS NOT NEW.product_id
       OR environment_id IS NOT NEW.environment_id
       OR tenant_id IS NOT NEW.tenant_id
       OR principal_id IS NOT NEW.principal_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'service credential source identity mismatch');
END;

CREATE TRIGGER service_credentials_source_delete
BEFORE DELETE ON service_credentials
BEGIN
  DELETE FROM entitlements
   WHERE source = 'service' AND source_ref = OLD.id;
END;

CREATE TRIGGER access_codes_source_identity_update
BEFORE UPDATE OF id, product_id, environment_id, tenant_id ON access_codes
WHEN EXISTS (
  SELECT 1
    FROM activations
   WHERE access_code_id = OLD.id
     AND (OLD.id IS NOT NEW.id OR tenant_id IS NOT NEW.tenant_id)
)
OR EXISTS (
  SELECT 1
    FROM entitlements
   WHERE source = 'access_code'
     AND source_ref = OLD.id
     AND (
       OLD.id IS NOT NEW.id
       OR product_id IS NOT NEW.product_id
       OR environment_id IS NOT NEW.environment_id
       OR tenant_id IS NOT NEW.tenant_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'access code source identity mismatch');
END;

CREATE TRIGGER access_codes_source_delete
BEFORE DELETE ON access_codes
BEGIN
  DELETE FROM entitlements
   WHERE source = 'access_code' AND source_ref = OLD.id;
END;

CREATE TRIGGER activations_source_delete
BEFORE DELETE ON activations
BEGIN
  DELETE FROM entitlements
   WHERE source = 'access_code'
     AND source_ref = OLD.access_code_id
     AND tenant_id = OLD.tenant_id
     AND principal_id = OLD.principal_id;
END;

CREATE TABLE token_grants (
  id TEXT PRIMARY KEY NOT NULL,
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
  created_at INTEGER NOT NULL,
  FOREIGN KEY (environment_id, product_id)
    REFERENCES environments(id, product_id) ON DELETE CASCADE
);

CREATE TRIGGER token_grants_entitlement_identity_insert
BEFORE INSERT ON token_grants
WHEN NEW.entitlement_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM entitlements
     WHERE id = NEW.entitlement_id
       AND product_id = NEW.product_id
       AND environment_id = NEW.environment_id
       AND tenant_id = NEW.tenant_id
       AND principal_id = NEW.principal_id
  )
BEGIN
  SELECT RAISE(ABORT, 'token grant entitlement identity mismatch');
END;

CREATE TRIGGER token_grants_entitlement_identity_update
BEFORE UPDATE OF entitlement_id, product_id, environment_id, tenant_id, principal_id ON token_grants
WHEN NEW.entitlement_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM entitlements
     WHERE id = NEW.entitlement_id
       AND product_id = NEW.product_id
       AND environment_id = NEW.environment_id
       AND tenant_id = NEW.tenant_id
       AND principal_id = NEW.principal_id
  )
BEGIN
  SELECT RAISE(ABORT, 'token grant entitlement identity mismatch');
END;

CREATE TRIGGER entitlements_grant_identity_update
BEFORE UPDATE OF product_id, environment_id, tenant_id, principal_id ON entitlements
WHEN EXISTS (
  SELECT 1
    FROM token_grants
   WHERE entitlement_id = OLD.id
     AND (
       product_id IS NOT NEW.product_id
       OR environment_id IS NOT NEW.environment_id
       OR tenant_id IS NOT NEW.tenant_id
       OR principal_id IS NOT NEW.principal_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'token grant entitlement identity mismatch');
END;

CREATE INDEX token_grants_active_idx ON token_grants(jti_hash, expires_at, revoked_at);

CREATE INDEX token_grants_environment_active_idx
  ON token_grants(product_id, environment_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE idempotency_keys (
  scope_hash TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('started', 'completed', 'failed')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (scope_hash, key_hash)
);

CREATE TABLE provider_attempts (
  id TEXT PRIMARY KEY NOT NULL,
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
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens BETWEEN 0 AND 10000000),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens BETWEEN 0 AND 200000),
  cost_microcents INTEGER NOT NULL DEFAULT 0 CHECK (cost_microcents BETWEEN 0 AND 10200000000000),
  created_at INTEGER NOT NULL,
  stale_after INTEGER NOT NULL CHECK (stale_after >= created_at),
  UNIQUE (request_id, attempt_number)
);

CREATE INDEX provider_attempts_product_time_idx
  ON provider_attempts(product_id, environment_id, created_at);

CREATE INDEX provider_attempts_stale_idx
  ON provider_attempts(error_class, stale_after);

CREATE INDEX provider_attempts_finalized_time_idx
  ON provider_attempts(created_at)
  WHERE error_class IS NULL OR error_class <> 'attempt_started';

CREATE INDEX provider_attempts_recent_idx
  ON provider_attempts(created_at DESC);

CREATE VIEW stale_provider_attempts AS
SELECT request_id, product_id, environment_id, route_id, provider, resolved_model, endpoint,
       input_tokens, output_tokens, cost_microcents, created_at, stale_after
FROM provider_attempts
WHERE error_class = 'attempt_started' AND stale_after <= unixepoch();

CREATE TABLE admin_audit (
  id TEXT PRIMARY KEY NOT NULL,
  action TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  actor_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX admin_audit_recent_idx ON admin_audit(created_at DESC);
