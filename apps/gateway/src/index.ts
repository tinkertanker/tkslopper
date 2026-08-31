import {
  HttpError,
  ProviderError,
  bearerToken,
  callProvider,
  chatRequestSchema,
  errorResponse,
  inspectGatewayRequest,
  jsonResponse,
  logSafeEvent,
  parseProviderRoutes,
  pseudonymize,
  randomId,
  readJsonBody,
  responsesRequestSchema,
  sha256,
  verifyGrant,
  zodMessage,
  type Endpoint,
  type ParsedGatewayRequest,
  type ProviderRoute,
  type SafeRequestEvent,
} from "@tkslopper/shared";

import {
  QuotaCoordinator,
  type QuotaAcquireRequest,
  type QuotaCompleteRequest,
} from "./quota";

export { QuotaCoordinator };

export type GatewayEnv = {
  DB: D1Database;
  QUOTA: DurableObjectNamespace;
  TOKEN_ISSUER: string;
  DEPLOYMENT_ENV: string;
  PROVIDER_ROUTES_JSON: string;
  MAX_BODY_BYTES: string;
  [binding: string]: unknown;
} & Record<"TOKEN_SIGNING_SECRET", string>;

type GrantPolicyRow = {
  grant_id: string;
  product_id: string;
  environment_id: string;
  tenant_id: string;
  principal_id: string;
  audience: string;
  capabilities_json: string;
  grant_expires_at: number;
  revoked_at: number | null;
  entitlement_status: string | null;
  entitlement_source: string | null;
  entitlement_expires_at: number | null;
  entitlement_product_id: string | null;
  entitlement_environment_id: string | null;
  entitlement_tenant_id: string | null;
  entitlement_principal_id: string | null;
  access_code_disabled: number | null;
  access_code_expires_at: number | null;
  activation_id: string | null;
  activation_revoked_at: number | null;
  product_enabled: number;
  product_kill_switch: number;
  environment_enabled: number;
  environment_kill_switch: number;
  environment_policy_version: number;
  rpm_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  daily_budget_microcents: number;
  max_request_bytes: number;
};

type AliasRow = {
  route_id: string;
  allow_reasoning: number;
  allow_images: number;
  allow_structured_json: number;
  max_input_tokens: number;
  max_output_tokens: number;
  input_cost_microcents_per_million: number;
  output_cost_microcents_per_million: number;
  policy_version: number;
};

type RequestContext = {
  requestId: string;
  startedAt: number;
  endpoint?: Endpoint;
  alias?: string;
  policy?: GrantPolicyRow;
  aliasPolicy?: AliasRow;
  route?: ProviderRoute;
  tenantHash?: string;
  principalHash?: string;
  providerAttempted: boolean;
};

const forbiddenAttributionHeaders = [
  "x-tkslopper-product",
  "x-tkslopper-environment",
  "x-tkslopper-tenant",
  "x-tkslopper-principal",
  "x-tkslopper-provider",
  "x-tkslopper-model",
  "x-tkslopper-cost-tier",
] as const;

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function isConfigured(env: GatewayEnv): boolean {
  if (
    typeof env.TOKEN_SIGNING_SECRET !== "string" ||
    env.TOKEN_SIGNING_SECRET.length < 32
  )
    return false;
  try {
    if (new URL(env.TOKEN_ISSUER).protocol !== "https:") return false;
    const routes = parseProviderRoutes(env.PROVIDER_ROUTES_JSON);
    return !(
      env.DEPLOYMENT_ENV === "production" &&
      [...routes.values()].some(({ provider }) => provider === "fixture")
    );
  } catch {
    return false;
  }
}

function parseCapabilities(value: string): string[] {
  const parsed = JSON.parse(value) as unknown;
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string")
  ) {
    throw new HttpError(
      500,
      "internal_error",
      "stored capability policy is invalid",
    );
  }
  return parsed;
}

function ensureNoAttributionOverride(request: Request): void {
  if (
    forbiddenAttributionHeaders.some((header) => request.headers.has(header))
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      "client attribution overrides are forbidden",
    );
  }
}

async function authenticate(
  request: Request,
  env: GatewayEnv,
): Promise<{ policy: GrantPolicyRow; tokenCapabilities: string[] }> {
  const rawToken = bearerToken(request);
  if (!rawToken)
    throw new HttpError(
      401,
      "authentication_failed",
      "grant authentication failed",
    );
  const claims = await verifyGrant(
    rawToken,
    env.TOKEN_SIGNING_SECRET,
    env.TOKEN_ISSUER,
  );
  if (!claims)
    throw new HttpError(
      401,
      "authentication_failed",
      "grant authentication failed",
    );
  const policy = await env.DB.prepare(
    `SELECT g.id AS grant_id, g.product_id, g.environment_id, g.tenant_id, g.principal_id, g.audience,
            g.capabilities_json, g.expires_at AS grant_expires_at, g.revoked_at,
            n.status AS entitlement_status, n.source AS entitlement_source,
            n.expires_at AS entitlement_expires_at, n.product_id AS entitlement_product_id,
            n.environment_id AS entitlement_environment_id, n.tenant_id AS entitlement_tenant_id,
            n.principal_id AS entitlement_principal_id,
            c.disabled AS access_code_disabled, c.expires_at AS access_code_expires_at,
            a.id AS activation_id, a.revoked_at AS activation_revoked_at,
            p.enabled AS product_enabled, p.kill_switch AS product_kill_switch,
            e.enabled AS environment_enabled, e.kill_switch AS environment_kill_switch,
            e.policy_version AS environment_policy_version, e.rpm_limit, e.tpm_limit,
            e.concurrency_limit, e.daily_budget_microcents, e.max_request_bytes
       FROM token_grants g
       JOIN products p ON p.id = g.product_id
       JOIN environments e ON e.id = g.environment_id AND e.product_id = g.product_id
       LEFT JOIN entitlements n ON n.id = g.entitlement_id
       LEFT JOIN access_codes c ON n.source = 'access_code' AND c.id = n.source_ref
       LEFT JOIN activations a ON n.source = 'access_code' AND a.access_code_id = n.source_ref
                              AND a.principal_id = g.principal_id
      WHERE g.jti_hash = ?`,
  )
    .bind(await sha256(claims.jti))
    .first<GrantPolicyRow>();
  const now = nowSeconds();
  if (
    !policy ||
    policy.revoked_at !== null ||
    policy.grant_expires_at <= now ||
    policy.entitlement_status !== "active" ||
    (policy.entitlement_expires_at !== null &&
      policy.entitlement_expires_at <= now) ||
    (policy.entitlement_source === "access_code" &&
      (policy.access_code_disabled !== 0 ||
        policy.access_code_expires_at === null ||
        policy.access_code_expires_at <= now ||
        policy.activation_id === null ||
        policy.activation_revoked_at !== null)) ||
    policy.product_enabled !== 1 ||
    policy.product_kill_switch === 1 ||
    policy.environment_enabled !== 1 ||
    policy.environment_kill_switch === 1 ||
    policy.entitlement_product_id !== policy.product_id ||
    policy.entitlement_environment_id !== policy.environment_id ||
    policy.entitlement_tenant_id !== policy.tenant_id ||
    policy.entitlement_principal_id !== policy.principal_id
  ) {
    throw new HttpError(403, "authorization_failed", "grant is not active");
  }
  const matchesClaims =
    claims.aud === policy.audience &&
    claims.sub === policy.principal_id &&
    claims.tks.productId === policy.product_id &&
    claims.tks.environmentId === policy.environment_id &&
    claims.tks.tenantId === policy.tenant_id &&
    claims.tks.principalId === policy.principal_id;
  if (!matchesClaims)
    throw new HttpError(
      401,
      "authentication_failed",
      "grant authentication failed",
    );
  const storedCapabilities = parseCapabilities(policy.capabilities_json);
  if (
    !claims.tks.capabilities.every((capability) =>
      storedCapabilities.includes(capability),
    )
  ) {
    throw new HttpError(
      403,
      "authorization_failed",
      "grant capability policy changed",
    );
  }
  return { policy, tokenCapabilities: claims.tks.capabilities };
}

function parseGatewayRequest(
  endpoint: Endpoint,
  value: unknown,
): ParsedGatewayRequest {
  if (endpoint === "chat") {
    const parsed = chatRequestSchema.safeParse(value);
    if (!parsed.success)
      throw new HttpError(400, "invalid_request", zodMessage(parsed.error));
    return { endpoint, body: parsed.data };
  }
  const parsed = responsesRequestSchema.safeParse(value);
  if (!parsed.success)
    throw new HttpError(400, "invalid_request", zodMessage(parsed.error));
  return { endpoint, body: parsed.data };
}

async function acquireIdempotency(
  request: Request,
  env: GatewayEnv,
  context: RequestContext,
  requestHash: string,
): Promise<void> {
  const key = request.headers.get("idempotency-key");
  if (!key) return;
  if (!/^[\x21-\x7E]{8,128}$/u.test(key)) {
    throw new HttpError(
      400,
      "invalid_request",
      "idempotency-key must be 8-128 visible ASCII characters",
    );
  }
  const policy = context.policy;
  if (!policy)
    throw new HttpError(500, "internal_error", "request context is incomplete");
  const now = nowSeconds();
  const scopeHash = await pseudonymize(
    `${policy.product_id}:${policy.environment_id}:${policy.tenant_id}:${policy.principal_id}`,
    env.TOKEN_SIGNING_SECRET,
  );
  const keyHash = await pseudonymize(key, env.TOKEN_SIGNING_SECRET);
  const result = await env.DB.prepare(
    `INSERT INTO idempotency_keys
      (scope_hash, key_hash, request_hash, request_id, status, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'started', ?, ?)
     ON CONFLICT(scope_hash, key_hash) DO UPDATE SET
       request_hash = excluded.request_hash,
       request_id = excluded.request_id,
       status = 'started',
       created_at = excluded.created_at,
       expires_at = excluded.expires_at
     WHERE idempotency_keys.expires_at <= excluded.created_at`,
  )
    .bind(scopeHash, keyHash, requestHash, context.requestId, now, now + 86_400)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new HttpError(
      409,
      "conflict",
      "idempotency key was already used; responses are not replayed",
    );
  }
}

async function finishIdempotency(
  request: Request,
  env: GatewayEnv,
  context: RequestContext,
  status: "completed" | "failed",
) {
  const key = request.headers.get("idempotency-key");
  const policy = context.policy;
  if (!key || !policy) return;
  const [scopeHash, keyHash] = await Promise.all([
    pseudonymize(
      `${policy.product_id}:${policy.environment_id}:${policy.tenant_id}:${policy.principal_id}`,
      env.TOKEN_SIGNING_SECRET,
    ),
    pseudonymize(key, env.TOKEN_SIGNING_SECRET),
  ]);
  await env.DB.prepare(
    "UPDATE idempotency_keys SET status = ? WHERE scope_hash = ? AND key_hash = ? AND request_id = ?",
  )
    .bind(status, scopeHash, keyHash, context.requestId)
    .run();
}

export function costMicrocents(tokens: number, ratePerMillion: number): number {
  const numerator = BigInt(tokens) * BigInt(ratePerMillion);
  const cost = (numerator + 999_999n) / 1_000_000n;
  if (cost > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpError(500, "internal_error", "configured rate is too large");
  }
  return Number(cost);
}

async function quotaCall(
  env: GatewayEnv,
  policy: GrantPolicyRow,
  body: QuotaAcquireRequest | QuotaCompleteRequest,
): Promise<Response> {
  const scope = `${policy.product_id}:${policy.environment_id}:${policy.tenant_id}:${policy.principal_id}`;
  const stub = env.QUOTA.get(env.QUOTA.idFromName(scope));
  return stub.fetch("https://quota.internal/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function recordAttemptStart(
  env: GatewayEnv,
  context: RequestContext,
  values: {
    inputTokens: number;
    outputTokens: number;
    costMicrocents: number;
  },
): Promise<void> {
  const {
    policy,
    aliasPolicy,
    route,
    endpoint,
    alias,
    tenantHash,
    principalHash,
  } = context;
  if (
    !policy ||
    !aliasPolicy ||
    !route ||
    !endpoint ||
    !alias ||
    !tenantHash ||
    !principalHash
  ) {
    throw new HttpError(500, "internal_error", "request context is incomplete");
  }
  const createdAt = nowSeconds();
  await env.DB.prepare(
    `INSERT INTO provider_attempts
      (id, request_id, attempt_number, product_id, environment_id, tenant_hash, principal_hash,
       alias, policy_version, route_id, provider, resolved_model, endpoint, status_code, error_class,
       latency_ms, input_tokens, output_tokens, cost_microcents, created_at, stale_after)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      randomId("attempt"),
      context.requestId,
      policy.product_id,
      policy.environment_id,
      tenantHash,
      principalHash,
      alias,
      aliasPolicy.policy_version,
      route.id,
      route.provider,
      route.model,
      endpoint,
      0,
      "attempt_started",
      0,
      values.inputTokens,
      values.outputTokens,
      values.costMicrocents,
      createdAt,
      createdAt + Math.ceil(route.timeoutMs / 1000) + 30,
    )
    .run();
}

async function recordAttempt(
  env: GatewayEnv,
  context: RequestContext,
  values: {
    statusCode: number;
    errorClass: string | null;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    costMicrocents: number;
  },
): Promise<void> {
  const result = await env.DB.prepare(
    `UPDATE provider_attempts
        SET status_code = ?, error_class = ?, latency_ms = ?, input_tokens = ?, output_tokens = ?,
            cost_microcents = ?
      WHERE request_id = ? AND attempt_number = 1`,
  )
    .bind(
      values.statusCode,
      values.errorClass,
      values.latencyMs,
      values.inputTokens,
      values.outputTokens,
      values.costMicrocents,
      context.requestId,
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new HttpError(
      500,
      "internal_error",
      "provider attempt accounting failed",
    );
  }
}

function safeEvent(
  context: RequestContext,
  values: Omit<SafeRequestEvent, "requestId" | "latencyMs">,
): SafeRequestEvent {
  return {
    requestId: context.requestId,
    productId: context.policy?.product_id,
    environmentId: context.policy?.environment_id,
    tenantHash: context.tenantHash,
    principalHash: context.principalHash,
    alias: context.alias,
    policyVersion: context.aliasPolicy?.policy_version,
    routeId: context.route?.id,
    provider: context.route?.provider,
    model: context.route?.model,
    endpoint: context.endpoint,
    latencyMs: Date.now() - context.startedAt,
    ...values,
  };
}

async function handleInference(
  request: Request,
  env: GatewayEnv,
  endpoint: Endpoint,
): Promise<Response> {
  const context: RequestContext = {
    requestId: randomId("req"),
    startedAt: Date.now(),
    endpoint,
    providerAttempted: false,
  };
  let quotaAcquired = false;
  let reservedTokens = 0;
  let reservedCost = 0;
  try {
    ensureNoAttributionOverride(request);
    const { policy, tokenCapabilities } = await authenticate(request, env);
    context.policy = policy;
    [context.tenantHash, context.principalHash] = await Promise.all([
      pseudonymize(policy.tenant_id, env.TOKEN_SIGNING_SECRET),
      pseudonymize(policy.principal_id, env.TOKEN_SIGNING_SECRET),
    ]);
    const globalMaxBody = Number(env.MAX_BODY_BYTES);
    const maxBody = Math.min(
      Number.isSafeInteger(globalMaxBody) && globalMaxBody > 0
        ? globalMaxBody
        : 1_048_576,
      policy.max_request_bytes,
    );
    const parsedRequest = parseGatewayRequest(
      endpoint,
      await readJsonBody(request, maxBody),
    );
    const inspection = inspectGatewayRequest(parsedRequest);
    context.alias = inspection.alias;
    if (!tokenCapabilities.includes(inspection.alias)) {
      throw new HttpError(
        403,
        "authorization_failed",
        "capability is not granted",
      );
    }
    const aliasPolicy = await env.DB.prepare(
      `SELECT route_id, allow_reasoning, allow_images, allow_structured_json,
              max_input_tokens, max_output_tokens,
              input_cost_microcents_per_million, output_cost_microcents_per_million, policy_version
         FROM aliases
        WHERE product_id = ? AND environment_id = ? AND alias = ? AND endpoint = ? AND enabled = 1`,
    )
      .bind(
        policy.product_id,
        policy.environment_id,
        inspection.alias,
        endpoint,
      )
      .first<AliasRow>();
    if (!aliasPolicy)
      throw new HttpError(
        403,
        "authorization_failed",
        "capability is not allowed for this endpoint",
      );
    context.aliasPolicy = aliasPolicy;
    if (inspection.estimatedInputTokens > aliasPolicy.max_input_tokens) {
      throw new HttpError(
        400,
        "invalid_request",
        "estimated input exceeds capability limit",
      );
    }
    if (inspection.maxOutputTokens > aliasPolicy.max_output_tokens) {
      throw new HttpError(
        400,
        "invalid_request",
        "requested output exceeds capability limit",
      );
    }
    if (inspection.hasImages && aliasPolicy.allow_images !== 1) {
      throw new HttpError(
        400,
        "invalid_request",
        "images are not allowed by this capability",
      );
    }
    if (
      inspection.hasStructuredJson &&
      aliasPolicy.allow_structured_json !== 1
    ) {
      throw new HttpError(
        400,
        "invalid_request",
        "structured JSON is not allowed by this capability",
      );
    }
    if (inspection.reasoningEffort && aliasPolicy.allow_reasoning !== 1) {
      throw new HttpError(
        400,
        "invalid_request",
        "reasoning effort is not allowed by this capability",
      );
    }
    const routes = parseProviderRoutes(env.PROVIDER_ROUTES_JSON);
    const route = routes.get(aliasPolicy.route_id);
    if (!route || !route.endpoints.includes(endpoint)) {
      throw new HttpError(
        503,
        "provider_unavailable",
        "capability route is unavailable",
      );
    }
    if (inspection.hasImages && !route.supportsImages) {
      throw new HttpError(
        503,
        "provider_unavailable",
        "capability route does not support images",
      );
    }
    if (inspection.hasStructuredJson && !route.supportsStructuredJson) {
      throw new HttpError(
        503,
        "provider_unavailable",
        "capability route does not support structured JSON",
      );
    }
    if (inspection.reasoningEffort && !route.supportsReasoning) {
      throw new HttpError(
        503,
        "provider_unavailable",
        "capability route does not support reasoning effort",
      );
    }
    context.route = route;
    await acquireIdempotency(
      request,
      env,
      context,
      await sha256(`${endpoint}:${inspection.alias}:${context.requestId}`),
    );

    const reservedInputTokens = inspection.hasImages
      ? aliasPolicy.max_input_tokens
      : inspection.estimatedInputTokens;
    reservedTokens = reservedInputTokens + inspection.maxOutputTokens;
    reservedCost =
      costMicrocents(
        reservedInputTokens,
        aliasPolicy.input_cost_microcents_per_million,
      ) +
      costMicrocents(
        inspection.maxOutputTokens,
        aliasPolicy.output_cost_microcents_per_million,
      );
    const quotaResponse = await quotaCall(env, policy, {
      operation: "acquire",
      requestId: context.requestId,
      reservationTtlSeconds: Math.ceil(route.timeoutMs / 1000) + 30,
      estimatedTokens: reservedTokens,
      reservedCostMicrocents: reservedCost,
      limits: {
        rpm: policy.rpm_limit,
        tpm: policy.tpm_limit,
        concurrency: policy.concurrency_limit,
        dailyBudgetMicrocents: policy.daily_budget_microcents,
      },
    });
    if (!quotaResponse.ok) {
      const reason = (await quotaResponse.json<{ reason?: string }>()).reason;
      const budget = reason === "budget";
      throw new HttpError(
        budget ? 402 : 429,
        budget ? "budget_exceeded" : "rate_limit_exceeded",
        budget
          ? "daily budget is exhausted"
          : "rate or concurrency limit exceeded",
      );
    }
    quotaAcquired = true;

    await recordAttemptStart(env, context, {
      inputTokens: reservedInputTokens,
      outputTokens: inspection.maxOutputTokens,
      costMicrocents: reservedCost,
    });

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort("deadline"),
      route.timeoutMs,
    );
    const abortFromClient = (): void => controller.abort("client_disconnected");
    request.signal.addEventListener("abort", abortFromClient, { once: true });
    if (request.signal.aborted) abortFromClient();
    try {
      context.providerAttempted = true;
      const result = await callProvider({
        request: parsedRequest,
        route,
        deploymentEnvironment: env.DEPLOYMENT_ENV,
        maxResponseBytes: Math.min(maxBody, 8_388_608),
        signal: controller.signal,
        getSecret: (binding) =>
          typeof env[binding] === "string" ? env[binding] : undefined,
      });
      if (
        result.usage.inputTokens > aliasPolicy.max_input_tokens ||
        result.usage.outputTokens > inspection.maxOutputTokens
      ) {
        throw new ProviderError("provider_protocol", 502, result.latencyMs);
      }
      const inputTokens = result.usage.inputTokens || reservedInputTokens;
      const outputTokens =
        result.usage.outputTokens || inspection.maxOutputTokens;
      const actualCost =
        costMicrocents(
          inputTokens,
          aliasPolicy.input_cost_microcents_per_million,
        ) +
        costMicrocents(
          outputTokens,
          aliasPolicy.output_cost_microcents_per_million,
        );
      const completion = await quotaCall(env, policy, {
        operation: "complete",
        requestId: context.requestId,
        actualTokens: inputTokens + outputTokens,
        actualCostMicrocents: actualCost,
      });
      if (!completion.ok)
        throw new HttpError(
          503,
          "internal_error",
          "quota accounting completion failed",
        );
      quotaAcquired = false;
      await recordAttempt(env, context, {
        statusCode: result.status,
        errorClass: null,
        latencyMs: result.latencyMs,
        inputTokens,
        outputTokens,
        costMicrocents: actualCost,
      });
      await finishIdempotency(request, env, context, "completed");
      logSafeEvent(
        safeEvent(context, {
          status: 200,
          inputTokens,
          outputTokens,
          costMicrocents: actualCost,
          attempts: 1,
        }),
      );
      return jsonResponse({ ...result.body, model: inspection.alias }, 200, {
        "x-tkslopper-request-id": context.requestId,
      });
    } catch (error) {
      if (!(error instanceof ProviderError)) throw error;
      const completion = await quotaCall(env, policy, {
        operation: "complete",
        requestId: context.requestId,
        actualTokens: reservedTokens,
        actualCostMicrocents: reservedCost,
      });
      if (!completion.ok)
        throw new HttpError(
          503,
          "internal_error",
          "quota accounting completion failed",
        );
      quotaAcquired = false;
      await recordAttempt(env, context, {
        statusCode: error.status,
        errorClass: error.errorClass,
        latencyMs: error.latencyMs,
        inputTokens: reservedInputTokens,
        outputTokens: inspection.maxOutputTokens,
        costMicrocents: reservedCost,
      });
      await finishIdempotency(request, env, context, "failed");
      const status =
        error.errorClass === "provider_timeout"
          ? 504
          : error.errorClass === "provider_cancelled"
            ? 499
            : 502;
      logSafeEvent(
        safeEvent(context, {
          status,
          errorClass: error.errorClass,
          inputTokens: reservedInputTokens,
          outputTokens: inspection.maxOutputTokens,
          costMicrocents: reservedCost,
          attempts: 1,
        }),
      );
      return errorResponse(
        status,
        "provider_unavailable",
        "upstream provider request failed",
        context.requestId,
      );
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abortFromClient);
    }
  } catch (error) {
    if (quotaAcquired && context.policy) {
      await quotaCall(env, context.policy, {
        operation: "complete",
        requestId: context.requestId,
        actualTokens: reservedTokens,
        actualCostMicrocents: reservedCost,
      }).catch(() => undefined);
    }
    await finishIdempotency(request, env, context, "failed").catch(
      () => undefined,
    );
    if (error instanceof HttpError) {
      logSafeEvent(
        safeEvent(context, {
          status: error.status,
          errorClass: error.code,
          attempts: context.providerAttempted ? 1 : 0,
        }),
      );
      return errorResponse(
        error.status,
        error.code,
        error.message,
        context.requestId,
      );
    }
    logSafeEvent(
      safeEvent(context, {
        status: 500,
        errorClass: "internal_error",
        attempts: context.providerAttempted ? 1 : 0,
      }),
    );
    return errorResponse(
      500,
      "internal_error",
      "gateway request failed",
      context.requestId,
    );
  }
}

export async function handleGateway(
  request: Request,
  env: GatewayEnv,
): Promise<Response> {
  if (!isConfigured(env))
    return errorResponse(500, "internal_error", "gateway is not configured");
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/healthz") {
    return jsonResponse({
      status: "ok",
      component: "gateway",
      streaming: false,
    });
  }
  if (request.method !== "POST")
    return errorResponse(404, "not_found", "not found");
  if (url.pathname === "/v1/chat/completions")
    return handleInference(request, env, "chat");
  if (url.pathname === "/v1/responses")
    return handleInference(request, env, "responses");
  return errorResponse(404, "not_found", "not found");
}

export default { fetch: handleGateway } satisfies ExportedHandler<GatewayEnv>;
