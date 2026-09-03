import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  randomId,
  sha256,
  signGrant,
  type GrantClaims,
} from "@tkslopper/shared";
import {
  costMicrocents,
  handleGateway,
  identityScope,
  type GatewayEnv,
} from "../apps/gateway/src";

const now = (): number => Math.floor(Date.now() / 1000);

beforeEach(async () => {
  const timestamp = now();
  const quota = env.QUOTA.get(
    env.QUOTA.idFromName(
      identityScope(
        "prod_vibbit",
        "env_vibbit",
        "tenant_fixture",
        "principal_fixture",
      ),
    ),
  );
  await runInDurableObject(quota, async (_instance, durableState) => {
    await durableState.storage.deleteAll();
  });
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
  signal?: AbortSignal,
): Request {
  return new Request("https://gateway.example.invalid/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...overrides,
    },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

function upstreamEnv(timeoutMs: number): GatewayEnv {
  return {
    ...(env as unknown as GatewayEnv),
    PROVIDER_ROUTES_JSON: JSON.stringify({
      "fixture-text-v1": {
        id: "fixture-text-v1",
        adapter: "openai-compatible",
        provider: "custom",
        profile: "custom",
        model: "physical-fixture-v1",
        baseUrl: "https://provider.example.invalid",
        credentialBinding: "UPSTREAM_KEY",
        endpoints: ["chat"],
        supportsImages: false,
        supportsReasoning: false,
        supportsStructuredJson: false,
        timeoutMs,
      },
    }),
    UPSTREAM_KEY: "public-fixture-upstream-value",
  };
}

async function quotaState(): Promise<{
  spentTodayMicrocents: number;
  reservedTodayMicrocents: number;
  reservations: Record<string, unknown>;
}> {
  const stub = env.QUOTA.get(
    env.QUOTA.idFromName(
      identityScope(
        "prod_vibbit",
        "env_vibbit",
        "tenant_fixture",
        "principal_fixture",
      ),
    ),
  );
  const state = await runInDurableObject(
    stub,
    async (_instance, durableState) =>
      durableState.storage.get<{
        spentTodayMicrocents: number;
        reservedTodayMicrocents: number;
        reservations: Record<string, unknown>;
      }>("quota"),
  );
  if (!state) throw new Error("quota state was not persisted");
  return state;
}

function abortableProviderFetch(onStart?: () => void) {
  return vi.fn<typeof fetch>().mockImplementation((_input, init) => {
    onStart?.();
    const signal = init?.signal;
    return new Promise<Response>((_resolve, reject) => {
      const abort = (): void =>
        reject(new Error("synthetic provider fetch aborted"));
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  });
}

function providerChatResponse(usage?: Record<string, unknown>): Response {
  return Response.json({
    id: "chatcmpl_accounting_fixture",
    object: "chat.completion",
    model: "physical-fixture-v1",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "fixture response" },
        finish_reason: "stop",
      },
    ],
    ...(usage === undefined ? {} : { usage }),
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
      "UPDATE token_grants SET audience = 'other:test'",
    ).run();
    expect((await SELF.fetch(chatRequest(token))).status).toBe(401);
    await env.DB.prepare(
      "UPDATE token_grants SET audience = 'vibbit:test'",
    ).run();
    await env.DB.prepare("UPDATE entitlements SET status = 'revoked'").run();
    expect((await SELF.fetch(chatRequest(token))).status).toBe(403);
    await env.DB.prepare("UPDATE entitlements SET status = 'active'").run();
    await env.DB.prepare(
      "UPDATE environments SET kill_switch = 1 WHERE id = 'env_vibbit'",
    ).run();
    expect((await SELF.fetch(chatRequest(token))).status).toBe(403);
  });

  it("fails closed at authentication when the linked entitlement tuple disagrees", async () => {
    const timestamp = now();
    const jti = randomId("grant");
    const claims: GrantClaims = {
      iss: env.TOKEN_ISSUER,
      aud: "vibbit:test",
      sub: "principal_fixture",
      iat: timestamp,
      exp: timestamp + 600,
      jti,
      tks: {
        productId: "prod_vibbit",
        environmentId: "env_vibbit",
        tenantId: "tenant_fixture",
        principalId: "principal_fixture",
        capabilities: ["text.chat.v1"],
        tokenType: "dev",
      },
    };
    const token = await signGrant(claims, env.TOKEN_SIGNING_SECRET);
    let prepareCalls = 0;
    const authStatement = {
      bind() {
        return this;
      },
      first() {
        return {
          grant_id: "tgrant_fixture",
          product_id: "prod_vibbit",
          environment_id: "env_vibbit",
          tenant_id: "tenant_fixture",
          principal_id: "principal_fixture",
          audience: "vibbit:test",
          capabilities_json: '["text.chat.v1"]',
          grant_expires_at: timestamp + 600,
          revoked_at: null,
          entitlement_status: "active",
          entitlement_source: "dev",
          entitlement_expires_at: timestamp + 600,
          entitlement_product_id: "prod_tapplet",
          entitlement_environment_id: "env_tapplet",
          entitlement_tenant_id: "tenant_fixture",
          entitlement_principal_id: "principal_fixture",
          access_code_disabled: null,
          access_code_expires_at: null,
          activation_id: null,
          activation_revoked_at: null,
          product_enabled: 1,
          product_kill_switch: 0,
          environment_enabled: 1,
          environment_kill_switch: 0,
          environment_policy_version: 1,
          rpm_limit: 20,
          tpm_limit: 1_000_000,
          concurrency_limit: 2,
          daily_budget_microcents: 1_000_000,
          max_request_bytes: 8_388_608,
        };
      },
    };
    const malformedDb = {
      prepare(query: string) {
        prepareCalls += 1;
        if (!query.includes("FROM token_grants")) {
          throw new Error(
            "gateway continued after malformed entitlement identity",
          );
        }
        return authStatement;
      },
    } as unknown as D1Database;
    const response = await handleGateway(chatRequest(token), {
      ...(env as unknown as GatewayEnv),
      DB: malformedDb,
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "authorization_failed" },
    });
    expect(prepareCalls).toBe(2);
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

describe("Stage 0 failure-path accounting", () => {
  it("uses an unambiguous identity tuple for quota and idempotency scopes", () => {
    expect(
      identityScope("product", "environment", "tenant:a", "principal"),
    ).not.toBe(
      identityScope("product", "environment", "tenant", "a:principal"),
    );
  });

  it("rejects a pre-aborted request before quota or attempt admission", async () => {
    const token = await grant();
    const controller = new AbortController();
    controller.abort("synthetic_client_disconnect");
    const response = await handleGateway(
      chatRequest(
        token,
        { "idempotency-key": ["pre", "aborted", "fixture", "0001"].join("-") },
        undefined,
        controller.signal,
      ),
      env,
    );
    expect(response.status).toBe(499);
    const persisted = await env.DB.prepare(
      `SELECT
         (SELECT COUNT(*) FROM provider_attempts) AS attempts,
         (SELECT COUNT(*) FROM idempotency_keys) AS idempotency`,
    ).first<{ attempts: number; idempotency: number }>();
    expect(persisted).toEqual({ attempts: 0, idempotency: 0 });
  });

  it("accounts zero and stores no attempt when intent persistence fails before dispatch", async () => {
    await env.DB.prepare(
      `CREATE TRIGGER fail_attempt_start
       BEFORE INSERT ON provider_attempts
       BEGIN SELECT RAISE(ABORT, 'synthetic attempt start failure'); END`,
    ).run();
    try {
      const token = await grant();
      const response = await SELF.fetch(
        chatRequest(token, { "idempotency-key": "start-failure-fixture-0001" }),
      );
      expect(response.status).toBe(500);
      expect(
        (
          await env.DB.prepare(
            "SELECT COUNT(*) AS count FROM provider_attempts",
          ).first<{ count: number }>()
        )?.count,
      ).toBe(0);
      const quota = await quotaState();
      expect(quota.reservations).toEqual({});
      expect(quota.reservedTodayMicrocents).toBe(0);
      expect(quota.spentTodayMicrocents).toBe(0);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_attempt_start").run();
    }
  });

  it.each([
    {
      name: "complete zero usage",
      usage: { prompt_tokens: 0, completion_tokens: 0 },
      expectedInput: 0,
      expectedOutput: 0,
      exposesUsage: true,
    },
    {
      name: "partial usage",
      usage: { prompt_tokens: 5 },
      expectedInput: 5,
      expectedOutput: 100,
      exposesUsage: false,
    },
    {
      name: "missing usage",
      usage: undefined,
      expectedInput: undefined,
      expectedOutput: 100,
      exposesUsage: false,
    },
  ])(
    "accounts $name without misrepresenting public usage",
    async ({ usage, expectedInput, expectedOutput, exposesUsage }) => {
      const token = await grant();
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>().mockResolvedValue(providerChatResponse(usage)),
      );
      try {
        const response = await handleGateway(
          chatRequest(token),
          upstreamEnv(5000),
        );
        expect(response.status).toBe(200);
        const body = await response.json<Record<string, unknown>>();
        if (exposesUsage) {
          expect(body.usage).toEqual({
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
          });
        } else {
          expect(body).not.toHaveProperty("usage");
        }
        const attempt = await env.DB.prepare(
          `SELECT input_tokens, output_tokens, cost_microcents
             FROM provider_attempts`,
        ).first<{
          input_tokens: number;
          output_tokens: number;
          cost_microcents: number;
        }>();
        expect(attempt?.output_tokens).toBe(expectedOutput);
        if (expectedInput === undefined)
          expect(attempt?.input_tokens).toBeGreaterThan(0);
        else expect(attempt?.input_tokens).toBe(expectedInput);
        const quota = await quotaState();
        expect(quota.reservations).toEqual({});
        expect(quota.spentTodayMicrocents).toBe(attempt?.cost_microcents);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("aborts one provider call at its deadline and finalizes conservative accounting", async () => {
    const token = await grant();
    const providerFetch = abortableProviderFetch();
    vi.stubGlobal("fetch", providerFetch);
    try {
      const response = await handleGateway(
        chatRequest(token, { "idempotency-key": "deadline-fixture-0001" }),
        upstreamEnv(1000),
      );
      expect(response.status).toBe(504);
      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(providerFetch.mock.calls[0]?.[1]?.signal?.reason).toBe("deadline");

      const attempt = await env.DB.prepare(
        `SELECT status_code, error_class, cost_microcents, created_at, stale_after
           FROM provider_attempts`,
      ).first<{
        status_code: number;
        error_class: string;
        cost_microcents: number;
        created_at: number;
        stale_after: number;
      }>();
      expect(attempt).toMatchObject({
        status_code: 504,
        error_class: "provider_timeout",
      });
      expect(attempt!.stale_after - attempt!.created_at).toBe(31);
      const quota = await quotaState();
      expect(quota.reservations).toEqual({});
      expect(quota.reservedTodayMicrocents).toBe(0);
      expect(quota.spentTodayMicrocents).toBe(attempt!.cost_microcents);
      const idempotency = await env.DB.prepare(
        "SELECT status, created_at, expires_at FROM idempotency_keys",
      ).first<{ status: string; created_at: number; expires_at: number }>();
      expect(idempotency?.status).toBe("failed");
      expect(idempotency!.expires_at - idempotency!.created_at).toBe(86_400);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("distinguishes client cancellation, aborts the provider, and accounts conservatively", async () => {
    const token = await grant();
    const requestController = new AbortController();
    let providerStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      providerStarted = resolve;
    });
    const providerFetch = abortableProviderFetch(providerStarted);
    vi.stubGlobal("fetch", providerFetch);
    try {
      const responsePromise = handleGateway(
        chatRequest(
          token,
          { "idempotency-key": "cancel-fixture-0001" },
          undefined,
          requestController.signal,
        ),
        upstreamEnv(5000),
      );
      await started;
      requestController.abort("synthetic_client_disconnect");
      const response = await responsePromise;
      expect(response.status).toBe(499);
      expect(providerFetch).toHaveBeenCalledTimes(1);
      expect(providerFetch.mock.calls[0]?.[1]?.signal?.reason).toBe(
        "client_disconnected",
      );
      const attempt = await env.DB.prepare(
        "SELECT status_code, error_class, cost_microcents FROM provider_attempts",
      ).first<{
        status_code: number;
        error_class: string;
        cost_microcents: number;
      }>();
      expect(attempt).toMatchObject({
        status_code: 499,
        error_class: "provider_cancelled",
      });
      const quota = await quotaState();
      expect(quota.reservations).toEqual({});
      expect(quota.spentTodayMicrocents).toBe(attempt!.cost_microcents);
      expect(
        (
          await env.DB.prepare("SELECT status FROM idempotency_keys").first<{
            status: string;
          }>()
        )?.status,
      ).toBe("failed");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("leaves bounded stale provenance when attempt finalization fails", async () => {
    await env.DB.prepare(
      `CREATE TRIGGER fail_attempt_finalization
       BEFORE UPDATE ON provider_attempts
       BEGIN SELECT RAISE(ABORT, 'synthetic attempt finalization failure'); END`,
    ).run();
    try {
      const token = await grant();
      const response = await SELF.fetch(
        chatRequest(token, { "idempotency-key": "finalize-fixture-0001" }),
      );
      expect(response.status).toBe(500);
      const attempt = await env.DB.prepare(
        `SELECT status_code, error_class, cost_microcents, created_at, stale_after
           FROM provider_attempts`,
      ).first<{
        status_code: number;
        error_class: string;
        cost_microcents: number;
        created_at: number;
        stale_after: number;
      }>();
      expect(attempt).toMatchObject({
        status_code: 0,
        error_class: "attempt_started",
      });
      expect(attempt!.stale_after - attempt!.created_at).toBe(40);
      const quota = await quotaState();
      expect(quota.reservations).toEqual({});
      expect(quota.spentTodayMicrocents).toBe(attempt!.cost_microcents);
      expect(
        (
          await env.DB.prepare("SELECT status FROM idempotency_keys").first<{
            status: string;
          }>()
        )?.status,
      ).toBe("failed");
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_attempt_finalization").run();
    }
  });

  it("retries quota completion once and leaves a bounded stale signal if it still fails", async () => {
    const operations: Array<Record<string, unknown>> = [];
    const quotaStub = {
      fetch(_url: string, init?: RequestInit): Promise<Response> {
        if (typeof init?.body !== "string")
          throw new Error("synthetic quota request body was not a string");
        const parsed: unknown = JSON.parse(init.body);
        if (typeof parsed !== "object" || parsed === null)
          throw new Error("synthetic quota request body was not an object");
        const operation = parsed as Record<string, unknown>;
        operations.push(operation);
        return Promise.resolve(
          operation.operation === "acquire"
            ? Response.json({ acquired: true })
            : Response.json({ completed: false }, { status: 503 }),
        );
      },
    };
    const quotaNamespace = {
      idFromName: () => ({ synthetic: true }),
      get: () => quotaStub,
    } as unknown as DurableObjectNamespace;
    const token = await grant();
    const response = await handleGateway(
      chatRequest(token, { "idempotency-key": "quota-failure-fixture-0001" }),
      { ...(env as unknown as GatewayEnv), QUOTA: quotaNamespace },
    );
    expect(response.status).toBe(503);
    expect(operations.map(({ operation }) => operation)).toEqual([
      "acquire",
      "complete",
      "complete",
    ]);
    expect(operations[0]?.reservationTtlSeconds).toBe(40);
    const attempt = await env.DB.prepare(
      `SELECT status_code, error_class, created_at, stale_after
         FROM provider_attempts`,
    ).first<{
      status_code: number;
      error_class: string;
      created_at: number;
      stale_after: number;
    }>();
    expect(attempt).toMatchObject({
      status_code: 0,
      error_class: "attempt_started",
    });
    expect(attempt!.stale_after - attempt!.created_at).toBe(40);
    expect(
      (
        await env.DB.prepare("SELECT status FROM idempotency_keys").first<{
          status: string;
        }>()
      )?.status,
    ).toBe("failed");

    await env.DB.prepare(
      "UPDATE provider_attempts SET stale_after = unixepoch()",
    ).run();
    const stale = await env.DB.prepare(
      "SELECT * FROM stale_provider_attempts",
    ).first<Record<string, unknown>>();
    expect(stale?.request_id).toMatch(/^req_/u);
    expect(stale).toMatchObject({
      product_id: "prod_vibbit",
      environment_id: "env_vibbit",
      route_id: "fixture-text-v1",
      provider: "fixture",
      resolved_model: "fixture-chat-v1",
      endpoint: "chat",
      output_tokens: 100,
    });
    expect(typeof stale?.input_tokens).toBe("number");
    expect(typeof stale?.cost_microcents).toBe("number");
    expect(typeof stale?.created_at).toBe("number");
    expect(typeof stale?.stale_after).toBe("number");
    expect(Object.keys(stale ?? {}).sort()).toEqual(
      [
        "request_id",
        "product_id",
        "environment_id",
        "route_id",
        "provider",
        "resolved_model",
        "endpoint",
        "input_tokens",
        "output_tokens",
        "cost_microcents",
        "created_at",
        "stale_after",
      ].sort(),
    );
  });
});

describe("gateway configuration", () => {
  const gatewayEnv = env as unknown as GatewayEnv;

  it("fails closed on unknown environments and invalid global body limits", async () => {
    const healthRequest = () =>
      new Request("https://gateway.example.invalid/healthz");
    expect(
      (
        await handleGateway(healthRequest(), {
          ...gatewayEnv,
          DEPLOYMENT_ENV: "prodution",
        })
      ).status,
    ).toBe(500);
    expect(
      (
        await handleGateway(healthRequest(), {
          ...gatewayEnv,
          MAX_BODY_BYTES: "not-a-number",
        })
      ).status,
    ).toBe(500);
  });

  it("fails health when a compatible route credential is absent, short, or reuses signing material", async () => {
    const healthRequest = () =>
      new Request("https://gateway.example.invalid/healthz");
    const configured = upstreamEnv(5000);
    for (const upstreamKey of [
      undefined,
      "too-short",
      gatewayEnv.TOKEN_SIGNING_SECRET,
    ]) {
      expect(
        (
          await handleGateway(healthRequest(), {
            ...configured,
            UPSTREAM_KEY: upstreamKey,
          })
        ).status,
      ).toBe(500);
    }
    expect((await handleGateway(healthRequest(), configured)).status).toBe(200);
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

  it("releases expired concurrency but conservatively charges reserved spend", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
      const stub = env.QUOTA.get(
        env.QUOTA.idFromName("quota-expiry-recovery-fixture"),
      );
      const reserve = (requestId: string, reservedCostMicrocents: number) =>
        stub.fetch("https://quota.internal/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operation: "acquire",
            requestId,
            reservationTtlSeconds: 5,
            estimatedTokens: 10,
            reservedCostMicrocents,
            limits: {
              rpm: 10,
              tpm: 1000,
              concurrency: 1,
              dailyBudgetMicrocents: 100,
            },
          }),
        });

      expect((await reserve("expired-unknown", 60)).status).toBe(200);
      vi.setSystemTime(new Date("2026-01-01T12:00:06.000Z"));
      expect((await reserve("after-expiry", 0)).status).toBe(200);
      expect(
        (
          await stub.fetch("https://quota.internal/", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              operation: "complete",
              requestId: "after-expiry",
              actualTokens: 1,
              actualCostMicrocents: 0,
            }),
          })
        ).status,
      ).toBe(200);
      expect((await reserve("over-conservative-budget", 50)).status).toBe(402);
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
