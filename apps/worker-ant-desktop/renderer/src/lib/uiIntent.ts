/**
 * zx_20260912 M3(管子·度量衡 / 海德格尔·在场): 托盘「出站未送达 N 条 →」点击后，IM 页需**落页即展开**补发明细。
 *
 * 为什么不用 CustomEvent：IM 页是 `lazy()` 分包，托盘点击时它可能**尚未挂载**，
 * 事件先于订阅者发出就会静默丢失——"跳过去了但没展开"正是一种名实不符。
 * 故用 pending 意图单例：先记意图，页面挂载时 consume 一次（有则消费、无则什么都不做）。
 */
let _pendingOutbox = false;

/** 托盘请求「落 IM 页即展开出站补发账明细」。 */
export function requestImOutbox(): void {
  _pendingOutbox = true;
}

/** 页面挂载时取走一次意图（取走即清，避免每次进 IM 页都自动展开）。 */
export function consumeImOutboxRequest(): boolean {
  const p = _pendingOutbox;
  _pendingOutbox = false;
  return p;
}
