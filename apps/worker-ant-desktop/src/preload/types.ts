export interface ElectronAPI {
  platform: string;
  isElectron: boolean;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  invoke(channel: string, arg1: unknown, arg2: unknown): Promise<unknown>;
  getToken(): Promise<string | null>;
  getRefreshToken(): Promise<string | null>;
  setToken(token: string): Promise<void>;
  setRefreshToken(token: string): Promise<void>;
  clearTokens(): Promise<void>;
  openOAuth(provider: string): Promise<void>;
  onOAuthCallback(callback: (data: { token: string; refreshToken?: string }) => void): void;
  showNotification(title: string, body: string): Promise<void>;
  openDirectoryDialog(): Promise<string | null>;
  openFileDialog(): Promise<string | null>;
  saveFileDialog(defaultName: string): Promise<string | null>;
  /** zx_20261013_1 批二(K7): 多选文件对话框；取消返回 `[]`（GUI 挂件据此判长度） */
  openFilesDialog(): Promise<string[]>;
  /** zx_20261013_1 批二(K7): 拖入的 `File` → 盘上绝对路径（`webUtils.getPathForFile`，Electron ≥32 的唯一口） */
  getPathForFile(file: File): string;
  /** zx_20260911_5 M3-3: 在系统文件管理器中显示本地路径（main 侧仅接受本地绝对路径） */
  showItemInFolder(filePath: string): Promise<unknown>;
  /** 未配置更新通道时返回 {started:false, reason}（如实说明），而非静默/报假错 */
  checkForUpdates(): Promise<{ started: boolean; reason?: string }>;
  onUpdateStatus(callback: (data: { status: string; percent?: number; message?: string }) => void): void;
  onSystemResume(callback: () => void): void;
  onTaskEvent(callback: (event: { type: string; taskId?: string; task_id?: string; projectId?: string; newStatus?: string; new_status?: string; [key: string]: unknown }) => void): () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}
