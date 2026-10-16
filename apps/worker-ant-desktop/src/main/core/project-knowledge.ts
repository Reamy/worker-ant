/**
 * zx_20261014_4 批四（维特根斯坦·不要想，要看／道德经·为学日益，为道日损）: **项目域知识册**——
 *   把项目里**已经发生的事实**（四类真源）**派生**成一册结构化、可复现的知识（**零 LLM**）。
 *
 * 病根（K12）：项目知识此前只有 `memory-manager.synthesizeProjectKnowledge` 的**散文 panorama**——
 *   靠 LLM 每轮重综合（花钱、不可复现、越写越长），注入截 800 字且优先级 `low`。知识不从"综合"里来，
 *   从**已发生的事实**里来：产出了什么（交付物）、用到什么关系（三元组）、什么服务被调过（调用账）、
 *   此刻什么在跑（守护/作业）。四样都是**本来就在库里**的，直接读出来即可——不必再让 LLM 复述一遍。
 *
 * ⚠ **零 LLM / 零网络 / 零 electron**：本模块只读库 + 格式化文本 + 写一册 ⇒ rr 可拿内存库**直跑真实现**。
 *   承 `project-knowledge-materials.ts` 的"不另抄 SQL"：三元组/交付物/调用账三样复用其读取真源
 *   （`collectProjectKnowledgeMaterials`），运行面复用 `describeProjectRuntime`——四样各**一个**取数口。
 *   ⚠ 与那份"材料"模块**目标不同，故不合并**：那份是喂给 LLM 综合 panorama 的**输入原料**；
 *     本册是**零 LLM 的最终产物**（落库、供注入）。同一份读取，两个不同的消费者。
 *
 * ⚠ **空则不出节**（承 `formatKnowledgeMaterials`）：源里没有的，不写空壳——"未发生"不假造。
 * ⚠ **一册 = 此刻可派生者**：`upsertProjectKnowledge` 除 upsert 外还**清掉本次不再派生的节**
 *   （源已空 ⇒ 该节如实消失），免得陈旧内容长期冒充"现在的事实"。
 *
 * ⚠ **节词表是**新增枚举值的情形**（承 `feedback_enum_value_sweep_readers`：须穷举**全部**读取谓词，
 *   含第二进程词表落点）：消费侧（`memory-context.ts` 按节选取）与展示侧均须从 `PROJECT_KNOWLEDGE_SECTIONS`
 *   派生，不得手抄第二份。
 *
 * zx_20261014_4 批五（**消费侧：预算内选节**）：本模块另导出 `orderKnowledgeSections` /
 *   `selectKnowledgeForInject`——把"注入哪几节"这**一把尺**也收在此一处（与节词表同处，免得分家）。
 *   ⚠ `KNOWLEDGE_INJECT_MAX_TOKENS` 是**本段自身的上界**，**不是**全局预算的第二份（全局预算仍以
 *     `budgetChars` 参数传入 `buildMemoryContext`）——它只防三元组一多就无界膨胀。
 */
import type Database from 'better-sqlite3';
import { collectProjectKnowledgeMaterials } from './project-knowledge-materials.js';
import { describeProjectRuntime } from './project-runtime-summary.js';
// zx_20261014_4 批五（预算内选节）：节的大小以 **token 唯一口径**折算（`token-estimate.ts` 一处真源），
//   不在本模块另立换算分度——"一个数只能有一个值"。
import { estimateTokensFromChars } from './token-estimate.js';

/** 四节的**唯一定处**（消费/展示一律由此派生；新增一节须穷举全部读取谓词）。 */
export const PROJECT_KNOWLEDGE_SECTIONS = ['entities', 'artifacts', 'services', 'runtime'] as const;
export type ProjectKnowledgeSection = (typeof PROJECT_KNOWLEDGE_SECTIONS)[number];

/** 节的人话名（界面/注入标题共一处真源）。 */
export const PROJECT_KNOWLEDGE_SECTION_LABEL: Record<ProjectKnowledgeSection, string> = {
  entities: '项目关系',
  artifacts: '已产出',
  services: '服务调用账',
  runtime: '运行面',
};

export interface ProjectKnowledgeEntry {
  section: ProjectKnowledgeSection;
  content: string;
  /** 真源出处（"这行从哪来"——人可据此复核，机器可据此判陈旧）。 */
  sourceRef: string;
}

/** 只读库面（`{prepare}` 窄接口）——与 `collectProjectKnowledgeMaterials`/`describeProjectRuntime` 同形。 */
type ReadDb = { prepare(sql: string): { all(...args: unknown[]): unknown } };

/**
 * 行 id。**不用 `node:crypto`**（照 `service-call-ledger.newCallId`）——保持本模块可被更宽的打包面引入。
 */
function newKnowledgeId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID?.() ?? `pk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 从四类真源**派生**某项目的知识册（只读，**零 LLM**）。
 *
 * 四节 → 真源：
 *   · `entities` —— `wa_knowledge_triples` 按 `confidence` top-N（经 `collectProjectKnowledgeMaterials`）
 *   · `artifacts` —— 交付物按类型计数（`countDeliverablesByType`，同上经 materials）
 *   · `services` —— `describeServiceCalls` 聚合（同一处）
 *   · `runtime`  —— `describeProjectRuntime`（守护/作业当前存量）
 *
 * 空库/新项目 ⇒ 四节皆空 ⇒ 返回空数组（"没发生"是如实值，不伪造壳）。
 */
export function deriveProjectKnowledge(db: ReadDb, projectId: string): ProjectKnowledgeEntry[] {
  const pid = projectId || '';
  const m = collectProjectKnowledgeMaterials(db, pid);
  const out: ProjectKnowledgeEntry[] = [];

  if (m.triples.length > 0) {
    out.push({
      section: 'entities',
      content: m.triples.map((t) => `${t.subject} ─[${t.predicate}]→ ${t.object}`).join('\n'),
      sourceRef: 'wa_knowledge_triples',
    });
  }
  if (m.deliverablesByType.length > 0) {
    out.push({
      section: 'artifacts',
      content: m.deliverablesByType.map((d) => `${d.type}:${d.count}`).join(' · '),
      sourceRef: 'wa_deliverables',
    });
  }
  if (m.serviceCalls.total > 0) {
    const sc = m.serviceCalls;
    const lines = [`合计 ${sc.total}（成功 ${sc.ok} / 失败 ${sc.failed}）`];
    for (const k of sc.byKind) lines.push(`${k.kind}: ${k.calls} 次（成 ${k.ok} / 败 ${k.failed}）`);
    out.push({ section: 'services', content: lines.join('\n'), sourceRef: 'wa_service_calls' });
  }
  const rt = describeProjectRuntime(db, pid);
  if (rt.daemons.total > 0 || rt.jobs.total > 0) {
    const lines: string[] = [];
    if (rt.daemons.total > 0) {
      lines.push(`守护 ${rt.daemons.total} 个（${rt.daemons.byStatus.map((s) => `${s.status || '未登记'}:${s.count}`).join(' · ')}）`);
    }
    if (rt.jobs.total > 0) {
      lines.push(`作业 ${rt.jobs.total} 条（${rt.jobs.byStatus.map((s) => `${s.status || '未登记'}:${s.count}`).join(' · ')}）`);
    }
    out.push({ section: 'runtime', content: lines.join('\n'), sourceRef: 'wa_deliverables+wa_jobs' });
  }
  return out;
}

/**
 * 写一册（**幂等**）：按 `(project_id, section)` upsert；并**清掉本次不再派生的节**（源已空 ⇒ 节消失）。
 * 整册替换包在一个事务里（读侧不会读到半册）。返回本次写入的节数。
 *
 * ⚠ 幂等的判据是"**同一份真源、连跑两次 ⇒ 行数不变、内容为最新**"，不是"`updated_at` 不变"——
 *   后者每次都会推进（那是"这册何时刷的"，本就该动）。
 */
export function upsertProjectKnowledge(
  db: Database.Database,
  projectId: string,
  entries: ReadonlyArray<ProjectKnowledgeEntry>,
): number {
  const pid = projectId || '';
  const upsert = db.prepare(
    `INSERT INTO wa_project_knowledge (id, project_id, section, content, source_ref, updated_at)
     VALUES (?, ?, ?, ?, ?, datetime('now'))
     ON CONFLICT(project_id, section) DO UPDATE SET
       content = excluded.content,
       source_ref = excluded.source_ref,
       updated_at = datetime('now')`,
  );
  const keep = entries.map((e) => e.section);
  // 空数组时不得生成 `NOT IN ()`（SQLite 语法错）——无节可留 ⇒ 整册清空（本项目此刻无知识，如实）。
  const prune = keep.length > 0
    ? db.prepare(`DELETE FROM wa_project_knowledge WHERE project_id = ? AND section NOT IN (${keep.map(() => '?').join(',')})`)
    : db.prepare('DELETE FROM wa_project_knowledge WHERE project_id = ?');
  const tx = db.transaction(() => {
    for (const e of entries) upsert.run(newKnowledgeId(), pid, e.section, e.content, e.sourceRef);
    if (keep.length > 0) prune.run(pid, ...keep);
    else prune.run(pid);
  });
  tx();
  return entries.length;
}

/**
 * 读某项目的知识册（只读；消费侧用）。按**词表顺序**归位（缺节即缺，不补空壳）。
 */
export function listProjectKnowledge(db: ReadDb, projectId: string): ProjectKnowledgeEntry[] {
  const rows = db.prepare(
    'SELECT section, content, source_ref FROM wa_project_knowledge WHERE project_id = ?',
  ).all(projectId || '') as Array<{ section: string; content: string; source_ref: string }>;
  const bySection = new Map(rows.map((r) => [r.section, r]));
  return PROJECT_KNOWLEDGE_SECTIONS
    .filter((s) => bySection.has(s))
    .map((s) => {
      const r = bySection.get(s)!;
      return { section: s, content: r.content ?? '', sourceRef: r.source_ref ?? '' };
    });
}

// ══════════════════════════════════════════════════════════════════════════════
// 批五｜消费侧择节（维特根斯坦·意义即使用 / 米勒 7±2：进上下文者宁少勿滥）
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 「项目域知识」段自身的 token 上限（**唯一口径** `estimateTokensFromChars` 折算；装不下**裁节不截字**）。
 * ⚠ 这不是全局记忆预算的第二份——全局预算仍由 `buildMemoryContext` 的 `budgetChars` 参数持有；
 *   本常量只管**这一段的内部体量**（事实册短、结构化，但要防三元组一多就无界）。
 */
export const KNOWLEDGE_INJECT_MAX_TOKENS = 400;

/**
 * 任务形态 → 节序（"哪种活儿先看哪几节"）。`runtime`（此刻什么在跑）与任务内容弱相关，**恒末位**。
 * 未列出的形态（`document`/`configuration`/`conversation`/`null`）取**词表序**——即不因形态而偏私。
 */
const KNOWLEDGE_SHAPE_ORDER: Record<string, readonly ProjectKnowledgeSection[]> = {
  code: ['artifacts', 'services', 'entities'],
  research: ['entities', 'artifacts', 'services'],
  analysis: ['entities', 'artifacts', 'services'],
};

/**
 * 按任务形态把已派生的节**排序**（不增不减，只定先后）：偏好节在前、`runtime` 末位，
 * 未在偏好表内者**按词表序垫后**（新增一节时不必回改本表——缺谁补谁，不静默丢）。
 */
export function orderKnowledgeSections(
  entries: ReadonlyArray<ProjectKnowledgeEntry>,
  archetype: string | null | undefined,
): ProjectKnowledgeEntry[] {
  const bySection = new Map(entries.map((e) => [e.section, e]));
  const preferred = KNOWLEDGE_SHAPE_ORDER[archetype ?? ''] ?? PROJECT_KNOWLEDGE_SECTIONS;
  const out: ProjectKnowledgeEntry[] = [];
  const seen = new Set<ProjectKnowledgeSection>();
  for (const s of [...preferred, 'runtime' as const, ...PROJECT_KNOWLEDGE_SECTIONS]) {
    if (seen.has(s)) continue;
    seen.add(s);
    const e = bySection.get(s);
    if (e) out.push(e);
  }
  return out;
}

/**
 * 预算内选节：按形态序**整节取舍**（装不下就跳过该节，**绝不截字**——保结构完整）。
 * 空册 / 预算 0 ⇒ 空数组（"没得注入"是如实值，不伪造）。
 */
export function selectKnowledgeForInject(
  entries: ReadonlyArray<ProjectKnowledgeEntry>,
  archetype: string | null | undefined,
  tokenBudget: number,
): ProjectKnowledgeEntry[] {
  const out: ProjectKnowledgeEntry[] = [];
  let used = 0;
  for (const e of orderKnowledgeSections(entries, archetype)) {
    const cost = estimateTokensFromChars(e.content.length);
    if (used + cost > tokenBudget) continue;
    out.push(e);
    used += cost;
  }
  return out;
}
