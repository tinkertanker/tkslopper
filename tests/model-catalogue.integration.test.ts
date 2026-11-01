import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { MODEL_CATALOGUE } from "@tkslopper/shared";
import {
  handleControlPlane,
  type ControlPlaneEnv,
} from "../apps/control-plane/src";
import { handleGateway, type GatewayEnv } from "../apps/gateway/src";

const controlEnv = {
  ...env,
  DASHBOARD_ACCESS_AUD: "catalogue-test",
} as unknown as ControlPlaneEnv;
const context = {
  access: {
    aud: "catalogue-test",
    getIdentity: () => Promise.resolve({ email: "editor@example.invalid" }),
  },
};
const origin = "https://control.example.invalid";
const path = "/dashboard/api/model-catalogue";
const data = () => structuredClone(MODEL_CATALOGUE.data);

function read() {
  return handleControlPlane(new Request(origin + path), controlEnv, context);
}

function save(body: unknown, headers: Record<string, string> = {}) {
  return handleControlPlane(
    new Request(origin + path, {
      method: "POST",
      headers: { origin, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
    controlEnv,
    context,
  );
}

function published(bindings = env as unknown as GatewayEnv) {
  return handleGateway(
    new Request("https://gateway.example.invalid/v1/model-catalogue"),
    bindings,
  );
}

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM model_catalogue_revisions"),
    env.DB.prepare("DELETE FROM admin_audit"),
    env.DB.prepare("DELETE FROM dashboard_admins"),
    env.DB
      .prepare(`INSERT INTO dashboard_admins (id, email, actor_hash, enabled, created_at, updated_at)
      VALUES ('catalogue-editor', 'editor@example.invalid', 'catalogue-actor', 1, 1, 1)`),
  ]);
});

describe("public catalogue administration", () => {
  it("publishes validated snapshots without altering the public envelope and records named history", async () => {
    expect(await (await read()).json()).toMatchObject({
      revision: 0,
      data: data(),
      history: [],
    });
    const entries = data();
    entries.splice(
      entries.findIndex((e) => e.id === "gpt-6-astra"),
      1,
    );
    entries.find((e) => e.id === "gpt-6-luna")!.is_default = false;
    entries.push({
      provider: "openai",
      id: "custom/model:v2",
      display_name: "Custom choice",
      tier: "balanced",
      is_default: true,
    });
    const response = await save({ revision: 0, data: entries });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const publicResponse = await published();
    expect(await publicResponse.json()).toEqual({
      object: "list",
      version: 1,
      data: entries,
    });
    expect(publicResponse.headers.get("access-control-allow-origin")).toBe("*");
    expect(publicResponse.headers.get("cache-control")).toBe(
      "public, max-age=3600",
    );
    const saved = await (await read()).json();
    expect(saved).toMatchObject({
      revision: 1,
      data: entries,
      history: [
        {
          revision: 1,
          actor_email: "editor@example.invalid",
          entry_count: entries.length,
        },
      ],
    });
    const history = await handleControlPlane(
      new Request(origin + path + "?revision=1"),
      controlEnv,
      context,
    );
    expect(await history.json()).toMatchObject({ revision: 1, data: entries });
    const audit = await env.DB.prepare(
      "SELECT action, resource_type, resource_id, actor_hash FROM admin_audit",
    ).all();
    expect(audit.results).toEqual([
      {
        action: "publish",
        resource_type: "model_catalogue",
        resource_id: "1",
        actor_hash: "catalogue-actor",
      },
    ]);
  });

  it("requires enabled named admins and same-origin JSON; bearer tokens cannot edit", async () => {
    for (const method of ["GET", "POST"]) {
      const request = new Request(origin + path, {
        method,
        headers: {
          origin,
          "content-type": "application/json",
          authorization: `Bearer ${String(env.ADMIN_TOKEN)}`,
        },
        ...(method === "POST"
          ? { body: JSON.stringify({ revision: 0, data: data() }) }
          : {}),
      });
      expect((await handleControlPlane(request, controlEnv)).status).toBe(401);
    }
    expect(
      (
        await save(
          { revision: 0, data: data() },
          { origin: "https://evil.example.invalid" },
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await save(
          { revision: 0, data: data() },
          { "content-type": "text/plain" },
        )
      ).status,
    ).toBe(403);
    await env.DB.prepare("UPDATE dashboard_admins SET enabled = 0").run();
    expect((await read()).status).toBe(403);
    expect((await save({ revision: 0, data: data() })).status).toBe(403);
    const api = await handleControlPlane(
      new Request(origin + "/admin/v1/model-catalogue", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${String(env.ADMIN_TOKEN)}`,
        },
        body: JSON.stringify({ revision: 0, data: data() }),
      }),
      controlEnv,
    );
    expect(api.status).toBe(404);
  });

  it.each([
    (entries: ReturnType<typeof data>) => entries.push({ ...entries[0]! }),
    (entries: ReturnType<typeof data>) => {
      entries[0]!.is_default = false;
    },
    (entries: ReturnType<typeof data>) => {
      entries[1]!.is_default = true;
    },
    (entries: ReturnType<typeof data>) => {
      entries[0]!.id = "bad id";
    },
    (entries: ReturnType<typeof data>) => {
      entries[0]!.display_name = " ";
    },
    (entries: ReturnType<typeof data>) => {
      Object.assign(entries[0]!, { provider: "unapproved-provider" });
    },
    (entries: ReturnType<typeof data>) => {
      Object.assign(entries[0]!, { tier: "free" });
    },
    (entries: ReturnType<typeof data>) => {
      Object.assign(entries[0]!, { baseUrl: "https://evil.example.invalid" });
    },
  ])(
    "rejects invalid catalogue documents without publishing or auditing (%#)",
    async (mutate) => {
      const entries = data();
      mutate(entries);
      expect((await save({ revision: 0, data: entries })).status).toBe(400);
      expect(await (await published()).json()).toEqual(MODEL_CATALOGUE);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM admin_audit",
        ).first(),
      ).toEqual({ count: 0 });
    },
  );

  it("rejects stale revisions and atomically rolls back a publication if audit fails", async () => {
    expect((await save({ revision: 0, data: data() })).status).toBe(200);
    const entries = data();
    entries[0]!.display_name = "New label";
    expect((await save({ revision: 0, data: entries })).status).toBe(409);
    await env.DB.prepare(
      `CREATE TRIGGER fail_catalogue_audit BEFORE INSERT ON admin_audit
      BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END`,
    ).run();
    try {
      expect((await save({ revision: 1, data: entries })).status).toBe(500);
    } finally {
      await env.DB.prepare("DROP TRIGGER fail_catalogue_audit").run();
    }
    expect(await (await read()).json()).toMatchObject({
      revision: 1,
      data: data(),
      history: [{ revision: 1 }],
    });
    expect((await save({ revision: 1, data: entries })).status).toBe(200);
    expect(await (await read()).json()).toMatchObject({
      revision: 2,
      data: entries,
      history: [{ revision: 2 }, { revision: 1 }],
    });
  });

  it("allows exactly one concurrent publisher from the same revision", async () => {
    const first = data();
    const second = data();
    first[0]!.display_name = "First publisher";
    second[0]!.display_name = "Second publisher";
    const responses = await Promise.all([
      save({ revision: 0, data: first }),
      save({ revision: 0, data: second }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(await (await published()).json()).toEqual({
      object: "list",
      version: 1,
      data: responses[0].status === 200 ? first : second,
    });
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM admin_audit").first(),
    ).toEqual({ count: 1 });
  });

  it("rejects invalid persisted data for editing but serves a non-cacheable public fallback", async () => {
    await env.DB.prepare(
      "INSERT INTO model_catalogue_revisions VALUES (1, '[]', 'catalogue-actor', 1)",
    ).run();
    expect((await read()).status).toBe(500);
    const response = await published();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(MODEL_CATALOGUE);
  });

  it("keeps bundled suggestions available when persistence is absent or unavailable", async () => {
    for (const bindings of [
      {},
      {
        DB: {
          prepare() {
            throw new Error("unavailable");
          },
        },
      },
    ]) {
      const response = await published(bindings as unknown as GatewayEnv);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(MODEL_CATALOGUE);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});
