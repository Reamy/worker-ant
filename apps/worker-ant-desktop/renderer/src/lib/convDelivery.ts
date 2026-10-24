/**
 * zx_20260920 M3（海德格尔·上手状态 / 维特根斯坦·意义即使用）:
 * 会话气泡的**送达态 × 在途态**——一处决定，收进可被受控复跑直接调用的纯函数。
 *
 * 病根（本轮 §1.3 的第三种沉默）: "正在补发中" 与 "没人在补发" 在界面上长得一模一样。
 * 用户点了补发，气泡一动不动，直到某次刷新才跳到结果——中间那段时间界面在**沉默**，
 * 而用户此时最需要知道的是"它在动"还是"它卡住了"。
 *
 * 定则：**四种沉默各有形状**——
 *   ① 收到（inbound）            → 不置一词（`null`）：收件不需要送达态。
 *   ② 已送达                     → 「已送达 12:34」绿。
 *   ③ 未送达                     → 「未送达 · <真原因>」红；原因没记到就如实说没记到。
 *   ④ 在途（重发 / 补发）         → 「重发中…」/「补发中…」琥珀色——**形状与③不同**，
 *      否则"点下去了"与"没点"无从分辨；上次失败的原因移入 `reason`（挂在 title 上，不占屏）。
 *
 * 抽取动机不是"代码好看"，是**它可测**：判据落在纯函数上，受控复跑跑的是**同一份真源**，
 * 而不是在测试里照抄一遍 if-else（承 feedback「往返/闭环判据须在生产入参上证」）。
 */

// zx_20260929 M7: 时刻与同一行的行首时间**必须同尺**——行首已改走 formatDbTime（本地），
// 此处再 `slice(11,16)` 取的是库内 UTC 串 ⇒ 同一行并排印出两个差 8 小时的时间。
import { formatDbTime } from './deliverable-view';

/** 本模块只读这几个字段——`Conversation` 的超集即可，不需要整行。 */
export interface ConvLike {
  id: string;
  direction: string;
  status?: string;
  last_error?: string;
  created_at?: string;
  /** 出站失败行关联的补发账 id；有它则"重试"走补发账那条路（`im:outboxRetry`）。 */
  outbox_id?: string;
}

/** 在途态：`idle` 无在途；`retrying` 走补发账（有 `outbox_id`）；`resending` 走单条重发。 */
export type ConvBusy = 'idle' | 'retrying' | 'resending';

export interface ConvDelivery {
  /** 屏上那句话 */
  label: string;
  /** 配色档：ok 绿 / bad 红 / busy 琥珀 */
  tone: 'ok' | 'bad' | 'busy';
  /** 在途时带上"上一次为什么没送到"——挂在 title，不占屏（无则不置） */
  reason?: string;
}

export interface ConvBusySets {
  /** 单条重发在途的**会话行 id**（`im:resend` 那条路；键是 conv.id） */
  resending: ReadonlySet<string>;
  /** 补发账在途的**补发账 id**（`im:outboxRetry` 那条路；键是 conv.outbox_id） */
  retryingOutbox: ReadonlySet<string>;
}

/**
 * 在途态判定。**顺序有意义**：一行若挂着 `outbox_id`，它的"重试"钮走的是补发账那条路，
 * 故 `retrying` 优先于 `resending`——否则同一个点击会在两个集合里各判一次，谁赢看运气。
 */
export function convBusyOf(c: ConvLike, sets: ConvBusySets): ConvBusy {
  if (c.direction !== 'outbound') return 'idle';
  const outboxId = (c.outbox_id || '').trim();
  if (outboxId && sets.retryingOutbox.has(outboxId)) return 'retrying';
  if (sets.resending.has(c.id)) return 'resending';
  return 'idle';
}

/**
 * 会话气泡右侧那句话。**返回 `null` = 不置一词**（inbound；或出站尚无任何可说的话）。
 * 调用方据此决定"要不要渲染这个 span"，不另判一份条件。
 */
export function convDeliveryOf(c: ConvLike, busy: ConvBusy = 'idle'): ConvDelivery | null {
  if (c.direction !== 'outbound') return null;
  const reason = (c.last_error || '').trim();
  if (busy === 'retrying') return { label: '补发中…', tone: 'busy', ...(reason ? { reason } : {}) };
  if (busy === 'resending') return { label: '重发中…', tone: 'busy', ...(reason ? { reason } : {}) };
  if (c.status === 'blocked_quota') {
    // zx_20260929 M8-c: 「发送条件缺失」——**也是没送到**，但话得说得更满一点：
    //   `failed` 是"这条这次真没发出去"（重试未必有用），本条是"等条件恢复就能送到"
    //   （配额窗口随用户下次入站刷新 / 登录态恢复）。两者在账上必须分得开，用户才知道**要不要等**。
    //   ⚠ 人机回话这条路**不自动补发**（D4：迟到的应答＝骚扰），故只说"可重发"，不说"重试中"。
    return { label: `未送达 · 等待条件恢复${reason ? ` · ${reason}` : ''}`, tone: 'bad' };
  }
  if (c.status === 'failed') return { label: `未送达${reason ? ` · ${reason}` : ' · 原因未记录'}`, tone: 'bad' };
  // zx_20260929 M8-c（本条的**第二半**，与上面那个新分支是同一件事）:
  //   原末行是"其余一切 ⇒ 已送达"——新状态值一旦写进库，**没在册的未送达态会被印成绿字「已送达」**，
  //   比今天更糟（本是没送到，界面反过来担保送到了）。故把话说死：只有 `sent`（或老行还没写该列，
  //   列默认值就是 `sent`）叫已送达；认不出的值如实说"认不出"，**绝不**替它说送到了。
  const status = c.status || 'sent';
  if (status !== 'sent') {
    return { label: `未送达 · 状态未识别（${status}）${reason ? ` · ${reason}` : ''}`, tone: 'bad' };
  }
  const hhmm = c.created_at ? formatDbTime(c.created_at, { timeOnly: true }) : '';
  return { label: `已送达${hhmm ? ` ${hhmm}` : ''}`, tone: 'ok' };
}
