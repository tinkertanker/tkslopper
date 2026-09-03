# ADR 0004: Quota and budget consistency

**Status:** Accepted

## Decision

Serialize RPM, estimated TPM, active concurrency, and daily budget reservations in one Durable Object per identity tuple. Reserve worst-case configured output before provider invocation; complete with normalized actual usage, conservatively retaining estimates when an upstream omits usage or fails ambiguously.

Persist an attempt intent in D1 before every physical provider call, then finalize it with normalized status, usage, cost, and route provenance. Product semantic retries are new requests and never collapse physical accounting.

## Failure behavior

Admission or accounting uncertainty fails closed. Reservations have bounded expiries to recover concurrency after Worker termination. An expired reservation conservatively converts reserved cost to spent cost and retains its estimated minute tokens; it never silently releases possibly incurred spend. Minute token reservations adjust to actual usage on explicit completion. Daily spend never decreases on a completed or ambiguous physical attempt.

Provider route credentials are validated before quota admission. A proven pre-dispatch failure attempts to complete any possibly acquired reservation with zero; admission and completion calls are idempotent and receive one bounded retry so a single lost acknowledgement does not strand a known-zero reservation. If both cleanup calls fail, the request returns `503`, retains any attempt intent, emits `quotaReservationState: "unresolved"`, and bounded expiry remains conservatively chargeable. Otherwise only a dispatched or ambiguous provider attempt is charged.

The gateway aborts the provider at its configured deadline (`504`, `provider_timeout`), conservatively completes the reservation because the provider outcome may be ambiguous, finalizes attempt provenance, and retains failed idempotency state for 24 hours. The current Workers runtime does not signal a client disconnect while this non-streaming gateway is still buffering the upstream response, so the gateway does not claim pre-response disconnect cancellation or return a synthetic `499`. A runtime-supported design remains tracked by issue #5.

Every attempt intent stores `stale_after` as its route deadline plus reservation grace. D1 attempt finalization occurs only after Durable Object completion, so a row exposed by `stale_provider_attempts` is an explicit reconciliation signal for termination or accounting failure between intent and finalization.

## Consequences

Daily counters live in Durable Object state, while per-attempt provenance lives in D1. A production reconciliation/export sink remains an explicit launch decision.
