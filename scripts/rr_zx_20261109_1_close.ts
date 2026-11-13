/**
 * zx_20261109_1 「轻·准」受控回归 —— 收口判据/账本（B3/B4/B5 生长）。
 *
 * B0 阶段只钉契约：构建标识与方案在册。后续批次在此追加：
 *   - B3 旁路 LLM 有界（run 级熔断/总预算/三因分开）
 *   - B4 判据路径可核性（`criteriaPathRefs` 确定性核验 + 提示词无 brief 时逐字节不变）
 *   - B5 完成账可回查（`criteriaOrder` 回填 / `evidence_refs` 落账 / `run_id` 幂等）
 *
 * 纪律：断言文案不含失败字形；夹具自建，不依赖真实墙钟。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { checkBuildPins, deriveBuildTag, stripKeepingLines } from './lib/rr-pins.js';
import { CommandWriteQueue } from '../apps/worker-ant-desktop/src/main/core/command-write-queue.js';
import type { WorkingDirScan } from '../apps/worker-ant-desktop/src/main/core/world-snapshot.js';
import {
  validateOutput, validateOutputs, summarizeUnverified, LLM_VALIDATION_BUDGET_MS,
} from '../apps/worker-ant-desktop/src/main/core/output-validator.js';
import {
  criteriaPathRefs, collectPathBases, missingPathRefs, PATH_BASES_MAX_TOP,
} from '../apps/worker-ant-desktop/src/main/core/acceptance-paths.js';
import {
  unverifiedReasonText, buildUnverifiedCheckPayload, isUnjudgedReason, acceptanceVerdictOf, toAcceptanceSummary,
  splitCriteriaLines, alignChecksToCriteria, buildAcceptanceCheckPayload, decideAcceptanceOutcome, recordAcceptanceOutcome,
} from '../apps/worker-ant-desktop/src/main/core/acceptance-check.js';
import {
  newRunId, shortRunId, tagWithRun, mergeFinalizeChecks, claimCompletedEmit,
} from '../apps/worker-ant-desktop/src/main/core/run-trace.js';
import {
  renderProjectBriefForJudge, PROJECT_BRIEF_JUDGE_MAX_CHARS, type ProjectBrief,
} from '../apps/worker-ant-desktop/src/main/core/project-brief.js';
import { buildDecomposePrompt } from '../apps/worker-ant-desktop/src/main/core/task-decompose.js';
import { checkAcceptanceCriteria } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
// 方向性比较：源码 build 只须**不早于**本脚本轮次（写死等值＝下一轮必炸的哑雷）。
const roundOrd = (t: string): number => {
  const m = /^zx_(\d{8})(?:_(\d+))?$/.exec(t);
  return m ? Number(m[1]) * 1000 + Number(m[2] ?? 1) : -1;
};
const ROOT = path.join(__dirname, '..');
const EXEC = path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/agent-executor.ts');
const EXEC_FINALIZE_SRC = path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/exec-finalize.ts');
const EXEC_CLOSE_SRC = path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/exec-close.ts');
const EXEC_ACCEPT_SRC = path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/exec-acceptance.ts');
const CONTROL_FINALIZE_SRC = path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/tools/control-finalize.ts');
const WORLD_SRC = path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/world-snapshot.ts');
const DECOMPOSE_SRC = path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/task-decompose.ts');
const PLAN = path.join(ROOT, 'plans/improve', `${SELF_ROUND}.md`);
const DIST = path.join(ROOT, 'apps/worker-ant-desktop/dist');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

console.log(`\n【A】构建标识 ${SELF_ROUND}`);
{
  const { tag, count } = deriveBuildTag(fs.readFileSync(EXEC, 'utf-8'));
  eq(count, 1, 'A1 源码 build 轮次标识恰好 1 处');
  ok(roundOrd(tag) >= roundOrd(SELF_ROUND), 'A2 源码 build 不早于脚本轮次（文件名派生，方向性比较）', `${tag} vs ${SELF_ROUND}`);
  ok(fs.existsSync(PLAN), `A3 方案在册：plans/improve/${SELF_ROUND}.md`);
  checkBuildPins(ok, { distDir: DIST });
}

// ══════════════════════════════════════════════════════════════════════
// B2：命令窗口合并队列 + 完成路径接线（行为 + 静态接线两层）
// ══════════════════════════════════════════════════════════════════════
async function sectionB2(): Promise<void> {
console.log('\n【G】B2 命令窗口合并（run 级一次盘点）与完成路径接线');
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-q-rr-b2-'));
  try {
    const mk = (p: string, ageMs: number) => {
      const abs = path.join(root, p);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, p);
      const t = new Date(Date.now() - ageMs);
      fs.utimesSync(abs, t, t);
      const st = fs.statSync(abs);
      return { abs, rel: p, size: st.size, mtimeMs: st.mtimeMs };
    };
    const oldA = mk('old_a.txt', 300_000);
    const fresh1 = mk('fresh1.txt', 1_000);
    const fresh2 = mk('fresh2.txt', 1_000);

    // ── G1 合并且取**最早** sinceMs、via 去重保序 ──
    const q = new CommandWriteQueue();
    q.enqueue({ projectId: 'P', taskId: 'T', workingDir: root, sinceMs: 200, via: 'execute_command' });
    q.enqueue({ projectId: 'P', taskId: 'T', workingDir: root, sinceMs: 100, via: 'run_privileged' });
    q.enqueue({ projectId: 'P', taskId: 'T', workingDir: root, sinceMs: 150, via: 'execute_command' });
    const win = q.take();
    eq([win?.sinceMs, win?.vias], [100, ['execute_command', 'run_privileged']],
      'G1 合并窗口取最早 `sinceMs`、`vias` 去重且保首次出现顺序');
    ok(q.hasPending === false && (await q.flush({ limit: 10, register: () => {} })) === null,
      'G2 队列已空 ⇒ flush 立即返回 null（不扫描——早退/异常路兜底不付第二遍遍历）');

    // ── G3 复用注入的扫描：只登记窗口内 mtime，来源如实合并 ──
    const scan: WorkingDirScan = {
      root, dirsScanned: 1, entriesScanned: 3, truncatedScan: false,
      files: [oldA, fresh1, fresh2],
    };
    const seen: Array<{ name: string; via: string }> = [];
    const q2 = new CommandWriteQueue();
    // 窗口是**绝对时刻**（生产口径 = 命令启动前的 `Date.now()`），不是"多少秒前"。
    q2.enqueue({ projectId: 'P', taskId: 'T', workingDir: root, sinceMs: Date.now() - 250_000, via: 'execute_command' });
    q2.enqueue({ projectId: 'P', taskId: 'T', workingDir: root, sinceMs: Date.now() - 200_000, via: 'run_privileged' });
    const r2 = await q2.flush({ limit: 10, scan, register: (p, via) => seen.push({ name: path.basename(p), via }) });
    eq(r2, { found: 2, registered: 2 }, 'G3 窗口内恰 2 个文件命中（`old_a.txt` 早于窗口不计）');
    eq(seen.map((s) => s.name).sort(), ['fresh1.txt', 'fresh2.txt'], 'G4 登记的正是窗口内的两个文件');
    eq([...new Set(seen.map((s) => s.via))], ['execute_command+run_privileged'],
      'G5 来源如实合并（多命令 = `execute_command+run_privileged`；单命令时与原值逐字相同）');

    // ── G6 扫描被大仓上限截断 ⇒ 退回不截断的生产盘点，宁可多扫不漏 ──
    const q3 = new CommandWriteQueue();
    q3.enqueue({ projectId: 'P', taskId: 'T', workingDir: root, sinceMs: Date.now() - 200_000, via: 'execute_command' });
    const r3 = await q3.flush({
      limit: 10,
      scan: { root, dirsScanned: 1, entriesScanned: 1, truncatedScan: true, files: [oldA] },
      register: () => {},
    });
    eq(r3, { found: 2, registered: 2 },
      'G6 注入扫描截断 ⇒ 退回 `listFilesWrittenSince` 全量盘点（不用"扫了一半"得出"就这些"）');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }

  // ── G7 静态接线：完成路径上"先补登记、后判卷与收口；审计延后" ──
  const code = stripKeepingLines(fs.readFileSync(EXEC, 'utf-8')).join('\n');
  const iFlush = code.indexOf('await flushTaskCommandWrites(db, commandWriteQueue, taskId, await auditScan)');
  const iAssess = code.indexOf('let qualityScore = assessCompletionQuality(');
  const iClose = code.indexOf('const closePromise = runCloseSection(');
  ok(iFlush > 0 && iAssess > iFlush && iClose > iAssess,
    'G7 次序：命令窗口补登记 → 质量评估（判卷读产出物） → 收口段（读交付）');
  ok(code.includes('return closePromise.then(') && code.includes('runWorldAudit?.(); return r;'),
    'G8 主路审计**延后到收口 settle 之后**触发（异步函数的 finally 不等待 return 的 Promise——故用 .then）');
  ok(code.includes('if (!closePathTaken) runWorldAudit?.();'),
    'G9 早退/异常路由 finally 触发审计（主路已触发 ⇒ `runWorldAudit` 的 started 闸使其幂等）');
  eq((code.match(/flushTaskCommandWrites\(/g) || []).length, 3,
    'G10 `flushTaskCommandWrites` 恰 3 处 = 1 定义 + 主路 1 + finally 兜底 1（两条路都有，且只有两条）');
  ok(code.includes('const auditScan: Promise<WorkingDirScan | null> = workingDir')
    && code.includes('scan: auditScan'),
    'G11 循环结束即启动**一份**扫描（取数时刻与旧审计相同），交给第二通道与 after 快照共用');
}
}

// ══════════════════════════════════════════════════════════════════════
// B3：收口旁路 LLM 有界（run 级熔断 / 批次总预算 / 成因分类）
// ══════════════════════════════════════════════════════════════════════
function tmpDoc(bits: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-b3-'));
  const file = path.join(dir, `${bits}.md`);
  fs.writeFileSync(file, `# 测试文档 ${bits}\n\n${'内容'.repeat(400)}\n\n结论：一切正常。\n`, 'utf-8');
  return file;
}

async function sectionB3(): Promise<void> {
  console.log('\n【H】B3 收口旁路 LLM 有界（熔断/总预算/成因分类）');
  const targets = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].map((b) => ({ file: tmpDoc(b), archetype: 'document' }));

  // ── H1 首条超时即熔断：假 client 在"选模型"这一跳立刻抛超时（不触网、不真等 12s）──
  const breaker = { tripped: false };
  const fakeTimeout = { getOptimalModel: async () => { const e = new Error('timed out'); e.name = 'TimeoutError'; throw e; } };
  const t0 = Date.now();
  const r = await validateOutputs(fakeTimeout as never, targets, { breaker, budgetMs: LLM_VALIDATION_BUDGET_MS });
  const dt = Date.now() - t0;
  ok(breaker.tripped === true, 'H1 首条超时即置熔断（run 级状态被真实写入，不是只读的装饰参数）');
  ok(dt < 1_000, 'H1b 六份总耗时远低于 6×单份上限（熔断后其余各条不再付一次等待）', `${dt}ms`);
  ok(r.length === 6 && r.every((x) => x.status === 'unknown'),
    'H2 熔断只改"等不等"、不改判定：六份均如实未核（不冒充内容充分）');
  ok(r.slice(3).every((x) => String(x.reason).includes('未再等待')),
    'H3 熔断后的条目原因写明"未再等待"（与首条"超时"分开说）', r.slice(3).map((x) => x.reason).join(' | ').slice(0, 120));
  const info = summarizeUnverified(r, breaker);
  ok(!!info && info.includes('熔断') && !info.includes('✗') && !info.includes('✓'),
    'H4 汇总 INFO：点明熔断、成因分类齐全、不含失败字形', String(info).slice(0, 160));

  // ── H5 判定不被洗白：快检不过的薄文档即便熔断在册也仍判 `insufficient` ──
  const thinDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-b3-thin-'));
  const thin = path.join(thinDir, 'thin.md');
  fs.writeFileSync(thin, '# 只有标题\n', 'utf-8');
  const rThin = await validateOutput(null as never, thin, 'document', { breaker: { tripped: true }, deadlineAt: 0 });
  eq(rThin.status, 'insufficient', 'H5 快检不过 ⇒ 仍判不充分（熔断/预算耗尽只影响"问不问"，不改变已有判定）');

  // ── H5b 辅助模型**正常**返回 insufficient ⇒ 仍拒收（只换网络出口，走生产真路径）──
  {
    const realFetch = globalThis.fetch;
    let hits = 0;
    globalThis.fetch = (async () => {
      hits += 1;
      const content = JSON.stringify({ sufficient: false, reason: '缺少结论段', suggestion: '补充结论', missingAspects: ['结论'] });
      return new Response(JSON.stringify({
        id: 'chatcmpl-rr', object: 'chat.completion', created: 0, model: 'rr-fake',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    try {
      const fakeModel = { getOptimalModel: async () => ({ url: 'https://rr.test/v1', api_key: 'k', model_name: 'm' }) };
      const rIn = await validateOutputs(fakeModel as never, [targets[0]!], { breaker: { tripped: false }, budgetMs: LLM_VALIDATION_BUDGET_MS });
      ok(rIn[0]?.status === 'insufficient' && hits === 1,
        'H5b 辅助模型正常返回"不充分" ⇒ 仍按不充分拒收（熔断/预算机制不改变判定），且确由生产路径发出 1 次请求',
        `status=${rIn[0]?.status} hits=${hits}`);
      ok(String(rIn[0]?.llmCheck?.reason).includes('缺少结论段'),
        'H5c 拒收理由来自模型结论（不是本地兜底话术）', String(rIn[0]?.llmCheck?.reason));
    } finally { globalThis.fetch = realFetch; }
  }

  // ── H6 无可用模型：立即 `no_model`（不是"超时"），汇总按因分账 ──
  const fakeNoModel = { getOptimalModel: async () => null };
  const t1 = Date.now();
  const rNo = await validateOutputs(fakeNoModel as never, [targets[0]!], { breaker: { tripped: false }, budgetMs: LLM_VALIDATION_BUDGET_MS });
  const dt1 = Date.now() - t1;
  ok(rNo[0]?.status === 'unknown' && (rNo[0]?.llmCheck as { reasonCode?: string })?.reasonCode === 'no_model' && dt1 < 1_000,
    'H6 无可用模型 ⇒ 立即未核并标 `no_model`（不等满 12s、也不说成超时）', `${dt1}ms`);
  const infoNo = summarizeUnverified(rNo, { tripped: false });
  ok(!!infoNo && infoNo.includes('无可用模型') && !infoNo.includes('超时'),
    'H6b 汇总按成因分账：`no_model` 不会被写成"超时/预算用尽"', String(infoNo).slice(0, 140));

  // ── H7 总预算已用尽：未开始的条目立即未核（不发起任何往返）──
  let neverHits = 0;
  const fakeNever = { getOptimalModel: async () => { neverHits += 1; throw new Error('should-not-be-called'); } };
  const t2 = Date.now();
  const rZero = await validateOutputs(fakeNever as never, targets.slice(0, 3), { breaker: { tripped: false }, budgetMs: 0 });
  const dt2 = Date.now() - t2;
  ok(rZero.every((x) => x.status === 'unknown' && String(x.reason).includes('总预算')) && dt2 < 500 && neverHits === 0,
    'H7 批次总预算为 0 ⇒ 三条立即未核并写明预算用完（选模型一跳**零调用**——不是先问再丢）', `${dt2}ms hits=${neverHits}`);

  // ── H8 静态接线：熔断器 run 级新建、经两路（工具面 / 收口段）传递、绝不模块级全局 ──
  const exec = stripKeepingLines(fs.readFileSync(EXEC, 'utf-8')).join('\n');
  ok((exec.match(/const sufficiencyBreaker: SufficiencyBreaker = \{ tripped: false \};/g) || []).length === 1,
    'H8 熔断器恰一处新建（run 级局部变量——不跨 run/跨任务串味）');
  ok(exec.includes('{ commandWriteQueue, sufficiencyBreaker }'),
    'H9 finalize 工具面收到**同一份**熔断器（经 buildTools 的 run 级入参，不另建第二份）');
  ok(exec.includes('sideAtFirstPersist, goalDefined, ctxJson, runStartedAtMs, sufficiencyBreaker,'),
    'H10 收口段收到**同一份**熔断器（finalize 门用过就熔断的话，收口段不再各等一轮）');
  ok(exec.includes('sufficiencyBreaker: extra?.sufficiencyBreaker ?? { tripped: false },'),
    'H11 ToolDeps 兜底占位与生产同形（受控回归不注入时也不炸）');
}

// ══════════════════════════════════════════════════════════════════════
// B4：判据读项目真身（提示词注入 + 确定性路径可核性 + 判卷短路）
// ══════════════════════════════════════════════════════════════════════
async function sectionB4(): Promise<void> {
  console.log('\n【I】B4 判据读项目真身（路径可核性 / 提示词注入 / 判卷短路）');

  // ── I1–I4 提取：只认「带目录 + 已知扩展名」的相对引用 ──
  eq(criteriaPathRefs('修改 src/pages/a.vue 并核对 src/a.ts:12 的行为'),
    ['src/pages/a.vue', 'src/a.ts'],
    'I1 命中相对引用；`src/a.ts:12` 归一为 `src/a.ts`（行号剥掉）');
  eq(criteriaPathRefs('见 ./src/b.ts。再改 src/b.ts'),
    ['src/b.ts'],
    'I2 `./` 前缀剥掉、尾部标点剥掉、重复引用只留一次');
  eq(criteriaPathRefs('访问 https://x/a/b.ts；用 dayjs 跑 npm run build；GET/PUT；console.log；orders/create；@scope/pkg；institution.wxml'),
    [],
    'I3 反证：URL/包名/命令/HTTP 方法/代码表达式/API 路由/作用域包名/单段文件名一律不误判');
  eq(criteriaPathRefs('见 ../outside/x.ts 与 /abs/y.ts'),
    [],
    'I4 翻出工作目录的 `../` 与绝对路径不核（没有可断言的相对基准）');

  // ── I5–I6 基底 + 缺项：真库标本形态的临时目录 ──
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-b4-'));
  try {
    fs.mkdirSync(path.join(root, 'mini-mp/src/pages/worker/institution'), { recursive: true });
    fs.writeFileSync(path.join(root, 'mini-mp/src/pages/worker/institution/institution.vue'), '<template/>');

    const { bases, truncated } = collectPathBases(root);
    ok(!truncated && bases.includes(path.join(root, 'mini-mp/src')),
      'I5 基底 = 工作目录 + 一级子目录 + 子工程 `src`（多包仓的源码根在册）', JSON.stringify(bases.map((b) => path.relative(root, b) || '.')));

    const refs = ['pages/worker/institution/institution.wxml', 'pages/worker/institution/institution.vue'];
    const missing = missingPathRefs(refs, bases, (abs) => { try { return fs.existsSync(abs); } catch { return false; } });
    eq(missing, ['pages/worker/institution/institution.wxml'],
      'I6 `b8310097` 形态：仓库里只有 `.vue` ⇒ 判据写的 `.wxml` 被标缺，真实的 `.vue` 不误标');

    eq(missingPathRefs(refs, bases, () => false, { basesTruncated: true }), [],
      'I7 基底枚举被截断 ⇒ 不判缺（fail-open：枚举不全就不能断言"哪里都没有"）');

    const bigRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-b4-many-'));
    try {
      for (let i = 0; i <= PATH_BASES_MAX_TOP; i++) fs.mkdirSync(path.join(bigRoot, `d${String(i).padStart(3, '0')}`));
      ok(collectPathBases(bigRoot).truncated === true,
        'I8 子目录数超上限 ⇒ 如实标 truncated（调用方据此 fail-open）');
    } finally { fs.rmSync(bigRoot, { recursive: true, force: true }); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }

  // ── I9 载荷/判词/判定：缺项随账本走，结局是 `unjudged` 而非"未达成" ──
  const pMissing = buildUnverifiedCheckPayload('criteria_path_missing', 'T0', { criteriaPathMissing: ['a/x.wxml', 'b/y.js'] });
  eq(pMissing.criteria_path_missing, ['a/x.wxml', 'b/y.js'], 'I9 缺项随载荷落账（not 只打日志）');
  ok(!('criteria_path_missing' in buildUnverifiedCheckPayload('no_model', 'T0', { criteriaPathMissing: ['a/x.wxml'] })),
    'I10 其它成因码不夹带路径（载荷形状按成因分化）');
  ok(unverifiedReasonText({ reason: 'criteria_path_missing', criteria_path_missing: ['a/x.wxml'] }).includes('a/x.wxml')
    && unverifiedReasonText({ reason: 'criteria_path_missing', criteria_path_missing: Array.from({ length: 7 }, (_, i) => `p${i}.ts`) }).includes('等 7 条'),
    'I11 判词带出缺哪条路径（>5 条以「等 N 条」收口）');
  eq([isUnjudgedReason('criteria_path_missing'), acceptanceVerdictOf(pMissing)], [true, 'unjudged'],
    'I12 结局记 `unjudged`（判据缺陷，不是交付未达成）');
  eq(toAcceptanceSummary(pMissing as never).criteria_path_missing, ['a/x.wxml', 'b/y.js'],
    'I13 摘要保留缺项（面板/暂停文案可回查）');

  // ── I14 提示词：无 brief 逐字节不变；有 brief 才追加硬规则 ──
  const desc = '给机构端加一个家属绑定页面';
  const basePrompt = buildDecomposePrompt(desc);
  ok(basePrompt === buildDecomposePrompt(desc, undefined, undefined, undefined, '')
    && basePrompt === buildDecomposePrompt(desc, undefined, undefined, undefined)
    && !basePrompt.includes('硬规则') && !basePrompt.includes('[项目须知'),
    'I14 空/缺 brief 时拆解提示词与旧四参**逐字节相同**（既有夹具不受污染）');
  const briefPrompt = buildDecomposePrompt(desc, undefined, undefined, undefined, '[项目须知] 技术栈：Vue3 / Vite\n- mini-mp/src：小程序源码');
  ok(briefPrompt.includes('技术栈：Vue3') && briefPrompt.includes('硬规则')
    && briefPrompt.includes('<目录职能>') && briefPrompt.includes('按框架习惯补上仓库里不存在的文件名'),
    'I15 ready 须知注入拆解提示词（含禁臆造文件名的硬规则）');

  // ── I16 判卷上下文渲染：只取 stack/layout、≤300 字、无内容返回空串 ──
  const leanBrief: ProjectBrief = { summary: '摘要', stack: [], commands: [], entry_points: [], layout: [], conventions: ['约定'], gotchas: [] };
  eq(renderProjectBriefForJudge(leanBrief), '', 'I16 无 stack/layout ⇒ 返回空串（提示词据此逐字节不变）');
  const okBrief: ProjectBrief = { ...leanBrief, stack: ['Vue3', 'Vite'], layout: [{ path: 'mini-mp/src', purpose: '小程序源码' }] };
  const hint = renderProjectBriefForJudge(okBrief);
  ok(hint.startsWith('[项目须知（判卷用）]') && hint.includes('技术栈：Vue3 / Vite') && hint.includes('mini-mp/src：小程序源码')
    && hint.length <= PROJECT_BRIEF_JUDGE_MAX_CHARS,
    'I17 判卷上下文含技术栈与目录职责且 ≤300 字', `${hint.length} 字`);
  const fatBrief: ProjectBrief = {
    ...leanBrief, stack: ['Vue3'],
    layout: Array.from({ length: 40 }, (_, i) => ({ path: `pkg${i}`, purpose: '很长的目录职责说明'.repeat(3) })),
  };
  const fatHint = renderProjectBriefForJudge(fatBrief);
  ok(fatHint.length <= PROJECT_BRIEF_JUDGE_MAX_CHARS && fatHint.includes('已省略'),
    'I18 超预算时整项丢弃并如实注明（不外溢、不挖洞）', `${fatHint.length} 字`);

  // ── I19–I22 行为：判卷入口的确定性短路（DB 夹具 + 不走 LLM）──
  const { DatabaseSync } = await import('node:sqlite');
  const mkDb = () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', parent_task_id TEXT DEFAULT NULL,
        title TEXT DEFAULT '', description TEXT DEFAULT '', acceptance_criteria TEXT DEFAULT '', context_json TEXT DEFAULT '{}');
      CREATE TABLE wa_projects (id TEXT PRIMARY KEY, working_dir TEXT DEFAULT '');
      CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT, content TEXT, created_at TEXT DEFAULT '');
      -- zx_20261110_2 B8：补 project_id——生产表有此列，deliverableScopeSql({ projectId }) 会按它过滤。
      --   夹具缺列 ⇒ 判卷入口的路径核验那条 SQL 抛错、被外层 catch 吞成 error：I19/I20/I21/I25 一起转红，
      --   读起来像"判据路径核验坏了"，实为**夹具比生产窄**。夹具必须与生产同形，否则断言在自我印证。
      CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, task_id TEXT, project_id TEXT, name TEXT, type TEXT, status TEXT, file_path TEXT);
      CREATE TABLE wa_project_briefs (project_id TEXT PRIMARY KEY, status TEXT, brief_json TEXT, source_hash TEXT DEFAULT '',
        error TEXT DEFAULT '', model TEXT DEFAULT '', tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
        trigger TEXT DEFAULT '', generated_at TEXT DEFAULT '', attempt_model TEXT DEFAULT '', updated_at TEXT DEFAULT '');
    `);
    return db;
  };
  const workRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-b4-db-'));
  try {
    fs.mkdirSync(path.join(workRoot, 'mini-mp/src/pages/worker/institution'), { recursive: true });
    fs.writeFileSync(path.join(workRoot, 'mini-mp/src/pages/worker/institution/institution.vue'), '<template/>');

    const db = mkDb();
    db.prepare('INSERT INTO wa_projects (id, working_dir) VALUES (?, ?)').run('P1', workRoot);
    db.prepare('INSERT INTO wa_tasks (id, project_id, context_json) VALUES (?, ?, ?)').run(
      'T1', 'P1', JSON.stringify({ goal: '兄弟键须保留', attachments: [{ id: 'a1' }] }),
    );
    const ctxStub = { getAnsClient: async () => { throw new Error('路径核验已短路，不得调用模型'); } } as never;
    const missingCriteria = '页面 pages/worker/institution/institution.wxml 与 pages/worker/institution/institution.js 均存在且渲染正常。';
    const r1 = await checkAcceptanceCriteria(ctxStub, db as never, 'T1', missingCriteria);
    eq([r1.outcome.ran, (r1.outcome as { reason?: string }).reason], [false, 'criteria_path_missing'],
      'I19 判据引用不存在的路径 ⇒ 不计通过，结局记 `criteria_path_missing`（不进入 LLM 判定）');
    eq(r1.payload.criteria_path_missing,
      ['pages/worker/institution/institution.wxml', 'pages/worker/institution/institution.js'],
      'I20 缺项随账本落库，逐条可回查');
    const ctxRow = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('T1') as { context_json: string }).context_json) as Record<string, unknown>;
    ok(ctxRow.goal === '兄弟键须保留' && Array.isArray(ctxRow.attachments)
      && (ctxRow.acceptance_check as { reason?: string })?.reason === 'criteria_path_missing',
      'I21 落账只动 `acceptance_check` 一个键（`goal`/`attachments` 兄弟键原样保留）');
    eq(acceptanceVerdictOf(r1.payload), 'unjudged', 'I22 载荷判定 = `unjudged`（finalize 的既有 paused 分支据此置待人工）');

    // 真实存在的 `.vue` ⇒ 不短路，正常进入判卷路（桩抛错 ⇒ 如实记 `error`，不是 `criteria_path_missing`）。
    db.prepare('INSERT INTO wa_tasks (id, project_id) VALUES (?, ?)').run('T2', 'P1');
    const r2 = await checkAcceptanceCriteria(ctxStub, db as never, 'T2', '页面 pages/worker/institution/institution.vue 渲染正常。');
    eq([r2.outcome.ran, (r2.outcome as { reason?: string }).reason], [false, 'error'],
      'I23 路径存在 ⇒ 不短路，照常进入判卷（桩抛错如实记 `error`，与路径缺陷分得开）');

    // ── I24–I25 提示词注入（行为）：无 brief 不加、有 ready brief 才加 ──
    const db2 = mkDb();
    db2.prepare('INSERT INTO wa_projects (id, working_dir) VALUES (?, ?)').run('P2', workRoot);
    db2.prepare('INSERT INTO wa_projects (id, working_dir) VALUES (?, ?)').run('P3', workRoot);
    db2.prepare('INSERT INTO wa_tasks (id, project_id) VALUES (?, ?)').run('T3', 'P2');
    db2.prepare('INSERT INTO wa_tasks (id, project_id) VALUES (?, ?)').run('T4', 'P3');
    db2.prepare('INSERT INTO wa_project_briefs (project_id, status, brief_json, updated_at) VALUES (?, ?, ?, ?)').run(
      'P3', 'ready',
      JSON.stringify({ stack: ['Vue3'], layout: [{ path: 'mini-mp/src', purpose: '小程序源码' }] }),
      '2026-11-09T00:00:00Z',
    );
    const realFetch = globalThis.fetch;
    const captured: string[] = [];
    globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
      let prompt = '';
      try {
        const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: Array<{ content?: unknown }> };
        const msgs = Array.isArray(body.messages) ? body.messages : [];
        prompt = String(msgs[msgs.length - 1]?.content ?? '');
      } catch { /* 留空 */ }
      captured.push(prompt);
      const content = JSON.stringify([{ criterion: '页面渲染正常', passed: true, reason: 'ok', evidence_refs: [] }]);
      return new Response(JSON.stringify({
        id: 'chatcmpl-b4', object: 'chat.completion', created: 0, model: 'rr-fake',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    try {
      const fakeAns = {
        getAnsClient: async () => ({
          getOptimalModel: async () => ({ url: 'https://rr.test/v1', api_key: 'k', model_name: 'm', max_output_tokens: 512 }),
        }),
        memory: null,
      } as never;
      const realCriteria = '页面 pages/worker/institution/institution.vue 渲染正常。';
      await checkAcceptanceCriteria(fakeAns, db2 as never, 'T3', realCriteria);
      await checkAcceptanceCriteria(fakeAns, db2 as never, 'T4', realCriteria);
      const noBrief = captured[0] ?? '';
      const withBrief = captured[1] ?? '';
      ok(noBrief.includes('验收标准') && !noBrief.includes('[项目须知（判卷用）]') && !noBrief.includes('框架通常如此'),
        'I24 无 ready 须知 ⇒ 判卷提示词不加项目段（与基线同形）');
      ok(withBrief.includes('[项目须知（判卷用）]') && withBrief.includes('技术栈：Vue3')
        && withBrief.includes('mini-mp/src：小程序源码') && withBrief.includes('不得因"框架通常如此"判通过'),
        'I25 有 ready 须知 ⇒ 判卷提示词带上限 ≤300 的项目上下文与"路径须存在"规则');
    } finally { globalThis.fetch = realFetch; }
  } finally { fs.rmSync(workRoot, { recursive: true, force: true }); }

  // ── I26 静态接线：三跳同在一处 + 拆解侧只认 ready ──
  // B6 按符号重定向：判卷入口搬至 `exec-acceptance.ts`，扫描面按真源扩展。
  const execCode = stripKeepingLines(fs.readFileSync(EXEC, 'utf-8')).join('\n')
    + stripKeepingLines(fs.readFileSync(EXEC_ACCEPT_SRC, 'utf-8')).join('\n');
  // zx_20261110_2 B6 按符号重定向：缺项核验升级为**来源阶梯**（own → 工作目录 → 同项目其他任务 → 快照），
  //   旧钉的"提取 → 基底 → 缺项"三跳仍须同在一处，只是第三跳改由 `resolveCriteriaPaths` 统一给出。
  ok(execCode.includes('criteriaPathRefs(criteria)') && execCode.includes('collectPathBases(workingDir)')
    && execCode.includes('resolveCriteriaPaths({'),
    'I26 判卷入口接上来源阶梯路径核验（提取 → 基底 → 阶梯解析三跳同在一处）');
  ok(/recordAcceptanceOutcome\(db, taskId, decided, \{\s*criteriaPathMissing: missing, ambiguousPaths: ambiguous, criteriaPathResolved: pathResolved/.test(execCode),
    'I27 缺项/歧义/已解析三态随账本落库（不是"只打日志"）');
  // zx_20261111_1 按符号重定向：`status` 改为"最近一次尝试的结局"，失败重跑时旧 `brief` 仍可用；
  //   注入判据从 `status==='ready'` 升级为**按内容**（`stored?.brief`）——更强真源，不是放宽。
  ok(execCode.includes('renderProjectBriefForJudge(stored.brief)') && execCode.includes('stored?.brief'),
    'I28 判卷上下文按须知内容注入（缺失不注入；失败重跑不丢上一份成功须知）');
  const decCode = stripKeepingLines(fs.readFileSync(DECOMPOSE_SRC, 'utf-8')).join('\n');
  ok(decCode.includes('loadProjectBrief(') && decCode.includes('stored?.brief'),
    'I29 拆解侧按须知内容选数（缺失不注入、不报错；不因一次失败静默丢认知）');
  ok(decCode.includes('projectBriefText') && decCode.includes('按框架习惯补上仓库里不存在的文件名'),
    'I30 拆解提示词有"禁臆造文件名"硬规则，由第 5 参按需注入');
}

// ══════════════════════════════════════════════════════════════════════
// B5：完成账可回查（判据回显 / 证据引用落账 / run 级幂等与留痕）
// ══════════════════════════════════════════════════════════════════════
async function sectionB5(): Promise<void> {
console.log('\n【J】B5 完成账可回查（判据回显 / evidence_refs / run_id 幂等）');
{
  // ── J1–J3 判据拆行 + 位置回填 ──
  eq(splitCriteriaLines('  一、甲\r\n\n 二、乙 \n'), ['一、甲', '二、乙'],
    'J1 判据拆行：按换行、去空白、丢空行、保序（不猜语义）');

  const order5 = ['甲：页面可打开', '乙：接口有值', '丙：无报错', '丁：字段齐全', '戊：文案正确'];
  const fiveBlind = Array.from({ length: 5 }, () => ({ passed: true, reason: 'ok' } as { criterion?: string; passed: boolean; reason: string }));
  const a5 = alignChecksToCriteria(fiveBlind, order5);
  eq([a5.criteriaTotal, a5.echoMissing, a5.unfilled, a5.deficit], [5, 0, 0, 0],
    'J2 模型回 5 条无 criterion ⇒ 按位回填后 0 缺失、总数 5');
  eq(a5.checks.map((c) => c.criterion), order5,
    'J3 回填文本与输入判据逐条一致（次序即输入次序，不重排）');

  const fourBlind = fiveBlind.slice(0, 4);
  const a4 = alignChecksToCriteria(fourBlind, order5);
  eq([a4.criteriaTotal, a4.echoMissing, a4.unfilled, a4.deficit], [5, 1, 0, 1],
    'J4 模型回 4 条 ⇒ 少回 1 条如实记回显缺失（总数仍取输入的 5）');

  // ── J5–J6 决策：对得上才判成；对不上记 criteria_echo_missing ──
  const d5 = decideAcceptanceOutcome({ kind: 'ok', text: null, checks: fiveBlind, criteriaOrder: order5 });
  eq([d5.outcome.ran, (d5.outcome as { passed?: boolean }).passed], [true, true],
    'J5 5 条全回填且全通过 ⇒ 正常判成（回填不改变判定）');
  const d4 = decideAcceptanceOutcome({ kind: 'ok', text: null, checks: fourBlind, criteriaOrder: order5 });
  eq([d4.outcome.ran, (d4.outcome as { reason?: string }).reason], [false, 'criteria_echo_missing'],
    'J6 4/5 对不上 ⇒ 结局 `criteria_echo_missing`（未判成，绝不冒名全过）');
  eq(d4.criteriaOrder, order5, 'J7 决策结果携带输入次序（供落账同一份回填）');

  // ── J8 载荷保留证据引用（通过项与拒收项都留） ──
  const pRef = buildAcceptanceCheckPayload([
    { criterion: '甲：页面可打开', passed: true, reason: 'ok', evidence_refs: ['run:abc12345'] },
    { criterion: '乙：接口有值', passed: false, reason: '无返回值', evidence_refs: ['file:src/api.ts:42'] },
  ]);
  eq([pRef.criteria_total, pRef.passed_total, pRef.verified], [2, 1, true],
    'J8 真核验载荷计数正确');
  eq([pRef.items?.[0]?.evidence_refs, (pRef.failed[0] as { evidence_refs?: string[] }).evidence_refs],
    [['run:abc12345'], ['file:src/api.ts:42']],
    'J9 `items[]` 与 `failed[]` 都保留 evidence_refs（完成账可回查引用了什么）');

  // ── J10–J11 落账：回显缺失也留明细与计数，且只动 acceptance_check ──
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', context_json TEXT DEFAULT '{}');
  `);
  db.prepare('INSERT INTO wa_tasks (id, context_json) VALUES (?, ?)').run(
    'T1', JSON.stringify({ goal: '兄弟键须保留', attachments: [{ id: 'a1' }] }),
  );
  const recorded = recordAcceptanceOutcome(db as never, 'T1', d4);
  eq([recorded.verified, (recorded as { reason?: string }).reason, recorded.criteria_total,
    recorded.passed_total, (recorded as { criteria_echo_missing?: number }).criteria_echo_missing],
  [false, 'criteria_echo_missing', 5, 4, 1],
  'J10 回显缺失照实落账：verified=false + 计数与缺数齐全');
  eq(acceptanceVerdictOf(recorded), 'unjudged', 'J11 载荷判定 = unjudged（finalize 据此置待人工，不冒名通过）');
  const rowCtx = JSON.parse((db.prepare('SELECT context_json FROM wa_tasks WHERE id = ?').get('T1') as { context_json: string }).context_json) as Record<string, unknown>;
  ok(rowCtx.goal === '兄弟键须保留' && Array.isArray(rowCtx.attachments)
    && (rowCtx.acceptance_check as { reason?: string })?.reason === 'criteria_echo_missing',
    'J12 落账只动 `acceptance_check` 一个键（兄弟键原样保留）');

  // ── J13–J16 run 标识与收口留痕 ──
  const runA = 'ABCD1234-5678-90ab-cdef-0123456789ab';
  eq(shortRunId(runA), 'abcd1234', 'J13 run 短码：小写取前 8 位（UUID 去连字符后截断）');
  ok(newRunId() !== newRunId() && newRunId().length === 36,
    'J14 每次运行生成互不相同的 run_id');
  eq(tagWithRun('[WARN] 世界模型审计：示例', runA), '[WARN] [run abcd1234] 世界模型审计：示例',
    'J15 行前缀插在等级标之后、正文之前');
  eq(tagWithRun('[WARN] [run abcd1234] 世界模型审计：示例', runA), '[WARN] [run abcd1234] 世界模型审计：示例',
    'J16 已带 run 前缀的行不重复插（幂等）');
  eq([tagWithRun('无等级的普通文本', runA), tagWithRun('[WARN] x', null)], ['无等级的普通文本', '[WARN] x'],
    'J17 无等级标 / 无 run_id ⇒ 原样返回（旧夹具不受污染）');

  const merged1 = mergeFinalizeChecks(['[INFO] 旧条目'], ['[INFO] 新条目一', '[INFO] 新条目二'], runA);
  eq(merged1, ['[INFO] 旧条目', '[INFO] [run abcd1234] 新条目一', '[INFO] [run abcd1234] 新条目二'],
    'J18 finalize_checks 合并：旧条目保留、新条目带 run 前缀');
  const merged2 = mergeFinalizeChecks(merged1, ['[INFO] 新条目二'], runA);
  eq(merged2, merged1, 'J19 相邻重复不追加（同一轮重复收口不胀账）');
  const merged3 = mergeFinalizeChecks(merged2, ['[INFO] 续跑条目'], 'eeeeffff-0000-0000-0000-000000000000');
  ok(merged3.length === 4 && merged3[0] === '[INFO] 旧条目'
    && merged3[3] === '[INFO] [run eeeeffff] 续跑条目',
    'J20 续跑追加到旧账之后、各自带自己的 run 前缀');

  const emitCtx: { completedRuns?: string[] } = {};
  eq([claimCompletedEmit(emitCtx, runA), claimCompletedEmit(emitCtx, runA), claimCompletedEmit(emitCtx, 'runB')],
    [true, false, true],
    'J21 同一 run 只发一条完成事件；换 run 再发');
  const fullCtx: { completedRuns: string[] } = { completedRuns: Array.from({ length: 10 }, (_, i) => `r${i}`) };
  claimCompletedEmit(fullCtx, 'r10');
  ok(fullCtx.completedRuns.length === 10 && fullCtx.completedRuns[9] === 'r10' && fullCtx.completedRuns[0] === 'r1',
    'J22 已发 run 名单有界 10 条（最旧滚出，不随续跑无限增长）');

  // ── J23–J28 静态接线：两个完成出口 / 两处 finalize_checks / 审计行前缀 ──
  // B6 按符号重定向：J28 的判卷入口在 `exec-acceptance.ts`，扫描面按真源扩展。
  const execCode = stripKeepingLines(fs.readFileSync(EXEC, 'utf-8')).join('\n')
    + stripKeepingLines(fs.readFileSync(EXEC_ACCEPT_SRC, 'utf-8')).join('\n');
  const closeCode = stripKeepingLines(fs.readFileSync(EXEC_CLOSE_SRC, 'utf-8')).join('\n');
  const finalizeCode = stripKeepingLines(fs.readFileSync(EXEC_FINALIZE_SRC, 'utf-8')).join('\n');
  const controlCode = stripKeepingLines(fs.readFileSync(CONTROL_FINALIZE_SRC, 'utf-8')).join('\n');
  const worldCode = stripKeepingLines(fs.readFileSync(WORLD_SRC, 'utf-8')).join('\n');
  ok(execCode.includes('ctx.runId = newRunId()') && execCode.includes('ctx.completedRuns = []'),
    'J23 每次执行入口生成新 run_id 并重置已发名单');
  ok(execCode.includes('if (claimCompletedEmit(ctx))') && execCode.includes('run_id: ctx.runId')
    && finalizeCode.includes('if (claimCompletedEmit(ctx))') && finalizeCode.includes('run_id: ctx.runId'),
    'J24 两个完成出口都经 `claimCompletedEmit` 且事件带 run_id（run 级幂等同在一处）');
  ok(controlCode.includes('mergeFinalizeChecks(ctxJson.finalize_checks, checks, ctx.runId)')
    && closeCode.includes('mergeFinalizeChecks(ctxJson.finalize_checks, [unverifiedInfo], ctx.runId)'),
    'J25 两处 finalize_checks 写口都经合并函数（不裸覆写旧账）');
  ok(execCode.includes('scan: auditScan, runId: ctx.runId'),
    'J26 审计调用把 run_id 传进世界模型审计');
  ok((worldCode.match(/tagWithRun\(/g) ?? []).length >= 5 && worldCode.includes('runId?: string'),
    'J27 世界模型审计的每条 INFO/WARN 都过 run 前缀');
  ok(execCode.includes('criteriaOrder: splitCriteriaLines(criteria)'),
    'J28 判卷入口把输入判据有序行喂给决策（回填与判定同源）');
}
}

sectionB2().then(sectionB3).then(sectionB4).then(sectionB5).then(() => {
  console.log(`\n汇总: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
