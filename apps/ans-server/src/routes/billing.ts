import type Database from 'better-sqlite3';
import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';

export function billingRoutes(db: Database.Database) {
  return (
    new Elysia({ prefix: '/api/v1/billing' })
      // 查询计费记录
      .get(
        '/records',
        ({ query }) => {
          const projectId = query?.project_id as string | undefined;
          const days = Number(query?.days) || 30;
          const limit = Number(query?.limit) || 100;
          const offset = Number(query?.offset) || 0;

          const since = new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
          let sql = 'SELECT * FROM ans_billing_records WHERE created_at >= ?';
          const params: unknown[] = [since];
          if (projectId) {
            sql += ' AND project_id = ?';
            params.push(projectId);
          }
          sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
          params.push(limit, offset);

          return { data: db.prepare(sql).all(...params) };
        },
        {
          query: t.Optional(
            t.Object({
              project_id: t.Optional(t.String()),
              days: t.Optional(t.String()),
              limit: t.Optional(t.String()),
              offset: t.Optional(t.String()),
            }),
          ),
        },
      )

      // 写入计费记录（内部调用）
      .post(
        '/records',
        ({ body, set }) => {
          const id = randomUUID();
          db.prepare(
            'INSERT INTO ans_billing_records (id, endpoint_id, model_id, project_id, tokens_in, tokens_out, cost, currency) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(
            id,
            body.endpoint_id,
            body.model_id,
            body.project_id ?? null,
            body.tokens_in ?? 0,
            body.tokens_out ?? 0,
            body.cost ?? 0,
            body.currency ?? 'USD',
          );
          set.status = 201;
          return { data: { id } };
        },
        {
          body: t.Object({
            endpoint_id: t.String(),
            model_id: t.String(),
            project_id: t.Optional(t.String()),
            tokens_in: t.Optional(t.Number()),
            tokens_out: t.Optional(t.Number()),
            cost: t.Optional(t.Number()),
            currency: t.Optional(t.String()),
          }),
        },
      )

      // 使用统计
      .get(
        '/usage',
        ({ query }) => {
          const days = Number(query?.days) || 30;
          const since = new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
          const rows = db
            .prepare(
              `
        SELECT model_id, SUM(tokens_in) as total_tokens_in, SUM(tokens_out) as total_tokens_out, SUM(cost) as total_cost, COUNT(*) as call_count
        FROM ans_billing_records WHERE created_at >= ? GROUP BY model_id ORDER BY total_cost DESC
      `,
            )
            .all(since);
          return { data: rows };
        },
        { query: t.Optional(t.Object({ days: t.Optional(t.String()) })) },
      )

      // 按日趋势统计
      .get(
        '/usage/daily',
        ({ query }) => {
          const days = Number(query?.days) || 7;
          const since = new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
          const rows = db
            .prepare(
              `
        SELECT date(created_at) as date, SUM(tokens_in + tokens_out) as total_tokens, SUM(cost) as total_cost, COUNT(*) as call_count
        FROM ans_billing_records WHERE created_at >= ? GROUP BY date(created_at) ORDER BY date ASC
      `,
            )
            .all(since);
          return { data: rows };
        },
        { query: t.Optional(t.Object({ days: t.Optional(t.String()) })) },
      )

      // 按项目统计
      .get('/usage/by-project', ({ query }) => {
        const days = Number(query?.days) || 30;
        const since = new Date(Date.now() - days * 86400000).toISOString().replace('T', ' ').slice(0, 19);
        const rows = db
          .prepare(
            `
        SELECT project_id, SUM(tokens_in) as total_tokens_in, SUM(tokens_out) as total_tokens_out, SUM(cost) as total_cost, COUNT(*) as call_count
        FROM ans_billing_records WHERE created_at >= ? GROUP BY project_id ORDER BY total_cost DESC
      `,
          )
          .all(since);
        return { data: rows };
      })

      // P0.5 实践验证：记录模型使用质量（供匹配引擎参考）
      .post(
        '/quality',
        ({ body, set }) => {
          const id = randomUUID();
          db.prepare(
            'INSERT INTO ans_model_quality_logs (id, model_id, project_id, task_type, capability, success, output_accepted, token_efficiency, latency_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          ).run(
            id,
            body.model_id,
            body.project_id || null,
            body.task_type || null,
            body.capability || 'chat',
            body.success ? 1 : 0,
            body.output_accepted ? 1 : 0,
            body.token_efficiency ?? null,
            body.latency_ms ?? null,
          );
          set.status = 201;
          return { data: { id } };
        },
        {
          body: t.Object({
            model_id: t.String(),
            project_id: t.Optional(t.String()),
            task_type: t.Optional(t.String()),
            capability: t.Optional(t.String()),
            success: t.Optional(t.Boolean()),
            output_accepted: t.Optional(t.Boolean()),
            token_efficiency: t.Optional(t.Number()),
            latency_ms: t.Optional(t.Number()),
          }),
        },
      )

      // 查询质量统计
      .get(
        '/quality',
        ({ query }) => {
          const projectId = query?.project_id as string | undefined;
          const rows = db
            .prepare(
              `
        SELECT model_id,
               CAST(SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS REAL) / MAX(COUNT(*), 1) as success_rate,
               COUNT(*) as total_uses,
               AVG(token_efficiency) as avg_token_efficiency,
               AVG(latency_ms) as avg_latency_ms
        FROM ans_model_quality_logs
        WHERE (? IS NULL OR project_id = ?)
        GROUP BY model_id
        ORDER BY total_uses DESC
      `,
            )
            .all(projectId || null, projectId || null);
          return { data: rows };
        },
        { query: t.Optional(t.Object({ project_id: t.Optional(t.String()) })) },
      )
  );
}
