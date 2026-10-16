/**
 * zx_20260924 M5（管子·度量衡 / 维特根斯坦·语言游戏）: 「任务完成时自动推主要成果文件」的**判据**这一处真源。
 *
 * 为什么单独立模块（同 `attachment-kinds` / `attachment-outcome` / `deliverable-tree` 范式：**零 import**）：
 * 它承载的是**三件可以判对错的规则**，不是一段 IO——
 *   ① **只推"主成果"**：`is_primary` 是互斥登记的谓词（`deliverable-lifecycle.applyPrimary` 置位即清兄弟），
 *      故正常恒 1 件；但历史/手工多标确实存在 ⇒ 件数上限把"多出来的"**如实说明**而不是静默丢；
 *   ② **两道闸取小**：单件字节上限 + 件数上限。超限**不推件、发文本说明**——
 *      「悄悄不发」与「发了但其实是条文件名」是同一种不诚实（后者见 `sendImMedia` 的三条不假装）；
 *   ③ **盘上不在的件不许当成"发出去了"**：字节数取不到（盘上已删/路径已失效）⇒ 与"超限"分开记，
 *      因为成因不同、用户采取的动作也不同（前者要重新产出，后者要自己下载）。
 * 规则要能被受控复跑按**两侧标本**钉住（rr 引不动 Electron），故判据放这里、接线在 `im/im-notify.ts`。
 *
 * ⚠ 这里是**摆法/闸门**，不是"筛件"的第二个真源：候选集由调用方按 `is_primary` 查库给出，
 *   本模块只回答"这几件里哪些发得出去、哪些为什么发不出去"。
 */
import { familyOf } from './attachment-kinds.js';

/** 推件时给 IM 适配器的 `kind`。**由扩展名定**（承 `zx_20260911_1`「判型由产物本身定」），不靠登记标签。 */
export type PrimaryPushKind = 'image' | 'file';

/** 发送形态：这件是**发件**还是**发文本说明**，补发时必须分得开（与 `ImOutboxEntry.mediaPath` 同一判据）。 */
export interface PrimaryPushFile {
  id: string;
  name: string;
  path: string;
  bytes: number;
  kind: PrimaryPushKind;
}

/** "这件为什么没发"——**四态穷尽**，且每态给用户一句能照做的说明（见 `describePrimaryPushSkip`）。 */
export type PrimaryPushSkipReason = 'missing_path' | 'not_on_disk' | 'over_bytes' | 'over_count';

export interface PrimaryPushSkip {
  id: string;
  name: string;
  reason: PrimaryPushSkipReason;
  /** 仅 `over_bytes` 有：该件实际字节数（说出来用户才知道差多少）。 */
  bytes?: number;
}

export interface PrimaryPushPlan {
  files: PrimaryPushFile[];
  skipped: PrimaryPushSkip[];
}

/**
 * 件数上限。依据：`is_primary` 是**互斥谓词**（一个任务内至多一条 ★），故正常恒 1 件；
 * 留 3 的口子是给历史/手工多标的数据——**超过了就如实说要用户自己去取**，而不是挑几件悄悄发。
 */
export const PRIMARY_PUSH_MAX_FILES = 3;

/**
 * 单件字节上限 **20MB**。依据：**工程估计，不是从某家文档抄来的权威值**——
 * 主流 IM 平台单文件上限多落在 20–30MB 一档（企微/钉钉偏严、飞书/QQ 偏松），
 * 取偏严的一侧当**不依赖具体平台**的稳妥值。调大前请先确认目标渠道的实际上限，
 * 否则就是"发出去了但平台拒收"，对用户而言与没发一样却更难查。
 */
export const PRIMARY_PUSH_MAX_BYTES = 20 * 1024 * 1024;

/** 未推送原因 → 面向用户的短标签。**只有这一份**（renderer / 日志 / IM 文本同引此处，勿手抄第二份）。 */
export const PRIMARY_PUSH_SKIP_LABEL: Readonly<Record<PrimaryPushSkipReason, string>> = {
  missing_path: '没有盘上路径',
  not_on_disk: '盘上已不存在',
  over_bytes: '单件超限',
  over_count: '超过本次件数上限',
};

/**
 * 候选件 → 推送计划。
 *
 * `sizeOf` **注入**（而不是在此 `fs.statSync`）：① 受控复跑无需真造文件即可钉住两侧标本；
 * ② 本模块得以保持零依赖。约定：**返回 `null` = 盘上没有/取不到**，返回 `0` = 存在但是空文件（照样算一件）。
 */
export function planPrimaryPush(
  items: ReadonlyArray<{ id: string; name: string; file_path?: string | null }>,
  opts: {
    sizeOf: (path: string) => number | null;
    maxFiles?: number;
    maxBytes?: number;
  },
): PrimaryPushPlan {
  const maxFiles = opts.maxFiles ?? PRIMARY_PUSH_MAX_FILES;
  const maxBytes = opts.maxBytes ?? PRIMARY_PUSH_MAX_BYTES;
  const files: PrimaryPushFile[] = [];
  const skipped: PrimaryPushSkip[] = [];
  for (const it of items) {
    const p = String(it.file_path ?? '').trim();
    if (!p) { skipped.push({ id: it.id, name: it.name, reason: 'missing_path' }); continue; }
    const bytes = opts.sizeOf(p);
    if (bytes === null) { skipped.push({ id: it.id, name: it.name, reason: 'not_on_disk' }); continue; }
    if (bytes > maxBytes) { skipped.push({ id: it.id, name: it.name, reason: 'over_bytes', bytes }); continue; }
    files.push({
      id: it.id,
      name: it.name,
      path: p,
      bytes,
      // 图片走 IM 的图片通路（可预览），其余一律当文件——**不按族细分**，IM 只有这两条路。
      kind: familyOf(p.split('.').pop() || '') === 'image' ? 'image' : 'file',
    });
  }
  // 件数闸在**收集完之后**才切：先说清楚"哪些是候选"，再说"这一次只发前 N 件"——
  // 若边收边截，"剩下的为什么没发"就只剩下一个数字，说不出是哪几件。
  const over = files.splice(maxFiles);
  for (const f of over) skipped.push({ id: f.id, name: f.name, reason: 'over_count' });
  return { files, skipped };
}

/** 字节数 → 人读短串（`12.3 KB` / `2.4 MB`）。 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '未知大小';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * 一件"没发出去"的**完整说明**。超限时带上"差多少"（实际大小 vs 上限）——
 * 只写"超限"用户不知道该重产出还是该自己下载。
 */
export function describePrimaryPushSkip(s: PrimaryPushSkip, maxBytes = PRIMARY_PUSH_MAX_BYTES): string {
  const label = PRIMARY_PUSH_SKIP_LABEL[s.reason];
  if (s.reason === 'over_bytes' && typeof s.bytes === 'number') {
    return `${s.name}（${formatBytes(s.bytes)}）未推送：${label}（上限 ${formatBytes(maxBytes)}）`;
  }
  return `${s.name}未推送：${label}`;
}

/** 本次要发的件的人读预览行（进补发账的 `message`，保证失败那条对话行不是一片空白）。 */
export function describePrimaryPushFile(f: PrimaryPushFile): string {
  return `📎 主要成果：${f.name}（${formatBytes(f.bytes)}）`;
}

/**
 * 整批的收口文案：**发的件逐件列出、没发的逐条说明**。
 * 返回 `''` 表示"这次一件都没发、也没什么可说的"（调用方据此不发这条文本，避免发一句空话）。
 */
export function describePrimaryPushOutcome(plan: PrimaryPushPlan): string {
  const lines: string[] = [];
  if (plan.files.length > 0) lines.push(`本次附上主要成果 ${plan.files.length} 件：`);
  for (const f of plan.files) lines.push(`· ${f.name}（${formatBytes(f.bytes)}）`);
  if (plan.skipped.length > 0) {
    lines.push(plan.files.length > 0 ? '以下未能附上：' : '主要成果未能附上：');
    for (const s of plan.skipped) lines.push(`· ${describePrimaryPushSkip(s)}`);
  }
  return lines.join('\n');
}
