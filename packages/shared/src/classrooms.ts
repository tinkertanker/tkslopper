import { z } from "zod";
import { HttpError } from "./http";
import { capabilitiesSchema, identifierSchema } from "./schemas";

/**
 * Classroom validation, wire types, and row decoding shared by the control
 * plane and its clients. Classes are product/environment/tenant scoped
 * entities; groups are the permanent quota scope that keys and codes attach to.
 */

export const CLASSROOM_MICROCENTS_MAX = 1_000_000_000_000_000;
export const CLASSROOM_CLASS_LIST_LIMIT = 200;
export const CLASSROOM_GROUP_LIST_LIMIT = 500;
export const CLASSROOM_GROUP_BULK_LIMIT = 100;
export const CLASSROOM_USAGE_GROUP_LIMIT = 500;
export const CLASSROOM_DEFAULT_MAX_ACTIVATIONS = 30;
export const CLASSROOM_MAX_ACTIVATIONS_MAX = 100_000;

const classroomNameSchema = z.string().trim().min(1).max(200);
const classroomTimestampSchema = z.number().int().safe().min(0);
const microcentsSchema = z
  .number()
  .int()
  .safe()
  .min(0)
  .max(CLASSROOM_MICROCENTS_MAX);
const nullableMicrocentsSchema = microcentsSchema.nullable();
const rpmLimitSchema = z.number().int().safe().min(1).max(1_000_000);
const tpmLimitSchema = z.number().int().safe().min(1).max(1_000_000_000);
const concurrencyLimitSchema = z.number().int().safe().min(1).max(10_000);
const maxActivationsSchema = z
  .number()
  .int()
  .safe()
  .min(1)
  .max(CLASSROOM_MAX_ACTIVATIONS_MAX);
const instructorsSchema = z
  .array(z.string().trim().min(1).max(200))
  .max(50)
  .transform((values) => [...new Set(values)]);

export function isIanaTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const timeZoneSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine(isIanaTimeZone, "timezone must be a valid IANA time zone");

export const classroomStatusSchema = z.enum(["active", "paused", "revoked"]);
export const classroomGroupStatusSchema = z.enum(["active", "revoked"]);
export const classroomAccessKindSchema = z.enum(["api_key", "join_code"]);

export const classroomClassCreateSchema = z
  .object({
    product_id: identifierSchema,
    environment_id: identifierSchema,
    tenant_id: identifierSchema,
    name: classroomNameSchema,
    course: z.string().trim().max(200).default(""),
    instructors: instructorsSchema.default([]),
    timezone: timeZoneSchema,
    starts_at: classroomTimestampSchema,
    expires_at: classroomTimestampSchema,
    capabilities: capabilitiesSchema,
    budget_microcents: microcentsSchema,
    group_budget_microcents: microcentsSchema,
    daily_budget_microcents: nullableMicrocentsSchema.default(null),
    rpm_limit: rpmLimitSchema,
    tpm_limit: tpmLimitSchema,
    concurrency_limit: concurrencyLimitSchema,
  })
  .strict();

export const classroomClassUpdateSchema = z
  .object({
    id: identifierSchema,
    name: classroomNameSchema.optional(),
    course: z.string().trim().max(200).optional(),
    instructors: instructorsSchema.optional(),
    timezone: timeZoneSchema.optional(),
    starts_at: classroomTimestampSchema.optional(),
    expires_at: classroomTimestampSchema.optional(),
    capabilities: capabilitiesSchema.optional(),
    budget_microcents: microcentsSchema.optional(),
    group_budget_microcents: microcentsSchema.optional(),
    daily_budget_microcents: nullableMicrocentsSchema.optional(),
    rpm_limit: rpmLimitSchema.optional(),
    tpm_limit: tpmLimitSchema.optional(),
    concurrency_limit: concurrencyLimitSchema.optional(),
    status: classroomStatusSchema.optional(),
  })
  .strict();

export const classroomClassDuplicateSchema = z
  .object({
    id: identifierSchema,
    name: classroomNameSchema,
    starts_at: classroomTimestampSchema,
    expires_at: classroomTimestampSchema,
  })
  .strict();

export const classroomClassListSchema = z.object({}).strict();

export const classroomClassUsageSchema = z
  .object({ class_id: identifierSchema })
  .strict();

export const classroomGroupCreateSchema = z
  .object({
    class_id: identifierSchema,
    names: z.array(classroomNameSchema).min(1).max(CLASSROOM_GROUP_BULK_LIMIT),
  })
  .strict();

export const classroomGroupListSchema = z
  .object({ class_id: identifierSchema })
  .strict();

export const classroomGroupUpdateSchema = z
  .object({
    id: identifierSchema,
    name: classroomNameSchema.optional(),
    capabilities: capabilitiesSchema.nullable().optional(),
    budget_microcents: microcentsSchema.optional(),
    daily_budget_microcents: nullableMicrocentsSchema.optional(),
    rpm_limit: rpmLimitSchema.nullable().optional(),
    tpm_limit: tpmLimitSchema.nullable().optional(),
    concurrency_limit: concurrencyLimitSchema.nullable().optional(),
    starts_at: classroomTimestampSchema.nullable().optional(),
    expires_at: classroomTimestampSchema.nullable().optional(),
    status: classroomGroupStatusSchema.optional(),
  })
  .strict();

export const classroomGroupAccessSchema = z
  .object({
    group_id: identifierSchema,
    kind: classroomAccessKindSchema,
    expires_at: classroomTimestampSchema.optional(),
    max_activations: maxActivationsSchema.optional(),
  })
  .strict();

export const classroomGroupKeySchema = z
  .object({ id: identifierSchema })
  .strict();

export type ClassroomClassCreate = z.infer<typeof classroomClassCreateSchema>;
export type ClassroomClassUpdate = z.infer<typeof classroomClassUpdateSchema>;
export type ClassroomClassDuplicate = z.infer<
  typeof classroomClassDuplicateSchema
>;
export type ClassroomClassUsageRequest = z.infer<
  typeof classroomClassUsageSchema
>;
export type ClassroomGroupCreate = z.infer<typeof classroomGroupCreateSchema>;
export type ClassroomGroupUpdate = z.infer<typeof classroomGroupUpdateSchema>;
export type ClassroomGroupAccess = z.infer<typeof classroomGroupAccessSchema>;
export type ClassroomStatus = z.infer<typeof classroomStatusSchema>;
export type ClassroomGroupStatus = z.infer<typeof classroomGroupStatusSchema>;
export type ClassroomAccessKind = z.infer<typeof classroomAccessKindSchema>;

export type ClassroomClassObject = {
  id: string;
  product_id: string;
  environment_id: string;
  tenant_id: string;
  name: string;
  course: string;
  instructors: string[];
  timezone: string;
  starts_at: number;
  expires_at: number;
  status: ClassroomStatus;
  capabilities: string[];
  budget_microcents: number;
  group_budget_microcents: number;
  daily_budget_microcents: number | null;
  rpm_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  created_at: number;
  updated_at: number;
};

export type ClassroomGroupObject = {
  id: string;
  class_id: string;
  name: string;
  status: ClassroomGroupStatus;
  /** `null` inherits the class capability policy. */
  capabilities: string[] | null;
  budget_microcents: number;
  daily_budget_microcents: number | null;
  rpm_limit: number | null;
  tpm_limit: number | null;
  concurrency_limit: number | null;
  starts_at: number | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
};

export type ClassroomGroupKeyObject = {
  id: string;
  group_id: string;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
};

export type ClassroomGroupCodeObject = {
  id: string;
  classroom_group_id: string;
  expires_at: number;
  disabled: boolean;
  activation_count: number;
  max_activations: number;
};

export type ClassroomClassListResponse = {
  classes: ClassroomClassObject[];
  truncated: boolean;
};

export type ClassroomGroupListResponse = {
  groups: ClassroomGroupObject[];
  keys: ClassroomGroupKeyObject[];
  codes: ClassroomGroupCodeObject[];
  truncated: boolean;
};

export type ClassroomGroupAccessResponse = {
  id: string;
  group_id: string;
  kind: ClassroomAccessKind;
  /** Present only for `api_key`, and only in the issuing response. */
  api_key?: string;
  /** Present only for `join_code`, and only in the issuing response. */
  access_code?: string;
  warning: "shown once";
};

export type ClassroomUsageMetrics = {
  requests: number;
  input_tokens: string;
  output_tokens: string;
  cost_microcents: string;
  pending_requests: number;
  pending_cost_microcents: string;
};

export type ClassroomGroupUsage = ClassroomUsageMetrics & {
  group_id: string;
};

export type ClassroomClassUsageResponse = {
  class_id: string;
  groups: ClassroomGroupUsage[];
  totals: ClassroomUsageMetrics;
  /** True when the bounded group list omitted groups. Sums are never truncated. */
  truncated: boolean;
};

/** Stored row shapes for the classroom tables, as D1 returns them. */
export type ClassroomClassRow = {
  id: string;
  product_id: string;
  environment_id: string;
  tenant_id: string;
  name: string;
  course: string;
  instructors_json: string;
  timezone: string;
  starts_at: number;
  expires_at: number;
  status: ClassroomStatus;
  capabilities_json: string;
  budget_microcents: number;
  group_budget_microcents: number;
  daily_budget_microcents: number | null;
  rpm_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  created_at: number;
  updated_at: number;
};

export type ClassroomGroupRow = {
  id: string;
  class_id: string;
  name: string;
  status: ClassroomGroupStatus;
  capabilities_json: string | null;
  budget_microcents: number;
  daily_budget_microcents: number | null;
  rpm_limit: number | null;
  tpm_limit: number | null;
  concurrency_limit: number | null;
  starts_at: number | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
};

export function decodeCapabilitiesJson(value: string | null): string[] | null {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new HttpError(
      500,
      "internal_error",
      "stored classroom capability policy is invalid",
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string")
  ) {
    throw new HttpError(
      500,
      "internal_error",
      "stored classroom capability policy is invalid",
    );
  }
  return parsed;
}

export function decodeInstructorsJson(value: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    throw new HttpError(
      500,
      "internal_error",
      "stored classroom instructors are invalid",
    );
  }
  if (
    !Array.isArray(parsed) ||
    !parsed.every((item) => typeof item === "string")
  ) {
    throw new HttpError(
      500,
      "internal_error",
      "stored classroom instructors are invalid",
    );
  }
  return parsed;
}

export function classroomClassObject(
  row: ClassroomClassRow,
): ClassroomClassObject {
  return {
    id: row.id,
    product_id: row.product_id,
    environment_id: row.environment_id,
    tenant_id: row.tenant_id,
    name: row.name,
    course: row.course,
    instructors: decodeInstructorsJson(row.instructors_json),
    timezone: row.timezone,
    starts_at: row.starts_at,
    expires_at: row.expires_at,
    status: row.status,
    capabilities: decodeCapabilitiesJson(row.capabilities_json) ?? [],
    budget_microcents: row.budget_microcents,
    group_budget_microcents: row.group_budget_microcents,
    daily_budget_microcents: row.daily_budget_microcents,
    rpm_limit: row.rpm_limit,
    tpm_limit: row.tpm_limit,
    concurrency_limit: row.concurrency_limit,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function classroomGroupObject(
  row: ClassroomGroupRow,
): ClassroomGroupObject {
  return {
    id: row.id,
    class_id: row.class_id,
    name: row.name,
    status: row.status,
    capabilities: decodeCapabilitiesJson(row.capabilities_json),
    budget_microcents: row.budget_microcents,
    daily_budget_microcents: row.daily_budget_microcents,
    rpm_limit: row.rpm_limit,
    tpm_limit: row.tpm_limit,
    concurrency_limit: row.concurrency_limit,
    starts_at: row.starts_at,
    expires_at: row.expires_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Class windows must be ordered and, on creation or extension, end in the future. */
export function validateClassroomWindow(
  window: { starts_at: number; expires_at: number },
  now: number,
  options: { requireFutureEnd: boolean },
): void {
  if (window.expires_at <= window.starts_at) {
    throw new HttpError(
      400,
      "invalid_request",
      "expires_at must be after starts_at",
    );
  }
  if (options.requireFutureEnd && window.expires_at <= now) {
    throw new HttpError(
      400,
      "invalid_request",
      "expires_at must be in the future",
    );
  }
}

/**
 * A group schedule is optional and must intersect the class window: supplied
 * bounds stay inside the class window and the effective window is non-empty.
 */
export function validateGroupWindow(
  window: { starts_at: number | null; expires_at: number | null },
  classWindow: { starts_at: number; expires_at: number },
  now: number,
  options: { requireFutureEnd: boolean },
): void {
  if (
    window.starts_at !== null &&
    window.expires_at !== null &&
    window.expires_at <= window.starts_at
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      "expires_at must be after starts_at",
    );
  }
  if (window.starts_at !== null && window.starts_at < classWindow.starts_at) {
    throw new HttpError(
      400,
      "invalid_request",
      "group starts_at must not precede the class schedule",
    );
  }
  if (
    window.expires_at !== null &&
    window.expires_at > classWindow.expires_at
  ) {
    throw new HttpError(
      400,
      "invalid_request",
      "group expires_at must not exceed the class schedule",
    );
  }
  const effectiveStart = window.starts_at ?? classWindow.starts_at;
  const effectiveEnd = window.expires_at ?? classWindow.expires_at;
  if (effectiveEnd <= effectiveStart) {
    throw new HttpError(
      400,
      "invalid_request",
      "group schedule must intersect the class schedule",
    );
  }
  if (options.requireFutureEnd && effectiveEnd <= now) {
    throw new HttpError(
      400,
      "invalid_request",
      "group schedule must end in the future",
    );
  }
}

/** Group capabilities, when set, must be a subset of the class policy. */
export function validateGroupCapabilities(
  groupCapabilities: string[] | null,
  classCapabilities: string[],
): string[] | null {
  if (groupCapabilities === null) return null;
  const allowed = new Set(classCapabilities);
  const outside = groupCapabilities.filter(
    (capability) => !allowed.has(capability),
  );
  if (outside.length > 0) {
    throw new HttpError(
      400,
      "invalid_request",
      `group capabilities must be a subset of the class capabilities: ${outside.join(", ")}`,
    );
  }
  return groupCapabilities;
}
