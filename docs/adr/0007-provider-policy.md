# ADR 0007: Provider and fallback policy

**Status:** Accepted

## Decision

Start with a development/test fixture adapter and one transparent OpenAI-compatible HTTP adapter. Trusted deployment configuration maps route IDs to HTTPS base URLs, physical models, supported endpoints/features, deadlines, and secret binding names. D1 aliases map public capability to a route ID. An external provider is a trusted data processor, not an adversarial isolation boundary: approve its security, data use, residency, and contract before routing production data or credentials to it.

Make exactly one physical attempt. Retries and fallback are off, and provider errors are normalized without leaking bodies. Never retry after response bytes are emitted (v1 buffers the complete non-streaming response).

Do not follow upstream redirects. The configured HTTPS route is the only approved destination. Provider-specific dialect transforms must be explicit trusted route policy with golden tests; the transparent adapter does not silently reinterpret unsupported fields.

## Consequences

Successful upstream bodies are schema-validated and projected onto the supported response contract; arbitrary fields and error bodies are never forwarded. Exact credential-reflection rejection is defense-in-depth against accidents, not a claim that arbitrary provider text can be made safe when the provider itself is malicious.

Operators must canary route changes and use kill switches. A future fallback policy requires explicit accounting/provenance semantics and cannot silently change provider or model.
