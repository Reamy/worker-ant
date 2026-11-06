/**
 * 任务管理5项修复 纯逻辑冒烟测试（f949f9a）。
 *
 * 覆盖：
 *  - 问题2 产出物去重：同任务内 file_path 重复注册返回已有记录、file_path 为空按 name 去重。
 *  - 问题5 finalize 待确认检测：从产出物文档提取「**【xxx】**」待确认事项（与 detectPendingConfirmations 同格式）。
 */
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { DatabaseSync } = nodeRequire('node:sqlite') as {
  DatabaseSync: new (path?: string) => {
    exec: (sql: string) => void;
    prepare: (sql: string) => { all: (...p: unknown[]) => unknown[]; get: (...p: unknown[]) => unknown; run: (...p: unknown[]) => { changes: number } };
  };
};

let passCount = 0;
let failCount = 0;
function assert(name: string, cond: boolean, detail?: string): void {
  if (cond) { passCount++; console.log(`  ✅ ${name}`); }
  else { failCount++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`); }
}

// ===== 问题5 待确认提取逻辑（复刻 finalize_task 检查6 的正则提取） =====
function extractPendingItems(content: string): string[] {
  const items: string[] = [];
  if (!/待确认|需用户确认|需确认|待决策|待答复|待核实/.test(content)) return items;
  const re = /\*\*【([^】]+)】\*\*/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const label = m[1]!.trim();
    if (/确认|澄清|决策|答复|核实|核对|待定/.test(label) && !items.includes(label)) items.push(label);
  }
  return items;
}

// ===== 问题2 去重查询逻辑（复刻 create_deliverable / register_deliverable 的去重） =====
function findExistingDedup(db: ReturnType<typeof DatabaseSync>, taskId: string, fp: string, name: string): { id: string; name: string; status: string } | null {
  const existing = fp
    ? (db.prepare('SELECT id, name, status FROM wa_deliverables WHERE task_id = ? AND file_path = ?').get(taskId, fp) as { id: string; name: string; status: string } | undefined)
    : (db.prepare('SELECT id, name, status FROM wa_deliverables WHERE task_id = ? AND name = ?').get(taskId, name) as { id: string; name: string; status: string } | undefined);
  return existing ?? null;
}

function main(): void {
  console.log('\n===== 任务管理5项修复 纯逻辑冒烟测试 =====\n');

  // ----- 问题5：待确认检测 -----
  console.log('[1] 问题5 产出物文档「待确认」事项提取');
  const docWithPending = `# 规划方案
## 六、待确认事项
1. **【成本费率确认】** 平安证券当前实际费率是否为佣金万2.5？
2. **【盈利目标数学澄清·最重要】** 请明确"每日3%"含义。
## 九、关键决策记录（已确认）
| 成本费率确认 | 佣金0.03% |
`;
  const items = extractPendingItems(docWithPending);
  assert('提取到「成本费率确认」', items.includes('成本费率确认'), JSON.stringify(items));
  assert('提取到「盈利目标数学澄清·最重要」', items.includes('盈利目标数学澄清·最重要'), JSON.stringify(items));
  assert('提取 2 项（未过滤已确认，检查6 只提取不区分章节）', items.length === 2, JSON.stringify(items));

  const docNoPending = '# 普通文档\n无待确认标记';
  assert('无待确认标记返回空', extractPendingItems(docNoPending).length === 0);

  // ----- 问题2：产出物去重 -----
  console.log('\n[2] 问题2 产出物去重（同任务内 file_path 去重）');
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE wa_deliverables (
    id TEXT PRIMARY KEY, task_id TEXT, type TEXT DEFAULT 'doc', name TEXT,
    file_path TEXT, status TEXT DEFAULT 'draft'
  );`);
  db.prepare("INSERT INTO wa_deliverables (id, task_id, type, name, file_path, status) VALUES ('d1','t1','doc','规划方案','/work/plans/A.md','draft')").run();

  const dup = findExistingDedup(db, 't1', '/work/plans/A.md', '规划方案');
  assert('同 file_path 重复注册命中已有记录', dup?.id === 'd1', JSON.stringify(dup));

  const dupByName = findExistingDedup(db, 't1', '', '规划方案');
  assert('file_path 为空时按 name 去重命中', dupByName?.id === 'd1', JSON.stringify(dupByName));

  const noDup = findExistingDedup(db, 't1', '/work/plans/B.md', '另一文档');
  assert('不同 file_path 不命中（应新建）', noDup === null, JSON.stringify(noDup));

  console.log(`\n===== 结果：${passCount} 通过 / ${failCount} 失败 =====\n`);
  process.exit(failCount > 0 ? 1 : 0);
}

main();
