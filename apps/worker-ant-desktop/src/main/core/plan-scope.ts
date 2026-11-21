/**
 * zx_20261116_1 M2「界」：方案轮的“只形成方案 / 不动代码”边界，沿祖先链继承。
 *
 * 病根（真事故 2026-11-16）：父任务 `18c076d9` 标题是「新后端对接易宝支付对接规划方案」、描述明写
 * 「此次任务只形成方案不动代码」；但自动拆出的报告子任务 `7e60cf1c` 标题/描述不含“规划/排期”，
 * `control-finalize.ts` 的 `isPlanProposal` 只看**当前报告任务自己**的题面 ⇒ 判 false ⇒ 报告里的
 * `⚠` 被派成了修复任务 `9e1e31f5`，并真的改了 `backend/pom.xml`——越过了父任务定的边界。
 *
 * 本模块只回答一件事：**此刻这条任务的上层是否明确说了“只做方案、不动代码”**。
 * 判据刻意收窄：
 *   · 只认**明确的边界句**（`只形成方案` / `不动代码` / `仅方案` …），不把裸“方案”二字当边界——
 *     否则所有带“方案”的实施任务都会被误拦；
 *   · 只看**非终态**祖先（completed/failed/archived 的方案轮已经结束，不该再约束后续实施任务）；
 *   · 祖先收集走 `task-accounting.collectAncestorIds`（既有唯一真源），不另写上溯循环。
 *
 * 零 electron 依赖；rr 可直引真实现。
 */
import { collectAncestorIds } from './task-accounting.js';

/** 明确的“方案轮不动代码”边界句。只此一份；新增说法只能加在这里。 */
export const PLAN_ONLY_RE = /只形成方案|只做方案|仅方案|只出方案|不动代码|不改代码|不修改代码|不落地代码|方案阶段不实施/;

export interface PlanScopeDb {
  prepare(sql: string): { get(...args: unknown[]): unknown };
}

interface AncestorRow {
  id?: unknown;
  title?: unknown;
  description?: unknown;
  status?: unknown;
}

/**
 * 返回**最近一个**明确声明“只做方案/不动代码”的非终态祖先；没有则 `null`。
 *
 * 读库失败按“没有边界”论（返回 null）：宁可让旧行为继续，也不因一次读失败把合法修复任务永久抑制。
 */
export function planOnlyScope(db: PlanScopeDb, taskId: string): { id: string; title: string } | null {
  const ids = collectAncestorIds(db as never, taskId);
  for (const id of ids) {
    let row: AncestorRow | undefined;
    try {
      row = db.prepare('SELECT id, title, description, status FROM wa_tasks WHERE id = ?').get(id) as AncestorRow | undefined;
    } catch {
      continue;
    }
    if (!row) continue;
    const status = String(row.status ?? '');
    if (status === 'completed' || status === 'failed' || status === 'archived') continue;
    const text = `${String(row.title ?? '')} ${String(row.description ?? '')}`;
    if (PLAN_ONLY_RE.test(text)) return { id: String(row.id ?? id), title: String(row.title ?? id) };
  }
  return null;
}
