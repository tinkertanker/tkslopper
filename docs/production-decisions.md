# Production decision and implementation roadmap

This register separates repository decisions from choices that require an accountable operator, account owner, provider owner, or legal/commercial owner. Completing an implementation item does not authorize deployment or any other external mutation.

## Decisions settled for v1

- The public inference API remains strict, buffered, and non-streaming: only Chat Completions and Responses. There is no public Anthropic Messages endpoint.
- Every capability alias ends in a positive integer version such as `.v1`. Clients never send provider names, physical models, upstream URLs, provider-specific reasoning controls, or attribution overrides.
- Public reasoning effort remains portable `low|medium|high`. Provider-specific values such as `none`, `minimal`, `max`, and `xhigh`, plus `thinking` objects and provider headers, belong to trusted route policy or a product-owned adapter. They are rejected at the public boundary until that route policy exists.
- One gateway request makes at most one physical provider call. Redirect following, retry, fallback, response replay, cache, and session storage are off.
- Product prompts, semantic repair, retrieval, validation, classroom state, Apple local/PCC routing, billing UX, and student records remain product-owned.
- Payload retention in tkslopper is zero. Logs and D1 attempt records are metadata-only. Exact metadata retention periods and deletion/export operations remain launch blockers rather than guessed defaults.
- `development`, `test`, and `production` are the only deployment-environment values. Invalid environment/body-limit configuration fails health checks closed.

## Prioritized implementation roadmap

### P0 — platform integrity and repository controls

These block any provider or product connection.

1. [Identity-tuple integrity (#4)](https://github.com/tinkertanker/tkslopper/issues/4): enforce product/environment consistency in D1 and every writer/reader. Before editing the initial migration, privately prove no remote D1 consumed the old migration; otherwise use a forward migration after a read-only preflight.
2. [Deadline, cancellation, and accounting recovery (#5)](https://github.com/tinkertanker/tkslopper/issues/5): execute abort, client-cancellation, finalization-failure, quota-completion-failure, and stale-attempt recovery tests.
3. [Dependency update isolation (#6)](https://github.com/tinkertanker/tkslopper/issues/6): keep major upgrades independently reviewable. Do not merge the current TypeScript 7/ESLint 10 or Zod 4 bot PRs without intentional migrations.
4. [Repository and CI governance (#7)](https://github.com/tinkertanker/tkslopper/issues/7): enable a verified private vulnerability channel, protect `main`, require checks/review, and pin external CI inputs. These GitHub settings require repository-admin action.

**Exit:** full local/CI gates pass at one reviewed SHA, identity preflight is clean, all Stage 0 failure paths are deterministic, and no Critical/Required review finding remains.

### P1 — public contracts and synthetic conformance

No account, provider key, or deployment is needed.

1. Make buffered Chat completion/incomplete/refusal semantics normative for Vibbit ([#10](https://github.com/tinkertanker/tkslopper/issues/10)).
2. Complete the Playground Pal eager-tutor pilot and combined context-window/native-client contract ([#11](https://github.com/tinkertanker/tkslopper/issues/11), [#12](https://github.com/tinkertanker/tkslopper/issues/12)).
3. Add trusted route-owned reasoning transforms, then production-faithful Tapplet request **and response** fixtures ([#13](https://github.com/tinkertanker/tkslopper/issues/13), [#14](https://github.com/tinkertanker/tkslopper/issues/14)).
4. Keep the executable local two-Worker smoke flow green for all three products, kill-switch denial, and grant revocation.

**Exit:** every product fixture is synthetic, tied to a verified product ref, admitted through the correct capability, projected into a product-consumable response, bounded by its outer timeout, and covered by payload-leakage assertions.

### P2 — approve an isolated sandbox design

[Issue #8](https://github.com/tinkertanker/tkslopper/issues/8) records the private choices below. A read-only Cloudflare identity/scope preflight follows only after an approved least-privilege token is supplied through the approved secret store. Completing this design does not authorize resource creation.

**Exit:** named owners approve provider/data/cost terms, Cloudflare topology, private configuration custody, admin ingress, retention, alerting, kill/rollback authority, and the exact mutation boundary.

### P3 — separately authorized Stage 1 provider canary

[Issue #9](https://github.com/tinkertanker/tkslopper/issues/9) creates and exercises an isolated synthetic-only environment only after separate approval for each external mutation.

**Exit:** route/model provenance, one-attempt behavior, timeout/cancellation, quotas, cost reconciliation, payload absence, kill switch, rollback, and teardown are proven against the selected provider.

### P4 — disabled product adapters, then product canaries

Implement adapters behind product-owned flags. Keep direct-provider rollback backend-only and never dual-send or replay ambiguous failures. Activate one product only after its own prerequisites and explicit canary authorization; success for one product does not approve another.

## Grouped decisions required from the user and accountable owners

### Hosting, security, and operations

1. Which Cloudflare account and jurisdiction/placement should own non-production and eventual production D1/DO/Workers, and who may authorize each mutation?
2. Are custom domains/routes needed, or should initial sandbox traffic use non-production Worker endpoints? No DNS change is implied.
3. Must v1 move from HS256 to asymmetric/dual-key verification before launch, and who owns signing/admin/provider key custody and rotation?
4. Who owns admin ingress, on-call, SLO/error budget, alerts, incident response, canary promotion, and rollback?

### Provider, privacy, and legal

1. Which provider projects, physical models, and dialects are approved for each alias, with what rate cards and least-privilege dedicated keys?
2. What training/data-use, retention, residency, DPA/subprocessor, school/minor-data, deletion, and export terms are required?
3. What retention periods apply separately to expired grants, idempotency hashes, provider-attempt metadata, and admin audit metadata? Until answered, production remains blocked and no cleanup schedule is claimed.

### Commercial entitlement sources

1. Which source is authoritative for each product: Stripe, StoreKit/App Store Server, school/org contracts, access codes, or a combination?
2. Who defines signature verification, replay protection, refunds, grace periods, conflict precedence, and reconciliation? No billing webhook or purchase flow will be guessed.

### Product policy

1. Approve per-product aliases, body/combined-context/output limits, budgets, quotas, route deadlines, browser/CORS posture, and whether one-attempt/no-transport-retry meets each product SLO.
2. Name direct-provider rollback owners and credential stores. Confirm that Vibbit deployment drift is reconciled, Tapplet's settled artifact schema is chosen, and Playground Pal's managed activation/BYOK retirement boundary is approved before any adapter activation.

No production launch proceeds until each answer has an owner, a private record where necessary, and verification evidence.
