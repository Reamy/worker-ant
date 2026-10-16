/**
 * zx_20260921 M8（重构·只动形不动义）: `executeTask` 的**上下文装配段**——把"模型开跑前该看见的一切"
 * 组装成 `messages`：系统提示骨架、工具规矩简报、日期/偏好/记忆/张力事实/沙箱/自治/失败模式、预算说明书、
 * 任务类型引导、项目上下文（含工作目录清单/MCP/术语/通知目录）、历史摘要与尾部回放（含 64K 系统提示保护之外
 * 的那一段：摘要与尾部裁剪）。**本段不负责 64K 截断**——那段仍留在调用方，作用于返回的 `messages` 之上。
 *
 * 搬迁来源：`core/agent-executor.ts` 的 `executeTask` 原 `:1390`–`:1577`，**逐行搬运**，只加函数包裹层、
 * 把外部读值提成参数、缩进整体左移两格，并把"就地拼装"收敛成函数末尾的一次返回。
 *
 * **为什么单独成模块**：本段是 `executeTask` 里**唯一**只读外部状态、产出两个新对象（`messages` 数组与
 * `projectCtx` 字符串）而不就地改写任何跨段累加量的一块。切出去不动任何账，是纯装配。
 *
 * **随结果回传的量（形状如实记）**：计划表原写输出 `{ messages, projectCtx }`，实测**还须回传 `summaryOnly`**
 * ——它在本段算出（"有 LLM 摘要且历史尾超预算 ⇒ 仅用摘要"），下游 `context_watermark` 要把它落库
 * （`summaryOnly` 是水位分项之一）。少回传一个只是把变量藏在模块里、下游读不到，属**形状订正**不是放松。
 * zx_20260930 M7-c 又添**第四个**回传量 `lessonsIds`（`<lessons-learned>` 真入文者的 id，供调用方回执）——
 * 同一道理：藏在本模块里，`use_count` / `injected_memory_ids` / `memory_used_ids_run` 就都记不上它。
 *
 * **本模块运行时 `import` 回 `agent-executor.js`**（`buildBudgetContextBlock` / `classifyTaskGuidance` /
 * `truncateCtx` / 三个 `CTX_*_MAX_CHARS` 常量 / `SYSTEM_PROMPT_BASE`）——与 `core/jobs/ai-task.ts` ↔
 * `agent-executor.js`、`core/exec-claim.ts` ↔ `agent-executor.js` 的既有双向引用**同形**（那两个环已长期存在且在跑）。
 * 搬的是**调用点**，这些符号的真源**仍在执行体一处**，本模块**未复制第二份**。
 * 它们只在函数体内被读，不在本模块顶层求值 ⇒ ESM 环里的 TDZ 不会触发。
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { CoreMessage } from 'ai';
import { isComplexOrPlanish, type AdaptiveStrategy, type ComplexityLevel, type TaskArchetype } from './task-archetype.js';
import { readBoolSetting } from './settings-bool.js';
import { createLogger } from './logger.js';
// zx_20260930 M5: 失败模式的**类型名**与写侧同引一处（原为写在本文件 SQL 里的裸字面量）。
//   读写分家时两侧各写一个近义串（拼法不同）都"没错"，查询恒空而无人报错——故名字只定义一次。
//   本文件内**不留**该名字的任何副本（连注释里都不写），免得日后有人照着抄成一个串。
import { MEM_TYPE_FAILURE_KNOWLEDGE } from './memory-constants.js';
import { buildToolConstraintBrief } from './tool-guards.js';
import { generateTensionContext, generateContradictionContext, getTensions } from './tension-engine.js';
import { generateFactSnapshot } from './world-snapshot.js';
import { getToolUsageHint } from './feedback-engine.js';
import { truncateHistoryTail } from './context-compaction.js';
import {
  buildBudgetContextBlock, classifyTaskGuidance, truncateCtx,
  CTX_HISTORY_TAIL_MAX_CHARS, CTX_MEMORY_MAX_CHARS, CTX_PROJECT_MAX_CHARS, SYSTEM_PROMPT_BASE,
} from './agent-executor.js';
import type { AgentContext } from './agent-executor.js';

const logger = createLogger('exec-context');

export interface TaskContextAssembly {
  /** 装配好的对话上下文。调用方**按引用继续推进**（验收标准、需求卡、上游要求、本轮 user 消息都在其后追加）。 */
  messages: CoreMessage[];
  /** 项目上下文全文（`<project-context>` 内的那份，未截断前）——下游水位要它的字符数。 */
  projectCtx: string;
  /** "有 LLM 摘要且历史尾超预算 ⇒ 仅用摘要不回放整条尾"。下游 `context_watermark` 分项。 */
  summaryOnly: boolean;
  /**
   * zx_20260930 M7-c：本段 `<lessons-learned>` **真推入上下文**的 procedural 记忆 id（0～3 条，空数组=本段未注入）。
   * 消费者在调用方：与 `memoryContext` 的 `accessedIds` 同路回执——`recordAccess` + 并入
   * `injected_memory_ids` 与 `memory_used_ids_run`。本模块**只回传、不落库**（保持纯装配）。
   */
  lessonsIds: string[];
}

/**
 * 装配模型开跑前的上下文。**纯读 + 纯拼装**：只写本函数自己新建的三个对象（`messages` 数组 / `projectCtx`
 * 字符串 / `lessonsIds` 数组），不改任何任务行、不落库（唯一的例外是段内既有的 `dynamic import('./sandbox.js')`
 * 与 `fs.readdirSync` 读目录）。zx_20260930 M7-c 添了第三个回传量 `lessonsIds`——它同样只是**新数组**，
 * 记账（`recordAccess` + 两个 union）由调用方做。
 */
export async function buildTaskContext(o: {
  ctx: AgentContext;
  db: Database.Database;
  taskId: string;
  projectId: string;
  project: Record<string, unknown> | undefined;
  workingDir: string;
  title: string;
  description: string;
  archetype: TaskArchetype;
  adaptiveStrategy: AdaptiveStrategy;
  complexityLevel: ComplexityLevel;
  userPrefs: string;
  memoryContext: string;
  successContext: string;
  subagentSystemPrompt: string | undefined;
  projCtxJson: Record<string, unknown>;
  maxTokens: number;
  maxCost: number;
  costSrc: 'task' | 'project' | 'none';
  costGateActive: boolean;
  historySummary: string;
  recentConversations: Array<{ role: string; content: string }>;
}): Promise<TaskContextAssembly> {
  const {
    ctx, db, taskId, projectId, project, workingDir, title, description, archetype, adaptiveStrategy,
    complexityLevel, userPrefs, memoryContext, successContext, subagentSystemPrompt, projCtxJson,
    maxTokens, maxCost, costSrc, costGateActive, historySummary, recentConversations,
  } = o;
  // zx_20260921 M2: 改为 `CoreMessage[]`——用户消息的 content 自本轮起可能是
  // `Array<TextPart | ImagePart>`（附件内联）。system/历史回放仍是纯字符串，仍是合法 UserContent。
  const messages: CoreMessage[] = [];
  messages.push({ role: 'system', content: SYSTEM_PROMPT_BASE });
  // zx_20260915 M5/P0-7：工具能力与限制简报——**把规矩告诉模型，别让模型去猜**（本条是根治）。
  // 独立一条 system 消息（而非写进 SYSTEM_PROMPT_BASE）：白名单条数由 SAFE_READONLY_COMMANDS 派生，
  // 写进模板常量就得落成字面量，下一轮换集即假（"只为下一轮"的哑雷）。
  // 受 `engine.shell_advice_honest` 门控（关 ⇒ 不注入，判据仍可被回归直调）。
  try {
    if (readBoolSetting(db, 'engine.shell_advice_honest')) {
      messages.push({ role: 'system', content: buildToolConstraintBrief() });
    }
  } catch { /* 简报失败不影响执行 */ }
  // D1 (2026-09-03_1): 复杂/规划类任务启动引导——建议先 enter_plan_mode 分解，避免无界探索
  // zx_20261002 M5: 判据由内联改为 `isComplexOrPlanish` **一处真源**——同一把尺现同时供
  //   启动路的"到点即拆"（`ai-task` 处理器）取用，两处不会再各说各话。
  try {
    if (isComplexOrPlanish(complexityLevel, title, description)) {
      messages.push({ role: 'system', content: '建议：本任务较复杂/属规划方案类。若任务目标尚需拆解，请先调用 enter_plan_mode 用 create_task 分解为子任务（可设 depends_on 依赖与优先级），规划完成后 exit_plan_mode 再逐步执行；避免无界探索、空耗预算。' });
    }
  } catch { /* 引导失败不影响执行 */ }
  // 子Agent类型 systemPrompt 注入
  if (subagentSystemPrompt) messages.push({ role: 'system', content: subagentSystemPrompt });
  // 当前日期注入（Agent写产出物/报告需准确日期）
  const now = new Date();
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  messages.push({ role: 'system', content: `<current-date>今天是 ${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')} (${weekdays[now.getDay()]})。在产出物、报告、文件名中使用此准确日期，不要凭记忆猜测。</current-date>` });
  if (userPrefs) {
    messages.push({ role: 'system', content: userPrefs });
  }
  if (memoryContext) {
    // zx_20260930 M7-a（米勒/巴德利·工作记忆 + 道德经·知止）: **预算双闸合一**。
    //   此处原有第二道闸 `truncateCtx(memoryContext, CTX_MEMORY_MAX_CHARS, '记忆上下文')`——它按**位**掐尾，
    //   而 `memory-context.ts` 里 `add(...)` 的段序把**最贴当下任务的段**正好放在末尾
    //   （工作记忆/已知盲区/负空间/复盘教训/心中贼/验收失败预警 皆为 high，见 MEM_SECTION_PRIORITY）
    //   ⇒ 预算一满就先把这几段整段掐掉，且掐掉的是**哪几段**用户与模型都无从得知。
    //   真源侧早已按**段优先级**整段取舍，并如实标注「已省略 N 段：…」——那里才是按值的那把尺。
    //   两道闸并存 = 同一条记忆块的预算有**两个**执行点，且后一道按位覆盖前一道的按值结果（方案 §1.4 病根）。
    //   故**撤掉这道闸**：真源产出什么，装配就原样推入。`CTX_MEMORY_MAX_CHARS` 仍是唯一预算真源
    //   （C35 钉它必须仍可从执行体 import），只是它此后只在真源侧**生效**；此处仅**审计**越界。
    //   越界只可能来自"保底支"——单段即超上限（`selectMemorySections` 到 `alive.size <= 1` 停手），
    //   生产各段文本上界皆远小于有效预算 ⇒ 生产不可达（rr_zx_20260929 D-2 已把这一支如实钉住）。
    //   故此处如实告警，而非在装配层再按位补一刀（补刀会把"如实越界"改写成"静默截断"，更坏）。
    if (memoryContext.length > CTX_MEMORY_MAX_CHARS) {
      logger.warn(
        { taskId, chars: memoryContext.length, budget: CTX_MEMORY_MAX_CHARS },
        '记忆上下文超出预算（保底支：单段即超上限）——原样推入，不在装配层按位补刀',
      );
    }
    messages.push({ role: 'system', content: memoryContext });
  }
  if (successContext) {
    messages.push({ role: 'system', content: successContext });
  }
  // C3: 架构张力上下文 + 矛盾论主要矛盾 + 实事求是事实快照
  try {
    const tensionCtx = generateTensionContext(db, projectId);
    if (tensionCtx) messages.push({ role: 'system', content: tensionCtx });
    const contradictionCtx = generateContradictionContext(db, projectId);
    if (contradictionCtx) messages.push({ role: 'system', content: contradictionCtx });
    // zx_20260904_7 优化② (2026-09-04): 张力 position → 可执行引导（数值阈值映射为指令）
    try {
      const tensions = getTensions(db, projectId);
      const guide: string[] = [];
      const ctrl = tensions['autonomy-vs-control']?.position; // 右=人工控制
      if (ctrl != null) {
        if (ctrl >= 70) guide.push('张力[自治vs可控]偏"人工控制"：目标/口径/风险操作不明确时先 ask_user 确认（多一步确认优于自行决策）。');
        else if (ctrl <= 20) guide.push('张力[自治vs可控]偏"Agent自治"：低风险推进可自主决策，仅重大不可逆操作才 ask_user。');
      }
      const qual = tensions['speed-vs-quality']?.position; // 右=高质量
      if (qual != null) {
        if (qual >= 70) guide.push('张力[速度vs质量]偏"高质量"：收尾前确保产出/测试可验证，勿过早 finalize（先 write_file 落产出并自测）。');
        else if (qual <= 30) guide.push('张力[速度vs质量]偏"快速"：聚焦核心目标、减少过度打磨，完成后及时 finalize。');
      }
      if (guide.length > 0) messages.push({ role: 'system', content: `<tension-guide>\n${guide.join('\n')}\n</tension-guide>` });
    } catch { /* 张力引导失败不阻塞 */ }
    const factSnapshot = await generateFactSnapshot(db, projectId);
    if (factSnapshot) messages.push({ role: 'system', content: factSnapshot });
  } catch {}
  // 沙箱模式感知（sandbox.getSandboxPrompt）
  try {
    const sandboxMode = (project?.sandbox_mode as string) || 'workspace';
    const { getSandboxPrompt } = await import('./sandbox.js');
    const sandboxPrompt = getSandboxPrompt(sandboxMode as 'strict' | 'workspace' | 'off');
    if (sandboxPrompt) messages.push({ role: 'system', content: sandboxPrompt });
  } catch {}

  // A1.3: 自治模式感知（autonomous_mode + backlog 链）
  try {
    const autoProj = db.prepare('SELECT autonomous_mode, context_json FROM wa_projects WHERE id = ?').get(projectId) as { autonomous_mode: string; context_json: string } | undefined;
    if (autoProj?.autonomous_mode && autoProj.autonomous_mode !== 'off') {
      const autoCtx = JSON.parse(autoProj.context_json || '{}');
      const backlog = (autoCtx.backlog as string[]) || [];
      const chainDepth = (autoCtx.autonomous_chain_depth as number) || 0;
      const autoParts = [`[自治模式] 当前项目处于自治模式(${autoProj.autonomous_mode})。`];
      if (backlog.length > 0) autoParts.push(`项目待办列表(backlog)剩余${backlog.length}项:\n${backlog.map((b, i) => `${i + 1}. ${b}`).join('\n')}`);
      autoParts.push(`当前自治链深度: ${chainDepth}/3（达到3将停止自动创建任务）。`);
      messages.push({ role: 'system', content: autoParts.join('\n') });
    }
  } catch {}

  // 失败模式感知 + 经验注入（3.2/3.3 实事求是）—— B2 (2026-08-31) 移除范例上下文双注入（保留 buildMemoryContext 内唯一注入）
  // zx_20260930 M7-c（赫布·一起激发的神经元连在一起 / 王阳明·知行合一）: `<lessons-learned>` 是**真入文**的一段
  //   （作为 system 消息推给模型、被模型读过），却**不回执**：既不 `recordAccess`（`use_count`/`last_used_at` 不动），
  //   也不进 `injected_memory_ids`。后果是**被用过却被记成没用过**——强化信号整条丢失，且下个 run 的
  //   `buildMemoryContext` 跨 run 排除集也认不出它们（同一段经验反复被当"新"注入）。
  //   本模块**保持纯读**（不改任务行、不落库），只把"真入文的 id"随结果**回传**，由执行体统一记账
  //   （与 `accessedIds` 同一处理方式，见 TaskContextAssembly.lessonsIds）。
  const lessonsIds: string[] = [];
  try {
    if (ctx.memory) {
      // zx_20260906 批2: lessons-learned 剔除已由 buildMemoryContext 注入的 procedural（全文去重，不重复占 token）。
      // 已入文集合读 context_json.injected_memory_ids（含本 run 与前序 run 的 union，见 buildMemoryContext 持久化）
      const injectedIds = new Set<string>();
      try {
        const pctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined)?.context_json || '{}') as { injected_memory_ids?: unknown };
        const arr = pctx.injected_memory_ids;
        if (Array.isArray(arr)) for (const id of arr) injectedIds.add(String(id));
      } catch { /* 忽略 */ }
      const deduped = ctx.memory.retrieveByType('procedural', projectId, 5).filter((m) => !injectedIds.has(String(m.id)));
      const lessons = deduped.slice(0, 3);
      if (lessons.length > 0) {
        messages.push({ role: 'system', content: `<lessons-learned>\n过往任务中积累的经验：\n${lessons.map(m => `• ${m.content}`).join('\n')}\n</lessons-learned>` });
        // 取**推入的那三条**（`lessons`，非 `deduped`）——与上面 `slice(0, 3)` 同源，与文案里列出的条目逐条对齐。
        for (const m of lessons) lessonsIds.push(String(m.id));
      }
    }
    const failModes = db.prepare('SELECT content FROM wa_memories WHERE project_id = ? AND memory_type = ? ORDER BY created_at DESC LIMIT 3').all(projectId, MEM_TYPE_FAILURE_KNOWLEDGE) as Array<{ content: string }>;
    if (failModes.length > 0) {
      messages.push({ role: 'system', content: `<failure-awareness>\n本项目的失败模式（避免重蹈覆辙）：\n${failModes.map(f => `• ${f.content.slice(0, 120)}`).join('\n')}\n</failure-awareness>` });
    }
  } catch {}
  // zx_20260910_5 M2 (X4) / zx_20260910_6 M1-M4: 说明书整块提取为可测导出纯函数（见文件上方 buildBudgetContextBlock）。
  // 名可名：说明书必须写规则真实的玩法，且"有没有金额闸"这件事必须在**渲染结果**里可验证，不能只在源码里"看起来有条件"。
  messages.push({ role: 'system', content: buildBudgetContextBlock({ maxTokens, maxCost, costSrc, costGateActive }) });

  // 任务类型引导 + 自适应优先工具（6种原型）
  const taskGuidance = classifyTaskGuidance(title + ' ' + description);
  if (taskGuidance) {
    messages.push({ role: 'system', content: taskGuidance });
  }
  if (adaptiveStrategy.priorityTools.length > 0) {
    messages.push({ role: 'system', content: `[任务类型: ${adaptiveStrategy.label}] 优先使用工具: ${adaptiveStrategy.priorityTools.join(', ')}` });
  }
  // 意义即使用：注入高失败率工具警示
  try {
    const toolHint = getToolUsageHint(db, projectId, archetype);
    if (toolHint) messages.push({ role: 'system', content: toolHint });
  } catch {}

  // 项目上下文注入
  let projectCtx = `当前任务: ${title}\n工作目录: ${workingDir}`;
  // 工作目录已有内容（帮助Agent了解目录结构）
  try {
    const dirEntries = fs.readdirSync(workingDir, { withFileTypes: true }).slice(0, 30);
    const dirs = dirEntries.filter(d => d.isDirectory() && !d.name.startsWith('.')).map(d => `${d.name}/`);
    const files = dirEntries.filter(d => d.isFile() && !d.name.startsWith('.')).map(d => d.name);
    if (dirs.length || files.length) {
      projectCtx += `\n目录内容: ${[...dirs.slice(0, 8), ...files.slice(0, 12)].join(', ')}${dirEntries.length > 30 ? '...' : ''}`;
    }
  } catch {}
  // MCP服务感知
  try {
    const mcpList = db.prepare(
      "SELECT d.name FROM wa_deliverables d WHERE d.project_id = ? AND d.type = 'mcp' AND d.status IN ('registered','running')"
    ).all(projectId) as Array<{ name: string }>;
    if (mcpList.length > 0) projectCtx += `\n可用的MCP服务: ${mcpList.map(s => s.name).join(', ')}`;
  } catch {}
  // 语言游戏（项目术语）
  if (projCtxJson.language_game) {
    const lg = projCtxJson.language_game as { terminology?: Record<string,string>; conventions?: string[] };
    if (lg.terminology && Object.keys(lg.terminology).length > 0) {
      projectCtx += '\n项目术语: ' + Object.entries(lg.terminology).map(([k,v]) => `${k}→${v}`).join(', ');
    }
    if (lg.conventions && lg.conventions.length > 0) {
      projectCtx += '\n编码约定: ' + lg.conventions.join('; ');
    }
  }
  // 通知目录
  const notifyDir = process.env.NOTIFICATION_PAYLOAD_DIR || path.join(ctx.dataDir, 'notification_payloads');
  projectCtx += `\n通知目录(F3): ${notifyDir}`;
  // zx_20260904_4 T2 (2026-09-04): 项目上下文上限（目录清单/描述超长不再无限拖首部）
  messages.push({ role: 'system', content: truncateCtx(`<project-context>${projectCtx}</project-context>`, CTX_PROJECT_MAX_CHARS, '项目上下文') });
  // A5: 压缩后的历史摘要优先，替代全量历史（保留最近30%尾部）
  if (historySummary) {
    messages.push({ role: 'system', content: `[任务历史摘要（LLM压缩）]\n${historySummary}` });
  }
  // zx_20260904_3 D2 (2026-09-04): 恢复上下文不重复回放——[系统恢复] 块由下方 taskMessage 唯一注入一次，
  // 跳过历史 DB 里的恢复行，避免旧恢复块被逐轮整段重放成倍放大 token
  // zx_20260904_4 T2 (2026-09-04): 历史较长且有 LLM 摘要 → 仅用摘要，不回放整条尾（长任务省 Token）
  const historyTailChars = recentConversations.reduce((a, c) => a + String(c.content || '').length, 0);
  const summaryOnly = !!historySummary && historyTailChars > CTX_HISTORY_TAIL_MAX_CHARS;
  if (summaryOnly) {
    messages.push({ role: 'system', content: '[历史压缩] 历史对话较长，已用 LLM 摘要替代逐条回放；确需细节再针对性 read_file。' });
  } else {
    // zx_20260913 M4-4(道德经·知止 / 管子·度量衡): 非 system 历史纳入**同一容量口径**。
    // 此前 `summaryOnly` 只在**已有 LLM 摘要**时生效；无摘要时下面这段逐条回放**无任何上限** ——
    // 长任务（多轮 resume）的历史会在每次 resume 时整条重放，首部无界膨胀。现按 CTX_HISTORY_TAIL_MAX_CHARS
    // **保留尾部 + 如实标注**（不静默掐尾、不整段丢弃）。
    const replay: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const conv of recentConversations) {
      if (conv.role === 'system') continue;
      if (String(conv.content || '').startsWith('[系统恢复]')) continue;
      // tool 结果行无 tool_call_id，AI SDK 会校验失败，转为 user 角色保留内容
      const role = conv.role === 'tool' ? 'user' : conv.role;
      replay.push({ role: role as 'user' | 'assistant', content: conv.content });
    }
    // 裁剪口径外置为纯函数（context-compaction.ts），使回归能直接跑真实现而非复刻判据
    const { kept, dropped } = truncateHistoryTail(replay, CTX_HISTORY_TAIL_MAX_CHARS);
    if (dropped > 0) {
      messages.push({ role: 'system', content: `[历史截断] 早期 ${dropped} 条对话超出历史预算已省略（保留最近 ${kept.length} 条）；确需细节请针对性 read_file 或查看任务详情。` });
    }
    for (const m of kept) messages.push(m);
  }
  return { messages, projectCtx, summaryOnly, lessonsIds };
}
