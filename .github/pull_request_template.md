## Change

Describe the bounded outcome and why tkslop owns it.

## Evidence

- [ ] `pnpm check`
- [ ] `pnpm audit --audit-level=high`
- [ ] Full-history secret scan

## Risk review

- [ ] Identity/authorization and multi-product isolation
- [ ] Quota, concurrency, budget, idempotency, and physical-attempt accounting
- [ ] OpenAI-compatible subset and provider behavior
- [ ] Metadata-only logging and public-repository privacy
- [ ] Canary, kill switch, and rollback impact

State “not applicable” with a reason rather than checking an unreviewed surface.
