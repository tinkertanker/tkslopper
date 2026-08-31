# ADR 0008: Multi-product isolation

**Status:** Accepted

## Decision

Scope environments, aliases, entitlements, grants, idempotency, quotas, and observability by server-derived product/environment/tenant/principal. Alias lookup includes product and environment; an identical alias string in another product is unrelated.

Use independent service credentials and access-code rows per environment. Production should use separate provider projects/keys when contractual, billing, or data-boundary needs require them; route configuration makes that separation possible.

## Consequences

A compromised product credential cannot select another product, tenant, capability, route, or cost tier. Cross-product fixture tests are release gates. Shared infrastructure is not equivalent to shared identity or policy.
