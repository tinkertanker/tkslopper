import {
  CLASSROOM_CLASS_LIST_LIMIT,
  CLASSROOM_DEFAULT_MAX_ACTIVATIONS,
  CLASSROOM_GROUP_KEY_PREFIX,
  CLASSROOM_GROUP_LIST_LIMIT,
  CLASSROOM_USAGE_GROUP_LIMIT,
  HttpError,
  classroomClassCreateSchema,
  classroomClassDuplicateSchema,
  classroomClassListSchema,
  classroomClassObject,
  classroomClassUpdateSchema,
  classroomClassUsageSchema,
  classroomGroupAccessSchema,
  classroomGroupCreateSchema,
  classroomGroupKeySchema,
  classroomGroupListSchema,
  classroomGroupObject,
  classroomGroupUpdateSchema,
  createOpaqueCredential,
  decodeCapabilitiesJson,
  hashCredential,
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
  type ClassroomGroupAccessResponse,
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

export type ClassroomClassOption = {
  product_id: string;
  environment_id: string;
  product_name: string;
  environment_name: string;
  aliases: string[];
};

export type ClassroomClassOptionsResponse = {
  environments: ClassroomClassOption[];
  truncated: boolean;
};

type ClassroomGroupKeyRow = {
  id: string;
  group_id: string;
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
    `SELECT id, class_id, name, status, capabilities_json, budget_microcents,
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
  validateClassroomWindow({ starts_at: startsAt, expires_at: expiresAt }, now, {
    requireFutureEnd: body.expires_at !== undefined,
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

  await env.DB.batch([
    ...groups.flatMap((group) => [group.statement, group.audit]),
  ]);

  return jsonResponse(
    {
      groups: groups.map((group) => ({
        id: group.id,
        class_id: class_.id,
        name: group.name,
        status: "active",
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
      `SELECT id, class_id, name, status, capabilities_json, budget_microcents,
              daily_budget_microcents, rpm_limit, tpm_limit, concurrency_limit, starts_at,
              expires_at, created_at, updated_at
         FROM classroom_groups
        WHERE class_id = ?
        ORDER BY name, id
        LIMIT ?`,
    )
      .bind(body.class_id, limit)
      .all<ClassroomGroupRow>(),
    env.DB.prepare(
      `SELECT id, group_id, expires_at, revoked_at, created_at
         FROM classroom_group_keys
        WHERE group_id IN (SELECT id FROM classroom_groups WHERE class_id = ?)
        ORDER BY created_at, id
        LIMIT ?`,
    )
      .bind(body.class_id, limit)
      .all<ClassroomGroupKeyRow>(),
    env.DB.prepare(
      `SELECT id, classroom_group_id, expires_at, disabled, activation_count, max_activations
         FROM access_codes
        WHERE classroom_group_id IN (SELECT id FROM classroom_groups WHERE class_id = ?)
        ORDER BY created_at, id
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
  set("updated_at", now);

  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE classroom_groups SET ${assignments.join(", ")}
        WHERE id = ? AND status <> 'revoked'`,
    ).bind(...values, group.id),
    auditStatement(env, actorHash, "update", "classroom_group", group.id, {
      onlyIfChanged: true,
    }),
  ]);
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

async function issueApiKey(
  env: ClassroomEnv,
  actorHash: string,
  group: ClassroomGroupRow,
  expiresAt: number | null,
): Promise<Response> {
  const id = randomId("gkey");
  const value = `${CLASSROOM_GROUP_KEY_PREFIX}${randomSecret(32)}`;
  const now = nowSeconds();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO classroom_group_keys (id, group_id, secret_hash, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(id, group.id, await sha256(value), expiresAt, now),
    auditStatement(env, actorHash, "create", "classroom_group_key", id),
  ]);
  const response: ClassroomGroupAccessResponse = {
    id,
    group_id: group.id,
    kind: "api_key",
    api_key: value,
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

  if (body.kind === "api_key")
    return await issueApiKey(env, actorHash, group, body.expires_at ?? null);

  const capabilities = effectiveGroupCapabilities(
    decodeCapabilitiesJson(class_.capabilities_json) ?? [],
    decodeCapabilitiesJson(group.capabilities_json),
  );
  if (capabilities.length === 0)
    throw new HttpError(
      409,
      "conflict",
      "class and group capability policies do not intersect",
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
    `SELECT id, group_id, expires_at, revoked_at, created_at
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

  const id = randomId("gkey");
  const value = `${CLASSROOM_GROUP_KEY_PREFIX}${randomSecret(32)}`;
  const now = nowSeconds();
  // The replacement key and its audit row are gated on the conditional revoke
  // of the old key, so a concurrent rotate or revoke cannot mint a second live
  // secret for the same group.
  const results = await env.DB.batch([
    env.DB.prepare(
      "UPDATE classroom_group_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
    ).bind(now, key.id),
    env.DB.prepare(
      `INSERT INTO classroom_group_keys (id, group_id, secret_hash, expires_at, created_at)
       SELECT ?, ?, ?, ?, ? WHERE changes() = 1`,
    ).bind(id, group.id, await sha256(value), key.expires_at, now),
    auditStatement(env, actorHash, "create", "classroom_group_key", id, {
      onlyIfChanged: true,
    }),
  ]);
  if ((results[0]?.meta.changes ?? 0) === 0)
    throw new HttpError(409, "conflict", "group key is already revoked");
  const response: ClassroomGroupAccessResponse = {
    id,
    group_id: group.id,
    kind: "api_key",
    api_key: value,
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
              e.name AS environment_name
         FROM products p JOIN environments e ON e.product_id = p.id
        WHERE p.enabled = 1 AND p.kill_switch = 0 AND e.enabled = 1 AND e.kill_switch = 0
        ORDER BY p.display_name, p.id, e.name, e.id
        LIMIT ?`,
    )
      .bind(environmentLimit + 1)
      .all<{
        product_id: string;
        product_name: string;
        environment_id: string;
        environment_name: string;
      }>(),
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
    case "/admin/v1/groups/rotate":
      return await adminRotateGroupKey(request, env, actorHash);
    case "/admin/v1/groups/revoke-key":
      return await adminRevokeGroupKey(request, env, actorHash);
    default:
      return undefined;
  }
}
