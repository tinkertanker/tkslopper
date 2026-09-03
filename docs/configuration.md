# Configuration governance

## Sources of truth

| Configuration                                                                               | Source                                                     | Sensitivity                         | Owner/change rule                                                           |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| Product/environment identity, entitlements, grants, kill switches, quotas, aliases          | D1 via authenticated control-plane/admin workflows         | Private metadata; no payloads       | Audited change; validate identity tuple; canary before enablement           |
| Provider route ID, adapter, physical model, endpoint/features, deadline, credential binding | `PROVIDER_ROUTES_JSON` in private deployment configuration | Private operational configuration   | Reviewed versioned artifact; no client override; route rollback retained    |
| Deployment environment, issuer, global body ceiling                                         | Worker vars                                                | Non-secret but environment-specific | Exact schema; health fails closed on invalid values                         |
| Signing secret, credential pepper, admin token, provider key                                | Worker secret bindings                                     | Secret                              | Independent values, least privilege, named custodian, rotation runbook      |
| Account IDs, database IDs, Worker names/routes, domains, jurisdictions                      | Private deployment configuration                           | Private deployment data             | Never commit to this public repository; external mutation requires approval |
| Provider rate card, data terms, retention, alert thresholds, canary owners                  | Private release decision record                            | Commercial/legal/operational        | Required before route enablement                                            |

The checked-in Wrangler files are development fixtures only. Placeholder resource IDs and fixture routes are not production policy.

## Alias and policy versioning

- Public aliases must end in `.vN`, where `N ≥ 1`. The suffix versions the client-visible semantic contract, not a physical provider release.
- The same alias text in another product, environment, or endpoint is unrelated.
- An in-place route/policy update may change only the physical implementation while preserving request fields, response projection, modality, context/output ceilings, safety behavior, retention/residency class, and product acceptance criteria. D1 increments `policy_version` for provenance.
- Any incompatible public behavior requires a new alias version. Issue both versions during migration; never silently reinterpret `.v1` as a different contract.
- Every route remap requires golden provider tests, synthetic canary evidence, previous route/config retention, a kill-switch owner, and a rollback decision. A successful route for one product cannot be copied to another without its own policy and tests.

## Provider adapter contract v1

The implemented production seam and initial launch family is `openai-compatible`; `fixture` is restricted to development/test. Trusted profiles cover official OpenAI, OpenRouter, OpenCode Go/Zen, direct DeepSeek, and deployment-approved compatible URLs. This is not a universal compatibility claim, and callers cannot supply a URL.

1. A route declares Chat and/or Responses, image/reasoning/structured-JSON support, physical model, HTTPS base URL, timeout, and a dedicated secret binding.
2. The gateway replaces the public alias with the configured physical model and forces `stream: false`.
3. It sends one Bearer-authenticated POST to `/v1/chat/completions` or `/v1/responses` with redirect following disabled.
4. Successful JSON is bounded, schema-validated, and projected. Usage is normalized. Provider extensions and error bodies are discarded.
5. The gateway restores the requested alias in the public success body and records physical route/model only in metadata provenance.
6. Unsupported endpoint/features fail before provider invocation. There is no retry, fallback, custom client header passthrough, arbitrary URL, or arbitrary provider field.

Public reasoning is `low|medium|high`. Trusted transforms from those portable values—or from omission—to provider-specific `none|minimal|max|xhigh`, `thinking`, or other dialect fields are not implemented yet and are tracked by [#13](https://github.com/tinkertanker/tkslopper/issues/13). Until then, a route must accept the portable wire shape exactly.

Anthropic Messages is not a public v1 endpoint. Native Anthropic and Gemini adapters are deferred roadmap features ([#16](https://github.com/tinkertanker/tkslopper/issues/16), [#17](https://github.com/tinkertanker/tkslopper/issues/17)), not initial-launch dependencies. Playground Pal's managed adapter must normalize its provider-specific requests into Chat or Responses; personal BYOK and Apple local/PCC calls remain outside tkslopper.

## Configuration validation and release workflow

1. Validate the reviewed artifact in CI with synthetic values and both Worker dry-runs.
2. Privately record a configuration version/digest, route IDs, provider project/model/dialect, rate-card date, data terms, body/context/output limits, deadline, budgets, retention, and owners. Never record secret values.
3. Diff against the active artifact. Reject unreviewed aliases, credential bindings, fixture routes in production, unknown deployment environments, body limits outside 1 KiB–10 MiB, or missing rollback configuration.
4. Deploy with every product/environment killed. Run health, exchange, revocation, isolation, quota, timeout, privacy, and provenance checks.
5. Promote through the canary plan. Record request IDs and configuration/deployment versions privately.
6. Roll back by killing the affected environment first, restoring a mutually compatible Worker/config version, and canarying back. Never reverse a D1 migration.

## Privacy and retention defaults

- Payload retention: **zero** in tkslopper logs and D1. Provider payload handling is governed separately by the approved provider contract/settings.
- Idempotency: key/scope/request hashes and status only; logical expiry is fixed at 24 hours. No response body is replayed.
- Grants: live rows are required for revocation/authorization until expiry. Post-expiry deletion timing is unresolved.
- Provider attempts and admin audit: metadata-only, but the current scaffold does not delete them automatically.
- Raw device IDs are keyed-pseudonymized; raw IP addresses and emails are not stored.

Production is blocked until owners choose retention periods and deletion/export procedures for expired grants, idempotency rows, provider attempts, activations/entitlements, and admin audit. The eventual scheduled cleanup must be idempotent, observable by counts only, preserve active authorization/accounting records, and be tested before enablement. “No cleanup implemented” must never be described as an acceptable retention default.
