/**
 * zx_20261003 M5（实践论·第一次飞跃／维特根斯坦·意义即用法）: 项目「**非记忆原料**」聚合——
 *   供 `memory-manager.synthesizeProjectKnowledge` 综合 panorama 时作**旁证**。
 *
 * 病根：panorama 此前**只综合"记忆"**（semantic/procedural/retrospective/negative），而项目知识整体
 *   还有三样**非记忆原料**：① 知识图谱 top 关系（三元组）② 交付物 byType ③ 调用账成败。只见记忆
 *   ⇒ 全景"看不见"项目已经**产出了什么**、**用到了什么关系**、**什么服务在跑/挂**。
 *   M5 把三样喂进综合的输入 ⇒ 执行期 §0 注入 panorama 时**无需新增分段**即继承更全知识面。
 *
 * ⚠ **形态守 K-4（知识产物，非权重）**：本模块只**读**、只**格式化文本**喂给 LLM 综合；**绝不**训练/微调。
 *
 * ⚠ **三样各自复用既有真源**（不另抄 SQL）：
 *   · 交付物 byType —— `deliverable-lifecycle.ts:386 countDeliverablesByType`（探针/退休口径一并继承）。
 *   · 调用账成败 —— `service-call-ledger.ts:120 describeServiceCalls`（三类都出栏的口径一并继承）。
 *   · 三元组 —— 此处是**项目级 top-by-confidence**，**与 `memory-manager.searchKnowledgeGraph` 是不同问题**：
 *     后者按**关键词 LIKE + 1 跳扩展**（"与什么相关"）；这里只要"本项目**最可信**的 N 条关系"（无查询词）。
 *     两者取数谓词、排序、有无跳数皆不同 ⇒ 不是"同一条规则的第二份实现"。
 *
 * ⚠ **零 electron**（同 `project-runtime-summary.ts`）：rr 可拿内存库**直跑生产真实现**，非照抄等价物。
 */
import type Database from 'better-sqlite3';
import { countDeliverablesByType } from './deliverable-lifecycle.js';
import { describeServiceCalls } from './service-call-ledger.js';

/** 三元组最多取几条——只喂"最可信的关系"，不把整张图灌进提示词。 */
const TOP_TRIPLES = 12;

export interface KnowledgeTriple { subject: string; predicate: string; object: string }
export interface DeliverableTypeCount { type: string; count: number }
export interface ServiceCallOverview {
  total: number;
  ok: number;
  failed: number;
  byKind: Array<{ kind: string; calls: number; ok: number; failed: number }>;
}

/** 实体/谓词的**出现次数**（不看可信度——那是 `triples` 的尺；这里回答"天天在说什么"）。 */
export interface KnowledgeTermFrequency { name: string; count: number }

export interface ProjectKnowledgeMaterials {
  triples: KnowledgeTriple[];
  /** zx_20261018_2 批四：全量三元组的频度（**不受** `TOP_TRIPLES` 限制——计数要全量才准）。 */
  tripleFrequency: { entities: KnowledgeTermFrequency[]; predicates: KnowledgeTermFrequency[] };
  deliverablesByType: DeliverableTypeCount[];
  serviceCalls: ServiceCallOverview;
}

/**
 * 读某项目的**非记忆原料**（只读）。**不写任何东西**。
 * 空库/新项目 ⇒ 三样皆空（"未发生"是如实值，不伪造）。
 */
export function collectProjectKnowledgeMaterials(
  db: { prepare(sql: string): { all(...args: unknown[]): unknown } },
  projectId: string,
): ProjectKnowledgeMaterials {
  const pid = projectId || '';
  const triples = db.prepare(
    `SELECT subject, predicate, object FROM wa_knowledge_triples
     WHERE project_id = ? ORDER BY confidence DESC, rowid DESC LIMIT ?`,
  ).all(pid, TOP_TRIPLES) as KnowledgeTriple[];
  // 频度须**全量**计数（top-N 只代表"最可信"，用它计数会把冷门但高频的实体系漏）。
  const allTriples = db.prepare(
    'SELECT subject, predicate, object FROM wa_knowledge_triples WHERE project_id = ?',
  ).all(pid) as KnowledgeTriple[];
  const ents = new Map<string, number>();
  const preds = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string): void => { if (k) m.set(k, (m.get(k) ?? 0) + 1); };
  for (const t of allTriples) {
    bump(ents, t.subject);
    bump(ents, t.object);
    bump(preds, t.predicate);
  }
  const toFrequency = (m: Map<string, number>): KnowledgeTermFrequency[] =>
    [...m.entries()].map(([name, count]) => ({ name, count }));

  const deliverablesByType = countDeliverablesByType(db as never, { projectId: pid })
    .map((r) => ({ type: r.type, count: r.c }));
  const sc = describeServiceCalls(db as never, pid);
  return {
    triples,
    tripleFrequency: { entities: toFrequency(ents), predicates: toFrequency(preds) },
    deliverablesByType,
    serviceCalls: {
      total: sc.total,
      ok: sc.ok,
      failed: sc.failed,
      byKind: sc.byKind.map((k) => ({ kind: k.kind, calls: k.calls, ok: k.ok, failed: k.failed })),
    },
  };
}

/**
 * 把非记忆原料格式化成提示词片段（纯函数）。**空则返回空串**（不出段——不给 LLM 灌空壳）。
 *
 * 调用账**有**通话时三档**都出栏**（含 0 次那档——"没发生过"≠"没这一栏"，承 `service-call-ledger` 口径）；
 * 一通未通时整段不出（对提示词是噪声；"零"的如实呈现属**界面**职责，见 M4/M6）。
 */
export function formatKnowledgeMaterials(m: ProjectKnowledgeMaterials): string {
  const lines: string[] = [];
  if (m.triples.length > 0) {
    lines.push('【项目关系（知识图谱最可信的关系）】');
    for (const t of m.triples) lines.push(`- ${t.subject} ─[${t.predicate}]→ ${t.object}`);
  }
  if (m.deliverablesByType.length > 0) {
    lines.push('【已产出（交付物按类型计数）】');
    lines.push(m.deliverablesByType.map((d) => `${d.type}:${d.count}`).join(' · '));
  }
  const sc = m.serviceCalls;
  if (sc.total > 0) {
    lines.push('【服务调用账（对外/对服务调用的成败）】');
    lines.push(`合计 ${sc.total}（成功 ${sc.ok} / 失败 ${sc.failed}）`);
    for (const k of sc.byKind) lines.push(`- ${k.kind}: ${k.calls} 次（成 ${k.ok} / 败 ${k.failed}）`);
  }
  return lines.join('\n');
}
