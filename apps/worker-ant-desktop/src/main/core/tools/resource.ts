/**
 * zx_20260920_1 M1（庄子·无用之用 / 金刚经·不住相）: 由 `agent-executor.ts` 的 `buildTools()`
 * **机械搬迁**而来——工具体**逐字节未改**，只把原来靠外层闭包取到的名字，改为从 `deps` 解构。
 * 搬迁纪律：**工具名 / 参数 schema / execute 行为 / 返回形状一律不动**；此处不新增、不删除任何工具。
 * 依赖面（6 项）由 `ToolDeps` 声明式给出，不再依赖隐式闭包。
 */
import type { ToolDeps } from './deps.js';
import { enqueueJob } from '../job-enqueuer.js';
import { jsonSchema } from 'ai';
import { createLogger } from '../logger.js';
import { parseDepIds } from '../dep-graph.js';
import { resolveTaskMilestoneLink, writeMilestoneDone, backfillBoardRemainderToSelf, selfCompleteBan, buildChildContext, resolveAncestorSchemeRef, classifyChildCompletion, childCompletionCheckLabel, milestoneBoardOwner, goalDeviationCapReached, isPlanOrImplTask, milestoneSubjectVerdict, MAX_CHILD_BREADTH, MAX_TASK_DEPTH, countActiveChildren, childBreadthRefusal, collectAncestorIds, collectSubtreeIds } from '../task-accounting.js';
// zx_20260930 M9: ANS 服务器地址取**一处真源** `resolveAnsCreds`（与签名请求同一条出路）。
// zx_20260930 M10: `find_mcp_service` 要读 ANS 注册表 ⇒ 到 ANS 的请求走**唯一出路** `ansSignedRequest`。
import { resolveAnsCreds, ansSignedRequest, ansFailureNote } from '../ans-signed-request.js';
// zx_20261002 M11: 项目调用记账——MCP 调用的**唯一写点**（连接池无 db/项目上下文，故记在调用方）。
import { recordServiceCall } from '../service-call-ledger.js';
// zx_20261030_2 M3（孙子·知彼知己）: 「等」的暂停因直接取词表常量，不在工具里手抄字符串。
import { PAUSE_REASON_CHILDREN_INCOMPLETE } from '../pause-reason.js';
// zx_20261105_1 M4：子代理结构化结论的唯一读点（与父侧简报同源）。
import { readSubagentResult, isSubagentTaskContext } from '../subagent-result.js';
// zx_20261105_1 M7：判据候选（纯函数）+ 上下文合并写口（候选只登记、不冒充用户判据）。
import { suggestCriteriaFromText, PROPOSED_ACCEPTANCE_KEY } from '../acceptance-check.js';
import { mergeTaskContext } from '../context-merge.js';
// zx_20261106_1 M3：子任务判据来源随上下文落库（模型给的标 model、留空标 missing、辩论/角色标 intentional_empty）。
import { withAcceptanceSource } from '../task-decompose.js';

const logger = createLogger('tools-resource');

/**
 * zx_20261105_1 M8（道德经·少则得 / 维特根斯坦·意义即用法）：同题面在途子任务复用，不重派。
 *
 * 归一化只做三件**可判**的事：去 `[Sub] ` 前缀、去 `（第 N 次）` 次数后缀、折叠空白。
 * 不猜同义、不合并不同题面——「同一题面」= 归一化后字面相等。
 * 终态取与 `children-gate`/`await_subagents` 同一口径（非 completed/failed/archived 皆算在途），
 * 不另抄一份在途状态清单。
 */
export const SUBAGENT_REPEAT_LIMIT = 3;
const TERMINAL_TASK_STATUSES = new Set(['completed', 'failed', 'archived']);

export function normalizeSubagentTitle(raw: string | null | undefined): string {
  return String(raw ?? '')
    .replace(/^\[Sub\]\s*/i, '')
    .replace(/[（(]第\s*\d+\s*次[)）]\s*$/u, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function resourceTools(deps: ToolDeps) {
  const { ctx, db, taskId, projectId, workingDir, ensureSkillsLoaded } = deps;
  return {
    find_best_model: {
      description: '查找最优模型。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: { capabilities: { type: 'string', description: '能力，逗号分隔，如 chat,embedding（可选）' } },
        required: [],
      }),
      execute: async (args: { capabilities?: string }) => {
        try {
          const ansClient = await ctx.getAnsClient();
          const caps = args.capabilities ? args.capabilities.split(',').map(s => s.trim()) : ['chat'];
          const m = await ansClient.getOptimalModel({ capabilities: caps, strategy: 'balanced' }) as Record<string, unknown>;
          return JSON.stringify({ model_name: m.model_name, model_id: m.model_id });
        } catch { return JSON.stringify({ error: '无可用模型' }); }
      },
    },
    spawn_subagent: {
      description: '将独立子任务分派给子Agent执行。子Agent独立上下文窗口，仅返回摘要给父Agent。可用类型: deploy(部署配置)/explorer(探索)/builder(构建)/verifier(验证)。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          prompt: { type: 'string', description: '子Agent的完整任务描述，包含期望产出' },
          taskTitle: { type: 'string', description: '子任务的简短标题' },
          agentType: { type: 'string', description: '子Agent类型: deploy/explorer/builder/verifier（可选）' },
          dependsOn: { type: 'string', description: '前置任务ID（多个用逗号分隔，可选）。有前置时子Agent不立即派发，待全部前置完成后由调度器自动启动。注意：若某前置已 failed/归档或已暂停（暂停的前置不会自动解锁，因等子任务而暂停者除外），则不会自动启动，须人工处置' },
          acceptance_criteria: { type: 'string', description: '该子任务的验收标准（逐条写，可判定为准）；留空则收口时如实记为「未设验收标准」而非默认通过（可选）' },
          allow_duplicate: { type: 'boolean', description: '同一父任务下同题面终态副本已达上限时仍要再派，显式传 true（默认 false）。只解除终态副本上限；同题面在途一律复用、不重派（可选）' },
        },
        required: ['prompt', 'taskTitle'],
      }),
      execute: async (args: { prompt: string; taskTitle: string; agentType?: string; dependsOn?: string; acceptance_criteria?: string; allow_duplicate?: boolean }) => {
        const parentCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
        const childDepth = (parentCtx.depth as number || 0) + 1;
        // zx_20260916_3 M1（D2 裁定：统一为 5）：原为 2 —— 与 create_task 的 5 是**同名同义两值**
        //（"嵌套深度"在两个出口被两样地用）。且 `childDepth > 2` 使任何 depth≥2 的任务调本工具必被拒
        //（2+1=3 > 2），本路径近乎不可用。现与 create_task 共用 MAX_TASK_DEPTH 一处真源。
        if (childDepth > MAX_TASK_DEPTH) return JSON.stringify({ error: `已达到最大嵌套深度(${MAX_TASK_DEPTH}层)，请直接完成当前子任务。` });
        // zx_20260916_3 M1（D1 裁定：全覆盖）：本工具**也**让任务树变宽，原先**无**广度闸——
        // 真库 3 个父任务达 6 个子、第 6 个一律是 `[Sub]` 前缀，即由此路绕过上限（E-①）。
        const breadthRefusal = childBreadthRefusal(db, taskId);
        if (breadthRefusal) return JSON.stringify({ error: breadthRefusal });
        // 从子Agent注册表读取类型配置（maxSteps/systemPrompt/工具白名单）
        let subagentTypeCfg: { maxSteps?: number; systemPrompt?: string; allowTools?: string[]; denyTools?: string[] } = {};
        if (args.agentType) {
          try {
            const { getSubagentType } = await import('../subagent-registry.js');
            subagentTypeCfg = getSubagentType(args.agentType) || {};
          } catch {}
        }
        // zx_20260911_3 M2a(知行合一): 子 agent 与 create_task 同一事实源——关联须上溯祖先链，否则同样丢 scheme_ref
        const subagentSr = resolveAncestorSchemeRef(db, taskId);
        const subagentCtx: Record<string, unknown> = withAcceptanceSource(
          { type: 'subagent', depth: childDepth, subagentType: args.agentType || null, maxSteps: subagentTypeCfg.maxSteps || null, systemPrompt: subagentTypeCfg.systemPrompt || null, allowTools: subagentTypeCfg.allowTools || null, denyTools: subagentTypeCfg.denyTools || null },
          // zx_20261106_1 M3：判据来源 —— 模型给了标 model，留空标 missing（候选判据只是候选，不算已设）。
          (args.acceptance_criteria || '').trim() ? 'model' : 'missing',
        );
        if (subagentSr) subagentCtx.scheme_ref = subagentSr;
        const id = crypto.randomUUID();
        const depIds = parseDepIds(args.dependsOn);
        // zx_20261105_1 M8：查-建在同一事务内串行（并发双派只落一行）。
        //   reused 优先于上限判定：有在途同题面就复用它，不再造副本；终态同题面才计次。
        const normalizedTitle = normalizeSubagentTitle(args.taskTitle);
        const decision = db.transaction((): {
          reusedId?: string; reusedStatus?: string; refused?: string; repeatIndex: number; created: boolean;
        } => {
          const siblings = db.prepare(
            'SELECT id, title, status FROM wa_tasks WHERE parent_task_id = ? ORDER BY created_at ASC',
          ).all(taskId) as Array<{ id: string; title: string | null; status: string }>;
          const same = normalizedTitle
            ? siblings.filter((s) => normalizeSubagentTitle(s.title) === normalizedTitle)
            : [];
          const inFlight = same.find((s) => !TERMINAL_TASK_STATUSES.has(s.status));
          if (inFlight) return { reusedId: inFlight.id, reusedStatus: inFlight.status, repeatIndex: 0, created: false };
          const terminalCount = same.filter((s) => TERMINAL_TASK_STATUSES.has(s.status)).length;
          if (terminalCount >= SUBAGENT_REPEAT_LIMIT && !args.allow_duplicate) {
            return {
              refused: `同一父任务下该题面已有 ${terminalCount} 个终态子任务（上限 ${SUBAGENT_REPEAT_LIMIT}）。`
                + '请说明与既往的差异、换个题面，或显式传 allow_duplicate:true。',
              repeatIndex: 0,
              created: false,
            };
          }
          const repeatIndex = terminalCount + 1;
          const title = repeatIndex > 1 ? `[Sub] ${args.taskTitle}（第 ${repeatIndex} 次）` : `[Sub] ${args.taskTitle}`;
          const ctx = repeatIndex > 1 ? { ...subagentCtx, subagent_repeat_index: repeatIndex } : subagentCtx;
          db.prepare(
            "INSERT INTO wa_tasks (id, project_id, title, description, status, priority, context_json, parent_task_id, source, depends_on, acceptance_criteria) VALUES (?, ?, ?, ?, 'pending', 1, ?, ?, 'agent', ?, ?)"
          ).run(id, projectId, title, args.prompt, JSON.stringify(ctx), taskId, depIds.join(','), (args.acceptance_criteria || '').trim());
          return { repeatIndex, created: true };
        })();
        if (decision.reusedId) {
          return JSON.stringify({
            taskId: decision.reusedId,
            reused: true,
            status: decision.reusedStatus,
            hint: '已存在同名在途子任务，已复用（未重复派发）。要等它到站请调用 await_subagents。',
          });
        }
        if (decision.refused) {
          return JSON.stringify({ error: 'duplicate_subagent_limit', message: decision.refused });
        }
        // zx_20261105_1 M7：无用户判据时登记候选（合并写，保留 subagentType/allowTools 等兄弟键）。
        const suggestedCriteria = (args.acceptance_criteria || '').trim()
          ? [] : suggestCriteriaFromText(args.taskTitle, args.prompt);
        if (suggestedCriteria.length > 0) {
          mergeTaskContext(db, id, { [PROPOSED_ACCEPTANCE_KEY]: suggestedCriteria });
        }
        // zx_20260913 M3-3(同一把尺): 有前置则不立即派发——与 create_task 同法，解锁**只**经 getReadyTasks 一条路
        if (depIds.length === 0) {
          enqueueJob(db, 'ai-task', { taskId: id, projectId, source: 'subagent', message: args.prompt });
        }
        return JSON.stringify({
          subTaskId: id,
          status: depIds.length > 0 ? 'created_pending_deps' : 'dispatched',
          agentType: args.agentType || null,
          ...(decision.repeatIndex > 1 ? { repeatIndex: decision.repeatIndex } : {}),
          ...(suggestedCriteria.length > 0 ? {
            suggestedCriteria,
            criteriaHint: '以上为**候选**判据（未采用）——须由人在任务详情点「采用」后才写入验收标准。',
          } : {}),
          hint: depIds.length > 0
            ? '已创建（pending）——前置完成前不会派发；前置完成后调度器自动启动。若某前置已 failed/归档或已暂停（暂停的前置不会自动解锁，因等子任务而暂停者除外），则不会自动启动，须人工处置。'
            : '子Agent将独立执行，完成后父任务自动恢复。要在此刻停下来等它，调用 await_subagents（不要用 list_agents 反复轮询）。',
        });
      },
    },
    // zx_20261030_2 M3（孙子·知彼知己 / 道德经·知止）: 父要等子，须有可表达的「等」。
    //   病根：只有 list_agents（看），没有 await（等）⇒ 父五次「看」子仍在跑，落成工具循环暂停。
    //   等 ≠ 失败，也 ≠ 轮询：有在跑的子就置 paused（因 children_incomplete，不传 note ⇒ 不推 IM），
    //   子全部到站由既有 checkParentTaskAfterChildDone 自动恢复；一个未完成子都没有 ⇒ 拒绝执行且不暂停；
    //   未完成子已全 paused ⇒ 也不自行等待（父此刻在跑，把事实交还它处置，避免"暂停—唤醒—再暂停"热环）。
    await_subagents: {
      description: '等待本任务派出的子Agent全部到站。有在跑的子时本任务进入暂停（因 children_incomplete），它们全部结束后自动恢复；没有未完成子时不暂停、直接返回。等待请用本工具，不要用 list_agents 反复轮询。',
      parameters: jsonSchema({ type: 'object' as const, properties: {}, required: [] }),
      execute: async (args: Record<string, unknown> | undefined) => {
        const extra = Object.keys(args ?? {});
        if (extra.length > 0) return JSON.stringify({ error: `await_subagents 不接受参数（收到：${extra.join(', ')}）` });
        const unfinished = db.prepare(
          "SELECT id, status FROM wa_tasks WHERE parent_task_id = ? AND status NOT IN ('completed','failed','archived') ORDER BY created_at ASC",
        ).all(taskId) as Array<{ id: string; status: string }>;
        // zx_20261105_1 M4：等待回执带上**已到站子代理**的结构化结论——父醒来即知"过了没有、凭什么、哪里没跑成"。
        //   只投影子代理（普通子任务不带该段）；缺失 ⇒ `unprovided` + 人话「未提供结构化结论」，绝不补 pass。
        const allKids = db.prepare(
          'SELECT id, status, context_json FROM wa_tasks WHERE parent_task_id = ? ORDER BY created_at ASC',
        ).all(taskId) as Array<{ id: string; status: string; context_json: string | null }>;
        const subagentResults = allKids
          .filter((k) => isSubagentTaskContext(k.context_json))
          .slice(0, 10)
          .map((k) => {
            const r = readSubagentResult(k.context_json);
            return {
              taskId: k.id,
              status: k.status,
              verdict: r?.verdict ?? 'unprovided',
              summary: r?.summary || '未提供结构化结论',
              limitations: r?.limitations ?? [],
            };
          });
        if (unfinished.length === 0) {
          return JSON.stringify({ status: 'nothing_to_wait', count: 0, subagentResults, hint: '当前没有在运行的子任务；请直接继续或收口。' });
        }
        const running = unfinished.filter((k) => k.status !== 'paused');
        if (running.length === 0) {
          return JSON.stringify({
            status: 'all_paused', count: unfinished.length, subagentResults,
            hint: `有 ${unfinished.length} 个未完成子任务，且已全部暂停——本任务不再自行等待。请逐个查看其状态并决定：恢复、修复或归档。`,
          });
        }
        const res = deps.pauseTask(db, { taskId, reason: PAUSE_REASON_CHILDREN_INCOMPLETE });
        if (!res.changed) {
          return JSON.stringify({
            status: 'not_paused', count: running.length, subagentResults,
            hint: '任务当前状态不接受再次暂停（可能已结束或被人工处置）；请直接按其状态收口。',
          });
        }
        return JSON.stringify({
          status: 'waiting', count: running.length, subagentResults,
          hint: `已暂停等待 ${running.length} 个子任务；它们全部到站后本任务自动恢复。`,
        });
      },
    },
    spawn_debate: {
      description: '启动辩论模式：多视角并行分析同一问题，汇总结果。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          question: { type: 'string', description: '辩论的问题' },
          perspectives: { type: 'string', description: '视角列表，逗号分隔，如 optimistic,pessimistic,neutral' },
        },
        required: ['question', 'perspectives'],
      }),
      execute: async (args: { question: string; perspectives: string }) => {
        const perspectives = args.perspectives.split(/[,，]/).map(s => s.trim()).filter(Boolean).slice(0, 5);
        const tasks: Array<{ taskId: string; perspective: string }> = [];
        const skipped: string[] = [];
        for (const p of perspectives) {
          // zx_20260916_3 M1（D1 全覆盖）：引擎自发建子同样受理于广度闸；闸满即**停建**并如实登记，
          // 不静默突破（新子任务落 'pending' 即计入在途，故逐条调用即天然把同批已建者算进去）。
          if (childBreadthRefusal(db, taskId)) { skipped.push(p); continue; }
          const id = crypto.randomUUID();
          // acceptance_criteria 显式留空：辩视角子任务的"验收"由父任务的 decide 汇总裁定，
          // 引擎在此无许诺者——写一条恒真的标准（如"给出该视角结论"）只会造出冒名的 verified=true。
          db.prepare(
            "INSERT INTO wa_tasks (id, project_id, parent_task_id, title, description, status, acceptance_criteria, context_json, source) VALUES (?, ?, ?, ?, ?, 'pending', '', ?, 'agent')"
          ).run(id, projectId, taskId, `[辩论-${p}] ${args.question.slice(0, 80)}`, `从"${p}"视角分析：${args.question}`, JSON.stringify({ depth: (JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}').depth || 0) + 1, debate: true, perspective: p, acceptance_source: 'intentional_empty' }));
          enqueueJob(db, 'ai-task', { taskId: id, projectId, source: 'debate', message: `从"${p}"视角分析：${args.question}` });
          tasks.push({ taskId: id, perspective: p });
        }
        return JSON.stringify({
          mode: 'debate', taskCount: tasks.length, tasks,
          ...(skipped.length > 0 ? { skipped, skippedReason: `槽位已满（上限 ${MAX_CHILD_BREADTH} 个在途子任务），未创建：${skipped.join('、')}` } : {}),
          hint: '辩论子任务将并行执行，完成后调用 decide 工具汇总结果',
        });
      },
    },
    recruit_swarm: {
      description: 'Swarm模式：根据目标自动组建角色团队（researcher/developer/reviewer/writer）。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: { objective: { type: 'string', description: '任务目标' } },
        required: ['objective'],
      }),
      execute: async (args: { objective: string }) => {
        const text = args.objective.toLowerCase();
        const roles: Array<{ role: string; description: string; priority: number }> = [];
        if (text.includes('分析') || text.includes('research') || text.includes('调研')) roles.push({ role: 'researcher', description: '负责深度调研和信息收集', priority: 1 });
        if (text.includes('代码') || text.includes('开发') || text.includes('实现') || text.includes('code')) roles.push({ role: 'developer', description: '负责代码实现和测试', priority: 1 });
        if (text.includes('审查') || text.includes('review') || text.includes('检查')) roles.push({ role: 'reviewer', description: '负责质量审查和安全检查', priority: 2 });
        if (text.includes('文档') || text.includes('报告') || text.includes('doc')) roles.push({ role: 'writer', description: '负责文档撰写和报告生成', priority: 2 });
        if (roles.length === 0) roles.push({ role: 'generalist', description: '通用任务执行', priority: 1 });
        const tasks: Array<{ taskId: string; role: string }> = [];
        const skipped: string[] = [];
        for (const r of roles) {
          // zx_20260916_3 M1（D1 全覆盖）：同 debate——引擎自发建子受理于同一道广度闸。
          if (childBreadthRefusal(db, taskId)) { skipped.push(r.role); continue; }
          const id = crypto.randomUUID();
          // 同 debate：角色子任务的标准由父任务 decide 汇总裁定，引擎无许诺者，显式留空不造冒名通过。
          db.prepare(
            "INSERT INTO wa_tasks (id, project_id, parent_task_id, title, description, status, priority, acceptance_criteria, context_json, source) VALUES (?, ?, ?, ?, ?, 'pending', ?, '', ?, 'agent')"
          ).run(id, projectId, taskId, `[Swarm-${r.role}] ${args.objective.slice(0, 60)}`, `角色: ${r.role}\n职责: ${r.description}\n目标: ${args.objective}`, r.priority, JSON.stringify({ depth: (JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}').depth || 0) + 1, swarm: true, role: r.role }));
          enqueueJob(db, 'ai-task', { taskId: id, projectId, source: 'swarm', message: `角色: ${r.role}\n目标: ${args.objective}` });
          tasks.push({ taskId: id, role: r.role });
        }
        return JSON.stringify({
          mode: 'swarm', roles: roles.map(r => r.role), tasks,
          ...(skipped.length > 0 ? { skipped, skippedReason: `槽位已满（上限 ${MAX_CHILD_BREADTH} 个在途子任务），未创建：${skipped.join('、')}` } : {}),
          hint: 'Swarm团队已组建，各角色子任务将并行执行，完成后调用 decide 汇总',
        });
      },
    },
    search_web: {
      description: '搜索网络获取最新信息',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          query: { type: 'string', description: '搜索关键词' },
        },
        required: ['query'],
      }),
      execute: async (args: { query: string }) => {
        try {
          const resp = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(args.query)}`, {
            signal: AbortSignal.timeout(10_000),
          });
          const html = await resp.text();
          // 简单提取文字摘要（前1000字符）
          const text = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
          return text || '无搜索结果';
        } catch (e) { return JSON.stringify({ error: (e as Error).message }); }
      },
    },
    read_web: {
      description: '抓取指定URL的网页内容并提取纯文本（用于获取网页/文档内容）。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          url: { type: 'string', description: '要抓取的URL（http/https）' },
        },
        required: ['url'],
      }),
      execute: async (args: { url: string }) => {
        if (!/^https?:\/\/.+/.test(args.url)) return JSON.stringify({ error: 'URL必须以http/https开头' });
        try {
          const resp = await fetch(args.url, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'Mozilla/5.0' } });
          const html = await resp.text();
          const text = html.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
          return text || '页面无文本内容';
        } catch (e) { return JSON.stringify({ error: `抓取失败: ${(e as Error).message.slice(0, 200)}` }); }
      },
    },
    find_mcp_service: {
      description: '查找可用的MCP服务（本项目产出物 + ANS 注册表），并列出各服务已注册的工具。先用本工具了解可用服务再用 call_mcp_tool。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: '服务名称过滤（可选，只作用于本项目产出物）' },
        },
        required: [],
      }),
      execute: async (args: { name?: string }) => {
        const q = args.name ? "AND (d.name LIKE ? OR d.name = ?)" : "";
        const params = args.name ? [`%${args.name}%`, args.name] : [];
        const mcps = db.prepare(`SELECT d.name, d.type, d.status, d.file_path FROM wa_deliverables d WHERE d.project_id = ? AND d.type = 'mcp' ${q} ORDER BY d.created_at DESC LIMIT 10`).all(projectId, ...params) as Array<{ name: string; type: string; status: string; file_path: string | null }>;
        // 通过 MCP 连接池列出每个服务的工具（缓存）
        // zx_20260929 M2: 端点与 `call_mcp_tool` **同尺**——取当前配置的 `ans_server_url`。此前不传解析器
        // ⇒ 走池内兜底常量 `ANS_DEFAULT_BASE_URL/mcp/<name>`：用户把 ANS 配到别处时，这里列的是**另一台**机器的工具。
        const ansUrl = resolveAnsCreds(db).baseUrl;
        const resolveEndpoint = async (serverName: string) => ({ name: serverName, endpoint: `${ansUrl}/mcp/${encodeURIComponent(serverName)}` });

        // zx_20260930 M10: **ANS 已注册的 MCP** 也纳入可见面。
        //   这不是"多看见几个名字"，而是把它们从**看不见**变成**用得上**——`call_mcp_tool` 一直是经 ANS 网关
        //   按**名字**调的（`${ansUrl}/mcp/<name>`），可此前 `find_mcp_service` 只列本项目 `type='mcp'`
        //   交付物 ⇒ "ANS 里注册了、但没落成本项目交付物"的服务**既列不出、也无从想到**，而它本来调得动。
        const ansByName = new Map<string, { status?: string; endpoint?: string }>();
        // 查失败**绝不静默当"没有"**：`ansNote` 如实带出去（ANS 未启动 / 401 / 超时都会走到这里，
        //   而"没查成"与"确实没有"是两件事——混成一个空列表就等于替 ANS 说了句我们并不知道的话）。
        let ansNote: string | undefined;
        {
          const r = await ansSignedRequest(resolveAnsCreds(db), '/api/v1/mcp/', { timeoutMs: 5000 });
          if (!r.ok) {
            ansNote = `ANS 注册表查询失败（${ansFailureNote(r)}）——下面只列本项目交付物，**不代表 ANS 里没有别的 MCP**`;
            logger.warn(`[find_mcp_service] ${ansNote}`);
          } else {
            const data = await r.response!.json() as { data?: Array<{ name?: string; status?: string; endpoint?: string }> };
            for (const s of data.data || []) if (s.name) ansByName.set(s.name, { status: s.status, endpoint: s.endpoint });
          }
        }

        let unknownTools = 0;
        // 探一次工具表：生产服务"在册但零工具"与"服务没起"必须**分开说**（zx_20260929 M2 的既有尺）。
        const probeTools = async (name: string): Promise<Record<string, unknown>> => {
          const got: Record<string, unknown> = {};
          try {
            const { listMcpTools } = await import('../mcp-client-pool.js');
            const info = await listMcpTools(name, { endpointResolver: resolveEndpoint });
            got.toolCount = info.tools.length;
            got.tools = info.tools.map(t => t.name);
            got.failures = info.failures;
            got.serverInfo = info.serverInfo;
          } catch (e) {
            unknownTools++;
            got.toolsUnknown = true;
            got.toolsError = (e as Error).message;
            logger.warn(`[find_mcp_service] ${name} 工具列表获取失败（服务未运行/未就绪）：${(e as Error).message}`);
          }
          return got;
        };

        const services: Array<Record<string, unknown>> = [];
        for (const m of mcps) {
          const item: Record<string, unknown> = { name: m.name, status: m.status, filePath: m.file_path };
          const reg = ansByName.get(m.name);
          if (reg) {
            item.ansRegistered = true;
            item.ansStatus = reg.status;
            ansByName.delete(m.name); // 已在上表出现 ⇒ 不再进"仅在 ANS"那一栏（否则同名两现）
          }
          Object.assign(item, await probeTools(m.name));
          services.push(item);
        }

        // ANS 注册、而本项目**没有**对应交付物的那些：单列一栏，逐条标 `notProjectDeliverable`。
        // 上限 10 条（与上表同尺）：每探一次工具表都是一次带 15s 超时的网络往返，注册表大时
        //   不能在一次工具调用里无界串行——超出部分如实报数，不悄悄截断。
        const ansOnly = [...ansByName.entries()];
        const ansRegistered: Array<Record<string, unknown>> = [];
        for (const [name, v] of ansOnly.slice(0, 10)) {
          ansRegistered.push({ name, notProjectDeliverable: true, ansStatus: v.status, ansEndpoint: v.endpoint, ...(await probeTools(name)) });
        }
        if (ansOnly.length > 10) ansRegistered.push({ note: `另有 ${ansOnly.length - 10} 个 ANS 已注册的 MCP 未列出（每次调用最多探 10 个）` });

        if (services.length === 0 && ansRegistered.length === 0) {
          // 空态也分两种：没查成 vs 确实没有（见上 `ansNote` 的说明）。
          const hint = ansNote
            ? '本项目暂无MCP服务产出物；ANS 注册表**没查成**（见 ansNote），故无法断定 ANS 里有没有可用的 MCP。'
            : '本项目暂无MCP服务产出物，ANS 注册表也确无已注册的 MCP。可用 create_deliverable(type="mcp") 创建。';
          return JSON.stringify({ services: [], hint, ...(ansNote ? { ansNote } : {}) });
        }
        return JSON.stringify({
          services,
          ...(ansRegistered.length > 0 ? { ansRegistered } : {}),
          ...(unknownTools > 0 ? { note: `${unknownTools} 个服务的工具列表**未知**（服务未运行或未就绪），不代表该服务没有工具` } : {}),
          ...(ansNote ? { ansNote } : {}),
        });
      },
    },
    call_mcp_tool: {
      description: '调用MCP服务的指定工具（通过ANS网关代理）。先用find_mcp_service了解可用服务。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          serverName: { type: 'string', description: 'MCP服务名称' },
          toolName: { type: 'string', description: '工具名称' },
          args: { type: 'string', description: '工具参数JSON（可选）' },
        },
        required: ['serverName', 'toolName'],
      }),
      execute: async (args: { serverName: string; toolName: string; args?: string }) => {
        // zx_20261002 M11: 调用账在**本处**记（`call_mcp_tool` 是全仓唯一调用 `callMcpTool` 的地方）。
        //   连接池自己没有 db/项目上下文，故成绩只能由调用方落；成败两路都要落（失败只是内存计数的病根在此除）。
        const startedAt = Date.now();
        const target = `${args.serverName}/${args.toolName}`;
        try {
          // 通过 MCP 连接池调用（工具缓存 + 断线重连 + 健康跟踪）
          // zx_20260929 M2: 端点解析器**按调用传参**（此前是进程级全局 `setEndpointResolver`，并发任务间互相覆盖）。
          const { callMcpTool } = await import('../mcp-client-pool.js');
          const ansUrl = resolveAnsCreds(db).baseUrl;
          let parsedArgs: Record<string, unknown> = {};
          if (args.args) { try { parsedArgs = JSON.parse(args.args); } catch { parsedArgs = {}; } }
          const mcpResult = await callMcpTool(args.serverName, args.toolName, parsedArgs, {
            endpointResolver: async (serverName: string) => ({ name: serverName, endpoint: `${ansUrl}/mcp/${encodeURIComponent(serverName)}` }),
          }) as { content?: Array<{ type: string; text?: string }> };
          recordServiceCall(db, { projectId, taskId, kind: 'mcp', target, operation: 'call', ok: true, durationMs: Date.now() - startedAt });
          const content = mcpResult?.content;
          if (content) return JSON.stringify(content.map(c => c.text || '').join('\n'));
          return JSON.stringify(mcpResult ?? {});
        } catch (e) {
          recordServiceCall(db, { projectId, taskId, kind: 'mcp', target, operation: 'call', ok: false, durationMs: Date.now() - startedAt, error: (e as Error).message });
          return JSON.stringify({ error: (e as Error).message });
        }
      },
    },
    list_skills: {
      description: '列出当前可用的AI技能（含名称/说明/来源分类），再用 skill 工具按名称调用。技能来源：内置(code_review/security_check) + ANS服务端插件技能 + .agents目录技能 + 记忆衍生技能(程序性记忆提炼、已批准)。',
      parameters: jsonSchema({ type: 'object' as const, properties: {}, required: [] }),
      execute: async () => {
        try {
          const { listSkills } = await import('../skill-registry.js');
          await ensureSkillsLoaded();
          return JSON.stringify(listSkills());
        } catch (e) {
          return JSON.stringify({ error: `技能列表获取异常: ${(e as Error).message}` });
        }
      },
    },
    skill: {
      description: '调用已注册的AI技能执行专项任务。技能来源：内置(code_review/security_check) + ANS服务端插件技能 + .agents目录技能 + 记忆衍生技能(程序性记忆提炼、已批准)。可用技能清单用 list_skills 查询。',
      parameters: jsonSchema({
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: '技能名称（用 list_skills 查询可用技能）' },
          input: { type: 'string', description: '技能的输入内容（代码或文本；提示词型技能可为空）' },
        },
        required: ['name'],
      }),
      execute: async (args: { name: string; input?: string }) => {
        // 从技能注册表执行（内置 + ANS + .agents 统一）
        try {
          const { executeSkill } = await import('../skill-registry.js');
          await ensureSkillsLoaded();
          return await executeSkill(args.name, args.input || '', { projectId, taskId, workingDir });
        } catch {
          return JSON.stringify({ error: `技能执行异常: ${args.name}` });
        }
      },
    },
  };
}
