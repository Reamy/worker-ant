/**
 * runFinalizeTask **finalize_task 执行体** —— 从 `core/tools/control.ts` 的 `finalize_task` 工具
 * **机械搬迁**而来（zx_20261003 M8，**纯搬移·零语义变更**）。搬迁来源符号区间：`control.ts:116-744`
 * （`finalize_task` execute）。
 *
 * 是什么：完成任务并落账的整段实现——完成自检（子任务/产出物/MCP 注册/产出方案待确认/核实问题闭环）、
 *   方案里程碑登记与回写、质量与目标达成记账、四道完成封顶、产出物缺失与内容充分性门禁、验收标准核对
 *   与「已验证成果配方」沉淀、收尾探针产出物处置、低分置暂停待人工。
 *
 * 为什么单独成模块：该 execute 体是 `control.ts` 内单体量最大的工具体；其对外可变通道是 `ctxJson`
 *   （收尾上下文，按引用读改写回库），依赖面已由 `ToolDeps` 的 15 个字段给出 ⇒ **零新增参数**。
 *   搬迁纪律：工具名 / `description` / 参数 schema / execute 行为 / 返回形状一律不动——schema 与
 *   description 仍留在 `control.ts` 的 `finalize_task` 工具对象内，本文件只承载 execute 体。
 *
 * ⚠ 运行时 import 回 `./control.js`（`gitRootsOfDirs` 仓根归位——真源仍在 control.ts 一处，未复制第二份）；
 *   该绑定只在函数体内读、不在模块顶层求值 ⇒ 与 `exec-*` 同形，ESM 循环引用不触发 TDZ。
 */

import type { ToolDeps } from './deps.js';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { PAUSE_REASON_QUALITY_BELOW_BAR } from '../pause-reason.js';
import { boolSetting, readBoolSetting } from '../settings-bool.js';
// zx_20260930 M8: 归并读点须排除墓碑（`MEM_LIVE_SQL` 一处真源）。
import { MEM_LIVE_SQL } from '../memory-lifecycle.js';
import { buildCompletionAccount, goalAchievedOf } from '../task-outcome.js';
import { readTaskAcceptanceCriteria, criteriaSourceOf, UNVERIFIED_REASON_LABEL, isAcceptanceVerified, acceptanceVerdictOf } from '../acceptance-check.js';
import { MAX_MANUAL_ITEMS, MAX_VERIFICATION_ISSUES, createVerificationFixTask, extractVerificationIssues, isReportDocPath } from '../verification-issues.js';
import { eventBus } from '../event-bus.js';
import { failedChildren, childNames } from '../children-gate.js';
import { getTensions } from '../tension-engine.js';
import { pauseTask } from '../pause-task.js';
import { childCompletionCheckLabel, classifyChildCompletion, milestoneBoardOwner, milestoneSubjectVerdict, isPlanOrImplTask, declaredMilestones, unclaimedMilestones, childBreadthRefusal, writeMilestoneDone, backfillBoardRemainderToSelf, milestoneTokenRegex, isVerificationTask } from '../task-accounting.js';
import { runShellCommand } from '../shell-exec.js';
// zx_20260922_1 M6（F8）: 「预算到没到顶」的唯一判据（零依赖纯函数，与禁用侧同源）——不在此另算一遍。
import { budgetCapReached } from '../step-budget.js';
import { selectProbeDeliverables, disposeProbeDeliverables, autoAssignPrimary } from '../deliverable-lifecycle.js';
import { gitRootsOfDirs } from './control.js';
import { gitGateVerdict, ownedPaths } from '../task-file-ledger.js';
import { ARCHETYPE_TOOL_CATEGORIES } from '../task-archetype.js';

/**
 * 引擎代拟验收未达成项的可读告警行（zx_20261022_1 批四）。
 * 纯函数、无副作用，供收口与受控回归直引同一份实现——文案一改，两处同变。
 * 上限 3 条：够定位，又不让收口消息被长清单淹没。无未达成项时返回 null。
 */
export function proposedMissWarning(
  checked: Array<{ criterion: string; note?: string | null; passed?: boolean }> | undefined,
  total: number,
): string | null {
  const missed = (checked ?? []).filter((c) => !c.passed);
  if (missed.length === 0) return null;
  const shown = missed.slice(0, 3).map((c) => `${c.criterion}（${c.note || '未说明'}）`).join('；');
  return `[WARN] 引擎自核未达成 ${missed.length}/${total} 条：${shown}${missed.length > 3 ? '；……' : ''}——仅记录，不阻断收口`;
}

export async function runFinalizeTask(deps: ToolDeps, args: { summary: string; quality?: string; probe_disposition?: string; probe_keep_reason?: string; scheme_ref_mode?: string }): Promise<string> {
  const { ctx, db, taskId, projectId, workingDir, checkAcceptanceCriteria, syncQualityColumn, archetypeForFile, formatInsufficiencyReasons, fileSig, addSideTokens, checkMCPRegistrationIntegrity, expectedOutputMiss, docValidationTargets, completionCapFloors, truncatedReads } = deps;
  // 任务完成自检：子任务完成状态 + 产出物注册状态 + AI内容
  const checks: string[] = [];

  // 检查1：直接子任务是否完成
  const myChildren = db.prepare("SELECT id, title, status, context_json FROM wa_tasks WHERE parent_task_id = ?").all(taskId) as Array<{ id: string; title: string; status: string; context_json: string | null }>;
  // zx_20260913 M3-6(同一把尺): 判据与 :1059 收敛为三值形态——已归档子任务不该阻塞父完成
  const incompleteChildren = myChildren.filter(s => !['completed', 'failed', 'archived'].includes(s.status));
  // zx_20260915 P0-3(c)(同一把尺): 失败子**先**判——它不在"未完成"集里，先问未完成即被静默略过。
  const failedKids = failedChildren(db, taskId);
  if (failedKids.length > 0) {
    return JSON.stringify({
      error: `有${failedKids.length}个子任务失败未处置(${childNames(failedKids)}). 请先重试；确属失败的用 update_task_status 置为 archived（带 reason）＝放弃，父任务即可继续收口。`,
      failedChildren: failedKids.map(c => c.id),
    });
  }
  if (incompleteChildren.length > 0) {
    return JSON.stringify({
      error: `还有${incompleteChildren.length}个子任务未完成(${incompleteChildren.map(c => c.title).join('; ')}). 请等待子任务完成后再finalize。`,
      incompleteCount: incompleteChildren.length,
    });
  }
  // zx_20260911_3 M4(如實): 完成计数须分类——空壳(置完成但无产出证据)不得冒名"全部完成"（E7）
  checks.push(childCompletionCheckLabel(classifyChildCompletion(myChildren)));
  // zx_20261028_2 M4：模板拆出的子任务**从未启动就被归档**（"没被采用"）与"做了没成"是两件事，
  //   后者已由上面那条如实计数，前者此前一个字都不说。按"归档 ∧ 无任何对话行"判定（启动过必留对话）。
  try {
    const unusedTpl = db.prepare(`
      SELECT c.title FROM wa_tasks c
      WHERE c.parent_task_id = ? AND c.source = 'template' AND c.status = 'archived'
        AND NOT EXISTS (SELECT 1 FROM wa_task_conversations v WHERE v.task_id = c.id)
    `).all(taskId) as Array<{ title: string }>;
    if (unusedTpl.length > 0) {
      checks.push(`[INFO] 模板子任务未被采用 ${unusedTpl.length} 个（均未启动）：${unusedTpl.map((u) => u.title).join('、')}——已归档，不计入交付`);
    }
  } catch { /* 未采用盘点 best-effort */ }
  // zx_20260904_6 D2 (2026-09-04): 父编排收尾前"里程碑缺口核查"——编排父(有子任务)文本声明 M 里程碑但缺对应子任务 → 阻止 finalize
  // zx_20260923 M4-a（G5）: `myChildren.length > 0` 短路**去掉**——0 子任务时整段跳过，恰是需求
  //   "逐里程碑建子任务"最没被满足的一刻（真库标本 a290ae2b：0 子任务、板上 M0–M5 齐全、一路放行）。
  //   ⚠ 但**不是**把"无子任务"直接判成缺口：`题面出现 M\d+` ≠ `承诺拆子任务`。全库回放实测，
  //   按题面字面判缺口会驳回 **62/62 条已成功完成**的任务（如「M2(F2)决策指令Schema契约化」只提到自己），
  //   排掉自指标签后仍误伤 28 条。故分两级后果（判据同源、后果按证据强度分）：
  //     · 有子任务 ⇒ 编排父的证据就在眼前，**维持原驳回**（2026-09-04 D2 行为分毫未动）；
  //     · 无子任务 ⇒ 缺口**如实报**（入 `checks`/`finalize_checks`），不驳回——报出来是职责，替用户
  //       判定"这条任务该不该拆"则越界（本任务是否确需拆，只有题面与用户知道）。
  try {
    const pRow = db.prepare('SELECT title, description FROM wa_tasks WHERE id = ?').get(taskId) as { title: string; description: string } | undefined;
    const missing = unclaimedMilestones(
      declaredMilestones(pRow?.title, pRow?.description),
      myChildren.map((c) => c.title),
    );
    if (missing.length > 0) {
      const msg = `编排父收尾前里程碑缺口核查：任务声明含 ${missing.join('、')} 但尚无对应子任务。请先用 create_task 创建这些里程碑子任务（若确为引用而非待实施，请从描述移除）后再 finalize。`;
      if (myChildren.length > 0) {
        return JSON.stringify({ error: msg, missingMilestones: missing });
      }
      checks.push(`[WARN] ${msg}`);
    }
  } catch { /* 缺口核查失败不阻断（尽力而为） */ }
  // zx_20260904_6 D5 (2026-09-04): 实施类任务声明"提交/git"且工作树仍脏 → 阻止 finalize 先提交（防"完成=工作树残留"）
  // zx_20260923 M7-a（G13）: 判据从"workingDir 下有没有 `.git`"改为**交付物锚定的仓根归位**
  //   （见 `gitRootsOfDirs` 头注释）——真库标本 31f6b443 那 28 项未提交改动因此才第一次被看见。
  //   逐仓检查、**各仓独立**：旧代码一个仓 `git status` 失败就 throw，把其余仓的检查一并带走。
  //   题面正则不动（`\bgit\b` 很宽）；找不到任何可归属的仓时仍**静默跳过**。
  try {
    const dpRow = db.prepare('SELECT title, description FROM wa_tasks WHERE id = ?').get(taskId) as { title: string; description: string } | undefined;
    const mentionsGit = /(提交|commit|\bgit\b)/.test(`${dpRow?.title || ''} ${dpRow?.description || ''}`);
    if (mentionsGit) {
      // zx_20261022_3 批十二（信·名实）：提交闸**认工具面 + 认路径归属**——
      //   旧实现拿整仓 `git status` 判，多任务共写一树时他人的脏文件会把本任务拦住；
      //   本任务形态若连 shell 都没有（真标本 094a8b47/e54532f9 被判 document），硬拦即死锁。
      //   判据唯一真源在 `task-file-ledger.ts` 的 `gitGateVerdict`（纯函数，rr 直跑）。
      const owned = ownedPaths(db, taskId);
      const archetypeNow = String((ctx as { archetype?: string }).archetype || '');
      const hasShell = archetypeNow
        ? (ARCHETYPE_TOOL_CATEGORIES[archetypeNow as keyof typeof ARCHETYPE_TOOL_CATEGORIES] ?? []).includes('shell')
        : false;
      const roots = gitRootsOfDirs([workingDir, ...owned.map(p => path.dirname(p))]);
      const dirt: Array<{ root: string; lines: string[] }> = [];
      for (const root of roots) {
        try {
          // zx_20260916_2 M1: 30s 上限（原 execSync 无 timeout ⇒ 卡住的 git 会把界面按住不放）
          const gitRes = await runShellCommand('git status --porcelain', { cwd: root, timeoutMs: 30_000, maxBuffer: 1024 * 1024 });
          if (!gitRes.ok) continue; // 该仓查不动 ⇒ 只跳过它，不带走其余仓的检查
          const lines = gitRes.stdout.split('\n').filter(Boolean);
          if (lines.length > 0) dirt.push({ root, lines });
        } catch { /* 该仓检查失败不阻断 */ }
      }
      const verdict = gitGateVerdict({ mentionsGit, hasShell, owned, dirt });
      if (verdict.mode === 'block') {
        const shown = verdict.ownedDirty.slice(0, 8);
        return JSON.stringify({
          error: `finalize 被拦：本任务自有 ${verdict.ownedDirty.length} 个文件未提交（${shown.join('、')}${verdict.ownedDirty.length > 8 ? ' 等' : ''}）。`
            + `请只提交本任务的文件：git add -- ${shown.map(p => `"${p}"`).join(' ')} && git commit -m "<说明>"。`
            + `工作树中其他改动的归属不在本任务，不要求你提交。`,
          uncommittedCount: verdict.ownedDirty.length,
          ownedDirty: shown,
        });
      }
      if (verdict.mode === 'warn') {
        checks.push(`[WARN] 提交门禁降级：${verdict.reason}——请人工核验本任务产出是否需要提交。`);
      }
    }
  } catch { /* 提交门禁失败不阻断（尽力而为） */ }

  // 检查2：产出物注册状态（2026-09-07 修正：register_deliverable/write_file 建行即 status='draft'，
  //        finalize 收尾 promoteTaskFileDeliverables 才置 completed——故 draft 属"已注册待收尾提升"，不再误报未注册；
  //        仅对超出 草稿/已注册/已完成/运行中 的异常状态告警）
  const deliverables = db.prepare('SELECT name, type, status FROM wa_deliverables WHERE task_id = ?').all(taskId) as Array<{ name: string; type: string; status: string }>;
  const abnormal = deliverables.filter(d => !['draft', 'registered', 'completed', 'running'].includes(d.status));
  if (deliverables.length === 0) {
    checks.push('[WARN] 无产出物');
  } else if (abnormal.length > 0) {
    checks.push(`[WARN] 产出物存在异常状态(${abnormal.length}): ${abnormal.map(d => `${d.name}(${d.status})`).join(', ')}`);
  } else {
    checks.push('[PASS] 所有产出物已注册');
  }

  // 检查3：是否有AI产出内容
  const assistantMsgs = db.prepare("SELECT COUNT(*) as count FROM wa_task_conversations WHERE task_id = ? AND role = 'assistant'").get(taskId) as { count: number };
  checks.push(assistantMsgs.count > 0 ? `[PASS] AI已产出 ${assistantMsgs.count} 条回复` : '[WARN] 无AI产出内容');

  // 检查4：MCP工具注册完整性（结果验证，非评分——import 但未在 lifespan 调用则阻断 finalize，强制补齐）
  const missingRegs = checkMCPRegistrationIntegrity(workingDir);
  if (missingRegs.length > 0) {
    return JSON.stringify({
      error: `工具模块已 import 但未在 lifespan 注册调用: ${missingRegs.join(', ')}。请在主文件的 lifespan 中添加注册调用后再 finalize。`,
      missingRegistrations: missingRegs,
    });
  }
  checks.push('[PASS] 工具模块 import 与注册调用一致');

  // 检查6：产出物文档「待确认」事项（致良知——方案产出中的待确认事项须向用户确认，不自行替用户决策）
  try {
    const docRows = db.prepare("SELECT file_path FROM wa_deliverables WHERE task_id = ? AND type = 'doc'").all(taskId) as Array<{ file_path: string | null }>;
    const pendingItems: string[] = [];
    for (const d of docRows) {
      if (!d.file_path) continue;
      let content = '';
      try { content = await fsp.readFile(d.file_path, 'utf-8'); } catch { continue; }
      if (!/待确认|需用户确认|需确认|待决策|待答复|待核实/.test(content)) continue;
      const re = /\*\*【([^】]+)】\*\*/g;
      let m;
      while ((m = re.exec(content)) !== null) {
        const label = m[1]!.trim();
        if (/确认|澄清|决策|答复|核实|核对|待定/.test(label) && !pendingItems.includes(label)) pendingItems.push(label);
      }
    }
    if (pendingItems.length > 0) {
      return JSON.stringify({
        error: `产出方案中存在 ${pendingItems.length} 个待确认事项，须先向用户确认。请调用 ask_user 工具（question 列出这些事项），等待用户回复后再 finalize。待确认事项：${pendingItems.join('；')}`,
        pendingConfirmations: pendingItems,
      });
    }
  } catch { /* 待确认检测失败不阻断 finalize */ }

  // 检查7：核实问题闭环（实事求是——核实发现的未落地问题须流转到修复，不停留在报告）
  try {
    const fixCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}');
    // 修复任务自身不再下钻：核实 → 修复 → 再核实 的递归无休（真库 `e1033ab6` 已是修复任务，
    //   若它的产出里再出现 ⚠/❌，就会再派生一个"修复修复任务"）。
    if (!fixCtx.verification_fix_created && !fixCtx.verification_fix) {
      const docRows = db.prepare("SELECT file_path FROM wa_deliverables WHERE task_id = ? AND type = 'doc'").all(taskId) as Array<{ file_path: string | null }>;
      const contents: string[] = [];
      for (const d of docRows) {
        // 只读报告类文档：源码/配置注释里的 ❌/⚠ 不是核实结论（`openapi.yaml` 的变更注记曾被当成问题立项）。
        if (!isReportDocPath(d.file_path)) continue;
        try { contents.push(await fsp.readFile(d.file_path, 'utf-8')); } catch { continue; }
      }
      // zx_20261021_2 D4（批四）：抽取规则收进 `verification-issues.ts`——取**主语**而非判定列
      //   （旧实现取"第一个含 ❌/⚠️ 的单元格"，真库派生任务因此长出「1. 不通过」「8. ️」）。
      //   零依赖模块，rr 可喂真报告片段直接断言。
      const { issues, manualItems, manualOverflow, overflow } = extractVerificationIssues(contents);
      // zx_20261029_3 M1：待人事项（GUI/真机/外部实例/凭据/部署）**不立项**——派给智能体只能空转。
      //   登记进 context_json 供界面/后续轮次查账；与下面"建修复任务"共用同一份 fixCtx，键不互相覆盖。
      if (manualItems.length > 0) {
        fixCtx.verification_manual_items = manualItems;
        db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(fixCtx), taskId);
        checks.push(
          `[INFO] 其中 ${manualItems.length} 条需人工执行（已登记，不自动立项）：${manualItems.map((s, i) => `${i + 1}. ${s}`).join(' ')}` +
            (manualOverflow > 0 ? `；另 ${manualOverflow} 条未列出（展示上限 ${MAX_MANUAL_ITEMS} 条）` : ''),
        );
      }
      if (issues.length > 0) {
        // E4 (2026-09-03): 规划/排期类任务默认不自动下钻实现子任务——
        // 其 ⚠️/❌ 是「待后续实施/待闭环」的里程碑项，而非应立即修复的未落地问题；
        // 确需实施应单独创建实施任务（三前置：方案口径已确认 + 指定 M 项 + 回归自检）。
        let planRow: { title: string; description: string } | undefined;
        try { planRow = db.prepare('SELECT title, description FROM wa_tasks WHERE id = ?').get(taskId) as { title: string; description: string } | undefined; } catch { /* ignore */ }
        const planText = `${planRow?.title || ''} ${planRow?.description || ''}`;
        // zx_20260915 P0-9（**刻意不并入** `task-accounting.PLAN_TASK_KEYWORDS`，原因如实登记在此）：
        // 本判据管的是「方案文档里的 ⚠/❌ 要不要自动下钻修复任务」，与「谁是里程碑主体」是两件事——
        // 正类这里是 `规划|排期`（**无"方案"**），负类这里是 `核实报告|完成情况核实|审计|盘点`（**无"核验/复核/检查"，却多"盘点"**）。
        // 强行并表会**同时**改掉两条判据：用里程碑那份词表会把「…方案…」类任务从"下钻修复"翻成"不下钻"。
        const isPlanProposal = /(规划|排期)/.test(planText) && !/(核实报告|完成情况核实|审计|盘点)/.test(planText);
        if (isPlanProposal) {
          checks.push(`[INFO] 方案文档含 ${issues.length} 处 ⚠/❌（属待后续实施/待闭环的里程碑项）——规划类任务不自动下钻实现子任务；如需实施请单独创建实施任务（附：方案口径已确认 + 指定 M 项 + 回归自检）。`);
        } else {
          // zx_20260916_3 M1（D1 全覆盖 / 毛选·惩前毖后治病救人）：引擎**自发**补救同样受理于广度闸。
          // 闸满时**如实上报**"发现问题但槽位已满"，而非静默突破上限（旧行为：这条路完全不查上限）。
          const fixRefusal = childBreadthRefusal(db, taskId);
          if (fixRefusal) {
            checks.push(`[WARN] 核实发现 ${issues.length} 个未落地问题，但槽位已满，**引擎未自动创建修复任务**。${fixRefusal}`);
          } else {
            // 本例的验收标准有**许诺者**（父任务的核实结论逐条点名），故落标准而非留空——
            // 留空虽也会被如实记为 no_criteria，但那是"无人许诺"的情形，不适用于此。
            // zx_20261021_2 D4：改**根任务 + depends_on=本任务**，且**不再 enqueueJob**——
            //   旧实现建子任务并立即入队，父还在收尾、子已开跑，两边改同一批文件；子任务还会
            //   顶住父的收口闸（`children-gate` 的 `children_incomplete`）。现由调度器（10s 扫描）
            //   在本任务到终态后接续：语义是"报告收口后再修"。
            const fix = createVerificationFixTask({ db, taskId, projectId, issues });
            fixCtx.verification_fix_created = fix.id;
            db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(fixCtx), taskId);
            checks.push(`[WARN] 核实发现 ${issues.length} 个未落地问题，已建立修复任务（前置=本任务，将在本任务收口后由调度器接续，不与本任务并发）`);
            if (overflow > 0) checks.push(`[INFO] 另有 ${overflow} 条未立项（单批上限 ${MAX_VERIFICATION_ISSUES} 条）`);
          }
        }
      }
    }
  } catch { /* 问题闭环 best-effort */ }

  // B1 (2026-09-03_1): 方案里程碑登记——doc 交付物含 M\d 且属方案类 → 登记 pending（规划↔实施追踪）
  // zx_20260915 P0-9 三处收口（开关 `engine.milestone_subject_check`，缺省开）：
  //   (a) 主体校验：核验类任务不得挂板（真库 8a6f226a 把 M0–M8 登成"待实施"，与 f07ad74a 那块板逐字相同）；
  //   (b) 板内幂等：目标板上已有同名里程碑 ⇒ 跳过，并按**真实写入行数**如实报（旧代码 INSERT OR IGNORE
  //       可能写 0 行却照报"已登记"，是"名实不符"）；跨板同名**不跳过**——「每轮一块新板」是全部 21 块板的成因；
  //   (c) scheme_ref_mode='reference' ⇒ 只引用不登记（与 :1017 缺口核查的既有正解同向）。
  try {
    const bctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}');
    if (bctx.plan_milestones_registered) {
      /* 本任务已登记过，不重复 */
    } else if (args.scheme_ref_mode === 'reference') {
      checks.push('[INFO] 方案引用模式（reference）：仅引用既有方案里程碑，不登记、不置"待实施"');
    } else {
      const brow = db.prepare('SELECT title, description FROM wa_tasks WHERE id = ?').get(taskId) as { title: string; description: string } | undefined;
      const btext = `${brow?.title || ''} ${brow?.description || ''}`;
      const subjectCheck = readBoolSetting(db, 'engine.milestone_subject_check');
      // 开关关 ⇒ 逐例回到旧判据（`found.size >= 2 || isPlanish`），不做主体校验、不做幂等
      const oldPlanish = /(规划|排期|方案)/.test(btext);
      const bdocs = db.prepare("SELECT file_path FROM wa_deliverables WHERE task_id = ? AND type = 'doc'").all(taskId) as Array<{ file_path: string | null }>;
      const found = new Set<string>();
      for (const d of bdocs) {
        if (!d.file_path) continue;
        let c = '';
        try { c = await fsp.readFile(d.file_path, 'utf-8'); } catch { continue; }
        const re = milestoneTokenRegex(); let mm;
        while ((mm = re.exec(c)) !== null) found.add(mm[0]);
      }
      // archetype 取**持久化**值（:3058 `taskCtx.archetype = archetype` 落 context_json）——
      // 不引本轮 `const archetype`：登记闭包定义在其声明之前，跨声明读取脆弱。
      const verdict = subjectCheck
        ? milestoneSubjectVerdict(btext, typeof bctx.archetype === 'string' ? bctx.archetype : null)
        : ({ ok: true } as const);
      const gateOk = subjectCheck ? isPlanOrImplTask(btext) : (found.size >= 2 || oldPlanish);
      if (!verdict.ok) {
        // 不登记这件事本身也要如实说出来（否则"没登记"与"登记失败"在用户眼里一模一样）；
        // 但真无里程碑可登时不必刷——found 为空则本就没有"待实施"可言。
        if (found.size > 0) checks.push(verdict.reason);
      } else if (found.size > 0 && gateOk) {
        // zx_20260910_2 M2: 板主优先取「被显式关联的方案任务」——此前恒以 self 登记，仅凭标题含
        // 「方案/规划/排期」就让实施锚父凭空长出第二块与真实方案板并行的空板（现象3：两块各 9 行全 pending）。
        // 规划任务登记自己的里程碑是正确语义，故无显式关联时维持原状（自建板）。
        const ownerTaskId = milestoneBoardOwner(bctx) ?? taskId;
        // 板主跨任务时取其自身 project_id（防跨项目关联时给里程碑挂错项目）
        const bp = ownerTaskId === taskId ? undefined : db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(ownerTaskId) as { project_id?: string } | undefined;
        const ownerProjectId = bp?.project_id || projectId;
        const mss = [...found].sort();
        // (b) 板内查重：`(plan_task_id, milestone)` 已存在 ⇒ 跳过该枚（跨板同名不在此列）
        const alreadyOn = new Map<string, string>();
        if (subjectCheck) {
          const q = db.prepare('SELECT implemented_by_task_id FROM wa_plan_milestones WHERE plan_task_id = ? AND milestone = ?');
          for (const ms of mss) {
            const r = q.get(ownerTaskId, ms) as { implemented_by_task_id?: string | null } | undefined;
            if (r) alreadyOn.set(ms, typeof r.implemented_by_task_id === 'string' && r.implemented_by_task_id ? r.implemented_by_task_id : ownerTaskId);
          }
        }
        const ins = db.prepare("INSERT OR IGNORE INTO wa_plan_milestones (id, project_id, plan_task_id, milestone, status, updated_at) VALUES (?, ?, ?, ?, 'pending', datetime('now'))");
        const created: string[] = [];
        for (const ms of mss) {
          if (alreadyOn.has(ms)) continue;
          ins.run(crypto.randomUUID(), ownerProjectId, ownerTaskId, ms);
          created.push(ms);
        }
        bctx.plan_milestones_registered = true;
        // zx_20260923 M4-c（G7）: 旗**只**承诺"板上确有行"（这句为真，故保留 `true` 不改语义）；
        //   但"登记到板"与"已有子任务承接"是两件事，此前二者的差额**全库无人记录**。
        //   真库标本 a290ae2b：板上 M0–M5 齐全、同名子任务 **0 个**，一路报"已登记…（待实施）"，
        //   崩掉时用户看到的仍是一副"里程碑都安排好了"的样子。故与 :128 缺口核查**同源**
        //   （共用 `milestoneRefsIn`）算出差额，**如实写实际值**并报出来。
        //   ⚠ 刻意**不**把"无同名子任务"当成"不该置 true"：真库回放该改法会让 62 条已完成任务的
        //   事实被写反（行确实在板上），是"用一种名实不符换另一种"；且规划任务登记板、
        //   实施由后续轮次承接本来就是合法形态——只报不改判据。
        const uncovered = unclaimedMilestones(mss, myChildren.map((c) => c.title));
        bctx.milestones_without_child_tasks = uncovered;
        db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(bctx), taskId);
        if (created.length > 0) checks.push(`[INFO] 已登记方案里程碑 ${created.join('/')}（挂${ownerTaskId === taskId ? '本任务' : '关联方案'}板，待实施，见方案里程碑卡）`);
        for (const [ms, who] of alreadyOn) checks.push(`[INFO] 里程碑 ${ms} 已存在（任务 ${who.slice(0, 8)}），未重复登记`);
        if (uncovered.length > 0) {
          checks.push(`[WARN] 下列里程碑**已在板上但尚无同名子任务**：${uncovered.join('/')}（"登记" ≠ "已执行"；若本任务须逐里程碑建子任务，请用 create_task 补齐，否则请忽略本条）`);
        }
      }
    }
  } catch { /* 里程碑登记 best-effort */ }

  // 更新质量信息 + 自检结果到 context_json
  const ctxJson = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
  ctxJson.completion_summary = args.summary;
  // B1/B2 (2026-09-04): finalize 质量门——低质(<60) 或编排父的子未全完成时拒直接 finalized（预算强制收尾可绕过）
  // zx_20260922_1 M6（F8）: 与**禁用侧同源**——经 `budgetCapReached` 读同一个 `budget_warn_band`
  //   （由 `agent-executor.ts` 预算追踪段按 `max(tokenBand, costBand)` 一处算出并写回），
  //   不再单独读 Token 尺的 `budget_usage_ratio`。
  //   病根：费用尺爆表把 bash/read_file/edit_file 全禁光时，此处只读 Token 尺（14%）判"没到顶"
  //   ⇒ 干不了活 + 不许收口 同时成立（真库标本 `a290ae2b`）。band 4 = 95% 档 = 系统首次宣告"预算超限"。
  const forcedByBudget = budgetCapReached(ctxJson);
  // zx_20260904_3 D1 (2026-09-04): finalize 产出物门禁——任务要求产出指定文件但磁盘缺失 → 拒 finalize
  //（实践检验：完成以交付文件真实存在为据，非 LLM 自报；预算强制收尾时记录待人工复核并放行）
  const missOutputs = expectedOutputMiss(db, taskId, workingDir);
  if (missOutputs.length > 0) {
    if (!forcedByBudget) {
      return JSON.stringify({ error: `finalize 产出物门禁未通过：任务要求产出文件但未检测到实际文件（${missOutputs.join('、')}）。请先使用 write_file 实际写入后再 finalize；若确需收口请在任务管理执行"标记完成"。`, missingOutputs: missOutputs });
    }
    checks.push(`[WARN] 产出物门禁：任务要求 ${missOutputs.join('、')} 但未检测到实际文件（预算强制收尾放行，标记需人工复核）`);
    ctxJson.deliverable_unfulfilled = { paths: missOutputs, forced: true };
  }
  if (!forcedByBudget) {
    // zx_20260904_3 批4 (2026-09-04): finalize 内容充分性门禁——目标集(声明产出∪注册文档交付物)校验不充分 → 拒 finalize
    //（finalize 成功路径直通 completed，故须在工具内拦截；status unknown 不拦仅记录）
    const finalizeTargets = docValidationTargets(db, taskId, workingDir);
    if (finalizeTargets.length > 0) {
      try {
        const { validateOutputs, VALIDATION_CRITERIA_VERSION, LLM_VALIDATION_TIMEOUT_MS } = await import('../output-validator.js');
        const ansClient = await ctx.getAnsClient();
        // zx_20261028_2 M3：逐文件串行（单文件 30s abort ⇒ N 个文件最坏 N×30s，收口假死的病根）
        //   改为有界并发一批问完。结论仍按输入序返回，账目顺序与拒收文案一字未改。
        // zx_20260922_1 M7（F9）：`validateOutput` 的第三参（任务题面）早已删除——量文件，就问文件。
        const targets = finalizeTargets.map((abs) => ({ file: abs, archetype: archetypeForFile(abs) }));
        const results = await validateOutputs(ansClient as never, targets);
        const ov: Array<Record<string, unknown>> = [];
        const insufficient: string[] = [];
        const insuffReasons: Array<{ file: string; reasons: string[] }> = [];
        // zx_20261028_2 M3：`unknown`（辅助模型超时/不可用/内容不可解码）**不阻断但必须可见**——
        //   此前只落库不发声，收口后无人知道"充分"那栏其实是没问出来。
        const unverified: string[] = [];
        for (const r of results) {
          const abs = r.file;
          // 省耗账实(1a): 内容校验为旁路子 LLM——usage 记入执行期账本，收口并账（逐条累加）
          addSideTokens(ctx, r.usage);
          // zx_20260911_1 M2: issues(快检诊断) 与 missingAspects/suggestion(LLM诊断) 两条来源并存，如实各归其位
          const issues = r.quickCheck?.issues ?? [];
          const missingAspects = r.llmCheck?.missingAspects ?? [];
          const suggestion = r.llmCheck?.suggestion ?? '';
          const sig = fileSig(abs);
          // zx_20260906 批2: 记录 archetype/size/mtimeMs 供 run 收口处复用（同文件内容未变不再二次校验）
          // zx_20260923 M3（G8）：落**判据版本**——否则本 run 收口复用这条结论时无从判断
          //   "它是不是按当前判据问出来的"（写点与读点必须同源，故取同一个 `VALIDATION_CRITERIA_VERSION`）
          ov.push({ file: abs, archetype: r.archetype, status: r.status, sufficient: r.sufficient, confidence: r.confidence, issues, missingAspects, suggestion, reason: r.reason, size: sig?.size ?? null, mtimeMs: sig?.mtimeMs ?? null, criteriaVersion: VALIDATION_CRITERIA_VERSION });
          if (r.status === 'insufficient') {
            insufficient.push(abs);
            insuffReasons.push({ file: abs, reasons: issues.length > 0 ? issues : (missingAspects.length > 0 ? missingAspects : [suggestion].filter(Boolean)) });
          } else if (r.status === 'unknown') {
            unverified.push(path.basename(abs));
          }
        }
        ctxJson.output_validations = ov;
        // zx_20260906_1 1b: 内容门结论先落库——供后置验收消费；拒收路径(insufficient)下次 finalize 也能复用，不重付校验 LLM
        db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctxJson), taskId);
        if (insufficient.length > 0) {
          return JSON.stringify({ error: `finalize 内容充分性门禁未通过：产出文件 ${insufficient.join('、')} 已生成但内容校验不充分。${formatInsufficiencyReasons(insuffReasons)}请按上述原因补全后再 finalize；若确需收口请在任务管理执行"标记完成"。`, insufficientOutputs: insufficient, insufficientReasons: insuffReasons });
        }
        if (unverified.length > 0) {
          checks.push(`[INFO] 内容充分性未核 ${unverified.length} 个（辅助模型 ${Math.round(LLM_VALIDATION_TIMEOUT_MS / 1000)}s 内无结论/不可用）：${unverified.join('、')}——不阻断收口，可人工复核`);
        }
      } catch { /* 校验失败不阻断 finalize（回退到存在性门禁） */ }
    }
    // zx_20260928 M2: 此处原有「自评分 <60 → **拒绝** finalize」的一道闸，**已删**。
    //   病根是"同一件事两把尺"：拒绝闸（本处）与暂停闸（本函数末尾）问的是同一个问句"分够不够 60"，
    //   却一处**拒**（把决定权交回给 agent，agent 可以反复重试、也可以改口 self-report 蒙过去）、
    //   一处**停**（把决定权交给人工）。删掉后本路只留暂停闸——与 run_close 同尺（低分即置 paused 待人工），
    //   且**更严**（停 vs 拒）。保护未减：删除前已核实全仓无任何断言钉该错误文案。
    try {
      const failedPend = failedChildren(db, taskId);
      if (failedPend.length > 0) {
        return JSON.stringify({ error: `finalize 被拦：有 ${failedPend.length} 个子任务失败未处置（${childNames(failedPend)}）。须先重试至完成；确属失败的用 update_task_status 置为 archived（带 reason）＝放弃，父任务即可继续收口；确需人工收口请在任务管理"标记完成"。` });
      }
      const pend = db.prepare("SELECT id, title FROM wa_tasks WHERE parent_task_id = ? AND status NOT IN ('completed','failed','archived')").all(taskId) as Array<{ id: string; title: string }>;
      if (pend.length > 0) {
        return JSON.stringify({ error: `finalize 被拦：仍有 ${pend.length} 个子任务未完成（${pend.map((p) => p.title.slice(0, 16)).join('、')}）。编排父任务须等子全部完成后才可 finalize；确需收口请在任务管理"标记完成"。` });
      }
    } catch { /* 子检查 best-effort */ }
  } else {
    // zx_20260923 M7-b（G14）: 上面整段被 `forcedByBudget` 短路。`missOutputs` 那一路**本就有留痕**
    //  （`[WARN]` + `deliverable_unfulfilled.forced`，两条用户可见，不是缺口）；缺的是这一段——
    //  内容充分性闸与质量门**整段跳过且不留任何痕**，于是"完成了、内容却从未校验"在账面上看不出来
    //  （`:691` 的 `paused_partial` 要求 `partial || finScore<60`，高分时不触发）。
    //  ⚠ 只如实报"没做什么"，**不改判据**：`prematureEnd × score` 的耦合是**合理的**——被迫结束
    //  但产出已足是合法情形，一并拦下等于"预算紧 ⇒ 不许完成"，与 `a290ae2b` 那条死锁同形。
    checks.push('[WARN] 预算强制收尾放行：产出内容充分性校验未执行（内容门与质量门一并跳过）——本次完成未经内容门禁核实，需人工复核');
  }
  // 检查5' 验收标准核对（慎终如始——LLM 逐条判断，未达标拦截）。zx_20260906_1 1b: 由"内容门之前"后置到内容充分性门/质量门/子任务门之后——
  // 验收消费刚写入并落库的 output_validations（内容充分才做验收；内容/质量/子任务任一不过则不再白耗一次验收 LLM）
  const acceptanceCriteria = readTaskAcceptanceCriteria(db, taskId);
  if (acceptanceCriteria.trim()) {
    const { outcome: accOutcome, block: acceptanceBlock, payload: accPayload } = await checkAcceptanceCriteria(ctx, db, taskId, acceptanceCriteria);
    if (acceptanceBlock) return acceptanceBlock;
    // zx_20260910_3 M1: 只有"真核验通过"才记 [PASS]；没核验的如实记 [WARN]（此前一律 [PASS]＝冒名）
    if (accOutcome.ran && accOutcome.passed) {
      checks.push('[PASS] 验收标准已核对达成');
    } else if (!accOutcome.ran) {
      // zx_20261015_2 D6（罗尔斯·同一把尺）：checks 面（本轮）与账账面（保留的旧结论）须**互相交代**。
      //   本轮没判成而账上仍留着上一轮 `verified:true` 的结论时（`maySupersedeLedger`：非结论不得抹掉
      //   结论），此前两句话并列而不相认——人读详情页看到自相矛盾（真库标本 `7c39678e`：
      //   `[WARN] 验收未核验（模型未输出可解析的核对结论）` 与账上 5/10 已核验同处一页）。
      //   `accPayload` 即 `checkAcceptanceCriteria` 回传的**账上生效那一笔**（同一次读，不另查库）。
      const reasonLabel = UNVERIFIED_REASON_LABEL[accOutcome.reason];
      if (isAcceptanceVerified(accPayload)) {
        const passedTotal = Number(accPayload.passed_total) || 0;
        const criteriaTotal = Number(accPayload.criteria_total) || 0;
        checks.push(`[WARN] 本轮未取得核对结论（${reasonLabel}）；账上保留此前一次已核验结论（${passedTotal}/${criteriaTotal} 已达成，${acceptanceVerdictOf(accPayload)}）——两者并非同一轮，已如实并列，不阻断收口`);
      } else {
        checks.push(`[WARN] 验收未核验（${reasonLabel}）——已如实记账，不阻断收口`);
      }
    } else {
      checks.push('[WARN] 验收未核验（未通过）——已如实记账，不阻断收口');
    }
    // zx_20260907 M1(A2): 验收通过 + doc 产出 → 沉淀「可复用成功配方」(exemplar·reusable) 供相似任务最少token复用(毛选:实践→经验→再实践)
    // zx_20260910_3 M1(名实相符): 加闸——配方正文自称"已完成并通过验收"，故只有**真核验通过**才可沉淀；
    //   没核验/没通过却落"已验证配方"，是把冒名从 checks 转嫁到记忆（头重脚轻的又一形态）。
    if (accOutcome.ran && accOutcome.passed) try {
      const cfgA2 = db.prepare("SELECT value FROM wa_settings WHERE key = 'memory.outcome_exemplar'").get() as { value: string } | undefined;
      if (boolSetting(cfgA2?.value) && ctx.memory) {
        // zx_20260907 M3: A2 死路修正——promote 到 completed 在 finalize 成功后(3427)才发生，此刻同 run 的 doc 仍是 draft，
        // 故纳入 draft(该任务收尾即 promote)；否则刚写 doc 的任务永远落不成 exemplar(复核实证)
        const docs = db.prepare("SELECT file_path FROM wa_deliverables WHERE task_id = ? AND type = 'doc' AND status IN ('draft','registered','completed')").all(taskId) as Array<{ file_path: string | null }>;
        if (docs.length > 0) {
          const tA2 = db.prepare('SELECT title FROM wa_tasks WHERE id = ?').get(taskId) as { title: string } | undefined;
          const titleA2 = tA2?.title || '任务';
          const paths = docs.map(d => (d.file_path || '').split(/[\\/]/).pop() || '').slice(0, 3).join('、');
          // A1a (2026-09-08): 空泛元句 → 成果级「已验证配方」——注入真实 doc 正文摘录 + 验收逐条 + 内容校验结论。
          // (毛选:从实践中来/王阳明:知行合一收口——上轮 A2 0行且无真实产物证据=知而未行;维特根斯坦:给相似任务可判定的成功样板，省试错 token)
          let acc = { criteria_total: 0, passed_total: 0, checked_at: '', passed: [] as string[] };
          let ovSufficient = false;
          try {
            const tctxRec = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}') as { acceptance_check?: typeof acc; output_validations?: Array<{ sufficient?: boolean }> };
            if (tctxRec.acceptance_check?.checked_at) acc = { criteria_total: Number(tctxRec.acceptance_check.criteria_total) || 0, passed_total: Number(tctxRec.acceptance_check.passed_total) || 0, checked_at: tctxRec.acceptance_check.checked_at, passed: Array.isArray(tctxRec.acceptance_check.passed) ? tctxRec.acceptance_check.passed : [] };
            const ovRec = Array.isArray(tctxRec.output_validations) ? tctxRec.output_validations : [];
            ovSufficient = ovRec.length > 0 && ovRec.every((v) => v.sufficient !== false);
          } catch { /* 收口数据读取失败则降级为标题+路径 */ }
          let gist = '';
          try {
            const vr = db.prepare(`SELECT content_snapshot FROM wa_deliverable_versions WHERE deliverable_id IN (SELECT id FROM wa_deliverables WHERE task_id = ? AND type = 'doc') ORDER BY created_at DESC, version DESC LIMIT 1`).get(taskId) as { content_snapshot?: string } | undefined;
            if (vr?.content_snapshot) gist = String(vr.content_snapshot).replace(/\s+/g, ' ').trim().slice(0, 160);
          } catch { /* 快照读取失败 */ }
          if (!gist) {
            for (const d of docs.slice(0, 2)) {
              // zx_20260916_2 M2: 去 `existsSync` 直读——读不到(含不存在)一律走同一 `catch`，与旧行为同尺
              try { if (d.file_path) { gist = (await fsp.readFile(d.file_path, 'utf-8')).replace(/\s+/g, ' ').trim().slice(0, 160); if (gist) break; } } catch { /* 读盘失败跳过 */ }
            }
          }
          const accN = Number(acc.criteria_total) || 0;
          const passedN = Number(acc.passed_total) || 0;
          const passedLine = accN > 0 ? `（验收 ${passedN}/${accN} 通过${acc.passed.length > 0 ? ` · ${acc.passed.slice(0, 2).map(s => s.slice(0, 30)).join('；')}` : ''}）` : '';
          // A1 (2026-09-08_1 少则得·知止): 同任务已有一条 verified receipt(同 docPaths 重叠)则归并更新而非新增——
          // 此前每次 clean 重跑都新增近似配方(实库同任务 3 条)→ §3 重复注入同款, 多则惑(道德经:损之又损;维特根斯坦:同一事态一条可判定样板)。
          const cfgDedup = db.prepare("SELECT value FROM wa_settings WHERE key = 'memory.receipt_dedup'").get() as { value?: string } | undefined;
          const dedupOn = boolSetting(cfgDedup?.value);
          let existingId: string | null = null;
          if (dedupOn) {
            try {
              const curNames = paths.split('、').filter(Boolean);
              // zx_20260930 M8: 归并目标**不得是墓碑**——墓碑保留 `is_exemplar`，不加这一句则
              //   命中墓碑后第 599 行会把新正文**写回已删的那一行**（墓碑原地复活，
              //   且因 `memory_type` 仍是 'deleted'，任何读取点的过滤都不会察觉）。
              const sameRows = db.prepare(`SELECT id, context_json FROM wa_memories WHERE task_id = ? AND source = 'outcome_exemplar' AND is_exemplar = 1 AND exemplar_type = 'good' AND ${MEM_LIVE_SQL}`).all(taskId) as Array<{ id: string; context_json?: string }>;
              for (const r of sameRows) {
                try {
                  const cj = JSON.parse(r.context_json || '{}') as { receipt?: { docPaths?: string } };
                  const oldNames = String(cj.receipt?.docPaths || '').split('、').filter(Boolean);
                  if (curNames.some((c) => oldNames.some((o) => c.includes(o) || o.includes(c)))) { existingId = r.id; break; }
                } catch { /* 单条解析失败跳过 */ }
              }
            } catch { /* 去重判定失败回退新增 */ }
          }
          const content = `[已验证成果配方]「${titleA2}」已完成并通过验收${passedLine}，产出：${paths}。\n产出摘录：${gist || '（无正文摘录）'}\n内容校验：${ovSufficient ? '充分' : '—'}。复用时照此配方与产出结构执行，减少试错省token。`;
          if (existingId) {
            // 归并更新：content 以最新 doc 摘/最新验收刷新、importance 抬、receipt 溯源刷新（保留既有 applied/encoding/reusable 键）
            try {
              const mRow0 = db.prepare('SELECT context_json FROM wa_memories WHERE id = ?').get(existingId) as { context_json?: string } | undefined;
              const mCtx0 = JSON.parse(mRow0?.context_json || '{}') as Record<string, unknown>;
              mCtx0.receipt = { taskId, docPaths: paths, acceptance: accN > 0 ? { criteria_total: accN, passed_total: passedN, checked_at: acc.checked_at || null } : null, has_gist: !!gist, sufficiency: ovSufficient };
              db.prepare("UPDATE wa_memories SET content = ?, importance = MAX(importance, 0.85), context_json = ?, updated_at = datetime('now') WHERE id = ?").run(content, JSON.stringify(mCtx0), existingId);
            } catch { /* 归并 best-effort */ }
          } else {
            const memId = ctx.memory.storeText({
              project_id: projectId, task_id: taskId, content,
              type: 'semantic', source: 'outcome_exemplar', reasoning: 'zx_20260908_1 A1a 验收通过→已验证成果配方', valence: 'positive', reusableExperience: true,
            });
            db.prepare('UPDATE wa_memories SET importance = MAX(importance, 0.85) WHERE id = ?').run(memId);
            ctx.memory.markExemplar(memId, 'good', { archetype: 'outcome_success' });
            // 溯源 receipt 元数据并入 context_json（不覆盖 reusable_experience/importance 既有字段）
            try {
              const mRow = db.prepare('SELECT context_json FROM wa_memories WHERE id = ?').get(memId) as { context_json?: string } | undefined;
              const mCtx = JSON.parse(mRow?.context_json || '{}') as Record<string, unknown>;
              mCtx.receipt = { taskId, docPaths: paths, acceptance: accN > 0 ? { criteria_total: accN, passed_total: passedN, checked_at: acc.checked_at || null } : null, has_gist: !!gist, sufficiency: ovSufficient };
              db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?').run(JSON.stringify(mCtx), memId);
            } catch { /* 元数据 best-effort */ }
          }
        }
      }
    } catch { /* 沉淀 best-effort */ }
  } else {
    // zx_20260915 P0-2(a)（空性·如实）: 没标准也**必须落一笔账**——此前这里什么都不做，
    //   于是"从未验收"与"验收通过"在库里、在界面上长得一模一样。`verified:false` 保证
    //   下游（`isAcceptanceVerified` 唯一判据）绝不据此打 ✓。
    // zx_20260916 M1: 记的是哪一种"无人许诺"必须**如实分说**——
    //   `engine_proposed` 是"引擎代拟了 N 条并逐条自核"，报成 `no_criteria` 就等于把已有的核对工作
    //   一笔勾销、又退回 zx_20260915 之前那种"什么都看不出来"的形态（本仓 G2 病根：一处真源、多处读点）。
    const { payload: accPayload } = await checkAcceptanceCriteria(ctx, db, taskId, acceptanceCriteria);
    if (criteriaSourceOf(accPayload) === 'engine_proposed') {
      const total = accPayload.proposed?.length ?? 0;
      const hit = (accPayload.proposed_checked ?? []).filter((c) => c.passed).length;
      checks.push(`[INFO] ${UNVERIFIED_REASON_LABEL.no_user_criteria}——引擎代拟 ${total} 条、逐条自核达成 ${hit} 条，**未验收**，不阻断收口`);
      // zx_20261022_1 批四（念了必须有人应）：只报总数，未达成的那几条就没人知道**差在哪**。
      //   真库标本：收口印「代拟 3 条、达成 0 条」，而三条判据与各自原因一条也没写出。
      //   逐条列出（上限 3 条，其余以计数收口）；不阻断、不改终态，只让账可读。
      const missWarning = proposedMissWarning(accPayload.proposed_checked, total);
      if (missWarning) checks.push(missWarning);
    } else {
      checks.push(`[INFO] ${UNVERIFIED_REASON_LABEL.no_criteria}（未验收）——已如实记账，不阻断收口`);
    }
  }
  // zx_20261018_3 D10（实机 E2E 组6 照出）: 完成分**必须消费本轮验收结论**。此前这一段排在验收核对
  //   **之前**，`completionCapFloors` 读到的是账上**上一轮**的验收账 ⇒ 首次验收失败后，agent 改好产出、
  //   第二次验收已 3/3 通过，完成分仍被旧的 `failed` 压到 45，最终同屏出现「验收 3/3 通过」+
  //   「45 分、验收未通过压降、已暂停」两种互相否认的口径（标本 `660fd8e3` / `08497ee3`）。
  //   故整段后移到验收之后、收口写库之前；验收失败路径已在上方 `return`，不产生陈旧分。
  //   分**怎么来的**如实写进 `feedback`：本路按收口方自评记账，**不跑**引擎六维评估——自评分不得冒充引擎分。
  const declaredScore = args.quality === 'excellent' ? 95 : args.quality === 'good' ? 80 : args.quality === 'acceptable' ? 60 : args.quality === 'partial' ? 40 : 70;
  const caps = completionCapFloors(db, {
    taskId,
    workingDir,
    archetype: typeof ctxJson.archetype === 'string' ? ctxJson.archetype : undefined,
    hasDeliverables: (db.prepare('SELECT COUNT(*) AS c FROM wa_deliverables WHERE task_id = ?').get(taskId) as { c: number }).c > 0,
  });
  const scoreWithCap = Math.min(declaredScore, caps.cap);
  const finGoalAchieved = goalAchievedOf(
    !!(ctxJson.task_goal as { goal?: string } | undefined)?.goal,
    ctxJson.goal_deviation_restarts,
    scoreWithCap,
  );
  ctxJson.completion_quality = buildCompletionAccount({
    score: scoreWithCap,
    goalAchieved: finGoalAchieved,
    via: 'finalize_task',
    feedback: `收口方自评 ${args.quality ?? '未附'}（本路按自评分记账，未跑引擎六维评估）`
      + (scoreWithCap < declaredScore ? `；基线分 ${declaredScore} 经四道封顶记账为 ${scoreWithCap}${caps.registerNote}${caps.typeNote}` : ''),
  });
  ctxJson.goal_achieved = finGoalAchieved;
  // zx_20260915 P0-8(a)（毛选·抓而不紧等于不抓 / 念了必须有人应）: 收尾临时产出物**处置**。
  //   B3 自检（zx_20260904）此前只 `[WARN] 建议清理`——实测"每轮都说建议清理、每轮都没人清"
  //   （a-stock 工作树 11 个 `_*.py` 未跟踪），真库 41 个探针产出物未退休、涉 13 个任务。
  //   现改为**默认退休**（`status='retired'`，既有取值，无迁移）；`probe_disposition='keep'` + 理由则保留并如实入账。
  //   **不删任何文件**（不逆"不擅自删用户文件"这条既有边界）——zx_20260916 M2 起退休时**另把文件移入
  //   `data/quarantine/<taskId>/` 并回写 `file_path`（原注释"只改登记状态"因此已不成立，就地订正：
  //   当时实测的正是"登记说已退休、文件仍在被分析仓库根"）。边界仍是"不删"，只是退休第一次真的发生在文件上。
  // ⚠ 必须排在 autoAssignPrimary **之前**：否则被退休的探针仍在择主候选里（两处并非"天然咬合"，顺序是前提）。
  //   判据走 `selectProbeDeliverables`（= docNotProbe 一把尺）——原处自带正则副本已退役。
  try {
    if (readBoolSetting(db, 'deliverable.probe_disposition')) {
      const probes = selectProbeDeliverables(db, taskId);
      if (probes.length > 0) {
        const names = probes.map((r) => (r.file_path || '').split(/[\\/]/).pop() || '').filter(Boolean);
        const shown = names.slice(0, 5).join('、');
        if (args.probe_disposition === 'keep') {
          const reason = (args.probe_keep_reason || '').trim() || '未说明理由';
          checks.push(`[WARN] 保留 ${probes.length} 个临时产出物（${shown}）：${reason}`);
        } else {
          // zx_20260916 M2: 隔离根由**调用方**给出（deliverable-lifecycle 零 electron，不解析 dataDir）。
          const quarantineDir = path.join(ctx.dataDir, 'quarantine', taskId);
          const { retired, moved, alreadyGone, failed } = disposeProbeDeliverables(db, probes, 'retire', quarantineDir);
          checks.push(`[PASS] 已退休 ${retired} 个临时产出物（${shown}）——登记状态置 retired`);
          checks.push(`[INFO] 已隔离 ${moved} 个文件至 ${quarantineDir}${alreadyGone ? `（另 ${alreadyGone} 个源文件已不在，未动，亦不谎报已隔离）` : ''}`);
          // zx_20260916_3 M2: 与 run_close 路的告知**同形**——两条收口路对同一件事说同样的话（含"判据是什么"，
          //   否则用户看到"已退休 3 个"无从判断哪些文件被动了）。
          checks.push('[INFO] 判据为显式前缀 _tmp/_probe/_verify（含 `0_probe.md` 这类 1–2 位数字前缀）——未按此命名的文件一律视为真实产出、不动');
          if (failed.length > 0) {
            checks.push(`[WARN] 隔离失败 ${failed.length} 个（${failed.map((f) => `${f.name}: ${f.reason}`).join('；')}）——文件仍在原处，登记已退休`);
          }
        }
      }
    }
  } catch { /* 处置 best-effort */ }
  // B2 (2026-09-08_1 知行合一): finalize 收口时若该任务非 retired 产出尚无 primary, 自动把最新 doc 置 primary
  // (deliverable.primary_auto 开关; 人工可在产出物页撤换——撤后不再自动覆盖, 化解 primary 实库 0 标注/交付单★段空)
  // zx_20260911_2 M4-G2: 逻辑抽为 deliverable-lifecycle.autoAssignPrimary 单一实现——update_task_status 完成出口同一处调用。
  // zx_20260910_3 M1(名实相符·注释订正): 原注释写"finalize 验收全过 →"，但本块**从不读验收结果**——
  //   无验收标准的任务同样需要主要成果，加验收闸反而是错的。此处只订正注释，不改行为。
  autoAssignPrimary(db, taskId);
  // zx_20261027_1 M4（道德经·知不知，上）: "只读到一部分"必须在收口账上说出来。
  //   此前 `read_file` 把 `paginateReadFile` 的 `truncated` 丢弃，只记"读过"——核验类任务
  //   读了前 50k 字没看到，与"整个文件里没有"在账上长得一模一样。此处只**如实报**，不阻断收口。
  try {
    const truncated = [...(truncatedReads ?? [])];
    if (truncated.length > 0) {
      const tro = db.prepare('SELECT title, description FROM wa_tasks WHERE id = ?').get(taskId) as { title?: string; description?: string } | undefined;
      const shown = truncated.slice(0, 3).map((p) => p.split(/[\\/]/).pop() || p).join('、');
      const more = truncated.length > 3 ? `等 ${truncated.length} 个` : '';
      const tail = isVerificationTask(`${tro?.title || ''} ${tro?.description || ''}`)
        ? '本任务为核验类——据此判定"未发现/无问题"前须读完或明确声明核验范围。'
        : '若要据此下结论，请补读（read_file 续读 offset）。';
      checks.push(`[WARN] 本次有 ${truncated.length} 个文件只读取了部分内容（${shown}${more}）——"没读到"不等于"不存在"。${tail}`);
    }
  } catch { /* 如实性提示 best-effort，不阻断收口 */ }
  ctxJson.finalize_checks = checks;
  // B1 回写 (2026-09-03_1): 实施任务带 scheme_ref → 完成时回写对应方案里程碑 done + 落地任务 id
  // zx_20260907: 补自动联动——scheme_ref 无生产者时回退按标题 M 前缀(父方案优先/同项目唯一)解析，新建"方案实施任务"finalize 即自动 done
  // zx_20260909 续跑(规划→独立实施): scheme_ref 仅带 plan_task_id(实施锚父关联方案, 子任务继承)时, 里程碑按标题 M{n} 派生——
  //   显式关联优先, 不受同项目多方案"唯一 M"歧义影响(跨父/平级实施任务亦可靠); 自动置位后补发 project.milestone_changed(交付单即时刷新)
  // zx_20260910_2 M1: 逻辑迁入 core/task-accounting.ts writeMilestoneDone——与 update_task_status 共用同一份
  //   真实现（此前本处与 update_task_status 各写一份，后者干脆不做 ⇒ 子任务完成而里程碑恒 pending）。
  writeMilestoneDone(db, taskId, ctxJson, (e) => { eventBus.emit('project.milestone_changed', e).catch(() => {}); });
  // zx_20260911_3 M5(管子·度量衡): 上限截断后「剩余 M」补归口——板上无卡且父自述范围内的 M{n} 归父自身。
  //   create_task 广度上限 5（D3 不放宽）而板可能有 7 行 ⇒ M5/M6 无卡、父子双双无处归口（E6）。
  //   仅在**编排父**（有子任务）且能定板时生效；父未声明过的 M 一律保持 pending（不冒名）。
  backfillBoardRemainderToSelf(db, taskId, ctxJson, (e) => { eventBus.emit('project.milestone_changed', e).catch(() => {}); });
  // M12 (2026-09-08 实机复核): acceptance_check 由 checkAcceptanceCriteria 走 persistAcceptanceCheck
  // (core/acceptance-check.ts) 独立读改写落库，
  // 而本地 ctxJson(起始读取于验收前)不含它——直接覆盖会把验收证据清掉 → UI 无验收徽标/验收面板空(实机证实, A1a 配方却已落含"3/3")。
  // 收口前把 DB 已落的外部分支键合并回 ctxJson，防丢验收。
  // zx_20260910_3 M1: 四出口皆落账后，本合并对"未核验"载荷同样必需（否则 [WARN] 那一笔也会被覆盖掉）。
  try {
    const curCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined)?.context_json || '{}') as { acceptance_check?: unknown };
    if (curCtx.acceptance_check) (ctxJson as Record<string, unknown>).acceptance_check = curCtx.acceptance_check;
  } catch { /* 合并 best-effort */ }
  db.prepare('UPDATE wa_tasks SET context_json = ?, updated_at = datetime(\'now\') WHERE id = ?').run(JSON.stringify(ctxJson), taskId);
  syncQualityColumn(db, taskId);
  // zx_20260904_7 硬映射② (2026-09-04): 张力 speed-vs-quality ≥70 → finalize 前须有产出物或代码/测试编辑（质量优先硬门禁；预算强制收尾跳过）
  try {
    const tq = getTensions(db, projectId)['speed-vs-quality']?.position ?? 50;
    if (tq >= 70 && !forcedByBudget) {
      const dl = (db.prepare('SELECT COUNT(*) AS c FROM wa_deliverables WHERE task_id = ?').get(taskId) as { c: number }).c;
      const codeEdit = (db.prepare("SELECT COUNT(*) AS c FROM wa_task_conversations WHERE task_id = ? AND role = 'tool' AND (content LIKE '%write_file%' OR content LIKE '%edit_file%')").get(taskId) as { c: number }).c;
      if (dl === 0 && codeEdit === 0) {
        return JSON.stringify({ error: `finalize 被拦（质量优先·张力 speed-vs-quality≥70）：尚无产出物或代码/测试编辑记录。请先 write_file 落产出（代码任务含测试）后再 finalize。`, qualityGate: 'tension-speed-vs-quality' });
      }
    }
  } catch { /* 质量门失败不阻断 */ }
  // zx_20260904_6 D1 (2026-09-04): 自评 partial（预算强制收尾场景）不 finalize 为 completed → 置 paused 待人工
  // zx_20260922_1 M6（F8）: 复用本函数已算好的 `forcedByBudget`——同一问句在本文件内**只算一次**。
  const finScore = (ctxJson.completion_quality as { score?: number })?.score ?? 70;
  // zx_20260928 M2（「完成出口同一把尺」）: 条件由 `(partial || finScore<60) && forcedByBudget` 放宽为
  //   **`finScore < 60`**——低分不再区分"是不是预算逼的"，一律走**同一处**暂停口。刻意**不新增暂停调用点**
  //   （`rr_zx_20260909_1_b1` 的 `engineSrc()` 台账按「暂停入口 + 显式告知键」钉着调用点总数，扫描面含本文件：
  //   `core/tools/*.ts` 也在 `engineSrc()` 内）——故此处只**放宽既有那条的触发条件**，不改调用点个数。
  //   ⚠ 本条注释本身也不得逐字写出那对扫描模式（`engineSrc()` **不去注释**，写了即被判为第 14 处调用点）。
  //   与上一步删除的「自评分 <60 → 拒绝」是同一条病根的两半：同一个问句（分够不够 60）一处拒、一处停，
  //   就是"完成"在不同出口上不是一个判据。删拒留停后，本路的低分处置与 run_close **同尺**（置 paused 待人工）。
  //   `forcedByBudget` 从判定里**去掉**（不是加严）：故"预算紧 ⇒ 不许完成"（`a290ae2b` 那条死锁的形状）不成立。
  if (finScore < 60) {
    const capNotes = `${caps.registerNote}${caps.typeNote}`.trim();
    // 强制支的 `note` **逐字保留**原串（`rr_zx_20260909_1_b1.ts` 逐字钉着它，是"partial 悬置须告知创建人"的凭据）
    const finNote = forcedByBudget
      ? '预算强制收尾且自评未达交付（partial/低分），已置暂停待人工核验产出'
      : `完成分 ${finScore}（<60）未达交付标准——收口方自评 ${args.quality ?? '未附'}${capNotes ? `，受封顶压降：${capNotes}` : ''}，已置暂停待人工核验产出`;
    // zx_20260909_1 补③(§十三): partial 悬置属"需人工介入"暂停 → 通知创建人(§八.3 承诺"partial 悬置都推")；
    //   门控 im.notify_pause_needed + 每任务每次至多一条由 markPauseNeeded 内部承担（`note` 即该告知）；
    //   用户主动暂停不经此分支
    pauseTask(db, { taskId, reason: PAUSE_REASON_QUALITY_BELOW_BAR, note: finNote });
    try {
      db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))").run(crypto.randomUUID(), taskId, forcedByBudget
        ? `[未达交付·partial] 预算强制收尾时自评 ${args.quality}（${finScore} 分<60），任务已暂停待人工：请核验产出（测试/提交）后决定"恢复继续"或"标记完成"。`
        : `[未达交付] 完成分 ${finScore}（<60）未达交付标准${capNotes ? `（受封顶压降：${capNotes}）` : ''}，任务已暂停待人工：请核验产出后决定"恢复继续"或"标记完成"。`);
    } catch { /* ignore */ }
    return JSON.stringify({ status: 'paused_partial', summary: args.summary, quality: args.quality, checks });
  }
  return JSON.stringify({ status: 'finalized', summary: args.summary, quality: args.quality || 'good', checks });
}
