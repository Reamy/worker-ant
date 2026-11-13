/**
 * 验收判卷 —— 从 `agent-executor.ts` 原样搬出（zx_20261109_1 B6，R-75a 执行体行数闸）。
 * 行为零变化；执行体保留同名再导出，旧调用点与受控回归脚本不裂。
 */
import type Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isPlanOrImplTask } from "./task-accounting.js";
import { deliverableScopeSql, docNotProbe, markTaskVerifiedVia } from "./deliverable-lifecycle.js";
import { proposeAcceptanceCriteria, recordProposedCheck, recordAcceptanceOutcome, decideAcceptanceOutcome, parseAcceptanceChecks, enforceEvidenceBoundChecks, splitCriteriaLines, summarizeAcceptanceFailures, type AcceptanceOutcome, type AcceptanceCheckPayload, type ProposedCriteria } from "./acceptance-check.js";
import { addSideTokens, usageTokensOf, logger, type AgentContext } from "./agent-executor.js";
import { collectEvidence, renderEvidence } from "./exec-evidence.js";
import { renderOwnedRepoEvidence } from "./task-file-ledger.js";
import { evidenceIdOf } from "./runtime-evidence.js";
import { createSafeProvider } from "./ai-provider.js";
import { auxModelRequest } from "./model-request.js";
import { criteriaPathRefs, collectPathBases, resolveCriteriaPaths } from "./acceptance-paths.js";
import { loadStoredSnapshot } from "./world-snapshot.js";
import { loadProjectBrief, renderProjectBriefForJudge } from "./project-brief.js";
import { recordPitfallCandidate } from "./knowledge-cards.js";

/**
 * Phase A (2026-08-26) 慎终如始：LLM 逐条核对验收标准。
 *
 * zx_20260910_3 M1（维特根斯坦·意义即用法／道德经·七十一章「知不知，上」）：
 * 返回**可判定的结局**而非同一个 `null`——无模型／未吐 JSON／异常／真通过四种结局分列，
 * 且**四个出口都落 ctxJson.acceptance_check**（带 verified 标记）。
 * 此前四种结局共用一个无名 `null`、且只有"真通过"才落库 ⇒ 真库 `acceptance_check` 写入数 0、
 * 而调用方一律记 `[PASS]`（冒名）。**不阻断语义不变**：只有"真拒收"才返回拦截串。
 */
/**
 * 规划/实施类任务、且任务上没有用户许诺的判据 ⇒ 从**任务自身**代拟可机检判据（zx_20260916 M1）。
 * 非规划类、或一条依据都找不到 ⇒ 返回 `null` ⇒ 调用方回落 `no_criteria`（不得为凑数编判据）。
 *
 * 判据清单取**已滤探针**的产出物（`docNotProbe` —— 同一把唯一的尺，不在此复刻第二份探针正则）。
 * 只读、零副作用；导出供受控回归直跑真实现。
 */
export function proposeAcceptanceForTask(db: Database.Database, taskId: string): ProposedCriteria | null {
  try {
    const t = db.prepare('SELECT title, description FROM wa_tasks WHERE id = ?').get(taskId) as { title?: string; description?: string } | undefined;
    if (!t) return null;
    if (!isPlanOrImplTask(`${t.title ?? ''} ${t.description ?? ''}`)) return null;
    const deliverables = db.prepare(
      `SELECT name, type, status, file_path FROM wa_deliverables WHERE task_id = ? AND ${docNotProbe('')}`,
    ).all(taskId) as Array<{ name: string; type: string; status: string; file_path: string | null }>;
    // zx_20261022_1 批三：相对路径字面量按**本项目工作目录**解析（不再按进程 cwd、也不只剩在册行一条路）。
    //   读不到 working_dir ⇒ 不注入 ⇒ 代拟②照旧如实记"相对路径无法解析"，不猜。
    let workingDir = '';
    try {
      const p = db.prepare('SELECT working_dir FROM wa_projects WHERE id = (SELECT project_id FROM wa_tasks WHERE id = ?)')
        .get(taskId) as { working_dir?: string | null } | undefined;
      workingDir = String(p?.working_dir ?? '').trim();
    } catch { /* 读不到项目行 ⇒ 只少这一条解析基准，不阻断代拟 */ }
    const proposed = proposeAcceptanceCriteria({
      title: t.title, description: t.description, deliverables,
      pathExists: (p) => fs.existsSync(p),
      resolveRelative: workingDir ? (p) => (path.isAbsolute(p) ? p : path.join(workingDir, p)) : undefined,
    });
    return proposed.proposed.length > 0 ? proposed : null;
  } catch {
    return null; // 取数失败 ⇒ 回落 no_criteria（如实"无人许诺"，不编判据）
  }
}


/**
 * zx_20261110_2 B6：本任务**快照里的文件清单**（相对工作目录），供判据路径阶梯的最后一档。
 *
 * 快照条目形如 `"/src/a.ts:1234"`（`snapshotFromScan` 记的是 `path.replace(root,'') + ':' + size`），
 * 故先剥 `:size`、再跟工作目录拼成绝对路径——**不**假定它以什么分隔符起手。
 * 取"执行后"快照（本轮交付的落点）；没有就退回"执行前"（至少是一份真清单，不臆造）。
 * 任何读失败 ⇒ 空数组：这一档只是锦上添花，不该让判卷因它中断。
 */
function readSnapshotPaths(db: Database.Database, taskId: string, workingDir: string): string[] {
  try {
    const row = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string | null } | undefined;
    if (!row?.context_json) return [];
    let ctx: Record<string, unknown>;
    try { ctx = JSON.parse(row.context_json) as Record<string, unknown>; } catch { return []; }
    const snap = loadStoredSnapshot(db, ctx.world_snapshot_after) ?? loadStoredSnapshot(db, ctx.world_snapshot_before);
    const hashes = Array.isArray(snap?.fileHashes) ? (snap!.fileHashes as unknown[]) : [];
    const wd = String(workingDir ?? '').trim();
    const out: string[] = [];
    for (const h of hashes) {
      if (typeof h !== 'string' || !h) continue;
      const c = h.lastIndexOf(':');
      const rel = c > 0 ? h.slice(0, c) : h;
      if (!rel) continue;
      out.push(wd && !path.isAbsolute(rel) ? path.join(wd, rel) : rel);
      if (out.length >= 5000) break; // 有界：判据引用通常个位数，清单只需够匹配
    }
    return out;
  } catch {
    return [];
  }
}

export async function checkAcceptanceCriteria(
  ctx: AgentContext,
  db: Database.Database,
  taskId: string,
  criteria: string,
): Promise<{ outcome: AcceptanceOutcome; block: string | null; payload: AcceptanceCheckPayload }> {
  // zx_20260915 P0-2(a)（维特根斯坦·意义即用法）: 「没设验收标准」也是一种**可判定结局**——
  //   此前调用方用 `if (criteria.trim())` 直接跳过，于是"没标准"与"验收通过"在库里同名（都无痕）。
  //   现进入即落一笔 `reason:'no_criteria'`，且 `verified:false` ⇒ `isAcceptanceVerified` 必返回 false
  //   （核心不变量：**没标准 ≠ 通过**）。不调 LLM、不耗 token。
  if (!criteria.trim()) {
    // zx_20260916 M1（维特根斯坦·家族相似 / 道德经·七十一章「知不知，上」）：「无人许诺」有两种——
    //   「无人许诺、也无从代拟」与「无人许诺、但引擎已代拟并逐条自核」，两者**不得混名**。
    //   规划类任务本职即产出方案，"方案写入指定路径"这类判据客观存在且可机检，缺的只是"有人写下来"。
    //   ⚠ 同时**仍不是"验过"**：引擎拟题 + 引擎判卷 = 自证 ⇒ 载荷 `verified:false`，下游绝不打 ✓。
    const proposed = proposeAcceptanceForTask(db, taskId);
    if (proposed) {
      const payload = recordProposedCheck(db, taskId, proposed);
      return { outcome: { ran: false, reason: 'no_user_criteria' }, block: null, payload };
    }
    const decided = { outcome: { ran: false, reason: 'no_criteria' } as AcceptanceOutcome, checks: [] as [] };
    const payload = recordAcceptanceOutcome(db, taskId, decided);
    return { outcome: decided.outcome, block: null, payload };
  }
  // ── zx_20261109_1 G11（判据路径可核性）：判卷前先做一次**确定性**核验 ──
  //   判据里点名的相对路径若在仓库里不存在，这条题指着的东西就不存在，判卷模型再怎么读证据也无从通过
  //   （真库标本 `b8310097`：判据写 `institution.wxml`/`institution.js`，仓库里只有 `institution.vue`，
  //   模型按"框架通常如此"照样判过）。只认带目录 + 已知扩展名的相对引用（`acceptance-paths.ts` 内的边界）；
  //   基底枚举不完整/读盘失败一律 fail-open——宁可漏拦，不可把合法判据判成不可核（本判定会直接置 paused）。
  let projectHintBlock = '';
  /**
   * zx_20261110_2 B6：**非 own** 的判据路径解析账（跨任务/快照）。四处结局都随载荷走——
   * 结论要说清，`resolved_as`/`resolved_from` 也要留得下（事故 `68c0a607` 教训：只记"缺了什么"，
   * 就永远看不出"其实在父任务名下"）。
   */
  let pathResolved: Array<{ ref: string; resolved_as: string; resolved_from: string }> = [];
  try {
    const prow = db.prepare(
      `SELECT p.id AS project_id, p.working_dir AS working_dir
         FROM wa_tasks t LEFT JOIN wa_projects p ON p.id = t.project_id
        WHERE t.id = ?`,
    ).get(taskId) as { project_id?: string | null; working_dir?: string | null } | undefined;
    const workingDir = String(prow?.working_dir ?? '').trim();
    const projectId = String(prow?.project_id ?? '');
    const refs = criteriaPathRefs(criteria);
    if (workingDir && refs.length > 0) {
      const { bases, truncated } = collectPathBases(workingDir);
      const exists = (abs: string): boolean => { try { return fs.existsSync(abs); } catch { return false; } };
      // 「算不算一条成果」只有 `deliverableScopeSql` 一处说了算（rr_zx_20260930 D-b-3 的常驻不变式）：
      //   这里不得自己拼 `status != 'retired' AND (type != 'doc' OR docNotProbe…)`——手拼一份就是第二块尺。
      const ownScope = deliverableScopeSql({ taskIds: [taskId] });
      const ownRows = db.prepare(
        `SELECT task_id, file_path FROM wa_deliverables WHERE ${ownScope.sql} AND file_path IS NOT NULL`,
      ).all(...ownScope.params) as Array<{ task_id: string; file_path: string }>;
      // 同项目其他任务（父/兄弟）的登记——本轮的**主要增量**：工程级查重会把行留在别的任务名下，
      //   只认"本任务 + 工作目录"就会把真存在的文件判成"路径不存在"。
      const projScope = deliverableScopeSql({ projectId, alias: 'd' });
      const projectRows = projectId ? db.prepare(
        `SELECT d.task_id AS task_id, d.file_path AS file_path FROM wa_deliverables d
           JOIN wa_tasks t ON t.id = d.task_id
          WHERE ${projScope.sql} AND d.task_id != ? AND d.file_path IS NOT NULL`,
      ).all(...projScope.params, taskId) as Array<{ task_id: string; file_path: string }> : [];
      const resolved = resolveCriteriaPaths({
        refs,
        ownDeliverables: ownRows.map((r) => ({ taskId: r.task_id, path: r.file_path })),
        projectDeliverables: projectRows.map((r) => ({ taskId: r.task_id, path: r.file_path })),
        bases,
        basesTruncated: truncated,
        snapshotPaths: readSnapshotPaths(db, taskId, workingDir),
        exists,
      });
      pathResolved = resolved.results
        .filter((r) => r.resolved && r.resolved_as && r.resolved_from && r.resolved_from !== 'own')
        .map((r) => ({ ref: r.ref, resolved_as: r.resolved_as!, resolved_from: r.resolved_from! }));
      // 基底枚举不全 ⇒ 不判缺（既有 fail-open 语义不变）；多命中的结论同样不作数。
      const missing = truncated ? [] : resolved.missing;
      const ambiguous = truncated ? [] : resolved.ambiguous;
      if (pathResolved.length > 0) {
        // "进会话"：判据点名的文件不在本任务名下、却真存在——这是本轮最该被看见的一笔事实。
        const cross = pathResolved.filter((r) => r.resolved_from.startsWith('project_deliverable:'));
        if (cross.length > 0) {
          try {
            db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
              .run(crypto.randomUUID(), taskId, `[判据路径] ${cross.length} 条判据引用的文件不在本任务名下，已按同项目其他任务登记的产出物解析：${cross.map((c) => `${c.ref} ← ${c.resolved_from.replace('project_deliverable:', '').slice(0, 8)}`).join('；')}`);
          } catch { /* 留痕失败不阻断判卷 */ }
        }
        logger.info({ taskId: taskId.slice(0, 8), resolved: pathResolved.slice(0, 5), resolvedCount: pathResolved.length },
          '判据路径经非本任务来源解析（own 之外）');
      }
      if (missing.length > 0) {
        const decided = { outcome: { ran: false, reason: 'criteria_path_missing' } as AcceptanceOutcome, checks: [] as [] };
        const payload = recordAcceptanceOutcome(db, taskId, decided, {
          criteriaPathMissing: missing, ambiguousPaths: ambiguous, criteriaPathResolved: pathResolved,
        });
        logger.warn({
          taskId: taskId.slice(0, 8), missing: missing.slice(0, 5), missingCount: missing.length,
          ambiguousCount: ambiguous.length, resolvedCount: pathResolved.length,
        }, '判据引用的路径在仓库中不存在（阶梯走完仍无命中）——不计通过，按未核记账');
        return { outcome: decided.outcome, block: null, payload };
      }
    }
    // G10：有须知 → 判卷上下文（≤300 字）；无须知 ⇒ 空串（提示词逐字节不变）。
    //   zx_20261111_1：按**内容**判（`status` 是最近一次尝试的结局，失败重跑不丢旧须知）。
    if (prow?.project_id) {
      const stored = loadProjectBrief(db, prow.project_id);
      if (stored?.brief) projectHintBlock = renderProjectBriefForJudge(stored.brief);
    }
  } catch { /* 表缺失/读盘失败 ⇒ fail-open：照旧判卷，不因核验本身失败而阻断 */ }
  let kind: 'ok' | 'no_model' | 'exception' = 'ok';
  let text: string | null = null;
  /** 本任务运行证据的可引用集（元素 `run:<id>`）；取证失败为空集 ⇒ 运行类判据一律降级（fail-closed） */
  let evidenceIndex: ReadonlySet<string> = new Set();
  try {
    // zx_20260917 M4（§6.1/6.2）: 取数与渲染收口到 `collectEvidence`/`renderEvidence`——
    //   从前这里**自己**以 `task_id = 本任务` 为界问四处（`convs`/`deliverables`/`docFiles`/`validationSummary`），
    //   于是「父持方案、子干活」的子任务只能看见自己那点自述 ⇒ 盲判。
    //   两处改动：产出物两路改走**整棵树**；渲染仍是这一段（提示词形状逐字节不变）。
    const bundle = collectEvidence(db, taskId);
    evidenceIndex = new Set(bundle.runtimeEvidence.map(evidenceIdOf));
    const evidenceBase = renderEvidence(
      bundle,
      (p) => { try { return fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; } catch { return null; } },
    );
    // zx_20261022_3 批十二：DoD 里"编译通过 / 行数 / 未提交"这类条目要**执行面证据**——
    //   判卷器是纯文本 LLM，故由引擎只读跑 git（范围限本任务自有文件）后并入证据。
    let repoEvidence = '';
    try { repoEvidence = await renderOwnedRepoEvidence(db, taskId); } catch { /* 取证失败不改判卷输入 */ }
    const evidence = repoEvidence
      ? `${evidenceBase}\n\n【本任务自有文件的仓库状态（引擎只读执行，非模型自述）】\n${repoEvidence}`
      : evidenceBase;

    const ansClient = await ctx.getAnsClient();
    const m = await ansClient.getOptimalModel(auxModelRequest()) as Record<string, unknown>;
    if (!m?.url || !m?.api_key || !m?.model_name) {
      kind = 'no_model'; // 出口①：无可用模型（如实记，不冒名通过）
    } else {
      const { generateText } = await import('ai');
      const provider = createSafeProvider({ apiKey: m.api_key as string, baseURL: m.url as string });
      const result = await generateText({
        model: provider.chat(m.model_name as string),
        temperature: 0.1,
        maxTokens: (m.max_output_tokens as number | undefined) || 4096,
        // zx_20260910_3 M1b: 补超时——本函数此前**无** abortSignal（可无限挂起），而 checkGoalDeviation 有 15s。
        // 取 30s（对照压缩路径 :30s）：验收提示词含 4 份产出摘录 + 内容校验 + 5 条会话，体量大于 goal-deviation；
        // 截断过短会把"真通过"记成 error ＝另一种失实。超时→catch→如实落 verified:false/reason:'error'，不冒名。
        abortSignal: AbortSignal.timeout(30_000),
        // zx_20261021_4 批三（道德经·六十四章「慎终如始」）：**只按下列证据判卷**。此前判卷把任务树里
        //   同名旧版文档也读进来，遂对着已废止的方案判新交付（`f79b1abb` 假阴性）：旧地图判新路。
        // zx_20261105_1 M1（王阳明·知行合一）：每条判据须附 `evidence_refs`；运行类判据
        //   只有引用本任务账上的 `run:<id>` 才算数——没跑过的"重启不报错"不成立。
        prompt: `以下是工蚁系统一个任务的验收标准与已完成工作内容。请逐条判断验收标准是否已达成。\n\n验收标准：\n${criteria}\n\n已完成工作：\n${evidence || '（无产出记录）'}\n\n只按下所列文件与记录判卷；未列出的旧版本不是本轮交付，不得据其判定未达成。\n\n每条判据须附 evidence_refs（数组），元素取自证据串中的 run:<id>、文件路径或会话行；没有证据的条目一律 passed:false。`
          // zx_20261109_1 G10：有 ready 须知时才追加；空串 ⇒ 提示词逐字节不变。
          + (projectHintBlock
            ? `\n\n${projectHintBlock}\n\n判据引用的路径若在仓库中不存在，须判 passed:false 或说明无法核实，不得因"框架通常如此"判通过。`
            : '')
          + `\n\n输出 JSON 数组：[{"criterion":"...","passed":true/false,"reason":"...","evidence_refs":["run:<id>", ...]}]，每条验收标准对应一项。只输出 JSON，不要其他文字。`,
      });
      text = result.text || '';
      // 省耗账实(1a): 验收为旁路子 LLM——usage 记入执行期账本，收口并账(不入步进，防双计)
      addSideTokens(ctx, usageTokensOf(result as unknown as { usage?: unknown; text?: string }, criteria + evidence));
    }
  } catch (err) {
    kind = 'exception'; // 出口③：核对异常（同样落账，避免 LLM 故障卡死 finalize）
    // zx_20260923_1 M2: 此处此前是**裸 catch**——异常原因一个字都不落，真库标本 `a290ae2b` 的
    //   `reason:'error'` 事后无从追溯（是超时？是 401？）。存量纪律：失败要留得下可追的痕。
    logger.warn({ taskId: taskId.slice(0, 8), err: err instanceof Error ? err.message : String(err) }, '验收核对异常——如实落 error，不冒名通过');
  }

  // zx_20261105_1 M1：先解析、再**按证据强制降级**，最后才定夺——"模型说通过"不是结论，
  //   "模型说通过且引用了本任务真跑过的 run:<id>"才是。解析失败/空数组分别落 no_json/empty_checks。
  const parsed = kind === 'ok' ? parseAcceptanceChecks(text || '') : null;
  const enforced = parsed ? enforceEvidenceBoundChecks(parsed, evidenceIndex) : null;
  // zx_20261109_1 B5：带上**输入判据的有序行**——模型缺 `criterion` 时按它回填；条数对不上则如实落
  //   `criteria_echo_missing`（unjudged），不再出现 `5/5 + passed:[]` 这种计数与明细打架的账。
  const decided = decideAcceptanceOutcome({ kind, text, checks: enforced, criteriaOrder: splitCriteriaLines(criteria) });
  // 四出口归一：无模型/未吐 JSON/异常/真通过**都**在这里落一笔（此前只有真通过才落库 ⇒ 台账恒 0）
  // zx_20260923_1 M1: 返回值是**账上生效的那一笔**——若本条是"非结论"而账上已有真结论，
  //   守卫会保留旧账（`maySupersedeLedger`），此时 `payload.verified === true` 表明"我这笔没落上"。
  //   如实留痕：不得让"这次没判成"悄悄把旧结论顶掉（真库标本 §1.1 正是这样被洗成"没证据"的）。
  const payload = recordAcceptanceOutcome(db, taskId, decided);
  // zx_20261110_2 B6：结论为"真通过"、且判据路径里有靠**别的任务登记**解析的 ⇒ 给本任务自己的
  //   成果补一笔 `verified_via='criteria:<ref>'`（唯一写口 `markTaskVerifiedVia`，只动 task_id = 本任务）。
  //   不通过/未核/异常一律不动——否则就是拿一条"没核成"的账去盖章。
  if (payload.verified === true && decided.outcome.ran && decided.outcome.passed && pathResolved.length > 0) {
    const r = markTaskVerifiedVia(db, taskId, pathResolved.map((x) => ({ ref: x.ref, resolvedFrom: x.resolved_from })));
    if (r.changed > 0) {
      logger.info({ taskId: taskId.slice(0, 8), changed: r.changed }, '判据路径跨任务解析——本任务成果已按 criteria:<ref> 打标');
    }
  }
  if (!decided.outcome.ran && payload.verified === true) {
    logger.warn({ taskId: taskId.slice(0, 8), reason: decided.outcome.reason, kept: payload.checked_at }, '本次验收未取得结论，账上既有结论未被覆盖（账本守卫保留旧账）');
  }
  const block = decided.outcome.ran && !decided.outcome.passed ? decided.outcome.block : null;

  // B1 (2026-08-31): 验收失败 → storeText 记忆（毛选实践论——验收失败沉淀为记忆，供下次执行预警）
  if (block) {
    try {
      if (ctx.memory) {
        const taskRow = db.prepare('SELECT project_id, title FROM wa_tasks WHERE id = ?').get(taskId) as { project_id: string; title: string } | undefined;
        if (taskRow) {
          // zx_20261030_2 M4（判据与理由同价）：摘要**一处真源**——同一字符串同时喂记忆与 pitfall 卡，
          //   不再各自只拼判据名（旧形 `map(f => f.criterion).join('、')` 让下一棒看不到「为何没过」）。
          const failedItems = summarizeAcceptanceFailures(payload.failed);
          const content = `任务「${taskRow.title}」验收未达：${failedItems}`;
          // zx_20260929 M4（维特根斯坦·同一个降权三处是三个意思 / 管子·度量衡）：**同源替换优先**。
          //   本条的读者只有一处——`memory-context.ts` 的 `retrieveByType('acceptance_failure', …, 3)`，
          //   而旧写法直写 ⇒ 同一项目每失败一次追加一行，**自家副本挤占自家 top3 名额**：
          //   连续失败两次后，那一格只剩"同一个任务的两条流水"，真正的历史教训被顶出去。
          //   同源键是 `source`（'acceptance_check' 每项目恒一）⇒ 命中即"内容追加"，去重与
          //   `promoteWorkingMemory` 用**同一把尺**（`sameSourceReplace`），不另立阈值。
          //   未命中（首次）才落新行——返回 null 即"这一源还没有过"，不是失败。
          const replaced = ctx.memory.sameSourceReplace(taskRow.project_id, 'acceptance_check', content);
          if (!replaced) {
            ctx.memory.storeText({ project_id: taskRow.project_id, task_id: taskId, type: 'acceptance_failure', content, source: 'acceptance_check' });
          }
          // zx_20261023_5 批二（「只生成不自动生效」）：同一次失败**另**落一张 pending pitfall 卡，
          //   下一次蒸馏才并入 active——本次失败的原因还没被任何后续证据检验过，不能立刻当"知识"注入。
          recordPitfallCandidate(db, taskRow.project_id, { taskTitle: taskRow.title, failedItems });
        }
      }
    } catch { /* 验收失败记忆 best-effort */ }
  }
  return { outcome: decided.outcome, block, payload };
}
