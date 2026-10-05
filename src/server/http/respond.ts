/**
 * 统一的响应封装：`{ data, meta }` / `{ error, meta }`。
 * docs/03 §7 规定所有接口共用这两个信封，因此只能在这里构造。
 */
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';

/**
 * 错误码 → HTTP 状态。
 * 未登记的错误码会退化成 400，因此新增错误码时必须同步登记，
 * 否则「操作进行中」这类冲突会被错报成输入错误。
 */
export const ERROR_STATUS: Record<string, number> = {
  INVALID_INPUT: 400,
  SESSION_EXPIRED: 401,
  SESSION_CHANGED: 409,
  ACTION_AUTHORIZATION_REQUIRED: 403,
  TOOL_NOT_ALLOWED: 403,
  RESOURCE_NOT_FOUND: 404,
  EVENT_NOT_FOUND: 404,
  STOP_NOT_FOUND: 404,
  CANDIDATE_NOT_FOUND: 404,
  PLACE_NOT_FOUND: 404,
  TOOL_NOT_FOUND: 404,
  REVISION_CONFLICT: 409,
  IDEMPOTENCY_CONFLICT: 409,
  PROPOSAL_EXPIRED: 409,
  UNDO_CONFLICT: 409,
  SOURCE_CHANGED: 409,
  OPERATION_TERMINAL: 409,
  OPERATION_IN_PROGRESS: 409,
  OPERATION_CANCELLED: 409,
  OPERATION_LEASED: 409,
  LEASE_LOST: 409,
  ACTION_REQUEST_EXISTS: 409,
  ACTION_AUTHORIZATION_INVALID: 409,
  ACTION_ALREADY_EXECUTED: 409,
  INVALID_TRIP_STATE: 409,
  EXECUTION_DATE_CONFLICT: 409,
  EXECUTION_FACT_PROTECTED: 409,
  PLAN_TIME_OR_PROGRESS_CONFLICT: 409,
  ACTIVE_STOP_CONFLICT: 409,
  TIME_INTERVAL_CONFLICT: 409,
  INVALID_EXECUTION_TRANSITION: 409,
  DATA_MODE_MISMATCH: 409,
  TRIP_MISMATCH: 409,
  OPERATION_EXISTS: 409,
  INVALID_OPERATION_STATE: 409,
  ENTRY_VERSION_CONFLICT: 409,
  HARD_CONSTRAINT_VIOLATION: 422,
  EVIDENCE_INSUFFICIENT: 422,
  WRITE_BATCH_NOT_SUPPORTED: 422,
  BUDGET_EXHAUSTED: 429,
  RATE_LIMITED: 429,
  TOOL_EXECUTION_FAILED: 502,
  PROVIDER_UNAVAILABLE: 503,
  PERSISTENCE_FAILED: 503,
  OPERATION_TIMEOUT: 504,
};

export function statusFor(code: string | undefined): number {
  return ERROR_STATUS[code ?? 'INVALID_INPUT'] ?? 400;
}

export function requestId(): string {
  return `req_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
}

export function sendJson(
  response: ServerResponse,
  status: number,
  payload: Record<string, unknown>,
): void {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  });
  response.end(body);
}

export function sendData(
  response: ServerResponse,
  data: unknown,
  meta: Record<string, unknown> = {},
): void {
  sendJson(response, 200, { data, meta: { requestId: requestId(), ...meta } });
}

export function sendError(
  response: ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
  retryable = false,
): void {
  sendJson(response, status, {
    error: { code, message, retryable, ...(details ? { details } : {}) },
    meta: { requestId: requestId() },
  });
}

/** 服务层返回的 ServiceResult 直接转成错误响应，并用领域错误码决定状态。 */
export function sendServiceError(
  response: ServerResponse,
  result: {
    error?: {
      code: string;
      message: string;
      details?: Record<string, unknown>;
      retryable?: boolean;
    };
  },
  fallbackCode = 'INVALID_INPUT',
): void {
  const code = result.error?.code ?? fallbackCode;
  sendError(
    response,
    statusFor(code),
    code,
    result.error?.message ?? '请求失败。',
    result.error?.details,
    result.error?.retryable ?? false,
  );
}

/** 429 分支集中在这里，避免每个限流点在四处复制同样的响应体。 */
export function sendRateLimited(
  response: ServerResponse,
  retryAfterSeconds: number,
  message = '请求过于频繁，请稍后重试。',
): void {
  sendError(response, 429, 'RATE_LIMITED', message, { retryAfterSeconds });
}
