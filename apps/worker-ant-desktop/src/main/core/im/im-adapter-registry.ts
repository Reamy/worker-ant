/**
 * 运行中的 IM 适配器注册表（全仓**唯一**一份）。
 *
 * zx_20261106_1 M1（维特根斯坦·一处真源 / 毛选·抓而不紧等于不抓）:
 *   此前这张表是 `ipc/im.ipc.ts` 的模块私有 `Map`，而通知路径在 `core/im/im-notify.ts`——
 *   要取适配器只能 `await import('../../ipc/im.ipc.js')`，而该文件**静态** `import { ipcMain } from 'electron'`。
 *   tsup `clean:true` 把动态 import 拆成带哈希的 chunk（`dist/im-notify-*.js` 之流），运行中的主进程
 *   仍持有旧 chunk 名；重建一次、旧 chunk 被删，下一次通知就整段 import 失败并被裸 catch 吞掉
 *   ⇒ 三本账同时为零，用户只看到"没收到通知"（2026-11-05 `ecc18d8e` 实机标本）。
 *
 *   把表放进 core、只 `import type` 适配器接口：通知/补发/网关三处**静态**引用同一对象，
 *   不再有第二张表，也不再需要"为了拿适配器去动态加载一个依赖 electron 的模块"。
 */
import type { ImAdapter } from '../../services/im-adapter.js';

const activeAdapters = new Map<string, ImAdapter>();

export function getActiveImAdapter(id: string): ImAdapter | undefined {
  return activeAdapters.get(id);
}

export function setActiveImAdapter(id: string, adapter: ImAdapter): void {
  activeAdapters.set(id, adapter);
}

export function deleteActiveImAdapter(id: string): void {
  activeAdapters.delete(id);
}

export function eachActiveImAdapter(fn: (adapter: ImAdapter, id: string) => void): void {
  for (const [id, adapter] of activeAdapters) fn(adapter, id);
}

export function activeImAdapterIds(): string[] {
  return Array.from(activeAdapters.keys());
}

export function clearActiveImAdapters(): void {
  activeAdapters.clear();
}
