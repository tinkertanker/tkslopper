# ADR 0007: Provider and fallback policy

**Status:** Accepted

## Decision

Start with a development/test fixture adapter and one launch wire-adapter family: `openai-compatible`, supporting non-streaming Chat Completions and Responses. Distinguish the wire adapter from the physical provider/gateway in route configuration and persisted provenance. Trusted deployment configuration maps route IDs to reviewed profiles, HTTPS base URLs, physical models, supported endpoints/features, deadlines, and dedicated secret binding names. D1 aliases map public capability to a route ID. Callers select only capability aliases, never providers, models, base URLs, credentials, attribution headers, or provider-specific fields.

Official OpenAI, OpenRouter, OpenCode Go/Zen, direct DeepSeek, and deployment-approved compatible URLs are trusted route profiles over that adapter, not additional adapters. Profiles own static attribution headers and provider-specific request translation. Apple Foundation Models and Private Cloud Compute remain product-side platform execution. Arbitrary caller-selected compatible endpoints remain unsupported; every custom URL must be approved and configured by the deployment owner.

Native Anthropic Messages and Gemini `generateContent` adapters are explicitly deferred post-launch roadmap features tracked by [#16](https://github.com/tinkertanker/tkslopper/issues/16) and [#17](https://github.com/tinkertanker/tkslopper/issues/17). They are not launch requirements. The initial implementation separates adapter/provider/profile provenance and implements OpenRouter's route-owned attribution plus Chat reasoning translation; the remaining OpenRouter/OpenCode/compatible profile transforms land as independently tested and canaried slices. An external provider is a trusted data processor, not an adversarial isolation boundary: approve its security, data use, residency, and contract before routing production data or credentials to it.

Make exactly one physical attempt. Retries and fallback are off, and provider errors are normalized without leaking bodies. Never retry after response bytes are emitted (v1 buffers the complete non-streaming response).

Do not follow upstream redirects. The configured HTTPS route is the only approved destination. Provider-specific dialect transforms must be explicit trusted route policy with golden tests; the transparent adapter does not silently reinterpret unsupported fields.

## Consequences

Successful upstream bodies are schema-validated and projected onto the supported response contract; arbitrary fields and error bodies are never forwarded. Exact credential-reflection rejection is defense-in-depth against accidents, not a claim that arbitrary provider text can be made safe when the provider itself is malicious.

Operators must canary route changes and use kill switches. A future fallback policy requires explicit accounting/provenance semantics and cannot silently change provider or model.

Launch scope is text, structured JSON, and one operation-specific image-input Responses route over the compatible adapter family; streaming, tools, image generation, audio, files, product prompts/workflows, and semantic retry/fallback remain out of scope. Tapplet production models, broader reasoning vocabulary (`none`, `minimal`, `max`, `xhigh`), and Responses `json_object` compatibility require explicit route/product decisions before those capabilities are enabled.
