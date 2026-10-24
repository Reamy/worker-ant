
/**
 * @layer infrastructure — 基础设施层 — 技术实现细节：SQLite、ANS Gateway、文件系统、MCP进程管理
 */
import { SignJWT, jwtVerify } from 'jose';
import { randomBytes, randomUUID as cryptoRandomUUID } from 'node:crypto';
import bcrypt from 'bcrypt';
import type Database from 'better-sqlite3';
import { resolveLicenseTier } from './license.js';
import { assertSeatAvailable } from './seat-quota.js';
import { localOwnerState } from './local-owner.js';

const BCRYPT_ROUNDS = 12;

const ACCESS_EXPIRES = '8h';
const REFRESH_EXPIRES = '7d';

// JWT密钥延迟初始化：ESM导入时loadEnvFile尚未执行，
// 模块级直接读取process.env.WA_JWT_SECRET会拿到undefined→每次重启换密钥→前端需重新登录
let _jwtSecret: Uint8Array | null = null;
function getJwtSecret(): Uint8Array {
  if (!_jwtSecret) {
    const key = process.env.WA_JWT_SECRET || randomBytes(32).toString('hex');
    _jwtSecret = new TextEncoder().encode(key);
  }
  return _jwtSecret;
}

export interface TokenPayload {
  sub: string;
  email: string;
  role: string;
}

export async function signAccessToken(payload: TokenPayload): Promise<string> {
  return new SignJWT({ ...payload })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(ACCESS_EXPIRES)
    .sign(getJwtSecret());
}

export async function signRefreshToken(userId: string): Promise<string> {
  const token = await new SignJWT({ sub: userId, type: 'refresh' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(REFRESH_EXPIRES)
    .sign(getJwtSecret());
  // 存储refresh token到数据库
  return token;
}

export async function verifyToken(token: string): Promise<TokenPayload> {
  const { payload } = await jwtVerify(token, getJwtSecret());
  return payload as unknown as TokenPayload;
}

async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_ROUNDS);
}

async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

export class AuthService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  /** 注册用户（邮箱+密码模式） */
  async register(email: string, password: string, name: string): Promise<{ user: Record<string, unknown>; accessToken: string; refreshToken: string }> {
    const existing = this.db.prepare('SELECT id FROM wa_users WHERE email = ?').get(email);
    if (existing) throw new Error('Email already registered');
    // zx_20261017_1 批五: 新增席位前过闸（自助注册与邀请/管理员创建同一条上限）。
    assertSeatAvailable(this.db, resolveLicenseTier(this.db));

    const id = randomUUID();
    const hash = await hashPassword(password);
    this.db.prepare(
      "INSERT INTO wa_users (id, email, name, role) VALUES (?, ?, ?, 'developer')",
    ).run(id, email, name);

    this.db.prepare('INSERT INTO wa_user_credentials (user_id, password_hash) VALUES (?, ?)').run(id, hash);

    this.ensureCredentialsTable();

    const accessToken = await signAccessToken({ sub: id, email, role: 'developer' });
    const refreshToken = await signRefreshToken(id);

    return {
      user: { id, email, name, role: 'developer' },
      accessToken,
      refreshToken,
    };
  }

  /** 邮箱+密码登录 */
  async login(email: string, password: string): Promise<{ user: Record<string, unknown>; accessToken: string; refreshToken: string } | null> {
    const user = this.db.prepare('SELECT * FROM wa_users WHERE email = ?').get(email) as Record<string, unknown> | undefined;
    if (!user) return null;

    const cred = this.db.prepare('SELECT password_hash FROM wa_user_credentials WHERE user_id = ?').get(user.id) as { password_hash: string } | undefined;
    if (!cred) return null;

    // A6: 兼容旧的SHA-256格式(salt:hash)和新的bcrypt格式($2b$...)
    const isBcrypt = cred.password_hash.startsWith('$2');
    if (isBcrypt) {
      if (!(await verifyPassword(password, cred.password_hash))) return null;
    } else {
      // 旧格式回退：sha256(salt+password)，登录成功后自动升级为bcrypt
      const [salt, storedHash] = cred.password_hash.split(':');
      if (!salt || !storedHash) return null;
      const { createHash } = await import('node:crypto');
      if (createHash('sha256').update(salt + password).digest('hex') !== storedHash) return null;
      // 自动升级为bcrypt
      const newHash = await hashPassword(password);
      this.db.prepare('UPDATE wa_user_credentials SET password_hash = ? WHERE user_id = ?').run(newHash, user.id);
    }

    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      accessToken: await signAccessToken({ sub: user.id as string, email: user.email as string, role: user.role as string }),
      refreshToken: await signRefreshToken(user.id as string),
    };
  }

  /**
   * 本机所有者首启自动登录（zx_20261023_4）。
   * 判据在 `local-owner.ts`：**不是**「渲染层说自己是主人」，而是库里仍只有未改密的种子管理员。
   * 不成立返回 `null`（调用方如实落到登录页），绝不降级放行。
   */
  async ensureLocalOwnerSession(): Promise<{ user: Record<string, unknown>; accessToken: string; refreshToken: string } | null> {
    const state = localOwnerState(this.db);
    if (state.kind !== 'untouched_seed_owner') return null;

    const user = this.db.prepare('SELECT id, email, name, role FROM wa_users WHERE id = ?').get(state.userId) as
      | Record<string, unknown>
      | undefined;
    if (!user?.id) return null;

    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      accessToken: await signAccessToken({ sub: user.id as string, email: user.email as string, role: user.role as string }),
      refreshToken: await signRefreshToken(user.id as string),
    };
  }

  /**
   * 首次使用时为本机所有者设置自己的密码（免旧密码）。
   * 只在判据成立时可用；写入即 bcrypt ⇒ 自动登录随之永久失效（判据第 3 条不再成立）。
   */
  async setLocalOwnerPassword(newPassword: string): Promise<{ success: boolean; error?: string }> {
    const state = localOwnerState(this.db);
    if (state.kind !== 'untouched_seed_owner') {
      return { success: false, error: '仅首次使用（默认管理员尚未改密）时可直接设置密码' };
    }
    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      return { success: false, error: '密码至少 6 位' };
    }
    const newHash = await hashPassword(newPassword);
    this.db.prepare('UPDATE wa_user_credentials SET password_hash = ? WHERE user_id = ?').run(newHash, state.userId);
    return { success: true };
  }

  /** 通过OAuth profile创建或查找用户 */
  async findOrCreateOAuth(profile: { email: string; name: string; provider: string; providerAccountId: string }): Promise<{ user: Record<string, unknown>; accessToken: string; refreshToken: string }> {
    let user = this.db.prepare(
      'SELECT u.* FROM wa_users u JOIN wa_oauth_accounts oa ON u.id = oa.user_id WHERE oa.provider = ? AND oa.provider_account_id = ?',
    ).get(profile.provider, profile.providerAccountId) as Record<string, unknown> | undefined;

    if (!user) {
      user = this.db.prepare('SELECT * FROM wa_users WHERE email = ?').get(profile.email) as Record<string, unknown> | undefined;
      if (user) {
        this.db.prepare('INSERT INTO wa_oauth_accounts (user_id, provider, provider_account_id) VALUES (?, ?, ?)').run(user.id, profile.provider, profile.providerAccountId);
      } else {
        // zx_20261017_1 批五: **只拦新建**——既有账号（上面两跳命中的）照常登录，不因满员被挡。
        assertSeatAvailable(this.db, resolveLicenseTier(this.db));
        const id = randomUUID();
        this.db.prepare('INSERT INTO wa_users (id, email, name, role) VALUES (?, ?, ?, ?)').run(id, profile.email, profile.name, 'developer');
        this.db.prepare('INSERT INTO wa_oauth_accounts (user_id, provider, provider_account_id) VALUES (?, ?, ?)').run(id, profile.provider, profile.providerAccountId);
        user = { id, email: profile.email, name: profile.name, role: 'developer' };
      }
    }

    return {
      user: { id: user.id, email: user.email, name: user.name, role: user.role },
      accessToken: await signAccessToken({ sub: user.id as string, email: user.email as string, role: user.role as string }),
      refreshToken: await signRefreshToken(user.id as string),
    };
  }

  /** 刷新 access token */
  async refresh(refreshToken: string): Promise<{ accessToken: string; refreshToken: string } | null> {
    try {
      const { payload } = await jwtVerify(refreshToken, getJwtSecret());
      if (payload.type !== 'refresh') return null;
      const userId = payload.sub as string;
      const user = this.db.prepare('SELECT id, email, role FROM wa_users WHERE id = ?').get(userId) as { id: string; email: string; role: string } | undefined;
      if (!user) return null;
      return {
        accessToken: await signAccessToken({ sub: user.id, email: user.email, role: user.role }),
        refreshToken: await signRefreshToken(user.id),
      };
    } catch {
      return null;
    }
  }

  private ensureCredentialsTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wa_user_credentials (
        user_id TEXT PRIMARY KEY REFERENCES wa_users(id),
        password_hash TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS wa_oauth_accounts (
        user_id TEXT REFERENCES wa_users(id),
        provider TEXT NOT NULL,
        provider_account_id TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (provider, provider_account_id)
      );
    `);
  }

  /** 管理员直接创建用户 */
  async createUser(email: string, password: string, name: string, role: string): Promise<{ id: string }> {
    const existing = this.db.prepare('SELECT id FROM wa_users WHERE email = ?').get(email);
    if (existing) throw new Error('Email already registered');
    // zx_20261017_1 批五: 管理员创建 / 接受邀请都走这里——席位闸放在插入之前（异步 bcrypt 之前，
    //   免得白白算一轮哈希才被拒）。
    assertSeatAvailable(this.db, resolveLicenseTier(this.db));

    const id = randomUUID();
    const hash = await hashPassword(password);
    this.db.prepare(
      'INSERT INTO wa_users (id, email, name, role) VALUES (?, ?, ?, ?)',
    ).run(id, email, name, role);

    this.ensureCredentialsTable();
    this.db.prepare('INSERT INTO wa_user_credentials (user_id, password_hash) VALUES (?, ?)').run(id, hash);

    return { id };
  }

  /** 修改密码（需验证旧密码） */
  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
    const cred = this.db.prepare('SELECT password_hash FROM wa_user_credentials WHERE user_id = ?').get(userId) as { password_hash: string } | undefined;
    if (!cred) return { success: false, error: '账号未设置密码（可能为OAuth登录）' };

    // 验证旧密码
    const isBcrypt = cred.password_hash.startsWith('$2');
    let oldValid = false;
    if (isBcrypt) {
      oldValid = await verifyPassword(oldPassword, cred.password_hash);
    } else {
      const [salt, storedHash] = cred.password_hash.split(':');
      if (salt && storedHash) {
        const { createHash } = await import('node:crypto');
        oldValid = createHash('sha256').update(salt + oldPassword).digest('hex') === storedHash;
      }
    }
    if (!oldValid) return { success: false, error: '旧密码不正确' };

    // 更新为新密码（统一用bcrypt）
    const newHash = await hashPassword(newPassword);
    this.db.prepare('UPDATE wa_user_credentials SET password_hash = ? WHERE user_id = ?').run(newHash, userId);
    return { success: true };
  }

  /** 管理员重置用户密码（绕过旧密码验证） */
  async resetPassword(userId: string, newPassword: string): Promise<{ success: boolean; error?: string }> {
    const user = this.db.prepare('SELECT id FROM wa_users WHERE id = ?').get(userId) as { id: string } | undefined;
    if (!user) return { success: false, error: '用户不存在' };
    const newHash = await hashPassword(newPassword);
    this.ensureCredentialsTable();
    this.db.prepare('INSERT OR REPLACE INTO wa_user_credentials (user_id, password_hash) VALUES (?, ?)').run(userId, newHash);
    return { success: true };
  }
}

function randomUUID(): string {
  return cryptoRandomUUID();
}
