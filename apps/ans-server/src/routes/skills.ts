import type Database from 'better-sqlite3';
import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { notFound } from '../utils/errors.js';
import { AuditService } from '../services/audit.js';
import { getResourceGroupsFromApiKey } from '../utils/security.js';
import { parsePagination, paginationClause, paginationArgs, pageMeta } from '../utils/pagination.js';

export function skillsRoutes(db: Database.Database) {
  const audit = new AuditService(db);

  return (
    new Elysia({ prefix: '/api/v1/skills' })
      .get('/', ({ query }) => {
        // M15-⑤: 加 `limit`/`offset`/`total`（**缺省不限**——不给上限，就不改现有阅读面读到的条数）
        const page = parsePagination(query as Record<string, unknown>);
        const tags = query?.tags as string | undefined;
        if (tags) {
          const tagList = tags.split(',');
          let rows = db
            .prepare('SELECT * FROM ans_skills WHERE status = ? ORDER BY created_at DESC')
            .all('active') as unknown[];
          // 客户端过滤tags匹配
          rows = rows.filter((row: any) => {
            try {
              const skillTags: string[] = JSON.parse(row.tags as string);
              return tagList.some((t) => skillTags.includes(t));
            } catch {
              return false;
            }
          });
          // 过滤发生在内存里 ⇒ total 是**过滤后**的全量（不是表全量），分页只能在这一层切
          const total = rows.length;
          const paged = page.limit === null ? rows : rows.slice(page.offset, page.offset + page.limit);
          return { data: paged, ...pageMeta(total, page, paged.length) };
        }
        const total = (
          db.prepare("SELECT COUNT(*) as c FROM ans_skills WHERE status = 'active'").get() as { c: number }
        ).c;
        const rows = db
          .prepare(`SELECT * FROM ans_skills WHERE status = 'active' ORDER BY created_at DESC${paginationClause(page)}`)
          .all(...paginationArgs(page));
        return { data: rows, ...pageMeta(total, page, rows.length) };
      })
      .get('/:id', ({ params: { id } }) => {
        const row = db.prepare('SELECT * FROM ans_skills WHERE id = ?').get(id);
        if (!row) throw notFound('Skill', id);
        return { data: row };
      })
      .post(
        '/',
        ({ body, set }) => {
          const id = randomUUID();
          db.prepare(
            'INSERT INTO ans_skills (id, name, description, input_schema, mcp_server_id, tags) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(
            id,
            body.name,
            body.description ?? '',
            JSON.stringify(body.input_schema ?? {}),
            body.mcp_server_id ?? null,
            JSON.stringify(body.tags ?? []),
          );
          audit.log({
            actor: 'api',
            action: 'create_skill',
            resource_type: 'skill',
            resource_id: id,
            detail: { name: body.name },
          });
          set.status = 201;
          return { data: { id, ...body } };
        },
        {
          body: t.Object({
            name: t.String(),
            description: t.Optional(t.String()),
            input_schema: t.Optional(t.Record(t.String(), t.Unknown())),
            mcp_server_id: t.Optional(t.String()),
            tags: t.Optional(t.Array(t.String())),
          }),
        },
      )
      .put(
        '/:id',
        ({ params: { id }, body }) => {
          const existing = db.prepare('SELECT id FROM ans_skills WHERE id = ?').get(id);
          if (!existing) throw notFound('Skill', id);
          db.prepare(
            'UPDATE ans_skills SET name = ?, description = ?, input_schema = ?, mcp_server_id = ?, tags = ? WHERE id = ?',
          ).run(
            body.name,
            body.description ?? '',
            JSON.stringify(body.input_schema ?? {}),
            body.mcp_server_id ?? null,
            JSON.stringify(body.tags ?? []),
            id,
          );
          return { data: { id, ...body } };
        },
        {
          body: t.Object({
            name: t.String(),
            description: t.Optional(t.String()),
            input_schema: t.Optional(t.Record(t.String(), t.Unknown())),
            mcp_server_id: t.Optional(t.String()),
            tags: t.Optional(t.Array(t.String())),
          }),
        },
      )
      .delete('/:id', ({ params: { id } }) => {
        db.prepare('UPDATE ans_skills SET status = ? WHERE id = ?').run('disabled', id);
        return { data: { id, status: 'disabled' } };
      })

      // 最优匹配
      .post(
        '/optimal',
        ({ body, request }) => {
          const groups = getResourceGroupsFromApiKey(db, request);
          let q =
            "SELECT id, name, description, input_schema, tags, resource_group FROM ans_skills WHERE status = 'active'";
          const p: string[] = [];
          if (groups.length > 0) {
            q += ` AND (${groups.map(() => "resource_group = ? OR resource_group = '' OR resource_group IS NULL").join(' OR ')})`;
            groups.forEach((rg) => p.push(rg));
          }
          const skills = db.prepare(q).all(...p) as Array<Record<string, unknown>>;
          if (body.name) {
            const exact = skills.find((s) => s.name === body.name);
            if (exact) return { data: parseSkill(skills, exact) };
          }
          if (body.tags && body.tags.length > 0) {
            const matched = skills.filter((s) => {
              try {
                const skillTags: string[] = JSON.parse(s.tags as string);
                return body.tags!.some((t) => skillTags.includes(t));
              } catch {
                return false;
              }
            });
            if (matched.length > 0) return { data: parseSkill(skills, matched[0]!) };
          }
          // 返回第一个可用技能
          if (skills.length > 0) return { data: parseSkill(skills, skills[0]!) };
          throw notFound('Skill', 'any');
        },
        {
          body: t.Object({
            name: t.Optional(t.String()),
            tags: t.Optional(t.Array(t.String())),
          }),
        },
      )
  );
}

function parseSkill(_all: Array<Record<string, unknown>>, row: Record<string, unknown>) {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    input_schema: parseJson(row.input_schema),
    tags: parseJson(row.tags),
  };
}

function parseJson(val: unknown): unknown {
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return val;
    }
  }
  return val;
}
