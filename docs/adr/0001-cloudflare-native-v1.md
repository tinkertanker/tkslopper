# ADR 0001: Cloudflare-native v1

**Status:** Accepted

## Decision

Use TypeScript Workers for the public boundary, D1 for control/policy state, and a principal-keyed Durable Object only for exact reservation and concurrency serialization. Do not use LiteLLM, Postgres, Redis, or Queue in v1.

Queue is deferred because there is no selected external usage sink yet; adding an idle queue would add failure modes without reconciliation value. Add it when a concrete export consumer and delivery contract exist.

## Alternatives

- **LiteLLM + Postgres + Redis:** broader provider compatibility and mature proxy features, but materially larger operational/security surface and weaker fit for the intentionally narrow API.
- **Single Worker without a Durable Object:** simpler, but cannot provide exact concurrent budget/concurrency reservations under distributed execution.

## Consequences

Provider breadth is intentionally small. The provider contract remains gateway-neutral so LiteLLM can replace only the physical data plane later. Rollback is Worker version rollback plus product kill switches; no product prompts or state migrate through tkslop.
