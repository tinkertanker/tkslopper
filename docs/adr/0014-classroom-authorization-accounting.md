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

## Amendment: group pause and join-code failures

Groups gain a reversible pause alongside terminal revocation. Migration
`0005_classroom_group_pause.sql` adds a nullable `classroom_groups.paused_at`
instead of widening the status `CHECK`, which SQLite could only change by rebuilding
the table. The shared policy loader rejects a paused group, so group keys,
existing grants and activations fail closed through the same path as class pause.
Pausing preserves keys, codes, allocations, usage and the group name; resuming
clears the column. Both Workers' readiness requires the column. The same migration
adds a non-secret four-character `key_hint` to group keys.

Join-code activation no longer refuses a correct secret after repeated failures.
Codes carry 256 bits of secret entropy, so the shared failure counter added no
protection against guessing, yet mistyped entries or anyone who learnt a code's
identifier could lock out a whole class, including renewals by activated devices. Wrong secrets still return
401 and increment the bounded counter as a signal; disable, expiry, activation
limits and classroom policy still apply.
