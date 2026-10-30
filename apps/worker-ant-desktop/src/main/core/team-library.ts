/**
 * zx_20261017_1 批六（维特根斯坦·意义即使用 / 道德经·不积）: **团队共享库的本地侧**。
 *
 * 三个纯本地动作（网络只在 `ipc/team.ipc.ts`，本模块零 electron、零 fetch ⇒ rr 直跑真实现）：
 *   · `listLocalItems` —— 本机**可分享**的候选（模板 / 记忆 / 成果元数据 / 领域包 / 项目画像）。只读，不上传。
 *   · `shareItem`      —— 从本地行组装一条**载荷**：模板带 subtasks/keywords；记忆带内容；
 *                         成果**只带元数据**（`file_path` 在此剥掉，不入库、不过网）；
 *                         领域包带包体本身（含 `training:false`）；项目画像带画像 JSON（不含本机路径）。
 *   · `importItem`     —— 把远端条目落到本地各自的真落点；id 一律新发，不覆盖本地行。
 *                         **领域包导入≠启用**：只落 `wa_domain_packs` 资产，不写启用映射。
 *                         **画像导入≠启用**：落 `wa_project_profiles(enabled=0, origin='imported')`，
 *                         且**不覆盖**目标已有画像（同版/异版都如实拒，用户可自行重新生成）。
 *
 * ⚠ 上限（200 字符 / 64KB / 单节点 500 条）**不在此判**：唯一写入口是 ANS，判据也在那儿。
 *   本模块只组装，不另造第二套刻度（改上限只改 `@worker-ant/shared-types` 一处）。
 * ⚠ 导入成果**不带文件**：`file_path` 写 NULL、状态 `draft`——它是"有人分享过这份成果"的
 *   元数据，不是一份可打开的本地文件；假装有文件比没有更坏。
 */
import { randomUUID } from 'node:crypto';
import { isTeamItemKind, type TeamItem, type TeamItemKind } from '@worker-ant/shared-types';
// zx_20261021_3 批三: 领域包的**包内结构**只由 `core/domain-pack.ts` 认（本模块不另写一份解析/节词表）。
import { parseDomainPackJson } from './domain-pack.js';
// zx_20261022_3 批八: 画像的结构/校验/落库同出 `core/project-profile.ts`（本模块不另写解析）。
import { insertImportedProfile, parseProjectProfileJson, readProjectProfile } from './project-profile.js';
// zx_20261030_1 M5「限」：用户驱动的记忆导入受档位容量闸（机器写入不在此列——见 §1.4）。
import { resolveLicenseTier } from './license.js';
import { capacityRefusal, countTeamLibraryMemories } from './tier-capacity.js';

/** 最小库接口（可脱 better-sqlite3 被 rr 直跑）。 */
export interface TeamLibraryDb {
  prepare(sql: string): {
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
    run(...args: unknown[]): unknown;
  };
}

/** 一列可分享候选（`title` 上屏；`subtitle` 补一句身份）。 */
export interface LocalTeamItem {
  kind: TeamItemKind;
  localId: string;
  title: string;
  subtitle: string;
}

/** 单列候选上限：够界面用，且不让一屏拖出上千行；超了**如实**给 `truncated`。 */
const CANDIDATE_LIMIT = 200;

export interface LocalCandidates {
  templates: LocalTeamItem[];
  memories: LocalTeamItem[];
  deliverables: LocalTeamItem[];
  /** 领域包（zx_20261021_3 批三）：本机 `wa_domain_packs` 资产，与"已启用"无关。 */
  domainPacks: LocalTeamItem[];
  /** 项目画像（zx_20261022_3 批八）：本机各项目已生成的画像（与"当前是否启用"无关）。 */
  profiles: LocalTeamItem[];
  /** 任一列被 `CANDIDATE_LIMIT` 截断 ⇒ true（界面如实说"还有更多"）。 */
  truncated: boolean;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function jsonArray(v: unknown): unknown[] {
  if (typeof v !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function firstChars(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n);
}

/** 本机可分享的候选（三类各一列）。纯本地读，不触网。 */
export function listLocalItems(db: TeamLibraryDb): LocalCandidates {
  const rows = <T>(sql: string): T[] => db.prepare(sql).all() as T[];
  const templates = rows<{ id: string; name: string; category: string }>(
    'SELECT id, name, category FROM wa_task_templates ORDER BY updated_at DESC, created_at DESC LIMIT 201',
  );
  const memories = rows<{ id: string; content: string; memory_type: string }>(
    'SELECT id, content, memory_type FROM wa_memories ORDER BY importance DESC, updated_at DESC LIMIT 201',
  );
  const deliverables = rows<{ id: string; name: string; type: string; status: string }>(
    'SELECT id, name, type, status FROM wa_deliverables ORDER BY created_at DESC LIMIT 201',
  );
  const domainPacks = rows<{ id: string; name: string; description: string; source_project_name: string }>(
    'SELECT id, name, description, source_project_name FROM wa_domain_packs ORDER BY updated_at DESC, id LIMIT 201',
  );
  // 画像一项目一份：`localId` = `project_id`（PK；分享时据此回查）。
  const profiles = rows<{ project_id: string; project_name: string | null; origin: string; source_project_name: string; generated_at: string }>(
    `SELECT p.project_id, j.name AS project_name, p.origin, p.source_project_name, p.generated_at
       FROM wa_project_profiles p LEFT JOIN wa_projects j ON j.id = p.project_id
      ORDER BY p.generated_at DESC, p.project_id LIMIT 201`,
  );
  const truncated = templates.length > CANDIDATE_LIMIT || memories.length > CANDIDATE_LIMIT
    || deliverables.length > CANDIDATE_LIMIT || domainPacks.length > CANDIDATE_LIMIT
    || profiles.length > CANDIDATE_LIMIT;
  return {
    templates: templates.slice(0, CANDIDATE_LIMIT).map((r) => ({
      kind: 'template',
      localId: r.id,
      title: r.name || '(未命名模板)',
      subtitle: r.category,
    })),
    memories: memories.slice(0, CANDIDATE_LIMIT).map((r) => ({
      kind: 'memory',
      localId: r.id,
      title: firstChars(r.content || '(空记忆)', 80),
      subtitle: r.memory_type,
    })),
    deliverables: deliverables.slice(0, CANDIDATE_LIMIT).map((r) => ({
      kind: 'deliverable',
      localId: r.id,
      title: r.name || r.type,
      subtitle: [r.type, r.status].filter(Boolean).join(' · '),
    })),
    domainPacks: domainPacks.slice(0, CANDIDATE_LIMIT).map((r) => ({
      kind: 'domain_pack',
      localId: r.id,
      title: r.name || '(未命名领域包)',
      subtitle: [r.description, r.source_project_name ? `源自 ${r.source_project_name}` : ''].filter(Boolean).join(' · '),
    })),
    profiles: profiles.slice(0, CANDIDATE_LIMIT).map((r) => ({
      kind: 'project_profile',
      localId: r.project_id,
      title: r.project_name || r.project_id,
      subtitle: [
        r.origin === 'imported' ? (r.source_project_name ? `导入自 ${r.source_project_name}` : '导入画像') : '本机生成',
        r.generated_at,
      ].filter(Boolean).join(' · '),
    })),
    truncated,
  };
}

/** `POST /api/v1/team/items` 的载荷形状：**没有** `source_node_id`（来源由 ANS 从凭据派生）。 */
export interface TeamSharePayload {
  kind: TeamItemKind;
  title: string;
  body: Record<string, unknown>;
}

/** 找不到本地行时如实抛出（IPC 原样上屏，不冒充"分享成功"）。 */
export class TeamLibraryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamLibraryError';
  }
}

/**
 * 从本地行组装共享载荷。
 * ⚠ 成果**绝不**带 `file_path`（不传文件；只在团队库留"曾经有这份成果"的元数据）。
 */
export function shareItem(db: TeamLibraryDb, kind: TeamItemKind, localId: string): TeamSharePayload {
  if (kind === 'template') {
    const row = db
      .prepare('SELECT id, name, category, description, subtasks, keywords FROM wa_task_templates WHERE id = ?')
      .get(localId) as
      | { name: string; category: string; description: string; subtasks: string; keywords: string }
      | undefined;
    if (!row) throw new TeamLibraryError(`模板不存在：${localId}`);
    return {
      kind,
      title: firstChars(row.name || '(未命名模板)', 200),
      body: {
        name: row.name,
        category: row.category,
        description: row.description,
        subtasks: jsonArray(row.subtasks),
        keywords: jsonArray(row.keywords),
      },
    };
  }
  if (kind === 'memory') {
    const row = db
      .prepare('SELECT content, memory_type, importance, reasoning FROM wa_memories WHERE id = ?')
      .get(localId) as { content: string; memory_type: string; importance: number; reasoning: string } | undefined;
    if (!row) throw new TeamLibraryError(`记忆不存在：${localId}`);
    return {
      kind,
      title: firstChars(row.content || '(空记忆)', 200),
      body: {
        content: row.content,
        memory_type: row.memory_type,
        importance: row.importance,
        reasoning: row.reasoning,
      },
    };
  }
  if (kind === 'domain_pack') {
    const row = db
      .prepare('SELECT name, description, pack_json, source_project_name FROM wa_domain_packs WHERE id = ?')
      .get(localId) as { name: string; description: string; pack_json: string; source_project_name: string } | undefined;
    if (!row) throw new TeamLibraryError(`领域包不存在：${localId}`);
    const pack = parseDomainPackJson(row.pack_json);
    // 坏包不冒充可分享：发出去别人也导入不了，等于把损坏转嫁给下一个节点。
    if (!pack || pack.sections.length === 0) throw new TeamLibraryError(`领域包内容不可用：${localId}（包体损坏或为空）`);
    return {
      kind,
      title: firstChars(row.name || pack.name || '(未命名领域包)', 200),
      // 体 = 包本身（含 version/sections/training:false/omitted_sections）；名与描述取库里行（用户可改过）。
      body: {
        version: pack.version,
        name: row.name || pack.name,
        description: row.description || pack.description,
        sections: pack.sections,
        source: pack.source,
        derived_at: pack.derived_at,
        training: false,
        omitted_sections: pack.omitted_sections,
      },
    };
  }
  if (kind === 'project_profile') {
    // `localId` = 项目 id（画像一项目一份）。
    const stored = readProjectProfile(db as never, localId);
    // 无画像/坏 JSON 不冒充可分享：发出去别人也只能判成坏包。
    if (!stored) throw new TeamLibraryError(`项目画像不存在或已损坏：${localId}`);
    const row = db.prepare('SELECT name FROM wa_projects WHERE id = ?').get(localId) as { name?: string } | undefined;
    const projectName = str(row?.name) || localId;
    return {
      kind,
      title: firstChars(projectName, 200),
      // 体只带画像本身与出处项目名——**不含**本机路径、不含本机项目 id 之外的隐私面。
      body: {
        version: stored.profile.version,
        profile: stored.profile,
        source_project_name: projectName,
      },
    };
  }

  const row = db
    .prepare('SELECT type, name, description, status, project_id, task_id FROM wa_deliverables WHERE id = ?')
    .get(localId) as
    | { type: string; name: string; description: string; status: string; project_id: string | null; task_id: string | null }
    | undefined;
  if (!row) throw new TeamLibraryError(`成果不存在：${localId}`);
  return {
    kind: 'deliverable',
    title: firstChars(row.name || row.type || '(未命名成果)', 200),
    // 只共享元数据——`file_path` 刻意不查、不带。
    body: {
      type: row.type,
      name: row.name,
      description: row.description,
      status: row.status,
    },
  };
}

function requireBody(item: TeamItem): Record<string, unknown> {
  const body = item?.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new TeamLibraryError('共享条目缺少可用的 body（ANS 行可能已损坏）');
  }
  return body as Record<string, unknown>;
}

/**
 * 把远端条目落到本地。
 *   template    → `wa_task_templates(source='team_library')`
 *   memory      → `wa_memories(memory_type='semantic', source='team_library')`
 *   deliverable → `wa_deliverables(file_path=NULL, status='draft')`（只元数据）
 *   domain_pack → `wa_domain_packs`（一份新资产；**不**写启用映射，导入≠启用）
 * 返回新行 id 与落点，供界面如实回报。
 */
export function importItem(
  db: TeamLibraryDb,
  item: TeamItem,
  opts: { projectId?: string | null } = {},
): { id: string; kind: TeamItemKind; target: string } {
  const kind = item?.kind;
  if (!isTeamItemKind(kind)) throw new TeamLibraryError(`未知的共享类型：${String(kind)}`);
  const body = requireBody(item);
  const projectId = opts.projectId ?? null;
  const id = randomUUID();

  if (kind === 'template') {
    db.prepare(
      'INSERT INTO wa_task_templates (id, name, category, description, subtasks, keywords, status, priority, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      id,
      str(body.name) || item.title,
      str(body.category) || 'shared',
      str(body.description),
      JSON.stringify(Array.isArray(body.subtasks) ? body.subtasks : []),
      JSON.stringify(Array.isArray(body.keywords) ? body.keywords : []),
      'active',
      0,
      'team_library',
    );
    return { id, kind, target: 'wa_task_templates' };
  }

  if (kind === 'domain_pack') {
    // ⚠ `parseDomainPackJson` 收的是**原始 JSON 串**（它自己 `JSON.parse`）；这里 body 已是对象，
    //   必须序列化再交——直接传对象会被 `String()` 成 `[object Object]` 判成坏包（实测踩过）。
    const pack = parseDomainPackJson(JSON.stringify(body));
    if (!pack || pack.sections.length === 0) {
      throw new TeamLibraryError('共享条目不是合法的领域包（缺 sections 或节名未知）');
    }
    const name = (pack.name || item.title || '(未命名领域包)').slice(0, 120);
    const description = pack.description.slice(0, 300);
    // 来源项目 id 是**分享方本机**的 id，跨机无意义 ⇒ 置空；只留项目名作出处。
    // ⚠ **不写** `wa_project_domain_packs`：导入是"把东西放进库"，启用才是"拿到本项目用"。
    db.prepare(
      `INSERT INTO wa_domain_packs (id, name, description, pack_json, source_project_id, source_project_name, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, ?, datetime('now'), datetime('now'))`,
    ).run(
      id,
      name,
      description,
      JSON.stringify({ ...pack, name, description, source: { project_id: '', project_name: pack.source.project_name } }),
      pack.source.project_name,
    );
    return { id, kind, target: 'wa_domain_packs' };
  }

  if (kind === 'memory') {
    // zx_20261030_1 M5「限」：团队共享库**导入**的记忆总条数（`source='team_library'`）受档位上限约束。
    //   到顶即按本模块既有错误形状拒（`TeamLibraryError`，IPC 原样上屏）；已导入的记忆一条不删。
    const verdict = capacityRefusal(resolveLicenseTier(db), 'maxTeamLibraryMemories', countTeamLibraryMemories(db));
    if (!verdict.ok) throw new TeamLibraryError(verdict.note);
    db.prepare(
      'INSERT INTO wa_memories (id, project_id, task_id, content, memory_type, importance, source, reasoning, updated_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, datetime(\'now\'))',
    ).run(
      id,
      projectId,
      str(body.content) || item.title,
      'semantic',
      num(body.importance, 0.5),
      'team_library',
      str(body.reasoning),
    );
    return { id, kind, target: 'wa_memories' };
  }

  if (kind === 'project_profile') {
    if (!projectId) throw new TeamLibraryError('导入项目画像须指定目标项目（画像依附于本项目，不落全局库）');
    const exists = db.prepare('SELECT 1 AS ok FROM wa_projects WHERE id = ?').get(projectId) as { ok?: number } | undefined;
    if (!exists) throw new TeamLibraryError(`目标项目不存在：${projectId}`);
    // 体形：`{version, profile, source_project_name}`；也接受直接给画像对象（兼容手工载荷）。
    const profile = parseProjectProfileJson(body.profile ?? body);
    if (!profile) throw new TeamLibraryError('共享条目不是合法的项目画像（版本不符或结构缺失）');
    const outcome = insertImportedProfile(db as never, projectId, profile, {
      sourceProjectName: str(body.source_project_name) || item.title,
    });
    // 不覆盖：同版/异版都如实拒（异版可能含目标项目自己的新事实，覆盖代价高）。
    if (outcome === 'conflict') {
      throw new TeamLibraryError('目标项目已有另一版画像——未覆盖（可先删除/重新生成后再导入）');
    }
    if (outcome === 'skipped') {
      throw new TeamLibraryError('目标项目已有同一版画像（内容相同，无需重复导入）');
    }
    // **不启用**：导入只是把画像放进本项目，启用仍是用户在本机的显式动作。
    return { id: projectId, kind, target: 'wa_project_profiles' };
  }

  db.prepare(
    'INSERT INTO wa_deliverables (id, project_id, task_id, type, name, description, file_path, status) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?)',
  ).run(
    id,
    projectId,
    str(body.type) || 'doc',
    str(body.name) || item.title,
    str(body.description),
    'draft',
  );
  return { id, kind, target: 'wa_deliverables' };
}
