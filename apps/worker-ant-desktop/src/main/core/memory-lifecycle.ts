/**
 * zx_20260930 M8（空性·无常 / 维特根斯坦·一个规则一处）: **记忆的生命周期分级与墓碑**。
 *
 * 病根（三条独立，同批治）：
 * ① **删除即湮灭**：`ipc/admin.ipc.ts` 的 `DELETE FROM wa_memories WHERE id = ?` 是**物理删**——
 *    行没了，于是"这条被删过"这一事实也随之消失。机器（`background-review` 的 LLM 提取、
 *    `promoteWorkingMemory` 的工作笔记沉淀）下次照样把同一段内容**原样重新提取回来**：
 *    用户的"删"在机器眼里等于从未发生，且**删除不可追溯**（连删过什么都不记得）。
 * ② **归档是一根绳子上的两个概念**：既有实现把"归档"当作 `memory_type` 的一个**取值**（哨兵），
 *    与 `episodic/semantic/...` 这些**类型**挤在同一列；于是"这条记忆活到哪一级了"没有一张表说得清，
 *    各级的**检索可见性**也没有一处被明确写下——只能靠散在十几条 SQL 里的 `!= 'archived'` 各自为政
 *    （本轮新增墓碑哨兵的第一处漏点，正是那些手抄的 `!= 'archived'`）。
 * ③ **保留期届满即消失**：`pruneArchivedMemory` 到了 90 天也是**物理删**——"它去哪了"无处可查。
 *
 * 本模块是**零依赖纯模块**（不引 electron / better-sqlite3 / node:*），故：
 * ① 可被受控回归直引跑真实现（同 memory-decay / memory-select 范式，G-1 不自造等价物）；
 * ② 可被渲染层跨 root 直引（分级词表**不在渲染层手抄第二份**）。
 *
 * ⚠ 本文件**不 import `memory-decay.ts`**（虽然那里有 `dbTimeMs`）：分级要判"多久没被取用"，
 *   而"时间基准"这一概念本轮已由 M6 收口到三戳（`last_used_at`/`last_reinforced_at`/`created_at`，
 *   `updated_at` 永不参与）。此处**只用同一套戳**，但解析实现**就地带一份最小的**——
 *   为的是让本模块保持"零 import"，同时**不改动 M6 已钉死的那一处真源**。
 *   两份 `parseUtcMs` 逐位等价（M8 的 rr 判据对该等价性有正面断言：同一批字面量两侧同值）。
 */

// ==================== 一、哨兵与"哪些是活的" ====================

/** 归档哨兵（历史既有：写在 `memory_type` 列上的一个**取值**，不是独立列）。 */
export const MEM_TYPE_ARCHIVED = 'archived';
/** 墓碑哨兵（本轮新增，同族写法）。 */
export const MEM_TYPE_DELETED = 'deleted';

/** 拼一个 `memory_type NOT IN (...)` 片段——名单**只此一处**构造，杜绝手抄漏项。 */
export function memTypeNotInSql(...types: string[]): string {
  return `memory_type NOT IN (${types.map((t) => `'${t}'`).join(', ')})`;
}

/**
 * ★**「哪些记忆还活着」的唯一一份 SQL 片段**。
 *
 * 一切读取点（检索 / 注入 / 统计 / 列表 / 整合）的 WHERE 都引它，不再各自手抄 `!= 'archived'`——
 * 手抄者必漏 `'deleted'`，而漏项的后果不是报错而是**墓碑被当活记忆注入**（静默、且方向恰是相反的）。
 *
 * ⚠ 引用时须**原样内插**：`\`... WHERE project_id = ? AND ${MEM_LIVE_SQL}\``。
 *   有齿退出码的静态判据（本轮 rr 的 G-c 组）就是按这条形状数的。
 */
export const MEM_LIVE_SQL = memTypeNotInSql(MEM_TYPE_ARCHIVED, MEM_TYPE_DELETED);

// ==================== 二、生命周期分级（四处，各有其检索可见性）====================

export type MemoryGrade = 'active' | 'cooling' | 'archived' | 'deleted';

export interface MemoryGradeSpec {
  grade: MemoryGrade;
  /** 用户可见中文名（唯一的词表落点，渲染层直引本模块，不手抄） */
  label: string;
  /** 语义（写在这里，不散在注释里） */
  meaning: string;
  /** 是否参与检索/注入（`MEM_LIVE_SQL` 就是这一列前两行与后两行的分界） */
  retrievalVisible: boolean;
  /** GUI 常规列表是否显示 */
  guiVisible: boolean;
  /** 审计面（"去向可查"）是否显示 */
  auditVisible: boolean;
}

/**
 * 四级清单——**唯一一份**。`retrievalVisible` 是 `MEM_LIVE_SQL` 的**语义侧说明**：
 * 前两条可见、后两条不可见。两侧若不一致，以本表为准去改 `MEM_LIVE_SQL`（同一个概念两处写法即本轮要治的病）。
 */
export const MEM_GRADES: readonly MemoryGradeSpec[] = [
  {
    grade: 'active', label: '活跃', meaning: '新建或近期被取用，正常参与检索与注入。',
    retrievalVisible: true, guiVisible: true, auditVisible: false,
  },
  {
    grade: 'cooling', label: '冷却', meaning: '已超过冷却期未被取用；**仍参与检索**，只是排序上让位于更新近的。',
    retrievalVisible: true, guiVisible: true, auditVisible: false,
  },
  {
    grade: 'archived', label: '归档', meaning: '整合管道判为低价值/过期而退出检索；**可恢复**（改回类型即回到检索面）。',
    retrievalVisible: false, guiVisible: true, auditVisible: false,
  },
  {
    grade: 'deleted', label: '墓碑', meaning: '已删除：只留 id / 时刻 / 缘由，**永不参与检索、不可恢复**，只在审计面可查。',
    retrievalVisible: false, guiVisible: false, auditVisible: true,
  },
];

/** 冷却期（天）：距"最后一次被取用（无则创建）"超过此天数 ⇒ 判「冷却」。同一时刻只此一个数。 */
export const MEM_COOLING_AFTER_DAYS = 30;

export function gradeSpec(grade: MemoryGrade): MemoryGradeSpec {
  return MEM_GRADES.find((g) => g.grade === grade) ?? MEM_GRADES[0]!;
}

/** 最小时间戳解析（与 `memory-decay.ts` 的 `dbTimeMs` 逐位等价；见文件头②）。 */
function parseUtcMs(raw: string | null | undefined): number {
  if (!raw) return NaN;
  const s = String(raw).trim();
  if (!s) return NaN;
  const iso = /[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s.replace(' ', 'T')}Z`;
  return Date.parse(iso);
}

/**
 * 从一行的**语义时间戳**推出分级。`nowMs` 必传（判据不依赖真实墙钟，G-4）。
 *
 * 时间基准取 `last_used_at || created_at`——问的是"**多久没被取用**"，故**不读 `updated_at`**
 * （M6 已钉死：系统写会刷新它，拿它当年龄即名实不符）。读不到时间 ⇒ 判「活跃」：
 * **宁可少标"冷"，不可把读不到当成冷**。
 */
export function gradeOf(
  row: { memory_type?: string | null; created_at?: string | null; last_used_at?: string | null },
  nowMs: number,
): MemoryGrade {
  const t = String(row.memory_type ?? '');
  if (t === MEM_TYPE_DELETED) return 'deleted';
  if (t === MEM_TYPE_ARCHIVED) return 'archived';
  const ms = parseUtcMs(row.last_used_at || row.created_at || null);
  if (!Number.isFinite(ms)) return 'active';
  return (nowMs - ms) / 86_400_000 > MEM_COOLING_AFTER_DAYS ? 'cooling' : 'active';
}

/** 与 `dbTimeMs` 的等价性自证用（rr 拿同一批字面量两侧对表；生产不消费）。 */
export function _parseUtcMsForEquivalence(raw: string | null | undefined): number {
  return parseUtcMs(raw);
}

// ==================== 三、墓碑：删了要留痕，且不许自己回来 ====================

/** 删除缘由词表——**唯一一份**（审计面直接显示这些串）。 */
export const MEM_DELETE_REASONS = {
  /** 记忆页的单条删除 */
  userMemory: '用户删除（记忆页）',
  /** 偏好页的单条删除 */
  userPreference: '用户删除（偏好）',
  /** 随项目删除级联 */
  projectCascade: '随项目删除',
  /** 随任务删除级联 */
  taskCascade: '随任务删除',
  /** 归档保留期届满（原为物理删，本轮改落墓碑） */
  retention: '归档保留期届满',
} as const;

/**
 * 整合（consolidate）合并后，被并入方的删除缘由。
 *
 * zx_20261012_1 批一（M29 墓碑纪律）：`consolidateMemories` 原为**物理删**被并入的那条，
 * 于是"它被并进谁"这一事实随之消失（审计面看不到去向）。改落墓碑后，缘由**指向承接正文的那条**——
 * 于是"这条去哪了"可答："并进了 `<targetId>`"。正文并未丢失（已融进承接行），故这不是湮灭，
 * 只是**同一份正文的一处新落点**；钉住 targetId 使这条墓碑可被反查（谁吸收了它）。
 */
export function consolidatedIntoReason(targetId: string): string {
  return `consolidated-into:${targetId}`;
}

/** 需要的库接口（最小面：使本模块可脱 better-sqlite3 在受控回归里跑真逻辑）。 */
export interface MemoryLifecycleDb {
  prepare(sql: string): {
    run(...args: unknown[]): { changes?: number };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

/** UTC 时刻串，格式与库内 `datetime('now')` **逐字一致**（`YYYY-MM-DD HH:MM:SS`），可注入以便判据确定化。 */
export function utcNowIso(nowMs: number = Date.now()): string {
  return new Date(nowMs).toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * 内容指纹（归一化后 djb2，稳定、无依赖）——墓碑据此拦截"删掉的内容又被机器重新提取回来"。
 * 归一化（折叠空白 + 小写 + 去首尾）使换行/大小写差异不构成"另一条内容"。
 * 尾部附长度，让"同哈希不同长"（碰撞）在判据里可被察觉而非静默同化。
 */
export function contentFingerprint(text: string): string {
  const s = (text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${(Math.abs(h) >>> 0).toString(36)}:${s.length.toString(36)}`;
}

/** 墓碑写入的**唯一**语句形状（正文清空、嵌入清空，只留 id/时刻/缘由/指纹）。 */
const TOMBSTONE_UPDATE_SQL =
  `UPDATE wa_memories SET memory_type = ?, deleted_at = ?, deleted_reason = ?, deleted_fingerprint = ?, ` +
  `content = '', embedding = NULL WHERE id = ? AND ${memTypeNotInSql(MEM_TYPE_DELETED)}`;

/**
 * 落一条墓碑（单条）。返回是否真改到行（已是墓碑 ⇒ false，**不覆盖第一次的缘由与时刻**）。
 *
 * 为什么要清空正文：墓碑不搬运内容——正文既是体积的大头，也正是"删了又回来"的唯一载体。
 * 清空后即便某条读取点漏了 `MEM_LIVE_SQL`，被漏掉的也只是**一条空正文**，不会把删掉的东西重新注入。
 */
export function tombstoneMemory(
  db: MemoryLifecycleDb,
  id: string,
  reason: string,
  nowMs: number = Date.now(),
): boolean {
  try {
    const row = db.prepare('SELECT content FROM wa_memories WHERE id = ?').get(id) as { content?: string } | undefined;
    if (!row) return false;
    const r = db.prepare(TOMBSTONE_UPDATE_SQL).run(
      MEM_TYPE_DELETED, utcNowIso(nowMs), reason, contentFingerprint(row.content ?? ''), id,
    );
    return (r?.changes ?? 0) > 0;
  } catch {
    return false;
  }
}

/**
 * 级联落墓碑（随项目/任务删除）。`column` 只接受两个**白名单列名**（防拼接进 SQL 的任意串）。
 * 返回落墓条数。逐行取正文算指纹，再逐行改写——级联规模是"一个项目/任务的记忆数"，可控。
 *
 * ⚠ **落墓后必须断开 `column` 上的父引用**（置 NULL）——本函数是"**父行即将被删**"的级联：
 *   墓碑行留着，而 `wa_memories.project_id REFERENCES wa_projects(id)` 这条外键会当场拦住父行的
 *   `DELETE`（父行还有子行指着它）。**实测**：`project:delete` 对**任何含记忆的项目**恒
 *   `FOREIGN KEY constraint failed`——即"删项目"自外键开启以来从未成功过一次（`zs_20261012_1`
 *   批四实机 E2E 照出，此前 rr 夹具**刻意省掉**该 FK 故全绿）。
 *   置 NULL 不动"账必有痕"：墓碑的账是 **id + deleted_at + deleted_reason + deleted_fingerprint**，
 *   归属由 `deleted_reason`（"随项目删除"）记着，不靠一条指向已亡父行的外键。
 */
export function tombstoneMemoriesBy(
  db: MemoryLifecycleDb,
  column: 'project_id' | 'task_id',
  value: string,
  reason: string,
  nowMs: number = Date.now(),
): number {
  if (column !== 'project_id' && column !== 'task_id') return 0;
  try {
    const rows = db.prepare(
      `SELECT id FROM wa_memories WHERE ${column} = ? AND ${memTypeNotInSql(MEM_TYPE_DELETED)}`,
    ).all(value) as Array<{ id: string }>;
    let n = 0;
    for (const r of rows) {
      if (tombstoneMemory(db, r.id, reason, nowMs)) {
        n++;
        // 断开父引用（父行随后即删）：`column` 已在白名单内，可安全内插。
        db.prepare(`UPDATE wa_memories SET ${column} = NULL WHERE id = ?`).run(r.id);
      }
    }
    return n;
  } catch {
    return 0;
  }
}

/**
 * 归档保留期届满 ⇒ 落墓碑（**原为物理删**）。返回落墓条数。
 * `retentionDays <= 0` ⇒ 关闭（与 `memory.archive_retention_days` 的 0=关 语义同源）。
 *
 * ⚠ 语义变更（如实登记）：本函数**不再减少行数**——它把"归档"推进到"墓碑"，
 *   回收的是**正文体积**（墓碑正文为空），留下的是**去向**。这正是 M8 要的"清理前须有可查的去向"。
 */
export function tombstoneExpiredArchived(
  db: MemoryLifecycleDb,
  retentionDays: number,
  reason: string = MEM_DELETE_REASONS.retention,
  nowMs: number = Date.now(),
): number {
  if (!(retentionDays > 0)) return 0;
  const cutoff = utcNowIso(nowMs - retentionDays * 86_400_000);
  try {
    const rows = db.prepare(
      `SELECT id FROM wa_memories WHERE memory_type = ? AND created_at < ?`,
    ).all(MEM_TYPE_ARCHIVED, cutoff) as Array<{ id: string }>;
    let n = 0;
    for (const r of rows) {
      if (tombstoneMemory(db, r.id, reason, nowMs)) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

export interface TombstoneRow {
  id: string;
  project_id: string | null;
  task_id: string | null;
  deleted_at: string;
  deleted_reason: string;
}

/** **去向可查**：墓碑清单（审计面）。按删除时刻倒序；`projectId` 省略即全库。 */
export function listTombstones(
  db: MemoryLifecycleDb,
  projectId?: string | null,
  limit = 100,
): TombstoneRow[] {
  try {
    const lim = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 100;
    const base =
      `SELECT id, project_id, task_id, deleted_at, deleted_reason FROM wa_memories WHERE memory_type = ?`;
    const rows = projectId
      ? db.prepare(`${base} AND project_id = ? ORDER BY deleted_at DESC, rowid DESC LIMIT ?`).all(MEM_TYPE_DELETED, projectId, lim)
      : db.prepare(`${base} ORDER BY deleted_at DESC, rowid DESC LIMIT ?`).all(MEM_TYPE_DELETED, lim);
    return rows as TombstoneRow[];
  } catch {
    return [];
  }
}

/**
 * 墓碑是否拦截这条内容——**机器不得把用户删掉的东西自己找回来**。
 *
 * 作用面刻意只在机器写入侧（`storeText`）：用户显式新增（`preferences:create` / `memory:create`
 * 走的是直插）**不受拦**——**人说了算**。同项目内、指纹一致即拦；跨项目不拦
 * （"在甲项目删掉的东西"不构成"乙项目不许学"的理由）。
 */
export function tombstoneBlocksContent(
  db: MemoryLifecycleDb,
  projectId: string | null | undefined,
  content: string,
): boolean {
  try {
    const fp = contentFingerprint(content);
    const row = db.prepare(
      `SELECT 1 FROM wa_memories WHERE memory_type = ? AND project_id IS ? AND deleted_fingerprint = ? LIMIT 1`,
    ).get(MEM_TYPE_DELETED, projectId ?? null, fp);
    return !!row;
  } catch {
    return false;
  }
}

// ==================== 四、同源替换有界（防线性膨胀）====================

/** 同源替换的正文上限（字）。超出则折叠更早的部分。 */
export const MEM_SAME_SOURCE_MAX_CHARS = 2000;

/** 折叠说明的生成（唯一一份；`folded` 为被折叠掉的**字数**）。 */
export function memFoldNote(folded: number): string {
  return `（更早的 ${folded} 字已折叠）`;
}

/**
 * 有界合并：`prev` + `[标签]` + `next`，超过 `maxChars` 则**保留最近 `maxChars` 字**、
 * 把更早的部分折成一行计数（`memFoldNote`）。
 *
 * 为什么留**尾部**而非头部：`sameSourceReplace` 的语义是"新搜索结果**覆盖**旧同源记忆"，
 * 越靠后即越新的认识 ⇒ 折叠时弃早留新才与语义同向。
 * 不变式：返回值长度 ≤ `maxChars + memFoldNote(9位数).length`（有界，反复追加不增长）；
 * 且未超限时**逐字等于**旧写法（零行为变化）。
 */
export function boundedSameSource(
  prev: string,
  next: string,
  opts: { maxChars?: number; label?: string } = {},
): string {
  const maxChars = Number.isFinite(opts.maxChars) && (opts.maxChars as number) > 0
    ? Math.floor(opts.maxChars as number) : MEM_SAME_SOURCE_MAX_CHARS;
  const label = opts.label ?? '更新';
  const merged = `${prev}\n[${label}]\n${next}`;
  if (merged.length <= maxChars) return merged;
  const tail = merged.slice(merged.length - maxChars);
  return memFoldNote(merged.length - tail.length) + tail;
}
