/**
 * IPC 调用封装 — 替代 HTTP fetch，通过 Electron IPC 直接调用 Main Process 服务。
 * 浏览器环境下回退到 HTTP fetch。
 */

// 自省两本账的返回形状取自 main 侧真源，不在此手抄镜像（手抄的形状会随真源漂移而悄悄变错）：
//   core/simplification-audit.ts · SimplificationReport / core/self-healing-monitor.ts · HealingRecord。
//   仅类型引用（`import type` ⇒ 打包期整条擦除），不引入 main 侧运行时依赖。
import type { SimplificationReport } from '../../../src/main/core/simplification-audit.js';
import type { HealingRecord } from '../../../src/main/core/self-healing-monitor.js';
// zx_20261002 M11: 调用账聚合的返回形状同法取 main 侧真源（`service-call-ledger.ts`），不手抄。
import type { ServiceCallReport } from '../../../src/main/core/service-call-ledger.js';
// zx_20261016_3 批四（M34）：自产提案的形状与**决策词表**同取自 main 侧真源（`core/self-evolve.ts`，
//   该模块刻意做成零运行期 import 正是为了 renderer 能引它的值——见其头注释）。手抄一份会漂的镜像不行。
import { PROPOSAL_DECISIONS, type SelfEvolveProposal, type ProposalDecision } from '../../../src/main/core/self-evolve.js';
// zx_20261004 M4/M5: 节点台账的返回形状取**共享真源**（ANS 与桌面同引那一份），不手抄镜像。
import type { AnsNode, NodePatch } from '../../../../../packages/shared-types/src/nodes.js';
// zx_20261004 M9/M10: 设备台账与控制结果的返回形状取 main 侧**零依赖语义模块**真源（`device-registry.ts`），
//   不手抄镜像（手抄的形状会随真源漂移而悄悄变错）。仅类型引用，打包期整条擦除。
import type { AnsDevice, DeviceActionRow, DeviceControlOutcome, TaskRef } from '../../../src/main/core/device-registry.js';
// zx_20261018_1 批五: 意图演练的计划形状同取 main 侧真源（步骤/略过件——不另写一份）。
import type { IntentSkip, IntentStep } from '../../../src/main/core/intent-plans.js';
// zx_20261013_1 批五: MQTT 配置上屏形状取自 main 侧零依赖适配层真源 `device-mqtt.ts`（仅类型，打包期擦除）。
import type { MqttStatusPayload } from '../../../src/main/core/device-mqtt.js';
// zx_20261023_5 批三: 设备渠道目录的形状取 main 侧零依赖真源 `device-channel.ts`（仅类型，打包期擦除）。
import type { ChannelAuthorize, DeviceChannel } from '../../../src/main/core/device-channel.js';
// zx_20261022_3 批三: 测试连接的**结果形状**取 main 侧零依赖真源 `device-diagnostics.ts`（仅类型，打包期擦除）。
import type { DeviceTestResult, DeviceTestTarget } from '../../../src/main/core/device-diagnostics.js';
// zx_20261004 M13: 调用记录的返回形状取 main 侧真源（`node-call-log.ts`），不手抄镜像。仅类型引用。
import type { NodeCallRecord } from '../../../src/main/core/node-call-log.js';
// zx_20261011 M4 出站台账/派发结局的形状取自 main 侧真源（`node-dispatch-log.ts` / `node-dispatcher.ts`），不手抄镜像。
import type { NodeDispatchRecord } from '../../../src/main/core/node-dispatch-log.js';
import type { DispatchResult, DispatchReadResult } from '../../../src/main/core/node-dispatcher.js';
// zx_20261012: 「未入网首因」的词表取自 main 侧真源（`node-heartbeat.ts`），不在此手抄镜像（词表的第二落点会漂）。
import type { NodeEnrollmentReason } from '../../../src/main/core/node-heartbeat.js';
// zx_20261005 M8: 许可状态形状取 main 侧**零依赖真源**（`core/license.ts`），不手抄镜像。仅类型引用。
import type { LicenseState } from '../../../src/main/core/license.js';
import type { SeatUsage } from '../../../src/main/core/seat-quota.js';
// zx_20261005 M22（Team 档软闸）: 面板据 `gate` 显示升级提示/禁用动作。仅类型引用 main 真源，打包期擦除。
import type { TeamGate } from '../../../src/main/core/team-gate.js';
// zx_20261005 M11: 定价形状同引 main 侧真源（`core/pricing.ts`），不手抄镜像。
import type { PricingPayload } from '../../../src/main/core/pricing.js';
// zx_20261018_2 批五: 档位对照形状同引 main 侧真源（`core/tier-catalog.ts`），不手抄镜像。
import type { TierCatalogPayload } from '../../../src/main/core/tier-catalog.js';
// zx_20261022_3 批九: 档位用量形状同引 main 真源（`core/tier-usage.ts`），不手抄镜像。
import type { TierUsagePayload } from '../../../src/main/core/tier-usage.js';
// zx_20261023_5 批五: 云端权益上屏形状同引 main IPC 真源（仅类型，打包期擦除——该文件运行期 import electron）。
import type { CloudEntitlementPayload } from '../../../src/main/ipc/license.ipc.js';
// zx_20261017_1 批七: 知识包预览/导出的返回形状同引 main 真源（仅类型，打包期擦除）。
import type { KnowledgeInjectionStats, ProjectKnowledgePreview } from '../../../src/main/core/project-knowledge.js';
import type { KnowledgeExportResult } from '../../../src/main/core/knowledge-export.js';
// zx_20261022_3 批七: 导入模式/结果/导入账形状同引 main 真源（仅类型，打包期擦除）。
import type {
  KnowledgeImportMode,
  KnowledgeImportRecord,
  KnowledgeImportResult,
} from '../../../src/main/core/knowledge-import.js';
// zx_20261022_3 批八: 画像视图形状同引 main IPC 真源（仅类型，打包期擦除）。
import type { KnowledgeProfileView } from '../../../src/main/ipc/knowledge.ipc.js';
// zx_20261021_3 批五: 领域包的资产/注入成效形状同引 main 真源（仅类型，打包期擦除）。
import type { DomainPackListRow, DomainPackPayload, DomainPackStats } from '../../../src/main/core/domain-pack.js';
// zx_20261014_4 批三: 「门」（外部 AI 终端接入）的返回形状取 main 侧真源——仅类型引用，打包期擦除。
//   ⚠ 只 **type** 引 `core/external-*` 与 `ipc/external.ipc`（后者运行期 import electron ⇒ 只能类型引）。
//   能力词表**不在渲染层手抄**（第二落点会漂）：随 `external:list` 的载荷由 main 送来。
import type { PendingTerminalPublic, TerminalPublic } from '../../../src/main/core/external-terminals.js';
import type { ExternalCallRow } from '../../../src/main/core/external-calls.js';
import type { ExternalListPayload, InboundStatusPayload, LanPendingPayload } from '../../../src/main/ipc/external.ipc.js';
// zx_20261017_1 批二: 审计行的形状取 main 侧词表真源（仅类型，打包期擦除）。
import type { AuditEventRow, AuditSource } from '../../../src/main/core/audit-labels.js';
// zx_20261017_1 批六: 团队共享库的条目形状与候选形状取共享真源/main core（仅类型，打包期擦除）。
import type { TeamItem, TeamItemKind } from '../../../../../packages/shared-types/src/team.js';
import type { LocalCandidates, LocalTeamItem } from '../../../src/main/core/team-library.js';

type IpcResult<T> = { data: T } | { error: { code: string; message: string } };

/** zx_20260910_1 M4: 带错误码的 IPC 错误——此前只抛 message，调用方无法区分业务码
 *  （如 ALREADY_RESPONDED 属幂等重复提交，应视同成功静默处理，而非报错提示）。 */
export class IpcError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message || code);
    this.name = 'IpcError';
    this.code = code;
  }
}

async function ipcCall<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (window.electronAPI?.isElectron) {
    const result = await window.electronAPI.invoke(channel, ...args) as IpcResult<T>;
    if ('error' in result) {
      throw new IpcError(result.error.code, result.error.message);
    }
    return (result as { data: T }).data;
  }
  // 浏览器回退：HTTP fetch（开发阶段兼容）
  throw new Error('IPC not available in browser mode');
}

/**
 * zx_20260914 M0.6: 「一次用户意图」的名字——**一次表单会话生成一个**，同一会话内的重复提交共用它。
 *
 * 为何不能每次点击现生成：主进程的去重判据就是"同键即同一次意图"，键每次变则判据永不相遇；
 * 而 React 的 state 在两次同 tick 点击间来不及更新（`creating` 标志挡不住同一 tick 的第二次），
 * 故真正的兜底是"两次调用带同一个键" ⇒ 主进程查到既有行并返回它。
 */
export function newClientRequestId(): string {
  const c = globalThis.crypto as { randomUUID?: () => string } | undefined;
  return c?.randomUUID?.() ?? `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ===== Auth =====
export const auth = {
  login: (email: string, password: string) =>
    ipcCall<{ user: Record<string, unknown>; accessToken: string; refreshToken: string }>('auth:login', { email, password }),

  register: (email: string, password: string, name: string) =>
    ipcCall<{ user: Record<string, unknown>; accessToken: string; refreshToken: string }>('auth:register', { email, password, name }),

  refresh: (refreshToken: string) =>
    ipcCall<{ accessToken: string; refreshToken: string }>('auth:refresh', { refreshToken }),
};

// ===== Project =====
export const projects = {
  list: () => ipcCall<Array<Record<string, unknown>>>('project:list'),

  get: (id: string) => ipcCall<Record<string, unknown>>('project:get', { id }),

  create: (body: {
    name: string; description?: string; cron_schedule?: string; cron_timezone?: string; working_dir?: string;
    cron_create_task?: { title?: string; description?: string }; cron_run_command?: string;
    autonomous_mode?: string; sandbox_mode?: string;
    budget?: { max_tokens_per_task?: number; max_cost_usd_per_task?: number };
    rhythm?: { activeHourStart?: number; activeHourEnd?: number; maxConcurrency?: number };
    backlog?: string[];
  }) => ipcCall<Record<string, unknown>>('project:create', body),

  update: (id: string, body: Record<string, unknown>) =>
    ipcCall<Record<string, unknown>>('project:update', { id, body }),

  // zx_20261012_3 批一: `removeDataDir` 由删除弹窗的复选框给（默认勾选 ⇒ 不传也清）；
  //   显式 `false` 才保留盘上数据目录。清的那一路只由 main 拼 `data/projects/<id>`，绝不碰 `working_dir`。
  delete: (id: string, opts?: { removeDataDir?: boolean }) =>
    ipcCall<{ id: string; deleted: boolean; dataDirRemoved?: boolean }>('project:delete', { id, removeDataDir: opts?.removeDataDir }),

  /** 删项目弹窗要如实显示"将清哪个盘" ⇒ 真实路径由 main 给（渲染层拼不出 dev/prod 两种根）。 */
  projectsDir: () => ipcCall<{ projectsDir: string }>('project:projectsDir'),

  updateStatus: (id: string, status: string) =>
    ipcCall<Record<string, unknown>>('project:updateStatus', { id, status }),

  clone: (id: string, name?: string) =>
    ipcCall<Record<string, unknown>>('project:clone', { id, name }),

  memories: (id: string, type?: string) =>
    ipcCall<{ list: Array<Record<string, unknown>>; counts: Array<Record<string, unknown>> }>('project:memories', { id, type }),

  milestones: (id: string) =>
    ipcCall<{ blockers: Array<Record<string, unknown>>; milestones: Array<Record<string, unknown>>; planMilestones: Array<Record<string, unknown>> }>('project:milestones', { id }),

  // zx_20260905 批5: 项目质量聚合（均质/趋势）
  qualityStats: (id: string) =>
    ipcCall<{ count: number; avg: number | null; low: number; recent: Array<Record<string, unknown>> }>('project:qualityStats', { id }),

  tensions: (id: string) =>
    ipcCall<{ tensions: Record<string, Record<string, unknown>>; configs: Record<string, Record<string, unknown>> }>('project:tensions', { id }),

  updateTension: (id: string, tensionId: string, position?: number, autoAdjust?: boolean) =>
    ipcCall<Record<string, unknown>>('project:updateTension', { id, tensionId, position, autoAdjust }),

  members: (id: string) => ipcCall<Array<Record<string, unknown>>>('project:members', { id }),

  addMember: (id: string, userId: string, role?: string) =>
    ipcCall<Array<Record<string, unknown>>>('project:addMember', { id, userId, role }),

  healthViews: (id: string) => ipcCall<Record<string, Record<string, unknown>>>('project:healthViews', { id }),

  knowledgePanorama: (id: string) => ipcCall<Record<string, unknown>>('project:knowledgePanorama', { id }),

  // zx_20260908 M2(B1): 项目「成果交付单」凝练聚合（done里程碑→落地任务 / 已验收doc·主要成果 / 高质任务）
  // zx_20260908_1 B1: 可选 window('30'/'7'=近N天/'all') 按窗口归口(primary 为累计位)
  deliveryDigest: (id: string, window?: string) =>
    ipcCall<{
      milestonesDone: Array<Record<string, unknown>>;
      primaryDeliverables: Array<Record<string, unknown>>;
      verifiedDocs: Array<Record<string, unknown>>;
      highQualityTasks: Array<Record<string, unknown>>;
    }>('project:deliveryDigest', { id, window: window ?? 'all' }),

  // zx_20261002 M11: 项目调用记账（只读聚合）——MCP 调用 / A2A 启动 / 守护进程启动 的成败与耗时。
  //   形状取自 main 侧真源 `core/service-call-ledger.ts` 的 `ServiceCallReport`，不在此手抄镜像。
  serviceCalls: (id: string) => ipcCall<ServiceCallReport>('service-calls:project', id),
};

// ===== Knowledge pack（zx_20261017_1 批七）=====
// 预览与注入同一把尺（main 侧 `previewProjectKnowledge` / `selectKnowledgeForInject`）；
// 导出仅落 JSONL，文件内 `training:false`。
export const knowledge = {
  preview: (projectId: string, archetype?: string) =>
    ipcCall<ProjectKnowledgePreview>('knowledge:preview', { projectId, archetype }),
  export: (projectId: string) =>
    ipcCall<KnowledgeExportResult>('knowledge:export', { projectId }),
  // zx_20261018_1 批七 R-66: 注入成效（真实注入行 → 归来结局），面板据此显示“注入 N 次 / 成功 M / 失败 K”。
  stats: (projectId: string) =>
    ipcCall<KnowledgeInjectionStats>('knowledge:stats', { projectId }),
  // zx_20261022_3 批七: 导入（挂 Pro 闸；拒因以 `FEATURE_REQUIRED` 原样上屏，解析错以解析码上屏）。
  import: (projectId: string, filePath: string, mode: KnowledgeImportMode) =>
    ipcCall<KnowledgeImportResult>('knowledge:import', { projectId, filePath, mode }),
  // 导入账（最近在前）——界面据此显示“上次从哪个包导了多少节”。
  imports: (projectId: string) =>
    ipcCall<KnowledgeImportRecord[]>('knowledge:imports', { projectId }),
  // zx_20261022_3 批八: 项目画像——读/手动生成刷新/启停。**不挂档位闸**（社区档照常自用）。
  profile: (projectId: string) =>
    ipcCall<KnowledgeProfileView>('knowledge:profile', { projectId }),
  profileGenerate: (projectId: string) =>
    ipcCall<KnowledgeProfileView>('knowledge:profileGenerate', { projectId }),
  profileEnabled: (projectId: string, enabled: boolean) =>
    ipcCall<KnowledgeProfileView>('knowledge:profileEnabled', { projectId, enabled }),
};

// ===== Domain pack（zx_20261021_3 批五）=====
// 生成/启用挂 Pro 闸（拒因原样以 `FEATURE_REQUIRED` 上屏）；撤销不挂闸；导入≠启用。
export const packs = {
  list: (projectId?: string) =>
    ipcCall<{ packs: DomainPackListRow[] }>('packs:list', { projectId }),
  derive: (projectId: string, opts: { name?: string; description?: string } = {}) =>
    ipcCall<{ id: string; pack: DomainPackPayload }>('packs:derive', { projectId, ...opts }),
  apply: (projectId: string, packId: string) =>
    ipcCall<{ applied: boolean; already: boolean }>('packs:apply', { projectId, packId }),
  // 撤销**永不挂闸**——`FEATURE_REQUIRED` 只可能来自 apply/derive。
  unapply: (projectId: string, packId: string) =>
    ipcCall<{ removed: boolean }>('packs:unapply', { projectId, packId }),
  stats: (projectId: string) => ipcCall<DomainPackStats>('packs:stats', { projectId }),
};

// ===== Task =====
export const tasks = {
  // zx_20261018_3 批五「显」: 真分页——返回 `{ rows, total, limit, offset }`（缺省页大小由 main 侧
  //   `resolvePage` 夹取：100/硬上限 500）。`total` 是全量口径，界面据此写"已加载 K / 共 M"。
  list: (projectId: string, page?: { limit?: number; offset?: number }) =>
    ipcCall<{ rows: Array<Record<string, unknown>>; total: number; limit: number; offset: number }>('task:list', { projectId, ...page }),

  // 确需"本项目全部任务"的调用点（详情页的父/前置标题、建单的父任务候选）按页取完——
  //   每次 IPC 都受硬上限约束，不在**一次**调用里把整表拉满。
  listAll: async (projectId: string): Promise<Array<Record<string, unknown>>> => {
    const all: Array<Record<string, unknown>> = [];
    for (;;) {
      const r = await tasks.list(projectId, { limit: 500, offset: all.length });
      const rows = Array.isArray(r.rows) ? r.rows : [];
      all.push(...rows);
      if (rows.length === 0 || all.length >= (Number(r.total) || 0)) break;
    }
    return all;
  },

  // zx_20260930 M4-2: 对话与成果各自分页。`*Total` 是**服务端全量口径**（与当页明细同集合、同范围真源），
  //   页面据此写"已加载 K / 共 M"并决定是否出「加载更多」——不得用当页长度冒充总数。
  get: (id: string, page?: { convLimit?: number; convOffset?: number; delivLimit?: number; delivOffset?: number }) =>
    ipcCall<{ task: Record<string, unknown>; conversations: Array<Record<string, unknown>>; conversationsTotal?: number; deliverables: Array<Record<string, unknown>>; deliverablesTotal?: number }>('task:get', { id, ...page }),

  /** zx_20261023_5 批一：任务详情「派单理由」三行（与真派同一把尺）。 */
  dispatchReason: (id: string) => ipcCall<DispatchReasonView>('task:dispatchReason', { id }),

  // zx_20260907 M3(D2 复核补): parentTaskId 可选——同项目指定父任务，打通 GUI 手工构造父子链
  // zx_20260909_1 M4(Z1): planTaskId 可选——新建即关联"方案(规划)"(创建即落 ctx.scheme_ref, 先于动工)
  // zx_20260914 M0.6: clientRequestId 可选——**一次表单提交 = 一个键**，main 侧据此幂等去重（双击不再建两份）。
  // zx_20261013_1 批二(K7): attachmentPaths 可选——建任务时就把本地件挂上（main 侧落盘并写 `context_json.attachments`）。
  create: (projectId: string, title: string, description?: string, priority?: number, acceptance_criteria?: string, parentTaskId?: string, planTaskId?: string, clientRequestId?: string, attachmentPaths?: string[]) =>
    ipcCall<Record<string, unknown>>('task:create', { projectId, title, description, priority, acceptance_criteria, parent_task_id: parentTaskId, plan_task_id: planTaskId, client_request_id: clientRequestId, attachment_paths: attachmentPaths }),

  // zx_20261013_1 批二(K7): 给已存在的任务挂本地件（详情页「挂附件」）。逐件独立成败，如实回执。
  attachFiles: (id: string, filePaths: string[]) =>
    ipcCall<{ imported: number; failures: Array<{ filePath: string; error: string }> }>('task:attachFiles', { id, filePaths }),

  updateStatus: (id: string, status: string) =>
    ipcCall<{ id: string; status: string }>('task:updateStatus', { id, status }),

  // zx_20261012_2 批二: 归档（放弃）——独立动作（弃 ≠ 败）。main 侧走唯一写手 `archiveTask`。
  archive: (id: string, reason?: string) =>
    ipcCall<{ id: string; status: string }>('task:archive', { id, reason }),

  retry: (id: string) => ipcCall<{ id: string; status: string }>('task:retry', { id }),

  resume: (id: string, reply?: string) => ipcCall<{ id: string; status: string }>('task:resume', { id, reply }),

  respond: (id: string, decision: 'allow' | 'deny' | 'option', value?: string) =>
    ipcCall<{ id: string; status: string; resumed?: boolean; rejected?: boolean }>('task:respond', { id, decision, value }),

  interrupt: (id: string) => ipcCall<Record<string, unknown>>('task:interrupt', { id }),

  inject: (id: string, text: string) => ipcCall<{ id: string; status: string; injected?: boolean }>('task:inject', { id, text }),

  delete: (id: string) => ipcCall<{ id: string; deleted: boolean }>('task:delete', { id }),

  update: (id: string, body: { title?: string; description?: string; priority?: number; acceptance_criteria?: string; depends_on?: string }) =>
    ipcCall<Record<string, unknown>>('task:update', { id, ...body }),

  context: (id: string, context?: Record<string, unknown>) =>
    ipcCall<Record<string, unknown>>('task:context', context ? { id, context } : { id }),

  events: (id: string) => ipcCall<Array<Record<string, unknown>>>('task:events', { id }),

  similar: (id: string, projectId: string) =>
    ipcCall<Array<Record<string, unknown>>>('task:similar', { id, projectId }),

  templates: () => ipcCall<Array<Record<string, unknown>>>('task:templates'),
};

// ===== IM =====
export const im = {
  channels: () => ipcCall<Array<Record<string, unknown>>>('im:channels'),

  createChannel: (channel_type: string, name?: string, config?: Record<string, string>) =>
    ipcCall<Record<string, unknown>>('im:createChannel', { channel_type, name, config }),

  updateChannel: (id: string, body: Record<string, unknown>) =>
    ipcCall<Record<string, unknown>>('im:updateChannel', { id, body }),

  startChannel: (id: string) => ipcCall<{ id: string; status: string }>('im:startChannel', { id }),

  stopChannel: (id: string) => ipcCall<{ id: string; status: string }>('im:stopChannel', { id }),

  // zx_20260911_5 M2-3: offset 用于「加载更多」(main 侧 LIMIT 50 OFFSET n)
  // zx_20260912 M2-4: 改 rowid 游标 `beforeSeq`(已加载最旧行的 seq)——OFFSET 会随实时插入整体位移而重/漏。
  // zx_20260913 M1-5: 补 q(搜索 message_json)/direction(方向筛选)——服务端过滤, 与游标/offset 同一 WHERE。
  conversations: (channelId: string, opts?: { offset?: number; beforeSeq?: number; q?: string; direction?: string }) =>
    ipcCall<Array<Record<string, unknown>>>('im:conversations', { channelId, ...opts }),

  // zx_20260914 M1-1: **手工回话**——界面第一次能自己说一句。此前只能「看」(`conversations`)，
  //   或「重发别人的话」(`im:resend` 认 convId)，"回得了话"缺最后一环。
  //   失败按错误码抛出（`IpcError.code`）：NO_CONTENT/BAD_REQUEST/NOT_FOUND/TOO_LONG/NO_ADAPTER/SEND_FAILED，
  //   `SEND_FAILED` 的真因原文即 message，界面直接上屏（不吞成"发送失败"三个字）。
  send: (channelId: string, externalUserId: string, text: string) =>
    ipcCall<{ sent: true; note?: string }>('im:send', { channelId, externalUserId, text }),

  // zx_20260930 M1: **手工发件**——与 `send` 同形。失败按错误码抛出（`IpcError.code`）：
  //   NO_CONTENT/BAD_REQUEST/FILE_NOT_FOUND/NOT_FOUND/NO_ADAPTER/**UNSUPPORTED_MEDIA**/SEND_FAILED，
  //   真因原文即 message，界面直接上屏（不吞成"发送失败"四个字）。
  sendMedia: (channelId: string, externalUserId: string, filePath: string, name?: string) =>
    ipcCall<{ sent: true }>('im:sendMedia', { channelId, externalUserId, filePath, name }),

  // zx_20260930 M1: **只读**取件——「显形」的取字节那一步。
  //   失败按错误码抛出：NO_PATH/URL/NOT_ABSOLUTE/OUT_OF_ROOT/MISSING/OVERSIZE/UNSUPPORTED。
  //   界面据此**退回"件名+大小+打开"**（不认识就如实说不认识，不给一个加载不出来的控件）。
  mediaRead: (filePath: string) =>
    ipcCall<{ kind: 'image' | 'audio' | 'video'; mime: string; size: number; dataUrl: string }>('im:mediaRead', { filePath }),

  // 「打开」「另存」——同为只读出口，越界一律如实拒（理由码同上 + OPEN_FAILED/COPY_FAILED）。
  mediaOpen: (filePath: string) => ipcCall<{ ok: true }>('im:mediaOpen', { filePath }),

  // 「用户取消」不抛错（main 走 `data`）——取消是一次取舍结果，不是失败。
  mediaSave: (filePath: string, name?: string) =>
    ipcCall<{ saved: boolean; cancelled?: true; savedTo?: string }>('im:mediaSave', { filePath, name }),

  // zx_20260914 M1-3: **只读**未读（导航红点取初值）——与 `markRead` 同源同形、恒等，
  //   但**不写库**。未读只在 main 算一次，界面不自己记账（方案①"本地自增"已证有竞态）。
  unread: () => ipcCall<{ unread: number }>('im:unread'),

  // zx_20261003 M12: **逐渠道**未读（渠道行红点）——同为只读；未读账 main 一处算，界面不自算。
  unreadByChannel: () => ipcCall<{ byChannel: Record<string, number> }>('im:unreadByChannel'),

  // zx_20260912 M2-3: 「确实在看 IM」→ 未读归零（托盘角标唯一真源）
  // zx_20261002 M2: 传 `channelId` 只清**该渠道**；不传 = 全部已读。界面不自算未读，只报"在看哪条"。
  markRead: (channelId?: string) => ipcCall<{ unread: number }>('im:markRead', channelId),

  deleteChannel: (id: string) => ipcCall<{ id: string; deleted: boolean }>('im:deleteChannel', { id }),
};

// ===== Admin =====
export const admin = {
  health: () => ipcCall<Record<string, unknown>>('admin:health'),

  stats: () => ipcCall<Record<string, unknown>>('admin:stats'),

  users: () => ipcCall<Array<Record<string, unknown>>>('admin:users'),

  memories: (projectId?: string, type?: string) =>
    ipcCall<{ list: Array<Record<string, unknown>>; counts: Array<Record<string, unknown>> }>('admin:memories', { projectId, type }),

  deleteMemory: (id: string) => ipcCall<{ id: string; deleted: boolean }>('admin:deleteMemory', id),

  downweightMemory: (id: string) => ipcCall<{ id: string; downweighted: boolean }>('admin:downweightMemory', id),

  memoryHealth: (projectId?: string) =>
    ipcCall<{ total: number; typeCounts: Record<string, number>; avgConfidence: number; conflictCount: number; exemplarCount: number; prospectCount: number; draftCount: number; tripleCount: number }>('admin:memoryHealth', { projectId }),

  // zx_20261018_3 批一: 注入账的读者（注入 ≠ 主动引用，两本账各自可见）。
  memoryInjectionStats: (projectId?: string) =>
    ipcCall<{ injected: number; distinctMemories: number; usedTimes: number; completed: number; failed: number; pending: number }>('memory:injectionStats', { projectId }),

  markExemplar: (id: string) => ipcCall<{ id: string; marked: boolean }>('admin:markExemplar', id),

  // zx_20261012_1 批一（M29）: 记忆子系统失败计数快照（如实的排障口径）。**无 GUI 卡片**——供排障/诊断直取。
  memoryFailures: () => ipcCall<{ failures: Record<string, number> }>('memory:failures'),

  // zx_20260924_1 M6（F7）: 自省两本账（架构简化审查报表 / 自愈日志）由 admin:diagnostics 一并带出。
  //   此前这里的泛型没列这两字段，渲染层只能用 `as unknown as` 绕开——类型陈旧被强转掩盖住了。
  diagnostics: () =>
    ipcCall<{
      invariants: Array<Record<string, unknown>>;
      toolStats: Array<Record<string, unknown>>;
      failureClusters: Array<Record<string, unknown>>;
      simplification: SimplificationReport | null;
      selfHealing: HealingRecord[];
      // zx_20261016_3 批四（M34）：自产提案台账并进本唯一诊断出口（与上两本账同源）。
      proposals: SelfEvolveProposal[];
    }>('admin:diagnostics'),

  repairInvariant: (name: string) =>
    ipcCall<{ name: string; repaired: number; detail: string }>('admin:repairInvariant', { name }),

  // zx_20261016_3 批四（M34）：自产提案的**人工闸**（approve / reject / rollback）。
  //   ⚠ 只此一途——引擎侧**没有**任何定时/自动应用路径（红线：绝不自动改源码）。
  selfEvolveDecide: (id: string, decision: ProposalDecision, by?: string) =>
    ipcCall<{ id: string; status: string; detail: string }>('selfEvolve:decide', { id, decision, by }),

  // 决策动作词表**取自 main 侧真源**（不在此手抄一份会漂的镜像；`self-evolve.ts` 为零运行期 import 模块）。
  selfEvolveDecisions: PROPOSAL_DECISIONS,
};

// ===== Skill (记忆衍生技能草稿审批) =====
export const skills = {
  listDrafts: (projectId?: string) =>
    ipcCall<{ drafts: Array<{ id: string; name: string; description: string; steps: string[] }> }>('skills:listDrafts', { projectId }),

  approve: (draftId: string) =>
    ipcCall<{ name: string }>('skills:approve', { draftId }),

  reject: (draftId: string) =>
    ipcCall<{ rejected: boolean }>('skills:reject', { draftId }),

  list: () =>
    ipcCall<{ skills: Array<Record<string, unknown>> }>('skills:list'),
};

// ===== Task Template (B1: 任务模板管理) =====
export interface TemplateSubtask { title: string; description: string; acceptance_criteria: string }

/** M10 (zx_20261002): 自动模板质量门台账（主进程 `describeAutoTemplateGates` 的只读投影）。 */
export interface AutoTemplateGateReport {
  funnel: { parentTasks: number; autoDecomposed: number; terminal: number; candidates: number; groups: number };
  blockedAt: 'parent-tasks' | 'auto-decomposed' | 'terminal' | 'candidates' | 'groups' | null;
  gates: Array<{ archetype: string | null; total: number; success: number; rate: number; verdict: string }>;
  created: number;
}

export const templates = {
  list: () =>
    ipcCall<Array<Record<string, unknown>>>('template:list'),

  autoGate: () =>
    ipcCall<AutoTemplateGateReport>('template:auto-gate'),

  create: (body: { name: string; category?: string; description?: string; subtasks?: TemplateSubtask[]; keywords?: string[]; priority?: number }) =>
    ipcCall<{ id: string; name: string }>('template:create', body),

  update: (id: string, body: Partial<{ name: string; category: string; description: string; subtasks: TemplateSubtask[]; keywords: string[]; priority: number; status: string }>) =>
    ipcCall<{ id: string }>('template:update', { id, ...body }),

  delete: (id: string) =>
    ipcCall<{ id: string; status: string }>('template:delete', { id }),

  // zx_20260924: 与 task:create 同一份判据（`decideTemplateMatch`）——故须**分别**给标题与描述
  //   （创建时两者参与的门槛不同：标题 ≥2、描述 ≥3），并回传 skip（真创建时会不会拆）。
  test: (title: string, description?: string) =>
    ipcCall<{
      matched: { id: string; name: string; category: string; priority: number; success_rate: number | null; hitKeywords: string[]; method?: string; similarity?: number | null; field?: 'title' | 'description' | ''; subtaskCount: number } | null;
      skip: 'explicit_subtasks' | 'planning_intent' | null;
    }>('template:test', { title, description }),
};

// ===== Deliverable =====
export const deliverables = {
  // zx_20260930 M4-2: 真分页——`limit`/`offset` 显式传（缺省由 main 侧 `resolvePage` 兜到 PAGE_DEFAULT）。
  //   返回体由裸数组改为 `{ rows, total, retiredCount, limit, offset }`：`total`/`retiredCount` 均为
  //   **服务端按同一组筛选条件**算出的全量条数（`retiredCount` 供"已退休 N 项"提示，不得由当页长度冒充）。
  list: (projectId?: string, type?: string, keyword?: string, page?: { limit?: number; offset?: number }) =>
    ipcCall<{ rows: Array<Record<string, unknown>>; total: number; retiredCount: number; limit: number; offset: number }>('deliverable:list', { projectId, type, keyword, ...page }),

  // zx_20260930 M4-2: 下拉名录（项目/任务/无任务计数）——由服务端一次算清，**不是**"把列表整份读回来再筛"。
  //   分页后名录必须与页无关（否则选定项目后下拉自坍缩 = E15 复发），故与 `list` 分成两个出口。
  facets: () => ipcCall<{ projects: Array<{ id: string; name: string }>; tasks: Array<{ id: string; title: string | null }>; noTaskCount: number }>('deliverable:facets'),

  // zx_20260924_1 M5-c: 手工新建可选带 `taskId`（认领所属任务，可回溯）；不传仍为项目级（NULL）。
  //   端口名必须与 main 侧 `deliverable:create` 解构的键**逐字同形**（`{ projectId, name, type, description, filePath, taskId }`）。
  create: (projectId: string, name: string, type: string, description?: string, filePath?: string, taskId?: string) =>
    ipcCall<Record<string, unknown>>('deliverable:create', { projectId, name, type, description, filePath, taskId }),

  update: (id: string, name?: string, description?: string) =>
    ipcCall<Record<string, unknown>>('deliverable:update', { id, name, description }),

  runtime: (id: string) => ipcCall<Record<string, unknown>>('deliverable:runtime', id),

  register: (id: string) => ipcCall<{ id: string; registered: boolean }>('deliverable:register', id),

  // zx_20260908 M2(B2b): 主要成果标记切换
  setPrimary: (id: string, primary: boolean) =>
    ipcCall<{ id: string; is_primary: number; updated: boolean }>('deliverable:setPrimary', { id, primary }),

  // zx_20260914 M2-4(王阳明·知行合一): 验收有入口——把已有验收结论落到这一条成果上。
  //   `ok:false` 是**合法业务结果**(如 ctx 未核验)，故走返回值而非抛错；调用方据 reason 说清原因。
  accept: (id: string) =>
    ipcCall<{ ok: boolean; changed: number; reason?: string }>('deliverable:accept', { id }),

  // zx_20260914 M2-2: 图片成果就地预览（主进程读盘转 data URL；三种失败各自有 reason）
  previewImage: (id: string) =>
    ipcCall<{ dataUrl?: string; size?: number; mime?: string; unsupported?: boolean; reason?: string; limit?: number }>('deliverable:previewImage', { id }),
};

/** `deliverable:accept` 的 `reason` → 用户看得懂的说明（**一处映射**，列表行与抽屉共用）。 */
export const ACCEPT_REASON_TEXT: Record<string, string> = {
  disabled: '验收功能未启用（可在设置里打开「成果验收」）',
  not_found: '该成果不存在或已删除',
  not_acceptance_type: '该类型成果不参与验收（仅 doc / code 可标）',
  no_owning_task: '手工创建的成果没有产出任务，无从取得验收结论',
  ctx_not_verified: '该成果所属任务的验收尚未核验——验收标只能落"已有的验收结论"，不能凭空盖章',
  not_in_register: '该成果已退休或属临时探针，不在册',
  // zx_20260930 M3-c: `createDeliverable` 的**新建校验**新增两枚拒绝原因（文档不许标服务型、
  //   tools/modules/lib/plugins 下的模块不是服务入口）。main 另带更具体的 `message`，此处是**兜底标签**——
  //   缺这两行则 GUI 命中校验时落回裸代码（rr_zx_20260914 §③ 钉的正是"main 产出的原因必须都有话可说"）。
  doc_as_service: '文档（.md/.txt）不能标为服务型成果——请改用「文档」类型',
  module_as_service: '位于 tools/modules/lib/plugins 的是工具模块、不是服务入口——请改用「文档」类型',
  error: '打标时出错，请重试',
};

/** 通用 IPC 调用（未封装的通道使用）。
 *  zx_20260909 M5 实机复核修(A1): 此前多参被折叠成单一数组作为载荷——main 侧按位置参数接收的 handler(如 settings:set(_e,key,value))
 *  收到的 key=数组 → 静默写库失败 → Settings 各开关(成果组/免打扰/声音等)点了不持久、重进即复原。改为直接透传展开(单对象/多参均正确)。 */
export async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  return ipcCall<T>(channel, ...args);
}

/** ANS 列表的分页信封（zx_20260930 M15-⑤）。`rows` 是**本页**的条数，`total` 是**条件命中的全量**。 */
export interface AnsPage<T> { rows: T[]; total: number; limit: number | null; offset: number; has_more: boolean; }

// ===== Nodes（协同面板，zx_20261004 M4/M5/M6）=====
// 形状取自共享真源 `packages/shared-types/src/nodes.ts`（`AnsNode`/`NodePatch`），不在此手抄镜像。
/** `nodes:list`：群蚁一屏。`error` 非空 = 读不到 ANS，界面如实说原因而非报空。`gate` 见 M22 软闸。 */
export interface NodesListPayload { nodes: AnsNode[]; localNodeId: string; gate: TeamGate; error?: string; /** zx_20261011_3: 读台账失败的 HTTP 状态码（传输层失败为 0）——与 main 侧 `NodesListPayload` 同形。 */ errorStatus?: number; }
/** `nodes:card`：本机台账行（M6「自知者明」）。`node=null` 且无 `error` = 本机尚未注册。 */
export interface NodeCardPayload { localNodeId: string; node: AnsNode | null; gate: TeamGate; error?: string; }
/** `nodes:requests`：AI 终端调用记录（M13）。纯本地读（`wa_event_log` 聚合），不触网。 */
export interface NodeRequestsPayload { records: NodeCallRecord[]; }
/** zx_20261010_1 M2: `nodes:enroll` 返回——`enrolled` 入网态、`started`=心跳/中转是否已起（免重启生效的凭据）。 */
export interface NodeEnrollPayload { enrolled: boolean; nodeId: string; resourceGroup: string | null; started: boolean; note: string; }
/** `nodes:request-token`：只回成功与否 + 原因（**不回传全令牌**——面板无需展示，注册随即用它）。 */
export interface NodeRequestTokenPayload { ok: boolean; note: string; }
/**
 * `nodes:enroll-state`：本机入网态（纯本地读，不触 ANS）。`name` 供入职卡预填（zx_20261011 M8）。
 * zx_20261012: 增 `reason`——未入网的**首因**（`NodeEnrollmentReason` 一处真源）；入职卡据此说人话，
 *   而非把"凭据仍是内置占位"这类真相**静默**（用户只见 ANS 侧 403 刷屏、桌面侧无一言）。
 */
export interface NodeEnrollStatePayload { enrolled: boolean; hasToken: boolean; nodeId: string; name: string; reason: NodeEnrollmentReason; }
/** zx_20261011 M4: `nodes:dispatches`：本机**派出去**的活（出站台账）。纯本地读（`wa_event_log` 聚合），不触网。 */
export interface NodeDispatchesPayload { records: NodeDispatchRecord[]; }
/**
 * zx_20261011_4 M4: `nodes:orchestrate-mode`：本机编排模式 + **词表**（`modes` 由 main 一处真源给，
 *   渲染层不手抄 `off`/`auto`——后者是词表的第二个落点）。写口见 `nodes.setOrchestrateMode`。
 */
export interface OrchestrateModePayload { mode: string; modes: string[]; }
/**
 * zx_20261017_1 批三: `nodes:auto-dispatch`：**建单即派**开关 + 最近一次自动外派（审计账投影）。
 *   `enabled` 缺省关（main 只认显式 `'1'`）；`last` 为 `null` 即还没有过自动外派（不是"派失败"）。
 */
export interface LastAutoDispatchPayload { at: string; nodeId: string; requestId: string; category: string; }
export interface AutoDispatchPayload {
  enabled: boolean;
  /** 一次性引导是否已问过（zx_20261018_1 批一）——`false` 且 Team 已入网时，面板弹一次确认。 */
  prompted: boolean;
  last: LastAutoDispatchPayload | null;
}
// ===== Audit（团队审计视图，zx_20261017_1 批二）=====
// 行形状取 main 侧词表真源（`core/audit-labels.ts`，零 import ⇒ 渲染层也能运行期引它的词表）。
/** `audit:list`：三本账合成时间线（新审计账 / 设备控制 / 外部终端调用）。**过 Team 软闸**。 */
export interface AuditListFilter { limit?: number; offset?: number; action?: string; source?: AuditSource; }
export interface AuditListPayload { events: AuditEventRow[]; }
/** zx_20261018_3 批七：导出只吃筛选（limit/offset 不接）；`savedTo` 是真实落盘路径。 */
export interface AuditExportPayload { savedTo: string; rows: number; }
export const audit = {
  list: (filter?: AuditListFilter) => ipcCall<AuditListPayload>('audit:list', filter),
  exportCsv: (filter?: AuditListFilter) => ipcCall<AuditExportPayload>('audit:export', filter),
};

// ===== Team library（团队共享库，zx_20261017_1 批六）=====
// 形状同引 main core / shared-types 真源；页面不手抄第二份。
export type { TeamItem, TeamItemKind, LocalCandidates, LocalTeamItem };
export interface TeamItemsPayload {
  local: LocalCandidates;
  remote: TeamItem[];
  total: number;
  hasMore: boolean;
  localNodeId: string;
  /** 非空 = 读不到 ANS 的如实原因（列表为空不是"库里没有"）。 */
  error?: string;
}
export interface TeamImportResult { id: string; kind: TeamItemKind; target: string; }
/** 四个出口均过 Team `team_library` 闸；分享/导入/删除是**显式动作**（列表加载不写）。 */
export const team = {
  items: (filter?: { kind?: TeamItemKind; offset?: number }) =>
    ipcCall<TeamItemsPayload>('team:items', filter),
  share: (kind: TeamItemKind, localId: string) => ipcCall<TeamItem>('team:share', { kind, localId }),
  importItem: (item: TeamItem, projectId?: string | null) =>
    ipcCall<TeamImportResult>('team:import', { item, ...(projectId ? { projectId } : {}) }),
  remove: (id: string) => ipcCall<{ id: string; deleted: boolean }>('team:delete', { id }),
};

/** zx_20261023_5 批一：协同面板三分组 + 任务详情派单理由（形状取 main 真源，不手抄镜像）。 */
export type { DispatchBoardItem, DispatchBoardPayload, DispatchReasonLine, DispatchReasonView } from '../../../src/main/core/collab-dispatch.js';
import type { DispatchBoardPayload, DispatchReasonView } from '../../../src/main/core/collab-dispatch.js';

export const nodes = {
  list: () => ipcCall<NodesListPayload>('nodes:list'),
  /** 协同面板三分组：可派 / 等待依赖 / 上游已死（与真派同一把尺）。 */
  dispatchBoard: () => ipcCall<DispatchBoardPayload>('nodes:dispatch-board'),
  update: (nodeId: string, patch: NodePatch) => ipcCall<AnsNode>('nodes:update', { nodeId, patch }),
  // zx_20261011_3: 删除离线节点（写口，过 Team 软闸；ANS 侧硬删 + 吊销该节点 key）。
  remove: (nodeId: string) => ipcCall<{ node_id: string; removed: boolean }>('nodes:delete', { nodeId }),
  card: () => ipcCall<NodeCardPayload>('nodes:card'),
  requests: () => ipcCall<NodeRequestsPayload>('nodes:requests'),
  // zx_20261010_1 M2/M4: 「加入协同网络」三出口——就地注册 / 一键申请令牌 / 读入网态。
  // zx_20261011 M8（追加批）: 注册可带 `name`（首注册即取的名；不带则用本地已存名）。
  enroll: (token?: string, name?: string) => ipcCall<NodeEnrollPayload>('nodes:enroll', { ...(token ? { token } : {}), ...(name ? { name } : {}) }),
  requestToken: () => ipcCall<NodeRequestTokenPayload>('nodes:request-token'),
  enrollState: () => ipcCall<NodeEnrollStatePayload>('nodes:enroll-state'),
  // zx_20261011 M4: 「派活」三出口——派发（写口，过 Team 软闸）/ 出站台账（本地读）/ 读回终态（读口不过闸）。
  dispatch: (input: { category: string; payload?: Record<string, unknown>; targetNodeId?: string }) =>
    ipcCall<DispatchResult>('nodes:dispatch', input),
  dispatches: () => ipcCall<NodeDispatchesPayload>('nodes:dispatches'),
  dispatchResult: (id: string) => ipcCall<DispatchReadResult>('nodes:dispatch-result', { id }),
  // zx_20261011_1 M4（双向澄清）: 作答被派方的一问（**写口**，过 Team 软闸）。
  answerQuestion: (id: string, answer: string) => ipcCall<DispatchReadResult>('nodes:answer-question', { id, answer }),
  // zx_20261011_4 M4: 编排模式读/写（本机设置 `node.orchestrate_mode`；读口随带词表，写口非法值如实拒）。
  orchestrateMode: () => ipcCall<OrchestrateModePayload>('nodes:orchestrate-mode'),
  setOrchestrateMode: (mode: string) => ipcCall<{ mode: string }>('nodes:set-orchestrate-mode', { mode }),
  // zx_20261017_1 批三: 建单即派读/写（本机设置 `node.auto_dispatch_on_create`，**缺省关**）。
  autoDispatch: () => ipcCall<AutoDispatchPayload>('nodes:auto-dispatch'),
  setAutoDispatch: (enabled: boolean) => ipcCall<{ enabled: boolean }>('nodes:set-auto-dispatch', { enabled }),
  /** 首次入网后的**一次性引导**回答（Team 已解锁才可达；拒绝也算回答，不再打扰）。 */
  confirmAutoDispatch: (accept: boolean) => ipcCall<{ enabled: boolean; prompted: boolean }>('nodes:confirm-auto-dispatch', { accept }),
};

// ===== External（「门」·外部 AI 终端接入，zx_20261014_4 批二/批三）=====
// 形状取 main 侧真源（`core/external-terminals.ts` / `core/external-calls.ts` / `ipc/external.ipc.ts`），
// 仅类型引用（打包期擦除）。**凭据不经用户手**：`approve` 只回成功与否，明文只从门端点直发终端。
export const external = {
  /** 待审批申请——**带短码**（给人核对"来的真是这个东西"）。 */
  listPending: () => ipcCall<{ pending: PendingTerminalPublic[] }>('external:listPending'),
  /**
   * 全部终端（各态）+ **可授予能力词表**（`capabilities`，main 一处真源给；renderer 不手抄）。
   * zx_20261014_4 批三：词表**随此载荷**下发（`external-calls.js` 运行期拉 `node:crypto`/`child_process`
   *   ⇒ renderer 不能运行期引它，只能拿 main 算好的那份）。
   */
  list: () => ipcCall<ExternalListPayload>('external:list'),
  /** 点同意：铸发凭据（库只存 hash）+ 记被允许的能力。**不回**明文（罗尔斯·无知之幕）。 */
  approve: (pairingId: string, capabilities: string[]) => ipcCall<{ ok: true }>('external:approve', { pairingId, capabilities }),
  reject: (pairingId: string) => ipcCall<{ ok: true }>('external:reject', { pairingId }),
  /** 吊销一台已批准终端（其凭据**立即**失效）。 */
  revoke: (terminalId: string) => ipcCall<{ ok: true }>('external:revoke', { terminalId }),
  /**
   * zx_20261022_3 批五：**重新签发**「已批准、未送达」终端的凭据——旧钥匙立即作废，新钥匙只回终端一次。
   * ⚠ 已送达的终端不适用（会把它踢出门）；要换须先吊销再重新配对。回 `message` 是给用户看的下一步。
   */
  reissue: (terminalId: string) => ipcCall<{ ok: true; message?: string }>('external:reissue', { terminalId }),
  /** 门的实况：`enabled`=用户意图（库里的开关），`running`=真在监听——二者皆如实，不互相推断。 */
  status: () => ipcCall<InboundStatusPayload>('external:status'),
  /** 用户显式开/关（**真起、真停**监听 + 写 `node.external_inbound`）；锁定档下"开"被拒、"关"恒放行。 */
  setInbound: (enabled: boolean) => ipcCall<InboundStatusPayload>('external:setInbound', { enabled }),
  /** 外部终端**经门做过的事**留痕（`result` 记 `ok`/`denied`/`error`；**被拒也留痕**）。 */
  listCalls: (limit?: number) => ipcCall<{ calls: ExternalCallRow[] }>('external:listCalls', { limit }),
  // zx_20261023_5 批四：局域网发现（Team）。发现 ≠ 授权——列表只来自内存、30 秒无广播即散。
  /** 待接入列表；`running`/`error` 分开如实说"空"是没人还是看不见。 */
  lanList: () => ipcCall<LanPendingPayload>('external:lanList'),
  /** 点「接入」：把发现到的终端转成待批申请（之后走核对码 → 批准 → 钥匙只回一次）。 */
  lanRequest: (lanId: string) => ipcCall<{ pairingId: string; pairCode: string }>('external:lanRequest', { lanId }),
  /** 「忽略」：24 小时静默（不落终端台账——拒绝的是"出现"，不是"进门申请"）。 */
  lanIgnore: (lanId: string) => ipcCall<{ ok: true; silencedForMs: number }>('external:lanIgnore', { lanId }),
};

// ===== Devices（设备面板，zx_20261004 M9/M10）=====
// 形状取自 main 侧零依赖语义模块 `device-registry.ts`（`AnsDevice`/`DeviceActionRow`/`DeviceControlOutcome`）。
/** `devices:list`：台账 + 最近审计 + 发现是否在跑 + Team 档软闸（M22，面板据此禁用动作）。 */
export interface DevicesListPayload {
  devices: AnsDevice[];
  actions: DeviceActionRow[];
  /** zx_20261014_3 批一: `task_id` ⇒ 标题 + 所属项目名（**读时现查**；查无的 id 不在表里 ⇒ 面板回退 id 前缀）。 */
  taskRefs: Record<string, TaskRef>;
  /** zx_20261016_2 批三: `actor_ref` ⇒ 终端名（外部终端路来的留痕；**读时现查**，查无不进表）。 */
  terminalRefs: Record<string, string>;
  discoveryRunning: boolean;
  gate: TeamGate;
}
/**
 * zx_20261017_1 批八: 三方云（涂鸦）配置态。
 * ⚠ **没有 Secret 字段**——只说"已配/未配"；Secret 从不回渲染层。
 */
export interface CloudStatusPayload {
  configured: boolean;
  region: string;
  regionLabel: string;
  accessId: string;
  accessIdSet: boolean;
  secretSet: boolean;
  providerRegistered: boolean;
  /** 台账里 `protocol='cloud'` 的设备数（如实计数，非"厂商全部设备"）。 */
  deviceCount: number;
}
/** zx_20261018_1 批五：意图预览的回包（**零设备动作**，只落计划）。 */
export interface IntentPreviewPayload {
  planId: string;
  expiresIn: number;
  steps: IntentStep[];
  skipped: IntentSkip[];
}

/** zx_20261023_5 批三：渠道目录回包（**锁定的渠道不在 `channels` 里**——列表即权限）。 */
export interface DeviceChannelsPayload {
  channels: DeviceChannel[];
  gate: TeamGate;
}
/** zx_20261023_5 批三：渠道预检回包（`verdict.ok:false` 的 `reason` 直接上屏）。 */
export interface DeviceChannelAuthPayload {
  channelId: string;
  verdict: ChannelAuthorize;
  hasCredentials: boolean;
  gate: TeamGate;
}
/** zx_20261023_5 批三：miIO token 状态——**只有"有没有/是否密文"**，token 永不回渲染层。 */
export interface MiioTokenState {
  hasValue: boolean;
  encrypted: boolean;
  cipherAvailable: boolean;
}
/** 意图执行的逐步结果（`ok`=全成；任一步失败如实列在 `steps` 里，不回滚）。 */
export interface IntentExecutePayload {
  planId: string;
  status: 'executed' | 'failed';
  steps: Array<{ call_name: string; action: string; ok: boolean; result?: string; error?: string }>;
}
export const devices = {
  list: (auditLimit?: number) => ipcCall<DevicesListPayload>('devices:list', { auditLimit }),
  // zx_20261013_1 批五: MQTT 配置态（装了没/配了没，**不触网**）+ 并联发现（配了 broker 才连）。
  mqttStatus: () => ipcCall<MqttStatusPayload>('devices:mqtt_status'),
  discover: () => ipcCall<{ discoveryRunning: boolean; mqttEnabled?: boolean; haEnabled?: boolean; mqttErrors?: string[] }>('devices:discover'),
  stop: () => ipcCall<{ discoveryRunning: boolean }>('devices:stop'),
  authorize: (deviceId: string, authorized: boolean) => ipcCall<AnsDevice>('devices:authorize', { deviceId, authorized }),
  // zx_20261014_1 批二: 改名——写 `wa_devices.alias`（"我叫它什么"）；空串=清除别名（回到自述名）。
  rename: (deviceId: string, alias: string) => ipcCall<AnsDevice>('devices:rename', { deviceId, alias }),
  // zx_20261018_1 批三: 指派房间——写 `wa_devices.room`（显式数据）；空串=清除（回到未分配）。
  setRoom: (deviceId: string, room: string) => ipcCall<AnsDevice>('devices:set_room', { deviceId, room }),
  control: (deviceId: string, action: string, args?: Record<string, unknown>) =>
    ipcCall<DeviceControlOutcome>('devices:control', { deviceId, action, args }),
  // zx_20261018_1 批五: 意图演练两跳——预览只落计划（不碰设备）；执行认领那份固定计划（只执行一次）。
  intentPreview: (room: string, feeling: string) =>
    ipcCall<IntentPreviewPayload>('devices:intent_preview', { room, feeling }),
  intentExecute: (planId: string) => ipcCall<IntentExecutePayload>('devices:intent_execute', { planId }),
  // zx_20261017_1 批八: 三方云（涂鸦试点）——配置态只读不触网；Secret 只写不读。
  cloudStatus: () => ipcCall<CloudStatusPayload>('devices:cloud_status'),
  tuyaConfig: (cfg: { region?: string; accessId?: string; accessSecret?: string }) =>
    ipcCall<CloudStatusPayload>('devices:tuya_config', cfg),
  cloudSync: () => ipcCall<{ added: number; updated: number; total: number }>('devices:cloud_sync'),
  // zx_20261022_3 批三: 测试连接——用户显式动作；`ok:false` 也是结果（带 `detail` 说清答了什么）。
  test: (target: DeviceTestTarget, deviceId?: string) =>
    ipcCall<DeviceTestResult>('devices:test', { target, deviceId }),
  // zx_20261023_5 批三: 渠道目录 / 渠道预检 / 米家 token（读写都不回 token）。
  channels: () => ipcCall<DeviceChannelsPayload>('devices:channels'),
  channelAuth: (channelId: string) => ipcCall<DeviceChannelAuthPayload>('devices:channel_auth', { channelId }),
  miioToken: (address: string, token?: string) =>
    ipcCall<MiioTokenState>('devices:miio_token', token === undefined ? { address } : { address, token }),
};

// ===== License（许可与激活，zx_20261005 M8）=====
// 返回形状取 main 侧**零依赖真源** `core/license.ts`（`LicenseState`），仅类型引用，打包期擦除。
// zx_20261017_1 批五: `license:status` 在许可本体旁**并列**席位用量（`seatUsage` 一处算），
//   界面按此组合类型接收，不在前端另数一边。
export interface LicenseStatus extends LicenseState {
  seats: SeatUsage;
  /** 本档设备绑定上限（main 由 `licenseDeviceCap` 派生；界面只透传，不写死 3/20）。 */
  deviceCap: number;
}
export const license = {
  status: () => ipcCall<LicenseStatus>('license:status'),
  /** 激活：main 侧**验签通过才落库**；坏件抛 `IpcError('LICENSE_INVALID')`，`message` 即如实原因。 */
  activate: (licenseText: string) => ipcCall<LicenseStatus>('license:activate', licenseText),
  /** 定价与权益（zx_20261005 M11）——真源 `core/pricing.ts`（与 `feature-limits.ts` 同一把尺）；渲染层不自带价格。 */
  pricing: () => ipcCall<PricingPayload>('license:pricing'),
  /** 档位能力对照（zx_20261018_2 批五）——真源 `core/tier-catalog.ts`；`included` 与真实软闸同一判据。 */
  catalog: () => ipcCall<TierCatalogPayload>('license:catalog'),
  /** 档位用量（zx_20261022_3 批九）——真源 `core/tier-usage.ts`；项目/席位/并发复用既有计数。 */
  usage: () => ipcCall<TierUsagePayload>('license:usage'),
  /** zx_20261023_5 批五: 云端权益**只读缓存**（不发请求）——设置页据此显示同步结果/不可达原因。 */
  cloud: () => ipcCall<CloudEntitlementPayload>('license:cloud'),
  /** 手动重拉一次（main 侧 5 秒有界、失败 fail-open）；`reason` 为本次如实原因。 */
  cloudRefresh: () => ipcCall<CloudEntitlementPayload & { reason: string | null }>('license:cloud_refresh'),
  /** 应用版本（唯一真源 `app.getVersion()`）。 */
  appVersion: () => ipcCall<string>('app:version'),
};

// ===== ANS 端口/托管（zx_20261005 M21 / K-11）=====
// 缺省地址**单一真源**在 `@worker-ant/shared-types`（renderer 不直引，经 main 过桥——见 `ipc/ans.ipc.ts`）。
export const ans = {
  /** ANS 地址缺省真源（仅显示用 fallback / placeholder / 示例；含用户配置值请走 `settings:getAll`）。 */
  defaults: () => ipcCall<{ baseUrl: string }>('ans:defaults'),
  /** 当前生效地址 + 托管状态（`managed`/`pid`/`reason`）+ 凭据三态（`configured`/`isDev`，zx_20261005 M16）。 */
  status: () => ipcCall<{ baseUrl: string; managed: boolean; pid: number | null; reason: string; configured: boolean; isDev: boolean }>('ans:status'),
  /** 显式拉起本地 ANS（不可达且本地且有入口才起）；返回如实结果。 */
  start: () => ipcCall<{ started: boolean; reachable: boolean; reason: string }>('ans:start'),
  /** 停止**本进程拉起的** ANS。 */
  stop: () => ipcCall<{ stopped: boolean }>('ans:stop'),
};

// ===== 示例项目（zx_20261012_1 批四）=====
// 一键载入/删除示例内容，与真实数据隔离（`wa_projects.is_sample`）。真逻辑在 main 侧 `core/sample-project.ts`。
export const sample = {
  install: () => ipcCall<{ projectId: string; created: boolean }>('sample:install'),
  remove: () => ipcCall<{ removed: boolean }>('sample:remove'),
};

// ===== ANS Proxy（带 HMAC 签名）=====
export const ansProxy = {
  get: <T>(path: string) => ipcCall<T>('ans-proxy:get', path),
  /**
   * zx_20260930 M15-⑤: 带分页元数据的列表读取。
   * 与 `get` 的差别**只在能不能看见 `total`/`has_more`**：`ipcCall` 会把返回值剥一层 `.data`，
   * 而元数据是 `data` 的兄弟键，经 `get` 会一并被丢掉（界面于是分不清"就这么多"与"只给了前 100"）。
   */
  getPaged: <T>(path: string) => ipcCall<AnsPage<T>>('ans-proxy:getPaged', path),
  post: <T>(path: string, body?: unknown) => ipcCall<T>('ans-proxy:post', path, body),
  put: <T>(path: string, body?: unknown) => ipcCall<T>('ans-proxy:put', path, body),
  delete: <T>(path: string) => ipcCall<T>('ans-proxy:delete', path),
};
