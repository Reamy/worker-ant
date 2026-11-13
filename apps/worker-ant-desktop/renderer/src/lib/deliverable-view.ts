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
// zx_20261107_1 B9: 通用时间/字节格式化已收口到 `lib/format.ts`（全站一把尺）——
//   本模块**转出**以保持既有 import 路径不变；新代码请直接从 `./format` 取。
import { formatDbTime, formatBytes } from './format';
export { formatDbTime, formatBytes };

export const DELIVERABLE_TYPE_LABEL: Record<string, string> = {
  mcp: 'MCP服务', a2a: 'A2A服务', ui: 'UI界面', doc: '文档', daemon: '守护进程', code: '代码',
};

export const DELIVERABLE_STATUS_LABEL: Record<string, string> = {
  draft: '草稿', running: '运行中', registered: '已注册', stopped: '已停止',
  completed: '已完成', failed: '失败', stale: '疑似失联', retired: '已退休',
};

/**
 * 本地绝对路径判据（展示层唯一真源）：POSIX 根、Windows 盘符、UNC 三形。
 * 只决定"是否出打开类按钮"；授权仍在 main（`deliverable:open` 只收 id，路径由 main 从库内取并过围栏）。
 * 此前列表页与抽屉各写一份，抽屉停在「只认 `/`」⇒ Windows 盘符恒假、按钮永不出——两处同源后才不再漂。
 */
export const isLocalAbsolutePath = (p?: string | null): boolean => !!p && /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(p);

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
