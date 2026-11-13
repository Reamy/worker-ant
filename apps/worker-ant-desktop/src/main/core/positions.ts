/**
 * zx_20261112_1 B1「岗」: **岗位**的单一真源（DDL + 纯函数 + 有界注入）。
 *
 * 岗位是长期在岗的知识载体，不是一次性子代理：说明 / 规范 / 技能 / 知识四段常驻，
 * 项目可启用、任务可指派；执行期只注入**有界**一段（≤1200 字），收口只生成**候选**经验。
 *
 * 三条纪律：
 *   ① 注入有硬上限：说明 > 规范 > 技能 > 知识 > 经验，超预算就整段不注入（不截半句）。
 *   ② 经验只从「已完成且验收通过」的任务生成候选，且**人工采纳**后才进入注入。
 *   ③ 本模块零 electron / 零网络：rr 用 node:sqlite 内存库直跑真逻辑。
 */
import type Database from 'better-sqlite3';
import { goalEvidenceOf, type AcceptanceCheckLike } from './acceptance-check.js';
// zx_20261112_1 B2: 外派键名只引一处真源（不在本文件手抄 `assigned_node_id`）。走零依赖落点，
//   避免把 node-orchestrate → node-identity 的 node:crypto 链带进渲染层构建。
import { REMOTE_ASSIGN_NODE_KEY } from './remote-assign-key.js';
// zx_20261113_1 B2: 「哪些记忆还活着」只引一处真源——岗位教训读复盘时不得手抄 `!= 'archived'`。
import { MEM_LIVE_SQL } from './memory-lifecycle.js';

/** 表 DDL 单一真源：`database.ts` 与 rr 夹具同引这一份。 */
export const POSITIONS_DDL = `
  CREATE TABLE IF NOT EXISTS wa_positions (
    id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, category TEXT NOT NULL DEFAULT 'custom',
    description TEXT NOT NULL DEFAULT '',
    skills_json TEXT NOT NULL DEFAULT '[]',
    rules_json TEXT NOT NULL DEFAULT '[]',
    knowledge_json TEXT NOT NULL DEFAULT '[]',
    enabled INTEGER NOT NULL DEFAULT 1,
    builtin INTEGER NOT NULL DEFAULT 0,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS wa_project_positions (
    project_id TEXT NOT NULL, position_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (project_id, position_id)
  );
  CREATE TABLE IF NOT EXISTS wa_position_lessons (
    id TEXT PRIMARY KEY, position_id TEXT NOT NULL, task_id TEXT NOT NULL, project_id TEXT NOT NULL,
    content TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
    -- zx_20261113_1 B2：来源三态—— retrospect（复盘可迁移教训）/ summary（项目摘要降级）/ imported（导入候选）。
    source TEXT NOT NULL DEFAULT 'summary',
    -- 可迁移标记：只有 1 才进入岗位注入与晋升；项目摘要与不可复用教训留档但不冒充岗位规范。
    reusable INTEGER NOT NULL DEFAULT 0,
    -- 晋升去向（rules/skills/knowledge）与时刻；非空即不再作为"经验"重复注入。
    promoted_to TEXT, promoted_at TEXT,
    -- 来源边界：local（本机任务沉淀）/ imported（岗位知识包导入，永不自动采纳）。
    origin TEXT NOT NULL DEFAULT 'local',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    decided_at TEXT, decided_by TEXT,
    UNIQUE(position_id, task_id)
  );
  CREATE INDEX IF NOT EXISTS idx_wa_position_lessons_pos_status ON wa_position_lessons(position_id, status);
  -- zx_20261113_1 B6「商」：岗位知识包导入回执（可核对"这次导入了什么"）。
  CREATE TABLE IF NOT EXISTS wa_position_imports (
    id TEXT PRIMARY KEY, position_id TEXT NOT NULL, file_name TEXT NOT NULL DEFAULT '',
    mode TEXT NOT NULL, added_sections INTEGER NOT NULL DEFAULT 0,
    added_lessons INTEGER NOT NULL DEFAULT 0, skipped_lessons INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`;

export const POSITION_NAME_MAX = 80;
export const POSITION_CATEGORY_MAX = 40;
export const POSITION_DESCRIPTION_MAX = 800;
export const POSITION_LIST_MAX = 20;
export const POSITION_ITEM_MAX = 200;
export const POSITION_BLOCK_MAX = 1200;
export const POSITION_LESSON_MAX = 300;
export const POSITION_DISPATCH_SUMMARY_MAX = 600;

/**
 * zx_20261112_1 B5：跨机派来的岗位上下文落 `context_json` 的这个键（**只写这个键，绝不写 `wa_tasks.position_id`**
 * ——那只属本机台账；对端岗位不在本机岗位表里，写成 position_id 会伪造一条本地指派）。
 */
export const DISPATCH_POSITION_KEY = 'dispatch_position';

/** 跨机岗位上下文（`{id,name,version,summary}`；`summary` 已由 `positionDispatchSummary` 去知识/经验）。 */
export interface DispatchPosition {
  id: string;
  name: string;
  version: number;
  summary: string;
}
export const POSITION_BLOCK_ITEMS = 3;

export const POSITION_LESSON_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type PositionLessonStatus = (typeof POSITION_LESSON_STATUSES)[number];

/**
 * 经验来源词表（唯一一处；页面/画像/回填同引）。
 *   · `retrospective` 复盘结构化教训（可迁移的主源）；
 *   · `summary` 无复盘时的收口摘要（项目为中心，**不可注入、不可晋升**）；
 *   · `imported` 岗位知识包导入（一律 pending，人工采纳后才算数）；
 *   · `task_close` 旧库历史值，语义等同 summary（迁移已归一，保留标签防旧行显示空）。
 */
export const POSITION_LESSON_SOURCES = ['retrospective', 'summary', 'imported', 'task_close'] as const;
export type PositionLessonSource = (typeof POSITION_LESSON_SOURCES)[number];

export const POSITION_LESSON_SOURCE_LABEL: Record<PositionLessonSource, string> = {
  retrospective: '复盘教训',
  summary: '项目摘要',
  imported: '导入候选',
  task_close: '项目摘要',
};
export const POSITION_LESSON_DECISIONS = ['accepted', 'rejected'] as const;
export type PositionLessonDecision = (typeof POSITION_LESSON_DECISIONS)[number];

export function isPositionLessonStatus(raw: unknown): raw is PositionLessonStatus {
  return typeof raw === 'string' && (POSITION_LESSON_STATUSES as readonly string[]).includes(raw);
}

export function isPositionLessonDecision(raw: unknown): raw is PositionLessonDecision {
  return typeof raw === 'string' && (POSITION_LESSON_DECISIONS as readonly string[]).includes(raw);
}

export interface Position {
  id: string;
  name: string;
  category: string;
  description: string;
  skills: string[];
  rules: string[];
  knowledge: string[];
  enabled: boolean;
  builtin: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PositionListRow extends Position {
  projectCount: number;
  pendingLessons: number;
}

export interface PositionInput {
  name?: unknown;
  category?: unknown;
  description?: unknown;
  skills?: unknown;
  rules?: unknown;
  knowledge?: unknown;
  enabled?: unknown;
}

export interface SanitizedPosition {
  name: string;
  category: string;
  description: string;
  skills: string[];
  rules: string[];
  knowledge: string[];
  enabled: boolean;
}

export type SanitizeResult =
  | { ok: true; value: SanitizedPosition }
  | { ok: false; code: string; message: string };

export interface PositionLesson {
  id: string;
  positionId: string;
  taskId: string;
  projectId: string;
  content: string;
  status: PositionLessonStatus;
  source: string;
  /** zx_20261113_1 B2：可迁移才进注入/晋升；摘要降级与不可复用教训只留档。 */
  reusable: boolean;
  /** 晋升去向（`rules` / `skills` / `knowledge`）；空串＝未晋升。 */
  promotedTo: string;
  promotedAt: string;
  /** 来源边界：`local` 本机沉淀 / `imported` 岗位知识包导入。 */
  origin: string;
  createdAt: string;
  decidedAt: string;
  decidedBy: string;
  taskTitle: string;
  projectName: string;
}

export interface PositionProjectBinding {
  id: string;
  name: string;
  archived: boolean;
  enabled: boolean;
}

export interface PositionDetail {
  position: Position;
  projects: PositionProjectBinding[];
  lessons: PositionLesson[];
}

export interface PositionScore {
  positionId: string;
  name: string;
  score: number;
  hits: string[];
}

export type PositionWriteResult =
  | { ok: true; position: Position }
  | { ok: false; code: string; message: string };

export interface PositionDb {
  prepare: Database.Database['prepare'];
  exec: Database.Database['exec'];
}

/* ── 内置种子 ───────────────────────────────────────────────────────────── */

interface BuiltinSeed {
  id: string;
  name: string;
  category: string;
  description: string;
  rules: string[];
  skills: string[];
}

/** 13 个内置岗位：每岗给可执行的四段初稿（知识留空，由任务沉淀与人工维护）。 */
const BUILTIN_POSITIONS: BuiltinSeed[] = [
  {
    id: 'pos_pm', name: '项目经理', category: 'management',
    description: '对目标、范围与节奏负责：把事拆清、把风险说早、把收口对账。',
    rules: ['先对齐验收标准再开工，标准不清先问清', '风险与依赖在进展里点名，不埋在细节中', '收口时逐项核对交付与验收结论'],
    skills: ['任务拆解', '进度跟踪', '风险识别'],
  },
  {
    id: 'pos_architect', name: '架构师', category: 'tech',
    description: '定技术路线与边界，让后续实现有据可依、可演进。',
    rules: ['先给边界与取舍理由，再给方案', '不为假设需求提前抽象'],
    skills: ['方案设计', '技术选型', '接口契约'],
  },
  {
    id: 'pos_analyst', name: '分析师', category: 'analysis',
    description: '把数据与事实变成可判断、可追溯的结论。',
    rules: ['结论必须带数据出处与口径', '区分事实、推断与建议'],
    skills: ['数据分析', '指标口径', '归因分析'],
  },
  {
    id: 'pos_designer', name: '设计师', category: 'design',
    description: '把需求变成可用、一致、说得清的界面与流程。',
    rules: ['先保证主路径可用，再谈视觉', '交互文案写清楚下一步'],
    skills: ['交互设计', '信息架构', '可用性检查'],
  },
  {
    id: 'pos_frontend', name: '前端工程师', category: 'tech',
    description: '实现可用的界面与交互，保证状态、错误与空态都说清楚。',
    rules: ['每个交互都有成功、失败、空态', '不把后端判断复制到前端'],
    skills: ['React', '状态管理', '前端构建'],
  },
  {
    id: 'pos_backend', name: '后端工程师', category: 'tech',
    description: '实现稳定、可观测、边界清楚的服务与数据流。',
    rules: ['输入在边界校验，内部信任契约', '失败要带可执行的错误原因'],
    skills: ['API 设计', '数据库', '并发与幂等'],
  },
  {
    id: 'pos_impl', name: '实施', category: 'delivery',
    description: '把方案落到客户环境，确保可运行、可回滚、可交接。',
    rules: ['上线前先演练回滚', '交付件与配置逐项留档'],
    skills: ['环境部署', '配置管理', '交付验收'],
  },
  {
    id: 'pos_qa', name: '测试', category: 'tech',
    description: '用可复现的标本证明行为，覆盖正常与异常两侧。',
    rules: ['每个判据都要有反证标本', '失败必须能定位到具体输入'],
    skills: ['用例设计', '回归测试', '缺陷定位'],
  },
  {
    id: 'pos_ops', name: '运维', category: 'operation',
    description: '让系统持续可观测、可恢复，变更可控。',
    rules: ['变更有回滚方案与观察窗口', '告警要能指向下一步动作'],
    skills: ['监控告警', '故障排查', '备份恢复'],
  },
  {
    id: 'pos_sales', name: '销售', category: 'business',
    description: '把客户问题翻译成可交付的价值，守住承诺边界。',
    rules: ['不承诺未验证的能力', '需求变更回到书面确认'],
    skills: ['需求挖掘', '方案讲解', '商务跟进'],
  },
  {
    id: 'pos_finance', name: '财务', category: 'business',
    description: '把收支、成本与风险记清，账要能对上。',
    rules: ['每个数都有来源与口径', '异常先核对再解释'],
    skills: ['账务核算', '成本分析', '预算管理'],
  },
  {
    id: 'pos_hr', name: '人事', category: 'business',
    description: '把岗位、人员与规则对齐，让协作有据可依。',
    rules: ['职责与权限写清楚', '敏感信息按最小必要处理'],
    skills: ['岗位管理', '招聘协调', '制度落地'],
  },
  {
    id: 'pos_marketing', name: '市场', category: 'business',
    description: '把产品价值讲给对的人，用公开内容建立信任。',
    rules: ['只做公开、可核实的表达', '不用夸大或无法兑现的承诺'],
    skills: ['内容策划', '渠道运营', '数据复盘'],
  },
];

export const BUILTIN_POSITION_NAMES = BUILTIN_POSITIONS.map((p) => p.name);

/**
 * 播种内置岗位（幂等）。用 `wa_settings.positions_seed_version` 标记首次播种：
 *   · 重复启动不再 INSERT（用户删掉的内置岗不会被复活）；
 *   · 夹具无 `wa_settings` 时退回 `INSERT OR IGNORE`（仍然不重复插）。
 * 同名用户自定义岗位由 `name UNIQUE` + `OR IGNORE` 保护，不会被覆盖。
 */
export function seedBuiltinPositions(db: PositionDb): number {
  const seedVersion = '1';
  try {
    const row = db
      .prepare("SELECT value FROM wa_settings WHERE key = 'positions_seed_version'")
      .get() as { value?: string } | undefined;
    if (String(row?.value ?? '') === seedVersion) return 0;
  } catch {
    // 夹具可能没有 wa_settings；继续按 OR IGNORE 播种。
  }

  let inserted = 0;
  for (const p of BUILTIN_POSITIONS) {
    const r = db
      .prepare(
        `INSERT OR IGNORE INTO wa_positions
           (id, name, category, description, skills_json, rules_json, knowledge_json, enabled, builtin, version)
         VALUES (?, ?, ?, ?, ?, ?, '[]', 1, 1, 1)`,
      )
      .run(p.id, p.name, p.category, p.description, JSON.stringify(p.skills), JSON.stringify(p.rules));
    inserted += r.changes;
  }
  try {
    db.prepare(
      `INSERT INTO wa_settings (key, value) VALUES ('positions_seed_version', ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(seedVersion);
  } catch {
    // 无 settings 表也不算失败：上方 OR IGNORE 已保证幂等。
  }
  return inserted;
}

/* ── 校验与读模型 ───────────────────────────────────────────────────────── */

function fail(code: string, message: string): SanitizeResult {
  return { ok: false, code, message };
}

function normalizeList(raw: unknown, label: string): { ok: true; value: string[] } | { ok: false; code: string; message: string } {
  if (raw == null) return { ok: true, value: [] };
  if (!Array.isArray(raw)) return { ok: false, code: 'LIST_NOT_ARRAY', message: `${label}必须是数组` };
  if (raw.length > POSITION_LIST_MAX) {
    return { ok: false, code: 'LIST_TOO_MANY', message: `${label}最多 ${POSITION_LIST_MAX} 条（当前 ${raw.length} 条）` };
  }
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { ok: false, code: 'ITEM_NOT_STRING', message: `${label}每一项都必须是文字` };
    const s = item.trim();
    if (!s) continue;
    if (s.length > POSITION_ITEM_MAX) {
      return { ok: false, code: 'ITEM_TOO_LONG', message: `${label}单条最多 ${POSITION_ITEM_MAX} 字（当前 ${s.length} 字）：${s.slice(0, 30)}…` };
    }
    if (!out.includes(s)) out.push(s);
  }
  return { ok: true, value: out };
}

/**
 * 四段校验：非法**整块拒绝**（不悄悄截断、不丢坏项），调用方据 `code` 给用户看原因。
 * 名称非空且唯一由写入侧 SQL 再判；此处只校验形状与长度。
 */
export function sanitizePosition(input: PositionInput): SanitizeResult {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  if (!name) return fail('NAME_REQUIRED', '岗位名称不能为空');
  if (name.length > POSITION_NAME_MAX) return fail('NAME_TOO_LONG', `岗位名称最多 ${POSITION_NAME_MAX} 字（当前 ${name.length} 字）`);

  const categoryRaw = typeof input.category === 'string' ? input.category.trim() : '';
  if (categoryRaw.length > POSITION_CATEGORY_MAX) {
    return fail('CATEGORY_TOO_LONG', `分类最多 ${POSITION_CATEGORY_MAX} 字（当前 ${categoryRaw.length} 字）`);
  }

  const description = typeof input.description === 'string' ? input.description.trim() : '';
  if (description.length > POSITION_DESCRIPTION_MAX) {
    return fail('DESCRIPTION_TOO_LONG', `说明最多 ${POSITION_DESCRIPTION_MAX} 字（当前 ${description.length} 字）`);
  }

  const rules = normalizeList(input.rules, '规范');
  if (!rules.ok) return rules;
  const skills = normalizeList(input.skills, '技能');
  if (!skills.ok) return skills;
  const knowledge = normalizeList(input.knowledge, '知识');
  if (!knowledge.ok) return knowledge;

  let enabled = true;
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') return fail('ENABLED_NOT_BOOLEAN', '启用状态必须是布尔值');
    enabled = input.enabled;
  }

  return {
    ok: true,
    value: {
      name,
      category: categoryRaw || 'custom',
      description,
      skills: skills.value,
      rules: rules.value,
      knowledge: knowledge.value,
      enabled,
    },
  };
}

function parseStringArray(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    if (!Array.isArray(v)) return [];
    return v.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  } catch {
    return [];
  }
}

function rowToPosition(raw: Record<string, unknown>): Position {
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    category: String(raw.category ?? 'custom'),
    description: String(raw.description ?? ''),
    skills: parseStringArray(raw.skills_json),
    rules: parseStringArray(raw.rules_json),
    knowledge: parseStringArray(raw.knowledge_json),
    enabled: Number(raw.enabled ?? 1) !== 0,
    builtin: Number(raw.builtin ?? 0) !== 0,
    version: Number(raw.version ?? 1) || 1,
    createdAt: String(raw.created_at ?? ''),
    updatedAt: String(raw.updated_at ?? ''),
  };
}

function rowToLesson(raw: Record<string, unknown>): PositionLesson {
  const status = isPositionLessonStatus(raw.status) ? raw.status : 'pending';
  return {
    id: String(raw.id ?? ''),
    positionId: String(raw.position_id ?? ''),
    taskId: String(raw.task_id ?? ''),
    projectId: String(raw.project_id ?? ''),
    content: String(raw.content ?? ''),
    status,
    source: String(raw.source ?? ''),
    reusable: Number(raw.reusable ?? 0) === 1,
    promotedTo: String(raw.promoted_to ?? ''),
    promotedAt: String(raw.promoted_at ?? ''),
    origin: String(raw.origin ?? 'local'),
    createdAt: String(raw.created_at ?? ''),
    decidedAt: String(raw.decided_at ?? ''),
    decidedBy: String(raw.decided_by ?? ''),
    taskTitle: String(raw.task_title ?? ''),
    projectName: String(raw.project_name ?? ''),
  };
}

/** 列表：内置在前，名称升序；带「绑定项目数」与「待确认经验数」。 */
export function listPositions(db: PositionDb): PositionListRow[] {
  const rows = db
    .prepare(
      `SELECT p.*,
              (SELECT COUNT(*) FROM wa_project_positions pp
                WHERE pp.position_id = p.id AND pp.enabled = 1) AS project_count,
              (SELECT COUNT(*) FROM wa_position_lessons l
                WHERE l.position_id = p.id AND l.status = 'pending') AS pending_lessons
         FROM wa_positions p
        ORDER BY p.builtin DESC, p.name ASC`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    ...rowToPosition(r),
    projectCount: Number(r.project_count ?? 0),
    pendingLessons: Number(r.pending_lessons ?? 0),
  }));
}

export function getPosition(db: PositionDb, id: string): Position | null {
  if (!id) return null;
  const row = db.prepare('SELECT * FROM wa_positions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  return row ? rowToPosition(row) : null;
}

export function getPositionByName(db: PositionDb, name: string): Position | null {
  const n = name.trim();
  if (!n) return null;
  const row = db.prepare('SELECT * FROM wa_positions WHERE name = ?').get(n) as Record<string, unknown> | undefined;
  return row ? rowToPosition(row) : null;
}

function listPositionProjects(db: PositionDb, positionId: string): PositionProjectBinding[] {
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.status, COALESCE(pp.enabled, 0) AS bound
         FROM wa_projects p
         LEFT JOIN wa_project_positions pp
           ON pp.project_id = p.id AND pp.position_id = ?
        WHERE p.status != 'archived'
        ORDER BY p.name ASC`,
    )
    .all(positionId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id ?? ''),
    name: String(r.name ?? ''),
    archived: String(r.status ?? '') === 'archived',
    enabled: Number(r.bound ?? 0) !== 0,
  }));
}

export function listPositionLessons(db: PositionDb, positionId: string): PositionLesson[] {
  const rows = db
    .prepare(
      `SELECT l.*, COALESCE(t.title, '') AS task_title, COALESCE(p.name, '') AS project_name
         FROM wa_position_lessons l
         LEFT JOIN wa_tasks t ON t.id = l.task_id
         LEFT JOIN wa_projects p ON p.id = l.project_id
        WHERE l.position_id = ?
        ORDER BY CASE l.status WHEN 'pending' THEN 0 ELSE 1 END, l.created_at DESC`,
    )
    .all(positionId) as Array<Record<string, unknown>>;
  return rows.map(rowToLesson);
}

export function getPositionDetail(db: PositionDb, id: string): PositionDetail | null {
  const position = getPosition(db, id);
  if (!position) return null;
  return {
    position,
    projects: listPositionProjects(db, id),
    lessons: listPositionLessons(db, id),
  };
}

/* ── 写入 ───────────────────────────────────────────────────────────────── */

function isUniqueError(e: unknown): boolean {
  return /UNIQUE constraint failed/i.test(String((e as Error)?.message ?? ''));
}

export function createPosition(db: PositionDb, input: PositionInput, nowIso = new Date().toISOString()): PositionWriteResult {
  const clean = sanitizePosition(input);
  if (!clean.ok) return clean;
  const v = clean.value;
  const id = `pos_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    db.prepare(
      `INSERT INTO wa_positions
         (id, name, category, description, skills_json, rules_json, knowledge_json, enabled, builtin, version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
    ).run(
      id, v.name, v.category, v.description,
      JSON.stringify(v.skills), JSON.stringify(v.rules), JSON.stringify(v.knowledge),
      v.enabled ? 1 : 0, nowIso, nowIso,
    );
  } catch (e) {
    if (isUniqueError(e)) return { ok: false, code: 'DUPLICATE_NAME', message: `已有同名岗位「${v.name}」` };
    throw e;
  }
  const created = getPosition(db, id);
  if (!created) return { ok: false, code: 'INTERNAL', message: '岗位已写入但读不回来' };
  return { ok: true, position: created };
}

export function updatePosition(db: PositionDb, id: string, input: PositionInput, nowIso = new Date().toISOString()): PositionWriteResult {
  const existing = getPosition(db, id);
  if (!existing) return { ok: false, code: 'NOT_FOUND', message: '岗位不存在' };
  const clean = sanitizePosition(input);
  if (!clean.ok) return clean;
  const v = clean.value;
  try {
    db.prepare(
      `UPDATE wa_positions
          SET name = ?, category = ?, description = ?, skills_json = ?, rules_json = ?, knowledge_json = ?,
              enabled = ?, version = version + 1, updated_at = ?
        WHERE id = ?`,
    ).run(
      v.name, v.category, v.description,
      JSON.stringify(v.skills), JSON.stringify(v.rules), JSON.stringify(v.knowledge),
      v.enabled ? 1 : 0, nowIso, id,
    );
  } catch (e) {
    if (isUniqueError(e)) return { ok: false, code: 'DUPLICATE_NAME', message: `已有同名岗位「${v.name}」` };
    throw e;
  }
  const updated = getPosition(db, id);
  if (!updated) return { ok: false, code: 'INTERNAL', message: '岗位已更新但读不回来' };
  return { ok: true, position: updated };
}

export function setPositionEnabled(db: PositionDb, id: string, enabled: boolean): PositionWriteResult {
  const existing = getPosition(db, id);
  if (!existing) return { ok: false, code: 'NOT_FOUND', message: '岗位不存在' };
  db.prepare(
    `UPDATE wa_positions SET enabled = ?, version = version + 1, updated_at = datetime('now') WHERE id = ?`,
  ).run(enabled ? 1 : 0, id);
  const updated = getPosition(db, id);
  if (!updated) return { ok: false, code: 'INTERNAL', message: '岗位已更新但读不回来' };
  return { ok: true, position: updated };
}

/**
 * 删除岗位。**不删已确认经验**：`wa_position_lessons` 行保留（`position_id` 无外键），
 *   项目绑定随之解除。返回保留的经验条数，页面据此提示「已解除绑定，经验已保留」。
 */
export function deletePosition(db: PositionDb, id: string): { deleted: boolean; unboundProjects: number; keptLessons: number } {
  const existing = getPosition(db, id);
  if (!existing) return { deleted: false, unboundProjects: 0, keptLessons: 0 };
  db.exec('BEGIN');
  try {
    const unbound = db.prepare('DELETE FROM wa_project_positions WHERE position_id = ?').run(id).changes;
    const kept = db.prepare('SELECT COUNT(*) AS n FROM wa_position_lessons WHERE position_id = ?').get(id) as { n?: number } | undefined;
    db.prepare('DELETE FROM wa_positions WHERE id = ?').run(id);
    db.exec('COMMIT');
    return { deleted: true, unboundProjects: unbound, keptLessons: Number(kept?.n ?? 0) };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch { /* 回滚失败保留原始错误 */ }
    throw e;
  }
}

/** 项目是否启用该岗位（缺行 = 未启用，不猜）。 */
export function setProjectPositionEnabled(db: PositionDb, projectId: string, positionId: string, enabled: boolean): boolean {
  if (!projectId || !positionId) return false;
  db.prepare(
    `INSERT INTO wa_project_positions (project_id, position_id, enabled, created_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(project_id, position_id) DO UPDATE SET enabled = excluded.enabled`,
  ).run(projectId, positionId, enabled ? 1 : 0);
  return true;
}

/**
 * 本项目**可指派**的岗位：岗位自身启用 ∧ 项目绑定启用。
 * 禁用任一即撤下（历史任务不改，下一轮注入自然为空）。
 */
export function listProjectEnabledPositions(db: PositionDb, projectId: string): Position[] {
  if (!projectId) return [];
  const rows = db
    .prepare(
      `SELECT p.* FROM wa_positions p
         JOIN wa_project_positions pp ON pp.position_id = p.id AND pp.project_id = ?
        WHERE p.enabled = 1 AND pp.enabled = 1
        ORDER BY p.name ASC`,
    )
    .all(projectId) as Array<Record<string, unknown>>;
  return rows.map(rowToPosition);
}

/**
 * zx_20261113_1 B1「联」：项目详情「岗位」卡的**只读投影**。
 *
 * 与 `listProjectEnabledPositions` 的分界：那个回答"**能派给谁**"（只回已启用的），
 * 这个回答"**这个项目有哪些岗位、各自干了多少**"——含未启用项，页面才看得见"为什么派不了"。
 * 计数全在 SQL 里一次取齐，renderer 不再遍历任务自己加。
 *
 * `taskActive` 的"在办"口径取既有非终态词表（pending / executing / running / paused），
 * archived 仍计入 `taskTotal`（它是项目历史的一部分），但不计入"在办"。
 */
export interface ProjectPositionBoardRow {
  id: string;
  name: string;
  category: string;
  enabled: boolean;
  bound: boolean;
  builtin: boolean;
  version: number;
  taskTotal: number;
  taskCompleted: number;
  taskActive: number;
  pendingLessons: number;
}

/**
 * zx_20261113_1 B5「像」：岗位画像——**一处派生、只读**。
 *
 * 回答四个问题（岗位页第一屏）：
 *   ① 做过多少（任务总/完成/失败/在办/归档）；
 *   ② 做得怎么样（验收通过数——按 `context_json.acceptance_check` 的 passed==criteria 判定）；
 *   ③ 学到什么（待审/采纳/拒绝/已晋升经验）；
 *   ④ 用了多少（岗位注入账：行数 / est_tokens / 完成 / 失败 / 浪费字数）。
 *
 * 读不到注入账时 `injections.available=false` + 原因——不把"没读到"写成 0。
 */
export interface PositionProfile {
  positionId: string;
  taskTotal: number;
  taskCompleted: number;
  taskFailed: number;
  taskActive: number;
  taskArchived: number;
  acceptancePassed: number;
  projectCount: number;
  lessons: { total: number; pending: number; accepted: number; rejected: number; promoted: number };
  injections: {
    available: boolean;
    reason: string;
    rows: number;
    estTokens: number;
    completed: number;
    failed: number;
    pending: number;
    wasteChars: number;
  };
  lastActive: string;
}

export function positionProfile(db: PositionDb, positionId: string): PositionProfile | null {
  const pid = String(positionId ?? '').trim();
  if (!pid) return null;
  const position = getPosition(db, pid);
  if (!position) return null;

  const task = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
              COALESCE(SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
              COALESCE(SUM(CASE WHEN status IN ('pending','executing','running','paused') THEN 1 ELSE 0 END), 0) AS active,
              COALESCE(SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END), 0) AS archived,
              COALESCE(SUM(CASE
                WHEN status = 'completed'
                 AND json_valid(context_json)
                 AND CAST(json_extract(context_json, '$.acceptance_check.criteria_total') AS INTEGER) > 0
                 AND CAST(json_extract(context_json, '$.acceptance_check.passed_total') AS INTEGER)
                   = CAST(json_extract(context_json, '$.acceptance_check.criteria_total') AS INTEGER)
                THEN 1 ELSE 0 END), 0) AS acceptance_passed,
              COALESCE(MAX(COALESCE(updated_at, created_at)), '') AS last_active
         FROM wa_tasks
        WHERE position_id = ?`,
    )
    .get(pid) as Record<string, unknown> | undefined;

  const lesson = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END), 0) AS pending,
              COALESCE(SUM(CASE WHEN status = 'accepted' THEN 1 ELSE 0 END), 0) AS accepted,
              COALESCE(SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END), 0) AS rejected,
              COALESCE(SUM(CASE WHEN promoted_to IS NOT NULL AND promoted_to <> '' THEN 1 ELSE 0 END), 0) AS promoted
         FROM wa_position_lessons
        WHERE position_id = ?`,
    )
    .get(pid) as Record<string, unknown> | undefined;

  let injections: PositionProfile['injections'] = {
    available: true, reason: '', rows: 0, estTokens: 0, completed: 0, failed: 0, pending: 0, wasteChars: 0,
  };
  try {
    const inj = db
      .prepare(
        `SELECT COUNT(*) AS rows,
                COALESCE(SUM(ci.est_tokens), 0) AS tokens,
                COALESCE(SUM(CASE WHEN ci.outcome = 'completed' THEN 1 ELSE 0 END), 0) AS completed,
                COALESCE(SUM(CASE WHEN ci.outcome = 'failed' THEN 1 ELSE 0 END), 0) AS failed,
                COALESCE(SUM(CASE WHEN ci.outcome NOT IN ('completed','failed') THEN 1 ELSE 0 END), 0) AS pending,
                COALESCE(SUM(CASE WHEN ci.outcome = 'failed' THEN ci.chars ELSE 0 END), 0) AS waste
           FROM wa_context_injections ci
           JOIN wa_tasks t ON t.id = ci.task_id
          WHERE t.position_id = ? AND ci.source = 'position'`,
      )
      .get(pid) as Record<string, unknown>;
    injections = {
      available: true,
      reason: '',
      rows: Number(inj?.rows) || 0,
      estTokens: Number(inj?.tokens) || 0,
      completed: Number(inj?.completed) || 0,
      failed: Number(inj?.failed) || 0,
      pending: Number(inj?.pending) || 0,
      wasteChars: Number(inj?.waste) || 0,
    };
  } catch (e) {
    injections = {
      available: false,
      reason: (e as Error)?.message || String(e),
      rows: 0, estTokens: 0, completed: 0, failed: 0, pending: 0, wasteChars: 0,
    };
  }

  const projects = listPositionProjects(db, pid).filter((p) => !p.archived && p.enabled);
  return {
    positionId: pid,
    taskTotal: Number(task?.total) || 0,
    taskCompleted: Number(task?.completed) || 0,
    taskFailed: Number(task?.failed) || 0,
    taskActive: Number(task?.active) || 0,
    taskArchived: Number(task?.archived) || 0,
    acceptancePassed: Number(task?.acceptance_passed) || 0,
    projectCount: projects.length,
    lessons: {
      total: Number(lesson?.total) || 0,
      pending: Number(lesson?.pending) || 0,
      accepted: Number(lesson?.accepted) || 0,
      rejected: Number(lesson?.rejected) || 0,
      promoted: Number(lesson?.promoted) || 0,
    },
    injections,
    lastActive: String(task?.last_active ?? ''),
  };
}

export function listProjectPositionBoard(db: PositionDb, projectId: string): ProjectPositionBoardRow[] {
  const pid = String(projectId ?? '').trim();
  if (!pid) return [];
  const rows = db
    .prepare(
      `SELECT p.id, p.name, p.category, p.enabled, p.builtin, p.version,
              COALESCE(pp.enabled, 0) AS bound,
              COALESCE(t.total, 0) AS task_total,
              COALESCE(t.completed, 0) AS task_completed,
              COALESCE(t.active, 0) AS task_active,
              COALESCE(l.pending, 0) AS pending_lessons
         FROM wa_positions p
         LEFT JOIN wa_project_positions pp
           ON pp.position_id = p.id AND pp.project_id = ?
         LEFT JOIN (
           SELECT position_id,
                  COUNT(*) AS total,
                  SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
                  SUM(CASE WHEN status IN ('pending','executing','running','paused') THEN 1 ELSE 0 END) AS active
             FROM wa_tasks
            WHERE project_id = ? AND position_id <> ''
            GROUP BY position_id
         ) t ON t.position_id = p.id
         LEFT JOIN (
           SELECT position_id, COUNT(*) AS pending
             FROM wa_position_lessons
            WHERE project_id = ? AND status = 'pending'
            GROUP BY position_id
         ) l ON l.position_id = p.id
        ORDER BY bound DESC, p.enabled DESC, p.name ASC`,
    )
    .all(pid, pid, pid) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id ?? ''),
    name: String(r.name ?? ''),
    category: String(r.category ?? ''),
    enabled: Number(r.enabled) === 1,
    bound: Number(r.bound) === 1,
    builtin: Number(r.builtin) === 1,
    version: Number(r.version) || 1,
    taskTotal: Number(r.task_total) || 0,
    taskCompleted: Number(r.task_completed) || 0,
    taskActive: Number(r.task_active) || 0,
    pendingLessons: Number(r.pending_lessons) || 0,
  }));
}

/* ── 经验候选与人工确认 ─────────────────────────────────────────────────── */

/**
 * 收口时写候选（`INSERT OR IGNORE`，`UNIQUE(position_id, task_id)` 保证重跑不重复）。
 * 只写 `pending`；是否采纳由用户决定。返回是否真插入（false = 已有候选或写入失败）。
 */
export function insertPositionLessonCandidate(
  db: PositionDb,
  input: {
    positionId: string;
    taskId: string;
    projectId: string;
    content: string;
    source?: string;
    reusable?: boolean;
    origin?: 'local' | 'imported';
  },
): boolean {
  const positionId = String(input.positionId ?? '').trim();
  const taskId = String(input.taskId ?? '').trim();
  const content = String(input.content ?? '').trim().slice(0, POSITION_LESSON_MAX);
  if (!positionId || !taskId || !content) return false;
  const id = `les_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    const r = db.prepare(
      `INSERT OR IGNORE INTO wa_position_lessons
         (id, position_id, task_id, project_id, content, status, source, reusable, origin)
       VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
    ).run(
      id, positionId, taskId, String(input.projectId ?? ''), content,
      String(input.source ?? 'summary'),
      input.reusable ? 1 : 0,
      input.origin === 'imported' ? 'imported' : 'local',
    );
    return r.changes > 0;
  } catch (e) {
    console.warn('[positions] 候选经验写入失败:', (e as Error)?.message || String(e));
    return false;
  }
}

export type LessonDecideResult =
  | { ok: true; lesson: PositionLesson }
  | { ok: false; code: string; message: string };

/**
 * 人工确认：只允许 `pending → accepted/rejected`，已决状态**不回到 pending**。
 * 采纳后进入注入；拒绝后不注入。两种决定都可由调用方落审计。
 */
export function decidePositionLesson(
  db: PositionDb,
  lessonId: string,
  decision: PositionLessonDecision,
  by = '',
  nowIso = new Date().toISOString(),
): LessonDecideResult {
  if (!isPositionLessonDecision(decision)) {
    return { ok: false, code: 'BAD_DECISION', message: '只能采纳或拒绝' };
  }
  const cur = db.prepare('SELECT status FROM wa_position_lessons WHERE id = ?').get(lessonId) as { status?: string } | undefined;
  if (!cur) return { ok: false, code: 'NOT_FOUND', message: '候选经验不存在' };
  if (String(cur.status ?? '') !== 'pending') {
    return { ok: false, code: 'ALREADY_DECIDED', message: '这条经验已经处理过了' };
  }
  const r = db.prepare(
    `UPDATE wa_position_lessons
        SET status = ?, decided_at = ?, decided_by = ?
      WHERE id = ? AND status = 'pending'`,
  ).run(decision, nowIso, String(by ?? ''), lessonId);
  if (r.changes === 0) return { ok: false, code: 'ALREADY_DECIDED', message: '这条经验已经处理过了' };
  const row = db
    .prepare(
      `SELECT l.*, COALESCE(t.title, '') AS task_title, COALESCE(p.name, '') AS project_name
         FROM wa_position_lessons l
         LEFT JOIN wa_tasks t ON t.id = l.task_id
         LEFT JOIN wa_projects p ON p.id = l.project_id
        WHERE l.id = ?`,
    )
    .get(lessonId) as Record<string, unknown> | undefined;
  if (!row) return { ok: false, code: 'INTERNAL', message: '已处理但读不回来' };
  return { ok: true, lesson: rowToLesson(row) };
}

export type LessonUpdateResult =
  | { ok: true; lesson: PositionLesson }
  | { ok: false; code: string; message: string };

/**
 * zx_20261113_2 M17：编辑一条经验的内容（人工缩短后再晋升）。
 *
 * 病根（2026-11-13 用户实测）：晋升规则要求单条 ≤ `POSITION_ITEM_MAX`（200 字），
 *   但界面只有「采纳 / 晋升」，没有编辑入口——错误提示「先编辑缩短再晋升」指向一个不存在的操作。
 *
 * 口径：只能编辑**未晋升**的经验（已晋升的段落是独立副本，改源文不会同步，必须先撤回）；
 *   内容非空且 ≤ `POSITION_LESSON_MAX`（300，经验本体的上限）；状态不改（采纳/待审保持原状）。
 */
export function updatePositionLessonContent(
  db: PositionDb,
  lessonId: string,
  content: string,
): LessonUpdateResult {
  const id = String(lessonId ?? '').trim();
  if (!id) return { ok: false, code: 'NOT_FOUND', message: '经验不存在' };
  const row = db.prepare('SELECT * FROM wa_position_lessons WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return { ok: false, code: 'NOT_FOUND', message: '经验不存在（可能已删除）' };
  const lesson = rowToLesson(row);
  if (lesson.promotedTo) {
    return { ok: false, code: 'ALREADY_PROMOTED', message: '这条经验已晋升；改源文不会同步已晋升的段落——先撤回晋升再编辑' };
  }
  const text = String(content ?? '').trim();
  if (!text) return { ok: false, code: 'EMPTY_CONTENT', message: '经验内容不能为空' };
  if (text.length > POSITION_LESSON_MAX) {
    return { ok: false, code: 'TOO_LONG', message: `经验最多 ${POSITION_LESSON_MAX} 字（当前 ${text.length} 字）` };
  }
  db.prepare('UPDATE wa_position_lessons SET content = ? WHERE id = ?').run(text, id);
  const updated = db.prepare('SELECT * FROM wa_position_lessons WHERE id = ?').get(id) as Record<string, unknown>;
  return { ok: true, lesson: rowToLesson(updated) };
}

/* ── 经验晋升（zx_20261113_1 B4「晋」） ─────────────────────────────────── */

export const POSITION_LESSON_PROMOTE_TARGETS = ['rules', 'skills', 'knowledge'] as const;
export type PositionLessonPromoteTarget = (typeof POSITION_LESSON_PROMOTE_TARGETS)[number];

export function isPositionLessonPromoteTarget(raw: unknown): raw is PositionLessonPromoteTarget {
  return typeof raw === 'string' && (POSITION_LESSON_PROMOTE_TARGETS as readonly string[]).includes(raw);
}

export const POSITION_PROMOTE_TARGET_LABEL: Record<PositionLessonPromoteTarget, string> = {
  rules: '规范',
  skills: '技能',
  knowledge: '知识',
};

export type PositionLessonPromoteResult =
  | { ok: true; position: Position; lesson: PositionLesson }
  | { ok: false; code: string; message: string };

/**
 * 把一条**已采纳且可迁移**的经验晋升到岗位四段之一（人工第二次确认）。
 *
 * 四条拒因，全部如实说清、不静默处理：
 *   · 未采纳 / 不可迁移 / 已晋升 ⇒ 不该动；
 *   · 目标段已满（`POSITION_LIST_MAX`）或文本已在段内 ⇒ 不重复追加、不挤掉别人；
 *   · 经验超过单条上限（`POSITION_ITEM_MAX`）⇒ 先缩短再晋升（绝不截半句写进规范）。
 */
export function promotePositionLesson(
  db: PositionDb,
  lessonId: string,
  target: PositionLessonPromoteTarget,
  nowIso = new Date().toISOString(),
): PositionLessonPromoteResult {
  if (!isPositionLessonPromoteTarget(target)) {
    return { ok: false, code: 'BAD_TARGET', message: '只能晋升到规范 / 技能 / 知识' };
  }
  const id = String(lessonId ?? '').trim();
  if (!id) return { ok: false, code: 'NOT_FOUND', message: '经验不存在' };
  const row = db.prepare('SELECT * FROM wa_position_lessons WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return { ok: false, code: 'NOT_FOUND', message: '经验不存在（可能已删除）' };
  const lesson = rowToLesson(row);
  if (lesson.status !== 'accepted') return { ok: false, code: 'NOT_ACCEPTED', message: '只有已采纳的经验才能晋升' };
  if (!lesson.reusable) return { ok: false, code: 'NOT_REUSABLE', message: '这条经验不可迁移（项目摘要或复盘判定不可复用），不能晋升为岗位规范' };
  if (lesson.promotedTo) {
    return { ok: false, code: 'ALREADY_PROMOTED', message: `这条经验已晋升到「${POSITION_PROMOTE_TARGET_LABEL[lesson.promotedTo as PositionLessonPromoteTarget] ?? lesson.promotedTo}」` };
  }
  const text = String(lesson.content ?? '').trim();
  if (!text) return { ok: false, code: 'EMPTY_CONTENT', message: '经验内容为空，无法晋升' };
  if (text.length > POSITION_ITEM_MAX) {
    return { ok: false, code: 'LESSON_TOO_LONG', message: `经验 ${text.length} 字，超过单条上限 ${POSITION_ITEM_MAX} 字——先编辑缩短再晋升` };
  }
  const position = getPosition(db, lesson.positionId);
  if (!position) return { ok: false, code: 'POSITION_MISSING', message: '岗位已删除，无法晋升' };
  const section = target === 'rules' ? position.rules : target === 'skills' ? position.skills : position.knowledge;
  if (section.length >= POSITION_LIST_MAX) {
    return { ok: false, code: 'SECTION_FULL', message: `「${POSITION_PROMOTE_TARGET_LABEL[target]}」已满 ${POSITION_LIST_MAX} 条——先删一条再加` };
  }
  if (section.some((s) => s.trim() === text)) {
    return { ok: false, code: 'ALREADY_IN_SECTION', message: `「${POSITION_PROMOTE_TARGET_LABEL[target]}」里已有同一句` };
  }
  const next = [...section, text];
  const col = target === 'rules' ? 'rules_json' : target === 'skills' ? 'skills_json' : 'knowledge_json';
  db.prepare(
    `UPDATE wa_positions SET ${col} = ?, version = version + 1, updated_at = ? WHERE id = ?`,
  ).run(JSON.stringify(next), nowIso, position.id);
  db.prepare(
    `UPDATE wa_position_lessons SET promoted_to = ?, promoted_at = ? WHERE id = ? AND promoted_to IS NULL`,
  ).run(target, nowIso, id);
  const pos = getPosition(db, position.id);
  const updated = db.prepare('SELECT * FROM wa_position_lessons WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!pos || !updated) return { ok: false, code: 'INTERNAL', message: '已晋升但读不回来' };
  return { ok: true, position: pos, lesson: rowToLesson(updated) };
}

/**
 * 撤回晋升：只有目标段**仍含原文**才移除并清 `promoted_to`。
 * 原文已被人工改过 ⇒ 拒绝并说明（宁可让人手工处理，也不按"差不多"删错一句）。
 */
export function unpromotePositionLesson(
  db: PositionDb,
  lessonId: string,
  nowIso = new Date().toISOString(),
): PositionLessonPromoteResult {
  const id = String(lessonId ?? '').trim();
  if (!id) return { ok: false, code: 'NOT_FOUND', message: '经验不存在' };
  const row = db.prepare('SELECT * FROM wa_position_lessons WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return { ok: false, code: 'NOT_FOUND', message: '经验不存在（可能已删除）' };
  const lesson = rowToLesson(row);
  if (!lesson.promotedTo) return { ok: false, code: 'NOT_PROMOTED', message: '这条经验还没有晋升' };
  if (!isPositionLessonPromoteTarget(lesson.promotedTo)) {
    return { ok: false, code: 'BAD_TARGET', message: '晋升去向未知，无法撤回' };
  }
  const position = getPosition(db, lesson.positionId);
  if (!position) return { ok: false, code: 'POSITION_MISSING', message: '岗位已删除，无法撤回' };
  const target = lesson.promotedTo;
  const section = target === 'rules' ? position.rules : target === 'skills' ? position.skills : position.knowledge;
  const text = String(lesson.content ?? '').trim();
  const idx = section.findIndex((s) => s.trim() === text);
  if (idx < 0) {
    return { ok: false, code: 'TEXT_CHANGED', message: `「${POSITION_PROMOTE_TARGET_LABEL[target]}」里的原文已改，无法自动撤回——请手工删除该句` };
  }
  const next = section.filter((_, i) => i !== idx);
  const col = target === 'rules' ? 'rules_json' : target === 'skills' ? 'skills_json' : 'knowledge_json';
  db.prepare(
    `UPDATE wa_positions SET ${col} = ?, version = version + 1, updated_at = ? WHERE id = ?`,
  ).run(JSON.stringify(next), nowIso, position.id);
  db.prepare('UPDATE wa_position_lessons SET promoted_to = NULL, promoted_at = NULL WHERE id = ?').run(id);
  const pos = getPosition(db, position.id);
  const updated = db.prepare('SELECT * FROM wa_position_lessons WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!pos || !updated) return { ok: false, code: 'INTERNAL', message: '已撤回但读不回来' };
  return { ok: true, position: pos, lesson: rowToLesson(updated) };
}

/** 注入用 accepted 经验（最近 3 条；**不筛可迁移**，供人工审阅/兼容旧套）。 */
export function listAcceptedLessons(db: PositionDb, positionId: string, limit = POSITION_BLOCK_ITEMS): PositionLesson[] {
  const rows = db
    .prepare(
      `SELECT * FROM wa_position_lessons
        WHERE position_id = ? AND status = 'accepted'
        ORDER BY COALESCE(decided_at, created_at) DESC
        LIMIT ?`,
    )
    .all(positionId, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToLesson);
}

/**
 * zx_20261113_1 B3「用」：**真正进入注入**的经验选择器。
 *
 * 与 `listAcceptedLessons` 的分界：那个是"人采纳过什么"（含项目摘要/不可迁移/已晋升），
 * 这个只回答"哪些有资格进岗位块"——`accepted ∧ reusable=1 ∧ 未晋升`。
 * 项目摘要（reusable=0）与不可复用复盘**永远不被选中**：岗位不是项目流水账。
 */
export function selectPositionLessonsForInjection(
  db: PositionDb,
  positionId: string,
  limit = POSITION_BLOCK_ITEMS,
): PositionLesson[] {
  const pid = String(positionId ?? '').trim();
  if (!pid) return [];
  const rows = db
    .prepare(
      `SELECT * FROM wa_position_lessons
        WHERE position_id = ? AND status = 'accepted' AND reusable = 1
          AND (promoted_to IS NULL OR promoted_to = '')
        ORDER BY COALESCE(decided_at, created_at) DESC
        LIMIT ?`,
    )
    .all(pid, limit) as Array<Record<string, unknown>>;
  return rows.map(rowToLesson);
}

/* ── 有界注入与建议打分（纯函数） ────────────────────────────────────────── */

interface BlockSource {
  name: string;
  description: string;
  rules: string[];
  skills: string[];
  knowledge: string[];
}

function buildBoundedBlock(head: string, sections: Array<[string, string]>, maxChars: number): string {
  const lines: string[] = [];
  let used = 0;
  const push = (line: string): boolean => {
    const add = lines.length === 0 ? line.length : line.length + 1;
    if (used + add > maxChars) return false;
    lines.push(line);
    used += add;
    return true;
  };
  if (!push(head)) return '';
  for (const [label, body] of sections) {
    if (!body.trim()) continue;
    // 超预算即整段停：低优先级不得越过更高优先级挤进预算。
    if (!push(`${label}：${body}`)) break;
  }
  return lines.join('\n');
}

/** 注入条目类型（与注入账 `source='position'` 的 `ref_id` 前缀同词）。 */
export const POSITION_BLOCK_ITEM_KINDS = ['description', 'rule', 'skill', 'knowledge', 'lesson'] as const;
export type PositionBlockItemKind = (typeof POSITION_BLOCK_ITEM_KINDS)[number];

export interface PositionBlockItem {
  kind: PositionBlockItemKind;
  /** 稳定身份：说明→`description`；规范/技能/知识→`<kind>:<内容哈希>`；经验→`lesson:<id>`。 */
  refId: string;
  /** 该条目**正文**字数（不含标签与分隔符；块总长另由 `text.length` 回答）。 */
  chars: number;
  /** 前 80 字，供任务详情直接上屏（不二次解析块文本）。 */
  preview: string;
}

export interface PositionBlockDetail {
  text: string;
  items: PositionBlockItem[];
}

/** 纯 JS FNV-1a（positions.ts 被 renderer 以值方式引用，不能引 node:crypto）。 */
function stableHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

type BlockLesson = Pick<PositionLesson, 'content' | 'status'> & { id?: string };

/**
 * 岗位注入块的**条目级**版本（≤1200 字）。优先级：说明 > 规范 > 技能 > 知识 > 经验（各最多 3 条）。
 * 返回的 `items` 只含**真进了文本**的条目（预算整段截断时，后面的不记——注入账不写"没进文"的账）。
 * `positionBlock` 保留为纯文本兼容壳；执行期的新调用点用本函数。
 */
export function positionBlockDetail(
  position: BlockSource,
  lessons: ReadonlyArray<BlockLesson> = [],
  maxChars = POSITION_BLOCK_MAX,
): PositionBlockDetail {
  const name = String(position.name ?? '').trim();
  if (!name) return { text: '', items: [] };
  const accepted = lessons
    .filter((l) => l.status === 'accepted' && String(l.content ?? '').trim())
    .slice(0, POSITION_BLOCK_ITEMS);

  const sections: Array<{
    label: string;
    kind: PositionBlockItemKind;
    joiner: string;
    items: Array<{ text: string; refId: string }>;
  }> = [
    {
      label: '说明', kind: 'description', joiner: '',
      items: String(position.description ?? '').trim()
        ? [{ text: String(position.description).trim(), refId: 'description' }]
        : [],
    },
    {
      label: '规范', kind: 'rule', joiner: '；',
      items: position.rules.slice(0, POSITION_BLOCK_ITEMS).filter((t) => t.trim())
        .map((t) => ({ text: t.trim(), refId: `rule:${stableHash(t.trim())}` })),
    },
    {
      label: '技能', kind: 'skill', joiner: '、',
      items: position.skills.slice(0, POSITION_BLOCK_ITEMS).filter((t) => t.trim())
        .map((t) => ({ text: t.trim(), refId: `skill:${stableHash(t.trim())}` })),
    },
    {
      label: '知识', kind: 'knowledge', joiner: '；',
      items: position.knowledge.slice(0, POSITION_BLOCK_ITEMS).filter((t) => t.trim())
        .map((t) => ({ text: t.trim(), refId: `knowledge:${stableHash(t.trim())}` })),
    },
    {
      label: '经验', kind: 'lesson', joiner: '；',
      items: accepted.map((l) => {
        const text = String(l.content).trim();
        return { text, refId: `lesson:${l.id ?? stableHash(text)}` };
      }),
    },
  ];

  const head = `【岗位】${name}`;
  const lines: string[] = [head];
  let used = head.length;
  const items: PositionBlockItem[] = [];
  for (const section of sections) {
    if (section.items.length === 0) continue;
    const line = `${section.label}：${section.items.map((i) => i.text).join(section.joiner)}`;
    if (used + 1 + line.length > maxChars) break;
    lines.push(line);
    used += 1 + line.length;
    for (const item of section.items) {
      items.push({
        kind: section.kind,
        refId: item.refId,
        chars: item.text.length,
        preview: item.text.slice(0, 80),
      });
    }
  }
  return { text: lines.join('\n'), items };
}

/**
 * 岗位注入块（≤1200 字，纯文本）。优先级：说明 > 规范 > 技能 > 知识 > 经验（各最多 3 条）。
 * `lessons` 由调用方按「最近在前」传入，本函数不读库。**兼容壳**：执行期用 `positionBlockDetail`。
 */
export function positionBlock(
  position: BlockSource,
  lessons: ReadonlyArray<BlockLesson> = [],
  maxChars = POSITION_BLOCK_MAX,
): string {
  return positionBlockDetail(position, lessons, maxChars).text;
}

/**
 * 跨机派发摘要（≤600 字）：只有说明 + 至多 3 条规范。
 * **绝不包含** `knowledge` 与岗位经验——知识与经验不出本机。
 */
export function positionDispatchSummary(position: BlockSource, maxChars = POSITION_DISPATCH_SUMMARY_MAX): string {
  const name = String(position.name ?? '').trim();
  if (!name) return '';
  return buildBoundedBlock(
    `【岗位】${name}`,
    [
      ['说明', position.description],
      ['规范', position.rules.slice(0, POSITION_BLOCK_ITEMS).join('；')],
    ],
    maxChars,
  );
}

/**
 * 洗跨机岗位上下文：`{id,name,version,summary}` 四字段齐全才认；`summary` 再截到上限。
 * 坏形 ⇒ `null`（调用方不落键——"读不懂的对端岗位"不注入）。
 */
export function sanitizeDispatchPosition(raw: unknown): DispatchPosition | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.trim() === '') return null;
  if (typeof o.name !== 'string' || o.name.trim() === '') return null;
  if (typeof o.version !== 'number' || !Number.isFinite(o.version)) return null;
  if (typeof o.summary !== 'string') return null;
  return {
    id: o.id,
    name: o.name,
    version: o.version,
    summary: o.summary.slice(0, POSITION_DISPATCH_SUMMARY_MAX),
  };
}

function scoreKeywords(p: Pick<BlockSource, 'name' | 'skills' | 'knowledge'>): Array<{ word: string; weight: number }> {
  const out: Array<{ word: string; weight: number }> = [];
  if (p.name.trim()) out.push({ word: p.name.trim(), weight: 4 });
  for (const s of p.skills) if (s.trim()) out.push({ word: s.trim(), weight: 2 });
  for (const k of p.knowledge) if (k.trim()) out.push({ word: k.trim(), weight: 1 });
  return out;
}

/**
 * 确定性关键词打分（零 LLM），**只用于建议**，不自动落库。
 * 命中词去重后加权求和；0 分不入结果。排序：分数降序，再按名称。
 */
export function scorePositionsForTask(
  positions: ReadonlyArray<Pick<Position, 'id' | 'name' | 'category' | 'skills' | 'rules' | 'knowledge'>>,
  text: string,
): PositionScore[] {
  const hay = String(text ?? '').toLowerCase();
  if (!hay.trim()) return [];
  const out: PositionScore[] = [];
  for (const p of positions) {
    const hits: string[] = [];
    let score = 0;
    const seen = new Set<string>();
    for (const { word, weight } of scoreKeywords(p)) {
      const w = word.toLowerCase();
      if (w.length < 2 || seen.has(w)) continue;
      if (hay.includes(w)) {
        seen.add(w);
        hits.push(word);
        score += weight;
      }
    }
    const cat = String(p.category ?? '').trim();
    if (cat && cat.length >= 2 && hay.includes(cat.toLowerCase()) && !seen.has(cat.toLowerCase())) {
      hits.push(cat);
      score += 1;
    }
    if (score > 0) out.push({ positionId: p.id, name: p.name, score, hits });
  }
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
}

/* ── 任务指派与收口沉淀 ─────────────────────────────────────────────────── */

/**
 * 建单/派活时的**可指派**判据：岗位存在且启用 ∧ 项目已绑定且启用。
 * 返回 `null` = 不可指派；调用点据此**拒绝建单**，不静默降级成"未指派"（那会让用户以为派上了）。
 */
export function resolveTaskPosition(db: PositionDb, projectId: string, positionId: string): Position | null {
  const proj = String(projectId ?? '').trim();
  const pid = String(positionId ?? '').trim();
  if (!proj || !pid) return null;
  const position = getPosition(db, pid);
  if (!position || !position.enabled) return null;
  const row = db
    .prepare('SELECT enabled FROM wa_project_positions WHERE project_id = ? AND position_id = ?')
    .get(proj, pid) as { enabled?: number } | undefined;
  return row && Number(row.enabled) === 1 ? position : null;
}

/** 任务收口时读任务行：只取沉淀判据需要的列（本模块不拥有 `wa_tasks` 的其他语义）。 */
interface CloseTaskRow {
  id: string;
  project_id?: string | null;
  status?: string | null;
  position_id?: string | null;
  context_json?: string | null;
}

/** 复盘里可迁移教训的形状（只取 lesson/action/reusable，不搬整段复盘）。 */
export interface RetrospectiveLesson {
  content: string;
  reusable: boolean;
}

/**
 * 读该任务**最近一条活着的复盘记忆**，取出结构化 `lesson`（有 `action` 则附上）。
 * 坏 JSON / 无 lesson / 读不到 ⇒ `null`（调用方回退摘要，不编）。
 *
 * zx_20261113_1 B2：这是岗位与项目的分水岭——项目沉淀"这次发生了什么"，
 * 岗位只取复盘里"下次怎么做"的可迁移部分。
 */
export function readRetrospectiveLesson(db: PositionDb, taskId: string): RetrospectiveLesson | null {
  const id = String(taskId ?? '').trim();
  if (!id) return null;
  try {
    const row = db
      .prepare(
        `SELECT context_json FROM wa_memories
          WHERE task_id = ? AND memory_type = 'retrospective' AND ${MEM_LIVE_SQL}
          ORDER BY COALESCE(updated_at, created_at) DESC, rowid DESC
          LIMIT 1`,
      )
      .get(id) as { context_json?: string } | undefined;
    if (!row) return null;
    const ctx = JSON.parse(String(row.context_json ?? '{}')) as {
      retrospective?: { lesson?: unknown; action?: unknown; reusable?: unknown };
    };
    const retro = ctx.retrospective;
    if (!retro || typeof retro.lesson !== 'string') return null;
    const lesson = retro.lesson.trim();
    if (!lesson) return null;
    const action = typeof retro.action === 'string' ? retro.action.trim() : '';
    const canAppend = action !== '' && lesson.length + action.length + '；下次怎么做：'.length <= POSITION_LESSON_MAX;
    return {
      content: (canAppend ? `${lesson}；下次怎么做：${action}` : lesson).slice(0, POSITION_LESSON_MAX),
      // `reusable` 以复盘判定为准；旧复盘缺该键时，有可行动建议即视为可迁移（与 memory-manager 的 A4 同尺）。
      reusable: retro.reusable === true || (retro.reusable === undefined && action !== ''),
    };
  } catch {
    return null;
  }
}

/**
 * 收口从**已完成任务**沉淀一条 `pending` 候选经验（不直接注入；同任务重跑不重复）。
 *
 * 四条准入（缺一不写，如实留空）：
 *   ① 任务指派了岗位，且岗位仍在（删岗后不再沉淀）；
 *   ② `status='completed'`（未完成/归档没有"做完的经验"）；
 *   ③ **非外派**——`assigned_node_id` 非空说明这活是他机干的，经验归他机岗位，不在本机账上；
 *   ④ `acceptance_check` 的结局是 `acceptance_passed`（只是"跑完了"不算数），且有人话摘要。
 *
 * zx_20261113_1 B2：来源**两级**——先取复盘结构化 `lesson/action`（可迁移，`source='retrospective'`），
 *   无复盘才回退收口摘要（`source='summary'`、`reusable=0`，留档但不注入/不晋升）。
 */
export type PositionLessonCandidateBuild =
  | {
      ok: true;
      positionId: string;
      projectId: string;
      content: string;
      source: 'retrospective' | 'summary';
      reusable: boolean;
    }
  | { ok: false; reason: string };

/**
 * 候选的**纯派生**（不写库）：四条准入 + 两级来源，全部在这一处。
 * 脚本 dry-run、rr 诊断与真写入共用同一把尺——不另写一套"预览时宽松"的判据。
 */
export function buildPositionLessonCandidate(db: PositionDb, taskId: string): PositionLessonCandidateBuild {
  const id = String(taskId ?? '').trim();
  if (!id) return { ok: false, reason: 'empty_task_id' };
  const row = db
    .prepare('SELECT id, project_id, status, position_id, context_json FROM wa_tasks WHERE id = ?')
    .get(id) as CloseTaskRow | undefined;
  if (!row) return { ok: false, reason: 'task_not_found' };
  const positionId = String(row.position_id ?? '').trim();
  if (!positionId) return { ok: false, reason: 'not_assigned' };
  if (String(row.status ?? '') !== 'completed') return { ok: false, reason: 'not_completed' };
  if (!getPosition(db, positionId)) return { ok: false, reason: 'position_missing' };
  let ctx: Record<string, unknown>;
  try {
    ctx = JSON.parse(String(row.context_json ?? '{}')) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: 'bad_context_json' };
  }
  if (String(ctx[REMOTE_ASSIGN_NODE_KEY] ?? '').trim()) return { ok: false, reason: 'remote_assigned' };
  // zx_20261112_1 B5：这是**对端岗位**交来的活——工作产物归对端的岗位，不在本机岗位账上沉淀经验。
  if (ctx[DISPATCH_POSITION_KEY] !== undefined) return { ok: false, reason: 'remote_position' };
  if (goalEvidenceOf(ctx.acceptance_check as AcceptanceCheckLike | undefined) !== 'acceptance_passed') {
    return { ok: false, reason: 'acceptance_not_passed' };
  }

  const projectId = String(row.project_id ?? '');
  const retro = readRetrospectiveLesson(db, id);
  if (retro) {
    return { ok: true, positionId, projectId, content: retro.content, source: 'retrospective', reusable: retro.reusable };
  }
  const summary = String(ctx.completion_summary ?? '').trim();
  if (!summary) return { ok: false, reason: 'no_summary' };
  return {
    ok: true, positionId, projectId,
    content: summary.slice(0, POSITION_LESSON_MAX),
    source: 'summary',
    reusable: false,
  };
}

/** 收口写候选：派生后 `INSERT OR IGNORE`（同一任务只一条，人工结论不被覆盖）。 */
export function generatePositionLessonCandidate(db: PositionDb, taskId: string): boolean {
  const built = buildPositionLessonCandidate(db, taskId);
  if (!built.ok) return false;
  return insertPositionLessonCandidate(db, {
    positionId: built.positionId,
    taskId: String(taskId).trim(),
    projectId: built.projectId,
    content: built.content,
    source: built.source,
    reusable: built.reusable,
  });
}

/**
 * 复盘落库之后**精炼**同任务的 pending 候选（内容换成可迁移教训）。
 *
 * 为什么不在收口时一步到位：复盘是 `background-review` 的异步 LLM 作业，收口那一刻它还没跑；
 * 收口先落一条摘要候选保证"有账"，复盘完成后再升级内容。**只动 pending**——
 * 已采纳/已拒绝是人工结论，后台不得改写（夏克特·错误归因：机器不能替人改记忆）。
 * 返回是否真改了一行（无候选时退回生成，仍受四条准入约束）。
 */
export function refinePositionLessonFromRetrospective(db: PositionDb, taskId: string): boolean {
  const id = String(taskId ?? '').trim();
  if (!id) return false;
  const retro = readRetrospectiveLesson(db, id);
  if (!retro) return false;
  const row = db
    .prepare("SELECT id FROM wa_position_lessons WHERE task_id = ? AND status = 'pending' LIMIT 1")
    .get(id) as { id?: string } | undefined;
  if (!row?.id) return generatePositionLessonCandidate(db, id);
  const r = db
    .prepare(
      `UPDATE wa_position_lessons
          SET content = ?, source = 'retrospective', reusable = ?
        WHERE id = ? AND status = 'pending'`,
    )
    .run(retro.content, retro.reusable ? 1 : 0, row.id);
  return r.changes > 0;
}
