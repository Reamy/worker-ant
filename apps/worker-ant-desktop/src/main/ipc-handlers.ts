import { ipcMain, safeStorage } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import type { AnsClient } from '@worker-ant/ans-client';

const TOKEN_KEY = 'wa_access_token';
const REFRESH_KEY = 'wa_refresh_token';

// 内存中缓存解密后的 token（避免频繁解密）
let _cachedToken: string | null = null;
let _cachedRefreshToken: string | null = null;

function encrypt(text: string): Buffer {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.encryptString(text);
  }
  // 回退：Base64 编码（非安全环境）
  return Buffer.from(text, 'utf-8');
}

function decrypt(buffer: Buffer): string {
  if (safeStorage.isEncryptionAvailable()) {
    return safeStorage.decryptString(buffer);
  }
  // 回退：Base64 解码
  return buffer.toString('utf-8');
}

// ANS 代理 — 单例 AnsClient，配置从数据库读取
let _ansClient: AnsClient | null = null;
let _dbForAns: unknown = null;

export function setAnsDb(db: unknown) { _dbForAns = db; }

export function clearAnsClient() {
  _ansClient = null;
  console.log('[ANS Proxy] 配置已更新，清除缓存（下次请求时用新配置重建）');
}

export async function getAnsClient() {
    if (!_ansClient) {
      const { AnsClient } = await import('@worker-ant/ans-client');
      // zx_20260930 M9: 身份三元组取 `resolveAnsCreds` **一处真源**（DB `wa_settings` → env → 缺省），
      //   不再本处手抄一遍同样的顺序（两处各记各的 ⇒ 漏读一个键就那一路恒 401 且静默）。
      const { resolveAnsCreds } = await import('./core/ans-signed-request.js');
      const { baseUrl: url, apiKey: key, secretKey: secret } = resolveAnsCreds(
        _dbForAns as { prepare(sql: string): { get(...args: unknown[]): unknown } } | undefined,
      );
      console.log(`[ANS Proxy] 初始化: ${url} (key=${key.slice(0,6)}...)`);
      _ansClient = new AnsClient({ serverUrl: url, apiKey: key, secretKey: secret });
    }
    return _ansClient;
  }

export function registerIpcHandlers(): void {
  // 自动更新
  ipcMain.handle('update:check', async () => {
    const { checkForUpdates } = await import('./auto-updater.js');
    return checkForUpdates();
  });

  async function ansCall(method: 'get'|'post'|'put'|'delete', path: string, body?: unknown) {
    try {
      const ans = await getAnsClient();
      if (method === 'get' || method === 'delete') return await ans[method](path);
      return await ans[method](path, body || {});
    } catch (err) {
      console.error(`[ANS Proxy] ${method.toUpperCase()} ${path} 失败:`, (err as Error).message);
      // zx_20261009 M5：**401（凭据不被认）**与其它失败**分家**——渲染层据此说清"未认证"，
      //   而不是一律落到"尚无可用模型"（把没认证说成没配模型，名实不符）。
      //   判型用 **duck-typing `.status`**（不用 `instanceof`）：打包闭包里 `ans-client` 可能有**多份**，
      //   `instanceof` 会因模块副本不同而落空；读 `status` 则跨副本稳。
      const status = (err as { status?: unknown }).status;
      const code = status === 401 ? 'ANS_UNAUTHORIZED' : 'ANS_UNAVAILABLE';
      return { error: { code, message: (err as Error).message } };
    }
  }

  ipcMain.handle('ans-proxy:get', async (_event, path: string) => ansCall('get', path));
  ipcMain.handle('ans-proxy:post', async (_event, path: string, body: unknown) => ansCall('post', path, body));
  ipcMain.handle('ans-proxy:put', async (_event, path: string, body: unknown) => ansCall('put', path, body));
  ipcMain.handle('ans-proxy:delete', async (_event, path: string) => ansCall('delete', path));
  // zx_20260930 M15-⑤: 带分页元数据的 ANS 列表读取。
  //   病根：renderer 的 `ipcCall` 会把返回值剥**一层** `.data`（renderer/src/lib/ipc.ts:31），
  //   而 ANS 的 `total`/`limit`/`offset`/`has_more` 恰是 `data` 的**兄弟**键 ⇒ 经 `ans-proxy:get`
  //   读到的只有列表，元数据被静默丢掉（界面于是无从知道"后面还有"）。
  //   本通道把「列表 + 元数据」整体放进 `data` ⇒ 剥一层后正好是 `{ rows, total, limit, offset, has_more }`。
  ipcMain.handle('ans-proxy:getPaged', async (_event, path: string) => {
    const raw = await ansCall('get', path);
    if (raw && typeof raw === 'object' && 'error' in raw) return raw; // 失败原样上抛，别裹进 data
    const r = raw as { data?: unknown[]; total?: number; limit?: number | null; offset?: number; has_more?: boolean };
    return { data: { rows: r.data ?? [], total: r.total ?? 0, limit: r.limit ?? null, offset: r.offset ?? 0, has_more: r.has_more ?? false } };
  });

  // 文件对话框
  ipcMain.handle('dialog:openDirectory', async () => {
    const { dialog, BrowserWindow } = await import('electron');
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openDirectory'],
      title: '选择项目工作目录',
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  ipcMain.handle('dialog:openFile', async () => {
    const { dialog, BrowserWindow } = await import('electron');
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile'],
      title: '选择文件',
    });
    return result.canceled ? null : result.filePaths[0] ?? null;
  });

  // zx_20261013_1 批二(K7)：**多选**文件（GUI 挂件选文件用）。单选的 `dialog:openFile` 保持不动——
  //   挂件要一次挂多件，故单开一个多选通道，不复用单选后拼接（那样选一次只能拿一件，得连点多次）。
  ipcMain.handle('dialog:openFiles', async () => {
    const { dialog, BrowserWindow } = await import('electron');
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, {
      properties: ['openFile', 'multiSelections'],
      title: '选择要挂到任务的文件',
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('dialog:saveFile', async (_event, defaultName: string) => {
    const { dialog, BrowserWindow } = await import('electron');
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return null;
    const result = await dialog.showSaveDialog(win, {
      defaultPath: defaultName,
      title: '保存文件',
    });
    return result.canceled ? null : result.filePath ?? null;
  });

  // 原生通知
  // zx_20261002 M1: 改走 `notification-service.showSystemNotification` 的**门控出口**（开关/全局免打扰/
  //   免打扰时段静音关键）。原实现直接 `new Notification` 裸发——本通道此前零调用方，一旦接线（IM 跨页提醒）
  //   就会绕过用户已关的 `ui_system_notifications` 与 `ui_dnd`。点击复用 `notif:focus-task{type:'im.navigate'}` 跳转。
  ipcMain.handle('notifications:show', async (_event, title: string, body: string) => {
    const { showSystemNotification } = await import('./core/notification-service.js');
    showSystemNotification(String(title ?? ''), String(body ?? ''));
  });

  // A2 (2026-09-03): 渲染进程路由焦点上报——用于原生通知「正在看该任务则不弹」判定
  ipcMain.handle('ui:taskFocus', async (_event, { taskId }: { taskId?: string | null }) => {
    const { setTaskFocus } = await import('./core/notification-service.js');
    setTaskFocus(taskId ?? null);
    return true;
  });

  // OAuth
  ipcMain.handle('oauth:open', async (_event, provider: string) => {
    const { openOAuthInBrowser } = await import('./auth-oauth.js');
    await openOAuthInBrowser(provider);
  });

  // 用系统默认浏览器打开外部链接/文件
  ipcMain.handle('shell:openExternal', async (_event, url: string) => {
    const { shell } = await import('electron');
    try {
      await shell.openExternal(url);
      return { data: { opened: true } };
    } catch (err) {
      return { error: { code: 'OPEN_FAILED', message: (err as Error).message } };
    }
  });

  // zx_20260911_5 M3-3(海德格尔·上手状态): 成果「在文件夹中显示」——本地路径直达，免"复制路径→再翻目录"。
  // 只接受**本地绝对路径**：带 scheme(如 file:// http(s)://) 或相对路径一律拒绝——不把 URL 当文件路径。
  ipcMain.handle('shell:showItemInFolder', async (_event, filePath: string) => {
    try {
      if (typeof filePath !== 'string' || !filePath || /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(filePath) || !path.isAbsolute(filePath)) {
        return { error: { code: 'INVALID_PATH', message: '仅支持本地绝对路径' } };
      }
      if (!fs.existsSync(filePath)) return { error: { code: 'NOT_FOUND', message: '路径不存在' } };
      const { shell } = await import('electron');
      shell.showItemInFolder(filePath);
      return { data: { shown: true } };
    } catch (err) {
      return { error: { code: 'SHOW_FAILED', message: (err as Error).message } };
    }
  });

  // Auth tokens
  ipcMain.handle('auth:getToken', async () => {
    if (_cachedToken) return _cachedToken;
    return null;
  });

  ipcMain.handle('auth:getRefreshToken', async () => {
    if (_cachedRefreshToken) return _cachedRefreshToken;
    return null;
  });

  ipcMain.handle('auth:setToken', async (_event, token: string) => {
    _cachedToken = token;
    try {
      const encrypted = encrypt(token);
      // 存储到 Electron 应用数据目录（由 main process 管理）
      const fs = await import('node:fs');
      const path = await import('node:path');
      const { app } = await import('electron');
      const dir = app.getPath('userData');
      fs.writeFileSync(path.join(dir, TOKEN_KEY), encrypted);
    } catch {
      // 加密失败时仅内存存储
    }
  });

  ipcMain.handle('auth:setRefreshToken', async (_event, token: string) => {
    _cachedRefreshToken = token;
    try {
      const encrypted = encrypt(token);
      const fs = await import('node:fs');
      const path = await import('node:path');
      const { app } = await import('electron');
      const dir = app.getPath('userData');
      fs.writeFileSync(path.join(dir, REFRESH_KEY), encrypted);
    } catch {
      // 加密失败时仅内存存储
    }
  });

  ipcMain.handle('auth:clearTokens', async () => {
    _cachedToken = null;
    _cachedRefreshToken = null;
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const { app } = await import('electron');
      const dir = app.getPath('userData');
      const tokenFile = path.join(dir, TOKEN_KEY);
      const refreshFile = path.join(dir, REFRESH_KEY);
      if (fs.existsSync(tokenFile)) fs.unlinkSync(tokenFile);
      if (fs.existsSync(refreshFile)) fs.unlinkSync(refreshFile);
    } catch {
      // 清理失败不影响
    }
  });

  // 启动时从磁盘恢复 token
  (async () => {
    try {
      const fs = await import('node:fs');
      const path = await import('node:path');
      const { app } = await import('electron');
      const dir = app.getPath('userData');
      const tokenFile = path.join(dir, TOKEN_KEY);
      const refreshFile = path.join(dir, REFRESH_KEY);
      if (fs.existsSync(tokenFile)) {
        const buf = fs.readFileSync(tokenFile);
        _cachedToken = decrypt(buf);
      }
      if (fs.existsSync(refreshFile)) {
        const buf = fs.readFileSync(refreshFile);
        _cachedRefreshToken = decrypt(buf);
      }
    } catch {
      // 恢复失败不影响启动
    }
  })();
}
