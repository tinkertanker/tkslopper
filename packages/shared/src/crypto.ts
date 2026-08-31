import { z } from "zod";

const encoder = new TextEncoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function randomId(prefix: string): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `${prefix}_${bytesToBase64Url(bytes)}`;
}

export function randomSecret(bytes = 32): string {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256(value: string): Promise<string> {
  return bytesToBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", encoder.encode(value)),
    ),
  );
}

async function hmac(value: string, secret: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign("HMAC", key, encoder.encode(value)),
  );
}

export async function pseudonymize(
  value: string,
  secret: string,
): Promise<string> {
  return bytesToBase64Url(await hmac(value, secret));
}

export async function hashCredential(
  secret: string,
  salt: string,
  pepper: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(`${secret}:${pepper}`),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: encoder.encode(salt),
      iterations: 100_000,
    },
    key,
    256,
  );
  return bytesToBase64Url(new Uint8Array(bits));
}

export async function verifyCredential(
  secret: string,
  salt: string,
  pepper: string,
  expectedHash: string,
): Promise<boolean> {
  const actual = base64UrlToBytes(await hashCredential(secret, salt, pepper));
  const expected = base64UrlToBytes(expectedHash);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) {
    difference |= (actual[index] ?? 0) ^ (expected[index] ?? 0);
  }
  return difference === 0;
}

const opaqueCredentialSchema = z
  .string()
  .min(20)
  .max(256)
  .regex(/^tk(?:svc|ac)_[A-Za-z0-9_-]{8,64}_[A-Za-z0-9_-]{16,128}$/u);

export function createOpaqueCredential(kind: "service" | "access_code"): {
  id: string;
  secret: string;
  value: string;
} {
  const id = bytesToHex(crypto.getRandomValues(new Uint8Array(12)));
  const secret = randomSecret();
  const prefix = kind === "service" ? "tksvc" : "tkac";
  return { id, secret, value: `${prefix}_${id}_${secret}` };
}

export function parseOpaqueCredential(
  value: string,
  expectedKind: "service" | "access_code",
): { id: string; secret: string } | undefined {
  if (!opaqueCredentialSchema.safeParse(value).success) return undefined;
  const expectedPrefix = expectedKind === "service" ? "tksvc" : "tkac";
  if (!value.startsWith(`${expectedPrefix}_`)) return undefined;
  const remainder = value.slice(expectedPrefix.length + 1);
  const separator = remainder.indexOf("_");
  if (separator < 8) return undefined;
  const id = remainder.slice(0, separator);
  const secret = remainder.slice(separator + 1);
  return { id, secret };
}

export const grantClaimsSchema = z
  .object({
    iss: z.string().url(),
    aud: z.string().min(1).max(200),
    sub: z.string().min(1).max(200),
    iat: z.number().int().nonnegative(),
    exp: z.number().int().positive(),
    jti: z.string().min(16).max(100),
    tks: z
      .object({
        productId: z.string().min(1).max(100),
        environmentId: z.string().min(1).max(100),
        tenantId: z.string().min(1).max(200),
        principalId: z.string().min(1).max(200),
        capabilities: z.array(z.string().min(1).max(100)).min(1).max(50),
        tokenType: z.enum(["service", "direct_client", "dev"]),
      })
      .strict(),
  })
  .strict();

export type GrantClaims = z.infer<typeof grantClaimsSchema>;

export async function signGrant(
  claims: GrantClaims,
  secret: string,
): Promise<string> {
  const header = bytesToBase64Url(
    encoder.encode(JSON.stringify({ alg: "HS256", typ: "tkslopper+jwt" })),
  );
  const payload = bytesToBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = bytesToBase64Url(
    await hmac(`${header}.${payload}`, secret),
  );
  return `${header}.${payload}.${signature}`;
}

export async function verifyGrant(
  token: string,
  secret: string,
  expectedIssuer: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<GrantClaims | undefined> {
  const segments = token.split(".");
  if (segments.length !== 3) return undefined;
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  if (
    encodedHeader === undefined ||
    encodedPayload === undefined ||
    encodedSignature === undefined
  )
    return undefined;

  try {
    const header = JSON.parse(
      new TextDecoder().decode(base64UrlToBytes(encodedHeader)),
    ) as unknown;
    if (
      typeof header !== "object" ||
      header === null ||
      !("alg" in header) ||
      header.alg !== "HS256" ||
      !("typ" in header) ||
      header.typ !== "tkslopper+jwt"
    ) {
      return undefined;
    }
    const expectedSignature = await hmac(
      `${encodedHeader}.${encodedPayload}`,
      secret,
    );
    const suppliedSignature = base64UrlToBytes(encodedSignature);
    if (expectedSignature.length !== suppliedSignature.length) return undefined;
    let difference = 0;
    for (let index = 0; index < expectedSignature.length; index += 1) {
      difference |=
        (expectedSignature[index] ?? 0) ^ (suppliedSignature[index] ?? 0);
    }
    if (difference !== 0) return undefined;

    const claims = grantClaimsSchema.parse(
      JSON.parse(
        new TextDecoder().decode(base64UrlToBytes(encodedPayload)),
      ) as unknown,
    );
    if (
      claims.iss !== expectedIssuer ||
      claims.iat > nowSeconds + 30 ||
      claims.exp <= nowSeconds
    )
      return undefined;
    return claims;
  } catch {
    return undefined;
  }
}
