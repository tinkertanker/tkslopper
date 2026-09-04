# ADR 0011: Buffered Chat completion outcomes

**Status:** Accepted

## Decision

Normalize every structurally valid, successful Chat provider response into a strict buffered choice contract. Each choice contains a non-negative `index`, an assistant message with required nullable `content` and `refusal`, and a required `finish_reason` of `stop`, `length`, `content_filter`, or `null`.

`stop` is the only complete outcome. It requires non-empty assistant content and no refusal. `length` is truncated and may retain partial content. `content_filter` is refused or filtered: content is removed and a non-empty provider refusal is preserved when available. `null` is incomplete and may retain unconfirmed partial content, but never a refusal.

Provider refusal text or a provider `content_filter` finish takes precedence and normalizes to `content_filter`. Provider `length` normalizes to `length`. Provider `stop` normalizes to `stop` only with non-empty content and no refusal. A missing, null, or unrecognized provider finish, or `stop` with null or empty content, normalizes to `null`.

HTTP 200 means the provider returned a valid buffered Chat envelope and quota/accounting completion succeeded; it does not by itself mean the choice is complete. A full-result consumer must require `finish_reason === "stop"` and non-empty content. A structurally malformed successful provider body remains a `502 provider_protocol` error.

## Consequences

Vibbit and other full-result consumers cannot accidentally present truncated, refused, filtered, or unconfirmed text as complete. OpenAPI-generated clients receive concrete choice, assistant-message, and finish-reason types. The dependency-free reference client demonstrates the required runtime branch for untyped JSON.

Normalization does not add streaming, retry, fallback, replay, or another provider attempt. Partial text may be available for explicit product-owned handling, but tkslopper never upgrades it to a complete outcome.

## Rejected alternatives

- Treating every HTTP 200 as complete loses provider outcome semantics.
- Converting truncation, refusal, or incompleteness into transport errors conflates a valid provider result with gateway failure and discards useful explicit state.
- Passing arbitrary provider finish strings through would make the versioned public contract depend on provider dialects.
