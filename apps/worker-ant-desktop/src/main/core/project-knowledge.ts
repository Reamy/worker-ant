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
import { collectProjectKnowledgeMaterials, type ProjectKnowledgeMaterials } from './project-knowledge-materials.js';
import { describeProjectRuntime } from './project-runtime-summary.js';
// zx_20261017_1 批七（维特根斯坦·意义即使用）: 索引只列**活记忆**——墓碑不冒充可检索的知识。
import { MEM_LIVE_SQL } from './memory-lifecycle.js';
// 失败因由的解析/说人话同引既有真源（`pause-reason.ts` 零 import，可被本模块直接引入）。
import { pauseReasonLabel, recordedPauseReason } from './pause-reason.js';
// 批四：外派计数用「已外派」三键的**唯一判据**（`node-orchestrate.ts` 零 electron，可直引）。
import { isRemoteAssigned } from './node-orchestrate.js';
// zx_20261014_4 批五（预算内选节）：节的大小以 **token 唯一口径**折算（`token-estimate.ts` 一处真源），
//   不在本模块另立换算分度——"一个数只能有一个值"。
import { estimateTokensFromChars } from './token-estimate.js';

/**
 * 九节的**唯一定处**（消费/展示一律由此派生；新增一节须穷举全部读取谓词）。
 *
 * zx_20261017_1 批七：在既有四节之外增 `criteria`（验收判据 + 失败因由摘要）、
 * `recipes`（模板 + 已验证样板）、`index`（交付物/记忆/终态任务的检索索引）——
 * 三节仍**全部从既有行走**（零 LLM、可复现）。`runtime` 保持**词表末位**（"此刻在跑"与任务内容弱相关）。
 *
 * zx_20261018_2 批四（庄子·吾丧我／管子·度量衡）：增 `domain`（项目术语 + 约定 + 知识图谱的
 *   高频实体/谓词）与 `usage`（服务调用成败、设备控制、外派、交付量）——仍是**已发生事实**的派生，
 *   与 `entities`/`services` 的分工是"**一个看关系、一个看频度**""**一个看按类成败、一个看对外动作**"，
 *   不重抄同一行（交付物类型分布仍只在 `artifacts`，`usage` 只计总量）。
 */
export const PROJECT_KNOWLEDGE_SECTIONS = ['entities', 'artifacts', 'services', 'domain', 'usage', 'criteria', 'recipes', 'index', 'runtime'] as const;
export type ProjectKnowledgeSection = (typeof PROJECT_KNOWLEDGE_SECTIONS)[number];

/** 节的人话名（界面/注入标题共一处真源）。 */
export const PROJECT_KNOWLEDGE_SECTION_LABEL: Record<ProjectKnowledgeSection, string> = {
  entities: '项目关系',
  artifacts: '已产出',
  services: '服务调用账',
  domain: '领域与术语',
  usage: '使用实况',
  criteria: '验收与失败',
  recipes: '配方与样板',
  index: '检索索引',
  runtime: '运行面',
};

/** 每节取多少行——上限只此一处（导出/预览/注入同吃一份，免得三处各写一个数）。 */
const CRITERIA_TASK_LIMIT = 10;
const RECIPE_TEMPLATE_LIMIT = 10;
const RECIPE_EXEMPLAR_LIMIT = 5;
const INDEX_DELIVERABLE_LIMIT = 12;
const INDEX_MEMORY_LIMIT = 8;
const INDEX_TASK_LIMIT = 10;
/** 批四：`domain` 的高频榜与约定条数、`usage` 的主要操作条数——上限只此一处。 */
const DOMAIN_ENTITY_LIMIT = 8;
const DOMAIN_PREDICATE_LIMIT = 5;
const DOMAIN_CONVENTION_LIMIT = 8;
const USAGE_OPERATION_LIMIT = 3;
/** 单行内文摘的上限（防止一条超长记忆把整节撑爆；只影响索引/判据的**行内**摘要，不截整节）。 */
const LINE_DIGEST_MAX = 160;

/** 压成一行（换行/连续空白折成单空格），超长加省略号。 */
function oneLine(s: string, max: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

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
 * 九节 → 真源（前四节既有；`criteria`/`recipes`/`index` 为 zx_20261017_1 批七；
 * `domain`/`usage` 为 zx_20261018_2 批四）：
 *   · `entities` —— `wa_knowledge_triples` 按 `confidence` top-N（经 `collectProjectKnowledgeMaterials`）
 *   · `artifacts` —— 交付物按类型计数（`countDeliverablesByType`，同上经 materials）
 *   · `services` —— `describeServiceCalls` 聚合（同一处）
 *   · `domain`   —— `wa_projects.context_json.language_game` + 三元组的**高频实体/谓词**
 *   · `usage`    —— 服务调用成败/主要操作 + 设备控制 + 外派归属 + 交付总量
 *   · `criteria` —— `wa_tasks.acceptance_criteria` + `status='failed'` 的 `context_json.pause_reason`
 *   · `recipes`  —— `wa_task_templates`（active）+ `wa_memories.is_exemplar=1`
 *   · `index`    —— 交付物 / 活记忆 / **终态任务**的检索索引（待办中任务未发生，不入索引）
 *   · `runtime`  —— `describeProjectRuntime`（守护/作业当前存量；恒末位）
 *
 * 空库/新项目 ⇒ 九节皆空 ⇒ 返回空数组（"没发生"是如实值，不伪造壳）。
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

  // ── 批四：领域与术语 / 使用实况（同为已发生事实的派生，零 LLM）──────────────
  const domain = deriveDomainSection(db, pid, m);
  if (domain) out.push(domain);
  const usage = deriveUsageSection(db, pid, m);
  if (usage) out.push(usage);

  // ── 批七：验收判据 + 失败因由摘要（许诺过什么、栽在哪一步）──────────────────
  const criteria = deriveCriteriaSection(db, pid);
  if (criteria) out.push(criteria);

  // ── 批七：配方（全局模板 + 本项目的已验证样板）────────────────────────────
  const recipes = deriveRecipesSection(db, pid);
  if (recipes) out.push(recipes);

  // ── 批七：检索索引（交付物 / 活记忆 / 终态任务）────────────────────────────
  const index = deriveIndexSection(db, pid);
  if (index) out.push(index);

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
 * `domain` 节（批四）：项目**术语/约定**（`wa_projects.context_json.language_game`）+
 * 知识图谱里的**高频实体与谓词**（按出现次数，不是按可信度——那是 `entities` 的尺）。
 *
 * 为什么频度与 `entities` 不重复：`entities` 列**最可信的 N 条关系**（看链条）；
 * `domain` 只回答"这个项目天天在说什么词/什么关系"（看词表）。两者取数谓词与排序都不同。
 * 空（无术语、无约定、无三元组）⇒ null（不出空壳）。
 */
function deriveDomainSection(db: ReadDb, pid: string, m: ProjectKnowledgeMaterials): ProjectKnowledgeEntry | null {
  const lines: string[] = [];

  const projRows = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').all(pid) as
    Array<{ context_json?: string | null }>;
  try {
    const ctx = JSON.parse(projRows[0]?.context_json || '{}') as {
      language_game?: { terminology?: unknown; conventions?: unknown };
    };
    const lg = ctx.language_game ?? {};
    const terms = lg.terminology !== null && typeof lg.terminology === 'object' && !Array.isArray(lg.terminology)
      ? Object.entries(lg.terminology as Record<string, unknown>)
          .filter(([, v]) => typeof v === 'string' && v.trim() !== '')
      : [];
    if (terms.length > 0) {
      lines.push(`术语：${terms.map(([k, v]) => `${k}=${oneLine(String(v), 40)}`).join(' · ')}`);
    }
    const convs = Array.isArray(lg.conventions)
      ? (lg.conventions as unknown[]).filter((c): c is string => typeof c === 'string' && c.trim() !== '')
      : [];
    for (const c of convs.slice(0, DOMAIN_CONVENTION_LIMIT)) lines.push(`约定：${oneLine(c, LINE_DIGEST_MAX)}`);
  } catch { /* 坏 JSON ⇒ 术语/约定如实缺席（不当成假事实，也不整体失败） */ }

  // 频度由共享取数口给（`collectProjectKnowledgeMaterials` 同一模块内读三元组——
  // 本模块不另写第二份取数 SQL；此处只管展示口径：排序与截断）。
  const { entities: ents, predicates: preds } = m.tripleFrequency;
  if (ents.length > 0 || preds.length > 0) {
    const top = (rows: Array<{ name: string; count: number }>, n: number): Array<[string, number]> =>
      rows.map((r) => [r.name, r.count] as [string, number])
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);
    const topEnts = top(ents, DOMAIN_ENTITY_LIMIT);
    const topPreds = top(preds, DOMAIN_PREDICATE_LIMIT);
    if (topEnts.length > 0) lines.push(`高频实体：${topEnts.map(([k, c]) => `${k}×${c}`).join(' · ')}`);
    if (topPreds.length > 0) lines.push(`高频关系：${topPreds.map(([k, c]) => `${k}×${c}`).join(' · ')}`);
  }

  if (lines.length === 0) return null;
  return {
    section: 'domain',
    content: lines.join('\n'),
    sourceRef: 'wa_projects.context_json.language_game+wa_knowledge_triples',
  };
}

/**
 * `usage` 节（批四）：项目**怎么被用的**——服务调用成败、设备控制、外派、交付量。
 *
 * ⚠ 项目归属按既有真源，不猜：
 *   · 服务调用 —— `wa_service_calls.project_id`；
 *   · 设备控制 —— `wa_device_actions.task_id`（面板/外部终端发起行**不带任务** ⇒ 不归任何项目，如实不计）；
 *   · 外派 —— `wa_tasks.context_json` 的「已外派」三键（`isRemoteAssigned`，唯一判据）；
 *   · 交付量 —— 只计总数；**类型分布仍在 `artifacts`**（同一行不抄两遍，免得在同册里占双份预算）。
 *
 * 计划原稿写"`wa_event_log` 的 `node_dispatch` 计数"——事件日志的 `node_dispatch` 聚合
 * **没有 project_id**（派单载荷也不带），无法按项目归属；若强行计数只能给全局数，混进项目册即失真。
 * 故改用任务行上已记下的外派归属（同一事实的项目侧真源）。
 * 空（四样皆无）⇒ null（不出空壳，也不写假 0）。
 */
function deriveUsageSection(db: ReadDb, pid: string, m: ProjectKnowledgeMaterials): ProjectKnowledgeEntry | null {
  const lines: string[] = [];

  const sc = m.serviceCalls;
  if (sc.total > 0) {
    const rate = Math.round((sc.ok / sc.total) * 100);
    lines.push(`服务调用 ${sc.total} 次（成功 ${sc.ok} / 失败 ${sc.failed}，成功率 ${rate}%）`);
    const ops = db.prepare(
      `SELECT operation, COUNT(*) AS cnt FROM wa_service_calls
       WHERE project_id = ? AND TRIM(COALESCE(operation, '')) != ''
       GROUP BY operation ORDER BY cnt DESC, operation ASC LIMIT ?`,
    ).all(pid, USAGE_OPERATION_LIMIT) as Array<{ operation: string; cnt: number }>;
    if (ops.length > 0) lines.push(`主要操作：${ops.map((o) => `${o.operation}×${o.cnt}`).join(' · ')}`);
  }

  const dev = db.prepare(
    `SELECT result, COUNT(*) AS cnt FROM wa_device_actions
     WHERE task_id IN (SELECT id FROM wa_tasks WHERE project_id = ?)
     GROUP BY result`,
  ).all(pid) as Array<{ result: string | null; cnt: number }>;
  if (dev.length > 0) {
    const total = dev.reduce((a, r) => a + (Number(r.cnt) || 0), 0);
    const parts = dev
      .sort((a, b) => (Number(b.cnt) || 0) - (Number(a.cnt) || 0) || String(a.result ?? '').localeCompare(String(b.result ?? '')))
      .map((r) => `${r.result || '未记'}×${r.cnt}`);
    lines.push(`设备控制 ${total} 次（任务发起，含被拒：${parts.join(' · ')}）`);
  }

  const taskCtx = db.prepare('SELECT context_json FROM wa_tasks WHERE project_id = ?').all(pid) as
    Array<{ context_json?: string | null }>;
  const dispatched = taskCtx.filter((r) => isRemoteAssigned(r.context_json)).length;
  if (dispatched > 0) lines.push(`外派他机 ${dispatched} 件`);

  if (m.deliverablesByType.length > 0) {
    const total = m.deliverablesByType.reduce((a, d) => a + d.count, 0);
    lines.push(`交付物 ${total} 件（类型分布见「${PROJECT_KNOWLEDGE_SECTION_LABEL.artifacts}」）`);
  }

  if (lines.length === 0) return null;
  return {
    section: 'usage',
    content: lines.join('\n'),
    sourceRef: 'wa_service_calls+wa_device_actions+wa_tasks.context_json.assigned_request_id+wa_deliverables',
  };
}

/**
 * `criteria` 节：任务**许诺过的验收标准** + 失败因由汇总。
 *
 * 失败因由用 `recordedPauseReason`（`pause-reason.ts` 的唯一解析器）逐行读、在 JS 内按因由计数
 * ——不用 SQL 的 JSON 函数，免得另一份"坏 JSON 怎么办"的口径与既有读点分家。
 * 空（无判据、无失败）⇒ null（不出空壳）。
 */
function deriveCriteriaSection(db: ReadDb, pid: string): ProjectKnowledgeEntry | null {
  const tasks = db.prepare(
    `SELECT title, status, acceptance_criteria FROM wa_tasks
     WHERE project_id = ? AND TRIM(COALESCE(acceptance_criteria, '')) != ''
     ORDER BY rowid DESC LIMIT ?`,
  ).all(pid, CRITERIA_TASK_LIMIT) as Array<{ title: string; status: string; acceptance_criteria: string }>;
  const lines = tasks.map((t) =>
    `- [${t.status}] ${oneLine(t.title, LINE_DIGEST_MAX)}：验收 ${oneLine(t.acceptance_criteria, LINE_DIGEST_MAX * 2)}`);

  const failed = db.prepare(
    `SELECT context_json FROM wa_tasks WHERE project_id = ? AND status = 'failed'`,
  ).all(pid) as Array<{ context_json: string | null }>;
  if (failed.length > 0) {
    const byReason = new Map<string, number>();
    for (const r of failed) {
      const reason = recordedPauseReason(r.context_json);
      byReason.set(reason, (byReason.get(reason) ?? 0) + 1);
    }
    const parts = [...byReason.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, c]) => `${reason ? pauseReasonLabel(reason) : '原因未记录'} ×${c}`);
    lines.push(`失败 ${failed.length} 项：${parts.join(' · ')}`);
  }

  if (lines.length === 0) return null;
  return { section: 'criteria', content: lines.join('\n'), sourceRef: 'wa_tasks+context_json.pause_reason' };
}

/**
 * `recipes` 节：**全局模板**（active）+ 本项目的**已验证样板**（`is_exemplar=1` 的活记忆）。
 * 模板表没有 project_id（既有形态是全局模板库），故不按项目过滤——如实照它的形状读。
 */
function deriveRecipesSection(db: ReadDb, pid: string): ProjectKnowledgeEntry | null {
  const templates = db.prepare(
    `SELECT name, description, category FROM wa_task_templates
     WHERE status = 'active' ORDER BY priority DESC, rowid DESC LIMIT ?`,
  ).all(RECIPE_TEMPLATE_LIMIT) as Array<{ name: string; description: string | null; category: string | null }>;
  const lines = templates.map((t) => {
    const cat = t.category ? `（${oneLine(t.category, 40)}）` : '';
    const desc = oneLine(t.description ?? '', LINE_DIGEST_MAX);
    return `- 模板${cat}：${oneLine(t.name, LINE_DIGEST_MAX)}${desc ? `——${desc}` : ''}`;
  });

  const exemplars = db.prepare(
    `SELECT content FROM wa_memories
     WHERE project_id = ? AND is_exemplar = 1 AND ${MEM_LIVE_SQL}
     ORDER BY rowid DESC LIMIT ?`,
  ).all(pid, RECIPE_EXEMPLAR_LIMIT) as Array<{ content: string }>;
  for (const e of exemplars) lines.push(`- 已验证：${oneLine(e.content, LINE_DIGEST_MAX)}`);

  if (lines.length === 0) return null;
  return { section: 'recipes', content: lines.join('\n'), sourceRef: 'wa_task_templates+wa_memories(is_exemplar)' };
}

/**
 * `index` 节：交付物 / 活记忆 / **终态任务**的检索索引。
 *
 * ⚠ 只列 `completed/failed/archived` 的任务——待办与执行中的任务**尚未发生**，不是可检索的知识
 *   （承本册"知识从已发生的事实里来"）。墓碑记忆同样不进（`MEM_LIVE_SQL`）。
 */
function deriveIndexSection(db: ReadDb, pid: string): ProjectKnowledgeEntry | null {
  const lines: string[] = [];
  const deliverables = db.prepare(
    `SELECT type, status, name FROM wa_deliverables
     WHERE project_id = ? ORDER BY rowid DESC LIMIT ?`,
  ).all(pid, INDEX_DELIVERABLE_LIMIT) as Array<{ type: string; status: string; name: string | null }>;
  for (const d of deliverables) {
    lines.push(`- 交付物[${d.type}/${d.status}] ${oneLine(d.name || '(未命名)', LINE_DIGEST_MAX)}`);
  }

  const memories = db.prepare(
    `SELECT memory_type, content FROM wa_memories
     WHERE project_id = ? AND ${MEM_LIVE_SQL}
     ORDER BY rowid DESC LIMIT ?`,
  ).all(pid, INDEX_MEMORY_LIMIT) as Array<{ memory_type: string; content: string }>;
  for (const m of memories) lines.push(`- 记忆[${m.memory_type}] ${oneLine(m.content, LINE_DIGEST_MAX)}`);

  const tasks = db.prepare(
    `SELECT title, status FROM wa_tasks
     WHERE project_id = ? AND status IN ('completed', 'failed', 'archived')
     ORDER BY rowid DESC LIMIT ?`,
  ).all(pid, INDEX_TASK_LIMIT) as Array<{ title: string; status: string }>;
  for (const t of tasks) lines.push(`- 任务[${t.status}] ${oneLine(t.title, LINE_DIGEST_MAX)}`);

  if (lines.length === 0) return null;
  return { section: 'index', content: lines.join('\n'), sourceRef: 'wa_deliverables+wa_memories+wa_tasks' };
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
 *
 * zx_20261022_3 批七（维特根斯坦·意义即使用）: 本册 = **派生册 ∪ 已导入册**。
 *   · 派生（`wa_project_knowledge`）是 consolidate 从本项目**既有事实**派生的、且每次重派生都会**剪枝**——
 *     故导入的节**绝不能**写进那张表（下一次 consolidate 会被静默清掉），改存 `wa_project_knowledge_imports`；
 *   · 合并只在**读侧一跳**完成：预览/注入/导出/导入比对看到的都是这一本册（"一个概念一个值"）。
 *   · 取舍规则：同一节两边都有 ⇒ `precedence > 0`（replace 模式导入）者胜；否则**派生者胜**
 *     —— 派生是"本项目新发生过的事实"，比合并模式带进来的旧内容新鲜。
 *   ⚠ 导入表由 `database.ts` 的建表段（`CREATE TABLE IF NOT EXISTS`）保证存在；读取侧**不设
 *     缺表兜底**——兜底会让漏建表的 rr 夹具在生产会炸的地方假绿（承 `feedback_rr_fixture_production_order`）。
 */
export function listProjectKnowledge(db: ReadDb, projectId: string): ProjectKnowledgeEntry[] {
  const pid = projectId || '';
  const rows = db.prepare(
    'SELECT section, content, source_ref FROM wa_project_knowledge WHERE project_id = ?',
  ).all(pid) as Array<{ section: string; content: string; source_ref: string }>;

  const derived = new Map(rows.map((r) => [r.section, r]));
  const imported = db.prepare(
    'SELECT section, content, precedence, source_hash FROM wa_project_knowledge_imports WHERE project_id = ?',
  ).all(pid) as Array<{ section: string; content: string; precedence: number; source_hash: string }>;
  const importedBy = new Map(imported.map((r) => [r.section, r]));

  return PROJECT_KNOWLEDGE_SECTIONS
    .filter((s) => derived.has(s) || importedBy.has(s))
    .map((s) => {
      const d = derived.get(s);
      const i = importedBy.get(s);
      if (i && (!d || Number(i.precedence) > 0)) {
        const h = String(i.source_hash ?? '').slice(0, 12);
        return {
          section: s,
          content: i.content ?? '',
          sourceRef: h ? `knowledge_import:${h}` : 'knowledge_import',
        };
      }
      return { section: s, content: d!.content ?? '', sourceRef: d!.source_ref ?? '' };
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
  // zx_20261018_2 批四：code 偏 usage/domain（"这个项目怎么跑起来的"），research/conversation 偏 domain。
  code: ['usage', 'domain', 'artifacts', 'services', 'entities'],
  research: ['domain', 'entities', 'artifacts', 'services'],
  analysis: ['entities', 'artifacts', 'services'],
  conversation: ['domain', 'artifacts', 'entities'],
};

/**
 * 按任务形态把已派生的节**排序**（不增不减，只定先后）：偏好节在前、`runtime` **恒末位**，
 * 未在偏好表内者**按词表序垫后**（新增一节时不必回改本表——缺谁补谁，不静默丢）。
 *
 * zx_20261017_1 批七：`runtime` 从"词表里恰好排在末尾"改为**显式最后**——新节插在它前面后，
 * 原先按"偏好 + runtime + 词表"的拼法会让 `runtime` 落到新节之前，破坏"恒末位"的语义。
 */
export function orderKnowledgeSections(
  entries: ReadonlyArray<ProjectKnowledgeEntry>,
  archetype: string | null | undefined,
): ProjectKnowledgeEntry[] {
  const bySection = new Map(entries.map((e) => [e.section, e]));
  const preferred = (KNOWLEDGE_SHAPE_ORDER[archetype ?? ''] ?? PROJECT_KNOWLEDGE_SECTIONS)
    .filter((s) => s !== 'runtime');
  const rest = PROJECT_KNOWLEDGE_SECTIONS.filter((s) => s !== 'runtime');
  const out: ProjectKnowledgeEntry[] = [];
  const seen = new Set<ProjectKnowledgeSection>();
  for (const s of [...preferred, ...rest, 'runtime' as const]) {
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

/** 预览的一节：段落原文 + 行数 + token 估（`selected` 即**真会被注入**的那几节）。 */
export interface KnowledgePreviewSection {
  section: ProjectKnowledgeSection;
  label: string;
  content: string;
  lines: number;
  tokens: number;
}

export interface ProjectKnowledgePreview {
  /** 与注入同一常量（不是第二份预算）。 */
  budgetTokens: number;
  selected: KnowledgePreviewSection[];
  /** 有内容、但被 400-token 预算挡在门外的节（如实列出，不假装"没有"）。 */
  omitted: KnowledgePreviewSection[];
  /**
   * 词表里有、但本册**没有事实源**因而未产出的节（批四）。
   * 只列节名与人话名，**不伪造空壳内容**——"没有事实"与"有内容但为空"是两件事。
   */
  emptySections: KnowledgeEmptySection[];
}

/** 空节：节名 + 人话名（渲染层不必再引 main 词表，凭载荷即可上屏）。 */
export interface KnowledgeEmptySection {
  section: ProjectKnowledgeSection;
  label: string;
}

/** 非空行数——与渲染层/注入侧看到的"行"同一把尺。 */
function countKnowledgeLines(content: string): number {
  return content.split(/\r?\n/).filter((l) => l.trim().length > 0).length;
}

function previewSection(e: ProjectKnowledgeEntry): KnowledgePreviewSection {
  return {
    section: e.section,
    label: PROJECT_KNOWLEDGE_SECTION_LABEL[e.section],
    content: e.content,
    lines: countKnowledgeLines(e.content),
    tokens: estimateTokensFromChars(e.content.length),
  };
}

/** 知识注入账的统计（zx_20261018_1 批七 R-66）：按 `wa_context_injections` 里的真实行数。 */
export interface KnowledgeInjectionStats {
  injected: number;
  completed: number;
  failed: number;
  pending: number;
}

/**
 * 某项目**知识注入**的成败统计（只读）。
 *
 * 口径：`source='knowledge'` 的注入行按 `task_id` 归到项目；行数是"节·次"——同一任务注入三节就是三行。
 * 结局只有三种（`pending` 未收口 / `completed` / `failed`），由 `backfillInjectionOutcomes` 回填；
 * 未回填的如实记 `pending`，不并入任何一侧。
 */
export function knowledgeInjectionStats(db: ReadDb, projectId: string): KnowledgeInjectionStats {
  const rows = db.prepare(
    `SELECT ci.outcome AS outcome, COUNT(*) AS cnt
       FROM wa_context_injections ci
       JOIN wa_tasks t ON t.id = ci.task_id
      WHERE t.project_id = ? AND ci.source = 'knowledge'
      GROUP BY ci.outcome`,
  ).all(projectId || '') as Array<{ outcome: string | null; cnt: number }>;
  const stats: KnowledgeInjectionStats = { injected: 0, completed: 0, failed: 0, pending: 0 };
  for (const r of rows) {
    const n = Number(r.cnt) || 0;
    stats.injected += n;
    if (r.outcome === 'completed') stats.completed += n;
    else if (r.outcome === 'failed') stats.failed += n;
    else stats.pending += n;
  }
  return stats;
}

/**
 * 项目知识**预览**（zx_20261017_1 批七 R-41）。
 *
 * ⚠ 与注入**同一取数**：读同一本册（`listProjectKnowledge`）、调同一个 `selectKnowledgeForInject`、
 *   吃同一个 `KNOWLEDGE_INJECT_MAX_TOKENS` —— 预览看到的节/行就是注入真会用的节/行
 *   （防"看到的和用的是两套"）。
 */
export function previewProjectKnowledge(
  db: ReadDb,
  projectId: string,
  archetype?: string | null,
): ProjectKnowledgePreview {
  const book = listProjectKnowledge(db, projectId);
  const picked = selectKnowledgeForInject(book, archetype, KNOWLEDGE_INJECT_MAX_TOKENS);
  const pickedSet = new Set<ProjectKnowledgeSection>(picked.map((e) => e.section));
  const present = new Set<ProjectKnowledgeSection>(book.map((e) => e.section));
  return {
    budgetTokens: KNOWLEDGE_INJECT_MAX_TOKENS,
    selected: picked.map(previewSection),
    omitted: orderKnowledgeSections(book.filter((e) => !pickedSet.has(e.section)), archetype).map(previewSection),
    emptySections: PROJECT_KNOWLEDGE_SECTIONS
      .filter((s) => !present.has(s))
      .map((s) => ({ section: s, label: PROJECT_KNOWLEDGE_SECTION_LABEL[s] })),
  };
}
