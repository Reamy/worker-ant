/**
 * zx_20261022_3 批八（维特根斯坦·意义即使用 / 孟子·尽心上「所过者化，所存者神」）:
 *   **项目画像 v1**——把九节知识书里最该让模型先看的那几样（术语 / 验收 / 配方 / 教训）
 *   压成一屏，并附一份**从已发生事实数出来的运行面**。
 *
 * 为什么要有画像：九节书是给"查"的，画像给"读"的——小模型先看 200 token 的画像，
 *   比在 400 token 的书里随机命中一节更接近"这个项目此刻是什么"。
 *
 * 与既有物的分工（不重抄、不冒充）：
 *   · `project-knowledge.ts` —— 九节册（**唯一取数源**；本模块只读它，不另写 SQL 派生知识）；
 *   · `domain-pack.ts` —— 可携带的三节经验（派生后落资产）；本模块是**本机运行态画像**，
 *     不落资产、不进共享库的"领域包"列（共享走 Team 第五类 `project_profile`）。
 *
 * ⚠ **零 LLM / 零网络 / 零 electron**：rr 可拿内存库直跑真实现。
 * ⚠ **确定性**：同一输入必得同一 JSON（`generatedAt` 是唯一例外）；`sourceHash` 只由输入算，
 *   不含生成时刻——书或统计一变，过期标记即成立。
 * ⚠ **预算不增**：画像注入 ≤ `PROFILE_INJECT_MAX_TOKENS`；知识书余量由消费侧算
 *   （`KNOWLEDGE_INJECT_MAX_TOKENS − 画像实际 token`），合计仍 ≤ 400。
 * ⚠ **行级取舍**：渲染时只整行取舍，**绝不截半句**；被舍掉的行在段末如实交代（若预算容得下）。
 */
import { createHash } from 'node:crypto';
import { listProjectKnowledge, type ProjectKnowledgeEntry } from './project-knowledge.js';
import { estimateTokensFromChars } from './token-estimate.js';

/** 画像格式版本（结构变更时递增；读取侧按版本判能否认识）。 */
export const PROJECT_PROFILE_VERSION = 1;
/** 画像段自身的 token 上界（唯一口径 `estimateTokensFromChars`）。 */
export const PROFILE_INJECT_MAX_TOKENS = 200;
/** 逐节字符上限（超出按**整行**丢弃并记余量，不截半句）。 */
export const PROFILE_TERMS_MAX_CHARS = 300;
export const PROFILE_ACCEPTANCE_MAX_CHARS = 400;
export const PROFILE_RECIPES_MAX_CHARS = 400;
export const PROFILE_LESSONS_MAX_CHARS = 300;
/** 单行摘要上限（防止某条验收标准把一行撑到 2000 字）。 */
export const PROFILE_LINE_MAX_CHARS = 160;

export type ProjectProfileOrigin = 'local' | 'imported';

export interface ProjectProfileRuntime {
  tasks: { total: number; completed: number; failed: number; active: number };
  deliverables: { total: number; byType: Array<{ type: string; count: number }> };
  /** 守护 / MCP / A2A 等外部调用的成败（`wa_service_calls` 按 kind 聚合）。 */
  calls: {
    total: number;
    ok: number;
    failed: number;
    byKind: Array<{ kind: string; calls: number; ok: number; failed: number }>;
  };
  /** 上下文注入笔数（按 `wa_context_injections.source` 分账）。 */
  injections: { knowledge: number; domain_pack: number; memory: number; project_profile: number };
  /** 最近一次执行用过的模型（`wa_tasks.context_json.last_model`；未记为''）。 */
  lastModel: string;
}

export interface ProjectProfile {
  version: number;
  /** 生成时所在项目（导入画像保留**来源**项目 id，作为出处）。 */
  projectId: string;
  generatedAt: string;
  /** 输入指纹（书 + 运行面）；**不含** `generatedAt`。 */
  sourceHash: string;
  terms: string;
  acceptance: string;
  recipes: string;
  runtime: ProjectProfileRuntime;
  lessons: string[];
}

/** 落库行（解析后）。 */
export interface StoredProjectProfile {
  profile: ProjectProfile;
  enabled: boolean;
  origin: ProjectProfileOrigin;
  /** 导入画像的来源项目名（本机生成者为''）。 */
  sourceProjectName: string;
  generatedAt: string;
  sourceHash: string;
}

/** 注入账里的画像条目（`ref_id` = `profile:<hash12>`，即"注入了哪一版画像"）。 */
export interface ProjectProfileInjectionStats {
  injections: number;
  completed: number;
  failed: number;
}

/**
 * 窄面库接口：只列 `prepare`。读/写共用（同 `domain-pack.ts` 的教训：两个 `prepare` 重载相交时
 *   TS 只取首个签名，`run` 会消失）。
 */
export interface ProfileDb {
  prepare(sql: string): {
    all(...args: unknown[]): unknown;
    get(...args: unknown[]): unknown;
    run(...args: unknown[]): { changes: number };
  };
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function clipLine(s: string, max = PROFILE_LINE_MAX_CHARS): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/**
 * 从多行文本里只取**完整行**，直到总字数触顶。
 * 返回 kept 与 droppedLines——"没带走什么"与"带走了什么"同样如实（调用方据此写余量注记）。
 */
function takeLines(text: string, maxChars: number): { kept: string[]; dropped: number } {
  const lines = String(text ?? '').split('\n').map((l) => l.trim()).filter((l) => l !== '');
  const kept: string[] = [];
  let used = 0;
  for (const l of lines) {
    if (used + l.length > maxChars) break;
    kept.push(l);
    used += l.length;
  }
  return { kept, dropped: Math.max(0, lines.length - kept.length) };
}

function withoutTail(kept: string[], dropped: number): string {
  if (kept.length === 0) return '';
  return kept.join('\n') + (dropped > 0 ? `\n（余 ${dropped} 行未收）` : '');
}

function sectionOf(book: ReadonlyArray<ProjectKnowledgeEntry>, section: string): string {
  return book.find((e) => e.section === section)?.content ?? '';
}

/** 只留知识书里画像关心的行（术语/约定/高频实体与关系）。 */
function termsFromBook(book: ReadonlyArray<ProjectKnowledgeEntry>): { value: string; dropped: number } {
  const lines = sectionOf(book, 'domain')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^(术语：|约定：|高频实体：|高频关系：)/.test(l))
    .map((l) => clipLine(l));
  const taken = takeLines(lines.join('\n'), PROFILE_TERMS_MAX_CHARS);
  return { value: withoutTail(taken.kept, taken.dropped), dropped: taken.dropped };
}

/** 验收承诺：知识书 `criteria` 里逐条 `- [status] ...` 的行。 */
function acceptanceFromBook(book: ReadonlyArray<ProjectKnowledgeEntry>): { value: string; dropped: number } {
  const lines = sectionOf(book, 'criteria')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- ['))
    .map((l) => clipLine(l));
  const taken = takeLines(lines.join('\n'), PROFILE_ACCEPTANCE_MAX_CHARS);
  return { value: withoutTail(taken.kept, taken.dropped), dropped: taken.dropped };
}

/** 配方：知识书 `recipes` 的逐行（模板 / 已验证样板）。 */
function recipesFromBook(book: ReadonlyArray<ProjectKnowledgeEntry>): { value: string; dropped: number } {
  const lines = sectionOf(book, 'recipes')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('- '))
    .map((l) => clipLine(l));
  const taken = takeLines(lines.join('\n'), PROFILE_RECIPES_MAX_CHARS);
  return { value: withoutTail(taken.kept, taken.dropped), dropped: taken.dropped };
}

/**
 * 教训：**已发生过的失败**（验收失败因由 + 外部调用失败），不从"建议"里编。
 * 同一事实不重复：按行去重后按出现序保留。
 */
function lessonsFromBook(book: ReadonlyArray<ProjectKnowledgeEntry>): { value: string[]; dropped: number } {
  const out: string[] = [];
  const push = (s: string) => {
    const line = clipLine(s);
    if (line && !out.includes(line)) out.push(line);
  };
  for (const l of sectionOf(book, 'criteria').split('\n')) {
    if (l.trim().startsWith('失败 ')) push(l.trim());
  }
  for (const l of sectionOf(book, 'services').split('\n')) {
    const m = /^(.+?):\s*(\d+)\s*次（成\s*(\d+)\s*\/\s*败\s*(\d+)）/.exec(l.trim());
    if (m && Number(m[4]) > 0) push(`服务「${m[1]}」失败 ${m[4]} 次（共 ${m[2]} 次）`);
  }
  const kept: string[] = [];
  let used = 0;
  for (const l of out) {
    if (used + l.length > PROFILE_LESSONS_MAX_CHARS) break;
    kept.push(l);
    used += l.length;
  }
  return { value: kept, dropped: Math.max(0, out.length - kept.length) };
}

interface TaskCounts {
  total: number;
  completed: number;
  failed: number;
  active: number;
}

function taskCounts(db: ProfileDb, pid: string): TaskCounts {
  const rows = db.prepare(
    'SELECT status, COUNT(*) AS c FROM wa_tasks WHERE project_id = ? GROUP BY status',
  ).all(pid) as Array<{ status: string | null; c: number }>;
  const by = new Map<string, number>();
  for (const r of rows) by.set(str(r.status) || 'unknown', Number(r.c) || 0);
  const completed = by.get('completed') ?? 0;
  const failed = by.get('failed') ?? 0;
  let total = 0;
  for (const n of by.values()) total += n;
  return { total, completed, failed, active: Math.max(0, total - completed - failed) };
}

/**
 * 运行面：全部按 `project_id` 归属（与 `project-knowledge.ts` 同一把尺）。
 * 排序固定（kind/type 字典序），保证同输入同输出。
 */
function collectRuntime(db: ProfileDb, pid: string): ProjectProfileRuntime {
  const deliverableRows = db.prepare(
    `SELECT type, COUNT(*) AS c FROM wa_deliverables
      WHERE project_id = ? GROUP BY type ORDER BY c DESC, type ASC`,
  ).all(pid) as Array<{ type: string | null; c: number }>;
  const byType = deliverableRows.map((r) => ({ type: str(r.type) || '未记', count: Number(r.c) || 0 }));

  const callRows = db.prepare(
    `SELECT kind,
            COUNT(*) AS calls,
            SUM(CASE WHEN ok = 1 THEN 1 ELSE 0 END) AS ok,
            SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failed
       FROM wa_service_calls WHERE project_id = ? GROUP BY kind ORDER BY kind ASC`,
  ).all(pid) as Array<{ kind: string | null; calls: number; ok: number | null; failed: number | null }>;
  const byKind = callRows.map((r) => ({
    kind: str(r.kind) || '未记',
    calls: Number(r.calls) || 0,
    ok: Number(r.ok) || 0,
    failed: Number(r.failed) || 0,
  }));
  const calls = {
    total: byKind.reduce((n, k) => n + k.calls, 0),
    ok: byKind.reduce((n, k) => n + k.ok, 0),
    failed: byKind.reduce((n, k) => n + k.failed, 0),
    byKind,
  };

  const injRows = db.prepare(
    `SELECT i.source AS source, COUNT(*) AS c
       FROM wa_context_injections i JOIN wa_tasks t ON t.id = i.task_id
      WHERE t.project_id = ? GROUP BY i.source ORDER BY i.source ASC`,
  ).all(pid) as Array<{ source: string | null; c: number }>;
  const inj = new Map<string, number>();
  for (const r of injRows) inj.set(str(r.source), Number(r.c) || 0);
  const injections = {
    knowledge: inj.get('knowledge') ?? 0,
    domain_pack: inj.get('domain_pack') ?? 0,
    memory: inj.get('memory') ?? 0,
    project_profile: inj.get('project_profile') ?? 0,
  };

  // 最近模型：只读**最近 20 个带 last_model 的任务**里最新那条；坏 JSON 跳过。
  let lastModel = '';
  const ctxRows = db.prepare(
    `SELECT context_json FROM wa_tasks
      WHERE project_id = ? AND context_json LIKE '%last_model%'
      ORDER BY rowid DESC LIMIT 20`,
  ).all(pid) as Array<{ context_json: string | null }>;
  for (const r of ctxRows) {
    try {
      const o = JSON.parse(str(r.context_json) || '{}') as { last_model?: unknown };
      if (typeof o.last_model === 'string' && o.last_model.trim()) {
        lastModel = clipLine(o.last_model, 100);
        break;
      }
    } catch { /* 坏 JSON ⇒ 继续看下一条（不伪造模型名） */ }
  }

  return {
    tasks: taskCounts(db, pid),
    deliverables: { total: byType.reduce((n, d) => n + d.count, 0), byType },
    calls,
    injections,
    lastModel,
  };
}

/** 输入指纹：书（词表序）+ 运行面（固定排序）。**不含**生成时刻。 */
export function profileSourceHash(
  book: ReadonlyArray<ProjectKnowledgeEntry>,
  runtime: ProjectProfileRuntime,
): string {
  const payload = JSON.stringify({
    book: book.map((e) => [e.section, e.content]),
    runtime,
  });
  return createHash('sha256').update(payload, 'utf-8').digest('hex');
}

/** 当前输入指纹（不生成画像；供过期标记）。 */
export function currentProfileSourceHash(db: ProfileDb, projectId: string): string {
  const pid = String(projectId ?? '');
  return profileSourceHash(listProjectKnowledge(db, pid), collectRuntime(db, pid));
}

/**
 * **生成画像**（纯函数式：只读库，不写）。空册且无任何运行事实 ⇒ `ok:false`
 * （"没得画"是如实值，不伪造一份全空的画像）。
 */
export function buildProjectProfile(
  db: ProfileDb,
  projectId: string,
  opts: { now?: string } = {},
): { ok: true; profile: ProjectProfile } | { ok: false; reason: string } {
  const pid = String(projectId ?? '');
  if (!pid) return { ok: false, reason: '缺少项目 id' };
  const book = listProjectKnowledge(db, pid);
  const runtime = collectRuntime(db, pid);
  if (book.length === 0 && runtime.tasks.total === 0 && runtime.deliverables.total === 0 && runtime.calls.total === 0) {
    return { ok: false, reason: '本项目暂无可生成画像的事实（知识册与运行面都为空）' };
  }
  const terms = termsFromBook(book);
  const acceptance = acceptanceFromBook(book);
  const recipes = recipesFromBook(book);
  const lessons = lessonsFromBook(book);
  return {
    ok: true,
    profile: {
      version: PROJECT_PROFILE_VERSION,
      projectId: pid,
      generatedAt: opts.now ?? new Date().toISOString(),
      sourceHash: profileSourceHash(book, runtime),
      terms: terms.value,
      acceptance: acceptance.value,
      recipes: recipes.value,
      runtime,
      lessons: lessons.value,
    },
  };
}

/**
 * 校验一段画像 JSON（坏即 `null`，调用方不伪造空画像）。
 * 导入/共享/落库读侧都走这一处。
 */
export function parseProjectProfileJson(raw: unknown): ProjectProfile | null {
  try {
    const o = JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) as Partial<ProjectProfile>;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
    if (Number(o.version) !== PROJECT_PROFILE_VERSION) return null;
    if (typeof o.projectId !== 'string') return null;
    const rt = o.runtime as Partial<ProjectProfileRuntime> | undefined;
    if (!rt || typeof rt !== 'object') return null;
    const runtime: ProjectProfileRuntime = {
      tasks: {
        total: Number(rt.tasks?.total) || 0,
        completed: Number(rt.tasks?.completed) || 0,
        failed: Number(rt.tasks?.failed) || 0,
        active: Number(rt.tasks?.active) || 0,
      },
      deliverables: {
        total: Number(rt.deliverables?.total) || 0,
        byType: Array.isArray(rt.deliverables?.byType)
          ? rt.deliverables!.byType
              .filter((d) => d && typeof d.type === 'string')
              .map((d) => ({ type: String(d.type), count: Number(d.count) || 0 }))
          : [],
      },
      calls: {
        total: Number(rt.calls?.total) || 0,
        ok: Number(rt.calls?.ok) || 0,
        failed: Number(rt.calls?.failed) || 0,
        byKind: Array.isArray(rt.calls?.byKind)
          ? rt.calls!.byKind
              .filter((k) => k && typeof k.kind === 'string')
              .map((k) => ({
                kind: String(k.kind),
                calls: Number(k.calls) || 0,
                ok: Number(k.ok) || 0,
                failed: Number(k.failed) || 0,
              }))
          : [],
      },
      injections: {
        knowledge: Number(rt.injections?.knowledge) || 0,
        domain_pack: Number(rt.injections?.domain_pack) || 0,
        memory: Number(rt.injections?.memory) || 0,
        project_profile: Number(rt.injections?.project_profile) || 0,
      },
      lastModel: typeof rt.lastModel === 'string' ? rt.lastModel : '',
    };
    return {
      version: PROJECT_PROFILE_VERSION,
      projectId: o.projectId,
      generatedAt: str(o.generatedAt),
      sourceHash: str(o.sourceHash),
      terms: str(o.terms),
      acceptance: str(o.acceptance),
      recipes: str(o.recipes),
      runtime,
      lessons: Array.isArray(o.lessons) ? o.lessons.filter((l): l is string => typeof l === 'string') : [],
    };
  } catch {
    return null;
  }
}

/**
 * 保存画像（**幂等 upsert**）。`enabled` 只在**首次插入**时生效——刷新不改变用户的启用选择；
 * 重新生成会把 `origin` 落回 `local`（画的是本机事实了，不再冒充外部导入）。
 */
export function saveProjectProfile(
  db: ProfileDb,
  profile: ProjectProfile,
  opts: { enabled?: boolean } = {},
): void {
  db.prepare(
    `INSERT INTO wa_project_profiles
       (project_id, version, source_hash, profile_json, generated_at, enabled, origin, source_project_name)
     VALUES (?, ?, ?, ?, ?, ?, 'local', '')
     ON CONFLICT(project_id) DO UPDATE SET
       version = excluded.version,
       source_hash = excluded.source_hash,
       profile_json = excluded.profile_json,
       generated_at = excluded.generated_at,
       origin = 'local',
       source_project_name = ''`,
  ).run(
    profile.projectId,
    profile.version,
    profile.sourceHash,
    JSON.stringify(profile),
    profile.generatedAt || new Date().toISOString(),
    opts.enabled === false ? 0 : 1,
  );
}

/** 导入画像（落目标项目，**缺省不启用**——导入≠启用）。不覆盖目标已有画像。 */
export function insertImportedProfile(
  db: ProfileDb,
  targetProjectId: string,
  profile: ProjectProfile,
  opts: { sourceProjectName?: string } = {},
): 'imported' | 'skipped' | 'conflict' {
  const pid = String(targetProjectId ?? '');
  const existing = db.prepare(
    'SELECT source_hash FROM wa_project_profiles WHERE project_id = ?',
  ).get(pid) as { source_hash?: string } | undefined;
  if (existing) {
    return String(existing.source_hash ?? '') === profile.sourceHash ? 'skipped' : 'conflict';
  }
  db.prepare(
    `INSERT INTO wa_project_profiles
       (project_id, version, source_hash, profile_json, generated_at, enabled, origin, source_project_name)
     VALUES (?, ?, ?, ?, ?, 0, 'imported', ?)`,
  ).run(
    pid,
    profile.version,
    profile.sourceHash,
    JSON.stringify(profile),
    profile.generatedAt || new Date().toISOString(),
    opts.sourceProjectName ?? '',
  );
  return 'imported';
}

/** 读某项目画像（坏 JSON ⇒ `null`，不伪造）。 */
export function readProjectProfile(db: ProfileDb, projectId: string): StoredProjectProfile | null {
  const row = db.prepare(
    `SELECT profile_json, enabled, origin, source_project_name, generated_at, source_hash
       FROM wa_project_profiles WHERE project_id = ?`,
  ).get(String(projectId ?? '')) as
    | {
        profile_json: string;
        enabled: number;
        origin: string;
        source_project_name: string;
        generated_at: string;
        source_hash: string;
      }
    | undefined;
  if (!row) return null;
  const profile = parseProjectProfileJson(row.profile_json);
  if (!profile) return null;
  return {
    profile,
    enabled: Number(row.enabled) === 1,
    origin: row.origin === 'imported' ? 'imported' : 'local',
    sourceProjectName: str(row.source_project_name),
    generatedAt: str(row.generated_at),
    sourceHash: str(row.source_hash),
  };
}

/** 开关画像（只改 `enabled`；返回是否真改了一行）。 */
export function setProjectProfileEnabled(db: ProfileDb, projectId: string, enabled: boolean): boolean {
  const r = db.prepare(
    'UPDATE wa_project_profiles SET enabled = ? WHERE project_id = ?',
  ).run(enabled ? 1 : 0, String(projectId ?? ''));
  return r.changes > 0;
}

/** 画像的注入账（`source='project_profile'`）——有写口就必须有读口。 */
export function profileInjectionStats(db: ProfileDb, projectId: string): ProjectProfileInjectionStats {
  const row = db.prepare(
    `SELECT COUNT(*) AS n,
            SUM(CASE WHEN i.outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN i.outcome = 'failed' THEN 1 ELSE 0 END) AS failed
       FROM wa_context_injections i JOIN wa_tasks t ON t.id = i.task_id
      WHERE i.source = 'project_profile' AND t.project_id = ?`,
  ).get(String(projectId ?? '')) as { n: number; completed: number | null; failed: number | null } | undefined;
  return {
    injections: Number(row?.n ?? 0),
    completed: Number(row?.completed ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}

/** `profile:<hash12>`——注入账的 `ref_id`；"注入了哪一版画像"可回查。 */
export function profileRefId(profile: ProjectProfile): string {
  return `profile:${String(profile.sourceHash ?? '').slice(0, 12)}`;
}

/**
 * 渲染注入段：**整行取舍**，装不下就停；若有行被舍掉，尽量在预算内如实交代余量。
 * 返回文本与折算 token（`estimateTokensFromChars` 唯一口径）；一行都装不下 ⇒ `null`。
 */
export function renderProjectProfile(
  profile: ProjectProfile,
  tokenBudget: number = PROFILE_INJECT_MAX_TOKENS,
): { text: string; tokens: number } | null {
  const lines: string[] = ['## 项目画像'];
  if (profile.terms) lines.push('术语与约定：', profile.terms);
  if (profile.acceptance) lines.push('验收承诺：', profile.acceptance);
  if (profile.recipes) lines.push('常用配方：', profile.recipes);
  if (profile.lessons.length > 0) {
    lines.push('已发生的教训：');
    for (const l of profile.lessons) lines.push(`- ${l}`);
  }
  const rt = profile.runtime;
  const rtParts: string[] = [];
  if (rt.tasks.total > 0) {
    rtParts.push(`任务 ${rt.tasks.total}（完成 ${rt.tasks.completed} / 失败 ${rt.tasks.failed} / 进行中 ${rt.tasks.active}）`);
  }
  if (rt.deliverables.total > 0) {
    rtParts.push(`交付 ${rt.deliverables.total} 件${rt.deliverables.byType.length > 0 ? `（${rt.deliverables.byType.map((d) => `${d.type}:${d.count}`).join(' · ')}）` : ''}`);
  }
  if (rt.calls.total > 0) {
    rtParts.push(`外部调用 ${rt.calls.total}（成功 ${rt.calls.ok} / 失败 ${rt.calls.failed}）`);
  }
  if (rt.lastModel) rtParts.push(`最近模型 ${rt.lastModel}`);
  if (rtParts.length > 0) lines.push('运行面：', ...rtParts.map((p) => `- ${p}`));

  const kept: string[] = [];
  for (const line of lines) {
    const tentative = [...kept, line];
    const hasMore = lines.length > tentative.length;
    const text = tentative.join('\n') + (hasMore ? '\n…（余部未注入）' : '');
    if (estimateTokensFromChars(text.length) > tokenBudget) break;
    kept.push(line);
  }
  if (kept.length === 0) return null;
  const dropped = lines.length - kept.length;
  const text = kept.join('\n') + (dropped > 0 ? '\n…（余部未注入）' : '');
  return { text, tokens: estimateTokensFromChars(text.length) };
}
