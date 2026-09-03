# Architecture

## Boundaries

The control plane owns durable authorization facts and the metadata-only operations view. The gateway owns one physical inference attempt and its admission/accounting. Product systems own all semantic behavior.

```diagram
┌─────────────────────────────┐          ┌──────────────────────────────┐
│ Product systems             │          │ tkslopper control plane      │
│ prompts/workflows/tools/RAG │─────────▶│ entitlement + grant minting  │
└──────────────┬──────────────┘          └──────────────┬───────────────┘
               │ short scoped grant                     │ D1 writes
               ▼                                        ▼
┌─────────────────────────────┐          ┌──────────────────────────────┐
│ tkslopper gateway           │◀────────▶│ D1 policy + attempt metadata │
│ validate → reserve → invoke │          └──────────────────────────────┘
└──────────────┬──────────────┘
               │ exact principal serialization
               ▼
┌─────────────────────────────┐          ┌──────────────────────────────┐
│ Durable Object              │          │ Configured provider          │
│ RPM/TPM/concurrency/budget  │          │ one route, one attempt        │
└─────────────────────────────┘          └──────────────────────────────┘
```

## Request flow

1. The control plane verifies a high-entropy service credential or a bounded access-code activation. It derives identity from stored rows, intersects requested capabilities with entitlement policy, mints a 1–60 minute grant, and stores its JTI hash for immediate revocation.
2. The gateway verifies the signature and expiry, then loads the JTI, entitlement, product, environment, and kill-switch state from D1. Any disagreement fails closed.
3. The body is strict-parsed only after authentication and the environment-specific byte limit is known. The public `model` value is a capability alias.
4. D1 resolves `(product, environment, endpoint, alias)` to policy and a trusted route ID. Route configuration supplies the physical provider/model and secret binding.
5. A principal-keyed Durable Object atomically reserves RPM, TPM, concurrency, and daily microcent budget. After admission, the gateway persists a metadata-only attempt intent before making exactly one provider call with a composed deadline/cancellation signal.
6. Before returning non-streaming bytes, the gateway completes the reservation and then finalizes that attempt row. A crash can leave an explicit `attempt_started` row for reconciliation, but cannot produce an unrecorded provider call. The gateway never logs request or response payloads.

## Consistency model

- D1 conditional writes bound activation attempts and activation counts.
- The Durable Object serializes exact hot-path reservations per product/environment/tenant/principal.
- D1 remains the revocation and policy source of truth; grants are deliberately short-lived but not trusted without the D1 row.
- Idempotency keys are hashed, retained for 24 hours, and prevent duplicate execution; response replay is off to avoid payload storage.
- Provider fallback/retry is off. A product may perform a semantic retry with a new idempotency key and will see a separately accounted physical attempt.

## Provider replacement seam

`ParsedGatewayRequest`, `ProviderRoute`, `ProviderResult`, normalized usage, and `ProviderError` form the data-plane seam. A future LiteLLM adapter can replace `callProvider` without moving entitlement, token, alias, or quota ownership.

## Operations view

The control Worker serves the read-only [operations dashboard](dashboard.md) because it already owns D1 policy, attempt, and audit metadata. A separate dashboard bearer credential cannot call write-capable admin routes. Live per-principal quota state remains inside Durable Objects and is deliberately not made enumerable for the dashboard.

## Extension seams

Stripe, App Store Server/StoreKit, and school-contract automation should write the existing entitlement abstraction through authenticated control-plane adapters. Webhook verification and replay protection belong outside the inference hot path. No production billing webhook is implemented in v1.
