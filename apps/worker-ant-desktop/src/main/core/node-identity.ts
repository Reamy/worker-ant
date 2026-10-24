/**
 * zx_20261004 M2（维特根斯坦·一个概念一个值 / 王阳明·自知者明）: 工蚁**本机节点身份**的唯一真源。
 *
 * 病根：此前本机对"我是谁"**没有概念**——没有 node_id、没有名字，故既不能向 ANS 注册（K-5 一节点一 key），
 * 也不能与其他工蚁相认（批二）。身份**不是**每次现编的：现编一次就是一个新节点，心跳账、令牌账、
 * 面板都跟着漂。故本模块把 `node.id`（UUID，首次生成后**永不改**）与 `node.name`（默认 `os.hostname()`）
 * 收成 `wa_settings` 两行，读写**只此一处**。
 *
 * 本文件只依赖 `node:os` / `node:crypto` 与 `shared-types`（不引 electron / better-sqlite3），
 * 故可被受控回归**直引跑真实现**（同 `ans-signed-request.ts` / `memory-lifecycle.ts` 范式）。
 */
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { NODE_HEARTBEAT_SEC_DEFAULT } from '@worker-ant/shared-types';

/**
 * 读设置的最小库接口（`AnsSettingDb` 同形：使本模块可脱 better-sqlite3 被 rr 直跑）。
 * `run` 为写设置所需——比 `AnsSettingDb` 多一个方法。
 */
export interface NodeSettingDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): unknown;
  };
}

/**
 * 节点相关设置的键名——**只此一处**。散落字面量即"同一件事两处各记各的"，
 * 任一处的键名打错，读到的那侧就静默回落缺省（`node.id` 读成 null ⇒ 又生成一个新节点）。
 */
export const NODE_SETTING_KEYS = {
  id: 'node.id',
  name: 'node.name',
  enrollmentToken: 'node.enrollment_token',
  role: 'node.role',
  weight: 'node.weight',
  participate: 'node.participate',
  heartbeatSec: 'node.heartbeat_sec',
  /** zx_20261011_2 M3: 向上游（派活方）等作答的上限（秒）；未配时回落 `CLARIFY_WAIT_SEC_DEFAULT`。 */
  clarifyWaitSec: 'node.clarify_wait_sec',
  /**
   * zx_20261011_4 M1: 跨机**编排**模式（`off`/`auto`）——**未配即 `off`**（默认关，不惊扰既有行为）。
   *   读口一处真源 `node-orchestrate.readOrchestrateMode`；此键名只此一处（散落即漂）。
   */
  orchestrateMode: 'node.orchestrate_mode',
  /**
   * zx_20261017_1 批三: **建单即派**开关——**默认关**（只认显式 `'1'`）。
   *   读口一处真源 `collab-dispatch.isAutoDispatchOn`（键名只此一处，散落即漂）。
   */
  autoDispatchOnCreate: 'node.auto_dispatch_on_create',
  /**
   * zx_20261018_1 批一: 建单即派的**一次性引导已问过**标记（`'true'` = 已问）。
   *   只在 Team 首次入网后由用户确认（应/不应）时写入；"没这一项"即**尚未引导**
   *   （**不预置缺省值**——预置会让"老机被重问"与"新机漏问"各错一边）。
   *   读口一处真源 `collab-dispatch.isAutoDispatchPrompted`。
   */
  autoDispatchPrompted: 'node.auto_dispatch_prompted',
  /** 注册成功后写回的资源组（`node:<id>`）——**它存在即已注册**（`node.id` 单独存在不算）。 */
  resourceGroup: 'node.resource_group',
  /**
   * zx_20261012：**注册所得 key 的前 8 字符**（与 ANS 侧 `ans_api_keys.key_prefix` 同口径）。
   *   注册成功时写；`nodeEnrollmentReason` 据此判"手里这把 key 是不是注册发的那把"。
   *   **旧装无此项**（本轮之前注册的机器）⇒ 判据按"非占位"放行，一旦重注册即记前缀、转强判据。
   */
  enrolledKeyPrefix: 'node.enrolled_key_prefix',
  /**
   * 本机对 ANS 的**身份两键**（`resolveAnsCreds` 的落点）。注册写回（K-9）与首启铸币（zx_20261009）
   *   **同一处**——原先是 `node-heartbeat.ts` 内的本地副本，两处各记各的即"同一件事两处各记各的"。
   */
  ansApiKey: 'ans_api_key',
  ansSecretKey: 'ans_secret_key',
} as const;

export interface NodeIdentity {
  id: string;
  name: string;
}

/** 读一行设置。表未建 / 无此键 ⇒ `null`（不把"读不到"当成"值为空串"）。 */
export function readNodeSetting(db: NodeSettingDb, key: string): string | null {
  try {
    const row = db.prepare('SELECT value FROM wa_settings WHERE key=?').get(key) as { value?: string } | undefined;
    return row?.value ?? null;
  } catch {
    return null; // 表还没建 / 库未就绪
  }
}

/** 写一行设置（upsert）。写失败**如实上报**（返回 false），不静默吞。 */
export function writeNodeSetting(db: NodeSettingDb, key: string, value: string): boolean {
  try {
    db.prepare(
      `INSERT INTO wa_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(key, value);
    return true;
  } catch {
    return false;
  }
}

/** 读本机身份；未落库 ⇒ `null`。**这是唯一读口**。 */
export function getNodeIdentity(db: NodeSettingDb): NodeIdentity | null {
  const id = readNodeSetting(db, NODE_SETTING_KEYS.id);
  if (!id) return null;
  const name = readNodeSetting(db, NODE_SETTING_KEYS.name);
  return { id, name: name || id };
}

/**
 * 确保本机身份存在——已存在则**原样返回**（幂等），不存在才生成并落库。
 *
 * ⚠ 幂等的意义：凡"启动时调一次 + 每轮心跳调一次"的调用点，第二次必须是**同值**。
 *   若每次现编 UUID，"同一台机器"在 ANS 上会变成不断增殖的幽灵节点。
 */
export function ensureNodeIdentity(db: NodeSettingDb, opts: { hostname?: string } = {}): NodeIdentity {
  const existing = getNodeIdentity(db);
  if (existing) return existing;
  const id = randomUUID();
  // 默认名取 `os.hostname()`（管理员可在设置里改）；hostname 为空时退到 id 前缀，不留空名。
  const name = (opts.hostname ?? os.hostname() ?? '').trim() || id.slice(0, 8);
  writeNodeSetting(db, NODE_SETTING_KEYS.id, id);
  writeNodeSetting(db, NODE_SETTING_KEYS.name, name);
  return { id, name };
}

/** 心跳周期（秒）——设置项非法/缺失时回落共享常量 `NODE_HEARTBEAT_SEC_DEFAULT`。 */
export function readNodeHeartbeatSec(db: NodeSettingDb, fallback: number = NODE_HEARTBEAT_SEC_DEFAULT): number {
  const raw = readNodeSetting(db, NODE_SETTING_KEYS.heartbeatSec);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
