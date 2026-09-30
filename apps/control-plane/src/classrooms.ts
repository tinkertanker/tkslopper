import {
  CLASSROOM_CLASS_LIST_LIMIT,
  CLASSROOM_DEFAULT_MAX_ACTIVATIONS,
  CLASSROOM_GROUP_BULK_LIMIT,
  CLASSROOM_GROUP_KEY_PREFIX,
  CLASSROOM_GROUP_LIST_LIMIT,
  CLASSROOM_MICROCENTS_MAX,
  CLASSROOM_USAGE_GROUP_LIMIT,
  HttpError,
  classroomClassCreateSchema,
  classroomClassDuplicateSchema,
  classroomClassListSchema,
  classroomClassObject,
  classroomClassUpdateSchema,
  classroomClassUsageSchema,
  classroomGroupAccessBulkSchema,
  classroomGroupAccessSchema,
  classroomGroupBudgetBulkSchema,
  classroomGroupCreateSchema,
  classroomGroupKeySchema,
  classroomGroupListSchema,
  classroomGroupObject,
  classroomGroupUpdateSchema,
  createOpaqueCredential,
  decodeCapabilitiesJson,
  hashCredential,
  isUniqueConstraintError,
  jsonResponse,
  randomId,
  randomSecret,
  readJsonBody,
  sha256,
  validateClassroomWindow,
  validateGroupCapabilities,
  validateGroupWindow,
  zodMessage,
  type ClassroomClassListResponse,
  type ClassroomClassRow,
  type ClassroomClassUsageResponse,
  type ClassroomGroupAccessBulkResponse,
  type ClassroomGroupAccessResponse,
  type ClassroomGroupBudgetBulkResponse,
  type ClassroomGroupBulkSkip,
  type ClassroomGroupCodeObject,
  type ClassroomGroupKeyObject,
  type ClassroomGroupListResponse,
  type ClassroomGroupRow,
  type ClassroomGroupUsage,
  type ClassroomUsageMetrics,
} from "@tkslopper/shared";
import { type ZodType } from "zod";

/**
 * Classroom administration. Classes are new product/environment/tenant scoped
 * entities; groups are the permanent quota scope that API keys and join codes
 * attach to. Gateway enforcement and activation hooks are owned elsewhere; this
 * module only writes control-plane policy and projects recorded usage.
 */

export type ClassroomEnv = {
  DB: D1Database;
  CREDENTIAL_PEPPER: string;
};

/** Environment guardrails; classroom group limits are bounded by these. */
export type ClassroomEnvironmentLimits = {
  policy_version: number;
  token_ttl_seconds: number;
  rpm_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  daily_budget_microcents: number;
  max_request_bytes: number;
};

export type ClassroomClassOption = {
  product_id: string;
  environment_id: string;
  product_name: string;
  environment_name: string;
  aliases: string[];
  limits: ClassroomEnvironmentLimits;
};

export type ClassroomClassOptionsResponse = {
  environments: ClassroomClassOption[];
  truncated: boolean;
};

type ClassroomGroupKeyRow = {
  id: string;
  group_id: string;
  key_hint: string | null;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
};

type ClassroomGroupContext = {
  group: ClassroomGroupRow;
  class: ClassroomClassRow;
};

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function parseBody<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const parsed = schema.safeParse(await readJsonBody(request, 65_536));
  if (!parsed.success)
    throw new HttpError(400, "invalid_request", zodMessage(parsed.error));
  return parsed.data;
}

function auditStatement(
  env: ClassroomEnv,
  actorHash: string,
  action: string,
  resourceType: string,
  resourceId: string,
  options?: { id?: string; onlyIfChanged?: boolean },
): D1PreparedStatement {
  const values = [
    options?.id ?? randomId("audit"),
    action,
    resourceType,
    resourceId,
    actorHash,
    nowSeconds(),
  ];
  return env.DB.prepare(
    options?.onlyIfChanged
      ? `INSERT INTO admin_audit (id, action, resource_type, resource_id, actor_hash, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE changes() > 0`
      : `INSERT INTO admin_audit (id, action, resource_type, resource_id, actor_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
  ).bind(...values);
}

async function requireEnvironment(
  env: ClassroomEnv,
  productId: string,
  environmentId: string,
): Promise<void> {
  const row = await env.DB.prepare(
    "SELECT 1 AS found FROM environments WHERE id = ? AND product_id = ?",
  )
    .bind(environmentId, productId)
    .first<{ found: number }>();
  if (!row)
    throw new HttpError(404, "not_found", "product environment not found");
}

/** Every requested capability must already be an enabled alias in the environment. */
async function requireEnabledAliases(
  env: ClassroomEnv,
  productId: string,
  environmentId: string,
  capabilities: string[],
): Promise<void> {
  const placeholders = capabilities.map(() => "?").join(", ");
  const rows = await env.DB.prepare(
    `SELECT alias FROM aliases
      WHERE product_id = ? AND environment_id = ? AND enabled = 1
        AND alias IN (${placeholders})`,
  )
    .bind(productId, environmentId, ...capabilities)
    .all<{ alias: string }>();
  const found = new Set(rows.results.map((row) => row.alias));
  const missing = capabilities.filter((capability) => !found.has(capability));
  if (missing.length > 0)
    throw new HttpError(
      400,
      "invalid_request",
      `capabilities must be enabled aliases in the target environment: ${missing.join(", ")}`,
    );
}

async function requireClassRow(
  env: ClassroomEnv,
  classId: string,
): Promise<ClassroomClassRow> {
  const row = await env.DB.prepare(
    `SELECT id, product_id, environment_id, tenant_id, name, course, instructors_json, timezone,
            starts_at, expires_at, status, capabilities_json, budget_microcents,
            group_budget_microcents, daily_budget_microcents, rpm_limit, tpm_limit,
            concurrency_limit, created_at, updated_at
       FROM classroom_classes WHERE id = ?`,
  )
    .bind(classId)
    .first<ClassroomClassRow>();
  if (!row) throw new HttpError(404, "not_found", "class not found");
  return row;
}

async function requireGroupContext(
  env: ClassroomEnv,
  groupId: string,
): Promise<ClassroomGroupContext> {
  const group = await env.DB.prepare(
    `SELECT id, class_id, name, status, paused_at, capabilities_json, budget_microcents,
            daily_budget_microcents, rpm_limit, tpm_limit, concurrency_limit, starts_at,
            expires_at, created_at, updated_at
       FROM classroom_groups WHERE id = ?`,
  )
    .bind(groupId)
    .first<ClassroomGroupRow>();
  if (!group) throw new HttpError(404, "not_found", "group not found");
  const class_ = await requireClassRow(env, group.class_id);
  return { group, class: class_ };
}

async function adminCreateClass(
  request: Request,
  env: ClassroomEnv,
  actorHash: string,
): Promise<Response> {
  const body = await parseBody(request, classroomClassCreateSchema);
  await requireEnvironment(env, body.product_id, body.environment_id);
  await requireEnabledAliases(
    env,
    body.product_id,
    body.environment_id,
    body.capabilities,
  );
  const now = nowSeconds();
  validateClassroomWindow(
    { starts_at: body.starts_at, expires_at: body.expires_at },
    now,
    { requireFutureEnd: true },
  );
  const id = randomId("class");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO classroom_classes
         (id, product_id, environment_id, tenant_id, name, course, instructors_json, timezone,
          starts_at, expires_at, status, capabilities_json, budget_microcents,
          group_budget_microcents, daily_budget_microcents, rpm_limit, tpm_limit,
          concurrency_limit, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      body.product_id,
      body.environment_id,
      body.tenant_id,
      body.name,
      body.course,
      JSON.stringify(body.instructors),
      body.timezone,
      body.starts_at,
      body.expires_at,
      JSON.stringify(body.capabilities),
      body.budget_microcents,
      body.group_budget_microcents,
      body.daily_budget_microcents,
      body.rpm_limit,
      body.tpm_limit,
      body.concurrency_limit,
      now,
      now,
    ),
    auditStatement(env, actorHash, "create", "classroom_class", id),
  ]);
  return jsonResponse({ id }, 201);
}

async function adminListClasses(
  request: Request,
  env: ClassroomEnv,
): Promise<Response> {
  await parseBody(request, classroomClassListSchema);
  const rows = await env.DB.prepare(
    `SELECT id, product_id, environment_id, tenant_id, name, course, instructors_json, timezone,
            starts_at, expires_at, status, capabilities_json, budget_microcents,
            group_budget_microcents, daily_budget_microcents, rpm_limit, tpm_limit,
            concurrency_limit, created_at, updated_at
       FROM classroom_classes
      ORDER BY created_at DESC, id
      LIMIT ?`,
  )
    .bind(CLASSROOM_CLASS_LIST_LIMIT + 1)
    .all<ClassroomClassRow>();
  const response: ClassroomClassListResponse = {
    classes: rows.results
      .slice(0, CLASSROOM_CLASS_LIST_LIMIT)
      .map(classroomClassObject),
    truncated: rows.results.length > CLASSROOM_CLASS_LIST_LIMIT,
  };
  return jsonResponse(response);
}

async function adminUpdateClass(
  request: Request,
  env: ClassroomEnv,
  actorHash: string,
): Promise<Response> {
  const body = await parseBody(request, classroomClassUpdateSchema);
  const row = await requireClassRow(env, body.id);
  if (row.status === "revoked")
    throw new HttpError(409, "conflict", "class is revoked");

  const capabilities =
    body.capabilities !== undefined
      ? body.capabilities
      : (decodeCapabilitiesJson(row.capabilities_json) ?? []);
  if (body.capabilities !== undefined)
    await requireEnabledAliases(
      env,
      row.product_id,
      row.environment_id,
      capabilities,
    );

  const now = nowSeconds();
  const startsAt =
    body.starts_at !== undefined ? body.starts_at : row.starts_at;
  const expiresAt =
    body.expires_at !== undefined ? body.expires_at : row.expires_at;
  // An ended class can still be topped up, re-limited, or extended: only a
  // changed end must lie in the future, and resending the stored end is not
  // a change.
  validateClassroomWindow({ starts_at: startsAt, expires_at: expiresAt }, now, {
    requireFutureEnd:
      body.expires_at !== undefined && body.expires_at !== row.expires_at,
  });

  // Only supplied fields are written, so a stale read cannot restore policy
  // that another writer narrowed or revoked between the read and this write.
  const assignments: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown): void => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };
  if (body.name !== undefined) set("name", body.name);
  if (body.course !== undefined) set("course", body.course);
  if (body.instructors !== undefined)
    set("instructors_json", JSON.stringify(body.instructors));
  if (body.timezone !== undefined) set("timezone", body.timezone);
  if (body.starts_at !== undefined) set("starts_at", body.starts_at);
  if (body.expires_at !== undefined) set("expires_at", body.expires_at);
  if (body.status !== undefined) set("status", body.status);
  if (body.capabilities !== undefined)
    set("capabilities_json", JSON.stringify(capabilities));
  if (body.budget_microcents !== undefined)
    set("budget_microcents", body.budget_microcents);
  if (body.group_budget_microcents !== undefined)
    set("group_budget_microcents", body.group_budget_microcents);
  if (body.daily_budget_microcents !== undefined)
    set("daily_budget_microcents", body.daily_budget_microcents);
  if (body.rpm_limit !== undefined) set("rpm_limit", body.rpm_limit);
  if (body.tpm_limit !== undefined) set("tpm_limit", body.tpm_limit);
  if (body.concurrency_limit !== undefined)
    set("concurrency_limit", body.concurrency_limit);
  set("updated_at", now);

  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE classroom_classes SET ${assignments.join(", ")}
        WHERE id = ? AND status <> 'revoked'`,
    ).bind(...values, row.id),
    auditStatement(env, actorHash, "update", "classroom_class", row.id, {
      onlyIfChanged: true,
    }),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0)
    await classWriteConflict(env, row.id);
  return jsonResponse({ id: row.id });
}

/** Distinguishes a vanished class from one revoked between read and write. */
async function classWriteConflict(
  env: ClassroomEnv,
  classId: string,
): Promise<never> {
  const current = await env.DB.prepare(
    "SELECT status FROM classroom_classes WHERE id = ?",
  )
    .bind(classId)
    .first<{ status: string }>();
  if (!current) throw new HttpError(404, "not_found", "class not found");
  throw new HttpError(409, "conflict", "class is revoked");
}

async function adminDuplicateClass(
  request: Request,
  env: ClassroomEnv,
  actorHash: string,
): Promise<Response> {
  const body = await parseBody(request, classroomClassDuplicateSchema);
  const source = await requireClassRow(env, body.id);
  const now = nowSeconds();
  validateClassroomWindow(
    { starts_at: body.starts_at, expires_at: body.expires_at },
    now,
    { requireFutureEnd: true },
  );
  const id = randomId("class");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO classroom_classes
         (id, product_id, environment_id, tenant_id, name, course, instructors_json, timezone,
          starts_at, expires_at, status, capabilities_json, budget_microcents,
          group_budget_microcents, daily_budget_microcents, rpm_limit, tpm_limit,
          concurrency_limit, created_at, updated_at)
       SELECT ?, product_id, environment_id, tenant_id, ?, course, instructors_json, timezone,
              ?, ?, 'active', capabilities_json, budget_microcents, group_budget_microcents,
              daily_budget_microcents, rpm_limit, tpm_limit, concurrency_limit, ?, ?
         FROM classroom_classes WHERE id = ?`,
    ).bind(id, body.name, body.starts_at, body.expires_at, now, now, source.id),
    env.DB.prepare(
      `INSERT INTO classroom_groups
         (id, class_id, name, status, capabilities_json, budget_microcents, daily_budget_microcents,
          rpm_limit, tpm_limit, concurrency_limit, starts_at, expires_at, created_at, updated_at)
       SELECT 'group_' || lower(hex(randomblob(16))), ?, name, 'active', capabilities_json,
              budget_microcents, daily_budget_microcents, rpm_limit, tpm_limit, concurrency_limit,
              NULL, NULL, ?, ?
         FROM classroom_groups WHERE class_id = ?`,
    ).bind(id, now, now, source.id),
    auditStatement(env, actorHash, "duplicate", "classroom_class", id),
  ]);
  return jsonResponse({ id }, 201);
}

async function adminCreateGroups(
  request: Request,
  env: ClassroomEnv,
  actorHash: string,
): Promise<Response> {
  const body = await parseBody(request, classroomGroupCreateSchema);
  const class_ = await requireClassRow(env, body.class_id);
  if (class_.status === "revoked")
    throw new HttpError(409, "conflict", "class is revoked");
  if (new Set(body.names).size !== body.names.length)
    throw new HttpError(
      409,
      "conflict",
      "group names must be unique within the request",
    );

  const existing: { name: string }[] = [];
  // D1 allows at most 100 bound parameters per statement, so probe in chunks.
  for (let offset = 0; offset < body.names.length; offset += 99) {
    const chunk = body.names.slice(offset, offset + 99);
    const rows = await env.DB.prepare(
      `SELECT name FROM classroom_groups WHERE class_id = ? AND name IN (${chunk
        .map(() => "?")
        .join(", ")})`,
    )
      .bind(body.class_id, ...chunk)
      .all<{ name: string }>();
    existing.push(...rows.results);
  }
  if (existing.length > 0)
    throw new HttpError(
      409,
      "conflict",
      `group name already exists in this class: ${existing
        .map((row) => row.name)
        .join(", ")}`,
    );

  const now = nowSeconds();
  const groups = body.names.map((name) => {
    const id = randomId("group");
    return {
      id,
      name,
      statement: env.DB.prepare(
        `INSERT INTO classroom_groups
           (id, class_id, name, status, capabilities_json, budget_microcents,
            daily_budget_microcents, rpm_limit, tpm_limit, concurrency_limit, starts_at,
            expires_at, created_at, updated_at)
         VALUES (?, ?, ?, 'active', NULL, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      ).bind(id, class_.id, name, class_.group_budget_microcents, now, now),
      audit: auditStatement(env, actorHash, "create", "classroom_group", id),
    };
  });

  try {
    await env.DB.batch([
      ...groups.flatMap((group) => [group.statement, group.audit]),
    ]);
  } catch (error) {
    // A concurrent writer can still claim a name after the probe above.
    if (isUniqueConstraintError(error))
      throw new HttpError(
        409,
        "conflict",
        "a group with that name already exists",
      );
    throw error;
  }

  return jsonResponse(
    {
      groups: groups.map((group) => ({
        id: group.id,
        class_id: class_.id,
        name: group.name,
        status: "active",
        paused: false,
        paused_at: null,
        capabilities: null,
        budget_microcents: class_.group_budget_microcents,
        daily_budget_microcents: null,
        rpm_limit: null,
        tpm_limit: null,
        concurrency_limit: null,
        starts_at: null,
        expires_at: null,
        created_at: now,
        updated_at: now,
      })),
    },
    201,
  );
}

async function adminListGroups(
  request: Request,
  env: ClassroomEnv,
): Promise<Response> {
  const body = await parseBody(request, classroomGroupListSchema);
  await requireClassRow(env, body.class_id);
  const limit = CLASSROOM_GROUP_LIST_LIMIT + 1;
  const [groups, keys, codes] = await Promise.all([
    env.DB.prepare(
      `SELECT id, class_id, name, status, paused_at, capabilities_json, budget_microcents,
              daily_budget_microcents, rpm_limit, tpm_limit, concurrency_limit, starts_at,
              expires_at, created_at, updated_at
         FROM classroom_groups
        WHERE class_id = ?
        ORDER BY name, id
        LIMIT ?`,
    )
      .bind(body.class_id, limit)
      .all<ClassroomGroupRow>(),
    // Live credentials first, newest first, so repeated rotation truncates
    // old revoked rows rather than hiding the keys an operator needs.
    env.DB.prepare(
      `SELECT id, group_id, key_hint, expires_at, revoked_at, created_at
         FROM classroom_group_keys
        WHERE group_id IN (SELECT id FROM classroom_groups WHERE class_id = ?)
        ORDER BY revoked_at IS NULL DESC, created_at DESC, id DESC
        LIMIT ?`,
    )
      .bind(body.class_id, limit)
      .all<ClassroomGroupKeyRow>(),
    env.DB.prepare(
      `SELECT id, classroom_group_id, expires_at, disabled, activation_count, max_activations
         FROM access_codes
        WHERE classroom_group_id IN (SELECT id FROM classroom_groups WHERE class_id = ?)
        ORDER BY disabled, created_at DESC, id DESC
        LIMIT ?`,
    )
      .bind(body.class_id, limit)
      .all<{
        id: string;
        classroom_group_id: string;
        expires_at: number;
        disabled: number;
        activation_count: number;
        max_activations: number;
      }>(),
  ]);

  const keyObjects: ClassroomGroupKeyObject[] = keys.results
    .slice(0, CLASSROOM_GROUP_LIST_LIMIT)
    .map((row) => ({
      id: row.id,
      group_id: row.group_id,
      key_hint: row.key_hint,
      expires_at: row.expires_at,
      revoked_at: row.revoked_at,
      created_at: row.created_at,
    }));
  const codeObjects: ClassroomGroupCodeObject[] = codes.results
    .slice(0, CLASSROOM_GROUP_LIST_LIMIT)
    .map((row) => ({
      id: row.id,
      classroom_group_id: row.classroom_group_id,
      expires_at: row.expires_at,
      disabled: row.disabled === 1,
      activation_count: row.activation_count,
      max_activations: row.max_activations,
    }));
  const response: ClassroomGroupListResponse = {
    groups: groups.results
      .slice(0, CLASSROOM_GROUP_LIST_LIMIT)
      .map(classroomGroupObject),
    keys: keyObjects,
    codes: codeObjects,
    truncated:
      groups.results.length > CLASSROOM_GROUP_LIST_LIMIT ||
      keys.results.length > CLASSROOM_GROUP_LIST_LIMIT ||
      codes.results.length > CLASSROOM_GROUP_LIST_LIMIT,
  };
  return jsonResponse(response);
}

async function adminUpdateGroup(
  request: Request,
  env: ClassroomEnv,
  actorHash: string,
): Promise<Response> {
  const body = await parseBody(request, classroomGroupUpdateSchema);
  const { group, class: class_ } = await requireGroupContext(env, body.id);
  if (group.status === "revoked")
    throw new HttpError(409, "conflict", "group is revoked");

  const classCapabilities =
    decodeCapabilitiesJson(class_.capabilities_json) ?? [];
  const capabilities =
    body.capabilities !== undefined
      ? validateGroupCapabilities(body.capabilities, classCapabilities)
      : decodeCapabilitiesJson(group.capabilities_json);

  const startsAt =
    body.starts_at !== undefined ? body.starts_at : group.starts_at;
  const expiresAt =
    body.expires_at !== undefined ? body.expires_at : group.expires_at;
  const now = nowSeconds();
  if (body.starts_at !== undefined || body.expires_at !== undefined)
    validateGroupWindow(
      { starts_at: startsAt, expires_at: expiresAt },
      { starts_at: class_.starts_at, expires_at: class_.expires_at },
      now,
      { requireFutureEnd: true },
    );

  // Only supplied fields are written, so a stale read cannot restore policy
  // that another writer narrowed or revoked between the read and this write.
  const assignments: string[] = [];
  const values: unknown[] = [];
  const set = (column: string, value: unknown): void => {
    assignments.push(`${column} = ?`);
    values.push(value);
  };
  if (body.name !== undefined) set("name", body.name);
  if (body.status !== undefined) set("status", body.status);
  if (body.capabilities !== undefined)
    set(
      "capabilities_json",
      capabilities === null ? null : JSON.stringify(capabilities),
    );
  if (body.budget_microcents !== undefined)
    set("budget_microcents", body.budget_microcents);
  if (body.daily_budget_microcents !== undefined)
    set("daily_budget_microcents", body.daily_budget_microcents);
  if (body.rpm_limit !== undefined) set("rpm_limit", body.rpm_limit);
  if (body.tpm_limit !== undefined) set("tpm_limit", body.tpm_limit);
  if (body.concurrency_limit !== undefined)
    set("concurrency_limit", body.concurrency_limit);
  if (body.starts_at !== undefined) set("starts_at", body.starts_at);
  if (body.expires_at !== undefined) set("expires_at", body.expires_at);
  // Pausing keeps the original pause time; resuming clears it.
  if (body.paused === true) {
    assignments.push("paused_at = COALESCE(paused_at, ?)");
    values.push(now);
  } else if (body.paused === false) set("paused_at", null);
  set("updated_at", now);

  // A request that only pauses or resumes is audited as such; any other edit
  // (with or without a pause change) is audited as an update.
  const onlyPause =
    body.paused !== undefined &&
    Object.keys(body).every((key) => key === "id" || key === "paused");
  const action = onlyPause ? (body.paused ? "pause" : "resume") : "update";
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `UPDATE classroom_groups SET ${assignments.join(", ")}
          WHERE id = ? AND status <> 'revoked'`,
      ).bind(...values, group.id),
      auditStatement(env, actorHash, action, "classroom_group", group.id, {
        onlyIfChanged: true,
      }),
    ]);
  } catch (error) {
    if (isUniqueConstraintError(error))
      throw new HttpError(
        409,
        "conflict",
        "a group with that name already exists",
      );
    throw error;
  }
  if ((results[0]?.meta.changes ?? 0) === 0)
    await groupWriteConflict(env, group.id);
  return jsonResponse({ id: group.id });
}

/** Distinguishes a vanished group from one revoked between read and write. */
async function groupWriteConflict(
  env: ClassroomEnv,
  groupId: string,
): Promise<never> {
  const current = await env.DB.prepare(
    "SELECT status FROM classroom_groups WHERE id = ?",
  )
    .bind(groupId)
    .first<{ status: string }>();
  if (!current) throw new HttpError(404, "not_found", "group not found");
  throw new HttpError(409, "conflict", "group is revoked");
}

/** Intersection of the class policy and the group policy (group `null` inherits). */
function effectiveGroupCapabilities(
  classCapabilities: string[],
  groupCapabilities: string[] | null,
): string[] {
  if (groupCapabilities === null) return classCapabilities;
  return classCapabilities.filter((capability) =>
    groupCapabilities.includes(capability),
  );
}

/** Last four characters: enough to tell keys apart, never enough to use one. */
function groupKeyHint(value: string): string {
  return value.slice(-4);
}

function newGroupKey(): { id: string; value: string; hint: string } {
  const value = `${CLASSROOM_GROUP_KEY_PREFIX}${randomSecret(32)}`;
  return { id: randomId("gkey"), value, hint: groupKeyHint(value) };
}

/**
 * Why a group cannot use newly issued access, or `undefined`. API keys and
 * join codes share these checks so neither is minted for a group whose
 * schedule has ended or whose class/group model policies do not intersect.
 */
function groupIssuanceBlocker(
  class_: ClassroomClassRow,
  group: ClassroomGroupRow,
  now: number,
): string | undefined {
  if (group.status === "revoked") return "group is revoked";
  if (Math.min(class_.expires_at, group.expires_at ?? class_.expires_at) <= now)
    return "class or group schedule has already ended";
  if (
    effectiveGroupCapabilities(
      decodeCapabilitiesJson(class_.capabilities_json) ?? [],
      decodeCapabilitiesJson(group.capabilities_json),
    ).length === 0
  )
    return "class and group capability policies do not intersect";
  return undefined;
}

async function issueApiKey(
  env: ClassroomEnv,
  actorHash: string,
  group: ClassroomGroupRow,
  expiresAt: number | null,
): Promise<Response> {
  const key = newGroupKey();
  const now = nowSeconds();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO classroom_group_keys
         (id, group_id, secret_hash, key_hint, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(key.id, group.id, await sha256(key.value), key.hint, expiresAt, now),
    auditStatement(env, actorHash, "create", "classroom_group_key", key.id),
  ]);
  const response: ClassroomGroupAccessResponse = {
    id: key.id,
    group_id: group.id,
    kind: "api_key",
    api_key: key.value,
    key_hint: key.hint,
    warning: "shown once",
  };
  return jsonResponse(response, 201);
}

async function issueJoinCode(
  env: ClassroomEnv,
  actorHash: string,
  class_: ClassroomClassRow,
  group: ClassroomGroupRow,
  capabilities: string[],
  requestedExpiresAt: number | undefined,
  maxActivations: number | undefined,
): Promise<Response> {
  const now = nowSeconds();
  const expiresAt = Math.min(
    class_.expires_at,
    group.expires_at ?? class_.expires_at,
    requestedExpiresAt ?? Number.MAX_SAFE_INTEGER,
  );
  if (expiresAt <= now)
    throw new HttpError(
      409,
      "conflict",
      "class or group schedule has already ended",
    );
  const credential = createOpaqueCredential("access_code");
  const salt = randomSecret(16);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO access_codes
         (id, product_id, environment_id, tenant_id, secret_salt, secret_hash, capabilities_json,
          expires_at, max_activations, max_failed_attempts, classroom_group_id, created_at,
          updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 8, ?, ?, ?)`,
    ).bind(
      credential.id,
      class_.product_id,
      class_.environment_id,
      class_.tenant_id,
      salt,
      await hashCredential(credential.secret, salt, env.CREDENTIAL_PEPPER),
      JSON.stringify(capabilities),
      expiresAt,
      maxActivations ?? CLASSROOM_DEFAULT_MAX_ACTIVATIONS,
      group.id,
      now,
      now,
    ),
    auditStatement(env, actorHash, "create", "access_code", credential.id),
  ]);
  const response: ClassroomGroupAccessResponse = {
    id: credential.id,
    group_id: group.id,
    kind: "join_code",
    access_code: credential.value,
    warning: "shown once",
  };
  return jsonResponse(response, 201);
}

async function adminGroupAccess(
  request: Request,
  env: ClassroomEnv,
  actorHash: string,
): Promise<Response> {
  const body = await parseBody(request, classroomGroupAccessSchema);
  const { group, class: class_ } = await requireGroupContext(
    env,
    body.group_id,
  );
  if (class_.status === "revoked")
    throw new HttpError(409, "conflict", "class is revoked");
  if (group.status === "revoked")
    throw new HttpError(409, "conflict", "group is revoked");

  const now = nowSeconds();
  if (body.expires_at !== undefined && body.expires_at <= now)
    throw new HttpError(
      400,
      "invalid_request",
      "expires_at must be in the future",
    );
  const blocker = groupIssuanceBlocker(class_, group, now);
  if (blocker) throw new HttpError(409, "conflict", blocker);

  if (body.kind === "api_key")
    return await issueApiKey(env, actorHash, group, body.expires_at ?? null);

  const capabilities = effectiveGroupCapabilities(
    decodeCapabilitiesJson(class_.capabilities_json) ?? [],
    decodeCapabilitiesJson(group.capabilities_json),
  );
  return await issueJoinCode(
    env,
    actorHash,
    class_,
    group,
    capabilities,
    body.expires_at,
    body.max_activations,
  );
}

async function adminRotateGroupKey(
  request: Request,
  env: ClassroomEnv,
  actorHash: string,
): Promise<Response> {
  const body = await parseBody(request, classroomGroupKeySchema);
  const key = await env.DB.prepare(
    `SELECT id, group_id, key_hint, expires_at, revoked_at, created_at
       FROM classroom_group_keys WHERE id = ?`,
  )
    .bind(body.id)
    .first<ClassroomGroupKeyRow>();
  if (!key) throw new HttpError(404, "not_found", "group key not found");
  if (key.revoked_at !== null)
    throw new HttpError(409, "conflict", "group key is already revoked");
  const { group, class: class_ } = await requireGroupContext(env, key.group_id);
  if (class_.status === "revoked")
    throw new HttpError(409, "conflict", "class is revoked");
  if (group.status === "revoked")
    throw new HttpError(409, "conflict", "group is revoked");

  const replacement = newGroupKey();
  const now = nowSeconds();
  // The replacement key and its audit row are gated on the conditional revoke
  // of the old key, so a concurrent rotate or revoke cannot mint a second live
  // secret for the same group.
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE classroom_group_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).bind(now, key.id),
    env.DB.prepare(
      `INSERT INTO classroom_group_keys
         (id, group_id, secret_hash, key_hint, expires_at, created_at)
       SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
    ).bind(
      replacement.id,
      group.id,
      await sha256(replacement.value),
      replacement.hint,
      key.expires_at,
      now,
    ),
    auditStatement(
      env,
      actorHash,
      "create",
      "classroom_group_key",
      replacement.id,
      {
        onlyIfChanged: true,
      },
    ),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0)
    throw new HttpError(409, "conflict", "group key is already revoked");
  const response: ClassroomGroupAccessResponse = {
    id: replacement.id,
    group_id: group.id,
    kind: "api_key",
    api_key: replacement.value,
    key_hint: replacement.hint,
    warning: "shown once",
  };
  return jsonResponse(response, 201);
}

async function adminRevokeGroupKey(
  request: Request,
  env: ClassroomEnv,
  actorHash: string,
): Promise<Response> {
  const body = await parseBody(request, classroomGroupKeySchema);
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE classroom_group_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).bind(nowSeconds(), body.id),
    auditStatement(env, actorHash, "revoke", "classroom_group_key", body.id, {
      onlyIfChanged: true,
    }),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0)
    throw new HttpError(404, "not_found", "active group key not found");
  return jsonResponse({ id: body.id });
}

const GROUP_ROW_COLUMNS = `id, class_id, name, status, paused_at, capabilities_json,
  budget_microcents, daily_budget_microcents, rpm_limit, tpm_limit, concurrency_limit,
  starts_at, expires_at, created_at, updated_at`;

/**
 * Loads explicitly requested groups of one class in request order. Unknown IDs
 * are reported rather than failing the batch. One JSON parameter keeps the
 * lookup inside D1's 100 bound-parameter limit.
 */
async function requestedClassGroups(
  env: ClassroomEnv,
  classId: string,
  groupIds: string[],
): Promise<{ groups: ClassroomGroupRow[]; skipped: ClassroomGroupBulkSkip[] }> {
  const rows = await env.DB.prepare(
    `SELECT ${GROUP_ROW_COLUMNS}
       FROM classroom_groups
      WHERE class_id = ? AND id IN (SELECT value FROM json_each(?))`,
  )
    .bind(classId, JSON.stringify(groupIds))
    .all<ClassroomGroupRow>();
  const byId = new Map(rows.results.map((row) => [row.id, row]));
  const groups: ClassroomGroupRow[] = [];
  const skipped: ClassroomGroupBulkSkip[] = [];
  for (const id of groupIds) {
    const group = byId.get(id);
    if (group) groups.push(group);
    else
      skipped.push({
        group_id: id,
        group_name: null,
        reason: "group not found in this class",
      });
  }
  return { groups, skipped };
}

async function adminGroupAccessBulk(
  request: Request,
  env: ClassroomEnv,
  actorHash: string,
): Promise<Response> {
  const body = await parseBody(request, classroomGroupAccessBulkSchema);
  const class_ = await requireClassRow(env, body.class_id);
  if (class_.status === "revoked")
    throw new HttpError(409, "conflict", "class is revoked");
  const now = nowSeconds();
  if (class_.expires_at <= now)
    throw new HttpError(409, "conflict", "class schedule has already ended");
  const expiresAt = body.expires_at ?? null;
  if (expiresAt !== null && expiresAt <= now)
    throw new HttpError(
      400,
      "invalid_request",
      "expires_at must be in the future",
    );

  let candidates: ClassroomGroupRow[];
  const skipped: ClassroomGroupBulkSkip[] = [];
  let truncated = false;
  if (body.group_ids === undefined) {
    const rows = await env.DB.prepare(
      `SELECT ${GROUP_ROW_COLUMNS}
         FROM classroom_groups
        WHERE class_id = ? AND status = 'active' AND paused_at IS NULL
        ORDER BY name, id
        LIMIT ?`,
    )
      .bind(class_.id, CLASSROOM_GROUP_BULK_LIMIT + 1)
      .all<ClassroomGroupRow>();
    candidates = rows.results.slice(0, CLASSROOM_GROUP_BULK_LIMIT);
    truncated = rows.results.length > CLASSROOM_GROUP_BULK_LIMIT;
  } else {
    // Explicitly named paused groups still receive keys; the keys work once
    // the group is resumed.
    const requested = await requestedClassGroups(
      env,
      class_.id,
      body.group_ids,
    );
    candidates = requested.groups;
    skipped.push(...requested.skipped);
  }

  const issued: {
    group: ClassroomGroupRow;
    key: ReturnType<typeof newGroupKey>;
    secretHash: string;
    auditId: string;
  }[] = [];
  for (const group of candidates) {
    const reason = groupIssuanceBlocker(class_, group, now);
    if (reason) {
      skipped.push({ group_id: group.id, group_name: group.name, reason });
      continue;
    }
    const key = newGroupKey();
    issued.push({
      group,
      key,
      secretHash: await sha256(key.value),
      auditId: randomId("audit"),
    });
  }

  let inserted = new Set<string>();
  if (issued.length > 0) {
    const payload = JSON.stringify(
      issued.map((entry) => ({
        id: entry.key.id,
        group_id: entry.group.id,
        secret_hash: entry.secretHash,
        key_hint: entry.key.hint,
        audit_id: entry.auditId,
      })),
    );
    // Two set-based statements (keys, then their audit rows) cover up to 100
    // groups in one transaction without approaching D1's per-batch statement
    // or bound-parameter limits. Keys are inserted only for groups that are
    // still active in a non-revoked class at write time, and each audit row
    // exists only for a key that was actually inserted.
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO classroom_group_keys
           (id, group_id, secret_hash, key_hint, expires_at, created_at)
         SELECT json_extract(k.value, '$.id'), g.id, json_extract(k.value, '$.secret_hash'),
                json_extract(k.value, '$.key_hint'), ?, ?
           FROM json_each(?) AS k
           JOIN classroom_groups AS g ON g.id = json_extract(k.value, '$.group_id')
           JOIN classroom_classes AS c ON c.id = g.class_id
          WHERE g.class_id = ? AND g.status = 'active' AND c.status <> 'revoked'`,
      ).bind(expiresAt, now, payload, class_.id),
      env.DB.prepare(
        `INSERT INTO admin_audit (id, action, resource_type, resource_id, actor_hash, created_at)
         SELECT json_extract(k.value, '$.audit_id'), 'create', 'classroom_group_key', key.id, ?, ?
           FROM json_each(?) AS k
           JOIN classroom_group_keys AS key ON key.id = json_extract(k.value, '$.id')`,
      ).bind(actorHash, now, payload),
      env.DB.prepare(
        `SELECT id FROM classroom_group_keys
          WHERE id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
      ).bind(payload),
    ]);
    inserted = new Set(
      ((results[2]?.results ?? []) as { id: string }[]).map((row) => row.id),
    );
  }

  const response: ClassroomGroupAccessBulkResponse = {
    class_id: class_.id,
    keys: [],
    skipped,
    truncated,
    warning: "shown once",
  };
  for (const entry of issued) {
    if (inserted.has(entry.key.id))
      response.keys.push({
        group_id: entry.group.id,
        group_name: entry.group.name,
        key_id: entry.key.id,
        api_key: entry.key.value,
        key_hint: entry.key.hint,
        expires_at: expiresAt,
      });
    else
      response.skipped.push({
        group_id: entry.group.id,
        group_name: entry.group.name,
        reason: "group or class was revoked during issuance",
      });
  }
  return jsonResponse(response, 201);
}

async function adminGroupBudgetBulk(
  request: Request,
  env: ClassroomEnv,
  actorHash: string,
): Promise<Response> {
  const body = await parseBody(request, classroomGroupBudgetBulkSchema);
  const class_ = await requireClassRow(env, body.class_id);
  if (class_.status === "revoked")
    throw new HttpError(409, "conflict", "class is revoked");

  const skipped: ClassroomGroupBulkSkip[] = [];
  let targets: ClassroomGroupRow[];
  if (body.group_ids === undefined) {
    const rows = await env.DB.prepare(
      `SELECT ${GROUP_ROW_COLUMNS}
         FROM classroom_groups
        WHERE class_id = ? AND status <> 'revoked'
        ORDER BY name, id`,
    )
      .bind(class_.id)
      .all<ClassroomGroupRow>();
    targets = rows.results;
  } else {
    const requested = await requestedClassGroups(
      env,
      class_.id,
      body.group_ids,
    );
    skipped.push(...requested.skipped);
    targets = [];
    for (const group of requested.groups) {
      if (group.status === "revoked")
        skipped.push({
          group_id: group.id,
          group_name: group.name,
          reason: "group is revoked",
        });
      else targets.push(group);
    }
  }

  const now = nowSeconds();
  const payload = JSON.stringify(
    targets.map((group) => ({ id: group.id, audit_id: randomId("audit") })),
  );
  const statements: D1PreparedStatement[] = [];
  if (body.class_budget_microcents !== undefined)
    statements.push(
      env.DB.prepare(
        `UPDATE classroom_classes SET budget_microcents = ?, updated_at = ?
          WHERE id = ? AND status <> 'revoked'`,
      ).bind(body.class_budget_microcents, now, class_.id),
      auditStatement(
        env,
        actorHash,
        "budget_set",
        "classroom_class",
        class_.id,
        { onlyIfChanged: true },
      ),
    );
  // "add" saturates at the stored maximum rather than failing the batch. The
  // update and its audit rows share one predicate inside one transaction, so
  // exactly the updated groups are audited.
  const targetPredicate = `g.class_id = ? AND g.status <> 'revoked'
    AND EXISTS (SELECT 1 FROM classroom_classes AS c WHERE c.id = g.class_id AND c.status <> 'revoked')`;
  statements.push(
    env.DB.prepare(
      `UPDATE classroom_groups AS g
          SET budget_microcents = ${
            body.mode === "set" ? "?" : "MIN(budget_microcents + ?, ?)"
          },
              updated_at = ?
        WHERE ${targetPredicate}
          AND g.id IN (SELECT json_extract(value, '$.id') FROM json_each(?))`,
    ).bind(
      ...(body.mode === "set"
        ? [body.budget_microcents]
        : [body.budget_microcents, CLASSROOM_MICROCENTS_MAX]),
      now,
      class_.id,
      payload,
    ),
    env.DB.prepare(
      `INSERT INTO admin_audit (id, action, resource_type, resource_id, actor_hash, created_at)
       SELECT json_extract(k.value, '$.audit_id'), ?, 'classroom_group', g.id, ?, ?
         FROM json_each(?) AS k
         JOIN classroom_groups AS g ON g.id = json_extract(k.value, '$.id')
        WHERE ${targetPredicate}`,
    ).bind(`budget_${body.mode}`, actorHash, now, payload, class_.id),
    env.DB.prepare(
      `SELECT g.id, g.name, g.budget_microcents
         FROM classroom_groups AS g
        WHERE ${targetPredicate}
          AND g.id IN (SELECT json_extract(value, '$.id') FROM json_each(?))
        ORDER BY g.name, g.id`,
    ).bind(class_.id, payload),
    env.DB.prepare(
      "SELECT status, budget_microcents FROM classroom_classes WHERE id = ?",
    ).bind(class_.id),
  );
  const results = await env.DB.batch(statements);
  const classState = results.at(-1)?.results[0] as
    { status: string; budget_microcents: number } | undefined;
  if (!classState) throw new HttpError(404, "not_found", "class not found");
  if (classState.status === "revoked")
    throw new HttpError(409, "conflict", "class is revoked");
  const updated = (results.at(-2)?.results ?? []) as {
    id: string;
    name: string;
    budget_microcents: number;
  }[];
  const updatedIds = new Set(updated.map((row) => row.id));
  for (const group of targets)
    if (!updatedIds.has(group.id))
      skipped.push({
        group_id: group.id,
        group_name: group.name,
        reason: "group was revoked during the update",
      });
  const response: ClassroomGroupBudgetBulkResponse = {
    class_id: class_.id,
    mode: body.mode,
    groups: updated.map((row) => ({
      group_id: row.id,
      group_name: row.name,
      budget_microcents: row.budget_microcents,
    })),
    skipped,
  };
  if (body.class_budget_microcents !== undefined)
    response.class_budget_microcents = classState.budget_microcents;
  return jsonResponse(response);
}

type ClassroomUsageRow = {
  group_id: string;
  requests: number;
  input_tokens: string;
  output_tokens: string;
  cost_microcents: string;
  pending_requests: number;
  pending_cost_microcents: string;
};

const CLASSROOM_USAGE_METRICS_SQL = `
  COALESCE(SUM(CASE WHEN status_code <> 0 THEN 1 ELSE 0 END), 0) AS requests,
  COALESCE(CAST(SUM(CASE WHEN status_code <> 0 THEN input_tokens ELSE 0 END) AS TEXT), '0')
    AS input_tokens,
  COALESCE(CAST(SUM(CASE WHEN status_code <> 0 THEN output_tokens ELSE 0 END) AS TEXT), '0')
    AS output_tokens,
  COALESCE(CAST(SUM(CASE WHEN status_code <> 0 THEN cost_microcents ELSE 0 END) AS TEXT), '0')
    AS cost_microcents,
  COALESCE(SUM(CASE WHEN status_code = 0 THEN 1 ELSE 0 END), 0) AS pending_requests,
  COALESCE(CAST(SUM(CASE WHEN status_code = 0 THEN cost_microcents ELSE 0 END) AS TEXT), '0')
    AS pending_cost_microcents`;

async function adminClassUsage(
  request: Request,
  env: ClassroomEnv,
): Promise<Response> {
  const body = await parseBody(request, classroomClassUsageSchema);
  await requireClassRow(env, body.class_id);

  const [groups, usage, totals] = await Promise.all([
    env.DB.prepare(
      `SELECT id AS group_id FROM classroom_groups
        WHERE class_id = ?
        ORDER BY name, id
        LIMIT ?`,
    )
      .bind(body.class_id, CLASSROOM_USAGE_GROUP_LIMIT + 1)
      .all<{ group_id: string }>(),
    env.DB.prepare(
      `SELECT classroom_group_id AS group_id, ${CLASSROOM_USAGE_METRICS_SQL}
         FROM provider_attempts
        WHERE classroom_group_id IN (SELECT id FROM classroom_groups WHERE class_id = ?)
        GROUP BY classroom_group_id`,
    )
      .bind(body.class_id)
      .all<ClassroomUsageRow>(),
    env.DB.prepare(
      `SELECT ${CLASSROOM_USAGE_METRICS_SQL}
         FROM provider_attempts
        WHERE classroom_group_id IN (SELECT id FROM classroom_groups WHERE class_id = ?)`,
    )
      .bind(body.class_id)
      .first<Omit<ClassroomUsageRow, "group_id">>(),
  ]);

  const byGroup = new Map(usage.results.map((row) => [row.group_id, row]));
  const zero: Omit<ClassroomUsageRow, "group_id"> = {
    requests: 0,
    input_tokens: "0",
    output_tokens: "0",
    cost_microcents: "0",
    pending_requests: 0,
    pending_cost_microcents: "0",
  };
  const groupUsage: ClassroomGroupUsage[] = groups.results
    .slice(0, CLASSROOM_USAGE_GROUP_LIMIT)
    .map((row) => {
      const metrics = byGroup.get(row.group_id) ?? zero;
      return {
        group_id: row.group_id,
        requests: metrics.requests,
        input_tokens: metrics.input_tokens,
        output_tokens: metrics.output_tokens,
        cost_microcents: metrics.cost_microcents,
        pending_requests: metrics.pending_requests,
        pending_cost_microcents: metrics.pending_cost_microcents,
      };
    });
  const totalsMetrics: ClassroomUsageMetrics = totals ?? zero;
  const response: ClassroomClassUsageResponse = {
    class_id: body.class_id,
    groups: groupUsage,
    totals: totalsMetrics,
    truncated: groups.results.length > CLASSROOM_USAGE_GROUP_LIMIT,
  };
  return jsonResponse(response);
}

async function adminClassOptions(
  request: Request,
  env: ClassroomEnv,
): Promise<Response> {
  await parseBody(request, classroomClassListSchema);
  const environmentLimit = 250;
  const aliasLimit = 50;
  const [environments, aliases] = await Promise.all([
    env.DB.prepare(
      `SELECT p.id AS product_id, p.display_name AS product_name, e.id AS environment_id,
              e.name AS environment_name, e.policy_version, e.token_ttl_seconds, e.rpm_limit,
              e.tpm_limit, e.concurrency_limit, e.daily_budget_microcents, e.max_request_bytes
         FROM products p JOIN environments e ON e.product_id = p.id
        WHERE p.enabled = 1 AND p.kill_switch = 0 AND e.enabled = 1 AND e.kill_switch = 0
        ORDER BY p.display_name, p.id, e.name, e.id
        LIMIT ?`,
    )
      .bind(environmentLimit + 1)
      .all<
        {
          product_id: string;
          product_name: string;
          environment_id: string;
          environment_name: string;
        } & ClassroomEnvironmentLimits
      >(),
    // Only enabled aliases of enabled product/environment pairs are offered, and
    // only the public alias name is projected; route, model, and credential
    // details stay out of this response.
    env.DB.prepare(
      `SELECT DISTINCT e.product_id, e.id AS environment_id, a.alias
         FROM aliases a
         JOIN environments e ON e.id = a.environment_id AND e.product_id = a.product_id
         JOIN products p ON p.id = e.product_id
        WHERE a.enabled = 1 AND p.enabled = 1 AND p.kill_switch = 0
          AND e.enabled = 1 AND e.kill_switch = 0
          AND (e.product_id, e.id) IN (
            SELECT p2.id, e2.id
              FROM products p2 JOIN environments e2 ON e2.product_id = p2.id
             WHERE p2.enabled = 1 AND p2.kill_switch = 0
               AND e2.enabled = 1 AND e2.kill_switch = 0
             ORDER BY p2.display_name, p2.id, e2.name, e2.id
             LIMIT ?
          )
        ORDER BY e.product_id, e.id, a.alias
        LIMIT ?`,
    )
      .bind(environmentLimit, environmentLimit * (aliasLimit + 1) + 1)
      .all<{ product_id: string; environment_id: string; alias: string }>(),
  ]);

  const visible = environments.results.slice(0, environmentLimit);
  let truncated = environments.results.length > environmentLimit;
  const byEnvironment = new Map<string, string[]>();
  for (const row of aliases.results) {
    const key = `${row.product_id}\u0000${row.environment_id}`;
    const names = byEnvironment.get(key) ?? [];
    if (names.length <= aliasLimit) names.push(row.alias);
    byEnvironment.set(key, names);
  }
  const options: ClassroomClassOption[] = visible.map((environment) => {
    const key = `${environment.product_id}\u0000${environment.environment_id}`;
    const names = byEnvironment.get(key) ?? [];
    if (names.length > aliasLimit) truncated = true;
    return {
      product_id: environment.product_id,
      environment_id: environment.environment_id,
      product_name: environment.product_name,
      environment_name: environment.environment_name,
      aliases: names.slice(0, aliasLimit),
      limits: {
        policy_version: environment.policy_version,
        token_ttl_seconds: environment.token_ttl_seconds,
        rpm_limit: environment.rpm_limit,
        tpm_limit: environment.tpm_limit,
        concurrency_limit: environment.concurrency_limit,
        daily_budget_microcents: environment.daily_budget_microcents,
        max_request_bytes: environment.max_request_bytes,
      },
    };
  });
  const response: ClassroomClassOptionsResponse = {
    environments: options,
    truncated,
  };
  return jsonResponse(response);
}

/**
 * Dispatches classroom admin paths. Returns `undefined` for paths this module
 * does not own so the caller can fall through to the existing route switch.
 */
export async function dispatchClassroomAdmin(
  request: Request,
  env: ClassroomEnv,
  actorHash: string,
  adminPath: string,
): Promise<Response | undefined> {
  switch (adminPath) {
    case "/admin/v1/classes/list":
      return await adminListClasses(request, env);
    case "/admin/v1/classes/options":
      return await adminClassOptions(request, env);
    case "/admin/v1/classes":
      return await adminCreateClass(request, env, actorHash);
    case "/admin/v1/classes/update":
      return await adminUpdateClass(request, env, actorHash);
    case "/admin/v1/classes/duplicate":
      return await adminDuplicateClass(request, env, actorHash);
    case "/admin/v1/classes/usage":
      return await adminClassUsage(request, env);
    case "/admin/v1/groups":
      return await adminCreateGroups(request, env, actorHash);
    case "/admin/v1/groups/list":
      return await adminListGroups(request, env);
    case "/admin/v1/groups/update":
      return await adminUpdateGroup(request, env, actorHash);
    case "/admin/v1/groups/access":
      return await adminGroupAccess(request, env, actorHash);
    case "/admin/v1/groups/access-bulk":
      return await adminGroupAccessBulk(request, env, actorHash);
    case "/admin/v1/groups/budget-bulk":
      return await adminGroupBudgetBulk(request, env, actorHash);
    case "/admin/v1/groups/rotate":
      return await adminRotateGroupKey(request, env, actorHash);
    case "/admin/v1/groups/revoke-key":
      return await adminRevokeGroupKey(request, env, actorHash);
    default:
      return undefined;
  }
}
