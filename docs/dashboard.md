# Operations dashboard

The control-plane Worker serves a read-only dashboard at `/dashboard`. After Cloudflare Access login, the page automatically requests metadata from `GET /admin/v1/dashboard`. Refresh uses the same login session; there is no dashboard token to copy or enter.

The Worker requires platform-verified `ctx.access`, its audience matching private `DASHBOARD_ACCESS_AUD`, and a human email identity. Caller-supplied identity headers, the old dashboard token, and the write-capable `ADMIN_TOKEN` cannot authorize dashboard reads. Access login grants no write-admin privileges. The page stores neither credentials nor metadata in browser storage; Access manages its own session cookie. Sign out uses the same-origin Access logout endpoint.

## Included data

- at most 100 products and 250 environments per response, with prominent truncation warnings and separate visible product/environment enabled and kill-switch state;
- visible policy versions/limits and bounded minimum counts of active aliases/entitlements plus grants that satisfy the gateway's current entitlement, source, and parent-policy checks; cap-plus-one sentinels and a pre-join live-grant candidate cap keep work bounded, with `≥` and an explicit truncation warning when a count may be incomplete;
- counts and exact accounted token/microcent aggregates over at most the latest 10,000 finalized records from the last 24 hours, with an explicit truncation warning;
- the latest 50 metadata-only provider-attempt records, with product/environment, policy, route, provider, resolved model, endpoint, token/cost, and timing provenance visible in the browser;
- the oldest 50 overdue `attempt_started` intents from `stale_provider_attempts`, with complete route provenance, creation/stale times, and input/output/cost reservation ceilings visible in the browser, plus an explicit warning when more details exist;
- the latest 25 administrative action/resource records without actor hashes; access-code resource IDs are redacted because possession of an ID would enable targeted failed-activation writes.

The API and UI omit prompts, responses, raw tenant/principal identifiers, their stored pseudonymous hashes, credential material, capability payloads, and admin actor hashes. Responses use `Cache-Control: no-store`; the page renders API values with text nodes rather than HTML.

## Deliberate limitation

Persisted attempt records begin only after quota admission, and an `attempt_started` intent is written before the physical provider call. The bounded 24-hour aggregates exclude those unfinished intents. Finalized failures can retain conservative token and cost estimates, so accounted values are not necessarily realized usage. Stale intents and their reservation ceilings are reported separately; their summary count is capped at 10,000, their detail list is capped at the oldest 50 records, and each cap has its own truncation warning.

Live per-principal RPM, TPM, concurrency, reservations, and daily spend remain inside non-enumerable Durable Object state. The first dashboard slice does not weaken that boundary or create an index of principals. It identifies that live quota data is unavailable. Provider billing remains authoritative for invoice reconciliation.

## Deployment boundary

Protect `/dashboard*` and `/admin/v1/dashboard` together in one Cloudflare Access application with named-operator allow policies and a short session. Both paths must share the same audience so the page's session also authorizes its data fetch. Set the application's audience tag as private `DASHBOARD_ACCESS_AUD`; absent configuration fails dashboard reads closed without affecting other APIs. Repeat both destinations for any alternate hostname. Add operators to this application's policy, not to a shared token. Existing bearer clients must migrate to Access login; the old dashboard secret is no longer read.

Local Wrangler uses its explicit `access.dev` identity with the `local-dashboard` audience. This simulation works only locally; production requires real platform-verified Access context. Never copy the simulated audience into private production configuration. See [ADR 0013](adr/0013-dashboard-access-login.md) for migration and rollback.

The dashboard has no mutation controls. Kill switches, revocation, provisioning, and credential issuance remain explicit audited admin API/CLI operations.
