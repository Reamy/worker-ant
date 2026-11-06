/**
 * zx_20261106_1「迹」受控回归 —— 通知必留迹、通知说真话、判据不空转、父回传真值。
 *
 * A 通知意图账：无目标 skipped / 意图→sent 同行回填 / 失败 error + 补发账 / 记账失败回 null /
 *   聚并窗口不被 skipped·error 占用（两只标本 + 正反两向）。
 * B 静态接线：通知/发送/补发账全静态引用；无 `import('./core/im/im-notify.js')`；
 *   `activeAdapters` 全仓仅注册表一处；通知路径无空 catch；im.ipc 只留薄委托。
 * C 通知真值：未达目标（premature / goal_achieved=false）不说「已完成」「主要成果」；
 *   正常完成原句逐字不变；failed 状态词仍由 DB 出；坏 JSON 不误报。
 * D 子任务判据：父判据进/不进提示词；补写只补空条、不覆写；派生两路都能判；
 *   `acceptance_source` 三条落库路径均可读；空判据仍有账可查。
 * E 父回传：未达目标子任务行如实；普通子任务五段逐字不变；缺判据写「未设判据」；派生判据带「派生·」。
 * F 日志：通知模块无 `console.*`，异常走 `createLogger`，日志不含正文。
 * G GUI 接线：`im:notifyLogList` 注册 + 页面调用 + 词表覆盖；完成卡「未达目标」条件；判据来源徽标。
 * H 静态钉：`checkBuildPins`、本轮标识、哑雷专项零命中、文案无失败字形。
 *
 * 纪律：零网络 / 零 electron；夹具按生产列形自建 DDL；计数器带 0→1 正面断言；
 *   断言文案不含失败/通过字形；不写"只为下一轮"的字面量（build 值由源码派生）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  NOTIFY_OUTCOMES,
  IM_FAIL_AGG_WINDOW_MS,
  recordNotifyIntent,
  finishNotifyIntent,
} from '../apps/worker-ant-desktop/src/main/core/im/im-notify-log.js';
import { pushImNotify } from '../apps/worker-ant-desktop/src/main/core/im/im-notify.js';
import { setActiveImAdapter, clearActiveImAdapters } from '../apps/worker-ant-desktop/src/main/core/im/im-adapter-registry.js';
import { completionTruthOf, buildTaskNotice } from '../apps/worker-ant-desktop/src/main/core/task-notice.js';
import {
  buildDecomposePrompt,
  buildAcceptanceRepairPrompt,
  mergeRepairedAcceptance,
  deriveAcceptanceFallback,
  withAcceptanceSource,
  acceptanceSourcesNotice,
  decomposeTask,
  planSubtasksFromTemplate,
} from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';
import { buildChildBriefs } from '../apps/worker-ant-desktop/src/main/core/jobs/ai-task.js';
import { ROUND_RE, checkBuildPins, deriveBuildTag, listStrayPinLiterals, stripKeepingLines } from './lib/rr-pins.js';

const ROOT = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const SCRIPTS = path.join(ROOT, 'scripts');
const SELF_ROUND = path.basename(__filename, '.ts').replace(/^rr_/, '');
const SRC_BUILD = deriveBuildTag(fs.readFileSync(path.join(ROOT, `${A}/src/main/core/agent-executor.ts`), 'utf-8')).tag;
/** 轮次序号（`zx_YYYYMMDD[_n]` → 可比较数值）；后续轮次推进 build 不应弄红套件。 */
const roundOrd = (tag: string): number => {
  const m = /^zx_(\d{8})(?:_(\d+))?$/.exec(tag);
  return m ? Number(m[1]) * 1000 + Number(m[2] ?? 1) : -1;
};

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);
const rd = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/* ═══ 夹具 ═══════════════════════════════════════════════════════════════ */
/** 生产列形（database.ts）：意图账含 outcome/detail；其余表只建本套件用到的列。 */
const SCHEMA = `
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', title TEXT DEFAULT '', description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
  source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT DEFAULT '', status TEXT DEFAULT 'active');
CREATE TABLE wa_im_notify_log (
  id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', task_id TEXT DEFAULT '', kind TEXT NOT NULL,
  suppressed INTEGER DEFAULT 0, outcome TEXT DEFAULT '', detail TEXT DEFAULT '', at INTEGER NOT NULL
);
CREATE TABLE wa_im_outbox (
  id TEXT PRIMARY KEY, channel_id TEXT DEFAULT '', external_user_id TEXT DEFAULT '', task_id TEXT DEFAULT '',
  kind TEXT DEFAULT '', message TEXT DEFAULT '', attempts INTEGER DEFAULT 0, status TEXT DEFAULT 'pending',
  next_retry_at INTEGER, last_error TEXT, last_attempt_at TEXT, created_at TEXT DEFAULT (datetime('now')),
  media_path TEXT, media_kind TEXT
);
CREATE TABLE wa_im_conversations (
  id TEXT PRIMARY KEY, channel_id TEXT DEFAULT '', external_user_id TEXT DEFAULT '', message_json TEXT DEFAULT '',
  direction TEXT DEFAULT '', status TEXT DEFAULT '', last_error TEXT DEFAULT '', outbox_id TEXT,
  chat_type TEXT, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_deliverables (
  id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', task_id TEXT DEFAULT '', type TEXT NOT NULL, name TEXT DEFAULT '',
  description TEXT DEFAULT '', file_path TEXT, registry_id TEXT, status TEXT DEFAULT 'draft', is_primary INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_task_conversations (
  id TEXT PRIMARY KEY, task_id TEXT DEFAULT '', role TEXT NOT NULL, content TEXT DEFAULT '',
  tool_calls TEXT, token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_deliverable_versions (id TEXT PRIMARY KEY, deliverable_id TEXT, version INTEGER);
`;
const mkdb = (): DatabaseSync => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d; };
function addTask(
  d: DatabaseSync,
  id: string,
  status = 'pending',
  ctx: Record<string, unknown> = {},
  parent = '',
  criteria = '',
): void {
  d.prepare('INSERT INTO wa_tasks (id, project_id, title, description, status, context_json, parent_task_id, acceptance_criteria) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'p1', id, id, status, JSON.stringify(ctx), parent, criteria);
}
const notifyRows = (d: DatabaseSync) =>
  d.prepare('SELECT * FROM wa_im_notify_log ORDER BY at ASC').all() as Array<Record<string, unknown>>;
const outboxRows = (d: DatabaseSync) => d.prepare('SELECT * FROM wa_im_outbox').all() as Array<Record<string, unknown>>;
const fakeAdapter = (behaviour: 'ok' | 'throw') => ({
  sendReply: async () => { if (behaviour === 'throw') throw new Error('模拟发送失败：网络断开'); },
}) as never;

/* ═══ A 通知意图账 ═══════════════════════════════════════════════════════ */
async function sectionA(): Promise<void> {
  console.log('\n【A】通知意图账：留迹、回填、记因、不占窗');
  {
    const d = mkdb();
    const r = recordNotifyIntent(d as never, { projectId: 'p1', taskId: 't1', kind: 'notification' });
    const rows = notifyRows(d);
    ok(r.id !== null && rows.length === 1 && rows[0]!.outcome === 'intent' && rows[0]!.suppressed === 0,
      'A1 登记即落一行 outcome=intent（不是只发不记）', JSON.stringify(rows[0]));
    finishNotifyIntent(d as never, r.id, 'sent', 'targets=1');
    const after = notifyRows(d);
    ok(after.length === 1 && after[0]!.outcome === 'sent' && after[0]!.detail === 'targets=1',
      'A2 结果回填同一行（意图→结果，不另起二账）', JSON.stringify(after[0]));
  }
  {
    // 无目标：pushImNotify 必须留下 skipped 且写明哪条渠道没解析到。
    const d = mkdb();
    addTask(d, 't1', 'completed', {});
    await pushImNotify(d as never, 't1', '任务完成', 'notification');
    const rows = notifyRows(d);
    ok(rows.length === 1 && rows[0]!.outcome === 'skipped' && String(rows[0]!.detail).startsWith('no_target:channel='),
      'A3 无目标可投 ⇒ skipped 行 + 指明渠道（2026-11-05 三账同零的病根）', JSON.stringify(rows));
    ok(outboxRows(d).length === 0, 'A4 没打算发 ≠ 没送达：不落补发账');
  }
  {
    // 成功发送：sent 且不落 outbox。
    const d = mkdb();
    d.exec("INSERT INTO wa_im_channels (id, channel_type, status) VALUES ('ch1','wechat','active')");
    addTask(d, 't1', 'completed', { channel: 'wechat', externalUser: 'u1' });
    setActiveImAdapter('ch1', fakeAdapter('ok'));
    await pushImNotify(d as never, 't1', '任务完成', 'notification');
    clearActiveImAdapters();
    const rows = notifyRows(d);
    ok(rows.length === 1 && rows[0]!.outcome === 'sent' && rows[0]!.detail === 'targets=1',
      'A5 送达 ⇒ sent + targets=1（同一行回填）', JSON.stringify(rows));
    ok(outboxRows(d).length === 0, 'A6 送达不进补发账（成功不落账）');
  }
  {
    // 失败发送：error + 补发账 pending，原因带进两本账。
    const d = mkdb();
    d.exec("INSERT INTO wa_im_channels (id, channel_type, status) VALUES ('ch1','wechat','active')");
    addTask(d, 't1', 'completed', { channel: 'wechat', externalUser: 'u1' });
    setActiveImAdapter('ch1', fakeAdapter('throw'));
    await pushImNotify(d as never, 't1', '任务完成', 'notification');
    clearActiveImAdapters();
    const rows = notifyRows(d);
    const ob = outboxRows(d);
    ok(rows.length === 1 && rows[0]!.outcome === 'error' && String(rows[0]!.detail).includes('模拟发送失败'),
      'A7 失败 ⇒ error + 真原因（不写「未送达」三个字了事）', JSON.stringify(rows));
    ok(ob.length === 1 && ob[0]!.status === 'pending' && ob[0]!.kind === 'notification',
      'A8 失败同时落补发账 pending（0→1 正面断言）', JSON.stringify(ob));
  }
  {
    // 记账失败不吞通知：prepare 即抛 ⇒ 返回 null，不抛。
    const broken = { prepare() { throw new Error('表不存在'); } } as never;
    const r = recordNotifyIntent(broken, { taskId: 't1', kind: 'notification' });
    ok(r.suppressed === false && r.id === null, 'A9 记账不可用 ⇒ {suppressed:false,id:null}（不阻断发送、不抛）');
  }
  {
    // 旧库形状（无 outcome/detail）：降级写旧形状，仍留一行。
    const old = new DatabaseSync(':memory:');
    old.exec(`CREATE TABLE wa_im_notify_log (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', task_id TEXT DEFAULT '',
      kind TEXT NOT NULL, suppressed INTEGER DEFAULT 0, at INTEGER NOT NULL);`);
    const r = recordNotifyIntent(old as never, { taskId: 't1', kind: 'notification' });
    const got = old.prepare('SELECT suppressed, at FROM wa_im_notify_log').all() as Array<Record<string, unknown>>;
    ok(r.id !== null && got.length === 1 && got[0]!.suppressed === 0, 'A10 缺列旧库降级写旧形状（缺列不丢通知）', JSON.stringify(got));
    finishNotifyIntent(old as never, r.id, 'sent');
    ok((old.prepare('SELECT COUNT(*) AS n FROM wa_im_notify_log').get() as { n: number }).n === 1,
      'A11 旧库回填不新增行（只是 UPDATE 打空，不抛）');
  }
  {
    // 聚并窗口：skipped / error 不占用（两只标本），真发才占用（正反两向）。
    //   ⚠ 每只标本各用一个**独立项目**：本判据按 (project_id, kind) 聚并，同一项目里前一只标本
    //   自己写的 intent 行也会成为窗口基线——混在一起量到的是互相干扰，不是被测语义。
    const d = mkdb();
    const t0 = 1_800_000_000_000;
    recordNotifyIntent(d as never, { projectId: 'pA', taskId: 't1', kind: 'task_failed', outcome: 'skipped', now: t0 });
    const nextSkipped = recordNotifyIntent(d as never, { projectId: 'pA', taskId: 't2', kind: 'task_failed', now: t0 + 60_000 });
    ok(nextSkipped.suppressed === false, 'A12 标本一：skipped 不占窗（下次仍可发）');
    recordNotifyIntent(d as never, { projectId: 'pB', taskId: 't3', kind: 'task_failed', outcome: 'error', now: t0 });
    const nextError = recordNotifyIntent(d as never, { projectId: 'pB', taskId: 't4', kind: 'task_failed', now: t0 + 60_000 });
    ok(nextError.suppressed === false, 'A13 标本二：error 不占窗（没发出去不等于发过）');
    recordNotifyIntent(d as never, { projectId: 'pC', taskId: 't5', kind: 'task_failed', outcome: 'sent', now: t0 });
    const nextReal = recordNotifyIntent(d as never, { projectId: 'pC', taskId: 't6', kind: 'task_failed', now: t0 + IM_FAIL_AGG_WINDOW_MS - 1 });
    ok(nextReal.suppressed === true, 'A14 反证：真发过的同类在窗内被聚并（判据不是永远 false）');
    const afterWindow = recordNotifyIntent(d as never, { projectId: 'pC', taskId: 't7', kind: 'task_failed', now: t0 + IM_FAIL_AGG_WINDOW_MS });
    ok(afterWindow.suppressed === false, 'A15 窗满即放行（边界不吞）');
  }
}

/* ═══ B 静态接线 ═════════════════════════════════════════════════════════ */
function sectionB(): void {
  console.log('\n【B】静态接线：不再有可被 tsup clean 删掉的动态 chunk');
  const idx = rd(`${A}/src/main/index.ts`);
  const mnf = rd(`${A}/src/main/core/im/im-notify.ts`);
  const iip = rd(`${A}/src/main/ipc/im.ipc.ts`);
  const reg = rd(`${A}/src/main/core/im/im-adapter-registry.ts`);
  ok(idx.includes("import { pushImOwnerNotice, pushImNotify, pushPrimaryDeliverables } from './core/im/im-notify.js'")
    && idx.includes("import { sendImText } from './core/im/im-send.js'")
    && idx.includes("import { enqueueImOutbox, outboxStats, retryImOutbox } from './core/im/im-outbox.js'"),
    'B1 index 静态引入通知/发送/补发账三处');
  ok(!idx.includes("import('./core/im/im-notify.js')") && !idx.includes("import('./core/im/im-outbox.js')")
    && !idx.includes("import('./ipc/im.ipc.js')"),
    'B2 index 无通知/补发/ipc 动态 import（旧 chunk 名失效这一跳从结构上消失）');
  ok(!mnf.includes("import('../../ipc/im.ipc.js')") && !mnf.includes("import('../ipc/im.ipc.js')"),
    'B3 core/im 不反向依赖 ipc/im.ipc（无 electron 依赖）');
  ok(mnf.includes("import { sendImText, sendImMedia } from './im-send.js'")
    && mnf.includes("import { enqueueImOutbox } from './im-outbox.js'"),
    'B4 发送/落账均为静态导入');
  const mapDecls = [...rd(`${A}/src/main/ipc/im.ipc.ts`).matchAll(/new Map<string,\s*ImAdapter>\(\)/g)].length
    + [...reg.matchAll(/new Map<string,\s*ImAdapter>\(\)/g)].length;
  ok(mapDecls === 1 && reg.includes('const activeAdapters'), 'B5 适配器表全仓仅注册表一处（不另建第二张表）', `实测 ${mapDecls} 处`);
  ok(/ipcMain\.handle\('im:send'[\s\S]{0,260}?adapters: \{ get: getActiveImAdapter \}/.test(iip),
    'B6 im:send 与通知路共用同一取口 getActiveImAdapter');
  for (const [file, src] of [
    ['im-notify.ts', mnf],
    ['im-notify-log.ts', rd(`${A}/src/main/core/im/im-notify-log.ts`)],
    ['im-send.ts', rd(`${A}/src/main/core/im/im-send.ts`)],
  ] as const) {
    // 去掉注释再判：注释里复述"旧实现是裸 catch {}"不算真代码。
    ok(!/catch\s*\{\s*\}/.test(stripKeepingLines(src).join('\n')), `B7 ${file} 无空 catch 块（失败要么回结果、要么入日志）`);
  }
  ok(iip.includes('return sendImText(channelId, toUser, taskId, message);')
    && iip.includes("export { sendImMessage, sendImMedia } from '../core/im/im-send.js';"),
    'B8 im.ipc 仅保留同名薄委托（实现真源在 core/im/im-send）');
}

/* ═══ C 通知真值 ═════════════════════════════════════════════════════════ */
function sectionC(): void {
  console.log('\n【C】通知说真话：未达目标不背书');
  {
    eq(completionTruthOf(JSON.stringify({ completion_quality: { goal_achieved: false, premature: true, goal_evidence: 'acceptance_failed' } })),
      { premature: true, goalAchieved: false, evidence: 'acceptance_failed', via: null },
      'C1 完成账四键如实读出');
    eq(completionTruthOf('{"goal_achieved":true}'), { premature: false, goalAchieved: true, evidence: null, via: null },
      'C2 顶层 goal_achieved 兜底（与 finalize-by-human 同取法）');
    eq(completionTruthOf('不是 JSON').goalAchieved, null, 'C3 坏 JSON ⇒ 未知（不猜）');
    eq(completionTruthOf('[]').goalAchieved, null, 'C4 非对象 ⇒ 未知');
  }
  {
    const d = mkdb();
    addTask(d, 't1', 'completed', { completion_quality: { premature: true, goal_achieved: false, goal_evidence: 'acceptance_failed' } });
    const n = buildTaskNotice(d as never, 't1', 'completed', { detail: '产出了报告草稿' });
    ok(n.level === 'warn' && n.title === '任务未达目标：t1', 'C5 d628e8e1 形态 ⇒ warn + 标题「任务未达目标」', n.title);
    ok(!n.message.includes('已完成') && !n.message.includes('主要成果'), 'C6 未达目标不出现「已完成」「主要成果」', n.message);
    ok(n.message.includes('未达成目标') && n.message.includes('被迫结束') && n.message.includes('验收未通过'),
      'C7 说清为什么未达（被迫收尾/验收未通过）', n.message);
    ok(n.message.includes('本轮产出（未达目标）'), 'C8 产出不冒充「主要成果」', n.message);
  }
  {
    const d = mkdb();
    addTask(d, 't2', 'completed', { completion_quality: { goal_achieved: false, goal_evidence: 'acceptance_failed' } });
    const n = buildTaskNotice(d as never, 't2', 'completed');
    ok(n.level === 'warn' && n.title === '任务未达目标：t2' && n.message.includes('验收未通过') && !n.message.includes('被迫结束'),
      'C9 未被迫收尾但目标未达 ⇒ 同样不背书（只报验收未通过）', n.message);
  }
  {
    const d = mkdb();
    addTask(d, 't3', 'completed', { completion_quality: { goal_achieved: true } });
    const n = buildTaskNotice(d as never, 't3', 'completed');
    ok(n.level === 'ok' && n.title === '任务已完成：t3' && n.message.includes('任务「t3」已完成。'),
      'C10 正常完成原句逐字不变', n.message);
  }
  {
    const d = mkdb();
    addTask(d, 't4', 'failed', {});
    const n = buildTaskNotice(d as never, 't4', 'completed');
    ok(n.level === 'fail' && n.status === 'failed' && n.message.includes('失败'),
      'C11 状态词仍由 DB 出（调用方说 completed、账上 failed ⇒ 输出失败）', n.message);
  }
  {
    const d = mkdb();
    addTask(d, 't5', 'completed', { completion_quality: '{坏' });
    const n = buildTaskNotice(d as never, 't5', 'completed');
    ok(n.level === 'ok' && n.title === '任务已完成：t5', 'C12 坏完成账 ⇒ 走正常分支（不误报未达）', n.title);
  }
  ok(rd(`${A}/src/main/core/jobs/ai-task.ts`).includes("...(unmet ? { title: '本轮产出' } : {})"),
    'C13 完成摘要块未达目标时标题改「本轮产出」（im-reply 一处真源）');
}

/* ═══ D 子任务判据 ═══════════════════════════════════════════════════════ */
async function sectionD(): Promise<void> {
  console.log('\n【D】子任务判据：不空转、有来源');
  const base = buildDecomposePrompt('做一个报告');
  ok(!base.includes('父任务已设定的验收标准') && base === buildDecomposePrompt('做一个报告', undefined, undefined, ''),
    'D1 无父判据 ⇒ 提示词逐字不变（空串不加段）');
  ok(buildDecomposePrompt('做一个报告', undefined, undefined, '含三条可机检项').includes('父任务已设定的验收标准')
    && buildDecomposePrompt('做一个报告', undefined, undefined, '含三条可机检项').includes('含三条可机检项'),
    'D2 有父判据 ⇒ 追加一段（子判据须支撑它）');
  const repairPrompt = buildAcceptanceRepairPrompt([{ title: '写初稿', description: '产出 md' }]);
  ok(repairPrompt.includes('写初稿') && repairPrompt.includes('做什么 + 怎么核') && repairPrompt.includes('只返回JSON数组'),
    'D3 补写提示词：点名缺失条目 + 可判定要求');

  const templates = [
    { title: 'A', description: 'a', acceptance_criteria: '已写好的判据' },
    { title: 'B', description: 'b', acceptance_criteria: '   ' },
  ];
  const merged = mergeRepairedAcceptance(templates, '[{"title":"A","acceptance_criteria":"被篡改"},{"title":"B","acceptance_criteria":"B 的判据"}]');
  eq(merged[0]!.acceptance_criteria, '已写好的判据', 'D4 补写不覆写已有判据（改动模型产物即篡改）');
  ok(merged[1]!.acceptance_criteria === 'B 的判据' && merged[1]!.acceptance_source === 'model_repaired',
    'D5 空条按 title 精确补齐并标 model_repaired', String(merged[1]!.acceptance_source));
  eq(mergeRepairedAcceptance(templates, '没有 JSON').map((t) => t.acceptance_criteria), ['已写好的判据', '   '],
    'D6 坏回话 ⇒ 模板原样返回（不猜）');
  eq(mergeRepairedAcceptance(templates, '[{"title":"不存在","acceptance_criteria":"x"}]')[1]!.acceptance_criteria, '   ',
    'D7 标题对不上 ⇒ 不硬塞');

  const dp = deriveAcceptanceFallback({ title: 'B', description: 'b' }, '父任务要能跑通');
  ok(dp.source === 'derived_parent' && dp.text.includes('核对方式') && dp.text.includes('父任务要能跑通')
    && dp.text.includes('可回读'),
    'D8 有父判据 ⇒ derived_parent，且写明核对方式与父判据', dp.text);
  const dg = deriveAcceptanceFallback({ title: 'B', description: '写一份清单' }, '   ');
  ok(dg.source === 'derived_generic' && dg.text.includes('核对方式') && dg.text.includes('写一份清单'),
    'D9 无父判据 ⇒ derived_generic（两路都写死核对方式）', dg.text);
  ok(!/完成即可|已实现/.test(dp.text + dg.text), 'D10 派生判据不退化成空话');

  eq(withAcceptanceSource({ a: 1 }, 'model'), { a: 1, acceptance_source: 'model' }, 'D11 来源并入上下文');
  eq(withAcceptanceSource({ a: 1 }, undefined), { a: 1 }, 'D12 无来源不落键（不编）');

  eq(acceptanceSourcesNotice(0, 0), '', 'D13 派生/缺失都为零 ⇒ 整句不出现');
  ok(acceptanceSourcesNotice(2, 1).includes('2 条判据为派生') && acceptanceSourcesNotice(2, 1).includes('1 条未设判据'),
    'D14 有派生/缺失 ⇒ 如实报数', acceptanceSourcesNotice(2, 1));

  {
    // decomposeTask：模型首答缺一条 ⇒ 补写；补写失败 ⇒ 派生。
    const modelReply = JSON.stringify([
      { title: '准备', description: '准备环境', acceptance_criteria: 'npm i 成功退出码 0', purpose: '备料' },
      { title: '产出', description: '写报告', purpose: '交付' },
    ]);
    const prompts: string[] = [];
    const deps = (repairOk: boolean) => ({
      resolveModel: async () => ({ url: 'http://stub', api_key: 'k' }),
      chat: async (_ep: unknown, prompt: string) => {
        prompts.push(prompt);
        if (prompt.includes('缺少验收标准')) {
          return repairOk
            ? { ok: true as const, text: '[{"title":"产出","acceptance_criteria":"报告落盘且含三节"}]' }
            : { ok: false as const, detail: '补写超时' };
        }
        return { ok: true as const, text: modelReply };
      },
    });
    const repaired = await decomposeTask('做一件事', { deps: deps(true) });
    eq(repaired.map((t) => t.acceptance_source), ['model', 'model_repaired'], 'D15 首答全的标 model、补写的标 model_repaired');
    ok(prompts.some((p) => p.includes('只补写') || p.includes('缺少验收标准')), 'D16 确实发起了补写（不是假标）');
    const derived = await decomposeTask('做一件事', { deps: deps(false), parentAcceptance: '父判据在此' });
    eq(derived.map((t) => t.acceptance_source), ['model', 'derived_parent'], 'D17 补写失败 ⇒ 派生并如实标来源');
    ok(derived[1]!.acceptance_criteria.includes('父判据在此'), 'D18 派生确实用了父判据');
    const generic = await decomposeTask('做一件事', { deps: deps(false) });
    eq(generic.map((t) => t.acceptance_source), ['model', 'derived_generic'], 'D19 无父判据 ⇒ 自动派生');
  }
  {
    // 落库：acceptance_source 写进 context_json；空判据不冒充有判据。
    const d = mkdb();
    addTask(d, 'P', 'executing');
    const r = planSubtasksFromTemplate(d as never, {
      parentTaskId: 'P', projectId: 'p1', depth: 0, source: 'test',
      template: [
        { title: '甲', description: 'a', acceptance_criteria: '甲的判据', purpose: 'x', acceptance_source: 'model' },
        { title: '乙', description: 'b', acceptance_criteria: '', purpose: 'y', acceptance_source: 'missing' },
        { title: '丙', description: 'c', acceptance_criteria: '丙判据', purpose: 'z' },
      ],
    });
    ok(r.created === 3, 'D20 三条子任务建出');
    const rows = d.prepare('SELECT id, title, acceptance_criteria, context_json FROM wa_tasks WHERE parent_task_id = ?').all('P') as Array<Record<string, string>>;
    // 按标题取名取，不依赖 SQLite 对中文的排序（那与本判据无关，混进来只会让断言随排序变红）。
    const byTitle = new Map(rows.map((x) => [x.title, x]));
    eq(['甲', '乙', '丙'].map((t) => JSON.parse(byTitle.get(t)!.context_json).acceptance_source), ['model', 'missing', undefined],
      'D21 来源随行落库；缺省不落键（GUI/模板路不编来源）');
    ok(byTitle.get('甲')!.acceptance_criteria === '甲的判据' && byTitle.get('乙')!.acceptance_criteria === '',
      'D22 空判据仍是空（未设判据 ≠ 已通过）');
  }
}

/* ═══ E 父回传 ═══════════════════════════════════════════════════════════ */
function sectionE(): void {
  console.log('\n【E】父回传真值：完成≠做成');
  const d = mkdb();
  addTask(d, 'P', 'executing');
  addTask(d, 'c1', 'completed', { completion_quality: { premature: true, goal_achieved: false }, acceptance_check: { verified: false, total: 0, passed: 0 } }, 'P');
  addTask(d, 'c2', 'completed', { completion_summary: '普通子任务完成', acceptance_check: { verified: true, total: 2, passed: 2 } }, 'P');
  addTask(d, 'c3', 'completed', { acceptance_source: 'missing', completion_summary: '无判据子' }, 'P');
  // `checked_at` 是 `isAcceptanceVerified` 的硬前提（无核验时刻 = 没核过），夹具须按生产形状给。
  addTask(d, 'c4', 'completed', { acceptance_source: 'derived_generic', acceptance_check: { checked_at: 1_800_000_000_000, verified: true, criteria_total: 1, passed_total: 1 } }, 'P');
  const briefs = buildChildBriefs(d as never, 'P');
  const b1 = briefs.find((b) => b.startsWith('c1｜')) || '';
  const b2 = briefs.find((b) => b.startsWith('c2｜')) || '';
  const b3 = briefs.find((b) => b.startsWith('c3｜')) || '';
  const b4 = briefs.find((b) => b.startsWith('c4｜')) || '';
  ok(b1.includes('完成·未达目标（被迫收尾）'), 'E1 未达目标子任务如实回传（不只说「完成」）', b1);
  ok(b2.split('｜').length === 5 && b2.includes('｜完成｜'), 'E2 普通子任务保持五段形状（逐字不变）', b2);
  ok(b3.includes('未设判据'), 'E3 缺判据写「未设判据」（不混进「未验收」）', b3);
  ok(b4.includes('派生·'), 'E4 派生判据带「派生·」前缀（父任务看得出判据来源）', b4);
}

/* ═══ F 日志 ═════════════════════════════════════════════════════════════ */
function sectionF(): void {
  console.log('\n【F】日志：不静默，也不泄正文');
  for (const rel of [
    `${A}/src/main/core/im/im-notify.ts`,
    `${A}/src/main/core/im/im-notify-log.ts`,
    `${A}/src/main/core/im/im-send.ts`,
    `${A}/src/main/core/im/im-outbox.ts`,
  ]) {
    const src = rd(rel);
    ok(!/console\.(log|warn|error|info)\(/.test(src), `F1 ${path.basename(rel)} 无 console.*（按天日志才留得下）`);
    // im-send 是**不抛**的发送原语：它把原因回给调用方（调用方负责入日志），自身不另记一份；
    // 其余三处是通知路径的终点/记账点，异常必须落到按天日志。
    ok(path.basename(rel) === 'im-send.ts'
      ? src.includes("createLogger(") === false && src.includes('return { ok: false, error:')
      : src.includes("createLogger('"),
      `F2 ${path.basename(rel)} 失败有去处（入日志或回给调用方）`);
  }
  const mnf = rd(`${A}/src/main/core/im/im-notify.ts`);
  ok(/log\.warn\(\{ taskId: shortId\(taskId\), kind, outcome: 'skipped'/.test(mnf),
    'F3 无目标跳过入日志（带 taskId/kind/outcome）');
  ok(/log\.error\(\{ taskId: shortId\(taskId\), kind, outcome: 'error', error: why \}/.test(mnf),
    'F4 通知异常入日志（带真因）');
  ok(!/log\.(warn|error|info)\([^)]*\bmessage\b/.test(mnf.split('pushImNotify')[0]!),
    'F5 日志字段不含通知正文（message 这个变量名不进日志载荷）');
  ok(/log\.error\(\{ taskId: shortId\(taskId\), kind, outcome, error:/.test(rd(`${A}/src/main/core/im/im-notify-log.ts`)),
    'F6 意图记账失败入日志（私人语言→公共账）');
}

/* ═══ G GUI 接线 ═════════════════════════════════════════════════════════ */
function sectionG(): void {
  console.log('\n【G】GUI 接线：账读得到、真值上得屏');
  const iip = rd(`${A}/src/main/ipc/im.ipc.ts`);
  const page = rd(`${A}/renderer/src/pages/IMPage.tsx`);
  const detail = rd(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  const pipc = rd(`${A}/src/main/ipc/project.ipc.ts`);
  ok(iip.includes("ipcMain.handle('im:notifyLogList'") && iip.includes('new Date(r.at).toISOString()'),
    'G1 im:notifyLogList 注册且 at 在边界转 ISO');
  ok(/t\.title AS task_title[\s\S]{0,200}?LEFT JOIN wa_tasks t ON t\.id = l\.task_id/.test(iip),
    'G2 左连任务表取标题（缺则渲染层回落短 id）');
  ok(page.includes("invoke('im:notifyLogList'"), 'G3 IM 页调用名与 IPC 注册名一致');
  const labelKeys = [...page.matchAll(/NOTIFY_OUTCOME_LABEL: Record<string,string> = \{([^}]*)\}/g)][0]?.[1] ?? '';
  const covered = NOTIFY_OUTCOMES.every((o) => labelKeys.includes(`${o}:`));
  ok(covered, 'G4 结果词表覆盖 NOTIFY_OUTCOMES 全部取值（未知值原样回显，不编）', labelKeys.replace(/\s+/g, ' ').slice(0, 80));
  ok(page.includes('没有通知意图记录。') && page.includes('窗口内聚并'), 'G5 空态如实 + 聚并徽标与结果并列');
  ok(detail.includes('收口报告（未达目标）') && detail.includes("completionQuality.premature === true || completionQuality.goal_achieved === false"),
    'G6 完成卡：未达目标条件 → 标题切换');
  ok(detail.includes('ACCEPTANCE_SOURCE_LABEL') && detail.includes('自动派生，未经人工确认'),
    'G7 子任务验收块显示判据来源并标注派生');
  ok(pipc.includes("json_extract(t.context_json, '$.acceptance_source') AS acceptance_source"),
    'G8 tasks:children 将判据来源投影出边界（渲染层不解析 context_json）');
  ok(page.includes('NOTIFY_KIND_LABEL') && page.includes('NOTIFY_LOG_PAGE = 50'),
    'G9 通知类型词表独立于补发账（两张表的键不是同一组）');
  // 空结果 ≠ 意图待回填：迁移前老行没有结果列，结果永不会回填（生产实测 146/146 行为空）。
  ok(page.includes('旧账（未记结果）') && /r\.outcome \|\| 'legacy'/.test(page) && !/r\.outcome \|\| 'intent'/.test(page),
    'G10 迁移前老行如实标「旧账（未记结果）」，不冒充「意图（尚未回填结果）」');
  // 凭据句不得与账上结论相反（生产标本 d628e8e1：goal_achieved=false 却印「达成」）。
  {
    const evBlock = detail.slice(detail.indexOf("ev === 'score_only'"), detail.indexOf("ev === 'none'"));
    ok(evBlock.includes('goal_achieved === false') && evBlock.includes('未达成（仅按质量分推断，未验收）'),
      'G11 凭据句随账上结论翻面（不出现「未达目标 + 达成凭据」自相矛盾）');
  }
}

/* ═══ H 静态钉 ═══════════════════════════════════════════════════════════ */
function sectionH(): void {
  console.log('\n【H】静态钉：构建标识与全量纪律');
  checkBuildPins(ok, { distDir: path.join(ROOT, `${A}/dist`) });
  ok(ROUND_RE.test(SELF_ROUND), 'H-1 本轮标识由载体自身派生且格式合法', SELF_ROUND);
  ok(fs.existsSync(path.join(ROOT, `plans/improve/${SELF_ROUND}.md`)), `H-2 方案在册：plans/improve/${SELF_ROUND}.md`);
  // 方向性比较（不是 `===`）：开新轮推进 build 时本钉仍成立，永不成为只对下一轮引爆的哑雷。
  eq(roundOrd(SRC_BUILD) >= roundOrd(SELF_ROUND), true,
    'H-3 源码 build 不早于本套件轮次（开新轮只改源码一处）', SRC_BUILD);
  eq(listStrayPinLiterals(SCRIPTS, ['rr_zx_20260909_fixes.ts'], ROOT), [],
    'H-4 除历史负钉外无轮次字面量（开新轮只改源码一处）');
  // 哑雷专项：任何脚本的代码行不得同时含 tag 标识符与轮次字面量。
  const ROUND_LIT = /['"`](zx_\d{8}(?:_\d+)?)['"`]/;
  const offenders: string[] = [];
  const files = fs.readdirSync(SCRIPTS).filter((f) => f.startsWith('rr_') && f.endsWith('.ts')).sort();
  for (const name of files) {
    stripKeepingLines(fs.readFileSync(path.join(SCRIPTS, name), 'utf-8')).forEach((line, i) => {
      if (/\btag\b/.test(line) && ROUND_LIT.test(line)) offenders.push(`${name}:${i + 1}`);
    });
  }
  eq(offenders, [], `H-5 哑雷专项零命中（扫描面 ${files.length} 个脚本）`);
  // 反证：同一判据喂旧形状必须命中。标本运行时拼出，本文件自身才不会被 H-5 判成哑雷。
  const legacyRound = ['zx', '20200101'].join('_');
  const landmineHit = (() => {
    const lines = stripKeepingLines(`  eq(tag, '${legacyRound}', '旧形');\n`);
    return lines.some((l) => /\btag\b/.test(l) && ROUND_LIT.test(l));
  })();
  ok(landmineHit, 'H-6 反证：旧形喂进同一判据必命中（扫描面不是空的）');
  // 本套件与新改源码文案不含失败/通过字形（全量汇总器按日志字形计数）。
  // 判据自身也用码点拼，避免自指命中。
  const GLYPHS = new RegExp('[' + String.fromCharCode(0x2717) + String.fromCharCode(0x2713) + ']');
  const self = rd('scripts/rr_zx_20261106_1.ts');
  ok(!GLYPHS.test(self), 'H-7 本套件断言文案不含失败/通过字形');
}

async function main(): Promise<void> {
  console.log(`rr_${SELF_ROUND} 受控回归（迹：通知必留迹，通知说真话）`);
  await sectionA();
  sectionB();
  sectionC();
  await sectionD();
  sectionE();
  sectionF();
  sectionG();
  sectionH();
  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
}

void main()
  .then(() => process.exit(fail === 0 ? 0 : 1))
  .catch((e: unknown) => {
    console.error(`rr_${SELF_ROUND} 未捕获异常（复跑未跑完，不得读作通过）：`, e);
    console.log(`\nFAIL rr_${SELF_ROUND}: ${pass} 通过 / ${fail + 1} 失败\n`);
    process.exit(1);
  });
