/**
 * zx_20261028_2 受控复跑 —— 怡寿里「初始化数据库脚本问题修复」标本的四条病灶。
 *
 * 轮次方案：`plans/improve/zx_20261028_2.md`（基线固证见 §1，实施见 §2）。
 *
 * 本套件钉的是**行为**，不是文案：
 *   A（M1）世界快照移出 `context_json`：落侧表 → ctx 只留引用；按引用取回整份；终态回收只动内联件；
 *          引用断了就说"没做判定"；侧表不可用时**退回内联**（行为同改造前）。
 *   B（M2）`task:list` 不再搬 `context_json`：从生产源码**取出那条 SELECT 真跑**，返回体无整份 ctx、
 *          摘录键逐值对得上、50KB 内联大件不再随列表过 IPC。
 *   C（M3）内容校验成批有界并发 + 12s 上限 + 三态如实：并发实测、超时/不可用两种"未核"、
 *          证据面渲染不再把"没问出来"写成"充分"。
 *   D（M4）模板匹配加闸 + 子任务如实记账：真跑 `decideTemplateMatch`（修复意图 vs 反证）、
 *          语义门槛边界两侧、0 完成 + 归档 → `[WARN]`、开关的 GUI 读写口。
 *
 * 纪律：
 *   - 夹具按**生产 DDL** 建表（自建 DDL 不跑 `initDatabase`，列漏一列就是响亮失败，不是静默假绿）。
 *   - 不写"只为下一轮为真"的字面量：阈值/超时/并发数一律引生产常量或从源码计数。
 *   - build 钉走 `checkBuildPins`（P1–P6），本文件不手写轮次值。
 *   - 断言文案不含失败字形（`rr:all` 汇总器按字形计数）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins } from './lib/rr-pins.js';
import {
  persistWorldSnapshot, loadWorldSnapshot, pruneTerminalInlineSnapshots, auditWorldConsistency,
} from '../apps/worker-ant-desktop/src/main/core/world-snapshot.js';
import {
  validateOutputs, LLM_VALIDATION_TIMEOUT_MS, VALIDATION_CONCURRENCY,
} from '../apps/worker-ant-desktop/src/main/core/output-validator.js';
import {
  decideTemplateMatch, matchTemplateSemantic, TASK_TEMPLATES, loadTemplatePool,
  TEMPLATE_SEMANTIC_MIN_SIMILARITY, TEMPLATE_SEMANTIC_TEXT_MAX,
} from '../apps/worker-ant-desktop/src/main/core/task-templates.js';
import { classifyChildCompletion, childCompletionCheckLabel } from '../apps/worker-ant-desktop/src/main/core/task-accounting.js';
import { collectEvidence } from '../apps/worker-ant-desktop/src/main/core/exec-evidence.js';
import { BOOL_SETTING_KEYS } from '../apps/worker-ant-desktop/src/main/core/settings-bool.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(a: unknown, b: unknown, label: string): void {
  ok(JSON.stringify(a) === JSON.stringify(b), label, `实测 ${JSON.stringify(a)}`);
}

const root = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const RENDERER = path.join(root, `${A}/renderer/src`);

/** 行保持式去注释（与 rr-pins 同一手法：注释里的字面量不算判据） */
function stripComments(src: string): string {
  return src.split('\n').map((line) => {
    const i = line.indexOf('//');
    return i >= 0 ? line.slice(0, i) : line;
  }).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
}
const readSrc = (rel: string): string => fs.readFileSync(path.join(root, rel), 'utf-8');

// ── 夹具：生产 DDL（database.ts 的 wa_world_snapshots 原样；其余为被测语句触及的列）──
function makeDb(opts: { sideTable?: boolean } = {}): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_tasks (
      id TEXT PRIMARY KEY, project_id TEXT, title TEXT, description TEXT, status TEXT,
      priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
      source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '', aggregate_version INTEGER DEFAULT 0,
      quality_score REAL, context_json TEXT, created_at TEXT, updated_at TEXT
    );
    CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT, working_dir TEXT DEFAULT '');
    CREATE TABLE wa_deliverables (
      id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, name TEXT, type TEXT, status TEXT,
      file_path TEXT, is_primary INTEGER DEFAULT 0, created_at TEXT
    );
    CREATE TABLE wa_task_conversations (
      id TEXT PRIMARY KEY, task_id TEXT, role TEXT, content TEXT, created_at TEXT
    );
    CREATE TABLE wa_task_templates (
      id TEXT PRIMARY KEY, name TEXT, category TEXT, description TEXT, subtasks TEXT, keywords TEXT,
      status TEXT, priority INTEGER, source TEXT, match_count INTEGER, created_at TEXT, updated_at TEXT
    );
  `);
  if (opts.sideTable !== false) {
    // 生产 DDL 逐字（database.ts:204–213）
    db.exec(`CREATE TABLE wa_world_snapshots (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      file_count INTEGER NOT NULL DEFAULT 0,
      truncated INTEGER NOT NULL DEFAULT 0,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_wa_world_snapshots_task ON wa_world_snapshots(task_id, kind);`);
  }
  return db;
}

const SAMPLE_SNAP = {
  timestamp: '2026-10-28T02:00:00.000Z',
  fileCount: 3,
  truncated: false,
  fileHashes: ['/a/x.ts:10', '/a/y.md:20', '/b/z.py:30'],
  taskStates: ['t1:running'],
  deliverableStates: ['d1:completed'],
};

async function main(): Promise<void> {
// ═════════════════════════════════════════════════════════════════════════
console.log('\n【A】M1：世界快照走侧表，ctx 只留引用');

{
  const db = makeDb();
  db.prepare("INSERT INTO wa_tasks (id, context_json) VALUES ('t1', '{}')").run();
  const ref = persistWorldSnapshot(db as never, 't1', 'before', SAMPLE_SNAP) as unknown as {
    ref: string; timestamp: string; fileCount: number; truncated: boolean;
  } | null;
  ok(!!ref && typeof ref.ref === 'string' && ref.ref.length > 0, 'A-1 落侧表返回引用（侧表不可用时会返回 null 并退回内联，见 A-5）');
  eq(ref ? Object.keys(ref).sort() : [], ['fileCount', 'ref', 'timestamp', 'truncated'], 'A-1b 引用只含四个摘要字段（快照原文不在引用里）');
  ok(ref ? JSON.stringify(ref).length < 400 : false, 'A-1c 引用体量有界（ctx 不再被百 KB 快照撑大）', ref ? `${JSON.stringify(ref).length} B` : '(无引用)');
  const back = loadWorldSnapshot(db as never, ref!.ref) as Record<string, unknown> | null;
  ok(!!back && JSON.stringify(back.fileHashes) === JSON.stringify(SAMPLE_SNAP.fileHashes),
    'A-1d 按引用取回整份（fileHashes 逐条相同）');
  ok(!!back && JSON.stringify(back.taskStates) === JSON.stringify(SAMPLE_SNAP.taskStates)
    && JSON.stringify(back.deliverableStates) === JSON.stringify(SAMPLE_SNAP.deliverableStates),
    'A-1e 任务态/成果态也原样取回（不是只剩文件名）');
  ok(loadWorldSnapshot(db as never, 'no-such-ref') === null, 'A-1f 取不到引用如实返回 null（不编空快照）');

  for (let i = 1; i <= 5; i++) {
    persistWorldSnapshot(db as never, 't1', 'after', { ...SAMPLE_SNAP, timestamp: `2026-10-28T02:00:0${i}Z` });
  }
  const rows = db.prepare("SELECT captured_at FROM wa_world_snapshots WHERE task_id = 't1' ORDER BY captured_at").all() as Array<{ captured_at: string }>;
  eq(rows.length, 4, 'A-2 同一任务写入 5 条后侧表只留 4 条（有界，不无限长）');
  ok(!rows.some((r) => r.captured_at === '2026-10-28T02:00:01Z'), 'A-2b 删的是最旧那条（保留最新 4 条）', rows.map((r) => r.captured_at.slice(-4)).join(','));
}

{
  const db = makeDb();
  const inline = JSON.stringify({ fileHashes: ['/a:1'], fileCount: 1, truncated: false, taskStates: [], deliverableStates: [] });
  const put = (id: string, status: string, ctx: Record<string, unknown>) =>
    db.prepare('INSERT INTO wa_tasks (id, status, context_json) VALUES (?, ?, ?)').run(id, status, JSON.stringify(ctx));
  put('done', 'completed', { world_snapshot_before: JSON.parse(inline), world_snapshot_after: JSON.parse(inline), finalize_checks: ['[PASS] 保留我'], other: 1 });
  put('failed', 'failed', { world_snapshot_before: { ref: 'r-keep', timestamp: 'x', fileCount: 1, truncated: false } });
  put('running', 'running', { world_snapshot_before: JSON.parse(inline) });
  const r = pruneTerminalInlineSnapshots(db as never);
  ok(r.tasks === 1, 'A-3 终态回收恰动 1 个任务（只清带内联原文的终态行）', `tasks=${r.tasks} bytes=${r.bytes}`);
  const done = JSON.parse((db.prepare("SELECT context_json FROM wa_tasks WHERE id='done'").get() as { context_json: string }).context_json) as Record<string, unknown>;
  ok(!('world_snapshot_before' in done) && !('world_snapshot_after' in done), 'A-3b 内联前后快照两键都已摘除');
  eq(done.finalize_checks, ['[PASS] 保留我'], 'A-3c 同行的 finalize_checks 原样保留（回收不是整段覆盖）');
  eq(done.other, 1, 'A-3d 其它兄弟键也不动');
  const failed = JSON.parse((db.prepare("SELECT context_json FROM wa_tasks WHERE id='failed'").get() as { context_json: string }).context_json) as Record<string, unknown>;
  ok(!!(failed.world_snapshot_before as { ref?: string })?.ref, 'A-3e 已是引用形的终态行不再动（引用是审计成对凭证，只有几十字节）');
  const running = JSON.parse((db.prepare("SELECT context_json FROM wa_tasks WHERE id='running'").get() as { context_json: string }).context_json) as Record<string, unknown>;
  ok(Array.isArray((running.world_snapshot_before as { fileHashes?: unknown })?.fileHashes), 'A-3f 运行中任务的快照不动（审计还要用）');
}

{
  const db = makeDb();
  db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p1', 'P', '')").run();
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES ('t1', 'p1', 'T', 'running', ?)")
    .run(JSON.stringify({ world_snapshot_before: { ref: 'gone', timestamp: 'x', fileCount: 0, truncated: false } }));
  const convs: string[] = [];
  await auditWorldConsistency(db as never, 't1', 'p1', (_t, _r, c) => { convs.push(c); });
  const ctx = JSON.parse((db.prepare("SELECT context_json FROM wa_tasks WHERE id='t1'").get() as { context_json: string }).context_json) as { finalize_checks?: string[] };
  ok((ctx.finalize_checks || []).includes('[INFO] 世界模型审计：执行前快照不可读，未做增删判定'),
    'A-4 引用断了 ⇒ 如实说"未做判定"（不拿空快照去比，否则全库文件都成"新增"）');
  eq(convs.length, 0, 'A-4b 且不往会话流里灌一条"发现了不一致"的假告警');
}

{
  // 侧表缺位（夹具自建 DDL 未建该表 / 迁移未跑）⇒ 退回内联，行为与改造前一致，且可见（logger.warn）
  const db = makeDb({ sideTable: false });
  db.prepare("INSERT INTO wa_projects (id, name, working_dir) VALUES ('p1', 'P', '')").run();
  const before = { fileHashes: [], fileCount: 0, truncated: false, taskStates: ['t1:running'], deliverableStates: [] };
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, status, context_json) VALUES ('t1', 'p1', 'T', 'running', ?)")
    .run(JSON.stringify({ world_snapshot_before: before }));
  ok(persistWorldSnapshot(db as never, 't1', 'after', SAMPLE_SNAP) === null, 'A-5 侧表不可用 ⇒ 落表返回 null（不静默丢、由调用方退回内联）');
  await auditWorldConsistency(db as never, 't1', 'p1', () => {});
  const ctx = JSON.parse((db.prepare("SELECT context_json FROM wa_tasks WHERE id='t1'").get() as { context_json: string }).context_json) as { world_snapshot_after?: { fileHashes?: unknown; ref?: unknown } };
  ok(Array.isArray(ctx.world_snapshot_after?.fileHashes) && ctx.world_snapshot_after?.ref === undefined,
    'A-5b 退回内联：after 仍以原文落 ctx（与改造前逐字节同形，不是丢快照）');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【B】M2：task:list 不搬整份 context_json');

{
  const ipcSrc = readSrc('apps/worker-ant-desktop/src/main/ipc/project.ipc.ts');
  const m = ipcSrc.match(/const rows = db\.prepare\(`(SELECT t\.id,[\s\S]*?)`\)\.all\(projectId, \.\.\.page\.params\)/);
  ok(!!m, 'B-1 从生产源码取出 task:list 的 SELECT（取不到则下面无从谈起，先自证扫描面）');
  const sql = (m?.[1] || '').replace('${page.sql}', '');
  ok(sql.length > 500, 'B-1b 取到的确为完整语句（不是片段）', `${sql.length} 字符`);
  ok(!/\bt\.\*/.test(sql), 'B-1c 不再 `SELECT t.*`（整行口径已拆）');
  ok(!/^\s*t\.context_json\s*,/m.test(sql) && /json_object\(/.test(sql) && /AS context_digest/.test(sql),
    'B-1d 上下文只以 `context_digest`（json_object 摘录）过 IPC，整份 ctx 不在选择列');
  ok(!/workflow_config/.test(sql), 'B-1e 同一句里也不再带 `workflow_config`（列表从不读它）');

  const db = makeDb();
  const bigCtx = {
    dynamic_priority: 7, completion_quality: { score: 88, goal_achieved: true }, tokens_used: 1234,
    budget_max_tokens: 50000, strategy_source: 'template', bottleneck_score: 3,
    reason: 'abandoned_by_user', awaiting_input: true, pending_approval: false, pause_reason: 'waiting',
    verification_fix: true, verification_fix_of: 'task-origin',
    attachments: ['/x/y.md'],
    world_snapshot_before: { fileHashes: Array.from({ length: 1200 }, (_, i) => `/big/f${i}.ts:${i}`) },
  };
  db.prepare(`INSERT INTO wa_tasks (id, project_id, title, description, status, priority, context_json, created_at, updated_at)
    VALUES ('t1', 'p1', 'T', 'D', 'paused', 0, ?, '2026-10-28T02:00:00Z', '2026-10-28T02:00:00Z')`).run(JSON.stringify(bigCtx));
  ok(JSON.stringify(bigCtx).length > 20_000, 'B-2 标本上下文足够大（内联快照 800 条），差异可辨', `${JSON.stringify(bigCtx).length} B`);
  const row = db.prepare(sql).get('p1') as Record<string, unknown> | undefined;
  ok(!!row, 'B-2b 该语句在**生产形状**夹具上真跑通（不是只读字符串）');
  ok(!!row && !('context_json' in row), 'B-2c 返回体无 `context_json` 键（正面断言——列表不再背整份 ctx）');
  ok(!!row && !('workflow_config' in row), 'B-2d 返回体也无 `workflow_config`');
  let digest: Record<string, unknown> = {};
  try { digest = JSON.parse(String(row?.context_digest || '{}')) as Record<string, unknown>; } catch { /* 下面判 */ }
  eq(Object.keys(digest).sort(), ['awaiting_input', 'bottleneck_score', 'budget_max_tokens', 'completion_quality',
    'dynamic_priority', 'pause_reason', 'pending_approval', 'reason', 'strategy_source', 'tokens_used',
    'verification_fix', 'verification_fix_of'],
  'B-2e 摘录恰含渲染层实际用到的 12 个键（逐项枚举，不用总数冒充）');
  eq([digest.dynamic_priority, digest.tokens_used, digest.reason, digest.awaiting_input], [7, 1234, 'abandoned_by_user', 1],
    'B-2f 摘录逐值与 ctx 一致（缩放/类型不是另说一套）');
  eq([digest.verification_fix, digest.verification_fix_of], [1, 'task-origin'],
    'B-2f2 自动派生两键随摘录过 IPC（json_extract 布尔收为 1，渲染层按真值判）');
  ok(typeof digest.completion_quality === 'object' && (digest.completion_quality as { score?: number })?.score === 88,
    'B-2g 对象型键（completion_quality）仍以对象取回（json_extract 的 JSON 文本被展开）');
  ok(String(row?.context_digest).length < 2_000, 'B-2h 摘录体量有界（大 ctx 不再随列表过 IPC）', `${String(row?.context_digest).length} B`);

  const tasksPage = stripComments(fs.readFileSync(path.join(RENDERER, 'pages/TasksPage.tsx'), 'utf-8'));
  ok(!/context_json/.test(tasksPage) && (tasksPage.match(/context_digest/g) || []).length >= 3,
    'B-3 列表页所有读点改读 `context_digest`，`context_json` 零残留（按出现次数报扫描面）',
    `digest ${(tasksPage.match(/context_digest/g) || []).length} 处 / ctx ${(tasksPage.match(/context_json/g) || []).length} 处`);
  const detailPage = stripComments(fs.readFileSync(path.join(RENDERER, 'pages/TaskDetailPage.tsx'), 'utf-8'));
  ok(/taskData\.task\.context_json/.test(detailPage) && /context_digest/.test(detailPage),
    'B-3b 详情页仍走 `task:get` 的整份 `context_json`（两形并存是刻意的：列表瘦身不等于详情丢上下文）');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【C】M3：内容校验成批、有界、三态如实');

{
  const src = stripComments(readSrc('apps/worker-ant-desktop/src/main/core/output-validator.ts'));
  ok(!/30_000/.test(src), 'C-1 旧 30s 上限零命中（判据里不再残留旧值）');
  ok((src.match(/LLM_VALIDATION_TIMEOUT_MS\s*=\s*12_000/g) || []).length === 1
    && (src.match(/AbortSignal\.timeout\(LLM_VALIDATION_TIMEOUT_MS\)/g) || []).length === 1,
    'C-1b 超时上限一处真源且被真正喂给 `AbortSignal`（不是只声明不使用）');
  ok((src.match(/VALIDATION_CONCURRENCY\s*=\s*3/g) || []).length === 1
    && /Math\.min\(VALIDATION_CONCURRENCY, targets\.length\)/.test(src),
    'C-1c 并发上限一处真源且池宽由它派生（不另写一个数字）');
  const fin = stripComments(readSrc('apps/worker-ant-desktop/src/main/core/tools/control-finalize.ts'));
  const exe = stripComments(readSrc('apps/worker-ant-desktop/src/main/core/exec-close.ts'));
  ok(/validateOutputs\(ansClient as never, targets\)/.test(fin) && !/validateOutput\(ansClient as never, abs/.test(fin),
    'C-1d 收口门只剩批量调用一处（逐文件直呼零残留）');
  ok(/validateOutputs\(ansClient as never, missTargets\)/.test(exe) && !/validateOutput\(ansClient as never, abs/.test(exe),
    'C-1e 执行侧收口同样走批量（缓存命中在循环内、未命中的成批问一次）');
  ok(/\[INFO\] 内容充分性未核/.test(fin), 'C-1f finalize 对"未核"追加 [INFO]（不阻断，但看得见）');
}

function tmpDoc(bits: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rrws2-'));
  const file = path.join(dir, `${bits}.md`);
  fs.writeFileSync(file, `# 测试文档 ${bits}\n\n${'内容'.repeat(400)}\n\n结论：一切正常。\n`, 'utf-8');
  return file;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

{
  const targets = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'].map((b) => ({ file: tmpDoc(b), archetype: 'document' }));
  // 假 ansClient：每问到"选模型"就阻塞 250ms 再挂 ⇒ 单份 ≈250ms；串行 6 份 ≈1500ms，并发 3 摊 ≈500ms。
  const fake = { getOptimalModel: async () => { await sleep(250); throw new Error('rr-fake-unavailable'); } };
  const t0 = Date.now();
  const one = await validateOutputs(fake as never, targets.slice(0, 1));
  const tOne = Date.now() - t0;
  const t1 = Date.now();
  const six = await validateOutputs(fake as never, targets);
  const tSix = Date.now() - t1;
  ok(one.length === 1 && one[0]!.status === 'unknown', 'C-2 单份：辅助模型不可用 ⇒ `unknown`（不是"充分"）', `status=${one[0]?.status}`);
  ok(six.length === targets.length && six.every((r) => r.status === 'unknown'),
    'C-2b 六份：各自独立降级为 `unknown`，一条失败不拖累其它条');
  eq(six.map((r) => r.file), targets.map((t) => t.file), 'C-2c 结果按输入序返回（调用方落账次序不变）');
  ok(tSix < tOne * 4, `C-2d 成批有界并发：六份总耗时显著低于串行（单份 ${tOne}ms / 六份 ${tSix}ms，串行应 ≈${tOne * 6}ms）`,
    `并发上限 ${VALIDATION_CONCURRENCY}`);
}

{
  const file = tmpDoc('timeout');
  const fakeTimeout = {
    getOptimalModel: async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; },
  };
  const r = (await validateOutputs(fakeTimeout as never, [{ file, archetype: 'document' }]))[0]!;
  const secs = Math.round(LLM_VALIDATION_TIMEOUT_MS / 1000);
  ok(r.status === 'unknown' && String(r.reason).includes(`${secs}s 内无结论`),
    'C-3 超时与"不可用"分开说：未核原因写明等待上限（由生产常量派生，不手抄秒数）', String(r.reason));

  const fakeDown = { getOptimalModel: async () => { throw new Error('down'); } };
  const r2 = (await validateOutputs(fakeDown as never, [{ file, archetype: 'document' }]))[0]!;
  ok(r2.status === 'unknown' && !String(r2.reason).includes('超时'),
    'C-3b 无可用模型 ⇒ 另一种原因（不把所有"未核"都说成超时）', String(r2.reason));
}

{
  // 证据面三态：`unknown` 此前按 `sufficient` 渲染成「充分」——没问出来被写成问过了且合格。
  const db = makeDb();
  const ov = [
    { file: '/ok.md', status: 'ok', sufficient: true },
    { file: '/bad.md', status: 'insufficient', sufficient: false, reason: '缺少结论' },
    { file: '/unk.md', status: 'unknown', sufficient: true, reason: `辅助模型 ${Math.round(LLM_VALIDATION_TIMEOUT_MS / 1000)}s 内无结论（超时）` },
  ];
  db.prepare("INSERT INTO wa_tasks (id, project_id, title, description, status, acceptance_criteria, context_json) VALUES ('t1','p1','T','D','running','',?)")
    .run(JSON.stringify({ output_validations: ov }));
  const bundle = collectEvidence(db as never, 't1');
  ok(bundle.validations.includes('- /ok.md: 充分'), 'C-4 证据面：有结论且充分 ⇒「充分」');
  ok(bundle.validations.includes('- /bad.md: 不充分(缺少结论)'), 'C-4b 明确不充分 ⇒ 带原因');
  ok(bundle.validations.includes(`- /unk.md: 未核(辅助模型 ${Math.round(LLM_VALIDATION_TIMEOUT_MS / 1000)}s 内无结论（超时）)`),
    'C-4c 未核 ⇒「未核(原因)」，不再冒充「充分」（`sufficient:true` 是 fail-open 的旧账，不是证据）');
  ok(!/^- \/unk\.md: 充分$/m.test(bundle.validations), 'C-4d 反证：未核那条不会被渲染成"充分"');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【D】M4：模板匹配加闸 + 子任务如实记账');

{
  const db = makeDb();
  for (const t of Object.values(TASK_TEMPLATES)) {
    db.prepare('INSERT INTO wa_task_templates (id, name, category, description, subtasks, keywords, status, priority, source, match_count) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(t.id, t.name, t.category, t.description, JSON.stringify(t.subtasks), JSON.stringify(t.keywords), 'active', t.priority ?? 0, 'system', 0);
  }
  loadTemplatePool(db as never);
  const probe = (title: string, description: string) => decideTemplateMatch(db as never, title, description);

  const repair = probe('初始化数据库脚本问题修复', '初始化脚本执行报错，请定位并修正迁移顺序');
  ok(repair.skip === 'repair_intent', 'D-1 该命中：真库标本「初始化数据库脚本问题修复」⇒ `repair_intent`（只跳过模板拆解）', `skip=${repair.skip}`);
  const build = probe('搭建一个内部管理后台', '');
  ok(build.skip === null, 'D-1b 反证：普通建设意图**不**被修复闸误伤（闸不是恒真）', `skip=${build.skip}`);
  const plan = probe('为项目撰写优化升级方案', '');
  ok(plan.skip === 'planning_intent', 'D-1c 规划意图仍归规划档（修复闸排在规划之前但只认修复词）', `skip=${plan.skip}`);
  const both = probe('数据库迁移脚本修复', '请撰写优化方案');
  ok(both.skip === 'repair_intent', 'D-1d 同时含"修复"与"方案" ⇒ 报修复意图（真相是"先定位再给方案"，报成规划会让用户以为交给 AI 做规划）', `skip=${both.skip}`);
  const explicit = probe('做两件事', '子任务A：修复接口；子任务B：补文档');
  ok(explicit.skip === 'explicit_subtasks', 'D-1e 显式子任务守卫仍最优先（与修复闸分属两态、不混为一谈）', `skip=${explicit.skip}`);

  const longDesc = `识别既有后端接口，形成前端调用规划。${'细节'.repeat(400)}`;
  const semi = probe('前端页面', longDesc);
  ok(semi.semanticText.includes('识别既有后端接口') && semi.semanticText.length <= TEMPLATE_SEMANTIC_TEXT_MAX,
    'D-2 语义兜底文本**标题+描述同取**且有界（旧式 `title || desc` 在标题非空时让描述整段不参与）',
    `${semi.semanticText.length} ≤ ${TEMPLATE_SEMANTIC_TEXT_MAX}`);
  const semi2 = probe('', '部署一个 MCP 服务到测试机');
  ok(semi2.semanticText.startsWith('部署一个'), 'D-2b 标题为空时仍退回描述（同取不改变这条既有行为）');
}

{
  const db = makeDb();
  for (const t of Object.values(TASK_TEMPLATES)) {
    db.prepare('INSERT INTO wa_task_templates (id, name, category, description, subtasks, keywords, status, priority, source, match_count) VALUES (?,?,?,?,?,?,?,?,?,?)')
      .run(t.id, t.name, t.category, t.description, JSON.stringify(t.subtasks), JSON.stringify(t.keywords), 'active', t.priority ?? 0, 'system', 0);
  }
  loadTemplatePool(db as never);
  const someId = Object.keys(TASK_TEMPLATES)[0]!;
  const vec = (s: number) => [s, Math.sqrt(1 - s * s)];
  const hitLo = matchTemplateSemantic([1, 0], new Map([[someId, vec(TEMPLATE_SEMANTIC_MIN_SIMILARITY - 0.01)]]));
  const hitHi = matchTemplateSemantic([1, 0], new Map([[someId, vec(TEMPLATE_SEMANTIC_MIN_SIMILARITY + 0.01)]]));
  ok(hitLo === null, `D-3 阈值下侧：相似度 ${(TEMPLATE_SEMANTIC_MIN_SIMILARITY - 0.01).toFixed(2)} 不命中（门槛没有形同虚设）`, `hit=${hitLo ? hitLo.template.id : 'null'}`);
  ok(hitHi !== null && hitHi.template.id === someId,
    `D-3b 阈值上侧：相似度 ${(TEMPLATE_SEMANTIC_MIN_SIMILARITY + 0.01).toFixed(2)} 命中（直引生产常量，不手抄 0.6）`,
    `hit=${hitHi ? hitHi.template.id : 'null'} sim=${hitHi ? hitHi.similarity.toFixed(3) : '-'}`);
}

{
  const archived = Array.from({ length: 3 }, () => ({ status: 'archived', context_json: '{}' }));
  const c = classifyChildCompletion(archived);
  eq([c.done, c.archived, c.open, c.incomplete], [0, 3, 0, 3], 'D-4 分类：3 归档 ⇒ done=0 / archived=3 / open=0（incomplete 仍为二者之和，旧判据不变）');
  const label = childCompletionCheckLabel(c);
  ok(label.startsWith('[WARN]') && label.includes('无一完成') && label.includes('归档 3 个'),
    'D-4b 无一完成 ⇒ `[WARN]` 并如实分列归档数（旧文案 `[PASS]` 会被读成收口条件已满足）', label);
  const openOnly = classifyChildCompletion([{ status: 'pending', context_json: '{}' }]);
  ok(childCompletionCheckLabel(openOnly).includes('未了结 1 个'), 'D-4c 未启动的未了结者单独计数（与"归档放弃"是两件事）');
  const mixed = classifyChildCompletion([
    { status: 'completed', context_json: '{}' }, { status: 'archived', context_json: '{}' },
    { status: 'failed', context_json: '{}' },
  ]);
  eq(childCompletionCheckLabel(mixed), '[PASS] 共 3 个子任务（完成 1 个、归档/未了结 1 个、失败 1 个）——存在失败子任务，请核验后决定是否补做；归档/未了结者未交付成果，请人工核验',
    'D-4d 既有 done>0 文案**逐字保留**（本轮只新增无一完成那一档；旧断言全部仍成立）');
  eq(childCompletionCheckLabel(classifyChildCompletion([
    { status: 'completed', context_json: '{}' }, { status: 'completed', context_json: '{}' },
  ])), '[PASS] 所有2个子任务已完成', 'D-4e 反证：全真完成仍逐字原样（不因新分支改口）');
}

{
  const page = stripComments(fs.readFileSync(path.join(RENDERER, 'pages/SettingsPage.tsx'), 'utf-8'));
  ok(/boolSetting\(all\['engine\.plan_auto_decompose'\]\)/.test(page)
    && /invoke\('settings:set', 'engine\.plan_auto_decompose'/.test(page)
    && /togglePlanAutoDecompose/.test(page),
    'D-5 开关有**读写两条腿**（此前键只在白名单里、主进程在读，用户点不到——"装好了没人能上电"）');
  ok(BOOL_SETTING_KEYS.includes('engine.plan_auto_decompose'),
    'D-5b 键仍在唯一那份布尔白名单里（判据与名单同源，未另造一份）');
  const templatesIpc = stripComments(fs.readFileSync(path.join(RENDERER, 'lib/ipc.ts'), 'utf-8'));
  ok(/semanticMinSimilarity: number/.test(templatesIpc) && /'repair_intent'/.test(templatesIpc),
    'D-5c 模板试用回传第三态与语义门槛（界面不再手抄阈值，skip 也不会落进 else 被说成"规划"）');
}

// ═════════════════════════════════════════════════════════════════════════
console.log('\n【S】build 钉（派生核对，不写轮次字面量）');
checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，`process.exit` 会在 Node 报告
//   unhandled rejection 之前把进程带走 ⇒ 跑到一半崩掉的复跑会打出一行假绿。
main().then(() => {
  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_zx_20261028_2: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`\nrr_zx_20261028_2 未捕获异常（复跑未跑完，不得读作通过）：`, e);
  fail++;
  console.log(`\nFAIL rr_zx_20261028_2: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
