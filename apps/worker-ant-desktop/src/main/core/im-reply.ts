/**
 * zx_20260909 Y1(空性·如实 / 维特根斯坦·可判定 / 少则得): IM 完成回话"主要成果摘要化"纯逻辑。
 *
 * 背景: 任务完成回 IM 此前 `buildCompletionNotice` 直接塞产出文件前 800 字(raw markdown/代码)，
 * 手机屏上是一段半截原文而非"主要成果"(微信日常在用)。本模块把"该报哪条成果、如何把它排成渠道友好
 * 摘要行"抽为**纯函数**(不依赖 electron/db 运行时类型)，供 ai-task.ts 组装 + scripts/rr_*.ts 受控复跑共用，
 * 防"测试与实作漂移"。
 *
 * 规则(如实·可判定): 非 retired 的 doc 中——①已完成且被标 ★primary → 优先；②已完成(最新)；③在制/未完成(最新, 标"在制")；
 * 无 doc 则回 null 交由调用方走旧兜底(summary/AI)。验收徽标经 describeAcceptance 如实(✓已验收 p/t / 验收 p/t / 无)。
 */
import { isAcceptanceVerified } from './acceptance-check.js';

export interface SummaryDocRow {
  id: string;
  name: string;
  type: string;
  status: string;
  is_primary?: number | boolean | null;
  created_at?: string | null;
}

function byLatest<T extends { created_at?: string | null }>(arr: T[]): T {
  return arr.reduce((a, b) => ((b.created_at || '') > (a.created_at || '') ? b : a));
}

/** 挑应上报的主要成果 doc(可判定的确定性选择; 无合格 doc 返回 null → 调用方走旧兜底)。 */
export function selectSummaryDoc(rows: SummaryDocRow[]): SummaryDocRow | null {
  const docs = rows.filter((r) => r.type === 'doc' && r.status !== 'retired');
  if (docs.length === 0) return null;
  const completed = docs.filter((d) => d.status === 'completed');
  const primaryCompleted = completed.filter((d) => d.is_primary === 1 || d.is_primary === true);
  if (primaryCompleted.length > 0) return byLatest(primaryCompleted);
  if (completed.length > 0) return byLatest(completed);
  return byLatest(docs);
}

/** 展示名: 优先文件路径 basename, 其次 name(可能为完整路径) basename, 最次原名。 */
export function displayDocName(row: { name: string }, filePath?: string | null): string {
  const raw = filePath || row.name || '';
  const base = raw.split(/[\\/]/).pop() || raw;
  return base;
}

export interface AcceptanceInfo {
  criteria_total?: number;
  passed_total?: number;
  checked_at?: string;
  /** zx_20260910_3 M1: false = 本次核对**没跑成**（无模型/未吐 JSON/异常），不得当"已验收"报出去 */
  verified?: boolean;
}

/**
 * 验收如实徽标: **确已核验**且全过 → '✓已验收 p/t'；确已核验未全过 → '验收 p/t'；无核验/未核验 → null。
 * zx_20260910_3 M1c(头重脚轻护栏): 判据由"有 checked_at"收敛为共用 `isAcceptanceVerified`——
 * 未核验载荷同样带 checked_at(尝试时刻)，只认 checked_at 会把"没核验"当"已验收"播给 IM。
 */
/**
 * zx_20260911_2 M4-G5(矛盾律·同一开关两入口同效): 追加 `showAcceptance` 门控——
 * `deliverable.show_acceptance=false` 时 IM 侧同 GUI 一样**不播验收徽标**(此前 GUI 关、IM 照播，同一开关两入口行为不一致)。
 * 默认 `true` 保持向后兼容：既有调用点(未传第二参)行为不变。
 */
export function describeAcceptance(acc: AcceptanceInfo | undefined, showAcceptance = true): string | null {
  if (!showAcceptance) return null;
  if (!isAcceptanceVerified(acc)) return null;
  const t = Number(acc?.criteria_total) || 0;
  const p = Number(acc?.passed_total) || 0;
  if (t > 0) return p >= t ? `✓已验收 ${p}/${t}` : `验收 ${p}/${t}`;
  return null;
}

export interface SummaryBlockOpts {
  name: string;
  version?: number | null;
  /** describeAcceptance 结果(验收徽标文本或 null) */
  accDesc?: string | null;
  /** 已完成但无验收或其它 → ''；在制(doc status 非 completed)且无验收 → '（在制）' */
  inDraft?: boolean;
  /** 正文一句摘要(≤~150, 已 normalize), 可选 */
  snippet?: string;
}

/** 组装"主要成果摘要块"(2 行以内)。空 name 时不产出。 */
export function buildSummaryBlock(o: SummaryBlockOpts): string {
  const n = (o.name || '').trim();
  if (!n) return '';
  const badge = o.accDesc ? `（${o.accDesc}）` : (o.inDraft ? '（在制）' : '');
  let line1 = `📄 主要成果：${n}`;
  if (o.version) line1 += ` v${o.version}`;
  if (badge) line1 += badge;
  const snippet = (o.snippet || '').trim();
  if (!snippet) return line1;
  const MAX = 150;
  const single = snippet.replace(/\s+/g, ' ').trim();
  const cut = single.length > MAX ? `${single.slice(0, MAX)}…` : single;
  return `${line1}\n${cut}`;
}

/** 摘要正文单行化 + 限长(供 snippet, 不做语义判断)。 */
export function normalizeSnippet(text: string, max = 150): string {
  const single = (text || '').replace(/\s+/g, ' ').trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}
