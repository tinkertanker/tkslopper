import { describe, expect, it } from "vitest";

import { callAiSdkTransport } from "../packages/shared/src/ai-sdk-transport";
import {
  chatRequestSchema,
  responsesRequestSchema,
  type ParsedGatewayRequest,
} from "../packages/shared/src/schemas";

const alias = "text.chat.v1";
const jsonSchema = {
  name: "answer",
  description: "A structured answer",
  schema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  },
};

// Exercise the installed createOpenAI/doGenerate implementation, not an SDK
// mock. This fixture deliberately does not satisfy SDK response schemas: these
// tests own the outbound wire contract, not the gateway's response projection.
async function captureWire(
  request: ParsedGatewayRequest,
  model: string,
  profile = "custom",
) {
  const controller = new AbortController();
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  let wire: unknown;
  const fetcher: typeof fetch = (url, init) => {
    calls.push({
      url:
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
      init,
    });
    wire = JSON.parse(init?.body as string);
    return Promise.resolve(Response.json({}));
  };
  try {
    await callAiSdkTransport({
      request,
      model,
      profile,
      baseURL: "https://provider.example.invalid/v1",
      apiKey: "public-fixture-upstream-key",
      headers: { "X-Transport-Test": "preserved" },
      fetcher,
      signal: controller.signal,
    });
  } catch (error) {
    // Never hide request-construction failures before the wire was captured.
    // Parsing the intentionally skeletal response may fail after capture.
    if (wire === undefined) throw error;
  }
  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(
    `https://provider.example.invalid/v1/${request.endpoint === "chat" ? "chat/completions" : "responses"}`,
  );
  expect(calls[0]!.init?.method).toBe("POST");
  expect(calls[0]!.init?.signal).toBe(controller.signal);
  const headers = new Headers(calls[0]!.init?.headers);
  expect(headers.get("authorization")).toBe(
    "Bearer public-fixture-upstream-key",
  );
  expect(headers.get("x-transport-test")).toBe("preserved");
  return wire;
}

const roles = ["system", "developer", "user", "assistant"] as const;
// Include URL normalization traps, inline data, and a prefix-valid URL which
// the public schema accepts but URL construction rejects. None may be fetched.
const imageUrls = [
  "https://images.example.invalid",
  "data:image/png;base64,AQID",
  "https://",
  "https://images.example.invalid/a%2Fb?q=%20",
];

describe("real AI SDK transport wire compatibility", () => {
  it.each([
    { strict: undefined, model: "gpt-5", profile: "custom", completion: false },
    {
      strict: false,
      model: "custom-physical-model",
      profile: "openrouter",
      completion: true,
    },
    { strict: true, model: "gpt-5", profile: "openrouter", completion: true },
  ])(
    "preserves Chat fields with $model, $profile, strict=$strict",
    async ({ strict, model, profile, completion }) => {
      const body = chatRequestSchema.parse({
        model: alias,
        messages: roles.flatMap((role, index) => [
          { role, content: `${role} string` },
          {
            role,
            content: [
              { type: "text", text: "first" },
              { type: "text", text: "second" },
              {
                type: "image_url",
                image_url: {
                  url: imageUrls[index],
                  ...(index === 0 ? {} : { detail: "high" }),
                },
              },
            ],
          },
        ]),
        temperature: 0,
        top_p: 0.7,
        ...(completion ? { max_completion_tokens: 321 } : { max_tokens: 123 }),
        reasoning_effort: "high",
        seed: 0,
        stop: completion ? ["END", "STOP"] : "END",
        response_format: {
          type: "json_schema",
          json_schema: {
            ...jsonSchema,
            ...(strict === undefined ? {} : { strict }),
          },
        },
      });
      const { reasoning_effort, ...expected } = body;
      expect(
        await captureWire({ endpoint: "chat", body }, model, profile),
      ).toStrictEqual({
        ...expected,
        model,
        stream: false,
        ...(profile === "openrouter"
          ? { reasoning: { effort: reasoning_effort } }
          : { reasoning_effort }),
      });
    },
  );

  it.each([
    { strict: undefined, model: "gpt-5" },
    { strict: false, model: "custom-physical-model" },
    { strict: true, model: "gpt-5" },
  ])(
    "preserves Responses fields with $model, strict=$strict",
    async ({ strict, model }) => {
      const body = responsesRequestSchema.parse({
        model: alias,
        instructions: "Keep these separate from system and developer input.",
        input: roles.flatMap((role, index) => [
          { role, content: `${role} string` },
          {
            role,
            content: [
              { type: "input_text", text: "first" },
              { type: "input_text", text: "second" },
              {
                type: "input_image",
                image_url: imageUrls[index],
                ...(index === 0 ? {} : { detail: "low" }),
              },
            ],
          },
        ]),
        stream: false,
        temperature: 0.4,
        top_p: 0,
        max_output_tokens: 456,
        reasoning: { effort: "low" },
        text: {
          format: {
            type: "json_schema",
            ...jsonSchema,
            ...(strict === undefined ? {} : { strict }),
          },
        },
      });
      expect(
        await captureWire({ endpoint: "responses", body }, model),
      ).toStrictEqual({
        ...body,
        model,
      });
    },
  );

  it.each([undefined, "text", "json_object"] as const)(
    "preserves Responses string input and format %s without inventing optional fields",
    async (format) => {
      const body = responsesRequestSchema.parse({
        model: alias,
        input: "Do not turn this into a message array.",
        instructions: "",
        ...(format === undefined ? {} : { text: { format: { type: format } } }),
      });
      expect(
        await captureWire(
          { endpoint: "responses", body },
          "custom-physical-model",
        ),
      ).toStrictEqual({
        ...body,
        model: "custom-physical-model",
        stream: false,
      });
    },
  );

  it.each([undefined, "json_object"] as const)(
    "preserves Chat format %s without inventing optional fields",
    async (format) => {
      const body = chatRequestSchema.parse({
        model: alias,
        messages: [{ role: "user", content: "Hello" }],
        ...(format === undefined ? {} : { response_format: { type: format } }),
      });
      expect(
        await captureWire({ endpoint: "chat", body }, "custom-physical-model"),
      ).toStrictEqual({
        ...body,
        model: "custom-physical-model",
        stream: false,
      });
    },
  );
});
