import pkg from 'electron-updater';
const { autoUpdater } = pkg;
import fs from 'node:fs';
import path from 'node:path';
import { app, BrowserWindow, dialog } from 'electron';

let updateCheckInterval: ReturnType<typeof setInterval> | null = null;

/**
 * 是否配置了**真实的更新通道**。
 * electron-builder 只在配置了 `publish` 时才把 `app-update.yml` 打进包（本仓当前未配置，
 * 见 electron-builder.yml 的 TODO(M4/M20)）。无此文件时 `checkForUpdates()` 必以 ENOENT 失败，
 * 每次启动都刷一条"更新失败"——那是不存在的故障。故无通道时**不发起检查**，如实说明原因。
 */
function hasUpdateFeed(): boolean {
  return app.isPackaged && fs.existsSync(path.join(process.resourcesPath, 'app-update.yml'));
}

export function initAutoUpdater(): void {
  // 配置更新源（electron-builder publish 配置）
  autoUpdater.autoDownload = false; // 用户可选择是否下载
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => {
    sendToRenderer('update:status', { status: 'checking' });
  });

  autoUpdater.on('update-available', (info) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;

    dialog.showMessageBox(win, {
      type: 'info',
      title: '发现新版本',
      message: `工蚁 ${info.version} 可用`,
      detail: `当前版本将更新到 ${info.version}。是否立即下载？`,
      buttons: ['立即下载', '稍后提醒'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        sendToRenderer('update:status', { status: 'downloading' });
        autoUpdater.downloadUpdate().catch((err) => {
          console.error('[更新] 下载失败:', err.message);
        });
      }
    });
  });

  autoUpdater.on('update-not-available', () => {
    sendToRenderer('update:status', { status: 'up-to-date' });
  });

  autoUpdater.on('download-progress', (progress) => {
    sendToRenderer('update:progress', { percent: progress.percent });
  });

  autoUpdater.on('update-downloaded', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;

    dialog.showMessageBox(win, {
      type: 'info',
      title: '更新已下载',
      message: '新版本已下载完成，重启应用以完成更新。',
      buttons: ['立即重启', '稍后'],
      defaultId: 0,
    }).then(({ response }) => {
      if (response === 0) {
        autoUpdater.quitAndInstall(false, true);
      }
    });
  });

  autoUpdater.on('error', (err) => {
    console.error('[更新] 错误:', err.message);
    sendToRenderer('update:error', { message: err.message });
  });
}

export function checkForUpdates(): { started: boolean; reason?: string } {
  if (!hasUpdateFeed()) {
    return { started: false, reason: '未配置更新通道（发行版尚未挂接发布源），已跳过检查' };
  }
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[更新] 检查失败:', err.message);
  });
  return { started: true };
}

export function startPeriodicUpdateCheck(intervalMinutes = 240): void {
  // 启动时立即检查一次；无通道则如实说明并**不装定时器**（免得每轮空刷）
  const first = checkForUpdates();
  if (!first.started) {
    console.log(`[更新] ${first.reason}`);
    return;
  }
  // 定期检查（默认每4小时）
  updateCheckInterval = setInterval(() => { checkForUpdates(); }, intervalMinutes * 60_000);
}

export function stopPeriodicUpdateCheck(): void {
  if (updateCheckInterval) {
    clearInterval(updateCheckInterval);
    updateCheckInterval = null;
  }
}

function sendToRenderer(channel: string, data: unknown): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    win.webContents.send(channel, data);
  }
}
