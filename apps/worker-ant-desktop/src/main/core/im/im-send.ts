/**
 * IM **发送真源**（不依赖 electron）。
 *
 * zx_20261106_1 M1（维特根斯坦·意义即使用 / 知行合一）:
 *   三条发送入口此前都住在 `ipc/im.ipc.ts`（静态 import electron）：
 *     · `sendImCompletionNotice`（通知路，返回 `{ok,error?}` 不抛）；
 *     · `sendImMessage` / `sendImMedia`（补发/手发路，严格抛出）。
 *   core 侧（`im-notify.ts`、`im-outbox.ts`）为了拿到它们只能**动态 import**——而动态 chunk 会被
 *   tsup `clean` 删掉，运行中的旧进程随即失配。现把实现下沉到这里：只依赖适配器注册表与能力表，
 *   `ipc/im.ipc.ts` 保留同名导出作为薄委托（外部契约不变），core 侧全部静态引用。
 */
import type { ImSendOpts } from '../../services/im-adapter.js';
import { getActiveImAdapter } from './im-adapter-registry.js';
import { MEDIA_UNSUPPORTED_TEXT } from './channel-capabilities.js';

/** 通知入口：**不抛**，无适配器/发送抛错都回 `{ok:false, error}`（供 outbox 补发判定）。 */
export async function sendImText(
  channelId: string,
  toUser: string,
  taskId: string,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  const adapter = getActiveImAdapter(channelId);
  if (!adapter) return { ok: false, error: '[IM] 渠道适配器未运行' };
  try {
    // `taskId` 为空串时传 `undefined`（= 不知道），不写空归属（承 zx_20260930 M2-c）。
    await adapter.sendReply(toUser || '', message, undefined, taskId ? { taskId } : undefined);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message || String(err) };
  }
}

/**
 * 严格发送入口：无适配器/发送异常**一律抛出**，不吞。
 * 供 `im-outbox` 区分「发送条件缺失」(`ImQuotaError`) 与「真失败」。
 */
export async function sendImMessage(
  channelId: string,
  toUser: string,
  message: string,
  opts?: ImSendOpts,
): Promise<void> {
  const adapter = getActiveImAdapter(channelId);
  if (!adapter) throw new Error('[IM] 渠道适配器未运行');
  await adapter.sendReply(toUser || '', message, undefined, opts);
}

/**
 * 严格发件入口：与 `sendImMessage` 同契约（无适配器/未实现/发送异常**一律抛出**）。
 * 三条"不假装"见 `MEDIA_UNSUPPORTED_TEXT`（能力表/补发前置拒绝/界面禁用钮同源）。
 */
export async function sendImMedia(
  channelId: string,
  toUser: string,
  file: { path: string; kind: 'image' | 'file'; name?: string },
  opts?: ImSendOpts,
): Promise<void> {
  const adapter = getActiveImAdapter(channelId);
  if (!adapter) throw new Error('[IM] 渠道适配器未运行');
  if (!adapter.sendMedia) throw new Error(`[IM] ${MEDIA_UNSUPPORTED_TEXT}`);
  await adapter.sendMedia(toUser || '', file, opts);
}
