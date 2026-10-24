/**
 * @layer application — 应用层 — 编排领域对象完成用例
 */
/**
 * A3: 作业处理器统一注册模块。
 * 从index.ts中提取，依赖通过参数注入。
 */
import type Database from 'better-sqlite3';
import type { AnsClient } from '@worker-ant/ans-client';
import type { TaskScheduler } from '../task-scheduler.js';
import type { MemoryManager } from '../memory-manager.js';
import { createLogger } from '../logger.js';
import { markTemplateInvalid, loadTemplatePool, autoCreateTemplatesFromSuccesses, describeAutoTemplateGates } from '../task-templates.js';
import { boolSetting } from '../settings-bool.js';
import { auxModelRequest } from '../model-request.js';
// zx_20260930 M5: 复盘的问法按**终态**分叉——判据取自 `task-terminal.ts` 一处（三处调度守卫同一个值）。
import { reviewFocus, isReviewableStatus } from '../task-terminal.js';
// zx_20260930 M8: 记忆读取谓词取**一处真源**（本文件两处曾各手抄一份 `!= 'archived'`）。
import { MEM_LIVE_SQL } from '../memory-lifecycle.js';
// zx_20261014_4 批四: 项目域知识册（**零 LLM** 派生）——与 panorama 并跑，注入侧由它取代 panorama（见 memory-context §K）。
import { deriveProjectKnowledge, upsertProjectKnowledge } from '../project-knowledge.js';
import { distillKnowledgeCards } from '../knowledge-cards.js';

interface JobDeps {
  db: Database.Database;
  ansClient: AnsClient;
  scheduler: TaskScheduler;
  memory: MemoryManager;
}

/** 注册所有后台作业处理器 */
export function registerAllJobs(deps: JobDeps): void {
  const { db, ansClient, scheduler, memory } = deps;
  const logger = createLogger('jobs');

  // ===== embed-memory: 异步生成未嵌入记忆的向量 =====
  let _embedRunning = false;
  scheduler.register('embed-memory', async () => {
    if (_embedRunning) return;
    _embedRunning = true;
    try {
      const unembedded = memory.getUnembedded(20);
      if (unembedded.length === 0) return;
      const embModel = await ansClient.getOptimalModel({ capabilities: ['embedding'] });
      if (!embModel?.url || !embModel?.api_key) {
        logger.warn('embed-memory: 无可用 embedding 模型或缺失 api_key，跳过本轮');
        return;
      }

      let failed = 0;
      for (const mem of unembedded) {
        try {
          const baseUrl = embModel.url.replace(/\/$/, '');
          // Ollama 原生 /api/embed 或已含 /embeddings 的端点直接用；OpenAI 兼容端点(url含/v1)追加 /embeddings
          const embUrl = baseUrl.includes('/api/embed') || baseUrl.includes('/embeddings')
            ? baseUrl : `${baseUrl}/embeddings`;
          const resp = await fetch(embUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${embModel.api_key}` },
            body: JSON.stringify({ model: embModel.model_name ?? 'text-embedding-3-small', input: mem.content.slice(0, 8000) }),
            signal: AbortSignal.timeout(30_000),
          });
          if (!resp.ok) {
            failed++;
            logger.warn({ memId: mem.id.slice(0, 8), status: resp.status }, 'embed-memory: 单条向量请求失败');
            continue;
          }
          const json = await resp.json() as { data?: Array<{ embedding: number[] }>; embeddings?: number[][] };
          const embedding = json.data?.[0]?.embedding || json.embeddings?.[0];
          if (embedding && embedding.length > 0) memory.updateEmbedding(mem.id, embedding);
        } catch (err) {
          failed++;
          logger.warn({ memId: mem.id.slice(0, 8), errMsg: (err as Error).message }, 'embed-memory: 单条向量生成异常');
        }
      }
      if (failed > 0) logger.warn({ failed, total: unembedded.length }, 'embed-memory: 本轮部分向量生成失败');
    } catch (err) {
      logger.error({ errMsg: (err as Error).message }, 'embed-memory: 作业执行失败');
    }
    finally { _embedRunning = false; }
  });

  // 启动后延迟处理积压 + 30分钟定期执行
  setTimeout(() => { scheduler.enqueue('embed-memory', {}).catch(() => {}); }, 3000);
  setInterval(() => { scheduler.enqueue('embed-memory', {}).catch(() => {}); }, 1_800_000);

  // ===== background-review: 任务完成后异步提取关键记忆 =====
  // zx_20260906 批2: 同任务 single-flight——ai-task 与 resume 完成路径可能各调度一次，并发执行会整批重复（≥4 次 LLM 重读同一对话）
  const bgReviewLocks = new Set<string>();
  scheduler.register('background-review', async (payload) => {
    const taskId = payload.taskId as string;
    const projectId = payload.projectId as string;
    if (!taskId || !projectId) return;
    if (bgReviewLocks.has(taskId)) return; // 已有同任务 review 在跑，跳过重复
    bgReviewLocks.add(taskId);

    try {
      // zx_20260906 批2(终核补强): 持久化幂等——已完成过 background-review(background_reviewed_at) 的任务整批不再重提
      // （in-memory single-flight 仅防本进程并发；此标记在应用重启/多轮 resume 后仍去重，避免 ≥4 次 LLM 重复读同一对话）
      // zx_20260930 M5: 本任务终态——决定 ①**要不要复盘**（终态守卫）②**复盘问什么**（成功=配方 / 失败=教训与阻塞条件）。
      //   两者同认 `task-terminal.ts` 一处，不在此另判一次。
      const reviewStatus = (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(taskId) as { status?: string } | undefined)?.status ?? null;
      if (!isReviewableStatus(reviewStatus)) return;
      const focus = reviewFocus(reviewStatus);
      // zx_20260906 批2(终核补强) 的持久化幂等——**按终态细分**（zx_20260930 M5）：
      //   原判据是"复盘过就永不复盘"。守卫放宽到含 `failed` 之后，一次"先失败、后由人恢复并完成"的任务
      //   会在**失败那一刻**用掉唯一名额 ⇒ 真正该留下来的**成功配方**永远提不出来，而 resume 路是本仓主形态、不是边角。
      //   故幂等键细到"**同一种终态**只复盘一次"：同结局重复触发仍不重复读同一对话（原保护一字不减），
      //   而"失败→成功"这种结局真的变了的情形各复盘一次——次数由结局**转变**次数封顶，**不**由 resume 轮数封顶。
      //   老行没有 `background_reviewed_status`（旧码只在 completed 盖章）⇒ 如实按 'completed' 认，不白送一次重复复盘。
      try {
        const pre = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined)?.context_json || '{}') as { background_reviewed_at?: unknown; background_reviewed_status?: unknown };
        const reviewedStatus = typeof pre.background_reviewed_status === 'string' ? pre.background_reviewed_status : 'completed';
        if (pre.background_reviewed_at && reviewedStatus === reviewStatus) return;
      } catch { /* 读取失败不阻断（以锁为准） */ }
      const convs = db.prepare(
        "SELECT role, content FROM wa_task_conversations WHERE task_id = ? ORDER BY rowid ASC LIMIT 50"
      ).all(taskId) as Array<{ role: string; content: string }>;
      if (convs.length === 0) return;

      const convText = convs.map(c => `[${c.role}] ${(c.content || '').slice(0, 300)}`).join('\n');

      // Phase 1.2: 知识图谱三元组提取（接线此前未调用的死代码）
      try { await memory.extractTriplesWithLLM(convText, projectId, taskId); } catch (err) {
        logger.warn({ taskId: taskId.slice(0, 8), errMsg: (err as Error).message }, 'background-review: 三元组提取失败');
      }

      const reviewModel = await ansClient.getOptimalModel(auxModelRequest());
      if (!reviewModel?.url || !reviewModel?.api_key || !reviewModel?.model_name) {
        logger.warn({ taskId: taskId.slice(0, 8) }, 'background-review: 无可用 chat 模型，跳过');
        return;
      }

      const { generateText } = await import('ai');
      const { createSafeProvider } = await import('../ai-provider.js');
      const provider = createSafeProvider({ baseURL: reviewModel.url, apiKey: reviewModel.api_key });
      // zx_20260930 M5: 提取的**问法**按终态分叉——失败任务要的是"教训与阻塞条件"
      //   （失败因 / 卡在什么条件上 / 下次怎么做），而不是泛泛的"关键记忆"。
      //   输出 JSON 形状两路**同形**，下方解析/落库一字未改。
      const extractAsk = focus === 'lessons'
        ? '从以下任务对话中提取最多3条**失败教训**。每条<=200字。要点：① 失败/中止的**直接原因**（现象背后到底是什么）；② 卡在什么**条件**上（缺什么才能继续）；③ 下次遇到同类任务该**怎么做**（一句可行动的指引，不要复述已发生的事）。'
        : '从以下任务对话中提取最多3条关键记忆。每条记忆<=200字。';
      const result = await generateText({
        model: provider(reviewModel.model_name),
        messages: [{
          role: 'user',
          content: `${extractAsk}\n\n对话:\n${convText.slice(0, 3000)}\n\n输出JSON: {"memories": [{"content": "...", "type": "episodic|semantic|procedural", "importance": 0.0-1.0, "valence": "positive|negative|neutral"}]}\n\nvalence 语义：positive=正面经验/成功做法（方案有效、做法成功）、negative=负面教训/失败做法（试过失败、踩坑）、neutral=中性事实。${focus === 'lessons' ? '（本任务未成功，教训取 negative、客观事实取 neutral。）' : ''}`,
        }],
        maxTokens: 4000,
        temperature: 0.1,
      });
      const text = result.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.warn({ taskId: taskId.slice(0, 8), textPreview: text.slice(0, 200) }, 'background-review: LLM 返回无 JSON，无法解析记忆');
        return;
      }
      const parsed = JSON.parse(jsonMatch[0]) as { memories?: Array<{ content: string; type: string; importance: number; valence?: string }> };
      const newMemIds: string[] = [];
      for (const m of parsed.memories || []) {
        if (m.content) {
          const id = memory.storeText({
            project_id: projectId, task_id: taskId, content: m.content,
            type: m.type || 'episodic', source: 'background_review',
            // zx_20260920_1 M7-b: 提示词向模型要了 `"importance": 0.0-1.0`、类型里也声明了，
            //   但此前**这个值从不传下去** ⇒ 取回来就地丢弃，落库一律取表列默认（典型的"取了不用"）。
            //   `storeText` 侧夹取到 [0,1]；不在此夹到 ≥ 默认值——「这条不重要」是模型的合法判断。
            importance: typeof m.importance === 'number' ? m.importance : undefined,
            valence: ['positive', 'negative', 'neutral'].includes(m.valence || '') ? m.valence : 'neutral',
          });
          newMemIds.push(id);
        }
      }

      // Phase A (2026-08-27 zx_2): 评估新提取记忆的加工深度（加工水平理论+格物致知——深加工记忆更可靠）
      for (const id of newMemIds) {
        try { await memory.assessProcessingDepth(id, projectId); } catch (err) {
          logger.warn({ memId: id.slice(0, 8), errMsg: (err as Error).message }, 'background-review: 加工深度评估失败');
        }
      }

      // Phase A (2026-08-26): 任务复盘（实践论「再认识」——对比计划 vs 实际产出教训）
      try { await memory.generateTaskRetrospective(taskId, projectId); } catch (err) {
        logger.warn({ taskId: taskId.slice(0, 8), errMsg: (err as Error).message }, 'background-review: 任务复盘生成失败');
      }

      // Phase B (2026-08-27): 记忆行动转化（王阳明知行合一——判定注入记忆是否真正被应用）
      try { await memory.assessMemoryApplication(taskId, projectId); } catch (err) {
        logger.warn({ taskId: taskId.slice(0, 8), errMsg: (err as Error).message }, 'background-review: 记忆行动转化判定失败');
      }

      // zx_20260906 批2: background-review 成本可见——估算提取 token + 完成时间戳（估算，不进逐步 ANS 记账防双计）
      try {
        const rctx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined)?.context_json || '{}') as Record<string, unknown>;
        rctx.background_reviewed_at = new Date().toISOString();
        // zx_20260930 M5: 幂等键带**终态**（见文件上方守卫）——同一结局只复盘一次，结局变了才再复盘。
        rctx.background_reviewed_status = reviewStatus;
        rctx.bg_review_usage = { estTokens: Math.max(1, Math.round(convText.length / 4)), via: 'background-review:cost-optimal', note: `三元组+记忆提取+加工深度+复盘(${focus === 'lessons' ? '失败教训' : '成功配方'})+行动转化` };
        db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(rctx), taskId);
      } catch { /* 记账 best-effort */ }
    } catch (err) {
      logger.error({ taskId: taskId.slice(0, 8), projectId: projectId.slice(0, 8), errMsg: (err as Error).message }, 'background-review: 关键记忆提取失败');
    } finally {
      bgReviewLocks.delete(taskId);
    }
  });

  // ===== consolidate-memories: 每小时记忆巩固（去重+冲突解决+Ebbinghaus衰减+忘却归档） =====
  scheduler.register('consolidate-memories', async () => {
    try {
      // zx_20260930 M8: 两处读取谓词改引**同一份** `MEM_LIVE_SQL`——手抄 `!= 'archived'` 者必漏 `'deleted'`，
      //   而漏项在这里的后果是「只剩下墓碑的僵尸项目」也被拉进来做一整轮 LLM 巩固。
      const projects = db.prepare(`SELECT DISTINCT project_id FROM wa_memories WHERE ${MEM_LIVE_SQL}`).all() as Array<{ project_id: string }>;
      if (projects.length === 0) return;
      // zx_20260908 A2 (为道日损·知止): 闲置项目(近 N 天无任务/记忆活动)跳过 LLM 密集巩固 Phase——该省的省；
      // 非 LLM 卫生(runConsolidationPipeline Ebbinghaus 遗忘/归档/prune/聚类/自动晋升/升级)保留，不损伤记忆卫生。
      // memory.consolidation_idle_skip 开关(默认 true；'0'=关闭=现行为)。空转留痕：跳过即 WARN 记一次(可观察)。
      let recentProjects = projects;
      try {
        const idleCfg = db.prepare("SELECT value FROM wa_settings WHERE key = 'memory.consolidation_idle_skip'").get() as { value?: string } | undefined;
        if (boolSetting(idleCfg?.value)) {
          const idleDays = 7;
          const cutoffMs = Date.now() - idleDays * 86_400_000;
          const actRows = db.prepare(
            `SELECT p.id AS project_id,
                    (SELECT MAX(t.updated_at) FROM wa_tasks t WHERE t.project_id = p.id) AS last_task,
                    (SELECT MAX(m.updated_at) FROM wa_memories m WHERE m.project_id = p.id AND m.${MEM_LIVE_SQL}) AS last_mem
             FROM wa_projects p WHERE p.id IN (${projects.map(() => '?').join(',')})`
          ).all(...projects.map((p) => p.project_id)) as Array<{ project_id: string; last_task: string | null; last_mem: string | null }>;
          const activeSet = new Set<string>();
          for (const r of actRows) {
            const lu = Math.max(
              r.last_task ? new Date(r.last_task.replace(' ', 'T') + 'Z').getTime() : 0,
              r.last_mem ? new Date(r.last_mem.replace(' ', 'T') + 'Z').getTime() : 0,
            );
            if (lu >= cutoffMs) activeSet.add(r.project_id);
          }
          recentProjects = projects.filter((p) => activeSet.has(p.project_id));
          if (recentProjects.length !== projects.length) {
            logger.info({ idleSkipped: projects.length - recentProjects.length, windowDays: idleDays }, 'consolidate: 闲置项目跳过 LLM 巩固 Phase(为道日损)');
          }
        }
      } catch (err) {
        logger.warn({ errMsg: (err as Error).message }, 'consolidate: 闲置项目判定失败(回退全部执行)');
      }
      let total = { deduped: 0, conflicts: 0, forgotten: 0, challenged: 0, pruned: 0 };
      for (const { project_id } of projects) {
        const r = memory.runConsolidationPipeline(project_id);
        total.deduped += r.deduped;
        total.conflicts += r.conflicts;
        total.forgotten += r.forgotten;
        total.challenged += r.challenged;
        total.pruned += r.pruned;
      }
      // Phase (2026-08-31): 记忆辩证扬弃——效价冲突对 LLM 正反合升华（黑格尔辩证法·否定之否定）
      let totalSublated = 0;
      for (const { project_id } of recentProjects) {
        try { totalSublated += await memory.dialecticalSublateMemories(project_id); } catch (err) {
          logger.warn({ projectId: project_id.slice(0, 8), errMsg: (err as Error).message }, 'consolidate: 辩证扬弃失败');
        }
      }
      if (totalSublated > 0) logger.info({ sublated: totalSublated }, '记忆辩证扬弃完成');
      // Phase 2.2: 家族相似性聚类——Jaccard关联相似记忆
      let totalLinked = 0;
      for (const { project_id } of projects) {
        try { totalLinked += memory.clusterSimilarMemories(project_id).linked; } catch (err) {
          logger.warn({ projectId: project_id.slice(0, 8), errMsg: (err as Error).message }, 'consolidate: 家族聚类失败');
        }
      }

      // Phase 3.1: 间隔重复——高价值记忆按递增间隔重放强化（LLM 校验，成本低）
      let totalSpaced = 0;
      for (const { project_id } of recentProjects) {
        try { totalSpaced += await memory.spacedRepetition(project_id); } catch (err) {
          logger.warn({ projectId: project_id.slice(0, 8), errMsg: (err as Error).message }, 'consolidate: 间隔重复失败');
        }
      }
      if (totalSpaced > 0) {
        logger.info({ reinforced: totalSpaced }, '间隔重复强化完成');
      }

      // Phase 3.1: 星星之火——标记跨项目通用智慧
      try {
        // A1b (2026-09-08): 自动晋升补写 exemplar_type='good'——此前只置 is_exemplar 不写 exemplar_type，
        // 消费方 getExemplars(type='good') 过滤永不命中 → 晋升行死路不进 §3 注入(实库 is_exemplar 2 行 type 全空实证)
        const exemplarResult = db.prepare(
          "UPDATE wa_memories SET is_exemplar = 1, exemplar_type = 'good' WHERE use_count >= 5 AND valence = 'positive' AND memory_type IN ('semantic', 'procedural') AND is_exemplar = 0"
        ).run();
        if (exemplarResult.changes > 0) {
          logger.info({ newExemplars: exemplarResult.changes }, '新增通用智慧(exemplar)');
        }
      } catch (err) {
        logger.warn({ errMsg: (err as Error).message }, 'consolidate: 范例标记失败');
      }

      // Phase A: 情景→语义抽象化（统计预筛 success_count≥3 + LLM 精炼蒸馏规则）
      // zx_20261002 M9-②（缘起－夏克特·错误归因）：**必须压在下面的 `use_count>=3` 改型之前**。
      //   两把尺量同一批行，而下面那把会把行**移出本闸的域**：`success_count` 只在「本次真用上且成功」时
      //   +1，而「本次用上」必然已 `recordAccess`（`use_count` +1）⇒ 恒有 `use_count >= success_count`
      //   ⇒ **凡够本闸（success_count>=3）的 episodic，必先够改型闸（use_count>=3）**。旧序先改型后抽象
      //   ⇒ 候选被 100% 搬走、本闸在真库恒空转（真库 episodic=2 且 success_count 全 0；另有 4 处
      //   `memory_type='archived'` 改型把累计计数带出活集）。先抽象再改型，两闸各取所需、互不吃掉。
      let totalAbstracted = 0;
      for (const { project_id } of recentProjects) {
        try { totalAbstracted += await memory.abstractSemanticKnowledge(project_id); } catch (err) {
          logger.warn({ projectId: project_id.slice(0, 8), errMsg: (err as Error).message }, 'consolidate: 情景→语义抽象失败');
        }
      }
      if (totalAbstracted > 0) {
        logger.info({ abstracted: totalAbstracted }, '情景→语义抽象完成');
      }

      // Phase 2.3: 情景→语义升级（episodic使用>=3次自动升级为semantic）
      // ⚠ 须在 Phase A 抽象**之后**跑：本句会把行改型成 `semantic`，从而移出抽象闸的 `memory_type='episodic'` 域。
      try {
        const upgradeResult = db.prepare(
          "UPDATE wa_memories SET memory_type = 'semantic' WHERE memory_type = 'episodic' AND use_count >= 3"
        ).run();
        if (upgradeResult.changes > 0) {
          logger.info({ upgraded: upgradeResult.changes }, 'episodic→semantic升级');
        }
      } catch (err) {
        logger.warn({ errMsg: (err as Error).message }, 'consolidate: 情景→语义升级失败');
      }

      // Phase A (2026-08-26): 程序性记忆→技能草案提取（success_count≥3 + LLM 编译，半自动待审批）
      let totalSkills = 0;
      for (const { project_id } of recentProjects) {
        try { totalSkills += await memory.extractProceduralSkills(project_id); } catch (err) {
          logger.warn({ projectId: project_id.slice(0, 8), errMsg: (err as Error).message }, 'consolidate: 程序性记忆→技能提取失败');
        }
      }
      if (totalSkills > 0) {
        logger.info({ extracted: totalSkills }, '程序性记忆→技能草案提取完成');
      }

      // Phase C (2026-08-26): 记忆再巩固（新证据修订旧记忆，相似非冲突对）
      let totalReconsolidated = 0;
      for (const { project_id } of recentProjects) {
        try { totalReconsolidated += await memory.reconsolidateMemories(project_id); } catch (err) {
          logger.warn({ projectId: project_id.slice(0, 8), errMsg: (err as Error).message }, 'consolidate: 记忆再巩固失败');
        }
      }
      if (totalReconsolidated > 0) {
        logger.info({ reconsolidated: totalReconsolidated }, '记忆再巩固完成');
      }

      // Phase A (2026-08-27): 记忆整合成体系（高价值记忆综合为项目知识全景）
      let totalPanorama = 0;
      for (const { project_id } of recentProjects) {
        try { if (await memory.synthesizeProjectKnowledge(project_id)) totalPanorama++; } catch (err) {
          logger.warn({ projectId: project_id.slice(0, 8), errMsg: (err as Error).message }, 'consolidate: 记忆整合成体系失败');
        }
      }
      if (totalPanorama > 0) {
        logger.info({ synthesized: totalPanorama }, '记忆整合成体系完成');
      }

      // Phase A (zx_20261014_4 批四): 项目域知识册（**零 LLM** 派生——四类真源直接成册）。
      //   与上面的 panorama **并跑**（后者保留、界面仍可见）；差别在**消费**：panorama 的注入段已移除，
      //   由本册取代（§批五）——"为学日益，为道日损"：不靠 LLM 每轮重写，只从既有事实**派生**。
      //   ⚠ 与 panorama 不同，本支**无门槛、无 LLM、无失败面**（除库读写外不可能失败）⇒ 不必"候选不足 return null"。
      let totalKnowledge = 0;
      let totalCards = 0;
      for (const { project_id } of recentProjects) {
        try {
          totalKnowledge += upsertProjectKnowledge(db, project_id, deriveProjectKnowledge(db, project_id));
          // zx_20261023_5 批二「省」: 蒸馏卡随册同轮重算（社区档在函数内的 Pro 闸处直接返零，不写库）。
          totalCards += distillKnowledgeCards(db, project_id).cards;
        } catch (err) {
          logger.warn({ projectId: project_id.slice(0, 8), errMsg: (err as Error).message }, 'consolidate: 域知识册派生失败');
        }
      }
      if (totalKnowledge > 0) {
        logger.info({ sections: totalKnowledge }, '项目域知识册派生完成');
      }
      if (totalCards > 0) {
        logger.info({ cards: totalCards }, '项目知识卡蒸馏完成');
      }

      // Phase A (2026-08-27): 记忆缘起条件（空性·缘起性空——高价值记忆提取适用条件+稳定性分级）
      let totalApplicability = 0;
      for (const { project_id } of recentProjects) {
        try {
          const candidates = db.prepare(
            "SELECT id FROM wa_memories WHERE project_id = ? AND memory_type IN ('semantic','procedural') AND importance >= 0.6 AND (context_json NOT LIKE '%\"applicability\"%') ORDER BY importance DESC LIMIT 10",
          ).all(project_id) as Array<{ id: string }>;
          for (const c of candidates) {
            if (await memory.extractApplicabilityConditions(c.id, project_id)) totalApplicability++;
          }
        } catch (err) {
          logger.warn({ projectId: project_id.slice(0, 8), errMsg: (err as Error).message }, 'consolidate: 记忆缘起条件提取失败');
        }
      }
      if (totalApplicability > 0) {
        logger.info({ extracted: totalApplicability }, '记忆缘起条件提取完成');
      }

      // Phase C (2026-08-27): 自我设限信念识别（王阳明·破心中贼——从失败任务提取自我设限假设）
      let totalBeliefs = 0;
      for (const { project_id } of recentProjects) {
        try { totalBeliefs += await memory.extractLimitingBeliefs(project_id); } catch (err) {
          logger.warn({ projectId: project_id.slice(0, 8), errMsg: (err as Error).message }, 'consolidate: 自我设限信念提取失败');
        }
      }
      if (totalBeliefs > 0) {
        logger.info({ extracted: totalBeliefs }, '自我设限信念提取完成');
      }

      if (total.deduped + total.conflicts + total.forgotten + total.challenged + total.pruned > 0) {
        logger.info({ ...total, projects: projects.length }, '记忆巩固完成');
      }
    } catch (err) {
      logger.error({ errMsg: (err as Error).message }, 'consolidate: 记忆巩固作业失败');
    }
  });

  // Phase 1.1: 调度consolidate-memories每小时执行一次（启动后延迟5分钟首跑）
  setTimeout(() => { scheduler.enqueue('consolidate-memories', {}).catch(() => {}); }, 300_000);
  setInterval(() => { scheduler.enqueue('consolidate-memories', {}).catch(() => {}); }, 3_600_000);

  // ===== A2 (2026-08-31): consolidate-templates 模板巩固（成功率追踪 + 失效精简，为道日损） =====
  scheduler.register('consolidate-templates', async () => {
    try {
      // 统计模板成功率（按 template id 分组，只统计父任务 parent_task_id=''，子任务的成功不代表模板整体成功）
      const stats = db.prepare(`
        SELECT json_extract(context_json, '$.template') as tpl_id,
               COUNT(*) as total,
               SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as success
        FROM wa_tasks
        WHERE context_json LIKE '%"auto_decomposed":true%' AND parent_task_id = '' AND status IN ('completed','failed')
        GROUP BY tpl_id
      `).all() as Array<{ tpl_id: string | null; total: number; success: number }>;
      let invalidated = 0;
      let disabled = 0;
      for (const s of stats) {
        if (!s.tpl_id || s.total < 3) continue;
        const rate = s.success / s.total;
        if (rate >= 0.3) continue;
        // B2: 自定义模板 → 持久化 status=disabled（可在模板管理界面重新启用）；系统模板 → 内存失效
        const tpl = db.prepare('SELECT source FROM wa_task_templates WHERE id = ?').get(s.tpl_id) as { source: string } | undefined;
        if (tpl && tpl.source === 'user') {
          db.prepare("UPDATE wa_task_templates SET status = 'disabled', updated_at = datetime('now') WHERE id = ?").run(s.tpl_id);
          loadTemplatePool(db);
          disabled++;
          logger.info({ tpl_id: s.tpl_id, total: s.total, success: s.success, rate: rate.toFixed(2) }, '自定义模板成功率过低→已禁用（可在模板管理重新启用）');
        } else {
          // B3 (2026-09-03): auto/系统模板失效也持久化（source='auto' 落库 disabled，重启不复活）
          markTemplateInvalid(db, s.tpl_id);
          loadTemplatePool(db);
          invalidated++;
          logger.info({ tpl_id: s.tpl_id, total: s.total, success: s.success, rate: rate.toFixed(2) }, '模板失效（成功率过低，auto 模板已持久化禁用；为道日损）');
        }
      }
      if (stats.length > 0) logger.info({ templates: stats.length, invalidated, disabled }, '模板巩固完成');

      // 候选模板提炼（日益）：成功拆解但非预置模板的任务，提取其子任务结构供人工审（不自动加入 TASK_TEMPLATES，避免噪声模板）
      try {
        const candidates = db.prepare(`
          SELECT p.id, p.title,
                 (SELECT COUNT(*) FROM wa_tasks c WHERE c.parent_task_id = p.id) as subCount
          FROM wa_tasks p
          WHERE p.status = 'completed'
            AND p.context_json LIKE '%"auto_decomposed":true%'
            AND p.context_json NOT LIKE '%"template":"mcp_deploy"%'
            AND p.context_json NOT LIKE '%"template":"web_app"%'
            AND p.context_json NOT LIKE '%"template":"data_analysis"%'
            AND p.context_json NOT LIKE '%"template":"doc_generation"%'
          ORDER BY p.updated_at DESC
          LIMIT 20
        `).all() as Array<{ id: string; title: string; subCount: number }>;
        if (candidates.length > 0) {
          logger.info({ candidateCount: candidates.length, sample: candidates.slice(0, 5).map(c => `${c.title}(${c.subCount}子任务)`) }, '候选模板（成功拆解非预置，供人工审提炼）');
        }
      } catch { /* 候选提炼 best-effort */ }

      // B1 (2026-09-02): 成功拆解自动生成模板（实践论第二次飞跃 + 质量门）——候选达质量门（样本≥3 成功率≥0.5）自动生成 source='auto' 模板
      // M10 (zx_20261002): 每次落一行**台账**（产出数 / 卡在哪一级 / 逐组判定）。此前只有 `autoCreated > 0` 才出话，
      //   零产出时三条 `continue` + `catch{return 0}` 全静默 ⇒ 真库恒 0 却无人知道卡在**上游**（无自动拆解任务）。
      //   质量门**一字未动**（样本≥3 / 成功率≥0.5），本行只是把判定过程如实说出来。
      try {
        const autoCreated = autoCreateTemplatesFromSuccesses(db);
        const ledger = describeAutoTemplateGates(db);
        logger.info({
          autoCreated,
          blockedAt: ledger.blockedAt,
          funnel: ledger.funnel,
          gates: ledger.gates.map(g => `${g.archetype ?? '∅'}=${g.verdict}`),
        }, 'M10 自动模板台账（产出 / 卡在哪一级 / 逐组判定）');
      } catch (err) { logger.error({ errMsg: (err as Error).message }, 'B1: 自动生成模板失败(best-effort)'); }

      // A1 (2026-08-31): 拆解模式提炼（王阳明事上磨练——从历史成功拆解提炼每类 archetype 的平均子任务数，供拆解时参考）
      // zx_20261016_3 M32（质量分入闸·拆解侧）: 同批再提炼一个 **avgQuality**（`completion_quality.score` 六维自评）。
      //   此前 patterns 只记「大约拆几个」，不记「拆得好不好」⇒ 一个反复拆坏的项目与一个拆得稳的项目，
      //   下一次拆解时被无差别参考。现并记 `{ n, avgQuality }`，读侧（`loadDecompositionPatterns`）对低分族降权。
      //   ⚠ 形状由**裸数改为对象**；旧项目 `context_json` 里仍是裸数 ⇒ 读侧须两种都认（向下兼容）。
      try {
        const parents = db.prepare(`
          SELECT p.project_id, json_extract(p.context_json, '$.archetype') as archetype,
                 (SELECT COUNT(*) FROM wa_tasks c WHERE c.parent_task_id = p.id) as subCount,
                 json_extract(p.context_json, '$.completion_quality.score') as qualityScore
          FROM wa_tasks p
          WHERE p.status = 'completed' AND parent_task_id = ''
            AND EXISTS (SELECT 1 FROM wa_tasks c WHERE c.parent_task_id = p.id)
          ORDER BY p.updated_at DESC
          LIMIT 100
        `).all() as Array<{ project_id: string; archetype: string | null; subCount: number; qualityScore: number | null }>;

        const byArchetype = new Map<string, { count: number; totalSubs: number; qSum: number; qCount: number }>();
        for (const p of parents) {
          const a = p.archetype || 'unknown';
          const e = byArchetype.get(a) || { count: 0, totalSubs: 0, qSum: 0, qCount: 0 };
          e.count++;
          e.totalSubs += p.subCount;
          if (typeof p.qualityScore === 'number' && Number.isFinite(p.qualityScore)) { e.qSum += p.qualityScore; e.qCount++; }
          byArchetype.set(a, e);
        }

        // `avgQuality` 缺记（该族无一条落过完成分）时为 `null`——不把"没记过账"读成"0 分"（承弃权纪律）。
        const patterns: Record<string, { n: number; avgQuality: number | null }> = {};
        for (const [archetype, e] of byArchetype) {
          if (e.count >= 3) {
            patterns[archetype] = { n: Math.round(e.totalSubs / e.count), avgQuality: e.qCount > 0 ? Math.round(e.qSum / e.qCount) : null };
          }
        }

        if (Object.keys(patterns).length > 0) {
          const projectIds = [...new Set(parents.map(p => p.project_id))];
          for (const pid of projectIds) {
            const proj = db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(pid) as { context_json: string } | undefined;
            if (!proj) continue;
            const ctx = JSON.parse(proj.context_json || '{}');
            ctx.decomposition_patterns = patterns;
            db.prepare('UPDATE wa_projects SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), pid);
          }
          logger.info({ patterns }, '拆解模式提炼完成');
        }
      } catch { /* 拆解模式 best-effort */ }
    } catch (err) {
      logger.error({ errMsg: (err as Error).message }, 'consolidate-templates 作业失败');
    }
  });

  // 调度：每天执行一次（启动后延迟10分钟首跑）
  setTimeout(() => { scheduler.enqueue('consolidate-templates', {}).catch(() => {}); }, 600_000);
  setInterval(() => { scheduler.enqueue('consolidate-templates', {}).catch(() => {}); }, 86_400_000);
}
