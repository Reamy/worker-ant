import { contextBridge, ipcRenderer, webUtils } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  platform: process.platform,
  isElectron: true,

  // 通用 IPC 调用（替代 HTTP fetch）
  invoke: (channel: string, ...args: unknown[]): Promise<unknown> =>
    ipcRenderer.invoke(channel, ...args),

  // Auth token management (via safeStorage in main process)
  getToken: (): Promise<string | null> => ipcRenderer.invoke('auth:getToken'),
  getRefreshToken: (): Promise<string | null> => ipcRenderer.invoke('auth:getRefreshToken'),
  setToken: (token: string): Promise<void> => ipcRenderer.invoke('auth:setToken', token),
  setRefreshToken: (token: string): Promise<void> => ipcRenderer.invoke('auth:setRefreshToken', token),
  clearTokens: (): Promise<void> => ipcRenderer.invoke('auth:clearTokens'),

  // OAuth via system browser
  openOAuth: (provider: string): Promise<void> => ipcRenderer.invoke('oauth:open', provider),
  onOAuthCallback: (callback: (data: { token: string; refreshToken?: string }) => void): void => {
    ipcRenderer.on('oauth:callback', (_event, data) => callback(data));
  },

  // 原生文件对话框
  openDirectoryDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openDirectory'),
  openFileDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFile'),
  saveFileDialog: (defaultName: string): Promise<string | null> => ipcRenderer.invoke('dialog:saveFile', defaultName),
  // zx_20261013_1 批二(K7)：多选文件（GUI 挂件选文件）。取消返回 `[]`（非 null——调用点只需判长度）。
  openFilesDialog: (): Promise<string[]> => ipcRenderer.invoke('dialog:openFiles'),

  // zx_20261013_1 批二(K7)：把**拖入的 File** 还原成其**盘上绝对路径**。
  //   渲染层 `File.path`（Electron 老属性）自 Electron 32 起被移除，官方替代即 `webUtils.getPathForFile`
  //   —— 这是唯一能拿到拖拽文件真实路径的口（`File.name` 只有裸名，无法定位盘上件）。
  //   仅在此处经 preload 暴露：渲染层不可直接 import electron。
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),

  // zx_20260911_5 M3-3: 成果本地直达——在系统文件管理器中显示该路径（仅本地绝对路径）
  showItemInFolder: (filePath: string): Promise<unknown> => ipcRenderer.invoke('shell:showItemInFolder', filePath),

  // 自动更新
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke('update:check'),
  onUpdateStatus: (callback: (data: { status: string; percent?: number; message?: string }) => void): void => {
    ipcRenderer.on('update:status', (_event, data) => callback(data));
    ipcRenderer.on('update:progress', (_event, data) => callback({ status: 'downloading', ...data }));
    ipcRenderer.on('update:error', (_event, data) => callback({ status: 'error', ...data }));
  },

  // 系统事件
  onSystemResume: (callback: () => void): void => {
    ipcRenderer.on('system:resume', () => callback());
  },

  // 任务事件实时推送（从main进程eventBus转发）
  onTaskEvent: (callback: (event: { type: string; taskId?: string; task_id?: string; projectId?: string; newStatus?: string; new_status?: string; [key: string]: unknown }) => void): (() => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data as Parameters<typeof callback>[0]);
    ipcRenderer.on('task:event', handler);
    return () => { ipcRenderer.removeListener('task:event', handler); };
  },

  // A2 (2026-09-03): 原生通知点击 → 渲染进程聚焦/导航任务详情
  onTaskFocus: (callback: (data: { type?: string; taskId?: string }) => void): (() => void) => {
    const handler = (_event: unknown, data: unknown) => callback(data as { type?: string; taskId?: string });
    ipcRenderer.on('notif:focus-task', handler);
    return () => { ipcRenderer.removeListener('notif:focus-task', handler); };
  },

  // 原生桌面通知
  showNotification: (title: string, body: string): Promise<void> =>
    ipcRenderer.invoke('notifications:show', title, body),

  // C1 (2026-09-04_2): 设置变更实时推送（免打扰/声音运行中即时生效）
  onSettingsChanged: (callback: (data: { key: string; value: string }) => void): void => {
    ipcRenderer.on('settings:changed', (_event, data) => callback(data as { key: string; value: string }));
  },
});
