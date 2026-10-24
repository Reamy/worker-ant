/**
 * Phase A/C(待确认事项门禁) 纯逻辑冒烟测试（PLAN_20260827_zx_3.md）。
 *
 * 数据库：node:sqlite 内存库(:memory:)，绝不使用开发库 data/worker-ant.db。
 * 覆盖：detectPendingConfirmations 从方案文档提取「待确认事项」，
 *       过滤任务 confirmations + 文档「关键决策记录（已确认）」章节的事项。
 */
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectPendingConfirmations } from '../apps/worker-ant-desktop/src/main/core/agent-executor.js';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path?: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => { all: (...p: unknown[]) => unknown[]; get: (...p: unknown[]) => unknown; run: (...p: unknown[]) => { changes: number; lastInsertRowid: number | bigint } };
  };
};

let passCount = 0;
let failCount = 0;
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) { passCount++; console.log(`  ✅ ${name}`); }
  else { failCount++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE wa_tasks (
    id TEXT PRIMARY KEY, project_id TEXT, title TEXT DEFAULT '', description TEXT DEFAULT '',
    status TEXT DEFAULT 'pending', context_json TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now')), updated_at TEXT DEFAULT (datetime('now'))
  );
`);

function main(): void {
  console.log('\n===== 待确认事项门禁(detectPendingConfirmations) 纯逻辑冒烟测试 =====\n');

  // 构造方案文档：含「待确认事项」章节(3项) + 「关键决策记录（已确认）」章节(1项已确认)
  const tmp = mkdtempSync(join(tmpdir(), 'zx3-'));
  mkdirSync(join(tmp, 'plans'), { recursive: true });
  const planContent = `# 测试方案
## 六、待确认事项（需用户答复后方可实施）
1. **【成本费率确认】** 平安证券当前实际费率是否为佣金万2.5？
2. **【盈利目标数学澄清·最重要】** 请明确"每日3%"与"每年300%"的真实含义。
3. **【选股范围确认】** 是否仍限定为主题池内标的？
## 九、关键决策记录（已确认）
| 成本费率确认 | 佣金0.03%（最低5元） |
`;
  writeFileSync(join(tmp, 'plans', 'A_test.md'), planContent);

  const taskText = '请按计划分步实施方案 plans/A_test.md';
  const taskId = 't1';

  console.log('[1] 提取待确认事项（过滤文档「关键决策记录」章节已确认的）');
  const all = detectPendingConfirmations(db, 'p1', taskText, taskId, tmp);
  assert('文档已确认的成本费率确认被过滤', !all.includes('成本费率确认'), JSON.stringify(all));
  assert('提取到盈利目标数学澄清·最重要', all.includes('盈利目标数学澄清·最重要'), JSON.stringify(all));
  assert('提取到选股范围确认', all.includes('选股范围确认'), JSON.stringify(all));

  console.log('\n[2] 任务 confirmations 再过滤（选股范围确认已确认）');
  db.prepare("INSERT INTO wa_tasks (id, project_id, description, context_json) VALUES ('t1', 'p1', ?, ?)")
    .run(taskText, JSON.stringify({ confirmations: ['选股范围确认'] }));
  const filtered = detectPendingConfirmations(db, 'p1', taskText, taskId, tmp);
  assert('任务已确认的选股范围确认不再返回', !filtered.includes('选股范围确认'), JSON.stringify(filtered));
  assert('仅剩盈利目标数学澄清待确认', filtered.length === 1 && filtered.includes('盈利目标数学澄清·最重要'), JSON.stringify(filtered));

  console.log('\n[3] 无待确认标记的文档不阻断（返回空）');
  const none = detectPendingConfirmations(db, 'p1', '请执行普通任务', 't2', tmp);
  assert('无方案路径返回空', none.length === 0, JSON.stringify(none));

  console.log(`\n===== 结果：${passCount} 通过 / ${failCount} 失败 =====\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
