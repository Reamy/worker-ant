/**
 * zx_20260930 M9 第二步：**ANS 侧真验签**——`x-signature` 从此真的参与校验。
 *
 * 病根（第一步已在桌面侧收口，见 `plans/improve/zx_20260930.md` §2.9-M9-1）：
 *   本仓 `utils/security.ts` 的 `hmacAuth` **只查 `x-api-key`、从不校验签名**——三个头都发齐了也照样过，
 *   于是 `x-signature` 是个装饰；更重的是 `getSecret` 把 DB 行的 `secret_hash`（sha256，不可逆）
 *   当作 HMAC 密钥返回 ⇒ 就算接上验签器，**拿哈希当密钥**也永远对不上。
 *
 * 本文件钉的是"接上之后**真的成立**"：
 *   ① **往返**：桌面侧 `ans-signed-request.ts` 的签名口径（`@worker-ant/ans-client` 的
 *      `createHmacSignature` 签 `` `${timestamp}\n${body}` ``）签出的头 + **原文** ⇒ 本仓真 `hmacAuth` 放行；
 *   ② **判别力**：退化成"拿 `secret_hash` 当密钥"、"验签前把体重新序列化一遍"、
 *      "把失败合成一个 401"这三条**都会让下面的反证标本转绿** ⇒ 它们是活的判别器，不是自我印证；
 *   ③ **分得开**：五种失败各自一句独立文案（缺头 / key 不认 / 过期 / secret 取不到明文 / 签名不符）——
 *      排查时是五件事，合成一个 401 就只能靠猜。
 *
 * ⚠ 为什么这一组落在 **ANS 的 vitest** 而不是 `scripts/rr_zx_20260930.ts`：本仓回归有一条约定的边界——
 *   **rr 不在运行时 import `apps/ans-server` 的源码**（`rr_zx_20260924.ts` §M6 的"分工如实"：
 *   `security.ts → pino + fs.mkdirSync(data/logs)`，一引就把 ANS 的导入副作用带进回归进程）。
 *   而"桌面签出的字节串 ↔ ANS 认不认"这条链**两半各自成立**：桌面那一半（生产签名器 ↔ 生产验签器）
 *   由 `rr_zx_20260930` 的 I-b 组在真桩上证；ANS 这一半（生产验签器 ↔ 真 `hmacAuth`）由本文件证，
 *   中间那一跳是同一个模块导出的 `createHmacSignature`/`verifyHmacSignature`，两侧都直引生产实现。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Elysia } from 'elysia';
import { hmacAuth, encryptApiKey } from '../utils/security.js';
import { authRoutes } from '../routes/auth.js';
import { createHmacSignature } from '@worker-ant/ans-client';

/** 与 `im-router` / `task-decompose` 实发到 `/api/v1/models/optimal` 的**同形入参**（不是为判据另造的）。 */
const OPTIMAL_BODY = { capabilities: ['chat'], strategy: 'cost-optimal' };
const POST_PATH = '/api/v1/models/optimal';
const GET_PATH = '/api/v1/skills';

const DEV_KEY = 'dev-key';
const DEV_SECRET = 'dev-secret';

/** 只按 `hmacAuth` 真正读到的列建表（`key_prefix`/`secret_hash`/`secret_enc`/`status`/`resource_groups`）。 */
const DDL = `
  CREATE TABLE ans_api_keys (
    id TEXT PRIMARY KEY,
    key_prefix TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    secret_enc TEXT DEFAULT '',
    name TEXT DEFAULT '',
    status TEXT DEFAULT 'active',
    resource_groups TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now'))
  );
`;

describe('M9-2 hmacAuth 真验签', () => {
  let db: Database.Database;
  let app: ReturnType<typeof hmacAuth> extends (a: infer A) => infer R ? R : never;
  const prevApiKeys = process.env.ANS_API_KEYS;

  beforeAll(() => {
    db = new Database(':memory:');
    db.exec(DDL);
    // env 路（`.env` 的开发态身份 = 当前运行中的桌面用的那一对）
    process.env.ANS_API_KEYS = `${DEV_KEY}:${DEV_SECRET}`;
    app = new Elysia()
      .use(hmacAuth(db))
      .post(POST_PATH, () => ({ ok: true }))
      .get(GET_PATH, () => ({ ok: true })) as never;
  });

  afterAll(() => {
    if (prevApiKeys === undefined) delete process.env.ANS_API_KEYS;
    else process.env.ANS_API_KEYS = prevApiKeys;
    db.close();
  });

  /**
   * 按桌面侧 `ansSignedHeaders` 的**同形**装三头（头名小写、签的是 `${timestamp}\n${bodyText}`）。
   * 签名那一跳调的是 `@worker-ant/ans-client` 的 `createHmacSignature`——桌面真源 `ans-signed-request.ts`
   * 引的就是它（rr_zx_20260929 的 B-44 已钉死这一点），故这里不是"等价自造物"。
   */
  type SignedHeaders = { 'x-api-key': string; 'x-timestamp': string; 'x-signature': string };
  const signed = (
    apiKey: string,
    secretKey: string,
    bodyText: string,
    timestampMs: number = Date.now(),
  ): SignedHeaders => {
    const timestamp = String(timestampMs);
    return {
      'x-api-key': apiKey,
      'x-timestamp': timestamp,
      'x-signature': createHmacSignature(secretKey, timestamp, bodyText),
    };
  };

  /** 投一个**真 `Request`**（原文逐字节送达；Elysia 的解析照常）。 */
  const call = async (
    headers: Record<string, string>,
    body?: string,
    method = 'POST',
  ): Promise<{ status: number; text: string }> => {
    const path = method === 'GET' ? GET_PATH : POST_PATH;
    const r = await app.handle(
      new Request(`http://localhost${path}`, {
        method,
        headers: { 'content-type': 'application/json', ...headers },
        ...(body === undefined ? {} : { body }),
      }),
    );
    return { status: r.status, text: await r.text() };
  };

  const hashOf = (s: string): string => createHash('sha256').update(s).digest('hex');

  it('路由在册：无头 ⇒ 401（不是 404）——以下每条的 200/401 都不是"路由不存在"', async () => {
    const r = await call({});
    expect(r.status).toBe(401);
    expect(r.text).not.toContain('NOT_FOUND');
  });

  it('★★★ 往返：桌面口径签出的三头 + 原文 ⇒ 200', async () => {
    const bodyText = JSON.stringify(OPTIMAL_BODY);
    const r = await call(signed(DEV_KEY, DEV_SECRET, bodyText), bodyText);
    expect(r.status).toBe(200);
    expect(r.text).toContain('"ok":true'); // 路由体真跑了 ⇒ 200 不是被别的东西短路
  });

  it('★ 时间窗/常量比较都在生产验签器口径内：过期 ⇒ 401 且文案是「过期」不是「签名不符」', async () => {
    const expiredAt = Date.now() - 600_000;
    const bodyText = JSON.stringify(OPTIMAL_BODY);
    const r = await call(signed(DEV_KEY, DEV_SECRET, bodyText, expiredAt), bodyText);
    expect(r.status).toBe(401);
    expect(r.text).toContain('Request timestamp expired');
    expect(r.text).not.toContain('Invalid signature');
  });

  it('★ 缺 x-signature（另两头齐备）⇒ 401 Missing authentication headers ——「漏一个头」的最小形状', async () => {
    const bodyText = JSON.stringify(OPTIMAL_BODY);
    // 取另两头（`signed` 的产物按同形入参取，不另造）——解构而非下标取值以避开 noUncheckedIndexedAccess。
    const { 'x-api-key': apiKeyHeader, 'x-timestamp': timestampHeader } = signed(DEV_KEY, DEV_SECRET, bodyText);
    const r = await call({ 'x-api-key': apiKeyHeader, 'x-timestamp': timestampHeader }, bodyText);
    expect(r.status).toBe(401);
    expect(r.text).toContain('Missing authentication headers');
  });

  it('未登记的 x-api-key ⇒ 401 Invalid API key（「钥匙不对」与「签名不对」分得开）', async () => {
    const bodyText = JSON.stringify(OPTIMAL_BODY);
    const r = await call(signed('nobody-known', DEV_SECRET, bodyText), bodyText);
    expect(r.status).toBe(401);
    expect(r.text).toContain('Invalid API key');
    expect(r.text).not.toContain('Invalid signature');
  });

  it('★ 篡改一个字节 ⇒ 401 Invalid signature（与往返那一对只差体中一字节）', async () => {
    const bodyText = JSON.stringify(OPTIMAL_BODY);
    const r = await call(signed(DEV_KEY, DEV_SECRET, bodyText), `${bodyText} `);
    expect(r.status).toBe(401);
    expect(r.text).toContain('Invalid signature');
  });

  it('★★ 字节精确：签「重新序列化后的串」而发原文 ⇒ 401；同一份原文签原文 ⇒ 200', async () => {
    // 体里带空白，故 `JSON.stringify(JSON.parse(raw))` 与 `raw` 是**两条不同的串**。
    // 「验签前把体重新序列化一遍」的写法在这一条上必然转红——这正是本判据要咬的那条路。
    const raw = '{"a": 1, "b": 2}';
    const renormalized = JSON.stringify(JSON.parse(raw));
    expect(renormalized).not.toBe(raw); // 自证：两条串确实不同（否则本判据是空转）
    const bad = await call(signed(DEV_KEY, DEV_SECRET, renormalized), raw);
    expect(bad.status).toBe(401);
    const good = await call(signed(DEV_KEY, DEV_SECRET, raw), raw);
    expect([good.status, good.text]).toEqual([200, '{"ok":true}']);
  });

  describe('DB 路（`secret_enc` 密文列）', () => {
    const PREFIX = 'dbpath01';
    const SECRET = 'db-path-secret';

    beforeAll(() => {
      db.prepare(
        'INSERT INTO ans_api_keys (id, key_prefix, secret_hash, secret_enc, name, resource_groups) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('k-db', PREFIX, hashOf(SECRET), encryptApiKey(SECRET), 'db-path', '[]');
    });

    it('★★ 明文（`decryptApiKey` 解出来那一把）⇒ 200 —— 新增列 + 解密路真跑通', async () => {
      const bodyText = JSON.stringify(OPTIMAL_BODY);
      const r = await call(signed(PREFIX, SECRET, bodyText), bodyText);
      expect(r.status).toBe(200);
    });

    it('★★★ 反证：拿 `secret_hash`（sha256）当密钥 ⇒ 401 —— 旧实现恒为真，故这条是活的判别器', async () => {
      const bodyText = JSON.stringify(OPTIMAL_BODY);
      const r = await call(signed(PREFIX, hashOf(SECRET), bodyText), bodyText);
      expect(r.status).toBe(401);
      expect(r.text).toContain('Invalid signature');
    });
  });

  describe('旧行（只有 secret_hash、secret_enc 为空）', () => {
    const PREFIX = 'legacy01';

    beforeAll(() => {
      db.prepare(
        'INSERT INTO ans_api_keys (id, key_prefix, secret_hash, secret_enc, name, resource_groups) VALUES (?, ?, ?, ?, ?, ?)',
      ).run('k-legacy', PREFIX, hashOf('legacy-secret'), '', 'legacy', '[]');
    });

    it('★ 如实拒绝 ⇒ 401 且文案是「secret 取不到明文」——服务端自己的账，与「调用方签错了」分开', async () => {
      // sha256 不可逆 ⇒ 旧行**取不到明文**，HMAC 参与不了。这条不许化归成 'Invalid signature'：
      // 那会把"本仓该补一次密文回填"读成"调用方签名错了"。
      const bodyText = JSON.stringify(OPTIMAL_BODY);
      const r = await call(signed(PREFIX, 'legacy-secret', bodyText), bodyText);
      expect(r.status).toBe(401);
      expect(r.text).toContain('API key secret unavailable for signature verification');
      expect(r.text).not.toContain('Invalid signature');
    });
  });

  describe('无体的 GET', () => {
    it('★★ 签空串 ⇒ 200 —— 与 `AnsClient.requestWithRetry` 无体时的口径逐字相同', async () => {
      const headers = signed(DEV_KEY, DEV_SECRET, '');
      const r = await call(headers, undefined, 'GET');
      expect([r.status, r.text]).toEqual([200, '{"ok":true}']);
    });

    it('★ 反证：无体却签 `undefined` 那一串（`JSON.stringify(undefined)` 的写法）⇒ 401', async () => {
      const headers = signed(DEV_KEY, DEV_SECRET, 'undefined');
      const r = await call(headers, undefined, 'GET');
      expect(r.status).toBe(401);
      expect(r.text).toContain('Invalid signature');
    });
  });
});

/**
 * zx_20260930 M15-②：**API Key 管理并入 HMAC 组**——「钥匙的钥匙」不再挂在公开路由上。
 *
 * 病根：`index.ts` 里 `authRoutes(db)` 原属「公开路由（无需HMAC认证）」组，而那句注释写着
 *   「（自包含认证）」——**代码里零认证**。于是未签名的 `GET /api/v1/auth/api-keys` 会**列出全部钥匙**
 *   （前缀/名字/资源组），`POST` 更能**签发新钥匙**；`hmacAuth` 不做路径白名单（`utils/security.ts:82`
 *   起是一个 `derive` 钩子），故"并入组内"=四个方法一并被挡，不需要另加一条规则。
 *
 * 两条腿（缺一即假绿）：
 *   ① **接线**：`index.ts` 里 `authRoutes(db)` 处在 `hmacManagement` 段内、顶层 `app` 段内不含它——
 *      若只在测试里自己 `new Elysia().use(hmacAuth).use(authRoutes)`，**index.ts 回退成公开也照样全绿**
 *      （"等价性证不了接上了"：判据须钉生产那一跳，故按**语句形状**切段，不按子串）。
 *   ② **真跑**：真 `hmacAuth(db)` + 真 `authRoutes(db)` 组起来，四个方法未签名 ⇒ 401；已签名 GET ⇒ 200 且
 *      真读到库里那一行（证路由体跑了，不是被什么短路成 200）。
 *
 * ⚠ 本仓已有「mcp-proxy body 校验未生效」一条既存事实（TypeBox Union 需 TypeCompiler）——与本组无关，
 *   本组只碰 `hmacAuth` 的 `derive` 与 `authRoutes` 的四条路由，不碰 Union 校验。
 */
describe('M15-② API Key 管理并入 HMAC 组', () => {
  let db: Database.Database;
  let guarded: { handle(r: Request): Response | Promise<Response> };
  const prevApiKeys = process.env.ANS_API_KEYS;

  const AUTH02_PREFIX = 'auth02kk';
  const AUTH02_SECRET = 'auth02-secret';

  /** 与上面 M9-2 组同口径的装头（同一份生产签名器；此处不复用其局部 `signed`，两组各自独立）。 */
  const signHeaders = (apiKey: string, secretKey: string, bodyText: string): Record<string, string> => {
    const timestamp = String(Date.now());
    return {
      'x-api-key': apiKey,
      'x-timestamp': timestamp,
      'x-signature': createHmacSignature(secretKey, timestamp, bodyText),
    };
  };

  beforeAll(() => {
    db = new Database(':memory:');
    db.exec(DDL);
    process.env.ANS_API_KEYS = `${DEV_KEY}:${DEV_SECRET}`;
    // 只插**一行**自有标本：用来证"签了名的 GET 真读到了库"（不借 M9-2 那两支的行，避免顺序耦合）。
    db.prepare(
      'INSERT INTO ans_api_keys (id, key_prefix, secret_hash, secret_enc, name, resource_groups) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(
      'k-auth02',
      AUTH02_PREFIX,
      createHash('sha256').update(AUTH02_SECRET).digest('hex'),
      encryptApiKey(AUTH02_SECRET),
      'auth02',
      '["g1"]',
    );
    guarded = new Elysia().use(hmacAuth(db)).use(authRoutes(db)) as unknown as {
      handle(r: Request): Response | Promise<Response>;
    };
  });

  afterAll(() => {
    if (prevApiKeys === undefined) delete process.env.ANS_API_KEYS;
    else process.env.ANS_API_KEYS = prevApiKeys;
    db.close();
  });

  it('① 接线：`authRoutes(db)` 在 `hmacManagement` 段内、不在顶层 `app` 段内（按语句形状切，非子串）', () => {
    const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../index.ts'), 'utf-8');
    const startManagement = src.indexOf('const hmacManagement = new Elysia()');
    const startApp = src.indexOf('const app = new Elysia(');
    // 锚点自证：锚点改名会让 indexOf 返回 -1 ⇒ 下面两段变空、后两条断言会"空转通过"。故在此判死。
    expect(startManagement).toBeGreaterThanOrEqual(0);
    expect(startApp).toBeGreaterThan(startManagement);
    const managementSeg = src.slice(startManagement, startApp);
    const appSeg = src.slice(startApp);
    // 切对了段（非空、且确实是那一组），否则"不含 authRoutes"可能只是因为切到了别处
    expect(managementSeg).toContain('modelsRoutes(db)');
    expect(appSeg).toContain('.use(hmacManagement)'); // 接线那一跳：hmacManagement 真挂到了顶层 app 上
    expect(managementSeg).toContain('authRoutes(db)');
    expect(appSeg).not.toContain('authRoutes(');
  });

  it('② 真跑：四个方法未签名 ⇒ 401「Missing authentication headers」（GET 此前会列出全部钥匙）', async () => {
    const cases: Array<[string, string, string | undefined]> = [
      ['GET', '/api/v1/auth/api-keys', undefined],
      ['POST', '/api/v1/auth/api-keys', JSON.stringify({ name: 'x' })],
      ['PUT', `/api/v1/auth/api-keys/${AUTH02_PREFIX}`, JSON.stringify({ resource_groups: ['a'] })],
      ['DELETE', `/api/v1/auth/api-keys/${AUTH02_PREFIX}`, undefined],
    ];
    for (const [method, path, body] of cases) {
      const r = await guarded.handle(
        new Request(`http://localhost${path}`, {
          method,
          headers: { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body }),
        }),
      );
      // 401 而非 404：路由**在册**（这条同时排除"路径写错了所以被挡"的假绿）
      expect([method, r.status]).toEqual([method, 401]);
      expect(await r.text()).toContain('Missing authentication headers');
    }
  });

  it('② 真跑：已签名 GET ⇒ 200，且真读到库里的那一行（`resource_groups` 已从 JSON 串解出 ⇒ 路由体真跑过）', async () => {
    const headers = signHeaders(DEV_KEY, DEV_SECRET, ''); // 无体 GET 签空串（与 `AnsClient.requestWithRetry` 同口径）
    const r = await guarded.handle(
      new Request('http://localhost/api/v1/auth/api-keys', {
        method: 'GET',
        headers: { 'content-type': 'application/json', ...headers },
      }),
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { data: Array<{ key_prefix: string; resource_groups: unknown }> };
    const row = body.data.find((k) => k.key_prefix === AUTH02_PREFIX);
    expect(row).toBeDefined();
    expect(row?.resource_groups).toEqual(['g1']); // `safeParse` 那一跳真跑了
  });
});
