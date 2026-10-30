/**
 * D2: 任务模板库（从原工蚁 task-templates.ts 移植）。
 * 预置常用任务模板，支持 AI 通过模板快速分解。
 *
 * B1 (2026-09-01): 模板持久化——静态 TASK_TEMPLATES 降级为种子源；
 * 运行时统一从 wa_task_templates 表（status='active'）加载到模板池，支持用户自定义模板。
 */
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

export interface TaskTemplate {
  id: string;
  name: string;
  category: string;
  description: string;
  /** zx_20260913 M3-3: `dependsOn` 为**同批序号**（1-based，指向 subtasks 内其它元素），落库前映射为任务 id。 */
  subtasks: Array<{ title: string; description: string; acceptance_criteria: string; dependsOn?: number[] }>;
  keywords: string[];
  priority?: number;
  match_count?: number;
  source?: string;
  status?: string;
  /** B2: 历史成功率（按 template 聚合 wa_tasks 父任务成败），用于多候选偏好 */
  success_rate?: number;
}

/** D2: 预置任务模板 */
export const TASK_TEMPLATES: Record<string, TaskTemplate> = {
  mcp_deploy: {
    id: 'mcp_deploy',
    name: 'MCP服务部署',
    category: 'deploy',
    description: '部署MCP服务：克隆仓库→安装依赖→启动服务→注册产出物',
    subtasks: [
      { title: '克隆仓库并安装依赖', description: '克隆代码仓库到项目工作目录，安装项目依赖（pip install或npm install等）。确认核心依赖安装成功。', acceptance_criteria: '依赖安装成功，pip list或npm list确认核心包已安装' },
      { title: '启动MCP服务', description: '启动服务进程（使用项目指定的启动方式和端口），确认进程正常运行。', acceptance_criteria: '服务进程存在，端口监听正常' },
      { title: '注册MCP产出物到ANS', description: '创建服务类型产出物，注册到服务注册中心。注册中心会自动发现服务工具并做健康检查。', acceptance_criteria: '产出物status为running或registered' },
    ],
    keywords: ['mcp', '部署', 'deploy', '服务', 'server', '启动', '注册'],
  },
  web_app: {
    id: 'web_app',
    name: 'Web应用搭建',
    category: 'build',
    description: '搭建Web应用：初始化项目→编写代码→测试→部署',
    subtasks: [
      { title: '项目初始化', description: '使用npm init或create-next-app等工具初始化项目结构。安装核心依赖。', acceptance_criteria: '项目目录创建成功，package.json存在，依赖安装完成' },
      { title: '核心功能实现', description: '按照需求编写前端页面和后端API。完成后端路由和数据库模型。', acceptance_criteria: '代码编译无错误，核心功能可用' },
      { title: '测试与注册产出物', description: '运行测试用例，创建UI/A2A产出物，注册到服务注册中心。', acceptance_criteria: '测试通过率>80%，产出物已注册' },
    ],
    keywords: ['web', '应用', 'app', '前端', '后端', 'api', '网站'],
  },
  data_analysis: {
    id: 'data_analysis',
    name: '数据分析',
    category: 'analyze',
    description: '数据分析任务：获取数据→处理分析→生成报告',
    subtasks: [
      { title: '数据获取与清洗', description: '使用search_web或read_file获取数据源，用bash进行数据清洗和格式化。', acceptance_criteria: '原始数据已获取，清洗后格式规范' },
      { title: '数据分析与洞察', description: '执行数据分析，识别趋势、异常、关联关系。生成分析代码或使用统计工具。', acceptance_criteria: '分析结论有数据支撑，包含至少3个关键发现' },
      { title: '生成分析报告', description: '将分析结果写入.md报告文件，创建doc类型产出物并注册。', acceptance_criteria: '报告文件>500B，产出物已注册' },
    ],
    keywords: ['数据', '分析', '统计', '报告', '图表', '趋势'],
  },
  doc_generation: {
    id: 'doc_generation',
    name: '文档生成',
    category: 'document',
    description: '文档生成：收集信息→撰写文档→注册产出物',
    subtasks: [
      { title: '信息收集', description: '读取相关代码文件、配置文件，收集文档所需的技术信息。', acceptance_criteria: '收集到足够的技术信息（至少3个关键文件）' },
      { title: '文档撰写', description: '使用write_file工具撰写README/API文档/使用指南等技术文档。', acceptance_criteria: '文档内容充分(>1KB)，结构完整' },
      { title: '注册产出物', description: '创建doc类型产出物并注册。', acceptance_criteria: '产出物已注册' },
    ],
    keywords: ['文档', 'doc', 'readme', 'api文档', '指南', '说明书'],
  },
  // ===== zx_20261005 M15：开发者示例任务库（开箱即用 5 例）=====
  //   面向"上手第一跳"（M14 安装向导的第 4 步"跑出第一个成果"）与 TemplatesPage 开箱可见：
  //   这五例覆盖日常开发者最常见的重复劳动，用户不必先想"我能让它干什么"。
  //   与上面 4 例同形（source='system'，可编辑/禁用、不可删）。
  weekly_report: {
    id: 'weekly_report',
    name: '周报生成',
    category: 'document',
    description: '汇总本周任务与成果 → 生成周报 → 存档产出物',
    subtasks: [
      { title: '收集本周任务与成果', description: '读取本项目的任务列表与产出物，筛选出本周（最近 7 天）completed 的任务及其成果摘要。', acceptance_criteria: '收集到本周至少 1 条已完成任务及成果摘要' },
      { title: '撰写周报', description: '按「本周完成 / 进行中 / 风险与阻塞 / 下周计划」四段结构撰写 Markdown 周报，内容须来自上一步真实收集的数据。', acceptance_criteria: '周报四段齐全，每条结论可追溯到具体任务' },
      { title: '注册周报产出物', description: '将周报写入 .md 文件并创建 doc 类型产出物注册。', acceptance_criteria: '产出物已注册且文件 >500B' },
    ],
    keywords: ['周报', 'weekly', '汇报', '总结', '本周', 'report'],
  },
  todo_scan: {
    id: 'todo_scan',
    name: 'TODO 扫描',
    category: 'analyze',
    description: '扫描源码 TODO/FIXME → 分类归档 → 生成待办清单',
    subtasks: [
      { title: '扫描代码注释标记', description: '在工作目录内检索 TODO / FIXME / HACK / XXX 注释标记，记录文件路径、行号与原文。', acceptance_criteria: '列出所有命中项（文件:行号 + 原文），无遗漏扫描目录' },
      { title: '分类与优先级归档', description: '按类型（bug风险/技术债/待实现）与所在模块分组，标出其中涉及安全或数据丢失风险的项。', acceptance_criteria: '每项均有分类，高风险项单独标出并说明理由' },
      { title: '生成待办清单', description: '输出 Markdown 清单（按优先级排序）并注册 doc 产出物。', acceptance_criteria: '清单条目数＝扫描命中数，产出物已注册' },
    ],
    keywords: ['todo', 'fixme', '待办', '扫描', '代码', '技术债'],
  },
  batch_rename: {
    id: 'batch_rename',
    name: '批量文件改名',
    category: 'code',
    description: '枚举目标文件 → 按规则批量改名 → 校验结果',
    subtasks: [
      { title: '枚举并预览改名映射', description: '按用户给定规则枚举目标文件，先输出「原名 → 新名」完整映射表供确认；存在冲突（重名/覆盖）时停下并如实报告。', acceptance_criteria: '映射表完整，冲突项为 0 或已显式列出' },
      { title: '执行批量改名', description: '按上一步映射表逐个改名（用 bash/脚本），不覆盖已有文件。', acceptance_criteria: '改名后文件数不变，无文件丢失' },
      { title: '校验改名结果', description: '重新枚举目录，核对每个新名存在、每个旧名不存在，输出校验结论。', acceptance_criteria: '校验通过：新名全在、旧名全无' },
    ],
    keywords: ['批量', '改名', 'rename', '重命名', '文件', 'batch'],
  },
  scheduled_inspection: {
    id: 'scheduled_inspection',
    name: '定时巡检',
    category: 'monitor',
    description: '采集运行状态 → 比对阈值 → 生成巡检报告（可挂项目定时）',
    subtasks: [
      { title: '采集运行状态', description: '采集目标服务的存活、端口监听、资源占用与近期错误日志等指标。', acceptance_criteria: '每项指标有实测值（非"大概正常"这类无据结论）' },
      { title: '比对阈值', description: '将实测值与预设阈值比对，逐项判定 正常/告警，告警项给出具体数值与阈值。', acceptance_criteria: '每项均有明确判定，告警项含实测值 vs 阈值' },
      { title: '生成巡检报告', description: '输出巡检报告（含各项实测值、判定与建议）并注册 doc 产出物。', acceptance_criteria: '报告覆盖全部采集项，产出物已注册' },
    ],
    keywords: ['巡检', '定时', '监控', '健康检查', '状态', 'inspection'],
  },
  release_notes: {
    id: 'release_notes',
    name: 'Release Notes 生成',
    category: 'document',
    description: '取提交历史 → 归类整理 → 生成发布说明',
    subtasks: [
      { title: '读取提交历史', description: '用 git log 读取自上一发布以来的提交记录（含作者与提交信息），确定版本区间。', acceptance_criteria: '取到提交列表且版本区间明确' },
      { title: '归类整理变更', description: '按「新功能 / 修复 / 优化 / 破坏性变更」归类提交，合并同类项，剔除噪声提交（如纯格式）。', acceptance_criteria: '每条变更归入某一类，破坏性变更已显式标注' },
      { title: '生成发布说明', description: '输出 Markdown 发布说明（含版本号、日期、分类条目）并注册 doc 产出物。', acceptance_criteria: '发布说明四类结构在册，产出物已注册' },
    ],
    keywords: ['release', 'notes', '发布', '变更', '版本', 'changelog'],
  },
};

// ==================== B1 (2026-09-01) 模板持久化：DB 模板池 ====================

/** 运行时模板池（DB 加载 status='active'；表缺失回退内置常量） */
let templatePool: TaskTemplate[] = [];
function ensurePool(db: Database.Database): TaskTemplate[] {
  if (templatePool.length > 0) return templatePool;
  try {
    // B2: 聚合历史成功率（按模板聚合父任务成败；context_json 含 "template":"<id>"）
    const rows = db.prepare(`
      SELECT t.id, t.name, t.category, t.description, t.subtasks, t.keywords, t.priority, t.match_count, t.source,
        (SELECT CASE WHEN COUNT(*) = 0 THEN NULL ELSE ROUND(1.0 * SUM(CASE WHEN wt.status = 'completed' THEN 1 ELSE 0 END) / COUNT(*), 4) END
         FROM wa_tasks wt
         WHERE wt.parent_task_id = '' AND wt.status IN ('completed','failed')
           AND wt.context_json LIKE '%"template":"' || t.id || '"%') as success_rate
      FROM wa_task_templates t
      WHERE t.status = 'active'
    `).all() as Array<{ id: string; name: string; category: string; description: string; subtasks: string; keywords: string; priority: number; match_count: number; source: string; success_rate: number | null }>;
    templatePool = rows.map(r => ({
      id: r.id,
      name: r.name,
      category: r.category,
      description: r.description,
      subtasks: JSON.parse(r.subtasks) as TaskTemplate['subtasks'],
      keywords: JSON.parse(r.keywords) as string[],
      priority: r.priority,
      match_count: r.match_count,
      source: r.source,
      success_rate: r.success_rate ?? undefined,
    }));
  } catch {
    templatePool = Object.values(TASK_TEMPLATES);
  }
  return templatePool;
}

/** 强制重载模板池（模板增改删后调用） */
export function loadTemplatePool(db: Database.Database): TaskTemplate[] {
  templatePool = [];
  return ensurePool(db);
}

/** 当前模板池（仅 active） */
export function getTemplatePool(): TaskTemplate[] { return templatePool; }

/**
 * D2: 规划/优化意图判定 —— 此类任务应交由 AI Agent 自主规划，而非套用固定模板拆解。
 * 刻意排除「分析/报告/文档/数据」等模板关键词，避免破坏 data_analysis/doc_generation 模板匹配。
 * zx_20260924 缺陷C: 本函数本身不带输入面，喂什么它就判什么；**喂它什么由 `decideTemplateMatch` 定**
 * （现为「标题 + 描述」全文——此前只喂标题，描述里的"规划/排期/方案"整段落空）。
 */
export function isPlanningOrOptimizationIntent(text: string): boolean {
  return /(优化|升级|规划|方案|排期|调研|评估|设计|梳理|撰写|总结|审计|盘点)/.test(text);
}

/**
 * zx_20261028_2 M4（「先诊断，后施工」）：修复/排查意图判定——此类任务的第一步是**定位**，
 *   套用「实现/部署」型模板会把"先查清"跳过去，直接拆成施工步骤（真库标本：「初始化数据库脚本问题修复」
 *   被拆成建表/写脚本/跑迁移，却没有一步是"复现并定位"）。
 *   **只跳过模板拆解**；LLM 自主拆解不受影响（`engine.plan_auto_decompose` 那条腿照旧）。
 */
export function isRepairOrDiagnosisIntent(text: string): boolean {
  return /(修复|修正|排查|定位|调试|报错|故障|失效|不生效|异常)/.test(text);
}

/** 失效模板集合（consolidate-templates 作业标记，成功率过低则失效——为道日损） */
const invalidTemplateIds = new Set<string>();

/**
 * 标记模板失效（成功率过低，不再参与匹配）。
 * B3 (2026-09-03): auto 模板由「仅内存失效」升级为「持久化 status=disabled」，
 * 避免重启后复活（扬弃：内存否定 → 持久否定）；loadTemplatePool 只加载 active 天然排除。
 */
export function markTemplateInvalid(db: Database.Database, id: string): void {
  invalidTemplateIds.add(id);
  try {
    db.prepare("UPDATE wa_task_templates SET status = 'disabled', updated_at = datetime('now') WHERE id = ? AND source = 'auto'").run(id);
  } catch { /* DB 无该行（内置种子）则仅内存失效 */ }
}
/** 模板是否失效 */
export function isTemplateInvalid(id: string): boolean { return invalidTemplateIds.has(id); }

/** 关键词命中的门槛：标题 ≥2（原 D2 口径）、描述 ≥3
 *  （描述更长、顺带撞词概率更高，故门槛抬高一档——"标题严、描述宽但更严于标题"） */
export const TITLE_MIN_HITS = 2;
export const DESC_MIN_HITS = 3;

export interface TemplateHit {
  template: TaskTemplate;
  /** 命中关键词（取自**真正命中的那一侧**文本，不是两侧并集） */
  hitKeywords: string[];
  /** 命中来自哪一侧（界面据此说明"为什么命中"） */
  field: 'title' | 'description';
}

/** 该不该拆（守卫原因）；非 null 即不拆 */
export type TemplateSkip = 'explicit_subtasks' | 'planning_intent' | 'repair_intent';

/** 语义兜底喂给 embedding 的文本上限（标题+描述合取后截断——过长会稀释相似度，单一真源） */
export const TEMPLATE_SEMANTIC_TEXT_MAX = 500;

/** 语义兜底的最低余弦相似度（单一真源：低于它不算命中；原散在 `matchTemplateSemantic` 里的 0.4 已收于此） */
export const TEMPLATE_SEMANTIC_MIN_SIMILARITY = 0.6;

export interface TemplateDecision {
  skip: TemplateSkip | null;
  /** 即便 `skip` 非空也会给出"本可命中谁"——界面据此说明"为什么没拆"（诊断不许只剩一句"没命中"） */
  hit: TemplateHit | null;
  /** 关键词未命中时，语义兜底该喂哪段文本（**标题+描述同取**截 500 字——旧 `title || desc` 会整段丢掉描述） */
  semanticText: string;
}

/** B2: 单侧取最优模板——命中数降序 → priority 降序 → 历史 success_rate 降序（跳过已失效模板） */
function bestTemplateBy(pool: TaskTemplate[], score: (tpl: TaskTemplate) => number, minHits: number): TaskTemplate | null {
  let best: TaskTemplate | null = null;
  let bestHits = 0;
  for (const tpl of pool) {
    if (invalidTemplateIds.has(tpl.id)) continue;
    const hits = score(tpl);
    if (hits < minHits) continue;
    if (!best || hits > bestHits) { best = tpl; bestHits = hits; continue; }
    if (hits === bestHits) {
      const bp = best.priority ?? 0, tp = tpl.priority ?? 0;
      if (tp > bp) { best = tpl; continue; }
      if (tp === bp && (tpl.success_rate ?? 0) > (best.success_rate ?? 0)) best = tpl;
    }
  }
  return best;
}

/** 在**指定文本**里按关键词找模板（命中 ≥ minHits），连同命中的那几个词一起返回 */
function pickIn(pool: TaskTemplate[], text: string, minHits: number): { template: TaskTemplate; hitKeywords: string[] } | null {
  const lower = (text || '').toLowerCase();
  const hitsOf = (tpl: TaskTemplate): number => tpl.keywords.filter(kw => lower.includes(kw)).length;
  const template = bestTemplateBy(pool, hitsOf, minHits);
  if (!template) return null;
  return { template, hitKeywords: template.keywords.filter(kw => lower.includes(kw)) };
}

/**
 * 任务文本 → 模板匹配（**唯一**判据处：`task:create` 与 `template:test` 都调这里，不许各自再抄一套）。
 *
 * D2/B2 原口径：需命中 ≥2 个关键词（过滤长描述里顺带提到单个词的误配）；多候选偏好——命中数多者优先。
 *
 * zx_20260924 缺陷C（用户报「模板识别匹配须容得下不规范输入」）：原判据喂的是
 * `matchText = 标题 || 描述前100字` —— **只要标题非空，描述就一个字都不参与匹配**。
 * 「某项目前端所需API接口识别」正是这么被拆错的：标题里的 `前端`+`api` 命中 web_app(2)，
 * 而描述里白纸黑字的「形成…规划排期方案…写入 plans/backend/20260924.md」从未被读过。
 * 现改为**两侧都参与**：标题 ≥2（原样保留），或 描述 ≥3（描述更长、撞词更易，故门槛抬高）。
 */
export function matchTaskTemplate(db: Database.Database, title: string, description: string): TemplateHit | null {
  const pool = ensurePool(db);
  const byTitle = pickIn(pool, title || '', TITLE_MIN_HITS);
  if (byTitle) return { ...byTitle, field: 'title' };
  const byDesc = pickIn(pool, description || '', DESC_MIN_HITS);
  if (byDesc) return { ...byDesc, field: 'description' };
  return null;
}

/**
 * 建任务前 / 模板测试的**完整**判据：先问该不该拆，再问命中谁。
 *
 * zx_20260924 缺陷C 的第二半：守卫此前只扫 `标题 || 描述前100字`，而 `hasExplicitSubtasks` 扫全文，
 * 两者一宽一窄；`template:test` 更干脆连守卫都没有、却挂着「与任务创建同口径」的牌子。
 * 现在三者同面——守卫扫 `标题 + 描述` 全文（规划/优化意图写在**描述里**也算），匹配走
 * `matchTaskTemplate`，模板测试走本函数。
 */
export function decideTemplateMatch(db: Database.Database, title: string, description: string): TemplateDecision {
  const titleText = (title || '').trim();
  const descText = (description || '').trim();
  const fullText = `${titleText} ${descText}`;
  // zx_20261028_2 M4：两侧**同取**——旧式 `titleText || descText.slice(0,100)` 在标题非空时
  //   让描述整段不参与语义兜底（与 zx_20260924 缺陷C 同一病根，那次只修了关键词腿）。
  const semanticText = [titleText, descText].filter(Boolean).join('\n').slice(0, TEMPLATE_SEMANTIC_TEXT_MAX);
  const hit = matchTaskTemplate(db, titleText, descText);
  if (/子任务|报告\s*[A-Za-z]/.test(fullText)) return { skip: 'explicit_subtasks', hit, semanticText };
  // 修复/排查意图**先于**规划意图判：一段文字既含"修复"又含"方案"时，真相是"先定位再给方案"，
  //   报成 planning_intent 会让用户以为该交给 AI 做规划。两者都属"不套模板"，仅文案不同。
  if (isRepairOrDiagnosisIntent(fullText)) return { skip: 'repair_intent', hit, semanticText };
  if (isPlanningOrOptimizationIntent(fullText)) return { skip: 'planning_intent', hit, semanticText };
  return { skip: null, hit, semanticText };
}

// ==================== A1 (2026-08-31) 模板语义匹配 ====================

/** 余弦相似度（内联，避免依赖 MemoryManager 私有方法） */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! ** 2;
    normB += b[i]! ** 2;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 模板 embedding 缓存（首次生成后复用，避免每次任务创建重新调 embedding 模型） */
const templateEmbeddingCache = new Map<string, number[]>();

/** 预生成/获取所有模板（DB 池）description 的 embedding（传入 embedText 函数） */
export async function getTemplateEmbeddings(db: Database.Database, embedText: (text: string) => Promise<number[] | null>): Promise<Map<string, number[]>> {
  for (const tpl of ensurePool(db)) {
    if (!templateEmbeddingCache.has(tpl.id)) {
      try {
        const emb = await embedText(tpl.description);
        if (emb && emb.length > 0) templateEmbeddingCache.set(tpl.id, emb);
      } catch { /* 单个模板 embedding 失败不阻断 */ }
    }
  }
  return templateEmbeddingCache;
}

/** 失效模板 embedding 缓存（模板描述变更/删除后调用；不传 id 清空全部） */
export function invalidateTemplateEmbedding(id?: string): void {
  if (id) templateEmbeddingCache.delete(id);
  else templateEmbeddingCache.clear();
}

/** 语义匹配：任务文本 embedding vs 模板 description embedding，返回相似度最高的模板（> 阈值）
 *  A2: 相似度接近（≤0.02）时按历史成功率偏好（知人者智——优先选中成功率高的），无历史数据行为不变 */
export function matchTemplateSemantic(textEmb: number[], templateEmbs: Map<string, number[]>): { template: TaskTemplate; similarity: number } | null {
  let best: { template: TaskTemplate; similarity: number } | null = null;
  for (const tpl of templatePool) {
    if (invalidTemplateIds.has(tpl.id)) continue;
    const tEmb = templateEmbs.get(tpl.id);
    if (!tEmb) continue;
    const sim = cosineSimilarity(textEmb, tEmb);
    if (sim < TEMPLATE_SEMANTIC_MIN_SIMILARITY) continue;
    if (!best) { best = { template: tpl, similarity: sim }; continue; }
    if (sim - best.similarity > 0.02) { best = { template: tpl, similarity: sim }; continue; }
    // 相似度接近：按历史成功率偏好
    if (Math.abs(sim - best.similarity) <= 0.02 && (tpl.success_rate ?? 0) > (best.template.success_rate ?? 0)) {
      best = { template: tpl, similarity: sim };
    }
  }
  return best;
}

// ==================== B1 (2026-09-02) 成功拆解自动生成模板 ====================

/** 启发式关键词提炼：从文本提取中文 bigram + 英文/技术词（过滤停用词/噪声），供自动模板匹配 */
function deriveTemplateKeywords(...texts: string[]): string[] {
  const stop = new Set(['的', '了', '在', '是', '和', '与', '及', '或', '一个', '这个', '那个', '我们', '进行', '需要', '可以', '以及', '通过', '使用', '根据', '任务', '项目', '文件', '内容', '实现', '完成', '处理', '请', '相关', '应该', '如果', '用', '到', '对', '把', '给', '并', '要', '让', '做']);
  const stopChars = new Set(['的', '了', '在', '是', '和', '与', '及', '或', '吗', '呢', '啊', '吧', '呀', '这', '那', '个', '些', '也', '都', '就', '还', '而', '且', '但', '若', '则', '请', '给', '让', '被', '把', '并', '要', '用', '到', '对']);
  const out: string[] = [];
  for (const text of texts) {
    const words = (text || '').toLowerCase().split(/[\s,，。、；：！？\n()（）:：/\[\]【】\-_.]+/).filter(w => w.length > 1 && !stop.has(w));
    const runs = (text || '').match(/[一-鿿]{2,}/g) || [];
    const bigrams: string[] = [];
    for (const run of runs) {
      for (let i = 0; i < run.length - 1; i++) {
        const bg = run.slice(i, i + 1 + 1);
        if (bg.length === 2 && ![...bg].some(c => stopChars.has(c)) && !stop.has(bg)) bigrams.push(bg);
      }
    }
    out.push(...words, ...bigrams);
  }
  return [...new Set(out.filter(k => !/^\d+$/.test(k)))].slice(0, 12);
}

// ==================== M10 (zx_20261002) 成功拆解质量门台账 ====================
//
// 病根（本轮实测）：这条流水线**接线了却零发生**，而且零得**无声**——
//   三条 `continue` + 一个 `catch { return 0 }` 全是静默出口；真库 `auto_decomposed` 恰 0 行
//   （M5/M6 之前三条拆解路在生产里一次都没走到底）⇒ 恒 0 却无人知道**卡在上游**，
//   也没人知道"有组时会被哪一条门卡住"。故把判定过程**原样**抽成一处，另开一个**只读**台账面。
//
// 纪律：质量门**一字不放宽**（样本≥3 / 成功率≥0.5 是防噪声模板的闸，见 M10 约束）。

/** 「成功拆解候选父任务」的公共过滤（终态口径由各查询自定）—— 3 类 LIKE 判据**一处真源**。 */
const AUTO_TEMPLATE_FILTER = `context_json LIKE '%"auto_decomposed":true%'
        AND context_json NOT LIKE '%"template":"mcp_deploy"%'
        AND context_json NOT LIKE '%"template":"web_app"%'
        AND context_json NOT LIKE '%"template":"data_analysis"%'
        AND context_json NOT LIKE '%"template":"doc_generation"%'`;

/** 逐组质量门判定结果（**一处实现**：生成与台账共用同一次评估）。 */
export type AutoTemplateGateVerdict =
  | 'passed'               // 过全部门（生成模式下即已写入）
  | 'no-archetype'         // context_json 无 $.archetype，无从分组
  | 'insufficient-samples' // 样本 < 3
  | 'low-success-rate'     // 成功率 < 0.5
  | 'duplicate-exists'     // 该 archetype 已有 auto 模板
  | 'no-representative'    // 找不到代表父任务
  | 'too-few-children'     // 代表任务子任务 < 2
  | 'no-keywords';         // 关键词提炼为空

export interface AutoTemplateGateRow {
  archetype: string | null;
  total: number;
  success: number;
  rate: number;
  verdict: AutoTemplateGateVerdict;
}

/** 漏斗逐级计数 —— 回答"卡在哪一级"，**含上游**（真库现状：无自动拆解任务）。 */
export interface AutoTemplateFunnel {
  parentTasks: number;    // 父任务（parent_task_id=''）
  autoDecomposed: number; // 其中标了 auto_decomposed
  terminal: number;       // 其中已终态（completed/failed）
  candidates: number;     // 其中排除 4 个内置模板后仍是候选
  groups: number;         // 按 archetype 分组后的组数
}

export interface AutoTemplateReport {
  funnel: AutoTemplateFunnel;
  /** 漏斗首次见零的那一级（全非零则 null）——直接回答"卡在哪一条"。 */
  blockedAt: 'parent-tasks' | 'auto-decomposed' | 'terminal' | 'candidates' | 'groups' | null;
  gates: AutoTemplateGateRow[];
  /** 本次真写入数；`describeAutoTemplateGates` 只读，恒 0。 */
  created: number;
}

interface EvaluatedGroup extends AutoTemplateGateRow {
  rep?: { id: string; title: string; description: string };
  children?: Array<{ id: string; title: string; description: string | null; acceptance_criteria: string | null; depends_on: string | null }>;
  keywords?: string[];
}

/** 质量门评估（**只读**）：漏斗计数 + 逐组判定 + 组内所需的代表/子任务/关键词（供生成路复用）。 */
function evaluateAutoTemplateGates(db: Database.Database): { funnel: AutoTemplateFunnel; groups: EvaluatedGroup[] } {
  const one = (sql: string): number => (db.prepare(sql).get() as { c: number }).c;
  const funnel: AutoTemplateFunnel = {
    parentTasks: one("SELECT COUNT(*) c FROM wa_tasks WHERE parent_task_id = ''"),
    autoDecomposed: one(`SELECT COUNT(*) c FROM wa_tasks WHERE parent_task_id = '' AND context_json LIKE '%"auto_decomposed":true%'`),
    terminal: one(`SELECT COUNT(*) c FROM wa_tasks WHERE parent_task_id = '' AND context_json LIKE '%"auto_decomposed":true%' AND status IN ('completed','failed')`),
    candidates: one(`SELECT COUNT(*) c FROM wa_tasks WHERE parent_task_id = '' AND status IN ('completed','failed') AND ${AUTO_TEMPLATE_FILTER}`),
    groups: 0,
  };
  const stats = db.prepare(`
    SELECT json_extract(context_json, '$.archetype') as archetype,
           COUNT(*) as total,
           SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as success
    FROM wa_tasks
    WHERE parent_task_id = '' AND status IN ('completed','failed') AND ${AUTO_TEMPLATE_FILTER}
    GROUP BY json_extract(context_json, '$.archetype')
  `).all() as Array<{ archetype: string | null; total: number; success: number }>;
  funnel.groups = stats.length;

  const groups: EvaluatedGroup[] = [];
  for (const s of stats) {
    const rate = s.total > 0 ? s.success / s.total : 0;
    const row: EvaluatedGroup = { archetype: s.archetype, total: s.total, success: s.success, rate, verdict: 'passed' };
    if (!s.archetype) { row.verdict = 'no-archetype'; groups.push(row); continue; }
    if (s.total < 3) { row.verdict = 'insufficient-samples'; groups.push(row); continue; }
    if (rate < 0.5) { row.verdict = 'low-success-rate'; groups.push(row); continue; }
    const dup = db.prepare("SELECT COUNT(*) as c FROM wa_task_templates WHERE source = 'auto' AND category = ?").get(s.archetype) as { c: number };
    if ((dup?.c ?? 0) > 0) { row.verdict = 'duplicate-exists'; groups.push(row); continue; }
    // 代表任务口径**照旧**：只取 `completed`（生成路原样），与统计口径（completed∪failed）**刻意不同**。
    const rep = db.prepare(`
      SELECT id, title, description FROM wa_tasks
      WHERE parent_task_id = '' AND status = 'completed' AND ${AUTO_TEMPLATE_FILTER}
        AND json_extract(context_json, '$.archetype') = ?
      ORDER BY updated_at DESC LIMIT 1
    `).get(s.archetype) as { id: string; title: string; description: string } | undefined;
    if (!rep) { row.verdict = 'no-representative'; groups.push(row); continue; }
    const children = db.prepare(
      'SELECT id, title, description, acceptance_criteria, depends_on FROM wa_tasks WHERE parent_task_id = ? ORDER BY COALESCE(priority, 99), created_at ASC'
    ).all(rep.id) as Array<{ id: string; title: string; description: string | null; acceptance_criteria: string | null; depends_on: string | null }>;
    if (children.length < 2) { row.verdict = 'too-few-children'; row.rep = rep; groups.push(row); continue; }
    const keywords = deriveTemplateKeywords(s.archetype, rep.title, rep.description);
    if (keywords.length === 0) { row.verdict = 'no-keywords'; row.rep = rep; groups.push(row); continue; }
    row.rep = rep; row.children = children; row.keywords = keywords;
    groups.push(row);
  }
  return { funnel, groups };
}

function firstBlockedStep(f: AutoTemplateFunnel): AutoTemplateReport['blockedAt'] {
  if (f.parentTasks === 0) return 'parent-tasks';
  if (f.autoDecomposed === 0) return 'auto-decomposed';
  if (f.terminal === 0) return 'terminal';
  if (f.candidates === 0) return 'candidates';
  if (f.groups === 0) return 'groups';
  return null;
}

/** M10 台账（**只读**，供界面/日志回答"自动模板为何为 0、卡在哪一级"）。 */
export function describeAutoTemplateGates(db: Database.Database): AutoTemplateReport {
  const { funnel, groups } = evaluateAutoTemplateGates(db);
  return {
    funnel,
    blockedAt: firstBlockedStep(funnel),
    gates: groups.map(g => ({ archetype: g.archetype, total: g.total, success: g.success, rate: g.rate, verdict: g.verdict })),
    created: 0,
  };
}

/** B1 (2026-09-02): 成功拆解自动生成模板（毛选实践论·第二次飞跃 + 质量门）。
 * 统计 completed∪failed 的 auto_decomposed 非预置父任务，按 archetype 分组；
 * 质量门：样本≥3 且成功率≥0.5 才生成（为道日损——样本不足/低成功率不生成，避免噪声模板）。
 * 每个通过 archetype 取最近成功父任务（代表）的子任务结构为真实可复用步骤，
 * 启发式提炼 name/keywords（确定性、无模型依赖，规避每日作业对 LLM 的脆弱依赖）；
 * 写入 wa_task_templates（source='auto'、priority=-1 低权重、status='active'）；
 * 防重：同 category=archetype 已有 auto 模板则跳过。生成后 loadTemplatePool 立即参与 task:create 匹配，
 * 并受 consolidate-templates 成功率反馈约束（过低自动 disabled，可在模板管理重新启用）。
 * 返回生成数；best-effort 静默（判定过程见 `evaluateAutoTemplateGates`，其台账由 `describeAutoTemplateGates` 只读暴露）。
 */
export function autoCreateTemplatesFromSuccesses(db: Database.Database): number {
  try {
    const { groups } = evaluateAutoTemplateGates(db);
    let created = 0;
    for (const g of groups) {
      if (g.verdict !== 'passed' || !g.rep || !g.children || !g.keywords) continue;
      // zx_20260921 M6（改动点 3）: **保留 `dependsOn`**。此前只取 title/description/acceptance_criteria，
      //   代表性父任务里那套真实前置关系（流水线：先克隆再安装再启动）到模板这一步被**丢弃**，
      //   于是模板拆出来的子任务永远全并行 —— 与"内置 4 模板无 dependsOn ⇒ 模板路存量为空"叠加，
      //   使 `depends_on` 在模板路上恒为空串。
      //   表达**仍用同批序号**（`depends_on` 存的是上一批的真实任务 id，跨批次没有意义）：
      //   把"代表任务里指向的那个 id"换算成"它在本次子任务数组里的位次"。
      //   自环（某子任务的前置恰是它自己）不在此处滤——那是落库侧 `resolveIndexDeps` 的职责（一处真源）。
      const idToIndex = new Map(g.children.map((c, i) => [c.id, i + 1]));
      const subtasks = g.children.map(c => {
        const deps = typeof c.depends_on === 'string' && c.depends_on
          ? c.depends_on.split(',').map(s => s.trim()).filter(Boolean)
          : [];
        const idx = deps.map(id => idToIndex.get(id)).filter((n): n is number => typeof n === 'number');
        return {
          title: c.title,
          description: c.description || '',
          acceptance_criteria: c.acceptance_criteria || '',
          ...(idx.length > 0 ? { dependsOn: idx } : {}),
        };
      });
      const name = (g.rep.title || `${g.archetype}任务`).slice(0, 30);
      const description = `基于 ${g.total} 次同 archetype 成功拆解（成功率 ${(g.rate * 100).toFixed(0)}%）自动提炼：${(g.rep.description || g.rep.title).slice(0, 80)}`;
      db.prepare(
        "INSERT INTO wa_task_templates (id, name, category, description, subtasks, keywords, status, priority, source) VALUES (?, ?, ?, ?, ?, ?, 'active', -1, 'auto')"
      ).run(randomUUID(), name, g.archetype, description, JSON.stringify(subtasks), JSON.stringify(g.keywords));
      created++;
    }
    if (created > 0) loadTemplatePool(db);
    return created;
  } catch { return 0; }
}
