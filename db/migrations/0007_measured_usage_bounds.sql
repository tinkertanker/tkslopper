-- Provider measurements can exceed request admission limits. Preserve those
-- measurements for settlement/reconciliation instead of rejecting the evidence.
-- D1 applies each migration transactionally; no shared database is touched by CI.
DROP VIEW stale_provider_attempts;

CREATE TABLE provider_attempts_measured (
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
  input_tokens INTEGER NOT NULL DEFAULT 0 CHECK (input_tokens BETWEEN 0 AND 9007199254740991),
  output_tokens INTEGER NOT NULL DEFAULT 0 CHECK (output_tokens BETWEEN 0 AND 9007199254740991),
  cost_microcents INTEGER NOT NULL DEFAULT 0 CHECK (cost_microcents >= 0),
  created_at INTEGER NOT NULL,
  stale_after INTEGER NOT NULL CHECK (stale_after >= created_at),
  classroom_group_id TEXT REFERENCES classroom_groups(id),
  UNIQUE (request_id, attempt_number)
);

INSERT INTO provider_attempts_measured
SELECT id, request_id, attempt_number, product_id, environment_id, tenant_hash,
       principal_hash, alias, policy_version, route_id, provider, resolved_model,
       endpoint, status_code, error_class, latency_ms, input_tokens, output_tokens,
       cost_microcents, created_at, stale_after, classroom_group_id
FROM provider_attempts;

DROP TABLE provider_attempts;
ALTER TABLE provider_attempts_measured RENAME TO provider_attempts;

CREATE INDEX provider_attempts_product_time_idx
  ON provider_attempts(product_id, environment_id, created_at);
CREATE INDEX provider_attempts_stale_idx
  ON provider_attempts(error_class, stale_after);
CREATE INDEX provider_attempts_finalized_time_idx
  ON provider_attempts(created_at)
  WHERE error_class IS NULL OR error_class <> 'attempt_started';
CREATE INDEX provider_attempts_recent_idx
  ON provider_attempts(created_at DESC);
CREATE INDEX provider_attempts_classroom_group_idx
  ON provider_attempts(classroom_group_id, created_at);

CREATE VIEW stale_provider_attempts AS
SELECT request_id, product_id, environment_id, alias, policy_version, route_id, provider,
       resolved_model, endpoint, input_tokens, output_tokens, cost_microcents, created_at, stale_after
FROM provider_attempts
WHERE error_class = 'attempt_started' AND stale_after <= unixepoch();

UPDATE schema_metadata SET value = '2026-10-27.measured-usage.1'
WHERE key = 'schema_version';
