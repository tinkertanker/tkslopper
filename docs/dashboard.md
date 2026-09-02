# Operations dashboard

The control-plane Worker serves a read-only dashboard shell at `/dashboard`. The shell contains no deployment data. It requests current metadata from `GET /admin/v1/dashboard` only after an operator supplies the separate `DASHBOARD_TOKEN` bearer credential.

The browser clears the token field when submitting and retains the value only for the lifetime of the in-flight request. It is not placed in a URL, cookie, browser storage, source file, or D1. Refreshing the data or page requires re-authentication. The write-capable `ADMIN_TOKEN` is intentionally rejected, and the Worker fails configuration if both credentials are equal.

## Included data

- product and environment enabled/kill-switch state;
- policy limits and counts of active aliases, entitlements, and grants;
- 24-hour physical attempt and failure counts, with token and microcent aggregates represented as decimal strings to preserve 64-bit precision;
- the latest 50 metadata-only physical attempts;
- overdue `attempt_started` rows from `stale_provider_attempts`;
- the latest 25 administrative action/resource records without actor hashes.

The API and UI omit prompts, responses, raw tenant/principal identifiers, their stored pseudonymous hashes, credential material, capability payloads, and admin actor hashes. Responses use `Cache-Control: no-store`; the page renders API values with text nodes rather than HTML.

## Deliberate limitation

Live per-principal RPM, TPM, concurrency, reservations, and daily spend remain inside non-enumerable Durable Object state. The first dashboard slice does not weaken that boundary or create an index of principals. It shows persisted D1 attempt accounting and identifies that live quota data is unavailable. Provider billing remains authoritative for invoice reconciliation.

## Deployment boundary

Create `DASHBOARD_TOKEN` as an independent high-entropy control-plane Worker secret. Do not reuse the admin token, signing secret, credential pepper, or a provider key. Restrict `/dashboard*` and `/admin/v1/dashboard` with Cloudflare Access or an equivalent operator-only ingress policy before exposing a deployed control Worker; the Worker-level bearer check remains defense in depth.

The dashboard has no mutation controls. Kill switches, revocation, provisioning, and credential issuance remain explicit audited admin API/CLI operations.
