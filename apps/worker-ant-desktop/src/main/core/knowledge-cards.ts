/**
 * zx_20261023_5 批二「省」（维特根斯坦·意义即使用 / 道德经·少则得）: **项目知识蒸馏卡**。
 *
 * 病根：知识册按"节"整块注入，任务类型不同却吃同一份 400-token 预算；一段长节里真正用得上的
 *   往往只有一两行。这一层把既有事实（九节册 + 三类记忆 + 已归档产出物标题）**确定性**压成
 *   一张张小卡（每张 ≤60 token），注入时按任务形态/关键词只挑 ≤5 张（≤150 token）。
 *
 * 纪律（与 `project-knowledge.ts` 同族）：
 *   · **零 LLM、可复现**：同输入必得同 id / 同文本 / 同顺序（`extractKeywords` 与 token 估都取既有真源）。
 *   · **不称"小模型"**：对外叫"项目知识卡 / 蒸馏卡"——它是确定性抽取，不是训练产物。
 *   · **总预算不增**：画像 200 + 卡 ≤150 + 知识册余量，合计仍 ≤ `KNOWLEDGE_INJECT_MAX_TOKENS`。
 *   · **失败教训只生成不自动生效**：验收失败落 `status='pending'` 的 pitfall 卡，下一次蒸馏才并入 active
 *     （避免"自己教自己"——本次失败的原因还没被任何后续证据检验过）。
 *
 * 读口：`MemoryManager.listKnowledgeCards`（此处先过 Pro 闸，再给 `selectKnowledgeCardsForInject` 挑）。
 */

import { estimateTokensFromChars, TOKEN_CHARS_PER_UNIT } from './token-estimate.js';
import { listProjectKnowledge } from './project-knowledge.js';
import { MEM_LIVE_SQL } from './memory-lifecycle.js';
import { extractKeywords } from './memory-select.js';
import { proFeatureRefusal } from './pro-gate.js';

/** 五类卡——**唯一定处**（新增一类须穷举选择表、来源映射与界面文案）。 */
export const KNOWLEDGE_CARD_KINDS = ['term', 'acceptance', 'recipe', 'lesson', 'pitfall'] as const;
export type KnowledgeCardKind = (typeof KNOWLEDGE_CARD_KINDS)[number];

export const KNOWLEDGE_CARD_KIND_LABEL: Record<KnowledgeCardKind, string> = {
  term: '术语',
  acceptance: '验收',
  recipe: '配方',
  lesson: '教训',
  pitfall: '坑',
};

/** 单卡 ≤60 token；每项目 ≤24 张；单次注入 ≤5 张、≤150 token（与总预算 400 同源）。 */
export const CARD_MAX_TOKENS = 60;
export const CARD_MAX_PER_PROJECT = 24;
export const CARD_INJECT_MAX_TOKENS = 150;
export const CARD_INJECT_MAX_ITEMS = 5;

/** 蒸馏卡是 Pro 能力（词表在 `pro-gate.ts`；此处只按名字引用，不另立档位判断）。 */
export const KNOWLEDGE_CARD_FEATURE = 'knowledge_cards' as const;

/** 只读库面（与 `project-knowledge.ts` 的 `ReadDb` 同形）。 */
type ReadDb = { prepare(sql: string): { all(...args: unknown[]): unknown; get(...args: unknown[]): unknown } };
/** 读写库面（蒸馏/落卡用；rr 用 node:sqlite 时须补 `transaction` 垫片）。 */
type WriteDb = {
  prepare(sql: string): {
    all(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): { changes: number };
  };
  transaction(fn: () => void): () => void;
};

export interface KnowledgeCard {
  id: string;
  projectId: string;
  kind: KnowledgeCardKind;
  text: string;
  /** 真源出处（"这张卡从哪来"，可复核）。 */
  source: string;
  confidence: number;
  tokens: number;
}

export interface KnowledgeCardCandidate {
  kind: KnowledgeCardKind;
  text: string;
  source: string;
  confidence: number;
}

/** 卡的次序（越靠前越该先入选：坑/验收 > 配方 > 教训 > 术语）。 */
const KIND_RANK: Record<KnowledgeCardKind, number> = {
  pitfall: 0,
  acceptance: 1,
  recipe: 2,
  lesson: 3,
  term: 4,
};

/** 任务形态 → 卡类亲和度（只调先后，不增不减；未列出的形态取平权表）。 */
const CARD_SHAPE_AFFINITY: Record<string, Partial<Record<KnowledgeCardKind, number>>> = {
  code: { recipe: 5, pitfall: 4, lesson: 3, term: 2, acceptance: 1 },
  research: { term: 4, lesson: 3, acceptance: 3, pitfall: 2, recipe: 1 },
  analysis: { acceptance: 4, term: 3, lesson: 3, pitfall: 3, recipe: 2 },
  conversation: { term: 3, lesson: 2, acceptance: 2, pitfall: 1, recipe: 1 },
};
const DEFAULT_AFFINITY: Record<KnowledgeCardKind, number> = { term: 2, acceptance: 2, recipe: 2, lesson: 2, pitfall: 2 };

/** 折叠为一行（换行/连续空白 → 单空格）。 */
function oneLine(s: unknown): string {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

/** 单卡有界：超 60 token 即截断并附省略号（截后仍 ≤60——按同一分度算）。 */
function clampCardText(raw: string): { text: string; tokens: number } {
  const text = oneLine(raw);
  if (estimateTokensFromChars(text.length) <= CARD_MAX_TOKENS) {
    return { text, tokens: estimateTokensFromChars(text.length) };
  }
  const maxChars = CARD_MAX_TOKENS * TOKEN_CHARS_PER_UNIT;
  const cut = `${text.slice(0, Math.max(0, maxChars - 1))}…`;
  return { text: cut, tokens: estimateTokensFromChars(cut.length) };
}

/** 稳定 id（FNV-1a 32 位；不用 node:crypto，保持本模块可被更宽的打包面引入）。 */
function cardId(projectId: string, kind: string, source: string, text: string): string {
  const s = `${projectId}|${kind}|${source}|${text}`;
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `kc-${h.toString(16).padStart(8, '0')}`;
}

/** 从某节正文取候选行（去列表符号；过短的行弃——"是的"不是一张卡）。 */
function sectionLines(content: string): string[] {
  return String(content ?? '')
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '').trim())
    .filter((l) => l.length >= 4);
}

/**
 * 从既有事实**派生**候选卡（纯函数，零写库；`distillKnowledgeCards` 与 rr 同吃这一处）。
 *
 * 来源 → 卡类：
 *   · 知识册 `domain`    → term        · `criteria` → acceptance
 *   · 知识册 `recipes`   → recipe      · 已归档产出物标题 → recipe（"样板：…"）
 *   · 记忆 `retrospective` → lesson    · `failure_knowledge` / `acceptance_failure` → pitfall
 */
export function deriveKnowledgeCardCandidates(db: ReadDb, projectId: string): KnowledgeCardCandidate[] {
  const pid = projectId || '';
  const out: KnowledgeCardCandidate[] = [];
  const SECTION_TO_KIND: Partial<Record<string, KnowledgeCardKind>> = {
    domain: 'term',
    criteria: 'acceptance',
    recipes: 'recipe',
  };
  for (const e of listProjectKnowledge(db, pid)) {
    const kind = SECTION_TO_KIND[e.section];
    if (!kind) continue;
    for (const line of sectionLines(e.content)) {
      out.push({ kind, text: line, source: `project_knowledge:${e.section}`, confidence: kind === 'acceptance' ? 0.9 : kind === 'recipe' ? 0.8 : 0.7 });
    }
  }

  // 已归档产出物标题：登记态（registered/generated）才算"真的产出过"；draft 只是草稿。
  try {
    const dels = db.prepare(
      "SELECT name, type FROM wa_deliverables WHERE project_id = ? AND status IN ('registered','generated') AND name IS NOT NULL AND TRIM(name) != '' ORDER BY created_at DESC LIMIT 12",
    ).all(pid) as Array<{ name?: string; type?: string }>;
    for (const d of dels) {
      out.push({ kind: 'recipe', text: `样板：${oneLine(d.name)}（${oneLine(d.type) || '文件'}）`, source: 'wa_deliverables', confidence: 0.6 });
    }
  } catch { /* 表不在（旧库）⇒ 无此项，不编造 */ }

  try {
    const rows = db.prepare(
      `SELECT content, memory_type, importance FROM wa_memories
        WHERE project_id = ? AND memory_type IN ('failure_knowledge','acceptance_failure','retrospective') AND ${MEM_LIVE_SQL}
        ORDER BY created_at DESC LIMIT 60`,
    ).all(pid) as Array<{ content?: string; memory_type?: string; importance?: number }>;
    for (const r of rows) {
      const kind: KnowledgeCardKind = r.memory_type === 'retrospective' ? 'lesson' : 'pitfall';
      const imp = Math.min(1, Math.max(0, Number(r.importance) || 0.5));
      out.push({
        kind,
        text: oneLine(r.content),
        source: `wa_memories:${r.memory_type ?? ''}`,
        confidence: Math.round((0.4 + 0.4 * imp) * 100) / 100,
      });
    }
  } catch { /* 同上 */ }

  return out;
}

/** 去重 + 排序 + 截到每项目上限（确定性：同输入必得同序）。 */
export function planKnowledgeCards(candidates: readonly KnowledgeCardCandidate[]): Array<KnowledgeCardCandidate & { text: string; tokens: number }> {
  const seen = new Set<string>();
  const kept: Array<KnowledgeCardCandidate & { text: string; tokens: number }> = [];
  for (const c of candidates) {
    const clamped = clampCardText(c.text);
    if (!clamped.text || clamped.text.length < 4) continue;
    const key = `${c.kind}|${c.source}|${clamped.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ ...c, text: clamped.text, tokens: clamped.tokens });
  }
  kept.sort((a, b) =>
    KIND_RANK[a.kind] - KIND_RANK[b.kind]
    || b.confidence - a.confidence
    || a.source.localeCompare(b.source)
    || a.text.localeCompare(b.text));
  return kept.slice(0, CARD_MAX_PER_PROJECT);
}

export interface DistillResult {
  /** 本次写入/更新的卡数（active）。 */
  cards: number;
  /** 本次由 pending 并入 active 的 pitfall 数（验收失败沉淀的教训）。 */
  promoted: number;
  /** 因项目超 24 张被清掉的旧卡数。 */
  pruned: number;
}

/**
 * 蒸馏并落库（Pro 能力；社区档直接返回零，不写库）。
 *
 * ⚠ 生成挂 Pro，**已生成的卡不回收**：降档后卡仍在表里，只是注入侧（`listKnowledgeCards`）按当前档拒绝。
 */
export function distillKnowledgeCards(db: WriteDb, projectId: string): DistillResult {
  const pid = projectId || '';
  if (!pid) return { cards: 0, promoted: 0, pruned: 0 };
  if (proFeatureRefusal(db, KNOWLEDGE_CARD_FEATURE) !== null) return { cards: 0, promoted: 0, pruned: 0 };

  // 上次验收失败沉淀的 pending pitfall：本次蒸馏才并入（"只生成不自动生效"）。
  let pending: Array<{ kind: KnowledgeCardKind; text: string; source: string; confidence: number }> = [];
  try {
    pending = db.prepare(
      "SELECT kind, text, source, confidence FROM wa_knowledge_cards WHERE project_id = ? AND kind = 'pitfall' AND status = 'pending'",
    ).all(pid) as Array<{ kind: KnowledgeCardKind; text: string; source: string; confidence: number }>;
  } catch { pending = []; }

  const planned = planKnowledgeCards([...deriveKnowledgeCardCandidates(db, pid), ...pending]);
  const promoted = planned.filter((c) => c.kind === 'pitfall' && pending.some((p) => p.text === c.text && p.source === c.source)).length;

  let cards = 0;
  let pruned = 0;
  const tx = db.transaction(() => {
    const up = db.prepare(
      `INSERT INTO wa_knowledge_cards (id, project_id, kind, text, source, confidence, tokens, status, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'))
       ON CONFLICT(project_id, kind, source, text) DO UPDATE SET
         confidence = excluded.confidence, tokens = excluded.tokens, status = 'active', updated_at = datetime('now')`,
    );
    for (const c of planned) {
      up.run(cardId(pid, c.kind, c.source, c.text), pid, c.kind, c.text, c.source, c.confidence, c.tokens);
      cards++;
    }
    // 本次没派生到的旧卡清掉（含已并入的 pending）——卡是可再生的派生结果，不积累陈旧。
    const keepIds = planned.map((c) => cardId(pid, c.kind, c.source, c.text));
    if (keepIds.length === 0) {
      pruned = db.prepare('DELETE FROM wa_knowledge_cards WHERE project_id = ?').run(pid).changes;
    } else {
      const ph = keepIds.map(() => '?').join(',');
      pruned = db.prepare(`DELETE FROM wa_knowledge_cards WHERE project_id = ? AND id NOT IN (${ph})`).run(pid, ...keepIds).changes;
    }
  });
  tx();
  return { cards, promoted, pruned };
}

/**
 * 验收失败时**只生成不生效**的 pitfall 卡（Pro 能力；社区档不写）。
 * 同任务反复失败 ⇒ 同文本同源 ⇒ 唯一键去重，不会越积越多。
 * 返回是否新写/更新了一行（旧行被重置为 pending，仍算一次"待并入"）。
 */
export function recordPitfallCandidate(
  db: WriteDb,
  projectId: string,
  input: { taskTitle: string; failedItems: string },
): boolean {
  const pid = projectId || '';
  if (!pid) return false;
  if (proFeatureRefusal(db, KNOWLEDGE_CARD_FEATURE) !== null) return false;
  const text = oneLine(`任务「${input.taskTitle || '未命名'}」验收未达：${input.failedItems || '（未列明项）'}`);
  if (text.length < 4) return false;
  const clamped = clampCardText(text);
  try {
    db.prepare(
      `INSERT INTO wa_knowledge_cards (id, project_id, kind, text, source, confidence, tokens, status, updated_at)
       VALUES (?, ?, 'pitfall', ?, 'acceptance_check', 0.5, ?, 'pending', datetime('now'))
       ON CONFLICT(project_id, kind, source, text) DO UPDATE SET
         confidence = excluded.confidence, tokens = excluded.tokens, status = 'pending', updated_at = datetime('now')`,
    ).run(cardId(pid, 'pitfall', 'acceptance_check', clamped.text), pid, clamped.text, clamped.tokens);
    return true;
  } catch { return false; }
}

/** 某项目**可注入**的卡（active）。Pro 闸在调用方 `MemoryManager.listKnowledgeCards` 里过。 */
export function listActiveKnowledgeCards(db: ReadDb, projectId: string): KnowledgeCard[] {
  try {
    const rows = db.prepare(
      "SELECT id, project_id, kind, text, source, confidence, tokens FROM wa_knowledge_cards WHERE project_id = ? AND status = 'active' ORDER BY kind, confidence DESC, id",
    ).all(projectId || '') as Array<{ id?: string; project_id?: string; kind?: string; text?: string; source?: string; confidence?: number; tokens?: number }>;
    return rows
      .filter((r) => (KNOWLEDGE_CARD_KINDS as readonly string[]).includes(String(r.kind ?? '')))
      .map((r) => ({
        id: String(r.id ?? ''),
        projectId: String(r.project_id ?? ''),
        kind: r.kind as KnowledgeCardKind,
        text: String(r.text ?? ''),
        source: String(r.source ?? ''),
        confidence: Number(r.confidence) || 0,
        tokens: Math.max(0, Number(r.tokens) || estimateTokensFromChars(String(r.text ?? '').length)),
      }));
  } catch { return []; }
}

/**
 * 注入前选卡：按任务形态亲和度 + 任务关键词重合打分，取 ≤5 张且总 token ≤150。
 * 装不下一张就跳过该张（不截半张卡——卡的意义是一句完整的话）。
 */
export function selectKnowledgeCardsForInject(
  cards: readonly KnowledgeCard[],
  archetype: string | null | undefined,
  taskText: string | null | undefined,
  tokenBudget: number = CARD_INJECT_MAX_TOKENS,
  maxItems: number = CARD_INJECT_MAX_ITEMS,
): KnowledgeCard[] {
  if (cards.length === 0) return [];
  const affinity = CARD_SHAPE_AFFINITY[archetype ?? ''] ?? DEFAULT_AFFINITY;
  const keywords = extractKeywords(String(taskText ?? ''));
  const scored = cards.map((c) => {
    const overlap = keywords.filter((k) => c.text.includes(k)).length;
    const score = (affinity[c.kind] ?? DEFAULT_AFFINITY[c.kind]) * 10 + overlap * 2 + c.confidence;
    return { card: c, score };
  });
  scored.sort((a, b) => b.score - a.score || a.card.tokens - b.card.tokens || a.card.id.localeCompare(b.card.id));
  const out: KnowledgeCard[] = [];
  let used = 0;
  for (const { card } of scored) {
    if (out.length >= maxItems) break;
    if (used + card.tokens > tokenBudget) continue;
    out.push(card);
    used += card.tokens;
  }
  return out;
}
