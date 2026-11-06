/**
 * zx_20260916 受控复跑 —— 「提议须有人应：代拟判据、隔离探针、播报豁免」。
 *
 * 各段对应方案 `plans/improve/zx_20260916.md` 一节，判据逐条照 §三.4 / §四.3 / §五.2 落：
 *   §S1 M1「代拟 ≠ 许诺」——**直引 `proposeAcceptanceCriteria` / `buildProposedCheckPayload` 真实现**
 *        （纯函数，路径探针由本脚本注入 ⇒ 判据一行未复刻）：
 *        ① 两类代拟各自"有依据才产出" + 反证（无依据 ⇒ 空，不编造）；
 *        ② **核心不变量** `isAcceptanceVerified(代拟载荷) === false`（引擎拟题 + 引擎判卷 = 自证）；
 *        ③ 载荷语义：`criteria_total`/`passed_total` 保持 0、自核结论落 `proposed_checked` **不进** `passed/failed`；
 *        ④ 落账 0→1（真夹具库）+ `criteriaSourceOf` 缺席读作 `declared`（存量载荷不迁移）；
 *        ⑤ `proposeAcceptanceForTask` 真实现三态：规划类代拟 / 非规划类不代拟 / 代拟不出则回落；
 *        ⑥ 枚举穷举（承 feedback「新增持久化枚举值须穷举全部读取谓词」）：
 *           **真源 + 具名读 + renderer 三处字面量分支**全部在册（正面断言，不是"不抛"）。
 *   §S2 M2「探针产物移入隔离目录」——**真临时目录**（`mkdtemp`），真跑 `disposeProbeDeliverables`：
 *        移动 0→1 正面断言 + 目标存在/原位不存在 + `file_path` 回写 + `status` 仍 retired；
 *        幂等（二次 `alreadyGone`，**不谎报已隔离**）；**真实交付 doc 零触碰**；
 *        缺省不传隔离根 ⇒ 退回旧行为（未接线调用方平滑过渡）；`keep` ⇒ 不移动；
 *        **失败面**（隔离根被同名文件占位 ⇒ `mkdirSync` 必抛）⇒ `failed` 非空 + 登记仍 retired + 路径**未**回写。
 *   §S3 M3「F3 播报豁免」——`isProbeNotifyFile` 真实现：探针名 0→N 命中 + **真库现存文件名反证**（防误伤）；
 *        静态：两路滤器**共引同一实现**、前缀表**只有一份**、`P0_` 的**差异刻意保留**（不得被误并）。
 *   §S4 build 钉（派生核对，不写轮次字面量）。
 *
 * ⚠ 承 feedback「rr 夹具须按生产初始化顺序」：本文件夹具 DDL 逐列照抄 `database.ts`（含 ALTER 补列）。
 * ⚠ 承 feedback「断言里不得写"只为下一轮"的字面量」：本文件不以轮次字面量做等值断言；
 *   build 钉一律由 `scripts/lib/rr-pins.ts` 派生核对（§S4）。
 * ⚠ 本文件**不打开真库**（真库只读实测见方案 §一）；§S4 读 `dist` ⇒ tsup 须先于本脚本。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins } from './lib/rr-pins.js';
import { engineSrc } from './lib/rr-engine-src.js';
import {
  proposeAcceptanceCriteria, buildProposedCheckPayload, recordProposedCheck,
  criteriaSourceOf, isAcceptanceVerified, UNVERIFIED_REASON_LABEL,
} from '../apps/worker-ant-desktop/src/main/core/acceptance-check.js';
import { proposeAcceptanceForTask } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { disposeProbeDeliverables, selectProbeDeliverables } from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
import { isProbeNotifyFile, PROBE_NOTIFY_PREFIXES } from '../apps/worker-ant-desktop/src/main/services/im-router.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (a: unknown, b: unknown, l: string) => ok(JSON.stringify(a) === JSON.stringify(b), l, `${JSON.stringify(a)} vs ${JSON.stringify(b)}`);

const A = 'apps/worker-ant-desktop';
const root = path.join(__dirname, '..');
const RD = (f: string) => fs.readFileSync(path.join(root, f), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
type AnyDb = import('better-sqlite3').Database;

// ── 夹具 schema：逐列照抄 database.ts DDL（含 ALTER 补列），既不缺列也不放宽 NOT NULL ──
const SCHEMA = `
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT DEFAULT '');
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'p', parent_task_id TEXT DEFAULT '',
  title TEXT DEFAULT '', description TEXT DEFAULT '', status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 0,
  context_json TEXT DEFAULT '{}', depends_on TEXT DEFAULT '', source TEXT DEFAULT 'test',
  acceptance_criteria TEXT DEFAULT '', quality_score REAL, aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT NOT NULL,
  name TEXT DEFAULT '', description TEXT DEFAULT '', file_path TEXT, registry_id TEXT,
  status TEXT DEFAULT 'draft', is_primary INTEGER DEFAULT 0, acceptance_verified INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
  event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
  aggregate_version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL DEFAULT '{}',
  metadata TEXT DEFAULT '{}', occurred_at TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')));
`;
const mkdb = (): AnyDb => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d as unknown as AnyDb; };

const addTask = (db: AnyDb, id: string, opts: { title?: string; description?: string; status?: string } = {}): void => {
  db.prepare(`INSERT INTO wa_tasks (id, project_id, title, description, status, source, acceptance_criteria, context_json)
              VALUES (?, 'p', ?, ?, ?, 'test', '', '{}')`)
    .run(id, opts.title ?? id, opts.description ?? '', opts.status ?? 'completed');
};
const addDeliv = (db: AnyDb, id: string, taskId: string, over: { name?: string; file_path?: string | null; status?: string } = {}): void => {
  db.prepare(`INSERT INTO wa_deliverables (id, project_id, task_id, type, name, description, file_path, status, is_primary, acceptance_verified, created_at, updated_at)
              VALUES (?, 'p', ?, 'doc', ?, '', ?, ?, 0, 0, datetime('now'), datetime('now'))`)
    .run(id, taskId, over.name ?? id, over.file_path ?? null, over.status ?? 'draft');
};
const delivRow = (db: AnyDb, id: string): { status: string; file_path: string | null } =>
  db.prepare('SELECT status, file_path FROM wa_deliverables WHERE id = ?').get(id) as { status: string; file_path: string | null };
const ctxObj = (db: AnyDb, id: string): Record<string, unknown> =>
  JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get(id) as { context_json: string }).context_json || '{}');

const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx16-'));
let seq = 0;
/** 真文件（探针隔离要真移动，故不能用假路径） */
const tmpFile = (name: string, body = 'x'): string => {
  const dir = path.join(tmpdir, `d${seq++}`);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, name);
  fs.writeFileSync(p, body);
  return p;
};
const tmpSub = (name: string): string => path.join(tmpdir, `d${seq++}`, name);
/** 相对路径落真文件（**目录层级要真**——规则②的判据是"在册产出物的 file_path 是否落在该路径上"，扁平路径测不出尾匹配） */
const tmpFileAt = (rel: string, body = 'x'): string => {
  const p = path.join(tmpdir, `d${seq++}`, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
  return p;
};

async function main(): Promise<void> {
  const aeSrc = stripComments(engineSrc());
  const acSrc = stripComments(RD(`${A}/src/main/core/acceptance-check.ts`));
  const routerSrc = stripComments(RD(`${A}/src/main/services/im-router.ts`));
  const tdpSrc = stripComments(RD(`${A}/renderer/src/pages/TaskDetailPage.tsx`));
  const dpSrc = stripComments(RD(`${A}/renderer/src/pages/DeliverablesPage.tsx`));

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S1】M1 代拟 ≠ 许诺：判据有据、验收不冒名、枚举穷举');
  {
    // ── (a) 规则① 产出落盘：有据才产出，探针缺席则如实"未能核实" ──
    const f1 = tmpFile('plan.md', '# 方案');
    const dels = [{ name: 'plans/project/A_x.md', type: 'doc', status: 'completed', file_path: f1 }];
    const p1 = proposeAcceptanceCriteria({ title: '某规划', description: '写方案', deliverables: dels, pathExists: fs.existsSync });
    eq(p1.proposed.length, 1, '① 单条在册产出物 ⇒ 单条判据（不重复不凑数）');
    ok(p1.checked[0]!.basis.includes('在册产出物'), '① 判据带**代拟依据**（`basis` 指向在册产出物的 file_path——"凭空代拟"的反证锚点）');
    eq(p1.checked[0]!.passed, true, '① 文件真在路径上 ⇒ passed **0→1**');
    eq(p1.checked[0]!.note, undefined, '① 达成时不写 note（只有未达成/未能核实才带说明）');

    const p1b = proposeAcceptanceCriteria({ title: '某规划', description: '写方案', deliverables: dels });
    eq(p1b.checked[0]!.passed, false, '① ② **不注入路径探针 ⇒ passed=false**（"未能核实"绝不冒名成"已达成"）');
    ok(String(p1b.checked[0]!.note).includes('未能核实'), '① ② 且 note 如实说明成因');

    const gone = proposeAcceptanceCriteria({ title: 'x', description: '', deliverables: [{ name: 'n', file_path: path.join(tmpdir, '不存在.md') }], pathExists: fs.existsSync });
    eq(gone.checked[0]!.passed, false, '① 文件不在路径上 ⇒ passed=false');
    ok(String(gone.checked[0]!.note).includes('未在路径上找到'), '① 且 note 指出具体哪个路径');

    // ── (b) 规则② 指定路径：判据落在"在册产出物的 file_path 是否落在该路径上" ──
    const f2 = tmpFileAt('plans/project/A_y.md', '# 方案');
    const p2 = proposeAcceptanceCriteria({
      title: '规划', description: '最终方案须写入指定文件 plans/project/A_y.md。',
      deliverables: [{ name: 'plans/project/A_y', file_path: f2 }], pathExists: fs.existsSync,
    });
    const hit = p2.checked.find((c) => c.criterion.includes('指定路径'))!;
    ok(!!hit && hit.passed, '② 文本路径字面量与在册产出物 file_path 尾匹配 ⇒ passed（**与 cwd 无关**——不以 `existsSync(字面量)` 判）');

    const p2b = proposeAcceptanceCriteria({
      title: '规划', description: '最终方案须写入指定文件 plans/project/A_z.md。',
      deliverables: [{ name: 'plans/project/A_y', file_path: f2 }], pathExists: fs.existsSync,
    });
    const miss = p2b.checked.find((c) => c.criterion.includes('指定路径'))!;
    eq(miss.passed, false, '② 字面量无对应在册产出物 ⇒ passed=false');
    ok(String(miss.note).includes('没有落在该路径上'), '② 且 note 说的是"没有产出物落在该路径"，不是"文件不存在"（成因不同名）');

    // ── (c) 规则③ 无依据 ⇒ 不代拟（不得为凑数编判据） ──
    eq(proposeAcceptanceCriteria({ title: '随手记一则', description: '无路径、无产出物', deliverables: [], pathExists: fs.existsSync }).proposed, [],
      '③ **两条依据皆无 ⇒ 空**（凭空代拟即编造，宁可返回空让调用方回落 `no_criteria`）');
    eq(proposeAcceptanceCriteria({ title: 'x', description: 'y', deliverables: [{ name: '无路径产出物', file_path: null }], pathExists: fs.existsSync }).proposed, [],
      '③ 产出物无 file_path ⇒ 不产出该条（空 file_path 不是"已落盘"）');

    // ── (d) 载荷语义 + 核心不变量「代拟 ≠ 许诺」 ──
    const payload = buildProposedCheckPayload(p1);
    eq(payload.verified, false, '★ 核心不变量：代拟载荷 `verified === false`（引擎拟题 + 引擎判卷 = 自证）');
    eq(isAcceptanceVerified(payload), false, '★ `isAcceptanceVerified(代拟载荷) === false`（下游绝不打 ✓ / 徽标 / 配方）');
    eq(payload.reason, 'no_user_criteria', '成因码与 `no_criteria` **不同名**（"无人许诺但有代拟" ≠ "无人许诺也无从代拟"）');
    eq(payload.criteria_source, 'engine_proposed', '载荷标明**来源**（`declared` / `engine_proposed` 不得混名）');
    eq([payload.criteria_total, payload.passed_total, payload.passed.length, payload.failed.length], [0, 0, 0, 0],
      '自核结论**不进** `passed/failed`（那不是"验收结果"）——计数沿用"未核验不报计数"，面板不会显示假的 N/N 已达成');
    eq(payload.proposed_checked!.length, payload.proposed.length, '`proposed` 与 `proposed_checked` 逐条对齐（可复盘）');
    eq(UNVERIFIED_REASON_LABEL.no_user_criteria.includes('代拟'), true, '人可读词表含新值（真源，非空串）');

    // ── (e) `criteriaSourceOf` 是唯一读点：缺席读作 declared（存量载荷零迁移） ──
    eq(criteriaSourceOf(undefined), 'declared', '`criteriaSourceOf(undefined)` ⇒ declared（"没这笔账"≠"引擎代拟"）');
    eq(criteriaSourceOf({ checked_at: 't', verified: true }), 'declared', '存量已核验载荷（无 `criteria_source`）⇒ declared');
    eq(criteriaSourceOf(payload), 'engine_proposed', '代拟载荷 ⇒ engine_proposed');

    // ── (f) 落账 0→1（真夹具库） ──
    const db = mkdb();
    addTask(db, 'm1-t', { title: '2026xxxx 规划方案', description: '写方案' });
    eq(ctxObj(db, 'm1-t').acceptance_check, undefined, '前置：落账前 `acceptance_check` **不在账上**（0）');
    recordProposedCheck(db, 'm1-t', p1);
    const acc = ctxObj(db, 'm1-t').acceptance_check as { verified?: boolean; reason?: string; criteria_source?: string };
    eq(acc.criteria_source, 'engine_proposed', '落账 **0→1**（正面断言：值从"无"变"engine_proposed"）');
    eq(acc.verified, false, '落库的 `verified` 仍为 false');

    // ── (g) `proposeAcceptanceForTask` 真实现三态（真夹具库 + 真探针滤除） ──
    const db2 = mkdb();
    const planFile = tmpFileAt('plans/project/A_2026xxxx.md', '# 方案');
    addTask(db2, 'm1-plan', { title: '2026xxxx 功能优化规划', description: `最终方案写入 plans/project/A_2026xxxx.md` });
    addDeliv(db2, 'm1-d1', 'm1-plan', { name: 'plans/project/A_2026xxxx', file_path: planFile });
    const pulled = proposeAcceptanceForTask(db2, 'm1-plan');
    eq(pulled?.proposed.length, 2, '规划类 + 无用户判据 ⇒ 代拟 **2 条**（① 产出落盘 + ② 指定路径，两类规则都真的产出，非空跑）');

    const db3 = mkdb();
    addTask(db3, 'm1-chat', { title: '随手记一则', description: '今天天气不错，记一笔' });
    addDeliv(db3, 'm1-d2', 'm1-chat', { name: 'notes', file_path: planFile });
    eq(proposeAcceptanceForTask(db3, 'm1-chat'), null, '**非规划类 ⇒ 不代拟**（不越权替所有任务代拟，回落 no_criteria）');

    const db4 = mkdb();
    addTask(db4, 'm1-bare', { title: '2026xxxx 实施', description: '无路径、无产出物' });
    eq(proposeAcceptanceForTask(db4, 'm1-bare'), null, '规划类但**一条依据都没有** ⇒ 仍回落 `no_criteria`（不编判据）');

    const db5 = mkdb();
    const probeFile = tmpFile('_tmp_probe_x.py', 'print(1)');
    addTask(db5, 'm1-probe', { title: '2026xxxx 方案实施', description: '' });
    addDeliv(db5, 'm1-d3', 'm1-probe', { name: '_tmp_probe_x', file_path: probeFile });
    eq(proposeAcceptanceForTask(db5, 'm1-probe'), null,
      '★ 代拟清单**按探针尺滤过**（`_tmp_probe_x.py` 不算"在册产出物"）——同一把 `docNotProbe` 的尺，不在此复刻第二份正则');

    // ── (h) 枚举穷举（承 feedback「新增持久化枚举值须穷举全部读取谓词」）：正面断言四处都在册 ──
    ok(acSrc.includes("'no_user_criteria'"), '① 真源在册：枚举定义（`AcceptanceUnverifiedReason`）');
    ok(acSrc.includes('no_user_criteria:') && acSrc.includes('UNVERIFIED_REASON_LABEL'), '① 真源在册：人可读词表 `UNVERIFIED_REASON_LABEL`');
    ok(aeSrc.includes('criteriaSourceOf('), '③ 具名读在册：`agent-executor.ts` 按来源分文案（不是只把新值塞进索引读就完事）');
    eq(tdpSrc.split("'no_user_criteria'").length - 1, 2, '④ renderer 在册：`TaskDetailPage.tsx` **恰 2 处**字面量分支（标题后缀 + 正文块）');
    eq(dpSrc.split("'no_user_criteria'").length - 1, 1, '④ renderer 在册：`DeliverablesPage.tsx` **恰 1 处**字面量分支');
    ok(tdpSrc.includes('proposed_checked') && dpSrc.includes('proposed'),
      '④ renderer 读的是**代拟项本身**（逐条展开 / 报条数）——不是只换个文案仍不显示内容');
    // 词表**别名**而非手抄：两页的 ACCEPTANCE_REASON_LABEL 必须是 main 侧 UNVERIFIED_REASON_LABEL 的引用，
    // 若某页改成字面量 map，新取值日后又要在第三处手抄（G8/G9 的复发形态）。
    const aliasOk = [tdpSrc, dpSrc].every((s) => /ACCEPTANCE_REASON_LABEL\s*:\s*Record<string,\s*string>\s*=\s*UNVERIFIED_REASON_LABEL/.test(s));
    ok(aliasOk, '④ 两页成因词表是 main 侧词表的**别名**（非手抄 map——手抄即"第二落点"再生一份）');
    const tdpType = RD(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
    ok(/AcceptanceCheckLike/.test(tdpType) && !/acceptance_check as \{ checked_at/.test(tdpType),
      '④ 该形状**跨 root 引 main 侧同一份类型**（"第二落点"不只是词表，手抄的**类型**同样会与真源分家）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S2】M2 探针产物移入隔离目录：真移动、真回写、真幂等、真有失败面');
  {
    // ── (a) 真移动 + 回写 ──
    const db = mkdb();
    addTask(db, 'm2-t');
    const realDoc = tmpFile('A_real.md', '# 真成果');
    const probeA = tmpFile('_tmp_probe_a.py', 'x');
    addDeliv(db, 'm2-real', 'm2-t', { name: 'plans/project/A_real', file_path: realDoc, status: 'completed' });
    addDeliv(db, 'm2-probe', 'm2-t', { name: '_tmp_probe_a', file_path: probeA, status: 'draft' });
    const qdir = tmpSub('quarantine/m2-t');
    const probes = selectProbeDeliverables(db, 'm2-t');
    eq(probes.length, 1, '前置：探针检出 1 条（真交付 doc 不在候选内——同一把尺）');

    const r1 = disposeProbeDeliverables(db, probes, 'retire', qdir);
    eq(r1.retired, 1, '① 退休 **0→1**（正面断言）');
    eq(r1.moved, 1, '① 隔离移动 **0→1**（正面断言——这是 M2 的要害：此前为恒 0）');
    eq(r1.alreadyGone, 0, '① 源文件在 ⇒ `alreadyGone` 保持 0（不把"移了"记成"本来就不在"）');
    eq(r1.failed, [], '① 无失败');
    ok(fs.existsSync(path.join(qdir, '_tmp_probe_a.py')), '① **目标文件存在**（真移到了隔离目录）');
    ok(!fs.existsSync(probeA), '① **原位不存在**（工作树真的干净了——不再是"登记说退休、文件还在原地"）');
    eq(delivRow(db, 'm2-probe'), { status: 'retired', file_path: path.join(qdir, '_tmp_probe_a.py') }, '① `status` 仍 retired 且 `file_path` **已回写**为新位置');

    // ── (b) 真实交付 doc 零触碰 ──
    eq(delivRow(db, 'm2-real'), { status: 'completed', file_path: realDoc }, '① **真实交付 doc 零触碰**（路径逐位不变）');
    ok(fs.existsSync(realDoc), '① 且其文件仍在原位（隔离不得误伤真成果）');

    eq(selectProbeDeliverables(db, 'm2-t').length, 0,
      '① 退休后**不再入选**（`selectProbeDeliverables` 排除 retired ⇒ 二次收口不会重选同一行，这是幂等的**真闸**，不靠"再移一次也无妨"）');

    // ── (c) 幂等兜底：源文件本就不在 ⇒ 不计入 moved、不谎报 ──
    //   真正会走到这一支的是"登记了探针但文件从未落盘 / 已被用户自行清走"（上面那行即把"二次收口重选"堵死）。
    const goneSrc = path.join(tmpdir, `d${seq++}`, '_tmp_probe_never.py');
    const again = disposeProbeDeliverables(db, [{ id: 'm2-probe', file_path: goneSrc }], 'retire', qdir);
    eq([again.retired, again.moved, again.alreadyGone, again.failed.length], [0, 0, 1, 0],
      '① 源本就无 ⇒ `alreadyGone` **1**、`moved` 0（如实"没动"）；且已 retired 行**不重复计数**（`retired` 0——状态没变就是没变）');

    // ── (d) 缺省不传隔离根 ⇒ 退回旧行为（未接线调用方平滑过渡） ──
    const db2 = mkdb();
    addTask(db2, 'm2-t2');
    const probeB = tmpFile('_verify_b.py', 'x');
    addDeliv(db2, 'm2-pb', 'm2-t2', { name: '_verify_b', file_path: probeB, status: 'draft' });
    const r2 = disposeProbeDeliverables(db2, selectProbeDeliverables(db2, 'm2-t2'), 'retire');
    eq([r2.retired, r2.moved], [1, 0], '① 不传隔离根 ⇒ 只改登记状态（**退回旧行为**，不静默改成移动）');
    ok(fs.existsSync(probeB), '① 且文件仍在原位');

    // ── (e) keep ⇒ 不移动、不退休 ──
    const db3 = mkdb();
    addTask(db3, 'm2-t3');
    const probeC = tmpFile('_tmp_c.py', 'x');
    addDeliv(db3, 'm2-pc', 'm2-t3', { name: '_tmp_c', file_path: probeC, status: 'draft' });
    const r3 = disposeProbeDeliverables(db3, selectProbeDeliverables(db3, 'm2-t3'), 'keep', tmpSub('quarantine/m2-t3'));
    eq([r3.kept, r3.moved], [1, 0], '① `keep` ⇒ 保留且**不移动**（保持既有语义）');
    eq(delivRow(db3, 'm2-pc').status, 'draft', '① 且 `status` 仍 `draft`（未擅自退休）');
    ok(fs.existsSync(probeC), '① 文件仍在原位');

    // ── (f) 失败面：**不得静默**（隔离根被同名文件占位 ⇒ mkdirSync 必抛） ──
    const db4 = mkdb();
    addTask(db4, 'm2-t4');
    const probeD = tmpFile('_tmp_d.py', 'x');
    addDeliv(db4, 'm2-pd', 'm2-t4', { name: '_tmp_d', file_path: probeD, status: 'draft' });
    const blocked = tmpFile('blocked', ''); // 用一个**文件**占住隔离根的路径 ⇒ mkdirSync(recursive) 抛 ENOTDIR/EEXIST
    const r4 = disposeProbeDeliverables(db4, selectProbeDeliverables(db4, 'm2-t4'), 'retire', path.join(blocked, 'sub'));
    eq(r4.moved, 0, '① 隔离失败 ⇒ `moved` **不计**（不把失败记成成功）');
    eq(r4.failed.length, 1, '① 失败**如实上抛**（`failed` 0→1——本仓纪律：被 `try/catch` 吞掉的写入只有正面断言能抓住）');
    ok(r4.failed[0]!.name === '_tmp_d.py' && String(r4.failed[0]!.reason).length > 0, '① 且点名是哪个文件、原因是何');
    eq(delivRow(db4, 'm2-pd'), { status: 'retired', file_path: probeD }, '① 失败时：登记**照常**置 retired，但 `file_path` **未回写**、文件原地不动');
    ok(fs.existsSync(probeD), '① 文件确实还在原处（失败不留白：登记状态与文件位置**各自如实**）');

    // ── (g) 静态：调用点确实把隔离根接上了 ──
    ok(aeSrc.includes("'quarantine'"), '静态：收口调用点传了隔离根（`data/quarantine/<taskId>`）');
    ok(/disposeProbeDeliverables\(db, probes, 'retire', /.test(aeSrc), '静态：`retire` 分支的调用带第 4 参（不接线 ⇒ 隔离永不发生）');
    ok(aeSrc.includes('隔离失败'), '静态：失败面在 `checks` 里如实报（不是只 return 计数没人看）');
    const dlSrc = stripComments(RD(`${A}/src/main/core/deliverable-lifecycle.ts`));
    const qOccur = dlSrc.split('quarantineDir').length - 1;
    ok(/quarantineDir\?: string,/.test(dlSrc), '静态：`quarantineDir` **可选**（缺省不传 ⇒ 退回旧行为，未接线的调用方零改动）');
    ok(qOccur >= 4, `静态：该形参**被消费**而非死参（定义 1 + 缺省判断 1 + mkdir 1 + join 1，实测 ${qOccur} 处——只见于签名的形参＝功能未落地）`);
    ok(!/fs\.unlinkSync/.test(dlSrc), '静态：本模块**不删文件**（"不删"这条边界未被逆——隔离是移动，不是删除）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S3】M3 F3 播报豁免：探针不播报、P0 仍播报、两路共用一份表');
  {
    // ── (a) 真实现：探针名命中 ──
    const probes = ['_tmp_probe_dsa.txt', '_probe_x.txt', 'inspect_run.txt', 'test_ping.txt', 'tmp_out.txt', '_verify_out.txt'];
    eq(probes.map(isProbeNotifyFile), probes.map(() => true), '探针/临时前缀 **0→N 全命中**（正面断言）');
    eq(isProbeNotifyFile('_TMP_UPPER.txt'), true, '大小写不敏感（`_TMP_UPPER.txt` 同样豁免）');

    // ── (b) 反证：真库现存文件名**一个都不命中**（防误伤真播报） ──
    const realNames = [
      'action_guide_close_20260813_172351.txt', 'action_guide_morning_20260824_102345.txt',
      'entry_plan_scan_20260821_102400.txt', 'midday_2026-08-12.txt', 'strategy_report_20260911_171917.txt',
      'top_picks_20260821_124906.txt', 'exit_alert_20260903_142923.txt', 'P0_alert.txt',
    ];
    eq(realNames.filter(isProbeNotifyFile), [], '★ 反证：真库现存 7 个真实播报名 + `P0_*.txt` **零命中**（豁免不得误伤正主）');

    // ── (c) 静态：两路滤器共引同一实现、前缀表只有一份、P0_ 差异刻意保留 ──
    // zx_20261003 M9 就地改钉：F3 播报段整体搬入 `services/f3-notification-push.ts`（im-router 仅再导出）。
    //   判据指向代码**现居**的文件；"两路共引"本就跨两文件（命令滤器留 im-router，定义+F3 滤器在 F3 文件）⇒ 两侧合计。
    const f3Src = stripComments(RD(`${A}/src/main/services/f3-notification-push.ts`));
    const routerRefs = (routerSrc + f3Src).split('isProbeNotifyFile(').length - 1;
    ok(routerRefs >= 3, `静态：两路滤器**共引同一实现**（定义在 F3 文件 + 命令/播报两处调用，im-router.ts 与 f3-notification-push.ts 合计，实测 ${routerRefs} 处——各写一份正则必分家）`);
    const tableDefs = (f3Src.split('PROBE_NOTIFY_PREFIXES: readonly string[]').length - 1);
    eq(tableDefs, 1, '静态：前缀表**只有一份**定义（在 `f3-notification-push.ts`——第二份手抄即第二份真源）');
    eq(PROBE_NOTIFY_PREFIXES.length, 6, '静态：前缀表内容在册（导出常量，rr 直读真值而非抄一遍）');
    ok(routerSrc.includes("!f.startsWith('P0_')"), '★ 静态：IM 命令路**仍排除 `P0_`**——两路滤器的差异是**实质差异**（P0 是给播报的，不是给命令的），**刻意不并成一份**');
    ok(/endsWith\('\.txt'\) && !isProbeNotifyFile\(f\)/.test(f3Src), '静态：F3 播报路按新口径滤（`.txt` 且非探针）——扫描面 `f3-notification-push.ts`（**M9 就地改钉**）');
  }

  // ═════════════════════════════════════════════════════════════════════════
  console.log('\n【S4】build 钉（派生核对，不写轮次字面量）');
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

void main().then(() => {
  fs.rmSync(tmpdir, { recursive: true, force: true });
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20260916: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
});
