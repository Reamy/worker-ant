/**
 * zx_20261030_1 M6「荐」（大野耐一·现地现物 / 柏拉图·美诺「学习即回忆」）: **项目级相似推荐**。
 *
 * 病根（§1.3 D7）：跨项目相似此前只到**任务级**（`memory-exemplars.ts`），项目级没有
 * 「与你相似的三个项目」入口。本模块补这一个只读入口。
 *
 * 判据**确定性、零 LLM、零向量库**（诚实边界：这不是训练出来的模型，也不是 embedding 检索）：
 *   · 画像术语交集（`project-profile.terms` + 项目名/描述 + 知识书 `domain` 节）—— 权重 0.50；
 *   · 名称/描述关键词 Jaccard（同一分词器 `extractKeywords`）—— 权重 0.20；
 *   · 知识卡**种类分布**余弦（active 卡，按 kind 计数）—— 权重 0.15；
 *   · 产出类型分布余弦（`wa_deliverables.type` 计数）—— 权重 0.15。
 * 只返回**有据**者：必须有共同术语/共同产出类型/共同卡种类之一，且总分 ≥ `SIMILAR_MIN_SCORE`；
 * 不是"总能凑出三个"——凑不出就少给，**输入不足 ⇒ 空数组**（"没据"是如实值）。
 *
 * 推荐**只展示、不自动注入**（§2.6）：注入会省 token 但会污染上下文，由用户点选。
 */
import { extractKeywords } from './memory-select.js';
import { readProjectProfile } from './project-profile.js';
import { listProjectKnowledge } from './project-knowledge.js';
import { KNOWLEDGE_CARD_KIND_LABEL, KNOWLEDGE_CARD_KINDS, type KnowledgeCardKind } from './knowledge-cards.js';

type SimDb = {
  prepare(sql: string): {
    all(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): { changes: number };
  };
};

/** 相似度阈值（低于此分不推荐——"有据才给"）。 */
export const SIMILAR_MIN_SCORE = 0.18;
/** 最多推荐几个（§2.6：前 3 个）。 */
export const SIMILAR_TOP_N = 3;
/** 候选池上界（有界；按 id 排序保证确定性）。 */
const SIMILAR_CANDIDATE_LIMIT = 200;

export interface SimilarProject {
  projectId: string;
  name: string;
  /** 0–1，保留 4 位小数（界面直接展示）。 */
  score: number;
  /** 「为什么像」——至少一条；界面逐行上屏。 */
  reasons: string[];
}

interface FeatureSet {
  projectId: string;
  name: string;
  /** 术语/关键词（小写去重）。 */
  terms: Set<string>;
  /** 仅名称/描述分词（与术语分开，用于 Jaccard 权重）。 */
  keywords: Set<string>;
  cardKinds: Map<string, number>;
  delivTypes: Map<string, number>;
}

function normTerm(t: string): string {
  return String(t ?? '').trim().toLowerCase();
}

function addTerms(set: Set<string>, text: string): void {
  for (const k of extractKeywords(String(text ?? ''))) {
    const t = normTerm(k);
    if (t.length >= 1) set.add(t);
  }
}

function projectRow(db: SimDb, projectId: string): { name: string; description: string } | null {
  const row = db.prepare('SELECT name, description FROM wa_projects WHERE id = ?').get(projectId) as
    { name?: string; description?: string } | undefined;
  if (!row) return null;
  return { name: String(row.name ?? ''), description: String(row.description ?? '') };
}

function featuresOf(db: SimDb, projectId: string): FeatureSet | null {
  const p = projectRow(db, projectId);
  if (!p) return null;
  const terms = new Set<string>();
  const keywords = new Set<string>();

  const kwText = `${p.name} ${p.description}`;
  addTerms(keywords, kwText);
  for (const k of keywords) terms.add(k);

  // 画像术语（本机生成/导入均可读；坏 JSON ⇒ null，不让一条坏画像拖垮推荐）
  try {
    const stored = readProjectProfile(db as unknown as Parameters<typeof readProjectProfile>[0], projectId);
    if (stored?.profile.terms) addTerms(terms, stored.profile.terms);
    if (stored?.profile.acceptance) addTerms(terms, stored.profile.acceptance);
  } catch { /* 画像读不到 ⇒ 少一维证据，不伪造 */ }

  // 知识书 `domain` 节（术语/约定/高频实体——既有真源，不再另派发）
  try {
    const domain = listProjectKnowledge(db as unknown as Parameters<typeof listProjectKnowledge>[0], projectId)
      .find((e) => e.section === 'domain')?.content ?? '';
    if (domain) addTerms(terms, domain);
  } catch { /* 同上 */ }

  const cardKinds = new Map<string, number>();
  try {
    const rows = db.prepare(
      "SELECT kind AS kind, COUNT(*) AS n FROM wa_knowledge_cards WHERE project_id = ? AND status = 'active' GROUP BY kind",
    ).all(projectId) as Array<{ kind?: string; n?: number }>;
    for (const r of rows) {
      const k = String(r.kind ?? '');
      if (!(KNOWLEDGE_CARD_KINDS as readonly string[]).includes(k)) continue;
      cardKinds.set(k, Number(r.n ?? 0) || 0);
    }
  } catch { /* 新库无卡表读数 ⇒ 空 */ }

  const delivTypes = new Map<string, number>();
  try {
    const rows = db.prepare(
      'SELECT type AS type, COUNT(*) AS n FROM wa_deliverables WHERE project_id = ? GROUP BY type',
    ).all(projectId) as Array<{ type?: string; n?: number }>;
    for (const r of rows) {
      const t = String(r.type ?? '').trim();
      if (!t) continue;
      delivTypes.set(t, Number(r.n ?? 0) || 0);
    }
  } catch { /* 同上 */ }

  return { projectId, name: p.name, terms, keywords, cardKinds, delivTypes };
}

function intersectSize(a: Set<string>, b: Set<string>): number {
  let n = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const x of small) if (big.has(x)) n++;
  return n;
}

function sharedValues(a: Set<string>, b: Set<string>): string[] {
  return [...a].filter((x) => b.has(x)).sort();
}

/** 分布余弦（键集取并集；两边都空 ⇒ 0）。 */
function cosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const keys = new Set([...a.keys(), ...b.keys()]);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const k of keys) {
    const x = a.get(k) ?? 0;
    const y = b.get(k) ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * 与 `projectId` 最相似的前 N 个项目。
 *   · 输入不足（目标项目无术语/无卡/无产出）⇒ `[]`；
 *   · 候选只列**本项目之外**的项目；推荐只读，不写任何表。
 */
export function similarProjects(
  db: SimDb,
  projectId: string,
  opts: { limit?: number } = {},
): SimilarProject[] {
  const pid = String(projectId ?? '');
  if (!pid) return [];
  const target = featuresOf(db, pid);
  if (!target) return [];
  // 输入不足：连名称/描述都判不出词，且没有卡与产出 ⇒ 不给推荐（不拿"随机的三个"凑数）。
  if (target.terms.size === 0 && target.cardKinds.size === 0 && target.delivTypes.size === 0) return [];

  const lim = Math.min(
    Math.max(1, Math.floor(Number(opts.limit) || SIMILAR_TOP_N)),
    SIMILAR_TOP_N,
  );
  const candidates = db.prepare(
    'SELECT id FROM wa_projects WHERE id <> ? ORDER BY id LIMIT ?',
  ).all(pid, SIMILAR_CANDIDATE_LIMIT) as Array<{ id?: string }>;

  const out: SimilarProject[] = [];
  for (const c of candidates) {
    const cid = String(c.id ?? '');
    if (!cid || cid === pid) continue;
    const f = featuresOf(db, cid);
    if (!f) continue;

    const sharedTerms = sharedValues(target.terms, f.terms);
    const minTerm = Math.min(target.terms.size, f.terms.size);
    const termScore = minTerm > 0 ? sharedTerms.length / minTerm : 0;

    const sharedKw = sharedValues(target.keywords, f.keywords);
    const kwUnion = new Set([...target.keywords, ...f.keywords]).size;
    const kwScore = kwUnion > 0 ? sharedKw.length / kwUnion : 0;

    const cardScore = cosine(target.cardKinds, f.cardKinds);
    const delivScore = cosine(target.delivTypes, f.delivTypes);

    const score = 0.5 * termScore + 0.2 * kwScore + 0.15 * cardScore + 0.15 * delivScore;
    if (score < SIMILAR_MIN_SCORE) continue;

    const sharedCards = sharedValues(
      new Set([...target.cardKinds.keys()]),
      new Set([...f.cardKinds.keys()]),
    );
    const sharedDelivs = sharedValues(
      new Set([...target.delivTypes.keys()]),
      new Set([...f.delivTypes.keys()]),
    );
    // 有据：至少要有一类真实交集（分数可以因分布相近而虚高，逐类交集才是"为什么像"）。
    if (sharedTerms.length === 0 && sharedDelivs.length === 0 && sharedCards.length === 0) continue;

    const reasons: string[] = [];
    if (sharedTerms.length > 0) {
      reasons.push(`共同术语：${sharedTerms.slice(0, 5).join('、')}`);
    }
    if (sharedDelivs.length > 0) {
      reasons.push(`共同产出类型：${sharedDelivs.slice(0, 4).join(' / ')}`);
    }
    if (sharedCards.length > 0) {
      reasons.push(`知识卡构成相近：${sharedCards
        .map((k) => KNOWLEDGE_CARD_KIND_LABEL[k as KnowledgeCardKind] ?? k)
        .join(' / ')}`);
    }

    out.push({ projectId: cid, name: f.name, score: round4(score), reasons });
  }

  out.sort((a, b) =>
    b.score - a.score
    || b.reasons.length - a.reasons.length
    || a.projectId.localeCompare(b.projectId));
  return out.slice(0, lim);
}
