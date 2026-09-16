/**
 * Browser harness for the course-centred dashboard.
 *
 * It serves the real `dashboardPage()` markup with mocked class/group/usage APIs so
 * the UI can be inspected and screenshotted before the management API is integrated.
 * The mock follows the supplied contract shapes and is deliberately small; it is not
 * a substitute for the control-plane Worker and is not an end-to-end test.
 *
 * Run: pnpm exec tsx tests/dashboard-classes.browser.ts [port]
 * Then drive http://127.0.0.1:<port>/ with a browser. Switch fixtures at runtime with
 * `curl -X POST /__scenario -d '{"scenario":"empty"}'` and reload.
 */
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import {
  dashboardFavicon,
  dashboardPage,
} from "../apps/control-plane/src/dashboard";

type Scenario =
  | "populated"
  | "empty"
  | "revoked"
  | "pending"
  | "error"
  | "viewer"
  | "nooptions"
  | "twoproducts"
  | "expired";
type Json = Record<string, unknown>;

const ALIAS_PATTERN = /^[a-z][a-z0-9._:-]*\.v[1-9][0-9]*$/;

/**
 * Test-only probe injected before the dashboard script. It wraps submit listeners on the
 * two group forms and click listeners on the class/group action controls so the regression
 * can await the real handler promise (which includes the handler's awaited refresh work)
 * instead of inferring completion from timing.
 */
const HANDLER_SETTLEMENT_PROBE = `<script>
(() => {
  window.__handlers = { pending: 0, completed: 0 };
  const submitIds = ["group-edit-form", "group-create-form"];
  const clickIds = ["class-pause", "class-duplicate", "class-duplicate-submit", "class-detail-refresh", "class-edit-submit"];
  const original = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, options) {
    const mightTrack = listener && typeof listener === "function" &&
      ((type === "submit" && submitIds.includes(this.id)) || type === "click");
    if (!mightTrack) return original.call(this, type, listener, options);
    // Row action buttons are registered while still detached, so the ancestry test has to
    // happen when the handler is invoked, not when it is added.
    const wrapped = function (event) {
      const target = this;
      const tracked =
        (type === "submit" && submitIds.includes(target.id)) ||
        (type === "click" &&
          (clickIds.includes(target.id) ||
            (target instanceof Element && target.classList.contains("row-action") &&
              target.closest("#class-keys, #class-groups"))));
      if (!tracked) return listener.call(target, event);
      window.__handlers.pending += 1;
      let result;
      try {
        result = listener.call(target, event);
      } catch (error) {
        window.__handlers.pending -= 1;
        window.__handlers.completed += 1;
        throw error;
      }
      if (result && typeof result.then === "function") {
        return result.finally(() => {
          window.__handlers.pending -= 1;
          window.__handlers.completed += 1;
        });
      }
      window.__handlers.pending -= 1;
      window.__handlers.completed += 1;
      return result;
    };
    return original.call(this, type, wrapped, options);
  };
})();
</script>`;

const scenarioNames: Scenario[] = [
  "populated",
  "empty",
  "revoked",
  "pending",
  "error",
  "viewer",
  "nooptions",
  "twoproducts",
  "expired",
];
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type ClassRow = Json & {
  id: string;
  group_budget_microcents: number;
  status: string;
  name: string;
};
type GroupRow = Json & {
  id: string;
  class_id: string;
  name: string;
  status: string;
};
type KeyRow = Json & {
  id: string;
  group_id: string;
  revoked_at: number | null;
};
type CodeRow = Json & {
  id: string;
  classroom_group_id: string;
  disabled: boolean;
};

type Store = {
  classes: ClassRow[];
  groups: GroupRow[];
  keys: KeyRow[];
  codes: CodeRow[];
  usage: Map<string, Json>;
  counter: number;
};

function classRow(overrides: Partial<ClassRow>): ClassRow {
  return {
    id: "cls_default",
    product_id: "prod_school",
    environment_id: "env_prod",
    tenant_id: "tenant_school",
    name: "Default class",
    course: "Default course",
    instructors: [],
    timezone: "Asia/Singapore",
    starts_at: now() - 86_400,
    expires_at: now() + 86_400 * 30,
    status: "active",
    capabilities: ["text.chat.v1"],
    budget_microcents: 5_000_000_000,
    group_budget_microcents: 500_000_000,
    daily_budget_microcents: null,
    rpm_limit: 30,
    tpm_limit: 100_000,
    concurrency_limit: 2,
    created_at: now() - 86_400,
    updated_at: now() - 3_600,
    ...overrides,
  };
}

function groupRow(overrides: Partial<GroupRow>): GroupRow {
  return {
    id: "grp_default",
    class_id: "cls_default",
    name: "Default group",
    status: "active",
    capabilities: null,
    budget_microcents: 500_000_000,
    daily_budget_microcents: null,
    rpm_limit: null,
    tpm_limit: null,
    concurrency_limit: null,
    starts_at: null,
    expires_at: null,
    created_at: now() - 86_400,
    updated_at: now() - 3_600,
    ...overrides,
  };
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function buildStore(scenario: Scenario): Store {
  const store: Store = {
    classes: [],
    groups: [],
    keys: [],
    codes: [],
    usage: new Map(),
    counter: 0,
  };
  if (scenario === "empty") return store;
  if (scenario === "viewer") {
    store.classes = [classRow({})];
    return store;
  }
  if (scenario === "revoked") {
    store.classes = [
      classRow({
        id: "cls_paused",
        name: "P5 Maths (paused)",
        course: "Primary 5 Mathematics",
        status: "paused",
        instructors: ["Mrs Tan", "Mr Lim"],
      }),
      classRow({
        id: "cls_revoked",
        name: "P4 Science (revoked)",
        course: "Primary 4 Science",
        status: "revoked",
        capabilities: ["text.chat.v1", "text.vision.v1"],
      }),
    ];
    store.groups = [
      groupRow({
        id: "grp_a",
        class_id: "cls_paused",
        name: "Group A",
        status: "revoked",
        budget_microcents: 400_000_000,
        capabilities: ["text.chat.v1"],
      }),
      groupRow({
        id: "grp_b",
        class_id: "cls_paused",
        name: "Group B",
        status: "active",
        daily_budget_microcents: 20_000_000,
        rpm_limit: 10,
      }),
    ];
    store.keys = [
      {
        id: "key_revoked",
        group_id: "grp_a",
        created_at: now() - 86_400,
        expires_at: null,
        revoked_at: now() - 3_600,
      },
      {
        id: "key_live",
        group_id: "grp_b",
        created_at: now() - 3_600,
        expires_at: null,
        revoked_at: null,
      },
    ];
    store.codes = [
      {
        id: "code_disabled",
        classroom_group_id: "grp_a",
        expires_at: now() + 86_400 * 14,
        disabled: true,
        activation_count: 30,
        max_activations: 30,
      },
    ];
    return store;
  }

  if (scenario === "expired") {
    store.classes = [
      classRow({
        id: "cls_expired",
        name: "P3 Art — Term 1 (ended)",
        course: "Primary 3 Art",
        starts_at: now() - 86_400 * 60,
        expires_at: now() - 86_400 * 5,
        capabilities: ["text.chat.v1"],
      }),
    ];
    store.groups = [
      groupRow({
        id: "grp_exp_1",
        class_id: "cls_expired",
        name: "Group 1",
        budget_microcents: 100_000_000,
        starts_at: now() - 86_400 * 60,
        expires_at: now() - 86_400 * 5,
      }),
      groupRow({
        id: "grp_exp_2",
        class_id: "cls_expired",
        name: "Group 2",
        budget_microcents: 100_000_000,
      }),
    ];
    return store;
  }

  store.classes = [
    classRow({
      id: "cls_p5",
      name: "P5 Maths — Term 3",
      course: "Primary 5 Mathematics",
      instructors: ["Mrs Tan", "Mr Lim"],
      daily_budget_microcents: 200_000_000,
      capabilities: ["text.chat.v1", "text.vision.v1"],
    }),
    classRow({
      id: "cls_p4",
      name: "P4 Science — Term 3",
      course: "Primary 4 Science",
      budget_microcents: 3_000_000_000,
      group_budget_microcents: 300_000_000,
    }),
  ];
  store.groups = [
    groupRow({
      id: "grp_1",
      class_id: "cls_p5",
      name: "Group 1",
      budget_microcents: 500_000_000,
    }),
    groupRow({
      id: "grp_2",
      class_id: "cls_p5",
      name: "Group 2",
      budget_microcents: 500_000_000,
      daily_budget_microcents: 50_000_000,
      rpm_limit: 15,
      capabilities: ["text.chat.v1"],
    }),
    groupRow({
      id: "grp_3",
      class_id: "cls_p5",
      name: "Group 3",
      budget_microcents: 500_000_000,
    }),
    groupRow({
      id: "grp_4",
      class_id: "cls_p5",
      name: "Group 4 (catch-up)",
      budget_microcents: 500_000_000,
      starts_at: now() + 86_400 * 7,
      expires_at: now() + 86_400 * 21,
    }),
    groupRow({
      id: "grp_b1",
      class_id: "cls_p4",
      name: "Science Group 1",
      budget_microcents: 300_000_000,
    }),
  ];
  store.keys = [
    {
      id: "key_a1b2",
      group_id: "grp_1",
      created_at: now() - 86_400 * 3,
      expires_at: null,
      revoked_at: null,
    },
    {
      id: "key_c3d4",
      group_id: "grp_2",
      created_at: now() - 86_400 * 2,
      expires_at: now() + 86_400 * 20,
      revoked_at: null,
    },
  ];
  store.codes = [
    {
      id: "code_p5a",
      classroom_group_id: "grp_1",
      expires_at: now() + 86_400 * 20,
      disabled: false,
      activation_count: 18,
      max_activations: 30,
    },
    {
      id: "code_p5b",
      classroom_group_id: "grp_2",
      expires_at: now() + 86_400 * 20,
      disabled: false,
      activation_count: 31,
      max_activations: 30,
    },
  ];
  store.usage.set("cls_p5", {
    class_id: "cls_p5",
    groups: [
      {
        group_id: "grp_1",
        requests: 812,
        input_tokens: "4120000",
        output_tokens: "980000",
        cost_microcents: "184300000",
        pending_requests: 2,
        pending_cost_microcents: "1200000",
      },
      {
        group_id: "grp_2",
        requests: 640,
        input_tokens: "3180000",
        output_tokens: "710000",
        cost_microcents: "142500000",
        pending_requests: 0,
        pending_cost_microcents: "0",
      },
      {
        group_id: "grp_3",
        requests: 105,
        input_tokens: "520000",
        output_tokens: "120000",
        cost_microcents: "22800000",
        pending_requests: 1,
        pending_cost_microcents: "640000",
      },
      {
        group_id: "grp_4",
        requests: 0,
        input_tokens: "0",
        output_tokens: "0",
        cost_microcents: "0",
        pending_requests: 0,
        pending_cost_microcents: "0",
      },
    ],
    totals: {
      requests: 1557,
      input_tokens: "7820000",
      output_tokens: "1810000",
      cost_microcents: "349600000",
      pending_requests: 3,
      pending_cost_microcents: "1840000",
    },
  });
  if (scenario === "pending") {
    store.usage.set("cls_p5", {
      class_id: "cls_p5",
      groups: [
        {
          group_id: "grp_1",
          requests: 0,
          input_tokens: "0",
          output_tokens: "0",
          cost_microcents: "0",
          pending_requests: 4,
          pending_cost_microcents: "5000000",
        },
      ],
      totals: {
        requests: 0,
        input_tokens: "0",
        output_tokens: "0",
        cost_microcents: "0",
        pending_requests: 4,
        pending_cost_microcents: "5000000",
      },
    });
  }
  return store;
}

function optionsFixture(scenario: Scenario): Json {
  if (scenario === "twoproducts") {
    return {
      environments: [
        {
          product_id: "prod_school",
          environment_id: "env_prod",
          product_name: "School products",
          environment_name: "production",
          aliases: ["text.chat.v1", "text.vision.v1", "text.structured.v1"],
        },
        {
          product_id: "prod_arts",
          environment_id: "env_arts",
          product_name: "Arts academy",
          environment_name: "studio",
          aliases: ["text.chat.v1"],
        },
      ],
      truncated: false,
    };
  }
  return {
    environments: [
      {
        product_id: "prod_school",
        environment_id: "env_prod",
        product_name: "School products",
        environment_name: "production",
        aliases: ["text.chat.v1", "text.vision.v1", "text.structured.v1"],
      },
      {
        product_id: "prod_school",
        environment_id: "env_lab",
        product_name: "School products",
        environment_name: "lab",
        aliases: ["text.chat.v1"],
      },
    ],
    truncated: false,
  };
}

function dashboardFixture(): Json {
  return {
    generated_at: now(),
    totals: {
      products: 1,
      environments: 1,
      finalized_attempts_24h: 42,
      failed_finalized_attempts_24h: 0,
      accounted_input_tokens_24h: "1200000",
      accounted_output_tokens_24h: "340000",
      accounted_cost_microcents_24h: "987654321",
      stale_attempts: 0,
    },
    products: [
      {
        id: "prod_school",
        slug: "school",
        display_name: "School products",
        enabled: true,
        kill_switch: false,
      },
    ],
    environments: [
      {
        id: "env_prod",
        product_id: "prod_school",
        name: "production",
        audience: "school:prod",
        product_enabled: true,
        product_kill_switch: false,
        enabled: true,
        kill_switch: false,
        policy_version: 3,
        rpm_limit: 30,
        tpm_limit: 100000,
        concurrency_limit: 2,
        daily_budget_microcents: 1000000,
        max_request_bytes: 1048576,
        aliases: 2,
        active_entitlements: 4,
        effective_grants: 5,
        finalized_attempts_24h: 42,
        failed_finalized_attempts_24h: 3,
        accounted_input_tokens_24h: "1200000",
        accounted_output_tokens_24h: "340000",
        accounted_cost_microcents_24h: "987654321",
        aliases_truncated: false,
        active_entitlements_truncated: false,
        effective_grants_truncated: false,
      },
    ],
    inventory_truncated: {
      products: false,
      environments: false,
      environment_counts: false,
    },
    accounting_truncated: {
      finalized_attempts: false,
      stale_attempts: false,
      stale_attempt_details: false,
    },
    recent_attempts: [],
    stale_attempts: [],
    recent_admin_actions: [],
    accounting_basis: {
      coverage:
        "Persisted provider-attempt records begin only after quota admission.",
      finalized: "Bounded fixture.",
      stale: "Bounded fixture.",
    },
    live_quota: {
      available: false,
      reason: "Fixture: live reservations are not enumerated.",
    },
  };
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage): Promise<Json> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of request as AsyncIterable<Uint8Array>)
    chunks.push(chunk);
  if (!chunks.length) return {};
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as Json;
  } catch {
    return {};
  }
}

function buildScenario(): { scenario: Scenario; store: Store } {
  return { scenario: "populated", store: buildStore("populated") };
}

async function main(): Promise<void> {
  const port = Number(process.argv[2] ?? 8790);
  let { scenario, store } = buildScenario();
  let updateDelayMs = 0;
  const html = (await dashboardPage().text()).replace(
    "<script nonce=",
    `${HANDLER_SETTLEMENT_PROBE}<script nonce=`,
  );
  const favicon = await dashboardFavicon().text();

  const server = createServer((request, response) => {
    void handle(request, response);
  });

  async function handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const path = url.pathname;
    if (request.method === "GET" && (path === "/" || path === "/dashboard")) {
      response.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(html);
      return;
    }
    if (request.method === "GET" && path === "/favicon.svg") {
      response.writeHead(200, {
        "content-type": "image/svg+xml; charset=utf-8",
      });
      response.end(favicon);
      return;
    }
    if (request.method === "GET" && path === "/__health") {
      sendJson(response, 200, { ok: true, scenario, updateDelayMs });
      return;
    }
    if (request.method === "POST" && path === "/__delay") {
      const body = await readBody(request);
      const requested = Number(body.ms ?? 0);
      updateDelayMs = Number.isFinite(requested)
        ? Math.max(0, Math.min(5_000, requested))
        : 0;
      sendJson(response, 200, { ok: true, ms: updateDelayMs });
      return;
    }
    if (request.method === "POST" && path === "/__scenario") {
      const body = await readBody(request);
      const next = str(body.scenario);
      if (!scenarioNames.includes(next as Scenario)) {
        sendJson(response, 400, { error: { message: "unknown scenario" } });
        return;
      }
      scenario = next as Scenario;
      store = buildStore(scenario);
      sendJson(response, 200, { ok: true, scenario });
      return;
    }
    if (request.method === "GET" && path === "/admin/v1/dashboard") {
      sendJson(response, 200, dashboardFixture());
      return;
    }
    if (request.method === "GET" && path === "/dashboard/api/session") {
      if (scenario === "viewer") {
        sendJson(response, 200, { role: "viewer" });
        return;
      }
      sendJson(response, 200, {
        role: "admin",
        email: "operator@example.invalid",
        admins: [{ email: "operator@example.invalid", enabled: true }],
        admins_truncated: false,
        recent_actions: [],
      });
      return;
    }
    if (request.method === "POST" && path.startsWith("/dashboard/api/")) {
      const operation = path.slice("/dashboard/api/".length);
      void handleOperation(operation, response, await readBody(request));
      return;
    }
    sendJson(response, 404, { error: { message: "not found" } });
  }

  async function handleOperation(
    operation: string,
    response: ServerResponse,
    body: Json,
  ): Promise<void> {
    if (
      scenario === "error" &&
      (operation === "classes/list" ||
        operation === "groups/list" ||
        operation === "classes/usage")
    ) {
      sendJson(response, 500, {
        error: { message: "Fixture: class service is unavailable." },
      });
      return;
    }
    const classId = str(body.class_id);
    const badAlias = (
      Array.isArray(body.capabilities) ? (body.capabilities as unknown[]) : []
    ).find((alias) => typeof alias !== "string" || !ALIAS_PATTERN.test(alias));
    if (badAlias !== undefined) {
      sendJson(response, 400, {
        error: { message: "capabilities: invalid alias" },
      });
      return;
    }
    switch (operation) {
      case "classes/options":
        if (scenario === "nooptions") {
          sendJson(response, 404, { error: { message: "not found" } });
          return;
        }
        sendJson(response, 200, optionsFixture(scenario));
        return;
      case "classes/list":
        sendJson(response, 200, { classes: store.classes, truncated: false });
        return;
      case "classes": {
        store.counter += 1;
        const id = `cls_new_${store.counter}`;
        store.classes.push(
          classRow({ ...body, id, created_at: now(), updated_at: now() }),
        );
        sendJson(response, 201, { id });
        return;
      }
      case "classes/update": {
        if (updateDelayMs) await sleep(updateDelayMs);
        const id = str(body.id);
        const index = store.classes.findIndex((row) => row.id === id);
        if (index < 0) {
          sendJson(response, 404, { error: { message: "Class not found." } });
          return;
        }
        if (store.classes[index]?.status === "revoked") {
          sendJson(response, 409, {
            error: { message: "revoked classes are terminal" },
          });
          return;
        }
        const merged = {
          ...store.classes[index],
          ...body,
          updated_at: now(),
        } as ClassRow;
        store.classes[index] = merged;
        sendJson(response, 200, { id });
        return;
      }
      case "classes/duplicate": {
        const source = store.classes.find((row) => row.id === str(body.id));
        if (!source) {
          sendJson(response, 404, { error: { message: "Class not found." } });
          return;
        }
        const startsAt = Number(body.starts_at ?? 0);
        const expiresAt = Number(body.expires_at ?? 0);
        if (!startsAt || !expiresAt || expiresAt <= startsAt) {
          sendJson(response, 400, {
            error: { message: "a new start and end are required" },
          });
          return;
        }
        if (expiresAt <= now()) {
          sendJson(response, 400, {
            error: { message: "the duplicated window must end in the future" },
          });
          return;
        }
        store.counter += 1;
        const id = `cls_copy_${store.counter}`;
        store.classes.push(
          classRow({
            ...source,
            ...body,
            id,
            status: "active",
            created_at: now(),
            updated_at: now(),
          }),
        );
        // Copied groups keep policy and budget but inherit the new class window.
        for (const group of store.groups.filter(
          (row) => row.class_id === str(body.id),
        )) {
          store.groups.push({
            ...group,
            id: `grp_copy_${store.counter}_${group.name}`,
            class_id: id,
            starts_at: null,
            expires_at: null,
          });
        }
        sendJson(response, 201, { id });
        return;
      }
      case "groups/list":
        sendJson(response, 200, {
          groups: store.groups.filter((row) => row.class_id === classId),
          keys: store.keys,
          codes: store.codes,
          truncated: false,
        });
        return;
      case "groups": {
        const names = Array.isArray(body.names) ? (body.names as string[]) : [];
        const created = names.map((name, index) => {
          store.counter += 1;
          const group = groupRow({
            id: `grp_new_${store.counter}_${index}`,
            class_id: classId,
            name,
            budget_microcents: 500_000_000,
          });
          store.groups.push(group);
          return group;
        });
        sendJson(response, 201, { groups: created });
        return;
      }
      case "groups/update": {
        const id = str(body.id);
        const index = store.groups.findIndex((row) => row.id === id);
        if (index < 0) {
          sendJson(response, 404, { error: { message: "Group not found." } });
          return;
        }
        store.groups[index] = {
          ...store.groups[index],
          ...body,
          updated_at: now(),
        } as GroupRow;
        sendJson(response, 200, { id });
        return;
      }
      case "groups/access": {
        store.counter += 1;
        const groupId = str(body.group_id);
        const target = store.groups.find((row) => row.id === groupId);
        if (target && target.status === "revoked") {
          sendJson(response, 409, {
            error: { message: "revoked groups are terminal" },
          });
          return;
        }
        if (body.kind === "join_code") {
          const id = `code_${store.counter}`;
          store.codes.push({
            id,
            classroom_group_id: groupId,
            expires_at: now() + 86_400 * 30,
            disabled: false,
            activation_count: 0,
            max_activations: Number(body.max_activations ?? 30),
          });
          sendJson(response, 201, {
            id,
            group_id: groupId,
            kind: "join_code",
            access_code: `tkac_${store.counter}_fixture-join-code`,
            warning: "shown once",
          });
          return;
        }
        const id = `key_${store.counter}`;
        store.keys.push({
          id,
          group_id: groupId,
          created_at: now(),
          expires_at: null,
          revoked_at: null,
        });
        sendJson(response, 201, {
          id,
          group_id: groupId,
          kind: "api_key",
          api_key: `tkgk_${store.counter}_fixture-api-key`,
          warning: "shown once",
        });
        return;
      }
      case "groups/rotate": {
        const id = str(body.id);
        const existing = store.keys.find((row) => row.id === id);
        if (existing) existing.revoked_at = now();
        store.counter += 1;
        const nextId = `key_rot_${store.counter}`;
        store.keys.push({
          id: nextId,
          group_id: existing?.group_id ?? "grp_1",
          created_at: now(),
          expires_at: null,
          revoked_at: null,
        });
        sendJson(response, 201, {
          id: nextId,
          group_id: existing?.group_id ?? "grp_1",
          kind: "api_key",
          api_key: `tkgk_rot_${store.counter}_fixture`,
          warning: "shown once",
        });
        return;
      }
      case "groups/revoke-key": {
        const id = str(body.id);
        const existing = store.keys.find((row) => row.id === id);
        if (existing) existing.revoked_at = now();
        sendJson(response, 200, { id });
        return;
      }
      case "revoke": {
        const id = str(body.resource_id);
        const existing = store.codes.find((row) => row.id === id);
        if (existing) existing.disabled = true;
        sendJson(response, 200, { id });
        return;
      }
      case "classes/usage": {
        const fixture = store.usage.get(classId) ?? {
          class_id: classId,
          groups: [],
          totals: {
            requests: 0,
            input_tokens: "0",
            output_tokens: "0",
            cost_microcents: "0",
            pending_requests: 0,
            pending_cost_microcents: "0",
          },
        };
        sendJson(response, 200, { ...fixture, truncated: false });
        return;
      }
      default:
        sendJson(response, 404, {
          error: { message: `Fixture has no handler for ${operation}` },
        });
    }
  }

  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(
      `dashboard classes harness listening on http://127.0.0.1:${port}/\n`,
    );
  });
}

void main();
