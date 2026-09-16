import { SELF, env, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  chatRequestSchema,
  inspectGatewayRequest,
  pseudonymize,
  randomId,
  randomSecret,
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
import {
  classroomQuotaScope,
  isClassroomGroupKey,
} from "../apps/gateway/src/classroom";
import { CLASSROOM_STORAGE_KEY } from "../apps/gateway/src/quota";
import vibbitChatResponse from "./fixtures/vibbit-chat-response.json";

const now = (): number => Math.floor(Date.now() / 1000);

const PRODUCT = "prod_vibbit";
const ENVIRONMENT = "env_vibbit";
const AUDIENCE = "vibbit:test";
const ALIAS = "text.chat.v1";
const TENANT = "tenant_classroom";
const OTHER_TENANT = "tenant_other";
const CLASS = "class_alpha";
const CLASS_BETA = "class_beta";
const CLASS_ADVERSARIAL = "class_adversarial";
const GROUP = "group_alpha";
const GROUP_GAMMA = "group_gamma";
const GROUP_BETA = "group_beta";
const DEVICE_PRINCIPAL = "device:fixture";

const groupKeyAlpha = `tkgk_${randomSecret(32)}`;
const groupKeyGamma = `tkgk_${randomSecret(32)}`;
const groupKeyBeta = `tkgk_${randomSecret(32)}`;
const groupKeyRevoked = `tkgk_${randomSecret(32)}`;

type ClassroomGroupStateShape = {
  lifetimeSpentMicrocents: number;
  lifetimeReservedMicrocents: number;
  dayKey: string;
  daySpentMicrocents: number;
  dayReservedMicrocents: number;
  minuteKey: string;
  requestsThisMinute: number;
  tokensThisMinute: number;
};

type ClassroomStateShape = {
  classId: string;
  lifetimeSpentMicrocents: number;
  lifetimeReservedMicrocents: number;
  groups: Record<string, ClassroomGroupStateShape>;
  reservations: Record<
    string,
    {
      groupId: string;
      estimatedTokens: number;
      reservedCostMicrocents: number;
      expiresAt: number;
      minuteKey: string;
      dayKey: string;
    }
  >;
  completionReceipts: Record<string, unknown>;
};

function classroomStub(classId: string) {
  return env.QUOTA.get(
    env.QUOTA.idFromName(classroomQuotaScope(PRODUCT, ENVIRONMENT, classId)),
  );
}

async function classroomState(classId: string): Promise<ClassroomStateShape> {
  const state = await rawClassroomState(classId);
  if (!state) throw new Error("classroom state was not persisted");
  return state;
}

async function rawClassroomState(
  classId: string,
): Promise<ClassroomStateShape | undefined> {
  return await runInDurableObject(
    classroomStub(classId),
    async (_instance, durableState) =>
      durableState.storage.get<ClassroomStateShape>(CLASSROOM_STORAGE_KEY),
  );
}

async function classroomCall(
  classId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return await classroomStub(classId).fetch("https://quota.internal/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const DEFAULT_LIMITS = {
  classBudgetMicrocents: 1_000_000,
  groupBudgetMicrocents: 1_000_000,
  dailyBudgetMicrocents: null,
  rpm: 10,
  tpm: 1_000_000,
  concurrency: 10,
};

function acquireBody(
  requestId: string,
  groupId: string,
  overrides: {
    reservedCostMicrocents?: number;
    estimatedTokens?: number;
    reservationTtlSeconds?: number;
    limits?: Record<string, unknown>;
  } = {},
): Record<string, unknown> {
  return {
    operation: "classroom_acquire",
    requestId,
    reservationTtlSeconds: overrides.reservationTtlSeconds ?? 60,
    estimatedTokens: overrides.estimatedTokens ?? 1,
    reservedCostMicrocents: overrides.reservedCostMicrocents ?? 10,
    classId: CLASS,
    groupId,
    limits: overrides.limits ?? DEFAULT_LIMITS,
  };
}

function completeBody(
  requestId: string,
  actualTokens: number,
  actualCostMicrocents: number,
  groupId: string = GROUP,
): Record<string, unknown> {
  return {
    operation: "classroom_complete",
    requestId,
    groupId,
    actualTokens,
    actualCostMicrocents,
  };
}

beforeEach(async () => {
  const timestamp = now();
  const classStarts = timestamp - 3600;
  const classExpires = timestamp + 3600;
  for (const scope of [
    classroomQuotaScope(PRODUCT, ENVIRONMENT, CLASS),
    classroomQuotaScope(PRODUCT, ENVIRONMENT, CLASS_BETA),
    identityScope(PRODUCT, ENVIRONMENT, TENANT, DEVICE_PRINCIPAL),
    identityScope(PRODUCT, ENVIRONMENT, TENANT, "principal_fixture"),
  ]) {
    const stub = env.QUOTA.get(env.QUOTA.idFromName(scope));
    await runInDurableObject(stub, async (_instance, durableState) => {
      await durableState.storage.deleteAll();
    });
  }
  const [alphaHash, gammaHash, betaHash, revokedHash] = await Promise.all([
    sha256(groupKeyAlpha),
    sha256(groupKeyGamma),
    sha256(groupKeyBeta),
    sha256(groupKeyRevoked),
  ]);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM provider_attempts"),
    env.DB.prepare("DELETE FROM idempotency_keys"),
    env.DB.prepare("DELETE FROM token_grants"),
    env.DB.prepare("DELETE FROM entitlements"),
    env.DB.prepare("DELETE FROM activations"),
    env.DB.prepare("DELETE FROM access_codes"),
    env.DB.prepare("DELETE FROM service_credentials"),
    env.DB.prepare("DELETE FROM classroom_group_keys"),
    env.DB.prepare("DELETE FROM classroom_groups"),
    env.DB.prepare("DELETE FROM classroom_classes"),
    env.DB.prepare("DELETE FROM aliases"),
    env.DB.prepare("DELETE FROM environments"),
    env.DB.prepare("DELETE FROM products"),
    env.DB.prepare("DELETE FROM admin_audit"),
    env.DB.prepare(
      `INSERT INTO products (id, slug, display_name, created_at, updated_at)
       VALUES (?, 'vibbit', 'Vibbit fixture', ?, ?)`,
    ).bind(PRODUCT, timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO environments
       (id, product_id, name, audience, rpm_limit, tpm_limit, concurrency_limit,
        daily_budget_microcents, max_request_bytes, created_at, updated_at)
       VALUES (?, ?, 'test', ?, 20, 1000000, 2, 1000000, 8388608, ?, ?)`,
    ).bind(ENVIRONMENT, PRODUCT, AUDIENCE, timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO aliases
       (id, product_id, environment_id, alias, endpoint, route_id, max_input_tokens, max_output_tokens,
        input_cost_microcents_per_million, output_cost_microcents_per_million, created_at, updated_at)
       VALUES ('alias_chat', ?, ?, ?, 'chat', 'fixture-text-v1', 500000, 4096, 1000, 2000, ?, ?)`,
    ).bind(PRODUCT, ENVIRONMENT, ALIAS, timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO classroom_classes
       (id, product_id, environment_id, tenant_id, name, starts_at, expires_at, status,
        capabilities_json, budget_microcents, group_budget_microcents, daily_budget_microcents,
        rpm_limit, tpm_limit, concurrency_limit, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Alpha', ?, ?, 'active', ?, 1000000, 500000, NULL, 20, 1000000, 2, ?, ?)`,
    ).bind(
      CLASS,
      PRODUCT,
      ENVIRONMENT,
      TENANT,
      classStarts,
      classExpires,
      JSON.stringify([ALIAS]),
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO classroom_classes
       (id, product_id, environment_id, tenant_id, name, starts_at, expires_at, status,
        capabilities_json, budget_microcents, group_budget_microcents, daily_budget_microcents,
        rpm_limit, tpm_limit, concurrency_limit, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'Beta', ?, ?, 'active', ?, 1000000, 500000, NULL, 20, 1000000, 2, ?, ?)`,
    ).bind(
      CLASS_BETA,
      PRODUCT,
      ENVIRONMENT,
      OTHER_TENANT,
      classStarts,
      classExpires,
      JSON.stringify([ALIAS]),
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO classroom_groups
       (id, class_id, name, status, capabilities_json, budget_microcents, daily_budget_microcents,
        rpm_limit, tpm_limit, concurrency_limit, starts_at, expires_at, created_at, updated_at)
       VALUES (?, ?, 'Alpha group', 'active', NULL, 400000, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    ).bind(GROUP, CLASS, timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO classroom_groups
       (id, class_id, name, status, capabilities_json, budget_microcents, daily_budget_microcents,
        rpm_limit, tpm_limit, concurrency_limit, starts_at, expires_at, created_at, updated_at)
       VALUES (?, ?, 'Gamma group', 'active', NULL, 400000, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    ).bind(GROUP_GAMMA, CLASS, timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO classroom_groups
       (id, class_id, name, status, capabilities_json, budget_microcents, daily_budget_microcents,
        rpm_limit, tpm_limit, concurrency_limit, starts_at, expires_at, created_at, updated_at)
       VALUES (?, ?, 'Beta group', 'active', NULL, 400000, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    ).bind(GROUP_BETA, CLASS_BETA, timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO classroom_group_keys (id, group_id, secret_hash, expires_at, revoked_at, created_at)
       VALUES ('gkey_alpha', ?, ?, NULL, NULL, ?)`,
    ).bind(GROUP, alphaHash, timestamp),
    env.DB.prepare(
      `INSERT INTO classroom_group_keys (id, group_id, secret_hash, expires_at, revoked_at, created_at)
       VALUES ('gkey_gamma', ?, ?, NULL, NULL, ?)`,
    ).bind(GROUP_GAMMA, gammaHash, timestamp),
    env.DB.prepare(
      `INSERT INTO classroom_group_keys (id, group_id, secret_hash, expires_at, revoked_at, created_at)
       VALUES ('gkey_beta', ?, ?, NULL, NULL, ?)`,
    ).bind(GROUP_BETA, betaHash, timestamp),
    env.DB.prepare(
      `INSERT INTO classroom_group_keys (id, group_id, secret_hash, expires_at, revoked_at, created_at)
       VALUES ('gkey_revoked', ?, ?, NULL, ?, ?)`,
    ).bind(GROUP, revokedHash, timestamp, timestamp),
  ]);
});

const defaultChatBody = {
  model: ALIAS,
  messages: [{ role: "user", content: "SYNTHETIC_PRIVATE_PROMPT_SENTINEL" }],
  max_completion_tokens: 100,
  stream: false,
};

function chatRequest(
  token: string,
  body: Record<string, unknown> = defaultChatBody,
): Request {
  return new Request("https://gateway.example.invalid/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function classroomUpstreamEnv(): GatewayEnv {
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
        timeoutMs: 5000,
      },
    }),
    UPSTREAM_KEY: "public-fixture-upstream-value",
  };
}

async function classroomGrant(options?: {
  groupId?: string;
  tenant?: string;
  principal?: string;
  capability?: string;
  accessCodeExpiresAt?: number;
  grantExpiresAt?: number;
}): Promise<string> {
  const groupId = options?.groupId ?? GROUP;
  const tenant = options?.tenant ?? TENANT;
  const principal = options?.principal ?? DEVICE_PRINCIPAL;
  const capability = options?.capability ?? ALIAS;
  const timestamp = now();
  const accessCodeId = randomId("ac");
  const entitlementId = randomId("ent");
  const jti = randomId("grant");
  const accessCodeExpiresAt = options?.accessCodeExpiresAt ?? timestamp + 600;
  const grantExpiresAt = options?.grantExpiresAt ?? timestamp + 600;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO access_codes
       (id, product_id, environment_id, tenant_id, secret_salt, secret_hash, capabilities_json,
        expires_at, max_activations, activation_count, max_failed_attempts, failed_attempts, disabled,
        created_at, updated_at, classroom_group_id)
       VALUES (?, ?, ?, ?, 'salt', 'hash', ?, ?, 10, 1, 8, 0, 0, ?, ?, ?)`,
    ).bind(
      accessCodeId,
      PRODUCT,
      ENVIRONMENT,
      tenant,
      JSON.stringify([capability]),
      accessCodeExpiresAt,
      timestamp,
      timestamp,
      groupId,
    ),
    env.DB.prepare(
      `INSERT INTO activations (id, access_code_id, tenant_id, principal_id, device_hash, activated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      randomId("activation"),
      accessCodeId,
      tenant,
      principal,
      "devicehash_fixture",
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO entitlements
       (id, product_id, environment_id, tenant_id, principal_id, source, source_ref, capabilities_json,
        status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'access_code', ?, ?, 'active', ?, ?, ?)`,
    ).bind(
      entitlementId,
      PRODUCT,
      ENVIRONMENT,
      tenant,
      principal,
      accessCodeId,
      JSON.stringify([capability]),
      accessCodeExpiresAt,
      timestamp,
      timestamp,
    ),
    env.DB.prepare(
      `INSERT INTO token_grants
       (id, jti_hash, entitlement_id, product_id, environment_id, tenant_id, principal_id, audience,
        capabilities_json, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      randomId("tgrant"),
      await sha256(jti),
      entitlementId,
      PRODUCT,
      ENVIRONMENT,
      tenant,
      principal,
      AUDIENCE,
      JSON.stringify([capability]),
      grantExpiresAt,
      timestamp,
    ),
  ]);
  const claims: GrantClaims = {
    iss: env.TOKEN_ISSUER,
    aud: AUDIENCE,
    sub: principal,
    iat: timestamp,
    exp: grantExpiresAt,
    jti,
    tks: {
      productId: PRODUCT,
      environmentId: ENVIRONMENT,
      tenantId: tenant,
      principalId: principal,
      capabilities: [capability],
      tokenType: "direct_client",
    },
  };
  return signGrant(claims, env.TOKEN_SIGNING_SECRET);
}

describe("classroom authorization", () => {
  it("derives the accounting scope from the classroom tuple", () => {
    expect(classroomQuotaScope(PRODUCT, ENVIRONMENT, CLASS)).toBe(
      JSON.stringify(["classroom", PRODUCT, ENVIRONMENT, CLASS]),
    );
    expect(isClassroomGroupKey(groupKeyAlpha)).toBe(true);
    expect(isClassroomGroupKey(`tkgk_${"a".repeat(10)}`)).toBe(false);
    expect(isClassroomGroupKey(`tkac_${"a".repeat(43)}`)).toBe(false);
  });

  it("accepts a direct group key, serves the fixture, and attributes the group", async () => {
    const response = await SELF.fetch(chatRequest(groupKeyAlpha));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(vibbitChatResponse);
    const attempt = await env.DB.prepare(
      `SELECT product_id, environment_id, tenant_hash, principal_hash, classroom_group_id, cost_microcents
         FROM provider_attempts`,
    ).first<{
      product_id: string;
      environment_id: string;
      tenant_hash: string;
      principal_hash: string;
      classroom_group_id: string | null;
      cost_microcents: number;
    }>();
    expect(attempt).toMatchObject({
      product_id: PRODUCT,
      environment_id: ENVIRONMENT,
      classroom_group_id: GROUP,
    });
    expect(attempt?.tenant_hash).toBe(
      await pseudonymize(TENANT, env.TOKEN_SIGNING_SECRET),
    );
    expect(attempt?.principal_hash).toBe(
      await pseudonymize(GROUP, env.TOKEN_SIGNING_SECRET),
    );
    const state = await classroomState(CLASS);
    expect(state.groups[GROUP]?.lifetimeSpentMicrocents).toBe(
      attempt?.cost_microcents,
    );
    expect(state.lifetimeSpentMicrocents).toBe(attempt?.cost_microcents);
    expect(state.lifetimeReservedMicrocents).toBe(0);
    expect(state.groups[GROUP]?.lifetimeReservedMicrocents).toBe(0);
  });

  it("rejects unknown, revoked, and expired group keys", async () => {
    expect((await SELF.fetch(chatRequest(groupKeyRevoked))).status).toBe(403);
    expect(
      (await SELF.fetch(chatRequest(`tkgk_${randomSecret(32)}`))).status,
    ).toBe(401);
    await env.DB.prepare(
      "UPDATE classroom_group_keys SET expires_at = ? WHERE id = 'gkey_alpha'",
    )
      .bind(now() - 1)
      .run();
    expect((await SELF.fetch(chatRequest(groupKeyAlpha))).status).toBe(403);
  });

  it("narrows direct keys to the class and group approved aliases", async () => {
    await env.DB.prepare(
      "UPDATE classroom_classes SET capabilities_json = ? WHERE id = ?",
    )
      .bind(JSON.stringify(["other.alias.v1"]), CLASS)
      .run();
    expect((await SELF.fetch(chatRequest(groupKeyAlpha))).status).toBe(403);

    await env.DB.prepare(
      "UPDATE classroom_classes SET capabilities_json = ? WHERE id = ?",
    )
      .bind(JSON.stringify([ALIAS, "second.alias.v1"]), CLASS)
      .run();
    await env.DB.prepare(
      "UPDATE classroom_groups SET capabilities_json = ? WHERE id = ?",
    )
      .bind(JSON.stringify(["second.alias.v1"]), GROUP)
      .run();
    expect((await SELF.fetch(chatRequest(groupKeyAlpha))).status).toBe(403);

    await env.DB.prepare(
      "UPDATE classroom_groups SET capabilities_json = ? WHERE id = ?",
    )
      .bind(JSON.stringify([ALIAS]), GROUP)
      .run();
    expect((await SELF.fetch(chatRequest(groupKeyAlpha))).status).toBe(200);
  });

  it("applies class pause and revoke to an already-issued grant and a valid key", async () => {
    const token = await classroomGrant();
    expect((await SELF.fetch(chatRequest(token))).status).toBe(200);
    await env.DB.prepare(
      "UPDATE classroom_classes SET status = 'paused' WHERE id = ?",
    )
      .bind(CLASS)
      .run();
    expect((await SELF.fetch(chatRequest(token))).status).toBe(403);
    expect((await SELF.fetch(chatRequest(groupKeyAlpha))).status).toBe(403);
    await env.DB.prepare(
      "UPDATE classroom_classes SET status = 'active' WHERE id = ?",
    )
      .bind(CLASS)
      .run();
    expect((await SELF.fetch(chatRequest(token))).status).toBe(200);
    await env.DB.prepare(
      "UPDATE classroom_classes SET status = 'revoked' WHERE id = ?",
    )
      .bind(CLASS)
      .run();
    expect((await SELF.fetch(chatRequest(token))).status).toBe(403);
    expect((await SELF.fetch(chatRequest(groupKeyAlpha))).status).toBe(403);
  });

  it("applies group revoke to an already-issued grant and a valid key", async () => {
    const token = await classroomGrant();
    expect((await SELF.fetch(chatRequest(token))).status).toBe(200);
    await env.DB.prepare(
      "UPDATE classroom_groups SET status = 'revoked' WHERE id = ?",
    )
      .bind(GROUP)
      .run();
    expect((await SELF.fetch(chatRequest(token))).status).toBe(403);
    expect((await SELF.fetch(chatRequest(groupKeyAlpha))).status).toBe(403);
  });

  it("enforces the effective class and group schedule on an existing grant", async () => {
    const token = await classroomGrant();
    const future = now() + 3600;
    const past = now() - 3600;
    await env.DB.prepare(
      "UPDATE classroom_classes SET starts_at = ?, expires_at = ? WHERE id = ?",
    )
      .bind(future, future + 3600, CLASS)
      .run();
    expect((await SELF.fetch(chatRequest(token))).status).toBe(403);

    await env.DB.prepare(
      "UPDATE classroom_classes SET starts_at = ?, expires_at = ? WHERE id = ?",
    )
      .bind(past, future, CLASS)
      .run();
    await env.DB.prepare(
      "UPDATE classroom_groups SET starts_at = ? WHERE id = ?",
    )
      .bind(future, GROUP)
      .run();
    expect((await SELF.fetch(chatRequest(token))).status).toBe(403);

    await env.DB.prepare(
      "UPDATE classroom_groups SET starts_at = NULL, expires_at = ? WHERE id = ?",
    )
      .bind(past, GROUP)
      .run();
    expect((await SELF.fetch(chatRequest(token))).status).toBe(403);

    await env.DB.prepare(
      "UPDATE classroom_groups SET starts_at = NULL, expires_at = NULL WHERE id = ?",
    )
      .bind(GROUP)
      .run();
    expect((await SELF.fetch(chatRequest(token))).status).toBe(200);
  });

  it("fails closed when a grant's classroom group belongs to another tenant", async () => {
    const forged = await classroomGrant({
      groupId: GROUP_BETA,
      tenant: TENANT,
    });
    expect((await SELF.fetch(chatRequest(forged))).status).toBe(403);

    // The direct key for that group still works and lands in its own class scope.
    expect((await SELF.fetch(chatRequest(groupKeyBeta))).status).toBe(200);
    const beta = await classroomState(CLASS_BETA);
    expect(beta.lifetimeSpentMicrocents).toBeGreaterThan(0);
    await expect(rawClassroomState(CLASS)).resolves.toBeUndefined();
  });

  it("shares one group budget across a direct key and an activated device", async () => {
    const token = await classroomGrant();
    expect((await SELF.fetch(chatRequest(token))).status).toBe(200);
    expect((await SELF.fetch(chatRequest(groupKeyAlpha))).status).toBe(200);
    const total = await env.DB.prepare(
      "SELECT SUM(cost_microcents) AS total FROM provider_attempts",
    ).first<{ total: number }>();
    const state = await classroomState(CLASS);
    expect(state.groups[GROUP]?.lifetimeSpentMicrocents).toBe(total?.total);
    expect(state.lifetimeSpentMicrocents).toBe(total?.total);
  });

  it("keeps group spend across key rotation and applies budget changes live", async () => {
    expect((await SELF.fetch(chatRequest(groupKeyAlpha))).status).toBe(200);
    const afterFirst = await classroomState(CLASS);
    const firstSpend = afterFirst.groups[GROUP]?.lifetimeSpentMicrocents ?? 0;
    expect(firstSpend).toBeGreaterThan(0);

    const rotated = `tkgk_${randomSecret(32)}`;
    await env.DB.prepare(
      `INSERT INTO classroom_group_keys (id, group_id, secret_hash, expires_at, revoked_at, created_at)
       VALUES ('gkey_rotated', ?, ?, NULL, NULL, ?)`,
    )
      .bind(GROUP, await sha256(rotated), now())
      .run();
    await env.DB.prepare(
      "UPDATE classroom_group_keys SET revoked_at = ? WHERE id = 'gkey_alpha'",
    )
      .bind(now())
      .run();
    expect((await SELF.fetch(chatRequest(rotated))).status).toBe(200);
    expect((await SELF.fetch(chatRequest(groupKeyAlpha))).status).toBe(403);

    const afterSecond = await classroomState(CLASS);
    const secondSpend = afterSecond.groups[GROUP]?.lifetimeSpentMicrocents ?? 0;
    expect(secondSpend).toBeGreaterThan(firstSpend);
    expect(afterSecond.lifetimeSpentMicrocents).toBe(secondSpend);

    // Lowering the allocation below recorded spend must deny, proving no reset.
    await env.DB.prepare(
      "UPDATE classroom_groups SET budget_microcents = 0 WHERE id = ?",
    )
      .bind(GROUP)
      .run();
    expect((await SELF.fetch(chatRequest(rotated))).status).toBe(402);
  });

  it("enforces the shared class lifetime cap across groups", async () => {
    const first = await SELF.fetch(chatRequest(groupKeyAlpha));
    expect(first.status).toBe(200);
    const attempt = await env.DB.prepare(
      "SELECT cost_microcents FROM provider_attempts",
    ).first<{ cost_microcents: number }>();
    const spent = attempt?.cost_microcents ?? 0;
    expect(spent).toBeGreaterThan(0);
    await env.DB.prepare(
      "UPDATE classroom_classes SET budget_microcents = ? WHERE id = ?",
    )
      .bind(spent, CLASS)
      .run();
    const denied = await SELF.fetch(chatRequest(groupKeyGamma));
    expect(denied.status).toBe(402);
    await expect(denied.json()).resolves.toMatchObject({
      error: { code: "budget_exceeded" },
    });
  });

  it("enforces a per-group lifetime allocation independently of other groups", async () => {
    await env.DB.prepare(
      "UPDATE classroom_groups SET budget_microcents = 0 WHERE id = ?",
    )
      .bind(GROUP_GAMMA)
      .run();
    expect((await SELF.fetch(chatRequest(groupKeyGamma))).status).toBe(402);
    expect((await SELF.fetch(chatRequest(groupKeyAlpha))).status).toBe(200);
  });

  it("reserves the input ceiling so an asymmetric settle cannot exceed the class cap", async () => {
    const conservativeReservation =
      costMicrocents(500_000, 1000) + costMicrocents(100, 2000);
    const inspection = inspectGatewayRequest({
      endpoint: "chat",
      body: chatRequestSchema.parse(defaultChatBody),
    });
    const estimateOnlyReservation =
      costMicrocents(inspection.estimatedInputTokens, 1000) +
      costMicrocents(inspection.maxOutputTokens, 2000);
    expect(estimateOnlyReservation).toBeLessThan(conservativeReservation);

    // A cap the estimate-based reservation would have admitted must deny,
    // because classroom admission reserves the configured input ceiling.
    await env.DB.prepare(
      "UPDATE classroom_classes SET budget_microcents = ? WHERE id = ?",
    )
      .bind(conservativeReservation - 1, CLASS)
      .run();
    expect((await SELF.fetch(chatRequest(groupKeyAlpha))).status).toBe(402);

    await env.DB.prepare(
      "UPDATE classroom_classes SET budget_microcents = ? WHERE id = ?",
    )
      .bind(conservativeReservation, CLASS)
      .run();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: "chatcmpl_asymmetric",
        object: "chat.completion",
        model: "physical-fixture-v1",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "fixture response" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3000, completion_tokens: 100 },
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      const response = await handleGateway(
        chatRequest(groupKeyAlpha),
        classroomUpstreamEnv(),
      );
      expect(response.status).toBe(200);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }

    const actualCost = costMicrocents(3000, 1000) + costMicrocents(100, 2000);
    // The provider reported far more input than the estimate, and the settle
    // still stayed within the reservation.
    expect(actualCost).toBeGreaterThan(estimateOnlyReservation);
    expect(actualCost).toBeLessThanOrEqual(conservativeReservation);
    const state = await classroomState(CLASS);
    expect(state.lifetimeReservedMicrocents).toBe(0);
    expect(state.lifetimeSpentMicrocents).toBe(actualCost);
    expect(state.groups[GROUP]?.lifetimeSpentMicrocents).toBe(actualCost);
  });

  it("rejects client attribution overrides on the classroom path", async () => {
    const response = await SELF.fetch(
      new Request("https://gateway.example.invalid/v1/chat/completions", {
        method: "POST",
        headers: {
          authorization: `Bearer ${groupKeyAlpha}`,
          "content-type": "application/json",
          "x-tkslopper-tenant": OTHER_TENANT,
        },
        body: JSON.stringify(defaultChatBody),
      }),
    );
    expect(response.status).toBe(400);
    await expect(rawClassroomState(CLASS)).resolves.toBeUndefined();
  });

  it("names the exhausted classroom budget dimension without claiming a daily cap", async () => {
    expect((await SELF.fetch(chatRequest(groupKeyAlpha))).status).toBe(200);
    const attempt = await env.DB.prepare(
      "SELECT cost_microcents FROM provider_attempts",
    ).first<{ cost_microcents: number }>();
    const spent = attempt?.cost_microcents ?? 0;
    expect(spent).toBeGreaterThan(0);

    await env.DB.prepare(
      "UPDATE classroom_classes SET budget_microcents = ? WHERE id = ?",
    )
      .bind(spent, CLASS)
      .run();
    const classDenied = await SELF.fetch(chatRequest(groupKeyAlpha));
    expect(classDenied.status).toBe(402);
    await expect(classDenied.json()).resolves.toMatchObject({
      error: {
        code: "budget_exceeded",
        message: "classroom total budget is exhausted",
      },
    });

    await env.DB.prepare(
      "UPDATE classroom_classes SET budget_microcents = 1000000 WHERE id = ?",
    )
      .bind(CLASS)
      .run();
    await env.DB.prepare(
      "UPDATE classroom_groups SET budget_microcents = ? WHERE id = ?",
    )
      .bind(spent, GROUP)
      .run();
    const groupDenied = await SELF.fetch(chatRequest(groupKeyAlpha));
    expect(groupDenied.status).toBe(402);
    await expect(groupDenied.json()).resolves.toMatchObject({
      error: { message: "classroom group budget is exhausted" },
    });

    await env.DB.prepare(
      "UPDATE classroom_groups SET budget_microcents = 1000000, daily_budget_microcents = 1 WHERE id = ?",
    )
      .bind(GROUP)
      .run();
    const dailyDenied = await SELF.fetch(chatRequest(groupKeyAlpha));
    expect(dailyDenied.status).toBe(402);
    await expect(dailyDenied.json()).resolves.toMatchObject({
      error: { message: "classroom group daily budget is exhausted" },
    });
  });

  it("never resets group or class counters on policy updates", async () => {
    expect((await SELF.fetch(chatRequest(groupKeyAlpha))).status).toBe(200);
    const before = await classroomState(CLASS);
    const groupSpent = before.groups[GROUP]?.lifetimeSpentMicrocents ?? 0;
    const classSpent = before.lifetimeSpentMicrocents;
    expect(groupSpent).toBeGreaterThan(0);

    const timestamp = now();
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE classroom_classes
            SET budget_microcents = 999999, capabilities_json = ?, starts_at = ?, expires_at = ?,
                status = 'paused'
          WHERE id = ?`,
      ).bind(
        JSON.stringify([ALIAS]),
        timestamp - 7200,
        timestamp + 7200,
        CLASS,
      ),
      env.DB.prepare(
        `UPDATE classroom_groups
            SET budget_microcents = 888888, capabilities_json = ?, status = 'active',
                starts_at = NULL, expires_at = NULL
          WHERE id = ?`,
      ).bind(JSON.stringify([ALIAS]), GROUP),
    ]);
    await env.DB.prepare(
      "UPDATE classroom_classes SET status = 'active' WHERE id = ?",
    )
      .bind(CLASS)
      .run();

    const afterUpdates = await classroomState(CLASS);
    expect(afterUpdates.groups[GROUP]?.lifetimeSpentMicrocents).toBe(
      groupSpent,
    );
    expect(afterUpdates.lifetimeSpentMicrocents).toBe(classSpent);

    expect((await SELF.fetch(chatRequest(groupKeyAlpha))).status).toBe(200);
    const afterRequest = await classroomState(CLASS);
    expect(
      afterRequest.groups[GROUP]?.lifetimeSpentMicrocents ?? 0,
    ).toBeGreaterThan(groupSpent);
    expect(afterRequest.lifetimeSpentMicrocents).toBeGreaterThan(classSpent);
    expect(afterRequest.lifetimeReservedMicrocents).toBe(0);
    expect(afterRequest.groups[GROUP]?.lifetimeReservedMicrocents).toBe(0);
  });

  it("fails closed when classroom completion cannot be confirmed", async () => {
    const operations: Array<Record<string, unknown>> = [];
    const quotaStub = {
      fetch(_url: string, init?: RequestInit): Promise<Response> {
        if (typeof init?.body !== "string")
          throw new Error("synthetic quota request body was not a string");
        const operation = JSON.parse(init.body) as Record<string, unknown>;
        operations.push(operation);
        return Promise.resolve(
          operation.operation === "classroom_acquire"
            ? Response.json({ acquired: true, existing: false })
            : Response.json({ completed: false }, { status: 503 }),
        );
      },
    };
    const quotaNamespace = {
      idFromName: () => ({ synthetic: true }),
      get: () => quotaStub,
    } as unknown as DurableObjectNamespace;
    const logger = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      const response = await handleGateway(chatRequest(groupKeyAlpha), {
        ...(env as unknown as GatewayEnv),
        QUOTA: quotaNamespace,
      });
      expect(response.status).toBe(503);
      expect(operations.map(({ operation }) => operation)).toEqual([
        "classroom_acquire",
        "classroom_complete",
        "classroom_complete",
      ]);
      expect(JSON.parse(String(logger.mock.calls.at(-1)?.[0]))).toMatchObject({
        event: "inference_request",
        status: 503,
        attempts: 1,
        quotaReservationState: "unresolved",
      });
    } finally {
      logger.mockRestore();
    }
  });
});

describe("classroom quota coordinator", () => {
  it("makes repeated admission and completion retry-safe", async () => {
    expect(
      (await classroomCall(CLASS, acquireBody("retry-1", GROUP))).status,
    ).toBe(200);
    const second = await classroomCall(CLASS, acquireBody("retry-1", GROUP));
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      acquired: true,
      existing: true,
    });
    expect(
      (await classroomCall(CLASS, completeBody("retry-1", 5, 7))).status,
    ).toBe(200);
    await expect(
      (await classroomCall(CLASS, completeBody("retry-1", 5, 7))).json(),
    ).resolves.toMatchObject({
      completed: true,
      found: false,
      knownCompleted: true,
    });
    expect(
      (await classroomCall(CLASS, completeBody("retry-1", 5, 8))).status,
    ).toBe(409);
    const state = await classroomState(CLASS);
    expect(state.lifetimeReservedMicrocents).toBe(0);
    expect(state.lifetimeSpentMicrocents).toBe(7);
    expect(state.groups[GROUP]?.lifetimeSpentMicrocents).toBe(7);
    expect(state.groups[GROUP]?.lifetimeReservedMicrocents).toBe(0);
  });

  it("reports an unknown completion after reservation expiry", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T12:00:00.000Z"));
      expect(
        (
          await classroomCall(
            CLASS,
            acquireBody("late", GROUP, {
              reservedCostMicrocents: 9,
              reservationTtlSeconds: 5,
              limits: { ...DEFAULT_LIMITS, concurrency: 1 },
            }),
          )
        ).status,
      ).toBe(200);
      vi.setSystemTime(new Date("2026-01-01T12:00:06.000Z"));
      const late = await classroomCall(CLASS, completeBody("late", 1, 1));
      expect(late.status).toBe(404);
      await expect(late.json()).resolves.toMatchObject({
        completed: false,
        reason: "unknown_reservation",
      });
      const state = await classroomState(CLASS);
      expect(state.lifetimeReservedMicrocents).toBe(0);
      expect(state.lifetimeSpentMicrocents).toBe(9);
      expect(state.groups[GROUP]?.lifetimeSpentMicrocents).toBe(9);
    } finally {
      vi.useRealTimers();
    }
  });

  it("repairs a duplicate reservation that survived a recorded completion", async () => {
    expect((await classroomCall(CLASS, acquireBody("dup", GROUP))).status).toBe(
      200,
    );
    expect((await classroomCall(CLASS, completeBody("dup", 5, 7))).status).toBe(
      200,
    );
    await runInDurableObject(
      classroomStub(CLASS),
      async (_instance, durableState) => {
        const state = await durableState.storage.get<ClassroomStateShape>(
          CLASSROOM_STORAGE_KEY,
        );
        if (!state) throw new Error("classroom state was not persisted");
        const group = state.groups[GROUP];
        if (!group) throw new Error("classroom group ledger is missing");
        state.lifetimeReservedMicrocents += 7;
        group.lifetimeReservedMicrocents += 7;
        group.dayReservedMicrocents += 7;
        state.reservations.dup = {
          groupId: GROUP,
          estimatedTokens: 1,
          reservedCostMicrocents: 7,
          expiresAt: Math.floor(Date.now() / 1000) + 60,
          minuteKey: group.minuteKey,
          dayKey: group.dayKey,
        };
        await durableState.storage.put(CLASSROOM_STORAGE_KEY, state);
      },
    );
    await expect(
      (await classroomCall(CLASS, completeBody("dup", 5, 7))).json(),
    ).resolves.toMatchObject({
      completed: true,
      found: false,
      knownCompleted: true,
    });
    const state = await classroomState(CLASS);
    expect(state.lifetimeReservedMicrocents).toBe(0);
    expect(state.lifetimeSpentMicrocents).toBe(7);
  });

  it("rejects a completion bound to a different group scope", async () => {
    expect(
      (await classroomCall(CLASS, acquireBody("scope-complete", GROUP))).status,
    ).toBe(200);
    const wrongGroup = await classroomCall(
      CLASS,
      completeBody("scope-complete", 5, 7, GROUP_GAMMA),
    );
    expect(wrongGroup.status).toBe(409);
    await expect(wrongGroup.json()).resolves.toMatchObject({
      completed: false,
      reason: "completion_scope_mismatch",
    });

    // The reservation is untouched and still settles for its own group.
    expect(
      (await classroomCall(CLASS, completeBody("scope-complete", 5, 7))).status,
    ).toBe(200);
    const state = await classroomState(CLASS);
    expect(state.lifetimeSpentMicrocents).toBe(7);
    expect(state.groups[GROUP]?.lifetimeSpentMicrocents).toBe(7);
    expect(state.groups[GROUP_GAMMA]).toBeUndefined();

    // A replay for the wrong group is rejected against the receipt too.
    expect(
      (
        await classroomCall(
          CLASS,
          completeBody("scope-complete", 5, 7, GROUP_GAMMA),
        )
      ).status,
    ).toBe(409);
    expect((await classroomState(CLASS)).lifetimeSpentMicrocents).toBe(7);
  });

  it("does not double charge when a completion receipt has been evicted", async () => {
    expect(
      (await classroomCall(CLASS, acquireBody("evict", GROUP))).status,
    ).toBe(200);
    expect(
      (await classroomCall(CLASS, completeBody("evict", 5, 7))).status,
    ).toBe(200);
    expect((await classroomState(CLASS)).lifetimeSpentMicrocents).toBe(7);

    await runInDurableObject(
      classroomStub(CLASS),
      async (_instance, durableState) => {
        const state = await durableState.storage.get<ClassroomStateShape>(
          CLASSROOM_STORAGE_KEY,
        );
        if (!state) throw new Error("classroom state was not persisted");
        state.completionReceipts = {};
        await durableState.storage.put(CLASSROOM_STORAGE_KEY, state);
      },
    );

    const replay = await classroomCall(CLASS, completeBody("evict", 5, 7));
    expect(replay.status).toBe(404);
    await expect(replay.json()).resolves.toMatchObject({
      completed: false,
      reason: "unknown_reservation",
    });
    const after = await classroomState(CLASS);
    expect(after.lifetimeSpentMicrocents).toBe(7);
    expect(after.lifetimeReservedMicrocents).toBe(0);
  });

  it("bounds retained completion receipts", async () => {
    expect(
      (await classroomCall(CLASS, acquireBody("bounded", GROUP))).status,
    ).toBe(200);
    await runInDurableObject(
      classroomStub(CLASS),
      async (_instance, durableState) => {
        const state = await durableState.storage.get<ClassroomStateShape>(
          CLASSROOM_STORAGE_KEY,
        );
        if (!state) throw new Error("classroom state was not persisted");
        const expiresAt = Math.floor(Date.now() / 1000) + 300;
        for (let index = 0; index < 600; index += 1) {
          state.completionReceipts[`synthetic-${index}`] = {
            groupId: GROUP,
            actualTokens: 0,
            actualCostMicrocents: 0,
            expiresAt,
          };
        }
        await durableState.storage.put(CLASSROOM_STORAGE_KEY, state);
      },
    );
    expect(
      (await classroomCall(CLASS, completeBody("bounded", 5, 7))).status,
    ).toBe(200);
    const state = await classroomState(CLASS);
    expect(Object.keys(state.completionReceipts).length).toBeLessThanOrEqual(
      512,
    );
    expect(state.completionReceipts.bounded).toBeDefined();
    expect(state.completionReceipts["synthetic-0"]).toBeUndefined();
  });

  it("serializes concurrency per group while the class ledger stays shared", async () => {
    const limits = { ...DEFAULT_LIMITS, concurrency: 1 };
    expect(
      (await classroomCall(CLASS, acquireBody("a-1", GROUP, { limits })))
        .status,
    ).toBe(200);
    expect(
      (await classroomCall(CLASS, acquireBody("a-2", GROUP, { limits })))
        .status,
    ).toBe(429);
    expect(
      (await classroomCall(CLASS, acquireBody("g-1", GROUP_GAMMA, { limits })))
        .status,
    ).toBe(200);
    const state = await classroomState(CLASS);
    expect(Object.keys(state.reservations).sort()).toEqual(["a-1", "g-1"]);
    expect(state.lifetimeReservedMicrocents).toBe(20);
  });

  it("serializes concurrent cross-group reservations against the shared class cap", async () => {
    await runInDurableObject(
      classroomStub(CLASS_ADVERSARIAL),
      async (_instance, durableState) => {
        await durableState.storage.deleteAll();
      },
    );
    const limits = {
      classBudgetMicrocents: 67,
      groupBudgetMicrocents: 1000,
      dailyBudgetMicrocents: null,
      rpm: 100,
      tpm: 1_000_000,
      concurrency: 10,
    };
    const acquire = (requestId: string, groupId: string) =>
      classroomCall(CLASS_ADVERSARIAL, {
        ...acquireBody(requestId, groupId, {
          reservedCostMicrocents: 17,
          limits,
        }),
        classId: CLASS_ADVERSARIAL,
      });

    // Twenty distinct groups race for a 67 cap at 17 each: only three fit.
    const firstWave = await Promise.all(
      Array.from({ length: 20 }, (_value, index) =>
        acquire(`adversarial-${index}`, `group-adversarial-${index}`),
      ),
    );
    const admitted = firstWave
      .map((response, index) => ({ response, index }))
      .filter(({ response }) => response.status === 200);
    expect(admitted).toHaveLength(3);
    expect(
      firstWave.filter((response) => response.status === 402),
    ).toHaveLength(17);
    const denied = firstWave.find((response) => response.status === 402);
    if (!denied) throw new Error("expected a class-cap denial");
    await expect(denied.json()).resolves.toMatchObject({
      acquired: false,
      reason: "class_budget",
    });

    // Each admitted reservation is completed twice concurrently. The duplicate
    // must settle idempotently, charging 7 + 11 + 13 exactly once.
    const costs = [7, 11, 13];
    const completions = await Promise.all(
      admitted.flatMap(({ index }, position) => {
        const body = completeBody(
          `adversarial-${index}`,
          1,
          costs[position] ?? 0,
          `group-adversarial-${index}`,
        );
        return [
          classroomCall(CLASS_ADVERSARIAL, body),
          classroomCall(CLASS_ADVERSARIAL, body),
        ];
      }),
    );
    expect(completions.map((response) => response.status)).toEqual([
      200, 200, 200, 200, 200, 200,
    ]);
    const completionBodies = await Promise.all(
      completions.map((response) =>
        response.json<{
          completed?: unknown;
          found?: unknown;
          knownCompleted?: unknown;
        }>(),
      ),
    );
    expect(completionBodies.every((body) => body.completed === true)).toBe(
      true,
    );
    expect(completionBodies.filter((body) => body.found === true)).toHaveLength(
      3,
    );
    expect(
      completionBodies.filter((body) => body.knownCompleted === true),
    ).toHaveLength(3);

    const settled = await classroomState(CLASS_ADVERSARIAL);
    expect(settled.lifetimeSpentMicrocents).toBe(31);
    expect(settled.lifetimeReservedMicrocents).toBe(0);

    // 31 spent + two 17 reservations = 65 <= 67, so exactly two of three fit.
    const secondWave = await Promise.all([
      acquire("second-wave-a", "group-second-a"),
      acquire("second-wave-b", "group-second-b"),
      acquire("second-wave-c", "group-second-c"),
    ]);
    expect(
      secondWave.filter((response) => response.status === 200),
    ).toHaveLength(2);
    expect(
      secondWave.filter((response) => response.status === 402),
    ).toHaveLength(1);
    const finalState = await classroomState(CLASS_ADVERSARIAL);
    expect(finalState.lifetimeSpentMicrocents).toBe(31);
    expect(finalState.lifetimeReservedMicrocents).toBe(34);
    expect(
      finalState.lifetimeSpentMicrocents +
        finalState.lifetimeReservedMicrocents,
    ).toBe(65);
    expect(
      Object.values(finalState.groups).reduce(
        (sum, group) => sum + group.lifetimeSpentMicrocents,
        0,
      ),
    ).toBe(31);
  });

  it("enforces a group daily budget and rolls it over at UTC midnight without resetting lifetime", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T23:59:50.000Z"));
      const limits = {
        classBudgetMicrocents: 1000,
        groupBudgetMicrocents: 1000,
        dailyBudgetMicrocents: 100,
        rpm: 10,
        tpm: 1000,
        concurrency: 10,
      };
      expect(
        (
          await classroomCall(
            CLASS,
            acquireBody("day-1", GROUP, {
              reservedCostMicrocents: 60,
              reservationTtlSeconds: 20,
              limits,
            }),
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await classroomCall(
            CLASS,
            acquireBody("day-1-over", GROUP, {
              reservedCostMicrocents: 50,
              limits,
            }),
          )
        ).status,
      ).toBe(402);
      vi.setSystemTime(new Date("2026-01-02T00:00:01.000Z"));
      expect(
        (
          await classroomCall(
            CLASS,
            acquireBody("day-2", GROUP, {
              reservedCostMicrocents: 60,
              limits,
            }),
          )
        ).status,
      ).toBe(200);
      const state = await classroomState(CLASS);
      expect(state.lifetimeReservedMicrocents).toBe(120);
      expect(state.groups[GROUP]?.lifetimeReservedMicrocents).toBe(120);
      expect(state.groups[GROUP]?.dayReservedMicrocents).toBe(60);
      expect(state.groups[GROUP]?.dayKey).toBe("2026-01-02");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the legacy principal ledger separate from the classroom ledger", async () => {
    const legacyScope = identityScope(
      PRODUCT,
      ENVIRONMENT,
      TENANT,
      DEVICE_PRINCIPAL,
    );
    const legacyStub = env.QUOTA.get(env.QUOTA.idFromName(legacyScope));
    expect(
      (
        await legacyStub.fetch("https://quota.internal/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operation: "acquire",
            requestId: "legacy-1",
            reservationTtlSeconds: 60,
            estimatedTokens: 10,
            reservedCostMicrocents: 5,
            limits: {
              rpm: 10,
              tpm: 1000,
              concurrency: 1,
              dailyBudgetMicrocents: 100,
            },
          }),
        })
      ).status,
    ).toBe(200);
    const legacyState = await runInDurableObject(
      legacyStub,
      async (_instance, durableState) =>
        durableState.storage.get<{
          spentTodayMicrocents: number;
          reservedTodayMicrocents: number;
        }>("quota"),
    );
    expect(legacyState?.reservedTodayMicrocents).toBe(5);
    await expect(rawClassroomState(CLASS)).resolves.toBeUndefined();
  });

  it("rejects a classroom payload whose class scope disagrees with the object", async () => {
    expect(
      (await classroomCall(CLASS, acquireBody("scope-seed", GROUP))).status,
    ).toBe(200);
    const response = await classroomStub(CLASS).fetch(
      "https://quota.internal/",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...acquireBody("scope-1", GROUP),
          classId: CLASS_BETA,
        }),
      },
    );
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toMatchObject({
      error: "classroom_scope_mismatch",
    });
  });
});
