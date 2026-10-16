import type Database from 'better-sqlite3';
import { randomBytes, createCipheriv, createDecipheriv, createHash, createHmac } from 'node:crypto';
import { verifyHmacSignature, generateApiKey } from '@worker-ant/ans-client';
import type { Elysia } from 'elysia';
import { AppError, ErrorCode, formatErrorResponse } from './errors.js';
import { createLogger } from './logger.js';

const logger = createLogger('ans-security');

const AES_ALGORITHM = 'aes-256-gcm';

/**
 * 从环境变量获取或生成加密密钥。生产环境必须从环境变量注入。
 */
export function getEncryptionKey(): Buffer {
  const envKey = process.env.ANS_ENCRYPTION_KEY;
  if (envKey) {
    // 验证：32字节hex = 64字符，仅含0-9a-f
    if (!/^[0-9a-fA-F]{64}$/.test(envKey)) {
      throw new Error(
        `ANS_ENCRYPTION_KEY 格式无效：需要64位hex字符串(32字节)，当前长度${envKey.length}。请运行: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
      );
    }
    return Buffer.from(envKey, 'hex');
  }
  // 开发环境自动生成（重启后已有加密数据将无法解密）
  logger.warn('未设置 ANS_ENCRYPTION_KEY，使用随机密钥（重启后加密数据将失效）');
  return randomBytes(32);
}

let _encKey: Buffer | null = null;

function encKey(): Buffer {
  if (!_encKey) _encKey = getEncryptionKey();
  return _encKey;
}

/**
 * 加密API Key用于存储。
 */
export function encryptApiKey(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(AES_ALGORITHM, encKey(), iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, tag, encrypted]);
  return combined.toString('base64');
}

/**
 * 解密存储的API Key。
 */
export function decryptApiKey(encoded: string): string {
  const combined = Buffer.from(encoded, 'base64');
  const iv = combined.subarray(0, 12);
  const tag = combined.subarray(12, 28);
  const encrypted = combined.subarray(28);
  const decipher = createDecipheriv(AES_ALGORITHM, encKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

/**
 * zx_20260930 M9：请求体**原文**的进程内留存。
 *
 * 签名签的是 `${timestamp}\n${body}` 里的那个 `body` **字节串**，故校验必须拿**收到的原文**
 * 比对——用 Elysia 解析后的对象再 `JSON.stringify` 一遍是**另一条串**（键序/空白都可能不同），
 * 那就成了"两侧各自序列化后碰巧相等"的运气。
 *
 * 为什么不在 `derive` 里读：实测 `derive` 时 Elysia 已消费过请求流，`request.clone().text()`
 *   抛 `Response body object should not be disturbed or locked`。`onRequest` 是最早的钩子，
 *   此刻 clone 出的流可读，且**只读副本**不动原流（Elysia 的解析照常）。
 * 为什么用 WeakMap 而不是往 `store` 里塞：键就是 `Request` 对象本身，请求结束即随对象回收，
 *   不需要任何清理，也不会跨请求串。
 */
const RAW_BODY = new WeakMap<object, string>();

/**
 * Elysia插件：验证HMAC签名。从X-Api-Key查secret，校验X-Timestamp和X-Signature。
 *
 * zx_20260930 M9：此前本插件**只查 key、从不校验 signature**——三个头都发齐了也照样过，
 *   也就是说 `x-signature` 之前是个装饰。现在接上 `verifyHmacSignature`（常量时间比较 + 5 分钟窗）。
 */
export function hmacAuth(db: Database.Database) {
  /**
   * 从配置表或环境变量取该 API Key 的 secret。
   *
   * 返回两样东西，**各有所用**：
   *  - `contextSecret`：放进 derive 上下文的那一个（沿用旧行为：DB 给 `secret_hash`、env 给明文）；
   *  - `plaintext`：**参与 HMAC 的那一个**。DB 行只有 `secret_enc` 才能解出明文；
   *    只有 `secret_hash` 的旧行**取不到明文**（sha256 不可逆）⇒ 为 `null`，如实拒绝。
   */
  const getSecrets = (apiKey: string): { contextSecret: string; plaintext: string | null } | null => {
    // 先查数据库（8.1：支持resource_groups）
    try {
      const row = db
        .prepare("SELECT secret_hash, secret_enc FROM ans_api_keys WHERE key_prefix = ? AND status = 'active'")
        .get(apiKey.slice(0, 8)) as { secret_hash: string; secret_enc?: string } | undefined;
      if (row?.secret_hash) {
        let plaintext: string | null = null;
        if (row.secret_enc) {
          try {
            plaintext = decryptApiKey(row.secret_enc);
          } catch (err) {
            // 解不开 = 换了 ANS_ENCRYPTION_KEY（开发态随机键重启即此形）或数据损坏。
            //   **不静默**：否则调用方只看到 401、无从分辨"key 错"与"解不开"。
            logger.warn(
              { err: (err as Error).message, prefix: apiKey.slice(0, 8) },
              'API Key 的 secret_enc 解密失败（该 Key 无法通过 HMAC 校验）',
            );
          }
        } else {
          logger.warn(
            { prefix: apiKey.slice(0, 8) },
            'API Key 只有 secret_hash 而无 secret_enc（旧行）——无法参与 HMAC 校验',
          );
        }
        return { contextSecret: row.secret_hash, plaintext };
      }
    } catch {
      /* table/column might not exist yet */
    }
    // 回退环境变量
    const apiKeyEnv = process.env.ANS_API_KEYS;
    if (apiKeyEnv) {
      const pairs = apiKeyEnv.split(',');
      for (const pair of pairs) {
        const [k, s] = pair.split(':');
        if (k === apiKey && s) return { contextSecret: s, plaintext: s };
      }
    }
    return null;
  };

  return (app: Elysia) =>
    app
      .onRequest(async ({ request }) => {
        try {
          RAW_BODY.set(request as unknown as object, await request.clone().text());
        } catch (err) {
          logger.warn({ err: (err as Error).message }, '读取请求体原文失败（该请求将无法通过签名校验）');
        }
      })
      .derive(async ({ request }) => {
        const apiKey = request.headers.get('x-api-key');
        const timestamp = request.headers.get('x-timestamp');
        const signature = request.headers.get('x-signature');

        if (!apiKey || !timestamp || !signature) {
          throw new AppError(ErrorCode.UNAUTHORIZED, 'Missing authentication headers', 401);
        }

        const secrets = getSecrets(apiKey);
        if (!secrets) {
          throw new AppError(ErrorCode.UNAUTHORIZED, 'Invalid API key', 401);
        }

        // 时间窗先单独判一次：与 `verifyHmacSignature` 内部重复，但要的是**分得开的错误文案**
        //   （"过期"与"签名不符"在排查时是两件事；合成一个 401 就只能靠猜）。
        const ts = Number(timestamp);
        if (isNaN(ts) || Math.abs(Date.now() - ts) > 300_000) {
          throw new AppError(ErrorCode.UNAUTHORIZED, 'Request timestamp expired', 401);
        }

        // ★真验签：签的是 `${timestamp}\n${body原文}`。取不到原文 ⇒ **拒绝**（不放过）。
        const rawBody = RAW_BODY.get(request as unknown as object);
        if (rawBody === undefined) {
          throw new AppError(ErrorCode.UNAUTHORIZED, 'Unable to read request body for signature verification', 401);
        }
        if (!secrets.plaintext) {
          // 与"签名不符"**分开**告知：这一条是服务端自己的账（Key 行没有可用的明文 secret），
          //   不是调用方签错了。合成一个 401 就只能靠猜。此前 `getSecret` 直接把 `secret_hash`
          //   当 secret 返回，正是"拿哈希当密钥"这一步让签名永远不可能对上。
          throw new AppError(ErrorCode.UNAUTHORIZED, 'API key secret unavailable for signature verification', 401);
        }
        if (!verifyHmacSignature(secrets.plaintext, timestamp, rawBody, signature)) {
          logger.warn({ prefix: apiKey.slice(0, 8), path: new URL(request.url).pathname }, 'HMAC 签名校验未通过');
          throw new AppError(ErrorCode.UNAUTHORIZED, 'Invalid signature', 401);
        }

        // 8.1: 提取该API Key的资源组（用于资源隔离过滤）
        let resourceGroups: string[] = [];
        try {
          const row = db
            .prepare("SELECT resource_groups FROM ans_api_keys WHERE key_prefix = ? AND status = 'active'")
            .get(apiKey.slice(0, 8)) as { resource_groups: string } | undefined;
          if (row?.resource_groups) {
            try {
              resourceGroups = JSON.parse(row.resource_groups);
            } catch {
              /* ignore */
            }
          }
        } catch {
          /* table might not have resource_groups yet */
        }

        return { apiKey, apiSecret: secrets.contextSecret, resourceGroups };
      });
}

/**
 * 管理API Key（供工蚁后端调用ANS服务端时使用）。
 * 生成并存储API Key + Secret对。
 */
export class ApiKeyManager {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    // 确保表存在
    db.exec(`
      CREATE TABLE IF NOT EXISTS ans_api_keys (
        id TEXT PRIMARY KEY,
        key_prefix TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        secret_enc TEXT DEFAULT '',
        name TEXT DEFAULT '',
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
  }

  /** 创建API Key对，返回完整key和secret（secret仅返回一次）。8.1: 支持resource_groups */
  createApiKey(name: string, resourceGroups: string[] = []): { apiKey: string; secret: string } {
    const apiKey = generateApiKey('wa');
    const secret = randomBytes(32).toString('hex');
    this.db
      .prepare(
        'INSERT INTO ans_api_keys (id, key_prefix, secret_hash, secret_enc, name, resource_groups) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        crypto.randomUUID(),
        apiKey.slice(0, 8),
        this.hashSecret(secret),
        encryptApiKey(secret),
        name,
        JSON.stringify(resourceGroups),
      );
    return { apiKey, secret };
  }

  /** 验证API Key对应的Secret */
  verifySecret(apiKey: string, secret: string): boolean {
    const row = this.db
      .prepare('SELECT secret_hash FROM ans_api_keys WHERE key_prefix = ? AND status = ?')
      .get(apiKey.slice(0, 8), 'active') as { secret_hash: string } | undefined;
    if (!row) return false;
    return row.secret_hash === this.hashSecret(secret);
  }

  revokeApiKey(prefix: string): void {
    this.db.prepare('UPDATE ans_api_keys SET status = ? WHERE key_prefix = ?').run('revoked', prefix);
  }

  /** 8.1: 更新API Key的资源组绑定 */
  updateResourceGroups(prefix: string, resourceGroups: string[]): void {
    this.db
      .prepare('UPDATE ans_api_keys SET resource_groups = ? WHERE key_prefix = ?')
      .run(JSON.stringify(resourceGroups), prefix);
  }

  listApiKeys(): Array<{
    id: string;
    key_prefix: string;
    name: string;
    status: string;
    resource_groups: string;
    created_at: string;
  }> {
    return this.db
      .prepare(
        'SELECT id, key_prefix, name, status, resource_groups, created_at FROM ans_api_keys ORDER BY created_at DESC',
      )
      .all() as Array<{
      id: string;
      key_prefix: string;
      name: string;
      status: string;
      resource_groups: string;
      created_at: string;
    }>;
  }

  private hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }
}

/**
 * 8.1: 从HTTP请求中提取API Key对应的资源组（公共辅助函数）。
 */
export function getResourceGroupsFromApiKey(db: Database.Database, request: Request): string[] {
  try {
    const apiKey = request.headers.get('x-api-key');
    if (!apiKey) return [];
    const row = db
      .prepare("SELECT resource_groups FROM ans_api_keys WHERE key_prefix = ? AND status = 'active'")
      .get(apiKey.slice(0, 8)) as { resource_groups: string } | undefined;
    if (row?.resource_groups) {
      try {
        return JSON.parse(row.resource_groups);
      } catch {
        return [];
      }
    }
  } catch {
    /* table might not exist yet */
  }
  return [];
}
