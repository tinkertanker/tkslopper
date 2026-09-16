type Reservation = {
  estimatedTokens: number;
  reservedCostMicrocents: number;
  expiresAt: number;
  minuteKey: string;
  dayKey: string;
};

type CompletionReceipt = {
  actualTokens: number;
  actualCostMicrocents: number;
  expiresAt: number;
};

type QuotaState = {
  minuteKey: string;
  requestsThisMinute: number;
  tokensThisMinute: number;
  dayKey: string;
  spentTodayMicrocents: number;
  reservedTodayMicrocents: number;
  reservations: Record<string, Reservation>;
  completionReceipts: Record<string, CompletionReceipt>;
};

const COMPLETION_RECEIPT_TTL_SECONDS = 300;
const MAX_COMPLETION_RECEIPTS = 512;
/**
 * Bumped whenever the coordinator's operation set changes, because gateway
 * readiness only compares this string. Classroom acquire/complete operations
 * require "2": a coordinator that still reports "1" cannot serve them, and
 * equality would otherwise let that old code pass readiness during a mixed
 * rollout. Legacy operations and state layout are unchanged.
 */
export const QUOTA_PROTOCOL_VERSION = "2";

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

/**
 * Classroom admission is a separate protocol branch inside the same Durable
 * Object class. The object is named by the class scope, so every group, key,
 * and activated device of one class serializes here and the class lifetime cap
 * is enforced atomically with each group's own limits.
 */
export type ClassroomAcquireRequest = {
  operation: "classroom_acquire";
  requestId: string;
  reservationTtlSeconds: number;
  estimatedTokens: number;
  reservedCostMicrocents: number;
  classId: string;
  groupId: string;
  limits: {
    classBudgetMicrocents: number;
    groupBudgetMicrocents: number;
    dailyBudgetMicrocents: number | null;
    rpm: number;
    tpm: number;
    concurrency: number;
  };
};

export type ClassroomCompleteRequest = {
  operation: "classroom_complete";
  requestId: string;
  /**
   * The group that acquired the reservation. Completion must prove the same
   * scope so a receipt can never settle against another group's ledger.
   */
  groupId: string;
  actualTokens: number;
  actualCostMicrocents: number;
};

type ClassroomGroupState = {
  lifetimeSpentMicrocents: number;
  lifetimeReservedMicrocents: number;
  dayKey: string;
  daySpentMicrocents: number;
  dayReservedMicrocents: number;
  minuteKey: string;
  requestsThisMinute: number;
  tokensThisMinute: number;
};

type ClassroomReservation = {
  groupId: string;
  estimatedTokens: number;
  reservedCostMicrocents: number;
  expiresAt: number;
  minuteKey: string;
  dayKey: string;
};

type ClassroomReceipt = {
  groupId: string;
  actualTokens: number;
  actualCostMicrocents: number;
  expiresAt: number;
};

type ClassroomState = {
  classId: string;
  lifetimeSpentMicrocents: number;
  lifetimeReservedMicrocents: number;
  groups: Record<string, ClassroomGroupState>;
  reservations: Record<string, ClassroomReservation>;
  completionReceipts: Record<string, ClassroomReceipt>;
};

/** Separate storage key so the legacy principal ledger is never reinterpreted. */
export const CLASSROOM_STORAGE_KEY = "classroom";

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
    completionReceipts: {},
  };
}

function normalizeState(state: QuotaState, now: number): boolean {
  let changed = false;
  state.completionReceipts ??= {};
  const currentMinute = minuteKey(now);
  const currentDay = dayKey(now);
  if (state.minuteKey !== currentMinute) {
    state.minuteKey = currentMinute;
    state.requestsThisMinute = 0;
    state.tokensThisMinute = 0;
    changed = true;
  }
  if (state.dayKey !== currentDay) {
    state.dayKey = currentDay;
    state.spentTodayMicrocents = 0;
    state.reservedTodayMicrocents = 0;
    changed = true;
  }
  for (const [requestId, reservation] of Object.entries(state.reservations)) {
    if (state.completionReceipts[requestId]) {
      if (reservation.minuteKey === state.minuteKey) {
        state.requestsThisMinute = Math.max(0, state.requestsThisMinute - 1);
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
      changed = true;
      continue;
    }
    if (reservation.expiresAt > now) continue;
    if (reservation.dayKey === state.dayKey) {
      state.reservedTodayMicrocents = Math.max(
        0,
        state.reservedTodayMicrocents - reservation.reservedCostMicrocents,
      );
      state.spentTodayMicrocents += reservation.reservedCostMicrocents;
    }
    delete state.reservations[requestId];
    changed = true;
  }
  for (const [requestId, receipt] of Object.entries(state.completionReceipts)) {
    if (receipt.expiresAt > now) continue;
    delete state.completionReceipts[requestId];
    changed = true;
  }
  return changed;
}

function storeCompletionReceipt(
  state: QuotaState,
  request: QuotaCompleteRequest,
  now: number,
): void {
  state.completionReceipts[request.requestId] = {
    actualTokens: request.actualTokens,
    actualCostMicrocents: request.actualCostMicrocents,
    expiresAt: now + COMPLETION_RECEIPT_TTL_SECONDS,
  };
  const receipts = Object.entries(state.completionReceipts);
  if (receipts.length <= MAX_COMPLETION_RECEIPTS) return;
  receipts.sort((left, right) => left[1].expiresAt - right[1].expiresAt);
  for (const [requestId] of receipts.slice(
    0,
    receipts.length - MAX_COMPLETION_RECEIPTS,
  )) {
    delete state.completionReceipts[requestId];
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

function isClassroomAcquireRequest(
  value: unknown,
): value is ClassroomAcquireRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("operation" in value) ||
    value.operation !== "classroom_acquire"
  ) {
    return false;
  }
  const candidate = value as Partial<ClassroomAcquireRequest>;
  return (
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0 &&
    isSafeInteger(candidate.reservationTtlSeconds) &&
    candidate.reservationTtlSeconds > 0 &&
    isSafeInteger(candidate.estimatedTokens) &&
    isSafeInteger(candidate.reservedCostMicrocents) &&
    typeof candidate.classId === "string" &&
    candidate.classId.length > 0 &&
    typeof candidate.groupId === "string" &&
    candidate.groupId.length > 0 &&
    typeof candidate.limits === "object" &&
    candidate.limits !== null &&
    isSafeInteger(candidate.limits.classBudgetMicrocents) &&
    isSafeInteger(candidate.limits.groupBudgetMicrocents) &&
    (candidate.limits.dailyBudgetMicrocents === null ||
      isSafeInteger(candidate.limits.dailyBudgetMicrocents)) &&
    isSafeInteger(candidate.limits.rpm) &&
    candidate.limits.rpm > 0 &&
    isSafeInteger(candidate.limits.tpm) &&
    candidate.limits.tpm > 0 &&
    isSafeInteger(candidate.limits.concurrency) &&
    candidate.limits.concurrency > 0
  );
}

function isClassroomCompleteRequest(
  value: unknown,
): value is ClassroomCompleteRequest {
  if (
    typeof value !== "object" ||
    value === null ||
    !("operation" in value) ||
    value.operation !== "classroom_complete"
  ) {
    return false;
  }
  const candidate = value as Partial<ClassroomCompleteRequest>;
  return (
    typeof candidate.requestId === "string" &&
    candidate.requestId.length > 0 &&
    typeof candidate.groupId === "string" &&
    candidate.groupId.length > 0 &&
    isSafeInteger(candidate.actualTokens) &&
    isSafeInteger(candidate.actualCostMicrocents)
  );
}

function freshClassroomGroup(now: number): ClassroomGroupState {
  return {
    lifetimeSpentMicrocents: 0,
    lifetimeReservedMicrocents: 0,
    dayKey: dayKey(now),
    daySpentMicrocents: 0,
    dayReservedMicrocents: 0,
    minuteKey: minuteKey(now),
    requestsThisMinute: 0,
    tokensThisMinute: 0,
  };
}

function freshClassroomState(classId: string): ClassroomState {
  return {
    classId,
    lifetimeSpentMicrocents: 0,
    lifetimeReservedMicrocents: 0,
    groups: {},
    reservations: {},
    completionReceipts: {},
  };
}

function countGroupReservations(
  state: ClassroomState,
  groupId: string,
): number {
  let count = 0;
  for (const reservation of Object.values(state.reservations)) {
    if (reservation.groupId === groupId) count += 1;
  }
  return count;
}

/**
 * Rolls UTC minute/day buckets, repairs a reservation that survived a recorded
 * completion, and conservatively converts an expired reservation into lifetime
 * and same-day spend. Lifetime totals never reset; a prior-day reservation is
 * never subtracted from the new day's bucket.
 */
function normalizeClassroomState(state: ClassroomState, now: number): boolean {
  let changed = false;
  state.groups ??= {};
  state.reservations ??= {};
  state.completionReceipts ??= {};
  const currentMinute = minuteKey(now);
  const currentDay = dayKey(now);
  for (const group of Object.values(state.groups)) {
    if (group.minuteKey !== currentMinute) {
      group.minuteKey = currentMinute;
      group.requestsThisMinute = 0;
      group.tokensThisMinute = 0;
      changed = true;
    }
    if (group.dayKey !== currentDay) {
      group.dayKey = currentDay;
      group.daySpentMicrocents = 0;
      group.dayReservedMicrocents = 0;
      changed = true;
    }
  }
  for (const [requestId, reservation] of Object.entries(state.reservations)) {
    const group = state.groups[reservation.groupId];
    if (state.completionReceipts[requestId]) {
      if (group) {
        group.lifetimeReservedMicrocents = Math.max(
          0,
          group.lifetimeReservedMicrocents - reservation.reservedCostMicrocents,
        );
        if (reservation.dayKey === group.dayKey) {
          group.dayReservedMicrocents = Math.max(
            0,
            group.dayReservedMicrocents - reservation.reservedCostMicrocents,
          );
        }
        if (reservation.minuteKey === group.minuteKey) {
          group.requestsThisMinute = Math.max(0, group.requestsThisMinute - 1);
          group.tokensThisMinute = Math.max(
            0,
            group.tokensThisMinute - reservation.estimatedTokens,
          );
        }
      }
      state.lifetimeReservedMicrocents = Math.max(
        0,
        state.lifetimeReservedMicrocents - reservation.reservedCostMicrocents,
      );
      delete state.reservations[requestId];
      changed = true;
      continue;
    }
    if (reservation.expiresAt > now) continue;
    state.lifetimeReservedMicrocents = Math.max(
      0,
      state.lifetimeReservedMicrocents - reservation.reservedCostMicrocents,
    );
    state.lifetimeSpentMicrocents += reservation.reservedCostMicrocents;
    if (group) {
      group.lifetimeReservedMicrocents = Math.max(
        0,
        group.lifetimeReservedMicrocents - reservation.reservedCostMicrocents,
      );
      group.lifetimeSpentMicrocents += reservation.reservedCostMicrocents;
      if (reservation.dayKey === group.dayKey) {
        group.dayReservedMicrocents = Math.max(
          0,
          group.dayReservedMicrocents - reservation.reservedCostMicrocents,
        );
        group.daySpentMicrocents += reservation.reservedCostMicrocents;
      }
    }
    delete state.reservations[requestId];
    changed = true;
  }
  for (const [requestId, receipt] of Object.entries(state.completionReceipts)) {
    if (receipt.expiresAt > now) continue;
    delete state.completionReceipts[requestId];
    changed = true;
  }
  return changed;
}

function storeClassroomReceipt(
  state: ClassroomState,
  request: ClassroomCompleteRequest,
  groupId: string,
  now: number,
): void {
  state.completionReceipts[request.requestId] = {
    groupId,
    actualTokens: request.actualTokens,
    actualCostMicrocents: request.actualCostMicrocents,
    expiresAt: now + COMPLETION_RECEIPT_TTL_SECONDS,
  };
  const receipts = Object.entries(state.completionReceipts);
  if (receipts.length <= MAX_COMPLETION_RECEIPTS) return;
  receipts.sort((left, right) => left[1].expiresAt - right[1].expiresAt);
  for (const [requestId] of receipts.slice(
    0,
    receipts.length - MAX_COMPLETION_RECEIPTS,
  )) {
    delete state.completionReceipts[requestId];
  }
}

function isClassroomBudgetReason(reason: string): boolean {
  return (
    reason === "class_budget" ||
    reason === "group_budget" ||
    reason === "group_daily_budget"
  );
}

export class QuotaCoordinator implements DurableObject {
  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      await this.state.storage.get("readiness-probe");
      return Response.json({
        status: "ok",
        protocolVersion: QUOTA_PROTOCOL_VERSION,
      });
    }
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
    if (isClassroomAcquireRequest(body)) return this.classroomAcquire(body);
    if (isClassroomCompleteRequest(body)) return this.classroomComplete(body);
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  private async acquire(request: QuotaAcquireRequest): Promise<Response> {
    const now = Math.floor(Date.now() / 1000);
    let denial: "rpm" | "tpm" | "concurrency" | "budget" | undefined;
    let existing = false;
    let completed = false;
    await this.state.storage.transaction(async (transaction) => {
      const state =
        (await transaction.get<QuotaState>("quota")) ?? freshState(now);
      let changed = normalizeState(state, now);
      if (state.reservations[request.requestId]) existing = true;
      else if (state.completionReceipts[request.requestId]) completed = true;
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
        changed = true;
      }
      if (changed) await transaction.put("quota", state);
    });
    if (completed)
      return Response.json(
        { acquired: false, reason: "request_completed" },
        { status: 409 },
      );
    if (denial)
      return Response.json(
        { acquired: false, reason: denial },
        { status: denial === "budget" ? 402 : 429 },
      );
    return Response.json({ acquired: true, existing });
  }

  private async complete(request: QuotaCompleteRequest): Promise<Response> {
    const now = Math.floor(Date.now() / 1000);
    let found = false;
    let knownCompleted = false;
    let mismatch = false;
    await this.state.storage.transaction(async (transaction) => {
      const state =
        (await transaction.get<QuotaState>("quota")) ?? freshState(now);
      let changed = normalizeState(state, now);
      const receipt = state.completionReceipts[request.requestId];
      if (receipt) {
        mismatch =
          receipt.actualTokens !== request.actualTokens ||
          receipt.actualCostMicrocents !== request.actualCostMicrocents;
        knownCompleted = !mismatch;
        if (changed) await transaction.put("quota", state);
        return;
      }
      const reservation = state.reservations[request.requestId];
      if (!reservation) {
        if (changed) await transaction.put("quota", state);
        return;
      }
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
      storeCompletionReceipt(state, request, now);
      changed = true;
      await transaction.put("quota", state);
    });
    if (mismatch)
      return Response.json(
        { completed: false, reason: "completion_mismatch" },
        { status: 409 },
      );
    if (!found && !knownCompleted)
      return Response.json(
        { completed: false, reason: "unknown_reservation" },
        { status: 404 },
      );
    return Response.json({ completed: true, found, knownCompleted });
  }

  private async classroomAcquire(
    request: ClassroomAcquireRequest,
  ): Promise<Response> {
    const now = Math.floor(Date.now() / 1000);
    let denial: string | undefined;
    let existing = false;
    let completed = false;
    let scopeMismatch = false;
    await this.state.storage.transaction(async (transaction) => {
      const stored = await transaction.get<ClassroomState>(
        CLASSROOM_STORAGE_KEY,
      );
      const state = stored ?? freshClassroomState(request.classId);
      if (state.classId !== request.classId) {
        scopeMismatch = true;
        return;
      }
      let changed = stored === undefined || normalizeClassroomState(state, now);
      if (state.reservations[request.requestId]) existing = true;
      else if (state.completionReceipts[request.requestId]) completed = true;
      else {
        let group = state.groups[request.groupId];
        if (!group) {
          group = freshClassroomGroup(now);
          state.groups[request.groupId] = group;
          changed = true;
        }
        const reservations = countGroupReservations(state, request.groupId);
        if (group.requestsThisMinute + 1 > request.limits.rpm) denial = "rpm";
        else if (
          group.tokensThisMinute + request.estimatedTokens >
          request.limits.tpm
        )
          denial = "tpm";
        else if (reservations + 1 > request.limits.concurrency)
          denial = "concurrency";
        else if (
          state.lifetimeSpentMicrocents +
            state.lifetimeReservedMicrocents +
            request.reservedCostMicrocents >
          request.limits.classBudgetMicrocents
        )
          denial = "class_budget";
        else if (
          group.lifetimeSpentMicrocents +
            group.lifetimeReservedMicrocents +
            request.reservedCostMicrocents >
          request.limits.groupBudgetMicrocents
        )
          denial = "group_budget";
        else if (
          request.limits.dailyBudgetMicrocents !== null &&
          group.daySpentMicrocents +
            group.dayReservedMicrocents +
            request.reservedCostMicrocents >
            request.limits.dailyBudgetMicrocents
        )
          denial = "group_daily_budget";
        else {
          state.lifetimeReservedMicrocents += request.reservedCostMicrocents;
          group.lifetimeReservedMicrocents += request.reservedCostMicrocents;
          group.dayReservedMicrocents += request.reservedCostMicrocents;
          group.requestsThisMinute += 1;
          group.tokensThisMinute += request.estimatedTokens;
          state.reservations[request.requestId] = {
            groupId: request.groupId,
            estimatedTokens: request.estimatedTokens,
            reservedCostMicrocents: request.reservedCostMicrocents,
            expiresAt: now + request.reservationTtlSeconds,
            minuteKey: group.minuteKey,
            dayKey: group.dayKey,
          };
          changed = true;
        }
      }
      if (changed) await transaction.put(CLASSROOM_STORAGE_KEY, state);
    });
    if (scopeMismatch)
      return Response.json(
        { error: "classroom_scope_mismatch" },
        { status: 500 },
      );
    if (completed)
      return Response.json(
        { acquired: false, reason: "request_completed" },
        { status: 409 },
      );
    if (denial)
      return Response.json(
        { acquired: false, reason: denial },
        { status: isClassroomBudgetReason(denial) ? 402 : 429 },
      );
    return Response.json({ acquired: true, existing });
  }

  private async classroomComplete(
    request: ClassroomCompleteRequest,
  ): Promise<Response> {
    const now = Math.floor(Date.now() / 1000);
    let found = false;
    let knownCompleted = false;
    let mismatch = false;
    let scopeMismatch = false;
    await this.state.storage.transaction(async (transaction) => {
      const state = await transaction.get<ClassroomState>(
        CLASSROOM_STORAGE_KEY,
      );
      if (!state) return;
      let changed = normalizeClassroomState(state, now);
      const receipt = state.completionReceipts[request.requestId];
      if (receipt) {
        if (receipt.groupId !== request.groupId) {
          scopeMismatch = true;
          if (changed) await transaction.put(CLASSROOM_STORAGE_KEY, state);
          return;
        }
        mismatch =
          receipt.actualTokens !== request.actualTokens ||
          receipt.actualCostMicrocents !== request.actualCostMicrocents;
        knownCompleted = !mismatch;
        if (changed) await transaction.put(CLASSROOM_STORAGE_KEY, state);
        return;
      }
      const reservation = state.reservations[request.requestId];
      if (!reservation) {
        if (changed) await transaction.put(CLASSROOM_STORAGE_KEY, state);
        return;
      }
      if (reservation.groupId !== request.groupId) {
        scopeMismatch = true;
        if (changed) await transaction.put(CLASSROOM_STORAGE_KEY, state);
        return;
      }
      found = true;
      let group = state.groups[reservation.groupId];
      if (!group) {
        group = freshClassroomGroup(now);
        state.groups[reservation.groupId] = group;
      }
      state.lifetimeReservedMicrocents = Math.max(
        0,
        state.lifetimeReservedMicrocents - reservation.reservedCostMicrocents,
      );
      state.lifetimeSpentMicrocents += request.actualCostMicrocents;
      group.lifetimeReservedMicrocents = Math.max(
        0,
        group.lifetimeReservedMicrocents - reservation.reservedCostMicrocents,
      );
      group.lifetimeSpentMicrocents += request.actualCostMicrocents;
      if (reservation.dayKey === group.dayKey) {
        group.dayReservedMicrocents = Math.max(
          0,
          group.dayReservedMicrocents - reservation.reservedCostMicrocents,
        );
        group.daySpentMicrocents += request.actualCostMicrocents;
      }
      if (reservation.minuteKey === group.minuteKey) {
        group.tokensThisMinute = Math.max(
          0,
          group.tokensThisMinute -
            reservation.estimatedTokens +
            request.actualTokens,
        );
      }
      delete state.reservations[request.requestId];
      storeClassroomReceipt(state, request, reservation.groupId, now);
      changed = true;
      await transaction.put(CLASSROOM_STORAGE_KEY, state);
    });
    if (scopeMismatch)
      return Response.json(
        { completed: false, reason: "completion_scope_mismatch" },
        { status: 409 },
      );
    if (mismatch)
      return Response.json(
        { completed: false, reason: "completion_mismatch" },
        { status: 409 },
      );
    if (!found && !knownCompleted)
      return Response.json(
        { completed: false, reason: "unknown_reservation" },
        { status: 404 },
      );
    return Response.json({ completed: true, found, knownCompleted });
  }
}
