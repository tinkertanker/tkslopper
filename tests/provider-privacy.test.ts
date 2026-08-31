import { describe, expect, it, vi } from "vitest";

import {
  callProvider,
  logSafeEvent,
  parseProviderRoutes,
  type ParsedGatewayRequest,
  type ProviderError,
} from "@tkslop/shared";

const request: ParsedGatewayRequest = {
  endpoint: "chat",
  body: {
    model: "text.chat.v1",
    messages: [{ role: "user", content: "PRIVATE_PAYLOAD_SENTINEL" }],
  },
};

describe("provider contract", () => {
  it("rejects control bindings as provider credentials", () => {
    expect(() =>
      parseProviderRoutes(
        JSON.stringify({
          route: {
            id: "route",
            provider: "openai-compatible",
            model: "physical-model-v1",
            baseUrl: "https://provider.example.invalid",
            credentialBinding: "TOKEN_SIGNING_SECRET",
            endpoints: ["chat"],
            supportsImages: false,
            supportsReasoning: false,
            supportsStructuredJson: false,
            timeoutMs: 5000,
          },
        }),
      ),
    ).toThrow();
  });

  it("keeps the fixture provider out of production", async () => {
    const route = parseProviderRoutes(
      JSON.stringify({
        fixture: {
          id: "fixture",
          provider: "fixture",
          model: "fixture-model",
          endpoints: ["chat"],
          supportsImages: false,
          supportsReasoning: false,
          supportsStructuredJson: false,
          timeoutMs: 5000,
        },
      }),
    ).get("fixture")!;
    await expect(
      callProvider({
        request,
        route,
        deploymentEnvironment: "production",
        maxResponseBytes: 10_000,
        signal: new AbortController().signal,
        getSecret: () => undefined,
      }),
    ).rejects.toMatchObject({
      errorClass: "provider_unavailable",
    } satisfies Partial<ProviderError>);
  });

  it("replaces aliases with the configured model and makes exactly one physical call", async () => {
    const route = parseProviderRoutes(
      JSON.stringify({
        route: {
          id: "route",
          provider: "openai-compatible",
          model: "physical-model-v1",
          baseUrl: "https://provider.example.invalid",
          credentialBinding: "UPSTREAM_KEY",
          endpoints: ["chat"],
          supportsImages: false,
          supportsReasoning: false,
          supportsStructuredJson: false,
          timeoutMs: 5000,
        },
      }),
    ).get("route")!;
    const upstreamSecret = "public-fixture-upstream-value";
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        id: "chatcmpl_fixture",
        object: "chat.completion",
        model: "physical-model-v1",
        reflected_top_level: upstreamSecret,
        choices: [
          {
            index: 0,
            message: {
              role: "assistant",
              content: "fixture response",
              reflected_nested: upstreamSecret,
            },
            finish_reason: "stop",
            reflected_choice: upstreamSecret,
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 7 },
      }),
    );
    const result = await callProvider({
      request,
      route,
      deploymentEnvironment: "test",
      maxResponseBytes: 10_000,
      signal: new AbortController().signal,
      getSecret: () => upstreamSecret,
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const init = fetcher.mock.calls[0]?.[1];
    if (typeof init?.body !== "string")
      throw new Error("provider body was not JSON text");
    expect(JSON.parse(init.body)).toMatchObject({
      model: "physical-model-v1",
      stream: false,
    });
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
    expect(JSON.stringify(result.body)).not.toContain(upstreamSecret);
  });

  it("normalizes upstream rejection without retaining its body", async () => {
    const route = parseProviderRoutes(
      JSON.stringify({
        route: {
          id: "route",
          provider: "openai-compatible",
          model: "physical-model-v1",
          baseUrl: "https://provider.example.invalid",
          credentialBinding: "UPSTREAM_KEY",
          endpoints: ["chat"],
          supportsImages: false,
          supportsReasoning: false,
          supportsStructuredJson: false,
          timeoutMs: 5000,
        },
      }),
    ).get("route")!;
    const sentinel = "UPSTREAM_PRIVATE_ERROR_SENTINEL";
    const operation = callProvider({
      request,
      route,
      deploymentEnvironment: "test",
      maxResponseBytes: 10_000,
      signal: new AbortController().signal,
      getSecret: () => "public-fixture-upstream-value",
      fetcher: vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response(sentinel, { status: 400 })),
    });
    await expect(operation).rejects.toMatchObject({
      errorClass: "provider_rejected",
    } satisfies Partial<ProviderError>);
    await operation.catch((error: unknown) =>
      expect(String(error)).not.toContain(sentinel),
    );
  });

  it("rejects malformed and unbounded successful provider responses", async () => {
    const route = parseProviderRoutes(
      JSON.stringify({
        route: {
          id: "route",
          provider: "openai-compatible",
          model: "physical-model-v1",
          baseUrl: "https://provider.example.invalid",
          credentialBinding: "UPSTREAM_KEY",
          endpoints: ["chat"],
          supportsImages: false,
          supportsReasoning: false,
          supportsStructuredJson: false,
          timeoutMs: 5000,
        },
      }),
    ).get("route")!;
    const invoke = (response: Response, maxResponseBytes = 10_000) =>
      callProvider({
        request,
        route,
        deploymentEnvironment: "test",
        maxResponseBytes,
        signal: new AbortController().signal,
        getSecret: () => "public-fixture-upstream-value",
        fetcher: vi.fn<typeof fetch>().mockResolvedValue(response),
      });
    await expect(
      invoke(Response.json({ object: "unexpected" })),
    ).rejects.toMatchObject({
      errorClass: "provider_protocol",
    } satisfies Partial<ProviderError>);
    await expect(
      invoke(new Response("x".repeat(100), { status: 200 }), 10),
    ).rejects.toMatchObject({
      errorClass: "provider_protocol",
    } satisfies Partial<ProviderError>);
    await expect(
      invoke(
        Response.json({
          id: "chatcmpl_fixture",
          object: "chat.completion",
          model: "physical-model-v1",
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: "public-fixture-upstream-value",
              },
              finish_reason: "stop",
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({
      errorClass: "provider_protocol",
    } satisfies Partial<ProviderError>);
  });
});

describe("metadata-only observability", () => {
  it("cannot accept payload-shaped fields and emits only the safe event", () => {
    const logger = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logSafeEvent({
      requestId: "req_fixture",
      productId: "vibbit",
      environmentId: "test",
      tenantHash: "tenant_hash",
      principalHash: "principal_hash",
      alias: "text.chat.v1",
      policyVersion: 1,
      routeId: "route_fixture",
      provider: "fixture",
      model: "fixture-model",
      endpoint: "chat",
      status: 200,
      latencyMs: 5,
      inputTokens: 8,
      outputTokens: 3,
      costMicrocents: 0,
      attempts: 1,
    });
    const serialized = String(logger.mock.calls[0]?.[0]);
    expect(serialized).not.toContain("PRIVATE_PAYLOAD_SENTINEL");
    expect(Object.keys(JSON.parse(serialized) as object)).not.toContain(
      "prompt",
    );
    logger.mockRestore();
  });
});
