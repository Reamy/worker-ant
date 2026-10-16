/**
 * zx_20260909_1 M2 (域A · IM 出站失败落账 + 短窗补发 A3)。
 *
 * 关键通知(完成/失败/介入暂停/超长进度, 均经 pushImNotify)发送失败 → enqueueImOutbox 落 pending;
 * main 定时器按 im.outbox_retry_min(分钟, 0=关)调用 retryImOutbox 短窗退避重试(默认 3 次、退避 1/2/4 min),
 * 成功置 sent、超窗/超次置 dead。不动 F3 文件目录契约、不动普通入站回话(那些即时确认不经本账)。
 * send 依赖注入便于无 Electron 环境的受控复跑注入假发送; 生产默认走 im.ipc.sendImMessage(严格版, 抛异常不吞)。
 *
 * zx_20260911_4 M2-2: 发送条件缺失类失败(配额耗尽/无 token)经 `ImQuotaError` 区分, 不烧尝试次数、标 blocked_quota,
 * 待该用户入站(reviveQuotaBlockedOutbox)复活再试。
 *
 * zx_20260924_1 M8(维特根斯坦·意义即使用): **能力不支持**是与"这一次没成功"不同的第三类结果。
 * `media:false` 的渠道(如个人微信)上, 一件媒体**结构上就送不出去**——此前补发路不读能力表,
 * 硬发下去, `sendImMedia` 抛「本通道不支持发送文件」被包成 `ImSendError` ⇒ 走**普通失败路**
 * (attempts+1、退避、最终 dead), 界面显示"未送达"而真相是"永远不会送达"。
 * 现在**在进入发送之前**如实拒绝(见 `mediaUnsupportedFor`), 落 `unsupported_media`、**不烧次数**。
 */
import crypto from 'node:crypto';
import path from 'node:path';
import type { ImDb } from './im-db.js';
import { ImSendError, isImQuotaError, isImSendError } from './im-errors.js';
import { emitOutboundMessage } from './outbound-event.js';
import { mediaUnsupportedReason } from './channel-capabilities.js';

export interface ImOutboxEntry {
  channelId: string;
  externalUserId: string;
  taskId: string;
  kind: string;
  /** 面向人的**预览文本**（供对话视图/事件预览）。发件时它是那句说明, 不是件的字节。 */
  message: string;
  /**
   * zx_20260924 M4（管子·度量衡 / 一处真源）: 这条账发的是**件**还是文本, 由这两个字段定, 不由 `kind` 猜。
   *
   * `mediaPath` 非空即为发件——补发必须走 `sendMedia`。**为什么单独立字段而不复用 `message`**：
   * 「发件」与「发文本」在补发时是两条不同的调用（`sendImMedia` vs `sendImMessage`）,
   * 若只留一个文本字段, 补发就只能凭"看起来像路径"去猜, 而那正是把件退化成文件名那条路。
   */
  mediaPath?: string;
  mediaKind?: string;
}

/** 人读的"这条账发的是什么"——媒体的账上 `message` 常为空, 不能就此让预览/对话行变成空白。 */
function entryPreview(entry: ImOutboxEntry): string {
  if (entry.message) return entry.message;
  return entry.mediaPath ? `📎 ${path.basename(entry.mediaPath)}` : '';
}

/**
 * `wa_im_outbox` 行 → 补发用的 entry。**唯一映射点**。
 *
 * 两条补发路（手动 `retryOutboxEntry`、自动 `retryImOutbox`）此前各写一遍字面量——M4 加了媒体两列后，
 * 那种写法要求两处**同时**记得带上新列，漏一处就是"两条路一把尺"当场不成立（且漏的是自动那条，
 * 最不显眼）。归到此一处后，新列只在这里加。
 */
function entryFromRow(row: Record<string, unknown>): ImOutboxEntry {
  const mediaPath = (row.media_path as string) || '';
  return {
    channelId: (row.channel_id as string) || '',
    externalUserId: (row.external_user_id as string) || '',
    taskId: (row.task_id as string) || '',
    kind: (row.kind as string) || 'notification',
    message: (row.message as string) || '',
    ...(mediaPath ? { mediaPath, mediaKind: (row.media_kind as string) || 'file' } : {}),
  };
}

export const OUTBOX_MAX_ATTEMPTS = 3;
export const OUTBOX_BACKOFF_MIN = [1, 2, 4];
/** zx_20260930 M4-3: 单页**硬上限**——`limit` 超此值一律夹回（不报错，也不让一次查询把整个账拉满）。 */
export const OUTBOX_PAGE_MAX = 500;

type DB = ImDb;

/**
 * zx_20260912 M3(管子·度量衡 / 王阳明·知行合一): **记因**——每次失败写 `last_attempt_at`, 并把真原因记进 `last_error`。
 *
 * 「具体原因优先」：`COALESCE(NULLIF(?, ''), last_error)` —— 库里已有具体原因时, 本次只有"结果描述"或空
 * 都**不覆盖**它。否则"为什么没送到"会被"第几次没送到"冲掉, 账只会越翻越糊涂。**不回填任何猜测**。
 * 整体 try/catch：账列缺失(旧库/旧夹具)时不拖累发送与重试本身的语义(与 enqueueImOutbox 既有容忍同口径)。
 */
function recordFailure(db: DB, id: string, reason?: string): void {
  try {
    const r = (reason || '').trim();
    db.prepare("UPDATE wa_im_outbox SET last_error = COALESCE(NULLIF(?, ''), last_error), last_attempt_at = datetime('now') WHERE id = ?").run(r, id);
  } catch { /* 记因失败不影响发送/重试语义 */ }
}

/**
 * zx_20260913 M1-4(罗尔斯·同一把尺): 出站送达态**写在事本身所在的行上**——补发账与对话视图同源。
 *
 * 病根: 出站行此前**只在发送成功后**落库, 发送失败在对话视图里静默缺席 ⇒ 同一件事在账里有行、
 * 在对话里没有两种说法。修法: 本函数(唯一记账点)顺带补一条 `status='failed'` 的对话行, 并以
 * `outbox_id` 真关联; 补发成功后由 `flipConversationSent` 把**同一行**翻回 `sent`。
 * 列缺失(旧库/旧夹具)时整段静默跳过, 不拖累落账与发送语义(与 recordFailure 同口径的容忍)。
 */
function recordFailedConversation(db: DB, outboxId: string, entry: ImOutboxEntry, error?: string): void {
  try {
    db.prepare(
      "INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction, status, last_error, outbox_id, created_at) VALUES (?, ?, ?, ?, 'outbound', 'failed', ?, ?, datetime('now'))"
    ).run(crypto.randomUUID(), entry.channelId, entry.externalUserId || '', JSON.stringify({ text: entryPreview(entry), ...mediaJson(entry) }), (error || '').trim(), outboxId);
  } catch { /* 对话表缺列(旧库)不阻断落账 */ }
}

/** 媒体件落进 `message_json`（**追加键**，不动 `text`）——失败那条对话行因此不会是一片空白。 */
function mediaJson(entry: ImOutboxEntry): Record<string, unknown> {
  return entry.mediaPath ? { media: { path: entry.mediaPath, kind: entry.mediaKind || 'file' } } : {};
}

/** 补发成功 → 把与 outbox 行关联的那条对话行由 failed 翻回 sent（同一把尺：一处送达，两处同说）。 */
function flipConversationSent(db: DB, outboxId: string): void {
  try {
    db.prepare("UPDATE wa_im_conversations SET status = 'sent', last_error = '' WHERE outbox_id = ? AND status = 'failed'").run(outboxId);
  } catch { /* 缺列不阻断补发结果 */ }
}

/** 发送失败落账(pending, 0 次尝试)。表缺失/失败静默忽略(发送方不阻断)。
 *  `error` 为可选的真原因(M3)：调用方手里有就带进来, 没有就留空——账上如实写"原因未记录", 不编。 */
export function enqueueImOutbox(db: DB, entry: ImOutboxEntry, error?: string): void {
  try {
    const id = crypto.randomUUID();
    db.prepare(
      "INSERT INTO wa_im_outbox (id, channel_id, external_user_id, task_id, kind, message, attempts, status, next_retry_at) VALUES (?, ?, ?, ?, ?, ?, 0, 'pending', ?)"
    ).run(id, entry.channelId, entry.externalUserId, entry.taskId, entry.kind || 'notification', entry.message || '', Date.now());
    // 媒体两列**单独一条 UPDATE**（与 `recordFailure` 同一手法）：INSERT 只碰 M2 就有的列，
    //   于是旧库/旧夹具（无 media_* 列）**照常落账**、文本件行为逐字不变；只有"这次要发的是一件"
    //   这种新情形才会碰到新列。若真落到缺列的库上，`console.warn` 如实报警而不是静默丢——静默丢的
    //   后果是账上少一个"这件是件"的标记，补发时就会把件退化成文件名。
    if (entry.mediaPath) {
      try {
        db.prepare("UPDATE wa_im_outbox SET media_path = ?, media_kind = ? WHERE id = ?")
          .run(entry.mediaPath, entry.mediaKind || 'file', id);
      } catch (e) {
        console.warn(`[IM:outbox] media_path 列缺失，媒体件记账降级: ${(e as Error).message}`);
      }
    }
    // 记因**单独一条**：记因语句触碰的是 M3 新列, 与 INSERT 分开, 旧库/旧夹具(无该列)不会连落账一起失败。
    recordFailure(db, id, error);
    // M1-4: 未送达也要**到场**——同日对话视图出现该条并标「未送达 + 原因」, 不再是账里有、对话里没有。
    recordFailedConversation(db, id, entry, error);
    // zx_20260911_5 M1-5(如实/上手): 落账即时报——此前失败完全不上报, 横幅只在下次出站成功或手动点击时才更新。
    // 复用既有 `im.message_outbound` 事件(不新增事件名), 带 pending:true 供界面区分"未送达已入账"。
    emitOutboundMessage({
      channelId: entry.channelId,
      channelType: lookupChannelType(db, entry.channelId),
      toUser: entry.externalUserId || '',
      preview: entryPreview(entry),
      pending: true,
    });
  } catch { /* outbox 落账失败忽略 */ }
}

function lookupChannelType(db: DB, channelId: string): string {
  try {
    return (db.prepare('SELECT channel_type FROM wa_im_channels WHERE id = ?').get(channelId) as { channel_type?: string } | undefined)?.channel_type || '';
  } catch { return ''; }
}

/** 该表有没有这一列——旧库/旧夹具缺 `media_*` 时据此退让(与 `enqueueImOutbox` 对缺列的既有口径同尺)。 */
function hasColumn(db: DB, table: string, col: string): boolean {
  try {
    return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some(r => r.name === col);
  } catch { return false; }
}

/**
 * zx_20260924_1 M8(维特根斯坦·意义即使用): **「这件此刻发不了」的唯一判据**——两条补发路共用这一份。
 *
 * 病根：`channel-capabilities.ts` 写下 `media:false` 与"本通道不支持发送文件"，而补发路既不读它
 * (连 `channel_type` 都没取)、也拦不住终态(`dead` 也在可补发集合里) ⇒ 用户点「补发」，件硬发下去、
 * `sendImMedia` 抛错被当**普通失败**处理：attempts+1、退避、再置 dead。账上写的是"这次没送到"，
 * 真相是"这条永远不会送达，因为这个通道根本发不了件"。
 *
 * 返回空串 = **能发**——含两种情形："这是纯文本行"(不看渠道) 与 "该通道支持发件"。
 * 判据取能力表那一列本身，文案取同一处真源，不在此另写第二句。
 * 渠道类型走既有的 `lookupChannelType`(不另写第二份查询)；渠道行已删/类型未知时按能力表兜底
 * (`media:false`)如实拒绝——宁可说"发不了"，也不去撞一个注定抛错的发送。
 */
function mediaUnsupportedFor(db: DB, row: Record<string, unknown>): string {
  if (!String(row.media_path || '')) return '';
  return mediaUnsupportedReason(lookupChannelType(db, String(row.channel_id || '')));
}

/** 命中上面判据后的**唯一落账手法**：状态如实说"结构上发不了"，`attempts` **不动**——与 `blocked_quota`
 *  同形："能力不支持"不是"这一次没成功"，烧次数只会把一件本来就到不了的件伪装成"试过 3 次才放弃"。 */
function markUnsupportedMedia(db: DB, id: string, reason: string): void {
  db.prepare("UPDATE wa_im_outbox SET status = 'unsupported_media' WHERE id = ?").run(id);
  recordFailure(db, id, reason);
}

export interface OutboxRow {
  id: string;
  channel_id: string | null;
  channel_name: string | null;
  /** zx_20260924_1 M8: 本行渠道的类型——能力表取用所需的键。此前只带 `channel_name` ⇒ 补发路手上拿不到它。 */
  channel_type: string | null;
  external_user_id: string | null;
  task_id: string | null;
  task_title: string | null;
  kind: string;
  message: string;
  /** zx_20260924_1 M8: 本行发的是**件**还是文本(非空 = 件)。界面据此判"这是不是一条件"。 */
  media_path: string | null;
  media_kind: string | null;
  /**
   * zx_20260924_1 M8: **派生字段**——此刻这条件发得了吗(主进程一处判)。
   *
   * 为什么在 main 派生而不是让 renderer 自己判：能力表是 main 侧模块，渲染层 import 不了
   * (跨进程)；让渲染层手抄一句同义文案就是第二份真源。故这里直接给结论 + 理由，渲染层只照抄。
   */
  media_unsupported: boolean;
  /** 同上：理由取自能力表那句真源(不需要时为空串)。 */
  media_unsupported_reason: string;
  attempts: number;
  status: string;
  created_at: string | null;
  next_retry_at: number | null;
  /** zx_20260912 M3: 最近一次失败的真原因(无则 null ⇒ 界面如实显示"原因未记录", 不回填猜测)。 */
  last_error: string | null;
  /** zx_20260912 M3: 最近一次尝试时刻(UTC 秒级, 与 created_at 同口径)。 */
  last_attempt_at: string | null;
}

/**
 * zx_20260911_5 M1-1(庄子·得鱼忘筌): 出站补发账**逐条明细**——此前界面只有一个数字, 点不开也查不到。
 * 只读 SQL, 单一真源(与 rr 受控复跑同源); status 可选过滤, 默认全部按下单时间倒序取 limit 条。
 * zx_20260912 M3: 带上 last_error/last_attempt_at——"补发那几条"之外, 还要答得出"为什么没送到"。
 * zx_20260924_1 M8: 再带 `channel_type` 与媒体两列, 并把"这件此刻发得了吗"**在 main 侧判好**一起返回
 *   (渲染层 import 不了能力表; 让它自己拼一句同义文案就是第二份真源)。
 * zx_20260930 M4-3(一处真源 / 名实相符): 加 `offset`——明细**分页可取尽**。此前界面写死 `limit:200`,
 *   而统计是 `GROUP BY status` 数**全部** ⇒ 账 >200 条时横幅说"待补发 300 条"、明细只列得出 200 行,
 *   剩下 100 条**用户翻不到**(数得到、取不着)。`ORDER BY` 补 `o.rowid DESC` 作**稳定次序**:
 *   `created_at` 只到秒, 同秒多行时单靠它排序**次序不定**, 翻页会重复/遗漏(分页病，不是显示病)。
 */
export function listOutbox(db: DB, opts?: { status?: string; limit?: number; offset?: number }): OutboxRow[] {
  const limit = Math.min(Math.max(Number(opts?.limit) || 100, 1), OUTBOX_PAGE_MAX);
  const offset = Math.max(Number(opts?.offset) || 0, 0);
  const where = opts?.status ? 'WHERE o.status = ?' : '';
  // 旧库/旧夹具没有 `media_*` 列(M4 的迁移只加在真库上)——照 `enqueueImOutbox` 对缺列的既有口径退让成 NULL,
  //   而不是让整张明细表在这些库上直接抛 `no such column`（那是"补发账翻不开"，比缺个标记严重得多）。
  const mediaCols = hasColumn(db, 'wa_im_outbox', 'media_path')
    ? 'o.media_path, o.media_kind'
    : 'NULL AS media_path, NULL AS media_kind';
  const sql = `SELECT o.id, o.channel_id, c.name AS channel_name, c.channel_type AS channel_type,
                      o.external_user_id, o.task_id, t.title AS task_title,
                      ${mediaCols},
                      o.kind, o.message, o.attempts, o.status, o.created_at, o.next_retry_at, o.last_error, o.last_attempt_at
               FROM wa_im_outbox o
               LEFT JOIN wa_im_channels c ON c.id = o.channel_id
               LEFT JOIN wa_tasks t ON t.id = o.task_id
               ${where}
               ORDER BY o.created_at DESC, o.rowid DESC LIMIT ? OFFSET ?`;
  const rows = (opts?.status
    ? db.prepare(sql).all(opts.status, limit, offset)
    : db.prepare(sql).all(limit, offset)) as Array<Omit<OutboxRow, 'media_unsupported' | 'media_unsupported_reason'>>;
  // 「发不了件」的派生**只此一处**：判据与文案都来自 `channel-capabilities`(能力表+同一句真源)。
  return rows.map(r => {
    const reason = r.media_path ? mediaUnsupportedReason(r.channel_type || '') : '';
    return { ...r, media_unsupported: !!reason, media_unsupported_reason: reason };
  });
}

export interface OutboxStats { pending: number; blocked_quota: number; dead: number; sent: number; other: number }

/**
 * zx_20260930 M4-3(一处真源): **逐状态原始计数**——`GROUP BY status` 的**唯一**一次落点。
 *
 * 两个消费者取同一份结果：`outboxStats` 把它折成横幅用的五档（含 `other` 兜底），
 * 界面拿它作**每组的「共 M 条」**。此前只有一个折叠后的对象 ⇒ 界面只能凭"明细行数"说"共几条"，
 * 于是"显示得下的"被当成"总共有的"，补发账 >200 条时**数得到、翻不着**。
 * 折叠是**展示口径**，不该是**唯一**口径——故原型（未折叠）单独留在这里，两个口径同生一源。
 */
export function outboxStatusCounts(db: DB): Record<string, number> {
  const out: Record<string, number> = {};
  const rows = db.prepare('SELECT status, COUNT(*) AS n FROM wa_im_outbox GROUP BY status').all() as Array<{ status: string; n: number }>;
  for (const r of rows) out[String(r.status)] = Number(r.n) || 0;
  return out;
}

/**
 * zx_20260911_5 M1-2(康德·范畴穷尽): 状态分类必须穷尽——此前 `blocked_quota`(等条件恢复)完全不计,
 * 且横幅仅在 pending/dead > 0 时出现 ⇒ 全 blocked_quota 时整条横幅消失。`other` 兜住任何未知态, 同样不漏。
 * zx_20260930 M4-3: 折叠**改由 `outboxStatusCounts` 派生**（一处 SQL、两个口径），本函数返回值形状**不变**
 *   （既有整对象断言散在 rr 里；加键是在改判据的强弱，不是在改事实）。
 */
export function outboxStats(db: DB): OutboxStats {
  const stats: OutboxStats = { pending: 0, blocked_quota: 0, dead: 0, sent: 0, other: 0 };
  for (const [status, n] of Object.entries(outboxStatusCounts(db))) {
    if (status === 'pending') stats.pending = n;
    else if (status === 'blocked_quota') stats.blocked_quota = n;
    else if (status === 'dead') stats.dead = n;
    else if (status === 'sent') stats.sent = n;
    else stats.other += n;
  }
  return stats;
}

export interface RetryOutcome { ok: boolean; status: string; attempts: number; quota?: boolean; error?: string }

/** zx_20260912 M2(海德格尔·在场): 补发成功也要到场——复用 `im.message_outbound`（不新增事件名），
 *  与初次发送同一条通道。否则补发成功是静默改库，正在看 IM 页的人看不到"它终于到了"。 */
function emitRetriedOutbound(db: DB, channelId: string, toUser: string, message: string): void {
  try {
    const ch = db.prepare('SELECT channel_type FROM wa_im_channels WHERE id = ?').get(channelId) as { channel_type?: string } | undefined;
    emitOutboundMessage({ channelId, channelType: ch?.channel_type || '', toUser, preview: message });
  } catch { /* 事件发不出不影响补发结果本身 */ }
}

/**
 * zx_20260911_5 M1-4(王阳明·知行合一): **单条**手动补发——看得见就要做得了。
 * 走与自动补发同一套语义(严格 send / `ImQuotaError` 不烧次数 / 1-2-4 退避 / 3 次转 dead), 不另造规则。
 * 只接受 pending/blocked_quota/dead; 已 sent 或行不存在如实回报, 不假装。
 *
 * zx_20260924_1 M8: 可补发集合**含 `unsupported_media`**——否则这一态成永久死结(将来适配器补上
 * `sendMedia` 后用户点不动它)。命中时仍由判据**当场再拒一次**：能拒的是"此刻发不了"，不是"永远不许试"。
 */
export async function retryOutboxEntry(
  db: DB,
  id: string,
  opts?: { now?: number; send?: (row: ImOutboxEntry) => Promise<boolean> },
): Promise<RetryOutcome> {
  const now = opts?.now ?? Date.now();
  const send = opts?.send ?? ((row: ImOutboxEntry) => defaultSend(db, row));
  const row = db.prepare('SELECT * FROM wa_im_outbox WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return { ok: false, status: 'not_found', attempts: 0 };
  const status = String(row.status || '');
  const attempts0 = Number(row.attempts) || 0;
  if (status === 'sent') return { ok: false, status: 'sent', attempts: attempts0, error: '该消息此前已送达' };
  if (!['pending', 'blocked_quota', 'dead', 'unsupported_media'].includes(status)) {
    return { ok: false, status, attempts: attempts0, error: `当前状态不可补发（${status}）` };
  }
  // M8: 状态闸之后、**发送之前**——这件此刻发不了就如实拒绝，绝不去撞一个注定抛错的 `send`
  //   (撞了会被当普通失败：attempts+1、退避、再 dead，用户读到的就成了"这次没送到")。
  const unsupported = mediaUnsupportedFor(db, row);
  if (unsupported) {
    markUnsupportedMedia(db, id, unsupported);
    return { ok: false, status: 'unsupported_media', attempts: attempts0, error: unsupported };
  }
  const entry = entryFromRow(row);
  let ok = false;
  // M3: 本次失败的真原因(若有)。`ImSendError` 与 `send` 返回 false 走**同一条**径——退避/次数/超窗语义逐字不变。
  let reason = '';
  try {
    ok = await send(entry);
  } catch (err) {
    if (isImQuotaError(err)) {
      // 发送条件缺失：不烧尝试次数(烧完 3 次转 dead 会真丢通知), 退回等入站/条件恢复
      db.prepare("UPDATE wa_im_outbox SET status = 'blocked_quota' WHERE id = ?").run(id);
      recordFailure(db, id, (err as Error).message);
      return { ok: false, status: 'blocked_quota', attempts: attempts0, quota: true, error: (err as Error).message };
    }
    // 注入 send 抛普通异常：维持既有语义(状态/次数都不动), 只把原因如实记下。
    if (!isImSendError(err)) {
      recordFailure(db, id, (err as Error).message);
      return { ok: false, status, attempts: attempts0, error: (err as Error).message };
    }
    reason = (err as Error).message;
  }
  if (ok) {
    db.prepare("UPDATE wa_im_outbox SET status = 'sent', attempts = attempts + 1, next_retry_at = NULL WHERE id = ?").run(id);
    // M1-4: 一处送达、两处同说——关联对话行同步由 failed 翻回 sent(否则对话视图永远停在"未送达")。
    flipConversationSent(db, id);
    emitRetriedOutbound(db, entry.channelId, entry.externalUserId, entryPreview(entry));
    return { ok: true, status: 'sent', attempts: attempts0 + 1 };
  }
  const attempts = attempts0 + 1;
  if (attempts >= OUTBOX_MAX_ATTEMPTS) {
    db.prepare("UPDATE wa_im_outbox SET status = 'dead', attempts = ? WHERE id = ?").run(attempts, id);
    recordFailure(db, id, reason);
    return { ok: false, status: 'dead', attempts, error: reason || '已达最大尝试次数，仍未能送达' };
  }
  const backoffMs = (OUTBOX_BACKOFF_MIN[attempts - 1] ?? 4) * 60_000;
  db.prepare("UPDATE wa_im_outbox SET status = 'pending', attempts = ?, next_retry_at = ? WHERE id = ?").run(attempts, now + backoffMs, id);
  recordFailure(db, id, reason);
  return { ok: false, status: 'pending', attempts, error: reason || '本次未送达，已排入下次补发' };
}

function sqliteUtcToMs(ts?: string | null): number {
  if (!ts) return 0;
  const s = String(ts).trim();
  const hasZone = /(Z|[+-]\d{2}:?\d{2})$/i.test(s);
  const ms = new Date(hasZone ? s : s.replace(' ', 'T') + 'Z').getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

/** 生产发送：走**严格**发送入口(抛出而非吞异常)，使 `ImQuotaError` 能到达 retryImOutbox 的类型判定。
 *  M3: 普通失败改抛 `ImSendError`(带真原因) —— 两个重试函数都把它**当 `false` 处理**(同一径、同一退避次数),
 *  差别只在"这回原因在手, 能记进账"。此前 `return false` 把原因丢在栈上, 账上只剩"未送达"三个字。
 *
 *  传 `recordConversation: false`(补发不另起一行): 本行走的是**补发**, 那条对话记录在首次发送失败时
 *  已由 `recordFailedConversation` 落库(`status='failed'`, 带 `outbox_id`); 补发成功后由
 *  `flipConversationSent` 把它翻回 `'sent'`。若适配器照常再插一行, 一次补发会让对话视图出现**两行**。 */
async function defaultSend(_db: DB, row: ImOutboxEntry): Promise<boolean> {
  try {
    const { sendImMessage, sendImMedia } = await import('../../ipc/im.ipc.js');
    // zx_20260924 M4: **这件是件，就还发件**——补发不降级。判据只有一条：`mediaPath` 在不在，
    //   不猜 `message` 像不像路径。两条路抛出的异常**同一套语义**（`ImQuotaError` 原样上抛、
    //   其余包成 `ImSendError`），故退避/次数/超窗/配额复活逐字共用，没有第二条规则。
    if (row.mediaPath) {
      await sendImMedia(
        row.channelId,
        row.externalUserId || '',
        { path: row.mediaPath, kind: row.mediaKind === 'image' ? 'image' : 'file' },
        { recordConversation: false },
      );
    } else {
      await sendImMessage(row.channelId, row.externalUserId || '', row.message || '', { recordConversation: false });
    }
    return true;
  } catch (err) {
    if (isImQuotaError(err)) throw err;
    throw new ImSendError((err as Error).message || String(err));
  }
}

/**
 * M2-2: 该用户入站(配额窗口刷新)后，把其 `blocked_quota` 行复活为可补发的 pending。
 * 只按 external_user_id 匹配——配额窗口本就是**按人**统计的(`wechat-adapter.pushQuota` key=toUser)。
 * 返回复活行数。表缺失/异常静默(入站流程不因此中断)。
 *
 * M8: **不管** `unsupported_media`——那一态等的是"渠道长出 `sendMedia`"或"换条渠道"，不是"等人入站"；
 * 复活它只会让同一件再被拒一次。真有那一天，`retryOutboxEntry` 的可补发集合已含该态，用户点得动。
 */
export function reviveQuotaBlockedOutbox(db: DB, externalUserId: string): number {
  if (!externalUserId) return 0;
  try {
    const r = db.prepare("UPDATE wa_im_outbox SET status = 'pending', next_retry_at = ? WHERE status = 'blocked_quota' AND external_user_id = ?").run(Date.now(), externalUserId);
    return Number(r.changes) || 0;
  } catch { return 0; }
}

/**
 * 扫描到期 pending 并补发。windowMinMinutes: 超窗(自落账起超过该分钟)未达 → 置 dead 不再补发; <=0 视同关闭(调用方已 gate)。
 * send 可注入(默认生产路径)。成功置 sent; 失败 attempts+1, 达到上限或超窗置 dead, 否则 next_retry_at 按 1/2/4 min 退避。
 * M2-2: send 抛 `ImQuotaError`(配额耗尽/无 token 类——发送条件缺失, 非消息问题) → 标 blocked_quota 且 **attempts 不增**,
 * 待该用户入站(reviveQuotaBlockedOutbox)复活再试; 超过窗口仍未复活同样置 dead, 不留永远扫不动的悬行。
 * M8: 命中"这件此刻发不了件"(渠道 `media:false`)的媒体行 → 标 `unsupported_media` 且 **attempts 不增**,
 * 与手动补发**同一判据**(`mediaUnsupportedFor`)，不留"每轮都白试一次"的悬行。
 */
export async function retryImOutbox(
  db: DB,
  windowMinMinutes: number,
  opts?: { now?: number; send?: (row: ImOutboxEntry) => Promise<boolean> },
): Promise<void> {
  if (!windowMinMinutes || windowMinMinutes <= 0) return;
  const now = opts?.now ?? Date.now();
  const send = opts?.send ?? ((row: ImOutboxEntry) => defaultSend(db, row));
  // M2-2 超窗清理: blocked_quota 不在补发扫描范围(等入站复活)，但同样按窗口封顶——
  // 否则无 token 类失败永远等不到入站，行会悬在 blocked_quota 里无人回收。
  try {
    const blocked = db.prepare("SELECT id, created_at FROM wa_im_outbox WHERE status = 'blocked_quota'").all() as Array<{ id: string; created_at: string | null }>;
    for (const b of blocked) {
      const cm = sqliteUtcToMs(b.created_at);
      if (cm > 0 && (now - cm) / 60_000 >= windowMinMinutes) {
        db.prepare("UPDATE wa_im_outbox SET status = 'dead' WHERE id = ? AND status = 'blocked_quota'").run(b.id);
        recordFailure(db, b.id, '等待条件恢复超时，超过补发窗口');
      }
    }
  } catch { /* 清理失败不阻断本轮补发 */ }
  const due = db.prepare("SELECT * FROM wa_im_outbox WHERE status = 'pending' AND next_retry_at IS NOT NULL AND next_retry_at <= ? ORDER BY next_retry_at ASC LIMIT 20").all(now) as Array<Record<string, unknown>>;
  for (const row of due) {
    try {
      const id = row.id as string;
      // M8(两条补发路一把尺)：自动路与手动路**同一个判据**——这件此刻发不了就如实拒绝，不烧次数。
      //   位置在超窗闸**之前**：一件落在"发不了件"渠道上的媒体，不论放了多久，真相都是"它到不了"，
      //   说成 `dead`(超窗放弃) 就把结构性问题说成了时间问题。
      const unsupported = mediaUnsupportedFor(db, row);
      if (unsupported) {
        markUnsupportedMedia(db, id, unsupported);
        continue;
      }
      // 超窗终态：落账已超过窗口分钟 → 不再补发(记录为 dead 防反复扫)
      const createdMs = sqliteUtcToMs(row.created_at as string | null);
      if (createdMs > 0 && (now - createdMs) / 60_000 >= windowMinMinutes) {
        db.prepare("UPDATE wa_im_outbox SET status = 'dead', attempts = attempts + 1 WHERE id = ? AND status = 'pending'").run(id);
        recordFailure(db, id, '超过补发窗口，未再补发');
        continue;
      }
      let ok = false;
      // M3: 本次失败的真原因(若有)——`ImSendError` 与 send 返回 false 同径, 退避/次数/超窗语义不变。
      let reason = '';
      try {
        ok = await send(entryFromRow(row));
      } catch (err) {
        if (isImQuotaError(err)) {
          // 发送条件缺失：不烧尝试次数(烧完 3 次转 dead 会真丢问句)，等入站刷新配额后复活
          db.prepare("UPDATE wa_im_outbox SET status = 'blocked_quota' WHERE id = ? AND status = 'pending'").run(id);
          recordFailure(db, id, (err as Error).message);
          continue;
        }
        // 注入 send 抛普通异常仍保持既有语义(不烧次数, 留给下一轮扫描)；生产口抛的 ImSendError 落到下方 false 径。
        if (!isImSendError(err)) throw err; // 其它异常仍由外层 catch 吞掉：单条失败不阻断其它行
        reason = (err as Error).message;
      }
      if (ok) {
        db.prepare("UPDATE wa_im_outbox SET status = 'sent', attempts = attempts + 1, next_retry_at = NULL WHERE id = ? AND status = 'pending'").run(id);
        flipConversationSent(db, id); // M1-4: 与手动补发同一把尺——自动补发成功同样翻回关联对话行
        emitRetriedOutbound(db, row.channel_id as string, (row.external_user_id as string) || '', entryPreview(entryFromRow(row)));
        continue;
      }
      const attempts = Number(row.attempts) + 1;
      if (attempts >= OUTBOX_MAX_ATTEMPTS) {
        db.prepare("UPDATE wa_im_outbox SET status = 'dead', attempts = ? WHERE id = ? AND status = 'pending'").run(attempts, id);
      } else {
        const backoffMs = (OUTBOX_BACKOFF_MIN[attempts - 1] ?? 4) * 60_000;
        db.prepare("UPDATE wa_im_outbox SET attempts = ?, next_retry_at = ? WHERE id = ? AND status = 'pending'").run(attempts, now + backoffMs, id);
      }
      recordFailure(db, id, reason);
    } catch { /* 单条补发异常不阻断其它 */ }
  }
}
