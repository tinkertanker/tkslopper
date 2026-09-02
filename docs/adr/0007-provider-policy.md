# ADR 0007: Provider and fallback policy

**Status:** Accepted

## Decision

Start with a development/test fixture adapter and an OpenAI-compatible HTTP adapter. Distinguish the wire adapter from the physical provider/gateway in route configuration and persisted provenance. Trusted deployment configuration maps route IDs to reviewed profiles, HTTPS base URLs, physical models, supported endpoints/features, deadlines, and dedicated secret binding names. D1 aliases map public capability to a route ID. Callers select only capability aliases, never providers, models, base URLs, credentials, attribution headers, or provider-specific fields.

The parity launch target inferred from Vibbit, Tapplet, and Playground Pal is three wire-adapter families:

1. `openai-compatible`, supporting non-streaming Chat Completions and Responses;
2. native Anthropic Messages;
3. native Gemini `generateContent`.

Official OpenAI, OpenRouter, OpenCode Go/Zen, and direct DeepSeek are trusted route profiles over the compatible adapter, not additional adapters. Profiles own static attribution headers and provider-specific request translation. Apple Foundation Models and Private Cloud Compute remain product-side platform execution. Arbitrary caller-selected compatible endpoints remain unsupported; a custom route must be approved and configured by the deployment owner.

The first implementation slice separates adapter/provider/profile provenance and implements OpenRouter's route-owned attribution plus Chat reasoning translation. Native Anthropic/Gemini translation and the remaining reviewed profile transforms land as independently canaried slices. An external provider is a trusted data processor, not an adversarial isolation boundary: approve its security, data use, residency, and contract before routing production data or credentials to it.

Make exactly one physical attempt. Retries and fallback are off, and provider errors are normalized without leaking bodies. Never retry after response bytes are emitted (v1 buffers the complete non-streaming response).

Do not follow upstream redirects. The configured HTTPS route is the only approved destination. Provider-specific dialect transforms must be explicit trusted route policy with golden tests; the transparent adapter does not silently reinterpret unsupported fields.

## Consequences

Successful upstream bodies are schema-validated and projected onto the supported response contract; arbitrary fields and error bodies are never forwarded. Exact credential-reflection rejection is defense-in-depth against accidents, not a claim that arbitrary provider text can be made safe when the provider itself is malicious.

Operators must canary route changes and use kill switches. A future fallback policy requires explicit accounting/provenance semantics and cannot silently change provider or model.

Launch scope is text, structured JSON, and one operation-specific image-input Responses route; streaming, tools, image generation, audio, files, product prompts/workflows, and semantic retry/fallback remain out of scope. The exact Gemini API version/model, Tapplet production models, broader reasoning vocabulary (`none`, `minimal`, `max`, `xhigh`), and Responses `json_object` compatibility require explicit route/product decisions before those capabilities are enabled.
