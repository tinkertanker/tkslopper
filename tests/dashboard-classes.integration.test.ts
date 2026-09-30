import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  handleControlPlane,
  type ControlPlaneEnv,
} from "../apps/control-plane/src";

// These are UI-contract tests for the course-centred dashboard served by the
// control plane. They assert the rendered shell and the browser write boundary
// only; the class/group management API is supplied separately, so a named admin
// reaching an unimplemented route is not asserted to succeed or fail.
const controlEnv = {
  ...env,
  DASHBOARD_ACCESS_AUD: "classes-test-audience",
} as unknown as ControlPlaneEnv;
const origin = "https://control.example.invalid";
const identity = (email: string) => ({
  access: {
    aud: "classes-test-audience",
    getIdentity: () => Promise.resolve({ email }),
  },
});

function get(path: string): Request {
  return new Request(origin + path);
}
function post(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request(origin + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

async function pageHtml(): Promise<string> {
  const response = await handleControlPlane(get("/dashboard"), controlEnv);
  expect(response.status).toBe(200);
  return response.text();
}

describe("course-centred dashboard UI", () => {
  it("ships the Classes workflow as an admin-gated view without exposing it to viewers", async () => {
    const html = await pageHtml();

    expect(html).toContain('data-view="classes"');
    expect(html).toContain('<li id="nav-classes" hidden>');
    expect(html).toContain('<div class="view" data-view="classes" hidden>');
    expect(html).toContain('<section id="class-detail" hidden>');
    // Existing sections remain addressable and the legacy nav still leads with overview.
    for (const view of ["overview", "attempts", "stale", "activity", "admin"]) {
      expect(html).toContain(`data-view="${view}"`);
    }
    expect(html).toContain(
      'class="nav-item" data-view="overview" aria-current="page"',
    );
    // Settings and Diagnostics now label the preserved legacy controls.
    expect(html).toContain('data-view="admin">Settings</button>');
    expect(html).toContain('data-view="attempts">Diagnostics</button>');
  });

  it("covers the create, distribute, inspect, and adjust workflow in the served shell", async () => {
    const html = await pageHtml();

    for (const element of [
      'id="classes"',
      'id="class-create-form"',
      'id="class-create-fields"',
      'id="class-edit-form"',
      'id="group-create-form"',
      'id="group-names"',
      'id="class-groups"',
      'id="class-keys"',
      'id="class-codes"',
      'id="class-usage"',
      'id="class-pause"',
      'id="class-duplicate"',
      'id="group-edit-panel"',
    ]) {
      expect(html).toContain(element);
    }
    // The form asks for the contract's class fields.
    for (const field of [
      "product_id",
      "environment_id",
      "tenant_id",
      "timezone",
      "starts_at",
      "expires_at",
      "budget_microcents",
      "group_budget_microcents",
      "daily_budget_microcents",
      "rpm_limit",
      "tpm_limit",
      "concurrency_limit",
    ]) {
      expect(html).toContain(`["${field}",`);
    }
  });

  it("gives duplication its own schedule and guards class-specific completion", async () => {
    const html = await pageHtml();

    // Duplication collects a new window instead of reusing the source's.
    expect(html).toContain(
      '<div class="subpanel" id="class-duplicate-panel" hidden>',
    );
    expect(html).toContain('id="class-duplicate-form"');
    expect(html).toContain('id="class-duplicate-fields"');
    expect(html).toContain('id="class-duplicate-submit"');
    expect(html).toContain(
      '["starts_at", "New start (browser local time)", "datetime-local"]',
    );
    expect(html).toContain(
      '["expires_at", "New end (browser local time)", "datetime-local"]',
    );
    expect(html).toContain(
      "const request = { id: targetId, name: payload.name, starts_at: payload.starts_at, expires_at: payload.expires_at }",
    );
    expect(html).not.toContain("starts_at: row.starts_at");

    // A late completion for class A must not relabel class B.
    expect(html).toContain(
      "async function runClassAction(statusId, action, targetClassId)",
    );
    expect(html).toContain(
      "if (targetClassId && classState.selected !== targetClassId) return true;",
    );
    expect(html).toContain(
      "if (classState.selected !== targetId) return null;",
    );
  });

  it("picks approved aliases from the control plane instead of free text", async () => {
    const html = await pageHtml();

    // Options come from the dedicated endpoint; the picker is a checkbox list.
    expect(html).toContain('"classes/options"');
    expect(html).toContain('id="class-create-aliases"');
    expect(html).toContain('id="class-edit-aliases"');
    expect(html).toContain('id="group-edit-aliases"');
    expect(html).toContain('input.type = "checkbox"');
    expect(html).toContain('input.name = "capabilities"');
    expect(html).toContain("approvedAliases(environmentId)");
    expect(html).toContain("not currently approved");
    expect(html).toContain("not in class policy");
    expect(html).toContain(
      "Only aliases approved and enabled for the chosen environment are listed",
    );
    expect(html).toContain(
      "A group can only be granted aliases the class already approves",
    );
    // If options cannot be listed the picker degrades to a clearly labelled text field.
    expect(html).toContain("classes/options did not respond");
    expect(html).toContain(
      'input.setAttribute("aria-label", "Approved aliases / models (comma separated)")',
    );
    expect(html).toContain(
      "the control plane rejects invalid or unapproved aliases with 400",
    );
    expect(html).toContain("Choose at least one approved alias.");
    expect(html).toContain("is not a valid alias ID");
    // Server rejections stay visible with a clear fallback.
    expect(html).toContain("revoked items are terminal");
    expect(html).toContain("The request was rejected as invalid.");
  });

  it("presents usage as a projection with allocation, accounted cost, and pending ceilings kept separate", async () => {
    const html = await pageHtml();

    expect(html).toContain('"Budget allocation"');
    expect(html).toContain('"Accounted lifetime cost"');
    expect(html).toContain('"Pending reservation ceiling"');
    expect(html).toContain("not a remaining balance");
    expect(html).toContain("does not reconcile");
    expect(html).toContain("may reduce the budget still available");
    // No exact available/remaining budget is derived from allocation minus cost.
    expect(html).not.toMatch(/remaining budget:/i);
    expect(html).not.toContain("available budget:");
    // Usage truncation from the contract is disclosed.
    expect(html).toContain("Usage is truncated");
  });

  it("keeps the two distribution mechanisms visibly separate and scoped", async () => {
    const html = await pageHtml();

    expect(html).toContain("Group API keys");
    expect(html).toContain("Join codes");
    expect(html).toContain("direct gateway API key");
    expect(html).toContain(
      "activates devices through the existing activation endpoint",
    );
    // Activation caps count devices, never a spending limit.
    expect(html).toContain("Activations (devices, not spend)");
    // Scope tags tell the operator which limit applies.
    for (const scope of ["class", "group", "key", "device"]) {
      expect(html).toContain(`<span class="scope">${scope}</span>`);
    }
    // Rotation is described as spend-preserving.
    expect(html).toContain("the group and its spend are unchanged");
  });

  it("routes every class and group call through the same-origin named-admin boundary", async () => {
    const html = await pageHtml();

    for (const operation of [
      "classes/list",
      "classes",
      "classes/update",
      "classes/duplicate",
      "classes/usage",
      "groups/list",
      "groups/update",
      "groups/access",
      "groups/rotate",
      "groups/revoke-key",
    ]) {
      expect(html).toContain(`"${operation}"`);
    }
    expect(html).toContain(
      'dashboardPost("groups", { class_id: classId, names })',
    );
    expect(html).toContain(
      'dashboardPost("groups/access", { group_id: groupId, kind })',
    );
    // Join-code revocation reuses the existing access_code revoke shape.
    expect(html).toContain('{ resource_type: "access_code", resource_id: id }');
    expect(html).toContain(
      'const response = await fetch("/dashboard/api/" + operation',
    );
    expect(html).toContain('credentials: "same-origin"');
  });

  it("shows issued credentials once and never persists or re-renders them unsafely", async () => {
    const html = await pageHtml();

    expect(html).toContain('id="class-secret" hidden');
    expect(html).toContain('id="class-secret-copy"');
    expect(html).toContain('id="class-secret-download"');
    expect(html).toContain('id="class-secret-clear"');
    expect(html).toContain("it is shown once and cannot be retrieved later");
    expect(html).toContain("do not store it in browser storage");
    // No browser storage of secrets, and user data only reaches text nodes.
    expect(html).not.toContain("localStorage");
    expect(html).not.toContain("sessionStorage");
    expect(html).not.toContain("innerHTML");
    expect(html).toContain(
      'document.getElementById("class-secret-value").textContent = value',
    );
    expect(html).toContain('window.addEventListener("pagehide", clearSecret)');
  });

  it("states the timezone of every date/time input and displayed timestamp", async () => {
    const html = await pageHtml();

    // Browser-local entry is labelled and the resolved zone is injected at runtime.
    expect(html).toContain("Starts at (browser local time)");
    expect(html).toContain("Ends at (browser local time)");
    expect(html).toContain("Starts at (browser local time; blank inherits)");
    expect(html).toContain('id="class-create-schedule-note"');
    expect(html).toContain('id="class-edit-schedule-note"');
    expect(html).toContain('id="group-edit-schedule-note"');
    expect(html).toContain("Intl.DateTimeFormat().resolvedOptions().timeZone");
    expect(html).toContain("entered in your browser's local time");
    // Class-scoped tables show times in the class's own IANA timezone, with UTC
    // alongside in the class summary.
    expect(html).toContain("Class tables show them in the class timezone");
    expect(html).toContain(
      'new Intl.DateTimeFormat("en-GB", { timeZone: timeZone || "UTC"',
    );
    expect(html).toContain('"Starts (class time)"');
    expect(html).toContain('"Ends (class time)"');
    expect(html).toContain('"Created (class time)"');
    expect(html).toContain('"Expires (class time)"');
    expect(html).toContain('"UTC: " + time(row.starts_at)');
    // Daily budgets are labelled as resetting at 00:00 UTC wherever they appear.
    expect(html).toContain('"Daily per student (resets 00:00 UTC)"');
    expect(html).toContain('"Daily group budget (resets 00:00 UTC)"');
    expect(html).toContain('"Daily budget per principal (resets 00:00 UTC)"');
    expect(html).toContain("Daily budgets reset at 00:00 UTC");
  });

  it("requires Access login and a named admin for the class write boundary", async () => {
    const owner = identity("owner@tinkertanker.com");
    const member = identity("member@tinkertanker.com");
    await env.DB.batch([
      env.DB.prepare("DELETE FROM dashboard_admins"),
      env.DB.prepare(
        `INSERT INTO dashboard_admins (id, email, actor_hash, enabled, created_at, updated_at)
         VALUES ('admin_classes', 'owner@tinkertanker.com', 'hash_classes', 1, 1, 1)`,
      ),
    ]);
    const create = () =>
      post("/dashboard/api/classes", { name: "P5 Maths" }, { origin });

    // No verified Access identity.
    expect((await handleControlPlane(create(), controlEnv)).status).toBe(401);
    // Verified identity without an enabled named-admin grant.
    expect(
      (await handleControlPlane(create(), controlEnv, member)).status,
    ).toBe(403);
    // An admin is authorized: routing may be supplied later, but never 401/403.
    const authorized = await handleControlPlane(create(), controlEnv, owner);
    expect([401, 403]).not.toContain(authorized.status);
    // Same-origin JSON is required for every browser write.
    expect(
      (
        await handleControlPlane(
          post(
            "/dashboard/api/classes",
            {},
            { origin, "content-type": "text/plain" },
          ),
          controlEnv,
          owner,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handleControlPlane(
          post(
            "/dashboard/api/classes",
            {},
            { origin: "https://evil.invalid" },
          ),
          controlEnv,
          owner,
        )
      ).status,
    ).toBe(403);
  });
});

describe("teacher class kit", () => {
  it("enters and shows money in US dollars, converting exactly to integer microcents", async () => {
    const html = await pageHtml();

    // Every class, group and environment budget field is a dollar field.
    for (const field of [
      '["budget_microcents", "Class total budget (US$, shared by every student)", "dollars"]',
      '["group_budget_microcents", "Budget per student (US$, lifetime; each new group)", "dollars"]',
      '["daily_budget_microcents", "Daily budget per student (US$, optional; resets 00:00 UTC)", "dollars"]',
      '["budget_microcents", "Group budget (US$, lifetime; shared by its keys and devices)", "dollars"]',
      '["daily_budget_microcents", "Daily budget per principal (US$; resets 00:00 UTC; not applied to classes)", "dollars", "20.00"]',
      '["input_cost_microcents_per_million", "Input price (US$ per million tokens)", "dollars", "0"]',
      '["output_cost_microcents_per_million", "Output price (US$ per million tokens)", "dollars", "0"]',
    ]) {
      expect(html).toContain(field);
    }
    expect(html).not.toContain("(μ¢, shared by all groups)");
    expect(html).not.toContain('"Daily budget (microcents)"');
    // Conversion is decimal-string and BigInt based, never floating point.
    expect(html).toContain("const MICROCENTS_PER_DOLLAR = 100000000n;");
    expect(html).toContain(
      'BigInt(match[1] || "0") * MICROCENTS_PER_DOLLAR + BigInt(fraction.padEnd(8, "0"))',
    );
    expect(html).toContain('return { error: "must not be negative" };');
    expect(html).toContain("can have at most 8 decimal places");
    // Operator diagnostics keep microcents.
    expect(html).toContain(
      '{ label: "Cost ceiling", value: "cost_microcents", format: cost }',
    );
  });

  it("creates a class with students and issues every key through groups/access-bulk", async () => {
    const html = await pageHtml();

    expect(html).toContain('id="class-create-students"');
    expect(html).toContain("Students (optional; one name per line, up to 100)");
    // Sensible defaults: now, three hours, $20 class, $1 per student.
    expect(html).toContain("expires_at: start + 3 * 3600");
    expect(html).toContain("budget_microcents: 2000000000");
    expect(html).toContain("group_budget_microcents: 100000000");
    // A valid tenant ID is suggested from the class name and date.
    expect(html).toContain(
      'return "class-" + (slug ? slug + "-" : "") + day.replace(/-/g, "");',
    );
    // Students become groups, then keys are issued in one bulk call.
    expect(html).toContain(
      'dashboardPost("groups", { class_id: createdId, names: students })',
    );
    expect(html).toContain('dashboardPost("groups/access-bulk"');
    expect(html).toContain('id="class-issue-all"');
    // Bulk issuance is confirmed in the page, not with a blocking dialog.
    expect(html).toContain(
      '<div class="confirm-bar" id="class-issue-confirm" hidden>',
    );
    expect(html).toContain('askInline("class-issue-confirm"');
    // Guardrails are shown next to class limits, with a warning when exceeded.
    expect(html).toContain("is above the environment guardrail of");
    expect(html).toContain(
      "Students get the lower of the class value and the guardrail.",
    );
  });

  it("builds student cards and CSV from text nodes and keeps kit secrets in memory only", async () => {
    const html = await pageHtml();

    for (const element of [
      'id="class-kit" hidden',
      'id="class-kit-keys"',
      'id="class-kit-skipped"',
      'id="class-kit-copy"',
      'id="class-kit-download"',
      'id="class-kit-print"',
      'id="class-kit-clear"',
      'id="print-cards"',
      'id="class-secret-card" hidden',
    ]) {
      expect(html).toContain(element);
    }
    expect(html).toContain('[["name", "key", "base_url", "models"]]');
    // Spreadsheet formula injection is neutralised in exported names.
    expect(html).toContain(
      'if (/^[=+\\-@\\t\\r]/.test(text)) text = "\'" + text;',
    );
    // Cards print on their own and carry the OpenAI-compatible snippets.
    expect(html).toContain("@media print");
    expect(html).toContain("body.print-kit .app { display: none; }");
    expect(html).toContain('"from openai import OpenAI"');
    expect(html).toContain("client.chat.completions.create(");
    expect(html).toContain('"curl " + base + "/chat/completions');
    expect(html).toContain(
      'const GATEWAY_MISSING = "<gateway URL not configured>";',
    );
    expect(html).toContain("Set GATEWAY_PUBLIC_URL on the control plane");
    // Secrets are cleared with the page state and never parsed as HTML.
    expect(html).toContain('window.addEventListener("pagehide", clearKit)');
    expect(html).toContain(
      'document.getElementById("print-cards").replaceChildren()',
    );
    for (const unsafe of [
      "innerHTML",
      "outerHTML",
      "insertAdjacentHTML",
      "document.write",
      "localStorage",
      "sessionStorage",
    ]) {
      expect(html).not.toContain(unsafe);
    }
    // CSP stays nonce-based with no inline handlers.
    expect(html).not.toMatch(/\son[a-z]+=["']/);
  });

  it("adds per-student pause, key hints, bulk budgets and environment editing", async () => {
    const html = await pageHtml();

    expect(html).toContain(
      'dashboardPost("groups/update", { id: row.id, paused })',
    );
    expect(html).toContain('label: row.paused ? "Resume" : "Pause"');
    expect(html).toContain(
      'row.status === "revoked" ? "Revoked" : row.paused ? "Paused" : "Active"',
    );
    expect(html).toContain(
      '{ label: "Key ends in", value: (row) => row.key_hint ? "…" + row.key_hint : "not recorded" }',
    );
    expect(html).toContain('id="group-budget-form"');
    expect(html).toContain('dashboardPost("groups/budget-bulk", request)');
    expect(html).toContain('<option value="add">');
    expect(html).toContain('<option value="set">');
    expect(html).toContain('["environments/update", "Edit environment limits"');
    expect(html).toContain('{ label: "Environment ID", value: "id" }');
    // Only admins get the edit shortcut; everyone can copy an ID.
    expect(html).toContain(
      'if (isAdmin) buttons.push({ label: "Edit limits", onClick: () => editEnvironment(row) });',
    );
    for (const flag of [
      "allow_images",
      "allow_reasoning",
      "allow_structured_json",
    ]) {
      expect(html).toContain(`["${flag}", `);
    }
    expect(html).toContain(
      '["max_failed_attempts", "Failed-attempt counter cap (a correct code is always accepted)", "number", 8]',
    );
  });
});
