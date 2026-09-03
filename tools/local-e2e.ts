import playgroundPalChat from "../tests/fixtures/playground-pal-chat.json";
import playgroundPalLongContext from "../tests/fixtures/playground-pal-long-context.json";
import playgroundPalResponses from "../tests/fixtures/playground-pal-responses.json";
import tappletChat from "../tests/fixtures/tapplet-chat.json";
import tappletImage from "../tests/fixtures/tapplet-image.json";
import tappletModeration from "../tests/fixtures/tapplet-moderation.json";
import tappletStrictJson from "../tests/fixtures/tapplet-strict-json.json";
import vibbitChat from "../tests/fixtures/vibbit-chat.json";
import vibbitChatRepair from "../tests/fixtures/vibbit-chat-repair.json";
import vibbitResponses from "../tests/fixtures/vibbit-responses.json";
import { validateLocalOrigin } from "./local-origin";

type JsonObject = Record<string, unknown>;
type Alias = {
  alias: string;
  endpoint: "chat" | "responses";
  routeId: "fixture-text-v1" | "fixture-vision-v1";
  allowImages?: boolean;
  allowReasoning?: boolean;
  allowStructuredJson?: boolean;
};
type InferenceFixture = {
  name: string;
  endpoint: Alias["endpoint"];
  body: JsonObject;
};

const controlPlaneUrl = validateLocalOrigin(
  process.env.TKSLOPPER_CONTROL_PLANE_URL ?? "http://127.0.0.1:8787",
);
const gatewayUrl = validateLocalOrigin(
  process.env.TKSLOPPER_GATEWAY_URL ?? "http://127.0.0.1:8788",
);
const adminToken = process.env.TKSLOPPER_ADMIN_TOKEN;
if (!adminToken)
  throw new Error("TKSLOPPER_ADMIN_TOKEN is required for the local E2E flow");

async function postJson(
  baseUrl: string,
  path: string,
  body: unknown,
  token?: string,
  idempotencyKey?: string,
): Promise<{ body: JsonObject; response: Response }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`${path} returned unexpected HTTP ${response.status}`);
  const parsed: unknown = await response.json();
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new Error(`${path} returned a non-object JSON body`);
  return { body: parsed as JsonObject, response };
}

async function expectStatus(
  baseUrl: string,
  path: string,
  body: unknown,
  token: string,
  status: number,
): Promise<void> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status !== status)
    throw new Error(
      `${path} returned HTTP ${response.status}; expected ${status}`,
    );
  await response.body?.cancel();
}

async function admin(path: string, body: unknown) {
  return postJson(controlPlaneUrl, path, body, adminToken);
}

async function createProductFlow(options: {
  slug: string;
  aliases: Alias[];
  fixtures: InferenceFixture[];
}): Promise<{
  environmentId: string;
  grantId: string;
  grant: string;
  sample: InferenceFixture;
}> {
  const suffix = crypto.randomUUID().slice(0, 8);
  const { body: product } = await admin("/admin/v1/products", {
    slug: `${options.slug}-${suffix}`,
    display_name: `${options.slug} local E2E fixture`,
  });
  if (typeof product.id !== "string")
    throw new Error("product creation did not return an ID");
  const { body: environment } = await admin("/admin/v1/environments", {
    product_id: product.id,
    name: "local-e2e",
    audience: `${options.slug}:local-e2e:${suffix}`,
    token_ttl_seconds: 900,
    rpm_limit: 100,
    tpm_limit: 20_000_000,
    concurrency_limit: 5,
    daily_budget_microcents: 0,
    max_request_bytes: 8_388_608,
  });
  if (typeof environment.id !== "string")
    throw new Error("environment creation did not return an ID");

  for (const alias of options.aliases) {
    await admin("/admin/v1/aliases", {
      product_id: product.id,
      environment_id: environment.id,
      alias: alias.alias,
      endpoint: alias.endpoint,
      route_id: alias.routeId,
      allow_reasoning: alias.allowReasoning ?? false,
      allow_images: alias.allowImages ?? false,
      allow_structured_json: alias.allowStructuredJson ?? false,
      max_input_tokens: 2_000_000,
      max_output_tokens: 32_000,
      input_cost_microcents_per_million: 0,
      output_cost_microcents_per_million: 0,
    });
  }

  const capabilities = [...new Set(options.aliases.map(({ alias }) => alias))];
  const { body: createdCredential } = await admin(
    "/admin/v1/service-credentials",
    {
      product_id: product.id,
      environment_id: environment.id,
      tenant_id: "synthetic-tenant",
      principal_id: "synthetic-backend",
      capabilities,
      expires_at: null,
    },
  );
  if (typeof createdCredential.credential !== "string")
    throw new Error("service credential creation did not return a credential");
  const { body: exchanged } = await postJson(
    controlPlaneUrl,
    "/v1/token",
    { capabilities, ttl_seconds: 600 },
    createdCredential.credential,
  );
  if (
    typeof exchanged.access_token !== "string" ||
    typeof exchanged.grant_id !== "string"
  ) {
    throw new Error("token exchange did not return a complete grant");
  }

  for (const fixture of options.fixtures) {
    const path =
      fixture.endpoint === "chat" ? "/v1/chat/completions" : "/v1/responses";
    const { body, response } = await postJson(
      gatewayUrl,
      path,
      fixture.body,
      exchanged.access_token,
      crypto.randomUUID(),
    );
    if (
      body.model !== fixture.body.model ||
      !response.headers.get("x-tkslopper-request-id")
    ) {
      throw new Error(`${fixture.name} did not preserve alias provenance`);
    }
    console.log(`PASS ${fixture.name}`);
  }

  const sample = options.fixtures[0];
  if (!sample) throw new Error("product flow has no inference fixture");
  return {
    environmentId: environment.id,
    grantId: exchanged.grant_id,
    grant: exchanged.access_token,
    sample,
  };
}

const largeContext = {
  model: playgroundPalLongContext.model,
  messages: [
    {
      role: "user",
      content: playgroundPalLongContext.context_segment.repeat(
        playgroundPalLongContext.repetitions,
      ),
    },
  ],
  max_completion_tokens: playgroundPalLongContext.max_completion_tokens,
  stream: playgroundPalLongContext.stream,
};

await createProductFlow({
  slug: "vibbit",
  aliases: [
    { alias: "text.chat.v1", endpoint: "chat", routeId: "fixture-text-v1" },
    {
      alias: "text.response.v1",
      endpoint: "responses",
      routeId: "fixture-text-v1",
    },
  ],
  fixtures: [
    { name: "vibbit.chat", endpoint: "chat", body: vibbitChat },
    { name: "vibbit.chat.repair", endpoint: "chat", body: vibbitChatRepair },
    { name: "vibbit.responses", endpoint: "responses", body: vibbitResponses },
  ],
});

await createProductFlow({
  slug: "tapplet",
  aliases: [
    {
      alias: "json.strict.v1",
      endpoint: "chat",
      routeId: "fixture-text-v1",
      allowReasoning: true,
      allowStructuredJson: true,
    },
    {
      alias: "json.strict.v1",
      endpoint: "responses",
      routeId: "fixture-text-v1",
      allowReasoning: true,
      allowStructuredJson: true,
    },
    {
      alias: "vision.classify.v1",
      endpoint: "responses",
      routeId: "fixture-vision-v1",
      allowImages: true,
    },
  ],
  fixtures: [
    { name: "tapplet.chat.json", endpoint: "chat", body: tappletChat },
    {
      name: "tapplet.responses.json",
      endpoint: "responses",
      body: tappletStrictJson,
    },
    {
      name: "tapplet.responses.moderation",
      endpoint: "responses",
      body: tappletModeration,
    },
    {
      name: "tapplet.responses.image",
      endpoint: "responses",
      body: tappletImage,
    },
  ],
});

const playgroundPal = await createProductFlow({
  slug: "playground-pal",
  aliases: [
    {
      alias: "long-context.chat.v1",
      endpoint: "chat",
      routeId: "fixture-text-v1",
      allowReasoning: true,
    },
    {
      alias: "long-context.response.v1",
      endpoint: "responses",
      routeId: "fixture-text-v1",
      allowReasoning: true,
    },
  ],
  fixtures: [
    {
      name: "playground-pal.chat",
      endpoint: "chat",
      body: playgroundPalChat,
    },
    {
      name: "playground-pal.responses",
      endpoint: "responses",
      body: playgroundPalResponses,
    },
    {
      name: "playground-pal.chat.large-context",
      endpoint: "chat",
      body: largeContext,
    },
  ],
});

await admin("/admin/v1/kill-switch", {
  resource_type: "environment",
  resource_id: playgroundPal.environmentId,
  enabled: true,
});
const samplePath =
  playgroundPal.sample.endpoint === "chat"
    ? "/v1/chat/completions"
    : "/v1/responses";
await expectStatus(
  gatewayUrl,
  samplePath,
  playgroundPal.sample.body,
  playgroundPal.grant,
  403,
);
await admin("/admin/v1/kill-switch", {
  resource_type: "environment",
  resource_id: playgroundPal.environmentId,
  enabled: false,
});
await admin("/admin/v1/revoke", {
  resource_type: "token_grant",
  resource_id: playgroundPal.grantId,
});
await expectStatus(
  gatewayUrl,
  samplePath,
  playgroundPal.sample.body,
  playgroundPal.grant,
  403,
);
console.log("PASS live kill switch and grant revocation");
console.log(
  "Local tkslopper E2E conformance passed without printing credentials.",
);
