# ADR 0004: Quota and budget consistency

**Status:** Accepted

## Decision

Serialize RPM, estimated TPM, active concurrency, and daily budget reservations in one Durable Object per identity tuple. Reserve worst-case configured output before provider invocation; complete with normalized actual usage, conservatively retaining estimates when an upstream omits usage or fails ambiguously.

Persist an attempt intent in D1 before every physical provider call, then finalize it with normalized status, usage, cost, and route provenance. Product semantic retries are new requests and never collapse physical accounting.

## Failure behavior

Admission or accounting uncertainty fails closed. Reservations have bounded expiries to recover concurrency after Worker termination. An expired reservation conservatively converts reserved cost to spent cost and retains its estimated minute tokens; it never silently releases possibly incurred spend. Minute token reservations adjust to actual usage on explicit completion. Daily spend never decreases on a completed or ambiguous physical attempt.

Provider route credentials are validated before quota admission. A request cancelled before admission or a proven pre-dispatch failure completes any acquired reservation with zero and removes its attempt intent; only a dispatched or ambiguous attempt is conservatively charged.

The gateway distinguishes its provider deadline (`504`, `provider_timeout`) from a client disconnect (`499`, `provider_cancelled`). Both abort the same one-call provider signal, conservatively complete the reservation because the provider outcome may be ambiguous, finalize attempt provenance, and retain failed idempotency state for 24 hours.

Every attempt intent stores `stale_after` as its route deadline plus reservation grace. D1 attempt finalization occurs only after Durable Object completion, so a row exposed by `stale_provider_attempts` is an explicit reconciliation signal for termination or accounting failure between intent and finalization.

## Consequences

Daily counters live in Durable Object state, while per-attempt provenance lives in D1. A production reconciliation/export sink remains an explicit launch decision.
