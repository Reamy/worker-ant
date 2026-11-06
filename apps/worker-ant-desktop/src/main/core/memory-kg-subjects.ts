/**
 * zx_20261018_3 批一（维特根斯坦·意义即用法 / 管子·度量衡）: 知识图谱**项目类三元组的主语**。
 *
 * 病根：旧实现把主语写成项目 id 前 8 位（`projectId.slice(0, 8)`，一串十六进制），而检索按任务
 *   标题/描述里的中文词做 `LIKE` ⇒ 这些三元组**永远匹配不到**，只写不读。
 *
 * 两件事共用这里的一份真源：
 *   · 写侧（`memory-kg.extractTriples`）取 `projectSubjectFor`；
 *   · 读侧（`retrieveKnowledgeGraphContext`）在任务词命中不足时把项目名当补充线索。
 *   · 旧行回填 `backfillTripleSubjects`——幂等，跑两次不改动第二遍的任何行。
 *
 * 纯 SQL / 零 electron 依赖（rr 直跑，不经过 IPC）。
 */
import type Database from 'better-sqlite3';

/** 项目类三元组的事实主语：项目名（去空白）；读不到名字才退回 id 前 8 位。 */
export function projectSubjectFor(db: Database.Database, projectId: string): string {
  try {
    const row = db.prepare('SELECT name FROM wa_projects WHERE id = ?').get(projectId) as { name?: string | null } | undefined;
    const name = (row?.name ?? '').trim();
    if (name) return name;
  } catch { /* 无表/无列 ⇒ 如实退回 id 前缀 */ }
  return projectId.slice(0, 8);
}

/**
 * 把旧主语（`substr(project_id,1,8)`）改写成项目名。返回改写行数。
 *
 * 只改**能读到项目名**的行；项目已不存在或名字为空的行原样保留（不猜、不抹）。
 * 幂等：改写后 `subject = name ≠ substr(id,1,8)`（除非名字恰等于前缀），第二遍命中 0 行。
 */
export function backfillTripleSubjects(db: Database.Database): number {
  const result = db.prepare(
    `UPDATE wa_knowledge_triples
        SET subject = (SELECT p.name FROM wa_projects p WHERE p.id = wa_knowledge_triples.project_id)
      WHERE subject = substr(project_id, 1, 8)
        AND EXISTS (
          SELECT 1 FROM wa_projects p
           WHERE p.id = wa_knowledge_triples.project_id AND TRIM(p.name) <> ''
        )`,
  ).run();
  return result.changes;
}
