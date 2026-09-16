import { HttpError, bearerToken, sha256 } from "@tkslopper/shared";

import {
  isClassroomGroupKey,
  loadClassroomPolicy,
} from "../../../packages/shared/src/classroom-policy";

/**
 * Gateway-side classroom authorization.
 *
 * A direct group key is verified against its stored SHA-256 digest and then
 * resolved through the same live policy helper the control plane uses. An
 * activated JWT grant instead resolves its access code's classroom group in
 * D1, so class/group pause, revocation, schedule, and capability narrowing
 * apply to already-issued grants on every request.
 */

export type ClassroomGatewayEnv = { DB: D1Database };

/** The subset of stored policy the inference hot path needs. */
export type RequestPolicy = {
  product_id: string;
  environment_id: string;
  tenant_id: string;
  principal_id: string;
  rpm_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  daily_budget_microcents: number;
  max_request_bytes: number;
};

export type ClassroomLimits = {
  classBudgetMicrocents: number;
  groupBudgetMicrocents: number;
  dailyBudgetMicrocents: number | null;
  rpm: number;
  tpm: number;
  concurrency: number;
};

export type ClassroomAuthorization = {
  policy: RequestPolicy;
  /** Approved aliases after class/group intersection. */
  capabilities: string[];
  limits: ClassroomLimits;
  quotaScope: string;
  classroom: { classId: string; groupId: string };
};

export type ClassroomKeyAuthentication = {
  policy: RequestPolicy;
  tokenCapabilities: string[];
  quotaScope: string;
  classroom: { classId: string; groupId: string };
  classroomLimits: ClassroomLimits;
  keyId: string;
};

type ClassroomEnvironmentRow = {
  rpm_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  daily_budget_microcents: number;
  max_request_bytes: number;
  product_enabled: number;
  product_kill_switch: number;
  environment_enabled: number;
  environment_kill_switch: number;
};

type ClassroomGroupKeyRow = {
  id: string;
  group_id: string;
  expires_at: number | null;
  revoked_at: number | null;
};

/**
 * One accounting scope per class. Every group, key, and activated device of a
 * class resolves to the same Durable Object so the class lifetime cap and each
 * group's limits are admitted in a single transaction.
 */
export function classroomQuotaScope(
  productId: string,
  environmentId: string,
  classId: string,
): string {
  return JSON.stringify(["classroom", productId, environmentId, classId]);
}

async function resolveClassroomAuthorization(
  env: ClassroomGatewayEnv,
  options: {
    groupId: string;
    principalId: string;
    now: number;
    expected?: {
      productId: string;
      environmentId: string;
      tenantId: string;
    };
  },
): Promise<ClassroomAuthorization> {
  const classroom = await loadClassroomPolicy(
    env.DB,
    options.groupId,
    options.now,
  );
  const expected = options.expected;
  if (
    expected &&
    (classroom.productId !== expected.productId ||
      classroom.environmentId !== expected.environmentId ||
      classroom.tenantId !== expected.tenantId)
  ) {
    throw new HttpError(
      403,
      "authorization_failed",
      "classroom identity mismatch",
    );
  }
  const environment = await env.DB.prepare(
    `SELECT e.rpm_limit, e.tpm_limit, e.concurrency_limit, e.daily_budget_microcents,
            e.max_request_bytes, p.enabled AS product_enabled, p.kill_switch AS product_kill_switch,
            e.enabled AS environment_enabled, e.kill_switch AS environment_kill_switch
       FROM environments e
       JOIN products p ON p.id = e.product_id
      WHERE e.product_id = ? AND e.id = ?`,
  )
    .bind(classroom.productId, classroom.environmentId)
    .first<ClassroomEnvironmentRow>();
  if (
    !environment ||
    environment.product_enabled !== 1 ||
    environment.product_kill_switch === 1 ||
    environment.environment_enabled !== 1 ||
    environment.environment_kill_switch === 1
  ) {
    throw new HttpError(
      403,
      "authorization_failed",
      "product environment is disabled",
    );
  }
  const dailyBudgetMicrocents =
    classroom.dailyBudgetMicrocents === null
      ? environment.daily_budget_microcents
      : Math.min(
          classroom.dailyBudgetMicrocents,
          environment.daily_budget_microcents,
        );
  const limits: ClassroomLimits = {
    classBudgetMicrocents: classroom.classBudgetMicrocents,
    groupBudgetMicrocents: classroom.groupBudgetMicrocents,
    dailyBudgetMicrocents,
    rpm: Math.min(environment.rpm_limit, classroom.rpmLimit),
    tpm: Math.min(environment.tpm_limit, classroom.tpmLimit),
    concurrency: Math.min(
      environment.concurrency_limit,
      classroom.concurrencyLimit,
    ),
  };
  const policy: RequestPolicy = {
    product_id: classroom.productId,
    environment_id: classroom.environmentId,
    tenant_id: classroom.tenantId,
    principal_id: options.principalId,
    rpm_limit: limits.rpm,
    tpm_limit: limits.tpm,
    concurrency_limit: limits.concurrency,
    daily_budget_microcents: dailyBudgetMicrocents,
    max_request_bytes: environment.max_request_bytes,
  };
  return {
    policy,
    capabilities: classroom.capabilities,
    limits,
    quotaScope: classroomQuotaScope(
      classroom.productId,
      classroom.environmentId,
      classroom.classId,
    ),
    classroom: { classId: classroom.classId, groupId: classroom.groupId },
  };
}

/**
 * Resolves a classroom-linked JWT grant. The caller supplies the grant's
 * identity tuple; a class or group that disagrees fails closed so a code from
 * one tenant can never reach another tenant's classroom.
 */
export async function resolveClassroomGrantAuthorization(
  env: ClassroomGatewayEnv,
  options: {
    groupId: string;
    principalId: string;
    expected: { productId: string; environmentId: string; tenantId: string };
    now: number;
  },
): Promise<ClassroomAuthorization> {
  return await resolveClassroomAuthorization(env, options);
}

export async function authenticateClassroomKey(
  request: Request,
  env: ClassroomGatewayEnv,
  now: number,
): Promise<ClassroomKeyAuthentication> {
  const rawToken = bearerToken(request);
  if (!rawToken || !isClassroomGroupKey(rawToken))
    throw new HttpError(
      401,
      "authentication_failed",
      "group key authentication failed",
    );
  const secretHash = await sha256(rawToken);
  const key = await env.DB.prepare(
    `SELECT id, group_id, expires_at, revoked_at
       FROM classroom_group_keys
      WHERE secret_hash = ?`,
  )
    .bind(secretHash)
    .first<ClassroomGroupKeyRow>();
  if (!key)
    throw new HttpError(
      401,
      "authentication_failed",
      "group key authentication failed",
    );
  if (key.revoked_at !== null)
    throw new HttpError(
      403,
      "authorization_failed",
      "classroom group key is revoked",
    );
  if (key.expires_at !== null && key.expires_at <= now)
    throw new HttpError(
      403,
      "authorization_failed",
      "classroom group key has expired",
    );
  const authorization = await resolveClassroomAuthorization(env, {
    groupId: key.group_id,
    // Direct keys have no device identity: the group is the principal.
    principalId: key.group_id,
    now,
  });
  return {
    policy: authorization.policy,
    tokenCapabilities: authorization.capabilities,
    quotaScope: authorization.quotaScope,
    classroom: authorization.classroom,
    classroomLimits: authorization.limits,
    keyId: key.id,
  };
}

export { isClassroomGroupKey };
