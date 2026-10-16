/**
 * zx_20260906_1 批2 受控复跑（源码静态防回归 + 内存库行为；绝不触碰开发库；用法同 rr_zx_20260906_1_b1.ts）。
 * S1 2a 摘要拼接：compactTaskConversations 不再"newSummary 覆盖 history_summary"，改为与既有摘要拼接保留早期意图。
 * S2 2d 观察死链下线：feedback-engine 不再导出 observeBehavior/learnWorkflowPatterns；getProjectThresholds 不再读 behavior_adjusted_thresholds(observed)。
 * S3 2e 冗余落库下线：tension-engine 不再持久化 last_contradiction_diagnosis（仅即时返回）。
 * S4 2d 运行时：memory 库中执行两个"已完成"任务 → calibrateProjectThresholds 仍可用(learned 层保留)，无 observe 引用即不再写 behavior_pattern。
 * （2b/2c 跨 run 排除/reinforce 属复核项，本批保守不改——复核结论见方案 §九）
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { calibrateProjectThresholds } from '../apps/worker-ant-desktop/src/main/core/feedback-engine.js';
const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as { DatabaseSync: new (p?: string) => { exec: (s: string) => void } };

let pass = 0; let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); }
}

const ROOT = path.join(__dirname, '..');
const exe = fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/agent-executor.ts'), 'utf-8');
const fe = fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/feedback-engine.ts'), 'utf-8');
const te = fs.readFileSync(path.join(ROOT, 'apps/worker-ant-desktop/src/main/core/tension-engine.ts'), 'utf-8');

console.log('S1 2a 摘要拼接(必修)');
ok(exe.includes('taskCtx.history_summary = mergedSummary'), 'history_summary 写的是 mergedSummary(非 newSummary)');
ok(exe.includes('`${prev}\\n[续]${next}`'), '旧摘要与新摘要以 [续] 拼接(保留早期意图)');
ok(exe.includes('merged: !!existingSummary?.trim()'), '日志带 merged 标记(可观测)');

console.log('S2 2d 观察死链下线');
ok(!/export function observeBehavior/.test(fe), 'observeBehavior 已下线');
ok(!/export function learnWorkflowPatterns/.test(fe), 'learnWorkflowPatterns 已下线');
ok(!/behavior_adjusted_thresholds/.test(fe) || /移除永不可能生效的 observed/.test(fe), 'observed(behavior_adjusted_thresholds) 分支已移除');
ok(!/observeBehavior\(db, projectId\);/.test(exe), 'executor 不再调用 observeBehavior');
ok(!/learnWorkflowPatterns\(db, projectId\);/.test(exe), 'executor 不再调用 learnWorkflowPatterns');
ok(/calibrateProjectThresholds/.test(fe), 'calibrateProjectThresholds(learned_thresholds) 保留(真实阈值自校准链路)');

console.log('S3 2e 冗余落库下线');
ok(!te.includes('ctx.last_contradiction_diagnosis = result'), 'tension-engine 不再持久化 last_contradiction_diagnosis');
ok(te.includes('generateContradictionContext 的即时返回'), '保留即时返回消费说明');

console.log('S4 2d 运行时(learned 层可用)');
const db = new DatabaseSync(':memory:') as unknown as { prepare: (s: string) => { all: (...a: unknown[]) => unknown[]; get: (...a: unknown[]) => unknown; run: (...a: unknown[]) => { changes: number } } };
db.exec("CREATE TABLE wa_projects (id TEXT PRIMARY KEY, context_json TEXT DEFAULT '{}'); CREATE TABLE wa_tasks (id TEXT PRIMARY KEY, project_id TEXT, status TEXT DEFAULT 'completed', created_at TEXT DEFAULT (datetime('now')), context_json TEXT DEFAULT '{}');");
const pid = 'p1';
db.prepare('INSERT INTO wa_projects (id) VALUES (?)').run(pid);
ok(typeof calibrateProjectThresholds === 'function', 'calibrateProjectThresholds 可导入(未被误删)');
const row = db.prepare("SELECT context_json FROM wa_projects WHERE id = ?").get(pid) as { context_json: string };
ok(JSON.parse(row.context_json || '{}').behavior_pattern === undefined, '无 behavior_pattern 死写');

console.log(`结果: ${pass} 通过, ${fail} 失败`);
if (fail > 0) process.exit(1);
