/**
 * zx_20261022_3 批十二 受控复跑 —— 「信·名实」：判得对形态、认得出归属、停得下也唤得醒。
 *
 * 分组（与用户并入本轮的六条真实问题一一对应）：
 *   A archetype 护栏（真实怡寿里题面仍判 code；真文档任务仍判 document；工具面随形态走）
 *   B 任务自有文件账 + 提交闸（无 shell 降级 WARN、他人脏不拦本任务、本任务脏才拦）
 *   C 撞顶续额的自动续跑判据（引擎自己发的那一笔才认）
 *   D 子任务暂停 ⇒ 父任务被唤醒并如实分列（含"不再无限唤醒"的去重）
 *   E 只读仓库证据（判卷器拿到的不是模型自述）
 *
 * 纪律（承 CLAUDE.md 与 auto-memory）：
 *   · 直引**生产函数 / 真实现**（被删/改名即编译期失败）。
 *   · 两侧标本同试；计数器类断言给 0→1 正面值。
 *   · 断言文案不含失败字形（`pnpm rr:all` 汇总器按字形计数）。
 *   · 表结构走生产 `initDatabase`（自建 DDL 照不出建表/迁移缺陷）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import Database from 'better-sqlite3';
import { checkBuildPins } from './lib/rr-pins.js';
import { initDatabase } from '../apps/worker-ant-desktop/src/main/database.js';
import { classifyArchetype, narrowToolFace } from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';
import { recordTaskFile, ownedPaths, porcelainPaths, gitGateVerdict, renderOwnedRepoEvidence } from '../apps/worker-ant-desktop/src/main/core/task-file-ledger.js';
import { shouldAutoResumeOnStepCap, STEP_CAP_GRANT_LIMIT } from '../apps/worker-ant-desktop/src/main/core/step-budget.js';
import { pauseSettlesParent, PAUSE_REASON_ACCEPTANCE_FAILED, PAUSE_REASON_CHILDREN_INCOMPLETE, PAUSE_REASON_USER_INTERRUPT, PAUSE_REASON_AWAITING_INPUT } from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
import { checkParentTaskAfterChildDone } from '../apps/worker-ant-desktop/src/main/core/jobs/ai-task.js';
import { reevaluateSelfWhenWaitingOnChildren } from '../apps/worker-ant-desktop/src/main/core/task-terminal-release.js';
import { setJobEnqueuer } from '../apps/worker-ant-desktop/src/main/core/job-enqueuer.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ok ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const tmpdir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261022-3-b12-'));

/* ── A：真实题面（逐字摘自怡寿里项目真库标本，冻结为夹具） ───────────────────── */

const M1_BACKEND = 'M1 P0 资金与订单主干 — 后端端点与动作（退款/提现/异常/机构员工/账单） '
  + '【目标】M1「P0 资金与订单主干」的后端部分：新增/增强 ERP 端点，使 P03/P04/P05/P06/P07/P11/P17 七页具备真实可用接口。不含页面代码。 '
  + '【必读】plans/backend/20261021.md §5「M1」DoD M1-1…M1-7（唯一验收依据）。 '
  + '幂等：优先用框架 Manager 的条件更新能力；若无，则「读-状态判断-写」，并在报告中如实标注为'
  + '【应用层幂等，非行级条件更新】，不得声称「DB 命中 0 行」';
const M1_FRONTEND = 'M1 P0 资金与订单主干 — 前端页面与模块JS（P03/P04/P05/P06/P07/P11/P17） '
  + '【目标】M1「P0 资金与订单主干」的前端部分：新建/增强 7 个 ERP 页面（jQuery + jqGrid + aceadmin，'
  + '沿用既有 pages+modules 结构），对接同里程碑后端任务提供的 erp/** 端点。';
const M25_BACKEND = 'M2.5 P2 增值与总览 — 后端端点（dashboard/summary、信用、回忆录、健康档案只读） '
  + '【目标】M2.5「P2 增值与总览」的后端部分：新建 5 个控制器共 15 个端点，为 P02/P21/P23/P24 四页提供接口。'
  + '不含页面代码（页面由并行前端任务负责）。';

function groupA(): void {
  const cases: Array<[string, string, string]> = [
    ['A-1', M1_BACKEND, 'code'],
    ['A-2', M1_FRONTEND, 'code'],
    ['A-3', M25_BACKEND, 'code'],
  ];
  for (const [tag, text, expect] of cases) {
    const got = classifyArchetype(text);
    ok(got === expect, `${tag} 真实怡寿里题面（写代码 + 附证据文档）判 ${expect}`, `got=${got}`);
  }
  // 真文档任务不得被 code 规则吞掉——两侧标本（承 feedback_predicate_needs_both_sides_specimen）。
  eq(classifyArchetype('撰写 API 文档，覆盖全部端点与参数'), 'document', 'A-4 撰写+文档（文档本身即交付物）仍判 document');
  eq(classifyArchetype('生成技术报告，总结本轮实施情况'), 'document', 'A-5 生成+报告仍判 document');
  eq(classifyArchetype('分析代码库架构，形成评估结论'), 'research', 'A-6 纯分析仍判 research');

  // 工具面随形态走：code 留 shell，document 不含 shell。
  const tools: Record<string, unknown> = { write_file: {}, read_file: {}, execute_command: {}, bash: {}, git_clone: {} };
  const codeFace = narrowToolFace('code', tools);
  const docFace = narrowToolFace('document', tools);
  ok(codeFace.removed.length === 0, 'A-7 code 形态不删任何工具（含 shell 三件）', `removed=${codeFace.removed.join(',')}`);
  ok(['execute_command', 'bash', 'git_clone'].every((n) => docFace.removed.includes(n)),
    'A-8 document 形态确实删掉 shell 三件（旧病根：判 document ⇒ 编译/提交/查库全不可用）', `removed=${docFace.removed.join(',')}`);
  eq(docFace.kept.sort(), ['read_file', 'write_file'], 'A-9 document 形态保留读写两件');
}

/* ── B：任务自有文件账 + 提交闸 ───────────────────────────────────────────── */

function groupB(): void {
  const db = initDatabase(path.join(tmpdir, 'ledger'));
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='wa_task_files'").get() as { name?: string } | undefined;
  ok(table?.name === 'wa_task_files', 'B-1 生产 initDatabase 建出 wa_task_files（不靠夹具自建 DDL）');

  const f1 = path.join(tmpdir, 'repo', 'src', 'a.ts');
  recordTaskFile(db, 'T1', f1, 'write_file');
  recordTaskFile(db, 'T1', path.join(tmpdir, 'repo', 'src', '.', 'a.ts'), 'edit_file');
  const owned = ownedPaths(db, 'T1');
  eq(owned, [path.resolve(f1)], 'B-2 同路径两次写入 ⇒ 账上 1 条（幂等 upsert，`/a/./b` 归一）');
  const via = (db.prepare('SELECT via FROM wa_task_files WHERE task_id = ?').get('T1') as { via: string }).via;
  eq(via, 'edit_file', 'B-3 同路径再写会刷新来源（via=最后写入者）');

  db.prepare("INSERT INTO wa_deliverables (id, task_id, name, type, status, file_path) VALUES ('D1','T1','报告','doc','completed',?)")
    .run(path.join(tmpdir, 'repo', 'docs', 'report.md'));
  eq(ownedPaths(db, 'T1').length, 2, 'B-4 自有路径 = 账 ∪ 交付物（子进程落盘后人工登记的文件也认）');

  eq(porcelainPaths(' M apps/x.ts'), ['apps/x.ts'], 'B-5 porcelain 普通行取路径');
  eq(porcelainPaths('R  old/name.ts -> new/name.ts'), ['old/name.ts', 'new/name.ts'], 'B-6 porcelain 重命名取两端');
  eq(porcelainPaths('?? "docs/带 空格.md"'), ['docs/带 空格.md'], 'B-7 porcelain 引号路径去引号');

  const repoRoot = path.join(tmpdir, 'repo');
  const ownedAbs = [path.join(repoRoot, 'src', 'a.ts')];
  const otherDirty = [{ root: repoRoot, lines: [' M apps/other.ts'] }];
  const ownDirty = [{ root: repoRoot, lines: [' M src/a.ts', ' M apps/other.ts'] }];

  eq(gitGateVerdict({ mentionsGit: true, hasShell: false, owned: ownedAbs, dirt: ownDirty }).mode, 'warn',
    'B-8 无 shell + 本任务脏 ⇒ WARN（拦也没用，硬拦即死锁：真标本 094a8b47）');
  eq(gitGateVerdict({ mentionsGit: true, hasShell: true, owned: [], dirt: ownDirty }).mode, 'warn',
    'B-9 有 shell 但一无所知 ⇒ WARN（"无法归属"不能说成"你脏了"）');
  const passOther = gitGateVerdict({ mentionsGit: true, hasShell: true, owned: ownedAbs, dirt: otherDirty });
  eq(passOther.mode, 'pass', 'B-10 只有**他人**改动 ⇒ 放行（多任务共写一树不再是死锁）');
  const blocked = gitGateVerdict({ mentionsGit: true, hasShell: true, owned: ownedAbs, dirt: ownDirty });
  eq(blocked.mode, 'block', 'B-11 本任务自有文件未提交 ⇒ 拦');
  eq(blocked.ownedDirty, [path.resolve(repoRoot, 'src/a.ts')], 'B-12 拦只点**自己的**路径，不拿他人改动说事');
  eq(gitGateVerdict({ mentionsGit: false, hasShell: true, owned: ownedAbs, dirt: ownDirty }).mode, 'pass',
    'B-13 题面未要求提交 ⇒ 放行');
  db.close();
}

/* ── C：撞顶续额自动续跑判据 ─────────────────────────────────────────────── */

function groupC(): void {
  const due = shouldAutoResumeOnStepCap({ step_cap_grants: 1, step_cap_hit: { resume_bonus: 86 } });
  eq([due.due, due.limit], [true, STEP_CAP_GRANT_LIMIT], 'C-1 引擎发了续额且未续跑过 ⇒ due');
  eq(shouldAutoResumeOnStepCap({}).due, false, 'C-2 无撞顶账 ⇒ 不拉起（绝不把普通暂停偷偷拉起）');
  eq(shouldAutoResumeOnStepCap({ step_cap_hit: { resume_bonus: 0 } }).due, false, 'C-3 续额用尽（未发新额度）⇒ 不拉起');
  eq(shouldAutoResumeOnStepCap({ step_cap_hit: { resume_bonus: 86, auto_resumed: 'x' } }).due, false,
    'C-4 同一笔续额已自动续跑过 ⇒ 不重复拉起');
  eq(shouldAutoResumeOnStepCap({ step_cap_grants: STEP_CAP_GRANT_LIMIT + 1, step_cap_hit: { resume_bonus: 86 } }).due, false,
    'C-5 续额次数超上限 ⇒ 不拉起（有界是硬约束）');
  ok(shouldAutoResumeOnStepCap({ step_cap_grants: 1, step_cap_hit: { resume_bonus: 86 } }).reason.includes('86'),
    'C-6 判词如实写出续额步数（用户看得到"发了多少"）');
}

/* ── D：子任务暂停 ⇒ 父任务被唤醒并如实分列 ───────────────────────────────── */

const D_SCHEMA = `
CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT 'p', title TEXT DEFAULT '',
  description TEXT DEFAULT '', status TEXT DEFAULT 'pending', parent_task_id TEXT DEFAULT '',
  depends_on TEXT DEFAULT '', context_json TEXT DEFAULT '{}', priority INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT NOT NULL,
  content TEXT DEFAULT '', tool_calls TEXT, token_count INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, task_id TEXT, name TEXT, type TEXT DEFAULT 'doc',
  status TEXT DEFAULT 'draft', file_path TEXT, description TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_jobs (id TEXT PRIMARY KEY, type TEXT NOT NULL, payload TEXT DEFAULT '{}',
  status TEXT DEFAULT 'pending', created_at TEXT DEFAULT (datetime('now')));
`;
type AnyDb = import('better-sqlite3').Database;
const mkdb = (): AnyDb => {
  const d = new DatabaseSync(':memory:');
  d.exec(D_SCHEMA);
  return d as unknown as AnyDb;
};
const addTask = (db: AnyDb, id: string, status: string, parent = '', ctx: Record<string, unknown> = {}): void => {
  db.prepare('INSERT INTO wa_tasks (id, title, status, parent_task_id, context_json) VALUES (?, ?, ?, ?, ?)')
    .run(id, `任务${id}`, status, parent, JSON.stringify(ctx));
};
const statusOf = (db: AnyDb, id: string): string =>
  (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status: string }).status;

function groupD(): void {
  // D-1 正样本：子暂停 + 父等子 ⇒ 父被唤醒，消息如实写"暂停·原因"，不冒充"全部完成"。
  {
    const db = mkdb();
    addTask(db, 'P', 'paused', '', { pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE });
    addTask(db, 'C', 'paused', 'P', { pause_reason: PAUSE_REASON_ACCEPTANCE_FAILED, completion_summary: '端点已建，验收未过' });
    const jobs: Array<{ type: string; payload: Record<string, unknown> }> = [];
    checkParentTaskAfterChildDone(db, 'C', { enqueue: (type, payload) => { jobs.push({ type, payload }); return Promise.resolve(''); } });
    const msg = String(jobs[0]?.payload.message ?? '');
    eq([statusOf(db, 'P'), jobs.length, jobs[0]?.type], ['pending', 1, 'resume-ai-task'], 'D-1 子暂停 ⇒ 父 paused→pending 且入队 1 笔');
    ok(msg.includes('暂停·验收未通过') && msg.includes('端点已建'), 'D-2 唤醒消息逐子分列「暂停·原因」与完成摘要（不再冒充"全部完成"）', msg.slice(0, 120));
    ok(!msg.includes('所有子任务已完成'), 'D-3 含暂停时**不说**"所有子任务已完成"（名实相符）');

    // D-4 反样本：还有兄弟在跑 ⇒ 父一动不动。
    const db2 = mkdb();
    addTask(db2, 'P2', 'paused', '', { pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE });
    addTask(db2, 'C2', 'paused', 'P2', { pause_reason: PAUSE_REASON_ACCEPTANCE_FAILED });
    addTask(db2, 'S2', 'executing', 'P2');
    const jobs2: unknown[] = [];
    checkParentTaskAfterChildDone(db2, 'C2', { enqueue: (type, payload) => { jobs2.push({ type, payload }); return Promise.resolve(''); } });
    eq([statusOf(db2, 'P2'), jobs2.length], ['paused', 0], 'D-4 还有兄弟在跑 ⇒ 父仍 paused、0 笔入队');
  }

  // D-5 去重：同一笔暂停只唤醒一次（父醒来未处置，不得无限唤醒）。
  {
    const db = mkdb();
    addTask(db, 'P', 'paused', '', { pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE });
    addTask(db, 'C', 'paused', 'P', { pause_reason: PAUSE_REASON_ACCEPTANCE_FAILED });
    const jobs: unknown[] = [];
    const enq = (type: string, payload: Record<string, unknown>) => { jobs.push({ type, payload }); return Promise.resolve(''); };
    checkParentTaskAfterChildDone(db, 'C', { enqueue: enq });
    db.prepare("UPDATE wa_tasks SET status = 'paused' WHERE id = 'P'").run(); // 模拟父又暂停
    checkParentTaskAfterChildDone(db, 'C', { enqueue: enq });
    eq(jobs.length, 1, 'D-5 同一笔暂停第二次调用 ⇒ 0 新增（parent_wake_at 去重，防自点火环）');
    const cctx = JSON.parse((db.prepare("SELECT context_json FROM wa_tasks WHERE id = 'C'").get() as { context_json: string }).context_json) as { parent_wake_at?: string };
    ok(typeof cctx.parent_wake_at === 'string' && cctx.parent_wake_at.length > 0, 'D-6 去重标记真落库（不是内存态）');
  }

  // D-7 等子暂停自查：子已全停 ⇒ 父立刻自行复核；子还在跑 ⇒ 不动。
  {
    const db = mkdb();
    addTask(db, 'P', 'paused', '', { pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE });
    addTask(db, 'C', 'paused', 'P', { pause_reason: PAUSE_REASON_ACCEPTANCE_FAILED });
    const jobs: Array<{ type: string; payload: Record<string, unknown> }> = [];
    setJobEnqueuer((type, payload) => { jobs.push({ type, payload }); return Promise.resolve(''); });
    try { reevaluateSelfWhenWaitingOnChildren(db, 'P'); } finally { setJobEnqueuer(null); }
    eq([statusOf(db, 'P'), jobs.length], ['pending', 1], 'D-7 父等子暂停且子已全停 ⇒ 自行复核（走生产 enqueueJob 真源）');

    const db2 = mkdb();
    addTask(db2, 'P2', 'paused', '', { pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE });
    addTask(db2, 'C2', 'paused', 'P2', { pause_reason: PAUSE_REASON_ACCEPTANCE_FAILED });
    addTask(db2, 'S2', 'executing', 'P2');
    const jobs2: unknown[] = [];
    setJobEnqueuer((type, payload) => { jobs2.push({ type, payload }); return Promise.resolve(''); });
    try { reevaluateSelfWhenWaitingOnChildren(db2, 'P2'); } finally { setJobEnqueuer(null); }
    eq([statusOf(db2, 'P2'), jobs2.length], ['paused', 0], 'D-8 子还有在跑的 ⇒ 自查不动（等它们各自到站）');
  }

  // D-9 哪些暂停算"定局"：用户停/等答复不算。
  eq([pauseSettlesParent(PAUSE_REASON_ACCEPTANCE_FAILED), pauseSettlesParent(PAUSE_REASON_CHILDREN_INCOMPLETE),
    pauseSettlesParent(PAUSE_REASON_USER_INTERRUPT), pauseSettlesParent(PAUSE_REASON_AWAITING_INPUT), pauseSettlesParent('')],
  [true, false, false, false, false], 'D-9 定局判据两侧齐备（验收未过算、等子/用户停/等答复/无因不算）');
}

/* ── E：只读仓库证据（判卷器拿到的不是模型自述） ─────────────────────────────── */

async function groupE(): Promise<void> {
  const db = initDatabase(path.join(tmpdir, 'evidence'));
  eq(await renderOwnedRepoEvidence(db, 'NOFILE'), '', 'E-1 无自有文件 ⇒ 空串（不编假证据）');

  const repo = path.join(tmpdir, 'gitrepo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  const f = path.join(repo, 'src', 'x.ts');
  fs.writeFileSync(f, 'export const x = 1;\n', 'utf-8');
  recordTaskFile(db, 'T9', f, 'write_file');
  const ev = await renderOwnedRepoEvidence(db, 'T9');
  ok(ev.includes('git status') && ev.includes('src/x.ts'), 'E-2 证据含 `git status` 与实际自有文件名', ev.slice(0, 120).replace(/\n/g, ' '));
  ok(ev.includes('??'), 'E-3 未跟踪文件如实显示（引擎真跑 git，不是模型自报）');
  db.close();
}

async function main(): Promise<void> {
  console.log('\n=== zx_20261022_3 b12 A archetype 护栏 ===');
  groupA();
  console.log('\n=== zx_20261022_3 b12 B 自有文件账与提交闸 ===');
  groupB();
  console.log('\n=== zx_20261022_3 b12 C 撞顶续额自动续跑 ===');
  groupC();
  console.log('\n=== zx_20261022_3 b12 D 子暂停⇒父唤醒 ===');
  groupD();
  console.log('\n=== zx_20261022_3 b12 E 只读仓库证据 ===');
  await groupE();

  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

main().then(() => {
  try { fs.rmSync(tmpdir, { recursive: true, force: true }); } catch { /* best-effort */ }
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} rr_zx_20261022_3_b12: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error('套件异常：', e);
  console.log(`\nFAIL rr_zx_20261022_3_b12: ${pass} 通过 / ${fail + 1} 失败\n`);
  process.exit(1);
});
