/**
 * zx_20260909_1 M1/M2 (域A · IM 通知可靠达) 共享通知模块。
 *
 * - resolveImNotifyTargets: A2 目标解析——通知目标=任务创建人(优先 task ctx 记录的 channel/externalUser，
 *   缺 externalUser 回落该 origin 渠道最近一条 inbound 同人)，**不再向任务无关渠道的"最近发言路人"广播**；
 *   无 origin 渠道(GUI 建任务常态)回落**最近一条 1:1 私聊 inbound**(补②§十三)——只取 1:1、排除群聊/房间，
 *   既保 GUI 任务可达(§七"仍保可达")又不误投群聊路人；im.notify_to_creator=false 时回落旧"全渠道最近 inbound"行为(broadcastAll)。
 * - pushImNotify: 统一发送入口(完成/失败/介入暂停/超长进度)，经 im.ipc.sendImCompletionNotice 实际发送，
 *   失败/M2 落 outbox 短窗补发。
 * - markPauseNeeded: A1 agent 判定需人工介入的暂停→通知创建人(每任务每次暂停至多一条，im.notify_pause_needed 门控；
 *   用户主动暂停 GUI/托盘 interrupt 不经此)。
 *
 * 位处 core/im 使 agent-executor(介入暂停判定点)/ai-task(目标偏离收敛)/index(完成/进度/超长在场) 三方复用；
 * im.ipc 以动态 import 引入，避免静态环。入站回话/ask_user 即时确认不走本模块(outbox 不覆盖普通回话)。
 */
import fs from 'node:fs';
import { boolSetting } from '../settings-bool.js';
import { buildTaskNotice } from '../task-notice.js';
import { imChannelEnabledSql } from './im-channel-status.js';
import type { ImDb } from './im-db.js';
import { recordNotifyIntent } from './im-notify-log.js';

export interface ImNotifyTarget {
  channelId: string;
  channelType: string;
  externalUserId: string;
}

function settingOf(db: ImDb, key: string, fallback: string): string {
  try {
    const r = db.prepare('SELECT value FROM wa_settings WHERE key = ?').get(key) as { value?: string } | undefined;
    return r?.value ?? fallback;
  } catch {
    return fallback;
  }
}

/** 启用中的渠道（`id`/`channel_type`）。M6：口径＝「启用中」（degraded/error/pending 也算）。 */
function enabledChannels(db: ImDb): Array<{ id: string; channel_type: string }> {
  try {
    return db.prepare(`SELECT id, channel_type FROM wa_im_channels WHERE ${imChannelEnabledSql()}`).all() as Array<{ id: string; channel_type: string }>;
  } catch { return []; }
}

/** 该渠道最近一条 inbound 的发送者。 */
function lastInboundOf(db: ImDb, channelId: string): string {
  try {
    const c = db.prepare("SELECT external_user_id FROM wa_im_conversations WHERE channel_id = ? AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1").get(channelId) as { external_user_id?: string } | undefined;
    return c?.external_user_id || '';
  } catch { return ''; }
}

/**
 * 补②(§十三): 1:1 私聊判定——`chat_type` 缺省(归档前遗留行)视为 direct，但显式 group 或房间号一律排除。
 * 谓词与展示侧口径一致(`COALESCE(json_extract(message_json,'$.chat_type'),'direct')='direct'` 且非 `@chatroom`)。
 * zx_20261016_1 批二：自 `resolveImNotifyTargets` 局部**提到模块级**——`resolveOwnerTargets`（配对通知）
 *   与任务通知**共用这一份**判据，不得各写一份（否则"什么算私聊"迟早分家）。
 */
const DIRECT_PREDICATE = "COALESCE(json_extract(message_json, '$.chat_type'), 'direct') = 'direct' AND COALESCE(external_user_id, '') NOT LIKE '%@chatroom%'";

/**
 * 跨 `channels` 取**时间最新**的一条 1:1 私聊 inbound 发送者；无 ⇒ `null`。
 * ⚠ 与既有行为**逐字一致**：不加 `try`（原实现也没有）——异常由调用方按各自口径处置。
 */
function lastDirectInboundTarget(db: ImDb, channels: Array<{ id: string; channel_type: string }>): ImNotifyTarget | null {
  if (channels.length === 0) return null;
  const holes = channels.map(() => '?').join(',');
  const row = db.prepare(
    `SELECT channel_id, external_user_id FROM wa_im_conversations WHERE channel_id IN (${holes}) AND direction = 'inbound' AND ${DIRECT_PREDICATE} ORDER BY created_at DESC LIMIT 1`
  ).get(...channels.map((c) => c.id)) as { channel_id?: string; external_user_id?: string } | undefined;
  const hit = row?.channel_id ? channels.find((c) => c.id === row.channel_id) : undefined;
  if (hit && row?.external_user_id) return { channelId: hit.id, channelType: hit.channel_type, externalUserId: row.external_user_id };
  return null;
}

/**
 * 任务 ctx 里的**来源会话声明**——`{channel:'', user:''}` = 这个任务**从未有过来源会话**（GUI/定时创建）。
 * 这是"有没有来源渠道"这一问的唯一解析点（`resolveImOriginTarget` 与 `resolveImNotifyTargets` 同引）。
 */
export function taskOriginField(db: ImDb, taskId: string): { channel: string; user: string } {
  try {
    const t = db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json?: string } | undefined;
    const ctx = JSON.parse(t?.context_json || '{}') as { channel?: unknown; externalUser?: unknown };
    return { channel: ctx.channel ? String(ctx.channel) : '', user: ctx.externalUser ? String(ctx.externalUser) : '' };
  } catch { return { channel: '', user: '' }; }
}

/** 任务所属项目（聚并窗口按项目聚；取不到即空串——不同项目绝不互相聚并）。 */
function taskProjectId(db: ImDb, taskId: string): string {
  try {
    const t = db.prepare('SELECT project_id FROM wa_tasks WHERE id = ?').get(taskId) as { project_id?: string | null } | undefined;
    return t?.project_id ? String(t.project_id) : '';
  } catch { return ''; }
}

/**
 * zx_20260924 M5（维特根斯坦·一处真源）: **严格**来源会话解析——只认任务自己的 `ctx.channel`/`ctx.externalUser`，
 * **不做"最近 1:1 私聊"回落**。
 *
 * 为什么要与 `resolveImNotifyTargets` 分开、且抽成一处：文字通知可以"找不到创建人就投给最近私聊的人"
 * （那是 `zx_20260909_1 A2` 的**有意**行为，为的是 GUI 任务仍可达）；但**推一个 20MB 的文件**给
 * "最近跟本系统说过话的某个人"，是把件投给了一个与本次任务无关的会话。故推件这条路的判据必须是
 * **任务有来源会话**。
 *
 * 返回 `null` 的三种情形（对推件路而言结论一样：**不推**）：**没有 `ctx.channel`**（GUI/定时创建）、
 * **该渠道已不在启用列表**（渠道被删/停用）、**该渠道下取不到收件人**（无 `ctx.externalUser` 且无 inbound）。
 */
export function resolveImOriginTarget(
  db: ImDb,
  taskId: string,
  channels?: Array<{ id: string; channel_type: string }>,
): ImNotifyTarget | null {
  const { channel: taskChannel, user: taskUser } = taskOriginField(db, taskId);
  if (!taskChannel) return null;
  const ch = (channels ?? enabledChannels(db)).find((c) => c.channel_type === taskChannel);
  if (!ch) return null;
  const user = taskUser || lastInboundOf(db, ch.id);
  if (!user) return null;
  return { channelId: ch.id, channelType: ch.channel_type, externalUserId: user };
}

/**
 * A2 目标解析。creatorOnly=true(默认，im.notify_to_creator 消费方在 pushImNotify 读取)：
 * 优先任务 origin 渠道 + 创建人(ctx.externalUser，缺则该渠道最近 inbound)；
 * 无 origin 渠道(GUI 建任务的常态) → 回落**最近一条 1:1 私聊 inbound** 发送者(补②§十三)，
 * 只取 1:1、显式排除群聊/房间(chat_type='group' 或 @chatroom 房间号)，绝不复现"群聊路人"误投。
 * creatorOnly=false：遍历所有 active 渠道、逐渠道"创建人优先→最近 inbound"回落(旧行为完整回退)。
 */
export function resolveImNotifyTargets(
  db: ImDb,
  taskId: string,
  creatorOnly: boolean,
): ImNotifyTarget[] {
  // M6：口径＝「启用中」（degraded/error/pending 也算）——旧谓词只认健康态，会把
  // degraded 渠道排除 → 目标解析 return → **连 outbox 都不落**，反噬 M3「未送达须记因」。
  const channels = enabledChannels(db);
  const { channel: taskChannel, user: taskUser } = taskOriginField(db, taskId);
  const lastInbound = (channelId: string): string => lastInboundOf(db, channelId);
  const targets: ImNotifyTarget[] = [];
  if (creatorOnly) {
    // zx_20260924 M5: 「任务自己的来源渠道 + 创建人」这一支与推件路**共用一处实现**
    //   （`resolveImOriginTarget`）——两条路若各写一份"怎么找来源渠道"，迟早会分家（G8/G9 老病）。
    //   能解析出来 ⇒ 就是唯一目标，到此为止（不再往"最近私聊"上回落）。
    const origin = resolveImOriginTarget(db, taskId, channels);
    if (origin) { targets.push(origin); return targets; }
    // ⚠ 订正边界（原件行为，**必须保住**）：解析不出来可能有两因——
    //   ① 有 `ctx.channel` 但渠道没了/取不到人 ⇒ **不回落**（原来就不投给别处，别把"报给了别人"当成修好了）；
    //   ② 压根没有 `ctx.channel`（GUI/定时任务）⇒ 才回落最近一条 1:1 私聊。
    if (taskChannel) return targets;
    // 无 origin 渠道(GUI 任务): 回落最近一条 1:1 私聊(跨 active 渠道取时间最新), 群聊/房间不入围
    // zx_20261016_1 批二: 这段判据抽为 `lastDirectInboundTarget`——**与配对通知同一份实现**（见该函数注）。
    const fallback = lastDirectInboundTarget(db, channels);
    if (fallback) targets.push(fallback);
    return targets;
  }
  // 旧行为回退：全渠道广播，任务无关渠道回落到其最近 inbound
  for (const ch of channels) {
    const user = ch.channel_type === taskChannel && taskUser ? taskUser : lastInbound(ch.id);
    if (user) targets.push({ channelId: ch.id, channelType: ch.channel_type, externalUserId: user });
  }
  return targets;
}

/**
 * 统一发送入口(完成/失败/介入暂停/超长进度)。通知目标=创建人(A2 默认)；发送失败(M2)落 outbox 短窗补发。
 * 任何异常不抛——通知失败不阻断调用方执行/暂停主流程。
 *
 * zx_20261012_2 批五 M5（「一处发」+ 短窗聚并）:
 *  - **先解析目标、无目标即返**：什么都没打算发就不该消耗聚并窗口（见 `im-notify-log.ts` 头注）。
 *  - **聚并**：同项目同类目在 `IM_FAIL_AGG_WINDOW_MS` 内至多真发一条。治的是失败通知的**两跳**——
 *    `recordExecutionFailure` 既直调 `markTaskFailed`、又 `emit('task.failed')`（事件投影器再调一次），
 *    同一失败因此两次到达本口；不去重就是两条 IM。
 */
export async function pushImNotify(
  db: ImDb,
  taskId: string,
  message: string,
  kind = 'notification',
): Promise<void> {
  try {
    const notifyToCreator = boolSetting(settingOf(db, 'im.notify_to_creator', 'true'));
    const targets = resolveImNotifyTargets(db, taskId, notifyToCreator);
    if (targets.length === 0 || !message) return;
    const { suppressed } = recordNotifyIntent(db, { projectId: taskProjectId(db, taskId), taskId, kind });
    if (suppressed) return;
    await sendTextToTargets(db, taskId, targets, message, kind);
  } catch (err) {
    // zx_20261013_2 批一（毛选·实事求是）: 「不阻断」不等于「可以静默」。此前这里是裸 `catch {}`——
    //   异常在三本账上**都不留痕**（无 outbox、无日志、无送达），"该发没发"只能靠"什么都没发生"反推。
    //   2026-10-13 实机即此：`wa_im_notify_log` 有暂停意图行、`wa_im_outbox` 零行、`wa_im_conversations`
    //   零 outbox 行。改为**先记日志再吞**，仍不阻断主流程（与 `markPauseNeeded` 同口径）。
    console.error(`[IM] pushImNotify 异常（task=${taskId.slice(0, 8)}，kind=${kind}）：${(err as Error).message || String(err)}`);
  }
}

/**
 * zx_20261016_1 批二（毛选·没有调查没有发言权 / 维特根斯坦·一处真源）:
 * **"本机主人"的通知目标**——与任何任务**无关**的通知（本轮就是"有终端请求接入")该发给谁。
 *
 * 判据与 `resolveImNotifyTargets` 的"无来源渠道回落"**共用一处**（`lastDirectInboundTarget`）：
 *   跨启用中渠道取**时间最新**的一条 **1:1 私聊** inbound 发送者（群聊/`@chatroom` 不入围）。
 * 为什么是它而不是别的：配对申请**没有任务**，也就没有"创建人"可查；本机主人＝**最近跟工蚁私聊过的人**
 *   ——这与 GUI 任务通知的回落**同一把尺**（`zx_20260909_1 A2` 的有意行为）。
 * 返回 `0` 或 `1` 个目标；解析异常一律回 `[]`（本路是**旁路**，解析不出来不该阻断配对）。
 */
export function resolveOwnerTargets(db: ImDb): ImNotifyTarget[] {
  try {
    const t = lastDirectInboundTarget(db, enabledChannels(db));
    return t ? [t] : [];
  } catch { return []; }
}

/**
 * zx_20261016_1 批二（管子·度量衡 / 王阳明·知行合一）:
 * 把一条**与任务无关**的通知推给本机主人（配对申请走此口）。
 *
 * ⚠ **刻意不过 `recordNotifyIntent`**：那是**按项目/任务聚并**的账（`IM_AGG_KINDS` 目前只含 `task_failed`），
 *   配对是**逐次都要发**的——两台机器人先后申请，压成一条等于**静默吞掉一次申请**。
 *   ⇒ 本口只做"解析目标 → 同一本 `sendTextToTargets`（含失败落 outbox 补发账）"。
 * ⚠ `taskId` 传 `''`：`wa_im_outbox.task_id` 是**可空 TEXT**，空串落账安全（配对本无任务）。
 * 不抛：推送是**旁路**，失败**不阻断**配对（机器人照常轮询），但**不静默**（如实打日志 + 失败落补发账）。
 */
export async function pushImOwnerNotice(db: ImDb, message: string, kind: string): Promise<void> {
  try {
    const targets = resolveOwnerTargets(db);
    if (targets.length === 0 || !message) return;
    await sendTextToTargets(db, '', targets, message, kind);
  } catch (err) {
    console.error(`[IM] pushImOwnerNotice 异常（kind=${kind}）：${(err as Error).message || String(err)}`);
  }
}

/**
 * 向**已解析出的**目标发文本，失败落同一本补发账（`zx_20260924 M5` 抽出：推件路"超限改发文本说明"
 * 与 `pushImNotify` 必须走**同一套**发送+落账语义，否则同一次通知里"正文到了、说明没到"两条真相）。
 */
async function sendTextToTargets(
  db: ImDb,
  taskId: string,
  targets: ImNotifyTarget[],
  message: string,
  kind: string,
): Promise<void> {
  if (targets.length === 0 || !message) return;
  // zx_20261013_2 批一（维特根斯坦·意义即使用 / 王阳明·知行合一）: 取发送模块与"真发"**同置受控区**。
  //   此前 `await import('../../ipc/im.ipc.js')` 在循环之外、`pushImNotify` 的 catch 之内——该模块
  //   **静态** `import { ipcMain } from 'electron'`，一旦取不到（electron 未就绪 / 模块加载失败）即抛，
  //   被 `pushImNotify` 的裸 catch 吞掉 ⇒ 账上一条意图、补发账零行、送达零行（2026-10-13 实机）。
  //   `handled` 记"已按 `r.ok` 处置过的目标数"：catch 里只补落**剩下那些**，既不漏也不重复落账。
  let handled = 0;
  try {
    const { sendImCompletionNotice } = await import('../../ipc/im.ipc.js');
    for (const tg of targets) {
      const r = await sendImCompletionNotice(tg.channelId, tg.externalUserId, taskId, message);
      if (!r.ok) {
        // M2(空性·无常/毛选·自我批评): 关键通知发送失败落 outbox 短窗补发(不静默丢)
        // M3(管子·度量衡): 连同**真原因**一起入账——此前原因被 sendImCompletionNotice 的 catch 吞掉。
        const { enqueueImOutbox } = await import('./im-outbox.js');
        enqueueImOutbox(db, { channelId: tg.channelId, externalUserId: tg.externalUserId, taskId, kind, message }, r.error);
      }
      handled++;
    }
  } catch (err) {
    // 取不到发送模块（或发送循环本身抛）⇒ **不得静默**：逐目标如实落同一本补发账。
    //   与 `r.ok === false` **同账、同因由形态**——三本账里"未送达"那一本必须写得下这一种失败，
    //   否则用户在补发页永远看不到"这次根本没发出去"。
    const why = `发送模块不可用：${(err as Error).message || String(err)}`;
    console.error(`[IM] ${why}（task=${taskId.slice(0, 8)}，${targets.length - handled} 个目标转落补发账）`);
    const { enqueueImOutbox } = await import('./im-outbox.js');
    for (const tg of targets.slice(handled)) {
      enqueueImOutbox(db, { channelId: tg.channelId, externalUserId: tg.externalUserId, taskId, kind, message }, why);
    }
  }
}

/**
 * zx_20260924 M5（毛选·实事求是 / 康德·范畴统一）: 任务完成时把**登记的主成果文件**推回来源会话。
 *
 * 三条边界，每条都取"如实"那一侧：
 *  ① **只推来源会话**：任务没有来源会话（GUI/定时创建、或来源渠道已没了）⇒ **不推**，日志如实记因。
 *     不按 `pushImNotify` 的"最近 1:1 私聊"回落——文字可以投给最近说过话的人，**一个 20MB 的件不行**。
 *  ② **超限不推件、改发文本说明**：闸门见 `planPrimaryPush`（单件 20MB / 至多 3 件）。
 *     ⚠ 说明里的每一句都由 `describePrimaryPushOutcome` 一处出，且**先说发了哪些、再说哪些为什么没发**——
 *     只报"有几件没发"等于把选择权（自己下载还是重产出）从用户手里拿走。
 *  ③ **失败落同一本账**：发件失败走 `enqueueImOutbox`（带 `mediaPath/mediaKind`），与文本失败**同一个表、
 *     同一套 1/2/4 退避、同一个 `dead` 终态**——不得因为"这次是文件"就换一本账（那样用户在补发页
 *     看到的"未送达"就只统计得到文字，件丢了没人知道）。补发时由 `defaultSend` 按 `mediaPath` 发件，不降级成文件名。
 *
 * 不抛：通知失败不阻断任务收尾（与 `pushImNotify` 同口径）。
 */
export async function pushPrimaryDeliverables(db: ImDb, taskId: string): Promise<void> {
  try {
    const target = resolveImOriginTarget(db, taskId);
    if (!target) {
      // 如实登记"为什么没推"——不静默。这行日志是"件没到"时唯一的线索。
      console.log(`[M5] 任务无来源会话（或来源渠道/收件人已失效），不推送主成果: ${taskId.slice(0, 8)}`);
      return;
    }
    // zx_20260930 M4-1 **登记一处刻意差异**(不改)：本处**不滤探针**，只按 `is_primary = 1` 取主成果。
    //   理由：`is_primary` 是**显式指派**（人标的 / 引擎 `autoAssignPrimary` 标的），而探针判据是**按名字推断**。
    //   两者相抵时以显式为准——这正是 zx_20260916_3 M2 立下的「探针身份应当被**宣告**，不该被**推断**」：
    //   一件被明确指为"本次主成果"的东西，不该因为名字里有 `_tmp` 就默默不发。故此处**不**改走 `deliverableScopeSql`。
    const rows = db.prepare(
      "SELECT id, name, file_path FROM wa_deliverables WHERE task_id = ? AND status != 'retired' AND is_primary = 1 ORDER BY updated_at DESC, rowid DESC",
    ).all(taskId) as Array<{ id: string; name: string; file_path?: string | null }>;
    if (rows.length === 0) return; // 没有主成果 ⇒ 无话可说（不发"本次附上 0 件"这种废话）
    const { planPrimaryPush, describePrimaryPushOutcome, describePrimaryPushFile } = await import('../im-primary-push.js');
    const plan = planPrimaryPush(rows, {
      sizeOf: (p) => { try { const st = fs.statSync(p); return st.isFile() ? st.size : null; } catch { return null; } },
    });
    if (plan.files.length === 0) {
      // 一件都发不出去 ⇒ **改发文本说明**（如实），不发一串空文件。
      await sendTextToTargets(db, taskId, [target], describePrimaryPushOutcome(plan), 'primary_deliverable');
      return;
    }
    const { enqueueImOutbox } = await import('./im-outbox.js');
    for (const f of plan.files) {
      // 预览文本进账（`message`）：一是失败那条对话行不该是一片空白，二是补发页要说得清"补的是哪一件"。
      const preview = describePrimaryPushFile(f);
      try {
        // zx_20261013_2 批一: 取发送模块**置于本 try 内**——import 失败与发送失败**同走一条落账路**
        //   （此前它在循环外、外层 catch 之内 ⇒ import 一抛，所有件静静丢、一本账都不落）。
        const { sendImMedia } = await import('../../ipc/im.ipc.js');
        await sendImMedia(target.channelId, target.externalUserId, { path: f.path, kind: f.kind, name: f.name });
      } catch (err) {
        enqueueImOutbox(
          db,
          { channelId: target.channelId, externalUserId: target.externalUserId, taskId, kind: 'primary_deliverable', message: preview, mediaPath: f.path, mediaKind: f.kind },
          (err as Error).message || String(err),
        );
      }
    }
    // 未附上的件（超限/盘上没了）**逐条说明**——即使件发出去了，这句也不能省：
    // "发了 1 件"与"那 1 件是什么、另外 2 件在哪"是两件事。
    if (plan.skipped.length > 0) {
      const onlySkipped = { files: [], skipped: plan.skipped };
      await sendTextToTargets(db, taskId, [target], describePrimaryPushOutcome(onlySkipped), 'primary_deliverable');
    }
  } catch (err) {
    // zx_20261013_2 批一: 同 `pushImNotify`——不阻断，但不静默。
    console.error(`[IM] pushPrimaryDeliverables 异常（task=${taskId.slice(0, 8)}）：${(err as Error).message || String(err)}`);
  }
}

// A1 每任务每次暂停至多一条(短窗去重，防并发/嵌套同任务双发)
const pauseNotifiedAt = new Map<string, number>();
const PAUSE_NOTIFY_COOLDOWN_MS = 90_000;

/**
 * A1 agent 判定需人工介入的暂停 → 通知创建人(标题+原因+处理引导)。用户主动暂停不经此。
 * fire-and-forget：调用方(暂停分支)不 await，不阻断主流程。
 */
export function markPauseNeeded(db: ImDb, taskId: string, reason: string): void {
  try {
    if (!boolSetting(settingOf(db, 'im.notify_pause_needed', 'true'))) return;
    const last = pauseNotifiedAt.get(taskId) || 0;
    if (Date.now() - last < PAUSE_NOTIFY_COOLDOWN_MS) return;
    pauseNotifiedAt.set(taskId, Date.now());
    // P0-4：文案由单一构造器出（标题/状态词现查 `wa_tasks`，本处只给句框架与原因）
    void pushImNotify(db, taskId, buildTaskNotice(db, taskId, 'paused', { detail: reason }).message, 'pause_needed');
  } catch (err) {
    // zx_20261013_2 批一（毛选·实事求是）: 同族第三处——`void pushImNotify(...)` 之前的**构造/取设置**那一跳
    //   若抛（`boolSetting`/`settingOf`/`buildTaskNotice`），此前同样是裸 `catch {}` 静默。
    //   不阻断暂停，但不静默——`markPauseNeeded` 是"该通知人工介入"的最后一跳，它哑了没人知道。
    console.error(`[IM] markPauseNeeded 异常（task=${taskId.slice(0, 8)}）：${(err as Error).message || String(err)}`);
  }
}
