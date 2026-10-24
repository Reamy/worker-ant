/**
 * zx_20261022_1 受控复跑 —— 「名实」：判据不被转义骗、探针不冒充成果、路径能落地、归属如实说。
 *
 * 分组（与本轮方案 §2 一一对应）：
 *   A 占位符判据见字　B 探针识别数字前缀 + ★ 自愈　C 验收路径落到工作目录
 *   D 自核未达成逐条列出　E 跨任务去重如实回话　F 上轮成果复核（不改码）
 *
 * 纪律（承 CLAUDE.md 与 auto-memory）：
 *   · 直引**生产函数**（被删/改名即编译期失败，不扫空字符串冒充覆盖）。
 *   · 正面/反面两只标本同试；计数器类断言给 0→1 正面值，不以"不抛"代替。
 *   · 夹具按生产初始化顺序与生产列同形（先建表/先 new 服务，再插数据行）。
 *   · 不写"只为下一轮"的字面量：build 轮次由 `checkBuildPins` 从真源派生核对。
 *   · 断言文案不含失败字形（`pnpm rr:all` 汇总器按字形计数）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { ARCHETYPE_VALIDATION, VALIDATION_CRITERIA_VERSION } from '../apps/worker-ant-desktop/src/main/core/output-validator.js';
import { docNotProbe, autoAssignPrimary } from '../apps/worker-ant-desktop/src/main/core/deliverable-lifecycle.js';
import { proposeAcceptanceCriteria } from '../apps/worker-ant-desktop/src/main/core/acceptance-check.js';
import { proposedMissWarning } from '../apps/worker-ant-desktop/src/main/core/tools/control-finalize.js';
import { ensureDocDeliverable } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { rankEvidenceDocFiles, isSupersededDocBody } from '../apps/worker-ant-desktop/src/main/core/exec-evidence.js';
import { writeTools } from '../apps/worker-ant-desktop/src/main/core/tools/write.js';
import { resolveMaxSteps, grantStepBudgetOnCapHit, STEP_CAP_GRANT_LIMIT } from '../apps/worker-ant-desktop/src/main/core/step-budget.js';
import { buildPreludePrompt } from '../apps/worker-ant-desktop/src/main/core/memory-prelude.js';
import { inferSubtaskDeps } from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';

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
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const CODE = (rel: string) => stripKeepingLines(RD(rel)).join('\n');

// node:sqlite 无 better-sqlite3 的 .transaction()——补最小等价 shim（同步执行，无嵌套）
const withTx = (d: DatabaseSync) => {
  (d as unknown as { transaction: unknown }).transaction = (fn: () => void) => () => fn();
  return d;
};
const mkdb = () => {
  const d = withTx(new DatabaseSync(':memory:'));
  d.exec(`
    CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT, name TEXT, description TEXT, file_path TEXT, status TEXT, is_primary INTEGER DEFAULT 0, updated_at TEXT, created_at TEXT);
    CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE wa_event_log (id INTEGER PRIMARY KEY AUTOINCREMENT, event_type TEXT, aggregate_id TEXT, aggregate_type TEXT, payload TEXT, created_at TEXT DEFAULT (datetime('now')));
    CREATE TABLE wa_deliverable_versions (id TEXT PRIMARY KEY, deliverable_id TEXT NOT NULL, file_path TEXT NOT NULL, content_snapshot TEXT, size INTEGER, version INTEGER, changed_by TEXT, created_at TEXT DEFAULT (datetime('now')));
  `);
  return d as unknown as import('better-sqlite3').Database;
};

function walkTs(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkTs(p, out);
    else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

// ───────────────────────── A 占位符判据见字（批一）─────────────────────────
function groupA(): void {
  const doc = ARCHETYPE_VALIDATION.document;
  ok(!!doc, 'A-1 文档档规则在册（直引导出真规则）');
  const rule = doc.forbiddenPatterns.find((p) => p.label === '占位符内容');
  ok(!!rule, 'A-2 「占位符内容」判据在册（按标签定位，不按行号）');
  const pat = rule.pattern;

  const positives = ['正文[待补充]结尾', '这里有 [TODO] 一条', '[WIP] 尚未完成', 'Lorem ipsum dolor', 'lorem IPSUM'];
  positives.forEach((s, i) => ok(pat.test(s), `A-3.${i + 1} 正向命中：${s}`));

  const negatives = ['用正则 \\w+ 匹配标识符', 'class \\w+Controller', 'WIP 讨论（无方括号）', '[完稿]', 'TODO 在正文中讨论'];
  negatives.forEach((s, i) => ok(!pat.test(s), `A-4.${i + 1} 反向不命中：${s}`));

  // 单一真源：注释剥离后，src/main 下**恰一个**文件定义「占位符内容」判据。
  const files = walkTs(path.join(root, A, 'src/main'));
  const hitFiles = files.filter((f) => CODE(path.relative(root, f)).includes('占位符内容'));
  eq(hitFiles.map((f) => path.relative(root, f)), [`${A}/src/main/core/output-validator.ts`],
    'A-5 判据只在一处（其余读点无手抄副本）');

  const src = CODE(`${A}/src/main/core/output-validator.ts`);
  ok(/export const ARCHETYPE_VALIDATION/.test(src), 'A-6 规则表导出（供复跑直引真规则）');
  ok(/VALIDATION_CRITERIA_VERSION: string = \(\(\) =>/.test(src) && /JSON\.stringify\(/.test(src),
    'A-7 版本指纹由判据源派生（改用规则 ⇒ 缓存自动失效）');
  ok(!/VALIDATION_CRITERIA_VERSION\s*=\s*['"][0-9a-f]{8,}['"]/.test(src), 'A-8 反证：未手写版本号常量');
  ok(/^[0-9a-f]{12,}$/i.test(VALIDATION_CRITERIA_VERSION), 'A-9 版本值为派生哈希形态', VALIDATION_CRITERIA_VERSION);
}

// ───────────────────────── B 探针识别数字前缀 + ★ 自愈（批二）─────────────────────────
function groupB(): void {
  const db = mkdb();
  db.exec('CREATE TABLE t (file_path TEXT, name TEXT)');
  const probes = [
    'plans/backend/0_probe.md',
    'plans/backend/00_probe2.md',
    'docs/0_verify.md',
    'docs/0_tmp.md',
    'scripts/_probe_old.py',
    'data/_sandbox/20260918/tmp6.jsonl',
  ];
  const reals = [
    'scripts/verify_push_20260910.py',
    'scripts/attempt_1.py',
    'test_a2026_m1_verify.py',
    '2026_verify_report.md',
    'scripts/check_command_consistency.py',
    'docs/20261021_probe.md',
  ];
  const ins = db.prepare('INSERT INTO t (file_path, name) VALUES (?, ?)');
  for (const p of [...probes, ...reals]) ins.run(p, path.basename(p));
  const rows = db.prepare(`SELECT file_path FROM t WHERE ${docNotProbe('')}`).all() as Array<{ file_path: string }>;
  const survivors = new Set(rows.map((r) => r.file_path));

  probes.forEach((p, i) => ok(!survivors.has(p), `B-1.${i + 1} 探针被排除：${p}`));
  reals.forEach((p, i) => ok(survivors.has(p), `B-2.${i + 1} 真产出保留：${p}`));

  // ★ 自愈：探针行上的 ★ 是无效指派（它会让 priCnt 早退、从此不再重估）。
  const d1 = mkdb();
  d1.prepare("INSERT INTO wa_settings (key, value) VALUES ('deliverable.primary_auto', 'true')").run();
  const insD = d1.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status, is_primary, created_at) VALUES (?, 'p1', ?, 'doc', ?, ?, 'draft', ?, ?)");
  insD.run('probe', 't9', '0_probe', 'plans/0_probe.md', 1, '2026-01-02');
  insD.run('real', 't9', 'real', 'plans/real.md', 0, '2026-01-01');
  const prim = (id: string) => (d1.prepare('SELECT is_primary c FROM wa_deliverables WHERE id = ?').get(id) as { c: number }).c;
  eq([prim('probe'), prim('real')], [1, 0], 'B-3 夹具前置：探针占着 ★、真成果为 0');
  const r1 = autoAssignPrimary(d1, 't9');
  eq(prim('probe'), 0, 'B-4 探针 ★ 被清（无效指派不再永久卡住重估）');
  eq(prim('real'), 1, 'B-5 ★ 0→1：补位到真成果');
  eq(r1.assigned, 'real', 'B-6 回传的指派对象即真成果');

  const d2 = mkdb();
  d2.prepare("INSERT INTO wa_settings (key, value) VALUES ('deliverable.primary_auto', 'true')").run();
  const ins2 = d2.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status, is_primary, created_at) VALUES (?, 'p1', 't10', 'doc', ?, ?, 'draft', ?, ?)");
  ins2.run('keep', 'keep', 'plans/keep.md', 1, '2026-01-01');
  ins2.run('other', 'other', 'plans/other.md', 0, '2026-02-01');
  const prim2 = (id: string) => (d2.prepare('SELECT is_primary c FROM wa_deliverables WHERE id = ?').get(id) as { c: number }).c;
  const r2 = autoAssignPrimary(d2, 't10');
  eq([prim2('keep'), prim2('other')], [1, 0], 'B-7 真成果的 ★ 不被清（反证：自愈只清探针行）');
  ok(r2.assigned === undefined, 'B-8 已有有效 ★ ⇒ 不重复指派');
}

// ───────────────────────── C 验收路径落到工作目录（批三）─────────────────────────
function groupC(): void {
  // ① 在册命中：判据②以既有产出行为证据，不解析字面量
  const c1 = proposeAcceptanceCriteria({
    title: '写方案', description: '将结论写入 plans/a.md',
    deliverables: [{ name: 'a', file_path: 'plans/a.md' }],
    pathExists: (p) => p === 'plans/a.md',
  });
  ok(c1.proposed.includes('产出写入指定路径：plans/a.md'), 'C-1 指定路径判据在册');
  const h1 = c1.checked.find((c) => c.criterion === '产出写入指定路径：plans/a.md');
  ok(h1?.passed === true, 'C-2 在册命中 ⇒ 自核达成');

  // ② 工作目录解析命中：登记行不在本任务名下时，文件真落盘也算
  const c2 = proposeAcceptanceCriteria({
    title: '写方案', description: '将结论写入 docs/b.md',
    deliverables: [],
    pathExists: (p) => p === '/wd/docs/b.md',
    resolveRelative: (p) => (path.isAbsolute(p) ? p : path.join('/wd', p)),
  });
  const h2 = c2.checked.find((c) => c.criterion === '产出写入指定路径：docs/b.md');
  ok(h2?.passed === true, 'C-3 字面量按工作目录解析后命中 ⇒ 自核达成（判据可被合法数据满足）');

  // ③ 两处都不在：如实说"账上没有、盘上也没有"
  const c3 = proposeAcceptanceCriteria({
    title: '写方案', description: '将结论写入 docs/c.md',
    deliverables: [],
    pathExists: () => false,
    resolveRelative: (p) => path.join('/wd', p),
  });
  const h3 = c3.checked.find((c) => c.criterion === '产出写入指定路径：docs/c.md');
  ok(h3?.passed === false && /项目工作目录下不存在该路径：\/wd\/docs\/c\.md/.test(h3?.note ?? ''),
    'C-4 未命中时的注记点名解析后的绝对路径', h3?.note);

  // ④ 未注入基准：不按进程 cwd 猜
  const c4 = proposeAcceptanceCriteria({
    title: '写方案', description: '将结论写入 docs/d.md',
    deliverables: [],
    pathExists: () => true,
  });
  const h4 = c4.checked.find((c) => c.criterion === '产出写入指定路径：docs/d.md');
  ok(h4?.passed === false && /未注入工作目录基准/.test(h4?.note ?? ''),
    'C-5 无基准 ⇒ 如实记"无法解析"，不猜', h4?.note);

  // ⑤ 在册命中但盘上没有：note 指向在册路径
  const c5 = proposeAcceptanceCriteria({
    title: '写方案', description: '将结论写入 plans/e.md',
    deliverables: [{ name: 'e', file_path: 'plans/e.md' }],
    pathExists: () => false,
  });
  const h5 = c5.checked.find((c) => c.criterion === '产出写入指定路径：plans/e.md');
  ok(h5?.passed === false && /文件不在路径上：plans\/e\.md/.test(h5?.note ?? ''),
    'C-6 在册命中但文件缺失 ⇒ 注记点名在册路径', h5?.note);

  // 接线：生产代拟器注入工作目录基准（不是只有纯函数支持）
  const ae = CODE(`${A}/src/main/core/agent-executor.ts`);
  ok(/SELECT working_dir FROM wa_projects/.test(ae) && /resolveRelative: workingDir \? \(p\) =>/.test(ae),
    'C-7 接线：`proposeAcceptanceForTask` 从项目工作目录注入解析基准');
}

// ───────────────────────── D 自核未达成逐条列出（批四）─────────────────────────
function groupD(): void {
  const warn = proposedMissWarning([
    { criterion: '产出物已落盘：a.md', note: '未在路径上找到：/x/a.md', passed: false },
    { criterion: '产出写入指定路径：docs/b.md', note: '在册产出物中没有落在该路径上的文件', passed: false },
    { criterion: '产出写入指定路径：docs/c.md', passed: true },
  ], 3);
  ok(!!warn && warn.includes('未达成 2/3 条'), 'D-1 有未达成项 ⇒ 出行并带 M/N 计数', warn ?? '(null)');
  ok(!!warn && warn.includes('产出物已落盘：a.md（未在路径上找到：/x/a.md）'),
    'D-2 逐条列出判据与原因（不再只报总数）');
  ok(!!warn && warn.includes('仅记录，不阻断收口'), 'D-3 明说只记录、不阻断');
  ok(!!warn && !warn.includes('✗') && !warn.includes('✓'), 'D-4 行文不含失败/成功字形（汇总器按字形计数）');

  eq(proposedMissWarning([{ criterion: 'x', passed: true }], 1), null, 'D-5 全达成 ⇒ 不出告警行');
  eq(proposedMissWarning([], 0), null, 'D-6 无代拟项 ⇒ 不出告警行');

  const many = proposedMissWarning(
    Array.from({ length: 5 }, (_, i) => ({ criterion: `判据${i + 1}`, note: '原因', passed: false })), 5);
  ok(!!many && many.includes('未达成 5/5 条') && many.split('；').length === 4,
    'D-7 超过 3 条时只列 3 条、其余以省略号收口', many ?? '(null)');

  const src = CODE(`${A}/src/main/core/tools/control-finalize.ts`);
  ok(/proposedMissWarning\(accPayload\.proposed_checked, total\)/.test(src),
    'D-8 接线：收口实际调用同一份实现（建了函数没人用 = 做了没用上）');
}

// ───────────────────────── E 跨任务去重如实回话（批五）─────────────────────────
async function groupE(): Promise<void> {
  const db = mkdb();
  db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status) VALUES ('own', 'p1', 'owner', 'doc', 'shared', '/wd/plans/shared.md', 'registered')").run();

  const cross = ensureDocDeliverable(db, { projectId: 'p1', taskId: 'child', absPath: '/wd/plans/shared.md', displayPath: 'plans/shared.md', via: 'write_file' });
  eq([cross.created, cross.ownerTaskId], [false, 'owner'], 'E-1 跨任务命中 ⇒ created=false 且回真属主');
  eq((db.prepare("SELECT task_id t FROM wa_deliverables WHERE id = 'own'").get() as { t: string }).t, 'owner',
    'E-2 反证：归属未被夺（承 zx_20260913 M2-2）');

  const self = ensureDocDeliverable(db, { projectId: 'p1', taskId: 'owner', absPath: '/wd/plans/shared.md', displayPath: 'plans/shared.md', via: 'write_file' });
  eq([self.created, self.ownerTaskId], [false, 'owner'], 'E-3 本任务命中 ⇒ 属主即本任务');

  const fresh = ensureDocDeliverable(db, { projectId: 'p1', taskId: 'child', absPath: '/wd/plans/new.md', displayPath: 'plans/new.md', via: 'write_file' });
  eq([fresh.created, fresh.ownerTaskId], [true, 'child'], 'E-4 无行 ⇒ 新建，属主为本任务');

  // 工具级回话：真实走 `writeTools` 的 execute（不是只看 ensureDocDeliverable）
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-zx-20261022_1-'));
  try {
    fs.mkdirSync(path.join(ws, 'plans'), { recursive: true });
    const sharedFp = path.join(ws, 'plans', 'shared.md');
    const ownFp = path.join(ws, 'plans', 'own.md');
    const ins = db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, file_path, status) VALUES (?, 'p1', ?, 'doc', ?, ?, 'registered')");
    ins.run('w-shared', 'owner', 'shared', sharedFp);
    ins.run('w-own', 'child', 'own', ownFp);

    const deps = {
      ctx: {}, db, taskId: 'child', projectId: 'p1', workingDir: ws,
      approvePathWrite: async () => ({ allowed: true }),
      ensureDocDeliverable,
      ARTIFACT_WRITE_TOOLS: new Set<string>(),
      logger: { error: () => {}, warn: () => {}, info: () => {}, debug: () => {} },
      readFiles: new Set<string>(),
    } as unknown as Parameters<typeof writeTools>[0];
    const tools = writeTools(deps);

    const wr = JSON.parse(String(await tools.write_file.execute({ filePath: 'plans/shared.md', content: '# 子任务写入\n' })));
    eq([wr.ok, wr.ownerTaskId], [true, 'owner'], 'E-5 write_file 跨任务命中 ⇒ 回话带 ownerTaskId');
    ok(/已登记在任务 owner 名下/.test(String(wr.note ?? '')), 'E-6 write_file 明说"工程级查重，不夺归属"', wr.note);
    eq((db.prepare("SELECT task_id t FROM wa_deliverables WHERE id = 'w-shared'").get() as { t: string }).t, 'owner',
      'E-7 反证：write_file 未改行归属');

    const wrSelf = JSON.parse(String(await tools.write_file.execute({ filePath: 'plans/own.md', content: '# 本任务\n' })));
    ok(wrSelf.ownerTaskId === undefined && wrSelf.note === undefined, 'E-8 同任务命中 ⇒ 不带归属告警（不制造噪音）');

    const rr = JSON.parse(String(await tools.register_deliverable.execute({ name: 'shared', type: 'doc', filePath: 'plans/shared.md' })));
    eq([rr.deduplicated, rr.ownerTaskId], [true, 'owner'], 'E-9 register_deliverable 跨任务命中 ⇒ 回话带 ownerTaskId');
    ok(/已登记在任务 owner 名下/.test(String(rr.note ?? '')), 'E-10 register_deliverable 同样如实说归属', rr.note);
    eq((db.prepare("SELECT task_id t FROM wa_deliverables WHERE id = 'w-shared'").get() as { t: string }).t, 'owner',
      'E-11 反证：register_deliverable 未改行归属');

    const rrSelf = JSON.parse(String(await tools.register_deliverable.execute({ name: 'own', type: 'doc', filePath: 'plans/own.md' })));
    ok(rrSelf.ownerTaskId === undefined && rrSelf.note === undefined, 'E-12 同任务命中 ⇒ 不带归属告警');
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

// ───────────────────────── F 上轮成果复核（批六，不改码）─────────────────────────
function groupF(): void {
  const spec = [
    { title: '输出排期方案', description: '写入 docs/排期.md', acceptance_criteria: '文件存在' },
    { title: '输出规划方案', description: '写入 docs/排期.md（细化到周）', acceptance_criteria: '文件存在' },
    { title: '核对数据口径', description: '写入 docs/口径.md', acceptance_criteria: '文件存在' },
    { title: '方案确认归档', description: '最终确认并归档方案', acceptance_criteria: '归档完成' },
  ];
  const inf = inferSubtaskDeps(spec);
  eq(inf.templates[1]?.dependsOn, [1], 'F-1 拆解：同产出路径 ⇒ 后写的依赖先写的');
  eq(inf.templates[2]?.dependsOn, undefined, 'F-2 拆解：不同产出路径 ⇒ 不加边');

  const prelude = buildPreludePrompt({
    title: '补全页面', description: '按现有设计补齐三个页面', acceptance: '构建通过', needCard: true,
    req: ['goal'], skeleton: ['"goal":""'],
    project: { name: '怡寿里', description: '茶叶电商站点', working_dir: '/tmp/yishouli' },
  });
  ok(prelude.includes('工作目录：/tmp/yishouli') && prelude.includes('不得虚构'),
    'F-3 预读：项目工作目录注入 + 反虚构硬约束在场');

  const files = [
    { file: '/p/docs/old.md', mtimeMs: 100 },
    { file: '/p/docs/new.md', mtimeMs: 300 },
    { file: '/p/docs/other.md', mtimeMs: 200 },
  ];
  eq(rankEvidenceDocFiles({ files, taskText: '本轮交付见 /p/docs/old.md' }).map((f) => f.file),
    ['/p/docs/old.md', '/p/docs/new.md', '/p/docs/other.md'], 'F-4 验收证据：任务点名者优先（即使更旧）');
  ok(isSupersededDocBody('# 排期方案\n\n> 状态：已废止，改用 v2\n\n正文') && !isSupersededDocBody('# 新方案\n\n正文讨论历史方案为何废止'),
    'F-5 验收证据：开头自报废止判失效，正文提及不算');

  eq(resolveMaxSteps(20, 1.0, 48), 72, 'F-6 步数：无续额时与旧公式逐位相同');
  eq(resolveMaxSteps(20, 1.0, 48, 72), 144, 'F-7 步数：续额加在取大结果之上');
  const ctx: Record<string, unknown> = {};
  const g1 = grantStepBudgetOnCapHit(ctx, 90);
  eq([g1.granted, ctx.step_budget_bonus, ctx.step_cap_grants], [true, 90, 1], 'F-8 撞顶续额 0→1 且写回上下文');
  const capped = grantStepBudgetOnCapHit({ step_cap_grants: STEP_CAP_GRANT_LIMIT, step_budget_bonus: 270 }, 50);
  eq(capped.granted, false, 'F-9 到顶后不再加额');
}

async function main(): Promise<void> {
  console.log('\n=== zx_20261022_1 A 占位符判据见字 ===');
  groupA();
  console.log('\n=== zx_20261022_1 B 探针识别数字前缀 + 星标自愈 ===');
  groupB();
  console.log('\n=== zx_20261022_1 C 验收路径落到工作目录 ===');
  groupC();
  console.log('\n=== zx_20261022_1 D 自核未达成逐条列出 ===');
  groupD();
  console.log('\n=== zx_20261022_1 E 跨任务去重如实回话 ===');
  await groupE();
  console.log('\n=== zx_20261022_1 F 上轮成果复核 ===');
  groupF();

  // build 钉（P1–P6 派生核对；P6 读 dist ⇒ tsup 须先于本套件）。
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

main().then(() => {
  console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} rr_zx_20261022_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => {
  console.error('套件异常：', e);
  console.log(`\nFAIL rr_zx_20261022_1: ${pass} 通过 / ${fail + 1} 失败\n`);
  process.exit(1);
});
