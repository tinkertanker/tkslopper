# Operations runbook

## Readiness gate

Before any canary, verify the exact reviewed application/configuration versions, named on-call and rollback owners, health checks, D1 migration/preflight result, provider deadline below the product's outer timeout, route/body/context/output limits, budget, metadata-only dashboards/alerts, retention decision, kill-switch access, compatible rollback target, and backend-only direct-provider path. Keep traffic killed if any owner or value is unknown.

## Signals

Alert from metadata aggregates only: status/error-class rates, latency, per-route token/cost deltas, quota denials, missing attempt writes, and Durable Object/D1/provider availability. Do not sample payloads for debugging.

## Kill switches

Use `pnpm admin -- kill-switch set` with a JSON body naming the product or environment ID and `enabled: true`. Verify new grants and gateway requests fail closed. Record the actor, reason, UTC time, and request IDs in the private incident system.

## Revocation

- Revoke a grant by the `grant_id` returned during exchange for immediate single-token invalidation.
- Revoke a service credential to disable the credential and its entitlement.
- Revoke an access code to disable future exchanges, revoke its activations, and revoke derived entitlements.
- Revoke an entitlement to invalidate every linked live grant at the gateway's next D1 check.

## Signing-key rotation

The v1 verifier supports one HS256 key. Rotation therefore requires a coordinated maintenance window: stop minting, kill affected environments, deploy both Workers with the new secret, revoke outstanding grants, then restore. A dual-key or asymmetric design is a launch decision if zero-downtime rotation is required.

## Credential/provider-key incident

1. Turn on the smallest applicable environment/product kill switch.
2. Revoke affected tkslopper credentials/entitlements and rotate provider keys in the provider system.
3. Rotate Worker secrets through `wrangler secret put`; never paste values into diagnostics.
4. Query metadata by request ID, route, time, and pseudonymous principal. Do not retrieve payloads—tkslopper has none.
5. Reconcile provider-side physical usage with D1 attempt metadata and Durable Object aggregate spend.
6. Restore via canary only after the cause and exposure window are understood.

## Reservation reconciliation

Explicit completion replaces a reservation with normalized actual usage. If completion cannot be confirmed, its bounded expiry releases concurrency but conservatively converts reserved cost to spend and retains estimated minute tokens until the minute resets.

Detect overdue attempt intents with the metadata-only view:

```sql
SELECT request_id, product_id, environment_id, alias, policy_version, route_id, provider,
       resolved_model, endpoint, input_tokens, output_tokens, cost_microcents, created_at, stale_after
FROM stale_provider_attempts
ORDER BY stale_after;
```

For every row, stop the narrowest affected environment if the failure is ongoing, use the request ID for internal metadata correlation, compare its route/model/time window against provider-side usage and aggregate Durable Object spend, and never replay it. The request ID is not currently sent upstream, so treat an outcome that cannot be matched as the reserved token/cost maximum. A confirmed no-call or completed-call outcome may be terminalized only through separately authorized, audited reconciliation tooling; the public scaffold does not guess or silently mutate that evidence. Keep the row and incident open until provider and quota accounting agree.

Compare aggregate provider usage to terminal `provider_attempts` and Durable Object spend after incidents. If a durable export consumer is selected, add Queue with an explicit at-least-once/idempotent delivery contract rather than mutating the hot path ad hoc.

Treat `provider_attempts.error_class = 'attempt_started'` older than the route deadline plus reservation grace as a reconciliation alert. Do not infer whether the provider completed: correlate request ID with provider-side metadata, conservatively retain the reservation/spend assumption, and never automatically replay. Automated stale-attempt detection and tested remediation are required by [#5](https://github.com/tinkertanker/tkslopper/issues/5) before Stage 1.

## Metadata retention and deletion

The scaffold stores no inference payloads, but expired grants, idempotency hashes/status, attempt metadata, activations/entitlements, and admin audit metadata need separately approved retention periods. Until those periods and deletion/export procedures are owned, production is blocked. Any cleanup job must be idempotent, preserve active authorization/accounting rows, emit counts only, and be exercised in local/isolated state before enablement.

## Worker version rollback

1. Turn on the affected product/environment kill switch before changing either Worker. If the control Worker is impaired, use the pre-authorized Cloudflare operator path and keep product traffic stopped.
2. Identify the last reviewed, mutually compatible version IDs without exposing bindings: `wrangler deployments list --config apps/gateway/wrangler.jsonc` and the equivalent control-plane command.
3. Roll back the gateway first, then the control plane: `wrangler rollback <version-id> --config <config> --message '<incident reference>'`. Use explicit version IDs from the incident record; never infer them from timestamps alone.
4. Do not reverse a D1 migration. A rollback candidate must be forward-compatible with the applied schema; otherwise keep the kill switch on and ship a reviewed forward fix.
5. While traffic remains stopped, verify health/configuration, synthetic service exchange, token revocation, alias isolation, one-attempt accounting, and quota completion against the rolled-back versions.
6. Restore only through the staged canary and observation windows. Record both resulting deployment IDs and the exact application commit.

Rollback commands change shared infrastructure and require separate deployment authorization. This runbook does not grant it.
