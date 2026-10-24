/**
 * 选项渲染/解析的唯一真源。
 *
 * 「[等待用户输入] 问题 [选项: A / B]」这串文本在四处被生产（ask_user 落库会话、门禁落库会话、
 * ask_user 发 IM、门禁发 IM）、在三处被解析（审批队列匹配、DB 回退扫描、启动重建）。
 * 此前渲染用了 `, ` / ` | ` / ` / ` 三种分隔，解析又各按一种 split ——
 * 用户看到的「A / B」与匹配用的 `,` 不是同一套，单字母选项只能靠 includes 偶然命中。
 * 本模块收口为一套规则：渲染一律 ` / `，解析接受 ` / | , 、 ; ；`（历史数据均仍可解析）。
 */

/** 选项分隔符：一个或多个 / | , 、 ; ； 及其两侧空白 */
export const OPTION_SEP_RE = /\s*[/|,、;；]\s*/;

/** 从 `[选项: A / B]` 中提取选项原文；无标记时视为整段即选项原文。
 *  zx_20260930 M3-e: 一并导出——调用方要能先问"这段文本里**有没有**选项块"
 *  （`parseOptions` 把"整段即选项原文"当合法入参，若不先问就把问题正文切成选项了）。
 *  标记本身的真源也只此一处，读点不再手抄 `'[选项:'`。 */
export const OPTION_BLOCK_RE = /\[选项[:：]\s*([^\]]*)\]/;

/** 渲染选项为唯一展示形态：`A / B`（展示、落库、发 IM 共用） */
export function formatOptions(opts: readonly string[]): string {
  return opts
    .map((o) => String(o).trim())
    .filter(Boolean)
    .join(' / ');
}

/**
 * 解析选项文本为数组。入参可以是整条 `[等待用户输入] 问题 [选项: A / B]`，
 * 也可以是仅选项原文（如 `A / B`）——两种都还原成同一数组。
 */
export function parseOptions(text: string): string[] {
  const m = OPTION_BLOCK_RE.exec(text || '');
  const raw = m ? m[1] : text || '';
  return raw
    .split(OPTION_SEP_RE)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** 渲染暂停类系统消息（ask_user 与门禁共用同一形态，横幅/审批匹配只认一处） */
export function formatAwaitingInputMessage(question: string, options: readonly string[]): string {
  const list = options.filter((o) => String(o).trim());
  return list.length > 0
    ? `[等待用户输入] ${question} [选项: ${formatOptions(list)}]`
    : `[等待用户输入] ${question}`;
}

// ====== 审批回复判定（队列路径与 DB 回退路径的唯一真源）======

/** 一条回复对某组审批选项的语义。`option` 携带命中的下标与选项原文。 */
export type ApprovalReply =
  | { kind: 'confirm' }
  | { kind: 'reject' }
  | { kind: 'option'; index: number; text: string };

const CONFIRM_RE = /^(是|yes|y|可以|确认|approve|同意|运行|ok|好|批准|批准执行|执行|确定)[!！。.]*$/i;
const REJECT_RE = /^(否|no|n|不|不行|不可以|取消|cancel|拒绝|别|stop)[!！。.]*$/i;

/** 「1」「1.」「(1)」「A」「A、」→ 0 基下标；越界或非编号 → null */
function parseOptionPrefix(msg: string, count: number): number | null {
  const m = /^[（(]?\s*([A-Za-z]|\d{1,2})\s*[)）.、:：]?\s*$/.exec(msg);
  if (!m) return null;
  const tok = m[1]!;
  const n = /^\d+$/.test(tok) ? Number(tok) : tok.toUpperCase().charCodeAt(0) - 64;
  if (!Number.isFinite(n) || n < 1 || n > count) return null;
  return n - 1;
}

/**
 * 判定一条 IM 回复的审批语义。队列路径与 DB 回退路径共用这一份——
 * 此前队列只认 `msgText.includes(option)`（用户按编号回「1」不命中），
 * 回退又只认选项文字且对确认一票否决，两条路对同一条回复给出不同答案。
 * 判定次序：确认 → 拒绝 → 编号/字母前缀 → 选项文本（长选项整句仍可命中）。
 */
export function matchApprovalReply(options: readonly string[], msgText: string): ApprovalReply | null {
  const msg = (msgText || '').trim();
  if (!msg) return null;
  if (CONFIRM_RE.test(msg)) return { kind: 'confirm' };
  if (REJECT_RE.test(msg)) return { kind: 'reject' };
  const opts = options.map((o) => String(o).trim()).filter(Boolean);
  if (opts.length === 0) return null;
  const idx = parseOptionPrefix(msg, opts.length);
  if (idx !== null) return { kind: 'option', index: idx, text: opts[idx]! };
  const hit = opts.findIndex((o) => msg.includes(o) || o.includes(msg));
  if (hit >= 0) return { kind: 'option', index: hit, text: opts[hit]! };
  return null;
}
