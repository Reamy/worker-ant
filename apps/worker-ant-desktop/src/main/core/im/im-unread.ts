/**
 * IM 未读账 — zx_20260912 M2(海德格尔·在场 / 老子·知不知上)。
 *
 * 未读 = 「上次确实在看 IM」之后到达的入站消息数。它只在托盘示人（用户对打断敏感，不新增系统通知），
 * 因此账必须有**唯一真源**：设置键 `im_last_read_at`。否则各显示端各自记账，必然对不上。
 *
 * 与托盘解耦（只暴露一个 sink 回调，由 main 注入）：本模块被 im-router 引用，若在此 import 托盘/electron，
 * 会把 Electron 依赖带进入站热路径与回归脚本。
 */
import type Database from 'better-sqlite3';

const KEY = 'im_last_read_at';
/**
 * zx_20261002 M2: 每渠道已读时刻（`im_read_at:<channelId>`）——按会话归零。
 * 病根（方案 §1.1-5）：未读原是**单一全局水位**，于是打开 `/im`（乃至任意渠道来一条消息）
 * 就把**所有渠道**的未读一并抹平，"回来已分不清哪些是新消息"。
 * 语义：某渠道有 `im_read_at:<id>` 就按它算；**没有**（从未被打开/看过）则回落到全局水位
 * （= 上次确实在看 IM 的时刻）——历史不因此被算成未读。
 */
const CHAN_KEY = (channelId: string): string => `im_read_at:${channelId}`;

/** 显示端（托盘）。由 main 注入；未注入时只记账不显示（回归/无 GUI 场景）。 */
let _sink: ((n: number) => void) | null = null;
export function setImUnreadSink(fn: ((n: number) => void) | null): void { _sink = fn; }

/** 与 wa_im_conversations.created_at 同口径同源（`datetime('now')` = UTC 秒级，可直接字符串比较）。 */
function nowSql(): string {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

/** 读上次「确实在看 IM」的时刻；**首次缺省 = 当前时刻**——否则历史全部会话会被算成未读。 */
export function getImLastReadAt(db: Database.Database): string {
  try {
    const row = db.prepare('SELECT value FROM wa_settings WHERE key = ?').get(KEY) as { value?: string } | undefined;
    if (row?.value) return row.value;
    const t = nowSql();
    db.prepare("INSERT OR REPLACE INTO wa_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(KEY, t);
    return t;
  } catch { return nowSql(); }
}

/** 入站未读数 = 已读时刻之后落库的 inbound 条数（**按渠道**各比各的水位，见 `CHAN_KEY`）。 */
export function computeImUnread(db: Database.Database): number {
  try {
    const since = getImLastReadAt(db);
    const r = db.prepare("SELECT COUNT(*) AS n FROM wa_im_conversations c WHERE c.direction = 'inbound' AND c.created_at > COALESCE((SELECT value FROM wa_settings WHERE key = 'im_read_at:' || c.channel_id), ?)").get(since) as { n: number } | undefined;
    return Number(r?.n) || 0;
  } catch { return 0; }
}

/**
 * zx_20261003 M12（维特根斯坦·意义即使用）: **逐渠道**未读数——同一把水位、同一道 WHERE，
 * 只是把"一个总数"分解成"每条渠道各多少"，供渠道行红点消费。
 *
 * 病根：水位自 zx_20261002 M2 起已是**每渠道**（`im_read_at:<id>`），但读取面只暴露一个总和
 * ⇒ 界面只知道"总共 N 条未读"，不知道"是哪条渠道的 N 条"，用户点进去之前无从判断。
 *
 * ⚠ **不是第二本账**：与 `computeImUnread` 同源同 WHERE（渠道水位缺失则回落全局水位），粒度不同而已；
 *   未读账仍在 main 一处算（**显示端不得自算**，承 zx_20260914 M1-3 口径）。
 * ⚠ 只返回**有未读**的渠道（`COUNT>0` 者才落在 GROUP BY 结果里）；无未读的渠道**键缺省 = 0**。
 */
export function computeImUnreadByChannel(db: Database.Database): Record<string, number> {
  try {
    const since = getImLastReadAt(db);
    const rows = db.prepare("SELECT c.channel_id AS channelId, COUNT(*) AS n FROM wa_im_conversations c WHERE c.direction = 'inbound' AND c.created_at > COALESCE((SELECT value FROM wa_settings WHERE key = 'im_read_at:' || c.channel_id), ?) GROUP BY c.channel_id").all(since) as Array<{ channelId: string; n: number }>;
    const out: Record<string, number> = {};
    for (const r of rows) { const k = String(r.channelId ?? ''); if (k) out[k] = Number(r.n) || 0; }
    return out;
  } catch { return {}; }
}

/** 把当前未读数同步给显示端。任何会改变未读的时刻都应调它：入站落库后 / 标记已读后 / 启动时。 */
export function refreshImUnread(db: Database.Database): number {
  const n = computeImUnread(db);
  try { _sink?.(n); } catch { /* 显示端异常不影响记账 */ }
  return n;
}

/**
 * 标记已读（renderer 侧「确实在看」的**唯一**写口）。
 *
 * - 传 `channelId` ⇒ 只清**该渠道**（打开该渠道的对话 / 正看着它时收到新入站）。
 * - 不传 ⇒ **全部已读**：全局水位与每个渠道水位一并推进到此刻（"把整个 IM 看了一遍"）。
 *
 * zx_20261002 M2: 此前只有全局一种写法，于是"打开任意一个渠道"就等于"所有渠道都读过"。
 * 现在按渠道留水位，未读账仍在 main 一处算（`computeImUnread`），显示端不得自算。
 */
export function markImRead(db: Database.Database, channelId?: string): number {
  try {
    const now = nowSql();
    if (channelId) {
      db.prepare("INSERT OR REPLACE INTO wa_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(CHAN_KEY(channelId), now);
    } else {
      db.prepare("INSERT OR REPLACE INTO wa_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))").run(KEY, now);
      // 已显式标记过的渠道也要推进到此刻，否则"全部已读"会漏掉它们（它们不再回落到全局水位）。
      db.prepare("UPDATE wa_settings SET value = ?, updated_at = datetime('now') WHERE key LIKE 'im_read_at:%'").run(now);
    }
  } catch { /* 写失败则未读不归零，如实保留（不假装已读） */ }
  return refreshImUnread(db);
}
