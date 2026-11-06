/**
 * zx_20261018_2 批七（见简 / 维特根斯坦·一个规则一处）: **检索簇**——自 `memory-manager.ts`
 * 机械搬迁而来的自由函数（来源符号：`searchConversations` / `searchBM25` / `searchByKeywords` /
 * `retrievalStrength` / `empiricalReliability` / `maturityOf` / `confidenceOf`，以及它们依赖的
 * `_processingDepthOf` / `_expandTerms` 与模块尾部的余弦相似度）。**逐字节行为不变**：SQL、阈值、
 * JSON 形状、算式一字未动。
 *
 * 函数取 `(mgr, …)`——`mgr` 只需满足下方最小宿主接口。`MemoryManager` 的同名方法现为**薄委托**，
 * 故全部既有调用点零改动。
 */
import type Database from 'better-sqlite3';
// 仅类型（打包期擦除）——不构成 `memory-manager.ts` 的运行期反向依赖。
import type { MemoryEntry } from './memory-manager.js';
import {
  ageDaysSince, memoryAgeDays,
  RETRIEVAL_TAU_DAYS, MATURITY_TAU_DAYS, CONFIDENCE_TAU_DAYS,
} from './memory-decay.js';
import { MEM_LIVE_SQL } from './memory-lifecycle.js';
import { readBoolSetting } from './settings-bool.js';
import { splitTaskLayers, mergeTaskLayers, applySchemaRecall, extractKeywords } from './memory-select.js';

/**
 * zx_20260930 M7-f 开关键：图式重构召回（巴特莱特）。缺省即开，关 ⇒ 回"纯逐字/语义"的旧口径，供 A/B。
 * 键名与库内 `ensureSetting` 同源（`database.ts`），并登记在 `settings-bool.ts` 的白名单里
 * （新增枚举/开关值须穷举全部读取谓词——本处只此一个读点，且判据由 `readBoolSetting` 单一真源给出）。
 */
const SCHEMA_RECALL_KEY = 'memory.schema_recall';

/** 检索簇所需的最小宿主面（`MemoryManager` 结构上满足）。 */
export interface MemoryRetrievalHost {
  readonly db: Database.Database;
  getProjectTerminology(projectId: string): Record<string, string>;
  retrievalStrength(mem: MemoryEntry): number;
  getRecent(projectId: string, limit?: number): MemoryEntry[];
  search(queryEmbedding: number[], projectId: string, topK?: number): MemoryEntry[];
  findCrossProjectSimilarTasks(projectId: string, taskId?: string, limit?: number): Array<{ id: string; title: string; projectName: string; similarity: number }>;
  listUnknowns(projectId: string, limit?: number): MemoryEntry[];
  listNegatives(projectId: string, limit?: number): MemoryEntry[];
}

/** Phase 7.7: FTS5 全文本搜索对话记录。 */
export function searchConversations(mgr: MemoryRetrievalHost, query: string, projectId?: string, limit = 10): Array<{ taskId: string; role: string; content: string }> {
  try {
    let rows: Array<{ task_id: string; role: string; content: string }>;
    if (projectId) {
      rows = mgr.db.prepare(`
        SELECT f.task_id, f.role, f.content FROM wa_conversations_fts f
        JOIN wa_tasks t ON f.task_id = t.id
        WHERE wa_conversations_fts MATCH ? AND t.project_id = ?
        ORDER BY rank LIMIT ?
      `).all(query, projectId, limit) as Array<{ task_id: string; role: string; content: string }>;
    } else {
      rows = mgr.db.prepare(`
        SELECT task_id, role, content FROM wa_conversations_fts
        WHERE wa_conversations_fts MATCH ?
        ORDER BY rank LIMIT ?
      `).all(query, limit) as Array<{ task_id: string; role: string; content: string }>;
    }
    return rows.map(r => ({ taskId: r.task_id, role: r.role, content: r.content.slice(0, 500) }));
  } catch {
    return [];
  }
}

/** BM25词法搜索（使用FTS5） */
export function searchBM25(mgr: MemoryRetrievalHost, query: string, projectId: string, topK = 10): MemoryEntry[] {
  try {
    const rows = mgr.db.prepare(`
      SELECT m.*, rank FROM wa_memories_fts f
      JOIN wa_memories m ON f.rowid = m.rowid
      WHERE wa_memories_fts MATCH ? AND m.project_id = ? AND m.${MEM_LIVE_SQL}
      ORDER BY rank LIMIT ?
    `).all(query, projectId, topK) as Array<MemoryEntry & { rank: number }>;
    return rows;
  } catch {
    // FTS5不可用时回退到LIKE搜索
    return searchByKeywords(mgr, query.split(/\s+/), projectId, topK);
  }
}

/** 文本检索（无embedding时的回退方案） */
export function searchByKeywords(mgr: MemoryRetrievalHost, keywords: string[], projectId: string, topK = 5): MemoryEntry[] {
  // Phase D: 术语表双向扩展，消除缩写/全称多义漏检
  const kwList = expandTerms(mgr.getProjectTerminology(projectId), keywords);
  const conditions = kwList.map(() => 'content LIKE ?');
  const params = kwList.map(k => `%${k}%`);
  return mgr.db.prepare(
    `SELECT * FROM wa_memories WHERE project_id = ? AND ${MEM_LIVE_SQL} AND (${conditions.join(' OR ')}) ORDER BY created_at DESC LIMIT ?`,
  ).all(projectId, ...params, topK) as MemoryEntry[];
}

/** Phase D: 术语表双向扩展（缩写→全称、全称→缩写），用于检索查询消歧。 */
export function expandTerms(terms: Record<string, string>, keywords: string[]): string[] {
  if (Object.keys(terms).length === 0) return keywords;
  const expanded = new Set<string>(keywords);
  for (const k of keywords) {
    const lower = k.toLowerCase();
    for (const [abbr, full] of Object.entries(terms)) {
      if (abbr.toLowerCase() === lower) expanded.add(full);
      else if (full.toLowerCase() === lower) expanded.add(abbr);
    }
  }
  return [...expanded];
}

/** Phase A (2026-08-27 zx_2) 格物致知：读记忆的加工深度（深=提炼规律/语义关联，浅=机械记录事实）。 */
export function processingDepthOf(mem: MemoryEntry): 'deep' | 'shallow' | null {
  try {
    const ctx = JSON.parse(mem.context_json || '{}') as { processing_depth?: unknown };
    return ctx.processing_depth === 'deep' || ctx.processing_depth === 'shallow' ? ctx.processing_depth : null;
  } catch { return null; }
}

/**
 * Phase 1.3 意义即使用：派生"提取强度"（retrieval strength）。
 * 由 use_count（对数压缩，饱和于 ~20 次）+ last_used_at 近因（时间常数 τ=14 天）合成，不新增列。
 * 与 importance（存储强度）区分：存储强度衡量长期价值，提取强度衡量当前可及性。
 *
 * zx_20260930 M6：τ 与时间尺取自 `memory-decay.ts` 一处真源。本条**刻意读 `last_used_at`**（与
 *   衰减/置信用的 `memoryAgeDays` 不同列）：提取强度问的是"最近**被取用**"（可及性），若混入
 *   `created_at`，"刚落库但从未被用过"会被判成"很可及"——那是把提取强度偷换成存储强度。
 *   `updated_at` 同样不读（系统改写不是使用）。旧注释写"半衰期14天"是**名实不符**（τ=14 的有效半衰期
 *   是 τ·ln2≈9.7 天）；本轮只把名字与出处归正，**值一字不动**。
 */
export function retrievalStrength(mem: MemoryEntry): number {
  const use = mem.use_count ?? 0;
  const useScore = Math.log2(1 + use) / Math.log2(21); // use_count=0→0, =20→~1
  const recency = mem.last_used_at ? Math.exp(-ageDaysSince(mem.last_used_at) / RETRIEVAL_TAU_DAYS) : 0;
  return 0.6 * useScore + 0.4 * recency;
}

/**
 * Phase 2.2 自知者明：经验可靠性（元记忆）。
 * 由实践成败计数派生，拉普拉斯平滑：(成功+1)/(成功+失败+2)，0 次实践 = 0.5 中性。
 */
export function empiricalReliability(mem: MemoryEntry): number {
  const s = mem.success_count ?? 0;
  const f = mem.failure_count ?? 0;
  return (s + 1) / (s + f + 2);
}

/**
 * Phase A (2026-08-26) 大器晚成：知识成熟度。
 * 由验证深度（success_count 对数压缩）+ 龄期（created_at 距今天数，半成熟约 21 天）合成，
 * 衡量知识从「易变」到「稳定」的成熟阶段（不新增列，复用 success_count + created_at）。
 */
export function maturityOf(mem: MemoryEntry): number {
  const s = mem.success_count ?? 0;
  const depth = Math.min(1, Math.log2(1 + s) / Math.log2(11)); // 0次→0, 10次→1 饱和
  // zx_20260930 M6: 尺与尺度常数取自 `memory-decay.ts` 一处真源（原来是裸字面量 21）。
  //   本条**刻意读 `created_at`**（而非 `memoryAgeDays`）：成熟度问的是"这条知识**存在**了多久"，
  //   是**同尺不同列**，不是第三把尺——若改读 `memoryAgeDays`，"一条老知识今天被用了一下"
  //   会把它打回"未成熟"，那是把成熟度偷换成新鲜度。
  const age = 1 - Math.exp(-ageDaysSince(mem.created_at) / MATURITY_TAU_DAYS); // 0天→0, 21天→0.63, 90天→0.99
  let m = depth * age;
  // Phase A (2026-08-27 zx_2) 格物致知：深加工记忆成熟加速（×1.5，上限 1）
  if (processingDepthOf(mem) === 'deep') m = Math.min(1, m * 1.5);
  return m;
}

/**
 * Phase 2.1 实事求是：派生记忆可信度（confidence）。
 * 由来源可靠性（source 基础分）+ 验证（被使用过/被实践反馈强化过）+ 质疑惩罚（context_json.confidence_penalty）
 * + 经验可靠性（Phase 2.2 成败计数）合成。
 */
export function confidenceOf(mem: MemoryEntry): number {
  const sourceBase: Record<string, number> = {
    user_instruction: 0.9, user_correction: 0.95, user_manual: 0.9, user_onboarding: 0.8,
    agent_execution: 0.6, background_review: 0.55, task_execution: 0.5,
    pattern_extraction: 0.4, auto_extract: 0.45,
  };
  let conf = sourceBase[mem.source ?? 'agent_execution'] ?? 0.5;
  if ((mem.use_count ?? 0) > 0) conf = Math.min(1, conf + 0.1);
  if (mem.last_reinforced_at) conf = Math.min(1, conf + 0.1);
  try {
    const ctx = JSON.parse(mem.context_json || '{}');
    if (typeof ctx.confidence_penalty === 'number') conf *= ctx.confidence_penalty;
    // Phase C 证据锚点：有 verified 证据加分；agent 自产记忆无证据降权（私人语言论证——须公共可验证）
    const evidence = ctx.evidence as { verified?: boolean } | undefined;
    if (evidence?.verified) conf = Math.min(1, conf + 0.1);
    else if ((mem.source ?? 'agent_execution') === 'agent_execution' && !evidence) conf *= 0.8;
    // Phase B 源监控：亲历(direct)/推断(inferred)弱信号校准（实践论：直接经验优先，与证据强信号叠加不冲突）
    const experience = ctx.experience as 'direct' | 'inferred' | undefined;
    if (experience === 'direct') conf = Math.min(1, conf + 0.05);
    else if (experience === 'inferred') conf = Math.max(0, conf - 0.05);
    // Phase B (2026-08-26) 记忆事实保鲜：被实践反驳(导致失败)→ 强降权（实事求是：事实变认识也要变）
    if (ctx.staleness) conf *= 0.7;
    // Phase A (2026-08-27) 空性·无常：易变细节(volatile)可信度更谨慎降权
    if (ctx.applicability?.stability === 'volatile') conf *= 0.9;
    // Phase A (2026-08-27 zx_2) 格物致知：深加工记忆可信度更高
    if (ctx.processing_depth === 'deep') conf = Math.min(1, conf + 0.05);
  } catch { /* 忽略非法 context_json */ }
  // D1 (2026-08-31): 遗忘曲线（人类记忆遗忘曲线艾宾浩斯——时间连续衰减；use_count>0 使用对抗遗忘；间隔重复强化 last_reinforced_at 也重置遗忘）
  // zx_20260930 M6: 龄期改取 `memoryAgeDays(mem)`——它**只认三个语义时间戳**
  //   （`last_used_at` / `last_reinforced_at` / `created_at` 取最大），`updated_at` 永不参与。
  //   旧写法（`max(lastUse,lastReinforce) || created_at`）与 `memoryAgeDays` 对**一切真实数据**同值：
  //   `created_at` 只可能早于那两个（先落库、后被用），故取最大时它是被支配项；若两个都缺，两边都落回
  //   `created_at`。差别只在"取不到时刻"那一支：旧写法给 `0`（=刚被用过，最不易衰减），新尺给 0 天
  //   （同为不衰减）——结论一致，且新尺的"取不到"语义写在 `memory-decay.ts` 一处，不再各写各的。
  //   尺度常数 τ=30 亦取自该处（旧注释写"半衰期30天"是名实不符：τ=30 的有效半衰期是 τ·ln2≈20.8 天）。
  const useFactor = (mem.use_count ?? 0) > 0 ? 1.5 : 1.0;
  conf *= Math.exp(-memoryAgeDays(mem) / (CONFIDENCE_TAU_DAYS * useFactor));
  // Phase 2.2: 融入经验可靠性（0.4 经验 + 0.6 先验）
  conf = conf * (0.6 + 0.4 * empiricalReliability(mem));
  // Phase A (2026-08-26) 大器晚成：知识成熟度微调——未成熟降微权，成熟升微权
  const maturity = maturityOf(mem);
  if (maturity < 0.25) conf = Math.max(0, conf - 0.05);
  else if (maturity >= 0.6) conf = Math.min(1, conf + 0.05);
  return Math.max(0, Math.min(1, conf));
}

/** 余弦相似度（原 `memory-manager.ts` 模块尾部同名函数，算式一字未动；两处搬迁簇共用）。 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! ** 2;
    normB += b[i]! ** 2;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ==================== 检索排序辅助（逐字节自 `memory-manager.ts` 私有方法搬迁） ====================

/** Phase 3.2: 读记忆的编码语境 archetype */
export function encodingArchetype(mem: MemoryEntry): string | null {
  try {
    const ctx = JSON.parse(mem.context_json || '{}');
    const arch = (ctx as { encoding_context?: { archetype?: unknown } }).encoding_context?.archetype;
    return typeof arch === 'string' ? arch : null;
  } catch { return null; }
}

/** Phase 3.2: 读记忆的编码语境关键词（存储时从任务标题/描述提取）。 */
export function encodingKeywords(mem: MemoryEntry): string[] {
  try {
    const ctx = JSON.parse(mem.context_json || '{}') as { encoding_context?: { keywords?: unknown } };
    const kws = ctx.encoding_context?.keywords;
    return Array.isArray(kws) ? (kws as string[]) : [];
  } catch { return []; }
}

/** Phase B: 读记忆的亲历/推断标记（源监控）。 */
export function experienceOf(mem: MemoryEntry): 'direct' | 'inferred' | null {
  try {
    const ctx = JSON.parse(mem.context_json || '{}') as { experience?: unknown };
    return ctx.experience === 'direct' || ctx.experience === 'inferred' ? ctx.experience : null;
  } catch { return null; }
}

/** Phase B: 直接经验优先的检索排序微调（实践论：亲历优先）。 */
export function experienceBoost(mem: MemoryEntry): number {
  return experienceOf(mem) === 'direct' ? 0.03 : 0;
}

/** Phase A: 成熟知识检索排序微调（大器晚成：成熟记忆略优先）。 */
export function maturityBoost(mem: MemoryEntry): number {
  return maturityOf(mem) * 0.02;
}

/** Phase A (2026-08-27 zx_2) 格物致知：深加工记忆检索排序微调（深加工可迁移性优先）。 */
export function processingDepthBoost(mem: MemoryEntry): number {
  return processingDepthOf(mem) === 'deep' ? 0.03 : 0;
}

/** A4: 复用价值标记检索加权——context_json.reusable_experience=1 的记忆（含可行动建议的复盘）更易命中 */
export function reusableBoost(mem: MemoryEntry): number {
  try {
    const ctx = JSON.parse(mem.context_json || '{}') as { reusable_experience?: number };
    return ctx.reusable_experience === 1 ? 0.08 : 0;
  } catch { return 0; }
}

/** Phase A (2026-08-27) 空性·缘起：读记忆的适用条件 + 稳定性分级。 */
export function applicabilityOf(mem: MemoryEntry): { conditions: string[]; stability: 'stable' | 'volatile' } | null {
  try {
    const ctx = JSON.parse(mem.context_json || '{}') as { applicability?: { conditions?: unknown; stability?: unknown } };
    const a = ctx.applicability;
    if (!a) return null;
    return {
      conditions: Array.isArray(a.conditions) ? (a.conditions as string[]).filter((c): c is string => typeof c === 'string') : [],
      stability: a.stability === 'volatile' ? 'volatile' : 'stable',
    };
  } catch { return null; }
}

/** Phase A (2026-08-27) 空性·无常：易变细节(volatile)排序微降（细节易变不如恒常规律可靠）。 */
export function applicabilityPenalty(mem: MemoryEntry): number {
  return applicabilityOf(mem)?.stability === 'volatile' ? 0.95 : 1;
}

/** A3 (2026-09-02): 记忆干扰管理——冲突/已取代标记降权（前摄/倒摄干扰）。
 * context_json.conflict_flag=true 或 superseded=true 的记忆（待辩证扬弃 / 已被更新的同类经验取代）在检索中降权，
 * 避免把已被矛盾经验或更新的旧信息当权威注入 Agent，直到 dialecticalSublateMemories 将旧记忆扬弃为综合（清除标记）或归档。
 */
export function conflictPenalty(mem: MemoryEntry): number {
  try {
    const ctx = JSON.parse(mem.context_json || '{}') as { conflict_flag?: boolean; superseded?: boolean };
    return ctx.conflict_flag === true || ctx.superseded === true ? 0.6 : 1;
  } catch { return 1; }
}

/**
 * Phase A (2026-08-27) 空性·缘起：判断记忆的适用条件是否与当前任务上下文不符。
 * 条件非空且任务文本不含任何条件的任一关键词 → 条件可能已变/不满足。
 * 保守：仅用于降权标注提醒，不硬删记忆。
 */
export function applicabilityMismatch(mem: MemoryEntry, taskText: string): boolean {
  const a = applicabilityOf(mem);
  if (!a || a.conditions.length === 0) return false;
  const taskTokens = new Set(extractKeywords(taskText || '').map(t => t.toLowerCase()));
  for (const cond of a.conditions) {
    const kws = extractKeywords(cond);
    if (kws.length === 0) continue;
    if (kws.some(k => taskTokens.has(k.toLowerCase()))) return false; // 命中任一条件关键词 → 条件可能满足
  }
  return true; // 所有条件关键词都不在任务文本中 → 条件可能已变
}

/** Phase D: 松弛关键词（更少停用词，召回更多线索）。 */
export function relaxedKeywords(text: string): string[] {
  const stop = new Set(['的', '了', '在', '是', '和', '与', '及', '或', 'to', 'the', 'for', 'and', 'of', 'a', 'an']);
  const words = text.split(/[\s,，。、；：！？\n()（）:：/\[\]【】]+/).filter(w => w.length > 1 && !stop.has(w.toLowerCase()));
  return [...new Set(words)].slice(0, 15);
}

/** A2 (2026-09-02): 提取实践效应（retrieval practice / testing effect，Karpicke & Roediger 2008）。
 * 相似任务开始前主动"回忆"相关记忆，并用当前任务文本做适用性检验：适用（applicabilityMismatch=false）
 * 的记忆以高于被动再暴露（recordAccess use_count+1）的强度加固（use_count+3，log2 压缩下模拟多次主动回忆，
 * 使"值得复用且当前适用"的记忆更易在后续检索/相似任务识别中胜出）；条件不匹配的记忆不加成（避免误强化过时记忆）。
 * 区别于 spacedRepetition（被动重读）与 recordAccess（被动访问）——这是主动回忆测试。
 * 纯同步、无 LLM 依赖（关键词召回），返回被加固的记忆条数；best-effort 静默。
 */
export function retrievalPractice(mgr: MemoryRetrievalHost, taskText: string, projectId: string, topK = 5): number {
  try {
    const text = (taskText || '').trim();
    if (text.length < 2) return 0;
    const keywords = extractKeywords(text).slice(0, 8);
    if (keywords.length === 0) return 0;
    const candidates = searchByKeywords(mgr, keywords, projectId, topK * 3);
    if (candidates.length === 0) return 0;
    let practiced = 0;
    for (const mem of candidates) {
      if (practiced >= topK) break;
      if (applicabilityMismatch(mem, text)) continue; // 适用性检验不过 → 不加固
      mgr.db.prepare("UPDATE wa_memories SET use_count = use_count + 3, last_used_at = datetime('now') WHERE id = ?").run(mem.id);
      practiced++;
    }
    return practiced;
  } catch { return 0; }
}

/**
 * 混合检索：BM25词法 + 向量语义 + RRF融合。
 * 结合精确关键词匹配和语义理解，比单一方法命中率高。
 */
export function searchHybrid(mgr: MemoryRetrievalHost, queryText: string, queryEmbedding: number[] | null, projectId: string, topK = 5): MemoryEntry[] {
  const bm25Results = searchBM25(mgr, queryText, projectId, 20);
  const vecResults = queryEmbedding ? mgr.search(queryEmbedding, projectId, 20) : [];

  // Reciprocal Rank Fusion (k=60)
  const rrfScores = new Map<string, number>();
  const entries = new Map<string, MemoryEntry>();

  for (const [rank, item] of bm25Results.entries()) {
    rrfScores.set(item.id, 1 / (60 + rank));
    entries.set(item.id, item);
  }
  for (const [rank, item] of vecResults.entries()) {
    const current = rrfScores.get(item.id) ?? 0;
    rrfScores.set(item.id, current + 1 / (60 + rank));
    if (!entries.has(item.id)) entries.set(item.id, item);
  }

  // 按RRF分数降序排序
  const sorted = Array.from(rrfScores.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, topK);

  return sorted.map(([id]) => entries.get(id)!).filter(Boolean);
}

export function retrieveLayered(mgr: MemoryRetrievalHost, queryText: string, queryEmbedding: number[] | null, projectId: string, topK = 5, opts?: { longTermK?: number }): {
  shortTerm: MemoryEntry[];
  midTerm: MemoryEntry[];
  longTerm: MemoryEntry[];
} {
  const shortTerm = mgr.getRecent(projectId, 5);
  const shortIds = new Set(shortTerm.map(m => m.id));

  const midTerm = mgr.db.prepare(
    // zx_20260930 M8: 中层（重要性召回）此前**没有任何类型过滤** ⇒ 墓碑会被当作"重要记忆"抽出来。
    `SELECT * FROM wa_memories WHERE project_id = ? AND importance >= 0.7 AND ${MEM_LIVE_SQL} AND id NOT IN (` +
    shortTerm.map(() => '?').join(',') + ") ORDER BY importance DESC, created_at DESC LIMIT ?",
  ).all(projectId, ...Array.from(shortIds), topK) as MemoryEntry[];

  const midIds = new Set(midTerm.map(m => m.id));
  const allExclude = new Set([...shortIds, ...midIds]);

  const longK = Math.max(topK, opts?.longTermK ?? topK);
  let longTerm: MemoryEntry[] = [];
  if (queryEmbedding) {
    longTerm = mgr.search(queryEmbedding, projectId, longK + 10)
      .filter(m => !allExclude.has(m.id))
      .slice(0, longK);
  }

  // 纯检索无副作用：访问记录由调用方在"实际注入"时统一 recordAccess，
  // 避免"检索到但未注入"的记忆被错误计入使用次数（使用强度应反映真实使用）。
  return { shortTerm, midTerm, longTerm };
}

/**
 * Phase 1.1 补充：任务相关记忆检索（三层检索的长期层落地）。
 * 用当前任务的 title+description 作为查询、复用任务启动时已生成的 task_embedding，
 * 召回与当前任务语义相关的历史记忆，弥补类型检索"只看 importance、不看任务相关性"的缺陷。
 *
 * zx_20260930 M7-d（Tulving《情景记忆的要素》）: **检索层分层**。此前这里只取 `longTerm`——
 *   那是 `search()` 一个混合分排出的 top-K，情景记忆与语义记忆在同池同分里争名额，
 *   语义分高的那层把情景层整体挤出去。现改为：先把长期层候选池**放宽**（`longTermK = max(4·topK, 20)`），
 *   再按 Tulving 二分**各排各的**（情景=近因、语义=0.4·重要度+0.6·提取强度），最后**轮转交织**取 `topK`。
 *   候选池的**排除语义一字未动**（仍排除最近 5 条与高重要度中期层）——本处只加"分层"这一跳。
 *
 * zx_20260930 M7-f（巴特莱特·图式重构召回）: 末跳再加**一次按当下需求的重建**——`schemaText`
 *   （由调用方从"任务立志 + 主要矛盾"拼出，**不是**题面本身）作为图式，对交织结果重排。
 *   为什么必须**从外部传图式**而非就地拿 `title+description`：题面正是本函数上游 `queryText` 的取数源
 *   ——拿它当图式，等于用**同一把逐字尺**再量一遍，那是自我印证而非重建。
 *   开关 `memory.schema_recall`（缺省即开）关掉即回旧口径，供 A/B；`schemaText` 缺省（`''`）时
 *   `applySchemaRecall` 判不出图式 ⇒ 原序返回 ⇒ **既有调用点（不传第四参）行为一字不变**。
 *   成员集不动（只重排，见 `memory-select.ts` 该函数注释）——本处不新增任何丢点。
 */
/**
 * 本次"任务相关检索"实际走的取数路（zx_20261018_3 批一）。
 * `embedding`＝任务向量语义检索；`cue`＝无向量时的线索检索回退；`none`＝两条都没取到。
 */
export type TaskRelevantSource = 'embedding' | 'cue' | 'none';

/**
 * zx_20261018_3 批一（维特根斯坦·意义即用法）: 无 embedding 不再**静默返回空**。
 *
 * 病根：取不到 `task_embedding` 就 `return []` ⇒ embedding 模型未配置/调用失败时，"记忆检索"
 *   整条路无声熄火，调用方分不清"没有相关记忆"与"根本没查"。
 * 治法：无向量 ⇒ 走**已有的** `retrieveByCue`（关键词 + 项目术语 + 编码语境，不新增第二套打分），
 *   并如实回报来源；线索也取不到时返回空集（**如实为空**，不编造）。
 */
export function retrieveTaskRelevantWithSource(
  mgr: MemoryRetrievalHost, taskId: string, projectId: string, topK = 5, schemaText = '',
): { memories: MemoryEntry[]; source: TaskRelevantSource } {
  try {
    const task = mgr.db.prepare('SELECT title, description, context_json FROM wa_tasks WHERE id = ?').get(taskId) as { title: string; description: string; context_json: string } | undefined;
    if (!task) return { memories: [], source: 'none' };
    const queryText = `${task.title}. ${(task.description || '').slice(0, 500)}`;
    let queryEmb: number[] | null = null;
    try { queryEmb = JSON.parse(task.context_json || '{}').task_embedding as number[] | null; } catch { queryEmb = null; }
    if (!queryEmb || queryEmb.length === 0) {
      const cue = retrieveByCue(mgr, queryText, projectId, topK);
      return { memories: cue, source: cue.length > 0 ? 'cue' : 'none' };
    }
    const pool = retrieveLayered(mgr, queryText, queryEmb, projectId, topK, { longTermK: Math.max(topK * 4, 20) }).longTerm;
    const { episodic, semantic } = splitTaskLayers(pool, (m) => mgr.retrievalStrength(m), Date.now());
    const merged = mergeTaskLayers(episodic, semantic, topK);
    const memories = (!schemaText || !readBoolSetting(mgr.db, SCHEMA_RECALL_KEY))
      ? merged
      : applySchemaRecall(merged, schemaText, { keywordsOf: extractKeywords });
    return { memories, source: 'embedding' };
  } catch { return { memories: [], source: 'none' }; }
}

export function retrieveTaskRelevant(mgr: MemoryRetrievalHost, taskId: string, projectId: string, topK = 5, schemaText = ''): MemoryEntry[] {
  return retrieveTaskRelevantWithSource(mgr, taskId, projectId, topK, schemaText).memories;
}

export function retrieveByCue(mgr: MemoryRetrievalHost, taskText: string, projectId: string, topK = 5): MemoryEntry[] {
  try {
    const rows = mgr.db.prepare(
      `SELECT * FROM wa_memories WHERE project_id = ? AND ${MEM_LIVE_SQL} AND memory_type != 'prospective' ORDER BY updated_at DESC LIMIT 200`,
    ).all(projectId) as MemoryEntry[];
    const cueKws = expandTerms(mgr.getProjectTerminology(projectId), extractKeywords(taskText)); // Phase D: 术语扩展
    const score = (m: MemoryEntry) => {
      const content = (m.content || '').toLowerCase();
      const encKws = encodingKeywords(m);
      let cue = 0;
      if (cueKws.length > 0) {
        // 内容关键词命中
        const contentHits = cueKws.filter(k => content.includes(k.toLowerCase())).length;
        const contentCue = contentHits / cueKws.length;
        // 编码语境关键词命中（存储时记录，权重更高——编码特异性）
        let encodingCue = 0;
        if (encKws.length > 0) {
          const encHits = cueKws.filter(k => encKws.some(ek => ek.toLowerCase() === k.toLowerCase())).length;
          encodingCue = encHits / cueKws.length;
        }
        cue = Math.max(contentCue, encodingCue * 1.5);
      }
      const archetype = encodingArchetype(m);
      const archBoost = archetype ? 0.05 : 0;
      // zx_20260929 M4: 补 `_applicabilityPenalty`（与 `retrieveByType` 同尺）——多线索检索是"任务开场找线索"的
      //   主要入口之一，此前它连冲突降权都乘了、唯独漏了易变降权，是本轮四条路径里最后一条不一致的。
      return (0.55 * cue + 0.25 * mgr.retrievalStrength(m) + 0.15 * m.importance + 0.05 * Math.min(1, (m.use_count ?? 0) / 10) + archBoost + experienceBoost(m) + maturityBoost(m))
        * applicabilityPenalty(m) * conflictPenalty(m);
    };
    return rows.sort((a, b) => score(b) - score(a)).slice(0, topK);
  } catch { return []; }
}

/** 读项目术语表（language_game.terminology，缩写↔全称映射）。 */
export function getProjectTerminology(mgr: MemoryRetrievalHost, projectId: string): Record<string, string> {
  try {
    const proj = mgr.db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as { context_json: string } | undefined;
    if (!proj) return {};
    const ctx = JSON.parse(proj.context_json || '{}') as { language_game?: { terminology?: unknown } };
    const terms = ctx.language_game?.terminology;
    return (terms && typeof terms === 'object') ? (terms as Record<string, string>) : {};
  } catch { return {}; }
}

/** 获取项目最近记忆（zx_20260911_4 M5-1: 归档墓碑不计入"最近"——存→取往返须排除已归档） */
export function getRecent(mgr: MemoryRetrievalHost, projectId: string, limit = 20): MemoryEntry[] {
  return mgr.db.prepare(
    `SELECT * FROM wa_memories WHERE project_id = ? AND ${MEM_LIVE_SQL} ORDER BY created_at DESC LIMIT ?`,
  ).all(projectId, limit) as MemoryEntry[];
}

/** 9.5c: 获取项目级语义记忆（跨任务知识）。排序融合提取强度（意义即使用）。 */
export function getProjectKnowledge(mgr: MemoryRetrievalHost, projectId: string, limit = 5): Array<MemoryEntry & { reasoning: string; source: string }> {
  try {
    const rows = mgr.db.prepare(
      "SELECT * FROM wa_memories WHERE project_id = ? AND memory_type = 'semantic' AND importance >= 0.3 ORDER BY importance DESC, updated_at DESC LIMIT ?",
    ).all(projectId, limit * 4) as Array<MemoryEntry & { reasoning: string; source: string }>;
    // zx_20260929 M4: 基础式与 `retrieveByType` **同形**（0.4·存储强度 + 0.6·提取强度）⇒ 惩罚因子也必须同一套，
    //   否则同一条易变/冲突的知识，在「项目知识」段里按原值出现、在「按类型检索」段里却被降了权——
    //   两段写进同一个上下文，模型看到的是同一件东西的两个价（《管子》度量衡：一把尺，不是两把）。
    //   故此处**两个乘子都补**（`_applicabilityPenalty` + `_conflictPenalty`），与 `retrieveByType` 看齐。
    const score = (r: MemoryEntry) => (0.4 * r.importance + 0.6 * mgr.retrievalStrength(r))
      * applicabilityPenalty(r) * conflictPenalty(r);
    rows.sort((a, b) => score(b) - score(a));
    return rows.slice(0, limit);
  } catch { return []; }
}

/** 获取未嵌入的记忆（供批处理） */
export function getUnembedded(mgr: MemoryRetrievalHost, limit = 10): MemoryEntry[] {
  return mgr.db.prepare(
    // zx_20260930 M8: 补 embedding 的选行也须排除墓碑——墓碑的 embedding **就是 NULL**，
    //   不加这一句就会被捞出来算一次向量并写回（写给一条已删记忆）。检索面读不到它，
    //   但"机器在给一条墓碑做功课"本身即名实不符。
    `SELECT * FROM wa_memories WHERE (embedding IS NULL OR embedding = '') AND ${MEM_LIVE_SQL} ORDER BY created_at ASC LIMIT ?`,
  ).all(limit) as MemoryEntry[];
}

/** 检索当前任务是否命中未知空间（关键词命中）。 */
export function retrieveUnknownHits(mgr: MemoryRetrievalHost, taskText: string, projectId: string, topK = 3): MemoryEntry[] {
  try {
    const unknowns = mgr.listUnknowns(projectId, 30);
    const kws = extractKeywords(taskText);
    if (kws.length === 0) return [];
    const score = (m: MemoryEntry) => {
      const content = (m.content || '').toLowerCase();
      return kws.filter(k => content.includes(k.toLowerCase())).length / kws.length;
    };
    return unknowns.filter(m => score(m) > 0).sort((a, b) => score(b) - score(a)).slice(0, topK);
  } catch { return []; }
}

/** 检索当前任务是否命中已知负空间（关键词命中）。 */
export function retrieveNegativeHits(mgr: MemoryRetrievalHost, taskText: string, projectId: string, topK = 3): MemoryEntry[] {
  try {
    const negatives = mgr.listNegatives(projectId, 30);
    const kws = extractKeywords(taskText);
    if (kws.length === 0) return [];
    const score = (m: MemoryEntry) => {
      const content = (m.content || '').toLowerCase();
      return kws.filter(k => content.includes(k.toLowerCase())).length / kws.length;
    };
    return negatives.filter(m => score(m) > 0).sort((a, b) => score(b) - score(a)).slice(0, topK);
  } catch { return []; }
}

export function deepRetrieve(mgr: MemoryRetrievalHost, taskText: string, projectId: string, taskId?: string, topK = 5): Array<{ content: string; source: string }> {
  const out: Array<{ content: string; source: string }> = [];
  const seen = new Set<string>();

  // 1. 原始对话 FTS 回溯（舌尖现象：记得做过但不记得细节）
  try {
    const convs = searchConversations(mgr, taskText, projectId, 5);
    for (const c of convs) {
      const key = `conv:${c.taskId}:${c.content.slice(0, 40)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ content: `[对话回溯·${c.role}] ${c.content.slice(0, 200)}`, source: 'conversation' });
    }
  } catch { /* ignore */ }

  // 2. 松弛关键词检索（更少停用词 + 术语扩展）
  try {
    const kws = expandTerms(mgr.getProjectTerminology(projectId), relaxedKeywords(taskText));
    if (kws.length > 0) {
      const mems = searchByKeywords(mgr, kws, projectId, topK);
      for (const m of mems) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        out.push({ content: m.content.slice(0, 200), source: 'memory' });
      }
    }
  } catch { /* ignore */ }

  // 3. 跨项目相似任务标题线索
  if (taskId) {
    try {
      const cross = mgr.findCrossProjectSimilarTasks(projectId, taskId, 3);
      for (const t of cross) {
        const key = `cross:${t.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ content: `[跨项目 ${t.similarity}%] ${t.title}（${t.projectName}）`, source: 'cross-project-task' });
      }
    } catch { /* ignore */ }
  }

  return out.slice(0, topK + 3);
}
