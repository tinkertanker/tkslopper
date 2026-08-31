# ADR 0004: Quota and budget consistency

**Status:** Accepted

## Decision

Serialize RPM, estimated TPM, active concurrency, and daily budget reservations in one Durable Object per identity tuple. Reserve worst-case configured output before provider invocation; complete with normalized actual usage, conservatively retaining estimates when an upstream omits usage or fails ambiguously.

Persist an attempt intent in D1 before every physical provider call, then finalize it with normalized status, usage, cost, and route provenance. Product semantic retries are new requests and never collapse physical accounting.

## Failure behavior

Admission or accounting uncertainty fails closed. Reservations have bounded expiries to recover from Worker termination. Minute token reservations adjust to actual usage on completion; daily spend never decreases on a completed physical attempt. A stale `attempt_started` row is an explicit reconciliation signal after termination between intent and finalization.

## Consequences

Daily counters live in Durable Object state, while per-attempt provenance lives in D1. A production reconciliation/export sink remains an explicit launch decision.
