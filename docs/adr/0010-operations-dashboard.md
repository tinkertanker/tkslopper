# ADR 0010: Metadata-only operations dashboard

**Status:** Accepted for the pre-release scaffold; deployment ingress remains unresolved

## Decision

Serve the first operations dashboard from the existing control-plane Worker because that component already owns D1 policy, provider-attempt metadata, stale-intent evidence, and administrative audit records. Do not add a third service or give the control plane access to gateway provider secrets or Durable Object internals.

The browser surface is read-only. An inert `/dashboard` shell loads data from `GET /admin/v1/dashboard` using a dedicated high-entropy `DASHBOARD_TOKEN`. The write-capable admin token is rejected; equality with any other control-plane secret fails configuration. Responses are not cached, a per-response CSP nonce permits only the bundled script/style, and the submitted credential is cleared immediately without browser persistence.

The API projects explicit metadata columns only. It omits request/response payloads, raw and pseudonymous identity values, credential and idempotency material, actor hashes, access-code resource IDs, provider URLs, and route secrets. Attempt aggregates are capped at 10,000 schema-bounded rows so each exact SQLite sum remains below signed 64-bit limits, then returned as decimal strings so JavaScript does not narrow it. Per-environment alias and active-entitlement counts use cap-plus-one indexed sentinels. Effective-grant evaluation first bounds the live-grant candidate set, then applies entitlement and parent-policy checks only to that set. The API reports bounded minimums with explicit truncation rather than allowing one high-cardinality environment to make request work unbounded.

## Deployment boundary

Before any deployed dashboard is exposed, restrict its hostname/path to named operators with Cloudflare Access or an equivalent short-session, MFA-capable ingress policy. Worker bearer authentication remains defense in depth. The public repository contains no hostname, Access audience, account identifier, or deployment authorization.

## Deliberate limitations

The dashboard reports only persisted D1 facts. Attempt intents start after quota admission but before the provider call, so unfinished intents are excluded from finalized metrics and stale reservation ceilings are shown separately. The browser exposes the product/environment, policy, route, provider, resolved-model, endpoint, token/cost, and timing provenance needed for those records. Finalized errors can retain conservative accounting estimates. The dashboard does not claim visibility into pre-attempt authentication/admission denials or non-enumerable live per-principal Durable Object reservations. Recorded microcents are accounting evidence, not a provider invoice. It has no kill, restore, revoke, replay, quota-reset, provisioning, route-edit, deployment, or secret controls.

## Rejected alternatives

- A separate dashboard service duplicates authentication, deployment, and D1 access without creating a true read-only storage boundary.
- Reusing `ADMIN_TOKEN` gives a browser unnecessary mutation authority.
- Indexing every Durable Object principal solely for dashboard enumeration expands sensitive identity/state surface and weakens the current quota boundary.
- Browser mutation controls are deferred until operator identity, responder authorization, atomic audit, and Cloudflare ingress are independently approved.
