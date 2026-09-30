import { readFile } from "node:fs/promises";

const routes: Record<string, string> = {
  "product:create": "/admin/v1/products",
  "environment:create": "/admin/v1/environments",
  "environment:update": "/admin/v1/environments/update",
  "alias:upsert": "/admin/v1/aliases",
  "entitlement:create": "/admin/v1/entitlements",
  "service-credential:create": "/admin/v1/service-credentials",
  "access-code:create": "/admin/v1/access-codes",
  revoke: "/admin/v1/revoke",
  "kill-switch:set": "/admin/v1/kill-switch",
  "dev:issue": "/admin/v1/dev/issue",
  "admins:grant": "/admin/v1/admins",
  "admins:remove": "/admin/v1/admins",
};

/** Flag names accepted by `environment update`, mapped to request fields. */
const environmentFlags: Record<string, string> = {
  "--rpm": "rpm_limit",
  "--tpm": "tpm_limit",
  "--concurrency": "concurrency_limit",
  "--daily-microcents": "daily_budget_microcents",
  "--max-request-bytes": "max_request_bytes",
  "--ttl": "token_ttl_seconds",
};

function usage(): never {
  console.error(`tkslopper admin CLI

Usage:
  pnpm admin -- <resource> <action> (--json '<object>' | --file path.json)
  pnpm admin -- revoke (--json '<object>' | --file path.json)
  pnpm admin -- admins (grant | remove) <email>
  pnpm admin -- environment update <product_id> <environment_id>
      [--rpm N] [--tpm N] [--concurrency N] [--daily-microcents N]
      [--max-request-bytes N] [--ttl N]

Commands:
  product create              environment create
  environment update          alias upsert
  entitlement create          service-credential create
  access-code create          revoke
  kill-switch set             dev issue
  admins grant                admins remove

environment update also accepts --json/--file with product_id, environment_id
and at least one setting. Only supplied settings change.

Environment:
  TKSLOPPER_CONTROL_PLANE_URL  Control Worker base URL
  TKSLOPPER_ADMIN_TOKEN        Admin bearer token (never pass it as an argument)

The response can contain a one-time credential or access code. Handle stdout as a secret.`);
  process.exit(2);
  throw new Error("process.exit returned unexpectedly");
}

function validatedBaseUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TKSLOPPER_CONTROL_PLANE_URL is not a valid URL");
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
      "TKSLOPPER_CONTROL_PLANE_URL must be HTTPS (or HTTP loopback) without credentials, path, query, or fragment",
    );
  }
  return url.origin;
}

async function jsonBody(arguments_: string[]): Promise<object> {
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
  return body;
}

/** `admins grant|remove <email>`; the control plane normalises the email. */
function adminMemberBody(enabled: boolean, rest: string[]): object {
  const [email, ...extra] = rest;
  if (!email || email.startsWith("--") || extra.length > 0) usage();
  return { email, enabled };
}

/** `environment update <product_id> <environment_id> --flag N ...` */
function environmentUpdateBody(rest: string[]): object {
  const [productId, environmentId, ...flags] = rest;
  if (
    !productId ||
    !environmentId ||
    productId.startsWith("--") ||
    environmentId.startsWith("--") ||
    flags.length === 0 ||
    flags.length % 2 !== 0
  )
    usage();
  const body: Record<string, unknown> = {
    product_id: productId,
    environment_id: environmentId,
  };
  for (let index = 0; index < flags.length; index += 2) {
    const field = environmentFlags[flags[index]!];
    const value = flags[index + 1]!;
    if (!field || field in body) usage();
    if (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)))
      throw new Error(`${flags[index]} must be a non-negative integer`);
    body[field] = Number(value);
  }
  return body;
}

async function main(): Promise<void> {
  // pnpm 10 forwards the documented `--` separator to the script.
  const arguments_ = process.argv
    .slice(2)
    .filter((value, index) => index !== 0 || value !== "--");
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

  const body =
    key === "admins:grant" || key === "admins:remove"
      ? adminMemberBody(key === "admins:grant", arguments_.slice(2))
      : key === "environment:update" &&
          !arguments_.includes("--json") &&
          !arguments_.includes("--file")
        ? environmentUpdateBody(arguments_.slice(2))
        : await jsonBody(arguments_);

  const configuredBaseUrl = process.env.TKSLOPPER_CONTROL_PLANE_URL;
  const adminToken = process.env.TKSLOPPER_ADMIN_TOKEN;
  if (!configuredBaseUrl || !adminToken)
    throw new Error(
      "TKSLOPPER_CONTROL_PLANE_URL and TKSLOPPER_ADMIN_TOKEN are required",
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
