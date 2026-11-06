/**
 * zx_20260911_1 受控复跑（「门禁判型」归位——一条判据，一场语言游戏）。
 *
 * 病（真库事故 5739ce1f「20260910功能优化」被反复拦截，逐字见 data/baseline_zx_20260911_1.json）：
 *   ① 内容门禁**按登记标签/任务原型判型**，拿"文档的尺子"去量 .py 代码 → 三个辅助脚本被判
 *      insufficient/confidence 0，而 document 规则要求正文含"结论/总结"——Python 脚本天然没有，
 *      这道闸**在设计上不可能通过**（误登记源头是系统自己的工具说明书："工具模块请用type=doc"）。
 *   ② 唯一有用的诊断 quickCheck.issues(「缺少结论/总结」)被算出来后**丢弃**（两条门禁只取 llmCheck 两字段），
 *      拒收文案却说"请根据校验反馈补全"——反馈是空的；且通知写 role='system'，恢复回放(:2851)逐字跳过 ⇒ 送不到。
 *   ③ 目标偏离检测每 5 步只读最近 3 条 assistant 消息，输入无门禁状态 ⇒ "围着门禁打转"被读成"跑偏"，
 *      两次到顶交人工。
 *
 * 修（判据的归属）：
 *   M1 判型由**产物本身**定（archetypeForFile，看扩展名，不问标签）；code 规则语言中立 + 修一处失效转义；
 *      code 原型止于结构快检；缓存复用加原型一致性判据；工具说明书去混说。
 *   M2 诊断落库(issues) + 拒收文案带出具体原因 + 内容门禁通知改 user 角色（可达）。
 *   M3 偏离检测补事实输入(buildDeviationContextBlock)，cap/节流/abort **一字不动**。
 *
 * 断言分两类：
 *   S0 **行为探针**——动态/静态 import 真实模块，在**函数返回值**上证判型与诊断（扫源码验不出"同一个 .py
 *      在两个原型下结论不同"这类事实）。
 *   S1–S9 **源/产物断言**——静态扫描；注释一律先 stripComments 再比对（zx_20260910_3/_4 两次踩假阳性坑）。
 *
 * 本文件不连任何 DB（真库实证见 data/baseline_zx_20260911_1.json 与方案 §〇）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { archetypeForFile, buildDeviationContextBlock, formatInsufficiencyReasons } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { validateOutput } from '../apps/worker-ant-desktop/src/main/core/output-validator.js';
import { checkBuildPins } from './lib/rr-pins.js';
import { engineSrc } from './lib/rr-engine-src.js';

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}
const ROOT = path.join(__dirname, '..');
const rd = (f: string) => fs.readFileSync(path.join(ROOT, f), 'utf-8');
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const EXE = 'apps/worker-ant-desktop/src/main/core/agent-executor.ts';
const OV = 'apps/worker-ant-desktop/src/main/core/output-validator.ts';
const ACCT = 'apps/worker-ant-desktop/src/main/core/task-accounting.ts';
const exeRaw = engineSrc();
const exe = stripComments(exeRaw);
const ovRaw = rd(OV);
const ov = stripComments(ovRaw);
const acct = stripComments(rd(ACCT));
// zx_20261028_2 M3：finalize 门的内容校验移入工具体（`runFinalizeTask`），两门并看须读它。
const cf = stripComments(rd('apps/worker-ant-desktop/src/main/core/tools/control-finalize.ts'));

(async () => {
  console.log('S0 行为探针：archetypeForFile 判型 / 同一 .py 在两原型下结论不同 / buildDeviationContextBlock / formatInsufficiencyReasons');
  {
    ok(typeof archetypeForFile === 'function', '★真源函数 archetypeForFile 已导出且可 import（判型成为产物的属性）');
    ok(typeof buildDeviationContextBlock === 'function', '★buildDeviationContextBlock 已导出且可 import（可测，不靠"源码里有"交差）');
    ok(typeof formatInsufficiencyReasons === 'function', '★formatInsufficiencyReasons 已导出且可 import');

    if (typeof archetypeForFile === 'function') {
      const codeCases = ['.py', '.ts', '.tsx', '.js', '.go', '.rs', '.sh', '.java', '.kt', '.sql', '.vue'];
      // zx_20260922_1 M3：判型由两档扩为三档。原 `.json`/`.yaml` 落在 docCases 里、断言它们判 'document'——
      // 那是**旧尺**的写照（配置文件被当文档量）。此处按新尺**拆成 configCases 单独断言**（非放宽：
      // 两档时"非代码即文档"是恒真的废话，三档后"这几类**必须**是 configuration 而**不是** document"
      // 才是能证伪的判据）。`''`/`.html` 仍留 docCases——它们确非配置。
      const configCases = ['.xml', '.json', '.yaml', '.yml', '.toml', '.properties', '.ini', '.conf', '.example'];
      const docCases = ['.md', '.markdown', '.txt', '.html', ''];
      const badCode = codeCases.filter((e) => archetypeForFile(`/tmp/a/b/x${e}`) !== 'code');
      const badDoc = docCases.filter((e) => archetypeForFile(`/tmp/a/b/x${e}`) !== 'document');
      const badCfg = configCases.filter((e) => archetypeForFile(`/tmp/a/b/x${e}`) !== 'configuration');
      ok(badCode.length === 0, `★代码扩展名 ${codeCases.length} 类 → 'code'`, badCode.join(','));
      ok(badDoc.length === 0, `★非代码非配置扩展名 ${docCases.length} 类 → 'document'（零削弱，沿用既有默认）`, badDoc.join(','));
      ok(badCfg.length === 0, `★配置扩展名 ${configCases.length} 类 → 'configuration'（M3 新档；此前一律误落 'document'）`, badCfg.join(','));
      ok(archetypeForFile('/tmp/a/b/.env') === 'configuration', "★整名即扩展名的 `.env` 亦判 'configuration'（path.extname('.env') === ''，靠 basename 兜住）");
      ok(archetypeForFile('/tmp/a/b/pom.xml.example') === 'configuration', '★复合后缀 `pom.xml.example` 判 configuration（活标本里那批 *.json.example 的同类）');
      ok(archetypeForFile('/tmp/A/B/X.PY') === 'code', '★扩展名大小写不敏感（.PY → code）');
      ok(archetypeForFile('') === 'document' && archetypeForFile(undefined as unknown as string) === 'document', '空/未定 → document（不误判为代码）');
    }

    // 同一个 .py：code 判据通过、document 判据判不足（复现事故"同一文件在两套尺子下命运相反"）
    const tmpPy = path.join(os.tmpdir(), `rr_20260911_1_${process.pid}.py`);
    const pyBody = [
      '#!/usr/bin/env python3',
      '# -*- coding: utf-8 -*-',
      'import os',
      'import sys',
      'from typing import List',
      '',
      'def check_alert(rows: List[dict]) -> List[dict]:',
      "    return [r for r in rows if r.get('level') == 'high']",
      '',
      'class Reporter:',
      '    def __init__(self, name: str) -> None:',
      '        self.name = name',
      '',
      '    def emit(self) -> None:',
      "        print('[%s] ok' % self.name)",
      '',
      'if __name__ == "__main__":',
      '    Reporter("verify").emit()',
      '# padding line to exceed 500 bytes so the ONLY document-rule miss is the conclusion clause',
      '# ' + 'x'.repeat(400),
    ].join('\n') + '\n';
    fs.writeFileSync(tmpPy, pyBody, 'utf-8');
    try {
      // zx_20260922_1 M7（F9）**就地改钉（非放宽）**：原调用形状为
      //   `validateOutput(null, tmpPy, '校验推送脚本', 'code')`——第 3 参是**任务题面**、第 4 参才是判型。
      //   M7 把题面入口整个拆掉（签名收成三参），第 4 参被 JS 静默丢弃 ⇒ 判型读到的成了那句题面，
      //   本组"同一文件换判型得不同结论"的对比**整个失去意义**（4 条断言连红，正是这处暴露的）。
      //   改钉后**更强**：判型由第 3 参直达，恰是本组要说的事——**结论只由判型决定，无题面可插嘴**。
      const rCode = await validateOutput(null as never, tmpPy, 'code');
      ok(rCode.status === 'ok' && rCode.sufficient === true, '★同一 .py 按 code 判据 → ok/sufficient（结构性快检通过）');
      ok(!('llmCheck' in rCode), '★code 原型止于快检——不调 LLM（llmCheck 不存在；此处 ansClient 为 null 亦未抛错）');
      ok((rCode.quickCheck?.issues ?? []).length === 0, 'code 快检 0 问题');

      const rDoc = await validateOutput(null as never, tmpPy, 'document');
      ok(rDoc.status === 'insufficient' && rDoc.sufficient === false, '★同一 .py 按 document 判据 → insufficient（复现事故）');
      ok((rDoc.quickCheck?.issues ?? []).some((s) => s.includes('结论/总结')),
        '★document 判据给出的诊断是"缺少结论/总结"（此前被丢弃、反馈为空的那条）', JSON.stringify(rDoc.quickCheck?.issues));
    } finally {
      try { fs.rmSync(tmpPy, { force: true }); } catch { /* ignore */ }
    }

    if (typeof buildDeviationContextBlock === 'function') {
      ok(buildDeviationContextBlock({}) === '', '无阻塞 → 返回空串（判定器行为与从前一致，不注入任何东西）');
      const b1 = buildDeviationContextBlock({
        output_validations: [
          { file: '/a/b/_verify_20260910_fix.py', status: 'insufficient', issues: ['缺少结论/总结'] },
          { file: '/a/b/报告.md', status: 'ok', issues: [] },
        ],
      });
      ok(b1.includes('_verify_20260910_fix.py') && b1.includes('缺少结论/总结'), '★有阻塞 → 事实块含文件名与原因', b1);
      ok(!b1.includes('报告.md'), '已通过的文件不进入事实块');
      const b2 = buildDeviationContextBlock({ deliverable_unfulfilled: { paths: ['/a/b/patch_x.py'] } });
      ok(b2.includes('patch_x.py'), '★无 output_validations 但有未满足产出 → 亦成事实块');
    }

    if (typeof formatInsufficiencyReasons === 'function') {
      ok(formatInsufficiencyReasons([{ file: '/a/b/x.py', reasons: ['缺少结论/总结'] }]).includes('x.py：缺少结论/总结'),
        '★逐文件带出具体原因（不再是"请根据校验反馈补全"的空话）');
      const blank = formatInsufficiencyReasons([{ file: '/a/b/y.md', reasons: [] }]);
      ok(blank.includes('校验器未给出具体原因'), '★两者皆空 ⇒ 如实说"校验器未给出具体原因"（不写空话）', blank);
      ok(formatInsufficiencyReasons([]) === '', '空输入 → 空串');
    }
  }

  console.log('S1 两条门禁的判型归位（按产物本身，不再按标签/任务原型）');
  {
    // zx_20261028_2 M3 **就地改钉（非放宽）**：两条门禁都改走 `validateOutputs` 批量面（有界并发），
    //   finalize 侧不再有 `const arch = …` 单行（判型在 targets 映射里）⇒ 按旧形状计数必红。
    //   改钉**更强**的新真源：两侧各**逐文件判型**（判型随每条目标走），且收口门只剩批量调用一处。
    ok((exe.match(/archetypeForFile\(abs\)/g) || []).length >= 1
      && cf.includes('archetype: archetypeForFile(abs)'),
      '★finalize 门与收口门均逐文件判型（各按产物本身）',
      `收口侧 ${(exe.match(/archetypeForFile\(abs\)/g) || []).length} 处 · finalize 侧映射 ${cf.includes('archetype: archetypeForFile(abs)')}`);
    ok(!exe.includes("abs, fText, 'document')"), '★finalize 门不再硬编码字面量 \'document\'');
    // zx_20260922_1 M7（F9）**就地改钉（非放宽）**：原两条钉的是"第三参跟的是 `arch` 而不是 `archetype`"——
    //   那仍是在钉"**题面被传进去了**，只是后面跟的判型对了"。M7 把"题面"这条入口整个拆掉（`validateOutput`
    //   签名收成三参），故此处改钉**更强**的新真源：调用形状里**根本不再出现任务题面**，判型 `arch` 收尾。
    ok(!exe.includes('`${title} ${description}`, arch)'), '★收口门不再把**任务题面**递给文件判据（旧形状 `${title} ${description}`, arch 已离场）');
    ok(exe.includes('validateOutputs(ansClient as never, missTargets)')
      && !exe.includes('validateOutput(ansClient as never, abs, arch)'),
      '收口门调用形状：批量面一次问完（判型随每条目标），逐文件直呼 `validateOutput` 已离场');
    // ⚠ 不得改写成 `!exe.includes('`${title} ${description}`')`——该表达式在本文件里另有 7 处**正当**用途
    //   （判原型 / 抽声明产出路径 / 记忆分类 …），那样写会扫出一片假红。判据须认得"车牌照"，不是"这两个字"。
  }

  console.log('S2 code 规则语言中立 + 失效转义已修');
  {
    ok(/fn\|func\|#include/.test(ovRaw), '★requiredPatterns 含 fn/func/#include（Go/Rust/C 亦算代码构造）');
    ok(/def\|class\|function/.test(ovRaw), 'requiredPatterns 含 def/class/function（Python/JS 口径保留）');
    ok(!ov.includes('\\u2705'), '★旧的失效转义已删——它实为字符类 {\\,u,2,7,0,5,1,3}，"TODO: 下轮修"因含 2 被误放行（注释里提到旧写法不算，故在 stripComments 后比对）');
    ok(/TODO\|FIXME/.test(ovRaw) && /✅\|✓\|已完成/.test(ovRaw), '★禁止项改为真 Unicode：/(?:TODO|FIXME)(?![^\\n]*(?:✅|✓|已完成))/');
  }

  console.log('S3 code 原型止于结构快检（实践论：代码判据是"能不能跑通"）');
  {
    // zx_20260922_1 M3 就地改钉（**非放宽**）：原断言写死 `if (archetype === 'code')` 这个**字面形状**，
    //   而 M3 把配置档并进了同一支 ⇒ 按旧字面比对必红。改钉**行为更强**的新真源：既要 code 仍在支内
    //   （zx_20260911_1 M1 的既定裁定不得被撤），又要 configuration 也在支内（M3 新档不许只过词表尺、
    //   再被文档判据的 LLM 补一刀）。两条各自可证伪，比原来那条"存在即通过"的更强。
    // ⚠ 扫描面：`archetype ===…` 的分支**不止一条**（zx_20261003 M1 之后又添了 `=== 'media'` 一条）
    //   ⇒ 取**提到 code/configuration 的那一条**来判，而非"文件里第一条"。若有人把 code 与 configuration
    //   拆成两条，find 命中 code 那条、configuration 缺失 ⇒ 仍判红（敏感性不减）。
    const archetypeGuards = ov.match(/if \(archetype ===[^)]*\)/g) ?? [];
    const earlyGuard = archetypeGuards.find((g) => g.includes("'code'") || g.includes("'configuration'")) ?? '';
    ok(earlyGuard.includes("'code'"),
      '★validateOutput 内有 code 早返回分支（止于结构快检——M1 裁定仍在）', earlyGuard.trim());
    ok(earlyGuard.includes("'configuration'"),
      '★同支现已**同时**覆盖 configuration（zx_20260922_1 M3：配置档不许只过结构尺、再被"文档判据"的 LLM 补刀）', earlyGuard.trim());
    ok(/\{ sufficient: true, status: 'ok', confidence: 0\.7, quickCheck: quick \}/.test(ov), 'code 早返回结论为 ok/sufficient（不冒充高置信）');
    const iCode = ov.indexOf("archetype === 'code'");
    const iLlm = ov.indexOf('llmSufficiencyCheck(ansClient');
    ok(iCode > 0 && iLlm > 0 && iCode < iLlm, '★code 分支在 LLM 校验之前返回（不白耗旁路 LLM）');
    // zx_20260922_1 M7（F9）就地改钉：原钉 `llmSufficiencyCheck(ansClient, filePath, taskDescription)`，
    //   并把它读作"LLM 校验照旧（刻意不改）"。那个形状**正是本批要拆的病根**——第三参是**任务题面**，
    //   于是"门禁问的是任务、答出来的记在文件名头上"。改钉后更强：入参只剩 (client, file, 判型)。
    ok(/const llm = await llmSufficiencyCheck\(ansClient, filePath, archetype\);/.test(ov),
      '★LLM 腿入参只余 (client, 文件, 判型)——**任务题面这条路已被拆掉**（document/analysis/research 仍走 LLM 腿，'
      + '变的只是问句的主语）');
    ok(!ov.includes('taskDescription'),
      '★那条通路的**名字**一并消失：`taskDescription` 在 `output-validator.ts`（去注释面）**零处**残留'
      + '（不是"改名留着"，是拆掉）');
  }

  console.log('S4 缓存复用加原型一致性判据（存量误判自愈）');
  {
    // zx_20260923 M3 就地改钉（**非放宽**）：原钉的是 run 收口处**内联**的
    //   `hit.entry.archetype === arch` 这个字面形状；M3-a 把「签名 + 判型 + **判据版本**」四条件
    //   收进一处真源 `canReuseOutputValidation`。改钉到更强的新真源，**两条各自可证伪**：
    //   ① 守卫确实改调真源，且内联旧形态**零残留**（不是"新函数加了、老判据留在原地"）；
    //   ② 判型那条**仍在真源函数体内**——改钉不是把条件顺手删掉换个绿灯，那才是放宽。
    ok(exe.includes('canReuseOutputValidation(hit, arch)') && !exe.includes('hit.entry.archetype === arch'),
      '★原型不一致则不复用（历史 .py 缓存记的是 document，自动重判）：run 收口改调一处真源 '
      + '`canReuseOutputValidation(hit, arch)`，内联旧判据零残留');
    ok(ov.includes('hit.entry.archetype === arch'),
      '★且判型那条**仍在真源函数体内**（改钉不是删条件换绿灯）');
  }

  console.log('S5 诊断落库 + 拒收文案带原因 + 通知可达（user 角色）');
  {
    // zx_20261028_2 M3 **就地改钉（非放宽）**：两门改批量面后，逐文件结果直接取 `r.quickCheck/issues`，
    //   旧单数 `v.quickCheck` 形状离场。改钉的两侧各自可证伪：finalize 侧落库行含 reason、
    //   收口侧实判/缓存两条来路都带出 issues。
    ok(cf.includes('issues, missingAspects, suggestion, reason: r.reason') && exe.includes('issues: r.quickCheck?.issues ?? []'),
      '★两条门禁落库均含 issues（finalize 侧并落未知原因 reason，收口侧实判来路）',
      `finalize ${cf.includes('issues, missingAspects, suggestion, reason: r.reason')} · 收口 ${exe.includes('issues: r.quickCheck?.issues ?? []')}`);
    ok(exe.includes('issues: r.quickCheck?.issues ?? []') && exe.includes('missingAspects: r.llmCheck?.missingAspects ?? []'),
      '实跑路径取批量校验结果的 quickCheck.issues / llmCheck.missingAspects');
    ok(exe.includes('issues: Array.isArray(hit.entry.issues)') , '缓存复用分支亦带出 issues（否则命中缓存的拒收仍是空反馈）');
    ok(exe.includes('formatInsufficiencyReasons(insuffReasons)'), 'finalize 拒收文案带出具体原因');
    ok(exe.includes('formatInsufficiencyReasons(contentReasons)'), '收口拒收文案带出具体原因');
    ok(!exe.includes('reasons: contentReasons'), '★不落重复的 deliverable_unfulfilled.reasons（三处生产者同形；原因已由 issues + 会话消息承载，再存一份无人读的即「做了没用上」）');
    ok(!exe.includes('请根据校验反馈补全'), '★不再残留"请根据校验反馈补全"这句空话');

    // 全文件有两条 `taskId, msg)` 插入（早先的存在性门禁用 system），故按行取"含 user 的那条"存在性判定
    const msgInserts = exe.split('\n').filter((l) => l.includes('INSERT INTO wa_task_conversations') && l.includes('taskId, msg)'));
    ok(msgInserts.length > 0 && msgInserts.some((l) => l.includes("'user'")),
      '★内容门禁通知以 user 角色写入（system 行在 :2851 恢复时被逐字跳过，反馈送不到）',
      `共 ${msgInserts.length} 条 msg 插入`);
    ok(exe.includes('[产出内容不充分]'), '保留 [产出内容不充分] 前缀供人机双方识别');
  }

  console.log('S6 偏离检测补事实输入（只补事实，不松闸）');
  {
    ok(exe.includes('buildDeviationContextBlock(gateCtx)'), '★调用点传入事实块');
    // zx_20260915 M4/P0-6(e) 同步：签名在 **goal 之后**插入 `successCriteria`（第 3 参），并在**尾部**追加
    // `toolNames`（第 7 参）——两者同受开关 `engine.deviation_full_input`，故调用点不再是单行字面量。
    // 本组断言因此**按位置**校验（事实块仍是第 6 参），而非钉死一整行字符串（那会连"调用点多一行"都判红）。
    const sigAt = exe.indexOf('async function checkGoalDeviation(');
    const callAt = exe.indexOf('await checkGoalDeviation(');
    const callBlk = exe.slice(callAt, exe.indexOf(');', callAt) + 2);
    ok(callAt > 0 && callBlk.includes('buildDeviationContextBlock(gateCtx)'),
      '★事实块仍接到 checkGoalDeviation（M4 起为第 6 参 blocks 位——前有 goal/successCriteria/recentText/ctx）');
    ok(callBlk.includes('fullDeviationInput ? recentToolNames : []'),
      '★工具名尾参受 `engine.deviation_full_input` 门控（关 ⇒ 传空数组，逐字回到本轮前）');
    // zx_20260917 M5c 同步：**同法**再追加两个可选尾参 `completedItems`（已完成项账本）/`userDirective`
    // （用户最近指令）——前 7 参一位未动（本组断言的靶心即"前 7 参位置"），新增参数只在 `toolNames` 之后。
    ok(/async function checkGoalDeviation\(\s*ansClient: unknown,\s*goal: string,\s*successCriteria: string,\s*recentText: string,\s*acc\?: \{ sideTokens\?: number \},\s*blockers\?: string,\s*toolNames\?: readonly string\[\],\s*completedItems\?: string,\s*userDirective\?: string,?\s*\)/.test(exe.slice(sigAt, sigAt + 500)),
      '★签名在案：successCriteria 紧随 goal（第 3 参）、toolNames 为**可选尾参**（第 7 参，旧调用点不传亦编译通过）');
    // ⚠ 本组**只**改上面那条正则（被签名变更顶红而必须同步），**不顺手加活**——
    //    两个新尾参的"确已接到调用点"由 M5c 自己的判据 K 在 `rr_zx_20260917.ts` 里正面钉住。
    ok(exe.slice(sigAt, sigAt + 400).includes('acc?: { sideTokens?: number }'),
      '★旁路 token 账（acc）仍是可选形参——"只补事实"的账口未变');
    // `硬门禁拦截` 那段文案 M4 起搬进纯函数 `buildDeviationPrompt`（可被 rr 直跑），仍在同文件内。
    ok(exe.includes('硬门禁拦截'), 'prompt 增补"存在硬门禁拦截…不得仅因此判为偏离核心目标"');
    ok(exe.includes('export function buildDeviationPrompt'), '★文案由可测纯函数派生（M4：rr 直跑真实现，不再复刻一份实现自我印证）');
  }

  console.log('S7 防反向漂移（本轮不得为修 ①/③ 而松闸）');
  {
    ok(ovRaw.includes("'结论/总结'") && ovRaw.includes('(?:结论|总结|建议|综上所述)'), '★document 规则一字未改：结论/总结 仍是硬要求');
    ok(ovRaw.includes('minSize: 500'), '★document minSize 500 未调低');
    ok(/const GOAL_DEVIATION_MAX_RESTARTS = 2;/.test(acct), '★偏离上限仍为 2（未放宽）');
    ok(/if \(!goalDeviationCapReached\(restarts\)\)/.test(exe), '额度自增仍受上限守卫（未取消）');
    ok(exe.includes("controller.abort(new Error('goal_deviation_restart'))"), '★abort 恒发仍在（到上限必交人工的不变量不押在入口完整性上）');
    ok(/if \(retries < 1\) \{/.test(exe), '★重试语义未改：<1 自动恢复一轮');
    // zx_20260917 M1: 告因改经唯一写入口的 `note`（pauseTask → markPauseNeeded），
    // 语义不变：该暂停仍置停、仍告知创建人——判据随落点改钉 `pauseTask(… note: 产出内容多次未通过充分性校验…)`。
    ok(exe.includes('pauseTask(db, { taskId, reason: PAUSE_REASON_OUTPUT_INSUFFICIENT, note: `产出内容多次未通过充分性校验：'), '★≥1 暂停待人工 + 通知创建人仍在');
    ok(ovRaw.includes("label: '占位符内容'"), 'document 占位符禁用项仍在（未顺手删）');
  }

  console.log('S8 run_features.build 已刷新为本轮（派生一致性，非字面量）');
  {
    // 订正（M5 落地时）：原为字面量钉 `build: 'zx_20260911_5'` + 反向残留 `!/build: 'zx_20260911_4'/`
    // （每开新轮须手改，逐轮滚长）。改为**派生一致性**：真源＝agent-executor.ts 的那一处 build 值；
    // P1「恰好一处」**严格强于**原反向钉，P6 亦核对产物同值（原 S9 的 `blob.includes('zx_…')` 子串判定
    // 会被产物**注释里的轮次名**假阳性命中，本轮实测坐实，故一并由 P6 的"取产物 build 值本身"取代）。
    // 见 plans/improve/zx_20260912.md §M5 与 scripts/lib/rr-pins.ts。
    checkBuildPins(ok, { distDir: path.join(ROOT, 'apps/worker-ant-desktop/dist') });
  }

  console.log('S9 端到端产物证据（实践论：只验源码不算数，须在构建产物内实测）');
  {
    const distDir = path.join(ROOT, 'apps/worker-ant-desktop/dist');
    let files: string[] = [];
    try { files = fs.readdirSync(distDir).filter((f) => f.endsWith('.js')); } catch { /* 未构建 */ }
    const blob = files.map((f) => fs.readFileSync(path.join(distDir, f), 'utf-8')).join('\n');
    ok(files.length > 0, `dist 构建产物在位（${files.length} 个 .js）`, files.length ? '' : '(请先 tsup)');
    ok(blob.includes('archetypeForFile'), '★产物内含判型真源 archetypeForFile');
    ok(blob.includes('buildDeviationContextBlock'), '★产物内含偏离事实块函数 buildDeviationContextBlock');
    ok(blob.includes('formatInsufficiencyReasons'), '★产物内含拒收原因格式化函数 formatInsufficiencyReasons');
    ok(blob.includes('#include'), '★产物内含语言中立的 code 判据（#include 锚点，esbuild 未破坏正则字面量）');
    // 订正（M5 落地时）：原 `blob.includes('zx_…')` 子串判定已由 S8 的 checkBuildPins P6 取代（取产物 build **值本身**、更强）。
  }

  console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
  process.exit(fail === 0 ? 0 : 1);
})();
