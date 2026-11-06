/**
 * 产出物展示的唯一真源：类型/状态词表、库内时间、版本大小换算。
 *
 * 为什么要这一份：renderer 是词表的第二个落点，而同一套「产出物」词表此前散在五处渲染点且互相漂移
 * （列表与仪表盘缺过 code、抽屉缺 failed、交付单与项目页用 守护/MCP 两套文案），同一条成果在不同页上名字不同。
 * 五处一律从这里取；大小换算同理（抽屉曾把库内**字符数**当字节除 1024，与列表显示相差一个量级）。
 */
// zx_20261011_4 M3: 库内时间解析的实现已上移共享真源（renderer 与 main 两侧都要，见 `db-time.ts`）——
//   本模块**转出**以保持既有 import 路径不变（多页仍从 `./deliverable-view` 取 `parseDbTime`）。
import { parseDbTime } from '../../../../../packages/shared-types/src/db-time.js';
export { parseDbTime };

export const DELIVERABLE_TYPE_LABEL: Record<string, string> = {
  mcp: 'MCP服务', a2a: 'A2A服务', ui: 'UI界面', doc: '文档', daemon: '守护进程', code: '代码',
};

export const DELIVERABLE_STATUS_LABEL: Record<string, string> = {
  draft: '草稿', running: '运行中', registered: '已注册', stopped: '已停止',
  completed: '已完成', failed: '失败', stale: '疑似失联', retired: '已退休',
};

/**
 * 库内时间列 → 本地时区展示（标准样式，分钟精度）。
 * 不带时区的串直接喂 `new Date` 会被按本地时区解析 ⇒ 差 8 小时（`2026-09-25 02:00:00` 会显示成 02:00）。
 * 只用于**来自库**的时间列；本来就是 ISO（带 `Z`/偏移）的照原样按本地展示。
 * 空值与非法值返回 `''`（"没有这个时间"不伪造成某个时刻）。
 */
export function formatDbTime(s?: string | null, opts?: { dateOnly?: boolean; timeOnly?: boolean }): string {
  const d = parseDbTime(s);
  if (!d) return '';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  if (opts?.timeOnly) return `${hh}:${mm}`;
  // 逐段拼 `Y/M/D H:MM`，**不用 `toLocaleString('zh-CN').slice(0,16)` 截断**：单数字月/日时该串只有
  //   17–18 位，切到 16 会把秒前那个冒号留下（`2026/10/7 10:11:`）——每年 1–9 月、每月 1–9 日全犯。
  const date = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
  return opts?.dateOnly ? date : `${date} ${hh}:${mm}`;
}

/** 字节数 → 人话。`null` 一律 `—`（不补 0）：文件不在与文件是空的，不是一回事。 */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

/** 字符串的 **UTF-8 真实字节数**（不是 `length`——`length` 数是码元，中文 1 字 = 3 字节）。 */
function utf8Bytes(s: string | undefined | null): number | null {
  if (s == null) return null;
  try { return new TextEncoder().encode(String(s)).length; } catch { return null; }
}

/**
 * `wa_deliverable_versions.size` 里存的是**字符数**（写入方是 `content.length`），不是字节数。
 * 这里**不乘系数**去"还原"字节（那是编造）：有快照正文就用正文**实算** UTF-8 字节（盘上字节的真身），
 * 没有正文就如实说"字符数"，并把"本列是字符数"写进 tooltip。两条路都不假装知道自己不知道的事。
 */
export function versionSizeText(size: number | null | undefined, content: string | undefined | null): { text: string; title: string } {
  const chars = size == null ? null : Number(size);
  const bytes = utf8Bytes(content);
  if (bytes != null) {
    return { text: formatBytes(bytes), title: `按该版快照正文实算 UTF-8 字节（库内 size 列存的是字符数 ${chars ?? '?'}，不是字节数）` };
  }
  if (chars != null && Number.isFinite(chars)) {
    return { text: `${chars} 字符`, title: '本列是字符数，不是字节数——该版无正文快照，无从实算盘上字节' };
  }
  return { text: '—', title: '无大小记录' };
}
