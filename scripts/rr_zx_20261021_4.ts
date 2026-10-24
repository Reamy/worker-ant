/**
 * zx_20261021_4 受控复跑 —— 「实」：拆解不编人、验收不误读、撞顶不白跑。
 *
 * 分组（与本轮方案 §2 一一对应）：
 *   A 拆解推断前置　B 预读不虚构　C 验收证据择文
 *   D 步数撞顶续额　E 快照轮转采样　F 步执行事件每步一条
 *
 * 纪律（承 CLAUDE.md 与 auto-memory）：
 *   · 直引**生产函数**（被删/改名即编译期失败，不扫空字符串冒充覆盖）。
 *   · 计数器类断言给 0→1 正面值，不以"不抛"代替。
 *   · 夹具按生产初始化顺序与生产列同形。
 *   · 不写"只为下一轮"的字面量：build 轮次由 `checkBuildPins` 从真源派生核对。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { extractExpectedOutputPaths, normalizeOutputPath } from '../apps/worker-ant-desktop/src/main/core/output-paths.js';
import { inferSubtaskDeps } from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';
import { buildPreludePrompt } from '../apps/worker-ant-desktop/src/main/core/memory-prelude.js';
import { rankEvidenceDocFiles, isSupersededDocBody } from '../apps/worker-ant-desktop/src/main/core/exec-evidence.js';
import {
  resolveMaxSteps,
  grantStepBudgetOnCapHit,
  stepCapContinuationOf,
  buildStepContinuationNote,
  STEP_CAP_GRANT_LIMIT,
} from '../apps/worker-ant-desktop/src/main/core/step-budget.js';
import { sampleSnapshotCandidates } from '../apps/worker-ant-desktop/src/main/core/world-snapshot.js';
import { stepEventToolLabel, logStepExecution, getExecutionTrace } from '../apps/worker-ant-desktop/src/main/core/observability.js';

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

// ───────────────────────── A 拆解推断前置（批一）─────────────────────────
function groupA(): void {
  const readsOnly = '读取 docs/参考.md 作为背景，不要修改';
  eq(extractExpectedOutputPaths(readsOnly), [],
    'A-1 只读文本不算产出（`读取 X.md` 无产出动词 ⇒ 空）');
  ok(extractExpectedOutputPaths('把结论写入 docs/排期.md').includes('docs/排期.md'),
    'A-2 产出动词 + 扩展名被认出');
  eq(normalizeOutputPath('.\\docs\\a.md'), 'docs/a.md', 'A-3 路径归一去 `./` 与反斜杠');

  // 真实怡寿里同族形状：排期/规划都写同一份文档；第四步是"确认归档"（父任务未提外部评审）。
  const spec = [
    { title: '输出排期方案', description: '写入 docs/排期.md', acceptance_criteria: '文件存在' },
    { title: '输出规划方案', description: '写入 docs/排期.md（细化到周）', acceptance_criteria: '文件存在' },
    { title: '核对数据口径', description: '写入 docs/口径.md', acceptance_criteria: '文件存在' },
    { title: '方案确认归档', description: '最终确认并归档方案', acceptance_criteria: '归档完成' },
  ];
  const r = inferSubtaskDeps(spec);
  eq(r.templates[1]?.dependsOn, [1],
    'A-4 ★ 同产出路径 ⇒ 后写的依赖先写的（同一文件不能两边并发改）');
  ok(r.inferred.some((d) => d.index === 2 && d.onIndex === 1 && d.reason === 'same_output' && d.output === 'docs/排期.md'),
    'A-5 推断原因与产出路径一并回传（不冒充模型声明）');
  eq(r.templates[2]?.dependsOn, undefined,
    'A-6 不同产出路径 ⇒ 不加边（防过度串行）');
  eq(r.templates[3]?.dependsOn, [3],
    'A-7 ★ 定稿/确认类 ⇒ 依赖前一个非确认型子任务');
  eq(spec[1]?.dependsOn, undefined,
    'A-8 不改调用方传入的模板（推断在副本上做）');
  ok(r.templates[0]?.dependsOn === undefined, 'A-9 首条无可依赖前序（不凭空自环）');

  const explicit = inferSubtaskDeps([
    { title: 'A', description: '写入 docs/x.md', acceptance_criteria: '' },
    { title: 'B', description: '写入 docs/x.md', acceptance_criteria: '', dependsOn: [1] },
  ]);
  eq(explicit.inferred, [], 'A-10 模型已声明的边不重复推断（不记第二条同样的账）');

  const src = CODE(`${A}/src/main/core/task-decompose.ts`);
  ok(/const inferred = inferSubtaskDeps\(opts\.template\)/.test(src) && /const template = inferred\.templates/.test(src),
    'A-11 接线：落库前应用推断（与 `resolveIndexDeps` 同一把尺）');
  ok(/export function recordInferredDeps/.test(src) && /decompose_inferred_deps/.test(src),
    'A-12 推断结果有落点：`context_json.decompose_inferred_deps`');
  ok(/不得虚构\*\*原始任务未提及的外部角色/.test(src), 'A-13 拆解提示词含反虚构硬约束');
  ok(/需要人拍板时应在执行中调用 ask_user/.test(src), 'A-14 提示词要求人拍板走 `ask_user`，不拆"找人评审"任务');
  ok(/同一个产出文件\*\*，后者必须用 dependsOn/.test(src), 'A-15 提示词要求同产出路径显式声明依赖');

  // 三路调用方都真记账（建了函数没人调 = 做了没用上）。
  const callers = [
    `${A}/src/main/core/tools/control.ts`,
    `${A}/src/main/core/jobs/ai-task.ts`,
    `${A}/src/main/services/im-router.ts`,
  ];
  for (const rel of callers) {
    ok(/recordInferredDeps\(/.test(CODE(rel)), `A-16 接线：${path.basename(rel)} 记推断账`);
  }
}

// ───────────────────────── B 预读不虚构（批二）─────────────────────────
function groupB(): void {
  const withProj = buildPreludePrompt({
    title: '补全页面', description: '按现有设计补齐三个页面', acceptance: '构建通过', needCard: true,
    req: ['goal', 'key_constraint', 'req_card'], skeleton: ['"goal":""', '"key_constraint":""', '"req_card":""'],
    project: { name: '怡寿里', description: '茶叶电商站点', working_dir: '/tmp/yishouli' },
  });
  ok(withProj.includes('项目：怡寿里'), 'B-1 项目名注入预读提示词');
  ok(withProj.includes('项目说明：茶叶电商站点'), 'B-2 项目描述注入');
  ok(withProj.includes('工作目录：/tmp/yishouli'), 'B-3 工作目录注入');
  ok(withProj.includes('不得虚构'), 'B-4 ★ 反虚构硬约束在场');
  ok(withProj.includes('待确认'), 'B-5 信息不足须写"待确认"，不得编造');
  ok(withProj.includes('任务：补全页面') && withProj.includes('按现有设计补齐三个页面'),
    'B-6 任务本身仍在场（上下文是补充，不是替换）');

  const noProj = buildPreludePrompt({
    title: '整理数据', description: '', acceptance: '', needCard: false,
    req: ['goal'], skeleton: ['"goal":""'], project: null,
  });
  ok(!noProj.includes('项目：'), 'B-7 项目行缺失 ⇒ 不编一行空项目（少上下文，不阻断）');
  ok(noProj.includes('任务：整理数据'), 'B-8 无项目时任务照常预读');
  ok(noProj.includes('不得虚构'), 'B-9 无项目时反虚构约束仍在');

  const src = CODE(`${A}/src/main/core/memory-manager.ts`);
  const pure = CODE(`${A}/src/main/core/memory-prelude.ts`);
  ok(/export function buildPreludePrompt/.test(pure) && /from '\.\/memory-prelude\.js'/.test(src)
    && /const prompt = buildPreludePrompt\(/.test(src) && !/export function buildPreludePrompt/.test(src),
    'B-10 接线：提示词构造**恰一份**在 `memory-prelude.ts`，`runTaskPrelude` 引它（管理器内不再留第二份实现）');
  ok(/SELECT name, description, working_dir FROM wa_projects WHERE id = \?/.test(src),
    'B-11 接线：项目上下文从真表读取（非硬编码）');
}

// ───────────────────────── C 验收证据择文（批三）─────────────────────────
function groupC(): void {
  const files = [
    { file: '/p/docs/old.md', mtimeMs: 100 },
    { file: '/p/docs/new.md', mtimeMs: 300 },
    { file: '/p/docs/other.md', mtimeMs: 200 },
  ];
  eq(rankEvidenceDocFiles({ files, taskText: '本轮交付见 /p/docs/old.md' }).map((f) => f.file),
    ['/p/docs/old.md', '/p/docs/new.md', '/p/docs/other.md'],
    'C-1 ★ 任务点名的绝对路径优先（即使它更旧）');
  eq(rankEvidenceDocFiles({ files, taskText: '请完成 new.md 的内容' }).map((f) => f.file),
    ['/p/docs/new.md', '/p/docs/other.md', '/p/docs/old.md'],
    'C-2 点名同名文件优先，其余按新到旧');
  eq(rankEvidenceDocFiles({ files, taskText: '无关任务' }).map((f) => f.file),
    ['/p/docs/new.md', '/p/docs/other.md', '/p/docs/old.md'],
    'C-3 未点名 ⇒ 纯按 mtime 新到旧');
  eq(rankEvidenceDocFiles({ files: [files[0]!, files[2]!], taskText: 'other.md' }).map((f) => f.file),
    ['/p/docs/other.md', '/p/docs/old.md'],
    'C-4 两只标本：点名者前移、未点名保持新到旧');

  ok(isSupersededDocBody('# 排期方案\n\n> 状态：已废止，改用 v2\n\n正文'), 'C-5 开头自报废止 ⇒ 判失效');
  ok(isSupersededDocBody('本文已被取代，请读新方案'), 'C-6 「已被取代」同样判失效');
  ok(!isSupersededDocBody('# 新方案\n\n正文讨论历史方案为何废止'), 'C-7 正文提及「废止」不算失效（只看开头状态行）');
  ok(!isSupersededDocBody(''), 'C-8 空正文不判失效');
  ok(!isSupersededDocBody(null), 'C-9 null 不判失效');
  const lateMarker = `${Array.from({ length: 60 }, (_, i) => `第 ${i} 行`).join('\n')}\n废止`;
  ok(!isSupersededDocBody(lateMarker), 'C-10 只在开头 40 行找失效声明（防正文长文误伤）');

  // zx_20261022_3 批十一：证据面实现已移至 `exec-evidence.ts`——C-11/C-13 改钉到**实现本尊**
  // （比原先扫消费者文件更强：消费者只留调用，实现才是行为所在）。C-12 的提示词仍属执行器。
  const evidenceSrc = CODE(`${A}/src/main/core/exec-evidence.ts`);
  const execSrc = CODE(`${A}/src/main/core/agent-executor.ts`);
  ok(/for \(const fp of bundle\.docFiles\)/.test(evidenceSrc) && /isSupersededDocBody\(body\)/.test(evidenceSrc),
    'C-11 接线：逐份读过、跳过失效件，再计入上限');
  ok(/只按下所列文件与记录判卷；未列出的旧版本不是本轮交付/.test(execSrc),
    'C-12 判卷提示词声明证据范围（未列出的旧版不是本轮交付）');
  ok(/rankEvidenceDocFiles\(\{/.test(evidenceSrc) && /mtimeMs/.test(evidenceSrc),
    'C-13 接线：`collectEvidence` 按排名取文件，不按行序');
}

// ───────────────────────── D 步数撞顶续额（批四）─────────────────────────
function groupD(): void {
  eq(resolveMaxSteps(20, 1.0, 48), 72, 'D-1 无续额时与旧公式逐位相同（向后兼容）');
  eq(resolveMaxSteps(20, 1.0, 48, 72), 144, 'D-2 续额加在取大结果之上（不是重新取大）');
  eq(resolveMaxSteps(20, 1.5, 0, 0), 30, 'D-3 空续额不改变基础预算');
  eq(resolveMaxSteps(20, 1.5, 0, NaN), 30, 'D-4 NaN 续额按 0 处理（脏值不放大预算）');
  eq(resolveMaxSteps(20, 1.5, 0, -5), 30, 'D-5 负续额按 0 处理');

  const ctx: Record<string, unknown> = {};
  const g1 = grantStepBudgetOnCapHit(ctx, 90);
  eq({ granted: g1.granted, grantedSteps: g1.grantedSteps, grants: g1.grants, bonus: g1.bonus },
    { granted: true, grantedSteps: 90, grants: 1, bonus: 90 },
    'D-6 ★ 撞顶 0→1：发一次性续额，账上次数 1');
  eq(ctx.step_budget_bonus, 90, 'D-7 续额写回 `step_budget_bonus`（恢复后真被读）');
  eq(ctx.step_cap_grants, 1, 'D-8 次数写回 `step_cap_grants`');
  const g2 = grantStepBudgetOnCapHit(ctx, 90);
  const g3 = grantStepBudgetOnCapHit(ctx, 90);
  const g4 = grantStepBudgetOnCapHit(ctx, 90);
  eq([g2.granted, g3.granted, g4.granted], [true, true, false],
    `D-9 ★ 至多 ${STEP_CAP_GRANT_LIMIT} 次：第四次不再加额`);
  eq(g4.bonus, 270, 'D-10 到顶后累计续额不再增长');
  eq(g4.grants, 3, 'D-11 到顶后次数封顶');
  const capped = grantStepBudgetOnCapHit({ step_cap_grants: 3, step_budget_bonus: 270 }, 50);
  eq([capped.granted, capped.bonus], [false, 270], 'D-12 存量已到顶 ⇒ 不发（不只靠本轮内存）');
  eq(grantStepBudgetOnCapHit({}, 0).granted, false, 'D-13 上限为 0 ⇒ 不发续额');

  eq(stepCapContinuationOf({}), null, 'D-14 没撞过顶 ⇒ 无续额账');
  eq(stepCapContinuationOf({ step_cap_hit: { count: 1, resume_bonus: 90 } }),
    { grantedSteps: 90, granted: true, grants: 1, limit: STEP_CAP_GRANT_LIMIT },
    'D-15 撞顶账可反读出"恢复后获 90 步"');
  eq(stepCapContinuationOf({ step_cap_hit: { count: 3, resume_bonus: null } })?.granted, false,
    'D-16 到顶后 resume_bonus 为 null ⇒ 不再声称会加额');

  const note = buildStepContinuationNote({ grantedSteps: 90, granted: true, grants: 1, limit: 3 });
  ok(note.includes('恢复后将获 90 步续额') && note.includes('第 1/3 次'),
    'D-17 ★ 暂停说明如实点名恢复后会得到多少（不再只说"请恢复继续"）');
  const exhausted = buildStepContinuationNote({ grantedSteps: 0, granted: false, grants: 3, limit: 3 });
  ok(exhausted.includes('用尽'), 'D-18 到顶时如实说"不再加额"，不假装还有许诺');

  const ae = CODE(`${A}/src/main/core/agent-executor.ts`);
  ok(/resolveMaxSteps\(baseMaxSteps, sizeMultiplier, estSteps, stepBudgetBonus\)/.test(ae),
    'D-19 接线：上限公式叠加上下文里的续额');
  ok(/const grant = grantStepBudgetOnCapHit\(ctxJson, maxSteps\)/.test(ae)
    && /ctxJson\.step_cap_hit = \{/.test(ae),
    'D-20 接线：撞顶当刻发续额并落账');
  ok(/step_cap_hit[\s\S]{0,400}?UPDATE wa_tasks SET context_json/.test(ae),
    'D-21 撞顶账当场落库（否则恢复后原样再撞）');
  const close = CODE(`${A}/src/main/core/exec-close.ts`);
  ok(/stepCapContinuationOf\(ctxJson\)/.test(close) && /buildStepContinuationNote\(capCont\)/.test(close),
    'D-22 接线：暂停说明引同一份续额账');
}

// ───────────────────────── E 快照轮转采样（批五）─────────────────────────
function groupE(): void {
  const paths: string[] = [];
  for (const dir of ['alpha', 'beta', 'gamma']) {
    for (let i = 0; i < 10; i++) paths.push(`/root/${dir}/f${i}.txt`);
  }
  const sample = sampleSnapshotCandidates(paths, 6, '/root');
  eq(sample.length, 6, 'E-1 取满上限');
  for (const dir of ['alpha', 'beta', 'gamma']) {
    eq(sample.filter((p) => p.startsWith(`/root/${dir}/`)).length, 2,
      `E-2 ★ 每个顶层目录都有代表（${dir} 2 个）——不再让靠前的子树吃光名额`);
  }
  eq(sample, sampleSnapshotCandidates(paths, 6, '/root'), 'E-3 两次采样顺序一致（前后快照稳定可比）');
  eq(sample[0], '/root/alpha/f0.txt', 'E-4 组内字典序、组间按组名（确定性）');

  const few = ['/root/b/z.txt', '/root/a/y.txt'];
  eq(sampleSnapshotCandidates(few, 10, '/root'), few, 'E-5 未超上限 ⇒ 原样返回全量（不改既有顺序）');
  eq(sampleSnapshotCandidates(few, 0, '/root'), [], 'E-6 上限 0 ⇒ 空样本');
  eq(sampleSnapshotCandidates([], 10, '/root'), [], 'E-7 空输入 ⇒ 空输出');

  const nested = ['/root/src/a/x.ts', '/root/src/b/y.ts', '/root/docs/z.md'];
  eq(sampleSnapshotCandidates(nested, 2, '/root'), ['/root/docs/z.md', '/root/src/a/x.ts'],
    'E-8 分组按相对首段：`src` 的两层共用一组，与 `docs` 轮转');

  const src = CODE(`${A}/src/main/core/world-snapshot.ts`);
  ok(/sampleSnapshotCandidates\(candidates\.map\(\(c\) => c\.path\), SNAPSHOT_FILE_LIMIT/.test(src),
    'E-9 接线：采样走轮转函数（唯一一处口径）');
  ok(/仅覆盖按顶层目录轮转抽取的/.test(src),
    'E-10 截断说明与实现同口径（不再谎称"字典序前 N"）');
}

// ───────────────────────── F 执行事件每步一条（批六）─────────────────────────
function groupF(): void {
  eq(stepEventToolLabel([{ toolName: 'read_file' }, { toolName: 'read_file' }, { toolName: 'write_file' }]),
    'read_file+write_file', 'F-1 同一步的多工具去重合并（保持首次出现顺序）');
  eq(stepEventToolLabel([]), '（无工具）', 'F-2 纯文本步如实标注，不冒充工具调用');
  eq(stepEventToolLabel([{ toolName: '' }]), '（无工具）', 'F-3 空工具名不产生空标签');

  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE wa_event_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
    event_type TEXT NOT NULL, aggregate_type TEXT NOT NULL, aggregate_id TEXT NOT NULL,
    aggregate_version INTEGER NOT NULL DEFAULT 1, payload TEXT NOT NULL DEFAULT '{}',
    metadata TEXT DEFAULT '{}', occurred_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')))`);
  const logDb = db as unknown as Parameters<typeof logStepExecution>[0];
  logStepExecution(logDb, 'task-1', 'proj-1', { toolName: 'read_file+write_file', tokens: 100 });
  const rows = db.prepare('SELECT COUNT(*) AS c FROM wa_event_log').get() as { c: number };
  eq(rows.c, 1, 'F-4 ★ 一次记录 = 一条事件（0→1）');
  const trace = getExecutionTrace(logDb, 'task-1');
  eq(trace.length, 1, 'F-5 追踪按事件一条');
  eq(trace[0]?.tokens, 100, 'F-6 ★ 整步 token 只记一次（不再每个工具各记一遍 ⇒ 聚合不虚高）');
  eq(trace[0]?.toolName, 'read_file+write_file', 'F-7 合并标签原样进入追踪');

  const stepSrc = CODE(`${A}/src/main/core/exec-step.ts`);
  ok(/const stepToolNames/.test(stepSrc) && /stepEventToolLabel\(stepToolNames\)/.test(stepSrc),
    'F-8 接线：事件使用合并标签');
  ok(!/logStepExecution\(d\.db, d\.taskId, d\.projectId, \{ toolName: tc\.toolName/.test(stepSrc),
    'F-9 ★ 旧的"逐工具调用各记一条"写法已移除（反证）');
  const callCount = (stepSrc.match(/logStepExecution\(/g) || []).length;
  eq(callCount, 1, 'F-10 每步只有一个写事件调用点');
}

function main(): void {
  console.log('\n=== zx_20261021_4 A 拆解推断前置 ===');
  groupA();
  console.log('\n=== zx_20261021_4 B 预读不虚构 ===');
  groupB();
  console.log('\n=== zx_20261021_4 C 验收证据择文 ===');
  groupC();
  console.log('\n=== zx_20261021_4 D 步数撞顶续额 ===');
  groupD();
  console.log('\n=== zx_20261021_4 E 快照轮转采样 ===');
  groupE();
  console.log('\n=== zx_20261021_4 F 执行事件每步一条 ===');
  groupF();

  // build 钉（P1–P6 派生核对；P6 读 dist ⇒ tsup 须先于本套件）。
  checkBuildPins(ok, { distDir: path.join(root, A, 'dist') });
}

main();
console.log(`\n${fail === 0 ? 'PASS' : 'FAIL'} rr_zx_20261021_4: ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail === 0 ? 0 : 1);
