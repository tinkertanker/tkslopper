import {
  MODEL_PROVIDERS,
  MODEL_TIERS,
  jsonResponse,
  randomSecret,
} from "@tkslopper/shared";
import { requireAccessEmail } from "./admin-access";
import { csvCell, formatDollars, parseDollars } from "./dashboard-money";

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
  token_ttl_seconds: number;
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
         e.enabled, e.kill_switch, e.policy_version, e.token_ttl_seconds, e.rpm_limit, e.tpm_limit,
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
      #class-groups th:first-child, #class-groups td:first-child { position: sticky; left: 0; z-index: 1; background: var(--panel); box-shadow: 1px 0 var(--rule); }
      /* A group name is API-bounded at 200 characters; the sticky first column must not
         grow past the actions column, so it is clipped with the full name in the title. */
      .bounded-cell { display: block; width: 180px; max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

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
        /* On narrow screens the sticky name column must leave room for the action buttons:
           shrink the bounded cell, stop pinning the first column, and let the action buttons
           wrap between themselves. The id scopes the wrap above the base td.actions rule. */
        #class-groups th:first-child, #class-groups td:first-child { position: static; }
        .bounded-cell { width: 96px; max-width: 96px; }
        #class-groups td.actions { white-space: normal; }
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
      .admin-fields label { display: grid; grid-template-rows: 1fr auto; gap: 6px; align-items: end; min-width: 0; color: var(--soft); font-size: 12px; font-weight: 650; }

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

      /* Classes: the course-centred workflow. It reuses the panel, table, pill, and form
         primitives above; only the pieces unique to class distribution are new. */
      .classes-body { min-width: 0; padding-bottom: 16px; }
      .classes-body > p { max-width: 78ch; margin: 12px 0; color: var(--soft); font-size: 13px; }
      .classes-body h3 { margin: 28px 0 0; font-size: 13px; font-weight: 650; }
      .classes-body form > label { display: block; margin-bottom: 7px; color: var(--soft); font-size: 12px; font-weight: 650; }
      .field-note { max-width: 88ch; margin: 4px 0 14px; color: var(--soft); font-size: 12px; }
      textarea {
        width: 100%;
        min-height: 96px;
        margin-bottom: 14px;
        padding: 10px 12px;
        border: 1px solid var(--soft);
        border-radius: 6px;
        background: var(--panel);
        color: var(--ink);
        font: inherit;
        font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
        font-size: 12.5px;
        resize: vertical;
      }
      textarea:focus-visible { outline: 2px solid var(--band); outline-offset: 2px; }
      .row-action {
        min-height: 28px;
        margin: 0 6px 4px 0;
        padding: 0 10px;
        border: 1px solid var(--rule);
        background: transparent;
        color: var(--green-deep);
        font-size: 12px;
        font-weight: 600;
        white-space: nowrap;
      }
      .row-action:hover { background: var(--green-wash); }
      .row-action.danger { border-color: #e0b6b1; color: var(--alarm); }
      .row-action.danger:hover { background: var(--alarm-wash); }
      td.actions { white-space: nowrap; }
      .scope {
        display: inline-block;
        margin: 0 4px 0 0;
        padding: 1px 7px 2px;
        border: 1px solid var(--rule);
        border-radius: 4px;
        color: var(--soft);
        font-size: 10.5px;
        font-weight: 650;
        letter-spacing: .02em;
        text-transform: uppercase;
      }
      .subpanel { margin-top: 14px; padding: 14px 16px 4px; border: 1px solid var(--rule); border-left: 3px solid var(--band); border-radius: 6px; background: #f7f9f3; }
      .subpanel h3 { margin-top: 0; }
      .action-row { display: flex; flex-wrap: wrap; gap: 8px; margin: 14px 0 4px; }
      #class-secret { margin: 16px 0 4px; padding: 14px 16px 4px; border: 1px solid #e0b6b1; border-left: 3px solid var(--alarm); border-radius: 6px; background: var(--alarm-wash); }
      #class-secret p { max-width: 78ch; margin: 0 0 10px; color: var(--alarm); font-size: 13px; font-weight: 600; }
      #class-secret pre {
        margin: 0 0 12px;
        padding: 14px;
        overflow-x: auto;
        border: 1px solid var(--rule);
        border-radius: 6px;
        background: var(--panel);
        font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
        font-size: 12.5px;
        white-space: pre-wrap;
        overflow-wrap: anywhere;
      }
      .status-line { margin: 12px 0 0; color: var(--soft); font-size: 13px; }
      .status-line.error { color: var(--alarm); font-weight: 600; }
      .status-line.ok { color: var(--green-deep); font-weight: 600; }

      /* Approved-alias picker: options come from the control plane, never free text. */
      .alias-editor { margin: 4px 0 10px; }
      .alias-editor fieldset { margin: 0; padding: 12px 14px 4px; border: 1px solid var(--rule); border-radius: 6px; }
      .alias-editor legend { padding: 0 6px; color: var(--soft); font-size: 12px; font-weight: 650; }
      .alias-option { display: flex; gap: 8px; align-items: baseline; margin: 0 0 9px; color: var(--ink); font-size: 12.5px; }
      .alias-option input[type="checkbox"] { flex: none; width: auto; min-height: 0; margin: 2px 0 0; }
      .alias-option span { overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
      .alias-option em { color: var(--alarm); font-style: normal; }
      .alias-editor input[type="text"] { max-width: 620px; }

      /* Checkbox fields sit inline with their label rather than stretching like text inputs. */
      .admin-fields label.check { display: flex; gap: 8px; align-items: center; align-self: end; min-height: 40px; color: var(--ink); font-size: 12.5px; font-weight: 600; }
      .admin-fields label.check input { flex: none; width: auto; min-height: 0; margin: 0; }
      .field-note.warn { color: var(--alarm); font-weight: 600; }
      .limit-notes { margin: 0 0 6px; }
      .limit-notes .field-note { margin: 2px 0 6px; }
      button.quiet { border-color: var(--rule); background: transparent; color: var(--green-deep); }
      button.quiet:hover { background: var(--green-wash); }

      /* In-page confirmation: the action only runs from this bar's own button. */
      .confirm-bar { margin: 10px 0 4px; padding: 12px 14px 2px; border: 1px solid var(--rule); border-left: 3px solid var(--band); border-radius: 6px; background: #f7f9f3; }
      .confirm-bar p { max-width: 78ch; margin: 0; color: var(--ink); font-size: 13px; font-weight: 600; }
      .confirm-bar .action-row { margin-top: 10px; }

      /* Class kit: every student's key at once, shown once, so it carries the alarm edge. */
      #class-kit { margin: 16px 0 4px; padding: 14px 16px 6px; border: 1px solid #e0b6b1; border-left: 3px solid var(--alarm); border-radius: 6px; background: var(--alarm-wash); }
      #class-kit h3 { margin: 0 0 8px; }
      #class-kit > p.kit-warning { max-width: 78ch; margin: 0 0 10px; color: var(--alarm); font-size: 13px; font-weight: 600; }
      #class-kit .table-wrap { margin: 8px 0; border: 1px solid var(--rule); border-radius: 6px; background: var(--panel); }
      #class-kit-keys td:nth-child(2) { user-select: all; }
      #class-kit h4, .student-card h4 { margin: 12px 0 4px; font-size: 12px; font-weight: 650; }

      /* Student card: the same element is used on screen (preview) and on paper. */
      .student-card { min-width: 0; margin: 10px 0 12px; padding: 12px 14px; border: 1px solid var(--rule); border-radius: 6px; background: var(--panel); color: var(--ink); }
      .student-card h3 { margin: 0; font-size: 15px; }
      .student-card .card-class { margin: 2px 0 8px; color: var(--soft); font-size: 12px; }
      .student-card dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 3px 12px; margin: 0; font-size: 12px; }
      .student-card dt { color: var(--soft); font-weight: 650; }
      .student-card dd { margin: 0; overflow-wrap: anywhere; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; }
      .student-card dd.missing { color: var(--alarm); font-weight: 650; }
      .student-card pre { margin: 0 0 6px; padding: 8px 10px; border: 1px solid var(--hair); border-radius: 4px; background: #f7f9f3; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace; font-size: 11px; white-space: pre-wrap; overflow-wrap: anywhere; }
      .student-card .card-foot { margin: 6px 0 0; color: var(--soft); font-size: 11px; }
      #class-secret .student-card p { max-width: none; margin: 2px 0 8px; color: var(--soft); font-size: 12px; font-weight: 400; }
      #class-secret .student-card p.card-foot { margin: 6px 0 0; font-size: 11px; }
      #class-secret .student-card pre { margin: 0 0 6px; padding: 8px 10px; background: #f7f9f3; font-size: 11px; }
      #print-cards { display: none; }

      /* With a class kit on screen, printing produces only the student cards. */
      @media print {
        @page { margin: 10mm; }
        body { min-width: 0; background: #fff; }
        body.print-kit .app { display: none; }
        body.print-kit #print-cards { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 5mm; }
        #print-cards .student-card { margin: 0; padding: 3mm 4mm; border: 1px dashed #777; break-inside: avoid; font-size: 8.5pt; }
        #print-cards .student-card h3 { font-size: 11pt; }
        #print-cards .student-card .card-class { margin-bottom: 2mm; }
        #print-cards .student-card dl { font-size: 8.5pt; }
        #print-cards .student-card h4 { margin: 2mm 0 1mm; font-size: 8pt; }
        #print-cards .student-card pre { margin-bottom: 1mm; padding: 1.5mm 2mm; font-size: 6.8pt; line-height: 1.3; }
        #print-cards .student-card .card-foot { font-size: 7pt; }
      }
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
          <li id="nav-classes" hidden><button type="button" class="nav-item" data-view="classes">Classes</button></li>
          <li><button type="button" class="nav-item" data-view="overview" aria-current="page">Overview</button></li>
          <li><button type="button" class="nav-item" data-view="attempts">Diagnostics</button></li>
          <li><button type="button" class="nav-item" data-view="stale">Stale intents</button></li>
          <li id="nav-activity"><button type="button" class="nav-item" data-view="activity">Activity</button></li>
          <li id="nav-admin" hidden><button type="button" class="nav-item" data-view="admin">Settings</button></li>
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

          <div class="view" data-view="classes" hidden>
            <p class="lede">Course-centred control. Create a class with approved aliases and a shared budget, list your students to give each one an API key, then print their cards. Each student is a group with its own allocation; group API keys are direct gateway credentials, and join codes still activate devices through the existing activation endpoint.</p>
            <p id="gateway-note" class="notice" role="status" hidden></p>

            <section>
              <div class="section-head"><h2 id="classes-heading">Classes</h2><p class="section-note">Bounded inventory; open a class to manage its groups, keys, and usage</p></div>
              <p id="class-options-note" class="section-note"></p>
              <div class="table-wrap" role="region" tabindex="0" aria-labelledby="classes-heading"><table id="classes"></table></div>
              <p id="classes-truncated" class="section-note" hidden>Only the first page of classes is shown.</p>
              <p id="classes-status" class="status-line" role="status" aria-live="polite"></p>
            </section>

            <section>
              <div class="section-head"><h2 id="class-create-heading">Create class</h2><p class="section-note">Approved aliases, budgets, and schedules are enforced by the control plane, not the browser</p></div>
              <div class="classes-body">
                <form id="class-create-form" autocomplete="off">
                  <div class="admin-fields" id="class-create-fields"></div>
                  <p class="field-note" id="class-create-schedule-note"></p>
                  <div class="limit-notes" id="class-create-limits" role="status" aria-live="polite"></div>
                  <div class="alias-editor" id="class-create-aliases"></div>
                  <p class="field-note" id="class-create-alias-note"></p>
                  <p class="field-note">Budgets are in US dollars and shared by scope: <span class="scope">class</span> the class total covers every group; <span class="scope">group</span> each group's (student's) budget is shared by all of its keys and activated devices; <span class="scope">key</span> and <span class="scope">device</span> access never adds a separate spend bucket. The optional daily budget applies per group and resets at 00:00 UTC.</p>
                  <label for="class-create-students">Students (optional; one name per line, up to 100)</label>
                  <textarea id="class-create-students" placeholder="Ada Lovelace&#10;Alan Turing"></textarea>
                  <p class="field-note">Each name becomes a group with its own API key. Keys are issued as soon as the class is created and shown once, ready to copy, download or print as student cards.</p>
                  <button id="class-create-submit" type="submit">Create class</button>
                </form>
                <p id="class-create-status" class="status-line" role="status" aria-live="polite"></p>
              </div>
            </section>

            <section id="class-detail" hidden>
              <div class="section-head"><h2 id="class-detail-heading">Class</h2><p class="section-note" id="class-detail-meta"></p></div>
              <div class="classes-body">
                <div class="action-row">
                  <button id="class-issue-all" type="button">Issue keys for all students</button>
                  <button id="class-pause" type="button">Pause class</button>
                  <button id="class-duplicate" type="button">Duplicate configuration</button>
                  <button id="class-detail-refresh" type="button">Refresh groups and usage</button>
                </div>
                <div class="confirm-bar" id="class-issue-confirm" role="group" aria-labelledby="class-issue-confirm-text" hidden>
                  <p id="class-issue-confirm-text"></p>
                  <div class="action-row">
                    <button type="button" data-confirm="yes">Issue keys</button>
                    <button type="button" class="quiet" data-confirm="no">Cancel</button>
                  </div>
                </div>
                <p id="class-action-status" class="status-line" role="status" aria-live="polite"></p>

                <div id="class-kit" tabindex="-1" aria-labelledby="class-kit-heading" hidden>
                  <h3 id="class-kit-heading">Class kit</h3>
                  <p class="kit-warning">Copy, download or print these keys now: each is shown once and cannot be retrieved later. Keep them out of tickets, logs and browser storage. While this kit is shown, printing the page (including Ctrl+P or Cmd+P) prints every student's card and key. Clearing, refreshing or leaving this page removes them from the screen.</p>
                  <p id="class-kit-gateway" class="field-note warn" hidden></p>
                  <p id="class-kit-summary" class="status-line ok"></p>
                  <div class="action-row">
                    <button id="class-kit-copy" type="button">Copy all (CSV)</button>
                    <button id="class-kit-download" type="button">Download CSV</button>
                    <button id="class-kit-print" type="button">Print student cards</button>
                    <button id="class-kit-clear" type="button" class="quiet">Clear</button>
                  </div>
                  <p id="class-kit-status" class="status-line" role="status" aria-live="polite"></p>
                  <div class="table-wrap" role="region" tabindex="0" aria-label="Issued student keys"><table id="class-kit-keys"></table></div>
                  <div id="class-kit-skipped-block" hidden>
                    <h4>Skipped</h4>
                    <div class="table-wrap" role="region" tabindex="0" aria-label="Skipped groups"><table id="class-kit-skipped"></table></div>
                  </div>
                  <h4>Card preview</h4>
                  <div id="class-kit-preview"></div>
                </div>

                <div class="subpanel">
                  <h3 id="class-edit-heading">Adjust class budget, schedule, and aliases</h3>
                  <form id="class-edit-form" autocomplete="off">
                    <div class="admin-fields" id="class-edit-fields"></div>
                    <p class="field-note" id="class-edit-schedule-note"></p>
                    <div class="limit-notes" id="class-edit-limits" role="status" aria-live="polite"></div>
                    <div class="alias-editor" id="class-edit-aliases"></div>
                    <p class="field-note" id="class-edit-alias-note"></p>
                    <p class="field-note">Leave the daily budget blank to remove the class's default group daily cap; environment guardrails still apply. Changing the per-student budget affects new groups only; use the budget form under Groups for existing students. Class controls cannot expose aliases the environment has not approved.</p>
                    <button id="class-edit-submit" type="submit">Save class</button>
                  </form>
                  <p id="class-edit-status" class="status-line" role="status" aria-live="polite"></p>
                </div>

                <div class="subpanel" id="class-duplicate-panel" hidden>
                  <h3 id="class-duplicate-heading">Duplicate configuration</h3>
                  <form id="class-duplicate-form" autocomplete="off">
                    <div class="admin-fields" id="class-duplicate-fields"></div>
                    <p class="field-note" id="class-duplicate-note"></p>
                    <button id="class-duplicate-submit" type="submit">Duplicate class</button>
                  </form>
                  <p id="class-duplicate-status" class="status-line" role="status" aria-live="polite"></p>
                </div>

                <h3>Groups and keys</h3>
                <p class="field-note">Groups are created in bulk. Each group inherits class policy unless it overrides it, and starts with the class default group budget.</p>
                <form id="group-create-form" autocomplete="off">
                  <label for="group-names">Group names (one per line, up to 100)</label>
                  <textarea id="group-names" required></textarea>
                  <button id="group-create-submit" type="submit">Create groups</button>
                </form>
                <p id="group-status" class="status-line" role="status" aria-live="polite"></p>
                <p id="groups-truncated" class="field-note" role="status" hidden>Group, key, or join-code inventory is truncated; counts and rows shown may be incomplete.</p>
                <div class="table-wrap" role="region" tabindex="0" aria-label="Class groups"><table id="class-groups"></table></div>

                <div class="subpanel">
                  <h3 id="group-budget-heading">Give every student more (or less) budget</h3>
                  <form id="group-budget-form" autocomplete="off">
                    <div class="admin-fields">
                      <label>Change<select name="mode"><option value="add">Add to each student's allocation</option><option value="set">Set each student's allocation to</option></select></label>
                      <label>Amount per student (US$)<input name="budget" type="text" inputmode="decimal" placeholder="1.00" required></label>
                      <label>New class total (US$, optional)<input name="class_budget" type="text" inputmode="decimal" placeholder="Leave blank to keep"></label>
                    </div>
                    <p class="field-note">Applies to every group that is not revoked, including paused ones. Allocations are lifetime caps; the class total still caps everyone together, so raise it too if students would otherwise share too little.</p>
                    <button id="group-budget-submit" type="submit">Review budget change</button>
                  </form>
                  <div class="confirm-bar" id="group-budget-confirm" role="group" aria-labelledby="group-budget-confirm-text" hidden>
                    <p id="group-budget-confirm-text"></p>
                    <div class="action-row">
                      <button type="button" data-confirm="yes">Apply to every student</button>
                      <button type="button" class="quiet" data-confirm="no">Cancel</button>
                    </div>
                  </div>
                  <p id="group-budget-status" class="status-line" role="status" aria-live="polite"></p>
                </div>

                <div class="subpanel" id="group-edit-panel" hidden>
                  <h3 id="group-edit-heading">Adjust group</h3>
                  <form id="group-edit-form" autocomplete="off">
                    <div class="admin-fields" id="group-edit-fields"></div>
                    <p class="field-note" id="group-edit-schedule-note"></p>
                    <div class="alias-editor" id="group-edit-aliases"></div>
                    <p class="field-note" id="group-edit-alias-note"></p>
                    <p class="field-note">Blank override fields inherit the class policy or remove the override. Revoking a group is terminal.</p>
                    <button id="group-edit-submit" type="submit">Save group</button>
                  </form>
                  <p id="group-edit-status" class="status-line" role="status" aria-live="polite"></p>
                </div>

                <h3>Group API keys</h3>
                <p class="field-note">Direct gateway credentials for compatible tools. Shown once. Multiple keys share one group's budget, and rotation keeps the group and its spend.</p>
                <div class="table-wrap" role="region" tabindex="0" aria-label="Group API keys"><table id="class-keys"></table></div>

                <h3>Join codes</h3>
                <p class="field-note">Codes that activate devices into short-lived grants through the existing activation endpoint. The activation cap counts devices, not spend, and every device shares the group budget.</p>
                <div class="table-wrap" role="region" tabindex="0" aria-label="Join codes"><table id="class-codes"></table></div>

                <h3>Usage</h3>
                <p class="field-note">Persisted accounting projection, not the live reservation state. Allocation is the configured budget for the scope, not a remaining balance. Accounted lifetime cost and pending reservation ceilings are shown separately; live reservations and uncertain charges may reduce the budget still available. This view does not reconcile them. Daily caps apply in UTC.</p>
                <div class="table-wrap" role="region" tabindex="0" aria-label="Class and group usage"><table id="class-usage"></table></div>
                <p id="class-usage-status" class="status-line" role="status" aria-live="polite"></p>
                <p id="class-usage-note" class="section-note"></p>

                <div id="class-secret" hidden>
                  <p>Copy this credential now: it is shown once and cannot be retrieved later. Do not put it in tickets or logs, and do not store it in browser storage.</p>
                  <pre id="class-secret-value"></pre>
                  <div id="class-secret-card" hidden></div>
                  <div class="action-row">
                    <button id="class-secret-copy" type="button">Copy</button>
                    <button id="class-secret-download" type="button">Download</button>
                    <button id="class-secret-clear" type="button">Clear</button>
                  </div>
                  <p id="class-secret-status" class="status-line" role="status" aria-live="polite"></p>
                </div>
              </div>
            </section>
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
          <div class="section-head"><h2 id="admin-heading">Settings</h2><p class="section-note">Changes here take effect immediately</p></div>
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
    <div id="print-cards"></div>
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

      // Teachers read and enter money in US dollars; the API stores integer microcents.
      // formatDollars, parseDollars and csvCell are embedded from dashboard-money.ts,
      // where they are unit-tested; see that module for the exact rules.
      __DASHBOARD_HELPERS__
      const money = (value) => formatDollars(value, true);
      // Plain decimal for prefilling inputs, e.g. 150000000 μ¢ becomes "1.50".
      const dollarText = (value) => formatDollars(value, false);
      // Class times are shown in the class's own IANA timezone; UTC is the fallback.
      function zonedTime(value, timeZone) {
        if (value === null || value === undefined || value === "") return "—";
        try {
          return new Intl.DateTimeFormat("en-GB", { timeZone: timeZone || "UTC", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }).format(new Date(Number(value) * 1000));
        } catch {
          return time(value) + " (class timezone invalid)";
        }
      }

      const PILL_KIND = { Enabled: "ok", Disabled: "off", KILLED: "bad", Admin: "ok", Active: "ok", Paused: "off", Revoked: "bad", Class: "ok", Group: "off" };
      const statusKind = (text) => /^2\d\d/.test(text) ? "ok" : text === "in flight" ? "off" : "bad";
      const pillKind = (column, text) => column.pill === "status" ? statusKind(text) : PILL_KIND[text] || "off";
      const isNumeric = (column) => column.num === true || column.format === number || column.format === cost || column.format === money;

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
              if (column.buttons) {
                cell.className = "actions";
                for (const button of column.buttons(item) || []) {
                  const element = document.createElement("button");
                  element.type = "button";
                  element.className = "row-action" + (button.danger ? " danger" : "");
                  element.textContent = button.label;
                  element.disabled = Boolean(button.disabled);
                  element.addEventListener("click", button.onClick);
                  cell.append(element);
                }
                row.append(cell);
                continue;
              }
              const raw = typeof column.value === "function" ? column.value(item) : item[column.value];
              const text = String(column.format ? column.format(raw) : raw ?? "—");
              // Secret cells (issued keys) never repeat their value in a tooltip.
              if (!column.secret) cell.title = String(raw ?? "");
              if (column.pill) {
                const pill = document.createElement("span");
                const kind = pillKind(column, text);
                pill.className = "pill " + kind;
                pill.textContent = text;
                cell.append(pill);
                if (column.pill === "status" && kind === "bad") row.classList.add("flagged");
              } else {
                if (isNumeric(column)) cell.className = "num";
                if (column.bounded) {
                  const bounded = document.createElement("span");
                  bounded.className = "bounded-cell";
                  bounded.textContent = text;
                  cell.append(bounded);
                } else {
                  cell.textContent = text;
                }
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

        const policyState = (enabled, killed) => killed ? "KILLED" : enabled ? "Enabled" : "Disabled";
        renderTable("products", [
          { label: "Product", value: "display_name" },
          { label: "ID", value: "id" },
          { label: "Slug", value: "slug" },
          { label: "State", value: (row) => policyState(row.enabled, row.kill_switch), pill: true },
        ], data.products);
        dashboardData = data;
        renderEnvironments();
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

      // Environment IDs are what Settings and the API ask for, so they are shown and
      // copyable. Editing limits is a named-admin action and only rendered for admins.
      let isAdmin = false;
      async function copyEnvironmentId(row) {
        try {
          await navigator.clipboard.writeText(row.id);
          status.textContent = "Copied environment ID " + row.id + ".";
        } catch {
          status.textContent = "Copy failed; select the environment ID and copy it manually.";
        }
      }
      function renderEnvironments() {
        const data = dashboardData || { products: [], environments: [] };
        const productNames = Object.fromEntries(data.products.map((item) => [item.id, item.display_name]));
        const policyState = (enabled, killed) => killed ? "KILLED" : enabled ? "Enabled" : "Disabled";
        const boundedCount = (value, truncated) => truncated ? "≥" + number(value) : number(value);
        renderTable("environments", [
          { label: "Product", value: (row) => productNames[row.product_id] || row.product_id },
          { label: "Environment", value: "name" },
          { label: "Environment ID", value: "id" },
          { label: "Actions", buttons: (row) => {
            const buttons = [{ label: "Copy ID", onClick: () => copyEnvironmentId(row) }];
            if (isAdmin) buttons.push({ label: "Edit limits", onClick: () => editEnvironment(row) });
            return buttons;
          } },
          { label: "Product state", value: (row) => policyState(row.product_enabled, row.product_kill_switch), pill: true },
          { label: "Environment state", value: (row) => policyState(row.enabled, row.kill_switch), pill: true },
          { label: "Policy", value: "policy_version", format: number },
          { label: "Token TTL", value: (row) => row.token_ttl_seconds === undefined || row.token_ttl_seconds === null ? "—" : number(row.token_ttl_seconds) + " s", num: true },
          { label: "RPM", value: "rpm_limit", format: number },
          { label: "TPM", value: "tpm_limit", format: number },
          { label: "Concurrency", value: "concurrency_limit", format: number },
          { label: "Daily budget per principal (resets 00:00 UTC)", value: "daily_budget_microcents", format: money },
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
      for (const item of navItems) item.addEventListener("click", () => {
        showView(item.dataset.view);
        if (item.dataset.view === "classes") loadClasses();
      });

      // Admins get the richer "Who changed what" table inside Settings, so the
      // actor-blind copy is theirs to lose, not the viewers'. Classes is a named-admin
      // workflow too, so it is hidden for viewers.
      function applyRole(admin) {
        isAdmin = admin;
        document.getElementById("nav-admin").hidden = !admin;
        document.getElementById("nav-classes").hidden = !admin;
        document.getElementById("nav-activity").hidden = admin;
        renderEnvironments();
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
        ["access-codes", "Issue classroom code", [...scopeFields, identityFields[0], capabilities, expiry, ["max_activations", "Maximum activations", "number"], ["max_failed_attempts", "Failed-attempt counter cap (a correct code is always accepted)", "number", 8]]],
        ["service-credentials", "Issue service key", [...scopeFields, ...identityFields, capabilities, [...expiry, "", true]]],
        ["revoke", "Revoke access", [["resource_type", "Resource type", ["access_code", "service_credential", "entitlement", "token_grant"]], ["resource_id", "Resource ID (not secret value)"]]],
        ["kill-switch", "Set kill switch", [["resource_type", "Resource type", ["environment", "product"]], ["resource_id", "Resource ID"], ["enabled", "Kill switch ON (true) / OFF (false)", ["true", "false"]]]],
        ["products", "Create product", [["slug", "Slug"], ["display_name", "Display name"]]],
        ["environments", "Create environment", [scopeFields[0], ["name", "Environment name"], ["audience", "Token audience"], ["rpm_limit", "Requests per minute, per principal", "number", 600], ["tpm_limit", "Tokens per minute, per principal", "number", 2000000], ["concurrency_limit", "Concurrent requests, per principal", "number", 20], ["daily_budget_microcents", "Daily budget per principal (US$; resets 00:00 UTC; not applied to classes)", "dollars", "20.00"]]],
        ["environments/update", "Edit environment limits", [...scopeFields, ["token_ttl_seconds", "Token lifetime (seconds, 60–3600)", "number", "", true], ["rpm_limit", "Requests per minute, per principal", "number", "", true], ["tpm_limit", "Tokens per minute, per principal", "number", "", true], ["concurrency_limit", "Concurrent requests, per principal", "number", "", true], ["daily_budget_microcents", "Daily budget per principal (US$; resets 00:00 UTC; not applied to classes)", "dollars", "", true], ["max_request_bytes", "Maximum request size (bytes, 1024–10485760)", "number", "", true]]],
        ["aliases", "Set model alias", [...scopeFields, ["alias", "Public alias"], ["endpoint", "Endpoint", ["chat", "responses"]], ["route_id", "Configured provider route ID"], ["display_name", "Client-facing display name — blank clears", "text", "", true], ["provider", "Client-facing provider — blank clears", ${JSON.stringify(["", ...MODEL_PROVIDERS])}, "", true], ["tier", "Client-facing tier — blank clears", ${JSON.stringify(["", ...MODEL_TIERS])}, "", true], ["max_input_tokens", "Maximum input tokens", "number"], ["max_output_tokens", "Maximum output tokens", "number"], ["input_cost_microcents_per_million", "Input price (US$ per million tokens)", "dollars", "0"], ["output_cost_microcents_per_million", "Output price (US$ per million tokens)", "dollars", "0"], ["allow_images", "Allow image input", "checkbox"], ["allow_reasoning", "Allow reasoning controls", "checkbox"], ["allow_structured_json", "Allow structured JSON output", "checkbox"]]],
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
          else if (type === "checkbox") { input.type = "checkbox"; input.required = false; input.checked = Boolean(initial); wrapper.className = "check"; wrapper.prepend(input); fields.append(wrapper); continue; }
          else if (type === "dollars") { input.type = "text"; input.inputMode = "decimal"; input.placeholder = "0.00"; input.value = initial; }
          else { input.type = type === "list" ? "text" : type; if (type === "number") { input.step = "1"; input.min = "0"; } input.value = initial; }
          wrapper.append(input); fields.append(wrapper);
        }
      }
      operation.addEventListener("change", renderFields); renderFields();
      // "Edit limits" in the Environments table opens this form prefilled with the
      // environment's current values; only what the admin submits is written.
      function editEnvironment(row) {
        showView("admin");
        operation.value = "environments/update";
        renderFields();
        const current = { product_id: row.product_id, environment_id: row.id, token_ttl_seconds: row.token_ttl_seconds, rpm_limit: row.rpm_limit, tpm_limit: row.tpm_limit, concurrency_limit: row.concurrency_limit, daily_budget_microcents: dollarText(row.daily_budget_microcents), max_request_bytes: row.max_request_bytes };
        for (const [name, value] of Object.entries(current)) {
          const input = fields.querySelector('[name="' + name + '"]');
          if (input && value !== undefined && value !== null) input.value = String(value);
        }
        set("admin-result-status", "Editing limits for environment " + row.name + " (" + row.id + "). Change what you need, then review and apply.");
        document.getElementById("admin-form").scrollIntoView({ block: "start" });
      }
      document.getElementById("admin-clear").addEventListener("click", clearResult);
      window.addEventListener("pagehide", clearResult);
      document.getElementById("admin-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const payload = {};
        const selected = operation.value;
        // Dollar amounts are converted to integer microcents before anything is sent.
        for (const [name, label, type] of operations.find((item) => item[0] === selected)[2]) {
          const input = fields.querySelector('[name="' + name + '"]');
          if (type === "checkbox") { payload[name] = input.checked; continue; }
          const value = input.value;
          if (value === "") continue;
          if (type === "dollars") {
            const parsed = parseDollars(value);
            if (parsed.error) { set("admin-result-status", label + " " + parsed.error + "."); return; }
            if (!parsed.empty) payload[name] = parsed.value;
            continue;
          }
          payload[name] = type === "number" ? Number(value) : type === "datetime-local" ? Math.floor(new Date(value).getTime() / 1000) : type === "list" ? value.split(",").map((item) => item.trim()).filter(Boolean) : Array.isArray(type) && type[0] === "true" ? value === "true" : value;
        }
        if (selected === "environments/update" && Object.keys(payload).every((key) => key === "product_id" || key === "environment_id")) { set("admin-result-status", "Change at least one environment setting."); return; }
        if (!window.confirm("Apply: " + operation.selectedOptions[0].textContent + "? This changes live state.")) return;
        clearResult(); adminSubmit.disabled = true; refresh.disabled = true; operation.disabled = true;
        set("admin-result-status", "Applying…");
        try {
          const response = await fetch("/dashboard/api/" + selected, { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", redirect: "error", cache: "no-store", body: JSON.stringify(payload) });
          const result = await response.json();
          if (!response.ok) { if (response.status === 401 || response.status === 403) { adminPanel.hidden = true; applyRole(false); status.textContent = "Admin access expired or was revoked. Reload to check your login."; } throw new Error(response.status >= 500 ? "Server error; check activity before retrying because the operation may have completed." : result.error?.message || "Operation rejected."); }
          if (selected === "admins") await loadDashboard();
          set("admin-result-status", selected === "environments/update" ? "Environment limits updated (policy version " + result.policy_version + "). Refresh to see them in Overview and Classes." : "Operation completed. Copy any credentials before refreshing the dashboard.");
          if (!adminPanel.hidden) { set("admin-result-data", JSON.stringify(result, null, 2)); document.getElementById("admin-result").hidden = false; }
        } catch (error) {
          set("admin-result-status", error instanceof TypeError || error instanceof SyntaxError ? "Connection failed; the operation may have completed. Check activity before retrying. Reload if your login expired." : error.message);
        } finally { adminSubmit.disabled = false; refresh.disabled = false; operation.disabled = false; }
      });

      // ---- Classes: course-centred workflow (named admins only) ----
      // Everything below talks to the class/group management API through the same
      // same-origin, named-admin POST /dashboard/api/... boundary as Settings.
      let dashboardData = null;
      let firstClassLoad = true;
      let classOptions = null;
      let classOptionsTruncated = false;
      const classState = { classes: [], selected: null, detail: null, usage: null, groupEditing: null, groupEditorRevision: 0 };
      // Credential-producing actions share one show-once panel, so only one may run at a
      // time: a second rotation must never overwrite a secret the operator has not seen.
      let credentialPending = false;
      // The gateway origin printed on student cards comes from the admin session
      // (GATEWAY_PUBLIC_URL); it is not secret, but cards say so plainly when it is unset.
      let gatewayConfig = { public_url: null, status: "unset" };
      const GATEWAY_MISSING = "<gateway URL not configured>";
      const gatewayBase = () => gatewayConfig.public_url ? gatewayConfig.public_url + "/v1" : GATEWAY_MISSING;
      // Bulk-issued keys live only in this object and the kit's DOM, never in storage;
      // clearKit() drops both on Clear, class change, refresh, lost access and page exit.
      const kitState = { classId: null, className: "", entries: [], skipped: [] };

      function setStatus(id, message, kind) {
        const element = document.getElementById(id);
        element.textContent = message || "";
        element.className = "status-line" + (kind ? " " + kind : "");
      }
      function messageFor(error) {
        if (error instanceof TypeError || error instanceof SyntaxError) return "Connection failed; the operation may have completed. Check the class list and activity before retrying.";
        return error && error.message ? error.message : "Operation failed.";
      }
      async function dashboardPost(operation, payload) {
        const response = await fetch("/dashboard/api/" + operation, {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          redirect: "error",
          cache: "no-store",
          body: JSON.stringify(payload || {}),
        });
        let result = null;
        try { result = await response.json(); } catch { result = null; }
        if (!response.ok) {
          if (response.status === 401 || response.status === 403) {
            document.getElementById("nav-classes").hidden = true;
            document.getElementById("class-detail").hidden = true;
            clearKit();
            clearSecret();
            applyRole(false);
            status.textContent = "Admin access expired or was revoked. Reload to check your login.";
          }
          const serverMessage = result && result.error && result.error.message;
          const fallback = response.status === 409 ? "This change conflicts with the current state; revoked items are terminal." : response.status === 400 ? "The request was rejected as invalid." : "Operation rejected.";
          throw new Error(response.status >= 500 ? "Server error; check activity before retrying because the operation may have completed." : serverMessage || fallback);
        }
        return result;
      }
      const pad = (value) => String(value).padStart(2, "0");
      function localDateTime(seconds) {
        if (!seconds) return "";
        const date = new Date(Number(seconds) * 1000);
        return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + "T" + pad(date.getHours()) + ":" + pad(date.getMinutes());
      }
      function renderFieldSet(container, spec, values) {
        container.replaceChildren();
        for (const [name, label, type] of spec) {
          const wrapper = document.createElement("label");
          wrapper.textContent = label;
          let input;
          if (type === "status") {
            input = document.createElement("select");
            for (const value of ["active", "revoked"]) {
              const option = document.createElement("option");
              option.value = value;
              option.textContent = value === "active" ? "Active" : "Revoked (terminal)";
              input.append(option);
            }
            input.value = values.status === "revoked" ? "revoked" : "active";
          } else if (type === "select-product" || type === "select-environment") {
            input = document.createElement("select");
            input.dataset.role = type;
          } else if (type === "list") {
            input = document.createElement("input");
            input.type = "text";
            input.value = Array.isArray(values[name]) ? values[name].join(", ") : "";
          } else if (type === "datetime-local") {
            input = document.createElement("input");
            input.type = "datetime-local";
            input.value = localDateTime(values[name]);
          } else if (type === "number") {
            input = document.createElement("input");
            input.type = "number";
            input.step = "1";
            input.min = "0";
            input.value = values[name] === null || values[name] === undefined ? "" : String(values[name]);
          } else if (type === "dollars") {
            input = document.createElement("input");
            input.type = "text";
            input.inputMode = "decimal";
            input.placeholder = /optional|blank/i.test(label) ? "Leave blank for none" : "0.00";
            input.dataset.kind = "dollars";
            input.dataset.label = label;
            input.value = values[name] === null || values[name] === undefined ? "" : dollarText(values[name]);
          } else {
            input = document.createElement("input");
            input.type = "text";
            input.value = values[name] === null || values[name] === undefined ? "" : String(values[name]);
          }
          input.name = name;
          wrapper.append(input);
          container.append(wrapper);
        }
      }
      function readFieldSet(container) {
        const payload = {};
        for (const input of container.querySelectorAll("input, select")) {
          const name = input.name;
          if (!name) continue;
          if (input.type === "datetime-local") { payload[name] = input.value ? Math.floor(new Date(input.value).getTime() / 1000) : null; continue; }
          if (input.type === "number") { payload[name] = input.value === "" ? null : Number(input.value); continue; }
          if (input.dataset.kind === "dollars") { const parsed = parseDollars(input.value); payload[name] = parsed.value === undefined ? null : parsed.value; continue; }
          if (name === "instructors") { payload[name] = input.value.split(",").map((item) => item.trim()).filter(Boolean); continue; }
          payload[name] = input.value;
        }
        return payload;
      }
      // Dollar fields are validated before a payload is built, so a typo is reported by
      // name instead of silently becoming "blank".
      function dollarProblem(container) {
        for (const input of container.querySelectorAll('input[data-kind="dollars"]')) {
          const parsed = parseDollars(input.value);
          if (parsed.error) return input.dataset.label.replace(/ \(.*$/, "") + " " + parsed.error + ".";
        }
        return "";
      }
      function scopeSource() {
        if (classOptions && Array.isArray(classOptions.environments) && classOptions.environments.length) {
          const products = [];
          const seen = new Set();
          const environments = [];
          for (const environment of classOptions.environments) {
            if (!seen.has(environment.product_id)) {
              seen.add(environment.product_id);
              products.push({ id: environment.product_id, display_name: environment.product_name || environment.product_id });
            }
            environments.push({ id: environment.environment_id, product_id: environment.product_id, name: environment.environment_name || environment.environment_id });
          }
          return { products, environments, approved: true };
        }
        const data = dashboardData || { products: [], environments: [] };
        return { products: data.products, environments: data.environments, approved: false };
      }
      function approvedAliases(environmentId) {
        if (!classOptions || !Array.isArray(classOptions.environments)) return null;
        const environment = classOptions.environments.find((item) => item.environment_id === environmentId);
        return environment && Array.isArray(environment.aliases) ? environment.aliases : [];
      }
      function readAliases(container) {
        const boxes = container.querySelectorAll('input[type="checkbox"][name="capabilities"]');
        if (boxes.length) return [...boxes].filter((box) => box.checked).map((box) => box.value);
        const text = container.querySelector('input[name="capabilities"]');
        return text ? text.value.split(",").map((item) => item.trim()).filter(Boolean) : [];
      }
      function renderAliasChecklist(container, config) {
        container.replaceChildren();
        const fieldset = document.createElement("fieldset");
        const legend = document.createElement("legend");
        legend.textContent = config.legend;
        fieldset.append(legend);
        const note = document.createElement("p");
        note.className = "field-note";
        note.textContent = config.note;
        fieldset.append(note);
        if (!config.options.length) {
          const empty = document.createElement("p");
          empty.className = "field-note";
          empty.textContent = config.empty;
          fieldset.append(empty);
        }
        for (const alias of config.options) {
          const label = document.createElement("label");
          label.className = "alias-option";
          const input = document.createElement("input");
          input.type = "checkbox";
          input.name = "capabilities";
          input.value = alias;
          input.checked = config.selected.includes(alias);
          const text = document.createElement("span");
          text.textContent = alias;
          label.append(input, text);
          if (config.outside.includes(alias)) {
            const marker = document.createElement("em");
            marker.textContent = config.outsideLabel;
            label.append(marker);
          }
          fieldset.append(label);
        }
        container.append(fieldset);
      }
      // The approved-alias picker is driven by classes/options. If that call is
      // unavailable it degrades to a labelled text field, never silent free text.
      function renderAliasEditor(container, environmentId, selected) {
        const approved = approvedAliases(environmentId);
        if (approved === null) {
          container.replaceChildren();
          const fieldset = document.createElement("fieldset");
          const legend = document.createElement("legend");
          legend.textContent = "Approved aliases / models";
          fieldset.append(legend);
          const note = document.createElement("p");
          note.className = "field-note";
          note.textContent = "The approved-alias list is unavailable (classes/options did not respond). Enter alias IDs separated by commas; the control plane rejects invalid or unapproved aliases with 400.";
          fieldset.append(note);
          const input = document.createElement("input");
          input.type = "text";
          input.name = "capabilities";
          input.setAttribute("aria-label", "Approved aliases / models (comma separated)");
          input.value = (selected || []).join(", ");
          fieldset.append(input);
          container.append(fieldset);
          return;
        }
        const options = approved.slice();
        for (const alias of selected || []) if (!options.includes(alias)) options.push(alias);
        renderAliasChecklist(container, {
          legend: "Approved aliases / models",
          note: "Only aliases approved and enabled for the chosen environment are listed; the control plane rejects anything else with 400.",
          empty: "This environment has no enabled aliases yet. Add one in Settings before creating the class.",
          options,
          selected: selected || [],
          outside: (selected || []).filter((alias) => !approved.includes(alias)),
          outsideLabel: "not currently approved",
        });
      }
      function aliasNoteText(environmentId) {
        const approved = approvedAliases(environmentId);
        if (approved === null) return "Approved aliases could not be listed; the text field above is validated server-side.";
        return "Alias options come from the control plane (enabled products, environments, and aliases only).";
      }
      function classAliases(classId) {
        const row = classState.classes.find((item) => item.id === classId);
        return row && Array.isArray(row.capabilities) ? row.capabilities : [];
      }
      function renderGroupAliases(row) {
        const policy = classAliases(row.class_id);
        const selected = Array.isArray(row.capabilities) ? row.capabilities : [];
        const options = policy.slice();
        for (const alias of selected) if (!options.includes(alias)) options.push(alias);
        renderAliasChecklist(document.getElementById("group-edit-aliases"), {
          legend: "Aliases (override)",
          note: "Leave every alias unchecked to inherit the class policy. A group can only be granted aliases the class already approves.",
          empty: "The class has no approved aliases to override.",
          options,
          selected,
          outside: selected.filter((alias) => !policy.includes(alias)),
          outsideLabel: "not in class policy",
        });
        set("group-edit-alias-note", "Group aliases are the intersection of this override and the class policy; the control plane enforces it.");
      }
      function fillScopeSelectors(container) {
        const productSelect = container.querySelector('[data-role="select-product"]');
        const environmentSelect = container.querySelector('[data-role="select-environment"]');
        if (!productSelect || !environmentSelect) return;
        const aliasContainer = document.getElementById("class-create-aliases");
        const renderEnvironmentAliases = () => {
          renderAliasEditor(aliasContainer, environmentSelect.value, []);
          set("class-create-alias-note", aliasNoteText(environmentSelect.value));
          applyCreateLimitDefaults();
          renderCreateLimits();
        };
        // The option source is read on every run. A listener bound once must not keep the
        // environments array captured on its first call, or a refreshed or newly created
        // product would wrongly resolve to "No environments".
        const fillEnvironments = () => {
          const source = scopeSource();
          const products = source.products;
          const environments = source.environments;
          const previousProduct = productSelect.value;
          productSelect.replaceChildren();
          for (const product of products) {
            const option = document.createElement("option");
            option.value = product.id;
            option.textContent = product.display_name;
            productSelect.append(option);
          }
          if (previousProduct && products.some((product) => product.id === previousProduct)) productSelect.value = previousProduct;
          const productId = productSelect.value;
          const previousEnvironment = environmentSelect.value;
          environmentSelect.replaceChildren();
          const matching = environments.filter((environment) => environment.product_id === productId);
          for (const environment of matching) {
            const option = document.createElement("option");
            option.value = environment.id;
            option.textContent = environment.name;
            environmentSelect.append(option);
          }
          if (!matching.length) {
            const option = document.createElement("option");
            option.value = "";
            option.textContent = "No environments";
            environmentSelect.append(option);
          } else if (previousEnvironment && matching.some((environment) => environment.id === previousEnvironment)) {
            environmentSelect.value = previousEnvironment;
          }
          renderEnvironmentAliases();
        };
        if (!productSelect.dataset.bound) {
          productSelect.dataset.bound = "true";
          productSelect.addEventListener("change", fillEnvironments);
          environmentSelect.addEventListener("change", renderEnvironmentAliases);
        }
        fillEnvironments();
      }
      async function loadClassOptions() {
        try {
          const result = await dashboardPost("classes/options", {});
          classOptions = result && Array.isArray(result.environments) ? result : null;
          classOptionsTruncated = Boolean(result && result.truncated);
        } catch {
          classOptions = null;
          classOptionsTruncated = false;
        }
      }
      function refreshAliasEditors() {
        fillScopeSelectors(document.getElementById("class-create-fields"));
        const row = classState.classes.find((item) => item.id === classState.selected);
        if (row) {
          renderAliasEditor(document.getElementById("class-edit-aliases"), row.environment_id, row.capabilities || []);
          set("class-edit-alias-note", aliasNoteText(row.environment_id));
        }
        const groupRow = classState.detail && (classState.detail.groups || []).find((group) => group.id === classState.groupEditing);
        if (groupRow) renderGroupAliases(groupRow);
        document.getElementById("class-options-note").textContent = classOptionsTruncated ? "The environment and alias options are truncated; only the first page is shown." : "";
      }

      const CLASS_FIELDS = [
        ["name", "Class name", "text"],
        ["course", "Course", "text"],
        ["instructors", "Instructors (comma separated)", "list"],
        ["timezone", "Class timezone (IANA, e.g. Asia/Singapore; times are shown in it)", "text"],
        ["starts_at", "Starts at (browser local time)", "datetime-local"],
        ["expires_at", "Ends at (browser local time)", "datetime-local"],
        ["budget_microcents", "Class total budget (US$, shared by every student)", "dollars"],
        ["group_budget_microcents", "Budget per student (US$, lifetime; each new group)", "dollars"],
        ["daily_budget_microcents", "Daily budget per student (US$, optional; resets 00:00 UTC)", "dollars"],
        ["rpm_limit", "Requests per minute, per student", "number"],
        ["tpm_limit", "Tokens per minute, per student", "number"],
        ["concurrency_limit", "Concurrent requests, per student", "number"],
      ];
      const CLASS_SCOPE_FIELDS = [
        ["product_id", "Product", "select-product"],
        ["environment_id", "Environment", "select-environment"],
        ["tenant_id", "Classroom / tenant ID (suggested from the class name and date)", "text"],
      ];
      // The create form leads with what a teacher knows (name, course), then where the
      // class runs; the tenant ID is suggested so nobody has to invent one.
      const CLASS_CREATE_FIELDS = CLASS_FIELDS.slice(0, 2).concat(CLASS_SCOPE_FIELDS, CLASS_FIELDS.slice(2));
      const GROUP_FIELDS = [
        ["name", "Group name", "text"],
        ["budget_microcents", "Group budget (US$, lifetime; shared by its keys and devices)", "dollars"],
        ["daily_budget_microcents", "Daily group budget (US$; blank inherits class default; resets 00:00 UTC)", "dollars"],
        ["rpm_limit", "Requests per minute (blank inherits)", "number"],
        ["tpm_limit", "Tokens per minute (blank inherits)", "number"],
        ["concurrency_limit", "Concurrency (blank inherits)", "number"],
        ["starts_at", "Starts at (browser local time; blank inherits)", "datetime-local"],
        ["expires_at", "Ends at (browser local time; blank inherits)", "datetime-local"],
        ["status", "Status", "status"],
      ];

      const DUPLICATE_FIELDS = [
        ["name", "New class name", "text"],
        ["starts_at", "New start (browser local time)", "datetime-local"],
        ["expires_at", "New end (browser local time)", "datetime-local"],
      ];
      // A duplicate always gets its own window: an expired source must not be copied
      // forward, so fall back to a future window instead of the source's past one.
      function duplicateDefaults(row) {
        const current = Math.floor(Date.now() / 1000);
        const stillCurrent = typeof row.expires_at === "number" && row.expires_at > current;
        return {
          name: row.name + " (copy)",
          starts_at: stillCurrent ? row.starts_at : current,
          expires_at: stillCurrent ? row.expires_at : current + 86_400 * 30,
        };
      }
      const statusLabel = (status) => status === "active" ? "Active" : status === "paused" ? "Paused" : "Revoked";
      // Group pause is a flag beside the terminal status, so a paused group reads "Paused".
      const groupStatusLabel = (row) => row.status === "revoked" ? "Revoked" : row.paused ? "Paused" : "Active";
      const ALIAS_PATTERN = /^[a-z][a-z0-9._:-]*\.v[1-9][0-9]*$/;
      const overrideText = (value, format) => value === null || value === undefined ? "Inherits class" : format(value);
      const browserTimeZone = (() => {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "browser local time"; }
        catch { return "browser local time"; }
      })();
      const defaultTimeZone = browserTimeZone === "browser local time" ? "Asia/Singapore" : browserTimeZone;
      const scheduleNote = "Start and end times are entered in your browser's local time (" + browserTimeZone + ") and stored as Unix seconds. Class tables show them in the class timezone, with UTC alongside in the class summary. Daily budgets reset at 00:00 UTC, whatever the class timezone.";
      function validateClassPayload(payload) {
        if (!payload.name || !String(payload.name).trim()) return "A class name is required.";
        if (!Array.isArray(payload.capabilities) || !payload.capabilities.length) return "Choose at least one approved alias.";
        const invalidAlias = payload.capabilities.find((alias) => !ALIAS_PATTERN.test(alias));
        if (invalidAlias) return "Alias \"" + invalidAlias + "\" is not a valid alias ID (expected a name like text.chat.v1).";
        for (const field of ["budget_microcents", "group_budget_microcents"]) {
          if (payload[field] === null || payload[field] === undefined || !Number.isFinite(payload[field])) return "Enter the class total and per-student budgets in US dollars.";
        }
        for (const field of ["rpm_limit", "tpm_limit", "concurrency_limit"]) {
          if (payload[field] === null || payload[field] === undefined || !Number.isInteger(payload[field]) || payload[field] < 1) return "Requests per minute, tokens per minute and concurrency must be whole numbers of at least 1.";
        }
        if (!payload.starts_at || !payload.expires_at) return "Start and end times are required.";
        if (payload.expires_at <= payload.starts_at) return "The end time must be after the start time.";
        return "";
      }
      function renderClassTable() {
        renderTable("classes", [
          { label: "Class", value: "name" },
          { label: "Course", value: (row) => row.course || "—" },
          { label: "Status", value: (row) => statusLabel(row.status), pill: true },
          { label: "Starts (class time)", value: (row) => zonedTime(row.starts_at, row.timezone) },
          { label: "Ends (class time)", value: (row) => zonedTime(row.expires_at, row.timezone) },
          { label: "Timezone", value: (row) => row.timezone || "—" },
          { label: "Class budget", value: "budget_microcents", format: money },
          { label: "Per-student budget", value: "group_budget_microcents", format: money },
          { label: "Daily per student (resets 00:00 UTC)", value: (row) => row.daily_budget_microcents === null || row.daily_budget_microcents === undefined ? "No class default" : money(row.daily_budget_microcents) },
          { label: "Approved aliases", value: (row) => (row.capabilities || []).join(", ") || "—" },
          { label: "Group defaults (RPM / TPM / concurrency)", value: (row) => number(row.rpm_limit) + " / " + number(row.tpm_limit) + " / " + number(row.concurrency_limit) },
          { label: "Updated", value: "updated_at", format: time },
          { label: "Actions", buttons: (row) => [{ label: "Open", onClick: () => selectClass(row.id) }] },
        ], classState.classes);
      }
      async function loadClasses() {
        if (document.getElementById("nav-classes").hidden) return;
        setStatus("classes-status", "Loading classes…", "");
        try {
          const result = await dashboardPost("classes/list", {});
          classState.classes = Array.isArray(result.classes) ? result.classes : [];
          renderClassTable();
          document.getElementById("classes-truncated").hidden = !result.truncated;
          setStatus("classes-status", classState.classes.length ? "" : "No classes yet. Create one below.", "");
          if (classState.selected && !classState.classes.some((row) => row.id === classState.selected)) clearClassDetail();
        } catch (error) {
          setStatus("classes-status", messageFor(error), "error");
        }
      }
      function classMeta(row) {
        const parts = [
          row.course ? row.course : "No course",
          "Status: " + statusLabel(row.status),
          "Schedule (" + (row.timezone || "UTC") + "): " + zonedTime(row.starts_at, row.timezone) + " → " + zonedTime(row.expires_at, row.timezone),
          "UTC: " + time(row.starts_at) + " → " + time(row.expires_at),
          "Class total budget: " + money(row.budget_microcents),
          "Per-student budget for new groups: " + money(row.group_budget_microcents),
          "Daily per student (resets 00:00 UTC): " + (row.daily_budget_microcents === null || row.daily_budget_microcents === undefined ? "no class default" : money(row.daily_budget_microcents)),
          "Approved aliases: " + ((row.capabilities || []).join(", ") || "—"),
          "Tenant: " + row.tenant_id,
        ];
        if (row.instructors && row.instructors.length) parts.splice(1, 0, "Instructors: " + row.instructors.join(", "));
        return parts.join(" · ");
      }
      async function selectClass(id) {
        const row = classState.classes.find((item) => item.id === id);
        if (!row) return;
        classState.selected = id;
        classState.detail = null;
        classState.usage = null;
        classState.groupEditing = null;
        renderGroups();
        renderKeys();
        renderCodes();
        renderUsage();
        document.getElementById("groups-truncated").hidden = true;
        clearSecret();
        // Reopening the class a kit belongs to keeps it; any other class clears it.
        if (kitState.classId !== id) clearKit();
        dismissInline("class-issue-confirm");
        dismissInline("group-budget-confirm");
        document.getElementById("group-budget-form").reset();
        setStatus("group-budget-status", "", "");
        document.getElementById("group-edit-panel").hidden = true;
        document.getElementById("class-duplicate-panel").hidden = true;
        setStatus("class-duplicate-status", "", "");
        document.getElementById("class-detail").hidden = false;
        set("class-detail-heading", row.name);
        set("class-detail-meta", classMeta(row));
        renderFieldSet(document.getElementById("class-edit-fields"), CLASS_FIELDS, row);
        renderAliasEditor(document.getElementById("class-edit-aliases"), row.environment_id, row.capabilities || []);
        set("class-edit-alias-note", aliasNoteText(row.environment_id));
        renderEditLimits();
        updatePauseButton(row);
        setStatus("class-action-status", "", "");
        setStatus("class-edit-status", "", "");
        setStatus("group-status", "", "");
        setStatus("group-edit-status", "", "");
        setStatus("class-usage-status", "", "");
        set("class-usage-note", "");
        await Promise.all([loadGroups(), loadUsage()]);
      }
      function clearClassDetail() {
        classState.selected = null;
        classState.detail = null;
        classState.usage = null;
        classState.groupEditing = null;
        document.getElementById("class-detail").hidden = true;
        document.getElementById("group-edit-panel").hidden = true;
        document.getElementById("class-duplicate-panel").hidden = true;
        clearSecret();
        clearKit();
      }
      function updatePauseButton(row) {
        const button = document.getElementById("class-pause");
        button.textContent = row.status === "paused" ? "Resume class" : "Pause class";
        button.disabled = row.status === "revoked";
        button.title = row.status === "revoked" ? "Revoked classes are terminal." : "";
      }
      async function loadGroups() {
        const classId = classState.selected;
        if (!classId) return;
        try {
          const result = await dashboardPost("groups/list", { class_id: classId });
          if (classState.selected !== classId) return;
          classState.detail = result;
          document.getElementById("groups-truncated").hidden = !result.truncated;
          renderGroups();
          renderKeys();
          renderCodes();
          renderUsage();
          renderEditLimits();
        } catch (error) {
          if (classState.selected !== classId) return;
          setStatus("group-status", messageFor(error), "error");
        }
      }
      function renderGroups() {
        const detail = classState.detail || { groups: [], keys: [], codes: [] };
        const groups = Array.isArray(detail.groups) ? detail.groups : [];
        const keys = Array.isArray(detail.keys) ? detail.keys : [];
        const codes = Array.isArray(detail.codes) ? detail.codes : [];
        const keyCounts = {};
        const codeCounts = {};
        for (const code of codes) codeCounts[code.classroom_group_id] = (codeCounts[code.classroom_group_id] || 0) + 1;
        const zone = classTimeZone();
        const inClassTime = (value) => zonedTime(value, zone);
        for (const key of keys) if (!key.revoked_at) keyCounts[key.group_id] = (keyCounts[key.group_id] || 0) + 1;
        renderTable("class-groups", [
          { label: "Group", value: "name", bounded: true },
          { label: "Status", value: groupStatusLabel, pill: true },
          { label: "Aliases", value: (row) => (row.capabilities === null || row.capabilities === undefined ? "Inherits class" : ((row.capabilities || []).join(", ") || "Inherits class")) },
          { label: "Group budget", value: "budget_microcents", format: money },
          { label: "Daily group budget (resets 00:00 UTC)", value: (row) => overrideText(row.daily_budget_microcents, money) },
          { label: "RPM", value: (row) => overrideText(row.rpm_limit, number) },
          { label: "TPM", value: (row) => overrideText(row.tpm_limit, number) },
          { label: "Concurrency", value: (row) => overrideText(row.concurrency_limit, number) },
          { label: "Starts (class time)", value: (row) => overrideText(row.starts_at, inClassTime) },
          { label: "Ends (class time)", value: (row) => overrideText(row.expires_at, inClassTime) },
          { label: "Live keys", value: (row) => number(keyCounts[row.id] || 0) },
          { label: "Join codes", value: (row) => number(codeCounts[row.id] || 0) },
          { label: "Actions", buttons: (row) => {
            const buttons = [];
            if (row.status === "active") {
              buttons.push({ label: "API key", disabled: credentialPending, onClick: () => issueGroupAccess(row.id, "api_key") });
              buttons.push({ label: "Join code", disabled: credentialPending, onClick: () => issueGroupAccess(row.id, "join_code") });
              buttons.push({ label: row.paused ? "Resume" : "Pause", onClick: () => setGroupPaused(row, !row.paused) });
            }
            buttons.push({ label: "Adjust", onClick: () => openGroupEditor(row) });
            if (row.status === "active") buttons.push({ label: "Revoke", danger: true, onClick: () => revokeGroup(row) });
            return buttons;
          } },
        ], groups);
      }
      function renderKeys() {
        const detail = classState.detail || { groups: [], keys: [] };
        const groupNames = Object.fromEntries((detail.groups || []).map((group) => [group.id, group.name]));
        const zone = classTimeZone();
        renderTable("class-keys", [
          { label: "Group", value: (row) => groupNames[row.group_id] || row.group_id },
          { label: "Key ends in", value: (row) => row.key_hint ? "…" + row.key_hint : "not recorded" },
          { label: "Key ID", value: "id" },
          { label: "Created (class time)", value: (row) => zonedTime(row.created_at, zone) },
          { label: "Expires (class time)", value: (row) => row.expires_at === null || row.expires_at === undefined ? "Inherits group schedule" : zonedTime(row.expires_at, zone) },
          { label: "State", value: (row) => row.revoked_at ? "Revoked" : "Active", pill: true },
          { label: "Actions", buttons: (row) => row.revoked_at ? [] : [
            { label: "Rotate", disabled: credentialPending, onClick: () => rotateKey(row.id) },
            { label: "Revoke", danger: true, onClick: () => revokeKey(row.id) },
          ] },
        ], Array.isArray(detail.keys) ? detail.keys : []);
      }
      function renderCodes() {
        const detail = classState.detail || { groups: [], codes: [] };
        const groupNames = Object.fromEntries((detail.groups || []).map((group) => [group.id, group.name]));
        renderTable("class-codes", [
          { label: "Code ID", value: "id" },
          { label: "Group", value: (row) => groupNames[row.classroom_group_id] || row.classroom_group_id },
          { label: "Expires (class time)", value: (row) => zonedTime(row.expires_at, classTimeZone()) },
          { label: "State", value: (row) => row.disabled ? "Disabled" : "Active", pill: true },
          { label: "Activations (devices, not spend)", value: (row) => number(row.activation_count) + " / " + number(row.max_activations) },
          { label: "Actions", buttons: (row) => row.disabled ? [] : [{ label: "Revoke", danger: true, onClick: () => revokeCode(row.id) }] },
        ], Array.isArray(detail.codes) ? detail.codes : []);
      }
      async function loadUsage() {
        const classId = classState.selected;
        if (!classId) return;
        try {
          const result = await dashboardPost("classes/usage", { class_id: classId });
          if (classState.selected !== classId) return;
          classState.usage = result;
          renderUsage();
          set("class-usage-note", result && result.truncated ? "Usage is truncated; only the first page of groups is shown. Class totals include every group." : "");
        } catch (error) {
          if (classState.selected !== classId) return;
          setStatus("class-usage-status", messageFor(error), "error");
        }
      }
      function renderUsage() {
        const usage = classState.usage || { groups: [], totals: null };
        const groups = (classState.detail && classState.detail.groups) || [];
        const groupNames = Object.fromEntries(groups.map((group) => [group.id, group.name]));
        const classRow = classState.classes.find((item) => item.id === classState.selected);
        const rows = [];
        if (usage.totals) rows.push({ scope_kind: "Class", scope: "Class total", allocation_microcents: classRow ? classRow.budget_microcents : null, ...usage.totals });
        for (const group of usage.groups || []) {
          const detailRow = groups.find((item) => item.id === group.group_id);
          rows.push({ scope_kind: "Group", scope: groupNames[group.group_id] || group.group_id, allocation_microcents: detailRow ? detailRow.budget_microcents : null, ...group });
        }
        renderTable("class-usage", [
          { label: "Scope", value: "scope_kind", pill: true },
          { label: "Group / total", value: "scope" },
          { label: "Budget allocation", value: (row) => row.allocation_microcents === null || row.allocation_microcents === undefined ? "—" : money(row.allocation_microcents), num: true },
          { label: "Requests", value: (row) => number(row.requests), num: true },
          { label: "Input tokens", value: (row) => number(row.input_tokens), num: true },
          { label: "Output tokens", value: (row) => number(row.output_tokens), num: true },
          { label: "Accounted lifetime cost", value: (row) => money(row.cost_microcents), num: true },
          { label: "Pending requests", value: (row) => number(row.pending_requests), num: true },
          { label: "Pending reservation ceiling", value: (row) => money(row.pending_cost_microcents), num: true },
        ], rows);
      }
      // Class-specific mutations finish after an await, during which the operator may
      // have opened another class. When a target class id is supplied, completion and
      // error messages only land while that class is still selected, so the heading,
      // editor, actions, and status can never describe different classes.
      async function runClassAction(statusId, action, targetClassId) {
        setStatus(statusId, "Applying…", "");
        try {
          const message = await action();
          if (targetClassId && classState.selected !== targetClassId) return true;
          setStatus(statusId, message || "Done.", "ok");
          return true;
        } catch (error) {
          if (targetClassId && classState.selected !== targetClassId) {
            setStatus("classes-status", messageFor(error), "error");
            return false;
          }
          setStatus(statusId, messageFor(error), "error");
          return false;
        }
      }
      // Ownership-guarded variant for completions that belong to a specific draft rather
      // than to a selected class: the group editor session and the bulk-create draft.
      // Gate once when the awaited work resolves, then run the owned cleanup and success
      // status synchronously: cleanup must not invalidate the ownership it just checked.
      async function runOwnedAction(statusId, owns, action, onSuccess, onSuperseded) {
        setStatus(statusId, "Applying…", "");
        try {
          const message = await action();
          if (!owns()) {
            if (onSuperseded) onSuperseded();
            return true;
          }
          if (onSuccess) onSuccess();
          setStatus(statusId, message || "Done.", "ok");
          return true;
        } catch (error) {
          if (!owns()) {
            setStatus("classes-status", messageFor(error), "error");
            return false;
          }
          setStatus(statusId, messageFor(error), "error");
          return false;
        }
      }
      function groupEditorOwnedBy(owner) {
        return classState.selected === owner.classId
          && classState.groupEditing === owner.groupId
          && classState.groupEditorRevision === owner.revision;
      }
      // Credential-producing actions share one show-once panel. While one is in flight the
      // issuance and rotation controls are disabled, so a later action cannot replace a
      // secret the operator has not read yet.
      function setCredentialPending(pending) {
        credentialPending = pending;
        document.getElementById("class-issue-all").disabled = pending;
        renderGroups();
        renderKeys();
      }
      async function runCredentialAction(action) {
        if (credentialPending) return;
        setCredentialPending(true);
        try {
          await action();
        } finally {
          setCredentialPending(false);
        }
      }
      function groupContext(groupId) {
        const group = classState.detail?.groups?.find((row) => row.id === groupId);
        const classroom = classState.classes.find((row) => row.id === classState.selected);
        return (group ? group.name : groupId) + " in " + (classroom ? classroom.name : classState.selected);
      }
      function showSecret(result, context, groupId) {
        const value = result.api_key || result.access_code || "";
        document.getElementById("class-secret-value").textContent = value;
        document.getElementById("class-secret").hidden = !value;
        // An API key gets the same student card as a bulk kit; join codes use the
        // activation flow instead, so they get no card.
        const cardBox = document.getElementById("class-secret-card");
        cardBox.replaceChildren();
        cardBox.hidden = true;
        if (result.api_key) {
          const classRow = classState.classes.find((row) => row.id === classState.selected);
          const group = classState.detail?.groups?.find((row) => row.id === groupId);
          cardBox.append(studentCard(cardEntry(classRow, group, { api_key: result.api_key, expires_at: null }, group ? group.name : context)));
          cardBox.hidden = false;
        }
        setStatus("class-secret-status", value ? ("For " + context + ". " + (result.api_key ? "Shown once. This is a direct gateway API key; it does not activate devices." : "Shown once. This join code activates devices through the existing activation endpoint.")) : "", value ? "ok" : "");
      }
      function clearSecret() {
        document.getElementById("class-secret").hidden = true;
        document.getElementById("class-secret-value").textContent = "";
        document.getElementById("class-secret-card").replaceChildren();
        document.getElementById("class-secret-card").hidden = true;
        setStatus("class-secret-status", "", "");
      }
      function classTimeZone() {
        const row = classState.classes.find((item) => item.id === classState.selected);
        return row && row.timezone ? row.timezone : "UTC";
      }

      // ---- Environment guardrails next to class limits ----
      // The gateway enforces min(environment guardrail, class/group value) for RPM, TPM and
      // concurrency, so a class value above the guardrail silently buys nothing.
      function environmentLimits(environmentId) {
        const option = classOptions && Array.isArray(classOptions.environments) ? classOptions.environments.find((item) => item.environment_id === environmentId) : null;
        if (option && option.limits) return option.limits;
        const row = dashboardData && Array.isArray(dashboardData.environments) ? dashboardData.environments.find((item) => item.id === environmentId) : null;
        return row ? { rpm_limit: row.rpm_limit, tpm_limit: row.tpm_limit, concurrency_limit: row.concurrency_limit, max_request_bytes: row.max_request_bytes, daily_budget_microcents: row.daily_budget_microcents } : null;
      }
      const CLASS_LIMIT_DEFAULTS = { rpm_limit: 30, tpm_limit: 100000, concurrency_limit: 3 };
      const LIMIT_NAMES = { rpm_limit: "Requests per minute", tpm_limit: "Tokens per minute", concurrency_limit: "Concurrent requests" };
      function readLimitValue(container, name) {
        const input = container.querySelector('[name="' + name + '"]');
        if (!input || input.value === "") return null;
        if (input.dataset.kind === "dollars") { const parsed = parseDollars(input.value); return parsed.value === undefined ? null : parsed.value; }
        const value = Number(input.value);
        return Number.isFinite(value) ? value : null;
      }
      function renderLimitNotes(targetId, container, environmentId, studentCount) {
        const target = document.getElementById(targetId);
        const notes = [];
        const add = (text, warn) => {
          const line = document.createElement("p");
          line.className = "field-note" + (warn ? " warn" : "");
          line.textContent = text;
          notes.push(line);
        };
        const limits = environmentLimits(environmentId);
        if (limits) {
          add("Environment guardrails per student: " + number(limits.rpm_limit) + " requests/min, " + number(limits.tpm_limit) + " tokens/min, " + number(limits.concurrency_limit) + " concurrent, " + number(limits.max_request_bytes) + " bytes per request. Students get the lower of the class value and the guardrail.");
          for (const name of ["rpm_limit", "tpm_limit", "concurrency_limit"]) {
            const value = readLimitValue(container, name);
            if (value !== null && value > limits[name]) add(LIMIT_NAMES[name] + " " + number(value) + " is above the environment guardrail of " + number(limits[name]) + ", so students get " + number(limits[name]) + ".", true);
          }
        } else {
          add("Environment guardrails are unavailable; the gateway still applies the lower of the environment and class limits.");
        }
        const total = readLimitValue(container, "budget_microcents");
        const each = readLimitValue(container, "group_budget_microcents");
        if (studentCount > 0 && total !== null && each !== null && BigInt(each) * BigInt(studentCount) > BigInt(total)) {
          add(number(studentCount) + " students × " + money(each) + " = " + money(BigInt(each) * BigInt(studentCount)) + ", more than the class total of " + money(total) + ". The class total is shared, so it can run out before every student has used their allocation.", true);
        }
        target.replaceChildren(...notes);
      }
      function createStudentNames() {
        return document.getElementById("class-create-students").value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
      }
      function renderCreateLimits() {
        const container = document.getElementById("class-create-fields");
        const environment = container.querySelector('[name="environment_id"]');
        renderLimitNotes("class-create-limits", container, environment ? environment.value : "", createStudentNames().length);
      }
      function renderEditLimits() {
        const row = classState.classes.find((item) => item.id === classState.selected);
        if (!row) return;
        const groups = (classState.detail && classState.detail.groups) || [];
        renderLimitNotes("class-edit-limits", document.getElementById("class-edit-fields"), row.environment_id, groups.filter((group) => group.status !== "revoked").length);
      }
      // Defaults stay generous but never exceed the chosen environment's guardrails. A
      // value the teacher has typed is left alone.
      function applyCreateLimitDefaults() {
        const container = document.getElementById("class-create-fields");
        const environment = container.querySelector('[name="environment_id"]');
        const limits = environmentLimits(environment ? environment.value : "");
        for (const name of ["rpm_limit", "tpm_limit", "concurrency_limit"]) {
          const input = container.querySelector('[name="' + name + '"]');
          if (!input || input.dataset.touched) continue;
          input.value = String(limits ? Math.min(CLASS_LIMIT_DEFAULTS[name], limits[name]) : CLASS_LIMIT_DEFAULTS[name]);
        }
      }

      // ---- Suggested tenant ID: class-<slug>-<yyyymmdd>, always a valid identifier ----
      function slugify(text, limit) {
        return String(text || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, limit).replace(/-+$/g, "");
      }
      function suggestedTenant(container) {
        const name = container.querySelector('[name="name"]');
        const starts = container.querySelector('[name="starts_at"]');
        const day = starts && /^\d{4}-\d{2}-\d{2}/.test(starts.value) ? starts.value.slice(0, 10) : localDateTime(Math.floor(Date.now() / 1000)).slice(0, 10);
        const slug = slugify(name ? name.value : "", 60);
        return "class-" + (slug ? slug + "-" : "") + day.replace(/-/g, "");
      }
      function createDefaults() {
        const start = Math.floor(Date.now() / 60000) * 60;
        return {
          timezone: defaultTimeZone,
          starts_at: start,
          expires_at: start + 3 * 3600,
          budget_microcents: 2000000000,
          group_budget_microcents: 100000000,
          daily_budget_microcents: null,
          ...CLASS_LIMIT_DEFAULTS,
        };
      }
      // keepStudents leaves the roster in place when it has not been used yet, so a
      // failure after the class was created never loses the teacher's list.
      function resetCreateForm(keepStudents) {
        const container = document.getElementById("class-create-fields");
        renderFieldSet(container, CLASS_CREATE_FIELDS, createDefaults());
        const tenant = container.querySelector('[name="tenant_id"]');
        tenant.value = suggestedTenant(container);
        if (!keepStudents) document.getElementById("class-create-students").value = "";
      }
      // The whole create → students → keys flow runs once at a time: a second click
      // must not create a second, keyless copy of the class.
      let creatingClass = false;
      function setCreateBusy(busy) {
        creatingClass = busy;
        for (const control of document.getElementById("class-create-form").querySelectorAll("input, select, textarea, button")) control.disabled = busy;
      }
      // A new class must be open before its students' keys are issued, otherwise the
      // kit would land in a hidden panel. One retry covers a transient list failure.
      async function openCreatedClass(id) {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          await loadClasses();
          if (classState.classes.some((row) => row.id === id)) {
            await selectClass(id);
            if (classState.selected === id && !document.getElementById("class-detail").hidden) return true;
          }
        }
        return false;
      }
      document.getElementById("class-create-fields").addEventListener("input", (event) => {
        const container = document.getElementById("class-create-fields");
        const name = event.target && event.target.name;
        if (name === "tenant_id" || name === "rpm_limit" || name === "tpm_limit" || name === "concurrency_limit") event.target.dataset.touched = "true";
        const tenant = container.querySelector('[name="tenant_id"]');
        if ((name === "name" || name === "starts_at") && tenant && !tenant.dataset.touched) tenant.value = suggestedTenant(container);
        renderCreateLimits();
      });
      document.getElementById("class-create-students").addEventListener("input", renderCreateLimits);
      document.getElementById("class-edit-fields").addEventListener("input", renderEditLimits);

      // ---- In-page confirmation bars (no blocking dialogs for bulk actions) ----
      // Each bar remembers the control that opened it so focus returns there afterwards.
      const confirmActions = new Map();
      function askInline(barId, message, action, trigger) {
        const bar = document.getElementById(barId);
        bar.querySelector("p").textContent = message;
        confirmActions.set(barId, { action, trigger: trigger || null });
        bar.hidden = false;
        bar.querySelector('[data-confirm="yes"]').focus();
      }
      function dismissInline(barId, restoreFocus) {
        const pending = confirmActions.get(barId);
        confirmActions.delete(barId);
        document.getElementById(barId).hidden = true;
        if (restoreFocus && pending && pending.trigger && pending.trigger.isConnected) pending.trigger.focus();
      }
      for (const bar of document.querySelectorAll(".confirm-bar")) {
        bar.querySelector('[data-confirm="yes"]').addEventListener("click", () => {
          const pending = confirmActions.get(bar.id);
          dismissInline(bar.id, true);
          return pending ? pending.action() : undefined;
        });
        bar.querySelector('[data-confirm="no"]').addEventListener("click", () => dismissInline(bar.id, true));
      }

      // ---- Student cards and the class kit ----
      // Allowed models are the class policy narrowed by any group override.
      function studentModels(classRow, group) {
        const policy = classRow && Array.isArray(classRow.capabilities) ? classRow.capabilities : [];
        if (group && Array.isArray(group.capabilities) && group.capabilities.length) return policy.filter((alias) => group.capabilities.includes(alias));
        return policy.slice();
      }
      function cardEntry(classRow, group, key, name) {
        const ends = [classRow && classRow.expires_at, group && group.expires_at, key && key.expires_at].filter((value) => typeof value === "number");
        return {
          name: name || (group ? group.name : "Student"),
          className: classRow ? classRow.name : "",
          timeZone: classRow ? classRow.timezone : "UTC",
          apiKey: key.api_key,
          hint: key.key_hint || null,
          groupId: group ? group.id : key.group_id,
          environmentId: classRow ? classRow.environment_id : "",
          models: studentModels(classRow, group),
          endsAt: ends.length ? Math.min(...ends) : null,
        };
      }
      // classes/options reports each alias's endpoints. The example prefers an alias
      // with Chat Completions and falls back to the Responses API when the student's
      // aliases only support that; an older control plane without endpoint data is
      // treated as chat.
      function aliasEndpoints(environmentId, alias) {
        const option = classOptions && Array.isArray(classOptions.environments) ? classOptions.environments.find((item) => item.environment_id === environmentId) : null;
        const entry = option && Array.isArray(option.alias_endpoints) ? option.alias_endpoints.find((item) => item.alias === alias) : null;
        return entry && Array.isArray(entry.endpoints) ? entry.endpoints : null;
      }
      function snippetChoice(models, environmentId) {
        const chat = models.find((alias) => {
          const endpoints = aliasEndpoints(environmentId, alias);
          return endpoints ? endpoints.includes("chat") : alias.includes("chat");
        });
        if (chat) return { model: chat, endpoint: "chat" };
        const responses = models.find((alias) => (aliasEndpoints(environmentId, alias) || []).includes("responses"));
        if (responses) return { model: responses, endpoint: "responses" };
        return { model: models[0] || "text.chat.v1", endpoint: "chat" };
      }
      function pythonSnippet(base, key, choice) {
        const call = choice.endpoint === "responses"
          ? ["reply = client.responses.create(", "    model=\"" + choice.model + "\",", "    input=\"Hello!\",", ")", "print(reply.output_text)"]
          : ["reply = client.chat.completions.create(", "    model=\"" + choice.model + "\",", "    messages=[{\"role\": \"user\", \"content\": \"Hello!\"}],", ")", "print(reply.choices[0].message.content)"];
        return ["from openai import OpenAI", "", "client = OpenAI(base_url=\"" + base + "\", api_key=\"" + key + "\")"].concat(call).join("\n");
      }
      function curlSnippet(base, key, choice) {
        const responses = choice.endpoint === "responses";
        return [
          "curl " + base + (responses ? "/responses" : "/chat/completions") + " \\",
          "  -H \"Authorization: Bearer " + key + "\" \\",
          "  -H \"Content-Type: application/json\" \\",
          responses
            ? "  -d '{\"model\": \"" + choice.model + "\", \"input\": \"Hello!\"}'"
            : "  -d '{\"model\": \"" + choice.model + "\", \"messages\": [{\"role\": \"user\", \"content\": \"Hello!\"}]}'",
        ].join("\n");
      }
      // Built from elements and text nodes only; nothing here is parsed as HTML.
      function studentCard(entry) {
        const base = gatewayBase();
        const card = document.createElement("article");
        card.className = "student-card";
        const heading = document.createElement("h3");
        heading.textContent = entry.name;
        const classLine = document.createElement("p");
        classLine.className = "card-class";
        classLine.textContent = entry.className;
        const list = document.createElement("dl");
        const row = (label, value, missing) => {
          const term = document.createElement("dt");
          term.textContent = label;
          const detail = document.createElement("dd");
          detail.textContent = value;
          if (missing) detail.className = "missing";
          list.append(term, detail);
        };
        row("Base URL", base, !gatewayConfig.public_url);
        row("API key", entry.apiKey);
        row("Models", entry.models.join(", ") || "none approved");
        row("Works until", entry.endsAt ? zonedTime(entry.endsAt, entry.timeZone) : "—");
        const choice = snippetChoice(entry.models, entry.environmentId);
        const pythonTitle = document.createElement("h4");
        pythonTitle.textContent = "Python (pip install openai)";
        const python = document.createElement("pre");
        python.textContent = pythonSnippet(base, entry.apiKey, choice);
        const curlTitle = document.createElement("h4");
        curlTitle.textContent = "curl";
        const curl = document.createElement("pre");
        curl.textContent = curlSnippet(base, entry.apiKey, choice);
        const foot = document.createElement("p");
        foot.className = "card-foot";
        foot.textContent = "Use a model name from the list above (GET " + base + "/models lists them). Chat Completions is at " + base + "/chat/completions and the Responses API at " + base + "/responses; each model works with the endpoints it is enabled for. Keep this key private.";
        card.append(heading, classLine, list, pythonTitle, python, curlTitle, curl, foot);
        return card;
      }
      function gatewayWarning() {
        if (gatewayConfig.public_url) return "";
        if (gatewayConfig.status === "invalid") return "GATEWAY_PUBLIC_URL is set but is not a bare https origin, so student cards show " + GATEWAY_MISSING + ". Set it to the gateway origin, for example https://gateway.example.com, and redeploy the control plane.";
        return "The gateway's public address is not configured, so student cards show " + GATEWAY_MISSING + ". Set GATEWAY_PUBLIC_URL on the control plane to the gateway's https origin and redeploy.";
      }
      function renderGatewayNote() {
        const note = document.getElementById("gateway-note");
        note.textContent = gatewayWarning();
        note.hidden = !note.textContent;
      }
      function showKit(result, classRow, groups) {
        const byId = new Map((groups || []).map((group) => [group.id, group]));
        kitState.classId = classRow ? classRow.id : null;
        kitState.className = classRow ? classRow.name : "";
        kitState.entries = (result.keys || []).map((key) => cardEntry(classRow, byId.get(key.group_id), key, key.group_name));
        kitState.skipped = Array.isArray(result.skipped) ? result.skipped : [];
        set("class-kit-heading", "Class kit: " + kitState.className);
        const gatewayNote = document.getElementById("class-kit-gateway");
        gatewayNote.textContent = gatewayWarning();
        gatewayNote.hidden = !gatewayNote.textContent;
        const summary = ["Issued " + number(kitState.entries.length) + " key" + (kitState.entries.length === 1 ? "" : "s") + " for " + kitState.className + "."];
        if (kitState.skipped.length) summary.push(number(kitState.skipped.length) + " skipped (see below).");
        if (result.truncated) summary.push("Only the first 100 groups were included; issue again with the remaining groups.");
        setStatus("class-kit-summary", summary.join(" "), kitState.entries.length ? "ok" : "error");
        renderTable("class-kit-keys", [
          { label: "Student", value: "name", bounded: true },
          { label: "API key", value: "apiKey", secret: true },
          { label: "Ends in", value: (row) => row.hint ? "…" + row.hint : "—" },
          { label: "Models", value: (row) => row.models.join(", ") || "—" },
          { label: "Actions", buttons: (row) => [{ label: "Copy", onClick: () => copyToClipboard(row.apiKey, "class-kit-status", "Copied the key for " + row.name + ".") }] },
        ], kitState.entries);
        renderTable("class-kit-skipped", [
          { label: "Group", value: (row) => row.group_name || row.group_id },
          { label: "Reason", value: "reason" },
        ], kitState.skipped);
        document.getElementById("class-kit-skipped-block").hidden = !kitState.skipped.length;
        document.getElementById("class-kit-preview").replaceChildren(...(kitState.entries.length ? [studentCard(kitState.entries[0])] : []));
        document.getElementById("print-cards").replaceChildren(...kitState.entries.map(studentCard));
        document.body.classList.toggle("print-kit", kitState.entries.length > 0);
        setStatus("class-kit-status", "", "");
        const panel = document.getElementById("class-kit");
        panel.hidden = false;
        panel.scrollIntoView({ block: "start" });
        // The triggering button is disabled while keys are issued, so move
        // keyboard and screen-reader focus to the keys that were just shown.
        panel.focus({ preventScroll: true });
      }
      function clearKit() {
        kitState.classId = null;
        kitState.className = "";
        kitState.entries = [];
        kitState.skipped = [];
        document.getElementById("class-kit").hidden = true;
        document.getElementById("class-kit-keys").replaceChildren();
        document.getElementById("class-kit-skipped").replaceChildren();
        document.getElementById("class-kit-preview").replaceChildren();
        document.getElementById("print-cards").replaceChildren();
        document.body.classList.remove("print-kit");
        setStatus("class-kit-status", "", "");
        setStatus("class-kit-summary", "", "");
      }
      function kitCsv() {
        const rows = [["name", "key", "base_url", "models"]].concat(kitState.entries.map((entry) => [entry.name, entry.apiKey, gatewayBase(), entry.models.join(" ")]));
        return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
      }
      async function copyToClipboard(value, statusId, message) {
        try {
          await navigator.clipboard.writeText(value);
          setStatus(statusId, message, "ok");
        } catch {
          setStatus(statusId, "Copy failed; select the value and copy it manually.", "error");
        }
      }
      function downloadText(filename, text, type) {
        const blob = new Blob([text], { type });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
      // Issues one new key per group through groups/access-bulk and shows the kit. With no
      // group IDs the server picks every active, unpaused group (first 100 by name).
      async function issueKit(classId, groupIds, statusId) {
        if (credentialPending) return false;
        let issued = false;
        const className = () => {
          const row = classState.classes.find((item) => item.id === classId);
          return row ? row.name : classId;
        };
        await runCredentialAction(async () => {
          clearSecret();
          clearKit();
          setStatus(statusId, "Issuing keys for " + className() + "…", "");
          try {
            const result = await dashboardPost("groups/access-bulk", groupIds ? { class_id: classId, group_ids: groupIds } : { class_id: classId });
            await loadGroups();
            const classRow = classState.classes.find((row) => row.id === classId);
            // Keys exist now whatever the operator did meanwhile, so the kit is always shown,
            // headed with its own class name, and the status names that class too.
            showKit(result, classRow || { id: classId, name: classId, capabilities: [], timezone: "UTC" }, classState.selected === classId && classState.detail ? classState.detail.groups : []);
            issued = true;
            setStatus(statusId, "Issued " + number((result.keys || []).length) + " student key(s) for " + className() + ((result.skipped || []).length ? "; " + number(result.skipped.length) + " skipped." : ".") + " Copy, download or print them now.", "ok");
          } catch (error) {
            setStatus(statusId, "Keys for " + className() + " were not issued: " + messageFor(error), "error");
          }
        });
        return issued;
      }
      async function setGroupPaused(row, paused) {
        const classId = classState.selected;
        await runClassAction("group-status", async () => {
          await dashboardPost("groups/update", { id: row.id, paused });
          await loadGroups();
          return paused ? "Paused " + row.name + ": their keys and devices are refused until resumed. Allocation and usage are kept." : "Resumed " + row.name + ".";
        }, classId);
      }
      async function issueGroupAccess(groupId, kind) {
        if (credentialPending) return;
        const classId = classState.selected;
        const label = kind === "api_key" ? "API key" : "join code";
        const context = groupContext(groupId);
        if (!window.confirm("Issue a new " + label + " for " + context + "? It is shown once and cannot be retrieved later.")) return;
        await runCredentialAction(async () => {
          clearSecret();
          await runClassAction("group-status", async () => {
            const result = await dashboardPost("groups/access", { group_id: groupId, kind });
            showSecret(result, context, groupId);
            await loadGroups();
            return "Issued " + label + " for " + context + ".";
          }, classId);
        });
      }
      async function rotateKey(id) {
        if (credentialPending) return;
        const classId = classState.selected;
        const key = classState.detail?.keys?.find((row) => row.id === id);
        const context = groupContext(key?.group_id || id);
        if (!window.confirm("Rotate the API key for " + context + "? The old key is invalidated immediately; the group and its spend are unchanged.")) return;
        await runCredentialAction(async () => {
          clearSecret();
          await runClassAction("group-status", async () => {
            const result = await dashboardPost("groups/rotate", { id });
            showSecret(result, context, key?.group_id);
            await loadGroups();
            return "Rotated the API key for " + context + ". The group and its spend are unchanged.";
          }, classId);
        });
      }
      async function revokeKey(id) {
        if (!window.confirm("Revoke this API key? This cannot be undone.")) return;
        const classId = classState.selected;
        await runClassAction("group-status", async () => {
          await dashboardPost("groups/revoke-key", { id });
          await loadGroups();
          return "API key revoked.";
        }, classId);
      }
      async function revokeCode(id) {
        if (!window.confirm("Revoke this join code? Devices already activated lose access on their next gateway request.")) return;
        const classId = classState.selected;
        await runClassAction("group-status", async () => {
          await dashboardPost("revoke", { resource_type: "access_code", resource_id: id });
          await loadGroups();
          return "Join code disabled.";
        }, classId);
      }
      async function revokeGroup(row) {
        if (!window.confirm("Revoke group " + row.name + "? Revocation is terminal and applies on the next gateway request.")) return;
        const classId = classState.selected;
        await runClassAction("group-status", async () => {
          await dashboardPost("groups/update", { id: row.id, status: "revoked" });
          await loadGroups();
          return "Group revoked.";
        }, classId);
      }
      function openGroupEditor(row) {
        classState.groupEditing = row.id;
        // A new editor session invalidates any in-flight save for the previous draft,
        // even when it targets the same group.
        classState.groupEditorRevision += 1;
        renderFieldSet(document.getElementById("group-edit-fields"), GROUP_FIELDS, row);
        renderGroupAliases(row);
        document.getElementById("group-edit-panel").hidden = false;
        set("group-edit-heading", "Adjust group: " + row.name);
        setStatus("group-edit-status", "", "");
      }
      // Editing the open editor is a new draft too, so a held save for the same group
      // cannot close the panel over newer field changes.
      document.getElementById("group-edit-form").addEventListener("input", () => {
        classState.groupEditorRevision += 1;
      });

      resetCreateForm();
      set("class-create-schedule-note", scheduleNote);
      set("class-edit-schedule-note", scheduleNote);
      set("group-edit-schedule-note", scheduleNote);
      set("class-create-alias-note", "Loading approved aliases…");
      set("class-edit-alias-note", "Loading approved aliases…");
      document.getElementById("class-create-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const container = document.getElementById("class-create-fields");
        const moneyProblem = dollarProblem(container);
        if (moneyProblem) { setStatus("class-create-status", moneyProblem, "error"); return; }
        const payload = readFieldSet(container);
        payload.capabilities = readAliases(document.getElementById("class-create-aliases"));
        const problem = validateClassPayload(payload);
        if (problem) { setStatus("class-create-status", problem, "error"); return; }
        if (!payload.tenant_id || !String(payload.tenant_id).trim()) { setStatus("class-create-status", "A classroom / tenant ID is required.", "error"); return; }
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{1,99}$/.test(payload.tenant_id)) { setStatus("class-create-status", "The tenant ID must be 2–100 letters, digits, dots, colons, hyphens or underscores, starting with a letter or digit.", "error"); return; }
        if (!payload.product_id || !payload.environment_id) { setStatus("class-create-status", "Choose a product and environment.", "error"); return; }
        if (!payload.course) delete payload.course;
        if (!payload.instructors || !payload.instructors.length) delete payload.instructors;
        // Students are checked before anything is written, so a bad roster never leaves a
        // half-made class behind.
        const students = createStudentNames();
        if (students.length > 100) { setStatus("class-create-status", "At most 100 students per class form; add the rest from the class afterwards.", "error"); return; }
        const tooLong = students.find((name) => name.length > 200);
        if (tooLong) { setStatus("class-create-status", "Student names can be at most 200 characters.", "error"); return; }
        const seen = new Set();
        const duplicate = students.find((name) => { const key = name.toLowerCase(); if (seen.has(key)) return true; seen.add(key); return false; });
        if (duplicate) { setStatus("class-create-status", "\"" + duplicate + "\" is listed twice; each student needs a distinct name.", "error"); return; }
        if (creatingClass) return;
        const className = String(payload.name).trim();
        setCreateBusy(true);
        let resetMode = "none";
        try {
          setStatus("class-create-status", "Creating " + className + "…", "");
          let createdId = null;
          try {
            const result = await dashboardPost("classes", payload);
            createdId = result && result.id ? result.id : null;
          } catch (error) {
            setStatus("class-create-status", messageFor(error), "error");
            return;
          }
          // From here the class exists: the class fields are reset so a resubmit cannot
          // create a duplicate, while an unused roster stays in its box.
          resetMode = "keep-students";
          const opened = createdId ? await openCreatedClass(createdId) : false;
          if (!students.length) {
            resetMode = "all";
            setStatus("class-create-status", opened ? "Created " + className + "." : "Created " + className + ", but the class list could not be reloaded. Select Refresh, then open it.", opened ? "ok" : "error");
            return;
          }
          let groupIds = [];
          try {
            const groups = await dashboardPost("groups", { class_id: createdId, names: students });
            groupIds = groups && Array.isArray(groups.groups) ? groups.groups.map((group) => group.id) : [];
          } catch (error) {
            setStatus("class-create-status", "Created " + className + ", but adding students failed: " + messageFor(error) + " Your student list is still in the Students box; open the class and add it under Groups.", "error");
            return;
          }
          resetMode = "all";
          if (!opened) {
            setStatus("class-create-status", "Created " + className + " with " + number(groupIds.length) + " students, but the class could not be opened, so no keys were issued. Select Refresh, open " + className + " and use Issue keys for all students.", "error");
            return;
          }
          await loadGroups();
          setStatus("class-create-status", "Created " + className + " with " + number(groupIds.length) + " students. Issuing their keys…", "");
          const issued = groupIds.length ? await issueKit(createdId, groupIds, "class-action-status") : false;
          setStatus("class-create-status", issued ? "Created " + className + " with " + number(groupIds.length) + " students; their keys are in the class kit for " + className + " below." : "Created " + className + " with " + number(groupIds.length) + " students, but keys were not issued. Open " + className + " and use Issue keys for all students.", issued ? "ok" : "error");
        } finally {
          // A failed first write keeps every field, including the chosen aliases.
          if (resetMode !== "none") {
            resetCreateForm(resetMode === "keep-students");
            refreshAliasEditors();
          }
          setCreateBusy(false);
        }
      });
      document.getElementById("class-edit-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const targetId = classState.selected;
        if (!targetId) return;
        const moneyProblem = dollarProblem(document.getElementById("class-edit-fields"));
        if (moneyProblem) { setStatus("class-edit-status", moneyProblem, "error"); return; }
        const payload = readFieldSet(document.getElementById("class-edit-fields"));
        payload.capabilities = readAliases(document.getElementById("class-edit-aliases"));
        const problem = validateClassPayload(payload);
        if (problem) { setStatus("class-edit-status", problem, "error"); return; }
        payload.id = targetId;
        await runClassAction("class-edit-status", async () => {
          await dashboardPost("classes/update", payload);
          await loadClasses();
          await loadUsage();
          if (classState.selected !== targetId) return null;
          const row = classState.classes.find((item) => item.id === targetId);
          if (row) { set("class-detail-heading", row.name); set("class-detail-meta", classMeta(row)); updatePauseButton(row); }
          return "Class updated. Changes are checked on every gateway request.";
        }, targetId);
      });
      document.getElementById("class-pause").addEventListener("click", async () => {
        const targetId = classState.selected;
        const row = classState.classes.find((item) => item.id === targetId);
        if (!row || row.status === "revoked") return;
        const next = row.status === "paused" ? "active" : "paused";
        if (!window.confirm(next === "paused" ? "Pause this class? Live requests are checked on every gateway call." : "Resume this class?")) return;
        await runClassAction("class-action-status", async () => {
          await dashboardPost("classes/update", { id: targetId, status: next });
          await loadClasses();
          if (classState.selected !== targetId) return null;
          const updated = classState.classes.find((item) => item.id === targetId);
          if (updated) { set("class-detail-heading", updated.name); set("class-detail-meta", classMeta(updated)); updatePauseButton(updated); }
          return next === "paused" ? "Class paused. Existing grants are checked on every request." : "Class resumed.";
        }, targetId);
      });
      document.getElementById("class-duplicate").addEventListener("click", () => {
        const row = classState.classes.find((item) => item.id === classState.selected);
        if (!row) return;
        renderFieldSet(document.getElementById("class-duplicate-fields"), DUPLICATE_FIELDS, duplicateDefaults(row));
        set("class-duplicate-note", "Copies policy and group names into a new class with the window below. Keys and spend are not copied, and the source class keeps its own schedule.");
        setStatus("class-duplicate-status", "", "");
        const panel = document.getElementById("class-duplicate-panel");
        panel.hidden = false;
        panel.scrollIntoView({ block: "start" });
      });
      document.getElementById("class-duplicate-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const targetId = classState.selected;
        if (!targetId) return;
        const payload = readFieldSet(document.getElementById("class-duplicate-fields"));
        if (!payload.name || !String(payload.name).trim()) { setStatus("class-duplicate-status", "A name for the new class is required.", "error"); return; }
        if (!payload.starts_at || !payload.expires_at) { setStatus("class-duplicate-status", "A start and end for the new class are required.", "error"); return; }
        if (payload.expires_at <= payload.starts_at) { setStatus("class-duplicate-status", "The end time must be after the start time.", "error"); return; }
        const request = { id: targetId, name: payload.name, starts_at: payload.starts_at, expires_at: payload.expires_at };
        await runClassAction("class-duplicate-status", async () => {
          const result = await dashboardPost("classes/duplicate", request);
          await loadClasses();
          // Stale completion: the operator left the source class, so nothing is reported.
          if (classState.selected !== targetId || !result || !result.id) return null;
          const newId = result.id;
          await selectClass(newId);
          // Opening the copy hides the source class's duplicate panel, so the confirmation
          // belongs in the visible class status. Write it only while the copy is still the
          // selected class: a switch during the load must win, never receive this message.
          if (classState.selected === newId) {
            setStatus("class-action-status", "Duplicated policy and group names into the new window; no keys or spend were copied.", "ok");
          }
          return null;
        }, targetId);
      });
      document.getElementById("class-detail-refresh").addEventListener("click", async () => {
        const targetId = classState.selected;
        await Promise.all([loadGroups(), loadUsage()]);
        if (classState.selected !== targetId) return;
        setStatus("class-action-status", "Reloaded groups and usage.", "ok");
      });
      document.getElementById("group-create-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const classId = classState.selected;
        if (!classId) return;
        const textarea = document.getElementById("group-names");
        const submitted = textarea.value;
        const names = submitted.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
        if (!names.length) { setStatus("group-status", "Enter at least one group name.", "error"); return; }
        if (names.length > 100) { setStatus("group-status", "At most 100 groups per request.", "error"); return; }
        // The draft belongs to this class and this exact text: a newer draft typed for
        // another class must survive an older completion.
        const owns = () => classState.selected === classId && document.getElementById("group-names").value === submitted;
        await runOwnedAction("group-status", owns, async () => {
          const result = await dashboardPost("groups", { class_id: classId, names });
          await Promise.all([loadGroups(), loadUsage()]);
          return "Created " + number((result && result.groups ? result.groups.length : names.length)) + " group(s).";
        }, () => { document.getElementById("group-names").value = ""; });
      });
      document.getElementById("group-edit-form").addEventListener("submit", async (event) => {
        event.preventDefault();
        const owner = {
          classId: classState.selected,
          groupId: classState.groupEditing,
          revision: classState.groupEditorRevision,
        };
        if (!owner.classId || !owner.groupId) return;
        const moneyProblem = dollarProblem(document.getElementById("group-edit-fields"));
        if (moneyProblem) { setStatus("group-edit-status", moneyProblem, "error"); return; }
        const payload = readFieldSet(document.getElementById("group-edit-fields"));
        payload.capabilities = readAliases(document.getElementById("group-edit-aliases"));
        if (Array.isArray(payload.capabilities) && !payload.capabilities.length) payload.capabilities = null;
        if (payload.budget_microcents === null || !Number.isFinite(payload.budget_microcents)) { setStatus("group-edit-status", "A group budget is required.", "error"); return; }
        if (payload.starts_at && payload.expires_at && payload.expires_at <= payload.starts_at) { setStatus("group-edit-status", "The end time must be after the start time.", "error"); return; }
        payload.id = owner.groupId;
        // Cleanup is owned by the editor session that submitted: another group, a reopened
        // draft, or another class must not be hidden or cleared by an older completion.
        const owns = () => groupEditorOwnedBy(owner);
        await runOwnedAction("group-edit-status", owns, async () => {
          await dashboardPost("groups/update", payload);
          await Promise.all([loadGroups(), loadUsage()]);
          return "Group updated.";
        }, () => {
          document.getElementById("group-edit-panel").hidden = true;
          classState.groupEditing = null;
        }, () => {
          const stillThisEditor =
            classState.selected === owner.classId &&
            classState.groupEditing === owner.groupId;
          if (stillThisEditor && !document.getElementById("group-edit-panel").hidden) {
            setStatus("group-edit-status", "Saved the earlier version; your newer edits are not saved yet.", "ok");
          }
        });
      });
      document.getElementById("class-secret-copy").addEventListener("click", async () => {
        const value = document.getElementById("class-secret-value").textContent;
        if (!value) return;
        try {
          await navigator.clipboard.writeText(value);
          setStatus("class-secret-status", "Copied to the clipboard. Paste it into your tool now.", "ok");
        } catch {
          setStatus("class-secret-status", "Copy failed; select the value and copy it manually.", "error");
        }
      });
      document.getElementById("class-secret-download").addEventListener("click", () => {
        const value = document.getElementById("class-secret-value").textContent;
        if (!value) return;
        downloadText("tkslopper-group-credential.txt", value + "\n", "text/plain");
        setStatus("class-secret-status", "Downloaded. Store it securely; it cannot be retrieved again.", "ok");
      });
      document.getElementById("class-issue-all").addEventListener("click", () => {
        const classId = classState.selected;
        const row = classState.classes.find((item) => item.id === classId);
        if (!row || credentialPending) return;
        const groups = (classState.detail && classState.detail.groups) || [];
        const eligible = groups.filter((group) => group.status === "active" && !group.paused).length;
        if (!eligible) { setStatus("class-action-status", "There are no active, unpaused students to issue keys for. Add students under Groups first.", "error"); return; }
        const paused = groups.filter((group) => group.status === "active" && group.paused).length;
        const visibleKit = kitState.entries.length ? " The " + number(kitState.entries.length) + " keys currently shown in the class kit will be cleared from the screen, so copy, download or print them first." : "";
        askInline("class-issue-confirm", "Issue a new API key for each of the " + number(Math.min(eligible, 100)) + " active, unpaused students in " + row.name + "?" + (paused ? " " + number(paused) + " paused student(s) are left out." : "") + " Existing keys keep working. The new keys are shown once, here." + visibleKit, () => {
          if (classState.selected !== classId) return undefined;
          return issueKit(classId, null, "class-action-status");
        }, document.getElementById("class-issue-all"));
      });
      document.getElementById("class-kit-copy").addEventListener("click", () => {
        if (!kitState.entries.length) return;
        return copyToClipboard(kitCsv(), "class-kit-status", "Copied " + number(kitState.entries.length) + " rows as CSV (name, key, base_url, models).");
      });
      document.getElementById("class-kit-download").addEventListener("click", () => {
        if (!kitState.entries.length) return;
        downloadText("tkslopper-" + (slugify(kitState.className, 60) || "class") + "-student-keys.csv", kitCsv(), "text/csv");
        setStatus("class-kit-status", "Downloaded the CSV. Store it securely and delete it after class; the keys cannot be retrieved again.", "ok");
      });
      document.getElementById("class-kit-print").addEventListener("click", () => {
        if (!kitState.entries.length) return;
        setStatus("class-kit-status", "Printing " + number(kitState.entries.length) + " student cards. Only the cards are printed.", "ok");
        window.print();
      });
      document.getElementById("class-kit-clear").addEventListener("click", clearKit);
      window.addEventListener("pagehide", clearKit);

      document.getElementById("group-budget-form").addEventListener("submit", (event) => {
        event.preventDefault();
        const classId = classState.selected;
        const row = classState.classes.find((item) => item.id === classId);
        if (!row) return;
        const form = event.target;
        const mode = form.elements.mode.value === "set" ? "set" : "add";
        const amount = parseDollars(form.elements.budget.value);
        if (amount.error || amount.empty) { setStatus("group-budget-status", "Amount per student " + (amount.error || "is required") + ".", "error"); return; }
        const total = parseDollars(form.elements.class_budget.value);
        if (total.error) { setStatus("group-budget-status", "New class total " + total.error + ".", "error"); return; }
        const groups = ((classState.detail && classState.detail.groups) || []).filter((group) => group.status !== "revoked");
        if (!groups.length) { setStatus("group-budget-status", "There are no students to change yet.", "error"); return; }
        const request = { class_id: classId, mode, budget_microcents: amount.value };
        if (!total.empty) request.class_budget_microcents = total.value;
        const change = mode === "set" ? "Set every student's allocation to " + money(amount.value) : "Add " + money(amount.value) + " to every student's allocation";
        setStatus("group-budget-status", "", "");
        askInline("group-budget-confirm", change + " (" + number(groups.length) + " students in " + row.name + ")" + (total.empty ? "" : " and set the class total to " + money(total.value)) + "?", () => {
          if (classState.selected !== classId) return undefined;
          return runClassAction("group-budget-status", async () => {
            const result = await dashboardPost("groups/budget-bulk", request);
            form.reset();
            await Promise.all([loadClasses(), loadGroups(), loadUsage()]);
            const updated = Array.isArray(result.groups) ? result.groups : [];
            const sum = updated.reduce((acc, group) => acc + BigInt(group.budget_microcents), 0n);
            const classRow = classState.classes.find((item) => item.id === classId);
            if (classRow && classState.selected === classId) {
              // The class total may have changed: refresh the summary and the edit form so
              // a stale total cannot be saved back over it.
              set("class-detail-meta", classMeta(classRow));
              renderFieldSet(document.getElementById("class-edit-fields"), CLASS_FIELDS, classRow);
              renderEditLimits();
            }
            const classTotal = result.class_budget_microcents ?? (classRow ? classRow.budget_microcents : null);
            const parts = [(mode === "set" ? "Set " : "Topped up ") + number(updated.length) + " student allocation(s)" + (mode === "set" ? " to " + money(amount.value) : " by " + money(amount.value)) + "."];
            if (result.class_budget_microcents !== undefined) parts.push("Class total is now " + money(result.class_budget_microcents) + ".");
            if ((result.skipped || []).length) parts.push(number(result.skipped.length) + " skipped.");
            if (classTotal !== null && sum > BigInt(classTotal)) parts.push("Allocations now add up to " + money(sum) + ", more than the class total of " + money(classTotal) + "; the class total is reached first.");
            return parts.join(" ");
          }, classId);
        }, document.getElementById("group-budget-submit"));
      });
      document.getElementById("class-secret-clear").addEventListener("click", clearSecret);
      window.addEventListener("pagehide", clearSecret);

      async function loadDashboard() {
        refresh.disabled = true;
        document.body.classList.add("loading");
        clearResult();
        clearSecret();
        clearKit();
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
            gatewayConfig = session.gateway && typeof session.gateway === "object" ? session.gateway : { public_url: null, status: "unset" };
            renderGatewayNote();
            set("admin-identity", "Signed in as " + session.email);
            document.getElementById("admin-limit").hidden = !session.admins_truncated;
            renderTable("admin-members", [{ label: "Email", value: "email" }, { label: "Role", value: (row) => row.enabled ? "Admin" : "Viewer (revoked)", pill: true }], session.admins);
            renderTable("admin-audit", [{ label: "Time", value: "created_at", format: time }, { label: "Actor", value: (row) => row.actor_email || "API credential" }, { label: "Action", value: "action" }, { label: "Resource", value: (row) => row.resource_type + " / " + (row.target_email || row.resource_id) }], session.recent_actions);
            adminPanel.hidden = false;
            applyRole(true);
            if (firstClassLoad) { firstClassLoad = false; showView("classes"); }
            await loadClassOptions();
            await loadClasses();
            refreshAliasEditors();
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

/**
 * Self-contained helpers embedded into the inline script under fixed names, so
 * the page runs exactly the functions the unit tests exercise.
 */
export const DASHBOARD_EMBEDDED_HELPERS = [
  ["formatDollars", formatDollars],
  ["parseDollars", parseDollars],
  ["csvCell", csvCell],
]
  .map(([name, helper]) => `const ${String(name)} = (${String(helper)});`)
  .join("\n      ");

const DASHBOARD_PAGE_HTML = DASHBOARD_HTML.replace(
  "__DASHBOARD_HELPERS__",
  () => DASHBOARD_EMBEDDED_HELPERS,
);

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
  return new Response(DASHBOARD_PAGE_HTML.replaceAll("__CSP_NONCE__", nonce), {
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
