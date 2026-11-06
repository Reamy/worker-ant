/**
 * zx_20260921_1 M3 —— ANS 四处 URL 落点的**行为探针**（`plans/improve/zx_20260921_1.md` §3 M3）。
 *
 * 为什么要单独一份、而不是并进 `scripts/rr_zx_20260921_1.ts`：那四个落点全在 ANS，而它们
 * **是否需要一张真库表 / 是否会 import 即启服**决定了自己能不能被驱动——
 *
 * | 落点 | 可达 | 本文件怎么探 |
 * | --- | --- | --- |
 * | `services/priorai-gateway.ts` | ✅ | **真驱动** `prioraiGateway.chat()`，捕获它真发出去的 URL |
 * | `routes/mcp-proxy.ts` | ✅ | **真驱动**：`mcpProxyRoutes(db)` + JSON-RPC `tools/call` 走**真路由** |
 * | `services/plugin-translator.ts` | ✅ | **真驱动** `PluginTranslator.translateLongText()`，注入取模型口 |
 * | `src/mcp-server.ts` | ❌ **潜伏** | **不 import**（它 import 即 `main()` 起服）——只按源码+可达性如实记 |
 *
 * ⚠ **不得把它记成"修了现网缺陷"**：`mcp-server.ts` 现状是「源码已归一处，但入口须手工启动」。
 * ⚠ 判据**不得自我印证**：每条都拿**生产那份**发出去的真实 URL 去比真源，而不是重述一遍源码怎么写的。
 *   另配**负对照**：改前那份算法（只认全路径）在这组输入上给出的 URL **必须不等**于实测 URL——
 *   否则"实测 === 真源"可能只是两套算法在这组输入上恰好同值，跟改没改无关。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChatCompletionsUrl } from '@worker-ant/ans-client';
import { prioraiGateway } from '../services/priorai-gateway.js';
import { PluginTranslator } from '../services/plugin-translator.js';
import { mcpProxyRoutes } from '../routes/mcp-proxy.js';
import { encryptApiKey } from '../utils/security.js';

/** 这三只 base 是**旧实现拼错、真源拼对**的形态（`/api/paas/v4`、`/v1beta`、`/api/v3`）。 */
const BASES = [
  'https://open.bigmodel.cn/api/paas/v4',
  'https://generativelanguage.googleapis.com/v1beta',
  'https://ark.cn-beijing.volces.com/api/v3',
];

/** 改前 ANS 四处那份拼接（**负对照标本**，不是生产实现）。 */
const OLD_B = (url: string): string =>
  url.endsWith('/v1/chat/completions') ? url : url.replace(/\/$/, '') + '/v1/chat/completions';

const realFetch = globalThis.fetch;
let seen: string[] = [];

function stubFetch(): void {
  seen = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(url);
    if (url.endsWith('/api/tags')) return new Response('', { status: 503 }); // 让 Tier 1（Ollama）让位
    return new Response(
      JSON.stringify({
        model: 'stub-model',
        choices: [{ message: { content: 'stub' } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;
}

function makeDb(url: string): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ans_ai_providers (id TEXT PRIMARY KEY, name TEXT, base_url TEXT, status TEXT DEFAULT 'active', enabled INTEGER DEFAULT 1);
    CREATE TABLE ans_ai_models (id TEXT PRIMARY KEY, provider_id TEXT, name TEXT, capabilities TEXT DEFAULT '[]', context_window INTEGER, max_output_tokens INTEGER, input_price_per_1k REAL, output_price_per_1k REAL, status TEXT DEFAULT 'active', enabled INTEGER DEFAULT 1);
    CREATE TABLE ans_model_endpoints (id TEXT PRIMARY KEY, model_id TEXT, url TEXT, api_key_ref TEXT, priority INTEGER DEFAULT 0, weight REAL DEFAULT 1.0, status TEXT DEFAULT 'active', last_latency_ms INTEGER DEFAULT 0);
  `);
  db.prepare("INSERT INTO ans_ai_providers VALUES ('p1', 'stub', 'https://stub.test', 'active', 1)").run();
  db.prepare(
    "INSERT INTO ans_ai_models VALUES ('m1', 'p1', 'stub-chat', '[\"chat\"]', 128000, 4096, 0, 0, 'active', 1)",
  ).run();
  db.prepare("INSERT INTO ans_model_endpoints VALUES ('e1', 'm1', ?, ?, 0, 1.0, 'active', 0)").run(
    url,
    encryptApiKey('sk-stub'),
  );
  return db;
}

beforeEach(() => stubFetch());
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe('M3 归一处真源：ANS 四处落点各自发出去的 URL', () => {
  it.each(BASES)('priorai-gateway 真驱动：%s', async (base) => {
    await prioraiGateway.chat({ primaryUrl: base, primaryKey: 'k', messages: [{ role: 'user', content: 'hi' }] });
    expect(seen).toEqual([resolveChatCompletionsUrl(base)]);
    expect(seen[0]).not.toBe(OLD_B(base)); // 负对照：改前那份会拼成别的
  });

  it.each(BASES)('plugin-translator 真驱动（Tier 2）：%s', async (base) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pt-'));
    const t = new PluginTranslator(dir, async () => ({
      url: base,
      api_key_ref: 'r',
      api_key: 'k',
      model_name: 'stub',
      max_output_tokens: 10,
      context_window: 10,
    }));
    const out = await t.translateLongText('hello');
    const chat = seen.filter((u) => !u.endsWith('/api/tags'));
    expect(chat).toEqual([resolveChatCompletionsUrl(base)]);
    expect(chat[0]).not.toBe(OLD_B(base));
    expect(out).toBe('stub');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.each(BASES)('mcp-proxy 真驱动（走真 JSON-RPC 路由）：%s', async (base) => {
    const db = makeDb(base);
    const app = mcpProxyRoutes(db);
    const res = await app.handle(
      new Request('http://localhost/mcp/message', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'ans_chat', arguments: { message: '你好' } },
        }),
      }),
    );
    const payload = (await res.json()) as { result?: unknown; error?: unknown };
    expect(payload.error).toBeUndefined();
    expect(seen).toEqual([resolveChatCompletionsUrl(base)]);
    expect(seen[0]).not.toBe(OLD_B(base));
    db.close();
  });
});

describe('M3 潜伏面：mcp-server.ts 如实记为"源码已归一、入口未接"', () => {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  it('从 index.ts 沿相对 import 走闭包 ⇒ 它当前**不可达**（真潜伏）', () => {
    const closure = new Set<string>();
    const walk = (abs: string): void => {
      if (closure.has(abs) || !fs.existsSync(abs)) return;
      closure.add(abs);
      for (const m of fs.readFileSync(abs, 'utf-8').matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
        const b = path.resolve(path.dirname(abs), m[1]!.replace(/\.js$/, ''));
        const cand = fs.existsSync(`${b}.ts`)
          ? `${b}.ts`
          : fs.existsSync(path.join(b, 'index.ts'))
            ? path.join(b, 'index.ts')
            : null;
        if (cand) walk(cand);
      }
    };
    walk(path.join(srcDir, 'index.ts'));

    expect(closure.size).toBeGreaterThan(0); // 扫描面自证
    expect(closure.has(path.join(srcDir, 'services/priorai-gateway.ts'))).toBe(true); // 同判定式**另一面**
    expect(closure.has(path.join(srcDir, 'mcp-server.ts'))).toBe(false); // ← 故"不可达"不是扫描器从不报
  });

  it('但它**确实已改调真源**（源码层面归一处），只是生效需手工启动该入口', () => {
    const text = fs.readFileSync(path.join(srcDir, 'mcp-server.ts'), 'utf-8');
    expect(text).toContain('resolveChatCompletionsUrl(matched.primary.url)');
    // 去注释后不得再有手写拼接（路径知识只剩一处）。
    expect(text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')).not.toContain('chat/completions');
  });
});
