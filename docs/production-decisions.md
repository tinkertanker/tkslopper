# Unresolved production decisions

These are deliberate blockers, not values to fill into this public repository:

- public domains, DNS, Worker routes, Cloudflare account, region/jurisdiction, and D1/DO placement;
- security-reviewed provider/subprocessor(s), physical models, projects, dedicated least-privilege keys, rate cards, data-use settings, regional processing, contracts, and acceptable OpenAI-compatible dialects;
- whether HS256 is acceptable or managed asymmetric signing/dual-key rotation is required;
- Stripe webhook verification, App Store Server/StoreKit verification, school-contract provisioning, refunds/grace periods, and source-of-truth conflict rules;
- DPAs, subprocessors, retention periods for grant/attempt/audit metadata, deletion/export procedures, and legal basis;
- on-call owner, escalation path, SLO/error budget, dashboards/alerts, incident system, and key custodians;
- Cloudflare Access or equivalent ingress restriction for admin routes, plus admin credential rotation ownership;
- per-product/environment tenants, capability policies, quotas, budgets, max body/context/output limits, and browser/CORS posture;
- external usage export/reconciliation consumer and whether Queue is justified;
- direct-provider emergency owners/credentials, canary cohorts, acceptance thresholds, and rollback authority.

No production launch should proceed until every item has an accountable owner and recorded decision.
