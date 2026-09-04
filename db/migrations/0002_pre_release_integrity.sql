-- This migration upgrades databases that already recorded the original
-- 0001_initial.sql. Run db/preflight/identity_integrity.sql first; the guard
-- below repeats the same checks and aborts before any table is rebuilt.
CREATE TABLE _migration_0002_identity_guard (
  clean INTEGER NOT NULL CHECK (clean = 1)
);

INSERT INTO _migration_0002_identity_guard (clean)
SELECT CASE WHEN
  EXISTS (SELECT 1 FROM products WHERE id IS NULL)
  OR EXISTS (SELECT 1 FROM environments WHERE id IS NULL)
  OR EXISTS (SELECT 1 FROM aliases WHERE id IS NULL)
  OR EXISTS (SELECT 1 FROM entitlements WHERE id IS NULL)
  OR EXISTS (SELECT 1 FROM service_credentials WHERE id IS NULL)
  OR EXISTS (SELECT 1 FROM access_codes WHERE id IS NULL)
  OR EXISTS (SELECT 1 FROM activations WHERE id IS NULL)
  OR EXISTS (SELECT 1 FROM token_grants WHERE id IS NULL)
  OR EXISTS (SELECT 1 FROM provider_attempts WHERE id IS NULL)
  OR EXISTS (SELECT 1 FROM admin_audit WHERE id IS NULL)
  OR EXISTS (
    SELECT 1
      FROM aliases AS child
      LEFT JOIN environments AS environment
        ON environment.id = child.environment_id
       AND environment.product_id = child.product_id
     WHERE environment.id IS NULL
  )
  OR EXISTS (
    SELECT 1
      FROM entitlements AS child
      LEFT JOIN environments AS environment
        ON environment.id = child.environment_id
       AND environment.product_id = child.product_id
     WHERE environment.id IS NULL
  )
  OR EXISTS (
    SELECT 1
      FROM service_credentials AS child
      LEFT JOIN environments AS environment
        ON environment.id = child.environment_id
       AND environment.product_id = child.product_id
     WHERE environment.id IS NULL
  )
  OR EXISTS (
    SELECT 1
      FROM access_codes AS child
      LEFT JOIN environments AS environment
        ON environment.id = child.environment_id
       AND environment.product_id = child.product_id
     WHERE environment.id IS NULL
  )
  OR EXISTS (
    SELECT 1
      FROM entitlements
     WHERE source IN ('access_code', 'service') AND source_ref IS NULL
  )
  OR EXISTS (
    SELECT 1
      FROM entitlements AS entitlement
      LEFT JOIN service_credentials AS credential
        ON credential.id = entitlement.source_ref
       AND credential.product_id = entitlement.product_id
       AND credential.environment_id = entitlement.environment_id
       AND credential.tenant_id = entitlement.tenant_id
       AND credential.principal_id = entitlement.principal_id
     WHERE entitlement.source = 'service' AND credential.id IS NULL
  )
  OR EXISTS (
    SELECT 1
      FROM activations AS activation
      LEFT JOIN access_codes AS code
        ON code.id = activation.access_code_id
       AND code.tenant_id = activation.tenant_id
     WHERE code.id IS NULL
  )
  OR EXISTS (
    SELECT 1
      FROM activations
     GROUP BY access_code_id, tenant_id, principal_id
    HAVING COUNT(*) > 1
  )
  OR EXISTS (
    SELECT 1
      FROM entitlements AS entitlement
      LEFT JOIN access_codes AS code
        ON code.id = entitlement.source_ref
       AND code.product_id = entitlement.product_id
       AND code.environment_id = entitlement.environment_id
       AND code.tenant_id = entitlement.tenant_id
      LEFT JOIN activations AS activation
        ON activation.access_code_id = entitlement.source_ref
       AND activation.tenant_id = entitlement.tenant_id
       AND activation.principal_id = entitlement.principal_id
     WHERE entitlement.source = 'access_code'
       AND (code.id IS NULL OR activation.id IS NULL)
  )
  OR EXISTS (
    SELECT 1
      FROM token_grants AS child
      LEFT JOIN environments AS environment
        ON environment.id = child.environment_id
       AND environment.product_id = child.product_id
     WHERE environment.id IS NULL
  )
  OR EXISTS (
    SELECT 1
      FROM token_grants AS grant_row
      LEFT JOIN entitlements AS entitlement
        ON entitlement.id = grant_row.entitlement_id
     WHERE grant_row.entitlement_id IS NOT NULL
       AND (
         entitlement.id IS NULL
         OR entitlement.product_id <> grant_row.product_id
         OR entitlement.environment_id <> grant_row.environment_id
         OR entitlement.tenant_id <> grant_row.tenant_id
         OR entitlement.principal_id <> grant_row.principal_id
       )
  )
  OR EXISTS (
    SELECT 1
      FROM provider_attempts
     WHERE input_tokens NOT BETWEEN 0 AND 10000000
        OR output_tokens NOT BETWEEN 0 AND 200000
        OR cost_microcents NOT BETWEEN 0 AND 10200000000000
  )
THEN 0 ELSE 1 END;

DROP INDEX entitlements_principal_idx;
DROP INDEX entitlements_source_idx;
DROP INDEX entitlements_source_principal_unique;
DROP INDEX token_grants_active_idx;
DROP INDEX provider_attempts_product_time_idx;

ALTER TABLE products RENAME TO products_legacy;
ALTER TABLE environments RENAME TO environments_legacy;
ALTER TABLE aliases RENAME TO aliases_legacy;
ALTER TABLE entitlements RENAME TO entitlements_legacy;
ALTER TABLE service_credentials RENAME TO service_credentials_legacy;
ALTER TABLE access_codes RENAME TO access_codes_legacy;
ALTER TABLE activations RENAME TO activations_legacy;
ALTER TABLE token_grants RENAME TO token_grants_legacy;
ALTER TABLE idempotency_keys RENAME TO idempotency_keys_legacy;
ALTER TABLE provider_attempts RENAME TO provider_attempts_legacy;
ALTER TABLE admin_audit RENAME TO admin_audit_legacy;

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
SELECT request_id, product_id, environment_id, alias, policy_version, route_id, provider,
       resolved_model, endpoint, input_tokens, output_tokens, cost_microcents, created_at, stale_after
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

INSERT INTO products
  (id, slug, display_name, enabled, kill_switch, created_at, updated_at)
SELECT id, slug, display_name, enabled, kill_switch, created_at, updated_at
FROM products_legacy;

INSERT INTO environments
  (id, product_id, name, audience, enabled, kill_switch, token_ttl_seconds,
   policy_version, rpm_limit, tpm_limit, concurrency_limit,
   daily_budget_microcents, max_request_bytes, created_at, updated_at)
SELECT id, product_id, name, audience, enabled, kill_switch, token_ttl_seconds,
       policy_version, rpm_limit, tpm_limit, concurrency_limit,
       daily_budget_microcents, max_request_bytes, created_at, updated_at
FROM environments_legacy;

INSERT INTO aliases
  (id, product_id, environment_id, alias, endpoint, route_id, enabled,
   allow_reasoning, allow_images, allow_structured_json, max_input_tokens,
   max_output_tokens, input_cost_microcents_per_million,
   output_cost_microcents_per_million, policy_version, created_at, updated_at)
SELECT id, product_id, environment_id, alias, endpoint, route_id, enabled,
       allow_reasoning, allow_images, allow_structured_json, max_input_tokens,
       max_output_tokens, input_cost_microcents_per_million,
       output_cost_microcents_per_million, policy_version, created_at, updated_at
FROM aliases_legacy;

INSERT INTO service_credentials
  (id, product_id, environment_id, tenant_id, principal_id, secret_salt,
   secret_hash, capabilities_json, disabled, expires_at, created_at, last_used_at)
SELECT id, product_id, environment_id, tenant_id, principal_id, secret_salt,
       secret_hash, capabilities_json, disabled, expires_at, created_at, last_used_at
FROM service_credentials_legacy;

INSERT INTO access_codes
  (id, product_id, environment_id, tenant_id, secret_salt, secret_hash,
   capabilities_json, expires_at, max_activations, activation_count,
   max_failed_attempts, failed_attempts, disabled, created_at, updated_at)
SELECT id, product_id, environment_id, tenant_id, secret_salt, secret_hash,
       capabilities_json, expires_at, max_activations, activation_count,
       max_failed_attempts, failed_attempts, disabled, created_at, updated_at
FROM access_codes_legacy;

INSERT INTO activations
  (id, access_code_id, tenant_id, principal_id, device_hash, activated_at, revoked_at)
SELECT id, access_code_id, tenant_id, principal_id, device_hash, activated_at, revoked_at
FROM activations_legacy;

INSERT INTO entitlements
  (id, product_id, environment_id, tenant_id, principal_id, source, source_ref,
   capabilities_json, status, expires_at, created_at, updated_at)
SELECT id, product_id, environment_id, tenant_id, principal_id, source, source_ref,
       capabilities_json, status, expires_at, created_at, updated_at
FROM entitlements_legacy;

INSERT INTO token_grants
  (id, jti_hash, entitlement_id, product_id, environment_id, tenant_id,
   principal_id, audience, capabilities_json, expires_at, revoked_at, created_at)
SELECT id, jti_hash, entitlement_id, product_id, environment_id, tenant_id,
       principal_id, audience, capabilities_json, expires_at, revoked_at, created_at
FROM token_grants_legacy;

INSERT INTO idempotency_keys
  (scope_hash, key_hash, request_id, status, created_at, expires_at)
SELECT scope_hash, key_hash, request_id, status, created_at, expires_at
FROM idempotency_keys_legacy;

INSERT INTO provider_attempts
  (id, request_id, attempt_number, product_id, environment_id, tenant_hash,
   principal_hash, alias, policy_version, route_id, provider, resolved_model,
   endpoint, status_code, error_class, latency_ms, input_tokens, output_tokens,
   cost_microcents, created_at, stale_after)
SELECT id, request_id, attempt_number, product_id, environment_id, tenant_hash,
       principal_hash, alias, policy_version, route_id, provider, resolved_model,
       endpoint, status_code, error_class, latency_ms, input_tokens, output_tokens,
       cost_microcents, created_at, created_at
FROM provider_attempts_legacy;

INSERT INTO admin_audit
  (id, action, resource_type, resource_id, actor_hash, created_at)
SELECT id, action, resource_type, resource_id, actor_hash, created_at
FROM admin_audit_legacy;

DROP TABLE token_grants_legacy;
DROP TABLE activations_legacy;
DROP TABLE aliases_legacy;
DROP TABLE entitlements_legacy;
DROP TABLE service_credentials_legacy;
DROP TABLE access_codes_legacy;
DROP TABLE environments_legacy;
DROP TABLE products_legacy;
DROP TABLE idempotency_keys_legacy;
DROP TABLE provider_attempts_legacy;
DROP TABLE admin_audit_legacy;

CREATE TABLE schema_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

INSERT INTO schema_metadata (key, value)
VALUES ('schema_version', '2026-09-03.pre-release.3');

DROP TABLE _migration_0002_identity_guard;
