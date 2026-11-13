/**
 * zx_20261107_1 B7「实·通·信」受控回归 —— 项目详情/任务详情（老子·无为 / 米勒 7±2 / 坛经·自性）。
 *
 * 静态检查五件事（零网络 / 零 electron / 零时钟）：
 *   A 项目详情：首屏卡 ≤6（两两同域收成默认折叠组），交付物计数 **UI 单源**；
 *   B 任务详情：token 不再在徽标行重印（执行总数只由 `TaskHeader` 报），三笔执行外记账移入「记账明细」；
 *   C 流式合批：事件写 ref 缓冲、~100ms 落展示态；step_finished/状态切换/卸载清缓冲与定时器；
 *   D 默认展开恰 3 段（任务目标 / 验收标准核对 / 子任务族验收），其余低频块默认折叠；
 *   E 构建钉：build 标识与脚本轮次同值（派生核对，不写死轮次字面量）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { buildNotOlderThan, checkBuildPins, deriveBuildTag } from './lib/rr-pins.js';

const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'apps/worker-ant-desktop/renderer/src');
const DESKTOP = path.join(ROOT, 'apps/worker-ant-desktop/src/main');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const eq = (actual: unknown, expect: unknown, label: string) =>
  ok(JSON.stringify(actual) === JSON.stringify(expect), label, `${JSON.stringify(actual)} vs ${JSON.stringify(expect)}`);

const R = (rel: string) => fs.readFileSync(path.join(RENDERER, rel), 'utf-8');

function sectionA(): void {
  console.log('\n【A】项目详情：首屏卡 ≤6 + 计数 UI 单源');
  const src = R('pages/ProjectDetailPage.tsx');

  // A1 计数只派生一次
  eq((src.match(/const projectDeliverables = project\.deliverableStats;/g) ?? []).length, 1,
    'A1 交付物计数在页面只派生一处（`projectDeliverables`）');
  ok(!src.includes('project.deliverableStats?.total'),
    'A2 反证：统计卡不再越过派生变量直取 `project.deliverableStats?.total`');
  ok(!src.includes('deliverableSummary as Record<string, unknown>)?.total'),
    'A3 知识全景不再重印产出物总数（同一把尺只留统计卡一个落点）');
  ok(src.includes('Object.entries(projectDeliverables || {})'),
    'A4 知识全景的 byType 分项取自**同一个** `projectDeliverables`');
  // zx_20261112_2 B6：四张统计卡合并为首屏摘要 ⇒ 旧标签退场，产出物计数在摘要里**恰一处**。
  eq((src.match(/label:'产出物（项目合计）'/g) ?? []).length, 0,
    'A5 旧统计卡标签已退场（反证：不再与摘要并存）');
  eq((src.match(/projectDeliverables\?\.total/g) ?? []).length, 1,
    'A5b 产出物计数在首屏摘要里恰一处（仍走同一个派生变量）');
  ok((src.match(/主成果/g) ?? []).length <= 4 && src.includes('本任务（含子任务）'),
    'A6 关联页面的「本任务（含子任务）」分母说明仍在（同名不同分母的区分不丢）');

  // A7 卡片分组：顶层直挂 3 张独立卡 + 2 个折叠组 + 须知块 = 6
  const directMounts = [...src.matchAll(/^      <(\w+Card) projectId=\{id!\} \/>$/gm)].map((m) => m[1]);
  eq(directMounts, ['DeliveryDigestCard', 'ServiceCallCard', 'KnowledgeFaceCard'],
    'A7 顶层直挂的独立卡恰 3 张（其余收进折叠组）');
  // zx_20261113_4 B4：知识资产两张卡带 `onChanged`（画像/领域包动作后刷新首屏状态），
  //   故挂载形状允许 `projectId={id!}` 后的额外 props；仍按**组件名逐成员枚举**，不是放宽成"随便挂"。
  //   ⚠ 不能用 `[^>]*` 匹配额外 props：`onChanged={() => …}` 里的箭头也含 `>`，会把行截断。
  const groupedMounts = [...src.matchAll(/^        <(\w+Card) projectId=\{id!\}.*\/>$/gm)].map((m) => m[1]);
  // zx_20261113_1 B1：新增「岗位组」一张卡（ProjectPositionsCard）——同域卡五张，逐成员枚举不漏。
  eq(groupedMounts, ['NodeDivisionCard', 'CollabBoardCard', 'ProjectPositionsCard', 'KnowledgePackCard', 'KnowledgeInboxCard'],
    'A8 五张同域卡各就各位（协同组 2 + 岗位组 1 + 知识资产组 2），无一张被落下');
  // 加强：知识资产组两张卡与领域包卡都必须把动作结果回灌首屏（否则"生成后仍显示未成型"）。
  eq((src.match(/<Knowledge(?:Pack|Inbox)Card projectId=\{id!\} onChanged=\{\(\) => void loadBusinessStatus\(\)\} \/>/g) ?? []).length, 2,
    'A8b 知识包/收件箱卡在动作后刷新首屏业务知识状态');
  ok(/<DomainPackCard key=\{packTick\} projectId=\{id!\} onChanged=\{\(\) => void loadBusinessStatus\(\)\} \/>/.test(src),
    'A8c 领域包卡同样在动作后刷新首屏状态');
  ok(src.includes('协同（节点分工 · 协同看板）') && src.includes('岗位（谁来做 · 学到什么）') && src.includes('知识资产（知识包 · 知识收件箱）'),
    'A9 三个组各有人话组名（折叠不是藏起来，是先说是什么）');
  ok(src.includes('项目须知'),
    'A10 项目须知块仍在首屏（不因为凑 6 卡被误删）');

  // A11 运行配置/IM 命令下沉高级区，内容逐字未动
  ok(src.includes('高级：运行配置与 IM 命令'),
    'A11 运行配置与 IM 命令收进「高级」默认折叠区');
  ok(src.includes('本项目指定模型（留空=跟随全局/自动）') && src.includes('IM 命令 ('),
    'A12 折叠内容逐字未动（B6 项目级模型指定与 IM 命令表都还在）');
  ok(src.includes('优先级：恢复路（续跑沿用） &gt; 本项目指定 &gt; 全局默认') === false
    ? src.includes('优先级：恢复路（续跑沿用）&gt; 本项目指定 &gt; 全局默认')
    : true,
    'A13 模型优先级说明句未改');
}

function sectionB(): void {
  console.log('\n【B】任务详情：token 单源 + 徽标减法');
  const src = R('pages/TaskDetailPage.tsx');

  ok(!src.includes('{formatTokens(displayTokens)} tokens'),
    'B1 徽标行不再重印执行 token 总数（唯一落点是 `TaskHeader` 的 token 格）');
  ok(src.includes('记账明细'),
    'B2 三笔执行外记账有专门的「记账明细」行');
  ok(src.includes('· 旁路~{formatTokens(sideTokensCe)}') && src.includes('· 复盘~{formatTokens(bgReviewTokens)}'),
    'B3 旁路/复盘两笔字面仍在（旧套件钉住：移动位置，不丢内容）');
  ok(src.includes('· 预读~{formatTokens(preludeTokens)}'),
    'B4 预读一笔同族在场');
  ok(!src.includes('依据：{archetypeReason}'),
    'B5 形态的「依据」不再单列一枚徽标（已收进形态徽标 tooltip）');
  ok(src.includes('形态：{archetypeLabel}'),
    'B6 形态徽标本体仍在（减法只减重复，不减信息）');
  ok(src.includes('⚠ 未达成果门禁'),
    'B7 成果门禁警示仍在（减法不得减掉风险信号）');
}

function sectionC(): void {
  console.log('\n【C】流式合批');
  const src = R('pages/TaskDetailPage.tsx');

  ok(src.includes('streamTextBufRef') && src.includes('streamReasoningBufRef'),
    'C1 文本/推理双缓冲 ref 在场');
  ok(src.includes('window.setTimeout(flushStreamBuf, 100)'),
    'C2 合批节拍 ~100ms（唯一落地点）');
  ok(!src.includes('setStreamingText(prev => (prev + delta)'),
    'C3 反证：事件处理器不再逐 token setState');
  const clearCalls = (src.match(/clearStreamBuf\(\);/g) ?? []).length;
  ok(clearCalls >= 3,
    'C4 清缓冲覆盖状态切换（executing / 离执行态）与 step_finished（未落地的尾巴一并丢弃）',
    `实测 ${clearCalls} 处`);
  ok(src.includes('.slice(-4000)') && src.includes('.slice(-8000)'),
    'C5 展示上限仍是 4000 / 8000 字符（与改前同一口径）');
  ok(/return \(\) => \{ if \(timer\) clearTimeout\(timer\); clearStreamBuf\(\); unsubscribe\(\); \};/.test(src),
    'C6 卸载时清定时器（合批不得留下野定时器）');
}

function sectionD(): void {
  console.log('\n【D】默认展开恰 3 段，其余低频块默认折叠');
  const src = R('pages/TaskDetailPage.tsx');

  const wrapped: Array<[string, string]> = [
    ['子任务目的', '子任务目的'],
    ['执行健康度', '执行健康度 ({signalStream.length})'],
    ['产出物验证', '产出物验证 ({outputValidations.length})'],
    ['扬弃小结', '>本次扬弃小结</summary>'],
    ['任务复盘', '/>任务复盘</h4>'],
    ['方案里程碑', '📋 方案里程碑'],
    ['关联方案', '🔗 关联方案(规划)'],
    ['任务依赖关系', '任务依赖关系</h4>'],
    ['相似任务', '相似任务 ({similarTasks.length})'],
  ];
  for (const [name, needle] of wrapped) {
    const i = src.indexOf(needle);
    const near = i > 0 ? src.slice(Math.max(0, i - 500), i) : '';
    ok(i > 0 && near.includes('<details'),
      `D-折叠 ${name}：默认折叠（标题常显，展开看内容）`, i > 0 ? undefined : '锚点未找到');
  }

  // 从「条件锚点」向后量到「标题锚点」：中间必须已有常显容器且**没有** `<details>` 折叠壳。
  //   反向取前 N 字符不可靠——条件与实际标题之间可能夹着子任务实时带这类长块。
  const open: Array<[string, string, string]> = [
    ['任务目标', '/>任务目标<', 'goalInfo && (goalInfo.goal || goalInfo.principalContradiction) && ('],
    ['验收标准核对', '>验收标准核对 ', 'acceptanceVisible && acceptanceCheck && ('],
    ['子任务族验收', '📋 子任务族验收（', 'familyChildren.length>0 && ('],
  ];
  for (const [name, needle, cond] of open) {
    const c = src.indexOf(cond);
    const n = c >= 0 ? src.indexOf(needle, c) : -1;
    const between = n > c ? src.slice(c, n) : '';
    // zx_20261113_2 M14：验收块加了 `id="acceptance-check"`（横幅「查看验收块」的锚点）。
    //   按**新容器形状**重定向，不删断言、不放宽到"任意 div"。
    ok(c >= 0 && n > c
      && (between.includes('<div className="bg-white rounded-lg border p-4">')
        || between.includes('<div id="acceptance-check" className="bg-white rounded-lg border p-4">'))
      && !between.includes('<details'),
      `D-展开 ${name}：默认展开（关键三段不带折叠壳）`,
      c < 0 ? '条件锚点未找到' : n < 0 ? '标题锚点未找到' : `间隔 ${between.length} 字符${between.includes('<details') ? '（含折叠壳）' : ''}`);
  }

  ok((src.match(/<details className="bg-white rounded-lg border">/g) ?? []).length >= 9,
    'D-计数：默认折叠的低频块不少于 9 个');
  ok(/任务依赖关系[\s\S]{0,4000}＋ 添加前置/.test(src),
    'D-依赖面板：折叠后「＋ 添加前置」入口仍在面板内（常驻，否则改不了空任务）');
  ok(src.includes('本任务（含子任务）'),
    'D-产出物分母说明仍在（交付报告一格）');
}

function sectionE(): void {
  console.log('\n【E】构建钉');
  const { tag } = deriveBuildTag(fs.readFileSync(path.join(DESKTOP, 'core/agent-executor.ts'), 'utf-8'));
  ok(buildNotOlderThan(tag, SELF_ROUND), 'E1 build 标识不早于脚本轮次（方向性派生）', `${tag} vs ${SELF_ROUND}`);
  checkBuildPins(ok, { rootDir: ROOT });
}

sectionA();
sectionB();
sectionC();
sectionD();
sectionE();

console.log(`\n[rr_${SELF_ROUND}_gui] ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
