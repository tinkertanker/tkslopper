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
      'dashboardPost("groups", { class_id: classState.selected, names })',
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
    expect(html).toContain("stored times are displayed in UTC");
    expect(html).toContain("does not convert these times");
    // The class timezone field is metadata, not a converter.
    expect(html).toContain("display and scheduling metadata");
    // Stored timestamps are labelled UTC, and daily caps are explicitly UTC.
    expect(html).toContain('"Starts (UTC)"');
    expect(html).toContain('"Ends (UTC)"');
    expect(html).toContain('"Created (UTC)"');
    expect(html).toContain('"Expires (UTC)"');
    expect(html).toContain('"Default group daily (UTC)"');
    expect(html).toContain('"Daily group budget (UTC)"');
    expect(html).toContain("applies in UTC");
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
