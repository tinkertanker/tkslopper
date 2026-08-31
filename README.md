# tkslopper

`tkslopper` is Tinkertanker's shared managed-inference boundary. It has two bounded components:

- a **control plane** for products, environments, entitlements, activation codes, service credentials, short-lived grants, revocation, and kill switches;
- a **data plane** that resolves capability aliases, enforces policy and exact per-principal reservations, invokes one configured provider route, normalizes usage/errors, and records metadata-only attempt provenance.

It intentionally does **not** own product prompts, workflows, retrieval, tools, memory, uploads, artifacts, classroom UX, payment UX, student records, provider fallback, semantic retries, or response caching.

> [!IMPORTANT]
> This repository is a deployable public scaffold, not a running production service. No Cloudflare resources, provider keys, billing integrations, domains, or production routes are included.

## Architecture

```diagram
Product backend ──service credential──▶ Control Worker ──short grant──┐
Native app ──access code + device───▶ Control Worker ──short grant───┤
                                                                    ▼
                              D1 policy ◀──── Gateway Worker ───▶ Provider
                                                  │
                                                  ▼
                                  per-principal Durable Object
                                  (RPM/TPM/concurrency/budget)
```

Both Workers share one D1 database. The control plane is the only public writer of identity and entitlement policy. The gateway derives product, environment, tenant, and principal from a signed, database-backed grant; client attribution overrides are rejected. Provider routes are deployment configuration, and only versioned capability aliases are public.

See [the architecture overview](docs/architecture.md) and [decision records](docs/adr/README.md).

## Supported inference surface

- `POST /v1/chat/completions`
- `POST /v1/responses`
- JSON responses only; `stream: true` is rejected
- selected text, image-input, strict JSON, token-limit, temperature, and explicitly enabled reasoning-effort fields
- no tools, audio, files, fine-tuning, assistants, batches, arbitrary provider/model selection, retry, fallback, or cache API

This is intentionally a narrow, versioned OpenAI-compatible shape. It is not advertised as full OpenAI API compatibility. See [the OpenAPI specification](openapi/tkslopper.openapi.yaml).

Example capability aliases (policy data, not hard-coded product behavior):

- `text.chat.v1`
- `json.strict.v1`
- `vision.classify.v1`
- `long-context.chat.v1`

## Integration examples

- [Service-to-service](examples/service-to-service.ts): a trusted product backend exchanges its service credential for a short grant, then calls the gateway without exposing either backend or provider credentials to an app.
- [Direct native client](examples/direct-client.ts): an installed app exchanges a bounded access code and pseudonymous device identifier for a short grant. Browser clients should remain behind a trusted product backend until an explicit CORS policy is approved.

## Local development

Prerequisites: Node.js 22+, pnpm 10+, and a Cloudflare account only if you later choose to deploy.

```bash
pnpm install
cp .dev.vars.example apps/control-plane/.dev.vars
cp .dev.vars.example apps/gateway/.dev.vars
# Replace every blank/placeholder with independent random local values.
pnpm migration:check
pnpm dev:control-plane
# In another terminal:
pnpm dev:gateway
```

Apply migrations to Wrangler's local D1 state before exercising the Workers:

```bash
pnpm wrangler d1 migrations apply tkslopper --local --config apps/control-plane/wrangler.jsonc
```

The checked-in fixture provider works only when `DEPLOYMENT_ENV` is `development` or `test`; it cannot run in production. Set `ENABLE_DEV_ISSUER=true` only in a local control-plane `.dev.vars` when using the admin-only test issuer.

Use the admin CLI against a local control Worker:

```bash
export TKSLOPPER_CONTROL_PLANE_URL=http://127.0.0.1:8787
export TKSLOPPER_ADMIN_TOKEN='your local ADMIN_TOKEN'
pnpm admin -- help
```

The CLI writes one-time service credentials and access codes to stdout. Do not put that output in shell history, tickets, logs, or source control.

## Validation

```bash
pnpm check
pnpm audit --audit-level=high
```

`pnpm check` runs format, lint, type checking, unit/integration/contract/adversarial tests, migration application, OpenAPI validation, Worker dry-runs, and public-repository hygiene checks. CI also scans the full Git history with Gitleaks.

## Deployment

Deployment is deliberately not automated from this repository. Follow [the deployment runbook](docs/runbooks/deployment.md), complete [the production decisions](docs/production-decisions.md), and obtain separate authorization before creating or changing infrastructure. Secrets must be supplied with `wrangler secret put`; never place them in Wrangler vars or committed files.

## Security

Read [SECURITY.md](SECURITY.md) before reporting a vulnerability. Never open a public issue containing credentials, access codes, prompts/responses, customer data, or deployment details.

## License

[MIT](LICENSE)
