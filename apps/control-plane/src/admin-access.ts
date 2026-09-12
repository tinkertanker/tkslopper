import { HttpError, jsonResponse } from "@tkslopper/shared";

type AccessEnv = { DB: D1Database; DASHBOARD_ACCESS_AUD?: string };

export async function requireAccessEmail(
  env: AccessEnv,
  access?: CloudflareAccessContext,
): Promise<string> {
  if (!env.DASHBOARD_ACCESS_AUD || access?.aud !== env.DASHBOARD_ACCESS_AUD)
    throw new HttpError(
      401,
      "authentication_failed",
      "dashboard login required",
    );
  const identity = await access.getIdentity();
  if (typeof identity?.email !== "string" || !identity.email.trim())
    throw new HttpError(
      401,
      "authentication_failed",
      "dashboard login required",
    );
  return identity.email.trim().toLowerCase();
}

export async function requireBrowserAdmin(
  request: Request,
  env: AccessEnv,
  access?: CloudflareAccessContext,
): Promise<string> {
  const email = await requireAccessEmail(env, access);
  // Cookie-authenticated writes must not be forgeable through cross-site forms/fetch.
  if (
    request.headers.get("origin") !== new URL(request.url).origin ||
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
  )
    throw new HttpError(
      403,
      "authorization_failed",
      "same-origin JSON request required",
    );
  const admin = await env.DB.prepare(
    "SELECT actor_hash FROM dashboard_admins WHERE email = ? AND enabled = 1",
  )
    .bind(email)
    .first<{ actor_hash: string }>();
  if (!admin)
    throw new HttpError(
      403,
      "authorization_failed",
      "named admin access required",
    );
  return admin.actor_hash;
}

export async function adminSession(
  env: AccessEnv,
  access?: CloudflareAccessContext,
): Promise<Response> {
  const email = await requireAccessEmail(env, access);
  const admin = await env.DB.prepare(
    "SELECT id FROM dashboard_admins WHERE email = ? AND enabled = 1",
  )
    .bind(email)
    .first();
  if (!admin) return jsonResponse({ role: "viewer" });
  const [members, actions] = (await env.DB.batch([
    env.DB.prepare(
      "SELECT email, enabled FROM dashboard_admins ORDER BY enabled DESC, email LIMIT 101",
    ),
    env.DB.prepare(`SELECT a.action, a.resource_type,
      CASE WHEN a.resource_type = 'access_code' THEN '[redacted]' ELSE a.resource_id END AS resource_id,
      a.created_at, d.email AS actor_email
      FROM admin_audit a LEFT JOIN dashboard_admins d ON d.actor_hash = a.actor_hash
      ORDER BY a.created_at DESC, a.id DESC LIMIT 25`),
  ])) as [D1Result, D1Result];
  return jsonResponse({
    role: "admin",
    email,
    admins: members.results.slice(0, 100),
    admins_truncated: members.results.length > 100,
    recent_actions: actions.results,
  });
}
