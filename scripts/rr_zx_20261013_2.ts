/**
 * zx_20261013_2 受控复跑 —— 「通」：**凡系统"账上说该发生、路上却没发生"的地方，要么把它真做通，
 *   要么如实说出它为什么不通——不许让"静默"冒充"办好了"**。
 *
 * 口径（维特根斯坦·意义即使用 / 毛选·实事求是 / 道德经·知不知上 / 管子·度量衡 / 王阳明·知行合一）：
 *   · 批一「通知路：异常不得静默」—— 2026-10-13 实机：`wa_im_notify_log` 有 `pause_needed` 意图行、
 *     `wa_im_outbox` 零行、`wa_im_conversations` 零 outbound ⇒ **三账互不相容**，唯一自洽解是
 *     "发送路径某一跳抛了、被整函数裸 `catch {}` 吞掉"。故本批把三处同族裸 catch 一次治净，
 *     并把动态 `import('../../ipc/im.ipc.js')` 从"循环之外、catch 之内"移进**与真发同一个受控区**。
 *   · 批二「收口：到顶也不得死锁」—— 两处**同形**根因：① band 5 名单保留 `finalize_task` 却不含
 *     `update_task_status`，而"收尾子任务"只能靠后者 ⇒ **结构死锁**；② `prematureEnd` 闸抢在良性子任务闸
 *     之前把父判成"低分过早结束"（真库 `7c39678e`：整份 8 里程碑方案只做完 M0 ⇒ 必判 45 分）。见 B 组。
 *   · 批三「拆解：拆得完，否则说得明」—— 病根：方案 8 里程碑 vs `MAX_CHILD_BREADTH=5`，首拆只建 M0~M4、
 *     M5~M7 从未创建；且两路都只说"槽位已满/其余未建"（**死路**），从不说"哪些里程碑没拆、之后怎么办"。
 *     **本轮只做"如实告知"**（滚动拆解择机，见方案 §2 批三 (a)）：新增 `shortfallNotice`（一处实现，
 *     引擎路/IM 路同取）把"没拆完"说成一句**给人看**的话。见 C 组。
 *   · 批四「币种口径：钱，要说是哪国的钱」—— 同页两处金额、两种货币（模型单价上限=美元/1k、任务预算=¥人民币）
 *     却都叫"成本/费用上限"⇒ 用户无从分辨。**不改币种**（ANS 定价基准即美元，改显示＝名实不符），
 *     只补文案说明是哪一场游戏 + 核 renderer **产物**含该串（词表第二落点）。见 D 组。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：判据一律静态导入生产导出（被删/改名即编译期失败）。
 *   G-2 **两侧标本**：凡判"命中/放行/收窄"的判据，反面标本（不命中）一并喂。
 *   G-5 判"用户可见文案还在不在"读 `stripKeepingLines` 后的代码。
 *   G-6 **无轮次字面量**：本轮方案路径/脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 *   ⚠ 计数器类断言一律**正面**（"值从 0 变 1"），不只断言"不抛"。
 *   ⚠ IM 真发送走动态 `import('electron')`（rr 起不了 electron）⇒ **发送必失败**，故本轮补发账
 *     `wa_im_outbox` 在受控回归里**可被正面断言**（这正是批一要立的那条痕）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：判据引用的生产符号**全部静态导入** ⇒ 被删/改名即编译期失败。
import { pushImNotify, pushPrimaryDeliverables, resolveImNotifyTargets } from '../apps/worker-ant-desktop/src/main/core/im/im-notify.js';
import { IM_AGG_KINDS } from '../apps/worker-ant-desktop/src/main/core/im/im-notify-log.js';
// 批二：两档预算名单（真名单，不在断言里照抄一份）+ "父是否在等子任务"的一处真源判据。
import { BUDGET_HARD_STOP_TOOLS, BUDGET_WARN_TOOLS } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { failedChildren, unfinishedChildren, childrenPendingAttention } from '../apps/worker-ant-desktop/src/main/core/children-gate.js';
import { shortfallNotice, DECOMPOSE_MAX_SUBTASKS } from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';
import { MAX_CHILD_BREADTH } from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
/** 等值断言（把实际值一并打出——红的时候要能立刻看出"差在哪"）。 */
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
/** 静态判据读**原文**；判"用户可见文案还在不在"用 `CODE()`（G-5）。 */
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''); // zx_20261013_2

/* ── 夹具 ────────────────────────────────────────────────────────────────── */

type AnyDb = import('better-sqlite3').Database;

/** 逐列照抄 `database.ts` DDL（含批一依赖的 `wa_im_outbox` 与 `wa_im_conversations` 出站四列）——
 *  既不缺列也不放宽（承 `feedback_rr_fixture_production_order`：夹具比生产宽松，断言就只是自我印证）。 */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'p', parent_task_id TEXT DEFAULT '',
  title TEXT DEFAULT '', description TEXT DEFAULT '', status TEXT DEFAULT 'pending',
  context_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT DEFAULT '', status TEXT);
CREATE TABLE wa_im_conversations (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT,
  message_json TEXT, direction TEXT, status TEXT, last_error TEXT, outbox_id TEXT,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_notify_log (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', task_id TEXT DEFAULT '',
  kind TEXT NOT NULL, suppressed INTEGER DEFAULT 0, at INTEGER NOT NULL);
CREATE TABLE wa_im_outbox (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT, task_id TEXT,
  kind TEXT DEFAULT 'notification', message TEXT DEFAULT '', attempts INTEGER DEFAULT 0,
  status TEXT DEFAULT 'pending', next_retry_at INTEGER, created_at TEXT DEFAULT (datetime('now')),
  last_error TEXT, last_attempt_at TEXT, media_path TEXT, media_kind TEXT);
`;

const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d as unknown as AnyDb; };

const addTask = (db: AnyDb, id: string, status: string, opts: { project?: string; parent?: string; ctx?: Record<string, unknown> } = {}): void => {
  db.prepare(`INSERT INTO wa_tasks (id, project_id, parent_task_id, title, status, context_json)
              VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, opts.project ?? 'p', opts.parent ?? '', id, status, JSON.stringify(opts.ctx ?? {}));
};
const statusOf = (db: AnyDb, id: string): string => (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;
/** 一套能让 `resolveImNotifyTargets` 回落到「最近一条 1:1 私聊 inbound」的最小 IM 世界。 */
const addImChannel = (db: AnyDb, channelId = 'c1', externalUser = 'u1', status = 'active'): void => {
  db.prepare('INSERT INTO wa_im_channels (id, channel_type, status) VALUES (?, ?, ?)').run(channelId, 'wechat', status);
  db.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction) VALUES (?, ?, ?, '{}', 'inbound')")
    .run(`cv-${channelId}`, channelId, externalUser);
};
/** 意图账：真发（`suppressed=0`）的行数 / 全部分类明细。 */
const notifySent = (db: AnyDb, kind: string, project?: string): number =>
  (db.prepare(`SELECT COUNT(*) AS c FROM wa_im_notify_log WHERE kind = ? AND suppressed = 0${project ? ' AND project_id = ?' : ''}`)
    .get(...(project ? [kind, project] : [kind])) as { c: number }).c;
const notifyAll = (db: AnyDb): Array<{ kind: string; suppressed: number; project_id: string }> =>
  db.prepare('SELECT kind, suppressed, project_id FROM wa_im_notify_log ORDER BY at, rowid').all() as Array<{ kind: string; suppressed: number; project_id: string }>;
/** 补发账（批一的"该有一本痕"）。 */
const outboxRows = (db: AnyDb): Array<{ kind: string; status: string; last_error: string | null; message: string; channel_id: string; external_user_id: string }> =>
  db.prepare('SELECT kind, status, last_error, message, channel_id, external_user_id FROM wa_im_outbox ORDER BY rowid').all() as never;
/** 未送达在**对话视图**的到场行（`recordFailedConversation` 落的 `outbound/failed`）。 */
const outboundFailed = (db: AnyDb): Array<{ id: string; outbox_id: string | null; last_error: string | null }> =>
  db.prepare("SELECT id, outbox_id, last_error FROM wa_im_conversations WHERE direction = 'outbound' AND status = 'failed' ORDER BY rowid").all() as never;

/**
 * 从 `src` 里抽 `marker` 之后**配平花括号**的函数体（跳过引号内括号、含反斜杠转义）。
 * 用于判"某一跳在不在受控区（try）之内"——注释已剥离，故只能读真代码。
 */
function fnBody(src: string, marker: string): string {
  const at = src.indexOf(marker);
  if (at < 0) return '';
  let i = src.indexOf('(', at + marker.length);
  if (i < 0) return '';
  let depth = 0; let quote = ''; let j = i;
  for (; j < src.length; j++) {
    const ch = src[j] as string;
    if (quote) { if (ch === '\\') { j++; } else if (ch === quote) { quote = ''; } continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) { j++; break; } }
  }
  const b0 = src.indexOf('{', j);
  if (b0 < 0) return '';
  depth = 0; quote = '';
  for (let k = b0; k < src.length; k++) {
    const ch = src[k] as string;
    if (quote) { if (ch === '\\') { k++; } else if (ch === quote) { quote = ''; } continue; }
    if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return src.slice(b0, k + 1); }
  }
  return src.slice(b0);
}

async function main(): Promise<void> {
  // ═══ A｜通知路：异常不得静默（毛选·实事求是 / 维特根斯坦·意义即使用）══════════════════════
  console.log('\n【A】通知路：无目标即返 · 有目标则必留痕（成功走送达，失败走补发账）');
  {
    // A-1 「该落痕」（2026-10-13 实机同形标本）：启用渠道 + 1:1 inbound + 任务无来源会话（回落最近私聊）。
    const db = mkdb(); addImChannel(db); addTask(db, 't1', 'executing', { project: 'p1' });
    const targets = resolveImNotifyTargets(db as never, 't1', true);
    eq(targets.length, 1, 'A-1a 前置：GUI 任务（ctx 无 channel）⇒ 回落到最近 1:1 私聊，恰 1 个目标（不是"没人可发"）');
    await pushImNotify(db as never, 't1', '任务暂停：需人工介入', 'pause_needed');
    eq(notifySent(db, 'pause_needed', 'p1'), 1, 'A-1b ★0→1：意图账 `pause_needed`（`suppressed=0`）**恰 1 条**');
    ok(outboxRows(db).length >= 1,
      'A-1c ★★该落痕：发送未成 ⇒ 补发账 `wa_im_outbox` **≥1 行**（此前任一跳抛 ⇒ 三账皆空、诊断只能靠"什么都没发生"反推）',
      `实测 ${outboxRows(db).length} 行`);
    eq(outboxRows(db)[0]!.kind, 'pause_needed', 'A-1d 补发账**保留类目**（kind 不丢——补发页才说得清"补的是哪一种通知"）');
    ok((outboxRows(db)[0]!.last_error || '').length > 0, 'A-1e ★补发账带**真原因**（M3 记因；非空字符串，不是"未送达"三个字）',
      String(outboxRows(db)[0]!.last_error || '').slice(0, 60));
    eq(outboundFailed(db).length, 1, 'A-1f ★未送达同步在**对话视图**到场（`direction=outbound,status=failed` 恰 1 行）——一账一视图同说');
    ok(!!outboundFailed(db)[0]!.outbox_id, 'A-1g 那条对话行与补发账**真关联**（`outbox_id` 非空——补发成功时可翻回 sent）');

    // A-2 「不该误报」（反证）：渠道 `inactive` ⇒ 无目标 ⇒ 意图/补发账**双零**（不"逢发必记失败"）。
    {
      const db2 = mkdb(); addImChannel(db2, 'c1', 'u1', 'inactive');
      addTask(db2, 't2', 'executing', { project: 'p2' });
      eq(resolveImNotifyTargets(db2 as never, 't2', true).length, 0, 'A-2a 前置：唯一渠道 `inactive` ⇒ 目标 **0**（`imChannelEnabledSql` 口径）');
      await pushImNotify(db2 as never, 't2', 'x', 'pause_needed');
      eq([notifySent(db2, 'pause_needed'), outboxRows(db2).length, outboundFailed(db2).length], [0, 0, 0],
        'A-2b ★反证：无目标 ⇒ 意图账/补发账/对话视图**三零**——A-1 不是"凡调用必落痕"的恒真式');
    }

    // A-3 「完成类目」在**子任务**上亦落意图行（类目未被特判抹掉）。
    {
      const db3 = mkdb(); addImChannel(db3);
      addTask(db3, 'P', 'executing', { project: 'p3' });
      addTask(db3, 'C', 'completed', { project: 'p3', parent: 'P' });
      await pushImNotify(db3 as never, 'C', '子任务已完成', 'notification');
      eq(notifySent(db3, 'notification', 'p3'), 1, 'A-3 ★完成类目 `notification` 在**子任务**上亦落意图行 0→1（不限顶层）');
      eq(statusOf(db3, 'C'), 'completed', 'A-3b 该子任务确为 completed（标本本身成立）');
    }

    // A-4 结构判据（**区分新旧码的那把尺**）：三处同族裸 catch 一次治净 + 动态 import 归入受控区。
    {
      const NOTIFY = CODE(`${A}/src/main/core/im/im-notify.ts`);
      const bare = NOTIFY.match(/catch\s*\{\s*\}/g) ?? [];
      eq(bare.length, 0, 'A-4a ★★去注释后 `im-notify.ts` **零**裸 `catch {}`（pushImNotify / sendTextToTargets / markPauseNeeded 三处同族病根一次治净）');
      const st = fnBody(NOTIFY, 'async function sendTextToTargets');
      const impIdx = st.indexOf("import('../../ipc/im.ipc.js')");
      const tryIdx = st.indexOf('try {');
      ok(impIdx > 0 && tryIdx > 0 && impIdx > tryIdx,
        'A-4b ★★动态 `import(\'../ipc/im.ipc.js\')` 与"真发"**同置受控区**（import 在 `try` 之内 ⇒ 取模块失败不再整段跳过 for 循环）');
      ok(/enqueueImOutbox\(/.test(st), 'A-4c 该受控区的失败出口走**同一本**补发账（`enqueueImOutbox` 在场）');
      ok(/console\.error\(/.test(NOTIFY), 'A-4d 异常至少上屏一次（`console.error` 在场——"不阻断"不等于"可静默"）');
    }

    // A-5 推件路同尺：发送模块取自**逐件循环之内**（此前在循环外 ⇒ import 一抛所有件静静丢）。
    {
      const NOTIFY = RD(`${A}/src/main/core/im/im-notify.ts`);
      const iLoop = NOTIFY.indexOf('for (const f of plan.files)');
      const iImp = NOTIFY.indexOf("import('../../ipc/im.ipc.js')", iLoop >= 0 ? iLoop : 0);
      ok(iLoop > 0 && iImp > iLoop,
        'A-5 ★推件路：`sendImMedia` 的发送模块取自**逐件循环之内**（import 失败与发送失败同走一条落账路）');
    }

    // A-6 反证：不得靠"放宽聚并/关掉聚并"来让标本变绿。
    eq(IM_AGG_KINDS, ['task_failed'], 'A-6 ★反证：`IM_AGG_KINDS` 仍**恰** `["task_failed"]`（未把 `pause_needed` 也纳入聚并来"制造"通过）');

    // A-7 聚并与落痕**各答各的问**：窗内第二条失败被聚并 ⇒ 仍入账、但**不再落补发账**。
    {
      const db7 = mkdb(); addImChannel(db7);
      addTask(db7, 't7a', 'executing', { project: 'p7' });
      await pushImNotify(db7 as never, 't7a', '失败1', 'task_failed');
      addTask(db7, 't7b', 'executing', { project: 'p7' });
      await pushImNotify(db7 as never, 't7b', '失败2', 'task_failed');
      eq([notifyAll(db7).length, notifySent(db7, 'task_failed', 'p7'), outboxRows(db7).length], [2, 1, 1],
        'A-7 ★★窗内第二条被聚并 ⇒ **仍入账**（总 2）但**不再落补发账**（outbox 仍 1）——聚并答"该不该出声"、落痕答"这次出没出去"');
    }

    // A-8 推件路无来源会话 ⇒ **不推**（如实日志），绝不误投给"最近说过话的人"。
    {
      const db8 = mkdb(); addImChannel(db8); addTask(db8, 't8', 'completed', { project: 'p8' });
      await pushPrimaryDeliverables(db8 as never, 't8');
      eq([notifySent(db8, 'primary_deliverable'), outboxRows(db8).length], [0, 0],
        'A-8 ★推件路：GUI 任务无来源会话 ⇒ 不推、不落补发账（文字可投最近私聊，**一个件不行**）');
    }
  }

  // ═══ B｜收口：到顶也不得死锁（毛选·主要矛盾 / 管子·度量衡）══════════════════════════════
  console.log('\n【B】收口：到顶也不得死锁（名单补口 + 闸顺序，两处同形根因）');
  {
    // ── B-1 「该放行」：band 5 ∧ 还有子任务没了结 ⇒ 「过早结束」判据不成立（不死锁）──────────
    // 真库标本 `7c39678e`（2026-10-13）：整份 8 里程碑方案只做完 M0，父在费用撞顶那一刻被 prematureEnd 抢判
    // 45 分；而按良性子任务闸本应落 `children_incomplete`。判据（含"先失败后未完成"）取生产真函数。
    {
      const db = mkdb();
      addTask(db, 'P', 'executing', { project: 'pb' });
      addTask(db, 'C1', 'pending', { project: 'pb', parent: 'P' });
      eq(unfinishedChildren(db as never, 'P').length, 1, 'B-1a 标本成立：`unfinishedChildren` 认出 1 个非终态子（pending）');
      ok(childrenPendingAttention(db as never, 'P') === true,
        'B-1b ★★该识别为「在等」：父还在等非终态子 ⇒ 判据为真 ⇒ `prematureEnd` 闸不得抢判"低分过早结束"');
    }
    {
      const db = mkdb();
      addTask(db, 'P', 'executing', { project: 'pb' });
      addTask(db, 'C1', 'failed', { project: 'pb', parent: 'P' });
      eq(failedChildren(db as never, 'P').length, 1, 'B-1c 标本成立：`failedChildren` 认出 1 个失败子（缺省开关下）');
      ok(childrenPendingAttention(db as never, 'P') === true,
        'B-1d ★失败子（未处置）同样算「还没了结」⇒ 真 ⇒ 父落 `children_failed` 良性暂停而非"低分过早结束"（先失败后未完成）');
    }

    // ── B-2 「不该误放」：band 5 ∧ 无 pending ⇒ 照常收口（原行为逐字不变）──────────────────
    {
      const db = mkdb();
      addTask(db, 'P', 'executing', { project: 'pb' });
      addTask(db, 'C1', 'completed', { project: 'pb', parent: 'P' });
      addTask(db, 'C2', 'archived', { project: 'pb', parent: 'P' });
      eq([unfinishedChildren(db as never, 'P').length, failedChildren(db as never, 'P').length], [0, 0],
        'B-2a 子任务全终态（completed/archived）⇒ 未完成 0 / 失败 0');
      eq(childrenPendingAttention(db as never, 'P'), false,
        'B-2b ★反证：无 pending ⇒ 判据为假 ⇒ `prematureEnd` 退回原式（不改收口行为，挡"改成恒真"的过宽变体）');
    }
    eq(childrenPendingAttention(mkdb() as never, 'NO-SUCH-PARENT'), false,
      'B-2c 无子任务 ⇒ 假（否则每个无子的任务都被判成"在等"，收口闸全线失效）');

    // ── B-2d/e 开关退回旧口径：`children_failed_pause=off` 只管 failed 那一半 ────────────────
    {
      const db = mkdb();
      db.prepare('INSERT INTO wa_settings (key, value) VALUES (?, ?)').run('engine.children_failed_pause', 'false');
      addTask(db, 'P', 'executing', { project: 'pb' });
      addTask(db, 'C1', 'failed', { project: 'pb', parent: 'P' });
      eq(childrenPendingAttention(db as never, 'P'), false,
        'B-2d 开关关 ⇒ 失败子不算"在等"（回到旧单判据 failed 视为终态放行）——与 `failedChildren` 的回退同向');
      addTask(db, 'C2', 'running', { project: 'pb', parent: 'P' });
      eq(childrenPendingAttention(db as never, 'P'), true,
        'B-2e 但**非终态子**在任何口径下都算"在等"（开关只管 failed 那一半，不放宽"父被未跑完的子永久扣住"）');
    }

    // ── B-3 接线与反证：「闸顺序」改动落点 + 名单不得放进"开新摊子"类工具 ───────────────────
    {
      const CLOSE = CODE(`${A}/src/main/core/exec-close.ts`);
      const preExpr = (CLOSE.match(/const prematureEnd = ([^;]+);/)?.[1] ?? '').trim();
      ok(preExpr.includes('budgetCapReached(') && preExpr.includes('maxSteps - 2') && preExpr.includes('!childrenPending'),
        'B-3a ★接线：`prematureEnd` = 「(预算到顶 ∨ 步数到顶) ∧ 非『在等』」——两半与"预算读同一真源"'
        + '（`budgetCapReached(`）一字未动，新加的只是合取一个"在等"闸', preExpr);
      ok(CLOSE.includes('const childrenPending = childrenPendingAttention(db, taskId)'),
        'B-3a′ 且"在等"取**生产真函数**（不是就地内联一份判据——否则判据自我印证）');
      const fin = CODE(`${A}/src/main/core/exec-finalize.ts`);
      ok(CLOSE.includes('childrenPendingAttention(db, taskId)') && fin.includes('unfinishedChildren(db, taskId)'),
        'B-3b ★一处真源：收口闸（exec-finalize）与过早结束闸（exec-close）**同取** `children-gate.ts`——不在两处各写一遍谓词');
      ok(!fin.includes("status NOT IN ('completed','failed','archived')"),
        'B-3c ★反证：exec-finalize 里那处**内联 SQL 已退场**（谓词只此一处；否则两处各判一遍必然分家——正是本轮病根）');

      const forbidden = ['read_file', 'execute_command', 'bash', 'edit_file', 'create_task'];
      ok(forbidden.every((t) => !BUDGET_HARD_STOP_TOOLS.includes(t)),
        'B-3d ★反证：band 5 名单未放进 ' + forbidden.join('/') + '（"到顶还能开新摊子/探索"即失守）',
        `HARD = ${BUDGET_HARD_STOP_TOOLS.join(',')}`);
      const closure = ['finalize_task', 'update_task_status', 'escalate_to_human', 'ask_user'];
      ok(closure.every((t) => BUDGET_HARD_STOP_TOOLS.includes(t)),
        'B-3e ★★「无路可退」的态不存在：band 5 保留**整套收尾/求助**工具箱 ' + closure.join('/')
        + '（`finalize_task` 是旧账；本轮补的是 `update_task_status`——收尾子任务只能靠它）',
        `HARD = ${BUDGET_HARD_STOP_TOOLS.join(',')}`);
      ok(BUDGET_WARN_TOOLS.includes('update_task_status'),
        'B-3f band 4 同一个洞一并补（`finalize_task` 也在册 ⇒ 只堵 band 5 会在 95% 档复发）');
    }

    // ── B-4 「复核」（方案 §2 批二 的 ⚠）：`update_task_status` 无写分入参 ⇒ 不需"band 5 只许置终态"围栏 ──
    {
      const CTRL = RD(`${A}/src/main/core/tools/control.ts`);
      const s = CTRL.indexOf('update_task_status: {');
      const e = CTRL.indexOf('execute: async', s);
      const uDecl = s >= 0 && e > s ? CTRL.slice(s, e) : '';
      ok(uDecl.length > 0 && !/(^|[^A-Za-z0-9_])(score|quality)([^A-Za-z0-9_]|$)/i.test(uDecl),
        'B-4a ★复核结论：`update_task_status` 的**入参声明**无 score/quality 字段 ⇒ 调用方无法传分',
        uDecl ? `${uDecl.split('\n').length} 行` : '(未切到块)');
      const body = CTRL.slice(e, CTRL.indexOf('enter_plan_mode: {', e));
      ok(body.includes('selfCompleteBan('),
        'B-4b 且**禁自完成**（`selfCompleteBan` 在场）：分一律由 `assessCompletionQuality` 从产出证据算出 ⇒ '
        + '"band 5 下改分逃逸质量闸"不成立，**无需**额外围栏（如实登记，不臆造一道闸）');
    }
  }

  // ═══ C｜拆解：拆不完要说得明（空性·缘起 / 道德经「知不知上」）══════════════════════════
  console.log('\n【C】拆解：拆不完要说得明');
  {
    // ── C-1 「该说」与「不该误报」：两只标本（承 feedback_predicate_needs_both_sides_specimen）──
    const over = shortfallNotice(8, 5);
    ok(over.includes('8') && over.includes('5') && over.includes('3')
      && over.includes('未建') && (over.includes('人工补齐') || over.includes('再拆')),
      'C-1a ★该有痕：规划 8 / 实建 5 ⇒ 一句**给人看**的话（三个数 + "未建" + 还能怎么补），不是"槽位已满"的拒绝口吻',
      over);
    ok(!over.includes('自动续拆') && !over.includes('已自动'),
      'C-1a′ ★不越界许诺：不得写成"会自动续拆"——系统眼下**不保证**这件事（写它就是本轮反复点名的"名实不符"）');
    ok(shortfallNotice(5, 5) === '' && shortfallNotice(3, 3) === '',
      'C-1b 反证·不该误报：建满（created ≥ planned）⇒ 空串（"建满"不得长出"未建满"的话）');
    const withMs = shortfallNotice(8, 5, 'M0、M1、M2、M3、M4、M5、M6、M7');
    ok(withMs.includes('里程碑') && withMs.includes('M7') && withMs.includes('8'),
      'C-1c 点名过里程碑时写进话里（维特根斯坦·意义即用法）：含"里程碑"与 M 号，数目落到具体的东西上', withMs.slice(0, 64));

    // ── C-2 「一处实现」：两路口径**同源**（不各写一份措辞＝两本账）──────────────────────
    const DEC = CODE(`${A}/src/main/core/task-decompose.ts`);
    const auto = fnBody(DEC, 'export async function autoDecomposeForTask(');
    ok(auto.includes('shortfallNotice('),
      'C-2a 引擎/启动路（`autoDecomposeForTask`）真调 `shortfallNotice`（不是就地又写一份措辞）');
    const IMR = CODE(`${A}/src/main/services/im-router.ts`);
    ok(IMR.includes('shortfallNotice('),
      'C-2b ★IM 路**同源**（同取 `task-decompose.ts` 那一处实现）');
    ok(!IMR.includes('其余未建'),
      'C-2b′ 反证：IM 路旧措辞「（槽位上限：规划 N 个，实建 K 个，**其余未建**）」已退场——死路不说"还能怎么补"');
    ok(DEC.includes('export function shortfallNotice('),
      'C-2c 该句**只此一处**定义（`task-decompose.ts` 导出，IM 路引入）');

    // ── C-3 反证：不得以"改大上限"冒充解决（既有裁定 D3 不放宽）──────────────────────────
    ok(DECOMPOSE_MAX_SUBTASKS === MAX_CHILD_BREADTH,
      'C-3a ★拆解上限仍**由引擎广度闸派生**（两处不得各写一个数）',
      `${DECOMPOSE_MAX_SUBTASKS} vs ${MAX_CHILD_BREADTH}`);
    const ACCT = stripKeepingLines(RD(`${A}/src/main/core/task-accounting.ts`)).join('\n');
    const breadthConsts = [...ACCT.matchAll(/MAX_CHILD_BREADTH\s*=\s*(\d+)/g)].map((m) => m[1]);
    ok(breadthConsts.length === 1 && Number(breadthConsts[0]) === MAX_CHILD_BREADTH,
      'C-3b ★反证：广度上限**未被改大**（全仓只一处定义，且与该常量同值）——不得用"改大它"冒充"拆得完"',
      breadthConsts.join(',') || '(未找到)');

    // ── C-4 反证：本轮**不做**滚动拆解 ⇒ 防重门一字未动（方案 §2 批三 (a) 择机）────────────
    ok(/if\s*\(\s*alreadyDecomposed\(opts\.db,\s*opts\.taskId\)\s*\)\s*return null;/.test(DEC),
      'C-4 本轮只做"如实告知"、未做滚动拆解 ⇒ `alreadyDecomposed` 那道防重门逐字仍在（不新增"续拆"路径）');
  }

  // ═══ D｜币种口径：钱，要说是哪国的钱（维特根斯坦·语言游戏）══════════════════════════
  console.log('\n【D】币种口径：钱，要说是哪国的钱');
  {
    const SP = RD(`${A}/renderer/src/pages/SettingsPage.tsx`);
    ok(SP.includes('模型单价上限') && SP.includes('按 ANS 定价'),
      'D-1a ★标题补全：由「成本上限」改「模型单价上限（美元 / 1k tokens，按 ANS 定价）」——说清是哪一场游戏（P6）');
    ok(SP.includes('是两回事') && SP.includes('人民币'),
      'D-1b ★并列说明：明写「与任务/项目预算的『¥ 人民币』是两回事」+「筛的是模型贵不贵，不是本任务能花多少钱」');
    // 反证：**不得**把显示改成人民币而底层仍按美元筛（名实不符 ⇒ 红）
    ok(/模型单价上限（美元/.test(SP) && !/模型单价上限（[^）]*人民币/.test(SP),
      'D-2 ★反证（名实相符）：显示币种仍写「美元」——ANS 定价基准即美元，改显示而不改底层才是本仓反复点名的病');
    ok(SP.includes('MAX_COST_PER_1K_KEY') && /settings:set['"],\s*MAX_COST_PER_1K_KEY/.test(SP),
      'D-2b 且写入那一跳仍绑同一键（`MAX_COST_PER_1K_KEY`）——改的是文案，数据路一字未动');
    // ⚠ 读**原文**不是去注释面：该语义写在 JSDoc 里（承 feedback_static_sweep_comment_strip：
    //   "代码含 X"类判据仍读原文；此处判的正是**文档语义**本身，剥离注释就把它判没了）。
    ok(RD(`${A}/src/main/core/model-request.ts`).includes('美元/1k tokens'),
      'D-2c 主进程侧真源仍记「（美元/1k tokens）」⇒ 显示与底层同币种（两把尺未混用）');

    // 词表第二落点（承 `feedback_enum_value_sweep_readers`）：renderer 是词表的**第二个落点**，须核**产物**
    const assetsDir = path.join(root, A, 'renderer/dist/assets');
    if (!fs.existsSync(assetsDir)) {
      ok(false, 'D-3 ★renderer 产物在场（本判据前置：`pnpm --filter @worker-ant/desktop-renderer build` 先行）', assetsDir);
    } else {
      const blob = fs.readdirSync(assetsDir).filter((f) => f.endsWith('.js'))
        .map((f) => fs.readFileSync(path.join(assetsDir, f), 'utf-8')).join('\n');
      ok(blob.includes('模型单价上限') && blob.includes('是两回事'),
        'D-3 ★词表第二落点：renderer **构建产物**里含该中文串（minify 后中文原样保留——搜串不搜标识符）',
        `产物 ${blob.length} 字符`);
    }
  }

  // ═══ S｜哑雷自检 + build 钉（派生核对，不写轮次字面量）════════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfPath = `scripts/${path.basename(__filename)}`;
    const selfLines = stripKeepingLines(RD(selfPath)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261013_2: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261013_2 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_zx_20261013_2: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
