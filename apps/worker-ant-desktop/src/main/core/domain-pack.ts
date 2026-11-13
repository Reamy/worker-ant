/**
 * zx_20261021_3 批一（庄子·养生主「指穷于为薪，火传也，不知其尽也」）: **领域包**——
 *   把某个项目里**已经发生的事实**中可迁移的那几节（领域与术语 / 验收与失败 / 配方与样板）
 *   派生为一份**可携带、可共享、可撤回**的 JSON 资产。
 *
 * 与既有物的分工（不重抄、不冒充）：
 *   · `project-knowledge.ts` —— 本项目的**九节整册**（含 artifacts/index/runtime 等不可迁移项）；
 *     本模块**只取其中三节**，且直接调用同一个 `deriveProjectKnowledge`（派生只此一处）。
 *   · `getCrossProjectKnowledge` —— 隐式、自动、按相似任务的记忆 top-3；本包是**显式**资产：
 *     用户挑、用户启用、能共享、能撤回。"自动捡到的"与"亲手带走的"是两件事，两本账分开。
 *   · 团队共享库 —— 本包作为第四类 item 走**既有** `team_library` 闸（批三），不另立假闸。
 *
 * ⚠ **零 LLM / 零网络 / 零 electron**：rr 可拿内存库直跑真实现。
 * ⚠ **有界且诚实**：超过 `DOMAIN_PACK_MAX_CHARS` 时按 `recipes → criteria → domain` **整节丢弃**，
 *   绝不截半句；丢了哪几节写进 `omitted_sections`——"带走了什么"与"没带走什么"同样如实。
 * ⚠ **不携带 sourceRef**：那是本项目内部出处（可能含本机路径），跨机无意义且泄隐私；
 *   包里只留节内容 + 源项目**名字**。
 * ⚠ **导入 ≠ 启用**：`wa_domain_packs` 是资产，`wa_project_domain_packs` 是启用关系；
 *   共享库拉取只落资产，启用是用户在本机显式动作。
 */
import { deriveProjectKnowledge, PROJECT_KNOWLEDGE_SECTION_LABEL, type ProjectKnowledgeEntry } from './project-knowledge.js';
// B3：业务域聚类的两个既有真源——活知识卡（已蒸馏、过 Pro 闸的卡）与任务关键词（不另写切词）。
import { KNOWLEDGE_CARD_KIND_LABEL, listActiveKnowledgeCards } from './knowledge-cards.js';
import { extractKeywords } from './memory-select.js';
import { proFeatureRefusal } from './pro-gate.js';
import { estimateTokensFromChars } from './token-estimate.js';
// zx_20261113_4 B2「荐」：候选包的"为什么推荐"复用**同一套**相似度判据（不另造分数）。
import { scoreProjectPair } from './project-similarity.js';

/** 可携带的三节——唯一定处（新增一节须穷举全部读取谓词）。 */
export const DOMAIN_PACK_SECTIONS = ['domain', 'criteria', 'recipes'] as const;
export type DomainPackSection = (typeof DOMAIN_PACK_SECTIONS)[number];

/** 节的人话名：直接取知识册标签（同一物不在两处起两个名）。 */
export const DOMAIN_PACK_SECTION_LABEL: Record<DomainPackSection, string> = {
  domain: PROJECT_KNOWLEDGE_SECTION_LABEL.domain,
  criteria: PROJECT_KNOWLEDGE_SECTION_LABEL.criteria,
  recipes: PROJECT_KNOWLEDGE_SECTION_LABEL.recipes,
};

/**
 * zx_20261107_1 B3「实·通·信」（巴特莱特·图式 / 赫布·共现强化 / 托尔文·语义记忆）:
 *   **业务域层**——同一个业务概念在不同项目里叫法不同、规则散落。本层在既有三节之外，
 *   把「业务术语 / 业务规则 / 典型场景」确定性聚成一块可携带、按需注入的业务知识。
 *
 * 纪律：
 *   · **零 LLM、零训练**：聚类 = 归一化 + 释义相等合并，同输入同输出同顺序；
 *   · **不改写已有知识**：只读项目知识/知识卡/已启用领域包，产物只进新包的 `pack_json`；
 *   · **同名异义不合并**（按名字分组，释义取最短一条，不猜）；**同义异名合并为别名**（释义归一后相等）；
 *   · **按需注入**：有任务文本时只挑与关键词相关的条目，且整块 ≤ `BUSINESS_INJECT_MAX_TOKENS`；
 *   · **v1 包照读**：无 `business` 字段即缺席，不补空壳（存储形状只加可选字段，不新增表列）。
 */
export interface BusinessTerm {
  term: string;
  meaning: string;
  /** 同义异名（归一化后释义相等/名字写法变体）；注入时随条目一起给出。 */
  aliases: string[];
  sources: string[];
}

export interface BusinessRule {
  rule: string;
  sources: string[];
}

export interface BusinessScenario {
  scenario: string;
  sources: string[];
}

export interface BusinessDomain {
  terms: BusinessTerm[];
  rules: BusinessRule[];
  scenarios: BusinessScenario[];
}

/** 输入形状（派生侧与回归共用）：允许缺释义/出处。 */
export interface BusinessDomainInput {
  terms?: Array<{ term: string; meaning?: string; source?: string }>;
  rules?: Array<{ rule: string; source?: string }>;
  scenarios?: Array<{ scenario: string; source?: string }>;
}

/** 有界：条目数、字段长、输入扫描量。 */
export const BUSINESS_MAX_TERMS = 20;
export const BUSINESS_MAX_RULES = 12;
export const BUSINESS_MAX_SCENARIOS = 8;
export const BUSINESS_TERM_MAX_CHARS = 40;
export const BUSINESS_MEANING_MAX_CHARS = 120;
export const BUSINESS_RULE_MAX_CHARS = 160;
export const BUSINESS_SCENARIO_MAX_CHARS = 160;
export const BUSINESS_SOURCE_MAX_CHARS = 80;
const BUSINESS_INPUT_MAX_ITEMS = 200;
/** 「业务域」子块自身的注入上界（整包总预算仍是 `DOMAIN_PACK_INJECT_MAX_TOKENS`）。 */
export const BUSINESS_INJECT_MAX_TOKENS = 150;

/** 包格式版本（结构变更时递增；读取侧按版本决定能否认识）。v2 = 可选业务域字段。 */
export const DOMAIN_PACK_VERSION = 2;
/** 整包体量上限（字符）。超界整节丢弃，不截字。 */
export const DOMAIN_PACK_MAX_CHARS = 16_000;
/** 超界时的丢弃次序（低价值/强项目相关者先走）：配方 → 验收 → 领域。 */
const DOMAIN_PACK_DROP_ORDER: readonly DomainPackSection[] = ['recipes', 'criteria', 'domain'];
/** 「领域包」注入段自身的 token 上界（唯一口径 `estimateTokensFromChars`）。 */
export const DOMAIN_PACK_INJECT_MAX_TOKENS = 400;
/** 名称/描述上界（防止一条超长标题把共享库列撑爆）。 */
export const DOMAIN_PACK_NAME_MAX = 120;
export const DOMAIN_PACK_DESC_MAX = 300;

export interface DomainPackSectionPayload {
  section: DomainPackSection;
  content: string;
}

export interface DomainPackPayload {
  version: number;
  name: string;
  description: string;
  sections: DomainPackSectionPayload[];
  source: { project_id: string; project_name: string };
  derived_at: string;
  /** 明确不用于训练（与知识导出的 `training:false` 同一承诺）。 */
  training: false;
  /** 超界被整节丢弃的节（空数组＝全带走了）。 */
  omitted_sections: DomainPackSection[];
  /** v2 可选业务域层；缺席＝本项目没有可聚的业务概念（不写空壳）。 */
  business?: BusinessDomain;
}

/** 包来路（zx_20261030_1 M6）：用户主动生成/导入，或系统按项目知识建议的候选。 */
export type DomainPackOrigin = 'user' | 'auto_candidate';

export interface DomainPackRow {
  id: string;
  name: string;
  description: string;
  source_project_id: string | null;
  source_project_name: string;
  origin: DomainPackOrigin;
  /** 非空 = 用户已忽略该候选（只对 `auto_candidate` 有语义）。 */
  dismissed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AppliedDomainPack {
  id: string;
  name: string;
  description: string;
  sections: DomainPackSectionPayload[];
  /** v2 可选业务域层；缺席＝该包没有业务概念（不补空壳）。 */
  business?: BusinessDomain;
  source_project_name: string;
  applied_at: string;
}

/** 候选包的推荐依据（与「相似项目」同一套分数与理由——不另造一把尺）。 */
export interface DomainPackSimilarity {
  score: number;
  reasons: string[];
}

/** 候选包的内容预览（节名 + 首段摘要；有界，不把整包塞进列表）。 */
export interface DomainPackPreviewSection {
  section: string;
  label: string;
  snippet: string;
}

export interface DomainPackListRow extends DomainPackRow {
  applied: boolean;
  section_count: number;
  chars: number;
  /** 仅 `listSuggestedDomainPacks` 填：与当前项目的相似度；无依据 ⇒ 缺席（不编 0 分）。 */
  similarity?: DomainPackSimilarity;
  /** 仅 `listSuggestedDomainPacks` 填：最多 3 节的内容预览。 */
  preview?: DomainPackPreviewSection[];
}

export interface DomainPackStats {
  injections: number;
  chars: number;
  completed: number;
  failed: number;
  packs: Array<{ pack_id: string; name: string; injections: number; chars: number; completed: number; failed: number }>;
}

/**
 * 窄面三法合一。**不可**写成 `ReadDb & WriteDb`：两个 `prepare` 重载相交时 TS 只取首个签名，
 *   返回值里就没有 `run`（实测 tsc 红）。故显式给出全集，读写共用一个窄接口。
 */
type ReadDb = { prepare(sql: string): { all(...args: unknown[]): unknown; get(...args: unknown[]): unknown } };
/** 只写窄面（与 `knowledge-export` 同形：不绑 better-sqlite3 类型，rr 可直接传内存库）。 */
type WriteDb = { prepare(sql: string): { run(...args: unknown[]): { changes: number } } };
type PackDb = { prepare(sql: string): { all(...args: unknown[]): unknown; get(...args: unknown[]): unknown; run(...args: unknown[]): { changes: number } } };

function newPackId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `dp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function clip(s: string, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * 业务词归一键：NFKC（全/半角、兼容字符）+ 小写 + 去掉空白/标点/符号。
 *   `客户` 与 `客户 `、`API 密钥` 与 `api密钥` 由此同一；`客户` 与 `客户经理` 仍不同。
 */
function normBusinessKey(s: string): string {
  return String(s ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/** 稳定排序：短者先，同长按码位字典序（不依赖 locale，跨机同序）。 */
function byLenThenLex(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

function pickMeaning(meanings: string[]): string {
  return [...new Set(meanings.filter((m) => m.trim() !== ''))].sort(byLenThenLex)[0] ?? '';
}

/**
 * 确定性业务域聚类（零 LLM）：
 *   · 术语先按**归一名字**分组（同名异义取最短释义，不猜）；
 *   · 再把归一释义相等的组并为同一条，其余名字进 `aliases`（同义异名）；
 *   · 规则/场景按归一文本去重，首见者胜，各自有界。
 */
export function deriveBusinessDomain(input: BusinessDomainInput): BusinessDomain {
  type TermGroup = { surfaces: string[]; meanings: string[]; sources: string[] };
  const groups: TermGroup[] = [];
  const byName = new Map<string, TermGroup>();
  for (const t of (input.terms ?? []).slice(0, BUSINESS_INPUT_MAX_ITEMS)) {
    const term = clip(t?.term ?? '', BUSINESS_TERM_MAX_CHARS);
    const key = normBusinessKey(term);
    if (!term || !key) continue;
    let g = byName.get(key);
    if (!g) {
      g = { surfaces: [], meanings: [], sources: [] };
      byName.set(key, g);
      groups.push(g);
    }
    g.surfaces.push(term);
    const meaning = clip(t?.meaning ?? '', BUSINESS_MEANING_MAX_CHARS);
    if (meaning) g.meanings.push(meaning);
    const source = clip(t?.source ?? '', BUSINESS_SOURCE_MAX_CHARS);
    if (source) g.sources.push(source);
  }

  // 同义异名合并：释义（归一后）相等且非空 ⇒ 同一业务概念的不同叫法。
  const byMeaning = new Map<string, TermGroup>();
  const merged: TermGroup[] = [];
  for (const g of groups) {
    const meaning = pickMeaning(g.meanings);
    const mk = meaning ? `m:${normBusinessKey(meaning)}` : '';
    const host = mk ? byMeaning.get(mk) : undefined;
    if (host) {
      host.surfaces.push(...g.surfaces);
      host.meanings.push(...g.meanings);
      host.sources.push(...g.sources);
    } else {
      if (mk) byMeaning.set(mk, g);
      merged.push(g);
    }
  }

  const terms: BusinessTerm[] = merged.slice(0, BUSINESS_MAX_TERMS).map((g) => {
    const surfaces = [...new Set(g.surfaces)].sort(byLenThenLex);
    return {
      term: surfaces[0] ?? '',
      meaning: pickMeaning(g.meanings),
      aliases: surfaces.slice(1),
      sources: [...new Set(g.sources)].sort(),
    };
  });

  const dedupe = <T extends { sources: string[] }>(
    items: Array<{ text: string; source: string }>,
    max: number,
    build: (text: string, sources: string[]) => T,
  ): T[] => {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const it of items.slice(0, BUSINESS_INPUT_MAX_ITEMS)) {
      const key = normBusinessKey(it.text);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(build(it.text, it.source ? [it.source] : []));
      if (out.length >= max) break;
    }
    return out;
  };

  return {
    terms,
    rules: dedupe(
      (input.rules ?? []).map((r) => ({ text: clip(r?.rule ?? '', BUSINESS_RULE_MAX_CHARS), source: clip(r?.source ?? '', BUSINESS_SOURCE_MAX_CHARS) })).filter((r) => r.text !== ''),
      BUSINESS_MAX_RULES,
      (rule, sources) => ({ rule, sources }),
    ),
    scenarios: dedupe(
      (input.scenarios ?? []).map((s) => ({ text: clip(s?.scenario ?? '', BUSINESS_SCENARIO_MAX_CHARS), source: clip(s?.source ?? '', BUSINESS_SOURCE_MAX_CHARS) })).filter((s) => s.text !== ''),
      BUSINESS_MAX_SCENARIOS,
      (scenario, sources) => ({ scenario, sources }),
    ),
  };
}

export function isEmptyBusinessDomain(b: BusinessDomain | null | undefined): boolean {
  return !b || (b.terms.length === 0 && b.rules.length === 0 && b.scenarios.length === 0);
}

/** 解析一个业务域（形状坏/空 ⇒ `undefined`，不伪造空壳）。 */
export function parseBusinessDomain(raw: unknown): BusinessDomain | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const str = (v: unknown, max: number): string => (typeof v === 'string' ? clip(v, max) : '');
  const list = (v: unknown, max: number, maxChars: number): string[] =>
    Array.isArray(v)
      ? [...new Set(v.map((x) => str(x, maxChars)).filter((x) => x !== ''))].slice(0, max)
      : [];

  const terms: BusinessTerm[] = [];
  if (Array.isArray(o.terms)) {
    for (const item of o.terms.slice(0, BUSINESS_MAX_TERMS)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const t = item as Record<string, unknown>;
      const term = str(t.term, BUSINESS_TERM_MAX_CHARS);
      if (!term) continue;
      terms.push({
        term,
        meaning: str(t.meaning, BUSINESS_MEANING_MAX_CHARS),
        aliases: list(t.aliases, BUSINESS_MAX_TERMS, BUSINESS_TERM_MAX_CHARS),
        sources: list(t.sources, BUSINESS_MAX_TERMS, BUSINESS_SOURCE_MAX_CHARS),
      });
    }
  }

  const rules: BusinessRule[] = [];
  if (Array.isArray(o.rules)) {
    for (const item of o.rules.slice(0, BUSINESS_MAX_RULES)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const r = item as Record<string, unknown>;
      const rule = str(r.rule, BUSINESS_RULE_MAX_CHARS);
      if (rule) rules.push({ rule, sources: list(r.sources, BUSINESS_MAX_TERMS, BUSINESS_SOURCE_MAX_CHARS) });
    }
  }

  const scenarios: BusinessScenario[] = [];
  if (Array.isArray(o.scenarios)) {
    for (const item of o.scenarios.slice(0, BUSINESS_MAX_SCENARIOS)) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const s = item as Record<string, unknown>;
      const scenario = str(s.scenario, BUSINESS_SCENARIO_MAX_CHARS);
      if (scenario) scenarios.push({ scenario, sources: list(s.sources, BUSINESS_MAX_TERMS, BUSINESS_SOURCE_MAX_CHARS) });
    }
  }

  const out: BusinessDomain = { terms, rules, scenarios };
  return isEmptyBusinessDomain(out) ? undefined : out;
}

type BusinessInputAccumulator = {
  terms: NonNullable<BusinessDomainInput['terms']>;
  rules: NonNullable<BusinessDomainInput['rules']>;
  scenarios: NonNullable<BusinessDomainInput['scenarios']>;
};

function stripListMarker(line: string): string {
  return line.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '').trim();
}

/** `术语：a=b · c=d` 的右半 → 逐对；`=`/`＝` 可有可无（无等号即只有词、无释义）。 */
function termPairsOf(text: string): Array<{ term: string; meaning: string }> {
  const out: Array<{ term: string; meaning: string }> = [];
  const rest = text.replace(/^术语[：:]\s*/, '');
  for (const part of rest.split(/ · /)) {
    const p = part.trim();
    if (!p) continue;
    const at = p.search(/[=＝]/);
    if (at >= 0) out.push({ term: p.slice(0, at).trim(), meaning: p.slice(at + 1).trim() });
    else out.push({ term: p, meaning: '' });
  }
  return out;
}

/**
 * 一节正文 → 业务域输入（`deriveDomainPack` 与 rr 同引）。
 *   术语行 `术语：…` / 约定行 `约定：…` 只在 `domain` 节；`criteria`/`recipes` 的每条列表行
 *   都是"典型场景"（许诺过的验收、跑通过的配方）——**不猜语义**，按行的**位置**归域。
 *   `高频实体/高频关系` 等其余行不进业务域（它们是频度榜，不是业务概念）。
 */
function collectSectionBusiness(
  section: DomainPackSection,
  content: string,
  source: string,
  acc: BusinessInputAccumulator,
): void {
  for (const raw of String(content ?? '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (section === 'domain') {
      if (/^术语[：:]/.test(line)) {
        for (const p of termPairsOf(line)) acc.terms.push({ term: p.term, meaning: p.meaning, source });
      } else if (/^约定[：:]/.test(line)) {
        const rule = line.replace(/^约定[：:]\s*/, '');
        if (rule) acc.rules.push({ rule, source });
      }
      continue;
    }
    const scenario = stripListMarker(line);
    if (scenario) acc.scenarios.push({ scenario, source });
  }
}

/**
 * 三源汇一（唯一定处）：项目知识册三节 + 本项目活知识卡 + 已启用领域包。
 *
 * ⚠ **只读**：不改既有知识、不写任何表；产物只进新包的 `business` 字段。
 * ⚠ 知识卡表在生产恒存在（`database.ts` 建表段）；旧夹具缺表时 `listActiveKnowledgeCards`
 *   按其既有语义返回空表（不编卡，也不拖垮派生）。
 */
function collectBusinessInputs(
  db: ReadDb,
  pid: string,
  entries: ReadonlyArray<ProjectKnowledgeEntry>,
): BusinessDomainInput {
  const acc: BusinessInputAccumulator = { terms: [], rules: [], scenarios: [] };
  for (const e of entries) {
    if (e.section === 'domain' || e.section === 'criteria' || e.section === 'recipes') {
      const source = e.section === 'domain'
        ? '项目知识·术语'
        : e.section === 'criteria' ? '项目知识·验收' : '项目知识·配方';
      // domain 节里术语行与约定行共存，源标按行细分（不把约定冒充术语）。
      if (e.section === 'domain') {
        for (const raw of e.content.split(/\r?\n/)) {
          const line = raw.trim();
          if (/^术语[：:]/.test(line)) {
            for (const p of termPairsOf(line)) acc.terms.push({ term: p.term, meaning: p.meaning, source });
          } else if (/^约定[：:]/.test(line)) {
            const rule = line.replace(/^约定[：:]\s*/, '');
            if (rule) acc.rules.push({ rule, source: '项目知识·约定' });
          }
        }
      } else {
        collectSectionBusiness(e.section, e.content, source, acc);
      }
    }
  }

  for (const c of listActiveKnowledgeCards(db, pid)) {
    const source = `知识卡·${KNOWLEDGE_CARD_KIND_LABEL[c.kind]}`;
    if (c.kind === 'term') {
      // 卡是从 `domain` 节逐行蒸馏的：只有 `术语：` 行才是业务术语（频度榜不是）。
      if (/^术语[：:]/.test(c.text)) {
        for (const p of termPairsOf(c.text)) acc.terms.push({ term: p.term, meaning: p.meaning, source });
      }
    } else if (c.kind === 'lesson' || c.kind === 'pitfall') {
      acc.rules.push({ rule: c.text, source });
    } else {
      acc.scenarios.push({ scenario: c.text, source });
    }
  }

  for (const pack of listAppliedDomainPacks(db, pid)) {
    const source = `领域包·${pack.name}`;
    if (pack.business && !isEmptyBusinessDomain(pack.business)) {
      for (const t of pack.business.terms) acc.terms.push({ term: t.term, meaning: t.meaning, source });
      for (const r of pack.business.rules) acc.rules.push({ rule: r.rule, source });
      for (const s of pack.business.scenarios) acc.scenarios.push({ scenario: s.scenario, source });
    } else {
      // v1 包没有 business：按同一套行格式读原文（不重写包，只在本次派生里用）。
      for (const s of pack.sections) collectSectionBusiness(s.section, s.content, source, acc);
    }
  }

  return acc;
}

function projectNameOf(db: ReadDb, projectId: string): string {
  try {
    const row = db.prepare('SELECT name FROM wa_projects WHERE id = ?').get(projectId) as { name?: string } | undefined;
    return String(row?.name ?? '').trim();
  } catch {
    return '';
  }
}

/** 解析一段 pack_json——损坏即 `null`（调用方跳过该行，不伪造空包）。 */
export function parseDomainPackJson(raw: unknown): DomainPackPayload | null {
  try {
    const o = JSON.parse(String(raw ?? '')) as Partial<DomainPackPayload>;
    if (!o || typeof o !== 'object') return null;
    if (!Array.isArray(o.sections)) return null;
    const sections: DomainPackSectionPayload[] = [];
    for (const s of o.sections) {
      const sec = (s as { section?: unknown })?.section;
      const content = (s as { content?: unknown })?.content;
      if (typeof sec !== 'string' || !(DOMAIN_PACK_SECTIONS as readonly string[]).includes(sec)) continue;
      if (typeof content !== 'string' || !content.trim()) continue;
      sections.push({ section: sec as DomainPackSection, content });
    }
    // v2 可选业务域：形状坏/为空 ⇒ 缺席（不补空壳；v1 包照旧可读）。
    const business = parseBusinessDomain((o as { business?: unknown }).business);
    return {
      version: Number(o.version) || 0,
      name: String(o.name ?? ''),
      description: String(o.description ?? ''),
      sections,
      source: {
        project_id: String(o.source?.project_id ?? ''),
        project_name: String(o.source?.project_name ?? ''),
      },
      derived_at: String(o.derived_at ?? ''),
      training: false,
      omitted_sections: Array.isArray(o.omitted_sections)
        ? o.omitted_sections.filter((s): s is DomainPackSection => (DOMAIN_PACK_SECTIONS as readonly string[]).includes(String(s)))
        : [],
      ...(business ? { business } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * 从某项目派生一份领域包（只读）。空册 ⇒ `ok:false`（"没得带"是如实值，不伪造空包）。
 * `opts.now` 仅供判据钉确定性（生产不传）。
 */
export function deriveDomainPack(
  db: ReadDb,
  projectId: string,
  opts: { name?: string; description?: string; now?: string } = {},
): { ok: true; pack: DomainPackPayload } | { ok: false; reason: string } {
  const pid = String(projectId ?? '');
  if (!pid) return { ok: false, reason: '缺少项目 id' };
  const entries = deriveProjectKnowledge(db, pid);
  const picked = DOMAIN_PACK_SECTIONS
    .map((section) => {
      const e = entries.find((x) => x.section === section);
      return e && e.content.trim() ? { section, content: e.content } : null;
    })
    .filter((x): x is DomainPackSectionPayload => x !== null);
  if (picked.length === 0) {
    return { ok: false, reason: '本项目暂无可携带的领域知识（领域与术语 / 验收与失败 / 配方与样板均为空）' };
  }
  // 有界：整节丢弃（低价值者先走），绝不截字。
  let kept = [...picked];
  let total = kept.reduce((n, s) => n + s.content.length, 0);
  const omitted: DomainPackSection[] = [];
  for (const section of DOMAIN_PACK_DROP_ORDER) {
    if (total <= DOMAIN_PACK_MAX_CHARS) break;
    const idx = kept.findIndex((s) => s.section === section);
    if (idx < 0) continue;
    total -= kept[idx]!.content.length;
    kept = kept.filter((s) => s.section !== section);
    omitted.push(section);
  }
  if (kept.length === 0) {
    return { ok: false, reason: `领域知识超过 ${DOMAIN_PACK_MAX_CHARS} 字上限，整节丢弃后无可携带内容` };
  }
  const projectName = projectNameOf(db, pid);
  const name = clip(opts.name ?? '', DOMAIN_PACK_NAME_MAX) || clip(`${projectName || `项目 ${pid.slice(0, 8)}`} · 领域包`, DOMAIN_PACK_NAME_MAX);
  const description = clip(opts.description ?? '', DOMAIN_PACK_DESC_MAX)
    || `从「${projectName || pid.slice(0, 8)}」派生的可携带领域经验（术语约定 / 验收判据 / 配方样板）`;
  // B3：业务域层（确定性聚类；空 ⇒ 字段缺席，不写空壳）。
  const business = deriveBusinessDomain(collectBusinessInputs(db, pid, entries));
  return {
    ok: true,
    pack: {
      version: DOMAIN_PACK_VERSION,
      name,
      description,
      sections: kept,
      source: { project_id: pid, project_name: projectName },
      derived_at: opts.now ?? new Date().toISOString(),
      training: false,
      omitted_sections: omitted,
      ...(isEmptyBusinessDomain(business) ? {} : { business }),
    },
  };
}

/**
 * 落一份包资产（**不启用**）。返回包 id。`sourceProjectId` 为空串 ⇒ 存 NULL（导入包）。
 * `origin` 缺省 `user`；系统建议的候选必须显式传 `auto_candidate`（承 §2.6：候选**永不自动启用**）。
 */
export function insertDomainPack(
  db: PackDb,
  pack: DomainPackPayload,
  origin: DomainPackOrigin = 'user',
): string {
  const id = newPackId();
  const args = [
    id,
    clip(pack.name, DOMAIN_PACK_NAME_MAX),
    clip(pack.description, DOMAIN_PACK_DESC_MAX),
    JSON.stringify(pack),
    pack.source.project_id ? pack.source.project_id : null,
    pack.source.project_name || '',
  ] as const;
  if (hasOriginColumn(db)) {
    db.prepare(
      `INSERT INTO wa_domain_packs (id, name, description, pack_json, source_project_id, source_project_name, origin, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(...args, origin);
  } else {
    // M6 之前的老表（旧夹具/未迁移库）没有 origin 列：按 `user` 落库。
    //   候选建议只在有该列时成立（见 `ensureAutoCandidateDomainPack`）——宁可没有建议，不改老表形状。
    db.prepare(
      `INSERT INTO wa_domain_packs (id, name, description, pack_json, source_project_id, source_project_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
    ).run(...args);
  }
  return id;
}

/** 该库的 `wa_domain_packs` 是否已有 M6 的 `origin` 列（老库/旧夹具没有）。 */
function hasOriginColumn(db: PackDb): boolean {
  try {
    const cols = db.prepare('PRAGMA table_info(wa_domain_packs)').all() as Array<{ name?: unknown }>;
    return cols.some((c) => String(c?.name ?? '') === 'origin');
  } catch {
    return false;
  }
}

/**
 * 生成并落库（**挂 Pro 闸**）。闸先于任何读写——社区档不派生、不落库。
 */
export function createDomainPack(
  db: PackDb,
  projectId: string,
  opts: { name?: string; description?: string } = {},
): { ok: true; id: string; pack: DomainPackPayload } | { ok: false; code: string; reason: string } {
  const refusal = proFeatureRefusal(db, 'domain_pack');
  if (refusal) return { ok: false, code: 'FEATURE_REQUIRED', reason: refusal };
  const derived = deriveDomainPack(db, projectId, opts);
  if (!derived.ok) return { ok: false, code: 'NO_CONTENT', reason: derived.reason };
  const id = insertDomainPack(db, derived.pack);
  return { ok: true, id, pack: derived.pack };
}

/**
 * 系统建议的候选包（zx_20261030_1 M6）：**只生成/更新，不启用**。
 *
 * 去重键 = **来源项目**：同一项目只留一份候选（不再每次吸收都多一份包）。
 * 用户已「忽略」（`dismissed_at` 非空）⇒ 永远不再重复建议，也**不复活**已忽略行。
 *
 * ⚠ 本函数**不挂 Pro 闸**：它只产出"建议"，真正启用仍走 `applyDomainPack` 的 Pro 闸——
 *   社区档看到建议也装不上，与"闸只挡搬运"同一把尺。
 */
export function ensureAutoCandidateDomainPack(
  db: PackDb,
  projectId: string,
): { id: string; created: boolean } | null {
  const pid = projectId || '';
  if (!pid) return null;
  const derived = deriveDomainPack(db, pid);
  if (!derived.ok) return null;
  const existing = db.prepare(
    `SELECT id, dismissed_at FROM wa_domain_packs
      WHERE source_project_id = ? AND origin = 'auto_candidate'
      ORDER BY created_at, id LIMIT 1`,
  ).get(pid) as { id?: string; dismissed_at?: string | null } | undefined;
  if (existing?.id) {
    // 忽略过就尊重忽略：不刷新、不复活（"拒绝"是用户的表态，不是可以重提的缺口）。
    if (existing.dismissed_at) return null;
    db.prepare(
      `UPDATE wa_domain_packs
          SET name = ?, description = ?, pack_json = ?, updated_at = datetime('now')
        WHERE id = ?`,
    ).run(
      clip(derived.pack.name, DOMAIN_PACK_NAME_MAX),
      clip(derived.pack.description, DOMAIN_PACK_DESC_MAX),
      JSON.stringify(derived.pack),
      existing.id,
    );
    return { id: existing.id, created: false };
  }
  const id = insertDomainPack(db, derived.pack, 'auto_candidate');
  return { id, created: true };
}

/** 预览边界（唯一定处）：最多几节、每节多少字。 */
export const SUGGESTED_PREVIEW_MAX_SECTIONS = 3;
export const SUGGESTED_PREVIEW_SNIPPET_CHARS = 120;

/** 摘要截断：优先在句末/分句标点处收口；找不到合适标点才硬截，并统一加「…」。 */
function previewSnippet(text: string): string {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (t.length <= SUGGESTED_PREVIEW_SNIPPET_CHARS) return t;
  const head = t.slice(0, SUGGESTED_PREVIEW_SNIPPET_CHARS);
  const marks = ['。', '！', '？', '；', '.', '!', '?', ';'];
  let cut = -1;
  for (const m of marks) cut = Math.max(cut, head.lastIndexOf(m));
  const body = cut >= 40 ? head.slice(0, cut + 1) : head;
  return `${body.trim()}…`;
}

/** 内容预览（最多 `SUGGESTED_PREVIEW_MAX_SECTIONS` 节；节名取同一份人话标签）。 */
export function previewDomainPackSections(pack: {
  sections: Array<{ section: DomainPackSection; content: string }>;
}): DomainPackPreviewSection[] {
  return pack.sections.slice(0, SUGGESTED_PREVIEW_MAX_SECTIONS).map((s) => ({
    section: s.section,
    label: DOMAIN_PACK_SECTION_LABEL[s.section] ?? s.section,
    snippet: previewSnippet(s.content),
  }));
}

/**
 * zx_20261113_4 B2「荐」：候选包排序——**有据者先**。
 *   · 相似度高者先；无相似依据（缺席）排后但**不隐藏**；
 *   · 同分按 `updated_at` 降序、`id` 升序（确定性，跨机同序）。
 */
export function rankSuggestedPacks<
  T extends { id: string; updated_at: string; similarity?: DomainPackSimilarity },
>(rows: readonly T[]): T[] {
  return [...rows].sort(
    (a, b) =>
      (b.similarity?.score ?? -1) - (a.similarity?.score ?? -1)
      || String(b.updated_at ?? '').localeCompare(String(a.updated_at ?? ''))
      || String(a.id ?? '').localeCompare(String(b.id ?? '')),
  );
}

/**
 * 给某项目看的候选包：未忽略、未启用、**不是从本项目派生**的 `auto_candidate` 资产。
 * 只展示，不注入；用户点「启用」才走 `applyDomainPack`（Pro 闸）。
 *
 * zx_20261113_4 B2「荐」：每条候选附「与当前项目的相似度 + 为什么像」与内容预览，并按相似度排序。
 *   · 相似度与「相似项目」同一套判据（`scoreProjectPair`），不另造分数；
 *   · 来源项目已归档/无交集/读不到 ⇒ 如实缺席（界面说「无相似依据」），仍可启用，不隐藏。
 */
export function listSuggestedDomainPacks(
  db: PackDb,
  projectId: string,
  limit: number = 5,
): DomainPackListRow[] {
  const pid = projectId || '';
  if (!pid) return [];
  const lim = Math.max(1, Math.floor(Number(limit) || 5));
  const rows = db.prepare(
    `SELECT p.id AS id, p.name AS name, p.description AS description,
            p.source_project_id AS source_project_id, p.source_project_name AS source_project_name,
            p.origin AS origin, p.dismissed_at AS dismissed_at,
            p.created_at AS created_at, p.updated_at AS updated_at, p.pack_json AS pack_json
       FROM wa_domain_packs p
       LEFT JOIN wa_project_domain_packs m ON m.pack_id = p.id AND m.project_id = ?
      WHERE p.origin = 'auto_candidate'
        AND p.dismissed_at IS NULL
        AND m.pack_id IS NULL
        AND (p.source_project_id IS NULL OR p.source_project_id <> ?)
      ORDER BY p.updated_at DESC, p.id
      LIMIT ?`,
  ).all(pid, pid, lim) as Array<DomainPackRow & { pack_json: string }>;
  const mapped: DomainPackListRow[] = rows.map((r) => {
    const pack = parseDomainPackJson(r.pack_json);
    // 相似度只对「有来源项目」的候选有意义；读不到/无交集 ⇒ 缺席（不编 0 分）。
    let similarity: DomainPackSimilarity | undefined;
    if (r.source_project_id) {
      try {
        const sim = scoreProjectPair(
          db as unknown as Parameters<typeof scoreProjectPair>[0],
          pid,
          r.source_project_id,
        );
        if (sim) similarity = { score: sim.score, reasons: sim.reasons };
      } catch { /* 相似度读不到 ⇒ 少一维证据，不影响候选展示 */ }
    }
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      source_project_id: r.source_project_id,
      source_project_name: r.source_project_name,
      origin: r.origin === 'auto_candidate' ? 'auto_candidate' : 'user',
      dismissed_at: r.dismissed_at ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      applied: false,
      section_count: pack?.sections.length ?? 0,
      chars: pack ? pack.sections.reduce((n, s) => n + s.content.length, 0) : 0,
      ...(similarity ? { similarity } : {}),
      ...(pack ? { preview: previewDomainPackSections(pack) } : {}),
    };
  });
  return rankSuggestedPacks(mapped);
}

/** 忽略一条候选（只对 `auto_candidate` 生效；幂等）。返回是否真改了一行。 */
export function dismissAutoCandidateDomainPack(db: WriteDb, packId: string): boolean {
  const r = db.prepare(
    `UPDATE wa_domain_packs SET dismissed_at = datetime('now'), updated_at = datetime('now')
      WHERE id = ? AND origin = 'auto_candidate' AND dismissed_at IS NULL`,
  ).run(packId || '');
  return r.changes > 0;
}

/** 列出包资产（可按项目标出是否已应用）。 */
export function listDomainPacks(db: ReadDb, projectId?: string): DomainPackListRow[] {
  const rows = db.prepare(
    'SELECT id, name, description, source_project_id, source_project_name, origin, dismissed_at, created_at, updated_at, pack_json FROM wa_domain_packs ORDER BY updated_at DESC, id',
  ).all() as Array<DomainPackRow & { pack_json: string }>;
  const applied = new Set<string>();
  if (projectId) {
    const ars = db.prepare('SELECT pack_id FROM wa_project_domain_packs WHERE project_id = ?').all(projectId) as Array<{ pack_id: string }>;
    for (const a of ars) applied.add(a.pack_id);
  }
  return rows.map((r) => {
    const pack = parseDomainPackJson(r.pack_json);
    return {
      id: r.id,
      name: r.name,
      description: r.description,
      source_project_id: r.source_project_id,
      source_project_name: r.source_project_name,
      origin: r.origin === 'auto_candidate' ? 'auto_candidate' : 'user',
      dismissed_at: r.dismissed_at ?? null,
      created_at: r.created_at,
      updated_at: r.updated_at,
      applied: applied.has(r.id),
      section_count: pack?.sections.length ?? 0,
      chars: pack ? pack.sections.reduce((n, s) => n + s.content.length, 0) : 0,
    };
  });
}

/** 单份领域包的可读详情（zx_20261113_5 M3「口」）：整包节内容 + 业务域，供"查看"用。 */
export interface DomainPackDetailSection {
  section: DomainPackSection;
  label: string;
  content: string;
}

export interface DomainPackDetail {
  id: string;
  name: string;
  description: string;
  source_project_name: string;
  version: number;
  derived_at: string;
  sections: DomainPackDetailSection[];
  omitted_sections: DomainPackSection[];
  /** 与 `omitted_sections` 同序的中文节名（renderer 不手抄第二份词表）。 */
  omitted_labels: string[];
  /** v2 可选业务域层；缺席＝该包没有业务概念（不补空壳）。 */
  business?: BusinessDomain;
}

/** 读一份包的详情。包不存在/包体损坏 ⇒ `null`（界面如实说"读不出"，不伪造空包）。 */
export function readDomainPackDetail(db: ReadDb, packId: string): DomainPackDetail | null {
  const id = String(packId ?? '');
  if (!id) return null;
  const row = db.prepare(
    'SELECT id, name, description, source_project_name, pack_json FROM wa_domain_packs WHERE id = ?',
  ).get(id) as
    | { id: string; name: string; description: string; source_project_name: string; pack_json: string }
    | undefined;
  if (!row) return null;
  const pack = parseDomainPackJson(row.pack_json);
  if (!pack) return null;
  return {
    id: row.id,
    name: row.name || pack.name,
    description: row.description || pack.description,
    source_project_name: row.source_project_name || pack.source.project_name,
    version: pack.version,
    derived_at: pack.derived_at,
    sections: pack.sections.map((s) => ({
      section: s.section,
      label: DOMAIN_PACK_SECTION_LABEL[s.section] ?? s.section,
      content: s.content,
    })),
    omitted_sections: pack.omitted_sections,
    omitted_labels: pack.omitted_sections.map((s) => DOMAIN_PACK_SECTION_LABEL[s] ?? s),
    ...(pack.business ? { business: pack.business } : {}),
  };
}

/**
 * 启用一份包（**挂 Pro 闸**）。幂等：已启用 ⇒ `applied:false`（不是错误，是"本来就在"）。
 * 包不存在 ⇒ 如实拒，不建悬空映射。
 */
export function applyDomainPack(
  db: PackDb,
  projectId: string,
  packId: string,
): { applied: boolean; reason?: 'already_applied' | 'no_such_pack' | 'no_such_project'; refusal?: string } {
  if (!projectId) return { applied: false, reason: 'no_such_project' };
  const refusal = proFeatureRefusal(db, 'domain_pack');
  if (refusal) return { applied: false, refusal };
  const exists = db.prepare('SELECT 1 AS ok FROM wa_domain_packs WHERE id = ?').get(packId) as { ok?: number } | undefined;
  if (!exists) return { applied: false, reason: 'no_such_pack' };
  const r = db.prepare(
    'INSERT OR IGNORE INTO wa_project_domain_packs (project_id, pack_id, applied_at) VALUES (?, ?, datetime(\'now\'))',
  ).run(projectId, packId);
  return r.changes > 0 ? { applied: true } : { applied: false, reason: 'already_applied' };
}

/** 取消启用——**永不挂闸**（用户必须随时能撤）。返回是否真删了一行。 */
export function unapplyDomainPack(db: WriteDb, projectId: string, packId: string): boolean {
  const r = db.prepare('DELETE FROM wa_project_domain_packs WHERE project_id = ? AND pack_id = ?').run(projectId, packId);
  return r.changes > 0;
}

/** 读某项目已启用的包（按启用时序；坏 JSON 跳过——不伪造空包）。 */
export function listAppliedDomainPacks(db: ReadDb, projectId: string): AppliedDomainPack[] {
  const rows = db.prepare(
    `SELECT p.id AS id, p.name AS name, p.description AS description, p.pack_json AS pack_json,
            p.source_project_name AS source_project_name, m.applied_at AS applied_at
       FROM wa_project_domain_packs m
       JOIN wa_domain_packs p ON p.id = m.pack_id
      WHERE m.project_id = ?
      ORDER BY m.applied_at, p.id`,
  ).all(projectId || '') as Array<{ id: string; name: string; description: string; pack_json: string; source_project_name: string; applied_at: string }>;
  const out: AppliedDomainPack[] = [];
  for (const r of rows) {
    const pack = parseDomainPackJson(r.pack_json);
    if (!pack || pack.sections.length === 0) continue;
    out.push({
      id: r.id,
      name: r.name,
      description: r.description,
      sections: pack.sections,
      ...(pack.business ? { business: pack.business } : {}),
      source_project_name: r.source_project_name,
      applied_at: r.applied_at,
    });
  }
  return out;
}

/** 领域包的注入账（`source='domain_pack'`）——有写口就必须有读口，否则"记了没人看"。 */
export function domainPackInjectionStats(db: ReadDb, projectId: string): DomainPackStats {
  const agg = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(i.chars), 0) AS chars,
            SUM(CASE WHEN i.outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN i.outcome = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM wa_context_injections i
       JOIN wa_tasks t ON t.id = i.task_id
      WHERE i.source = 'domain_pack' AND t.project_id = ?`,
  ).get(projectId || '') as { n: number; chars: number; completed: number | null; failed: number | null } | undefined;
  const packs = db.prepare(
    `SELECT i.ref_id AS pack_id, COALESCE(p.name, '') AS name, COUNT(*) AS n, COALESCE(SUM(i.chars), 0) AS chars,
            SUM(CASE WHEN i.outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN i.outcome = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM wa_context_injections i
       JOIN wa_tasks t ON t.id = i.task_id
       LEFT JOIN wa_domain_packs p ON p.id = i.ref_id
      WHERE i.source = 'domain_pack' AND t.project_id = ?
      GROUP BY i.ref_id
      ORDER BY n DESC, i.ref_id`,
  ).all(projectId || '') as Array<{ pack_id: string; name: string; n: number; chars: number; completed: number | null; failed: number | null }>;
  return {
    injections: Number(agg?.n ?? 0),
    chars: Number(agg?.chars ?? 0),
    completed: Number(agg?.completed ?? 0),
    failed: Number(agg?.failed ?? 0),
    packs: packs.map((p) => ({
      pack_id: p.pack_id,
      name: p.name,
      injections: Number(p.n ?? 0),
      chars: Number(p.chars ?? 0),
      completed: Number(p.completed ?? 0),
      failed: Number(p.failed ?? 0),
    })),
  };
}

/**
 * 业务域子块渲染（B3 按需注入）：
 *   · **有任务关键词** ⇒ 只留命中条目（术语名/释义/规则/场景任一包含关键词）；全不命中 ⇒ 空块；
 *   · **无关键词**（判不出任务文本）⇒ 全留；
 *   · 逐条整取，超 `tokenBudget` 即止——**不截半句**；一条都放不下 ⇒ 空串（不写空标题）。
 * 关键词匹配用 `extractKeywords`（与知识卡/记忆选择同一把切词尺），不另造分度。
 */
export function renderBusinessBlock(
  business: BusinessDomain | null | undefined,
  keywords: readonly string[] = [],
  tokenBudget: number = BUSINESS_INJECT_MAX_TOKENS,
): string {
  if (!business || isEmptyBusinessDomain(business)) return '';
  const kws = keywords.map((k) => String(k).toLowerCase()).filter((k) => k !== '');
  const hit = (text: string): boolean => kws.length === 0 || kws.some((k) => text.toLowerCase().includes(k));

  const items: string[] = [];
  for (const t of business.terms) {
    const alias = t.aliases.length > 0 ? `（别名：${t.aliases.join('、')}）` : '';
    const meaning = t.meaning ? `：${t.meaning}` : '';
    const text = `${t.term}${alias}${meaning}`;
    if (hit(text)) items.push(`- 术语 ${text}`);
  }
  for (const r of business.rules) {
    if (hit(r.rule)) items.push(`- 规则 ${r.rule}`);
  }
  for (const s of business.scenarios) {
    if (hit(s.scenario)) items.push(`- 场景 ${s.scenario}`);
  }
  if (items.length === 0) return '';

  const header = '### 业务域';
  const lines: string[] = [];
  for (const item of items) {
    const candidate = [header, ...lines, item].join('\n');
    if (estimateTokensFromChars(candidate.length) > tokenBudget) break;
    lines.push(item);
  }
  return lines.length > 0 ? [header, ...lines].join('\n') : '';
}

/** 一个包对当前任务关键词的命中：命中次数 + 命中的节/业务域种类数。 */
function packHit(pack: AppliedDomainPack, keywords: readonly string[]): { hits: number; kinds: number } {
  if (keywords.length === 0) return { hits: 0, kinds: 0 };
  let hits = 0;
  let kinds = 0;
  for (const s of pack.sections) {
    const text = String(s.content ?? '').toLowerCase();
    const n = keywords.filter((k) => text.includes(k)).length;
    if (n > 0) {
      kinds++;
      hits += n;
    }
  }
  const biz = pack.business;
  if (biz) {
    const text = [
      ...biz.terms.flatMap((t) => [t.term, t.meaning, ...t.aliases]),
      ...biz.rules.map((r) => r.rule),
      ...biz.scenarios.map((x) => x.scenario),
    ]
      .join('\n')
      .toLowerCase();
    const n = keywords.filter((k) => text.includes(k)).length;
    if (n > 0) {
      kinds++;
      hits += n;
    }
  }
  return { hits, kinds };
}

/**
 * zx_20261113_4 B3「注」（管子·度量衡 / 维特根斯坦·意义即用法）：**多包注入的排序**——纯函数。
 *
 * 病根：多个已启用包按 `listAppliedDomainPacks` 的顺序**先到先得**，同一份 400 token 预算里
 *   先塞的可能与本任务无关，相关的反而被挤掉。
 *
 * 判据：
 *   · `keywords` 为空（判不出任务文本）⇒ **原序返回**（零行为变化，可回退）；
 *   · 否则按「命中关键词数」降序 → 「命中的节/业务域种类数」降序 → 名称 → id（确定性）；
 *   · **全不命中 ⇒ 原序**（不因排序把顺序重排，也不丢包）。
 * ⚠ 只改顺序，不改整包取舍、不改预算、不截半句。
 */
export function rankDomainPacksForInject(
  packs: readonly AppliedDomainPack[],
  keywords: readonly string[],
): AppliedDomainPack[] {
  const kws = keywords.map((k) => String(k ?? '').toLowerCase()).filter((k) => k !== '');
  if (kws.length === 0 || packs.length <= 1) return [...packs];
  const scored = packs.map((p) => ({ p, ...packHit(p, kws) }));
  if (scored.every((s) => s.hits === 0)) return [...packs];
  // 名称/id 用**码位比较**而不是 localeCompare——后者随 ICU/locale 变，跨机可能不同序。
  const cmp = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  return scored
    .sort(
      (a, b) =>
        b.hits - a.hits
        || b.kinds - a.kinds
        || cmp(a.p.name, b.p.name)
        || cmp(a.p.id, b.p.id),
    )
    .map((s) => s.p);
}

/**
 * 注入段渲染：整包取舍（塞不下整包跳过并**点名**），绝不截字。
 * 返回文本 + 逐包注入行（`ref_id` = 包 id；`chars` = 该包渲染块字数）。
 *
 * B3：给了 `taskText` 时，包内业务域子块按关键词**按需**挑选（≤ `BUSINESS_INJECT_MAX_TOKENS`）；
 *   业务域计入整包成本，整包仍受 `tokenBudget` 约束（本段合计 ≤ 400 token 的既有口径不变）。
 */
export function renderDomainPackSection(
  packs: ReadonlyArray<AppliedDomainPack>,
  tokenBudget: number = DOMAIN_PACK_INJECT_MAX_TOKENS,
  taskText?: string | null,
): { text: string; injections: Array<{ ref_id: string; chars: number }> } {
  const keywords = taskText ? extractKeywords(String(taskText)) : [];
  const blocks: Array<{ ref_id: string; text: string }> = [];
  const skipped: string[] = [];
  let used = 0;
  // zx_20261113_4 B3「注」：有任务文本时按相关性排序；无文本 ⇒ 原序（零行为变化）。
  for (const p of rankDomainPacksForInject(packs, keywords)) {
    const body = p.sections
      .map((s) => `### ${DOMAIN_PACK_SECTION_LABEL[s.section]}\n${s.content}`)
      .join('\n');
    const biz = renderBusinessBlock(p.business, keywords);
    const text = `### 领域包：${p.name}\n${body}${biz ? `\n${biz}` : ''}`;
    const cost = estimateTokensFromChars(text.length);
    if (used + cost > tokenBudget) { skipped.push(p.name); continue; }
    used += cost;
    blocks.push({ ref_id: p.id, text });
  }
  if (blocks.length === 0) return { text: '', injections: [] };
  const note = skipped.length > 0 ? `\n（另有 ${skipped.length} 个领域包未注入：${skipped.join('、')}）` : '';
  return {
    text: `## 领域包\n${blocks.map((b) => b.text).join('\n')}${note}`,
    injections: blocks.map((b) => ({ ref_id: b.ref_id, chars: b.text.length })),
  };
}
