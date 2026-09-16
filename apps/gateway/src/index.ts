import {
  DATABASE_SCHEMA_VERSION,
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
  prepareProvider,
  pseudonymize,
  randomId,
  readJsonBody,
  responsesRequestSchema,
  sha256,
  verifyGrant,
  zodMessage,
  type Endpoint,
  type ParsedGatewayRequest,
  type PreparedProvider,
  type ProviderRoute,
  type SafeRequestEvent,
} from "@tkslopper/shared";

import {
  QUOTA_PROTOCOL_VERSION,
  QuotaCoordinator,
  type ClassroomAcquireRequest,
  type ClassroomCompleteRequest,
  type QuotaAcquireRequest,
  type QuotaCompleteRequest,
} from "./quota";
import {
  authenticateClassroomKey,
  isClassroomGroupKey,
  resolveClassroomGrantAuthorization,
  type ClassroomLimits,
  type RequestPolicy,
} from "./classroom";

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

type GrantPolicyRow = RequestPolicy & {
  grant_id: string;
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
  service_credential_id: string | null;
  service_credential_disabled: number | null;
  service_credential_expires_at: number | null;
  access_code_disabled: number | null;
  access_code_expires_at: number | null;
  access_code_product_id: string | null;
  access_code_environment_id: string | null;
  access_code_tenant_id: string | null;
  access_code_classroom_group_id: string | null;
  activation_id: string | null;
  activation_tenant_id: string | null;
  activation_principal_id: string | null;
  activation_revoked_at: number | null;
  product_enabled: number;
  product_kill_switch: number;
  environment_enabled: number;
  environment_kill_switch: number;
  environment_policy_version: number;
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
  policy?: RequestPolicy;
  aliasPolicy?: AliasRow;
  route?: ProviderRoute;
  tenantHash?: string;
  principalHash?: string;
  providerAttempted: boolean;
  quotaScope?: string;
  classroom?: { classId: string; groupId: string };
  classroomLimits?: ClassroomLimits;
};

type Authentication = {
  policy: RequestPolicy;
  tokenCapabilities: string[];
  quotaScope: string;
  classroom?: { classId: string; groupId: string };
  classroomLimits?: ClassroomLimits;
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

function hasBindingMethods(value: unknown, methods: string[]): boolean {
  if (typeof value !== "object" || value === null) return false;
  const binding = value as Record<string, unknown>;
  return methods.every((method) => typeof binding[method] === "function");
}

function isConfigured(env: GatewayEnv): boolean {
  const maxBodyBytes = Number(env.MAX_BODY_BYTES);
  if (
    !hasBindingMethods(env.DB, ["prepare"]) ||
    !hasBindingMethods(env.QUOTA, ["idFromName", "get"]) ||
    typeof env.TOKEN_SIGNING_SECRET !== "string" ||
    env.TOKEN_SIGNING_SECRET.length < 32 ||
    !["development", "test", "production"].includes(env.DEPLOYMENT_ENV) ||
    !Number.isSafeInteger(maxBodyBytes) ||
    maxBodyBytes < 1024 ||
    maxBodyBytes > 10_485_760
  )
    return false;
  try {
    if (new URL(env.TOKEN_ISSUER).protocol !== "https:") return false;
    const routes = parseProviderRoutes(env.PROVIDER_ROUTES_JSON);
    if (routes.size === 0) return false;
    for (const route of routes.values()) {
      if (route.adapter === "fixture") {
        if (env.DEPLOYMENT_ENV === "production") return false;
        continue;
      }
      const credential = env[route.credentialBinding];
      if (
        typeof credential !== "string" ||
        credential.length < 16 ||
        credential === env.TOKEN_SIGNING_SECRET
      )
        return false;
      if (route.gateway) {
        const gatewayCredential = env[route.gateway.credentialBinding];
        if (
          typeof gatewayCredential !== "string" ||
          gatewayCredential.length < 16 ||
          gatewayCredential === credential ||
          gatewayCredential === env.TOKEN_SIGNING_SECRET
        )
          return false;
      }
    }
    return true;
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

async function authenticateGrant(
  request: Request,
  env: GatewayEnv,
): Promise<Authentication> {
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
            s.id AS service_credential_id, s.disabled AS service_credential_disabled,
            s.expires_at AS service_credential_expires_at,
            c.disabled AS access_code_disabled, c.expires_at AS access_code_expires_at,
            c.product_id AS access_code_product_id, c.environment_id AS access_code_environment_id,
            c.tenant_id AS access_code_tenant_id,
            c.classroom_group_id AS access_code_classroom_group_id,
            a.id AS activation_id, a.tenant_id AS activation_tenant_id,
            a.principal_id AS activation_principal_id, a.revoked_at AS activation_revoked_at,
            p.enabled AS product_enabled, p.kill_switch AS product_kill_switch,
            e.enabled AS environment_enabled, e.kill_switch AS environment_kill_switch,
            e.policy_version AS environment_policy_version, e.rpm_limit, e.tpm_limit,
            e.concurrency_limit, e.daily_budget_microcents, e.max_request_bytes
       FROM token_grants g
       JOIN products p ON p.id = g.product_id
       JOIN environments e ON e.id = g.environment_id AND e.product_id = g.product_id
       LEFT JOIN entitlements n ON n.id = g.entitlement_id
       LEFT JOIN service_credentials s ON n.source = 'service' AND s.id = n.source_ref
                                      AND s.product_id = g.product_id
                                      AND s.environment_id = g.environment_id
                                      AND s.tenant_id = g.tenant_id
                                      AND s.principal_id = g.principal_id
       LEFT JOIN access_codes c ON n.source = 'access_code' AND c.id = n.source_ref
                               AND c.product_id = g.product_id
                               AND c.environment_id = g.environment_id
                               AND c.tenant_id = g.tenant_id
       LEFT JOIN activations a ON n.source = 'access_code' AND a.access_code_id = c.id
                              AND a.tenant_id = g.tenant_id
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
    (policy.entitlement_source === "service" &&
      (policy.service_credential_id === null ||
        policy.service_credential_disabled !== 0 ||
        (policy.service_credential_expires_at !== null &&
          policy.service_credential_expires_at <= now))) ||
    (policy.entitlement_source === "access_code" &&
      (policy.access_code_disabled !== 0 ||
        policy.access_code_expires_at === null ||
        policy.access_code_expires_at <= now ||
        policy.access_code_product_id !== policy.product_id ||
        policy.access_code_environment_id !== policy.environment_id ||
        policy.access_code_tenant_id !== policy.tenant_id ||
        policy.activation_id === null ||
        policy.activation_tenant_id !== policy.tenant_id ||
        policy.activation_principal_id !== policy.principal_id ||
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
  let quotaScope = identityScope(
    policy.product_id,
    policy.environment_id,
    policy.tenant_id,
    policy.principal_id,
  );
  let tokenCapabilities = claims.tks.capabilities;
  let classroom: { classId: string; groupId: string } | undefined;
  let classroomLimits: ClassroomLimits | undefined;
  const classroomGroupId =
    policy.entitlement_source === "access_code"
      ? policy.access_code_classroom_group_id
      : null;
  if (classroomGroupId !== null) {
    const authorization = await resolveClassroomGrantAuthorization(env, {
      groupId: classroomGroupId,
      principalId: policy.principal_id,
      expected: {
        productId: policy.product_id,
        environmentId: policy.environment_id,
        tenantId: policy.tenant_id,
      },
      now,
    });
    tokenCapabilities = tokenCapabilities.filter((capability) =>
      authorization.capabilities.includes(capability),
    );
    quotaScope = authorization.quotaScope;
    classroom = authorization.classroom;
    classroomLimits = authorization.limits;
  }
  return {
    policy,
    tokenCapabilities,
    quotaScope,
    ...(classroom === undefined ? {} : { classroom }),
    ...(classroomLimits === undefined ? {} : { classroomLimits }),
  };
}

async function authenticateRequest(
  request: Request,
  env: GatewayEnv,
): Promise<Authentication> {
  const rawToken = bearerToken(request);
  if (rawToken && isClassroomGroupKey(rawToken))
    return await authenticateClassroomKey(request, env, nowSeconds());
  return await authenticateGrant(request, env);
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

export function identityScope(
  productId: string,
  environmentId: string,
  tenantId: string,
  principalId: string,
): string {
  return JSON.stringify([productId, environmentId, tenantId, principalId]);
}

async function acquireIdempotency(
  request: Request,
  env: GatewayEnv,
  context: RequestContext,
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
    identityScope(
      policy.product_id,
      policy.environment_id,
      policy.tenant_id,
      policy.principal_id,
    ),
    env.TOKEN_SIGNING_SECRET,
  );
  const keyHash = await pseudonymize(key, env.TOKEN_SIGNING_SECRET);
  const result = await env.DB.prepare(
    `INSERT INTO idempotency_keys
      (scope_hash, key_hash, request_id, status, created_at, expires_at)
     VALUES (?, ?, ?, 'started', ?, ?)
     ON CONFLICT(scope_hash, key_hash) DO UPDATE SET
       request_id = excluded.request_id,
       status = 'started',
       created_at = excluded.created_at,
       expires_at = excluded.expires_at
     WHERE idempotency_keys.expires_at <= excluded.created_at`,
  )
    .bind(scopeHash, keyHash, context.requestId, now, now + 86_400)
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
      identityScope(
        policy.product_id,
        policy.environment_id,
        policy.tenant_id,
        policy.principal_id,
      ),
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

type QuotaRequestBody =
  | QuotaAcquireRequest
  | QuotaCompleteRequest
  | ClassroomAcquireRequest
  | ClassroomCompleteRequest;

async function quotaCall(
  env: GatewayEnv,
  scope: string,
  body: QuotaRequestBody,
): Promise<Response> {
  const stub = env.QUOTA.get(env.QUOTA.idFromName(scope));
  return await stub.fetch("https://quota.internal/", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function quotaCallWithRetry(
  env: GatewayEnv,
  scope: string,
  body: QuotaRequestBody,
): Promise<Response> {
  let lastResponse: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const response = await quotaCall(env, scope, body);
      if (response.ok || response.status < 500) return response;
      lastResponse = response;
    } catch (error) {
      lastError = error;
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError instanceof Error
    ? lastError
    : new Error("quota coordinator call failed");
}

type ReservationValues = {
  reservationTtlSeconds: number;
  estimatedTokens: number;
  reservedCostMicrocents: number;
};

function quotaAcquireBody(
  context: RequestContext,
  values: ReservationValues,
): QuotaAcquireRequest | ClassroomAcquireRequest {
  const policy = context.policy;
  if (!policy)
    throw new HttpError(500, "internal_error", "request context is incomplete");
  if (context.classroom) {
    const { classroom, classroomLimits } = context;
    if (!classroomLimits)
      throw new HttpError(
        500,
        "internal_error",
        "classroom limits are missing from the request context",
      );
    return {
      operation: "classroom_acquire",
      requestId: context.requestId,
      reservationTtlSeconds: values.reservationTtlSeconds,
      estimatedTokens: values.estimatedTokens,
      reservedCostMicrocents: values.reservedCostMicrocents,
      classId: classroom.classId,
      groupId: classroom.groupId,
      limits: classroomLimits,
    };
  }
  return {
    operation: "acquire",
    requestId: context.requestId,
    reservationTtlSeconds: values.reservationTtlSeconds,
    estimatedTokens: values.estimatedTokens,
    reservedCostMicrocents: values.reservedCostMicrocents,
    limits: {
      rpm: policy.rpm_limit,
      tpm: policy.tpm_limit,
      concurrency: policy.concurrency_limit,
      dailyBudgetMicrocents: policy.daily_budget_microcents,
    },
  };
}

function quotaCompleteBody(
  context: RequestContext,
  values: { actualTokens: number; actualCostMicrocents: number },
): QuotaCompleteRequest | ClassroomCompleteRequest {
  if (context.classroom)
    return {
      operation: "classroom_complete",
      requestId: context.requestId,
      // Bound to the group that acquired the reservation, both derived from D1.
      groupId: context.classroom.groupId,
      actualTokens: values.actualTokens,
      actualCostMicrocents: values.actualCostMicrocents,
    };
  return {
    operation: "complete",
    requestId: context.requestId,
    actualTokens: values.actualTokens,
    actualCostMicrocents: values.actualCostMicrocents,
  };
}

function isBudgetDenial(reason: string | undefined): boolean {
  return (
    reason === "budget" ||
    reason === "class_budget" ||
    reason === "group_budget" ||
    reason === "group_daily_budget"
  );
}

/**
 * A classroom lifetime cap is not a daily cap. Only name the dimension the
 * admission reason actually identified; otherwise stay generic.
 */
function budgetDenialMessage(
  context: RequestContext,
  reason: string | undefined,
): string {
  if (!context.classroom) return "daily budget is exhausted";
  switch (reason) {
    case "class_budget":
      return "classroom total budget is exhausted";
    case "group_budget":
      return "classroom group budget is exhausted";
    case "group_daily_budget":
      return "classroom group daily budget is exhausted";
    default:
      return "classroom budget is exhausted";
  }
}

async function quotaCompletionSucceeded(
  response: Response | undefined,
): Promise<boolean> {
  if (!response?.ok) return false;
  try {
    const body = await response.json<{
      completed?: unknown;
      found?: unknown;
      knownCompleted?: unknown;
    }>();
    return (
      body.completed === true &&
      (body.found === true || body.knownCompleted === true)
    );
  } catch {
    return false;
  }
}

async function quotaAcquisitionSucceeded(response: Response): Promise<boolean> {
  if (!response.ok) return false;
  try {
    const body = await response.json<{
      acquired?: unknown;
      existing?: unknown;
    }>();
    return body.acquired === true && typeof body.existing === "boolean";
  } catch {
    return false;
  }
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
       latency_ms, input_tokens, output_tokens, cost_microcents, created_at, stale_after, classroom_group_id)
     VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      // Classroom attribution only; legacy attempts keep NULL.
      context.classroom?.groupId ?? null,
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

async function discardAttemptIntent(
  env: GatewayEnv,
  context: RequestContext,
): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM provider_attempts
      WHERE request_id = ? AND attempt_number = 1 AND error_class = 'attempt_started'`,
  )
    .bind(context.requestId)
    .run();
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
  let quotaMayBeAcquired = false;
  let quotaCompletionExhausted = false;
  let quotaReservationUnresolved = false;
  let completionTokens = 0;
  let completionCost = 0;
  let reservedTokens = 0;
  let reservedCost = 0;
  try {
    ensureNoAttributionOverride(request);
    const authentication = await authenticateRequest(request, env);
    const { policy, tokenCapabilities } = authentication;
    const quotaScope = authentication.quotaScope;
    context.policy = policy;
    context.quotaScope = quotaScope;
    if (authentication.classroom) context.classroom = authentication.classroom;
    if (authentication.classroomLimits)
      context.classroomLimits = authentication.classroomLimits;
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
    let preparedProvider: PreparedProvider;
    try {
      preparedProvider = prepareProvider({
        route,
        deploymentEnvironment: env.DEPLOYMENT_ENV,
        getSecret: (binding) =>
          typeof env[binding] === "string" ? env[binding] : undefined,
      });
    } catch (error) {
      if (error instanceof ProviderError) {
        throw new HttpError(
          503,
          "provider_unavailable",
          "capability route is unavailable",
        );
      }
      throw error;
    }
    await acquireIdempotency(request, env, context);

    // Classroom settlement must never exceed its reservation, otherwise
    // concurrent requests could each settle above the shared class cap. Reserve
    // the configured input ceiling (the envelope images already use) so the
    // provider-reported input can only settle at or below it. Legacy traffic
    // keeps its existing estimate-based reservation.
    const reservedInputTokens =
      inspection.hasImages || context.classroom !== undefined
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
    quotaMayBeAcquired = true;
    const quotaResponse = await quotaCallWithRetry(
      env,
      quotaScope,
      quotaAcquireBody(context, {
        reservationTtlSeconds: Math.ceil(route.timeoutMs / 1000) + 30,
        estimatedTokens: reservedTokens,
        reservedCostMicrocents: reservedCost,
      }),
    ).catch(() => undefined);
    if (!quotaResponse?.ok) {
      if (!quotaResponse || quotaResponse.status >= 500) {
        throw new HttpError(
          503,
          "internal_error",
          "quota accounting admission failed",
        );
      }
      quotaMayBeAcquired = false;
      const reason = (await quotaResponse.json<{ reason?: string }>()).reason;
      const budget = isBudgetDenial(reason);
      throw new HttpError(
        budget ? 402 : 429,
        budget ? "budget_exceeded" : "rate_limit_exceeded",
        budget
          ? budgetDenialMessage(context, reason)
          : "rate or concurrency limit exceeded",
      );
    }
    if (!(await quotaAcquisitionSucceeded(quotaResponse))) {
      throw new HttpError(
        503,
        "internal_error",
        "quota accounting admission failed",
      );
    }

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
    try {
      const result = await callProvider({
        request: parsedRequest,
        prepared: preparedProvider,
        maxResponseBytes: Math.min(maxBody, 8_388_608),
        signal: controller.signal,
        // Cloudflare retains at most five entries. D1 supplies policy/route
        // provenance through the shared request ID.
        metadata: {
          request_id: context.requestId,
          product_id: policy.product_id,
          environment_id: policy.environment_id,
          tenant: context.tenantHash ?? "",
          principal: context.principalHash ?? "",
        },
        onDispatch: () => {
          context.providerAttempted = true;
          completionTokens = reservedTokens;
          completionCost = reservedCost;
        },
      });
      if (
        (result.usage.inputTokens !== undefined &&
          result.usage.inputTokens > aliasPolicy.max_input_tokens) ||
        (result.usage.outputTokens !== undefined &&
          result.usage.outputTokens > inspection.maxOutputTokens)
      ) {
        throw new ProviderError("provider_protocol", 502, result.latencyMs);
      }
      const inputTokens = result.usage.inputTokens ?? reservedInputTokens;
      const outputTokens =
        result.usage.outputTokens ?? inspection.maxOutputTokens;
      const actualCost =
        costMicrocents(
          inputTokens,
          aliasPolicy.input_cost_microcents_per_million,
        ) +
        costMicrocents(
          outputTokens,
          aliasPolicy.output_cost_microcents_per_million,
        );
      completionTokens = inputTokens + outputTokens;
      completionCost = actualCost;
      const completion = await quotaCallWithRetry(
        env,
        quotaScope,
        quotaCompleteBody(context, {
          actualTokens: completionTokens,
          actualCostMicrocents: completionCost,
        }),
      ).catch(() => undefined);
      if (!(await quotaCompletionSucceeded(completion))) {
        quotaCompletionExhausted = true;
        quotaReservationUnresolved = true;
        throw new HttpError(
          503,
          "internal_error",
          "quota accounting completion failed",
        );
      }
      quotaMayBeAcquired = false;
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
      const providerAttempted = context.providerAttempted;
      completionTokens = providerAttempted ? reservedTokens : 0;
      completionCost = providerAttempted ? reservedCost : 0;
      const completion = await quotaCallWithRetry(
        env,
        quotaScope,
        quotaCompleteBody(context, {
          actualTokens: completionTokens,
          actualCostMicrocents: completionCost,
        }),
      ).catch(() => undefined);
      if (!(await quotaCompletionSucceeded(completion))) {
        quotaCompletionExhausted = true;
        quotaReservationUnresolved = true;
        throw new HttpError(
          503,
          "internal_error",
          "quota accounting completion failed",
        );
      }
      quotaMayBeAcquired = false;
      if (providerAttempted) {
        await recordAttempt(env, context, {
          statusCode: error.status,
          errorClass: error.errorClass,
          latencyMs: error.latencyMs,
          inputTokens: reservedInputTokens,
          outputTokens: inspection.maxOutputTokens,
          costMicrocents: reservedCost,
        });
      } else {
        await discardAttemptIntent(env, context);
      }
      await finishIdempotency(request, env, context, "failed");
      const status = error.errorClass === "provider_timeout" ? 504 : 502;
      logSafeEvent(
        safeEvent(context, {
          status,
          errorClass: error.errorClass,
          ...(providerAttempted
            ? {
                inputTokens: reservedInputTokens,
                outputTokens: inspection.maxOutputTokens,
                costMicrocents: reservedCost,
              }
            : {}),
          attempts: providerAttempted ? 1 : 0,
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
    }
  } catch (error) {
    if (quotaMayBeAcquired && !quotaCompletionExhausted && context.quotaScope) {
      const completion = await quotaCallWithRetry(
        env,
        context.quotaScope,
        quotaCompleteBody(context, {
          actualTokens: completionTokens,
          actualCostMicrocents: completionCost,
        }),
      ).catch(() => undefined);
      if (await quotaCompletionSucceeded(completion))
        quotaMayBeAcquired = false;
      else quotaReservationUnresolved = true;
    }
    if (!context.providerAttempted && !quotaReservationUnresolved) {
      await discardAttemptIntent(env, context).catch(() => undefined);
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
          ...(quotaReservationUnresolved
            ? { quotaReservationState: "unresolved" as const }
            : {}),
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
        ...(quotaReservationUnresolved
          ? { quotaReservationState: "unresolved" as const }
          : {}),
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort("deadline"), 2000);
    try {
      const quota = env.QUOTA.get(env.QUOTA.idFromName("readiness-probe"));
      const [schema, quotaResponse] = await Promise.all([
        env.DB.prepare(
          `SELECT value,
                  (SELECT COUNT(*) FROM sqlite_schema
                    WHERE type = 'table'
                      AND name IN ('classroom_classes', 'classroom_groups', 'classroom_group_keys')) AS classroom_tables,
                  (SELECT COUNT(*) FROM pragma_table_info('access_codes')
                    WHERE name = 'classroom_group_id') AS access_code_classroom_group,
                  (SELECT COUNT(*) FROM pragma_table_info('provider_attempts')
                    WHERE name = 'classroom_group_id') AS attempt_classroom_group
             FROM schema_metadata WHERE key = 'schema_version'`,
        ).first<{
          value: string;
          classroom_tables: number;
          access_code_classroom_group: number;
          attempt_classroom_group: number;
        }>(),
        quota.fetch("https://quota.internal/healthz", {
          signal: controller.signal,
        }),
      ]);
      const quotaBody = quotaResponse.ok
        ? await quotaResponse.json<{
            status?: unknown;
            protocolVersion?: unknown;
          }>()
        : undefined;
      if (
        schema?.value !== DATABASE_SCHEMA_VERSION ||
        schema.classroom_tables !== 3 ||
        schema.access_code_classroom_group !== 1 ||
        schema.attempt_classroom_group !== 1 ||
        quotaBody?.status !== "ok" ||
        quotaBody.protocolVersion !== QUOTA_PROTOCOL_VERSION
      ) {
        throw new Error("readiness dependency is incompatible");
      }
    } catch {
      return errorResponse(500, "internal_error", "gateway is not ready");
    } finally {
      clearTimeout(timeout);
    }
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
