/**
 * SQLite向量记忆管理器。
 * 写入：异步提取embedding并存储；检索：余弦相似度排序 + Top-K。
 */

/**
 * @layer domain — 领域层（内因）— 决定系统"是什么"的核心：Agent引擎、任务管理、记忆系统、事件溯源
 */
import type Database from 'better-sqlite3';
import { type AnsClient } from '@worker-ant/ans-client';
import { randomUUID } from 'node:crypto';
import { generateText } from 'ai';
import { createSafeProvider } from './ai-provider.js';
import { createLogger } from './logger.js';
import { assessComplexity } from './task-archetype.js';
import { eventBus } from './event-bus.js';
import { MEM_IMPORTANCE_DEFAULT, PANORAMA_MIN_IMPORTANCE, PANORAMA_TOP_K } from './memory-constants.js';
// zx_20261003 M5: panorama 综合纳入**非记忆原料**（三元组 top 关系 + 交付物 byType + 调用账成败）。
import { collectProjectKnowledgeMaterials, formatKnowledgeMaterials } from './project-knowledge-materials.js';
// zx_20261014_4 批五: **项目域知识册**（零 LLM 派生册）——消费侧的唯一读口（薄委托，不另抄 SQL）。
import { listProjectKnowledge } from './project-knowledge.js';
import type { ProjectKnowledgeEntry } from './project-knowledge.js';
// zx_20261021_3 批一: 领域包的**消费侧读口**（薄委托）；本模块不另抄包解析。
import { listAppliedDomainPacks } from './domain-pack.js';
import type { AppliedDomainPack } from './domain-pack.js';
// zx_20261022_3 批八: 项目画像的**消费侧读口**（薄委托）；解析/校验只在 `project-profile.ts` 一处。
import { readProjectProfile } from './project-profile.js';
import type { StoredProjectProfile } from './project-profile.js';
// zx_20261023_5 批二: 知识蒸馏卡的**消费侧读口**（薄委托）；Pro 闸与选卡算法只在 `knowledge-cards.ts` 一处。
import { listActiveKnowledgeCards, KNOWLEDGE_CARD_FEATURE } from './knowledge-cards.js';
import type { KnowledgeCard } from './knowledge-cards.js';
import { proFeatureRefusal } from './pro-gate.js';
// zx_20260930 M5: 复盘的**提示词**由 `memory-write.ts` 的纯函数定（按终态分叉 + 无事实则不编），
//   本文件不再就地拼一段"只认成功"的提示词。类型 `FailureRecord` 亦取自那里。
import { buildTaskReviewPrompt, failureAnchors, isAttributable } from './memory-write.js';
import type { FailureRecord } from './memory-write.js';
import { auxModelRequest } from './model-request.js';
// zx_20261021_4 批二：理解预读的提示词构造搬进 `core/memory-prelude.ts`（纯函数、零依赖——
//   本文件的读表与调用保留，拼装只此一份）。
import { buildPreludePrompt } from './memory-prelude.js';
import type { PreludeProjectContext } from './memory-prelude.js';
// zx_20261012_3 批二（「算得真」）：字÷4 的分度走**一处真源**（core/token-estimate.ts），不各写一份。
import { estimateTokensFromChars } from './token-estimate.js';
// zx_20260930 M6: **时间基准的四个常数与两把派生尺**收进 `core/memory-decay.ts` 一处真源
//   （本轮之前它们散在本文件里当裸字面量：14 / 21 / 30 / 0.1）。
import { dbTimeMs } from './memory-decay.js';
// zx_20260930 M7-d: 检索层的"分层与择要"算式收进 `core/memory-select.ts`（零依赖纯函数）——
//   受控回归直接引**生产这一份**去度量，不必自造等价物。
// zx_20260930 M7-e: 分词器（`extractKeywords`）与工作记忆的**池/焦点两把尺**同出该处——
//   注入侧够不到本类的私有方法，故分词器成为**一处真源**（本类的 `_extractKeywords` 改为委托）。
// zx_20260930 M7-f: 图式重构召回（`applySchemaRecall`）亦同出该处——同一条纪律（判据调生产这一份）。
import {
  extractKeywords, rankWorkingMemory, WM_POOL_CAP, type WorkingMemoryItem,
} from './memory-select.js';
// zx_20260930 M8(空性·无常 / 维特根斯坦·一个规则一处): 记忆的**生命周期分级与墓碑**收进
//   `core/memory-lifecycle.ts`（零依赖纯函数）——哨兵/缘由词表/指纹算法/墓碑语句形状**只此一处**。
//   ★`MEM_LIVE_SQL` 是本文件**一切读取点**的 WHERE 片段（不再手抄 `!= 'archived'`——手抄者必漏 `'deleted'`）。
import {
  MEM_LIVE_SQL, MEM_TYPE_DELETED, MEM_DELETE_REASONS,
  tombstoneMemory, tombstoneExpiredArchived, tombstoneBlocksContent,
  boundedSameSource, contentFingerprint,
} from './memory-lifecycle.js';
// zx_20261012_1 批一（M29 静默失败清零）: 吞写入/状态变更者的空 catch 一律 `recordMemoryFailure`
//   —— 计一次数、留一行痕；**不改任何回退返回值**（原 `return false/0` 原样保留）。
import { recordMemoryFailure, MEM_FAIL } from './memory-failure.js';
// zx_20261004 M14（K-8 轻得下）: **知识图谱簇**与**前瞻记忆簇**已机械搬出本文件（逐字节行为不变）——
//   本文件只留同名**薄委托**方法，故全部既有调用点零改动。函数取 `(this, …)`（`this` 结构上满足
//   两模块的最小宿主接口：`readonly db`/`readonly ansClient` + `scheduleChanged`）。
import {
  storeTriple as kgStoreTriple, searchKnowledgeGraph as kgSearchKnowledgeGraph,
  retrieveKnowledgeGraphContext as kgRetrieveKnowledgeGraphContext,
  extractTriples as kgExtractTriples, extractTriplesWithLLM as kgExtractTriplesWithLLM,
} from './memory-kg.js';
import {
  storeProspective as prospStoreProspective, listProspective as prospListProspective,
  getTriggeredProspective as prospGetTriggeredProspective,
  markProspectiveTriggered as prospMarkProspectiveTriggered,
  scanDueProspective as prospScanDueProspective,
} from './memory-prospective.js';
// zx_20261018_2 批七（见简）: **检索簇 / 整合簇 / 范例簇**已机械搬出本文件（逐字节行为不变）——
//   本文件只留同名**薄委托**方法，故全部既有调用点零改动。函数取 `(this, …)`（`this` 结构上满足
//   三模块的最小宿主接口：`readonly db`/`readonly ansClient`/`getProjectTerminology`）。
import {
  searchConversations as retSearchConversations, searchBM25 as retSearchBM25,
  searchByKeywords as retSearchByKeywords, processingDepthOf,
  retrievalStrength as retRetrievalStrength, empiricalReliability as retEmpiricalReliability,
  maturityOf as retMaturityOf, confidenceOf as retConfidenceOf,
  retrievalPractice as retRetrievalPractice, searchHybrid as retSearchHybrid,
  retrieveLayered as retRetrieveLayered, retrieveTaskRelevant as retRetrieveTaskRelevant,
  retrieveTaskRelevantWithSource as retRetrieveTaskRelevantWithSource,
  retrieveByCue as retRetrieveByCue, deepRetrieve as retDeepRetrieve,
  applicabilityMismatch as retApplicabilityMismatch,
  encodingArchetype, encodingKeywords, experienceOf, experienceBoost, maturityBoost,
  processingDepthBoost, reusableBoost, applicabilityOf, applicabilityPenalty, conflictPenalty,
  cosineSimilarity, getRecent as retGetRecent, getProjectKnowledge as retGetProjectKnowledge,
  getUnembedded as retGetUnembedded, retrieveUnknownHits as retRetrieveUnknownHits,
  retrieveNegativeHits as retRetrieveNegativeHits,
  getProjectTerminology as retGetProjectTerminology,
  type TaskRelevantSource,
} from './memory-retrieval.js';
import {
  consolidateMemories as consConsolidateMemories,
  runConsolidationPipeline as consRunPipeline,
  challengeOverconfident as consChallengeOverconfident,
  pruneMemories as consPruneMemories,
  spacedRepetition as consSpacedRepetition,
  detectAndResolveConflicts as consDetectConflicts,
  dialecticalSublateMemories as consDialecticalSublate,
} from './memory-consolidation.js';
import {
  markExemplar as exMarkExemplar, unmarkExemplar as exUnmarkExemplar,
  getExemplars as exGetExemplars, generateExemplarContext as exGenerateExemplarContext,
  findSimilarTasks as exFindSimilarTasks, getSimilarTaskExperience as exGetSimilarTaskExperience,
  findCrossProjectSimilarTasks as exFindCrossProjectSimilarTasks,
  getCrossProjectKnowledge as exGetCrossProjectKnowledge,
  clusterSimilarMemories as exClusterSimilarMemories,
} from './memory-exemplars.js';
// zx_20260920_1 M7: 两常量在此**转出**，供受控回归从**模块命名空间**取真值（不手抄 0.6）；
//   真源是 `core/memory-constants.ts`（纯模块，渲染层亦直引同一份）。
export { MEM_IMPORTANCE_DEFAULT, PANORAMA_MIN_IMPORTANCE, PANORAMA_TOP_K };

const logger = createLogger('memory');

/**
 * zx_20260906 批4 (4d): 记忆沉淀实时——后台写点经节流发射 memory.changed（main 侧聚合 ≤1 次/3s，
 * 瞬态事件仅内存通知，不落事件日志）。MemoriesPage 订阅后记忆列表/类型卡在沉淀期不再停滞。
 */
let _memChangedTimer: ReturnType<typeof setTimeout> | null = null;
let _memChangedPending = new Map<string, string>(); // key=projectId:type → type
function scheduleMemoryChanged(projectId: string | null | undefined, memoryType: string): void {
  const p = projectId || '__none__';
  _memChangedPending.set(`${p}:${memoryType}`, memoryType);
  if (_memChangedTimer) return;
  _memChangedTimer = setTimeout(() => {
    _memChangedTimer = null;
    const byProj = new Map<string, Set<string>>();
    for (const [k, t] of _memChangedPending) {
      const [p2] = k.split(':');
      if (!byProj.has(p2!)) byProj.set(p2!, new Set());
      byProj.get(p2!)!.add(t);
    }
    _memChangedPending.clear();
    for (const [p2, types] of byProj) {
      void eventBus.emitTransient('memory.changed', {
        projectId: p2 === '__none__' ? undefined : p2,
        project_id: p2 === '__none__' ? null : p2,
        memory_types: [...types],
      }).catch(() => {});
    }
  }, 3000);
}

export interface MemoryEntry {
  id: string;
  project_id: string;
  task_id: string | null;
  content: string;
  embedding: string | null;
  memory_type: string;
  importance: number;
  valence?: string;
  created_at: string;
  use_count?: number;
  last_used_at?: string | null;
  /** zx_20261018_3 批一: 注入计数与使用计数分账（注入 ≠ 主动引用）。 */
  injected_count?: number;
  last_injected_at?: string | null;
  source?: string;
  reasoning?: string;
  context_json?: string;
  last_reinforced_at?: string | null;
  success_count?: number;
  failure_count?: number;
}

/**
 * zx_20261018_3 批一（管子·度量衡）: 再巩固的「新证据」判据——**一处真源**，rr 直测两只标本。
 *
 * 证据 = 主动引用过（`use_count`）∨ 至少被注入过一次（`injected_count`）∨ 有已验证证据。
 * 旧实现只看 `use_count`；注入与使用分账后若不补 `injected_count`，"只被注入过"的记忆
 * 会从"有证据"掉成"无证据"，净证据凭空变少——故此处是**同一把尺的延续**，不是放宽。
 */
export function hasReconsolidationEvidence(
  mem: Pick<MemoryEntry, 'use_count' | 'injected_count' | 'context_json'>,
): boolean {
  if ((mem.use_count ?? 0) >= 1 || (mem.injected_count ?? 0) >= 1) return true;
  try {
    const ctx = JSON.parse(mem.context_json || '{}') as { evidence?: { verified?: boolean } };
    return !!ctx.evidence?.verified;
  } catch { return false; }
}

// zx_20260930 M6: `dbTimeMs` 的**实现**已移入 `core/memory-decay.ts`（零依赖模块，`rr` 判据直引同一真源，
//   不必自造等价物）。此处**原样转出**——既有引点（`project-engine.ts` 等）与 rr 断言一字不改。
//   语义与 zx_20260929 M4 逐字一致：带 `Z`/偏移的原样解析、其余补 `T`+`Z` 按 UTC 解析、取不到返 `NaN`。
export { dbTimeMs };

/** 同 run 共现（赫布）强化的单次加权幅度（`_reinforceCooccurrence` 一处消费）。 */
export const CO_OCCUR_BOOST = 0.02;

/**
 * zx_20261018_1 批七：`usage_score` 作为**小幅**排序因子的权重。
 * 与 archetype 匹配等 boost 同档（0.05）——成功率高只在相关度相当时决胜，绝不覆盖相关度。
 */
export const USAGE_RELIABILITY_BOOST_WEIGHT = 0.05;

/**
 * zx_20261012_1 批二（M26-a）：向量索引缓存的**键**——`id` + **正文指纹**（一处真源纯函数）。
 *
 * 为什么不能只用 `id`：缓存里存的是**按某份正文算出的**向量。若正文改了而缓存仍按 `id` 命中，
 * 机器就会拿**旧正文的向量**去算"新正文的相关度"（`search` 正这么用）⇒ 召回静默失真。
 * 把正文指纹并入键：正文一变，键就变，旧项**自然不可达**（"同 id 换内容"这一类一并治住）。
 * 指纹取 `contentFingerprint`（折叠空白 + 小写 + 长度）⇒ 仅排版差异不构成"另一份内容"。
 */
export function embeddingCacheKey(id: string, content: string): string {
  return `${id}#${contentFingerprint(content).slice(0, 8)}`;
}

export class MemoryManager {
  // zx_20261004 M14: `private` → `readonly`（**仅可见性，行为不变**——构造后从不重赋），
  //   使本实例结构上满足 `MemoryKgHost`/`MemoryProspectiveHost` 的 `readonly db`/`readonly ansClient`。
  readonly db: Database.Database;
  readonly ansClient: AnsClient;

  constructor(db: Database.Database, ansClient: AnsClient) {
    this.db = db;
    this.ansClient = ansClient;
    this.initFts();
    // zx_20260907 M1(A1): 启动时按保留期清理归档记忆(幂等,失败不阻断)
    try { void this.pruneArchivedMemory(); } catch { /* best-effort */ }
  }

  /** zx_20261004 M14: 前瞻记忆簇的"记忆已变"节流发射——薄面，转模块级 `scheduleMemoryChanged`
   *  （throttle 器留本文件，避免 `memory-prospective.ts` 反向 import 成 ESM 环）。 */
  scheduleChanged(projectId: string | null | undefined, memoryType: string): void {
    scheduleMemoryChanged(projectId, memoryType);
  }

  /**
   * zx_20260907 M1(A1) 建；zx_20260930 M8 收口：归档池保留期届满 —— **落墓碑**（原为物理删）。
   *
   * ⚠ 语义变更（M8 如实登记）:本函数**不再减少行数** —— 它把「归档」推进到「墓碑」，
   *   回收的是**正文体积**（墓碑正文为空），留下的是**去向**（`listTombstones` 可查）。
   *   这正是 M8 要的「清理前须有可查的去向」：物理删会连"它去哪了"一起删掉。
   *   返回的是**落墓条数**（与旧返回"删除条数"同形，量纲仍是"本次处置了几条"）。
   */
  async pruneArchivedMemory(): Promise<number> {
    try {
      const row = this.db.prepare("SELECT value FROM wa_settings WHERE key = 'memory.archive_retention_days'").get() as { value: string } | undefined;
      const days = Number(row?.value ?? '90');
      if (!(days > 0)) { logger.info('memory.archive_retention_days=0, 归档清理已关闭'); return 0; }
      const n = tombstoneExpiredArchived(this.db, days);
      if (n > 0) logger.info('memory: 按保留期 %d 天落墓碑 %d 条（不再减行数，正文已清空，去向见审计面）', days, n);
      return n;
    } catch (e) {
      logger.warn('memory: 归档清理失败 %s', (e as Error).message);
      return 0;
    }
  }

  /** 初始化FTS5全文搜索 */
  private initFts(): void {
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS wa_memories_fts USING fts5(
          content, memory_type, project_id,
          content='wa_memories', content_rowid='rowid'
        );
      `);
      // 同步触发器：插入/更新/删除时自动同步FTS索引
      this.db.exec(`
        CREATE TRIGGER IF NOT EXISTS wa_memories_ai AFTER INSERT ON wa_memories BEGIN
          INSERT INTO wa_memories_fts(rowid, content, memory_type, project_id)
          VALUES (new.rowid, new.content, new.memory_type, new.project_id);
        END;
        CREATE TRIGGER IF NOT EXISTS wa_memories_ad AFTER DELETE ON wa_memories BEGIN
          INSERT INTO wa_memories_fts(wa_memories_fts, rowid, content, memory_type, project_id)
          VALUES ('delete', old.rowid, old.content, old.memory_type, old.project_id);
        END;
        CREATE TRIGGER IF NOT EXISTS wa_memories_au AFTER UPDATE ON wa_memories BEGIN
          INSERT INTO wa_memories_fts(wa_memories_fts, rowid, content, memory_type, project_id)
          VALUES ('delete', old.rowid, old.content, old.memory_type, old.project_id);
          INSERT INTO wa_memories_fts(rowid, content, memory_type, project_id)
          VALUES (new.rowid, new.content, new.memory_type, new.project_id);
        END;
      `);

      // Phase 7.7: 会话搜索 FTS5 表（独立表）
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS wa_conversations_fts USING fts5(
          role, content, task_id
        );
      `);
      // 自动同步触发器：此前 indexConversation 从未被调用，导致 wa_conversations_fts 恒为空、searchConversations 永远无结果。
      // 现改为在 wa_task_conversations 插入/删除/更新时自动索引（与 wa_memories_fts 同模式）。
      // 修复 (2026-09-01)：wa_conversations_fts 是普通内嵌内容表（无 content= 外部表声明），
      // 而 FTS5 'delete' 命令仅支持 external-content/contentless 表——此前 ad/au 触发器用它，
      // 导致每次删除/更新对话都报 SQL logic error（task:delete 删除任务连带失败，表现为「无法删除已完成任务」）。
      // 对普通 FTS5 表改用普通 DELETE BY rowid；DROP+CREATE 使存量库启动时自愈。
      this.db.exec(`
        DROP TRIGGER IF EXISTS wa_conversations_ad;
        DROP TRIGGER IF EXISTS wa_conversations_au;
        CREATE TRIGGER IF NOT EXISTS wa_conversations_ai AFTER INSERT ON wa_task_conversations BEGIN
          INSERT INTO wa_conversations_fts(rowid, role, content, task_id)
          VALUES (new.rowid, new.role, substr(new.content, 1, 1000), new.task_id);
        END;
        CREATE TRIGGER wa_conversations_ad AFTER DELETE ON wa_task_conversations BEGIN
          DELETE FROM wa_conversations_fts WHERE rowid = old.rowid;
        END;
        CREATE TRIGGER wa_conversations_au AFTER UPDATE ON wa_task_conversations BEGIN
          DELETE FROM wa_conversations_fts WHERE rowid = old.rowid;
          INSERT INTO wa_conversations_fts(rowid, role, content, task_id)
          VALUES (new.rowid, new.role, substr(new.content, 1, 1000), new.task_id);
        END;
      `);
      // 回填 (2026-09-01)：触发器加入前已存在的对话从未进入 FTS 索引（仅后续新增被索引），
      // 导致会话搜索只能命中部分记录。用幂等 INSERT...SELECT 按原始 rowid 补齐缺失行（重复运行无副作用）。
      const convCount = (this.db.prepare('SELECT COUNT(*) c FROM wa_task_conversations').get() as { c: number }).c || 0;
      const ftsCount = (this.db.prepare('SELECT COUNT(*) c FROM wa_conversations_fts').get() as { c: number }).c || 0;
      if (ftsCount < convCount) {
        this.db.exec(`
          INSERT INTO wa_conversations_fts(rowid, role, content, task_id)
          SELECT c.rowid, c.role, substr(c.content, 1, 1000), c.task_id
          FROM wa_task_conversations c
          WHERE NOT EXISTS (SELECT 1 FROM wa_conversations_fts f WHERE f.rowid = c.rowid);
        `);
        logger.info({ convCount, ftsCount }, '对话 FTS 索引回填完成');
      }
    } catch { /* FTS5 已存在或不可用 */ }
  }

  /**
   * Phase 7.7: 索引一条对话记录到 FTS5。
   */
  indexConversation(rowid: number, role: string, content: string, taskId: string): void {
    try {
      this.db.prepare(
        'INSERT INTO wa_conversations_fts(rowid, role, content, task_id) VALUES (?, ?, ?, ?)',
      ).run(rowid, role, content.slice(0, 1000), taskId);
    } catch (err) {
      const msg = (err as { message?: string }).message || '';
      // 仅忽略重复键和表不存在错误，其他错误记录日志
      if (!msg.includes('UNIQUE constraint') && !msg.includes('no such table')) {
        logger.warn({ rowid, taskId, errMsg: msg.slice(0, 100) }, 'FTS5索引写入失败');
      }
    }
  }

  /** Phase 7.7: FTS5 全文本搜索对话记录。——批七起委托 `memory-retrieval.ts`。 */
  searchConversations(query: string, projectId?: string, limit = 10): Array<{ taskId: string; role: string; content: string }> {
    return retSearchConversations(this, query, projectId, limit);
  }

  /** 存储记忆（含embedding）。9.5: 支持source/reasoning */
  // ⚠ zx_20260920_1 M7 实测：本方法**全仓零调用者**（`apps/`、`packages/` 全扫为空，也不在
  //   `MemoryRepository` 接口中）—— 是个死入口。本轮**不删**（删它要连带裁定接口与表列默认值的可达性），
  //   仅把兜底值归到 `MEM_IMPORTANCE_DEFAULT`，免将来接线时把 0.5 那份病带回来。
  async store(params: {
    project_id: string;
    task_id?: string;
    content: string;
    embedding: number[];
    type?: string;
    importance?: number;
    reasoning?: string;
    source?: string;
  }): Promise<string> {
    const id = randomUUID();
    this.db.prepare(
      'INSERT INTO wa_memories (id, project_id, task_id, content, embedding, memory_type, importance, reasoning, source, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))',
    ).run(id, params.project_id, params.task_id ?? null, params.content, JSON.stringify(params.embedding), params.type ?? 'episodic', params.importance ?? MEM_IMPORTANCE_DEFAULT, params.reasoning ?? '', params.source ?? 'agent_execution');
    scheduleMemoryChanged(params.project_id, params.type ?? 'episodic');
    return id;
  }

  /** 存储不含embedding的记忆文本。9.5: 支持source/reasoning/user_id。Phase B: 支持experience(亲历/推断)。A4: 支持reusableExperience(复用价值标记) */
  storeText(params: { project_id: string; task_id?: string; content: string; type?: string; source?: string; reasoning?: string; user_id?: string; importance?: number; evidence?: { file_path?: string; verified?: boolean }; experience?: 'direct' | 'inferred'; valence?: string; reusableExperience?: boolean }): string {
    // zx_20260930 M8(空性·无常): 墓碑拦截——**机器不得把用户删掉的东西自己找回来**。
    //   作用面刻意只在**机器写入侧**（本函数）：用户显式新增（`preferences:create` / `memory:create`）
    //   走的是直插，不经此处，故天然不受拦。
    //   ★`user_*` 来源例外：「用户经 IM 说的原话」（`user_correction`）**不受拦**——
    //   那是**人在说话**，与"机器重提取"是两回事；拦它即等于用一条旧删除堵住用户此刻的嘴。
    //   返回空串是**如实**：没有新行落库，调用方拿到空 id（调用点均只做无副作用消费，见 `tools/write.ts`）。
    const src = params.source ?? 'agent_execution';
    if (!src.startsWith('user_') && tombstoneBlocksContent(this.db, params.project_id, params.content)) {
      logger.info('memory: 内容命中墓碑 → 机器写入已拦截（project=%s source=%s）', params.project_id, src);
      return '';
    }
    const id = randomUUID();
    const uid = params.user_id || params.project_id === '__user__' ? (params.user_id || '') : '';
    // Phase 3.2: 记录编码语境（任务 archetype + 关键词）+ Phase C 证据锚点
    const contextObj: Record<string, unknown> = {};
    if (params.task_id) {
      try {
        const tctx = JSON.parse((this.db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(params.task_id) as { context_json: string } | undefined)?.context_json || '{}');
        const encodingContext: Record<string, unknown> = {};
        if (tctx.archetype) encodingContext.archetype = tctx.archetype;
        const keywords = this._extractKeywords(this.getTaskText(params.task_id));
        if (keywords.length > 0) encodingContext.keywords = keywords;
        if (Object.keys(encodingContext).length > 0) contextObj.encoding_context = encodingContext;
      } catch { /* 忽略 */ }
    }
    if (params.evidence) {
      contextObj.evidence = { ...params.evidence, task_id: params.task_id ?? undefined };
    }
    // Phase B 源监控：亲历(direct)/推断(inferred)自动推导——用户来源或有验证证据=亲历，其余默认推断
    let experience = params.experience;
    if (!experience) {
      if (params.evidence?.verified || (params.source ?? '').startsWith('user_')) experience = 'direct';
      else experience = 'inferred';
    }
    contextObj.experience = experience;
    // A4: 复用价值标记（0/1）——值得复用的经验在检索中加权，相似任务识别更易命中
    if (params.reusableExperience !== undefined) contextObj.reusable_experience = params.reusableExperience ? 1 : 0;
    const contextJson = JSON.stringify(contextObj);
    // zx_20260920_1 M7: 落库刻度**取自一处真源**。此前这条 INSERT **没有 `importance` 列** ⇒ 取表列默认
    //   0.5，而读侧门槛是 0.6 ⇒ 按基线写入的记忆**出生即不可被整合**，`panorama` 结构性恒 0（闭环死锁）。
    //   调用方可传模型自评值（`background-review`）：**夹取到 [0,1]**（模型输出不可信），
    //   但**不**夹到 ≥ 默认值——「这条不重要」是它的合法判断，抹平即另一种失真。
    const importance = typeof params.importance === 'number' && Number.isFinite(params.importance)
      ? Math.min(1, Math.max(0, params.importance))
      : MEM_IMPORTANCE_DEFAULT;
    this.db.prepare(
      'INSERT INTO wa_memories (id, project_id, task_id, content, memory_type, importance, source, reasoning, user_id, valence, context_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime(\'now\'))',
    ).run(id, params.project_id, params.task_id ?? null, params.content, params.type ?? 'episodic', importance, params.source ?? 'agent_execution', params.reasoning ?? '', uid, params.valence ?? 'neutral', contextJson);
    scheduleMemoryChanged(params.project_id, params.type ?? 'episodic');
    return id;
  }

  /** 9.5b: 更新记忆内容（再巩固） */
  updateMemory(id: string, content: string, reasoning?: string): void {
    // zx_20261012_1 批二（M26-a）: 正文一变即**失效该 id 的旧缓存项**（按旧正文的键删；正文未变则删了也无害）。
    const before = this.db.prepare('SELECT content FROM wa_memories WHERE id = ?').get(id) as { content?: string } | undefined;
    this.db.prepare(
      "UPDATE wa_memories SET content = ?, reasoning = ?, updated_at = datetime('now') WHERE id = ?",
    ).run(content, reasoning ?? '', id);
    if (before) this._embeddingCache.delete(embeddingCacheKey(id, before.content ?? ''));
  }

  /**
   * 9.5b: 合并两条记忆（保留较新的为容器，合并内容+推理，删除旧条）
   *
   * zx_20260930 M8: 正文合并改 `boundedSameSource`——与 `sameSourceReplace` **同一形状的第二个落点**
   *   （同一个病：把两条全文拼起来，无上界）。未超上限时与旧写法**逐字相同**。
   *   ⚠ 被吸收的旧条（idB）**仍走物理删、不落墓碑**：它的内容**留在了合并行**里，
   *   这不是"删除"，而墓碑的语义是"这些内容不再属于系统"——给它落墓反而会**挡住合并后的正文被重新提取**。
   *   【zx_20261012_1 批一·墓碑纪律**豁免#1**（如实登记）】本处物理删**合法**：正文随 `boundedSameSource`
   *   并入 idA，墓碑的"正文清空 + 按原正文算指纹"会**误拦合并后正文的重新提取**
   *   （承接行里已含被并入方正文，再按它算一份删前指纹即自相矛盾）。判据见 `rr_zx_20261012_1` 的"豁免三处恰为这几处"。
   */
  mergeMemories(idA: string, idB: string): string {
    const a = this.db.prepare('SELECT * FROM wa_memories WHERE id = ?').get(idA) as MemoryEntry & { reasoning: string } | undefined;
    const b = this.db.prepare('SELECT * FROM wa_memories WHERE id = ?').get(idB) as MemoryEntry & { reasoning: string } | undefined;
    if (!a || !b) throw new Error('Memory not found');
    const merged = boundedSameSource(a.content, b.content, { label: '合并' });
    const mergedReasoning = [a.reasoning, b.reasoning].filter(Boolean).join('\n');
    this.db.prepare(
      "UPDATE wa_memories SET content = ?, reasoning = ?, importance = MIN(1.0, ? + ?), updated_at = datetime('now') WHERE id = ?",
    ).run(merged, mergedReasoning, a.importance, b.importance * 0.5, idA);
    this.db.prepare('DELETE FROM wa_memories WHERE id = ?').run(idB);
    // zx_20261012_1 批二（M26-a）: 承接方（idA）正文已变、旧条（idB）已删 ⇒ 两条旧缓存项一律失效。
    this._embeddingCache.delete(embeddingCacheKey(idA, a.content));
    this._embeddingCache.delete(embeddingCacheKey(idB, b.content));
    return idA;
  }

  /** 存储用户偏好（跨项目，user_id维度） */
  storeUserPreference(params: { user_id: string; content: string; type?: string; source?: string; reasoning?: string }): string {
    const id = randomUUID();
    // 用户偏好跨项目，不绑定特定project_id(避免外键约束失败)
    // zx_20260920_1 M7: 补 `importance` 列——用户偏好本就是「按重要性排序取用」（见 `retrieveByType`/GUI 偏好页），
    //   而此前取表列默认 0.5 ⇒ 读侧 0.6 的门槛对它恒不可达。
    this.db.prepare(
      'INSERT INTO wa_memories (id, project_id, task_id, content, memory_type, importance, source, reasoning, user_id, updated_at) VALUES (?, NULL, NULL, ?, ?, ?, ?, ?, ?, datetime(\'now\'))',
    ).run(id, params.content, params.type ?? 'semantic', MEM_IMPORTANCE_DEFAULT, params.source ?? 'user_instruction', params.reasoning ?? '', params.user_id);
    scheduleMemoryChanged(null, params.type ?? 'semantic');
    return id;
  }

  /** 获取用户偏好（跨项目，按importance+时间排序） */
  getUserPreferences(userId: string, limit = 10): Array<MemoryEntry & { reasoning: string; source: string }> {
    try {
      return this.db.prepare(
        "SELECT * FROM wa_memories WHERE user_id = ? AND memory_type = 'semantic' ORDER BY importance DESC, updated_at DESC LIMIT ?",
      ).all(userId, limit) as Array<MemoryEntry & { reasoning: string; source: string }>;
    } catch { return []; }
  }

  /**
   * 删除用户偏好（`forget_preference` 工具 = 用户明说"忘掉这条"）。
   *
   * zx_20260930 M8: **落墓碑，不再物理删**。偏好行的 `project_id` 为 NULL（跨项目），
   *   故不能走 `tombstoneMemoriesBy`，只能用单条 `tombstoneMemory`。
   *   残留的 `user_id` 无害：读侧 `getUserPreferences` 只认 `memory_type = 'semantic'`。
   */
  deleteUserPreference(memoryId: string, userId: string): boolean {
    const row = this.db.prepare('SELECT id FROM wa_memories WHERE id = ? AND user_id = ?').get(memoryId, userId);
    if (!row) return false;
    return tombstoneMemory(this.db, memoryId, MEM_DELETE_REASONS.userPreference);
  }

  /** C1: 按类型检索项目记忆（如procedural经验）。排序融合提取强度（意义即使用）+ 编码语境 boost。 */
  retrieveByType(memoryType: string, projectId: string, limit = 5, currentArchetype?: string | null, taskText?: string): Array<MemoryEntry & { reasoning: string }> {
    try {
      const rows = this.db.prepare(
        "SELECT * FROM wa_memories WHERE project_id = ? AND memory_type = ? ORDER BY importance DESC, created_at DESC LIMIT ?",
      ).all(projectId, memoryType, limit * 4) as Array<MemoryEntry & { reasoning: string }>;
      const score = (r: MemoryEntry) => {
        const base = 0.4 * r.importance + 0.6 * this.retrievalStrength(r);
        // Phase 3.2 语言游戏：编码语境匹配（同 archetype）给予小幅排序 boost
        const archetype = this._encodingArchetype(r);
        // Phase B 源监控：直接经验优先
        // zx_20261018_1 批七（王阳明·知行合一）：实践成败是**小幅**排序因子——`usage_score` 复用既有
        //   `empiricalReliability`（拉普拉斯平滑 `(s+1)/(s+f+2)`，0 次实践 = 0.5 中性），权重与其余 boost
        //   同档（0.05）。**不覆盖相关度**：base（重要度 0.4 + 提取强度 0.6）仍是主项，成功率高只在同等相关度时
        //   起决胜作用（R-63 的两只标本正是这一支）。
        const raw = base + (currentArchetype && archetype === currentArchetype ? 0.05 : 0) + this._experienceBoost(r) + this._maturityBoost(r) + this._processingDepthBoost(r) + this._effectivenessBoost(r.memory_type, projectId) + this._reusableBoost(r) + USAGE_RELIABILITY_BOOST_WEIGHT * this.empiricalReliability(r);
        // Phase A (2026-08-27) 空性·无常：易变细节(volatile)排序微降
        let s = raw * this._applicabilityPenalty(r) * this._conflictPenalty(r);
        // Phase A (2026-08-27) 空性·缘起：适用条件与当前任务不符 → 排序降权（条件校验落在排序层）
        if (taskText && this.applicabilityMismatch(r, taskText)) s *= 0.6;
        return s;
      };
      rows.sort((a, b) => score(b) - score(a));
      return rows.slice(0, limit);
    } catch { return []; }
  }

  /** Phase 3.2: 读任务原型（编码/提取语境） */
  getTaskArchetype(taskId: string): string | null {
    try {
      const row = this.db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined;
      if (!row) return null;
      const ctx = JSON.parse(row.context_json || '{}');
      return typeof ctx.archetype === 'string' ? ctx.archetype : null;
    } catch { return null; }
  }

  /** A3: 最近同类（同 archetype）成功/失败任务的验收标准，供执行中验收预警对照自查 */
  getPeerAcceptanceCriteria(projectId: string, archetype: string, limit = 3): Array<{ title: string; status: string; acceptance_criteria: string }> {
    try {
      return this.db.prepare(`
        SELECT title, status, acceptance_criteria
        FROM wa_tasks
        WHERE project_id = ? AND parent_task_id = '' AND status IN ('completed','failed')
          AND acceptance_criteria != '' AND json_extract(context_json, '$.archetype') = ?
        ORDER BY updated_at DESC LIMIT ?
      `).all(projectId, archetype, limit) as Array<{ title: string; status: string; acceptance_criteria: string }>;
    } catch { return []; }
  }

  /** Phase 3.2: 读记忆的编码语境 archetype。——批七起委托 `memory-retrieval.ts`。 */
  private _encodingArchetype(mem: MemoryEntry): string | null {
    return encodingArchetype(mem);
  }

  /** Phase 3.2: 读记忆的编码语境关键词（存储时从任务标题/描述提取）。——批七起委托 `memory-retrieval.ts`。 */
  private _encodingKeywords(mem: MemoryEntry): string[] {
    return encodingKeywords(mem);
  }

  /** Phase B: 读记忆的亲历/推断标记（源监控）。——批七起委托 `memory-retrieval.ts`。 */
  private _experienceOf(mem: MemoryEntry): 'direct' | 'inferred' | null {
    return experienceOf(mem);
  }

  /** Phase B: 直接经验优先的检索排序微调（实践论：亲历优先）。——批七起委托 `memory-retrieval.ts`。 */
  private _experienceBoost(mem: MemoryEntry): number {
    return experienceBoost(mem);
  }

  /** Phase A: 成熟知识检索排序微调（大器晚成：成熟记忆略优先）。——批七起委托 `memory-retrieval.ts`。 */
  private _maturityBoost(mem: MemoryEntry): number {
    return maturityBoost(mem);
  }

  /** Phase A (2026-08-27 zx_2) 格物致知：读记忆的加工深度。——批七起委托 `memory-retrieval.ts`。 */
  private _processingDepthOf(mem: MemoryEntry): 'deep' | 'shallow' | null {
    return processingDepthOf(mem);
  }

  /** Phase A (2026-08-27 zx_2) 格物致知：深加工记忆检索排序微调（深加工可迁移性优先）。——批七起委托 `memory-retrieval.ts`。 */
  private _processingDepthBoost(mem: MemoryEntry): number {
    return processingDepthBoost(mem);
  }

  /** A4: 复用价值标记检索加权——context_json.reusable_experience=1 的记忆（含可行动建议的复盘）更易命中。——批七起委托 `memory-retrieval.ts`。 */
  private _reusableBoost(mem: MemoryEntry): number {
    return reusableBoost(mem);
  }

  /** Phase A (2026-08-27) 空性·缘起：读记忆的适用条件 + 稳定性分级。——批七起委托 `memory-retrieval.ts`。 */
  private _applicabilityOf(mem: MemoryEntry): { conditions: string[]; stability: 'stable' | 'volatile' } | null {
    return applicabilityOf(mem);
  }

  /** Phase A (2026-08-27) 空性·无常：易变细节(volatile)排序微降（细节易变不如恒常规律可靠）。——批七起委托 `memory-retrieval.ts`。 */
  private _applicabilityPenalty(mem: MemoryEntry): number {
    return applicabilityPenalty(mem);
  }

  /** A3 (2026-09-02): 记忆干扰管理——冲突/已取代标记降权（前摄/倒摄干扰）。
   * context_json.conflict_flag=true 或 superseded=true 的记忆（待辩证扬弃 / 已被更新的同类经验取代）在检索中降权，
   * 避免把已被矛盾经验或更新的旧信息当权威注入 Agent，直到 dialecticalSublateMemories 将旧记忆扬弃为综合（清除标记）或归档。
   * ——批七起委托 `memory-retrieval.ts`。
   */
  private _conflictPenalty(mem: MemoryEntry): number {
    return conflictPenalty(mem);
  }

  /**
   * Phase A (2026-08-27) 空性·缘起：判断记忆的适用条件是否与当前任务上下文不符。
   * 条件非空且任务文本不含任何条件的任一关键词 → 条件可能已变/不满足。
   * 保守：仅用于降权标注提醒，不硬删记忆。——批七起委托 `memory-retrieval.ts`。
   */
  applicabilityMismatch(mem: MemoryEntry, taskText: string): boolean {
    return retApplicabilityMismatch(mem, taskText);
  }

  /**
   * 9.5d: 同源覆盖——新搜索结果覆盖旧同源记忆，但不能跨源覆盖用户指令。
   *
   * zx_20260930 M8 两处收口：
   * ① 取"旧同源那条"时加 `MEM_LIVE_SQL`——**墓碑不是可覆盖的同源记忆**。
   *    不加则 UPDATE 会落在墓碑行上 ⇒ 正文被写回、`memory_type` 仍是 'deleted'，
   *    也就是**删掉的东西在原地复活**（且因类型未变而不触发任何读取点的提醒）。
   * ② 正文合并改 `boundedSameSource`——覆盖是**同源累加**，无界则每轮把全文再抄一遍，线性膨胀。
   *    未超上限时与旧写法 `a + '\n[更新]\n' + b` **逐字相同**（零行为变化）。
   */
  sameSourceReplace(projectId: string, source: string, content: string, reasoning?: string): string | null {
    if (source === 'user_correction' || source === 'user_instruction') return null; // 永不覆盖用户来源
    const existing = this.db.prepare(
      `SELECT id, content FROM wa_memories WHERE project_id = ? AND source = ? AND ${MEM_LIVE_SQL} ORDER BY created_at DESC LIMIT 1`,
    ).get(projectId, source) as { id: string; content: string } | undefined;
    if (existing) {
      this.db.prepare(
        "UPDATE wa_memories SET content = ?, reasoning = ?, updated_at = datetime('now') WHERE id = ?",
      ).run(boundedSameSource(existing.content, content, { label: '更新' }), reasoning ?? '', existing.id);
      // zx_20261012_1 批二（M26-a）: 同源覆盖也改正文 ⇒ 一并失效旧缓存项（第三个落点，与另两处同一把尺）。
      this._embeddingCache.delete(embeddingCacheKey(existing.id, existing.content));
      return existing.id;
    }
    return null;
  }

  /** 更新记忆的embedding（同时失效向量索引缓存） */
  updateEmbedding(id: string, embedding: number[]): void {
    // zx_20261012_1 批二（M26-a）: 缓存键＝`id`+**正文指纹** ⇒ 先按**旧正文**删旧项，再按**当前正文**写新项。
    const row = this.db.prepare('SELECT content FROM wa_memories WHERE id = ?').get(id) as { content?: string } | undefined;
    this.db.prepare('UPDATE wa_memories SET embedding = ? WHERE id = ?').run(JSON.stringify(embedding), id);
    if (!row) return;
    const key = embeddingCacheKey(id, row.content ?? '');
    this._embeddingCache.delete(key);
    if (embedding.length > 0) this._embeddingCache.set(key, embedding);
  }

  // 12.2: 内存向量索引缓存——避免重复JSON.parse，加速余弦相似度计算
  private _embeddingCache = new Map<string, number[]>();
  private _cacheGeneration = 0;
  // Phase B (2026-08-27): 记忆有效性统计缓存（按项目，30 分钟 TTL）
  private _effectivenessCache = new Map<string, { ts: number; stats: Array<{ memoryType: string; successCount: number; failCount: number; successRate: number; sampleCount: number }> }>();
  private static readonly EFFECTIVENESS_CACHE_TTL = 30 * 60 * 1000;
  private static readonly MAX_CACHE_SIZE = 10_000;

  /** 预热向量索引：批量加载项目内所有embedding到内存，超过上限则随机淘汰旧条目 */
  warmupVectorIndex(projectId: string): number {
    const rows = this.db.prepare(
      "SELECT id, content, embedding FROM wa_memories WHERE project_id = ? AND embedding IS NOT NULL AND embedding != ''",
    ).all(projectId) as Array<{ id: string; content: string; embedding: string }>;
    for (const row of rows) {
      try {
        // 超过上限时随机淘汰20%旧条目
        if (this._embeddingCache.size >= MemoryManager.MAX_CACHE_SIZE) {
          const keys = Array.from(this._embeddingCache.keys());
          const evictCount = Math.ceil(keys.length * 0.2);
          for (let i = 0; i < evictCount; i++) {
            this._embeddingCache.delete(keys[Math.floor(Math.random() * keys.length)]!);
          }
        }
        const emb = JSON.parse(row.embedding) as number[];
        // zx_20261012_1 批二（M26-a）: 键含正文指纹（与 `search`/失效点同一把尺）。
        if (emb.length > 0) this._embeddingCache.set(embeddingCacheKey(row.id, row.content), emb);
      } catch { /* skip invalid */ }
    }
    this._cacheGeneration++;
    logger.info({ projectId, cached: this._embeddingCache.size }, '向量索引已预热');
    return this._embeddingCache.size;
  }

  /**
   * 语义检索（12.2优化：内存向量索引，避免重复JSON.parse）。
   * 首次查询自动预热，后续查询直接使用缓存。
   */
  search(queryEmbedding: number[], projectId: string, topK = 5): MemoryEntry[] {
    if (this._embeddingCache.size === 0) this.warmupVectorIndex(projectId);

    const rows = this.db.prepare(
      // zx_20260911_4 M5-1(赫布/艾宾浩斯·归档即不再激活): 归档墓碑不得再被取回——见 searchBM25/searchByKeywords/getRecent 同一把尺
      `SELECT * FROM wa_memories WHERE project_id = ? AND ${MEM_LIVE_SQL} AND embedding IS NOT NULL AND embedding != '' ORDER BY created_at DESC LIMIT 500`,
    ).all(projectId) as MemoryEntry[];

    if (rows.length === 0) return [];

    const scored = rows.map(row => {
      try {
        // zx_20261012_1 批二（M26-a）: 按 `id`+**本文正文指纹**取缓存——正文变过则键已变，此处必 miss 并重取。
        const embKey = embeddingCacheKey(row.id, row.content ?? '');
        const emb = this._embeddingCache.get(embKey) ?? (() => {
          const parsed = JSON.parse(row.embedding!) as number[];
          if (parsed.length > 0) this._embeddingCache.set(embKey, parsed);
          return parsed;
        })();
        const semantic = cosineSimilarity(queryEmbedding, emb);
        const retrieval = this.retrievalStrength(row);
        // A4: reusable_experience=1 记忆小幅加权，相似任务识别更易命中
        // zx_20260929 M4（同一个降权三处是三个意思）: 补 `_applicabilityPenalty` —— 与 `retrieveByType` 同尺。
        //   此前易变细节（volatile）只在按类型检索时微降（×0.95），走语义检索却一点不降
        //   ⇒「这条易变知识算不算数」取决于它**碰巧从哪条路被取回**，而调用方无从知道。
        const score = (0.6 * semantic + 0.25 * retrieval + 0.15 * row.importance + this._reusableBoost(row))
          * this._applicabilityPenalty(row) * this._conflictPenalty(row);
        return { ...row, score };
      } catch { return { ...row, score: 0 }; }
    });

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /** BM25词法搜索（使用FTS5）。——批七起委托 `memory-retrieval.ts`。 */
  searchBM25(query: string, projectId: string, topK = 10): MemoryEntry[] {
    return retSearchBM25(this, query, projectId, topK);
  }

  /** 文本检索（无embedding时的回退方案）。——批七起委托 `memory-retrieval.ts`。 */
  searchByKeywords(keywords: string[], projectId: string, topK = 5): MemoryEntry[] {
    return retSearchByKeywords(this, keywords, projectId, topK);
  }

  /** A2 (2026-09-02): 提取实践效应（retrieval practice / testing effect，Karpicke & Roediger 2008）。
   * 相似任务开始前主动"回忆"相关记忆，并用当前任务文本做适用性检验：适用（applicabilityMismatch=false）
   * 的记忆以高于被动再暴露（recordAccess use_count+1）的强度加固（use_count+3，log2 压缩下模拟多次主动回忆，
   * 使"值得复用且当前适用"的记忆更易在后续检索/相似任务识别中胜出）；条件不匹配的记忆不加成（避免误强化过时记忆）。
   * 区别于 spacedRepetition（被动重读）与 recordAccess（被动访问）——这是主动回忆测试。
   * 纯同步、无 LLM 依赖（关键词召回），返回被加固的记忆条数；best-effort 静默。
   */
  retrievalPractice(taskText: string, projectId: string, topK = 5): number {
    return retRetrievalPractice(this, taskText, projectId, topK);
  }

  /**
   * 混合检索：BM25词法 + 向量语义 + RRF融合。
   * 结合精确关键词匹配和语义理解，比单一方法命中率高。
   */
  searchHybrid(queryText: string, queryEmbedding: number[] | null, projectId: string, topK = 5): MemoryEntry[] {
    return retSearchHybrid(this, queryText, queryEmbedding, projectId, topK);
  }

  /** 获取项目最近记忆（zx_20260911_4 M5-1: 归档墓碑不计入"最近"——存→取往返须排除已归档）。——批七起委托 `memory-retrieval.ts`。 */
  getRecent(projectId: string, limit = 20): MemoryEntry[] {
    return retGetRecent(this, projectId, limit);
  }

  /** 9.5c: 获取项目级语义记忆（跨任务知识）。排序融合提取强度（意义即使用）。——批七起委托 `memory-retrieval.ts`。 */
  getProjectKnowledge(projectId: string, limit = 5): Array<MemoryEntry & { reasoning: string; source: string }> {
    return retGetProjectKnowledge(this, projectId, limit);
  }

  /**
   * zx_20261014_4 批五: 项目域知识册（零 LLM 派生册）——消费侧的唯一读口。
   *   ⚠ 与 `getProjectKnowledge`（上面那个：`wa_memories` 里的 **semantic 记忆**）**不是一回事**：
   *     那份是"模型综合过的记忆"，这份是**从四类真源直接派生的结构化事实**（零 LLM、可复现）。
   *   薄委托到 `project-knowledge.ts`（本模块不另抄那份 SQL；"一个数只有一个来源"）。
   */
  listDomainKnowledge(projectId: string): ProjectKnowledgeEntry[] {
    return listProjectKnowledge(this.db, projectId);
  }

  /**
   * zx_20261023_5 批二: 某项目**可注入**的知识卡（active）。
   * 生成与注入都挂 Pro（`knowledge_cards`）；**降档不回收已生成的卡**——卡仍在表里，
   * 只是当前档位读回空数组（与领域包"闸只挡搬运/生成、不抹已存在的资产"同一把尺）。
   */
  listKnowledgeCards(projectId: string): KnowledgeCard[] {
    if (proFeatureRefusal(this.db, KNOWLEDGE_CARD_FEATURE) !== null) return [];
    return listActiveKnowledgeCards(this.db, projectId);
  }

  /**
   * zx_20261021_3 批一: 某项目**已启用**的领域包（按启用时序；坏包跳过）。
   * 薄委托到 `domain-pack.ts`——本模块不另抄 SQL/解析。
   */
  listAppliedDomainPacks(projectId: string): AppliedDomainPack[] {
    return listAppliedDomainPacks(this.db, projectId);
  }

  /**
   * zx_20261022_3 批八: 本项目画像（含启用位/出处）；无画像或坏 JSON ⇒ `null`。
   * 薄委托到 `project-profile.ts`——本模块不另抄解析，也不替调用方判断"能否注入"。
   */
  listProjectProfile(projectId: string): StoredProjectProfile | null {
    return readProjectProfile(this.db, projectId);
  }

  /** 获取未嵌入的记忆（供批处理）。——批七起委托 `memory-retrieval.ts`。 */
  getUnembedded(limit = 10): MemoryEntry[] {
    return retGetUnembedded(this, limit);
  }

  /** 批量记录记忆访问追踪（仅更新use_count/last_used_at，不修改importance） */
  recordAccess(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(
      `UPDATE wa_memories SET use_count = use_count + 1, last_used_at = datetime('now') WHERE id IN (${placeholders})`,
    ).run(...ids);
  }

  /**
   * zx_20261018_3 批一（王阳明·知行合一 / 维特根斯坦·意义即用法）: 记录"这条记忆**被注入了上下文**"。
   *
   * 与 `recordAccess` 的分界：注入是**见过**（模型被动读到），`recordAccess` 是**用过**
   *   （模型经 `memory_search` 主动取用）。旧实现让注入直接 `use_count + 1`，两件事挤在一个数里——
   *   注入越勤的记忆越像"被用过"，排序与再巩固都据此误判。
   * 只更 `injected_count` / `last_injected_at`，**不碰** `use_count`。
   */
  recordInjection(ids: string[]): void {
    if (ids.length === 0) return;
    const placeholders = ids.map(() => '?').join(',');
    this.db.prepare(
      `UPDATE wa_memories SET injected_count = injected_count + 1, last_injected_at = datetime('now') WHERE id IN (${placeholders})`,
    ).run(...ids);
  }

  /**
   * zx_20261018_1 批七（管子·度量衡／知行合一）：把**这次真正注入上下文的东西**记成一笔明细账。
   *
   * · `knowledge`：逐节一行（`ref_id` = 节名，`chars` = 该节渲染字数）——由 `buildMemoryContext` 同一次
   *   构造里产出，不经二次解析猜边界。
   * · `memoryIds`：真入文的记忆 id（`accessedIds`）。每行 `chars` 取该记忆**正文**长度（注入时正文按
   *   300 字截断，故同样封顶 300）——它是"这条记忆自身多大"，不是渲染行长；分账总量另由
   *   `token_breakdown.memory` 记真体积（两本账刻意分家：一本回答"注入了谁"，一本回答"一共多少字"）。
   * · `profiles`（zx_20261022_3 批八）：画像一段一行（`ref_id` = `profile:<hash12>`，即"注入了哪一版"）。
   * · `cards`（zx_20261023_5 批二）：蒸馏卡一张一行（`ref_id` = 卡的稳定 id `kc-<hash8>`，`chars` = 该卡
   *   渲染行字数）——用它回答"这次到底哪几张卡真进了上下文"，而不是只报一个总 token 数。
   *
   * **唯一键 `(task_id, source, ref_id)` + `INSERT OR IGNORE`**：resume/多次装配重复注入只留一行（R-62）。
   * 返回**新写入**行数（0→1 的正面计数即由此可断言）。
   */
  recordContextInjections(taskId: string, input: { knowledge?: Array<{ ref_id: string; chars: number }>; memoryIds?: string[]; domainPacks?: Array<{ ref_id: string; chars: number }>; profiles?: Array<{ ref_id: string; chars: number }>; cards?: Array<{ ref_id: string; chars: number }> }): number {
    const ins = this.db.prepare(
      `INSERT OR IGNORE INTO wa_context_injections (id, task_id, source, ref_id, chars, est_tokens, outcome)
       VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    );
    let written = 0;
    for (const k of input.knowledge ?? []) {
      const chars = Math.max(0, Math.floor(k.chars));
      written += ins.run(randomUUID(), taskId, 'knowledge', k.ref_id, chars, estimateTokensFromChars(chars)).changes;
    }
    // zx_20261021_3 批一: 领域包逐包一行（`ref_id` = 包 id，`chars` = 该包渲染块字数）。
    for (const k of input.domainPacks ?? []) {
      const chars = Math.max(0, Math.floor(k.chars));
      written += ins.run(randomUUID(), taskId, 'domain_pack', k.ref_id, chars, estimateTokensFromChars(chars)).changes;
    }
    // zx_20261022_3 批八: 画像一段一行（`ref_id` = `profile:<hash12>`，`chars` = 该段渲染字数）。
    for (const k of input.profiles ?? []) {
      const chars = Math.max(0, Math.floor(k.chars));
      written += ins.run(randomUUID(), taskId, 'project_profile', k.ref_id, chars, estimateTokensFromChars(chars)).changes;
    }
    // zx_20261023_5 批二: 蒸馏卡一张一行（`ref_id` = 卡 id，`chars` = 该卡渲染行字数）。
    for (const k of input.cards ?? []) {
      const chars = Math.max(0, Math.floor(k.chars));
      written += ins.run(randomUUID(), taskId, 'knowledge_card', k.ref_id, chars, estimateTokensFromChars(chars)).changes;
    }
    for (const id of input.memoryIds ?? []) {
      let chars = 0;
      try {
        const row = this.db.prepare('SELECT LENGTH(content) AS n FROM wa_memories WHERE id = ?').get(id) as { n: number | null } | undefined;
        chars = Math.min(300, Math.max(0, Number(row?.n) || 0));
      } catch { /* 读不到正文 ⇒ 记 0 字（行仍然在，"注入过"这件事实不丢） */ }
      written += ins.run(randomUUID(), taskId, 'memory', id, chars, estimateTokensFromChars(chars)).changes;
    }
    return written;
  }

  /**
   * zx_20261018_1 批七：任务收口时按注入账回填成败（R-61）。
   * 只回填 `pending`——已在上一轮结清的账不再改写（同一任务同一记忆的结局只记一次）。
   * 返回回填行数。
   */
  backfillInjectionOutcomes(taskId: string, outcome: 'completed' | 'failed'): number {
    return this.db.prepare(
      `UPDATE wa_context_injections SET outcome = ?, updated_at = datetime('now')
       WHERE task_id = ? AND outcome = 'pending'`,
    ).run(outcome, taskId).changes;
  }

  /** Phase 1.3 意义即使用：派生"提取强度"。——批七起委托 `memory-retrieval.ts`。 */
  retrievalStrength(mem: MemoryEntry): number {
    return retRetrievalStrength(mem);
  }

  /** Phase 2.2 自知者明：经验可靠性（元记忆）。——批七起委托 `memory-retrieval.ts`。 */
  empiricalReliability(mem: MemoryEntry): number {
    return retEmpiricalReliability(mem);
  }

  /** Phase A (2026-08-26) 大器晚成：知识成熟度。——批七起委托 `memory-retrieval.ts`。 */
  maturityOf(mem: MemoryEntry): number {
    return retMaturityOf(mem);
  }

  /** Phase 2.1 实事求是：派生记忆可信度（confidence）。——批七起委托 `memory-retrieval.ts`。 */
  confidenceOf(mem: MemoryEntry): number {
    return retConfidenceOf(mem);
  }

  /**
   * Phase 1.2: 实践反馈强化——任务完成后根据质量反馈到关联记忆的importance。
   * 成功任务强化关联记忆，失败任务轻微降权。
   *
   * zx_20260930 M6（夏克特·错误归因）：**只有"本次真被用上"的记忆才配受奖罚**。
   *   ① 使用证据 = `context_json.memory_used_ids_run`（`buildMemoryContext` 本 run 的真入文集合，**每 run 覆盖**）。
   *      它**不是** `injected_memory_ids`——后者是**跨 run 的 union**（供排重），拿它当"本次用过"就是把前几次
   *      run 用过的记忆一并算到本次成败头上，那正是"一次失败连坐全部注入记忆"的病根。
   *   ② 降权还须**可指认**（`failureAnchors` / `isAttributable`）：失败自己留下的字据里取不到硬锚点
   *      ⇒ 指认不了 ⇒ **只记计数**，不降权、不打 `staleness`（承 M2-(c)「只在真知道时标」）。
   *   ③ 老任务读不到 ① 的键 ⇒ 同样**只记计数**（`_bumpCount`），不奖不罚——宁可少标，不可乱标。
   *
   * ⚠ 删去的旧"关键词重叠回退"（无注入记录时按标题/会话词面重叠猜关联）：它**不是** `recordAccess` 命中，
   *   拿它打 `staleness` 就是同一个错误归因换了个入口。没有使用证据时正确动作是"什么都不做"，不是"猜一批"。
   */
  reinforceMemories(taskId: string, projectId: string, success: boolean, qualityScore?: number): number {
    try {
      // zx_20261018_1 批七：注入账的结局**先回填**（含"只有知识注入、没有记忆入文"的任务——
      //   旧实现首行 `usedIds.length === 0` 就早退，那些知识注入行会永远停在 pending）。
      //   ⚠ 本处**只改 outcome**，不碰 `success_count/failure_count`：那两个计数器的唯一写口
      //   仍是下面的 `_bumpCount` / `_applyReinforcement`（同一任务同一记忆只记一次由其 per-run 集保证）。
      //   ⚠ 账是**附带**、强化是**主事**：回填失败只留痕，绝不连坐整轮强化（否则一张账写不动
      //   就把 reinforcement 整个吞掉——实测夹具无此表时 20+ 条旧断言全红）。
      try { this.backfillInjectionOutcomes(taskId, success ? 'completed' : 'failed'); }
      catch (err) { recordMemoryFailure(MEM_FAIL.injectionBackfill, err, { taskId, projectId }); }
      const perRun = this._readRunMemoryIds(taskId);
      const usedIds = perRun ?? this._readInjectedMemoryIds(taskId);
      if (usedIds.length === 0) return 0;

      // 失败侧先取锚点，锚点**只从失败自己留下的字据里取**（`failure_record` ∪ 任务标题实词）。
      // ⚠ 锚点非空**不等于**这批记忆都可指认：还要看本条的正文/证据锚点里是否真出现某个锚点。
      //   `failure_record === null`（非"无产出物"的异常失败路）时通常只剩标题实词，而多数记忆的正文
      //   不会逐字含任务标题 ⇒ 它们照样落进"只记计数"那一支。真正的分界在 `_isMemoryAttributable`。
      const anchors = success ? [] : this._readFailureAnchors(taskId);
      let touched = 0;
      for (const id of usedIds) {
        if (perRun === null) {
          this._bumpCount(id, success ? 'success_count' : 'failure_count');
          touched++;
          continue;
        }
        if (success) {
          if (this._applyReinforcement(id, true, qualityScore, taskId)) touched++;
          continue;
        }
        if (anchors.length > 0 && this._isMemoryAttributable(id, anchors)) {
          if (this._applyReinforcement(id, false, qualityScore, taskId)) touched++;
        } else {
          this._bumpCount(id, 'failure_count');
          touched++;
        }
      }
      if (touched > 0) {
        logger.info(
          { taskId: taskId.slice(0, 8), projectId: projectId.slice(0, 8), success, touched, perRun: perRun !== null, anchors: anchors.length },
          '记忆反馈强化完成',
        );
      }
      // zx_20261012_1 批二（M26-b）共现强化（赫布）：同一 run **同期入文**的记忆互相加权。
      //   只认**本次真入文**集合（`perRun`）——`union`（injected_memory_ids）是跨 run 累计，
      //   拿它当"同期"就是把不同 run 的记忆硬绑一起（与 M6 的错误归因同形）。单条入文 ⇒ 无共现可言。
      //   失败路不奖（与上面的奖罚方向一致）：只 `_bumpCount`，不动 importance。
      if (success && perRun !== null && usedIds.length >= 2) {
        const co = this._reinforceCooccurrence(usedIds);
        if (co > 0) logger.info({ taskId: taskId.slice(0, 8), coActivated: usedIds.length, boosted: co }, '记忆共现强化（同期入文者互相加权）');
      }
      return touched;
    } catch (err) {
      recordMemoryFailure(MEM_FAIL.reinforceRun, err, { taskId, projectId });
      logger.warn({ err, taskId: taskId.slice(0, 8) }, '记忆强化失败');
      return 0;
    }
  }

  /**
   * zx_20261012_1 批二（M26-b）：共现强化——同一 run 同期入文的记忆两两互相加权（赫布：一起激活的连一起）。
   *
   * 与 `_applyReinforcement` 的**奖罚**是两回事：后者按"本次用得好不好"加减，本函数只表达
   * "这几条**同时**被想起过"这一结构事实，幅度小（`CO_OCCUR_BOOST`）、只加不减、有上界 1.0。
   * 调用点已在 `reinforceMemories` 内**按 `perRun` 与"≥2 条"两道闸**收窄，本函数不再重复判。
   */
  private _reinforceCooccurrence(ids: string[]): number {
    let boosted = 0;
    for (const id of ids) {
      try {
        const r = this.db.prepare(
          "UPDATE wa_memories SET importance = MIN(1.0, importance + ?), updated_at = datetime('now') WHERE id = ?",
        ).run(CO_OCCUR_BOOST, id);
        if ((r?.changes ?? 0) > 0) boosted++;
      } catch (err) { recordMemoryFailure(MEM_FAIL.cooccurBump, err, { id }); }
    }
    return boosted;
  }

  /** Phase 1.2: 读任务**累计注入**的记忆 ID（union，供后续 run 排重；无则返回空） */
  private _readInjectedMemoryIds(taskId: string): string[] {
    try {
      const row = this.db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined;
      if (!row) return [];
      const ctx = JSON.parse(row.context_json || '{}');
      const ids = ctx.injected_memory_ids as unknown;
      return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [];
    } catch { return []; }
  }

  /**
   * zx_20260930 M6: 读**本次 run 真入文**的记忆 ID（`context_json.memory_used_ids_run`）。
   * 键不存在（本轮之前的存量任务）返回 `null`，与"空数组"**刻意区别**——前者是"不知道"，后者是"知道没用"。
   */
  private _readRunMemoryIds(taskId: string): string[] | null {
    try {
      const row = this.db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined;
      if (!row) return null;
      const ctx = JSON.parse(row.context_json || '{}');
      const ids = ctx.memory_used_ids_run as unknown;
      return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : null;
    } catch { return null; }
  }

  /** zx_20260930 M6: 失败自己留下的字据里能取到的硬锚点（`failure_record` ∪ 任务标题实词）；取不到返回空数组。 */
  private _readFailureAnchors(taskId: string): string[] {
    try {
      const row = this.db.prepare('SELECT title, context_json FROM wa_tasks WHERE id = ?').get(taskId) as { title: string | null; context_json: string } | undefined;
      if (!row) return [];
      const ctx = JSON.parse(row.context_json || '{}') as { failure_record?: FailureRecord | null };
      return failureAnchors(ctx.failure_record ?? null, row.title || '');
    } catch { return []; }
  }

  /** zx_20260930 M6: 该记忆与本次失败是否可指认关联（正文或 `context_json.evidence.file_path` 里出现任一硬锚点）。 */
  private _isMemoryAttributable(memId: string, anchors: string[]): boolean {
    try {
      const row = this.db.prepare('SELECT content, context_json FROM wa_memories WHERE id = ?').get(memId) as { content: string | null; context_json: string | null } | undefined;
      if (!row) return false;
      let evidencePath: string | null = null;
      try {
        const ctx = JSON.parse(row.context_json || '{}') as { evidence?: { file_path?: string | null } };
        evidencePath = ctx.evidence?.file_path ?? null;
      } catch { /* 非法 context_json ⇒ 只按正文判 */ }
      return isAttributable(row.content || '', anchors, evidencePath);
    } catch { return false; }
  }

  /** zx_20260930 M6: **只记计数**——不动 importance、不打 `staleness`。"指认不了"时唯一该做的事。 */
  private _bumpCount(memId: string, col: 'success_count' | 'failure_count'): void {
    try {
      this.db.prepare(`UPDATE wa_memories SET ${col} = ${col} + 1 WHERE id = ?`).run(memId);
    } catch (err) { recordMemoryFailure(MEM_FAIL.reinforceBumpCount, err, { memId, col }); }
  }

  /** Phase 1.2: 对单条记忆施加强化/降权，返回是否成功。Phase B: 失败时标记 staleness（实践反驳）。 */
  private _applyReinforcement(memId: string, success: boolean, qualityScore?: number, taskId?: string): boolean {
    try {
      if (success) {
        const q = (qualityScore || 70) / 100;
        const delta = 0.1 * q; // 成功→强化
        this.db.prepare(
          "UPDATE wa_memories SET importance = MIN(1.0, importance + ?), success_count = success_count + 1, last_reinforced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
        ).run(Math.round(delta * 100) / 100, memId);
        // Phase B (2026-08-26): 成功重新验证 → 清除 staleness（实践重新验证，记忆不再"可能过时"）
        try {
          const row = this.db.prepare('SELECT context_json FROM wa_memories WHERE id = ?').get(memId) as { context_json: string } | undefined;
          if (row) {
            const ctx = JSON.parse(row.context_json || '{}');
            if (ctx.staleness) {
              delete ctx.staleness;
              this.db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), memId);
            }
          }
        } catch { /* ignore */ }
      } else {
        const delta = -0.05; // 失败→轻微降权
        this.db.prepare(
          "UPDATE wa_memories SET importance = MAX(0.05, importance + ?), failure_count = failure_count + 1, last_reinforced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
        ).run(Math.round(delta * 100) / 100, memId);
        // Phase B (2026-08-26) 记忆事实保鲜：被注入使用的记忆导致失败 → 标记可能过时（实践反驳）
        if (taskId) {
          try {
            const row = this.db.prepare('SELECT context_json FROM wa_memories WHERE id = ?').get(memId) as { context_json: string } | undefined;
            if (row) {
              const ctx = JSON.parse(row.context_json || '{}');
              ctx.staleness = { contradicted_at: new Date().toISOString(), failed_task: taskId };
              this.db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), memId);
            }
          } catch { /* ignore */ }
        }
      }
      return true;
    } catch (err) { recordMemoryFailure(MEM_FAIL.reinforceApply, err, { memId, success }); return false; }
  }

  /**
   * 分层检索：返回短期(最近N条) + 中期(高重要性无嵌入) + 长期(语义相似)的三层结果。
   *
   * zx_20260930 M7-d：加 `opts.longTermK` **放宽长期层的候选池**（默认 = `topK` ⇒ 旧行为逐字不变）。
   *   调用方 `retrieveTaskRelevant` 要在长期层里再分"情景/语义"两层各排各的 ⇒ 池子必须比最终条数宽，
   *   否则一层就被 topK 卡死、无从分层。刻意**不改返回类型、不动默认值**（"加可选参数，不改签名语义"）——
   *   既有调用点一字不动。注意 `midTerm` 仍按 `topK` 取：本参数问的是**长期层**的池宽。
   */
  retrieveLayered(queryText: string, queryEmbedding: number[] | null, projectId: string, topK = 5, opts?: { longTermK?: number }): {
    shortTerm: MemoryEntry[];
    midTerm: MemoryEntry[];
    longTerm: MemoryEntry[];
  } {
    return retRetrieveLayered(this, queryText, queryEmbedding, projectId, topK, opts);
  }

  /**
   * Phase 1.1 补充：任务相关记忆检索（三层检索的长期层落地）。
   * 用当前任务的 title+description 作为查询、复用任务启动时已生成的 task_embedding，
   * 召回与当前任务语义相关的历史记忆，弥补类型检索"只看 importance、不看任务相关性"的缺陷。
   *
   * zx_20260930 M7-d（Tulving《情景记忆的要素》）: **检索层分层**。此前这里只取 `longTerm`——
   *   那是 `search()` 一个混合分排出的 top-K，情景记忆与语义记忆在同池同分里争名额，
   *   语义分高的那层把情景层整体挤出去。现改为：先把长期层候选池**放宽**（`longTermK = max(4·topK, 20)`），
   *   再按 Tulving 二分**各排各的**（情景=近因、语义=0.4·重要度+0.6·提取强度），最后**轮转交织**取 `topK`。
   *   候选池的**排除语义一字未动**（仍排除最近 5 条与高重要度中期层）——本处只加"分层"这一跳。
   *
   * zx_20260930 M7-f（巴特莱特·图式重构召回）: 末跳再加**一次按当下需求的重建**——`schemaText`
   *   （由调用方从"任务立志 + 主要矛盾"拼出，**不是**题面本身）作为图式，对交织结果重排。
   *   为什么必须**从外部传图式**而非就地拿 `title+description`：题面正是本函数上游 `queryText` 的取数源
   *   ——拿它当图式，等于用**同一把逐字尺**再量一遍，那是自我印证而非重建。
   *   开关 `memory.schema_recall`（缺省即开）关掉即回旧口径，供 A/B；`schemaText` 缺省（`''`）时
   *   `applySchemaRecall` 判不出图式 ⇒ 原序返回 ⇒ **既有调用点（不传第四参）行为一字不变**。
   *   成员集不动（只重排，见 `memory-select.ts` 该函数注释）——本处不新增任何丢点。
   */
  retrieveTaskRelevant(taskId: string, projectId: string, topK = 5, schemaText = ''): MemoryEntry[] {
    return retRetrieveTaskRelevant(this, taskId, projectId, topK, schemaText);
  }

  /** zx_20261018_3 批一: 同一次检索，外加**来源**（embedding / cue / none）——无向量时不再静默为空。 */
  retrieveTaskRelevantWithSource(taskId: string, projectId: string, topK = 5, schemaText = ''): { memories: MemoryEntry[]; source: TaskRelevantSource } {
    return retRetrieveTaskRelevantWithSource(this, taskId, projectId, topK, schemaText);
  }

  /** 合并相似记忆：将相似度>0.9的记忆合并为一条。——批七起委托 `memory-consolidation.ts`。 */
  consolidateMemories(projectId: string): number {
    return consConsolidateMemories(this, projectId);
  }

  /** Phase 7.4: 记忆整合管道——去重+冲突解决+遗忘。——批七起委托 `memory-consolidation.ts`。 */
  runConsolidationPipeline(projectId: string): { deduped: number; conflicts: number; forgotten: number; challenged: number; pruned: number } {
    return consRunPipeline(this, projectId);
  }

  /** Phase 2.3 反者道之动：定期质疑"importance 高但从未被验证/使用"的记忆。——批七起委托 `memory-consolidation.ts`。 */
  challengeOverconfident(projectId: string): number {
    return consChallengeOverconfident(this, projectId);
  }

  /** Phase 3.2 为道日损：主动精简冗余/低价值/过期冲突记忆。——批七起委托 `memory-consolidation.ts`。 */
  pruneMemories(projectId: string): number {
    return consPruneMemories(this, projectId);
  }

  /** Phase 3.1 间隔重复：对高价值记忆按递增间隔重放校验。——批七起委托 `memory-consolidation.ts`。 */
  async spacedRepetition(projectId: string): Promise<number> {
    return consSpacedRepetition(this, projectId);
  }

  /** Phase 3.2: 矛盾检测——基于内容重叠+效价对比，检测新旧记忆冲突并自动处理。——批七起委托 `memory-consolidation.ts`。 */
  detectAndResolveConflicts(projectId: string): number {
    return consDetectConflicts(this, projectId);
  }

  /** Phase (2026-08-31) 记忆冲突的辩证升华（黑格尔辩证法·正反合 + 否定之否定）。——批七起委托 `memory-consolidation.ts`。 */
  async dialecticalSublateMemories(projectId: string): Promise<number> {
    return consDialecticalSublate(this, projectId);
  }

  /** 存储知识三元组（去重：同subject+predicate+object+project_id不重复插入）——M14 起委托 `memory-kg.ts`。 */
  storeTriple(params: { projectId: string; subject: string; predicate: string; object: string; confidence?: number; source?: string }): string | null {
    return kgStoreTriple(this, params);
  }

  /** 知识图谱检索：1-2跳邻域扩展——M14 起委托 `memory-kg.ts`。 */
  searchKnowledgeGraph(query: string, projectId: string, limit = 10): Array<{ subject: string; predicate: string; object: string; confidence: number }> {
    return kgSearchKnowledgeGraph(this, query, projectId, limit);
  }

  /**
   * Phase 3.1 家族相似性：从任务标题/描述提取关键词，查询知识图谱，返回去重后的相关三元组。
   * 优先【】内领域词，其次长度>1的中英文词（过滤常见虚词），限前3个查询词。——M14 起委托 `memory-kg.ts`。
   */
  retrieveKnowledgeGraphContext(taskId: string, projectId: string, limit = 5): Array<{ subject: string; predicate: string; object: string }> {
    return kgRetrieveKnowledgeGraphContext(this, taskId, projectId, limit);
  }

  /** 简单三元组提取：从文本中提取常见关系模式——M14 起委托 `memory-kg.ts`。 */
  extractTriples(text: string, projectId: string): number {
    return kgExtractTriples(this, text, projectId);
  }

  /** LLM驱动的三元组提取：用低成本模型从文本中提取关系——M14 起委托 `memory-kg.ts`。 */
  async extractTriplesWithLLM(text: string, projectId: string, taskId: string): Promise<number> {
    return kgExtractTriplesWithLLM(this, text, projectId, taskId);
  }

  // ==================== P1.3 范例驱动规则 ====================

  /** 标记一条记忆为范例（正例或反例）。——批七起委托 `memory-exemplars.ts`。 */
  markExemplar(id: string, type: 'good' | 'bad', context?: { archetype?: string; trigger?: string; toolSequence?: string[] }): void {
    exMarkExemplar(this, id, type, context);
  }

  /** 取消范例标记。——批七起委托 `memory-exemplars.ts`。 */
  unmarkExemplar(id: string): void {
    exUnmarkExemplar(this, id);
  }

  /** 获取项目的范例记忆（effectRank=true 时按"被真正应用"证据优先）。——批七起委托 `memory-exemplars.ts`。 */
  getExemplars(projectId: string, type?: 'good' | 'bad', limit = 5, effectRank = false): Array<{ id: string; content: string; type: string; context: unknown }> {
    return exGetExemplars(this, projectId, type, limit, effectRank);
  }

  /** 生成范例上下文字符串（注入Agent system prompt）。——批七起委托 `memory-exemplars.ts`。 */
  generateExemplarContext(projectId: string, opts?: { excluded?: ReadonlySet<string>; outIds?: string[] }): string {
    return exGenerateExemplarContext(this, projectId, opts);
  }

  // ==================== P1.4 家族相似聚类 ====================

  /** 为已完成任务生成embedding并存储到context_json */
  async generateTaskEmbedding(taskId: string, projectId: string): Promise<void> {
    try {
      const task = this.db.prepare('SELECT title, description FROM wa_tasks WHERE id = ?').get(taskId) as { title: string; description: string } | undefined;
      if (!task) return;
      const taskText = `${task.title}. ${(task.description || '').slice(0, 500)}`;
      const emb = await this._embedText(taskText);
      if (emb && emb.length > 0) {
        const ctx = JSON.parse((this.db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}');
        ctx.task_embedding = emb;
        this.db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), taskId);
      }
    } catch { /* best-effort */ }
  }

  /** 查找与给定任务最相似的历史任务（基于余弦相似度）。——批七起委托 `memory-exemplars.ts`。 */
  findSimilarTasks(projectId: string, taskId?: string, limit = 5): Array<{ id: string; title: string; status: string; similarity: number }> {
    return exFindSimilarTasks(this, projectId, taskId, limit);
  }

  /** A1 (2026-09-01): 相似历史任务经验提炼。——批七起委托 `memory-exemplars.ts`。 */
  getSimilarTaskExperience(projectId: string, taskId: string, limit = 3, precomputed?: Array<{ id: string; title: string; status: string; similarity: number }>, opts?: { excluded?: ReadonlySet<string>; outIds?: string[] }): string {
    return exGetSimilarTaskExperience(this, projectId, taskId, limit, precomputed, opts);
  }

  /** 跨项目查找相似任务。——批七起委托 `memory-exemplars.ts`。 */
  findCrossProjectSimilarTasks(projectId: string, taskId?: string, limit = 3): Array<{ id: string; title: string; projectName: string; similarity: number }> {
    return exFindCrossProjectSimilarTasks(this, projectId, taskId, limit);
  }

  /** Phase C (2026-08-26) 家族相似：跨项目知识迁移。——批七起委托 `memory-exemplars.ts`。 */
  getCrossProjectKnowledge(projectId: string, taskId: string, topK = 3): Array<{ id: string; content: string; projectName: string; memoryType: string }> {
    return exGetCrossProjectKnowledge(this, projectId, taskId, topK);
  }

  // ==================== Phase 2.2: 家族相似性聚类 ====================

  /** Jaccard相似度聚类：同一项目内语义相似的记忆自动关联。——批七起委托 `memory-exemplars.ts`。 */
  clusterSimilarMemories(projectId: string): { linked: number } {
    return exClusterSimilarMemories(this, projectId);
  }

  /** 公开的文本向量化入口（供 search_project_memory 等工具生成查询向量） */
  async embedText(text: string): Promise<number[] | null> {
    return this._embedText(text);
  }

  /** 公开余弦相似度（暴露内部 _cosineCalc，供 task-archetype 语义分类使用） */
  cosineSimilarity(a: number[], b: number[]): number {
    return this._cosineCalc(a, b);
  }

  /** 原型 embedding 缓存（6 原型 FAMILY_REPRESENTATIVES 描述，首次生成后复用） */
  private _archetypeEmbeddings: Map<string, number[]> | null = null;

  /** B1 (2026-08-31) 语义分类：任务文本 embedding vs 原型描述 embedding，返回相似度最高的原型 */
  async classifyArchetypeByEmbedding(taskText: string, representatives: Record<string, string>): Promise<{ archetype: string; score: number } | null> {
    try {
      const taskEmb = await this._embedText(taskText);
      if (!taskEmb || taskEmb.length === 0) return null;
      if (!this._archetypeEmbeddings || this._archetypeEmbeddings.size === 0) {
        this._archetypeEmbeddings = new Map();
        for (const [archetype, desc] of Object.entries(representatives)) {
          const emb = await this._embedText(desc);
          if (emb && emb.length > 0) this._archetypeEmbeddings.set(archetype, emb);
        }
      }
      if (this._archetypeEmbeddings.size === 0) return null;
      let best: { archetype: string; score: number } | null = null;
      for (const [archetype, emb] of this._archetypeEmbeddings) {
        const sim = this._cosineCalc(taskEmb, emb);
        if (!best || sim > best.score) best = { archetype, score: sim };
      }
      return best;
    } catch { return null; }
  }

  /** 内部：调用ANS获取文本embedding */
  private async _embedText(text: string): Promise<number[] | null> {
    try {
      const embModel = await this.ansClient.getOptimalModel({ capabilities: ['embedding'] });
      if (!embModel?.url) return null;
      const baseUrl = embModel.url.replace(/\/$/, '');
      // Ollama 原生 /api/embed 或已含 /embeddings 的端点直接用；OpenAI 兼容端点(url含/v1)追加 /embeddings
      const embUrl = baseUrl.includes('/api/embed') || baseUrl.includes('/embeddings')
        ? baseUrl : `${baseUrl}/embeddings`;
      const resp = await fetch(embUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${embModel.api_key || ''}` },
        body: JSON.stringify({ input: text.slice(0, 4000), model: embModel.model_name || 'text-embedding-3-small' }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!resp.ok) return null;
      const json = await resp.json() as { data?: Array<{ embedding: number[] }>; embeddings?: number[][] };
      // 兼容 OpenAI（data[0].embedding）与 Ollama（embeddings[0]）两种返回格式
      return json.data?.[0]?.embedding || json.embeddings?.[0] || null;
    } catch { return null; }
  }

  /** 内部：余弦相似度计算（类内部使用，避免直接调用外部函数） */
  private _cosineCalc(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! ** 2;
      normB += b[i]! ** 2;
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  // ==================== Phase 3.1 前瞻记忆 ====================

  /** 登记前瞻记忆（记住未来要做的事）。trigger_condition 为事件型文本，due_at 为时间型（可选）。——M14 起委托 `memory-prospective.ts`。 */
  storeProspective(params: { projectId: string; taskId?: string; content: string; triggerCondition?: string; dueAt?: string }): string {
    return prospStoreProspective(this, params);
  }

  /** 列出项目内前瞻记忆（含各状态，调用方按 status 过滤）。——M14 起委托 `memory-prospective.ts`。 */
  listProspective(projectId: string, limit = 30): MemoryEntry[] {
    return prospListProspective(this, projectId, limit);
  }

  /** 检查前瞻记忆触发：事件型（trigger_condition 关键词命中 taskText）或时间型（due_at 已过）。——M14 起委托 `memory-prospective.ts`。 */
  getTriggeredProspective(projectId: string, taskText: string): MemoryEntry[] {
    return prospGetTriggeredProspective(this, projectId, taskText);
  }

  /** 标记前瞻记忆为已触发。——M14 起委托 `memory-prospective.ts`。 */
  markProspectiveTriggered(id: string): void {
    prospMarkProspectiveTriggered(this, id);
  }

  /** Phase 3.1: 扫描所有项目中 due_at 到期的前瞻记忆（时间型，空闲周期扫描用）。命中即标记 triggered 并返回。——M14 起委托 `memory-prospective.ts`。 */
  scanDueProspective(now: number): Array<{ id: string; projectId: string; content: string }> {
    return prospScanDueProspective(this, now);
  }

  // ==================== Phase 3.2 线索依赖提取 ====================

  /** 多线索加权检索（关键词线索 + 编码语境关键词 + 提取强度 + 重要性 + 使用频次 + 编码语境加成）。 */
  retrieveByCue(taskText: string, projectId: string, topK = 5): MemoryEntry[] {
    return retRetrieveByCue(this, taskText, projectId, topK);
  }

  /**
   * 提取关键词（过滤虚词/停用词 + 中文 bigram 回退，最多 15 个）。
   *
   * zx_20260930 M7-e：**实现已移入 `core/memory-select.ts`**（与本类八处调用点共用同一份），
   *   本方法只剩一次委托——签名与名字一字不改，故八处调用点与既有判据皆无感。
   *   搬家的理由：注入侧（`memory-context.ts`）要算"这条笔记与当下任务有多少共同词"，
   *   而跨模块调用 `private` 是编译错；与其在那边抄第二份分词，不如把实现提到零依赖模块。
   */
  private _extractKeywords(text: string): string[] {
    return extractKeywords(text);
  }

  // ==================== Phase 3.3 工作记忆 ====================

  /**
   * 读任务工作记忆**池**（任务内临时情境，与长期记忆物理分离——存 `wa_tasks.context_json`）。
   *
   * ⚠ 这里返回的是**池**（上限 `WM_POOL_CAP`），不是**注入焦点**（`WM_WINDOW_CAP`=7±2）。
   *   两者的分开正是 M7-e 的修法：旧实现把 7±2 这道**焦点**上限当成**存储**上限用（FIFO 丢最旧），
   *   于是"只准同时想 7 件事"被读成"只准记 7 条"，第 8 条一落笔第 1 条即销毁、再无从沉淀。
   */
  getWorkingMemory(taskId: string): WorkingMemoryItem[] {
    try {
      const row = this.db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined;
      if (!row) return [];
      const ctx = JSON.parse(row.context_json || '{}') as Record<string, unknown>;
      const wm = ctx.working_memory;
      return Array.isArray(wm) ? (wm as WorkingMemoryItem[]) : [];
    } catch { return []; }
  }

  /**
   * 记一条工作记忆。**记录即复述**（巴德利·复述回路）：
   *   · 同内容再记一次 ⇒ **不是**塞第二条，而是给这一条 `n` 加一、刷新 `ts`（=最近一次复述时刻）。
   *     旧实现无条件 push ⇒ 复述在库里被记成"两条笔记"（占两格、沉淀出两条同源记忆）。
   *   · 池满（`WM_POOL_CAP`）⇒ 按**同一个值算式**（复述强度 × 任务相关度 × 新近度）淘汰**最低者**。
   *     旧实现 `while (wm.length > 7) wm.shift()` 丢的是**最旧**的，而"最旧"只是值的三个因子之一
   *     ——一条被反复复述、且切题的老笔记不该因时序被扔。
   *
   * 池上界是**硬界**而非那把尺：它在"单任务记满 WM_POOL_CAP 条"时才触发（正常任务远不到），
   * 触发时按值淘汰（不是任意/最旧）。注入侧的**焦点择要**另在 `memory-context.ts` 落账。
   */
  addWorkingMemory(taskId: string, content: string): void {
    try {
      const row = this.db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string } | undefined;
      if (!row) return;
      const ctx = JSON.parse(row.context_json || '{}') as Record<string, unknown>;
      const wm = Array.isArray(ctx.working_memory) ? (ctx.working_memory as WorkingMemoryItem[]) : [];
      const text = content.slice(0, 500);
      const ts = new Date().toISOString();
      const hit = wm.find((w) => w.content === text);
      if (hit) { hit.n = (hit.n ?? 1) + 1; hit.ts = ts; }
      else wm.push({ content: text, ts, n: 1 });
      if (wm.length > WM_POOL_CAP) {
        const ranked = rankWorkingMemory(wm, {
          taskText: this.getTaskText(taskId), keywordsOf: extractKeywords, nowMs: Date.now(),
        });
        const keep = new Set(ranked.slice(0, WM_POOL_CAP).map((r) => r.item));
        ctx.working_memory = wm.filter((w) => keep.has(w));
        // zx_20261012_1 批二（工作记忆池淘汰留痕，§1.4）：池满时把**被挤出的是哪条**如实记一行。
        //   本轮**不消费**（M27 的"挤出可见"再取用），此处只为那一格预埋数据——静默淘汰即"没发生过"。
        const evicted = wm.filter((w) => !keep.has(w));
        if (evicted.length > 0) {
          logger.info(
            { taskId: taskId.slice(0, 8), cap: WM_POOL_CAP, evicted: evicted.map((e) => e.content.slice(0, 60)) },
            '工作记忆池淘汰（挤出最低分者）',
          );
        }
      } else {
        ctx.working_memory = wm;
      }
      this.db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), taskId);
    } catch (err) { recordMemoryFailure(MEM_FAIL.workingMemoryAdd, err, { taskId }); }
  }

  /** 稳定字符串哈希（djb2），用于工作记忆分槽去重。 */
  private _hashString(s: string): number {
    let h = 5381;
    for (let i = 0; i < s.length; i++) { h = ((h << 5) + h + s.charCodeAt(i)) | 0; }
    return Math.abs(h) >>> 0;
  }

  /** A1 (2026-09-02): 工作记忆 → 长期记忆巩固门（Atkinson-Shiffrin：工作记忆经巩固转入长期记忆）。
   * 任务终止（completed/failed）时调用：把 agent 执行中显式记录的工作记忆（note 工具 → context_json.working_memory，
   * 随任务结束即消失）去重后写入 wa_memories（source='working_memory:*'，type='episodic'，experience='direct'），
   * 附任务标题+成败上下文，使本次执行的关键笔记沉淀为后续相似任务可召回的长期记忆。
   * 去重：按内容哈希分槽（sameSourceReplace），重跑/恢复同一笔记合并不重复，不同笔记各自独立。
   * 返回沉淀条数。
   */
  promoteWorkingMemory(taskId: string, projectId: string, success: boolean): number {
    try {
      const task = this.db.prepare('SELECT title, context_json FROM wa_tasks WHERE id = ?').get(taskId) as { title: string; context_json: string } | undefined;
      if (!task) return 0;
      const ctx = JSON.parse(task.context_json || '{}') as Record<string, unknown>;
      const wm = Array.isArray(ctx.working_memory) ? (ctx.working_memory as WorkingMemoryItem[]) : [];
      if (wm.length === 0) return 0;
      const title = (task.title || taskId).slice(0, 40);
      let promoted = 0;
      for (const item of wm) {
        const note = (item.content || '').trim();
        if (note.length < 10) continue; // 过短笔记无沉淀价值（避免噪声记忆）
        const memoryContent = `[${success ? '成功' : '失败'}任务「${title}」工作笔记] ${note.slice(0, 500)}`;
        const source = `working_memory:${taskId.slice(0, 8)}:${this._hashString(note)}`;
        const replaced = this.sameSourceReplace(projectId, source, memoryContent, success ? '工作记忆沉淀（任务成功）' : '工作记忆沉淀（任务失败）');
        if (!replaced) {
          this.storeText({ project_id: projectId, task_id: taskId, type: 'episodic', content: memoryContent, source, experience: 'direct', valence: success ? 'positive' : 'negative' });
        }
        promoted++;
      }
      return promoted;
    } catch { return 0; }
  }

  /** 读任务标题+描述（供线索依赖提取 / 前瞻记忆触发的检索查询）。 */
  getTaskText(taskId: string): string {
    try {
      const t = this.db.prepare('SELECT title, description FROM wa_tasks WHERE id = ?').get(taskId) as { title: string; description: string } | undefined;
      return t ? `${t.title}. ${(t.description || '').slice(0, 500)}` : '';
    } catch { return ''; }
  }

  // ==================== Phase A 情景→语义抽象化 ====================

  /**
   * 情景记忆→语义记忆自动抽象化（实践论：感性认识→理性认识的飞跃）。
   * 统计预筛（success_count≥3 的 episodic，按 archetype 分组）→ LLM 精炼（cost-optimal 蒸馏规则）→ 去重标记。
   * 返回抽象出的语义规则条数。
   */
  async abstractSemanticKnowledge(projectId: string): Promise<number> {
    try {
      const candidates = this.db.prepare(
        "SELECT * FROM wa_memories WHERE project_id = ? AND memory_type = 'episodic' AND success_count >= 3 AND (context_json NOT LIKE '%\"abstracted\":true%') ORDER BY updated_at DESC LIMIT 100",
      ).all(projectId) as MemoryEntry[];
      if (candidates.length < 2) return 0;

      const groups = new Map<string, MemoryEntry[]>();
      for (const m of candidates) {
        const arch = this._encodingArchetype(m) ?? 'general';
        const list = groups.get(arch);
        if (list) list.push(m); else groups.set(arch, [m]);
      }

      let abstracted = 0;
      for (const members of groups.values()) {
        if (members.length < 2) continue;
        const rules = await this._abstractWithLLM(members);
        for (const rule of rules) {
          // 去重：与已有 semantic 记忆关键词重叠则跳过
          const kws = this._extractKeywords(rule).slice(0, 3);
          if (kws.length === 0) continue;
          const dup = this.searchByKeywords(kws, projectId, 3);
          if (dup.some(d => d.memory_type === 'semantic')) continue;
          this.storeText({ project_id: projectId, content: rule, type: 'semantic', source: 'abstraction' });
          abstracted++;
        }
        // 标记原 episodic 已抽象（仅当 LLM 实际产出规则，失败时保留供下次重试）
        if (rules.length === 0) continue;
        for (const m of members) {
          try {
            const ctx = JSON.parse(m.context_json || '{}') as Record<string, unknown>;
            ctx.abstracted = true;
            this.db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), m.id);
          } catch (err) { recordMemoryFailure(MEM_FAIL.abstractMark, err, { projectId, memId: m.id }); }
        }
      }
      if (abstracted > 0) logger.info({ projectId: projectId.slice(0, 8), abstracted }, '情景→语义抽象完成');
      return abstracted;
    } catch (err) {
      recordMemoryFailure(MEM_FAIL.abstractRun, err, { projectId });
      logger.warn({ projectId: projectId.slice(0, 8), errMsg: (err as Error).message }, '情景→语义抽象失败');
      return 0;
    }
  }

  /** 用 cost-optimal 模型从多条已验证的 episodic 记忆中蒸馏可复用语义规则。 */
  private async _abstractWithLLM(members: MemoryEntry[]): Promise<string[]> {
    try {
      const m = await this.ansClient.getOptimalModel(auxModelRequest());
      if (!m?.url || !m?.api_key || !m?.model_name) return [];
      const provider = createSafeProvider({ baseURL: m.url, apiKey: m.api_key });
      const model = provider(m.model_name);
      const experiences = members.map(x => `- ${x.content.slice(0, 300)}`).join('\n');
      const result = await generateText({
        model, temperature: 0.2, maxTokens: m.max_output_tokens || 4096,
        prompt: `以下是工蚁系统在一个项目中经过实践验证（成功≥3次）的具体经历。请从中提炼 1-3 条可复用的通用经验/规则（语义知识），每条一行，用中文，简洁明确，不要重复经历本身：\n\n${experiences}`,
      });
      return (result.text || '')
        .split('\n')
        .map(s => s.replace(/^\s*[-*\d.]+\s*/, '').trim())
        .filter(s => s.length > 5 && s.length < 200);
    } catch { return []; }
  }

  // ==================== Phase B 知识盲区登记 ====================

  /** 登记知识盲区（解决不了的问题，持久化元认知——知不知，上）。 */
  storeUnknown(projectId: string, taskId: string | undefined, content: string): string {
    const id = randomUUID();
    const ctx = {
      known_unknown: {
        encountered_task: taskId ?? null,
        encountered_at: new Date().toISOString(),
      },
    };
    this.db.prepare(
      "INSERT INTO wa_memories (id, project_id, task_id, content, memory_type, importance, source, context_json, updated_at) VALUES (?, ?, ?, ?, 'unknown', ?, 'agent_execution', ?, datetime('now'))",
    ).run(id, projectId, taskId ?? null, content, MEM_IMPORTANCE_DEFAULT, JSON.stringify(ctx));
    scheduleMemoryChanged(projectId, 'unknown');
    return id;
  }

  /** 列出项目内已登记的知识盲区。 */
  listUnknowns(projectId: string, limit = 20): MemoryEntry[] {
    try {
      return this.db.prepare(
        "SELECT * FROM wa_memories WHERE project_id = ? AND memory_type = 'unknown' ORDER BY created_at DESC LIMIT ?",
      ).all(projectId, limit) as MemoryEntry[];
    } catch { return []; }
  }

  /** 检索当前任务是否命中已知盲区（关键词命中）。——批七起委托 `memory-retrieval.ts`。 */
  retrieveUnknownHits(taskText: string, projectId: string, topK = 3): MemoryEntry[] {
    return retRetrieveUnknownHits(this, taskText, projectId, topK);
  }

  // ==================== Phase B (2026-08-26) 负空间记忆 ====================

  /** 登记负空间（试过失败/刻意回避，持久化规避经验——有无相生）。 */
  storeNegative(projectId: string, taskId: string | undefined, content: string, kind: 'tried_failed' | 'avoid' = 'tried_failed'): string {
    const id = randomUUID();
    const ctx = {
      negative: {
        kind,
        encountered_task: taskId ?? null,
        encountered_at: new Date().toISOString(),
      },
    };
    this.db.prepare(
      "INSERT INTO wa_memories (id, project_id, task_id, content, memory_type, importance, source, valence, context_json, updated_at) VALUES (?, ?, ?, ?, 'negative', ?, 'agent_execution', 'negative', ?, datetime('now'))",
    ).run(id, projectId, taskId ?? null, content, MEM_IMPORTANCE_DEFAULT, JSON.stringify(ctx));
    scheduleMemoryChanged(projectId, 'negative');
    return id;
  }

  /** 列出项目内已登记的负空间记忆。 */
  listNegatives(projectId: string, limit = 20): MemoryEntry[] {
    try {
      return this.db.prepare(
        "SELECT * FROM wa_memories WHERE project_id = ? AND memory_type = 'negative' ORDER BY created_at DESC LIMIT ?",
      ).all(projectId, limit) as MemoryEntry[];
    } catch { return []; }
  }

  /** 检索当前任务是否命中已知负空间（关键词命中）。——批七起委托 `memory-retrieval.ts`。 */
  retrieveNegativeHits(taskText: string, projectId: string, topK = 3): MemoryEntry[] {
    return retRetrieveNegativeHits(this, taskText, projectId, topK);
  }

  // ==================== Phase D 术语表检索消歧 ====================

  /** 读项目术语表（language_game.terminology，缩写↔全称映射）。——批七起委托 `memory-retrieval.ts`。 */
  getProjectTerminology(projectId: string): Record<string, string> {
    return retGetProjectTerminology(this, projectId);
  }

  // ==================== Phase A 程序性记忆→技能 ====================

  /**
   * 程序性记忆→技能草案提取（维特根斯坦 意义即使用 + 毛选 第二次飞跃）。
   * 查询 success_count≥3 的 procedural 记忆，按 archetype 分组，LLM 蒸馏技能草案，存 wa_skills(draft)。
   * 返回生成的技能草案条数。
   */
  async extractProceduralSkills(projectId: string): Promise<number> {
    try {
      const candidates = this.db.prepare(
        "SELECT * FROM wa_memories WHERE project_id = ? AND memory_type = 'procedural' AND success_count >= 3 AND (context_json NOT LIKE '%\"skill_compiled\":true%') ORDER BY updated_at DESC LIMIT 100",
      ).all(projectId) as MemoryEntry[];
      if (candidates.length < 2) return 0;

      const groups = new Map<string, MemoryEntry[]>();
      for (const m of candidates) {
        const arch = this._encodingArchetype(m) ?? 'general';
        const list = groups.get(arch);
        if (list) list.push(m); else groups.set(arch, [m]);
      }

      let extracted = 0;
      for (const members of groups.values()) {
        if (members.length < 2) continue;
        const skill = await this._distillSkillWithLLM(members);
        if (!skill) continue;
        this.storeSkillDraft(projectId, skill);
        extracted++;
        // 标记源记忆已编译（仅当成功产出技能草案）
        for (const m of members) {
          try {
            const ctx = JSON.parse(m.context_json || '{}') as Record<string, unknown>;
            ctx.skill_compiled = true;
            this.db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), m.id);
          } catch { /* ignore */ }
        }
      }
      if (extracted > 0) logger.info({ projectId: projectId.slice(0, 8), extracted }, '程序性记忆→技能草案提取完成');
      return extracted;
    } catch (err) {
      logger.warn({ projectId: projectId.slice(0, 8), errMsg: (err as Error).message }, '程序性记忆→技能提取失败');
      return 0;
    }
  }

  /** 用 cost-optimal 模型从多条已验证的 procedural 记忆中蒸馏技能草案。 */
  private async _distillSkillWithLLM(members: MemoryEntry[]): Promise<{ name: string; description: string; steps: string[] } | null> {
    try {
      const m = await this.ansClient.getOptimalModel(auxModelRequest());
      if (!m?.url || !m?.api_key || !m?.model_name) return null;
      const provider = createSafeProvider({ baseURL: m.url, apiKey: m.api_key });
      const model = provider(m.model_name);
      const experiences = members.map(x => `- ${x.content.slice(0, 300)}`).join('\n');
      const result = await generateText({
        model, temperature: 0.2, maxTokens: m.max_output_tokens || 4096,
        prompt: `以下是工蚁系统在一个项目中经过实践验证（成功≥3次）的操作步骤经验。请将其提炼为一个可复用的操作技能，输出 JSON：{"name":"技能名(简洁英文snake_case)","description":"一句话说明用途","steps":["步骤1","步骤2",...]}\n\n经验：\n${experiences}`,
      });
      const text = result.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]) as { name?: string; description?: string; steps?: string[] };
      if (!parsed.name || !Array.isArray(parsed.steps) || parsed.steps.length === 0) return null;
      return {
        name: parsed.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40),
        description: (parsed.description || '').slice(0, 200),
        steps: parsed.steps.map(s => (s || '').trim()).filter(s => s.length > 0).slice(0, 20),
      };
    } catch { return null; }
  }

  /** 存储技能草案到 wa_skills(status='draft')。同名（任意状态）已存在则返回已有 id，避免 wa_skills.name 唯一约束冲突。 */
  storeSkillDraft(projectId: string, skill: { name: string; description: string; steps: string[] }): string {
    // name 为全局 UNIQUE，去重须按 name 全查（不限 status），否则同名已 approved/rejected 时 INSERT 抛 UNIQUE 异常
    const existing = this.db.prepare(
      "SELECT id FROM wa_skills WHERE name = ?",
    ).get(skill.name) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = randomUUID();
    this.db.prepare(
      "INSERT INTO wa_skills (id, name, description, category, config, status, project_id, updated_at) VALUES (?, ?, ?, 'custom', ?, 'draft', ?, datetime('now'))",
    ).run(id, skill.name, skill.description, JSON.stringify({ instructions: skill.steps }), projectId);
    return id;
  }

  /** 列出待审批的技能草案（projectId 为空时跨全部项目，供全局审批 UI 使用）。 */
  listSkillDrafts(projectId?: string, limit = 20): Array<{ id: string; name: string; description: string; steps: string[] }> {
    try {
      const rows = projectId
        ? this.db.prepare(
            "SELECT id, name, description, config FROM wa_skills WHERE project_id = ? AND status = 'draft' ORDER BY created_at DESC LIMIT ?",
          ).all(projectId, limit) as Array<{ id: string; name: string; description: string; config: string }>
        : this.db.prepare(
            "SELECT id, name, description, config FROM wa_skills WHERE status = 'draft' ORDER BY created_at DESC LIMIT ?",
          ).all(limit) as Array<{ id: string; name: string; description: string; config: string }>;
      return rows.map(r => {
        let steps: string[] = [];
        try { steps = (JSON.parse(r.config || '{}') as { instructions?: string[] }).instructions || []; } catch { /* ignore */ }
        return { id: r.id, name: r.name, description: r.description, steps };
      });
    } catch { return []; }
  }

  /** 批准技能草案：注册进 skill-registry 并持久化 approved。 */
  async approveSkill(draftId: string): Promise<{ name: string } | null> {
    const row = this.db.prepare(
      "SELECT name, description, config FROM wa_skills WHERE id = ? AND status = 'draft'",
    ).get(draftId) as { name: string; description: string; config: string } | undefined;
    if (!row) return null;
    const { registerSkill } = await import('./skill-registry.js');
    let instructions = '';
    try { instructions = ((JSON.parse(row.config || '{}') as { instructions?: string[] }).instructions || []).join('\n'); } catch { /* ignore */ }
    registerSkill({ name: row.name, description: row.description, category: 'custom', content: instructions });
    this.db.prepare("UPDATE wa_skills SET status = 'approved', updated_at = datetime('now') WHERE id = ?").run(draftId);
    return { name: row.name };
  }

  /** 拒绝技能草案。 */
  rejectSkill(draftId: string): boolean {
    const r = this.db.prepare(
      "UPDATE wa_skills SET status = 'rejected', updated_at = datetime('now') WHERE id = ? AND status = 'draft'",
    ).run(draftId);
    return r.changes > 0;
  }

  /** 启动时加载所有已批准的记忆衍生技能到 skill-registry。 */
  async loadSkillsFromDb(): Promise<number> {
    try {
      const { registerSkill } = await import('./skill-registry.js');
      const rows = this.db.prepare(
        "SELECT name, description, config FROM wa_skills WHERE status = 'approved'",
      ).all() as Array<{ name: string; description: string; config: string }>;
      let loaded = 0;
      for (const r of rows) {
        let instructions = '';
        try { instructions = ((JSON.parse(r.config || '{}') as { instructions?: string[] }).instructions || []).join('\n'); } catch { /* ignore */ }
        registerSkill({ name: r.name, description: r.description, category: 'custom', content: instructions });
        loaded++;
      }
      if (loaded > 0) logger.info({ loaded }, '已从数据库加载已批准技能');
      return loaded;
    } catch { return 0; }
  }

  // ==================== Phase C 记忆再巩固 ====================

  /**
   * 记忆再巩固（毛选 矛盾论 对立统一 + 人类记忆重构 Bartlett）。
   * 相似但非冲突（余弦 0.75-0.92、效价不相反）的记忆对，较新且有验证/已使用者为新证据，
   * 用 cost-optimal 模型把增量信息融入旧记忆内容（保留旧 id/importance 历史）。
   * 返回再巩固条数。
   */
  async reconsolidateMemories(projectId: string): Promise<number> {
    try {
      const memories = this.db.prepare(
        `SELECT * FROM wa_memories WHERE project_id = ? AND ${MEM_LIVE_SQL} AND embedding IS NOT NULL AND embedding != '' ORDER BY created_at DESC LIMIT 120`,
      ).all(projectId) as MemoryEntry[];
      if (memories.length < 2) return 0;

      let reconsolidated = 0;
      const consumed = new Set<string>();
      for (let i = 0; i < memories.length; i++) {
        const newer = memories[i]!;
        if (!newer.embedding || consumed.has(newer.id)) continue;
        for (let j = i + 1; j < memories.length; j++) {
          const older = memories[j]!;
          if (!older.embedding || consumed.has(older.id)) continue;
          try {
            const embA = JSON.parse(newer.embedding) as number[];
            const embB = JSON.parse(older.embedding) as number[];
            const sim = cosineSimilarity(embA, embB);
            if (sim < 0.75 || sim >= 0.92) continue;
            // 效价相反 → 冲突，交由 detectAndResolveConflicts 处理，不再巩固
            if ((newer.valence === 'positive' && older.valence === 'negative') || (newer.valence === 'negative' && older.valence === 'positive')) continue;
            // 新证据判定：较新记忆须已使用（主动引用或至少被注入过）或有验证证据。
            // zx_20261018_3 批一: 判据收为具名纯函数 `hasReconsolidationEvidence`（一处真源、rr 直测）。
            if (!hasReconsolidationEvidence(newer)) continue;
            // 防失控：旧记忆 reconsolidated_count >= 3 停止
            if (this._reconsolidatedCount(older) >= 3) continue;
            const merged = await this._reconsolidateWithLLM(older, newer);
            if (!merged) continue;
            this.db.prepare(
              "UPDATE wa_memories SET content = ?, updated_at = datetime('now') WHERE id = ?",
            ).run(merged, older.id);
            const ctx = JSON.parse(older.context_json || '{}') as Record<string, unknown>;
            ctx.reconsolidated_count = this._reconsolidatedCount(older) + 1;
            this.db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), older.id);
            consumed.add(newer.id);
            reconsolidated++;
          } catch (err) { recordMemoryFailure(MEM_FAIL.reconsolidatePair, err, { projectId, olderId: older.id, newerId: newer.id }); }
        }
      }
      if (reconsolidated > 0) logger.info({ projectId: projectId.slice(0, 8), reconsolidated }, '记忆再巩固完成');
      return reconsolidated;
    } catch (err) {
      recordMemoryFailure(MEM_FAIL.reconsolidateRun, err, { projectId });
      logger.warn({ projectId: projectId.slice(0, 8), errMsg: (err as Error).message }, '记忆再巩固失败');
      return 0;
    }
  }

  /** Phase C: 读记忆的再巩固次数。 */
  private _reconsolidatedCount(mem: MemoryEntry): number {
    try {
      const ctx = JSON.parse(mem.context_json || '{}') as { reconsolidated_count?: number };
      return typeof ctx.reconsolidated_count === 'number' ? ctx.reconsolidated_count : 0;
    } catch { return 0; }
  }

  /** Phase C: LLM 把新记忆增量信息融入旧记忆，返回修订后的旧记忆内容。 */
  private async _reconsolidateWithLLM(older: MemoryEntry, newer: MemoryEntry): Promise<string | null> {
    try {
      const m = await this.ansClient.getOptimalModel(auxModelRequest());
      if (!m?.url || !m?.api_key || !m?.model_name) return null;
      const provider = createSafeProvider({ baseURL: m.url, apiKey: m.api_key });
      const model = provider(m.model_name);
      const result = await generateText({
        model, temperature: 0.2, maxTokens: m.max_output_tokens || 4096,
        prompt: `以下是工蚁系统的两条相关经验记忆。请把「新记忆」中的增量信息融入「旧记忆」，保留旧记忆的稳定部分，输出修订后的旧记忆（一段话，简洁，不要新增臆造内容）：\n\n旧记忆：${older.content.slice(0, 400)}\n\n新记忆：${newer.content.slice(0, 400)}\n\n修订后：`,
      });
      const text = (result.text || '').trim();
      if (text.length < 10 || text.length > 800) return null;
      return text;
    } catch { return null; }
  }

  // ==================== Phase D 检索失败自省 ====================

  /**
   * 深度检索（知道感/舌尖现象补救，道德经 知不知 + 维特根斯坦 知道如何继续）。
   * 常规检索未命中时回退：原始对话 FTS 回溯 + 松弛关键词 + 跨项目相似任务标题线索。
   * 返回恢复的线索列表（content + source）。
   */
  deepRetrieve(taskText: string, projectId: string, taskId?: string, topK = 5): Array<{ content: string; source: string }> {
    return retDeepRetrieve(this, taskText, projectId, taskId, topK);
  }

  // ==================== Phase A (2026-08-26) 任务复盘 ====================

  /**
   * 任务复盘（实践论「再认识」+ 人类 AAR）：对比计划 vs 实际，产出偏差+可复用教训，存为 retrospective 记忆。
   * 返回复盘记忆 id，无可复述的"实际"或 LLM 失败返回 null。
   *
   * zx_20260930 M5（失败也复盘·按终态分叉）：此前本函数**只认成功**——门是 `ctx.completion_summary`
   *   不存在就 `return null`，而那条键**只有成功收尾（`finalize_task`）才写** ⇒ 失败任务永远没有复盘，
   *   失败的教训与阻塞条件一条也不沉淀（比成功配方更该记住的东西）。
   *   现改：提示词的构造（含"实际"取哪一份真源、该问配方还是教训）**全部**交给
   *   `memory-write.ts` 的纯函数 `buildTaskReviewPrompt`——它按终态分叉，且手上没有事实时返回 null（**不编**）。
   *   输出 JSON 键 `{delta, lesson, action}` 两路同形，下方解析/落库一字未改。
   */
  async generateTaskRetrospective(taskId: string, projectId: string): Promise<string | null> {
    try {
      const task = this.db.prepare(
        'SELECT title, description, acceptance_criteria, status, context_json FROM wa_tasks WHERE id = ?',
      ).get(taskId) as { title: string; description: string; acceptance_criteria: string; status: string | null; context_json: string } | undefined;
      if (!task) return null;
      const ctx = JSON.parse(task.context_json || '{}') as {
        completion_summary?: string; failure_record?: FailureRecord;
        awaiting_input?: { question?: string }; acceptance_check?: { reason?: string };
      };
      const built = buildTaskReviewPrompt({
        status: task.status,
        title: task.title,
        description: task.description,
        acceptanceCriteria: task.acceptance_criteria,
        completionSummary: ctx.completion_summary,
        failureRecord: ctx.failure_record ?? null,
        awaitingQuestion: ctx.awaiting_input?.question ?? null,
        acceptanceReason: ctx.acceptance_check?.reason ?? null,
      });
      if (!built) return null; // 手上没有可复述的事实 ⇒ 不编

      const m = await this.ansClient.getOptimalModel(auxModelRequest());
      if (!m?.url || !m?.api_key || !m?.model_name) return null;
      const provider = createSafeProvider({ baseURL: m.url, apiKey: m.api_key });
      const model = provider(m.model_name);
      const result = await generateText({
        model, temperature: 0.2, maxTokens: m.max_output_tokens || 4096,
        prompt: built.prompt,
      });
      const text = result.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]) as { delta?: string; lesson?: string; action?: string };
      if (!parsed.lesson) return null;
      const content = `[复盘] 计划：${task.title.slice(0, 60)} | 偏差：${(parsed.delta || '').slice(0, 100)} | 教训：${parsed.lesson.slice(0, 200)}${parsed.action ? ` | 行动：${parsed.action.slice(0, 200)}` : ''}`;
      // A4: 含「下次怎么做」可行动建议 → 判定为值得复用，写入 reusable_experience=1（检索加权）
      const memId = this.storeText({ project_id: projectId, task_id: taskId, content, type: 'retrospective', source: 'retrospective', reusableExperience: !!parsed.action });
      // B1 (2026-09-03): 复盘结构化落库——content 保留一行摘要（检索/兼容不变），结构放 context_json.retrospective（UI 分节渲染）
      try {
        const memRow = this.db.prepare('SELECT context_json FROM wa_memories WHERE id=?').get(memId) as { context_json: string } | undefined;
        const prev = memRow?.context_json ? (JSON.parse(memRow.context_json) as Record<string, unknown>) : {};
        this.db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?').run(
          JSON.stringify({ ...prev, retrospective: { plan: task.title.slice(0, 200), delta: parsed.delta || '', lesson: parsed.lesson, action: parsed.action || '', reusable: !!parsed.action } }),
          memId,
        );
      } catch { /* 结构落库失败不影响 content 摘要 */ }
      return memId;
    } catch { return null; }
  }

  // ==================== Phase A (2026-08-27) 记忆整合成体系 ====================

  /**
   * 记忆整合成体系（实践论第一次飞跃：感性→理性认识 + 大制不割）。
   * 把分散的高价值记忆综合为连贯「项目知识全景」，存为 memory_type='panorama'（同源覆盖只保留最新）。
   * 返回全景记忆 id，候选记忆 < `PANORAMA_TOP_K` 或 LLM 失败返回 null。
   */
  async synthesizeProjectKnowledge(projectId: string): Promise<string | null> {
    try {
      // zx_20260920_1 M7: 门槛**由真源拼出**，不另写 `0.6` 字面量——写侧（`MEM_IMPORTANCE_DEFAULT`）与
      //   读侧（本行）原先各写各的、谁也没把另一条当约束，于是「≥3 条 ≥0.6」对新写入恒不可满足。
      //   ⚠ 本支**一字未改**（zx_20261002 M9-② 只在下方**另起一支**，不改这条绝对门槛的语义与串面）。
      const highValue = this.db.prepare(
        `SELECT content, memory_type FROM wa_memories WHERE project_id = ? AND memory_type IN ('semantic','procedural','retrospective','negative') AND importance >= ${PANORAMA_MIN_IMPORTANCE} ORDER BY importance DESC, updated_at DESC LIMIT 30`,
      ).all(projectId) as Array<{ content: string; memory_type: string }>;

      // zx_20261002 M9-②（佛学·应无所住／夏克特·错误归因／艾宾浩斯·遗忘曲线）: **相对名次支**。
      //   实证：`importance` 是**时间函数**（衰减），真库活项目记忆已跌到 0.02–0.28 ⇒ 上面那条绝对门槛
      //   在合法数据下**结构性不可满足**（闸在册、永不落 ⇒ 真库 `panorama` 恒 0）。
      //   故补一把**同项目相对名次**的尺：项目内候选齐 `PANORAMA_TOP_K` 条即够综合。绝对支不废——
      //   它继续把"高价值"那几条**排到前面**（下面的合并顺序：绝对支在前），只是不再是**唯一准入**。
      //   ⚠ 命名取舍：本支取数**不按 importance 过滤**，故谓词里没有 `importance >=`；两支都以
      //     `ORDER BY importance DESC` 收尾 ⇒ 即便整体衰减，"项目里最有价值的那几条"仍被优先喂给 LLM。
      const topRanked = this.db.prepare(
        `SELECT content, memory_type FROM wa_memories WHERE project_id = ? AND memory_type IN ('semantic','procedural','retrospective','negative') ORDER BY importance DESC, updated_at DESC LIMIT ${PANORAMA_TOP_K}`,
      ).all(projectId) as Array<{ content: string; memory_type: string }>;

      // 合并两支：绝对支在前（高价值优先），按（类型, 正文）去重。
      //   谓词一致 ⇒ 同一行不可能只在一支里"变样"；去重只为清掉两支都取到的重复。
      const seen = new Set<string>();
      const memories: Array<{ content: string; memory_type: string }> = [];
      for (const m of [...highValue, ...topRanked]) {
        const key = m.memory_type + '\u0000' + m.content;
        if (seen.has(key)) continue;
        seen.add(key);
        memories.push(m);
      }
      // 门槛：**候选条数** ≥ TOP_K（旧写法是硬编码的 `< 3`；现值收进真源，口径不变）。
      if (memories.length < PANORAMA_TOP_K) return null;

      const m = await this.ansClient.getOptimalModel(auxModelRequest());
      if (!m?.url || !m?.api_key || !m?.model_name) return null;
      const provider = createSafeProvider({ baseURL: m.url, apiKey: m.api_key });
      const model = provider(m.model_name);
      const memoriesText = memories.map(x => `[${x.memory_type}] ${x.content.slice(0, 200)}`).join('\n');
      // zx_20261003 M5: 综合的输入**不止记忆**——把项目**非记忆原料**（三元组 top 关系 + 交付物 byType +
      //   调用账成败）一并喂进去作**旁证**。空则不出段（`formatKnowledgeMaterials` 返空串）。
      //   ⚠ **不改**上面的 `memories.length < PANORAMA_TOP_K` 门槛——"候选不足 ⇒ 如实 return null" 语义不动；
      //     非记忆原料**不是**门槛的兜底（否则又会造出"没记忆也能凑一份 panorama"的伪知识）。
      const materialsText = formatKnowledgeMaterials(collectProjectKnowledgeMaterials(this.db, projectId));
      const materialsBlock = materialsText
        ? `\n\n另附该项目的**非记忆原料**（交付物/关系/服务调用账）——**仅作旁证**，可据此校正你对项目现状的判断，但**不得**据此臆造未记载的内容：\n${materialsText}`
        : '';
      const result = await generateText({
        model, temperature: 0.2, maxTokens: m.max_output_tokens || 4096,
        prompt: `以下是工蚁系统一个项目中积累的高价值记忆（按类型标注）。请综合为一份连贯的「项目知识全景」，输出 JSON：{"overview":"项目概况","tech_stack":"技术栈/架构","approaches":"已验证打法","pitfalls":"坑/注意事项","blind_spots":"知识盲区"}。简洁中文，只综合不臆造。\n\n${memoriesText}${materialsBlock}`,
      });
      const text = result.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]) as Record<string, string>;
      const parts: string[] = [];
      if (parsed.overview) parts.push(`【概况】${parsed.overview}`);
      if (parsed.tech_stack) parts.push(`【技术栈】${parsed.tech_stack}`);
      if (parsed.approaches) parts.push(`【打法】${parsed.approaches}`);
      if (parsed.pitfalls) parts.push(`【坑】${parsed.pitfalls}`);
      if (parsed.blind_spots) parts.push(`【盲区】${parsed.blind_spots}`);
      const content = parts.join('\n');
      if (content.length < 20) return null;

      // 同源覆盖：删除旧全景，存新全景（只保留最新）
      // 【zx_20261012_1 批一·墓碑纪律**豁免#3**（如实登记）】panorama 是**派生行**（由现存记忆 LLM 综合而成，
      //   非用户写入的信息载体）——删它不丢任何"用户/机器写入的事实"，下次综合即重算。落墓反会污染审计面。
      this.db.prepare("DELETE FROM wa_memories WHERE project_id = ? AND memory_type = 'panorama'").run(projectId);
      const id = this.storeText({ project_id: projectId, content, type: 'panorama', source: 'synthesis' });
      // 全景综合的是项目里**最有价值的那几条**（绝对支高价值在前、相对支补足），「理性认识」应不低于其组成部分，设 0.8 防过快衰减
      this.db.prepare('UPDATE wa_memories SET importance = 0.8 WHERE id = ?').run(id);
      return id;
    } catch { return null; }
  }

  // ==================== Phase A (2026-08-27) 记忆缘起条件 ====================

  /**
   * 记忆缘起条件提取（空性·缘起性空 + 无常）：对高价值 semantic/procedural 记忆，
   * LLM 提取「适用条件 + 稳定性分级」，写入 context_json.applicability。
   * 已有 applicability 的记忆跳过（幂等）。返回是否成功提取。
   */
  async extractApplicabilityConditions(memId: string, projectId: string): Promise<boolean> {
    try {
      const mem = this.db.prepare(
        "SELECT content, context_json, importance FROM wa_memories WHERE id = ? AND project_id = ?",
      ).get(memId, projectId) as { content: string; context_json: string; importance: number } | undefined;
      // ⚠ zx_20260920_1 M7: 同值不同义的第二处 `0.6`（另见 `challengeOverconfident`）——这里是
      //   「缘起条件提取」的闸，不是全景门槛，**刻意不并入** `PANORAMA_MIN_IMPORTANCE`；
      //   调全景门槛时请一并评估此处。
      if (!mem || mem.importance < 0.6) return false;
      const ctx = JSON.parse(mem.context_json || '{}') as { applicability?: unknown };
      if (ctx.applicability && Object.keys(ctx.applicability as object).length > 0) return false; // 已提取，幂等跳过

      const m = await this.ansClient.getOptimalModel(auxModelRequest());
      if (!m?.url || !m?.api_key || !m?.model_name) return false;
      const provider = createSafeProvider({ baseURL: m.url, apiKey: m.api_key });
      const model = provider(m.model_name);
      const result = await generateText({
        model, temperature: 0.1, maxTokens: m.max_output_tokens || 4096,
        prompt: `以下是工蚁系统的一条高价值记忆。请判断这条记忆的「适用条件/前提」和「稳定性」。\n\n记忆：${mem.content.slice(0, 400)}\n\n输出 JSON：{"conditions": ["适用条件短语，如'仅适用于Windows环境'、'需要Node 22+'，没有则空数组"], "stability": "stable"|"volatile"}\n\nstability 判定：stable=恒常规律（技术栈选型/架构原则等不易变）；volatile=无常细节（具体版本号/临时环境配置/易变状态）。简洁中文。`,
      });
      const text = result.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return false;
      const parsed = JSON.parse(jsonMatch[0]) as { conditions?: unknown; stability?: unknown };
      const conditions = Array.isArray(parsed.conditions) ? (parsed.conditions as unknown[]).filter((c): c is string => typeof c === 'string' && c.length > 1).slice(0, 5) : [];
      const stability = parsed.stability === 'volatile' ? 'volatile' : 'stable';
      if (conditions.length === 0 && stability !== 'volatile') return false; // 既无条件也无无常标记，跳过

      const fresh = JSON.parse(mem.context_json || '{}') as Record<string, unknown>;
      fresh.applicability = { conditions, stability, extracted_at: new Date().toISOString() };
      this.db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?').run(JSON.stringify(fresh), memId);
      return true;
    } catch { return false; }
  }

  /**
   * 记忆加工深度评估（加工水平理论 + 王阳明·格物致知 + 维特根斯坦·意义即使用 + 空性·缘起）：
   * 对已存储的记忆，LLM 判断「深加工（与已有知识关联+提炼规律）/浅加工（机械记录事实）」，
   * 写入 context_json.processing_depth；deep 记忆 importance 上浮 +0.1。
   * 已有 processing_depth 的记忆跳过（幂等）。返回是否成功评估。
   */
  async assessProcessingDepth(memId: string, projectId: string): Promise<boolean> {
    try {
      const mem = this.db.prepare(
        "SELECT content, context_json FROM wa_memories WHERE id = ? AND project_id = ?",
      ).get(memId, projectId) as { content: string; context_json: string } | undefined;
      if (!mem) return false;
      const ctx = JSON.parse(mem.context_json || '{}') as { processing_depth?: unknown };
      if (ctx.processing_depth === 'deep' || ctx.processing_depth === 'shallow') return false; // 已评估，幂等跳过

      const m = await this.ansClient.getOptimalModel(auxModelRequest());
      if (!m?.url || !m?.api_key || !m?.model_name) return false;
      const provider = createSafeProvider({ baseURL: m.url, apiKey: m.api_key });
      const model = provider(m.model_name);
      const result = await generateText({
        model, temperature: 0.1, maxTokens: m.max_output_tokens || 4096,
        prompt: `以下是工蚁系统的一条记忆。请判断这条记忆的「加工深度」。\n\n记忆：${mem.content.slice(0, 400)}\n\n输出 JSON：{"depth": "deep"|"shallow", "reason": "一句话说明"}\n\ndeep=深层加工（提炼了规律/因果/可迁移的方法，而非仅记录事实）；shallow=浅层加工（机械记录某次事实/状态，未提炼规律）。`,
      });
      const text = result.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return false;
      const parsed = JSON.parse(jsonMatch[0]) as { depth?: string };
      const depth = parsed.depth === 'deep' ? 'deep' : 'shallow';

      const fresh = JSON.parse(mem.context_json || '{}') as Record<string, unknown>;
      fresh.processing_depth = depth;
      this.db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?').run(JSON.stringify(fresh), memId);
      // 深加工记忆 importance 上浮 +0.1（格物致知：深加工更可靠）
      if (depth === 'deep') {
        this.db.prepare('UPDATE wa_memories SET importance = MIN(1.0, importance + 0.1) WHERE id = ?').run(memId);
      }
      return true;
    } catch { return false; }
  }

  // ==================== Phase B (2026-08-27) 记忆行动转化 ====================

  /**
   * 记忆行动转化（王阳明知行合一 + 事上磨练）：任务完成后 LLM 判定每条注入记忆是否「真正被应用」
   * （其结论/打法在本次执行中被采纳并影响行动），而非仅被检索。
   * 被应用且成功的记忆额外强化（真知必能行）；被检索却未应用的记忆微降（知而不行只是未知）。
   * 返回 { applied, notApplied }，无注入记忆/无完成摘要/LLM 失败返回 null。
   *
   * zx_20260930 M6: 判定的对象与 `reinforceMemories` **同一份使用证据**（per-run 优先、老任务落回 union）——
   *   两处若各取一套，"基础强化算在谁头上"就对不上（见 `_recordApplication` 的 `baseReinforced`）。
   */
  async assessMemoryApplication(taskId: string, projectId: string): Promise<{ applied: number; notApplied: number } | null> {
    try {
      const perRun = this._readRunMemoryIds(taskId);
      const injectedIds = perRun ?? this._readInjectedMemoryIds(taskId);
      if (injectedIds.length === 0) return null;
      const task = this.db.prepare('SELECT status, context_json FROM wa_tasks WHERE id = ?').get(taskId) as { status: string; context_json: string } | undefined;
      if (!task) return null;
      const ctx = JSON.parse(task.context_json || '{}');
      const summary = ctx.completion_summary as string | undefined;
      if (!summary) return null;
      const success = task.status === 'completed';
      // 复算 reinforceMemories 的 success 基础强化幅度（0.1*q，与 _applyReinforcement 保持一致），用于 notApplied 精确抵消
      const qScore = (ctx.completion_quality as { score?: number } | undefined)?.score;
      const reinforceDelta = 0.1 * ((qScore ?? 70) / 100);

      const mems = injectedIds.map(id => {
        const row = this.db.prepare('SELECT id, content FROM wa_memories WHERE id = ?').get(id) as { id: string; content: string } | undefined;
        return row ? { id: row.id, content: row.content.slice(0, 200) } : null;
      }).filter((x): x is { id: string; content: string } => x !== null);
      if (mems.length === 0) return null;

      const m = await this.ansClient.getOptimalModel(auxModelRequest());
      if (!m?.url || !m?.api_key || !m?.model_name) return null;
      const provider = createSafeProvider({ baseURL: m.url, apiKey: m.api_key });
      const model = provider(m.model_name);
      const memsText = mems.map((x, i) => `${i + 1}. ${x.content}`).join('\n');
      const result = await generateText({
        model, temperature: 0.1, maxTokens: m.max_output_tokens || 4096,
        prompt: `以下是工蚁系统一个已完成任务的注入记忆与完成摘要。请判定每条记忆是否「真正被应用」（即其结论/打法在本次执行中被采纳并影响行动），而非仅被检索。\n\n注入记忆：\n${memsText}\n\n任务完成摘要：\n${summary.slice(0, 500)}\n\n输出 JSON：{"applied": [记忆编号...], "notApplied": [记忆编号...]}，编号从1开始，只输出编号数组。`,
      });
      const text = result.text || '';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return null;
      const parsed = JSON.parse(jsonMatch[0]) as { applied?: unknown; notApplied?: unknown };
      const toIdx = (v: unknown): Set<number> => new Set(Array.isArray(v) ? (v as unknown[]).map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= mems.length) : []);

      let applied = 0, notApplied = 0;
      const appliedIdx = toIdx(parsed.applied);
      const notAppliedIdx = toIdx(parsed.notApplied);
      for (let i = 0; i < mems.length; i++) {
        const mem = mems[i]!;
        if (appliedIdx.has(i + 1)) { applied++; this._recordApplication(mem.id, true, success, reinforceDelta, perRun !== null); }
        else if (notAppliedIdx.has(i + 1)) { notApplied++; this._recordApplication(mem.id, false, success, reinforceDelta, perRun !== null); }
      }
      if (applied + notApplied > 0) logger.info({ taskId: taskId.slice(0, 8), applied, notApplied, success }, '记忆行动转化判定完成');
      return { applied, notApplied };
    } catch { return null; }
  }

  /**
   * Phase B: 记录单条记忆的应用结果，并对「被应用且成功/被检索未应用」做知行合一增量强化。
   * `baseReinforced`（zx_20260930 M6）：`reinforceMemories` 是否**真的**给这条加过基础分。
   *   老任务（无 per-run 键）只记计数、importance 分文未动 ⇒ 抵不掉从未加过的分。
   */
  private _recordApplication(memId: string, applied: boolean, success: boolean, reinforceDelta = 0.07, baseReinforced = true): void {
    try {
      const row = this.db.prepare('SELECT context_json FROM wa_memories WHERE id = ?').get(memId) as { context_json: string } | undefined;
      if (!row) return;
      const ctx = JSON.parse(row.context_json || '{}') as Record<string, unknown>;
      const prev = (ctx.applied as { count?: number; last_applied_at?: string; last_success?: boolean } | undefined) ?? {};
      ctx.applied = {
        count: (prev.count ?? 0) + (applied ? 1 : 0),
        last_applied_at: applied ? new Date().toISOString() : prev.last_applied_at,
        last_success: applied ? success : prev.last_success,
      };
      this.db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?').run(JSON.stringify(ctx), memId);

      // 知行合一增量强化（叠加在 reinforceMemories 基础强化之上）
      if (applied && success) {
        // 被应用且成功：额外 +0.03（真知被行且成，强于仅被检索）
        this.db.prepare('UPDATE wa_memories SET importance = MIN(1.0, importance + 0.03) WHERE id = ?').run(memId);
      } else if (!applied && success) {
        // 被检索未应用且成功：抵消 reinforceMemories 的基础强化(+reinforceDelta)并额外 -0.03（知而不行只是未知，纠正死记）
        // zx_20260930 M6: 抵的只能是**真加过**的分——老任务只记计数（`baseReinforced=false`）时只扣 0.03。
        const back = baseReinforced ? reinforceDelta + 0.03 : 0.03;
        this.db.prepare('UPDATE wa_memories SET importance = MAX(0.05, importance - ?) WHERE id = ?').run(Math.round(back * 100) / 100, memId);
      }
    } catch (err) { recordMemoryFailure(MEM_FAIL.applicationRecord, err, { memId, applied, success }); }
  }

  // ==================== Phase C (2026-08-27) 自我设限信念识别 ====================

  /**
   * 自我设限信念识别（王阳明·破心中贼）：从失败任务对话中提取「自我设限假设」
   * （如"无法完成/需人工/不可行/超出能力"等未尝试就放弃的内在信念），存为 memory_type='limiting_belief'。
   * 严控触发：仅 status='failed' 且未提取过的任务，且提取到明确「自我设限」措辞才存。
   * 返回提取条数。
   */
  async extractLimitingBeliefs(projectId: string): Promise<number> {
    try {
      const tasks = this.db.prepare(
        "SELECT id, title, context_json FROM wa_tasks WHERE project_id = ? AND status = 'failed' AND (context_json NOT LIKE '%\"limiting_belief_extracted\":true%') ORDER BY updated_at DESC LIMIT 10",
      ).all(projectId) as Array<{ id: string; title: string; context_json: string }>;
      if (tasks.length === 0) return 0;

      const m = await this.ansClient.getOptimalModel(auxModelRequest());
      if (!m?.url || !m?.api_key || !m?.model_name) return 0;
      const provider = createSafeProvider({ baseURL: m.url, apiKey: m.api_key });
      const model = provider(m.model_name);

      let extracted = 0;
      for (const task of tasks) {
        try {
          const convs = this.db.prepare(
            "SELECT role, content FROM wa_task_conversations WHERE task_id = ? ORDER BY rowid ASC LIMIT 50",
          ).all(task.id) as Array<{ role: string; content: string }>;
          if (convs.length === 0) continue;
          const convText = convs.map(c => `[${c.role}] ${(c.content || '').slice(0, 300)}`).join('\n');

          const result = await generateText({
            model, temperature: 0.1, maxTokens: m.max_output_tokens || 4096,
            prompt: `以下是工蚁系统一个失败任务的对话。请判断其中是否存在「自我设限信念」（未尝试就放弃的内在假设，如"无法完成/需要人工/不可行/超出能力/只能放弃"），注意排除客观技术障碍和已实际尝试过的失败。\n\n任务：${task.title.slice(0, 100)}\n对话：\n${convText.slice(0, 2500)}\n\n输出 JSON：{"belief": "自我设限信念描述，不存在则为空字符串", "evidence": "支撑该判断的对话片段"}。简洁中文。`,
          });
          const text = result.text || '';
          const jsonMatch = text.match(/\{[\s\S]*\}/);
          if (!jsonMatch) continue;
          const parsed = JSON.parse(jsonMatch[0]) as { belief?: string; evidence?: string };
          const belief = (parsed.belief || '').trim();
          if (belief.length < 4) continue;

          const id = this.storeText({
            project_id: projectId, task_id: task.id,
            content: `[心中贼] ${belief.slice(0, 200)}`,
            type: 'limiting_belief', source: 'limiting_belief',
          });
          // 存信念依据（evidence），供注入时展示
          try {
            const mrow = this.db.prepare('SELECT context_json FROM wa_memories WHERE id = ?').get(id) as { context_json: string } | undefined;
            if (mrow) {
              const mctx = JSON.parse(mrow.context_json || '{}') as Record<string, unknown>;
              mctx.belief = { evidence: (parsed.evidence || '').slice(0, 200) };
              this.db.prepare('UPDATE wa_memories SET context_json = ? WHERE id = ?').run(JSON.stringify(mctx), id);
            }
          } catch { /* ignore */ }

          // 标记该任务已提取，避免重复
          const tctx = JSON.parse(task.context_json || '{}') as Record<string, unknown>;
          tctx.limiting_belief_extracted = true;
          this.db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(tctx), task.id);
          extracted++;
        } catch { /* 单任务提取失败继续下一个 */ }
      }
      if (extracted > 0) logger.info({ projectId: projectId.slice(0, 8), extracted }, '破心中贼：自我设限信念提取完成');
      return extracted;
    } catch { return 0; }
  }

  // ==================== zx_20260905 批1 (2026-09-05) 理解预跑「三调合一」 ====================
  // 原 任务立志(identifyTaskGoal) + 主要矛盾(identifyTaskPrincipalContradiction) + 需求卡 refine(refineRequirementCard)
  // 是 3 次独立 cost-optimal LLM 预读，各自把任务文本再送一次且不计费（不可见成本）。此处合并为一次结构化预读，
  // 一次产出 goal/success_criteria/investigate + key_constraint + req_card，并统一缓存到 ctxJson：
  //   · task_goal 已存在（首识或用户纠正回写）→ 复用、绝不覆盖（沿用 C3 语义）
  //   · principal_contradiction / requirement_card 同源缓存 → resume 不再重复预读（原矛盾每次 resume 都重算）
  //   · 附带 prelude_usage 估算预读 token，使此前不可见成本可见（不并入步进记账，避免双计）
  async runTaskPrelude(
    taskId: string, projectId: string,
  ): Promise<{ goal: { goal: string; success_criteria: string; investigate: string[] } | null; contradiction: string | null; card: string | null } | null> {
    try {
      const row = this.db.prepare('SELECT title, description, acceptance_criteria, context_json FROM wa_tasks WHERE id = ? AND project_id = ?').get(taskId, projectId) as { title: string; description: string | null; acceptance_criteria: string | null; context_json: string } | undefined;
      if (!row) return null;
      const ctx: Record<string, unknown> = (() => { try { return JSON.parse(row.context_json || '{}'); } catch { return {}; } })();
      const title = (row.title || '').slice(0, 200);
      const description = row.description || '';
      const acceptance = row.acceptance_criteria || '';
      const isSimple = assessComplexity(`${title} ${description}`) === 'simple';
      const isSubagent = ctx.type === 'subagent' || Number(ctx.depth || 0) >= 1;

      // 缓存读取：task_goal（首识/用户纠正），contradiction/card（本次或历史 run 预读）
      const existingGoal = ctx.task_goal as { goal?: string; success_criteria?: string; investigate?: unknown } | undefined;
      const cachedGoal = existingGoal?.goal && String(existingGoal.goal).length >= 4
        ? { goal: String(existingGoal.goal).slice(0, 120), success_criteria: (existingGoal.success_criteria || '').trim().slice(0, 120), investigate: Array.isArray(existingGoal.investigate) ? (existingGoal.investigate as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 1).slice(0, 3) : [] }
        : null;
      const cachedContr = typeof ctx.principal_contradiction === 'string' && String(ctx.principal_contradiction).trim().length >= 4 ? String(ctx.principal_contradiction).trim().slice(0, 120) : null;
      const cachedCard = typeof ctx.requirement_card === 'string' && String(ctx.requirement_card).trim().length > 0 ? String(ctx.requirement_card) : null;

      // 各字段门：goal/矛盾 仅 complex|standard 识别（沿用旧 gate）；需求卡 refine 仅长文(≥300)且非 subagent/depth≥1
      const needGoal = !isSimple && !cachedGoal;
      const needContr = !isSimple && !cachedContr;
      const textLen = `${title}\n${description}\n${acceptance}`.length;
      const needCard = !isSubagent && !cachedCard && textLen >= 300;
      if (!needGoal && !needContr && !needCard) {
        return { goal: cachedGoal, contradiction: cachedContr, card: cachedCard };
      }

      const m = await this.ansClient.getOptimalModel(auxModelRequest());
      if (!m?.url || !m?.api_key || !m?.model_name) return { goal: cachedGoal, contradiction: cachedContr, card: cachedCard };

      const req: string[] = [];
      if (needGoal) req.push('goal/success_criteria/investigate');
      if (needContr) req.push('key_constraint');
      if (needCard) req.push('req_card');
      const skeleton: string[] = [];
      if (needGoal) skeleton.push('"goal": "核心目标一句话(须具体可验证)", "success_criteria": "成功标准一句话", "investigate": ["需先调查的关键信息，最多3条"]');
      if (needContr) skeleton.push('"key_constraint": "关键约束一句话(无明确难点则空字符串)"');
      if (needCard) skeleton.push('"req_card": "极简需求卡(纯文本，行式: 目标:/边界约束:/产出文件:/验收要点:/勿做:)"');

      const provider = createSafeProvider({ baseURL: m.url, apiKey: m.api_key });
      const model = provider(m.model_name);
      // zx_20261021_4 批二: 预读带项目上下文 + 反虚构硬约束（读不到项目行照常预读，只少这几行）。
      const project = (() => {
        try {
          return this.db.prepare('SELECT name, description, working_dir FROM wa_projects WHERE id = ?').get(projectId) as PreludeProjectContext | undefined;
        } catch { return undefined; }
      })();
      const prompt = buildPreludePrompt({ title, description, acceptance, needCard, req, skeleton, project });
      const result = await generateText({ model, temperature: 0.2, maxTokens: m.max_output_tokens || 4096, prompt });
      const out = result.text || '';
      const outChars = out.length;
      const jsonMatch = out.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return { goal: cachedGoal, contradiction: cachedContr, card: cachedCard };
      const parsed = (() => { try { return JSON.parse(jsonMatch[0]) as { goal?: unknown; success_criteria?: unknown; investigate?: unknown; key_constraint?: unknown; req_card?: unknown }; } catch { return {}; } })();

      let newGoal = cachedGoal;
      if (needGoal) {
        let g = typeof parsed.goal === 'string' ? parsed.goal.trim() : '';
        // 立志兜底：goal 过短/为空回退 title（王阳明立志：志不立天下无可成之事）
        if (g.length < 4) g = title.length >= 4 ? `完成「${title}」` : '';
        if (g) newGoal = {
          goal: g.slice(0, 120),
          success_criteria: (typeof parsed.success_criteria === 'string' ? parsed.success_criteria : '').trim().slice(0, 120),
          investigate: Array.isArray(parsed.investigate) ? (parsed.investigate as unknown[]).filter((x): x is string => typeof x === 'string' && x.length > 1).slice(0, 3) : [],
        };
      }
      let newContr = cachedContr;
      if (needContr) {
        const k = typeof parsed.key_constraint === 'string' ? parsed.key_constraint.trim() : '';
        if (k.length >= 4) newContr = k.slice(0, 120);
      }
      let newCard = cachedCard;
      if (needCard) {
        const rc = typeof parsed.req_card === 'string' ? parsed.req_card.trim() : '';
        if (rc) newCard = `[需求卡(提炼)]\n${rc.slice(0, 1200)}`;
      }

      // 回写 ctxJson（只写本次算出的缺失字段；task_goal 缓存存在时绝不动用户纠正值）
      try {
        const latest = JSON.parse((this.db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}') as Record<string, unknown>;
        if (needGoal && newGoal) latest.task_goal = newGoal;
        if (needContr && newContr) latest.principal_contradiction = newContr;
        if (needCard && newCard) latest.requirement_card = newCard;
        latest.prelude_usage = { tokens_in: estimateTokensFromChars(prompt.length), tokens_out: estimateTokensFromChars(outChars), tokens: estimateTokensFromChars(prompt.length) + estimateTokensFromChars(outChars) };
        this.db.prepare('UPDATE wa_tasks SET context_json = ? WHERE id = ?').run(JSON.stringify(latest), taskId);
      } catch { /* 回写失败不阻塞 */ }
      logger.info({ taskId: taskId.slice(0, 8), needGoal, needContr, needCard, goal: newGoal ? newGoal.goal.slice(0, 24) : '', contr: newContr ? newContr.slice(0, 24) : '' }, '任务理解预读(三调合一)完成');
      return { goal: newGoal, contradiction: newContr, card: newCard };
    } catch { return null; }
  }

  /**
   * 任务立志（王阳明·立志 + 毛选·调查研究）：委托 runTaskPrelude，保持调用语义（simple 返回 null）。
   */
  async identifyTaskGoal(taskId: string, projectId: string): Promise<{ goal: string; success_criteria: string; investigate: string[] } | null> {
    const p = await this.runTaskPrelude(taskId, projectId).catch(() => null);
    return p?.goal ?? null;
  }

  /**
   * 任务级主要矛盾识别（毛选·矛盾论 + 维特根斯坦）：委托 runTaskPrelude，保持调用语义（simple 返回 null）。
   */
  async identifyTaskPrincipalContradiction(taskId: string, projectId: string): Promise<string | null> {
    const p = await this.runTaskPrelude(taskId, projectId).catch(() => null);
    return p?.contradiction ?? null;
  }

  // ==================== Phase B (2026-08-27) 记忆有效性评估 ====================

  /**
   * 记忆有效性评估（实事求是：实践检验记忆）。按 memory_type 统计「注入后任务成功率」。
   * 样本≥3 才纳入；30 分钟缓存避免频繁全表扫描。
   */
  buildMemoryEffectivenessStats(projectId: string): Array<{ memoryType: string; successCount: number; failCount: number; successRate: number; sampleCount: number }> {
    const cached = this._effectivenessCache.get(projectId);
    if (cached && Date.now() - cached.ts < MemoryManager.EFFECTIVENESS_CACHE_TTL) return cached.stats;
    const stats = this._computeEffectivenessStats(projectId);
    this._effectivenessCache.set(projectId, { ts: Date.now(), stats });
    return stats;
  }

  private _computeEffectivenessStats(projectId: string): Array<{ memoryType: string; successCount: number; failCount: number; successRate: number; sampleCount: number }> {
    try {
      const tasks = this.db.prepare(
        "SELECT context_json, status FROM wa_tasks WHERE project_id = ? AND status IN ('completed','failed') AND context_json LIKE '%injected_memory_ids%'",
      ).all(projectId) as Array<{ context_json: string; status: string }>;
      if (tasks.length < 3) return [];

      const typeStats = new Map<string, { success: number; fail: number }>();
      for (const t of tasks) {
        try {
          const ctx = JSON.parse(t.context_json || '{}');
          const ids = ctx.injected_memory_ids as unknown;
          if (!Array.isArray(ids) || ids.length === 0) continue;
          const isSuccess = t.status === 'completed';
          const placeholders = ids.map(() => '?').join(',');
          const rows = this.db.prepare(`SELECT DISTINCT memory_type FROM wa_memories WHERE id IN (${placeholders})`).all(...ids) as Array<{ memory_type: string }>;
          for (const r of rows) {
            const entry = typeStats.get(r.memory_type) || { success: 0, fail: 0 };
            if (isSuccess) entry.success++; else entry.fail++;
            typeStats.set(r.memory_type, entry);
          }
        } catch { /* skip */ }
      }

      const stats: Array<{ memoryType: string; successCount: number; failCount: number; successRate: number; sampleCount: number }> = [];
      for (const [type, e] of typeStats) {
        const total = e.success + e.fail;
        if (total < 3) continue;
        stats.push({ memoryType: type, successCount: e.success, failCount: e.fail, successRate: e.success / total, sampleCount: total });
      }
      stats.sort((a, b) => b.successRate - a.successRate);
      return stats;
    } catch { return []; }
  }

  /** Phase B: 记忆类型有效性排序微调（实事求是：成功类型略优先、失败类型略降权）。 */
  private _effectivenessBoost(memoryType: string, projectId: string): number {
    const stats = this.buildMemoryEffectivenessStats(projectId);
    const s = stats.find(x => x.memoryType === memoryType);
    if (!s) return 0;
    if (s.successRate >= 0.7) return 0.02;
    if (s.successRate < 0.4) return -0.02;
    return 0;
  }

  // ==================== Phase C (2026-08-27) 任务执行元认知 ====================

  /**
   * 任务执行元认知（具体问题具体分析 + 语言游戏）：按 archetype 从工具成败数据学习「执行打法」。
   * 返回 { archetype: "优先: X/Y；避免: Z" }，样本≥3 才纳入。
   */
  buildExecutionPlaybook(projectId: string): Record<string, string> {
    try {
      const proj = this.db.prepare('SELECT context_json FROM wa_projects WHERE id = ?').get(projectId) as { context_json: string } | undefined;
      const ctx = JSON.parse(proj?.context_json || '{}');
      const usage = ctx.tool_usage as Record<string, { toolName: string; archetype: string; successCount: number; failCount: number }> | undefined;
      if (!usage) return {};
      const byArchetype = new Map<string, { verified: string[]; avoid: string[] }>();
      for (const record of Object.values(usage)) {
        const sc = record.successCount || 0;
        const fc = record.failCount || 0;
        const total = sc + fc;
        if (total < 3) continue;
        const entry = byArchetype.get(record.archetype) || { verified: [], avoid: [] };
        if (sc / total >= 0.8) entry.verified.push(record.toolName);
        else if (sc / total < 0.4) entry.avoid.push(record.toolName);
        byArchetype.set(record.archetype, entry);
      }
      const playbook: Record<string, string> = {};
      for (const [archetype, e] of byArchetype) {
        const parts: string[] = [];
        if (e.verified.length > 0) parts.push(`优先: ${e.verified.join('/')}`);
        if (e.avoid.length > 0) parts.push(`避免: ${e.avoid.join('/')}`);
        if (parts.length > 0) playbook[archetype] = parts.join('；');
      }
      return playbook;
    } catch { return {}; }
  }
}
