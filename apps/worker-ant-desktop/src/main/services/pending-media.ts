/**
 * zx_20260921 M1（亚里士多德·潜能与现实 / 维特根斯坦·意义即使用）: **入站媒体与任务之间那一截线**。
 *
 * 病根（方案 §1.1）：`saveInboundMedia` 真把件写到 `attachments/<UTC 日期>/` 并**返回 `savedPath`**，
 * 而 `im-router.ts` 只用它拼一句回执就**丢掉**——盘上有件、库里**没有"盘上哪一份"这句话**
 * ⇒ 下一条消息无从取件；`context_json.attachments` 全仓**零处**写，而 `taskHasMedia`
 * （`core/model-request.ts`）**只读不写** ⇒ `hasMedia` 恒假 ⇒ `vision` 恒不参与选型。
 * 一句话：**件在盘上，路没修**。
 *
 * 规则（承用户 2026-09-21 裁定，方案 §3-M1）：微信发图**仍然止步不回话、不建任务**（上轮 D3 裁定不被推翻）。
 * 改走「**暂存最近一件 + 下一条文字挂载**」——用户接着发一句「分析这张图」时，把它挂到新建任务上。
 * 这贴近微信真实用法：**先发图、再说话**。
 *
 * ⚠ 本模块**零依赖**（只 `node:path` + 类型），故可被受控回归直跑真实现——
 *   "窗口真的生效、取过真的取不到"这些话，只有跑一遍才算证过。
 */
import path from 'node:path';
// `import type` **编译期即抹除**：本模块运行时仍只依赖 `node:path`，受控回归照样能直跑真实现。
import type Database from 'better-sqlite3';
import { ATTACHMENTS_DIR, type InboundMedia } from './im-media.js';

/**
 * 「最近的件」认多久（**单点真源**）。
 *
 * 10 分钟：够一次"发图 → 打字"的间隔（含边看图边想），又短到不会把上一条无关消息的图捡回来。
 * 改这个值只改这里一处——窗口比较在 SQL 内用同一基准（见 `takePendingMedia`）。
 */
export const PENDING_MEDIA_WINDOW_MS = 10 * 60 * 1000;

/** 取到的一件：`InboundMedia` + **盘上路径**（这一项才是 M1 要接上的那一截）。 */
export interface PendingMedia extends InboundMedia {
  /** 盘上**绝对路径**（`saveInboundMedia` 返回的那个）。 */
  path: string;
}

/**
 * 把 `Date` 写成 SQLite `datetime('now')` 的**同款字符串**（`YYYY-MM-DD HH:MM:SS`，**UTC**）。
 *
 * 之所以要这一步：库内 `wa_im_conversations.created_at` 的默认值是 `datetime('now')` ⇒ 存的是 **UTC**
 * 文本；而 `Date` 是绝对时刻。**两者之间只允许通过这个函数换算**——
 * 直接拿本地墙钟（+0800）去比大小会**整整错 8 小时**，且这种错**不会自己暴露**（结论对、依据错）。
 * 承 `feedback_timezone_clock_basis.md`。
 */
function utcSqlDatetime(d: Date): string {
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * 取「该用户在这个渠道上**最近的、还没被用掉的那一件**」，**取即消费**。
 *
 * 谓词（全部落在 SQL 里，与库内同一时间基准）：
 *   同 `channel_id` · 同 `external_user_id` · `direction='inbound'` · `message_json` 有 `saved_path`
 *   · 没有 `media_consumed_at`（**一次性**——防同一张图被挂到多个任务）· `created_at` 在窗口内
 *   · `created_at <= 本条文字消息的时刻`（见 `beforeId`）
 * 排序按 `rowid`（**到达次序**，见下）⇒ **最近一件**。
 *
 * ⚠ **为什么按 `rowid` 而不按 `created_at`**：该列是 `datetime('now')`，**秒级**——
 *   同一秒内"先文字、后图片"与"先图片、后文字"**列值一模一样**，分不开。上一版据此写
 *   `created_at <= (本条的 created_at)`，被一条标本当场证伪（**后到的图照挂到先建的任务上**）。
 *   `rowid` 是插入次序、逐条递增，才真正表达"这条在它之前到"。**窗口判定仍用 `created_at`**
 *   （那是"多久算过期"，与次序无关）。
 *
 * @param beforeId 当前这条**文字**消息的入站行 id。给了就只认**到达次序在它之前**的件——
 *   否则"先说『分析这张图』、随后才发图"会把**后到的**图挂到**先建的**任务上（顺序颠倒的误挂）。
 *   不给则退化为"不晚于此刻"。
 *
 * @returns 取到则返回件（并**当场消费**）；没有则 `undefined`——**不是**空对象，两者排查时不同义。
 */
export function takePendingMedia(
  db: Database.Database,
  opts: { channelId: string; externalUser: string; now?: Date; beforeId?: string },
): PendingMedia | undefined {
  const now = opts.now ?? new Date();
  const cutoff = utcSqlDatetime(new Date(now.getTime() - PENDING_MEDIA_WINDOW_MS));

  let row: { id: string; message_json: string } | undefined;
  try {
    const params: unknown[] = [opts.channelId, opts.externalUser, cutoff];
    let beforeSql = '';
    if (opts.beforeId) {
      beforeSql = 'AND rowid <= (SELECT rowid FROM wa_im_conversations WHERE id = ?)';
      params.push(opts.beforeId);
    }
    row = db.prepare(
      `SELECT id, message_json FROM wa_im_conversations
        WHERE channel_id = ?
          AND external_user_id = ?
          AND direction = 'inbound'
          AND json_extract(message_json, '$.saved_path') IS NOT NULL
          AND json_extract(message_json, '$.media_consumed_at') IS NULL
          AND created_at >= ?
          ${beforeSql}
        ORDER BY rowid DESC
        LIMIT 1`
    ).get(...params) as { id: string; message_json: string } | undefined;
  } catch {
    // 读不到（表结构异常 / JSON 列被污染）⇒ **当没有件**：挂不上附件是降级，不该把建任务整条搞挂。
    return undefined;
  }
  if (!row) return undefined;

  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(row.message_json) as Record<string, unknown>; } catch { return undefined; }
  const savedPath = typeof parsed.saved_path === 'string' ? parsed.saved_path : '';
  // 纵深防御：真库里这一列是**我们**写的，但路径随后会被 `readFile` 读——只认 `attachments/` 之下那一支。
  //   段名比对（而非前缀比对）与 `im-media.ts` 的 `shownAttachmentPath` 同一口径。
  if (!savedPath || !path.resolve(savedPath).split(path.sep).includes(ATTACHMENTS_DIR)) return undefined;

  // **取即消费**：写 `media_consumed_at` 键（不新造列）。写失败也照样把件交出去——
  //   最坏结果是同一件被挂两次（可见的重复），胜过"用户发了图却永远挂不上"（不可见的丢失）。
  try {
    db.prepare('UPDATE wa_im_conversations SET message_json = json_set(message_json, \'$.media_consumed_at\', ?) WHERE id = ?')
      .run(utcSqlDatetime(now), row.id);
  } catch { /* 消费标记写不进去不影响本次取件 */ }

  const media: PendingMedia = { kind: String(parsed.kind ?? ''), path: savedPath };
  if (typeof parsed.file_name === 'string' && parsed.file_name) media.fileName = parsed.file_name;
  if (typeof parsed.size_bytes === 'number' && Number.isFinite(parsed.size_bytes)) media.sizeBytes = parsed.size_bytes;
  return media;
}

/**
 * 把取到的一件**并进任务上下文**的形状（`context_json.attachments[i]`）。
 *
 * 单独成函数是为了让 rr 能**断言这个形状本身**，而不必从 `im-router.ts` 的内联字面量里抠。
 * `channel` 记下**从哪个渠道来的**——同一件日后可能从多家进来，排查时要分得开。
 */
export function attachmentEntry(media: PendingMedia, channelType: string, at: Date): Record<string, unknown> {
  return {
    path: media.path,
    ...(media.fileName ? { fileName: media.fileName } : {}),
    kind: media.kind,
    ...(media.sizeBytes !== undefined ? { sizeBytes: media.sizeBytes } : {}),
    channel: channelType,
    at: at.toISOString(),
  };
}

/**
 * **把若干件「并进任务上下文」的唯一写者**（`context_json.attachments[i]`）。
 *
 * 追加**不覆盖**：目标任务可能已经有件（建任务时挂的、或上一次回复挂的），覆盖会让先前那件
 * 在账上"从未存在过"——件还躺在盘上，但没有任何一句话说得清它是谁。
 *
 * 为什么抽成独立函数（zx_20261013_1 批二）：IM 入站（`attachPendingMediaToTask`）与桌面 GUI 挂件
 * （`services/task-attachments.ts`）**两条来路**要写同一格；若各写一份 `json_set`，就是"同一条规则的
 * 第二次实现"（G8/G9 老病的温床）。写者收此一处 ⇒ 两条路落库的形状/回读口径逐字一致。
 *
 * `entries` 为空 ⇒ **不写**（"没有"与"空数组"排查时不同义；且避免把 `[]` 盖到既有件上）。
 */
export function appendTaskAttachments(
  db: Database.Database,
  taskId: string,
  entries: ReadonlyArray<Record<string, unknown>>,
): void {
  if (entries.length === 0) return;

  // 旧值只在**确实是数组**时续用；读不出/不是数组就从空数组续起（不把坏值原样带下去）。
  let list: unknown[] = [];
  try {
    const row = db
      .prepare("SELECT json_extract(COALESCE(context_json,'{}'), '$.attachments') AS a FROM wa_tasks WHERE id = ?")
      .get(taskId) as { a?: string | null } | undefined;
    if (typeof row?.a === 'string') {
      const parsed = JSON.parse(row.a) as unknown;
      if (Array.isArray(parsed)) list = parsed;
    }
  } catch { /* 旧值读不出 ⇒ 从空数组续起 */ }
  list.push(...entries);

  // 单次 `json_set` + **单组** path/value ⇒ 层数恒为 1（本仓 2026-09-24 刚因"手工套娃少一层"吞过一次
  //   语法错，见 `project.ipc.ts` 缺陷B）。数组必须 `json(?)` 包一层，否则落库的是字符串而非 JSON 数组。
  db.prepare("UPDATE wa_tasks SET context_json = json_set(COALESCE(context_json,'{}'), '$.attachments', json(?)) WHERE id = ?")
    .run(JSON.stringify(list), taskId);

  // **写后回读**：不验就等于没写。件已被消费掉（IM 路）/已落盘（GUI 路），落库若没成，用户就"发了件却永远挂不上"——
  //   这是不可见的丢失，必须留一行可查的线索（不抛：挂不上件是降级，不该把整条消息处理搞挂）。
  try {
    const back = db
      .prepare("SELECT json_array_length(json_extract(COALESCE(context_json,'{}'), '$.attachments')) AS n FROM wa_tasks WHERE id = ?")
      .get(taskId) as { n?: number | null } | undefined;
    if ((back?.n ?? 0) !== list.length) {
      console.error(`[pending-media] 附件落库回读不符（task=${taskId.slice(0, 8)} 写=${list.length} 读=${back?.n ?? null}）——该件已消费但未挂上`);
    }
  } catch { /* 回读失败不影响本次取件 */ }
}

/**
 * **唯一的取件出口**：取「该用户最近一件未消费的件」并挂到**已经落地的那张任务**上。
 *
 * 为什么要有它（2026-09-24 §2e，实机 E2E 当场照出）：件原先只在**建任务路**
 * （`handleCreateTask`）被取用。而「先发件、再说话」这句话若不是命令式，会先被 `handleAgentReply`
 * 当成"对该用户暂停任务的回复"接走（`im-router.ts` 步骤1）——**根本走不到建任务路** ⇒ 件停在盘上
 * 无人认领。实机表现为：`data/attachments/` 里件好好的，`context_json.attachments` 却是空的，
 * agent 只能自己去 `ls` 附件目录碰运气（用户目的侥幸达成，**设计的挂载链一次都没跑**）。
 *
 * 承用户 2026-09-24 裁定：「**件挂到本条文字最终落到的那张任务上**」——回复路就挂到被恢复的任务，
 * 建任务路就挂到新任务。两条路都调本函数 ⇒ `takePendingMedia` 只剩这一个调用点，
 * "取即消费"的时机不再散落两处（散落正是"某条新路忘了取件"的温床）。
 *
 * 落库那一半已抽 `appendTaskAttachments`（一处写者，与 GUI 挂件共用）。
 *
 * @returns 取到并挂上则返回件；没有件则 `undefined`（**不写空数组**——"没有"与"空"排查时不同义）。
 */
export function attachPendingMediaToTask(
  db: Database.Database,
  opts: { channelId: string; externalUser: string; channelType: string; taskId: string; beforeId?: string; now?: Date },
): PendingMedia | undefined {
  const now = opts.now ?? new Date();
  const media = takePendingMedia(db, {
    channelId: opts.channelId,
    externalUser: opts.externalUser,
    now,
    ...(opts.beforeId ? { beforeId: opts.beforeId } : {}),
  });
  if (!media) return undefined;
  appendTaskAttachments(db, opts.taskId, [attachmentEntry(media, opts.channelType, now)]);
  return media;
}
