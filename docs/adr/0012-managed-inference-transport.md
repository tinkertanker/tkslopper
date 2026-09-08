# ADR 0012: AI SDK and Cloudflare AI Gateway

**Status:** Accepted for repository implementation; hosted canary pending.

## Decision and ownership

Keep classroom access codes, bounded device activation, credential exchange,
short-lived grants, live parent revocation, identity derivation, capability
policy, hard-budget reservations and duplicate suppression in tkslopper.
Use published AI SDK provider packages for compatible inference dispatch and
Cloudflare AI Gateway provider-native endpoints for managed observability.
Provider credentials stay on the backend. This does not require Vercel hosting
or Vercel AI Gateway, and does not enable Cloudflare Unified Billing.

The gateway derives pseudonymous tenant/principal attribution from authenticated
state. Cloudflare retains at most five custom metadata entries: we send request ID,
product, environment, tenant pseudonym and principal pseudonym. Alias, policy
version, route and endpoint remain in D1, correlated by request ID, not independent
Cloudflare metadata filters. A principal is not necessarily a person; a shared
service credential still represents its backend principal.

Cloudflare usage is observed provider usage, not our conservative accounting
ledger. Its eventually consistent spend limits do not replace Durable Object
reservations. The D1 attempt and stale-reconciliation views remain authoritative
for admission/accounting recovery. Generic request exploration belongs in
Cloudflare; classroom administration remains in the control plane.

## Implementation and upgrade boundary

`ai-sdk-transport.ts` uses public `createOpenAI` chat/Responses `doGenerate` APIs,
without the higher-level generation retry/tool loop. Exact package versions and
the lockfile pin the tested behavior. There is no vendored code or SDK fork.

The SDK's unified prompt representation cannot represent every accepted v1 wire
shape. The compatibility module restores roles/content boundaries, explicit
token-limit spelling, sampling/reasoning fields and omitted schema strictness.
These overlays are deliberately tested as public-contract compatibility, not
assumed provider portability. SDK response parsing is also narrower for refusal
and partial usage. Only fully buffered successful upstream bytes may be accepted
by our existing public projector if SDK parsing rejects them. Malformed JSON,
model substitution, reflected credentials, over-size bodies and transport errors
still fail closed. SDK exception bodies are never logged or returned.

The transport guard permits at most one fetch to the exact configured URL, forces
manual redirects, preserves the route deadline and bounds the body before SDK
parsing. Cloudflare headers request one attempt, no cache and metadata-only logs.
These are local guarantees/requested settings, not proof of remote execution.
Provider-internal routing (including OpenRouter) also needs qualification.

## Changeover sequence and rollback

1. Replace handwritten request dispatch with pinned SDK transport; retain public
   API and database schema. Run all prior fixtures and failure-accounting tests.
2. Add private `gateway` route configuration and separate credentials. No account
   identifiers, real keys, or active gateway defaults belong in this repository.
3. Run synthetic local tests of headers, request parity, refusal, missing usage,
   deadlines, errors and one-fetch behavior. Build both Workers.
4. With a named account/gateway/provider and approved private credentials, run a
   separately authorized hosted canary using the changeover runbook. Inspect real
   metadata-only logs, cost attribution and actual provider attempt counts.
5. Enable one killed-by-default environment only after canary acceptance. Do not
   claim adoption complete until this remote step succeeds.

Omitting `gateway` explicitly selects direct SDK transport. It is a configuration
rollback mode, not a second implementation or automatic failover. Kill the
environment before switching transport and never replay an ambiguous request.
No D1 migration or classroom credential reissue is required.

## Alternatives

- A stock LiteLLM service adds PostgreSQL/possibly Redis while still requiring our
  classroom policy and conservative ledger. Defer unless its key/team management
  becomes more valuable than the managed service's operational simplicity.
- AI SDK alone does not provide operational logs or a key administration UI.
- Workers AI is a possible inference destination, not classroom authorization.
- Deleting public validation to adopt SDK defaults would silently change v1
  refusals, role handling and incomplete results. Prefer explicit compatibility
  until a separately versioned API is approved.

## Verification sources

- [Cloudflare provider-native OpenAI endpoints](https://developers.cloudflare.com/ai-gateway/usage/providers/openai/)
- [Metadata-only log headers](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- [Five-entry custom metadata limit](https://developers.cloudflare.com/ai-gateway/observability/custom-metadata/)
- [Retries and first-response timeout](https://developers.cloudflare.com/ai-gateway/configuration/request-handling/)
- [Credential precedence and Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/)
- [Eventually consistent spend limits](https://developers.cloudflare.com/ai-gateway/features/spend-limits/)
