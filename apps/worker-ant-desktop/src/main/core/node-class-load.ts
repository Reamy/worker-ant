/**
 * zx_20261112_1 B5「衡」（管子·度地 / 维特根斯坦·意义即用法）: **本机六类目各有几件在跑**的唯一派生处。
 *
 * 病根：`free_slots` 只答"机器还有几个槽"，不答"哪一类正挤"——一台 8 槽机器上 6 件都在跑 `code`，
 *   对另一件 `code` 任务而言它其实已经很挤；派单方却只见"还剩 2 槽"。本模块把在跑任务按**能力类目**分桶。
 *
 * 三种口径各自一处：
 *   ① 哪些状态算"在跑"——`PROJECT_RUNNING_STATUSES`（占位三态，与机器槽位同一把尺，勿另抄）；
 *   ② 一件任务算**哪一类**——已存 `dispatch_requirements.categories` 优先，缺则按任务形态
 *      `routeCategoryForTask` 兜底（与派单/路由同源）；判不出 ⇒ 不记入任何类目（不猜）；
 *   ③ 「读不到」＝`null`（未知），不是全 0——全 0 会被派单方读成"这类空闲着"。
 *
 * ⚠ `classRunningOfRows` / `sanitizeClassRunning` 是**纯函数**（无 DB / 网络 / 时钟），rr 直跑真实现；
 *   只有 `deriveClassRunning` 读库（且失败如实回 `null`）。
 */
import { NODE_CARD_CATEGORIES, type NodeCardCategory } from '@worker-ant/shared-types';
import { PROJECT_RUNNING_STATUSES } from './task-accounting.js';
import { requirementsForTask } from './task-capability.js';
import { routeCategoryForTask } from './task-routing.js';

/** 六类目在跑数（键恒齐——没在跑就是 0，与"未知"由 `null` 区分）。 */
export type ClassRunning = Record<NodeCardCategory, number>;

/** 全零快照（"已知确实没在跑"）；未知请用 `null`，勿用本函数冒充。 */
export function emptyClassRunning(): ClassRunning {
  const out = {} as ClassRunning;
  for (const c of NODE_CARD_CATEGORIES) out[c] = 0;
  return out;
}

/**
 * 心跳/状态里的 `class_running` 洗形：**六键齐全且均为非负有限数**才认，否则 `null`（未知）。
 * 缺键的旧上报不补齐成 0——"少报一类"不等于"这一类空闲"。
 */
export function sanitizeClassRunning(raw: unknown): ClassRunning | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const out = {} as ClassRunning;
  for (const c of NODE_CARD_CATEGORIES) {
    const v = o[c];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return null;
    out[c] = v;
  }
  return out;
}

/** 一件在跑任务判定类目所必要的字段（`wa_tasks` 行子集）。 */
export interface ClassLoadRow {
  title?: unknown;
  description?: unknown;
  context_json?: string | Buffer | null;
}

/**
 * 一组在跑任务 → 六类目计数。
 *   类目来源：已存 `dispatch_requirements.categories` 优先；为空则 `routeCategoryForTask` 兜底；
 *   两处都判不出 ⇒ 该件不计入任何类目（未知不外推）。一件任务声明多类目时逐类各计一次。
 */
export function classRunningOfRows(rows: readonly ClassLoadRow[]): ClassRunning {
  const out = emptyClassRunning();
  for (const row of rows) {
    const req = requirementsForTask({
      title: row.title,
      description: row.description,
      contextJson: row.context_json ?? null,
    });
    let cats = req.categories;
    if (cats.length === 0) {
      const fallback = routeCategoryForTask(row.title, row.description);
      if (fallback) cats = [fallback];
    }
    for (const c of cats) {
      if (c in out) out[c] += 1;
    }
  }
  return out;
}

/** 读库所需的最小接口（与 `task-accounting` 的 `AccountingDb` 同形，避免多造一种）。 */
export interface ClassLoadDb {
  prepare(sql: string): { all(...args: unknown[]): unknown[] };
}

/**
 * 本机在跑任务按类目分桶。**读不到任务表 ⇒ `null`（未知）**，不写全 0 冒充"都没在跑"。
 */
export function deriveClassRunning(db: ClassLoadDb): ClassRunning | null {
  try {
    const placeholders = PROJECT_RUNNING_STATUSES.map(() => '?').join(',');
    const rows = db
      .prepare(`SELECT title, description, context_json FROM wa_tasks WHERE status IN (${placeholders})`)
      .all(...PROJECT_RUNNING_STATUSES) as ClassLoadRow[];
    return classRunningOfRows(rows);
  } catch {
    return null;
  }
}
