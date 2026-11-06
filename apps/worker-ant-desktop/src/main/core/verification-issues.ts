/**
 * 核实报告 → 「未落地问题」的**唯一提取与立项入口**（zx_20261021_2 批四 D4）。
 *
 * ## 治的病：派生任务拿判定词当问题
 *
 * 旧实现（`tools/control-finalize.ts` 检查 7 内联）取表格行里**第一个含 ❌/⚠️ 的单元格**当问题，
 * 而那一格通常正是**判定列**。真库派生任务 `58c60680` / `9cc5bb81` 的描述因此长这样：
 *
 *   `1. 不通过` / `8. ️` / `9. ️→❌（运用面）` / `10. ️ 静态成立` / `12. ️ 演示级`
 *
 * 十条里没有一条说得出"要修的是什么"——维特根斯坦：**意义即用法**。
 * 「修复 X」的用法要求 X 是一句可指认的话；`不通过` 是判定，不是 X。
 *
 * ## 取法（批四 §1）
 *
 * 1. **先定判定格 `k`**（含 ❌/⚠️ 的那一格），它只用来定位，**不当主语**；
 * 2. 主语 = `k` 左边最后一个"非判定格"（编号格如 `1`/`10` 不算主语——它不是一句话）；
 * 3. 细节 = 判定格若不止是判定词（如「代码级通过，实调未完成」）则用它，
 *    否则取右边第一个非判定、非「依据/证据」格；
 * 4. 二者拼成一句；命中不了 `ACTIONABLE_RE` 的丢弃（"静态成立"这类判定残留就此出局）；
 * 5. 归一、去重、上限 20（超出数如实回传给调用方上报）。
 *
 * ## 为什么不和父任务并发
 *
 * 旧实现建的是**子任务**且**立即 `enqueueJob`**：父还在收尾、子已开跑，两边改同一批文件；
 * 而子任务又会让父任务的收口闸（`children-gate`）盯住它。现改为**根任务 + `depends_on=本任务`**，
 * 由调度器在报告到终态后接续——"报告收口后再修"，既不并发，也不占子任务槽位。
 *
 * 本模块**零运行期依赖**（仅 node:crypto），可在 rr 里直接喂真报告片段跑断言。
 */
import { randomUUID } from 'node:crypto';

/** 单批最多立项的问题数——超出部分由调用方如实上报"另 N 条未立项"。 */
export const MAX_VERIFICATION_ISSUES = 20;

/**
 * 只有**报告类文档**才是"核实结论"的载体；源码/配置里的 ❌/⚠ 是注释，不是结论。
 *
 * 真库 `e1033ab6` 就是这么长出来的：`mini-mp/openapi.yaml:308` 的一行变更注记
 * （`#           ⚠ ②③ 属破坏性变更…`）以 `#` 开头，被 `issueFromLine` 当成 markdown 标题，
 * 抽出 1 条"问题"并派生了修复任务——修复者只能去改 mock 层。意义即用法：
 * 「核实报告」的用法是 .md/.markdown/.txt，不是任意产出文件。
 */
const REPORT_DOC_EXT_RE = /\.(md|markdown|txt)$/i;

export function isReportDocPath(filePath: string | null | undefined): filePath is string {
  return !!filePath && REPORT_DOC_EXT_RE.test(filePath);
}

/**
 * 判定词表：**不得当主语，也不得单独成题**。
 * 归一后完全相等才判为判定格（「部分通过（运用面）」这类带补充说明的仍可用作细节）。
 */
const VERDICT_ONLY = new Set([
  '不通过', '未通过', '部分通过', '通过', '需修正', '需改进', '静态成立', '未实调', '未实测',
  '已落地', '演示级', '展示域', '已实现', '已完成', '待验证', '待核实', '正常', '异常', '部分', '半闭环',
]);

/**
 * 可操作信号闸——命中不了就当判定残留丢弃。
 *
 * `未完成|未实调|未实测` 三枚是**细节位**的信号（如在「端到端业务链：代码级通过，实调未完成」里），
 * 它们**不能**单独成主语/成题（那是 `VERDICT_ONLY` 管的事）；但作为一句话里的细节出现时，
 * 它明说"这件事还差一步"，正是要立项的那类事——真报告里「实调未完成」就这样被旧口径漏掉过。
 */
const ACTIONABLE_RE = /未落地|未实现|缺失|未接入|未消费|零调用|无调用方|不一致|不同源|未映射|未配置|未传|丢失|阻断|模拟|硬编码|能力空转|无端点|未完成|未实调|未实测|建议|待定|风险/;

/**
 * zx_20261029_3 M1（荀子·名定而实辨）：**只能由人做的事**，不该派给智能体。
 *
 * 病根：`ACTIONABLE_RE` 里曾有一枚裸 `需`，于是「需 GUI 人工操作」「需运行实例 + MySQL」
 * 「需重编译部署」全被当成"可修问题"自动立了修复任务——真库三张 `paused` 的
 * `修复核实发现的未落地问题` 描述逐条都是这种待人事项，派出去后只能空转到目标偏离为止。
 *
 * 判据分两半：
 * - **动作/话术**（`HUMAN_ACTION_RE`）本身即足：人工、GUI、扫码、真机、开发者工具、截图、需登录…
 * - **资源**（`HUMAN_RESOURCE_RE`）须与「需/无法/不允许/不可用…」**同句**才算：运行实例、外部数据库、
 *   测试库、沙箱、账号凭据、部署重编译。单说「部署脚本缺失」是**可修**的，故不能只看资源词。
 *
 * 刻意不收裸 `登录`（「登录接口未实现」是可修的）、裸 `未`（「账号体系缺失」是可修的）。
 */
const HUMAN_ACTION_RE = /人工|手动|扫码|真机|开发者工具|界面点击|截图|需登录|登录操作|需在你们的|需要你/;
const HUMAN_RESOURCE_RE = /运行实例|数据库实例|MySQL|MariaDB|外部服务|测试库|沙箱|账号|账户|凭据|密钥|重编译|部署/;
const HUMAN_QUALIFIER_RE = /需|无法|不允许|不可用|无可用|没有/;

/** 这一条是否只能由人做（GUI/真机/外部实例/凭据/部署）。 */
export function isHumanOnlyIssue(issue: string): boolean {
  const s = normalizeCell(issue);
  if (HUMAN_ACTION_RE.test(s)) return true;
  return HUMAN_RESOURCE_RE.test(s) && HUMAN_QUALIFIER_RE.test(s);
}

/** 待人事项的展示上限（再多就只报数量，不把收口文案撑爆）。 */
export const MAX_MANUAL_ITEMS = 10;

/** 证据列/说明列——不能拿来当"要修什么"。 */
const EVIDENCE_RE = /^(依据|证据|备注|说明|结果|判定|见\s|详见)/;

const GLYPH_RE = /[❌⚠🔴🟠🟡✅✔✗🚫🧾]/g;

/** 去 markdown 修饰、列表编号、判定字形、多余空白与首尾标点。 */
function normalizeCell(raw: string): string {
  return raw
    .replace(/[*_`~]/g, '')
    .replace(/^#{1,6}\s*/, '')
    .replace(/^\s*(?:[-+*]|\d+[.)、])\s+/, '')
    .replace(/[\uFE0F\u200D\u20E3]/g, '')
    .replace(GLYPH_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[\s:：,，。;；、\-—]+|[\s:：,，。;；、\-—]+$/g, '')
    .trim();
}

function isVerdictOnly(s: string): boolean {
  return !s || VERDICT_ONLY.has(s);
}

/** 主语须是"一句话"：至少两个字、含文字（纯编号 `1` / `10` 不是主语）。 */
function isUsableSubject(s: string): boolean {
  if (s.length < 2 || isVerdictOnly(s) || EVIDENCE_RE.test(s)) return false;
  return /[A-Za-z㐀-鿿]/.test(s);
}

function isUsableDetail(s: string): boolean {
  return !!s && !isVerdictOnly(s) && !EVIDENCE_RE.test(s);
}

/** 从一行里抽一条候选（标题行整行；表格行按上述主语+细节规则）。 */
function issueFromLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  if (/^#{1,4}\s+/.test(trimmed)) {
    if (!/[❌⚠🔴🟠🟡]/.test(trimmed)) return null;
    return normalizeCell(trimmed);
  }

  if (!trimmed.includes('|') || !/[❌⚠]/.test(trimmed)) return null;
  const cells = trimmed.split('|').map((c) => c.trim()).filter((c) => c && !/^[-:]+$/.test(c));
  const k = cells.findIndex((c) => /[❌⚠]/.test(c));
  if (k < 0) return null;

  let subject = '';
  for (let i = k - 1; i >= 0; i--) {
    const s = normalizeCell(cells[i]!);
    if (isUsableSubject(s)) { subject = s; break; }
  }

  let detail = normalizeCell(cells[k]!);
  if (!isUsableDetail(detail)) {
    detail = '';
    for (let i = k + 1; i < cells.length; i++) {
      const d = normalizeCell(cells[i]!);
      if (isUsableDetail(d)) { detail = d; break; }
    }
  }

  if (subject && detail) return `${subject}：${detail}`;
  return subject || detail || null;
}

export interface VerificationIssueExtraction {
  /** 已归一、去重、截断后的可操作问题（保持原文出现顺序） */
  issues: string[];
  /** 只能由人做的事项（已去重、展示上限内）——**不立项**，由调用方登账并告知用户 */
  manualItems: string[];
  /** 待人事项超出展示上限的条数 */
  manualOverflow: number;
  /** 因上限 20 被截掉的可操作问题数（如实上报"另 N 条未立项"） */
  overflow: number;
}

function dedupKey(s: string): string {
  return s.toLowerCase().replace(/[\s:：，,。；;、（）()【】\[\]「」《》]/g, '');
}

/** 从一份或多份报告正文里抽出可立项的问题；待人事项单列，不混进 issues。 */
export function extractVerificationIssues(texts: string[]): VerificationIssueExtraction {
  const seen = new Set<string>();
  const picked: string[] = [];
  const manual: string[] = [];
  for (const text of texts) {
    for (const line of String(text ?? '').split('\n')) {
      const issue = issueFromLine(line);
      if (!issue) continue;
      const cleaned = issue.replace(/\s+/g, ' ').trim();
      if (cleaned.length < 6) continue;
      const humanOnly = isHumanOnlyIssue(cleaned);
      if (!humanOnly && !ACTIONABLE_RE.test(cleaned)) continue;
      const key = dedupKey(cleaned);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (humanOnly) manual.push(cleaned); else picked.push(cleaned);
    }
  }
  return {
    issues: picked.slice(0, MAX_VERIFICATION_ISSUES),
    manualItems: manual.slice(0, MAX_MANUAL_ITEMS),
    manualOverflow: Math.max(0, manual.length - MAX_MANUAL_ITEMS),
    overflow: Math.max(0, picked.length - MAX_VERIFICATION_ISSUES),
  };
}

/** 只用到 prepare().run() 的最小库接口（与 `task-jobs.ts` 同形）。 */
export interface VerificationFixDb {
  prepare(sql: string): { run(...args: unknown[]): { changes?: number } };
}

export interface CreateVerificationFixOptions {
  db: VerificationFixDb;
  /** 核实报告任务 id */
  taskId: string;
  projectId: string;
  issues: string[];
}

export interface VerificationFixTask {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  dependsOn: string;
  parentTaskId: null;
}

/**
 * 立一个修复任务：**根任务 + 前置=报告任务**，不立即入队。
 *
 * 验收标准逐条带"要什么证据"——旧模板「已落地且可核验」对"未落地"的问题是空话，
 * 修复者只能自报"已落地"，核验者无从复核。
 */
export function createVerificationFixTask(opts: CreateVerificationFixOptions): VerificationFixTask {
  const { db, taskId, projectId, issues } = opts;
  const id = randomUUID();
  const title = `修复核实发现的未落地问题（${issues.length} 个）`;
  const description = issues.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const acceptanceCriteria = issues
    .map((s, i) => `${i + 1}. ${s} —— 修复已落地，并给出可复核证据（文件:行 / 脚本命令与输出 / 构建日志）`)
    .join('\n');
  const contextJson = JSON.stringify({ depth: 1, verification_fix: true, verification_fix_of: taskId });
  db.prepare(
    "INSERT INTO wa_tasks (id, project_id, title, description, status, priority, parent_task_id, depends_on, source, acceptance_criteria, context_json) VALUES (?, ?, ?, ?, 'pending', 2, NULL, ?, 'agent', ?, ?)",
  ).run(id, projectId, title, description, taskId, acceptanceCriteria, contextJson);
  return { id, title, description, acceptanceCriteria, dependsOn: taskId, parentTaskId: null };
}
