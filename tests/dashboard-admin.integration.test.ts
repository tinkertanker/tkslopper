import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  handleControlPlane,
  type ControlPlaneEnv,
} from "../apps/control-plane/src";
import { gatewayPublicUrl } from "../apps/control-plane/src/admin-access";

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

describe("gateway public URL for student cards", () => {
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM dashboard_admins"),
      env.DB.prepare(
        `INSERT INTO dashboard_admins (id, email, actor_hash, enabled, created_at, updated_at)
         VALUES ('admin_gateway', 'owner@tinkertanker.com', 'hash_gateway', 1, 1, 1)`,
      ),
    ]);
  });

  it("accepts only a bare https origin and treats blanks and .invalid placeholders as unset", () => {
    expect(gatewayPublicUrl(undefined)).toEqual({
      public_url: null,
      status: "unset",
    });
    expect(gatewayPublicUrl("  ")).toEqual({
      public_url: null,
      status: "unset",
    });
    expect(gatewayPublicUrl("https://gateway.example.com")).toEqual({
      public_url: "https://gateway.example.com",
      status: "configured",
    });
    expect(gatewayPublicUrl(" https://Gateway.Example.com:8443/ ")).toEqual({
      public_url: "https://gateway.example.com:8443",
      status: "configured",
    });
    expect(gatewayPublicUrl("https://gateway.example.invalid")).toEqual({
      public_url: null,
      status: "placeholder",
    });
    for (const invalid of [
      "http://gateway.example.com",
      "gateway.example.com",
      "https://gateway.example.com/v1",
      "https://gateway.example.com/?x=1",
      "https://gateway.example.com/#x",
      "https://user:pass@gateway.example.com",
      "javascript:alert(1)",
      42,
    ]) {
      expect(gatewayPublicUrl(invalid)).toEqual({
        public_url: null,
        status: "invalid",
      });
    }
  });

  it("exposes the gateway origin to admins only and never breaks health when absent or invalid", async () => {
    const owner = identity("owner@tinkertanker.com");
    const member = identity("member@tinkertanker.com");
    const session = async (settings: Partial<ControlPlaneEnv>, who = owner) =>
      (
        await handleControlPlane(
          new Request(origin + "/dashboard/api/session"),
          { ...config, ...settings },
          who,
        )
      ).json();
    expect(
      await session({ GATEWAY_PUBLIC_URL: "https://gateway.example.com/" }),
    ).toMatchObject({
      role: "admin",
      gateway: {
        public_url: "https://gateway.example.com",
        status: "configured",
      },
    });
    expect(await session({})).toMatchObject({
      gateway: { public_url: null, status: "unset" },
    });
    expect(
      await session({ GATEWAY_PUBLIC_URL: "http://gateway.example.com" }),
    ).toMatchObject({ gateway: { public_url: null, status: "invalid" } });
    expect(
      await session(
        { GATEWAY_PUBLIC_URL: "https://gateway.example.com" },
        member,
      ),
    ).toEqual({ role: "viewer" });
    const withoutGateway = { ...config };
    delete withoutGateway.GATEWAY_PUBLIC_URL;
    for (const settings of [
      withoutGateway,
      { ...config, GATEWAY_PUBLIC_URL: "" },
      { ...config, GATEWAY_PUBLIC_URL: "not a url" },
    ]) {
      const health = await handleControlPlane(
        new Request(origin + "/healthz"),
        settings,
      );
      expect(health.status).toBe(200);
    }
  });

  it("reports each environment's token TTL in the dashboard metadata", async () => {
    const bearer = { authorization: `Bearer ${String(env.ADMIN_TOKEN)}` };
    const product = await handleControlPlane(
      post(
        "/admin/v1/products",
        { slug: "ttl-metadata", display_name: "TTL metadata" },
        bearer,
      ),
      config,
    );
    const { id: productId } = await product.json<{ id: string }>();
    const created = await handleControlPlane(
      post(
        "/admin/v1/environments",
        {
          product_id: productId,
          name: "ttl-env",
          audience: "ttl-metadata:env",
          token_ttl_seconds: 600,
        },
        bearer,
      ),
      config,
    );
    expect(created.status).toBe(201);
    const metadata = await handleControlPlane(
      new Request(origin + "/admin/v1/dashboard"),
      config,
      identity("owner@tinkertanker.com"),
    );
    const body = await metadata.json<{
      environments: { product_id: string; token_ttl_seconds: number }[];
    }>();
    expect(
      body.environments.find((row) => row.product_id === productId),
    ).toMatchObject({ token_ttl_seconds: 600 });
  });
});
