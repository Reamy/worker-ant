/**
 * zx_20261108_1 B5「诚」受控回归 —— GUI 交互诚实 + 预算闸名实相符
 * （维特根斯坦·意义即使用 / 老子·信言不美 / 毛选·实事求是）。
 *
 * 钉住五件事（零网络 / 零 electron / 零墙钟）：
 *   A 动作失败可见：四个页面里凡 try 体内有**写动作**的，catch 必须把失败说给用户
 *     （`fb.fail`/`reportAction`/`setXxxMsg`/`setErr`/`messageOf`），不许静默；
 *     空 catch 只准留在**只读**路径（六处，逐一按 try 体认领，写动作一律不得空 catch）；
 *     对话框保存失败就地显示（Provider/Model/Endpoint 三个 `{err && …}`）；
 *   B 三态归一：`parseTriState` 收齐三种开/三种关写法，其余如实 `unknown`；
 *     设置页「严格备用」读回走同一把尺；
 *   C 预算闸真触发：`policy.budget_tokens` 覆盖真读；执行中累计 token 达阈值 ⇒ 暂停动作；
 *     未达 ⇒ 不触发（两侧标本）；end-to-end 调用 `pauseTask` 落 paused/因/告知意图账；
 *   D 名实接线：成本条件只在**执行循环**（累计之后、真实 totalTokensUsed）评估一处；
 *     执行前只评失败率条件（不再以 0 token 评成本）；`engine.policy_check` 关 ⇒ 不评估；
 *     设置页文案不再自称「只用不拦」；
 *   E 构建钉 + renderer 产物含本批用户可见文案。
 *
 * 纪律：文案不含失败字形；轮次由载体自身派生；判据读注释剥离后的代码。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildNotOlderThan, checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';
import { DEFAULT_POLICIES, evaluateBudgetPolicies, evaluateFailurePolicies, type Policy } from '../apps/worker-ant-desktop/src/main/core/policy-engine.js';
import { loadPolicies } from '../apps/worker-ant-desktop/src/main/core/policy-config.js';
import { pauseTask } from '../apps/worker-ant-desktop/src/main/core/pause-task.js';
import { PAUSE_REASON_POLICY_PAUSED } from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
import { parseTriState } from '../apps/worker-ant-desktop/src/main/core/settings-bool.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const ROOT = path.join(__dirname, '..');
const PAGES = path.join(ROOT, 'apps/worker-ant-desktop/renderer/src/pages');
const DIST = path.join(ROOT, 'apps/worker-ant-desktop/renderer/dist');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

const CODE = (abs: string): string => stripKeepingLines(fs.readFileSync(abs, 'utf-8')).join('\n');

// ── 通用扫描：每个 catch（关键字，非 `.catch(` 回调）连同它的 try 体 ──────────
interface CatchSite { tryBody: string; body: string; after: string }
function catchesOf(code: string): CatchSite[] {
  const out: CatchSite[] = [];
  const re = /(?<!\.)catch\s*(?:\([^)]*\))?\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(code))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < code.length; i++) {
      const c = code[i];
      if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
    const body = code.slice(m.index + m[0].length, i);
    let j = m.index - 1;
    while (j >= 0 && /\s/.test(code[j]!)) j--;
    let tryBody = '';
    if (code[j] === '}') {
      let d2 = 0;
      let k = j;
      for (; k >= 0; k--) {
        const c = code[k];
        if (c === '}') d2++;
        else if (c === '{') { d2--; if (d2 === 0) break; }
      }
      tryBody = code.slice(k + 1, j);
    }
    out.push({ tryBody, body, after: code.slice(i, i + 80) });
  }
  return out;
}

/** 「会改变世界」的调用（写动作）——命中即该 catch 必须出声。 */
// `dispatchResult` 是**读**（远端进度轮询），故动词表不收 `dispatch`——按符号认，不按同形前缀。
const MUTATION = /ansProxy\.(?:post|put|delete|patch)\(|invoke(?:<[^>\n]*>)?\([^;\n]*'[\w.-]+:(?:set|del|delete|update|create|add|remove|toggle|save|start|stop|bind|unbind|import|reset|clear|activate|enable|disable)'|\.(?:create|update|remove|delete|set[A-Z]\w*|save|add|attach|pause|resume|activate|revoke|upload|install|uninstall|import|clear|reset|start|stop|enable|disable)\w*\(/;
/** 用户可见的失败反馈。 */
const VISIBLE = /fb\.fail|reportAction|reportLoad|setErr\(|setError\(|set[A-Z]\w*Msg\(|messageOf|setCloudMsg|setLicMsg|setPwMsg|setSampleMsg|setUpdateMsg/;
/** 只读路径空 catch 的认领表（写动作的 try 一律不得空 catch）。 */
const READ_MARKERS: Array<{ name: string; test: (s: CatchSite) => boolean }> = [
  { name: '设置页-许可状态读', test: (s) => s.tryBody.includes('licenseApi.status()') },
  { name: '设置页-挂载读(保持空态)', test: (s) => /^\}\s*finally\s*\{\s*setAnsLoaded\(true\)/.test(s.after.trimStart()) },
  { name: '模型页-推荐清单读(可选)', test: (s) => s.tryBody.includes("getRaw<RecEnvelope>('/api/v1/models/recommended')") },
  { name: '模型页-默认模型读(可选)', test: (s) => s.tryBody.includes("invoke<string | null>('settings:get', 'model.default_model')") },
  { name: '项目详情-头部刷新读', test: (s) => s.tryBody.includes('projects.get(id)') && s.tryBody.includes('setLastUpdated(Date.now())') },
  { name: '任务详情-远端进度轮询读', test: (s) => s.tryBody.includes('nodes.dispatchResult(selfRemote.requestId)') },
];

function sectionA(): void {
  console.log('\n【A】动作失败可见：写动作的 catch 必须出声，空 catch 只准在只读路径');
  const files = ['SettingsPage.tsx', 'ModelsPage.tsx', 'ProjectDetailPage.tsx', 'TaskDetailPage.tsx'];
  const silentActions: string[] = [];
  const unknownEmpty: string[] = [];
  const emptyHit: string[] = [];

  for (const f of files) {
    const code = CODE(path.join(PAGES, f));
    eq((code.match(/\balert\(/g) ?? []).length, 0, `A-alert ${f} 不用 alert（失败就地显示）`);
    for (const site of catchesOf(code)) {
      const body = site.body.trim();
      const mutating = MUTATION.test(site.tryBody);
      if (body === '') {
        const marker = READ_MARKERS.find((r) => r.test(site));
        if (!marker) unknownEmpty.push(`${f}: ${site.tryBody.replace(/\s+/g, ' ').slice(0, 70)}`);
        else if (mutating) emptyHit.push(`${f}/${marker.name}`);
      } else if (mutating && !VISIBLE.test(body)) {
        silentActions.push(`${f}: ${site.tryBody.replace(/\s+/g, ' ').slice(0, 70)}`);
      }
    }
  }
  eq(silentActions, [], 'A1 写动作的 catch 全部把失败说给用户（静默即红）');
  eq(unknownEmpty, [], 'A2 空 catch 只在六处只读路径（新增空 catch 须先在此认领）');
  eq(emptyHit, [], 'A3 反证：认领的空 catch 其 try 体内不含写动作');

  const R = (f: string) => CODE(path.join(PAGES, f));
  for (const f of ['SettingsPage.tsx', 'ModelsPage.tsx', 'ProjectDetailPage.tsx']) {
    ok(R(f).includes("from '../lib/action-feedback';") && R(f).includes('<ActionFeedback note={fb.note}'),
      `A4 ${f} 挂上统一反馈条（同一份 ActionFeedback）`);
  }
  const td = R('TaskDetailPage.tsx');
  ok(td.includes('const reportAction = (e: unknown)') && td.includes('const reportLoad = (what: string, e: unknown)')
    && /\{actionMsg && \(/.test(td),
    'A5 任务详情动作/读失败经 `reportAction`/`reportLoad` 上屏');

  const mp = R('ModelsPage.tsx');
  eq((mp.match(/\{err && <p/g) ?? []).length, 3,
    'A6 三个对话框（供应商/模型/端点）保存失败就地显示');
  ok(mp.includes("setErr('请提供 API Key')"),
    'A7 缺 Key 不再 alert，留对话框内说清');
}

function sectionB(): void {
  console.log('\n【B】三态归一：同一把 parseTriState');
  eq(['true', '1', 'on', ' TRUE ', 'On'].map((v) => parseTriState(v)),
    ['true', 'true', 'true', 'true', 'true'], 'B1 三种历史「开」写法全收（大小写/空白同归）');
  eq(['false', '0', 'off', ' FALSE '].map((v) => parseTriState(v)),
    ['false', 'false', 'false', 'false'], 'B2 三种历史「关」写法全收');
  eq([undefined, null, '', 'yes', '2'].map((v) => parseTriState(v as string | null | undefined)),
    ['unknown', 'unknown', 'unknown', 'unknown', 'unknown'], 'B3 其余如实 unknown（不替调用方猜缺省）');

  const sp = CODE(path.join(PAGES, 'SettingsPage.tsx'));
  ok(sp.includes("import { parseTriState } from '../../../src/main/core/settings-bool.js';"),
    'B4 设置页跨 root 引 main 唯一判据（不手抄第二份）');
  ok(sp.includes("setStrictFallback(parseTriState(all['engine.capability_strict_fallback']) === 'true')"),
    'B5 「严格备用」读回走同一把尺（缺省关键不再被当成开）');
}

// ── C：预算闸真触发（真 `evaluateBudgetPolicies` + 真 `pauseTask`）──────────
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
CREATE TABLE wa_im_channels (id TEXT PRIMARY KEY, channel_type TEXT DEFAULT '', status TEXT);
CREATE TABLE wa_im_conversations (id TEXT PRIMARY KEY, channel_id TEXT, external_user_id TEXT,
  message_json TEXT, direction TEXT, created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_im_notify_log (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', task_id TEXT DEFAULT '',
  kind TEXT NOT NULL, suppressed INTEGER DEFAULT 0, outcome TEXT DEFAULT '', detail TEXT DEFAULT '',
  at INTEGER NOT NULL);
`;
type AnyDb = import('better-sqlite3').Database;
const mkdb = (): AnyDb => {
  const d = new DatabaseSync(':memory:');
  d.exec(SCHEMA);
  d.prepare("INSERT INTO wa_im_channels (id, channel_type, status) VALUES ('c1', 'wechat', 'active')").run();
  d.prepare("INSERT INTO wa_im_conversations (id, channel_id, external_user_id, message_json, direction) VALUES ('cv1', 'c1', 'u1', '{}', 'inbound')").run();
  return d as unknown as AnyDb;
};
const addTask = (db: AnyDb, id: string, status = 'executing'): void => {
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES (?, 'p', ?, ?, '{}')").run(id, id, status);
};
const notifyRows = (db: AnyDb) =>
  db.prepare('SELECT kind, outcome FROM wa_im_notify_log ORDER BY at, rowid').all() as Array<{ kind: string; outcome: string }>;
const statusOf = (db: AnyDb, id: string): string =>
  (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;
const ctxOf = (db: AnyDb, id: string): Record<string, unknown> =>
  JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json || '{}');

function budgetOf(policies: Policy[]): Policy {
  return policies.find((p) => p.name === 'budget_hard_limit')!;
}

function sectionC(): void {
  console.log('\n【C】预算闸真触发：真实累计 token 达上限 ⇒ 暂停');
  const db = mkdb();
  const derived = budgetOf(DEFAULT_POLICIES).conditions[0]!.threshold;
  eq(budgetOf(loadPolicies(db)).conditions[0]!.threshold, derived,
    'C1 未改设置时阈值由内置缺省派生（不写第二份数字）');

  db.prepare("INSERT OR REPLACE INTO wa_settings (key, value) VALUES ('policy.budget_tokens', '100')").run();
  eq(budgetOf(loadPolicies(db)).conditions[0]!.threshold, 100,
    'C2 设置页写的 `policy.budget_tokens` 被真读（0→100 正面断言）');

  const policies = loadPolicies(db);
  eq(evaluateBudgetPolicies({ taskTokens: 99 }, policies).actions, [],
    'C3a 未达上限不触发（反面标本）');
  const hit = evaluateBudgetPolicies({ taskTokens: 100 }, policies);
  ok(hit.triggered && hit.actions.some((a) => a.type === 'pause_task'),
    'C3b 达到上限触发暂停（侧面标本）', JSON.stringify(hit.actions));

  const costPolicies: Policy[] = [{
    name: 'cost_cap',
    conditions: [{ type: 'cost', threshold: 1, metric: 'usd' }],
    actions: [{ type: 'notify_admin', message: '费用超限' }],
  }];
  eq(evaluateBudgetPolicies({ taskCost: 0.999 }, costPolicies).actions, [], 'C4a 费用口径未达不触发');
  ok(evaluateBudgetPolicies({ taskCost: 1 }, costPolicies).actions.length === 1, 'C4b 费用口径达阈触发');

  const failOnly: Policy[] = [{
    name: 'fail_only',
    conditions: [{ type: 'error_rate', threshold: 1, window: 10 }],
    actions: [{ type: 'pause_task', message: '失败过多' }],
  }];
  eq(evaluateBudgetPolicies({ taskTokens: 9_999_999 }, failOnly).actions, [],
    'C5a 预算路不评失败率条件（各答各的问）');
  eq(evaluateFailurePolicies({ projectRecentFailures: () => 0 }, failOnly).actions, [],
    'C5b 失败率路未达不触发（反面标本）');
  ok(evaluateFailurePolicies({ projectRecentFailures: () => 1 }, failOnly).actions.length === 1,
    'C5c 失败率路达阈触发');
  eq(evaluateFailurePolicies({ projectRecentFailures: () => 9_999 }, costPolicies).actions, [],
    'C5d 失败率路不评成本条件（反之亦然）');

  // end-to-end：真正把任务落成 paused，并留下告知意图账（0→1）
  addTask(db, 't1');
  const before = notifyRows(db).length;
  const msg = hit.actions[0]!.message;
  const res = pauseTask(db, { taskId: 't1', reason: PAUSE_REASON_POLICY_PAUSED, note: msg });
  ok(res.changed, 'C6a pauseTask 真写入（changed=true）');
  eq(statusOf(db, 't1'), 'paused', 'C6b 任务状态落为 paused');
  eq(ctxOf(db, 't1').pause_reason, PAUSE_REASON_POLICY_PAUSED, 'C6c 暂停因落 `policy_paused`');
  const after = notifyRows(db);
  ok(after.length === before + 1 && after.some((r) => r.kind === 'pause_needed'),
    'C6d 策略暂停留下一条暂停告知意图账（0→1 正面）', JSON.stringify(after));

  addTask(db, 't2', 'completed');
  eq(pauseTask(db, { taskId: 't2', reason: PAUSE_REASON_POLICY_PAUSED, note: msg }),
    { changed: false, skipped: 'terminal' }, 'C7 终态不被暂停覆写（唯一写口的闸仍在）');
}

function sectionD(): void {
  console.log('\n【D】名实接线：成本条件只在执行循环（累计之后）评估');
  const step = CODE(path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/exec-step.ts'));
  const sel = CODE(path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/exec-model-select.ts'));

  const iAcc = step.indexOf('d.totalTokensUsed += stepTokens');
  const iEval = step.indexOf('evaluateBudgetPolicies(');
  ok(iAcc >= 0 && iEval >= 0 && iAcc < iEval,
    'D1 预算评估在累计之后（拿到的是含本步的真实累计）', `${iAcc} < ${iEval}`);
  ok(step.includes('{ taskTokens: d.totalTokensUsed, taskCost: d.totalCostUsed }'),
    'D2 传入真实累计两项（不再是 `taskTokens: 0`）');
  ok(/readBoolSetting\(d\.db, 'engine\.policy_check'\)/.test(step),
    'D3 `engine.policy_check` 关 ⇒ 不评估（一键回退）');
  eq((step.match(/evaluateBudgetPolicies\(/g) ?? []).length, 1,
    'D4 成本条件只在执行循环一处评估（无第二落点）');
  ok(step.includes('pauseTask(d.db, { taskId: d.taskId, reason: PAUSE_REASON_POLICY_PAUSED')
    && step.includes('d.controller.abort('),
    'D5 触发后走唯一暂停写口并中止在途 run');
  ok(step.includes('void pushImNotify(d.db, d.taskId, line, \'admin_notify\')'),
    'D6 通知类动作经统一 IM 出口（不静默）');

  ok(sel.includes('evaluateFailurePolicies(') && !sel.includes('evaluateBudgetPolicies('),
    'D7 执行前只评失败率条件（不再以 0 token 评成本）');
  ok(!sel.includes('evaluatePolicies('),
    'D8 反证：执行前无 `evaluatePolicies` 混评（成本条件不会在度量未产生处被判）');

  const sp = CODE(path.join(PAGES, 'SettingsPage.tsx'));
  ok(sp.includes('执行中逐拍累计评估') && sp.includes('达到上限即暂停任务并告知'),
    'D9 设置页文案如实说「执行中评估、达上限即暂停」');
  ok(!/budget_tokens[\s\S]{0,160}仅记录/.test(sp),
    'D10 反证：文案不再自称「只用不拦」');
}

function sectionE(): void {
  console.log('\n【E】构建钉 + renderer 产物');
  const { tag } = deriveBuildTag(fs.readFileSync(
    path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/agent-executor.ts'), 'utf-8'));
  ok(buildNotOlderThan(tag, SELF_ROUND), 'E1 build 标识不早于脚本轮次（方向性派生）', `${tag} vs ${SELF_ROUND}`);
  checkBuildPins(ok, { rootDir: ROOT });

  if (fs.existsSync(DIST)) {
    const blob = fs.readdirSync(DIST, { recursive: true })
      .map((f) => String(f)).filter((f) => f.endsWith('.js'))
      .map((f) => fs.readFileSync(path.join(DIST, f), 'utf-8')).join('\n');
    ok(blob.includes('执行中逐拍累计评估'), 'E2 renderer 产物含预算闸如实文案');
    ok(blob.includes('请提供 API Key'), 'E3 renderer 产物含对话框就地错误文案');
  } else {
    ok(false, 'E2 renderer 产物缺失（须先跑 renderer build）', DIST);
  }
}

sectionA();
sectionB();
sectionC();
sectionD();
sectionE();

console.log(`\n[rr_${SELF_ROUND}_gui] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
