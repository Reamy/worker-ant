/**
 * zx_20261022_3 批十一：**判卷证据面**（取数 + 择文 + 渲染）从 `agent-executor.ts` 抽出。
 *
 * 行为零变化——代码逐行搬移，仅改了归属与 import 来源；抽出的理由不是"拆得好看"，
 * 而是证明「减重可以在不全量重写的前提下安全发生」。证据面是判卷"看得见什么"的唯一真源：
 *   - `collectEvidence`：整棵树（祖先 ∪ 自身 ∪ 后代）的产出物与 doc 文件路径；
 *   - `rankEvidenceDocFiles`：任务点名最优先、其次新的（纯函数）；
 *   - `isSupersededDocBody`：正文开头自报失效的文档不是本轮交付；
 *   - `renderEvidence`：证据面 → 判卷提示词里那一整段（唯一一处渲染）。
 *
 * ⚠ `taskTreeIds` 真源在 `task-accounting.ts`（与 `collectAncestorIds`/`collectSubtreeIds` 同处），
 *   本模块只引用、不另造第二套父子遍历。
 * ⚠ 零 electron 依赖；rr 可直跑真实现。
 */
import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { taskTreeIds } from './task-accounting.js';
import { buildSufficiencyWindow } from './output-validator.js';
import { evidenceIdOf, listRuntimeEvidence, renderRuntimeEvidence, type RuntimeEvidenceRow } from './runtime-evidence.js';
import { deliverableContributors, readContribution } from './deliverable-attribution.js';
// zx_20261116_3 M3「判」：run 起点基线 + 子任务异常账（验收判卷的两块新证据）。
import { readRunStartBaseline, type RunStartBaseline } from './run-baseline.js';
import { isUnjudgedReason } from './acceptance-check.js';

/** `collectEvidence` 的取数形状——判卷"看得见什么"的可单测对象（§6.2）。 */
export interface EvidenceBundle {
  /** 本任务最近 5 条 assistant 消息正文 */
  convs: string[];
  /** 整棵树名下的产出物（name/status） */
  deliverables: Array<{ name: string; status: string }>;
  /** 整棵树名下**文件此刻确在**的 doc 产出物绝对路径（最多 4 条，见 `EVIDENCE_FILE_BITS_LIMIT`） */
  docFiles: string[];
  /** 复用已生成的内容校验结论（`context_json.output_validations`）渲染出的那一段，无则空串 */
  validations: string;
  /**
   * zx_20261105_1 M1：本任务的运行证据（shell 成功/失败/超时/被拒），**以本任务为界**——
   * 证据引用的是"这条任务真的跑过"，树内兄弟任务的运行记录不能替它作证。
   */
  runtimeEvidence: RuntimeEvidenceRow[];
  /** zx_20261116_2 M2：本任务的贡献说明（`wa_task_files` 文件 + finalize/update 摘要）。 */
  contribution?: { files: string[]; summary: string; source?: string; at?: string } | null;
  /**
   * zx_20261116_2 M2：doc 文件的归属面——owner、`wa_task_files` 写者、本任务是否参与、是否共享。
   * `isShared`：contributors >1 或 owner 不是本任务（单任务自有文件为 false，渲染逐字不加新块）。
   */
  fileAttribution?: Array<{
    file: string;
    ownerTaskId: string | null;
    contributors: string[];
    taskParticipates: boolean;
    isShared: boolean;
  }>;
  /** zx_20261116_3 M3：run 起点已有的未跟踪/已修改文件（判“只读”时扣除）。 */
  runStartBaseline?: RunStartBaseline | null;
  /** zx_20261116_3 M3：直接子任务里的覆盖完成/验收未通过/未判成——主任务总体结论须逐条点名。 */
  childExceptions?: Array<{
    id: string;
    title: string;
    /** zx_20261117_1 M2「账」：`not_achieved` = 已完成但 `goal_achieved=false`（含 `no_criteria` 的 45 分） */
    kind: 'override' | 'failed' | 'unjudged' | 'not_achieved';
    passed?: number;
    total?: number;
    score?: number;
    reason?: string;
  }>;
  /** zx_20261116_3 M4：父任务账上的覆盖链（子任务 id/原因/原验收）。 */
  childrenOverride?: Array<{ taskId: string; reason?: string; at?: string; passed?: number; total?: number }>;
  /**
   * zx_20261117_1 M3「证」：**直接子任务**的执行类运行证据（成功且 exit=0，最近 5 条），
   * 带归属——父任务可引用子任务的 `mvn ... test` 证明「全绿/退出码 0」类判据，不必自己重跑。
   */
  childRuntimeEvidence?: Array<RuntimeEvidenceRow & { ownerTaskId: string; ownerTitle: string }>;
}

/**
 * 判卷提示词里最多带几份产出正文摘录。
 *
 * zx_20261023_2 批二：4 → 6。真标本里一轮判卷要看的交付文档**本就不止 4 份**，第 5/6 份
 * 此前根本进不了证据面 ⇒ 判卷"没看见"当成"没做"。
 */
export const EVIDENCE_FILE_BITS_LIMIT = 6;

/**
 * 每份摘录的**覆盖式窗口**尺度（zx_20261023_2 批二）。
 *
 * 旧实现是 `body.slice(0, 600)`——真标本 25,636 字节的证据文档**中段整段不可见**，
 * 判卷模型据此判"未达成"。改用判卷侧同源的 `buildSufficiencyWindow`（头 + 标题大纲 + 尾）：
 * 短文档整份返回，长文档也不再静默丢中段。尺度比校验侧（6000/4000/4000）小，
 * 因为这里一轮要带 6 份，总量须有界。
 */
export const EVIDENCE_WINDOW = { headChars: 1600, tailChars: 2400, outlineChars: 1000 } as const;

/**
 * zx_20261021_4 批三：正文开头自报失效的文档**不是本轮交付**。
 *
 * 真库标本 `f79b1abb`：树上同时躺着已验证的 Vue3 方案与被废止的旧版，`docFiles` 按行序取前 4 份，
 * 判卷模型读到了旧的那份 ⇒ 判「未达成」。判卷读什么，就是它判什么；故先剔失效件再排序。
 * 只看开头 40 行（失效声明惯例写在标题/状态行），不做全文关键词扫描——正文里讨论"废止策略"是内容，不是状态。
 * 且必须**同一行**既有失效词、又处在陈述状态的语境（`> 状态：已废止` / `本文已被取代`）：
 * 只撞到一个「废止」词不算——否则「正文讨论历史方案为何废止」这种正常内容会被整份剔除。
 */
const SUPERSEDED_DOC_RE = /废止|作废|已废弃|已被取代|已过期|superseded|deprecated/i;
const SUPERSEDED_STATUS_RE = /状态|本文|本方案|本文档|本版|此文档|该文档|注意|说明|已废止|已作废|已废弃|已被取代|已过期|superseded|deprecated/i;
export function isSupersededDocBody(body: string | null | undefined): boolean {
  if (!body) return false;
  return body.split('\n').slice(0, 40).some((line) =>
    SUPERSEDED_DOC_RE.test(line) && SUPERSEDED_STATUS_RE.test(line));
}

export interface RankedDocFile { file: string; mtimeMs: number }

/**
 * zx_20261021_4 批三：证据择文——**任务点名的最优先，其次新的**（纯函数，rr 直测）。
 * 只决定「先读哪几份」，是否失效由 `isSupersededDocBody` 在读取时判（它需要正文，不在这里假装知道）。
 */
export function rankEvidenceDocFiles(o: { files: readonly RankedDocFile[]; taskText: string }): RankedDocFile[] {
  const norm = (s: string) => s.replace(/\\/g, '/');
  const text = norm(o.taskText || '');
  const basename = (p: string) => norm(p).split('/').pop() || p;
  const score = (f: RankedDocFile): number => {
    if (text.includes(norm(f.file))) return 1000;
    if (text.includes(basename(f.file))) return 500;
    return 0;
  };
  return [...o.files].sort((a, b) => score(b) - score(a) || b.mtimeMs - a.mtimeMs || a.file.localeCompare(b.file));
}

/**
 * zx_20260917 M4·§6.1/6.2 读面：把判卷的**取数**从判卷逻辑里抽出来——"看得见什么"从此是可单测的对象。
 *
 * 病根③（§1.3-⑤/§1.4）：判卷取数**全部以 `task_id = 本任务` 为界**，而主形态是
 * 「父任务持方案、子任务干活」⇒ 子任务判卷时看不见整棵树里任何一份落盘文件，
 * 于是它只能凭"最近 5 条 assistant 消息"判卷——**盲判**（判定 1/5 与 5/5 的差别只在它读到了什么）。
 *
 * 两条改动（§6.0bis-g 收窄：**只有产出物两路**走整树，`convs`/`validations` 仍以本任务为界）：
 * ① `deliverables`/`docFiles` 取**整棵树**（`taskTreeIds`）——不再只问"本任务自己交了什么"；
 * ② 由此 `docFiles` 的正文摘录覆盖到**树内任何一处**落盘的 doc（§6.1-2 的"最小可用做法"：
 *    对已登记 doc 做"存在性 + 正文摘录"，**不**依赖全量世界模型 diff——本项目 6417 文件 > 2000 上限，
 *    那条通道对本项目结构上是死的，见 §7.1-3）。
 *
 * 只读、零副作用；导出供受控回归直跑真实现（判据 E 即对它跑只读回放）。
 */
export function collectEvidence(db: Database.Database, taskId: string): EvidenceBundle {
  const ids = taskTreeIds(db, taskId);
  const inTree = `(${ids.map(() => '?').join(',')})`;
  const convs = db.prepare(
    "SELECT content FROM wa_task_conversations WHERE task_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 5",
  ).all(taskId) as Array<{ content: string }>;
  const deliverables = db.prepare(
    `SELECT name, status FROM wa_deliverables WHERE task_id IN ${inTree}`,
  ).all(...ids) as Array<{ name: string; status: string }>;
  const docRows = db.prepare(
    `SELECT id, task_id, file_path FROM wa_deliverables WHERE task_id IN ${inTree} AND type = 'doc' AND file_path IS NOT NULL AND file_path != ''`,
  ).all(...ids) as Array<{ id: string; task_id: string | null; file_path: string }>;
  // zx_20261116_2 M2：本任务**写过但不在本树名下**的文件（共享成果）也必须进证据面——
  //   否则根任务/独子任务的共享文件在外树时，判卷"看不见"就当成"没做"。
  try {
    const ownPaths = db.prepare('SELECT path FROM wa_task_files WHERE task_id = ? ORDER BY last_at ASC').all(taskId) as Array<{ path?: unknown }>;
    const seen = new Set(docRows.map((r) => r.file_path));
    const projectId = (db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(taskId) as { project_id?: string } | undefined)?.project_id;
    for (const r of ownPaths) {
      const p = String(r.path ?? '').trim();
      if (!p || seen.has(p)) continue;
      let hit: { id: string; task_id: string | null } | undefined;
      if (projectId) {
        try { hit = db.prepare('SELECT id, task_id FROM wa_deliverables WHERE project_id = ? AND file_path = ?').get(projectId, p) as { id: string; task_id: string | null } | undefined; } catch { /* ignore */ }
      }
      docRows.push({ id: hit?.id ?? `own:${p}`, task_id: hit?.task_id ?? null, file_path: p });
      seen.add(p);
    }
  } catch { /* 老夹具无 wa_task_files：只保留树内 doc */ }
  // zx_20261021_4 批三: 判卷先读「任务点名 / 更新」的文档（旧实现按行序取前 4，废止件因此混入证据面）。
  const taskText = (() => {
    try {
      const t = db.prepare('SELECT title, description, acceptance_criteria FROM wa_tasks WHERE id = ?').get(taskId) as
        { title?: string; description?: string; acceptance_criteria?: string } | undefined;
      return `${t?.title ?? ''}\n${t?.description ?? ''}\n${t?.acceptance_criteria ?? ''}`;
    } catch { return ''; }
  })();
  const ranked = rankEvidenceDocFiles({
    taskText,
    files: docRows.map((f) => {
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(f.file_path).mtimeMs; } catch { /* 文件已不在：仍参与排序，只是不占新度 */ }
      return { file: f.file_path, mtimeMs };
    }),
  });
  const byPath = new Map(docRows.map((r) => [r.file_path, r]));
  const rankedRows = ranked.map((f) => byPath.get(f.file)).filter((r): r is { id: string; task_id: string | null; file_path: string } => !!r);
  const docFiles = rankedRows.map((r) => r.file_path);
  // zx_20261116_2 M2：每个 doc 文件的归属面——owner 恒在 contributors 首位，本任务是否参与/是否共享由此判。
  const fileAttribution = rankedRows.map((r) => {
    const contributors = r.id.startsWith('own:') ? [taskId] : deliverableContributors(db, r.id);
    const ownerTaskId = r.task_id ?? null;
    return {
      file: r.file_path,
      ownerTaskId,
      contributors,
      taskParticipates: contributors.includes(taskId),
      isShared: contributors.length > 1 || (ownerTaskId != null && ownerTaskId !== taskId),
    };
  });
  const contribution = readContribution(db, taskId);
  let validations = '';
  try {
    const ctxr = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}') as { output_validations?: Array<{ file: string; sufficient?: boolean; status?: string; reason?: string }> };
    const ov = Array.isArray(ctxr.output_validations) ? ctxr.output_validations : [];
    // zx_20261028_2 M3：三态如实——`unknown`（辅助模型超时/不可用/内容不可解码）此前被渲染成「充分」，
    //   把"没问出来"冒充成"问过了且合格"。今按 `status` 先判，再退回快检结论。
    const mark = (v: { sufficient?: boolean; status?: string; reason?: string }): string => {
      if (v.status === 'unknown') return `未核(${v.reason || '辅助模型不可用'})`;
      if (v.status === 'insufficient' || v.sufficient === false) return `不充分(${v.reason || v.status || 'insufficient'})`;
      return '充分';
    };
    if (ov.length) validations = `[内容校验]\n${ov.map(v => `- ${v.file}: ${mark(v)}`).join('\n')}`;
  } catch { /* 校验结论读取失败跳过 */ }
  return {
    convs: convs.map(c => c.content || ''),
    deliverables,
    docFiles,
    validations,
    runtimeEvidence: listRuntimeEvidence(db, taskId),
    contribution,
    fileAttribution,
    runStartBaseline: readRunStartBaseline(db, taskId),
    childExceptions: collectChildExceptions(db, taskId),
    childrenOverride: readChildrenOverride(db, taskId),
    childRuntimeEvidence: collectChildRuntimeEvidence(db, taskId),
  };
}

/** zx_20261116_3 M4：父任务账上的 `children_override`（capped 20）。 */
function readChildrenOverride(
  db: Database.Database,
  taskId: string,
): NonNullable<EvidenceBundle['childrenOverride']> {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined;
    const ctx = JSON.parse(row?.context_json || '{}') as { children_override?: unknown };
    if (!Array.isArray(ctx.children_override)) return [];
    return ctx.children_override
      .filter((x): x is Record<string, unknown> => !!x && typeof x === 'object')
      .slice(-20)
      .map((x) => ({
        taskId: typeof x.taskId === 'string' ? x.taskId : '',
        reason: typeof x.reason === 'string' ? x.reason : '',
        at: typeof x.at === 'string' ? x.at : '',
        passed: Number(x.passed) || 0,
        total: Number(x.total) || 0,
      }));
  } catch {
    return [];
  }
}

/**
 * zx_20261116_3 M3「判」：直接子任务里的异常账（覆盖完成/验收未通过/未判成）。
 * 只列**直接子任务**、不递归；账上已有的 `completion_override`/`acceptance_check` 原样读，不重跑验收。
 */
function collectChildExceptions(
  db: Database.Database,
  taskId: string,
): NonNullable<EvidenceBundle['childExceptions']> {
  try {
    const rows = db.prepare(
      "SELECT id, title, context_json FROM wa_tasks WHERE parent_task_id = ? AND status NOT IN ('archived') ORDER BY created_at ASC LIMIT 20",
    ).all(taskId) as Array<{ id: string; title: string; context_json?: string }>;
    const out: NonNullable<EvidenceBundle['childExceptions']> = [];
    for (const r of rows) {
      let ctx: Record<string, unknown> = {};
      try { ctx = JSON.parse(r.context_json || '{}') as Record<string, unknown>; } catch { /* 坏 JSON 跳过 */ }
      const ac = ctx.acceptance_check as { verified?: unknown; passed_total?: unknown; criteria_total?: unknown; reason?: unknown } | undefined;
      const passed = Number(ac?.passed_total) || 0;
      const total = Number(ac?.criteria_total) || 0;
      const override = ctx.completion_override as { reason?: unknown } | undefined;
      if (override && typeof override === 'object') {
        out.push({ id: r.id, title: r.title, kind: 'override', passed, total, reason: typeof override.reason === 'string' ? override.reason : '' });
      } else if (ac?.verified === true && total > 0 && passed < total) {
        out.push({ id: r.id, title: r.title, kind: 'failed', passed, total });
      } else if (ac?.verified === false && isUnjudgedReason(ac.reason as Parameters<typeof isUnjudgedReason>[0])) {
        out.push({ id: r.id, title: r.title, kind: 'unjudged', passed, total, reason: typeof ac.reason === 'string' ? ac.reason : '' });
      } else {
        // zx_20261117_1 M2「账」：`no_criteria` 不在 UNJUDGED_REASONS 里，但 `goal_achieved=false` 是**真事实**
        //   （真标本 `42abb368`：completed / 45 分 / 0 判据，父任务 4/4 验收一次未提它）。
        //   只在 override/failed/unjudged 都没命中时补——避免同一子任务被列两次。
        const cq = ctx.completion_quality as { goal_achieved?: unknown; score?: unknown; feedback?: unknown } | undefined;
        if (cq?.goal_achieved === false) {
          out.push({
            id: r.id,
            title: r.title,
            kind: 'not_achieved',
            passed,
            total,
            score: typeof cq.score === 'number' ? cq.score : undefined,
            reason: typeof cq.feedback === 'string' ? cq.feedback : '',
          });
        }
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * zx_20261117_1 M3「证」：**直接子任务**的执行类运行证据（成功且 exit=0，最近 5 条）。
 *
 * 病根（标本 04）：主任务 `b697b767` 判据 3「H2 测试全绿」的 own run 只有 `grep -c "@Test"`，
 * 真正的 `mvn ... test` 在子任务 `8fab4491` 账上 ⇒ 父任务要么误绑 grep、要么被迫自己重跑。
 * 本函数把子任务的执行证据**带归属**带进父任务证据面；只收 execute_command/bash、ok=1、exit=0。
 */
function collectChildRuntimeEvidence(
  db: Database.Database,
  taskId: string,
): NonNullable<EvidenceBundle['childRuntimeEvidence']> {
  try {
    const rows = db.prepare(
      `SELECT e.*, t.title AS owner_title
         FROM wa_task_runtime_evidence e
         JOIN wa_tasks t ON t.id = e.task_id
        WHERE e.task_id IN (SELECT id FROM wa_tasks WHERE parent_task_id = ? AND status NOT IN ('archived'))
          AND e.tool IN ('execute_command','bash')
          AND e.ok = 1
          AND (e.exit_code IS NULL OR e.exit_code = 0)
        ORDER BY e.created_at DESC, e.rowid DESC
        LIMIT 5`,
    ).all(taskId) as Array<RuntimeEvidenceRow & { owner_title: string }>;
    return rows.map((r) => ({ ...r, ownerTaskId: r.task_id, ownerTitle: r.owner_title }));
  } catch {
    return [];
  }
}

/** 证据面 → 判卷提示词里那一整段（**唯一一处**渲染；`collectEvidence` 的纯函数收口） */
export function renderEvidence(bundle: EvidenceBundle, readFile: (p: string) => string | null): string {
  const fileBits: string[] = [];
  const attrByPath = new Map((bundle.fileAttribution ?? []).map((a) => [a.file, a]));
  const sharedAny = (bundle.fileAttribution ?? []).some((a) => a.isShared);
  // zx_20261116_2 M2：只在共享面出现时加“贡献声明/本任务写入”两块；单任务自有文件逐字不加（旧证据面不退）。
  const contributionBlock = sharedAny && bundle.contribution
    ? `[本任务贡献声明] ${bundle.contribution.summary || '（未写摘要）'}\n`
      + `[本任务写入] ${bundle.contribution.files.map((p) => path.basename(p)).join('、') || '（无）'}`
    : '';
  // zx_20261021_4 批三: 先剔失效件，**再**计入上限——旧实现先切 4 份再读，失效件会挤掉有效件。
  for (const fp of bundle.docFiles) {
    if (fileBits.length >= EVIDENCE_FILE_BITS_LIMIT) break;
    try {
      const body = readFile(fp);
      if (body !== null && !isSupersededDocBody(body)) {
        const a = attrByPath.get(fp);
        const sharedLabel = a?.isShared
          ? `[共享文件 · 归属 ${a.ownerTaskId ? a.ownerTaskId.slice(0, 8) : '未记'} · 本任务参与 ${a.taskParticipates ? 'yes' : 'no'} · 参与 ${a.contributors.map((id) => id.slice(0, 8)).join('、')}]\n`
          : '';
        fileBits.push(`${sharedLabel}[文件 ${path.basename(fp)}]\n${buildSufficiencyWindow(body, EVIDENCE_WINDOW).text}`);
      }
    } catch { /* 文件读取失败跳过 */ }
  }
  return [
    ...(contributionBlock ? [contributionBlock] : []),
    ...bundle.convs.map(c => `[产出] ${c.slice(0, 400)}`),
    // zx_20261015_2 D1（道德经·三十八章「前识者，道之华，而愚之始」/ 维特根斯坦·意义即用法）：
    //   产出物行**只给名字**，不再带内部登记状态。`draft` 在**推进游戏**里意为"尚未 promote"，
    //   判卷游戏里没人约定过它 ⇒ 那里它没有用法、只有误导（旁路 LLM 按日常语义读成"未完成"）；
    //   而 promote 只在收口成功路径上做（判卷没过就 return）⇒ 判卷 failed ⇒ 不 promote ⇒
    //   恢复后读到同一批 draft ⇒ **自锁死循环**。判卷该看的是 name + 文件正文摘录 + 会话/校验。
    ...bundle.deliverables.map(d => `[产出物] ${d.name}`),
    ...fileBits,
    // zx_20261105_1 M1：运行证据段（会话/产出之后、仓库状态之前）。判卷条目的 `evidence_refs`
    //   要引用这里的 `run:<id>`；没有这一段的"执行过"只是模型自述。
    renderRuntimeEvidence(bundle.runtimeEvidence),
    renderChildRuntimeEvidence(bundle.childRuntimeEvidence),
    renderRunStartBaseline(bundle.runStartBaseline),
    renderChildExceptions(bundle.childExceptions),
    renderChildrenOverride(bundle.childrenOverride),
    bundle.validations,
  ].filter(Boolean).join('\n');
}

/** zx_20261117_1 M3「证」：子任务运行证据段——空则逐字不加。 */
function renderChildRuntimeEvidence(
  rows: EvidenceBundle['childRuntimeEvidence'] | null | undefined,
): string {
  if (!rows || rows.length === 0) return '';
  const lines = rows.map((r) => {
    const cmd = String(r.command ?? '').replace(/\s+/g, ' ').trim().slice(0, 300);
    return `- ${evidenceIdOf(r)}（子任务 ${r.ownerTaskId.slice(0, 8)}「${r.ownerTitle}」） tool=${r.tool} exit=${r.exit_code ?? '-'} cmd=${cmd}`;
  });
  return `[子任务运行证据]\n${lines.join('\n')}`;
}

/** zx_20261116_3 M4：覆盖链（父账）——空则逐字不加。 */
function renderChildrenOverride(
  list: EvidenceBundle['childrenOverride'] | null | undefined,
): string {
  if (!list || list.length === 0) return '';
  return `[覆盖链]\n${list.map((x) => `- ${x.taskId.slice(0, 8)} (${x.passed ?? 0}/${x.total ?? 0})${x.reason ? ` 原因=${x.reason.slice(0, 200)}` : ''}`).join('\n')}`;
}

/** zx_20261116_3 M3：run 起点基线——只列非空项；两者皆空逐字不加。 */
function renderRunStartBaseline(b: RunStartBaseline | null | undefined): string {
  if (!b) return '';
  const parts: string[] = [];
  if (b.untracked.length) parts.push(`untracked=${b.untracked.slice(0, 20).join(',')}`);
  if (b.modified.length) parts.push(`modified=${b.modified.slice(0, 20).join(',')}`);
  if (parts.length === 0) return '';
  return `[run 起点基线] at=${b.at} ${parts.join(' ')}`;
}

/** zx_20261116_3 M3：子任务异常账——空则逐字不加（旧证据面不退）。 */
function renderChildExceptions(
  list: EvidenceBundle['childExceptions'] | null | undefined,
): string {
  if (!list || list.length === 0) return '';
  const lines = list.map((x) => {
    const label = x.kind === 'override'
      ? `覆盖完成(${x.passed ?? 0}/${x.total ?? 0})`
      : x.kind === 'failed'
        ? `验收未通过(${x.passed ?? 0}/${x.total ?? 0})`
        : x.kind === 'not_achieved'
          ? `完成·未达目标${typeof x.score === 'number' ? `(score=${x.score})` : ''}`
          : '验收未判成';
    return `- ${x.id.slice(0, 8)} ${x.title}: ${label}${x.reason ? ` 原因=${x.reason.slice(0, 200)}` : ''}`;
  });
  return `[子任务异常账]\n${lines.join('\n')}`;
}
