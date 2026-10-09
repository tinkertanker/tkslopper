import { z } from "zod";

import { HttpError } from "./http";
import type { ParsedGatewayRequest } from "./schemas";

/** Validate the native subset before admission; never silently discard controls. */
export function validateAnthropicRequest(request: ParsedGatewayRequest): void {
  const invalid = (message: string): never => {
    throw new HttpError(400, "invalid_request", message);
  };
  if (
    request.body.temperature !== undefined ||
    request.body.top_p !== undefined
  )
    invalid("this capability does not accept sampling parameters");
  if (request.endpoint === "chat" && request.body.seed !== undefined)
    invalid("this capability does not accept seed");
  const format =
    request.endpoint === "chat"
      ? request.body.response_format
      : request.body.text?.format;
  if (format?.type === "json_object")
    invalid("this capability requires json_schema for structured output");
  if (
    format?.type === "json_schema" &&
    ("json_schema" in format ? format.json_schema.strict : format.strict) ===
      false
  )
    invalid("this capability does not support non-strict JSON schema output");
  const messages =
    request.endpoint === "chat"
      ? request.body.messages
      : typeof request.body.input === "string"
        ? [{ role: "user", content: request.body.input }]
        : request.body.input;
  let conversation = false;
  for (const message of messages) {
    const system = message.role === "system" || message.role === "developer";
    if (system && conversation)
      invalid("system and developer messages must precede the conversation");
    if (!system) {
      if (!conversation && message.role !== "user")
        invalid("the conversation must start with a user message");
      conversation = true;
    }
    if (typeof message.content === "string") continue;
    for (const part of message.content) {
      if (part.type === "text" || part.type === "input_text") continue;
      if (message.role !== "user") invalid("images must be in user messages");
      const { url, detail } =
        part.type === "image_url"
          ? part.image_url
          : { url: part.image_url, detail: part.detail };
      if (detail !== undefined && detail !== "auto")
        invalid("this capability does not support image detail controls");
      if (url.startsWith("data:")) {
        if (
          !/^data:image\/(?:png|jpeg|gif|webp);base64,(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
            url,
          ) ||
          url.endsWith(",")
        )
          invalid(
            "images must be HTTPS URLs or base64 PNG, JPEG, GIF or WebP data URLs",
          );
      } else {
        try {
          const parsed = new URL(url);
          if (
            parsed.protocol !== "https:" ||
            parsed.username ||
            parsed.password
          )
            invalid("image URL must use HTTPS without credentials");
        } catch {
          invalid("image URL must use HTTPS without credentials");
        }
      }
    }
  }
  if (!conversation || messages.at(-1)?.role !== "user")
    invalid(
      "the conversation must end with a user message; assistant prefill is unsupported",
    );
}

const messageSchema = z.object({
  id: z.string().min(1),
  type: z.literal("message"),
  role: z.literal("assistant"),
  model: z.string().min(1),
  content: z.array(
    z.discriminatedUnion("type", [
      z.object({ type: z.literal("text"), text: z.string() }),
      z.object({ type: z.literal("thinking") }),
      z.object({ type: z.literal("redacted_thinking") }),
    ]),
  ),
  stop_reason: z.string().nullable(),
  usage: z.object({}).passthrough().optional(),
});

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

/** Project native bytes into the existing public projector; never expose thinking. */
export function translateAnthropicResponse(
  parsed: unknown,
  endpoint: "chat" | "responses",
): unknown {
  const validated = messageSchema.safeParse(parsed);
  if (!validated.success) return undefined;
  const body = validated.data;
  const text = body.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("");
  const refused = body.stop_reason === "refusal";
  const truncated =
    body.stop_reason === "max_tokens" ||
    body.stop_reason === "model_context_window_exceeded";
  const complete =
    (body.stop_reason === "end_turn" || body.stop_reason === "stop_sequence") &&
    text.length > 0;
  // Anthropic's input_tokens excludes cache reads and writes. Include both in
  // token accounting, but leave missing/malformed usage unknown, never zero.
  const counts = [
    body.usage?.input_tokens,
    body.usage?.cache_creation_input_tokens === undefined
      ? 0
      : body.usage.cache_creation_input_tokens,
    body.usage?.cache_read_input_tokens === undefined
      ? 0
      : body.usage.cache_read_input_tokens,
  ].map(tokenCount);
  const input = counts.every((count) => count !== undefined)
    ? tokenCount(counts.reduce((sum, count) => sum + count, 0))
    : undefined;
  const output = tokenCount(body.usage?.output_tokens);
  if (endpoint === "chat")
    return {
      id: body.id,
      object: "chat.completion",
      model: body.model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: refused ? null : text || null,
            refusal: refused ? text || "Request declined" : null,
          },
          finish_reason: refused
            ? "content_filter"
            : truncated
              ? "length"
              : complete
                ? "stop"
                : null,
        },
      ],
      usage: { prompt_tokens: input, completion_tokens: output },
    };
  const status = complete || refused ? "completed" : "incomplete";
  return {
    id: body.id,
    object: "response",
    model: body.model,
    status,
    ...(status === "incomplete"
      ? {
          incomplete_details: {
            reason: truncated ? "max_output_tokens" : null,
          },
        }
      : {}),
    output: [
      {
        id: body.id,
        type: "message",
        role: "assistant",
        status,
        content: refused
          ? [{ type: "refusal", refusal: text || "Request declined" }]
          : text
            ? [{ type: "output_text", text, annotations: [] }]
            : [],
      },
    ],
    usage: { input_tokens: input, output_tokens: output },
  };
}
