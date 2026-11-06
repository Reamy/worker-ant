/**
 * zx_20260930 M15-④（全局错误处置）+ M15-①（a2a-proxy 去掉不存在的列）。
 *
 * 判据纪律（G-1…G-7）：
 *   G-1 调**生产导出**（`errorResponseOf` / `errorHandler` / `deriveA2aTaskUrl` / `a2aProxyRoutes`），
 *       不另写等价物。`errorHandler()` 是 `index.ts` 挂的**同一个**插件 ⇒ 测的是生产那一跳，
 *       不是判据自己转写的那一份（"判据的自我印证"）。
 *   G-2 正反两侧各给真标本：内网 URL 那侧要能照出来（正面断言在场），通用文案那侧要照不出来（反面）。
 *   G-7 夹具逐列照抄 `db/schema.ts` 的 DDL——尤其 `ans_a2a_servers` **没有 `endpoint` 列**（正是 ① 的病根）。
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { Elysia } from 'elysia';
import Database from 'better-sqlite3';
import {
  AppError,
  ErrorCode,
  INTERNAL_ERROR_MESSAGE,
  errorResponseOf,
  formatErrorResponse,
  notFound,
} from '../utils/errors.js';
import { handleRouteError } from '../utils/error-handler.js';
import { deriveA2aTaskUrl, a2aProxyRoutes } from '../routes/a2a-proxy.js';

/** 一句**真标本**的内部细节：既是内网 URL 又带端口。『不外泄』的判据拿它当"该照不出来"的那面。 */
const INTERNAL_LEAK = 'upstream http://ans.internal:3001/v1/chat failed: no such column: endpoint';

describe('M15-④ errorResponseOf（纯函数：四支处置）', () => {
  it('① AppError → 它自己的 status/code/message/detail（本仓刻意写给人看的，原样回）', () => {
    const r = errorResponseOf(new AppError(ErrorCode.FORBIDDEN, '系统推荐供应商不可删除', 403, { x: 1 }), 'UNKNOWN');
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');
    expect(r.body.error.message).toBe('系统推荐供应商不可删除');
    expect(r.body.error.detail).toEqual({ x: 1 });
  });

  it('④ 裸 Error → 500 + 通用文案；**原文（内网 URL）不在体里**（有账但不外泄）', () => {
    const r = errorResponseOf(new Error(INTERNAL_LEAK), 'UNKNOWN');
    expect(r.status).toBe(500);
    expect(r.body.error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(r.body.error.message).toBe(INTERNAL_ERROR_MESSAGE);
    // 反证：真标本里的内网字符串一个都不许出现（正面断言"通用"不足以证明"没泄漏"）
    const raw = JSON.stringify(r.body);
    expect(raw).not.toContain('ans.internal');
    expect(raw).not.toContain('3001');
    expect(raw).not.toContain('no such column');
  });

  it('②③ Elysia 侧 code：VALIDATION/PARSE/NOT_FOUND 各自的码与状态', () => {
    const bad = new Error('body must be Object'); // 校验器原文含 schema 细节 ⇒ 不回
    const v = errorResponseOf(bad, 'VALIDATION');
    expect(v.status).toBe(400);
    expect(v.body.error.code).toBe(ErrorCode.VALIDATION_ERROR);
    expect(JSON.stringify(v.body)).not.toContain('body must be Object');

    const p = errorResponseOf(new Error('parse fail'), 'PARSE');
    expect(p.status).toBe(400);
    expect(p.body.error.code).toBe(ErrorCode.INVALID_REQUEST);

    const n = errorResponseOf(new Error('not found'), 'NOT_FOUND');
    expect(n.status).toBe(404);
    expect(n.body.error.code).toBe(ErrorCode.NOT_FOUND);
  });

  it('notFound() 是 AppError ⇒ 走 ① 支（404 + 资源名）', () => {
    const r = errorResponseOf(notFound('Model', 'm9'), 'UNKNOWN');
    expect(r.status).toBe(404);
    expect(r.body.error.message).toContain('m9');
  });

  it('formatErrorResponse 有生产调用方（不再是"零调用方"的死码）', () => {
    // 直调它本身即证它在册；接线由下一条（errorHandler 组装）证。
    expect(formatErrorResponse(new AppError(ErrorCode.CONFLICT, 'dup', 409)).error.code).toBe('CONFLICT');
  });
});

describe('M15-④ 错误处置接线（生产回调，真跑一次路由抛错）', () => {
  // 与 `index.ts` 一字不差的那一跳：`.onError(handleRouteError)`
  // 类型由**构建表达式派生**（`models-routes.test.ts` 的成法）：`let app: Elysia` 是"裸泛型"，与带
  // 路由表的实例不同型（onStart 不兼容）⇒ 赋值处会 TS2322。
  const buildApp = () =>
    new Elysia()
      .onError(handleRouteError)
      .get('/boom-app', () => {
        throw new AppError(ErrorCode.FORBIDDEN, '刻意拒绝', 403);
      })
      .get('/boom-raw', () => {
        throw new Error(INTERNAL_LEAK);
      });
  let app: ReturnType<typeof buildApp>;
  beforeAll(() => {
    app = buildApp();
  });

  it('AppError 经接线 → 403 + 自己的文案', async () => {
    const res = await app.handle(new Request('http://localhost/boom-app'));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('FORBIDDEN');
    expect(body.error.message).toBe('刻意拒绝');
  });

  it('裸 Error 经接线 → 500 + 通用文案（端到端：状态码与体都到位，且不泄漏）', async () => {
    const res = await app.handle(new Request('http://localhost/boom-raw'));
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(JSON.parse(raw).error.message).toBe(INTERNAL_ERROR_MESSAGE);
    expect(raw).not.toContain('ans.internal');
    expect(raw).not.toContain('no such column');
  });
});

describe('M15-① deriveA2aTaskUrl（唯一派生处，两侧标本）', () => {
  it('三种已知 Agent Card 后缀 → 归一到 /tasks', () => {
    expect(deriveA2aTaskUrl('http://a.example/.well-known/agent.json')).toBe('http://a.example/tasks');
    expect(deriveA2aTaskUrl('http://a.example/agent-card.json')).toBe('http://a.example/tasks');
    expect(deriveA2aTaskUrl('http://a.example/agent.json')).toBe('http://a.example/tasks');
  });

  it('裸 base（无已知后缀）**原样返回**——旧行为如此，不借修 bug 改语义', () => {
    expect(deriveA2aTaskUrl('http://a.example/v1')).toBe('http://a.example/v1');
    expect(deriveA2aTaskUrl('http://a.example')).toBe('http://a.example');
    expect(deriveA2aTaskUrl('')).toBe('');
  });
});

describe('M15-① a2a-proxy 任务端点（真库夹具：无 endpoint 列）', () => {
  let db: Database.Database;
  let app: ReturnType<typeof a2aProxyRoutes>;
  const origFetch = globalThis.fetch;

  beforeAll(() => {
    db = new Database(':memory:');
    // G-7: 逐列照抄 schema.ts 的 ans_a2a_servers —— **没有 endpoint 列**。
    //   旧实现 `SELECT agent_card_url, endpoint` 每调必抛 ⇒ send/get/cancel 恒 500。
    db.exec(`
      CREATE TABLE ans_a2a_servers (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        agent_card_url TEXT NOT NULL,
        capabilities TEXT DEFAULT '[]',
        auth_config TEXT DEFAULT '{"type":"none"}',
        status TEXT DEFAULT 'active',
        health_check_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    db.prepare(
      "INSERT INTO ans_a2a_servers (id, name, agent_card_url, capabilities) VALUES ('a1', 'helper', 'http://a.example/.well-known/agent.json', '[\"chat\"]')",
    ).run();
    app = a2aProxyRoutes(db);
  });

  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  const rpc = (method: string, params?: Record<string, unknown>) =>
    app.handle(
      new Request('http://localhost/a2a/tasks', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      }),
    );

  it('tasks/send 能读到 agent 并派生 URL（旧实现此处因不存在的列必抛）', async () => {
    let seenUrl = '';
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await rpc('tasks/send', { id: 'a1', message: { parts: [{ text: 'hi' }] } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: unknown; error?: { message: string } };
    expect(body.error).toBeUndefined();
    expect(body.result).toEqual({ ok: true });
    // 正面断言：打的是**派生**后的 /tasks（不是 agent_card_url 原文）
    expect(seenUrl).toBe('http://a.example/tasks');
  });

  it('tasks/get 与 tasks/send **同一把尺**（原此处少一条 /agent.json 替换）', async () => {
    let seenUrl = '';
    globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
      seenUrl = String(url);
      return new Response(JSON.stringify({ state: 'working' }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await rpc('tasks/get', { id: 'a1', taskId: 't1' });
    expect(res.status).toBe(200);
    expect(seenUrl).toBe('http://a.example/tasks');
  });

  it('上游抛错 → 500 + 通用文案；**上游原文（内网 URL）不进响应体**', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error(INTERNAL_LEAK);
    }) as unknown as typeof fetch;

    const res = await rpc('tasks/send', { id: 'a1', message: { parts: [{ text: 'hi' }] } });
    expect(res.status).toBe(500);
    const raw = await res.text();
    expect(JSON.parse(raw).error.message).toBe('Internal error');
    expect(raw).not.toContain('ans.internal');
    expect(raw).not.toContain('no such column');
  });

  it('agent/refresh 发现失败 → 通用文案（`discovery.error` 里的内网地址不外泄）', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:19952');
    }) as unknown as typeof fetch;

    const res = await rpc('agent/refresh', { id: 'a1' });
    const raw = await res.text();
    expect(JSON.parse(raw).error.message).toBe('Agent card discovery failed');
    expect(raw).not.toContain('127.0.0.1');
    expect(raw).not.toContain('19952');
  });
});
