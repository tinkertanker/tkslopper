# Configuration governance

## Sources of truth

| Configuration                                                                               | Source                                                     | Sensitivity                         | Owner/change rule                                                           |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------- |
| Product/environment identity, entitlements, grants, kill switches, quotas, aliases          | D1 via authenticated control-plane/admin workflows         | Private metadata; no payloads       | Audited change; validate identity tuple; canary before enablement           |
| Provider route ID, adapter, physical model, endpoint/features, deadline, credential binding | `PROVIDER_ROUTES_JSON` in private deployment configuration | Private operational configuration   | Reviewed versioned artifact; no client override; route rollback retained    |
| Deployment environment, issuer, global body ceiling                                         | Worker vars                                                | Non-secret but environment-specific | Exact schema; health fails closed on invalid values                         |
| Gateway public origin for student cards (`GATEWAY_PUBLIC_URL`, control plane)               | Worker vars                                                | Non-secret but environment-specific | Bare https origin; display-only, so invalid values are reported, not fatal  |
| Signing secret, credential pepper, admin token, provider key                                | Worker secret bindings                                     | Secret                              | Independent values, least privilege, named custodian, rotation runbook      |
| Account IDs, database IDs, Worker names/routes, domains, jurisdictions                      | Private deployment configuration                           | Private deployment data             | Never commit to this public repository; external mutation requires approval |
| Provider rate card, data terms, retention, alert thresholds, canary owners                  | Private release decision record                            | Commercial/legal/operational        | Required before route enablement                                            |

The checked-in Wrangler files are development fixtures only. Placeholder resource IDs and fixture routes are not production policy.

## Client model catalogues

`GET /v1/model-catalogue` on the gateway is the single source of direct-provider suggestions for app BYOK and teacher/provider-key pickers. Its checked-in source is [`packages/shared/src/model-catalogue.ts`](../packages/shared/src/model-catalogue.ts), never `PROVIDER_ROUTES_JSON` or D1 route policy. It is public, works without inference credentials or D1, allows credential-free cross-origin GET (`Access-Control-Allow-Origin: *`), and caches for one hour. Do not use it as a readiness probe. No other endpoint gains CORS access.

```json
{
  "object": "list",
  "version": 1,
  "data": [
    {
      "id": "claude-haiku-5-5",
      "provider": "anthropic",
      "display_name": "Claude Haiku 5.5",
      "tier": "economy",
      "is_default": true
    }
  ]
}
```

This abbreviated example is a suggestion, not authorization or a managed alias. Providers are `openai`, `anthropic`, `gemini`, `deepseek`, `openrouter`, `opencode-go`, and `opencode-zen`. IDs are native to each provider: OpenRouter includes its vendor prefix; OpenCode has no app-specific `go/`, `zen/` or `responses/` prefix. Exactly one default is suggested per provider. Tiers (`economy`, `balanced`, `premium`) are qualitative picker hints, not prices, budget limits, or account-access guarantees.

Apps fetch from their configured tkslopper gateway origin without keys, Authorization, or cookies, validate the version/entries, bound the request and response, and retain a small bundled fallback for missing configuration, offline operation, or invalid/failed fetches. Catalogue updates replace suggestions, not saved/custom choices. `is_default` applies only to a new selection. Apps keep transport URLs, credential handling and protocol selection locally; catalogue data cannot redirect requests or expand managed permissions. BYOK inference still goes directly to its provider.

The initial catalogue consolidates all three apps' existing non-OpenAI/Claude suggestions and refreshes direct GPT/Claude IDs from the official sources below. Reseller IDs are preserved rather than guessed from vendor releases; verify each reseller's availability before refreshing them. New catalogue edits need duplicate/default checks, review of provider-native IDs and data-use labels, and the normal release approval. The Muse Contributor label retains its data-training warning. Do not publish private deployments, route IDs, base URLs, credential bindings or account details.

Authenticated `GET /v1/models` and `/v1/models/{alias}` remain the source of **managed** options. Existing objects retain their shape unless an admin supplies optional `display_name`, `provider`, or `tier` through `POST /admin/v1/aliases`, dashboard **Set model alias**, or `pnpm admin -- alias upsert`. A label can explicitly identify the model (for example “Claude Haiku 5.5”); it is not inferred from a private route. Only these three presentation fields are added. Clients display them but continue submitting the alias `id`.

Alias upsert is a full endpoint-row replacement: omitted or null presentation fields clear previous values, preventing a route remap from retaining an old label accidentally. `display_name` is trimmed, nonempty when supplied, and at most 120 characters; provider and tier use the enums above. When an alias has both Chat and Responses rows, each presentation field is emitted only if all enabled rows agree on a non-null value. Different models can therefore share an alias without a misleading combined label; configure consistent metadata on both rows to show it publicly. Labels do not alter route selection, authorization, ceilings or billing.

Apply additive migration `0006_alias_presentation.sql` **before** deploying these Workers (only with deployment approval). Existing aliases begin with null metadata and their old public shape. Both health checks require the new columns. Old Workers can run against the expanded schema for rollback; never reverse the migration. Updating the public catalogue does not provision a Claude route, remap aliases or grant access.

An old control Worker does not clear labels on alias updates. If rolling back, clear presentation before remapping any alias, or re-upsert aliases changed during the rollback window with correct or cleared labels before restoring the new gateway.

## Alias and policy versioning

- Public aliases must end in `.vN`, where `N ≥ 1`. The suffix versions the client-visible semantic contract, not a physical provider release.
- The same alias text in another product, environment, or endpoint is unrelated.
- An in-place route/policy update may change only the physical implementation while preserving request fields, response projection, modality, context/output ceilings, safety behavior, retention/residency class, and product acceptance criteria. D1 increments `policy_version` for provenance.
- Any incompatible public behavior requires a new alias version. Issue both versions during migration; never silently reinterpret `.v1` as a different contract.
- Every route remap requires golden provider tests, synthetic canary evidence, previous route/config retention, a kill-switch owner, and a rollback decision. A successful route for one product cannot be copied to another without its own policy and tests.

## Provider adapter contract v1

Compatible transport now uses pinned AI SDK packages. Add the optional private `gateway` object to route through Cloudflare AI Gateway with separate provider and gateway credentials, backend-derived metadata and payload logging disabled. See [configuration and hosted acceptance](runbooks/ai-gateway-changeover.md). The existing direct base URL is used only when `gateway` is omitted; there is no automatic fallback or Unified Billing mode.

Implemented adapters are `openai-compatible` and native `anthropic`; `fixture` is restricted to development/test. Compatible profiles cover official OpenAI, OpenRouter, OpenCode Go/Zen, direct DeepSeek, and deployment-approved compatible URLs. This is not a universal compatibility claim, and callers cannot supply a URL.

1. A route declares Chat and/or Responses, image/reasoning/structured-JSON support, physical model, HTTPS base URL, timeout, and a dedicated secret binding.
2. The gateway replaces the public alias with the configured physical model, forces `stream: false`, and always sends an explicit output limit: the client's value clamped to the alias ceiling, or 4,096 tokens (also clamped) when omitted. OpenAI routes always receive `max_completion_tokens` and other routes always receive `max_tokens`, whichever spelling the client used. A request whose reservation alone exceeds the per-minute token limit is rejected with 400 rather than a retryable 429.
3. Compatible routes send one Bearer-authenticated POST to `/v1/chat/completions` or `/v1/responses` with redirect following disabled. Anthropic routes use the native translation below.
4. Successful JSON is bounded, schema-validated, and projected. The provider-reported model must match the reviewed route model exactly, as a dated snapshot of it (`<model>-YYYY-MM-DD`, `<model>-YYYYMMDD` or `<model>-NNNN`), or as one of the route's optional `acceptedModels`; anything else fails closed rather than becoming a silent fallback. Usage is normalized. Provider extensions and error bodies are discarded.
   A definitive provider rejection (400, 401, 402, 403, 404, 413, 415, 422 or 429) releases the reservation and the idempotency key without charge. Client-fixable rejections (400, 413, 415, 422) return 400; an upstream 429 returns 429 with the provider's `Retry-After` (default 10 seconds); credential, credit, permission and unknown-model rejections remain 502 because they are route configuration faults. Timeouts, 5xx and malformed bodies stay ambiguous and keep the conservative charge.
5. The gateway restores the requested alias in the public success body and records the reviewed physical route/model only in metadata provenance.
6. Unsupported endpoint/features fail before provider invocation. There is no retry, fallback, custom client header passthrough, arbitrary URL, or arbitrary provider field.

Public reasoning is `low|medium|high`. The OpenRouter Chat profile transforms public `reasoning_effort` to `reasoning.effort`; native Anthropic maps effort to adaptive thinking as described below. Other value/default transforms to `none|minimal|max|xhigh` or provider dialects remain tracked by [#13](https://github.com/tinkertanker/tkslopper/issues/13).

### Native Anthropic

Set `adapter`, `provider`, and `profile` to `anthropic`, `baseUrl` to `https://api.anthropic.com` (without `/v1`), and a dedicated `credentialBinding`, for example `ANTHROPIC_API_KEY`. Both public endpoints translate to one `/v1/messages` POST using `x-api-key` and `anthropic-version: 2023-06-01`. The optional Cloudflare `gateway` uses `/anthropic/v1/messages` and the same separate-credential, one-attempt and metadata-only logging controls. Pinned `@ai-sdk/anthropic` constructs the request; tkslopper owns admission, byte/deadline limits, response projection and accounting.

The public model is still an authorized `.vN` alias from `/v1/models`, not `claude-haiku-5-5`. No public `/v1/messages`, streaming, tools, thinking blocks, cache controls or arbitrary provider fields are added.

- Leading system/developer text becomes native system blocks; Responses `instructions` comes first. Conversation history must start and end with a user turn. Assistant prefill and system/developer messages after conversation starts return 400 before admission.
- Images are user-only HTTPS URLs or base64 PNG/JPEG/GIF/WebP data URLs. The gateway never downloads remote images. Omit `detail` or use `auto`; `low`/`high` and images in other roles return 400.
- Omit `temperature`, `top_p` and `seed`. These controls return 400 rather than being silently discarded. This subset targets current Claude models, including Haiku 5.5's changed sampling rules.
- Portable `low|medium|high` effort maps to adaptive thinking plus `output_config.effort`. With no effort specified, the model's default applies. The output limit includes thinking and text and remains clamped to the alias ceiling.
- Structured output requires `json_schema`, with `strict` true or omitted; `json_object` and `strict:false` return 400. Schemas pass through to native `output_config.format` without tools or repair attempts. Provider schema restrictions still apply.
- Only text blocks are exposed. Thinking/signatures and provider extensions are discarded. `end_turn`/`stop_sequence` with nonempty text are complete; token/context exhaustion is truncated; `refusal` is projected as refusal; all other stops or empty answers are incomplete. Unexpected tool blocks fail closed.
- Input usage includes uncached input plus cache creation/read tokens. Output usage includes thinking. Missing/malformed counts remain unknown for conservative settlement; they are never assumed zero. The existing two-rate ledger does not price cache tiers separately: approve a conservative rate card covering the selected service/context tier. No cache writes are requested by this adapter.

Existing aliases must not be remapped if their sampling, JSON mode or message-shape contract is incompatible. Provision a separately approved alias/version and product grant instead. No D1 migration or credential reissue is needed merely to install the adapter. Native Gemini remains deferred ([#17](https://github.com/tinkertanker/tkslopper/issues/17)); personal BYOK and Apple local/PCC calls remain outside tkslopper.

### Model refresh, checked 2026-10-09

These are physical model recommendations for new private routes and defaults in the public direct-provider catalogue, not automatically enabled managed aliases. The development Wrangler routes remain synthetic fixtures.

| Use              | OpenAI        | Anthropic           |
| ---------------- | ------------- | ------------------- |
| Low-cost default | `gpt-6-luna`  | `claude-haiku-5-5`  |
| Balanced         | `gpt-6.1-sol` | `claude-sonnet-5-5` |
| High capability  | `gpt-6-astra` | `claude-opus-5-5`   |

Official sources: [OpenAI catalog](https://developers.openai.com/api/docs/models), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [Claude catalog](https://platform.claude.com/docs/en/models/overview), [Haiku 5.5 migration](https://platform.claude.com/docs/en/models/haiku-5-5/migration-guide), [native structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs). Anthropic also lists `claude-fable-5-1` for demanding long-horizon tasks; it is not the education default. Haiku 5.5 was released October 7, 2026. Both low-cost models list base input/output pricing from US$0.10/US$0.50 per million tokens; verify current service-tier, long-context, cache and regional prices before setting budgets. Existing working routes are not automatically migrated, and documentation availability does not prove access for a particular API account.

## Configuration validation and release workflow

1. Validate the reviewed artifact in CI with synthetic values and both Worker dry-runs.
2. Privately record a configuration version/digest, route IDs, provider project/model/dialect, rate-card date, data terms, body/context/output limits, deadline, budgets, retention, and owners. Never record secret values.
3. Diff against the active artifact. Reject unreviewed aliases, credential bindings, fixture routes in production, unknown deployment environments, body limits outside 1 KiB–10 MiB, or missing rollback configuration.
4. Deploy with every product/environment killed. Run health, exchange, revocation, isolation, quota, timeout, privacy, and provenance checks.
5. Promote through the canary plan. Record request IDs and configuration/deployment versions privately.
6. Roll back by killing the affected environment first, restoring a mutually compatible Worker/config version, and canarying back. Never reverse a D1 migration.

## Privacy and retention defaults

- Payload retention: **zero** in tkslopper logs and D1. Provider payload handling is governed separately by the approved provider contract/settings.
- Idempotency: key and identity-scope hashes, request ID, and status only; logical expiry is fixed at 24 hours. No payload hash or response body is stored or replayed.
- Grants: live rows are required for revocation/authorization until expiry. Post-expiry deletion timing is unresolved.
- Provider attempts and admin audit: metadata-only, but the current scaffold does not delete them automatically.
- Raw device IDs are keyed-pseudonymized; raw IP addresses and emails are not stored.

Production is blocked until owners choose retention periods and deletion/export procedures for expired grants, idempotency rows, provider attempts, activations/entitlements, and admin audit. The eventual scheduled cleanup must be idempotent, observable by counts only, preserve active authorization/accounting records, and be tested before enablement. “No cleanup implemented” must never be described as an acceptable retention default.
