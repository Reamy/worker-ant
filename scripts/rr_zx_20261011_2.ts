/**
 * zx_20261011_2 受控复跑 —— 实机 E2E 照出的缺陷（D1 / D1b / D3 / D2），
 *   及其后由同一轮 E2E **收口复看**照出的 **D5 / D6 / D7**（A 端台账名实 / 外部终端不瞎问 / 轮询不设上限）。
 *
 * 本轮口径一句话（维特根斯坦·意义即用法）：**答得上，才算问过**。
 *
 * 病根（本轮方案 §1）：
 *   D1  relay 把 `paused` 一律当作"有人在等输入"——而那只是 24 个因由**之一**。
 *       实机 B 的两件任务真因是 `abnormal_end`（跑完未收口），A 端台账却同挂「待作答 + 失败」。
 *   D1b 作答**没有任何一条路**真正送到执行体：ANS 把「作答」实现成"置回 assigned ⇒ 重跑"，
 *       新任务既不带答案、又重问、还把旧答案抹掉（`answer_json=NULL`）⇒ 作答从未进过执行体。
 *   D3  提问窗口硬编码 60s，对人（读题→点选→提交）太短——是 D1b 那条畸变的直接导火索。
 *   D2  派活下拉把 `others` 原样喂进去、只按类目收窄：observer/未参与/离线的他机照列，
 *       手选后 ANS 才拒（E2E ③ 实测：B 已转观察者，A 的窗口里它仍在）。
 *   D5（收口复看）A 端台账把"暂停等人答"错记成**结论** `error`：relay 遇 `paused` 报 error，
 *       读回即落 `node.request_result` ⇒ 行被钉成 error，作答后重跑出的 done 反被幂等守卫挡住
 *       ⇒ A 端**恒显失败**（即便 ANS 已 done）。治法＝error ∧ `question_status='asked'` 时**不落账**。
 *   D6（收口复看）**外部 AI 终端**请求也写 `node_request_id` ⇒ `ask_user` 对着空气问满一整个窗口
 *       （假 `awaiting_answer` + 白等 180s）才自决。治法＝仅 `requester_node_id` 非空（对等派发）才写。
 *   D7（收口复看·**实机照出**）A 端出站读回轮询硬编码 40×5s＝200s 上限：真任务常跑数分钟
 *       （实测 349s）⇒ 窗口到点先停、收口那一下被漏掉 ⇒ 台账行**永停"待回"**。治法＝去上限。
 *   D9（**实机照出**·格②）中继任务命中"工作目录外写入审批"即被瞬时置 `paused`，relay 轮询一见 `paused`
 *       即回 `error` ⇒ A 端恒显失败、B 端其实完成。病根＝`pauseForDecision`（全仓唯一"置停等人"的咽喉）
 *       从未读 `no_interaction`。治法＝咽喉把守（置停**之前**问 `noInteractionPauseRefusal` ⇒ 不置停）。
 *   D10（**实机照出**·用户裁定"应挡住终态"）ANS `/answer` 只读 `question_status` 不读 `status` ⇒
 *       `done ∧ asked` 的件被作答复活、重跑一遍。治法＝`/answer` 增终态闸（幂等分支之后）+ 面板不提供死动作。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：判据一律静态导入生产导出（被删/改名即编译期失败）。
 *   G-2 **两侧标本**：凡判"命中/放行/收窄"的判据，反面标本（不命中）一并喂。
 *   G-4 **不碰真实网络/墙钟**：到 ANS 的请求一概注入假实现；时刻一律用**冻结基准**（不取 `Date.now`）。
 *   G-5 判"用户可见文案还在不在"读 `stripKeepingLines` 后的代码（注释里提到旧文案不构成本文之病）。
 *   G-6 **无轮次字面量**：本轮方案路径/脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：判据引用的生产符号**全部静态导入** ⇒ 被删/改名即编译期失败（而非"扫了个空、静默假绿"）。
import { makeRelayRunner, RELAY_PROJECT_NAME } from '../apps/worker-ant-desktop/src/main/core/node-request-runner.js';
// D5：出站台账的**读回落账**（error ∧ 待答 ⇒ 不落 result）。
import { refreshDispatchResult } from '../apps/worker-ant-desktop/src/main/core/node-dispatcher.js';
// D1：题因的**一处真源**（读点 + 人话词表）。
import {
  pauseReasonLabel,
  recordedPauseReason,
  PAUSE_REASON_ABNORMAL_END,
  PAUSE_REASON_AWAITING_INPUT,
} from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
// D1b：答案注入的两键一族（与 `NODE_REQUEST_ID_KEY` 并列同处）。
import {
  answerOf,
  NODE_ANSWER_KEY,
  NODE_REQUEST_ID_KEY,
  resolveClarifyWaitMs,
  CLARIFY_WAIT_SEC_DEFAULT,
} from '../apps/worker-ant-desktop/src/main/core/node-clarify.js';
import { NODE_SETTING_KEYS, type NodeSettingDb } from '../apps/worker-ant-desktop/src/main/core/node-identity.js';
// D9：不可交互任务的**暂停闸拒绝**真源（与 `noInteractionAskRefusal` 同族，M11 语义只在本模块）。
import { noInteractionPauseRefusal, NO_INTERACTION_KEY } from '../apps/worker-ant-desktop/src/main/core/no-interaction.js';
// D2：候选收窄的两个**同源判据**（一个管"接得住"、一个管"在不在线"）。
import { isDispatchable } from '../packages/shared-types/src/nodes.js';
import { isNodeOnline } from '../apps/worker-ant-desktop/renderer/src/lib/node-view.js';
import type { AnsNodeRequest, NodeRole } from '../packages/shared-types/src/nodes.js';
import type { RequestRunner, RequestRunResult } from '../apps/worker-ant-desktop/src/main/core/node-request-worker.js';

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
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''); // zx_20261011_2

/* ── 夹具 ────────────────────────────────────────────────────────────────── */

/** G-4：冻结基准时刻——判"在不在线"不取墙钟，标本才在任意时刻为真。 */
const NOW_MS = Date.parse('2026-10-11T00:00:00.000Z');

/** 一条中转请求（只填本轮判据用得到的字段；其余取与生产同形的缺省）。 */
function ansReq(over: Partial<AnsNodeRequest>): AnsNodeRequest {
  return {
    id: 'rq-0001', category: 'project_task', payload: { prompt: '干活' },
    requester_key_prefix: 'ab12', requester_node_id: 'n-self', target_node_id: null,
    status: 'assigned', result: null,
    question: null, answer: null, question_status: null,
    created_at: '2026-10-11T00:00:00.000Z', claimed_at: null, done_at: null,
    ...over,
  };
}

type RunnerDb = Parameters<typeof makeRelayRunner>[0]['db'];

/**
 * 中转执行器的**最小库夹具**：只建被测路径真正读写的表。
 *
 * ⚠ 中转项目**预置**（名 = `RELAY_PROJECT_NAME`）⇒ `ensureRelayProject` 首查即命中、**不**走
 *   `ProjectEngine.create`（那条路要 `_enrichProject` 的一堆统计表，与本轮判据无关）。
 */
function relayDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, description TEXT DEFAULT '', cron_schedule TEXT, cron_timezone TEXT, working_dir TEXT, owner_id TEXT, status TEXT DEFAULT 'active', context_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT);
    CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT DEFAULT '', description TEXT DEFAULT '', workflow_config TEXT DEFAULT '{}', priority INTEGER DEFAULT 0, source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '', status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', created_at TEXT DEFAULT (datetime('now')), updated_at TEXT);
    CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT, payload TEXT, status TEXT);
    CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT, content TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, file_path TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_deliverable_versions (id TEXT PRIMARY KEY, deliverable_id TEXT, file_path TEXT, changed_by TEXT, created_at TEXT DEFAULT (datetime('now')));
  `);
  d.prepare('INSERT INTO wa_projects (id, name, owner_id) VALUES (?, ?, ?)').run('proj-relay', RELAY_PROJECT_NAME, 'u-admin');
  return d;
}

/** 最近一件任务（夹具里同一时刻只有一件）——`rowid` 兜底，免 `created_at` 同秒并列。 */
function latestTask(d: DatabaseSync): { id: string; context_json: string } {
  return d.prepare('SELECT id, context_json FROM wa_tasks ORDER BY rowid DESC LIMIT 1').get() as { id: string; context_json: string };
}

/**
 * 跑一次中转执行器，并让它在**第一次轮询后**被"执行体"置为 `paused`（带因由）。
 *
 * 生产时序是 `create → updateContext → [执行体真跑，最终 pauseTask 写因] → poll`；
 * 本夹具把"执行体那一段"折进**注入的 `sleep`**（第一次睡眠即代执行体落暂停 + 因由），
 * 使 `poll` 时任务行**如实**是 `{status:'paused', context_json.pause_reason}`——正是被测读点面对的状态。
 */
async function runPaused(d: DatabaseSync, opts: { reason: string; answer?: string; reqOver?: Partial<AnsNodeRequest> }): Promise<{ runResult: RequestRunResult; contextJson: string }> {
  let wrote = false;
  const sleep = async (): Promise<void> => {
    if (wrote) return;
    wrote = true;
    const t = latestTask(d);
    const ctx = JSON.parse(t.context_json || '{}') as Record<string, unknown>;
    ctx.pause_reason = opts.reason;
    d.prepare("UPDATE wa_tasks SET status = 'paused', context_json = ? WHERE id = ?").run(JSON.stringify(ctx), t.id);
  };
  const runner = makeRelayRunner({ db: d as unknown as RunnerDb, pollMs: 1, timeoutMs: 10 * 60_000, now: () => 0, sleep });
  const req = ansReq({ id: 'rq-D1', ...opts.reqOver, ...(opts.answer !== undefined ? { answer: { answer: opts.answer } } : {}) });
  // `now: () => 0` ⇒ 永不触 deadline（冻结基准，G-4）。
  const runResult = await (runner as RequestRunner)(req, [], 'conversation');
  return { runResult, contextJson: latestTask(d).context_json };
}

/** `wa_settings` 单表夹具（`readNodeSetting` 的落点）。 */
function settingDb(settings: Record<string, string> = {}): NodeSettingDb {
  const d = new DatabaseSync(':memory:');
  d.exec("CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))");
  for (const [k, v] of Object.entries(settings)) d.prepare('INSERT INTO wa_settings (key,value) VALUES (?,?)').run(k, v);
  return d as unknown as NodeSettingDb;
}

/**
 * D5 夹具：`refreshDispatchResult` 的**最小库**——`wa_settings`（过 `isNodeEnrolled` 闸）
 *   + `wa_event_log`（`eventAlreadyRecorded` 的落点；空表 ⇒ 未记 ⇒ 该落的照落）。
 * ⚠ 只建被测路径真读的表；本模块 emit 走**注入**的 sink，不落库。
 */
function dispatchDb(): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec(`
    CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_type TEXT, aggregate_id TEXT, event_type TEXT, payload TEXT, occurred_at TEXT DEFAULT (datetime('now')));
  `);
  d.prepare('INSERT INTO wa_settings (key,value) VALUES (?,?)').run(NODE_SETTING_KEYS.id, 'n-self');
  d.prepare('INSERT INTO wa_settings (key,value) VALUES (?,?)').run(NODE_SETTING_KEYS.resourceGroup, 'node:n-self');
  // zx_20261012：判据增②（非占位凭据）——真形状须补非占位 `ans_api_key`（断言逐条原样）。
  d.prepare('INSERT INTO wa_settings (key,value) VALUES (?,?)').run(NODE_SETTING_KEYS.ansApiKey, 'wa_rr_enrolled_key');
  return d;
}

/** 读回一单（注入假 IO + 假 emit），返回 emit 到的 `(type, data)` 序列。 */
async function readBack(d: DatabaseSync, req: AnsNodeRequest): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  const seen: Array<{ type: string; data: Record<string, unknown> }> = [];
  await refreshDispatchResult(d as unknown as Parameters<typeof refreshDispatchResult>[0], req.id, {
    io: { submit: async () => req, get: async () => req, answer: async () => req },
    emit: (type, data) => { seen.push({ type, data }); },
  });
  return seen;
}

async function main(): Promise<void> {
  // ═══ A｜D1 relay 遇 `paused` 分因（道德经·名可名：一个名盖不住两件事）════════════
  console.log('\n【A】D1 paused 分因（真在等人 ≠ 跑完未收口）');
  {
    // —— 分类真源两标本（人话取自一处真源，未知因由原文回显）——
    eq(pauseReasonLabel(recordedPauseReason(JSON.stringify({ pause_reason: PAUSE_REASON_AWAITING_INPUT }))),
      '等待用户回复/决策',
      'A-1 ★真在等人 ⇒ 人话「等待用户回复/决策」（`recordedPauseReason`→`pauseReasonLabel` 一处真源）');
    eq(pauseReasonLabel(recordedPauseReason(JSON.stringify({ pause_reason: PAUSE_REASON_ABNORMAL_END }))),
      '执行未能正常收口',
      'A-2 ★★**本轮病根标本**：跑完未收口 ⇒ 人话「执行未能正常收口」（旧实现把它也说成"有人在等"）');
    ok(pauseReasonLabel(recordedPauseReason(JSON.stringify({ pause_reason: 'some_new_reason' }))) === 'some_new_reason',
      'A-3 未知因由**原文回显**（不吞、不编——新因由未入词表也不误报成因不明）');

    // —— runner 端到端两标本：同一条产线，仅因由不同 ⇒ 两种回传 ——
    const d1 = relayDb();
    const r1 = await runPaused(d1, { reason: PAUSE_REASON_AWAITING_INPUT });
    const d2 = relayDb();
    const r2 = await runPaused(d2, { reason: PAUSE_REASON_ABNORMAL_END });

    eq([r1.runResult.status, r1.runResult.result.taskStatus, r1.runResult.result.pauseReason],
      ['error', 'paused', PAUSE_REASON_AWAITING_INPUT],
      'A-4 ★端到端：`paused` 任务 ⇒ 如实 `error`，`taskStatus=paused` 且**原样带出** `pauseReason`（机器可读）');
    ok(String(r1.runResult.result.error).includes('等待用户回复/决策'),
      'A-5 ★端到端：回传文案含该因由的人话（不是写死的"有人在等"）', String(r1.runResult.result.error));
    ok(String(r2.runResult.result.error).includes('执行未能正常收口')
      && r2.runResult.result.pauseReason === PAUSE_REASON_ABNORMAL_END,
      'A-6 ★★端到端**反面标本**：`abnormal_end` ⇒ 回传「执行未能正常收口」（与 A-5 **两句不同**——这才叫分因）',
      String(r2.runResult.result.error));
    ok(r1.runResult.result.error !== r2.runResult.result.error,
      'A-7 ★两句不同（若仍走旧实现，两者会是同一句"awaiting input"）');
    ok(!String(r1.runResult.result.error).includes('awaiting input')
      && !String(r2.runResult.result.error).includes('awaiting input'),
      'A-8 ★写死的 `awaiting input` 文案已除（用户可见文案里不再有它）');
    ok(typeof r1.runResult.result.taskId === 'string' && String(r1.runResult.result.taskId).length > 0,
      'A-9 回传仍带 `taskId`（可追溯性不因分因而丢）');

    // —— 静态：分因人话取自真源；不再内联一份因由词表 ——
    const RUNNER = RD(`${A}/src/main/core/node-request-runner.ts`);
    ok(RUNNER.includes('recordedPauseReason(row?.context_json)') && RUNNER.includes('pauseReasonLabel(pauseReason)'),
      'A-10 ★接线：runner **引并调**分因真源（`recordedPauseReason` + `pauseReasonLabel`）');
    ok(/from\s*'\.\/pause-reason\.js'/.test(RUNNER),
      'A-11 真源经 import 引入（非在 runner 里重抄一份因由→人话的表）');
    ok(!CODE(`${A}/src/main/core/node-request-runner.ts`).includes('awaiting input'),
      'A-12 ★代码（去注释）零 `awaiting input` 字面量（注释里提旧文案不构成本文之病，G-5）');
  }

  // ═══ B｜D1b 答案注入（维特根斯坦·意义即用法：答案得真送到执行体）══════════════════
  console.log('\n【B】D1b 作答随重跑注入（一处真源 + 一答一用）');
  {
    // —— 解析器两标本 ——
    eq(answerOf(JSON.stringify({ [NODE_ANSWER_KEY]: '用中文写' })), '用中文写',
      'B-1a 从中继任务上下文读出**已注入的作答**');
    eq([answerOf('{}'), answerOf('not json'), answerOf(null), answerOf(JSON.stringify({ [NODE_ANSWER_KEY]: '' }))],
      [null, null, null, null],
      'B-1b 未注入 / 脏 json / 空串 / 缺值 ⇒ 一律 `null`（"还没答过"不伪装成"答过了"）');
    eq([NODE_ANSWER_KEY, NODE_REQUEST_ID_KEY], ['node_answer', 'node_request_id'],
      'B-2 ★契约名一处真源：`node_answer` 与 `node_request_id` 并列同处（写口读口皆取此常量）');

    // —— runner 行为：`req.answer` 非空 ⇒ 写进新任务上下文；无 ⇒ 不写该键（两侧标本）——
    const d3 = relayDb();
    const withAnswer = await runPaused(d3, { reason: PAUSE_REASON_ABNORMAL_END, answer: '按中文作答' });
    const ctx3 = JSON.parse(withAnswer.contextJson || '{}') as Record<string, unknown>;
    eq(ctx3[NODE_ANSWER_KEY], '按中文作答',
      'B-3 ★★端到端：`req.answer` 非空 ⇒ 重跑的新任务上下文**带上**该答案（病根：新任务既不带来、又被重问）');
    eq(ctx3[NODE_REQUEST_ID_KEY], 'rq-D1',
      'B-4 同一处 `updateContext` 亦写 `node_request_id`（派单 id 与派单答案同族、同处落）');

    const d4 = relayDb();
    const noAnswer = await runPaused(d4, { reason: PAUSE_REASON_ABNORMAL_END });
    const ctx4 = JSON.parse(noAnswer.contextJson || '{}') as Record<string, unknown>;
    ok(!(NODE_ANSWER_KEY in ctx4),
      'B-5 ★反面标本：未作答 ⇒ 上下文**不含** `node_answer` 键（"没这笔账"≠"账上是空串"）');

    // —— 静态接线 ——
    const RUNNER_B = CODE(`${A}/src/main/core/node-request-runner.ts`);
    ok(/\[NODE_ANSWER_KEY\]:\s*injectedAnswer/.test(RUNNER_B) && /req\.answer\?\.answer/.test(RUNNER_B),
      'B-6 ★接线：runner 建任务时从 `req.answer.answer` 取答案写进 `[NODE_ANSWER_KEY]`（真源接线，非摆设）');
    ok(/from\s*'\.\/node-clarify\.js'/.test(RUNNER_B) && /NODE_ANSWER_KEY/.test(RUNNER_B),
      'B-7 键名经 import 自一处真源（不在 runner 里手抄 `node_answer` 字符串）');
  }

  // ═══ C｜D1b `ask_user` 取答次序 + 一答一用（次序即判据）════════════════════════
  console.log('\n【C】D1b `ask_user` 次序与消费（先取已给的答案，再现问，最后自决）');
  {
    const CTRL = RD(`${A}/src/main/core/tools/control.ts`);
    const injectedIdx = CTRL.indexOf('answerOf(ctxJson)');
    const askerIdx = CTRL.indexOf('getRequestAsker()');
    const refusalIdx = CTRL.indexOf('noInteractionAskRefusal(ctxJson)');
    ok(injectedIdx >= 0 && askerIdx > injectedIdx && refusalIdx > askerIdx,
      'C-1 ★★次序即判据：`answerOf`（已给的答案）< `getRequestAsker`（现问现等）< `noInteractionAskRefusal`（自决兜底）',
      `answerOf@${injectedIdx} < asker@${askerIdx} < refusal@${refusalIdx}`);
    ok(CTRL.includes("json_remove(context_json, '$.node_answer')"),
      'C-2 ★**一答一用**：取到即 `json_remove` 删键（否则同一任务再问一个**不同**的问题会张冠李戴）');
    ok(/source:\s*'requester'/.test(CTRL),
      'C-3 已注入作答与其后现问的作答**同一条回执形状**（`source: requester`——模型无须分辨来源）');
    ok(/import\s*\{[^}]*answerOf[^}]*\}\s*from\s*'\.\.\/node-clarify\.js'/.test(CTRL),
      'C-4 `answerOf` 经 import 自一处真源（非在 control 里解析第二遍 `node_answer`）');
  }

  // ═══ D｜D3 放宽等待（可配、由常量派生、仍是有界）════════════════════════════════
  console.log('\n【D】D3 等作答上限（60s → 由常量派生；可配不写死）');
  {
    eq(CLARIFY_WAIT_SEC_DEFAULT, 180,
      'D-1 ★缺省上限一处真源＝180s（够人一次往返，且明显 < relay runner 的 10 分钟上限，不互相抢先超时）');

    // —— 解析器四态标本（设/不设/非法/非正）——
    const defMs = CLARIFY_WAIT_SEC_DEFAULT * 1000;
    eq(resolveClarifyWaitMs(settingDb({})), defMs,
      'D-2a 未设 `node.clarify_wait_sec` ⇒ 回落 `CLARIFY_WAIT_SEC_DEFAULT`（读不到≠值为空）');
    eq(resolveClarifyWaitMs(settingDb({ [NODE_SETTING_KEYS.clarifyWaitSec]: '45' })), 45_000,
      'D-2b 设 45 ⇒ 45_000ms（管理员可调，不写死）');
    eq([resolveClarifyWaitMs(settingDb({ [NODE_SETTING_KEYS.clarifyWaitSec]: 'abc' })),
      resolveClarifyWaitMs(settingDb({ [NODE_SETTING_KEYS.clarifyWaitSec]: '0' })),
      resolveClarifyWaitMs(settingDb({ [NODE_SETTING_KEYS.clarifyWaitSec]: '-3' }))],
      [defMs, defMs, defMs],
      'D-2c 非法/非正 ⇒ 一律回落缺省（坏设置不该把等待窗开成 0s 或负数）');
    eq(NODE_SETTING_KEYS.clarifyWaitSec, 'node.clarify_wait_sec',
      'D-2d 键名在 `NODE_SETTING_KEYS` 一处真源（散落字面量必有一处漂）');

    // —— 静态：`askRequester` 缺省由常量派生（不再硬编码 60_000）——
    const CLARIFY = CODE(`${A}/src/main/core/node-clarify.ts`);
    ok(/deps\.timeoutMs\s*\?\?\s*CLARIFY_WAIT_SEC_DEFAULT\s*\*\s*1000/.test(CLARIFY),
      'D-3 ★`askRequester` 缺省超时由 `CLARIFY_WAIT_SEC_DEFAULT` 派生（改常量即改缺省，不手抄时间数）');
    ok(!/deps\.timeoutMs\s*\?\?\s*60_000/.test(CLARIFY),
      'D-4 ★反证：写死的 `?? 60_000` 已除（60s 是 D1b 那条畸变的导火索）');
    ok(/export function resolveClarifyWaitMs\(/.test(CLARIFY) && /NODE_SETTING_KEYS\.clarifyWaitSec/.test(CLARIFY),
      'D-5 解析器 `resolveClarifyWaitMs` 具名导出、经 `NODE_SETTING_KEYS` 取键（读口一处真源）');

    // —— 静态：装配处按设置传参（且闭包外先求值——`let db` 收窄不进闭包体）——
    const IDX = CODE(`${A}/src/main/index.ts`);
    ok(/const clarifyWaitMs = resolveClarifyWaitMs\(db\);/.test(IDX)
      && /timeoutMs:\s*clarifyWaitMs/.test(IDX),
      'D-6 ★装配接线：`main/index.ts` 注册 asker 时传 `timeoutMs`（读设置、缺省回落常量）');
  }

  // ═══ E｜D2 派活候选收窄（一个规则一处：接得住 ∧ 在线）══════════════════════════
  console.log('\n【E】D2 派活下拉按"可派单 ∧ 在线"收窄（与 ANS `nodeQualifies` 同源同窄）');
  {
    // —— 组合判据标本（在线的可派 / 离线的可派 / 在线的观察者 / 未参与）——
    const online = new Date(NOW_MS - 10_000).toISOString();
    const offline = new Date(NOW_MS - (90_000 + 60_000)).toISOString(); // > NODE_OFFLINE_SEC=90s
    const cand = (role: NodeRole, participate: boolean, seen: string) =>
      ({ role, participate, last_seen_at: seen });
    const pick = (n: ReturnType<typeof cand>) => isDispatchable(n) && isNodeOnline(n.last_seen_at, NOW_MS);
    eq([
      pick(cand('worker', true, online)),        // 接得住 ∧ 在线 ⇒ 收
      pick(cand('primary', true, online)),       // 接得住 ∧ 在线 ⇒ 收
      pick(cand('worker', true, offline)),       // 接得住 ∧ 离线 ⇒ 不收
      pick(cand('observer', true, online)),      // 观察者只分不接 ⇒ 不收
      pick(cand('worker', false, online)),       // 未参与 ⇒ 不收
    ], [true, true, false, false, false],
      'E-1 ★★候选判据两标本：仅「接得住 ∧ 在线」入选；离线 / 观察者 / 未参与**皆落选**（E2E ③ 标本：B 转观察者仍在列）');
    eq(isNodeOnline(null, NOW_MS), false,
      'E-2 无 `last_seen_at` ⇒ 离线（"不知道就不说成在线"——离线候选不该出现在可派列）');

    // —— 静态接线：候选由 `isDispatchable ∧ isNodeOnline` 派生；`others` 仍供分组 ——
    const PEERS = CODE(`${A}/renderer/src/pages/PeersPage.tsx`);
    ok(/const dispatchCandidates = others\.filter\(n => isDispatchable\(n\) && isNodeOnline\(n\.last_seen_at, nowMs\)\)/.test(PEERS),
      'E-3 ★接线：`dispatchCandidates` 由 `isDispatchable ∧ isNodeOnline` 派生（与 ANS 侧 `nodeQualifies` 同窄）');
    ok(/<DispatchCard candidates=\{dispatchCandidates\}/.test(PEERS),
      'E-4 ★派活卡**真喂**收窄后的候选（不是算了一份却仍传 `others`）');
    ok(!/<DispatchCard candidates=\{others\}/.test(PEERS),
      'E-5 反证：把 `others` 原样喂进卡内的旧写法已除（留着即回退）');
    ok(/const groups = NODE_ROLES\.map\(.*others\.filter\(/.test(PEERS),
      'E-6 ★分组**仍用 `others`**（面板如实展示所有邻居——在线的观察者也该看得见，只是不该出现在可派列）');
    ok(/from '\.\.\/lib\/node-view'/.test(RD(`${A}/renderer/src/pages/PeersPage.tsx`))
      && /isDispatchable/.test(PEERS),
      'E-7 两个判据皆经 import 自各自真源（不在此页重写"什么算可派/在线"）');
  }

  // ═══ F｜D5/D6 收口复看照出的两处（A 端台账名实 / 外部终端不瞎问）══════════════════
  console.log('\n【F】D5 台账不把"等人答"钉成失败 + D6 外部终端不写 node_request_id');
  {
    // —— D5 行为：三标本（error∧asked 不落 / error 无待答照落 / done 照落）——
    const askedErr = await readBack(dispatchDb(), ansReq({
      status: 'error', question_status: 'asked',
      question: { question: '要中文还是英文？' },
      result: { error: 'relay task paused: 等待用户回复/决策', taskStatus: 'paused' },
    }));
    ok(!askedErr.some((e) => e.type === 'node.request_result'),
      'F-1 ★★D5：`error` ∧ 有一问**未答**（`question_status=asked`）⇒ **不落** `node.request_result`',
      askedErr.map((e) => e.type).join(',') || '（无）');
    ok(askedErr.some((e) => e.type === 'node.request_question'),
      'F-2 ★D5：同一读回**仍落** `node.request_question`（待答块照上屏——别把话一起吞了）');

    const plainErr = await readBack(dispatchDb(), ansReq({
      status: 'error', question_status: null, result: { error: '真·执行失败' },
    }));
    ok(plainErr.some((e) => e.type === 'node.request_result' && e.data.status === 'error'),
      'F-3 ★反面标本：`error` ∧ **无**待答 ⇒ **照落** `node.request_result(status=error)`（真失败不因 D5 被吞）');

    const doneRerun = await readBack(dispatchDb(), ansReq({
      status: 'done', question_status: 'answered', answer: { answer: '用中文' }, result: { taskStatus: 'completed' },
    }));
    ok(doneRerun.some((e) => e.type === 'node.request_result' && e.data.status === 'done'),
      'F-4 ★D5 出路标本：作答后重跑收口的 `done` ⇒ 照落 result（`errorAwaitingAnswer` 只挡 error∧asked，不挡 done）');

    // —— D5 静态接线 ——
    const DISP = CODE(`${A}/src/main/core/node-dispatcher.ts`);
    ok(/const errorAwaitingAnswer = request\.status === 'error' && request\.question_status === 'asked';/.test(DISP),
      'F-5 ★接线：D5 判据**具名**（error ∧ asked）——不是内联进 `if` 的一团、可被单独读懂');
    ok(/&& !errorAwaitingAnswer && !eventAlreadyRecorded\(/.test(DISP),
      'F-6 ★接线：该判据真参与 result 落账的**前置**（算了却不用＝摆设）');

    // —— D6 行为：两侧标本（对等派发写 / 外部终端不写）——
    const peerCtx = JSON.parse((await runPaused(relayDb(), { reason: PAUSE_REASON_ABNORMAL_END })).contextJson || '{}') as Record<string, unknown>;
    eq(peerCtx[NODE_REQUEST_ID_KEY], 'rq-D1',
      'F-7 ★★D6：对等派发（`requester_node_id` 非空）⇒ 上下文**含** `node_request_id`（ask_user 能据它向上游问）');

    const extCtx = JSON.parse((await runPaused(relayDb(), { reason: PAUSE_REASON_ABNORMAL_END, reqOver: { requester_node_id: null } })).contextJson || '{}') as Record<string, unknown>;
    ok(!(NODE_REQUEST_ID_KEY in extCtx),
      'F-8 ★★D6反面标本：外部 AI 终端（`requester_node_id=null`）⇒ **不含** `node_request_id`（不再对着空气瞎问满一窗）');

    const extAnsCtx = JSON.parse((await runPaused(relayDb(), { reason: PAUSE_REASON_ABNORMAL_END, answer: '外部答案', reqOver: { requester_node_id: null } })).contextJson || '{}') as Record<string, unknown>;
    ok(!(NODE_REQUEST_ID_KEY in extAnsCtx) && !(NODE_ANSWER_KEY in extAnsCtx),
      'F-9 ★D6：外部终端**即便带了 answer** ⇒ 两键**皆不写**（无上游作答者，注入亦无意义）');

    // —— D6 静态接线 ——
    const RUNNER_F = CODE(`${A}/src/main/core/node-request-runner.ts`);
    ok(/const peerDispatch = req\.requester_node_id != null;/.test(RUNNER_F),
      'F-10 ★接线：D6 判据由 `requester_node_id` 派生（对等派发 ⇔ 有人可答）');
    ok(/\.\.\.\(peerDispatch \? \{ \[NODE_REQUEST_ID_KEY\]: req\.id \} : \{\}\)/.test(RUNNER_F),
      'F-11 ★接线：`node_request_id` **仅对等派发时写**（外部终端不写）');
    ok(/const injectedAnswer = peerDispatch && typeof req\.answer\?\.answer/.test(RUNNER_F),
      'F-12 ★接线：答案注入**同受此闸**（不写 id 的件也不注入答案——同一判据一处）');

    // —— D7（收口复看·**实机照出**）：出站读回轮询**无固定次数上限** ——
    //   旧 40×5s＝200s 到点即停；而真任务常跑数分钟（实测 349s）⇒ 收口那一下被漏掉、行永停"待回"。
    const PEERS_F = CODE(`${A}/renderer/src/pages/PeersPage.tsx`);
    ok(/setInterval\(/.test(PEERS_F) && /nodesApi\.dispatchResult\(id\)/.test(PEERS_F)
      && !/tries\s*>=\s*\d+/.test(PEERS_F) && /clearInterval/.test(PEERS_F),
      'F-13 ★★D7：出站读回轮询**无固定次数上限**（以"行离开 pending"为止，而非一个猜出来的窗长）');
  }

  // ═══ G｜D8 问/答不即时上屏（**实机照出**：主进程漏转发两条）══════════════════════
  console.log('\n【G】D8 双向澄清两跳要送渲染层（台账列了四孔、墙上就得有四根线）');
  {
    // 病形：`DispatchLedger` 的 `liveTypes` 列了四类，主进程 `forwardToRenderer` 却只有两条 ⇒
    //   `node.request_question`/`node.request_answered` **落库却到不了渲染层** ⇒ B 发问/本机作答不即时上屏
    //   （实机：07:45:41 已问，面板一直不显，手动刷新才见）。
    // 判据读**去注释后**的代码：注释里写一句"已转发"不算数（完备性扫面读剥离后的代码）。
    const IDX_G = CODE(`${A}/src/main/index.ts`);
    const FORWARD = ['node.request_dispatched', 'node.request_result', 'node.request_question', 'node.request_answered'] as const;
    ok(FORWARD.every((ty) => IDX_G.includes(`forwardToRenderer('${ty}'`)),
      'G-1 ★★D8：四类出站事件**各**经 `forwardToRenderer` 送 `task:event`——少一条该类事件落库却到不了面板、台账不即时刷');
    // 另一端配对：renderer 的订阅面须与 main 的转发面**一一对应**（两处各写各的即"插头与线不配对"）。
    const PEERS_G = RD(`${A}/renderer/src/pages/PeersPage.tsx`);
    const ledgerLive = [...PEERS_G.matchAll(/liveTypes:\s*\[([^\]]*)\]/g)].map((m) => m[1]).find((s) => s.includes("'node.request_dispatched'")) ?? '';
    ok(FORWARD.every((ty) => ledgerLive.includes(`'${ty}'`)),
      'G-2 ★★D8：出站台账 `liveTypes` 与主进程转发**四类一一对应**（缺一类该类事件即不即时上屏）');
  }

  // ═══ H｜D9 不可交互任务不得暂停等待人工（**实机照出**：中继任务被路径审批闸假失败）══════
  console.log('\n【H】D9 不可交互任务不置停（咽喉把守：一处真源 + 置停之前）');
  {
    // 判据真源＝`noInteractionPauseRefusal`（与 `noInteractionAskRefusal` 同族，M11 语义只在 no-interaction.ts）。
    const refusal = JSON.parse(noInteractionPauseRefusal(JSON.stringify({ [NO_INTERACTION_KEY]: true }), 'path_approval') || 'null') as Record<string, unknown> | null;
    eq([refusal?.status, refusal?.decision_type], ['cannot_pause', 'path_approval'],
      'H-1 ★★不可交互任务的路径审批闸 ⇒ 回 `cannot_pause` 拒绝回执（**不**是 `paused`——旧写法会把它置停，relay 轮询即误报失败）');

    eq([
      noInteractionPauseRefusal('{}', 'path_approval'),
      noInteractionPauseRefusal(JSON.stringify({ [NO_INTERACTION_KEY]: false }), 'privilege_approval'),
      noInteractionPauseRefusal('not json', 'path_approval'),
    ], [null, null, null],
      'H-2 ★两侧标本：可交互 / 显式 false / 脏 json ⇒ **一律 `null`**（照常暂停——抑制只在确知时生效，不误伤普通任务）');

    // 静态：**咽喉把守**——`pauseForDecision` 在**置停之前**先问真源并 return。
    //   次序即判据：若守卫落在 `pauseTask` 之后，任务已被置 `paused`，relay 仍会误报失败（病根原样）。
    const EXEC = CODE(`${A}/src/main/core/agent-executor.ts`);
    const guardIdx = EXEC.indexOf('noInteractionPauseRefusal(');
    const persistIdx = EXEC.indexOf('persistAwaitingInput(db, taskId');
    const pauseIdx = EXEC.indexOf('pauseTask(db, { taskId, reason: PAUSE_REASON_AWAITING_INPUT })');
    ok(guardIdx >= 0 && persistIdx > guardIdx && pauseIdx > guardIdx,
      'H-3 ★★次序即判据：闸判在 `persistAwaitingInput` / `pauseTask` **之前**（若置停在前，任务已 paused，relay 仍误报失败）',
      `guard@${guardIdx} < persist@${persistIdx} < pause@${pauseIdx}`);

    // 覆盖面**逐成员枚举**：两处**瞬态**审批闸皆经 `pauseForDecision` ⇒ 一处把守即全覆盖。
    const SHELL = CODE(`${A}/src/main/core/tools/shell.ts`);
    ok(EXEC.includes("pauseForDecision('path_approval'") && SHELL.includes("pauseForDecision('privilege_approval'"),
      'H-4 ★覆盖面逐成员枚举：`path_approval`（写入审批）与 `privilege_approval`（特权命令）**两闸皆经** `pauseForDecision` ⇒ 一处把守全覆盖');

    ok(/import\s*\{[^}]*noInteractionPauseRefusal[^}]*\}\s*from\s*'\.\/no-interaction\.js'/.test(EXEC),
      'H-5 判据经 import 自 `no-interaction.ts` 一处真源（不在 agent-executor 手抄第二份 `no_interaction` 判断）');
    ok(/export function noInteractionPauseRefusal\(/.test(RD(`${A}/src/main/core/no-interaction.ts`)),
      'H-6 真源具名导出（被删/改名 ⇒ 本套件编译期失败，不静默假绿）');
  }

  // ═══ I｜D10 终态不可复活（**实机照出**：/answer 能把已完成的单子重跑）══════════════
  console.log('\n【I】D10 `/answer` 挡终态 + 面板不再提供死动作');
  {
    // 静态**次序**：ANS `/answer` 的终态闸须在**幂等分支之后**（已答重投仍 200，不误伤）
    //   且 `question_status !== 'asked'` 判据**之前**（先挡"复活"，再谈"无待答"）。
    const NODES = CODE('apps/ans-server/src/routes/nodes.ts');
    //   扫面须**限于 `/answer` 处理体内**：`/result` 处理器里也有一句同形的终态守卫
    //   （`if (row.status === 'done' || row.status === 'error')`），不设起点会把它认成本闸（假绿/假红）。
    const ansStart = NODES.indexOf("'/requests/:id/answer'");
    const idemIdx = NODES.indexOf("if (row.question_status === 'answered') return", ansStart);
    const termIdx = NODES.indexOf("if (row.status === 'done' || row.status === 'error')", ansStart);
    const noQIdx = NODES.indexOf("if (row.question_status !== 'asked')", ansStart);
    ok(ansStart >= 0, 'I-0 `/answer` 路由在场（次序判据的扫描起点，缺则下面三条全无意义）', `ansStart@${ansStart}`);
    ok(idemIdx >= 0 && termIdx > idemIdx && noQIdx > termIdx,
      'I-1 ★★次序即判据：`/answer` 终态闸在**幂等分支之后**（已答重投仍 200）、`question_status!==asked` **之前**（先挡复活）',
      `幂等@${idemIdx} < 终态闸@${termIdx} < 无待答@${noQIdx}`);

    // 面板名实：作答框与「待作答」徽标**仅当行还 `pending`**；旧承诺"作答后会重跑"（已被堵死的路）已除。
    const PEERS_I = CODE(`${A}/renderer/src/pages/PeersPage.tsx`);
    ok(/rec\.questionStatus === 'asked' && rec\.status === 'pending' && <QuestionBlock/.test(PEERS_I),
      'I-2 ★★renderer：作答框 `QuestionBlock` 以 `status===\'pending\'` 为前置（终态件不再给作答框——那动作已被 400 拒绝）');
    ok(/rec\.questionStatus === 'asked' && rec\.status === 'pending' && <span/.test(PEERS_I),
      'I-3 ★renderer：「待作答」徽标同受 `status===\'pending\'` 前置（不再与红「失败」并列摆着）');
    ok(!PEERS_I.includes('你作答后会以该答案重跑'),
      'I-4 ★反证：旧文案"你作答后会以该答案重跑"已除（承诺了一条**已被 D10 闸堵死**的路——名实不符）');
  }

  // ═══ S｜哑雷自检 + build 钉（派生核对，不写轮次字面量）══════════════════════════
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
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261011_2: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261011_2 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_zx_20261011_2: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
