import { z } from "zod";

import { readBoundedBytes } from "./http";
import type { ParsedGatewayRequest } from "./schemas";

const reservedCredentialBindings = new Set([
  "DEPLOYMENT_ENV",
  "MAX_BODY_BYTES",
  "PROVIDER_ROUTES_JSON",
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
            finish_reason: z.string().nullable(),
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

const routeSchema = z
  .object({
    id: z.string().min(1).max(100),
    provider: z.enum(["openai-compatible", "fixture"]),
    model: z.string().min(1).max(200),
    baseUrl: z.string().url().optional(),
    credentialBinding: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]*$/u)
      .optional(),
    endpoints: z.array(z.enum(["chat", "responses"])).min(1),
    supportsImages: z.boolean(),
    supportsReasoning: z.boolean(),
    supportsStructuredJson: z.boolean(),
    timeoutMs: z.number().int().min(1000).max(120_000),
  })
  .strict()
  .superRefine((route, context) => {
    if (
      route.provider === "openai-compatible" &&
      (!route.baseUrl || !route.credentialBinding)
    ) {
      context.addIssue({
        code: "custom",
        message:
          "openai-compatible routes require baseUrl and credentialBinding",
      });
    }
    if (
      route.provider === "openai-compatible" &&
      route.baseUrl &&
      !route.baseUrl.startsWith("https://")
    ) {
      context.addIssue({
        code: "custom",
        message: "provider baseUrl must use HTTPS",
      });
    }
    if (route.provider === "openai-compatible" && route.baseUrl) {
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
    }
    if (
      route.credentialBinding &&
      reservedCredentialBindings.has(route.credentialBinding)
    ) {
      context.addIssue({
        code: "custom",
        message: "provider route must use a dedicated credential binding",
      });
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

export type NormalizedUsage = { inputTokens: number; outputTokens: number };

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
      | "provider_cancelled"
      | "provider_unavailable"
      | "provider_rejected"
      | "provider_protocol",
    readonly status: number,
    readonly latencyMs: number,
  ) {
    super(errorClass);
  }
}

function abortedProviderError(signal: AbortSignal, latencyMs: number) {
  const clientCancelled = signal.reason === "client_disconnected";
  return new ProviderError(
    clientCancelled ? "provider_cancelled" : "provider_timeout",
    clientCancelled ? 499 : 504,
    latencyMs,
  );
}

function numericUsage(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

function normalizeUsage(
  body: Record<string, unknown>,
  endpoint: "chat" | "responses",
): NormalizedUsage {
  const usage =
    typeof body.usage === "object" && body.usage !== null
      ? (body.usage as Record<string, unknown>)
      : {};
  if (endpoint === "chat") {
    return {
      inputTokens: numericUsage(usage.prompt_tokens),
      outputTokens: numericUsage(usage.completion_tokens),
    };
  }
  return {
    inputTokens: numericUsage(usage.input_tokens),
    outputTokens: numericUsage(usage.output_tokens),
  };
}

function projectProviderBody(
  parsed: unknown,
  endpoint: "chat" | "responses",
): Record<string, unknown> | undefined {
  if (endpoint === "chat") {
    const validated = providerChatResponseSchema.safeParse(parsed);
    if (!validated.success) return undefined;
    const body = validated.data;
    const usage = normalizeUsage(body, endpoint);
    return {
      id: body.id,
      object: body.object,
      ...(body.created === undefined ? {} : { created: body.created }),
      model: body.model,
      choices: body.choices.map((choice) => ({
        index: choice.index,
        message: {
          role: choice.message.role,
          content: choice.message.content,
          ...(choice.message.refusal === undefined
            ? {}
            : { refusal: choice.message.refusal }),
        },
        finish_reason: choice.finish_reason,
      })),
      ...(body.usage === undefined
        ? {}
        : {
            usage: {
              prompt_tokens: usage.inputTokens,
              completion_tokens: usage.outputTokens,
              total_tokens: usage.inputTokens + usage.outputTokens,
            },
          }),
    };
  }
  const validated = providerResponsesResponseSchema.safeParse(parsed);
  if (!validated.success) return undefined;
  const body = validated.data;
  const usage = normalizeUsage(body, endpoint);
  return {
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
    ...(body.usage === undefined
      ? {}
      : {
          usage: {
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            total_tokens: usage.inputTokens + usage.outputTokens,
          },
        }),
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
            message: { role: "assistant", content: "fixture response" },
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

export async function callProvider(options: {
  request: ParsedGatewayRequest;
  route: ProviderRoute;
  deploymentEnvironment: string;
  maxResponseBytes: number;
  signal: AbortSignal;
  getSecret: (binding: string) => string | undefined;
  fetcher?: typeof fetch;
}): Promise<ProviderResult> {
  const startedAt = Date.now();
  const { request, route } = options;
  if (!route.endpoints.includes(request.endpoint)) {
    throw new ProviderError("provider_protocol", 500, Date.now() - startedAt);
  }
  if (options.signal.aborted)
    throw abortedProviderError(options.signal, Date.now() - startedAt);
  if (route.provider === "fixture") {
    if (!["development", "test"].includes(options.deploymentEnvironment)) {
      throw new ProviderError(
        "provider_unavailable",
        503,
        Date.now() - startedAt,
      );
    }
    return fixtureResult(request, route, Date.now() - startedAt);
  }

  const secret = route.credentialBinding
    ? options.getSecret(route.credentialBinding)
    : undefined;
  if (!secret || secret.length < 16 || !route.baseUrl)
    throw new ProviderError(
      "provider_unavailable",
      503,
      Date.now() - startedAt,
    );
  const path =
    request.endpoint === "chat" ? "/v1/chat/completions" : "/v1/responses";
  const upstreamBody = { ...request.body, model: route.model, stream: false };
  try {
    const response = await (options.fetcher ?? fetch)(
      `${route.baseUrl.replace(/\/$/u, "")}${path}`,
      {
        method: "POST",
        redirect: "manual",
        headers: {
          authorization: `Bearer ${secret}`,
          "content-type": "application/json",
        },
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
    const body = projectProviderBody(parsed, request.endpoint);
    if (!body || containsSecret(body, secret))
      throw new ProviderError("provider_protocol", 502, Date.now() - startedAt);
    return {
      status: response.status,
      body,
      usage: normalizeUsage(body, request.endpoint),
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if (options.signal.aborted)
      throw abortedProviderError(options.signal, Date.now() - startedAt);
    throw new ProviderError(
      "provider_unavailable",
      503,
      Date.now() - startedAt,
    );
  }
}
