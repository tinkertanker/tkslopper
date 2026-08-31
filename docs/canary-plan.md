# Staged POC and canary plan

No stage authorizes production deployment.

## Stage 0: local/CI fixture

Exercise service exchange, access-code activation bounds, revocation, kill switches, all golden request fixtures, cross-product alias denial, idempotency conflict, quota/concurrency/budget denial, deadlines, one-attempt accounting, and payload-leakage assertions.

**Accept:** all gates pass at the reviewed SHA; no Critical/Required review findings.

**Kill:** any identity override, cross-product access, payload in logs/storage, unbounded attempt, or accounting race.

## Stage 1: isolated provider sandbox

Use a dedicated provider project/key and synthetic prompts only. Cap daily budget at the smallest useful amount. Compare normalized usage, physical provider calls, D1 attempts, and Durable Object spend.

**Accept:** 100% route provenance, zero duplicate physical attempts for reused idempotency keys, expected quota denials, cancellation/deadline behavior, and provider cost variance within the predeclared tolerance.

**Kill:** missing attempt provenance, unexplained spend, provider/model mismatch, secret exposure, or >1 physical call per request.

## Stage 2: one internal product environment

Use one internal tenant and non-sensitive workload. Start ≤1% or an allowlisted cohort, then 5%, 25%, 50%, 100% only after a full observation window at each step.

**Accept:** product-defined quality unchanged, gateway p95 latency overhead within target, error budget intact, no isolation/privacy event, revocation and kill drill successful.

**Kill:** product quality regression, sustained 5xx/timeout increase, p95 breach, quota false-positive, rollback failure, or on-call uncertainty.

## Stage 3: product-by-product canary

Order products independently. Vibbit requires complete non-streaming results. Tapplet requires strict JSON and image-input conformance. Playground Pal requires approved large-context policy and measured cost. Never infer acceptance for one product from another.

Keep product backends' [direct-provider rollback](runbooks/direct-provider-rollback.md) available throughout canary.
