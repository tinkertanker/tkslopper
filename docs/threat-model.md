# Threat model

## Scope and security objectives

This model covers the public control plane, gateway, shared D1 data, per-principal quota Durable Objects, operator configuration, and one approved upstream route. Product systems and providers are adjacent trust domains, not code owned by tkslopper.

Security objectives:

1. A caller cannot forge or override product, environment, tenant, principal, entitlement, capability, route, provider, model, or cost tier.
2. A valid credential cannot cross its product/environment/tenant/principal boundary.
3. One accepted inference request causes at most one recorded physical provider attempt and is bounded by quota, concurrency, deadline, body/output limits, and budget.
4. Provider credentials and control secrets never reach clients or public history.
5. tkslopper never logs or persists request/response payloads or direct identifiers.
6. Revocation and kill switches fail closed without waiting for grant expiry.

Availability, model quality, prompt injection inside product workflows, and provider behavior are important but cannot weaken those objectives.

## Trust boundaries and data

```diagram
┌───────────────────┐  service/access credential  ┌──────────────────┐
│ Product or client │────────────────────────────▶│ Control plane    │
└─────────┬─────────┘◀──── short scoped grant ────└────────┬─────────┘
          │                                                 │ policy writes
          │ grant + strict request                          ▼
          │                                      ┌──────────────────┐
          └─────────────────────────────────────▶│ Gateway + D1     │
                                                 └───────┬──────────┘
                                                         │ reservation
                                              ┌──────────▼──────────┐
                                              │ Principal quota DO │
                                              └─────────────────────┘
                                                         │ one HTTPS call
                                              ┌──────────▼──────────┐
                                              │ Approved provider  │
                                              └─────────────────────┘
```

Secrets: signing material, credential pepper, admin token, service/access credentials, and provider keys. Sensitive payloads: prompts, responses, source code, images, and provider error bodies. Stored metadata: pseudonymous identity hashes, grant/policy references, request/route provenance, status, latency, usage, and cost.

## Threats, controls, and remaining gates

| Threat                                     | Current control                                                                                                       | Remaining gate                                                                                                       |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Forged grant or algorithm confusion        | Fixed JWT type/HS256 verification, issuer/expiry checks, live JTI and entitlement lookup                              | Decide signing/rotation architecture and exercise rotation                                                           |
| Product/environment tuple corruption       | Gateway compares signed and stored identity; aliases are server-scoped                                                | Complete relational integrity [#4](https://github.com/tinkertanker/tkslopper/issues/4) before any integration        |
| Client attribution/model override          | Attribution headers are rejected; strict schemas require versioned aliases; route/model come from D1 + trusted config | Keep provider-specific fields out of public contracts                                                                |
| Stolen service/access credential           | Salted+peppered hashes, bounded activation attempts/counts, expiry, revocation, short grants                          | Define custody, activation distribution, abuse alerts, and native renewal                                            |
| Access-code enumeration                    | Opaque high-entropy credentials and bounded failures                                                                  | Add operator monitoring without logging codes or raw devices                                                         |
| Browser cross-origin abuse                 | No browser CORS contract is approved                                                                                  | Keep browsers behind product backends until per-environment origins are approved                                     |
| Upstream redirect/route escape             | HTTPS-only configured base URL, no embedded credentials/query/fragment, redirect mode `manual`                        | Approve each base URL/provider project and test DNS/redirect behavior in sandbox                                     |
| Malformed or secret-reflecting upstream    | Bounded body, strict response schemas/projection, exact-secret reflection rejection, sanitized errors                 | Provider remains a trusted processor; contract/DPA and provider compromise response are mandatory                    |
| Hidden duplicate spend                     | One call, no redirect follow/retry/fallback/replay; D1 attempt intent before invocation; principal DO reservation     | Complete timeout/cancellation/finalization recovery [#5](https://github.com/tinkertanker/tkslopper/issues/5)         |
| Quota/budget race                          | Principal-keyed Durable Object serializes reservations                                                                | Reconcile stale reservations/attempts and external provider usage                                                    |
| Oversized input/output or context overflow | Bounded JSON/body/output and alias input/output ceilings; no truncation                                               | Add route/model combined-window admission [#12](https://github.com/tinkertanker/tkslopper/issues/12)                 |
| Payload leakage through logs/storage       | Typed metadata-only event, projected provider errors, payload-free attempts/idempotency                               | Configure platform telemetry/exporters payload-off and add retention cleanup after owner decision                    |
| Admin compromise                           | Dedicated bearer token and hashed audit actor                                                                         | Restrict ingress, rotate credentials, name custodians, and protect audit retention                                   |
| Supply-chain/repository compromise         | Frozen lockfile, audit, hygiene check, full-history Gitleaks                                                          | Pin CI inputs, protect `main`, and enable private reporting [#7](https://github.com/tinkertanker/tkslopper/issues/7) |
| Product semantic prompt injection          | Product owns prompts, retrieval, tools, validation, and semantic repair                                               | Product-specific tests/grounding remain required; gateway does not inspect payload semantics                         |
| Raw provider keys in untrusted clients/QR  | Managed routes use scoped grants; service/provider keys remain server-side                                            | Playground Pal raw-key classroom migration and BYOK boundary require product approval                                |

## Abuse and failure rules

- Authentication, identity mismatch, missing policy, invalid configuration, route mismatch, unsupported fields, and accounting uncertainty fail closed.
- Unknown fields are rejected, not silently dropped. In particular, Anthropic `thinking`, provider-specific reasoning objects/values, OpenRouter attribution headers, and prompt-cache controls require trusted translation outside the public request.
- No automatic retry or fallback occurs, including after timeout or ambiguous provider failure. Product semantic repairs are separate requests and separately accounted attempts.
- Upstream response bytes are buffered before client emission. Streaming is outside v1.
- Exact payload-secret reflection detection is defense in depth, not containment of a malicious provider. Only approved processors may receive production credentials/data.

Review this model whenever identity, signing, admin ingress, CORS, provider routing, retries/fallback, streaming, logging/export, billing adapters, or stored data changes.
