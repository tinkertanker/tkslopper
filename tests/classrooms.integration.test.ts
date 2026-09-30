import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  DATABASE_SCHEMA_VERSION,
  hashCredential,
  parseOpaqueCredential,
  sha256,
} from "@tkslopper/shared";
import {
  handleControlPlane,
  type ControlPlaneEnv,
} from "../apps/control-plane/src";

const controlEnv = {
  ...env,
  DASHBOARD_ACCESS_AUD: "classroom-test-audience",
} as unknown as ControlPlaneEnv;
const origin = "https://control.example.invalid";
const browserIdentity = {
  access: {
    aud: "classroom-test-audience",
    getIdentity: () => Promise.resolve({ email: "operator@example.invalid" }),
  },
};
const now = (): number => Math.floor(Date.now() / 1000);

function request(
  path: string,
  body: unknown,
  token?: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(origin + path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function admin(path: string, body: unknown): Promise<Response> {
  return handleControlPlane(
    request(path, body, String(env.ADMIN_TOKEN)),
    controlEnv,
  );
}

async function json<T>(response: Response): Promise<T> {
  const parsed: unknown = await response.json();
  return parsed as T;
}

/** Dynamic timestamp matcher that keeps `toEqual` object literals type-safe. */
function anyNumber(): unknown {
  const matcher: unknown = expect.any(Number);
  return matcher;
}

async function adminJson<T>(path: string, body: unknown): Promise<T> {
  const response = await admin(path, body);
  expect(response.status, `${path} -> ${await response.clone().text()}`).toBe(
    200,
  );
  return await json<T>(response);
}

function classBody(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const timestamp = now();
  return {
    product_id: "prod_classroom",
    environment_id: "env_classroom",
    tenant_id: "tenant_classroom",
    name: "Period 1",
    course: "CS101",
    instructors: ["teacher@example.invalid"],
    timezone: "Asia/Singapore",
    starts_at: timestamp - 60,
    expires_at: timestamp + 3600,
    capabilities: ["text.chat.v1", "json.strict.v1"],
    budget_microcents: 1_000_000,
    group_budget_microcents: 100_000,
    daily_budget_microcents: null,
    rpm_limit: 30,
    tpm_limit: 100_000,
    concurrency_limit: 2,
    ...overrides,
  };
}

async function createClass(
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const response = await admin("/admin/v1/classes", classBody(overrides));
  expect(response.status, await response.clone().text()).toBe(201);
  return (await json<{ id: string }>(response)).id;
}

async function createGroups(
  classId: string,
  names: string[],
): Promise<{ id: string; name: string }[]> {
  const response = await admin("/admin/v1/groups", {
    class_id: classId,
    names,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const body = await json<{ groups: { id: string; name: string }[] }>(response);
  return body.groups;
}

async function classRow(
  id: string,
): Promise<{ status: string; capabilities_json: string }> {
  const row = await env.DB.prepare(
    "SELECT status, capabilities_json FROM classroom_classes WHERE id = ?",
  )
    .bind(id)
    .first<{ status: string; capabilities_json: string }>();
  if (!row) throw new Error("class row missing");
  return row;
}

function groupStatement(
  id: string,
  classId: string,
  name: string,
  timestamp: number,
  budget = 1000,
): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO classroom_groups
       (id, class_id, name, status, capabilities_json, budget_microcents, created_at, updated_at)
     VALUES (?, ?, ?, 'active', NULL, ?, ?, ?)`,
  ).bind(id, classId, name, budget, timestamp, timestamp);
}

function attemptStatement(
  id: string,
  requestId: string,
  groupId: string | null,
  values: {
    statusCode: number;
    errorClass: string | null;
    inputTokens: number;
    outputTokens: number;
    costMicrocents: number;
  },
): D1PreparedStatement {
  const timestamp = now();
  return env.DB.prepare(
    `INSERT INTO provider_attempts
       (id, request_id, attempt_number, product_id, environment_id, tenant_hash, principal_hash,
        alias, policy_version, route_id, provider, resolved_model, endpoint, status_code, error_class,
        latency_ms, input_tokens, output_tokens, cost_microcents, created_at, stale_after,
        classroom_group_id)
     VALUES (?, ?, 1, 'prod_classroom', 'env_classroom', 'tenant_hash', 'principal_hash',
             'text.chat.v1', 1, 'route_chat', 'fixture', 'fixture-model', 'chat', ?, ?, 0, ?, ?, ?,
             ?, ?, ?)`,
  ).bind(
    id,
    requestId,
    values.statusCode,
    values.errorClass,
    values.inputTokens,
    values.outputTokens,
    values.costMicrocents,
    timestamp,
    timestamp + 60,
    groupId,
  );
}

/** Wraps a prepared statement so a hook runs right after it resolves. */
function wrapStatement(
  statement: D1PreparedStatement,
  afterExecute: () => Promise<void>,
): D1PreparedStatement {
  const wrapper = {
    bind: (...values: unknown[]): D1PreparedStatement =>
      wrapStatement(statement.bind(...values), afterExecute),
    first: async (columnName?: string): Promise<unknown> => {
      const result: unknown =
        columnName === undefined
          ? await statement.first()
          : await statement.first(columnName);
      await afterExecute();
      return result;
    },
    all: async (): Promise<unknown> => {
      const result: unknown = await statement.all();
      await afterExecute();
      return result;
    },
    run: async (): Promise<unknown> => {
      const result: unknown = await statement.run();
      await afterExecute();
      return result;
    },
  };
  return wrapper as unknown as D1PreparedStatement;
}

/**
 * Deterministic stale-read harness: the first matching read resolves against the
 * real database and then `afterExecute` runs before the handler continues, which
 * reproduces a concurrent mutation landing between a read and its write.
 */
function racingEnv(
  matches: (sql: string) => boolean,
  afterExecute: () => Promise<void>,
): ControlPlaneEnv {
  let fired = false;
  const hook = async (): Promise<void> => {
    if (fired) return;
    fired = true;
    await afterExecute();
  };
  const db = {
    prepare(sql: string): D1PreparedStatement {
      const statement = controlEnv.DB.prepare(sql);
      return matches(sql) ? wrapStatement(statement, hook) : statement;
    },
    batch: (statements: D1PreparedStatement[]) =>
      controlEnv.DB.batch(statements),
  };
  return { ...controlEnv, DB: db as unknown as D1Database };
}

const classReadTrigger = (sql: string): boolean =>
  sql.includes("FROM classroom_classes WHERE id = ?");
const groupReadTrigger = (sql: string): boolean =>
  sql.includes("FROM classroom_groups WHERE id = ?");
const keyReadTrigger = (sql: string): boolean =>
  sql.includes("FROM classroom_group_keys WHERE id = ?");

function controlRequest(path: string, body: unknown): Request {
  return request(path, body, String(env.ADMIN_TOKEN));
}

async function countRows(table: string): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS count FROM ${table}`,
  ).first<{ count: number }>();
  return row?.count ?? 0;
}

beforeEach(async () => {
  const timestamp = now();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM provider_attempts"),
    env.DB.prepare("DELETE FROM classroom_group_keys"),
    env.DB.prepare("DELETE FROM access_codes"),
    env.DB.prepare("DELETE FROM activations"),
    env.DB.prepare("DELETE FROM entitlements"),
    env.DB.prepare("DELETE FROM token_grants"),
    env.DB.prepare("DELETE FROM classroom_groups"),
    env.DB.prepare("DELETE FROM classroom_classes"),
    env.DB.prepare("DELETE FROM aliases"),
    env.DB.prepare("DELETE FROM service_credentials"),
    env.DB.prepare("DELETE FROM environments"),
    env.DB.prepare("DELETE FROM products"),
    env.DB.prepare("DELETE FROM dashboard_admins"),
    env.DB.prepare("DELETE FROM admin_audit"),
    env.DB.prepare("DELETE FROM idempotency_keys"),
    env.DB.prepare(
      `INSERT INTO products (id, slug, display_name, created_at, updated_at)
       VALUES ('prod_classroom', 'classroom-fixture', 'Classroom fixture', ?, ?)`,
    ).bind(timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO environments
         (id, product_id, name, audience, created_at, updated_at)
       VALUES ('env_classroom', 'prod_classroom', 'test', 'classroom:test', ?, ?)`,
    ).bind(timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO aliases
         (id, product_id, environment_id, alias, endpoint, route_id, max_input_tokens,
          max_output_tokens, created_at, updated_at)
       VALUES ('alias_chat', 'prod_classroom', 'env_classroom', 'text.chat.v1', 'chat',
               'route_chat', 1000, 100, ?, ?)`,
    ).bind(timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO aliases
         (id, product_id, environment_id, alias, endpoint, route_id, max_input_tokens,
          max_output_tokens, created_at, updated_at)
       VALUES ('alias_json', 'prod_classroom', 'env_classroom', 'json.strict.v1', 'chat',
               'route_json', 1000, 100, ?, ?)`,
    ).bind(timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO aliases
         (id, product_id, environment_id, alias, endpoint, route_id, max_input_tokens,
          max_output_tokens, enabled, created_at, updated_at)
       VALUES ('alias_vision', 'prod_classroom', 'env_classroom', 'vision.classify.v1',
               'responses', 'route_vision', 1000, 100, 0, ?, ?)`,
    ).bind(timestamp, timestamp),
  ]);
});

describe("classroom class lifecycle", () => {
  it("creates a class from enabled aliases and lists decoded policy", async () => {
    const id = await createClass();
    const list = await adminJson<{
      classes: Record<string, unknown>[];
      truncated: boolean;
    }>("/admin/v1/classes/list", {});
    expect(list.truncated).toBe(false);
    expect(list.classes).toHaveLength(1);
    expect(list.classes[0]).toEqual({
      id,
      product_id: "prod_classroom",
      environment_id: "env_classroom",
      tenant_id: "tenant_classroom",
      name: "Period 1",
      course: "CS101",
      instructors: ["teacher@example.invalid"],
      timezone: "Asia/Singapore",
      starts_at: anyNumber(),
      expires_at: anyNumber(),
      status: "active",
      capabilities: ["text.chat.v1", "json.strict.v1"],
      budget_microcents: 1_000_000,
      group_budget_microcents: 100_000,
      daily_budget_microcents: null,
      rpm_limit: 30,
      tpm_limit: 100_000,
      concurrency_limit: 2,
      created_at: anyNumber(),
      updated_at: anyNumber(),
    });
    expect(JSON.stringify(list)).not.toContain("instructors_json");
    expect(JSON.stringify(list)).not.toContain("capabilities_json");
    const audit = await env.DB.prepare(
      "SELECT action, resource_type FROM admin_audit ORDER BY created_at DESC",
    ).all<{ action: string; resource_type: string }>();
    expect(audit.results).toContainEqual({
      action: "create",
      resource_type: "classroom_class",
    });
  });

  it("rejects unknown capabilities, disabled aliases, invalid timezones and unsafe windows", async () => {
    expect((await admin("/admin/v1/classes", classBody())).status).toBe(201);
    const cases: [Record<string, unknown>, number][] = [
      [{ capabilities: ["unknown.model.v1"] }, 400],
      [{ capabilities: ["vision.classify.v1"] }, 400],
      [{ timezone: "Mars/Phobos" }, 400],
      [{ timezone: "" }, 400],
      [{ expires_at: now() - 1 }, 400],
      [{ budget_microcents: Number.MAX_SAFE_INTEGER + 1 }, 400],
      [{ rpm_limit: 0 }, 400],
      [{ tpm_limit: 1_000_000_001 }, 400],
      [{ concurrency_limit: 10_001 }, 400],
      [{ environment_id: "env_missing" }, 404],
      [{ unexpected: true }, 400],
    ];
    for (const [overrides, expected] of cases) {
      const response = await admin(
        "/admin/v1/classes",
        classBody({ ...overrides, name: `case-${expected}-${Math.random()}` }),
      );
      expect(response.status, JSON.stringify(overrides)).toBe(expected);
    }
    const unordered = await admin(
      "/admin/v1/classes",
      classBody({ starts_at: now() + 3600, expires_at: now() + 60 }),
    );
    expect(unordered.status).toBe(400);
    expect(
      (await handleControlPlane(request("/admin/v1/classes", {}), controlEnv))
        .status,
    ).toBe(401);
    expect(
      (
        await handleControlPlane(
          request("/admin/v1/unknown", {}, String(env.ADMIN_TOKEN)),
          controlEnv,
        )
      ).status,
    ).toBe(404);
  });

  it("applies live updates and treats revocation as terminal", async () => {
    const id = await createClass();
    const update = await admin("/admin/v1/classes/update", {
      id,
      name: "Period 2",
      capabilities: ["text.chat.v1"],
      budget_microcents: 2_000_000,
      daily_budget_microcents: 500,
      rpm_limit: 60,
    });
    expect(update.status, await update.clone().text()).toBe(200);
    expect(await update.json()).toEqual({ id });
    const row = await classRow(id);
    expect(row.capabilities_json).toBe('["text.chat.v1"]');
    const list = await adminJson<{ classes: Record<string, unknown>[] }>(
      "/admin/v1/classes/list",
      {},
    );
    expect(list.classes[0]).toMatchObject({
      name: "Period 2",
      capabilities: ["text.chat.v1"],
      budget_microcents: 2_000_000,
      daily_budget_microcents: 500,
      rpm_limit: 60,
      group_budget_microcents: 100_000,
    });
    expect(
      (
        await admin("/admin/v1/classes/update", {
          id,
          capabilities: ["vision.classify.v1"],
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin("/admin/v1/classes/update", {
          id,
          product_id: "prod_other",
        })
      ).status,
    ).toBe(400);
    expect(
      (await admin("/admin/v1/classes/update", { id: "class_missing" })).status,
    ).toBe(404);
    expect(
      (await admin("/admin/v1/classes/update", { id, status: "paused" }))
        .status,
    ).toBe(200);
    expect((await classRow(id)).status).toBe("paused");
    expect(
      (await admin("/admin/v1/classes/update", { id, status: "revoked" }))
        .status,
    ).toBe(200);
    expect((await classRow(id)).status).toBe("revoked");
    const afterRevoke = await admin("/admin/v1/classes/update", {
      id,
      name: "Period 3",
    });
    expect(afterRevoke.status).toBe(409);
    expect((await classRow(id)).status).toBe("revoked");
  });

  it("does not resurrect a class revoked between read and write", async () => {
    const classId = await createClass();
    const racing = racingEnv(classReadTrigger, async () => {
      await env.DB.prepare(
        "UPDATE classroom_classes SET status = 'revoked', updated_at = ? WHERE id = ?",
      )
        .bind(now(), classId)
        .run();
    });
    const response = await handleControlPlane(
      controlRequest("/admin/v1/classes/update", {
        id: classId,
        budget_microcents: 7,
      }),
      racing,
    );
    expect(response.status, await response.clone().text()).toBe(409);
    const row = await env.DB.prepare(
      "SELECT status, budget_microcents FROM classroom_classes WHERE id = ?",
    )
      .bind(classId)
      .first<{ status: string; budget_microcents: number }>();
    expect(row).toEqual({ status: "revoked", budget_microcents: 1_000_000 });
    const audits = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM admin_audit WHERE action = 'update' AND resource_type = 'classroom_class'",
    ).first<{ count: number }>();
    expect(audits).toEqual({ count: 0 });
  });

  it("does not restore a class policy narrowed between read and write", async () => {
    const classId = await createClass();
    const narrowed = now() + 120;
    const racing = racingEnv(classReadTrigger, async () => {
      await env.DB.prepare(
        `UPDATE classroom_classes
            SET capabilities_json = '["text.chat.v1"]', expires_at = ?
          WHERE id = ?`,
      )
        .bind(narrowed, classId)
        .run();
    });
    const response = await handleControlPlane(
      controlRequest("/admin/v1/classes/update", {
        id: classId,
        budget_microcents: 7,
      }),
      racing,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const row = await env.DB.prepare(
      "SELECT capabilities_json, expires_at, budget_microcents FROM classroom_classes WHERE id = ?",
    )
      .bind(classId)
      .first<{
        capabilities_json: string;
        expires_at: number;
        budget_microcents: number;
      }>();
    expect(row).toEqual({
      capabilities_json: '["text.chat.v1"]',
      expires_at: narrowed,
      budget_microcents: 7,
    });
  });

  it("caps the class list at 200 and flags truncation", async () => {
    const timestamp = now();
    const statements = Array.from({ length: 201 }, (_, index) =>
      env.DB.prepare(
        `INSERT INTO classroom_classes
           (id, product_id, environment_id, tenant_id, name, starts_at, expires_at,
            capabilities_json, budget_microcents, group_budget_microcents, rpm_limit,
            tpm_limit, concurrency_limit, created_at, updated_at)
         VALUES (?, 'prod_classroom', 'env_classroom', 'tenant_classroom', ?, ?, ?,
                 '["text.chat.v1"]', 1, 1, 1, 1, 1, ?, ?)`,
      ).bind(
        `class_seed_${index}`,
        `seed-${index}`,
        timestamp,
        timestamp + 3600,
        timestamp,
        timestamp,
      ),
    );
    for (let offset = 0; offset < statements.length; offset += 100)
      await env.DB.batch(statements.slice(offset, offset + 100));
    const list = await adminJson<{
      classes: unknown[];
      truncated: boolean;
    }>("/admin/v1/classes/list", {});
    expect(list.classes).toHaveLength(200);
    expect(list.truncated).toBe(true);
  });
});

describe("classroom group policy", () => {
  it("creates groups in bulk with inherited class defaults", async () => {
    const classId = await createClass();
    const groups = await createGroups(classId, ["Alpha", "Beta"]);
    expect(groups.map((group) => group.name)).toEqual(["Alpha", "Beta"]);
    expect(new Set(groups.map((group) => group.id)).size).toBe(2);
    const list = await adminJson<{
      groups: Record<string, unknown>[];
      keys: unknown[];
      codes: unknown[];
      truncated: boolean;
    }>("/admin/v1/groups/list", { class_id: classId });
    expect(list.keys).toEqual([]);
    expect(list.codes).toEqual([]);
    expect(list.truncated).toBe(false);
    expect(list.groups).toEqual([
      {
        id: groups[0]?.id,
        class_id: classId,
        name: "Alpha",
        status: "active",
        paused: false,
        paused_at: null,
        capabilities: null,
        budget_microcents: 100_000,
        daily_budget_microcents: null,
        rpm_limit: null,
        tpm_limit: null,
        concurrency_limit: null,
        starts_at: null,
        expires_at: null,
        created_at: anyNumber(),
        updated_at: anyNumber(),
      },
      expect.objectContaining({ name: "Beta", id: groups[1]?.id }),
    ]);
    const audit = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM admin_audit WHERE resource_type = 'classroom_group' AND action = 'create'",
    ).first<{ count: number }>();
    expect(audit).toEqual({ count: 2 });
  });

  it("rejects duplicate and invalid group names without partial writes", async () => {
    const classId = await createClass();
    await createGroups(classId, ["Alpha"]);
    const inRequestDuplicate = await admin("/admin/v1/groups", {
      class_id: classId,
      names: ["Beta", "Beta"],
    });
    expect(inRequestDuplicate.status).toBe(409);
    const existingName = await admin("/admin/v1/groups", {
      class_id: classId,
      names: ["Gamma", "Alpha"],
    });
    expect(existingName.status).toBe(409);
    const groups = await adminJson<{ groups: Record<string, unknown>[] }>(
      "/admin/v1/groups/list",
      { class_id: classId },
    );
    expect(groups.groups.map((group) => group.name)).toEqual(["Alpha"]);
    expect(
      (await admin("/admin/v1/groups", { class_id: classId, names: [] }))
        .status,
    ).toBe(400);
    expect(
      (
        await admin("/admin/v1/groups", {
          class_id: classId,
          names: Array.from({ length: 101 }, (_, index) => `n${index}`),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin("/admin/v1/groups", {
          class_id: "class_missing",
          names: ["Delta"],
        })
      ).status,
    ).toBe(404);
  });

  it("accepts the full 100-name bulk and rejects the 101st", async () => {
    const classId = await createClass();
    const names = Array.from(
      { length: 100 },
      (_, index) => `bulk-${String(index).padStart(3, "0")}`,
    );
    const created = await createGroups(classId, names);
    expect(created).toHaveLength(100);
    expect(new Set(created.map((group) => group.id)).size).toBe(100);
    const list = await adminJson<{ groups: unknown[]; truncated: boolean }>(
      "/admin/v1/groups/list",
      { class_id: classId },
    );
    expect(list.groups).toHaveLength(100);
    expect(list.truncated).toBe(false);
    const tooMany = await admin("/admin/v1/groups", {
      class_id: classId,
      names: [...names, "bulk-100"],
    });
    expect(tooMany.status).toBe(400);
  });

  it("restricts group policy to the class policy and schedules to the class window", async () => {
    const timestamp = now();
    const classId = await createClass({
      starts_at: timestamp,
      expires_at: timestamp + 3600,
    });
    const [group] = await createGroups(classId, ["Alpha"]);
    const groupId = String(group?.id);
    expect(
      (
        await admin("/admin/v1/groups/update", {
          id: groupId,
          capabilities: ["vision.classify.v1"],
        })
      ).status,
    ).toBe(400);
    const narrowed = await admin("/admin/v1/groups/update", {
      id: groupId,
      capabilities: ["json.strict.v1"],
      budget_microcents: 5000,
      daily_budget_microcents: 100,
      rpm_limit: 5,
      tpm_limit: 5000,
      concurrency_limit: 1,
      starts_at: timestamp + 60,
      expires_at: timestamp + 1800,
    });
    expect(narrowed.status, await narrowed.clone().text()).toBe(200);
    expect(await narrowed.json()).toEqual({ id: groupId });
    const listed = await adminJson<{ groups: Record<string, unknown>[] }>(
      "/admin/v1/groups/list",
      { class_id: classId },
    );
    expect(listed.groups[0]).toMatchObject({
      capabilities: ["json.strict.v1"],
      budget_microcents: 5000,
      daily_budget_microcents: 100,
      rpm_limit: 5,
      tpm_limit: 5000,
      concurrency_limit: 1,
      starts_at: timestamp + 60,
      expires_at: timestamp + 1800,
    });
    expect(
      (
        await admin("/admin/v1/groups/update", {
          id: groupId,
          starts_at: timestamp - 60,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin("/admin/v1/groups/update", {
          id: groupId,
          expires_at: timestamp + 7200,
        })
      ).status,
    ).toBe(400);
    const inherit = await admin("/admin/v1/groups/update", {
      id: groupId,
      capabilities: null,
      rpm_limit: null,
      starts_at: null,
      expires_at: null,
    });
    expect(inherit.status).toBe(200);
    const inherited = await adminJson<{ groups: Record<string, unknown>[] }>(
      "/admin/v1/groups/list",
      { class_id: classId },
    );
    expect(inherited.groups[0]).toMatchObject({
      capabilities: null,
      rpm_limit: null,
      starts_at: null,
      expires_at: null,
    });
    expect(
      (
        await admin("/admin/v1/groups/update", {
          id: "group_missing",
          name: "Ghost",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await admin("/admin/v1/groups/update", {
          id: groupId,
          status: "revoked",
        })
      ).status,
    ).toBe(200);
    expect(
      (await admin("/admin/v1/groups/update", { id: groupId, name: "Ghost" }))
        .status,
    ).toBe(409);
    await admin("/admin/v1/classes/update", { id: classId, status: "revoked" });
    expect(
      (
        await admin("/admin/v1/groups", {
          class_id: classId,
          names: ["Blocked"],
        })
      ).status,
    ).toBe(409);
  });

  it("does not resurrect a group revoked between read and write", async () => {
    const classId = await createClass();
    const [group] = await createGroups(classId, ["Alpha"]);
    const groupId = String(group?.id);
    const racing = racingEnv(groupReadTrigger, async () => {
      await env.DB.prepare(
        "UPDATE classroom_groups SET status = 'revoked', updated_at = ? WHERE id = ?",
      )
        .bind(now(), groupId)
        .run();
    });
    const response = await handleControlPlane(
      controlRequest("/admin/v1/groups/update", {
        id: groupId,
        name: "Renamed",
      }),
      racing,
    );
    expect(response.status, await response.clone().text()).toBe(409);
    const row = await env.DB.prepare(
      "SELECT name, status FROM classroom_groups WHERE id = ?",
    )
      .bind(groupId)
      .first<{ name: string; status: string }>();
    expect(row).toEqual({ name: "Alpha", status: "revoked" });
    const audits = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM admin_audit WHERE action = 'update' AND resource_type = 'classroom_group'",
    ).first<{ count: number }>();
    expect(audits).toEqual({ count: 0 });
  });

  it("does not restore a group policy narrowed between read and write", async () => {
    const classId = await createClass();
    const [group] = await createGroups(classId, ["Alpha"]);
    const groupId = String(group?.id);
    const racing = racingEnv(groupReadTrigger, async () => {
      await env.DB.prepare(
        `UPDATE classroom_groups SET capabilities_json = '["json.strict.v1"]' WHERE id = ?`,
      )
        .bind(groupId)
        .run();
    });
    const response = await handleControlPlane(
      controlRequest("/admin/v1/groups/update", {
        id: groupId,
        budget_microcents: 777,
      }),
      racing,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const row = await env.DB.prepare(
      "SELECT capabilities_json, budget_microcents FROM classroom_groups WHERE id = ?",
    )
      .bind(groupId)
      .first<{ capabilities_json: string; budget_microcents: number }>();
    expect(row).toEqual({
      capabilities_json: '["json.strict.v1"]',
      budget_microcents: 777,
    });
  });

  it("caps the group list at 500 rows per collection and flags truncation", async () => {
    const classId = await createClass();
    const timestamp = now();
    const statements = Array.from({ length: 501 }, (_, index) =>
      groupStatement(
        `group_seed_${index}`,
        classId,
        `g${String(index).padStart(3, "0")}`,
        timestamp,
      ),
    );
    for (let offset = 0; offset < statements.length; offset += 200)
      await env.DB.batch(statements.slice(offset, offset + 200));
    const list = await adminJson<{
      groups: Record<string, unknown>[];
      truncated: boolean;
    }>("/admin/v1/groups/list", { class_id: classId });
    expect(list.groups).toHaveLength(500);
    expect(list.groups[0]?.name).toBe("g000");
    expect(list.groups[499]?.name).toBe("g499");
    expect(list.truncated).toBe(true);
  });
});

describe("classroom group access", () => {
  it("issues a group API key once, stores only its hash, and never re-discloses it", async () => {
    const classId = await createClass();
    const [group] = await createGroups(classId, ["Alpha"]);
    const groupId = String(group?.id);
    const issued = await admin("/admin/v1/groups/access", {
      group_id: groupId,
      kind: "api_key",
    });
    expect(issued.status, await issued.clone().text()).toBe(201);
    const body = await json<Record<string, unknown>>(issued);
    expect(body).toMatchObject({
      group_id: groupId,
      kind: "api_key",
      warning: "shown once",
    });
    const apiKey = String(body.api_key);
    expect(apiKey.startsWith("tkgk_")).toBe(true);
    const stored = await env.DB.prepare(
      "SELECT id, group_id, secret_hash, expires_at, revoked_at FROM classroom_group_keys",
    ).first<{ id: string; group_id: string; secret_hash: string }>();
    expect(stored?.id).toBe(body.id);
    expect(stored?.group_id).toBe(groupId);
    expect(stored?.secret_hash).toBe(await sha256(apiKey));
    expect(stored?.secret_hash).not.toBe(apiKey);
    const listResponse = await admin("/admin/v1/groups/list", {
      class_id: classId,
    });
    const listText = await listResponse.text();
    expect(listText).not.toContain(apiKey);
    expect(listText).not.toContain(String(stored?.secret_hash));
    const list = JSON.parse(listText) as {
      keys: Record<string, unknown>[];
    };
    expect(list.keys).toHaveLength(1);
    expect(list.keys[0]).toMatchObject({
      id: body.id,
      group_id: groupId,
      expires_at: null,
      revoked_at: null,
    });
    expect(
      (
        await admin("/admin/v1/groups/access", {
          group_id: groupId,
          kind: "api_key",
          expires_at: now() - 1,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin("/admin/v1/groups/access", {
          group_id: "group_missing",
          kind: "api_key",
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await admin("/admin/v1/groups/access", {
          group_id: groupId,
          kind: "carrier_pigeon",
        })
      ).status,
    ).toBe(400);
  });

  it("issues a join code with class/group intersection capabilities and the minimum expiry", async () => {
    const timestamp = now();
    const classId = await createClass({
      capabilities: ["text.chat.v1", "json.strict.v1"],
      starts_at: timestamp,
      expires_at: timestamp + 7200,
    });
    const [group] = await createGroups(classId, ["Alpha"]);
    const groupId = String(group?.id);
    await admin("/admin/v1/groups/update", {
      id: groupId,
      capabilities: ["json.strict.v1"],
      expires_at: timestamp + 3600,
    });
    const issued = await admin("/admin/v1/groups/access", {
      group_id: groupId,
      kind: "join_code",
      expires_at: timestamp + 100_000,
      max_activations: 5,
    });
    expect(issued.status, await issued.clone().text()).toBe(201);
    const body = await json<Record<string, unknown>>(issued);
    expect(body).toMatchObject({
      group_id: groupId,
      kind: "join_code",
      warning: "shown once",
    });
    const accessCode = String(body.access_code);
    const parsed = parseOpaqueCredential(accessCode, "access_code");
    expect(parsed).toBeDefined();
    const stored = await env.DB.prepare(
      `SELECT id, product_id, environment_id, tenant_id, secret_salt, secret_hash,
              capabilities_json, expires_at, max_activations, classroom_group_id
         FROM access_codes WHERE id = ?`,
    )
      .bind(parsed?.id)
      .first<{
        secret_salt: string;
        secret_hash: string;
        capabilities_json: string;
        expires_at: number;
        max_activations: number;
        classroom_group_id: string;
        product_id: string;
        environment_id: string;
        tenant_id: string;
      }>();
    expect(stored?.classroom_group_id).toBe(groupId);
    expect(stored?.capabilities_json).toBe('["json.strict.v1"]');
    expect(stored?.expires_at).toBe(timestamp + 3600);
    expect(stored?.max_activations).toBe(5);
    expect(stored?.product_id).toBe("prod_classroom");
    expect(stored?.environment_id).toBe("env_classroom");
    expect(stored?.tenant_id).toBe("tenant_classroom");
    expect(stored?.secret_hash).toBe(
      await hashCredential(
        String(parsed?.secret),
        String(stored?.secret_salt),
        String(env.CREDENTIAL_PEPPER),
      ),
    );
    const activation = await handleControlPlane(
      request("/v1/activations", {
        access_code: accessCode,
        device_id: "classroom-device-0001",
      }),
      controlEnv,
    );
    expect(activation.status, await activation.clone().text()).toBe(200);
    expect(await activation.json()).toMatchObject({
      capabilities: ["json.strict.v1"],
    });
    const defaulted = await admin("/admin/v1/groups/access", {
      group_id: groupId,
      kind: "join_code",
    });
    expect(defaulted.status).toBe(201);
    const defaultedBody = await json<{ id: string }>(defaulted);
    const defaultedRow = await env.DB.prepare(
      "SELECT max_activations, expires_at FROM access_codes WHERE id = ?",
    )
      .bind(defaultedBody.id)
      .first<{ max_activations: number; expires_at: number }>();
    expect(defaultedRow).toEqual({
      max_activations: 30,
      expires_at: timestamp + 3600,
    });
  });

  it("refuses join codes once the class schedule has ended", async () => {
    const timestamp = now();
    const classId = await createClass();
    const [group] = await createGroups(classId, ["Alpha"]);
    await env.DB.prepare(
      "UPDATE classroom_classes SET starts_at = ?, expires_at = ? WHERE id = ?",
    )
      .bind(timestamp - 7200, timestamp - 60, classId)
      .run();
    const response = await admin("/admin/v1/groups/access", {
      group_id: String(group?.id),
      kind: "join_code",
    });
    expect(response.status).toBe(409);
  });

  it("does not mint a second live key when a rotation loses a concurrent revoke", async () => {
    const classId = await createClass();
    const [group] = await createGroups(classId, ["Alpha"]);
    const groupId = String(group?.id);
    const first = await json<{ id: string; api_key: string }>(
      await admin("/admin/v1/groups/access", {
        group_id: groupId,
        kind: "api_key",
      }),
    );
    const racing = racingEnv(keyReadTrigger, async () => {
      const revoke = await admin("/admin/v1/groups/revoke-key", {
        id: first.id,
      });
      expect(revoke.status).toBe(200);
    });
    const response = await handleControlPlane(
      controlRequest("/admin/v1/groups/rotate", { id: first.id }),
      racing,
    );
    expect(response.status, await response.clone().text()).toBe(409);
    expect(await countRows("classroom_group_keys")).toBe(1);
    const keys = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM classroom_group_keys WHERE revoked_at IS NULL",
    ).first<{ count: number }>();
    expect(keys).toEqual({ count: 0 });
    const audits = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM admin_audit WHERE action = 'create' AND resource_type = 'classroom_group_key'",
    ).first<{ count: number }>();
    expect(audits).toEqual({ count: 1 });
  });

  it("lets exactly one of two concurrent rotations win", async () => {
    const classId = await createClass();
    const [group] = await createGroups(classId, ["Alpha"]);
    const groupId = String(group?.id);
    const first = await json<{ id: string; api_key: string }>(
      await admin("/admin/v1/groups/access", {
        group_id: groupId,
        kind: "api_key",
      }),
    );
    let winner: { status: number } | undefined;
    const racing = racingEnv(keyReadTrigger, async () => {
      winner = await admin("/admin/v1/groups/rotate", { id: first.id });
    });
    const loser = await handleControlPlane(
      controlRequest("/admin/v1/groups/rotate", { id: first.id }),
      racing,
    );
    expect(winner?.status).toBe(201);
    expect(loser.status, await loser.clone().text()).toBe(409);
    expect(await countRows("classroom_group_keys")).toBe(2);
    const live = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM classroom_group_keys WHERE revoked_at IS NULL",
    ).first<{ count: number }>();
    expect(live).toEqual({ count: 1 });
    const secretHashes = await env.DB.prepare(
      "SELECT COUNT(DISTINCT secret_hash) AS count FROM classroom_group_keys",
    ).first<{ count: number }>();
    expect(secretHashes).toEqual({ count: 2 });
  });

  it("rotates and revokes group API keys atomically", async () => {
    const classId = await createClass();
    const [group] = await createGroups(classId, ["Alpha"]);
    const groupId = String(group?.id);
    const first = await json<{ id: string; api_key: string }>(
      await admin("/admin/v1/groups/access", {
        group_id: groupId,
        kind: "api_key",
      }),
    );
    const rotated = await admin("/admin/v1/groups/rotate", { id: first.id });
    expect(rotated.status, await rotated.clone().text()).toBe(201);
    const rotatedBody = await json<{
      id: string;
      group_id: string;
      api_key: string;
    }>(rotated);
    expect(rotatedBody.group_id).toBe(groupId);
    expect(rotatedBody.id).not.toBe(first.id);
    expect(rotatedBody.api_key).not.toBe(first.api_key);
    const rows = await env.DB.prepare(
      "SELECT id, group_id, revoked_at, expires_at FROM classroom_group_keys ORDER BY created_at",
    ).all<{ id: string; group_id: string; revoked_at: number | null }>();
    expect(rows.results).toHaveLength(2);
    expect(rows.results[0]).toMatchObject({ id: first.id, group_id: groupId });
    expect(rows.results[0]?.revoked_at).not.toBeNull();
    expect(rows.results[1]).toMatchObject({
      id: rotatedBody.id,
      group_id: groupId,
      revoked_at: null,
    });
    expect(
      (await admin("/admin/v1/groups/rotate", { id: first.id })).status,
    ).toBe(409);
    expect(
      (await admin("/admin/v1/groups/rotate", { id: "gkey_missing" })).status,
    ).toBe(404);
    const revoked = await admin("/admin/v1/groups/revoke-key", {
      id: rotatedBody.id,
    });
    expect(revoked.status).toBe(200);
    expect(await revoked.json()).toEqual({ id: rotatedBody.id });
    const afterRevoke = await env.DB.prepare(
      "SELECT revoked_at FROM classroom_group_keys WHERE id = ?",
    )
      .bind(rotatedBody.id)
      .first<{ revoked_at: number | null }>();
    expect(afterRevoke?.revoked_at).not.toBeNull();
    expect(
      (await admin("/admin/v1/groups/revoke-key", { id: rotatedBody.id }))
        .status,
    ).toBe(404);
    expect(
      (await admin("/admin/v1/groups/revoke-key", { id: "gkey_missing" }))
        .status,
    ).toBe(404);
  });
});

describe("classroom duplication and usage", () => {
  it("duplicates policy and groups without credentials, usage, or revoked state", async () => {
    const timestamp = now();
    const classId = await createClass({
      capabilities: ["text.chat.v1"],
      group_budget_microcents: 4000,
      starts_at: timestamp,
      expires_at: timestamp + 3600,
    });
    const groups = await createGroups(classId, ["Alpha", "Beta"]);
    await admin("/admin/v1/groups/update", {
      id: String(groups[1]?.id),
      status: "revoked",
      budget_microcents: 900,
    });
    await admin("/admin/v1/groups/access", {
      group_id: String(groups[0]?.id),
      kind: "api_key",
    });
    await admin("/admin/v1/groups/access", {
      group_id: String(groups[0]?.id),
      kind: "join_code",
    });
    await env.DB.batch([
      attemptStatement(
        "attempt_duplicate",
        "request_duplicate",
        String(groups[0]?.id),
        {
          statusCode: 200,
          errorClass: null,
          inputTokens: 5,
          outputTokens: 7,
          costMicrocents: 11,
        },
      ),
    ]);
    const duplicate = await admin("/admin/v1/classes/duplicate", {
      id: classId,
      name: "Period 1 (copy)",
      starts_at: timestamp + 7200,
      expires_at: timestamp + 10_800,
    });
    expect(duplicate.status, await duplicate.clone().text()).toBe(201);
    const { id: copyId } = await json<{ id: string }>(duplicate);
    expect(copyId).not.toBe(classId);
    const list = await adminJson<{ classes: Record<string, unknown>[] }>(
      "/admin/v1/classes/list",
      {},
    );
    const copy = list.classes.find((entry) => entry.id === copyId);
    expect(copy).toMatchObject({
      product_id: "prod_classroom",
      environment_id: "env_classroom",
      tenant_id: "tenant_classroom",
      name: "Period 1 (copy)",
      course: "CS101",
      capabilities: ["text.chat.v1"],
      budget_microcents: 1_000_000,
      group_budget_microcents: 4000,
      rpm_limit: 30,
      tpm_limit: 100_000,
      concurrency_limit: 2,
      status: "active",
      starts_at: timestamp + 7200,
      expires_at: timestamp + 10_800,
    });
    const copied = await adminJson<{
      groups: Record<string, unknown>[];
      keys: unknown[];
      codes: unknown[];
    }>("/admin/v1/groups/list", { class_id: copyId });
    expect(copied.groups.map((entry) => entry.name)).toEqual(["Alpha", "Beta"]);
    expect(copied.groups.map((entry) => entry.status)).toEqual([
      "active",
      "active",
    ]);
    expect(copied.groups.map((entry) => entry.budget_microcents)).toEqual([
      4000, 900,
    ]);
    const copiedIds = copied.groups.map((entry) => entry.id);
    expect(new Set(copiedIds).size).toBe(2);
    expect(copiedIds).not.toContain(groups[0]?.id);
    expect(copiedIds).not.toContain(groups[1]?.id);
    expect(copied.keys).toEqual([]);
    expect(copied.codes).toEqual([]);
    const usage = await adminJson<{ totals: Record<string, unknown> }>(
      "/admin/v1/classes/usage",
      { class_id: copyId },
    );
    expect(usage.totals).toMatchObject({ requests: 0, pending_requests: 0 });
    expect(
      (
        await admin("/admin/v1/classes/duplicate", {
          id: classId,
          name: "Past copy",
          starts_at: timestamp - 7200,
          expires_at: timestamp - 3600,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await admin("/admin/v1/classes/duplicate", {
          id: "class_missing",
          name: "Ghost",
          starts_at: timestamp,
          expires_at: timestamp + 60,
        })
      ).status,
    ).toBe(404);
  });

  it("clears copied group schedules so duplicated groups inherit the new class window", async () => {
    const timestamp = now();
    const classId = await createClass({
      starts_at: timestamp - 7200,
      expires_at: timestamp + 3600,
    });
    const [group] = await createGroups(classId, ["Alpha"]);
    // An override that is now expired, as happens after a class window narrows.
    await env.DB.prepare(
      "UPDATE classroom_groups SET starts_at = ?, expires_at = ? WHERE id = ?",
    )
      .bind(timestamp - 7200, timestamp - 60, String(group?.id))
      .run();
    const duplicate = await admin("/admin/v1/classes/duplicate", {
      id: classId,
      name: "Next term",
      starts_at: timestamp + 7200,
      expires_at: timestamp + 10_800,
    });
    expect(duplicate.status, await duplicate.clone().text()).toBe(201);
    const { id: copyId } = await json<{ id: string }>(duplicate);
    const copied = await adminJson<{ groups: Record<string, unknown>[] }>(
      "/admin/v1/groups/list",
      { class_id: copyId },
    );
    expect(copied.groups).toHaveLength(1);
    expect(copied.groups[0]).toMatchObject({
      name: "Alpha",
      starts_at: null,
      expires_at: null,
    });
    // The inherited window makes the copied group usable rather than expired.
    const issued = await admin("/admin/v1/groups/access", {
      group_id: String(copied.groups[0]?.id),
      kind: "join_code",
    });
    expect(issued.status, await issued.clone().text()).toBe(201);
    const { id: codeId } = await json<{ id: string }>(issued);
    const code = await env.DB.prepare(
      "SELECT expires_at, classroom_group_id FROM access_codes WHERE id = ?",
    )
      .bind(codeId)
      .first<{ expires_at: number; classroom_group_id: string }>();
    expect(code).toEqual({
      expires_at: timestamp + 10_800,
      classroom_group_id: String(copied.groups[0]?.id),
    });
  });

  it("projects lifetime usage per group with pending intents separated from finalized usage", async () => {
    const classId = await createClass();
    const groups = await createGroups(classId, ["Alpha", "Beta", "Gamma"]);
    const alpha = String(groups[0]?.id);
    const beta = String(groups[1]?.id);
    const gamma = String(groups[2]?.id);
    await env.DB.batch([
      attemptStatement("attempt_a1", "request_a1", alpha, {
        statusCode: 200,
        errorClass: null,
        inputTokens: 5,
        outputTokens: 7,
        costMicrocents: 10,
      }),
      attemptStatement("attempt_a2", "request_a2", alpha, {
        statusCode: 504,
        errorClass: "provider_timeout",
        inputTokens: 3,
        outputTokens: 4,
        costMicrocents: 5,
      }),
      attemptStatement("attempt_a3", "request_a3", alpha, {
        statusCode: 0,
        errorClass: "attempt_started",
        inputTokens: 50,
        outputTokens: 60,
        costMicrocents: 100,
      }),
      attemptStatement("attempt_b1", "request_b1", beta, {
        statusCode: 200,
        errorClass: null,
        inputTokens: 1000,
        outputTokens: 2000,
        costMicrocents: 3000,
      }),
      attemptStatement("attempt_unattributed", "request_unattributed", null, {
        statusCode: 200,
        errorClass: null,
        inputTokens: 9999,
        outputTokens: 9999,
        costMicrocents: 9999,
      }),
    ]);
    const usage = await adminJson<{
      class_id: string;
      groups: Record<string, unknown>[];
      totals: Record<string, unknown>;
      truncated: boolean;
    }>("/admin/v1/classes/usage", { class_id: classId });
    expect(usage.class_id).toBe(classId);
    expect(usage.truncated).toBe(false);
    expect(usage.groups.map((group) => group.group_id)).toEqual([
      alpha,
      beta,
      gamma,
    ]);
    expect(usage.groups[0]).toEqual({
      group_id: alpha,
      requests: 2,
      input_tokens: "8",
      output_tokens: "11",
      cost_microcents: "15",
      pending_requests: 1,
      pending_cost_microcents: "100",
    });
    expect(usage.groups[1]).toEqual({
      group_id: beta,
      requests: 1,
      input_tokens: "1000",
      output_tokens: "2000",
      cost_microcents: "3000",
      pending_requests: 0,
      pending_cost_microcents: "0",
    });
    expect(usage.groups[2]).toEqual({
      group_id: gamma,
      requests: 0,
      input_tokens: "0",
      output_tokens: "0",
      cost_microcents: "0",
      pending_requests: 0,
      pending_cost_microcents: "0",
    });
    expect(usage.totals).toEqual({
      requests: 3,
      input_tokens: "1008",
      output_tokens: "2011",
      cost_microcents: "3015",
      pending_requests: 1,
      pending_cost_microcents: "100",
    });
    expect(
      (await admin("/admin/v1/classes/usage", { class_id: "class_missing" }))
        .status,
    ).toBe(404);
  });

  it("bounds the usage group list without truncating sums", async () => {
    const classId = await createClass();
    const timestamp = now();
    const statements = Array.from({ length: 501 }, (_, index) =>
      groupStatement(
        `group_usage_${index}`,
        classId,
        `g${String(index).padStart(3, "0")}`,
        timestamp,
      ),
    );
    for (let offset = 0; offset < statements.length; offset += 200)
      await env.DB.batch(statements.slice(offset, offset + 200));
    await env.DB.batch([
      attemptStatement(
        "attempt_omitted",
        "request_omitted",
        "group_usage_500",
        {
          statusCode: 200,
          errorClass: null,
          inputTokens: 7,
          outputTokens: 9,
          costMicrocents: 42,
        },
      ),
    ]);
    const usage = await adminJson<{
      groups: Record<string, unknown>[];
      totals: Record<string, unknown>;
      truncated: boolean;
    }>("/admin/v1/classes/usage", { class_id: classId });
    expect(usage.groups).toHaveLength(500);
    expect(usage.truncated).toBe(true);
    expect(usage.groups.map((group) => group.group_id)).not.toContain(
      "group_usage_500",
    );
    expect(usage.totals).toEqual({
      requests: 1,
      input_tokens: "7",
      output_tokens: "9",
      cost_microcents: "42",
      pending_requests: 0,
      pending_cost_microcents: "0",
    });
  });
});

describe("classroom class options", () => {
  it("offers enabled environments with enabled distinct aliases and no provider details", async () => {
    const timestamp = now();
    const alias = (
      id: string,
      productId: string,
      environmentId: string,
      name: string,
      endpoint: string,
      enabled = 1,
    ) =>
      env.DB.prepare(
        `INSERT INTO aliases
           (id, product_id, environment_id, alias, endpoint, route_id, max_input_tokens,
            max_output_tokens, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 1000, 100, ?, ?, ?)`,
      ).bind(
        id,
        productId,
        environmentId,
        name,
        endpoint,
        `route_${id}`,
        enabled,
        timestamp,
        timestamp,
      );
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO environments (id, product_id, name, audience, created_at, updated_at)
         VALUES ('env_second', 'prod_classroom', 'second', 'classroom:second', ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO environments (id, product_id, name, audience, enabled, created_at, updated_at)
         VALUES ('env_disabled', 'prod_classroom', 'disabled', 'classroom:disabled', 0, ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO environments (id, product_id, name, audience, kill_switch, created_at, updated_at)
         VALUES ('env_killed', 'prod_classroom', 'killed', 'classroom:killed', 1, ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO products (id, slug, display_name, enabled, created_at, updated_at)
         VALUES ('prod_disabled', 'disabled-fixture', 'Disabled fixture', 0, ?, ?)`,
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        `INSERT INTO environments (id, product_id, name, audience, created_at, updated_at)
         VALUES ('env_hidden', 'prod_disabled', 'hidden', 'hidden:test', ?, ?)`,
      ).bind(timestamp, timestamp),
      alias(
        "alias_dual_chat",
        "prod_classroom",
        "env_classroom",
        "dual.endpoint.v1",
        "chat",
      ),
      alias(
        "alias_dual_responses",
        "prod_classroom",
        "env_classroom",
        "dual.endpoint.v1",
        "responses",
      ),
      alias(
        "alias_second",
        "prod_classroom",
        "env_second",
        "second.only.v1",
        "chat",
      ),
      alias(
        "alias_second_disabled",
        "prod_classroom",
        "env_second",
        "second.off.v1",
        "chat",
        0,
      ),
      alias(
        "alias_hidden",
        "prod_disabled",
        "env_hidden",
        "hidden.only.v1",
        "chat",
      ),
    ]);

    const response = await admin("/admin/v1/classes/options", {});
    expect(response.status, await response.clone().text()).toBe(200);
    const text = await response.clone().text();
    const body = JSON.parse(text) as {
      environments: {
        product_id: string;
        environment_id: string;
        product_name: string;
        environment_name: string;
        aliases: string[];
      }[];
      truncated: boolean;
    };
    expect(body.truncated).toBe(false);
    // Ordered by product display name then environment name.
    expect(body.environments.map((entry) => entry.environment_id)).toEqual([
      "env_second",
      "env_classroom",
    ]);
    // Environment guardrails are non-secret and shown so class limits can be
    // chosen within them; these rows use the column defaults.
    const defaultLimits = {
      policy_version: 1,
      token_ttl_seconds: 900,
      rpm_limit: 30,
      tpm_limit: 100_000,
      concurrency_limit: 2,
      daily_budget_microcents: 1_000_000,
      max_request_bytes: 1_048_576,
    };
    expect(body.environments[0]).toEqual({
      product_id: "prod_classroom",
      environment_id: "env_second",
      product_name: "Classroom fixture",
      environment_name: "second",
      aliases: ["second.only.v1"],
      limits: defaultLimits,
    });
    expect(body.environments[1]).toEqual({
      product_id: "prod_classroom",
      environment_id: "env_classroom",
      product_name: "Classroom fixture",
      environment_name: "test",
      aliases: ["dual.endpoint.v1", "json.strict.v1", "text.chat.v1"],
      limits: defaultLimits,
    });
    // Disabled aliases, disabled or killed environments, and other products are omitted.
    expect(text).not.toContain("vision.classify.v1");
    expect(text).not.toContain("second.off.v1");
    expect(text).not.toContain("hidden.only.v1");
    expect(text).not.toContain("env_disabled");
    expect(text).not.toContain("env_killed");
    expect(text).not.toContain("env_hidden");
    // Only public alias names are projected; route and model details never appear.
    expect(text).not.toContain("route_");
    expect(text).not.toContain("fixture-model");
    expect(text).not.toContain("secret");
    for (const entry of body.environments)
      expect(Object.keys(entry).sort()).toEqual([
        "aliases",
        "environment_id",
        "environment_name",
        "limits",
        "product_id",
        "product_name",
      ]);
  });

  it("bounds the options list at 250 environments and 50 aliases per environment", async () => {
    const timestamp = now();
    const environments = Array.from({ length: 251 }, (_, index) =>
      env.DB.prepare(
        `INSERT INTO environments (id, product_id, name, audience, created_at, updated_at)
         VALUES (?, 'prod_classroom', ?, ?, ?, ?)`,
      ).bind(
        `env_bulk_${index}`,
        `bulk-${String(index).padStart(3, "0")}`,
        `classroom:bulk:${index}`,
        timestamp,
        timestamp,
      ),
    );
    for (let offset = 0; offset < environments.length; offset += 100)
      await env.DB.batch(environments.slice(offset, offset + 100));
    const aliases = Array.from({ length: 51 }, (_, index) =>
      env.DB.prepare(
        `INSERT INTO aliases
           (id, product_id, environment_id, alias, endpoint, route_id, max_input_tokens,
            max_output_tokens, created_at, updated_at)
         VALUES (?, 'prod_classroom', 'env_bulk_0', ?, 'chat', ?, 1000, 100, ?, ?)`,
      ).bind(
        `alias_bulk_${index}`,
        `bulk.${String(index).padStart(2, "0")}.v1`,
        `route_bulk_${index}`,
        timestamp,
        timestamp,
      ),
    );
    for (let offset = 0; offset < aliases.length; offset += 50)
      await env.DB.batch(aliases.slice(offset, offset + 50));

    const body = await adminJson<{
      environments: { environment_id: string; aliases: string[] }[];
      truncated: boolean;
    }>("/admin/v1/classes/options", {});
    expect(body.truncated).toBe(true);
    expect(body.environments).toHaveLength(250);
    const bulk = body.environments.find(
      (entry) => entry.environment_id === "env_bulk_0",
    );
    expect(bulk?.aliases).toHaveLength(50);
    expect(bulk?.aliases[0]).toBe("bulk.00.v1");
    expect(bulk?.aliases[49]).toBe("bulk.49.v1");
  });

  it("requires the same admin authentication as the rest of the classroom surface", async () => {
    expect(
      (
        await handleControlPlane(
          request("/admin/v1/classes/options", {}),
          controlEnv,
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handleControlPlane(
          request(
            "/admin/v1/classes/options",
            { extra: true },
            String(env.ADMIN_TOKEN),
          ),
          controlEnv,
        )
      ).status,
    ).toBe(400);
  });
});

describe("classroom group pause", () => {
  it("pauses and resumes a group reversibly with audited state", async () => {
    const classId = await createClass();
    const [group] = await createGroups(classId, ["Alpha"]);
    const groupId = String(group?.id);
    const listGroup = async (): Promise<Record<string, unknown>> => {
      const list = await adminJson<{ groups: Record<string, unknown>[] }>(
        "/admin/v1/groups/list",
        { class_id: classId },
      );
      return list.groups[0] ?? {};
    };

    const paused = await admin("/admin/v1/groups/update", {
      id: groupId,
      paused: true,
    });
    expect(paused.status, await paused.clone().text()).toBe(200);
    const first = await listGroup();
    expect(first).toMatchObject({ status: "active", paused: true });
    expect(first.paused_at).toEqual(anyNumber());
    await env.DB.prepare(
      "UPDATE classroom_groups SET paused_at = 1 WHERE id = ?",
    )
      .bind(groupId)
      .run();
    // Pausing again keeps the original pause time.
    expect(
      (await admin("/admin/v1/groups/update", { id: groupId, paused: true }))
        .status,
    ).toBe(200);
    expect(await listGroup()).toMatchObject({ paused: true, paused_at: 1 });

    const resumed = await admin("/admin/v1/groups/update", {
      id: groupId,
      paused: false,
    });
    expect(resumed.status).toBe(200);
    expect(await listGroup()).toMatchObject({
      status: "active",
      paused: false,
      paused_at: null,
    });
    expect(
      (
        await admin("/admin/v1/groups/update", {
          id: groupId,
          paused: true,
          budget_microcents: 5,
        })
      ).status,
    ).toBe(200);
    const audits = await env.DB.prepare(
      `SELECT action FROM admin_audit
        WHERE resource_type = 'classroom_group' AND action <> 'create'
        ORDER BY rowid`,
    ).all<{ action: string }>();
    expect(audits.results.map((row) => row.action)).toEqual([
      "pause",
      "pause",
      "resume",
      "update",
    ]);

    expect(
      (await admin("/admin/v1/groups/update", { id: groupId, paused: "yes" }))
        .status,
    ).toBe(400);
    expect(
      (
        await admin("/admin/v1/groups/update", {
          id: groupId,
          status: "revoked",
        })
      ).status,
    ).toBe(200);
    for (const pausedValue of [true, false])
      expect(
        (
          await admin("/admin/v1/groups/update", {
            id: groupId,
            paused: pausedValue,
          })
        ).status,
      ).toBe(409);
  });

  it("blocks new and renewing activations while paused and restores them on resume", async () => {
    const classId = await createClass();
    const [group] = await createGroups(classId, ["Alpha"]);
    const groupId = String(group?.id);
    const issued = await json<{ id: string; access_code: string }>(
      await admin("/admin/v1/groups/access", {
        group_id: groupId,
        kind: "join_code",
      }),
    );
    const activate = (device: string) =>
      handleControlPlane(
        request("/v1/activations", {
          access_code: issued.access_code,
          device_id: device,
        }),
        controlEnv,
      );
    expect((await activate("classroom-device-a")).status).toBe(200);
    await admin("/admin/v1/groups/update", { id: groupId, paused: true });
    const renewal = await activate("classroom-device-a");
    expect(renewal.status).toBe(403);
    expect(await renewal.json()).toMatchObject({
      error: { message: "classroom group is paused" },
    });
    expect((await activate("classroom-device-b")).status).toBe(403);
    await admin("/admin/v1/groups/update", { id: groupId, paused: false });
    expect((await activate("classroom-device-a")).status).toBe(200);
    expect((await activate("classroom-device-b")).status).toBe(200);
  });
});

describe("classroom group names", () => {
  it("returns 409 for a rename onto an existing group name", async () => {
    const classId = await createClass();
    const [alpha] = await createGroups(classId, ["Alpha", "Beta"]);
    const response = await admin("/admin/v1/groups/update", {
      id: String(alpha?.id),
      name: "Beta",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: {
        code: "conflict",
        message: "a group with that name already exists",
      },
    });
    // Renaming to its own name is not a conflict.
    expect(
      (
        await admin("/admin/v1/groups/update", {
          id: String(alpha?.id),
          name: "Alpha",
        })
      ).status,
    ).toBe(200);
  });

  it("returns 409 when a concurrent writer claims a name after the probe", async () => {
    const classId = await createClass();
    const racing = racingEnv(
      (sql) => sql.includes("SELECT name FROM classroom_groups"),
      async () => {
        await groupStatement("group_racer", classId, "Alpha", now()).run();
      },
    );
    const response = await handleControlPlane(
      controlRequest("/admin/v1/groups", {
        class_id: classId,
        names: ["Alpha", "Beta"],
      }),
      racing,
    );
    expect(response.status, await response.clone().text()).toBe(409);
    const names = await env.DB.prepare(
      "SELECT name FROM classroom_groups WHERE class_id = ?",
    )
      .bind(classId)
      .all<{ name: string }>();
    expect(names.results).toEqual([{ name: "Alpha" }]);
  });
});

describe("classroom group key issuance", () => {
  it("returns and stores a four-character key hint for issued and rotated keys", async () => {
    const classId = await createClass();
    const [group] = await createGroups(classId, ["Alpha"]);
    const issued = await json<{
      id: string;
      api_key: string;
      key_hint: string;
    }>(
      await admin("/admin/v1/groups/access", {
        group_id: String(group?.id),
        kind: "api_key",
      }),
    );
    expect(issued.key_hint).toBe(issued.api_key.slice(-4));
    const rotated = await json<{
      id: string;
      api_key: string;
      key_hint: string;
    }>(await admin("/admin/v1/groups/rotate", { id: issued.id }));
    expect(rotated.key_hint).toBe(rotated.api_key.slice(-4));
    const stored = await env.DB.prepare(
      "SELECT id, key_hint FROM classroom_group_keys ORDER BY created_at, rowid",
    ).all<{ id: string; key_hint: string }>();
    expect(stored.results).toEqual([
      { id: issued.id, key_hint: issued.key_hint },
      { id: rotated.id, key_hint: rotated.key_hint },
    ]);
    const listText = await (
      await admin("/admin/v1/groups/list", { class_id: classId })
    ).text();
    expect(listText).not.toContain(issued.api_key);
    expect(listText).not.toContain(rotated.api_key);
    const list = JSON.parse(listText) as {
      keys: { id: string; key_hint: string | null }[];
    };
    expect(list.keys).toEqual([
      expect.objectContaining({ id: rotated.id, key_hint: rotated.key_hint }),
      expect.objectContaining({ id: issued.id, key_hint: issued.key_hint }),
    ]);
  });

  it("lists live keys newest first so rotation history cannot hide them", async () => {
    const classId = await createClass();
    const [group] = await createGroups(classId, ["Alpha"]);
    const groupId = String(group?.id);
    const timestamp = now();
    const statements = Array.from({ length: 501 }, (_, index) =>
      env.DB.prepare(
        `INSERT INTO classroom_group_keys
           (id, group_id, secret_hash, expires_at, revoked_at, created_at)
         VALUES (?, ?, ?, NULL, ?, ?)`,
      ).bind(
        `gkey_old_${index}`,
        groupId,
        `hash_old_${index}`,
        timestamp - 10,
        timestamp - 10_000 + index,
      ),
    );
    for (let offset = 0; offset < statements.length; offset += 100)
      await env.DB.batch(statements.slice(offset, offset + 100));
    const live = await json<{ id: string }>(
      await admin("/admin/v1/groups/access", {
        group_id: groupId,
        kind: "api_key",
      }),
    );
    const list = await adminJson<{
      keys: {
        id: string;
        key_hint: string | null;
        revoked_at: number | null;
      }[];
      truncated: boolean;
    }>("/admin/v1/groups/list", { class_id: classId });
    expect(list.truncated).toBe(true);
    expect(list.keys).toHaveLength(500);
    expect(list.keys[0]).toMatchObject({ id: live.id, revoked_at: null });
    // Older revoked rows follow newest first; pre-hint rows report null.
    expect(list.keys[1]).toMatchObject({ id: "gkey_old_500", key_hint: null });
  });

  it("refuses API keys for ended schedules and disjoint model policies", async () => {
    const timestamp = now();
    const classId = await createClass();
    const [alpha, beta] = await createGroups(classId, ["Alpha", "Beta"]);
    const issuedResponse = await admin("/admin/v1/groups/access", {
      group_id: String(alpha?.id),
      kind: "api_key",
    });
    expect(issuedResponse.status).toBe(201);
    const issued = await json<{ id: string }>(issuedResponse);
    await env.DB.prepare(
      "UPDATE classroom_groups SET expires_at = ? WHERE id = ?",
    )
      .bind(timestamp - 1, String(alpha?.id))
      .run();
    // Rotation applies the same issuance checks as a new key.
    const rotated = await admin("/admin/v1/groups/rotate", { id: issued.id });
    expect(rotated.status).toBe(409);
    expect(await rotated.json()).toMatchObject({
      error: { message: "class or group schedule has already ended" },
    });
    for (const kind of ["api_key", "join_code"]) {
      const response = await admin("/admin/v1/groups/access", {
        group_id: String(alpha?.id),
        kind,
      });
      expect(response.status, kind).toBe(409);
      expect(await response.json()).toMatchObject({
        error: { message: "class or group schedule has already ended" },
      });
    }
    await admin("/admin/v1/groups/update", {
      id: String(beta?.id),
      capabilities: ["json.strict.v1"],
    });
    await admin("/admin/v1/classes/update", {
      id: classId,
      capabilities: ["text.chat.v1"],
    });
    for (const kind of ["api_key", "join_code"]) {
      const response = await admin("/admin/v1/groups/access", {
        group_id: String(beta?.id),
        kind,
      });
      expect(response.status, kind).toBe(409);
      expect(await response.json()).toMatchObject({
        error: {
          message: "class and group capability policies do not intersect",
        },
      });
    }
    await env.DB.prepare(
      "UPDATE classroom_classes SET starts_at = ?, expires_at = ? WHERE id = ?",
    )
      .bind(timestamp - 7200, timestamp - 60, classId)
      .run();
    await admin("/admin/v1/classes/update", {
      id: classId,
      capabilities: ["text.chat.v1", "json.strict.v1"],
    });
    expect(
      (
        await admin("/admin/v1/groups/access", {
          group_id: String(beta?.id),
          kind: "api_key",
        })
      ).status,
    ).toBe(409);
    // Only the key issued before the schedule ended exists.
    expect(await countRows("classroom_group_keys")).toBe(1);
  });
});

describe("classroom bulk key issuance", () => {
  type BulkResponse = {
    class_id: string;
    keys: {
      group_id: string;
      group_name: string;
      key_id: string;
      api_key: string;
      key_hint: string;
      expires_at: number | null;
    }[];
    skipped: { group_id: string; group_name: string | null; reason: string }[];
    truncated: boolean;
    warning: string;
  };

  async function bulk(body: unknown): Promise<Response> {
    return await admin("/admin/v1/groups/access-bulk", body);
  }

  it("issues one key per active unpaused group by default, storing only digests", async () => {
    const classId = await createClass();
    const [alpha, beta, gamma, delta] = await createGroups(classId, [
      "Alpha",
      "Beta",
      "Gamma",
      "Delta",
    ]);
    await admin("/admin/v1/groups/update", {
      id: String(beta?.id),
      paused: true,
    });
    await admin("/admin/v1/groups/update", {
      id: String(gamma?.id),
      status: "revoked",
    });
    const response = await bulk({ class_id: classId });
    expect(response.status, await response.clone().text()).toBe(201);
    const body = await json<BulkResponse>(response);
    expect(body).toMatchObject({
      class_id: classId,
      skipped: [],
      truncated: false,
      warning: "shown once",
    });
    expect(body.keys.map((key) => key.group_name)).toEqual(["Alpha", "Delta"]);
    expect(body.keys.map((key) => key.group_id)).toEqual([
      alpha?.id,
      delta?.id,
    ]);
    for (const key of body.keys) {
      expect(key.api_key.startsWith("tkgk_")).toBe(true);
      expect(key.key_hint).toBe(key.api_key.slice(-4));
      expect(key.expires_at).toBeNull();
      const stored = await env.DB.prepare(
        "SELECT group_id, secret_hash, key_hint, expires_at, revoked_at FROM classroom_group_keys WHERE id = ?",
      )
        .bind(key.key_id)
        .first();
      expect(stored).toEqual({
        group_id: key.group_id,
        secret_hash: await sha256(key.api_key),
        key_hint: key.key_hint,
        expires_at: null,
        revoked_at: null,
      });
    }
    const audits = await env.DB.prepare(
      `SELECT resource_id FROM admin_audit
        WHERE action = 'create' AND resource_type = 'classroom_group_key'
        ORDER BY resource_id`,
    ).all<{ resource_id: string }>();
    expect(audits.results.map((row) => row.resource_id)).toEqual(
      body.keys.map((key) => key.key_id).sort(),
    );
    const listText = await (
      await admin("/admin/v1/groups/list", { class_id: classId })
    ).text();
    for (const key of body.keys) expect(listText).not.toContain(key.api_key);
  });

  it("reports skipped groups instead of failing the batch", async () => {
    const timestamp = now();
    const classId = await createClass();
    const otherClassId = await createClass({ name: "Other" });
    const [alpha, paused, revoked, ended, disjoint] = await createGroups(
      classId,
      ["Alpha", "Paused", "Revoked", "Ended", "Disjoint"],
    );
    const [foreign] = await createGroups(otherClassId, ["Foreign"]);
    await admin("/admin/v1/groups/update", {
      id: String(paused?.id),
      paused: true,
    });
    await admin("/admin/v1/groups/update", {
      id: String(revoked?.id),
      status: "revoked",
    });
    await env.DB.prepare(
      "UPDATE classroom_groups SET expires_at = ? WHERE id = ?",
    )
      .bind(timestamp - 1, String(ended?.id))
      .run();
    await env.DB.prepare(
      "UPDATE classroom_groups SET capabilities_json = '[\"vision.classify.v1\"]' WHERE id = ?",
    )
      .bind(String(disjoint?.id))
      .run();
    const expiresAt = timestamp + 600;
    const response = await bulk({
      class_id: classId,
      group_ids: [
        alpha?.id,
        paused?.id,
        revoked?.id,
        ended?.id,
        disjoint?.id,
        foreign?.id,
        "group_missing",
        alpha?.id,
      ],
      expires_at: expiresAt,
    });
    expect(response.status, await response.clone().text()).toBe(201);
    const body = await json<BulkResponse>(response);
    // Explicitly named paused groups receive keys that work once resumed.
    expect(body.keys.map((key) => [key.group_name, key.expires_at])).toEqual([
      ["Alpha", expiresAt],
      ["Paused", expiresAt],
    ]);
    expect(body.skipped).toEqual([
      {
        group_id: foreign?.id,
        group_name: null,
        reason: "group not found in this class",
      },
      {
        group_id: "group_missing",
        group_name: null,
        reason: "group not found in this class",
      },
      {
        group_id: revoked?.id,
        group_name: "Revoked",
        reason: "group is revoked",
      },
      {
        group_id: ended?.id,
        group_name: "Ended",
        reason: "class or group schedule has already ended",
      },
      {
        group_id: disjoint?.id,
        group_name: "Disjoint",
        reason: "class and group capability policies do not intersect",
      },
    ]);
    expect(await countRows("classroom_group_keys")).toBe(2);
  });

  it("covers 100 groups in one request and discloses truncation", async () => {
    const classId = await createClass();
    const names = Array.from(
      { length: 101 },
      (_, index) => `g${String(index).padStart(3, "0")}`,
    );
    await createGroups(classId, names.slice(0, 100));
    await createGroups(classId, names.slice(100));
    const body = await json<BulkResponse>(await bulk({ class_id: classId }));
    expect(body.keys).toHaveLength(100);
    expect(body.keys[0]?.group_name).toBe("g000");
    expect(body.keys[99]?.group_name).toBe("g099");
    expect(body.truncated).toBe(true);
    expect(new Set(body.keys.map((key) => key.api_key)).size).toBe(100);
    expect(await countRows("classroom_group_keys")).toBe(100);
    const audits = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM admin_audit WHERE resource_type = 'classroom_group_key'",
    ).first<{ count: number }>();
    expect(audits).toEqual({ count: 100 });
    expect(
      (
        await bulk({
          class_id: classId,
          group_ids: Array.from({ length: 101 }, (_, index) => `g_${index}`),
        })
      ).status,
    ).toBe(400);
  });

  it("rejects missing, revoked, and ended classes and past expiry", async () => {
    const timestamp = now();
    const classId = await createClass();
    await createGroups(classId, ["Alpha"]);
    expect((await bulk({ class_id: "class_missing" })).status).toBe(404);
    expect(
      (await bulk({ class_id: classId, expires_at: timestamp - 1 })).status,
    ).toBe(400);
    expect((await bulk({ class_id: classId, group_ids: [] })).status).toBe(400);
    expect((await bulk({ class_id: classId, extra: true })).status).toBe(400);
    await env.DB.prepare(
      "UPDATE classroom_classes SET starts_at = ?, expires_at = ? WHERE id = ?",
    )
      .bind(timestamp - 7200, timestamp - 60, classId)
      .run();
    const ended = await bulk({ class_id: classId });
    expect(ended.status).toBe(409);
    expect(await ended.json()).toMatchObject({
      error: { message: "class schedule has already ended" },
    });
    await admin("/admin/v1/classes/update", { id: classId, status: "revoked" });
    expect((await bulk({ class_id: classId })).status).toBe(409);
    expect(await countRows("classroom_group_keys")).toBe(0);
  });

  it("does not issue keys for a group revoked between read and write", async () => {
    const classId = await createClass();
    const [alpha, beta] = await createGroups(classId, ["Alpha", "Beta"]);
    const racing = racingEnv(
      (sql) => sql.includes("paused_at IS NULL"),
      async () => {
        await env.DB.prepare(
          "UPDATE classroom_groups SET status = 'revoked' WHERE id = ?",
        )
          .bind(String(beta?.id))
          .run();
      },
    );
    const response = await handleControlPlane(
      controlRequest("/admin/v1/groups/access-bulk", { class_id: classId }),
      racing,
    );
    expect(response.status, await response.clone().text()).toBe(201);
    const body = await json<BulkResponse>(response);
    expect(body.keys.map((key) => key.group_id)).toEqual([alpha?.id]);
    expect(body.skipped).toEqual([
      {
        group_id: beta?.id,
        group_name: "Beta",
        reason: "group or class was revoked during issuance",
      },
    ]);
    expect(await countRows("classroom_group_keys")).toBe(1);
    const audits = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM admin_audit WHERE resource_type = 'classroom_group_key'",
    ).first<{ count: number }>();
    expect(audits).toEqual({ count: 1 });
  });
});

describe("classroom bulk budgets", () => {
  type BudgetResponse = {
    class_id: string;
    mode: string;
    groups: {
      group_id: string;
      group_name: string;
      budget_microcents: number;
    }[];
    skipped: { group_id: string; group_name: string | null; reason: string }[];
    class_budget_microcents?: number;
  };

  it("sets or adds group allocations and optionally the class total", async () => {
    const classId = await createClass({ group_budget_microcents: 1000 });
    const [alpha, beta, gamma] = await createGroups(classId, [
      "Alpha",
      "Beta",
      "Gamma",
    ]);
    await admin("/admin/v1/groups/update", {
      id: String(beta?.id),
      paused: true,
    });
    await admin("/admin/v1/groups/update", {
      id: String(gamma?.id),
      status: "revoked",
    });
    const added = await admin("/admin/v1/groups/budget-bulk", {
      class_id: classId,
      mode: "add",
      budget_microcents: 500,
      class_budget_microcents: 9_000_000,
    });
    expect(added.status, await added.clone().text()).toBe(200);
    expect(await json<BudgetResponse>(added)).toEqual({
      class_id: classId,
      mode: "add",
      groups: [
        { group_id: alpha?.id, group_name: "Alpha", budget_microcents: 1500 },
        { group_id: beta?.id, group_name: "Beta", budget_microcents: 1500 },
      ],
      skipped: [],
      truncated: false,
      class_budget_microcents: 9_000_000,
    });
    const set = await json<BudgetResponse>(
      await admin("/admin/v1/groups/budget-bulk", {
        class_id: classId,
        group_ids: [alpha?.id, gamma?.id, "group_missing"],
        mode: "set",
        budget_microcents: 42,
      }),
    );
    expect(set.groups).toEqual([
      { group_id: alpha?.id, group_name: "Alpha", budget_microcents: 42 },
    ]);
    expect(set.skipped).toEqual([
      {
        group_id: "group_missing",
        group_name: null,
        reason: "group not found in this class",
      },
      { group_id: gamma?.id, group_name: "Gamma", reason: "group is revoked" },
    ]);
    expect(set.class_budget_microcents).toBeUndefined();
    const rows = await env.DB.prepare(
      "SELECT name, budget_microcents FROM classroom_groups WHERE class_id = ? ORDER BY name",
    )
      .bind(classId)
      .all();
    expect(rows.results).toEqual([
      { name: "Alpha", budget_microcents: 42 },
      { name: "Beta", budget_microcents: 1500 },
      { name: "Gamma", budget_microcents: 1000 },
    ]);
    const classBudget = await env.DB.prepare(
      "SELECT budget_microcents FROM classroom_classes WHERE id = ?",
    )
      .bind(classId)
      .first("budget_microcents");
    expect(classBudget).toBe(9_000_000);
    const audits = await env.DB.prepare(
      `SELECT action, resource_type, resource_id FROM admin_audit
        WHERE action LIKE 'budget_%' ORDER BY rowid`,
    ).all<{ action: string; resource_type: string; resource_id: string }>();
    expect(audits.results).toEqual([
      {
        action: "budget_set",
        resource_type: "classroom_class",
        resource_id: classId,
      },
      {
        action: "budget_add",
        resource_type: "classroom_group",
        resource_id: expect.any(String) as string,
      },
      {
        action: "budget_add",
        resource_type: "classroom_group",
        resource_id: expect.any(String) as string,
      },
      {
        action: "budget_set",
        resource_type: "classroom_group",
        resource_id: alpha?.id,
      },
    ]);
  });

  it("saturates additions at the stored maximum and validates input", async () => {
    const classId = await createClass();
    const [alpha] = await createGroups(classId, ["Alpha"]);
    await admin("/admin/v1/groups/update", {
      id: String(alpha?.id),
      budget_microcents: 999_999_999_999_990,
    });
    const body = await json<BudgetResponse>(
      await admin("/admin/v1/groups/budget-bulk", {
        class_id: classId,
        mode: "add",
        budget_microcents: 1_000,
      }),
    );
    expect(body.groups[0]?.budget_microcents).toBe(1_000_000_000_000_000);
    for (const invalid of [
      { class_id: classId, mode: "multiply", budget_microcents: 1 },
      { class_id: classId, mode: "set", budget_microcents: -1 },
      {
        class_id: classId,
        mode: "set",
        budget_microcents: 1_000_000_000_000_001,
      },
      { class_id: classId, mode: "set" },
      { class_id: classId, mode: "set", budget_microcents: 1, extra: 1 },
    ])
      expect(
        (await admin("/admin/v1/groups/budget-bulk", invalid)).status,
        JSON.stringify(invalid),
      ).toBe(400);
    expect(
      (
        await admin("/admin/v1/groups/budget-bulk", {
          class_id: "class_missing",
          mode: "set",
          budget_microcents: 1,
        })
      ).status,
    ).toBe(404);
    await admin("/admin/v1/classes/update", { id: classId, status: "revoked" });
    expect(
      (
        await admin("/admin/v1/groups/budget-bulk", {
          class_id: classId,
          mode: "set",
          budget_microcents: 1,
        })
      ).status,
    ).toBe(409);
  });
});

describe("ended class maintenance", () => {
  it("tops up and extends a class whose schedule has ended", async () => {
    const timestamp = now();
    const classId = await createClass();
    const ended = timestamp - 60;
    await env.DB.prepare(
      "UPDATE classroom_classes SET starts_at = ?, expires_at = ? WHERE id = ?",
    )
      .bind(timestamp - 7200, ended, classId)
      .run();
    const topUp = await admin("/admin/v1/classes/update", {
      id: classId,
      budget_microcents: 5_000_000,
      rpm_limit: 90,
    });
    expect(topUp.status, await topUp.clone().text()).toBe(200);
    // Resending the stored end alongside other edits is not an extension.
    expect(
      (
        await admin("/admin/v1/classes/update", {
          id: classId,
          expires_at: ended,
          group_budget_microcents: 7,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await admin("/admin/v1/classes/update", {
          id: classId,
          expires_at: timestamp - 30,
        })
      ).status,
    ).toBe(400);
    const extended = await admin("/admin/v1/classes/update", {
      id: classId,
      expires_at: timestamp + 3600,
    });
    expect(extended.status).toBe(200);
    const row = await env.DB.prepare(
      `SELECT expires_at, budget_microcents, group_budget_microcents, rpm_limit
         FROM classroom_classes WHERE id = ?`,
    )
      .bind(classId)
      .first();
    expect(row).toEqual({
      expires_at: timestamp + 3600,
      budget_microcents: 5_000_000,
      group_budget_microcents: 7,
      rpm_limit: 90,
    });
  });
});

describe("classroom administration surface", () => {
  it("requires admin authentication and mirrors through the browser admin path", async () => {
    const timestamp = now();
    expect(
      (
        await handleControlPlane(
          request("/admin/v1/classes/list", {}),
          controlEnv,
        )
      ).status,
    ).toBe(401);
    await env.DB.prepare(
      `INSERT INTO dashboard_admins (id, email, actor_hash, enabled, created_at, updated_at)
       VALUES ('admin_classroom', 'operator@example.invalid', 'actor_classroom', 1, ?, ?)`,
    )
      .bind(timestamp, timestamp)
      .run();
    const browserCreate = () =>
      handleControlPlane(
        request("/dashboard/api/classes", classBody(), undefined, { origin }),
        controlEnv,
        browserIdentity,
      );
    expect((await browserCreate()).status).toBe(201);
    expect(
      (
        await handleControlPlane(
          request("/dashboard/api/classes", classBody(), undefined, {}),
          controlEnv,
          browserIdentity,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleControlPlane(
          request("/dashboard/api/classes/list", {}, undefined, { origin }),
          controlEnv,
          browserIdentity,
        )
      ).status,
    ).toBe(200);

    const browser = (path: string, body: unknown) =>
      handleControlPlane(
        request(`/dashboard/api/${path}`, body, undefined, { origin }),
        controlEnv,
        browserIdentity,
      );
    const environment = await browser("environments/update", {
      product_id: "prod_classroom",
      environment_id: "env_classroom",
      rpm_limit: 600,
    });
    expect(environment.status, await environment.clone().text()).toBe(200);
    expect(await environment.json()).toMatchObject({ rpm_limit: 600 });
    const classId = await createClass({ name: "Browser bulk" });
    await createGroups(classId, ["Alpha"]);
    const keys = await browser("groups/access-bulk", { class_id: classId });
    expect(keys.status, await keys.clone().text()).toBe(201);
    expect(
      (
        await browser("groups/budget-bulk", {
          class_id: classId,
          mode: "add",
          budget_microcents: 1,
        })
      ).status,
    ).toBe(200);
    const actors = await env.DB.prepare(
      `SELECT DISTINCT action, actor_hash FROM admin_audit
        WHERE action IN ('update', 'budget_add') AND actor_hash = 'actor_classroom'`,
    ).all();
    expect(actors.results).toHaveLength(2);
  });

  it("requires the classroom schema in readiness", async () => {
    const response = await handleControlPlane(
      new Request(origin + "/healthz"),
      controlEnv,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const complete = {
      value: DATABASE_SCHEMA_VERSION,
      admin_schema: 1,
      classroom_classes_schema: 1,
      classroom_groups_schema: 1,
      classroom_group_keys_schema: 1,
      access_code_group_column: 1,
      attempt_group_column: 1,
      group_paused_column: 1,
      group_key_hint_column: 1,
    };
    const columns = [
      "classroom_classes_schema",
      "classroom_groups_schema",
      "classroom_group_keys_schema",
      "access_code_group_column",
      "attempt_group_column",
      "group_paused_column",
      "group_key_hint_column",
    ] as const;
    for (const column of columns) {
      const stub = {
        ...controlEnv,
        DB: {
          prepare() {
            return {
              first: () => Promise.resolve({ ...complete, [column]: 0 }),
            };
          },
        } as unknown as D1Database,
      };
      expect(
        (await handleControlPlane(new Request(origin + "/healthz"), stub))
          .status,
        column,
      ).toBe(500);
    }
  });
});
