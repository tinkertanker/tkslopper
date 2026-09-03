import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

async function runWrangler(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "wrangler", ...args], {
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`wrangler check exited ${code}`)),
    );
  });
}

async function runWranglerJson(args: string[]): Promise<unknown> {
  return await new Promise<unknown>((resolve, reject) => {
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
        resolve(JSON.parse(output) as unknown);
      } catch {
        reject(new Error("wrangler JSON check returned invalid output"));
      }
    });
  });
}

function identityViolations(output: unknown): unknown[] {
  if (!Array.isArray(output))
    throw new Error("identity preflight returned an invalid result envelope");
  return (output as unknown[]).flatMap((statement): unknown[] => {
    if (typeof statement !== "object" || statement === null)
      throw new Error(
        "identity preflight returned an invalid statement result",
      );
    const results = (statement as { results?: unknown }).results;
    if (!Array.isArray(results))
      throw new Error("identity preflight omitted statement results");
    return results as unknown[];
  });
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

async function main(): Promise<void> {
  const persistenceDirectory = await mkdtemp(
    join(tmpdir(), "tkslopper-migrations-"),
  );
  try {
    const databaseArgs = [
      "tkslopper",
      "--local",
      "--persist-to",
      persistenceDirectory,
      "--config",
      "apps/control-plane/wrangler.jsonc",
    ];
    await runWrangler(["d1", "migrations", "apply", ...databaseArgs]);
    const preflightArgs = [
      "d1",
      "execute",
      ...databaseArgs,
      "--file",
      "db/preflight/identity_integrity.sql",
    ];
    assertNoIdentityViolations(await runWranglerJson(preflightArgs));

    await runWranglerJson([
      "d1",
      "execute",
      ...databaseArgs,
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
    const dirtyResult = await runWranglerJson(preflightArgs);
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
      ...databaseArgs,
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
    const nullKeyResult = await runWranglerJson(preflightArgs);
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
  } finally {
    await rm(persistenceDirectory, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "migration check failed",
  );
  process.exit(1);
});
