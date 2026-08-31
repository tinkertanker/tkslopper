# ADR 0002: Trust boundaries

**Status:** Accepted

## Decision

Treat every app/client body, header, access code, service credential, and upstream response as untrusted for parsing and schema validation. Only the control plane may establish product/environment/tenant/principal identity. Only D1 policy plus deployment route configuration may choose endpoint, capability, provider, physical model, or cost tier.

Provider credentials, token signing material, credential pepper, and admin credentials are Worker secrets. Cloudflare AI Gateway run tokens and provider keys are never returned to clients.

An upstream is nevertheless a trusted data processor: receiving its credential lets it deliberately encode or fragment that credential into otherwise valid model output, which no transparent text gateway can reliably filter. Production route configuration must therefore name only security-reviewed processors under an appropriate contract, with dedicated least-privilege credentials. Response schemas and explicit projection constrain accidental reflection and protocol drift; they are defense-in-depth, not a sandbox for a malicious provider.

## Consequences

Client attribution headers are rejected rather than ignored. Signed grants are still checked against live D1 grant, entitlement, environment, and kill-switch state. Authentication, route parsing, policy corruption, and missing secrets fail closed. A provider compromise is a subprocessor/credential incident requiring route disablement, kill switches, key rotation, and reconciliation; response filtering cannot contain it.
