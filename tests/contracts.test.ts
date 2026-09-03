import { describe, expect, it } from "vitest";

import {
  capabilitySchema,
  chatRequestSchema,
  createOpaqueCredential,
  hashCredential,
  inspectGatewayRequest,
  parseOpaqueCredential,
  responsesRequestSchema,
  signGrant,
  verifyCredential,
  verifyGrant,
  type GrantClaims,
} from "@tkslopper/shared";

import playgroundPalLongContext from "./fixtures/playground-pal-long-context.json";
import playgroundPalChat from "./fixtures/playground-pal-chat.json";
import playgroundPalResponses from "./fixtures/playground-pal-responses.json";
import tappletChat from "./fixtures/tapplet-chat.json";
import tappletImage from "./fixtures/tapplet-image.json";
import tappletModeration from "./fixtures/tapplet-moderation.json";
import tappletStrictJson from "./fixtures/tapplet-strict-json.json";
import vibbitChat from "./fixtures/vibbit-chat.json";
import vibbitChatRepair from "./fixtures/vibbit-chat-repair.json";
import vibbitResponses from "./fixtures/vibbit-responses.json";

describe("credentials and grants", () => {
  it("stores salted and peppered credential hashes and parses the opaque envelope", async () => {
    const credential = createOpaqueCredential("service");
    expect(parseOpaqueCredential(credential.value, "service")).toEqual({
      id: credential.id,
      secret: credential.secret,
    });
    expect(
      parseOpaqueCredential(credential.value, "access_code"),
    ).toBeUndefined();
    const hash = await hashCredential(
      credential.secret,
      "public-salt-a",
      "public-pepper-a",
    );
    expect(hash).not.toContain(credential.secret);
    expect(
      await verifyCredential(
        credential.secret,
        "public-salt-a",
        "public-pepper-a",
        hash,
      ),
    ).toBe(true);
    expect(
      await verifyCredential("wrong", "public-salt-a", "public-pepper-a", hash),
    ).toBe(false);
  });

  it("rejects tampered, expired, and wrong-issuer grants", async () => {
    const now = 2_000_000_000;
    const claims: GrantClaims = {
      iss: "https://issuer.example.invalid",
      aud: "vibbit:production",
      sub: "principal-fixture",
      iat: now,
      exp: now + 300,
      jti: "grant_fixture_identifier",
      tks: {
        productId: "vibbit",
        environmentId: "production",
        tenantId: "tenant-fixture",
        principalId: "principal-fixture",
        capabilities: ["text.chat.v1"],
        tokenType: "service",
      },
    };
    const token = await signGrant(claims, "public-test-signing-material");
    expect(
      await verifyGrant(token, "public-test-signing-material", claims.iss, now),
    ).toEqual(claims);
    expect(
      await verifyGrant(
        `${token.slice(0, -1)}x`,
        "public-test-signing-material",
        claims.iss,
        now,
      ),
    ).toBeUndefined();
    expect(
      await verifyGrant(
        token,
        "public-test-signing-material",
        "https://other.invalid",
        now,
      ),
    ).toBeUndefined();
    expect(
      await verifyGrant(
        token,
        "public-test-signing-material",
        claims.iss,
        now + 301,
      ),
    ).toBeUndefined();
  });
});

describe("normalized product request schema smoke", () => {
  it("requires an explicit positive integer version on every capability alias", () => {
    expect(capabilitySchema.safeParse("text.chat.v1").success).toBe(true);
    expect(capabilitySchema.safeParse("text.chat").success).toBe(false);
    expect(capabilitySchema.safeParse("text.chat.v0").success).toBe(false);
    expect(capabilitySchema.safeParse("provider-model-name").success).toBe(
      false,
    );
  });

  it("accepts Vibbit Chat, Responses, and ordered semantic-repair transcripts", () => {
    expect(chatRequestSchema.safeParse(vibbitChat).success).toBe(true);
    expect(responsesRequestSchema.safeParse(vibbitResponses).success).toBe(
      true,
    );
    const repair = chatRequestSchema.parse(vibbitChatRepair);
    expect(repair.messages.map(({ role }) => role)).toEqual([
      "system",
      "user",
      "assistant",
      "user",
    ]);
  });

  it("accepts Tapplet Chat, Responses, moderation, and image shapes", () => {
    const chat = chatRequestSchema.parse(tappletChat);
    expect(
      inspectGatewayRequest({ endpoint: "chat", body: chat }),
    ).toMatchObject({ hasStructuredJson: true, reasoningEffort: "high" });
    for (const fixture of [tappletStrictJson, tappletModeration]) {
      const response = responsesRequestSchema.parse(fixture);
      expect(
        inspectGatewayRequest({ endpoint: "responses", body: response }),
      ).toMatchObject({ hasStructuredJson: true });
    }
    const image = responsesRequestSchema.parse(tappletImage);
    expect(
      inspectGatewayRequest({ endpoint: "responses", body: image }),
    ).toMatchObject({ hasImages: true, reasoningEffort: undefined });
  });

  it("accepts normalized Playground Pal Chat and Responses shapes", () => {
    expect(chatRequestSchema.safeParse(playgroundPalChat).success).toBe(true);
    expect(
      responsesRequestSchema.safeParse(playgroundPalResponses).success,
    ).toBe(true);
  });

  it("materializes and admits Playground Pal large-context chat semantics", () => {
    const template = playgroundPalLongContext;
    const parsed = chatRequestSchema.parse({
      model: template.model,
      messages: [
        {
          role: "user",
          content: template.context_segment.repeat(template.repetitions),
        },
      ],
      max_completion_tokens: template.max_completion_tokens,
      stream: template.stream,
    });
    expect(
      inspectGatewayRequest({ endpoint: "chat", body: parsed })
        .estimatedInputTokens,
    ).toBeGreaterThan(250_000);
  });

  it("rejects provider-specific fields that product adapters must translate", () => {
    expect(
      chatRequestSchema.safeParse({
        ...playgroundPalChat,
        thinking: { type: "enabled" },
      }).success,
    ).toBe(false);
    expect(
      responsesRequestSchema.safeParse({
        ...playgroundPalResponses,
        prompt_cache_key: "product-owned-cache-key",
        prompt_cache_retention: "24h",
      }).success,
    ).toBe(false);
    expect(
      chatRequestSchema.safeParse({
        ...tappletChat,
        reasoning_effort: "max",
        thinking: { type: "enabled" },
      }).success,
    ).toBe(false);
    expect(
      responsesRequestSchema.safeParse({
        ...tappletStrictJson,
        reasoning: { effort: "xhigh" },
      }).success,
    ).toBe(false);
  });

  it("rejects unsupported streaming, tools, and arbitrary provider parameters", () => {
    const base = {
      model: "text.chat.v1",
      messages: [{ role: "user", content: "synthetic" }],
    };
    expect(chatRequestSchema.safeParse({ ...base, stream: true }).success).toBe(
      false,
    );
    expect(chatRequestSchema.safeParse({ ...base, tools: [] }).success).toBe(
      false,
    );
    expect(
      chatRequestSchema.safeParse({ ...base, provider: "untrusted" }).success,
    ).toBe(false);
  });
});
