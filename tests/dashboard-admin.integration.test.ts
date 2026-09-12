import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  handleControlPlane,
  type ControlPlaneEnv,
} from "../apps/control-plane/src";

const config = {
  ...env,
  DASHBOARD_ACCESS_AUD: "admin-test",
} as unknown as ControlPlaneEnv;
const origin = "https://control.example.invalid";
const identity = (email: string) => ({
  access: { aud: "admin-test", getIdentity: () => Promise.resolve({ email }) },
});
function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return new Request(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("named dashboard admins", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM dashboard_admins"),
      env.DB.prepare("DELETE FROM admin_audit"),
    ]);
  });

  it("rolls back role changes when audit persistence fails and preserves a last admin under concurrent removals", async () => {
    const setMember = (email: string, enabled: boolean) =>
      handleControlPlane(
        post(
          "/admin/v1/admins",
          { email, enabled },
          { authorization: `Bearer ${String(env.ADMIN_TOKEN)}` },
        ),
        config,
      );
    await env.DB.exec(
      "CREATE TRIGGER reject_admin_audit BEFORE INSERT ON admin_audit BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END",
    );
    expect((await setMember("first@tinkertanker.com", true)).status).toBe(500);
    expect(
      await env.DB.prepare("SELECT id FROM dashboard_admins").first(),
    ).toBeNull();
    await env.DB.exec("DROP TRIGGER reject_admin_audit");
    expect((await setMember("first@tinkertanker.com", true)).status).toBe(200);
    expect((await setMember("second@tinkertanker.com", true)).status).toBe(200);
    const removals = await Promise.all([
      setMember("first@tinkertanker.com", false),
      setMember("second@tinkertanker.com", false),
    ]);
    expect(removals.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM dashboard_admins WHERE enabled = 1",
      ).first(),
    ).toEqual({ n: 1 });
  });

  it("bootstraps with bearer, checks login and origin, audits the person and revokes writes", async () => {
    const owner = identity("Owner@tinkertanker.com");
    const member = identity("member@tinkertanker.com");
    const grant = { email: "owner@tinkertanker.com", enabled: true };
    const bootstrap = await handleControlPlane(
      post("/admin/v1/admins", grant, {
        authorization: `Bearer ${String(env.ADMIN_TOKEN)}`,
      }),
      config,
    );
    expect(bootstrap.status).toBe(200);
    const session = await handleControlPlane(
      new Request(origin + "/dashboard/api/session"),
      config,
      owner,
    );
    expect(await session.json()).toMatchObject({
      role: "admin",
      email: grant.email,
    });
    const create = () =>
      post(
        "/dashboard/api/products",
        { slug: "named-admin", display_name: "Named admin" },
        { origin },
      );
    expect((await handleControlPlane(create(), config, member)).status).toBe(
      403,
    );
    expect((await handleControlPlane(create(), config)).status).toBe(401);
    expect(
      (
        await handleControlPlane(create(), config, {
          access: { ...owner.access, aud: "wrong" },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await handleControlPlane(
          post(
            "/dashboard/api/products",
            {},
            { origin, "content-type": "text/plain" },
          ),
          config,
          owner,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleControlPlane(
          post(
            "/dashboard/api/products",
            {},
            { origin: "https://evil.invalid" },
          ),
          config,
          owner,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleControlPlane(
          post("/dashboard/api/products", {}),
          config,
          owner,
        )
      ).status,
    ).toBe(403);
    expect((await handleControlPlane(create(), config, owner)).status).toBe(
      201,
    );
    const details = await handleControlPlane(
      new Request(origin + "/dashboard/api/session"),
      config,
      owner,
    );
    expect(await details.json()).toMatchObject({
      recent_actions: expect.arrayContaining([
        expect.objectContaining({ action: "create", actor_email: grant.email }),
      ]) as unknown,
    });
    const viewers = await handleControlPlane(
      new Request(origin + "/dashboard/api/session"),
      config,
      member,
    );
    expect(await viewers.json()).toEqual({ role: "viewer" });
    expect(
      (
        await handleControlPlane(
          post(
            "/dashboard/api/admins",
            { ...grant, enabled: false },
            { origin },
          ),
          config,
          owner,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await handleControlPlane(
          post(
            "/dashboard/api/admins",
            { email: "member@tinkertanker.com", enabled: true },
            { origin },
          ),
          config,
          owner,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handleControlPlane(
          post(
            "/dashboard/api/admins",
            { ...grant, enabled: false },
            { origin },
          ),
          config,
          member,
        )
      ).status,
    ).toBe(200);
    expect((await handleControlPlane(create(), config, owner)).status).toBe(
      403,
    );
    const audit = await handleControlPlane(
      new Request(origin + "/dashboard/api/session"),
      config,
      member,
    );
    expect(await audit.json()).toMatchObject({
      recent_actions: expect.arrayContaining([
        expect.objectContaining({ action: "create", actor_email: grant.email }),
        expect.objectContaining({
          action: "admin_revoke",
          actor_email: "member@tinkertanker.com",
          target_email: grant.email,
        }),
      ]) as unknown,
    });
    const viewerMetadata = await handleControlPlane(
      new Request(origin + "/admin/v1/dashboard"),
      config,
      owner,
    );
    expect(viewerMetadata.status).toBe(200);
    const viewerText = await viewerMetadata.text();
    expect(viewerText).not.toContain(grant.email);
    expect(viewerText).not.toContain("member@tinkertanker.com");
  });
});
