# First deployment from an operator machine

This is the shortest safe path from a fresh Cloudflare account to a working class. Run it on a trusted machine with `wrangler login` already done. Nothing here needs secrets in the repository, shell history or chat: `wrangler secret put` prompts for each value.

The general [deployment runbook](deployment.md) still applies for later production changes.

## 0. Before you start

- Node.js 22+, pnpm 10+, `pnpm install` in a clone of this repository, and `pnpm wrangler whoami` showing the right account.
- One upstream provider API key (for example OpenAI or OpenRouter) created for tkslopper only.
- Decide the two hostnames. The simplest option is the account's `workers.dev` subdomain:
  - control plane: `https://tkslopper-control-plane.<subdomain>.workers.dev`
  - gateway: `https://tkslopper-gateway.<subdomain>.workers.dev`

  Custom domains work the same way; use them in place of the `workers.dev` names below.

## 1. Create the database

```bash
pnpm wrangler d1 create tkslopper
```

Note the `database_id` it prints.

## 2. Write private deployment configuration

Keep production configuration out of git in `deploy/` (ignored by `.gitignore`):

```bash
mkdir -p deploy
cp apps/control-plane/wrangler.jsonc deploy/control-plane.jsonc
cp apps/gateway/wrangler.jsonc deploy/gateway.jsonc
```

In **both** files:

- set `"main"` to `"../apps/<worker>/src/index.ts"` and `"migrations_dir"` to `"../db/migrations"`;
- set `"database_id"` to the value from step 1;
- set `"workers_dev": true` (or add your custom-domain `routes`);
- set `"DEPLOYMENT_ENV": "production"`;
- set `"TOKEN_ISSUER"` to the **control-plane** origin, for example `"https://tkslopper-control-plane.<subdomain>.workers.dev"`, identically in both files.

In `deploy/control-plane.jsonc` also:

- delete the whole `"access"` block (it only simulates Access locally);
- set `"DASHBOARD_ACCESS_AUD"` to `"pending"` for now; step 6 replaces it;
- set `"GATEWAY_PUBLIC_URL"` to the gateway origin (no `/v1` or other path), for example `"https://tkslopper-gateway.<subdomain>.workers.dev"`, so student cards show the right base URL;
- keep `"ENABLE_DEV_ISSUER": "false"`.

In `deploy/gateway.jsonc` replace `PROVIDER_ROUTES_JSON` with one real route. It must be a JSON string; the fixture routes are refused in production. For OpenAI:

```json
{
  "openai-mini": {
    "id": "openai-mini",
    "adapter": "openai-compatible",
    "provider": "openai",
    "profile": "openai",
    "model": "gpt-4o-mini",
    "baseUrl": "https://api.openai.com",
    "credentialBinding": "UPSTREAM_API_KEY",
    "endpoints": ["chat", "responses"],
    "supportsImages": true,
    "supportsReasoning": false,
    "supportsStructuredJson": true,
    "timeoutMs": 60000
  }
}
```

For OpenRouter use `"provider": "openrouter"`, `"profile": "openrouter"`, `"baseUrl": "https://openrouter.ai/api"` and an OpenRouter model name. The gateway appends `/v1` to `baseUrl`. A provider may report a dated snapshot such as `gpt-4o-mini-2024-07-18`; that is accepted automatically. List any other exact name it reports in `"acceptedModels"`.

## 3. Apply migrations

```bash
pnpm wrangler d1 migrations apply tkslopper --remote --config deploy/control-plane.jsonc
```

## 4. Set secrets

Generate each value independently, for example with `openssl rand -base64 48`, and paste it at the prompt. Use the **same** signing secret for both Workers, and different values for everything else.

```bash
pnpm wrangler secret put TOKEN_SIGNING_SECRET --config deploy/control-plane.jsonc
pnpm wrangler secret put CREDENTIAL_PEPPER --config deploy/control-plane.jsonc
pnpm wrangler secret put ADMIN_TOKEN --config deploy/control-plane.jsonc
pnpm wrangler secret put TOKEN_SIGNING_SECRET --config deploy/gateway.jsonc
pnpm wrangler secret put UPSTREAM_API_KEY --config deploy/gateway.jsonc
```

Keep `ADMIN_TOKEN` in a password manager: it is the break-glass credential for the admin API.

## 5. Deploy

Deploy the gateway first, then the control plane:

```bash
pnpm wrangler deploy --config deploy/gateway.jsonc
pnpm wrangler deploy --config deploy/control-plane.jsonc
curl -sS https://tkslopper-gateway.<subdomain>.workers.dev/healthz
curl -sS https://tkslopper-control-plane.<subdomain>.workers.dev/healthz
```

Both health checks must return `"status":"ok"`. A 500 usually means a missing secret, a signing secret shorter than 32 characters, an `http:` issuer, or a fixture route left in production configuration.

## 6. Protect the dashboard with Cloudflare Access

In Cloudflare Zero Trust, create one self-hosted Access application covering **both** `<control-plane host>/dashboard*` and `<control-plane host>/admin/v1/dashboard`, with an allow policy listing your operators' emails. (On `workers.dev` you can instead enable Access from the Worker's settings.) Copy the application's audience (AUD) tag into `DASHBOARD_ACCESS_AUD` in `deploy/control-plane.jsonc` and deploy the control plane again.

Do not add a bypass policy. Only `/dashboard*` and `/admin/v1/dashboard` are behind Access; the rest of `/admin/v1/*` requires `ADMIN_TOKEN`.

Add a Cloudflare rate-limiting rule for `POST <control-plane host>/v1/activations` (for example 20 requests per minute per IP). A correct join code is never locked out, so this edge limit is what bounds repeated wrong-code attempts and their hashing cost.

## 7. Make yourself an admin

```bash
read -rs TKSLOPPER_ADMIN_TOKEN && export TKSLOPPER_ADMIN_TOKEN
export TKSLOPPER_CONTROL_PLANE_URL=https://tkslopper-control-plane.<subdomain>.workers.dev
pnpm admin -- admins grant you@example.com
```

Open `<control plane>/dashboard`, sign in through Access, and check that Settings and Classes appear.

## 8. First class

In the dashboard:

1. **Settings, Create product**, for example slug `classroom`.
2. **Settings, Create environment** for that product. The defaults (600 RPM, 2,000,000 TPM, concurrency 20) are sized for a class; change them later with **Edit environment**.
3. **Settings, Set model alias**: alias `text.chat.v1`, endpoint `chat`, route `openai-mini`, `max_input_tokens` 400000 (a byte budget), `max_output_tokens` 4096, and your provider's prices in microcents per million tokens (US$0.15 per million is 15000000). Add a second alias row with endpoint `responses` if students will use the Responses API.
4. **Classes, Create class** with the alias, budgets and today's time window, add one group per student, then issue all keys and download the student cards.

Check one key before class:

```bash
curl -sS https://tkslopper-gateway.<subdomain>.workers.dev/v1/models -H "Authorization: Bearer tkgk_..."
curl -sS https://tkslopper-gateway.<subdomain>.workers.dev/v1/chat/completions \
  -H "Authorization: Bearer tkgk_..." -H "Content-Type: application/json" \
  -d '{"model":"text.chat.v1","messages":[{"role":"user","content":"Say hello"}]}'
```

## Rolling back

`pnpm wrangler rollback --config deploy/<worker>.jsonc` returns a Worker to its previous version. Pause a class or kill-switch the environment from the dashboard to stop traffic immediately. Migrations are additive; do not delete them.
