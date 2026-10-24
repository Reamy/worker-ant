/**
 * 上下文预组装块（zx_20261018_1 批九「收」）。
 *
 * 从 `agent-executor.ts` **原样抽出**（零行为变化）：预算说明书、偏离事实说明、
 * 校验不充分原因、计划模式上下文合并、上游要求、已落盘账本、用户指令、按位截断。
 *
 * ⚠ 只依赖 `better-sqlite3` 的**类型**与入参；不引事件总线、不判档位——这是拼装层，不是决策层。
 *   `agent-executor.ts` 保留同名导出（旧调用点不裂，同 `acceptance-check` 范式）。
 */
import type Database from 'better-sqlite3';

// zx_20260910_6 M4（实践论：实践是唯一判据）：把「预算说明书」整块提取为**可测导出纯函数**。
// 理由：本轮要修的是"说明书把没有的上限说成有"，这类病**只扫源码验不出来**——
// 必须在**渲染结果**上验证三态（未设 / 设了已定价 / 设了未定价）各自说了什么。
// 档位说明沿用 zx_20260910_5 M2 (X4) 的真源口径 60%/75%/95%/98%（原写 70% 系失实，已订正不可回退）。
export function buildBudgetContextBlock(p: {
  maxTokens: number; maxCost: number; costSrc: 'task' | 'project' | 'none'; costGateActive: boolean;
}): string {
  const { maxTokens, maxCost, costSrc, costGateActive } = p;
  return `<budget-context>
Token预算: ${maxTokens.toLocaleString()} tokens${costSrc === 'none' ? '' : ` | 费用上限: ¥${maxCost.toFixed(2)}（${costSrc === 'task' ? '任务级' : '项目级'}）`}
预算使用达 60%/75% 时预警收敛提示，95% 禁探索改造类工具，98% 硬收尾强制产出。Token 与费用两道上限任一先到即触发。
${costSrc === 'none' ? '本任务未设置金额上限：无费用闸（费用照常累计与展示）。如需金额硬闸，可在项目或任务设置中填写费用上限。' : costGateActive ? '' : '注意：所选模型未配置单价（input/output_price_per_1k 均为 0），费用上限无法计量 ⇒ 费用闸不生效，当前仅有 Token 上限生效。'}
</budget-context>`;
}

// zx_20260911_1 M3（抓主要矛盾 / 知止不殆）：偏离判定器此前"看不见自己被闸卡着"——
// 只读最近 3 条 assistant 消息，门禁把模型逼进"修门禁"循环后自然读作"围绕门禁打转"。
// 由 ctxJson 的未满足产出生成一句**事实说明**供判定器参考（只补事实，不松闸：cap/节流/abort 一字不动）。
// 无阻塞时返回 ''，判定器行为与从前完全一致。
//
// zx_20260916_3 M1（同法，换一道闸）：**槽位满**这件事实以同一手法补入。D1 裁定全覆盖后，引擎自发补救
// （核实下钻/辩论/swarm）也会被广度闸拒——判定器若不知道"是引擎拦的，不是执行体跑偏"，
// 就会把"反复尝试建子任务"读作偏离并加码，正是 zx_20260911_1 M3 那个病的复发。
//
// ⚠ 本函数是**纯函数**（只读入参）：槽位数是**查库**得来的，由**调用方**查好放进
// `ctxJson.child_slots = { active, max }`——不得为此引入 db 依赖，否则 rr 就无法直跑这份真实现。
export function buildDeviationContextBlock(ctxJson: Record<string, unknown>): string {
  const parts: string[] = [];
  const seen = new Set<string>();
  const add = (file: string, reason: string): void => {
    const base = String(file || '').replace(/.*\//, '');
    if (!base || seen.has(base)) return;
    seen.add(base);
    parts.push(reason ? `${base}（${reason}）` : base);
  };
  const ov = Array.isArray(ctxJson.output_validations) ? (ctxJson.output_validations as Array<Record<string, unknown>>) : [];
  for (const e of ov) {
    if (e?.status !== 'insufficient') continue;
    const issues = Array.isArray(e.issues) ? (e.issues as string[]) : [];
    const missing = Array.isArray(e.missingAspects) ? (e.missingAspects as string[]) : [];
    add(String(e.file ?? ''), (issues.length > 0 ? issues : missing).join('；'));
  }
  const unf = ctxJson.deliverable_unfulfilled as { paths?: string[] } | undefined;
  if (unf && Array.isArray(unf.paths)) for (const p of unf.paths) add(String(p), '');
  const slots = ctxJson.child_slots as { active?: unknown; max?: unknown } | undefined;
  const slotFull = typeof slots?.active === 'number' && typeof slots?.max === 'number' && slots.active >= slots.max;
  const slotFact = slotFull ? `子任务槽位 ${slots!.active}/${slots!.max} 已满（引擎约束，非执行体选择）` : '';
  if (!slotFact && parts.length === 0) return '';
  const gateFact = parts.length > 0 ? `产出内容充分性门禁未通过：${parts.join('、')}` : '';
  return [slotFact, gateFact].filter(Boolean).join('；');
}

// zx_20260911_1 M2（知行合一 / 治疗）：门禁"算出来的诊断"必须送达执行体。
// 此前 quickCheck.issues（如"缺少结论/总结"）从未落库，而拒收文案却说"请根据校验反馈补全"——反馈是空的。
// 本函数把逐文件原因装成一句具体的话；两者皆空时**如实说**"校验器未给出具体原因"，不再写空话（那名实不符）。
export function formatInsufficiencyReasons(items: Array<{ file: string; reasons: string[] }>): string {
  const lines = items.map((it) => {
    const base = String(it.file || '').replace(/.*\//, '');
    return it.reasons.length > 0 ? `${base}：${it.reasons.join('；')}` : `${base}：校验器未给出具体原因`;
  });
  return lines.length > 0 ? `具体原因——${lines.join('；')}。` : '';
}

// zx_20260911_3 M1（奥卡姆·如无必要勿增实体）：计划模式两处入口的「只补写、不重建」合并器。
// 原实现以**全新对象**整体覆写 context_json（指纹：df334d91 的 ctx 前三键恰为 mode/plan/subtaskCount）
// ⇒ 抹掉事后关联写入的 scheme_ref，整棵子树自此与方案板失联。此处把"既有上下文 + 本工具自有三键"
// 抽为纯函数，使受控回归能在真入参上证，而非只扫源码。
export function mergePlanModeContext(
  ctxJson: Record<string, unknown> | null | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(ctxJson || {}), ...patch };
}

// zx_20260921 M8: 加 `export` 供 `core/exec-context.ts` 用（真源仍在此处）。
export function truncateCtx(text: string, maxChars: number, tag: string): string {
  if (!text || text.length <= maxChars) return text;
  const cut = text.slice(0, Math.max(0, maxChars - 80));
  const cutAt = cut.lastIndexOf('\n');
  const head = cutAt > Math.floor(maxChars * 0.6) ? cut.slice(0, cutAt) : cut;
  return `${head}\n…(${tag}较长，已裁剪至 ${maxChars} 字符；确需细节可 read_file/ask_user)`;
}

// zx_20260906_2 批1 (2026-09-06): 层级要求入链——子任务/依赖任务执行时注入「父任务(1级)+depends_on 前置(1级)」要求。
// 子任务只见自身 title/desc(executeTask 原 taskMessage 仅拼自身)会不知道"要符合什么"而试错返工；给对上游要点(准)→免空转(省 token)。
// 无 parent/depends_on 则零注入(意义即使用)；整块 UPSTREAM_BLOCK_MAX_CHARS 上限 + truncateCtx 兜底；不递归、不新增记忆机制。
const UPSTREAM_BLOCK_MAX_CHARS = 2000;

/**
 * zx_20261023_5 批一：跨机派单随行的**上游摘要**——键名与上限的**一处真源**。
 *
 * 写口：`node-request-runner`（远端收到 `payload.upstream` 后落进新任务的 context_json）；
 * 读口：本文件 `buildUpstreamRequirementBlock`（远端任务没有本机 depends_on，只有这份摘要可依）。
 * 上游依赖图**不进 ANS**——跨机的只是"前置做完了什么"，不是一张远端 DAG。
 */
export const UPSTREAM_SUMMARIES_KEY = 'upstream_summaries';
export const UPSTREAM_MAX_ITEMS = 5;
export const UPSTREAM_MAX_CHARS = 1200;

export interface UpstreamSummaryItem {
  id: string;
  title: string;
  summary: string;
}

/**
 * 把"上游摘要数组"的**任意来料**收成受控形态。**永不抛**：非数组、缺字段的条目一律丢弃
 * （不把"读不成"当成"有值"）；条数与总字符按上限再收一次——接收端不信任发送端，两边各守各的界。
 * 两处共用：`parseUpstreamSummaries`（读 context_json）与 `node-request-runner.relayUpstream`（读派单载荷）。
 */
export function sanitizeUpstreamSummaries(value: unknown): UpstreamSummaryItem[] {
  if (!Array.isArray(value)) return [];
  const arr = value;
  const out: UpstreamSummaryItem[] = [];
  let used = 0;
  for (const item of arr) {
    if (out.length >= UPSTREAM_MAX_ITEMS) break;
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.id === 'string' ? o.id.trim() : '';
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const summary = typeof o.summary === 'string' ? o.summary.trim() : '';
    if (!id && !title && !summary) continue;
    const cost = title.length + summary.length + 8;
    if (used + cost > UPSTREAM_MAX_CHARS) break;
    used += cost;
    out.push({ id, title, summary });
  }
  return out;
}

/** 从 context_json（string / Buffer / null）解析上游摘要；坏 JSON ⇒ 空数组。 */
export function parseUpstreamSummaries(raw: unknown): UpstreamSummaryItem[] {
  let ctx: Record<string, unknown> = {};
  try {
    const s = raw == null ? '' : Buffer.isBuffer(raw) ? raw.toString('utf-8') : String(raw);
    const o = s ? JSON.parse(s) : null;
    if (o && typeof o === 'object' && !Array.isArray(o)) ctx = o as Record<string, unknown>;
  } catch { return []; }
  return sanitizeUpstreamSummaries(ctx[UPSTREAM_SUMMARIES_KEY]);
}

export function buildUpstreamRequirementBlock(db: Database.Database, task: Record<string, unknown>): string | null {
  try {
    const parentId = String(task.parent_task_id ?? '').trim();
    const deps = String(task.depends_on ?? '').trim();
    // zx_20261023_5 批一：跨机派来的任务，依赖在派单方本机已满足，本地没有 depends_on——
    //   它的"上游"只以摘要形态随单而来；三者皆无才是真的零注入。
    const upstream = parseUpstreamSummaries(task.context_json);
    if (!parentId && !deps && upstream.length === 0) return null;
    const lines: string[] = ['先明确本子任务须满足的父级/前置要求再执行，不得偏离父任务目标（父/前置若进行中，以其已落产出为准，必要时 read_file 复核）。'];
    if (parentId) {
      const p = db.prepare('SELECT title, description, acceptance_criteria, status FROM wa_tasks WHERE id = ?').get(parentId) as { title?: string; description?: string | null; acceptance_criteria?: string | null; status?: string } | undefined;
      if (p) {
        lines.push(`[父任务] ${p.title ?? '?'}（状态：${p.status ?? '?'}）`);
        if (p.description) lines.push(`父任务目标：${String(p.description).slice(0, 500)}`);
        if (p.acceptance_criteria) lines.push(`父任务验收（本子任务须助其达成）：${String(p.acceptance_criteria).slice(0, 500)}`);
      }
    }
    if (deps) {
      for (const depId of deps.split(',').map((s) => s.trim()).filter(Boolean)) {
        const d = db.prepare('SELECT id, title, status FROM wa_tasks WHERE id = ?').get(depId) as { id?: string; title?: string; status?: string } | undefined;
        if (!d) continue;
        lines.push(`[前置任务 ${String(d.id).slice(0, 8)}] ${d.title ?? '?'}（${d.status ?? '?'}）`);
        const outs = db.prepare("SELECT name, type FROM wa_deliverables WHERE task_id = ? AND status NOT IN ('retired') ORDER BY created_at DESC LIMIT 4").all(depId) as Array<{ name: string; type: string }>;
        if (outs.length > 0) lines.push(`  已完成产出：${outs.map((o) => `[${o.type}] ${o.name}`).join('；')}`);
        else if (d.status === 'completed') lines.push('  已完成（无登记产出物，如需可 read_file 核查现场）');
      }
    }
    if (upstream.length > 0) {
      lines.push('[上游已完成任务摘要]（由派单方随单带入；其产出留在派单方本机，确需细节应向派单方追问，不要凭空假定文件已在本地）');
      for (const u of upstream) {
        const tag = u.id ? String(u.id).slice(0, 8) : '上游';
        lines.push(`- [前置 ${tag}] ${u.title || '（无标题）'}：${u.summary || '（无摘要）'}`);
      }
    }
    const block = `<upstream-requirement>\n${lines.join('\n')}\n</upstream-requirement>`;
    return truncateCtx(block, UPSTREAM_BLOCK_MAX_CHARS, '上游要求');
  } catch { return null; }
}

// ── zx_20260917 M5c（失明⑥）：偏离判定器要看得见「**已经干完哪些**」 ─────────────────────
// 病：判定器的输入是「最近 3 条 assistant 消息 + 近 5 次工具名」，**没有顺序的证据**；
// 而目标常形如「按 A→B→C 顺序完成」⇒ 发生**无知论证**：「未提及」被读作「未做」，
// 「正在做第 k 项」被读作「先做了第 k 项」——对任何 k > 1 都成立，故这是**结构性必报**。
// 实测（§1.4-Ⅲ）：M1 的三条指控全部此形状，而落盘时刻序一位不差（F0.5→F0.4→F0.3→F0.2）。

/** 账本第一路的一行：**本任务真写过的文件** + 其**首次落盘时刻**（`occurred_at` 原文，UTC） */
export interface WrittenFileFact { path: string; at: string }

/** 账本里最多列几个文件（**显示**上限，非取数上限；超出时如实说"另有 N 项"） */
export const COMPLETED_ITEMS_FILE_LIMIT = 15;

/**
 * 账本第一路取数：`wa_event_log` 的文件事件，按路径**归并**取首次落盘时刻，升序。
 *
 * ⚠ 三种事件都取：`file.created`（新建）／`file.edited`（局部编辑）／`file.updated`（覆盖写入）。
 * 只取前两者会让**覆盖式写入隐形**——`write_file` 对已存在文件发的正是 `file.updated`
 * （`file.created` 仅在 `!existedBefore` 时发），不看它等于看不见这类落盘。
 *
 * 归并到"路径"而非"事件"：要的是**顺序**（谁先落盘），重复编辑同一文件不构成新次序。
 */
export function collectWrittenFiles(db: Database.Database, taskId: string): WrittenFileFact[] {
  try {
    const rows = db.prepare(
      `SELECT json_extract(payload, '$.filePath') AS fp, MIN(occurred_at) AS at
         FROM wa_event_log
        WHERE aggregate_id = ? AND event_type IN ('file.created', 'file.edited', 'file.updated')
        GROUP BY json_extract(payload, '$.filePath')
        ORDER BY at ASC`,
    ).all(taskId) as Array<{ fp: string | null; at: string | null }>;
    return rows.filter((r) => !!r.fp).map((r) => ({ path: String(r.fp), at: String(r.at ?? '') }));
  } catch { return []; }
}

/** 库里时刻 → `HH:MM:SS`（两种落库格式同位置：`2026-09-17T06:30:31Z` 与 `2026-09-17 06:30:31`） */
function clockOf(at: string): string { return String(at || '').slice(11, 19); }

/** 路径只留末两段（判定器要拿它跟 assistant 正文里的文件名对上，全路径太长、basename 又有重名风险） */
function shortPath(p: string): string {
  const segs = String(p || '').split('/').filter(Boolean);
  return segs.length <= 2 ? segs.join('/') : `…/${segs.slice(-2).join('/')}`;
}

/**
 * 账本段（**纯函数**，供 rr 直跑真实现）——形制照抄 `blockerNote`：前导 `\n注意：…`、尾随 `\n`，无内容返回 `''`。
 *
 * ⚠ 空账本**返回空串**（K3）：不得把"表为空"渲染成一句"什么都没缺"的暗示——
 * 无事实时判定器行为**逐字回到本轮前**。
 */
export function buildCompletedItemsBlock(facts: { files?: readonly WrittenFileFact[]; deliverables?: readonly { name?: unknown; type?: unknown }[] }): string {
  const files = facts.files ?? [];
  const delivs = facts.deliverables ?? [];
  if (files.length === 0 && delivs.length === 0) return '';
  const lines: string[] = [];
  if (files.length > 0) {
    lines.push('[已落盘文件]（第一列为该文件的**首次落盘时刻**，全表按此时刻升序）');
    for (const x of files.slice(0, COMPLETED_ITEMS_FILE_LIMIT)) lines.push(`- ${clockOf(x.at)} ${shortPath(x.path)}`);
    if (files.length > COMPLETED_ITEMS_FILE_LIMIT) {
      lines.push(`- （共 ${files.length} 项，此处只列前 ${COMPLETED_ITEMS_FILE_LIMIT} 项）`);
    }
  }
  if (delivs.length > 0) {
    lines.push('[已登记产出物]（已登记且此刻确实在）');
    for (const d of delivs) lines.push(`- [${String(d.type ?? '')}] ${String(d.name ?? '')}`);
  }
  return `\n注意：下列各项**已完成**（按完成时刻升序）。判定时：「未提及」不等于「未做」——凡在上表内的项，不得因未出现在"最近进展"里而判为未做；涉及"顺序/先后"的指控，只能依据本表的时间序，本表未提供的顺序，不得推定为倒置。\n${lines.join('\n')}\n`;
}

// ── zx_20260917 M5c（失明⑦）：判定器要看得见「**用户刚下的指令**」 ────────────────────────
// 病（与⑥**独立**）：取"最近进展"的查询硬编码 `role = 'assistant'` ⇒ 用户与系统的消息一条都进不去，
// **判定器看不见自己刚发出去的提醒**，也看不见"用户刚刚改了任务重点"（§1.4-Ⅳ 实证：
// 用户填「现在只剩 F0.6 与 F0.1 两项」、执行体照办，判分器随即判「未按指定顺序」⇒ 照指令办事成了偏离证据）。
//
// ⚠ 只取 `role = 'user'` **一档**：`role = 'system'` 的行是 `[工具调用] name(args)` 噪声（全库成千行级），
//   掺进来会把账本淹掉。而 `[目标偏离提醒]` / `[系统] 继续执行` / 用户在桌面填的恢复指令**实测都落在 `user`**。

/** 单条指令的注入上限（沿既有"每段有界"的形制，不新增机制） */
export const USER_DIRECTIVE_MAX_CHARS = 300;

/**
 * 第二路取数：最近的 `user` 角色消息，`rowid` 逆序（真实插入序——`created_at` 仅秒级分辨不了同秒多行）。
 *
 * ⚠ **按正文去重**：实测同一句恢复指令会在压缩回放时**再写一行**（真库 M1：`06:55:07` 与 `06:55:40` 同文），
 *   不去重则两行同文占满窗口，真正的"更早那条不同指令"被挤掉。
 * ⚠ 取数多要几条（`limit * 3`）再去重截取——否则去重会把窗口吃到不足 `limit` 条。
 */
export function readRecentUserDirectives(db: Database.Database, taskId: string, limit = 2): string[] {
  try {
    const rows = db.prepare(
      "SELECT content, created_at FROM wa_task_conversations WHERE task_id = ? AND role = 'user' ORDER BY rowid DESC LIMIT ?",
    ).all(taskId, limit * 3) as Array<{ content?: string | null; created_at?: string | null }>;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const r of rows) {
      const c = (r.content || '').trim();
      if (!c || seen.has(c)) continue;
      seen.add(c);
      out.push(`${clockOf(String(r.created_at || ''))} ${c.length > USER_DIRECTIVE_MAX_CHARS ? `${c.slice(0, USER_DIRECTIVE_MAX_CHARS)}…` : c}`);
      if (out.length >= limit) break;
    }
    return out;
  } catch { return []; }
}

/**
 * 指令段（**纯函数**）。空 ⇒ `''`（逐字回到本轮前）。
 *
 * ⚠ 明写"用户指令**优先于**目标里的执行顺序"——但**不是免死金牌**：仍要求"做的事至少符合二者之一"，
 *   否则判分器会从"看不见指令"翻转成"指令即免检"（K5-rev 钉的就是这支）。
 */
export function buildUserDirectiveBlock(directives: readonly string[]): string {
  const items = (directives ?? []).filter((d) => typeof d === 'string' && d.trim());
  if (items.length === 0) return '';
  return `\n注意：用户/系统最近下达的指令为：\n${items.map((d) => `- ${d}`).join('\n')}\n**用户指令优先于上述目标中的执行顺序**——执行体按该指令调整重点不构成偏离；只有当它做的事既不符合目标、也不符合该指令时才判偏离。\n`;
}
