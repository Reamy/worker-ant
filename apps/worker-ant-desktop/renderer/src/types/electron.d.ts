interface DiffLine {
  type: 'add' | 'del' | 'ctx';
  content: string;
}
interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}
interface TaskEvent {
  type: string;
  taskId?: string;
  task_id?: string;
  projectId?: string;
  newStatus?: string;
  new_status?: string;
  // Phase 1 文件变更
  filePath?: string;
  action?: string;
  content?: string;
  size?: number;
  hunks?: DiffHunk[];
  additions?: number;
  deletions?: number;
  truncated?: boolean;
  deliverableId?: string;
  // Phase 2 决策确认
  decision_type?: string;
  question?: string;
  options?: string[];
  context?: Record<string, unknown>;
  issue?: string;
  // Phase A 逐步执行流
  step?: number;
  text?: string;
  tokens?: number;
  // D1 (2026-09-04_2) 心跳/任务事件顶层任务名（main 转发 task.heartbeat 携带）
  title?: string;
  totalTokens?: number;
  toolCalls?: string;
  // D2 (2026-09-01) 步骤详情：耗时 / 本步 token 增量 / 工具成败
  duration_ms?: number;
  token_delta?: number;
  toolOk?: boolean;
  // D3 (2026-09-02) token 级流式：本步实时生成文本增量（task.step_streaming 瞬态事件）
  textDelta?: string;
  // CoT (2026-09-03) 推理模型思考过程增量（reasoning_content 旁路提取）
  reasoningDelta?: string;
  // Phase B 记忆注入可视化
  memories?: Array<{ id: string; type: string; content: string; confidence: number; tag?: string }>;
  // Phase A (2026-08-28 zx_1) 任务目标显性化
  goal?: string;
  success_criteria?: string;
  investigate?: string[];
  principalContradiction?: string;
  // Phase B (2026-08-28 zx_1) 目标达成监控信号
  reason?: string;
  level?: string;
  message?: string;
  signalType?: string;
  // Phase B (2026-08-28 zx_5) 任务执行预估
  steps?: number;
  basedOn?: number;
  // E1 (2026-09-04_2) 累计预算 band（step_finished 附）——预算带质变点
  budgetRatio?: number;
  budgetBand?: number;
  budgetMaxTokens?: number;
  // D1 (2026-09-04_2) 长任务心跳简报（task.heartbeat 瞬态）
  heartbeatElapsedSec?: number;
  // zx_20260904_4 T5 (2026-09-04) 步骤实时上下文水位%（step_finished 附，近似估算）
  contextWaterPct?: number;
  // zx_20260904_7 I1 (2026-09-04) 实际 vs 预估 token 偏差%（step_finished 附）
  estBiasPct?: number;
  progressPct?: number;
  // zx_20260906 批4 (4a/4d): IM 入站消息实时 + 记忆沉淀广播（main 转发 payload 附带）
  channelId?: string;
  channel_id?: string;
  channelType?: string;
  channel_type?: string;
  memory_types?: string[];
  // zx_20260912 M1: 渠道运行期跃迁（channel.status_changed 瞬态）——detail 是这次跃迁的如实说明
  status?: string;
  detail?: string;
  // zx_20260914 M1-3: IM 未读数（`im.unread` 瞬态）——main 单点算出后随既有 `task:event` 通道广播，
  //   托盘角标与导航红点**同一个数**；本字段只被 AppLayout 消费（见其注释）。
  unread?: number;
  // zx_20261004 M4: 节点事件（`node.presence_changed` 持久化 / `node.heartbeat` 瞬态）。
  //   `node.presence_changed` 带 nodeId + node（改档后的台账行）；`node.heartbeat` 带本机负载即时值。
  //   zx_20261007 M2: `busyRatio` → `dispatchFillRatio`（正名：是"我方派单填充率"非机器忙闲）+ 新增 `cpuUsagePercent`。
  nodeId?: string;
  node?: Record<string, unknown>;
  ok?: boolean;
  dispatchFillRatio?: number;
  cpuUsagePercent?: number | null;
  jobsRunning?: number;
  lastError?: string | null;
  // zx_20261004 M10: 设备事件（`device.discovered` / `device.status_changed`，两者皆持久化）。
  //   `device` 是落账/改后的台账行（含 id/authorized/status）；`isNew` 仅 `device.discovered` 带（供"新发现"标）。
  deviceId?: string;
  device?: Record<string, unknown>;
  isNew?: boolean;
}

interface ElectronAPI {
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
  onSettingsChanged(callback: (data: { key: string; value: string }) => void): void;
  openDirectoryDialog(): Promise<string | null>;
  openFileDialog(): Promise<string | null>;
  saveFileDialog(defaultName: string): Promise<string | null>;
  /** zx_20261013_1 批二(K7): 多选文件对话框；取消返回 `[]` */
  openFilesDialog(): Promise<string[]>;
  /** zx_20261013_1 批二(K7): 拖入的 `File` → 盘上绝对路径（`webUtils.getPathForFile`） */
  getPathForFile(file: File): string;
  /** zx_20260911_5 M3-3: 在系统文件管理器中显示本地路径（main 侧仅接受本地绝对路径） */
  showItemInFolder(filePath: string): Promise<unknown>;
  /** 未配置更新通道时返回 {started:false, reason}（如实说明），而非静默/报假错 */
  checkForUpdates(): Promise<{ started: boolean; reason?: string }>;
  onUpdateStatus(callback: (data: { status: string; percent?: number; message?: string }) => void): void;
  onSystemResume(callback: () => void): void;
  onTaskEvent(callback: (event: TaskEvent) => void): () => void;
  // A2 (2026-09-03): 原生通知点击 → 聚焦任务详情导航
  onTaskFocus(callback: (data: { type?: string; taskId?: string }) => void): () => void;
}

declare global {
  interface Window {
    electronAPI?: ElectronAPI;
  }
}

export {};
