/**
 * zx_20261110_1 B6 受控回归 —— IM 任务推送内容「说人话」。
 *
 * 基线：`data/baseline_zx_20261110_1_im_push.md`（只读采样 2026-11-10）——
 *   完成推送 9/9 无"下一步"、0/9 带任务 ID/产出物数，8/9 含 markdown 残留；
 *   暂停推送把「等子自动恢复」也写成「待复核…可在桌面处理/恢复」；失败推送只有一行、无下一步。
 *
 * 本套件钉住七件事：
 *   A 净化函数：markdown 表格/SQL/围栏/标题/shabang 不上屏，正常中文不吞；
 *   B 完成推送：四段（结论/做了什么/下一步/任务 ID+产出物数）；未达目标不背书；
 *   C 暂停推送：等子族说「自动继续/无需操作」、不含「待复核」；需人工族保留「待复核」；
 *   D 失败推送：原因缺失如实写「未提供失败原因」，不编；
 *   E 历史真样本复读（基线 C1/C3/P1/F1 四段原文过净化）；
 *   F 静态钉：构建标识、轮次标识、哑雷专项、断言文案无失败/通过字形。
 *
 * 纪律：零网络 / 零 electron；夹具按生产列形自建 DDL；断言文案不含失败/通过字形。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { plainTextSnippet, extractKeyPoints } from '../apps/worker-ant-desktop/src/main/core/im-reply.js';
import { buildTaskNotice } from '../apps/worker-ant-desktop/src/main/core/task-notice.js';
import {
  buildPauseNotice,
  PAUSE_REASON_CHILDREN_INCOMPLETE,
  PAUSE_REASON_QUALITY_BELOW_BAR,
} from '../apps/worker-ant-desktop/src/main/core/pause-reason.js';
import { ROUND_RE, checkBuildPins, deriveBuildTag, listStrayPinLiterals, stripKeepingLines } from './lib/rr-pins.js';

const ROOT = path.join(__dirname, '..');
const A = 'apps/worker-ant-desktop';
const SCRIPTS = path.join(ROOT, 'scripts');
/** 由载体自身派生轮次（文件名可带 `_notice` 后缀，只取轮次前缀）。 */
const SELF_ROUND = /^rr_(zx_\d{8}(?:_\d+)?)/.exec(path.basename(__filename, '.ts'))?.[1] ?? '';
const SRC_BUILD = deriveBuildTag(fs.readFileSync(path.join(ROOT, `${A}/src/main/core/agent-executor.ts`), 'utf-8')).tag;
const roundOrd = (tag: string): number => {
  const m = /^zx_(\d{8})(?:_(\d+))?$/.exec(tag);
  return m ? Number(m[1]) * 1000 + Number(m[2] ?? 1) : -1;
};

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
const rd = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

/* ═══ 夹具（生产列形；只建本套件读到的列） ═══════════════════════════════ */
const SCHEMA = `
CREATE TABLE wa_tasks (
  id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', title TEXT DEFAULT '', description TEXT DEFAULT '',
  status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}', workflow_config TEXT DEFAULT '{}',
  priority INTEGER DEFAULT 0, depends_on TEXT DEFAULT '', parent_task_id TEXT DEFAULT '',
  source TEXT DEFAULT 'user', acceptance_criteria TEXT DEFAULT '', aggregate_version INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE wa_settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE wa_deliverables (
  id TEXT PRIMARY KEY, project_id TEXT DEFAULT '', task_id TEXT DEFAULT '', type TEXT NOT NULL, name TEXT DEFAULT '',
  description TEXT DEFAULT '', file_path TEXT, registry_id TEXT, status TEXT DEFAULT 'draft', is_primary INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
);
`;
const mkdb = (): DatabaseSync => { const d = new DatabaseSync(':memory:'); d.exec(SCHEMA); return d; };
function addTask(
  d: DatabaseSync,
  id: string,
  status = 'pending',
  ctx: Record<string, unknown> = {},
  parent = '',
  title = '示例任务',
): void {
  d.prepare('INSERT INTO wa_tasks (id, project_id, title, description, status, context_json, parent_task_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(id, 'p1', title, id, status, JSON.stringify(ctx), parent);
}
function addDeliverable(d: DatabaseSync, id: string, taskId: string): void {
  d.prepare('INSERT INTO wa_deliverables (id, project_id, task_id, type, name, status) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, 'p1', taskId, 'doc', `${id}.md`, 'completed');
}

/* ═══ A 净化函数 ═════════════════════════════════════════════════════════ */
function sectionA(): void {
  console.log('\n【A】净化函数：markdown/SQL/代码不上屏，正常中文不吞');
  const dirty = [
    '# ERP 家属用户管理页',
    '',
    '| 项 | 值 |',
    '| --- | --- |',
    '| 路由 | worker/org-application |',
    '',
    '```python',
    '#!/usr/bin/env python3',
    'print("hello")',
    '```',
    '',
    '结论：页面已接通。详见 [报告](https://example.com/report)。',
  ].join('\n');
  const out = plainTextSnippet(dirty, 400);
  ok(!out.includes('|'), 'A-1 表格行不上屏', out);
  ok(!out.includes('```') && !out.includes('`'), 'A-2 围栏与行内反引号不上屏', out);
  ok(!out.includes('#!/usr/bin/env python3') && !out.includes('print('), 'A-3 围栏内的代码原样丢弃', out);
  ok(!/^#/m.test(out), 'A-4 标题符不上屏', out);
  ok(!out.includes('https://example.com') && out.includes('报告'), 'A-5 链接只留文字、裸 URL 不留', out);
  ok(out.includes('结论：页面已接通。'), 'A-6 正常中文句子原样保留', out);

  const sql = [
    '-- ==== 怡寿里 · ERP 菜单 ====',
    "CREATE TABLE IF NOT EXISTS wa_family ('id' TEXT);",
    'V1.0.18__yishouli-family-menu.sql 已落盘。',
  ].join('\n');
  const sq = plainTextSnippet(sql, 300);
  ok(!sq.includes('-- ====') && !sq.includes('CREATE TABLE'), 'A-7 SQL 注释与语句不上屏', sq);
  ok(sq.includes('V1.0.18__yishouli-family-menu.sql 已落盘。'), 'A-8 文件名与人话结论保留', sq);

  ok(plainTextSnippet('这是一段正常的中文摘要。没有 Markdown。') === '这是一段正常的中文摘要。没有 Markdown。',
    'A-9 反证：纯中文不因净化而改变');
  ok(plainTextSnippet('') === '', 'A-10 空输入回空串（不编一句）');

  const pts = extractKeyPoints('- 修好登录页\n- 补了回归\n- 修好登录页\n- 第四条不该出现', 3);
  ok(pts.length === 3 && pts[0] === '修好登录页' && pts[1] === '补了回归',
    'A-11 列表项优先且去重、最多三条', JSON.stringify(pts));
  const prose = extractKeyPoints('第一件事做完了。第二件事也做完了。第三件还在路上。', 3);
  ok(prose.length === 3 && prose[0].includes('第一件事'), 'A-12 无列表项时按句切，不把整段当一条', JSON.stringify(prose));
}

/* ═══ B 完成推送：四段 + 未达目标不背书 ═════════════════════════════════ */
function sectionB(): void {
  console.log('\n【B】完成推送：结论/做了什么/下一步/任务 ID+产出物数');
  {
    const d = mkdb();
    addTask(d, 'b-done-1234', 'completed', { completion_quality: { score: 92, goal_achieved: true } });
    addDeliverable(d, 'dv1', 'b-done-1234');
    addDeliverable(d, 'dv2', 'b-done-1234');
    const n = buildTaskNotice(d as never, 'b-done-1234', 'completed', {
      detail: '## 主要成果\n- 修好登录页\n- 补了回归\n\n```js\nconsole.log(1)\n```',
    });
    ok(n.body.includes('任务「示例任务」已完成（质量 92/100）。'), 'B-1 结论行带质量分', n.body);
    ok(n.body.includes('做了什么：') && n.body.includes('- 修好登录页') && n.body.includes('- 补了回归'),
      'B-2 做了什么：列表项净化后逐条列出', n.body);
    ok(!n.body.includes('console.log') && !n.body.includes('```'), 'B-3 完成推送内无代码围栏残留', n.body);
    ok(n.body.includes('下一步：无需操作，详情见桌面。'), 'B-4 正常完成给"无需操作"出口', n.body);
    ok(n.body.includes('任务 ID：b-done-1') && n.body.includes('产出物 2 件'),
      'B-5 任务短 ID + 产出物数同现', n.body);
    ok(!n.body.includes('任务 b-done-1') && !n.body.includes('b-done-1234'),
      'B-6 不出现"任务 <短 ID>"占位形，也不泄漏全 ID', n.body);
  }
  {
    const d = mkdb();
    addTask(d, 'b-unmet', 'completed', { completion_quality: { premature: true, goal_achieved: false, goal_evidence: 'acceptance_failed' } });
    const n = buildTaskNotice(d as never, 'b-unmet', 'completed', { detail: '产出了报告草稿' });
    ok(n.body.split('\n')[0].includes('未达成目标'), 'B-7 未达目标：首行即结论，不先播摘要', n.body);
    ok(!n.body.includes('已完成') && !n.body.includes('主要成果'), 'B-8 未达目标不出现「已完成」「主要成果」', n.body);
    ok(n.body.includes('被迫结束') && n.body.includes('验收未通过') && n.body.includes('本轮产出（未达目标）'),
      'B-9 说清为什么未达、产出不冒充主要成果', n.body);
    ok(n.body.includes('下一步：') && n.body.includes('「继续」'), 'B-10 未达目标给可执行的桌面下一步', n.body);
    ok(n.body.includes('任务 ID：'), 'B-11 未达目标同样带任务 ID');
  }
  {
    const d = mkdb();
    addTask(d, 'b-nodoc', 'completed', { completion_quality: { goal_achieved: true } });
    const n = buildTaskNotice(d as never, 'b-nodoc', 'completed');
    ok(n.body.includes('做了什么：本轮未附摘要') && n.body.includes('任务 ID：b-nodoc'),
      'B-12 无摘要时如实说"未附摘要"，不编"主要成果"', n.body);
  }
}

/* ═══ C 暂停推送：等子族 vs 需人工族 ═══════════════════════════════════ */
function sectionC(): void {
  console.log('\n【C】暂停推送：按因由分两族');
  {
    const d = mkdb();
    addTask(d, 'c-parent', 'paused', { pause_reason: PAUSE_REASON_CHILDREN_INCOMPLETE });
    addTask(d, 'c-kid1', 'executing', {}, 'c-parent');
    addTask(d, 'c-kid2', 'pending', {}, 'c-parent');
    addTask(d, 'c-kid3', 'completed', {}, 'c-parent');
    const n = buildTaskNotice(d as never, 'c-parent', 'paused');
    ok(n.body.includes('子任务尚未完成'), 'C-1 等子族仍如实说因由（既有词表不变）', n.body);
    ok(n.body.includes('自动继续') && n.body.includes('无需操作'),
      'C-2 等子族明说"自动继续/无需操作"（不再骗人去点按钮）', n.body);
    ok(!n.body.includes('待复核'), 'C-3 等子族不得再写「待复核」（自相矛盾的旧形）', n.body);
    ok(n.body.includes('等待 2 个子任务完成后自动继续'), 'C-4 报出在途子任务数（只数未终态）', n.body);
  }
  {
    const d = mkdb();
    addTask(d, 'c-human', 'paused', { pause_reason: PAUSE_REASON_QUALITY_BELOW_BAR });
    const n = buildTaskNotice(d as never, 'c-human', 'paused');
    ok(n.body.includes('质量分未达交付标准'), 'C-5 需人工族因由如实', n.body);
    ok(n.body.includes('待复核') && n.body.includes('可在桌面处理/恢复'),
      'C-6 需人工族保留「待复核 + 可在桌面处理/恢复」', n.body);
    ok(!n.body.includes('无需操作'), 'C-7 需人工族不得说"无需操作"', n.body);
  }
  {
    // 直调真实现（零 import 模块）：等子族与需人工族的**可判定差异**
    const auto = buildPauseNotice({ name: 'X', word: '已暂停', pauseReason: PAUSE_REASON_CHILDREN_INCOMPLETE, blockedDownstream: 0 });
    const human = buildPauseNotice({ name: 'X', word: '已暂停', pauseReason: PAUSE_REASON_QUALITY_BELOW_BAR, blockedDownstream: 0 });
    ok(auto.includes('自动继续') && !auto.includes('待复核') && human.includes('待复核') && !human.includes('自动继续'),
      'C-8 两族的措辞差异可由同一函数判定（非文案巧合）');
  }
}

/* ═══ D 失败推送：原因缺失不编 ═══════════════════════════════════════ */
function sectionD(): void {
  console.log('\n【D】失败推送：原因/建议动作/缺省如实');
  {
    const d = mkdb();
    addTask(d, 'd-fail', 'failed');
    const n = buildTaskNotice(d as never, 'd-fail', 'failed');
    ok(n.body.includes('任务「示例任务」失败。'), 'D-1 失败结论行', n.body);
    ok(n.body.includes('失败原因：未提供失败原因'), 'D-2 缺省时如实说"未提供失败原因"（不编）', n.body);
    ok(n.body.includes('建议动作：') && n.body.includes('「恢复」'), 'D-3 失败带可执行下一步', n.body);
  }
  {
    const d = mkdb();
    addTask(d, 'd-fail2', 'failed');
    const n = buildTaskNotice(d as never, 'd-fail2', 'failed', {
      detail: '```\nTraceback (most recent call last)\n```\n本机无 MySQL 实例，沙箱不允许起容器。',
    });
    ok(n.body.includes('失败原因：本机无 MySQL 实例，沙箱不允许起容器。') && !n.body.includes('Traceback'),
      'D-4 失败原因净化后只留人话（堆栈不上屏）', n.body);
  }
}

/* ═══ E 历史真样本复读（基线 C1/C3/P1/F1 原文形态） ═══════════════ */
function sectionE(): void {
  console.log('\n【E】历史真样本复读（只读基线里的脏正文过净化）');
  const c1 = '#!/usr/bin/env python3\n# -*- coding: utf-8 -*-\nimport os\n\ndef main():\n    print("ok")';
  const c1out = plainTextSnippet(c1, 200);
  ok(c1out === '', 'E-1 C1（纯 shebang + 代码）净化后无字可读 ⇒ 回空串，不改写成"已完成"', JSON.stringify(c1out));

  const c3 = '-- ==== 怡寿里 · ERP 菜单 ====\nCREATE TABLE IF NOT EXISTS x (id TEXT);\n菜单 V1.0.18 已落盘。';
  const c3out = plainTextSnippet(c3, 200);
  ok(c3out.includes('菜单 V1.0.18 已落盘。') && !c3out.includes('CREATE'), 'E-2 C3（SQL 头）只留结论行', c3out);

  const p1 = '待复核：质量分未达交付标准 · 已自动拆解为 3 个子任务';
  ok(buildPauseNotice({ name: 'erp 家属用户管理页面优化', word: '已暂停', pauseReason: PAUSE_REASON_QUALITY_BELOW_BAR, blockedDownstream: 0, note: p1 }).includes('待复核'),
    'E-3 P1（需人工样本）仍按需人工族播报');

  const f1 = '受环境限制未能闭环（非代码问题）：本机无 MySQL/MariaDB 实例，沙箱不允许起容器。';
  ok(plainTextSnippet(f1, 200) === f1, 'E-4 F1（失败原因本身即人话）不被净化吞掉');
}

/* ═══ F 静态钉 ═══════════════════════════════════════════════════════ */
function sectionF(): void {
  console.log('\n【F】静态钉：构建标识与全量纪律');
  checkBuildPins(ok, { distDir: path.join(ROOT, `${A}/dist`) });
  ok(ROUND_RE.test(SELF_ROUND), 'F-1 本轮标识由载体自身派生且格式合法', SELF_ROUND);
  ok(fs.existsSync(path.join(ROOT, `plans/improve/${SELF_ROUND}.md`)), `F-2 方案在册：plans/improve/${SELF_ROUND}.md`);
  ok(roundOrd(SRC_BUILD) >= roundOrd(SELF_ROUND), 'F-3 源码 build 不早于本套件轮次', SRC_BUILD);
  ok(listStrayPinLiterals(SCRIPTS, ['rr_zx_20260909_fixes.ts'], ROOT).length === 0,
    'F-4 除历史负钉外无轮次字面量');
  const ROUND_LIT = /['"`](zx_\d{8}(?:_\d+)?)['"`]/;
  const offenders: string[] = [];
  const files = fs.readdirSync(SCRIPTS).filter((f) => f.startsWith('rr_') && f.endsWith('.ts')).sort();
  for (const name of files) {
    stripKeepingLines(fs.readFileSync(path.join(SCRIPTS, name), 'utf-8')).forEach((line, i) => {
      if (/\btag\b/.test(line) && ROUND_LIT.test(line)) offenders.push(`${name}:${i + 1}`);
    });
  }
  ok(offenders.length === 0, `F-5 哑雷专项零命中（扫描面 ${files.length} 个脚本）`, offenders.join(', '));
  const GLYPHS = new RegExp('[' + String.fromCharCode(0x2717) + String.fromCharCode(0x2713) + ']');
  ok(!GLYPHS.test(rd('scripts/rr_zx_20261110_1_notice.ts')), 'F-6 本套件断言文案不含失败/通过字形');
  // 接线：净化函数与四段结构确在源码里（不是只在本套件里自造）
  const tn = rd(`${A}/src/main/core/task-notice.ts`);
  ok(tn.includes("plainTextSnippet(detail, 220)") && tn.includes("'做了什么：'") && tn.includes("'下一步：无需操作，详情见桌面。'"),
    'F-7 完成推送四段确在唯一构造器（task-notice.ts）内');
  ok(tn.includes('未提供失败原因') && tn.includes('建议动作：'), 'F-8 失败推送的新结构确在唯一构造器内');
  const pr = rd(`${A}/src/main/core/pause-reason.ts`);
  ok(pr.includes('PAUSE_REASON_CHILDREN_INCOMPLETE') && pr.includes('自动继续，无需操作'), 'F-9 暂停两族判定确在 pause-reason.ts');
}

function main(): void {
  console.log(`rr_${SELF_ROUND} 受控回归（准·达：推送说人话）`);
  sectionA();
  sectionB();
  sectionC();
  sectionD();
  sectionE();
  sectionF();
  console.log(`\n${fail === 0 ? 'OK' : 'FAIL'} rr_${SELF_ROUND}: ${pass} 通过 / ${fail} 失败\n`);
  process.exit(fail === 0 ? 0 : 1);
}

try {
  main();
} catch (e: unknown) {
  console.error(`rr_${SELF_ROUND} 未捕获异常（复跑未跑完，不得读作通过）：`, e);
  console.log(`\nFAIL rr_${SELF_ROUND}: ${pass} 通过 / ${fail + 1} 失败\n`);
  process.exit(1);
}
