import { z } from "zod";

import { readBoundedBytes } from "./http";
import type { ChatCompletionChoice, ParsedGatewayRequest } from "./schemas";

const reservedCredentialBindings = new Set([
  "ADMIN_TOKEN",
  "CREDENTIAL_PEPPER",
  "DASHBOARD_TOKEN",
  "DB",
  "DEPLOYMENT_ENV",
  "ENABLE_DEV_ISSUER",
  "MAX_BODY_BYTES",
  "PROVIDER_ROUTES_JSON",
  "QUOTA",
  "TOKEN_ISSUER",
  "TOKEN_SIGNING_SECRET",
]);

const providerChatResponseSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("chat.completion"),
    created: z.number().int().nonnegative().optional(),
    model: z.string().min(1),
    choices: z
      .array(
        z
          .object({
            index: z.number().int().nonnegative(),
            message: z
              .object({
                role: z.literal("assistant"),
                content: z.string().nullable(),
                refusal: z.string().nullable().optional(),
              })
              .passthrough(),
            finish_reason: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .min(1),
    usage: z.object({}).passthrough().optional(),
  })
  .passthrough();

const responseContentSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("output_text"),
      text: z.string(),
      annotations: z.array(z.unknown()).optional(),
    })
    .passthrough(),
  z.object({ type: z.literal("refusal"), refusal: z.string() }).passthrough(),
]);

const responseOutputSchema = z.discriminatedUnion("type", [
  z
    .object({
      id: z.string().min(1),
      type: z.literal("message"),
      role: z.literal("assistant"),
      status: z.string().optional(),
      content: z.array(responseContentSchema),
    })
    .passthrough(),
  z
    .object({
      id: z.string().min(1),
      type: z.literal("reasoning"),
      status: z.string().optional(),
      summary: z.array(
        z
          .object({ type: z.literal("summary_text"), text: z.string() })
          .passthrough(),
      ),
    })
    .passthrough(),
]);

const providerResponsesResponseSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("response"),
    created_at: z.number().int().nonnegative().optional(),
    model: z.string().min(1),
    status: z.string(),
    incomplete_details: z
      .object({ reason: z.string().nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
    output: z.array(responseOutputSchema),
    usage: z.object({}).passthrough().optional(),
  })
  .passthrough();

const routeFields = {
  id: z.string().min(1).max(100),
  model: z.string().min(1).max(200),
  endpoints: z.array(z.enum(["chat", "responses"])).min(1),
  supportsImages: z.boolean(),
  supportsReasoning: z.boolean(),
  supportsStructuredJson: z.boolean(),
  timeoutMs: z.number().int().min(1000).max(120_000),
};

const fixtureRouteSchema = z
  .object({
    ...routeFields,
    adapter: z.literal("fixture"),
    provider: z.literal("fixture"),
    profile: z.literal("fixture"),
  })
  .strict();

const compatibleRouteSchema = z
  .object({
    ...routeFields,
    adapter: z.literal("openai-compatible"),
    provider: z.enum([
      "openai",
      "openrouter",
      "opencode",
      "deepseek",
      "custom",
    ]),
    profile: z.enum([
      "openai",
      "openrouter",
      "opencode-go",
      "opencode-zen",
      "deepseek",
      "custom",
    ]),
    baseUrl: z.string().url(),
    credentialBinding: z.string().regex(/^[A-Z][A-Z0-9_]*$/u),
    attribution: z
      .object({
        referer: z.string().url(),
        title: z
          .string()
          .min(1)
          .max(100)
          .refine((value) => !/[\r\n]/u.test(value)),
        titleHeader: z.enum(["x-title", "x-openrouter-title"]),
      })
      .strict()
      .optional(),
  })
  .strict();

const routeSchema = z
  .discriminatedUnion("adapter", [fixtureRouteSchema, compatibleRouteSchema])
  .superRefine((route, context) => {
    if (route.adapter === "fixture") return;
    if (!route.baseUrl.startsWith("https://")) {
      context.addIssue({
        code: "custom",
        message: "provider baseUrl must use HTTPS",
      });
    }
    const baseUrl = new URL(route.baseUrl);
    if (
      baseUrl.username ||
      baseUrl.password ||
      baseUrl.search ||
      baseUrl.hash
    ) {
      context.addIssue({
        code: "custom",
        message:
          "provider baseUrl must not embed credentials, query parameters, or fragments",
      });
    }
    if (reservedCredentialBindings.has(route.credentialBinding)) {
      context.addIssue({
        code: "custom",
        message: "provider route must use a dedicated credential binding",
      });
    }
    const providerForProfile = {
      openai: "openai",
      openrouter: "openrouter",
      "opencode-go": "opencode",
      "opencode-zen": "opencode",
      deepseek: "deepseek",
      custom: "custom",
    }[route.profile];
    if (route.provider !== providerForProfile) {
      context.addIssue({
        code: "custom",
        message: "provider must match the selected route profile",
      });
    }
    if (route.attribution && route.profile !== "openrouter") {
      context.addIssue({
        code: "custom",
        message:
          "attribution headers are supported only by OpenRouter profiles",
      });
    }
    if (route.attribution) {
      const referer = new URL(route.attribution.referer);
      if (
        referer.protocol !== "https:" ||
        referer.username ||
        referer.password ||
        referer.search ||
        referer.hash
      ) {
        context.addIssue({
          code: "custom",
          message: "provider attribution referer must be a safe HTTPS URL",
        });
      }
    }
  });

export type ProviderRoute = z.infer<typeof routeSchema>;

export function parseProviderRoutes(
  value: string,
): ReadonlyMap<string, ProviderRoute> {
  const raw = z.record(routeSchema).parse(JSON.parse(value) as unknown);
  const routes = new Map<string, ProviderRoute>();
  for (const [key, route] of Object.entries(raw)) {
    if (key !== route.id)
      throw new Error("provider route key must match route id");
    routes.set(key, route);
  }
  return routes;
}

export type NormalizedUsage = {
  inputTokens?: number;
  outputTokens?: number;
};

export type PreparedProvider = {
  route: ProviderRoute;
  credential: string | null;
};

export function prepareProvider(options: {
  route: ProviderRoute;
  deploymentEnvironment: string;
  getSecret: (binding: string) => string | undefined;
}): PreparedProvider {
  if (options.route.adapter === "fixture") {
    if (!["development", "test"].includes(options.deploymentEnvironment)) {
      throw new ProviderError("provider_unavailable", 503, 0);
    }
    return { route: options.route, credential: null };
  }
  const credential = options.getSecret(options.route.credentialBinding);
  if (!credential || credential.length < 16) {
    throw new ProviderError("provider_unavailable", 503, 0);
  }
  return { route: options.route, credential };
}

export type ProviderResult = {
  status: number;
  body: Record<string, unknown>;
  usage: NormalizedUsage;
  latencyMs: number;
};

export class ProviderError extends Error {
  constructor(
    readonly errorClass:
      | "provider_timeout"
      | "provider_unavailable"
      | "provider_rejected"
      | "provider_protocol",
    readonly status: number,
    readonly latencyMs: number,
  ) {
    super(errorClass);
  }
}

function abortedProviderError(latencyMs: number) {
  return new ProviderError("provider_timeout", 504, latencyMs);
}

function numericUsage(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function normalizeUsage(
  body: Record<string, unknown>,
  endpoint: "chat" | "responses",
): NormalizedUsage {
  const usage =
    typeof body.usage === "object" && body.usage !== null
      ? (body.usage as Record<string, unknown>)
      : {};
  const inputTokens = numericUsage(
    endpoint === "chat" ? usage.prompt_tokens : usage.input_tokens,
  );
  const outputTokens = numericUsage(
    endpoint === "chat" ? usage.completion_tokens : usage.output_tokens,
  );
  return {
    ...(inputTokens === undefined ? {} : { inputTokens }),
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

type ProviderChatChoice = z.infer<
  typeof providerChatResponseSchema
>["choices"][number];

function normalizeChatChoice(choice: ProviderChatChoice): ChatCompletionChoice {
  const providerRefusal = choice.message.refusal;
  const hasRefusal = providerRefusal !== undefined && providerRefusal !== null;
  if (hasRefusal || choice.finish_reason === "content_filter") {
    return {
      index: choice.index,
      message: {
        role: choice.message.role,
        content: null,
        refusal: providerRefusal || null,
      },
      finish_reason: "content_filter",
    };
  }
  const finishReason =
    choice.finish_reason === "length"
      ? "length"
      : choice.finish_reason === "stop" &&
          typeof choice.message.content === "string" &&
          choice.message.content.length > 0
        ? "stop"
        : null;
  return {
    index: choice.index,
    message: {
      role: choice.message.role,
      content: choice.message.content,
      refusal: null,
    },
    finish_reason: finishReason,
  };
}

function projectProviderBody(
  parsed: unknown,
  endpoint: "chat" | "responses",
): Pick<ProviderResult, "body" | "usage"> | undefined {
  if (endpoint === "chat") {
    const validated = providerChatResponseSchema.safeParse(parsed);
    if (!validated.success) return undefined;
    const body = validated.data;
    const usage = normalizeUsage(body, endpoint);
    return {
      body: {
        id: body.id,
        object: body.object,
        ...(body.created === undefined ? {} : { created: body.created }),
        model: body.model,
        choices: body.choices.map(normalizeChatChoice),
        ...(usage.inputTokens === undefined || usage.outputTokens === undefined
          ? {}
          : {
              usage: {
                prompt_tokens: usage.inputTokens,
                completion_tokens: usage.outputTokens,
                total_tokens: usage.inputTokens + usage.outputTokens,
              },
            }),
      },
      usage,
    };
  }
  const validated = providerResponsesResponseSchema.safeParse(parsed);
  if (!validated.success) return undefined;
  const body = validated.data;
  const usage = normalizeUsage(body, endpoint);
  return {
    body: {
      id: body.id,
      object: body.object,
      ...(body.created_at === undefined ? {} : { created_at: body.created_at }),
      model: body.model,
      status: body.status,
      ...(body.incomplete_details === undefined
        ? {}
        : {
            incomplete_details:
              body.incomplete_details === null
                ? null
                : { reason: body.incomplete_details.reason ?? null },
          }),
      output: body.output.map((item) =>
        item.type === "message"
          ? {
              id: item.id,
              type: item.type,
              role: item.role,
              ...(item.status === undefined ? {} : { status: item.status }),
              content: item.content.map((content) =>
                content.type === "output_text"
                  ? { type: content.type, text: content.text, annotations: [] }
                  : { type: content.type, refusal: content.refusal },
              ),
            }
          : {
              id: item.id,
              type: item.type,
              ...(item.status === undefined ? {} : { status: item.status }),
              summary: item.summary.map(({ type, text }) => ({ type, text })),
            },
      ),
      ...(usage.inputTokens === undefined || usage.outputTokens === undefined
        ? {}
        : {
            usage: {
              input_tokens: usage.inputTokens,
              output_tokens: usage.outputTokens,
              total_tokens: usage.inputTokens + usage.outputTokens,
            },
          }),
    },
    usage,
  };
}

function containsSecret(value: unknown, secret: string): boolean {
  if (typeof value === "string") return value.includes(secret);
  if (Array.isArray(value))
    return value.some((item) => containsSecret(item, secret));
  if (typeof value === "object" && value !== null)
    return Object.values(value).some((item) => containsSecret(item, secret));
  return false;
}

function fixtureResult(
  request: ParsedGatewayRequest,
  route: ProviderRoute,
  latencyMs: number,
): ProviderResult {
  if (request.endpoint === "chat") {
    return {
      status: 200,
      body: {
        id: "chatcmpl_fixture",
        object: "chat.completion",
        created: 0,
        model: route.model,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "fixture response",
              refusal: null,
            },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
      },
      usage: { inputTokens: 8, outputTokens: 3 },
      latencyMs,
    };
  }
  return {
    status: 200,
    body: {
      id: "resp_fixture",
      object: "response",
      created_at: 0,
      model: route.model,
      status: "completed",
      output: [
        {
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          content: [
            { type: "output_text", text: "fixture response", annotations: [] },
          ],
        },
      ],
      usage: { input_tokens: 8, output_tokens: 3, total_tokens: 11 },
    },
    usage: { inputTokens: 8, outputTokens: 3 },
    latencyMs,
  };
}

function compatibleRequestBody(
  request: ParsedGatewayRequest,
  route: Extract<ProviderRoute, { adapter: "openai-compatible" }>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    ...request.body,
    model: route.model,
    stream: false,
  };
  if (
    request.endpoint === "chat" &&
    route.profile === "openrouter" &&
    request.body.reasoning_effort
  ) {
    delete body.reasoning_effort;
    body.reasoning = { effort: request.body.reasoning_effort };
  }
  return body;
}

export async function callProvider(options: {
  request: ParsedGatewayRequest;
  prepared: PreparedProvider;
  maxResponseBytes: number;
  signal: AbortSignal;
  onDispatch: () => void;
  fetcher?: typeof fetch;
}): Promise<ProviderResult> {
  const startedAt = Date.now();
  const { request } = options;
  const { route, credential } = options.prepared;
  if (!route.endpoints.includes(request.endpoint)) {
    throw new ProviderError("provider_protocol", 500, Date.now() - startedAt);
  }
  if (options.signal.aborted)
    throw abortedProviderError(Date.now() - startedAt);
  if (route.adapter === "fixture") {
    options.onDispatch();
    return fixtureResult(request, route, Date.now() - startedAt);
  }

  if (!credential)
    throw new ProviderError(
      "provider_unavailable",
      503,
      Date.now() - startedAt,
    );
  const path =
    request.endpoint === "chat" ? "/v1/chat/completions" : "/v1/responses";
  const upstreamBody = compatibleRequestBody(request, route);
  const headers: Record<string, string> = {
    authorization: `Bearer ${credential}`,
    "content-type": "application/json",
  };
  if (route.attribution) {
    headers["http-referer"] = route.attribution.referer;
    headers[route.attribution.titleHeader] = route.attribution.title;
  }
  try {
    options.onDispatch();
    const response = await (options.fetcher ?? fetch)(
      `${route.baseUrl.replace(/\/$/u, "")}${path}`,
      {
        method: "POST",
        redirect: "manual",
        headers,
        body: JSON.stringify(upstreamBody),
        signal: options.signal,
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError(
        "provider_rejected",
        response.status,
        Date.now() - startedAt,
      );
    }
    const declaredLength = Number(response.headers.get("content-length") ?? 0);
    if (declaredLength > options.maxResponseBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ProviderError("provider_protocol", 502, Date.now() - startedAt);
    }
    const bytes = await readBoundedBytes(
      response.body,
      options.maxResponseBytes,
    );
    if (!bytes)
      throw new ProviderError("provider_protocol", 502, Date.now() - startedAt);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      throw new ProviderError("provider_protocol", 502, Date.now() - startedAt);
    }
    const projected = projectProviderBody(parsed, request.endpoint);
    if (
      !projected ||
      projected.body.model !== route.model ||
      containsSecret(projected.body, credential)
    )
      throw new ProviderError("provider_protocol", 502, Date.now() - startedAt);
    return {
      status: response.status,
      ...projected,
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (options.signal.aborted)
      throw abortedProviderError(Date.now() - startedAt);
    throw new ProviderError(
      "provider_unavailable",
      503,
      Date.now() - startedAt,
    );
  }
}
