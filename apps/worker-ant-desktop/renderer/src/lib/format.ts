/**
 * 渲染层格式化**唯一真源**（zx_20261107_1 B9「信」）。
 *
 * 病根（实测）：同一件事在各页各写一份，且早已漂开——
 * - token：详情页 `formatToken` 是 `1.5K`（1 位小数），看板 `formatToken` 是 `2K`（0 位），
 *   另有十余处内联 `(n/1000).toFixed(1)+'K'`；同一个数在两页显示成两个值。
 * - 金额：`¥` 前缀散落在模型页/任务页/项目页/设置页，位小数各写各的（4/6/2 位）。
 * - 时间：`formatDbTime` 已是真源，但多页又在外面包一层 `|| s`；还有 `toLocaleString()` 直接上屏。
 * - 计数：`toLocaleString()` 与不分组各写各的。
 *
 * 本模块只做**展示换算**，不承载业务判据：值从哪来、可不可信由调用方决定；这里只保证
 * 「同一个数，在任何一页显示成同一个样子」。
 */
import { parseDbTime } from '../../../../../packages/shared-types/src/db-time.js';

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

/** 同上，但解析不了时**原样回显**——「不认识这个时刻」与「没有时刻」不是一回事。 */
export function formatTimeOrRaw(s?: string | null): string {
  return formatDbTime(s) || String(s ?? '');
}

/** 字节数 → 人话。`null` 一律 `—`（不补 0）：文件不在与文件是空的，不是一回事。 */
export function formatBytes(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(Number(n))) return '—';
  const v = Number(n);
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

/** token 数 → 人话（K/M）。空值/非数 ⇒ `0`（账上没算与算了是 0，在展示层同值）。 */
export function formatTokens(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v) || v === 0) return '0';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `${(v / 1_000).toFixed(1)}K`;
  return String(v);
}

/** 计数 → 带千分位的人话；非数如实 `0`（不抛、不显示 NaN）。 */
export function formatCount(n: number | null | undefined): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  return v.toLocaleString('zh-CN');
}

/** 毫秒耗时 → 人话（ms / s / mss）。非正数一律 `-`（没计时 ≠ 计时为 0）。 */
export function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '-';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

/**
 * 币种代码 → 符号。**只做符号映射，不做币种判定**：某笔钱到底是何币种由写账方/目录决定
 * （模型单价币种的真源在 `recommended-models.json` 的 `provider_currency`，见 B6）。
 * 认不出的代码**原样返还**，不臆造一个符号。
 */
export const CURRENCY_SYMBOL: Record<string, string> = {
  CNY: '¥', USD: '$', EUR: '€', GBP: '£', JPY: '¥',
};

export function currencySymbol(code?: string | null): string {
  const c = String(code || 'CNY').toUpperCase();
  return CURRENCY_SYMBOL[c] ?? c;
}

/**
 * 金额 → `符号 + 定点小数`。空值/非数 ⇒ `—`（不把"没记"印成 ¥0）。
 *
 * 币种礼仪（zx_20261107_1 B6）：**省略 `currency` ⇒ CNY（历史口径）；显式 `currency: null` ⇒ 不印符号**。
 * 两者必须分开——币种未知是"说不出"，不是"就是人民币"；把未知印成 ¥ 正是本批要治的病。
 */
export function formatMoney(
  amount: number | null | undefined,
  opts: { currency?: string | null; digits?: number } = {},
): string {
  if (amount == null || !Number.isFinite(Number(amount))) return '—';
  const sym = opts.currency === null ? '' : currencySymbol(opts.currency);
  return `${sym}${Number(amount).toFixed(opts.digits ?? 2)}`;
}
