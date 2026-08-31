import { describe, expect, it } from "vitest";

import {
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
} from "@tkslop/shared";

import playgroundPalLongContext from "./fixtures/playground-pal-long-context.json";
import tappletImage from "./fixtures/tapplet-image.json";
import tappletStrictJson from "./fixtures/tapplet-strict-json.json";
import vibbitChat from "./fixtures/vibbit-chat.json";
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

describe("golden product request contracts", () => {
  it("accepts Vibbit Chat and Responses non-streaming shapes", () => {
    expect(chatRequestSchema.safeParse(vibbitChat).success).toBe(true);
    expect(responsesRequestSchema.safeParse(vibbitResponses).success).toBe(
      true,
    );
  });

  it("accepts Tapplet strict JSON and image Responses shapes", () => {
    expect(responsesRequestSchema.safeParse(tappletStrictJson).success).toBe(
      true,
    );
    expect(
      inspectGatewayRequest({
        endpoint: "responses",
        body: responsesRequestSchema.parse(tappletStrictJson),
      }).hasStructuredJson,
    ).toBe(true);
    const image = responsesRequestSchema.parse(tappletImage);
    expect(
      inspectGatewayRequest({ endpoint: "responses", body: image }).hasImages,
    ).toBe(true);
  });

  it("materializes and admits Playground Pal long-context chat semantics", () => {
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
