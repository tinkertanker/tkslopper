import type { ZodError } from "zod";

export type ErrorCode =
  | "authentication_failed"
  | "authorization_failed"
  | "invalid_request"
  | "not_found"
  | "conflict"
  | "rate_limit_exceeded"
  | "budget_exceeded"
  | "provider_unavailable"
  | "internal_error";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers?: HeadersInit,
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

export function errorResponse(
  status: number,
  code: ErrorCode,
  message: string,
  requestId?: string,
): Response {
  const headers = requestId ? { "x-tkslop-request-id": requestId } : undefined;
  return jsonResponse(
    { error: { message, type: code, code }, request_id: requestId },
    status,
    headers,
  );
}

export function zodMessage(error: ZodError): string {
  return error.issues
    .slice(0, 3)
    .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
    .join("; ");
}

export async function readBoundedBytes(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<Uint8Array | undefined> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function readJsonBody(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  if (
    !request.headers
      .get("content-type")
      ?.toLowerCase()
      .startsWith("application/json")
  ) {
    throw new HttpError(
      415,
      "invalid_request",
      "content-type must be application/json",
    );
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > maxBytes)
    throw new HttpError(413, "invalid_request", "request body is too large");
  const bytes = await readBoundedBytes(request.body, maxBytes);
  if (!bytes)
    throw new HttpError(413, "invalid_request", "request body is too large");
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    throw new HttpError(
      400,
      "invalid_request",
      "request body is not valid JSON",
    );
  }
}

export function bearerToken(request: Request): string | undefined {
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ")) return undefined;
  const value = authorization.slice("Bearer ".length);
  return value.length > 0 ? value : undefined;
}
