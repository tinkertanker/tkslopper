type Reservation = {
  estimatedTokens: number;
  reservedCostMicrocents: number;
  expiresAt: number;
  minuteKey: string;
  dayKey: string;
};

type QuotaState = {
  minuteKey: string;
  requestsThisMinute: number;
  tokensThisMinute: number;
  dayKey: string;
  spentTodayMicrocents: number;
  reservedTodayMicrocents: number;
  reservations: Record<string, Reservation>;
};

export type QuotaAcquireRequest = {
  operation: "acquire";
  requestId: string;
  reservationTtlSeconds: number;
  estimatedTokens: number;
  reservedCostMicrocents: number;
  limits: {
    rpm: number;
    tpm: number;
    concurrency: number;
    dailyBudgetMicrocents: number;
  };
};

export type QuotaCompleteRequest = {
  operation: "complete";
  requestId: string;
  actualTokens: number;
  actualCostMicrocents: number;
};

function minuteKey(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 16);
}

function dayKey(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString().slice(0, 10);
}

function freshState(now: number): QuotaState {
  return {
    minuteKey: minuteKey(now),
    requestsThisMinute: 0,
    tokensThisMinute: 0,
    dayKey: dayKey(now),
    spentTodayMicrocents: 0,
    reservedTodayMicrocents: 0,
    reservations: {},
  };
}

function normalizeState(state: QuotaState, now: number): void {
  const currentMinute = minuteKey(now);
  const currentDay = dayKey(now);
  if (state.minuteKey !== currentMinute) {
    state.minuteKey = currentMinute;
    state.requestsThisMinute = 0;
    state.tokensThisMinute = 0;
  }
  if (state.dayKey !== currentDay) {
    state.dayKey = currentDay;
    state.spentTodayMicrocents = 0;
    state.reservedTodayMicrocents = 0;
  }
  for (const [requestId, reservation] of Object.entries(state.reservations)) {
    if (reservation.expiresAt > now) continue;
    if (reservation.minuteKey === state.minuteKey) {
      state.tokensThisMinute = Math.max(
        0,
        state.tokensThisMinute - reservation.estimatedTokens,
      );
    }
    if (reservation.dayKey === state.dayKey) {
      state.reservedTodayMicrocents = Math.max(
        0,
        state.reservedTodayMicrocents - reservation.reservedCostMicrocents,
      );
    }
    delete state.reservations[requestId];
  }
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isAcquireRequest(value: unknown): value is QuotaAcquireRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("operation" in value) ||
    value.operation !== "acquire"
  ) {
    return false;
  }
  const candidate = value as Partial<QuotaAcquireRequest>;
  return (
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0 &&
    isSafeInteger(candidate.reservationTtlSeconds) &&
    candidate.reservationTtlSeconds > 0 &&
    isSafeInteger(candidate.estimatedTokens) &&
    isSafeInteger(candidate.reservedCostMicrocents) &&
    typeof candidate.limits === "object" &&
    candidate.limits !== null &&
    isSafeInteger(candidate.limits.rpm) &&
    candidate.limits.rpm > 0 &&
    isSafeInteger(candidate.limits.tpm) &&
    candidate.limits.tpm > 0 &&
    isSafeInteger(candidate.limits.concurrency) &&
    candidate.limits.concurrency > 0 &&
    isSafeInteger(candidate.limits.dailyBudgetMicrocents)
  );
}

function isCompleteRequest(value: unknown): value is QuotaCompleteRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("operation" in value) ||
    value.operation !== "complete"
  ) {
    return false;
  }
  const candidate = value as Partial<QuotaCompleteRequest>;
  return (
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0 &&
    isSafeInteger(candidate.actualTokens) &&
    isSafeInteger(candidate.actualCostMicrocents)
  );
}

export class QuotaCoordinator implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST")
      return Response.json({ error: "method_not_allowed" }, { status: 405 });
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    if (isAcquireRequest(body)) return this.acquire(body);
    if (isCompleteRequest(body)) return this.complete(body);
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  private async acquire(request: QuotaAcquireRequest): Promise<Response> {
    const now = Math.floor(Date.now() / 1000);
    let denial:
      "duplicate" | "rpm" | "tpm" | "concurrency" | "budget" | undefined;
    await this.state.storage.transaction(async (transaction) => {
      const state =
        (await transaction.get<QuotaState>("quota")) ?? freshState(now);
      normalizeState(state, now);
      if (state.reservations[request.requestId]) denial = "duplicate";
      else if (state.requestsThisMinute + 1 > request.limits.rpm)
        denial = "rpm";
      else if (
        state.tokensThisMinute + request.estimatedTokens >
        request.limits.tpm
      )
        denial = "tpm";
      else if (
        Object.keys(state.reservations).length + 1 >
        request.limits.concurrency
      )
        denial = "concurrency";
      else if (
        state.spentTodayMicrocents +
          state.reservedTodayMicrocents +
          request.reservedCostMicrocents >
        request.limits.dailyBudgetMicrocents
      ) {
        denial = "budget";
      } else {
        state.requestsThisMinute += 1;
        state.tokensThisMinute += request.estimatedTokens;
        state.reservedTodayMicrocents += request.reservedCostMicrocents;
        state.reservations[request.requestId] = {
          estimatedTokens: request.estimatedTokens,
          reservedCostMicrocents: request.reservedCostMicrocents,
          expiresAt: now + request.reservationTtlSeconds,
          minuteKey: state.minuteKey,
          dayKey: state.dayKey,
        };
        await transaction.put("quota", state);
      }
    });
    if (denial)
      return Response.json(
        { acquired: false, reason: denial },
        { status: denial === "budget" ? 402 : 429 },
      );
    return Response.json({ acquired: true });
  }

  private async complete(request: QuotaCompleteRequest): Promise<Response> {
    const now = Math.floor(Date.now() / 1000);
    let found = false;
    await this.state.storage.transaction(async (transaction) => {
      const state =
        (await transaction.get<QuotaState>("quota")) ?? freshState(now);
      normalizeState(state, now);
      const reservation = state.reservations[request.requestId];
      if (!reservation) return;
      found = true;
      if (reservation.minuteKey === state.minuteKey) {
        state.tokensThisMinute = Math.max(
          0,
          state.tokensThisMinute -
            reservation.estimatedTokens +
            request.actualTokens,
        );
      }
      if (reservation.dayKey === state.dayKey) {
        state.reservedTodayMicrocents = Math.max(
          0,
          state.reservedTodayMicrocents - reservation.reservedCostMicrocents,
        );
        state.spentTodayMicrocents += request.actualCostMicrocents;
      }
      delete state.reservations[request.requestId];
      await transaction.put("quota", state);
    });
    return Response.json({ completed: found }, { status: found ? 200 : 404 });
  }
}
