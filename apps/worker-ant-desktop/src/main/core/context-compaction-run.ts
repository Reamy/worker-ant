/**
 * zx_20261110_2 B5「损」：**上下文压缩的运行段**——从 `agent-executor.ts` 抽出（R-75a 行数额度）。
 *
 * 抽出的判据是"它是不是编排"：这里做的是"取数 → 分段问模型 → 合并 → 落边界"这一整段，
 * 执行体只该留下一句调用。抽到独立模块还有一个如实的好处：**这一段的预算/中止/回退三分**
 * （`budget` / `aborted` / `error`）与纯逻辑（`context-compaction.ts` 的分段与规则摘要）分处两文件，
 * 谁改了哪一半都读得出来。
 *
 * 与 `agent-executor.ts` 的关系：单向依赖（本模块不 import 执行体），执行体 import 本模块的
 * `compactTaskConversations`。**真源只有一份**——`rr_zx_20261110_2_finalize` 直调本模块钉边界语义。
 */
import crypto from 'node:crypto';
import type Database from 'better-sqlite3';
import { createLogger } from './logger.js';
import { createSafeProvider } from './ai-provider.js';
import { sanitizeLoneSurrogates } from './tool-guards.js';
import { estimateTokensFromChars } from './token-estimate.js';
import { planSummaryChunks, buildRuleDigest, mergeCompactionSummaries, COMPACTION_BUDGET_MS } from './context-compaction.js';

const logger = createLogger('compaction');

/** A5: 上下文压缩——用 LLM 将对话压缩为结构化摘要（maxRows 限制**单次**压缩输入规模）。
 *
 *  zx_20260911_4 M5-3（庄子·得鱼忘筌）: 此前 `slice(-maxRows)` 只摘**尾部** maxRows 条，
 *  而边界 compacted_up_to_rowid 落在整块最后一行 ⇒ 中间行被遮蔽却从未进入摘要（静默丢失）。
 *  改为按 maxRows 分段、逐段摘要后合并（`planSummaryChunks`）——"被遮蔽 ⟺ 进入摘要输入"成立；
 *  任一段未产出摘要即整体失败（fail-closed，返回 ''），边界不推进——宁可本轮不压缩，也不静默丢历史。
 *  规则回退分支同样如实（`buildRuleDigest` 逐条覆盖全部行，不再虚报省略行数）。 */
export async function compressConversations(
  apiKey: string, baseUrl: string, modelName: string,
  conversations: Array<{ role: string; content: string }>,
  maxRows: number = 40,
  // zx_20261110_2 B5「损」: 总预算截止时刻 + 本 run 的中止信号（用户按暂停即中止压缩）。
  opts?: { deadlineAt?: number; signal?: AbortSignal },
): Promise<{ ok: boolean; summary: string; degraded?: 'budget' | 'aborted' | 'error' }> {
  try {
    const { generateText } = await import('ai');
    const provider = createSafeProvider({ apiKey, baseURL: baseUrl });

    const parts: string[] = [];
    for (const chunk of planSummaryChunks(conversations, maxRows)) {
      // 总预算/中止**在每段起问前**判一次：已到点或已中止 ⇒ 不再起问，如实回因由（调用方据此不推进边界）。
      if (opts?.signal?.aborted) return { ok: false, summary: '', degraded: 'aborted' };
      const leftMs = opts?.deadlineAt != null ? opts.deadlineAt - Date.now() : 30_000;
      if (leftMs <= 0) return { ok: false, summary: '', degraded: 'budget' };
      // zx_20260911_3 M3-5: 落单半代理会让 JSON.stringify 产出非法转义 ⇒ 请求体 400（E13）。
      // 仅在**发送前**净化，落库原文不动。
      const convText = sanitizeLoneSurrogates(chunk.map(c => `[${c.role}] ${(c.content || '').slice(0, 500)}`).join('\n'));

      const compactPrompt = `你是一个上下文压缩助手。请将以下任务对话压缩为结构化摘要。

要求：
1. 保留关键推理理由、决策依据、放弃的方案及原因
2. 结构化事实——目标、已完成操作、关键发现、约束条件、待解决问题
3. 摘要总长度不超过500字
4. 直接输出摘要，不要其他内容

对话记录：
${convText}

请输出压缩结果：`;

      const result = await generateText({
        model: provider.chat(modelName),
        messages: [{ role: 'user', content: compactPrompt }],
        maxTokens: 2000,
        temperature: 0.3,
        // zx_20261110_2 B5：本段等待 = min(既有 30s 单段上限, 总预算剩余)；有中止信号则合并
        //   （`AbortSignal.any` 任一触发即断）——用户暂停能真的吹停压缩，变量名如实写"剩余"。
        abortSignal: opts?.signal
          ? AbortSignal.any([opts.signal, AbortSignal.timeout(Math.min(30_000, leftMs))])
          : AbortSignal.timeout(Math.min(30_000, leftMs)),
      });
      const part = (result.text || '').trim();
      if (part.length < 20) return { ok: false, summary: '' };
      parts.push(part);
    }
    const summary = parts.join('\n').trim();
    if (!summary) return { ok: false, summary: '' };
    logger.info({ convCount: conversations.length, chunks: parts.length, summaryLen: summary.length }, '上下文压缩完成');
    return { ok: true, summary };
  } catch (err) {
    // 因由三分：用户中止 > 总预算用尽 > 其它（其它沿用旧的规则摘要回退，调用方照旧持久化边界）。
    if (opts?.signal?.aborted) {
      logger.info({ convCount: conversations.length }, '上下文压缩因任务中止而放弃（本轮不推进压缩边界）');
      return { ok: false, summary: '', degraded: 'aborted' };
    }
    if (opts?.deadlineAt != null && Date.now() >= opts.deadlineAt) {
      logger.warn({ convCount: conversations.length, budgetMs: COMPACTION_BUDGET_MS }, '上下文压缩超出总预算，本轮不推进压缩边界');
      return { ok: false, summary: '', degraded: 'budget' };
    }
    logger.warn({ err }, '上下文压缩失败，回退到规则压缩');
    return { ok: false, summary: buildRuleDigest(conversations), degraded: 'error' };
  }
}

// ====== Phase 1.2: 会话派生上下文（模型可见即落库） ======

/** 读取任务可见对话行（rowid 有序），压缩边界之前的旧历史被遮蔽、以摘要替代。 */
function deriveConversationRows(db: Database.Database, taskId: string): {
  summary: string;
  rows: Array<{ rid: number; role: string; content: string }>;
} {
  const taskCtx = (() => { try { return JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}'); } catch { return {}; } })();
  const compactedUpTo = (taskCtx.compacted_up_to_rowid as number) || 0;
  const summary = (taskCtx.history_summary as string) || '';
  const rows = (db.prepare(
    'SELECT rowid AS rid, role, content FROM wa_task_conversations WHERE task_id = ? AND rowid > ? ORDER BY rowid ASC',
  ).all(taskId, compactedUpTo) as Array<{ rid: number; role: string; content: string }>)
    // zx_20261113_2 M12：`[压缩]` 行是 UI/审计留痕；摘要已由 `history_summary` 单独注入，
    //   再把它当普通会话行喂回模型＝同一段摘要按 resume 次数重复。此处置行仍留档，只是不进上下文。
    .filter((r) => !(r.role === 'system' && (r.content || '').startsWith('[压缩]')));
  return { summary, rows };
}

/** 估算上下文 token 数（按 4 字符/token 粗略估算，与系统提示预算一致）。 */
function estimateContextTokens(rows: Array<{ content?: string }>): number {
  return rows.reduce((s, c) => s + estimateTokensFromChars((c.content || '').length), 0);
}

/** Phase 1.1: 上下文压缩——双阈值触发，保留最近30%尾部，摘要+边界持久化（resume 不再重压）。
 *  zx_20261110_2 B5：本函数**导出**只为受控复跑直调本尊（`rr_zx_20261110_2_finalize` 钉"预算用尽 ⇒
 *  回退规则摘要且**不推进边界**"）——生产调用点仍是 `executeTask` 内那一处，导出不改变接线。 */
export async function compactTaskConversations(
  db: Database.Database, taskId: string,
  apiKey: string, baseUrl: string, modelName: string,
  contextWindow: number,
  // zx_20261110_2 B5「损」: 总预算 + 本 run 的中止信号——压缩不再是无界关键路径。
  opts?: { signal?: AbortSignal; budgetMs?: number },
): Promise<{ summary: string; recentConversations: Array<{ role: string; content: string }>; degraded?: 'budget' | 'aborted' }> {
  const { summary: existingSummary, rows } = deriveConversationRows(db, taskId);
  const cw = Number(contextWindow) > 0 ? Number(contextWindow) : 128_000;
  const estimatedTokens = estimateContextTokens(rows);

  // 触发判断：软阈值60% + 硬阈值85% + 轮数>40 + 递减收益检测
  let shouldCompact = rows.length > 40 || estimatedTokens > cw * 0.6;
  if (!shouldCompact) {
    const recentAssist = rows.filter(c => c.role === 'assistant').slice(-5);
    if (recentAssist.length >= 3 && Math.max(...recentAssist.map(c => c.content.length)) < 500) shouldCompact = true;
  }
  if (!shouldCompact || rows.length <= 15) {
    return { summary: existingSummary, recentConversations: rows.map(r => ({ role: r.role, content: r.content })) };
  }

  // 尾部保留：软阈值60%保留30%；硬阈值85%更激进保留10%（最少5条）
  const isHard = estimatedTokens > cw * 0.85;
  const tailCount = Math.max(5, Math.ceil(rows.length * (isHard ? 0.1 : 0.3)));
  // tool 调用/结果成对：边界不得落在 tool 结果行上（否则拆开 [工具调用] 与其结果）
  let boundary = rows.length - tailCount;
  while (boundary > 0 && rows[boundary]?.role === 'tool') boundary--;
  const older = rows.slice(0, boundary);
  // zx_20261110_2 B5：总预算从**进入压缩这一刻**起算（跨 chunk 累计），不按段重计。
  const budgetMs = opts?.budgetMs ?? COMPACTION_BUDGET_MS;
  const comp = await compressConversations(apiKey, baseUrl, modelName, older, 40, {
    deadlineAt: Date.now() + budgetMs,
    signal: opts?.signal,
  });
  // 预算用尽 / 用户中止 ⇒ **回退规则摘要但绝不推进边界**：本轮模型看的是这份临时摘要，
  //   下一轮仍会从同一 boundary 重试压缩（"压了一半就当作压完"会把没进摘要的行永久遮蔽）。
  if (!comp.ok && (comp.degraded === 'budget' || comp.degraded === 'aborted')) {
    const rule = buildRuleDigest(older);
    const transient = [existingSummary.trim(), rule ? `[规则摘要]${rule}` : ''].filter(Boolean).join('\n');
    return {
      summary: transient || existingSummary,
      recentConversations: rows.slice(boundary).map(r => ({ role: r.role, content: r.content })),
      degraded: comp.degraded,
    };
  }
  const newSummary = comp.summary;
  if (!newSummary) {
    return { summary: existingSummary, recentConversations: rows.map(r => ({ role: r.role, content: r.content })) };
  }

  // 持久化：边界（最后被遮蔽行 rowid）+ 摘要（context_json）+ [压缩] 会话行（UI/审计可见）
  const lastShadowedRid = older[older.length - 1]!.rid;
  const taskCtx = (() => { try { return JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}'); } catch { return {}; } })();
  // 省察克治/反者道之动 (zx_20260906_1 2a): 多次 resume 再压缩不再"覆盖旧摘要"——旧摘要(早期意图/关键决策)与本次新摘要**拼接**，
  // 避免多次 resume 后最早期意图逐轮塌缩丢失；超长时截旧保新并标注（早期首段仍优先保留）。
  // zx_20261113_2 M12：重复摘要不再线性拼接；超长仍按既有口径截旧保新。
  const mergedRaw = mergeCompactionSummaries(existingSummary, newSummary);
  const mergedSummary = mergedRaw.length > 12_000
    ? `${(existingSummary || '').trim().slice(0, 4000)}\n…[早期记忆保留至此]…\n[续]${(newSummary || '').trim().slice(0, 7800)}`
    : mergedRaw;
  taskCtx.history_summary = mergedSummary;
  taskCtx.compacted_up_to_rowid = lastShadowedRid;
  db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(taskCtx), taskId);
  db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content, token_count, created_at) VALUES (?, ?, 'system', ?, 0, datetime('now'))")
    .run(crypto.randomUUID(), taskId, `[压缩] ${mergedSummary}`);
  logger.info({ taskId: taskId.slice(0, 8), shadowed: older.length, kept: rows.length - boundary, summaryLen: mergedSummary.length, merged: !!existingSummary?.trim() }, '上下文压缩完成并持久化');

  return { summary: mergedSummary, recentConversations: rows.slice(boundary).map(r => ({ role: r.role, content: r.content })) };
}
