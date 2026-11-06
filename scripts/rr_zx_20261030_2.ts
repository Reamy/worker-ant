/**
 * zx_20261030_2「器」受控回归 —— 名正、器利、止有时。
 *
 * 九组判据（照方案 §4.1）：
 *   N 形态：真标本「增加用户禁用功能」判 code；反向两只不判 code；
 *     `classifyArchetypeDetailed` 的 keyword / family / fallback 三态各一且理由非空。
 *   E 工具面：builder 白名单与说明书都含 edit_file；deny 赢过 allow；
 *     restored 只列「档外但被显式允许」；**说明书声明数 = 最终工具面键数**（旧形说上一刀之后的数即红）。
 *   W 等子：有在跑的子 ⇒ 置停（因 children_incomplete、不传 note）；无未完成子 ⇒ 不暂停；
 *     全暂停 ⇒ 不自行等；终态子不计；多余参数报错不暂停；pauseTask 不受理 ⇒ 如实回 not_paused。
 *   A 验收：摘要带理由、超上限恰 3 条 + 「另 N 条」、空理由标「未说明」；
 *     候选卡逐字含同一摘要（记忆与卡同源），长文案截断仍带指针且不超预算。
 *   S 步文本：收口增量四支；三步 31/38/40 拼接 ⇒ 0 条聚合正文；改写如实落账。
 *   B 简报：标记行括号配对（命令里的「; 」不切断）、计数不截断、role='tool' 结果行不算标记；
 *     简报与恢复摘要共用同一标记行真源，优先级 = 完成摘要 > 工具摘要 > 末条 assistant。
 *   G 审计：自身流转不报、直接子计入、无关任务不入；缺省（不传 scope）旧行为不变。
 *   Q 覆盖：override > node > 自动；非法值当没写；GUI 七态来源与覆盖写口在册。
 *   H 构建钉与收口卫生。
 *
 * 纪律：零网络 / 零 electron；夹具自建 DDL（列形状照抄生产）；计数器带 0→1 正面断言；
 *   不以真实墙钟为判据；本套件不自写「只为下一轮」字面量。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  availableToolNames,
  applySubagentToolScope,
  buildToolFaceBrief,
  classifyArchetype,
  classifyArchetypeDetailed,
  narrowToolFace,
  type TaskArchetype,
} from '../apps/worker-ant-desktop/src/main/core/task-archetype.js';
import { closeTextDelta, resolvePinnedArchetype } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { summarizeAcceptanceFailures } from '../apps/worker-ant-desktop/src/main/core/acceptance-check.js';
import { recordPitfallCandidate } from '../apps/worker-ant-desktop/src/main/core/knowledge-cards.js';
import { digestToolTurns, formatDigest, parseToolMarkers } from '../apps/worker-ant-desktop/src/main/core/tool-digest.js';
import { SUBAGENT_TYPES } from '../apps/worker-ant-desktop/src/main/core/subagent-registry.js';
import { TOOL_METAS } from '../apps/worker-ant-desktop/src/main/core/tool-registry.js';
import { resourceTools } from '../apps/worker-ant-desktop/src/main/core/tools/resource.js';
import type { ToolDeps } from '../apps/worker-ant-desktop/src/main/core/tools/deps.js';
import { PAUSE_REASON_CHILDREN_INCOMPLETE } from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
import { compareSnapshots } from '../apps/worker-ant-desktop/src/main/core/world-snapshot.js';
import { ROUND_RE, checkBuildPins, stripKeepingLines } from './lib/rr-pins.js';

const ROOT = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const MAIN = `${A}/src/main/core`;
/** 本轮标识**由载体自身派生**（不写「只为下一轮」的字面量）。 */
const SELF_ROUND = path.basename(__filename, '.ts').replace(/^rr_/, '');

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}
function readText(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf-8');
}
function readCode(rel: string): string {
  return stripKeepingLines(readText(rel)).join('\n');
}

// ══════════════════════════════════════════════════════════════════════
// N 形态判定（名）——真标本与反向标本
// ══════════════════════════════════════════════════════════════════════

function sectionN(): void {
  console.log('\n【N】M1：名——形态判定补词、来源三态');
  const real = classifyArchetypeDetailed('增加用户禁用功能');
  eq([real.archetype, real.source], ['code', 'keyword'], 'N-1 真标本「增加用户禁用功能」⇒ code（关键词命中）');
  ok(real.reason.includes('功能'), 'N-2 理由点名「动作+功能/开关类产物」（不靠猜）', real.reason);

  const negatives = ['增加一份报告', '支持一下这个问题'];
  const negDecisions = negatives.map((t) => classifyArchetypeDetailed(t));
  ok(negDecisions.every((d) => d.archetype !== 'code'), 'N-3 反向两只标本都不判 code（不过宽）',
    negDecisions.map((d) => `${d.archetype}/${d.source}`).join(' , '));

  const family = classifyArchetypeDetailed('解释概念，帮助理解技术知识');
  eq(family.source, 'family', 'N-4 无关键词命中而家族相似度够 ⇒ source=family');
  const fallback = classifyArchetypeDetailed('今天天气怎么样');
  eq([fallback.archetype, fallback.source], ['conversation', 'fallback'], 'N-5 短题面兜底 ⇒ conversation / fallback');

  ok([real.reason, family.reason, fallback.reason].every((r) => typeof r === 'string' && r.trim().length > 0),
    'N-6 三态理由都非空（写进任务账的来源有据）');

  eq(['增加用户禁用功能', '增加一份报告', '支持一下这个问题'].map((t) => classifyArchetype(t)),
    ['code', negDecisions[0]!.archetype, negDecisions[1]!.archetype],
    'N-7 兼容出口 classifyArchetype 与 Detailed 同判');
}

// ══════════════════════════════════════════════════════════════════════
// E 工具面（器）——白名单、两刀优先级、说明书与工具面同源
// ══════════════════════════════════════════════════════════════════════

function sectionE(): void {
  console.log('\n【E】M2：器——子代理工具面说与做同源');
  const builder = SUBAGENT_TYPES.builder;
  ok(!!builder && (builder.allowTools ?? []).includes('edit_file'), 'E-1 builder 白名单含 edit_file（读真注册表）');
  ok(!!builder && (builder.systemPrompt ?? '').includes('edit_file'), 'E-2 builder 说明书明写 edit_file（提示词与白名单同源）');
  ok(!!builder && (builder.allowTools ?? []).includes('write_file'), 'E-3 新建用 write_file 仍在白名单');

  // deny 赢过 allow：同一名字同时在两侧 ⇒ 被 deny 删。
  const both = applySubagentToolScope(
    { kept: ['read_file', 'write_file'], removed: [] },
    { allowTools: ['read_file', 'write_file'], denyTools: ['write_file'] },
  );
  eq([both.kept, both.removedByDeny, both.removedByAllow], [['read_file'], ['write_file'], []],
    'E-4 deny 赢过 allow（同时在两侧时以 deny 为准）');

  // allow 砍掉名单外的形态保留件。
  const allowOnly = applySubagentToolScope(
    { kept: ['read_file', 'write_file', 'execute_command'], removed: ['device_control'] },
    { allowTools: ['read_file', 'execute_command'] },
  );
  eq([allowOnly.kept, allowOnly.removedByAllow, allowOnly.removedByDeny],
    [['read_file', 'execute_command'], ['write_file'], []],
    'E-5 allow 只留名单内，removedByAllow 点名被它删的');

  // 说明书的声明数必须 = 最终工具面键数（旧病：说上一刀之后的数）。
  const allNames = TOOL_METAS.map((m) => m.name);
  const full: Record<string, unknown> = Object.fromEntries(allNames.map((n) => [n, {}]));
  const archetypes: TaskArchetype[] = ['code', 'research', 'document', 'analysis', 'configuration', 'conversation'];
  for (const arch of archetypes) {
    const available = new Set(availableToolNames(arch));
    const base = narrowToolFace(arch, full, { allowTools: builder!.allowTools });
    ok(base.restored.every((n) => !available.has(n) && n in full),
      `E-6[${arch}] restored 只列「档外但被显式允许」的工具，${base.restored.join(',') || '(空)'}`);
    const scope = applySubagentToolScope(base, { allowTools: builder!.allowTools, denyTools: builder!.denyTools });
    const finalKept = scope.kept;
    ok(finalKept.length + scope.removed.length === allNames.length,
      `E-7[${arch}] 保留+移除恰为全集（划分不丢件 ${finalKept.length}+${scope.removed.length}=${allNames.length}）`);
    const brief = buildToolFaceBrief(arch, '编码实现', finalKept, scope.removed.length);
    ok(brief.includes(`只注入**本档 ${finalKept.length} 个工具`),
      `E-8[${arch}] 说明书声明数 = 最终工具面键数（${finalKept.length}）`, brief.slice(0, 80));
    ok(!brief.includes(`只注入**本档 ${base.kept.length} 个工具`),
      `E-9[${arch}] 不再复现「说 allow/deny 之前的数」（旧病 ${base.kept.length} vs 实际 ${finalKept.length}）`);
    ok(finalKept.every((n) => brief.includes(n)), `E-10[${arch}] 说明书逐个点名最终留下的工具`);
    ok(finalKept.length < base.kept.length,
      `E-11[${arch}] allow/deny 真收窄（0→1 对照：${base.kept.length} → ${finalKept.length}）`);
  }

  const ae = readCode(`${MAIN}/agent-executor.ts`);
  const iBase = ae.indexOf('const baseFace = narrowToolFace(');
  const iScope = ae.indexOf('const scope = applySubagentToolScope(');
  const iDelete = ae.indexOf('for (const k of toolFace.removed) delete toolMap[k];');
  const iBrief = ae.indexOf('buildToolFaceBrief(archetype, adaptiveStrategy.label, toolFace.kept, toolFace.removed.length)');
  ok(iBase >= 0 && iBase < iScope && iScope < iDelete && iDelete < iBrief,
    'E-12 接线顺序：形态收窄 → allow/deny 两刀 → 删 key → 生成说明书（顺序改回去即红）',
    `${iBase}/${iScope}/${iDelete}/${iBrief}`);
}

// ══════════════════════════════════════════════════════════════════════
// W 等子（止）——await_subagents 的置停条件
// ══════════════════════════════════════════════════════════════════════

interface AwaitTool {
  execute: (args: Record<string, unknown> | undefined) => Promise<string>;
}

async function sectionW(): Promise<void> {
  console.log('\n【W】M3：止——父要等子，须有可表达的「等」');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE wa_tasks (
    id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT,
    context_json TEXT DEFAULT '{}', parent_task_id TEXT,
    created_at TEXT DEFAULT (datetime('now')));`);
  const add = (id: string, status: string, parent: string | null): void => {
    db.prepare('INSERT INTO wa_tasks (id, project_id, title, status, parent_task_id) VALUES (?, ?, ?, ?, ?)')
      .run(id, 'proj', id, status, parent);
  };
  add('p1', 'executing', null);

  const calls: Array<Record<string, unknown>> = [];
  let changed = true;
  const deps = {
    db,
    taskId: 'p1',
    projectId: 'proj',
    ctx: {},
    pauseTask: ((_d: unknown, o: Record<string, unknown>) => {
      calls.push(o);
      return { changed, skipped: changed ? undefined : 'terminal' };
    }) as unknown as ToolDeps['pauseTask'],
  } as unknown as ToolDeps;
  const aw = (resourceTools(deps) as unknown as { await_subagents: AwaitTool }).await_subagents;
  const statusOf = (id: string): string | undefined =>
    (db.prepare('SELECT status FROM wa_tasks WHERE id = ?').get(id) as { status?: string } | undefined)?.status;

  // W-1/W-2 有在跑的子 ⇒ 置停，因 children_incomplete，且不传 note（不推 IM）。
  add('c1', 'executing', 'p1');
  const waiting = JSON.parse(await aw.execute(undefined)) as { status?: string; count?: number };
  eq([waiting.status, waiting.count], ['waiting', 1], 'W-1 有在跑的子 ⇒ status=waiting / count=1');
  eq(calls.length, 1, 'W-2 置停入口恰被调用 1 次（0→1 正面断言）');
  eq(calls[0]?.reason, PAUSE_REASON_CHILDREN_INCOMPLETE, 'W-3 暂停因取词表常量 children_incomplete');
  ok(calls[0] !== undefined && !('note' in calls[0]), 'W-4 不传 note（等子不推 IM）', JSON.stringify(calls[0]));

  // W-5 无未完成子 ⇒ 不暂停，且状态仍 executing。
  db.prepare("UPDATE wa_tasks SET status = 'completed' WHERE id = 'c1'").run();
  const none = JSON.parse(await aw.execute(undefined)) as { status?: string };
  eq(none.status, 'nothing_to_wait', 'W-5 无未完成子 ⇒ nothing_to_wait');
  eq(calls.length, 1, 'W-6 无未完成子不调置停入口（调用数不变）');
  eq(statusOf('p1'), 'executing', 'W-7 反证：父任务状态未被改动（仍 executing）');

  // W-8 未完成子已全 paused ⇒ 不自行等待（交给父处置，避免暂停—唤醒—暂停热环）。
  add('c2', 'paused', 'p1');
  const allPaused = JSON.parse(await aw.execute(undefined)) as { status?: string; count?: number };
  eq([allPaused.status, allPaused.count], ['all_paused', 1], 'W-8 未完成子全暂停 ⇒ all_paused / count=未完成数');
  eq(calls.length, 1, 'W-9 全暂停不调置停入口');

  // W-10 终态子不参与计数；混跑时 count 只数 running。
  add('c3', 'completed', 'p1');
  add('c4', 'executing', 'p1');
  const mixed = JSON.parse(await aw.execute(undefined)) as { status?: string; count?: number };
  eq([mixed.status, mixed.count], ['waiting', 1], 'W-10 混跑：count 只数在跑的子（终态/暂停不计）');
  eq(calls.length, 2, 'W-11 混跑确实置停一次（0→1 对照 1→2）');

  // W-12 多余参数直接报错，不暂停。
  const extra = JSON.parse(await aw.execute({ foo: 1 })) as { error?: string };
  ok(typeof extra.error === 'string' && extra.error.includes('foo'), 'W-12 多余参数报错（点名收到的键），不暂停');
  eq(calls.length, 2, 'W-13 报错路径不调置停入口');

  // W-14 置停入口不受理（终态/已停）⇒ 如实回 not_paused，不谎称已等。
  db.prepare("UPDATE wa_tasks SET status = 'paused' WHERE id = 'c2'").run();
  db.prepare("UPDATE wa_tasks SET status = 'executing' WHERE id = 'c4'").run();
  changed = false;
  const declined = JSON.parse(await aw.execute(undefined)) as { status?: string; count?: number };
  eq([declined.status, declined.count], ['not_paused', 1], 'W-14 置停不受理 ⇒ not_paused（如实回，不谎称等待中）');
  changed = true;
}

// ══════════════════════════════════════════════════════════════════════
// A 验收（账）——理由入账，记忆与卡同源
// ══════════════════════════════════════════════════════════════════════

function sectionA(): void {
  console.log('\n【A】M4：账——验收理由入账');
  const seven = Array.from({ length: 7 }, (_, i) => ({ criterion: `判据${i + 1}`, reason: `原因${i + 1}` }));
  const s7 = summarizeAcceptanceFailures(seven);
  ok(s7.includes('原因1') && s7.includes('原因2') && s7.includes('原因3'),
    'A-1 摘要含理由（不再只剩判据名）', s7);
  ok(s7.split('；').length === 4 && /另 4 条$/.test(s7), 'A-2 超上限 ⇒ 恰 3 条 + 「另 N 条」', s7);
  ok(!s7.includes('判据4'), 'A-3 未露第 4 条判据（有界）');

  eq(summarizeAcceptanceFailures([{ criterion: '接口可用' }]), '接口可用（未说明）',
    'A-4 reason 缺省 ⇒ 标「未说明」（不静默留空）');
  const one = summarizeAcceptanceFailures([{ criterion: '列名不符', reason: '缺 3 列' }]);
  eq(one, '列名不符（缺 3 列）', 'A-5 一条时不出现「另 N 条」');
  eq(summarizeAcceptanceFailures([]), '', 'A-6 空数组 ⇒ 空串（调用方据此不写）');

  // 记忆正文与候选卡共用同一字符串：卡文逐字包含该摘要。
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT DEFAULT (datetime('now')));
CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT);
CREATE TABLE wa_knowledge_cards (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '', confidence REAL NOT NULL DEFAULT 0.5,
  tokens INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now')));
CREATE UNIQUE INDEX idx_wa_knowledge_cards_key ON wa_knowledge_cards(project_id, kind, source, text);`);
  db.prepare('INSERT INTO wa_projects (id, name) VALUES (?, ?)').run('p1', '演示项目');
  db.prepare("INSERT INTO wa_settings (key, value) VALUES ('license.trial_started_at', ?)").run(new Date().toISOString());

  const wrote = recordPitfallCandidate(db as never, 'p1', { taskTitle: '导出对账单', failedItems: one });
  ok(wrote === true, 'A-7 候选卡真写入（0→1 正面断言）');
  const shortRow = db.prepare("SELECT text FROM wa_knowledge_cards WHERE kind = 'pitfall'").get() as { text: string } | undefined;
  eq(shortRow?.text, `任务「导出对账单」验收未达：${one}`, 'A-8 卡文逐字包含同一摘要（记忆与卡同源）');

  // 上限只留 3 条，靠「每条本身够长」越过 60 token 预算（数量多寡不决定长度）。
  const longItems = summarizeAcceptanceFailures(
    Array.from({ length: 3 }, (_, i) => ({ criterion: `判据${i + 1}`, reason: `缺列与类型不符`.repeat(12) })),
  );
  const wroteLong = recordPitfallCandidate(db as never, 'p1', { taskTitle: '长文案任务', failedItems: longItems });
  ok(wroteLong === true, 'A-9 长文案候选卡真写入');
  const longRow = db.prepare("SELECT text, tokens FROM wa_knowledge_cards WHERE text LIKE '%长文案任务%'").get() as
    { text: string; tokens: number } | undefined;
  ok(!!longRow && longRow.text.endsWith('（详见任务验收）'), 'A-10 超预算时以「（详见任务验收）」收口（不静默丢尾）', longRow?.text);
  ok(!!longRow && longRow.tokens <= 60, 'A-11 截断后仍不超 60 token 预算', String(longRow?.tokens));

  const ae = readCode(`${MAIN}/agent-executor.ts`);
  ok(/const failedItems = summarizeAcceptanceFailures\(payload\.failed\);/.test(ae)
    && /recordPitfallCandidate\(db, taskRow\.project_id, \{ taskTitle: taskRow\.title, failedItems \}\)/.test(ae),
    'A-12 接线在册：摘要单源同喂记忆正文与候选卡写口');
}

// ══════════════════════════════════════════════════════════════════════
// S 步文本（简）——收口只写增量
// ══════════════════════════════════════════════════════════════════════

function sectionS(): void {
  console.log('\n【S】M5：简——收口正文去重');
  eq(closeTextDelta('', ''), { delta: '', rewritten: false }, 'S-1 空 written 空 final ⇒ 不写');
  const first = closeTextDelta('', 'X');
  ok(first.delta === 'X' && first.rewritten === false, 'S-2 空 written 有 final ⇒ 整段写一次（0→1）', JSON.stringify(first));
  eq(closeTextDelta('A+B', 'B'), { delta: '', rewritten: false }, 'S-3 final = 已写尾段（SDK 末步正文）⇒ 增量空，不重复写');
  eq(closeTextDelta('AB', 'A'), { delta: '', rewritten: false }, 'S-4 final 是已写前缀 ⇒ 不写');
  {
    const r = closeTextDelta('A+B', 'B\n\n[注记]已撞顶');
    ok(r.delta === '\n\n[注记]已撞顶' && r.rewritten === false, 'S-5 末步+撞顶注记 ⇒ 只写差值', JSON.stringify(r));
  }
  eq(closeTextDelta('AB', 'ABCD'), { delta: 'CD', rewritten: false }, 'S-6 final 以已写开头 ⇒ 只写余下');
  eq(closeTextDelta('ABC', 'XYZ'), { delta: 'XYZ', rewritten: true }, 'S-7 无关内容 ⇒ 整段写一次并如实标 rewritten');

  {
    const a = 'a'.repeat(31), b = 'b'.repeat(38), c = 'c'.repeat(40);
    eq(closeTextDelta(a + b + c, c), { delta: '', rewritten: false }, 'S-8 三步 31/38/40 拼接 + final=末步 ⇒ 0 条聚合正文');
    eq(closeTextDelta(a + b + c, a + b + c), { delta: '', rewritten: false }, 'S-9 final=全部拼接 ⇒ 0 聚合');
  }
  eq(closeTextDelta('结论：已修复。', '已修复。'), { delta: '', rewritten: false }, 'S-10 Unicode 尾段匹配');

  const step = readCode(`${MAIN}/exec-step.ts`);
  ok(step.includes('const writtenText = event.text.slice(0, 50_000);') && step.includes('d.textWritten += writtenText;'),
    'S-11 逐步正文累加与落库同一 50k 截断口径');
  ok(step.includes('get textWritten(): string;') && step.includes('set textWritten(v: string);'),
    'S-12 StepScope 暴露 textWritten 读写访问器（steps 之间共享同一账）');

  const ae = readCode(`${MAIN}/agent-executor.ts`);
  ok(ae.includes('const closeDelta = closeTextDelta(textWritten, finalContent);') && ae.includes('if (closeDelta.delta) {'),
    'S-13 收口只写 delta，空增量不写');
  ok(ae.includes('rf.final_text_rewritten = true;'), 'S-14 改写如实落 run_features.final_text_rewritten');
}

// ══════════════════════════════════════════════════════════════════════
// B 简报（据）——工具摘要与已读清单同源
// ══════════════════════════════════════════════════════════════════════

function sectionB(): void {
  console.log('\n【B】M6：据——工具摘要、已读清单、简报优先级');
  const markers = [
    { content: '[工具调用] read_file({"filePath":"/a/b/x.ts"}); read_file({"filePath":"/a/b/y.ts"})' },
    { content: '[工具调用] bash({"command":"grep -n foo a.ts; grep bar b.ts"}); search_content({"pattern":"术语"})' },
  ];
  const d = digestToolTurns(parseToolMarkers(markers));
  eq(d.counts, { filesRead: 2, filesWritten: 0, commands: 1, searches: 1, children: 0 },
    'B-1 括号配对：命令里的「; 」不切断、两条命令算 1 次调用');
  eq(d.filesRead, ['x.ts', 'y.ts'], 'B-2 已读清单取 basename（去目录）');
  eq(formatDigest(d), '读 2 文件、跑 1 命令、搜 1 次', 'B-3 摘要人话（读/写/跑/搜）');

  const toolRows = [{ content: '[read_file] 结果正文' }, { content: '[bash] 结果正文' }];
  eq(formatDigest(digestToolTurns(parseToolMarkers(toolRows))), '',
    'B-4 反证：role=tool 的结果行不是标记行 ⇒ 摘要为空（旧形按 role=tool 取，清单恒空）');

  const many = Array.from({ length: 20 }, (_, i) => ({ content: `[工具调用] read_file({"filePath":"/p/f${i}.ts"})` }));
  const dm = digestToolTurns(parseToolMarkers(many));
  ok(dm.counts.filesRead === 20 && dm.filesRead.length <= 5,
    'B-5 计数不截断（读 20）而清单有界（≤5）', `${dm.counts.filesRead} 次 / 清单 ${dm.filesRead.length} 条`);
  ok(formatDigest(dm).includes('读 20 文件'), 'B-6 摘要照实数说「读 20」，不以清单长度冒充次数');

  const broken = [{ content: '[工具调用] bash({"command":"x' }, { content: 'not a marker' }];
  const db = digestToolTurns(parseToolMarkers(broken));
  eq([db.counts.commands, db.filesRead.length], [0, 0], 'B-7 截断在参数中间 ⇒ 跳过该条，不抛、不虚计');

  const ai = readCode(`${MAIN}/jobs/ai-task.ts`);
  const markerSql = ai.split(`role = 'system' AND content LIKE '[工具调用] %'`).length - 1;
  ok(markerSql >= 2, 'B-8 简报与恢复摘要共用同一标记行真源（role=system + [工具调用] 前缀）', `${markerSql} 处`);
  const iSummary = ai.indexOf('ctx.completion_summary');
  const iDigest = ai.indexOf('formatDigest(digestToolTurns(parseToolMarkers(rows)))');
  const iLast = ai.indexOf("ORDER BY created_at DESC LIMIT 1");
  ok(iSummary >= 0 && iSummary < iDigest && iDigest < iLast,
    'B-9 简报优先级：完成摘要 > 工具摘要 > 末条 assistant（聚合噪音排在最后）',
    `${iSummary}/${iDigest}/${iLast}`);
}

// ══════════════════════════════════════════════════════════════════════
// G 审计（谁变谁负责）——范围收窄只缩「谁导致」，不缩「有没有变」
// ══════════════════════════════════════════════════════════════════════

function sectionG(): void {
  console.log('\n【G】M6：据——审计范围 = 本任务 + 直接子');
  const snap = (files: string[], tasks: string[], truncated = false) =>
    ({ fileHashes: files, fileCount: files.length, truncated, taskStates: tasks });
  const before = snap(['a.ts'], ['p1:executing', 'c1:pending', 'x9:pending']);
  const after = snap(['a.ts', 'b.ts'], ['p1:paused', 'c1:executing', 'x9:failed']);

  const scoped = compareSnapshots(before, after, { taskId: 'p1', scopeTaskIds: ['p1', 'c1'] });
  ok(!scoped.some((s) => s.includes('p1:executing')), 'G-1 本任务自身 executing→paused 不报（正常流转）', scoped.join(' | '));
  ok(scoped.some((s) => s.includes('c1:pending→executing')), 'G-2 直接子任务的变化计入（0→1 正面断言）', scoped.join(' | '));
  ok(!scoped.some((s) => s.includes('x9')), 'G-3 无关任务的变化不入本任务结论', scoped.join(' | '));
  ok(scoped.some((s) => s.includes('[文件新增]')), 'G-4 范围收窄只缩「谁导致」，文件增删照常报', scoped.join(' | '));

  const unscoped = compareSnapshots(before, after);
  ok(unscoped.some((s) => s.includes('p1:executing')), 'G-5 反证：不传 scope 时自身流转仍被报（缺省行为不变）');
  ok(unscoped.some((s) => s.includes('x9:pending')), 'G-6 反证：不传 scope 时无关任务也被报');

  const truncated = compareSnapshots(before, snap(['a.ts', 'b.ts'], after.taskStates as string[], true),
    { taskId: 'p1', scopeTaskIds: ['p1', 'c1'] });
  ok(truncated.some((s) => s.includes('[任务状态变更]')) && !truncated.some((s) => s.includes('[文件新增]')),
    'G-7 采样截断只放弃文件增删判定，任务流转照常比（两类结论解耦）');

  const ws = readCode(`${MAIN}/world-snapshot.ts`);
  ok(ws.includes('scopeTaskIds: [taskId, ...childIds]'), 'G-8 审计范围接线在册（本任务 + 直接子）');
  ok(ws.includes('if (scope && opts?.taskId && tid === opts.taskId) continue;'),
    'G-9 自身流转排除点在同一处实现（不靠调用方自觉）');
}

// ══════════════════════════════════════════════════════════════════════
// Q 覆盖（形态覆盖优先级 + GUI 同键）
// ══════════════════════════════════════════════════════════════════════

function sectionQ(): void {
  console.log('\n【Q】M1/M7：覆盖优先级与 GUI 同键');
  const q = (ctx: unknown) => resolvePinnedArchetype(typeof ctx === 'string' ? ctx : JSON.stringify(ctx));

  const manual = q({ archetype_override: 'code' });
  eq([manual?.archetype, manual?.source], ['code', 'manual'], 'Q-1 override 合法 ⇒ 优先且来源 manual');
  const node = q({ node_archetype: 'document' });
  eq([node?.archetype, node?.source], ['document', 'node'], 'Q-2 仅 node 合法 ⇒ 来源 node');
  const both = q({ archetype_override: 'analysis', node_archetype: 'document' });
  eq([both?.archetype, both?.source], ['analysis', 'manual'], 'Q-3 两者皆有 ⇒ override 赢');
  const bad = q({ archetype_override: 'nonsense', node_archetype: 'research' });
  eq([bad?.archetype, bad?.source], ['research', 'node'], 'Q-4 override 非法 ⇒ 当没写，回落 node');
  eq(q({ archetype_override: 'nonsense' }), null, 'Q-5 无合法覆盖值 ⇒ null（走自动判定，来源仍为自动）');
  eq([q({}), q(''), q('{bad json'), q({ archetype_override: 123 })], [null, null, null, null],
    'Q-6 空上下文/坏账/非字符串值一律 null，不抛不猜');

  const page = readText(`${A}/renderer/src/pages/TaskDetailPage.tsx`);
  const sources = ['keyword', 'family', 'fallback', 'semantic', 'calibrated', 'node', 'manual'];
  ok(sources.every((s) => page.includes(`${s}:`)), 'Q-7 GUI 来源人话七态同键穷举（类型级而非手抄清单）');
  ok(/ARCHETYPE_OVERRIDE_OPTIONS/.test(page) && page.includes('archetype_override'),
    'Q-8 GUI 有覆盖写口（archetype_override 写任务上下文）');
  ok(page.includes('isToolCallRow'), 'Q-9 GUI 会话区工具行可识别（折叠不吞正文）');
}

// ══════════════════════════════════════════════════════════════════════
// H 收口卫生
// ══════════════════════════════════════════════════════════════════════

function sectionH(): void {
  console.log('\n【H】收口卫生');
  checkBuildPins(ok, { distDir: path.join(ROOT, `${A}/dist`) });

  ok(ROUND_RE.test(SELF_ROUND), 'H-1 本轮标识由载体自身派生且格式合法', SELF_ROUND);

  const selfLines = stripKeepingLines(fs.readFileSync(__filename, 'utf-8'));
  const dud = selfLines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => /(?:eq\([^,)]*,\s*|===?\s*|!==?\s*)'zx_\d{8}(?:_\d+)?'/.test(line));
  ok(dud.length === 0, 'H-2 本套件无「只为下一轮」字面量', dud.map((x) => `${x.i + 1}:${x.line.trim()}`).join(' | '));

  const selfText = fs.readFileSync(__filename, 'utf-8');
  const badGlyphs = [0x2717, 0x2713].map((c) => String.fromCodePoint(c));
  ok(!badGlyphs.some((g) => selfText.includes(g)), 'H-3 本套件文案无失败/通过字形（全量汇总器按失败字形计数）');
  ok(/通过 \/ .*失败/.test(selfText), 'H-4 收尾行如实印出断言数（通过 / 失败）');
}

async function main(): Promise<void> {
  console.log(`rr_${SELF_ROUND} 受控回归（器：名正、器利、止有时）`);
  sectionN();
  sectionE();
  await sectionW();
  sectionA();
  sectionS();
  sectionB();
  sectionG();
  sectionQ();
  sectionH();
  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
}

main().then(() => {
  process.exit(fail === 0 ? 0 : 1);
}).catch((e: unknown) => {
  console.error(`rr_${SELF_ROUND} 未捕获异常（复跑未跑完，不得读作通过）：`, e);
  fail++;
  console.log(`\nFAIL rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(1);
});
