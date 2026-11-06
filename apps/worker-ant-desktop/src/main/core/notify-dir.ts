/**
 * zx_20261003 M9（纯搬移·零语义变更）: 通知目录的**单一持有者**——`_notificationDir` 与 `setNotificationDir`。
 *
 * 搬迁来源：`services/im-router.ts` 原 `:88`–`:89`，并收拢原先散在 **4 处**的同一兜底表达式
 *   `_notificationDir || path.join(process.cwd(), '../../data/notification_payloads')`
 *   （im-router 命令侧 `:872` + F3 侧 `:1035`/`:1103`/`:1143`）为**唯一**一处 `resolveNotificationDir()`
 *   ——同一件事两处各写一份即会分家（本仓 G2 病根），故目录解析只此一处。
 *
 * ⚠ **跨仓契约**：env `NOTIFICATION_PAYLOAD_DIR` 与目录名 `data/notification_payloads` 是另一仓（a-stock）
 *   依赖的契约，**不得改**。本模块只把这份目录的**持有与解析**收到一处，不改名、不换路。
 */
import path from 'node:path';
import { packagedUserDataDir } from './app-paths.js';

let _notificationDir = '';
export function setNotificationDir(dir: string): void { _notificationDir = dir; }

/**
 * 通知目录的**唯一**解析式：显式设过则用之；否则打包版落 `<userData>/notification_payloads`
 *   （cwd 是 `/`），dev/rr 仍退回 `../../data/notification_payloads`。
 */
export function resolveNotificationDir(): string {
  if (_notificationDir) return _notificationDir;
  const packagedRoot = packagedUserDataDir();
  return packagedRoot
    ? path.join(packagedRoot, 'notification_payloads')
    : path.join(process.cwd(), '../../data/notification_payloads');
}
