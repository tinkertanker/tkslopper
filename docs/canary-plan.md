# Staged POC and canary plan

No stage authorizes production deployment.

## Stage 0: local/CI fixture

Exercise service exchange, access-code activation bounds, revocation, kill switches, all normalized schema-smoke fixtures, cross-product alias denial, idempotency conflict, quota/concurrency/budget denial, deadlines, one-attempt accounting, and payload-leakage assertions.

`pnpm check` executes the named Stage 0 failure gates: provider deadline abort, real local-Workers client-disconnect cancellation, one physical call, conservative timeout/cancellation accounting, attempt-finalization fault, quota-completion fault with one bounded retry, stale-attempt detection, 24-hour idempotency bounds, and conservative reservation expiry. No remote provider is used.

`pnpm check` is the CI gate. With both local Workers running against the shared `.wrangler/local` state, `pnpm e2e:local` additionally proves the public control-plane→gateway flow for all three products without a remote provider.

**Accept:** all gates pass at the reviewed SHA; no Critical/Required review findings.

**Kill:** any identity override, cross-product access, payload in logs/storage, unbounded attempt, or accounting race.

Deadline, client-cancellation, finalization-failure, quota-completion-failure, and stale-attempt recovery remain blocking until [#5](https://github.com/tinkertanker/tkslopper/issues/5) is complete. A green happy-path smoke test is not Stage 0 completion.

## Stage 1: isolated provider sandbox

Use a dedicated provider project/key and synthetic prompts only. Cap daily budget at the smallest useful amount. Compare normalized usage, physical provider calls, D1 attempts, and Durable Object spend.

**Accept:** 100% route provenance, zero duplicate physical attempts for reused idempotency keys, expected quota denials, cancellation/deadline behavior, and provider cost variance within the predeclared tolerance.

**Kill:** missing attempt provenance, unexplained spend, provider/model mismatch, secret exposure, or >1 physical call per request.

Before creating this environment, privately record the reviewed application SHA, configuration digest, provider project/model/dialect, rate-card date, synthetic corpus, timeout, body/context/output ceilings, daily budget, retention/data settings, reconciliation tolerance, resource owners, kill authority, rollback target, and teardown owner. This record contains no secret values. Design approval and each external mutation are separate approvals.

## Stage 2: one internal product environment

Use one internal tenant and non-sensitive workload. Start ≤1% or an allowlisted cohort, then 5%, 25%, 50%, 100% only after a full observation window at each step.

**Accept:** product-defined quality unchanged, gateway p95 latency overhead within target, error budget intact, no isolation/privacy event, revocation and kill drill successful.

**Kill:** product quality regression, sustained 5xx/timeout increase, p95 breach, quota false-positive, rollback failure, or on-call uncertainty.

## Stage 3: product-by-product canary

Order products independently. Vibbit requires complete non-streaming results. Tapplet requires strict JSON and image-input conformance. Playground Pal requires approved large-context policy and measured cost. Never infer acceptance for one product from another.

Keep product backends' [direct-provider rollback](runbooks/direct-provider-rollback.md) available throughout canary.

## Promotion and rollback evidence

For every cohort step, record privately:

- UTC start/end, product/environment/cohort, application/config/deployment versions, and approver;
- request counts and request IDs, status/error distribution, p50/p95 latency, quota denials, usage/cost reconciliation, and product-owned quality result;
- kill-switch and rollback drill result, the next observation window, and explicit promote/hold/kill decision.

Never promote automatically on elapsed time alone. On a kill condition, stop new traffic with the narrowest kill switch before changing routes or Workers. Do not replay ambiguous failures, dual-send to the direct provider, reverse a D1 migration, or restore traffic without a new canary decision.
