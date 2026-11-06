/**
 * zx_20260930 M15-④：全局错误处置的**接线**（一处），供 `index.ts` 与判据共用。
 *
 * 为什么把这一跳抽出来：处置逻辑（`errorResponseOf`）是纯函数、能直调；但"路由抛错 → 到底回什么
 * 状态码/什么体"这件事**还经过 `.onError` 这一跳**。若判据自己再写一遍这个回调，
 * 测的就是判据自己那份转写（"判据的自我印证"——全绿证的是生产没走的路）。
 *
 * ⚠ 刻意**不是**一个 `Elysia` 插件：实测（Elysia 1.4）一个**没有路由**的插件里注册的 `onError`
 *   不会上浮到父实例 ⇒ `.use(errorHandler())` 等于没挂（错误走了 Elysia 内置处置，把
 *   `error.message` 原文当响应体回出去——正是本项要消掉的泄漏）。
 *   故这里导出**回调本身**，调用侧一律 `.onError(handleRouteError)`：生产与判据用的是同一个函数。
 */
import { errorResponseOf } from './errors.js';
import { createLogger } from './logger.js';

const logger = createLogger('error-handler');

/**
 * Elysia `.onError` 上下文里本回调用到的两件（结构对齐即可，不引 Elysia 类型以免强绑版本）。
 *
 * ⚠ `code` 是 `string | number`（Elysia 1.4 的 `ErrorHandler` 上下文如此）——写成 `string` 会让
 *   `.onError(handleRouteError)` 直接**过不了重载**（实测 `TS2769`/`TS2322`：`Type 'number' is not
 *   assignable to type 'string'`），即"接线那一刻的类型就假了"。本回调只认 Elysia 的**字符串**码
 *   （`VALIDATION`/`PARSE`/`NOT_FOUND`），非字符串一律走"其余 ⇒ 500"那一支（`errorResponseOf` 内部
 *   已有 `typeof code === 'string'` 的收窄，行为与写 `string` 时逐字相同）。
 */
export interface RouteErrorContext {
  error: unknown;
  code?: string | number;
  set: { status?: number | string };
}

/** 全局错误处置：细节进日志（有账），响应体只给码 + 通用/刻意文案（不外泄）。 */
export function handleRouteError({ error, code, set }: RouteErrorContext): {
  error: { code: string; message: string; detail?: unknown };
} {
  const { status, body } = errorResponseOf(error, code);
  const log = { err: error, code, status };
  if (status >= 500) logger.error(log, '路由未捕获错误');
  else logger.warn(log, '路由错误');
  set.status = status;
  return body;
}
