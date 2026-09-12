# ADR 0013: Login-based dashboard access

**Status:** Accepted. Supersedes ADR 0010's dashboard bearer authentication.

**Extension:** Named D1 admin grants now authorize a separate same-origin browser
write surface and admin-only actor visibility. Access login alone still grants
no write role. See [named admins](../dashboard.md#named-admins) for authorization,
bootstrap, migration, audit retention, and rollback; the original read-only
rollout below remains historical context.

The dashboard uses Cloudflare Access login without a second shared token. The
Worker checks the platform-verified `ctx.access` audience against private
`DASHBOARD_ACCESS_AUD` and requires a human email identity. It does not trust
caller-supplied email/JWT headers or forward identity into dashboard data/logs.
Cloudflare Access policies own operator membership and session lifetime.

The page loads immediately, refreshes using its same-origin Access cookie, and
offers Access logout. Authentication/redirect failures hide previous data and
ask the operator to reload to sign in. No automatic request retry is introduced.
Write-admin APIs still require `ADMIN_TOKEN`; this login grants no write role.

Put the page and JSON endpoint, including alternate hostnames, in one Access
application using public destinations. Separate applications create different
audiences/cookies and can break browser data fetches. Preserve exact-operator
allow policies when consolidating; never use an everyone/bypass policy.

Deployment order: save existing Access configuration privately, consolidate the
protected destinations without leaving a protection gap, set the real audience,
then deploy. Keep the old secret privately for rollback to the preceding Worker
version, but it is ignored by this version. No database migration is needed.
Rollback restores the previous code/token UI; Access protection stays enabled.

Tests cover valid identity, wrong/missing audience, missing/human-less identity,
forged headers, retired tokens and lack of write access. Local Wrangler explicitly
simulates Access via `access.dev`; that is not hosted authentication evidence.
Verify real Access protection and authenticated page/data behavior after rollout.

Sources: [Workers Access context](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)
and [Access application destinations](https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/update/).
