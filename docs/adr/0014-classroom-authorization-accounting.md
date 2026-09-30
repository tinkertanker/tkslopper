# ADR 0014: Classroom authorization and accounting

**Status:** Accepted

## Decision

Classes own a lifetime budget across stable groups. Groups own lifetime allocations
and share their daily, rate, and concurrency limits across all group keys and
activated devices. Class daily/rate/concurrency settings are group defaults, not
additional class-wide limits. Daily buckets use UTC.

High-entropy `tkgk_` keys authenticate directly using a SHA-256 digest lookup.
Classroom join codes retain the existing device activation and short-lived grant
flow. Both paths reload class/group policy from D1 on every gateway request;
signed claims alone cannot preserve access after pause, revocation, schedule expiry,
or capability narrowing. Grant product/environment/tenant must match the class.

One Durable Object per `(classroom, product, environment, class)` atomically admits
the class and group budgets and group limits. Its classroom state is separate from
legacy per-principal accounting. Classroom text requests reserve the serialised-byte
input estimate (images reserve the alias input ceiling) plus the effective output
limit before dispatch, and settlement is capped at that reservation, so accepted
provider usage cannot push spending past the envelope. The environment's
per-principal daily budget does not apply to classrooms; its rate, token and
concurrency limits remain guardrails. Completion is bound to the group and uses bounded retry
receipts. Uncertain dispatch and expired reservations retain conservative charges.

## Alternatives

Separate class and group Durable Objects cannot transact together. Compensating
partial reservations would weaken atomic admission and complicate failure recovery.
One class-sized coordinator trades class-wide serialization for a strict shared cap.
Per-key ledgers would let key rotation reset or fragment group spending.

## Consequences

Rotation and policy edits preserve ledger identity and spending. Duplication creates
new identities and configuration without credentials, usage, or revoked state;
copied groups inherit the new class schedule.

D1 provider-attempt rows carry group attribution and remain an audit/usage
projection, not authoritative remaining balance. A committed settlement followed by
failed D1 finalization can leave a pending intent. Automatic reconciliation is not
implemented; the UI distinguishes accounted cost from pending reservation ceilings.

Migration `0004_classrooms.sql` is additive and leaves legacy rows unlinked. Apply
it before deploying the gateway, verify gateway readiness, then deploy the control
plane that issues classroom access. Rolling back to a gateway without classroom
checks requires first invalidating classroom credentials and grants. Retain the
additive schema and history.
