/**
 * zx_20261104_3 M3「联」: 授权台的**保鲜词表一处真源**——`/inbox` 页与侧栏角标同引这份。
 *
 * 判据：三本账的写口各自落库后都会发一条既有事件（门态 / 设备发现与状态 / 跨机问答与收口）；
 *   命中即复取 `approval:inbox`。轮询只作崩溃/漏事件的兜底。
 */
export const APPROVAL_LIVE_TYPES = [
  'external.status_changed',   // 终端：申请到达 / 批准 / 拒绝 / 吊销
  'device.discovered',         // 设备：发现即入待授权
  'device.status_changed',     // 设备：授权开关变更
  'node.request_question',     // 跨机：对端发问
  'node.request_answered',     // 跨机：已作答
  'node.request_result',       // 跨机：收口（待答清单可能随之变化）
  'node.request_dispatched',   // 跨机：新派出一单
] as const;

/** 兜底轮询间隔（崩溃/漏事件时最迟这么久对齐一次）。 */
export const APPROVAL_POLL_MS = 15_000;
