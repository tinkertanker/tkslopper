import {
  HttpError,
  accessCodeCreateSchema,
  activationSchema,
  aliasUpsertSchema,
  bearerToken,
  createOpaqueCredential,
  devIssueSchema,
  entitlementCreateSchema,
  environmentCreateSchema,
  errorResponse,
  hashCredential,
  jsonResponse,
  killSwitchSchema,
  parseOpaqueCredential,
  productCreateSchema,
  pseudonymize,
  randomId,
  randomSecret,
  readJsonBody,
  revokeSchema,
  serviceCredentialCreateSchema,
  sha256,
  signGrant,
  tokenExchangeSchema,
  verifyCredential,
  zodMessage,
  type GrantClaims,
} from "@tkslopper/shared";
import type { ZodType } from "zod";

export type ControlPlaneEnv = {
  DB: D1Database;
  TOKEN_SIGNING_SECRET: string;
  CREDENTIAL_PEPPER: string;
  ADMIN_TOKEN: string;
  TOKEN_ISSUER: string;
  DEPLOYMENT_ENV: string;
  ENABLE_DEV_ISSUER: string;
};

type EnvironmentRow = {
  product_id: string;
  environment_id: string;
  audience: string;
  token_ttl_seconds: number;
  product_enabled: number;
  product_kill_switch: number;
  environment_enabled: number;
  environment_kill_switch: number;
};

type EntitlementRow = {
  id: string;
  capabilities_json: string;
  expires_at: number | null;
};

type AccessEntitlementRow = EntitlementRow & {
  status: "active" | "revoked" | "expired";
};

type ServiceCredentialRow = EnvironmentRow & {
  id: string;
  tenant_id: string;
  principal_id: string;
  secret_salt: string;
  secret_hash: string;
  capabilities_json: string;
  disabled: number;
  expires_at: number | null;
};

type AccessCodeRow = EnvironmentRow & {
  id: string;
  tenant_id: string;
  secret_salt: string;
  secret_hash: string;
  capabilities_json: string;
  expires_at: number;
  max_activations: number;
  activation_count: number;
  max_failed_attempts: number;
  failed_attempts: number;
  disabled: number;
};

type ActivationRow = {
  id: string;
  principal_id: string;
  revoked_at: number | null;
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function ensureConfiguration(env: ControlPlaneEnv): void {
  let issuerIsValid = false;
  try {
    issuerIsValid = new URL(env.TOKEN_ISSUER).protocol === "https:";
  } catch {
    issuerIsValid = false;
  }
  if (
    typeof env.TOKEN_SIGNING_SECRET !== "string" ||
    env.TOKEN_SIGNING_SECRET.length < 32 ||
    typeof env.CREDENTIAL_PEPPER !== "string" ||
    env.CREDENTIAL_PEPPER.length < 32 ||
    typeof env.ADMIN_TOKEN !== "string" ||
    env.ADMIN_TOKEN.length < 32 ||
    !issuerIsValid ||
    (env.DEPLOYMENT_ENV === "production" && env.ENABLE_DEV_ISSUER === "true")
  ) {
    throw new HttpError(
      500,
      "internal_error",
      "control plane is not configured",
    );
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

function selectCapabilities(allowed: string[], requested?: string[]): string[] {
  if (requested === undefined) return allowed;
  if (!requested.every((capability) => allowed.includes(capability))) {
    throw new HttpError(
      403,
      "authorization_failed",
      "requested capability is not entitled",
    );
  }
  return requested;
}

function ensureEnvironmentEnabled(row: EnvironmentRow): void {
  if (
    row.product_enabled !== 1 ||
    row.product_kill_switch === 1 ||
    row.environment_enabled !== 1 ||
    row.environment_kill_switch === 1
  ) {
    throw new HttpError(
      403,
      "authorization_failed",
      "product environment is disabled",
    );
  }
}

async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readJsonBody(request, 65_536));
  if (!parsed.success)
    throw new HttpError(400, "invalid_request", zodMessage(parsed.error));
  return parsed.data;
}

async function requireAdmin(
  request: Request,
  env: ControlPlaneEnv,
): Promise<string> {
  const supplied = bearerToken(request);
  if (!supplied)
    throw new HttpError(
      401,
      "authentication_failed",
      "admin authentication failed",
    );
  const [suppliedHash, expectedHash] = await Promise.all([
    sha256(supplied),
    sha256(env.ADMIN_TOKEN),
  ]);
  if (suppliedHash !== expectedHash)
    throw new HttpError(
      401,
      "authentication_failed",
      "admin authentication failed",
    );
  return suppliedHash;
}

async function audit(
  env: ControlPlaneEnv,
  actorHash: string,
  action: string,
  resourceType: string,
  resourceId: string,
): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO admin_audit (id, action, resource_type, resource_id, actor_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(
      randomId("audit"),
      action,
      resourceType,
      resourceId,
      actorHash,
      nowSeconds(),
    )
    .run();
}

async function requireProductEnvironment(
  env: ControlPlaneEnv,
  productId: string,
  environmentId: string,
): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT 1 AS found FROM environments WHERE product_id = ? AND id = ?",
  )
    .bind(productId, environmentId)
    .first<{ found: number }>();
  if (!row)
    throw new HttpError(404, "not_found", "product environment not found");
}

async function findActiveEntitlement(
  env: ControlPlaneEnv,
  identity: {
    productId: string;
    environmentId: string;
    tenantId: string;
    principalId: string;
  },
  now: number,
): Promise<EntitlementRow | null> {
  return env.DB.prepare(
    `SELECT id, capabilities_json, expires_at
       FROM entitlements
      WHERE product_id = ? AND environment_id = ? AND tenant_id = ? AND principal_id = ?
        AND status = 'active'
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC LIMIT 1`,
  )
    .bind(
      identity.productId,
      identity.environmentId,
      identity.tenantId,
      identity.principalId,
      now,
    )
    .first<EntitlementRow>();
}

async function mintAndStoreGrant(
  env: ControlPlaneEnv,
  options: {
    productId: string;
    environmentId: string;
    tenantId: string;
    principalId: string;
    audience: string;
    capabilities: string[];
    tokenType: "service" | "direct_client" | "dev";
    ttlSeconds: number;
    entitlementId: string;
    entitlementExpiresAt: number | null;
  },
): Promise<{
  grant_id: string;
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  capabilities: string[];
}> {
  const now = nowSeconds();
  const expiration = Math.min(
    now + options.ttlSeconds,
    options.entitlementExpiresAt ?? Number.MAX_SAFE_INTEGER,
  );
  if (expiration <= now)
    throw new HttpError(403, "authorization_failed", "entitlement has expired");
  const jti = randomId("grant");
  const claims: GrantClaims = {
    iss: env.TOKEN_ISSUER,
    aud: options.audience,
    sub: options.principalId,
    iat: now,
    exp: expiration,
    jti,
    tks: {
      productId: options.productId,
      environmentId: options.environmentId,
      tenantId: options.tenantId,
      principalId: options.principalId,
      capabilities: options.capabilities,
      tokenType: options.tokenType,
    },
  };
  const token = await signGrant(claims, env.TOKEN_SIGNING_SECRET);
  const grantId = randomId("tgrant");
  await env.DB.prepare(
    `INSERT INTO token_grants
      (id, jti_hash, entitlement_id, product_id, environment_id, tenant_id, principal_id, audience,
       capabilities_json, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      grantId,
      await sha256(jti),
      options.entitlementId,
      options.productId,
      options.environmentId,
      options.tenantId,
      options.principalId,
      options.audience,
      JSON.stringify(options.capabilities),
      expiration,
      now,
    )
    .run();
  return {
    grant_id: grantId,
    access_token: token,
    token_type: "Bearer",
    expires_in: expiration - now,
    capabilities: options.capabilities,
  };
}

async function exchangeServiceCredential(
  request: Request,
  env: ControlPlaneEnv,
): Promise<Response> {
  const credentialValue = bearerToken(request);
  const parsedCredential = credentialValue
    ? parseOpaqueCredential(credentialValue, "service")
    : undefined;
  if (!parsedCredential)
    throw new HttpError(
      401,
      "authentication_failed",
      "credential authentication failed",
    );
  const body = await parseBody(request, tokenExchangeSchema);
  const row = await env.DB.prepare(
    `SELECT c.id, c.product_id, c.environment_id, c.tenant_id, c.principal_id, c.secret_salt, c.secret_hash,
            c.capabilities_json, c.disabled, c.expires_at, e.audience, e.token_ttl_seconds,
            p.enabled AS product_enabled, p.kill_switch AS product_kill_switch,
            e.enabled AS environment_enabled, e.kill_switch AS environment_kill_switch
       FROM service_credentials c
       JOIN products p ON p.id = c.product_id
       JOIN environments e ON e.id = c.environment_id AND e.product_id = c.product_id
      WHERE c.id = ?`,
  )
    .bind(parsedCredential.id)
    .first<ServiceCredentialRow>();
  const now = nowSeconds();
  if (
    !row ||
    row.disabled === 1 ||
    (row.expires_at !== null && row.expires_at <= now) ||
    !(await verifyCredential(
      parsedCredential.secret,
      row.secret_salt,
      env.CREDENTIAL_PEPPER,
      row.secret_hash,
    ))
  ) {
    throw new HttpError(
      401,
      "authentication_failed",
      "credential authentication failed",
    );
  }
  ensureEnvironmentEnabled(row);
  const entitlement = await findActiveEntitlement(
    env,
    {
      productId: row.product_id,
      environmentId: row.environment_id,
      tenantId: row.tenant_id,
      principalId: row.principal_id,
    },
    now,
  );
  if (!entitlement)
    throw new HttpError(403, "authorization_failed", "no active entitlement");
  const capabilities = selectCapabilities(
    parseCapabilities(entitlement.capabilities_json).filter((capability) =>
      parseCapabilities(row.capabilities_json).includes(capability),
    ),
    body.capabilities,
  );
  await env.DB.prepare(
    "UPDATE service_credentials SET last_used_at = ? WHERE id = ?",
  )
    .bind(now, row.id)
    .run();
  return jsonResponse(
    await mintAndStoreGrant(env, {
      productId: row.product_id,
      environmentId: row.environment_id,
      tenantId: row.tenant_id,
      principalId: row.principal_id,
      audience: row.audience,
      capabilities,
      tokenType: "service",
      ttlSeconds: Math.min(
        body.ttl_seconds ?? row.token_ttl_seconds,
        row.token_ttl_seconds,
      ),
      entitlementId: entitlement.id,
      entitlementExpiresAt: entitlement.expires_at,
    }),
  );
}

async function activateAccessCode(
  request: Request,
  env: ControlPlaneEnv,
): Promise<Response> {
  const body = await parseBody(request, activationSchema);
  const parsedCredential = parseOpaqueCredential(
    body.access_code,
    "access_code",
  );
  if (!parsedCredential)
    throw new HttpError(
      401,
      "authentication_failed",
      "access code authentication failed",
    );
  const row = await env.DB.prepare(
    `SELECT c.id, c.product_id, c.environment_id, c.tenant_id, c.secret_salt, c.secret_hash,
            c.capabilities_json, c.disabled, c.expires_at, c.max_activations, c.activation_count,
            c.max_failed_attempts, c.failed_attempts, e.audience, e.token_ttl_seconds,
            p.enabled AS product_enabled, p.kill_switch AS product_kill_switch,
            e.enabled AS environment_enabled, e.kill_switch AS environment_kill_switch
       FROM access_codes c
       JOIN products p ON p.id = c.product_id
       JOIN environments e ON e.id = c.environment_id AND e.product_id = c.product_id
      WHERE c.id = ?`,
  )
    .bind(parsedCredential.id)
    .first<AccessCodeRow>();
  const now = nowSeconds();
  if (
    !row ||
    row.disabled === 1 ||
    row.expires_at <= now ||
    row.failed_attempts >= row.max_failed_attempts
  ) {
    throw new HttpError(
      401,
      "authentication_failed",
      "access code authentication failed",
    );
  }
  if (
    !(await verifyCredential(
      parsedCredential.secret,
      row.secret_salt,
      env.CREDENTIAL_PEPPER,
      row.secret_hash,
    ))
  ) {
    await env.DB.prepare(
      "UPDATE access_codes SET failed_attempts = failed_attempts + 1, updated_at = ? WHERE id = ? AND failed_attempts < max_failed_attempts",
    )
      .bind(now, row.id)
      .run();
    throw new HttpError(
      401,
      "authentication_failed",
      "access code authentication failed",
    );
  }
  ensureEnvironmentEnabled(row);
  const allowedCapabilities = parseCapabilities(row.capabilities_json);
  const capabilities = selectCapabilities(
    allowedCapabilities,
    body.capabilities,
  );
  const deviceHash = await pseudonymize(body.device_id, env.CREDENTIAL_PEPPER);
  let activation = await env.DB.prepare(
    "SELECT id, principal_id, revoked_at FROM activations WHERE access_code_id = ? AND device_hash = ?",
  )
    .bind(row.id, deviceHash)
    .first<ActivationRow>();
  if (activation?.revoked_at)
    throw new HttpError(403, "authorization_failed", "activation is revoked");
  if (!activation) {
    const activationId = randomId("activation");
    const principalId = `device:${deviceHash.slice(0, 43)}`;
    const entitlementId = randomId("ent");
    const results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE access_codes
            SET activation_count = activation_count + 1, failed_attempts = 0, updated_at = ?
          WHERE id = ? AND disabled = 0 AND expires_at > ? AND activation_count < max_activations
            AND NOT EXISTS (SELECT 1 FROM activations WHERE access_code_id = ? AND device_hash = ?)`,
      ).bind(now, row.id, now, row.id, deviceHash),
      env.DB.prepare(
        `INSERT OR IGNORE INTO activations
          (id, access_code_id, tenant_id, principal_id, device_hash, activated_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
      ).bind(activationId, row.id, row.tenant_id, principalId, deviceHash, now),
      env.DB.prepare(
        `INSERT OR IGNORE INTO entitlements
          (id, product_id, environment_id, tenant_id, principal_id, source, source_ref,
           capabilities_json, status, expires_at, created_at, updated_at)
         SELECT ?, c.product_id, c.environment_id, c.tenant_id, ?, 'access_code', c.id,
                ?, 'active', c.expires_at, ?, ?
           FROM access_codes c
           JOIN activations a ON a.access_code_id = c.id
          WHERE c.id = ? AND c.disabled = 0 AND c.expires_at > ?
            AND a.id = ? AND a.revoked_at IS NULL`,
      ).bind(
        entitlementId,
        principalId,
        JSON.stringify(allowedCapabilities),
        now,
        now,
        row.id,
        now,
        activationId,
      ),
    ]);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[1]?.meta.changes ?? 0) !== 1
    ) {
      activation = await env.DB.prepare(
        "SELECT id, principal_id, revoked_at FROM activations WHERE access_code_id = ? AND device_hash = ?",
      )
        .bind(row.id, deviceHash)
        .first<ActivationRow>();
      if (!activation)
        throw new HttpError(
          403,
          "authorization_failed",
          "access code activation limit reached",
        );
    } else {
      activation = {
        id: activationId,
        principal_id: principalId,
        revoked_at: null,
      };
    }
  }
  const entitlement = await env.DB.prepare(
    `SELECT id, capabilities_json, status, expires_at
       FROM entitlements
      WHERE source = 'access_code' AND source_ref = ? AND product_id = ? AND environment_id = ?
        AND tenant_id = ? AND principal_id = ?`,
  )
    .bind(
      row.id,
      row.product_id,
      row.environment_id,
      row.tenant_id,
      activation.principal_id,
    )
    .first<AccessEntitlementRow>();
  if (
    !entitlement ||
    entitlement.status !== "active" ||
    (entitlement.expires_at !== null && entitlement.expires_at <= now)
  ) {
    throw new HttpError(
      403,
      "authorization_failed",
      "entitlement is not active",
    );
  }
  return jsonResponse(
    await mintAndStoreGrant(env, {
      productId: row.product_id,
      environmentId: row.environment_id,
      tenantId: row.tenant_id,
      principalId: activation.principal_id,
      audience: row.audience,
      capabilities,
      tokenType: "direct_client",
      ttlSeconds: Math.min(
        body.ttl_seconds ?? row.token_ttl_seconds,
        row.token_ttl_seconds,
      ),
      entitlementId: entitlement.id,
      entitlementExpiresAt: entitlement.expires_at,
    }),
  );
}

async function adminCreateProduct(
  request: Request,
  env: ControlPlaneEnv,
  actorHash: string,
): Promise<Response> {
  const body = await parseBody(request, productCreateSchema);
  const id = randomId("prod");
  const now = nowSeconds();
  await env.DB.prepare(
    "INSERT INTO products (id, slug, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
  )
    .bind(id, body.slug, body.display_name, now, now)
    .run();
  await audit(env, actorHash, "create", "product", id);
  return jsonResponse({ id, ...body }, 201);
}

async function adminCreateEnvironment(
  request: Request,
  env: ControlPlaneEnv,
  actorHash: string,
): Promise<Response> {
  const body = await parseBody(request, environmentCreateSchema);
  const id = randomId("env");
  const now = nowSeconds();
  await env.DB.prepare(
    `INSERT INTO environments
      (id, product_id, name, audience, token_ttl_seconds, rpm_limit, tpm_limit, concurrency_limit,
       daily_budget_microcents, max_request_bytes, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      body.product_id,
      body.name,
      body.audience,
      body.token_ttl_seconds,
      body.rpm_limit,
      body.tpm_limit,
      body.concurrency_limit,
      body.daily_budget_microcents,
      body.max_request_bytes,
      now,
      now,
    )
    .run();
  await audit(env, actorHash, "create", "environment", id);
  return jsonResponse({ id, ...body }, 201);
}

async function adminUpsertAlias(
  request: Request,
  env: ControlPlaneEnv,
  actorHash: string,
): Promise<Response> {
  const body = await parseBody(request, aliasUpsertSchema);
  await requireProductEnvironment(env, body.product_id, body.environment_id);
  const id = randomId("alias");
  const now = nowSeconds();
  await env.DB.prepare(
    `INSERT INTO aliases
      (id, product_id, environment_id, alias, endpoint, route_id, allow_reasoning, allow_images,
       allow_structured_json, max_input_tokens, max_output_tokens, input_cost_microcents_per_million,
       output_cost_microcents_per_million, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(environment_id, alias, endpoint) DO UPDATE SET
       route_id = excluded.route_id,
       allow_reasoning = excluded.allow_reasoning,
       allow_images = excluded.allow_images,
       allow_structured_json = excluded.allow_structured_json,
       max_input_tokens = excluded.max_input_tokens,
       max_output_tokens = excluded.max_output_tokens,
       input_cost_microcents_per_million = excluded.input_cost_microcents_per_million,
       output_cost_microcents_per_million = excluded.output_cost_microcents_per_million,
       policy_version = aliases.policy_version + 1,
       enabled = 1,
       updated_at = excluded.updated_at`,
  )
    .bind(
      id,
      body.product_id,
      body.environment_id,
      body.alias,
      body.endpoint,
      body.route_id,
      Number(body.allow_reasoning),
      Number(body.allow_images),
      Number(body.allow_structured_json),
      body.max_input_tokens,
      body.max_output_tokens,
      body.input_cost_microcents_per_million,
      body.output_cost_microcents_per_million,
      now,
      now,
    )
    .run();
  await audit(
    env,
    actorHash,
    "upsert",
    "alias",
    `${body.environment_id}:${body.endpoint}:${body.alias}`,
  );
  return jsonResponse(body);
}

async function adminCreateEntitlement(
  request: Request,
  env: ControlPlaneEnv,
  actorHash: string,
): Promise<Response> {
  const body = await parseBody(request, entitlementCreateSchema);
  await requireProductEnvironment(env, body.product_id, body.environment_id);
  const id = randomId("ent");
  const now = nowSeconds();
  await env.DB.prepare(
    `INSERT INTO entitlements
      (id, product_id, environment_id, tenant_id, principal_id, source, capabilities_json, status,
       expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
  )
    .bind(
      id,
      body.product_id,
      body.environment_id,
      body.tenant_id,
      body.principal_id,
      body.source,
      JSON.stringify(body.capabilities),
      body.expires_at,
      now,
      now,
    )
    .run();
  await audit(env, actorHash, "create", "entitlement", id);
  return jsonResponse({ id, ...body, status: "active" }, 201);
}

async function adminCreateServiceCredential(
  request: Request,
  env: ControlPlaneEnv,
  actorHash: string,
): Promise<Response> {
  const body = await parseBody(request, serviceCredentialCreateSchema);
  await requireProductEnvironment(env, body.product_id, body.environment_id);
  const credential = createOpaqueCredential("service");
  const salt = randomSecret(16);
  const now = nowSeconds();
  const entitlementId = randomId("ent");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO service_credentials
        (id, product_id, environment_id, tenant_id, principal_id, secret_salt, secret_hash,
         capabilities_json, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      credential.id,
      body.product_id,
      body.environment_id,
      body.tenant_id,
      body.principal_id,
      salt,
      await hashCredential(credential.secret, salt, env.CREDENTIAL_PEPPER),
      JSON.stringify(body.capabilities),
      body.expires_at,
      now,
    ),
    env.DB.prepare(
      `INSERT INTO entitlements
        (id, product_id, environment_id, tenant_id, principal_id, source, source_ref, capabilities_json,
         status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'service', ?, ?, 'active', ?, ?, ?)`,
    ).bind(
      entitlementId,
      body.product_id,
      body.environment_id,
      body.tenant_id,
      body.principal_id,
      credential.id,
      JSON.stringify(body.capabilities),
      body.expires_at,
      now,
      now,
    ),
  ]);
  await audit(env, actorHash, "create", "service_credential", credential.id);
  return jsonResponse(
    {
      id: credential.id,
      credential: credential.value,
      entitlement_id: entitlementId,
      warning: "shown once",
    },
    201,
  );
}

async function adminCreateAccessCode(
  request: Request,
  env: ControlPlaneEnv,
  actorHash: string,
): Promise<Response> {
  const body = await parseBody(request, accessCodeCreateSchema);
  await requireProductEnvironment(env, body.product_id, body.environment_id);
  const credential = createOpaqueCredential("access_code");
  const salt = randomSecret(16);
  const now = nowSeconds();
  await env.DB.prepare(
    `INSERT INTO access_codes
      (id, product_id, environment_id, tenant_id, secret_salt, secret_hash, capabilities_json,
       expires_at, max_activations, max_failed_attempts, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      credential.id,
      body.product_id,
      body.environment_id,
      body.tenant_id,
      salt,
      await hashCredential(credential.secret, salt, env.CREDENTIAL_PEPPER),
      JSON.stringify(body.capabilities),
      body.expires_at,
      body.max_activations,
      body.max_failed_attempts,
      now,
      now,
    )
    .run();
  await audit(env, actorHash, "create", "access_code", credential.id);
  return jsonResponse(
    { id: credential.id, access_code: credential.value, warning: "shown once" },
    201,
  );
}

async function adminRevoke(
  request: Request,
  env: ControlPlaneEnv,
  actorHash: string,
): Promise<Response> {
  const body = await parseBody(request, revokeSchema);
  const now = nowSeconds();
  let changes = 0;
  if (body.resource_type === "token_grant") {
    const result = await env.DB.prepare(
      "UPDATE token_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    )
      .bind(now, body.resource_id)
      .run();
    changes = result.meta.changes ?? 0;
  } else if (body.resource_type === "entitlement") {
    const result = await env.DB.prepare(
      `UPDATE entitlements SET status = 'revoked', updated_at = ? WHERE id = ? AND status = 'active'`,
    )
      .bind(now, body.resource_id)
      .run();
    changes = result.meta.changes ?? 0;
  } else if (body.resource_type === "access_code") {
    const results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE access_codes SET disabled = 1, updated_at = ? WHERE id = ? AND disabled = 0",
      ).bind(now, body.resource_id),
      env.DB.prepare(
        "UPDATE activations SET revoked_at = ? WHERE access_code_id = ? AND revoked_at IS NULL",
      ).bind(now, body.resource_id),
      env.DB.prepare(
        `UPDATE entitlements SET status = 'revoked', updated_at = ?
          WHERE source = 'access_code' AND source_ref = ? AND status = 'active'`,
      ).bind(now, body.resource_id),
    ]);
    changes = results[0]?.meta.changes ?? 0;
  } else {
    const results = await env.DB.batch([
      env.DB.prepare(
        "UPDATE service_credentials SET disabled = 1 WHERE id = ? AND disabled = 0",
      ).bind(body.resource_id),
      env.DB.prepare(
        `UPDATE entitlements SET status = 'revoked', updated_at = ?
          WHERE source = 'service' AND source_ref = ? AND status = 'active'`,
      ).bind(now, body.resource_id),
    ]);
    changes = results[0]?.meta.changes ?? 0;
  }
  if (changes === 0)
    throw new HttpError(404, "not_found", "active resource not found");
  await audit(env, actorHash, "revoke", body.resource_type, body.resource_id);
  return jsonResponse({ revoked: true, ...body });
}

async function adminKillSwitch(
  request: Request,
  env: ControlPlaneEnv,
  actorHash: string,
): Promise<Response> {
  const body = await parseBody(request, killSwitchSchema);
  const table = body.resource_type === "product" ? "products" : "environments";
  const result = await env.DB.prepare(
    `UPDATE ${table} SET kill_switch = ?, updated_at = ? WHERE id = ?`,
  )
    .bind(Number(body.enabled), nowSeconds(), body.resource_id)
    .run();
  if ((result.meta.changes ?? 0) === 0)
    throw new HttpError(404, "not_found", "resource not found");
  await audit(
    env,
    actorHash,
    body.enabled ? "kill" : "restore",
    body.resource_type,
    body.resource_id,
  );
  return jsonResponse(body);
}

async function adminDevIssue(
  request: Request,
  env: ControlPlaneEnv,
  actorHash: string,
): Promise<Response> {
  if (env.DEPLOYMENT_ENV === "production" || env.ENABLE_DEV_ISSUER !== "true") {
    throw new HttpError(404, "not_found", "not found");
  }
  const body = await parseBody(request, devIssueSchema);
  const row = await env.DB.prepare(
    `SELECT p.id AS product_id, e.id AS environment_id, e.audience, e.token_ttl_seconds,
            p.enabled AS product_enabled, p.kill_switch AS product_kill_switch,
            e.enabled AS environment_enabled, e.kill_switch AS environment_kill_switch
       FROM products p JOIN environments e ON e.product_id = p.id
      WHERE p.id = ? AND e.id = ?`,
  )
    .bind(body.product_id, body.environment_id)
    .first<EnvironmentRow>();
  if (!row)
    throw new HttpError(404, "not_found", "product environment not found");
  ensureEnvironmentEnabled(row);
  const now = nowSeconds();
  const ttlSeconds = body.ttl_seconds ?? 900;
  const entitlementId = randomId("ent");
  await env.DB.prepare(
    `INSERT INTO entitlements
      (id, product_id, environment_id, tenant_id, principal_id, source, capabilities_json, status,
       expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'dev', ?, 'active', ?, ?, ?)`,
  )
    .bind(
      entitlementId,
      body.product_id,
      body.environment_id,
      body.tenant_id,
      body.principal_id,
      JSON.stringify(body.capabilities),
      now + ttlSeconds,
      now,
      now,
    )
    .run();
  await audit(env, actorHash, "dev_issue", "entitlement", entitlementId);
  return jsonResponse(
    await mintAndStoreGrant(env, {
      productId: body.product_id,
      environmentId: body.environment_id,
      tenantId: body.tenant_id,
      principalId: body.principal_id,
      audience: row.audience,
      capabilities: body.capabilities,
      tokenType: "dev",
      ttlSeconds: Math.min(ttlSeconds, row.token_ttl_seconds),
      entitlementId,
      entitlementExpiresAt: now + ttlSeconds,
    }),
  );
}

export async function handleControlPlane(
  request: Request,
  env: ControlPlaneEnv,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    ensureConfiguration(env);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return jsonResponse({ status: "ok", component: "control-plane" });
    }
    if (request.method === "POST" && url.pathname === "/v1/token") {
      return await exchangeServiceCredential(request, env);
    }
    if (request.method === "POST" && url.pathname === "/v1/activations") {
      return await activateAccessCode(request, env);
    }
    if (request.method === "POST" && url.pathname.startsWith("/admin/v1/")) {
      const actorHash = await requireAdmin(request, env);
      switch (url.pathname) {
        case "/admin/v1/products":
          return await adminCreateProduct(request, env, actorHash);
        case "/admin/v1/environments":
          return await adminCreateEnvironment(request, env, actorHash);
        case "/admin/v1/aliases":
          return await adminUpsertAlias(request, env, actorHash);
        case "/admin/v1/entitlements":
          return await adminCreateEntitlement(request, env, actorHash);
        case "/admin/v1/service-credentials":
          return await adminCreateServiceCredential(request, env, actorHash);
        case "/admin/v1/access-codes":
          return await adminCreateAccessCode(request, env, actorHash);
        case "/admin/v1/revoke":
          return await adminRevoke(request, env, actorHash);
        case "/admin/v1/kill-switch":
          return await adminKillSwitch(request, env, actorHash);
        case "/admin/v1/dev/issue":
          return await adminDevIssue(request, env, actorHash);
        default:
          throw new HttpError(404, "not_found", "not found");
      }
    }
    throw new HttpError(404, "not_found", "not found");
  } catch (error) {
    if (error instanceof HttpError)
      return errorResponse(error.status, error.code, error.message);
    return errorResponse(500, "internal_error", "control plane request failed");
  }
}

export default {
  fetch: handleControlPlane,
} satisfies ExportedHandler<ControlPlaneEnv>;
