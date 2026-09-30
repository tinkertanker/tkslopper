import { z } from "zod";

export const DATABASE_SCHEMA_VERSION = "2026-09-03.pre-release.3";

export const identifierSchema = z
  .string()
  .min(2)
  .max(100)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/u);
export const capabilitySchema = z
  .string()
  .min(2)
  .max(100)
  .regex(/^[a-z][a-z0-9._:-]*\.v[1-9][0-9]*$/u);
export const capabilitiesSchema = z
  .array(capabilitySchema)
  .min(1)
  .max(50)
  .transform((values) => [...new Set(values)]);

const imageUrlSchema = z
  .string()
  .max(8_000_000)
  .refine(
    (value) => value.startsWith("https://") || value.startsWith("data:image/"),
    {
      message: "image URL must use https or an image data URL",
    },
  );

const chatContentPartSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("text"), text: z.string().max(2_000_000) })
    .strict(),
  z
    .object({
      type: z.literal("image_url"),
      image_url: z
        .object({
          url: imageUrlSchema,
          detail: z.enum(["auto", "low", "high"]).optional(),
        })
        .strict(),
    })
    .strict(),
]);

const chatMessageSchema = z
  .object({
    role: z.enum(["system", "developer", "user", "assistant"]),
    content: z.union([
      z.string().max(2_000_000),
      z.array(chatContentPartSchema).min(1).max(100),
    ]),
  })
  .strict();

const jsonSchemaFormat = z
  .object({
    type: z.literal("json_schema"),
    json_schema: z
      .object({
        name: identifierSchema,
        description: z.string().max(1000).optional(),
        strict: z.boolean().optional(),
        schema: z.record(z.unknown()),
      })
      .strict(),
  })
  .strict();

export const chatRequestSchema = z
  .object({
    model: capabilitySchema,
    messages: z.array(chatMessageSchema).min(1).max(1000),
    stream: z.literal(false).optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_tokens: z.number().int().min(1).max(200_000).optional(),
    max_completion_tokens: z.number().int().min(1).max(200_000).optional(),
    response_format: z
      .union([
        z.object({ type: z.literal("json_object") }).strict(),
        jsonSchemaFormat,
      ])
      .optional(),
    reasoning_effort: z.enum(["low", "medium", "high"]).optional(),
    stop: z
      .union([z.string().max(500), z.array(z.string().max(500)).max(20)])
      .optional(),
    seed: z.number().int().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.max_tokens === undefined ||
      value.max_completion_tokens === undefined,
    {
      message: "max_tokens and max_completion_tokens are mutually exclusive",
    },
  );

export const chatCompletionFinishReasonSchema = z
  .enum(["stop", "length", "content_filter"])
  .nullable();

export const chatCompletionChoiceSchema = z
  .object({
    index: z.number().int().nonnegative(),
    message: z
      .object({
        role: z.literal("assistant"),
        content: z.string().nullable(),
        refusal: z.string().min(1).nullable(),
      })
      .strict(),
    finish_reason: chatCompletionFinishReasonSchema,
  })
  .strict()
  .superRefine((choice, context) => {
    const { content, refusal } = choice.message;
    if (
      choice.finish_reason === "stop" &&
      (content === null || content.length === 0 || refusal !== null)
    ) {
      context.addIssue({
        code: "custom",
        message: "a complete Chat choice requires non-empty content",
      });
    }
    if (choice.finish_reason === "length" && refusal !== null) {
      context.addIssue({
        code: "custom",
        message: "a truncated Chat choice cannot contain a refusal",
      });
    }
    if (choice.finish_reason === "content_filter" && content !== null) {
      context.addIssue({
        code: "custom",
        message: "a refused Chat choice cannot contain assistant content",
      });
    }
    if (choice.finish_reason === null && refusal !== null) {
      context.addIssue({
        code: "custom",
        message: "an incomplete Chat choice cannot contain a refusal",
      });
    }
  });

export const chatCompletionResponseSchema = z
  .object({
    id: z.string().min(1),
    object: z.literal("chat.completion"),
    created: z.number().int().nonnegative().optional(),
    model: capabilitySchema,
    choices: z.array(chatCompletionChoiceSchema).min(1),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative(),
        completion_tokens: z.number().int().nonnegative(),
        total_tokens: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
  })
  .strict();

const responseContentPartSchema = z.discriminatedUnion("type", [
  z
    .object({ type: z.literal("input_text"), text: z.string().max(2_000_000) })
    .strict(),
  z
    .object({
      type: z.literal("input_image"),
      image_url: imageUrlSchema,
      detail: z.enum(["auto", "low", "high"]).optional(),
    })
    .strict(),
]);

const responseInputItemSchema = z
  .object({
    role: z.enum(["developer", "system", "user", "assistant"]),
    content: z.union([
      z.string().max(2_000_000),
      z.array(responseContentPartSchema).min(1).max(100),
    ]),
  })
  .strict();

export const responsesRequestSchema = z
  .object({
    model: capabilitySchema,
    input: z.union([
      z.string().max(2_000_000),
      z.array(responseInputItemSchema).min(1).max(1000),
    ]),
    instructions: z.string().max(2_000_000).optional(),
    stream: z.literal(false).optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    max_output_tokens: z.number().int().min(1).max(200_000).optional(),
    reasoning: z
      .object({ effort: z.enum(["low", "medium", "high"]) })
      .strict()
      .optional(),
    text: z
      .object({
        format: z.union([
          z.object({ type: z.literal("text") }).strict(),
          z.object({ type: z.literal("json_object") }).strict(),
          z
            .object({
              type: z.literal("json_schema"),
              name: identifierSchema,
              description: z.string().max(1000).optional(),
              strict: z.boolean().optional(),
              schema: z.record(z.unknown()),
            })
            .strict(),
        ]),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ChatCompletionFinishReason = z.infer<
  typeof chatCompletionFinishReasonSchema
>;
export type ChatCompletionChoice = z.infer<typeof chatCompletionChoiceSchema>;
export type ChatCompletionResponse = z.infer<
  typeof chatCompletionResponseSchema
>;
export type ResponsesRequest = z.infer<typeof responsesRequestSchema>;
export type Endpoint = "chat" | "responses";

export type ParsedGatewayRequest =
  | { endpoint: "chat"; body: ChatRequest }
  | { endpoint: "responses"; body: ResponsesRequest };

/** Output limit applied when a client omits one, before the alias ceiling. */
export const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

export function inspectGatewayRequest(request: ParsedGatewayRequest): {
  alias: string;
  estimatedInputTokens: number;
  /** The client's explicit output limit, if it supplied one. */
  requestedOutputTokens: number | undefined;
  maxOutputTokens: number;
  hasImages: boolean;
  hasStructuredJson: boolean;
  reasoningEffort: "low" | "medium" | "high" | undefined;
} {
  const body = request.body;
  let images = 0;
  const visit = (value: unknown, key?: string): void => {
    if (typeof value === "string") {
      if (
        key === "image_url" ||
        (key === "url" &&
          (value.startsWith("data:image/") || value.startsWith("https://")))
      ) {
        images += 1;
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value === "object" && value !== null) {
      for (const [childKey, child] of Object.entries(value))
        visit(child, childKey);
    }
  };
  visit(body);
  let requestedOutput: number | undefined;
  let hasStructuredJson: boolean;
  let reasoningEffort: "low" | "medium" | "high" | undefined;
  if (request.endpoint === "chat") {
    requestedOutput =
      request.body.max_completion_tokens ?? request.body.max_tokens;
    hasStructuredJson = request.body.response_format !== undefined;
    reasoningEffort = request.body.reasoning_effort;
  } else {
    requestedOutput = request.body.max_output_tokens;
    hasStructuredJson =
      request.body.text?.format.type === "json_schema" ||
      request.body.text?.format.type === "json_object";
    reasoningEffort = request.body.reasoning?.effort;
  }
  return {
    alias: body.model,
    // A tokenizer-independent byte count is deliberately conservative for
    // text and inline images. Remote images reserve the alias ceiling later.
    estimatedInputTokens: Math.max(
      1,
      new TextEncoder().encode(JSON.stringify(body)).byteLength,
    ),
    requestedOutputTokens: requestedOutput,
    maxOutputTokens: requestedOutput ?? DEFAULT_MAX_OUTPUT_TOKENS,
    hasImages: images > 0,
    hasStructuredJson,
    reasoningEffort,
  };
}

/**
 * Returns the request with an explicit output limit, so the provider enforces
 * the same envelope the gateway reserved. OpenAI routes always receive
 * `max_completion_tokens`, which every OpenAI chat model accepts and its
 * reasoning models require; other compatible routes always receive the widely
 * supported `max_tokens`, whatever spelling the client chose.
 */
export function withOutputTokenLimit(
  request: ParsedGatewayRequest,
  limit: number,
  profile: string,
): ParsedGatewayRequest {
  if (request.endpoint === "responses")
    return {
      endpoint: "responses",
      body: { ...request.body, max_output_tokens: limit },
    };
  const body = { ...request.body };
  delete body.max_tokens;
  delete body.max_completion_tokens;
  if (profile === "openai") body.max_completion_tokens = limit;
  else body.max_tokens = limit;
  return { endpoint: "chat", body };
}

export const tokenExchangeSchema = z
  .object({
    capabilities: capabilitiesSchema.optional(),
    ttl_seconds: z.number().int().min(60).max(3600).optional(),
  })
  .strict();

export const activationSchema = z
  .object({
    access_code: z.string().min(20).max(256),
    device_id: z.string().min(8).max(500),
    capabilities: capabilitiesSchema.optional(),
    ttl_seconds: z.number().int().min(60).max(3600).optional(),
  })
  .strict();

export const productCreateSchema = z
  .object({ slug: identifierSchema, display_name: z.string().min(1).max(200) })
  .strict();

const tokenTtlSecondsSchema = z.number().int().min(60).max(3600);
const environmentRpmLimitSchema = z.number().int().min(1).max(100_000);
const environmentTpmLimitSchema = z.number().int().min(1).max(100_000_000);
const environmentConcurrencyLimitSchema = z.number().int().min(1).max(1000);
const environmentDailyBudgetSchema = z
  .number()
  .int()
  .min(0)
  .max(1_000_000_000_000_000);
const maxRequestBytesSchema = z.number().int().min(1024).max(10_485_760);

// Defaults are sized for one class of about 30 students sharing an
// environment; per-group classroom limits narrow them further.
export const environmentCreateSchema = z
  .object({
    product_id: identifierSchema,
    name: identifierSchema,
    audience: z.string().min(3).max(200),
    token_ttl_seconds: tokenTtlSecondsSchema.default(900),
    rpm_limit: environmentRpmLimitSchema.default(600),
    tpm_limit: environmentTpmLimitSchema.default(2_000_000),
    concurrency_limit: environmentConcurrencyLimitSchema.default(20),
    daily_budget_microcents:
      environmentDailyBudgetSchema.default(2_000_000_000),
    max_request_bytes: maxRequestBytesSchema.default(1_048_576),
  })
  .strict();

export const environmentUpdateSchema = z
  .object({
    product_id: identifierSchema,
    environment_id: identifierSchema,
    token_ttl_seconds: tokenTtlSecondsSchema.optional(),
    rpm_limit: environmentRpmLimitSchema.optional(),
    tpm_limit: environmentTpmLimitSchema.optional(),
    concurrency_limit: environmentConcurrencyLimitSchema.optional(),
    daily_budget_microcents: environmentDailyBudgetSchema.optional(),
    max_request_bytes: maxRequestBytesSchema.optional(),
  })
  .strict()
  .refine(
    (value) =>
      Object.keys(value).some(
        (key) => key !== "product_id" && key !== "environment_id",
      ),
    { message: "at least one environment setting is required" },
  );

export const aliasUpsertSchema = z
  .object({
    product_id: identifierSchema,
    environment_id: identifierSchema,
    alias: capabilitySchema,
    endpoint: z.enum(["chat", "responses"]),
    route_id: identifierSchema,
    allow_reasoning: z.boolean().default(false),
    allow_images: z.boolean().default(false),
    allow_structured_json: z.boolean().default(false),
    max_input_tokens: z.number().int().min(1).max(10_000_000),
    max_output_tokens: z.number().int().min(1).max(200_000),
    input_cost_microcents_per_million: z
      .number()
      .int()
      .min(0)
      .max(1_000_000_000_000)
      .default(0),
    output_cost_microcents_per_million: z
      .number()
      .int()
      .min(0)
      .max(1_000_000_000_000)
      .default(0),
  })
  .strict();

export const entitlementCreateSchema = z
  .object({
    product_id: identifierSchema,
    environment_id: identifierSchema,
    tenant_id: identifierSchema,
    principal_id: identifierSchema,
    source: z.enum(["dev", "stripe", "storekit", "contract"]),
    capabilities: capabilitiesSchema,
    expires_at: z.number().int().positive().nullable().default(null),
  })
  .strict();

export const serviceCredentialCreateSchema = entitlementCreateSchema
  .pick({
    product_id: true,
    environment_id: true,
    tenant_id: true,
    principal_id: true,
    capabilities: true,
  })
  .extend({ expires_at: z.number().int().positive().nullable().default(null) })
  .strict();

export const accessCodeCreateSchema = z
  .object({
    product_id: identifierSchema,
    environment_id: identifierSchema,
    tenant_id: identifierSchema,
    capabilities: capabilitiesSchema,
    expires_at: z.number().int().positive(),
    max_activations: z.number().int().min(1).max(100_000),
    max_failed_attempts: z.number().int().min(1).max(50).default(8),
  })
  .strict();

export const devIssueSchema = z
  .object({
    product_id: identifierSchema,
    environment_id: identifierSchema,
    tenant_id: identifierSchema,
    principal_id: identifierSchema,
    capabilities: capabilitiesSchema,
    ttl_seconds: z.number().int().min(60).max(3600).default(900),
  })
  .strict();

export const revokeSchema = z
  .object({
    resource_type: z.enum([
      "token_grant",
      "entitlement",
      "access_code",
      "service_credential",
    ]),
    resource_id: z.string().min(1).max(200),
  })
  .strict();

export const killSwitchSchema = z
  .object({
    resource_type: z.enum(["product", "environment"]),
    resource_id: z.string().min(1).max(200),
    enabled: z.boolean(),
  })
  .strict();
