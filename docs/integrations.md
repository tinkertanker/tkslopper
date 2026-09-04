# Product integration contracts

These plans are based on public-safe synthetic audits at fixed product refs:

- Vibbit `tinkertanker/vibbit@4eb53bf67eb5e3c6a33e15f5f1a5222c5fcf23f7`
- Tapplet `tinkertanker/tapplet@d3ca90e31af5f0e7c727271391363eab27168e71`
- Playground Pal `tinkertanker/playground-pal@a28d2cd8c1075022adaab99a350f801b0ba6f949`

Fixtures contain synthetic content only. They are partial normalized schema-smoke examples, not source-exact captures or complete product conformance. In particular, they do not prove runtime model fallback, every per-operation token default, Playground Pal analysis/ordered-repair flows, or Tapplet's full repair workflow. They describe gateway-bound normalized requests, not permission to connect a product or provider.

## Shared adapter rules

1. A trusted product backend exchanges its service credential for the minimum short-lived capabilities, then calls Chat or Responses with a fresh idempotency key per physical attempt.
2. A native client may use only an approved access-code/activation flow and short grant. It never receives a service credential or provider key.
3. Products translate provider-specific fields into the portable public subset. Unknown fields must fail locally or at the gateway; never silently drop them.
4. Products retain prompts, workflow, semantic repairs, response semantics, validation, moderation policy, retrieval, history, and user-facing errors.
5. Record `x-tkslopper-request-id` as the join key for route/model/policy provenance. The public `model` remains the requested alias; physical model identity stays in trusted metadata.
6. Do not retry an ambiguous gateway failure automatically. A product-owned semantic repair uses a new idempotency key and is a separately billed attempt.

The repository's [service-to-service](../examples/service-to-service.ts) and [direct activation](../examples/direct-client.ts) examples are dependency-free reference clients. They intentionally avoid a provider SDK so the strict supported JSON and credential boundary remain visible.

## Vibbit

**Boundary:** Vibbit's BFF keeps classroom/session authentication, MakeCode system/user prompts, ordered semantic repair transcripts, compiler/decompiler validation, product quotas, and final `{feedback, code}` parsing. Its backend uses a service credential; extension/bookmarklet BYOK remains direct initially.

**Gateway profiles:**

- `text.chat.v1` → Chat, buffered string assistant content, up to 3,072 output tokens.
- `text.response.v1` → Responses, buffered `output_text` projection, up to 3,072 output tokens.

Vibbit currently sends physical model IDs and provider-specific `reasoning` on some routes. Its new adapter must send aliases and only portable fields. Each semantic repair preserves `system,user,assistant,user` order and uses a new idempotency key. The tkslopper route deadline must remain below Vibbit's 60-second provider-attempt/browser envelope; no gateway transport retry/fallback is allowed.

**Buffered Chat result:** HTTP 200 can carry a complete, truncated, refused/filtered, or incomplete choice. Vibbit may accept text only when `finish_reason` is `stop` and assistant `content` is non-empty. It must handle `length` as truncation, `content_filter` as refusal/filtering, and `null` as incomplete; partial content in a non-complete choice is not a final result. See [ADR 0011](adr/0011-buffered-chat-outcomes.md) and the [complete-result client helper](../examples/chat-completion.ts).

**Remaining blocker:** The observed public deployment materially differs from the audited repository (provider list/defaults, class-code behavior, teacher route, and CORS); deploy or identify a known revision and capture sanitized request-shape evidence before migration.

## Tapplet

**Boundary:** Tapplet's Worker keeps device/class access, D1 quotas, retrieval, prompts, artifact/revision/repair workflow, HTML/design-card validation, image normalization/classification policy, publication moderation, and R2/D1 records. Only physical inference transport moves.

**Gateway profiles:**

- `json.strict.v1` on Chat and Responses for artifact/moderation requests.
- `vision.classify.v1` on Responses for canonical JPEG input.

Current direct calls use `thinking`, OpenRouter `reasoning`, and physical efforts `xhigh|minimal|none|max`. The product adapter sends portable `high|low` or omits effort; trusted route policy must map/inject the selected physical dialect under [#13](https://github.com/tinkertanker/tkslopper/issues/13). Direct-provider attribution headers stay route-owned. The gateway's internal deadline must be shorter than Tapplet's 45-second per-call abort; Tapplet performs no transport retries. `x-tkslopper-request-id` joins its metadata trace to tkslopper provenance.

The current request fixtures cover Chat JSON, Responses `json_object`, moderation, and canonical JPEG transport. [#14](https://github.com/tinkertanker/tkslopper/issues/14) still requires the settled strict artifact/moderation schemas, response-segment/incomplete projections, image classification output contract, payload-leakage assertions, and route deadline evidence.

## Playground Pal

**Boundary:** Apple on-device and PCC calls stay local and unmetered by tkslopper. The app retains context selection/reduction, system instructions, history, citation/grounding checks, analysis schema, quality policy, local storage, and personal BYOK direct adapters.

The first slice is a test-only managed-route pilot, not app routing. A product-owned managed adapter normalizes current Anthropic Messages, OpenAI Responses, and OpenAI-compatible Chat calls into:

- `long-context.chat.v1` for text chat/analysis;
- `long-context.response.v1` if the pilot proves Responses is needed.

There is no public `/v1/messages`. Anthropic `system`, `thinking`, cache controls, provider headers, OpenAI prompt-cache/verbosity fields, and provider-specific efforts must be translated or intentionally omitted by the managed adapter/route policy. Personal BYOK must not upload user provider keys to tkslopper. Eventual classroom QR/bootstrap migration requires an opaque activation credential and an approved pseudonymous principal model.

Current cloud calls are buffered with a 30-second request and 60-second resource timeout. Route deadlines therefore need product approval and must finish inside that envelope. Playground Pal's source limits are soft character targets up to roughly 180,000 characters; the gateway must measure serialized bytes and eventually enforce a physical route's combined input+output window without truncating. [#11](https://github.com/tinkertanker/tkslopper/issues/11) and [#12](https://github.com/tinkertanker/tkslopper/issues/12) own the endpoint, retry, context-window, native renewal/error, and response-projection decisions.

## Integration sequence

1. Land platform integrity/failure-path/repository gates.
2. Complete synthetic gateway fixtures and provider-adapter response projections.
3. Add disabled product adapters with synthetic tests at the audited product refs.
4. Reconcile Vibbit deployment drift, settle Tapplet's schemas/reasoning routes, and decide Playground Pal's principal/BYOK/endpoint contract.
5. Under separate authorization, run a provider sandbox; then one disabled-by-default product canary at a time with direct-provider rollback retained.

No example or plan authorizes production traffic, real credentials, provider/domain setup, billing integration, or deployment.
