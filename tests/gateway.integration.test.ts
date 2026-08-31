import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  randomId,
  sha256,
  signGrant,
  type GrantClaims,
} from "@tkslopper/shared";
import { costMicrocents } from "../apps/gateway/src";

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
      `INSERT OR IGNORE INTO products (id, slug, display_name, created_at, updated_at)
       VALUES ('prod_vibbit', 'vibbit', 'Vibbit fixture', ?, ?)`,
    ).bind(timestamp, timestamp),
    env.DB.prepare(
      `INSERT OR IGNORE INTO products (id, slug, display_name, created_at, updated_at)
       VALUES ('prod_tapplet', 'tapplet', 'Tapplet fixture', ?, ?)`,
    ).bind(timestamp, timestamp),
    env.DB.prepare(
      `INSERT OR IGNORE INTO environments
       (id, product_id, name, audience, rpm_limit, tpm_limit, concurrency_limit,
        daily_budget_microcents, max_request_bytes, created_at, updated_at)
       VALUES ('env_vibbit', 'prod_vibbit', 'test', 'vibbit:test', 20, 1000000, 2, 1000000, 8388608, ?, ?)`,
    ).bind(timestamp, timestamp),
    env.DB.prepare(
      `INSERT OR IGNORE INTO environments
       (id, product_id, name, audience, rpm_limit, tpm_limit, concurrency_limit,
        daily_budget_microcents, max_request_bytes, created_at, updated_at)
       VALUES ('env_tapplet', 'prod_tapplet', 'test', 'tapplet:test', 20, 1000000, 2, 1000000, 8388608, ?, ?)`,
    ).bind(timestamp, timestamp),
    env.DB.prepare(
      `INSERT OR IGNORE INTO aliases
       (id, product_id, environment_id, alias, endpoint, route_id, max_input_tokens, max_output_tokens,
        input_cost_microcents_per_million, output_cost_microcents_per_million, created_at, updated_at)
       VALUES ('alias_chat', 'prod_vibbit', 'env_vibbit', 'text.chat.v1', 'chat', 'fixture-text-v1',
               500000, 4096, 1000, 2000, ?, ?)`,
    ).bind(timestamp, timestamp),
    env.DB.prepare(
      `INSERT OR IGNORE INTO aliases
       (id, product_id, environment_id, alias, endpoint, route_id, allow_images, allow_structured_json,
        max_input_tokens, max_output_tokens, created_at, updated_at)
       VALUES ('alias_vision', 'prod_tapplet', 'env_tapplet', 'vision.classify.v1', 'responses',
               'fixture-vision-v1', 1, 1, 100000, 1024, ?, ?)`,
    ).bind(timestamp, timestamp),
  ]);
});

async function grant(options?: {
  productId?: string;
  environmentId?: string;
  audience?: string;
  capability?: string;
}): Promise<string> {
  const productId = options?.productId ?? "prod_vibbit";
  const environmentId = options?.environmentId ?? "env_vibbit";
  const audience = options?.audience ?? "vibbit:test";
  const capability = options?.capability ?? "text.chat.v1";
  const timestamp = now();
  const entitlementId = randomId("ent");
  const jti = randomId("grant");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO entitlements
       (id, product_id, environment_id, tenant_id, principal_id, source, capabilities_json,
        status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 'tenant_fixture', 'principal_fixture', 'dev', ?, 'active', ?, ?, ?)`,
    ).bind(
      entitlementId,
      productId,
      environmentId,
      JSON.stringify([capability]),
      timestamp + 600,
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO token_grants
       (id, jti_hash, entitlement_id, product_id, environment_id, tenant_id, principal_id, audience,
        capabilities_json, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, 'tenant_fixture', 'principal_fixture', ?, ?, ?, ?)`,
    ).bind(
      randomId("tgrant"),
      await sha256(jti),
      entitlementId,
      productId,
      environmentId,
      audience,
      JSON.stringify([capability]),
      timestamp + 600,
      timestamp,
    ),
  ]);
  const claims: GrantClaims = {
    iss: env.TOKEN_ISSUER,
    aud: audience,
    sub: "principal_fixture",
    iat: timestamp,
    exp: timestamp + 600,
    jti,
    tks: {
      productId,
      environmentId,
      tenantId: "tenant_fixture",
      principalId: "principal_fixture",
      capabilities: [capability],
      tokenType: "dev",
    },
  };
  return signGrant(claims, env.TOKEN_SIGNING_SECRET);
}

function chatRequest(
  token: string,
  overrides?: Record<string, string>,
  body: Record<string, unknown> = {
    model: "text.chat.v1",
    messages: [{ role: "user", content: "SYNTHETIC_PRIVATE_PROMPT_SENTINEL" }],
    max_completion_tokens: 100,
    stream: false,
  },
): Request {
  return new Request("https://gateway.example.invalid/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...overrides,
    },
    body: JSON.stringify(body),
  });
}

describe("gateway integration and isolation", () => {
  it("serves a full non-streaming fixture result and records one physical attempt", async () => {
    const token = await grant();
    const response = await SELF.fetch(
      chatRequest(token, { "idempotency-key": "fixture-request-0001" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-tkslopper-request-id")).toMatch(/^req_/u);
    await expect(response.json()).resolves.toMatchObject({
      model: "text.chat.v1",
      object: "chat.completion",
    });
    const attempt = await env.DB.prepare(
      "SELECT status_code, error_class, input_tokens, output_tokens FROM provider_attempts",
    ).first<{
      status_code: number;
      error_class: string | null;
      input_tokens: number;
      output_tokens: number;
    }>();
    expect(attempt).toMatchObject({
      status_code: 200,
      error_class: null,
      input_tokens: 8,
      output_tokens: 3,
    });
    expect(JSON.stringify(attempt)).not.toContain(
      "SYNTHETIC_PRIVATE_PROMPT_SENTINEL",
    );
    expect(JSON.stringify(attempt)).not.toContain("fixture response");
  });

  it("rejects attribution overrides and cross-product aliases", async () => {
    const token = await grant();
    expect(
      (
        await SELF.fetch(
          chatRequest(token, { "x-tkslopper-product": "prod_tapplet" }),
        )
      ).status,
    ).toBe(400);
    const tappletToken = await grant({
      productId: "prod_tapplet",
      environmentId: "env_tapplet",
      audience: "tapplet:test",
      capability: "text.chat.v1",
    });
    expect((await SELF.fetch(chatRequest(tappletToken))).status).toBe(403);
  });

  it("requires explicit alias and route support for structured JSON", async () => {
    const textToken = await grant();
    expect(
      (
        await SELF.fetch(
          chatRequest(textToken, undefined, {
            model: "text.chat.v1",
            messages: [{ role: "user", content: "synthetic" }],
            response_format: { type: "json_object" },
          }),
        )
      ).status,
    ).toBe(400);

    const visionToken = await grant({
      productId: "prod_tapplet",
      environmentId: "env_tapplet",
      audience: "tapplet:test",
      capability: "vision.classify.v1",
    });
    const response = await SELF.fetch(
      new Request("https://gateway.example.invalid/v1/responses", {
        method: "POST",
        headers: {
          authorization: `Bearer ${visionToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          model: "vision.classify.v1",
          input: "Return a synthetic label.",
          text: {
            format: {
              type: "json_schema",
              name: "label_result",
              strict: true,
              schema: { type: "object" },
            },
          },
          max_output_tokens: 100,
        }),
      }),
    );
    expect(response.status).toBe(200);
  });

  it("fails closed on a claim/database identity mismatch and live kill switch", async () => {
    const token = await grant();
    const segments = token.split(".");
    expect(segments).toHaveLength(3);
    const malformed = `${segments[0]}.${segments[1]}.invalid`;
    expect((await SELF.fetch(chatRequest(malformed))).status).toBe(401);
    await env.DB.prepare(
      "UPDATE token_grants SET principal_id = 'other_fixture_principal'",
    ).run();
    expect((await SELF.fetch(chatRequest(token))).status).toBe(401);
    await env.DB.prepare(
      "UPDATE token_grants SET principal_id = 'principal_fixture'",
    ).run();
    await env.DB.prepare("UPDATE entitlements SET status = 'revoked'").run();
    expect((await SELF.fetch(chatRequest(token))).status).toBe(403);
    await env.DB.prepare("UPDATE entitlements SET status = 'active'").run();
    await env.DB.prepare(
      "UPDATE environments SET kill_switch = 1 WHERE id = 'env_vibbit'",
    ).run();
    expect((await SELF.fetch(chatRequest(token))).status).toBe(403);
  });

  it("prevents idempotency replay without storing the response payload", async () => {
    const token = await grant();
    const headers = { "idempotency-key": "fixture-request-0002" };
    expect((await SELF.fetch(chatRequest(token, headers))).status).toBe(200);
    expect((await SELF.fetch(chatRequest(token, headers))).status).toBe(409);
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM provider_attempts WHERE product_id = ?",
    )
      .bind("prod_vibbit")
      .first<{ count: number }>();
    expect(row?.count).toBe(1);
    const stored = await env.DB.prepare(
      "SELECT * FROM idempotency_keys LIMIT 1",
    ).first<Record<string, unknown>>();
    expect(JSON.stringify(stored)).not.toContain(
      "SYNTHETIC_PRIVATE_PROMPT_SENTINEL",
    );
    expect(JSON.stringify(stored)).not.toContain("fixture response");
  });

  it("does not leak request payloads through logs", async () => {
    const logger = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const token = await grant();
    expect((await SELF.fetch(chatRequest(token))).status).toBe(200);
    expect(JSON.stringify(logger.mock.calls)).not.toContain(
      "SYNTHETIC_PRIVATE_PROMPT_SENTINEL",
    );
    expect(JSON.stringify(logger.mock.calls)).not.toContain("fixture response");
    logger.mockRestore();
  });
});

describe("exact quota reservations", () => {
  it("calculates maximum configured rates without floating-point loss", () => {
    expect(costMicrocents(10_000_000, 1_000_000_000_000)).toBe(
      10_000_000_000_000,
    );
    expect(costMicrocents(1, 1)).toBe(1);
  });

  it("serializes concurrency and releases it on completion", async () => {
    const stub = env.QUOTA.get(
      env.QUOTA.idFromName("quota-concurrency-fixture"),
    );
    const acquire = (requestId: string) =>
      stub.fetch("https://quota.internal/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "acquire",
          requestId,
          reservationTtlSeconds: 60,
          estimatedTokens: 100,
          reservedCostMicrocents: 10,
          limits: {
            rpm: 10,
            tpm: 1000,
            concurrency: 1,
            dailyBudgetMicrocents: 100,
          },
        }),
      });
    const requestIds = ["request-a", "request-b"];
    const acquisitions = await Promise.all(requestIds.map(acquire));
    expect(acquisitions.map(({ status }) => status).sort()).toEqual([200, 429]);
    const acquiredRequestId =
      requestIds[acquisitions.findIndex(({ status }) => status === 200)];
    if (!acquiredRequestId)
      throw new Error("concurrency reservation had no winner");
    expect(
      (
        await stub.fetch("https://quota.internal/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operation: "complete",
            requestId: acquiredRequestId,
            actualTokens: 80,
            actualCostMicrocents: 8,
          }),
        })
      ).status,
    ).toBe(200);
    expect((await acquire("request-c")).status).toBe(200);
  });

  it("rejects budget over-reservation atomically", async () => {
    const stub = env.QUOTA.get(env.QUOTA.idFromName("quota-budget-fixture"));
    const reserve = (requestId: string) =>
      stub.fetch("https://quota.internal/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "acquire",
          requestId,
          reservationTtlSeconds: 60,
          estimatedTokens: 100,
          reservedCostMicrocents: 60,
          limits: {
            rpm: 10,
            tpm: 1000,
            concurrency: 2,
            dailyBudgetMicrocents: 100,
          },
        }),
      });
    const responses = await Promise.all([
      reserve("request-budget-a"),
      reserve("request-budget-b"),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([200, 402]);
    const denied = responses.find(({ status }) => status === 402);
    if (!denied) throw new Error("budget reservation was not denied");
    await expect(denied.json()).resolves.toMatchObject({
      acquired: false,
      reason: "budget",
    });
  });

  it("does not subtract an expired prior-day reservation from the new day", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T23:59:50.000Z"));
      const stub = env.QUOTA.get(
        env.QUOTA.idFromName("quota-midnight-fixture"),
      );
      const reserve = (requestId: string, reservedCostMicrocents: number) =>
        stub.fetch("https://quota.internal/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operation: "acquire",
            requestId,
            reservationTtlSeconds: 20,
            estimatedTokens: 1,
            reservedCostMicrocents,
            limits: {
              rpm: 10,
              tpm: 1000,
              concurrency: 10,
              dailyBudgetMicrocents: 100,
            },
          }),
        });

      expect((await reserve("prior-day", 60)).status).toBe(200);
      vi.setSystemTime(new Date("2026-01-02T00:00:01.000Z"));
      expect((await reserve("new-day", 60)).status).toBe(200);
      vi.setSystemTime(new Date("2026-01-02T00:00:11.000Z"));
      expect((await reserve("new-day-over-budget", 50)).status).toBe(402);
    } finally {
      vi.useRealTimers();
    }
  });

  it("enforces RPM and estimated TPM ceilings", async () => {
    const acquire = (
      scope: string,
      requestId: string,
      limits: { rpm: number; tpm: number },
      estimatedTokens: number,
    ) => {
      const stub = env.QUOTA.get(env.QUOTA.idFromName(scope));
      return stub.fetch("https://quota.internal/", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          operation: "acquire",
          requestId,
          reservationTtlSeconds: 60,
          estimatedTokens,
          reservedCostMicrocents: 0,
          limits: {
            ...limits,
            concurrency: 10,
            dailyBudgetMicrocents: 100,
          },
        }),
      });
    };
    expect(
      (await acquire("quota-rpm-fixture", "rpm-a", { rpm: 1, tpm: 1000 }, 10))
        .status,
    ).toBe(200);
    expect(
      (await acquire("quota-rpm-fixture", "rpm-b", { rpm: 1, tpm: 1000 }, 10))
        .status,
    ).toBe(429);
    expect(
      (await acquire("quota-tpm-fixture", "tpm-a", { rpm: 10, tpm: 100 }, 60))
        .status,
    ).toBe(200);
    expect(
      (await acquire("quota-tpm-fixture", "tpm-b", { rpm: 10, tpm: 100 }, 50))
        .status,
    ).toBe(429);
  });
});
