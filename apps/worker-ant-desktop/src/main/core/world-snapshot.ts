/**
 * B2: 世界模型快照与一致性校验（从原工蚁 world-snapshot.ts 移植）。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { tagWithRun } from './run-trace.js';
import { createLogger } from './logger.js';
import { buildPlanMilestoneLine } from './project-analytics.js';
import { walkWorkingDir, type WorkingFile } from './working-dir-walk.js';
// ⚠ 与 `working-dir-scan-cache` 互为 import（它要 `scanWorkingDirOnce`，本文件要 `factListingCached`）：
//   两侧只在**函数体内**读对方绑定、顶层不求值 ⇒ ESM 循环安全（与 `exec-finalize` 回引 `agent-executor` 同形）。
import { factListingCached } from './working-dir-scan-cache.js';

const logger = createLogger('world-snapshot');

/**
 * 跳过的大目录（版本控制/虚拟环境/IDE/缓存/构建产物）。
 *
 * zx_20260923 M5-b（G10）：补 `target`（Maven/Gradle/Cargo 的构建产物目录）。
 * 三个落点**同吃这一份**：① 定义（本行）；② `isSampledWorkingFile`（其两个消费者 = `captureWorldSnapshot`
 * 审计快照，与 `listFilesWrittenSince` 命令窗口落盘登记）；③ `generateFactSnapshot` 的目录树遍历（按 `e.name` 试）。
 * 与既有 `dist`/`build`/`output` 同款取舍：**生成物不进采样面**——收窄的是采样面，不是"看不见就没事"。
 */
const SKIP_DIRS = /(?:^|\/)(\.git|\.venv|\.venv_\w+|venv|\.github|\.idea|__pycache__|node_modules|_image|output|\.mypy_cache|\.pytest_cache|\.tox|\.eggs|dist|build|target)(?:\/|$)/;

/** M3: 文件采样上限——**截断只作用于 `fileHashes` 样本**，`fileCount` 始终记真实总数（见 `captureWorldSnapshot`）。
 *  与文案、受控回归共用同一常量，不各写一个 2000。 */
export const SNAPSHOT_FILE_LIMIT = 2000;
/** M3: 大批变更时在告警里列出的条数上限（完整清单落盘 `world-snapshot-diffs/<taskId>.json`） */
export const SNAPSHOT_LIST_LIMIT = 10;

/**
 * zx_20260922_1 M5（F7）：「快照截断 ⇒ 未做增删判定」这条结论的**唯一**标记。
 *
 * 它是**如实说明**（"没做判断"），不是**发现**（"有不一致"）——二者此前共用一条 `[WARN]` 通道，
 * 而大工作树（本任务 8980 文件 > 上限）**恒走截断** ⇒ 每一轮都吃一条恒真告警（狼来了）。
 * `compareSnapshots` 产出这个标记，`auditWorldConsistency` 据它把结论分到 info / warn 两级。
 * ⚠ 不要去改 `compareSnapshots` 的**判定行为**（截断即放弃增删判定是对的，`zx_20260916_3 M3①` 立下的），
 * 本批只分开**输出的去处**。
 */
export const TRUNCATION_ISSUE_PREFIX = '[快照已截断]';

/** 从 `path:size` 哈希还原相对路径 */
function extractName(h: string): string { const c = h.lastIndexOf(':'); return c > 0 ? h.slice(0, c) : h; }

/**
 * zx_20261104_1 M7：截断时**如实给出覆盖率**——"样本内无增删"不能被读成"无增删"。
 *
 * 纯函数、零 IO：`sampled` 取样本哈希条数（stat 失败会少于上限，如实少报），
 * `total` 取 `fileCount`（捕获时已记截断前真总数）。未截断时 `coverageText` 为空串
 * （没有"不知道的部分"，不硬造一句边界声明）。
 */
export function describeSnapshotCoverage(snapshot: Record<string, unknown>): {
  truncated: boolean; sampled: number; total: number; coverageText: string;
} {
  const total = Math.max(0, Number(snapshot.fileCount) || 0);
  const sampled = Array.isArray(snapshot.fileHashes) ? snapshot.fileHashes.length : 0;
  const truncated = snapshot.truncated === true;
  const coverageText = truncated
    ? `样本覆盖 ${sampled}/${total} 个路径（按顶层目录轮转），样本外未审计`
    : '';
  return { truncated, sampled, total, coverageText };
}

/** M3③: 大批变更的完整清单落盘（告警只列前 N 个，全量须可复核）。落盘失败返回空串（不阻断审计） */
function writeDiffDump(opts: { taskId?: string; dataDir?: string } | undefined, deleted: string[], added: string[]): string {
  if (!opts?.taskId || !opts.dataDir) return '';
  try {
    const abs = path.join(opts.dataDir, 'world-snapshot-diffs', `${opts.taskId}.json`);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, JSON.stringify({
      taskId: opts.taskId,
      timestamp: new Date().toISOString(),
      deletedCount: deleted.length,
      addedCount: added.length,
      deleted: deleted.map(extractName),
      added: added.map(extractName),
    }, null, 2));
    return `（完整清单: 数据目录/world-snapshot-diffs/${opts.taskId}.json）`;
  } catch { return ''; }
}

/** 采样 stat 的并发批量（libuv 线程池默认 4，此处只做"别一次排几千个"的背压） */
const STAT_CONCURRENCY = 64;

/** zx_20261109_1 B1：`SKIP_DIRS` 的**唯一一处**对外形态——供目录级剪枝与 rr 共用，禁止在别处复制正则。 */
export function isSkippedWorkingPath(rel: string): boolean { return SKIP_DIRS.test(rel); }
/** 目录剪枝：目录相对路径（带尾斜杠）命中即不下沉；与文件谓词 `isSampledWorkingFile` 同源。 */
const shouldSkipSampledDir = (relDir: string): boolean => isSkippedWorkingPath(relDir);
const shouldSkipSampledFile = (name: string, rel: string): boolean => !isSampledWorkingFile(name, rel);

/**
 * zx_20260917 M4：工作目录采样的**口径**（唯一一处）——隐藏项与 `SKIP_DIRS` 下的项都不收录。
 *
 * 抽出来的理由与本仓一贯的理由相同：**同一个概念两处各写一份，必然分家**。
 * 现有两个消费者读它：① `captureWorldSnapshot`（审计快照）；② `listFilesWrittenSince`（M4 子进程落盘盘点）。
 * 两处若各写一份过滤条件，"哪些文件算工作目录里的文件"就有了两个答案。
 */
export function isSampledWorkingFile(name: string, rel: string): boolean {
  return !name.startsWith('.') && !SKIP_DIRS.test(rel);
}

/**
 * zx_20260917 M4·§6.1-3：**本命令窗口内**被写过的文件清单（绝对路径）——供"子进程落盘补登记"用。
 *
 * 判据 = `mtimeMs >= sinceMs`（`sinceMs` 是**该条命令启动时刻**，调用方取）。三条设计取舍：
 * ① **不截断**（对照 `captureWorldSnapshot` 的 `SNAPSHOT_FILE_LIMIT = 2000`）：本函数只收"改过的"，
 *    命中集天然很小，故全量 stat 是对的（实测 6417 文件项目 stat 全量 ~13ms）；
 *    截断反而会让大仓里"排在第 2000 个之后"的产物**永远看不见**（§1.3-⑤ 的同一堵墙，不在这里再撞一次）。
 * ② **按 mtime 归因、不做前后两份快照**：前后快照要 readdir 两次（实测 ~880ms/命令），
 *    本函数一次（实测 readdir 339ms + 过滤 99ms + stat 13ms ≈ 450ms/命令）。
 * ③ 归因窗口是**命令自身**，不是"最近 N 分钟"——§6.1-3 红线禁的是后者（会把用户的无关改动算进来）。
 *    **已接受的边界**（§6.0bis-d）：窗口内并发的外部改动会被算作本命令所写；只覆盖工作目录内；
 *    `SKIP_DIRS` 下的生成物（`output`/`dist`/`build`/`target`）看不见。
 */
export async function listFilesWrittenSince(root: string, sinceMs: number): Promise<string[]> {
  const out: string[] = [];
  if (!root) return out;
  try {
    // zx_20261109_1 B1：目录级剪枝（不再先枚举 `node_modules` 等再逐条丢）。
    const walk = await walkWorkingDir(root, {
      shouldSkipDir: shouldSkipSampledDir,
      shouldSkipFile: shouldSkipSampledFile,
    });
    const cands = walk.files.map((f) => f.abs);
    for (let i = 0; i < cands.length; i += STAT_CONCURRENCY) {
      const batch = await Promise.all(cands.slice(i, i + STAT_CONCURRENCY).map(async (fp) => {
        // 单个 stat 失败只跳过该条（与 `captureWorldSnapshot` 同一条纪律：不让一条坏路径废掉整轮盘点）
        try { return (await fsp.stat(fp)).mtimeMs >= sinceMs ? fp : null; } catch { return null; }
      }));
      for (const f of batch) if (f) out.push(f);
    }
  } catch { /* 目录读不到 = 本轮无写入 */ }
  return out;
}

/**
 * zx_20261021_4 批五：快照样本的**轮转采样**——按顶层目录轮流取，取代「全局字典序切前 N」。
 *
 * 病根：全局字典序切前 2000，等于只给"字典序靠前的那批子树"拍照，排在后面的整个子树
 * （真库标本怡寿里：`src/` 吃掉全部名额后 `docs/`、`scripts/` 永不可见）**永远不进样本**——
 * 样本内"无增删"因此不是世界的结论，只是排序的结论。
 *
 * 约定：① 组 = 相对 `root` 的首段路径；② 组内按字典序、组间按组名字典序（前后两次快照稳定可比）；
 * ③ 逐轮每组取一个直到取满 `limit`；④ 未超上限时**原样返回全量**（不重排，避免改变既有可比性）。
 * 纯函数、零 IO，rr 直跑生产实现。
 */
export function sampleSnapshotCandidates(paths: readonly string[], limit: number, root?: string): string[] {
  const all = [...paths];
  if (!(limit > 0)) return [];
  if (all.length <= limit) return all;
  const relOf = (p: string): string => {
    if (!root) return p;
    const rel = path.relative(root, p);
    return rel && rel !== '.' ? rel : p;
  };
  const groups = new Map<string, string[]>();
  for (const p of all) {
    const rel = relOf(p).replace(/\\/g, '/');
    const key = rel.split('/')[0] || rel;
    const g = groups.get(key);
    if (g) g.push(p); else groups.set(key, [p]);
  }
  const keys = [...groups.keys()].sort((a, b) => a.localeCompare(b));
  for (const k of keys) groups.get(k)!.sort((a, b) => a.localeCompare(b));
  const out: string[] = [];
  for (let round = 0; out.length < limit; round++) {
    let took = false;
    for (const k of keys) {
      const g = groups.get(k)!;
      if (round >= g.length) continue;
      out.push(g[round]!);
      took = true;
      if (out.length >= limit) break;
    }
    if (!took) break;
  }
  return out;
}

// ── zx_20261109_1 B2：一次遍历两用 ──────────────────────────────────────
/** 本 run 的工作目录扫描结果：一次 walker + 一次批量 stat（`size`/`mtimeMs` 全量在手）。 */
export interface WorkingDirScan {
  root: string;
  files: WorkingFile[];
  dirsScanned: number;
  entriesScanned: number;
  truncatedScan: boolean;
}

/** 大仓上限（G15）：条目数与时长，超限即停在已扫描处并如实标记。 */
export const SCAN_MAX_ENTRIES = 200_000;
export const SCAN_DEADLINE_MS = 10_000;

/**
 * 工作目录**一次**扫描（B2 的唯一取数口）。
 *
 * 旧实现同一段收口要扫两遍：第二证据通道 `listFilesWrittenSince`（全量 stat）
 * + `captureWorldSnapshot`（再 readdir + 采样 stat）。两遍读的是同一棵树、同一时刻附近，
 * 却各付一次遍历成本（怡寿里实测 188–217ms + 200ms 级）。此处一次拿全，两个消费者共用。
 *
 * 目录不可读/不存在 ⇒ `null`（调用方按"没有可扫描的世界"处理，不假装扫过）。
 *
 * zx_20261110_2 B5：**这条口径此前并不成立**——`walkWorkingDir` 对根目录的 `readdir` 失败是
 * `catch { return }`（"一条坏路径不废整轮盘点"），于是不存在的目录会得到"0 个文件的合法扫描"，
 * 与"目录是空的"分不开。调用方据此写"没有变化"就是假话（审计最不能接受的一句）。
 * 故先 `stat` 根目录：读不到/不是目录 ⇒ `null`；一次 stat 的代价换"空"与"没有"分得清。
 */
export async function scanWorkingDirOnce(
  root: string,
  opts: { maxEntries?: number; deadlineMs?: number; yieldEvery?: number } = {},
): Promise<WorkingDirScan | null> {
  const dir = String(root ?? '').trim();
  if (!dir) return null;
  try {
    const st = await fsp.stat(dir).catch(() => null);
    if (!st || !st.isDirectory()) return null;
    const walk = await walkWorkingDir(dir, {
      shouldSkipDir: shouldSkipSampledDir,
      shouldSkipFile: shouldSkipSampledFile,
      statMode: 'all',
      maxEntries: opts.maxEntries ?? SCAN_MAX_ENTRIES,
      deadlineMs: opts.deadlineMs ?? SCAN_DEADLINE_MS,
      yieldEvery: opts.yieldEvery,
    });
    return {
      root: dir,
      files: walk.files,
      dirsScanned: walk.dirsScanned,
      entriesScanned: walk.entriesScanned,
      truncatedScan: walk.truncatedScan,
    };
  } catch { return null; }
}

/**
 * 由一次扫描生成**与 `captureWorldSnapshot` 同形**的快照（逐字段一致）。
 *
 * `truncated` 有两个来源，任一为真即不冒充全量：① 样本超过 `SNAPSHOT_FILE_LIMIT`；
 * ② 扫描本身被大仓上限截断（`truncatedScan`）——后者若漏记，前后两份快照会拿
 * "部分 vs 全量"做增删判定，把没扫到的文件全报成"消失"。
 */
export function snapshotFromScan(
  db: Database.Database,
  projectId: string,
  scan: WorkingDirScan | null,
): Record<string, unknown> | null {
  try {
    const root = scan?.root ?? '';
    const scanned = scan?.files ?? [];
    const totalCount = scanned.length;
    const sizeByPath = new Map(scanned.map((f) => [f.abs, f.size]));
    const sample = sampleSnapshotCandidates(scanned.map((f) => f.abs), SNAPSHOT_FILE_LIMIT, root);
    const files = sample
      .map((p) => ({ path: p, size: sizeByPath.get(p) }))
      .filter((f): f is { path: string; size: number } => typeof f.size === 'number');
    const tasks = db.prepare('SELECT id, title, status FROM wa_tasks WHERE project_id = ?').all(projectId) as Array<{ id: string; title: string; status: string }>;
    const deliverables = db.prepare('SELECT id, name, status, file_path FROM wa_deliverables WHERE project_id = ?').all(projectId) as Array<{ id: string; name: string; status: string; file_path: string | null }>;
    return {
      timestamp: new Date().toISOString(),
      fileCount: totalCount,
      truncated: totalCount > SNAPSHOT_FILE_LIMIT || scan?.truncatedScan === true,
      fileHashes: files.map(f => `${f.path.replace(root, '')}:${f.size}`).sort(),
      taskStates: tasks.map(t => `${t.id}:${t.status}`).sort(),
      deliverableStates: deliverables.map(d => `${d.id}:${d.status}`).sort(),
    };
  } catch { return null; }
}

/** B2: 捕获世界快照（文件列表+任务状态+产出物状态）
 *
 *  zx_20260916_2 M3：改 `async`，并把**排序提到 stat 之前**。
 *  旧序是「先对**全部**条目 statSync → 再排序 → 再截断到 2000」——被截掉的 4000 多个 stat 是白算的，
 *  而在主进程里同步算这些 = 界面陪着冻（实测 maxLag 669ms）。`size` 只进哈希、**不参与排序**，
 *  故「先截断后 stat」产出与旧实现**逐字节相同**（`fileCount` 与样本哈希均已实测比对）。
 */
export async function captureWorldSnapshot(db: Database.Database, projectId: string): Promise<Record<string, unknown> | null> {
  try {
    const proj = db.prepare('SELECT working_dir FROM wa_projects WHERE id = ?').get(projectId) as { working_dir: string } | undefined;
    // zx_20261109_1 B2：一次扫描（walker + 全量 stat）产出候选与样本 size，快照由 `snapshotFromScan` 一处成文。
    //   采样面不变：文件仍由 `isSampledWorkingFile` 最终过滤（B1 剪枝口径），`fileCount` 仍记截断前真实总数。
    const scan = proj?.working_dir ? await scanWorkingDirOnce(proj.working_dir) : null;
    return snapshotFromScan(db, projectId, scan);
  } catch { return null; }
}

/**
 * zx_20261028_2 M1（为学日益，为道日损）：`context_json` 里只留**引用 + 摘要**，快照原文进侧表。
 *
 * 病根（真标本 `f021a2a4`）：ctx 217,629 B 中 198,036 B 是一份**从未被比对**的 before——
 * 收口路不经过 `auditWorldConsistency`，after 恒缺；全库同类载荷 28.3 MB / 31.3 MB。
 * 快照的用途是"事后比对一次"，不是"永久收藏"，故原文按引用取，ctx 只留四个摘要字段。
 */
export interface WorldSnapshotRef {
  ref: string;
  timestamp: string;
  fileCount: number;
  truncated: boolean;
}

/** 同一任务在侧表的保留条数（两轮成对 + 余量）；超出即删最旧，防无限长。 */
const SNAPSHOT_KEEP_PER_TASK = 4;

/**
 * 落一条快照并返回引用。侧表不可用（如夹具自建 DDL 未建该表）⇒ 返回 `null`，
 * **调用方退回内联**（与改造前逐字节同形）——降级可见（logger.warn），不静默丢快照。
 */
export function persistWorldSnapshot(
  db: Database.Database,
  taskId: string,
  kind: 'before' | 'after',
  snap: Record<string, unknown>,
): WorldSnapshotRef | null {
  const fileCount = Number(snap.fileCount) || 0;
  const truncated = snap.truncated === true;
  const timestamp = String(snap.timestamp || new Date().toISOString());
  try {
    const ref = crypto.randomUUID();
    db.prepare(`INSERT INTO wa_world_snapshots (id, task_id, kind, captured_at, file_count, truncated, payload_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      ref, taskId, kind, timestamp, fileCount, truncated ? 1 : 0,
      JSON.stringify({
        fileHashes: Array.isArray(snap.fileHashes) ? snap.fileHashes : [],
        taskStates: Array.isArray(snap.taskStates) ? snap.taskStates : [],
        deliverableStates: Array.isArray(snap.deliverableStates) ? snap.deliverableStates : [],
      }),
    );
    db.prepare(`DELETE FROM wa_world_snapshots WHERE task_id = ? AND id NOT IN (
      SELECT id FROM wa_world_snapshots WHERE task_id = ? ORDER BY captured_at DESC, rowid DESC LIMIT ${SNAPSHOT_KEEP_PER_TASK}
    )`).run(taskId, taskId);
    return { ref, timestamp, fileCount, truncated };
  } catch (err) {
    logger.warn({ taskId, reason: (err as Error).message?.slice(0, 80) }, '世界快照落侧表失败——退回内联（行为同改造前）');
    return null;
  }
}

/** 按引用取回整份快照（含 fileHashes/taskStates/deliverableStates）。 */
export function loadWorldSnapshot(db: Database.Database, ref: string): Record<string, unknown> | null {
  try {
    const row = db.prepare('SELECT captured_at, file_count, truncated, payload_json FROM wa_world_snapshots WHERE id = ?')
      .get(ref) as { captured_at: string; file_count: number; truncated: number; payload_json: string } | undefined;
    if (!row) return null;
    return {
      timestamp: row.captured_at,
      fileCount: row.file_count,
      truncated: row.truncated === 1,
      ...(JSON.parse(row.payload_json || '{}') as Record<string, unknown>),
    };
  } catch { return null; }
}

/**
 * ctx 里存的那一格 → 整份快照：新形（ref）按引用取，旧形（内联对象，含 rr 标本）原样用。
 * zx_20261110_2 B6：导出——判据路径阶梯的第④步要读"开跑那一刻的世界文件清单"，
 * 读法必须与本文件同源（不得由 exec-acceptance 再手抄一遍 ref/内联两种形态的分支）。
 */
export function loadStoredSnapshot(db: Database.Database, stored: unknown): Record<string, unknown> | null {
  if (!stored || typeof stored !== 'object') return null;
  const o = stored as Record<string, unknown>;
  if (Array.isArray(o.fileHashes)) return o;
  if (typeof o.ref === 'string' && o.ref) return loadWorldSnapshot(db, o.ref);
  return null;
}

/**
 * zx_20261028_2 M1：一次性清掉**终态任务**里的内联快照（新快照已走侧表，旧的仅此处回收）。
 * 只动 `status IN ('completed','failed','archived')` 的行，且只摘 `world_snapshot_before/after` 两键
 * （`finalize_checks`、对话、成果等其它键原样保留）；运行中/暂停中的任务不动（审计还要用）。
 */
export function pruneTerminalInlineSnapshots(db: Database.Database): { tasks: number; bytes: number } {
  let tasks = 0;
  let bytes = 0;
  const rows = db.prepare(`SELECT id, context_json FROM wa_tasks
    WHERE status IN ('completed','failed','archived')
      AND (context_json LIKE '%"world_snapshot_before":{%' OR context_json LIKE '%"world_snapshot_after":{%')`)
    .all() as Array<{ id: string; context_json: string }>;
  const upd = db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?');
  for (const r of rows) {
    let ctx: Record<string, unknown>;
    try { ctx = JSON.parse(r.context_json || '{}') as Record<string, unknown>; } catch { continue; }
    let changed = false;
    for (const key of ['world_snapshot_before', 'world_snapshot_after'] as const) {
      const v = ctx[key];
      // 只摘**内联**原文（带 fileHashes）；已经是 ref 摘要的留着（它只有几十字节，且是审计的成对凭证）
      if (v && typeof v === 'object' && Array.isArray((v as { fileHashes?: unknown }).fileHashes)) {
        delete ctx[key];
        changed = true;
      }
    }
    if (!changed) continue;
    const next = JSON.stringify(ctx);
    try {
      upd.run(next, r.id);
      tasks++;
      bytes += Math.max(0, r.context_json.length - next.length);
    } catch { /* 单行失败不阻断其余行 */ }
  }
  if (tasks > 0) logger.info({ tasks, freedKB: Math.round(bytes / 1024) }, '已清理终态任务的内联世界快照');
  return { tasks, bytes };
}

/** B2: 对比执行前后快照，检测意外副作用和不一致。
 *  `opts` 仅供大批变更落盘（缺省=纯函数零 IO）；`scopeTaskIds` 给了就只比这部分任务的流转
 *  （供审计「只对自己的变化负责」用），且本次审计主体（`opts.taskId`）自身的流转不算告警。 */
export function compareSnapshots(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  opts?: { taskId?: string; dataDir?: string; scopeTaskIds?: string[] },
): string[] {
  const issues: string[] = [];
  const beforeFiles = new Set(before.fileHashes as string[]);
  const afterFiles = new Set(after.fileHashes as string[]);

  // M3①: 任一侧样本被截断 ⇒ **放弃增删判定**。
  //   before/after 的样本集一旦一侧被截到"字典序前 2000 条"，边界之后的文件一律被记成"消失"——
  //   §1.4 的"323 个文件消失"即此（before 435 条未截断、after 超限被截），该数字由截断边界决定而非真实删除。
  //   空性：不知道就不说。**逐侧如实标注**（只报"已截断"那一侧，不笼统说"均超上限"）。
  const beforeN = Number(before.fileCount) || 0;
  const afterN = Number(after.fileCount) || 0;
  const beforeTrunc = before.truncated === true;
  const afterTrunc = after.truncated === true;
  if (beforeTrunc || afterTrunc) {
    // zx_20260922_1 M5（F7 治法2）：**显式声明结论的适用边界**——只说"已截断"不够，
    //   须说清"样本只覆盖哪些路径" ⇒ 读者不会把"样本内无增删"读成"无增删"。
    //   zx_20261021_4 批五：抽样口径由「全局字典序前 N」改为「按顶层目录轮转」⇒ 这句边界如实跟着改，
    //   不得让说明继续谎称"看的是字典序前 N"（说明与实现分家，正是本轮要治的同一种病）。
    // zx_20261104_1 M7: 覆盖率由 `describeSnapshotCoverage` 一处派生（N/M + 抽样口径 + "样本外未审计"），
    //   不在文案里手抄 `SNAPSHOT_FILE_LIMIT`——样本量被 stat 失败缩小时说明仍如实。
    const side = (snap: Record<string, unknown>, n: number, t: boolean) => `${n}${t
      ? ` 已截断（${describeSnapshotCoverage(snap).coverageText}）`
      : ' 未截断'}`;
    issues.push(`${TRUNCATION_ISSUE_PREFIX} 未做增删判定（before ${side(before, beforeN, beforeTrunc)} / after ${side(after, afterN, afterTrunc)}）`);
  } else {
    const newFiles = [...afterFiles].filter(f => !beforeFiles.has(f));
    const deletedFiles = [...beforeFiles].filter(f => !afterFiles.has(f));
    const deletedNames = new Set(deletedFiles.map(extractName));
    const newNames = new Set(newFiles.map(extractName));
    const actualDeletions = deletedFiles.filter(f => !newNames.has(extractName(f)));
    const actualAdditions = newFiles.filter(f => !deletedNames.has(extractName(f)));

    if (actualDeletions.length > 0 && actualDeletions.length <= 3) {
      issues.push(`[文件删除] ${actualDeletions.length}个文件消失: ${actualDeletions.join(', ')}`);
    } else if (actualDeletions.length > 3) {
      // M3③: 大批变更不再只给一句"大量变更，可能异常"——列前 N 个 + 总数，完整清单落盘以复核
      const shown = actualDeletions.slice(0, SNAPSHOT_LIST_LIMIT).map(extractName);
      const tail = actualDeletions.length > shown.length ? ` …（共 ${actualDeletions.length} 个）` : '';
      issues.push(`[文件删除] ${actualDeletions.length}个文件消失: ${shown.join(', ')}${tail}${writeDiffDump(opts, actualDeletions, actualAdditions)}`);
    }
    if (actualAdditions.length > 0 && actualAdditions.length <= 3) {
      issues.push(`[文件新增] ${actualAdditions.join(', ')}`);
    }
  }
  // 任务状态变更与文件采样无关（taskStates 从不截断）——截断时这一项照常如实比
  const beforeTasks = new Map((before.taskStates as string[]).map(s => s.split(':') as [string, string]));
  const afterTasks = new Map((after.taskStates as string[]).map(s => s.split(':') as [string, string]));
  const taskChanges: string[] = [];
  // zx_20261030_2 M6: 给了 scope 就只看 scope 内的任务；审计主体自己的流转只用于排除，不报。
  const scope = opts?.scopeTaskIds ? new Set(opts.scopeTaskIds) : null;
  for (const [tid, afterStatus] of afterTasks) {
    if (scope && !scope.has(tid)) continue;
    if (scope && opts?.taskId && tid === opts.taskId) continue;
    const beforeStatus = beforeTasks.get(tid);
    if (beforeStatus && beforeStatus !== afterStatus) taskChanges.push(`${tid.slice(0, 8)}:${beforeStatus}→${afterStatus}`);
  }
  if (taskChanges.length > 0) issues.push(`[任务状态变更] ${taskChanges.join(', ')}`);
  return issues;
}

/** B2: 审计世界模型一致性。对比执行前后的快照，将不一致写入任务对话。
 *  zx_20260916_2 M3：随 `captureWorldSnapshot` 改 `async`（调用方须 `await`，否则审计会在快照算完前就返回）。 */
export async function auditWorldConsistency(
  db: Database.Database,
  taskId: string,
  projectId: string,
  addConversation: (taskId: string, role: string, content: string) => void,
  opts?: {
    dataDir?: string;
    runStartedAtMs?: number;
    fileMutationCount?: number;
    scan?: Promise<WorkingDirScan | null>;
    /** zx_20261109_1 B5：本 run 身份——审计 INFO/WARN 行带 run 前缀，续跑后分得清哪一轮。 */
    runId?: string;
  },
): Promise<void> {
  try {
    const task = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined;
    let ctx: Record<string, unknown> = {};
    try { ctx = JSON.parse(task?.context_json || '{}'); } catch { /* ignore */ }
    let workingDir = '';
    try {
      const project = db.prepare('SELECT working_dir FROM wa_projects WHERE id = ?').get(projectId) as { working_dir?: string } | undefined;
      workingDir = String(project?.working_dir ?? '').trim();
    } catch { /* 项目读不到 ⇒ 无工作目录可扫 */ }
    // zx_20261109_1 B2：**一次扫描两用**——`opts.scan` 由收口路在循环结束后启动（与旧审计同刻），
    //   这里不再各扫一遍：written 由 scan 的 mtime 派生，after 快照由同一份 scan 成文。
    let scanLoaded = false;
    let scan: WorkingDirScan | null = null;
    const ensureScan = async (): Promise<WorkingDirScan | null> => {
      if (scanLoaded) return scan;
      scanLoaded = true;
      scan = opts?.scan ? await opts.scan.catch(() => null) : await scanWorkingDirOnce(workingDir);
      return scan;
    };
    // zx_20261104_1 M7：**第二证据通道**——本任务命令窗口内实际写入的文件。
    //   它与前后快照互补：快照截断时至少还有"本任务确实动过哪些文件"这一本账；
    //   与 fileMutationCount（write_file/edit_file 调用次数）对账，对不上时如实写差额，不静默。
    if (opts?.runStartedAtMs) {
      try {
        const sc = await ensureScan();
        const since = opts.runStartedAtMs;
        const names = (sc?.files ?? [])
          .filter((f) => typeof f.mtimeMs === 'number' && f.mtimeMs >= since)
          .map((f) => path.relative(workingDir, f.abs) || f.abs)
          .sort();
        const shown = names.slice(0, SNAPSHOT_LIST_LIMIT);
        const tail = names.length > shown.length ? ` …（共 ${names.length} 个）` : '';
        const mut = typeof opts.fileMutationCount === 'number' ? opts.fileMutationCount : null;
        const diff = mut != null && mut !== names.length
          ? `；与文件改写计数不符：引擎记 ${mut} 次、窗口盘点 ${names.length} 个（差额 ${Math.abs(mut - names.length)}；改写计数含同一文件多次编辑）`
          : '';
        const checks = Array.isArray(ctx.finalize_checks) ? (ctx.finalize_checks as string[]) : [];
        if (!sc && workingDir) {
          // 扫描不可用 ≠ 没写过文件：如实说"没盘点到"，不写"写入 0 个"。
          checks.push(tagWithRun('[INFO] 世界模型审计：工作目录扫描不可用，本轮未做命令窗口盘点', opts.runId));
        } else if (sc?.truncatedScan) {
          // G15：大仓上限触发 ⇒ 结论只覆盖已扫描部分，**不得**把截断写成"本任务未写文件"。
          checks.push(tagWithRun(`[INFO] 世界模型审计：工作目录过大（本轮只检查了前 ${sc.entriesScanned} 条，达到条目或时长上限后提前结束），未完成全量盘点与增删判定；已扫描范围内本任务命令窗口写入 ${names.length} 个文件${shown.length ? `：${shown.join(', ')}${tail}` : ''}${diff}（不是全量）`, opts.runId));
        } else {
          checks.push(tagWithRun(`[INFO] 世界模型审计第二通道：本任务命令窗口写入 ${names.length} 个文件${shown.length ? `：${shown.join(', ')}${tail}` : ''}${diff}（这是本任务写过的，不是世界全量）`, opts.runId));
        }
        ctx.finalize_checks = checks;
        db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), taskId);
      } catch { /* 第二通道 best-effort：盘点失败不阻断审计 */ }
    }
    if (!ctx.world_snapshot_before) return;
    // zx_20261028_2 M1: 新形是 `{ref,…}` 摘要（原文在 `wa_world_snapshots`）；旧形内联对象原样用。
    //   引用取不到（行被清/库被换）⇒ 如实说"没做判定"，不拿空快照去比（否则全库文件都成"新增"）。
    const before = loadStoredSnapshot(db, ctx.world_snapshot_before);
    if (!before) {
      const checks = Array.isArray(ctx.finalize_checks) ? (ctx.finalize_checks as string[]) : [];
      checks.push(tagWithRun('[INFO] 世界模型审计：执行前快照不可读，未做增删判定', opts?.runId));
      ctx.finalize_checks = checks;
      db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), taskId);
      return;
    }
    // zx_20261109_1 B2：after 快照复用**同一份** scan（不再二次 readdir/stat）。
    //   扫描不可用 ⇒ 与旧 `captureWorldSnapshot` **同形**（空候选的合法快照，`fileCount` 记 0）——
    //   这是既有语义，不在此擅自改判；只保证不拿"扫了一半"冒充全量（`truncatedScan` 已进 `truncated`）。
    const after = snapshotFromScan(db, projectId, await ensureScan());
    if (!after) return;
    // zx_20261030_2 M6: 只对本任务自己造成的世界变化负责——范围 = 本任务 + 直接子任务；
    //   本任务自身的 executing→paused 属正常流转，由 compareSnapshots 按 opts.taskId 排除。
    let childIds: string[] = [];
    try {
      childIds = (db.prepare('SELECT id FROM wa_tasks WHERE parent_task_id = ?').all(taskId) as Array<{ id: string }>).map((r) => r.id);
    } catch { /* 子任务读不到时范围收窄为本任务（自身流转仍被排除） */ }
    const issues = compareSnapshots(before, after, {
      taskId, dataDir: opts?.dataDir, scopeTaskIds: [taskId, ...childIds],
    });
    // zx_20260922_1 M5（F7）：**分级**——「截断 ⇒ 没做判断」是如实说明（info），
    //   「比出 N 项不一致」才是告警（warn）。此前二者共用一条通道 ⇒ 大工作树上恒真的 [WARN]（狼来了）。
    //   分级只按 `TRUNCATION_ISSUE_PREFIX` 一处判（与 `compareSnapshots` 的产出同源），不另抄一份字面量。
    const infos = issues.filter((s) => s.startsWith(TRUNCATION_ISSUE_PREFIX));
    const warns = issues.filter((s) => !s.startsWith(TRUNCATION_ISSUE_PREFIX));
    // M3②: 事后快照落库——"报了 N 个文件消失"这句话从此**事后可被独立复核**（此前全仓只存 before）。
    //   无论有无结论都落（干净的一次执行同样是证据）。写回走与 before 同一处 ctxJson 读写。
    // zx_20261028_2 M1: 原文进侧表，ctx 只留 ref；侧表不可用 ⇒ 退回内联（行为同改造前）。
    ctx.world_snapshot_after = persistWorldSnapshot(db, taskId, 'after', after) ?? after;
    if (warns.length > 0 || infos.length > 0) {
      // M3④: 结论进收口 checks（与其余 checks 同处可见，renderer 按前缀着色：[WARN] 黄、[INFO] 蓝）。
      //   **仍不阻断**——它不是闸，只求"用户看得见"。任务未 finalize 过则新建该键，否则该结论无处可见。
      const checks = Array.isArray(ctx.finalize_checks) ? (ctx.finalize_checks as string[]) : [];
      if (warns.length > 0) checks.push(tagWithRun(`[WARN] 世界模型审计：${warns.join('；')}`, opts?.runId));
      if (infos.length > 0) checks.push(tagWithRun(`[INFO] 世界模型审计：${infos.join('；')}`, opts?.runId));
      ctx.finalize_checks = checks;
    }
    db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), taskId);
    // ⚠ 会话行与 `logger.warn` **只由 warns 驱动**：info 级结论已在 checks 里如实可见，
    //   再往会话流里灌一遍"每轮必有"的通知，正是本轮要治的那句狼来了。
    if (warns.length > 0) {
      logger.warn({ taskId, issues: warns }, 'B2世界模型不一致检测');
      addConversation(taskId, 'system', `[B2世界模型审计] 执行后检测到${warns.length}项不一致:\n${warns.map(i => `  ${i}`).join('\n')}`);
    }
  } catch { /* audit best-effort */ }
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** 3.3 实事求是：生成"事实快照"——供Agent决策参考的当前世界状态摘要
 *  zx_20260916_2 M3：改 `async`（同款同步递归，同款冻结源）。 */
export async function generateFactSnapshot(db: Database.Database, projectId: string): Promise<string> {
  try {
    const proj = db.prepare('SELECT name, working_dir FROM wa_projects WHERE id = ?').get(projectId) as { name: string; working_dir: string } | undefined;
    if (!proj) return '';
    const parts: string[] = [];
    parts.push(`项目: ${proj.name}`);
    if (proj.working_dir) {
      try {
        // zx_20261110_2 B5「损」：同一目录 60s 内复用同一份清单（事实快照是**只读**消费者——
        //   它描述"开跑这一刻的世界"，不会因为本 run 后面写了文件就变；缓存只吸收重复扫描的等待）。
        //   前后比对类消费者**不得**走这里（见 `working-dir-scan-cache.ts` 顶注）。
        const allFiles = await factListingCached(proj.working_dir, async () => {
          const acc: string[] = [];
          // zx_20261109_1 B1：深度 ≤3 的目录树改用同一剪枝 walker。
          // 本消费者与快照消费者的口径**不同**（这里按 basename 跳过隐藏项与 SKIP_DIRS，且列出目录本身），
          // 故经参数传入各自谓词——walker 不复制任何业务正则；顺序/上限/输出形状与旧实现一致。
          await walkWorkingDir(proj.working_dir, {
            maxDepth: 3,
            includeNonFiles: true,
            statMode: 'all',
            shouldSkipDir: (_relDir, name) => name.startsWith('.') || SKIP_DIRS.test(name),
            shouldSkipFile: (name) => name.startsWith('.') || SKIP_DIRS.test(name),
            onDir: (rel) => acc.push(`${rel}/`),
            onFile: (f) => { if (f.size != null) acc.push(`${f.rel} (${formatSize(f.size)})`); },
          });
          return acc;
        });
        if (allFiles.length > 0) {
          const preview = allFiles.slice(0, 30);
          parts.push(`\n工作目录文件(${allFiles.length}个，显示前${preview.length}):\n${preview.map(f => `  - ${f}`).join('\n')}${allFiles.length > 30 ? `\n  ...共${allFiles.length}个文件` : ''}`);
        }
      } catch { /* ignore */ }
    }
    const tasks = db.prepare('SELECT title, status FROM wa_tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 10').all(projectId) as Array<{ title: string; status: string }>;
    if (tasks.length > 0) parts.push(`\n最近任务状态:\n${tasks.map(t => `  - [${t.status}] ${t.title.slice(0, 50)}`).join('\n')}`);
    // zx_20261015_2 D1（同病根第二处·agent 面）：事实快照是**喂给模型自己的上下文**，
    //   同样不得把内部登记状态（`draft`/…）当"产出到没到"读——模型看见自己的产出标着 `draft`
    //   会把"尚未 promote"误读成"还没做"。只给 `type` 与 `name`（事物本身）。
    const deliverables = db.prepare('SELECT name, type FROM wa_deliverables WHERE project_id = ? ORDER BY created_at DESC LIMIT 5').all(projectId) as Array<{ name: string; type: string }>;
    if (deliverables.length > 0) parts.push(`\n产出物:\n${deliverables.map(d => `  - [${d.type}] ${d.name}`).join('\n')}`);
    // zx_20260905 批3 (2026-09-05): 方案里程碑(wa_plan_milestones M0-M6)进度注入——执行器开跑即知项目大盘（借项目成果数据提准确·减重发现）
    const planMs = buildPlanMilestoneLine(db, projectId);
    if (planMs) parts.push(`\n${planMs}`);
    return `<fact-snapshot>\n以下是当前项目的事实状态（"实事求是"——决策应锚定在这些事实上）：\n\n${parts.join('\n')}\n</fact-snapshot>`;
  } catch { return ''; }
}
