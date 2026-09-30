export type SafeRequestEvent = {
  requestId: string;
  traceId?: string | undefined;
  productId?: string | undefined;
  environmentId?: string | undefined;
  tenantHash?: string | undefined;
  principalHash?: string | undefined;
  alias?: string | undefined;
  policyVersion?: number | undefined;
  routeId?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  endpoint?: "chat" | "responses" | undefined;
  status: number;
  errorClass?: string | undefined;
  latencyMs: number;
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  costMicrocents?: number | undefined;
  attempts: 0 | 1;
  quotaReservationState?: "unresolved" | undefined;
  /** The D1 attempt projection could not be finalised; the ledger is settled. */
  attemptProjection?: "failed" | undefined;
};

export function logSafeEvent(event: SafeRequestEvent): void {
  console.log(JSON.stringify({ event: "inference_request", ...event }));
}
