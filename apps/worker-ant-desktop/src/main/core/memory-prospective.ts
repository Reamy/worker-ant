/**
 * zx_20261004 M14（K-8 轻得下 / 维特根斯坦·一个规则一处）: **前瞻记忆簇**——自 `memory-manager.ts`
 * 机械搬迁而来的自由函数（来源符号区间：原 `storeProspective` … `scanDueProspective`，即该文件
 * 1988–2078 行）。**逐字节行为不变**：SQL、JSON 形状、常量一字未动。
 *
 * 函数取 `(mgr, …)`——`mgr` 只需满足下方最小宿主接口。`MemoryManager` 的同名方法现为**薄委托**，
 * 故全部既有调用点零改动。宿主接口带 `scheduleChanged`：节流器 `scheduleMemoryChanged` 仍留在
 * `memory-manager.ts`（经此注入，避免 `memory-prospective.ts` 反向 import 该文件而成 ESM 环）。
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { MEM_IMPORTANCE_DEFAULT } from './memory-constants.js';
import { dbTimeMs } from './memory-decay.js';
// 仅类型（打包期擦除）——不构成 `memory-manager.ts` 的运行期反向依赖。
import type { MemoryEntry } from './memory-manager.js';
// zx_20261012_1 批一（M29 静默失败清零）: 空 catch 换为 `recordMemoryFailure`（降级不变，留痕）。
import { recordMemoryFailure, MEM_FAIL } from './memory-failure.js';

/** 前瞻记忆簇所需的最小宿主面：一个库 + 一个"记忆已变"节流发射（`MemoryManager` 结构上满足）。 */
export interface MemoryProspectiveHost {
  readonly db: Database.Database;
  scheduleChanged(projectId: string | null | undefined, memoryType: string): void;
}

/** 登记前瞻记忆（记住未来要做的事）。trigger_condition 为事件型文本，due_at 为时间型（可选）。 */
export function storeProspective(mgr: MemoryProspectiveHost, params: { projectId: string; taskId?: string; content: string; triggerCondition?: string; dueAt?: string }): string {
  const id = randomUUID();
  const ctx = {
    prospective: {
      trigger_condition: params.triggerCondition ?? '',
      due_at: params.dueAt ?? null,
      status: 'pending',
      created_task_id: params.taskId ?? null,
    },
  };
  mgr.db.prepare(
    'INSERT INTO wa_memories (id, project_id, task_id, content, memory_type, importance, source, context_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))',
  ).run(id, params.projectId, params.taskId ?? null, params.content, 'prospective', MEM_IMPORTANCE_DEFAULT, 'agent_execution', JSON.stringify(ctx));
  mgr.scheduleChanged(params.projectId, 'prospective');
  return id;
}

/** 列出项目内前瞻记忆（含各状态，调用方按 status 过滤）。 */
export function listProspective(mgr: MemoryProspectiveHost, projectId: string, limit = 30): MemoryEntry[] {
  try {
    return mgr.db.prepare(
      "SELECT * FROM wa_memories WHERE project_id = ? AND memory_type = 'prospective' ORDER BY created_at DESC LIMIT ?",
    ).all(projectId, limit) as MemoryEntry[];
  } catch (err) { recordMemoryFailure(MEM_FAIL.prospectiveList, err, { projectId }); return []; }
}

/** 检查前瞻记忆触发：事件型（trigger_condition 关键词命中 taskText）或时间型（due_at 已过）。 */
export function getTriggeredProspective(mgr: MemoryProspectiveHost, projectId: string, taskText: string): MemoryEntry[] {
  const triggered: MemoryEntry[] = [];
  try {
    const now = Date.now();
    for (const m of listProspective(mgr, projectId, 30)) {
      let p: { trigger_condition?: string; due_at?: string | null; status?: string } = {};
      try {
        const ctx = JSON.parse(m.context_json || '{}') as { prospective?: typeof p };
        p = ctx.prospective || {};
      } catch (err) { recordMemoryFailure(MEM_FAIL.prospectiveParse, err, { id: m.id }); }
      if (p.status === 'done' || p.status === 'triggered') continue;
      let hit = false;
      if (p.due_at) {
        // zx_20260929 M4: `due_at` 由模型经 `remember_intent` 自填（`tools/memory.ts` 声明为 ISO），
        //   非 SQLite 列 ⇒ 与"库里串"不同类；但同文件不该有两把尺：`dbTimeMs` 对带 `Z`/偏移的 ISO
        //   **原样放行**（模型按契约填写时语义不变），对无时区串则与全文件一致地按 UTC 解析。
        const due = dbTimeMs(p.due_at);
        if (!Number.isNaN(due) && due <= now) hit = true;
      }
      if (!hit && p.trigger_condition) {
        const kws = p.trigger_condition.split(/[\s,，。、；：！？]+/).filter(k => k.length > 1);
        hit = kws.some(k => taskText.toLowerCase().includes(k.toLowerCase()));
      }
      if (hit) triggered.push(m);
    }
  } catch (err) { recordMemoryFailure(MEM_FAIL.prospectiveGetTriggered, err, { projectId }); }
  return triggered;
}

/** 标记前瞻记忆为已触发。 */
export function markProspectiveTriggered(mgr: MemoryProspectiveHost, id: string): void {
  try {
    const row = mgr.db.prepare('SELECT context_json FROM wa_memories WHERE id = ?').get(id) as { context_json: string } | undefined;
    if (!row) return;
    const ctx = JSON.parse(row.context_json || '{}') as Record<string, unknown>;
    const p = (ctx.prospective as Record<string, unknown>) || {};
    p.status = 'triggered';
    ctx.prospective = p;
    mgr.db.prepare("UPDATE wa_memories SET context_json = ?, updated_at = datetime('now'), last_used_at = datetime('now'), use_count = COALESCE(use_count,0) + 1 WHERE id = ?").run(JSON.stringify(ctx), id);
  } catch (err) { recordMemoryFailure(MEM_FAIL.prospectiveMark, err, { id }); }
}

/** Phase 3.1: 扫描所有项目中 due_at 到期的前瞻记忆（时间型，空闲周期扫描用）。命中即标记 triggered 并返回。 */
export function scanDueProspective(mgr: MemoryProspectiveHost, now: number): Array<{ id: string; projectId: string; content: string }> {
  const due: Array<{ id: string; projectId: string; content: string }> = [];
  try {
    const rows = mgr.db.prepare(
      "SELECT id, project_id, content, context_json FROM wa_memories WHERE memory_type = 'prospective' AND context_json LIKE '%\"due_at\"%'",
    ).all() as Array<{ id: string; project_id: string; content: string; context_json: string }>;
    for (const r of rows) {
      try {
        const ctx = JSON.parse(r.context_json || '{}') as { prospective?: { due_at?: string | null; status?: string } };
        const p = ctx.prospective || {};
        if (p.status === 'done' || p.status === 'triggered') continue;
        if (!p.due_at) continue;
        const dueAt = dbTimeMs(p.due_at); // zx_20260929 M4: 同上，一把尺
        if (Number.isNaN(dueAt) || dueAt > now) continue;
        markProspectiveTriggered(mgr, r.id);
        due.push({ id: r.id, projectId: r.project_id, content: r.content });
      } catch (err) { recordMemoryFailure(MEM_FAIL.prospectiveParse, err, { id: r.id, from: 'scan' }); }
    }
  } catch (err) { recordMemoryFailure(MEM_FAIL.prospectiveScan, err); }
  return due;
}
