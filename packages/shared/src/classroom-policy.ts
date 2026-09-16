import { HttpError } from "./http";

/**
 * Classroom policy is the live authorization source for classroom traffic.
 *
 * Classes are product/environment/tenant scoped; groups are stable identities
 * that survive key rotation and device changes. This module is deliberately
 * free of request handling so the gateway hot path and the control-plane
 * activation precheck resolve exactly the same normalized policy.
 */

export const CLASSROOM_GROUP_KEY_PREFIX = "tkgk_";

const classroomGroupKeySchema = /^tkgk_[A-Za-z0-9_-]{16,128}$/u;

export function isClassroomGroupKey(value: string): boolean {
  return classroomGroupKeySchema.test(value);
}

export type ClassroomPolicy = {
  classId: string;
  groupId: string;
  productId: string;
  environmentId: string;
  tenantId: string;
  timezone: string;
  /** Approved aliases: group null inherits the class set, otherwise the intersection. */
  capabilities: string[];
  /** Class total lifetime cap shared across every group. */
  classBudgetMicrocents: number;
  /** Explicit lifetime allocation for this group. */
  groupBudgetMicrocents: number;
  /** Effective group daily budget: group override, else class default, else null. */
  dailyBudgetMicrocents: number | null;
  /** Effective limits: group override, else class default. */
  rpmLimit: number;
  tpmLimit: number;
  concurrencyLimit: number;
  /** Effective schedule: max(class, group) start, min(class, group) end. */
  startsAt: number;
  expiresAt: number;
};

export type ClassroomPolicyDatabase = Pick<D1Database, "prepare">;

type ClassroomPolicyRow = {
  group_id: string;
  class_id: string;
  group_status: string;
  group_capabilities_json: string | null;
  group_budget_microcents: number;
  group_daily_budget_microcents: number | null;
  group_rpm_limit: number | null;
  group_tpm_limit: number | null;
  group_concurrency_limit: number | null;
  group_starts_at: number | null;
  group_expires_at: number | null;
  product_id: string;
  environment_id: string;
  tenant_id: string;
  class_timezone: string;
  class_status: string;
  class_capabilities_json: string;
  class_budget_microcents: number;
  class_daily_budget_microcents: number | null;
  class_rpm_limit: number;
  class_tpm_limit: number;
  class_concurrency_limit: number;
  class_starts_at: number;
  class_expires_at: number;
};

function parseClassroomCapabilities(value: string, scope: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new HttpError(
      500,
      "internal_error",
      `stored classroom ${scope} policy is invalid`,
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string")
  ) {
    throw new HttpError(
      500,
      "internal_error",
      `stored classroom ${scope} policy is invalid`,
    );
  }
  return parsed;
}

function requireClassroomInteger(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(
      500,
      "internal_error",
      `stored classroom ${label} is invalid`,
    );
  }
  return value;
}

export function intersectClassroomCapabilities(
  policyCapabilities: string[],
  requested: string[],
): string[] {
  return requested.filter((capability) =>
    policyCapabilities.includes(capability),
  );
}

/**
 * Loads and normalizes live classroom policy for a group, or throws an
 * `HttpError`. Status, schedule, capabilities, limits, and budgets are all
 * enforced here so every caller fails closed on the same conditions.
 *
 * `enforceSchedule: false` still normalizes the policy but skips the
 * start/end window check, for callers that only need the tuple and policy
 * facts (for example a pre-activation check).
 */
export async function loadClassroomPolicy(
  db: ClassroomPolicyDatabase,
  groupId: string,
  now: number,
  options?: { enforceSchedule?: boolean },
): Promise<ClassroomPolicy> {
  const row = await db
    .prepare(
      `SELECT g.id AS group_id, g.class_id, g.status AS group_status,
              g.capabilities_json AS group_capabilities_json,
              g.budget_microcents AS group_budget_microcents,
              g.daily_budget_microcents AS group_daily_budget_microcents,
              g.rpm_limit AS group_rpm_limit, g.tpm_limit AS group_tpm_limit,
              g.concurrency_limit AS group_concurrency_limit,
              g.starts_at AS group_starts_at, g.expires_at AS group_expires_at,
              c.product_id, c.environment_id, c.tenant_id,
              c.timezone AS class_timezone, c.status AS class_status,
              c.capabilities_json AS class_capabilities_json,
              c.budget_microcents AS class_budget_microcents,
              c.daily_budget_microcents AS class_daily_budget_microcents,
              c.rpm_limit AS class_rpm_limit, c.tpm_limit AS class_tpm_limit,
              c.concurrency_limit AS class_concurrency_limit,
              c.starts_at AS class_starts_at, c.expires_at AS class_expires_at
         FROM classroom_groups g
         JOIN classroom_classes c ON c.id = g.class_id
        WHERE g.id = ?`,
    )
    .bind(groupId)
    .first<ClassroomPolicyRow>();
  if (!row)
    throw new HttpError(
      403,
      "authorization_failed",
      "classroom group is not available",
    );
  if (row.class_status !== "active" || row.group_status !== "active")
    throw new HttpError(403, "authorization_failed", "classroom is not active");
  const classStartsAt = requireClassroomInteger(
    row.class_starts_at,
    "class start",
  );
  const classExpiresAt = requireClassroomInteger(
    row.class_expires_at,
    "class expiry",
  );
  const groupStartsAt =
    row.group_starts_at === null
      ? classStartsAt
      : requireClassroomInteger(row.group_starts_at, "group start");
  const groupExpiresAt =
    row.group_expires_at === null
      ? classExpiresAt
      : requireClassroomInteger(row.group_expires_at, "group expiry");
  const startsAt = Math.max(classStartsAt, groupStartsAt);
  const expiresAt = Math.min(classExpiresAt, groupExpiresAt);
  if (
    options?.enforceSchedule !== false &&
    (now < startsAt || now >= expiresAt)
  )
    throw new HttpError(
      403,
      "authorization_failed",
      "classroom is outside its active schedule",
    );
  const classCapabilities = parseClassroomCapabilities(
    row.class_capabilities_json,
    "class",
  );
  const groupCapabilities =
    row.group_capabilities_json === null
      ? null
      : parseClassroomCapabilities(row.group_capabilities_json, "group");
  const capabilities =
    groupCapabilities === null
      ? classCapabilities
      : classCapabilities.filter((capability) =>
          groupCapabilities.includes(capability),
        );
  const classBudgetMicrocents = requireClassroomInteger(
    row.class_budget_microcents,
    "class budget",
  );
  const groupBudgetMicrocents = requireClassroomInteger(
    row.group_budget_microcents,
    "group budget",
  );
  const dailyBudgetMicrocents =
    row.group_daily_budget_microcents === null
      ? row.class_daily_budget_microcents === null
        ? null
        : requireClassroomInteger(
            row.class_daily_budget_microcents,
            "class daily budget",
          )
      : requireClassroomInteger(
          row.group_daily_budget_microcents,
          "group daily budget",
        );
  const rpmLimit = requireClassroomInteger(
    row.group_rpm_limit ?? row.class_rpm_limit,
    "rpm limit",
  );
  const tpmLimit = requireClassroomInteger(
    row.group_tpm_limit ?? row.class_tpm_limit,
    "tpm limit",
  );
  const concurrencyLimit = requireClassroomInteger(
    row.group_concurrency_limit ?? row.class_concurrency_limit,
    "concurrency limit",
  );
  return {
    classId: row.class_id,
    groupId: row.group_id,
    productId: row.product_id,
    environmentId: row.environment_id,
    tenantId: row.tenant_id,
    timezone: row.class_timezone,
    capabilities,
    classBudgetMicrocents,
    groupBudgetMicrocents,
    dailyBudgetMicrocents,
    rpmLimit,
    tpmLimit,
    concurrencyLimit,
    startsAt,
    expiresAt,
  };
}
