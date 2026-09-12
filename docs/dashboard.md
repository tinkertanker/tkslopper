# Operations dashboard

The control-plane Worker serves the operations dashboard at `/dashboard`. After Cloudflare Access login, the page automatically requests metadata from `GET /admin/v1/dashboard` and checks its role at `GET /dashboard/api/session`. Refresh uses the same login session; there is no dashboard token to copy or enter.

The Worker requires platform-verified `ctx.access`, its audience matching private `DASHBOARD_ACCESS_AUD`, and a human email identity. Caller-supplied identity headers, the old dashboard token, and the write-capable `ADMIN_TOKEN` cannot authorize dashboard reads. Access login alone grants no write privileges: named admin grants are checked separately on every browser write. The page stores neither credentials nor metadata in browser storage; Access manages its own session cookie. Sign out uses the same-origin Access logout endpoint.

## Named admins

The Administration section is visible only to enabled named admins. Select **Manage admins**, enter an email, choose **Grant admin** or **Remove admin**, then review and apply. All admins have full write permissions, including managing other admins. At least one admin must remain. Removing a grant takes effect on subsequent authorization checks; requests already authorized may finish. Email matching is trimmed and case-insensitive. Cloudflare's sign-in policy remains a separate gate: granting a role does not automatically admit a new email domain.

The section also supports classroom access-code and service-key issuance, revocation, kill switches, product/environment creation, aliases, and entitlements using the existing validated mutation handlers. Forms expose common settings; the existing API/CLI remains available for all supported parameters. One-time credentials appear only in the successful result, are not automatically re-fetched, and are cleared on refresh, operation change, explicit Clear result, or page exit. A failed connection can leave an uncertain write outcome: check activity before retrying; do not assume the operation failed.

Browser writes use `POST /dashboard/api/<operation>` with same-origin JSON and verified Access identity plus an enabled D1 role. They never receive the shared admin token. The corresponding `POST /admin/v1/<operation>` routes remain bearer-only for automation and recovery. Bootstrap the first admin through `POST /admin/v1/admins` with an admin bearer and JSON `{ "email": "operator@example.invalid", "enabled": true }`. No user becomes admin merely by being first to log in.

Role changes and their audit records commit in one D1 batch. Disabled role rows are retained so historical actions remain attributable. The admin-only session endpoint returns named members (first 100, with truncation disclosed) and the latest 25 actions with actor email; API/CLI actions have no individual identity. Viewer metadata continues to omit emails and actor hashes. Admin emails are stored as access-management data, not inference telemetry.

Apply additive migration `0003_dashboard_admins.sql` before deploying the new control Worker, then bootstrap the approved operator. It does not alter existing tables or the gateway-compatible schema marker; control readiness additionally requires the new table. Rollback to the preceding Worker leaves grants inert without deleting audit history. Removing named access never changes the legacy recovery credential.

## Included data

- at most 100 products and 250 environments per response, with prominent truncation warnings and separate visible product/environment enabled and kill-switch state;
- visible policy versions/limits and bounded minimum counts of active aliases/entitlements plus grants that satisfy the gateway's current entitlement, source, and parent-policy checks; cap-plus-one sentinels and a pre-join live-grant candidate cap keep work bounded, with `≥` and an explicit truncation warning when a count may be incomplete;
- counts and exact accounted token/microcent aggregates over at most the latest 10,000 finalized records from the last 24 hours, with an explicit truncation warning;
- the latest 50 metadata-only provider-attempt records, with product/environment, policy, route, provider, resolved model, endpoint, token/cost, and timing provenance visible in the browser;
- the oldest 50 overdue `attempt_started` intents from `stale_provider_attempts`, with complete route provenance, creation/stale times, and input/output/cost reservation ceilings visible in the browser, plus an explicit warning when more details exist;
- the latest 25 administrative action/resource records without actor hashes; access-code resource IDs are redacted because possession of an ID would enable targeted failed-activation writes.

The viewer metadata API and tables omit prompts, responses, raw tenant/principal identifiers, their stored pseudonymous hashes, credential material, capability payloads, and admin actor hashes. Admin operation results and admin-only identity/audit data are separate. Responses use `Cache-Control: no-store`; the page renders API values with text nodes rather than HTML.

## Deliberate limitation

Persisted attempt records begin only after quota admission, and an `attempt_started` intent is written before the physical provider call. The bounded 24-hour aggregates exclude those unfinished intents. Finalized failures can retain conservative token and cost estimates, so accounted values are not necessarily realized usage. Stale intents and their reservation ceilings are reported separately; their summary count is capped at 10,000, their detail list is capped at the oldest 50 records, and each cap has its own truncation warning.

Live per-principal RPM, TPM, concurrency, reservations, and daily spend remain inside non-enumerable Durable Object state. The first dashboard slice does not weaken that boundary or create an index of principals. It identifies that live quota data is unavailable. Provider billing remains authoritative for invoice reconciliation.

## Deployment boundary

Protect `/dashboard*` and `/admin/v1/dashboard` together in one Cloudflare Access application with named-operator allow policies and a short session. Both paths must share the same audience so the page's session also authorizes its data fetch. Set the application's audience tag as private `DASHBOARD_ACCESS_AUD`; absent configuration fails dashboard reads closed without affecting other APIs. Repeat both destinations for any alternate hostname. Add operators to this application's policy, not to a shared token. Existing bearer clients must migrate to Access login; the old dashboard secret is no longer read.

Local Wrangler uses its explicit `access.dev` identity with the `local-dashboard` audience. This simulation works only locally; production requires real platform-verified Access context. Never copy the simulated audience into private production configuration. See [ADR 0013](adr/0013-dashboard-access-login.md) for migration and rollback.

The `/dashboard*` Access destination also protects browser admin routes. Keep the metadata endpoint and these routes in the same application/audience. Never add an Access bypass to make browser writes work.
