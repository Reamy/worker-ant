/**
 * zx_20261004 M14（K-8 轻得下 / 维特根斯坦·一个规则一处）: **知识图谱簇**——自 `memory-manager.ts`
 * 机械搬迁而来的自由函数（来源符号区间：原 `storeTriple` … `extractTriplesWithLLM`，即该文件
 * 1459–1611 行）。**逐字节行为不变**：SQL、提示词、正则、常量一字未动。
 *
 * 函数取 `(mgr, …)`——`mgr` 只需满足下方最小宿主接口（读 `db` / `ansClient`）。`MemoryManager`
 * 的同名方法现为**薄委托**（`return storeTriple(this, …)`），故全部既有调用点零改动。
 */
import type Database from 'better-sqlite3';
import { type AnsClient } from '@worker-ant/ans-client';
import { randomUUID } from 'node:crypto';
import { generateText } from 'ai';
import { createSafeProvider } from './ai-provider.js';
import { createLogger } from './logger.js';
// zx_20261012_1 批一（M29 静默失败清零）: `retrieveKnowledgeGraphContext` 的空 catch 收为具名计数。
import { recordMemoryFailure, MEM_FAIL } from './memory-failure.js';
import { auxModelRequest } from './model-request.js';

const logger = createLogger('memory');

/** 知识图谱簇所需的最小宿主面：一个库 + 一个 ANS 客户端（`MemoryManager` 结构上满足）。 */
export interface MemoryKgHost {
  readonly db: Database.Database;
  readonly ansClient: AnsClient;
}

/** 存储知识三元组（去重：同subject+predicate+object+project_id不重复插入） */
export function storeTriple(mgr: MemoryKgHost, params: { projectId: string; subject: string; predicate: string; object: string; confidence?: number; source?: string }): string | null {
  const { projectId, subject, predicate, object, confidence = 0.5, source = 'agent_extraction' } = params;
  const existing = mgr.db.prepare(
    'SELECT id FROM wa_knowledge_triples WHERE project_id = ? AND subject = ? AND predicate = ? AND object = ?',
  ).get(projectId, subject, predicate, object) as { id: string } | undefined;
  if (existing) {
    // 已有：提升置信度
    mgr.db.prepare('UPDATE wa_knowledge_triples SET confidence = MIN(1.0, confidence + ?) WHERE id = ?')
      .run(confidence * 0.3, existing.id);
    return existing.id;
  }
  const id = randomUUID();
  mgr.db.prepare(
    'INSERT INTO wa_knowledge_triples (id, project_id, subject, predicate, object, confidence, source) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(id, projectId, subject, predicate, object, confidence, source);
  return id;
}

/** 知识图谱检索：1-2跳邻域扩展 */
export function searchKnowledgeGraph(mgr: MemoryKgHost, query: string, projectId: string, limit = 10): Array<{ subject: string; predicate: string; object: string; confidence: number }> {
  // 直接匹配：subject或object包含查询词
  const direct = mgr.db.prepare(`
    SELECT subject, predicate, object, confidence FROM wa_knowledge_triples
    WHERE project_id = ? AND (subject LIKE ? OR object LIKE ? OR predicate LIKE ?)
    ORDER BY confidence DESC LIMIT ?
  `).all(projectId, `%${query}%`, `%${query}%`, `%${query}%`, limit) as Array<{ subject: string; predicate: string; object: string; confidence: number }>;

  // 1跳扩展：如果直接结果少于limit/2，用直接结果的subject/object再查
  if (direct.length < limit / 2) {
    const entities = new Set<string>();
    for (const t of direct) { entities.add(t.subject); entities.add(t.object); }
    if (entities.size > 0) {
      const placeholders = [...entities].map(() => '?').join(',');
      // zx_20261003 M6（注入确认打出的真缺陷）: SQL 里 `subject IN (...)` 与 `object IN (...)`
      //   是**两处**占位（共 2n 个 `?`），此前只 `...[entities]` **绑一次**（n 个）⇒ 参数少于占位，
      //   better-sqlite3 抛 `RangeError`、被 `retrieveKnowledgeGraphContext` 的 catch 吞成 `[]`——
      //   即"直接命中少于 limit/2（常见情形）"时 **§7 相关知识关联静默恒空**。此处把实体绑**两遍**。
      const entityVals = [...entities];
      const expanded = mgr.db.prepare(`
        SELECT subject, predicate, object, confidence FROM wa_knowledge_triples
        WHERE project_id = ? AND (subject IN (${placeholders}) OR object IN (${placeholders}))
        ORDER BY confidence DESC LIMIT ?
      `).all(projectId, ...entityVals, ...entityVals, limit - direct.length) as Array<{ subject: string; predicate: string; object: string; confidence: number }>;
      return [...direct, ...expanded].slice(0, limit);
    }
  }
  return direct;
}

/**
 * Phase 3.1 家族相似性：从任务标题/描述提取关键词，查询知识图谱，返回去重后的相关三元组。
 * 优先【】内领域词，其次长度>1的中英文词（过滤常见虚词），限前3个查询词。
 */
export function retrieveKnowledgeGraphContext(mgr: MemoryKgHost, taskId: string, projectId: string, limit = 5): Array<{ subject: string; predicate: string; object: string }> {
  try {
    const task = mgr.db.prepare('SELECT title, description FROM wa_tasks WHERE id = ?').get(taskId) as { title: string; description: string } | undefined;
    if (!task) return [];
    const text = `${task.title} ${(task.description || '').slice(0, 300)}`;
    const stopWords = new Set(['扩展', '管理', '工具', '任务', '实现', '报告', '的', '了', '在', '是', '和', '与', '及', '或', 'to', 'the', 'for', 'and', 'of', 'a', 'an']);
    const bracketMatches = text.match(/【([^】]+)】/g)?.map(s => s.replace(/[【】]/g, '')) ?? [];
    const words = text.split(/[\s,，。、；：！？\n()（）:：/]+/).filter(w => w.length > 1 && !stopWords.has(w));
    const terms = [...new Set([...bracketMatches, ...words])].slice(0, 3);
    if (terms.length === 0) return [];

    const results: Array<{ subject: string; predicate: string; object: string }> = [];
    const seen = new Set<string>();
    for (const term of terms) {
      for (const t of searchKnowledgeGraph(mgr, term, projectId, 5)) {
        const key = `${t.subject}|${t.predicate}|${t.object}`;
        if (!seen.has(key)) { seen.add(key); results.push({ subject: t.subject, predicate: t.predicate, object: t.object }); }
      }
      if (results.length >= limit) break;
    }
    return results.slice(0, limit);
  } catch (err) { recordMemoryFailure(MEM_FAIL.kgQuery, err, { taskId, projectId }); return []; }
}

/** 简单三元组提取：从文本中提取常见关系模式 */
export function extractTriples(mgr: MemoryKgHost, text: string, projectId: string): number {
  const patterns: Array<{ regex: RegExp; predicate: string; extract: (m: RegExpMatchArray) => [string, string] }> = [
    { regex: /(?:使用|基于|采用|using|built with|powered by)\s+([A-Za-z@/.\-_#一-鿿]+)/gi, predicate: 'uses', extract: (m) => ['project', m[1]!] },
    { regex: /(?:创建|生成|产出|created|generated|produced)\s+([A-Za-z@/.\-_#一-鿿]+)/gi, predicate: 'produced', extract: (m) => ['task', m[1]!] },
    { regex: /(?:部署到|deployed to|部署于)\s+([A-Za-z@/.\-_#一-鿿]+)/gi, predicate: 'deployed_to', extract: (m) => ['project', m[1]!] },
    { regex: /(?:集成|对接|integrated with)\s+([A-Za-z@/.\-_#一-鿿]+)/gi, predicate: 'integrates_with', extract: (m) => ['project', m[1]!] },
    { regex: /(?:依赖|依赖项|depends on)\s+([A-Za-z@/.\-_#一-鿿]+)/gi, predicate: 'depends_on', extract: (m) => ['project', m[1]!] },
    { regex: /(?:实现了|implements)\s+([A-Za-z@/.\-_#一-鿿]+)/gi, predicate: 'implements', extract: (m) => ['task', m[1]!] },
  ];
  let count = 0;
  for (const { regex, predicate, extract } of patterns) {
    const matches = text.matchAll(regex);
    for (const m of matches) {
      const [subjType, obj] = extract(m);
      const subject = subjType === 'project' ? projectId.slice(0, 8) : `task`;
      if (obj && obj.length > 1 && obj.length < 60) {
        const id = storeTriple(mgr, { projectId, subject, predicate, object: obj.toLowerCase(), confidence: 0.6, source: 'pattern_extraction' });
        if (id) count++;
      }
    }
  }
  if (count > 0) logger.info({ projectId, count }, '知识三元组(正则)已提取');
  return count;
}

/** LLM驱动的三元组提取：用低成本模型从文本中提取关系 */
export async function extractTriplesWithLLM(mgr: MemoryKgHost, text: string, projectId: string, taskId: string): Promise<number> {
  if (!text || text.length < 50) return 0;
  const prompt = `从以下任务输出中提取知识三元组（主体-关系-客体）。每条三元组表示一个实体之间的关系。

输出格式：JSON数组，每个元素包含 subject, predicate, object 三个字段。

关系类型（predicate）可以是：
- uses: 使用/依赖于某技术、工具、库
- produces: 产出/创建了某物
- depends_on: 依赖某个外部服务或数据源
- belongs_to: 属于某个分类或领域
- related_to: 与其他概念相关

要求：
1. 主体和客体尽量使用具体名称（如"tushare"而非"数据源"）
2. 每条关系应基于文本中明确提到的内容，不要臆造
3. 返回5-15条高质量三元组，如果文本信息不足则返回较少条数

任务输出文本：
${text.slice(0, 3000)}

只返回JSON数组，不要其他文字。`;

  try {
    const m = await mgr.ansClient.getOptimalModel(auxModelRequest());
    if (!m?.url || !m?.api_key || !m?.model_name) return 0;
    const provider = createSafeProvider({ baseURL: m.url, apiKey: m.api_key });
    const model = provider(m.model_name);
    const result = await generateText({ model, prompt, temperature: 0.2, maxTokens: m.max_output_tokens || 4096 });
    const content = result.text || '';
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return 0;
    const triples = JSON.parse(jsonMatch[0]) as Array<{ subject: string; predicate: string; object: string }>;
    let count = 0;
    for (const t of triples) {
      if (!t.subject || !t.predicate || !t.object) continue;
      if (t.subject.length > 80 || t.object.length > 80) continue;
      const validPredicates = new Set(['uses', 'produces', 'depends_on', 'belongs_to', 'related_to', 'deployed_to', 'integrates_with', 'implements']);
      const pred = validPredicates.has(t.predicate) ? t.predicate : 'related_to';
      const id = storeTriple(mgr, { projectId, subject: t.subject.toLowerCase(), predicate: pred, object: t.object.toLowerCase(), confidence: 0.7, source: 'llm_extraction' });
      if (id) count++;
    }
    if (count > 0) logger.info({ projectId, taskId, count, model: m.model_name }, '知识三元组(LLM)已提取');
    return count;
  } catch (err) {
    recordMemoryFailure(MEM_FAIL.kgExtractLlm, err, { projectId, taskId });
    logger.warn({ err, projectId, taskId }, 'LLM三元组提取失败，回退到正则');
    return extractTriples(mgr, text, projectId);
  }
}
