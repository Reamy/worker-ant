/**
 * zx_20261012_2 受控复跑 —— 「名各有主」：**一个名字只主一件事，判据才能各答各的问**。
 *
 * 本轮口径一句话（道德经·名可名非常名 / 维特根斯坦·意义即用法 / 毛选·矛盾论）：
 *   · 批一「熔断器口径归位 + 策略可配」——`window: 10` 写了却**从没人读**（旧码 `COUNT(*)…LIMIT 10`
 *     里 `LIMIT` 空转，数的是**全时段**失败数）⇒ 项目历史 5 个失败 + 一个新任务 = 当场误熔断。
 *     "写下的，机器要认"：窗口必须真走进取数（签名由 `number` 改 `(w)=>number`，类型层封死）。
 *   · 批二「放弃自成一态 `archived`」——`failed` 既装"真失败"又装"主动放弃" ⇒ 名不副实则判据必错。
 *   · 批三「停 ≠ 死」——`dead` 把 `paused`（策略熔断、等人工）也算"死" ⇒ 停被错杀成死（事故 9 连败主源）。
 *   · 批四「拆解随本相」——提示词里的 `2-6` 与广度闸 `MAX_CHILD_BREADTH=5` 两把尺；粒度须由引擎闸派生。
 *   · 批五「通知面归位」——失败/暂停的 IM 有**四个静默岔口**，各自记账却不落 IM ⇒ 收成**两处出声**。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：判据一律静态导入生产导出（被删/改名即编译期失败）。
 *   G-2 **两侧标本**：凡判"命中/放行/收窄"的判据，反面标本（不命中）一并喂。
 *   G-4 **不碰真实网络/墙钟**：到 ANS 的探活一概打 `127.0.0.1:1`（确定性快速失败）。
 *   G-5 判"用户可见文案还在不在"读 `stripKeepingLines` 后的代码。
 *   G-6 **无轮次字面量**：本轮方案路径/脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 *   ⚠ 计数器类断言一律**正面**（"值从 0 变 1"），不只断言"不抛"。
 *   ⚠ IM 发送走动态 `import('electron')`（rr 起不了 electron）⇒ 只断**意图账** `wa_im_notify_log`。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：判据引用的生产符号**全部静态导入** ⇒ 被删/改名即编译期失败。
import { countRecentFailures, loadPolicies, POLICY_OVERRIDES, policySettingDefaults } from '../apps/worker-ant-desktop/src/main/core/policy-config.js';
import { evaluatePolicies, DEFAULT_POLICIES, type Policy } from '../apps/worker-ant-desktop/src/main/core/policy-engine.js';
import { archiveTask, ARCHIVE_REASON_KEY } from '../apps/worker-ant-desktop/src/main/core/task-archive.js';
import { markTaskFailed } from '../apps/worker-ant-desktop/src/main/core/task-terminal.js';
import { failedChildren } from '../apps/worker-ant-desktop/src/main/core/children-gate.js';
import { hasUnrecoverableDep, DEP_UNRECOVERABLE_STATUSES, DEP_DEAD_STATUSES } from '../apps/worker-ant-desktop/src/main/core/dep-graph.js';
import { reconcileStalledSubtasks, PARENT_INTERRUPTED_PAUSE_REASONS, SELF_HEALING_LOGS_DDL } from '../apps/worker-ant-desktop/src/main/core/self-healing-monitor.js';
import { DECOMPOSE_MIN_SUBTASKS, DECOMPOSE_MAX_SUBTASKS, buildDecomposePrompt, planSubtasksFromTemplate } from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';
import { MAX_CHILD_BREADTH, childBreadthRefusal } from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import { recordNotifyIntent, IM_FAIL_AGG_WINDOW_MS } from '../apps/worker-ant-desktop/src/main/core/im/im-notify-log.js';
import { pauseTask } from '../apps/worker-ant-desktop/src/main/core/pause-task.js';
import { PAUSE_REASON_POLICY_PAUSED, PAUSE_REASON_EXEC_TIMEOUT, PAUSE_REASON_NO_OUTPUT } from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
import { selectModelForTask } from '../apps/worker-ant-desktop/src/main/core/exec-model-select.js';
import { buildTools } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { eventBus, type AppEvent } from '../apps/worker-ant-desktop/src/main/core/event-bus.js';

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
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''); // zx_20261012_2

/* ── 夹具 ────────────────────────────────────────────────────────────────── */

type AnyDb = import('better-sqlite3').Database;

/** 逐列照抄 `database.ts` DDL（含 ALTER 补列）——既不缺列也不放宽 NOT NULL（承 rr_zx_20260915）。 */
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, status TEXT DEFAULT 'active', context_json TEXT DEFAULT '{}', working_dir TEXT);
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'p', parent_task_id TEXT DEFAULT '',
  title TEXT DEFAULT '', description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0,
  context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '', source TEXT DEFAULT 'test',
  acceptance_criteria TEXT DEFAULT '', quality_score REAL, aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', retry_count INTEGER DEFAULT 0, max_retries INTEGER DEFAULT 3,
  scheduled_at TEXT, started_at TEXT, completed_at TEXT, error TEXT,
  created_at TEXT DEFAULT (datetime('now')));
-- 批五 M5：失败通知的唯一出口＝markTaskFailed ⇒ pushImNotify，其**意图账**须在场
--   （发送经动态 import electron 的 im.ipc —— rr 起不了 electron ⇒ 只有这本账能在回归里被正面断言）。
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT DEFAULT '', status TEXT);
CREATE TABLE wa_im_conversations (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT,
  message_json TEXT, direction TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_notify_log (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', task_id TEXT DEFAULT '',
  kind TEXT NOT NULL, suppressed INTEGER DEFAULT 0, at INTEGER NOT NULL);
` + SELF_HEALING_LOGS_DDL;

const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d as unknown as AnyDb; };

const addTask = (db: AnyDb, id: string, status: string, opts: { project?: string; parent?: string; ctx?: Record<string, unknown>; depends?: string; createdAgo?: string } = {}): void => {
  db.prepare(`INSERT INTO wa_tasks (id, project_id, parent_task_id, title, status, depends_on, source, context_json, created_at)
              VALUES (?, ?, ?, ?, ?, ?, 'test', ?, datetime('now', ?))`)
    .run(id, opts.project ?? 'p', opts.parent ?? '', id, status, opts.depends ?? '', JSON.stringify(opts.ctx ?? {}), opts.createdAgo ?? '-0 minutes');
};
const setTask = (db: AnyDb, id: string, status: string): void => { db.prepare('UPDATE wa_tasks SET status = ? WHERE id = ?').run(status, id); };
const statusOf = (db: AnyDb, id: string): string => (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;
const ctxOf = (db: AnyDb, id: string): Record<string, unknown> => JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json || '{}');
const convs = (db: AnyDb, id: string): string[] =>
  (db.prepare('SELECT content FROM wa_task_conversations WHERE task_id = ? ORDER BY created_at, rowid').all(id) as Array<{ content: string }>).map((r) => r.content);
const setSetting = (db: AnyDb, key: string, value: string): void => { db.prepare('INSERT OR REPLACE INTO wa_settings (key, value) VALUES (?, ?)').run(key, value); };
/** 一套能让 `resolveImNotifyTargets` 回落到「最近一条 1:1 私聊 inbound」的最小 IM 世界。 */
const addImChannel = (db: AnyDb, channelId = 'c1', externalUser = 'u1'): void => {
  db.prepare("INSERT INTO wa_im_channels (id, channel_type, status) VALUES (?, 'wechat', 'active')").run(channelId);
  db.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction) VALUES (?, ?, ?, '{}', 'inbound')")
    .run(`cv-${channelId}`, channelId, externalUser);
};
/** 意图账：真发（`suppressed=0`）的行数 / 全部分类明细。 */
const notifySent = (db: AnyDb, kind: string, project?: string): number =>
  (db.prepare(`SELECT COUNT(*) AS c FROM wa_im_notify_log WHERE kind = ? AND suppressed = 0${project ? ' AND project_id = ?' : ''}`)
    .get(...(project ? [kind, project] : [kind])) as { c: number }).c;
const notifyAll = (db: AnyDb): Array<{ kind: string; suppressed: number; at: number; project_id: string }> =>
  db.prepare('SELECT kind, suppressed, at, project_id FROM wa_im_notify_log ORDER BY at, rowid').all() as Array<{ kind: string; suppressed: number; at: number; project_id: string }>;

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx2-'));
if (!tmpdir) throw new Error('tmpdir 未建');

/** 12 个任务、仅**最早**的 6 个 `failed`（`created_at` 递减 1 分钟 ⇒ 序号可预期）。 */
const seedFailures = (db: AnyDb, project: string, total = 12, failedOldest = 6): void => {
  for (let i = 0; i < total; i++) {
    addTask(db, `${project}-t${i}`, i < failedOldest ? 'failed' : 'completed',
      { project, createdAgo: `-${total - 1 - i} minutes` });
  }
};

/**
 * 从 `src` 里抽出每个 `marker` 调用的**平衡括号**调用体（跳过引号内的括号，含反斜杠转义）。
 * E-10 用它读"每个 `emit('task.failed', …)` 到底带没带因"——注释已剥离，故只能读真代码。
 */
function balancedCalls(src: string, marker: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const at = src.indexOf(marker, i);
    if (at < 0) break;
    const p = src.indexOf('(', at + marker.length);
    if (p < 0) break;
    let depth = 0; let j = p; let quote = '';
    for (; j < src.length; j++) {
      const ch = src[j] as string;
      if (quote) { if (ch === '\\') { j++; } else if (ch === quote) { quote = ''; } continue; }
      if (ch === "'" || ch === '"' || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) { j++; break; } }
    }
    out.push(src.slice(at, j));
    i = j;
  }
  return out;
}

/** 递归收集 `src/` 下的 .ts/.tsx（判据/扫描面用）。 */
function walk(dirAbs: string, filter: (p: string) => boolean, out: string[] = []): string[] {
  for (const ent of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const p = path.join(dirAbs, ent.name);
    if (ent.isDirectory()) walk(p, filter, out);
    else if (filter(p)) out.push(p);
  }
  return out;
}

/** 一份合法的 ANS `getOptimalModel` 回包（必然连不上的端点 ⇒ 探活确定性快速失败，不碰真网）。 */
const DEAD_URL = 'http://127.0.0.1:1';
const okPayload = (o: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'm-primary', model_name: 'primary-model', url: DEAD_URL, api_key: 'k1',
  max_output_tokens: 4096, context_window: 128_000,
  input_price_per_1k: 0.001, output_price_per_1k: 0.002,
  capabilities: ['chat', 'function-calling', 'streaming'],
  sameProviderFallback: null, crossProviderFallback: null, fallback: null, ...o,
});

/** 跑一次**生产** `selectModelForTask`（连同它落下的会话行一起取回——"账"是本组主要取证）。 */
async function pick(db: AnyDb, taskId: string, projectId: string): Promise<{ thrown: string | null; conv: string[] }> {
  try {
    await selectModelForTask({
      db: db as never, taskId, projectId, taskCtxJson: '{}',
      ansClient: { getOptimalModel: async () => okPayload() } as never,
      archetype: 'conversation' as never, modelStrategy: 'cost-optimal',
    });
    return { thrown: null, conv: convs(db, taskId) };
  } catch (e) {
    return { thrown: (e as Error).message, conv: convs(db, taskId) };
  }
}

async function main(): Promise<void> {
  // ═══ A｜熔断器口径归位 + 策略可配（毛选·实事求是：依据须是"最近 N 个"，不是"全时段"）════════
  console.log('\n【A】熔断器：`window` 真被读 + 策略真可配（两侧标本）');
  {
    const db = mkdb(); const P = 'pa';
    seedFailures(db, P, 12, 6);
    // 12 行、最早 6 个 failed；`created_at` DESC ⇒ 最近 10 个 = 序号 2..11，其中 failed = {2,3,4,5} = 4。
    eq(countRecentFailures(db, P, 0), 6, 'A-1 全时段（`window=0`）= **6**——旧码 `COUNT(*)…LIMIT 10` 数出的正是它（病标本基线）');
    eq(countRecentFailures(db, P, 10), 4, 'A-2 ★窗 10 内 = **4**（< 阈值 5 ⇒ 级联闸**不**误熔断；旧码数 6 ≥ 5 必命中）');
    eq(countRecentFailures(db, P, 3), 0, 'A-3 ★窗 3 内 = **0**（最近 3 个全非 failed）——窗大小真换取了不同取数结果');
    eq(countRecentFailures(db, 'p-none', 10), 0, 'A-4 无此项目 ⇒ 0（不是"读不到即全时段"）');

    // 同 metrics 下 window 3 与 window 10 **结论不同** ⇒ `condition.window` 真被读（而非写死）。
    const metrics = { taskTokens: 0, taskCost: 0, projectRecentFailures: (w: number) => countRecentFailures(db, P, w) };
    const polWin = (w: number): Policy => ({ name: `w${w}`, conditions: [{ type: 'error_rate', threshold: 3, window: w }], actions: [{ type: 'notify_admin' }] });
    eq([evaluatePolicies(metrics, [polWin(3)]).triggered, evaluatePolicies(metrics, [polWin(10)]).triggered], [false, true],
      'A-5 ★★同一 metrics、同阈值 3，**仅窗不同** ⇒ 结论不同（窗 3 取 0 不触发 / 窗 10 取 4 触发）——`window` 写对了就得认');
    // 病标本的正面对照：旧口径（恒返全时段 6）在同一阈值 5 的级联策上必命中；新口径不命中。
    const cascade = DEFAULT_POLICIES.find((p) => p.name === 'failure_cascade_guard');
    const oldStyle = { taskTokens: 0, taskCost: 0, projectRecentFailures: () => 6 };
    eq([evaluatePolicies(oldStyle, [cascade as Policy]).triggered, evaluatePolicies(metrics, [cascade as Policy]).triggered], [true, false],
      'A-6 ★★旧口径（全时段 6）在级联闸上**误命中**；新口径（窗内 4）**不命中**——这正是本轮要治的那次误熔断');

    // `loadPolicies` 读设置生效：默认由 `DEFAULT_POLICIES` 派生（不手抄），改键则随之变。
    const dflt = (db2: AnyDb): number => loadPolicies(db2).find((p) => p.name === 'failure_cascade_guard')!.conditions[0]!.threshold as number;
    const derivedDefault = cascade!.conditions[0]!.threshold;
    const empty = mkdb();
    eq(dflt(empty), derivedDefault, 'A-7 `loadPolicies` 空库 ⇒ 级联阈值=缺省（由 `DEFAULT_POLICIES` 现算，不手抄数字）');
    setSetting(empty, 'policy.cascade_fail_threshold', '2');
    eq(dflt(empty), 2, 'A-8 ★改 `policy.cascade_fail_threshold`=2 ⇒ `loadPolicies` 读回 2（阈值真可配）');
    setSetting(empty, 'policy.cascade_fail_window', '77');
    eq(loadPolicies(empty).find((p) => p.name === 'failure_cascade_guard')!.conditions[0]!.window, 77, 'A-9 ★窗亦可配（`policy.cascade_fail_window`=77 读回 77）');
    // 缺省种子表与覆盖名单**同源**（键名不散两处）。
    eq(policySettingDefaults().map(([k]) => k), POLICY_OVERRIDES.map((o) => o.key), 'A-10 `policySettingDefaults()` 的键 === `POLICY_OVERRIDES` 名单（键名只此一份）');

    // 执行前策略闸的**0→1 正面断言**：开 ⇒ 写策略行；关 ⇒ 一条不写（连取数都不取）。
    const dbOn = mkdb(); seedFailures(dbOn, 'paon', 12, 6); addImChannel(dbOn); addTask(dbOn, 'a-on', 'executing', { project: 'paon' });
    const rOn = await pick(dbOn, 'a-on', 'paon');
    const polRowsOn = rOn.conv.filter((c) => c.startsWith('[策略通知]'));
    eq(polRowsOn.length, 1, 'A-11 ★0→1：策略闸开 ⇒ `[策略通知]` 会话行**恰 1 条**（窗 10 内 4 次失败 ≥ 阈值 3）');
    ok(rOn.conv.some((c) => c.startsWith('[降级通知]')), 'A-11b 同一次还落了 `[降级通知]`（探活未通过、无备用）——两条各说各事，不互相顶替');
    eq(notifySent(dbOn, 'admin_notify', 'paon'), 1, 'A-12 ★`notify_admin` **真发**（意图账 `admin_notify` 0→1）——「通知管理员」此前只写会话行、不通知人');
    eq(rOn.thrown, null, 'A-12b 该路不抛（探活未通过 ≠ 端点已死，按原端点继续）');

    const dbOff = mkdb(); seedFailures(dbOff, 'paoff', 12, 6); addImChannel(dbOff); addTask(dbOff, 'a-off', 'executing', { project: 'paoff' });
    setSetting(dbOff, 'engine.policy_check', 'false');
    const rOff = await pick(dbOff, 'a-off', 'paoff');
    eq(rOff.conv.filter((c) => c.startsWith('[策略')).length, 0, 'A-13 ★反证（关）：`engine.policy_check=false` ⇒ **零**策略行（一键回退，非删代码）');
    eq(notifySent(dbOff, 'admin_notify'), 0, 'A-14 ★反证（关）：意图账零 `admin_notify`——上一条不是恒真');
  }

  // ═══ B｜归档自成一态（维特根斯坦·名各有主：`failed` 不再兼任"主动放弃"）══════════════
  console.log('\n【B】`archived`：真落态 + 真发事件 + 真写因 + 真翻账页');
  {
    const db = mkdb(); addImChannel(db);
    addTask(db, 'b-1', 'pending', { project: 'pb', ctx: { completion_quality: { score: 90, goal_achieved: false, via: 'run_close' }, acceptance_check: { verified: false } } });
    db.prepare('UPDATE wa_tasks SET quality_score = 90 WHERE id = ?').run('b-1');
    const seen: AppEvent[] = [];
    const h = (e: AppEvent): void => { if (e.data.taskId === 'b-1') seen.push(e); };
    eventBus.on('task.status_changed', h);
    const res = archiveTask(db, { taskId: 'b-1', reason: '用户放弃该方向', expectStatus: 'pending' });
    eventBus.off('task.status_changed', h);
    eq([res.changed, res.pageTurned], [true, true], 'B-1 归档真落态 **且**真翻账页（上一次 run 的判卷被结清）');
    eq(statusOf(db, 'b-1'), 'archived', 'B-2 ★`wa_tasks.status` → `archived`（不再与 `failed` 混用一个名）');
    eq(ctxOf(db, 'b-1')[ARCHIVE_REASON_KEY], '用户放弃该方向', 'B-3 ★因由落 `context_json.archive_reason`（键名单一真源 `ARCHIVE_REASON_KEY`）');
    const c1 = ctxOf(db, 'b-1');
    eq([c1.completion_quality, c1.acceptance_check, c1.goal_achieved], [undefined, undefined, false],
      'B-4 ★翻账页：`completion_quality`/`acceptance_check` 被清、`goal_achieved` 如实置 false（90 分旧账不再冒名今态）');
    eq((db.prepare('SELECT quality_score AS q FROM wa_tasks WHERE id = ?').get('b-1') as { q: number | null }).q, null,
      'B-5 ★`wa_tasks.quality_score` 列被清 NULL（否则已弃任务仍按 90 分进项目均质）');
    eq([seen.length, seen[0]?.data.new_status, seen[0]?.data.reason], [1, 'archived', '用户放弃该方向'],
      'B-6 ★事件在场且**恰一条**（`status_changed{new_status:\'archived\', reason}`）——写口不自补第二条');

    // 反证：CAS 不符 ⇒ 库**纹丝不动**（不是"照样翻、只是回 false"）。
    const db2 = mkdb(); addTask(db2, 'b-2', 'pending', { project: 'pb' });
    const r2 = archiveTask(db2, { taskId: 'b-2', reason: 'r', expectStatus: 'paused' });
    eq([r2.changed, r2.pageTurned, statusOf(db2, 'b-2')], [false, false, 'pending'],
      'B-7 ★反证：`expectStatus` 不符 ⇒ `changed=false` 且库**未动**（CAS 是真闸，不是事后回 false）');

    // `archived` 子**不计入** `failedChildren` ⇒ 父不被"放弃"误判成"有失败子"。
    const db3 = mkdb(); addTask(db3, 'P', 'paused', { project: 'pb' });
    addTask(db3, 'C-f', 'failed', { project: 'pb', parent: 'P' });
    addTask(db3, 'C-a', 'archived', { project: 'pb', parent: 'P' });
    eq(failedChildren(db3, 'P').map((r) => r.id), ['C-f'],
      'B-8 ★`failedChildren` 只认 `failed`（`archived` 出局）——"放弃"不该读成"失败"，否则父的恢复判据必错');

    // 静态：enum 含 `archived`；`archiveTask` 定义恰一处；GUI 词表含 `已归档`。
    const CTL = CODE(`${A}/src/main/core/tools/control.ts`);
    ok(/enum:\s*\['pending', 'running', 'paused', 'completed', 'failed', 'archived'\]/.test(CTL),
      'B-9 ★`update_task_status` 的 `status` 是 **enum** 且含 `archived`（"能写的值"与 `TaskStatus` 一致，编造值不可表达）');
    const AR = CODE(`${A}/src/main/core/task-archive.ts`);
    eq((AR.match(/export function archiveTask\(/g) ?? []).length, 1, 'B-10 ★`archiveTask` 定义**恰一处**（唯一写手）');
    const SV = RD(`${A}/renderer/src/lib/status-view.ts`);
    ok(/archived:\s*'已归档'/.test(SV), 'B-11 GUI 词表含 `archived: \'已归档\'`（用户看得见的新态）');
  }

  // ═══ C｜级联：停 ≠ 死（毛选·矛盾论：具体问题具体分析）══════════════════════════════
  console.log('\n【C】级联判据：`hasUnrecoverableDep` 两侧标本 + 策略暂停不再被错杀成死');
  {
    // 判据本身：`failed`/`archived` ⇒ true；`paused`（任意因由）/`waiting`/`unresolved`/不存在 ⇒ false。
    const st = (m: Record<string, string>) => (id: string): string | undefined => m[id];
    eq([hasUnrecoverableDep(['x'], st({ x: 'failed' })), hasUnrecoverableDep(['x'], st({ x: 'archived' }))], [true, true],
      'C-1 ★该命中侧：前置 `failed` / `archived` ⇒ 真（二者皆"再也不会自行恢复"）');
    eq([hasUnrecoverableDep(['x'], st({ x: 'paused' })), hasUnrecoverableDep(['x'], st({ x: 'waiting' })),
        hasUnrecoverableDep(['x'], st({ x: 'unresolved' })), hasUnrecoverableDep(['x'], st({}))], [false, false, false, false],
      'C-2 ★★不该命中侧：`paused`/`waiting`/`unresolved`/查不到 ⇒ **皆 false**（把 `paused` 也判死＝本轮事故主源）');
    ok(DEP_UNRECOVERABLE_STATUSES.every((s) => (DEP_DEAD_STATUSES as readonly string[]).includes(s)),
      'C-3 ★`DEP_UNRECOVERABLE_STATUSES ⊆ DEP_DEAD_STATUSES`（"真死"是"挡住调度"的子集——两把尺各答各的问，但不得越界）',
      `不可恢复=[${DEP_UNRECOVERABLE_STATUSES.join(',')}] · 挡调度=[${DEP_DEAD_STATUSES.join(',')}]`);
    ok((DEP_DEAD_STATUSES as readonly string[]).includes('paused') && !(DEP_UNRECOVERABLE_STATUSES as readonly string[]).includes('paused'),
      'C-4 ★`paused` 在"挡调度"里（对：它挡调度）、**不在**"不可恢复"里（对：人一恢复它就活）——一个词只主一件事');

    // `policy_paused` **不属**"父被打断"——熔断喊停时把子自动派起来与熔断意图相反（**不改宽**，双向钉）。
    ok(!PARENT_INTERRUPTED_PAUSE_REASONS.includes(PAUSE_REASON_POLICY_PAUSED)
      && PARENT_INTERRUPTED_PAUSE_REASONS.includes(PAUSE_REASON_EXEC_TIMEOUT),
      'C-5 ★★`PARENT_INTERRUPTED_PAUSE_REASONS` **不含** `policy_paused`、**含** `exec_timeout`（双向）'
      + '——熔断喊停时救起子任务＝反其意而行；此集有宽窄两侧同钉，本轮**不做**改宽');

    // 病标本：父 `paused(policy_paused)` + 子 `pending` 无在途作业 ⇒ **不动子**（策略暂停应"等"，不该被判死）。
    {
      const db = mkdb();
      addTask(db, 'P', 'paused', { project: 'pc', ctx: { pause_reason: PAUSE_REASON_POLICY_PAUSED } });
      addTask(db, 'C', 'pending', { project: 'pc', parent: 'P' });
      const rec = reconcileStalledSubtasks(db as never);
      eq([rec.candidates, rec.reconciled, rec.dispatched, statusOf(db, 'C')], [1, [], [], 'pending'],
        'C-6 ★★病标本：父策略熔断暂停 + 子无前置 ⇒ 子**仍 pending**、既不判死也不派发'
        + '（旧码 `depState===\'dead\'` 在此把"停"错杀成"死"，正是事故 9 连败的来源）');
    }
    // 反证：前置真 `failed` ⇒ **仍标 failed**（收窄不可以宽成"不救"）。
    {
      const db = mkdb();
      addTask(db, 'P', 'pending', { project: 'pc2' });
      addTask(db, 'D', 'failed', { project: 'pc2' });
      addTask(db, 'C', 'pending', { project: 'pc2', parent: 'P', depends: 'D' });
      const rec = reconcileStalledSubtasks(db as never);
      eq([rec.reconciled, statusOf(db, 'C')], [['C'], 'failed'],
        'C-7 ★反证：前置**真死**（`failed`）⇒ 子**仍被如实标 failed**（0→1）——判据收窄不得宽成"什么都不救"');
      ok(convs(db, 'C').some((c) => c.includes('已如实标记为失败')), 'C-7b 那笔账留痕（会话行声明"无出路"），不是静默改态');
    }
    // 反证二：父 `pending` + 子无前置 ⇒ **派发**（父没停，子本可跑——这里不动才是错）。
    {
      const db = mkdb();
      addTask(db, 'P', 'paused', { project: 'pc3', ctx: { pause_reason: PAUSE_REASON_EXEC_TIMEOUT } });
      addTask(db, 'C', 'pending', { project: 'pc3', parent: 'P' });
      const before = (db.prepare('SELECT COUNT(*) AS c FROM wa_jobs').get() as { c: number }).c;
      const rec = reconcileStalledSubtasks(db as never);
      const after = (db.prepare('SELECT COUNT(*) AS c FROM wa_jobs').get() as { c: number }).c;
      eq([rec.dispatched, statusOf(db, 'C'), before, after], [['C'], 'pending', 0, 1],
        'C-8 ★对照：父"自身执行被打断"（`exec_timeout`）且子无前置 ⇒ **派发救起**（0→1 `wa_jobs` 行），子**留 pending**'
        + '——与 C-6 同形不同因，结论相反，正是"具体问题具体分析"');
    }
  }

  // ═══ D｜拆解随本相（粒度 + 广度，一个概念一个值）════════════════════════════════════
  console.log('\n【D】拆解粒度由广度闸派生 + 里程碑提示只在点了方案文件时生效');
  {
    eq(DECOMPOSE_MAX_SUBTASKS, MAX_CHILD_BREADTH,
      'D-1 ★`DECOMPOSE_MAX_SUBTASKS === MAX_CHILD_BREADTH`（拆解上限＝建子任务闸，两处不得各写一个数）');
    ok(DECOMPOSE_MIN_SUBTASKS >= 2 && DECOMPOSE_MIN_SUBTASKS <= DECOMPOSE_MAX_SUBTASKS, 'D-2 下限 ∈ [2, 上限]（合法）');

    // 源码**零** `2-6` 字面量（去注释码；递归扫 `src/`——renderer 是词表第二落点）。
    const srcFiles = walk(path.join(root, A, 'src'), (p) => /\.tsx?$/.test(p));
    const hit26: string[] = [];
    for (const f of srcFiles) if (/2-6个子任务/.test(stripKeepingLines(fs.readFileSync(f, 'utf-8')).join('\n'))) hit26.push(path.relative(root, f));
    eq(hit26, [], 'D-3 ★源码**零** `2-6个子任务` 字面量（曾与广度闸 5 各说各话）', `扫描 ${srcFiles.length} 文件`);

    // 提示词：数量段由常量派生；有 hint ⇒ 追加硬规则且**逐字**列出里程碑；无 hint ⇒ 与两参调用**逐字相同**。
    const desc = '把方案落地';
    const pats = 'a类: 约3个子任务';
    const base2 = buildDecomposePrompt(desc, pats);
    ok(base2.includes(`${DECOMPOSE_MIN_SUBTASKS}-${DECOMPOSE_MAX_SUBTASKS}个子任务`),
      'D-4 数量段由 `DECOMPOSE_MIN_SUBTASKS`/`DECOMPOSE_MAX_SUBTASKS` 派生（`2-5个子任务`，非写死的 `2-6`）');
    eq([buildDecomposePrompt(desc, pats, ''), buildDecomposePrompt(desc, pats, undefined)], [base2, base2],
      'D-5 ★无 hint（空串/undefined）⇒ 提示词与两参调用**逐字相同**（提示词不被空提示污染——保既有夹具的 C23 反证）');
    const withHint = buildDecomposePrompt(desc, pats, 'M1-契约 / M2-实现 / M3-验收');
    ok(withHint.includes('一里程碑一子任务') && withHint.includes('M1-契约 / M2-实现 / M3-验收'),
      'D-6 ★有 hint ⇒ 追加"一里程碑一子任务"硬规则且**逐字**列出里程碑（里程碑板因此不留未承接项）');
    // 真实形状：里程碑规则**插在**「任务描述 + 历史模式」与「输出格式要求」之间（不是追加到末尾）。
    // 强判据＝既有段逐字节不动：以共有的尾段锚 `\n\n请以JSON数组格式返回` 切开，前段相同 ∧ 后段相同 ⇒ 纯插入。
    {
      const tail = '\n\n请以JSON数组格式返回';
      const i0 = base2.indexOf(tail);
      const i1 = withHint.indexOf(tail);
      const inserted = i1 > i0 ? withHint.slice(i0, i1) : '';
      ok(i0 > 0 && i1 > i0
        && withHint.slice(0, i0) === base2.slice(0, i0)
        && withHint.slice(i1) === base2.slice(i0)
        && inserted.includes('一里程碑一子任务'),
        'D-7 ★插入而非替换：切掉新插的里程碑规则后，提示词**逐字节**等于无 hint 版（历史模式段等一位不动）');
    }

    // `planSubtasksFromTemplate` 超限仍截断，`refusal` 文案**逐字**取 `childBreadthRefusal`。
    const db = mkdb();
    addTask(db, 'P', 'executing', { project: 'pd' });
    for (let i = 0; i < MAX_CHILD_BREADTH - 1; i++) addTask(db, `P-k${i}`, 'pending', { project: 'pd', parent: 'P' });
    const template = Array.from({ length: MAX_CHILD_BREADTH + 2 }, (_, i) => ({ title: `M${i + 1}-x`, description: 'd', acceptance_criteria: '' }));
    const res = planSubtasksFromTemplate(db as never, { parentTaskId: 'P', projectId: 'pd', template, depth: 1, source: 'auto-decompose' });
    eq([res.planned, res.created], [MAX_CHILD_BREADTH + 2, 1],
      'D-8 ★★广度闸真截断：模板 7 条、父已有 4 个在途 ⇒ 只建 **1** 条（建满 5 即拒，报数只许用 `created`）');
    eq(res.refusal, childBreadthRefusal(db, 'P'),
      'D-9 ★截断真因**逐字**取 `childBreadthRefusal`（与 `create_task` 那道闸同一个数，不另写一句）');
    ok(!!res.refusal && res.refusal.includes('在途') && res.refusal.includes('① 把剩余工作交给某个'),
      'D-10 拒因带"在途"口径与三条当下可执行的路（毛选：纠偏建议须在当前约束下可执行）');
  }

  // ═══ E｜通知面归位（维特根斯坦·没有私人语言：只对自己记账≠对人说）════════════════════
  console.log('\n【E】失败/暂停 IM：一处发 + 短窗聚并 + 工具失败走同一出口');
  {
    // `markTaskFailed` 带因 ⇒ 意图账 0→1；同项目窗内第二条 ⇒ 聚并（不增）；换项目 ⇒ 再增。
    const db = mkdb(); addImChannel(db);
    addTask(db, 'e-1', 'executing', { project: 'pe1' });
    const r1 = markTaskFailed(db as never, 'e-1', { reason: 'boom-1' });
    eq([r1.changed, statusOf(db, 'e-1')], [true, 'failed'], 'E-1 前置：`markTaskFailed` 真落 `failed`');
    eq(notifySent(db, 'task_failed', 'pe1'), 1, 'E-2 ★0→1：带因失败 ⇒ 意图账 `task_failed`（`suppressed=0`）**恰 1 条**——「一处发、六处收」');
    addTask(db, 'e-2', 'executing', { project: 'pe1' });
    markTaskFailed(db as never, 'e-2', { reason: 'boom-2' });
    eq([notifySent(db, 'task_failed', 'pe1'), notifyAll(db).length], [1, 2],
      'E-3 ★★同项目窗内第二条失败 ⇒ **不再真发**（`suppressed=0` 仍 1）；但**仍入账**（总行数 2）——9 连败 ≠ 9 条');
    addTask(db, 'e-3', 'executing', { project: 'pe2' });
    markTaskFailed(db as never, 'e-3', { reason: 'boom-3' });
    eq(notifySent(db, 'task_failed'), 2, 'E-4 ★换 `projectId` ⇒ **再增**（聚并按项目，不是全局黑洞）');

    // 反证：无因 ⇒ **不发**（否则先发的空话会占掉窗口，把随后带因的那条吃掉）。
    addTask(db, 'e-4', 'executing', { project: 'pe3' });
    markTaskFailed(db as never, 'e-4', {});
    eq(notifySent(db, 'task_failed', 'pe3'), 0, 'E-5 ★反证：无因失败 ⇒ 零意图（"让带因的那条说话"——E-2 不是恒真）');

    // 窗的**边界**（注入时钟，不碰墙钟）：`IM_FAIL_AGG_WINDOW_MS` 前/后两侧标本。
    {
      const w = mkdb(); const base = 1_000_000;
      const sup = (now: number): boolean => recordNotifyIntent(w as never, { projectId: 'pw', taskId: 'x', kind: 'task_failed', now }).suppressed;
      eq([sup(base), sup(base + IM_FAIL_AGG_WINDOW_MS - 1), sup(base + IM_FAIL_AGG_WINDOW_MS), sup(base + IM_FAIL_AGG_WINDOW_MS + 1)],
        [false, true, false, true],
        'E-6 ★★窗边界两侧：首条发 / 窗内不发 / **满窗即发** / 刚过窗内不发——"时间窗"不是"永久黑洞"');
      eq(notifySent(w, 'task_failed'), 2, 'E-7 满窗那一条**真发**（`suppressed=0` 计数 2）——被聚并的行不刷新窗口');
    }

    // `update_task_status(status='failed')` 走**同一出口**：会话行 / 事件 / IM **三样齐**（此前裸 `UPDATE`，三者皆缺）。
    {
      const db2 = mkdb(); addImChannel(db2); addTask(db2, 'u-1', 'executing', { project: 'pu' });
      const seen: AppEvent[] = [];
      const h = (e: AppEvent): void => { if (e.data.taskId === 'u-1') seen.push(e); };
      eventBus.on('task.status_changed', h);
      const tools = buildTools({ db: db2 } as never, 'caller-task', 'pu', tmpdir) as unknown as Record<string, { execute: (a: unknown) => Promise<string> }>;
      await tools.update_task_status!.execute({ targetTaskId: 'u-1', status: 'failed', reason: '经工具置失败' });
      eventBus.off('task.status_changed', h);
      eq(statusOf(db2, 'u-1'), 'failed', 'E-8 ★`update_task_status(failed)` 真落 `failed`（改走 `markTaskFailed`，不再裸 `UPDATE`）');
      ok(convs(db2, 'u-1').some((c) => c.startsWith('[标记失败]')), 'E-9 ①会话行：`[标记失败] …` 在场（人看得见"发生了什么"）');
      ok(seen.length === 1 && seen[0]!.data.error === '经工具置失败', 'E-10 ②事件：`status_changed{failed, error}` 带因在场（恰一条）');
      eq(notifySent(db2, 'task_failed', 'pu'), 1, 'E-11 ★③IM：意图账 0→1——同一出口三样齐（维特根斯坦：记账不是通知，人收到才是）');
    }

    // `pauseTask(policy_paused)` **不传 note** ⇒ IM 仍发（`pause-reason` 自带因由那一跳真触发）。
    {
      const db3 = mkdb(); addImChannel(db3); addTask(db3, 'p-1', 'executing', { project: 'pp1' });
      pauseTask(db3 as never, { taskId: 'p-1', reason: PAUSE_REASON_POLICY_PAUSED });
      eq([statusOf(db3, 'p-1'), notifySent(db3, 'pause_needed', 'pp1')], ['paused', 1],
        'E-12 ★★熔断喊停**不传 note** ⇒ 仍发 IM（0→1 `pause_needed`）——`pause-reason` 自带因由那一跳真触发；'
        + '熔断是本系统自己做的决定，最该让人知道（实机"很多暂停、IM 一条没有"的一支）');
      const db4 = mkdb(); addImChannel(db4); addTask(db4, 'p-2', 'executing', { project: 'pp2' });
      pauseTask(db4 as never, { taskId: 'p-2', reason: PAUSE_REASON_NO_OUTPUT });
      eq(notifySent(db4, 'pause_needed'), 0, 'E-13 ★反证：非中断类因由（`no_output`）不传 note ⇒ **不发**（E-12 不是"凡暂停必发"）');
    }

    // 静态：`ai-task.ts` **零** `hooks.notify` 残口（已由 `markTaskFailed` 统一发，免同一失败发两遍）。
    const AIT = CODE(`${A}/src/main/core/jobs/ai-task.ts`);
    eq((AIT.match(/hooks\.notify/g) ?? []).length, 0, 'E-14 ★★`ai-task.ts` 去注释码后**零** `hooks.notify`（删除未留残口——否则一次失败发两遍）');

    // E-10 防线：全仓每个 `emit('task.failed', …)` 的调用体**处处带因**（`error` 或 `taskFailedPayload`）。
    const mainFiles = walk(path.join(root, A, 'src', 'main'), (p) => p.endsWith('.ts'));
    const badCalls: string[] = []; let failEmits = 0;
    for (const f of mainFiles) {
      const code = stripKeepingLines(fs.readFileSync(f, 'utf-8')).join('\n');
      for (const call of balancedCalls(code, "emit('task.failed'")) {
        failEmits++;
        if (!/\berror\b/.test(call) && !/taskFailedPayload/.test(call)) badCalls.push(`${path.relative(root, f)}: ${call.replace(/\s+/g, ' ').slice(0, 90)}`);
      }
    }
    ok(failEmits > 0, 'E-15 扫描面自证：全仓确有 `emit(\'task.failed\', …)` 调用点（不是扫了个空）', `${failEmits} 处`);
    eq(badCalls, [], 'E-16 ★★每个 `emit(\'task.failed\', …)` 都带因（`error` 直写或 `taskFailedPayload` 派生）——'
      + '这是"无因即不发 IM"的**防线**：漏一个，那次失败就永远没有通知', `扫描 ${mainFiles.length} 文件`);
  }

  // ═══ S｜哑雷自检 + build 钉（派生核对，不写轮次字面量）════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
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
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261012_2: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261012_2 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_zx_20261012_2: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
