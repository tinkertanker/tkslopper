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
    await runWrangler([
      "d1",
      "execute",
      ...databaseArgs,
      "--file",
      "db/preflight/identity_integrity.sql",
    ]);
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
