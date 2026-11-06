import type Database from 'better-sqlite3';
import { Elysia, t } from 'elysia';
import { randomUUID } from 'node:crypto';
import { ApiKeyManager } from '../utils/security.js';

export function authRoutes(db: Database.Database) {
  const keyManager = new ApiKeyManager(db);

  return (
    new Elysia({ prefix: '/api/v1/auth' })
      // 获取所有API Key（含resource_groups）
      .get('/api-keys', () => {
        const keys = keyManager.listApiKeys();
        return { data: keys.map((k) => ({ ...k, resource_groups: safeParse(k.resource_groups, []) })) };
      })
      // 创建API Key对（8.1: 支持resource_groups）
      .post(
        '/api-keys',
        ({ body, set }) => {
          const groups = body.resource_groups ?? [];
          const result = keyManager.createApiKey(body.name ?? 'default', groups);
          set.status = 201;
          return { data: { api_key: result.apiKey, secret: result.secret, name: body.name, resource_groups: groups } };
        },
        { body: t.Object({ name: t.Optional(t.String()), resource_groups: t.Optional(t.Array(t.String())) }) },
      )
      // 更新API Key资源组绑定
      .put(
        '/api-keys/:prefix',
        ({ params: { prefix }, body }) => {
          keyManager.updateResourceGroups(prefix, body.resource_groups ?? []);
          return { data: { prefix, resource_groups: body.resource_groups } };
        },
        { body: t.Object({ resource_groups: t.Array(t.String()) }) },
      )
      // 撤销API Key
      .delete('/api-keys/:prefix', ({ params: { prefix } }) => {
        keyManager.revokeApiKey(prefix);
        return { data: { prefix, status: 'revoked' } };
      })
  );
}

function safeParse(val: unknown, fallback: unknown): unknown {
  if (typeof val === 'string') {
    try {
      return JSON.parse(val);
    } catch {
      return fallback;
    }
  }
  return val ?? fallback;
}
