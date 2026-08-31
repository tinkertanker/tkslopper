import { readFile } from "node:fs/promises";

const routes: Record<string, string> = {
  "product:create": "/admin/v1/products",
  "environment:create": "/admin/v1/environments",
  "alias:upsert": "/admin/v1/aliases",
  "entitlement:create": "/admin/v1/entitlements",
  "service-credential:create": "/admin/v1/service-credentials",
  "access-code:create": "/admin/v1/access-codes",
  revoke: "/admin/v1/revoke",
  "kill-switch:set": "/admin/v1/kill-switch",
  "dev:issue": "/admin/v1/dev/issue",
};

function usage(): never {
  console.error(`tkslop admin CLI

Usage:
  pnpm admin -- <resource> <action> (--json '<object>' | --file path.json)
  pnpm admin -- revoke (--json '<object>' | --file path.json)

Commands:
  product create              environment create
  alias upsert                entitlement create
  service-credential create   access-code create
  revoke                      kill-switch set
  dev issue

Environment:
  TKSLOP_CONTROL_PLANE_URL  Control Worker base URL
  TKSLOP_ADMIN_TOKEN        Admin bearer token (never pass it as an argument)

The response can contain a one-time credential or access code. Handle stdout as a secret.`);
  process.exit(2);
  throw new Error("process.exit returned unexpectedly");
}

function validatedBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TKSLOP_CONTROL_PLANE_URL is not a valid URL");
  }
  const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const secure = url.protocol === "https:";
  const local = url.protocol === "http:" && loopbackHosts.has(url.hostname);
  if (
    (!secure && !local) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "/" && url.pathname !== "")
  ) {
    throw new Error(
      "TKSLOP_CONTROL_PLANE_URL must be HTTPS (or HTTP loopback) without credentials, path, query, or fragment",
    );
  }
  return url.origin;
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  if (
    arguments_.length === 0 ||
    arguments_.includes("help") ||
    arguments_.includes("--help")
  )
    usage();
  const first = arguments_[0];
  const second = arguments_[1];
  if (!first) usage();
  const key = first === "revoke" ? "revoke" : `${first}:${second ?? ""}`;
  const route = routes[key];
  if (!route) usage();

  const jsonIndex = arguments_.indexOf("--json");
  const fileIndex = arguments_.indexOf("--file");
  if ((jsonIndex === -1) === (fileIndex === -1)) usage();
  const rawBody =
    jsonIndex >= 0
      ? arguments_[jsonIndex + 1]
      : fileIndex >= 0 && arguments_[fileIndex + 1]
        ? await readFile(arguments_[fileIndex + 1]!, "utf8")
        : undefined;
  if (!rawBody) usage();
  let body: unknown;
  try {
    body = JSON.parse(rawBody) as unknown;
  } catch {
    throw new Error("request body is not valid JSON");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new Error("request body must be a JSON object");
  }

  const configuredBaseUrl = process.env.TKSLOP_CONTROL_PLANE_URL;
  const adminToken = process.env.TKSLOP_ADMIN_TOKEN;
  if (!configuredBaseUrl || !adminToken)
    throw new Error(
      "TKSLOP_CONTROL_PLANE_URL and TKSLOP_ADMIN_TOKEN are required",
    );
  const baseUrl = validatedBaseUrl(configuredBaseUrl);
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${adminToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const responseText = await response.text();
  if (!response.ok) {
    console.error(`control plane returned HTTP ${response.status}`);
    console.error(responseText);
    process.exit(1);
  }
  console.log(responseText);
}

void main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "admin command failed",
  );
  process.exit(1);
});
