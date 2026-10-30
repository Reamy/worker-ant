/**
 * zx_20261011 受控复跑 —— 「派活」（C2 核心闭环：把一单活派给网络里的某台工蚁，读回收口）。
 *
 * 病根（`plans/improve/zx_20261011.md` §1.1）：接收侧（拉待办 → 本地跑 → 回传）自 M12 已齐备，但
 *   **发送侧零调用**——工蚁桌面从不主动派活；`ans_nodes` 的卡里写着 `project_task`，面板却写「暂不支持
 *   跨机派发」。名存实亡（维特根斯坦·意义即使用：一个从不被使用的动词，等于没有这个动词）。
 *
 * 判据分四层：
 *   A. **core 行为**（王阳明·知行合一）：`dispatchNodeRequest` 喂**假 io 两侧**——成功体 emit
 *      `node.request_dispatched` 且回填 id/目标/状态；失败体（io 抛）⇒ `ok:false` + 非空 note、**不 emit**。
 *   B. **未入网短路**：`dispatchNodeRequest` / `refreshDispatchResult` 皆如实 `not-enrolled`，
 *      **不触 io**（没有身份就没有读回凭据——不造"派得出去、收不回来"的假闭环）。
 *   C. **出站台账 0→1**（道德经·合抱之木生于毫末）：`listNodeDispatchRecords` 从 0 行起——
 *      喂一条 `dispatched`（形状由 A 捕获的 emit **派生**，非自造）⇒ 1 行 `pending`；
 *      再喂 `result` ⇒ 同一行翻 `done`/`error` 且算出 `durationMs`（**一次派发一行**，不是两条事件两行）。
 *   D. **接线静态**：IPC 写口 `nodes:dispatch` 过 Team 软闸 + 台账读口 `/dispatch-result` 不过闸；
 *      `event-bus` 两类事件入 `node_dispatch` 聚合映射；`index.ts` 两处转发到渲染层；渲染层通道在册；
 *      ANS 侧**同源判据**（`DISPATCHABLE_WHERE` 一处 WHERE、负载感知排序纯函数 `node-ranking.ts`、读回端点、`requester_node_id` 列）。
 *   E. **renderer 第二落点**（词表的第二个落点）：源码 + 产物含「派活」卡的用户可见文案，且**旧横幅已除**。
 *
 * ── 纪律（承 auto-memory 各条）──────────────────────────────────────────────
 *   G-1 **用生产函数**：判据一律调生产导出（静态导入 ⇒ 被删/改名即编译期失败）。
 *   G-2 **两侧标本**：派发成功/失败、读回终态/非终态、未入网——两侧都喂（只喂一侧则过宽变体全票通过）。
 *   G-3 **计数器用 0→1 正面断言**（`length: 0 → 1`），不用"不抛"代替。
 *   G-4 **不碰真实网络 / 不依赖真实墙钟**：io 一律注入假实现；`durationMs` 用固定 ISO 差（不 sleep）。
 *   G-5 静态判据读**原文**（去注释在本仓是静默毁伤）——一律 `RD(...)`，不 `strip`。
 *   G-6 **无轮次字面量**：本轮方案路径与脚本名由 `path.basename(__filename)` 派生（末尾自检）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
// G-1：判据引用的生产符号**全部静态导入** ⇒ 被删/改名即编译期失败（而非"扫了个空、静默假绿"）。
import {
  dispatchNodeRequest, refreshDispatchResult,
  type DispatchIo, type DispatchEventSink,
} from '../apps/worker-ant-desktop/src/main/core/node-dispatcher.js';
import {
  listNodeDispatchRecords, type NodeDispatchRecord,
} from '../apps/worker-ant-desktop/src/main/core/node-dispatch-log.js';
// zx_20261011 M9（追加批）：入站台账（同病同治）——两本账形状对齐由 M9-3 行为断言钉住。
import { listNodeCallRecords } from '../apps/worker-ant-desktop/src/main/core/node-call-log.js';
// zx_20261011 M10（追加批）：接线那一跳的真源 + 中转标题/回传摘要的真源。
import { nodeRequestEventToLog } from '../apps/worker-ant-desktop/src/main/core/node-request-worker.js';
import { relayTaskTitle, readOutcome } from '../apps/worker-ant-desktop/src/main/core/node-request-runner.js';
// zx_20261011_1 M5（收口真源统一）：IM 通知与 relay 回传**同引**的"取哪份内容"真源。
import { completionNoticeFallback, resolveTaskOutcome, resolveTaskProducedFile, PRODUCED_FILE_MIN_CHARS } from '../apps/worker-ant-desktop/src/main/core/task-outcome.js';
import type { TaskOutcomeDb } from '../apps/worker-ant-desktop/src/main/core/task-outcome.js';
import { isNoInteraction, noInteractionAskRefusal, NO_INTERACTION_KEY } from '../apps/worker-ant-desktop/src/main/core/no-interaction.js';
// zx_20261011 M10（三轮）：卡片摘要去壳的真源（renderer 侧纯函数，rr 直跑**行为**）。
import { briefFromText, resultBrief } from '../apps/worker-ant-desktop/renderer/src/lib/result-brief.js';
import type { AnsNodeRequest, NodeRequestSubmit } from '@worker-ant/shared-types';

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
const S = 'apps/ans-server';
/** 静态判据读**原文**（G-5：去注释在本仓是静默毁伤——"注释里写着有、代码里没有"正是要防的形态）。 */
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
/** 递归收集某目录下全部 `.ts`（静态判据扫**整个 main src**——防"另开一处"绕过）。 */
function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (e.isFile() && e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

/** 本套件轮次标识由**载体自身**派生（G-6：不写"只为下一轮为真"的字面量）。 */
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, ''); // zx_20261011

/* ── 夹具 ────────────────────────────────────────────────────────────────── */

/**
 * `wa_settings` + `wa_event_log` 两表夹具（`isNodeEnrolled` 读前者；`refreshDispatchResult`
 *   的幂等守卫与 `listNodeDispatchRecords` 读后者）。DDL 与生产同形——按事件日志的真实列形状建，
 *   否则"读到 0 行"是夹具缺列所致，断言只在自我印证。
 */
function settingDb(settings: Record<string, string> = {}): DatabaseSync {
  const d = new DatabaseSync(':memory:');
  d.exec("CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')))");
  d.exec("CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT DEFAULT '{}', occurred_at TEXT DEFAULT (datetime('now')))");
  for (const [k, v] of Object.entries(settings)) d.prepare('INSERT INTO wa_settings (key,value) VALUES (?,?)').run(k, v);
  return d;
}
/**
 * **已入网**夹具：`node.id` 在 ∧ `node.resource_group === node:<id>`（`isNodeEnrolled` 的唯一判据）。
 * zx_20261011_1 M3 订正：`dispatchNodeRequest` 增**派发侧角色闸**——角色缺省＝`worker`（只接不分）。
 *   本套件 A/C/M9 段演的是"**要派得出去**"的正路，故夹具须显式带上可派档（`primary`）；
 *   否则真源一变默认档，此处就会以 `role-cannot-dispatch` 假红（M3 后首跑实测 10 条）。
 *   ⚠ 这是"夹具补足前置条件"，不是放宽判据——角色闸本身由 `rr_zx_20261011_1` 的 E 段正反两侧钉死。
 */
function enrolledDb(): DatabaseSync {
  // zx_20261012：判据增②（非占位凭据）——真形状须补非占位 `ans_api_key`（断言逐条原样）。
  return settingDb({ 'node.id': 'n-self', 'node.resource_group': 'node:n-self', 'node.role': 'primary', ans_api_key: 'wa_rr_enrolled_key' });
}
/** 库字面量（判据只读列名，不写轮次字面量）。 */
const asDb = (d: DatabaseSync) => d as unknown as import('better-sqlite3').Database;

/** 一条 ANS 请求的**真形状**（A/C 两侧标本共用；字段齐备，只改要验的那几个）。 */
function ansReq(over: Partial<AnsNodeRequest>): AnsNodeRequest {
  return {
    id: 'req-0001', category: 'project_task', payload: { prompt: '干活' },
    requester_key_prefix: 'ab12', requester_node_id: 'n-self', target_node_id: 'n-other',
    status: 'pending', result: null,
    // zx_20261011_1 M4：澄清三字段（无问答即全 `null`；两侧标本按需 over）。
    question: null, answer: null, question_status: null,
    created_at: '2026-10-11T00:00:00.000Z', claimed_at: null, done_at: null,
    ...over,
  };
}

/**
 * 假 io（G-4：受控回归喂假 ⇒ 不碰真实网络）。`impl` 只换**返回值/抛**，**记录仍在包装层**——
 *   若把 `impl` 铺在 `io` 上（覆盖 `submit` 本身），被覆盖的那份就不再 `push`，
 *   "恰一次提交"的断言会因"记录漏了"而假红（A-2 首轮实测）。故包装而非覆盖。
 */
function fakeIo(impl: {
  submit?: (req: NodeRequestSubmit) => AnsNodeRequest | Promise<AnsNodeRequest>;
  get?: (id: string) => AnsNodeRequest | Promise<AnsNodeRequest>;
} = {}): { io: DispatchIo; submits: NodeRequestSubmit[]; gets: string[] } {
  const submits: NodeRequestSubmit[] = []; const gets: string[] = [];
  const io: DispatchIo = {
    async submit(req) { submits.push(req); return impl.submit ? await impl.submit(req) : ansReq({}); },
    async get(id) { gets.push(id); return impl.get ? await impl.get(id) : ansReq({}); },
  };
  return { io, submits, gets };
}
/** 捕获式事件出口（记下每次 emit 的 type/data，供断言——不落库，避免"自造等价实现"）。 */
function captureEmit(): { emit: DispatchEventSink; calls: Array<{ type: string; data: Record<string, unknown> }> } {
  const calls: Array<{ type: string; data: Record<string, unknown> }> = [];
  return { emit: (type, data) => { calls.push({ type, data }); }, calls };
}
/** 把一条**捕获的 emit** 落成事件行——形状与 `event-bus` 持久化时一致（`idField='requestId'` ⇒ aggregate_id）。 */
function persistEmit(d: DatabaseSync, type: string, data: Record<string, unknown>, at: string): void {
  d.prepare("INSERT INTO wa_event_log (aggregate_type, aggregate_id, event_type, payload, occurred_at) VALUES ('node_dispatch',?,?,?,?)")
    .run(String(data.requestId), type, JSON.stringify(data), at);
}

async function main(): Promise<void> {
  // ═══ A｜core 行为（两侧标本 / 王阳明·知行合一）═════════════════════════════
  console.log('\n【A】派发行为（两侧标本：成功体 emit 到场、失败体如实拒且不 emit）');
  {
    const db = enrolledDb();
    const { io, submits } = fakeIo({ async submit() { return ansReq({ id: 'req-A1', target_node_id: 'n-other', status: 'pending' }); } });
    const cap = captureEmit();
    const r = await dispatchNodeRequest(asDb(db), { category: 'project_task', payload: { prompt: '跑一轮' } }, { io, emit: cap.emit });
    eq([r.ok, r.requestId, r.targetNodeId, r.status, r.note], [true, 'req-A1', 'n-other', 'pending', ''],
      'A-1 ★成功体：`ok=true`、回填 `requestId`/目标/状态、**note 空**（成功不留一句多余的"失败"）');
    eq(submits.length, 1, 'A-2 提交**恰一次**（不重复提交——重复即同一单派两回）');
    eq(submits[0], { category: 'project_task', payload: { prompt: '跑一轮' } },
      'A-3 ★提交体形状：类目 + `payload`（**无** `target_node_id` 键——留空=自动选；多带 null 会被 ANS 当显式指定）');
    eq([cap.calls.length, cap.calls[0]?.type], [1, 'node.request_dispatched'],
      'A-4 ★★**到场事件**：成功即 emit `node.request_dispatched`（出站台账的左半——没有它台账永是 0 行）');
    eq([cap.calls[0]?.data.requestId, cap.calls[0]?.data.category], ['req-A1', 'project_task'],
      'A-5 事件载荷带 `requestId`（=聚合键）+ 类目（面板据此显"我派了什么"）');

    // —— 手动指定目标：显式 `target_node_id` 落进提交体 ——
    const { io: io2, submits: subs2 } = fakeIo({ async submit() { return ansReq({ id: 'req-A2', target_node_id: 'n-pick' }); } });
    const cap2 = captureEmit();
    await dispatchNodeRequest(asDb(enrolledDb()), { category: 'text', targetNodeId: 'n-pick' }, { io: io2, emit: cap2.emit });
    eq(subs2[0], { category: 'text', target_node_id: 'n-pick' },
      'A-6 ★手动指定：`targetNodeId` 落成 `target_node_id`（自动选时不带此键——A-3 反证）');

    // —— 失败体（io 抛）——
    const { io: ioBad, submits: subsBad } = fakeIo({ async submit() { throw new Error('HTTP 400 目标节点不合格'); } });
    const capBad = captureEmit();
    const rb = await dispatchNodeRequest(asDb(enrolledDb()), { category: 'project_task' }, { io: ioBad, emit: capBad.emit });
    eq([rb.ok, rb.requestId, rb.status], [false, '', ''],
      'A-7 ★★两侧标本：io **抛** ⇒ `ok=false`、无 id/状态（若实现"无论成败都 emit"或无脑回 ok，此红）');
    ok(rb.note.includes('HTTP 400'), 'A-8 失败**如实报因**（透出 io 异常的人话，不是一句"失败了"）', rb.note);
    eq(capBad.calls.length, 0, 'A-9 ★★失败**不 emit 到场事件**（没派成的活不进台账——否则台账里躺着"派过"的幽灵）');

    // —— `emit` 抛不该改这单结局 ——
    const { io: io3 } = fakeIo();
    const r3 = await dispatchNodeRequest(asDb(enrolledDb()), { category: 'project_task' }, { io: io3, emit: () => { throw new Error('bus down'); } });
    eq(r3.ok, true, 'A-10 事件出口**抛** ⇒ 仍 `ok=true`（台账刷新失败不改这单的结局——两件事的成败分开算）');
  }

  // ═══ B｜未入网短路（不触 io）═══════════════════════════════════════════════
  console.log('\n【B】未入网（没有身份就没有读回凭据——不造假闭环）');
  {
    const { io, submits } = fakeIo();
    const cap = captureEmit();
    const r = await dispatchNodeRequest(asDb(settingDb()), { category: 'project_task' }, { io, emit: cap.emit });
    eq([r.ok, r.note], [false, 'not-enrolled'], 'B-1 ★未入网 ⇒ `ok=false` 且原因**恰是** `not-enrolled`（供面板说人话）');
    eq([submits.length, cap.calls.length], [0, 0],
      'B-2 ★★未入网**不触 io、不 emit**（连一次网络都不发——否则出网 403 才知没身份，白跑一趟）');

    const { io: io2, gets } = fakeIo();
    const rr = await refreshDispatchResult(asDb(settingDb()), 'req-x', { io: io2 });
    eq([rr.ok, rr.request, rr.note, gets.length], [false, null, 'not-enrolled', 0],
      'B-3 ★读回同短路：未入网 ⇒ `not-enrolled` 且不触 io（读回按 `node:<id>` 鉴权，没身份读不回）');
  }

  // ═══ C｜出站台账 0→1（道德经·合抱之木生于毫末）═════════════════════════════
  console.log('\n【C】出站台账（一条派发 = 两条事件，按 requestId 归并成一行）');
  {
    const db = enrolledDb();
    const log = db as unknown as { prepare(s: string): { all(...a: unknown[]): unknown[] } };
    eq(listNodeDispatchRecords(log, 50).length, 0, 'C-1 ★起点 **0 行**（0→1 的正面断言起点——非"不抛"）');

    // 派生：用 A 捕获的 emit 形状落行（不自造一份 payload 形状）
    persistEmit(db, 'node.request_dispatched', { requestId: 'req-D1', category: 'project_task', targetNodeId: 'n-other' }, '2026-10-11T00:00:00.000Z');
    let recs: NodeDispatchRecord[] = listNodeDispatchRecords(log, 50);
    eq(recs.length, 1, 'C-2 ★★计数器 **0→1**：恰好一条 `dispatched` ⇒ 恰一行台账（不是"两条事件两行"）');
    eq([recs[0]?.requestId, recs[0]?.status, recs[0]?.targetNodeId, recs[0]?.dispatchedAt, recs[0]?.resultAt, recs[0]?.durationMs],
      ['req-D1', 'pending', 'n-other', '2026-10-11T00:00:00.000Z', null, null],
      'C-3 只派出未收口 ⇒ `pending`、`resultAt=null`、**`durationMs=null`**（不编一个 0 冒充"瞬时完成"）');

    persistEmit(db, 'node.request_result', { requestId: 'req-D1', category: 'project_task', targetNodeId: 'n-other', status: 'done', result: { ok: 1 } }, '2026-10-11T00:00:12.000Z');
    recs = listNodeDispatchRecords(log, 50);
    eq(recs.length, 1, 'C-4 ★**归并**：同一 requestId 的第二条事件**不新增行**（一次派发仍是一行）');
    eq([recs[0]?.status, recs[0]?.durationMs, recs[0]?.result], ['done', 12000, { ok: 1 }],
      'C-5 ★★收口：终态翻 `done`、算出 `durationMs`（12s）、带上 result（读回的值真进了台账）');

    // 两侧标本：error 也是"终态"，但状态如实是 error 不是 done
    persistEmit(db, 'node.request_result', { requestId: 'req-D2', category: 'text', targetNodeId: '', status: 'error', result: null }, '2026-10-11T00:00:05.000Z');
    persistEmit(db, 'node.request_dispatched', { requestId: 'req-D2', category: 'text', targetNodeId: '' }, '2026-10-11T00:00:00.000Z');
    const d2 = listNodeDispatchRecords(log, 50).find((x) => x.requestId === 'req-D2');
    eq(d2?.status, 'error', 'C-6 ★两侧标本：`error` 收口 ⇒ 状态**如实**是 `error`（不与 done 混为一栏）');
  }

  // ═══ D｜接线静态（读原文，G-5）══════════════════════════════════════════════
  console.log('\n【D】接线（IPC 出口 / 事件映射 / 转发 / ANS 同源判据）');
  {
    const NIPC = RD(`${A}/src/main/ipc/nodes.ipc.ts`);
    const dIdx = NIPC.indexOf("ipcMain.handle('nodes:dispatch'");
    const lIdx = NIPC.indexOf("ipcMain.handle('nodes:dispatches'");
    const rIdx = NIPC.indexOf("ipcMain.handle('nodes:dispatch-result'");
    ok(dIdx >= 0 && lIdx > dIdx && rIdx > lIdx, 'D-1 三个出口**都在册**（dispatch 写口 / dispatches 台账 / dispatch-result 读回）');
    const dBody = dIdx >= 0 && lIdx > dIdx ? NIPC.slice(dIdx, lIdx) : '';
    ok(dBody.includes("teamFeatureRefusal(licDb, 'multi_node')") && dBody.includes('dispatchNodeRequest(db'),
      'D-2 ★派发**写口过 Team 软闸**且调 core（真源在 ANS——闸与 `nodes:update` 同源，漏一处即可绕过）');
    const rBody = rIdx >= 0 ? NIPC.slice(rIdx, rIdx + 600) : '';
    ok(rBody.includes('refreshDispatchResult(db') && !rBody.includes('teamFeatureRefusal('),
      'D-3 ★读回口**不过闸**（读自己派出去的东西不该因档位抛——承 `zx_20261010_1` §5.4-1 的偏离理由）');
    const lBody = lIdx >= 0 && rIdx > lIdx ? NIPC.slice(lIdx, rIdx) : '';
    ok(lBody.includes('listNodeDispatchRecords(') && !lBody.includes('teamFeatureRefusal('),
      'D-4 ★台账读口**不过闸**（与 `nodes:requests` 同形：读本地台账不该因档位抛）');

    const EB = RD(`${A}/src/main/core/event-bus.ts`);
    const unionSeg = /export type EventType =([\s\S]*?);/.exec(EB)?.[1] ?? '';
    const mapSeg = /EVENT_AGGREGATE_MAP[\s\S]*?\n\}/.exec(EB)?.[0] ?? '';
    ok(unionSeg.includes("'node.request_dispatched'") && unionSeg.includes("'node.request_result'"),
      'D-5 两类出站事件入 `EventType` union（否则 `emit` 编译期即红）');
    // zx_20261011_1 M4：澄清一问一答**同属出站聚合** ⇒ 映射由 2 处增至 4 处（钉更大的面，强度只增不减）。
    eq((mapSeg.match(/'node_dispatch'/g) ?? []).length, 4,
      'D-6 ★★出站四类事件**各**映射到 `aggregate_type: \'node_dispatch\'`（dispatched/result/question/answered——少一处则该类事件不落库、台账缺一半）');

    // 读**去注释后**的代码：判"是否**真转发**"须看真调用，注释里写一句 `forwardToRenderer('node.request_question'`
    //   并不能转发（完备性扫面读剥离后的代码）——否则把行注释掉也照样绿（负证实测照出）。
    const IDX = stripKeepingLines(RD(`${A}/src/main/index.ts`)).join('\n');
    // zx_20261011_2 D8（实机照出·维特根斯坦·一个规则一处）：旧判据只钉 dispatched/result 两条 ⇒
    //   「断言名冒充覆盖面」——澄清的一问一答（question/answered）**没被转发**也照样绿。
    //   病形：台账（`DispatchLedger`）的 `liveTypes` 列了四类、墙上却只有两根线 ⇒ 问/答**落库却到不了面板**。
    //   现按**四类逐枚举**（与渲染层 `liveTypes` 一一对应），缺一类即红。
    const FORWARD_TYPES = ['node.request_dispatched', 'node.request_result', 'node.request_question', 'node.request_answered'] as const;
    ok(FORWARD_TYPES.every((ty) => IDX.includes(`forwardToRenderer('${ty}'`)),
      'D-7 ★★四类出站事件（dispatched/result/question/answered）**各**经 `forwardToRenderer` 送 `task:event`——少一条该类事件落库却到不了面板、台账不即时刷（D8 实机病根）');

    const RIPC = RD(`${A}/renderer/src/lib/ipc.ts`);
    ok(["'nodes:dispatch'", "'nodes:dispatches'", "'nodes:dispatch-result'"].every((s) => RIPC.includes(s)),
      'D-8 渲染层三通道在册（通道名须与 main 逐字对得上）');

    // ── ANS 侧**同源判据**（静态读原文；行为两侧在 vitest `nodes-routes.test.ts`）──
    const NR = RD(`${S}/src/routes/nodes.ts`);
    ok(NR.includes('DISPATCHABLE_WHERE') && (NR.match(/DISPATCHABLE_WHERE/g) ?? []).length >= 2,
      'D-9 ★可派判据**一处 WHERE**（`DISPATCHABLE_WHERE` 定义并复用——自动选与手动校验同一把尺，抄两份必分家）');
    // zx_20261027_3 M1「实况」: 老 SQL 排序把「余力未知」当 1.0 满血 ⇒ 已由**纯函数** `node-ranking.ts` 取代。
    //   判据按符号重定向到新单一真源（不删不松）：三层序 free<unknown<full，仅 free 层计 weight×ratio。
    const RANK = RD(`${S}/src/routes/node-ranking.ts`);
    ok(/free:\s*0[^}]{0,40}unknown:\s*1[^}]{0,40}full:\s*2/.test(RANK)
      && /group === 'free' && ratio !== null \? weight \* ratio : weight/.test(RANK),
      'D-10 ★★负载感知排序**单一真源**（`node-ranking.ts`）：三层序 free<unknown<full，只有已知余力层计 `weight × ratio`'
      + '（余力未知按 weight、不假装满血——罗尔斯·无知之幕：不拿"不知道"当"没能力"）');
    ok(NR.includes('rankDispatchCandidates(') && !/ORDER BY[\s\S]{0,120}capacity_free_ratio/.test(NR),
      'D-10b ★接线：`nodes.ts` 排序交给同一纯函数，不再自持一份 SQL ORDER BY（两把尺必分家）');
    ok(/isNodeCardCategory/.test(NR), 'D-11 手动目标以**同源类目判据**校验（不手抄类目串表）');

    const SCR = RD(`${S}/src/db/schema.ts`);
    ok(/requester_node_id\s+TEXT/.test(SCR), 'D-12 `ans_node_requests` 增 `requester_node_id` 列（读回鉴权的载体）');
  }

  // ═══ E｜renderer 第二落点（词表的第二个落点）════════════════════════════════
  console.log('\n【E】「派活」上屏（renderer 第二落点：词表须穷举到界面）');
  {
    const PEERS = RD(`${A}/renderer/src/pages/PeersPage.tsx`);
    ok(PEERS.includes('function DispatchCard(') && PEERS.includes('nodesApi.dispatch('),
      'E-1 ★「派活」卡在场**且真调 IPC**（不是只画个按钮——知行合一：卡要接到动作上）');
    ok(PEERS.includes('function DispatchLedger(') && PEERS.includes('nodesApi.dispatches()'),
      'E-2 ★出站台账在场且读真源（`nodes.dispatches`）');
    // zx_20261011_2 D7（重定向到更强真源，非放宽）：旧判据钉的是 `tries>=N` 这个**猜出来的窗长**，
    //   而它正是 D7 缺陷本身（40×5s＝200s 到点即停，长任务收口那一下被漏掉 ⇒ 行永显"待回"）。
    //   改钉**真正的止轮条件**：轮询由 `pendingKey`（派生自 `status==='pending'`）驱动、空则提前 return、
    //   卸载清 interval——以"行离开 pending"为止，且反证旧窗长已除。比原判据更强（钉住"谁使它停"）。
    ok(PEERS.includes('nodesApi.dispatchResult(')
      && /const pendingKey = records\.filter\(r => r\.status === 'pending'\)/.test(PEERS)
      && /if \(!pendingKey\) return;/.test(PEERS)
      && /\}, \[pendingKey\]\);/.test(PEERS)
      && /setInterval\(/.test(PEERS) && /clearInterval/.test(PEERS)
      && !/tries\s*>=\s*\d+/.test(PEERS),
      'E-3 ★读回轮询**以"行离开 pending"为止**（`pendingKey` 派生自 `status===\'pending\'`、空则提前 return、卸载清 interval；反证 `tries>=N` 猜窗长已除——长任务收口不再被漏）');
    // zx_20261011_2 D8（维特根斯坦·两处对得上 / renderer 第二落点）：台账订阅的四类 `liveTypes` 须与**主进程
    //   转发的四类**一一对应——两处各写各的就会「台账列了四孔、墙上只两根线」（D8 实机病根即此）。
    //   ⚠ 本判据与 D-7 一上一下（main 转发端 ↔ renderer 订阅端）配对，缺任一端都拦得住。
    const ledgerLive = [...PEERS.matchAll(/liveTypes:\s*\[([^\]]*)\]/g)].map((m) => m[1]).find((s) => s.includes("'node.request_dispatched'")) ?? '';
    ok(['node.request_dispatched', 'node.request_result', 'node.request_question', 'node.request_answered'].every((ty) => ledgerLive.includes(`'${ty}'`)),
      'E-3b ★★出站台账 `liveTypes` 与主进程转发**四类一一对应**（dispatched/result/question/answered）——缺一类该类事件落库却到不了面板、问/答不即时上屏');
    // 旧横幅须从**用户可见的代码**里消失；但注释里追溯"旧文案已被兑现"是正当的（且是 G-5 意义上的好注释），
    //   故按**去注释后**的原文判——既抓"横幅仍在代码里"，又不误伤解释性注释。
    const peersCode = stripKeepingLines(PEERS).join('\n');
    ok(!peersCode.includes('暂不支持跨机派发'),
      'E-4 ★★**旧横幅已除**（去注释后代码里再无"暂不支持跨机派发"——卡片在而横幅仍在则自相矛盾）');

    // 产物（minify 后标识符搜不到，中文串可搜）——须先跑 renderer build。
    const assetsDir = path.join(root, `${A}/renderer/dist/assets`);
    const chunks = fs.existsSync(assetsDir)
      ? fs.readdirSync(assetsDir).filter((f) => /^PeersPage-.*\.js$/.test(f)) : [];
    eq(chunks.length, 1, 'E-5 PeersPage 产物 chunk 恰一个（renderer 已构建）');
    if (chunks.length === 1) {
      const c = fs.readFileSync(path.join(assetsDir, chunks[0]!), 'utf-8');
      ok(c.includes('派活') && c.includes('我派出去的活'),
        'E-6 ★产物含**派活卡 + 出站台账**的用户可见文案（空话补成了可操作的门）');
      ok(c.includes('自动（按负载/权重选）') && c.includes('对等派发'),
        'E-7 ★产物含**自动/手动目标**与**对等派发**边界文案（可辨"自动选"与"我指定"）');
      ok(c.includes('本机尚未入网——请先加入协同网络，才能派活。'),
        'E-8 ★未入网的`not-enrolled`在界面**说人话**（不把原样 code 甩给用户）');
    }
  }

  // ═══ M7｜退出期收尾「退得干净」（E2E 期发现的既有缺陷，追加批）════════════════
  //   G-5 二分：**存在性**判据读原文（`RD`）；**次序**类判据（"清在 await 之前"）是**执行顺序**命题——
  //   注释/字符串不参与执行 ⇒ 按**去注释后**代码判（承 auto-memory：命题是"真做 X"时读代码，
  //   注释不能清定时器）。**反证**：不以"worker has exited"串做等价自证（那正是病象本身）。
  console.log('\n【M7】退出期收尾（清定时器 / 静默收尾期异常 / flush 日志）');
  {
    const IDX = RD(`${A}/src/main/index.ts`);
    const IDXcode = stripKeepingLines(IDX);
    const idxText = IDXcode.join('\n');
    /** 取某**顶格**块（函数 / `app.on(...)`）体：自匹配行到其后首个列 0 的 `}`。 */
    const blockOf = (startRe: RegExp): string => {
      const s = IDXcode.findIndex((l) => startRe.test(l));
      if (s < 0) return '';
      const e = IDXcode.findIndex((l, i) => i > s && /^\}/.test(l));
      return IDXcode.slice(s, e < 0 ? undefined : e + 1).join('\n');
    };

    // 1. 无裸露定时器：**创建数 == 被 trackShutdownTimer 登记数**
    //    （只数"登记了几处"抓不住"新加一处没登记"——必须与创建总数比。）
    const created = (idxText.match(/\bset(?:Interval|Timeout)\(/g) ?? []).length;
    const wrapped = (idxText.match(/trackShutdownTimer\(\s*set(?:Interval|Timeout)\(/g) ?? []).length;
    ok(created > 0 && wrapped === created,
      'M7-1 ★★无裸露定时器：`index.ts` 每个 `setInterval`/`setTimeout` 创建皆经 `trackShutdownTimer(` 登记'
      + '（判据=创建数 vs 登记数相等——非"登记了 N 处"，新加一处漏登记即红）', `${wrapped}/${created}`);
    ok(/trackShutdownTimer\(\s*startPeriodicInvariantCheck\(/.test(idxText),
      'M7-2 ★小时不变量拍**返回的句柄也登记**（E2E 刷屏的正是它——不登记则清不掉）');

    // 2. `stopCore`：清定时器在**首个 await 之前**（清得早，await 窗口内不再到点触发）
    const stopText = blockOf(/^async function stopCore\(/);
    const clearPos = stopText.indexOf('for (const t of shutdownTimers)');
    const awaitPos = stopText.search(/\bawait\b/);
    ok(clearPos >= 0 && awaitPos > clearPos,
      'M7-3 ★★**先清后 await**：清 `shutdownTimers` 在 `stopCore` 首个 `await` 之前'
      + '（再往后的 await 窗口里定时器不再触发）', `clear@${clearPos} < await@${awaitPos}`);
    ok(/shutdownTimers\.length\s*=\s*0/.test(stopText),
      'M7-4 清后复位清单（不清空则重复 stop 清到已清句柄——虽无害，账也要平）');

    // 3. `before-quit` 次序单调：立旗 → 收尾 → flush → 硬退
    //    zx_20261024_4 追补：`app.exit(0)` 在本机**卡在 Electron 原生退出序列**（rr_zx_20261024_4 Z-6），
    //    末步改 `hardExit(0)`（`process.reallyExit`）。真源换了载体 ⇒ 断言重定向到新载体，非放宽。
    const bqText = blockOf(/^app\.on\('before-quit'/);
    const order = ['markShuttingDown(', 'await stopCore()', 'flushLoggersSync(', 'hardExit(0)']
      .map((s) => bqText.indexOf(s));
    ok(order.every((p) => p >= 0) && order.every((p, i) => i === 0 || p > order[i - 1]!),
      'M7-5 ★★退出次序单调：`markShuttingDown()` → `await stopCore()` → `flushLoggersSync()` → `hardExit(0)`'
      + '（旗在最前=收尾期异常静默；flush 在硬退前=末几行不丢）', order.join('<'));

    // 4. `resilience`：收尾期 `uncaughtException` **进处理体即静默 return**
    const RES = RD(`${A}/src/main/resilience.ts`);
    const resText = stripKeepingLines(RES).join('\n');
    ok(/export function markShuttingDown\(\)/.test(resText) && /_shuttingDown\s*=\s*true/.test(resText),
      'M7-6 `markShuttingDown()` 置 `_shuttingDown` 旗（供主进程收尾前调用）');
    ok(/process\.on\('uncaughtException'[\s\S]{0,220}?if\s*\(\s*_shuttingDown\s*\)\s*return/.test(resText),
      'M7-7 ★★收尾期 `uncaughtException` **进体即** `return`（写日志撞已退 worker 属预期竞态——不冒充异常、不误判致命、不进重启分支）');

    // 5. `logger`：导出 flush + **登记** multistream（漏登记 ⇒ flush 扫空仍全绿）
    const LOG = RD(`${A}/src/main/core/logger.ts`);
    ok(/export function flushLoggersSync\(\)/.test(LOG),
      'M7-8 `flushLoggersSync()` 导出（主进程 exit 前的落点）');
    ok(/for\s*\(\s*const d of _flushables\s*\)/.test(LOG) && /\.flushSync\?\.\(\)/.test(LOG),
      'M7-9 flush 逐项调 `flushSync`（对已退 worker 直接返不挂——与 `write` 同一把 `destroyed` 尺）');
    ok(/pino\.multistream\(streams\)/.test(LOG) && /_flushables\.push\(dest/.test(LOG),
      'M7-10 ★`createLogger` **登记**其 multistream 到 `_flushables`（漏登记 ⇒ flush 扫了个空仍全绿）');

    // 6. 承 F-8：`system-bootstrap` 的 `setInterval` 仍恰 1，且小时拍返回句柄
    const SB = RD(`${A}/src/main/core/system-bootstrap.ts`);
    eq((SB.match(/setInterval\(/g) ?? []).length, 1,
      'M7-11 承 F-8：`system-bootstrap` 的 `setInterval` 仍**恰 1**（本轮只让它返回句柄，不新造节拍）');
    ok(/const timer = setInterval\(/.test(SB) && SB.indexOf('return timer;') > SB.indexOf('const timer = setInterval('),
      'M7-12 小时拍**返回 `timer` 句柄**（`const timer = setInterval(` 之后确有 `return timer;`——否则调用方无从清除，M7-2 落空）');
  }

  // ═══ M8｜节点取名（E2E 期发现的半成品线：ANS 认 name、`NodePatch.name` 也在册，却**无任何写口**）═════
  //   病形（§7.1）：整链存在（ANS PATCH 收 name / `NodePatch.name` / IPC `nodes:update` / renderer `nodes.update`），
  //   但 (a) **任何 GUI 都没有名称输入框**、(b) 本机 name **从不镜像** ⇒ 同机两实例默认同名 hostname，台账无从分辨。
  console.log('\n【M8】节点取名（入网可就地取名 / 改档可改名——同机多实例可分辨）');
  {
    // G-5 二分：**存在性**判据读原文；**次序**判据（"先写本地名、再注册"）读**去注释后**代码——注释不执行，
    //   且该处注释正文就写着 `enrollWithToken`（按原文 indexOf 会命中注释 ⇒ 次序假绿）。
    const IPC = RD(`${A}/src/main/ipc/nodes.ipc.ts`);
    const ipcText = stripKeepingLines(IPC).join('\n');
    ok(/patch\.name\s*!==\s*undefined\s*&&\s*node\.name/.test(ipcText)
      && /writeNodeSetting\(settingDb,\s*NODE_SETTING_KEYS\.name,\s*node\.name\)/.test(ipcText)
      && /broadcastSetting\(NODE_SETTING_KEYS\.name,\s*node\.name\)/.test(ipcText),
      'M8-1 ★`nodes:update` 镜像 `name`（写本地 + 广播，与 role/weight/participate 同范式；镜像值取 ANS 回传的收窄结果）');
    const nameWriteAt = ipcText.search(/NODE_SETTING_KEYS\.name,\s*trimmedName/);
    const enrollCallAt = ipcText.search(/enrollWithToken\(settingDb/);
    ok(nameWriteAt >= 0 && enrollCallAt > nameWriteAt,
      'M8-2 ★★`nodes:enroll` 收 `name` 且**注册之前**先写本地 `node.name`（后续 `ensureNodeIdentity` 读它上送——'
      + '否则首注册仍带默认 hostname，"同机同名"照旧）', `writeName@${nameWriteAt} < enroll@${enrollCallAt}`);
    ok(/name:\s*readNodeSetting\(settingDb,\s*NODE_SETTING_KEYS\.name\)/.test(ipcText),
      'M8-3 `nodes:enroll-state` 回传本机 `name`（入职卡据此**预填**输入框——异步到达前用户已动手则不被覆盖）');

    // renderer 第二落点（词表必须穷举到界面，否则"后端齐了、用户够不着"）
    const RIPC = RD(`${A}/renderer/src/lib/ipc.ts`);
    ok(/NodeEnrollStatePayload[\s\S]{0,200}?name:\s*string/.test(RIPC),
      'M8-4a `NodeEnrollStatePayload` 增 `name`（新取值须过 IPC 边界——renderer 是词表的第二个落点）');
    const PEERS = RD(`${A}/renderer/src/pages/PeersPage.tsx`);
    ok(/<EnrollCard[^>]*initialName=/.test(PEERS) && /nodesApi\.enroll\(t,\s*name\.trim\(\)\s*\|\|\s*undefined\)/.test(PEERS),
      'M8-4b ★入职卡**就地取名**：`initialName` 透传 + `enroll(token,name)` 真把名字递下去（不是画个输入框摆设）');
    ok(/\.\.\.\(name\.trim\(\)\s*\?\s*\{\s*name:\s*name\.trim\(\)\s*\}\s*:\s*\{\}\)/.test(PEERS),
      'M8-5 ★改档口把 `name` 一并 PATCH（`nodes.update(node_id, patch)` 的 patch 真含 name——'
      + '否则 `NodePatch.name` 仍是个"在册却无人能写"的虚名）');
    eq((PEERS.match(/placeholder="节点名/g) ?? []).length, 2,
      'M8-6 ★名称输入框**恰两处**（入职卡 + 本机改档行）——同机两实例可亲手分辨');

    // ANS 侧契约（早存在，此处钉住防回归：改档真收 name、类型在册）
    ok(/name\?:\s*string/.test(RD('packages/shared-types/src/nodes.ts')),
      'M8-7a `NodePatch.name` 在册（客户端与 ANS 共用的类型契约）');
    ok(/if \(body\.name !== undefined\)\s*\{\s*sets\.push\('name = \?'/.test(RD(`${S}/src/routes/nodes.ts`)),
      'M8-7b ANS `PATCH /nodes/:nodeId` 真收 `name`（真源在 ANS——本地镜像才有"收窄后回传"可取）');

    // 产物（minify 后标识符搜不到，中文串可搜）——须先跑 renderer build。
    const m8Assets = path.join(root, `${A}/renderer/dist/assets`);
    const m8Chunks = fs.existsSync(m8Assets)
      ? fs.readdirSync(m8Assets).filter((f) => /^PeersPage-.*\.js$/.test(f)) : [];
    if (m8Chunks.length === 1) {
      const c = fs.readFileSync(path.join(m8Assets, m8Chunks[0]!), 'utf-8');
      ok(c.includes('节点名（同机多实例时用来分辨）'),
        'M8-8 ★产物含**取名输入框**的用户可见文案（半成品线补成可操作的门）');
    }
  }

  // ═══ M9｜「账上要记那件活」（E2E 期用户报出：台账行认不出派的是什么、摘要无所属）══════════════
  //   病形：两类事件（出站 `node.request_dispatched` / 入站 `node.request_received`）**都只记
  //   requestId/类目/目标**，**不记请求载荷** ⇒ 台账行只答"派过一单"，答不了"派的是什么"；
  //   且回传摘要（远端最后一条消息）**无所属**地裸挂一行，用户读作"看不懂"。
  //   治法：载荷随事件落库、随记录聚合；渲染层把"我派的"与"执行方回传"分标签并排。
  console.log('\n【M9】台账要记那件活（请求载荷入账 / 摘要有所属）');
  {
    // —— 行为①：出站到场事件**带载荷**（喂假 io+捕获 emit，断言真发出去的那份进了事件）——
    const { io } = fakeIo({ async submit() { return ansReq({ id: 'req-M9', target_node_id: 'n-other' }); } });
    const cap = captureEmit();
    await dispatchNodeRequest(asDb(enrolledDb()), { category: 'project_task', payload: { prompt: '用一句话介绍你自己' } }, { io, emit: cap.emit });
    eq(cap.calls[0]?.data.requestPayload, { prompt: '用一句话介绍你自己' },
      'M9-1 ★★行为：到场事件携 `requestPayload` = **真提交的那份**（不记载荷则台账认不出"派的是什么"）');

    // —— 行为②：出站聚合把它读进记录 ——
    const db = enrolledDb();
    const log = db as unknown as { prepare(s: string): { all(...a: unknown[]): unknown[] } };
    persistEmit(db, 'node.request_dispatched',
      { requestId: 'req-M9L', category: 'project_task', targetNodeId: 'n-other', requestPayload: { prompt: '写一首诗' } },
      '2026-10-11T00:00:00.000Z');
    const rec = listNodeDispatchRecords(log, 50).find((x) => x.requestId === 'req-M9L');
    eq(rec?.requestPayload, { prompt: '写一首诗' },
      'M9-2 ★★出站台账聚合 `requestPayload`（载荷真进了行——只写事件不读等于没记）');

    // —— 行为③：入站聚合同形（两侧同病同治，与 `node-call-log` 刻意对照的纪律一致）——
    const idb = new DatabaseSync(':memory:');
    idb.exec("CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL, event_type TEXT NOT NULL, payload TEXT DEFAULT '{}', occurred_at TEXT DEFAULT (datetime('now')))");
    idb.prepare("INSERT INTO wa_event_log (aggregate_type, aggregate_id, event_type, payload, occurred_at) VALUES ('node_request',?,?,?,?)")
      .run('req-M9I', 'node.request_received', JSON.stringify({ requestId: 'req-M9I', category: 'text', requesterKeyPrefix: 'wa_x', requestPayload: { prompt: '报个到' } }), '2026-10-11T00:00:00.000Z');
    const irecs = listNodeCallRecords(idb as unknown as Parameters<typeof listNodeCallRecords>[0], 50);
    eq(irecs[0]?.requestPayload, { prompt: '报个到' },
      'M9-3 ★入站台账同形聚合 `requestPayload`（两个方向各一本账，但同一份形状）');

    // —— 接线静态：入站 worker 的 `received` 事件**确带**载荷（此句是"事件携字段"的接线命题，
    //    其聚合行为已由 M9-3 行为断言覆盖；故此处按原文静态钉，不重复搭 worker 假件）——
    ok(/type: 'node\.request_received'[\s\S]{0,200}?requestPayload: req\.payload/.test(stripKeepingLines(RD(`${A}/src/main/core/node-request-worker.ts`)).join('\n')),
      'M9-4 ★入站 worker 的 `received` 事件携 `requestPayload: req.payload`（真机上＝ANS 回传的那份）');

    // —— renderer 第二落点：两标签 + 载荷摘要派生 ——
    const PEERS = RD(`${A}/renderer/src/pages/PeersPage.tsx`);
    ok(/function requestBrief\(/.test(PEERS) && /payload\.prompt === 'string'/.test(PEERS),
      'M9-5a ★`requestBrief` 由**同源键** `payload.prompt` 派生（接收侧建任务读的也是它——一处真源）');
    eq((PEERS.match(/派单内容|请求内容/g) ?? []).length, 2,
      'M9-5b ★★两个方向各一条"内容"标签（出站「派单内容」/入站「请求内容」）——由枚举数派生');
    eq((PEERS.match(/执行方回传|执行结果/g) ?? []).length, 2,
      'M9-5c ★★两个方向各一条"结果"标签（出站「执行方回传」/入站「执行结果」）——摘要**有了所属**，不再裸挂');

    const m9Assets = path.join(root, `${A}/renderer/dist/assets`);
    const m9Chunks = fs.existsSync(m9Assets)
      ? fs.readdirSync(m9Assets).filter((f) => /^PeersPage-.*\.js$/.test(f)) : [];
    if (m9Chunks.length === 1) {
      const c = fs.readFileSync(path.join(m9Assets, m9Chunks[0]!), 'utf-8');
      ok(c.includes('派单内容') && c.includes('执行方回传') && c.includes('请求内容'),
        'M9-6 ★产物含四个新标签的用户可见文案（台账行认得出"哪件活、谁的话"）');
    }
  }

  // ═══ M10｜回传要答得到（接线那一跳 · 标题 · 摘要）══════════════════════════════
  //   由来（E2E 用户目视**第二轮**，三处真缺陷）：
  //   ① B 端「AI 终端调用记录」**无「请求内容」**——不是构建过期（B 的 dist 含 M9、重启后事件仍缺），
  //      是 `main/index.ts` 的 `onEvent` **手抄白名单**把 M9 新加的 `requestPayload` 滤掉了
  //      （A 出站走 `(type,data)=>emit` 整体透传故正常；A 事件有载荷、B 事件无）。M9-4 只静态读 worker 源码，
  //      **照不出接线那一跳**——本批补一条**行为**断言（直跑真实现，非读源码）。
  //   ② 中转任务标题 `[中转 project_task] 7cd7496a`——requestId 对人无义（用户读作"无法友好的理解"）。
  //   ③ 回传摘要取**最后一条 assistant 消息**——是执行循环的英文旁白（"…Let me finalize."），答非所问；
  //      结论真源是 `context_json.completion_summary`（`finalize_task` 写，引擎内 ai-task/memory-write 同取）。
  console.log('\n【M10】回传要答得到（接线透传 / 标题取题 / 摘要取结论）');
  {
    // —— 行为①：接线真源**整体透传**（received 带载荷、completed 带 status/result 皆不得丢）——
    const recv = nodeRequestEventToLog({
      type: 'node.request_received', requestId: 'req-M10', category: 'project_task',
      requesterKeyPrefix: 'wa_x', requestPayload: { prompt: '用一句话介绍你自己' },
    });
    eq(recv.type, 'node.request_received', 'M10-1a ★接线真源：`type` 作**落库键**原样返回');
    eq((recv.data as { requestPayload?: unknown }).requestPayload, { prompt: '用一句话介绍你自己' },
      'M10-1b ★★行为：`received` 事件经接线真源后**仍携** `requestPayload`（白名单漏字段的病根在此被钉住）');
    ok((recv.data as { type?: unknown }).type === undefined,
      'M10-1c `type` **不进** data（否则事件键会混进载荷）');
    const doneEv = nodeRequestEventToLog({
      type: 'node.request_completed', requestId: 'req-M10', category: 'project_task',
      requesterKeyPrefix: 'wa_x', status: 'done', result: { taskStatus: 'completed' },
    });
    ok((doneEv.data as { status?: unknown }).status === 'done' && (doneEv.data as { result?: unknown }).result !== undefined,
      'M10-1d 整体透传（非"只补 requestPayload 一个字段"）：`status`/`result` 亦随行');

    // —— 静态接线：`main/index.ts` 的 onEvent **调**接线真源，且**不再**手抄白名单（防回退）——
    const MAIN = stripKeepingLines(RD(`${A}/src/main/index.ts`)).join('\n');
    ok(/onEvent:\s*\(e\)\s*=>\s*\{[\s\S]{0,400}?nodeRequestEventToLog\(e\)/.test(MAIN),
      'M10-1e ★静态接线：`onEvent` 真调 `nodeRequestEventToLog(e)`（接线那一跳按语句形状钉住）');
    ok(!/requesterKeyPrefix:\s*e\.requesterKeyPrefix/.test(MAIN),
      'M10-1f 反证：**旧手抄白名单已除**（`requesterKeyPrefix: e.requesterKeyPrefix` 不在场——留着即回退）');

    // —— 行为②：中转标题取**派来的那句话**（含无 prompt 兜底 / 超长截断）——
    eq(relayTaskTitle({ ...ansReq({}), category: 'project_task', payload: { prompt: '用一句话介绍你自己' } }),
      '[AI 终端] 用一句话介绍你自己',
      'M10-2a ★★行为：中转标题＝派来的那句（不再拿 `类目+requestId 前8位` 冒充）');
    eq(relayTaskTitle({ ...ansReq({}), category: 'media', payload: {} }), '[AI 终端·media]',
      'M10-2b 无 prompt 才退回 `[AI 终端·类目]`（不编一句摘要冒充"派来的是什么"）');
    const longTitle = relayTaskTitle({ ...ansReq({}), category: 'code', payload: { prompt: 'x'.repeat(60) } });
    ok(longTitle.startsWith('[AI 终端] ') && longTitle.endsWith('…') && longTitle.length === '[AI 终端] '.length + 41,
      'M10-2c 超长 prompt 有界截断（40 字 + 省略号）', String(longTitle.length));

    // —— 行为③：回传摘要取**结论**（同一 DB 里放一条"流水"末条消息做对照）——
    const odb = new DatabaseSync(':memory:');
    odb.exec("CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, context_json TEXT DEFAULT '{}')");
    odb.exec("CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT, content TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))");
    odb.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run('t-M10',
      JSON.stringify({ completion_summary: '已按任务要求完成自我介绍。产出文件现仅含一句中文…' }));
    odb.prepare('INSERT INTO wa_task_conversations (id, task_id, role, content, created_at) VALUES (?,?,?,?,?)')
      .run('c1', 't-M10', 'assistant', 'The file now contains exactly one Chinese sentence… Let me finalize.', '2026-10-11T00:00:05.000Z');
    eq(readOutcome(odb as unknown as Parameters<typeof readOutcome>[0], 't-M10').summary,
      '已按任务要求完成自我介绍。产出文件现仅含一句中文…',
      'M10-3a ★★行为：回传摘要取 `completion_summary`（结论），**不是**最后一条 assistant 消息（流水旁白）');

    // 缺失结论 ⇒ 才退回末条 assistant 消息（失败收口那条路不写 summary）。
    odb.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run('t-M10b', '{}');
    odb.prepare('INSERT INTO wa_task_conversations (id, task_id, role, content, created_at) VALUES (?,?,?,?,?)')
      .run('c2', 't-M10b', 'assistant', '兜底回话', '2026-10-11T00:00:06.000Z');
    eq(readOutcome(odb as unknown as Parameters<typeof readOutcome>[0], 't-M10b').summary, '兜底回话',
      'M10-3b 无结论时才退回末条回话（兜底仍在，不是把旧源删了了事）');

    // ★★ 行为③补（E2E 第三轮 `9e43726a` 照出）：本任务**改写了项目里既存文件**时——
    //   `write_file` 去重更新旧产出物（`deliverableId` 属**旧任务**）⇒ `wa_deliverables` 本任务名下**无行**
    //   （`finalize_checks` 记 `[WARN] 无产出物`）⇒ 回传曾退化成"完成自述"（描述文件/字节数），**答非所问**。
    //   真源在 `wa_deliverable_versions.changed_by`（**每个版本是谁写的**，`tools/write.ts` 写）。
    odb.exec("CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, task_id TEXT, file_path TEXT, name TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now')))");
    odb.exec("CREATE TABLE wa_deliverable_versions (id TEXT PRIMARY KEY, deliverable_id TEXT, file_path TEXT, content_snapshot TEXT, size INTEGER, version INTEGER, changed_by TEXT, created_at TEXT DEFAULT (datetime('now')))");
    const tmpd = fs.mkdtempSync(path.join('/tmp', 'rr-m10c-'));
    const answerPath = path.join(tmpd, 'self_introduction.md');
    const answerDoc = '我是工蚁（Worker Ant），一个能理解任务意图、自主拆解步骤并调用工具落地执行的 AI 任务执行助手。\n\n## 简介\n- 角色：AI 任务执行助手\n- 核心能力：理解→规划→执行→验证';
    fs.writeFileSync(answerPath, answerDoc, 'utf-8');
    odb.prepare('INSERT INTO wa_deliverables (id, task_id, file_path) VALUES (?,?,?)').run('deliv-other', 't-other', answerPath);
    odb.prepare('INSERT INTO wa_deliverable_versions (id, deliverable_id, file_path, content_snapshot, size, version, changed_by) VALUES (?,?,?,?,?,?,?)')
      .run('v-old', 'deliv-other', answerPath, '旧内容', 3, 1, 't-other');
    odb.prepare('INSERT INTO wa_deliverable_versions (id, deliverable_id, file_path, content_snapshot, size, version, changed_by) VALUES (?,?,?,?,?,?,?)')
      .run('v-new', 'deliv-other', answerPath, answerDoc, answerDoc.length, 2, 't-M10c');
    odb.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run('t-M10c',
      JSON.stringify({ completion_summary: '按任务要求以一句话介绍自己，并将答案整理为 self_introduction.md（659 字节）。文件已落盘并关联产出物记录…' }));
    eq(readOutcome(odb as unknown as Parameters<typeof readOutcome>[0], 't-M10c').summary, answerDoc,
      'M10-3c ★★行为：本任务**改写既存文件**（名下无产出物行）⇒ 回传取**本任务写出的版本**内容（`changed_by` 真源），不再退化成"完成自述"');

    // 反证：**别人写的**版本不得回传（否则等于泄漏同项目其他任务的成果）。
    odb.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run('t-M10d',
      JSON.stringify({ completion_summary: '本任务的结论自述' }));
    eq(readOutcome(odb as unknown as Parameters<typeof readOutcome>[0], 't-M10d').summary, '本任务的结论自述',
      'M10-3d 反证：只认**本任务写的**版本——别人写的产出物不回传（退回本任务结论自述）');

    // ═══ zx_20261011_1 M5：收口摘要"取哪份内容"**一处真源**（IM 通知 ⟷ relay 回传 同引）═══
    //   病根（`zx_20261011` §9.6）：IM 通知路（ai-task）原只按 `wa_deliverables.task_id` 选产出物、
    //   **不认 `changed_by`** ⇒ "改写既存件"的果在 IM 路丢失，与 relay 路**两把尺**。
    //   修法＝两路同引 `task-outcome.resolveTaskOutcome`；以下在**同一 changed_by 标本**上证"两路同结果"。
    const toDb = odb as unknown as TaskOutcomeDb;
    const produced = resolveTaskProducedFile(toDb, 't-M10c');
    ok(produced?.filePath === answerPath && produced?.content === answerDoc,
      'M5-1 ★★行为：本任务改写既存件（`wa_deliverables` 名下无行、`changed_by` 有）⇒ `resolveTaskProducedFile` 经 `changed_by` 取到该文件（真源一处）');
    ok(produced !== null && produced.content.length > PRODUCED_FILE_MIN_CHARS,
      'M5-2 产出物认取的字数下限**由常量自身派生**（> `PRODUCED_FILE_MIN_CHARS`，不手抄 50）', `下限=${PRODUCED_FILE_MIN_CHARS}`);
    const roM5 = resolveTaskOutcome(toDb, 't-M10c');
    ok(roM5?.source === 'file' && roM5.text === answerDoc,
      'M5-3 `resolveTaskOutcome` 先命中 `file` 源（该标本的 `completion_summary` 恰是"完成自述"——取它即答非所问）');
    ok(resolveTaskProducedFile(toDb, 't-M10d') === null && resolveTaskOutcome(toDb, 't-M10d')?.source === 'summary',
      'M5-4 反证：别人写的版本不回传 ⇒ 该任务**无产出物文件**、退结论自述（不泄漏同项目他任务成果）');
    // —— 两路同结果（relay 路 vs IM 路，同一标本）——
    eq(readOutcome(odb as unknown as Parameters<typeof readOutcome>[0], 't-M10c').summary, answerDoc,
      'M5-5a relay 路：改写既存件 ⇒ 取该文件内容');
    eq(completionNoticeFallback(toDb, 't-M10c', '执行体末次输出（不该被取）'), answerDoc,
      'M5-5b ★★ IM 路：同一标本取到**同一份**文件内容（同引一处真源——此前 IM 只按 `task_id` 选 ⇒ 两把尺）');
    eq(completionNoticeFallback(toDb, 't-M10d', '执行体末次输出'), '本任务的结论自述',
      'M5-5c IM 路反证：无本任务产出物 ⇒ 退 `completion_summary`（别人写的不取）');
    eq(completionNoticeFallback(toDb, 't-M10b', '执行体末次输出'), '执行体末次输出',
      'M5-5d IM 路末级兜底＝执行体末次输出（本路版面；与 relay 路"库内末条 assistant"不同——如实分列，不假装全同）');

    // —— 静态接线：一处真源 + **两路同引** + 反证两路旧内联取数皆已除 ——
    const TO = stripKeepingLines(RD(`${A}/src/main/core/task-outcome.ts`)).join('\n');
    ok(/export function resolveTaskProducedFile/.test(TO) && /export function resolveTaskOutcome/.test(TO) && /export function completionNoticeFallback/.test(TO),
      'M5-6 真源模块在册：`resolveTaskProducedFile` / `resolveTaskOutcome` / `completionNoticeFallback` 皆**具名导出**');
    ok(/changed_by\s*=\s*\?/.test(TO),
      'M5-7 真源含 `changed_by` 取数（改写既存件的真源——不是只按 `task_id`）');
    const RUNNER_M5 = stripKeepingLines(RD(`${A}/src/main/core/node-request-runner.ts`)).join('\n');
    ok(/from\s*'\.\/task-outcome\.js'/.test(RUNNER_M5) && /resolveTaskOutcome\(db,\s*taskId\)/.test(RUNNER_M5),
      'M5-8 ★静态接线：relay 回传路**引并调**共享真源 `resolveTaskOutcome`（不自带一份取数）');
    ok(!/FROM wa_deliverables WHERE task_id/.test(RUNNER_M5),
      'M5-9 反证：relay 路**旧内联取数已除**（`FROM wa_deliverables WHERE task_id` 不在场——留着即回退成两把尺）');
    const AI_M5 = stripKeepingLines(RD(`${A}/src/main/core/jobs/ai-task.ts`)).join('\n');
    ok(/from\s*'\.\.\/task-outcome\.js'/.test(AI_M5) && /completionNoticeFallback\(db,\s*taskId,\s*aiContent\)/.test(AI_M5),
      'M5-10 ★静态接线：IM 通知路**引并调**共享真源（`completionNoticeFallback` 由 `task-outcome` 提供，两路同引一处）');
    ok(!/SELECT file_path FROM wa_deliverables WHERE task_id = \?[^;]*ORDER BY created_at DESC LIMIT 1/.test(AI_M5),
      'M5-11 反证：IM 路**旧内联取数已除**（不再自带"只按 `task_id` 选产出物"的第二份实现——旧实现正是两把尺的来路）');

    // —— 静态：标题真源**只此一份**、且真被用（防"改了 A 处、B 处还是旧文案"）——
    const RUNNER = stripKeepingLines(RD(`${A}/src/main/core/node-request-runner.ts`)).join('\n');
    eq((RUNNER.match(/\[中转 /g) ?? []).length, 0,
      'M10-4a 旧标题前缀 `[中转 ` 已从 runner 清除（不留第二份标题文案）');
    ok(/title:\s*relayTaskTitle\(req\)/.test(RUNNER),
      'M10-4b runner 建任务**真用** `relayTaskTitle(req)`（真源接线，不是摆设）');

    // —— 行为④（三轮）：回传＝产出物**原文**（数据对外完整），但卡片是 3 行 `line-clamp`
    //    而正文以 markdown 标题开头 ⇒ 标题占满 3 行、答案被挤出。故**只在展示层**去壳取正文首段。
    const doc = '# 自我介绍\n\n## 一句话介绍\n\n我是工蚁（Worker Ant），一个能理解任务意图、自主拆解步骤并调用工具落地执行的 AI 任务执行助手。\n\n## 简介\n\n- **角色**：AI 任务执行助手';
    const SENT = '我是工蚁（Worker Ant），一个能理解任务意图、自主拆解步骤并调用工具落地执行的 AI 任务执行助手。';
    eq(briefFromText(doc), SENT,
      'M10-5a ★★行为：markdown 产出物 ⇒ 卡片摘要取**正文首段**（`#`/`##`/空行等结构壳已除，答案不再被挤出 3 行）');
    eq(briefFromText('已按任务要求完成自我介绍。产出文件 self_introduction.md 现仅含一句中文…'),
      '已按任务要求完成自我介绍。产出文件 self_introduction.md 现仅含一句中文…',
      'M10-5b 纯文本摘要**原样返回**（不误伤既有形态）');
    eq(briefFromText('# A\n## B'), '# A\n## B',
      'M10-5c 全篇皆结构（无正文）⇒ **退回原文**，不返回空');
    eq(resultBrief({ summary: doc }), SENT,
      'M10-5d `resultBrief` 对 summary **过壳**（不是直返原样）');
    const RB = stripKeepingLines(RD(`${A}/renderer/src/lib/result-brief.ts`)).join('\n');
    ok(/briefFromText\(result\.summary\)/.test(RB) && !/return\s+result\.summary\s*;/.test(RB),
      'M10-5e ★静态接线：`resultBrief` 真调 `briefFromText(result.summary)`（防"抽了函数没人叫"）+ 反证旧直返已除');
    const PEERS_RB = RD(`${A}/renderer/src/pages/PeersPage.tsx`);
    ok(/from\s+'\.\.\/lib\/result-brief'/.test(PEERS_RB) && !/function\s+resultBrief\s*\(/.test(PEERS_RB),
      'M10-5f PeersPage 改用共享真源（本地重复定义已除——一处真源）');
  }

  // ═══ M11｜不可交互任务（外部一次性请求，请求方无从应答 ⇒ 许人问、门禁亦不暂停）══════════
  console.log('\n【M11】不可交互任务：派来的活不许等（真源 core/no-interaction.ts）');
  {
    // —— 行为（纯函数，零依赖直跑）——
    ok(isNoInteraction(JSON.stringify({ [NO_INTERACTION_KEY]: true })),
      'M11-1 行为：显式 true ⇒ 判为不可交互');
    ok(!isNoInteraction(JSON.stringify({ [NO_INTERACTION_KEY]: false })) && !isNoInteraction('{}') && !isNoInteraction(null) && !isNoInteraction(undefined),
      'M11-2 反证：false / 空对象 / null / undefined ⇒ **不放行抑制**（只需确知才抑制，绝不误伤普通任务）');
    ok(!isNoInteraction('not-json{'),
      'M11-3 反证：JSON 不可解析 ⇒ 按**可交互**处理（读不到不抑制——安全方向）');
    const refusal = noInteractionAskRefusal(JSON.stringify({ [NO_INTERACTION_KEY]: true }));
    ok(refusal !== null && /cannot_ask/.test(refusal) && /无法应答/.test(refusal) && /自行|默认/.test(refusal),
      'M11-4 ★★行为：不可交互任务的 ask_user 拒绝回执＝`cannot_ask` + 明说"请求方无法应答、请自取默认"（交执行体自决，不假装成功）');
    ok(noInteractionAskRefusal('{}') === null && noInteractionAskRefusal(JSON.stringify({ [NO_INTERACTION_KEY]: false })) === null,
      'M11-5 反证：普通任务 ask_user **照常提问**（refusal 为 null，行为不变）');

    // —— 静态接线：一处真源 + 两个读点 + 写点（"做了没用上"的两个方向都钉死）——
    const NOI = stripKeepingLines(RD(`${A}/src/main/core/no-interaction.ts`)).join('\n');
    ok(/export const NO_INTERACTION_KEY\s*=\s*'no_interaction'/.test(NOI) && /export function isNoInteraction/.test(NOI) && /export function noInteractionAskRefusal/.test(NOI),
      'M11-6 真源模块在册：键名常量 + 判法 + 拒绝回执皆**具名导出**（一处真源）');
    const CTRL = stripKeepingLines(RD(`${A}/src/main/core/tools/control.ts`)).join('\n');
    ok(/import\s*\{\s*noInteractionAskRefusal\s*\}\s*from\s*'\.\.\/no-interaction\.js'/.test(CTRL) &&
       /noInteractionAskRefusal\(/.test(CTRL) &&
       CTRL.indexOf('noInteractionAskRefusal(') < CTRL.indexOf('pauseForDecision(args.header'),
      'M11-7 ★静态接线：`ask_user` **先**判可否问（调真源）、**再**调 `pauseForDecision`（次序即判据；防"抽了函数没人叫"）');
    const CLAIM = stripKeepingLines(RD(`${A}/src/main/core/exec-claim.ts`)).join('\n');
    ok(/import\s*\{\s*isNoInteraction\s*\}\s*from\s*'\.\/no-interaction\.js'/.test(CLAIM) && /if\s*\(\s*isNoInteraction\(gateJson\)\s*\)\s*return null;/.test(CLAIM),
      'M11-8 ★静态接线：执行前门禁读**同一真源**判法并放行（不暂停）——同语义两读点不手抄');
    const RUNNER_N = stripKeepingLines(RD(`${A}/src/main/core/node-request-runner.ts`)).join('\n');
    ok(/import\s*\{\s*NO_INTERACTION_KEY\s*\}\s*from\s*'\.\/no-interaction\.js'/.test(RUNNER_N) &&
       /\[NO_INTERACTION_KEY\]:\s*true/.test(RUNNER_N),
      'M11-9 ★静态接线：中继层**写点**用同一常量落 `no_interaction`（键名三处一处真源，非同名字面量各写各的）');
  }

  // ═══ S｜哑雷自检 + build 钉（派生核对，不写轮次字面量）══════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 ★方向性自指（由载体自身派生，非抄来的常量）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言**抛异常**时若只挂 `finally`，`process.exit` 会在 Node 报告 unhandled
//   rejection **之前**把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行 ✅ 假绿。
main().then(() => {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261011: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\n💥 rr_zx_20261011 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
  console.log(`\n❌ rr_zx_20261011: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
