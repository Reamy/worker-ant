import { ipcMain } from 'electron';
import type Database from 'better-sqlite3';
import { AuthService } from '../core/auth.js';
import { resolveLicenseTier } from '../core/license.js';
import { SeatLimitError } from '../core/seat-quota.js';
import { claimInviteToken, issueInviteToken, markInviteUsed } from '../core/invite.js';
import { SEED_OWNER_EMAIL, localOwnerState } from '../core/local-owner.js';
import crypto from 'node:crypto';

let authService: AuthService | null = null;

/**
 * zx_20261017_1 批五: 席位闸的错误码整形**一处**——四个建用户入口共用。
 *   满员是"能理解的拒绝"（`SEAT_LIMIT` + 已用/上限），不是内部错误。
 */
function authError(err: unknown, fallbackCode: string): { error: { code: string; message: string } } {
  const e = err as Error;
  if (e instanceof SeatLimitError) return { error: { code: 'SEAT_LIMIT', message: e.message } };
  return { error: { code: fallbackCode, message: e.message } };
}

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

  // zx_20261023_4: 首启本机所有者自动登录——判据在 `core/local-owner.ts`，此处只做壳。
  //   读侧：界面据此决定要不要显示"设置密码"卡片（不适用就什么都不显示）。
  ipcMain.handle('auth:localOwnerState', async () => {
    try {
      const state = localOwnerState(db);
      return { data: { eligible: state.kind === 'untouched_seed_owner', email: SEED_OWNER_EMAIL } };
    } catch {
      // 表缺失/坏库 ⇒ 不放行（fail closed），界面按"不适用"处理。
      return { data: { eligible: false, email: SEED_OWNER_EMAIL } };
    }
  });

  // 不成立时回 `data: null`（不是错误）：这就是"这台机器不该自动登录"，调用方落到登录页。
  ipcMain.handle('auth:ensureLocalOwner', async () => {
    try {
      const result = await authService!.ensureLocalOwnerSession();
      return { data: result };
    } catch (err) {
      return { error: { code: 'INTERNAL', message: (err as Error).message } };
    }
  });

  ipcMain.handle('auth:setLocalOwnerPassword', async (_event, { newPassword }: { newPassword: string }) => {
    try {
      const result = await authService!.setLocalOwnerPassword(newPassword);
      if (!result.success) {
        return { error: { code: 'INVALID', message: result.error || '密码设置失败' } };
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
      return authError(err, msg.includes('already') ? 'CONFLICT' : 'INTERNAL');
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
      return authError(err, 'OAUTH_ERROR');
    }
  });

  // 创建用户（管理员）
  ipcMain.handle('auth:createUser', async (_event, { email, password, name, role }: { email: string; password: string; name: string; role: string }) => {
    try {
      const result = await authService!.createUser(email, password, name, role || 'viewer');
      return { data: result };
    } catch (err) {
      return authError(err, 'INTERNAL');
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
      //   expires_at/used_by/used_at）。真列用法收在 `core/invite.ts`（发/接/核销一处），本处只做壳。
      // zx_20261017_1 批五: 发之前先过席位闸——满员不签发（不把"接不进来"的链接发给用户）。
      issueInviteToken(db, resolveLicenseTier(db), { id: crypto.randomUUID(), token, expiresAt });
      return { data: { token, expires_at: expiresAt, url: `worker-ant://accept-invite/${token}` } };
    } catch (err) {
      return authError(err, 'INTERNAL');
    }
  });

  // 接受邀请
  ipcMain.handle('auth:acceptInvite', async (_event, { token, email, password, name }: { token: string; email: string; password: string; name: string }) => {
    try {
      // zx_20261017_1 批五: **先验令牌与席位，再建用户，最后才核销**——满员/重名失败时令牌不烧，
      //   去掉一人后同一令牌仍可用（此前是先核销后建用户，失败即"链接作废、人没进来"）。
      const claim = claimInviteToken(db, resolveLicenseTier(db), token);
      if (!claim.ok) return { error: { code: 'INVALID', message: '邀请链接无效或已过期' } };
      const result = await authService!.createUser(email, password, name, 'viewer');
      markInviteUsed(db, token);
      return { data: result };
    } catch (err) {
      return authError(err, 'INTERNAL');
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
