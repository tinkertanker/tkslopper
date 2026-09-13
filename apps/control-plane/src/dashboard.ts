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
    <link rel="icon" href="/favicon.svg" type="image/svg+xml">
    <style nonce="__CSP_NONCE__">
      :root {
        color-scheme: light;
        --ink: #161a12;
        --soft: #5d6458;
        --faint: #8b9286;
        --paper: #ecefe5;
        --panel: #fff;
        --rule: #d3d8ca;
        --hair: #e5e9de;
        --hover: #f5f8f0;
        --band: #2e6006;
        --band-edge: #244c04;
        --green: #60ae0a;
        --on-band: #cdeda6;
        --green-deep: #2b5a06;
        --green-wash: #eaf7db;
        --band-alarm: #8c1f18;
        --alarm: #ab241b;
        --alarm-wash: #fbe7e4;
      }

      * { box-sizing: border-box; }
      [hidden] { display: none !important; }

      body {
        margin: 0;
        min-width: 320px;
        background: var(--paper);
        color: var(--ink);
        font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      }

      .mono { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }

      .app { display: grid; grid-template-columns: 216px minmax(0, 1fr); min-height: 100vh; }

      /* Sidebar carries the brand and the only navigation; it stays green in every state. */
      .sidebar {
        display: flex;
        flex-direction: column;
        gap: 18px;
        padding: 20px 16px 22px;
        background: var(--band);
        color: #fff;
      }
      .brand { display: flex; gap: 10px; align-items: flex-start; }
      .mark { flex: none; display: flex; color: var(--on-band); }
      .mark svg { display: block; fill: currentColor; }
      .brand-name { margin: 0; font: 600 14px/1.3 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; letter-spacing: -.01em; }
      .tag {
        align-self: flex-start;
        margin: -8px 0 0;
        padding: 3px 9px 4px;
        border: 1px solid rgb(255 255 255 / 34%);
        border-radius: 999px;
        color: rgb(255 255 255 / 82%);
        font-size: 11px;
        line-height: 1;
      }
      .nav { display: grid; gap: 2px; margin: 0; padding: 0; list-style: none; }
      .nav-item {
        width: 100%;
        min-height: 34px;
        padding: 0 10px;
        border: 0;
        border-radius: 6px;
        background: transparent;
        color: rgb(255 255 255 / 78%);
        font: inherit;
        font-size: 13px;
        font-weight: 500;
        text-align: left;
        cursor: pointer;
      }
      .nav-item:hover { background: rgb(255 255 255 / 10%); color: #fff; }
      .nav-item[aria-current="page"] { background: rgb(255 255 255 / 17%); color: #fff; font-weight: 650; }
      .nav-item:focus-visible { outline: 2px solid var(--on-band); outline-offset: -2px; }
      .side-foot { display: grid; gap: 6px; margin-top: auto; font-size: 12px; }
      .side-foot p { margin: 0; overflow-wrap: anywhere; color: rgb(255 255 255 / 70%); }
      .side-foot p:empty { display: none; }
      .side-foot a { color: var(--on-band); }
      .sidebar a:focus-visible { outline-color: var(--on-band); }

      .content { display: flex; flex-direction: column; min-width: 0; }

      /* Quiet when nominal, loud when not: the bar only takes the alarm colour if something is wrong. */
      .topbar {
        display: flex;
        flex-wrap: wrap;
        gap: 10px 16px;
        align-items: center;
        padding: 13px 24px;
        border-bottom: 1px solid var(--rule);
        background: var(--panel);
      }
      body.alarm .topbar { border-bottom-color: #6d1712; background: var(--band-alarm); color: #fff; }
      .verdict { display: flex; gap: 9px; align-items: center; margin: 0; font-size: 19px; font-weight: 600; letter-spacing: -.01em; }
      .glyph { display: flex; }
      .glyph svg { fill: none; stroke: var(--green-deep); stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
      .glyph-bad, body.alarm .glyph-ok { display: none; }
      body.alarm .glyph-bad { display: block; stroke: #ffb9b3; stroke-width: 2.8; }
      .stamp { margin: 0; color: var(--soft); font-size: 12px; }
      .stamp span { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
      body.alarm .stamp { color: rgb(255 255 255 / 74%); }

      .sweep { height: 2px; overflow: hidden; background: transparent; }
      .sweep::after { display: none; width: 34%; height: 2px; background: var(--green); content: ""; }
      body.loading .sweep::after { display: block; animation: sweep 1.1s linear infinite; }
      @keyframes sweep { from { transform: translateX(-100%); } to { transform: translateX(400%); } }
      @media (prefers-reduced-motion: reduce) {
        body.loading .sweep::after { width: 100%; animation: none; }
      }

      button {
        min-height: 38px;
        padding: 0 16px;
        border: 1px solid var(--band);
        border-radius: 6px;
        background: var(--band);
        color: #fff;
        font: inherit;
        font-weight: 600;
        cursor: pointer;
      }
      button:hover { background: var(--band-edge); }
      button[disabled] { opacity: .55; cursor: progress; }
      #refresh { margin-left: auto; }
      body.alarm #refresh { border-color: #fff; background: #fff; color: var(--band-alarm); }
      a { color: var(--green-deep); text-underline-offset: 3px; }
      button:focus-visible, a:focus-visible, .table-wrap:focus-visible { outline: 2px solid var(--band); outline-offset: 2px; }
      body.alarm .topbar a:focus-visible, body.alarm #refresh:focus-visible { outline-color: #fff; }
      #status { color: var(--soft); font-size: 13px; }
      #status.error { color: var(--alarm); font-weight: 600; }
      body.alarm .topbar #status, body.alarm .topbar #status.error { color: rgb(255 255 255 / 82%); }

      main { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; padding: 20px 24px 40px; }
      .view { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
      .lede { max-width: 78ch; margin: 0; color: var(--soft); font-size: 13px; }

      /* Instrument cluster: one strip, hairline-divided, so the six readings compare directly. */
      .cards {
        display: grid;
        grid-template-columns: repeat(6, minmax(0, 1fr));
        gap: 1px;
        overflow: hidden;
        border: 1px solid var(--rule);
        border-radius: 6px;
        background: var(--hair);
      }
      .card { min-width: 0; padding: 14px 16px 16px; background: var(--panel); }
      .card span { display: block; color: var(--soft); font-size: 12px; }
      .card strong {
        display: block;
        min-width: 0;
        margin-top: 6px;
        overflow-wrap: anywhere;
        font: 600 clamp(20px, 1.7vw, 27px)/1.1 ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
        font-variant-numeric: tabular-nums;
        letter-spacing: -.02em;
      }
      .card.alert { box-shadow: inset 0 3px 0 var(--alarm); background: var(--alarm-wash); }
      .card.alert strong { color: var(--alarm); }

      section {
        min-width: 0;
        padding: 16px 18px 6px;
        border: 1px solid var(--rule);
        border-radius: 6px;
        background: var(--panel);
      }
      .section-head { display: flex; flex-wrap: wrap; gap: 4px 16px; align-items: baseline; justify-content: space-between; padding-bottom: 11px; border-bottom: 1px solid var(--rule); margin-bottom: 2px; }
      h2 { margin: 0; font-size: 15px; font-weight: 650; }
      .section-note { margin: 0; color: var(--soft); font-size: 12px; }
      .notice { margin: 0; padding: 13px 16px; border: 1px solid var(--rule); border-left: 3px solid var(--faint); border-radius: 6px; background: var(--panel); color: var(--soft); font-size: 13px; }

      .table-wrap { min-width: 0; max-width: 100%; overflow-x: auto; overscroll-behavior-x: contain; }
      .table-wrap::before { display: none; }
      table { width: 100%; border-collapse: collapse; white-space: nowrap; }
      th, td { padding: 9px 12px; border-bottom: 1px solid var(--hair); text-align: left; }
      th { color: var(--soft); font-size: 11px; font-weight: 650; }
      td { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 12.5px; }
      td.num { text-align: right; font-variant-numeric: tabular-nums; }
      th.num { text-align: right; }
      tbody tr:last-child td { border-bottom: 0; }
      tbody tr:hover { background: var(--hover); }
      tbody tr.flagged td:first-child { box-shadow: inset 3px 0 0 var(--alarm); }

      .pill { display: inline-block; padding: 2px 9px 3px; border-radius: 999px; background: var(--hair); color: var(--soft); font-size: 11px; font-weight: 600; letter-spacing: .01em; }
      .pill.ok { background: var(--green-wash); color: var(--green-deep); }
      .pill.off { background: var(--hair); color: var(--soft); }
      .pill.bad { background: var(--alarm-wash); color: var(--alarm); }

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
      .empty { color: var(--soft); font-style: italic; }
      .split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 18px; }
      .limitation { border-left: 3px solid var(--faint); }
      .limitation .section-head { border-bottom: 0; padding-bottom: 6px; }
      .limitation #quota-note { padding-bottom: 14px; }

      footer { padding: 0 24px 28px; color: var(--soft); font-size: 12px; }
      code { font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }

      /* Below this the sidebar costs more width than it returns, so it lies down as a strip. */
      @media (max-width: 900px) {
        .app { grid-template-columns: minmax(0, 1fr); min-height: 0; }
        .sidebar { flex-direction: row; flex-wrap: wrap; gap: 10px 14px; align-items: center; padding: 12px 16px; }
        .brand-name { font-size: 13px; }
        .tag { margin: 0; }
        .nav { grid-auto-flow: column; grid-auto-columns: max-content; gap: 4px; max-width: 100%; overflow-x: auto; overscroll-behavior-x: contain; }
        .nav-item { min-height: 32px; white-space: nowrap; }
        .side-foot { grid-auto-flow: column; align-items: center; gap: 14px; margin: 0 0 0 auto; }
        .topbar { padding-right: 16px; padding-left: 16px; }
        main { padding: 16px 16px 32px; }
        footer { padding: 0 16px 24px; }
      }
      @media (max-width: 1100px) {
        .cards { grid-template-columns: repeat(3, minmax(0, 1fr)); }
        .split { grid-template-columns: minmax(0, 1fr); }
      }
      @media (max-width: 680px) {
        .verdict { font-size: 17px; }
        #refresh { margin-left: 0; }
        .side-foot { margin-left: 0; }
        .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        section { padding: 14px 14px 4px; }
        .table-wrap::before {
          position: sticky;
          left: 0;
          display: block;
          padding: 0 0 8px;
          color: var(--soft);
          content: "Swipe horizontally for all columns";
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
      /* Administration: the only part of this page that can change live state, so it is
         the only panel that carries the band's colour. */
      #admin-panel { border-color: #c2d3ab; box-shadow: inset 0 3px 0 var(--band); }
      .admin-body { min-width: 0; padding-bottom: 16px; }
      .admin-body > p { max-width: 78ch; margin: 12px 0; color: var(--soft); font-size: 13px; }
      #admin-panel .section-head { flex-wrap: wrap; }
      #admin-identity { min-width: 0; overflow-wrap: anywhere; }

      #admin-form { margin: 18px 0 0; }
      #admin-form > label { display: block; margin-bottom: 7px; color: var(--soft); font-size: 12px; font-weight: 650; }
      input, select {
        width: 100%;
        min-height: 40px;
        padding: 0 12px;
        border: 1px solid var(--soft);
        border-radius: 6px;
        background: var(--panel);
        color: var(--ink);
        font: inherit;
      }
      select { max-width: 460px; }
      input:focus-visible, select:focus-visible { outline: 2px solid var(--band); outline-offset: 2px; }
      .admin-fields { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 14px; margin: 18px 0; }
      .admin-fields label { display: grid; gap: 6px; min-width: 0; color: var(--soft); font-size: 12px; font-weight: 650; }

      .admin-body h3 { margin: 28px 0 0; font-size: 13px; font-weight: 650; }
      #admin-result-status { margin: 12px 0 0; color: var(--soft); font-size: 13px; }
      #admin-result-status.error { color: var(--alarm); font-weight: 600; }
      #admin-result { margin-top: 16px; }
      /* Issued credentials are shown once and never again: warn in the alarm colour. */
      #admin-result > p { max-width: 78ch; margin: 0 0 10px; color: var(--alarm); font-size: 13px; font-weight: 600; }
      .admin-body pre {
        margin: 0 0 12px;
        padding: 14px;
        overflow-x: auto;
        border: 1px solid var(--rule);
        border-radius: 6px;
        background: #f7f9f3;
        font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
        font-size: 12.5px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      #admin-clear { border-color: var(--rule); background: transparent; color: var(--green-deep); }
      #admin-clear:hover { background: var(--green-wash); }
    </style>
  </head>
  <body>
    <div class="app">
      <nav class="sidebar" aria-label="Dashboard sections">
        <div class="brand">
          <span class="mark" aria-hidden="true"><svg width="30" height="26" viewBox="201 257 843 727" focusable="false"><g transform="translate(0 1254) scale(.1 -.1)" fill="currentColor"><path d="M5528 9949 c-425 -41 -800 -297 -993 -679 -87 -174 -120 -332 -112 -540 6 -148 19 -209 92 -425 65 -193 78 -278 72 -470 -4 -118 -11 -180 -27 -238 -88 -326 -280 -603 -605 -877 -131 -109 -401 -298 -519 -363 -252 -137 -402 -243 -536 -378 -184 -185 -291 -368 -358 -618 -23 -87 -26 -114 -26 -286 0 -176 2 -198 27 -290 53 -197 164 -381 294 -489 112 -93 272 -176 370 -192 l41 -6 -29 111 c-39 152 -53 273 -46 416 8 152 27 255 78 403 136 393 416 708 794 892 314 153 581 186 920 115 26 -5 51 8 202 112 390 267 1419 963 2017 1364 l640 429 324 -486 c178 -268 320 -490 315 -494 -4 -4 -287 -196 -628 -426 -341 -230 -811 -549 -1045 -709 -234 -159 -541 -368 -681 -464 l-256 -173 33 -97 c58 -169 69 -245 69 -456 0 -246 -27 -368 -123 -560 -124 -250 -299 -446 -536 -603 -151 -99 -305 -162 -509 -207 -33 -7 -33 -18 8 -118 37 -94 86 -168 155 -238 75 -76 131 -111 233 -146 102 -36 279 -38 382 -6 179 57 319 184 460 419 146 243 283 362 475 410 90 23 222 14 313 -20 138 -52 228 -134 380 -345 126 -176 223 -277 340 -355 162 -108 310 -156 480 -156 166 0 303 43 432 134 173 124 254 281 243 475 -7 112 -29 165 -153 366 -124 202 -175 308 -220 464 -47 163 -62 318 -46 480 42 441 259 831 796 1426 88 98 192 217 230 265 236 295 292 589 163 855 -73 150 -186 247 -375 321 -157 62 -220 112 -297 238 -69 113 -208 352 -272 466 -76 139 -161 226 -271 277 -71 34 -87 37 -184 41 -156 6 -214 -14 -429 -144 -164 -99 -263 -125 -395 -104 -98 16 -166 50 -240 121 -106 101 -163 238 -185 442 -28 254 -90 433 -218 626 -188 284 -482 461 -816 491 -123 11 -124 11 -248 -1z M9527 9339 c-251 -34 -489 -202 -605 -427 -72 -138 -87 -205 -87 -382 0 -172 10 -219 71 -345 134 -275 410 -445 721 -445 236 0 432 84 590 254 259 277 290 697 74 1014 -105 155 -278 274 -462 318 -77 18 -220 25 -302 13z M2775 8400 c-417 -65 -723 -402 -752 -826 -21 -325 156 -654 438 -813 258 -145 566 -147 838 -6 177 92 329 258 401 439 50 123 63 198 63 341 0 144 -16 223 -74 360 -53 129 -178 278 -305 366 -68 47 -181 97 -269 119 -93 24 -254 33 -340 20z M4335 5536 c-169 -44 -294 -115 -422 -239 -304 -293 -374 -770 -167 -1133 126 -220 294 -357 544 -440 80 -27 95 -28 260 -28 165 0 180 1 260 28 167 56 297 135 406 248 171 178 258 372 271 609 21 382 -192 738 -540 899 -126 58 -191 72 -367 76 -139 4 -164 2 -245 -20z M9455 4874 c-256 -57 -477 -246 -574 -491 -53 -136 -67 -347 -31 -489 71 -282 280 -496 562 -574 420 -117 865 136 995 565 14 46 18 93 18 205 0 138 -2 150 -33 240 -94 270 -272 446 -537 530 -93 30 -298 37 -400 14z"/></g></svg></span>
          <h1 class="brand-name">tkslopper operations</h1>
        </div>
        <p class="tag" id="role-label">Read-only</p>
        <ul class="nav">
          <li><button type="button" class="nav-item" data-view="overview" aria-current="page">Overview</button></li>
          <li><button type="button" class="nav-item" data-view="attempts">Attempts</button></li>
          <li><button type="button" class="nav-item" data-view="stale">Stale intents</button></li>
          <li id="nav-activity"><button type="button" class="nav-item" data-view="activity">Activity</button></li>
          <li id="nav-admin" hidden><button type="button" class="nav-item" data-view="admin">Administration</button></li>
        </ul>
        <div class="side-foot">
          <p id="admin-identity"></p>
          <a href="/cdn-cgi/access/logout">Sign out</a>
        </div>
      </nav>

      <div class="content">
        <div class="topbar">
          <p class="verdict"><span class="glyph" aria-hidden="true"><svg class="glyph-ok" width="17" height="17" viewBox="0 0 20 20" focusable="false"><path d="M4 10.4l4 4 8-9"/></svg><svg class="glyph-bad" width="17" height="17" viewBox="0 0 20 20" focusable="false"><path d="M10 3.5v8.2M10 15.2v1.3"/></svg></span><span id="verdict">Checking state</span></p>
          <p class="stamp">Updated <span id="generated-at">never</span></p>
          <button type="button" id="refresh">Refresh</button>
          <span id="status" role="status" aria-live="polite">Loading metadata…</span>
        </div>
        <div class="sweep" aria-hidden="true"></div>

        <main id="dashboard" hidden>
          <p id="inventory-warning" class="notice" role="status" hidden></p>

          <div class="cards" role="list" aria-label="24 hour summary">
            <div class="card" role="listitem"><span>Products</span><strong id="total-products">—</strong></div>
            <div class="card" role="listitem"><span>Environments</span><strong id="total-environments">—</strong></div>
            <div class="card" role="listitem"><span>Finalized in 24h</span><strong id="total-attempts">—</strong></div>
            <div class="card" id="card-failures" role="listitem"><span>Failures in 24h</span><strong id="total-failures">—</strong></div>
            <div class="card" role="listitem"><span>Accounted cost, 24h (μ¢)</span><strong id="total-cost">—</strong></div>
            <div class="card" id="card-stale" role="listitem"><span>Stale intents</span><strong id="total-stale">—</strong></div>
          </div>

          <div class="view" data-view="overview">
            <p class="lede">Operational metadata without prompts or responses. Named admins can manage access and configuration; issued credentials appear only in the operation result.</p>

            <section>
              <div class="section-head"><h2 id="products-heading">Products</h2><p class="section-note">Bounded inventory and parent policy state</p></div>
              <div class="table-wrap" role="region" tabindex="0" aria-labelledby="products-heading"><table id="products"></table></div>
            </section>

            <section>
              <div class="section-head"><h2 id="environments-heading">Environments</h2><p class="section-note">Bounded inventory; policy state and latest finalized 24-hour accounting records</p></div>
              <div class="table-wrap" role="region" tabindex="0" aria-labelledby="environments-heading"><table id="environments"></table></div>
            </section>

            <section class="limitation">
              <div class="section-head"><h2>Live quota state</h2><p class="section-note">Not enumerated</p></div>
              <p id="quota-note" class="section-note"></p>
            </section>
          </div>

          <div class="view" data-view="attempts" hidden>
            <section>
              <div class="section-head"><h2 id="attempts-heading">Recent attempt records</h2><p class="section-note">Latest 50 intents or finalized records after quota admission</p></div>
              <div class="table-wrap" role="region" tabindex="0" aria-labelledby="attempts-heading"><table id="attempts"></table></div>
            </section>
          </div>

          <div class="view" data-view="stale" hidden>
            <section>
              <div class="section-head"><h2 id="stale-heading">Stale intents</h2><p class="section-note">Oldest 50 past route deadline plus grace; usage values are reservation ceilings</p></div>
              <div class="table-wrap" role="region" tabindex="0" aria-labelledby="stale-heading"><table id="stale"></table></div>
            </section>
          </div>

          <div class="view" data-view="activity" hidden>
            <section>
              <div class="section-head"><h2 id="audit-heading">Admin activity</h2><p class="section-note">Latest 25 audited mutations</p></div>
              <div class="table-wrap" role="region" tabindex="0" aria-labelledby="audit-heading"><table id="audit"></table></div>
            </section>
          </div>

          <div class="view" data-view="admin" hidden>
        <section id="admin-panel" hidden>
          <div class="section-head"><h2 id="admin-heading">Administration</h2><p class="section-note">Changes here take effect immediately</p></div>
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
          </div>
        </main>

        <footer>Operational metadata, not billing records.</footer>
      </div>
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

      const PILL_KIND = { Enabled: "ok", Disabled: "off", KILLED: "bad", Admin: "ok" };
      const statusKind = (text) => /^2\d\d/.test(text) ? "ok" : text === "in flight" ? "off" : "bad";
      const pillKind = (column, text) => column.pill === "status" ? statusKind(text) : PILL_KIND[text] || "off";
      const isNumeric = (column) => column.num === true || column.format === number || column.format === cost;

      function renderTable(id, columns, rows) {
        const table = document.getElementById(id);
        const head = document.createElement("thead");
        const headRow = document.createElement("tr");
        for (const column of columns) {
          const cell = document.createElement("th");
          cell.scope = "col";
          if (isNumeric(column)) cell.className = "num";
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
              const text = String(column.format ? column.format(raw) : raw ?? "—");
              cell.title = String(raw ?? "");
              if (column.pill) {
                const pill = document.createElement("span");
                const kind = pillKind(column, text);
                pill.className = "pill " + kind;
                pill.textContent = text;
                cell.append(pill);
                if (column.pill === "status" && kind === "bad") row.classList.add("flagged");
              } else {
                if (isNumeric(column)) cell.className = "num";
                cell.textContent = text;
              }
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
        set("total-cost", number(data.totals.accounted_cost_microcents_24h));
        set("total-stale", number(data.totals.stale_attempts));
        set("generated-at", time(data.generated_at));

        const stale = Number(data.totals.stale_attempts || 0);
        const failures = Number(data.totals.failed_finalized_attempts_24h || 0);
        const killed = data.environments.filter((row) => row.kill_switch || row.product_kill_switch).length;
        const plural = (count, noun) => number(count) + " " + noun + (count === 1 ? "" : "s");
        const faults = [];
        if (killed) faults.push(plural(killed, "killed environment"));
        if (stale) faults.push(plural(stale, "stale intent"));
        if (failures) faults.push(plural(failures, "failure") + " in 24h");
        const faultCoverageIncomplete = data.inventory_truncated.environments || data.accounting_truncated.finalized_attempts;
        set("verdict", faults.length ? faults.join(", ") : faultCoverageIncomplete ? "No faults in shown metadata" : "All nominal");
        document.body.classList.toggle("alarm", faults.length > 0);
        document.getElementById("card-failures").classList.toggle("alert", failures > 0);
        document.getElementById("card-stale").classList.toggle("alert", stale > 0);
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
          { label: "State", value: (row) => policyState(row.enabled, row.kill_switch), pill: true },
        ], data.products);
        renderTable("environments", [
          { label: "Product", value: (row) => productNames[row.product_id] || row.product_id },
          { label: "Environment", value: "name" },
          { label: "Product state", value: (row) => policyState(row.product_enabled, row.product_kill_switch), pill: true },
          { label: "Environment state", value: (row) => policyState(row.enabled, row.kill_switch), pill: true },
          { label: "Policy", value: "policy_version", format: number },
          { label: "RPM", value: "rpm_limit", format: number },
          { label: "TPM", value: "tpm_limit", format: number },
          { label: "Concurrency", value: "concurrency_limit", format: number },
          { label: "Daily budget", value: "daily_budget_microcents", format: cost },
          { label: "Max request", value: (row) => number(row.max_request_bytes) + " bytes", num: true },
          { label: "Finalized", value: "finalized_attempts_24h", format: number },
          { label: "Finalized failures", value: "failed_finalized_attempts_24h", format: number },
          { label: "Accounted input", value: "accounted_input_tokens_24h", format: number },
          { label: "Accounted output", value: "accounted_output_tokens_24h", format: number },
          { label: "Accounted cost", value: "accounted_cost_microcents_24h", format: cost },
          { label: "Aliases", value: (row) => boundedCount(row.aliases, row.aliases_truncated), num: true },
          { label: "Active entitlements", value: (row) => boundedCount(row.active_entitlements, row.active_entitlements_truncated), num: true },
          { label: "Effective grants", value: (row) => boundedCount(row.effective_grants, row.effective_grants_truncated), num: true },
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
          { label: "Status", value: "display_status", pill: "status" },
          { label: "Latency", value: (row) => number(row.latency_ms) + " ms", num: true },
          { label: "Accounted tokens / ceiling", value: (row) => number(row.input_tokens) + " / " + number(row.output_tokens), num: true },
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
      const navItems = [...document.querySelectorAll(".nav-item")];
      const views = [...document.querySelectorAll(".view")];

      function showView(name) {
        const target = navItems.some((item) => item.dataset.view === name && !item.closest("li").hidden) ? name : "overview";
        for (const view of views) view.hidden = view.dataset.view !== target;
        for (const item of navItems) {
          if (item.dataset.view === target) item.setAttribute("aria-current", "page");
          else item.removeAttribute("aria-current");
        }
      }
      for (const item of navItems) item.addEventListener("click", () => showView(item.dataset.view));

      // Admins get the richer "Who changed what" table inside Administration, so the
      // actor-blind copy is theirs to lose, not the viewers'.
      function applyRole(isAdmin) {
        document.getElementById("nav-admin").hidden = !isAdmin;
        document.getElementById("nav-activity").hidden = isAdmin;
        const current = navItems.find((item) => item.hasAttribute("aria-current"));
        showView(current ? current.dataset.view : "overview");
      }
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
          if (!response.ok) { if (response.status === 401 || response.status === 403) { adminPanel.hidden = true; applyRole(false); status.textContent = "Admin access expired or was revoked. Reload to check your login."; } throw new Error(response.status >= 500 ? "Server error; check activity before retrying because the operation may have completed." : result.error?.message || "Operation rejected."); }
          if (selected === "admins") await loadDashboard();
          set("admin-result-status", "Operation completed. Copy any credentials before refreshing the dashboard.");
          if (!adminPanel.hidden) { set("admin-result-data", JSON.stringify(result, null, 2)); document.getElementById("admin-result").hidden = false; }
        } catch (error) {
          set("admin-result-status", error instanceof TypeError || error instanceof SyntaxError ? "Connection failed; the operation may have completed. Check activity before retrying. Reload if your login expired." : error.message);
        } finally { adminSubmit.disabled = false; refresh.disabled = false; operation.disabled = false; }
      });

      async function loadDashboard() {
        refresh.disabled = true;
        document.body.classList.add("loading");
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
          set("role-label", session.role === "admin" ? "Admin" : "Read-only");
          if (session.role === "admin") {
            set("admin-identity", "Signed in as " + session.email);
            document.getElementById("admin-limit").hidden = !session.admins_truncated;
            renderTable("admin-members", [{ label: "Email", value: "email" }, { label: "Role", value: (row) => row.enabled ? "Admin" : "Viewer (revoked)", pill: true }], session.admins);
            renderTable("admin-audit", [{ label: "Time", value: "created_at", format: time }, { label: "Actor", value: (row) => row.actor_email || "API credential" }, { label: "Action", value: "action" }, { label: "Resource", value: (row) => row.resource_type + " / " + (row.target_email || row.resource_id) }], session.recent_actions);
            adminPanel.hidden = false;
            applyRole(true);
          } else {
            applyRole(false);
          }
          dashboard.hidden = false;
          status.textContent = "Loaded bounded metadata.";
        } catch (error) {
          status.className = "error";
          set("verdict", "State unavailable");
          document.body.classList.add("alarm");
          status.textContent = error instanceof TypeError ? "Your session may have expired. Reload this page to sign in." : error instanceof Error ? error.message : "Dashboard data is unavailable.";
        } finally {
          document.body.classList.remove("loading");
          refresh.disabled = false;
        }
      }
      refresh.addEventListener("click", loadDashboard);
      loadDashboard();
    </script>
  </body>
</html>`;

const FAVICON_SVG = String.raw`<svg xmlns="http://www.w3.org/2000/svg" viewBox="201 257 843 727"><g transform="translate(0 1254) scale(.1 -.1)" fill="#60ae0a"><path d="M5528 9949 c-425 -41 -800 -297 -993 -679 -87 -174 -120 -332 -112 -540 6 -148 19 -209 92 -425 65 -193 78 -278 72 -470 -4 -118 -11 -180 -27 -238 -88 -326 -280 -603 -605 -877 -131 -109 -401 -298 -519 -363 -252 -137 -402 -243 -536 -378 -184 -185 -291 -368 -358 -618 -23 -87 -26 -114 -26 -286 0 -176 2 -198 27 -290 53 -197 164 -381 294 -489 112 -93 272 -176 370 -192 l41 -6 -29 111 c-39 152 -53 273 -46 416 8 152 27 255 78 403 136 393 416 708 794 892 314 153 581 186 920 115 26 -5 51 8 202 112 390 267 1419 963 2017 1364 l640 429 324 -486 c178 -268 320 -490 315 -494 -4 -4 -287 -196 -628 -426 -341 -230 -811 -549 -1045 -709 -234 -159 -541 -368 -681 -464 l-256 -173 33 -97 c58 -169 69 -245 69 -456 0 -246 -27 -368 -123 -560 -124 -250 -299 -446 -536 -603 -151 -99 -305 -162 -509 -207 -33 -7 -33 -18 8 -118 37 -94 86 -168 155 -238 75 -76 131 -111 233 -146 102 -36 279 -38 382 -6 179 57 319 184 460 419 146 243 283 362 475 410 90 23 222 14 313 -20 138 -52 228 -134 380 -345 126 -176 223 -277 340 -355 162 -108 310 -156 480 -156 166 0 303 43 432 134 173 124 254 281 243 475 -7 112 -29 165 -153 366 -124 202 -175 308 -220 464 -47 163 -62 318 -46 480 42 441 259 831 796 1426 88 98 192 217 230 265 236 295 292 589 163 855 -73 150 -186 247 -375 321 -157 62 -220 112 -297 238 -69 113 -208 352 -272 466 -76 139 -161 226 -271 277 -71 34 -87 37 -184 41 -156 6 -214 -14 -429 -144 -164 -99 -263 -125 -395 -104 -98 16 -166 50 -240 121 -106 101 -163 238 -185 442 -28 254 -90 433 -218 626 -188 284 -482 461 -816 491 -123 11 -124 11 -248 -1z M9527 9339 c-251 -34 -489 -202 -605 -427 -72 -138 -87 -205 -87 -382 0 -172 10 -219 71 -345 134 -275 410 -445 721 -445 236 0 432 84 590 254 259 277 290 697 74 1014 -105 155 -278 274 -462 318 -77 18 -220 25 -302 13z M2775 8400 c-417 -65 -723 -402 -752 -826 -21 -325 156 -654 438 -813 258 -145 566 -147 838 -6 177 92 329 258 401 439 50 123 63 198 63 341 0 144 -16 223 -74 360 -53 129 -178 278 -305 366 -68 47 -181 97 -269 119 -93 24 -254 33 -340 20z M4335 5536 c-169 -44 -294 -115 -422 -239 -304 -293 -374 -770 -167 -1133 126 -220 294 -357 544 -440 80 -27 95 -28 260 -28 165 0 180 1 260 28 167 56 297 135 406 248 171 178 258 372 271 609 21 382 -192 738 -540 899 -126 58 -191 72 -367 76 -139 4 -164 2 -245 -20z M9455 4874 c-256 -57 -477 -246 -574 -491 -53 -136 -67 -347 -31 -489 71 -282 280 -496 562 -574 420 -117 865 136 995 565 14 46 18 93 18 205 0 138 -2 150 -33 240 -94 270 -272 446 -537 530 -93 30 -298 37 -400 14z"/></g></svg>`;

export function dashboardFavicon(): Response {
  return new Response(FAVICON_SVG, {
    headers: {
      "cache-control": "public, max-age=86400",
      "content-type": "image/svg+xml; charset=utf-8",
      "x-content-type-options": "nosniff",
    },
  });
}

export function dashboardPage(): Response {
  const nonce = randomSecret(16);
  return new Response(DASHBOARD_HTML.replaceAll("__CSP_NONCE__", nonce), {
    headers: {
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
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
