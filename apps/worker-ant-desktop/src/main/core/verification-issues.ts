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
// zx_20261117_1 M1「案」：与 `task-archetype` 共用同一份方案样板剥离（纯函数，零运行期依赖）。
import { stripPlanBoilerplate } from './plan-text.js';
// zx_20261120_3 M1「职·全」：验收修复任务继承来源任务岗位。
import { deriveTaskPosition, positionContextFields } from './positions.js';

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
const ACTIONABLE_RE = /未落地|未实现|缺失|未接入|未消费|零调用|无调用方|不一致|不同源|未映射|未配置|未传|丢失|阻断|模拟|硬编码|能力空转|无端点|未完成|未实调|未实测/;

/**
 * zx_20261116_1 M3（辨·名实）：**提醒/风险/待定**不是“未落地的可修问题”，而是**人的决策面**。
 *
 * 真标本：方案 §1.2 依赖清单的说明列写
 *   `工具（⚠ 与易宝 SDK 的 commons-lang3 依赖冲突史相关，见 §1.9 风险）`
 * 这里的 `⚠` 是提醒、句尾“风险”是**指向风险登记的指针**；旧口径把它当可修问题，派生了
 * `修复核实发现的未落地问题（1 个）`（真库 `9e1e31f5`），还越过了父任务“只形成方案不动代码”的边界。
 * 故把 `建议|待定|风险` 从 `ACTIONABLE_RE` 移出，单列 `advisories`：**登记、告知、不自动立项**。
 * 一条同时含可修词（如“未接入”）与“风险”的句子仍进 `issues`（可修优先）。
 */
const ADVISORY_RE = /建议|待定|风险/;

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
  /** 提醒/风险/待定（已去重、上限同 `MAX_VERIFICATION_ISSUES`）——**登记、告知、不立项** */
  advisories: string[];
  /** 待人事项超出展示上限的条数 */
  manualOverflow: number;
  /** 提醒/风险/待定超出展示上限的条数 */
  advisoryOverflow: number;
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
  const advisory: string[] = [];
  for (const text of texts) {
    for (const line of String(text ?? '').split('\n')) {
      const issue = issueFromLine(line);
      if (!issue) continue;
      const cleaned = issue.replace(/\s+/g, ' ').trim();
      if (cleaned.length < 6) continue;
      const humanOnly = isHumanOnlyIssue(cleaned);
      const actionable = ACTIONABLE_RE.test(cleaned);
      const advisoryOnly = ADVISORY_RE.test(cleaned);
      if (!humanOnly && !actionable && !advisoryOnly) continue;
      const key = dedupKey(cleaned);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (humanOnly) manual.push(cleaned);
      else if (actionable) picked.push(cleaned);
      else advisory.push(cleaned);
    }
  }
  return {
    issues: picked.slice(0, MAX_VERIFICATION_ISSUES),
    manualItems: manual.slice(0, MAX_MANUAL_ITEMS),
    advisories: advisory.slice(0, MAX_VERIFICATION_ISSUES),
    manualOverflow: Math.max(0, manual.length - MAX_MANUAL_ITEMS),
    advisoryOverflow: Math.max(0, advisory.length - MAX_VERIFICATION_ISSUES),
    overflow: Math.max(0, picked.length - MAX_VERIFICATION_ISSUES),
  };
}

/** 单批最多登记的「留到后续」项数——超出由调用方如实上报 `overflow`。 */
export const MAX_DEFERRED_ITEMS = 10;

/**
 * zx_20261117_1 M1「案」：这个题面**是不是"规划提案"**（而不是"方案实施"）。
 *
 * 病根：旧判据 `/(规划|排期)/` 对全题面扫描。实现任务的模板描述里有一句
 * 「每开始一项任务前请先根据**实施排期计划**进行一次细化**规划**后再开始实施」⇒ 命中"排期"，
 * 于是「方案实施」任务被判成规划类，已检测到的未落地项只打 INFO、不派生后续任务
 * （真标本 `a55f9aa6`：4/4 收口；用户 13 分钟后手动补建 `b697b767`）。
 *
 * 取法（顺序不可颠倒）：
 *   0. 核实/审计/盘点类 ⇒ false（沿用旧负类，避免把核实报告当方案）；
 *   1. **显式文档意图**（撰写/编写/写/输出/产出/生成/制定/拟定/设计 + 规划/排期/方案）⇒ true；
 *   2. **实施动作**（方案实施/实施方案/落地/实现/接入/对齐/联调）⇒ false（标本 01 走这支）；
 *   3. **标题**含"规划/排期" ⇒ true（真规划任务：`20260914 功能优化规划`、`…规划方案`）；
 *   4. 其余 ⇒ false。
 *
 * 只认**标题**的"规划/排期"（第 3 步），不认描述里的引用句——这正是旧判据误伤的位置。
 */
export function isPlanProposalText(title: string, description: string): boolean {
  const raw = `${title || ''} ${description || ''}`;
  const stripped = stripPlanBoilerplate(raw).replace(/\s+/g, ' ').trim();
  const titleStripped = stripPlanBoilerplate(title || '').replace(/\s+/g, ' ').trim();
  if (/(核实报告|完成情况核实|审计|盘点)/.test(raw)) return false;
  if (/(撰写|编写|写|输出|产出|生成|制定|拟定|设计).{0,12}(规划|排期|方案)/.test(stripped)) return true;
  if (/(方案实施|实施方案|落地|实现|接入|对齐|联调)/.test(stripped)) return false;
  if (/(规划|排期)/.test(titleStripped)) return true;
  return false;
}

export interface DeferredItemExtraction {
  /** 承诺过要补的实施项（可立项） */
  items: string[];
  /** 承诺过要补、但只能由人做（真机/凭据/部署…）的项——只登记，不立项 */
  manualItems: string[];
  /**
   * zx_20261119_2 M1：「留待**某个子任务/批次**」的交接项——承接方在册或在排，**不是缺口**。
   * 只登记 `verification_deferred_items`，不并入 issues、不派生修复任务。
   */
  handoffItems: string[];
  /** 超上限被截掉的条数 */
  overflow: number;
}

const DEFERRED_RE = /留到|留待|推迟到|延后到|后续批|下一批/;
const OUT_OF_SCOPE_RE = /明确不做|不在本轮|不纳入本轮|out of scope|非本轮|不做清单/i;
const DONE_RE = /已完成|已落地|已解决|已实现|已补齐|已作废/;

/** zx_20261119_2 M1：交接措辞的显式信号——说"子任务/兄弟任务"就是把活交出去了。 */
const HANDOFF_HINT_RE = /子任务|兄弟任务/;
/**
 * zx_20261119_2 M1：批次/条目号（`S1–S7`、`U1/U2/U3`、`B2-1`、`M5`）——方案内编号即"另有承接批次"。
 * 词界要求：前一个字符不能是字母数字，免得把 `ABC1` 之类英文词当编号。
 */
const BATCH_TOKEN_RE = /(^|[^A-Za-z0-9])(?:[USBCMT]\d+)(?![A-Za-z0-9])/;

/**
 * zx_20261119_2 M1：这一行是不是「交接」而不是「缺口」。
 *
 * 真标本（S2）：`编译留待 S1–S7 批次统一验证` / `运行时行为证据留待子任务「后端测试用例补充与回归」补齐`。
 * 旧口径把这两句当可修问题派了修复任务，而修复者只能写"归属说明"。
 */
export function isDeferredHandoff(line: string, siblingTitles: string[] = []): boolean {
  const s = String(line ?? '');
  if (HANDOFF_HINT_RE.test(s)) return true;
  for (const t of siblingTitles) {
    const title = String(t ?? '').trim();
    if (title.length >= 6 && s.includes(title)) return true;
  }
  return BATCH_TOKEN_RE.test(s);
}

/**
 * zx_20261117_1 M1「案」：从方案/报告正文里抽出**纯文本的「留到后续」清单**。
 *
 * 病根：`issueFromLine` 只认 ❌/⚠ 字形；`plans/…§10.16.6.4` 原文「留到 B2 后续批」没有字形
 * ⇒ 不进 `issues`，finalize 不点名、不派生后续任务（标本 02）。
 *
 * 只认**承诺过要补**的措辞（留到/留待/推迟到/延后到/后续批/下一批），并：
 *   · 跳过已完成/已落地/已作废行（防止把"已完成…B2 后续批落地"的历史回填当未落地项）；
 *   · 跳过"明确不做/不在本轮/out of scope"边界声明；
 *   · 命中 `isHumanOnlyIssue` 的进 `manualItems`，不进 `items`；
 *   · 上限 `MAX_DEFERRED_ITEMS`，超出由 `overflow` 如实上报。
 */
export interface DeferredExtractOptions {
  /** zx_20261119_2 M1：同父兄弟任务标题——行内点名它们即视为"交接"，不是缺口。 */
  siblingTitles?: string[];
}

export function extractDeferredItems(texts: string[], opts: DeferredExtractOptions = {}): DeferredItemExtraction {
  const siblingTitles = Array.isArray(opts.siblingTitles) ? opts.siblingTitles : [];
  const seen = new Set<string>();
  const items: string[] = [];
  const manual: string[] = [];
  const handoff: string[] = [];
  let overflow = 0;
  for (const text of texts) {
    let inFence = false;
    for (const line of String(text ?? '').split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('```')) { inFence = !inFence; continue; }
      if (inFence || !trimmed) continue;
      if (!DEFERRED_RE.test(trimmed)) continue;
      if (OUT_OF_SCOPE_RE.test(trimmed) || DONE_RE.test(trimmed)) continue;
      const cleaned = normalizeCell(trimmed).slice(0, 240);
      if (cleaned.length < 6) continue;
      const key = dedupKey(cleaned);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (isHumanOnlyIssue(cleaned)) {
        if (manual.length < MAX_MANUAL_ITEMS) manual.push(cleaned);
        else overflow++;
        continue;
      }
      // zx_20261119_2 M1：交接项排在限额之前——它本来就不该占 issues 的槽。
      if (isDeferredHandoff(cleaned, siblingTitles)) { handoff.push(cleaned); continue; }
      if (items.length >= MAX_DEFERRED_ITEMS) { overflow++; continue; }
      items.push(cleaned);
    }
  }
  return { items, manualItems: manual, handoffItems: handoff, overflow };
}

/** 只用到 prepare().run()/get() 的最小库接口（M1 起去重合并要读既有行）。 */
export interface VerificationFixDb {
  prepare(sql: string): {
    run(...args: unknown[]): { changes?: number };
    get(...args: unknown[]): unknown;
    all(...args: unknown[]): unknown[];
  };
}

export interface CreateVerificationFixOptions {
  db: VerificationFixDb;
  /** 核实报告任务 id */
  taskId: string;
  projectId: string;
  issues: string[];
  /** zx_20261119_2 M1：报告任务标题——写进 context，供 GUI 显示「修复自 X」 */
  reportTitle?: string;
  /**
   * zx_20261116_1 M6（序）：额外前置——同父的**在途**兄弟任务 id。
   *
   * 病根：旧实现只把“报告任务”当前置；同父的其它子任务（真事故 `72319f17`）仍在跑时，
   * 修复任务可与它同时改同一份方案文档（本次未冲突，但风险真实存在）。窄版只串在途兄弟；
   * `pending/paused/failed/archived` 不纳入（尚未动手 / 已在等人处置）。
   */
  extraDependsOn?: string[];
}

export interface VerificationFixTask {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  dependsOn: string;
  parentTaskId: null;
  /** zx_20261119_2 M1：true = 并入同父既有派生修复任务（本次未新建行） */
  merged: boolean;
}

/**
 * 立一个修复任务：**根任务 + 前置=报告任务**，不立即入队。
 *
 * 验收标准逐条带"要什么证据"——旧模板「已落地且可核验」对"未落地"的问题是空话，
 * 修复者只能自报"已落地"，核验者无从复核。
 */
/** 从「N. xxx」编号描述里取回问题列表（合并时复用）。 */
function splitNumbered(text: string): string[] {
  return String(text ?? '')
    .split('\n')
    .map((line) => line.replace(/^\s*\d+[.、)]\s*/, '').trim())
    .filter(Boolean);
}

/** 标题里的首条问题摘要：压空白、截 24 字（超出加省略号）。 */
function summarizeIssue(s: string): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > 24 ? `${t.slice(0, 24)}…` : t;
}

function fixTitleOf(issues: string[]): string {
  const head = issues[0] ? `：${summarizeIssue(issues[0])}` : '';
  return `修复核实发现的未落地问题（${issues.length} 个）${head}`;
}

function acceptanceOf(issues: string[]): string {
  return issues
    .map((s, i) => `${i + 1}. ${s} —— 修复已落地，并给出可复核证据（文件:行 / 脚本命令与输出 / 构建日志）`)
    .join('\n');
}

export function createVerificationFixTask(opts: CreateVerificationFixOptions): VerificationFixTask {
  const { db, taskId, projectId, issues } = opts;
  // 前置：报告任务 + 在途兄弟（去重、去空）。旧行为（不传 extraDependsOn）逐字不变。
  const dependsOn = [taskId, ...(opts.extraDependsOn ?? [])]
    .filter((v) => typeof v === 'string' && v.trim().length > 0)
    .filter((v, i, arr) => arr.indexOf(v) === i)
    .join(',');

  // zx_20261119_2 M1：同父同源去重合并——此前同父二次核实会各建一条**同名**孤立任务。
  // 判据只认「同项目 + 同 verification_fix_of + 未归档/未失败」；不同报告任务仍各立一条。
  try {
    const existing = db.prepare(
      "SELECT id, title, description, acceptance_criteria, context_json FROM wa_tasks "
      + "WHERE project_id = ? AND source = 'agent' AND status NOT IN ('archived','failed') "
      + "AND json_extract(context_json, '$.verification_fix_of') = ? ORDER BY created_at ASC LIMIT 1",
    ).get(projectId, taskId) as
      { id: string; title: string; description: string; acceptance_criteria: string; context_json: string } | undefined;
    if (existing) {
      const merged = splitNumbered(existing.description);
      const added: string[] = [];
      for (const s of issues) {
        if (!merged.some((e) => dedupKey(e) === dedupKey(s))) { merged.push(s); added.push(s); }
      }
      if (added.length > 0) {
        const title = fixTitleOf(merged);
        const description = merged.map((s, i) => `${i + 1}. ${s}`).join('\n');
        const acceptanceCriteria = acceptanceOf(merged);
        db.prepare("UPDATE wa_tasks SET title = ?, description = ?, acceptance_criteria = ?, updated_at = datetime('now') WHERE id = ?")
          .run(title, description, acceptanceCriteria, existing.id);
        // 合并痕：只追加这一格，保留 verification_fix_of / verification_fix_created 等兄弟键。
        const ctx = JSON.parse(existing.context_json || '{}') as { verification_fix_merged?: string[] };
        const mergedLog = [...(Array.isArray(ctx.verification_fix_merged) ? ctx.verification_fix_merged : []), ...added];
        db.prepare("UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json, '{}'), '$.verification_fix_merged', json(?)) WHERE id = ?")
          .run(JSON.stringify(mergedLog), existing.id);
        return { id: existing.id, title, description, acceptanceCriteria, dependsOn, parentTaskId: null, merged: true };
      }
      // 无新条目 ⇒ 幂等：不新建、不改行。
      return {
        id: existing.id, title: existing.title, description: existing.description,
        acceptanceCriteria: existing.acceptance_criteria, dependsOn, parentTaskId: null, merged: true,
      };
    }
  } catch { /* 去重查询失败不阻断立项（宁可多一条，不可漏一条） */ }

  const id = randomUUID();
  const title = fixTitleOf(issues);
  const description = issues.map((s, i) => `${i + 1}. ${s}`).join('\n');
  const acceptanceCriteria = acceptanceOf(issues);
  // zx_20261120_3 M1：来源任务有岗位 ⇒ 修复任务继承（停用/未绑定 ⇒ none）。
  const derivedPosition = deriveTaskPosition(db, { projectId, parentTaskId: taskId });
  const contextJson = JSON.stringify({
    depth: 1,
    verification_fix: true,
    verification_fix_of: taskId,
    ...(opts.reportTitle ? { verification_fix_of_title: opts.reportTitle.slice(0, 200) } : {}),
    ...positionContextFields(derivedPosition),
  });
  db.prepare(
    "INSERT INTO wa_tasks (id, project_id, title, description, status, priority, parent_task_id, depends_on, source, acceptance_criteria, context_json, position_id) VALUES (?, ?, ?, ?, 'pending', 2, NULL, ?, 'agent', ?, ?, ?)",
  ).run(id, projectId, title, description, dependsOn, acceptanceCriteria, contextJson, derivedPosition.positionId);
  return { id, title, description, acceptanceCriteria, dependsOn, parentTaskId: null, merged: false };
}
