/**
 * zx_20260909 三处桌面修复受控复跑（node:sqlite 内存库 + /tmp 临时文件；tsx 运行，导入 src .ts）。
 * ① output-validator 头窗口漏判：长结构化文档只送前6000字符 → O1-O4 中后段详设被 LLM 当"缺失"（实证 A_20260908 反复 finalize 不充分）。
 *    改为覆盖式窗口(头部+全篇标题大纲+结尾)，buildSufficiencyWindow 纯函数在此断言。
 * ② assessCompletionQuality 假通过：无真实产出证据(realOutputEvidence=false)仅靠对话/步数冲到 ≥60 → goal_achieved=true
 *    （实证 T1 子任务产出0 却 good/60；auto_completed_without_output 任务 completed 却带高分）。改为评分内统一压降<60，conversation 例外。
 * ③ run_features.build 陈旧：硬编码 zx_20260904_5 长期未动 → DB 无法关联真实二进制。刷新为 zx_20260909 + 源接线断言防回退。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildSufficiencyWindow } from '../apps/worker-ant-desktop/src/main/core/output-validator.js';
import { assessCompletionQuality } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path?: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => { all: (...p: unknown[]) => unknown[]; get: (...p: unknown[]) => unknown; run: (...p: unknown[]) => { changes: number } };
  };
};

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

console.log('① output-validator 覆盖式窗口(buildSufficiencyWindow)');
const short = '短内容。'.repeat(100);
const wShort = buildSufficiencyWindow(short);
ok(wShort.truncated === false && wShort.text === short, '短文件(<头+尾窗) → 不截断、原文直出');
// 长文档：中后段标题 + 结尾哨兵必须进入窗口（此前只送头6000 → 中后段详设不可见）
const headFill = '前导理论段。'.repeat(3000); // ≈12000 字符，把 O3 详设挤出前6000
const longDoc = [
  '# A 长方案文档',
  headFill,
  '## 0. 速览',
  '速览内容。'.repeat(200),
  '## 2. O1-O4 详设',
  '## 中段 O3 目标口径单源化详设',
  'O3 的中段详设正文，仅在此出现一次。'.repeat(100),
  '## 4. 排期与验收',
  '排期内容。'.repeat(300),
  '## 结论与下一步',
  '=====TAIL-SENTINEL 文末收尾=====',
].join('\n');
const wLong = buildSufficiencyWindow(longDoc);
ok(wLong.truncated === true, '长文件 → 标记截断');
ok(wLong.totalChars === longDoc.length, '报告全文总字符');
ok(wLong.text.includes('中段 O3 目标口径单源化详设'), '中后段 O3 详设标题经"标题大纲"入窗（防被当缺失）');
ok(wLong.text.includes('=====TAIL-SENTINEL 文末收尾====='), '文末结论/哨兵经"结尾"入窗');
ok(wLong.text.includes('## 0. 速览'), '头部速览仍在（首窗）');
ok(wLong.text.length < 16000, `覆盖式窗口总字符有界(省耗)`, `${wLong.text.length}字符`);

console.log('② assessCompletionQuality 无真实产出证据压降');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr_zx0909_'));
const db = new DatabaseSync(':memory:') as unknown as { prepare: (sql: string) => { all: (...p: unknown[]) => unknown[]; get: (...p: unknown[]) => unknown; run: (...p: unknown[]) => { changes: number } }; exec: (sql: string) => void };
db.exec(`CREATE TABLE wa_projects (id TEXT PRIMARY KEY, name TEXT DEFAULT '', working_dir TEXT DEFAULT '');
  CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT DEFAULT '', status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}');
  CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, project_id TEXT, task_id TEXT, type TEXT DEFAULT '', name TEXT DEFAULT '', status TEXT DEFAULT 'draft', file_path TEXT, created_at TEXT DEFAULT (datetime('now')));
  CREATE TABLE wa_task_conversations (id TEXT PRIMARY KEY, task_id TEXT, role TEXT DEFAULT '', content TEXT DEFAULT '', token_count INTEGER DEFAULT 0, created_at TEXT DEFAULT (datetime('now')));
`);
const pid = randomUUID();
db.prepare('INSERT INTO wa_projects (id, name, working_dir) VALUES (?, ?, ?)').run(pid, 't', tmpDir);
const newTask = (): string => { const id = randomUUID(); db.prepare('INSERT INTO wa_tasks (id, project_id, title) VALUES (?, ?, ?)').run(id, pid, 't'); return id; };
const addChat = (taskId: string, n: number): void => {
  for (let i = 0; i < n; i++) db.prepare("INSERT INTO wa_task_conversations (id, task_id, role, content) VALUES (?, ?, 'assistant', ?)").run(randomUUID(), taskId, `第${i}条回复内容。`);
};
const wdir = tmpDir;

// 2a 大量对话+步数但无任何真实产出（无 deliverable、无 write/edit/register 工具记录）→ 不得 ≥60（goal 会=false）
const tEng = newTask();
addChat(tEng, 3);
const qEng = assessCompletionQuality(db as never, tEng, 20, 50_000, 400_000, 40, wdir, 'code');
ok(typeof qEng.score === 'number' && qEng.score < 60, `非conversation无真实产出 → 评分压降<60(杜绝靠闲聊冲 good)`, `${qEng.score}分`);
ok(qEng.feedback.includes('无真实产出证据，评分压降<60'), '反馈注明压降原因');
// 2b conversation 型（以对话为交付物）不压降 —— 例外保留
const tConv = newTask();
addChat(tConv, 3);
const qConv = assessCompletionQuality(db as never, tConv, 20, 50_000, 400_000, 40, wdir, 'conversation');
ok(qConv.score >= 60, `conversation 型以对话为交付物 → 不压降`, `${qConv.score}分`);
ok(!qConv.feedback.includes('无真实产出证据'), 'conversation 反馈不含压降注记');
// 2c 有真实 deliverable 落盘 → 正常高分，不被压降
const tReal = newTask();
addChat(tReal, 3);
const realFile = path.join(tmpDir, 'out.md');
fs.writeFileSync(realFile, '充分正文。'.repeat(600), 'utf-8');
db.prepare("INSERT INTO wa_deliverables (id, project_id, task_id, type, name, status, file_path) VALUES (?, ?, ?, 'doc', 'd', 'completed', ?)").run(randomUUID(), pid, tReal, realFile);
const qReal = assessCompletionQuality(db as never, tReal, 8, 20_000, 400_000, 40, wdir, 'document');
ok(qReal.score >= 60, `有真实产出物落盘 → 正常(不被无产出压降)`, `${qReal.score}分`);
// 2d 完全空转(无产出无对话) → 既有 hard score:10 兜底（goal=false）
const tEmpty = newTask();
const qEmpty = assessCompletionQuality(db as never, tEmpty, 0, 0, 0, 40, wdir);
ok(qEmpty.score < 60, '完全空转(无产出无对话) → <60', `${qEmpty.score}分`);

console.log('③ run_features.build 刷新接线(源断言防回退到陈旧值)');
const aeSrc = fs.readFileSync(path.resolve(__dirname, '../apps/worker-ant-desktop/src/main/core/agent-executor.ts'), 'utf-8');
ok(!aeSrc.includes("build: 'zx_20260904_5'"), '不再残留陈旧 build: zx_20260904_5');
// zx_20260910_3 M6: 原断言钉死"当前轮次 = zx_20260909"——而 build 标识**每轮都该刷新**，
// 这条断言因此每开一轮必误报（它把"某个历史轮次的值"误当成了"当前轮次"的不变量）。
// 改为钉**格式**：具体轮次值由各轮自己的收口回归钉住（如 rr_zx_20260910_3_b5 的 S1）。
ok(/build: 'zx_\d{8}(_\d+)?'/.test(aeSrc), 'build 为有效轮次标识（zx_YYYYMMDD[_x]；具体轮次值由各轮收口回归钉住）');
ok(aeSrc.includes('发版/改 run 循环特性与收口逻辑后须把此处刷新为最新轮次标识'), '刷新纪律注释已写入');
ok(aeSrc.includes('无真实产出证据，评分压降<60') && aeSrc.includes('realOutputEvidence(db, taskId)'), '②压降逻辑已接入 assessCompletionQuality');
const ovSrc = fs.readFileSync(path.resolve(__dirname, '../apps/worker-ant-desktop/src/main/core/output-validator.ts'), 'utf-8');
ok(ovSrc.includes('buildSufficiencyWindow') && ovSrc.includes('文档标题大纲') && ovSrc.includes('文档结尾'), '①覆盖式窗口已接入 output-validator');

fs.rmSync(tmpDir, { recursive: true, force: true });
console.log(`\n结果: ${pass} 通过, ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
