# Deployment runbook

This runbook is documentation, not deployment authorization.

## Preconditions

1. Resolve every item in [production decisions](../production-decisions.md).
2. Complete security/privacy, API compatibility, quota/accounting, and operability reviews against the exact commit.
3. Run `pnpm check`, `pnpm audit --audit-level=high`, and a full-history secret scan.
4. Select Cloudflare accounts, D1 database, Worker names/routes, Durable Object jurisdiction, provider projects, retention, owner, and rollback contacts outside this public repository.
5. Replace placeholder database IDs and non-secret route configuration in private deployment configuration. Do not commit account IDs or private values here.

The initial migration includes product/environment and grant/entitlement identity constraints because this public scaffold has no deployed D1. If an operator discovers a database created from an earlier copy, do not silently rewrite ownership or reapply an edited migration. First run the read-only preflight against the private deployment configuration:

```bash
pnpm wrangler d1 execute <database-name> --remote --config <private-config> \
  --file db/preflight/identity_integrity.sql
```

An empty result is required; any reported violation/count blocks migration and requires an owner-reviewed forward migration. Running that remote preflight, like every remote operation in this runbook, requires separate authorization.

## Secrets

Generate independent values. Never reuse an admin token as a signing key or pepper.

```bash
wrangler secret put TOKEN_SIGNING_SECRET --config apps/control-plane/wrangler.jsonc
wrangler secret put TOKEN_SIGNING_SECRET --config apps/gateway/wrangler.jsonc
wrangler secret put CREDENTIAL_PEPPER --config apps/control-plane/wrangler.jsonc
wrangler secret put ADMIN_TOKEN --config apps/control-plane/wrangler.jsonc
wrangler secret put UPSTREAM_API_KEY --config apps/gateway/wrangler.jsonc
```

The same signing value must be supplied to both Workers in the HS256 v1 design. Provider route `credentialBinding` names must correspond to gateway secrets. Confirm secrets with binding metadata only; never print their values.

## Order

1. Back up D1 and apply migrations using the exact reviewed artifact.
2. Deploy the control Worker with no public product enabled.
3. Deploy the gateway Worker with fixture routes removed and production `DEPLOYMENT_ENV`; fixture routes fail closed in production but must not be production policy.
4. Create products/environments/aliases through the admin workflow. Keep environment kill switches on.
5. Run synthetic token exchange, revocation, alias isolation, quota, upstream deadline, and metadata-only logging checks.
6. Follow the [canary plan](../canary-plan.md). Enable one environment only after acceptance evidence is recorded.

## Never do during deployment

- Put secrets or provider tokens in vars, D1, source, command-line arguments, logs, or tickets.
- Enable the dev issuer or fixture provider in production.
- Relax a kill switch, quota, body limit, or capability to make a canary pass.
- add fallback/retry without a reviewed policy change.
