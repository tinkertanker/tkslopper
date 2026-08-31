import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const forbiddenPaths = [
  /(^|\/)\.dev\.vars$/u,
  /(^|\/)\.env($|\.)/u,
  /(^|\/)\.wrangler\//u,
  /(^|\/)dist\//u,
  /(^|\/)coverage\//u,
  /(^|\/)node_modules\//u,
];

const secretPatterns: Array<[string, RegExp]> = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u],
  ["GitHub token", /\bgh[opsu]_[A-Za-z0-9]{30,}\b/u],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{20,}\b/u],
  [
    "Cloudflare API token",
    /CLOUDFLARE_API_TOKEN\s*[:=]\s*["']?[A-Za-z0-9_-]{40}\b/u,
  ],
  ["live Stripe key", /\b[rs]k_live_[A-Za-z0-9]{16,}\b/u],
];

function candidateFiles(): string[] {
  const result = spawnSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0) throw new Error("git ls-files failed");
  return result.stdout.split("\0").filter(Boolean);
}

async function main(): Promise<void> {
  const failures: string[] = [];
  for (const path of candidateFiles()) {
    const isEnvironmentExample =
      path.endsWith(".env.example") || path.endsWith(".dev.vars.example");
    if (
      !isEnvironmentExample &&
      forbiddenPaths.some((pattern) => pattern.test(path))
    ) {
      failures.push(`${path}: forbidden tracked/generated path`);
    }
    if (path === "pnpm-lock.yaml") continue;
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch {
      continue;
    }
    for (const [label, pattern] of secretPatterns) {
      if (pattern.test(contents)) failures.push(`${path}: possible ${label}`);
    }
  }
  if (failures.length > 0)
    throw new Error(`public hygiene check failed:\n${failures.join("\n")}`);
  console.log(
    `Public hygiene check passed for ${candidateFiles().length} candidate files.`,
  );
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "public hygiene check failed",
  );
  process.exit(1);
});
