import {
  HttpError,
  bearerToken,
  jsonResponse,
  randomSecret,
  sha256,
} from "@tkslopper/shared";

export type DashboardEnv = {
  DB: D1Database;
  DASHBOARD_TOKEN: string;
};

type ProductRow = {
  id: string;
  slug: string;
  display_name: string;
  enabled: number;
  kill_switch: number;
};

type EnvironmentRow = {
  id: string;
  product_id: string;
  name: string;
  audience: string;
  enabled: number;
  kill_switch: number;
  policy_version: number;
  rpm_limit: number;
  tpm_limit: number;
  concurrency_limit: number;
  daily_budget_microcents: number;
  max_request_bytes: number;
  aliases: number;
  active_entitlements: number;
  active_grants: number;
  attempts_24h: number;
  failed_attempts_24h: number;
  input_tokens_24h: string;
  output_tokens_24h: string;
  cost_microcents_24h: string;
};

type TotalsRow = {
  attempts_24h: number;
  failed_attempts_24h: number;
  input_tokens_24h: string;
  output_tokens_24h: string;
  cost_microcents_24h: string;
  stale_attempts: number;
};

type AttemptRow = {
  request_id: string;
  product_id: string;
  environment_id: string;
  alias: string;
  policy_version: number;
  route_id: string;
  provider: string;
  resolved_model: string;
  endpoint: string;
  status_code: number;
  error_class: string | null;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_microcents: number;
  created_at: number;
};

type StaleAttemptRow = {
  request_id: string;
  product_id: string;
  environment_id: string;
  route_id: string;
  provider: string;
  resolved_model: string;
  endpoint: string;
  input_tokens: number;
  output_tokens: number;
  cost_microcents: number;
  created_at: number;
  stale_after: number;
};

type AuditRow = {
  action: string;
  resource_type: string;
  resource_id: string;
  created_at: number;
};

const DASHBOARD_HTML = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>tkslopper operations</title>
    <style nonce="__CSP_NONCE__">
      :root {
        color-scheme: light;
        --ink: #13201c;
        --muted: #5d6e67;
        --paper: #f4f1e9;
        --card: #fffdf7;
        --line: #d9d4c6;
        --accent: #136f63;
        --accent-soft: #dceee9;
        --danger: #a6382d;
        --danger-soft: #f8dfda;
        --warning: #95620a;
        --shadow: 0 16px 40px rgb(28 45 39 / 8%);
      }

      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      body {
        margin: 0;
        min-width: 320px;
        background:
          radial-gradient(circle at 84% 8%, rgb(19 111 99 / 10%), transparent 28rem),
          var(--paper);
        color: var(--ink);
        font: 15px/1.45 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }

      .shell { width: min(1440px, calc(100% - 40px)); margin: 0 auto; }
      header { padding: 42px 0 28px; }
      .eyebrow {
        margin: 0 0 8px;
        color: var(--accent);
        font-size: 12px;
        font-weight: 800;
        letter-spacing: .12em;
        text-transform: uppercase;
      }
      h1 { margin: 0; font: 700 clamp(30px, 5vw, 52px)/1.03 Georgia, serif; }
      .lede { max-width: 740px; margin: 12px 0 0; color: var(--muted); }

      .auth {
        display: grid;
        grid-template-columns: minmax(220px, 420px) auto 1fr;
        gap: 10px;
        align-items: center;
        margin-top: 24px;
      }
      input, button {
        min-height: 44px;
        border: 1px solid var(--line);
        border-radius: 10px;
        font: inherit;
      }
      input { width: 100%; padding: 0 14px; background: var(--card); color: var(--ink); }
      button {
        padding: 0 18px;
        border-color: var(--accent);
        background: var(--accent);
        color: white;
        font-weight: 750;
        cursor: pointer;
      }
      button:hover { filter: brightness(.94); }
      button:focus-visible, input:focus-visible { outline: 3px solid rgb(19 111 99 / 25%); outline-offset: 2px; }
      #status { color: var(--muted); font-size: 13px; }
      #status.error { color: var(--danger); font-weight: 700; }

      main { display: grid; gap: 24px; padding-bottom: 56px; }
      .cards { display: grid; grid-template-columns: repeat(6, minmax(140px, 1fr)); gap: 12px; }
      .card, section {
        border: 1px solid var(--line);
        border-radius: 14px;
        background: rgb(255 253 247 / 88%);
        box-shadow: var(--shadow);
      }
      .card { min-height: 116px; padding: 18px; }
      .card span { display: block; color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
      .card strong { display: block; margin-top: 12px; font: 700 27px/1 Georgia, serif; }
      .card.alert strong { color: var(--danger); }

      section { min-width: 0; padding: 20px; }
      .section-head { display: flex; gap: 16px; align-items: baseline; justify-content: space-between; margin-bottom: 14px; }
      h2 { margin: 0; font: 700 22px/1.2 Georgia, serif; }
      .section-note { margin: 0; color: var(--muted); font-size: 13px; }
      .table-wrap { max-width: 100%; overflow-x: auto; overscroll-behavior-x: contain; }
      .table-wrap::before { display: none; }
      table { width: 100%; border-collapse: collapse; white-space: nowrap; }
      th, td { padding: 11px 12px; border-bottom: 1px solid var(--line); text-align: left; }
      th { color: var(--muted); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
      tbody tr:last-child td { border-bottom: 0; }
      tbody tr:hover { background: var(--accent-soft); }
      #attempts { min-width: 1145px; table-layout: fixed; }
      #attempts th:nth-child(1) { width: 145px; }
      #attempts th:nth-child(2) { width: 160px; }
      #attempts th:nth-child(3) { width: 155px; }
      #attempts th:nth-child(4) { width: 220px; }
      #attempts th:nth-child(5) { width: 145px; }
      #attempts th:nth-child(6) { width: 105px; }
      #attempts th:nth-child(7) { width: 135px; }
      #attempts th:nth-child(8) { width: 80px; }
      #attempts td { overflow: hidden; text-overflow: ellipsis; }
      #audit { table-layout: fixed; }
      #audit th:nth-child(1) { width: 25%; }
      #audit th:nth-child(2) { width: 20%; }
      #audit th:nth-child(3) { width: 55%; }
      .empty { color: var(--muted); font-style: italic; }
      .split { display: grid; grid-template-columns: 1fr; gap: 24px; }
      .limitation { border-left: 4px solid var(--warning); }

      footer { padding: 0 0 42px; color: var(--muted); font-size: 12px; }
      code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }

      @media (max-width: 1100px) {
        .cards { grid-template-columns: repeat(3, 1fr); }
        .split { grid-template-columns: 1fr; }
      }
      @media (max-width: 680px) {
        .shell { width: min(100% - 24px, 1440px); }
        header { padding-top: 26px; }
        .auth { grid-template-columns: 1fr; }
        .cards { grid-template-columns: repeat(2, 1fr); }
        section { padding: 16px; }
        .table-wrap::before {
          position: sticky;
          left: 0;
          display: block;
          padding: 0 0 8px;
          color: var(--muted);
          content: "Swipe horizontally for all columns →";
          font-size: 12px;
        }
        #stale { min-width: 700px; }
        #audit { min-width: 640px; }
        #audit th:nth-child(1) { width: 170px; }
        #audit th:nth-child(2) { width: 100px; }
        #audit th:nth-child(3) { width: 370px; }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <p class="eyebrow">Control plane · read only</p>
        <h1>tkslopper operations</h1>
        <p class="lede">Metadata-only visibility into product state, recent physical attempts, accounting, stale work, and administrative changes. Prompts, responses, credentials, and raw identities never appear here.</p>
        <form class="auth" id="auth-form">
          <label><span class="eyebrow">Dashboard token</span><input id="token" type="password" autocomplete="off" required aria-label="Dashboard token"></label>
          <button type="submit">Load dashboard</button>
          <span id="status" role="status" aria-live="polite">Enter the separate read-only token. It is kept in memory only.</span>
        </form>
      </header>

      <main id="dashboard" hidden>
        <div class="cards" aria-label="24 hour summary">
          <div class="card"><span>Products</span><strong id="total-products">—</strong></div>
          <div class="card"><span>Environments</span><strong id="total-environments">—</strong></div>
          <div class="card"><span>Attempts · 24h</span><strong id="total-attempts">—</strong></div>
          <div class="card"><span>Failures · 24h</span><strong id="total-failures">—</strong></div>
          <div class="card"><span>Cost · 24h</span><strong id="total-cost">—</strong></div>
          <div class="card alert"><span>Stale attempts</span><strong id="total-stale">—</strong></div>
        </div>

        <section>
          <div class="section-head"><h2>Environments</h2><p class="section-note">Policy state and persisted 24-hour accounting</p></div>
          <div class="table-wrap" tabindex="0" aria-label="Environments table; scroll horizontally for all columns"><table id="environments"></table></div>
        </section>

        <section>
          <div class="section-head"><h2>Recent attempts</h2><p class="section-note">Latest 50 physical attempt records</p></div>
          <div class="table-wrap" tabindex="0" aria-label="Recent attempts table; scroll horizontally for all columns"><table id="attempts"></table></div>
        </section>

        <div class="split">
          <section>
            <div class="section-head"><h2>Stale attempts</h2><p class="section-note">Past route deadline plus grace</p></div>
            <div class="table-wrap" tabindex="0" aria-label="Stale attempts table; scroll horizontally for all columns"><table id="stale"></table></div>
          </section>
          <section>
            <div class="section-head"><h2>Admin activity</h2><p class="section-note">Latest 25 audited mutations</p></div>
            <div class="table-wrap" tabindex="0" aria-label="Admin activity table; scroll horizontally for all columns"><table id="audit"></table></div>
          </section>
        </div>

        <section class="limitation">
          <div class="section-head"><h2>Live quota state</h2><p class="section-note">Not enumerated</p></div>
          <p id="quota-note" class="section-note"></p>
        </section>
      </main>

      <footer>Generated <span id="generated-at">after authentication</span>. Values are operational metadata, not billing records.</footer>
    </div>

    <script nonce="__CSP_NONCE__">
      const form = document.getElementById("auth-form");
      const token = document.getElementById("token");
      const status = document.getElementById("status");
      const dashboard = document.getElementById("dashboard");

      const number = (value) => {
        try { return new Intl.NumberFormat().format(BigInt(String(value ?? 0))); }
        catch { return String(value ?? 0); }
      };
      const time = (value) => value ? new Date(Number(value) * 1000).toLocaleString() : "—";
      const cost = (value) => number(value) + " μ¢";
      const set = (id, value) => { document.getElementById(id).textContent = String(value); };

      function renderTable(id, columns, rows) {
        const table = document.getElementById(id);
        const head = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const column of columns) {
          const cell = document.createElement("th");
          cell.scope = "col";
          cell.textContent = column.label;
          headRow.append(cell);
        }
        head.append(headRow);
        const body = document.createElement("tbody");
        if (!rows.length) {
          const row = document.createElement("tr");
          const cell = document.createElement("td");
          cell.colSpan = columns.length;
          cell.className = "empty";
          cell.textContent = "No records";
          row.append(cell);
          body.append(row);
        } else {
          for (const item of rows) {
            const row = document.createElement("tr");
            for (const column of columns) {
              const cell = document.createElement("td");
              const raw = typeof column.value === "function" ? column.value(item) : item[column.value];
              cell.textContent = String(column.format ? column.format(raw) : raw ?? "—");
              cell.title = String(raw ?? "");
              row.append(cell);
            }
            body.append(row);
          }
        }
        table.replaceChildren(head, body);
      }

      function render(data) {
        set("total-products", number(data.totals.products));
        set("total-environments", number(data.totals.environments));
        set("total-attempts", number(data.totals.attempts_24h));
        set("total-failures", number(data.totals.failed_attempts_24h));
        set("total-cost", cost(data.totals.cost_microcents_24h));
        set("total-stale", number(data.totals.stale_attempts));
        set("generated-at", time(data.generated_at));
        set("quota-note", data.live_quota.reason);

        const productNames = Object.fromEntries(data.products.map((item) => [item.id, item.display_name]));
        renderTable("environments", [
          { label: "Product", value: (row) => productNames[row.product_id] || row.product_id },
          { label: "Environment", value: "name" },
          { label: "State", value: (row) => row.kill_switch ? "KILLED" : row.enabled ? "Enabled" : "Disabled" },
          { label: "Attempts", value: "attempts_24h", format: number },
          { label: "Failures", value: "failed_attempts_24h", format: number },
          { label: "Input tokens", value: "input_tokens_24h", format: number },
          { label: "Output tokens", value: "output_tokens_24h", format: number },
          { label: "Cost", value: "cost_microcents_24h", format: cost },
          { label: "Aliases", value: "aliases", format: number },
          { label: "Active grants", value: "active_grants", format: number },
        ], data.environments);
        renderTable("attempts", [
          { label: "Time", value: "created_at", format: time },
          { label: "Request", value: "request_id" },
          { label: "Alias", value: "alias" },
          { label: "Provider / model", value: (row) => row.provider + " / " + row.resolved_model },
          { label: "Status", value: (row) => row.error_class || row.status_code },
          { label: "Latency", value: (row) => number(row.latency_ms) + " ms" },
          { label: "Tokens", value: (row) => number(row.input_tokens) + " / " + number(row.output_tokens) },
          { label: "Cost", value: "cost_microcents", format: cost },
        ], data.recent_attempts);
        renderTable("stale", [
          { label: "Stale since", value: "stale_after", format: time },
          { label: "Request", value: "request_id" },
          { label: "Route", value: "route_id" },
          { label: "Provider", value: "provider" },
          { label: "Cost ceiling", value: "cost_microcents", format: cost },
        ], data.stale_attempts);
        renderTable("audit", [
          { label: "Time", value: "created_at", format: time },
          { label: "Action", value: "action" },
          { label: "Resource", value: (row) => row.resource_type + " / " + row.resource_id },
        ], data.recent_admin_actions);
      }

      form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const suppliedToken = token.value;
        token.value = "";
        status.className = "";
        status.textContent = "Loading metadata…";
        dashboard.hidden = true;
        try {
          const response = await fetch("/admin/v1/dashboard", {
            headers: { authorization: "Bearer " + suppliedToken },
            cache: "no-store",
          });
          if (!response.ok) throw new Error(response.status === 401 ? "Dashboard authentication failed." : "Dashboard data is unavailable.");
          render(await response.json());
          dashboard.hidden = false;
          status.textContent = "Loaded. Token was not stored; re-enter it to refresh.";
        } catch (error) {
          status.className = "error";
          status.textContent = error instanceof Error ? error.message : "Dashboard data is unavailable.";
        }
      });
    </script>
  </body>
</html>`;

export function dashboardPage(): Response {
  const nonce = randomSecret(16);
  return new Response(DASHBOARD_HTML.replaceAll("__CSP_NONCE__", nonce), {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "content-type": "text/html; charset=utf-8",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
    },
  });
}

async function requireDashboard(
  request: Request,
  env: DashboardEnv,
): Promise<void> {
  const supplied = bearerToken(request);
  if (!supplied)
    throw new HttpError(
      401,
      "authentication_failed",
      "dashboard authentication failed",
    );
  const [suppliedHash, expectedHash] = await Promise.all([
    sha256(supplied),
    sha256(env.DASHBOARD_TOKEN),
  ]);
  if (suppliedHash !== expectedHash)
    throw new HttpError(
      401,
      "authentication_failed",
      "dashboard authentication failed",
    );
}

export async function dashboardOverview(
  request: Request,
  env: DashboardEnv,
): Promise<Response> {
  await requireDashboard(request, env);
  const generatedAt = Math.floor(Date.now() / 1000);
  const since = generatedAt - 86_400;
  const [products, environments, totals, attempts, stale, actions] =
    await Promise.all([
      env.DB.prepare(
        `SELECT id, slug, display_name, enabled, kill_switch
           FROM products
          ORDER BY slug`,
      ).all<ProductRow>(),
      env.DB.prepare(
        `SELECT e.id, e.product_id, e.name, e.audience, e.enabled, e.kill_switch,
                e.policy_version, e.rpm_limit, e.tpm_limit, e.concurrency_limit,
                e.daily_budget_microcents, e.max_request_bytes,
                (SELECT COUNT(*) FROM aliases a
                  WHERE a.product_id = e.product_id AND a.environment_id = e.id AND a.enabled = 1) AS aliases,
                (SELECT COUNT(*) FROM entitlements n
                  WHERE n.product_id = e.product_id AND n.environment_id = e.id
                    AND n.status = 'active' AND (n.expires_at IS NULL OR n.expires_at > ?)) AS active_entitlements,
                (SELECT COUNT(*) FROM token_grants g
                  WHERE g.product_id = e.product_id AND g.environment_id = e.id
                    AND g.revoked_at IS NULL AND g.expires_at > ?) AS active_grants,
                (SELECT COUNT(*) FROM provider_attempts x
                  WHERE x.product_id = e.product_id AND x.environment_id = e.id
                    AND x.created_at >= ?) AS attempts_24h,
                (SELECT COUNT(*) FROM provider_attempts x
                  WHERE x.product_id = e.product_id AND x.environment_id = e.id
                    AND x.created_at >= ? AND x.error_class IS NOT NULL) AS failed_attempts_24h,
                CAST((SELECT COALESCE(SUM(x.input_tokens), 0) FROM provider_attempts x
                  WHERE x.product_id = e.product_id AND x.environment_id = e.id
                    AND x.created_at >= ?) AS TEXT) AS input_tokens_24h,
                CAST((SELECT COALESCE(SUM(x.output_tokens), 0) FROM provider_attempts x
                  WHERE x.product_id = e.product_id AND x.environment_id = e.id
                    AND x.created_at >= ?) AS TEXT) AS output_tokens_24h,
                CAST((SELECT COALESCE(SUM(x.cost_microcents), 0) FROM provider_attempts x
                  WHERE x.product_id = e.product_id AND x.environment_id = e.id
                    AND x.created_at >= ?) AS TEXT) AS cost_microcents_24h
           FROM environments e
          ORDER BY e.product_id, e.name`,
      )
        .bind(generatedAt, generatedAt, since, since, since, since, since)
        .all<EnvironmentRow>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS attempts_24h,
                COALESCE(SUM(CASE WHEN error_class IS NOT NULL THEN 1 ELSE 0 END), 0) AS failed_attempts_24h,
                CAST(COALESCE(SUM(input_tokens), 0) AS TEXT) AS input_tokens_24h,
                CAST(COALESCE(SUM(output_tokens), 0) AS TEXT) AS output_tokens_24h,
                CAST(COALESCE(SUM(cost_microcents), 0) AS TEXT) AS cost_microcents_24h,
                (SELECT COUNT(*) FROM stale_provider_attempts) AS stale_attempts
           FROM provider_attempts
          WHERE created_at >= ?`,
      )
        .bind(since)
        .first<TotalsRow>(),
      env.DB.prepare(
        `SELECT request_id, product_id, environment_id, alias, policy_version, route_id,
                provider, resolved_model, endpoint, status_code, error_class, latency_ms,
                input_tokens, output_tokens, cost_microcents, created_at
           FROM provider_attempts
          ORDER BY created_at DESC
          LIMIT 50`,
      ).all<AttemptRow>(),
      env.DB.prepare(
        `SELECT request_id, product_id, environment_id, route_id, provider, resolved_model,
                endpoint, input_tokens, output_tokens, cost_microcents, created_at, stale_after
           FROM stale_provider_attempts
          ORDER BY stale_after
          LIMIT 50`,
      ).all<StaleAttemptRow>(),
      env.DB.prepare(
        `SELECT action, resource_type, resource_id, created_at
           FROM admin_audit
          ORDER BY created_at DESC
          LIMIT 25`,
      ).all<AuditRow>(),
    ]);

  const normalizedProducts = products.results.map((product) => ({
    ...product,
    enabled: product.enabled === 1,
    kill_switch: product.kill_switch === 1,
  }));
  const normalizedEnvironments = environments.results.map((environment) => ({
    ...environment,
    enabled: environment.enabled === 1,
    kill_switch: environment.kill_switch === 1,
  }));

  return jsonResponse({
    generated_at: generatedAt,
    totals: {
      products: normalizedProducts.length,
      environments: normalizedEnvironments.length,
      attempts_24h: totals?.attempts_24h ?? 0,
      failed_attempts_24h: totals?.failed_attempts_24h ?? 0,
      input_tokens_24h: totals?.input_tokens_24h ?? "0",
      output_tokens_24h: totals?.output_tokens_24h ?? "0",
      cost_microcents_24h: totals?.cost_microcents_24h ?? "0",
      stale_attempts: totals?.stale_attempts ?? 0,
    },
    products: normalizedProducts,
    environments: normalizedEnvironments,
    recent_attempts: attempts.results,
    stale_attempts: stale.results,
    recent_admin_actions: actions.results,
    live_quota: {
      available: false,
      reason:
        "Current per-principal reservations remain Durable Object-local and cannot be enumerated. Persisted attempt accounting is shown above.",
    },
  });
}
