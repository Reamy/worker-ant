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
  const docFiles = db.prepare(
    `SELECT file_path FROM wa_deliverables WHERE task_id IN ${inTree} AND type = 'doc' AND file_path IS NOT NULL AND file_path != ''`,
  ).all(...ids) as Array<{ file_path: string }>;
  // zx_20261021_4 批三: 判卷先读「任务点名 / 更新」的文档（旧实现按行序取前 4，废止件因此混入证据面）。
  const taskText = (() => {
    try {
      const t = db.prepare('SELECT title, description, acceptance_criteria FROM wa_tasks WHERE id = ?').get(taskId) as
        { title?: string; description?: string; acceptance_criteria?: string } | undefined;
      return `${t?.title ?? ''}\n${t?.description ?? ''}\n${t?.acceptance_criteria ?? ''}`;
    } catch { return ''; }
  })();
  const rankedDocFiles = rankEvidenceDocFiles({
    taskText,
    files: docFiles.map((f) => {
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(f.file_path).mtimeMs; } catch { /* 文件已不在：仍参与排序，只是不占新度 */ }
      return { file: f.file_path, mtimeMs };
    }),
  }).map((f) => f.file);
  let validations = '';
  try {
    const ctxr = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}') as { output_validations?: Array<{ file: string; sufficient?: boolean; status?: string }> };
    const ov = Array.isArray(ctxr.output_validations) ? ctxr.output_validations : [];
    if (ov.length) validations = `[内容校验]\n${ov.map(v => `- ${v.file}: ${v.sufficient ? '充分' : `不充分(${v.status ?? 'insufficient'})`}`).join('\n')}`;
  } catch { /* 校验结论读取失败跳过 */ }
  return { convs: convs.map(c => c.content || ''), deliverables, docFiles: rankedDocFiles, validations };
}

/** 证据面 → 判卷提示词里那一整段（**唯一一处**渲染；`collectEvidence` 的纯函数收口） */
export function renderEvidence(bundle: EvidenceBundle, readFile: (p: string) => string | null): string {
  const fileBits: string[] = [];
  // zx_20261021_4 批三: 先剔失效件，**再**计入上限——旧实现先切 4 份再读，失效件会挤掉有效件。
  for (const fp of bundle.docFiles) {
    if (fileBits.length >= EVIDENCE_FILE_BITS_LIMIT) break;
    try {
      const body = readFile(fp);
      if (body !== null && !isSupersededDocBody(body)) {
        fileBits.push(`[文件 ${path.basename(fp)}]\n${buildSufficiencyWindow(body, EVIDENCE_WINDOW).text}`);
      }
    } catch { /* 文件读取失败跳过 */ }
  }
  return [
    ...bundle.convs.map(c => `[产出] ${c.slice(0, 400)}`),
    // zx_20261015_2 D1（道德经·三十八章「前识者，道之华，而愚之始」/ 维特根斯坦·意义即用法）：
    //   产出物行**只给名字**，不再带内部登记状态。`draft` 在**推进游戏**里意为"尚未 promote"，
    //   判卷游戏里没人约定过它 ⇒ 那里它没有用法、只有误导（旁路 LLM 按日常语义读成"未完成"）；
    //   而 promote 只在收口成功路径上做（判卷没过就 return）⇒ 判卷 failed ⇒ 不 promote ⇒
    //   恢复后读到同一批 draft ⇒ **自锁死循环**。判卷该看的是 name + 文件正文摘录 + 会话/校验。
    ...bundle.deliverables.map(d => `[产出物] ${d.name}`),
    ...fileBits,
    bundle.validations,
  ].filter(Boolean).join('\n');
}
