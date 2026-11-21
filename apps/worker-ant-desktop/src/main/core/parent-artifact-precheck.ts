/**
 * zx_20261119_2 M3「审」——**父任务收口前的有界机检**。
 *
 * 病根（真标本 S5）：所有子任务完成后，引擎注入的强制收口提示明令「不要探索、不要创建新任务、
 * 不要搜索」⇒ 父任务只能"整合已有成果"，无法核对子任务产物是否真在盘上。真库里它
 * `run_mutations=1`（只写了一份报告），却对"五个子任务是否都交付了"没有任何机检。
 *
 * 本模块只做**存在性**核对：取直接子任务的在册产出物 `file_path`，逐个 `existsSync`。
 * **不读内容、不判质量、不写验收账**——机检不是第二套验收；它只把"缺什么"交给提示词，
 * 让父任务如实说"缺"，而不是替它说"已通过"。
 *
 * 有界：每个子任务最多 3 件、总数最多 30 件；超出如实报"另有 N 件未核"。
 * 零 electron 依赖（只用 node:fs），rr 可直调真实现。
 */
import fs from 'node:fs';
import type Database from 'better-sqlite3';

export const PRECHECK_PER_CHILD_LIMIT = 3;
export const PRECHECK_TOTAL_LIMIT = 30;

export interface PrecheckMissing {
  taskId: string;
  taskTitle: string;
  path: string;
}

export interface ArtifactPrecheckResult {
  /** 参与核对的直接子任务数 */
  children: number;
  /** 实际检查的产出物件数 */
  checked: number;
  /** 不在盘上的件（父任务须在报告中如实说明） */
  missing: PrecheckMissing[];
  /** 超出上限未核的件数（如实上报） */
  skipped: number;
  /** 名下**一件可核产出物都没有**的子任务数（不是"文件缺失"，是"没登记"） */
  childrenWithoutDeliverables: number;
}

export interface PrecheckOptions {
  perChild?: number;
  totalLimit?: number;
  /** 注入探针（rr 用）；缺省 `fs.existsSync` */
  exists?: (p: string) => boolean;
}

export function preflightChildrenArtifacts(
  db: Database.Database,
  parentTaskId: string,
  opts: PrecheckOptions = {},
): ArtifactPrecheckResult {
  const perChild = Math.max(1, opts.perChild ?? PRECHECK_PER_CHILD_LIMIT);
  const totalLimit = Math.max(1, opts.totalLimit ?? PRECHECK_TOTAL_LIMIT);
  const exists = opts.exists ?? ((p: string) => {
    try { return fs.existsSync(p); } catch { return false; }
  });
  const children = (() => {
    try {
      return db.prepare('SELECT id, title FROM wa_tasks WHERE parent_task_id = ? ORDER BY created_at ASC')
        .all(parentTaskId) as Array<{ id: string; title: string }>;
    } catch { return []; }
  })();

  let checked = 0;
  let skipped = 0;
  let childrenWithoutDeliverables = 0;
  const missing: PrecheckMissing[] = [];
  for (const child of children) {
    let paths: string[] = [];
    try {
      const rows = db.prepare(
        "SELECT file_path FROM wa_deliverables WHERE task_id = ? AND file_path IS NOT NULL AND TRIM(file_path) <> '' ORDER BY rowid ASC",
      ).all(child.id) as Array<{ file_path: string }>;
      paths = rows.map((r) => String(r.file_path));
    } catch { /* 单子取数失败 ⇒ 按"没登记"处理 */ }
    if (paths.length === 0) { childrenWithoutDeliverables++; continue; }
    const take = paths.slice(0, perChild);
    skipped += paths.length - take.length; // 超出"每子任务上限"的部分
    for (const p of take) {
      if (checked >= totalLimit) { skipped++; continue; } // 超出"总数上限"的部分
      checked++;
      if (!exists(p)) missing.push({ taskId: child.id, taskTitle: String(child.title ?? ''), path: p });
    }
  }
  return { children: children.length, checked, missing, skipped, childrenWithoutDeliverables };
}

/**
 * 把机检结果渲染成提示词一段。**只报"缺"与"有多少"，不说"通过/验收"**。
 * 无子任务/无可核件时也如实说明——不能因为"没东西可核"就假装核过了。
 */
export function buildArtifactPrecheckNote(r: ArtifactPrecheckResult): string {
  if (r.children === 0) return '[机检] 没有直接子任务，无可核产出物。';
  const tail = r.skipped > 0 ? `；另有 ${r.skipped} 件未核（超出单次核对上限）` : '';
  if (r.checked === 0) {
    return `[机检] 子任务未登记可核产出物（${r.childrenWithoutDeliverables}/${r.children} 个未登记），无法核对文件是否在盘上${tail}。请在最终报告中如实说明。`;
  }
  if (r.missing.length === 0) {
    return `[机检] 已核对 ${r.checked} 件子任务产出物，均在盘上${tail}。`;
  }
  const shown = r.missing.slice(0, 10).map((m) => `${m.taskTitle || m.taskId.slice(0, 8)} → ${m.path}`).join('；');
  const more = r.missing.length > 10 ? ` 等 ${r.missing.length} 件` : '';
  return `[机检] 已核对 ${r.checked} 件子任务产出物，其中 ${r.missing.length} 件不在盘上：${shown}${more}${tail}。请在最终报告中如实说明（不得声称已完成）。`;
}
