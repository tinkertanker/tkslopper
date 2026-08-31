# ADR 0005: OpenAI compatibility scope

**Status:** Accepted

## Decision

Expose only `/v1/chat/completions` and `/v1/responses`, non-streaming, with strict schemas for common text, image-input, strict JSON, and explicitly permitted reasoning-effort fields. The `model` field is a tkslopper capability alias, not a provider model.

Require every alias to end in a positive integer version such as `.v1`. The version covers client-visible semantics; a physical route may change under the same alias only when golden tests and canary evidence prove that request/response, limits, modality, safety, privacy, and cost-class behavior remain compatible. Incompatible behavior requires a new alias version.

Reject unknown or unsupported fields. Do not silently drop tools, arbitrary metadata, streaming, provider-specific parameters, or conflicting token fields. Normalize successful response `model` back to the requested alias.

Keep public reasoning effort portable at `low|medium|high`. Provider-specific efforts, thinking controls, cache controls, and headers require trusted route translation or product-owned normalization; they are not client-selectable fields.

## Consequences

Existing OpenAI SDKs can target the gateway for this documented subset, but tkslopper does not claim full OpenAI compatibility. Streaming requires a later ADR covering SSE cancellation, emitted-byte retry prohibition, TTFT, and final accounting.
