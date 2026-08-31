# Operations runbook

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

Expired reservations release automatically. Compare aggregate provider usage to `provider_attempts` and Durable Object spend after incidents. If a durable export consumer is selected, add Queue with an explicit at-least-once/idempotent delivery contract rather than mutating the hot path ad hoc.

## Worker version rollback

1. Turn on the affected product/environment kill switch before changing either Worker. If the control Worker is impaired, use the pre-authorized Cloudflare operator path and keep product traffic stopped.
2. Identify the last reviewed, mutually compatible version IDs without exposing bindings: `wrangler deployments list --config apps/gateway/wrangler.jsonc` and the equivalent control-plane command.
3. Roll back the gateway first, then the control plane: `wrangler rollback <version-id> --config <config> --message '<incident reference>'`. Use explicit version IDs from the incident record; never infer them from timestamps alone.
4. Do not reverse a D1 migration. A rollback candidate must be forward-compatible with the applied schema; otherwise keep the kill switch on and ship a reviewed forward fix.
5. While traffic remains stopped, verify health/configuration, synthetic service exchange, token revocation, alias isolation, one-attempt accounting, and quota completion against the rolled-back versions.
6. Restore only through the staged canary and observation windows. Record both resulting deployment IDs and the exact application commit.

Rollback commands change shared infrastructure and require separate deployment authorization. This runbook does not grant it.
