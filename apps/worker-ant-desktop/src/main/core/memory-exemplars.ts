/**
 * zx_20261018_2 批七（见简 / 维特根斯坦·一个规则一处）: **范例与相似簇**——自 `memory-manager.ts`
 * 机械搬迁而来的自由函数（来源符号：`markExemplar` / `unmarkExemplar` / `getExemplars` /
 * `generateExemplarContext` / `findSimilarTasks` / `getSimilarTaskExperience` /
 * `findCrossProjectSimilarTasks` / `getCrossProjectKnowledge` / `clusterSimilarMemories`）。
 * **逐字节行为不变**：SQL、阈值、JSON 形状、提示词一字未动。
 *
 * 函数取 `(mgr, …)`——`mgr` 只需满足下方最小宿主接口。`MemoryManager` 的同名方法现为**薄委托**，
 * 故全部既有调用点零改动。
 */
import type Database from 'better-sqlite3';
import { createLogger } from './logger.js';
import { boolSetting } from './settings-bool.js';
import { MEM_LIVE_SQL } from './memory-lifecycle.js';
import { cosineSimilarity } from './memory-retrieval.js';

const logger = createLogger('memory');

/** 范例/相似簇所需的最小宿主面（`MemoryManager` 结构上满足）。 */
export interface MemoryExemplarHost {
  readonly db: Database.Database;
}

/** 标记一条记忆为范例（正例或反例） */
export function markExemplar(mgr: MemoryExemplarHost, id: string, type: 'good' | 'bad', context?: { archetype?: string; trigger?: string; toolSequence?: string[] }): void {
  try {
    const ctx = context ? JSON.stringify(context) : null;
    mgr.db.prepare("UPDATE wa_memories SET is_exemplar = 1, exemplar_type = ?, exemplar_context = ? WHERE id = ?").run(type, ctx, id);
  } catch { /* best-effort */ }
}

/** 取消范例标记 */
export function unmarkExemplar(mgr: MemoryExemplarHost, id: string): void {
  try {
    mgr.db.prepare("UPDATE wa_memories SET is_exemplar = 0, exemplar_type = NULL, exemplar_context = NULL WHERE id = ?").run(id);
  } catch { /* best-effort */ }
}

/** 获取项目的范例记忆（effectRank=true 时按"被真正应用"证据升序优先——A2 用法即意义，importance 仍主键） */
export function getExemplars(mgr: MemoryExemplarHost, projectId: string, type?: 'good' | 'bad', limit = 5, effectRank = false): Array<{ id: string; content: string; type: string; context: unknown }> {
  try {
    const typeFilter = type ? "AND exemplar_type = ?" : "";
    const params: unknown[] = [projectId];
    if (type) params.push(type);
    const rows = mgr.db.prepare(
      // zx_20260911_4 M5-2(庄子·得鱼忘筌): 范例亦须过归档尺——真库 5 条范例中 3 条为墓碑（含相似冲突墓碑），
      // 此前仍被注入提示词（存→取往返在范例路径上失守）。
      `SELECT id, content, importance, exemplar_type as type, exemplar_context as context, context_json as cj, updated_at as updated FROM wa_memories WHERE project_id = ? ${typeFilter} AND is_exemplar = 1 AND ${MEM_LIVE_SQL}`
    ).all(...params) as Array<{ id: string; content: string; type: string; context: string; cj?: string; importance: number; updated: string }>;
    const list = rows.map(r => {
      let context: unknown = null;
      try { context = r.context ? JSON.parse(r.context) : null; } catch { context = null; }
      let applied = 0; let lastSuccess = false;
      if (effectRank) {
        try { const cj = JSON.parse(r.cj || '{}') as { applied?: { count?: number; last_success?: boolean } }; applied = Number(cj.applied?.count) || 0; lastSuccess = cj.applied?.last_success === true; } catch { /* ignore */ }
      }
      return { id: r.id, content: r.content, type: r.type, context, importance: Number(r.importance) || 0, updated: r.updated || '', applied, lastSuccess };
    });
    // A2 (2026-09-08_1): 有效样板(被后续 run 真正采纳且成功)加权置前——权重小(0.1),importance 仍主键；同分按更新时间
    list.sort((a, b) => {
      const sa = a.importance + (effectRank && a.applied > 0 && a.lastSuccess ? 0.1 : 0);
      const sb = b.importance + (effectRank && b.applied > 0 && b.lastSuccess ? 0.1 : 0);
      if (sa !== sb) return sb - sa;
      return String(b.updated).localeCompare(String(a.updated));
    });
    return list.slice(0, limit).map(({ id, content, type, context }) => ({ id, content, type, context }));
  } catch { return []; }
}

/** 生成范例上下文字符串（注入Agent system prompt；memory.exemplar_effect_rank 开关 true=有效样板优先） */
/**
 * zx_20260913 M4-3(名实相符 / 记账即事实): 本函数此前只回字符串——**内部本有 id**（`getExemplars` 返回含 `id`）
 * 却不外露，于是调用方 `add('范例记忆', ctx)` 无 id 可传 ⇒ 既不能跨 run 排除、也不进 `recordAccess`。
 * 现以**可选 opts** 外露（不动返回类型 ⇒ 既有 3 个 rr 的 `() => ''` 桩照旧成立）：
 *   `excluded`：跨 run 去重（与 `buildMemoryContext` 的 `notExcluded` **同尺**：取回后过滤，不放宽检索面）；
 *   `outIds`：实际写入文本的 id（与文本同序），供 `add(name, text, ids)` 记账。
 */
export function generateExemplarContext(mgr: MemoryExemplarHost, projectId: string, opts?: { excluded?: ReadonlySet<string>; outIds?: string[] }): string {
  let effectRank = true;
  try {
    const s = mgr.db.prepare("SELECT value FROM wa_settings WHERE key = 'memory.exemplar_effect_rank'").get() as { value?: string } | undefined;
    effectRank = boolSetting(s?.value);
  } catch { effectRank = true; }
  const notEx = <T extends { id: string }>(arr: T[]): T[] => opts?.excluded ? arr.filter((e) => !opts.excluded!.has(e.id)) : arr;
  const good = notEx(getExemplars(mgr, projectId, 'good', 3, effectRank));
  const bad = notEx(getExemplars(mgr, projectId, 'bad', 2, effectRank));
  if (good.length === 0 && bad.length === 0) return '';

  let ctx = '\n<exemplar-context>\n[范例驱动规则] 以下是本项目的成功/失败范例，请参考正例模式、避免反例模式：\n';
  if (good.length > 0) {
    ctx += '\n✅ 成功范例：\n';
    for (const e of good) { ctx += `  - ${e.content.slice(0, 300)}\n`; opts?.outIds?.push(e.id); }
  }
  if (bad.length > 0) {
    ctx += '\n❌ 失败范例（避免重复）：\n';
    for (const e of bad) { ctx += `  - ${e.content.slice(0, 300)}\n`; opts?.outIds?.push(e.id); }
  }
  ctx += '</exemplar-context>';
  return ctx;
}

/** 查找与给定任务最相似的历史任务（基于余弦相似度） */
export function findSimilarTasks(mgr: MemoryExemplarHost, projectId: string, taskId?: string, limit = 5): Array<{ id: string; title: string; status: string; similarity: number }> {
  try {
    // 获取目标任务的embedding
    let targetEmb: number[] | null = null;
    if (taskId) {
      const task = mgr.db.prepare("SELECT context_json FROM wa_tasks WHERE id = ?").get(taskId) as { context_json: string } | undefined;
      if (task) {
        try { targetEmb = JSON.parse(task.context_json || '{}').task_embedding as number[]; } catch { /* */ }
      }
    }

    // 获取所有有embedding的已完成任务
    const candidates = mgr.db.prepare(
      "SELECT id, title, status, context_json FROM wa_tasks WHERE project_id = ? AND status = 'completed' AND context_json LIKE '%task_embedding%' ORDER BY updated_at DESC LIMIT 100"
    ).all(projectId) as Array<{ id: string; title: string; status: string; context_json: string }>;

    if (candidates.length === 0) return [];

    const scored: Array<{ id: string; title: string; status: string; similarity: number }> = [];

    if (targetEmb) {
      // 有目标embedding：余弦相似度排序
      for (const c of candidates) {
        if (c.id === taskId) continue;
        try {
          const candEmb = JSON.parse(c.context_json || '{}').task_embedding as number[] | undefined;
          if (candEmb && candEmb.length > 0) {
            const sim = cosineSimilarity(targetEmb, candEmb);
            if (sim > 0.5) scored.push({ id: c.id, title: c.title, status: c.status, similarity: Math.round(sim * 100) });
          }
        } catch { /* skip */ }
      }
      scored.sort((a, b) => b.similarity - a.similarity);
    } else {
      // 无目标：返回最近完成的任务
      for (const c of candidates.slice(0, limit)) {
        scored.push({ id: c.id, title: c.title, status: c.status, similarity: 0 });
      }
    }

    return scored.slice(0, limit);
  } catch { return []; }
}

/**
 * A1 (2026-09-01): 相似历史任务经验提炼——供 buildMemoryContext 注入（让历史同类经验真正送达 Agent）
 * 毛选实践论「从实践中来」：召回 TopN 相似历史任务 → 各取 episodic/procedural 记忆 Top2 → 提炼经验文本。
 */
// zx_20260911_5 M4-3（纯省算，不改语义）: 允许调用方传入**已取**的相似任务列表，免同参重复检索（E9）。
export function getSimilarTaskExperience(mgr: MemoryExemplarHost, projectId: string, taskId: string, limit = 3, precomputed?: Array<{ id: string; title: string; status: string; similarity: number }>, opts?: { excluded?: ReadonlySet<string>; outIds?: string[] }): string {
  try {
    const similar = precomputed ?? findSimilarTasks(mgr, projectId, taskId, limit);
    if (similar.length === 0) return '';
    const lines = ['[历史同类经验] 以下为本项目相似历史任务的经验（供参考，勿机械套用）：'];
    for (const s of similar) {
      // zx_20260913 M4-3: 补 `id` 并于取回后过滤（与 `notExcluded` 同尺，不放宽检索面）；id 与文本同序供记账。
      const mems = mgr.db.prepare(
        "SELECT id, content, importance, memory_type, valence FROM wa_memories WHERE task_id = ? AND memory_type IN ('episodic','procedural') ORDER BY importance DESC LIMIT 2"
      ).all(s.id) as Array<{ id: string; content: string; importance: number; memory_type: string; valence: string }>;
      const fresh = opts?.excluded ? mems.filter((m) => !opts.excluded!.has(m.id)) : mems;
      if (fresh.length === 0) continue;
      lines.push(`- 相似任务「${s.title}」（状态: ${s.status}，相似度: ${s.similarity}）`);
      for (const m of fresh) {
        const tag = m.valence === 'positive' ? '成功' : m.valence === 'negative' ? '失败' : m.memory_type;
        lines.push(`  【${tag}】${m.content.slice(0, 200)}`);
        opts?.outIds?.push(m.id);
      }
    }
    // 全部子记忆都被排除时不留空标头（与 `## 空段` 约束同尺）
    return lines.length > 1 ? lines.join('\n') : '';
  } catch { return ''; }
}

/** 跨项目查找相似任务 */
export function findCrossProjectSimilarTasks(mgr: MemoryExemplarHost, projectId: string, taskId?: string, limit = 3): Array<{ id: string; title: string; projectName: string; similarity: number }> {
  try {
    let targetEmb: number[] | null = null;
    if (taskId) {
      const task = mgr.db.prepare("SELECT context_json FROM wa_tasks WHERE id = ?").get(taskId) as { context_json: string } | undefined;
      if (task) { try { targetEmb = JSON.parse(task.context_json || '{}').task_embedding as number[]; } catch { /* */ } }
    }
    if (!targetEmb) return [];

    const candidates = mgr.db.prepare(
      "SELECT t.id, t.title, p.name as project_name, t.context_json FROM wa_tasks t JOIN wa_projects p ON t.project_id = p.id WHERE t.project_id != ? AND t.status = 'completed' AND t.context_json LIKE '%task_embedding%' ORDER BY t.updated_at DESC LIMIT 200"
    ).all(projectId) as Array<{ id: string; title: string; project_name: string; context_json: string }>;

    const scored: Array<{ id: string; title: string; projectName: string; similarity: number }> = [];
    for (const c of candidates) {
      try {
        const candEmb = JSON.parse(c.context_json || '{}').task_embedding as number[] | undefined;
        if (candEmb && candEmb.length > 0) {
          const sim = cosineSimilarity(targetEmb, candEmb);
          if (sim > 0.7) scored.push({ id: c.id, title: c.title, projectName: c.project_name, similarity: Math.round(sim * 100) });
        }
      } catch { /* skip */ }
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    return scored.slice(0, limit);
  } catch { return []; }
}

/** Phase C (2026-08-26) 家族相似：跨项目知识迁移——把跨项目已验证的高价值语义/程序性知识注入当前任务。 */
export function getCrossProjectKnowledge(mgr: MemoryExemplarHost, projectId: string, taskId: string, topK = 3): Array<{ id: string; content: string; projectName: string; memoryType: string }> {
  try {
    const task = mgr.db.prepare("SELECT context_json FROM wa_tasks WHERE id = ?").get(taskId) as { context_json: string } | undefined;
    if (!task) return [];
    const targetEmb = JSON.parse(task.context_json || '{}').task_embedding as number[] | undefined;
    if (!targetEmb || targetEmb.length === 0) return [];

    const candidates = mgr.db.prepare(
      "SELECT t.id, t.title, t.project_id, p.name as project_name, t.context_json FROM wa_tasks t JOIN wa_projects p ON t.project_id = p.id WHERE t.project_id != ? AND t.status = 'completed' AND t.context_json LIKE '%task_embedding%' ORDER BY t.updated_at DESC LIMIT 200",
    ).all(projectId) as Array<{ id: string; title: string; project_id: string; project_name: string; context_json: string }>;

    const scored: Array<{ projectId: string; projectName: string; similarity: number }> = [];
    for (const c of candidates) {
      try {
        const candEmb = JSON.parse(c.context_json || '{}').task_embedding as number[] | undefined;
        if (candEmb && candEmb.length > 0) {
          const sim = cosineSimilarity(targetEmb, candEmb);
          if (sim > 0.7) scored.push({ projectId: c.project_id, projectName: c.project_name, similarity: sim });
        }
      } catch { /* skip */ }
    }
    scored.sort((a, b) => b.similarity - a.similarity);
    if (scored.length === 0) return [];

    const out: Array<{ id: string; content: string; projectName: string; memoryType: string }> = [];
    const seenProjects = new Set<string>();
    for (const s of scored.slice(0, 3)) {
      if (seenProjects.has(s.projectId)) continue;
      seenProjects.add(s.projectId);
      // zx_20260913 M4-3: 补 `id`——调用方据此跨 run 排除（与 `notExcluded` 同尺）并记账。
      const memories = mgr.db.prepare(
        "SELECT id, content, memory_type FROM wa_memories WHERE project_id = ? AND memory_type IN ('semantic','procedural') AND importance >= 0.7 ORDER BY importance DESC, updated_at DESC LIMIT 3",
      ).all(s.projectId) as Array<{ id: string; content: string; memory_type: string }>;
      for (const m of memories) {
        out.push({ id: m.id, content: m.content.slice(0, 200), projectName: s.projectName, memoryType: m.memory_type });
      }
      if (out.length >= topK + 3) break;
    }
    return out.slice(0, topK + 3);
  } catch { return []; }
}

/**
 * Jaccard相似度聚类：同一项目内语义相似的记忆自动关联。
 * 使用词袋模型（字符bigram），similarity > 0.6 时链接。
 */
export function clusterSimilarMemories(mgr: MemoryExemplarHost, projectId: string): { linked: number } {
  const memories = mgr.db.prepare(
    `SELECT id, content FROM wa_memories WHERE project_id = ? AND ${MEM_LIVE_SQL} ORDER BY updated_at DESC LIMIT 100`,
  ).all(projectId) as Array<{ id: string; content: string }>;
  if (memories.length < 2) return { linked: 0 };

  // 预处理：为每条记忆生成bigram集合
  const bigramSets = memories.map(m => {
    const clean = (m.content || '').replace(/[^一-鿿a-zA-Z0-9一-鿿]/g, '');
    const bigrams = new Set<string>();
    for (let i = 0; i < clean.length - 1; i++) {
      bigrams.add(clean.slice(i, i + 2));
    }
    return { id: m.id, bigrams };
  });

  let linked = 0;
  for (let i = 0; i < bigramSets.length; i++) {
    // 检查是否已有相似关联
    const existingSimilar = mgr.db.prepare(
      "SELECT similar_to FROM wa_memories WHERE id = ? AND similar_to != ''",
    ).get(bigramSets[i]!.id) as { similar_to: string } | undefined;
    if (existingSimilar) continue; // 已有关联，跳过

    for (let j = i + 1; j < bigramSets.length; j++) {
      const a = bigramSets[i]!;
      const b = bigramSets[j]!;
      // Jaccard: |A ∩ B| / |A ∪ B|
      const intersection = new Set([...a.bigrams].filter(x => b.bigrams.has(x)));
      const union = new Set([...a.bigrams, ...b.bigrams]);
      const similarity = union.size > 0 ? intersection.size / union.size : 0;

      if (similarity > 0.6) {
        // 双向关联
        const updateSimilar = (id: string, simId: string) => {
          const row = mgr.db.prepare('SELECT similar_to FROM wa_memories WHERE id = ?').get(id) as { similar_to: string } | undefined;
          const existing = (row?.similar_to || '') ? JSON.parse(row!.similar_to) as string[] : [];
          if (!existing.includes(simId)) {
            existing.push(simId);
            mgr.db.prepare('UPDATE wa_memories SET similar_to = ? WHERE id = ?').run(JSON.stringify(existing), id);
          }
        };
        updateSimilar(a.id, b.id);
        updateSimilar(b.id, a.id);
        linked++;
      }
    }
  }

  if (linked > 0) logger.info({ projectId, linked, total: memories.length }, '记忆相似聚类完成');
  return { linked };
}
