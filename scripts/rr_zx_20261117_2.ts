/**
 * zx_20261117_2 「名」受控复跑。
 *
 * 分组：
 *   M「名」`GET /api/v1/billing/usage` 回人可见的 `model_name`（M1/M2）
 *   N「证」渲染层仍以 `model_name` 为首选；聚合真源仍是 `model_id`（M3）
 *
 * 纪律（承 CLAUDE.md 与 auto-memory）：
 *   · 直引生产 `billingRoutes` 真实现（被删/改名即编译期失败）。
 *   · 两侧标本同试：UUID 主键模型 + 孤儿账。
 *   · 计数器类断言给正面值（合计 300/150、call_count=2）。
 *   · 断言文案不含失败字形；不以轮次字面量做等值断言。
 */
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { billingRoutes } from '../apps/ans-server/src/routes/billing.js';
import { checkBuildPins } from './lib/rr-pins.js';

let pass = 0;
let fail = 0;
function ok(cond: boolean, label: string, detail?: string): void {
  if (cond) { pass++; console.log(`  ok ${label}${detail ? ` — ${detail}` : ''}`); }
  else { fail++; console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`); }
}
function eq(actual: unknown, expect: unknown, label: string): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expect);
  ok(a === e, label, `${a} vs ${e}`);
}

const root = path.join(__dirname, '..');

interface UsageRow {
  model_id: string;
  model_name: string | null;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost: number;
  call_count: number;
}

async function fetchUsage(app: ReturnType<typeof billingRoutes>): Promise<UsageRow[]> {
  const r = await app.handle(new Request('http://localhost/api/v1/billing/usage?days=30', { method: 'GET' }));
  ok(r.status === 200, 'M0 路由可调用（200）');
  const body = (await r.json()) as { data: UsageRow[] };
  return body.data;
}

async function groupM(): Promise<void> {
  console.log('\n【M】「名」billing/usage 回包带模型名');
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE ans_ai_models (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE ans_billing_records (
      id TEXT PRIMARY KEY,
      endpoint_id TEXT,
      model_id TEXT,
      project_id TEXT,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cost REAL DEFAULT 0.0,
      currency TEXT DEFAULT 'USD',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.prepare('INSERT INTO ans_ai_models (id, name) VALUES (?, ?)').run(
    '27683d97-a588-4784-89e5-d67e3318bf5d',
    'qwen3.5:9b',
  );
  db.prepare('INSERT INTO ans_ai_models (id, name) VALUES (?, ?)').run('deepseek-v4-flash', 'deepseek-v4-flash');
  const ins = db.prepare(
    'INSERT INTO ans_billing_records (id, model_id, tokens_in, tokens_out, cost) VALUES (?, ?, ?, ?, ?)',
  );
  ins.run('b1', '27683d97-a588-4784-89e5-d67e3318bf5d', 100, 50, 0.01);
  ins.run('b2', '27683d97-a588-4784-89e5-d67e3318bf5d', 200, 100, 0.02);
  ins.run('b3', 'deepseek-v4-flash', 400, 200, 0.03);
  ins.run('b4', 'qwen2.5:3b', 7, 3, 0.001);

  const app = billingRoutes(db as never);
  const rows = await fetchUsage(app);

  const uuidRow = rows.find((x) => x.model_id === '27683d97-a588-4784-89e5-d67e3318bf5d');
  eq(uuidRow?.model_name, 'qwen3.5:9b', 'M-01 UUID 主键模型回人可见名（qwen3.5:9b）');
  eq(
    [uuidRow?.total_tokens_in, uuidRow?.total_tokens_out, uuidRow?.call_count],
    [300, 150, 2],
    'M-02 聚合真源仍是 model_id：两笔并一行，合计 300/150，call_count=2',
  );
  eq(rows.filter((x) => x.model_id === '27683d97-a588-4784-89e5-d67e3318bf5d').length, 1,
    'M-03 JOIN 未把同一 model_id 拆成多行');

  const orphan = rows.find((x) => x.model_id === 'qwen2.5:3b');
  eq(orphan?.model_name, null, 'M-04 孤儿账如实回 model_name=null（不伪造）');
  eq(rows.length, 3, 'M-05 孤儿账仍独立成行（不并入他模型）');

  const named = rows.find((x) => x.model_id === 'deepseek-v4-flash');
  eq(named?.model_name, 'deepseek-v4-flash', 'M-06 id 恰等于名字的模型同样带 model_name 列');

  // 反证：把 JOIN 拿掉就必然回 undefined —— 语料里 `m.name as model_name` 必须是唯一来源
  const src = fs.readFileSync(path.join(root, 'apps/ans-server/src/routes/billing.ts'), 'utf8');
  ok(/LEFT JOIN ans_ai_models m ON m\.id = b\.model_id/.test(src), 'M-07 显示名来自 ans_ai_models 主键 JOIN');
  ok(/GROUP BY b\.model_id/.test(src), 'M-08 分组仍只按 b.model_id（不做 id/name 双条件聚合）');
}

function groupN(): void {
  console.log('\n【N】「证」渲染层口径与接线');
  const page = fs.readFileSync(
    path.join(root, 'apps/worker-ant-desktop/renderer/src/pages/DashboardPage.tsx'),
    'utf8',
  );
  ok(/model_name\s*\|\|\s*b\.model_id/.test(page),
    'N-01 渲染层仍以 model_name 为首选、model_id 兜底（本轮修法在此分支上生效）');
  ok(page.includes('按模型'),
    'N-02 「Token 消耗（按模型）」区块在册');

  const planPath = path.join(root, 'plans/improve/zx_20261117_2.md');
  ok(fs.existsSync(planPath), 'N-03 本轮方案文件在册');
}

async function main(): Promise<void> {
  console.log('zx_20261117_2 受控复跑');
  await groupM();
  groupN();

  console.log('\n── build 钉 ──');
  checkBuildPins(ok, { distDir: path.join(root, 'apps/worker-ant-desktop/dist') });

  console.log(`\n[rr_zx_20261117_2] ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('套件异常：', e);
  process.exit(1);
});
