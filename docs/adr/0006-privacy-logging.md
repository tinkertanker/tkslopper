# ADR 0006: Privacy and logging

**Status:** Accepted

## Decision

Observability is metadata-only: request ID, pseudonymous identity hashes, product/environment IDs, alias/policy version, physical route/provider/model, status/error class, latency, token/cost estimates, and attempt count.

Never log or persist prompts, responses, image/base64 data, tool payloads, filenames, access codes, authorization headers, emails, raw device IDs, or raw IP addresses. Upstream error bodies and exception messages are not logged or returned.

## Consequences

Debugging relies on request IDs, synthetic reproduction, provider dashboards, and aggregate metadata. Idempotency stores hashes and status but not response payloads. Retention and DPA terms remain production decisions.
