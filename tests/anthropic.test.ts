import { describe, expect, it, vi } from "vitest";
import {
  callProvider,
  chatRequestSchema,
  parseProviderRoutes,
  prepareProvider,
  type ParsedGatewayRequest,
} from "@tkslopper/shared";

const model = "claude-haiku-5-5";
const routeConfig = {
  id: "claude",
  adapter: "anthropic",
  provider: "anthropic",
  profile: "anthropic",
  model,
  baseUrl: "https://api.anthropic.com",
  credentialBinding: "ANTHROPIC_API_KEY",
  endpoints: ["chat", "responses"],
  supportsImages: true,
  supportsReasoning: true,
  supportsStructuredJson: true,
  timeoutMs: 60000,
};

function upstream(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_fixture",
    type: "message",
    role: "assistant",
    model,
    content: [
      {
        type: "thinking",
        thinking: "PRIVATE_THINKING",
        signature: "PRIVATE_SIGNATURE",
      },
      { type: "text", text: "Hello" },
      { type: "text", text: " world" },
    ],
    stop_reason: "end_turn",
    usage: {
      input_tokens: 11,
      cache_creation_input_tokens: 7,
      cache_read_input_tokens: 3,
      output_tokens: 5,
    },
    ...overrides,
  };
}

async function invoke(
  request: ParsedGatewayRequest,
  body = upstream(),
  gateway = false,
  physicalModel = model,
) {
  const route = parseProviderRoutes(
    JSON.stringify({
      claude: {
        ...routeConfig,
        model: physicalModel,
        ...(gateway
          ? {
              gateway: {
                accountId: "a".repeat(32),
                gatewayId: "test",
                credentialBinding: "GATEWAY_KEY",
              },
            }
          : {}),
      },
    }),
  ).get("claude")!;
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json(body));
  const onDispatch = vi.fn();
  const result = await callProvider({
    request,
    prepared: prepareProvider({
      route,
      deploymentEnvironment: "test",
      getSecret: (binding) =>
        binding === "GATEWAY_KEY"
          ? "public-fixture-gateway-key"
          : "public-fixture-anthropic-key",
    }),
    maxResponseBytes: 10000,
    signal: new AbortController().signal,
    onDispatch,
    fetcher,
  });
  expect(onDispatch).toHaveBeenCalledTimes(1);
  expect(fetcher).toHaveBeenCalledTimes(1);
  return {
    result,
    url: fetcher.mock.calls[0]![0],
    init: fetcher.mock.calls[0]![1]!,
  };
}

describe("Anthropic provider contract", () => {
  it.each([
    { temperature: 1 },
    { top_p: 0.99 },
    { seed: 0 },
    { response_format: { type: "json_object" } },
    {
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: { type: "object" },
          strict: false,
        },
      },
    },
    {
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Prefill" },
      ],
    },
    {
      messages: [
        { role: "user", content: "Hi" },
        { role: "system", content: "Late system" },
        { role: "user", content: "Continue" },
      ],
    },
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: { url: "data:image/svg+xml;base64,AQID" },
            },
          ],
        },
      ],
    },
    {
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image_url",
              image_url: {
                url: "https://images.example.invalid/a.png",
                detail: "high",
              },
            },
          ],
        },
      ],
    },
  ])(
    "rejects unsupported request fields before dispatch: %j",
    async (overrides) => {
      const route = parseProviderRoutes(
        JSON.stringify({ claude: routeConfig }),
      ).get("claude")!;
      const fetcher = vi.fn<typeof fetch>();
      const onDispatch = vi.fn();
      await expect(
        callProvider({
          request: {
            endpoint: "chat",
            body: chatRequestSchema.parse({
              model: "text.chat.v1",
              messages: [{ role: "user", content: "Hi" }],
              ...overrides,
            }),
          },
          prepared: prepareProvider({
            route,
            deploymentEnvironment: "test",
            getSecret: () => "public-fixture-anthropic-key",
          }),
          fetcher,
          onDispatch,
          maxResponseBytes: 10000,
          signal: new AbortController().signal,
        }),
      ).rejects.toMatchObject({ status: 400, code: "invalid_request" });
      expect(fetcher).not.toHaveBeenCalled();
      expect(onDispatch).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "translates Chat to one native Messages call (gateway=%s)",
    async (gateway) => {
      const { result, url, init } = await invoke(
        {
          endpoint: "chat",
          body: {
            model: "text.chat.v1",
            messages: [
              { role: "system", content: "Be concise" },
              { role: "developer", content: "Explain the image" },
              {
                role: "user",
                content: [
                  { type: "text", text: "What is this?" },
                  {
                    type: "image_url",
                    image_url: { url: "data:image/png;base64,AQID" },
                  },
                  {
                    type: "image_url",
                    image_url: { url: "https://images.example.invalid/p.png" },
                  },
                ],
              },
            ],
            max_completion_tokens: 1234,
            reasoning_effort: "low",
            stop: "END",
          },
        },
        upstream(),
        gateway,
      );
      expect(url).toBe(
        gateway
          ? `https://gateway.ai.cloudflare.com/v1/${"a".repeat(32)}/test/anthropic/v1/messages`
          : "https://api.anthropic.com/v1/messages",
      );
      const headers = new Headers(init.headers);
      expect(headers.get("x-api-key")).toBe("public-fixture-anthropic-key");
      expect(headers.get("anthropic-version")).toBe("2023-06-01");
      expect(headers.has("authorization")).toBe(false);
      if (gateway) {
        expect(headers.get("cf-aig-collect-log-payload")).toBe("false");
        expect(headers.get("cf-aig-max-attempts")).toBe("1");
      }
      expect(init.redirect).toBe("manual");
      const wire = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(wire).toMatchObject({
        model,
        max_tokens: 1234,
        stream: false,
        stop_sequences: ["END"],
        thinking: { type: "adaptive" },
        output_config: { effort: "low" },
        system: [
          { type: "text", text: "Be concise" },
          { type: "text", text: "Explain the image" },
        ],
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "What is this?" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "AQID",
                },
              },
              {
                type: "image",
                source: {
                  type: "url",
                  url: "https://images.example.invalid/p.png",
                },
              },
            ],
          },
        ],
      });
      expect(result.body.choices).toEqual([
        {
          index: 0,
          message: { role: "assistant", content: "Hello world", refusal: null },
          finish_reason: "stop",
        },
      ]);
      expect(result.usage).toEqual({ inputTokens: 21, outputTokens: 5 });
      expect(JSON.stringify(result)).not.toContain("PRIVATE_");
    },
  );

  it.each([model, "claude-sonnet-5-5", "claude-opus-5-5"])(
    "maps Responses instructions and native JSON schema without tools (%s)",
    async (physicalModel) => {
      const schema = {
        type: "object",
        properties: { ok: { type: "boolean" } },
        required: ["ok"],
        additionalProperties: false,
      };
      const { result, init } = await invoke(
        {
          endpoint: "responses",
          body: {
            model: "text.chat.v1",
            input: "Return JSON",
            instructions: "Be exact",
            max_output_tokens: 777,
            reasoning: { effort: "medium" },
            text: {
              format: {
                type: "json_schema",
                name: "answer",
                strict: true,
                schema,
              },
            },
          },
        },
        upstream({ model: physicalModel }),
        false,
        physicalModel,
      );
      const wire = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(wire).toMatchObject({
        model: physicalModel,
        max_tokens: 777,
        system: [{ type: "text", text: "Be exact" }],
        output_config: {
          effort: "medium",
          format: { type: "json_schema", schema },
        },
      });
      expect(wire).not.toHaveProperty("tools");
      expect(result.body).toMatchObject({
        object: "response",
        status: "completed",
        output: [
          {
            type: "message",
            role: "assistant",
            content: [
              { type: "output_text", text: "Hello world", annotations: [] },
            ],
          },
        ],
        usage: { input_tokens: 21, output_tokens: 5, total_tokens: 26 },
      });
    },
  );

  it.each(["chat", "responses"] as const)(
    "preserves the caller's exact strict schema for %s without SDK weakening",
    async (endpoint) => {
      const schema = {
        type: "object",
        properties: {
          answer: {
            oneOf: [
              { type: "string", pattern: "^[A-Z]+$", maxLength: 7 },
              { type: "integer", minimum: 18, maximum: 23 },
            ],
          },
          scores: {
            type: "object",
            additionalProperties: { type: "number", minimum: 0 },
          },
        },
        required: ["answer", "scores"],
        additionalProperties: false,
      };
      const format = { name: "answer", strict: true, schema };
      const { init } = await invoke(
        endpoint === "chat"
          ? {
              endpoint,
              body: {
                model: "text.chat.v1",
                messages: [{ role: "user", content: "Return JSON" }],
                reasoning_effort: "low",
                response_format: { type: "json_schema", json_schema: format },
              },
            }
          : {
              endpoint,
              body: {
                model: "text.chat.v1",
                input: "Return JSON",
                reasoning: { effort: "low" },
                text: { format: { type: "json_schema", ...format } },
              },
            },
      );
      const wire = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(wire.output_config).toEqual({
        effort: "low",
        format: { type: "json_schema", schema },
      });
    },
  );

  it.each([
    ["max_tokens", "length", "incomplete"],
    ["model_context_window_exceeded", "length", "incomplete"],
    ["refusal", "content_filter", "completed"],
    ["pause_turn", null, "incomplete"],
  ])(
    "preserves %s rather than returning a completed answer",
    async (stop_reason, finish, status) => {
      const chat = await invoke(
        {
          endpoint: "chat",
          body: {
            model: "text.chat.v1",
            messages: [{ role: "user", content: "Hi" }],
            max_tokens: 100,
          },
        },
        upstream({ stop_reason }),
      );
      expect(chat.result.body.choices).toMatchObject([
        {
          finish_reason: finish,
          message: {
            content: stop_reason === "refusal" ? null : "Hello world",
          },
        },
      ]);
      const responses = await invoke(
        {
          endpoint: "responses",
          body: { model: "text.chat.v1", input: "Hi", max_output_tokens: 100 },
        },
        upstream({ stop_reason }),
      );
      expect(responses.result.body.status).toBe(status);
      if (stop_reason === "refusal")
        expect(responses.result.body.output).toMatchObject([
          { content: [{ type: "refusal", refusal: "Hello world" }] },
        ]);
    },
  );

  it.each([
    { model: "claude-unapproved" },
    { content: [{ type: "tool_use", id: "tool", name: "run", input: {} }] },
    { content: [{ type: "text", text: "public-fixture-anthropic-key" }] },
  ])("fails closed for an invalid upstream response %j", async (override) => {
    await expect(
      invoke(
        {
          endpoint: "chat",
          body: {
            model: "text.chat.v1",
            messages: [{ role: "user", content: "Hi" }],
          },
        },
        upstream(override),
      ),
    ).rejects.toMatchObject({ errorClass: "provider_protocol" });
  });

  it.each([
    { usage: undefined, expected: {} },
    { usage: { output_tokens: 5 }, expected: { outputTokens: 5 } },
    {
      usage: {
        input_tokens: 11,
        cache_read_input_tokens: -1,
        output_tokens: 5,
      },
      expected: { outputTokens: 5 },
    },
    {
      usage: {
        input_tokens: 11,
        cache_read_input_tokens: null,
        output_tokens: 5,
      },
      expected: { outputTokens: 5 },
    },
  ])(
    "does not undercount absent or malformed usage: %j",
    async ({ usage, expected }) => {
      const { result } = await invoke(
        { endpoint: "responses", body: { model: "text.chat.v1", input: "Hi" } },
        upstream({ usage }),
      );
      expect(result.usage).toEqual(expected);
      expect(result.body).not.toHaveProperty("usage");
    },
  );

  it("does not classify thinking-only output as a complete answer", async () => {
    const { result } = await invoke(
      {
        endpoint: "chat",
        body: {
          model: "text.chat.v1",
          messages: [{ role: "user", content: "Hi" }],
        },
      },
      upstream({
        content: [{ type: "thinking", thinking: "PRIVATE_THINKING" }],
      }),
    );
    expect(result.body.choices).toMatchObject([
      { finish_reason: null, message: { content: null } },
    ]);
  });
});
