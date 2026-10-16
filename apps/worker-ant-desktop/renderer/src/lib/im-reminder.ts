/**
 * zx_20261002 M1: IM 跨页提醒的**判据与文案**（纯函数·零 import）。
 *
 * 为什么单独成文件：判据要能被受控回归**直跑真实现**——rr 直接 `import` 本模块
 * （同 `lib/convDelivery.ts` 的既有形），而不是在断言里照抄一遍 if-else。
 * 自造一份等价实现再拿它自证，证的是"生产没走的那条路"（本仓已复发的假绿形态）。
 *
 * 硬约束（方案 §2 批一 M1）：**在 IM 页且窗口可见时，绝不打扰**。
 * 与 `IMPage.tsx` 既有的"在场即不虚增未读"同一把尺。
 *
 * 两种提醒通道**不重叠**、由同一判据分派：
 *   - 窗口不可见（最小化/被遮挡）⇒ 原生系统横幅（`AppLayout.tsx` 调 `showNotification`）；
 *   - 可见但不在 IM 页 ⇒ 应用内 toast（`lib/toast.tsx`），点击即回 IM 页；
 *   - 可见且在 IM 页 ⇒ 不提醒（正在看）。
 */

export type ImReminderChannel = 'native' | 'toast' | 'none';

/** 「该走哪条提醒」——输入是**渲染进程当场的事实**（可见性 + 当前路由），输出一个三态。 */
export function imReminderChannel(o: { visible: boolean; onImPage: boolean }): ImReminderChannel {
  if (!o.visible) return 'native';
  return o.onImPage ? 'none' : 'toast';
}

/** 当前是否停在 IM 页（HashRouter：`#/im`、`#/im/...`、`#/im?...` 都算）。 */
export function isImRoute(hash: string): boolean {
  const p = String(hash || '').replace(/^#/, '').split('?')[0] ?? '';
  return p === '/im' || p.startsWith('/im/');
}

const KIND_LABEL: Record<string, string> = {
  image: '图片',
  audio: '语音',
  video: '视频',
  file: '文件',
  text: '消息',
};

export function kindLabelOf(kind: unknown): string {
  const k = typeof kind === 'string' ? kind : '';
  return KIND_LABEL[k] ?? (k ? '件' : '新消息');
}

export function formatBytes(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export interface ImInboundNotice {
  title: string;
  body: string;
}

/**
 * 由入站瞬态载荷（`im-router.ts` 的 `im.message_inbound`）生成提醒文案。
 * 结构化字段与 JSON 真源同名，另容 snake_case（事件日志/历史形状）——**不猜**"谁发的"，取不到就如实说未知。
 */
export function imInboundNotice(raw: Record<string, unknown>): ImInboundNotice {
  const channel =
    String(raw.channelName ?? raw.channel_name ?? '').trim() ||
    String(raw.channelType ?? raw.channel_type ?? '').trim() ||
    'IM';
  const from = String(raw.fromUser ?? raw.from_user_id ?? '').trim() || '未知联系人';
  const fileName = String(raw.fileName ?? raw.file_name ?? '').trim();
  const preview = String(raw.preview ?? '').trim();
  const size = formatBytes(raw.sizeBytes ?? raw.size_bytes);
  const kind = String(raw.kind ?? '');
  const body = fileName
    ? `${kindLabelOf(kind)} ${fileName}${size ? `（${size}）` : ''}${preview ? ` · ${preview}` : ''}`
    : preview || (kind ? kindLabelOf(kind) : '（无正文）');
  return { title: `${channel} · ${from}`, body };
}
