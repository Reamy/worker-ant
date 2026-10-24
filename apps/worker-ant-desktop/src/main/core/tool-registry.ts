/**
 * 工具注册中心 — 统一工具元数据（分类/只读/权限级别/配额）。
 *
 * 借鉴 Claude Code Tool.ts + 归档版 tool-registry.ts：
 *  - 工具实现仍由 agent-executor.buildTools 组装（闭包依赖 ctx/taskId/workingDir），
 *  - 元数据集中在此，供配额/审批/沙箱/过滤统一治理。
 */
import type { Tool } from 'ai';

export type ToolCategory = 'readonly' | 'write' | 'control' | 'shell' | 'memory' | 'resource' | 'media' | 'device';
export type PermissionLevel = 'normal' | 'privileged';

export interface ToolQuota {
  soft: number;
  hard: number;
  softMsg: string;
  hardMsg: string;
}

export interface ToolMeta {
  name: string;
  category: ToolCategory;
  /** 只读工具：无写入副作用，可用于 Step1/严格模式 */
  isReadOnly: boolean;
  /** 权限级别：normal 无需审批；privileged 需 ask_user 审批（run_privileged） */
  permissionLevel: PermissionLevel;
  description: string;
  /** 调用配额（软/硬限制 + 提示），缺省表示不限 */
  quota?: ToolQuota;
  /**
   * 共账键：同一 `quotaKey` 的工具**共用一本配额账**（缺省 = 工具名，即各自一本）。
   * ⚠ 与 `quota` 成对：只填 `quotaKey` 而不共享 `quota` 对象，账就归了口径没归。
   */
  quotaKey?: string;
}

/**
 * 探索类 shell 命令的**一本账**（zx_20260916_3 M5 / O-H；D4 已裁定「合为一本账」）。
 *
 * 病根：`execute_command` 与 `bash` 此前**各带一份** `soft:12, hard:20` 且文案各起一个名字
 * （`[配额]` / `[bash配额]`）——同一个约束两本独立账。实测有效探索配额翻倍：日志里 14:08
 * `[bash配额]` 软告警之后，**同一批工作于 15:20 经 `execute_command` 照常继续**。
 * ⇒ 阈值与文案**一处定义**，两条 meta 引用同一个对象（连对象身份都相同，不是"抄得一样"）。
 * 归一后执行体实际可用的探索量 = **20**（原为 12 + 20 = 32）——收紧是 D4 裁定的代价③，见方案 §10.1。
 */
export const SHELL_EXPLORE_QUOTA_KEY = 'shell_explore';
export const SHELL_EXPLORE_QUOTA: ToolQuota = {
  soft: 12,
  hard: 20,
  softMsg: '[探索配额] 探索类命令已调用 12 次（bash 与 execute_command 共用这一本账；跑测试/构建/git 提交等收尾命令不计入）。立即停止探索——用 write_file 直接写入产出文件。',
  hardMsg: '[探索配额告警] 探索类命令已调用 20 次（bash 与 execute_command 共用这一本账；收尾命令不计入），已达上限：探索类调用将被拒绝（跑测试/构建/git 提交等收尾命令照常放行）。请立即用 write_file 保存成果，不要再执行探索命令。',
};

/**
 * 配额账 —— **按 `quotaKey` 一本账**（zx_20260916_3 M5 / O-H）。
 *
 * 生产每次 `executeTask` 里 `new` 一个；**内存态**（跨恢复/重启会重置，属既有限制，D4 归一并未改变它——
 * 如实登记，不谎称已解决）。抽成类是为了让受控回归**直跑真账本**（"值从 0 变 1"这类正面断言只有在真实现上
 * 才算数），而不是在测试里复刻一份计数逻辑。
 */
export class ExploreQuotaLedger {
  private readonly counts = new Map<string, number>();
  private readonly softWarned = new Set<string>();

  /** 计入一次"吃额度"的调用；返回计入后该账的计数 */
  add(quotaKey: string): number {
    const n = (this.counts.get(quotaKey) || 0) + 1;
    this.counts.set(quotaKey, n);
    return n;
  }

  count(quotaKey: string): number {
    return this.counts.get(quotaKey) || 0;
  }

  /**
   * 该账此刻该触发的动作（动作的落点——写库/禁用工具——留在调用侧）。
   *
   * 软警告**每账至多一次**：原实现靠 `count === soft` 的**恰好相等**来保证只响一次，一旦某一步里
   * 跨过 12（同一步发出多个探索调用）就整条漏掉——与本轮"判据只认恰好那一刻的样子"同一形状，故改为 `>=`
   * 并用 `softWarned` 兜住只响一次。
   * 到硬线时**不再补软告警**：硬告警更强且已说明「一并禁用」，两句同一步发出只是噪音（不是漏报）。
   */
  gate(quotaKey: string, limit: ToolQuota): { softMsg?: string; hard: boolean } {
    const n = this.count(quotaKey);
    if (n >= limit.hard) return { hard: true };
    if (n >= limit.soft && !this.softWarned.has(quotaKey)) {
      this.softWarned.add(quotaKey);
      return { softMsg: limit.softMsg, hard: false };
    }
    return { hard: false };
  }
}

/**
 * 63 个工具的元数据表（zx_20260914 M2-5b 订正：原写 `47`，已漂移 9 个；M3-1 新增 `list_skills` → 56+1；
 * zx_20260921 M5 新增 `view_image` / `read_document` → 57+2；zx_20261004 M8 新增
 * `list_devices` / `device_status` / `device_control` → 59+3；zx_20261018_1 批五新增 `device_intent` → 62+1）。
 *
 * `list_skills` 须在册：`toolRegistry.listReadOnlyNames()` 供 Step1 只读工具集派生（agent-executor），
 * 缺登即被剔出只读步——而「开跑第一步先看看有哪些技能」正是只读步最需要的场景。
 *
 * 本数字**必须等于 `TOOL_METAS.length`**。上一轮曾据"表里少 4 条"立项要来补，
 * 实测是**数错了**——`bash`/`execute_command`/`search_web`/`read_web` 本就在表内，
 * 只是 `name:` 独占一行（多行条目），按单行模式 grep 会漏掉恰好这 4 条。
 * 故 rr 断言**不写死数字**，直接比对运行期的 `TOOL_METAS.length`——写死只是把漂移推迟到下一次。
 *
 * 分类语义：
 *  - readonly 只读查询（读文件/查任务/搜索/列目录/列偏好）
 *  - write   写入修改（写文件/改文件/记忆写入/交付物/偏好）
 *  - control 流程控制与审批（询问用户/完成任务/建任务/计划模式/中断/子代理通信）
 *  - shell   命令执行（execute_command/bash/git_clone/run_privileged）
 *            · `execute_command` = 通用命令（**可 `cd`、可写**）；不支持 `&&`/`;`/`|` 等分隔符
 *            · `bash`             = **只读**白名单命令；**支持 `|` 管道**；不支持 `;`/`&`/`cd`/重定向
 *            · 两者 cwd 均已是任务项目目录（一般无需 `cd`），写文件走 `write_file`/`edit_file`
 *            （zx_20260915 M5/P0-7：分工写进两把工具的 `description`，此处为类目侧的同一口径）
 *  - memory  记忆检索（项目记忆/知识图谱）
 *  - resource 外部资源与多代理（模型/MCP/网络/技能/子代理/辩论/招募）
 *  - media   媒体与文档**内容**按需读（读图 / 抽 PDF 正文）——zx_20260921 M5 新增。
 *            **为何不复用 `readonly`**：`readonly` 是六档全含的底线类目（见 `task-archetype.ts`
 *            `ARCHETYPE_TOOL_CATEGORIES` 前的底线注记），把这两件塞进去等于**六档全在**，
 *            与 `narrowToolFace` 的收窄意图相抵（"到处都在 = 等于没收窄"）。单开一类才能只给该给的档。
 *  - device  局域网设备**读与控**（列台账 / 读状态 / 下控制命令）——zx_20261004 M8 新增。
 *            同 media 之由：不塞进 `readonly`（否则六档全在），单开一类才能只给该给的档
 *            （`task-archetype.ts` 里只给 `configuration` 与 `code` 两档——"配得上/AI 终端"场景）。
 *            ⚠ `device_control` 虽在 `write` 类语义上是写，但 `category` 记 `device`（同 `run_privileged`
 *            那样：`permissionLevel` 与 `category` 是两条轴，不互相顶替）——能否执行另由 K-6 闸裁定。
 */
export const TOOL_METAS: ToolMeta[] = [
  // readonly
  { name: 'read_file', category: 'readonly', isReadOnly: true, permissionLevel: 'normal', description: '读取文件' },
  { name: 'file_retrieval', category: 'readonly', isReadOnly: true, permissionLevel: 'normal', description: '检索文件内容' },
  { name: 'get_current_time', category: 'readonly', isReadOnly: true, permissionLevel: 'normal', description: '获取当前时间' },
  { name: 'list_project_tasks', category: 'readonly', isReadOnly: true, permissionLevel: 'normal', description: '列出项目任务' },
  { name: 'get_project_info', category: 'readonly', isReadOnly: true, permissionLevel: 'normal', description: '获取项目信息' },
  { name: 'task_get', category: 'readonly', isReadOnly: true, permissionLevel: 'normal', description: '获取任务详情' },
  { name: 'search_content', category: 'readonly', isReadOnly: true, permissionLevel: 'normal', description: '搜索文件内容' },
  { name: 'list_files', category: 'readonly', isReadOnly: true, permissionLevel: 'normal', description: '列出目录文件' },
  { name: 'list_agents', category: 'readonly', isReadOnly: true, permissionLevel: 'normal', description: '列出可用子代理' },
  { name: 'list_my_preferences', category: 'readonly', isReadOnly: true, permissionLevel: 'normal', description: '列出用户偏好' },

  // media
  { name: 'view_image', category: 'media', isReadOnly: true, permissionLevel: 'normal', description: '查看盘上图片的元数据（尺寸/格式/字节数）' },
  { name: 'read_document', category: 'media', isReadOnly: true, permissionLevel: 'normal', description: '抽取 PDF 正文' },

  // write
  { name: 'write_file', category: 'write', isReadOnly: false, permissionLevel: 'normal', description: '写入文件内容' },
  { name: 'edit_file', category: 'write', isReadOnly: false, permissionLevel: 'normal', description: '精确替换文件片段' },
  { name: 'update_project_terms', category: 'write', isReadOnly: false, permissionLevel: 'normal', description: '更新项目术语' },
  { name: 'update_memory', category: 'write', isReadOnly: false, permissionLevel: 'normal', description: '更新记忆' },
  { name: 'save_memory', category: 'write', isReadOnly: false, permissionLevel: 'normal', description: '保存记忆' },
  { name: 'merge_memories', category: 'write', isReadOnly: false, permissionLevel: 'normal', description: '合并记忆' },
  { name: 'remember_preference', category: 'write', isReadOnly: false, permissionLevel: 'normal', description: '记住用户偏好' },
  { name: 'forget_preference', category: 'write', isReadOnly: false, permissionLevel: 'normal', description: '遗忘用户偏好' },
  { name: 'create_deliverable', category: 'write', isReadOnly: false, permissionLevel: 'normal', description: '创建交付物' },
  { name: 'register_deliverable', category: 'write', isReadOnly: false, permissionLevel: 'normal', description: '注册交付物' },
  { name: 'mark_exemplar', category: 'write', isReadOnly: false, permissionLevel: 'normal', description: '标记范例' },

  // control
  { name: 'ask_user', category: 'control', isReadOnly: false, permissionLevel: 'normal', description: '询问用户（暂停任务）' },
  { name: 'complete_investigation', category: 'control', isReadOnly: false, permissionLevel: 'normal', description: '完成调查' },
  { name: 'finalize_task', category: 'control', isReadOnly: false, permissionLevel: 'normal', description: '完成任务' },
  { name: 'create_task', category: 'control', isReadOnly: false, permissionLevel: 'normal', description: '创建子任务' },
  { name: 'update_task_status', category: 'control', isReadOnly: false, permissionLevel: 'normal', description: '更新任务状态' },
  { name: 'escalate_to_human', category: 'control', isReadOnly: false, permissionLevel: 'normal', description: '升级到人工' },
  { name: 'enter_plan_mode', category: 'control', isReadOnly: false, permissionLevel: 'normal', description: '进入计划模式' },
  { name: 'exit_plan_mode', category: 'control', isReadOnly: false, permissionLevel: 'normal', description: '退出计划模式' },
  { name: 'interrupt', category: 'control', isReadOnly: false, permissionLevel: 'normal', description: '中断任务' },
  { name: 'decide', category: 'control', isReadOnly: false, permissionLevel: 'normal', description: '多代理决策' },
  { name: 'send_message_to_task', category: 'control', isReadOnly: false, permissionLevel: 'normal', description: '向任务发消息' },

  // shell
  {
    name: 'execute_command',
    category: 'shell',
    isReadOnly: false,
    permissionLevel: 'normal',
    description: '执行命令',
    // zx_20260916_3 M5: 与 `bash` **同一本账、同一份文案**（D4 裁定）——不是两份抄得一样的定义。
    quota: SHELL_EXPLORE_QUOTA,
    quotaKey: SHELL_EXPLORE_QUOTA_KEY,
  },
  {
    name: 'bash',
    category: 'shell',
    isReadOnly: false,
    permissionLevel: 'normal',
    description: '执行只读 shell 命令',
    quota: SHELL_EXPLORE_QUOTA,
    quotaKey: SHELL_EXPLORE_QUOTA_KEY,
  },
  { name: 'git_clone', category: 'shell', isReadOnly: false, permissionLevel: 'normal', description: '克隆仓库' },
  { name: 'run_privileged', category: 'shell', isReadOnly: false, permissionLevel: 'privileged', description: '用户批准后执行特权命令' },

  // memory
  { name: 'search_project_memory', category: 'memory', isReadOnly: true, permissionLevel: 'normal', description: '搜索项目记忆' },
  { name: 'search_knowledge_graph', category: 'memory', isReadOnly: true, permissionLevel: 'normal', description: '搜索知识图谱' },
  { name: 'remember_intent', category: 'memory', isReadOnly: false, permissionLevel: 'normal', description: '登记前瞻记忆（未来要做的事）' },
  { name: 'list_intents', category: 'memory', isReadOnly: true, permissionLevel: 'normal', description: '列出待办前瞻记忆' },
  { name: 'note_working_context', category: 'memory', isReadOnly: false, permissionLevel: 'normal', description: '记录任务工作记忆（临时情境）' },
  { name: 'register_unknown', category: 'memory', isReadOnly: false, permissionLevel: 'normal', description: '登记知识盲区' },
  { name: 'list_unknowns', category: 'memory', isReadOnly: true, permissionLevel: 'normal', description: '列出知识盲区' },
  { name: 'register_negative', category: 'memory', isReadOnly: false, permissionLevel: 'normal', description: '登记负空间记忆' },
  { name: 'list_negatives', category: 'memory', isReadOnly: true, permissionLevel: 'normal', description: '列出负空间记忆' },
  { name: 'list_skill_drafts', category: 'memory', isReadOnly: true, permissionLevel: 'normal', description: '列出待审批技能草案' },
  { name: 'propose_skill', category: 'memory', isReadOnly: false, permissionLevel: 'normal', description: '提出技能草案' },

  // resource
  { name: 'find_best_model', category: 'resource', isReadOnly: true, permissionLevel: 'normal', description: '查找最优模型' },
  { name: 'find_mcp_service', category: 'resource', isReadOnly: true, permissionLevel: 'normal', description: '查找 MCP 服务' },
  { name: 'call_mcp_tool', category: 'resource', isReadOnly: false, permissionLevel: 'normal', description: '调用 MCP 工具' },
  {
    name: 'search_web',
    category: 'resource',
    isReadOnly: true,
    permissionLevel: 'normal',
    description: '搜索网络',
    quota: { soft: 3, hard: 5, softMsg: '[搜索配额] 已搜索3次。若结果为空说明网络不可用，直接基于训练知识撰写报告。', hardMsg: '[搜索配额耗尽] 搜索已禁用，必须基于训练知识直接输出。' },
  },
  {
    name: 'read_web',
    category: 'resource',
    isReadOnly: true,
    permissionLevel: 'normal',
    description: '抓取网页内容',
    quota: { soft: 5, hard: 8, softMsg: '[抓取配额] 已抓取5次网页。请聚焦核心内容，避免过度抓取。', hardMsg: '[抓取配额耗尽] 抓取已禁用。请基于已有内容直接产出。' },
  },
  { name: 'list_skills', category: 'resource', isReadOnly: true, permissionLevel: 'normal', description: '列出可用技能（含来源分类）' },
  { name: 'skill', category: 'resource', isReadOnly: false, permissionLevel: 'normal', description: '执行技能' },
  { name: 'spawn_subagent', category: 'resource', isReadOnly: false, permissionLevel: 'normal', description: '派生子代理' },
  { name: 'spawn_debate', category: 'resource', isReadOnly: false, permissionLevel: 'normal', description: '发起辩论' },
  { name: 'recruit_swarm', category: 'resource', isReadOnly: false, permissionLevel: 'normal', description: '招募协作组' },

  // device
  { name: 'list_devices', category: 'device', isReadOnly: true, permissionLevel: 'normal', description: '列出局域网设备台账' },
  { name: 'device_status', category: 'device', isReadOnly: true, permissionLevel: 'normal', description: '读取设备授权态与状态快照' },
  // ⚠ `device_control` 的 `category` 是 `device` 而非 `write`（见上方分类语义注记）；能否执行由 K-6
  //   `deviceControlVerdict` 裁定（未授权只可读、门锁/安防即便授权也拒），非本表权限级别所辖。
  { name: 'device_control', category: 'device', isReadOnly: false, permissionLevel: 'normal', description: '控制设备（须先授权）' },
  // zx_20261018_1 批五: 意图路（房间+感受 → 计划 → 执行）。与 `device_control` 同属 `device` 类，
  //   档位面**不新开类目**（conversation 档的工具面不因此放宽）。
  { name: 'device_intent', category: 'device', isReadOnly: false, permissionLevel: 'normal', description: '按房间+感受执行家居舒适意图（home.comfort）' },
];

class ToolRegistry {
  private tools = new Map<string, Tool>();
  private metas = new Map<string, ToolMeta>();

  constructor() {
    for (const meta of TOOL_METAS) {
      this.metas.set(meta.name, meta);
    }
  }

  /** 注册工具实现（由 buildTools 组装时调用） */
  registerTool(name: string, tool: Tool): void {
    this.tools.set(name, tool);
  }

  getMeta(name: string): ToolMeta | undefined {
    return this.metas.get(name);
  }

  getQuota(name: string): ToolQuota | undefined {
    return this.metas.get(name)?.quota;
  }

  /** 该工具计入哪本配额账（缺省 = 工具名）——同 key 的工具**共用一本账**。 */
  quotaKeyOf(name: string): string {
    return this.metas.get(name)?.quotaKey ?? name;
  }

  /**
   * 与该工具**同账**的全部在册工具名（含自身）。
   * 硬禁用必须按此**一并禁用**：只禁被调用的那一个，同账的另一半仍能继续吃这本账 —— 账等于没归成一本。
   */
  quotaKeyPeers(name: string): string[] {
    const key = this.quotaKeyOf(name);
    return TOOL_METAS.filter((m) => (m.quotaKey ?? m.name) === key).map((m) => m.name);
  }

  isReadOnly(name: string): boolean {
    return this.metas.get(name)?.isReadOnly ?? false;
  }

  isPrivileged(name: string): boolean {
    return this.metas.get(name)?.permissionLevel === 'privileged';
  }

  /** 列出只读工具名（供 Step1 只读限制） */
  listReadOnlyNames(): string[] {
    return TOOL_METAS.filter(m => m.isReadOnly).map(m => m.name);
  }

  /** 列出所有工具名 */
  listNames(): string[] {
    return TOOL_METAS.map(m => m.name);
  }

  /** 按分类列出工具名 */
  listNamesByCategory(): Record<ToolCategory, string[]> {
    const result: Record<string, string[]> = {};
    for (const meta of TOOL_METAS) {
      (result[meta.category] ??= []).push(meta.name);
    }
    return result as Record<ToolCategory, string[]>;
  }
}

export const toolRegistry = new ToolRegistry();
