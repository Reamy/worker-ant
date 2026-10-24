/**
 * zx_20261018_2 批七（见简 / 维特根斯坦·一个规则一处）: **整合簇**——自 `memory-manager.ts`
 * 机械搬迁而来的自由函数（来源符号：`consolidateMemories` / `runConsolidationPipeline` /
 * `challengeOverconfident` / `pruneMemories` / `spacedRepetition` / `detectAndResolveConflicts` /
 * `dialecticalSublateMemories` 及其私有助手 `_sublateWithLLM`）。**逐字节行为不变**：SQL、阈值、
 * JSON 形状、提示词一字未动。
 *
 * 函数取 `(mgr, …)`——`mgr` 只需满足下方最小宿主接口。`MemoryManager` 的同名方法现为**薄委托**，
 * 故全部既有调用点零改动。
 */
import type Database from 'better-sqlite3';
import { type AnsClient } from '@worker-ant/ans-client';
import { generateText } from 'ai';
import { createSafeProvider } from './ai-provider.js';
import { createLogger } from './logger.js';
import { auxModelRequest } from './model-request.js';
import { dbTimeMs, decayFactor } from './memory-decay.js';
import { MEM_LIVE_SQL, tombstoneMemory, consolidatedIntoReason } from './memory-lifecycle.js';
import { recordMemoryFailure, MEM_FAIL } from './memory-failure.js';
import { cosineSimilarity } from './memory-retrieval.js';
// 仅类型（打包期擦除）——不构成 `memory-manager.ts` 的运行期反向依赖。
import type { MemoryEntry } from './memory-manager.js';

const logger = createLogger('memory');

/** 整合簇所需的最小宿主面（`MemoryManager` 结构上满足）。 */
export interface MemoryConsolidationHost {
  readonly db: Database.Database;
  readonly ansClient: AnsClient;
}

/** 合并相似记忆：将相似度>0.9的记忆合并为一条 */
export function consolidateMemories(mgr: MemoryConsolidationHost, projectId: string): number {
  const memories = mgr.db.prepare(
    "SELECT * FROM wa_memories WHERE project_id = ? AND embedding IS NOT NULL AND embedding != '' ORDER BY created_at DESC LIMIT 200",
  ).all(projectId) as MemoryEntry[];
  let mergedCount = 0;
  // zx_20261012_1 批一: `consumed` 守卫——`memories` 是**起跑时的快照**，被合并走的 b 其快照项仍在，
  //   若不拦，外层 i 会再以 b 为容器去 UPDATE（对已落墓碑的行无效果）却仍把 c 物理删掉 ⇒ 静默丢内容。
  //   `reconsolidateMemories` 早有同形守卫（原 :2396），此处补齐——同一个病，同一把尺。
  const consumed = new Set<string>();

  for (let i = 0; i < memories.length; i++) {
    const a = memories[i]!;
    if (!a.embedding || consumed.has(a.id)) continue;
    for (let j = i + 1; j < memories.length; j++) {
      const b = memories[j]!;
      if (!b.embedding || consumed.has(b.id)) continue;
      try {
        const embA = JSON.parse(a.embedding) as number[];
        const embB = JSON.parse(b.embedding) as number[];
        const sim = cosineSimilarity(embA, embB);
        if (sim > 0.92) {
          // 合并到较新的记忆
          const merged = `[合并记忆]\n${a.content}\n---\n${b.content}`;
          mgr.db.prepare('UPDATE wa_memories SET content = ?, importance = MIN(1.0, ? + ?), embedding = ? WHERE id = ?')
            .run(merged, a.importance, b.importance * 0.5, a.embedding, a.id);
          // zx_20261012_1 批一（墓碑纪律）: 被并入的 b 原为**物理删** ⇒ 去向不可查。改落墓碑，
          //   `deleted_reason` 指向承接正文的 a ⇒ "这条去哪了"可答；正文未丢（已融进 a）。
          tombstoneMemory(mgr.db, b.id, consolidatedIntoReason(a.id));
          consumed.add(b.id);
          mergedCount++;
        } else if (sim > 0.85) {
          // 干扰遗忘：相似但不够合并的记忆，旧条目受干扰惩罚
          const penalty = 0.7;
          const newImportance = Math.max(0.05, (b.importance * penalty));
          mgr.db.prepare('UPDATE wa_memories SET importance = ?, updated_at = datetime(\'now\') WHERE id = ?')
            .run(Math.round(newImportance * 100) / 100, b.id);
        }
      } catch (err) { recordMemoryFailure(MEM_FAIL.consolidateMerge, err, { projectId, aId: a.id, bId: b.id }); }
    }
  }
  if (mergedCount > 0) logger.info({ projectId, mergedCount }, '记忆整合完成');
  return mergedCount;
}

/**
 * Phase 7.4: 记忆整合管道——去重+冲突解决+遗忘。
 * 返回 {deduped, conflicts, forgotten, challenged, pruned}
 */
export function runConsolidationPipeline(mgr: MemoryConsolidationHost, projectId: string): { deduped: number; conflicts: number; forgotten: number; challenged: number; pruned: number } {
  const result = { deduped: 0, conflicts: 0, forgotten: 0, challenged: 0, pruned: 0 };

  // 1. 去重（已有逻辑）
  result.deduped = consolidateMemories(mgr, projectId);

  // zx_20260920 M5: 此处原有「冲突解决：同 type 内保留最新、其余 importance 逐轮 ×0.5」，已删——
  //   ① 它不是冲突判据：同 type 内不止一条 ≠ 冲突，semantic/procedural 本就是**累积**的知识（真库 semantic 77 条）；
  //   ② 无下界且每轮管线各打一次 ⇒ importance = 0.5^n 直奔 0（真库实测自 2^-95 到 2^-140，是它的指纹）。
  //   后果不止「降权」：`retrieveByType` 对 semantic 要求 `importance >= 0.3`，打折两轮即**检索不到**；
  //   而 `synthesizeProjectKnowledge` 的门槛「≥3 条 importance ≥0.6」被它压成**恒不可满足**（真库 panorama 恒 0）。
  //   冲突交给本管道下方的 `detectAndResolveConflicts`：它有真的重叠率/效价判据，只打 `superseded` 标、不动 importance。

  // Phase 9.5: Ebbinghaus 衰减——先对所有非归档记忆应用时间衰减
  const allMemories = mgr.db.prepare(
    `SELECT id, importance, memory_type, valence, source, use_count, is_exemplar, last_used_at, last_reinforced_at, created_at FROM wa_memories WHERE project_id = ? AND ${MEM_LIVE_SQL}`,
  ).all(projectId) as Array<{ id: string; importance: number; memory_type: string; valence: string | null; source: string; use_count: number; is_exemplar: number; last_used_at: string | null; last_reinforced_at: string | null; created_at: string | null }>;

  for (const mem of allMemories) {
    // zx_20260930 M6: 衰减曲线收进 `memory-decay.ts` 一处真源——半衰期**按记忆类型派生**
    //   （情景 7 天 / 认识类 30 天 / 用户偏好·负空间·全景 90 天），再乘效价（正 ×2 / 负 ×0.5）
    //   与核心豁免（×5，原 λ×0.2 的同一件事）。
    //   **龄期只认三个语义时间戳**（`last_used_at`/`last_reinforced_at`/`created_at` 取最大），
    //   `updated_at` **永不参与**：它被十几处系统写刷新（同源替换 / 强化 / 冲突合并 / 工具改写），
    //   拿它当年龄等于每次系统改写白送一轮新的半衰期。zx_20260920 M5 记的"半衰期 ~18 小时"病根有二，
    //   此处收掉的是第二个（第一个是时区基准，已由 `dbTimeMs` 在 M4 收口）。
    //   ⚠ 与 M5 之前相比这是**改生产行为**：基准由"所有类型一律 ≈6.9 天"改为上表分档 ⇒ 非情景类
    //     记忆衰减显著变慢。这是 M6-1 的裁定所要求（短命情景 vs 长效认识），不是顺手改曲线。
    const decayed = mem.importance * decayFactor(mem);
    if (Math.abs(decayed - mem.importance) > 0.01) {
      mgr.db.prepare('UPDATE wa_memories SET importance = ? WHERE id = ?')
        .run(Math.max(0, Math.round(decayed * 100) / 100), mem.id);
    }
  }

  // 3. 遗忘：importance<0.1 且 >7天未访问的归档
  // zx_20260914 M3-2: panorama（项目知识全景）**免归档**——它是整合产物、全项目仅一条，
  //   被"遗忘"掉等于整块理性认识凭空消失（真库曾因此 panorama=0）；衰减仍会作用于它（如实保留），
  //   但 `retrieveByType` 无 importance 阈值，故只要不归档就仍会被注入。
  const cutoff = new Date(Date.now() - 7 * 86400000).toISOString().replace('T', ' ').slice(0, 19);
  const forgotten = mgr.db.prepare(
    // zx_20260930 M8: 归档的**来源条件**须排除墓碑——否则一条墓碑会被"归档"改写掉，
    //   分级从「墓碑」翻回「归档」，删除留痕当场作废（`MEM_LIVE_SQL` 即此一处真源）。
    `UPDATE wa_memories SET memory_type = 'archived' WHERE project_id = ? AND importance < 0.1 AND created_at < ? AND memory_type NOT IN ('archived', 'panorama') AND ${MEM_LIVE_SQL}`,
  ).run(projectId, cutoff);
  result.forgotten = forgotten.changes;

  // Phase 3.2: 矛盾检测——新旧记忆内容冲突处理
  const resolvedConflicts = detectAndResolveConflicts(mgr, projectId);
  result.conflicts += resolvedConflicts;

  // Phase 2.3 反者道之动：质疑高权重低验证记忆（防止过拟合固化）
  result.challenged = challengeOverconfident(mgr, projectId);

  // Phase 3.2 为道日损：主动精简低价值/过期冲突记忆
  result.pruned = pruneMemories(mgr, projectId);

  if (result.deduped > 0 || result.conflicts > 0 || result.forgotten > 0 || result.challenged > 0 || result.pruned > 0) {
    logger.info({ projectId, ...result }, '记忆整合管道完成');
  }
  return result;
}

/**
 * Phase 2.3 反者道之动：定期质疑"importance 高但从未被验证/使用"的记忆。
 * 物极必反——过度自信（高权重）且无实践检验的记忆应被降可信度，避免固化错误认知。
 * 通过写入 context_json.confidence_penalty 实现，不直接改 importance（保留价值，降可信度）。
 */
export function challengeOverconfident(mgr: MemoryConsolidationHost, projectId: string): number {
  // ⚠ zx_20260920_1 M7: 本行的 `0.6` 与 `PANORAMA_MIN_IMPORTANCE` **同值不同义**——这里是
  //   「反者道之动」的**质疑线**（候选集还要求 `use_count = 0 AND last_reinforced_at IS NULL`），
  //   不是「可被整合进全景」的下限。**刻意不并入**那个常量：并了就等于把两个本可独立调节的概念
  //   锁死成一个。改全景门槛时，请一并评估本行与 `extractApplicabilityConditions` 的闸。
  //   （下方 `importance < 0.7` 那道闸是**唯一**放过"按基线新写入记忆"的地方，见 memory-constants.ts。）
  const rows = mgr.db.prepare(
    `SELECT id, importance, use_count, last_reinforced_at, context_json FROM wa_memories WHERE project_id = ? AND ${MEM_LIVE_SQL} AND importance >= 0.6 AND (use_count = 0 OR use_count IS NULL) AND (last_reinforced_at IS NULL OR last_reinforced_at = '')`,
  ).all(projectId) as Array<{ id: string; importance: number; use_count: number; last_reinforced_at: string | null; context_json: string }>;

  let challenged = 0;
  for (const r of rows) {
    try {
      const ctx = JSON.parse(r.context_json || '{}');
      // Phase A (2026-08-27) 空性·无常：易变细节(volatile)质疑门槛降为 0.6，恒常规律保持原 0.7
      const isVolatile = (ctx as { applicability?: { stability?: string } }).applicability?.stability === 'volatile';
      if (r.importance < 0.7 && !isVolatile) continue;
      const existing = typeof ctx.confidence_penalty === 'number' ? ctx.confidence_penalty : 1;
      ctx.confidence_penalty = Math.max(0.2, Math.round(existing * 0.8 * 100) / 100);
      mgr.db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), r.id);
      challenged++;
    } catch { /* 忽略非法 context_json */ }
  }
  if (challenged > 0) logger.info({ projectId, challenged }, '反者道之动：质疑高权重低验证记忆');
  return challenged;
}

/**
 * Phase 3.2 为道日损：主动精简冗余/低价值/过期冲突记忆（归档可恢复，非物理删除）。
 * 比被动 Ebbinghaus 衰减阈值更积极：低价值(importance<0.3 且从未使用>30天) + 过期冲突(标记冲突>7天未解决)。
 */
export function pruneMemories(mgr: MemoryConsolidationHost, projectId: string): number {
  let pruned = 0;
  const cutoff30 = new Date(Date.now() - 30 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
  // zx_20260914 M3-2: 同"遗忘"——panorama 免归档（整合产物，被精简掉等于全项目理性认识消失）
  const low = mgr.db.prepare(
    `UPDATE wa_memories SET memory_type = 'archived' WHERE project_id = ? AND memory_type NOT IN ('archived', 'panorama') AND ${MEM_LIVE_SQL} AND importance < 0.3 AND (use_count = 0 OR use_count IS NULL) AND created_at < ?`,
  ).run(projectId, cutoff30);
  pruned += low.changes;

  const cutoff7 = new Date(Date.now() - 7 * 86_400_000).toISOString().replace('T', ' ').slice(0, 19);
  // zx_20260914 M3-2: panorama 在此**亦须**免归档——这条对 panorama 是**可达**的（此前判为不可达是误判）：
  //   矛盾检测把 `conflict_flag` 打在 `newer` 上（当对方为 user_instruction/纠正 时，见 `:1177`），
  //   而 panorama 正是"后写"的一方；判据是 token 重叠率 ≥0.3（非语义冲突）——
  //   用户指令与项目全景本就同题，误标概率不低。一旦被标且 7 天内没重新综合（综合走 LLM 闸门、
  //   失败即 return null），全景就被这条清掉。实测：一周内未综合 ⇒ 全景被归档、context_json 留 conflict_flag。
  const stale = mgr.db.prepare(
    `UPDATE wa_memories SET memory_type = 'archived' WHERE project_id = ? AND memory_type NOT IN ('archived', 'panorama') AND ${MEM_LIVE_SQL} AND context_json LIKE '%"conflict_flag":true%' AND updated_at < ?`,
  ).run(projectId, cutoff7);
  pruned += stale.changes;

  if (pruned > 0) logger.info({ projectId, pruned }, '为道日损：主动精简低价值/过期冲突记忆');
  return pruned;
}

/**
 * Phase 3.1 间隔重复：对高价值记忆（importance≥0.8 且 positive）按递增间隔(1→3→7→30天)重放，
 * 用 cost-optimal 低成本模型校验"是否仍成立"，通过则强化、失败则降可信度。对抗被动遗忘。
 */
export async function spacedRepetition(mgr: MemoryConsolidationHost, projectId: string): Promise<number> {
  try {
    const candidates = mgr.db.prepare(
      `SELECT id, content, last_reinforced_at, created_at, context_json FROM wa_memories WHERE project_id = ? AND ${MEM_LIVE_SQL} AND importance >= 0.8 AND valence = 'positive'`,
    ).all(projectId) as Array<{ id: string; content: string; last_reinforced_at: string | null; created_at: string; context_json: string }>;

    let validated = 0;
    const now = Date.now();
    for (const mem of candidates) {
      try {
        const ctx = JSON.parse(mem.context_json || '{}');
        const repeatCount = (ctx.spaced_repeat_count as number) || 0;
        const intervalDays = [1, 3, 7, 30][Math.min(repeatCount, 3)]!;
        // zx_20260929 M4: 同一把尺（本条管"间隔到了没"：8 小时误差会把 1 天档提前到 16 小时触发）
        const last = mem.last_reinforced_at ? dbTimeMs(mem.last_reinforced_at) : dbTimeMs(mem.created_at);
        if ((now - last) / 86_400_000 < intervalDays) continue;

        const m = await mgr.ansClient.getOptimalModel(auxModelRequest());
        if (!m?.url || !m?.api_key || !m?.model_name) break;
        const provider = createSafeProvider({ baseURL: m.url, apiKey: m.api_key });
        const model = provider(m.model_name);
        const result = await generateText({
          model, temperature: 0.1, maxTokens: m.max_output_tokens || 4096,
          prompt: `以下是工蚁系统项目的一条重要经验记忆。请判断它是否仍然成立、值得保留（只需回答"是"或"否"）：\n\n${mem.content.slice(0, 400)}\n\n是否仍成立？`,
        });
        const verdict = (result.text || '').trim();
        if (/否|不成立|过时|错误/.test(verdict)) {
          const existing = typeof ctx.confidence_penalty === 'number' ? ctx.confidence_penalty : 1;
          ctx.confidence_penalty = Math.max(0.2, Math.round(existing * 0.7 * 100) / 100);
          mgr.db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), mem.id);
        } else {
          ctx.spaced_repeat_count = repeatCount + 1;
          mgr.db.prepare(
            "UPDATE wa_memories SET last_reinforced_at = datetime('now'), context_json = ?, importance = MIN(1.0, importance + 0.02) WHERE id = ?",
          ).run(JSON.stringify(ctx), mem.id);
          validated++;
        }
      } catch { /* 单条校验失败继续 */ }
    }
    if (validated > 0) logger.info({ projectId, validated }, '间隔重复：重放强化重要记忆');
    return validated;
  } catch { return 0; }
}

/**
 * Phase 3.2: 矛盾检测——基于内容重叠+效价对比，检测新旧记忆冲突并自动处理。
 * 策略：
 *   1. source='user_correction' 新记忆 → 替换旧记忆内容
 *   2. source='agent_execution' 且高重叠低效价差异 → 旧记忆标记为 conflicted
 *   3. source='user_instruction' 旧记忆 → 永远不被覆盖，新记忆记录冲突
 */
export function detectAndResolveConflicts(mgr: MemoryConsolidationHost, projectId: string): number {
  const memories = mgr.db.prepare(
    `SELECT id, content, source, valence, importance, context_json FROM wa_memories WHERE project_id = ? AND ${MEM_LIVE_SQL} ORDER BY created_at DESC LIMIT 50`,
  ).all(projectId) as Array<{ id: string; content: string; source: string; valence: string; importance: number; context_json: string }>;

  if (memories.length < 2) return 0;
  let resolved = 0;

  for (let i = 0; i < memories.length; i++) {
    const newer = memories[i]!;
    if (!newer.content) continue;
    const newerTokens = new Set(newer.content.toLowerCase().split(/[\s,，。、；：！？\n]+/).filter(t => t.length > 1));

    for (let j = i + 1; j < memories.length; j++) {
      const older = memories[j]!;
      if (!older.content) continue;
      const olderTokens = older.content.toLowerCase().split(/[\s,，。、；：！？\n]+/).filter(t => t.length > 1);

      // 计算内容重叠度
      const overlap = olderTokens.filter(t => newerTokens.has(t)).length;
      const overlapRatio = overlap / Math.max(1, Math.min(newerTokens.size, olderTokens.length));
      if (overlapRatio < 0.3) continue; // 低重叠，跳过

      // 效价冲突检测：新旧记忆效价相反（positive vs negative）→ 高阶冲突
      const valenceConflict = (newer.valence === 'positive' && older.valence === 'negative')
        || (newer.valence === 'negative' && older.valence === 'positive');

      // 策略判断
      if (newer.source === 'user_correction') {
        // 策略1: 用户纠正 → 覆盖旧记忆
        mgr.db.prepare(
          "UPDATE wa_memories SET content = ?, source = 'user_correction', valence = ?, updated_at = datetime('now') WHERE id = ?",
        ).run(older.content + '\n[已纠正→] ' + newer.content, newer.valence, older.id);
        // 【zx_20261012_1 批一·墓碑纪律**豁免#2**（如实登记）】newer 的正文已并入 older（上句 UPDATE），
        //   物理删合法——与合并同形：内容在别处留存，落墓反而误拦"纠正后正文"的重新提取。
        mgr.db.prepare('DELETE FROM wa_memories WHERE id = ?').run(newer.id);
        resolved++;
      } else if (older.source === 'user_instruction' || older.source === 'user_correction') {
        // 策略3: 用户指令/纠正永远不被覆盖 → 新记忆标记冲突
        const ctx = JSON.parse(newer.context_json || '{}');
        ctx.conflict_flag = true;
        ctx.conflict_with = older.id;
        mgr.db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?')
          .run(JSON.stringify(ctx), newer.id);
        resolved++;
      } else if (valenceConflict && overlapRatio > 0.5) {
        // 高阶效价冲突 → 旧记忆标记冲突待审 + A3 superseded（检索降权，避免把已被矛盾经验取代的旧信息当权威注入）
        const ctx = JSON.parse(older.context_json || '{}');
        ctx.conflict_flag = true;
        ctx.conflict_with = newer.id;
        ctx.superseded = true;
        mgr.db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?')
          .run(JSON.stringify(ctx), older.id);
        resolved++;
      } else if (newer.source === 'agent_execution' && overlapRatio > 0.7) {
        // 策略2: agent_execution 高重叠 → 新记忆保留，标记潜在冲突引用
        const ctx = JSON.parse(newer.context_json || '{}');
        ctx.potential_conflict = true;
        ctx.related_to = older.id;
        mgr.db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?')
          .run(JSON.stringify(ctx), newer.id);
        resolved++;
      }
    }
  }

  if (resolved > 0) logger.info({ projectId, resolved }, '记忆矛盾检测完成');
  return resolved;
}

/**
 * Phase (2026-08-31) 记忆冲突的辩证升华（黑格尔辩证法·正反合 + 否定之否定）。
 * 对 detectAndResolveConflicts 标记的效价冲突记忆对（conflict_flag + conflict_with），
 * 用 LLM 把正反矛盾「扬弃」为条件化综合记忆（保留精华 + 超越局限 + 显性化适用条件）。
 * 正题（被标记记忆）更新为综合，反题归档（保留可追溯）。
 */
export async function dialecticalSublateMemories(mgr: MemoryConsolidationHost, projectId: string): Promise<number> {
  try {
    const conflictPairs = mgr.db.prepare(
      `SELECT id, content, context_json FROM wa_memories WHERE project_id = ? AND ${MEM_LIVE_SQL} AND context_json LIKE '%"conflict_flag":true%' AND context_json LIKE '%"conflict_with"%' LIMIT 5`
    ).all(projectId) as Array<{ id: string; content: string; context_json: string }>;
    if (conflictPairs.length === 0) return 0;

    let sublated = 0;
    for (const thesis of conflictPairs) {
      try {
        const ctx = JSON.parse(thesis.context_json || '{}') as { conflict_with?: string };
        if (!ctx.conflict_with) continue;
        const antithesis = mgr.db.prepare(
          `SELECT id, content, source FROM wa_memories WHERE id = ? AND ${MEM_LIVE_SQL}`
        ).get(ctx.conflict_with) as { id: string; content: string; source: string } | undefined;
        if (!antithesis) continue;
        // 用户指令/纠正（权威）不与 agent 内容「综合」，跳过扬弃（避免稀释权威）
        if (antithesis.source === 'user_instruction' || antithesis.source === 'user_correction') continue;

        const synthesis = await sublateWithLLM(mgr, thesis.content, antithesis.content);
        if (!synthesis) continue;

        const newCtx: Record<string, unknown> = { ...ctx };
        newCtx.sublated = { from: antithesis.id, at: new Date().toISOString() };
        delete newCtx.conflict_flag;
        delete newCtx.conflict_with;
        delete newCtx.superseded; // A3: 已扬弃为综合 → 恢复检索权（不再按被取代降权）
        mgr.db.prepare("UPDATE wa_memories SET content = ?, valence = 'neutral', context_json = ?, updated_at = datetime('now') WHERE id = ?")
          .run(synthesis, JSON.stringify(newCtx), thesis.id);
        mgr.db.prepare("UPDATE wa_memories SET memory_type = 'archived', updated_at = datetime('now') WHERE id = ?").run(antithesis.id);
        sublated++;
      } catch (err) { recordMemoryFailure(MEM_FAIL.sublatePair, err, { projectId, thesisId: thesis.id }); }
    }
    if (sublated > 0) logger.info({ projectId: projectId.slice(0, 8), sublated }, '记忆辩证扬弃完成');
    return sublated;
  } catch (err) {
    recordMemoryFailure(MEM_FAIL.sublateRun, err, { projectId });
    logger.warn({ projectId: projectId.slice(0, 8), errMsg: (err as Error).message }, '记忆辩证扬弃失败');
    return 0;
  }
}

/** 内部：LLM 辩证扬弃——把正题（thesis）+ 反题（antithesis）综合为合题（synthesis）。 */
async function sublateWithLLM(mgr: MemoryConsolidationHost, thesis: string, antithesis: string): Promise<string | null> {
  try {
    const m = await mgr.ansClient.getOptimalModel(auxModelRequest());
    if (!m?.url || !m?.api_key || !m?.model_name) return null;
    const provider = createSafeProvider({ baseURL: m.url, apiKey: m.api_key });
    const model = provider(m.model_name);
    const result = await generateText({
      model, temperature: 0.2, maxTokens: m.max_output_tokens || 4096,
      prompt: `以下是关于同一主题的两条矛盾记忆。请辩证扬弃（黑格尔正反合）：既保留两者精华、又超越两者局限、显性化适用条件，综合为一条更高的记忆。\n\n正题：${thesis.slice(0, 300)}\n反题：${antithesis.slice(0, 300)}\n\n输出 JSON：{"synthesis": "综合记忆（含适用条件：在什么条件下成立、什么条件下不成立）"}，简洁中文，不要泛泛而谈。`,
    });
    const text = result.text || '';
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as { synthesis?: string };
    if (!parsed.synthesis || parsed.synthesis.trim().length < 4) return null;
    return `[扬弃] ${parsed.synthesis.trim().slice(0, 300)}`;
  } catch { return null; }
}
