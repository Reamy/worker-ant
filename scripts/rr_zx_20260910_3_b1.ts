/**
 * zx_20260910_3 批2 受控复跑（真实现 + node:sqlite 真 SQL；绝不触碰开发库）。
 *
 * 本轮问题 G1「验收的『没跑』与『通过』同名」：
 *   `checkAcceptanceCriteria` 用**同一个 `null`** 承载四种互斥结局——无模型／LLM 未吐 JSON／核对异常／**真通过**，
 *   且落库只在"真通过"那一支。调用方无从分辨，一律记 `[PASS] 验收标准已核对达成`
 *   ⇒ 真库（2026-09-10 实测）132 任务 / 10 个带验收标准：`acceptance_check` 写入数 **0**、
 *     `acceptance_verified=1` **0**，却有 3 条"验收达成"的痕（名与实脱钩）。
 *   ⇒ 且下游各读点只认 `acceptance_check.checked_at`，一旦 M1a 把"没核验"也落账，
 *     它们会把"没核验"认成"已验收"——把冒名 PASS 换成一批冒名 ✓（头重脚轻）。
 *
 * S1 M1a 四出口各落一账：`decideAcceptanceOutcome` → `recordAcceptanceOutcome`（真实现）对真库执行，
 *    逐出口断言 ctxJson.acceptance_check 的存在、verified 取值与 reason；
 *    并断言"未核验"与"真通过"两种载荷**形状可区分**（这正是本轮要拆的东西）。
 * S2 M1b 载荷精度：逐条 criterion/passed/reason 保留与 trim/缺省兜底（旧 zx_20260906_2 语义不回归）。
 * S3 M1c 下游护栏：`isAcceptanceVerified` 唯一判据 + `markDocAcceptanceVerified`（真调生产函数）
 *    + `backfillDocAcceptanceVerified`（真调生产函数）+ `describeAcceptance`（IM 徽标）四处，verified=false 一律不认。
 * S4 接线静态：调用方落账**无条件**（不在任何 if 内）· `[WARN]` 文案存在 · 验收配方加闸 · 三读点接线同判据
 *    · TaskDetail 面板显示"未核验"（覆测试触达不到的巨型 handler / renderer，同 zx_20260909_1_b3 手法）。
 * S5 M1b JSON 提取修复（批3）：6 种真实模型输出的**复现对照表**（旧贪婪法失败集 ⊆ 新法通过集）+
 *    配平不误闭合（串内 `]`／转义）+ 尾逗号容错 + 条目定型（`"passed":"false"` 不再被计通过）
 *    + 全败如实 `no_json`（不冒名）+ 超时静态断言。
 *
 * ⚠ G5/G6（收敛计数器三义归一 / 恢复必自愈）断言属 M2c/M2d＝批4b，届时在同文件追加 S6/S7。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  decideAcceptanceOutcome, recordAcceptanceOutcome, buildAcceptanceCheckPayload,
  buildUnverifiedCheckPayload, isAcceptanceVerified, parseAcceptanceChecks,
} from '../apps/worker-ant-desktop/src/main/core/acceptance-check.js';
import { markDocAcceptanceVerified, backfillDocAcceptanceVerified } from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
import { describeAcceptance } from '../apps/worker-ant-desktop/src/main/core/im-reply.js';
import { engineSrc } from './lib/rr-engine-src.js';
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p?: string) => any };

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const exe = engineSrc();
const pip = rd('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
const acc = rd('apps/worker-ant-desktop/src/main/core/acceptance-check.ts');
const dlc = rd('apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.ts');
const tdp = rd('apps/worker-ant-desktop/renderer/src/pages/TaskDetailPage.tsx');

/** 建一个带 wa_tasks/wa_deliverables/wa_settings 的内存库（列与生产 schema 一致的必要子集） */
function mkdb(): any {
  const db = new DatabaseSync(':memory:') as any;
  db.exec(`
    CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, status TEXT DEFAULT 'executing', context_json TEXT DEFAULT '{}');
    CREATE TABLE wa_deliverables (
      id TEXT PRIMARY KEY, task_id TEXT, name TEXT, type TEXT, status TEXT DEFAULT 'draft',
      file_path TEXT, acceptance_verified INTEGER DEFAULT 0, updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);
  `);
  return db;
}
const addTask = (db: any, id: string, ctx: Record<string, unknown> = {}) =>
  db.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run(id, JSON.stringify(ctx));
const addDoc = (db: any, id: string, taskId: string, name: string, filePath: string, verified = 0) =>
  db.prepare("INSERT INTO wa_deliverables (id, task_id, name, type, status, file_path, acceptance_verified) VALUES (?, ?, ?, 'doc', 'completed', ?, ?)")
    .run(id, taskId, name, filePath, verified);
const acOf = (db: any, taskId: string) =>
  JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(taskId) as { context_json: string })?.context_json || '{}').acceptance_check;

/** 模拟生产调用序列：取数 → 决策 → 落账（与 checkAcceptanceCriteria 尾段同构，但跑的是真实现函数） */
function runExit(db: any, taskId: string, kind: 'ok' | 'no_model' | 'exception', text: string | null) {
  const decided = decideAcceptanceOutcome({ kind, text });
  const payload = recordAcceptanceOutcome(db, taskId, decided);
  const block = decided.outcome.ran && !decided.outcome.passed ? decided.outcome.block : null;
  return { decided, payload, block };
}

// ─────────────────────────────────────────────────────────────
console.log('S1 M1a 四出口各落一账（真实现 + 真 SQL）');

{
  const db = mkdb();
  addTask(db, 't-no-model'); addTask(db, 't-no-json'); addTask(db, 't-error'); addTask(db, 't-pass'); addTask(db, 't-fail');

  const rNoModel = runExit(db, 't-no-model', 'no_model', null);
  const rNoJson = runExit(db, 't-no-json', 'ok', '我检查了两项，看起来都没问题。'); // 模型有话但无 JSON 数组
  const rError = runExit(db, 't-error', 'exception', null);
  const rPass = runExit(db, 't-pass', 'ok', '[{"criterion":"A可用","passed":true},{"criterion":"B已测","passed":true}]');
  const rFail = runExit(db, 't-fail', 'ok', '[{"criterion":"A可用","passed":true},{"criterion":"C有文档","passed":false,"reason":"缺 .md"}]');

  // 出口①②③④⑤：全部落账（修复前①②③④都不会写库）
  const rows = ['t-no-model', 't-no-json', 't-error', 't-pass', 't-fail'].map((t) => acOf(db, t));
  ok(rows.every((r) => r && typeof r === 'object'), '五个出口**全部**落账 acceptance_check（此前恒 0）', rows.map((r) => r?.verified === undefined ? '无' : String(r.verified)).join(','));

  // 结局判定
  ok(rNoModel.decided.outcome.ran === false && rNoModel.decided.outcome.reason === 'no_model', '出口①无模型 → ran=false/reason=no_model');
  ok(rNoJson.decided.outcome.ran === false && rNoJson.decided.outcome.reason === 'no_json', '出口②未吐 JSON → ran=false/reason=no_json');
  ok(rError.decided.outcome.ran === false && rError.decided.outcome.reason === 'error', '出口③异常 → ran=false/reason=error');
  ok(rPass.decided.outcome.ran === true && rPass.decided.outcome.passed === true, '出口④真通过 → ran=true/passed=true');
  ok(rFail.decided.outcome.ran === true && rFail.decided.outcome.passed === false, '出口⑤真拒收 → ran=true/passed=false');

  // 载荷形状可区分：这是"没跑"与"通过"不再同名的落地形态
  ok(acOf(db, 't-no-model').verified === false && acOf(db, 't-no-model').reason === 'no_model', '未核验载荷 verified=false + reason 记成因');
  ok(acOf(db, 't-error').verified === false && acOf(db, 't-error').reason === 'error' && acOf(db, 't-error').criteria_total === 0, '异常载荷 criteria_total=0（面板不显示假的 0/0 达成）');
  ok(acOf(db, 't-pass').verified === true && acOf(db, 't-pass').criteria_total === 2 && acOf(db, 't-pass').passed_total === 2, '真通过载荷 verified=true + 2/2');
  ok(acOf(db, 't-pass').reason === undefined, '真通过载荷不带 reason（形状与未核验互斥）');
  ok(acOf(db, 't-fail').verified === true && acOf(db, 't-fail').passed_total === 1 && acOf(db, 't-fail').failed.length === 1, '真拒收载荷 verified=true + 1/2 + failed 逐条');

  // 门禁语义不变：只有"真拒收"才拦
  ok(rFail.block !== null && String(rFail.block).includes('验收标准未达成'), '只有真拒收返回拦截串（门禁语义不变）', String(rFail.block).slice(0, 30));
  ok([rNoModel, rNoJson, rError, rPass].every((r) => r.block === null), '没跑/通过一律不拦（不阻断收口＝用户裁决 D1）');
  ok(String(rFail.block).includes('failedAcceptance'), '拦截串保留 failedAcceptance 载荷（下游展示逐条理由）');

  // 落账是读改写：不得清掉 ctx 其它键
  const db2 = mkdb();
  addTask(db2, 't-keep', { output_validations: [{ file: 'a.md', sufficient: true }], completion_quality: { score: 88 } });
  runExit(db2, 't-keep', 'no_model', null);
  const kept = JSON.parse((db2.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('t-keep') as { context_json: string }).context_json);
  ok(kept.output_validations?.[0]?.sufficient === true && kept.completion_quality?.score === 88, '落账为读改写，不动 ctx 其它键（output_validations/quality 保留）');
  db2.close();
  db.close();
}

// ─────────────────────────────────────────────────────────────
console.log('\nS1b 未核验载荷形状 · parseAcceptanceChecks 边界（不抛＝不冒名）');

ok(buildUnverifiedCheckPayload('no_model').verified === false && buildUnverifiedCheckPayload('no_model').criteria_total === 0, 'buildUnverifiedCheckPayload 形状固定');
ok(parseAcceptanceChecks('') === null && parseAcceptanceChecks('无方括号') === null, '空/无数组 → null（落 no_json 而**不是**冒名通过）');
ok(parseAcceptanceChecks('{"a":1}') === null, '可解析但非数组 → null（此前 `.filter` 抛异常被 catch 吞成 null → 冒名 PASS）');
ok(parseAcceptanceChecks('[{"criterion":"x","passed":true}]')?.length === 1, '正常数组 → 逐条');
ok(parseAcceptanceChecks('[非法 json]') === null, '非法 JSON → null（不抛）');

// ─────────────────────────────────────────────────────────────
console.log('\nS2 M1b 真核验载荷逐条精度（旧 zx_20260906_2 语义不回归）');

{
  const p = buildAcceptanceCheckPayload([
    { criterion: 'A可用', passed: true, reason: 'ok' },
    { criterion: 'B已测', passed: true },
    { criterion: 'C有文档', passed: false, reason: '缺.md' },
    { criterion: 'D性能达', passed: false },
    { criterion: '  带空格  ', passed: true },
    { criterion: '  ', passed: false },
  ]);
  ok(p.criteria_total === 6 && p.passed_total === 3, '计数正确 6 条 / 3 过');
  ok(p.passed.includes('A可用') && p.passed.includes('B已测') && p.passed.includes('带空格'), '通过项 criterion 保留且 trim');
  ok(p.failed.some((f) => f.criterion === 'C有文档' && f.reason === '缺.md'), '拒收项 reason 保留');
  ok(p.failed.some((f) => f.criterion === 'D性能达' && f.reason === '未说明'), 'reason 缺省兜底「未说明」');
  ok(p.failed.some((f) => f.criterion === '未命名' && f.reason === '未说明'), '全空白 criterion → 「未命名」（不丢拒收计数）');
  ok(buildAcceptanceCheckPayload([]).criteria_total === 0 && buildAcceptanceCheckPayload([]).verified === true, '空核对亦 verified=true（真跑过、0 条标准）');
}

// ─────────────────────────────────────────────────────────────
console.log('\nS3 M1c 下游护栏——verified=false 一律不认（四处共用一个判据）');

ok(isAcceptanceVerified({ checked_at: '2026-09-10T00:00:00Z', verified: true }) === true, '判据：checked_at + verified=true → 验过');
ok(isAcceptanceVerified({ checked_at: '2026-09-10T00:00:00Z', verified: false }) === false, '判据：verified=false → **不算验过**（M1a 新载荷）');
ok(isAcceptanceVerified({ checked_at: '2026-09-09T00:00:00Z' }) === true, '判据：存量数据无 verified 字段 → 视为验过（兼容）');
ok(isAcceptanceVerified({ verified: true }) === false, '判据：无 checked_at → 不算验过');
ok(isAcceptanceVerified(null) === false && isAcceptanceVerified(undefined) === false && isAcceptanceVerified('str') === false, '判据：null/undefined/非对象 → 不算验过（不抛）');

{
  // 真调生产函数：未核验 → 不打标；真核验 → 打标；探针/非 doc/retired 不受影响
  const db = mkdb();
  addTask(db, 't-unv', { acceptance_check: { checked_at: '2026-09-10T01:00:00Z', verified: false, reason: 'no_model', criteria_total: 0, passed_total: 0, passed: [], failed: [] } });
  addDoc(db, 'd1', 't-unv', '报告', '/x/report.md');
  markDocAcceptanceVerified(db, 't-unv');
  ok(Number((db.prepare("SELECT acceptance_verified v FROM wa_deliverables WHERE id='d1'").get() as any).v) === 0, '★护栏：未核验(verified=false) → **不**打 acceptance_verified（否则冒名 ✓）');

  addTask(db, 't-ver', { acceptance_check: { checked_at: '2026-09-10T01:00:00Z', verified: true, criteria_total: 2, passed_total: 2, passed: ['a', 'b'], failed: [] } });
  addDoc(db, 'd2', 't-ver', '报告', '/x/report2.md');
  addDoc(db, 'd3', 't-ver', '探针', '/x/_probe_ge.py');
  markDocAcceptanceVerified(db, 't-ver');
  ok(Number((db.prepare("SELECT acceptance_verified v FROM wa_deliverables WHERE id='d2'").get() as any).v) === 1, '真核验 → 正常打标（既有语义不回归）');
  ok(Number((db.prepare("SELECT acceptance_verified v FROM wa_deliverables WHERE id='d3'").get() as any).v) === 0, '探针 doc 仍不打标（C2 谓词不回归）');
  db.close();
}
{
  // 真调生产函数：回填 SQL 须排除 verified:false
  const db = mkdb();
  addTask(db, 't-a', { acceptance_check: { checked_at: '2026-09-10T01:00:00Z', verified: true, criteria_total: 1, passed_total: 1, passed: ['a'], failed: [] } });
  db.prepare("UPDATE wa_tasks SET status='completed' WHERE id='t-a'").run();
  addTask(db, 't-b', { acceptance_check: { checked_at: '2026-09-10T01:00:00Z', verified: false, reason: 'no_json', criteria_total: 0, passed_total: 0, passed: [], failed: [] } });
  db.prepare("UPDATE wa_tasks SET status='completed' WHERE id='t-b'").run();
  addDoc(db, 'da', 't-a', '报告', '/x/a.md');
  addDoc(db, 'db1', 't-b', '报告', '/x/b.md');
  backfillDocAcceptanceVerified(db);
  ok(Number((db.prepare("SELECT acceptance_verified v FROM wa_deliverables WHERE id='da'").get() as any).v) === 1, '回填：真核验的已完成任务 → 回填 1');
  ok(Number((db.prepare("SELECT acceptance_verified v FROM wa_deliverables WHERE id='db1'").get() as any).v) === 0, '★回填护栏：verified=false 的任务被 SQL 排除（不误标）');
  ok(!!db.prepare("SELECT 1 FROM wa_settings WHERE key='migration.doc_acceptance_backfill'").get(), '回填迁移标记落位（仅首启一次）');
  db.close();
}

ok(describeAcceptance({ checked_at: '2026-09-10T00:00:00Z', verified: true, criteria_total: 3, passed_total: 3 }) === '✓已验收 3/3', 'IM 徽标：真核验全过 → ✓已验收 p/t');
ok(describeAcceptance({ checked_at: '2026-09-10T00:00:00Z', verified: true, criteria_total: 3, passed_total: 1 }) === '验收 1/3', 'IM 徽标：真核验未全过 → 验收 p/t');
ok(describeAcceptance({ checked_at: '2026-09-10T00:00:00Z', verified: false, reason: 'no_model' }) === null, '★IM 徽标护栏：未核验 → null（不把"没核验"播成"已验收"）');
ok(describeAcceptance(undefined) === null, 'IM 徽标：无载荷 → null');

// ─────────────────────────────────────────────────────────────
console.log('\nS4 接线静态（覆巨型 handler / renderer 等测试触达不到处）');

// 落账无条件：调用方不得在某个出口上"忘记落账"
const fnStart = exe.indexOf('async function checkAcceptanceCriteria');
// 边界取下一个函数声明（不靠 magic 偏移/易漂的注释串——前者随文件增删即失准，后者一删断言就静默失效）
const fnEnd = exe.indexOf('async function checkGoalDeviation', fnStart);
const fnBody = exe.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
ok(fnStart > -1 && fnEnd > fnStart, '切片定位成功（函数体边界以内，不越界到相邻函数）');
ok(fnBody.includes('recordAcceptanceOutcome(db, taskId, decided)'), 'checkAcceptanceCriteria 经 recordAcceptanceOutcome 落账（四出口归一）');
ok(/^\s{2}const payload = recordAcceptanceOutcome\(db, taskId, decided\);/m.test(fnBody), '落账调用**无条件**（缩进 2 空格、前面无 if——四出口共用一笔）');
ok(!/if\s*\([^)]*\)\s*\{?\s*\n?\s*recordAcceptanceOutcome/.test(fnBody), '落账未被任何 if 包住（防"只有真通过才落库"复发）');
ok(fnBody.includes("kind = 'no_model';") && fnBody.includes("kind = 'exception';"), '四出口成因在取数段被显式标名（不再吞成一个 null）');
ok(exe.includes('} = await checkAcceptanceCriteria('), '调用方解构 { outcome, block }（不再只有一个裸 block）');
ok(exe.includes("checks.push('[PASS] 验收标准已核对达成')") && exe.includes('[WARN] 验收未核验'), '调用方按结局分流 [PASS]/[WARN]（不再无条件 [PASS]）');
ok(/if \(accOutcome\.ran && accOutcome\.passed\) \{\s*\n\s*checks\.push\('\[PASS\]/.test(exe), '[PASS] 被"真核验通过"包住');
ok(/if \(accOutcome\.ran && accOutcome\.passed\) try \{/.test(exe), '★验收配方（exemplar）加闸：只有真核验通过才沉淀"已验证配方"');
ok(exe.includes('finalize 收口时若该任务非 retired 产出尚无 primary'), 'M1 顺手订正 B2 注释（原写"验收全过"但代码从不读验收，名实相符）');
ok(!exe.includes('Finalize 验收全过'), '旧的不实注释已移除');

// 单一真源
ok((acc.match(/export function isAcceptanceVerified/g) || []).length === 1, 'isAcceptanceVerified 只有一份定义（全系统唯一判据）');
ok((acc.match(/export function buildAcceptanceCheckPayload/g) || []).length === 1 && (dlc.match(/export function buildAcceptanceCheckPayload/g) || []).length === 0, 'payload 纯函数单一真源在 acceptance-check.ts');
ok(exe.includes("export { buildAcceptanceCheckPayload } from './acceptance-check.js';"), 'agent-executor 保留旧导出（旧回归/调用点不裂）');
ok(!/text\.match\(\/\\\[\[\\s\\S\]\*\\\]\/\)/.test(exe), '贪婪正则在 agent-executor 中不再有副本（收敛到 acceptance-check.parseAcceptanceChecks）');

// 下游各读点一律接线同判据
// zx_20260914 M2-3③: 三个读点(list/digest/抽屉)的**解析**整体收敛到 core `verifiedAcceptanceMap`（`isAcceptanceVerified`
//   的唯一消费处）⇒ project.ipc 自身不再解析 acceptance_check、连判据都不再 import（遗留 import 已随之删除）。
//   扫描面如实命名：本段扫 `src/main/ipc/project.ipc.ts` 与 `src/main/core/deliverable-lifecycle.ts` 两个文件。
ok(!pip.includes('acceptance-check.js'), 'project.ipc 不再自带验收判据（连 import 都无——派生已收敛到 core）');
ok((pip.match(/annotateAcceptance\(db, /g) || []).length === 3, '三个读点（list/digest 邻/抽屉+task:get）全经共享派生，不再各写各的',
  `实测 annotateAcceptance(db, …) ${(pip.match(/annotateAcceptance\(db, /g) || []).length} 处`);
// zx_20260915 P0-2(d): 解析处仍是**一处**，只是由 `verifiedAcceptanceMap` 下移一级到 `parseAcceptance`
//   ——P0-2 要同出「未核验」视图，同一遍解析必须同时产两态（合成一个 Map 会诱使每个读点各判一次 verified）。
//   故锚点由"`accMap.set` 那一行"改为"该唯一消费落在 `parseAcceptance` 体内"。
ok((dlc.match(/isAcceptanceVerified\(/g) || []).length === 1
  && dlc.indexOf('isAcceptanceVerified(ac)') > dlc.indexOf('function parseAcceptance('),
  'core 内 isAcceptanceVerified 恰一处消费，且落在唯一解析处 `parseAcceptance`（P0-2 起同出未核验视图）');
ok(!/if \(ac && typeof ac === 'object' && ac\.checked_at\)/.test(pip), '旧的"只认 checked_at"读法已移除');
// project.ipc 是只读消费方：acceptance_check 一律只读（写路径唯一在 recordAcceptanceOutcome），
// 故此处无回填 SQL、也无需 verified:false 排除——若将来在此新增写/回填，本条会失败以提醒补排除条件。
ok(!/acceptance_check\s*=/.test(pip), 'project.ipc 对 acceptance_check 只读（无写/回填 ⇒ 无需排除条件；若新增写点本条报警）');
ok((dlc.match(/context_json LIKE '%checked_at%'/g) || []).length === 1, '回填 SQL 全树唯一（deliverable-lifecycle 单点，勿再散落第二处）');
ok(dlc.includes("NOT LIKE '%\"verified\":false%'"), 'deliverable-lifecycle 回填 SQL 追加 verified:false 排除');
// zx_20260914 M2-3③: 打标与打标前置判定**共用同一个解析处**（此前 markDocAcceptanceVerified 自行 parse + 自判，是第三份手抄）
ok(dlc.includes('if (!verifiedAcceptanceMap(db, [taskId]).has(taskId)) return;'), 'per-doc 打标改用共用解析处（判据仍是同一个 isAcceptanceVerified）');
ok(rd('apps/worker-ant-desktop/src/main/core/im-reply.ts').includes('if (!isAcceptanceVerified(acc)) return null;'), 'IM 徽标改用共用判据');

// renderer：未核验必须可见（否则"没跑到"与"没标准"仍不可分）
ok(tdp.includes('acceptanceCheck.verified === false') && tdp.includes('未核验'), 'TaskDetail 面板显示"未核验"（不再只显空白）');
ok(tdp.includes('ACCEPTANCE_REASON_LABEL'), 'TaskDetail 展示未核验成因（无模型/未吐 JSON/异常）');
ok(tdp.includes('(acceptanceCheck.criteria_total ?? 0) > 0 || acceptanceCheck.verified === false'), '面板**在未核验时也渲染**（此前 criteria_total=0 ⇒ 整体不渲染＝空白）');

// ─────────────────────────────────────────────────────────────
console.log('\nS5 M1b JSON 提取修复（E22 复现对照表 · 旧贪婪法 vs 新配平法）');

// 旧法（已被替换的实现，逐字复刻只为留下"修复前必败"的对照靶标）
const oldGreedy = (text: string): unknown[] | null => {
  const m = text.match(/\[[\s\S]*\]/);
  if (!m) return null;
  try { const p = JSON.parse(m[0]) as unknown; return Array.isArray(p) ? p : null; } catch { return null; }
};

// 6 种真实模型输出（E22 隔离实测表）：④⑤⑥ 是旧法必败、旧代码下冒名为 [PASS] 的三例
const REAL_OUTPUTS: Array<{ name: string; text: string; expectOld: boolean }> = [
  { name: '① 纯数组', expectOld: true, text: '[{"criterion":"A可用","passed":true,"reason":"ok"}]' },
  { name: '② ```json 围栏', expectOld: true, text: '```json\n[{"criterion":"A可用","passed":true}]\n```' },
  { name: '③ 前后散文（无括号）', expectOld: true, text: '根据验收标准逐条判断：\n[{"criterion":"A可用","passed":true}]\n以上。' },
  { name: '④ 前置 [方括号] 思考', expectOld: false, text: '[分析] 逐条判断如下：[{"criterion":"A可用","passed":true}]' },
  { name: '⑤ 后置 [附注]', expectOld: false, text: '[{"criterion":"A可用","passed":true}]\n以上结论见 [附注]。' },
  { name: '⑥ 前置思考含 []', expectOld: false, text: '思考：模型应输出 [] 表示空。结论：[{"criterion":"A可用","passed":false,"reason":"缺文档"}]' },
];
let oldOk = 0;
for (const c of REAL_OUTPUTS) {
  const o = oldGreedy(c.text) !== null;
  const n = parseAcceptanceChecks(c.text);
  if (o) oldOk++;
  ok(o === c.expectOld, `对照表·旧贪婪法 ${o ? '通过' : '失败'}（${c.name}）`);
  ok(n !== null, `★新法修复通过（${c.name}）`);
}
ok(oldOk === 3, `★复现 E22：旧法 6 例中恰 3 例失败（实测 ${6 - oldOk} 失败）`);
ok(REAL_OUTPUTS.every((c) => parseAcceptanceChecks(c.text) !== null), '★新法覆盖旧法全部失败例（含 ④⑤⑥）');

// 配平：字符串字面量内的 ] 与转义引号不得误判闭合
const strNest = parseAcceptanceChecks('[{"criterion":"A[1] 与 B] 均可用","passed":true}]');
ok(strNest !== null && strNest[0].criterion === 'A[1] 与 B] 均可用', '配平：criterion 串内 `[` `]` 不被误当括号');
const escQ = parseAcceptanceChecks('[{"criterion":"引号\\"与]","passed":true}]');
ok(escQ !== null && escQ[0].passed === true, '配平：串内转义引号不提前中断（`\\"` 后仍正确闭合）');
const nested = parseAcceptanceChecks('[{"criterion":"A","passed":true,"notes":["x","y"]}]');
ok(nested !== null && nested[0].criterion === 'A', '配平：嵌套数组取最外层跨度（不在内层提前收口）');

// 尾逗号容错（仅边界容错）
const trailing = parseAcceptanceChecks('[{"criterion":"A","passed":true},]');
ok(trailing !== null && trailing[0].criterion === 'A', '容错：数组尾逗号可解析（仅边界容错）');
const trailingObj = parseAcceptanceChecks('[{"criterion":"A","passed":true,}]');
ok(trailingObj !== null && trailingObj[0].passed === true, '容错：对象尾逗号可解析');

// 条目定型（防反向冒名）：字符串/数字型 passed 归一
const sFalse = parseAcceptanceChecks('[{"criterion":"A","passed":"false","reason":"缺文档"}]');
ok(sFalse !== null && sFalse[0].passed === false, '★定型：`"passed":"false"` → false（此前 `=== false` 为假 ⇒ 拒收项被计通过）');
const sTrue = parseAcceptanceChecks('[{"criterion":"A","passed":"true"}]');
ok(sTrue !== null && sTrue[0].passed === true, '定型：`"passed":"true"` → true');
const numFalse = parseAcceptanceChecks('[{"criterion":"A","passed":0}]');
ok(numFalse !== null && numFalse[0].passed === false, '定型：`passed:0` → false');
const numTrue = parseAcceptanceChecks('[{"criterion":"A","passed":1}]');
ok(numTrue !== null && numTrue[0].passed === true, '定型：`passed:1` → true');
const noPassed = parseAcceptanceChecks('[{"criterion":"A","reason":"未说明"}]');
ok(noPassed !== null && noPassed[0].passed === undefined, '定型：缺 passed 字段 → undefined（旧语义"计通过"不变，不借机改判）');
const sFalseOutcome = decideAcceptanceOutcome({ kind: 'ok', text: '[{"criterion":"A","passed":"false","reason":"缺文档"}]' });
ok(sFalseOutcome.outcome.ran && !sFalseOutcome.outcome.passed, '★定型接入结局：`"passed":"false"` 现在会**拦住**（此前静默通过）');

// 全败如实 no_json（不冒名）· 不猜对象包裹
ok(parseAcceptanceChecks('无数组的散文结论：验收无法判断') === null, '无数组 → null（落 no_json，不冒名）');
// 对象包裹：数组**字面存在**于文本中 ⇒ 作为候选跨度取到（不靠猜键、不猜语义）；键名不被解读
const wrapped = parseAcceptanceChecks('{"checks":[{"criterion":"A","passed":true}]}');
ok(wrapped !== null && wrapped.length === 1 && wrapped[0].criterion === 'A', '对象包裹：取出其中**字面存在**的数组（不猜键名，仅取跨度）');
ok(parseAcceptanceChecks('{"checks":[]}') !== null && (parseAcceptanceChecks('{"checks":[]}') as unknown[]).length === 0, '对象包裹·空数组 → 空结论（非 null：真拿到了"零条"）');
ok(parseAcceptanceChecks('[{"criterion":"A"') === null, '未闭合数组 → null');
ok(decideAcceptanceOutcome({ kind: 'ok', text: '模型认为无法判断' }).outcome.ran === false, 'no_json 结局成立（下游落 verified:false/reason:no_json）');

// 超时静态（本函数此前无 abortSignal，可无限挂起）
const accFn = exe.slice(exe.indexOf('async function checkAcceptanceCriteria'), exe.indexOf('async function checkGoalDeviation'));
ok(/abortSignal: AbortSignal\.timeout\(30_000\)/.test(accFn), '★补超时：checkAcceptanceCriteria 现带 abortSignal 30s（此前无，可无限挂起）');
ok(/abortSignal: AbortSignal\.timeout\(15_000\)/.test(exe.slice(exe.indexOf('async function checkGoalDeviation'))), '对照：checkGoalDeviation 仍为 15s（未误改）');

// ─────────────────────────────────────────────────────────────
// S6 zx_20260916 M1 第五出口「无人许诺，但引擎已代拟」（`no_user_criteria`）
//   本文件是**四出口**（no_model / no_json / error / no_criteria）的原始台账，新增取值必须回到此处点名，
//   否则"五出口"只在新区脚本里成立、老台账仍停在四——正是本仓反复吃过的"同一判据两处两个答案"。
//   完备性由**源码派生比对**：枚举联合类型的成员逐个去词表里找，不写"恰 N 个"这类只对下一轮引爆的字面量
//   （承 feedback「断言里不得写'只为下一轮'的字面量」——下轮再加一个取值，此处应自然通过而非弄红）。
console.log('\nS6 M1 第五出口 no_user_criteria（枚举新增取值 · 词表完备 · 下游不认）');

const unionSrc = acc.slice(acc.indexOf('AcceptanceUnverifiedReason ='), acc.indexOf(';', acc.indexOf('AcceptanceUnverifiedReason =')));
const reasonMembers = [...unionSrc.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
ok(reasonMembers.length >= 5 && reasonMembers.includes('no_user_criteria'),
  `枚举含第五取值（源码实测 ${reasonMembers.length} 个：${reasonMembers.join('/')}）`);
const labelBlock = acc.slice(acc.indexOf('UNVERIFIED_REASON_LABEL'), acc.indexOf('export function buildAcceptanceCheckPayload'));
const unlabeled = reasonMembers.filter((m) => !new RegExp(`(^|[\\s{])${m}:`).test(labelBlock));
ok(unlabeled.length === 0, `★ 词表覆盖全部枚举取值（逐成员派生比对；缺谁就点谁：${unlabeled.join('、') || '无'}）`);

const pFifth = buildUnverifiedCheckPayload('no_user_criteria');
ok(pFifth.verified === false && pFifth.reason === 'no_user_criteria' && pFifth.criteria_total === 0,
  '第五出口形状与"没跑"同构：verified=false、不报计数、成因码自陈其名');
ok(isAcceptanceVerified(pFifth) === false, '★ 唯一判据护栏：代拟载荷**不计入已验收**（新取值不得开后门）');
ok(describeAcceptance(pFifth) === null, '★ IM 徽标护栏：代拟载荷 → null（不把"引擎代拟"播成"已验收"）');
ok(pFifth.criteria_source === undefined,
  '第五出口走的是"未核验"通道，`criteria_source` 由代拟载荷专属（两条通道不得串味）');

console.log('\n结果: pass=' + pass + ' fail=' + fail);
if (fail > 0) process.exit(1);
