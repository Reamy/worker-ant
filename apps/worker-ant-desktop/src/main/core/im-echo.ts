/**
 * zx_20261111_3「证」（维特根斯坦·意义即使用 / 道德经·信言不美）:
 *   IM 回执**自证**——「我把它理解成了什么」+ 一句可执行的纠正，以及 10 分钟撤销窗的判定。
 *
 * 病根：建单回执只说「已创建任务「X」（项目: P）」，**不说为什么把它当任务**；`markInboundDecision`
 *   把 `reason` 写进审计，用户看不到。理解错了也只能回电脑前处理（`BUILTIN_IM_COMMANDS` 七条里
 *   没有任何撤销/停止）。
 *
 * 三条纪律：
 *   ① **依据取路由自己的那一个 reason**——不在这里另写一份"为什么"（两处各说一遍迟早分家）。
 *   ② **只对改世界的动作回显**（建单/启动）；查询/闲聊/帮助不加这一行（说了也没得改）。
 *   ③ **承诺的能力必须真存在**：撤销只承诺"10 分钟内 + 还没开跑"这两条——做不到的（已在跑）
 *      如实拒绝并说清去哪处理（承 `feedback_promised_toggle_needs_gui_io`：不摆点了没用的路）。
 *
 * ⚠ 纯函数、零 IO、零时钟（`nowMs` 由调用方传入）：受控回归直引跑真实现。
 */

/** 撤销窗口：10 分钟。比确认窗（30 分钟）短——撤销是"刚发错马上改"，不是"过一会儿再想想"。 */
export const UNDO_WINDOW_MS = 10 * 60_000;

/** 撤销触发词（**不含「取消」**——那是对审批/确认问句的答复，抢了会改变既有语义）。 */
export const UNDO_COMMAND_RE = /^\s*[「“"]?(撤销|撤回)[」”"]?[\s。.!！]*$/;

export interface EchoDecision {
  intent: string;
  route: string;
  confidence: string;
  reason: string;
}

/**
 * 回执里那一行「我理解成…」。返回 `null` = 这条路由不该加（查询/闲聊/帮助/群聊拒绝/确认分支）。
 *
 * 建单一律带撤销指引；启动不带——"已经开始跑"没有撤回语义，写了等于许诺做不到的事。
 */
export function intentEcho(d: EchoDecision | null | undefined): string | null {
  if (!d) return null;
  if (d.route !== 'create' && d.route !== 'start') return null;
  if (d.intent === 'create_task') {
    return `我理解成：建任务（依据：${d.reason}）。不对就回「撤销」，10 分钟内有效。`;
  }
  if (d.intent === 'start_task') {
    return `我理解成：启动任务（依据：${d.reason}）。`;
  }
  return null;
}

export interface UndoEntry {
  taskId: string;
  /** 建单成功的时刻（毫秒）。 */
  at: number;
}

export type UndoVerdict =
  | { ok: true; taskId: string }
  | { ok: false; reason: 'none' | 'expired' };

/** 窗口判定：没有记录 ⇒ `none`；超窗 ⇒ `expired`。时钟由调用方给（判据不依赖真实墙钟）。 */
export function decideUndo(entry: UndoEntry | undefined | null, nowMs: number, windowMs = UNDO_WINDOW_MS): UndoVerdict {
  if (!entry || !entry.taskId) return { ok: false, reason: 'none' };
  const age = Number(nowMs) - Number(entry.at);
  if (!Number.isFinite(age) || age < 0 || age > windowMs) return { ok: false, reason: 'expired' };
  return { ok: true, taskId: entry.taskId };
}

/** 撤销被拒时的人话（`running` = 任务已经开跑，撤销窗口对"已经开始的事"无效）。 */
export function undoRefusalText(reason: 'none' | 'expired' | 'running' | 'gone'): string {
  if (reason === 'expired') return '超过 10 分钟了，撤销窗口已关闭；要处理请到任务详情。';
  if (reason === 'running') return '这条任务已经开始执行，不能撤销了；要停请到任务详情操作。';
  if (reason === 'gone') return '那条任务已经不在了（可能已被删除）。';
  return '没有可撤销的建单（撤销只覆盖最近一次通过 IM 创建的任务）。';
}
