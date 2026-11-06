/**
 * zx_20261018_2 批六「见新」（维特根斯坦·意义即用法 / 道德经·不出户知天下）:
 * **GUI 事件驱动刷新的三个发点**——把"变了"从"每 5/10 秒猜一次"改成"发生即说一声"。
 *
 * 病根：交付物运行态与「门」的待批/调用留痕此前**只能靠轮询**——用户点了启动要等下一拍才见绿点，
 *   外部终端来申请要等 5 秒才上屏；而轮询本身回答不了"此刻到底变没变"，只是**猜**。
 *
 * 三条纪律：
 *   ① **只发瞬态**（`emitTransient`）——运行态/门态/一次门内调用是**此刻的投影**，真相已在
 *      `wa_deliverables.status` / `wa_external_terminals` / `wa_external_calls`；进不可变事件日志只会洪泛。
 *   ② **发点即真源旁的薄壳**——不在这里做任何判断（是否真的变了由调用方在写库之后决定）。
 *   ③ 轮询**降级为兜底**（`renderer/src/lib/refresh.ts` 一处常量），管的是"崩溃/无人发事件"的情形。
 */
import { eventBus } from './event-bus.js';

/** 交付物运行态三态（与 `wa_deliverables.status` 的运行态词同一组；`via` 记是哪个动作触发的）。 */
export type DeliverableRuntimeState = 'running' | 'stopped' | 'failed';

/** 交付物**运行态**变了（启动 / 停止 / 进程退出）——`deliverable:start|stop` 与两处 `exit` 回调发。 */
export function emitDeliverableRuntimeChanged(
  deliverableId: string,
  state: DeliverableRuntimeState,
  via: string,
): void {
  void eventBus.emitTransient('deliverable.runtime_changed', {
    deliverableId,
    deliverable_id: deliverableId,
    state,
    via,
    ts: new Date().toISOString(),
  }).catch(() => { /* 广播失败不影响已落库的事实 */ });
}

/** 「门」的状态变了（开关 / 新待批 / 批准 / 拒绝 / 吊销）——人侧 IPC 与入站配对处发。 */
export function emitExternalStatusChanged(via: string, extra: Record<string, unknown> = {}): void {
  void eventBus.emitTransient('external.status_changed', {
    via,
    ts: new Date().toISOString(),
    ...extra,
  }).catch(() => { /* 广播失败不影响已落库的事实 */ });
}

/**
 * zx_20261023_5 批四：局域网里**看见了**一台 AI 终端（mDNS 广播到达）——面板的待接入列表据此即时刷新。
 * ⚠ 只报"看见"（id/名字/地址），**不报凭据**；这不是"接入"，更不是"授权"。
 */
export function emitLanTerminalSeen(terminal: { id: string; name: string; address: string }): void {
  void eventBus.emitTransient('external.lan_changed', {
    id: terminal.id,
    name: terminal.name,
    address: terminal.address,
    ts: new Date().toISOString(),
  }).catch(() => { /* 广播失败不影响内存里的待接入列表 */ });
}

/** 一次门内调用落账后的观察面（`external-calls` 只读到的四样；不透传参数与设备坐标）。 */
export interface ExternalCallObservation {
  terminalId: string;
  capability: string;
  result: string;
  reason?: string;
}

/** 门内调用落了账（含被拒）——`external-calls` 经注入的 `onCallRecorded` 回调往外发。 */
export function emitExternalCallRecorded(entry: ExternalCallObservation): void {
  void eventBus.emitTransient('external.call_recorded', {
    terminalId: entry.terminalId,
    terminal_id: entry.terminalId,
    capability: entry.capability,
    result: entry.result,
    reason: entry.reason ?? '',
    ts: new Date().toISOString(),
  }).catch(() => { /* 广播失败不影响已落库的留痕 */ });
}
