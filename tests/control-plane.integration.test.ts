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

async function admin(path: string, body: unknown): Promise<Response> {
  return handleControlPlane(
    request(path, body, String(env.ADMIN_TOKEN)),
    controlEnv,
  );
}

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
