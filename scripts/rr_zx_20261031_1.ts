/**
 * zx_20261031_1 受控复跑 —— 「名器」：名当副实，器当称事。
 *
 * 病根（见 plans/improve/zx_20261031_1.md §1，真标本 2026-10-31 13:48 IM 试用）：
 *   ① 标题切分把**中文里的空格**当成句界 ⇒ `把这周本仓库的 git 提交整理成一份周报，…`
 *      落库标题成了 `把这周本仓库的`（IM 回执、GUI 任务卡、截图素材全跟着残句走）；
 *   ② 同一题面里 `git`/`周报` 都不在关键词表，落到长度兜底的 `.md` ⇒ `document`，
 *      而 `document` 按设计**不含 shell**（A-8 红线）⇒ 模型拿不到 `git log`，
 *      只能手算 `.git/logs` 的 Unix 时间戳，5 条提交里 4 条时刻错 80 分钟。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * §M1 判据 —— 切分纯函数（`core/im/task-input.ts`）。
 *   真标本标题完整、描述留余下指令；中文夹英文的空格不是句界；纯英文句子的切法与旧行为**逐字一致**
 *   （`fix login bug` ⇒ `fix`，反证没把英文规则一起改掉）；`@`/脚手架清洗顺序不变；50 字封顶仍生效。
 *
 * §M2 判据 —— 「git 聚合」判 analysis。
 *   真标本整句判 `analysis` 且 `source=keyword`（证明是**本条规则**接住的，不是家族/兜底碰巧）；
 *   三条负标本（撰写文档 / 生成报告 / 增加一份报告）仍判原档（两侧标本，承
 *   `feedback_predicate_needs_both_sides_specimen`）；analysis 工具面确含 shell 三件，
 *   document 工具面仍删 shell 三件（A-8 反证：本轮**没有**放宽 document）。
 *
 * §M3 判据 —— 接线（`feedback_equivalence_needs_wiring_criterion`）。
 *   `im-router.ts` 的建任务路**真的**调了 `splitTaskInput(msgText)`，旧内联正则 `cleaned.search(`
 *   在全 `src/main` 已零处；实现只此一份（恰一个 `function splitTaskInput`）。
 *
 * ── 纪律 ─────────────────────────────────────────────────────────────────────
 *   G-1 调生产导出，不复刻等价物；G-2 两侧标本；G-5 静态判据读原文（去注释仅在判「代码是否真调」时用）；
 *   G-6 零轮次字面量：本轮标识与方案路径由 `path.basename(__filename)` 派生。
 *   ⚠ 断言文案不得含 ✗/✓（全量汇总器按失败字形计数，见 feedback_rr_assertion_text_no_failure_glyph）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';
import { classifyArchetype, classifyArchetypeDetailed, availableToolNames, narrowToolFace } from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';
import { findTitleBoundary, splitTaskInput, TASK_TITLE_MAX } from '../apps/worker-ant-desktop/src/main/core/im/task-input.js';

let pass = 0; let fail = 0;

function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual); const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');
const MAIN = path.join(root, 'apps/worker-ant-desktop/src/main');
/** 静态判据读**原文**；仅在判「代码里是否真调」时先去注释。 */
const RD = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf-8');
const SELF_ROUND = path.basename(__filename).replace(/^rr_/, '').replace(/\.ts$/, '');

/** 真标本：用户 2026-10-31 13:48 发给工蚁的原话（含 @ 提及）。 */
const SPECIMEN = '把这周本仓库的 git 提交整理成一份周报，按模块分组，写到 docs/weekly-report.md。 @demo-weekly';
/** 50 字封顶标本：无任何句读，只能靠上限兜底。 */
const LONG_NO_PUNCT = '甲乙丙丁'.repeat(20);

function main(): void {
  // ═══ M1 切分纯函数 ═════════════════════════════════════════════════════════
  console.log('\n【M1】标题/描述切分：中文空格是排版，不是句界');
  {
    const real = splitTaskInput(SPECIMEN);
    eq(real.title, '把这周本仓库的 git 提交整理成一份周报',
      'M1-1 ★真标本标题完整到中文句读（旧实现止于「的 |git」的空格）');
    ok(real.description.includes('按模块分组') && real.description.includes('docs/weekly-report.md'),
      'M1-2 描述保留余下指令（模型仍能拼出完整要求）', real.description);

    const noSpace = splitTaskInput('把这周本仓库的git提交整理成一份周报，按模块分组，写到 docs/weekly-report.md。');
    eq([noSpace.title, noSpace.description], ['把这周本仓库的git提交整理成一份周报', '，按模块分组，写到 docs/weekly-report.md。'],
      'M1-3 去空格变体切在**同一个句读**上（是否切分不依赖那两处空格）');

    const en = splitTaskInput('fix login bug');
    eq([en.title, en.description], ['fix', 'login bug'],
      'M1-4 ★纯英文反证：空格仍为句界（旧行为逐字保留，没把英文规则一并改掉）');

    eq(splitTaskInput('用 React 做一个登录页').title, '用 React 做一个登录页',
      'M1-5 中文夹英文：无句读时整句作标题（空格不切）');

    eq(splitTaskInput('创建任务：复核Y1摘要，输出差异 @demo-weekly'),
      { title: '复核Y1摘要', description: '，输出差异' },
      'M1-6 @提及 + 建任务脚手架的清洗顺序不变（先清 @ 再清脚手架再切）');

    eq(splitTaskInput('写周报。补充说明').title, '写周报',
      'M1-7 中文句读仍是句界（不是把所有空格都放行）');

    eq(splitTaskInput(LONG_NO_PUNCT).title.length, TASK_TITLE_MAX,
      `M1-8 ${TASK_TITLE_MAX} 字上限仍生效（无句读长题的兜底）`);
    eq(TASK_TITLE_MAX, 50, 'M1-9 上限值与旧实现同值（50，未借机改动）');

    eq(findTitleBoundary('fix login bug'), 3, 'M1-10 边界函数：纯英文取首个空格');
    eq(findTitleBoundary('的git'), -1, 'M1-11 边界函数：空格两侧有汉字则不是界');
  }

  // ═══ M2 「git 聚合」判 analysis ══════════════════════════════════════════
  console.log('\n【M2】形态：取 git 事实做聚合 ⇒ analysis（自带 shell）');
  {
    const real = splitTaskInput(SPECIMEN);
    // 与执行器同形：agent-executor 用 `${title} ${description}` 判形态。
    const combined = `${real.title} ${real.description}`;
    const dec = classifyArchetypeDetailed(combined);
    eq([dec.archetype, dec.source], ['analysis', 'keyword'],
      'M2-1 ★真标本（标题+描述，与执行器同形）判 analysis，且是关键词规则接住的');
    ok(/git/.test(dec.reason) && /shell/.test(dec.reason),
      'M2-2 判定理由点名 git 与 shell（写进任务账的来源有据）', dec.reason);

    const negatives: Array<[string, string]> = [
      ['撰写 API 文档，覆盖全部端点与参数', 'document'],
      ['生成技术报告，总结本轮实施情况', 'document'],
      ['增加一份报告', 'document'],
    ];
    for (const [text, want] of negatives) {
      eq(classifyArchetype(text), want, `M2-3 负标本仍判 ${want}：「${text}」（规则不过宽）`);
    }

    const realTools = availableToolNames('analysis');
    ok(['execute_command', 'bash', 'git_clone'].every((n) => realTools.includes(n)),
      'M2-4 ★analysis 工具面确含 shell 三件（判对了形态，才拿得到 git log）',
      ['execute_command', 'bash', 'git_clone'].filter((n) => !realTools.includes(n)).join(',') || '三件齐');

    // A-8 反证：document 仍删 shell 三件——本轮**没有**放宽 document 类目。
    const all: Record<string, unknown> = Object.fromEntries(availableToolNames('code').map((n) => [n, {}]));
    const docFace = narrowToolFace('document', all);
    ok(['execute_command', 'bash', 'git_clone'].every((n) => docFace.removed.includes(n)),
      'M2-5 ★document 工具面仍删 shell 三件（A-8 红线未动）',
      docFace.removed.filter((n) => ['execute_command', 'bash', 'git_clone'].includes(n)).join(',') || '未删');

    // 反向顺序标本：聚合词在前、git 事实词在后，同样命中。
    eq(classifyArchetype('整理本周 git 提交，按模块分组'), 'analysis',
      'M2-6 聚合词在前的同一件事也判 analysis（任一顺序）');
  }

  // ═══ M3 接线：建任务路真的调了纯函数 ══════════════════════════════════════
  console.log('\n【M3】接线：恰一份实现，旧内联正则已除');
  {
    const imRouter = stripKeepingLines(RD('apps/worker-ant-desktop/src/main/services/im-router.ts')).join('\n');
    ok(/splitTaskInput\(msgText\)/.test(imRouter),
      'M3-1 ★im-router 建任务路调用 splitTaskInput(msgText)（等价的纯函数建了也得接上）');
    ok(!/cleaned\.search\(/.test(imRouter),
      'M3-2 旧内联切分 `cleaned.search(` 已零处（不留第二份实现）');
    ok(!/\[\\s，,。．\.！!\？\?；;、:：\]/.test(imRouter),
      'M3-3 旧边界字符类（把 \\s 当句界的那一串）已从 im-router 消失');

    const mainFiles: string[] = [];
    const walk = (dir: string): void => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, ent.name);
        if (ent.isDirectory()) walk(p);
        else if (ent.name.endsWith('.ts')) mainFiles.push(p);
      }
    };
    walk(MAIN);
    const definers = mainFiles
      .filter((f) => /function\s+splitTaskInput\s*\(/.test(stripKeepingLines(fs.readFileSync(f, 'utf-8')).join('\n')))
      .map((f) => path.relative(root, f));
    eq(definers, ['apps/worker-ant-desktop/src/main/core/im/task-input.ts'],
      'M3-4 全 src/main 恰一份 splitTaskInput 实现（一处真源）');
  }

  // ═══ S 哑雷自检 + build 钉 ═════════════════════════════════════════════════
  console.log('\n【S】哑雷自检 + build 钉（派生核对，不写轮次字面量）');
  {
    const selfLines = stripKeepingLines(RD(`scripts/${path.basename(__filename)}`)).join('\n');
    const selfPins = [...selfLines.matchAll(/(?<![A-Za-z0-9_])(?:build:\s*|ROUND\s*=\s*|includes\()'(zx_[0-9_]+)'/g)];
    ok(selfPins.length === 0, 'S1 本文件零 build 轮次字面量（G-6：不写"只为下一轮"的哑雷）',
      selfPins.map((m) => m[1]).join(',') || '0 处');
    ok(/zx_\d{8}/.test(SELF_ROUND) && fs.existsSync(path.join(root, `plans/improve/${SELF_ROUND}.md`)),
      'S2 方向性自指（由载体自身派生）：本轮方案文件在场', `plans/improve/${SELF_ROUND}.md`);
    ok(fs.existsSync(path.join(root, `scripts/rr_${SELF_ROUND}.ts`)),
      'S3 本套件在册（脚本名由载体派生）', `scripts/rr_${SELF_ROUND}.ts`);

    checkBuildPins(ok, { distDir: path.join(root, 'apps/worker-ant-desktop/dist') });
  }
}

// ⚠ `catch` 不可省：夹具/断言抛异常时若只挂 `finally`，进程会在 unhandled rejection 之前被带走 ⇒ 假绿。
try {
  main();
} catch (e: unknown) {
  console.error(`\n💥 rr_zx_20261031_1 未捕获异常（复跑**未跑完**，不得读作通过）：`, e);
  fail++;
} finally {
  console.log(`\n${fail === 0 ? '✅' : '❌'} rr_zx_20261031_1: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}
