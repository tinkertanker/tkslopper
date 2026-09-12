import { jsonResponse, randomSecret } from "@tkslopper/shared";
import { requireAccessEmail } from "./admin-access";

export type DashboardEnv = {
  DB: D1Database;
  DASHBOARD_ACCESS_AUD?: string;
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
  product_enabled: number;
  product_kill_switch: number;
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
  effective_grants: number;
  effective_grants_truncated: number;
  finalized_attempts_24h: number;
  failed_finalized_attempts_24h: number;
  accounted_input_tokens_24h: string;
  accounted_output_tokens_24h: string;
  accounted_cost_microcents_24h: string;
};

type TotalsRow = {
  finalized_attempts_24h: number;
  failed_finalized_attempts_24h: number;
  accounted_input_tokens_24h: string;
  accounted_output_tokens_24h: string;
  accounted_cost_microcents_24h: string;
  stale_attempts: number;
  finalized_attempts_truncated: number;
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
  stale_after: number;
};

type StaleAttemptRow = {
  request_id: string;
  product_id: string;
  environment_id: string;
  alias: string;
  policy_version: number;
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

export const DASHBOARD_ATTEMPT_LIMIT = 10_000;
export const DASHBOARD_INVENTORY_COUNT_LIMIT = 1000;
export const DASHBOARD_STALE_DETAIL_LIMIT = 50;

export const DASHBOARD_ENVIRONMENTS_SQL = `WITH selected_environments AS (
  SELECT e.id, e.product_id, e.name, e.audience,
         p.enabled AS product_enabled, p.kill_switch AS product_kill_switch,
         e.enabled, e.kill_switch, e.policy_version, e.rpm_limit, e.tpm_limit,
         e.concurrency_limit, e.daily_budget_microcents, e.max_request_bytes
    FROM environments e
    JOIN products p ON p.id = e.product_id
   ORDER BY e.product_id, e.name
   LIMIT ?
),
bounded_attempts AS (
  SELECT product_id, environment_id, error_class, input_tokens, output_tokens, cost_microcents
    FROM provider_attempts INDEXED BY provider_attempts_finalized_time_idx
   WHERE created_at >= ?
     AND (error_class IS NULL OR error_class <> 'attempt_started')
   ORDER BY created_at DESC
   LIMIT ?
),
attempt_counts AS (
  SELECT product_id, environment_id,
         COUNT(*) AS finalized_attempts_24h,
         SUM(CASE WHEN error_class IS NOT NULL THEN 1 ELSE 0 END) AS failed_finalized_attempts_24h,
         SUM(input_tokens) AS accounted_input_tokens_24h,
         SUM(output_tokens) AS accounted_output_tokens_24h,
         SUM(cost_microcents) AS accounted_cost_microcents_24h
    FROM bounded_attempts
   GROUP BY product_id, environment_id
)
SELECT e.*,
       (SELECT COUNT(*) FROM (
          SELECT 1
            FROM aliases AS a INDEXED BY aliases_environment_active_idx
           WHERE a.product_id = e.product_id AND a.environment_id = e.id AND a.enabled = 1
           LIMIT ?
       )) AS aliases,
       (SELECT COUNT(*) FROM (
          SELECT 1
            FROM entitlements AS n INDEXED BY entitlements_environment_active_idx
           WHERE n.product_id = e.product_id AND n.environment_id = e.id
             AND n.status = 'active' AND (n.expires_at IS NULL OR n.expires_at > ?)
           LIMIT ?
       )) AS active_entitlements,
       CASE WHEN e.product_enabled = 1 AND e.product_kill_switch = 0
                  AND e.enabled = 1 AND e.kill_switch = 0
         THEN (SELECT CASE WHEN COUNT(*) > ? THEN 1 ELSE 0 END FROM (
                SELECT 1
                  FROM token_grants AS candidate INDEXED BY token_grants_environment_active_idx
                 WHERE candidate.product_id = e.product_id
                   AND candidate.environment_id = e.id
                   AND candidate.revoked_at IS NULL AND candidate.expires_at > ?
                 LIMIT ?
              ))
         ELSE 0
       END AS effective_grants_truncated,
       CASE WHEN e.product_enabled = 1 AND e.product_kill_switch = 0
                  AND e.enabled = 1 AND e.kill_switch = 0
         THEN (SELECT COUNT(*)
                 FROM token_grants AS g
                 CROSS JOIN entitlements AS n
                WHERE g.rowid IN (
                  SELECT candidate.rowid
                    FROM token_grants AS candidate INDEXED BY token_grants_environment_active_idx
                   WHERE candidate.product_id = e.product_id
                     AND candidate.environment_id = e.id
                     AND candidate.revoked_at IS NULL AND candidate.expires_at > ?
                   LIMIT ?
                )
                  AND n.id = g.entitlement_id
                  AND n.product_id = g.product_id
                  AND n.environment_id = g.environment_id
                  AND n.tenant_id = g.tenant_id
                  AND n.principal_id = g.principal_id
                  AND n.status = 'active' AND (n.expires_at IS NULL OR n.expires_at > ?)
                  AND (n.source <> 'service' OR EXISTS (
                    SELECT 1
                      FROM service_credentials AS s
                     WHERE s.id = n.source_ref
                       AND s.product_id = g.product_id
                       AND s.environment_id = g.environment_id
                       AND s.tenant_id = g.tenant_id
                       AND s.principal_id = g.principal_id
                       AND s.disabled = 0
                       AND (s.expires_at IS NULL OR s.expires_at > ?)
                  ))
                  AND (n.source <> 'access_code' OR EXISTS (
                    SELECT 1
                      FROM access_codes AS c
                      JOIN activations AS a
                        ON a.access_code_id = c.id
                       AND a.tenant_id = c.tenant_id
                     WHERE c.id = n.source_ref
                       AND c.product_id = g.product_id
                       AND c.environment_id = g.environment_id
                       AND c.tenant_id = g.tenant_id
                       AND c.disabled = 0 AND c.expires_at > ?
                       AND a.principal_id = g.principal_id
                       AND a.revoked_at IS NULL
                  )))
         ELSE 0
       END AS effective_grants,
       COALESCE(x.finalized_attempts_24h, 0) AS finalized_attempts_24h,
       COALESCE(x.failed_finalized_attempts_24h, 0) AS failed_finalized_attempts_24h,
       CAST(COALESCE(x.accounted_input_tokens_24h, 0) AS TEXT) AS accounted_input_tokens_24h,
       CAST(COALESCE(x.accounted_output_tokens_24h, 0) AS TEXT) AS accounted_output_tokens_24h,
       CAST(COALESCE(x.accounted_cost_microcents_24h, 0) AS TEXT) AS accounted_cost_microcents_24h
  FROM selected_environments AS e
  LEFT JOIN attempt_counts AS x
    ON x.product_id = e.product_id AND x.environment_id = e.id
 ORDER BY e.product_id, e.name`;

export const DASHBOARD_TOTALS_SQL = `WITH bounded_finalized AS (
  SELECT error_class, input_tokens, output_tokens, cost_microcents
    FROM provider_attempts INDEXED BY provider_attempts_finalized_time_idx
   WHERE created_at >= ?
     AND (error_class IS NULL OR error_class <> 'attempt_started')
   ORDER BY created_at DESC
   LIMIT ?
),
included_finalized AS (
  SELECT * FROM bounded_finalized LIMIT ?
),
bounded_stale AS (
  SELECT 1
    FROM provider_attempts INDEXED BY provider_attempts_stale_idx
   WHERE error_class = 'attempt_started' AND stale_after <= ?
   ORDER BY stale_after
   LIMIT ?
)
SELECT COUNT(*) AS finalized_attempts_24h,
       COALESCE(SUM(CASE WHEN error_class IS NOT NULL THEN 1 ELSE 0 END), 0) AS failed_finalized_attempts_24h,
       CAST(COALESCE(SUM(input_tokens), 0) AS TEXT) AS accounted_input_tokens_24h,
       CAST(COALESCE(SUM(output_tokens), 0) AS TEXT) AS accounted_output_tokens_24h,
       CAST(COALESCE(SUM(cost_microcents), 0) AS TEXT) AS accounted_cost_microcents_24h,
       (SELECT COUNT(*) FROM bounded_stale) AS stale_attempts,
       (SELECT COUNT(*) FROM bounded_finalized) > ? AS finalized_attempts_truncated
  FROM included_finalized`;

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
        --muted: #53635c;
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
      input, button, select {
        min-height: 44px;
        border: 1px solid var(--line);
        border-radius: 10px;
        font: inherit;
      }
      input, select { width: 100%; padding: 0 14px; border: 2px solid var(--muted); background: var(--card); color: var(--ink); }
      .admin-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin: 16px 0; }
      .admin-fields label { display: grid; gap: 6px; min-width: 0; }
      .admin-body { min-width: 0; }
      #admin-panel .section-head { flex-wrap: wrap; }
      #admin-identity { overflow-wrap: anywhere; min-width: 0; }
      .admin-body pre { white-space: pre-wrap; overflow-wrap: anywhere; }
      select:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
      button {
        padding: 0 18px;
        border-color: var(--accent);
        background: var(--accent);
        color: white;
        font-weight: 750;
        cursor: pointer;
      }
      button:hover { filter: brightness(.94); }
      button:focus-visible, input:focus-visible, .table-wrap:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
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
      .card { min-width: 0; min-height: 116px; padding: 18px; }
      .card span { display: block; color: var(--muted); font-size: 12px; font-weight: 700; text-transform: uppercase; }
      .card strong { display: block; min-width: 0; margin-top: 12px; overflow-wrap: anywhere; font: 700 27px/1.1 Georgia, serif; }
      .card.alert strong { color: var(--danger); }

      section { min-width: 0; padding: 20px; }
      .section-head { display: flex; gap: 16px; align-items: baseline; justify-content: space-between; margin-bottom: 14px; }
      h2 { margin: 0; font: 700 22px/1.2 Georgia, serif; }
      .section-note { margin: 0; color: var(--muted); font-size: 13px; }
      .notice { margin: 0; padding: 12px 16px; border-left: 4px solid var(--warning); border-radius: 8px; background: #fff7df; color: var(--ink); font-weight: 650; }
      .table-wrap { max-width: 100%; overflow-x: auto; overscroll-behavior-x: contain; }
      .table-wrap::before { display: none; }
      table { width: 100%; border-collapse: collapse; white-space: nowrap; }
      th, td { padding: 11px 12px; border-bottom: 1px solid var(--line); text-align: left; }
      th { color: var(--muted); font-size: 11px; letter-spacing: .06em; text-transform: uppercase; }
      tbody tr:last-child td { border-bottom: 0; }
      tbody tr:hover { background: var(--accent-soft); }
      #attempts { min-width: 2000px; table-layout: fixed; }
      #attempts th { overflow-wrap: anywhere; white-space: normal; }
      #attempts th:nth-child(1) { width: 230px; }
      #attempts th:nth-child(2), #attempts th:nth-child(3), #attempts th:nth-child(6) { width: 150px; }
      #attempts th:nth-child(4) { width: 140px; }
      #attempts th:nth-child(5) { width: 135px; }
      #attempts th:nth-child(7) { width: 190px; }
      #attempts th:nth-child(8) { width: 100px; }
      #attempts th:nth-child(9), #attempts th:nth-child(11) { width: 90px; }
      #attempts th:nth-child(10) { width: 130px; }
      #attempts th:nth-child(12) { width: 200px; }
      #attempts th:nth-child(13) { width: 195px; }
      #attempts td { overflow-wrap: anywhere; white-space: normal; vertical-align: top; }
      #stale { min-width: 1950px; table-layout: fixed; }
      #stale th, #stale td { overflow-wrap: anywhere; white-space: normal; vertical-align: top; }
      #audit { table-layout: fixed; }
      #audit th, #audit td { overflow-wrap: anywhere; white-space: normal; vertical-align: top; }
      #audit th:nth-child(1) { width: 25%; }
      #audit th:nth-child(2) { width: 20%; }
      #audit th:nth-child(3) { width: 55%; }
      .empty { color: var(--muted); font-style: italic; }
      .split { display: grid; grid-template-columns: 1fr; gap: 24px; }
      .limitation { border-left: 4px solid var(--warning); }

      footer { padding: 0 0 42px; color: var(--muted); font-size: 12px; }
      code { font-family: ui-monospace, SFMono-Regular, Consolas, monospace; }

      @media (max-width: 1100px) {
        .cards { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .split { grid-template-columns: 1fr; }
      }
      @media (max-width: 680px) {
        .shell { width: min(100% - 24px, 1440px); }
        header { padding-top: 26px; }
        .auth { grid-template-columns: 1fr; }
        .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
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
        #audit { min-width: 640px; }
        #audit th:nth-child(1) { width: 170px; }
        #audit th:nth-child(2) { width: 100px; }
        #audit th:nth-child(3) { width: 370px; }
      }
      @media (max-width: 480px) {
        .cards { grid-template-columns: minmax(0, 1fr); }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <header>
        <p class="eyebrow" id="role-label">Control plane · read only</p>
        <h1>tkslopper operations</h1>
        <p class="lede">Operational metadata without prompts or responses. Named admins can manage access and configuration; issued credentials appear only in the operation result.</p>
        <div class="auth">
          <button type="button" id="refresh">Refresh dashboard</button>
          <a href="/cdn-cgi/access/logout">Sign out</a>
          <span id="status" role="status" aria-live="polite">Loading metadata…</span>
        </div>
      </header>

      <main id="dashboard" hidden>
        <p id="inventory-warning" class="notice" role="status" hidden></p>

        <section id="admin-panel" hidden>
          <div class="section-head"><h2 id="admin-heading">Administration</h2><p class="section-note" id="admin-identity"></p></div>
          <div class="admin-body">
            <p>All admins have full write access. People must also be allowed by Cloudflare Access to sign in. Other company users remain viewers.</p>
            <div class="table-wrap" role="region" tabindex="0" aria-label="Named admins"><table id="admin-members"></table></div>
            <p id="admin-limit" hidden>Only the first 100 admins are shown. You can still manage an exact email using the form.</p>
            <form id="admin-form" autocomplete="off">
              <label for="admin-operation">Operation</label>
              <select id="admin-operation"></select>
              <div id="admin-fields" class="admin-fields"></div>
              <p>Use product and environment IDs from the tables below. Submission changes live state. There is no automatic retry.</p>
              <button id="admin-submit" type="submit">Review and apply</button>
            </form>
            <p id="admin-result-status" role="status" aria-live="polite"></p>
            <div id="admin-result" hidden>
              <p>Copy issued credentials now: they cannot be retrieved later. Do not put them in tickets or logs.</p>
              <pre id="admin-result-data"></pre>
              <button id="admin-clear" type="button">Clear result</button>
            </div>
            <h3 id="admin-audit-heading">Who changed what</h3>
            <p>Latest 25 actions. API credential means a legacy API/CLI caller, not an identified person.</p>
            <div class="table-wrap" role="region" tabindex="0" aria-labelledby="admin-audit-heading"><table id="admin-audit"></table></div>
          </div>
        </section>

        <div class="cards" role="list" aria-label="24 hour summary">
          <div class="card" role="listitem"><span>Products shown</span><strong id="total-products">—</strong></div>
          <div class="card" role="listitem"><span>Environments shown</span><strong id="total-environments">—</strong></div>
          <div class="card" role="listitem"><span>Finalized · 24h</span><strong id="total-attempts">—</strong></div>
          <div class="card" role="listitem"><span>Finalized failures · 24h</span><strong id="total-failures">—</strong></div>
          <div class="card" role="listitem"><span>Accounted cost · 24h</span><strong id="total-cost">—</strong></div>
          <div class="card alert" role="listitem"><span>Stale intents</span><strong id="total-stale">—</strong></div>
        </div>

        <section>
          <div class="section-head"><h2 id="products-heading">Products</h2><p class="section-note">Bounded inventory and parent policy state</p></div>
          <div class="table-wrap" role="region" tabindex="0" aria-labelledby="products-heading"><table id="products"></table></div>
        </section>

        <section>
          <div class="section-head"><h2 id="environments-heading">Environments</h2><p class="section-note">Bounded inventory; policy state and latest finalized 24-hour accounting records</p></div>
          <div class="table-wrap" role="region" tabindex="0" aria-labelledby="environments-heading"><table id="environments"></table></div>
        </section>

        <section>
          <div class="section-head"><h2 id="attempts-heading">Recent attempt records</h2><p class="section-note">Latest 50 intents or finalized records after quota admission</p></div>
          <div class="table-wrap" role="region" tabindex="0" aria-labelledby="attempts-heading"><table id="attempts"></table></div>
        </section>

        <div class="split">
          <section>
            <div class="section-head"><h2 id="stale-heading">Stale intents</h2><p class="section-note">Oldest 50 past route deadline plus grace; usage values are reservation ceilings</p></div>
            <div class="table-wrap" role="region" tabindex="0" aria-labelledby="stale-heading"><table id="stale"></table></div>
          </section>
          <section>
            <div class="section-head"><h2 id="audit-heading">Admin activity</h2><p class="section-note">Latest 25 audited mutations</p></div>
            <div class="table-wrap" role="region" tabindex="0" aria-labelledby="audit-heading"><table id="audit"></table></div>
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
      const refresh = document.getElementById("refresh");
      const status = document.getElementById("status");
      const dashboard = document.getElementById("dashboard");

      const number = (value) => {
        try { return new Intl.NumberFormat().format(BigInt(String(value ?? 0))); }
        catch { return String(value ?? 0); }
      };
      const time = (value) => value ? new Date(Number(value) * 1000).toISOString().replace("T", " ").replace(".000Z", " UTC") : "—";
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
        set("total-attempts", number(data.totals.finalized_attempts_24h));
        set("total-failures", number(data.totals.failed_finalized_attempts_24h));
        set("total-cost", cost(data.totals.accounted_cost_microcents_24h));
        set("total-stale", number(data.totals.stale_attempts));
        set("generated-at", time(data.generated_at));
        set("quota-note", data.live_quota.reason);

        const warnings = [];
        if (data.inventory_truncated.products) warnings.push("Product inventory is truncated to the first 100 rows.");
        if (data.inventory_truncated.environments) warnings.push("Environment inventory is truncated to the first 250 rows.");
        if (data.inventory_truncated.environment_counts) warnings.push("One or more per-environment inventory counts are shown as bounded minimums.");
        if (data.accounting_truncated.finalized_attempts) warnings.push("24-hour accounting is truncated to the latest 10,000 finalized records.");
        if (data.accounting_truncated.stale_attempts) warnings.push("The stale-intent count is capped at 10,000.");
        if (data.accounting_truncated.stale_attempt_details) warnings.push("Stale-intent details are truncated to the oldest 50 records.");
        const warning = document.getElementById("inventory-warning");
        warning.textContent = warnings.join(" ");
        warning.hidden = warnings.length === 0;

        const productNames = Object.fromEntries(data.products.map((item) => [item.id, item.display_name]));
        const policyState = (enabled, killed) => killed ? "KILLED" : enabled ? "Enabled" : "Disabled";
        const boundedCount = (value, truncated) => truncated ? "≥" + number(value) : number(value);
        renderTable("products", [
          { label: "Product", value: "display_name" },
          { label: "ID", value: "id" },
          { label: "Slug", value: "slug" },
          { label: "State", value: (row) => policyState(row.enabled, row.kill_switch) },
        ], data.products);
        renderTable("environments", [
          { label: "Product", value: (row) => productNames[row.product_id] || row.product_id },
          { label: "Environment", value: "name" },
          { label: "Product state", value: (row) => policyState(row.product_enabled, row.product_kill_switch) },
          { label: "Environment state", value: (row) => policyState(row.enabled, row.kill_switch) },
          { label: "Policy", value: "policy_version", format: number },
          { label: "RPM", value: "rpm_limit", format: number },
          { label: "TPM", value: "tpm_limit", format: number },
          { label: "Concurrency", value: "concurrency_limit", format: number },
          { label: "Daily budget", value: "daily_budget_microcents", format: cost },
          { label: "Max request", value: (row) => number(row.max_request_bytes) + " bytes" },
          { label: "Finalized", value: "finalized_attempts_24h", format: number },
          { label: "Finalized failures", value: "failed_finalized_attempts_24h", format: number },
          { label: "Accounted input", value: "accounted_input_tokens_24h", format: number },
          { label: "Accounted output", value: "accounted_output_tokens_24h", format: number },
          { label: "Accounted cost", value: "accounted_cost_microcents_24h", format: cost },
          { label: "Aliases", value: (row) => boundedCount(row.aliases, row.aliases_truncated) },
          { label: "Active entitlements", value: (row) => boundedCount(row.active_entitlements, row.active_entitlements_truncated) },
          { label: "Effective grants", value: (row) => boundedCount(row.effective_grants, row.effective_grants_truncated) },
        ], data.environments);
        renderTable("attempts", [
          { label: "Time", value: "created_at", format: time },
          { label: "Product", value: "product_id" },
          { label: "Environment", value: "environment_id" },
          { label: "Request", value: "request_id" },
          { label: "Alias", value: "alias" },
          { label: "Route", value: "route_id" },
          { label: "Provider / model", value: (row) => row.provider + " / " + row.resolved_model },
          { label: "Endpoint", value: "endpoint" },
          { label: "Policy", value: "policy_version", format: number },
          { label: "Status", value: "display_status" },
          { label: "Latency", value: (row) => number(row.latency_ms) + " ms" },
          { label: "Accounted tokens / ceiling", value: (row) => number(row.input_tokens) + " / " + number(row.output_tokens) },
          { label: "Accounted cost / ceiling", value: "cost_microcents", format: cost },
        ], data.recent_attempts);
        renderTable("stale", [
          { label: "Stale since", value: "stale_after", format: time },
          { label: "Created", value: "created_at", format: time },
          { label: "Product", value: "product_id" },
          { label: "Environment", value: "environment_id" },
          { label: "Request", value: "request_id" },
          { label: "Alias", value: "alias" },
          { label: "Policy", value: "policy_version", format: number },
          { label: "Route", value: "route_id" },
          { label: "Provider / model", value: (row) => row.provider + " / " + row.resolved_model },
          { label: "Endpoint", value: "endpoint" },
          { label: "Input ceiling", value: "input_tokens", format: number },
          { label: "Output ceiling", value: "output_tokens", format: number },
          { label: "Cost ceiling", value: "cost_microcents", format: cost },
        ], data.stale_attempts);
        renderTable("audit", [
          { label: "Time", value: "created_at", format: time },
          { label: "Action", value: "action" },
          { label: "Resource", value: (row) => row.resource_type + " / " + row.resource_id },
        ], data.recent_admin_actions);
      }

      const adminPanel = document.getElementById("admin-panel");
      const operation = document.getElementById("admin-operation");
      const fields = document.getElementById("admin-fields");
      const adminSubmit = document.getElementById("admin-submit");
      const scopeFields = [["product_id", "Product ID"], ["environment_id", "Environment ID"]];
      const identityFields = [["tenant_id", "Classroom / tenant ID"], ["principal_id", "Principal ID"]];
      const capabilities = ["capabilities", "Capabilities (comma separated)", "list"];
      const expiry = ["expires_at", "Expires at (local time)", "datetime-local"];
      const operations = [
        ["admins", "Manage admins", [["email", "Email", "email"], ["enabled", "Admin access", ["true", "false"]]]],
        ["access-codes", "Issue classroom code", [...scopeFields, identityFields[0], capabilities, expiry, ["max_activations", "Maximum activations", "number"], ["max_failed_attempts", "Maximum failed attempts", "number", 8]]],
        ["service-credentials", "Issue service key", [...scopeFields, ...identityFields, capabilities, [...expiry, "", true]]],
        ["revoke", "Revoke access", [["resource_type", "Resource type", ["access_code", "service_credential", "entitlement", "token_grant"]], ["resource_id", "Resource ID (not secret value)"]]],
        ["kill-switch", "Set kill switch", [["resource_type", "Resource type", ["environment", "product"]], ["resource_id", "Resource ID"], ["enabled", "Kill switch ON (true) / OFF (false)", ["true", "false"]]]],
        ["products", "Create product", [["slug", "Slug"], ["display_name", "Display name"]]],
        ["environments", "Create environment", [scopeFields[0], ["name", "Environment name"], ["audience", "Token audience"], ["rpm_limit", "Requests per minute", "number", 30], ["tpm_limit", "Tokens per minute", "number", 100000], ["concurrency_limit", "Concurrency", "number", 2], ["daily_budget_microcents", "Daily budget (microcents)", "number", 1000000]]],
        ["aliases", "Set model alias", [...scopeFields, ["alias", "Public alias"], ["endpoint", "Endpoint", ["chat", "responses"]], ["route_id", "Configured provider route ID"], ["max_input_tokens", "Maximum input tokens", "number"], ["max_output_tokens", "Maximum output tokens", "number"], ["input_cost_microcents_per_million", "Input microcents per million tokens", "number", 0], ["output_cost_microcents_per_million", "Output microcents per million tokens", "number", 0]]],
        ["entitlements", "Create entitlement", [...scopeFields, ...identityFields, ["source", "Source", ["contract", "stripe", "storekit", "dev"]], capabilities, [...expiry, "", true]]],
      ];
      for (const [value, label] of operations) { const option = document.createElement("option"); option.value = value; option.textContent = label; operation.append(option); }
      function clearResult() { document.getElementById("admin-result").hidden = true; set("admin-result-data", ""); }
      function renderFields() {
        clearResult();
        fields.replaceChildren();
        for (const [name, label, type = "text", initial = "", optional = false] of operations.find((item) => item[0] === operation.value)[2]) {
          const wrapper = document.createElement("label"); wrapper.textContent = label + (optional ? " (optional)" : "");
          const input = document.createElement(Array.isArray(type) ? "select" : "input");
          input.name = name; input.required = !optional;
          if (Array.isArray(type)) for (const value of type) { const option = document.createElement("option"); option.value = value; option.textContent = name === "enabled" && operation.value === "admins" ? (value === "true" ? "Grant admin" : "Remove admin") : value; input.append(option); }
          else { input.type = type === "list" ? "text" : type; if (type === "number") { input.step = "1"; input.min = "0"; } input.value = initial; }
          wrapper.append(input); fields.append(wrapper);
        }
      }
      operation.addEventListener("change", renderFields); renderFields();
      document.getElementById("admin-clear").addEventListener("click", clearResult);
      window.addEventListener("pagehide", clearResult);
      document.getElementById("admin-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        if (!window.confirm("Apply: " + operation.selectedOptions[0].textContent + "? This changes live state.")) return;
        const payload = {};
        const selected = operation.value;
        for (const [name, , type] of operations.find((item) => item[0] === selected)[2]) {
          const value = fields.querySelector('[name="' + name + '"]').value;
          if (value === "") continue;
          payload[name] = type === "number" ? Number(value) : type === "datetime-local" ? Math.floor(new Date(value).getTime() / 1000) : type === "list" ? value.split(",").map((item) => item.trim()).filter(Boolean) : Array.isArray(type) && type[0] === "true" ? value === "true" : value;
        }
        clearResult(); adminSubmit.disabled = true; refresh.disabled = true; operation.disabled = true;
        set("admin-result-status", "Applying…");
        try {
          const response = await fetch("/dashboard/api/" + selected, { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", redirect: "error", cache: "no-store", body: JSON.stringify(payload) });
          const result = await response.json();
          if (!response.ok) { if (response.status === 401 || response.status === 403) { adminPanel.hidden = true; status.textContent = "Admin access expired or was revoked. Reload to check your login."; } throw new Error(response.status >= 500 ? "Server error; check activity before retrying because the operation may have completed." : result.error?.message || "Operation rejected."); }
          if (selected === "admins") await loadDashboard();
          set("admin-result-status", "Operation completed. Copy any credentials before refreshing the dashboard.");
          if (!adminPanel.hidden) { set("admin-result-data", JSON.stringify(result, null, 2)); document.getElementById("admin-result").hidden = false; }
        } catch (error) {
          set("admin-result-status", error instanceof TypeError || error instanceof SyntaxError ? "Connection failed; the operation may have completed. Check activity before retrying. Reload if your login expired." : error.message);
        } finally { adminSubmit.disabled = false; refresh.disabled = false; operation.disabled = false; }
      });

      async function loadDashboard() {
        refresh.disabled = true;
        clearResult();
        adminPanel.hidden = true;
        status.className = "";
        status.textContent = "Loading metadata…";
        dashboard.hidden = true;
        try {
          const response = await fetch("/admin/v1/dashboard", {
            credentials: "same-origin",
            redirect: "error",
            cache: "no-store",
          });
          if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "Your login expired or is not authorized. Reload this page to sign in." : "Dashboard data is unavailable.");
          render(await response.json());
          const sessionResponse = await fetch("/dashboard/api/session", { credentials: "same-origin", redirect: "error", cache: "no-store" });
          if (!sessionResponse.ok) throw new Error("Unable to verify your role. Reload to sign in.");
          const session = await sessionResponse.json();
          set("role-label", session.role === "admin" ? "Control plane · admin" : "Control plane · read only");
          if (session.role === "admin") {
            set("admin-identity", "Signed in as " + session.email);
            document.getElementById("admin-limit").hidden = !session.admins_truncated;
            renderTable("admin-members", [{ label: "Email", value: "email" }, { label: "Role", value: (row) => row.enabled ? "Admin" : "Viewer (revoked)" }], session.admins);
            renderTable("admin-audit", [{ label: "Time", value: "created_at", format: time }, { label: "Actor", value: (row) => row.actor_email || "API credential" }, { label: "Action", value: "action" }, { label: "Resource", value: (row) => row.resource_type + " / " + (row.target_email || row.resource_id) }], session.recent_actions);
            adminPanel.hidden = false;
          }
          dashboard.hidden = false;
          status.textContent = "Loaded bounded metadata.";
        } catch (error) {
          status.className = "error";
          status.textContent = error instanceof TypeError ? "Your session may have expired. Reload this page to sign in." : error instanceof Error ? error.message : "Dashboard data is unavailable.";
        } finally {
          refresh.disabled = false;
        }
      }
      refresh.addEventListener("click", loadDashboard);
      loadDashboard();
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

export async function dashboardOverview(
  env: DashboardEnv,
  access?: CloudflareAccessContext,
): Promise<Response> {
  await requireAccessEmail(env, access);
  const generatedAt = Math.floor(Date.now() / 1000);
  const since = generatedAt - 86_400;
  const productLimit = 100;
  const environmentLimit = 250;
  const [products, environments, totals, attempts, stale, actions] =
    await Promise.all([
      env.DB.prepare(
        `SELECT id, slug, display_name, enabled, kill_switch
           FROM products
          ORDER BY slug
          LIMIT ?`,
      )
        .bind(productLimit + 1)
        .all<ProductRow>(),
      env.DB.prepare(DASHBOARD_ENVIRONMENTS_SQL)
        .bind(
          environmentLimit + 1,
          since,
          DASHBOARD_ATTEMPT_LIMIT,
          DASHBOARD_INVENTORY_COUNT_LIMIT + 1,
          generatedAt,
          DASHBOARD_INVENTORY_COUNT_LIMIT + 1,
          DASHBOARD_INVENTORY_COUNT_LIMIT,
          generatedAt,
          DASHBOARD_INVENTORY_COUNT_LIMIT + 1,
          generatedAt,
          DASHBOARD_INVENTORY_COUNT_LIMIT + 1,
          generatedAt,
          generatedAt,
          generatedAt,
        )
        .all<EnvironmentRow>(),
      env.DB.prepare(DASHBOARD_TOTALS_SQL)
        .bind(
          since,
          DASHBOARD_ATTEMPT_LIMIT + 1,
          DASHBOARD_ATTEMPT_LIMIT,
          generatedAt,
          DASHBOARD_ATTEMPT_LIMIT + 1,
          DASHBOARD_ATTEMPT_LIMIT,
        )
        .first<TotalsRow>(),
      env.DB.prepare(
        `SELECT request_id, product_id, environment_id, alias, policy_version, route_id,
                provider, resolved_model, endpoint, status_code, error_class, latency_ms,
                input_tokens, output_tokens, cost_microcents, created_at, stale_after
           FROM provider_attempts
          ORDER BY created_at DESC
          LIMIT 50`,
      ).all<AttemptRow>(),
      env.DB.prepare(
        `SELECT request_id, product_id, environment_id, alias, policy_version, route_id,
                provider, resolved_model, endpoint, input_tokens, output_tokens,
                cost_microcents, created_at, stale_after
           FROM stale_provider_attempts
          ORDER BY stale_after
          LIMIT ?`,
      )
        .bind(DASHBOARD_STALE_DETAIL_LIMIT + 1)
        .all<StaleAttemptRow>(),
      env.DB.prepare(
        `SELECT action, resource_type,
                CASE WHEN resource_type = 'access_code' THEN '[redacted]' ELSE resource_id END AS resource_id,
                created_at
           FROM admin_audit
          ORDER BY created_at DESC
          LIMIT 25`,
      ).all<AuditRow>(),
    ]);

  const productsTruncated = products.results.length > productLimit;
  const visibleEnvironments = environments.results.slice(0, environmentLimit);
  const environmentsTruncated = environments.results.length > environmentLimit;
  const environmentCountsTruncated = visibleEnvironments.some(
    (environment) =>
      environment.aliases > DASHBOARD_INVENTORY_COUNT_LIMIT ||
      environment.active_entitlements > DASHBOARD_INVENTORY_COUNT_LIMIT ||
      environment.effective_grants_truncated === 1,
  );
  const finalizedAttemptsTruncated = totals?.finalized_attempts_truncated === 1;
  const staleAttemptCount = totals?.stale_attempts ?? 0;
  const staleAttemptsTruncated = staleAttemptCount > DASHBOARD_ATTEMPT_LIMIT;
  const staleAttemptDetailsTruncated =
    stale.results.length > DASHBOARD_STALE_DETAIL_LIMIT;
  const normalizedProducts = products.results
    .slice(0, productLimit)
    .map((product) => ({
      ...product,
      enabled: product.enabled === 1,
      kill_switch: product.kill_switch === 1,
    }));
  const normalizedEnvironments = visibleEnvironments.map((environment) => ({
    ...environment,
    product_enabled: environment.product_enabled === 1,
    product_kill_switch: environment.product_kill_switch === 1,
    enabled: environment.enabled === 1,
    kill_switch: environment.kill_switch === 1,
    aliases: Math.min(environment.aliases, DASHBOARD_INVENTORY_COUNT_LIMIT),
    aliases_truncated: environment.aliases > DASHBOARD_INVENTORY_COUNT_LIMIT,
    active_entitlements: Math.min(
      environment.active_entitlements,
      DASHBOARD_INVENTORY_COUNT_LIMIT,
    ),
    active_entitlements_truncated:
      environment.active_entitlements > DASHBOARD_INVENTORY_COUNT_LIMIT,
    effective_grants: Math.min(
      environment.effective_grants,
      DASHBOARD_INVENTORY_COUNT_LIMIT,
    ),
    effective_grants_truncated: environment.effective_grants_truncated === 1,
  }));
  const normalizedAttempts = attempts.results.map((attempt) => ({
    ...attempt,
    display_status:
      attempt.error_class === "attempt_started"
        ? attempt.stale_after <= generatedAt
          ? "stale intent"
          : "in flight"
        : attempt.error_class
          ? `${attempt.error_class} / ${attempt.status_code}`
          : String(attempt.status_code),
  }));

  return jsonResponse({
    generated_at: generatedAt,
    totals: {
      products: normalizedProducts.length,
      environments: normalizedEnvironments.length,
      finalized_attempts_24h: totals?.finalized_attempts_24h ?? 0,
      failed_finalized_attempts_24h: totals?.failed_finalized_attempts_24h ?? 0,
      accounted_input_tokens_24h: totals?.accounted_input_tokens_24h ?? "0",
      accounted_output_tokens_24h: totals?.accounted_output_tokens_24h ?? "0",
      accounted_cost_microcents_24h:
        totals?.accounted_cost_microcents_24h ?? "0",
      stale_attempts: Math.min(staleAttemptCount, DASHBOARD_ATTEMPT_LIMIT),
    },
    products: normalizedProducts,
    environments: normalizedEnvironments,
    inventory_truncated: {
      products: productsTruncated,
      environments: environmentsTruncated,
      environment_counts: environmentCountsTruncated,
    },
    accounting_truncated: {
      finalized_attempts: finalizedAttemptsTruncated,
      stale_attempts: staleAttemptsTruncated,
      stale_attempt_details: staleAttemptDetailsTruncated,
    },
    recent_attempts: normalizedAttempts,
    stale_attempts: stale.results.slice(0, DASHBOARD_STALE_DETAIL_LIMIT),
    recent_admin_actions: actions.results,
    accounting_basis: {
      coverage:
        "Persisted provider-attempt records begin only after quota admission.",
      finalized:
        "Aggregates use at most the latest 10,000 finalized records from the last 24 hours and exclude attempt_started intents; terminal failures may retain conservative token and cost estimates.",
      stale:
        "Stale attempt_started rows are reported separately with reservation ceilings.",
    },
    live_quota: {
      available: false,
      reason:
        "Current per-principal reservations remain Durable Object-local and cannot be enumerated. Persisted attempt accounting is shown above.",
    },
  });
}
