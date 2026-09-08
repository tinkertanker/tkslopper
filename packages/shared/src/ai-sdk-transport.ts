import { createOpenAI } from "@ai-sdk/openai";
import type {
  LanguageModelV4CallOptions,
  LanguageModelV4FilePart,
  LanguageModelV4Prompt,
  LanguageModelV4TextPart,
} from "@ai-sdk/provider";

import type {
  ChatRequest,
  ParsedGatewayRequest,
  ResponsesRequest,
} from "./schemas";

type Message =
  | ChatRequest["messages"][number]
  | Exclude<ResponsesRequest["input"], string>[number];

function promptMessage(message: Message): LanguageModelV4Prompt[number] {
  const parts: Array<LanguageModelV4TextPart | LanguageModelV4FilePart> =
    typeof message.content === "string"
      ? [{ type: "text", text: message.content }]
      : message.content.map((part) => {
          if (part.type === "text" || part.type === "input_text")
            return { type: "text", text: part.text };
          const { url, detail } =
            part.type === "image_url"
              ? part.image_url
              : { url: part.image_url, detail: part.detail };
          let data: LanguageModelV4FilePart["data"];
          try {
            data = { type: "url", url: new URL(url) };
          } catch {
            // The public schema checks URL prefixes, not URL parseability.
            // Retain these bytes via the content overlay rather than rejecting
            // an accepted request before the provider can validate it.
            data = { type: "data", data: new TextEncoder().encode(url) };
          }
          return {
            type: "file",
            // Invalid URLs need a concrete construction-only media hint; the
            // original image_url (not this data representation) goes on wire.
            mediaType: data.type === "url" ? "image/*" : "image/png",
            data,
            ...(detail === undefined
              ? {}
              : { providerOptions: { openai: { imageDetail: detail } } }),
          };
        });
  if (message.role === "user") return { role: "user", content: parts };
  if (parts.every((part) => part.type === "text")) {
    const text = parts.map((part) => part.text).join("");
    return message.role === "assistant"
      ? { role: "assistant", content: [{ type: "text", text }] }
      : { role: "system", content: text };
  }
  // SDK converters support images only in user messages. Preserve the real
  // parts here; restore the public role at the wire boundary below.
  return { role: "user", content: parts };
}

/**
 * One direct SDK generation, without ai core, retries, tools, or downloads.
 * baseURL already includes /v1. The caller owns the supplied single-shot fetch,
 * redirect/size/deadline limits, raw response capture, and public projection.
 * SDK parsing errors deliberately propagate: a captured public response can be
 * valid even when the SDK rejects its refusal or partial usage representation.
 */
export async function callAiSdkTransport(options: {
  request: ParsedGatewayRequest;
  profile: string;
  model: string;
  baseURL: string;
  apiKey: string;
  headers: Record<string, string>;
  fetcher: typeof fetch;
  signal: AbortSignal;
}): Promise<void> {
  const { request } = options;
  const messages: Message[] =
    request.endpoint === "chat"
      ? request.body.messages
      : typeof request.body.input === "string"
        ? [{ role: "user", content: request.body.input }]
        : request.body.input;
  const format =
    request.endpoint === "chat"
      ? request.body.response_format
      : request.body.text?.format;
  const schema =
    format?.type === "json_schema"
      ? "json_schema" in format
        ? format.json_schema
        : format
      : undefined;
  const effort =
    request.endpoint === "chat"
      ? request.body.reasoning_effort
      : request.body.reasoning?.effort;
  const maxOutputTokens =
    request.endpoint === "chat"
      ? (request.body.max_tokens ?? request.body.max_completion_tokens)
      : request.body.max_output_tokens;
  const call: LanguageModelV4CallOptions = {
    prompt: messages.map(promptMessage),
    abortSignal: options.signal,
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(request.body.temperature === undefined
      ? {}
      : { temperature: request.body.temperature }),
    ...(request.body.top_p === undefined ? {} : { topP: request.body.top_p }),
    ...(format === undefined
      ? {}
      : {
          responseFormat:
            format.type === "text"
              ? { type: "text" }
              : {
                  type: "json",
                  ...(schema === undefined
                    ? {}
                    : {
                        schema: schema.schema,
                        name: schema.name,
                        ...(schema.description === undefined
                          ? {}
                          : { description: schema.description }),
                      }),
                },
        }),
    providerOptions: {
      openai: {
        systemMessageMode: "system",
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        ...(schema?.strict === undefined
          ? {}
          : { strictJsonSchema: schema.strict }),
        ...(request.endpoint !== "responses" ||
        request.body.instructions === undefined
          ? {}
          : { instructions: request.body.instructions }),
      },
    },
  };
  if (request.endpoint === "chat") {
    if (request.body.seed !== undefined) call.seed = request.body.seed;
    if (request.body.stop !== undefined)
      call.stopSequences =
        typeof request.body.stop === "string"
          ? [request.body.stop]
          : request.body.stop;
  }

  const provider = createOpenAI({
    baseURL: options.baseURL,
    apiKey: options.apiKey,
    headers: options.headers,
    fetch: async (url, init) => {
      const wire = JSON.parse(init?.body as string) as Record<string, unknown>;
      const key = request.endpoint === "chat" ? "messages" : "input";
      const generated = wire[key] as Array<Record<string, unknown>>;
      if (!Array.isArray(generated) || generated.length !== messages.length)
        throw new Error("Unexpected SDK prompt shape");
      // V4 has no developer role or multipart system content; converters also
      // join Chat assistant text, split Responses assistant parts, normalize
      // URLs/string-vs-array content, and emit output_text for Responses history.
      // Repair only changed role/content fields, keeping SDK message construction.
      messages.forEach((message, index) => {
        const item = generated[index]!;
        if (item.role !== message.role) item.role = message.role;
        if (JSON.stringify(item.content) !== JSON.stringify(message.content))
          item.content = message.content;
      });
      if (
        request.endpoint === "responses" &&
        typeof request.body.input === "string"
      )
        wire.input = request.body.input;

      // OpenAI model-name heuristics drop sampling/reasoning settings that
      // compatible providers may accept. Preserve explicit public settings.
      if (request.body.temperature !== undefined)
        wire.temperature = request.body.temperature;
      if (request.body.top_p !== undefined) wire.top_p = request.body.top_p;
      if (request.endpoint === "chat") {
        // maxOutputTokens loses which public token-limit spelling was chosen.
        delete wire.max_tokens;
        delete wire.max_completion_tokens;
        if (request.body.max_tokens !== undefined)
          wire.max_tokens = request.body.max_tokens;
        if (request.body.max_completion_tokens !== undefined)
          wire.max_completion_tokens = request.body.max_completion_tokens;
        if (request.body.stop !== undefined) wire.stop = request.body.stop;
        if (effort !== undefined) {
          if (options.profile === "openrouter") {
            delete wire.reasoning_effort;
            wire.reasoning = { effort };
          } else wire.reasoning_effort = effort;
        }
        if (schema?.strict === undefined && schema !== undefined) {
          const responseFormat = wire.response_format as {
            json_schema: Record<string, unknown>;
          };
          delete responseFormat.json_schema.strict;
        }
      } else {
        if (effort !== undefined) wire.reasoning = { effort };
        // SDK omits explicit text format and defaults JSON schema strict to true.
        if (format?.type === "text") wire.text = { format: { type: "text" } };
        if (schema?.strict === undefined && schema !== undefined) {
          const text = wire.text as { format: Record<string, unknown> };
          delete text.format.strict;
        }
      }
      wire.stream = false;
      return options.fetcher(url, {
        ...init,
        body: JSON.stringify(wire),
        signal: options.signal,
      });
    },
  });
  await (
    request.endpoint === "chat"
      ? provider.chat(options.model)
      : provider.responses(options.model)
  ).doGenerate(call);
}
