/**
 * B2: 世界模型快照与一致性校验（从原工蚁 world-snapshot.ts 移植）。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createLogger } from './logger.js';
import { buildPlanMilestoneLine } from './project-analytics.js';

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

/** M3 补：逐条过滤（纯 CPU）每多少条让出一拍——见 `captureWorldSnapshot` 内说明 */
const FILTER_YIELD_EVERY = 16384;

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
    const entries = await fsp.readdir(root, { recursive: true, withFileTypes: true });
    const cands: string[] = [];
    for (let i = 0; i < entries.length; i++) {
      if (i > 0 && i % FILTER_YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
      const e = entries[i]!;
      if (!e.isFile()) continue;
      const fp = path.join((e as unknown as { parentPath?: string }).parentPath || root, e.name);
      if (!isSampledWorkingFile(e.name, path.relative(root, fp))) continue;
      cands.push(fp);
    }
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
    const candidates: Array<{ path: string }> = [];
    let totalCount = 0;
    if (proj?.working_dir) {
      try {
        const entries = await fsp.readdir(proj.working_dir, { recursive: true, withFileTypes: true });
        // `readdir(recursive)` 把**被跳过目录里的条目也一并返回**（实测真目录 55622 条只留 6104 条），
        // 逐条 `path.join`+`path.relative`+正则过滤是纯 CPU——实测这一轮独占 97ms 事件循环（I/O 只占 1ms）。
        // 故每 `FILTER_YIELD_EVERY` 条让出一拍：把一次 ~100ms 的卡顿切成几段 <30ms 的（顺序、结果不变）。
        for (let i = 0; i < entries.length; i++) {
          if (i > 0 && i % FILTER_YIELD_EVERY === 0) await new Promise((r) => setImmediate(r));
          const e = entries[i]!;
          if (!e.isFile()) continue;
          const fp = path.join((e as unknown as { parentPath?: string }).parentPath || proj.working_dir, e.name);
          // zx_20260917 M4: 过滤口径改读 `isSampledWorkingFile`（与 M4 的落盘盘点同一处判据），
          // 判定**逐字不变**（`!hidden && !SKIP_DIRS` 只是换了个写法的同一谓词）。
          if (!isSampledWorkingFile(e.name, path.relative(proj.working_dir, fp))) continue;
          candidates.push({ path: fp });
        }
        // M3①: 先记**截断前真实总数**，再截样本。样本量本身从此只是样本量。
        totalCount = candidates.length;
      } catch { /* ignore */ }
    }
    // zx_20261021_4 批五：截样本改走**顶层目录轮转**（`sampleSnapshotCandidates` 是唯一一处）。
    //   旧写法「全局字典序排序后切前 2000」让排在后面的子树永远不进样本——样本里的"无增删"只是排序的结论。
    const sample = sampleSnapshotCandidates(candidates.map((c) => c.path), SNAPSHOT_FILE_LIMIT, proj?.working_dir).map((p) => ({ path: p }));
    const files: Array<{ path: string; size: number }> = [];
    for (let i = 0; i < sample.length; i += STAT_CONCURRENCY) {
      const batch = await Promise.all(sample.slice(i, i + STAT_CONCURRENCY).map(async (c) => {
        // 单个 stat 失败只跳过该条：旧实现此处整体 abort ⇒ fileCount 记成 0 ⇒ 审计静默失效（有意收紧）
        try { return { path: c.path, size: (await fsp.stat(c.path)).size }; } catch { return null; }
      }));
      for (const f of batch) if (f) files.push(f);
    }
    const tasks = db.prepare('SELECT id, title, status FROM wa_tasks WHERE project_id = ?').all(projectId) as Array<{ id: string; title: string; status: string }>;
    const deliverables = db.prepare('SELECT id, name, status, file_path FROM wa_deliverables WHERE project_id = ?').all(projectId) as Array<{ id: string; name: string; status: string; file_path: string | null }>;
    return {
      timestamp: new Date().toISOString(),
      // M3⑥: 截断后**不得把样本量当总数**（那正是 §1.4 病根的另一种形态）
      fileCount: totalCount,
      truncated: totalCount > SNAPSHOT_FILE_LIMIT,
      fileHashes: files.map(f => `${f.path.replace(proj?.working_dir || '', '')}:${f.size}`).sort(),
      taskStates: tasks.map(t => `${t.id}:${t.status}`).sort(),
      deliverableStates: deliverables.map(d => `${d.id}:${d.status}`).sort(),
    };
  } catch { return null; }
}

/** B2: 对比执行前后快照，检测意外副作用和不一致。`opts` 仅供大批变更落盘（缺省=纯函数零 IO） */
export function compareSnapshots(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  opts?: { taskId?: string; dataDir?: string },
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
    const side = (n: number, t: boolean) => `${n}${t
      ? ` 已截断（超采样上限 ${SNAPSHOT_FILE_LIMIT}，即仅覆盖按顶层目录轮转抽取的 ${SNAPSHOT_FILE_LIMIT} 个路径）`
      : ' 未截断'}`;
    issues.push(`${TRUNCATION_ISSUE_PREFIX} 未做增删判定（before ${side(beforeN, beforeTrunc)} / after ${side(afterN, afterTrunc)}）`);
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
  for (const [tid, afterStatus] of afterTasks) {
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
  opts?: { dataDir?: string },
): Promise<void> {
  try {
    const task = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined;
    let ctx: Record<string, unknown> = {};
    try { ctx = JSON.parse(task?.context_json || '{}'); } catch { /* ignore */ }
    const before = ctx.world_snapshot_before as Record<string, unknown> | undefined;
    if (!before) return;
    const after = await captureWorldSnapshot(db, projectId);
    if (!after) return;
    const issues = compareSnapshots(before, after, { taskId, dataDir: opts?.dataDir });
    // zx_20260922_1 M5（F7）：**分级**——「截断 ⇒ 没做判断」是如实说明（info），
    //   「比出 N 项不一致」才是告警（warn）。此前二者共用一条通道 ⇒ 大工作树上恒真的 [WARN]（狼来了）。
    //   分级只按 `TRUNCATION_ISSUE_PREFIX` 一处判（与 `compareSnapshots` 的产出同源），不另抄一份字面量。
    const infos = issues.filter((s) => s.startsWith(TRUNCATION_ISSUE_PREFIX));
    const warns = issues.filter((s) => !s.startsWith(TRUNCATION_ISSUE_PREFIX));
    // M3②: 事后快照落库——"报了 N 个文件消失"这句话从此**事后可被独立复核**（此前全仓只存 before）。
    //   无论有无结论都落（干净的一次执行同样是证据）。写回走与 before 同一处 ctxJson 读写。
    ctx.world_snapshot_after = after;
    if (warns.length > 0 || infos.length > 0) {
      // M3④: 结论进收口 checks（与其余 checks 同处可见，renderer 按前缀着色：[WARN] 黄、[INFO] 蓝）。
      //   **仍不阻断**——它不是闸，只求"用户看得见"。任务未 finalize 过则新建该键，否则该结论无处可见。
      const checks = Array.isArray(ctx.finalize_checks) ? (ctx.finalize_checks as string[]) : [];
      if (warns.length > 0) checks.push(`[WARN] 世界模型审计：${warns.join('；')}`);
      if (infos.length > 0) checks.push(`[INFO] 世界模型审计：${infos.join('；')}`);
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
        const allFiles: string[] = [];
        const walk = async (dir: string, depth = 0): Promise<void> => {
          if (depth > 3) return;
          let entries;
          try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; /* 目录不可读：跳过 */ }
          for (const e of entries) {
            if (e.name.startsWith('.') || SKIP_DIRS.test(e.name)) continue;
            const rel = path.relative(proj.working_dir, path.join(dir, e.name));
            if (e.isDirectory()) { allFiles.push(`${rel}/`); await walk(path.join(dir, e.name), depth + 1); }
            else {
              try { const stat = await fsp.stat(path.join(dir, e.name)); allFiles.push(`${rel} (${formatSize(stat.size)})`); } catch { /* 单文件不可读：跳过 */ }
            }
          }
        };
        await walk(proj.working_dir);
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
