# Operations dashboard

The control-plane Worker serves a read-only dashboard shell at `/dashboard`. The shell contains no deployment data. It requests current metadata from `GET /admin/v1/dashboard` only after an operator supplies the separate `DASHBOARD_TOKEN` bearer credential.

The browser clears the token field when submitting and retains the value only for the lifetime of the in-flight request. It is not placed in a URL, cookie, browser storage, source file, or D1. Refreshing the data or page requires re-authentication. The write-capable `ADMIN_TOKEN` is intentionally rejected, and the Worker fails configuration if the dashboard credential equals the admin token, signing secret, or credential pepper.

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

Create `DASHBOARD_TOKEN` as an independent high-entropy control-plane Worker secret. Do not reuse the admin token, signing secret, credential pepper, or a provider key. The Worker can enforce equality checks only for secrets bound to it; the deployment owner must compare private fingerprints against gateway provider secrets before provisioning. Restrict `/dashboard*` and `/admin/v1/dashboard` with Cloudflare Access or an equivalent operator-only ingress policy before exposing a deployed control Worker; the Worker-level bearer check remains defense in depth.

The dashboard has no mutation controls. Kill switches, revocation, provisioning, and credential issuance remain explicit audited admin API/CLI operations.
