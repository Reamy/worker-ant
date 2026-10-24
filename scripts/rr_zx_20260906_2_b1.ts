/**
 * zx_20260906_2 批1 受控复跑（node:sqlite 内存库行为 + 源码静态防回归；绝不触碰开发库；经桌面 node_modules/.bin/tsx 运行，用法同 rr_zx_20260906_1_b1.ts）。
 * S1 1a 运行时：子任务(有 parent_task_id) → buildUpstreamRequirementBlock 返回含 [父任务]/父目标/父验收 的 [上游要求] 块。
 * S2 1a 运行时：depends_on 前置已完成且带产出物 → 块含 前置标题 与 已完成产出名。
 * S3 1a 运行时：前置 completed 无登记产出物 → 块含 "无登记产出物" 提示。
 * S4 1a 运行时：无 parent/depends_on 的普通任务 → 零注入(null)。
 * S5 1a 截断：超长父描述 → 块 ≤ UPSTREAM_MAX_CHARS(2000)+tag 兜底（含 "已裁剪"）。
 * S6 1a 静态接线：executor 组装调用 buildUpstreamRequirementBlock(db, task) 位于 taskMessage 之前（system 先于 user 入栈）。
 * 1b(resume 恢复省耗) 属复核项·保守不改——复核结论见方案 §九：prelude 命中缓存(2761-2776)已省主要预读 LLM；
 *    [系统恢复] user 块(ai-task 366-383)已带进度摘要防重复探索；续跑注入文本为模型固有上下文；跨 resume 缓存
 *    buildMemoryContext 结果有"漏新记忆/新里程碑"的准确风险且需失效机制，收益低 → 不改，如实记录。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { buildUpstreamRequirementBlock } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p?: string) => { exec: (s: string) => void } };

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const ROOT = path.join(__dirname, '..');
const exe = fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/agent-executor.ts'), 'utf-8');
// zx_20261018_1 批九：上下文预组装搬到 `core/exec-prelude.ts`（执行体只留再导出与组装调用）。
//   定义 / 上限 / 截断兜底三件按**新家**核；接线（组装次序、system 入栈）仍看执行体。
const pre = fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/exec-prelude.ts'), 'utf-8');

type SQLite = { prepare: (s: string) => { all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => { changes: number } } };
const db = new DatabaseSync(':memory:') as unknown as SQLite;
db.exec(`CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, title TEXT, description TEXT, acceptance_criteria TEXT, status TEXT DEFAULT 'pending', parent_task_id TEXT DEFAULT '', depends_on TEXT DEFAULT '');
CREATE TABLE wa_deliverables (id TEXT PRIMARY KEY, task_id TEXT, name TEXT, type TEXT, status TEXT DEFAULT 'draft', created_at TEXT DEFAULT (datetime('now')));`);
const insTask = db.prepare("INSERT INTO wa_tasks (id, project_id, title, description, acceptance_criteria, status, parent_task_id, depends_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
const insDeliv = db.prepare("INSERT INTO wa_deliverables (id, task_id, name, type, status) VALUES (?, ?, ?, ?, ?)");
const P = 'p1';

console.log('S1 1a 子任务注入 父任务要求');
insTask.run('parent', P, '父任务甲', '把项目A做成', '产出一份A实现方案并落地', 'executing', '', '');
insTask.run('child', P, '子任务乙', '只做A的接口模块', '', 'pending', 'parent', '');
const b1 = buildUpstreamRequirementBlock(db as unknown as Parameters<typeof buildUpstreamRequirementBlock>[0], { parent_task_id: 'parent', depends_on: '' } as Record<string, unknown>);
ok(b1 !== null, '有父任务 → 非空块');
ok((b1 || '').includes('<upstream-requirement>'), '块带 <upstream-requirement> 标记');
ok((b1 || '').includes('[父任务] 父任务甲'), '含 父任务标题');
ok((b1 || '').includes('父任务目标：把项目A做成'), '含 父任务目标');
ok((b1 || '').includes('父任务验收（本子任务须助其达成）：产出一份A实现方案并落地'), '含 父任务验收要点');

console.log('S2 1a depends_on 前置 已完成产出注入');
insTask.run('depA', P, '前置任务D', '', '', 'completed', '', '');
insDeliv.run('dv1', 'depA', 'a_plan.md', 'doc', 'completed');
insDeliv.run('dv2', 'depA', 'report.md', 'doc', 'completed');
const b2 = buildUpstreamRequirementBlock(db as unknown as Parameters<typeof buildUpstreamRequirementBlock>[0], { parent_task_id: '', depends_on: 'depA' } as Record<string, unknown>);
ok(b2 !== null && (b2 || '').includes('[前置任务'), '有 depends_on → 非空块含 [前置任务]');
ok((b2 || '').includes('前置任务D（completed）'), '含 前置标题+状态');
ok((b2 || '').includes('a_plan.md') && (b2 || '').includes('report.md') && (b2 || '').includes('[doc]'), '含 已完成产出名(deliverables 检索 NOT IN retired)');

console.log('S3 1a 前置 completed 无产出 提示');
insTask.run('depB', P, '空手任务E', '', '', 'completed', '', '');
const b3 = buildUpstreamRequirementBlock(db as unknown as Parameters<typeof buildUpstreamRequirementBlock>[0], { parent_task_id: '', depends_on: 'depB' } as Record<string, unknown>);
ok(b3 !== null && (b3 || '').includes('已完成（无登记产出物'), 'completed 无产出 → 提示无登记产出物可 read_file 核查');

console.log('S4 1a 普通任务零注入');
const b4 = buildUpstreamRequirementBlock(db as unknown as Parameters<typeof buildUpstreamRequirementBlock>[0], { parent_task_id: '', depends_on: '' } as Record<string, unknown>);
ok(b4 === null, '无 parent/depends_on → null(零注入，意义即使用)');

console.log('S5 1a 截断兜底');
// 父/前置内容有 500 字符切片，需多前置长产出叠加才能越过 2000 上限触发 truncateCtx
const longNames: string[] = [];
for (let i = 0; i < 4; i++) {
  const depId = `depL${i}`; insTask.run(depId, P, `长前置${i}`, '', '', 'completed', '', '');
  for (let j = 0; j < 4; j++) { const nm = `deliverable_${i}_${j}_` + 'x'.repeat(140); insDeliv.run(`dvL${i}_${j}`, depId, nm, 'doc', 'completed'); longNames.push(nm); }
}
const b5 = buildUpstreamRequirementBlock(db as unknown as Parameters<typeof buildUpstreamRequirementBlock>[0], { parent_task_id: '', depends_on: 'depL0,depL1,depL2,depL3' } as Record<string, unknown>);
ok(b5 !== null, '多前置 → 非空块');
ok((b5 || '').length <= 2100, `块受上限约束(≤2100)，实际 ${(b5 || '').length}`);
ok((b5 || '').includes('已裁剪') && (b5 || '').includes('上游要求较长'), '截断标注存在(truncateCtx 兜底)');
ok(!['deliverable_3_0_', 'deliverable_3_1_', 'deliverable_3_2_', 'deliverable_3_3_'].some((n) => (b5 || '').includes(n)), '超限后末位前置块整块被裁(保留头部要点，非任意丢)');
ok((b5 || '').includes('depL0') || (b5 || '').includes('depL1'), '靠前前置块要点保留');

console.log('S6 1a 静态接线(组装位置在 taskMessage 前)');
ok(pre.includes('function buildUpstreamRequirementBlock(db: Database.Database'), '顶层 helper 定义存在(新家 `exec-prelude.ts`)');
// zx_20261023_5 批一：两个上限分家——`UPSTREAM_BLOCK_MAX_CHARS`(2000) 管**整块**渲染上限，
//   `UPSTREAM_MAX_CHARS`(1200) 管**随单摘要**的总字符预算。此处钉更强的新真源（块上限仍 2000）。
ok(pre.includes('const UPSTREAM_BLOCK_MAX_CHARS = 2000'), '注入块上限常量存在(新家，整块 2000)');
ok(exe.includes("buildUpstreamRequirementBlock") && /from '\.\/exec-prelude\.js'/.test(exe),
  '旧路径仍可导入（执行体再导出，旧调用点不裂）');
const defIdx = exe.indexOf('const upstreamReq = buildUpstreamRequirementBlock(db, task)');
const taskMsgIdx = exe.indexOf('const taskMessage = userMessage');
ok(defIdx > -1 && taskMsgIdx > -1 && defIdx < taskMsgIdx, 'executor 组装调用位于 taskMessage 之前(system 先于 user 入栈)', `upstream@${defIdx} taskMessage@${taskMsgIdx}`);
const pushIdx = exe.indexOf(`if (upstreamReq) messages.push({ role: 'system', content: upstreamReq })`);
ok(pushIdx > -1 && pushIdx < taskMsgIdx, '注入以 system 角色入栈且先于 user 消息');
ok(pre.indexOf('truncateCtx(block, UPSTREAM_BLOCK_MAX_CHARS, \'上游要求\')') > -1, '块经 truncateCtx 兜底(新家，块上限)');

console.log(`结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
