# Direct-provider rollback

Product backends—not direct untrusted clients—must retain an emergency direct-provider adapter behind a product-owned feature flag. It owns the same product prompt/workflow and uses a backend-only provider key from that product's secret store.

## Trigger

Use only when tkslop causes a sustained error/latency breach and direct provider health is confirmed. Turn on the tkslop environment kill switch first to prevent split traffic and duplicate attempts.

## Procedure

1. Record the UTC start, affected product/environment, tkslop request IDs, and current reviewed release.
2. Kill the tkslop environment.
3. Enable the product backend's direct route for a bounded cohort; direct app clients must route through the trusted backend, never receive a provider key.
4. Preserve product-side semantic idempotency. Do not automatically replay ambiguous tkslop failures.
5. Monitor product success/latency and provider spend separately. tkslop quotas/budgets do not cover bypass traffic.
6. Repair and validate tkslop with synthetic traffic, then canary back. Disable and rotate emergency credentials according to product policy.

The direct path is continuity control, not a permanent shadow retry or fallback. Never invoke both routes for one semantic operation unless a product-specific experiment explicitly owns and pays for both attempts.
