import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  handleControlPlane,
  type ControlPlaneEnv,
} from "../apps/control-plane/src";

const controlEnv = env as unknown as ControlPlaneEnv;
const now = (): number => Math.floor(Date.now() / 1000);

beforeEach(async () => {
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM provider_attempts"),
    env.DB.prepare("DELETE FROM idempotency_keys"),
    env.DB.prepare("DELETE FROM token_grants"),
    env.DB.prepare("DELETE FROM activations"),
    env.DB.prepare("DELETE FROM access_codes"),
    env.DB.prepare("DELETE FROM service_credentials"),
    env.DB.prepare("DELETE FROM entitlements"),
    env.DB.prepare("DELETE FROM aliases"),
    env.DB.prepare("DELETE FROM environments"),
    env.DB.prepare("DELETE FROM products"),
    env.DB.prepare("DELETE FROM admin_audit"),
    env.DB.prepare(
      `INSERT INTO products (id, slug, display_name, created_at, updated_at)
       VALUES ('prod_control', 'control-fixture', 'Control fixture', ?, ?)`,
    ).bind(timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO environments
       (id, product_id, name, audience, created_at, updated_at)
       VALUES ('env_control', 'prod_control', 'test', 'control:test', ?, ?)`,
    ).bind(timestamp, timestamp),
  ]);
});

function request(path: string, body: unknown, token?: string): Request {
  return new Request(`https://control.example.invalid${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function get(path: string, token?: string): Request {
  return new Request(`https://control.example.invalid${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

async function admin(path: string, body: unknown): Promise<Response> {
  return handleControlPlane(
    request(path, body, String(env.ADMIN_TOKEN)),
    controlEnv,
  );
}

describe("operations dashboard", () => {
  it("serves an inert same-origin shell without exposing configuration", async () => {
    const response = await handleControlPlane(get("/dashboard"), controlEnv);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'none'",
    );
    expect(response.headers.get("content-security-policy")).not.toContain(
      "unsafe-inline",
    );
    const html = await response.text();
    expect(html).toContain("tkslopper operations");
    expect(html).not.toContain("__CSP_NONCE__");
    expect(html).not.toContain(String(env.ADMIN_TOKEN));
    expect(html).not.toContain(String(env.DASHBOARD_TOKEN));
  });

  it("fails closed when the read credential reuses any control-plane secret", async () => {
    for (const conflictingSecret of [
      controlEnv.ADMIN_TOKEN,
      controlEnv.TOKEN_SIGNING_SECRET,
      controlEnv.CREDENTIAL_PEPPER,
    ]) {
      const response = await handleControlPlane(get("/dashboard"), {
        ...controlEnv,
        DASHBOARD_TOKEN: conflictingSecret,
      });

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "internal_error" },
      });
    }
  });

  it("requires the separate read credential and returns metadata-only operations state", async () => {
    const timestamp = now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO provider_attempts
          (id, request_id, attempt_number, product_id, environment_id, tenant_hash, principal_hash,
           alias, policy_version, route_id, provider, resolved_model, endpoint, status_code,
           error_class, latency_ms, input_tokens, output_tokens, cost_microcents, created_at,
           stale_after)
         VALUES ('attempt_terminal', 'request_terminal', 1, 'prod_control', 'env_control',
                 'private_tenant_hash', 'private_principal_hash', 'text.chat.v1', 1,
                 'route_fixture', 'fixture', 'fixture-model', 'chat', 504, 'provider_timeout',
                 1000, 120, 80, 25, ?, ?)`,
      ).bind(timestamp - 30, timestamp + 30),
      env.DB.prepare(
        `INSERT INTO provider_attempts
          (id, request_id, attempt_number, product_id, environment_id, tenant_hash, principal_hash,
           alias, policy_version, route_id, provider, resolved_model, endpoint, status_code,
           error_class, latency_ms, input_tokens, output_tokens, cost_microcents, created_at,
           stale_after)
         VALUES ('attempt_success', 'request_success', 1, 'prod_control', 'env_control',
                 'private_tenant_hash', 'private_principal_hash', 'text.chat.v1', 1,
                 'route_fixture', 'fixture', 'fixture-model', 'chat', 200, NULL,
                 100, 30, 20, 10, ?, ?)`,
      ).bind(timestamp - 20, timestamp + 40),
      env.DB.prepare(
        `INSERT INTO provider_attempts
          (id, request_id, attempt_number, product_id, environment_id, tenant_hash, principal_hash,
           alias, policy_version, route_id, provider, resolved_model, endpoint, status_code,
           error_class, latency_ms, input_tokens, output_tokens, cost_microcents, created_at,
           stale_after)
         VALUES ('attempt_stale', 'request_stale', 1, 'prod_control', 'env_control',
                 'private_tenant_hash', 'private_principal_hash', 'json.strict.v1', 1,
                 'route_fixture', 'fixture', 'fixture-model', 'responses', 0, 'attempt_started',
                 0, 200, 100, 40, ?, ?)`,
      ).bind(timestamp - 120, timestamp - 60),
      env.DB.prepare(
        `INSERT INTO provider_attempts
          (id, request_id, attempt_number, product_id, environment_id, tenant_hash, principal_hash,
           alias, policy_version, route_id, provider, resolved_model, endpoint, status_code,
           error_class, latency_ms, input_tokens, output_tokens, cost_microcents, created_at,
           stale_after)
         VALUES ('attempt_live', 'request_live', 1, 'prod_control', 'env_control',
                 'private_tenant_hash', 'private_principal_hash', 'text.chat.v1', 1,
                 'route_fixture', 'fixture', 'fixture-model', 'chat', 0, 'attempt_started',
                 0, 400, 200, 80, ?, ?)`,
      ).bind(timestamp - 5, timestamp + 600),
      env.DB.prepare(
        `INSERT INTO admin_audit
          (id, action, resource_type, resource_id, actor_hash, created_at)
         VALUES ('audit_fixture', 'kill', 'environment', 'env_control',
                 'private_actor_hash', ?)`,
      ).bind(timestamp - 10),
    ]);

    expect(
      (await handleControlPlane(get("/admin/v1/dashboard"), controlEnv)).status,
    ).toBe(401);
    expect(
      (
        await handleControlPlane(
          get("/admin/v1/dashboard", String(env.ADMIN_TOKEN)),
          controlEnv,
        )
      ).status,
    ).toBe(401);

    const response = await handleControlPlane(
      get("/admin/v1/dashboard", String(env.DASHBOARD_TOKEN)),
      controlEnv,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const overview: unknown = await response.json();
    expect(overview).toMatchObject({
      totals: {
        products: 1,
        environments: 1,
        finalized_attempts_24h: 2,
        failed_finalized_attempts_24h: 1,
        accounted_input_tokens_24h: "150",
        accounted_output_tokens_24h: "100",
        accounted_cost_microcents_24h: "35",
        stale_attempts: 1,
      },
      products: [
        {
          id: "prod_control",
          slug: "control-fixture",
          display_name: "Control fixture",
          enabled: true,
          kill_switch: false,
        },
      ],
      environments: [
        {
          id: "env_control",
          product_id: "prod_control",
          name: "test",
          audience: "control:test",
          product_enabled: true,
          product_kill_switch: false,
          finalized_attempts_24h: 2,
          failed_finalized_attempts_24h: 1,
          accounted_cost_microcents_24h: "35",
        },
      ],
      stale_attempts: [
        {
          request_id: "request_stale",
          product_id: "prod_control",
          environment_id: "env_control",
        },
      ],
      recent_admin_actions: [
        {
          action: "kill",
          resource_type: "environment",
          resource_id: "env_control",
        },
      ],
      live_quota: {
        available: false,
      },
    });
    const serialized = JSON.stringify(overview);
    expect(serialized).toContain("exclude attempt_started");
    expect(serialized).not.toContain("private_tenant_hash");
    expect(serialized).not.toContain("private_principal_hash");
    expect(serialized).not.toContain("private_actor_hash");
    expect(serialized).not.toContain("secret_hash");
  });

  it("reports gateway-effective grant and parent policy state", async () => {
    const timestamp = now();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO entitlements
          (id, product_id, environment_id, tenant_id, principal_id, source,
           capabilities_json, status, expires_at, created_at, updated_at)
         VALUES ('ent_effective', 'prod_control', 'env_control', 'tenant_fixture',
                 'principal_effective', 'dev', '["text.chat.v1"]', 'active', ?, ?, ?)`,
      ).bind(timestamp + 600, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO entitlements
          (id, product_id, environment_id, tenant_id, principal_id, source,
           capabilities_json, status, expires_at, created_at, updated_at)
         VALUES ('ent_revoked', 'prod_control', 'env_control', 'tenant_fixture',
                 'principal_revoked', 'dev', '["text.chat.v1"]', 'revoked', ?, ?, ?)`,
      ).bind(timestamp + 600, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO access_codes
          (id, product_id, environment_id, tenant_id, secret_salt, secret_hash,
           capabilities_json, expires_at, max_activations, disabled, created_at, updated_at)
         VALUES ('code_disabled', 'prod_control', 'env_control', 'tenant_fixture', 'salt',
                 'hash', '["text.chat.v1"]', ?, 1, 1, ?, ?)`,
      ).bind(timestamp + 600, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO activations
          (id, access_code_id, tenant_id, principal_id, device_hash, activated_at)
         VALUES ('activation_disabled', 'code_disabled', 'tenant_fixture',
                 'principal_disabled', 'device_hash', ?)`,
      ).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO entitlements
          (id, product_id, environment_id, tenant_id, principal_id, source, source_ref,
           capabilities_json, status, expires_at, created_at, updated_at)
         VALUES ('ent_disabled', 'prod_control', 'env_control', 'tenant_fixture',
                 'principal_disabled', 'access_code', 'code_disabled', '["text.chat.v1"]',
                 'active', ?, ?, ?)`,
      ).bind(timestamp + 600, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO token_grants
          (id, jti_hash, entitlement_id, product_id, environment_id, tenant_id, principal_id,
           audience, capabilities_json, expires_at, created_at)
         VALUES ('grant_effective', 'jti_effective', 'ent_effective', 'prod_control',
                 'env_control', 'tenant_fixture', 'principal_effective', 'control:test',
                 '["text.chat.v1"]', ?, ?)`,
      ).bind(timestamp + 300, timestamp),
      env.DB.prepare(
        `INSERT INTO token_grants
          (id, jti_hash, entitlement_id, product_id, environment_id, tenant_id, principal_id,
           audience, capabilities_json, expires_at, created_at)
         VALUES ('grant_revoked', 'jti_revoked', 'ent_revoked', 'prod_control',
                 'env_control', 'tenant_fixture', 'principal_revoked', 'control:test',
                 '["text.chat.v1"]', ?, ?)`,
      ).bind(timestamp + 300, timestamp),
      env.DB.prepare(
        `INSERT INTO token_grants
          (id, jti_hash, entitlement_id, product_id, environment_id, tenant_id, principal_id,
           audience, capabilities_json, expires_at, created_at)
         VALUES ('grant_disabled', 'jti_disabled', 'ent_disabled', 'prod_control',
                 'env_control', 'tenant_fixture', 'principal_disabled', 'control:test',
                 '["text.chat.v1"]', ?, ?)`,
      ).bind(timestamp + 300, timestamp),
    ]);

    const load = async (): Promise<unknown> => {
      const response = await handleControlPlane(
        get("/admin/v1/dashboard", String(env.DASHBOARD_TOKEN)),
        controlEnv,
      );
      expect(response.status).toBe(200);
      const overview: unknown = await response.json();
      return overview;
    };

    expect(await load()).toMatchObject({
      environments: [
        {
          product_enabled: true,
          product_kill_switch: false,
          enabled: true,
          kill_switch: false,
          effective_grants: 1,
        },
      ],
    });

    await env.DB.prepare(
      "UPDATE products SET kill_switch = 1, updated_at = ? WHERE id = 'prod_control'",
    )
      .bind(timestamp)
      .run();
    expect(await load()).toMatchObject({
      products: [{ kill_switch: true }],
      environments: [
        {
          product_enabled: true,
          product_kill_switch: true,
          enabled: true,
          kill_switch: false,
          effective_grants: 0,
        },
      ],
    });
  });
});

describe("control-plane credential workflows", () => {
  it("creates a one-time service credential, exchanges a scoped grant, and revokes it", async () => {
    const created = await admin("/admin/v1/service-credentials", {
      product_id: "prod_control",
      environment_id: "env_control",
      tenant_id: "tenant_fixture",
      principal_id: "backend_fixture",
      capabilities: ["text.chat.v1", "json.strict.v1"],
      expires_at: null,
    });
    expect(created.status).toBe(201);
    const credential: unknown = await created.json();
    if (
      typeof credential !== "object" ||
      credential === null ||
      !("id" in credential) ||
      typeof credential.id !== "string" ||
      !("credential" in credential) ||
      typeof credential.credential !== "string"
    ) {
      throw new Error("invalid service credential response");
    }
    expect(credential.credential).toMatch(/^tksvc_/u);

    const exchange = await handleControlPlane(
      request(
        "/v1/token",
        { capabilities: ["text.chat.v1"], ttl_seconds: 300 },
        credential.credential,
      ),
      controlEnv,
    );
    expect(exchange.status).toBe(200);
    const grant: unknown = await exchange.json();
    expect(grant).toMatchObject({
      token_type: "Bearer",
      expires_in: 300,
      capabilities: ["text.chat.v1"],
    });
    if (
      typeof grant !== "object" ||
      grant === null ||
      !("grant_id" in grant) ||
      typeof grant.grant_id !== "string"
    ) {
      throw new Error("invalid grant response");
    }
    expect(grant.grant_id).toMatch(/^tgrant_/u);
    expect(
      (
        await admin("/admin/v1/revoke", {
          resource_type: "token_grant",
          resource_id: grant.grant_id,
        })
      ).status,
    ).toBe(200);

    const revoked = await admin("/admin/v1/revoke", {
      resource_type: "service_credential",
      resource_id: credential.id,
    });
    expect(revoked.status).toBe(200);
    expect(
      (
        await handleControlPlane(
          request("/v1/token", {}, credential.credential),
          controlEnv,
        )
      ).status,
    ).toBe(401);
  });

  it("atomically bounds concurrent access-code activations while allowing repeat exchange", async () => {
    const created = await admin("/admin/v1/access-codes", {
      product_id: "prod_control",
      environment_id: "env_control",
      tenant_id: "classroom_fixture",
      capabilities: ["vision.classify.v1"],
      expires_at: now() + 3600,
      max_activations: 1,
      max_failed_attempts: 3,
    });
    expect(created.status).toBe(201);
    const code: unknown = await created.json();
    if (
      typeof code !== "object" ||
      code === null ||
      !("id" in code) ||
      typeof code.id !== "string" ||
      !("access_code" in code) ||
      typeof code.access_code !== "string"
    ) {
      throw new Error("invalid access-code response");
    }
    const activationBodies = ["a", "b"].map((suffix) => ({
      access_code: code.access_code,
      device_id: `public-fixture-installation-${suffix}`,
      capabilities: ["vision.classify.v1"],
      ttl_seconds: 300,
    }));
    const responses = await Promise.all(
      activationBodies.map((body) =>
        handleControlPlane(request("/v1/activations", body), controlEnv),
      ),
    );
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 403]);
    const winner =
      activationBodies[responses.findIndex(({ status }) => status === 200)];
    if (!winner) throw new Error("concurrent activation had no winner");
    const repeatResponses = await Promise.all(
      [winner, winner].map((body) =>
        handleControlPlane(request("/v1/activations", body), controlEnv),
      ),
    );
    expect(repeatResponses.map(({ status }) => status)).toEqual([200, 200]);
    const stored = await env.DB.prepare(
      "SELECT activation_count FROM access_codes WHERE id = ?",
    )
      .bind(code.id)
      .first<{ activation_count: number }>();
    expect(stored?.activation_count).toBe(1);
    const entitlements = await env.DB.prepare(
      `SELECT id FROM entitlements
        WHERE source = 'access_code' AND source_ref = ?`,
    )
      .bind(code.id)
      .all<{ id: string }>();
    expect(entitlements.results).toHaveLength(1);
    const entitlementId = entitlements.results[0]?.id;
    if (!entitlementId)
      throw new Error("activation entitlement was not stored");
    expect(
      (
        await admin("/admin/v1/revoke", {
          resource_type: "entitlement",
          resource_id: entitlementId,
        })
      ).status,
    ).toBe(200);
    expect(
      (await handleControlPlane(request("/v1/activations", winner), controlEnv))
        .status,
    ).toBe(403);
  });

  it("keeps the test issuer admin-only and environment-gated", async () => {
    const response = await admin("/admin/v1/dev/issue", {
      product_id: "prod_control",
      environment_id: "env_control",
      tenant_id: "tenant_fixture",
      principal_id: "principal_fixture",
      capabilities: ["text.chat.v1"],
      ttl_seconds: 120,
    });
    expect(response.status).toBe(200);
    expect(
      (await handleControlPlane(request("/admin/v1/dev/issue", {}), controlEnv))
        .status,
    ).toBe(401);
  });
});

describe("product environment integrity", () => {
  async function addOtherProduct(): Promise<void> {
    const timestamp = now();
    await env.DB.prepare(
      `INSERT INTO products (id, slug, display_name, created_at, updated_at)
       VALUES ('prod_other', 'other-fixture', 'Other fixture', ?, ?)`,
    )
      .bind(timestamp, timestamp)
      .run();
  }

  it("rejects mismatched product and environment pairs at the database boundary", async () => {
    await addOtherProduct();
    const timestamp = now();
    const malformedWrites = [
      env.DB.prepare(
        `INSERT INTO aliases
           (id, product_id, environment_id, alias, endpoint, route_id, max_input_tokens,
            max_output_tokens, created_at, updated_at)
           VALUES ('alias_mismatch', 'prod_other', 'env_control', 'text.chat.v1', 'chat',
                   'fixture-text-v1', 1000, 100, ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO entitlements
           (id, product_id, environment_id, tenant_id, principal_id, source, capabilities_json,
            status, created_at, updated_at)
           VALUES ('ent_mismatch', 'prod_other', 'env_control', 'tenant_fixture',
                   'principal_fixture', 'dev', '["text.chat.v1"]', 'active', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO service_credentials
           (id, product_id, environment_id, tenant_id, principal_id, secret_salt, secret_hash,
            capabilities_json, created_at)
           VALUES ('service_mismatch', 'prod_other', 'env_control', 'tenant_fixture',
                   'principal_fixture', 'salt', 'hash', '["text.chat.v1"]', ?)`,
      ).bind(timestamp),
      env.DB.prepare(
        `INSERT INTO access_codes
           (id, product_id, environment_id, tenant_id, secret_salt, secret_hash,
            capabilities_json, expires_at, max_activations, created_at, updated_at)
           VALUES ('code_mismatch', 'prod_other', 'env_control', 'tenant_fixture', 'salt',
                   'hash', '["text.chat.v1"]', ?, 1, ?, ?)`,
      ).bind(timestamp + 3600, timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO token_grants
           (id, jti_hash, product_id, environment_id, tenant_id, principal_id, audience,
            capabilities_json, expires_at, created_at)
           VALUES ('grant_mismatch', 'jti_mismatch', 'prod_other', 'env_control',
                   'tenant_fixture', 'principal_fixture', 'control:test', '["text.chat.v1"]',
                   ?, ?)`,
      ).bind(timestamp + 300, timestamp),
    ];

    for (const write of malformedWrites) {
      await expect(write.run()).rejects.toThrow(/foreign key constraint/i);
    }
  });

  it("rejects grant and entitlement tuple disagreement at the database boundary", async () => {
    const timestamp = now();
    await env.DB.prepare(
      `INSERT INTO entitlements
       (id, product_id, environment_id, tenant_id, principal_id, source, capabilities_json,
        status, created_at, updated_at)
       VALUES ('ent_tuple', 'prod_control', 'env_control', 'tenant_fixture',
               'principal_fixture', 'dev', '["text.chat.v1"]', 'active', ?, ?)`,
    )
      .bind(timestamp, timestamp)
      .run();

    await expect(
      env.DB.prepare(
        `INSERT INTO token_grants
           (id, jti_hash, entitlement_id, product_id, environment_id, tenant_id, principal_id,
            audience, capabilities_json, expires_at, created_at)
           VALUES ('grant_bad_tuple', 'jti_bad_tuple', 'ent_tuple', 'prod_control',
                   'env_control', 'tenant_fixture', 'other_principal', 'control:test',
                   '["text.chat.v1"]', ?, ?)`,
      )
        .bind(timestamp + 300, timestamp)
        .run(),
    ).rejects.toThrow(/grant entitlement identity mismatch/i);

    await env.DB.prepare(
      `INSERT INTO token_grants
       (id, jti_hash, entitlement_id, product_id, environment_id, tenant_id, principal_id,
        audience, capabilities_json, expires_at, created_at)
       VALUES ('grant_tuple', 'jti_tuple', 'ent_tuple', 'prod_control', 'env_control',
               'tenant_fixture', 'principal_fixture', 'control:test', '["text.chat.v1"]', ?, ?)`,
    )
      .bind(timestamp + 300, timestamp)
      .run();
    await expect(
      env.DB.prepare(
        "UPDATE entitlements SET principal_id = 'other_principal' WHERE id = 'ent_tuple'",
      ).run(),
    ).rejects.toThrow(/grant entitlement identity mismatch/i);
  });

  it("returns a stable 4xx and leaves no partial admin writes for a mismatched pair", async () => {
    await addOtherProduct();
    const mismatchedRequests: Array<[string, Record<string, unknown>]> = [
      [
        "/admin/v1/aliases",
        {
          product_id: "prod_other",
          environment_id: "env_control",
          alias: "text.chat.v1",
          endpoint: "chat",
          route_id: "fixture-text-v1",
          max_input_tokens: 1000,
          max_output_tokens: 100,
        },
      ],
      [
        "/admin/v1/entitlements",
        {
          product_id: "prod_other",
          environment_id: "env_control",
          tenant_id: "tenant_fixture",
          principal_id: "principal_fixture",
          source: "dev",
          capabilities: ["text.chat.v1"],
          expires_at: null,
        },
      ],
      [
        "/admin/v1/service-credentials",
        {
          product_id: "prod_other",
          environment_id: "env_control",
          tenant_id: "tenant_fixture",
          principal_id: "principal_fixture",
          capabilities: ["text.chat.v1"],
          expires_at: null,
        },
      ],
      [
        "/admin/v1/access-codes",
        {
          product_id: "prod_other",
          environment_id: "env_control",
          tenant_id: "tenant_fixture",
          capabilities: ["text.chat.v1"],
          expires_at: now() + 3600,
          max_activations: 1,
          max_failed_attempts: 3,
        },
      ],
    ];

    for (const [path, body] of mismatchedRequests) {
      const response = await admin(path, body);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        error: {
          code: "not_found",
          message: "product environment not found",
        },
      });
    }

    for (const table of [
      "aliases",
      "entitlements",
      "service_credentials",
      "access_codes",
      "admin_audit",
    ]) {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM ${table}`,
      ).first<{ count: number }>();
      expect(row?.count).toBe(0);
    }
  });
});

describe("control-plane configuration", () => {
  it("fails closed on an unknown deployment environment", async () => {
    const response = await handleControlPlane(
      new Request("https://control.example.invalid/healthz"),
      { ...controlEnv, DEPLOYMENT_ENV: "prodution" },
    );
    expect(response.status).toBe(500);
  });
});
