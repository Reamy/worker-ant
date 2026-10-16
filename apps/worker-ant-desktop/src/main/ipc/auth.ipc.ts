import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { AuthService } from '../core/auth.js';
import crypto from 'node:crypto';

let authService: AuthService | null = null;

export function initAuthIpc(db: Database.Database): void {
  authService = new AuthService(db);

  // 邮箱登录
  ipcMain.handle('auth:login', async (_event, { email, password }: { email: string; password: string }) => {
    try {
      const result = await authService!.login(email, password);
      if (!result) {
        return { error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' } };
      }
      return { data: result };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // 邮箱注册
  ipcMain.handle('auth:register', async (_event, { email, password, name }: { email: string; password: string; name: string }) => {
    try {
      const result = await authService!.register(email, password, name);
      return { data: result };
    } catch (err) {
      const msg = (err as Error).message;
      return { error: { code: msg.includes('already') ? 'CONFLICT' : 'INTERNAL', message: msg } };
    }
  });

  // 获取当前用户
  ipcMain.handle('auth:me', async () => {
    return { error: { code: 'NOT_IMPLEMENTED', message: 'Use token from auth:login' } };
  });

  // 刷新 token
  ipcMain.handle('auth:refresh', async (_event, { refreshToken }: { refreshToken: string }) => {
    try {
      const result = await authService!.refresh(refreshToken);
      if (!result) {
        return { error: { code: 'UNAUTHORIZED', message: 'Invalid or expired refresh token' } };
      }
      return { data: result };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // 修改角色
  ipcMain.handle('auth:changeRole', async (_event, { userId, role }: { userId: string; role: string }) => {
    try {
      db.prepare('UPDATE wa_users SET role = ? WHERE id = ?').run(role, userId);
      return { data: { userId, role } };
    } catch (err) { return { error: { code: 'INTERNAL', message: (err as Error).message } }; }
  });

  // 修改密码
  ipcMain.handle('auth:changePassword', async (_event, { userId, oldPassword, newPassword }: { userId: string; oldPassword: string; newPassword: string }) => {
    try {
      const result = await authService!.changePassword(userId, oldPassword, newPassword);
      if (!result.success) {
        return { error: { code: 'INVALID', message: result.error || '密码修改失败' } };
      }
      return { data: result };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // OAuth 桌面端交换
  ipcMain.handle('auth:oauthExchange', async (_event, { provider, code }: { provider: string; code: string }) => {
    try {
      const tokens = await exchangeOAuthCode(provider, code);
      if (!tokens) {
        return { error: { code: 'OAUTH_FAILED', message: 'OAuth 认证失败' } };
      }
      const result = await authService!.findOrCreateOAuth({
        email: tokens.email,
        name: tokens.name,
        provider,
        providerAccountId: tokens.providerAccountId,
      });
      return { data: result };
    } catch (err) {
      return { error: { code: 'OAUTH_ERROR', message: (err as Error).message } };
    }
  });

  // 创建用户（管理员）
  ipcMain.handle('auth:createUser', async (_event, { email, password, name, role }: { email: string; password: string; name: string; role: string }) => {
    try {
      const result = await authService!.createUser(email, password, name, role || 'viewer');
      return { data: result };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // 重置密码（管理员）
  ipcMain.handle('auth:resetPassword', async (_event, { userId, newPassword }: { userId: string; newPassword: string }) => {
    try {
      const result = await authService!.resetPassword(userId, newPassword);
      if (!result.success) return { error: { code: 'INVALID', message: result.error || '重置失败' } };
      return { data: result };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // 邀请用户
  ipcMain.handle('auth:invite', async () => {
    try {
      const token = crypto.randomUUID().replace(/-/g, '').slice(0, 32);
      const expiresAt = new Date(Date.now() + 72 * 3600_000).toISOString();
      // zx_20261002 M16-④: `wa_invite_tokens` **没有 `used` 列**（真列：id/token/created_by/created_at/
      //   expires_at/used_by/used_at）。原三条语句（建/验/核销）全按 `used` 写 ⇒ 邀请功能**整体抛错**，
      //   被各自的 `catch` 变成 `{error: INTERNAL}`。改用真列：`used_at IS NULL` ＝ 未用；
      //   核销写 `used_at`。**列存在性**这条病根与 M16 的另两处同源（见 `scripts/lib/sql-columns.ts`）。
      db.prepare('INSERT INTO wa_invite_tokens (id, token, expires_at) VALUES (?, ?, ?)').run(crypto.randomUUID(), token, expiresAt);
      return { data: { token, expires_at: expiresAt, url: `worker-ant://accept-invite/${token}` } };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  // 接受邀请
  ipcMain.handle('auth:acceptInvite', async (_event, { token, email, password, name }: { token: string; email: string; password: string; name: string }) => {
    try {
      // `expires_at` 存的是 ISO（带 `T`/`Z`），与 `datetime('now')` 的 `YYYY-MM-DD HH:MM:SS` **不同形**，
      //   直接字符串比大小在"同日"会读错 ⇒ 两侧都过 `datetime()` 归一后再比。
      const invite = db.prepare("SELECT * FROM wa_invite_tokens WHERE token = ? AND used_at IS NULL AND datetime(expires_at) > datetime('now')").get(token) as Record<string, unknown> | undefined;
      if (!invite) return { error: { code: 'INVALID', message: '邀请链接无效或已过期' } };
      db.prepare("UPDATE wa_invite_tokens SET used_at = datetime('now') WHERE token = ?").run(token);
      const result = await authService!.createUser(email, password, name, 'viewer');
      return { data: result };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  console.log('[IPC] Auth handlers registered');
}

/** OAuth code 交换（复用服务端逻辑） */
async function exchangeOAuthCode(provider: string, code: string): Promise<{ email: string; name: string; providerAccountId: string } | null> {
  if (provider === 'github') return exchangeGitHubCode(code);
  if (provider === 'google') return exchangeGoogleCode(code);
  return null;
}

async function exchangeGitHubCode(code: string): Promise<{ email: string; name: string; providerAccountId: string } | null> {
  const clientId = process.env.AUTH_GITHUB_ID;
  const clientSecret = process.env.AUTH_GITHUB_SECRET;
  if (!clientId || !clientSecret) return null;

  const tokenResp = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const tokenData = await tokenResp.json() as { access_token?: string };
  if (!tokenData.access_token) return null;

  const userResp = await fetch('https://api.github.com/user', {
    headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'worker-ant-desktop' },
  });
  const userData = await userResp.json() as { id?: number; login?: string; name?: string; email?: string };
  if (!userData.id) return null;

  let email = userData.email;
  if (!email) {
    try {
      const emailsResp = await fetch('https://api.github.com/user/emails', {
        headers: { Authorization: `Bearer ${tokenData.access_token}`, 'User-Agent': 'worker-ant-desktop' },
      });
      const emails = await emailsResp.json() as Array<{ email: string; primary: boolean }>;
      email = emails.find(e => e.primary)?.email;
    } catch { /* optional */ }
  }

  return { email: email || `${userData.login}@github.users`, name: userData.name || userData.login || 'GitHub User', providerAccountId: String(userData.id) };
}

async function exchangeGoogleCode(code: string): Promise<{ email: string; name: string; providerAccountId: string } | null> {
  const clientId = process.env.AUTH_GOOGLE_ID;
  const clientSecret = process.env.AUTH_GOOGLE_SECRET;
  if (!clientId || !clientSecret) return null;

  const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code', redirect_uri: 'worker-ant://auth/callback' }),
  });
  const tokenData = await tokenResp.json() as { id_token?: string; error?: string };
  if (!tokenData.id_token || tokenData.error) return null;

  const payload = JSON.parse(Buffer.from(tokenData.id_token.split('.')[1]!, 'base64').toString());
  return { email: payload.email || '', name: payload.name || payload.email?.split('@')[0] || 'Google User', providerAccountId: payload.sub || '' };
}
