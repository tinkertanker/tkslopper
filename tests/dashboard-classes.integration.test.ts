import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  handleControlPlane,
  type ControlPlaneEnv,
} from "../apps/control-plane/src";

// These tests cover the browser write boundary of the course-centred dashboard
// served by the control plane, plus the script's safety invariants. The
// class/group management API is tested separately in classrooms.integration.
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
  it("never reaches for HTML-injecting APIs, browser storage, or inline handlers", async () => {
    const html = await pageHtml();

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
});
