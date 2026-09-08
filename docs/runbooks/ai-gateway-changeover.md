# Cloudflare AI Gateway changeover

## Scope

Repository support is not a live deployment. No real provider traffic, credits,
gateway creation, secret writes or resource changes occur in the local tests.
Classroom clients keep their existing codes/grants; never distribute a provider
key or Cloudflare account token to them.

## Private configuration

On an `openai-compatible` route, add `gateway` with:

| Field               | Value                                                     |
| ------------------- | --------------------------------------------------------- |
| `accountId`         | Approved account's 32-character lowercase hexadecimal ID  |
| `gatewayId`         | Approved gateway name                                     |
| `credentialBinding` | Dedicated Worker secret binding for the gateway Run token |

Keep the route's existing `credentialBinding` for the provider key. Both values
must be present, distinct and at least 16 characters. Never reuse a signing or
admin secret. Readiness rejects absent or invalid gateway credentials.

Provider-native paths are constructed on `gateway.ai.cloudflare.com`; account
and gateway values are validated path segments, not arbitrary URLs. Supported
gateway profiles are `openai`, `openrouter` and `deepseek`; other compatible
profiles remain available only as direct SDK routes until qualified. `baseUrl`
remains the explicitly configured direct rollback target and is not consulted
when `gateway` is set. It retains the existing convention of excluding `/v1`.

The Worker always supplies the provider key in `Authorization` and the gateway
token in `cf-aig-authorization`. Missing keys fail locally, with no intentional
fall-through to stored keys or Unified Billing. Keep Unified Billing disabled and
do not fund credits for this BYOK canary. Missing/failed provider credentials must
also be tested on the hosted endpoint before enabling traffic.

## Hosted acceptance gate

An owner must first identify the account, gateway, provider project/model, data
terms, metadata retention period, budget cap and rollback authority. Supply
credentials privately. Approve creation/configuration, secret writes, deployment
and bounded synthetic traffic explicitly before executing them.

1. Disable payload collection, caching, automatic retries, dynamic fallbacks and
   active model inference health probes at the gateway. The Worker also forces
   `cf-aig-collect-log-payload:false`, `cf-aig-skip-cache:true` and
   `cf-aig-max-attempts:1`. Retain metadata logs and choose deletion/retention.
2. Keep product/environment kill switches on while deploying. Verify readiness,
   then temporarily enable only the isolated synthetic environment.
3. Exchange a synthetic classroom code on two devices. Verify distinct principal
   attribution and shared tenant/product/environment; revoke an activation and
   then its parent, verifying subsequent requests are denied locally.
4. Inspect Cloudflare logs using `request_id`, `product_id`, `environment_id`,
   `tenant` and `principal` (the five-entry metadata limit). Correlate `request_id`
   with D1 attempts for `alias`, `policy_version`, `route_id` and `endpoint`;
   those are not separate Cloudflare custom-metadata filters.
   Search prompt/response/error sentinels: none may appear in stored payloads,
   logs, exports, or diagnostic captures. Check both successful and failed calls.
5. Exercise success, refusal, truncation, missing usage, provider 429/5xx,
   deadline, disconnect after request acceptance and duplicate idempotency keys.
   Verify actual upstream attempt count, not just the Worker-to-gateway count.
   Cloudflare timeout is first-response time; our deadline must bound full reads.
6. Reconcile provider usage against Cloudflare observed cost and D1/DO accounting.
   An ambiguous operation may have a conservative charge greater than observed
   usage; never overwrite the ledger with dashboard totals.
7. Verify a bad/missing provider key fails without credit billing, and caller
   metadata/header spoofing cannot alter attribution or logging controls.
8. Kill the environment, restore the prior route configuration, and verify
   explicit direct SDK rollback without automatic resend. Record sanitized
   evidence, route/config versions and request IDs privately before promotion.

Any payload retention, extra physical attempt, authorization bypass, wrong model,
unexpected credit billing or unexplained accounting gap blocks activation.

## Upgrades

Use stock packages; never patch `node_modules`. Upgrade in a separate PR, run
`pnpm check` and the SDK/Cloudflare transport tests, compare outgoing wire shapes
and rerun hosted acceptance for affected routes. Do not assume SDK unified finish
reasons preserve our public response contract. No current local test proves
Cloudflare's server-side behavior or replaces the canary.
