-- schema_metadata is absent from legacy databases; its current key is declared
-- PRIMARY KEY NOT NULL in the initial pre-release schema.
SELECT 'products_primary_key_null' AS violation, COUNT(*) AS row_count
FROM products
WHERE id IS NULL
HAVING COUNT(*) > 0;

SELECT 'environments_primary_key_null' AS violation, COUNT(*) AS row_count
FROM environments
WHERE id IS NULL
HAVING COUNT(*) > 0;

SELECT 'aliases_primary_key_null' AS violation, COUNT(*) AS row_count
FROM aliases
WHERE id IS NULL
HAVING COUNT(*) > 0;

SELECT 'entitlements_primary_key_null' AS violation, COUNT(*) AS row_count
FROM entitlements
WHERE id IS NULL
HAVING COUNT(*) > 0;

SELECT 'service_credentials_primary_key_null' AS violation, COUNT(*) AS row_count
FROM service_credentials
WHERE id IS NULL
HAVING COUNT(*) > 0;

SELECT 'access_codes_primary_key_null' AS violation, COUNT(*) AS row_count
FROM access_codes
WHERE id IS NULL
HAVING COUNT(*) > 0;

SELECT 'activations_primary_key_null' AS violation, COUNT(*) AS row_count
FROM activations
WHERE id IS NULL
HAVING COUNT(*) > 0;

SELECT 'token_grants_primary_key_null' AS violation, COUNT(*) AS row_count
FROM token_grants
WHERE id IS NULL
HAVING COUNT(*) > 0;

SELECT 'provider_attempts_primary_key_null' AS violation, COUNT(*) AS row_count
FROM provider_attempts
WHERE id IS NULL
HAVING COUNT(*) > 0;

SELECT 'admin_audit_primary_key_null' AS violation, COUNT(*) AS row_count
FROM admin_audit
WHERE id IS NULL
HAVING COUNT(*) > 0;

SELECT 'aliases_product_environment' AS violation, COUNT(*) AS row_count
FROM aliases AS child
LEFT JOIN environments AS environment
  ON environment.id = child.environment_id AND environment.product_id = child.product_id
WHERE environment.id IS NULL
HAVING COUNT(*) > 0;

SELECT 'entitlements_product_environment' AS violation, COUNT(*) AS row_count
FROM entitlements AS child
LEFT JOIN environments AS environment
  ON environment.id = child.environment_id AND environment.product_id = child.product_id
WHERE environment.id IS NULL
HAVING COUNT(*) > 0;

SELECT 'service_credentials_product_environment' AS violation, COUNT(*) AS row_count
FROM service_credentials AS child
LEFT JOIN environments AS environment
  ON environment.id = child.environment_id AND environment.product_id = child.product_id
WHERE environment.id IS NULL
HAVING COUNT(*) > 0;

SELECT 'access_codes_product_environment' AS violation, COUNT(*) AS row_count
FROM access_codes AS child
LEFT JOIN environments AS environment
  ON environment.id = child.environment_id AND environment.product_id = child.product_id
WHERE environment.id IS NULL
HAVING COUNT(*) > 0;

SELECT 'entitlements_managed_source_reference' AS violation, COUNT(*) AS row_count
FROM entitlements
WHERE source IN ('access_code', 'service') AND source_ref IS NULL
HAVING COUNT(*) > 0;

SELECT 'entitlements_service_identity' AS violation, COUNT(*) AS row_count
FROM entitlements AS entitlement
LEFT JOIN service_credentials AS credential
  ON credential.id = entitlement.source_ref
 AND credential.product_id = entitlement.product_id
 AND credential.environment_id = entitlement.environment_id
 AND credential.tenant_id = entitlement.tenant_id
 AND credential.principal_id = entitlement.principal_id
WHERE entitlement.source = 'service' AND credential.id IS NULL
HAVING COUNT(*) > 0;

SELECT 'activations_access_code_identity' AS violation, COUNT(*) AS row_count
FROM activations AS activation
LEFT JOIN access_codes AS code
  ON code.id = activation.access_code_id AND code.tenant_id = activation.tenant_id
WHERE code.id IS NULL
HAVING COUNT(*) > 0;

SELECT 'activations_access_code_principal_unique' AS violation,
       SUM(duplicate_count - 1) AS row_count
FROM (
  SELECT COUNT(*) AS duplicate_count
  FROM activations
  GROUP BY access_code_id, tenant_id, principal_id
  HAVING COUNT(*) > 1
)
HAVING SUM(duplicate_count - 1) > 0;

SELECT 'entitlements_access_code_identity' AS violation, COUNT(*) AS row_count
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
HAVING COUNT(*) > 0;

SELECT 'token_grants_product_environment' AS violation, COUNT(*) AS row_count
FROM token_grants AS child
LEFT JOIN environments AS environment
  ON environment.id = child.environment_id AND environment.product_id = child.product_id
WHERE environment.id IS NULL
HAVING COUNT(*) > 0;

SELECT 'token_grants_entitlement_identity' AS violation, COUNT(*) AS row_count
FROM token_grants AS grant_row
LEFT JOIN entitlements AS entitlement ON entitlement.id = grant_row.entitlement_id
WHERE grant_row.entitlement_id IS NOT NULL
  AND (
    entitlement.id IS NULL
    OR entitlement.product_id <> grant_row.product_id
    OR entitlement.environment_id <> grant_row.environment_id
    OR entitlement.tenant_id <> grant_row.tenant_id
    OR entitlement.principal_id <> grant_row.principal_id
  )
HAVING COUNT(*) > 0;

SELECT 'provider_attempt_bounds' AS violation, COUNT(*) AS row_count
FROM provider_attempts
WHERE input_tokens NOT BETWEEN 0 AND 10000000
   OR output_tokens NOT BETWEEN 0 AND 200000
   OR cost_microcents NOT BETWEEN 0 AND 10200000000000
HAVING COUNT(*) > 0;
