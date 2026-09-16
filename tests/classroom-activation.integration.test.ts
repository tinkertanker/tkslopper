import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  createOpaqueCredential,
  hashCredential,
  randomSecret,
  verifyGrant,
} from "@tkslopper/shared";
import {
  handleControlPlane,
  type ControlPlaneEnv,
} from "../apps/control-plane/src";

const controlEnv = env as unknown as ControlPlaneEnv;
let classId: string;
let groupId: string;
let code: ReturnType<typeof createOpaqueCredential>;
let timestamp: number;

beforeEach(async () => {
  timestamp = Math.floor(Date.now() / 1000);
  const suffix = crypto.randomUUID();
  classId = `class_${suffix}`;
  groupId = `group_${suffix}`;
  const productId = `product_${suffix}`;
  const environmentId = `environment_${suffix}`;
  code = createOpaqueCredential("access_code");
  const salt = randomSecret(16);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO products (id,slug,display_name,created_at,updated_at) VALUES (?,?,?,?,?)",
    ).bind(productId, productId, "Activation fixture", timestamp, timestamp),
    env.DB.prepare(
      "INSERT INTO environments (id,product_id,name,audience,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ).bind(
      environmentId,
      productId,
      "test",
      environmentId,
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO classroom_classes
       (id,product_id,environment_id,tenant_id,name,starts_at,expires_at,capabilities_json,
        budget_microcents,group_budget_microcents,rpm_limit,tpm_limit,concurrency_limit,created_at,updated_at)
       VALUES (?,?,?,'activation-tenant','Course',?,?,'["text.chat.v1","text.response.v1"]',1000,500,30,10000,2,?,?)`,
    ).bind(
      classId,
      productId,
      environmentId,
      timestamp - 60,
      timestamp + 1200,
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO classroom_groups
       (id,class_id,name,budget_microcents,capabilities_json,expires_at,created_at,updated_at)
       VALUES (?,?,'Group',500,'["text.chat.v1"]',?,?,?)`,
    ).bind(groupId, classId, timestamp + 400, timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO access_codes
       (id,product_id,environment_id,tenant_id,secret_salt,secret_hash,capabilities_json,
        expires_at,max_activations,max_failed_attempts,created_at,updated_at,classroom_group_id)
       VALUES (?,?,?,'activation-tenant',?,?,'["text.chat.v1","text.response.v1"]',?,10,10,?,?,?)`,
    ).bind(
      code.id,
      productId,
      environmentId,
      salt,
      await hashCredential(code.secret, salt, controlEnv.CREDENTIAL_PEPPER),
      timestamp + 900,
      timestamp,
      timestamp,
      groupId,
    ),
  ]);
});

function activate(
  capabilities?: string[],
  device = "classroom-test-device",
): Promise<Response> {
  return handleControlPlane(
    new Request("https://control.example.invalid/v1/activations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        access_code: code.value,
        device_id: device,
        capabilities,
      }),
    }),
    controlEnv,
  );
}

describe("classroom activation policy", () => {
  it("intersects live models and bounds the grant to the earlier group expiry", async () => {
    const response = await activate();
    expect(response.status).toBe(200);
    const body = await response.json<{
      access_token: string;
      capabilities: string[];
    }>();
    expect(body.capabilities).toEqual(["text.chat.v1"]);
    const claims = await verifyGrant(
      body.access_token,
      controlEnv.TOKEN_SIGNING_SECRET,
      controlEnv.TOKEN_ISSUER,
    );
    expect(claims?.exp).toBe(timestamp + 400);
    const entitlement = await env.DB.prepare(
      "SELECT expires_at FROM entitlements WHERE source_ref = ?",
    )
      .bind(code.id)
      .first<{ expires_at: number }>();
    // The durable entitlement may retain the code lifetime; live policy bounds every grant.
    expect(entitlement?.expires_at).toBe(timestamp + 900);
  });

  it("rejects a requested model excluded by the group before consuming an activation", async () => {
    expect((await activate(["text.response.v1"])).status).toBe(403);
    expect(
      await env.DB.prepare(
        "SELECT activation_count FROM access_codes WHERE id = ?",
      )
        .bind(code.id)
        .first("activation_count"),
    ).toBe(0);
  });

  it.each(["paused", "revoked"])(
    "rejects %s classes for new and existing devices",
    async (status) => {
      expect((await activate()).status).toBe(200);
      await env.DB.prepare(
        "UPDATE classroom_classes SET status = ? WHERE id = ?",
      )
        .bind(status, classId)
        .run();
      expect((await activate()).status).toBe(403);
      expect(
        (await activate(undefined, "second-classroom-device")).status,
      ).toBe(403);
      expect(
        await env.DB.prepare(
          "SELECT activation_count FROM access_codes WHERE id = ?",
        )
          .bind(code.id)
          .first("activation_count"),
      ).toBe(1);
    },
  );

  it("rejects future start and exact expiry boundaries without issuing grants", async () => {
    await env.DB.prepare(
      "UPDATE classroom_groups SET starts_at = ? WHERE id = ?",
    )
      .bind(timestamp + 100, groupId)
      .run();
    expect((await activate()).status).toBe(403);
    await env.DB.prepare(
      "UPDATE classroom_groups SET starts_at = NULL, expires_at = ? WHERE id = ?",
    )
      .bind(timestamp, groupId)
      .run();
    expect((await activate()).status).toBe(403);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) FROM entitlements WHERE source_ref = ?",
      )
        .bind(code.id)
        .first("COUNT(*)"),
    ).toBe(0);
  });

  it("rejects a code whose tenant differs from its linked classroom", async () => {
    await env.DB.prepare(
      "UPDATE access_codes SET tenant_id = 'wrong-tenant' WHERE id = ?",
    )
      .bind(code.id)
      .run();
    expect((await activate()).status).toBe(403);
    expect(
      await env.DB.prepare(
        "SELECT activation_count FROM access_codes WHERE id = ?",
      )
        .bind(code.id)
        .first("activation_count"),
    ).toBe(0);
  });
});
