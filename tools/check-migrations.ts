import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const databaseName = "tkslopper";
const currentConfig = "apps/control-plane/wrangler.jsonc";
const initialMigration = resolve("db/migrations/0001_initial.sql");
const forwardMigration = resolve(
  "db/migrations/0002_pre_release_integrity.sql",
);
const preflightFile = "db/preflight/identity_integrity.sql";

async function runWrangler(args: string[]): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn("pnpm", ["exec", "wrangler", ...args], {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolvePromise()
        : reject(new Error(`wrangler check exited ${code}`)),
    );
  });
}

async function runWranglerExpectFailure(args: string[]): Promise<string> {
  return await new Promise<string>((resolvePromise, reject) => {
    const child = spawn("pnpm", ["exec", "wrangler", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk: string) => {
        output += chunk;
      });
    }
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) {
        reject(new Error("wrangler unexpectedly accepted a dirty migration"));
        return;
      }
      resolvePromise(output);
    });
  });
}

async function runWranglerJson(args: string[]): Promise<unknown> {
  return await new Promise<unknown>((resolvePromise, reject) => {
    const child = spawn("pnpm", ["exec", "wrangler", ...args, "--json"], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`wrangler JSON check exited ${code}`));
        return;
      }
      try {
        resolvePromise(JSON.parse(output) as unknown);
      } catch {
        reject(new Error("wrangler JSON check returned invalid output"));
      }
    });
  });
}

function statementRows(output: unknown): unknown[] {
  if (!Array.isArray(output))
    throw new Error("D1 check returned an invalid result envelope");
  return (output as unknown[]).flatMap((statement): unknown[] => {
    if (typeof statement !== "object" || statement === null)
      throw new Error("D1 check returned an invalid statement result");
    const results = (statement as { results?: unknown }).results;
    if (!Array.isArray(results))
      throw new Error("D1 check omitted statement results");
    return results as unknown[];
  });
}

function identityViolations(output: unknown): unknown[] {
  return statementRows(output);
}

function assertNoIdentityViolations(output: unknown): void {
  const violations = identityViolations(output);
  if (violations.length > 0)
    throw new Error(
      `identity preflight found ${violations.length} violation result(s)`,
    );
}

function hasIdentityViolation(output: unknown, expected: string): boolean {
  return identityViolations(output).some(
    (result) =>
      typeof result === "object" &&
      result !== null &&
      "violation" in result &&
      result.violation === expected,
  );
}

function assertSingleRow(
  output: unknown,
  expected: Record<string, string | number>,
): void {
  const rows = statementRows(output);
  if (rows.length !== 1 || typeof rows[0] !== "object" || rows[0] === null)
    throw new Error("D1 verification did not return exactly one row");
  const row = rows[0] as Record<string, unknown>;
  for (const [field, value] of Object.entries(expected)) {
    if (row[field] !== value)
      throw new Error(
        `D1 verification expected ${field}=${String(value)}, received ${String(row[field])}`,
      );
  }
}

function databaseArgs(
  persistenceDirectory: string,
  config = currentConfig,
): string[] {
  return [
    databaseName,
    "--local",
    "--persist-to",
    persistenceDirectory,
    "--config",
    config,
  ];
}

function preflightArgs(args: string[]): string[] {
  return ["d1", "execute", ...args, "--file", preflightFile];
}

interface LegacyDatabase {
  args: string[];
  migrationsDirectory: string;
}

async function createLegacyDatabase(
  rootDirectory: string,
  name: string,
): Promise<LegacyDatabase> {
  const testDirectory = join(rootDirectory, name);
  const migrationsDirectory = join(testDirectory, "migrations");
  const persistenceDirectory = join(testDirectory, "persistence");
  const config = join(testDirectory, "wrangler.json");
  await mkdir(migrationsDirectory, { recursive: true });
  await copyFile(
    initialMigration,
    join(migrationsDirectory, "0001_initial.sql"),
  );
  await writeFile(
    config,
    JSON.stringify({
      name: `tkslopper-${name}`,
      main: resolve("apps/control-plane/src/index.ts"),
      compatibility_date: "2025-08-30",
      workers_dev: false,
      d1_databases: [
        {
          binding: "DB",
          database_name: databaseName,
          database_id: "00000000-0000-0000-0000-000000000000",
          migrations_dir: migrationsDirectory,
        },
      ],
    }),
  );
  const args = databaseArgs(persistenceDirectory, config);
  await runWrangler(["d1", "migrations", "apply", ...args]);
  return { args, migrationsDirectory };
}

async function stageForwardMigration(
  migrationsDirectory: string,
): Promise<void> {
  await copyFile(
    forwardMigration,
    join(migrationsDirectory, "0002_pre_release_integrity.sql"),
  );
}

async function checkCurrentSchema(rootDirectory: string): Promise<void> {
  const persistenceDirectory = join(rootDirectory, "current");
  const args = databaseArgs(persistenceDirectory);
  await runWrangler(["d1", "migrations", "apply", ...args]);
  const preflight = preflightArgs(args);
  assertNoIdentityViolations(await runWranglerJson(preflight));

  await runWranglerJson([
    "d1",
    "execute",
    ...args,
    "--command",
    `DROP TRIGGER entitlements_service_identity_insert;
     INSERT INTO products (id, slug, display_name, created_at, updated_at)
     VALUES ('preflight_fixture_product', 'preflight-fixture', 'Preflight fixture', 1, 1);
     INSERT INTO environments (id, product_id, name, audience, created_at, updated_at)
     VALUES ('preflight_fixture_environment', 'preflight_fixture_product', 'test',
             'preflight:fixture', 1, 1);
     INSERT INTO entitlements
       (id, product_id, environment_id, tenant_id, principal_id, source, source_ref,
        capabilities_json, status, created_at, updated_at)
     VALUES ('preflight_fixture_entitlement', 'preflight_fixture_product',
             'preflight_fixture_environment', 'tenant_fixture', 'principal_fixture',
             'service', 'missing_service_credential', '["text.chat.v1"]', 'active', 1, 1);`,
  ]);
  const dirtyResult = await runWranglerJson(preflight);
  let rejected = false;
  try {
    assertNoIdentityViolations(dirtyResult);
  } catch {
    rejected = true;
  }
  if (!rejected)
    throw new Error("identity preflight accepted the dirty-state fixture");

  await runWranglerJson([
    "d1",
    "execute",
    ...args,
    "--command",
    `DELETE FROM entitlements WHERE id = 'preflight_fixture_entitlement';
     DROP TABLE token_grants;
     CREATE TABLE token_grants (
       id TEXT PRIMARY KEY,
       entitlement_id TEXT,
       product_id TEXT NOT NULL,
       environment_id TEXT NOT NULL,
       tenant_id TEXT NOT NULL,
       principal_id TEXT NOT NULL
     );
     INSERT INTO token_grants
       (id, entitlement_id, product_id, environment_id, tenant_id, principal_id)
     VALUES (NULL, NULL, 'preflight_fixture_product', 'preflight_fixture_environment',
             'tenant_fixture', 'principal_fixture');`,
  ]);
  const nullKeyResult = await runWranglerJson(preflight);
  if (!hasIdentityViolation(nullKeyResult, "token_grants_primary_key_null"))
    throw new Error("identity preflight missed a NULL logical primary key");
  rejected = false;
  try {
    assertNoIdentityViolations(nullKeyResult);
  } catch {
    rejected = true;
  }
  if (!rejected)
    throw new Error("identity preflight accepted a NULL logical primary key");
  console.log("Identity preflight clean and dirty-state gates passed.");
}

async function seedLegacyDatabase(args: string[]): Promise<void> {
  await runWranglerJson([
    "d1",
    "execute",
    ...args,
    "--command",
    `INSERT INTO products
       (id, slug, display_name, enabled, kill_switch, created_at, updated_at)
     VALUES ('legacy-product', 'legacy-product', 'Legacy product', 1, 0, 100, 101);
     INSERT INTO environments
       (id, product_id, name, audience, enabled, kill_switch, token_ttl_seconds,
        policy_version, rpm_limit, tpm_limit, concurrency_limit,
        daily_budget_microcents, max_request_bytes, created_at, updated_at)
     VALUES ('legacy-environment', 'legacy-product', 'test', 'legacy:audience', 1, 0,
             900, 7, 31, 100001, 3, 1000001, 1048577, 102, 103);
     INSERT INTO aliases
       (id, product_id, environment_id, alias, endpoint, route_id, enabled,
        allow_reasoning, allow_images, allow_structured_json, max_input_tokens,
        max_output_tokens, input_cost_microcents_per_million,
        output_cost_microcents_per_million, policy_version, created_at, updated_at)
     VALUES ('legacy-alias', 'legacy-product', 'legacy-environment', 'fixture.v1',
             'chat', 'fixture-route', 1, 1, 0, 1, 1000, 200, 11, 13, 7, 104, 105);
     INSERT INTO service_credentials
       (id, product_id, environment_id, tenant_id, principal_id, secret_salt,
        secret_hash, capabilities_json, disabled, expires_at, created_at, last_used_at)
     VALUES ('legacy-service', 'legacy-product', 'legacy-environment', 'service-tenant',
             'service-principal', 'fixture-salt', 'fixture-hash', '["text.chat.v1"]',
             0, 10000, 106, 107);
     INSERT INTO access_codes
       (id, product_id, environment_id, tenant_id, secret_salt, secret_hash,
        capabilities_json, expires_at, max_activations, activation_count,
        max_failed_attempts, failed_attempts, disabled, created_at, updated_at)
     VALUES ('legacy-code', 'legacy-product', 'legacy-environment', 'access-tenant',
             'fixture-salt', 'fixture-hash', '["text.chat.v1"]', 10000, 2, 1,
             8, 0, 0, 108, 109);
     INSERT INTO activations
       (id, access_code_id, tenant_id, principal_id, device_hash, activated_at, revoked_at)
     VALUES ('legacy-activation', 'legacy-code', 'access-tenant', 'access-principal',
             'fixture-device', 110, NULL);
     INSERT INTO entitlements
       (id, product_id, environment_id, tenant_id, principal_id, source, source_ref,
        capabilities_json, status, expires_at, created_at, updated_at)
     VALUES
       ('legacy-service-entitlement', 'legacy-product', 'legacy-environment',
        'service-tenant', 'service-principal', 'service', 'legacy-service',
        '["text.chat.v1"]', 'active', 10000, 111, 112),
       ('legacy-access-entitlement', 'legacy-product', 'legacy-environment',
        'access-tenant', 'access-principal', 'access_code', 'legacy-code',
        '["text.chat.v1"]', 'active', 10000, 113, 114),
       ('legacy-dev-entitlement', 'legacy-product', 'legacy-environment',
        'dev-tenant', 'dev-principal', 'dev', NULL,
        '["text.chat.v1"]', 'active', NULL, 115, 116);
     INSERT INTO token_grants
       (id, jti_hash, entitlement_id, product_id, environment_id, tenant_id,
        principal_id, audience, capabilities_json, expires_at, revoked_at, created_at)
     VALUES
       ('legacy-service-grant', 'legacy-jti-service', 'legacy-service-entitlement',
        'legacy-product', 'legacy-environment', 'service-tenant', 'service-principal',
        'legacy:audience', '["text.chat.v1"]', 10000, NULL, 117),
       ('legacy-access-grant', 'legacy-jti-access', 'legacy-access-entitlement',
        'legacy-product', 'legacy-environment', 'access-tenant', 'access-principal',
        'legacy:audience', '["text.chat.v1"]', 10000, NULL, 118),
       ('legacy-dev-grant', 'legacy-jti-dev', 'legacy-dev-entitlement',
        'legacy-product', 'legacy-environment', 'dev-tenant', 'dev-principal',
        'legacy:audience', '["text.chat.v1"]', 10000, 120, 119);
     INSERT INTO idempotency_keys
       (scope_hash, key_hash, request_hash, request_id, status, created_at, expires_at)
     VALUES ('legacy-scope', 'legacy-key', 'legacy-request-hash', 'legacy-request',
             'completed', 121, 10000);
     INSERT INTO provider_attempts
       (id, request_id, attempt_number, product_id, environment_id, tenant_hash,
        principal_hash, alias, policy_version, route_id, provider, resolved_model,
        endpoint, status_code, error_class, latency_ms, input_tokens, output_tokens,
        cost_microcents, created_at)
     VALUES
       ('legacy-started-attempt', 'legacy-started-request', 1, 'legacy-product',
        'legacy-environment', 'tenant-hash', 'principal-hash', 'fixture.v1', 7,
        'fixture-route', 'fixture', 'fixture-model', 'chat', 0, 'attempt_started',
        0, 10, 20, 30, 122),
       ('legacy-complete-attempt', 'legacy-complete-request', 1, 'legacy-product',
        'legacy-environment', 'tenant-hash', 'principal-hash', 'fixture.v1', 7,
        'fixture-route', 'fixture', 'fixture-model', 'chat', 200, NULL,
        40, 50, 60, 70, 123);
     INSERT INTO admin_audit
       (id, action, resource_type, resource_id, actor_hash, created_at)
     VALUES ('legacy-audit', 'upsert', 'environment', 'legacy-environment',
             'fixture-actor', 124);`,
  ]);
}

async function checkLegacyUpgrade(rootDirectory: string): Promise<void> {
  const legacy = await createLegacyDatabase(rootDirectory, "legacy-upgrade");
  await seedLegacyDatabase(legacy.args);
  assertNoIdentityViolations(await runWranglerJson(preflightArgs(legacy.args)));
  await stageForwardMigration(legacy.migrationsDirectory);
  await runWrangler(["d1", "migrations", "apply", ...legacy.args]);

  const result = await runWranglerJson([
    "d1",
    "execute",
    ...legacy.args,
    "--command",
    `SELECT
       (SELECT value FROM schema_metadata WHERE key = 'schema_version') AS schema_version,
       (SELECT COUNT(*) FROM products) AS products,
       (SELECT COUNT(*) FROM environments) AS environments,
       (SELECT COUNT(*) FROM aliases) AS aliases,
       (SELECT COUNT(*) FROM service_credentials) AS service_credentials,
       (SELECT COUNT(*) FROM access_codes) AS access_codes,
       (SELECT COUNT(*) FROM activations) AS activations,
       (SELECT COUNT(*) FROM entitlements) AS entitlements,
       (SELECT COUNT(*) FROM token_grants) AS token_grants,
       (SELECT COUNT(*) FROM idempotency_keys) AS idempotency_keys,
       (SELECT COUNT(*) FROM provider_attempts) AS provider_attempts,
       (SELECT COUNT(*) FROM admin_audit) AS admin_audit,
       (SELECT COUNT(*) FROM pragma_table_info('idempotency_keys')
         WHERE name = 'request_hash') AS request_hash_columns,
       (SELECT request_id FROM idempotency_keys
         WHERE scope_hash = 'legacy-scope' AND key_hash = 'legacy-key') AS idempotency_request_id,
       (SELECT stale_after - created_at FROM provider_attempts
         WHERE id = 'legacy-started-attempt') AS stale_after_offset,
       (SELECT COUNT(*) FROM stale_provider_attempts
         WHERE alias = 'fixture.v1' AND policy_version = 7) AS stale_rows,
       (SELECT COUNT(*) FROM sqlite_master
         WHERE name LIKE '%_legacy' OR name = '_migration_0002_identity_guard') AS temporary_objects,
       (SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'index' AND name IN (
           'aliases_environment_active_idx',
           'entitlements_environment_active_idx',
           'activations_access_code_principal_unique',
           'token_grants_environment_active_idx',
           'provider_attempts_stale_idx',
           'provider_attempts_finalized_time_idx',
           'provider_attempts_recent_idx',
           'admin_audit_recent_idx'
         )) AS new_indexes,
       (SELECT COUNT(*) FROM sqlite_master WHERE type = 'trigger') AS triggers,
       (SELECT COUNT(*) FROM sqlite_master
         WHERE type = 'view' AND name = 'stale_provider_attempts') AS stale_view,
       (SELECT "notnull" FROM pragma_table_info('products') WHERE name = 'id') AS products_id_not_null,
       (SELECT "notnull" FROM pragma_table_info('environments') WHERE name = 'id') AS environments_id_not_null,
       (SELECT "notnull" FROM pragma_table_info('aliases') WHERE name = 'id') AS aliases_id_not_null,
       (SELECT "notnull" FROM pragma_table_info('entitlements') WHERE name = 'id') AS entitlements_id_not_null,
       (SELECT "notnull" FROM pragma_table_info('service_credentials') WHERE name = 'id') AS service_credentials_id_not_null,
       (SELECT "notnull" FROM pragma_table_info('access_codes') WHERE name = 'id') AS access_codes_id_not_null,
       (SELECT "notnull" FROM pragma_table_info('activations') WHERE name = 'id') AS activations_id_not_null,
       (SELECT "notnull" FROM pragma_table_info('token_grants') WHERE name = 'id') AS token_grants_id_not_null,
       (SELECT "notnull" FROM pragma_table_info('provider_attempts') WHERE name = 'id') AS provider_attempts_id_not_null,
       (SELECT "notnull" FROM pragma_table_info('admin_audit') WHERE name = 'id') AS admin_audit_id_not_null;`,
  ]);
  assertSingleRow(result, {
    schema_version: "2026-09-03.pre-release.3",
    products: 1,
    environments: 1,
    aliases: 1,
    service_credentials: 1,
    access_codes: 1,
    activations: 1,
    entitlements: 3,
    token_grants: 3,
    idempotency_keys: 1,
    provider_attempts: 2,
    admin_audit: 1,
    request_hash_columns: 0,
    idempotency_request_id: "legacy-request",
    stale_after_offset: 0,
    stale_rows: 1,
    temporary_objects: 0,
    new_indexes: 8,
    triggers: 15,
    stale_view: 1,
    products_id_not_null: 1,
    environments_id_not_null: 1,
    aliases_id_not_null: 1,
    entitlements_id_not_null: 1,
    service_credentials_id_not_null: 1,
    access_codes_id_not_null: 1,
    activations_id_not_null: 1,
    token_grants_id_not_null: 1,
    provider_attempts_id_not_null: 1,
    admin_audit_id_not_null: 1,
  });
  if (
    statementRows(
      await runWranglerJson([
        "d1",
        "execute",
        ...legacy.args,
        "--command",
        "PRAGMA foreign_key_check;",
      ]),
    ).length > 0
  )
    throw new Error("legacy upgrade left a foreign-key violation");
  assertNoIdentityViolations(await runWranglerJson(preflightArgs(legacy.args)));
  console.log("Legacy 0001 data upgraded to the current schema intact.");
}

async function checkDirtyLegacyUpgrade(rootDirectory: string): Promise<void> {
  const legacy = await createLegacyDatabase(rootDirectory, "legacy-dirty");
  await runWranglerJson([
    "d1",
    "execute",
    ...legacy.args,
    "--command",
    `INSERT INTO products (id, slug, display_name, created_at, updated_at)
     VALUES (NULL, 'dirty-legacy-product', 'Dirty legacy product', 1, 1);`,
  ]);
  const violations = await runWranglerJson(preflightArgs(legacy.args));
  if (!hasIdentityViolation(violations, "products_primary_key_null"))
    throw new Error("identity preflight missed the dirty legacy fixture");
  await stageForwardMigration(legacy.migrationsDirectory);
  const failure = await runWranglerExpectFailure([
    "d1",
    "migrations",
    "apply",
    ...legacy.args,
  ]);
  if (!failure.includes("CHECK constraint failed"))
    throw new Error("dirty legacy migration failed outside its identity guard");

  assertSingleRow(
    await runWranglerJson([
      "d1",
      "execute",
      ...legacy.args,
      "--command",
      `SELECT
         (SELECT COUNT(*) FROM products WHERE id IS NULL) AS dirty_products,
         (SELECT COUNT(*) FROM sqlite_master
           WHERE name = 'schema_metadata') AS schema_metadata_tables,
         (SELECT COUNT(*) FROM sqlite_master
           WHERE name LIKE '%_legacy' OR name = '_migration_0002_identity_guard') AS partial_objects,
         (SELECT "notnull" FROM pragma_table_info('products')
           WHERE name = 'id') AS products_id_not_null;`,
    ]),
    {
      dirty_products: 1,
      schema_metadata_tables: 0,
      partial_objects: 0,
      products_id_not_null: 0,
    },
  );
  console.log("Dirty legacy upgrade rejected and rolled back atomically.");
}

async function main(): Promise<void> {
  const rootDirectory = await mkdtemp(join(tmpdir(), "tkslopper-migrations-"));
  try {
    await checkCurrentSchema(rootDirectory);
    await checkLegacyUpgrade(rootDirectory);
    await checkDirtyLegacyUpgrade(rootDirectory);
  } finally {
    await rm(rootDirectory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "migration check failed",
  );
  process.exit(1);
});
