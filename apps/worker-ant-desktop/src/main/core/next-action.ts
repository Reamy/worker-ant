/**
 * zx_20261111_3「显」（道德经·少则得 / 维特根斯坦·意义即使用 / 毛选·没有调查没有发言权）:
 *   **第一行**的唯一真源——五页各自回答同一句话：「此刻是什么 / 凭什么这么说 / 下一步点哪个」。
 *
 * 病根：五个页面顶部只有标题与统计；任务详情 2556 行、设置 1280 行，用户得自己读完这一屏
 *   才知道"现在该我干什么"。"该我处理"的账其实有（`tasks:actionNeeded`），却只在全局铃铛里。
 *
 * 四条纪律：
 *   ① **只派生优先级，不取数**：入参是页面已经算好的事实（纯函数、零 IO、零时钟）。
 *   ② **取不到就说取不到**：任何一项读失败一律 `tone:'unknown'` 且写原因——不得回落成 `ok`，
 *      也不得用 0 冒充"没有"（"没读到"≠"确实是 0"）。
 *   ③ **一个动作**：`action` 至多一个；没有可做的事就没有按钮（不造动作）。
 *   ④ **说人话**：`headline` 不出现 `paused` / `pending` / `live` 这类内部键——那是给机器看的。
 *
 * 优先级次序**写死在本文件**（次序即优先级），调用方不得自行排序；每一档在 rr 里都有两只标本
 *   （该命中的 / 不得命中的）。
 */

import { durationText } from './duration-text.js';

export type NextActionTone = 'act' | 'waiting' | 'blocked' | 'ok' | 'unknown';

/** 动作 id——只表示"要做什么"，路由/回调由页面映射（core 不认识路由，也不认识 IPC 名字）。 */
export type NextActionId =
  | 'view_tasks'
  | 'answer_task'
  | 'start_task'
  | 'init_brief'
  | 'edit_project'
  | 'view_deliverables'
  | 'filter_unverified'
  | 'open_models'
  | 'open_settings';

export interface NextAction {
  /** 稳定键：rr 精确断言用，改文案不动它。 */
  key: string;
  tone: NextActionTone;
  /** 一句话：此刻是什么。 */
  headline: string;
  /** 一句依据：为什么这么说（只准引用入参里的真实值）。 */
  detail?: string;
  action?: { label: string; id: NextActionId };
}

/** 「多久没新进展」才算卡住。10 分钟：比看门狗（600s abort）宽一档，不致于把正常慢步报成卡死。 */
export const STALL_AFTER_MS = 10 * 60_000;

/** 非负整数；NaN/负数/非数 ⇒ 0（调用方已把"读不到"表达成 `loadError`，这里不再造第三种状态）。 */
function n(v: unknown): number {
  const x = Number(v);
  return Number.isFinite(x) && x > 0 ? Math.floor(x) : 0;
}

function unknownOf(key: string, reason: string): NextAction {
  return { key, tone: 'unknown', headline: `读不到：${reason}` };
}

// ────────────────────────────── 项目详情 ──────────────────────────────

export interface ProjectActionFacts {
  /** 取数失败的人话原因；非空 ⇒ unknown。 */
  loadError?: string | null;
  status?: string | null;
  /** 本项目**等你回复**的任务数（`tasks:actionNeeded` 中 kind=await_input 且属本项目）。 */
  awaiting?: number | null;
  /** 本项目近一天**执行失败**的任务数。 */
  failed?: number | null;
  /** 须知状态：`ready|failed|running|pending`（来自 `projects.brief`）。 */
  briefStatus?: string | null;
  /** 须知是否过期；`null` = 判不了（不当作过期，也不当作新鲜）。 */
  briefStale?: boolean | null;
  briefError?: string | null;
  /** 有工作目录或非空描述（重新生成须知的前提）。 */
  hasBriefSource?: boolean | null;
}

export function nextActionForProject(f: ProjectActionFacts | null | undefined): NextAction {
  if (!f) return unknownOf('project.unknown', '项目数据尚未载入');
  if (f.loadError) return unknownOf('project.unknown', f.loadError);

  const awaiting = n(f.awaiting);
  if (awaiting > 0) {
    return {
      key: 'project.awaiting',
      tone: 'act',
      headline: `有 ${awaiting} 件任务在等你回复`,
      detail: '不回，它们就停在那里不动',
      action: { label: '去回复', id: 'view_tasks' },
    };
  }

  const failed = n(f.failed);
  if (failed > 0) {
    return {
      key: 'project.failed',
      tone: 'act',
      headline: `有 ${failed} 件任务执行失败`,
      detail: '可重试或看失败原因',
      action: { label: '查看任务', id: 'view_tasks' },
    };
  }

  if (f.briefStale === true) {
    return {
      key: 'project.brief_stale',
      tone: 'act',
      headline: '项目说明变了，须知已过期',
      detail: '重新生成一次，后续任务才按新说明干活',
      action: { label: '重新生成', id: 'init_brief' },
    };
  }

  if (f.hasBriefSource === false) {
    return {
      key: 'project.no_source',
      tone: 'act',
      headline: '还差一步：写下项目说明',
      detail: '有说明或工作目录后，工蚁才知道这个项目是干什么的',
      action: { label: '编辑项目', id: 'edit_project' },
    };
  }

  if (f.briefStatus === 'failed') {
    return {
      key: 'project.brief_failed',
      tone: 'waiting',
      headline: '上次生成项目须知失败',
      ...(f.briefError ? { detail: f.briefError } : {}),
      action: { label: '再试一次', id: 'init_brief' },
    };
  }

  if (f.status === 'paused') {
    return { key: 'project.paused', tone: 'waiting', headline: '项目已暂停', detail: '恢复后才会继续派活' };
  }

  if (f.briefStatus === 'running') {
    return { key: 'project.brief_running', tone: 'waiting', headline: '正在生成项目须知' };
  }

  // ⚠ 刻意**不报**"还有 N 件没走完"：页面上唯一能拿到的是 `taskStats.total/completed`，
  //   而 `total - completed` 把**已归档**也算成"未完成"（真库实测：怡寿里 120 件里 21 件是归档件）。
  //   没有可靠的"未完成"数时，宁可只说"暂无待办"（= 没有需要你做/回的事），也不编一个 21。
  return { key: 'project.idle', tone: 'ok', headline: '暂无待办' };
}

// ────────────────────────────── 任务详情 ──────────────────────────────

export interface TaskActionFacts {
  loadError?: string | null;
  status?: string | null;
  /** 是否在等用户回复（页面按 `ctx.awaiting_input` / `[等待用户输入]` 既有判据算好）。 */
  awaitingInput?: boolean | null;
  /** 等的问题（截短后由页面给；有则进 detail）。 */
  awaitingQuestion?: string | null;
  /** `depBlockInfo` 的 state：`met|waiting|blocked|unresolved`。 */
  depState?: string | null;
  /** `depBlockInfo.text`（人话）。 */
  depText?: string | null;
  /** `task:get.execState`：`live|queued|ghost|idle|terminal`。 */
  execState?: string | null;
  /** 距最后一次进展的毫秒数；`null` = 不知道（不当作"刚刚"）。 */
  progressAgeMs?: number | null;
  /** 暂停成因的人话（`pauseReasonLabel` 已转好）；无则不给。 */
  pauseReason?: string | null;
}

export function nextActionForTask(f: TaskActionFacts | null | undefined): NextAction {
  if (!f) return unknownOf('task.unknown', '任务数据尚未载入');
  if (f.loadError) return unknownOf('task.unknown', f.loadError);

  const status = String(f.status ?? '');
  if (!status) return unknownOf('task.unknown', '任务状态未取得');

  if (f.awaitingInput === true) {
    return {
      key: 'task.awaiting_input',
      tone: 'act',
      headline: '这件任务在等你回复',
      ...(f.awaitingQuestion ? { detail: f.awaitingQuestion } : {}),
      action: { label: '去回复', id: 'answer_task' },
    };
  }

  if (f.depState === 'blocked' || f.depState === 'unresolved') {
    return {
      key: 'task.dep_blocked',
      tone: 'blocked',
      headline: '前置没完成，这件动不了',
      ...(f.depText ? { detail: f.depText } : {}),
    };
  }

  if (f.depState === 'waiting') {
    return {
      key: 'task.dep_waiting',
      tone: 'waiting',
      headline: '等前置完成后自动出发',
      ...(f.depText ? { detail: f.depText } : {}),
    };
  }

  if (f.execState === 'ghost') {
    return {
      key: 'task.ghost',
      tone: 'blocked',
      headline: '状态写着在跑，其实没有执行体',
      detail: '可直接重新开始，不会双跑',
      action: { label: '重新开始', id: 'start_task' },
    };
  }

  if (f.execState === 'live' || f.execState === 'queued') {
    const age = f.progressAgeMs;
    if (age != null && Number.isFinite(age) && Number(age) >= STALL_AFTER_MS) {
      return {
        key: 'task.stalled',
        tone: 'waiting',
        headline: `执行中，但已 ${durationText(Number(age))}没有新进展`,
        detail: '可能卡在某个步骤；再等等，或到任务里看最后一步',
      };
    }
    if (f.execState === 'queued') {
      return { key: 'task.queued', tone: 'waiting', headline: '已排队，等着开跑' };
    }
    return {
      key: 'task.running',
      tone: 'ok',
      headline: '执行中',
      ...(age != null && Number.isFinite(age) ? { detail: `最后进展 ${durationText(Number(age))}前` } : {}),
    };
  }

  if (status === 'failed') {
    return {
      key: 'task.failed',
      tone: 'act',
      headline: '执行失败',
      ...(f.pauseReason ? { detail: f.pauseReason } : {}),
      action: { label: '重试', id: 'start_task' },
    };
  }

  if (status === 'paused') {
    return {
      key: 'task.paused',
      tone: 'waiting',
      headline: '已暂停',
      ...(f.pauseReason ? { detail: f.pauseReason } : {}),
      action: { label: '继续', id: 'start_task' },
    };
  }

  if (status === 'pending') {
    return {
      key: 'task.pending',
      tone: 'act',
      headline: '还没开始',
      action: { label: '开始执行', id: 'start_task' },
    };
  }

  if (status === 'completed') return { key: 'task.completed', tone: 'ok', headline: '已完成' };
  if (status === 'archived') return { key: 'task.archived', tone: 'ok', headline: '已归档' };

  return { key: 'task.other', tone: 'ok', headline: '无需处理' };
}

// ────────────────────────────── 产出物管理 ──────────────────────────────

export interface DeliverableActionFacts {
  loadError?: string | null;
  /** 全部（未退休）成果数——服务端同一 scope 的计数。 */
  total?: number | null;
  /** 未验收件数（口径 = 页面徽标同一判据，见 `core/deliverable-attention.ts`）。 */
  unverified?: number | null;
  /** 验收展示是否开着（`deliverable.show_acceptance`）。关掉时不谈验收——那是用户主动不看的。 */
  acceptanceEnabled?: boolean | null;
}

export function nextActionForDeliverables(f: DeliverableActionFacts | null | undefined): NextAction {
  if (!f) return unknownOf('deliverable.unknown', '产出物数据尚未载入');
  if (f.loadError) return unknownOf('deliverable.unknown', f.loadError);
  if (f.total == null) return unknownOf('deliverable.unknown', '总量未取得');

  const total = n(f.total);

  if (total === 0) {
    return {
      key: 'deliverable.empty',
      tone: 'act',
      headline: '还没有产出物',
      detail: '任务跑完后，成果会集中在这里',
      action: { label: '查看任务', id: 'view_tasks' },
    };
  }

  // 验收展示关掉时，**不说"均已验收"**——那不是我们知道的（用户把这项关了，页面上根本没有验收信息）。
  if (f.acceptanceEnabled === false) {
    return { key: 'deliverable.ok', tone: 'ok', headline: `${total} 件产出物`, detail: '验收展示已在设置里关闭' };
  }

  const unverified = n(f.unverified);
  if (unverified > 0) {
    // 不给按钮：页内没有"只看未验收"的筛选（不造一个点了没用的动作），只在行上标出来。
    return {
      key: 'deliverable.unverified',
      tone: 'act',
      headline: `有 ${unverified} 件成果还没验收`,
      detail: '验收过的成果才算"已交付"',
    };
  }

  return { key: 'deliverable.ok', tone: 'ok', headline: `${total} 件产出物，均已验收` };
}

// ────────────────────────────── AI 模型管理 ──────────────────────────────

export interface ModelActionFacts {
  loadError?: string | null;
  /** 读模型列表的三态（`core/model-availability.ts` 的 `ModelsRead`）。 */
  read?: 'ok' | 'auth' | 'error' | null;
  readNote?: string | null;
  /** 有可用且含 chat 能力的模型。 */
  hasChat?: boolean | null;
  /** 有可用端点（`available === true`）的模型数。 */
  available?: number | null;
  /** 目录条数。 */
  catalog?: number | null;
}

export function nextActionForModels(f: ModelActionFacts | null | undefined): NextAction {
  if (!f) return unknownOf('model.unknown', '模型数据尚未载入');
  if (f.loadError) return unknownOf('model.unknown', f.loadError);
  if (f.read && f.read !== 'ok') {
    return unknownOf('model.unknown', f.readNote || (f.read === 'auth' ? 'ANS 未认证' : 'ANS 未连接'));
  }
  if (f.hasChat === true) {
    return {
      key: 'model.ok',
      tone: 'ok',
      headline: `可用模型 ${n(f.available)} 个`,
      detail: `目录 ${n(f.catalog)} 条（含未配端点者）`,
    };
  }
  return {
    key: 'model.no_chat',
    tone: 'act',
    headline: '没有可用的对话模型',
    detail: '任务跑不起来：先加一个供应商与端点，再启用一个对话模型',
    action: { label: '去配置模型', id: 'open_models' },
  };
}

// ────────────────────────────── 系统设置 ──────────────────────────────

export interface SettingsActionFacts {
  /** ANS 配置三态（页面已有的 `ansStatus`）。 */
  ans?: 'configured' | 'unconfigured' | 'unknown' | null;
  ansNote?: string | null;
  /** 全局默认模型名；空串 = 未指定（自动选型）；`null` = 没取到。 */
  defaultModel?: string | null;
}

export function nextActionForSettings(f: SettingsActionFacts | null | undefined): NextAction {
  if (!f) return unknownOf('settings.unknown', '设置尚未载入');
  if (!f.ans || f.ans === 'unknown') {
    return unknownOf('settings.unknown', f.ansNote || 'ANS 状态未取得');
  }
  if (f.ans === 'unconfigured') {
    return {
      key: 'settings.ans_unconfigured',
      tone: 'act',
      headline: '还差一步：配好 ANS',
      detail: '填上地址与密钥，模型匹配、技能同步、跨机协同才有来源',
      action: { label: '去配置', id: 'open_settings' },
    };
  }
  if (f.defaultModel == null) {
    return unknownOf('settings.unknown', '默认模型未取得');
  }
  if (!f.defaultModel) {
    return {
      key: 'settings.ok',
      tone: 'ok',
      headline: '一切就绪',
      detail: '未指定默认模型，按自动选型挑',
    };
  }
  return { key: 'settings.ok', tone: 'ok', headline: '一切就绪', detail: `默认模型：${f.defaultModel}` };
}
