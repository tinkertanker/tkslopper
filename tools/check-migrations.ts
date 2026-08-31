import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

async function main(): Promise<void> {
  const persistenceDirectory = await mkdtemp(
    join(tmpdir(), "tkslopper-migrations-"),
  );
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "pnpm",
        [
          "exec",
          "wrangler",
          "d1",
          "migrations",
          "apply",
          "tkslopper",
          "--local",
          "--persist-to",
          persistenceDirectory,
          "--config",
          "apps/control-plane/wrangler.jsonc",
        ],
        { stdio: "inherit" },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`migration check exited ${code}`)),
      );
    });
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
