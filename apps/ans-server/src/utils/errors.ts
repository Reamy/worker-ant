/**
 * ANS服务端错误码与结构化错误响应。
 */

export const ErrorCode = {
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  CIRCUIT_OPEN: 'CIRCUIT_OPEN',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
  GATEWAY_ERROR: 'GATEWAY_ERROR',
  VALIDATION_ERROR: 'VALIDATION_ERROR',
} as const;

export type ErrorCodeType = (typeof ErrorCode)[keyof typeof ErrorCode];

export class AppError extends Error {
  constructor(
    public code: ErrorCodeType,
    message: string,
    public status: number = 400,
    public detail?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export function notFound(resource: string, id: string): AppError {
  return new AppError(ErrorCode.NOT_FOUND, `${resource} not found: ${id}`, 404);
}

export function conflict(message: string): AppError {
  return new AppError(ErrorCode.CONFLICT, message, 409);
}

export function unauthorized(message = 'Invalid or missing credentials'): AppError {
  return new AppError(ErrorCode.UNAUTHORIZED, message, 401);
}

export function rateLimited(message = 'Too many requests'): AppError {
  return new AppError(ErrorCode.RATE_LIMITED, message, 429);
}

/**
 * 非 `AppError` 一律回这句（**一处真源**）。zx_20260930 M15-④：内部细节只进日志，不进响应体。
 */
export const INTERNAL_ERROR_MESSAGE = 'Internal server error';

export function formatErrorResponse(error: unknown): { error: { code: string; message: string; detail?: unknown } } {
  if (error instanceof AppError) {
    // `AppError` 的 message/detail 都是**本仓刻意写给人看的**（如 rate-limiter 的 `{ retryAfter }`）⇒ 原样回。
    return { error: { code: error.code, message: error.message, detail: error.detail } };
  }
  // M15-④: 此前这里回 `error.message`——`throw new Error('upstream http://ans.internal:3001/x failed')`
  //   那类原文里就带着**内网 URL / SQL 列名 / 连接错误**，等于把内部细节原样交给调用方。
  //   现在统一通用文案；原文由调用侧（`.onError`）打日志——**有账，但不外泄**。
  return { error: { code: ErrorCode.INTERNAL_ERROR, message: INTERNAL_ERROR_MESSAGE } };
}

/** 错误响应的「状态码 + 体」两件（`.onError` 的产出形状）。 */
export interface ErrorResponse {
  status: number;
  body: { error: { code: string; message: string; detail?: unknown } };
}

/**
 * zx_20260930 M15-④：路由错误的**唯一处置**（纯函数，供 `index.ts` 的 `.onError` 调用）。
 *
 * 四支，各自给**能据以行动**的码与文案：
 *   ① `AppError` → 它自己的 status/code/message（含 detail）；
 *   ② Elysia `VALIDATION` → 400 `VALIDATION_ERROR`——**不回**校验器原文（它含 schema 细节）；
 *   ③ `NOT_FOUND` / `PARSE` → 404 / 400，也是一句通用文案；
 *   ④ 其余（含裸 `Error`）→ 500 + `INTERNAL_ERROR_MESSAGE`。
 * `code` 取 Elysia `.onError` 上下文里的那个值（非 AppError 时才有意义）。⚠ 传 `unknown` 而非 `string`
 * ——上下文里它是 `string | number`（见 `error-handler.ts` 的 `RouteErrorContext` 注）；内部已按
 * `typeof code === 'string'` 收窄，**非字符串 = 落"其余 ⇒ 500"那一支**，与签名写 `string` 时行为逐字相同。
 */
export function errorResponseOf(error: unknown, code?: unknown): ErrorResponse {
  if (error instanceof AppError) return { status: error.status, body: formatErrorResponse(error) };
  const c = typeof code === 'string' ? code : '';
  if (c === 'VALIDATION')
    return { status: 400, body: { error: { code: ErrorCode.VALIDATION_ERROR, message: 'Invalid request' } } };
  if (c === 'PARSE')
    return { status: 400, body: { error: { code: ErrorCode.INVALID_REQUEST, message: 'Invalid request body' } } };
  if (c === 'NOT_FOUND') return { status: 404, body: { error: { code: ErrorCode.NOT_FOUND, message: 'Not found' } } };
  return { status: 500, body: formatErrorResponse(error) };
}
