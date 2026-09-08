import { describe, expect, it, vi } from "vitest";
import {
  callProvider,
  parseProviderRoutes,
  prepareProvider,
  type ParsedGatewayRequest,
} from "@tkslopper/shared";

const providerKey = "public-fixture-provider-secret";
const gatewayKey = "public-fixture-cloudflare-secret";
const config = {
  id: "route",
  adapter: "openai-compatible",
  provider: "openai",
  profile: "openai",
  model: "physical-model-v1",
  baseUrl: "https://api.openai.com",
  credentialBinding: "UPSTREAM_KEY",
  gateway: {
    accountId: "0".repeat(32),
    gatewayId: "synthetic-test",
    credentialBinding: "AIG_KEY",
  },
  endpoints: ["chat", "responses"],
  supportsImages: true,
  supportsReasoning: true,
  supportsStructuredJson: true,
  timeoutMs: 5000,
};
const route = () =>
  parseProviderRoutes(JSON.stringify({ route: config })).get("route")!;
const prepare = () =>
  prepareProvider({
    route: route(),
    deploymentEnvironment: "test",
    getSecret: (name) => (name === "UPSTREAM_KEY" ? providerKey : gatewayKey),
  });
const request: ParsedGatewayRequest = {
  endpoint: "chat",
  body: {
    model: "text.chat.v1",
    messages: [{ role: "user", content: "PRIVATE_PROMPT" }],
  },
};
const responseBody = (content = "synthetic answer") => ({
  id: "chat-fixture",
  object: "chat.completion",
  model: config.model,
  choices: [
    {
      index: 0,
      message: { role: "assistant", content },
      finish_reason: "stop",
    },
  ],
});

describe("Cloudflare AI Gateway BYOK transport", () => {
  it("uses separate backend credentials and forces metadata-only, uncached, one-attempt routing", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(responseBody()));
    const onDispatch = vi.fn();
    const metadata = {
      request_id: "req_synthetic",
      principal: "pseudonym",
      product_id: "product",
    };
    await callProvider({
      request,
      prepared: prepare(),
      maxResponseBytes: 4096,
      signal: new AbortController().signal,
      onDispatch,
      metadata,
      fetcher,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onDispatch).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe(
      `https://gateway.ai.cloudflare.com/v1/${"0".repeat(32)}/synthetic-test/openai/chat/completions`,
    );
    expect(init?.redirect).toBe("manual");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${providerKey}`);
    expect(headers.get("cf-aig-authorization")).toBe(`Bearer ${gatewayKey}`);
    expect(headers.get("cf-aig-collect-log-payload")).toBe("false");
    expect(headers.get("cf-aig-collect-log")).toBe("true");
    expect(headers.get("cf-aig-skip-cache")).toBe("true");
    expect(headers.get("cf-aig-max-attempts")).toBe("1");
    expect(headers.get("cf-aig-request-timeout")).toBe("5000");
    expect(JSON.parse(headers.get("cf-aig-metadata")!)).toEqual(metadata);
    expect(headers.get("cf-aig-metadata")).not.toContain("PRIVATE_PROMPT");
  });

  it.each([undefined, "short", providerKey])(
    "fails preflight for missing/invalid/shared gateway credentials: %s",
    (key) => {
      expect(() =>
        prepareProvider({
          route: route(),
          deploymentEnvironment: "test",
          getSecret: (name) => (name === "UPSTREAM_KEY" ? providerKey : key),
        }),
      ).toThrow("provider_unavailable");
    },
  );

  it.each(["TOKEN_SIGNING_SECRET", "UPSTREAM_KEY", "DB"])(
    "rejects unsafe gateway credential binding %s",
    (credentialBinding) => {
      expect(() =>
        parseProviderRoutes(
          JSON.stringify({
            route: {
              ...config,
              gateway: { ...config.gateway, credentialBinding },
            },
          }),
        ),
      ).toThrow();
    },
  );

  it.each([providerKey, gatewayKey])(
    "never exposes either reflected credential",
    async (secret) => {
      await expect(
        callProvider({
          request,
          prepared: prepare(),
          maxResponseBytes: 4096,
          signal: new AbortController().signal,
          onDispatch: vi.fn(),
          fetcher: vi
            .fn<typeof fetch>()
            .mockResolvedValue(Response.json(responseBody(secret))),
        }),
      ).rejects.toMatchObject({ errorClass: "provider_protocol" });
    },
  );

  it.each([302, 429, 500])(
    "does not retry or fall back after HTTP %s",
    async (status) => {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
        new Response("PRIVATE_ERROR", {
          status,
          headers: { location: "https://other.invalid" },
        }),
      );
      await expect(
        callProvider({
          request,
          prepared: prepare(),
          maxResponseBytes: 4096,
          signal: new AbortController().signal,
          onDispatch: vi.fn(),
          fetcher,
        }),
      ).rejects.toMatchObject({ errorClass: "provider_rejected", status });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );

  it("retains Responses refusal, status, order and partial usage despite stricter SDK parsing", async () => {
    const body = {
      id: "resp_test",
      object: "response",
      model: config.model,
      status: "incomplete",
      incomplete_details: { reason: null },
      output: [
        {
          id: "message_test",
          type: "message",
          role: "assistant",
          status: "incomplete",
          content: [
            { type: "output_text", text: "partial", annotations: [] },
            { type: "refusal", refusal: "denied" },
          ],
        },
      ],
      usage: { input_tokens: 12 },
    };
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json(body));
    const result = await callProvider({
      request: {
        endpoint: "responses",
        body: { model: "text.response.v1", input: "synthetic" },
      },
      prepared: prepare(),
      maxResponseBytes: 4096,
      signal: new AbortController().signal,
      onDispatch: vi.fn(),
      fetcher,
    });
    expect(result.body).toEqual({ ...body, usage: undefined });
    expect(result.body).not.toHaveProperty("usage");
    expect(result.usage).toEqual({ inputTokens: 12 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]![0]).toMatch(/\/openai\/responses$/u);
  });
});
