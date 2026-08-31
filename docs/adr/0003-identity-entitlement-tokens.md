# ADR 0003: Identity, entitlement, and tokens

**Status:** Accepted

## Decision

Model identity as the tuple `(product, environment, tenant, principal)`. Service credentials and access codes are opaque high-entropy credentials stored as PBKDF2-SHA256 hashes with per-credential salts and a Worker-secret pepper.

Access codes are bootstrap credentials with expiry, failed-attempt bounds, activation limits, pseudonymous device activations, and remote revocation. Both flows exchange into HS256 grants valid for at most one hour and normally 15 minutes. Every grant has a hashed, live D1 JTI row linked to an entitlement and can be revoked immediately.

## Alternatives

Asymmetric signing would reduce shared-secret scope, but requires a production key-management/rotation choice not yet made. HS256 keeps the public scaffold executable; production must decide whether to retain it or move to managed asymmetric keys before launch.

## Consequences

The gateway performs a D1 authorization read per request. Billing sources are abstract entitlement `source` values; Stripe, StoreKit, and contract verification are not faked.
