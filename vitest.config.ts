import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const testBindings = {
  ["TOKEN_" + "SIGNING_SECRET"]:
    "public-fixture-signing-material-at-least-32-bytes",
  CREDENTIAL_PEPPER: "public-fixture-pepper-material-at-least-32-bytes",
  ADMIN_TOKEN: "public-fixture-admin-token-at-least-32-bytes",
  ENABLE_DEV_ISSUER: "true",
  DEPLOYMENT_ENV: "test",
};

export default defineConfig(async () => {
  const migrations = await readD1Migrations(
    fileURLToPath(new URL("./db/migrations", import.meta.url).href),
  );
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./apps/gateway/wrangler.jsonc" },
        miniflare: {
          bindings: {
            ...testBindings,
            TEST_MIGRATIONS: JSON.stringify(migrations),
          },
        },
      }),
    ],
    resolve: {
      alias: {
        "@tkslopper/shared": fileURLToPath(
          new URL("./packages/shared/src/index.ts", import.meta.url).href,
        ),
      },
    },
    test: {
      setupFiles: ["./tests/setup.ts"],
      coverage: { reporter: ["text", "json", "html"] },
    },
  };
});
