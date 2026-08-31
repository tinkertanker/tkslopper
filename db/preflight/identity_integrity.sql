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
