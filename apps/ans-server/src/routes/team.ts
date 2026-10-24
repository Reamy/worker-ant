/**
 * zx_20261017_1 批六（维特根斯坦·意义即使用 / 管子·度量衡）: **团队共享库**的 ANS 路由。
 *
 * 三件事，各只做一件：
 *   · `GET /api/v1/team/items`  —— 任何 HMAC 调用方可读（分页 / 按 kind 过滤）。
 *   · `POST /api/v1/team/items` —— **只有节点凭据**可写；来源节点由凭据派生（`deriveRequesterNodeId`），
 *       body 里即便塞了 `source_node_id` 也不看（R-31：冒名无从下手）。
 *   · `DELETE /api/v1/team/items/:id` —— 只允许**来源节点**删自己的（他人 ⇒ 403；不存在 ⇒ 404）。
 *
 * ⚠ 上限（title 200 / body 64KB / 单节点 500）真源在 `@worker-ant/shared-types` 的 `team.ts`——
 *   本文件不写第二份数字。上限**只在此判**（唯一写入口）；桌面不预演一套 500 条判据。
 * ⚠ 成果只共享元数据：`file_path` 由桌面侧组装时剥掉；本路由不解析 body 语义，只存/取 JSON。
 * ⚠ 离线许可**不在此校验**（D-5）：Team 闸在桌面本地执行；ANS 只认节点凭据。
 */
import type Database from 'better-sqlite3';
import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { AppError, ErrorCode, conflict, notFound } from '../utils/errors.js';
import { parsePagination, paginationClause, paginationArgs, pageMeta } from '../utils/pagination.js';
import { deriveRequesterNodeId } from './nodes.js';
import {
  TEAM_ITEM_KINDS,
  TEAM_ITEM_MAX_BODY_BYTES,
  TEAM_ITEM_MAX_PER_NODE,
  TEAM_ITEM_MAX_TITLE,
  isTeamItemKind,
  type TeamItem,
  type TeamItemKind,
} from '@worker-ant/shared-types';

/** 拒因里的类型清单**由真源派生**——新增一类不会留下"三选一"的旧话（zx_20261021_3 批三）。 */
const KIND_LIST = TEAM_ITEM_KINDS.join(' / ');

interface TeamItemRow {
  id: string;
  kind: string;
  title: string;
  body_json: string;
  source_node_id: string;
  created_at: string;
  updated_at: string;
}

function parseBody(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    // 坏行如实解成空对象（读取面不因一行坏载荷整页失败）。
    return {};
  }
}

function toItem(row: TeamItemRow): TeamItem {
  return {
    id: row.id,
    kind: (isTeamItemKind(row.kind) ? row.kind : 'template') as TeamItemKind,
    title: row.title,
    body: parseBody(row.body_json),
    source_node_id: row.source_node_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function bad(message: string): AppError {
  return new AppError(ErrorCode.INVALID_REQUEST, message, 400);
}

/** 写入方必须是**已注册节点**——非节点凭据（外部终端 / dev key）没有"来源节点"可派生。 */
function requireNode(db: Database.Database, request: Request): string {
  const nodeId = deriveRequesterNodeId(db, request);
  if (!nodeId) throw new AppError(ErrorCode.FORBIDDEN, '只有已注册工蚁节点可写入团队共享库', 403);
  return nodeId;
}

/** 校验一条输入；合法回 `null`，否则回**能据以行动**的拒因（R-33 三件逐项）。 */
function validateInput(input: unknown): string | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return '请求体须为对象';
  const o = input as Record<string, unknown>;
  if (!isTeamItemKind(o.kind)) return `kind 须为 ${KIND_LIST} 之一（收到 ${String(o.kind)}）`;
  if (typeof o.title !== 'string') return 'title 须为字符串';
  if (o.title.length > TEAM_ITEM_MAX_TITLE) {
    return `标题过长：${o.title.length} 字符（上限 ${TEAM_ITEM_MAX_TITLE}）`;
  }
  if (!o.body || typeof o.body !== 'object' || Array.isArray(o.body)) return 'body 须为对象';
  const bytes = Buffer.byteLength(JSON.stringify(o.body), 'utf8');
  if (bytes > TEAM_ITEM_MAX_BODY_BYTES) {
    return `载荷过大：${bytes} 字节（上限 ${TEAM_ITEM_MAX_BODY_BYTES}）`;
  }
  return null;
}

export function teamRoutes(db: Database.Database) {
  return (
    new Elysia({ prefix: '/api/v1/team' })
      // 读：任何 HMAC 调用方（模板/记忆/成果的元数据本身不含密钥）。
      .get('/items', ({ query }) => {
        const q = (query ?? {}) as Record<string, unknown>;
        const kind = typeof q.kind === 'string' && q.kind ? q.kind : '';
        if (kind && !isTeamItemKind(kind)) throw bad(`kind 须为 ${KIND_LIST} 之一（收到 ${kind}）`);
        const filter = kind ? 'WHERE kind = ?' : '';
        const filterArgs: unknown[] = kind ? [kind] : [];
        const page = parsePagination(q);
        const total = (
          db.prepare(`SELECT COUNT(*) AS c FROM ans_team_items ${filter}`).get(...filterArgs) as { c: number }
        ).c;
        const rows = db
          .prepare(`SELECT * FROM ans_team_items ${filter} ORDER BY created_at DESC, id DESC${paginationClause(page)}`)
          .all(...filterArgs, ...paginationArgs(page)) as TeamItemRow[];
        return { data: rows.map(toItem), ...pageMeta(total, page, rows.length) };
      })
      // 写：来源节点**由凭据派生**；body 里的 `source_node_id` 一律不看。
      .post(
        '/items',
        ({ body, request, set }) => {
          const sourceNodeId = requireNode(db, request);
          const refusal = validateInput(body);
          if (refusal) throw bad(refusal);

          const input = body as { kind: TeamItemKind; title: string; body: Record<string, unknown> };
          const used = (
            db.prepare('SELECT COUNT(*) AS c FROM ans_team_items WHERE source_node_id = ?').get(sourceNodeId) as {
              c: number;
            }
          ).c;
          if (used >= TEAM_ITEM_MAX_PER_NODE) {
            throw conflict(`本节点已分享 ${used} 条（上限 ${TEAM_ITEM_MAX_PER_NODE}）；先删除旧条目再分享`);
          }

          const id = randomUUID();
          db.prepare(
            'INSERT INTO ans_team_items (id, kind, title, body_json, source_node_id) VALUES (?, ?, ?, ?, ?)',
          ).run(id, input.kind, input.title, JSON.stringify(input.body), sourceNodeId);
          const row = db.prepare('SELECT * FROM ans_team_items WHERE id = ?').get(id) as TeamItemRow;
          set.status = 201;
          return { data: toItem(row) };
        },
        { body: t.Any() },
      )
      // 删：只认来源节点（不存在 404；他人 403——两向标本见 vitest R-32）。
      .delete('/items/:id', ({ params, request }) => {
        const requester = requireNode(db, request);
        const row = db.prepare('SELECT * FROM ans_team_items WHERE id = ?').get(params.id) as TeamItemRow | undefined;
        if (!row) throw notFound('Team item', params.id);
        if (row.source_node_id !== requester) {
          throw new AppError(ErrorCode.FORBIDDEN, '只能删除本节点分享的条目', 403);
        }
        db.prepare('DELETE FROM ans_team_items WHERE id = ?').run(params.id);
        return { data: { id: params.id, deleted: true } };
      })
  );
}
