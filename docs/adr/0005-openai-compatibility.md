# ADR 0005: OpenAI compatibility scope

**Status:** Accepted

## Decision

Expose only `/v1/chat/completions` and `/v1/responses`, non-streaming, with strict schemas for common text, image-input, strict JSON, and explicitly permitted reasoning-effort fields. The `model` field is a tkslopper capability alias, not a provider model.

Reject unknown or unsupported fields. Do not silently drop tools, arbitrary metadata, streaming, provider-specific parameters, or conflicting token fields. Normalize successful response `model` back to the requested alias.

## Consequences

Existing OpenAI SDKs can target the gateway for this documented subset, but tkslopper does not claim full OpenAI compatibility. Streaming requires a later ADR covering SSE cancellation, emitted-byte retry prohibition, TTFT, and final accounting.
